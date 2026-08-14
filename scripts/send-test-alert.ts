/**
 * Sends one real test alert to MARLON_PHONE through Sendivo, to verify the
 * §11b Channel 2 path end to end (client → send → agent_actions log).
 *
 * Copilot mode is only safe if escalations actually reach the phone, so this is
 * worth re-running after any deploy or credential change.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/send-test-alert.ts
 */
import { getDb } from "../src/db";
import { sendUrgentAlert } from "../src/lib/alerts";

async function main() {
  const result = await sendUrgentAlert(getDb(), {
    type: "escalation",
    message:
      "🚨 Premier Edge test — escalation alerts are wired. A real one names the seller and the reason. No action needed.",
  });

  console.log("alert result:", JSON.stringify(result));
  process.exit(result.sent ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
