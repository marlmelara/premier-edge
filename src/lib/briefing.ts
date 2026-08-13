/**
 * Daily briefing (design doc §11b, Channel 1). One SMS at 9am, modeled on the
 * reference tool: greeting + date header, then lines in priority order, empty
 * lines skipped. Capped at 3 SMS segments — when everything is happening at
 * once, the top of the list is what survives.
 */

export type BriefingData = {
  /**
   * Closings inside the window, soonest first. `daysOut` is null when the deal
   * has no confirmed closing date yet — reported as "at title" rather than
   * inventing a countdown.
   */
  closings: { address: string; daysOut: number | null }[];
  contractsAwaitingSignature: number;
  escalationsPending: number;
  approvalsWaiting: number;
  newRepliesSinceYesterday: number;
  optOutsYesterday: number;
};

/** Concatenated GSM-7 SMS: 153 chars per segment, 3 segments. */
const MAX_CHARS = 153 * 3;

export function composeBriefing(data: BriefingData, now: Date = new Date()): string {
  const date = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const header = `Good morning Marlon — Premier Edge briefing, ${date}`;

  // Priority order from the design doc; empty lines are skipped, not zero-filled.
  const lines: string[] = [];

  for (const closing of data.closings) {
    lines.push(
      closing.daysOut === null
        ? `⏰ ${closing.address} — at title, no date set`
        : `⏰ ${closing.address} closes in ${closing.daysOut}d`,
    );
  }
  if (data.contractsAwaitingSignature > 0) {
    lines.push(`✍️ ${data.contractsAwaitingSignature} contract${plural(data.contractsAwaitingSignature)} awaiting signature`);
  }
  if (data.escalationsPending > 0) {
    lines.push(`🚨 ${data.escalationsPending} escalation${plural(data.escalationsPending)} pending`);
  }
  if (data.approvalsWaiting > 0) {
    lines.push(`✅ ${data.approvalsWaiting} approval${plural(data.approvalsWaiting)} waiting`);
  }
  if (data.newRepliesSinceYesterday > 0) {
    lines.push(`💬 ${data.newRepliesSinceYesterday} new repl${data.newRepliesSinceYesterday === 1 ? "y" : "ies"}`);
  }
  if (data.optOutsYesterday > 0) {
    lines.push(`🚫 ${data.optOutsYesterday} opt-out${plural(data.optOutsYesterday)}`);
  }

  if (lines.length === 0) return `${header}\n\nNothing needs you today.`;

  // Drop from the bottom (lowest priority) until it fits three segments.
  let body = lines;
  while (body.length > 1 && `${header}\n\n${body.join("\n")}`.length > MAX_CHARS) {
    body = body.slice(0, -1);
  }
  const dropped = lines.length - body.length;
  const suffix = dropped > 0 ? `\n+${dropped} more in the app` : "";

  return `${header}\n\n${body.join("\n")}${suffix}`.slice(0, MAX_CHARS);
}

const plural = (n: number) => (n === 1 ? "" : "s");
