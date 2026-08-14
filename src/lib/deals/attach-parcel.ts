import { eq } from "drizzle-orm";
import { isCountyKey } from "@/adapters/registry";
import type { CountyKey } from "@/adapters/types";
import type { Db } from "@/db";
import { agentActions, deals } from "@/db/schema";
import { bestMatch } from "@/lib/eligibility/match-builders";
import { fromCents } from "@/lib/eligibility/offer-math";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";
import { parcelsForContact } from "@/lib/lists/import";

/**
 * Attaching a county-verified parcel to a deal — the step that turns "someone
 * replied" into "we know what land this is and what it's worth."
 *
 * Shared by the Deal Room's manual attach and the automatic resolution that
 * runs on first inbound, so both paths compute the numbers the same way.
 */

export type AttachResult =
  | { ok: true; verdict: "pass" | "fail" | "pending"; matchedBuilder: string | null; buyersConsidered: number }
  | { ok: false; reason: string };

export async function attachParcelToDeal(
  db: Db,
  dealId: string,
  county: CountyKey,
  parcelId: string,
): Promise<AttachResult> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { ok: false, reason: "deal not found" };

  const result = await verifyParcel(db, county, parcelId.trim(), deal.campaignId ?? null);
  if (!result) return { ok: false, reason: `parcel not found in ${county} records` };

  // The numbers follow whichever buyer the lot actually matched — max offer is
  // that buyer's price minus their fee floor, not a campaign-wide constant.
  const best = bestMatch(result.matches);
  const numbers = best
    ? {
        matchedBuilderId: best.builderId,
        maxOffer: fromCents(best.maxOfferCents),
        anchor: fromCents(best.anchorCents),
      }
    : { matchedBuilderId: null };

  await db
    .update(deals)
    .set({
      parcelId: result.parcelRowId,
      verdict: result.verdict,
      // A passing verdict moves the deal forward on the pipeline, but never
      // backwards from a stage it has already reached.
      ...(result.verdict === "pass" && (deal.stage === "lead" || deal.stage === "qualifying")
        ? { stage: "verified" as const }
        : {}),
      ...numbers,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId));

  return {
    ok: true,
    verdict: result.verdict,
    matchedBuilder: best?.builderName ?? null,
    buyersConsidered: result.matches.length,
  };
}

/**
 * Resolve a fresh lead's lot from the imported list instead of waiting for
 * Marlon to type a parcel id.
 *
 * Only fires when the contact is on record as owning **exactly one** lot. A
 * seller with several parcels is genuinely ambiguous — "are you interested in
 * selling?" doesn't say which one — and picking for them would run flood,
 * wetlands, and a price against land they weren't talking about. Those threads
 * stay manual, which is what `contact_parcels` being many-to-many is for.
 */
export async function autoAttachFromList(
  db: Db,
  dealId: string,
  contactId: string,
  conversationId?: string,
): Promise<{ attached: boolean; reason: string }> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { attached: false, reason: "deal not found" };
  if (deal.parcelId) return { attached: false, reason: "deal already has a parcel" };

  const owned = await parcelsForContact(db, contactId);
  if (owned.length === 0) return { attached: false, reason: "contact has no linked parcel" };
  if (owned.length > 1) {
    await db.insert(agentActions).values({
      conversationId,
      type: "parcel_auto_attach_skipped",
      input: { dealId, contactId },
      output: { reason: "multiple linked parcels", parcels: owned.map((p) => p.parcelId) },
    });
    return { attached: false, reason: `${owned.length} linked parcels — needs a human` };
  }

  const only = owned[0];
  if (!isCountyKey(only.county)) return { attached: false, reason: `no adapter for county ${only.county}` };

  const result = await attachParcelToDeal(db, dealId, only.county, only.parcelId);
  // Auto-attach sets the deal's money, so it goes in the audit trail either way.
  await db.insert(agentActions).values({
    conversationId,
    type: result.ok ? "parcel_auto_attached" : "parcel_auto_attach_failed",
    input: { dealId, county: only.county, parcelId: only.parcelId, source: "imported_list" },
    output: result.ok
      ? { verdict: result.verdict, matchedBuilder: result.matchedBuilder, buyersConsidered: result.buyersConsidered }
      : { reason: result.reason },
  });

  return result.ok
    ? { attached: true, reason: `verdict ${result.verdict}` }
    : { attached: false, reason: result.reason };
}
