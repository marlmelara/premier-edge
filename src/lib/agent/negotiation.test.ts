import { describe, expect, it } from "vitest";
import type { OfferCriteria } from "@/lib/eligibility/offer-math";
import { decideFollowUp, decideOffer, MAX_PROBES } from "./negotiation";

/**
 * These cover *sequencing* — which move the policy picks and when. The dollar
 * values themselves are offer-math's job and its tests are Marlon-written
 * (working agreement §13), so amounts appear here only as the observable
 * consequence of a move, never as the thing under test.
 */

const cents = (dollars: number) => dollars * 100;

// Marlon's worked example: builder pays 135k, we keep at least 5k.
// max 130,000 · anchor .78 → 101,400 · ladder 101,400 → 117,000 → 130,000
const criteria: OfferCriteria = {
  builderBuyPrice: cents(135_000),
  minAssignmentFee: cents(5_000),
  anchorPct: 0.78,
};

const ANCHOR = cents(101_400);
const SECOND_RUNG = cents(117_000);
const CEILING = cents(130_000);

const base = {
  klass: "asking_price" as const,
  criteria,
  lastOfferCents: null,
  sellerAskCents: null,
  probesSoFar: 0,
};

describe("decideOffer — ask before you tell", () => {
  it("asks for the seller's number instead of opening with ours", () => {
    const move = decideOffer(base);
    expect(move.kind).toBe("no_price");
    if (move.kind === "no_price") expect(move.intent).toBe("probe");
  });

  it("probes on a plain expression of interest too", () => {
    const move = decideOffer({ ...base, klass: "interested" });
    if (move.kind === "no_price") expect(move.intent).toBe("probe");
    else expect.fail("should have probed");
  });

  it("gives our number once the seller won't give theirs", () => {
    const move = decideOffer({ ...base, probesSoFar: MAX_PROBES });
    expect(move.kind).toBe("offer");
    if (move.kind === "offer") expect(move.cents).toBe(ANCHOR);
  });

  it("never probes again once a price is already on the table", () => {
    const move = decideOffer({ ...base, lastOfferCents: ANCHOR, probesSoFar: 0 });
    expect(move.kind).toBe("offer");
  });

  it("stops probing the moment the seller names a number", () => {
    const move = decideOffer({ ...base, klass: "counter_offer", sellerAskCents: cents(150_000) });
    expect(move.kind).toBe("offer");
  });
});

describe("decideOffer — the seller's number caps ours", () => {
  it("never offers more than the seller asked for", () => {
    // They want 80k. Our anchor is 101.4k. Opening at the anchor hands them
    // $21,400 they never asked for — the whole reason this cap exists.
    const move = decideOffer({ ...base, klass: "counter_offer", sellerAskCents: cents(80_000) });
    expect(move.kind).toBe("offer");
    if (move.kind === "offer") {
      expect(move.cents).toBe(cents(80_000));
      expect(move.meetsSellerAsk).toBe(true);
    }
  });

  it("anchors below an asking price that sits above our anchor", () => {
    const move = decideOffer({ ...base, klass: "counter_offer", sellerAskCents: cents(110_000) });
    if (move.kind === "offer") {
      expect(move.cents).toBe(ANCHOR);
      expect(move.meetsSellerAsk).toBe(false);
    } else expect.fail("should have offered");
  });

  it("stays on the ladder when the asking price is outrageous", () => {
    const move = decideOffer({ ...base, klass: "counter_offer", sellerAskCents: cents(500_000) });
    if (move.kind === "offer") expect(move.cents).toBe(ANCHOR);
    else expect.fail("should have offered");
  });

  it("does not retrade itself when the seller comes down below our standing offer", () => {
    const move = decideOffer({
      ...base,
      klass: "counter_offer",
      lastOfferCents: ANCHOR,
      sellerAskCents: cents(90_000),
    });
    if (move.kind === "offer") expect(move.cents).toBe(ANCHOR);
    else expect.fail("should have offered");
  });
});

describe("decideOffer — gates", () => {
  it("says nothing about money without a verified buyer match", () => {
    const move = decideOffer({ ...base, criteria: null });
    expect(move.kind).toBe("no_price");
    if (move.kind === "no_price") expect(move.intent).toBe("reply");
  });

  it("leaves classes that aren't about price alone", () => {
    const move = decideOffer({ ...base, klass: "question_about_process" });
    if (move.kind === "no_price") expect(move.intent).toBe("reply");
    else expect.fail("should not have priced");
  });

  it("reports a used-up ladder rather than inventing room", () => {
    expect(decideOffer({ ...base, klass: "counter_offer", lastOfferCents: CEILING }).kind).toBe("ceiling_reached");
  });

  it("flags the ceiling rung so it never auto-sends", () => {
    const move = decideOffer({ ...base, klass: "counter_offer", lastOfferCents: SECOND_RUNG });
    if (move.kind === "offer") {
      expect(move.cents).toBe(CEILING);
      expect(move.isCeiling).toBe(true);
    } else expect.fail("should have offered");
  });
});

describe("decideFollowUp — chasing silence", () => {
  const standing = {
    criteria,
    lastOfferCents: ANCHOR,
    sellerAskCents: null,
    hoursSinceLastOutbound: 0,
    followUpsSinceReply: 0,
  };

  it("does not chase a thread that never got a number", () => {
    expect(decideFollowUp({ ...standing, lastOfferCents: null, hoursSinceLastOutbound: 99 }).kind).toBe("none");
  });

  it("waits before the first check-in", () => {
    expect(decideFollowUp({ ...standing, hoursSinceLastOutbound: 2 }).kind).toBe("none");
  });

  it("nudges the same day without changing the number", () => {
    const move = decideFollowUp({ ...standing, hoursSinceLastOutbound: 5 });
    expect(move.kind).toBe("nudge");
    if (move.kind === "nudge") expect(move.cents).toBe(ANCHOR);
  });

  it("does not raise the day the nudge goes out", () => {
    expect(decideFollowUp({ ...standing, followUpsSinceReply: 1, hoursSinceLastOutbound: 10 }).kind).toBe("none");
  });

  it("goes back to the partners and raises after a couple of days", () => {
    const move = decideFollowUp({ ...standing, followUpsSinceReply: 1, hoursSinceLastOutbound: 50 });
    expect(move.kind).toBe("partner_bump");
    if (move.kind === "partner_bump") {
      expect(move.cents).toBe(SECOND_RUNG);
      expect(move.isCeiling).toBe(false);
    }
  });

  it("stops after the raise — a third unanswered chase is harassment", () => {
    expect(decideFollowUp({ ...standing, followUpsSinceReply: 2, hoursSinceLastOutbound: 500 }).kind).toBe("none");
  });

  it("does not raise past a seller's own asking price", () => {
    const move = decideFollowUp({
      ...standing,
      lastOfferCents: cents(80_000),
      sellerAskCents: cents(80_000),
      followUpsSinceReply: 1,
      hoursSinceLastOutbound: 50,
    });
    expect(move.kind).toBe("none");
  });
});
