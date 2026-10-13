import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { formatIssues, getServerEnv, type ServerEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// Scan configuration (Stage 3.1.1: fail safe)
// ---------------------------------------------------------------------------

export type ScanConfig =
  | {
      enabled: true;
      cronSecret: string;
      workerDatabaseUrl: string;
      workerDatabaseCa?: string;
    }
  | {
      enabled: false;
      /** "off" when FEATURE_SCAN is not "on"; "misconfigured" when it is "on" but a setting is wrong. */
      reason: "off" | "misconfigured";
      /** Variable names and problems only, never values. */
      problems: string[];
    };

const scanSchema = z.object({
  FEATURE_SCAN: z.enum(["on", "off"], { error: "must be 'on' or 'off'" }).default("off"),
  CRON_SECRET: z.string().min(32, "must be at least 32 random characters").optional(),
  WORKER_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/c360_worker[.:]/, "must be a postgres:// URL for the c360_worker login")
    .refine((v) => !/\s/.test(v), "must be on one line with no spaces")
    .refine((v) => {
      try {
        return new URL(v).hostname.length > 0;
      } catch {
        return false;
      }
    }, "is not a valid connection URL")
    .optional(),
  WORKER_DATABASE_CA: z
    .string()
    .refine(isPemCertificate, "must be a valid PEM certificate (-----BEGIN CERTIFICATE----- ...)")
    .optional(),
});

/** True when the text parses as an X.509 certificate. Never echoes the text. */
export function isPemCertificate(v: string): boolean {
  if (!v.includes("BEGIN CERTIFICATE")) return false;
  try {
    new X509Certificate(v.replace(/\\n/g, "\n"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the scan settings separately from the rest of the app. Any problem
 * turns scanning OFF (reason "misconfigured") instead of throwing, so sign-in,
 * the dashboard, customers and search keep working.
 */
export function parseScanConfig(env: ServerEnv): ScanConfig {
  const parsed = scanSchema.safeParse({
    FEATURE_SCAN: env.FEATURE_SCAN,
    CRON_SECRET: env.CRON_SECRET,
    WORKER_DATABASE_URL: env.WORKER_DATABASE_URL,
    WORKER_DATABASE_CA: env.WORKER_DATABASE_CA,
  });
  if (!parsed.success) {
    const problems = formatIssues(parsed.error);
    const wantsOn = env.FEATURE_SCAN !== undefined && env.FEATURE_SCAN !== "off";
    return { enabled: false, reason: wantsOn ? "misconfigured" : "off", problems: wantsOn ? problems : [] };
  }
  const s = parsed.data;
  if (s.FEATURE_SCAN !== "on") return { enabled: false, reason: "off", problems: [] };
  const problems: string[] = [];
  if (env.FEATURE_GMAIL !== "on") problems.push("FEATURE_SCAN: needs FEATURE_GMAIL=on");
  if (!s.CRON_SECRET) problems.push("CRON_SECRET: required when FEATURE_SCAN=on");
  if (!s.WORKER_DATABASE_URL) problems.push("WORKER_DATABASE_URL: required when FEATURE_SCAN=on");
  if (problems.length > 0 || !s.CRON_SECRET || !s.WORKER_DATABASE_URL) {
    return { enabled: false, reason: "misconfigured", problems };
  }
  return {
    enabled: true,
    cronSecret: s.CRON_SECRET,
    workerDatabaseUrl: s.WORKER_DATABASE_URL,
    workerDatabaseCa: s.WORKER_DATABASE_CA?.replace(/\\n/g, "\n"),
  };
}

let cachedScanConfig: ScanConfig | undefined;

/** Server-only. Never throws for scan problems; returns enabled:false instead. */
export function getScanConfig(): ScanConfig {
  cachedScanConfig ??= parseScanConfig(getServerEnv());
  return cachedScanConfig;
}

