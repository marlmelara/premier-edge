import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, contracts, conversations, deals, messages, optOuts, parcels } from "@/db/schema";
import { env } from "@/env";
import { composeBriefing, type BriefingData } from "@/lib/briefing";
import { sendSms } from "@/lib/sendivo/client";

/**
 * Daily briefing cron (design doc §11b, Channel 1). Scheduled in vercel.json.
 * Vercel signs cron invocations with CRON_SECRET; we require it so the endpoint
 * can't be triggered by anyone who finds the URL.
 */

const CLOSING_WINDOW_DAYS = 14;

export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [closings, awaiting, escalations, approvals, replies, optOutCount] = await Promise.all([
    // Under-contract deals with a linked parcel. Deals without a confirmed
    // closing date report as "at title" rather than getting a made-up countdown.
    db
      .select({ address: parcels.address, parcelId: parcels.parcelId, closingDate: deals.closingDate })
      .from(deals)
      .innerJoin(parcels, eq(deals.parcelId, parcels.id))
      .where(eq(deals.stage, "under_contract"))
      .limit(10),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contracts)
      .where(sql`${contracts.status} IS DISTINCT FROM 'completed'`)
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.escalated, true))
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.type, "draft_created"),
          sql`NOT EXISTS (
            SELECT 1 FROM ${agentActions} r
            WHERE r.type IN ('draft_approved','draft_edited','draft_rejected')
            AND r.input->>'draftId' = ${agentActions.id}::text
          )`,
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.direction, "inbound"), gte(messages.createdAt, since)))
      .then((r) => r[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(optOuts)
      .where(gte(optOuts.optedOutAt, since))
      .then((r) => r[0]?.count ?? 0),
  ]);

  const data: BriefingData = {
    closings: closings
      .map((c) => ({
        address: c.address ?? c.parcelId,
        daysOut: c.closingDate ? Math.max(0, Math.ceil((c.closingDate.getTime() - Date.now()) / 86_400_000)) : null,
      }))
      // Dated closings first, soonest to furthest; undated ones after.
      .filter((c) => c.daysOut === null || c.daysOut <= CLOSING_WINDOW_DAYS)
      .sort((a, b) => (a.daysOut ?? Infinity) - (b.daysOut ?? Infinity)),
    contractsAwaitingSignature: awaiting,
    escalationsPending: escalations,
    approvalsWaiting: approvals,
    newRepliesSinceYesterday: replies,
    optOutsYesterday: optOutCount,
  };

  const message = composeBriefing(data);
  const to = env().MARLON_PHONE;
  if (!to) {
    await db.insert(agentActions).values({ type: "briefing_skipped", input: data, output: { reason: "no MARLON_PHONE" } });
    return NextResponse.json({ ok: false, reason: "MARLON_PHONE not configured", preview: message }, { status: 200 });
  }

  try {
    const result = await sendSms({ to, message });
    await db.insert(agentActions).values({
      type: "briefing_sent",
      input: data,
      output: { sendivoMessageId: result.message_id, chars: message.length },
    });
    return NextResponse.json({ ok: true, chars: message.length }, { status: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db.insert(agentActions).values({ type: "briefing_failed", input: data, output: { detail } });
    return NextResponse.json({ ok: false, reason: detail }, { status: 200 });
  }
}
