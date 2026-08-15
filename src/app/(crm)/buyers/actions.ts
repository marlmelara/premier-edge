"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/db";
import { builders, campaignBuilders, criteriaSets, deals } from "@/db/schema";
import type { UtilityRule } from "@/lib/eligibility/buy-box";

async function requireSession() {
  const session = await auth();
  if (!session?.user) throw new Error("unauthorized");
}

const money = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
};

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A buyer and their buy-box in one write — they're useless apart. The criteria
 * are what every parcel gets scored against before we negotiate.
 */
export async function saveBuyerAction(formData: FormData) {
  await requireSession();
  const db = getDb();

  const builderId = String(formData.get("builderId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false as const, reason: "buyer name is required" };

  const buyPrice = money(formData.get("builderBuyPrice"));
  const feeFloor = money(formData.get("minAssignmentFee"));
  if (!buyPrice) return { ok: false as const, reason: "what they pay per lot is required" };
  if (!feeFloor) return { ok: false as const, reason: "your minimum assignment fee is required" };
  if (Number(feeFloor) >= Number(buyPrice)) {
    return { ok: false as const, reason: "your fee floor must be less than what they pay, or there's no offer to make" };
  }

  const minSqft = Number(formData.get("minSqft") ?? 0);
  if (!Number.isFinite(minSqft) || minSqft <= 0) return { ok: false as const, reason: "minimum lot size is required" };

  const zones = list(formData.get("allowedFloodZones"));
  const builderFields = {
    name,
    entityName: String(formData.get("entityName") ?? "").trim() || null,
    email: String(formData.get("email") ?? "").trim() || null,
    phone: String(formData.get("phone") ?? "").trim() || null,
    markets: list(formData.get("markets")),
    // Free text: often all Marlon has is a name, or a name and an address.
    preferredTitleName: String(formData.get("preferredTitleName") ?? "").trim() || null,
    preferredTitleAddress: String(formData.get("preferredTitleAddress") ?? "").trim() || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
    updatedAt: new Date(),
  };

  const criteriaFields = {
    minSqft,
    allowedFloodZones: zones.length ? zones.map((z) => z.toUpperCase()) : ["X"],
    wetlandsAllowed: formData.get("wetlandsAllowed") === "on",
    builderBuyPrice: buyPrice,
    minAssignmentFee: feeFloor,
    anchorPct: String(formData.get("anchorPct") ?? "0.780"),
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    const id = builderId
      ? (await tx.update(builders).set(builderFields).where(eq(builders.id, builderId)).returning())[0].id
      : (await tx.insert(builders).values(builderFields).returning())[0].id;

    const existing = await tx.query.criteriaSets.findFirst({ where: eq(criteriaSets.builderId, id) });
    if (existing) await tx.update(criteriaSets).set(criteriaFields).where(eq(criteriaSets.id, existing.id));
    else await tx.insert(criteriaSets).values({ ...criteriaFields, builderId: id });
  });

  revalidatePath("/buyers");
  revalidatePath("/campaigns");
  return { ok: true as const };
}

/** Attach or detach a buyer from a campaign. A campaign may carry several. */
export async function toggleCampaignBuyerAction(campaignId: string, builderId: string, attached: boolean) {
  await requireSession();
  const db = getDb();

  if (attached) {
    await db.insert(campaignBuilders).values({ campaignId, builderId }).onConflictDoNothing();
  } else {
    await db
      .delete(campaignBuilders)
      .where(and(eq(campaignBuilders.campaignId, campaignId), eq(campaignBuilders.builderId, builderId)));
  }

  revalidatePath("/buyers");
  revalidatePath("/campaigns");
  return { ok: true as const };
}

/**
 * Buy boxes are now many-per-buyer (§10 amendment). saveBuyerAction still
 * writes the buyer's identity; these manage the boxes underneath it.
 */

const utilityRulesFrom = (raw: FormDataEntryValue | null): UtilityRule[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        water: r.water === "city" || r.water === "well" ? r.water : "any",
        sewer: r.sewer === "city" || r.sewer === "septic" ? r.sewer : "any",
        // Absolute amounts, entered in dollars, stored in cents.
        buyPriceCents:
          r.buyPrice != null && Number.isFinite(Number(r.buyPrice))
            ? Math.round(Number(r.buyPrice) * 100)
            : undefined,
        accepted: r.accepted !== false,
      }));
  } catch {
    return [];
  }
};

export async function saveBuyBoxAction(formData: FormData) {
  await requireSession();
  const db = getDb();

  const builderId = String(formData.get("builderId") ?? "");
  if (!builderId) return { ok: false as const, reason: "which buyer is this for?" };

  const boxId = String(formData.get("boxId") ?? "") || null;
  const county = String(formData.get("county") ?? "").trim();
  if (!county) return { ok: false as const, reason: "a buy box needs a county" };

  const buyPrice = money(formData.get("builderBuyPrice"));
  const feeFloor = money(formData.get("minAssignmentFee"));
  if (!buyPrice) return { ok: false as const, reason: "base price per lot is required" };
  if (!feeFloor) return { ok: false as const, reason: "your minimum assignment fee is required" };
  if (Number(feeFloor) >= Number(buyPrice)) {
    return { ok: false as const, reason: "your fee floor must be less than what they pay, or there's no offer to make" };
  }

  const minSqft = Number(formData.get("minSqft") ?? 0);
  if (!Number.isFinite(minSqft) || minSqft <= 0) return { ok: false as const, reason: "minimum lot size is required" };

  const rules = utilityRulesFrom(formData.get("utilityRules"));
  // Every priced rule is an absolute amount, so the same floor applies to each.
  for (const rule of rules) {
    if (rule.accepted && rule.buyPriceCents != null && rule.buyPriceCents <= Number(feeFloor) * 100) {
      return {
        ok: false as const,
        reason: `a utility price of $${(rule.buyPriceCents / 100).toLocaleString("en-US")} is at or below your fee floor — there'd be no offer to make`,
      };
    }
  }

  const zones = list(formData.get("allowedFloodZones"));
  const fields = {
    builderId,
    name: String(formData.get("name") ?? "").trim() || `${county} buy box`,
    county,
    cities: list(formData.get("cities")),
    zips: list(formData.get("zips")),
    utilityRules: rules,
    minSqft,
    allowedFloodZones: zones.length ? zones.map((z) => z.toUpperCase()) : ["X"],
    wetlandsAllowed: formData.get("wetlandsAllowed") === "on",
    builderBuyPrice: buyPrice,
    minAssignmentFee: feeFloor,
    anchorPct: String(formData.get("anchorPct") ?? "0.780"),
    updatedAt: new Date(),
  };

  if (boxId) await db.update(criteriaSets).set(fields).where(eq(criteriaSets.id, boxId));
  else await db.insert(criteriaSets).values(fields);

  revalidatePath("/buyers");
  revalidatePath("/campaigns");
  return { ok: true as const };
}

export async function deleteBuyBoxAction(boxId: string) {
  await requireSession();
  await getDb().delete(criteriaSets).where(eq(criteriaSets.id, boxId));
  revalidatePath("/buyers");
  return { ok: true as const };
}

/**
 * Remove a buyer entirely.
 *
 * Refused while any deal is matched to them: those deals carry a max offer and
 * an anchor derived from this buyer's numbers, and deleting the buyer would
 * leave live negotiations priced against a builder who no longer exists.
 * Detach them from the campaign instead — that stops new matches without
 * rewriting history.
 */
export async function deleteBuyerAction(builderId: string) {
  await requireSession();
  const db = getDb();

  const [matched] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deals)
    .where(eq(deals.matchedBuilderId, builderId));

  if ((matched?.n ?? 0) > 0) {
    return {
      ok: false as const,
      reason: `${matched.n} deal(s) are priced against this buyer. Detach them from the campaign instead of deleting.`,
    };
  }

  await db.transaction(async (tx) => {
    await tx.delete(campaignBuilders).where(eq(campaignBuilders.builderId, builderId));
    await tx.delete(criteriaSets).where(eq(criteriaSets.builderId, builderId));
    await tx.delete(builders).where(eq(builders.id, builderId));
  });

  revalidatePath("/buyers");
  revalidatePath("/campaigns");
  return { ok: true as const };
}
