/**
 * Campaign gating (design doc §10): a campaign can only go ready→live when
 * criteria, builder, title routing, Sendivo health, and agent config are all
 * present. The UI cannot launch an incomplete campaign — this function is what
 * makes that true.
 */

export type GateInput = {
  hasCriteria: boolean;
  hasBuilder: boolean;
  hasTitleRouting: boolean;
  /** Sendivo reachable and the campaign has a live sending number. */
  sendivoHealthy: boolean;
  hasSendingNumber: boolean;
  /** Agent can classify/draft — the key is configured. */
  agentConfigured: boolean;
};

export type GateCheck = { key: keyof GateInput; label: string; passed: boolean; fix: string };

const CHECKS: { key: keyof GateInput; label: string; fix: string }[] = [
  { key: "hasCriteria", label: "Criteria set", fix: "Attach a criteria set (min sqft, flood zones, builder price, fee floor)." },
  { key: "hasBuilder", label: "Matched builder", fix: "Attach the builder who buys in this market." },
  { key: "hasTitleRouting", label: "Title routing", fix: "Set a title company on the builder, the campaign, or the FL default." },
  { key: "sendivoHealthy", label: "Sendivo reachable", fix: "Check the Sendivo API key and account status." },
  { key: "hasSendingNumber", label: "Sending number", fix: "Assign an active 10DLC number to this campaign." },
  { key: "agentConfigured", label: "Agent configured", fix: "Set ANTHROPIC_API_KEY so the agent can classify and draft." },
];

export type GateResult = { canGoLive: boolean; checks: GateCheck[]; blockers: GateCheck[] };

export function evaluateCampaignGate(input: GateInput): GateResult {
  const checks = CHECKS.map((c) => ({ ...c, passed: input[c.key] }));
  const blockers = checks.filter((c) => !c.passed);
  return { canGoLive: blockers.length === 0, checks, blockers };
}
