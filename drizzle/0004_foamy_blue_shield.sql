ALTER TABLE "parcels" ADD COLUMN "flood_zones" text[];--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "wetlands_intersects" boolean;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "last_checked_at" timestamp with time zone;