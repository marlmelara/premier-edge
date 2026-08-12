import type { GeoJsonPolygon } from "@/lib/gis/arcgis";

export type CountyKey = "st_lucie" | "lee" | "charlotte";

/** Normalized parcel data — what every county adapter must produce. */
export type ParcelRecord = {
  county: CountyKey;
  parcelId: string;
  address?: string;
  ownerNameRaw?: string;
  acreage?: number;
  sqft?: number;
  geometry?: GeoJsonPolygon;
  legalDescription?: string;
  assessedValue?: number;
  appraiserUrl?: string;
  sourceAdapter: string;
  rawPayload: unknown;
};

/**
 * One interface, one file per county (design doc §6). Adding a county or a
 * state = adding an adapter file + a title default row — nothing else changes.
 */
export type CountyAdapter = {
  key: CountyKey;
  countyName: string;
  state: "FL";
  /** Authoritative source description, for the checks audit trail. */
  source: string;
  getParcelById(parcelId: string): Promise<ParcelRecord | null>;
  searchByAddress(query: string): Promise<ParcelRecord[]>;
};
