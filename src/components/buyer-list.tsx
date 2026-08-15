"use client";

import { useState, useTransition } from "react";
import { BuyBoxList } from "@/components/buy-box-list";
import type { BuyBoxRow } from "@/components/buy-box-form";
import { toggleCampaignBuyerAction } from "@/app/(crm)/buyers/actions";
import { BuyerForm, type BuyerFormValues } from "@/components/buyer-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";


export type BuyerRow = BuyerFormValues & {
  builderId: string;
  name: string;
  maxOffer: string | null;
  campaignIds: string[];
  /** Several per buyer — county-wide plus tighter city/zip boxes. */
  boxes: BuyBoxRow[];
};

export type CampaignRef = { id: string; name: string };

export function BuyerList({ buyers, campaigns }: { buyers: BuyerRow[]; campaigns: CampaignRef[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      {adding ? (
        <BuyerForm onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" onClick={() => setAdding(true)}>
          Add buyer
        </Button>
      )}

      {buyers.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          No buyers yet. Until at least one exists with a buy box, the agent can&apos;t price anything — every lot
          comes back &ldquo;pending&rdquo; because there&apos;s nobody to match it against.
        </p>
      )}

      {buyers.map((buyer) =>
        editing === buyer.builderId ? (
          <BuyerForm key={buyer.builderId} initial={buyer} onDone={() => setEditing(null)} />
        ) : (
          <div key={buyer.builderId} className="rounded-lg border border-border p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{buyer.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {buyer.entityName ?? "no signing entity"} · {buyer.email ?? "no email"}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(buyer.builderId)}>
                Edit
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
              {buyer.markets?.length ? (
                <Badge variant="outline">{buyer.markets.join(", ")}</Badge>
              ) : (
                <Badge variant="outline">any market</Badge>
              )}
            </div>

            <div className="mt-3 border-t border-border pt-3">
              <BuyBoxList builderId={buyer.builderId} builderName={buyer.name} boxes={buyer.boxes} />
            </div>

            {campaigns.length > 0 && (
              <div className="mt-3 border-t border-border pt-2">
                <p className="mb-1 text-[11px] text-muted-foreground">Sourcing for:</p>
                <div className="flex flex-wrap gap-3">
                  {campaigns.map((campaign) => {
                    const attached = buyer.campaignIds.includes(campaign.id);
                    return (
                      <label key={campaign.id} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={attached}
                          disabled={pending}
                          onChange={() =>
                            startTransition(async () => {
                              await toggleCampaignBuyerAction(campaign.id, buyer.builderId, !attached);
                            })
                          }
                        />
                        {campaign.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
