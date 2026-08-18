"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { isCountyKey } from "@/adapters/registry";
import { getDb } from "@/db";
import { agentActions, contactParcels, contacts, conversations, deals, offers, parcels } from "@/db/schema";
import { attachParcelToDeal } from "@/lib/deals/attach-parcel";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";
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

/**
 * Parcel management on a deal (§2.1 amendment, Aug 15 2026).
 *
 * A seller and their land are two different relationships, and the schema has
 * always modelled them separately: `contact_parcels` is every lot a contact is
 * on record as owning (many-to-many), while `deals.parcel_id` is the single lot
 * *this* negotiation is about. Until now only the second had a UI, so a wrong
 * match was unfixable and a seller with three lots could only ever show one.
 */

/** Take the parcel off a deal without forgetting that the contact owns it. */
export async function detachParcelAction(dealId: string) {
  await requireSession();
  const db = getDb();

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { ok: false as const, reason: "deal not found" };
  if (!deal.parcelId) return { ok: false as const, reason: "no parcel attached" };

  // Clearing the parcel clears everything derived from it. The verdict, the
  // matched buyer and the ceiling were all computed for *that* lot; leaving
  // them behind would let the agent price a deal against land it is no longer
  // about — the one mistake this system must never make.
  await db
    .update(deals)
    .set({
      parcelId: null,
      verdict: "pending",
      matchedBuilderId: null,
      maxOffer: null,
      anchor: null,
      ...(deal.stage === "verified" ? { stage: "qualifying" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId));

  await db.insert(agentActions).values({
    type: "parcel_detached",
    input: { dealId, parcelRowId: deal.parcelId, clearedOffer: deal.maxOffer },
  });

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return { ok: true as const };
}

/**
 * Record that a contact owns a lot, without making it the deal's subject.
 * This is how "they mentioned they have two others" gets captured.
 */
export async function linkParcelToContactAction(contactId: string, county: string, parcelId: string) {
  await requireSession();
  if (!isCountyKey(county)) return { ok: false as const, reason: "unknown county" };

  const db = getDb();
  const verified = await verifyParcel(db, county, parcelId.trim(), null);
  if (!verified) return { ok: false as const, reason: `parcel not found in ${county} records` };

  await db
    .insert(contactParcels)
    .values({ contactId, parcelId: verified.parcelRowId, relationship: "claimed" })
    .onConflictDoNothing();

  revalidatePath("/deal-room");
  revalidatePath("/sellers");
  return { ok: true as const, address: verified.parcel.address ?? verified.parcel.parcelId };
}

/** Forget that a contact owns a lot. The parcel itself stays in the land bank. */
export async function unlinkParcelFromContactAction(contactId: string, parcelRowId: string) {
  await requireSession();
  const db = getDb();

  await db
    .delete(contactParcels)
    .where(and(eq(contactParcels.contactId, contactId), eq(contactParcels.parcelId, parcelRowId)));

  // A deal pointed at the lot we just disowned would be negotiating over land
  // this seller isn't on record for.
  const affected = await db.query.deals.findFirst({
    where: and(eq(deals.contactId, contactId), eq(deals.parcelId, parcelRowId)),
  });
  if (affected) await detachParcelAction(affected.id);

  revalidatePath("/deal-room");
  revalidatePath("/sellers");
  return { ok: true as const };
}

/**
 * Point the deal at a different lot the contact already owns — the "we're
 * actually talking about the other one" move. Re-runs eligibility, so the
 * numbers always belong to the lot on screen.
 */
export async function setDealParcelAction(dealId: string, county: string, parcelId: string) {
  await requireSession();
  if (!isCountyKey(county)) return { ok: false as const, reason: "unknown county" };

  const db = getDb();
  const result = await attachParcelToDeal(db, dealId, county, parcelId);
  if (!result.ok) return { ok: false as const, reason: result.reason };

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return { ok: true as const, verdict: result.verdict, matchedBuilder: result.matchedBuilder };
}

/** Labels on a contact — free-form tagging (§2.2). */
export async function setContactLabelsAction(contactId: string, labels: string[]) {
  await requireSession();
  const db = getDb();

  const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].slice(0, 20);
  await db.update(contacts).set({ labels: cleaned, updatedAt: new Date() }).where(eq(contacts.id, contactId));

  revalidatePath("/deal-room");
  revalidatePath("/sellers");
  return { ok: true as const, labels: cleaned };
}

/**
 * Set a parcel's utilities by hand.
 *
 * Charlotte and St. Lucie publish no water/sewer service-area layer — verified
 * against both counties' own data catalogs — so outside Lee this is how the
 * answer gets in when the seller has told us, or when Marlon simply knows.
 * Recorded with its source so the context card can say where it came from.
 */
export async function setParcelUtilitiesAction(
  parcelRowId: string,
  water: "city" | "well" | null,
  sewer: "city" | "septic" | null,
) {
  await requireSession();
  const db = getDb();

  await db
    .update(parcels)
    .set({
      waterSource: water,
      sewerType: sewer,
      utilityDetail: water || sewer ? "entered by hand" : null,
      updatedAt: new Date(),
    })
    .where(eq(parcels.id, parcelRowId));

  await db.insert(agentActions).values({
    type: "utilities_set_manually",
    input: { parcelRowId },
    output: { water, sewer },
  });

  revalidatePath("/deal-room");
  revalidatePath("/land-bank");
  return { ok: true as const };
}

/**
 * Hand an escalated thread back to the agent.
 *
 * Escalation was a one-way door: `escalated` was set and nothing anywhere ever
 * cleared it, so a thread Marlon had already dealt with stayed in the queue
 * forever. Now that escalations are rare and mean something, being unable to
 * clear them is what makes the queue untrustworthy.
 *
 * The state goes back to where the conversation actually is, not to NEW — a
 * thread escalated mid-negotiation resumes negotiating.
 */
export async function resolveEscalationAction(
  conversationId: string,
  resume: "QUALIFYING" | "NEGOTIATING" | "OFFER_SENT" = "QUALIFYING",
) {
  await requireSession();
  const db = getDb();

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) return { ok: false as const, reason: "conversation not found" };
  if (!conversation.escalated) return { ok: false as const, reason: "this thread isn't escalated" };

  await db
    .update(conversations)
    .set({ escalated: false, escalationReason: null, state: resume, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await db.insert(agentActions).values({
    conversationId,
    type: "escalation_resolved",
    input: { was: conversation.escalationReason, resumedAt: resume },
    approvedBy: "marlon",
  });

  revalidatePath("/deal-room");
  return { ok: true as const };
}

/**
 * Move a deal's stage by hand, and record the money when it closes.
 *
 * The lifecycle previously dead-ended: contracts pushed a deal to
 * `under_contract` and nothing on any screen could move it further. `closed`
 * was never set anywhere, `assignment_fee` and `closed_at` were never written,
 * and the Closings page was therefore wired to data no code path could produce.
 * A deal that funded in real life had nowhere to be recorded.
 *
 * The fee is required to close because it is the number the business is
 * measured by — a closed deal with no fee would quietly report a month as
 * earning nothing.
 */
const DEAL_STAGES = [
  "lead",
  "qualifying",
  "verified",
  "offer",
  "negotiating",
  "accepted",
  "under_contract",
  "closed",
  "dead",
] as const;

export async function setDealStageAction(
  dealId: string,
  stage: string,
  extra?: { assignmentFee?: string; closedAt?: string; deadReason?: string },
) {
  await requireSession();
  if (!(DEAL_STAGES as readonly string[]).includes(stage)) {
    return { ok: false as const, reason: "unknown stage" };
  }

  const db = getDb();
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { ok: false as const, reason: "deal not found" };

  const patch: Record<string, unknown> = { stage, updatedAt: new Date() };

  if (stage === "closed") {
    const fee = Number(String(extra?.assignmentFee ?? "").replace(/[$,\s]/g, ""));
    if (!Number.isFinite(fee) || fee <= 0) {
      return { ok: false as const, reason: "what did you make on it? the assignment fee is required to close" };
    }
    patch.assignmentFee = fee.toFixed(2);
    // Funding date defaults to today; a backdated close is normal when the
    // wire lands before anyone updates the CRM.
    const when = extra?.closedAt ? new Date(`${extra.closedAt}T12:00:00`) : new Date();
    if (Number.isNaN(when.getTime())) return { ok: false as const, reason: "that closing date isn't valid" };
    patch.closedAt = when;
    if (!deal.closingDate) patch.closingDate = when;
  }

  if (stage === "dead") patch.deadReason = extra?.deadReason?.trim() || "closed by hand";

  await db.update(deals).set(patch).where(eq(deals.id, dealId));
  await db.insert(agentActions).values({
    type: "deal_stage_set",
    input: { dealId, from: deal.stage, to: stage },
    output: { assignmentFee: patch.assignmentFee ?? null, closedAt: patch.closedAt ?? null },
    approvedBy: "marlon",
  });

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  revalidatePath("/closings");
  return { ok: true as const };
}

/**
 * Put a deal on a campaign by hand.
 *
 * The campaign supplies the buy boxes, so a deal without one can never be
 * priced. New deals adopt the single running campaign automatically; this is
 * for the case where several are running and the right one has to be chosen.
 */
export async function setDealCampaignAction(dealId: string, campaignId: string | null) {
  await requireSession();
  const db = getDb();

  await db
    .update(deals)
    .set({ campaignId: campaignId || null, updatedAt: new Date() })
    .where(eq(deals.id, dealId));

  // The verdict was computed against the old campaign's buyers, so re-run
  // eligibility rather than leaving a stale pass/fail on screen.
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (deal?.parcelId) {
    const parcel = await db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) });
    if (parcel && isCountyKey(parcel.county)) {
      await attachParcelToDeal(db, dealId, parcel.county, parcel.parcelId);
    }
  }

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return { ok: true as const };
}
