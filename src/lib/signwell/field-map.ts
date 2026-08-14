/**
 * Maps the deal facts we know onto the SignWell template's field ids.
 *
 * SignWell templates expose fields by their editor-assigned api_id. Marlon's
 * PSA template ("Real Estate Purchase And Sale Agreement - PCPB",
 * d72658dc-a8ea-48a2-92d1-ce10b1f3e910) uses the editor defaults —
 * TextField_1..14, DateField_1..3 — which carry no meaning we can infer.
 *
 * Guessing here would put a wrong price or a wrong parcel into a binding
 * contract, so the map starts empty and contract sending refuses until it's
 * filled in. Confirm what each field is in the SignWell template editor, then
 * fill the ids below.
 */

/** The facts the app can supply. Every value is code-derived, never seller-typed. */
export type ContractFacts = {
  propertyAddress: string;
  parcelId: string;
  county: string;
  legalDescription: string;
  purchasePrice: string;
  sellerName: string;
  buyerEntity: string;
  effectiveDate: string;
};

/**
 * `null` means "not yet mapped". Fill each with the template's api_id
 * (e.g. propertyAddress: "TextField_3").
 */
export const PSA_FIELD_MAP: Record<keyof ContractFacts, string | null> = {
  propertyAddress: null,
  parcelId: null,
  county: null,
  legalDescription: null,
  purchasePrice: null,
  sellerName: null,
  buyerEntity: null,
  effectiveDate: null,
};

export const ASSIGNMENT_FIELD_MAP: Record<string, string | null> = {};

export type FieldMapCheck = { ready: true } | { ready: false; missing: string[] };

export function checkFieldMap(map: Record<string, string | null>): FieldMapCheck {
  const missing = Object.entries(map)
    .filter(([, id]) => !id)
    .map(([key]) => key);
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

/** Turn known facts into SignWell's `template_fields` payload, skipping unmapped keys. */
export function toTemplateFields(
  map: Record<string, string | null>,
  facts: Partial<Record<string, string>>,
): { api_id: string; value: string }[] {
  return Object.entries(map)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, apiId]) => ({ api_id: apiId, value: facts[key] ?? "" }));
}
