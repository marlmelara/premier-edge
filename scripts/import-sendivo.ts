/**
 * Import Sendivo's own CSV exports into Premier Edge.
 *
 * Sendivo's API can't be read (no list endpoint for conversations, messages,
 * contacts, or opt-outs — all verified 404/405), and the webhook only carries
 * messages sent *after* it starts working. This is how everything already in
 * Sendivo gets in.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/import-sendivo.ts optouts <csv> [--dry]
 *   npx dotenv -e .env.local -- npx tsx scripts/import-sendivo.ts history <csv> [--dry]
 *
 * Run `optouts` FIRST and before any blast from Premier Edge. Suppression reads
 * this database, so anyone who sent STOP to Sendivo will be texted again until
 * their number is in here.
 *
 * Both are idempotent — re-running merges instead of duplicating.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getDb } from "../src/db";
import {
  importMessageHistory,
  importOptOuts,
  parseMessageExport,
  parseOptOutExport,
} from "../src/lib/lists/sendivo-export";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const [mode, csvPath] = args.filter((a) => !a.startsWith("--"));

async function main() {
  if (!mode || !csvPath || (mode !== "optouts" && mode !== "history")) {
    console.error("Usage: import-sendivo <optouts|history> <csv> [--dry]");
    process.exit(1);
  }

  const text = readFileSync(csvPath, "utf8");
  console.log(`\n${basename(csvPath)}\n`);

  if (mode === "optouts") {
    const parsed = parseOptOutExport(text);
    console.log(
      parsed.mode === "flag_column"
        ? "  Found an opt-out flag column — only flagged rows will be suppressed."
        : "  No opt-out flag column found — treating EVERY row as an opt-out.",
    );
    console.log(`  ${parsed.rows.length} numbers to suppress · ${parsed.skipped} rows skipped (no valid phone)`);

    if (parsed.rows.length === 0) {
      console.error("\n❌ Nothing to import. Check that the file has a phone column.");
      process.exit(1);
    }
    console.log(`  Sample: ${parsed.rows.slice(0, 5).map((r) => r.phone).join(", ")}`);

    if (dry) {
      console.log("\n--dry: stopping before any writes.\n");
      process.exit(0);
    }

    const result = await importOptOuts(getDb(), parsed.rows);
    console.log(
      `\n🚫 ${result.suppressed} newly suppressed · ${result.alreadyKnown} already known · ` +
        `${result.contactsCreated} contacts created for numbers we'd never seen\n`,
    );
    process.exit(0);
  }

  const parsed = parseMessageExport(text);
  console.log(`  ${parsed.rows.length} messages parsed · ${parsed.skipped} skipped`);
  if (parsed.skipped > 0) {
    console.log("  Skipped rows were missing a phone, a body, or a readable direction — none were guessed at.");
  }
  if (parsed.unmapped.length) console.log(`  Unmapped columns: ${parsed.unmapped.join(", ")}`);

  if (parsed.rows.length === 0) {
    console.error("\n❌ Nothing to import. The file needs phone, message body, and direction columns.");
    process.exit(1);
  }

  const phones = new Set(parsed.rows.map((r) => r.phone));
  console.log(`  ${phones.size} distinct sellers`);
  console.log(`\n  Sample: [${parsed.rows[0].direction}] ${parsed.rows[0].body.slice(0, 70)}`);

  if (dry) {
    console.log("\n--dry: stopping before any writes.\n");
    process.exit(0);
  }

  const result = await importMessageHistory(getDb(), parsed.rows);
  console.log(
    `\n💬 ${result.threads} threads created · ${result.messagesInserted} messages inserted · ` +
      `${result.duplicatesSkipped} already present`,
  );
  if (result.suppressedContacts > 0) {
    console.log(`   ${result.suppressedContacts} of those sellers are opted out — their threads are terminal.`);
  }
  console.log("\n   The agent was NOT run on these: they already happened and were already answered.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
