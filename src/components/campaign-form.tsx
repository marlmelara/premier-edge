"use client";

import { useState, useTransition } from "react";
import { deleteCampaignAction, saveCampaignAction } from "@/app/(crm)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type CampaignRow = {
  id: string;
  name: string;
  market: string | null;
  status: string;
  sendivoCampaignId: string | null;
};

/**
 * Create or edit a campaign. A campaign is what ties buyers to a market, and
 * nothing can be priced without one — until now the only way to get a campaign
 * was to seed it with a script.
 */
export function CampaignForm({ campaign, onDone }: { campaign?: CampaignRow; onDone?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-2 rounded border border-border p-3"
      action={(fd) => {
        setError(null);
        if (campaign) fd.set("id", campaign.id);
        startTransition(async () => {
          const result = await saveCampaignAction(fd);
          if (!result.ok) setError(result.reason);
          else onDone?.();
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="text-muted-foreground">Name</span>
          <Input name="name" defaultValue={campaign?.name ?? ""} placeholder="Cape Coral — Aug 2026" className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Market</span>
          <Input name="market" defaultValue={campaign?.market ?? ""} placeholder="Cape Coral" className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Status</span>
          <select
            name="status"
            defaultValue={campaign?.status ?? "draft"}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            {["draft", "ready", "live", "paused", "done"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Sendivo campaign id (optional)</span>
          <Input
            name="sendivoCampaignId"
            defaultValue={campaign?.sendivoCampaignId ?? ""}
            placeholder="4230"
            className="text-sm"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : campaign ? "Save" : "Create campaign"}
        </Button>
        {campaign && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            className="text-red-400"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteCampaignAction(campaign.id);
                if (!result.ok) setError(result.reason);
              })
            }
          >
            Delete
          </Button>
        )}
        {onDone && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
