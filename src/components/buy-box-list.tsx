"use client";

import { useState, useTransition } from "react";
import { deleteBuyerAction } from "@/app/(crm)/buyers/actions";
import { Button } from "@/components/ui/button";
import { BuyBoxForm, type BuyBoxRow } from "@/components/buy-box-form";
import { describeUtilityRules } from "@/lib/eligibility/buy-box";
import { formatMoney, formatSqft } from "@/lib/format";

const COUNTY_LABELS: Record<string, string> = { lee: "Lee", charlotte: "Charlotte", st_lucie: "St. Lucie" };

/**
 * A buyer's buy boxes. Several per buyer is the normal case — county-wide plus
 * tighter ones for a city or zip — so they're listed rather than folded into
 * the buyer form.
 */
export function BuyBoxList({
  builderId,
  builderName,
  boxes,
}: {
  builderId: string;
  builderName: string;
  boxes: BuyBoxRow[];
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Buy boxes ({boxes.length})
        </p>
        <button
          type="button"
          disabled={pending}
          className="text-[11px] text-red-400 hover:underline disabled:opacity-50"
          onClick={() => {
            setDeleteError(null);
            startTransition(async () => {
              const result = await deleteBuyerAction(builderId);
              if (!result.ok) setDeleteError(result.reason);
            });
          }}
        >
          Delete {builderName}
        </button>
      </div>
      {deleteError && <p className="text-[11px] text-amber-400">{deleteError}</p>}

      {boxes.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">
          No buy box yet — nothing can be priced for this buyer until there is one.
        </p>
      )}

      {boxes.map((box) =>
        editing === box.id ? (
          <BuyBoxForm key={box.id} builderId={builderId} box={box} onDone={() => setEditing(null)} />
        ) : (
          <button
            key={box.id}
            type="button"
            onClick={() => setEditing(box.id)}
            className="w-full rounded border border-border p-2 text-left text-xs hover:bg-secondary/40"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{box.name ?? "Buy box"}</span>
              <span className="text-[10px] text-muted-foreground">
                {COUNTY_LABELS[box.county ?? ""] ?? box.county}
                {box.cities?.length ? ` · ${box.cities.join(", ")}` : ""}
                {box.zips?.length ? ` · ${box.zips.join(", ")}` : ""}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {formatSqft(box.minSqft)}+ · zones {box.allowedFloodZones.join("/")} ·{" "}
              {box.wetlandsAllowed ? "wetlands OK" : "no wetlands"} · base {formatMoney(box.builderBuyPrice)} · fee floor{" "}
              {formatMoney(box.minAssignmentFee)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {describeUtilityRules(box.utilityRules ?? [])}
            </p>
          </button>
        ),
      )}

      {adding ? (
        <BuyBoxForm builderId={builderId} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)} className="text-xs">
          + Add buy box
        </Button>
      )}
    </div>
  );
}
