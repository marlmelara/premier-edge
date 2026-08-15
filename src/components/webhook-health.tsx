import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { agentActions, messages } from "@/db/schema";
import { formatDateTime } from "@/lib/format";

/**
 * Sendivo webhook health (§11f).
 *
 * The webhook is the only way a seller's reply reaches Premier Edge — Sendivo's
 * API has no readable endpoint for conversations or messages. When it stops
 * working, nothing breaks loudly: the Deal Room simply stays empty while
 * Sendivo's own inbox fills up, which is exactly what happened for the first
 * three weeks of live campaigns.
 *
 * So the silence gets a readout. "Never" and "3 weeks ago" look completely
 * different here, and a rejected call names the reason.
 */
export async function WebhookHealth({ db }: { db: Db }) {
  const [stats] = await db
    .select({
      lastInbound: sql<string | null>`(SELECT max(created_at) FROM ${messages} WHERE direction = 'inbound')`,
      rejected24h: sql<number>`COUNT(*) FILTER (
        WHERE ${agentActions.type} = 'sendivo_webhook_rejected'
        AND ${agentActions.createdAt} > now() - interval '24 hours')`,
      unrecognized24h: sql<number>`COUNT(*) FILTER (
        WHERE ${agentActions.type} = 'sendivo_webhook_unrecognized'
        AND ${agentActions.createdAt} > now() - interval '24 hours')`,
      // Measured in the database, not in render: it's a question about when a
      // row was written, and the answer shouldn't depend on the web server's
      // clock agreeing with Postgres's.
      hoursQuiet: sql<number | null>`(
        SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) / 3600
        FROM ${messages} WHERE direction = 'inbound')`,
    })
    .from(agentActions);

  const lastRejectionDetail = await db.query.agentActions.findFirst({
    where: sql`${agentActions.type} = 'sendivo_webhook_rejected'`,
    orderBy: sql`${agentActions.createdAt} DESC`,
  });

  const lastInbound = stats?.lastInbound ? new Date(stats.lastInbound) : null;
  const hoursQuiet = stats?.hoursQuiet == null ? Infinity : Number(stats.hoursQuiet);
  const rejected = Number(stats?.rejected24h ?? 0);

  // A rejection means something IS calling us with the wrong credentials —
  // almost always the URL in Sendivo missing its ?token=. That's a different
  // problem from never being called, and it's fixable in 30 seconds.
  const status = rejected > 0 ? "rejecting" : hoursQuiet > 48 ? "quiet" : "ok";

  const tone =
    status === "ok"
      ? "border-emerald-800 text-emerald-300"
      : status === "rejecting"
        ? "border-red-800 text-red-300"
        : "border-amber-800 text-amber-300";

  const rejectionInput = (lastRejectionDetail?.input ?? {}) as { tokenPresented?: string; via?: string };

  return (
    <div className={`rounded border p-3 ${tone}`} data-testid="webhook-health">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide">Sendivo webhook</p>
        <span className="text-[11px]">
          {status === "ok" ? "receiving" : status === "rejecting" ? "REJECTING CALLS" : "no inbound"}
        </span>
      </div>

      <p className="mt-1 text-sm text-foreground">
        {lastInbound ? `Last reply ${formatDateTime(lastInbound)}` : "No seller reply has ever arrived"}
      </p>

      {status === "rejecting" && (
        <p className="mt-1 text-[11px]">
          {rejected} call{rejected === 1 ? "" : "s"} rejected in 24h — token presented:{" "}
          {rejectionInput.tokenPresented ?? "unknown"} via {rejectionInput.via ?? "unknown"}. The webhook URL in Sendivo
          is probably missing its <code>?token=</code>.
        </p>
      )}

      {status === "quiet" && (
        <p className="mt-1 text-[11px]">
          Nothing rejected either, so Sendivo isn&apos;t calling at all. Check that the webhook is configured and enabled
          for inbound messages.
        </p>
      )}

      {Number(stats?.unrecognized24h ?? 0) > 0 && (
        <p className="mt-1 text-[11px]">
          {Number(stats.unrecognized24h)} payload(s) arrived in a shape we don&apos;t parse — captured in agent_actions.
        </p>
      )}
    </div>
  );
}
