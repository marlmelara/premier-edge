/**
 * Conversation state machine (design doc §6). Code owns transitions — the LLM
 * only classifies and drafts language, it never moves state on its own.
 */

export const CONVERSATION_STATES = [
  "NEW",
  "QUALIFYING",
  "VERIFYING",
  "OFFER_SENT",
  "NEGOTIATING",
  "ACCEPTED",
  "CONTRACT_SENT",
  "TITLE_ROUTED",
  // terminals
  "ESCALATED",
  "DEAD",
  "OPTED_OUT",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const TERMINAL_STATES: ConversationState[] = ["ESCALATED", "DEAD", "OPTED_OUT"];

/** Terminals are reachable from anywhere; the happy path only moves forward. */
const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  NEW: ["QUALIFYING", "VERIFYING"],
  QUALIFYING: ["VERIFYING", "OFFER_SENT"],
  VERIFYING: ["OFFER_SENT", "QUALIFYING"],
  OFFER_SENT: ["NEGOTIATING", "ACCEPTED"],
  NEGOTIATING: ["OFFER_SENT", "ACCEPTED"],
  ACCEPTED: ["CONTRACT_SENT"],
  CONTRACT_SENT: ["TITLE_ROUTED"],
  TITLE_ROUTED: [],
  ESCALATED: ["QUALIFYING", "NEGOTIATING", "OFFER_SENT"], // Marlon can hand a thread back
  DEAD: [],
  OPTED_OUT: [],
};

export function isConversationState(value: string): value is ConversationState {
  return (CONVERSATION_STATES as readonly string[]).includes(value);
}

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  if (from === to) return true;
  if (TERMINAL_STATES.includes(to)) return from !== "OPTED_OUT" || to === "OPTED_OUT";
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ConversationState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The message classes the agent recognizes. Everything the agent can't place
 * confidently becomes OFF_SCRIPT, which escalates.
 */
export const INBOUND_CLASSES = [
  "interested",
  "not_interested",
  "asking_price",
  "counter_offer",
  "accepted",
  "wrong_person",
  "question_about_process",
  "hostile",
  "opt_out",
  "off_script",
] as const;

export type InboundClass = (typeof INBOUND_CLASSES)[number];

/**
 * Classes that stop the machine and reach Marlon (policy revised Aug 15 2026).
 *
 * Escalation is expensive: it costs attention, and an escalation that fires on
 * something with an obvious answer trains you to ignore the ones that matter.
 * Only `off_script` survives here — by definition it is a message we could not
 * place, which is exactly when a human should look.
 *
 * The two that were removed have clear, automatic answers:
 * - `wrong_person`: they don't own it. Unlink the lot from that contact so we
 *   never text them about it again, mark the deal dead, done.
 * - `hostile`: someone swearing at a cold text is not interested. Mark them
 *   dead and stop. Nothing a human does here changes the outcome, and dwelling
 *   on it is how you end up replying to an angry stranger.
 */
export const ESCALATING_CLASSES: InboundClass[] = ["off_script"];

/**
 * Classes that end the conversation on their own. Terminal, but routine — the
 * difference between "this is over" and "someone needs to look at this".
 */
export const SELF_RESOLVING_CLASSES: InboundClass[] = ["wrong_person", "hostile"];

/** Where a classified inbound moves the conversation, given where it is now. */
export function nextState(current: ConversationState, klass: InboundClass): ConversationState {
  if (klass === "opt_out") return "OPTED_OUT";
  if (ESCALATING_CLASSES.includes(klass)) return "ESCALATED";
  // Wrong number and hostility both end the thread without anyone's attention.
  if (SELF_RESOLVING_CLASSES.includes(klass)) return "DEAD";
  if (klass === "not_interested") return "DEAD";
  if (klass === "accepted") return "ACCEPTED";

  switch (klass) {
    case "interested":
    case "question_about_process":
      return current === "NEW" ? "QUALIFYING" : current;
    case "asking_price":
      return current === "OFFER_SENT" || current === "NEGOTIATING" ? current : "QUALIFYING";
    case "counter_offer":
      return "NEGOTIATING";
    default:
      return current;
  }
}
