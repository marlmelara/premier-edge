"use client";

import dynamic from "next/dynamic";
import type { GeoJsonPolygon } from "@/lib/gis/arcgis";

// Leaflet touches `window` at import time — client-only via dynamic import.
const ParcelMapInner = dynamic(() => import("./parcel-map-inner"), {
  ssr: false,
  loading: () => <div className="h-[180px] w-full animate-pulse rounded-lg bg-muted" />,
});

export function ParcelMap({ geometry, height }: { geometry: GeoJsonPolygon; height?: number }) {
  return <ParcelMapInner geometry={geometry} height={height} />;
}
