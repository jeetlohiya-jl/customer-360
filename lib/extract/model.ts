/**
 * Stage C: the Anthropic Messages API call and its cost accounting.
 *
 * - Synchronous Messages API only (not Batches, not Files): see the design doc
 *   for the data-retention reasons.
 * - The fixed instructions are marked for prompt caching.
 * - Errors carry a short code and HTTP status only, never a response body
 *   (an error body could echo request content).
 * - Never called unless FEATURE_EXTRACT is on and an API key is configured.
 */
import { MAX_OUTPUT_TOKENS, MODEL_ID, OUTPUT_SCHEMA, SYSTEM_PROMPT } from "./prompt";

type Fetch = typeof fetch;

// Claude Haiku 5.5 list prices for prompts up to 100,000 tokens, USD per million tokens
// (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-13).
export const PRICES = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125 } as const;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Cost in micro-USD (1 USD = 1,000,000). */
export function costMicroUsd(u: Usage): number {
  return Math.ceil(
    u.input_tokens * PRICES.input +
      u.output_tokens * PRICES.output +
      u.cache_read_input_tokens * PRICES.cacheRead +
      u.cache_creation_input_tokens * PRICES.cacheWrite5m,
  );
}

/**
 * Worst-case cost of one call, reserved before it is made. Counts every
 * character as a token (a large over-estimate), all input as a cache write
 * (the most expensive input price) and the full output allowance.
 */
export function reservationMicroUsd(promptChars: number): number {
  const inputTokens = SYSTEM_PROMPT.length + JSON.stringify(OUTPUT_SCHEMA).length + promptChars;
  return Math.ceil(inputTokens * PRICES.cacheWrite5m + MAX_OUTPUT_TOKENS * PRICES.output);
}

export class ModelError extends Error {
  constructor(
    public readonly code: "http_error" | "network_error" | "no_tool_output",
    public readonly httpStatus?: number,
    /** Anthropic's machine-readable error type, e.g. rate_limit_error. Never a message. */
    public readonly type?: string,
    /** True when the request may have been processed and billed (cost unknown). */
    public readonly maybeBilled = false,
  ) {
    super(code);
    this.name = "ModelError";
  }
}

export interface ModelResult {
  output: unknown;
  usage: Usage;
}

export interface ExtractModel {
  extract(userMessage: string): Promise<ModelResult>;
}

export function anthropicModel(apiKey: string, fetchImpl: Fetch = fetch): ExtractModel {
  return {
    async extract(userMessage) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL_ID,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools: [{ name: "record_facts", description: "Record the business facts found in the email.", input_schema: OUTPUT_SCHEMA }],
            tool_choice: { type: "tool", name: "record_facts" },
            messages: [{ role: "user", content: userMessage }],
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new ModelError("network_error", undefined, undefined, true);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { type?: unknown } };
        const type = typeof body.error?.type === "string" && /^[a-z_]{1,40}$/.test(body.error.type) ? body.error.type : undefined;
        throw new ModelError("http_error", res.status, type, false);
      }
      const body = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[]; usage?: Partial<Usage> };
      const usage: Usage = {
        input_tokens: body.usage?.input_tokens ?? 0,
        output_tokens: body.usage?.output_tokens ?? 0,
        cache_read_input_tokens: body.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: body.usage?.cache_creation_input_tokens ?? 0,
      };
      const tool = body.content?.find((c) => c.type === "tool_use" && c.name === "record_facts");
      if (!tool) throw Object.assign(new ModelError("no_tool_output", res.status), { usage });
      return { output: tool.input, usage };
    },
  };
}
