CREATE TABLE "campaign_builders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "criteria_sets" ADD COLUMN "builder_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "matched_builder_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_builders" ADD CONSTRAINT "campaign_builders_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_builders" ADD CONSTRAINT "campaign_builders_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_builders_pair_idx" ON "campaign_builders" USING btree ("campaign_id","builder_id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_matched_builder_id_builders_id_fk" FOREIGN KEY ("matched_builder_id") REFERENCES "public"."builders"("id") ON DELETE no action ON UPDATE no action;