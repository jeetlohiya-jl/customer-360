/**
 * Runs once when a server instance starts. Validates configuration so a
 * missing or malformed variable stops the server instead of failing later.
 *
 * Exception (Stage 3.1.1): scan settings never stop the server. A bad scan
 * setting switches scanning off and is reported here by variable name only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("@/lib/env");
  getServerEnv(); // throws EnvValidationError with variable names (never values)
  const { getScanConfig } = await import("@/lib/scan/config");
  const scan = getScanConfig();
  if (!scan.enabled && scan.reason === "misconfigured") {
    console.warn(JSON.stringify({ event: "scan_config_invalid", problems: scan.problems }));
  }
}
