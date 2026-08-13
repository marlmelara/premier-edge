import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, contacts, conversations, deals, messages, optOuts } from "@/db/schema";
import { sendConversationMessage } from "./client";

/**
 * The ONLY path for seller-facing sends. Guardrails live in code (§6):
 * opt-out gate + quiet hours run on every send — Marlon's included ("minus
 * approval", §2.1). Every send and every block is logged to agent_actions.
 */

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; blocked: "opted_out" | "quiet_hours" | "no_sendivo_conversation" | "send_failed"; reason: string };

/** Quiet hours: 8am–9pm seller-local. Launch counties are all Eastern. */
export function isWithinQuietHours(now: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now),
  );
  return hour < 8 || hour >= 21;
}

export async function sendSellerMessage(
  db: Db,
  conversationId: string,
  body: string,
  sentBy: "agent" | "marlon",
): Promise<SendResult> {
  const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!conversation) return { ok: false, blocked: "send_failed", reason: "conversation not found" };

  const deal = await db.query.deals.findFirst({ where: eq(deals.id, conversation.dealId) });
  const contact = deal ? await db.query.contacts.findFirst({ where: eq(contacts.id, deal.contactId) }) : null;
  if (!contact) return { ok: false, blocked: "send_failed", reason: "contact not found" };

  const block = async (
    blocked: "opted_out" | "quiet_hours" | "no_sendivo_conversation",
    reason: string,
  ): Promise<SendResult> => {
    await db.insert(agentActions).values({
      conversationId,
      type: "send_blocked",
      input: { body, sentBy, blocked, reason },
    });
    return { ok: false, blocked, reason };
  };

  // Opt-out gate — checked before EVERY send (§5).
  const optedOut = await db.query.optOuts.findFirst({ where: eq(optOuts.phone, contact.phone) });
  if (optedOut || contact.optedOut) {
    return block("opted_out", `${contact.phone} opted out`);
  }

  if (isWithinQuietHours()) {
    return block("quiet_hours", "outside 8am–9pm seller-local");
  }

  if (!conversation.sendivoConversationId || !/^\d+$/.test(conversation.sendivoConversationId)) {
    return block(
      "no_sendivo_conversation",
      "no numeric Sendivo conversation id yet — arrives with the first live inbound webhook",
    );
  }

  // The takeover: threads the reply AND permanently kills Sendivo's AI for
  // this thread. Sending IS the takeover — there is no resume (§6).
  let sendivoMessageId: string;
  try {
    const result = await sendConversationMessage(Number(conversation.sendivoConversationId), body);
    sendivoMessageId = result.message_id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.insert(agentActions).values({
      conversationId,
      type: "send_failed",
      input: { body, sentBy },
      output: { reason },
    });
    return { ok: false, blocked: "send_failed", reason };
  }

  // The SMS is already delivered at this point. If we can't record it, the
  // thread cap and the audit trail silently under-count — so fail loudly rather
  // than letting the agent send past its daily cap on this thread.
  let message;
  try {
    [message] = await db
      .insert(messages)
      .values({
        conversationId,
        direction: "outbound",
        body,
        sendivoMessageId,
        status: "pending",
        sentBy,
      })
      .returning();

    await db
      .update(conversations)
      .set({ lastOutboundAt: new Date(), ownedByEdge: true, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[send] message sent but not recorded", reason);
    await db
      .insert(agentActions)
      .values({
        conversationId,
        type: "message_sent_unrecorded",
        input: { body, sentBy, sendivoMessageId },
        output: { reason },
      })
      .catch(() => {});
    return { ok: false, blocked: "send_failed", reason: `delivered, but not recorded: ${reason}` };
  }

  await db.insert(agentActions).values({
    conversationId,
    type: "message_sent",
    input: { body, sentBy },
    output: { sendivoMessageId, messageId: message.id },
    approvedBy: sentBy === "marlon" ? "marlon" : undefined,
  });

  return { ok: true, messageId: message.id };
}
