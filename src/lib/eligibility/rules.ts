import type { FloodZoneHit } from "./fema";
import type { WetlandHit } from "./nwi";

/**
 * Pure eligibility rules — no I/O. The LLM never touches these (design doc §6:
 * code owns eligibility). Every outcome carries a human-readable summary for
 * the Property Context Card badge and a detail payload for the checks table.
 */

export type CheckOutcome = {
  result: "pass" | "fail" | "error";
  summary: string;
  detail: Record<string, unknown>;
};

export function evaluateFloodZones(hits: FloodZoneHit[], allowedZones: string[]): CheckOutcome {
  const zones = [...new Set(hits.map((h) => h.zone).filter(Boolean))];
  if (zones.length === 0) {
    // NFHL maps effectively all of coastal Florida; an empty intersection
    // means the geometry fell outside effective NFHL data. Needs eyes.
    return {
      result: "error",
      summary: "No NFHL coverage — manual review",
      detail: { zones, allowedZones, hits },
    };
  }
  const disallowed = zones.filter((z) => !allowedZones.includes(z));
  return disallowed.length === 0
    ? { result: "pass", summary: zones.join(", "), detail: { zones, allowedZones, hits } }
    : { result: "fail", summary: disallowed.join(", "), detail: { zones, disallowed, allowedZones, hits } };
}

export function evaluateWetlands(hits: WetlandHit[], wetlandsAllowed: boolean): CheckOutcome {
  if (hits.length === 0) {
    return { result: "pass", summary: "clear", detail: { intersections: 0 } };
  }
  const types = [...new Set(hits.map((h) => h.wetlandType ?? h.attribute))];
  return wetlandsAllowed
    ? { result: "pass", summary: `intersects (${types.length} type${types.length > 1 ? "s" : ""}, allowed)`, detail: { intersections: hits.length, types, hits } }
    : { result: "fail", summary: "intersects", detail: { intersections: hits.length, types, hits } };
}

export function evaluateSqft(sqft: number | undefined, minSqft: number): CheckOutcome {
  if (sqft === undefined || !Number.isFinite(sqft)) {
    return { result: "error", summary: "size unknown", detail: { sqft, minSqft } };
  }
  const formatted = `${Math.round(sqft).toLocaleString("en-US")} sqft`;
  return sqft >= minSqft
    ? { result: "pass", summary: formatted, detail: { sqft, minSqft } }
    : { result: "fail", summary: `${formatted} < ${minSqft.toLocaleString("en-US")}`, detail: { sqft, minSqft } };
}

/** verdict: any fail → fail; else any error → pending; else pass. */
export function overallVerdict(outcomes: CheckOutcome[]): "pass" | "fail" | "pending" {
  if (outcomes.some((o) => o.result === "fail")) return "fail";
  if (outcomes.some((o) => o.result === "error")) return "pending";
  return "pass";
}
