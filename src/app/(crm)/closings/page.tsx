import Link from "next/link";
import { escrowTotal, listClosings } from "@/lib/closings";
import { calendarWeeks, fitsCalendar, monthsIn, resolveRange, shiftRange, toDayString } from "@/lib/date-range";
import { formatMoney, formatPhone } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Closings — Premier Edge" };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const money = (cents: number) => formatMoney(cents / 100);

/**
 * Closings (§2.5). What actually got paid, and when.
 *
 * The pipeline answers "what might close"; this answers "what did". Both
 * banners count the same figure — our assignment fee — so closed and escrowed
 * are directly comparable rather than one being revenue and the other a
 * purchase price.
 */
export default async function ClosingsPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string; month?: string; year?: string }>;
}) {
  const params = await searchParams;
  const range = resolveRange(params);
  const [summary, escrow] = await Promise.all([listClosings(range), escrowTotal()]);

  const href = (next: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/closings${p.toString() ? `?${p}` : ""}`;
  };

  const back = shiftRange(range, -1);
  const forward = shiftRange(range, 1);
  const showCalendar = fitsCalendar(range);
  const thisYear = new Date().getFullYear();

  return (
    <main className="h-full space-y-4 overflow-y-auto px-6 py-5">
      {/* Money first — it's the reason to open this screen. */}
      <div className="space-y-2">
        <div className="rounded-lg bg-gradient-to-r from-emerald-700 to-teal-600 px-5 py-4 text-white">
          <p className="text-3xl font-bold tracking-tight">{money(summary.totalCents)}</p>
          <p className="text-sm text-emerald-50/90">
            {summary.count} file{summary.count === 1 ? "" : "s"} closed · {range.label}
          </p>
        </div>
        <Link
          href="/pipeline?stage=under_contract"
          className="block rounded-lg bg-gradient-to-r from-emerald-800 to-emerald-600 px-5 py-3 text-white transition-opacity hover:opacity-90"
        >
          <p className="text-2xl font-bold tracking-tight">{money(escrow.cents)}</p>
          <p className="text-xs text-emerald-50/90">
            {escrow.count} file{escrow.count === 1 ? "" : "s"} in escrow · click to see them
          </p>
        </Link>
      </div>

      {/* Scope */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
        <div className="flex gap-1">
          {[
            { label: "Month", q: { preset: "month" } },
            { label: "Quarter", q: { preset: "quarter" } },
            { label: "Year", q: { preset: "year", year: thisYear } },
            { label: "YTD", q: { preset: "ytd" } },
            { label: "All time", q: { preset: "all" } },
          ].map((opt) => (
            <Link
              key={opt.label}
              href={href(opt.q)}
              className={`rounded px-2 py-1 text-xs ${
                range.preset === opt.q.preset ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        {(back || forward) && (
          <div className="flex items-center gap-1">
            {back && (
              <Link href={href({ preset: range.preset, ...back })} className="rounded bg-secondary px-2 py-1 text-xs">
                ‹
              </Link>
            )}
            <span className="min-w-28 text-center text-xs font-medium">{range.label}</span>
            {forward && (
              <Link href={href({ preset: range.preset, ...forward })} className="rounded bg-secondary px-2 py-1 text-xs">
                ›
              </Link>
            )}
          </div>
        )}

        {/* Custom range. Leaving "to" blank means "through today". */}
        <form action="/closings" className="ml-auto flex items-center gap-1.5 text-xs">
          <input
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className="rounded border border-border bg-background px-2 py-1"
          />
          <span className="text-muted-foreground">→</span>
          <input
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="rounded border border-border bg-background px-2 py-1"
            title="Leave blank for 'to present'"
          />
          <button type="submit" className="rounded bg-secondary px-2 py-1 hover:bg-secondary/70">
            Apply
          </button>
        </form>
      </div>

      {showCalendar ? (
        <CalendarGrid range={range} byDay={summary.byDay} />
      ) : (
        <MonthRollup range={range} byMonth={summary.byMonth} />
      )}

      {/* The files themselves */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          Closed files · {range.label}
        </h2>
        {summary.rows.length === 0 ? (
          <p className="rounded border border-border p-4 text-sm text-muted-foreground">
            Nothing closed in this range. A deal shows here once its stage is <code>closed</code> and it has an
            assignment fee recorded.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Date</th>
                <th className="py-1 font-medium">Property</th>
                <th className="py-1 font-medium">Seller</th>
                <th className="py-1 text-right font-medium">Assignment fee</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.dealId} className="border-b border-border/50">
                  <td className="py-1.5 text-muted-foreground">{row.day}</td>
                  <td className="py-1.5">{row.address ?? "—"}</td>
                  <td className="py-1.5 text-muted-foreground">
                    {row.sellerName ?? formatPhone(row.sellerPhone)}
                  </td>
                  <td className="py-1.5 text-right font-medium text-emerald-400">{money(row.feeCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function CalendarGrid({
  range,
  byDay,
}: {
  range: ReturnType<typeof resolveRange>;
  byDay: Map<string, { cents: number; count: number }>;
}) {
  const weeks = calendarWeeks(range.from);
  const monthIndex = range.from.getMonth();
  const today = toDayString(new Date());

  return (
    <div className="rounded border border-border p-3">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
        {WEEKDAYS.map((d) => (
          <div key={d} className="pb-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((day) => {
          const key = toDayString(day);
          const entry = byDay.get(key);
          const outside = day.getMonth() !== monthIndex;
          return (
            <div
              key={key}
              className={`min-h-16 rounded border p-1 text-left ${
                outside
                  ? "border-transparent text-muted-foreground/40"
                  : entry
                    ? "border-emerald-800 bg-emerald-950/50"
                    : "border-border/60"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[11px] ${key === today ? "rounded bg-primary px-1 font-semibold text-primary-foreground" : ""}`}>
                  {day.getDate()}
                </span>
                {entry && entry.count > 1 && (
                  <span className="text-[9px] text-muted-foreground">{entry.count}</span>
                )}
              </div>
              {entry && !outside && (
                <p className="mt-0.5 text-[11px] font-semibold text-emerald-300">{money(entry.cents)}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A year of daily cells is unreadable, so long scopes roll up by month with a
 * bar per month scaled to the biggest one.
 */
function MonthRollup({
  range,
  byMonth,
}: {
  range: ReturnType<typeof resolveRange>;
  byMonth: Map<string, { cents: number; count: number }>;
}) {
  const months = monthsIn(range);
  const peak = Math.max(1, ...months.map((m) => byMonth.get(toDayString(m))?.cents ?? 0));

  return (
    <div className="space-y-1 rounded border border-border p-3">
      {months.map((m) => {
        const entry = byMonth.get(toDayString(m));
        const cents = entry?.cents ?? 0;
        return (
          <Link
            key={toDayString(m)}
            href={`/closings?preset=month&month=${m.getMonth() + 1}&year=${m.getFullYear()}`}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-secondary/40"
          >
            <span className="w-20 shrink-0 text-muted-foreground">
              {MONTH_SHORT[m.getMonth()]} {m.getFullYear()}
            </span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-secondary/40">
              <span
                className="block h-full rounded bg-emerald-600"
                style={{ width: `${Math.round((cents / peak) * 100)}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right font-medium">{cents ? money(cents) : "—"}</span>
            <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">
              {entry?.count ? `${entry.count}` : ""}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
