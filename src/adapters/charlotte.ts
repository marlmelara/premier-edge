import { arcgisQuery, esriPolygonToGeoJson, polygonAreaSqft, sqlQuote, type EsriFeature } from "@/lib/gis/arcgis";
import type { CountyAdapter, ParcelRecord } from "./types";

/**
 * Charlotte County — county GIS "Property Ownership" layer (verified live
 * Aug 12, 2026). ACCOUNT is the parcel id (e.g. "402125204030"). String
 * fields arrive space-padded and numeric values arrive as padded strings —
 * everything gets trimmed/parsed here.
 */
const LAYER_URL =
  "https://agis.charlottecountyfl.gov/arcgis/rest/services/Essentials/CCGIS_Web_Layers2022/MapServer/17";

const OUT_FIELDS = [
  "ACCOUNT",
  "ownersname",
  "propertyaddress",
  "FullPropertyAddress",
  "landuse",
  "usecode",
  "totlandvalue",
  "assessedvalue",
  "shortlegal",
];

const trimmed = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  // County fields are fixed-width padded, so runs of spaces show up mid-string
  // ("17200      GULFSPRAY CIR") and would land in a contract that way.
  const t = v.replace(/\s+/g, " ").trim();
  return t.length ? t : undefined;
};

const paddedNumber = (v: unknown): number | undefined => {
  const t = trimmed(typeof v === "number" ? String(v) : v);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export function mapCharlotteFeature(feature: EsriFeature): ParcelRecord {
  const a = feature.attributes;
  const geometry = esriPolygonToGeoJson(feature.geometry);
  const sqft = polygonAreaSqft(geometry); // no stated area field on this layer
  const account = trimmed(typeof a.ACCOUNT === "number" ? String(a.ACCOUNT) : a.ACCOUNT) ?? "";
  return {
    county: "charlotte",
    parcelId: account,
    address: trimmed(a.FullPropertyAddress) ?? trimmed(a.propertyaddress),
    ownerNameRaw: trimmed(a.ownersname),
    acreage: sqft !== undefined ? sqft / 43560 : undefined,
    sqft: sqft !== undefined ? Math.round(sqft) : undefined,
    geometry,
    legalDescription: trimmed(a.shortlegal),
    assessedValue: paddedNumber(a.assessedvalue),
    appraiserUrl: account
      ? `https://www.ccappraiser.com/Show_parcel.asp?acct=${account}&gen=T&tax=T&bld=T&oth=T&sal=T&lnd=T&leg=T`
      : undefined,
    sourceAdapter: "charlotte/ccgis-property-ownership",
    rawPayload: feature.attributes,
  };
}

export const charlotteAdapter: CountyAdapter = {
  key: "charlotte",
  countyName: "Charlotte",
  state: "FL",
  source: "Charlotte County GIS — Essentials/CCGIS_Web_Layers2022 layer 17 (Property Ownership)",

  async getParcelById(parcelId) {
    const features = await arcgisQuery(LAYER_URL, {
      where: `ACCOUNT = ${sqlQuote(parcelId.trim())}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      resultRecordCount: 1,
    });
    return features.length ? mapCharlotteFeature(features[0]) : null;
  },

  /**
   * Charlotte splits the address: `propertyaddress` is the street name alone
   * ("GULFSPRAY CIR") and only `FullPropertyAddress` carries the house number,
   * space-padded between the two ("17200      GULFSPRAY CIR"). Searching the
   * full string against either field therefore matches nothing — the padding
   * defeats a LIKE, and the street-only field has no number to find.
   *
   * So we search the street name and return everything on it. The house number
   * is matched exactly by the caller against `address`, which the mapper has
   * already trimmed (see lib/lists/address.ts).
   */
  async searchByAddress(query) {
    const street = stripHouseNumber(query);
    const features = await arcgisQuery(LAYER_URL, {
      where: `UPPER(propertyaddress) LIKE ${sqlQuote(`%${street}%`)}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      // A Cape Coral / Port Charlotte street runs to hundreds of lots, and a
      // truncated page could omit the one parcel we're looking for.
      resultRecordCount: 500,
    });
    return features.map(mapCharlotteFeature);
  },
};

/** "17200 GULFSPRAY CIR" → "GULFSPRAY CIR". Leaves a query with no number alone. */
function stripHouseNumber(query: string): string {
  return query.trim().toUpperCase().replace(/^\d+[A-Z]?\s+/, "");
}
