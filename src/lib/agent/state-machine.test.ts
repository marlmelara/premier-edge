import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, nextState, type ConversationState } from "./state-machine";

describe("nextState", () => {
  it("routes opt-out and unrecognized messages to terminals regardless of state", () => {
    const states: ConversationState[] = ["NEW", "QUALIFYING", "OFFER_SENT", "NEGOTIATING"];
    for (const state of states) {
      expect(nextState(state, "opt_out")).toBe("OPTED_OUT");
      expect(nextState(state, "off_script")).toBe("ESCALATED");
      expect(nextState(state, "wrong_person")).toBe("ESCALATED");
      expect(nextState(state, "not_interested")).toBe("DEAD");
    }
  });

  it("moves a fresh lead into qualifying on interest", () => {
    expect(nextState("NEW", "interested")).toBe("QUALIFYING");
    expect(nextState("NEW", "question_about_process")).toBe("QUALIFYING");
  });

  it("treats a counter as negotiating and an acceptance as accepted", () => {
    expect(nextState("OFFER_SENT", "counter_offer")).toBe("NEGOTIATING");
    expect(nextState("OFFER_SENT", "accepted")).toBe("ACCEPTED");
  });

  it("does not walk a priced conversation backwards when the seller re-asks price", () => {
    expect(nextState("NEGOTIATING", "asking_price")).toBe("NEGOTIATING");
    expect(nextState("OFFER_SENT", "asking_price")).toBe("OFFER_SENT");
    expect(nextState("NEW", "asking_price")).toBe("QUALIFYING");
  });
});

describe("canTransition", () => {
  it("allows the happy path forward", () => {
    expect(canTransition("NEW", "QUALIFYING")).toBe(true);
    expect(canTransition("ACCEPTED", "CONTRACT_SENT")).toBe(true);
    expect(canTransition("CONTRACT_SENT", "TITLE_ROUTED")).toBe(true);
  });

  it("refuses to skip the contract step or reverse a closed deal", () => {
    expect(canTransition("ACCEPTED", "TITLE_ROUTED")).toBe(false);
    expect(canTransition("TITLE_ROUTED", "NEGOTIATING")).toBe(false);
    expect(canTransition("DEAD", "QUALIFYING")).toBe(false);
  });

  it("lets Marlon hand an escalated thread back, but never revives an opt-out", () => {
    expect(canTransition("ESCALATED", "NEGOTIATING")).toBe(true);
    expect(canTransition("OPTED_OUT", "QUALIFYING")).toBe(false);
  });

  it("marks the three terminals", () => {
    expect(isTerminal("ESCALATED")).toBe(true);
    expect(isTerminal("DEAD")).toBe(true);
    expect(isTerminal("OPTED_OUT")).toBe(true);
    expect(isTerminal("NEGOTIATING")).toBe(false);
  });
});
