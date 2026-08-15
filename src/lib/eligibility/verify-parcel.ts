import { eq, sql } from "drizzle-orm";
import { getAdapter } from "@/adapters/registry";
import type { CountyKey, ParcelRecord } from "@/adapters/types";
import type { Db } from "@/db";
import { builders, campaignBuilders, checks, criteriaSets, parcels } from "@/db/schema";
import { getRedis } from "@/lib/redis";
import { queryFloodZones, type FloodZoneHit } from "./fema";
import { queryWetlands, type WetlandHit } from "./nwi";
import { lookupUtilities, type UtilityLookup } from "./utilities";
import { matchBuilders, verdictFromMatches, type BuilderCriteria, type BuilderMatch, type ParcelFacts } from "./match-builders";
import { toCents } from "./offer-math";
import { boxesForPlace, type BuyBox, type UtilityRule } from "./buy-box";
import type { CheckOutcome } from "./rules";

export type VerifyResult = {
  parcelRowId: string;
  parcel: ParcelRecord;
  facts: ParcelFacts;
  /** Every buyer on the campaign, scored — best offer first. */
  matches: BuilderMatch[];
  verdict: "pass" | "fail" | "pending";
  fromCache: boolean;
};

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The eligibility pipeline (design doc §6, extended for multiple buyers).
 *
 * County adapter → FEMA → NWI → size, gathered once per parcel, then scored
 * against each buyer attached to the campaign. This is the due-diligence gate:
 * the agent cannot quote a price until a lot has a buyer whose criteria it
 * satisfies, so we never negotiate on land nobody wants.
 */
export async function verifyParcel(
  db: Db,
  county: CountyKey,
  parcelId: string,
  campaignId: string | null,
): Promise<VerifyResult | null> {
  // The parcel comes first now: which buy boxes apply depends on the lot's
  // city and zip, so there is nothing to load criteria for until we know where
  // it is. That also means the cache key is built from the boxes that actually
  // applied, not from every box on the campaign.
  const adapter = getAdapter(county);
  const parcel = await adapter.getParcelById(parcelId);
  if (!parcel) return null;

  const place = { county, city: cityFromAddress(parcel.address), zip: zipFromAddress(parcel.address) };
  const criteria = campaignId ? await loadCampaignBuilders(db, campaignId, place) : [];

  const redis = getRedis();
  const key = cacheKey(county, parcelId, criteria);
  if (redis) {
    const hit = await redis.get<Omit<VerifyResult, "fromCache">>(key).catch(() => null);
    if (hit) return { ...hit, fromCache: true };
  }

  const [row] = await db
    .insert(parcels)
    .values(parcelValues(county, parcel))
    .onConflictDoUpdate({ target: [parcels.county, parcels.parcelId], set: { ...parcelValues(county, parcel), updatedAt: sql`now()` } })
    .returning({ id: parcels.id });

  // Parcel-level facts: gathered once, regardless of how many buyers we score.
  const geometry = parcel.geometry;
  const [flood, wet, utils] = geometry
    ? await Promise.all([
        safely(() => queryFloodZones(geometry)),
        safely(() => queryWetlands(geometry)),
        safely(() => lookupUtilities(county, geometry)),
      ])
    : [
        { ok: false as const, error: "no parcel geometry" },
        { ok: false as const, error: "no parcel geometry" },
        { ok: false as const, error: "no parcel geometry" },
      ];

  const utilities: UtilityLookup = utils.ok
    ? utils.value
    : { incomplete: true, sources: [], detail: "utility lookup failed" };

  const facts: ParcelFacts = {
    sqft: parcel.sqft,
    floodZones: flood.ok ? flood.value : [],
    wetlands: wet.ok ? wet.value : [],
    checksIncomplete: !flood.ok || !wet.ok,
  };

  // Fold the GIS findings back onto the parcel now that they're known — this is
  // what the land bank searches on.
  await db
    .update(parcels)
    .set({
      floodZones: [...new Set(facts.floodZones.map((z) => z.zone))],
      wetlandsIntersects: flood.ok && wet.ok ? facts.wetlands.length > 0 : null,
      // Null when undetermined — never defaulted to well/septic, since a buy box
      // that prices on utilities must refuse rather than guess.
      waterSource: utilities.water ?? null,
      sewerType: utilities.sewer ?? null,
      utilityDetail: utilities.detail ?? null,
      lastCheckedAt: new Date(),
      updatedAt: sql`now()`,
    })
    .where(eq(parcels.id, row.id));

  const matches = matchBuilders(facts, criteria, parcel.address);
  const verdict = verdictFromMatches(matches);

  await recordChecks(db, row.id, adapter.source, parcel, facts, flood, wet, matches);

  const result: Omit<VerifyResult, "fromCache"> = { parcelRowId: row.id, parcel, facts, matches, verdict };
  if (redis && verdict !== "pending") await redis.set(key, result, { ex: CACHE_TTL_SECONDS }).catch(() => {});
  return { ...result, fromCache: false };
}

/**
 * The buy boxes that apply to this parcel, one per builder on the campaign.
 *
 * A builder can have several — county-wide, plus tighter ones for a city or a
 * zip. The most specific box that covers the lot wins, so a Cape Coral entry
 * overrides the Lee County one without either being duplicated.
 */
export async function loadCampaignBuilders(
  db: Db,
  campaignId: string,
  place?: { county: string; city?: string | null; zip?: string | null },
): Promise<BuilderCriteria[]> {
  const rows = await db
    .select({
      boxId: criteriaSets.id,
      builderId: builders.id,
      builderName: builders.name,
      markets: builders.markets,
      name: criteriaSets.name,
      county: criteriaSets.county,
      cities: criteriaSets.cities,
      zips: criteriaSets.zips,
      utilityRules: criteriaSets.utilityRules,
      minSqft: criteriaSets.minSqft,
      allowedFloodZones: criteriaSets.allowedFloodZones,
      wetlandsAllowed: criteriaSets.wetlandsAllowed,
      builderBuyPrice: criteriaSets.builderBuyPrice,
      minAssignmentFee: criteriaSets.minAssignmentFee,
      anchorPct: criteriaSets.anchorPct,
      concessionSteps: criteriaSets.concessionSteps,
    })
    .from(campaignBuilders)
    .innerJoin(builders, eq(campaignBuilders.builderId, builders.id))
    .innerJoin(criteriaSets, eq(criteriaSets.builderId, builders.id))
    .where(eq(campaignBuilders.campaignId, campaignId));

  const boxes: BuyBox[] = rows.map((r) => ({
    id: r.boxId,
    builderId: r.builderId,
    builderName: r.builderName,
    name: r.name ?? "Buy box",
    // A box saved before scoping existed has no county; treat it as covering
    // wherever it is being asked about rather than silently dropping it.
    county: r.county ?? place?.county ?? "",
    cities: r.cities ?? [],
    zips: r.zips ?? [],
    minSqft: r.minSqft,
    allowedFloodZones: r.allowedFloodZones,
    wetlandsAllowed: r.wetlandsAllowed,
    baseBuyPriceCents: toCents(r.builderBuyPrice),
    minAssignmentFeeCents: toCents(r.minAssignmentFee),
    anchorPct: Number(r.anchorPct),
    concessionSteps: Array.isArray(r.concessionSteps) ? (r.concessionSteps as number[]) : undefined,
    utilityRules: Array.isArray(r.utilityRules) ? (r.utilityRules as UtilityRule[]) : [],
  }));

  const applicable = place ? boxesForPlace(boxes, place) : boxes;
  const markets = new Map(rows.map((r) => [r.builderId, r.markets]));

  return applicable.map((b) => ({
    builderId: b.builderId,
    builderName: b.builderName,
    markets: markets.get(b.builderId) ?? undefined,
    minSqft: b.minSqft,
    allowedFloodZones: b.allowedFloodZones,
    wetlandsAllowed: b.wetlandsAllowed,
    builderBuyPrice: b.baseBuyPriceCents,
    minAssignmentFee: b.minAssignmentFeeCents,
    anchorPct: b.anchorPct,
    concessionSteps: b.concessionSteps,
    utilityRules: b.utilityRules,
  }));
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function safely<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parcelValues(county: CountyKey, parcel: ParcelRecord, facts?: ParcelFacts) {
  return {
    county,
    parcelId: parcel.parcelId,
    // Denormalized GIS findings — what makes the land bank searchable.
    ...(facts
      ? {
          floodZones: [...new Set(facts.floodZones.map((z) => z.zone))],
          wetlandsIntersects: facts.wetlands.length > 0,
          lastCheckedAt: new Date(),
        }
      : {}),
    address: parcel.address,
    legalDescription: parcel.legalDescription,
    ownerNameRaw: parcel.ownerNameRaw,
    acreage: parcel.acreage?.toFixed(4),
    sqft: parcel.sqft,
    geometry: parcel.geometry,
    sourceAdapter: parcel.sourceAdapter,
    rawPayload: parcel.rawPayload,
    appraiserUrl: parcel.appraiserUrl,
    assessedValue: parcel.assessedValue?.toFixed(2),
  };
}

const cacheKey = (county: CountyKey, parcelId: string, criteria: BuilderCriteria[]) =>
  `verify:${county}:${parcelId}:${criteria
    .map((c) => `${c.builderId}:${c.minSqft}:${c.allowedFloodZones.join("|")}:${c.wetlandsAllowed}:${c.builderBuyPrice}`)
    .sort()
    .join(",")}`;

/**
 * One row per check kind. Buyer-specific outcomes are folded into the detail so
 * the context card can explain which buyer rejected the lot and why.
 */
async function recordChecks(
  db: Db,
  parcelRowId: string,
  source: string,
  parcel: ParcelRecord,
  facts: ParcelFacts,
  flood: Attempt<FloodZoneHit[]>,
  wet: Attempt<WetlandHit[]>,
  matches: BuilderMatch[],
) {
  const perBuyer = (kind: "fema" | "nwi" | "sqft") =>
    matches.map((m) => ({
      builder: m.builderName,
      result: m.outcomes.find((o) => o.kind === kind)?.outcome.result,
      summary: m.outcomes.find((o) => o.kind === kind)?.outcome.summary,
    }));

  /**
   * A check row records whether we *determined the fact*, which is a different
   * question from whether a buyer accepts it.
   *
   * `factKnown` is false only when the underlying service failed — FEMA down,
   * no geometry to query. With no buyers attached there is nothing to judge
   * against, but the fact is still known: "AE zone" and "10,019 sqft" are true
   * regardless of who is buying. Reporting that as an error made a fully
   * successful lookup render as three warning triangles, which is noise exactly
   * where the signal has to be trustworthy.
   */
  const worst = (kind: "fema" | "nwi" | "sqft", factKnown: boolean): CheckOutcome["result"] => {
    if (!factKnown) return "error";
    if (matches.length === 0) return "pass";
    const results = matches.map((m) => m.outcomes.find((o) => o.kind === kind)?.outcome.result);
    if (results.includes("pass")) return "pass";
    if (results.includes("error")) return "error";
    return "fail";
  };

  await db.insert(checks).values([
    {
      parcelId: parcelRowId,
      kind: "county" as const,
      result: "pass" as const,
      detail: { summary: `found via ${source}`, owner: parcel.ownerNameRaw, address: parcel.address },
    },
    {
      parcelId: parcelRowId,
      kind: "fema" as const,
      result: worst("fema", flood.ok),
      detail: flood.ok
        ? { summary: [...new Set(facts.floodZones.map((z) => z.zone))].join(", ") || "no NFHL coverage", zones: facts.floodZones, byBuyer: perBuyer("fema") }
        : { summary: "service unavailable", error: flood.error },
    },
    {
      parcelId: parcelRowId,
      kind: "nwi" as const,
      result: worst("nwi", wet.ok),
      detail: wet.ok
        ? { summary: facts.wetlands.length === 0 ? "clear" : "intersects", hits: facts.wetlands, byBuyer: perBuyer("nwi") }
        : { summary: "service unavailable", error: wet.error },
    },
    {
      parcelId: parcelRowId,
      kind: "sqft" as const,
      result: worst("sqft", facts.sqft !== undefined),
      detail: { summary: facts.sqft ? `${facts.sqft.toLocaleString("en-US")} sqft` : "size unknown", sqft: facts.sqft, byBuyer: perBuyer("sqft") },
    },
  ]);
}

/**
 * County parcel addresses are a single situs string ("4158 NW 40TH AVE, CAPE
 * CORAL"), so city and zip are parsed out of it rather than stored separately.
 * Returning undefined is fine — a zip-scoped buy box declines rather than
 * assuming, which is the safe direction.
 */
function cityFromAddress(address?: string): string | undefined {
  if (!address) return undefined;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  // Last part may be "FL 33993"; the city is the part before any state/zip tail.
  const candidate = parts[parts.length - 1];
  const isStateZip = /^[A-Z]{2}\s*\d{5}/.test(candidate) || /^\d{5}/.test(candidate);
  return (isStateZip ? parts[parts.length - 2] : candidate) || undefined;
}

function zipFromAddress(address?: string): string | undefined {
  const match = address?.match(/\b(\d{5})(?:-\d{4})?\b\s*$/);
  return match?.[1];
}
