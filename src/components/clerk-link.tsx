"use client";

import { useState } from "react";
import { clerkPortal } from "@/lib/clerk";

/**
 * Opens the county's official-records portal and puts the owner name on the
 * clipboard in the same click.
 *
 * The portals can't be deep-linked to a parcel (see lib/clerk.ts), so the real
 * friction isn't finding the site — it's retyping "BALOG CHRISTOPHER GEORGE +"
 * into a search box without a typo. Copying first turns the lookup into a
 * paste.
 */
export function ClerkLink({
  county,
  ownerName,
  parcelId,
}: {
  county: string;
  ownerName: string | null;
  parcelId: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const portal = clerkPortal(county);
  if (!portal) return null;

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard can be blocked; the link still works, so fail quietly.
      setCopied(null);
    }
  };

  return (
    <div className="rounded border border-border p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Title research</span>
        <a
          href={portal.url}
          target="_blank"
          rel="noreferrer"
          onClick={() => ownerName && copy(ownerName, "owner")}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {portal.label} ↗
        </a>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Opens the records search and copies the {portal.searchBy} — these portals can&apos;t be linked straight to a
        parcel, so paste it in.
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {ownerName && (
          <button
            type="button"
            onClick={() => copy(ownerName, "owner")}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-secondary/50"
          >
            {copied === "owner" ? "copied ✓" : `copy owner`}
          </button>
        )}
        <button
          type="button"
          onClick={() => copy(parcelId, "parcel")}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-secondary/50"
        >
          {copied === "parcel" ? "copied ✓" : "copy parcel id"}
        </button>
      </div>
    </div>
  );
}
