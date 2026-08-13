import Link from "next/link";
import type { checks as checksTable, contacts, criteriaSets, deals, parcels } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { ParcelMap } from "@/components/parcel-map";
import { AttachParcelForm } from "@/components/attach-parcel";
import { anchorOffer, fromCents, maxOffer, roomLeft, toCents, type OfferCriteria } from "@/lib/eligibility/offer-math";
import { femaMscUrl } from "@/lib/eligibility/fema";
import { nwiMapperUrl } from "@/lib/eligibility/nwi";
import { formatDateTime, formatMoney, formatSqft } from "@/lib/format";
import type { GeoJsonPolygon } from "@/lib/gis/arcgis";

type Deal = typeof deals.$inferSelect;
type Parcel = typeof parcels.$inferSelect;
type Check = typeof checksTable.$inferSelect;
type Contact = typeof contacts.$inferSelect;
type Criteria = typeof criteriaSets.$inferSelect;

const COUNTY_LABELS: Record<string, string> = { st_lucie: "St. Lucie", lee: "Lee", charlotte: "Charlotte" };
const CHECK_LABELS: Record<string, string> = { county: "County", fema: "Flood zone", nwi: "Wetlands", sqft: "Size" };

function resultIcon(result: string) {
  return result === "pass" ? "✅" : result === "fail" ? "❌" : "⚠️";
}

/**
 * The Property Context Card (design doc §2.1) — one component, one truth.
 * Renders anywhere a conversation appears: Deal Room, Seller 360, approval
 * queue. Answers "who, what land, do we want it, what will we pay" in <5s.
 */
export function ContextCard({
  deal,
  parcel,
  checks,
  contact,
  criteria,
}: {
  deal: Deal;
  parcel: Parcel | null;
  checks: Check[];
  contact: Contact | null;
  criteria: Criteria | null;
}) {
  if (!parcel) {
    return (
      <div data-testid="context-card" className="space-y-4 p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Property Context</h2>
        <p className="text-sm text-muted-foreground">
          No parcel linked yet. Look it up by county parcel ID to run eligibility.
        </p>
        <AttachParcelForm dealId={deal.id} />
        {contact?.sendivoRaw != null &&
          typeof contact.sendivoRaw === "object" &&
          "property_address" in contact.sendivoRaw &&
          typeof contact.sendivoRaw.property_address === "string" && (
            <p className="text-xs text-muted-foreground">
              Sendivo enrichment suggests: {String(contact.sendivoRaw.property_address)}
            </p>
          )}
      </div>
    );
  }

  const geometry = (parcel.geometry as GeoJsonPolygon | null) ?? null;
  const centroid = geometry
    ? geometry.coordinates[0]
        .reduce<[number, number]>(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
        .map((v) => v / geometry.coordinates[0].length)
    : null;

  const failedKinds = checks.filter((c) => c.result === "fail").map((c) => CHECK_LABELS[c.kind] ?? c.kind);
  const errorKinds = checks.filter((c) => c.result === "error").map((c) => CHECK_LABELS[c.kind] ?? c.kind);

  const offerCriteria: OfferCriteria | null = criteria
    ? {
        builderBuyPrice: toCents(criteria.builderBuyPrice),
        minAssignmentFee: toCents(criteria.minAssignmentFee),
        anchorPct: Number(criteria.anchorPct),
        concessionSteps: Array.isArray(criteria.concessionSteps) ? (criteria.concessionSteps as number[]) : undefined,
      }
    : null;
  const computedMax = offerCriteria ? fromCents(maxOffer(offerCriteria)) : deal.maxOffer;
  const computedAnchor = offerCriteria ? fromCents(anchorOffer(offerCriteria)) : deal.anchor;
  const room =
    offerCriteria != null
      ? fromCents(roomLeft(offerCriteria, deal.lastOffer ? toCents(deal.lastOffer) : null))
      : null;

  return (
    <div data-testid="context-card" className="space-y-4 p-4">
      {/* Identity */}
      <div>
        <h2 className="text-sm font-semibold">{parcel.address ?? "(no situs address)"}</h2>
        <p className="text-xs text-muted-foreground">
          {COUNTY_LABELS[parcel.county] ?? parcel.county} County · {parcel.parcelId}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatSqft(parcel.sqft)}
          {parcel.acreage ? ` · ${Number(parcel.acreage).toFixed(2)} ac` : ""}
          {parcel.assessedValue ? ` · assessed ${formatMoney(parcel.assessedValue)}` : ""}
        </p>
        {parcel.ownerNameRaw && <p className="mt-1 text-xs">Owner of record: {parcel.ownerNameRaw}</p>}
      </div>

      {/* Verdict strip */}
      <div
        className={`rounded-md px-3 py-2 text-sm font-semibold ${
          deal.verdict === "pass"
            ? "bg-green-950 text-green-300"
            : deal.verdict === "fail"
              ? "bg-red-950 text-red-300"
              : "bg-yellow-950 text-yellow-300"
        }`}
      >
        {deal.verdict === "pass"
          ? "ALL BOXES CHECKED ✅"
          : deal.verdict === "fail"
            ? `FAILED: ${failedKinds.join(", ").toLowerCase()} ❌`
            : errorKinds.length
              ? `PENDING: ${errorKinds.join(", ").toLowerCase()} ⚠️`
              : "PENDING ⚠️"}
      </div>

      {/* Eligibility badges — click-expandable to raw detail + checked-at */}
      <div className="space-y-1">
        {checks.map((check) => {
          const detail = (check.detail ?? {}) as Record<string, unknown>;
          return (
            <details key={check.id} className="group rounded border border-border">
              <summary className="flex cursor-pointer items-center justify-between px-2 py-1.5 text-xs">
                <span>
                  {resultIcon(check.result)} {CHECK_LABELS[check.kind] ?? check.kind}
                </span>
                <span className="text-muted-foreground">{String(detail.summary ?? check.result)}</span>
              </summary>
              <div className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
                <p>checked {formatDateTime(check.checkedAt)}</p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(detail, null, 1)}
                </pre>
              </div>
            </details>
          );
        })}
      </div>

      {/* The numbers — computed, never typed */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded border border-border p-2">
          <p className="text-[11px] text-muted-foreground">Max offer</p>
          <p className="font-semibold">{formatMoney(computedMax)}</p>
        </div>
        <div className="rounded border border-border p-2">
          <p className="text-[11px] text-muted-foreground">Anchor (start at)</p>
          <p className="font-semibold">{formatMoney(computedAnchor)}</p>
        </div>
        <div className="rounded border border-border p-2">
          <p className="text-[11px] text-muted-foreground">Last offered</p>
          <p className="font-semibold">{formatMoney(deal.lastOffer)}</p>
        </div>
        <div className="rounded border border-border p-2">
          <p className="text-[11px] text-muted-foreground">Seller counter</p>
          <p className="font-semibold">{formatMoney(deal.sellerCounter)}</p>
        </div>
        {room != null && (
          <div className="col-span-2 rounded border border-border p-2">
            <p className="text-[11px] text-muted-foreground">Room left</p>
            <p className="font-semibold">{formatMoney(room)}</p>
          </div>
        )}
        {!criteria && (
          <p className="col-span-2 text-[11px] text-muted-foreground">
            No campaign criteria linked — numbers show stored values only.
          </p>
        )}
      </div>

      {/* Map snapshot */}
      {geometry && <ParcelMap geometry={geometry} />}

      {/* Contract status chips land in M4 */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">PSA — not sent</Badge>
        <Badge variant="outline">Assignment — not sent</Badge>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-3 text-xs">
        {parcel.appraiserUrl && (
          <Link href={parcel.appraiserUrl} target="_blank" className="underline underline-offset-2">
            County appraiser
          </Link>
        )}
        {centroid && (
          <>
            <Link href={femaMscUrl(centroid[0], centroid[1])} target="_blank" className="underline underline-offset-2">
              FEMA MSC
            </Link>
            <Link href={nwiMapperUrl(centroid[0], centroid[1])} target="_blank" className="underline underline-offset-2">
              NWI mapper
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
