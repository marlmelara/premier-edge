import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { env } from "@/env";
import { runAgentTurn } from "@/lib/agent/run";
import { autoAttachFromList } from "@/lib/deals/attach-parcel";
import { getContactByPhone } from "@/lib/sendivo/client";
import { ingestInboundMessage, mapSendivoContact } from "@/lib/sendivo/ingest";
import { classifyWebhook } from "@/lib/sendivo/webhook-schema";

/**
 * The agent turn runs inline here and makes two model calls, which take longer
 * than the platform default. Vercel caps this at the plan's ceiling (60s on
 * Pro), so the run completes instead of being killed after the message is
 * persisted but before the draft is written.
 */
export const maxDuration = 60;

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

      // Run the agent inline: it only ever produces a pending draft, and
      // Sendivo's retry is bounded by our dedupe. Failures must not 500 the
      // webhook — the message is already persisted either way.
      if (result.outcome === "persisted" && !result.optedOut) {
        // Resolve the lot from the imported list first, so the agent's very
        // first turn already knows whether a buyer wants this land. Without it
        // the thread stalls until someone types a parcel id by hand.
        let autoAttach: { attached: boolean; reason: string } | undefined;
        try {
          autoAttach = await autoAttachFromList(db, result.dealId, result.contactId, result.conversationId);
        } catch (error) {
          console.warn("[sendivo-webhook] parcel auto-attach failed", error);
        }

        try {
          const agent = await runAgentTurn(db, result.conversationId);
          return NextResponse.json({ ok: true, ...result, autoAttach, agent }, { status: 200 });
        } catch (error) {
          console.error("[sendivo-webhook] agent turn failed", error);
        }
        return NextResponse.json({ ok: true, ...result, autoAttach }, { status: 200 });
      }
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
