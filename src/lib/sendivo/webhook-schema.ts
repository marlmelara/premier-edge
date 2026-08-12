/**
 * Sendivo webhook payload handling.
 *
 * The API docs PDF shows four webhook types (Inbound Message Received,
 * Outbound Delivery Status, Phone Number Ready, Deal Status Updated) but the
 * exact payload shapes live in a collapsed "Webhook Events" panel we don't
 * have. So classification is structural and tolerant: field names cover the
 * variants Sendivo plausibly uses (its REST API mixes `from_number`/`from`,
 * `message_content`/`message`/`body`). Anything unrecognized is captured raw
 * into agent_actions by the route so the real shape is learned from the first
 * live event — then tightened here.
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
