import { sql } from "drizzle-orm";
import { getAdapter } from "@/adapters/registry";
import type { CountyKey, ParcelRecord } from "@/adapters/types";
import type { Db } from "@/db";
import { checks, parcels } from "@/db/schema";
import { getRedis } from "@/lib/redis";
import { queryFloodZones } from "./fema";
import { queryWetlands } from "./nwi";
import { evaluateFloodZones, evaluateSqft, evaluateWetlands, overallVerdict, type CheckOutcome } from "./rules";

export type VerifyCriteria = {
  minSqft: number;
  allowedFloodZones: string[];
  wetlandsAllowed: boolean;
};

export type VerifyResult = {
  parcelRowId: string;
  parcel: ParcelRecord;
  outcomes: { kind: "county" | "fema" | "nwi" | "sqft"; outcome: CheckOutcome }[];
  verdict: "pass" | "fail" | "pending";
  fromCache: boolean;
};

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const cacheKey = (county: CountyKey, parcelId: string, c: VerifyCriteria) =>
  `verify:${county}:${parcelId}:${c.minSqft}:${c.allowedFloodZones.join("|")}:${c.wetlandsAllowed}`;

/**
 * The eligibility pipeline (design doc §6): county adapter → FEMA → NWI →
 * size → persisted checks + Redis cache. Every run appends fresh rows to
 * `checks` (history preserved); the parcels row is upserted on
 * (county, parcel_id).
 */
export async function verifyParcel(
  db: Db,
  county: CountyKey,
  parcelId: string,
  criteria: VerifyCriteria,
): Promise<VerifyResult | null> {
  const redis = getRedis();
  const key = cacheKey(county, parcelId, criteria);
  if (redis) {
    const hit = await redis.get<Omit<VerifyResult, "fromCache">>(key).catch(() => null);
    if (hit) return { ...hit, fromCache: true };
  }

  const adapter = getAdapter(county);
  const parcel = await adapter.getParcelById(parcelId);
  if (!parcel) return null;

  // Upsert the parcels row first so checks can reference it.
  const [row] = await db
    .insert(parcels)
    .values({
      county,
      parcelId: parcel.parcelId,
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
    })
    .onConflictDoUpdate({
      target: [parcels.county, parcels.parcelId],
      set: {
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
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: parcels.id });

  const countyOutcome: CheckOutcome = {
    result: "pass",
    summary: `found via ${adapter.source}`,
    detail: { parcelId: parcel.parcelId, address: parcel.address, owner: parcel.ownerNameRaw },
  };

  const runExternal = async (fn: () => Promise<CheckOutcome>): Promise<CheckOutcome> => {
    try {
      return await fn();
    } catch (error) {
      return {
        result: "error",
        summary: "service unavailable",
        detail: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  };

  const geometry = parcel.geometry;
  const [femaOutcome, nwiOutcome] = geometry
    ? await Promise.all([
        runExternal(async () => evaluateFloodZones(await queryFloodZones(geometry), criteria.allowedFloodZones)),
        runExternal(async () => evaluateWetlands(await queryWetlands(geometry), criteria.wetlandsAllowed)),
      ])
    : [
        { result: "error" as const, summary: "no geometry", detail: {} },
        { result: "error" as const, summary: "no geometry", detail: {} },
      ];
  const sqftOutcome = evaluateSqft(parcel.sqft, criteria.minSqft);

  const outcomes: VerifyResult["outcomes"] = [
    { kind: "county", outcome: countyOutcome },
    { kind: "fema", outcome: femaOutcome },
    { kind: "nwi", outcome: nwiOutcome },
    { kind: "sqft", outcome: sqftOutcome },
  ];

  await db.insert(checks).values(
    outcomes.map(({ kind, outcome }) => ({
      parcelId: row.id,
      kind,
      result: outcome.result,
      detail: { summary: outcome.summary, ...outcome.detail, criteria },
    })),
  );

  const verdict = overallVerdict(outcomes.map((o) => o.outcome));
  const result: Omit<VerifyResult, "fromCache"> = {
    parcelRowId: row.id,
    parcel,
    outcomes,
    verdict,
  };

  // Cache only clean verdicts — errors should retry on next request.
  if (redis && verdict !== "pending") {
    await redis.set(key, result, { ex: CACHE_TTL_SECONDS }).catch(() => {});
  }

  return { ...result, fromCache: false };
}
