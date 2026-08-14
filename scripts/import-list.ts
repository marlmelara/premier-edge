/**
 * Import a blast list, resolve every lot, and pre-qualify it against a
 * campaign's buyers — before a single text goes out.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/import-list.ts <csv> <county> [--campaign <id>] [--limit N] [--dry]
 *
 * Examples:
 *   # See how the columns map and what would happen, touching nothing:
 *   npx dotenv -e .env.local -- npx tsx scripts/import-list.ts cape-coral.csv lee --dry
 *
 *   # Import and pre-qualify, then write the blast-ready subset:
 *   npx dotenv -e .env.local -- npx tsx scripts/import-list.ts cape-coral.csv lee --campaign <uuid>
 *
 * Output: `<csv-basename>.blast-ready.csv` — the contacts whose lots a buyer on
 * the campaign would actually take. That's the file to upload to Sendivo.
 */
import dns from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isCountyKey, listCounties } from "../src/adapters/registry";
import { getDb } from "../src/db";
import { parseList } from "../src/lib/lists/csv";
import { importList } from "../src/lib/lists/import";
import { blastReadyContacts, prequalifyList, toCsv } from "../src/lib/lists/prequalify";

dns.setDefaultResultOrder("ipv4first"); // hazards.fema.gov publishes broken IPv6

const args = process.argv.slice(2);
/** Flags that take a value; everything else beginning with -- is a boolean. */
const VALUED = new Set(["campaign", "limit"]);

const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

/** Positionals, skipping flags and the values that belong to them. */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUED.has(a.slice(2))) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main() {
  const [csvPath, county] = positionals();

  if (!csvPath || !county || !isCountyKey(county)) {
    console.error(
      `Usage: import-list <csv> <county> [--campaign <id>] [--limit N] [--dry]\nCounties: ${listCounties().join(", ")}`,
    );
    process.exit(1);
  }

  const parsed = parseList(readFileSync(csvPath, "utf8"));
  console.log(`\n${basename(csvPath)} — ${parsed.rows.length} rows with a usable phone number`);
  if (parsed.skipped) console.log(`  ${parsed.skipped} rows skipped (no valid phone)`);

  console.log("\nColumn mapping:");
  for (const [field, index] of Object.entries(parsed.headerMap)) {
    console.log(`  ${field.padEnd(18)} → column ${index}`);
  }
  if (parsed.unmapped.length) {
    console.log(`\n  Unmapped columns (kept in raw, not used): ${parsed.unmapped.join(", ")}`);
  }
  if (!parsed.headerMap.parcelId && !parsed.headerMap.propertyAddress) {
    console.error("\n❌ No parcel id and no property address column — nothing can be resolved. Check the headers.");
    process.exit(1);
  }

  if (has("dry")) {
    console.log("\n--dry: stopping before any writes. Sample row:");
    console.log(JSON.stringify(parsed.rows[0], null, 2));
    process.exit(0);
  }

  const limit = flag("limit") ? Number(flag("limit")) : undefined;
  const db = getDb();

  console.log("\nImporting…");
  const imported = await importList(db, parsed.rows, {
    county,
    limit,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    },
  });
  console.log(
    `\n  ${imported.contacts} contacts · ${imported.parcelsLinked} lots resolved · ` +
      `${imported.unresolved.length} unresolved · ${imported.optedOut} already opted out`,
  );
  if (imported.errors.length) console.log(`  ${imported.errors.length} errors`);

  if (imported.unresolved.length) {
    console.log("\n  Unresolved (first 10) — these need a parcel id by hand:");
    for (const u of imported.unresolved.slice(0, 10)) {
      console.log(`    ${u.phone}  ${u.address ?? "(no address)"}  — ${u.reason}`);
    }
    const path = join(dirname(csvPath), `${basename(csvPath, ".csv")}.unresolved.csv`);
    writeFileSync(
      path,
      "phone,property_address,reason\n" +
        imported.unresolved.map((u) => `${u.phone},"${u.address ?? ""}","${u.reason}"`).join("\n") +
        "\n",
    );
    console.log(`  Full list: ${path}`);
  }

  const campaignId = flag("campaign");
  if (!campaignId) {
    console.log("\nNo --campaign given, so nothing was pre-qualified.");
    console.log("Re-run with --campaign <id> to score these lots against that campaign's buyers.");
    process.exit(0);
  }

  console.log("\nPre-qualifying against the campaign's buy boxes…");
  const scored = await prequalifyList(db, {
    county,
    campaignId,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    },
  });

  console.log(`\n\n  ✅ ${scored.fits.length} lots a buyer will take`);
  console.log(`  ❌ ${scored.fails.length} lots nobody takes today (now in the land bank)`);
  if (scored.pending.length) console.log(`  ⏳ ${scored.pending.length} inconclusive — a GIS service was down, re-run`);
  if (scored.errors.length) console.log(`  ⚠️  ${scored.errors.length} errors`);

  const reasonCounts = new Map<string, number>();
  for (const f of scored.fails) {
    for (const r of f.reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  if (reasonCounts.size) {
    console.log("\n  Why lots failed:");
    for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(5)}  ${reason}`);
    }
  }

  const blast = await blastReadyContacts(db, county, scored.fits.map((f) => f.parcelId));
  const outPath = join(dirname(csvPath), `${basename(csvPath, ".csv")}.blast-ready.csv`);
  writeFileSync(outPath, toCsv(blast));

  console.log(`\n📤 ${blast.length} contacts worth texting → ${outPath}`);
  console.log(`   ${parsed.rows.length - blast.length} of the original ${parsed.rows.length} rows filtered out.\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
