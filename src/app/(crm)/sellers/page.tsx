import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatPhone, timeAgo } from "@/lib/format";
import { styleFor } from "@/lib/labels";
import { listSellers } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sellers — Premier Edge" };

/**
 * The seller directory (§2.2) — every contact we have ever texted, which after
 * the Sendivo log sync is the entire blast audience rather than only the people
 * who replied. Paginated: this is a five-figure table.
 */
const FILTERS = [
  { key: "", label: "Everyone" },
  { key: "replied", label: "Replied" },
  { key: "with-parcel", label: "Has a lot" },
  { key: "opted-out", label: "Opted out" },
] as const;

export default async function SellersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; f?: string; page?: string }>;
}) {
  const { q = "", f = "", page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const { rows, total, pageSize } = await listSellers({
    q,
    page,
    replied: f === "replied" || undefined,
    withParcel: f === "with-parcel" || undefined,
    optedOut: f === "opted-out" ? true : undefined,
  });

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const href = (next: Partial<{ q: string; f: string; page: number }>) => {
    const p = new URLSearchParams();
    const merged = { q, f, page, ...next };
    if (merged.q) p.set("q", merged.q);
    if (merged.f) p.set("f", merged.f);
    if (merged.page > 1) p.set("page", String(merged.page));
    return `/sellers${p.toString() ? `?${p}` : ""}`;
  };

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Sellers</h1>
          <p className="text-xs text-muted-foreground">
            {total.toLocaleString("en-US")} contact{total === 1 ? "" : "s"}
          </p>
        </div>

        <form className="mt-3 flex gap-2" action="/sellers">
          {f && <input type="hidden" name="f" value={f} />}
          <input
            name="q"
            defaultValue={q}
            placeholder="Name, phone, or mailing address…"
            className="w-80 rounded border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button type="submit" className="rounded bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/70">
            Search
          </button>
        </form>

        <div className="mt-3 flex gap-1">
          {FILTERS.map((filter) => (
            <Link
              key={filter.key}
              href={href({ f: filter.key, page: 1 })}
              className={`rounded px-2 py-1 text-xs ${
                f === filter.key ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q || f ? "Nothing matches that." : "No contacts yet — run the Sendivo sync or import a list."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-2 font-medium">Seller</th>
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 font-medium">Replies</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border/50 hover:bg-secondary/30">
                  <td className="px-6 py-2">
                    <Link href={`/sellers/${row.id}`} className="font-medium hover:underline">
                      {row.name ?? formatPhone(row.phone)}
                    </Link>
                    {row.name && <span className="ml-2 text-xs text-muted-foreground">{formatPhone(row.phone)}</span>}
                    {row.optedOut && (
                      <Badge variant="outline" className="ml-2 border-red-800 text-[10px] text-red-300">
                        opted out
                      </Badge>
                    )}
                    {row.labels?.map((label) => (
                      <span
                        key={label}
                        className={`ml-1 rounded border px-1.5 py-0.5 text-[10px] ${styleFor(label)}`}
                      >
                        {label}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.firstAddress ?? (row.parcelCount > 0 ? `${row.parcelCount} lot(s)` : "—")}
                    {row.parcelCount > 1 && (
                      <span className="ml-1 text-[11px] text-muted-foreground">+{row.parcelCount - 1} more</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.inboundCount > 0 && row.conversationId ? (
                      <Link href={`/deal-room?c=${row.conversationId}`} className="text-emerald-400 hover:underline">
                        {row.inboundCount} →
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.source}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">{timeAgo(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {lastPage > 1 && (
        <div className="flex items-center justify-between border-t border-border px-6 py-2 text-xs">
          <span className="text-muted-foreground">
            Page {page} of {lastPage.toLocaleString("en-US")}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={href({ page: page - 1 })} className="rounded bg-secondary px-2 py-1 hover:bg-secondary/70">
                ← Previous
              </Link>
            )}
            {page < lastPage && (
              <Link href={href({ page: page + 1 })} className="rounded bg-secondary px-2 py-1 hover:bg-secondary/70">
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
