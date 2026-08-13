"use client";

import { useState, useTransition } from "react";
import { sendMessageAction } from "@/app/(crm)/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Deal Room composer. Marlon's sends run the same guardrails as the agent's
 * (opt-out, quiet hours) minus approval — blocks surface inline (§2.1).
 * Pending agent-draft cards mount here in M3.
 */
export function Composer({ conversationId, disabled }: { conversationId: string; disabled?: boolean }) {
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-2 border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setNotice(null);
        startTransition(async () => {
          const result = await sendMessageAction(conversationId, body);
          if (result.ok) {
            setBody("");
          } else {
            setNotice(result.reason ?? "send failed");
          }
        });
      }}
    >
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={disabled ? "Sending unavailable" : "Message the seller…"}
        rows={2}
        maxLength={1600}
        disabled={disabled || pending}
        className="resize-none text-sm"
      />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">{body.length}/1600 · guardrails: opt-out, quiet hours 8a–9p ET</p>
        <Button type="submit" size="sm" disabled={disabled || pending || !body.trim()}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
      {notice && <p className="text-xs text-yellow-400">Blocked: {notice}</p>}
    </form>
  );
}
