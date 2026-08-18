import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE, isWithinQuietHours, timezoneForCounty } from "./send";

/** 8am–9pm seller-local. UTC instants chosen so the local hour is unambiguous. */
const at = (iso: string) => new Date(iso);

describe("quiet hours", () => {
  it("blocks before 8am and from 9pm, seller-local", () => {
    // 11:00Z = 07:00 EDT — too early.
    expect(isWithinQuietHours(at("2026-08-15T11:00:00Z"), "America/New_York")).toBe(true);
    // 12:00Z = 08:00 EDT — the window opens.
    expect(isWithinQuietHours(at("2026-08-15T12:00:00Z"), "America/New_York")).toBe(false);
    // 01:00Z = 21:00 EDT the previous day — closed.
    expect(isWithinQuietHours(at("2026-08-16T01:00:00Z"), "America/New_York")).toBe(true);
  });

  it("is genuinely seller-local, not just Eastern", () => {
    // 12:00Z is 08:00 in Florida but 07:00 in Texas. Hardcoding Eastern would
    // text a Central-time seller an hour early — a 10DLC violation that looks
    // correct from Florida.
    const instant = at("2026-08-15T12:00:00Z");
    expect(isWithinQuietHours(instant, "America/New_York")).toBe(false);
    expect(isWithinQuietHours(instant, "America/Chicago")).toBe(true);
  });

  it("falls back to Eastern for a county we don't know", () => {
    // Conservative for a Florida-first business: Eastern opens later and closes
    // earlier than Central.
    expect(timezoneForCounty(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(timezoneForCounty("somewhere_new")).toBe(DEFAULT_TIMEZONE);
    expect(timezoneForCounty("lee")).toBe("America/New_York");
  });
});
