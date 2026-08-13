import type { Db } from "@/db";
import { agentActions } from "@/db/schema";
import { env } from "@/env";
import { getRedis } from "@/lib/redis";
import { sendSms } from "@/lib/sendivo/client";

/**
 * Notifications to Marlon (design doc §11b).
 *
 * Channel 2 — urgent alerts: fire immediately, never batched. Alerts always
 * send regardless of hour: quiet hours protect sellers, not the owner.
 * `info` severity never texts — it waits for the daily briefing (Channel 1).
 *
 * Anti-spam: same alert type at most once per 15 minutes, coalesced.
 */

export type AlertType =
  | "escalation"
  | "offer_accepted"
  | "contract_signed"
  | "contract_failed"
  | "title_email_failed"
  | "kill_switch"
  | "guardrail_bug"
  | "system_health";

const URGENT_TYPES: AlertType[] = [
  "escalation",
  "offer_accepted",
  "contract_signed",
  "contract_failed",
  "title_email_failed",
  "kill_switch",
  "guardrail_bug",
  "system_health",
];

const THROTTLE_SECONDS = 15 * 60;

export type AlertResult =
  | { sent: true }
  | { sent: false; reason: "not_urgent" | "throttled" | "no_recipient" | "send_failed"; detail?: string };

/**
 * @param conversationId when the alert belongs to a thread, so it lands in that
 *        conversation's audit trail as well as the global one.
 */
export async function sendUrgentAlert(
  db: Db,
  params: { type: AlertType; message: string; conversationId?: string },
): Promise<AlertResult> {
  const log = async (outcome: Record<string, unknown>) => {
    await db.insert(agentActions).values({
      conversationId: params.conversationId,
      type: "alert",
      input: { alertType: params.type, message: params.message },
      output: outcome,
    });
  };

  if (!URGENT_TYPES.includes(params.type)) {
    await log({ sent: false, reason: "not_urgent" });
    return { sent: false, reason: "not_urgent" };
  }

  const to = env().MARLON_PHONE;
  if (!to) {
    await log({ sent: false, reason: "no_recipient" });
    return { sent: false, reason: "no_recipient" };
  }

  // Per-type throttle. Without Redis we send every time rather than silently
  // dropping alerts — missing an escalation is worse than a duplicate text.
  const redis = getRedis();
  if (redis) {
    const key = `alert:throttle:${params.type}`;
    const first = await redis.set(key, "1", { nx: true, ex: THROTTLE_SECONDS }).catch(() => "OK");
    if (first !== "OK") {
      const pending = await redis.incr(`alert:coalesced:${params.type}`).catch(() => 0);
      await log({ sent: false, reason: "throttled", coalesced: pending });
      return { sent: false, reason: "throttled" };
    }
    // Fold in anything suppressed during the previous window.
    const coalescedKey = `alert:coalesced:${params.type}`;
    const suppressed = Number((await redis.get<string>(coalescedKey).catch(() => "0")) ?? 0);
    if (suppressed > 0) {
      params = { ...params, message: `${params.message} (+${suppressed} more since last alert)` };
      await redis.del(coalescedKey).catch(() => {});
    }
  }

  try {
    const result = await sendSms({ to, message: params.message });
    await log({ sent: true, sendivoMessageId: result.message_id });
    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[alerts] send failed", detail);
    await log({ sent: false, reason: "send_failed", detail });
    return { sent: false, reason: "send_failed", detail };
  }
}
