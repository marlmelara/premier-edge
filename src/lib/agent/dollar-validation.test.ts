import { describe, expect, it } from "vitest";
import { extractDollarAmounts, validateDraftDollars } from "./dollar-validation";

const cents = (dollars: number) => dollars * 100;

describe("extractDollarAmounts", () => {
  it("finds dollar-prefixed amounts in several formats", () => {
    expect(extractDollarAmounts("We can offer $18,700 for the lot")).toEqual([cents(18_700)]);
    expect(extractDollarAmounts("$18700")).toEqual([cents(18_700)]);
    expect(extractDollarAmounts("$ 18,700.00")).toEqual([cents(18_700)]);
  });

  it("finds amounts written in words and shorthand", () => {
    expect(extractDollarAmounts("I can do 18,700 dollars")).toEqual([cents(18_700)]);
    expect(extractDollarAmounts("how about 24k")).toEqual([cents(24_000)]);
  });

  it("finds bare numbers a seller would read as a price", () => {
    expect(extractDollarAmounts("I can do 18,700")).toEqual([cents(18_700)]);
    expect(extractDollarAmounts("would you take 24000")).toEqual([cents(24_000)]);
  });

  it("ignores years and small non-money numbers", () => {
    expect(extractDollarAmounts("We can close in 2026, about 30 days out")).toEqual([]);
    expect(extractDollarAmounts("Parcel 12 of 40")).toEqual([]);
  });

  it("returns every distinct amount when a draft names more than one", () => {
    const found = extractDollarAmounts("I offered $18,700 but could stretch to $21,000");
    expect(found).toEqual([cents(18_700), cents(21_000)]);
  });
});

describe("validateDraftDollars", () => {
  it("passes a draft with no numbers at all", () => {
    expect(validateDraftDollars("Are you open to selling the lot?", []).ok).toBe(true);
  });

  it("passes when every amount is code-supplied", () => {
    const result = validateDraftDollars("We can pay $18,700 cash, closing costs on us.", [cents(18_700)]);
    expect(result.ok).toBe(true);
  });

  it("rejects an invented number — the whole point of the guardrail", () => {
    const result = validateDraftDollars("We can pay $19,500 cash.", [cents(18_700)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.disallowed).toEqual([cents(19_500)]);
  });

  it("rejects a draft that quotes a number when none was authorized", () => {
    const result = validateDraftDollars("Most lots like yours go for about $30,000.", []);
    expect(result.ok).toBe(false);
  });

  it("rejects a ceiling-breaking second number even when the first is allowed", () => {
    const result = validateDraftDollars("We're at $18,700 now and could go to $26,000.", [cents(18_700)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.disallowed).toEqual([cents(26_000)]);
  });
});
