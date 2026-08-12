import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { contacts, conversations, deals, messages, optOuts } from "@/db/schema";
import { isOptOutMessage, normalizePhone, type SendivoInboundMessage } from "./webhook-schema";

export type IngestResult =
  | { outcome: "persisted"; contactId: string; conversationId: string; messageId: string; optedOut: boolean }
  | { outcome: "duplicate" };

/**
 * Persist one inbound Sendivo message: upsert contact by phone, find-or-create
 * the deal + conversation spine, insert the message (deduped on
 * sendivo_message_id), and enforce local opt-out immediately on STOP keywords.
 *
 * Sendivo contact enrichment (GET /contacts on first inbound) is a follow-up —
 * it needs the API key (open item #1).
 */
export async function ingestInboundMessage(db: Db, payload: SendivoInboundMessage): Promise<IngestResult> {
  const msg = payload.message;
  const phone = normalizePhone(msg.from);

  return db.transaction(async (tx) => {
    // Dedupe first: Sendivo retries webhooks, and we may see the same message id twice.
    const existing = await tx.query.messages.findFirst({
      where: eq(messages.sendivoMessageId, msg.id),
      columns: { id: true },
    });
    if (existing) return { outcome: "duplicate" as const };

    const [contact] = await tx
      .insert(contacts)
      .values({ phone, source: "inbound", sendivoContactId: msg.contact_id })
      .onConflictDoUpdate({
        target: contacts.phone,
        set: { updatedAt: new Date() },
      })
      .returning();

    // Conversation: match by Sendivo's conversation id when present, else the
    // contact's most recent conversation, else create a fresh deal + conversation.
    let conversation =
      msg.conversation_id != null
        ? await tx.query.conversations.findFirst({
            where: eq(conversations.sendivoConversationId, msg.conversation_id),
          })
        : undefined;

    if (!conversation) {
      const contactDeals = await tx.query.deals.findMany({
        where: eq(deals.contactId, contact.id),
        columns: { id: true },
        orderBy: desc(deals.createdAt),
      });
      if (contactDeals.length > 0) {
        conversation = await tx.query.conversations.findFirst({
          where: eq(conversations.dealId, contactDeals[0].id),
          orderBy: desc(conversations.createdAt),
        });
      }
    }

    if (!conversation) {
      const [deal] = await tx.insert(deals).values({ contactId: contact.id }).returning();
      [conversation] = await tx
        .insert(conversations)
        .values({ dealId: deal.id, sendivoConversationId: msg.conversation_id })
        .returning();
    }

    const receivedAt = msg.received_at ? new Date(msg.received_at) : new Date();
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "inbound",
        body: msg.body,
        sendivoMessageId: msg.id,
        status: "received",
      })
      .returning();

    await tx
      .update(conversations)
      .set({ lastInboundAt: receivedAt, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));

    // Local opt-out enforcement — checked before EVERY send, recorded at ingest.
    const optedOut = isOptOutMessage(msg.body);
    if (optedOut) {
      await tx.insert(optOuts).values({ phone, source: "inbound_keyword" }).onConflictDoNothing();
      await tx.update(contacts).set({ optedOut: true, updatedAt: new Date() }).where(eq(contacts.id, contact.id));
      await tx
        .update(conversations)
        .set({ state: "OPTED_OUT", updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));
    }

    return {
      outcome: "persisted" as const,
      contactId: contact.id,
      conversationId: conversation.id,
      messageId: message.id,
      optedOut,
    };
  });
}
