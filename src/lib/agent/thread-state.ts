import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, criteriaSets, messages } from "@/db/schema";
import { toCents, type OfferCriteria } from "@/lib/eligibility/offer-math";

/**
 * Facts about a thread that the negotiation policy needs but can't derive from
 * the deal row alone. Read-only, shared by the inbound agent turn (run.ts) and
 * the follow-up sweep.
 */

/**
 * The buy box this lot's price comes from — the matched buyer's, not a campaign
 * default. Returns null when the due-diligence gate hasn't been cleared: no
 * passing verdict, no matched builder, or no criteria set. Anything less and
 * we'd be pricing a lot we can't actually sell.
 */
export async function loadOfferCriteria(
  db: Db,
  deal: { verdict: string; matchedBuilderId: string | null } | null | undefined,
): Promise<OfferCriteria | null> {
  if (!deal || deal.verdict !== "pass" || !deal.matchedBuilderId) return null;

  const criteria = await db.query.criteriaSets.findFirst({
    where: eq(criteriaSets.builderId, deal.matchedBuilderId),
  });
  if (!criteria) return null;

  return {
    builderBuyPrice: toCents(criteria.builderBuyPrice),
    minAssignmentFee: toCents(criteria.minAssignmentFee),
    anchorPct: Number(criteria.anchorPct),
    concessionSteps: Array.isArray(criteria.concessionSteps) ? (criteria.concessionSteps as number[]) : undefined,
  };
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
