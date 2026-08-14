import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, contacts, conversations, deals, messages, parcels } from "@/db/schema";
import { toCents } from "@/lib/eligibility/offer-math";
import { AgentRefusal } from "./anthropic";
import { draftReply } from "./draft";
import { decideFollowUp } from "./negotiation";
import { isKillSwitchOn, outboundToday, THREAD_DAILY_CAP } from "./guardrails";

import { followUpsFrom, loadOfferCriteria, silenceState } from "./thread-state";

/**
 * The follow-up sweep (design doc §2.1, amended Aug 14 2026): a seller who goes
 * quiet after an offer gets chased, not abandoned. Same-day nudge at the same
 * number, then one "we went back to our partners" raise a couple of days later,
 * then we stop.
 *
 * Copilot rules apply exactly as they do on the inbound path — this produces
 * *pending drafts*, never sends. Nothing reaches a seller without Marlon
 * approving it in the Deal Room.
 *
 * The sweep is idempotent and driven entirely by elapsed time, so running it
 * hourly, daily, or twice in a minute all produce the same result. That matters
 * because Vercel's Hobby plan only allows a once-per-day cron.
 */

/** Threads still in play. A dead or accepted deal is nobody's to chase. */
const OPEN_STATES = ["OFFER_SENT", "NEGOTIATING"];
const CLOSED_STAGES: (typeof deals.stage.enumValues)[number][] = [
  "accepted",
  "under_contract",
  "closed",
  "dead",
];

export type FollowUpSweep = {
  scanned: number;
  drafted: number;
  skipped: { conversationId: string; reason: string }[];
};

export async function runFollowUps(db: Db, opts: { limit?: number } = {}): Promise<FollowUpSweep> {
  const result: FollowUpSweep = { scanned: 0, drafted: 0, skipped: [] };
  if (await isKillSwitchOn()) return { ...result, skipped: [{ conversationId: "*", reason: "kill switch is on" }] };

  const candidates = await db
    .select({
      conversationId: conversations.id,
      state: conversations.state,
      dealId: deals.id,
      verdict: deals.verdict,
      matchedBuilderId: deals.matchedBuilderId,
      lastOffer: deals.lastOffer,
      sellerCounter: deals.sellerCounter,
      parcelId: deals.parcelId,
      contactName: contacts.name,
      // A pending draft means Marlon hasn't dealt with the last one yet;
      // stacking a second card on the thread just makes the queue confusing.
      hasPendingDraft: sql<boolean>`EXISTS (
        SELECT 1 FROM ${agentActions} d
        WHERE d.conversation_id = ${conversations.id}
          AND d.type = 'draft_created'
          AND NOT EXISTS (
            SELECT 1 FROM ${agentActions} r
            WHERE r.type IN ('draft_approved', 'draft_edited', 'draft_rejected')
              AND r.input->>'draftId' = d.id::text
          )
      )`,
    })
    .from(conversations)
    .innerJoin(deals, eq(conversations.dealId, deals.id))
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .where(
      and(
        inArray(conversations.state, OPEN_STATES),
        eq(conversations.escalated, false),
        eq(contacts.optedOut, false),
        notInArray(deals.stage, CLOSED_STAGES),
        // No standing offer means there's nothing to follow up on.
        isNotNull(deals.lastOffer),
      ),
    )
    .limit(opts.limit ?? 200);

  result.scanned = candidates.length;

  for (const row of candidates) {
    const skip = (reason: string) => result.skipped.push({ conversationId: row.conversationId, reason });

    if (row.hasPendingDraft) {
      skip("a draft is already waiting for approval");
      continue;
    }

    const silence = await silenceState(db, row.conversationId);
    const criteria = await loadOfferCriteria(db, row);
    const move = decideFollowUp({
      criteria,
      lastOfferCents: row.lastOffer ? toCents(row.lastOffer) : null,
      sellerAskCents: row.sellerCounter ? toCents(row.sellerCounter) : null,
      hoursSinceLastOutbound: silence.hoursSinceLastOutbound,
      followUpsSinceReply: followUpsFrom(silence),
    });

    if (move.kind === "none") {
      skip(move.reason);
      continue;
    }
    if (move.kind === "ceiling_reached") {
      // Not an escalation: nobody is waiting on us, the ladder is simply spent.
      skip("ceiling reached — nothing left to offer");
      continue;
    }

    if ((await outboundToday(db, row.conversationId)) >= THREAD_DAILY_CAP) {
      skip("thread daily cap");
      continue;
    }

    const [parcel, thread] = await Promise.all([
      row.parcelId ? db.query.parcels.findFirst({ where: eq(parcels.id, row.parcelId) }) : Promise.resolve(null),
      db.query.messages.findMany({
        where: eq(messages.conversationId, row.conversationId),
        orderBy: desc(messages.createdAt),
        limit: 12,
      }),
    ]);

    let draft;
    try {
      draft = await draftReply({
        classification: "interested",
        conversationState: row.state,
        intent: move.intent,
        sellerName: row.contactName,
        parcelAddress: parcel?.address,
        county: parcel?.county,
        authorizedOfferCents: move.cents,
        sellerCounterCents: row.sellerCounter ? toCents(row.sellerCounter) : null,
        recentThread: [...thread].reverse().map((m) => ({ direction: m.direction, body: m.body })),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await db.insert(agentActions).values({
        conversationId: row.conversationId,
        type: "draft_failed",
        input: { intent: move.intent, source: "followup_sweep" },
        output: { detail, refusal: error instanceof AgentRefusal },
      });
      skip(`draft failed: ${detail}`);
      continue;
    }

    if (!draft.ok) {
      await db.insert(agentActions).values({
        conversationId: row.conversationId,
        type: "draft_rejected_dollar_validation",
        input: { intent: move.intent, source: "followup_sweep", authorized: move.cents },
        output: { message: draft.message, disallowed: draft.validation.ok ? [] : draft.validation.disallowed },
      });
      skip("draft failed dollar validation");
      continue;
    }

    await db.insert(agentActions).values({
      conversationId: row.conversationId,
      type: "draft_created",
      input: {
        classification: "followup",
        state: row.state,
        intent: move.intent,
        source: "followup_sweep",
        authorizedOfferCents: move.cents,
        isCeilingOffer: move.kind === "partner_bump" && move.isCeiling,
        hoursSilent: Math.round(silence.hoursSinceLastOutbound),
      },
      output: { message: draft.message, notes: draft.notes, amounts: draft.validation.amounts },
    });
    result.drafted += 1;
  }

  return result;
}
