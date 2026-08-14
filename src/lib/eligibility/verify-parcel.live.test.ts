import dns from "node:dns";
import { describe, expect, it } from "vitest";
import { matchBuilders, verdictFromMatches, type BuilderCriteria } from "./match-builders";
import { queryFloodZones } from "./fema";
import { queryWetlands } from "./nwi";
import { getAdapter } from "@/adapters/registry";

/**
 * Live due-diligence test: hits the real Lee County appraiser, FEMA NFHL, and
 * USFWS NWI services, then scores the lot against two buyers with different
 * criteria. No database.
 *
 *   RUN_LIVE=1 npx dotenv -e .env.local -- vitest run src/lib/eligibility/verify-parcel.live.test.ts
 */
describe.skipIf(process.env.RUN_LIVE !== "1")("due diligence (live)", () => {
  dns.setDefaultResultOrder("ipv4first"); // hazards.fema.gov has broken IPv6

  it("checks a real Lehigh Acres lot and matches it to the right buyer", { timeout: 60_000 }, async () => {
    const parcel = await getAdapter("lee").getParcelById("354426L3121060010");
    expect(parcel).not.toBeNull();
    expect(parcel!.ownerNameRaw).toBe("CASTILLO AGUSTIN PONCE");
    expect(parcel!.sqft).toBe(11_530);

    const [floodZones, wetlands] = await Promise.all([
      queryFloodZones(parcel!.geometry!),
      queryWetlands(parcel!.geometry!),
    ]);
    console.log("county :", parcel!.address, "|", parcel!.sqft, "sqft");
    console.log("flood  :", floodZones.map((z) => z.zone).join(", ") || "none");
    console.log("wetland:", wetlands.length === 0 ? "clear" : wetlands.map((w) => w.attribute).join(", "));

    const buyers: BuilderCriteria[] = [
      {
        builderId: "big",
        builderName: "Wants big lots",
        minSqft: 40_000,
        allowedFloodZones: ["X"],
        wetlandsAllowed: false,
        builderBuyPrice: 6_000_000,
        minAssignmentFee: 800_000,
        anchorPct: 0.78,
      },
      {
        builderId: "quarter_acre",
        builderName: "Quarter-acre builder",
        minSqft: 10_000,
        allowedFloodZones: ["X"],
        wetlandsAllowed: false,
        builderBuyPrice: 3_200_000,
        minAssignmentFee: 800_000,
        anchorPct: 0.78,
      },
    ];

    const matches = matchBuilders(
      { sqft: parcel!.sqft, floodZones, wetlands, checksIncomplete: false },
      buyers,
      parcel!.address,
    );
    for (const m of matches) {
      console.log(`  ${m.fits ? "✅" : "❌"} ${m.builderName}${m.failures.length ? " — " + m.failures.join("; ") : ""}`);
    }

    // The 11,530 sqft lot is too small for the first buyer, right for the second.
    expect(matches[0].builderId).toBe("quarter_acre");
    expect(matches[0].fits).toBe(true);
    expect(matches.find((m) => m.builderId === "big")!.fits).toBe(false);
    expect(verdictFromMatches(matches)).toBe("pass");
  });
});
