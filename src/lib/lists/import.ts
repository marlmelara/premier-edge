import { and, eq, sql } from "drizzle-orm";
import { getAdapter } from "@/adapters/registry";
import type { CountyKey } from "@/adapters/types";
import type { Db } from "@/db";
import { contactParcels, contacts, optOuts, parcels } from "@/db/schema";
import { pickConfidentMatch, searchTermFor } from "./address";
import type { ListRow } from "./csv";

/**
 * Import a blast list into Premier Edge and resolve each row's lot.
 *
 * This is the step that inverts the funnel (§11d). Until now the system only
 * learned about a lot after a seller replied and Marlon typed the parcel id in
 * by hand — so due diligence happened *after* we'd already paid to text
 * everyone, including owners of land no buyer would ever take. Importing the
 * list up front means every lot can be checked before a single message goes
 * out, and every checked lot lands in the land bank whether it fits today or
 * not.
 *
 * Resolution is exact-match only (see address.ts). Rows we can't place
 * confidently are reported for review, never guessed at.
 */

export type ImportOptions = {
  /** Which county adapter resolves addresses. Rows naming a different county are skipped. */
  county: CountyKey;
  /** Cap concurrent county-GIS requests — these are public government endpoints. */
  concurrency?: number;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
};

export type UnresolvedRow = {
  phone: string;
  address: string | null;
  reason: string;
};

export type ImportSummary = {
  rows: number;
  contacts: number;
  parcelsLinked: number;
  /** Rows whose lot we couldn't place — the manual queue. */
  unresolved: UnresolvedRow[];
  /** Rows skipped because the contact has already opted out. */
  optedOut: number;
  errors: { phone: string; detail: string }[];
};

export async function importList(db: Db, rows: ListRow[], opts: ImportOptions): Promise<ImportSummary> {
  const slice = opts.limit ? rows.slice(0, opts.limit) : rows;
  const summary: ImportSummary = {
    rows: slice.length,
    contacts: 0,
    parcelsLinked: 0,
    unresolved: [],
    optedOut: 0,
    errors: [],
  };

  // Opt-outs are keyed by phone and survive across lists — a re-upload of a
  // list someone already opted out of must not resurrect them.
  const suppressed = new Set((await db.select({ phone: optOuts.phone }).from(optOuts)).map((r) => r.phone));

  let done = 0;
  await mapWithConcurrency(slice, opts.concurrency ?? 4, async (row) => {
    try {
      const contactId = await upsertContact(db, row, suppressed.has(row.phone));
      summary.contacts += 1;

      if (suppressed.has(row.phone)) {
        summary.optedOut += 1;
        return;
      }

      const resolved = await resolveParcel(db, row, opts.county);
      if (resolved.ok) {
        await linkContactToParcel(db, contactId, resolved.parcelRowId);
        summary.parcelsLinked += 1;
      } else {
        summary.unresolved.push({ phone: row.phone, address: row.propertyAddress ?? null, reason: resolved.reason });
      }
    } catch (error) {
      summary.errors.push({ phone: row.phone, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      done += 1;
      opts.onProgress?.(done, slice.length);
    }
  });

  return summary;
}

async function upsertContact(db: Db, row: ListRow, optedOut: boolean): Promise<string> {
  // Fill blanks only (§2.4 merge policy): a later list upload must not overwrite
  // anything we've since learned from the seller directly.
  const fill = (column: unknown, value: string | undefined) =>
    value === undefined ? undefined : sql`COALESCE(${column}, ${value})`;

  const [contact] = await db
    .insert(contacts)
    .values({
      phone: row.phone,
      source: "blast",
      name: row.name,
      email: row.email,
      altPhones: row.altPhones,
      mailingStreet: row.mailingStreet,
      mailingCity: row.mailingCity,
      mailingState: row.mailingState,
      mailingZip: row.mailingZip,
      optedOut,
      sendivoRaw: row.raw,
    })
    .onConflictDoUpdate({
      target: contacts.phone,
      set: {
        name: fill(contacts.name, row.name),
        email: fill(contacts.email, row.email),
        mailingStreet: fill(contacts.mailingStreet, row.mailingStreet),
        mailingCity: fill(contacts.mailingCity, row.mailingCity),
        mailingState: fill(contacts.mailingState, row.mailingState),
        mailingZip: fill(contacts.mailingZip, row.mailingZip),
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });

  return contact.id;
}

type Resolution = { ok: true; parcelRowId: string; parcelId: string } | { ok: false; reason: string };

/**
 * Turn a list row into a parcel row.
 *
 * When the list carries an APN we trust it and write a stub — the full record
 * gets filled in by `verifyParcel`, which upserts on (county, parcel_id) — so
 * importing a list with parcel ids costs no county-GIS calls at all. Only
 * address-only rows need a lookup.
 */
async function resolveParcel(db: Db, row: ListRow, county: CountyKey): Promise<Resolution> {
  if (row.parcelId) {
    const [stub] = await db
      .insert(parcels)
      .values({ county, parcelId: row.parcelId.trim(), address: row.propertyAddress })
      .onConflictDoUpdate({
        target: [parcels.county, parcels.parcelId],
        set: { updatedAt: new Date() },
      })
      .returning({ id: parcels.id });
    return { ok: true, parcelRowId: stub.id, parcelId: row.parcelId.trim() };
  }

  const term = searchTermFor(row);
  if (!term) return { ok: false, reason: "no property address on the row" };

  const adapter = getAdapter(county);
  const candidates = await adapter.searchByAddress(term);
  const match = pickConfidentMatch(row.propertyAddress!, candidates, row.propertyCity);
  if (!match.matched) {
    const detail =
      match.reason === "no_candidates"
        ? "county search returned nothing"
        : match.reason === "ambiguous"
          ? `${match.candidates} parcels share this address`
          : `no exact match among ${match.candidates} candidates`;
    return { ok: false, reason: detail };
  }

  const p = match.parcel;
  const [saved] = await db
    .insert(parcels)
    .values({
      county,
      parcelId: p.parcelId,
      address: p.address,
      legalDescription: p.legalDescription,
      ownerNameRaw: p.ownerNameRaw,
      acreage: p.acreage?.toFixed(4),
      sqft: p.sqft,
      geometry: p.geometry,
      sourceAdapter: p.sourceAdapter,
      rawPayload: p.rawPayload,
      appraiserUrl: p.appraiserUrl,
      assessedValue: p.assessedValue?.toFixed(2),
    })
    .onConflictDoUpdate({
      target: [parcels.county, parcels.parcelId],
      set: { address: p.address, ownerNameRaw: p.ownerNameRaw, updatedAt: new Date() },
    })
    .returning({ id: parcels.id });

  return { ok: true, parcelRowId: saved.id, parcelId: p.parcelId };
}

/**
 * The list asserts ownership from county records, so the claim is recorded as
 * `claimed` — owner XCHECK against the appraiser is what promotes it to
 * `owner`, and that runs at contract time.
 */
async function linkContactToParcel(db: Db, contactId: string, parcelRowId: string): Promise<void> {
  await db
    .insert(contactParcels)
    .values({ contactId, parcelId: parcelRowId, relationship: "claimed" })
    .onConflictDoNothing();
}

/** The parcels a contact is on record as owning — how an inbound reply finds its lot. */
export async function parcelsForContact(db: Db, contactId: string) {
  return db
    .select({
      parcelRowId: parcels.id,
      county: parcels.county,
      parcelId: parcels.parcelId,
      address: parcels.address,
    })
    .from(contactParcels)
    .innerJoin(parcels, eq(contactParcels.parcelId, parcels.id))
    .where(and(eq(contactParcels.contactId, contactId)));
}

/** Bounded parallelism — county GIS servers are public infrastructure, not a load test target. */
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
