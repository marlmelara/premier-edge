import { describe, expect, it } from "vitest";
import { evaluateFloodZones, evaluateSqft, evaluateWetlands, overallVerdict } from "./rules";

describe("evaluateFloodZones", () => {
  it("passes when every intersecting zone is allowed", () => {
    const outcome = evaluateFloodZones(
      [{ zone: "X" }, { zone: "X", subtype: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD" }],
      ["X"],
    );
    expect(outcome.result).toBe("pass");
    expect(outcome.summary).toBe("X");
  });

  it("fails when any zone is disallowed, naming the offender", () => {
    const outcome = evaluateFloodZones([{ zone: "X" }, { zone: "AE" }], ["X"]);
    expect(outcome.result).toBe("fail");
    expect(outcome.summary).toBe("AE");
  });

  it("errors on empty NFHL coverage instead of passing silently", () => {
    expect(evaluateFloodZones([], ["X"]).result).toBe("error");
  });
});

describe("evaluateWetlands", () => {
  it("passes when clear", () => {
    expect(evaluateWetlands([], false)).toMatchObject({ result: "pass", summary: "clear" });
  });

  it("fails on intersection when wetlands are not allowed", () => {
    const outcome = evaluateWetlands([{ attribute: "PFO2/EM5C", wetlandType: "Freshwater Forested/Shrub Wetland" }], false);
    expect(outcome.result).toBe("fail");
    expect(outcome.summary).toBe("intersects");
  });

  it("passes on intersection when criteria allow wetlands", () => {
    expect(evaluateWetlands([{ attribute: "PEM1C" }], true).result).toBe("pass");
  });
});

describe("evaluateSqft", () => {
  it("passes at or above the minimum", () => {
    expect(evaluateSqft(12400, 10000).result).toBe("pass");
    expect(evaluateSqft(10000, 10000).result).toBe("pass");
  });

  it("fails below the minimum and errors on unknown", () => {
    expect(evaluateSqft(9999, 10000).result).toBe("fail");
    expect(evaluateSqft(undefined, 10000).result).toBe("error");
  });
});

describe("overallVerdict", () => {
  const pass = { result: "pass" as const, summary: "", detail: {} };
  const fail = { result: "fail" as const, summary: "", detail: {} };
  const error = { result: "error" as const, summary: "", detail: {} };

  it("fail beats error beats pass", () => {
    expect(overallVerdict([pass, pass])).toBe("pass");
    expect(overallVerdict([pass, error])).toBe("pending");
    expect(overallVerdict([pass, error, fail])).toBe("fail");
  });
});
