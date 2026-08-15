/**
 * Buy boxes (§10 amendment, Aug 15 2026).
 *
 * A builder is not one set of numbers. The same buyer pays differently in Cape
 * Coral than in Lehigh Acres, and within one city pays differently depending on
 * what utilities a lot has — city water and sewer is worth far more than well
 * and septic, because the next owner has to pay to put those in.
 *
 * Two mistakes to avoid, and they pull in opposite directions:
 *
 *   1. One buy box per utility combination. Four near-identical rows per city
 *      that all have to be edited together, and drift the moment one is missed.
 *   2. One buy box with a single price. Loses the distinction that decides
 *      whether a deal is worth doing.
 *
 * So: **one buy box per market**, carrying a small price matrix over utilities.
 * The size floor, flood tolerance and wetlands rule are stated once. The price
 * varies by utility combination inside that one entry. A buyer who doesn't care
 * about utilities leaves the matrix empty and gets a single base price.
 *
 * Pure functions, no I/O.
 */

export type WaterSource = "city" | "well";
export type SewerType = "city" | "septic";

/** What we determined about a lot's utilities. Unknown is honest, not a guess. */
export type ParcelUtilities = {
  water?: WaterSource;
  sewer?: SewerType;
  /** Free-text provenance for the context card, e.g. "Cape Coral UEP — assessed 2019". */
  detail?: string;
};

/**
 * One row of the price matrix. `"any"` matches either value, so a buyer who
 * only prices on sewer writes two rows instead of four.
 */
export type UtilityRule = {
  water: WaterSource | "any";
  sewer: SewerType | "any";
  /** Cents. Omitted means "use the buy box's base price". */
  buyPriceCents?: number;
  /** False means this combination is a hard no, whatever the price. */
  accepted: boolean;
};

export type BuyBox = {
  id: string;
  builderId: string;
  builderName: string;
  /** Marlon's name for it — "Cape Coral standard". */
  name: string;

  // --- Where it applies. County is required; city and zip narrow it. ---
  county: string;
  cities: string[];
  zips: string[];

  // --- What the lot has to be ---
  minSqft: number;
  allowedFloodZones: string[];
  wetlandsAllowed: boolean;

  // --- What it's worth ---
  /** Cents. The price when no utility rule applies. */
  baseBuyPriceCents: number;
  minAssignmentFeeCents: number;
  anchorPct: number;
  concessionSteps?: number[];
  /** Empty means utilities don't affect this buyer's price. */
  utilityRules: UtilityRule[];
};

/**
 * How well a buy box matches a parcel's location, or null if it doesn't apply.
 * Higher is more specific, so a zip-level box beats a city-level one.
 */
export function scopeScore(box: BuyBox, place: { county: string; city?: string | null; zip?: string | null }): number | null {
  if (box.county.toLowerCase() !== place.county.toLowerCase()) return null;

  const norm = (v: string) => v.trim().toLowerCase();

  if (box.zips.length > 0) {
    // A zip list is a promise about zips; a lot with no zip on file can't
    // satisfy it, and assuming otherwise would price the wrong market.
    if (!place.zip) return null;
    if (!box.zips.map(norm).includes(norm(place.zip))) return null;
    return 3;
  }

  if (box.cities.length > 0) {
    if (!place.city) return null;
    if (!box.cities.map(norm).includes(norm(place.city))) return null;
    return 2;
  }

  return 1; // county-wide
}

/** The most specific buy box that covers this location, per builder. */
export function boxesForPlace(
  boxes: BuyBox[],
  place: { county: string; city?: string | null; zip?: string | null },
): BuyBox[] {
  const best = new Map<string, { box: BuyBox; score: number }>();
  for (const box of boxes) {
    const score = scopeScore(box, place);
    if (score === null) continue;
    const current = best.get(box.builderId);
    // A tie keeps the first, which is stable given a stable query order.
    if (!current || score > current.score) best.set(box.builderId, { box, score });
  }
  return [...best.values()].map((v) => v.box);
}

export type UtilityPrice =
  | { accepted: true; buyPriceCents: number; rule: UtilityRule | null }
  | { accepted: false; reason: string };

/**
 * What this buyer pays for a lot with these utilities.
 *
 * An empty matrix means utilities are irrelevant to them — base price, always.
 * A non-empty matrix is an allowlist: a combination nobody wrote a rule for is
 * declined rather than quietly sold at the base price, because the whole point
 * of the matrix is that utilities change what the lot is worth.
 *
 * Unknown utilities never resolve to a price when the matrix is non-empty.
 * Guessing "probably city water" is how you promise a number you can't honour.
 */
export function priceForUtilities(box: BuyBox, utilities: ParcelUtilities): UtilityPrice {
  if (box.utilityRules.length === 0) {
    return { accepted: true, buyPriceCents: box.baseBuyPriceCents, rule: null };
  }

  if (!utilities.water || !utilities.sewer) {
    return { accepted: false, reason: "utilities unknown and this buyer prices on them" };
  }

  const matches = box.utilityRules
    .map((rule) => {
      const waterOk = rule.water === "any" || rule.water === utilities.water;
      const sewerOk = rule.sewer === "any" || rule.sewer === utilities.sewer;
      if (!waterOk || !sewerOk) return null;
      // Exact beats "any", so a specific rule overrides a catch-all.
      const specificity = (rule.water === "any" ? 0 : 1) + (rule.sewer === "any" ? 0 : 1);
      return { rule, specificity };
    })
    .filter((m): m is { rule: UtilityRule; specificity: number } => m !== null)
    .sort((a, b) => b.specificity - a.specificity);

  const best = matches[0];
  if (!best) {
    return {
      accepted: false,
      reason: `no rule for ${utilities.water} water + ${utilities.sewer} sewer`,
    };
  }
  if (!best.rule.accepted) {
    return { accepted: false, reason: `buyer excludes ${utilities.water} water + ${utilities.sewer} sewer` };
  }

  return {
    accepted: true,
    buyPriceCents: best.rule.buyPriceCents ?? box.baseBuyPriceCents,
    rule: best.rule,
  };
}

/** Human summary of a matrix, for the buyer screen. */
export function describeUtilityRules(rules: UtilityRule[]): string {
  if (rules.length === 0) return "Utilities don't affect this buyer's price";
  return rules
    .map((r) => {
      const combo = `${r.water === "any" ? "any" : r.water} water + ${r.sewer === "any" ? "any" : r.sewer} sewer`;
      if (!r.accepted) return `${combo}: won't buy`;
      return `${combo}: ${r.buyPriceCents != null ? `$${(r.buyPriceCents / 100).toLocaleString("en-US")}` : "base price"}`;
    })
    .join(" · ");
}
