import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, builders, campaigns, contacts, contracts, deals, offers, parcels, titleCompanies } from "@/db/schema";
import { env } from "@/env";
import { sendUrgentAlert } from "@/lib/alerts";
import { formatMoney } from "@/lib/format";
import { getCompletedPdf } from "@/lib/signwell/client";
import { composeTitleEmail, resolveTitleCompany, type TitleCompanyRef } from "./title-routing";

/**
 * Title routing (design doc §9): one email with both signed PDFs, CC'd to the
 * builder and Marlon, logged. A delivery failure pings Marlon by SMS — a
 * closing that silently never reached title is the worst failure in the chain.
 */

export type TitleEmailResult = { ok: true; to: string[]; source: string } | { ok: false; reason: string };

const toRef = (row: typeof titleCompanies.$inferSelect | null | undefined): TitleCompanyRef | null =>
  row ? { id: row.id, name: row.name, emails: row.emails, state: row.state, isDefaultFl: row.isDefaultFl } : null;

export async function routeToTitle(db: Db, dealId: string): Promise<TitleEmailResult> {
  const apiKey = env().RESEND_API_KEY;
  const from = env().TITLE_EMAIL_FROM;
  if (!apiKey || !from) return { ok: false, reason: "RESEND_API_KEY / TITLE_EMAIL_FROM not configured" };

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  if (!deal?.parcelId) return { ok: false, reason: "deal or parcel missing" };

  const [parcel, contact, campaign] = await Promise.all([
    db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) }),
    db.query.contacts.findFirst({ where: eq(contacts.id, deal.contactId) }),
    deal.campaignId ? db.query.campaigns.findFirst({ where: eq(campaigns.id, deal.campaignId) }) : null,
  ]);
  if (!parcel) return { ok: false, reason: "parcel missing" };

  const builder = campaign?.builderId ? await db.query.builders.findFirst({ where: eq(builders.id, campaign.builderId) }) : null;

  const [builderPreferred, campaignSpecified, floridaDefault] = await Promise.all([
    builder?.preferredTitleCompanyId
      ? db.query.titleCompanies.findFirst({ where: eq(titleCompanies.id, builder.preferredTitleCompanyId) })
      : null,
    campaign?.titleCompanyId ? db.query.titleCompanies.findFirst({ where: eq(titleCompanies.id, campaign.titleCompanyId) }) : null,
    db.query.titleCompanies.findFirst({ where: eq(titleCompanies.isDefaultFl, true) }),
  ]);

  const routing = resolveTitleCompany({
    builderPreferred: toRef(builderPreferred),
    sellerSpecified: toRef(campaignSpecified),
    floridaDefault: toRef(floridaDefault),
  });
  if (!routing.ok) {
    await alertFailure(db, `title routing failed for ${parcel.address ?? parcel.parcelId}: ${routing.reason}`);
    return { ok: false, reason: routing.reason };
  }

  const [latestOffer] = await db.select().from(offers).where(eq(offers.dealId, dealId)).orderBy(desc(offers.version)).limit(1);
  const email = composeTitleEmail({
    propertyAddress: parcel.address ?? parcel.parcelId,
    county: parcel.county,
    sellerName: contact?.name ?? "(seller)",
    builderEntity: builder?.entityName ?? builder?.name ?? "(builder)",
    price: latestOffer ? formatMoney(latestOffer.amount) : "(see agreement)",
  });

  // Both signed PDFs, fetched fresh from SignWell.
  const signed = await db.query.contracts.findMany({ where: eq(contracts.dealId, dealId) });
  const attachments: { filename: string; content: string }[] = [];
  for (const contract of signed.filter((c) => c.signwellDocumentId && c.status === "completed")) {
    try {
      const pdf = await getCompletedPdf(contract.signwellDocumentId!);
      attachments.push({ filename: `${contract.kind}-${parcel.parcelId}.pdf`, content: pdf.toString("base64") });
    } catch (error) {
      console.warn(`[title-email] could not fetch ${contract.kind} pdf`, error);
    }
  }

  const cc = [builder?.email, env().MARLON_EMAIL].filter((v): v is string => Boolean(v));

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: routing.company.emails,
      cc: cc.length ? cc : undefined,
      subject: email.subject,
      text: email.body,
      attachments: attachments.length ? attachments : undefined,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    await db.insert(agentActions).values({
      type: "title_email_failed",
      input: { dealId, to: routing.company.emails },
      output: { detail },
    });
    await alertFailure(db, `title email FAILED for ${parcel.address ?? parcel.parcelId}: ${detail}`);
    return { ok: false, reason: detail };
  }

  await db.insert(agentActions).values({
    type: "title_email_sent",
    input: { dealId, to: routing.company.emails, cc, source: routing.source },
    output: { attachments: attachments.length },
  });
  await db.update(deals).set({ stage: "closed", updatedAt: new Date() }).where(eq(deals.id, dealId));

  return { ok: true, to: routing.company.emails, source: routing.source };
}

async function alertFailure(db: Db, message: string) {
  await sendUrgentAlert(db, { type: "title_email_failed", message: `⚠️ ${message}` });
}
