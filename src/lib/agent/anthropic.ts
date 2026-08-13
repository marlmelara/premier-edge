import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/env";

/**
 * Anthropic client + a JSON-shaped call helper. The LLM is language-only
 * (design doc §6): it classifies text and drafts wording. It never sees or
 * computes a dollar figure that code didn't hand it.
 */

export const AGENT_MODEL = "claude-opus-5";

let client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  const key = env().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  client ??= new Anthropic({ apiKey: key });
  return client;
}

export function hasAnthropicKey(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

export class AgentRefusal extends Error {
  constructor(readonly category?: string) {
    super(`model refused${category ? ` (${category})` : ""}`);
    this.name = "AgentRefusal";
  }
}

type JsonCallOptions<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
};

/**
 * One structured-output call. Server-side fallbacks are on so a safety-classifier
 * refusal is retried on another model rather than dropping the thread; a refusal
 * that survives the chain throws AgentRefusal, which the caller escalates.
 */
export async function jsonCall<T>({
  system,
  user,
  schema,
  jsonSchema,
  effort = "low",
  maxTokens = 4000,
}: JsonCallOptions<T>): Promise<T> {
  const response = await getAnthropic().beta.messages.create({
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    output_config: {
      effort,
      format: { type: "json_schema", schema: jsonSchema },
    },
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new AgentRefusal(response.stop_details?.category ?? undefined);
  }

  const text = response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`model returned non-JSON: ${text.slice(0, 200)}`);
  }
  return schema.parse(parsed);
}
