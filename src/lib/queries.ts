import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  agentActions,
  builders,
  campaigns,
  checks,
  contacts,
  contracts,
  conversations,
  criteriaSets,
  deals,
  messages,
  offers,
  parcels,
  titleCompanies,
} from "@/db/schema";
import { evaluateCampaignGate } from "@/lib/campaigns/gating";

/**
 * Read-model queries for the three CRM lenses (design doc §2). All three are
 * views over the `deals` spine — no screen has private state.
 */

export type ConversationListFilters = {
  state?: string;
  escalated?: boolean;
  /** seller replied after our last outbound (or we never replied) */
  needsAttention?: boolean;
  campaignId?: string;
};

export async function listConversations(filters: ConversationListFilters) {
  const db = getDb();
  const where: SQL[] = [];
  if (filters.state) where.push(eq(conversations.state, filters.state));
  if (filters.escalated) where.push(eq(conversations.escalated, true));
  if (filters.campaignId) where.push(eq(deals.campaignId, filters.campaignId));
  if (filters.needsAttention) {
    where.push(
      sql`${conversations.lastInboundAt} IS NOT NULL AND (${conversations.lastOutboundAt} IS NULL OR ${conversations.lastInboundAt} > ${conversations.lastOutboundAt})`,
    );
  }

  return db
    .select({
      id: conversations.id,
      state: conversations.state,
      escalated: conversations.escalated,
      lastInboundAt: conversations.lastInboundAt,
      lastOutboundAt: conversations.lastOutboundAt,
      dealId: deals.id,
      dealStage: deals.stage,
      verdict: deals.verdict,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      campaignName: campaigns.name,
      lastMessageAt: sql<Date>`GREATEST(COALESCE(${conversations.lastInboundAt}, 'epoch'::timestamptz), COALESCE(${conversations.lastOutboundAt}, 'epoch'::timestamptz))`,
    })
    .from(conversations)
    .innerJoin(deals, eq(conversations.dealId, deals.id))
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(campaigns, eq(deals.campaignId, campaigns.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(sql`GREATEST(COALESCE(${conversations.lastInboundAt}, 'epoch'::timestamptz), COALESCE(${conversations.lastOutboundAt}, 'epoch'::timestamptz))`))
    .limit(100);
}

export async function getConversationDetail(conversationId: string) {
  const db = getDb();
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) return null;

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, conversation.dealId) });
  if (!deal) return null;

  const [contact, thread, campaign] = await Promise.all([
    db.query.contacts.findFirst({ where: eq(contacts.id, deal.contactId) }),
    db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: messages.createdAt,
      limit: 500,
    }),
    deal.campaignId ? db.query.campaigns.findFirst({ where: eq(campaigns.id, deal.campaignId) }) : null,
  ]);

  const criteria = campaign?.criteriaId
    ? await db.query.criteriaSets.findFirst({ where: eq(criteriaSets.id, campaign.criteriaId) })
    : null;

  const dealContracts = await db.query.contracts.findMany({
    where: eq(contracts.dealId, deal.id),
    orderBy: desc(contracts.createdAt),
  });

  const parcel = deal.parcelId ? await db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) }) : null;
  const parcelChecks = parcel
    ? await db.query.checks.findMany({
        where: eq(checks.parcelId, parcel.id),
        orderBy: desc(checks.checkedAt),
        limit: 20,
      })
    : [];

  // newest check per kind
  const latestChecks = new Map<string, (typeof parcelChecks)[number]>();
  for (const c of parcelChecks) {
    if (!latestChecks.has(c.kind)) latestChecks.set(c.kind, c);
  }

  return {
    conversation,
    deal,
    contact: contact ?? null,
    campaign: campaign ?? null,
    criteria: criteria ?? null,
    parcel: parcel ?? null,
    checks: [...latestChecks.values()],
    contracts: dealContracts,
    thread,
  };
}

export async function getSeller360(contactId: string) {
  const db = getDb();
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  if (!contact) return null;

  const contactDeals = await db.query.deals.findMany({
    where: eq(deals.contactId, contactId),
    orderBy: desc(deals.createdAt),
  });
  const dealIds = contactDeals.map((d) => d.id);

  const [convs, dealOffers, dealParcels, campaignRows] = await Promise.all([
    dealIds.length
      ? db.query.conversations.findMany({ where: inArray(conversations.dealId, dealIds), orderBy: desc(conversations.createdAt) })
      : [],
    dealIds.length ? db.query.offers.findMany({ where: inArray(offers.dealId, dealIds), orderBy: desc(offers.createdAt) }) : [],
    db
      .select({ parcel: parcels, dealId: deals.id })
      .from(deals)
      .innerJoin(parcels, eq(deals.parcelId, parcels.id))
      .where(eq(deals.contactId, contactId)),
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns),
  ]);

  const convIds = convs.map((c) => c.id);
  const actions = convIds.length
    ? await db.query.agentActions.findMany({
        where: inArray(agentActions.conversationId, convIds),
        orderBy: desc(agentActions.createdAt),
        limit: 100,
      })
    : [];

  const campaignNames = new Map(campaignRows.map((c) => [c.id, c.name]));
  return { contact, deals: contactDeals, conversations: convs, offers: dealOffers, parcels: dealParcels, actions, campaignNames };
}

/** Campaigns with their §10 gate inputs resolved, for the campaign dashboard. */
export async function listCampaignsWithGate(sendivoHealthy: boolean, agentConfigured: boolean) {
  const db = getDb();
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      market: campaigns.market,
      criteriaId: campaigns.criteriaId,
      builderId: campaigns.builderId,
      titleCompanyId: campaigns.titleCompanyId,
      sendivoCampaignId: campaigns.sendivoCampaignId,
      builderTitleCompanyId: builders.preferredTitleCompanyId,
    })
    .from(campaigns)
    .leftJoin(builders, eq(campaigns.builderId, builders.id))
    .orderBy(desc(campaigns.createdAt));

  const [defaultTitle] = await db
    .select({ id: titleCompanies.id })
    .from(titleCompanies)
    .where(eq(titleCompanies.isDefaultFl, true))
    .limit(1);

  return rows.map((row) => ({
    ...row,
    gate: evaluateCampaignGate({
      hasCriteria: Boolean(row.criteriaId),
      hasBuilder: Boolean(row.builderId),
      hasTitleRouting: Boolean(row.titleCompanyId ?? row.builderTitleCompanyId ?? defaultTitle?.id),
      sendivoHealthy,
      hasSendingNumber: Boolean(row.sendivoCampaignId),
      agentConfigured,
    }),
  }));
}

export type PipelineFilters = { stage?: string; verdict?: string; q?: string };

export async function listPipeline(filters: PipelineFilters) {
  const db = getDb();
  const where: SQL[] = [];
  if (filters.stage) where.push(eq(deals.stage, filters.stage as (typeof deals.stage.enumValues)[number]));
  if (filters.verdict) where.push(eq(deals.verdict, filters.verdict as (typeof deals.verdict.enumValues)[number]));
  if (filters.q) {
    const q = `%${filters.q}%`;
    const match = or(ilike(contacts.name, q), ilike(contacts.phone, q), ilike(parcels.address, q));
    if (match) where.push(match);
  }

  return db
    .select({
      dealId: deals.id,
      stage: deals.stage,
      verdict: deals.verdict,
      maxOffer: deals.maxOffer,
      lastOffer: deals.lastOffer,
      sellerCounter: deals.sellerCounter,
      updatedAt: deals.updatedAt,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      parcelAddress: parcels.address,
      parcelCounty: parcels.county,
      campaignName: campaigns.name,
      conversationId: sql<string | null>`(SELECT id FROM conversations WHERE deal_id = ${deals.id} ORDER BY created_at DESC LIMIT 1)`,
    })
    .from(deals)
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(parcels, eq(deals.parcelId, parcels.id))
    .leftJoin(campaigns, eq(deals.campaignId, campaigns.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(deals.updatedAt))
    .limit(200);
}
