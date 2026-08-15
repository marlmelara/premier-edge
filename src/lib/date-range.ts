/**
 * Date ranges for the closings view (§2.5, Aug 15 2026).
 *
 * Every scope Marlon asked for is the same thing — a start and an end — so
 * rather than four code paths there is one range type and several ways to name
 * it. "A date to present" is just an open end, which is why `to` is optional
 * everywhere rather than being a special mode.
 *
 * Pure functions, no I/O. Dates are handled as calendar days in local time:
 * a closing on the 4th belongs on the 4th regardless of the hour it recorded.
 */

export type RangePreset = "month" | "quarter" | "year" | "ytd" | "all" | "custom";

export type DateRange = {
  /** Inclusive start of the first day. */
  from: Date;
  /** Exclusive end — the instant after the last day, so comparisons are `< to`. */
  to: Date;
  label: string;
  preset: RangePreset;
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** `YYYY-MM-DD` → local midnight, or null. Avoids `new Date("2026-05-04")` parsing as UTC. */
export function parseDay(value: string | undefined | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The earliest date we'd ever show. Premier Equity has no closings before this. */
const EPOCH = new Date(2020, 0, 1);

/**
 * Resolve URL params into a range.
 *
 * `from` with no `to` means "that date to present", which is the open-ended
 * case rather than a separate mode.
 */
export function resolveRange(
  params: { preset?: string; from?: string; to?: string; month?: string; year?: string },
  now = new Date(),
): DateRange {
  const from = parseDay(params.from);
  const to = parseDay(params.to);

  if (from || to) {
    const start = from ?? EPOCH;
    // Exclusive end: add a day so the last day is included whole.
    const end = to ? addDays(to, 1) : addDays(startOfDay(now), 1);
    return {
      from: start,
      to: end,
      preset: "custom",
      label: from && to ? `${toDayString(from)} → ${toDayString(to)}` : from ? `${toDayString(from)} → present` : `through ${toDayString(to!)}`,
    };
  }

  const preset = (params.preset ?? "month") as RangePreset;

  if (preset === "all") {
    return { from: EPOCH, to: addDays(startOfDay(now), 1), label: "All time", preset: "all" };
  }

  if (preset === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1);
    return { from: start, to: addDays(startOfDay(now), 1), label: `${now.getFullYear()} to date`, preset: "ytd" };
  }

  if (preset === "year") {
    const year = Number(params.year) || now.getFullYear();
    return {
      from: new Date(year, 0, 1),
      to: new Date(year + 1, 0, 1),
      label: String(year),
      preset: "year",
    };
  }

  if (preset === "quarter") {
    const year = Number(params.year) || now.getFullYear();
    const q = Math.floor((Number(params.month) || now.getMonth() + 1 - 1) / 3);
    const startMonth = q * 3;
    return {
      from: new Date(year, startMonth, 1),
      to: new Date(year, startMonth + 3, 1),
      label: `Q${q + 1} ${year}`,
      preset: "quarter",
    };
  }

  // Default: a single month.
  const year = Number(params.year) || now.getFullYear();
  const monthIndex = params.month ? Number(params.month) - 1 : now.getMonth();
  const safeMonth = Number.isFinite(monthIndex) && monthIndex >= 0 && monthIndex <= 11 ? monthIndex : now.getMonth();
  return {
    from: new Date(year, safeMonth, 1),
    to: new Date(year, safeMonth + 1, 1),
    label: `${MONTHS[safeMonth]} ${year}`,
    preset: "month",
  };
}

/** Step a month or year range forward/backward. Undefined for ranges that don't step. */
export function shiftRange(range: DateRange, direction: -1 | 1): { month?: number; year: number } | null {
  if (range.preset === "month") {
    const d = new Date(range.from.getFullYear(), range.from.getMonth() + direction, 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }
  if (range.preset === "year") return { year: range.from.getFullYear() + direction };
  return null;
}

/**
 * Whether a range is small enough that a day grid makes sense. A year of daily
 * cells is unreadable; those scopes get a monthly roll-up instead.
 */
export function fitsCalendar(range: DateRange): boolean {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return days <= 62;
}

/** Calendar weeks covering a month, padded to whole Sun–Sat rows. */
export function calendarWeeks(monthStart: Date): Date[][] {
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const weeks: Date[][] = [];
  let cursor = gridStart;
  // Six rows covers every month layout; trailing all-outside rows are dropped.
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    weeks.push(week);
    cursor = addDays(cursor, 7);
    if (cursor.getMonth() !== monthStart.getMonth() && cursor > first) break;
  }
  return weeks;
}

/** Month buckets covering a range, for scopes too long to show day by day. */
export function monthsIn(range: DateRange): Date[] {
  const months: Date[] = [];
  const cursor = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
  while (cursor < range.to) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}
