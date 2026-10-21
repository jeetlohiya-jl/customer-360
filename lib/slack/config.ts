import { z } from "zod";
import { formatIssues, getServerEnv, type ServerEnv } from "@/lib/env";
import { parseScanConfig } from "@/lib/scan/config";

/**
 * Slack DM assistant configuration. Fail-safe like scanning and extraction:
 * any problem turns Slack OFF (problems are reported by variable name only)
 * and never stops the site. Needs FEATURE_SLACK=on, the Slack app's signing
 * secret and bot token, an Anthropic API key and the worker database login
 * (from the scan settings).
 */
export type SlackConfig =
  | { enabled: true; signingSecret: string; botToken: string; anthropicApiKey: string; workerDatabaseUrl: string; workerDatabaseCa?: string }
  | { enabled: false; reason: "off" | "misconfigured"; problems: string[] };

const schema = z.object({
  SLACK_SIGNING_SECRET: z.string().regex(/^[a-f0-9]{32}$/, "must be the Slack app's signing secret (32 hex characters)").optional(),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-[A-Za-z0-9-]{20,}$/, "must be a Slack bot token (xoxb-...)").optional(),
  ANTHROPIC_API_KEY: z.string().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "must be an Anthropic API key (sk-ant-...)").optional(),
});

export function parseSlackConfig(env: ServerEnv): SlackConfig {
  if (env.FEATURE_SLACK !== "on") return { enabled: false, reason: "off", problems: [] };
  const parsed = schema.safeParse({
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  });
  if (!parsed.success) return { enabled: false, reason: "misconfigured", problems: formatIssues(parsed.error) };
  const problems: string[] = [];
  for (const k of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY"] as const) {
    if (!parsed.data[k]) problems.push(`${k}: required when FEATURE_SLACK=on`);
  }
  const scan = parseScanConfig(env);
  if (!scan.enabled) problems.push("FEATURE_SLACK: needs the worker database settings (FEATURE_SCAN=on, WORKER_DATABASE_URL)");
  const { SLACK_SIGNING_SECRET: s, SLACK_BOT_TOKEN: t, ANTHROPIC_API_KEY: a } = parsed.data;
  if (problems.length > 0 || !scan.enabled || !s || !t || !a) return { enabled: false, reason: "misconfigured", problems };
  return { enabled: true, signingSecret: s, botToken: t, anthropicApiKey: a, workerDatabaseUrl: scan.workerDatabaseUrl, workerDatabaseCa: scan.workerDatabaseCa };
}

let cached: SlackConfig | undefined;
export function getSlackConfig(): SlackConfig {
  cached ??= parseSlackConfig(getServerEnv());
  return cached;
}
