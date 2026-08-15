import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  classifyWebhook,
  isOptOutMessage,
  normalizePhone,
  verifyWebhookSignature,
} from "./webhook-schema";

describe("classifyWebhook", () => {
  it("classifies a nested inbound payload", () => {
    const result = classifyWebhook({
      event: "message.received",
      message: {
        id: 12345,
        from: "(772) 555-0142",
        body: "Yes I own that lot",
        conversation_id: 789,
        received_at: "2026-08-12T15:00:00Z",
      },
    });
    expect(result).toMatchObject({
      kind: "inbound",
      sendivoMessageId: "12345",
      from: "(772) 555-0142",
      body: "Yes I own that lot",
      conversationId: "789",
    });
  });

  it("classifies a flat inbound payload with sms/logs-style field names", () => {
    const result = classifyWebhook({
      message_id: "abc-123",
      from_number: "+17725550142",
      to_number: "+12393787893",
      message_content: "Who is this?",
      conversation_id: 42,
    });
    expect(result).toMatchObject({
      kind: "inbound",
      sendivoMessageId: "abc-123",
      from: "+17725550142",
      body: "Who is this?",
      conversationId: "42",
    });
  });

  it("classifies a flat inbound payload where `message` is the body string", () => {
    const result = classifyWebhook({
      event: "inbound_sms",
      id: 9,
      phone: "2395550171",
      message: "still interested?",
    });
    expect(result).toMatchObject({ kind: "inbound", sendivoMessageId: "9", body: "still interested?" });
  });

  it("classifies delivery status updates, not as inbound", () => {
    const result = classifyWebhook({
      event: "message.status",
      message_id: "abc-123",
      status: "delivered",
    });
    expect(result).toEqual({ kind: "delivery_status", sendivoMessageId: "abc-123", status: "delivered" });
  });

  it("does not treat a status event with a body as inbound", () => {
    const result = classifyWebhook({
      event: "delivery_status_updated",
      message_id: "abc-123",
      from_number: "+12393787893",
      message_content: "original text",
      status: "failed",
    });
    expect(result.kind).toBe("delivery_status");
  });

  it("returns unknown for unrecognizable payloads", () => {
    expect(classifyWebhook({ event: "phone_number.ready", phone_number: "+1" }).kind).toBe("unknown");
    expect(classifyWebhook("nonsense").kind).toBe("unknown");
    expect(classifyWebhook(null).kind).toBe("unknown");
    expect(classifyWebhook({ event: "message.received", message: { body: "no id or from" } }).kind).toBe("unknown");
  });
});

describe("normalizePhone", () => {
  it("normalizes US formats to E.164", () => {
    expect(normalizePhone("(772) 555-0142")).toBe("+17725550142");
    expect(normalizePhone("772-555-0142")).toBe("+17725550142");
    expect(normalizePhone("17725550142")).toBe("+17725550142");
    expect(normalizePhone("+1 772 555 0142")).toBe("+17725550142");
  });
});

describe("isOptOutMessage", () => {
  it("detects exact opt-out keywords case-insensitively", () => {
    expect(isOptOutMessage("STOP")).toBe(true);
    expect(isOptOutMessage(" stop ")).toBe(true);
    expect(isOptOutMessage("Stop!")).toBe(true);
    expect(isOptOutMessage("unsubscribe")).toBe(true);
  });

  it("does not flag messages that merely contain a keyword", () => {
    expect(isOptOutMessage("Don't stop texting me, I'm interested")).toBe(false);
    expect(isOptOutMessage("I want to cancel the showing but keep talking")).toBe(false);
  });
});

/**
 * The real Sendivo envelope, captured from a live Send Test on Aug 15 2026.
 * The previous classifier returned "unknown" for this — it only looked at the
 * top level and at `message`, never at `data` — so every seller reply would
 * have been dropped even once delivery worked.
 */
const REAL_INBOUND = {
  test: true,
  event: "inbound_message",
  timestamp: "2026-08-15T20:23:21+00:00",
  data: {
    to: "+14155559999",
    from: "+14155551234",
    contact: { id: 12345, last_name: "Contact", first_name: "Test", phone_number: "+14155551234" },
    message: "This is a test inbound message from Sendivo.",
    locationId: null,
    message_id: "test_CdUUVYfJapYfKPVU",
    received_at: "2026-08-15T20:23:21+00:00",
    conversation_id: 67890,
    sub_account_name: "Example Sub Account",
  },
};

describe("classifyWebhook — the documented Sendivo envelope", () => {
  it("does not ingest Sendivo's own Send Test", () => {
    // Its numbers are +1415555xxxx placeholders. Ingesting them would invent a
    // seller and open a thread against land nobody owns.
    const result = classifyWebhook(REAL_INBOUND);
    expect(result.kind).toBe("ignored");
    if (result.kind === "ignored") expect(result.reason).toBe("test delivery");
  });

  it("reads a real inbound reply out of data", () => {
    const live = { ...REAL_INBOUND, test: undefined };
    const result = classifyWebhook(live);
    expect(result.kind).toBe("inbound");
    if (result.kind === "inbound") {
      expect(result.sendivoMessageId).toBe("test_CdUUVYfJapYfKPVU");
      expect(result.from).toBe("+14155551234");
      expect(result.body).toBe("This is a test inbound message from Sendivo.");
      expect(result.conversationId).toBe("67890");
      expect(result.contactId).toBe("12345");
    }
  });

  it("reads a delivery status out of data", () => {
    const result = classifyWebhook({
      event: "delivery_status",
      data: { message_id: "abc123", to: "+14155551234", status: "delivered", status_group: "DELIVERED" },
    });
    expect(result.kind).toBe("delivery_status");
    if (result.kind === "delivery_status") expect(result.status).toBe("delivered");
  });

  it("names the events it deliberately skips instead of calling them unknown", () => {
    // Keeps the unrecognized log meaningful — it should only hold surprises.
    for (const event of ["phone_number_ready", "deal_status_updated"]) {
      expect(classifyWebhook({ event, data: { anything: true } }).kind).toBe("ignored");
    }
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const raw = '{"event":"inbound_message","data":{"message":"hi"}}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = (t: string, body: string, s = secret) =>
    "sha256=" + createHmac("sha256", s).update(`${t}.${body}`).digest("hex");

  it("accepts a correctly signed delivery", () => {
    expect(
      verifyWebhookSignature({ raw, signatureHeader: sign(ts, raw), timestampHeader: ts, secret }).ok,
    ).toBe(true);
  });

  it("rejects a body that changed after signing", () => {
    const tampered = raw.replace("hi", "we can do 15");
    const result = verifyWebhookSignature({ raw: tampered, signatureHeader: sign(ts, raw), timestampHeader: ts, secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mismatch");
  });

  it("rejects a signature made with the wrong secret", () => {
    const result = verifyWebhookSignature({
      raw,
      signatureHeader: sign(ts, raw, "whsec_wrong"),
      timestampHeader: ts,
      secret,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a replayed delivery outside the tolerance window", () => {
    const old = String(Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 60);
    const result = verifyWebhookSignature({ raw, signatureHeader: sign(old, raw), timestampHeader: old, secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
  });

  it("rejects a delivery with no signature at all", () => {
    const result = verifyWebhookSignature({ raw, signatureHeader: null, timestampHeader: ts, secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_signature");
  });
});
