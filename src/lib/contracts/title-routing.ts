/**
 * Title-company routing (design doc §9): builder preference → seller-specified
 * → Florida default. Pure resolution logic so the precedence is testable
 * without a database.
 */

export type TitleCompanyRef = {
  id: string;
  name: string;
  emails: string[];
  state: string;
  isDefaultFl: boolean;
};

export type TitleRoutingInput = {
  /** The matched builder's preferred closer, when they have one. */
  builderPreferred?: TitleCompanyRef | null;
  /** A closer the seller asked for during negotiation. */
  sellerSpecified?: TitleCompanyRef | null;
  /** Seeded default (Marlon's contact). */
  floridaDefault?: TitleCompanyRef | null;
};

export type TitleRouting =
  | { ok: true; company: TitleCompanyRef; source: "builder_preferred" | "seller_specified" | "fl_default" }
  | { ok: false; reason: string };

export function resolveTitleCompany(input: TitleRoutingInput): TitleRouting {
  const usable = (c?: TitleCompanyRef | null) => (c && c.emails.length > 0 ? c : null);

  const builder = usable(input.builderPreferred);
  if (builder) return { ok: true, company: builder, source: "builder_preferred" };

  const seller = usable(input.sellerSpecified);
  if (seller) return { ok: true, company: seller, source: "seller_specified" };

  const fallback = usable(input.floridaDefault);
  if (fallback) return { ok: true, company: fallback, source: "fl_default" };

  // Named but unusable is a different failure from nothing configured — say which.
  const named = [input.builderPreferred, input.sellerSpecified, input.floridaDefault].filter(Boolean);
  return {
    ok: false,
    reason: named.length
      ? `title company ${named[0]!.name} has no email address on file`
      : "no title company configured — seed the Florida default",
  };
}

/** The one-line title email from the reference tool (§9), with both PDFs attached. */
export function composeTitleEmail(params: {
  propertyAddress: string;
  county: string;
  sellerName: string;
  builderEntity: string;
  price: string;
  closingNote?: string;
}): { subject: string; body: string } {
  return {
    subject: `New closing — ${params.propertyAddress} (${params.county} County)`,
    body: [
      `Please open title on ${params.propertyAddress} in ${params.county} County.`,
      "",
      `Seller: ${params.sellerName}`,
      `Buyer/assignee: ${params.builderEntity}`,
      `Purchase price: ${params.price}`,
      params.closingNote ? `Notes: ${params.closingNote}` : null,
      "",
      "The signed purchase agreement and assignment are attached. Reply here with the title commitment and any items you need from us.",
      "",
      "Marlon Melara",
      "Premier Equity Co. LLC",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  };
}
