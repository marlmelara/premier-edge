import { maxOffer, offerFor, type Cents, type OfferCriteria } from "@/lib/eligibility/offer-math";
import type { InboundClass } from "./state-machine";

/**
 * Negotiation policy — *when* we name a number, as opposed to offer-math's
 * *which* number (design doc §2.1, amended Aug 14 2026).
 *
 * The sequence Marlon negotiates by hand, encoded:
 *
 *   1. The opener never carries a price. We ask if they'd sell, nothing more.
 *   2. When they engage, we ask what they want for it — twice if we have to.
 *      A seller who would have taken $80k should never hear our $101k anchor.
 *   3. If they won't name a number and want ours, we open at the anchor.
 *   4. Whatever they say, our number is capped by theirs: we never offer more
 *      than a seller has already asked for.
 *   5. Silence after an offer gets chased, not abandoned: a nudge the same day
 *      restating the same number, then one "we went back to our partners"
 *      raise a couple of days later.
 *
 * Pure functions — no I/O, no model. run.ts and the follow-up cron supply the
 * facts; this decides the move.
 */

/** How many times we ask for the seller's number before we put ours down first. */
export const MAX_PROBES = 2;

/**
 * How many times we ask what utilities the lot has before pricing without them.
 *
 * Once. Charlotte and St. Lucie publish no service-area layer — verified
 * against both counties' own catalogs — so outside Lee the seller is the only
 * source. But a seller who ignores the question is telling us something, and
 * the buy box that needs the answer declines on its own rather than guessing.
 */
export const MAX_UTILITY_ASKS = 1;
/** Same-day chase on an unanswered offer — same money, just a check-in. */
export const NUDGE_AFTER_HOURS = 4;
/** The "we spoke with our partners" raise, once the nudge also goes unanswered. */
export const PARTNER_BUMP_AFTER_HOURS = 48;
/** Nudge + bump, then we stop. A third unanswered chase is harassment, not sales. */
export const MAX_FOLLOW_UPS = 2;

/** What the model is being asked to write. Drives the drafting instruction. */
export type DraftIntent = "reply" | "probe" | "utility_probe" | "offer" | "nudge" | "partner_bump";

export type OfferDecision =
  | { kind: "no_price"; intent: "reply" | "probe" | "utility_probe"; reason: string }
  | { kind: "offer"; intent: "offer"; cents: Cents; isCeiling: boolean; meetsSellerAsk: boolean }
  | { kind: "ceiling_reached" };

/** Classes where the seller is angling for a price. */
const PRICE_CLASSES: InboundClass[] = ["asking_price", "counter_offer"];
/** Classes where asking what they want is the natural next thing to say. */
const PROBE_CLASSES: InboundClass[] = ["interested", "asking_price"];

export function decideOffer(input: {
  klass: InboundClass;
  /** null when the lot isn't verified or no buyer's criteria it fits. */
  criteria: OfferCriteria | null;
  lastOfferCents: Cents | null;
  sellerAskCents: Cents | null;
  probesSoFar: number;
  /**
   * True when a buyer on this lot prices on utilities and we haven't determined
   * them. Outside Lee there is no published layer, so the seller is the source.
   */
  utilitiesWouldDecide?: boolean;
  /** How many times we've already asked what utilities the lot has. */
  utilityAsksSoFar?: number;
}): OfferDecision {
  const wantsPrice = PRICE_CLASSES.includes(input.klass);
  const probeable = PROBE_CLASSES.includes(input.klass);
  if (!wantsPrice && !probeable) {
    return { kind: "no_price", intent: "reply", reason: `${input.klass} does not call for a price` };
  }

  // The due-diligence gate: no money talk at all until a verified parcel has a
  // buyer whose criteria it satisfies.
  if (!input.criteria) {
    return { kind: "no_price", intent: "reply", reason: "no verified buyer match" };
  }

  // Ask before we tell. Anchoring at a seller who'd have taken less is the most
  // expensive mistake available on this thread, and it's unrecoverable — you
  // can't walk a number back.
  const namedAPrice = input.sellerAskCents !== null;
  if (!namedAPrice && input.lastOfferCents === null && input.probesSoFar < MAX_PROBES) {
    return {
      kind: "no_price",
      intent: "probe",
      reason: `asking for their number (${input.probesSoFar + 1} of ${MAX_PROBES})`,
    };
  }

  // Settle utilities before naming a price, but only when a buyer actually
  // prices on them. If every buyer on this lot ignores water and sewer, asking
  // spends a round trip and changes nothing — that thread gets a number now.
  if (input.utilitiesWouldDecide && (input.utilityAsksSoFar ?? 0) < MAX_UTILITY_ASKS) {
    return {
      kind: "no_price",
      intent: "utility_probe",
      reason: "a buyer prices on utilities and we don't know them yet",
    };
  }

  // Either they gave us a number, or they won't and it's on us to start.
  const cents = offerFor(input.criteria, input.lastOfferCents, input.sellerAskCents);
  if (cents === null) return { kind: "ceiling_reached" };

  return {
    kind: "offer",
    intent: "offer",
    cents,
    isCeiling: cents === maxOffer(input.criteria),
    meetsSellerAsk: input.sellerAskCents !== null && cents === input.sellerAskCents,
  };
}

export type FollowUpDecision =
  | { kind: "none"; reason: string }
  | { kind: "nudge"; intent: "nudge"; cents: Cents }
  | { kind: "partner_bump"; intent: "partner_bump"; cents: Cents; isCeiling: boolean }
  | { kind: "ceiling_reached" };

/**
 * Whether an unanswered thread is due for a chase. Measured from our last
 * outbound message, with the count resetting whenever the seller replies.
 */
export function decideFollowUp(input: {
  criteria: OfferCriteria | null;
  lastOfferCents: Cents | null;
  sellerAskCents: Cents | null;
  hoursSinceLastOutbound: number;
  followUpsSinceReply: number;
}): FollowUpDecision {
  // We only chase a number we already put in writing. A thread that never got
  // an offer is a qualifying problem, not a follow-up one.
  if (input.lastOfferCents === null) return { kind: "none", reason: "no standing offer" };
  if (!input.criteria) return { kind: "none", reason: "no verified buyer match" };
  if (input.followUpsSinceReply >= MAX_FOLLOW_UPS) return { kind: "none", reason: "follow-ups exhausted" };

  if (input.followUpsSinceReply === 0) {
    if (input.hoursSinceLastOutbound < NUDGE_AFTER_HOURS) return { kind: "none", reason: "too soon to nudge" };
    // Same number, no new money — just making sure the offer landed.
    return { kind: "nudge", intent: "nudge", cents: input.lastOfferCents };
  }

  if (input.hoursSinceLastOutbound < PARTNER_BUMP_AFTER_HOURS) {
    return { kind: "none", reason: "too soon to raise" };
  }
  const cents = offerFor(input.criteria, input.lastOfferCents, input.sellerAskCents);
  if (cents === null) return { kind: "ceiling_reached" };
  // offerFor floors at the standing offer, so a seller who asked for less than
  // our next rung gets a re-send, not a raise. Nothing to say — leave it.
  if (cents === input.lastOfferCents) return { kind: "none", reason: "no room above the standing offer" };

  return { kind: "partner_bump", intent: "partner_bump", cents, isCeiling: cents === maxOffer(input.criteria) };
}
