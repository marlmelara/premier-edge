/**
 * Dollar validation (design doc §6): any dollar figure in an agent draft must
 * equal a value code supplied. The LLM never computes money — if a number it
 * wrote isn't on the allowed list, the draft is rejected, and two rejections on
 * a thread escalate to Marlon.
 *
 * Pure functions, no I/O — these are the unit-testable core of the guardrail.
 */

/** Every money-looking figure in a message, in cents. */
export function extractDollarAmounts(text: string): number[] {
  const found: number[] = [];
  const push = (raw: string) => {
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value)) found.push(Math.round(value * 100));
  };

  // $12,000 / $12000.50 / $12k
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k\b)?/gi)) {
    const base = Number(m[1].replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
    found.push(Math.round((m[3] ? base * 1000 : base) * 100));
  }

  // 12,000 dollars / 12000 dollars / 18k
  for (const m of text.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d+)\s?(?:dollars|bucks)\b/gi)) push(m[1]);
  for (const m of text.matchAll(/\b(\d{1,3}(?:\.\d)?)\s?k\b/gi)) {
    found.push(Math.round(Number(m[1]) * 1000 * 100));
  }

  // Bare comma-grouped numbers read as money: "I can do 18,700"
  for (const m of text.matchAll(/(?<![$\d.,])\b(\d{1,3}(?:,\d{3})+)\b/g)) push(m[1]);

  // Bare integers of 4+ digits, excluding year-like values so "closing in 2026"
  // isn't treated as a price.
  for (const m of text.matchAll(/(?<![$\d.,])\b(\d{4,7})\b(?![\d.,])/g)) {
    const value = Number(m[1]);
    if (value >= 1900 && value <= 2100) continue;
    found.push(value * 100);
  }

  return [...new Set(found)];
}

export type DollarValidation =
  | { ok: true; amounts: number[] }
  | { ok: false; amounts: number[]; disallowed: number[]; missingRequired?: number };

/**
 * @param allowedCents every amount code supplied for this draft. Includes the
 *        seller's own stated price: repeating what they said back to them is
 *        normal negotiation, and that number came from code, not the model.
 * @param mustIncludeCents when we authorized an offer, the draft has to actually
 *        contain it. Without this a draft could name only the seller's number
 *        ("we can do $150,000") and pass — committing us above our ceiling.
 */
export function validateDraftDollars(
  text: string,
  allowedCents: number[],
  mustIncludeCents?: number | null,
): DollarValidation {
  const amounts = extractDollarAmounts(text);
  const allowed = new Set(allowedCents);
  const disallowed = amounts.filter((cents) => !allowed.has(cents));
  if (disallowed.length > 0) return { ok: false, amounts, disallowed };

  if (mustIncludeCents != null && !amounts.includes(mustIncludeCents)) {
    return { ok: false, amounts, disallowed: [], missingRequired: mustIncludeCents };
  }
  return { ok: true, amounts };
}
