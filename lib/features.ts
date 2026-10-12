/**
 * Feature flags. In Phase 1 both integrations are hard-disabled: the env
 * schema only accepts "off", and these helpers return false regardless.
 * Later phases will read the validated env instead.
 */
export const PHASE = 1 as const;

export function isGmailEnabled(): false {
  return false;
}

export function isSlackEnabled(): false {
  return false;
}

export function featureSummary() {
  return { gmail: "off", slack: "off" } as const;
}
