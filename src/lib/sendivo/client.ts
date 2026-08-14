import { z } from "zod";
import { env } from "@/env";

/**
 * Typed Sendivo REST client (transport only — design doc §6).
 * Shapes verified against the API docs PDF + live probes on Aug 12, 2026.
 */
const BASE_URL = "https://app.sendivo.io/api/v1";

export class SendivoError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SendivoError";
  }
}

const envelope = z.union([
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({
    success: z.literal(false),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).loose(),
  }),
]);

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> },
): Promise<T> {
  const key = env().SENDIVO_API_KEY;
  if (!key) throw new SendivoError("SENDIVO_API_KEY not configured");

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SendivoError(`Sendivo returned non-JSON (HTTP ${res.status})`, undefined, res.status);
  }

  const parsed = envelope.parse(json);
  if (!parsed.success) {
    throw new SendivoError(parsed.error.message ?? "Sendivo request failed", parsed.error.code, res.status);
  }
  return schema.parse(parsed.data);
}

// --- Shapes (loose: Sendivo may add fields) ---

const idString = z.union([z.string(), z.number()]).transform(String);

export const sendivoPhoneNumber = z
  .object({
    id: z.number(),
    phone_number: z.string(),
    friendly_name: z.string().nullish(),
    is_default: z.boolean().nullish(),
    number_status: z.string().nullish(),
    messaging_status: z.string().nullish(),
    campaign: z.object({ id: z.number(), name: z.string() }).loose().nullish(),
    sub_account_id: z.number().nullish(),
  })
  .loose();

export const sendivoCampaign = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string().nullish(),
    is_default: z.boolean().nullish(),
    brand: z.object({ id: z.number(), name: z.string() }).loose().nullish(),
    phone_numbers: z.array(z.object({ id: z.number(), phone_number: z.string() }).loose()).nullish(),
  })
  .loose();

export const sendivoContact = z
  .object({
    id: z.number(),
    sub_account_id: z.number().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    full_name: z.string().nullish(),
    email: z.string().nullish(),
    phone_number: z.string().nullish(),
    alternative_mobile_numbers: z.array(z.string()).nullish(),
    address_line1: z.string().nullish(),
    address_line2: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    postal_code: z.string().nullish(),
    property_address: z.string().nullish(),
    property_city: z.string().nullish(),
    property_state: z.string().nullish(),
    property_zip: z.string().nullish(),
    notes: z.string().nullish(),
    opted_out: z.boolean().nullish(),
    labels: z.array(z.object({ id: z.number(), name: z.string() }).loose()).nullish(),
  })
  .loose();
export type SendivoContact = z.infer<typeof sendivoContact>;

const sendResult = z
  .object({
    message_id: idString,
    status: z.string().nullish(),
    segments: z.number().nullish(),
    to: z.string().nullish(),
    from: z.string().nullish(),
  })
  .loose();

const takeoverResult = sendResult
  .safeExtend({
    conversation_id: z.number(),
    conversation_message_id: z.number().nullish(),
    ai_responder_stopped: z.boolean().nullish(),
  })
  .loose();

export const deliveryMetrics = z
  .object({
    start_date: z.string(),
    end_date: z.string(),
    sms_sent: z.number(),
    segments_sent: z.number(),
    inbound_sms_received: z.number(),
    delivery_rate: z.number().nullable(),
    opt_out_rate: z.number().nullable(),
    response_rate: z.number().nullable(),
  })
  .loose();

export const sendivoBlast = z
  .object({
    id: z.number(),
    name: z.string(),
    list_name: z.string().nullish(),
    contacts_count: z.number().nullish(),
    sms_sent: z.number().nullish(),
    delivery_rate: z.number().nullish(), // null while blast is in progress
    reply_rate: z.number().nullish(),
    opt_outs: z.number().nullish(),
    deals_won: z.number().nullish(),
    blast_cost: z.number().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .loose();

// --- Client surface ---

export function getPhoneNumbers() {
  return request(z.array(sendivoPhoneNumber), "/phone-numbers");
}

export function getCampaigns() {
  return request(z.array(sendivoCampaign), "/campaigns");
}

/** Enrichment lookup (§2.4). Returns null when Sendivo doesn't know the number or it's ambiguous across sub-accounts. */
export async function getContactByPhone(phoneNumber: string, subAccountId?: number) {
  try {
    const data = await request(z.object({ contact: sendivoContact }).loose(), "/contacts", {
      query: { phone_number: phoneNumber, sub_account_id: subAccountId },
    });
    return data.contact;
  } catch (error) {
    if (error instanceof SendivoError && (error.code === "NOT_FOUND" || error.code === "AMBIGUOUS_CONTACT")) {
      return null;
    }
    throw error;
  }
}

/**
 * Sendivo rejects a /sms call that carries neither `from` nor
 * `from_phone_number_id`, so resolve the account's default sending number once
 * and reuse it. Cached in module memory — the number changes about never, and a
 * cold start just re-fetches.
 */
let defaultFromId: number | undefined;

export async function getDefaultSendingNumberId(): Promise<number> {
  if (defaultFromId !== undefined) return defaultFromId;

  const configured = env().SENDIVO_FROM_NUMBER_ID;
  if (configured) {
    defaultFromId = Number(configured);
    return defaultFromId;
  }

  const numbers = await getPhoneNumbers();
  const usable =
    numbers.find((n) => n.is_default && n.messaging_status === "active") ??
    numbers.find((n) => n.messaging_status === "active") ??
    numbers[0];
  if (!usable) throw new SendivoError("no phone number available on the Sendivo account");

  defaultFromId = usable.id;
  return defaultFromId;
}

/** Stateless number-to-number send — reserved for Marlon notifications (§11b), never sellers. */
export async function sendSms(params: {
  to: string;
  message: string;
  from?: string;
  fromPhoneNumberId?: number;
  campaignId?: number;
}) {
  // One of `from` / `from_phone_number_id` is required by the API.
  const fromPhoneNumberId =
    params.fromPhoneNumberId ?? (params.from ? undefined : await getDefaultSendingNumberId());

  return request(sendResult, "/sms", {
    method: "POST",
    body: {
      to: params.to,
      message: params.message,
      from: params.from,
      from_phone_number_id: fromPhoneNumberId,
      campaign_id: params.campaignId,
    },
  });
}

/**
 * Threaded reply = the takeover (§6): permanently kills Sendivo's AI Responder
 * for the thread. Every seller-facing send goes through here.
 */
export function sendConversationMessage(conversationId: number, message: string) {
  return request(takeoverResult, `/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { message },
  });
}

export function getDeliveryMetrics(startDate: string, endDate: string) {
  return request(deliveryMetrics, "/delivery-metrics", {
    query: { start_date: startDate, end_date: endDate },
  });
}

export function getBlasts(params?: { startDate?: string; endDate?: string; page?: number; perPage?: number }) {
  return request(
    z.object({ blasts: z.array(sendivoBlast), pagination: z.object({}).loose().nullish() }).loose(),
    "/blasts",
    {
      query: {
        start_date: params?.startDate,
        end_date: params?.endDate,
        page: params?.page,
        per_page: params?.perPage,
      },
    },
  );
}

/** One-way push back to Sendivo so its dashboard isn't lying (§2.4 — nice-to-have). */
export function updateContactDealStatus(phoneNumber: string, dealStatus: string, dealValue?: number) {
  return request(z.object({}).loose(), "/contacts/deal-status", {
    method: "POST",
    body: { phone_number: phoneNumber, deal_status: dealStatus, deal_value: dealValue },
  });
}
