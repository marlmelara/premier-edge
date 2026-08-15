"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CampaignForm, type CampaignRow } from "@/components/campaign-form";

/** Campaign management. Without one, nothing can be priced. */
export function CampaignManager({ campaigns }: { campaigns: CampaignRow[] }) {
  const [adding, setAdding] = useState(campaigns.length === 0);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {campaigns.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          No campaigns yet. A campaign ties buyers to a market — eligibility can&apos;t run without one.
        </p>
      )}

      {campaigns.map((c) =>
        editing === c.id ? (
          <CampaignForm key={c.id} campaign={c} onDone={() => setEditing(null)} />
        ) : (
          <button
            key={c.id}
            type="button"
            onClick={() => setEditing(c.id)}
            className="flex w-full items-center justify-between rounded border border-border p-2 text-left text-sm hover:bg-secondary/40"
          >
            <span>
              <span className="font-medium">{c.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">{c.market ?? "no market"}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">{c.status}</span>
          </button>
        ),
      )}

      {adding ? (
        <CampaignForm onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="ghost" className="text-xs" onClick={() => setAdding(true)}>
          + New campaign
        </Button>
      )}
    </div>
  );
}
