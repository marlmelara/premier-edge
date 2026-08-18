import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The money paths, against the real local database.
 *
 * These two functions decide what a seller is offered and what land that offer
 * is against — the two things a bug here costs real money on. They were covered
 * only indirectly, through the agent-turn suite, which meant a regression in
 * offer recording or parcel detaching could ship green.
 *
 *   RUN_DB=1 npx dotenv -e .env.local -- vitest run src/app/\(crm\)/actions.money.test.ts
 */

vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { name: "marlon" } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sendivo/send", () => ({ sendSellerMessage: vi.fn(async () => ({ ok: true, messageId: "m1" })) }));
vi.mock("@/lib/alerts", () => ({ sendUrgentAlert: vi.fn(async () => ({ sent: true })) }));

const { getDb } = await import("@/db");
const { agentActions, builders, contactParcels, contacts, conversations, criteriaSets, deals, offers, parcels } =
  await import("@/db/schema");
const { detachParcelAction, resolveDraftAction } = await import("./actions");
const { loadOfferCriteria } = await import("@/lib/agent/thread-state");
const { sendSellerMessage } = await import("@/lib/sendivo/send");

let db: ReturnType<typeof getDb>;
const made: { contacts: string[]; parcels: string[]; builders: string[] } = {
  contacts: [],
  parcels: [],
  builders: [],
};

async function seedDealWithParcel() {
  const phone = `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const [contact] = await db.insert(contacts).values({ phone, source: "inbound" }).returning();
  const [parcel] = await db
    .insert(parcels)
    .values({
      county: "lee",
      parcelId: `TEST-${Math.random().toString(36).slice(2, 10)}`,
      address: "1 TEST LN",
      lastCheckedAt: new Date(),
    })
    .returning();
  const [builder] = await db.insert(builders).values({ name: `Test Buyer ${Date.now()}` }).returning();

  made.contacts.push(contact.id);
  made.parcels.push(parcel.id);
  made.builders.push(builder.id);

  const [deal] = await db
    .insert(deals)
    .values({
      contactId: contact.id,
      parcelId: parcel.id,
      verdict: "pass",
      stage: "verified",
      matchedBuilderId: builder.id,
      maxOffer: "130000.00",
      anchor: "101400.00",
    })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ dealId: deal.id, state: "NEGOTIATING" })
    .returning();

  return { contact, parcel, builder, deal, conversation };
}

describe.skipIf(process.env.RUN_DB !== "1")("money paths", () => {
  beforeEach(() => {
    db ??= getDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const id of made.contacts) {
      const dealRows = await db.select({ id: deals.id }).from(deals).where(eq(deals.contactId, id));
      for (const d of dealRows) {
        const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.dealId, d.id));
        for (const c of convs) {
          await db.delete(agentActions).where(eq(agentActions.conversationId, c.id));
          await db.delete(conversations).where(eq(conversations.id, c.id));
        }
        await db.delete(offers).where(eq(offers.dealId, d.id));
        await db.delete(deals).where(eq(deals.id, d.id));
      }
      await db.delete(contactParcels).where(eq(contactParcels.contactId, id));
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    for (const id of made.parcels) await db.delete(parcels).where(eq(parcels.id, id));
    for (const id of made.builders) {
      await db.delete(criteriaSets).where(eq(criteriaSets.builderId, id));
      await db.delete(builders).where(eq(builders.id, id));
    }
    made.contacts.length = 0;
    made.parcels.length = 0;
    made.builders.length = 0;
  });

  it("records an approved offer exactly once, and moves the deal to it", async () => {
    const { deal, conversation } = await seedDealWithParcel();
    const [draft] = await db
      .insert(agentActions)
      .values({
        conversationId: conversation.id,
        type: "draft_created",
        input: { intent: "offer", authorizedOfferCents: 10_140_000, classification: "counter_offer" },
        output: { message: "We can do $101,400 on the lot.", notes: "anchor" },
      })
      .returning();

    const result = await resolveDraftAction(conversation.id, draft.id, {
      action: "approve",
      body: "We can do $101,400 on the lot.",
    });
    expect(result.ok).toBe(true);
    expect(sendSellerMessage).toHaveBeenCalledOnce();

    const written = await db.select().from(offers).where(eq(offers.dealId, deal.id));
    expect(written).toHaveLength(1);
    expect(Number(written[0].amount)).toBe(101_400);
    expect(written[0].version).toBe(1);

    const [after] = await db.select().from(deals).where(eq(deals.id, deal.id));
    expect(Number(after.lastOffer)).toBe(101_400);
    expect(after.stage).toBe("offer");
  });

  it("does not record a second offer when a nudge restates the same number", async () => {
    // A nudge carries the standing amount so the model may repeat it. Recording
    // it again would stack duplicate versions at one price and make the ladder
    // think we'd already moved.
    const { deal, conversation } = await seedDealWithParcel();
    const [draft] = await db
      .insert(agentActions)
      .values({
        conversationId: conversation.id,
        type: "draft_created",
        input: { intent: "nudge", authorizedOfferCents: 10_140_000, classification: "followup" },
        output: { message: "Just checking that $101,400 works for you.", notes: "nudge" },
      })
      .returning();

    await resolveDraftAction(conversation.id, draft.id, {
      action: "approve",
      body: "Just checking that $101,400 works for you.",
    });

    expect(await db.select().from(offers).where(eq(offers.dealId, deal.id))).toHaveLength(0);
  });

  it("refuses to resolve a draft twice", async () => {
    const { conversation } = await seedDealWithParcel();
    const [draft] = await db
      .insert(agentActions)
      .values({
        conversationId: conversation.id,
        type: "draft_created",
        input: { intent: "probe", classification: "interested" },
        output: { message: "What were you hoping to get for it?", notes: "probe" },
      })
      .returning();

    expect((await resolveDraftAction(conversation.id, draft.id, { action: "approve", body: "What were you hoping to get for it?" })).ok).toBe(true);
    const second = await resolveDraftAction(conversation.id, draft.id, { action: "approve", body: "again" });
    expect(second.ok).toBe(false);
    expect(sendSellerMessage).toHaveBeenCalledOnce();
  });

  it("prices off the scoped buy box and the lot's utilities, not the base price", async () => {
    // The bug this pins: loadOfferCriteria used findFirst by builder, so with
    // several buy boxes it picked an arbitrary one and always read the base
    // price. A Cape Coral lot on septic would have been priced off the
    // headline number and the spread would vanish at closing.
    const { deal, parcel, builder } = await seedDealWithParcel();

    await db
      .update(parcels)
      .set({ address: "1 TEST LN, CAPE CORAL", waterSource: "city", sewerType: "septic" })
      .where(eq(parcels.id, parcel.id));

    // A county-wide box the lot also matches, and a tighter Cape Coral one.
    await db.insert(criteriaSets).values([
      {
        builderId: builder.id,
        name: "Lee county-wide",
        county: "lee",
        minSqft: 5000,
        allowedFloodZones: ["X"],
        wetlandsAllowed: false,
        builderBuyPrice: "200000.00",
        minAssignmentFee: "5000.00",
        anchorPct: "0.780",
      },
      {
        builderId: builder.id,
        name: "Cape Coral",
        county: "lee",
        cities: ["Cape Coral"],
        minSqft: 5000,
        allowedFloodZones: ["X"],
        wetlandsAllowed: false,
        builderBuyPrice: "135000.00",
        minAssignmentFee: "5000.00",
        anchorPct: "0.780",
        utilityRules: [
          { water: "city", sewer: "city", buyPriceCents: 13_500_000, accepted: true },
          { water: "city", sewer: "septic", buyPriceCents: 12_000_000, accepted: true },
        ],
      },
    ]);

    const [full] = await db.select().from(deals).where(eq(deals.id, deal.id));
    const criteria = await loadOfferCriteria(db, full);

    // Cape Coral beats county-wide, and septic beats the base price.
    expect(criteria).not.toBeNull();
    expect(criteria!.builderBuyPrice).toBe(12_000_000);
    expect(criteria!.minAssignmentFee).toBe(500_000);
  });

  it("refuses to price when the buyer won't take the lot's utilities", async () => {
    const { deal, parcel, builder } = await seedDealWithParcel();
    await db
      .update(parcels)
      .set({ address: "1 TEST LN, CAPE CORAL", waterSource: "well", sewerType: "city" })
      .where(eq(parcels.id, parcel.id));

    await db.insert(criteriaSets).values({
      builderId: builder.id,
      name: "Cape Coral",
      county: "lee",
      minSqft: 5000,
      allowedFloodZones: ["X"],
      wetlandsAllowed: false,
      builderBuyPrice: "135000.00",
      minAssignmentFee: "5000.00",
      anchorPct: "0.780",
      utilityRules: [{ water: "well", sewer: "city", accepted: false }],
    });

    const [full] = await db.select().from(deals).where(eq(deals.id, deal.id));
    // No criteria means no price is authorized at all — the correct outcome
    // for a combination this buyer refuses.
    expect(await loadOfferCriteria(db, full)).toBeNull();
  });

  it("clears every number derived from the lot when the parcel is detached", async () => {
    // The verdict, matched buyer, max offer and anchor were all computed for
    // THAT lot. Leaving them behind would let the agent price a deal against
    // land it is no longer about.
    const { deal } = await seedDealWithParcel();

    const result = await detachParcelAction(deal.id);
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(deals).where(eq(deals.id, deal.id));
    expect(after.parcelId).toBeNull();
    expect(after.verdict).toBe("pending");
    expect(after.matchedBuilderId).toBeNull();
    expect(after.maxOffer).toBeNull();
    expect(after.anchor).toBeNull();
    expect(after.stage).toBe("qualifying");
  });
});
