import { z } from "zod";
import { formatMoney } from "@/lib/format";
import { jsonCall } from "./anthropic";
import { validateDraftDollars, type DollarValidation } from "./dollar-validation";
import type { DraftIntent } from "./negotiation";
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

When the seller names a price far above AUTHORIZED AMOUNT, stay warm and matter-of-fact. Do not argue, correct them, call their number unrealistic, or explain why it is too high. Acknowledge what they said, give the authorized number as what we can do, and leave the door open. A seller who feels talked down to stops replying, and their lot stays on our list for later.

Every message goes to a human for approval before sending, so write the reply you would actually send.`;

/**
 * What this particular message is for. The negotiation policy picks the intent
 * (negotiation.ts); the model only executes it.
 */
const INTENT_INSTRUCTION: Record<DraftIntent, string> = {
  reply: "Answer what the seller said and keep the conversation moving.",

  probe:
    "Ask what they would want for the lot. That is the entire job of this message. We deliberately do not name a price first — a seller who would have taken less should never hear our number — so do not hint at a range, quote what other lots sold for, or promise our number will be strong. One short, friendly question.",

  offer: "Give them the authorized amount as what we can do on this lot.",

  nudge:
    "They have not replied to the offer we already sent. Check in once, briefly and without pressure, to see whether that number works for them. You may restate the authorized amount, but you may not change it and you may not add any term to sweeten it.",

  partner_bump:
    "They went quiet after our last offer. We went back to our partners and can now do better. Say that plainly, give the new authorized amount, and leave the decision with them. No apologies, no urgency, and no deadline — we have not been given one.",
};

export type DraftContext = {
  classification: InboundClass;
  conversationState: string;
  /** What this message is supposed to accomplish. Defaults to a plain reply. */
  intent?: DraftIntent;
  sellerName?: string | null;
  parcelAddress?: string | null;
  county?: string | null;
  /** Cents. When set, this is the only figure the model may use. */
  authorizedOfferCents?: number | null;
  sellerCounterCents?: number | null;
  /** True when the authorized amount *is* the seller's asking price — we're agreeing, not countering. */
  meetsSellerAsk?: boolean;
  recentThread: { direction: string; body: string }[];
};

export type DraftResult =
  | { ok: true; message: string; notes: string; validation: DollarValidation }
  | { ok: false; reason: "dollar_validation"; message: string; notes: string; validation: DollarValidation };

export async function draftReply(ctx: DraftContext): Promise<DraftResult> {
  const authorized = ctx.authorizedOfferCents ?? null;
  const intent = ctx.intent ?? "reply";
  const transcript = ctx.recentThread
    .map((m) => `${m.direction === "inbound" ? "Seller" : "Us"}: ${m.body}`)
    .join("\n");

  const user = `CONTEXT
Seller: ${ctx.sellerName ?? "unknown name"}
Property: ${ctx.parcelAddress ?? "not yet identified"}${ctx.county ? ` (${ctx.county} County)` : ""}
Conversation state: ${ctx.conversationState}
Latest message classified as: ${ctx.classification}
${ctx.sellerCounterCents != null ? `Seller has asked for: ${formatMoney(ctx.sellerCounterCents / 100)}` : ""}
${ctx.meetsSellerAsk ? "The authorized amount is exactly what they asked for — this message accepts their number, it does not counter it." : ""}

WHAT THIS MESSAGE IS FOR: ${INTENT_INSTRUCTION[intent]}

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

  // The gate: code checks every number in the model's output. The seller's own
  // stated price is allowed through — acknowledging it is good negotiation —
  // but when we're putting a price on the table, ours must appear too, so a
  // draft can never quote only their number back as if we accepted it.
  // A nudge is exempt: restating the standing offer is optional there, and
  // "did that number work for you?" is a perfectly good message.
  const allowed = [authorized, ctx.sellerCounterCents ?? null].filter((v): v is number => v != null);
  const required = intent === "offer" || intent === "partner_bump" ? authorized : null;
  const validation = validateDraftDollars(drafted.message, allowed, required);
  if (!validation.ok) {
    return { ok: false, reason: "dollar_validation", message: drafted.message, notes: drafted.notes, validation };
  }
  return { ok: true, message: drafted.message, notes: drafted.notes, validation };
}
