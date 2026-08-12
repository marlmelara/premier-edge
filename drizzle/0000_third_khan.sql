CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'ready', 'live', 'paused', 'done');--> statement-breakpoint
CREATE TYPE "public"."check_kind" AS ENUM('county', 'fema', 'nwi', 'sqft');--> statement-breakpoint
CREATE TYPE "public"."check_result" AS ENUM('pass', 'fail', 'error');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('blast', 'inbound', 'manual');--> statement-breakpoint
CREATE TYPE "public"."contract_kind" AS ENUM('psa', 'assignment');--> statement-breakpoint
CREATE TYPE "public"."deal_stage" AS ENUM('lead', 'qualifying', 'verified', 'offer', 'negotiating', 'accepted', 'under_contract', 'closed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."deal_verdict" AS ENUM('pass', 'fail', 'pending');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('agent', 'marlon');--> statement-breakpoint
CREATE TYPE "public"."parcel_relationship" AS ENUM('owner', 'claimed', 'unknown');--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"type" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_name" text,
	"email" text,
	"phone" text,
	"markets" text[],
	"buy_criteria" jsonb,
	"preferred_title_company_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"market" text,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"sendivo_campaign_id" text,
	"sendivo_blast_ids" integer[],
	"criteria_id" uuid,
	"builder_id" uuid,
	"title_company_id" uuid,
	"autonomy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid NOT NULL,
	"kind" "check_kind" NOT NULL,
	"result" "check_result" NOT NULL,
	"detail" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"parcel_id" uuid NOT NULL,
	"relationship" "parcel_relationship" DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"alt_phones" text[],
	"mailing_street" text,
	"mailing_city" text,
	"mailing_state" text,
	"mailing_zip" text,
	"source" "contact_source" DEFAULT 'inbound' NOT NULL,
	"sendivo_contact_id" text,
	"stage" text,
	"labels" text[],
	"notes" text,
	"opted_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"kind" "contract_kind" NOT NULL,
	"signwell_document_id" text,
	"template_used" text,
	"sellers" jsonb,
	"price" numeric(12, 2),
	"status" text,
	"signed_pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"sendivo_conversation_id" text,
	"state" text DEFAULT 'NEW' NOT NULL,
	"owned_by_edge" boolean DEFAULT false NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"escalated" boolean DEFAULT false NOT NULL,
	"escalation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_sendivo_conversation_id_unique" UNIQUE("sendivo_conversation_id")
);
--> statement-breakpoint
CREATE TABLE "criteria_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_sqft" integer NOT NULL,
	"allowed_flood_zones" text[] DEFAULT '{X}'::text[] NOT NULL,
	"wetlands_allowed" boolean DEFAULT false NOT NULL,
	"builder_buy_price" numeric(12, 2) NOT NULL,
	"min_assignment_fee" numeric(12, 2) NOT NULL,
	"max_offer" numeric(12, 2) GENERATED ALWAYS AS (builder_buy_price - min_assignment_fee) STORED,
	"anchor_pct" numeric(4, 3) DEFAULT '0.780' NOT NULL,
	"concession_steps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"parcel_id" uuid,
	"campaign_id" uuid,
	"stage" "deal_stage" DEFAULT 'lead' NOT NULL,
	"verdict" "deal_verdict" DEFAULT 'pending' NOT NULL,
	"max_offer" numeric(12, 2),
	"anchor" numeric(12, 2),
	"last_offer" numeric(12, 2),
	"seller_counter" numeric(12, 2),
	"dead_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text NOT NULL,
	"sendivo_message_id" text,
	"status" text,
	"classified_as" text,
	"sent_by" "message_sender",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sendivo_message_id_unique" UNIQUE("sendivo_message_id")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"state_at_offer" text,
	"assumptions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_outs" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"county" text NOT NULL,
	"parcel_id" text NOT NULL,
	"address" text,
	"legal_description" text,
	"owner_name_raw" text,
	"acreage" numeric(10, 4),
	"sqft" integer,
	"geometry" jsonb,
	"source_adapter" text,
	"raw_payload" jsonb,
	"appraiser_url" text,
	"assessed_value" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"emails" text[] NOT NULL,
	"state" text NOT NULL,
	"is_default_fl" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_preferred_title_company_id_title_companies_id_fk" FOREIGN KEY ("preferred_title_company_id") REFERENCES "public"."title_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_criteria_id_criteria_sets_id_fk" FOREIGN KEY ("criteria_id") REFERENCES "public"."criteria_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_title_company_id_title_companies_id_fk" FOREIGN KEY ("title_company_id") REFERENCES "public"."title_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_parcels" ADD CONSTRAINT "contact_parcels_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_parcels" ADD CONSTRAINT "contact_parcels_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_parcels_pair_idx" ON "contact_parcels" USING btree ("contact_id","parcel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_deal_version_idx" ON "offers" USING btree ("deal_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "parcels_county_parcel_id_idx" ON "parcels" USING btree ("county","parcel_id");