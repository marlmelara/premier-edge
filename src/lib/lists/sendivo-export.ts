import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { contacts, conversations, deals, messages, optOuts } from "@/db/schema";
import { mapHeaders, normalizeListPhone, parseCsv } from "./csv";

/**
 * Importing what already lives in Sendivo (§11e, Aug 15 2026).
 *
 * Sendivo's API is write-mostly: `/contacts` needs a phone number,
 * `/conversations/{id}/messages` is POST-only, and there is no list endpoint
 * for conversations, messages, or opt-outs (all verified 404/405 live). The
 * webhook is the only programmatic way in, and it only carries messages sent
 * *after* it starts working — months of live negotiations and, more seriously,
 * every STOP anyone has ever sent, stay invisible.
 *
 * That last part is a compliance problem, not an inconvenience. Opt-out
 * suppression checks Premier Edge's database, so a seller who opted out in
 * Sendivo would be texted again the moment a blast runs from here.
 *
 * So: import Sendivo's own CSV exports. Headers are alias-matched the same way
 * blast lists are, because export formats differ and guessing column positions
 * breaks silently.
 */

const OPT_OUT_ALIASES = ["optedout", "optout", "unsubscribed", "isoptedout", "donotcontact", "dnc", "stopped"];
const DATE_ALIASES = ["date", "datetime", "timestamp", "time", "createdat", "sentat", "optedoutat", "receivedat"];
const BODY_ALIASES = ["message", "body", "text", "content", "messagebody", "messagetext"];
const DIRECTION_ALIASES = ["direction", "type", "messagetype", "kind"];

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Find a column by alias list, returning its index. */
function columnFor(headers: string[], aliases: string[]): number | undefined {
  const normalized = headers.map(key);
  for (const alias of aliases) {
    const i = normalized.indexOf(alias);
    if (i >= 0) return i;
  }
  return undefined;
}

/** Truthy spellings an export might use for a boolean flag. */
const TRUTHY = new Set(["1", "true", "yes", "y", "t", "opted out", "optedout", "unsubscribed", "stop"]);
const isTruthy = (v: string) => TRUTHY.has(v.trim().toLowerCase());

// ---------------------------------------------------------------- opt-outs

export type OptOutRow = { phone: string; optedOutAt?: Date };

export type OptOutParse = {
  rows: OptOutRow[];
  skipped: number;
  /** How the file was read, so a wrong guess is visible rather than silent. */
  mode: "flag_column" | "every_row";
};

/**
 * Parse an opt-out export. Handles both shapes an export can take: a contacts
 * dump with an "opted out" column, or a file that is already only opt-outs.
 */
export function parseOptOutExport(text: string): OptOutParse {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], skipped: 0, mode: "every_row" };

  const headers = table[0].map((h) => h.trim());
  const { map } = mapHeaders(headers);
  const phoneCol = map.phone ?? columnFor(headers, ["phone", "phonenumber", "number", "to", "contact"]);
  const flagCol = columnFor(headers, OPT_OUT_ALIASES);
  const dateCol = columnFor(headers, DATE_ALIASES);

  const rows: OptOutRow[] = [];
  let skipped = 0;

  for (const cells of table.slice(1)) {
    const phone = phoneCol === undefined ? null : normalizeListPhone(cells[phoneCol] ?? "");
    if (!phone) {
      skipped += 1;
      continue;
    }
    // With a flag column, only flagged rows count. Without one, the file is
    // assumed to be an opt-out list already — never the other way around, since
    // over-suppressing costs a lead and under-suppressing is a violation.
    if (flagCol !== undefined && !isTruthy(cells[flagCol] ?? "")) continue;

    const raw = dateCol !== undefined ? cells[dateCol] : undefined;
    const parsed = raw ? new Date(raw) : undefined;
    rows.push({ phone, optedOutAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined });
  }

  return { rows, skipped, mode: flagCol !== undefined ? "flag_column" : "every_row" };
}

export type OptOutImport = { suppressed: number; alreadyKnown: number; contactsCreated: number };

/**
 * Write opt-outs to both places suppression reads from: the `opt_outs` ledger
 * (keyed by phone, survives across lists and campaigns) and the denormalized
 * `contacts.opted_out` flag. A contact row is created when we've never seen the
 * number, so the suppression survives a later list import that would otherwise
 * introduce them fresh.
 */
export async function importOptOuts(db: Db, rows: OptOutRow[]): Promise<OptOutImport> {
  const result: OptOutImport = { suppressed: 0, alreadyKnown: 0, contactsCreated: 0 };

  for (const row of rows) {
    const existing = await db.query.optOuts.findFirst({ where: eq(optOuts.phone, row.phone) });
    if (existing) result.alreadyKnown += 1;

    await db
      .insert(optOuts)
      .values({ phone: row.phone, source: "sendivo_export", ...(row.optedOutAt ? { optedOutAt: row.optedOutAt } : {}) })
      .onConflictDoNothing();

    const [contact] = await db
      .insert(contacts)
      .values({ phone: row.phone, source: "blast", optedOut: true })
      .onConflictDoUpdate({
        target: contacts.phone,
        set: { optedOut: true, updatedAt: new Date() },
      })
      .returning({ id: contacts.id, createdAt: contacts.createdAt, updatedAt: contacts.updatedAt });

    // A row whose timestamps still match was inserted by this statement.
    if (contact && contact.createdAt.getTime() === contact.updatedAt.getTime()) result.contactsCreated += 1;
    if (!existing) result.suppressed += 1;
  }

  return result;
}

// ---------------------------------------------------------- message history

export type HistoryRow = {
  phone: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt?: Date;
  name?: string;
};

export type HistoryParse = { rows: HistoryRow[]; skipped: number; unmapped: string[] };

const INBOUND_WORDS = ["inbound", "in", "received", "receive", "reply", "incoming", "from"];
const OUTBOUND_WORDS = ["outbound", "out", "sent", "send", "outgoing", "to", "delivered"];

function readDirection(value: string | undefined): "inbound" | "outbound" | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (INBOUND_WORDS.includes(v)) return "inbound";
  if (OUTBOUND_WORDS.includes(v)) return "outbound";
  return null;
}

export function parseMessageExport(text: string): HistoryParse {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], skipped: 0, unmapped: [] };

  const headers = table[0].map((h) => h.trim());
  const { map, unmapped } = mapHeaders(headers);
  const phoneCol = map.phone ?? columnFor(headers, ["phone", "phonenumber", "number", "contact"]);
  const bodyCol = columnFor(headers, BODY_ALIASES);
  const dirCol = columnFor(headers, DIRECTION_ALIASES);
  const dateCol = columnFor(headers, DATE_ALIASES);
  const nameCol = map.name as number | undefined;

  const rows: HistoryRow[] = [];
  let skipped = 0;

  for (const cells of table.slice(1)) {
    const phone = phoneCol === undefined ? null : normalizeListPhone(cells[phoneCol] ?? "");
    const body = bodyCol === undefined ? undefined : cells[bodyCol]?.trim();
    const direction = readDirection(dirCol === undefined ? undefined : cells[dirCol]);

    // Every one of these is required to place a message in a thread correctly.
    // A row missing any of them is reported, not guessed at — an outbound
    // logged as inbound would be classified as if the seller said it.
    if (!phone || !body || !direction) {
      skipped += 1;
      continue;
    }

    const raw = dateCol !== undefined ? cells[dateCol] : undefined;
    const parsed = raw ? new Date(raw) : undefined;
    rows.push({
      phone,
      direction,
      body,
      sentAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
      name: nameCol !== undefined ? cells[nameCol]?.trim() || undefined : undefined,
    });
  }

  return { rows, skipped, unmapped };
}

export type HistoryImport = {
  threads: number;
  messagesInserted: number;
  duplicatesSkipped: number;
  suppressedContacts: number;
};

/**
 * Rebuild Sendivo's threads inside Premier Edge.
 *
 * Deliberately does *not* run the agent: these messages already happened and
 * were already answered, and drafting replies to months-old conversations would
 * put stale offers in the approval queue. The threads land as history, and the
 * agent picks up from the next live inbound.
 */
export async function importMessageHistory(db: Db, rows: HistoryRow[]): Promise<HistoryImport> {
  const result: HistoryImport = { threads: 0, messagesInserted: 0, duplicatesSkipped: 0, suppressedContacts: 0 };

  // Group by phone so each seller becomes one thread, oldest message first.
  const byPhone = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const list = byPhone.get(row.phone) ?? [];
    list.push(row);
    byPhone.set(row.phone, list);
  }

  for (const [phone, thread] of byPhone) {
    thread.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
    const name = thread.find((m) => m.name)?.name;

    const suppressed = await db.query.optOuts.findFirst({ where: eq(optOuts.phone, phone) });

    const [contact] = await db
      .insert(contacts)
      .values({ phone, source: "inbound", name, optedOut: Boolean(suppressed) })
      .onConflictDoUpdate({
        target: contacts.phone,
        set: { name: sql`COALESCE(${contacts.name}, ${name ?? null})`, updatedAt: new Date() },
      })
      .returning({ id: contacts.id });

    if (suppressed) result.suppressedContacts += 1;

    // Reuse this contact's existing thread if they already have one, so a
    // re-import merges into it rather than growing a parallel conversation.
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(deals, eq(conversations.dealId, deals.id))
      .where(eq(deals.contactId, contact.id))
      .orderBy(conversations.createdAt)
      .limit(1);

    let conversationId = existing?.id;
    if (!conversationId) {
      const [deal] = await db.insert(deals).values({ contactId: contact.id }).returning();
      const [created] = await db
        .insert(conversations)
        .values({
          dealId: deal.id,
          // Imported history is not a live negotiation until the seller says
          // something new, and OPTED_OUT is terminal for anyone suppressed.
          state: suppressed ? "OPTED_OUT" : "QUALIFYING",
        })
        .returning({ id: conversations.id });
      conversationId = created.id;
      result.threads += 1;
    }

    for (const m of thread) {
      // No sendivo_message_id in an export, so dedupe on the content itself —
      // re-running the import must not double the thread.
      const [dupe] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.direction, m.direction),
            eq(messages.body, m.body),
          ),
        )
        .limit(1);

      if (dupe) {
        result.duplicatesSkipped += 1;
        continue;
      }

      await db.insert(messages).values({
        conversationId,
        direction: m.direction,
        body: m.body,
        status: "imported",
        sentBy: m.direction === "outbound" ? "marlon" : undefined,
        ...(m.sentAt ? { createdAt: m.sentAt } : {}),
      });
      result.messagesInserted += 1;
    }

    const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound");
    const lastOutbound = [...thread].reverse().find((m) => m.direction === "outbound");
    await db
      .update(conversations)
      .set({
        ...(lastInbound?.sentAt ? { lastInboundAt: lastInbound.sentAt } : {}),
        ...(lastOutbound?.sentAt ? { lastOutboundAt: lastOutbound.sentAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  }

  return result;
}
