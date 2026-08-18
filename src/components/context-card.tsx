import Link from "next/link";
import type { checks as checksTable, contacts, contracts as contractsTable, criteriaSets, deals, parcels } from "@/db/schema";
import { crossCheckOwner } from "@/lib/contracts/owner-xcheck";
import { Badge } from "@/components/ui/badge";
import { ParcelMap } from "@/components/parcel-map";
import { ParcelManager, type OwnedParcel } from "@/components/parcel-manager";
import { LabelPicker } from "@/components/label-picker";
import { ClerkLink } from "@/components/clerk-link";
import { DealStage } from "@/components/deal-stage";
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
type Contract = typeof contractsTable.$inferSelect;

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
  contracts = [],
  ownedParcels = [],
  campaigns = [],
}: {
  deal: Deal;
  parcel: Parcel | null;
  checks: Check[];
  contact: Contact | null;
  criteria: Criteria | null;
  contracts?: Contract[];
  /** Every lot this seller is on record for, not just the one under negotiation. */
  ownedParcels?: OwnedParcel[];
  campaigns?: { id: string; name: string }[];
}) {
  if (!parcel) {
    return (
      <div data-testid="context-card" className="space-y-4 p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Property Context</h2>
        <p className="text-sm text-muted-foreground">
          No parcel linked yet. Look it up by county parcel ID to run eligibility.
        </p>
        {contact && (
          <ParcelManager
            dealId={deal.id}
            contactId={contact.id}
            activeParcelRowId={null}
            owned={ownedParcels}
          />
        )}
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

  const xcheck = crossCheckOwner(contact?.name, parcel.ownerNameRaw);

  // Per-buyer results were recorded into the check details by the eligibility
  // pipeline; reassemble them so the card can show who wants this lot.
  const buyerMatches = (() => {
    type Row = { builder: string; fits: boolean; failures: string[]; maxOffer: string | null };
    const byBuilder = new Map<string, Row>();
    for (const check of checks) {
      const detail = (check.detail ?? {}) as { byBuyer?: { builder?: string; result?: string; summary?: string }[] };
      for (const entry of detail.byBuyer ?? []) {
        if (!entry.builder) continue;
        const row = byBuilder.get(entry.builder) ?? { builder: entry.builder, fits: true, failures: [], maxOffer: null };
        if (entry.result !== "pass") {
          row.fits = false;
          row.failures.push(`${CHECK_LABELS[check.kind] ?? check.kind}: ${entry.summary ?? entry.result}`);
        }
        byBuilder.set(entry.builder, row);
      }
    }
    const rows = [...byBuilder.values()];
    // The matched buyer's numbers are already denormalized on the deal.
    const matched = rows.find((r) => r.fits);
    if (matched) matched.maxOffer = deal.maxOffer;
    return rows.sort((a, b) => Number(b.fits) - Number(a.fits));
  })();
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
            ? `DOESN'T QUALIFY: ${failedKinds.join(", ").toLowerCase()} — land bank only`
            : errorKinds.length
              ? `COULDN'T CHECK: ${errorKinds.join(", ").toLowerCase()} — re-run ⚠️`
              : buyerMatches.length === 0
                ? "CHECKS DONE — no buyer to judge against"
                : "PENDING ⚠️"}
      </div>

      {/* Utilities: the largest single price swing on a vacant lot, since the
          next owner either connects or drills. */}
      <div className="rounded border border-border p-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Utilities</span>
          <span className="font-medium">
            {parcel.waterSource || parcel.sewerType
              ? `${parcel.waterSource === "city" ? "City water" : parcel.waterSource === "well" ? "Well" : "water ?"} · ${
                  parcel.sewerType === "city" ? "city sewer" : parcel.sewerType === "septic" ? "septic" : "sewer ?"
                }`
              : "not determined"}
          </span>
        </div>
        {parcel.utilityDetail && <p className="mt-0.5 text-[10px] text-muted-foreground">{parcel.utilityDetail}</p>}
      </div>

      <ClerkLink county={parcel.county} ownerName={parcel.ownerNameRaw} parcelId={parcel.parcelId} />

      <DealStage
        dealId={deal.id}
        stage={deal.stage}
        assignmentFee={deal.assignmentFee}
        campaignId={deal.campaignId}
        campaigns={campaigns}
      />

      {contact && <LabelPicker contactId={contact.id} current={contact.labels ?? []} />}

      {/* Which buyer wants it — the point of the whole check */}
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-muted-foreground">Buyer match</p>
        {buyerMatches.length === 0 ? (
          <p className="text-[11px] text-yellow-400">
            No buyers on this campaign yet — add one under Buyers, or nothing can be priced.
          </p>
        ) : (
          buyerMatches.map((m) => (
            <div
              key={m.builder}
              className={`flex items-start justify-between rounded border px-2 py-1 text-[11px] ${
                m.fits ? "border-green-800 bg-green-950/30" : "border-border"
              }`}
            >
              <span className={m.fits ? "text-green-300" : "text-muted-foreground"}>
                {m.fits ? "✅" : "❌"} {m.builder}
                {!m.fits && m.failures.length > 0 && (
                  <span className="block pl-4 text-muted-foreground">{m.failures.join(" · ")}</span>
                )}
              </span>
              {m.fits && <span className="shrink-0 font-medium text-green-300">max {formatMoney(m.maxOffer)}</span>}
            </div>
          ))
        )}
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

      {/* Contract status + owner cross-check */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {(["psa", "assignment"] as const).map((kind) => {
            const contract = contracts.find((c) => c.kind === kind);
            return (
              <Badge
                key={kind}
                variant="outline"
                className={contract?.status === "completed" ? "border-green-700 text-green-300" : undefined}
              >
                {kind === "psa" ? "PSA" : "Assignment"} — {contract?.status?.replace(/_/g, " ") ?? "not sent"}
              </Badge>
            );
          })}
        </div>
        <p className={`text-[11px] ${xcheck.requiresHumanApproval ? "text-yellow-400" : "text-muted-foreground"}`}>
          Owner XCHECK: {xcheck.verdict} — {xcheck.reason}
        </p>
      </div>

      {/* Quick links */}
      {contact && (
        <div className="border-t border-border pt-3">
          <ParcelManager
            dealId={deal.id}
            contactId={contact.id}
            activeParcelRowId={parcel.id}
            owned={ownedParcels}
          />
        </div>
      )}

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
