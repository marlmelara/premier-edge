
import { getDb } from "@/db";
import { builders, campaignBuilders, campaigns, criteriaSets } from "@/db/schema";
import { BuyerList, type BuyerRow } from "@/components/buyer-list";
import type { UtilityRule } from "@/lib/eligibility/buy-box";

export const dynamic = "force-dynamic";
export const metadata = { title: "Buyers — Premier Edge" };

/**
 * The buyer list and their buy boxes. This is the front half of due diligence:
 * a parcel's flood zone, wetlands, and size only mean something relative to
 * what a specific builder will take, and at what price.
 */
export default async function BuyersPage() {
  const db = getDb();

  const [rows, campaignRows, links, boxRows] = await Promise.all([
    db
      .select({
        builderId: builders.id,
        name: builders.name,
        entityName: builders.entityName,
        email: builders.email,
        phone: builders.phone,
        markets: builders.markets,
        notes: builders.notes,
      })
      .from(builders)
      .orderBy(builders.name),
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).orderBy(campaigns.name),
    db.select({ campaignId: campaignBuilders.campaignId, builderId: campaignBuilders.builderId }).from(campaignBuilders),
    // Buy boxes are many-per-buyer now, so they're loaded separately and
    // grouped — joining them would duplicate a builder once per box.
    db
      .select({
        id: criteriaSets.id,
        builderId: criteriaSets.builderId,
        name: criteriaSets.name,
        county: criteriaSets.county,
        cities: criteriaSets.cities,
        zips: criteriaSets.zips,
        minSqft: criteriaSets.minSqft,
        allowedFloodZones: criteriaSets.allowedFloodZones,
        wetlandsAllowed: criteriaSets.wetlandsAllowed,
        builderBuyPrice: criteriaSets.builderBuyPrice,
        minAssignmentFee: criteriaSets.minAssignmentFee,
        anchorPct: criteriaSets.anchorPct,
        utilityRules: criteriaSets.utilityRules,
      })
      .from(criteriaSets),
  ]);

  const buyers: BuyerRow[] = rows.map((r) => ({
    ...r,
    maxOffer: null,
    campaignIds: links.filter((l) => l.builderId === r.builderId).map((l) => l.campaignId),
    boxes: boxRows
      .filter((b) => b.builderId === r.builderId)
      .map((b) => ({
        id: b.id,
        name: b.name,
        county: b.county,
        cities: b.cities,
        zips: b.zips,
        minSqft: b.minSqft,
        allowedFloodZones: b.allowedFloodZones,
        wetlandsAllowed: b.wetlandsAllowed,
        builderBuyPrice: b.builderBuyPrice,
        minAssignmentFee: b.minAssignmentFee,
        anchorPct: b.anchorPct,
        utilityRules: Array.isArray(b.utilityRules) ? (b.utilityRules as UtilityRule[]) : [],
      })),
  }));

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <div>
        <h1 className="text-lg font-semibold">Buyers</h1>
        <p className="text-sm text-muted-foreground">
          Every parcel is scored against these buy boxes before the agent may name a price. A lot that fits nobody
          never gets an offer.
        </p>
      </div>
      <BuyerList buyers={buyers} campaigns={campaignRows} />
    </main>
  );
}
