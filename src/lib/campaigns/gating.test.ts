import { describe, expect, it } from "vitest";
import { evaluateCampaignGate, type GateInput } from "./gating";

const complete: GateInput = {
  hasCriteria: true,
  hasBuilder: true,
  hasTitleRouting: true,
  sendivoHealthy: true,
  hasSendingNumber: true,
  agentConfigured: true,
};

describe("evaluateCampaignGate", () => {
  it("allows go-live only when every requirement is met", () => {
    const result = evaluateCampaignGate(complete);
    expect(result.canGoLive).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("blocks on any single missing requirement and names the fix", () => {
    for (const key of Object.keys(complete) as (keyof GateInput)[]) {
      const result = evaluateCampaignGate({ ...complete, [key]: false });
      expect(result.canGoLive).toBe(false);
      expect(result.blockers.map((b) => b.key)).toEqual([key]);
      expect(result.blockers[0].fix.length).toBeGreaterThan(0);
    }
  });

  it("reports every blocker at once on a fresh campaign", () => {
    const result = evaluateCampaignGate({
      hasCriteria: false,
      hasBuilder: false,
      hasTitleRouting: false,
      sendivoHealthy: false,
      hasSendingNumber: false,
      agentConfigured: false,
    });
    expect(result.canGoLive).toBe(false);
    expect(result.blockers).toHaveLength(6);
  });
});
