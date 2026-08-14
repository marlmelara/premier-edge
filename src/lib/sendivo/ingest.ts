import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { contacts, conversations, deals, messages, optOuts } from "@/db/schema";
import type { SendivoContact } from "./client";
import { isOptOutMessage, normalizePhone, type ClassifiedWebhook } from "./webhook-schema";

export type InboundMessage = Extract<ClassifiedWebhook, { kind: "inbound" }>;

export type ContactEnrichment = {
  sendivoContactId: string;
  name?: string;
  email?: string;
  altPhones?: string[];
  mailingStreet?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
  labels?: string[];
  notes?: string;
  optedOut?: boolean;
  raw: unknown;
};

/** Map a Sendivo contact to our enrichment fields (merge policy: ours wins after first pull). */
export function mapSendivoContact(c: SendivoContact): ContactEnrichment {
  const name = c.full_name ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? undefined;
  return {
    sendivoContactId: String(c.id),
    name: name || undefined,
    email: c.email ?? undefined,
    altPhones: c.alternative_mobile_numbers ?? undefined,
    mailingStreet: [c.address_line1, c.address_line2].filter(Boolean).join(", ") || undefined,
    mailingCity: c.city ?? undefined,
    mailingState: c.state ?? undefined,
    mailingZip: c.postal_code ?? undefined,
    labels: c.labels?.map((l) => l.name),
    notes: c.notes ?? undefined,
    optedOut: c.opted_out ?? undefined,
    raw: c,
  };
}

export type IngestOptions = {
  /** Called for contacts we haven't enriched yet; network errors should be caught by the caller and yield null. */
  enrich?: (phone: string) => Promise<ContactEnrichment | null>;
};

export type IngestResult =
  | {
      outcome: "persisted";
      contactId: string;
      dealId: string;
      conversationId: string;
      messageId: string;
      optedOut: boolean;
    }
  | { outcome: "duplicate" };

/**
 * Persist one inbound Sendivo message: upsert contact by phone (with
 * first-inbound enrichment, §2.4), find-or-create the deal + conversation
 * spine, insert the message (deduped on sendivo_message_id), and enforce
 * local opt-out immediately on STOP keywords.
 */
export async function ingestInboundMessage(
  db: Db,
  msg: InboundMessage,
  opts?: IngestOptions,
): Promise<IngestResult> {
  const phone = normalizePhone(msg.from);

  // Dedupe before doing any work: Sendivo retries webhooks.
  const existingMsg = await db.query.messages.findFirst({
    where: eq(messages.sendivoMessageId, msg.sendivoMessageId),
    columns: { id: true },
  });
  if (existingMsg) return { outcome: "duplicate" };

  // Enrichment happens outside the transaction (it's a network call) and only
  // on first inbound — i.e. when the contact is unknown or never enriched.
  const known = await db.query.contacts.findFirst({
    where: eq(contacts.phone, phone),
    columns: { id: true, sendivoContactId: true },
  });
  const enrichment = !known?.sendivoContactId && opts?.enrich ? await opts.enrich(phone) : null;

  return db.transaction(async (tx) => {
    const coalesce = (column: unknown, value: string | undefined) =>
      value === undefined ? undefined : sql`COALESCE(${column}, ${value})`;

    const [contact] = await tx
      .insert(contacts)
      .values({
        phone,
        source: "inbound",
        sendivoContactId: enrichment?.sendivoContactId ?? msg.contactId,
        name: enrichment?.name,
        email: enrichment?.email,
        altPhones: enrichment?.altPhones,
        mailingStreet: enrichment?.mailingStreet,
        mailingCity: enrichment?.mailingCity,
        mailingState: enrichment?.mailingState,
        mailingZip: enrichment?.mailingZip,
        labels: enrichment?.labels,
        notes: enrichment?.notes,
        sendivoRaw: enrichment?.raw,
      })
      .onConflictDoUpdate({
        target: contacts.phone,
        // Merge policy: fill blanks only — after the first pull, ours wins.
        set: {
          sendivoContactId: coalesce(contacts.sendivoContactId, enrichment?.sendivoContactId ?? msg.contactId),
          name: coalesce(contacts.name, enrichment?.name),
          email: coalesce(contacts.email, enrichment?.email),
          notes: coalesce(contacts.notes, enrichment?.notes),
          ...(enrichment?.raw !== undefined
            ? { sendivoRaw: sql`COALESCE(${contacts.sendivoRaw}, ${JSON.stringify(enrichment.raw)}::jsonb)` }
            : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    // Conversation: match by Sendivo's conversation id when present, else the
    // contact's most recent conversation, else create a fresh deal + conversation.
    let conversation =
      msg.conversationId != null
        ? await tx.query.conversations.findFirst({
            where: eq(conversations.sendivoConversationId, msg.conversationId),
          })
        : undefined;

    if (!conversation) {
      const latestDeal = await tx.query.deals.findFirst({
        where: eq(deals.contactId, contact.id),
        columns: { id: true },
        orderBy: desc(deals.createdAt),
      });
      if (latestDeal) {
        conversation = await tx.query.conversations.findFirst({
          where: eq(conversations.dealId, latestDeal.id),
          orderBy: desc(conversations.createdAt),
        });
        // Backfill the Sendivo conversation id if we only just learned it.
        if (conversation && !conversation.sendivoConversationId && msg.conversationId) {
          await tx
            .update(conversations)
            .set({ sendivoConversationId: msg.conversationId })
            .where(eq(conversations.id, conversation.id));
        }
      }
    }

    if (!conversation) {
      const [deal] = await tx.insert(deals).values({ contactId: contact.id }).returning();
      [conversation] = await tx
        .insert(conversations)
        .values({ dealId: deal.id, sendivoConversationId: msg.conversationId })
        .returning();
    }

    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "inbound",
        body: msg.body,
        sendivoMessageId: msg.sendivoMessageId,
        status: "received",
      })
      .returning();

    await tx
      .update(conversations)
      .set({ lastInboundAt: msg.receivedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));

    // Local opt-out enforcement — checked before EVERY send, recorded at ingest.
    // Sendivo-side opt-out flags from enrichment are honored too.
    const optedOut = isOptOutMessage(msg.body) || enrichment?.optedOut === true;
    if (optedOut) {
      const source = isOptOutMessage(msg.body) ? "inbound_keyword" : "sendivo_sync";
      await tx.insert(optOuts).values({ phone, source }).onConflictDoNothing();
      await tx.update(contacts).set({ optedOut: true, updatedAt: new Date() }).where(eq(contacts.id, contact.id));
      await tx
        .update(conversations)
        .set({ state: "OPTED_OUT", updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));
    }

    return {
      outcome: "persisted" as const,
      contactId: contact.id,
      dealId: conversation.dealId,
      conversationId: conversation.id,
      messageId: message.id,
      optedOut,
    };
  });
}
