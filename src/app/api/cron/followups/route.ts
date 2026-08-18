import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions } from "@/db/schema";
import { env } from "@/env";
import { runFollowUps } from "@/lib/agent/followups";

/**
 * Follow-up sweep endpoint. Drafts nudges and partner-bump raises for threads
 * that went quiet after an offer — drafts only, never sends (§6).
 *
 * Safe to call at any cadence: every decision is derived from elapsed time, so
 * extra invocations are no-ops. Vercel's Hobby plan caps crons at once per day
 * (a sub-daily expression fails the deploy outright), so vercel.json runs this
 * each morning; point any external scheduler at the same URL with the same
 * bearer token to get the same-day nudge closer to its intended 4 hours.
 */

// One Anthropic call per due thread. The default 10s would kill the sweep
// mid-loop and leave half the threads unchased.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  try {
    // Keepalive. Supabase pauses a free-tier project after ~7 days without
    // activity, and a paused database means inbound seller replies 500 at the
    // webhook and are lost silently — the worst failure mode this system has.
    // Marlon's three other Supabase projects are paused right now, so this is
    // observed behaviour, not a precaution. Any query resets the timer; this
    // sweep runs daily anyway, so the touch is free.
    await db.execute(sql`SELECT 1`);

    const sweep = await runFollowUps(db);
    if (sweep.drafted > 0 || sweep.scanned > 0) {
      await db.insert(agentActions).values({
        type: "followup_sweep",
        input: { scanned: sweep.scanned },
        output: { drafted: sweep.drafted, skipped: sweep.skipped },
      });
    }
    return NextResponse.json({ ok: true, ...sweep });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db.insert(agentActions).values({
      type: "followup_sweep_failed",
      output: { detail },
    });
    return NextResponse.json({ ok: false, reason: detail }, { status: 500 });
  }
}
