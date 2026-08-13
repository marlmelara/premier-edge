import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatPhone, timeAgo } from "@/lib/format";
import { listPipeline } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipeline — Premier Edge" };

const STAGES = [
  "lead",
  "qualifying",
  "verified",
  "offer",
  "negotiating",
  "accepted",
  "under_contract",
  "closed",
  "dead",
] as const;

/** Saved views (design doc §2.3) — the two Marlon named, as links. */
const SAVED_VIEWS = [
  { label: "All", href: "/pipeline" },
  { label: "Eligible · needs offer", href: "/pipeline?verdict=pass&stage=verified" },
  { label: "Negotiating", href: "/pipeline?stage=negotiating" },
  { label: "Under contract", href: "/pipeline?stage=under_contract" },
];

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; verdict?: string; q?: string }>;
}) {
  const { stage, verdict, q } = await searchParams;
  const rows = await listPipeline({ stage, verdict, q });

  return (
    <main className="space-y-4 px-6 py-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <p className="text-xs text-muted-foreground">{rows.length} deals</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SAVED_VIEWS.map((view) => (
          <Link
            key={view.label}
            href={view.href}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary/50"
          >
            {view.label}
          </Link>
        ))}
        <form action="/pipeline" className="ml-auto flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, phone, address"
            className="rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-muted-foreground"
          />
          <select
            name="stage"
            defaultValue={stage ?? ""}
            className="rounded border border-border bg-transparent px-2 py-1 text-xs"
          >
            <option value="">Any stage</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-secondary px-2 py-1 text-xs">
            Filter
          </button>
        </form>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Address</TableHead>
            <TableHead>Seller</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Eligibility</TableHead>
            <TableHead className="text-right">Max offer</TableHead>
            <TableHead className="text-right">Last offer</TableHead>
            <TableHead className="text-right">Counter</TableHead>
            <TableHead>Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                No deals match.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.dealId}>
              <TableCell className="text-sm">
                {row.conversationId ? (
                  <Link href={`/deal-room?c=${row.conversationId}`} className="hover:underline">
                    {row.parcelAddress ?? "(no parcel linked)"}
                  </Link>
                ) : (
                  (row.parcelAddress ?? "(no parcel linked)")
                )}
                {row.parcelCounty && <span className="ml-1 text-xs text-muted-foreground">{row.parcelCounty}</span>}
              </TableCell>
              <TableCell className="text-sm">
                <Link href={`/sellers/${row.contactId}`} className="hover:underline">
                  {row.contactName ?? formatPhone(row.contactPhone)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {row.stage.replace("_", " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">
                {row.verdict === "pass" ? "✅" : row.verdict === "fail" ? "❌" : "⚠️"}
              </TableCell>
              <TableCell className="text-right text-sm">{formatMoney(row.maxOffer)}</TableCell>
              <TableCell className="text-right text-sm">{formatMoney(row.lastOffer)}</TableCell>
              <TableCell className="text-right text-sm">{formatMoney(row.sellerCounter)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{timeAgo(row.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
