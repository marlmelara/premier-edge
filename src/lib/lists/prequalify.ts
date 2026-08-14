import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { CountyKey } from "@/adapters/types";
import type { Db } from "@/db";
import { contactParcels, contacts, parcels } from "@/db/schema";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";

/**
 * Batch pre-qualification (§11d): run the full due-diligence chain over an
 * imported list *before* anyone gets texted.
 *
 * The payoff is twofold. Marlon only blasts owners of lots a buyer would
 * actually take, so the money and the attention go where they can convert; and
 * every lot that fails for a physical reason — wetlands, AE zone, too small —
 * is already sitting in the land bank with its findings attached, waiting for a
 * buyer whose box tolerates it.
 *
 * Resumable and idempotent: parcels checked recently are skipped, so an
 * interrupted run picks up where it stopped.
 */

export type PrequalifyOptions = {
  county: CountyKey;
  /** Buy boxes come from the buyers attached to this campaign. */
  campaignId: string;
  limit?: number;
  /** Re-check anything last verified longer ago than this. FEMA/NWI move slowly. */
  staleAfterDays?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number, parcelId: string) => void;
};

export type PrequalifySummary = {
  checked: number;
  fits: { parcelId: string; address: string | null; builder: string; maxOfferCents: number }[];
  fails: { parcelId: string; address: string | null; reasons: string[] }[];
  /** Checked but inconclusive — a GIS service was down. Worth re-running. */
  pending: { parcelId: string; address: string | null }[];
  errors: { parcelId: string; detail: string }[];
};

const DEFAULT_STALE_DAYS = 90;

export async function prequalifyList(db: Db, opts: PrequalifyOptions): Promise<PrequalifySummary> {
  const staleBefore = new Date(Date.now() - (opts.staleAfterDays ?? DEFAULT_STALE_DAYS) * 86_400_000);

  // Only parcels someone on the list actually owns — this is a list sweep, not
  // a re-scan of every parcel we've ever touched.
  const due = await db
    .selectDistinct({ parcelId: parcels.parcelId, address: parcels.address })
    .from(parcels)
    .innerJoin(contactParcels, eq(contactParcels.parcelId, parcels.id))
    .innerJoin(contacts, eq(contactParcels.contactId, contacts.id))
    .where(
      and(
        eq(parcels.county, opts.county),
        eq(contacts.optedOut, false),
        or(isNull(parcels.lastCheckedAt), lt(parcels.lastCheckedAt, staleBefore)),
      ),
    )
    .limit(opts.limit ?? 5000);

  const summary: PrequalifySummary = { checked: 0, fits: [], fails: [], pending: [], errors: [] };
  let done = 0;

  await mapWithConcurrency(due, opts.concurrency ?? 3, async (row) => {
    try {
      const result = await verifyParcel(db, opts.county, row.parcelId, opts.campaignId);
      if (!result) {
        summary.errors.push({ parcelId: row.parcelId, detail: "county has no such parcel" });
        return;
      }
      summary.checked += 1;

      const best = result.matches.find((m) => m.fits);
      if (result.verdict === "pass" && best) {
        summary.fits.push({
          parcelId: row.parcelId,
          address: result.parcel.address ?? row.address,
          builder: best.builderName,
          maxOfferCents: best.maxOfferCents,
        });
      } else if (result.verdict === "pending") {
        summary.pending.push({ parcelId: row.parcelId, address: result.parcel.address ?? row.address });
      } else {
        // Every buyer's reasons, deduped — this is what makes the land bank
        // searchable later ("show me the wetland lots").
        const reasons = [...new Set(result.matches.flatMap((m) => m.failures))];
        summary.fails.push({
          parcelId: row.parcelId,
          address: result.parcel.address ?? row.address,
          reasons: reasons.length ? reasons : ["no buyer attached to this campaign"],
        });
      }
    } catch (error) {
      summary.errors.push({ parcelId: row.parcelId, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      done += 1;
      opts.onProgress?.(done, due.length, row.parcelId);
    }
  });

  return summary;
}

export type BlastRow = {
  phone: string;
  name: string | null;
  parcelId: string;
  address: string | null;
  sqft: number | null;
};

/**
 * The contacts worth texting: owners of the lots that cleared due diligence for
 * at least one buyer on the campaign. This is the list that goes back up to
 * Sendivo.
 *
 * Takes the passing parcel ids from a `prequalifyList` run rather than
 * re-deriving them from the land-bank columns. Fit is a per-buy-box judgement —
 * flood tolerance, size floor, market — and only the run that scored them knows
 * which campaign's box was applied. Guessing from `flood_zones` alone would put
 * lots in front of sellers that no buyer on the campaign would take.
 */
export async function blastReadyContacts(
  db: Db,
  county: CountyKey,
  passingParcelIds: string[],
): Promise<BlastRow[]> {
  if (passingParcelIds.length === 0) return [];

  return db
    .selectDistinctOn([contacts.phone], {
      phone: contacts.phone,
      name: contacts.name,
      parcelId: parcels.parcelId,
      address: parcels.address,
      sqft: parcels.sqft,
    })
    .from(contacts)
    .innerJoin(contactParcels, eq(contactParcels.contactId, contacts.id))
    .innerJoin(parcels, eq(contactParcels.parcelId, parcels.id))
    .where(
      and(
        eq(parcels.county, county),
        eq(contacts.optedOut, false),
        inArray(parcels.parcelId, passingParcelIds),
      ),
    )
    .orderBy(contacts.phone);
}

/** RFC 4180 output — quoted only where it has to be, so the file diffs cleanly. */
export function toCsv(rows: BlastRow[]): string {
  const escape = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "phone,name,parcel_id,property_address,sqft";
  const body = rows.map((r) => [r.phone, r.name, r.parcelId, r.address, r.sqft].map(escape).join(","));
  return [header, ...body].join("\n") + "\n";
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}
