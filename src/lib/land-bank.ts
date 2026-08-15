import { and, desc, eq, gte, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { builders, contacts, criteriaSets, deals, parcels } from "@/db/schema";

/**
 * The land bank: every parcel we've ever checked, kept whether or not we could
 * buy it at the time.
 *
 * A lot rejected for flood zone or wetlands isn't dead — those are permanent
 * facts about the land, and some future builder will tolerate them. A lot
 * rejected on price is even less dead: the seller told us their number, and
 * numbers move. Either way, the parcel, its GIS findings, and the seller's
 * asking price stay on file so a new buy box can be searched against history.
 */

export type LandBankFilters = {
  county?: string;
  minSqft?: number;
  maxSqft?: number;
  /** Flood zones to include, e.g. ["X"]. Empty means any. */
  floodZones?: string[];
  /** "only" = wetlands present, "exclude" = clear only, undefined = either. */
  wetlands?: "only" | "exclude";
  /** Cap on what the seller asked, in dollars. */
  maxAskingPrice?: number;
  /** Only parcels where a seller named a price. */
  withPriceOnly?: boolean;
  q?: string;
};

export type LandBankRow = {
  parcelId: string;
  parcelRef: string;
  county: string;
  address: string | null;
  sqft: number | null;
  ownerNameRaw: string | null;
  floodZones: string[] | null;
  wetlandsIntersects: boolean | null;
  lastCheckedAt: Date | null;
  appraiserUrl: string | null;
  assessedValue: string | null;
  /** What the seller said they wanted, if they ever named a number. */
  sellerAsking: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  dealStage: string | null;
  deadReason: string | null;
};

export async function searchLandBank(filters: LandBankFilters): Promise<LandBankRow[]> {
  const db = getDb();
  const where: SQL[] = [isNotNull(parcels.lastCheckedAt)];

  if (filters.county) where.push(eq(parcels.county, filters.county));
  if (filters.minSqft) where.push(gte(parcels.sqft, filters.minSqft));
  if (filters.maxSqft) where.push(lte(parcels.sqft, filters.maxSqft));
  if (filters.wetlands === "only") where.push(eq(parcels.wetlandsIntersects, true));
  if (filters.wetlands === "exclude") where.push(eq(parcels.wetlandsIntersects, false));

  // Overlap: keep the parcel if any of its zones is in the requested set.
  if (filters.floodZones?.length) {
    where.push(sql`${parcels.floodZones} && ${filters.floodZones}::text[]`);
  }
  if (filters.maxAskingPrice) {
    where.push(sql`${deals.sellerCounter} IS NOT NULL AND ${deals.sellerCounter} <= ${filters.maxAskingPrice}`);
  }
  if (filters.withPriceOnly) where.push(isNotNull(deals.sellerCounter));
  if (filters.q) {
    const q = `%${filters.q}%`;
    const match = or(
      sql`${parcels.address} ILIKE ${q}`,
      sql`${parcels.parcelId} ILIKE ${q}`,
      sql`${parcels.ownerNameRaw} ILIKE ${q}`,
    );
    if (match) where.push(match);
  }

  return db
    .select({
      parcelId: parcels.id,
      parcelRef: parcels.parcelId,
      county: parcels.county,
      address: parcels.address,
      sqft: parcels.sqft,
      ownerNameRaw: parcels.ownerNameRaw,
      floodZones: parcels.floodZones,
      wetlandsIntersects: parcels.wetlandsIntersects,
      lastCheckedAt: parcels.lastCheckedAt,
      appraiserUrl: parcels.appraiserUrl,
      assessedValue: parcels.assessedValue,
      sellerAsking: deals.sellerCounter,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      dealStage: deals.stage,
      deadReason: deals.deadReason,
    })
    .from(parcels)
    .leftJoin(deals, eq(deals.parcelId, parcels.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .where(and(...where))
    .orderBy(desc(parcels.lastCheckedAt))
    .limit(300);
}

/**
 * Reverse match: given a buyer's buy box, which parcels in the bank fit — and
 * of those, which already have an asking price at or under what we could pay?
 * This is the "a buyer came along who takes wetlands" query.
 */
export async function matchBankToBuyer(builderId: string) {
  const db = getDb();
  const [buyer] = await db
    .select({
      name: builders.name,
      markets: builders.markets,
      minSqft: criteriaSets.minSqft,
      allowedFloodZones: criteriaSets.allowedFloodZones,
      wetlandsAllowed: criteriaSets.wetlandsAllowed,
      builderBuyPrice: criteriaSets.builderBuyPrice,
      minAssignmentFee: criteriaSets.minAssignmentFee,
    })
    .from(builders)
    .innerJoin(criteriaSets, eq(criteriaSets.builderId, builders.id))
    .where(eq(builders.id, builderId))
    .limit(1);

  if (!buyer) return null;

  const maxOffer = Number(buyer.builderBuyPrice) - Number(buyer.minAssignmentFee);
  const rows = await searchLandBank({
    minSqft: buyer.minSqft,
    floodZones: buyer.allowedFloodZones,
    wetlands: buyer.wetlandsAllowed ? undefined : "exclude",
  });

  return {
    buyerName: buyer.name,
    maxOffer,
    rows: rows.map((r) => ({
      ...r,
      // A seller who already named a number at or below our ceiling is the
      // warmest lead in the bank — we know the land fits and the price works.
      withinBudget: r.sellerAsking != null ? Number(r.sellerAsking) <= maxOffer : null,
    })),
  };
}

export async function landBankCounties(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ county: parcels.county })
    .from(parcels)
    .where(isNotNull(parcels.lastCheckedAt));
  return rows.map((r) => r.county).sort();
}

/**
 * The same land bank, but with geometry — for the map view.
 *
 * Kept separate from `searchLandBank` because polygons are heavy: a table of
 * 300 rows doesn't want them, and a map of 300 lots needs nothing else.
 */
export async function landBankGeometry(filters: LandBankFilters = {}) {
  const db = getDb();
  const where: SQL[] = [isNotNull(parcels.lastCheckedAt), isNotNull(parcels.geometry)];

  if (filters.county) where.push(eq(parcels.county, filters.county));
  if (filters.minSqft) where.push(gte(parcels.sqft, filters.minSqft));
  if (filters.wetlands === "only") where.push(eq(parcels.wetlandsIntersects, true));
  if (filters.wetlands === "exclude") where.push(eq(parcels.wetlandsIntersects, false));
  if (filters.floodZones?.length) {
    where.push(sql`${parcels.floodZones} && ${filters.floodZones}::text[]`);
  }

  return db
    .select({
      id: parcels.id,
      parcelId: parcels.parcelId,
      address: parcels.address,
      county: parcels.county,
      sqft: parcels.sqft,
      floodZones: parcels.floodZones,
      wetlandsIntersects: parcels.wetlandsIntersects,
      waterSource: parcels.waterSource,
      sewerType: parcels.sewerType,
      askingPrice: sql<string | null>`(
        SELECT d.seller_counter FROM deals d
        WHERE d.parcel_id = ${parcels.id} AND d.seller_counter IS NOT NULL
        ORDER BY d.updated_at DESC LIMIT 1)`,
      geometry: parcels.geometry,
    })
    .from(parcels)
    .where(and(...where))
    // Enough to see the shape of the inventory without shipping a megabyte of
    // polygons to the browser.
    .limit(500);
}
