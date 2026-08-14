/**
 * Verifies a county adapter end to end against the live services: pulls a real
 * parcel, runs FEMA and NWI on its geometry, and prints what the land bank
 * would store. Run this whenever a county is added or a county changes its GIS.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/verify-adapter.ts lee 354426L3121060010
 *   npx dotenv -e .env.local -- npx tsx scripts/verify-adapter.ts charlotte 402125204030
 *
 * With no parcel id it runs an address search instead, which is the quicker
 * smoke test that a newly added adapter is wired up at all.
 */
import dns from "node:dns";
import { getAdapter, isCountyKey, listCounties } from "../src/adapters/registry";
import { queryFloodZones } from "../src/lib/eligibility/fema";
import { queryWetlands } from "../src/lib/eligibility/nwi";
import { polygonAreaSqft } from "../src/lib/gis/arcgis";

dns.setDefaultResultOrder("ipv4first"); // hazards.fema.gov publishes broken IPv6

const ok = (label: string, detail: string) => console.log(`  ✅ ${label.padEnd(22)} ${detail}`);
const bad = (label: string, detail: string) => console.log(`  ❌ ${label.padEnd(22)} ${detail}`);

async function main() {
  const [county, parcelId] = process.argv.slice(2);
  if (!county || !isCountyKey(county)) {
    console.error(`Usage: verify-adapter <county> [parcelId]\nCounties: ${listCounties().join(", ")}`);
    process.exit(1);
  }

  const adapter = getAdapter(county);
  console.log(`\n${adapter.countyName} County (${adapter.state})`);
  console.log(`source: ${adapter.source}\n`);

  if (!parcelId) {
    const results = await adapter.searchByAddress("ST");
    if (results.length === 0) {
      bad("address search", "returned nothing — check the layer URL and field names");
      process.exit(1);
    }
    ok("address search", `${results.length} results, e.g. ${results[0].parcelId} — ${results[0].address ?? "(no address)"}`);
    console.log("\nRe-run with one of those parcel ids for the full check.");
    process.exit(0);
  }

  const parcel = await adapter.getParcelById(parcelId);
  if (!parcel) {
    bad("parcel lookup", `${parcelId} not found — is the id format right for this county?`);
    process.exit(1);
  }

  ok("parcel lookup", parcel.parcelId);
  const report = (label: string, value: string | undefined, missing: string) => {
    if (value) ok(label, value);
    else bad(label, missing);
  };

  report("address", parcel.address, "missing — contracts need this");
  report("owner of record", parcel.ownerNameRaw, "missing — owner XCHECK can't run");
  report("legal description", parcel.legalDescription && `${parcel.legalDescription.slice(0, 60)}…`, "missing — the PSA needs it");
  report("size", parcel.sqft ? `${parcel.sqft.toLocaleString("en-US")} sqft` : undefined, "missing — size checks can't run");
  report("appraiser link", parcel.appraiserUrl, "missing (nice to have)");

  if (!parcel.geometry) {
    bad("geometry", "missing — flood and wetlands checks are impossible without it");
    process.exit(1);
  }
  const computed = polygonAreaSqft(parcel.geometry);
  ok("geometry", `${parcel.geometry.coordinates[0].length} vertices, ~${Math.round(computed ?? 0).toLocaleString("en-US")} sqft`);

  if (parcel.sqft && computed) {
    const drift = Math.abs(computed - parcel.sqft) / parcel.sqft;
    if (drift < 0.15) ok("size cross-check", `geometry agrees within ${(drift * 100).toFixed(1)}%`);
    else bad("size cross-check", `geometry disagrees by ${(drift * 100).toFixed(1)}% — check the county's units`);
  }

  // National layers — these work anywhere in the US, so a failure here is the
  // service being down, not the adapter being wrong.
  try {
    const zones = await queryFloodZones(parcel.geometry);
    ok("FEMA flood", zones.map((z) => z.zone).join(", ") || "no NFHL coverage at this location");
  } catch (error) {
    bad("FEMA flood", error instanceof Error ? error.message : String(error));
  }

  try {
    const wetlands = await queryWetlands(parcel.geometry);
    ok("NWI wetlands", wetlands.length === 0 ? "clear" : wetlands.map((w) => w.attribute).join(", "));
  } catch (error) {
    bad("NWI wetlands", error instanceof Error ? error.message : String(error));
  }

  console.log("\nIf every line above is ✅, this county is ready to use.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
