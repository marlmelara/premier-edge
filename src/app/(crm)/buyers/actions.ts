"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/db";
import { builders, campaignBuilders, criteriaSets } from "@/db/schema";

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
