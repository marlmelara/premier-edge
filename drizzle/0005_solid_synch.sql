ALTER TABLE "criteria_sets" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "criteria_sets" ADD COLUMN "county" text;--> statement-breakpoint
ALTER TABLE "criteria_sets" ADD COLUMN "cities" text[];--> statement-breakpoint
ALTER TABLE "criteria_sets" ADD COLUMN "zips" text[];--> statement-breakpoint
ALTER TABLE "criteria_sets" ADD COLUMN "utility_rules" jsonb;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "water_source" text;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "sewer_type" text;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "utility_detail" text;