import { describe, expect, it } from "vitest";
import { classifyWebhook, isOptOutMessage, normalizePhone } from "./webhook-schema";

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
