"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { isCountyKey } from "@/adapters/registry";
import { getDb } from "@/db";
import { agentActions, deals, offers } from "@/db/schema";
import { attachParcelToDeal } from "@/lib/deals/attach-parcel";
import { fromCents } from "@/lib/eligibility/offer-math";
import { sendSellerMessage } from "@/lib/sendivo/send";
import { sendUrgentAlert } from "@/lib/alerts";
import { getPendingDraft, putsANewPriceOnTheTable, recordDraftResolution } from "@/lib/agent/drafts";
import { setKillSwitch } from "@/lib/agent/guardrails";
import { formatMoney } from "@/lib/format";

async function requireSession() {
  const session = await auth();
  if (!session?.user) throw new Error("unauthorized");
}

export async function sendMessageAction(conversationId: string, body: string) {
  await requireSession();
  const trimmed = body.trim();
  if (!trimmed) return { ok: false as const, reason: "empty message" };
  if (trimmed.length > 1600) return { ok: false as const, reason: "over 1600 characters" };

  const result = await sendSellerMessage(getDb(), conversationId, trimmed, "marlon");
  revalidatePath("/deal-room");
  return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason, blocked: result.blocked };
}

/**
 * Approve an agent draft (optionally edited) and send it. Approve vs edit is
 * recorded separately — the edit rate is the autonomy-graduation evidence (§12).
 */
export async function resolveDraftAction(
  conversationId: string,
  draftId: string,
  decision: { action: "approve" | "edit"; body: string } | { action: "reject"; reason: string },
) {
  await requireSession();
  const db = getDb();

  const pending = await getPendingDraft(db, conversationId);
  if (!pending || pending.id !== draftId) {
    return { ok: false as const, reason: "this draft was already handled" };
  }

  if (decision.action === "reject") {
    await recordDraftResolution(db, {
      conversationId,
      draftId,
      resolution: "rejected",
      originalMessage: pending.message,
      rejectionReason: decision.reason,
    });
    revalidatePath("/deal-room");
    return { ok: true as const };
  }

  const body = decision.body.trim();
  if (!body) return { ok: false as const, reason: "empty message" };
  if (body.length > 1600) return { ok: false as const, reason: "over 1600 characters" };

  const result = await sendSellerMessage(db, conversationId, body, "agent");
  if (!result.ok) return { ok: false as const, reason: result.reason, blocked: result.blocked };

  await recordDraftResolution(db, {
    conversationId,
    draftId,
    // Compare trimmed to trimmed: a draft that merely ends in whitespace is an
    // approval, not an edit — the edit rate gates autonomy graduation.
    resolution: body === pending.message.trim() ? "approved" : "edited",
    originalMessage: pending.message,
    finalMessage: body,
  });

  // A sent offer becomes an immutable snapshot and updates the deal's numbers.
  // The SMS is already gone, so a failure here must be loud, never silent: an
  // unrecorded offer makes the next turn re-offer the anchor to a seller who
  // has already been quoted.
  // A nudge restates a price already on record, so only a genuinely new number
  // becomes an offer row.
  const newPriceCents = putsANewPriceOnTheTable(pending) ? pending.authorizedOfferCents! : null;
  if (newPriceCents != null) {
    try {
      await recordOffer(db, conversationId, newPriceCents);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await db.insert(agentActions).values({
        conversationId,
        type: "offer_record_failed",
        input: { amountCents: newPriceCents },
        output: { detail },
      });
      await sendUrgentAlert(db, {
        type: "guardrail_bug",
        conversationId,
        message: `⚠️ Offer ${formatMoney(newPriceCents / 100)} was SENT but not recorded: ${detail}. Set the last offer by hand before the agent replies again.`,
      });
      return { ok: false as const, reason: `sent, but the offer failed to record: ${detail}` };
    }
  }

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return { ok: true as const };
}

async function recordOffer(db: ReturnType<typeof getDb>, conversationId: string, amountCents: number) {
  const conversation = await db.query.conversations.findFirst({
    where: (c, { eq: eqf }) => eqf(c.id, conversationId),
  });
  if (!conversation) return;

  const amount = fromCents(amountCents);

  // Version from MAX(version)+1 in SQL, not a row count: counting breaks if any
  // offer is ever removed, and races between two concurrent approvals.
  await db.transaction(async (tx) => {
    await tx.insert(offers).values({
      dealId: conversation.dealId,
      version: sql`(SELECT COALESCE(MAX(${offers.version}), 0) + 1 FROM ${offers} WHERE ${offers.dealId} = ${conversation.dealId})`,
      amount,
      stateAtOffer: conversation.state,
      assumptions: { source: "agent_draft_approved", conversationId },
    });
    await tx
      .update(deals)
      .set({ lastOffer: amount, stage: "offer", updatedAt: new Date() })
      .where(eq(deals.id, conversation.dealId));
  });
}

/** Kill switch (§6): stops the agent from producing new drafts, instantly. */
export async function setKillSwitchAction(on: boolean) {
  await requireSession();
  try {
    await setKillSwitch(on);
    revalidatePath("/deal-room");
    revalidatePath("/campaigns");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Attach a county-verified parcel to a deal: runs the eligibility pipeline,
 * links the parcel, sets the verdict, and — when the deal's campaign has a
 * criteria set — recomputes max offer + anchor (denormalized on the deal,
 * never hand-typed; §5).
 */
export async function attachParcelAction(dealId: string, county: string, parcelId: string) {
  await requireSession();
  if (!isCountyKey(county)) return { ok: false as const, reason: "unknown county" };

  const db = getDb();
  const result = await attachParcelToDeal(db, dealId, county, parcelId);
  if (!result.ok) return { ok: false as const, reason: result.reason };

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return {
    ok: true as const,
    verdict: result.verdict,
    matchedBuilder: result.matchedBuilder,
    buyersConsidered: result.buyersConsidered,
  };
}
