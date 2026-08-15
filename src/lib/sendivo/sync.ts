import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, contacts, conversations, deals, messages } from "@/db/schema";
import { env } from "@/env";
import { getPhoneNumbers, getSmsLogs, type SendivoSmsLog } from "./client";
import { normalizePhone } from "./webhook-schema";

/**
 * Pull Sendivo's SMS logs into Premier Edge (§11g, Aug 15 2026).
 *
 * `GET /sms/logs` is the only readable message endpoint Sendivo exposes, and it
 * carries **outbound only** — verified by walking six weeks and finding 10,153
 * rows, every one from one of our own numbers. Seller replies arrive solely by
 * webhook.
 *
 * That still makes this the missing piece. Every number we have ever texted is
 * a `to_number` in these logs, so the blast audience — the contact list the API
 * refuses to enumerate any other way — can be reconstructed from it, along with
 * the full outbound side of every thread. When the webhook starts delivering,
 * replies land on threads that already exist and already know who the seller is.
 *
 * Dedupe rides on `message_id`, the same identifier the webhook sends, so the
 * two paths can never double-insert the same message.
 */

/** Sendivo caps a logs query at 7 days. */
const WINDOW_DAYS = 7;
const PAGE_SIZE = 1000;
const CHUNK = 500;

export type SyncResult = {
  windows: number;
  logsSeen: number;
  /** Outbound messages held back because the contact has no thread yet. */
  awaitingThread: number;
  contactsUpserted: number;
  threadsCreated: number;
  messagesInserted: number;
  skippedOwnNumber: number;
  errors: string[];
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function syncSmsLogs(
  db: Db,
  opts: {
    /** Defaults to 90 days back — far enough to cover the campaigns to date. */
    since?: Date;
    until?: Date;
    /**
     * Open a thread for every contact in the logs. Off by default — see
     * ingestLogs. Useful only for a one-off "show me everything" backfill.
     */
    createThreads?: boolean;
    onProgress?: (window: string, logs: number) => void;
  } = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    windows: 0,
    logsSeen: 0,
    awaitingThread: 0,
    contactsUpserted: 0,
    threadsCreated: 0,
    messagesInserted: 0,
    skippedOwnNumber: 0,
    errors: [],
  };

  // Our own numbers decide direction; without them every row looks ambiguous.
  const ourNumbers = new Set((await getPhoneNumbers()).map((n) => normalizePhone(n.phone_number)));
  if (ourNumbers.size === 0) {
    result.errors.push("Sendivo returned no phone numbers — cannot tell inbound from outbound");
    return result;
  }
  // Briefings and alerts go to Marlon's cell. They're our own operational SMS,
  // not a seller conversation, and would otherwise create a contact for him.
  const marlon = env().MARLON_PHONE ? normalizePhone(env().MARLON_PHONE!) : null;

  const until = opts.until ?? new Date();
  const since = opts.since ?? new Date(until.getTime() - 90 * 86_400_000);

  for (let start = new Date(since); start <= until; ) {
    const end = new Date(Math.min(start.getTime() + (WINDOW_DAYS - 1) * 86_400_000, until.getTime()));
    const window = `${isoDate(start)}..${isoDate(end)}`;
    result.windows += 1;

    let logs: SendivoSmsLog[] = [];
    try {
      for (let page = 1; ; page++) {
        const data = await getSmsLogs({ startDate: isoDate(start), endDate: isoDate(end), page, perPage: PAGE_SIZE });
        logs = logs.concat(data.logs);
        if (!data.pagination?.has_more) break;
      }
    } catch (error) {
      result.errors.push(`${window}: ${error instanceof Error ? error.message : String(error)}`);
      start = new Date(end.getTime() + 86_400_000);
      continue;
    }

    result.logsSeen += logs.length;
    opts.onProgress?.(window, logs.length);
    await ingestLogs(db, logs, ourNumbers, marlon, result, opts.createThreads ?? false);

    start = new Date(end.getTime() + 86_400_000);
  }

  await db.insert(agentActions).values({
    type: "sendivo_sync",
    input: { since: since.toISOString(), until: until.toISOString() },
    output: { ...result, errors: result.errors.slice(0, 10) },
  });

  return result;
}

type Normalized = {
  counterparty: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: Date;
  sendivoMessageId: string | null;
  status: string | null;
};

async function ingestLogs(
  db: Db,
  logs: SendivoSmsLog[],
  ourNumbers: Set<string>,
  marlon: string | null,
  result: SyncResult,
  createThreads: boolean,
): Promise<void> {
  const normalized: Normalized[] = [];

  for (const log of logs) {
    const from = normalizePhone(log.from_number);
    const to = normalizePhone(log.to_number);
    const outbound = ourNumbers.has(from);
    const inbound = ourNumbers.has(to);
    if (!outbound && !inbound) continue; // neither side is ours — not our traffic

    const counterparty = outbound ? to : from;
    // Our own alerting, not a seller thread.
    if (marlon && counterparty === marlon) {
      result.skippedOwnNumber += 1;
      continue;
    }
    if (ourNumbers.has(counterparty)) {
      result.skippedOwnNumber += 1;
      continue;
    }

    normalized.push({
      counterparty,
      direction: outbound ? "outbound" : "inbound",
      body: log.message_content,
      sentAt: new Date(log.created_at),
      sendivoMessageId: log.message_id ?? null,
      status: log.status ?? null,
    });
  }

  if (normalized.length === 0) return;

  const phones = [...new Set(normalized.map((n) => n.counterparty))];

  // 1. Contacts. Blast recipients, so `source: blast`; fill-blanks only, since
  //    anything we already know came from a later, better source.
  for (const chunk of chunked(phones, CHUNK)) {
    await db
      .insert(contacts)
      .values(chunk.map((phone) => ({ phone, source: "blast" as const })))
      .onConflictDoNothing({ target: contacts.phone });
  }
  result.contactsUpserted += phones.length;

  const contactRows = await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(inArray(contacts.phone, phones));
  const contactByPhone = new Map(contactRows.map((c) => [c.phone, c.id]));

  // 2. One thread per contact. Reuse an existing one so a re-sync doesn't fork
  //    the conversation.
  const contactIds = [...contactByPhone.values()];
  const existing = await db
    .select({ contactId: deals.contactId, conversationId: conversations.id })
    .from(conversations)
    .innerJoin(deals, eq(conversations.dealId, deals.id))
    .where(inArray(deals.contactId, contactIds));
  const conversationByContact = new Map(existing.map((r) => [r.contactId, r.conversationId]));

  // Only contacts who already have a thread get their outbound history filed.
  //
  // A blast recipient who never replied is a *contact*, not a conversation —
  // opening 7,000 threads would bury the handful of real negotiations in both
  // the Deal Room list and the pipeline, neither of which filters them out.
  // When someone does reply the webhook creates their thread, and the next sync
  // backfills everything we ever sent them into it.
  const needThread = createThreads ? contactIds.filter((id) => !conversationByContact.has(id)) : [];
  for (const chunk of chunked(needThread, CHUNK)) {
    const newDeals = await db
      .insert(deals)
      .values(chunk.map((contactId) => ({ contactId })))
      .returning({ id: deals.id, contactId: deals.contactId });
    const newConversations = await db
      .insert(conversations)
      .values(newDeals.map((d) => ({ dealId: d.id, state: "NEW" as const })))
      .returning({ id: conversations.id, dealId: conversations.dealId });

    const dealToContact = new Map(newDeals.map((d) => [d.id, d.contactId]));
    for (const c of newConversations) {
      const contactId = dealToContact.get(c.dealId);
      if (contactId) conversationByContact.set(contactId, c.id);
    }
    result.threadsCreated += chunk.length;
  }

  // 3. Messages. `sendivo_message_id` is unique, so conflicts are the dedupe —
  //    a re-sync, or a webhook that already delivered this message, is a no-op.
  const rows = normalized
    .map((n) => {
      const contactId = contactByPhone.get(n.counterparty);
      const conversationId = contactId ? conversationByContact.get(contactId) : undefined;
      if (!conversationId) {
        result.awaitingThread += 1;
        return null;
      }
      return {
        conversationId,
        direction: n.direction,
        body: n.body,
        sendivoMessageId: n.sendivoMessageId,
        status: n.status,
        sentBy: n.direction === "outbound" ? ("marlon" as const) : undefined,
        createdAt: n.sentAt,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    // Rows with no message_id can't be deduped by conflict, so they'd duplicate
    // on every sync. Sendivo has always supplied one; dropping the rest is safer
    // than growing the thread each run.
    .filter((r) => r.sendivoMessageId !== null);

  for (const chunk of chunked(rows, CHUNK)) {
    const inserted = await db
      .insert(messages)
      .values(chunk)
      .onConflictDoNothing({ target: messages.sendivoMessageId })
      .returning({ id: messages.id });
    result.messagesInserted += inserted.length;
  }

  // 4. Keep the thread's activity timestamps honest for the follow-up sweep.
  //    Nothing to update when no contact in this window has a thread — and an
  //    empty IN () list is a syntax error, not a no-op.
  if (conversationByContact.size === 0) return;
  await db.execute(sql`
    UPDATE conversations c SET
      last_outbound_at = s.last_out,
      last_inbound_at  = COALESCE(s.last_in, c.last_inbound_at),
      updated_at = now()
    FROM (
      SELECT conversation_id,
             max(created_at) FILTER (WHERE direction = 'outbound') AS last_out,
             max(created_at) FILTER (WHERE direction = 'inbound')  AS last_in
      FROM messages
      WHERE conversation_id IN (${sql.join([...conversationByContact.values()].map((id) => sql`${id}::uuid`), sql`, `)})
      GROUP BY conversation_id
    ) s
    WHERE c.id = s.conversation_id
  `);
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
