import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, campaigns, conversations, deals } from "@/db/schema";
import type { DraftIntent } from "./negotiation";

/**
 * The autonomy ladder (design doc §12).
 *
 * `campaigns.autonomy` has existed as an unused jsonb column since the schema
 * was written; the September plan — graduate to auto-send at <10% edit rate
 * over 50–100 sends, per campaign, reversible — had no code path at all.
 *
 * The shape of the rule matters more than the threshold. Autonomy is granted
 * **per intent**, not per campaign wholesale, because the intents carry wildly
 * different risk: a probe asks a question and can be wrong harmlessly, while an
 * offer commits money. Earning trust on probes should never silently buy trust
 * on prices.
 */

/** Intents that may ever graduate. Everything else stays human-approved forever. */
export const GRADUATABLE: DraftIntent[] = ["probe", "utility_probe", "nudge"];

/**
 * Never automatic, whatever the numbers say (§6):
 * - `offer` and `partner_bump` commit money.
 * - `reply` is the catch-all for messages the policy didn't shape.
 * A ceiling-priced offer is excluded twice over, here and at the send.
 */
export const NEVER_AUTOMATIC: DraftIntent[] = ["offer", "partner_bump", "reply"];

export const MIN_SENDS_BEFORE_GRADUATION = 50;
export const MAX_EDIT_RATE = 0.1;

export type AutonomySettings = {
  /** Intents Marlon has switched on. Empty means fully copilot. */
  enabled: DraftIntent[];
};

export type IntentPerformance = {
  intent: DraftIntent;
  approved: number;
  edited: number;
  rejected: number;
  sends: number;
  editRate: number | null;
  /** Whether the numbers justify graduating — not whether it's switched on. */
  eligible: boolean;
};

export function readAutonomy(raw: unknown): AutonomySettings {
  if (!raw || typeof raw !== "object") return { enabled: [] };
  const enabled = (raw as { enabled?: unknown }).enabled;
  if (!Array.isArray(enabled)) return { enabled: [] };
  return {
    enabled: enabled.filter((i): i is DraftIntent => GRADUATABLE.includes(i as DraftIntent)),
  };
}

/**
 * Whether a specific draft may send itself.
 *
 * Three independent gates, all of which must pass: the intent is one that can
 * ever graduate, Marlon has switched it on for this campaign, and the draft
 * carries no money. The last is belt-and-braces — a probe should never have an
 * authorized amount — but a bug that let one through would auto-send a price.
 */
export function mayAutoSend(params: {
  intent: DraftIntent;
  autonomy: AutonomySettings;
  authorizedOfferCents: number | null;
  isCeilingOffer: boolean;
}): boolean {
  if (NEVER_AUTOMATIC.includes(params.intent)) return false;
  if (!GRADUATABLE.includes(params.intent)) return false;
  if (!params.autonomy.enabled.includes(params.intent)) return false;
  if (params.authorizedOfferCents != null) return false;
  if (params.isCeilingOffer) return false;
  return true;
}

/**
 * Per-intent edit rate for a campaign — the evidence behind graduating.
 *
 * Rejections count against the rate as well as edits. A draft Marlon threw away
 * is a worse outcome than one he fixed, and a metric that ignored them could
 * show 0% edits on an intent that never once produced a usable message.
 */
export async function intentPerformance(db: Db, campaignId: string): Promise<IntentPerformance[]> {
  const rows = await db
    .select({
      intent: sql<string>`d.input->>'intent'`,
      approved: sql<number>`COUNT(*) FILTER (WHERE r.type = 'draft_approved')::int`,
      edited: sql<number>`COUNT(*) FILTER (WHERE r.type = 'draft_edited')::int`,
      rejected: sql<number>`COUNT(*) FILTER (WHERE r.type = 'draft_rejected')::int`,
    })
    .from(sql`${agentActions} d`)
    .innerJoin(sql`${agentActions} r`, sql`r.input->>'draftId' = d.id::text`)
    .innerJoin(conversations, sql`${conversations.id} = d.conversation_id`)
    .innerJoin(deals, eq(conversations.dealId, deals.id))
    .where(and(sql`d.type = 'draft_created'`, eq(deals.campaignId, campaignId)))
    .groupBy(sql`d.input->>'intent'`);

  return GRADUATABLE.map((intent) => {
    const row = rows.find((r) => r.intent === intent);
    const approved = row?.approved ?? 0;
    const edited = row?.edited ?? 0;
    const rejected = row?.rejected ?? 0;
    const sends = approved + edited;
    const decided = sends + rejected;
    const editRate = decided > 0 ? (edited + rejected) / decided : null;
    return {
      intent,
      approved,
      edited,
      rejected,
      sends,
      editRate,
      eligible: sends >= MIN_SENDS_BEFORE_GRADUATION && editRate !== null && editRate < MAX_EDIT_RATE,
    };
  });
}

export async function campaignAutonomy(db: Db, campaignId: string): Promise<AutonomySettings> {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  return readAutonomy(campaign?.autonomy);
}
