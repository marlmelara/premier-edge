import { describe, expect, it } from "vitest";
import { calendarWeeks, fitsCalendar, monthsIn, parseDay, resolveRange, toDayString } from "./date-range";

const NOW = new Date(2026, 4, 22); // 22 May 2026

describe("parseDay", () => {
  it("reads a day as local midnight, not UTC", () => {
    // new Date("2026-05-04") is UTC midnight, which is 3 May in Florida — a
    // closing would land on the wrong calendar cell.
    const d = parseDay("2026-05-04")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);
    expect(d.getDate()).toBe(4);
  });

  it("rejects anything that isn't YYYY-MM-DD", () => {
    expect(parseDay("05/04/2026")).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay(undefined)).toBeNull();
  });
});

describe("resolveRange", () => {
  it("defaults to the current month", () => {
    const r = resolveRange({}, NOW);
    expect(r.label).toBe("May 2026");
    expect(toDayString(r.from)).toBe("2026-05-01");
    expect(toDayString(r.to)).toBe("2026-06-01");
  });

  it("covers a whole year", () => {
    const r = resolveRange({ preset: "year", year: "2026" }, NOW);
    expect(toDayString(r.from)).toBe("2026-01-01");
    expect(toDayString(r.to)).toBe("2027-01-01");
  });

  it("treats a start date with no end as 'to present'", () => {
    const r = resolveRange({ from: "2026-01-15" }, NOW);
    expect(r.label).toBe("2026-01-15 → present");
    expect(toDayString(r.from)).toBe("2026-01-15");
    // Exclusive end is the day after today, so today's closings are included.
    expect(toDayString(r.to)).toBe("2026-05-23");
  });

  it("includes the whole last day of a custom range", () => {
    const r = resolveRange({ from: "2026-05-01", to: "2026-05-04" }, NOW);
    expect(toDayString(r.to)).toBe("2026-05-05");
  });

  it("spans multiple years when asked", () => {
    const r = resolveRange({ from: "2024-01-01", to: "2026-12-31" }, NOW);
    expect(r.from.getFullYear()).toBe(2024);
    expect(r.to.getFullYear()).toBe(2027);
  });

  it("falls back to the current month on a nonsense month", () => {
    expect(resolveRange({ preset: "month", month: "99" }, NOW).label).toBe("May 2026");
  });

  it("runs year-to-date from January 1", () => {
    const r = resolveRange({ preset: "ytd" }, NOW);
    expect(toDayString(r.from)).toBe("2026-01-01");
    expect(r.label).toBe("2026 to date");
  });
});

describe("fitsCalendar", () => {
  it("shows a day grid for a month, and rolls up a year", () => {
    expect(fitsCalendar(resolveRange({}, NOW))).toBe(true);
    expect(fitsCalendar(resolveRange({ preset: "year", year: "2026" }, NOW))).toBe(false);
  });
});

describe("calendarWeeks", () => {
  it("pads to whole Sunday–Saturday rows", () => {
    const weeks = calendarWeeks(new Date(2026, 4, 1));
    expect(weeks[0]).toHaveLength(7);
    expect(weeks[0][0].getDay()).toBe(0);
    // Every day of May must appear exactly once.
    const days = weeks.flat().filter((d) => d.getMonth() === 4).map((d) => d.getDate());
    expect(new Set(days).size).toBe(31);
  });
});

describe("monthsIn", () => {
  it("buckets a multi-year range by month", () => {
    const r = resolveRange({ from: "2025-11-01", to: "2026-02-28" }, NOW);
    expect(monthsIn(r).map((m) => toDayString(m))).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
  });
});
