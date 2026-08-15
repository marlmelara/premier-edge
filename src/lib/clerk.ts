/**
 * County Clerk official-records links (§2.1, Aug 15 2026).
 *
 * The one external lookup worth keeping: deeds, liens, probate and the chain of
 * title. Everything else on a typical wholesaler's tool rail — appraiser,
 * Zillow, permits — is either already pulled into the property card or
 * irrelevant to vacant land, so it isn't here.
 *
 * These portals cannot be deep-linked to a parcel. They're session-based apps
 * behind strict CSP with unpublished, unstable query parameters; a link built
 * from a guessed pattern would rot silently and send Marlon to an error page
 * mid-negotiation. So the link opens the portal and the card puts the owner
 * name and parcel id one click from the clipboard — the search itself is a
 * paste, which is the honest 90% of the value.
 */

export type ClerkPortal = {
  url: string;
  label: string;
  /** What to search by once the portal is open. */
  searchBy: string;
};

const PORTALS: Record<string, ClerkPortal> = {
  lee: {
    url: "https://www.leeclerk.org/records/official-records",
    label: "Lee County Clerk",
    searchBy: "owner name",
  },
  charlotte: {
    // Verified reachable Aug 15 2026; the others bot-block automated checks but
    // are the counties' own published records pages.
    url: "https://recording.charlotteclerk.com/",
    label: "Charlotte County Clerk",
    searchBy: "owner name",
  },
  st_lucie: {
    url: "https://stlucieclerk.com/official-records",
    label: "St. Lucie County Clerk",
    searchBy: "owner name",
  },
};

export function clerkPortal(county: string): ClerkPortal | null {
  return PORTALS[county] ?? null;
}
