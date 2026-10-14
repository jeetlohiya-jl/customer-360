import { z } from "zod";
import { formatIssues, getServerEnv, type ServerEnv } from "@/lib/env";
import { parseScanConfig } from "@/lib/scan/config";

/**
 * Stage B + C configuration. Fail-safe like the scan settings: any problem
 * turns extraction OFF (and is logged by variable name only); it never stops
 * the site. Extraction needs a valid scan configuration (worker login, cron
 * secret), Gmail on, FEATURE_EXTRACT=on and an Anthropic API key.
 *
 * Even when this is enabled, nothing is processed until a mailbox is on the
 * database's extraction allowlist AND its owner has granted gmail.readonly.
 */
export type ExtractConfig =
  | { enabled: true; anthropicApiKey: string; cronSecret: string; workerDatabaseUrl: string; workerDatabaseCa?: string }
  | { enabled: false; reason: "off" | "misconfigured"; problems: string[] };

const schema = z.object({
  FEATURE_EXTRACT: z.enum(["on", "off"], { error: "must be 'on' or 'off'" }).default("off"),
  ANTHROPIC_API_KEY: z.string().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "must be an Anthropic API key (sk-ant-...)").optional(),
});

export function parseExtractConfig(env: ServerEnv): ExtractConfig {
  const parsed = schema.safeParse({ FEATURE_EXTRACT: env.FEATURE_EXTRACT, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY });
  const wantsOn = env.FEATURE_EXTRACT !== undefined && env.FEATURE_EXTRACT !== "off";
  if (!parsed.success) return { enabled: false, reason: wantsOn ? "misconfigured" : "off", problems: wantsOn ? formatIssues(parsed.error) : [] };
  if (parsed.data.FEATURE_EXTRACT !== "on") return { enabled: false, reason: "off", problems: [] };

  const problems: string[] = [];
  if (!parsed.data.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY: required when FEATURE_EXTRACT=on");
  const scan = parseScanConfig(env);
  if (!scan.enabled) problems.push("FEATURE_EXTRACT: needs a valid scan configuration (FEATURE_SCAN=on, CRON_SECRET, WORKER_DATABASE_URL)");
  if (problems.length > 0 || !scan.enabled || !parsed.data.ANTHROPIC_API_KEY) return { enabled: false, reason: "misconfigured", problems };
  return {
    enabled: true,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    cronSecret: scan.cronSecret,
    workerDatabaseUrl: scan.workerDatabaseUrl,
    workerDatabaseCa: scan.workerDatabaseCa,
  };
}

let cached: ExtractConfig | undefined;
export function getExtractConfig(): ExtractConfig {
  cached ??= parseExtractConfig(getServerEnv());
  return cached;
}
