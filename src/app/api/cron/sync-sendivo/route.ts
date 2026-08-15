import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema";
import { env } from "@/env";
import { syncSmsLogs } from "@/lib/sendivo/sync";

/**
 * Incremental Sendivo sync. Pulls the last few days of SMS logs so new blast
 * recipients become contacts and outbound history lands on threads that exist.
 *
 * Short window by default: the sync is idempotent (dedupe on Sendivo's
 * message_id) and a rolling few days is enough to stay current, while a full
 * backfill is a one-off run of scripts/sync-sendivo.ts.
 *
 * Not in vercel.json — Hobby allows 2 crons and both are spoken for — so this
 * is driven by the same GitHub Actions schedule as the follow-up sweep.
 */
export const maxDuration = 300;

const DEFAULT_DAYS = 3;

export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = Number(req.nextUrl.searchParams.get("days") ?? DEFAULT_DAYS);
  const since = new Date(Date.now() - (Number.isFinite(days) ? days : DEFAULT_DAYS) * 86_400_000);

  const db = getDb();
  try {
    const result = await syncSmsLogs(db, { since });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db.insert(agentActions).values({ type: "sendivo_sync_failed", output: { detail } });
    return NextResponse.json({ ok: false, reason: detail }, { status: 500 });
  }
}
