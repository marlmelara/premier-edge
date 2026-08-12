import { arcgisQuery, esriPolygonToGeoJson, polygonAreaSqft, sqlQuote, type EsriFeature } from "@/lib/gis/arcgis";
import type { CountyAdapter, ParcelRecord } from "./types";

/**
 * Lee County — parcel layer maintained by the Lee County Property Appraiser,
 * synced nightly (verified live Aug 12, 2026). STRAP is the parcel id
 * (e.g. "354426L3121060010"); Property_URL deep-links to leepa.org.
 */
const LAYER_URL =
  "https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/arcgis/rest/services/Lee_County_Parcels/FeatureServer/0";

const OUT_FIELDS = [
  "STRAP",
  "FOLIOID",
  "O_NAME",
  "SITEADDR",
  "SITECITY",
  "GISACRES",
  "STATEDAREA_SQFT",
  "JUST",
  "ASSESSED",
  "LEGAL",
  "Property_URL",
];

export function mapLeeFeature(feature: EsriFeature): ParcelRecord {
  const a = feature.attributes;
  const geometry = esriPolygonToGeoJson(feature.geometry);
  const statedSqft = typeof a.STATEDAREA_SQFT === "number" && a.STATEDAREA_SQFT > 0 ? a.STATEDAREA_SQFT : undefined;
  const computedSqft = polygonAreaSqft(geometry);
  const address = [a.SITEADDR, a.SITECITY]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .join(", ");
  return {
    county: "lee",
    parcelId: String(a.STRAP ?? "").trim(),
    address: address || undefined,
    ownerNameRaw: typeof a.O_NAME === "string" ? a.O_NAME.trim() || undefined : undefined,
    acreage: typeof a.GISACRES === "number" ? a.GISACRES : undefined,
    sqft: statedSqft ?? (computedSqft !== undefined ? Math.round(computedSqft) : undefined),
    geometry,
    legalDescription: typeof a.LEGAL === "string" ? a.LEGAL.trim() || undefined : undefined,
    assessedValue: typeof a.JUST === "number" ? a.JUST : undefined,
    appraiserUrl:
      typeof a.Property_URL === "string" && a.Property_URL
        ? a.Property_URL
        : typeof a.FOLIOID === "number"
          ? `https://www.leepa.org/Display/Displayparcel.aspx?folioID=${a.FOLIOID}`
          : undefined,
    sourceAdapter: "lee/leepa-parcels",
    rawPayload: feature.attributes,
  };
}

export const leeAdapter: CountyAdapter = {
  key: "lee",
  countyName: "Lee",
  state: "FL",
  source: "Lee County Property Appraiser — Lee_County_Parcels (ArcGIS Online, nightly sync)",

  async getParcelById(parcelId) {
    const features = await arcgisQuery(LAYER_URL, {
      where: `STRAP = ${sqlQuote(parcelId.trim())}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      resultRecordCount: 1,
    });
    return features.length ? mapLeeFeature(features[0]) : null;
  },

  async searchByAddress(query) {
    const features = await arcgisQuery(LAYER_URL, {
      where: `UPPER(SITEADDR) LIKE ${sqlQuote(`%${query.trim().toUpperCase()}%`)}`,
      outFields: OUT_FIELDS,
      returnGeometry: true,
      resultRecordCount: 10,
    });
    return features.map(mapLeeFeature);
  },
};
