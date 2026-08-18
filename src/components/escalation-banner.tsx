"use client";

import { useState, useTransition } from "react";
import { resolveEscalationAction } from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";

/**
 * An escalated thread and the way out of it.
 *
 * Escalation used to be permanent — nothing cleared the flag — so the queue
 * filled with threads that had already been handled. Resuming picks the state
 * the conversation should return to, because a thread escalated mid-negotiation
 * shouldn't restart at qualifying.
 */
export function EscalationBanner({
  conversationId,
  reason,
}: {
  conversationId: string;
  reason: string | null;
}) {
  const [resume, setResume] = useState<"QUALIFYING" | "NEGOTIATING" | "OFFER_SENT">("QUALIFYING");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="border-b border-red-900/60 bg-red-950/30 p-3">
      <p className="text-xs font-medium text-red-300">🚨 Escalated — the agent has stopped on this thread</p>
      {reason && <p className="mt-0.5 text-[11px] text-red-200/80">{reason}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={resume}
          onChange={(e) => setResume(e.target.value as typeof resume)}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="QUALIFYING">Resume at qualifying</option>
          <option value="NEGOTIATING">Resume at negotiating</option>
          <option value="OFFER_SENT">Resume at offer sent</option>
        </select>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await resolveEscalationAction(conversationId, resume);
              if (!result.ok) setError(result.reason);
            });
          }}
        >
          {pending ? "Resuming…" : "I handled it — resume"}
        </Button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
