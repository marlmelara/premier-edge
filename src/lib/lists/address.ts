import type { ParcelRecord } from "@/adapters/types";

/**
 * Address normalization for matching a list row to a county parcel.
 *
 * The bar here is deliberately high: attaching the wrong parcel means running
 * flood, wetlands, and a purchase price against land the seller doesn't own,
 * and every downstream check would pass on the wrong lot. So this only ever
 * reports an exact match after normalization — anything ambiguous goes to the
 * manual queue rather than being guessed at.
 *
 * Pure functions, no I/O.
 */

const DIRECTIONALS: Record<string, string> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
};

/** USPS Pub. 28 suffixes, trimmed to what shows up on Florida land lists. */
const SUFFIXES: Record<string, string> = {
  AVENUE: "AVE",
  AVEN: "AVE",
  AVN: "AVE",
  AV: "AVE",
  STREET: "ST",
  STR: "ST",
  STRT: "ST",
  ROAD: "RD",
  DRIVE: "DR",
  DRV: "DR",
  COURT: "CT",
  CRT: "CT",
  LANE: "LN",
  BOULEVARD: "BLVD",
  BOUL: "BLVD",
  BLV: "BLVD",
  CIRCLE: "CIR",
  CIRC: "CIR",
  CRCL: "CIR",
  PLACE: "PL",
  TERRACE: "TER",
  TERR: "TER",
  PARKWAY: "PKWY",
  PKY: "PKWY",
  HIGHWAY: "HWY",
  HIWAY: "HWY",
  TRAIL: "TRL",
  POINT: "PT",
  PLAZA: "PLZ",
  SQUARE: "SQ",
  CROSSING: "XING",
  MANOR: "MNR",
  HOLLOW: "HOLW",
  EXTENSION: "EXT",
};

/**
 * Uppercase, depunctuated, with directionals and street suffixes reduced to
 * their USPS short forms so "1234 Northwest 5th Avenue" and "1234 NW 5TH AVE"
 * compare equal.
 */
export function normalizeAddress(raw: string): string {
  const words = raw
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^A-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.map((w) => DIRECTIONALS[w] ?? SUFFIXES[w] ?? w).join(" ");
}

export type AddressMatch =
  | { matched: true; parcel: ParcelRecord }
  | { matched: false; reason: "no_candidates" | "no_exact_match" | "ambiguous"; candidates: number };

/**
 * The street line alone — everything before the first comma.
 *
 * Counties are inconsistent about what else they append. Lee returns
 * "1841 NE 2ND ST, CAPE CORAL" while a list carries "1841 Ne 2nd St", so
 * comparing whole strings fails on a lot that is plainly the same one. The
 * house number and street are what identify the parcel; the city is a suffix,
 * and it is checked separately when we know it.
 */
export function streetLine(address: string): string {
  return normalizeAddress(address.split(",")[0]);
}

/**
 * Pick the one parcel whose address is the same address, or admit we can't
 * tell. Never returns a "close enough" result — a near-miss on a land parcel
 * is a different lot, not a typo.
 */
export function pickConfidentMatch(
  query: string,
  candidates: ParcelRecord[],
  /** The city the lot is in, when we know it. Only ever narrows, never widens. */
  expectedCity?: string | null,
): AddressMatch {
  if (candidates.length === 0) return { matched: false, reason: "no_candidates", candidates: 0 };

  // Street line to street line. Still exact on house number and street — the
  // parts that identify the lot — just tolerant of the city a county appends.
  const target = streetLine(query);
  let exact = candidates.filter((c) => c.address && streetLine(c.address) === target);

  if (exact.length === 0) return { matched: false, reason: "no_exact_match", candidates: candidates.length };

  // Two cities in one county can share a street address. When we know which
  // city, that decides it; when we don't, ambiguity stands and a human looks.
  if (exact.length > 1 && expectedCity) {
    const city = normalizeAddress(expectedCity);
    const inCity = exact.filter((c) => c.address && normalizeAddress(c.address).includes(city));
    if (inCity.length === 1) return { matched: true, parcel: inCity[0] };
    if (inCity.length > 0) exact = inCity;
  }

  if (exact.length === 1) return { matched: true, parcel: exact[0] };

  // Several parcels share one situs address — common where a lot was split.
  // Picking one at random would be a coin flip on which land we negotiate for.
  return { matched: false, reason: "ambiguous", candidates: exact.length };
}

/**
 * The string we hand the county's address search. Counties index the street
 * line only, so city/state/zip are dropped — and the house number plus street
 * name is enough to narrow to a handful of candidates for exact matching.
 */
export function searchTermFor(row: { propertyAddress?: string }): string | null {
  if (!row.propertyAddress) return null;
  const street = row.propertyAddress.split(",")[0];
  const normalized = normalizeAddress(street);
  return normalized.length >= 4 ? normalized : null;
}
