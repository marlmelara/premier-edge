import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, contracts } from "@/db/schema";
import { env } from "@/env";
import { sendUrgentAlert } from "@/lib/alerts";
import { sendContract } from "@/lib/contracts/send-contract";
import { routeToTitle } from "@/lib/contracts/title-email";
import { signWellWebhookPayload, verifyWebhookSignature } from "@/lib/signwell/client";

/**
 * SignWell signed-webhook chain (design doc §8): PSA signed → assignment sent →
 * assignment signed → title email. Signature is HMAC-SHA256 over
 * `"{type}@{time}"` keyed by the webhook secret id.
 */
export async function POST(req: NextRequest) {
  const webhookId = env().SIGNWELL_WEBHOOK_ID;
  if (!webhookId) {
    console.error("[signwell-webhook] SIGNWELL_WEBHOOK_ID not configured");
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  const parsed = signWellWebhookPayload.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, reason: "unrecognized payload" }, { status: 200 });

  const { event, data } = parsed.data;
  if (!verifyWebhookSignature(event, webhookId)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const db = getDb();
  const documentId = extractDocumentId(data);
  if (!documentId) {
    await db.insert(agentActions).values({ type: "signwell_webhook_unmatched", input: parsed.data });
    return NextResponse.json({ ok: false, reason: "no document id in payload (captured)" }, { status: 200 });
  }

  const contract = await db.query.contracts.findFirst({ where: eq(contracts.signwellDocumentId, documentId) });
  if (!contract) {
    await db.insert(agentActions).values({ type: "signwell_webhook_unknown_document", input: parsed.data });
    return NextResponse.json({ ok: false, reason: "document not ours (captured)" }, { status: 200 });
  }

  await db.insert(agentActions).values({
    type: "signwell_webhook",
    input: { event: event.type, documentId, kind: contract.kind },
  });

  if (event.type !== "document_completed") {
    await db.update(contracts).set({ status: event.type, updatedAt: new Date() }).where(eq(contracts.id, contract.id));
    return NextResponse.json({ ok: true, outcome: "status_recorded" }, { status: 200 });
  }

  await db
    .update(contracts)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(contracts.id, contract.id));

  await sendUrgentAlert(db, {
    type: "contract_signed",
    message: `✅ ${contract.kind.toUpperCase()} signed for deal ${contract.dealId.slice(0, 8)}.`,
  });

  // Chain forward: PSA signed → send the assignment; assignment signed → title.
  if (contract.kind === "psa") {
    const next = await sendContract(db, contract.dealId, "assignment");
    return NextResponse.json({ ok: true, outcome: "assignment_" + (next.ok ? "sent" : "failed") }, { status: 200 });
  }

  const routed = await routeToTitle(db, contract.dealId);
  return NextResponse.json({ ok: true, outcome: routed.ok ? "title_routed" : "title_failed" }, { status: 200 });
}

/** SignWell nests the document differently per event; accept the shapes it uses. */
function extractDocumentId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  const nested = obj.object ?? obj.document;
  if (typeof nested === "object" && nested !== null) {
    const inner = (nested as Record<string, unknown>).id;
    if (typeof inner === "string") return inner;
  }
  return null;
}
