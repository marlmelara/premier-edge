import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { builders, criteriaSets } from "@/db/schema";
import { landBankCounties, landBankGeometry, matchBankToBuyer, searchLandBank, type LandBankRow } from "@/lib/land-bank";
import { LandMap, type MapParcel } from "@/components/land-map";
import type { GeoJsonPolygon } from "@/lib/gis/arcgis";
import { formatMoney, formatPhone, formatSqft, timeAgo } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Land Bank — Premier Edge" };

const COUNTY_LABELS: Record<string, string> = { st_lucie: "St. Lucie", lee: "Lee", charlotte: "Charlotte" };

function Zone({ zones }: { zones: string[] | null }) {
  if (!zones?.length) return <span className="text-muted-foreground">—</span>;
  const clean = zones.every((z) => z === "X");
  return (
    <span className={clean ? "text-green-400" : "text-amber-400"}>
      {zones.join(", ")}
    </span>
  );
}

function Row({ row, budget }: { row: LandBankRow & { withinBudget?: boolean | null }; budget?: number }) {
  return (
    <tr className="border-b border-border/50 hover:bg-secondary/30">
      <td className="py-2 pr-3">
        <p className="text-sm">{row.address ?? row.parcelRef}</p>
        <p className="text-[11px] text-muted-foreground">
          {COUNTY_LABELS[row.county] ?? row.county} · {row.parcelRef}
        </p>
      </td>
      <td className="px-3 text-sm tabular-nums">{formatSqft(row.sqft)}</td>
      <td className="px-3 text-sm">
        <Zone zones={row.floodZones} />
      </td>
      <td className="px-3 text-sm">
        {row.wetlandsIntersects === null ? (
          <span className="text-muted-foreground">?</span>
        ) : row.wetlandsIntersects ? (
          <span className="text-amber-400">intersects</span>
        ) : (
          <span className="text-green-400">clear</span>
        )}
      </td>
      <td className="px-3 text-right text-sm tabular-nums">
        {row.sellerAsking ? (
          <span className={row.withinBudget === false ? "text-amber-400" : "text-foreground"}>
            {formatMoney(row.sellerAsking)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {budget != null && row.withinBudget === true && <span className="ml-1 text-green-400">✓</span>}
      </td>
      <td className="px-3 text-sm">
        {row.contactId ? (
          <Link href={`/sellers/${row.contactId}`} className="hover:underline">
            {row.contactName ?? formatPhone(row.contactPhone ?? "")}
          </Link>
        ) : (
          <span className="text-muted-foreground">no contact</span>
        )}
      </td>
      <td className="px-3 text-[11px] text-muted-foreground">{timeAgo(row.lastCheckedAt)}</td>
    </tr>
  );
}

/**
 * Every parcel we've ever checked, searchable by the facts that never change
 * (flood zone, wetlands, size) plus the one that does (what the seller wanted).
 */
export default async function LandBankPage({
  searchParams,
}: {
  searchParams: Promise<{
    county?: string;
    minSqft?: string;
    floodZones?: string;
    wetlands?: string;
    maxAsking?: string;
    withPrice?: string;
    q?: string;
    buyer?: string;
    view?: string;
  }>;
}) {
  const sp = await searchParams;
  const db = getDb();

  const buyerOptions = await db
    .select({ id: builders.id, name: builders.name })
    .from(builders)
    .innerJoin(criteriaSets, eq(criteriaSets.builderId, builders.id))
    .orderBy(builders.name);

  const counties = await landBankCounties();

  // Buyer mode reverse-matches the whole bank against one buy box.
  const buyerMatch = sp.buyer ? await matchBankToBuyer(sp.buyer) : null;
  const rows: (LandBankRow & { withinBudget?: boolean | null })[] = buyerMatch
    ? buyerMatch.rows
    : await searchLandBank({
        county: sp.county || undefined,
        minSqft: sp.minSqft ? Number(sp.minSqft) : undefined,
        floodZones: sp.floodZones ? sp.floodZones.split(",").map((z) => z.trim().toUpperCase()).filter(Boolean) : undefined,
        wetlands: sp.wetlands === "only" || sp.wetlands === "exclude" ? sp.wetlands : undefined,
        maxAskingPrice: sp.maxAsking ? Number(sp.maxAsking) : undefined,
        withPriceOnly: sp.withPrice === "1",
        q: sp.q || undefined,
      });

  // Map is opt-in: polygons are heavy, and the table is the right tool when
  // you already know what you're looking for.
  const showMap = sp.view === "map";
  const mapParcels: MapParcel[] = showMap
    ? (
        await landBankGeometry({
          county: sp.county || undefined,
          minSqft: sp.minSqft ? Number(sp.minSqft) : undefined,
          floodZones: sp.floodZones
            ? sp.floodZones.split(",").map((z) => z.trim().toUpperCase()).filter(Boolean)
            : undefined,
          wetlands: sp.wetlands === "only" || sp.wetlands === "exclude" ? sp.wetlands : undefined,
        })
      ).map((p) => ({ ...p, geometry: p.geometry as GeoJsonPolygon }))
    : [];

  const withPrice = rows.filter((r) => r.sellerAsking).length;
  const inBudget = rows.filter((r) => r.withinBudget === true).length;

  return (
    <main className="space-y-5 px-6 py-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">Land Bank</h1>
          <p className="text-sm text-muted-foreground">
            Every parcel we&apos;ve checked, kept whether or not we could buy it. Flood zone and wetlands don&apos;t
            change — a new buyer&apos;s buy box might.
          </p>
        </div>
        <div className="flex gap-1">
          {[
            { key: "", label: "Table" },
            { key: "map", label: "Map" },
          ].map((v) => {
            const next = new URLSearchParams(
              Object.entries(sp).filter(([, val]) => val) as [string, string][],
            );
            if (v.key) next.set("view", v.key);
            else next.delete("view");
            return (
              <Link
                key={v.label}
                href={`/land-bank${next.toString() ? `?${next}` : ""}`}
                className={`rounded px-2 py-1 text-xs ${
                  (sp.view ?? "") === v.key ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/50"
                }`}
              >
                {v.label}
              </Link>
            );
          })}
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            <span className="text-lg font-semibold text-foreground">{rows.length}</span> parcels
          </p>
          <p>{withPrice} with an asking price</p>
        </div>
      </div>

      {/* Reverse match — "a buyer came along who takes wetlands" */}
      <div className="rounded-lg border border-border p-3">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Match the bank to a buyer&apos;s buy box</p>
        <div className="flex flex-wrap items-center gap-2">
          {buyerOptions.length === 0 && (
            <span className="text-xs text-muted-foreground">Add a buyer with a buy box first.</span>
          )}
          {buyerOptions.map((b) => (
            <Link
              key={b.id}
              href={sp.buyer === b.id ? "/land-bank" : `/land-bank?buyer=${b.id}`}
              className={`rounded px-2 py-1 text-xs ${
                sp.buyer === b.id ? "bg-green-950 text-green-300" : "border border-border hover:bg-secondary/50"
              }`}
            >
              {b.name}
            </Link>
          ))}
        </div>
        {buyerMatch && (
          <p className="mt-2 text-xs text-green-300">
            {rows.length} parcels fit {buyerMatch.buyerName}&apos;s criteria · we could pay up to{" "}
            {formatMoney(buyerMatch.maxOffer)} · {inBudget} already have an asking price within that
          </p>
        )}
      </div>

      {/* Manual filters */}
      {!buyerMatch && (
        <form action="/land-bank" className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3 text-xs">
          <label className="space-y-1">
            <span className="block text-muted-foreground">Search</span>
            <input
              name="q"
              defaultValue={sp.q}
              placeholder="address, parcel, owner"
              className="rounded border border-border bg-transparent px-2 py-1"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">County</span>
            <select name="county" defaultValue={sp.county ?? ""} className="rounded border border-border bg-transparent px-2 py-1">
              <option value="">Any</option>
              {counties.map((c) => (
                <option key={c} value={c}>
                  {COUNTY_LABELS[c] ?? c}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">Min sqft</span>
            <input name="minSqft" type="number" defaultValue={sp.minSqft} className="w-24 rounded border border-border bg-transparent px-2 py-1" />
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">Flood zones</span>
            <input name="floodZones" defaultValue={sp.floodZones} placeholder="X, AE" className="w-24 rounded border border-border bg-transparent px-2 py-1" />
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">Wetlands</span>
            <select name="wetlands" defaultValue={sp.wetlands ?? ""} className="rounded border border-border bg-transparent px-2 py-1">
              <option value="">Either</option>
              <option value="exclude">Clear only</option>
              <option value="only">Intersecting only</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-muted-foreground">Max asking</span>
            <input name="maxAsking" type="number" defaultValue={sp.maxAsking} className="w-24 rounded border border-border bg-transparent px-2 py-1" />
          </label>
          <label className="flex items-center gap-1.5 pb-1.5">
            <input type="checkbox" name="withPrice" value="1" defaultChecked={sp.withPrice === "1"} className="size-4" />
            <span>Has a price</span>
          </label>
          <button type="submit" className="rounded bg-secondary px-3 py-1.5">
            Filter
          </button>
        </form>
      )}

      {showMap && (
        <div className="space-y-2">
          <LandMap parcels={mapParcels} />
          <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span><span className="mr-1 inline-block size-2 rounded-sm bg-emerald-500" />clean</span>
            <span><span className="mr-1 inline-block size-2 rounded-sm bg-amber-500" />flood zone</span>
            <span><span className="mr-1 inline-block size-2 rounded-sm bg-sky-400" />wetlands</span>
            <span>{mapParcels.length} lot(s) drawn · hover for detail</span>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">Property</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Flood</th>
              <th className="px-3 py-2">Wetlands</th>
              <th className="px-3 py-2 text-right">Seller asked</th>
              <th className="px-3 py-2">Seller</th>
              <th className="px-3 py-2">Checked</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nothing in the bank matches. Every parcel you verify lands here automatically.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <Row key={row.parcelId} row={row} budget={buyerMatch?.maxOffer} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>
          <Badge variant="outline" className="mr-1 border-green-800 text-green-400">
            green
          </Badge>
          fits / clear
        </span>
        <span>
          <Badge variant="outline" className="mr-1 border-amber-800 text-amber-400">
            amber
          </Badge>
          a buyer would have to accept it
        </span>
        <span>✓ = seller&apos;s price is already within what this buyer lets us pay</span>
      </div>
    </main>
  );
}
