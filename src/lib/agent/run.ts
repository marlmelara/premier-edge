import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, contactParcels, contacts, conversations, deals, messages, parcels } from "@/db/schema";
import { fromCents, toCents } from "@/lib/eligibility/offer-math";
import { sendUrgentAlert } from "@/lib/alerts";
import { formatPhone } from "@/lib/format";
import { AgentRefusal, hasAnthropicKey } from "./anthropic";
import { classifyInbound } from "./classify";
import { draftReply } from "./draft";
import { decideOffer, type OfferDecision } from "./negotiation";
import { loadOfferCriteria, probesSent } from "./thread-state";
import {
  acquireRunLock,
  dollarValidationFailures,
  isKillSwitchOn,
  outboundToday,
  releaseRunLock,
  THREAD_DAILY_CAP,
} from "./guardrails";
import { ESCALATING_CLASSES, isConversationState, isTerminal, nextState, type InboundClass } from "./state-machine";

/**
 * The agent turn: one inbound message in, at most one *pending* draft out.
 * Copilot mode (design doc §6) — nothing is ever sent from here. Marlon
 * approves, edits, or rejects in the Deal Room composer.
 */

const CONFIDENCE_FLOOR = 0.7;

export type AgentRunOutcome =
  | { ran: false; reason: string }
  | { ran: true; classification: InboundClass; state: string; drafted: boolean; escalated: boolean };

export async function runAgentTurn(db: Db, conversationId: string): Promise<AgentRunOutcome> {
  if (!hasAnthropicKey()) return { ran: false, reason: "ANTHROPIC_API_KEY not configured" };
  if (await isKillSwitchOn()) {
    await db.insert(agentActions).values({
      conversationId,
      type: "agent_skipped",
      input: { reason: "kill_switch" },
    });
    return { ran: false, reason: "kill switch is on" };
  }
  if (!(await acquireRunLock(conversationId))) return { ran: false, reason: "another run in flight" };

  try {
    return await runTurnInner(db, conversationId);
  } finally {
    await releaseRunLock(conversationId);
  }
}

async function runTurnInner(db: Db, conversationId: string): Promise<AgentRunOutcome> {
  const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!conversation) return { ran: false, reason: "conversation not found" };

  const currentState = isConversationState(conversation.state) ? conversation.state : "NEW";
  if (isTerminal(currentState)) return { ran: false, reason: `conversation is ${currentState}` };

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, conversation.dealId) });
  if (!deal) return { ran: false, reason: "deal not found" };

  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, deal.contactId) });
  if (contact?.optedOut) return { ran: false, reason: "contact opted out" };

  const thread = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: desc(messages.createdAt),
    limit: 12,
  });
  const ordered = [...thread].reverse();
  const latestInbound = [...ordered].reverse().find((m) => m.direction === "inbound");
  if (!latestInbound) return { ran: false, reason: "no inbound message to answer" };
  // Exclude the message under classification by id, not by position: it isn't
  // always last (Marlon may have replied after it).
  const priorThread = ordered.filter((m) => m.id !== latestInbound.id);

  // --- Classify (language only) ---
  let classification;
  try {
    classification = await classifyInbound({
      body: latestInbound.body,
      conversationState: currentState,
      recentThread: priorThread.map((m) => ({ direction: m.direction, body: m.body })),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await db.insert(agentActions).values({
      conversationId,
      type: "classify_failed",
      input: { messageId: latestInbound.id },
      output: { detail },
    });
    await escalate(db, conversationId, `classification failed: ${detail}`, contact?.phone);
    return { ran: true, classification: "off_script", state: "ESCALATED", drafted: false, escalated: true };
  }

  await db.insert(agentActions).values({
    conversationId,
    type: "classified",
    input: { messageId: latestInbound.id, body: latestInbound.body },
    output: classification,
  });
  await db
    .update(messages)
    .set({ classifiedAs: classification.classification, updatedAt: new Date() })
    .where(eq(messages.id, latestInbound.id));

  // --- Code owns the transition ---
  const target = nextState(currentState, classification.classification);
  const lowConfidence = classification.confidence < CONFIDENCE_FLOOR;
  const mustEscalate = ESCALATING_CLASSES.includes(classification.classification) || lowConfidence;

  await db
    .update(conversations)
    .set({ state: mustEscalate ? "ESCALATED" : target, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // The freshest number the seller has named — this message's if they just gave
  // one, otherwise whatever they said before. Read from the classification
  // rather than re-reading the deal: the row we loaded predates this update, and
  // a stale ask is how the agent ends up unable to echo the price they just sent.
  if (classification.seller_counter_amount != null) {
    await db
      .update(deals)
      .set({ sellerCounter: classification.seller_counter_amount.toFixed(2), updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
  }
  const sellerAskCents =
    classification.seller_counter_amount != null
      ? toCents(classification.seller_counter_amount)
      : deal.sellerCounter
        ? toCents(deal.sellerCounter)
        : null;

  if (mustEscalate) {
    const why = lowConfidence
      ? `low confidence (${classification.confidence.toFixed(2)}) on "${latestInbound.body.slice(0, 60)}"`
      : `${classification.classification}: "${latestInbound.body.slice(0, 60)}"`;
    await escalate(db, conversationId, why, contact?.phone);
    return { ran: true, classification: classification.classification, state: "ESCALATED", drafted: false, escalated: true };
  }

  if (classification.classification === "opt_out") {
    await db
      .update(deals)
      .set({ stage: "dead", deadReason: "opted out", updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
    return { ran: true, classification: "opt_out", state: "OPTED_OUT", drafted: false, escalated: false };
  }

  if (classification.classification === "accepted") {
    // The pipeline is a lens on this same row (§5) — advance the deal, not just
    // the conversation, or accepted deals keep showing as needing an offer.
    await db.update(deals).set({ stage: "accepted", updatedAt: new Date() }).where(eq(deals.id, deal.id));
    // Time-sensitive and never auto-answered: contracts are human-driven (§6).
    await sendUrgentAlert(db, {
      type: "offer_accepted",
      conversationId,
      message: `🚨 ACCEPTED — ${contact?.name ?? formatPhone(contact?.phone ?? "")} accepted${deal.lastOffer ? ` $${deal.lastOffer}` : ""}. Open the Deal Room.`,
    });
    return { ran: true, classification: "accepted", state: "ACCEPTED", drafted: false, escalated: false };
  }

  // Wrong number: they don't own it. Unlinking the lot is the whole point —
  // otherwise the next list import or auto-attach hands us the same bad pairing
  // and we text them about it again.
  if (classification.classification === "wrong_person") {
    if (deal.parcelId) {
      await db
        .delete(contactParcels)
        .where(and(eq(contactParcels.contactId, deal.contactId), eq(contactParcels.parcelId, deal.parcelId)));
    }
    await db
      .update(deals)
      .set({
        stage: "dead",
        deadReason: "wrong person — not the owner",
        parcelId: null,
        verdict: "pending",
        matchedBuilderId: null,
        maxOffer: null,
        anchor: null,
        updatedAt: new Date(),
      })
      .where(eq(deals.id, deal.id));
    return { ran: true, classification: "wrong_person", state: "DEAD", drafted: false, escalated: false };
  }

  // Someone swearing at a cold text is not a lead. No reply, no notification.
  if (classification.classification === "hostile") {
    await db
      .update(deals)
      .set({ stage: "dead", deadReason: "hostile reply", updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
    return { ran: true, classification: "hostile", state: "DEAD", drafted: false, escalated: false };
  }

  if (classification.classification === "not_interested") {
    await db
      .update(deals)
      .set({ stage: "dead", deadReason: "seller declined", updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
    return { ran: true, classification: "not_interested", state: "DEAD", drafted: false, escalated: false };
  }

  // --- Guardrail: thread cap ---
  if ((await outboundToday(db, conversationId)) >= THREAD_DAILY_CAP) {
    await db.insert(agentActions).values({
      conversationId,
      type: "agent_skipped",
      input: { reason: "thread_daily_cap", cap: THREAD_DAILY_CAP },
    });
    return { ran: true, classification: classification.classification, state: target, drafted: false, escalated: false };
  }

  // --- Code decides the money, if any ---
  const decision = await decideMove(db, deal.id, conversationId, classification.classification, sellerAskCents);
  if (decision.kind === "ceiling_reached") {
    // The ladder is spent and they still want more. That is not a problem to
    // solve, it is a price we can't pay: label them, keep the lot in the land
    // bank with what they asked for, and move on. A buyer whose numbers work
    // later is exactly what the land bank is for.
    await db
      .update(deals)
      .set({ stage: "dead", deadReason: "wants more than our ceiling", updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
    if (contact) {
      const labels = new Set([...(contact.labels ?? []), "Price dreamer"]);
      await db.update(contacts).set({ labels: [...labels], updatedAt: new Date() }).where(eq(contacts.id, contact.id));
    }
    await db.insert(agentActions).values({
      conversationId,
      type: "ceiling_reached",
      input: { dealId: deal.id, sellerAskCents },
      output: { outcome: "dead — land bank retains the lot and their asking price" },
    });
    return { ran: true, classification: classification.classification, state: "DEAD", drafted: false, escalated: false };
  }
  const authorizedCents = decision.kind === "offer" ? decision.cents : null;

  const parcel = deal.parcelId ? await db.query.parcels.findFirst({ where: eq(parcels.id, deal.parcelId) }) : null;

  // --- Draft, then validate every dollar it wrote ---
  let draft;
  try {
    draft = await draftReply({
      classification: classification.classification,
      conversationState: target,
      intent: decision.intent,
      sellerName: contact?.name,
      parcelAddress: parcel?.address,
      county: parcel?.county,
      authorizedOfferCents: authorizedCents,
      sellerCounterCents: sellerAskCents,
      meetsSellerAsk: decision.kind === "offer" && decision.meetsSellerAsk,
      recentThread: ordered.map((m) => ({ direction: m.direction, body: m.body })),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const isRefusal = error instanceof AgentRefusal;
    await db.insert(agentActions).values({
      conversationId,
      type: "draft_failed",
      input: { classification: classification.classification },
      output: { detail, refusal: isRefusal },
    });
    await escalate(db, conversationId, `draft failed: ${detail}`, contact?.phone);
    return { ran: true, classification: classification.classification, state: "ESCALATED", drafted: false, escalated: true };
  }

  if (!draft.ok) {
    await db.insert(agentActions).values({
      conversationId,
      type: "draft_rejected_dollar_validation",
      input: { classification: classification.classification, intent: decision.intent, authorized: authorizedCents },
      output: { message: draft.message, disallowed: draft.validation.ok ? [] : draft.validation.disallowed },
    });

    // Two failures on a thread means something is wrong with the agent, not the
    // seller — stop trying and get Marlon (§6).
    if ((await dollarValidationFailures(db, conversationId)) >= 2) {
      await escalate(db, conversationId, "agent produced unauthorized dollar amounts twice", contact?.phone);
      await sendUrgentAlert(db, {
        type: "guardrail_bug",
        conversationId,
        message: `⚠️ Agent failed dollar-validation twice on ${formatPhone(contact?.phone ?? "")}. Thread escalated.`,
      });
      return { ran: true, classification: classification.classification, state: "ESCALATED", drafted: false, escalated: true };
    }
    return { ran: true, classification: classification.classification, state: target, drafted: false, escalated: false };
  }

  // --- Pending draft card: nothing sends until Marlon approves ---
  await db.insert(agentActions).values({
    conversationId,
    type: "draft_created",
    input: {
      classification: classification.classification,
      state: target,
      intent: decision.intent,
      authorizedOfferCents: authorizedCents,
      isCeilingOffer: decision.kind === "offer" && decision.isCeiling,
      meetsSellerAsk: decision.kind === "offer" && decision.meetsSellerAsk,
    },
    output: { message: draft.message, notes: draft.notes, amounts: draft.validation.amounts },
  });

  return { ran: true, classification: classification.classification, state: target, drafted: true, escalated: false };
}

/**
 * Load what the negotiation policy needs and let it decide the move: say
 * nothing about money, ask the seller for their number, or name a specific
 * price. Every dollar figure still comes from offer-math (§6) — this only picks
 * *whether* and *when*.
 */
async function decideMove(
  db: Db,
  dealId: string,
  conversationId: string,
  klass: InboundClass,
  sellerAskCents: number | null,
): Promise<OfferDecision> {
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  const criteria = await loadOfferCriteria(db, deal);
  const probes = criteria ? await probesSent(db, conversationId) : 0;

  return decideOffer({
    klass,
    criteria,
    lastOfferCents: deal?.lastOffer ? toCents(deal.lastOffer) : null,
    sellerAskCents,
    probesSoFar: probes,
  });
}

async function escalate(db: Db, conversationId: string, reason: string, phone?: string | null) {
  await db
    .update(conversations)
    .set({ state: "ESCALATED", escalated: true, escalationReason: reason, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  await db.insert(agentActions).values({
    conversationId,
    type: "escalated",
    input: { reason },
  });
  await sendUrgentAlert(db, {
    type: "escalation",
    conversationId,
    message: `🚨 Escalated${phone ? ` — ${formatPhone(phone)}` : ""}: ${reason}`,
  });
}

/** Exported for the offer preview in the Deal Room. */
export function describeOffer(cents: number): string {
  return `$${fromCents(cents)}`;
}
