import { z } from "zod";
import { INBOUND_CLASSES, type InboundClass } from "./state-machine";
import { jsonCall } from "./anthropic";

/**
 * Classify one inbound seller message. Language only — the returned class
 * drives a code-owned state transition (§6), and any counter-offer amount the
 * seller names is recorded but never used as an offer without code re-deriving
 * what we're allowed to pay.
 */

const classificationSchema = z.object({
  classification: z.enum(INBOUND_CLASSES),
  confidence: z.number().min(0).max(1),
  seller_counter_amount: z.number().nullable(),
  /** Utilities the seller states the lot has. Null when they didn't say. */
  utilities_water: z.enum(["city", "well"]).nullable(),
  utilities_sewer: z.enum(["city", "septic"]).nullable(),
  reasoning: z.string(),
});

export type Classification = z.infer<typeof classificationSchema> & { classification: InboundClass };

const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    classification: { type: "string", enum: [...INBOUND_CLASSES] },
    confidence: { type: "number" },
    seller_counter_amount: {
      type: ["number", "null"],
      description: "Dollar amount the seller named as their price, or null if they named none.",
    },
    utilities_water: {
      type: ["string", "null"],
      enum: ["city", "well", null],
      description: "Water source the seller says the lot has, or null if not mentioned.",
    },
    utilities_sewer: {
      type: ["string", "null"],
      enum: ["city", "septic", null],
      description: "Sewer type the seller says the lot has, or null if not mentioned.",
    },
    reasoning: { type: "string" },
  },
  required: [
    "classification",
    "confidence",
    "seller_counter_amount",
    "utilities_water",
    "utilities_sewer",
    "reasoning",
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You classify inbound SMS replies from landowners who received a text asking whether they'd sell a vacant lot.

Pick exactly one classification:
- interested: open to selling or wants to hear more
- not_interested: declines, says not selling
- asking_price: asks what we'd pay, without naming a number
- counter_offer: names a price they want
- accepted: agrees to a specific price we offered
- wrong_person: says they don't own it, sold it already, or we have the wrong number
- question_about_process: asks how this works, who we are, closing costs, timing
- hostile: insults, profanity, or anger without a clear opt-out request
- opt_out: asks to stop being contacted, in any wording
- off_script: anything else — confusion, legal threats, or a message you cannot place confidently

Set confidence to how certain you are. Use off_script when unsure rather than guessing.
If the seller names a dollar amount as their asking price, put the number in seller_counter_amount; otherwise null. Record it even when the number is far above what any buyer would pay — an unrealistic asking price is still worth knowing, and classify it as counter_offer rather than hostile.
If the seller says anything about the lot's utilities, record it: utilities_water is "city" for city/county/public water and "well" for a private well; utilities_sewer is "city" for city/county/public sewer and "septic" for a septic tank. Leave either null when they didn't say. Capture this from any message, not only a reply to a direct question — sellers often volunteer it.

Keep reasoning to one sentence.`;

export async function classifyInbound(params: {
  body: string;
  conversationState: string;
  recentThread: { direction: string; body: string }[];
}): Promise<Classification> {
  const transcript = params.recentThread
    .map((m) => `${m.direction === "inbound" ? "Seller" : "Us"}: ${m.body}`)
    .join("\n");

  const user = `Conversation state: ${params.conversationState}

Recent thread:
${transcript || "(no prior messages)"}

Classify this new inbound message:
${params.body}`;

  return (await jsonCall({
    system: SYSTEM,
    user,
    schema: classificationSchema,
    jsonSchema: CLASSIFICATION_JSON_SCHEMA,
    effort: "low",
  })) as Classification;
}
