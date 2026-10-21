/**
 * Feature flags.
 *
 * - Gmail: controlled by FEATURE_GMAIL (validated env). When "on", the env
 *   schema also guarantees the OAuth client and encryption key are present.
 * - Slack DM assistant: on only when FEATURE_SLACK=on AND every Slack setting
 *   is valid (lib/slack/config.ts). Off by default.
 */
import { getServerEnv } from "@/lib/env";
import { getSlackConfig } from "@/lib/slack/config";

export const PHASE = "4" as const;
export const PHASE_LABEL = "Customer facts and Slack DM assistant (Slack off until approved)";

export function isGmailEnabled(): boolean {
  return getServerEnv().FEATURE_GMAIL === "on";
}

export function isSlackEnabled(): boolean {
  return getSlackConfig().enabled;
}

export function featureSummary() {
  return { gmail: isGmailEnabled() ? "on" : "off", slack: isSlackEnabled() ? "on" : "off" } as const;
}
