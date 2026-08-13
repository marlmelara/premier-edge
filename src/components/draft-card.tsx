"use client";

import { useState, useTransition } from "react";
import { resolveDraftAction } from "@/app/(crm)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PendingDraft } from "@/lib/agent/drafts";
import { formatMoney } from "@/lib/format";

/**
 * The approval queue, rendered inline in the composer (design doc §2.1).
 * Nothing the agent writes reaches a seller without passing through here.
 */
export function DraftCard({ conversationId, draft }: { conversationId: string; draft: PendingDraft }) {
  const [body, setBody] = useState(draft.message);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const edited = body.trim() !== draft.message;

  const run = (decision: Parameters<typeof resolveDraftAction>[2]) => {
    setNotice(null);
    startTransition(async () => {
      const result = await resolveDraftAction(conversationId, draft.id, decision);
      if (!result.ok) setNotice(result.reason ?? "failed");
    });
  };

  return (
    <div className="space-y-2 border-t border-amber-900/60 bg-amber-950/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-amber-700 text-[10px] text-amber-300">
          AGENT DRAFT · needs approval
        </Badge>
        <span className="text-[11px] text-muted-foreground">{draft.classification.replace(/_/g, " ")}</span>
        {draft.authorizedOfferCents != null && (
          <Badge variant="outline" className="text-[10px]">
            offer {formatMoney(draft.authorizedOfferCents / 100)}
          </Badge>
        )}
        {draft.isCeilingOffer && (
          <Badge variant="destructive" className="text-[10px]">
            AT CEILING
          </Badge>
        )}
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={1600}
        disabled={pending}
        className="resize-none bg-background text-sm"
      />
      {draft.notes && <p className="text-[11px] text-muted-foreground">Why: {draft.notes}</p>}

      {rejecting ? (
        <div className="space-y-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why is this wrong? (feeds prompt tuning)"
            className="resize-none bg-background text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => run({ action: "reject", reason: reason.trim() })}
            >
              Confirm reject
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || !body.trim()}
            onClick={() => run({ action: edited ? "edit" : "approve", body: body.trim() })}
          >
            {pending ? "Sending…" : edited ? "Send edited" : "Approve & send"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
          {edited && <span className="text-[11px] text-amber-400">counts as an edit</span>}
        </div>
      )}

      {notice && <p className="text-xs text-yellow-400">{notice}</p>}
    </div>
  );
}
