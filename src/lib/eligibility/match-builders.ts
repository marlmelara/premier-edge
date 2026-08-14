import { anchorOffer, maxOffer, type OfferCriteria } from "./offer-math";
import { evaluateFloodZones, evaluateSqft, evaluateWetlands, type CheckOutcome } from "./rules";
import type { FloodZoneHit } from "./fema";
import type { WetlandHit } from "./nwi";

/**
 * Buyer matching (design doc §6 + the multi-buyer amendment to §10).
 *
 * The expensive part of due diligence — county parcel lookup, FEMA flood zones,
 * NWI wetlands — is per *parcel* and runs once. Whether the lot is worth buying
 * is per *buyer*: each has their own size floor, flood/wetland tolerance, and
 * buy price. So we gather the facts once and score them against every buyer on
 * the campaign.
 *
 * Pure functions, no I/O.
 */

/** What the GIS pipeline learned about the parcel, independent of any buyer. */
export type ParcelFacts = {
  sqft?: number;
  floodZones: FloodZoneHit[];
  wetlands: WetlandHit[];
  /** True when a GIS service failed, so a "fits" verdict can't be trusted. */
  checksIncomplete: boolean;
};

export type BuilderCriteria = {
  builderId: string;
  builderName: string;
  minSqft: number;
  allowedFloodZones: string[];
  wetlandsAllowed: boolean;
  /** cents */
  builderBuyPrice: number;
  /** cents */
  minAssignmentFee: number;
  anchorPct: number;
  concessionSteps?: number[];
  /** Empty means the builder buys anywhere. */
  markets?: string[];
};

export type BuilderMatch = {
  builderId: string;
  builderName: string;
  fits: boolean;
  /** Human-readable reasons this buyer is out, for the context card. */
  failures: string[];
  outcomes: { kind: "fema" | "nwi" | "sqft"; outcome: CheckOutcome }[];
  /** cents — what we could pay if this buyer takes it. */
  maxOfferCents: number;
  anchorCents: number;
  /** Our spread if they buy at their price. */
  assignmentFeeCents: number;
};

function marketMatches(criteria: BuilderCriteria, parcelMarket?: string | null): boolean {
  if (!criteria.markets?.length || !parcelMarket) return true;
  const needle = parcelMarket.toLowerCase();
  return criteria.markets.some((m) => needle.includes(m.toLowerCase()) || m.toLowerCase().includes(needle));
}

/**
 * Score one parcel against every buyer, best offer first. A buyer only "fits"
 * when every check passes — an errored GIS check never counts as a pass, so a
 * service outage can't manufacture a match.
 */
export function matchBuilders(
  facts: ParcelFacts,
  criteria: BuilderCriteria[],
  parcelMarket?: string | null,
): BuilderMatch[] {
  return criteria
    .map((c): BuilderMatch => {
      const fema = evaluateFloodZones(facts.floodZones, c.allowedFloodZones);
      const nwi = evaluateWetlands(facts.wetlands, c.wetlandsAllowed);
      const sqft = evaluateSqft(facts.sqft, c.minSqft);

      const failures: string[] = [];
      if (fema.result === "fail") failures.push(`flood zone ${fema.summary}`);
      if (fema.result === "error") failures.push("flood check unavailable");
      if (nwi.result === "fail") failures.push("wetlands intersect");
      if (nwi.result === "error") failures.push("wetlands check unavailable");
      if (sqft.result === "fail") failures.push(`too small (${sqft.summary})`);
      if (sqft.result === "error") failures.push("size unknown");
      if (!marketMatches(c, parcelMarket)) failures.push(`outside ${c.builderName}'s markets`);

      const oc: OfferCriteria = {
        builderBuyPrice: c.builderBuyPrice,
        minAssignmentFee: c.minAssignmentFee,
        anchorPct: c.anchorPct,
        concessionSteps: c.concessionSteps,
      };

      // A buyer whose fee floor exceeds their buy price can't produce an offer;
      // treat that as a config failure rather than crashing the pipeline.
      let maxOfferCents = 0;
      let anchorCents = 0;
      try {
        maxOfferCents = maxOffer(oc);
        anchorCents = anchorOffer(oc);
      } catch {
        failures.push(`${c.builderName}'s buy price is below their fee floor`);
      }

      return {
        builderId: c.builderId,
        builderName: c.builderName,
        fits: failures.length === 0,
        failures,
        outcomes: [
          { kind: "fema", outcome: fema },
          { kind: "nwi", outcome: nwi },
          { kind: "sqft", outcome: sqft },
        ],
        maxOfferCents,
        anchorCents,
        assignmentFeeCents: c.minAssignmentFee,
      };
    })
    .sort((a, b) => {
      // Fitting buyers first, then the one who leaves the most negotiating room.
      if (a.fits !== b.fits) return a.fits ? -1 : 1;
      return b.maxOfferCents - a.maxOfferCents;
    });
}

/** The buyer we'd actually assign to: fits, and pays best. */
export function bestMatch(matches: BuilderMatch[]): BuilderMatch | null {
  return matches.find((m) => m.fits) ?? null;
}

/**
 * Deal-level verdict across all buyers: pass if anyone wants it, pending when a
 * check errored (so it's worth retrying), fail when every buyer said no on the
 * facts.
 */
export function verdictFromMatches(matches: BuilderMatch[]): "pass" | "fail" | "pending" {
  if (matches.length === 0) return "pending";
  if (matches.some((m) => m.fits)) return "pass";
  const anyErrored = matches.some((m) => m.outcomes.some((o) => o.outcome.result === "error"));
  return anyErrored ? "pending" : "fail";
}
