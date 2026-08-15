/**
 * Premier Edge data model — mirrors Design Doc §5 exactly.
 * Money numeric(12,2), IDs uuid, all tables timestamped (agent_actions is
 * append-only: created_at only). `deals` is the join-everything spine.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const contactSource = pgEnum("contact_source", ["blast", "inbound", "manual"]);
export const parcelRelationship = pgEnum("parcel_relationship", ["owner", "claimed", "unknown"]);
export const checkKind = pgEnum("check_kind", ["county", "fema", "nwi", "sqft"]);
export const checkResult = pgEnum("check_result", ["pass", "fail", "error"]);
export const dealStage = pgEnum("deal_stage", [
  "lead",
  "qualifying",
  "verified",
  "offer",
  "negotiating",
  "accepted",
  "under_contract",
  "closed",
  "dead",
]);
export const dealVerdict = pgEnum("deal_verdict", ["pass", "fail", "pending"]);
export const campaignStatus = pgEnum("campaign_status", ["draft", "ready", "live", "paused", "done"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageSender = pgEnum("message_sender", ["agent", "marlon"]);
export const contractKind = pgEnum("contract_kind", ["psa", "assignment"]);

const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  email: text("email"),
  altPhones: text("alt_phones").array(),
  mailingStreet: text("mailing_street"),
  mailingCity: text("mailing_city"),
  mailingState: text("mailing_state"),
  mailingZip: text("mailing_zip"),
  source: contactSource("source").notNull().default("inbound"),
  sendivoContactId: text("sendivo_contact_id"),
  stage: text("stage"),
  labels: text("labels").array(),
  notes: text("notes"),
  optedOut: boolean("opted_out").notNull().default(false),
  // Full Sendivo contact payload from first-inbound enrichment (§2.4) —
  // audit trail, and property_address fields seed M1 parcel resolution.
  sendivoRaw: jsonb("sendivo_raw"),
  ...timestamps,
});

export const parcels = pgTable(
  "parcels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    county: text("county").notNull(),
    parcelId: text("parcel_id").notNull(),
    address: text("address"),
    legalDescription: text("legal_description"),
    ownerNameRaw: text("owner_name_raw"),
    acreage: numeric("acreage", { precision: 10, scale: 4 }),
    sqft: integer("sqft"),
    geometry: jsonb("geometry"), // GeoJSON from the county adapter
    sourceAdapter: text("source_adapter"),
    rawPayload: jsonb("raw_payload"),
    appraiserUrl: text("appraiser_url"),
    assessedValue: money("assessed_value"),
    /**
     * DOC AMENDMENT (proposed, Aug 14 2026), §5: the GIS findings are
     * denormalized onto the parcel so the land bank is searchable in plain SQL.
     *
     * A lot we can't buy today isn't dead — it's inventory waiting for a buyer
     * whose buy box tolerates it. Burying "AE zone" inside checks.detail jsonb
     * makes "find every wetland lot we've ever logged" a table scan through
     * JSON; as columns it's an index away. `checks` remains the audit trail.
     */
    floodZones: text("flood_zones").array(),
    wetlandsIntersects: boolean("wetlands_intersects"),
    /**
     * DOC AMENDMENT (Aug 15 2026): utilities decide the largest single price
     * swing on a vacant lot — the next owner either connects or drills. Stored
     * denormalized like the flood/wetland findings so the land bank is
     * searchable on them. Null means undetermined, never "well/septic".
     */
    waterSource: text("water_source"),
    sewerType: text("sewer_type"),
    utilityDetail: text("utility_detail"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("parcels_county_parcel_id_idx").on(t.county, t.parcelId)],
);

export const contactParcels = pgTable(
  "contact_parcels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    parcelId: uuid("parcel_id")
      .notNull()
      .references(() => parcels.id),
    relationship: parcelRelationship("relationship").notNull().default("unknown"),
    ...timestamps,
  },
  (t) => [uniqueIndex("contact_parcels_pair_idx").on(t.contactId, t.parcelId)],
);

export const checks = pgTable("checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  parcelId: uuid("parcel_id")
    .notNull()
    .references(() => parcels.id),
  kind: checkKind("kind").notNull(),
  result: checkResult("result").notNull(),
  detail: jsonb("detail"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

/**
 * DOC AMENDMENT (proposed, Aug 14 2026) to §5/§10: a criteria set now belongs to
 * a *builder*, and a campaign can carry several builders (see campaignBuilders).
 *
 * Why: builder_buy_price is inherently per-buyer. With one criteria set per
 * campaign there is no single answer to "does this lot fit" once more than one
 * builder is in play — and the max offer depends on which builder takes it.
 * Matching a parcel against every buyer's criteria is what keeps us from
 * negotiating on lots nobody wants.
 */
/**
 * A buy box. DOC AMENDMENT (Aug 15 2026), §5 + §10.
 *
 * Was one row per builder. A builder actually has several: the same buyer pays
 * differently in Cape Coral than Lehigh Acres, and differently again depending
 * on a lot's utilities. So this is now many-per-builder, scoped by
 * county/city/zip, with a price matrix over water and sewer inside the single
 * entry rather than a separate row per combination.
 */
export const criteriaSets = pgTable("criteria_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Nullable only so pre-amendment rows survive; new criteria always name a builder. */
  builderId: uuid("builder_id"),
  /** Marlon's name for it — "Cape Coral standard". */
  name: text("name"),
  /** Where it applies. County is the required scope; city and zip narrow it. */
  county: text("county"),
  cities: text("cities").array(),
  zips: text("zips").array(),
  /**
   * Price matrix over utilities: [{ water, sewer, buyPriceCents?, accepted }].
   * Empty/null means utilities don't affect this buyer's price. Absolute
   * amounts, not deductions — Marlon quotes them that way.
   */
  utilityRules: jsonb("utility_rules"),
  minSqft: integer("min_sqft").notNull(),
  allowedFloodZones: text("allowed_flood_zones")
    .array()
    .notNull()
    .default(sql`'{X}'::text[]`),
  wetlandsAllowed: boolean("wetlands_allowed").notNull().default(false),
  builderBuyPrice: money("builder_buy_price").notNull(),
  minAssignmentFee: money("min_assignment_fee").notNull(),
  // Computed by the DB, never typed: what we can pay = builder price − our fee floor.
  maxOffer: money("max_offer").generatedAlwaysAs(
    sql`builder_buy_price - min_assignment_fee`,
  ),
  anchorPct: numeric("anchor_pct", { precision: 4, scale: 3 }).notNull().default("0.780"),
  concessionSteps: jsonb("concession_steps"),
  ...timestamps,
});

export const titleCompanies = pgTable("title_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  emails: text("emails").array().notNull(),
  state: text("state").notNull(),
  isDefaultFl: boolean("is_default_fl").notNull().default(false),
  ...timestamps,
});

export const builders = pgTable("builders", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  entityName: text("entity_name"),
  email: text("email"),
  phone: text("phone"),
  markets: text("markets").array(),
  buyCriteria: jsonb("buy_criteria"),
  preferredTitleCompanyId: uuid("preferred_title_company_id").references(() => titleCompanies.id),
  notes: text("notes"),
  ...timestamps,
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  market: text("market"),
  status: campaignStatus("status").notNull().default("draft"),
  sendivoCampaignId: text("sendivo_campaign_id"),
  sendivoBlastIds: integer("sendivo_blast_ids").array(),
  criteriaId: uuid("criteria_id").references(() => criteriaSets.id),
  builderId: uuid("builder_id").references(() => builders.id),
  titleCompanyId: uuid("title_company_id").references(() => titleCompanies.id),
  autonomy: jsonb("autonomy"),
  ...timestamps,
});

/**
 * Which buyers a campaign is sourcing for. Marlon usually runs one builder per
 * campaign, but the model supports several so a lot can be matched to whichever
 * buyer actually wants it.
 */
export const campaignBuilders = pgTable(
  "campaign_builders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    builderId: uuid("builder_id")
      .notNull()
      .references(() => builders.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("campaign_builders_pair_idx").on(t.campaignId, t.builderId)],
);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id),
  // Nullable: a fresh inbound lead has no parcel or campaign resolved yet.
  parcelId: uuid("parcel_id").references(() => parcels.id),
  campaignId: uuid("campaign_id").references(() => campaigns.id),
  stage: dealStage("stage").notNull().default("lead"),
  verdict: dealVerdict("verdict").notNull().default("pending"),
  // Denormalized for pipeline list speed; recomputed from criteria+offers on
  // write, never hand-edited.
  maxOffer: money("max_offer"),
  anchor: money("anchor"),
  lastOffer: money("last_offer"),
  sellerCounter: money("seller_counter"),
  deadReason: text("dead_reason"),
  /**
   * The buyer this lot was matched to — the one whose criteria it satisfies and
   * who pays best. Set by the eligibility pipeline, and what the offer math and
   * the assignment contract both key off.
   */
  matchedBuilderId: uuid("matched_builder_id").references(() => builders.id),
  // DOC AMENDMENT (proposed, Aug 12 2026): not in design doc §5. The §11b
  // briefing's top-priority line is "closings within N days (address +
  // countdown)", which needs a real date — deriving it from updated_at gives a
  // countdown that resets on every edit. Set when title routing confirms a date.
  closingDate: timestamp("closing_date", { withTimezone: true }),
  /**
   * DOC AMENDMENT (Aug 15 2026): what we actually earned on this deal — the
   * spread between the builder's price and what we paid the seller. Recorded
   * explicitly rather than derived, because the buy box can change after a
   * close and history must not move with it.
   */
  assignmentFee: money("assignment_fee"),
  /** Set when the money is actually in hand, as distinct from a scheduled closing date. */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  ...timestamps,
});

/**
 * Conversation state machine values (M3). Text column, not a pg enum, so the
 * machine can grow without a migration: NEW → QUALIFYING → VERIFYING →
 * OFFER_SENT → NEGOTIATING → ACCEPTED → CONTRACT_SENT → TITLE_ROUTED, with
 * ESCALATED / DEAD / OPTED_OUT terminals.
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  sendivoConversationId: text("sendivo_conversation_id").unique(),
  state: text("state").notNull().default("NEW"),
  ownedByEdge: boolean("owned_by_edge").notNull().default(false),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
  escalated: boolean("escalated").notNull().default(false),
  escalationReason: text("escalation_reason"),
  ...timestamps,
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  direction: messageDirection("direction").notNull(),
  body: text("body").notNull(),
  sendivoMessageId: text("sendivo_message_id").unique(), // webhook dedupe anchor
  status: text("status"),
  classifiedAs: text("classified_as"),
  sentBy: messageSender("sent_by"),
  ...timestamps,
});

/** APPEND-ONLY audit log. Never updated, never deleted. */
export const agentActions = pgTable("agent_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  type: text("type").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable offer snapshots — one row per version, never updated. */
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    version: integer("version").notNull(),
    amount: money("amount").notNull(),
    stateAtOffer: text("state_at_offer"),
    assumptions: jsonb("assumptions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("offers_deal_version_idx").on(t.dealId, t.version)],
);

export const contracts = pgTable("contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id),
  kind: contractKind("kind").notNull(),
  signwellDocumentId: text("signwell_document_id"),
  templateUsed: text("template_used"),
  sellers: jsonb("sellers"), // 1..n signers
  price: money("price"),
  status: text("status"),
  signedPdfUrl: text("signed_pdf_url"),
  ...timestamps,
});

/** Checked before EVERY send. Phone is the PK — one row per opted-out number. */
export const optOuts = pgTable("opt_outs", {
  phone: text("phone").primaryKey(),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source"),
});
