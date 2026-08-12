import { arcgisQuery, type GeoJsonPolygon } from "@/lib/gis/arcgis";

/**
 * USFWS National Wetlands Inventory via Esri Living Atlas (the USFWS-hosted
 * REST endpoints don't allow public feature queries; the Living Atlas layer
 * mirrors NWI and was verified live Aug 12, 2026 — Everglades point returns
 * PFO2/EM5C, dry Fort Myers point returns none).
 */
const NWI_LAYER_URL = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Wetlands/FeatureServer/0";

export type WetlandHit = { attribute: string; wetlandType?: string };

export async function queryWetlands(parcel: GeoJsonPolygon): Promise<WetlandHit[]> {
  const features = await arcgisQuery(NWI_LAYER_URL, {
    geometry: { rings: parcel.coordinates },
    geometryType: "esriGeometryPolygon",
    outFields: ["ATTRIBUTE", "WETLAND_TYPE"],
    returnGeometry: false,
  });
  return features.map((f) => ({
    attribute: String(f.attributes.ATTRIBUTE ?? "").trim(),
    wetlandType:
      typeof f.attributes.WETLAND_TYPE === "string" ? f.attributes.WETLAND_TYPE.trim() || undefined : undefined,
  }));
}

/** NWI mapper link pre-centered on the parcel for the context card quick links. */
export function nwiMapperUrl(lng: number, lat: number): string {
  return `https://fwsprimary.wim.usgs.gov/wetlands/apps/wetlands-mapper/?lat=${lat}&lng=${lng}&zoom=16`;
}
