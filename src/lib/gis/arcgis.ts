/**
 * Minimal ArcGIS REST query client shared by county adapters and the
 * FEMA/NWI checks. GET for short URLs, POST (form-encoded) when the query
 * string would get too long (parcel polygons).
 */

export type EsriPolygon = { rings: number[][][] };

export type EsriFeature = {
  attributes: Record<string, unknown>;
  geometry?: EsriPolygon;
};

export class ArcgisError extends Error {
  constructor(
    message: string,
    readonly layerUrl: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ArcgisError";
  }
}

export type ArcgisQueryOptions = {
  where?: string;
  /** Esri geometry object (point {x,y} or polygon {rings}) in WGS84. */
  geometry?: Record<string, unknown>;
  geometryType?: "esriGeometryPoint" | "esriGeometryPolygon" | "esriGeometryEnvelope";
  outFields: string[];
  returnGeometry?: boolean;
  resultRecordCount?: number;
  orderByFields?: string;
};

export async function arcgisQuery(layerUrl: string, opts: ArcgisQueryOptions): Promise<EsriFeature[]> {
  const params = new URLSearchParams({ f: "json", outFields: opts.outFields.join(",") });
  if (opts.where) params.set("where", opts.where);
  if (opts.geometry) {
    params.set("geometry", JSON.stringify(opts.geometry));
    params.set("geometryType", opts.geometryType ?? "esriGeometryPolygon");
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
  }
  params.set("returnGeometry", opts.returnGeometry ? "true" : "false");
  if (opts.returnGeometry) params.set("outSR", "4326");
  if (opts.resultRecordCount) params.set("resultRecordCount", String(opts.resultRecordCount));
  if (opts.orderByFields) params.set("orderByFields", opts.orderByFields);

  const queryUrl = `${layerUrl}/query`;
  const getUrl = `${queryUrl}?${params.toString()}`;
  const doFetch = () =>
    getUrl.length <= 1900
      ? fetch(getUrl)
      : fetch(queryUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params,
        });

  // Government GIS servers (FEMA especially) reset connections intermittently —
  // retry transient network errors and 5xx twice with a short backoff.
  let res: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      res = await doFetch();
      if (res.status < 500) break;
      lastError = new ArcgisError(`HTTP ${res.status}`, layerUrl);
      res = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  if (!res) throw lastError instanceof Error ? lastError : new ArcgisError("network failure", layerUrl);

  if (!res.ok) throw new ArcgisError(`HTTP ${res.status}`, layerUrl);
  const json = (await res.json()) as {
    features?: EsriFeature[];
    error?: { code?: number; message?: string };
  };
  if (json.error) throw new ArcgisError(json.error.message ?? "query failed", layerUrl, json.error.code);
  return json.features ?? [];
}

/** Escape a value for use inside an ArcGIS SQL string literal. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };

export function esriPolygonToGeoJson(geometry: EsriPolygon | undefined): GeoJsonPolygon | undefined {
  if (!geometry?.rings?.length) return undefined;
  return { type: "Polygon", coordinates: geometry.rings };
}

const EARTH_RADIUS_M = 6378137;
const SQMETERS_TO_SQFT = 10.76391041671;

/**
 * Planar shoelace area on an equirectangular projection centered at the ring's
 * mean latitude — accurate well under 0.1% at parcel scale. Holes (additional
 * rings) are subtracted.
 */
export function polygonAreaSqft(polygon: GeoJsonPolygon | undefined): number | undefined {
  if (!polygon?.coordinates?.length) return undefined;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const ringArea = (ring: number[][]): number => {
    if (ring.length < 3) return 0;
    const lat0 = toRad(ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length);
    const cosLat = Math.cos(lat0);
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [lng1, lat1] = ring[i];
      const [lng2, lat2] = ring[(i + 1) % ring.length];
      const x1 = toRad(lng1) * cosLat;
      const x2 = toRad(lng2) * cosLat;
      sum += x1 * toRad(lat2) - x2 * toRad(lat1);
    }
    return Math.abs(sum / 2) * EARTH_RADIUS_M * EARTH_RADIUS_M;
  };

  const [outer, ...holes] = polygon.coordinates;
  const sqMeters = ringArea(outer) - holes.reduce((sum, h) => sum + ringArea(h), 0);
  return Math.max(0, sqMeters * SQMETERS_TO_SQFT);
}
