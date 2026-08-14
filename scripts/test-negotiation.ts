/**
 * Exercises the negotiation stances Marlon described, against the live model:
 * an outrageous counter, a plain "yes I'm interested", and a price question
 * before any parcel is verified.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/test-negotiation.ts
 */
import { draftReply } from "../src/lib/agent/draft";

const cases = [
  {
    label: "outrageous counter — must stay cordial, quote only the authorized number",
    ctx: {
      classification: "counter_offer" as const,
      conversationState: "NEGOTIATING",
      sellerName: "Agustin Castillo",
      parcelAddress: "3219 15TH ST SW, LEHIGH ACRES",
      county: "Lee",
      authorizedOfferCents: 1_870_000,
      sellerCounterCents: 15_000_000,
      recentThread: [
        { direction: "outbound", body: "Are you open to selling your lot in Lehigh Acres?" },
        { direction: "inbound", body: "I want 150,000 for it, not a penny less" },
      ],
    },
  },
  {
    label: "interested, nothing verified yet — must name no price at all",
    ctx: {
      classification: "interested" as const,
      conversationState: "QUALIFYING",
      sellerName: null,
      parcelAddress: null,
      county: null,
      authorizedOfferCents: null,
      sellerCounterCents: null,
      recentThread: [
        { direction: "outbound", body: "Are you open to selling your vacant lot?" },
        { direction: "inbound", body: "yes im interested" },
      ],
    },
  },
  {
    label: "asks price before due diligence — must not guess a number",
    ctx: {
      classification: "asking_price" as const,
      conversationState: "QUALIFYING",
      sellerName: null,
      parcelAddress: null,
      county: null,
      authorizedOfferCents: null,
      sellerCounterCents: null,
      recentThread: [{ direction: "inbound", body: "how much are you paying?" }],
    },
  },
];

async function main() {
  for (const { label, ctx } of cases) {
    const draft = await draftReply(ctx);
    console.log(`\n── ${label}`);
    console.log(`   ${draft.ok ? "✅ dollar-validation passed" : "❌ REJECTED"}`);
    console.log(`   "${draft.message}"`);
    console.log(`   why: ${draft.notes}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
