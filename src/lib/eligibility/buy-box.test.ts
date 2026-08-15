import { describe, expect, it } from "vitest";
import { boxesForPlace, priceForUtilities, scopeScore, type BuyBox } from "./buy-box";

const cents = (d: number) => d * 100;

const base: BuyBox = {
  id: "b1",
  builderId: "builder-1",
  builderName: "Coastal Homes",
  name: "Cape Coral standard",
  county: "lee",
  cities: [],
  zips: [],
  minSqft: 10_000,
  allowedFloodZones: ["X"],
  wetlandsAllowed: false,
  baseBuyPriceCents: cents(135_000),
  minAssignmentFeeCents: cents(5_000),
  anchorPct: 0.78,
  utilityRules: [],
};

describe("scopeScore — which market a buy box covers", () => {
  it("ignores a different county entirely", () => {
    expect(scopeScore(base, { county: "charlotte" })).toBeNull();
  });

  it("prefers the most specific box that applies", () => {
    const countyWide = { ...base, id: "county" };
    const cityLevel = { ...base, id: "city", cities: ["Cape Coral"] };
    const zipLevel = { ...base, id: "zip", zips: ["33993"] };
    const place = { county: "lee", city: "Cape Coral", zip: "33993" };

    expect(scopeScore(countyWide, place)).toBe(1);
    expect(scopeScore(cityLevel, place)).toBe(2);
    expect(scopeScore(zipLevel, place)).toBe(3);
  });

  it("matches city and zip case-insensitively", () => {
    const box = { ...base, cities: ["CAPE CORAL"] };
    expect(scopeScore(box, { county: "lee", city: "cape coral" })).toBe(2);
  });

  it("declines a zip-scoped box when the lot has no zip on file", () => {
    // Assuming it fits would price the lot against a market we can't confirm.
    expect(scopeScore({ ...base, zips: ["33993"] }, { county: "lee", city: "Cape Coral" })).toBeNull();
  });
});

describe("boxesForPlace — one box per builder", () => {
  it("keeps only the most specific box for each builder", () => {
    const boxes: BuyBox[] = [
      { ...base, id: "county" },
      { ...base, id: "city", cities: ["Cape Coral"], baseBuyPriceCents: cents(150_000) },
    ];
    const chosen = boxesForPlace(boxes, { county: "lee", city: "Cape Coral" });
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe("city");
  });

  it("keeps one box per builder when several buyers cover the same market", () => {
    const boxes: BuyBox[] = [
      { ...base, id: "a", builderId: "builder-1" },
      { ...base, id: "b", builderId: "builder-2" },
    ];
    expect(boxesForPlace(boxes, { county: "lee" })).toHaveLength(2);
  });
});

describe("priceForUtilities", () => {
  it("pays the base price when the buyer doesn't price on utilities", () => {
    const result = priceForUtilities(base, {});
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.buyPriceCents).toBe(cents(135_000));
  });

  const tiered: BuyBox = {
    ...base,
    utilityRules: [
      { water: "city", sewer: "city", buyPriceCents: cents(135_000), accepted: true },
      { water: "city", sewer: "septic", buyPriceCents: cents(120_000), accepted: true },
      { water: "well", sewer: "septic", buyPriceCents: cents(95_000), accepted: true },
      { water: "well", sewer: "city", accepted: false },
    ],
  };

  it("prices each combination from the one entry", () => {
    const cases: [Parameters<typeof priceForUtilities>[1], number][] = [
      [{ water: "city", sewer: "city" }, cents(135_000)],
      [{ water: "city", sewer: "septic" }, cents(120_000)],
      [{ water: "well", sewer: "septic" }, cents(95_000)],
    ];
    for (const [utilities, expected] of cases) {
      const result = priceForUtilities(tiered, utilities);
      expect(result.accepted).toBe(true);
      if (result.accepted) expect(result.buyPriceCents).toBe(expected);
    }
  });

  it("honours a combination the buyer refuses outright", () => {
    const result = priceForUtilities(tiered, { water: "well", sewer: "city" });
    expect(result.accepted).toBe(false);
  });

  it("refuses to price a lot whose utilities we haven't determined", () => {
    // Guessing "probably city water" is how you promise a number you can't pay.
    const result = priceForUtilities(tiered, { water: "city" });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/unknown/);
  });

  it("declines a combination nobody wrote a rule for", () => {
    // A non-empty matrix is an allowlist: silently falling back to base price
    // would defeat the reason the matrix exists.
    const partial: BuyBox = {
      ...base,
      utilityRules: [{ water: "city", sewer: "city", buyPriceCents: cents(135_000), accepted: true }],
    };
    expect(priceForUtilities(partial, { water: "well", sewer: "septic" }).accepted).toBe(false);
  });

  it("lets a specific rule override a catch-all", () => {
    const withCatchAll: BuyBox = {
      ...base,
      utilityRules: [
        { water: "any", sewer: "any", buyPriceCents: cents(100_000), accepted: true },
        { water: "city", sewer: "city", buyPriceCents: cents(140_000), accepted: true },
      ],
    };
    const specific = priceForUtilities(withCatchAll, { water: "city", sewer: "city" });
    if (specific.accepted) expect(specific.buyPriceCents).toBe(cents(140_000));
    else expect.fail("should have priced");

    const fallback = priceForUtilities(withCatchAll, { water: "well", sewer: "septic" });
    if (fallback.accepted) expect(fallback.buyPriceCents).toBe(cents(100_000));
    else expect.fail("catch-all should have applied");
  });

  it("falls back to the box's base price when a rule names no price", () => {
    const noPrice: BuyBox = {
      ...base,
      utilityRules: [{ water: "any", sewer: "any", accepted: true }],
    };
    const result = priceForUtilities(noPrice, { water: "well", sewer: "septic" });
    if (result.accepted) expect(result.buyPriceCents).toBe(cents(135_000));
    else expect.fail("should have priced");
  });
});
