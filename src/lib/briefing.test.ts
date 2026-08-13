import { describe, expect, it } from "vitest";
import { composeBriefing, type BriefingData } from "./briefing";

const empty: BriefingData = {
  closings: [],
  contractsAwaitingSignature: 0,
  escalationsPending: 0,
  approvalsWaiting: 0,
  newRepliesSinceYesterday: 0,
  optOutsYesterday: 0,
};

const AUG_12 = new Date("2026-08-12T13:00:00Z");

describe("composeBriefing", () => {
  it("greets with the day and date like the reference tool", () => {
    expect(composeBriefing(empty, AUG_12)).toContain("Good morning Marlon — Premier Edge briefing, Wednesday, August 12");
  });

  it("says so plainly when nothing needs him", () => {
    expect(composeBriefing(empty, AUG_12)).toContain("Nothing needs you today.");
  });

  it("skips empty lines rather than reporting zeros", () => {
    const message = composeBriefing({ ...empty, escalationsPending: 2 }, AUG_12);
    expect(message).toContain("🚨 2 escalations pending");
    expect(message).not.toContain("✍️");
    expect(message).not.toContain("💬");
  });

  it("reports an undated closing honestly instead of inventing a countdown", () => {
    const message = composeBriefing({ ...empty, closings: [{ address: "3219 15TH ST SW", daysOut: null }] }, AUG_12);
    expect(message).toContain("⏰ 3219 15TH ST SW — at title, no date set");
    expect(message).not.toMatch(/closes in \d/);
  });

  it("orders lines by the design doc's priority", () => {
    const message = composeBriefing(
      {
        closings: [{ address: "3219 15TH ST SW", daysOut: 4 }],
        contractsAwaitingSignature: 1,
        escalationsPending: 3,
        approvalsWaiting: 2,
        newRepliesSinceYesterday: 9,
        optOutsYesterday: 1,
      },
      AUG_12,
    );
    const order = ["⏰", "✍️", "🚨", "✅", "💬", "🚫"].map((icon) => message.indexOf(icon));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });

  it("singularizes counts of one", () => {
    const message = composeBriefing({ ...empty, approvalsWaiting: 1, newRepliesSinceYesterday: 1 }, AUG_12);
    expect(message).toContain("1 approval waiting");
    expect(message).toContain("1 new reply");
  });

  it("stays within three SMS segments on a heavy day, keeping the top of the list", () => {
    const message = composeBriefing(
      {
        closings: Array.from({ length: 12 }, (_, i) => ({ address: `123${i} SOME LONG STREET NAME SW`, daysOut: i + 1 })),
        contractsAwaitingSignature: 4,
        escalationsPending: 7,
        approvalsWaiting: 11,
        newRepliesSinceYesterday: 40,
        optOutsYesterday: 3,
      },
      AUG_12,
    );
    expect(message.length).toBeLessThanOrEqual(153 * 3);
    expect(message).toContain("⏰ 1230 SOME LONG STREET NAME SW closes in 1d");
    expect(message).toContain("more in the app");
  });
});
