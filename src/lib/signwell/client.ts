import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";

/**
 * SignWell REST client. Shapes taken from SignWell's official SDK
 * (github.com/Bidsketch/signwell-sdk-ruby), read Aug 12, 2026 — not guessed.
 *
 * Auth is the `X-Api-Key` header; base path is https://www.signwell.com/api/v1.
 */
const BASE_URL = "https://www.signwell.com/api/v1";

export class SignWellError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SignWellError";
  }
}

async function request<T>(schema: z.ZodType<T>, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const key = env().SIGNWELL_API_KEY;
  if (!key) throw new SignWellError("SIGNWELL_API_KEY not configured");

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "X-Api-Key": key,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new SignWellError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);

  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof z.ZodError) throw new SignWellError(`unexpected response shape: ${error.message}`);
    throw new SignWellError(`non-JSON response: ${text.slice(0, 200)}`);
  }
}

export const signWellDocument = z
  .object({
    id: z.string(),
    status: z.string().nullish(),
    name: z.string().nullish(),
    test_mode: z.boolean().nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    recipients: z
      .array(z.object({ id: z.string().nullish(), name: z.string().nullish(), email: z.string().nullish() }).loose())
      .nullish(),
  })
  .loose();

export type SignWellDocument = z.infer<typeof signWellDocument>;

export type TemplateRecipient = {
  /**
   * The template placeholder this person fills, matched by name ("Seller",
   * "Buyer"). Names are stable across template edits; the numeric placeholder
   * ids are positional and shift when roles are reordered.
   */
  placeholderName: string;
  name: string;
  email: string;
  sendEmail?: boolean;
};

/** One prefilled template field: `api_id` is the field's id in the SignWell template. */
export type TemplateFieldValue = { api_id: string; value: string };

export function createDocumentFromTemplate(params: {
  templateId: string;
  name: string;
  subject?: string;
  message?: string;
  recipients: TemplateRecipient[];
  fields: TemplateFieldValue[];
  metadata?: Record<string, string>;
  /** true leaves the document unsent — used for the human-approved multi-seller path (§6). */
  draft?: boolean;
  testMode?: boolean;
}) {
  return request(signWellDocument, "/document_templates/documents", {
    method: "POST",
    body: {
      template_id: params.templateId,
      name: params.name,
      subject: params.subject,
      message: params.message,
      draft: params.draft ?? false,
      test_mode: params.testMode ?? false,
      apply_signing_order: false,
      recipients: params.recipients.map((r) => ({
        placeholder_name: r.placeholderName,
        name: r.name,
        email: r.email,
        send_email: r.sendEmail ?? true,
      })),
      template_fields: params.fields,
      metadata: params.metadata,
    },
  });
}

export function getDocument(documentId: string) {
  return request(signWellDocument, `/documents/${encodeURIComponent(documentId)}`);
}

/** The signed PDF, for the title-company email. */
export async function getCompletedPdf(documentId: string): Promise<Buffer> {
  const key = env().SIGNWELL_API_KEY;
  if (!key) throw new SignWellError("SIGNWELL_API_KEY not configured");

  const res = await fetch(`${BASE_URL}/documents/${encodeURIComponent(documentId)}/completed_pdf`, {
    headers: { "X-Api-Key": key },
  });
  if (!res.ok) throw new SignWellError(`completed_pdf HTTP ${res.status}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Webhook payload: `{ event: { type, time, hash }, data: {...} }`. The signature
 * is HMAC-SHA256 over `"{type}@{time}"` keyed by the webhook's secret id.
 */
export const signWellWebhookPayload = z
  .object({
    event: z
      .object({
        type: z.string(),
        time: z.union([z.string(), z.number()]),
        hash: z.string(),
      })
      .loose(),
    data: z.unknown().optional(),
  })
  .loose();

export type SignWellWebhookPayload = z.infer<typeof signWellWebhookPayload>;

export function verifyWebhookSignature(event: { type: string; time: string | number; hash: string }, webhookId: string): boolean {
  const expected = createHmac("sha256", webhookId).update(`${event.type}@${event.time}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(event.hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
