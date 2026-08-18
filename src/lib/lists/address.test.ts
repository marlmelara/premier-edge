import { describe, expect, it } from "vitest";
import type { ParcelRecord } from "@/adapters/types";
import { normalizeAddress, pickConfidentMatch, searchTermFor } from "./address";

const parcel = (parcelId: string, address?: string): ParcelRecord => ({
  county: "lee",
  parcelId,
  address,
  sourceAdapter: "test",
  rawPayload: {},
});

describe("normalizeAddress", () => {
  it("collapses the ways one address gets written", () => {
    const canonical = normalizeAddress("1234 NW 5TH AVE");
    expect(normalizeAddress("1234 Northwest 5th Avenue")).toBe(canonical);
    expect(normalizeAddress("1234  nw  5th  ave.")).toBe(canonical);
    expect(normalizeAddress("1234 NW 5th Ave,")).toBe(canonical);
  });

  it("normalizes the suffixes Florida land lists use", () => {
    expect(normalizeAddress("17200 Gulfspray Circle")).toBe("17200 GULFSPRAY CIR");
    expect(normalizeAddress("55 Palm Boulevard")).toBe("55 PALM BLVD");
    expect(normalizeAddress("8 Sunset Terrace")).toBe("8 SUNSET TER");
  });

  it("keeps the house number distinct", () => {
    expect(normalizeAddress("1234 MAIN ST")).not.toBe(normalizeAddress("1235 MAIN ST"));
  });
});

describe("pickConfidentMatch", () => {
  it("matches across formatting differences", () => {
    const result = pickConfidentMatch("1234 Northwest 5th Avenue", [parcel("A", "1234 NW 5TH AVE")]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.parcel.parcelId).toBe("A");
  });

  it("picks the right one out of a street full of candidates", () => {
    const result = pickConfidentMatch("1234 NW 5th Ave", [
      parcel("A", "1230 NW 5TH AVE"),
      parcel("B", "1234 NW 5TH AVE"),
      parcel("C", "1238 NW 5TH AVE"),
    ]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.parcel.parcelId).toBe("B");
  });

  it("refuses a near miss rather than guessing the neighbour's lot", () => {
    const result = pickConfidentMatch("1234 NW 5th Ave", [parcel("A", "1236 NW 5TH AVE")]);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe("no_exact_match");
  });

  it("refuses when two parcels share the address — a split lot is a coin flip", () => {
    const result = pickConfidentMatch("1234 NW 5th Ave", [
      parcel("A", "1234 NW 5TH AVE"),
      parcel("B", "1234 NW 5th Ave"),
    ]);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe("ambiguous");
  });

  it("reports an empty county result distinctly", () => {
    const result = pickConfidentMatch("1234 NW 5th Ave", []);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe("no_candidates");
  });

  it("ignores candidates the county returned with no address", () => {
    const result = pickConfidentMatch("1234 NW 5th Ave", [parcel("A", undefined), parcel("B", "1234 NW 5TH AVE")]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.parcel.parcelId).toBe("B");
  });
});

describe("searchTermFor", () => {
  it("searches on the street line only — counties don't index city or zip", () => {
    expect(searchTermFor({ propertyAddress: "1234 SW 5th Ave, Cape Coral, FL 33914" })).toBe("1234 SW 5TH AVE");
  });

  it("declines a row with nothing to search on", () => {
    expect(searchTermFor({})).toBeNull();
    expect(searchTermFor({ propertyAddress: "n/a" })).toBeNull();
  });
});

describe("pickConfidentMatch — county address suffixes", () => {
  it("matches when the county appends the city and the list doesn't", () => {
    // The bug that stopped every Lee auto-resolve: Sendivo carries
    // "1841 Ne 2nd St" while Lee returns "1841 NE 2ND ST, CAPE CORAL".
    // Whole-string equality fails on a lot that is plainly the same one.
    const result = pickConfidentMatch("1841 Ne 2nd St", [parcel("A", "1841 NE 2ND ST, CAPE CORAL")]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.parcel.parcelId).toBe("A");
  });

  it("still refuses a different house number on the same street", () => {
    // Tolerating the city suffix must not tolerate the part that identifies
    // the lot.
    expect(pickConfidentMatch("1841 Ne 2nd St", [parcel("A", "1843 NE 2ND ST, CAPE CORAL")]).matched).toBe(false);
  });

  it("uses the city to break a tie between two towns in one county", () => {
    const result = pickConfidentMatch(
      "100 Main St",
      [parcel("A", "100 MAIN ST, CAPE CORAL"), parcel("B", "100 MAIN ST, FORT MYERS")],
      "Fort Myers",
    );
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.parcel.parcelId).toBe("B");
  });

  it("stays ambiguous when two towns tie and we don't know the city", () => {
    const result = pickConfidentMatch("100 Main St", [
      parcel("A", "100 MAIN ST, CAPE CORAL"),
      parcel("B", "100 MAIN ST, FORT MYERS"),
    ]);
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.reason).toBe("ambiguous");
  });
});
