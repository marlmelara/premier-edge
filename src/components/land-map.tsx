"use client";

import dynamic from "next/dynamic";
import type { MapParcel } from "./land-map-inner";

// Leaflet touches `window` at import time — client-only via dynamic import.
const LandMapInner = dynamic(() => import("./land-map-inner"), {
  ssr: false,
  loading: () => <div className="h-[620px] w-full animate-pulse rounded-lg bg-muted" />,
});

export function LandMap({ parcels, height }: { parcels: MapParcel[]; height?: number }) {
  return <LandMapInner parcels={parcels} height={height} />;
}

export type { MapParcel };
