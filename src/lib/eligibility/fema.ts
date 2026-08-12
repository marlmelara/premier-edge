import { arcgisQuery, type GeoJsonPolygon } from "@/lib/gis/arcgis";

/**
 * FEMA National Flood Hazard Layer — layer 28 "Flood Hazard Zones"
 * (verified live Aug 12, 2026). Note: hazards.fema.gov needs IPv4
 * (src/instrumentation.ts handles that).
 */
const NFHL_ZONES_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28";

export type FloodZoneHit = { zone: string; subtype?: string };

export async function queryFloodZones(parcel: GeoJsonPolygon): Promise<FloodZoneHit[]> {
  const features = await arcgisQuery(NFHL_ZONES_URL, {
    geometry: { rings: parcel.coordinates },
    geometryType: "esriGeometryPolygon",
    outFields: ["FLD_ZONE", "ZONE_SUBTY"],
    returnGeometry: false,
  });
  return features.map((f) => ({
    zone: String(f.attributes.FLD_ZONE ?? "").trim(),
    subtype: typeof f.attributes.ZONE_SUBTY === "string" ? f.attributes.ZONE_SUBTY.trim() || undefined : undefined,
  }));
}

/** FEMA Map Service Center link for the context card quick links. */
export function femaMscUrl(lng: number, lat: number): string {
  return `https://msc.fema.gov/portal/search?AddressQuery=${lat},${lng}`;
}
