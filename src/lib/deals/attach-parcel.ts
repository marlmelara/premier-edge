import { eq } from "drizzle-orm";
import { getAdapter, isCountyKey, listCounties } from "@/adapters/registry";
import type { CountyKey } from "@/adapters/types";
import type { Db } from "@/db";
import { agentActions, contactParcels, contacts, deals } from "@/db/schema";
import { bestMatch } from "@/lib/eligibility/match-builders";
import { fromCents } from "@/lib/eligibility/offer-math";
import { verifyParcel } from "@/lib/eligibility/verify-parcel";
import { parcelsForContact } from "@/lib/lists/import";
import { pickConfidentMatch, searchTermFor } from "@/lib/lists/address";

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

  // Attaching a lot to a deal asserts this seller owns it, so record the
  // ownership too. Without this the contact's lot list stays empty even while
  // a parcel is plainly attached, and a re-attach later has nothing to offer.
  await db
    .insert(contactParcels)
    .values({ contactId: deal.contactId, parcelId: result.parcelRowId, relationship: "claimed" })
    .onConflictDoNothing();

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

  let owned = await parcelsForContact(db, contactId);

  // Nothing on file yet? Sendivo's own contact record carries the property
  // address (pulled by the first-inbound enrichment and kept in sendivo_raw),
  // so resolve it against the county appraiser before giving up. This is the
  // difference between a thread that arrives knowing what land it is about and
  // one that sits waiting for someone to type a parcel id.
  if (owned.length === 0) {
    const resolved = await resolveFromSendivoAddress(db, contactId, conversationId);
    if (resolved) owned = await parcelsForContact(db, contactId);
  }

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

/**
 * Resolve a contact's lot from the property address Sendivo already holds.
 *
 * Every Sendivo contact carries `property_address` / `property_city` from the
 * list that was uploaded there, and the first-inbound enrichment stores the
 * whole payload in `contacts.sendivo_raw`. Until now that address was only
 * *displayed* as a hint on the context card — the schema comment has said
 * "seeds M1 parcel resolution" since day one, and nothing did it.
 *
 * The county appraiser is the authority for turning an address into a parcel
 * id, and it is already wired up per county. That makes a third-party lookup
 * unnecessary: the GIS layers are the same records a consumer site is derived
 * from, they are free, and they carry the geometry that flood and wetlands
 * checks need anyway.
 *
 * Matching is exact-only (lib/lists/address.ts) and must be unambiguous across
 * every county we support. A near miss is the neighbour's lot, and a lot that
 * matches in two counties is a coin flip — both are left for a human.
 */
async function resolveFromSendivoAddress(
  db: Db,
  contactId: string,
  conversationId?: string,
): Promise<boolean> {
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  const raw = contact?.sendivoRaw;
  if (!raw || typeof raw !== "object") return false;

  const enrichment = raw as Record<string, unknown>;
  const address = typeof enrichment.property_address === "string" ? enrichment.property_address : null;
  if (!address) return false;

  const term = searchTermFor({ propertyAddress: address });
  if (!term) return false;

  const hits: { county: CountyKey; parcelId: string; address?: string }[] = [];
  for (const county of listCounties()) {
    try {
      const candidates = await getAdapter(county).searchByAddress(term);
      const match = pickConfidentMatch(address, candidates);
      if (match.matched) hits.push({ county, parcelId: match.parcel.parcelId, address: match.parcel.address });
    } catch {
      // One county's GIS being down must not stop the others from answering.
    }
  }

  if (hits.length !== 1) {
    await db.insert(agentActions).values({
      conversationId,
      type: "parcel_address_resolve_skipped",
      input: { contactId, address },
      output: { reason: hits.length === 0 ? "no confident match" : `matched in ${hits.length} counties`, hits },
    });
    return false;
  }

  const [hit] = hits;
  const verified = await verifyParcel(db, hit.county, hit.parcelId, null);
  if (!verified) return false;

  await db
    .insert(contactParcels)
    .values({ contactId, parcelId: verified.parcelRowId, relationship: "claimed" })
    .onConflictDoNothing();

  await db.insert(agentActions).values({
    conversationId,
    type: "parcel_resolved_from_address",
    input: { contactId, address, source: "sendivo_enrichment" },
    output: { county: hit.county, parcelId: hit.parcelId, matchedAddress: hit.address },
  });

  return true;
}
