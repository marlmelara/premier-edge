"use client";

import { useState, useTransition } from "react";
import {
  detachParcelAction,
  linkParcelToContactAction,
  setDealParcelAction,
  unlinkParcelFromContactAction,
} from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const COUNTY_LABELS: Record<string, string> = { st_lucie: "St. Lucie", lee: "Lee", charlotte: "Charlotte" };

export type OwnedParcel = {
  parcelRowId: string;
  county: string;
  parcelId: string;
  address: string | null;
  sqft: number | null;
  floodZones: string[] | null;
  wetlandsIntersects: boolean | null;
};

/**
 * Every lot a seller is on record for, and which one this deal is about.
 *
 * The two are deliberately separate. `contact_parcels` is ownership — a seller
 * with three vacant lots is ordinary, and we want all three on file the moment
 * they mention them. `deals.parcel_id` is the subject of *this* negotiation,
 * because the offer math, the eligibility verdict and the contract all have to
 * point at exactly one piece of land.
 *
 * Detaching is a first-class action: an auto-matched or hand-typed parcel can
 * be wrong, and being unable to take it back would leave the agent pricing land
 * the seller doesn't own.
 */
export function ParcelManager({
  dealId,
  contactId,
  activeParcelRowId,
  owned,
}: {
  dealId: string;
  contactId: string;
  activeParcelRowId: string | null;
  owned: OwnedParcel[];
}) {
  const [county, setCounty] = useState("lee");
  const [parcelId, setParcelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(owned.length === 0);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; reason?: string; address?: string }>) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.reason ?? "failed");
      else if (result.address) setNotice(`Linked ${result.address}`);
    });
  };

  return (
    <div className="space-y-2" data-testid="parcel-manager">
      {owned.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Lots on record ({owned.length})
          </p>
          {owned.map((lot) => {
            const active = lot.parcelRowId === activeParcelRowId;
            return (
              <div
                key={lot.parcelRowId}
                className={`rounded border p-2 text-xs ${
                  active ? "border-primary/60 bg-primary/5" : "border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{lot.address ?? lot.parcelId}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {COUNTY_LABELS[lot.county] ?? lot.county} · {lot.parcelId}
                      {lot.sqft ? ` · ${lot.sqft.toLocaleString("en-US")} sqft` : ""}
                      {lot.floodZones?.length ? ` · ${lot.floodZones.join("/")}` : ""}
                      {lot.wetlandsIntersects ? " · wetlands" : ""}
                    </p>
                  </div>
                  {active && <span className="shrink-0 text-[10px] font-medium text-primary">THIS DEAL</span>}
                </div>

                <div className="mt-1.5 flex gap-2">
                  {!active && (
                    <button
                      type="button"
                      disabled={pending}
                      className="text-[11px] text-primary hover:underline disabled:opacity-50"
                      onClick={() => run(() => setDealParcelAction(dealId, lot.county, lot.parcelId))}
                    >
                      Make this the deal
                    </button>
                  )}
                  {active && (
                    <button
                      type="button"
                      disabled={pending}
                      className="text-[11px] text-amber-400 hover:underline disabled:opacity-50"
                      onClick={() => run(() => detachParcelAction(dealId))}
                    >
                      Detach from deal
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    className="text-[11px] text-muted-foreground hover:text-red-400 hover:underline disabled:opacity-50"
                    onClick={() => run(() => unlinkParcelFromContactAction(contactId, lot.parcelRowId))}
                  >
                    Not their lot
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <form
          className="space-y-2 rounded border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const id = parcelId.trim();
            // Linking to the contact rather than straight onto the deal: the
            // first lot becomes the deal's subject, later ones just get filed.
            run(async () => {
              const linked = await linkParcelToContactAction(contactId, county, id);
              if (linked.ok && !activeParcelRowId) await setDealParcelAction(dealId, county, id);
              if (linked.ok) setParcelId("");
              return linked;
            });
          }}
        >
          <Select value={county} onValueChange={(value) => setCounty(value ?? county)}>
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>{(value: string) => COUNTY_LABELS[value] ?? value}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="st_lucie">St. Lucie</SelectItem>
              <SelectItem value="lee">Lee</SelectItem>
              <SelectItem value="charlotte">Charlotte</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={parcelId}
            onChange={(e) => setParcelId(e.target.value)}
            placeholder="Parcel ID (STRAP / account / parcel no)"
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || !parcelId.trim()} className="flex-1">
              {pending ? "Verifying…" : owned.length ? "Add another lot" : "Verify & link parcel"}
            </Button>
            {owned.length > 0 && (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add another lot
        </button>
      )}

      {notice && <p className="text-[11px] text-emerald-400">{notice}</p>}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
