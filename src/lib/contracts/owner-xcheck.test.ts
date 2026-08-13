import { describe, expect, it } from "vitest";
import { crossCheckOwner, hasMultipleOwners, isEntityOwner, normalizeName } from "./owner-xcheck";

describe("normalizeName", () => {
  it("uppercases, strips punctuation, and drops generational suffixes", () => {
    expect(normalizeName("John A. Smith Jr.")).toEqual(["JOHN", "SMITH"]);
    expect(normalizeName("MEHNEY PATRICIA L & CHARLES E JR")).toEqual(["MEHNEY", "PATRICIA", "CHARLES"]);
  });
});

describe("isEntityOwner", () => {
  it("flags companies and trusts", () => {
    expect(isEntityOwner("SBM Associates LLC")).toBe(true);
    expect(isEntityOwner("PORTOFINO ISLES CDD")).toBe(false); // not a known marker — falls through to name comparison
    expect(isEntityOwner("SMITH FAMILY TRUST")).toBe(true);
    expect(isEntityOwner("CASTILLO AGUSTIN PONCE")).toBe(false);
  });
});

describe("hasMultipleOwners", () => {
  it("detects joint ownership", () => {
    expect(hasMultipleOwners("MEHNEY PATRICIA L & CHARLES E JR")).toBe(true);
    expect(hasMultipleOwners("CHAPMAN MARY AND BRENT SCHUTH")).toBe(true);
    expect(hasMultipleOwners("CASTILLO AGUSTIN PONCE")).toBe(false);
  });
});

describe("crossCheckOwner", () => {
  it("matches a real county record against the same person named naturally", () => {
    // Live Lee County record: owner is stored last-name-first, unpunctuated.
    const result = crossCheckOwner("Agustin Castillo", "CASTILLO AGUSTIN PONCE");
    expect(result.verdict).toBe("match");
    expect(result.requiresHumanApproval).toBe(false);
  });

  it("requires approval when the parcel has co-owners, even on a name match", () => {
    const result = crossCheckOwner("Patricia Mehney", "MEHNEY PATRICIA L & CHARLES E JR");
    expect(result.verdict).toBe("match");
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.reason).toContain("multiple owners");
  });

  it("flags an entity owner instead of guessing at signing authority", () => {
    const result = crossCheckOwner("William Murphy", "SBM Associates LLC");
    expect(result.verdict).toBe("needs_review");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("calls out a partial match rather than passing or failing it outright", () => {
    const result = crossCheckOwner("John Smith", "SMITH ROBERT A");
    expect(result.verdict).toBe("partial");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("rejects an unrelated name", () => {
    const result = crossCheckOwner("Maria Gonzalez", "CASTILLO AGUSTIN PONCE");
    expect(result.verdict).toBe("mismatch");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("needs review when either side is missing", () => {
    expect(crossCheckOwner(null, "CASTILLO AGUSTIN PONCE").verdict).toBe("needs_review");
    expect(crossCheckOwner("Agustin Castillo", null).verdict).toBe("needs_review");
    expect(crossCheckOwner("Agustin Castillo", "   ").verdict).toBe("needs_review");
  });
});
