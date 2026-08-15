"use client";

import { GeoJSON, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { GeoJsonPolygon } from "@/lib/gis/arcgis";
import "leaflet/dist/leaflet.css";

export type MapParcel = {
  id: string;
  parcelId: string;
  address: string | null;
  county: string;
  sqft: number | null;
  floodZones: string[] | null;
  wetlandsIntersects: boolean | null;
  waterSource: string | null;
  sewerType: string | null;
  askingPrice: string | null;
  geometry: GeoJsonPolygon;
};

/**
 * Every checked lot on one map.
 *
 * Land is spatial and a table hides that — three lots on the same street read
 * as three rows, but on a map they're obviously one block worth buying
 * together. Colour carries the verdict so the shape of the inventory is
 * readable without clicking: green is clean, amber is a flood zone, blue is
 * wetlands, and wetlands wins when a lot is both because it's the harder
 * problem to sell around.
 */
function colorFor(p: MapParcel): string {
  if (p.wetlandsIntersects) return "#38bdf8";
  const zones = p.floodZones ?? [];
  if (zones.length && !zones.every((z) => z.toUpperCase() === "X")) return "#f59e0b";
  return "#10b981";
}

export default function LandMapInner({ parcels, height = 620 }: { parcels: MapParcel[]; height?: number }) {
  const all = parcels.flatMap((p) => p.geometry.coordinates[0]);
  const lats = all.map(([, lat]) => lat);
  const lngs = all.map(([lng]) => lng);

  // Southwest Florida, so the map still opens somewhere sensible with no lots.
  const bounds: [[number, number], [number, number]] = all.length
    ? [
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ]
    : [
        [26.4, -82.2],
        [26.8, -81.7],
      ];

  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [30, 30] }}
      style={{ height, width: "100%", borderRadius: 8, zIndex: 0 }}
      scrollWheelZoom
      attributionControl={false}
    >
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {parcels.map((p) => (
        <GeoJSON
          key={p.id}
          data={p.geometry}
          style={{ color: colorFor(p), weight: 2, fillOpacity: 0.25 }}
        >
          <Tooltip sticky>
            <div style={{ fontSize: 12, lineHeight: 1.4 }}>
              <strong>{p.address ?? p.parcelId}</strong>
              <br />
              {p.sqft ? `${p.sqft.toLocaleString("en-US")} sqft` : "size unknown"}
              {p.floodZones?.length ? ` · zone ${p.floodZones.join("/")}` : ""}
              {p.wetlandsIntersects ? " · wetlands" : ""}
              <br />
              {p.waterSource || p.sewerType
                ? `${p.waterSource ?? "?"} water · ${p.sewerType ?? "?"} sewer`
                : "utilities not determined"}
              {p.askingPrice ? (
                <>
                  <br />
                  <strong>asking ${Number(p.askingPrice).toLocaleString("en-US")}</strong>
                </>
              ) : null}
            </div>
          </Tooltip>
        </GeoJSON>
      ))}
    </MapContainer>
  );
}
