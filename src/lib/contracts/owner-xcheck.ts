/**
 * Owner cross-check (design doc §9). Compares the person we've been texting to
 * the owner of record on the county appraiser's parcel row, before any contract
 * goes out. Pure functions — no I/O.
 *
 * A mismatch never blocks silently: it escalates to Marlon. Multi-owner parcels
 * are always human-approved, never templated (§6).
 */

const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V"]);
const ENTITY_MARKERS = ["LLC", "L L C", "INC", "CORP", "TRUST", "TRUSTEE", "ESTATE", "LP", "LLP", "FOUNDATION", "CHURCH", "COMPANY", "CO"];

export function normalizeName(raw: string): string[] {
  return raw
    .toUpperCase()
    .replace(/[.,'"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 1 && !SUFFIXES.has(t));
}

/** County records list entities as the owner; those can't sign like a person can. */
export function isEntityOwner(ownerNameRaw: string): boolean {
  const upper = ` ${ownerNameRaw.toUpperCase().replace(/[.,]/g, "")} `;
  return ENTITY_MARKERS.some((marker) => upper.includes(` ${marker} `));
}

/** "SMITH JOHN & MARY", "SMITH JOHN AND MARY", "JONES A & B SCHUTH" → more than one signer. */
export function hasMultipleOwners(ownerNameRaw: string): boolean {
  return /\s(&|AND)\s/i.test(ownerNameRaw);
}

export type XCheckVerdict = "match" | "partial" | "mismatch" | "needs_review";

export type XCheckResult = {
  score: number;
  verdict: XCheckVerdict;
  /** True when a human must approve before any contract is generated (§6). */
  requiresHumanApproval: boolean;
  reason: string;
};

/**
 * County owner strings are last-name-first and unpunctuated
 * ("CASTILLO AGUSTIN PONCE"), so compare as unordered token sets rather than
 * trying to parse a name order that isn't consistent.
 */
export function crossCheckOwner(contactName: string | null | undefined, ownerNameRaw: string | null | undefined): XCheckResult {
  if (!ownerNameRaw?.trim()) {
    return { score: 0, verdict: "needs_review", requiresHumanApproval: true, reason: "no owner of record on the parcel" };
  }
  if (!contactName?.trim()) {
    return { score: 0, verdict: "needs_review", requiresHumanApproval: true, reason: "no name on the contact to compare" };
  }

  if (isEntityOwner(ownerNameRaw)) {
    return {
      score: 0,
      verdict: "needs_review",
      requiresHumanApproval: true,
      reason: `owner of record is an entity (${ownerNameRaw.trim()}) — confirm signing authority`,
    };
  }

  const contactTokens = normalizeName(contactName);
  const ownerTokens = new Set(normalizeName(ownerNameRaw));
  if (contactTokens.length === 0 || ownerTokens.size === 0) {
    return { score: 0, verdict: "needs_review", requiresHumanApproval: true, reason: "names too short to compare" };
  }

  const matched = contactTokens.filter((t) => ownerTokens.has(t));
  const score = matched.length / contactTokens.length;
  const multi = hasMultipleOwners(ownerNameRaw);

  if (score >= 1) {
    return multi
      ? {
          score,
          verdict: "match",
          requiresHumanApproval: true,
          reason: `name matches, but the parcel has multiple owners (${ownerNameRaw.trim()}) — all must sign`,
        }
      : { score, verdict: "match", requiresHumanApproval: false, reason: "every name part matches the owner of record" };
  }

  if (score >= 0.5) {
    return {
      score,
      verdict: "partial",
      requiresHumanApproval: true,
      reason: `partial match (${matched.join(" ")}) against owner of record ${ownerNameRaw.trim()}`,
    };
  }

  return {
    score,
    verdict: "mismatch",
    requiresHumanApproval: true,
    reason: `contact "${contactName.trim()}" does not match owner of record "${ownerNameRaw.trim()}"`,
  };
}
