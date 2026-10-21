import { z } from "zod";
import { formatIssues, getServerEnv, type ServerEnv } from "@/lib/env";
import { parseScanConfig } from "@/lib/scan/config";

/**
 * Gmail sync (push + safety net) configuration. Fail-safe like the other
 * background features: any problem turns sync OFF (problems are reported by
 * variable name only) and never stops the site. Needs FEATURE_SYNC=on, a valid
 * scan configuration (Gmail, worker login, cron secret), the Pub/Sub topic
 * Gmail publishes to, and the service account Pub/Sub signs pushes with.
 */
export type SyncConfig =
  | {
      enabled: true;
      topic: string;
      pushServiceAccount: string;
      pushAudience: string;
      cronSecret: string;
      workerDatabaseUrl: string;
      workerDatabaseCa?: string;
    }
  | { enabled: false; reason: "off" | "misconfigured"; problems: string[] };

const schema = z.object({
  GMAIL_PUSH_TOPIC: z
    .string()
    .regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/, "must look like projects/<project-id>/topics/<topic>")
    .optional(),
  GMAIL_PUSH_SERVICE_ACCOUNT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/, "must be a service account email (…@<project>.iam.gserviceaccount.com)")
    .optional(),
});

export function parseSyncConfig(env: ServerEnv): SyncConfig {
  if (env.FEATURE_SYNC === undefined || env.FEATURE_SYNC === "off") return { enabled: false, reason: "off", problems: [] };
  if (env.FEATURE_SYNC !== "on") return { enabled: false, reason: "misconfigured", problems: ["FEATURE_SYNC: must be 'on' or 'off'"] };
  const parsed = schema.safeParse({ GMAIL_PUSH_TOPIC: env.GMAIL_PUSH_TOPIC, GMAIL_PUSH_SERVICE_ACCOUNT: env.GMAIL_PUSH_SERVICE_ACCOUNT });
  if (!parsed.success) return { enabled: false, reason: "misconfigured", problems: formatIssues(parsed.error) };
  const problems: string[] = [];
  if (!parsed.data.GMAIL_PUSH_TOPIC) problems.push("GMAIL_PUSH_TOPIC: required when FEATURE_SYNC=on");
  if (!parsed.data.GMAIL_PUSH_SERVICE_ACCOUNT) problems.push("GMAIL_PUSH_SERVICE_ACCOUNT: required when FEATURE_SYNC=on");
  const scan = parseScanConfig(env);
  if (!scan.enabled) problems.push("FEATURE_SYNC: needs a valid scan configuration (FEATURE_SCAN=on and its settings)");
  const { GMAIL_PUSH_TOPIC: topic, GMAIL_PUSH_SERVICE_ACCOUNT: sa } = parsed.data;
  if (problems.length > 0 || !scan.enabled || !topic || !sa) return { enabled: false, reason: "misconfigured", problems };
  return {
    enabled: true,
    topic,
    pushServiceAccount: sa,
    pushAudience: `${env.APP_BASE_URL}/api/gmail/push`,
    cronSecret: scan.cronSecret,
    workerDatabaseUrl: scan.workerDatabaseUrl,
    workerDatabaseCa: scan.workerDatabaseCa,
  };
}

let cached: SyncConfig | undefined;
export function getSyncConfig(): SyncConfig {
  cached ??= parseSyncConfig(getServerEnv());
  return cached;
}
