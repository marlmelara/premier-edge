import { describe, expect, it } from "vitest";
import { isOptOutMessage, normalizePhone, sendivoInboundMessage } from "./webhook-schema";

describe("sendivoInboundMessage", () => {
  it("parses a minimal inbound payload", () => {
    const parsed = sendivoInboundMessage.parse({
      event: "message.received",
      message: { id: 12345, from: "(772) 555-0142", body: "Yes I own that lot" },
    });
    expect(parsed.message.id).toBe("12345");
    expect(parsed.message.from).toBe("(772) 555-0142");
  });

  it("keeps unrecognized fields for auditability", () => {
    const parsed = sendivoInboundMessage.parse({
      event: "message.received",
      message: { id: "a1", from: "+17725550142", body: "hi", segment_count: 1 },
      account_id: "acct_9",
    });
    expect((parsed as Record<string, unknown>).account_id).toBe("acct_9");
  });

  it("rejects payloads without a message id or sender", () => {
    expect(
      sendivoInboundMessage.safeParse({ event: "message.received", message: { body: "hi" } }).success,
    ).toBe(false);
    expect(sendivoInboundMessage.safeParse({ event: "campaign.finished" }).success).toBe(false);
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
