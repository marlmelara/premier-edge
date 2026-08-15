/**
 * Deal labels (§2.2).
 *
 * A curated set rather than free text. Free-text tags drift — "hot", "HOT",
 * "hot lead", "hotlead" — and a filter that misses a third of the rows it
 * should match is worse than no filter. These are the states that change what
 * Marlon does next, grouped so the palette reads at a glance.
 *
 * Anything genuinely one-off belongs in the contact's notes, not a label.
 */

export type LabelGroup = "motivation" | "obstacle" | "logistics";

export type LabelDef = {
  name: string;
  group: LabelGroup;
  /** What it means, and why it changes the next move. */
  hint: string;
};

export const LABELS: LabelDef[] = [
  // Motivation — how hard to push, and how fast.
  { name: "Hot", group: "motivation", hint: "Wants to move now — prioritize the reply" },
  { name: "Motivated", group: "motivation", hint: "Real reason to sell (taxes, probate, moving)" },
  { name: "Price dreamer", group: "motivation", hint: "Asking far above any buy box — park it, stay cordial" },
  { name: "Not selling", group: "motivation", hint: "Declined, but keep the lot on file" },
  { name: "Follow up later", group: "motivation", hint: "Right lot, wrong time — revisit in a few months" },

  // Obstacles — the things that kill a close after the price is agreed.
  { name: "Title issue", group: "obstacle", hint: "Liens, probate, unclear chain — title company first" },
  { name: "Multiple owners", group: "obstacle", hint: "More than one signer; never auto-send a contract" },
  { name: "Not the owner", group: "obstacle", hint: "XCHECK mismatch or wrong number" },
  { name: "Back taxes", group: "obstacle", hint: "Delinquent — payoff comes out of the spread" },
  { name: "Deed only", group: "obstacle", hint: "Owns it outright, no mortgage payoff needed" },

  // Logistics — how to work them.
  { name: "Spanish", group: "logistics", hint: "Prefers Spanish — handle by hand for now" },
  { name: "Call, don't text", group: "logistics", hint: "Asked to be phoned" },
  { name: "Agent involved", group: "logistics", hint: "Represented — expect a commission ask" },
  { name: "Multiple lots", group: "logistics", hint: "Owns more than one parcel worth checking" },
];

export const LABEL_NAMES = LABELS.map((l) => l.name);

const BY_NAME = new Map(LABELS.map((l) => [l.name.toLowerCase(), l]));

export function labelDef(name: string): LabelDef | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** Colour per group, so obstacles read as obstacles without reading the word. */
export const GROUP_STYLE: Record<LabelGroup, string> = {
  motivation: "border-emerald-800 bg-emerald-950/60 text-emerald-300",
  obstacle: "border-red-900 bg-red-950/60 text-red-300",
  logistics: "border-sky-900 bg-sky-950/60 text-sky-300",
};

export const GROUP_LABEL: Record<LabelGroup, string> = {
  motivation: "Motivation",
  obstacle: "Obstacle",
  logistics: "Logistics",
};

export function styleFor(name: string): string {
  const def = labelDef(name);
  // An unknown label (renamed in code, still on a row) stays visible and neutral
  // rather than vanishing — losing a tag silently is worse than an odd colour.
  return def ? GROUP_STYLE[def.group] : "border-border bg-secondary text-muted-foreground";
}
