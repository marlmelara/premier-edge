import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatMoney, formatPhone, formatSqft } from "@/lib/format";
import { getSeller360 } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seller 360 — Premier Edge" };

/**
 * One page per contact (design doc §2.2): identity, every conversation,
 * every linked parcel, offer history, full agent_actions timeline.
 * Answers "have we ever talked to this person, about what land, how did it end."
 */
export default async function SellerPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  const data = await getSeller360(contactId).catch(() => null);
  if (!data) notFound();
  const { contact, deals, conversations, offers, parcels, actions, campaignNames } = data;

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      {/* Identity */}
      <section>
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">{contact.name ?? formatPhone(contact.phone)}</h1>
          {contact.optedOut && <Badge variant="destructive">OPTED OUT</Badge>}
          {contact.stage && <Badge variant="outline">{contact.stage}</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatPhone(contact.phone)}
          {contact.email ? ` · ${contact.email}` : ""}
          {contact.altPhones?.length ? ` · alt: ${contact.altPhones.map(formatPhone).join(", ")}` : ""}
        </p>
        {(contact.mailingStreet || contact.mailingCity) && (
          <p className="text-sm text-muted-foreground">
            {[contact.mailingStreet, contact.mailingCity, contact.mailingState, contact.mailingZip]
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
        {contact.labels && contact.labels.length > 0 && (
          <div className="mt-2 flex gap-1">
            {contact.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        )}
        {contact.notes && <p className="mt-2 text-sm">{contact.notes}</p>}
      </section>

      {/* Parcels */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Linked parcels</h2>
        {parcels.length === 0 && <p className="text-sm text-muted-foreground">None linked.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {parcels.map(({ parcel, dealId }) => {
            const deal = deals.find((d) => d.id === dealId);
            return (
              <div key={parcel.id} className="rounded border border-border p-3 text-sm">
                <p className="font-medium">{parcel.address ?? parcel.parcelId}</p>
                <p className="text-xs text-muted-foreground">
                  {parcel.county} · {parcel.parcelId} · {formatSqft(parcel.sqft)}
                </p>
                <p className="mt-1 text-xs">
                  {deal?.verdict === "pass" ? "✅ eligible" : deal?.verdict === "fail" ? "❌ failed" : "⚠️ pending"}
                  {deal?.maxOffer ? ` · max ${formatMoney(deal.maxOffer)}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Conversations */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Conversations</h2>
        {conversations.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
        <div className="space-y-1">
          {conversations.map((conv) => {
            const deal = deals.find((d) => d.id === conv.dealId);
            return (
              <Link
                key={conv.id}
                href={`/deal-room?c=${conv.id}`}
                className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm hover:bg-secondary/40"
              >
                <span>
                  {conv.state}
                  {conv.escalated ? " 🚨" : ""}
                  {deal?.campaignId ? ` · ${campaignNames.get(deal.campaignId) ?? "campaign"}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  last inbound {formatDateTime(conv.lastInboundAt)}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Offer history — immutable snapshots */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Offer history</h2>
        {offers.length === 0 && <p className="text-sm text-muted-foreground">No offers yet.</p>}
        <div className="space-y-1">
          {offers.map((offer) => (
            <div key={offer.id} className="flex justify-between rounded border border-border px-3 py-2 text-sm">
              <span>
                v{offer.version} · {formatMoney(offer.amount)}
              </span>
              <span className="text-xs text-muted-foreground">
                {offer.stateAtOffer} · {formatDateTime(offer.createdAt)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* agent_actions timeline */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Activity timeline</h2>
        {actions.length === 0 && <p className="text-sm text-muted-foreground">No recorded actions.</p>}
        <div className="space-y-1">
          {actions.map((action) => (
            <div key={action.id} className="flex justify-between rounded border border-border/50 px-3 py-1.5 text-xs">
              <span className="font-mono">{action.type}</span>
              <span className="text-muted-foreground">
                {action.approvedBy ? `approved by ${action.approvedBy} · ` : ""}
                {formatDateTime(action.createdAt)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
