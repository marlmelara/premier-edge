import { describe, expect, it } from "vitest";
import { bestMatch, matchBuilders, verdictFromMatches, type BuilderCriteria, type ParcelFacts } from "./match-builders";

const cents = (d: number) => d * 100;

const builder = (over: Partial<BuilderCriteria> = {}): BuilderCriteria => ({
  builderId: "b1",
  builderName: "Builder One",
  minSqft: 10_000,
  allowedFloodZones: ["X"],
  wetlandsAllowed: false,
  builderBuyPrice: cents(32_000),
  minAssignmentFee: cents(8_000),
  anchorPct: 0.78,
  ...over,
});

const goodLot: ParcelFacts = {
  sqft: 11_530,
  floodZones: [{ zone: "X" }],
  wetlands: [],
  checksIncomplete: false,
};

describe("matchBuilders", () => {
  it("matches a clean lot and computes that buyer's offer room", () => {
    const [match] = matchBuilders(goodLot, [builder()]);
    expect(match.fits).toBe(true);
    expect(match.failures).toEqual([]);
    expect(match.maxOfferCents).toBe(cents(24_000)); // 32,000 buy − 8,000 fee
    expect(match.anchorCents).toBe(cents(18_700)); // 78% of max, rounded to $100
  });

  it("ranks fitting buyers by who leaves the most room", () => {
    const matches = matchBuilders(goodLot, [
      builder({ builderId: "low", builderName: "Low", builderBuyPrice: cents(28_000) }),
      builder({ builderId: "high", builderName: "High", builderBuyPrice: cents(40_000) }),
    ]);
    expect(matches.map((m) => m.builderId)).toEqual(["high", "low"]);
    expect(bestMatch(matches)?.builderId).toBe("high");
  });

  it("puts any fitting buyer ahead of a higher-paying one who does not fit", () => {
    const matches = matchBuilders(goodLot, [
      builder({ builderId: "rich_picky", builderName: "Rich", builderBuyPrice: cents(60_000), minSqft: 40_000 }),
      builder({ builderId: "modest", builderName: "Modest", builderBuyPrice: cents(30_000) }),
    ]);
    expect(matches[0].builderId).toBe("modest");
    expect(matches[0].fits).toBe(true);
    expect(matches[1].fits).toBe(false);
    expect(bestMatch(matches)?.builderId).toBe("modest");
  });

  it("names why each buyer passed on it", () => {
    const wetAeLot: ParcelFacts = {
      sqft: 5_000,
      floodZones: [{ zone: "AE" }],
      wetlands: [{ attribute: "PFO2/EM5C" }],
      checksIncomplete: false,
    };
    const [match] = matchBuilders(wetAeLot, [builder()]);
    expect(match.fits).toBe(false);
    expect(match.failures).toEqual(
      expect.arrayContaining([expect.stringContaining("flood zone AE"), "wetlands intersect", expect.stringContaining("too small")]),
    );
  });

  it("lets a buyer who tolerates wetlands take a lot another buyer rejects", () => {
    const wetLot: ParcelFacts = { sqft: 12_000, floodZones: [{ zone: "X" }], wetlands: [{ attribute: "PEM1C" }], checksIncomplete: false };
    const matches = matchBuilders(wetLot, [
      builder({ builderId: "picky", builderName: "Picky" }),
      builder({ builderId: "flexible", builderName: "Flexible", wetlandsAllowed: true }),
    ]);
    expect(bestMatch(matches)?.builderId).toBe("flexible");
    expect(matches.find((m) => m.builderId === "picky")?.fits).toBe(false);
  });

  it("respects a buyer's market list", () => {
    const matches = matchBuilders(goodLot, [builder({ markets: ["Port Charlotte"] })], "Lehigh Acres");
    expect(matches[0].fits).toBe(false);
    expect(matches[0].failures.some((f) => f.includes("markets"))).toBe(true);
  });

  it("treats a buyer with no market list as buying anywhere", () => {
    const matches = matchBuilders(goodLot, [builder({ markets: [] })], "Lehigh Acres");
    expect(matches[0].fits).toBe(true);
  });

  it("never counts an errored GIS check as a pass", () => {
    // No NFHL coverage returns an error outcome, not a pass.
    const unknown: ParcelFacts = { sqft: 12_000, floodZones: [], wetlands: [], checksIncomplete: true };
    const [match] = matchBuilders(unknown, [builder()]);
    expect(match.fits).toBe(false);
    expect(match.failures).toContain("flood check unavailable");
  });

  it("flags a buyer configured with a fee floor above their buy price", () => {
    const [match] = matchBuilders(goodLot, [builder({ builderBuyPrice: cents(5_000), minAssignmentFee: cents(8_000) })]);
    expect(match.fits).toBe(false);
    expect(match.failures.some((f) => f.includes("below their fee floor"))).toBe(true);
  });
});

describe("verdictFromMatches", () => {
  it("passes when any buyer wants it", () => {
    const matches = matchBuilders(goodLot, [builder({ minSqft: 40_000 }), builder({ builderId: "b2" })]);
    expect(verdictFromMatches(matches)).toBe("pass");
  });

  it("fails when every buyer rejected it on the facts", () => {
    const small: ParcelFacts = { sqft: 2_000, floodZones: [{ zone: "X" }], wetlands: [], checksIncomplete: false };
    expect(verdictFromMatches(matchBuilders(small, [builder()]))).toBe("fail");
  });

  it("stays pending when a check errored, so it can be retried", () => {
    const unknown: ParcelFacts = { sqft: 12_000, floodZones: [], wetlands: [], checksIncomplete: true };
    expect(verdictFromMatches(matchBuilders(unknown, [builder()]))).toBe("pending");
  });

  it("is pending when the campaign has no buyers attached at all", () => {
    expect(verdictFromMatches([])).toBe("pending");
  });
});
