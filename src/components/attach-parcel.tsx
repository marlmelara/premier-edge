"use client";

import { useState, useTransition } from "react";
import { attachParcelAction } from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const COUNTY_LABELS: Record<string, string> = {
  st_lucie: "St. Lucie",
  lee: "Lee",
  charlotte: "Charlotte",
};

export function AttachParcelForm({ dealId }: { dealId: string }) {
  const [county, setCounty] = useState("lee");
  const [parcelId, setParcelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      data-testid="attach-parcel-form"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await attachParcelAction(dealId, county, parcelId);
          if (!result.ok) setError(result.reason);
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
      <Button type="submit" size="sm" disabled={pending || !parcelId.trim()} className="w-full">
        {pending ? "Verifying…" : "Verify & link parcel"}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
