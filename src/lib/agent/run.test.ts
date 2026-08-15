import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent-turn wiring, verified against the real local database with the two
 * model calls mocked. This is the guardrail suite: it proves an off-script
 * message escalates, an unauthorized dollar figure is rejected, the thread cap
 * holds, and — most importantly — that nothing is ever sent without approval.
 *
 * Requires the local Postgres from docker-compose:
 *   RUN_DB=1 npx dotenv -e .env.local -- vitest run src/lib/agent/run.test.ts
 */

vi.mock("./anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./anthropic")>()),
  hasAnthropicKey: () => true,
}));
vi.mock("./classify", () => ({ classifyInbound: vi.fn() }));
vi.mock("./draft", () => ({ draftReply: vi.fn() }));
vi.mock("@/lib/alerts", () => ({ sendUrgentAlert: vi.fn(async () => ({ sent: true })) }));

const { classifyInbound } = await import("./classify");
const { draftReply } = await import("./draft");
const { sendUrgentAlert } = await import("@/lib/alerts");
const { getDb } = await import("@/db");
const { agentActions, contacts, conversations, deals, messages } = await import("@/db/schema");
const { runAgentTurn } = await import("./run");
const { getPendingDraft } = await import("./drafts");

// Resolved in beforeEach, not at import: getDb() validates the environment, and
// this file is imported even when the suite is skipped.
let db: ReturnType<typeof getDb>;
let conversationId: string;
let contactId: string;

async function seedThread(inbound: string) {
  const phone = `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const [contact] = await db.insert(contacts).values({ phone, source: "inbound" }).returning();
  const [deal] = await db.insert(deals).values({ contactId: contact.id }).returning();
  const [conversation] = await db.insert(conversations).values({ dealId: deal.id, state: "NEW" }).returning();
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: "inbound",
    body: inbound,
    sendivoMessageId: `test_${crypto.randomUUID()}`,
  });
  contactId = contact.id;
  conversationId = conversation.id;
  return { contact, deal, conversation };
}

const classification = (over: Partial<Awaited<ReturnType<typeof classifyInbound>>> = {}) => ({
  classification: "interested" as const,
  confidence: 0.95,
  seller_counter_amount: null,
  utilities_water: null,
  utilities_sewer: null,
  reasoning: "test",
  ...over,
});

describe.skipIf(process.env.RUN_DB !== "1")("runAgentTurn", () => {
  beforeEach(() => {
    db ??= getDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (!conversationId) return;
    await db.delete(agentActions).where(eq(agentActions.conversationId, conversationId));
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    if (conv) await db.delete(deals).where(eq(deals.id, conv.dealId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  });

  it("produces a pending draft and sends nothing", async () => {
    await seedThread("Yes, I still own it. What are you thinking?");
    vi.mocked(classifyInbound).mockResolvedValue(classification());
    vi.mocked(draftReply).mockResolvedValue({
      ok: true,
      message: "Thanks for getting back to us — is the lot still vacant?",
      notes: "qualify before pricing",
      validation: { ok: true, amounts: [] },
    });

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ ran: true, drafted: true, escalated: false });

    const draft = await getPendingDraft(db, conversationId);
    expect(draft?.message).toContain("still vacant");

    // The whole point of copilot mode: no outbound row exists yet.
    const outbound = await db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
    });
    expect(outbound.filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  it("escalates an off-script message and alerts Marlon instead of drafting", async () => {
    await seedThread("My attorney will be contacting you about this");
    vi.mocked(classifyInbound).mockResolvedValue(classification({ classification: "off_script", confidence: 0.9 }));

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ escalated: true, drafted: false });
    expect(draftReply).not.toHaveBeenCalled();
    expect(sendUrgentAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "escalation" }),
    );

    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
    expect(conv?.state).toBe("ESCALATED");
    expect(conv?.escalated).toBe(true);
  });

  it("escalates when the classifier is unsure rather than guessing", async () => {
    await seedThread("maybe? depends");
    vi.mocked(classifyInbound).mockResolvedValue(classification({ confidence: 0.4 }));

    const result = await runAgentTurn(db, conversationId);
    expect(result.ran && result.escalated).toBe(true);
    expect(draftReply).not.toHaveBeenCalled();
  });

  it("rejects a draft containing an unauthorized dollar amount", async () => {
    await seedThread("What would you pay?");
    vi.mocked(classifyInbound).mockResolvedValue(classification({ classification: "asking_price" }));
    vi.mocked(draftReply).mockResolvedValue({
      ok: false,
      reason: "dollar_validation",
      message: "We could do around $30,000 for it.",
      notes: "",
      validation: { ok: false, amounts: [3_000_000], disallowed: [3_000_000] },
    });

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ drafted: false });
    expect(await getPendingDraft(db, conversationId)).toBeNull();

    const actions = await db.query.agentActions.findMany({
      where: eq(agentActions.conversationId, conversationId),
    });
    expect(actions.map((a) => a.type)).toContain("draft_rejected_dollar_validation");
  });

  it("alerts on acceptance without drafting a reply", async () => {
    await seedThread("Yes, I accept that price");
    vi.mocked(classifyInbound).mockResolvedValue(classification({ classification: "accepted" }));

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ state: "ACCEPTED", drafted: false });
    expect(draftReply).not.toHaveBeenCalled();
    expect(sendUrgentAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "offer_accepted" }),
    );
  });

  it("stops at the daily thread cap", async () => {
    const { conversation } = await seedThread("Still interested, tell me more");
    for (let i = 0; i < 3; i++) {
      await db.insert(messages).values({
        conversationId: conversation.id,
        direction: "outbound",
        body: `prior ${i}`,
        sendivoMessageId: `test_out_${crypto.randomUUID()}`,
        sentBy: "agent",
      });
    }
    vi.mocked(classifyInbound).mockResolvedValue(classification());

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ drafted: false });
    expect(draftReply).not.toHaveBeenCalled();
  });

  it("does not run on a terminal conversation", async () => {
    await seedThread("stop");
    await db.update(conversations).set({ state: "OPTED_OUT" }).where(eq(conversations.id, conversationId));

    const result = await runAgentTurn(db, conversationId);
    expect(result).toMatchObject({ ran: false });
    expect(classifyInbound).not.toHaveBeenCalled();
  });
});
