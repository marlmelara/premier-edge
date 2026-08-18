import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { getRedis } from "@/lib/redis";

/**
 * Guardrails that live in code, never in the prompt (design doc §6).
 * The opt-out gate and quiet hours are enforced at send time in
 * lib/sendivo/send.ts; these are the agent-specific limits.
 *
 * DOC AMENDMENT (Aug 15 2026): these were Redis-only, and Redis was never
 * provisioned. That left the kill switch inert and the send-lock absent — two
 * concurrent webhook retries could double-text a seller, which is the failure
 * a lock exists to prevent.
 *
 * Postgres is always present and this is a two-user system, so both now live
 * there: the kill switch as a row, the lock as a `pg_advisory_lock`, which the
 * database releases on its own if a function dies mid-run. Redis stays as a
 * fast path when configured, but nothing depends on it for correctness.
 */

export const THREAD_DAILY_CAP = 3;

/**
 * Global kill switch — flips every conversation to approval-only, instantly.
 *
 * Stored as the newest `kill_switch` row in the audit log rather than a
 * settings table: the history of who stopped the agent and when is worth as
 * much as the current state, and agent_actions is already append-only.
 */
export async function isKillSwitchOn(db?: Db): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<string>("agent:kill_switch").catch(() => null);
    if (cached !== null) return cached === "on";
  }

  const database = db ?? getDb();
  const [row] = await database
    .select({ on: sql<boolean>`(${agentActions.output}->>'on')::boolean` })
    .from(agentActions)
    .where(eq(agentActions.type, "kill_switch"))
    .orderBy(desc(agentActions.createdAt))
    .limit(1);
  return row?.on === true;
}

export async function setKillSwitch(on: boolean, db?: Db): Promise<void> {
  const database = db ?? getDb();
  await database.insert(agentActions).values({
    type: "kill_switch",
    input: { action: on ? "engaged" : "released" },
    output: { on },
    approvedBy: "marlon",
  });

  // Redis, when present, is only a cache in front of that row.
  const redis = getRedis();
  if (redis) {
    if (on) await redis.set("agent:kill_switch", "on").catch(() => {});
    else await redis.set("agent:kill_switch", "off").catch(() => {});
  }
}

/** Outbound messages we've sent on this thread in the last 24h. */
export async function outboundToday(db: Db, conversationId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "outbound"),
        gte(messages.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * One in-flight agent run per conversation.
 *
 * Backed by a Postgres advisory lock, so it exists whether or not Redis does.
 * Sendivo retries webhooks; without a lock two retries of the same message can
 * run the agent twice and put two drafts — or two sends — on one thread.
 *
 * `pg_try_advisory_lock` is non-blocking and session-scoped, so a function that
 * dies mid-run doesn't strand the lock the way a TTL-less key would.
 */
const lockKey = (conversationId: string) =>
  // hashtext gives a stable 32-bit int from the uuid; advisory locks are keyed
  // by number, not string.
  sql`hashtext(${`agent:run:${conversationId}`})`;

export async function acquireRunLock(conversationId: string, db?: Db): Promise<boolean> {
  const database = db ?? getDb();
  try {
    const [row] = await database.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(${lockKey(conversationId)}) AS locked`,
    );
    return row?.locked === true;
  } catch {
    // A lock we can't take is not a reason to drop a seller's reply on the
    // floor; the dedupe on sendivo_message_id is the backstop.
    return true;
  }
}

export async function releaseRunLock(conversationId: string, db?: Db): Promise<void> {
  const database = db ?? getDb();
  try {
    await database.execute(sql`SELECT pg_advisory_unlock(${lockKey(conversationId)})`);
  } catch {
    // Session-scoped: Postgres drops it when the connection goes anyway.
  }
}

/**
 * How many times the agent has failed dollar-validation on this thread.
 * Two failures escalates (§6) — the model is not allowed a third attempt.
 */
export async function dollarValidationFailures(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentActions)
    .where(and(eq(agentActions.conversationId, conversationId), eq(agentActions.type, "draft_rejected_dollar_validation")));
  return row?.count ?? 0;
}
