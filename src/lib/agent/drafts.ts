import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions } from "@/db/schema";
import type { DraftIntent } from "./negotiation";

/**
 * Pending agent drafts live in `agent_actions` as `draft_created` rows — the
 * design doc's data model has no drafts table, and agent_actions is already the
 * append-only audit trail. A draft is "pending" until a later row
 * (`draft_approved` / `draft_edited` / `draft_rejected`) references its id.
 */

export type PendingDraft = {
  id: string;
  message: string;
  notes: string;
  classification: string;
  /** What this message was for — see negotiation.ts. Older rows have none. */
  intent: DraftIntent;
  authorizedOfferCents: number | null;
  isCeilingOffer: boolean;
  /** The authorized amount is the seller's own asking price, not a counter. */
  meetsSellerAsk: boolean;
  createdAt: Date;
};

const RESOLUTION_TYPES = ["draft_approved", "draft_edited", "draft_rejected"] as const;

export async function getPendingDraft(db: Db, conversationId: string): Promise<PendingDraft | null> {
  const row = await db.query.agentActions.findFirst({
    where: and(
      eq(agentActions.conversationId, conversationId),
      eq(agentActions.type, "draft_created"),
      sql`NOT EXISTS (
        SELECT 1 FROM ${agentActions} resolution
        WHERE resolution.type IN (${sql.join(
          RESOLUTION_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})
        AND resolution.input->>'draftId' = ${agentActions.id}::text
      )`,
    ),
    orderBy: desc(agentActions.createdAt),
  });
  if (!row) return null;

  const output = (row.output ?? {}) as { message?: string; notes?: string };
  const input = (row.input ?? {}) as {
    classification?: string;
    intent?: string;
    authorizedOfferCents?: number | null;
    isCeilingOffer?: boolean;
    meetsSellerAsk?: boolean;
  };
  if (!output.message) return null;

  return {
    id: row.id,
    message: output.message,
    notes: output.notes ?? "",
    classification: input.classification ?? "unknown",
    // Rows written before intents existed carried an amount iff they were an
    // offer, so that's how they're read back.
    intent: isDraftIntent(input.intent) ? input.intent : input.authorizedOfferCents != null ? "offer" : "reply",
    authorizedOfferCents: input.authorizedOfferCents ?? null,
    isCeilingOffer: Boolean(input.isCeilingOffer),
    meetsSellerAsk: Boolean(input.meetsSellerAsk),
    createdAt: row.createdAt,
  };
}

const DRAFT_INTENTS: DraftIntent[] = ["reply", "probe", "offer", "nudge", "partner_bump"];

function isDraftIntent(value: unknown): value is DraftIntent {
  return typeof value === "string" && (DRAFT_INTENTS as string[]).includes(value);
}

/**
 * Whether approving this draft should write a new offer row. A nudge restates
 * a price we already recorded — recording it again would stack duplicate offer
 * versions at the same amount.
 */
export function putsANewPriceOnTheTable(draft: PendingDraft): boolean {
  return draft.authorizedOfferCents != null && (draft.intent === "offer" || draft.intent === "partner_bump");
}

/** Append the resolution row. Approve/edit are distinguished for edit-rate tracking (§12). */
export async function recordDraftResolution(
  db: Db,
  params: {
    conversationId: string;
    draftId: string;
    resolution: "approved" | "edited" | "rejected";
    originalMessage: string;
    finalMessage?: string;
    rejectionReason?: string;
  },
): Promise<void> {
  await db.insert(agentActions).values({
    conversationId: params.conversationId,
    type: `draft_${params.resolution}`,
    input: { draftId: params.draftId, original: params.originalMessage },
    output: {
      final: params.finalMessage,
      // Rejection reasons are the raw material for prompt tuning in September (§12).
      reason: params.rejectionReason,
    },
    approvedBy: params.resolution === "rejected" ? undefined : "marlon",
  });
}
