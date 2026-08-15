import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentActions, conversations, messages } from "@/db/schema";
import { getBlasts, getDeliveryMetrics } from "@/lib/sendivo/client";
import { isKillSwitchOn } from "@/lib/agent/guardrails";
import { hasAnthropicKey } from "@/lib/agent/anthropic";
import { KillSwitch } from "@/components/kill-switch";
import { WebhookHealth } from "@/components/webhook-health";
import { listCampaignsWithGate } from "@/lib/queries";
import { getRedis } from "@/lib/redis";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns — Premier Edge" };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-border p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-semibold">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

type MetricsResult =
  | { ok: true; data: Awaited<ReturnType<typeof getDeliveryMetrics>> }
  | { ok: false; reason: string };

/**
 * Campaign dashboard (design doc §2.3): Sendivo delivery/reply/opt-out tiles
 * + our own agent stats — the autonomy-graduation evidence.
 */
export default async function CampaignsPage() {
  const db = getDb();
  const startDate = isoDaysAgo(29);
  const endDate = new Date().toISOString().slice(0, 10);

  // Explicit discriminated result: the Sendivo schemas are `.loose()`, so an
  // `in` check on the raw value can't narrow it.
  const [metrics, blasts, agentStats] = await Promise.all([
    getDeliveryMetrics(startDate, endDate).then(
      (data): MetricsResult => ({ ok: true, data }),
      (error: unknown): MetricsResult => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
    getBlasts({ perPage: 10 }).catch(() => null),
    db
      .select({
        drafts: sql<number>`COUNT(*) FILTER (WHERE ${agentActions.type} = 'draft_created')`,
        approved: sql<number>`COUNT(*) FILTER (WHERE ${agentActions.type} = 'draft_approved')`,
        edited: sql<number>`COUNT(*) FILTER (WHERE ${agentActions.type} = 'draft_edited')`,
        rejected: sql<number>`COUNT(*) FILTER (WHERE ${agentActions.type} = 'draft_rejected')`,
        blocked: sql<number>`COUNT(*) FILTER (WHERE ${agentActions.type} = 'send_blocked')`,
      })
      .from(agentActions)
      .then((r) => r[0]),
  ]);

  const redisAvailable = getRedis() !== null;
  const killSwitchOn = await isKillSwitchOn();
  const campaignGates = await listCampaignsWithGate(metrics.ok, hasAnthropicKey());

  const [local] = await db
    .select({
      conversations: sql<number>`(SELECT COUNT(*) FROM ${conversations})`,
      inbound: sql<number>`COUNT(*) FILTER (WHERE ${messages.direction} = 'inbound')`,
      outbound: sql<number>`COUNT(*) FILTER (WHERE ${messages.direction} = 'outbound')`,
    })
    .from(messages);

  const editRate =
    agentStats.approved + agentStats.edited > 0
      ? `${((agentStats.edited / (agentStats.approved + agentStats.edited)) * 100).toFixed(1)}%`
      : "—";

  return (
    <main className="h-full space-y-8 overflow-y-auto px-6 py-6">
      {/* Above the metrics on purpose: Sendivo's own numbers can look healthy
          while nothing reaches us, which is the failure this catches. */}
      <WebhookHealth db={db} />

      <section>
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Campaigns</h1>
          <p className="text-xs text-muted-foreground">
            Sendivo delivery metrics · {startDate} → {endDate}
          </p>
        </div>
        {!metrics.ok ? (
          <p className="mt-3 rounded border border-border p-3 text-sm text-yellow-400">
            Sendivo metrics unavailable: {metrics.reason}
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Tile label="SMS sent" value={metrics.data.sms_sent.toLocaleString("en-US")} />
            <Tile label="Segments" value={metrics.data.segments_sent.toLocaleString("en-US")} />
            <Tile label="Inbound" value={metrics.data.inbound_sms_received.toLocaleString("en-US")} />
            <Tile
              label="Delivery rate"
              value={metrics.data.delivery_rate != null ? `${metrics.data.delivery_rate}%` : "—"}
            />
            <Tile
              label="Response rate"
              value={metrics.data.response_rate != null ? `${metrics.data.response_rate}%` : "—"}
            />
            <Tile
              label="Opt-out rate"
              value={metrics.data.opt_out_rate != null ? `${metrics.data.opt_out_rate}%` : "—"}
            />
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Agent stats (autonomy evidence)</h2>
          <KillSwitch initialOn={killSwitchOn} available={redisAvailable} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Tile label="Drafts" value={agentStats.drafts.toString()} hint="M3" />
          <Tile label="Approved" value={agentStats.approved.toString()} />
          <Tile label="Edited" value={agentStats.edited.toString()} />
          <Tile label="Edit rate" value={editRate} hint="auto-send at <10%" />
          <Tile label="Sends blocked" value={agentStats.blocked.toString()} hint="guardrails" />
          <Tile label="Threads" value={local.conversations.toString()} hint={`${local.inbound} in / ${local.outbound} out`} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground">Campaign readiness (§10 gate)</h2>
        {campaignGates.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No campaigns yet.</p>}
        <div className="mt-2 space-y-2">
          {campaignGates.map((campaign) => (
            <div key={campaign.id} className="rounded border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{campaign.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {campaign.market ?? "no market"} · {campaign.status}
                  </p>
                </div>
                <span className={`text-xs ${campaign.gate.canGoLive ? "text-green-400" : "text-yellow-400"}`}>
                  {campaign.gate.canGoLive ? "✅ ready to go live" : `${campaign.gate.blockers.length} blocking`}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {campaign.gate.checks.map((check) => (
                  <span
                    key={check.key}
                    title={check.passed ? "ready" : check.fix}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      check.passed ? "bg-green-950 text-green-300" : "bg-yellow-950 text-yellow-300"
                    }`}
                  >
                    {check.passed ? "✓" : "✗"} {check.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground">Recent blasts (Sendivo)</h2>
        {!blasts ? (
          <p className="mt-2 text-sm text-muted-foreground">Blast list unavailable.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {blasts.blasts.map((blast) => (
              <div key={blast.id} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{blast.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {blast.contacts_count?.toLocaleString("en-US") ?? "—"} contacts ·{" "}
                    {blast.sms_sent?.toLocaleString("en-US") ?? "—"} sent · {blast.status}
                    {blast.created_at ? ` · ${formatDateTime(new Date(blast.created_at))}` : ""}
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {/* metrics are null while a blast is still running */}
                  <p>{blast.delivery_rate != null ? `${blast.delivery_rate}% delivered` : "in progress"}</p>
                  <p>{blast.reply_rate != null ? `${blast.reply_rate}% replies` : ""}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
