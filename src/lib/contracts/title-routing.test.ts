import { describe, expect, it } from "vitest";
import { composeTitleEmail, resolveTitleCompany, type TitleCompanyRef } from "./title-routing";

const company = (over: Partial<TitleCompanyRef> = {}): TitleCompanyRef => ({
  id: "t1",
  name: "Test Title",
  emails: ["closings@example.com"],
  state: "FL",
  isDefaultFl: false,
  ...over,
});

describe("resolveTitleCompany", () => {
  it("prefers the builder's title company over everything else", () => {
    const result = resolveTitleCompany({
      builderPreferred: company({ id: "builder", name: "Builder Title" }),
      sellerSpecified: company({ id: "seller" }),
      floridaDefault: company({ id: "default", isDefaultFl: true }),
    });
    expect(result).toMatchObject({ ok: true, source: "builder_preferred" });
    if (result.ok) expect(result.company.id).toBe("builder");
  });

  it("falls to the seller's choice when the builder has no preference", () => {
    const result = resolveTitleCompany({
      sellerSpecified: company({ id: "seller" }),
      floridaDefault: company({ id: "default", isDefaultFl: true }),
    });
    expect(result).toMatchObject({ ok: true, source: "seller_specified" });
  });

  it("falls to the Florida default last", () => {
    const result = resolveTitleCompany({ floridaDefault: company({ id: "default", isDefaultFl: true }) });
    expect(result).toMatchObject({ ok: true, source: "fl_default" });
  });

  it("skips a company with no email rather than routing into a void", () => {
    const result = resolveTitleCompany({
      builderPreferred: company({ id: "builder", emails: [] }),
      floridaDefault: company({ id: "default", isDefaultFl: true }),
    });
    expect(result).toMatchObject({ ok: true, source: "fl_default" });
  });

  it("fails with a specific reason when nothing is routable", () => {
    expect(resolveTitleCompany({})).toMatchObject({ ok: false });
    const emailless = resolveTitleCompany({ floridaDefault: company({ emails: [] }) });
    expect(emailless.ok).toBe(false);
    if (!emailless.ok) expect(emailless.reason).toContain("no email address");
  });
});

describe("composeTitleEmail", () => {
  it("writes the one-line title email with the deal's facts", () => {
    const email = composeTitleEmail({
      propertyAddress: "3219 15TH ST SW, LEHIGH ACRES",
      county: "Lee",
      sellerName: "Agustin Castillo",
      builderEntity: "Placeholder Builder LLC",
      price: "$24,000",
    });
    expect(email.subject).toBe("New closing — 3219 15TH ST SW, LEHIGH ACRES (Lee County)");
    expect(email.body).toContain("Seller: Agustin Castillo");
    expect(email.body).toContain("Purchase price: $24,000");
    expect(email.body).toContain("attached");
    expect(email.body).not.toContain("Notes:");
  });
});
