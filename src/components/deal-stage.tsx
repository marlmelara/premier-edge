"use client";

import { useState, useTransition } from "react";
import { setDealCampaignAction, setDealStageAction } from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

/**
 * Move a deal by hand, and record the money when it closes.
 *
 * The lifecycle previously stopped at `under_contract` — contracts pushed it
 * there and nothing could move it further, so a deal that actually funded had
 * nowhere to be recorded and the Closings page could never show a number.
 *
 * The fee is required to close, because a closed deal with no fee would report
 * the month as earning nothing.
 */
export function DealStage({
  dealId,
  stage,
  assignmentFee,
  campaignId,
  campaigns = [],
}: {
  dealId: string;
  stage: string;
  assignmentFee: string | null;
  campaignId: string | null;
  campaigns?: { id: string; name: string }[];
}) {
  const [next, setNext] = useState(stage);
  const [fee, setFee] = useState(assignmentFee ?? "");
  const [closedAt, setClosedAt] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = next !== stage;
  const closing = next === "closed";

  return (
    <div className="space-y-2 rounded border border-border p-2 text-xs" data-testid="deal-stage">
      {/* The campaign supplies the buy boxes — a deal without one can never be
          priced, whatever buyers exist. */}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Campaign</span>
        <select
          value={campaignId ?? ""}
          disabled={pending}
          onChange={(e) =>
            startTransition(async () => {
              await setDealCampaignAction(dealId, e.target.value || null);
            })
          }
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">none — nothing can be priced</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {!campaignId && (
        <p className="text-[10px] text-amber-400">
          No campaign, so no buy boxes apply and this lot will always verdict “pending”.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Deal stage</span>
        <select
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {closing && (
        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className="text-muted-foreground">Assignment fee</span>
            <Input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="5000" className="h-8 text-xs" />
          </label>
          <label>
            <span className="text-muted-foreground">Funded on</span>
            <Input
              type="date"
              value={closedAt}
              onChange={(e) => setClosedAt(e.target.value)}
              className="h-8 text-xs"
            />
          </label>
        </div>
      )}

      {dirty && (
        <Button
          size="sm"
          disabled={pending}
          className="w-full"
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await setDealStageAction(dealId, next, { assignmentFee: fee, closedAt });
              if (!result.ok) setError(result.reason);
            });
          }}
        >
          {pending ? "Saving…" : closing ? "Mark closed" : `Move to ${next.replace(/_/g, " ")}`}
        </Button>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
