import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { getRedis } from "@/lib/redis";

/**
 * Guardrails that live in code, never in the prompt (design doc §6).
 * The opt-out gate and quiet hours are enforced at send time in
 * lib/sendivo/send.ts; these are the agent-specific limits.
 */

export const THREAD_DAILY_CAP = 3;

/** Global kill switch — flips every conversation to approval-only, instantly. */
export async function isKillSwitchOn(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.get<string>("agent:kill_switch").catch(() => null)) === "on";
}

export async function setKillSwitch(on: boolean): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("kill switch requires Redis (UPSTASH_REDIS_REST_* not configured)");
  if (on) await redis.set("agent:kill_switch", "on");
  else await redis.del("agent:kill_switch");
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
 * Redis send-lock: one in-flight agent run per conversation. Without Redis we
 * degrade to no lock — acceptable at two users, and stated plainly here rather
 * than pretending the lock exists.
 */
export async function acquireRunLock(conversationId: string, ttlSeconds = 60): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const acquired = await redis
    .set(`agent:lock:${conversationId}`, "1", { nx: true, ex: ttlSeconds })
    .catch(() => null);
  return acquired === "OK";
}

export async function releaseRunLock(conversationId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`agent:lock:${conversationId}`).catch(() => {});
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
