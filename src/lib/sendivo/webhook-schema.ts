import { z } from "zod";

/**
 * ASSUMED Sendivo inbound-message webhook shape — open item #1 in the design
 * doc. Confirm field names against the real Sendivo webhook docs once the API
 * key + webhook token arrive, and adjust here (this module is the only place
 * the wire shape is known).
 *
 * `.loose()` keeps unrecognized fields so the raw payload can be audited even
 * if Sendivo sends more than we model.
 */
export const sendivoInboundMessage = z
  .object({
    event: z.literal("message.received").or(z.literal("message.inbound")),
    message: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        conversation_id: z.union([z.string(), z.number()]).transform(String).optional(),
        contact_id: z.union([z.string(), z.number()]).transform(String).optional(),
        from: z.string().min(1), // seller's phone
        body: z.string(),
        campaign_id: z.union([z.string(), z.number()]).transform(String).optional(),
        received_at: z.string().optional(),
      })
      .loose(),
  })
  .loose();

export type SendivoInboundMessage = z.infer<typeof sendivoInboundMessage>;

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
