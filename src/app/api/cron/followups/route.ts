import { NextResponse, type NextRequest } from "next/server";
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
