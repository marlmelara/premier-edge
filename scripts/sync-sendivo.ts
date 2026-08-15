/**
 * Pull Sendivo's SMS logs into Premier Edge.
 *
 * `GET /sms/logs` is outbound-only (verified: 10,153 rows over six weeks, every
 * one from our own numbers), so this reconstructs the blast audience and the
 * outbound side of every thread. Seller replies still arrive only by webhook —
 * but once this has run, those replies land on threads that already exist.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/sync-sendivo.ts            # last 90 days
 *   npx dotenv -e .env.local -- npx tsx scripts/sync-sendivo.ts --days 180
 *   npx dotenv -e .env.local -- npx tsx scripts/sync-sendivo.ts --since 2026-07-01
 *
 * Idempotent — dedupes on Sendivo's message_id, so re-running is a no-op.
 */
import dns from "node:dns";
import { getDb } from "../src/db";
import { syncSmsLogs } from "../src/lib/sendivo/sync";

dns.setDefaultResultOrder("ipv4first");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const sinceFlag = flag("since");
  const days = flag("days") ? Number(flag("days")) : 90;
  const since = sinceFlag ? new Date(`${sinceFlag}T00:00:00Z`) : new Date(Date.now() - days * 86_400_000);

  if (Number.isNaN(since.getTime())) {
    console.error("Bad --since date. Use YYYY-MM-DD.");
    process.exit(1);
  }

  console.log(`\nSyncing Sendivo SMS logs since ${since.toISOString().slice(0, 10)}…\n`);

  const result = await syncSmsLogs(getDb(), {
    since,
    onProgress: (window, count) => console.log(`  ${window}  ${count} logs`),
  });

  console.log(`
📥 ${result.logsSeen.toLocaleString("en-US")} logs across ${result.windows} windows
   ${result.contactsUpserted.toLocaleString("en-US")} contacts touched
   ${result.threadsCreated.toLocaleString("en-US")} threads created
   ${result.messagesInserted.toLocaleString("en-US")} messages inserted
   ${result.awaitingThread.toLocaleString("en-US")} outbound held (contact has not replied yet — no thread)\n   ${result.skippedOwnNumber} skipped (our own alerts, not sellers)`);

  if (result.errors.length) {
    console.log(`\n⚠️  ${result.errors.length} window(s) failed:`);
    for (const e of result.errors.slice(0, 5)) console.log(`   ${e}`);
  }

  console.log(
    "\nNote: these are OUTBOUND only — Sendivo has no readable endpoint for seller replies.\n" +
      "Inbound still depends on the webhook.\n",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
