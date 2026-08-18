import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, criteriaSets, messages, parcels } from "@/db/schema";
import { toCents, type OfferCriteria } from "@/lib/eligibility/offer-math";
import { boxesForPlace, priceForUtilities, type BuyBox, type UtilityRule } from "@/lib/eligibility/buy-box";

/**
 * Facts about a thread that the negotiation policy needs but can't derive from
 * the deal row alone. Read-only, shared by the inbound agent turn (run.ts) and
 * the follow-up sweep.
 */

/**
 * The buy box this lot's price comes from, resolved the same way eligibility
 * resolved it.
 *
 * This used to `findFirst` a criteria set by builder id, which was correct when
 * a builder had exactly one. Once buy boxes became many-per-builder — scoped by
 * county, city and zip, carrying a utility price matrix — that returned an
 * *arbitrary* row with no ordering, and read the base price while ignoring
 * utilities entirely.
 *
 * The consequence was silent and expensive: a Cape Coral lot on city water and
 * septic would be priced off the buyer's headline number rather than their
 * septic number, and the anchor would land thousands of dollars above what the
 * deal could actually carry. Nothing would look wrong until the spread vanished
 * at closing.
 *
 * So the same two steps eligibility performs run here: pick the most specific
 * box covering the lot, then price it for the utilities the lot actually has.
 *
 * Returns null when the due-diligence gate hasn't been cleared, when no box
 * covers the lot, or when the buyer won't take these utilities at any price.
 */
export async function loadOfferCriteria(
  db: Db,
  deal:
    | {
        verdict: string;
        matchedBuilderId: string | null;
        parcelId?: string | null;
        campaignId?: string | null;
      }
    | null
    | undefined,
): Promise<OfferCriteria | null> {
  if (!deal || deal.verdict !== "pass" || !deal.matchedBuilderId) return null;

  const rows = await db
    .select({
      id: criteriaSets.id,
      builderId: criteriaSets.builderId,
      name: criteriaSets.name,
      county: criteriaSets.county,
      cities: criteriaSets.cities,
      zips: criteriaSets.zips,
      minSqft: criteriaSets.minSqft,
      allowedFloodZones: criteriaSets.allowedFloodZones,
      wetlandsAllowed: criteriaSets.wetlandsAllowed,
      builderBuyPrice: criteriaSets.builderBuyPrice,
      minAssignmentFee: criteriaSets.minAssignmentFee,
      anchorPct: criteriaSets.anchorPct,
      concessionSteps: criteriaSets.concessionSteps,
      utilityRules: criteriaSets.utilityRules,
    })
    .from(criteriaSets)
    .where(eq(criteriaSets.builderId, deal.matchedBuilderId));

  if (rows.length === 0) return null;

  const parcel = deal.parcelId
    ? await db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) })
    : null;

  const boxes: BuyBox[] = rows.map((r) => ({
    id: r.id,
    builderId: r.builderId ?? deal.matchedBuilderId!,
    builderName: "",
    name: r.name ?? "Buy box",
    // A box saved before scoping existed has no county; treat it as covering
    // wherever it is being asked about rather than dropping it silently.
    county: r.county ?? parcel?.county ?? "",
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

  const box = parcel
    ? boxesForPlace(boxes, {
        county: parcel.county,
        city: cityOf(parcel.address),
        zip: zipOf(parcel.address),
      })[0]
    : boxes[0];

  if (!box) return null;

  // Utilities set the buy price before any offer math runs.
  const price = priceForUtilities(box, {
    water: (parcel?.waterSource as "city" | "well" | null) ?? undefined,
    sewer: (parcel?.sewerType as "city" | "septic" | null) ?? undefined,
  });
  if (!price.accepted) return null;

  return {
    builderBuyPrice: price.buyPriceCents,
    minAssignmentFee: box.minAssignmentFeeCents,
    anchorPct: box.anchorPct,
    concessionSteps: box.concessionSteps,
  };
}

/** County situs addresses are one string; city and zip are parsed back out. */
function cityOf(address?: string | null): string | undefined {
  if (!address) return undefined;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1];
  const isStateZip = /^[A-Z]{2}\s*\d{5}/.test(last) || /^\d{5}/.test(last);
  return (isStateZip ? parts[parts.length - 2] : last) || undefined;
}

function zipOf(address?: string | null): string | undefined {
  return address?.match(/\b(\d{5})(?:-\d{4})?\b\s*$/)?.[1];
}

/**
 * How many times we've actually *sent* a message asking the seller for their
 * number. Counts sent probes, not drafted ones — a probe Marlon rejected never
 * reached the seller, so it shouldn't spend one of our attempts.
 */
export async function probesSent(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentActions)
    .where(sql`
      ${agentActions.conversationId} = ${conversationId}
      AND ${agentActions.type} = 'draft_created'
      AND ${agentActions.input}->>'intent' = 'probe'
      AND EXISTS (
        SELECT 1 FROM ${agentActions} r
        WHERE r.type IN ('draft_approved', 'draft_edited')
        AND r.input->>'draftId' = ${agentActions.id}::text
      )
    `);
  return row?.count ?? 0;
}

export type SilenceState = {
  /** Outbound messages sent since the seller last said anything. */
  outboundSinceReply: number;
  /** When we last sent, or null if we never have. */
  lastOutboundAt: Date | null;
  /** Hours since that last outbound; Infinity when we've never sent. */
  hoursSinceLastOutbound: number;
};

/**
 * How long this thread has been one-sided. Everything the follow-up ladder
 * needs comes from message rows rather than intent bookkeeping, so a message
 * Marlon typed himself counts the same as one the agent drafted — if he already
 * chased them manually, we don't chase again on top of it.
 */
export async function silenceState(db: Db, conversationId: string): Promise<SilenceState> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(sql`
      ${messages.conversationId} = ${conversationId}
      AND ${messages.direction} = 'outbound'
      AND ${messages.createdAt} > COALESCE(
        (SELECT max(m.created_at) FROM ${messages} m
         WHERE m.conversation_id = ${conversationId} AND m.direction = 'inbound'),
        '-infinity'::timestamptz
      )
    `);

  const lastAt = row?.lastAt ? new Date(row.lastAt) : null;
  return {
    outboundSinceReply: row?.count ?? 0,
    lastOutboundAt: lastAt,
    hoursSinceLastOutbound: lastAt ? (Date.now() - lastAt.getTime()) / 3_600_000 : Infinity,
  };
}

/**
 * Follow-ups we've already sent on the current silence. The first outbound
 * after their last reply is the message itself; everything after it is a chase.
 */
export function followUpsFrom(state: SilenceState): number {
  return Math.max(0, state.outboundSinceReply - 1);
}

/** How many times we've actually sent a "what utilities does it have?" message. */
export async function utilityAsksSent(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentActions)
    .where(sql`
      ${agentActions.conversationId} = ${conversationId}
      AND ${agentActions.type} = 'draft_created'
      AND ${agentActions.input}->>'intent' = 'utility_probe'
      AND EXISTS (
        SELECT 1 FROM ${agentActions} r
        WHERE r.type IN ('draft_approved', 'draft_edited')
        AND r.input->>'draftId' = ${agentActions.id}::text
      )
    `);
  return row?.count ?? 0;
}
