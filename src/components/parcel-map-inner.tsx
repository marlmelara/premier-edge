"use client";

import { GeoJSON, MapContainer, TileLayer } from "react-leaflet";
import type { GeoJsonPolygon } from "@/lib/gis/arcgis";
import "leaflet/dist/leaflet.css";

export default function ParcelMapInner({ geometry, height = 180 }: { geometry: GeoJsonPolygon; height?: number }) {
  const lngs = geometry.coordinates[0].map(([lng]) => lng);
  const lats = geometry.coordinates[0].map(([, lat]) => lat);
  const bounds: [[number, number], [number, number]] = [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];

  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [20, 20] }}
      style={{ height, width: "100%", borderRadius: 8, zIndex: 0 }}
      scrollWheelZoom={false}
      attributionControl={false}
    >
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <GeoJSON data={geometry} style={{ color: "#f59e0b", weight: 2, fillOpacity: 0.15 }} />
    </MapContainer>
  );
}
