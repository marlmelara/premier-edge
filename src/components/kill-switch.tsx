"use client";

import { useState, useTransition } from "react";
import { setKillSwitchAction } from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";

/**
 * Global kill switch (design doc §6). Stops the agent from producing new
 * drafts; sends already in the approval queue are unaffected — Marlon still
 * decides on those.
 */
export function KillSwitch({ initialOn, available }: { initialOn: boolean; available: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!available) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Kill switch needs Redis (UPSTASH_REDIS_REST_URL / _TOKEN).
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className={`text-sm ${on ? "text-red-400" : "text-muted-foreground"}`}>
        Agent drafting: {on ? "STOPPED" : "running"}
      </span>
      <Button
        size="sm"
        variant={on ? "default" : "destructive"}
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await setKillSwitchAction(!on);
            if (result.ok) setOn(!on);
            else setError(result.reason);
          });
        }}
      >
        {pending ? "…" : on ? "Resume agent" : "Kill switch"}
      </Button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
