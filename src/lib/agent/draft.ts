import { z } from "zod";
import { formatMoney } from "@/lib/format";
import { jsonCall } from "./anthropic";
import { validateDraftDollars, type DollarValidation } from "./dollar-validation";
import type { InboundClass } from "./state-machine";

/**
 * Draft one reply to a seller. The model writes wording only: every dollar
 * figure it is allowed to use is handed to it by code, and the draft is
 * rejected if it produces any other number (design doc §6).
 */

const draftSchema = z.object({
  message: z.string().min(1).max(1600),
  notes: z.string(),
});

const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "The SMS to send. Plain text, no markdown, under 300 characters." },
    notes: { type: "string", description: "One sentence for Marlon on why this reply." },
  },
  required: ["message", "notes"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write short SMS replies on behalf of a small land-buying company (Premier Equity) texting Florida landowners about vacant lots.

Voice: a real person who buys land, not a marketing bot. Plain words, no exclamation marks, no emoji, no all-caps, no "Dear". One or two sentences. Under 300 characters.

Hard rules:
- Use ONLY the dollar amount given to you in AUTHORIZED AMOUNT, written exactly as given. If AUTHORIZED AMOUNT says none, your message must contain no prices, no ranges, no estimates, and no numbers a reader could mistake for a price.
- Never invent or imply a number — not an approximate figure, not "around", not "up to", not a comparison to other lots.
- State no deal terms that are not in CONTEXT. That includes who pays closing costs or fees, closing dates or timelines, title work, inspections, contingencies, and financing. If CONTEXT does not name a term, you may not offer it — even when it is customary and even when it would help close. The price is the only commitment you are authorized to make.
- Never claim to be an attorney, agent, or appraiser.
- If you cannot write a compliant reply, return a message asking the seller a clarifying question instead.

Every message goes to a human for approval before sending, so write the reply you would actually send.`;

export type DraftContext = {
  classification: InboundClass;
  conversationState: string;
  sellerName?: string | null;
  parcelAddress?: string | null;
  county?: string | null;
  /** Cents. When set, this is the only figure the model may use. */
  authorizedOfferCents?: number | null;
  sellerCounterCents?: number | null;
  recentThread: { direction: string; body: string }[];
};

export type DraftResult =
  | { ok: true; message: string; notes: string; validation: DollarValidation }
  | { ok: false; reason: "dollar_validation"; message: string; notes: string; validation: DollarValidation };

export async function draftReply(ctx: DraftContext): Promise<DraftResult> {
  const authorized = ctx.authorizedOfferCents ?? null;
  const transcript = ctx.recentThread
    .map((m) => `${m.direction === "inbound" ? "Seller" : "Us"}: ${m.body}`)
    .join("\n");

  const user = `CONTEXT
Seller: ${ctx.sellerName ?? "unknown name"}
Property: ${ctx.parcelAddress ?? "not yet identified"}${ctx.county ? ` (${ctx.county} County)` : ""}
Conversation state: ${ctx.conversationState}
Latest message classified as: ${ctx.classification}
${ctx.sellerCounterCents != null ? `Seller has asked for: ${formatMoney(ctx.sellerCounterCents / 100)}` : ""}

AUTHORIZED AMOUNT: ${authorized != null ? formatMoney(authorized / 100) : "none — do not mention any price"}

Thread so far:
${transcript || "(no prior messages)"}

Write the next reply.`;

  const drafted = await jsonCall({
    system: SYSTEM,
    user,
    schema: draftSchema,
    jsonSchema: DRAFT_JSON_SCHEMA,
    effort: "medium",
  });

  // The gate: code checks every number in the model's output.
  const validation = validateDraftDollars(drafted.message, authorized != null ? [authorized] : []);
  if (!validation.ok) {
    return { ok: false, reason: "dollar_validation", message: drafted.message, notes: drafted.notes, validation };
  }
  return { ok: true, message: drafted.message, notes: drafted.notes, validation };
}
