import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  agentActions,
  builders,
  campaigns,
  checks,
  contactParcels,
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
import { campaignBuilders } from "@/db/schema";
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

  // The numbers on the card follow the buyer this lot was matched to.
  const criteria = deal.matchedBuilderId
    ? await db.query.criteriaSets.findFirst({ where: eq(criteriaSets.builderId, deal.matchedBuilderId) })
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

  // Every lot this seller is on record for — not just the one under
  // negotiation. A seller who owns three parcels is normal, and the Deal Room
  // has to be able to say "we're actually talking about the other one".
  const ownedParcels = await db
    .select({
      parcelRowId: parcels.id,
      county: parcels.county,
      parcelId: parcels.parcelId,
      address: parcels.address,
      sqft: parcels.sqft,
      floodZones: parcels.floodZones,
      wetlandsIntersects: parcels.wetlandsIntersects,
      relationship: contactParcels.relationship,
    })
    .from(contactParcels)
    .innerJoin(parcels, eq(contactParcels.parcelId, parcels.id))
    .where(eq(contactParcels.contactId, deal.contactId))
    .orderBy(desc(contactParcels.createdAt));

  return {
    conversation,
    deal,
    contact: contact ?? null,
    campaign: campaign ?? null,
    criteria: criteria ?? null,
    parcel: parcel ?? null,
    ownedParcels,
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
      buyerCount: sql<number>`(
        SELECT count(*)::int FROM ${campaignBuilders}
        JOIN ${criteriaSets} ON ${criteriaSets.builderId} = ${campaignBuilders.builderId}
        WHERE ${campaignBuilders.campaignId} = ${campaigns.id}
      )`,
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
      hasCriteria: row.buyerCount > 0,
      hasBuilder: row.buyerCount > 0,
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

export type SellerFilters = {
  q?: string;
  /** Only contacts who have actually replied to us. */
  replied?: boolean;
  optedOut?: boolean;
  /** Only contacts with a lot on record. */
  withParcel?: boolean;
  page?: number;
};

export const SELLERS_PAGE_SIZE = 50;

/**
 * The seller directory (§2.2). Paginated because the blast audience is tens of
 * thousands of rows — the whole point of syncing Sendivo's logs is that every
 * number we have ever texted is in here, and an unbounded query would try to
 * render all of them.
 */
export async function listSellers(filters: SellerFilters = {}) {
  const db = getDb();
  const page = Math.max(1, filters.page ?? 1);
  const where: SQL[] = [];

  if (filters.q?.trim()) {
    const q = `%${filters.q.trim()}%`;
    // Digits-only variant so "(239) 555-0101" finds a stored +12395550101.
    const digits = filters.q.replace(/\D/g, "");
    const match = or(
      ilike(contacts.name, q),
      ilike(contacts.phone, q),
      digits.length >= 4 ? ilike(contacts.phone, `%${digits}%`) : undefined,
      ilike(contacts.mailingStreet, q),
    );
    if (match) where.push(match);
  }
  if (filters.optedOut !== undefined) where.push(eq(contacts.optedOut, filters.optedOut));

  // Correlated subqueries are written with an explicit "contacts"."id" rather
  // than a Drizzle column reference: inside a subquery that joins
  // contact_parcels, an unqualified "id" is ambiguous and Postgres rejects the
  // whole statement (42702).
  const OUTER = sql.raw('"contacts"."id"');

  const parcelCount = sql<number>`(SELECT count(*)::int FROM ${contactParcels} cp WHERE cp.contact_id = ${OUTER})`;
  const inboundCount = sql<number>`(
    SELECT count(*)::int FROM ${messages} m
    JOIN ${conversations} cv ON m.conversation_id = cv.id
    JOIN ${deals} d ON cv.deal_id = d.id
    WHERE d.contact_id = ${OUTER} AND m.direction = 'inbound')`;

  if (filters.replied) where.push(sql`${inboundCount} > 0`);
  if (filters.withParcel) where.push(sql`${parcelCount} > 0`);

  const condition = where.length ? and(...where) : undefined;

  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: contacts.id,
        name: contacts.name,
        phone: contacts.phone,
        source: contacts.source,
        labels: contacts.labels,
        optedOut: contacts.optedOut,
        updatedAt: contacts.updatedAt,
        parcelCount,
        inboundCount,
        firstAddress: sql<string | null>`(
          SELECT p.address FROM ${contactParcels} cp
          JOIN ${parcels} p ON p.id = cp.parcel_id
          WHERE cp.contact_id = ${OUTER} LIMIT 1)`,
        conversationId: sql<string | null>`(
          SELECT cv.id FROM ${conversations} cv
          JOIN ${deals} d ON cv.deal_id = d.id
          WHERE d.contact_id = ${OUTER} ORDER BY cv.created_at DESC LIMIT 1)`,
      })
      .from(contacts)
      .where(condition)
      .orderBy(desc(contacts.updatedAt))
      .limit(SELLERS_PAGE_SIZE)
      .offset((page - 1) * SELLERS_PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(condition),
  ]);

  return { rows, total: count?.n ?? 0, page, pageSize: SELLERS_PAGE_SIZE };
}
