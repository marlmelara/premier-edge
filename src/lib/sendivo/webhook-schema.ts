import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sendivo webhook payload handling.
 *
 * Shapes confirmed against a live delivery on Aug 15 2026 (their "Webhook
 * Events" reference plus a captured Send Test). Every event is the same
 * envelope — `{ event, timestamp, data: {...} }` — with the payload nested
 * under `data`:
 *
 *   inbound_message      data: { message_id, from, to, message, received_at,
 *                                contact: {...}, conversation_id, locationId }
 *   delivery_status      data: { message_id, bulk_id, to, from, status,
 *                                status_group, status_description, sent_at, done_at }
 *   phone_number_ready   data: { phone_number, phone_number_id, status, ... }
 *   deal_status_updated  data: { change_type, contact, deal_status, previous_status, ... }
 *
 * Test deliveries carry `test: true` and are deliberately not ingested — the
 * test payload uses +1415555xxxx placeholders, which would otherwise become a
 * real contact and a real thread.
 *
 * A global-scoped webhook adds `sub_account_name` to every `data` object.
 *
 * The earlier version of this classifier looked for fields at the top level or
 * under `message`, never under `data`, so every real delivery fell through to
 * "unknown". The tolerant fallback below is kept for shapes we haven't seen,
 * but the documented envelope is matched first.
 */

export type ClassifiedWebhook =
  | {
      kind: "inbound";
      sendivoMessageId: string;
      from: string;
      body: string;
      conversationId?: string;
      contactId?: string;
      receivedAt?: Date;
    }
  | { kind: "delivery_status"; sendivoMessageId: string; status: string }
  /** A recognized event we deliberately don't act on — not a parse failure. */
  | { kind: "ignored"; event: string; reason: string }
  | { kind: "unknown" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export function classifyWebhook(payload: unknown): ClassifiedWebhook {
  const raw = asRecord(payload);
  if (!raw) return { kind: "unknown" };

  const data = asRecord(raw.data);
  const eventName = typeof raw.event === "string" ? raw.event.toLowerCase() : "";

  // --- The documented envelope ---
  if (data) {
    // Sendivo's own test fixture, sent by the "Send Test" button. Its numbers
    // are +1415555xxxx placeholders; ingesting them would invent a seller.
    if (raw.test === true) {
      return { kind: "ignored", event: eventName || "unknown", reason: "test delivery" };
    }

    if (eventName === "inbound_message") {
      const id = pickString(data, ["message_id"]);
      const from = pickString(data, ["from"]);
      const body = pickString(data, ["message"]);
      if (id && from && body) {
        const contact = asRecord(data.contact);
        const receivedAt = pickString(data, ["received_at"]);
        const parsed = receivedAt ? new Date(receivedAt) : undefined;
        return {
          kind: "inbound",
          sendivoMessageId: id,
          from,
          body,
          conversationId: pickString(data, ["conversation_id"]),
          contactId: contact ? pickString(contact, ["id"]) : undefined,
          receivedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
        };
      }
    }

    if (eventName === "delivery_status") {
      const id = pickString(data, ["message_id"]);
      const status = pickString(data, ["status", "status_group", "status_description"]);
      if (id && status) return { kind: "delivery_status", sendivoMessageId: id, status };
    }

    // Recognized but not acted on. Naming them keeps the unrecognized-payload
    // log meaningful — it should only ever hold genuine surprises.
    if (eventName === "phone_number_ready" || eventName === "deal_status_updated") {
      return { kind: "ignored", event: eventName, reason: "not consumed by Premier Edge" };
    }
  }

  // --- Tolerant fallback for shapes we haven't seen ---
  // Nested shape: {event, message: {...}}. Flat shape: fields at top level
  // (where `message` may itself be the body string).
  const nested = asRecord(raw.message);
  const obj = nested ?? raw;

  const id = pickString(obj, ["id", "message_id", "sms_id"]) ?? pickString(raw, ["message_id"]);
  const from = pickString(obj, ["from", "from_number", "phone", "phone_number", "sender"]);
  const body =
    pickString(obj, ["body", "message_content", "text", "content"]) ??
    (typeof raw.message === "string" ? raw.message : undefined) ??
    (nested ? pickString(nested, ["message"]) : undefined);
  const status = pickString(obj, ["status", "status_name", "delivery_status"]);
  const event = typeof raw.event === "string" ? raw.event.toLowerCase() : "";

  const looksStatusEvent = /status|delivery/.test(event);
  const looksInboundEvent = /inbound|received|reply/.test(event);

  if (id && from && body && !looksStatusEvent) {
    const receivedAtRaw = pickString(obj, ["received_at", "created_at", "timestamp"]);
    const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : undefined;
    return {
      kind: "inbound",
      sendivoMessageId: id,
      from,
      body,
      conversationId: pickString(obj, ["conversation_id"]) ?? pickString(raw, ["conversation_id"]),
      contactId: pickString(obj, ["contact_id"]) ?? pickString(raw, ["contact_id"]),
      receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : undefined,
    };
  }

  if (id && status && !looksInboundEvent) {
    return { kind: "delivery_status", sendivoMessageId: id, status };
  }

  return { kind: "unknown" };
}

/**
 * Verify a Sendivo webhook signature.
 *
 * Their scheme, from the Webhook Events reference:
 *   HMAC-SHA256(timestamp + "." + payload, signing_secret)
 * delivered as `X-Sendivo-Signature: sha256=<hex>` alongside
 * `X-Sendivo-Timestamp: <unix seconds>`.
 *
 * The payload must be the exact bytes received — re-serializing the parsed
 * object reorders keys and changes whitespace, and the digest stops matching.
 */
export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "missing_timestamp" | "stale" | "mismatch" };

/** How far out of step with us Sendivo's clock may be before we call it a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhookSignature(params: {
  raw: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string;
  now?: Date;
}): SignatureCheck {
  if (!params.signatureHeader) return { ok: false, reason: "missing_signature" };
  if (!params.timestampHeader) return { ok: false, reason: "missing_timestamp" };

  const sent = Number(params.timestampHeader);
  if (!Number.isFinite(sent)) return { ok: false, reason: "missing_timestamp" };

  // Replay window. Without this a captured delivery stays valid forever.
  const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sent) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", params.secret)
    .update(`${params.timestampHeader}.${params.raw}`)
    .digest("hex");
  const presented = params.signatureHeader.replace(/^sha256=/i, "").trim();

  // Constant-time compare, and only on equal lengths — timingSafeEqual throws
  // on a length mismatch, which would itself leak the expected length.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "mismatch" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Normalize a phone number to E.164-ish form: keep digits, prefix +1 for bare 10-digit US numbers. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

const OPT_OUT_KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out"];

/** CTIA/10DLC opt-out keyword detection: the message must BE the keyword, not merely contain it. */
export function isOptOutMessage(body: string): boolean {
  const normalized = body.trim().toLowerCase().replace(/[.!]+$/, "");
  return OPT_OUT_KEYWORDS.includes(normalized);
}
