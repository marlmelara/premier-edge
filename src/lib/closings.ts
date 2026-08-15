import { and, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, deals, parcels } from "@/db/schema";
import { toDayString, type DateRange } from "./date-range";

/**
 * Closings and money (§2.5, Aug 15 2026).
 *
 * "Closed" means the assignment funded, and the number that matters is our
 * spread — the assignment fee — not the purchase price. `deals.assignment_fee`
 * records it explicitly at close rather than deriving it from the buy box,
 * because a buy box edited next month must not retroactively change what a
 * past month earned.
 *
 * Escrow is the other half: money under contract but not yet funded. Both are
 * counted the same way so the two banners are directly comparable.
 */

export type ClosingRow = {
  dealId: string;
  day: string;
  feeCents: number;
  address: string | null;
  sellerName: string | null;
  sellerPhone: string;
};

export type ClosingsSummary = {
  rows: ClosingRow[];
  totalCents: number;
  count: number;
  /** Day string → total for that day, for the calendar cells. */
  byDay: Map<string, { cents: number; count: number }>;
  /** Month start (YYYY-MM-01) → total, for scopes too long to show daily. */
  byMonth: Map<string, { cents: number; count: number }>;
};

const toCents = (v: string | null) => (v ? Math.round(Number(v) * 100) : 0);

/** Deals whose money has landed, within the range. */
export async function listClosings(range: DateRange): Promise<ClosingsSummary> {
  const db = getDb();

  const rows = await db
    .select({
      dealId: deals.id,
      // A confirmed funding date wins; a scheduled closing date is the fallback
      // so a deal marked closed without a funding timestamp still appears.
      closedAt: sql<string>`COALESCE(${deals.closedAt}, ${deals.closingDate})`,
      assignmentFee: deals.assignmentFee,
      address: parcels.address,
      sellerName: contacts.name,
      sellerPhone: contacts.phone,
    })
    .from(deals)
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(parcels, eq(deals.parcelId, parcels.id))
    .where(
      and(
        eq(deals.stage, "closed"),
        or(isNotNull(deals.closedAt), isNotNull(deals.closingDate)),
        gte(sql`COALESCE(${deals.closedAt}, ${deals.closingDate})`, range.from),
        lt(sql`COALESCE(${deals.closedAt}, ${deals.closingDate})`, range.to),
      ),
    );

  return summarize(
    rows.map((r) => ({
      dealId: r.dealId,
      day: toDayString(new Date(r.closedAt)),
      feeCents: toCents(r.assignmentFee),
      address: r.address,
      sellerName: r.sellerName,
      sellerPhone: r.sellerPhone,
    })),
  );
}

/** Under contract, not yet funded — the escrow banner. */
export async function escrowTotal(): Promise<{ cents: number; count: number }> {
  const db = getDb();
  const [row] = await db
    .select({
      cents: sql<number>`COALESCE(SUM(${deals.assignmentFee}), 0) * 100`,
      count: sql<number>`count(*)::int`,
    })
    .from(deals)
    .where(eq(deals.stage, "under_contract"));

  return { cents: Math.round(Number(row?.cents ?? 0)), count: row?.count ?? 0 };
}

function summarize(rows: ClosingRow[]): ClosingsSummary {
  const byDay = new Map<string, { cents: number; count: number }>();
  const byMonth = new Map<string, { cents: number; count: number }>();
  let totalCents = 0;

  for (const row of rows) {
    totalCents += row.feeCents;

    const day = byDay.get(row.day) ?? { cents: 0, count: 0 };
    day.cents += row.feeCents;
    day.count += 1;
    byDay.set(row.day, day);

    const monthKey = `${row.day.slice(0, 7)}-01`;
    const month = byMonth.get(monthKey) ?? { cents: 0, count: 0 };
    month.cents += row.feeCents;
    month.count += 1;
    byMonth.set(monthKey, month);
  }

  return {
    rows: rows.sort((a, b) => a.day.localeCompare(b.day)),
    totalCents,
    count: rows.length,
    byDay,
    byMonth,
  };
}
