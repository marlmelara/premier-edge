import { describe, expect, it } from "vitest";
import { GRADUATABLE, mayAutoSend, NEVER_AUTOMATIC, readAutonomy } from "./autonomy";

const all = (enabled = GRADUATABLE) => ({ enabled });

describe("mayAutoSend — what the ladder will never grant", () => {
  it("never auto-sends anything carrying money", () => {
    // The single rule the whole system is built around. Even if an offer intent
    // were somehow switched on, an authorized amount blocks it independently.
    for (const intent of NEVER_AUTOMATIC) {
      expect(
        mayAutoSend({ intent, autonomy: all([...GRADUATABLE, intent]), authorizedOfferCents: null, isCeilingOffer: false }),
      ).toBe(false);
    }
  });

  it("blocks a graduatable intent that somehow carries a price", () => {
    // A probe should never have an amount. If a bug gave it one, that bug must
    // not become an auto-sent price.
    expect(
      mayAutoSend({ intent: "probe", autonomy: all(), authorizedOfferCents: 10_140_000, isCeilingOffer: false }),
    ).toBe(false);
  });

  it("blocks the ceiling rung twice over", () => {
    expect(
      mayAutoSend({ intent: "nudge", autonomy: all(), authorizedOfferCents: null, isCeilingOffer: true }),
    ).toBe(false);
  });

  it("stays copilot until the intent is switched on for that campaign", () => {
    expect(
      mayAutoSend({ intent: "probe", autonomy: { enabled: [] }, authorizedOfferCents: null, isCeilingOffer: false }),
    ).toBe(false);
  });

  it("grants only the intent that was switched on, not its neighbours", () => {
    const onlyProbe = { enabled: ["probe" as const] };
    expect(mayAutoSend({ intent: "probe", autonomy: onlyProbe, authorizedOfferCents: null, isCeilingOffer: false })).toBe(true);
    expect(mayAutoSend({ intent: "nudge", autonomy: onlyProbe, authorizedOfferCents: null, isCeilingOffer: false })).toBe(false);
  });
});

describe("readAutonomy", () => {
  it("treats anything malformed as fully copilot", () => {
    // A corrupt settings blob must fail closed — toward approval, never toward
    // sending.
    for (const raw of [null, undefined, "on", 42, {}, { enabled: "probe" }]) {
      expect(readAutonomy(raw).enabled).toEqual([]);
    }
  });

  it("drops intents that may never graduate, even if stored", () => {
    expect(readAutonomy({ enabled: ["probe", "offer", "partner_bump"] }).enabled).toEqual(["probe"]);
  });
});
