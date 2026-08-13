"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { isCountyKey } from "@/adapters/registry";
import { getDb } from "@/db";
import { criteriaSets, deals } from "@/db/schema";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";
import { anchorOffer, fromCents, maxOffer, toCents } from "@/lib/eligibility/offer-math";
import { sendSellerMessage } from "@/lib/sendivo/send";

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
 * Attach a county-verified parcel to a deal: runs the eligibility pipeline,
 * links the parcel, sets the verdict, and — when the deal's campaign has a
 * criteria set — recomputes max offer + anchor (denormalized on the deal,
 * never hand-typed; §5).
 */
export async function attachParcelAction(dealId: string, county: string, parcelId: string) {
  await requireSession();
  if (!isCountyKey(county)) return { ok: false as const, reason: "unknown county" };

  const db = getDb();
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { ok: false as const, reason: "deal not found" };

  const campaign = deal.campaignId
    ? await db.query.campaigns.findFirst({ where: (c, { eq: eqf }) => eqf(c.id, deal.campaignId!) })
    : null;
  const criteria = campaign?.criteriaId
    ? await db.query.criteriaSets.findFirst({ where: eq(criteriaSets.id, campaign.criteriaId) })
    : null;

  const verifyCriteria = criteria
    ? {
        minSqft: criteria.minSqft,
        allowedFloodZones: criteria.allowedFloodZones,
        wetlandsAllowed: criteria.wetlandsAllowed,
      }
    : { minSqft: 10_000, allowedFloodZones: ["X"], wetlandsAllowed: false };

  const result = await verifyParcel(db, county, parcelId.trim(), verifyCriteria);
  if (!result) return { ok: false as const, reason: `parcel not found in ${county} records` };

  const numbers = criteria
    ? (() => {
        const oc = {
          builderBuyPrice: toCents(criteria.builderBuyPrice),
          minAssignmentFee: toCents(criteria.minAssignmentFee),
          anchorPct: Number(criteria.anchorPct),
          concessionSteps: Array.isArray(criteria.concessionSteps) ? (criteria.concessionSteps as number[]) : undefined,
        };
        return { maxOffer: fromCents(maxOffer(oc)), anchor: fromCents(anchorOffer(oc)) };
      })()
    : {};

  await db
    .update(deals)
    .set({ parcelId: result.parcelRowId, verdict: result.verdict, ...numbers, updatedAt: new Date() })
    .where(eq(deals.id, dealId));

  revalidatePath("/deal-room");
  revalidatePath("/pipeline");
  return { ok: true as const, verdict: result.verdict };
}
