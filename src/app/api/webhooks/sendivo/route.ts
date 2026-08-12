import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { env } from "@/env";
import { getContactByPhone } from "@/lib/sendivo/client";
import { ingestInboundMessage, mapSendivoContact } from "@/lib/sendivo/ingest";
import { classifyWebhook } from "@/lib/sendivo/webhook-schema";

/**
 * Sendivo webhook receiver. Sendivo's webhook config is just a URL (no signing
 * mechanism in their docs), so the shared secret rides in the URL:
 * https://<host>/api/webhooks/sendivo?token=<SENDIVO_WEBHOOK_TOKEN>
 * (an x-webhook-token header also works, for manual testing).
 *
 * Always 200 on payloads we can't act on — 4xx makes transports retry forever.
 * 401 only on a bad token. Unrecognized shapes are captured into agent_actions
 * so the real payload shape is learned from the first live event.
 */
export async function POST(req: NextRequest) {
  const expected = env().SENDIVO_WEBHOOK_TOKEN;
  if (!expected) {
    console.error("[sendivo-webhook] SENDIVO_WEBHOOK_TOKEN not configured; rejecting");
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  const token = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token");
  if (token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid json" }, { status: 200 });
  }

  const db = getDb();
  const classified = classifyWebhook(body);

  switch (classified.kind) {
    case "inbound": {
      const result = await ingestInboundMessage(db, classified, {
        enrich: async (phone) => {
          try {
            const contact = await getContactByPhone(phone);
            return contact ? mapSendivoContact(contact) : null;
          } catch (error) {
            console.warn("[sendivo-webhook] enrichment failed", error);
            return null;
          }
        },
      });
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    }

    case "delivery_status": {
      const updated = await db
        .update(messages)
        .set({ status: classified.status, updatedAt: new Date() })
        .where(eq(messages.sendivoMessageId, classified.sendivoMessageId))
        .returning({ id: messages.id });
      return NextResponse.json({ ok: true, outcome: "status_updated", matched: updated.length }, { status: 200 });
    }

    case "unknown": {
      await db.insert(agentActions).values({ type: "sendivo_webhook_unrecognized", input: body });
      console.warn("[sendivo-webhook] unrecognized payload captured to agent_actions");
      return NextResponse.json({ ok: false, reason: "unrecognized payload (captured)" }, { status: 200 });
    }
  }
}
