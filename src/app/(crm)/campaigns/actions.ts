"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/db";
import { campaigns, deals } from "@/db/schema";

async function requireSession() {
  const session = await auth();
  if (!session?.user) throw new Error("unauthorized");
}

const STATUSES = ["draft", "ready", "live", "paused", "done"] as const;
type Status = (typeof STATUSES)[number];

/**
 * Create or rename a campaign.
 *
 * There was no way to make one in the UI at all — the first campaign had to be
 * seeded by script, which meant a second market couldn't be started without a
 * developer. A campaign is what ties buyers to a market, and eligibility can't
 * run without one, so this is the first thing a new market needs.
 */
export async function saveCampaignAction(formData: FormData) {
  await requireSession();
  const db = getDb();

  const id = String(formData.get("id") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false as const, reason: "a campaign needs a name" };

  const rawStatus = String(formData.get("status") ?? "draft");
  const status: Status = (STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as Status) : "draft";

  const fields = {
    name,
    market: String(formData.get("market") ?? "").trim() || null,
    status,
    // Sendivo's own campaign id, so blast metrics can be tied back later.
    sendivoCampaignId: String(formData.get("sendivoCampaignId") ?? "").trim() || null,
    updatedAt: new Date(),
  };

  if (id) await db.update(campaigns).set(fields).where(eq(campaigns.id, id));
  else await db.insert(campaigns).values(fields);

  revalidatePath("/campaigns");
  revalidatePath("/buyers");
  return { ok: true as const };
}

/**
 * Delete a campaign. Refused while deals reference it — those deals were
 * priced against the buyers attached here, and orphaning them would leave
 * live negotiations pointing at a campaign that no longer exists.
 */
export async function deleteCampaignAction(campaignId: string) {
  await requireSession();
  const db = getDb();

  const attached = await db.query.deals.findFirst({ where: eq(deals.campaignId, campaignId) });
  if (attached) {
    return { ok: false as const, reason: "deals reference this campaign — pause it instead of deleting" };
  }

  await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  revalidatePath("/campaigns");
  return { ok: true as const };
}
