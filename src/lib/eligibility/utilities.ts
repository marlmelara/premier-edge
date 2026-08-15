import { arcgisQuery, type GeoJsonPolygon } from "@/lib/gis/arcgis";
import type { ParcelUtilities, SewerType, WaterSource } from "./buy-box";

/**
 * Utility service lookup (§6 amendment, Aug 15 2026).
 *
 * Whether a vacant lot has city water and sewer, or needs a well and septic, is
 * the single largest swing in what a builder will pay for it — the next owner
 * either connects or drills. So it belongs in the buy box, and that means we
 * have to determine it rather than ask.
 *
 * Same shape as the FEMA and NWI clients: point-in-polygon against a published
 * service-area layer. A lot inside the water service area has city water; one
 * outside it is on a well. Same for sewer.
 *
 * Counties publish these separately from parcels, so this is per-county like
 * the parcel adapters. Absence of a layer is reported as unknown, never guessed
 * — `priceForUtilities` refuses to price on unknown utilities precisely so a
 * missing layer can't become an invented number.
 */

const LEE_ONLINE = "https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/arcgis/rest/services";

type ServiceLayer = {
  url: string;
  /** What being inside this polygon proves. */
  means: "city_water" | "city_sewer";
  label: string;
};

/**
 * Layers verified live Aug 15 2026. Cape Coral's water assessment areas are the
 * UEP (Utilities Extension Project) footprint — for a Cape Coral vacant lot,
 * whether it sits in an assessed area is the question that decides the deal.
 */
/**
 * Counties probed Aug 15 2026:
 *
 * - **Lee** — full coverage, below.
 * - **Charlotte** — publishes only an *Urban Service Area* delineation
 *   (CCGIS_Web_Layers2022 layer 34, USA = In/Out/PG). That is a planning
 *   boundary, not a water/sewer service area. Being inside it correlates with
 *   utilities but does not establish them, and this module's whole contract is
 *   that a reported value is a fact. Deliberately not wired up.
 * - **St. Lucie** — public GIS exposes tax maps only; no service-area layer is
 *   discoverable. Would need a direct request to SLC Utilities.
 *
 * Both fall through to "not determined", which is the safe direction: a buy box
 * that prices on utilities declines to quote rather than guess, and Marlon can
 * set them by hand on the parcel when he knows.
 */
const LAYERS: Record<string, ServiceLayer[]> = {
  lee: [
    { url: `${LEE_ONLINE}/CAPECORAL_WaterAssessmentAreas/FeatureServer/0`, means: "city_water", label: "Cape Coral water assessment (UEP)" },
    { url: `${LEE_ONLINE}/WastewaterServiceArea/FeatureServer/0`, means: "city_sewer", label: "Lee County wastewater service area" },
    { url: `${LEE_ONLINE}/Lehigh_sewer_areas_served/FeatureServer/0`, means: "city_sewer", label: "Lehigh Acres sewer served" },
  ],
};

export type UtilityLookup = ParcelUtilities & {
  /** True when no layer answered — the caller must not treat this as "well/septic". */
  incomplete: boolean;
  sources: string[];
};

/**
 * Determine a parcel's utilities from published service areas.
 *
 * A county with no layers configured returns `incomplete`, which keeps every
 * utility-priced buy box from quoting on it. That is the safe direction: a lot
 * we can't classify is a lot a human should look at, not one we guess on.
 */
export async function lookupUtilities(county: string, geometry: GeoJsonPolygon): Promise<UtilityLookup> {
  const layers = LAYERS[county];
  if (!layers?.length) {
    return { incomplete: true, sources: [], detail: `no utility layers configured for ${county}` };
  }

  const sources: string[] = [];
  let water: WaterSource | undefined;
  let sewer: SewerType | undefined;
  let anyAnswered = false;

  const results = await Promise.all(
    layers.map(async (layer) => {
      try {
        const features = await arcgisQuery(layer.url, {
          // Esri wants { rings }, not GeoJSON — same shape the FEMA and NWI
          // clients send.
          geometry: { rings: geometry.coordinates },
          geometryType: "esriGeometryPolygon",
          outFields: ["*"],
          returnGeometry: false,
          resultRecordCount: 1,
        });
        return { layer, inside: features.length > 0, ok: true as const };
      } catch {
        // One layer being down must not turn into a wrong answer for the others.
        return { layer, inside: false, ok: false as const };
      }
    }),
  );

  for (const r of results) {
    if (!r.ok) continue;
    anyAnswered = true;
    if (r.inside) {
      sources.push(r.layer.label);
      if (r.layer.means === "city_water") water = "city";
      if (r.layer.means === "city_sewer") sewer = "city";
    }
  }

  if (!anyAnswered) {
    return { incomplete: true, sources: [], detail: "utility services unavailable" };
  }

  // Outside every water/sewer service area means well/septic — but only when a
  // layer of that kind actually answered. Otherwise it stays unknown.
  const waterAnswered = results.some((r) => r.ok && r.layer.means === "city_water");
  const sewerAnswered = results.some((r) => r.ok && r.layer.means === "city_sewer");

  return {
    water: water ?? (waterAnswered ? "well" : undefined),
    sewer: sewer ?? (sewerAnswered ? "septic" : undefined),
    incomplete: !waterAnswered || !sewerAnswered,
    sources,
    detail: sources.length ? sources.join(" · ") : "outside all service areas",
  };
}

export function listUtilityCounties(): string[] {
  return Object.keys(LAYERS);
}
