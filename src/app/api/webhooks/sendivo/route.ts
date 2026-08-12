import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { env } from "@/env";
import { ingestInboundMessage } from "@/lib/sendivo/ingest";
import { sendivoInboundMessage } from "@/lib/sendivo/webhook-schema";

/**
 * Sendivo inbound webhook. Secret-tokened (header `x-webhook-token` or
 * `?token=`), Zod-validated, deduped on sendivo_message_id.
 *
 * Always 200 on validation failures we can't act on — returning 4xx makes
 * transports retry forever. 401 only on a bad token.
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

  const parsed = sendivoInboundMessage.safeParse(body);
  if (!parsed.success) {
    console.warn("[sendivo-webhook] unrecognized payload", parsed.error.flatten());
    return NextResponse.json({ ok: false, reason: "unrecognized payload" }, { status: 200 });
  }

  const result = await ingestInboundMessage(getDb(), parsed.data);
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
}
