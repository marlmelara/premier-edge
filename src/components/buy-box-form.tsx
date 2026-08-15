"use client";

import { useState, useTransition } from "react";
import { deleteBuyBoxAction, saveBuyBoxAction } from "@/app/(crm)/buyers/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SewerType, UtilityRule, WaterSource } from "@/lib/eligibility/buy-box";

const COUNTIES = [
  { value: "lee", label: "Lee" },
  { value: "charlotte", label: "Charlotte" },
  { value: "st_lucie", label: "St. Lucie" },
];

/** The four real combinations, plus catch-alls for buyers who price on one side only. */
const COMBOS: { water: WaterSource | "any"; sewer: SewerType | "any"; label: string }[] = [
  { water: "city", sewer: "city", label: "City water + city sewer" },
  { water: "city", sewer: "septic", label: "City water + septic" },
  { water: "well", sewer: "city", label: "Well + city sewer" },
  { water: "well", sewer: "septic", label: "Well + septic" },
  { water: "any", sewer: "any", label: "Anything else (catch-all)" },
];

export type BuyBoxRow = {
  id: string;
  name: string | null;
  county: string | null;
  cities: string[] | null;
  zips: string[] | null;
  minSqft: number;
  allowedFloodZones: string[];
  wetlandsAllowed: boolean;
  builderBuyPrice: string;
  minAssignmentFee: string;
  anchorPct: string;
  utilityRules: UtilityRule[] | null;
};

type Draft = { enabled: boolean; accepted: boolean; buyPrice: string };

/**
 * One buy box: where it applies, what the lot must be, and what it's worth.
 *
 * The utility matrix lives inside this single entry rather than as separate
 * boxes per combination — size, flood and wetlands are stated once, and only
 * the price varies. Amounts are absolute, matching how Marlon quotes them.
 */
export function BuyBoxForm({
  builderId,
  box,
  onDone,
}: {
  builderId: string;
  box?: BuyBoxRow;
  onDone?: () => void;
}) {
  const initial: Record<string, Draft> = {};
  for (const combo of COMBOS) {
    const key = `${combo.water}|${combo.sewer}`;
    const existing = box?.utilityRules?.find((r) => r.water === combo.water && r.sewer === combo.sewer);
    initial[key] = {
      enabled: Boolean(existing),
      accepted: existing ? existing.accepted : true,
      buyPrice: existing?.buyPriceCents != null ? String(existing.buyPriceCents / 100) : "",
    };
  }

  const [drafts, setDrafts] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const serialized = COMBOS.filter((c) => drafts[`${c.water}|${c.sewer}`].enabled).map((c) => {
    const d = drafts[`${c.water}|${c.sewer}`];
    return { water: c.water, sewer: c.sewer, accepted: d.accepted, buyPrice: d.buyPrice || undefined };
  });

  return (
    <form
      className="space-y-3 rounded border border-border p-3"
      action={(fd) => {
        setError(null);
        fd.set("builderId", builderId);
        if (box) fd.set("boxId", box.id);
        fd.set("utilityRules", JSON.stringify(serialized));
        startTransition(async () => {
          const result = await saveBuyBoxAction(fd);
          if (!result.ok) setError(result.reason);
          else onDone?.();
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="text-muted-foreground">Name</span>
          <Input name="name" defaultValue={box?.name ?? ""} placeholder="Cape Coral standard" className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">County</span>
          <select
            name="county"
            defaultValue={box?.county ?? "lee"}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            {COUNTIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Cities (optional, comma-separated)</span>
          <Input name="cities" defaultValue={box?.cities?.join(", ") ?? ""} placeholder="Cape Coral" className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Zips (optional)</span>
          <Input name="zips" defaultValue={box?.zips?.join(", ") ?? ""} placeholder="33993, 33991" className="text-sm" />
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Leave cities and zips blank for the whole county. A narrower box wins over a wider one automatically.
      </p>

      <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
        <label className="text-xs">
          <span className="text-muted-foreground">Min lot size (sqft)</span>
          <Input name="minSqft" type="number" defaultValue={box?.minSqft ?? 10000} className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Allowed flood zones</span>
          <Input name="allowedFloodZones" defaultValue={box?.allowedFloodZones?.join(", ") ?? "X"} className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Base price per lot</span>
          <Input name="builderBuyPrice" defaultValue={box?.builderBuyPrice ?? ""} placeholder="135000" className="text-sm" />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Your min assignment fee</span>
          <Input name="minAssignmentFee" defaultValue={box?.minAssignmentFee ?? ""} placeholder="5000" className="text-sm" />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="wetlandsAllowed" defaultChecked={box?.wetlandsAllowed ?? false} />
          <span>Wetlands OK</span>
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">Anchor % of max</span>
          <Input name="anchorPct" defaultValue={box?.anchorPct ?? "0.780"} className="text-sm" />
        </label>
      </div>

      <div className="border-t border-border pt-3">
        <p className="text-xs font-medium">Utility pricing</p>
        <p className="mb-2 text-[10px] text-muted-foreground">
          Tick only the combinations this buyer takes. Blank price means the base price above. Leave all unticked if
          utilities don&apos;t change what they pay.
        </p>
        <div className="space-y-1">
          {COMBOS.map((combo) => {
            const key = `${combo.water}|${combo.sewer}`;
            const d = drafts[key];
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  onChange={(e) => update(key, { enabled: e.target.checked })}
                />
                <span className="w-48 shrink-0">{combo.label}</span>
                <select
                  value={d.accepted ? "buy" : "no"}
                  disabled={!d.enabled}
                  onChange={(e) => update(key, { accepted: e.target.value === "buy" })}
                  className="rounded border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-40"
                >
                  <option value="buy">Will buy</option>
                  <option value="no">Won&apos;t buy</option>
                </select>
                <Input
                  value={d.buyPrice}
                  disabled={!d.enabled || !d.accepted}
                  onChange={(e) => update(key, { buyPrice: e.target.value })}
                  placeholder="base price"
                  className="h-7 w-28 text-xs disabled:opacity-40"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : box ? "Save buy box" : "Add buy box"}
        </Button>
        {box && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => startTransition(async () => void (await deleteBuyBoxAction(box.id)))}
            className="text-red-400"
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
