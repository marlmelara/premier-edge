import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Composer } from "@/components/composer";
import { ContextCard } from "@/components/context-card";
import { PollRefresh } from "@/components/poll-refresh";
import { formatDateTime, formatPhone, timeAgo } from "@/lib/format";
import { getConversationDetail, listConversations } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deal Room — Premier Edge" };

const FILTERS = [
  { key: "", label: "All" },
  { key: "needs-attention", label: "Needs reply" },
  { key: "escalated", label: "Escalated" },
  { key: "opted-out", label: "Opted out" },
] as const;

export default async function DealRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; f?: string }>;
}) {
  const { c: selectedId, f: filter = "" } = await searchParams;

  const conversationList = await listConversations({
    escalated: filter === "escalated" || undefined,
    needsAttention: filter === "needs-attention" || undefined,
    state: filter === "opted-out" ? "OPTED_OUT" : undefined,
  });
  const detail = selectedId ? await getConversationDetail(selectedId) : null;

  return (
    <main className="grid h-[calc(100vh-49px)] grid-cols-[300px_1fr_340px]">
      <PollRefresh />

      {/* Left — conversation list */}
      <section className="flex flex-col overflow-hidden border-r border-border">
        <div className="flex gap-1 border-b border-border p-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key ? `/deal-room?f=${f.key}${selectedId ? `&c=${selectedId}` : ""}` : `/deal-room${selectedId ? `?c=${selectedId}` : ""}`}
              className={`rounded px-2 py-1 text-xs ${filter === f.key ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/50"}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversationList.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No conversations{filter ? " for this filter" : " yet"}.</p>
          )}
          {conversationList.map((conv) => {
            const needsReply =
              conv.lastInboundAt && (!conv.lastOutboundAt || conv.lastInboundAt > conv.lastOutboundAt);
            return (
              <Link
                key={conv.id}
                data-testid="conversation-row"
                href={`/deal-room?${filter ? `f=${filter}&` : ""}c=${conv.id}`}
                className={`block border-b border-border/50 px-3 py-2 hover:bg-secondary/40 ${conv.id === selectedId ? "bg-secondary/60" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate text-sm font-medium">
                    {conv.contactName ?? formatPhone(conv.contactPhone)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(conv.lastMessageAt)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1">
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {conv.state}
                  </Badge>
                  {conv.verdict === "pass" && <span className="text-[10px]">✅</span>}
                  {conv.verdict === "fail" && <span className="text-[10px]">❌</span>}
                  {needsReply && <span className="ml-auto size-2 rounded-full bg-blue-400" title="needs reply" />}
                  {conv.escalated && <span className="text-[10px]">🚨</span>}
                </div>
                {conv.campaignName && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{conv.campaignName}</p>
                )}
              </Link>
            );
          })}
        </div>
      </section>

      {/* Center — thread + composer */}
      <section className="flex flex-col overflow-hidden">
        {!detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a conversation
          </div>
        ) : (
          <>
            <div className="border-b border-border px-4 py-2">
              <Link href={`/sellers/${detail.contact?.id}`} className="text-sm font-medium hover:underline">
                {detail.contact?.name ?? (detail.contact ? formatPhone(detail.contact.phone) : "Unknown")}
              </Link>
              <p className="text-xs text-muted-foreground">
                {detail.contact ? formatPhone(detail.contact.phone) : ""}
                {detail.campaign ? ` · ${detail.campaign.name}` : ""} · {detail.conversation.state}
                {detail.conversation.ownedByEdge ? " · owned by Edge" : ""}
              </p>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
              {detail.thread.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
              {detail.thread.map((msg) => (
                <div
                  key={msg.id}
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    msg.direction === "inbound" ? "self-start bg-secondary" : "self-end bg-blue-950 text-blue-100"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                  <p className="mt-1 text-[10px] opacity-60">
                    {formatDateTime(msg.createdAt)}
                    {msg.direction === "outbound" && msg.sentBy ? ` · ${msg.sentBy}` : ""}
                    {msg.direction === "outbound" && msg.status ? ` · ${msg.status}` : ""}
                  </p>
                </div>
              ))}
            </div>
            <Composer
              conversationId={detail.conversation.id}
              disabled={detail.conversation.state === "OPTED_OUT" || detail.contact?.optedOut}
            />
          </>
        )}
      </section>

      {/* Right rail — Property Context Card */}
      <section className="overflow-y-auto border-l border-border">
        {detail ? (
          <ContextCard
            deal={detail.deal}
            parcel={detail.parcel}
            checks={detail.checks}
            contact={detail.contact}
            criteria={detail.criteria}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Property context appears here.</div>
        )}
      </section>
    </main>
  );
}
