import dns from "node:dns";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { verifyParcel } from "./verify-parcel";

/**
 * Live integration test — hits the real county GIS, FEMA, and NWI services
 * plus the local database. Opt-in so CI stays hermetic:
 *
 *   RUN_LIVE=1 npx dotenv -e .env.local -- vitest run src/lib/eligibility/verify-parcel.live.test.ts
 */
describe.skipIf(process.env.RUN_LIVE !== "1")("verifyParcel (live)", () => {
  dns.setDefaultResultOrder("ipv4first"); // hazards.fema.gov has broken IPv6

  it("verifies a real vacant Lehigh Acres lot end-to-end", { timeout: 60_000 }, async () => {
    const result = await verifyParcel(getDb(), "lee", "354426L3121060010", {
      minSqft: 10_000,
      allowedFloodZones: ["X"],
      wetlandsAllowed: false,
    });

    expect(result).not.toBeNull();
    console.log("verdict:", result!.verdict);
    for (const { kind, outcome } of result!.outcomes) {
      console.log(`  ${kind}: ${outcome.result} — ${outcome.summary}`);
    }

    expect(result!.parcel.ownerNameRaw).toBe("CASTILLO AGUSTIN PONCE");
    expect(result!.parcel.sqft).toBe(11530);
    expect(result!.outcomes).toHaveLength(4);
    expect(result!.outcomes.find((o) => o.kind === "sqft")?.outcome.result).toBe("pass");
    expect(["pass", "fail", "pending"]).toContain(result!.verdict);
  });

  it("returns null for a nonexistent parcel", { timeout: 30_000 }, async () => {
    const result = await verifyParcel(getDb(), "lee", "DOES-NOT-EXIST-000", {
      minSqft: 10_000,
      allowedFloodZones: ["X"],
      wetlandsAllowed: false,
    });
    expect(result).toBeNull();
  });
});
