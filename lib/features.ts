/**
 * Feature flags.
 *
 * - Gmail: controlled by FEATURE_GMAIL (validated env). When "on", the env
 *   schema also guarantees the OAuth client and encryption key are present.
 * - Slack: not built; always off.
 */
import { getServerEnv } from "@/lib/env";

export const PHASE = "3.2" as const;
export const PHASE_LABEL = "Customer email search (header data only, no email content)";

export function isGmailEnabled(): boolean {
  return getServerEnv().FEATURE_GMAIL === "on";
}

export function isSlackEnabled(): false {
  return false;
}

export function featureSummary() {
  return { gmail: isGmailEnabled() ? "on" : "off", slack: "off" } as const;
}
