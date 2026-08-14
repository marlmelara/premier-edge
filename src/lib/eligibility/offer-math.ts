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
   * Concession ladder as fractions of **max offer**, ascending, each in
   * (0, 1] — the same unit as anchorPct, so the whole ladder reads in one
   * scale: 0.78 anchor → 0.9 → 1.0 ceiling. Steps at or below the anchor are
   * dropped, and the ladder always ends exactly on maxOffer.
   * Default [0.9, 1].
   */
  concessionSteps?: number[];
};

const DEFAULT_CONCESSION_STEPS = [0.9, 1];
const ROUND_TO = 100 * 100; // offers round to whole $100s — sellers never see $14,287.53

const roundDownTo = (cents: Cents, step: number) => Math.floor(cents / step) * step;

/** Ceiling: builder price minus our fee floor. Mirrors criteria_sets.max_offer (DB-generated). */
export function maxOffer(c: OfferCriteria): Cents {
  const value = c.builderBuyPrice - c.minAssignmentFee;
  if (value <= 0) throw new Error("criteria produce a non-positive max offer");
  return value;
}

/** Start-at price: anchorPct of max, rounded down to $100, never above the ceiling. */
export function anchorOffer(c: OfferCriteria): Cents {
  const max = maxOffer(c);
  return Math.min(roundDownTo(max * c.anchorPct, ROUND_TO), max);
}

/**
 * Every offer amount the agent is ever allowed to send, ascending: the anchor,
 * then each concession step as a fraction of max (rounded down to $100),
 * ending exactly at maxOffer.
 */
export function concessionLadder(c: OfferCriteria): Cents[] {
  const max = maxOffer(c);
  const steps = c.concessionSteps?.length ? c.concessionSteps : DEFAULT_CONCESSION_STEPS;

  const ladder = [anchorOffer(c)];
  for (const step of steps) {
    const rung = step >= 1 ? max : roundDownTo(max * step, ROUND_TO);
    if (rung > ladder[ladder.length - 1] && rung <= max) ladder.push(rung);
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

/**
 * The amount we may actually put in front of *this* seller: the next rung on
 * the ladder, but never above a price the seller has already named.
 *
 * Without the cap, a seller who says "I'd take 80k" gets answered with our
 * 101.4k anchor and we hand them $21,400 they never asked for. The ladder sets
 * the ceiling for the negotiation; their own number sets the ceiling for this
 * message.
 *
 * @param sellerAsk what the seller said they want, in cents, or null if they
 *        haven't named a number yet.
 */
export function offerFor(c: OfferCriteria, lastOffer: Cents | null, sellerAsk: Cents | null): Cents | null {
  const rung = nextAllowedOffer(c, lastOffer);
  if (rung === null) return null;
  if (sellerAsk === null || sellerAsk >= rung) return rung;
  // They want less than our next rung. Meet their number — but never go below
  // what we already put in writing, which would be a retrade.
  return lastOffer === null ? sellerAsk : Math.max(sellerAsk, lastOffer);
}

/** Negotiation room between the last offer (or anchor) and the ceiling — computed, never typed (§2.1). */
export function roomLeft(c: OfferCriteria, lastOffer: Cents | null): Cents {
  return maxOffer(c) - (lastOffer ?? anchorOffer(c));
}

/**
 * Dollar-validation primitive (M3): an amount is sendable if it sits on the
 * ladder, or if it's a seller's own asking price we're meeting under the
 * ceiling. Never above maxOffer, whatever the seller said.
 */
export function isAllowedOfferAmount(c: OfferCriteria, amount: Cents, sellerAsk: Cents | null = null): boolean {
  if (amount > maxOffer(c)) return false;
  if (concessionLadder(c).includes(amount)) return true;
  return sellerAsk !== null && amount === sellerAsk;
}
