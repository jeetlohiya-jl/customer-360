/**
 * The Anthropic call that writes a Slack answer from stored facts.
 * Same rules as extraction: Messages API only, fixed instructions cached,
 * errors carry a code and status only (never a response body).
 */
import { ModelError, PRICES, type Usage } from "@/lib/extract/model";
import { MODEL_ID } from "@/lib/extract/prompt";
import { ANSWER_MAX_TOKENS, ANSWER_SYSTEM_PROMPT } from "./answer";

type Fetch = typeof fetch;

export interface AnswerModel {
  answer(prompt: string): Promise<{ text: string; usage: Usage }>;
}

/** Worst case for one answer: every character a token, all input at the cache-write price, full output. */
export function answerReservationMicroUsd(promptChars: number): number {
  return Math.ceil((ANSWER_SYSTEM_PROMPT.length + promptChars) * PRICES.cacheWrite5m + ANSWER_MAX_TOKENS * PRICES.output);
}

export function anthropicAnswerModel(apiKey: string, fetchImpl: Fetch = fetch): AnswerModel {
  return {
    async answer(prompt) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL_ID,
            max_tokens: ANSWER_MAX_TOKENS,
            system: [{ type: "text", text: ANSWER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new ModelError("network_error", undefined, undefined, true);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { type?: unknown } };
        const type = typeof body.error?.type === "string" && /^[a-z_]{1,40}$/.test(body.error.type) ? body.error.type : undefined;
        throw new ModelError("http_error", res.status, type, false);
      }
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: Partial<Usage> };
      const usage: Usage = {
        input_tokens: body.usage?.input_tokens ?? 0,
        output_tokens: body.usage?.output_tokens ?? 0,
        cache_read_input_tokens: body.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: body.usage?.cache_creation_input_tokens ?? 0,
      };
      const text = (body.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim();
      if (!text) throw Object.assign(new ModelError("no_tool_output", res.status), { usage });
      return { text, usage };
    },
  };
}
