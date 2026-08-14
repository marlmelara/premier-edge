/**
 * Exercises the real agent path against the live Anthropic API: classify an
 * inbound seller message, then draft a reply with a code-authorized amount, and
 * confirm dollar-validation passes.
 *
 * Costs a few cents per run. Uses no database.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/test-agent.ts
 */
import { classifyInbound } from "../src/lib/agent/classify";
import { draftReply } from "../src/lib/agent/draft";

async function main() {
  console.log("--- classify ---");
  const classification = await classifyInbound({
    body: "Yeah I still own that lot on 15th. What would you pay for it?",
    conversationState: "QUALIFYING",
    recentThread: [{ direction: "outbound", body: "Hi, are you open to selling your vacant lot in Lehigh Acres?" }],
  });
  console.log(JSON.stringify(classification, null, 2));

  console.log("\n--- draft (authorized: $18,700) ---");
  const draft = await draftReply({
    classification: classification.classification,
    conversationState: "OFFER_SENT",
    sellerName: "Agustin Castillo",
    parcelAddress: "3219 15TH ST SW, LEHIGH ACRES",
    county: "Lee",
    authorizedOfferCents: 1_870_000,
    sellerCounterCents: null,
    recentThread: [
      { direction: "outbound", body: "Hi, are you open to selling your vacant lot in Lehigh Acres?" },
      { direction: "inbound", body: "Yeah I still own that lot on 15th. What would you pay for it?" },
    ],
  });

  if (draft.ok) {
    console.log("MESSAGE:", draft.message);
    console.log("NOTES:  ", draft.notes);
    console.log("amounts found (cents):", draft.validation.amounts);
    console.log("\n✅ dollar-validation PASSED");
  } else {
    console.log("MESSAGE:", draft.message);
    console.log("❌ dollar-validation REJECTED — disallowed:", draft.validation.ok ? [] : draft.validation.disallowed);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
