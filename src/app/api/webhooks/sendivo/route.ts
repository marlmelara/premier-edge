import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { env } from "@/env";
import { runAgentTurn } from "@/lib/agent/run";
import { autoAttachFromList } from "@/lib/deals/attach-parcel";
import { getContactByPhone } from "@/lib/sendivo/client";
import { ingestInboundMessage, mapSendivoContact } from "@/lib/sendivo/ingest";
import { classifyWebhook, verifyWebhookSignature } from "@/lib/sendivo/webhook-schema";

/**
 * The agent turn runs inline here and makes two model calls, which take longer
 * than the platform default. Vercel caps this at the plan's ceiling (60s on
 * Pro), so the run completes instead of being killed after the message is
 * persisted but before the draft is written.
 */
export const maxDuration = 60;

/**
 * Sendivo webhook receiver. The shared secret rides in the URL:
 * https://<host>/api/webhooks/sendivo?token=<SENDIVO_WEBHOOK_TOKEN>
 * (an x-webhook-token header also works, for manual testing).
 *
 * Sendivo added a per-webhook signing secret (`whsec_…`) around Aug 15 2026,
 * after this was written. It is not yet enforced here — see logReceipt for why,
 * and for how the scheme gets identified from a real delivery.
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
    // A silent 401 is indistinguishable from never being called at all, which
    // is the difference between "the URL in Sendivo is missing its token" and
    // "Sendivo isn't sending webhooks" — hours of guessing either way. Leave a
    // trace, without storing the body (it's unauthenticated and attacker-shaped).
    await logRejection(req, token);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Read the body as text first: signature verification has to run over the
  // exact bytes Sendivo signed, not a re-serialized object.
  const raw = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid json" }, { status: 200 });
  }

  const db = getDb();

  // Signature check (Sendivo: HMAC-SHA256 over `timestamp + "." + body`).
  // Only enforced when the secret is configured, so the URL token remains the
  // sole gate until it is — but once set, a bad signature is rejected outright.
  const signingSecret = env().SENDIVO_WEBHOOK_SIGNING_SECRET;
  if (signingSecret) {
    const check = verifyWebhookSignature({
      raw,
      signatureHeader: req.headers.get("x-sendivo-signature"),
      timestampHeader: req.headers.get("x-sendivo-timestamp"),
      secret: signingSecret,
    });
    if (!check.ok) {
      await db.insert(agentActions).values({
        type: "sendivo_webhook_bad_signature",
        input: {
          reason: check.reason,
          event: req.headers.get("x-sendivo-event"),
          presented: req.headers.get("x-sendivo-signature"),
          timestamp: req.headers.get("x-sendivo-timestamp"),
        },
        // The exact bytes, so a digest that disagrees can be reproduced offline
        // instead of costing another round trip. The request is already
        // token-authenticated, so this is Sendivo's own payload.
        output: { raw: raw.slice(0, 4000) },
      });
      return NextResponse.json({ error: "bad signature", reason: check.reason }, { status: 401 });
    }
  }

  // Record every authenticated delivery, headers included.
  //
  // Sendivo added a `whsec_…` signing secret to their webhook UI around Aug 15
  // 2026, and the "Webhook Events" reference that would document the scheme is
  // a collapsed panel that doesn't survive their PDF export. Rather than guess
  // at a header name and an algorithm — and risk rejecting real seller replies —
  // the first deliveries are recorded in full so the scheme can be read off a
  // real request and then enforced.
  await logReceipt(db, req, raw, body);

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

    case "ignored": {
      // A recognized event we don't consume, or Sendivo's own Send Test. Not a
      // failure, and deliberately not logged as one.
      return NextResponse.json(
        { ok: true, outcome: "ignored", event: classified.event, reason: classified.reason },
        { status: 200 },
      );
    }

    case "unknown": {
      await db.insert(agentActions).values({ type: "sendivo_webhook_unrecognized", input: body });
      console.warn("[sendivo-webhook] unrecognized payload captured to agent_actions");
      return NextResponse.json({ ok: false, reason: "unrecognized payload (captured)" }, { status: 200 });
    }
  }
}

/**
 * Headers worth keeping: anything that could carry a signature, an event name,
 * or a timestamp.
 */
const INTERESTING_HEADER = /^(x-sendivo|sendivo|svix|webhook|x-webhook|x-signature|x-hub|x-event|user-agent$|content-type$)/i;

/**
 * Never store these. The platform injects its own credentials into inbound
 * requests — `x-vercel-oidc-token`, and a Bearer token nested inside
 * `x-vercel-sc-headers` — and a diagnostic log is no place for them.
 */
const SECRET_HEADER = /(token|authorization|secret|signature-ts|cookie)/i;

/**
 * Log an authenticated delivery with its headers, plus what an HMAC-SHA256 of
 * the raw body under the signing secret would look like in the common encodings.
 *
 * Comparing those candidates against whatever signature header Sendivo actually
 * sent identifies the scheme from one real request, with no guessing — after
 * which verification can be enforced instead of observed.
 */
async function logReceipt(db: Db, req: NextRequest, raw: string, body: unknown): Promise<void> {
  try {
    const [seen] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentActions)
      .where(sql`${agentActions.type} = 'sendivo_webhook_received'`);
    // Only the first handful matter — after that the shape is known and every
    // real message is already stored as a message row.
    if ((seen?.count ?? 0) >= 25) return;

    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      if (!INTERESTING_HEADER.test(name)) return;
      // A signature header is the whole point, so it survives; a credential
      // never does, even when it matches the pattern above.
      if (SECRET_HEADER.test(name) && !/signature$/i.test(name)) return;
      headers[name] = value.slice(0, 200);
    });

    const secret = env().SENDIVO_WEBHOOK_SIGNING_SECRET;
    const candidates = secret
      ? {
          hex: createHmac("sha256", secret).update(raw).digest("hex"),
          base64: createHmac("sha256", secret).update(raw).digest("base64"),
          // Svix-style secrets are base64 after the `whsec_` prefix.
          hex_decoded_secret: createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
            .update(raw)
            .digest("hex"),
          base64_decoded_secret: createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
            .update(raw)
            .digest("base64"),
        }
      : null;

    await db.insert(agentActions).values({
      type: "sendivo_webhook_received",
      input: { headers, bodyKeys: body && typeof body === "object" ? Object.keys(body) : null },
      output: { body, signatureCandidates: candidates },
    });
  } catch (error) {
    // Diagnostics must never cost us a seller's reply.
    console.warn("[sendivo-webhook] could not log receipt", error);
  }
}

/**
 * Record that something hit the webhook with the wrong token. Capped per hour:
 * the URL is public, so an open logger would let anyone fill the audit table.
 * Only shape metadata is stored, never the body.
 */
const REJECTION_LOG_CAP_PER_HOUR = 20;

async function logRejection(req: NextRequest, token: string | null): Promise<void> {
  try {
    const db = getDb();
    const [recent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentActions)
      .where(
        sql`${agentActions.type} = 'sendivo_webhook_rejected'
            AND ${agentActions.createdAt} > now() - interval '1 hour'`,
      );
    if ((recent?.count ?? 0) >= REJECTION_LOG_CAP_PER_HOUR) return;

    await db.insert(agentActions).values({
      type: "sendivo_webhook_rejected",
      input: {
        // Enough to tell "no token at all" from "wrong token" from "stale token"
        // without ever writing the presented value down.
        tokenPresented: token === null ? "none" : `${token.length} chars`,
        via: req.headers.get("x-webhook-token") ? "header" : token ? "query" : "absent",
        userAgent: req.headers.get("user-agent")?.slice(0, 120) ?? null,
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
    });
  } catch (error) {
    // Diagnostics must never turn a 401 into a 500.
    console.warn("[sendivo-webhook] could not log rejection", error);
  }
}
