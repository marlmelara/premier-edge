import { arcgisQuery, esriPolygonToGeoJson, polygonAreaSqft, sqlQuote, type EsriFeature } from "@/lib/gis/arcgis";
import type { CountyAdapter, ParcelRecord } from "./types";

/**
 * St. Lucie County — the Property Appraiser's own public parcel layer
 * (verified live Aug 12, 2026). ParcelID format: "3420-525-0196-000-1".
 */
const LAYER_URL = "https://map.paslc.gov/arcgis/rest/services/PROD/SLCPA_PublicParcels/MapServer/0";

const OUT_FIELDS = [
  "ParcelID",
  "SiteAddress",
  "Owners",
  "Acres",
  "TotalArea",
  "JustMarketValue",
  "LegalDescription",
  "PrimaryLandUse",
];

export function mapStLucieFeature(feature: EsriFeature): ParcelRecord {
  const a = feature.attributes;
  const geometry = esriPolygonToGeoJson(feature.geometry);
  const statedSqft = typeof a.TotalArea === "number" && a.TotalArea > 0 ? a.TotalArea : undefined;
  const computedSqft = polygonAreaSqft(geometry);
  return {
    county: "st_lucie",
    parcelId: String(a.ParcelID ?? "").trim(),
    address: typeof a.SiteAddress === "string" ? a.SiteAddress.trim() || undefined : undefined,
    ownerNameRaw: typeof a.Owners === "string" ? a.Owners.trim() || undefined : undefined,
    acreage: typeof a.Acres === "number" ? a.Acres : undefined,
    sqft: statedSqft ?? (computedSqft !== undefined ? Math.round(computedSqft) : undefined),
    geometry,
    legalDescription: typeof a.LegalDescription === "string" ? a.LegalDescription.trim() || undefined : undefined,
    assessedValue: typeof a.JustMarketValue === "number" ? a.JustMarketValue : undefined,
    // PASLC's record search app; no stable per-parcel deep link is published.
    appraiserUrl: "https://apps.paslc.gov/search-real-estate",
    sourceAdapter: "st-lucie/paslc-public-parcels",
    rawPayload: feature.attributes,
  };
}

export const stLucieAdapter: CountyAdapter = {
  key: "st_lucie",
  countyName: "St. Lucie",
  state: "FL",
  source: "St. Lucie County Property Appraiser — PROD/SLCPA_PublicParcels (map.paslc.gov)",

  async getParcelById(parcelId) {
    const features = await arcgisQuery(LAYER_URL, {
      where: `ParcelID = ${sqlQuote(parcelId.trim())}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      resultRecordCount: 1,
    });
    return features.length ? mapStLucieFeature(features[0]) : null;
  },

  async searchByAddress(query) {
    const features = await arcgisQuery(LAYER_URL, {
      where: `UPPER(SiteAddress) LIKE ${sqlQuote(`%${query.trim().toUpperCase()}%`)}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      resultRecordCount: 10,
    });
    return features.map(mapStLucieFeature);
  },
};
