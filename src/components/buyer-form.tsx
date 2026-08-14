"use client";

import { useState, useTransition } from "react";
import { saveBuyerAction } from "@/app/(crm)/buyers/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type BuyerFormValues = {
  builderId?: string;
  name?: string;
  entityName?: string | null;
  email?: string | null;
  phone?: string | null;
  markets?: string[] | null;
  notes?: string | null;
  minSqft?: number;
  allowedFloodZones?: string[];
  wetlandsAllowed?: boolean;
  builderBuyPrice?: string;
  minAssignmentFee?: string;
  anchorPct?: string;
};

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block space-y-1">
    <span className="text-xs font-medium">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
  </label>
);

/**
 * A buyer and their buy-box. These criteria are what every parcel is scored
 * against before the agent is allowed to name a price.
 */
export function BuyerForm({ initial, onDone }: { initial?: BuyerFormValues; onDone?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await saveBuyerAction(formData);
          if (result.ok) onDone?.();
          else setError(result.reason);
        });
      }}
    >
      {initial?.builderId && <input type="hidden" name="builderId" value={initial.builderId} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Buyer name *">
          <Input name="name" defaultValue={initial?.name} placeholder="Coastal Homes" required />
        </Field>
        <Field label="Signing entity" hint="Goes on the assignment contract">
          <Input name="entityName" defaultValue={initial?.entityName ?? ""} placeholder="Coastal Homes LLC" />
        </Field>
        <Field label="Email" hint="Where the assignment is sent to sign">
          <Input name="email" type="email" defaultValue={initial?.email ?? ""} />
        </Field>
        <Field label="Phone">
          <Input name="phone" defaultValue={initial?.phone ?? ""} />
        </Field>
      </div>

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Buy box — what they&apos;ll take</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="They pay per lot *" hint="Your max offer is this minus your fee floor">
            <Input name="builderBuyPrice" defaultValue={initial?.builderBuyPrice} placeholder="32000" required />
          </Field>
          <Field label="Your minimum fee *" hint="The spread you won't go below">
            <Input name="minAssignmentFee" defaultValue={initial?.minAssignmentFee} placeholder="8000" required />
          </Field>
          <Field label="Minimum lot size (sqft) *">
            <Input name="minSqft" type="number" defaultValue={initial?.minSqft ?? 10000} required />
          </Field>
          <Field label="Allowed flood zones" hint="Comma separated. X only is the safe default.">
            <Input name="allowedFloodZones" defaultValue={(initial?.allowedFloodZones ?? ["X"]).join(", ")} />
          </Field>
          <Field label="Markets" hint="Comma separated. Leave blank to buy anywhere.">
            <Input name="markets" defaultValue={(initial?.markets ?? []).join(", ")} placeholder="Lehigh Acres, Port Charlotte" />
          </Field>
          <Field label="Anchor %" hint="Where the first offer starts, as a fraction of max">
            <Input name="anchorPct" defaultValue={initial?.anchorPct ?? "0.780"} />
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs">
          <input type="checkbox" name="wetlandsAllowed" defaultChecked={initial?.wetlandsAllowed} className="size-4" />
          Will accept lots that intersect wetlands
        </label>
      </div>

      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={initial?.notes ?? ""} className="resize-none" />
      </Field>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : initial?.builderId ? "Save changes" : "Add buyer"}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
