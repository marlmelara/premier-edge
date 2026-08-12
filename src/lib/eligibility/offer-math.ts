/**
 * Offer math — code owns every dollar figure (design doc §6). The LLM never
 * computes money; any $ amount in an agent draft must equal one of the values
 * these functions produce (dollar-validation, M3).
 *
 * All arithmetic is integer cents. DB numeric(12,2) strings convert at the
 * boundary via toCents/fromCents.
 *
 * NOTE (working agreement §13): the unit tests for this module are
 * Marlon-written — do not add generated tests here.
 */

export type Cents = number;

export function toCents(value: string | number): Cents {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`not a money value: ${value}`);
  return Math.round(n * 100);
}

export function fromCents(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

export type OfferCriteria = {
  /** What the matched builder pays us — numeric(12,2) as cents. */
  builderBuyPrice: Cents;
  /** Our fee floor — the assignment spread we won't go below. */
  minAssignmentFee: Cents;
  /** Anchor as a fraction of max offer (criteria_sets.anchor_pct, default 0.78). */
  anchorPct: number;
  /**
   * Concession ladder as fractions of the anchor→max gap, ascending, each in
   * (0, 1]. The last rung lands exactly on maxOffer. Default [0.4, 0.7, 1].
   */
  concessionSteps?: number[];
};

const DEFAULT_CONCESSION_STEPS = [0.4, 0.7, 1];
const ROUND_TO = 100 * 100; // offers round to whole $100s — sellers never see $14,287.53

const roundDownTo = (cents: Cents, step: number) => Math.floor(cents / step) * step;

/** Ceiling: builder price minus our fee floor. Mirrors criteria_sets.max_offer (DB-generated). */
export function maxOffer(c: OfferCriteria): Cents {
  const value = c.builderBuyPrice - c.minAssignmentFee;
  if (value <= 0) throw new Error("criteria produce a non-positive max offer");
  return value;
}

/** Start-at price: anchorPct of max, rounded down to $100. */
export function anchorOffer(c: OfferCriteria): Cents {
  return roundDownTo(maxOffer(c) * c.anchorPct, ROUND_TO);
}

/**
 * Every offer amount the agent is ever allowed to send, ascending:
 * anchor first, then anchor + gap×step (rounded down to $100), deduped,
 * ending exactly at maxOffer.
 */
export function concessionLadder(c: OfferCriteria): Cents[] {
  const max = maxOffer(c);
  const anchor = anchorOffer(c);
  const gap = max - anchor;
  const steps = c.concessionSteps?.length ? c.concessionSteps : DEFAULT_CONCESSION_STEPS;

  const ladder = [anchor];
  for (const step of steps) {
    const rung = step >= 1 ? max : roundDownTo(anchor + gap * step, ROUND_TO);
    if (rung > ladder[ladder.length - 1]) ladder.push(rung);
  }
  if (ladder[ladder.length - 1] !== max) ladder.push(max);
  return ladder;
}

/** Next rung above lastOffer, or null when the ladder is exhausted (→ ceiling reached, escalate). */
export function nextAllowedOffer(c: OfferCriteria, lastOffer: Cents | null): Cents | null {
  const ladder = concessionLadder(c);
  if (lastOffer === null) return ladder[0];
  return ladder.find((rung) => rung > lastOffer) ?? null;
}

/** Negotiation room between the last offer (or anchor) and the ceiling — computed, never typed (§2.1). */
export function roomLeft(c: OfferCriteria, lastOffer: Cents | null): Cents {
  return maxOffer(c) - (lastOffer ?? anchorOffer(c));
}

/** Dollar-validation primitive (M3): a drafted amount must sit on the ladder. */
export function isAllowedOfferAmount(c: OfferCriteria, amount: Cents): boolean {
  return concessionLadder(c).includes(amount);
}
