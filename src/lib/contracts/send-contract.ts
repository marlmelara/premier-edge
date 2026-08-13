import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, builders, contacts, contracts, deals, offers, parcels } from "@/db/schema";
import { env } from "@/env";
import { sendUrgentAlert } from "@/lib/alerts";
import { createDocumentFromTemplate, SignWellError } from "@/lib/signwell/client";
import { formatMoney } from "@/lib/format";
import { crossCheckOwner } from "./owner-xcheck";

/**
 * Contract generation (design doc §8). Every field comes from the
 * county-verified parcel and the accepted offer snapshot — never from anything
 * the seller typed. Single-seller deals are fully templated; anything the
 * owner cross-check flags is created as a SignWell *draft* for Marlon to
 * review rather than sent (§6: never auto — multi-seller, owner mismatches).
 */

export type SendContractResult =
  | { ok: true; contractId: string; signwellDocumentId: string; sentForSignature: boolean; xcheckReason: string }
  | { ok: false; reason: string };

function templateFor(kind: "psa" | "assignment"): { templateId?: string; recipientRole: string } {
  const e = env();
  return kind === "psa"
    ? { templateId: e.SIGNWELL_PSA_TEMPLATE_ID, recipientRole: e.SIGNWELL_PSA_SELLER_ROLE ?? "Seller" }
    : { templateId: e.SIGNWELL_ASSIGNMENT_TEMPLATE_ID, recipientRole: e.SIGNWELL_ASSIGNMENT_BUYER_ROLE ?? "Assignee" };
}

export async function sendContract(db: Db, dealId: string, kind: "psa" | "assignment"): Promise<SendContractResult> {
  const { templateId, recipientRole } = templateFor(kind);
  if (!templateId) return { ok: false, reason: `SignWell ${kind.toUpperCase()} template id not configured` };

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal) return { ok: false, reason: "deal not found" };
  if (deal.verdict !== "pass") return { ok: false, reason: "parcel has not passed eligibility" };
  if (!deal.parcelId) return { ok: false, reason: "no verified parcel linked to this deal" };

  const [parcel, contact] = await Promise.all([
    db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, deal.contactId) }),
  ]);
  if (!parcel || !contact) return { ok: false, reason: "parcel or contact missing" };

  // Price comes from the immutable accepted-offer snapshot, not the deal row.
  const [latestOffer] = await db
    .select()
    .from(offers)
    .where(eq(offers.dealId, dealId))
    .orderBy(desc(offers.version))
    .limit(1);
  if (!latestOffer) return { ok: false, reason: "no offer on record to contract against" };

  const xcheck = crossCheckOwner(contact.name, parcel.ownerNameRaw);

  // Recipient differs by contract: the PSA is signed by the seller, the
  // assignment by the builder taking it over.
  let recipientName: string;
  let recipientEmail: string;
  if (kind === "psa") {
    if (!contact.email) return { ok: false, reason: "seller has no email address for e-signature" };
    recipientName = contact.name ?? "Seller";
    recipientEmail = contact.email;
  } else {
    const builder = deal.campaignId
      ? await db.query.campaigns
          .findFirst({ where: (c, { eq: eqf }) => eqf(c.id, deal.campaignId!) })
          .then((c) => (c?.builderId ? db.query.builders.findFirst({ where: eq(builders.id, c.builderId) }) : null))
      : null;
    if (!builder?.email) return { ok: false, reason: "matched builder has no email address" };
    recipientName = builder.entityName ?? builder.name;
    recipientEmail = builder.email;
  }

  const price = latestOffer.amount;
  const fields = [
    { api_id: "property_address", value: parcel.address ?? "" },
    { api_id: "parcel_id", value: parcel.parcelId },
    { api_id: "county", value: parcel.county },
    { api_id: "legal_description", value: parcel.legalDescription ?? "" },
    { api_id: "purchase_price", value: formatMoney(price) },
    { api_id: "seller_name", value: contact.name ?? "" },
    { api_id: "owner_of_record", value: parcel.ownerNameRaw ?? "" },
  ];

  // A flagged cross-check produces a draft, not a send.
  const asDraft = xcheck.requiresHumanApproval;

  let document;
  try {
    document = await createDocumentFromTemplate({
      templateId,
      name: `${kind === "psa" ? "Purchase Agreement" : "Assignment"} — ${parcel.address ?? parcel.parcelId}`,
      subject: kind === "psa" ? "Purchase agreement for your lot" : "Assignment of purchase agreement",
      recipients: [{ id: recipientRole, name: recipientName, email: recipientEmail, sendEmail: !asDraft }],
      fields,
      metadata: { deal_id: dealId, contract_kind: kind },
      draft: asDraft,
      testMode: env().SIGNWELL_TEST_MODE === "true",
    });
  } catch (error) {
    const reason = error instanceof SignWellError ? error.message : String(error);
    await db.insert(agentActions).values({
      type: "contract_send_failed",
      input: { dealId, kind },
      output: { reason },
    });
    await sendUrgentAlert(db, {
      type: "contract_failed",
      message: `⚠️ SignWell ${kind.toUpperCase()} failed for ${parcel.address ?? parcel.parcelId}: ${reason}`,
    });
    return { ok: false, reason };
  }

  const [row] = await db
    .insert(contracts)
    .values({
      dealId,
      kind,
      signwellDocumentId: document.id,
      templateUsed: templateId,
      sellers: [{ name: recipientName, email: recipientEmail, role: recipientRole }],
      price,
      status: asDraft ? "draft_pending_review" : (document.status ?? "sent"),
    })
    .returning();

  await db.insert(agentActions).values({
    type: asDraft ? "contract_drafted_for_review" : "contract_sent",
    input: { dealId, kind, xcheck },
    output: { signwellDocumentId: document.id, contractId: row.id },
  });

  if (asDraft) {
    await sendUrgentAlert(db, {
      type: "escalation",
      message: `✍️ ${kind.toUpperCase()} held as draft — ${xcheck.reason}. Review in SignWell before sending.`,
    });
  } else if (kind === "psa") {
    await db.update(deals).set({ stage: "under_contract", updatedAt: new Date() }).where(eq(deals.id, dealId));
  }

  return {
    ok: true,
    contractId: row.id,
    signwellDocumentId: document.id,
    sentForSignature: !asDraft,
    xcheckReason: xcheck.reason,
  };
}
