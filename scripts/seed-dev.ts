/**
 * Dev-only seed: a title company, builder, criteria set, and a live campaign,
 * then links every existing conversation to that campaign so the CRM screens
 * have something to render. Safe to re-run (idempotent on natural keys).
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/seed-dev.ts
 */
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { builders, campaigns, criteriaSets, deals, titleCompanies } from "../src/db/schema";

async function main() {
  const db = getDb();

  const existingTitle = await db.query.titleCompanies.findFirst({ where: eq(titleCompanies.isDefaultFl, true) });
  const title =
    existingTitle ??
    (
      await db
        .insert(titleCompanies)
        .values({
          name: "FL Default Title (placeholder)",
          contactName: "TBD — Marlon's contact",
          emails: ["title@example.com"],
          state: "FL",
          isDefaultFl: true,
        })
        .returning()
    )[0];

  const existingBuilder = await db.query.builders.findFirst();
  const builder =
    existingBuilder ??
    (
      await db
        .insert(builders)
        .values({
          name: "Placeholder Builder LLC",
          entityName: "Placeholder Builder LLC",
          email: "builder@example.com",
          markets: ["Lehigh Acres", "Port St. Lucie", "Port Charlotte"],
          preferredTitleCompanyId: title.id,
        })
        .returning()
    )[0];

  const existingCriteria = await db.query.criteriaSets.findFirst();
  const criteria =
    existingCriteria ??
    (
      await db
        .insert(criteriaSets)
        .values({
          minSqft: 10_000,
          allowedFloodZones: ["X"],
          wetlandsAllowed: false,
          builderBuyPrice: "32000.00",
          minAssignmentFee: "8000.00",
          anchorPct: "0.780",
          concessionSteps: [0.4, 0.7, 1],
        })
        .returning()
    )[0];

  const existingCampaign = await db.query.campaigns.findFirst();
  const campaign =
    existingCampaign ??
    (
      await db
        .insert(campaigns)
        .values({
          name: "Lehigh Acres · Aug 2026",
          market: "Lee",
          status: "live",
          criteriaId: criteria.id,
          builderId: builder.id,
          titleCompanyId: title.id,
        })
        .returning()
    )[0];

  const linked = await db
    .update(deals)
    .set({ campaignId: campaign.id, updatedAt: new Date() })
    .where(isNull(deals.campaignId))
    .returning({ id: deals.id });

  console.log(
    `seeded: title=${title.name}, builder=${builder.name}, criteria max_offer=${criteria.maxOffer}, campaign=${campaign.name}, deals linked=${linked.length}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
