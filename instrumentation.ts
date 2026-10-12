/**
 * Runs once when a server instance starts. Validates configuration so a
 * missing or malformed variable stops the server instead of failing later.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("@/lib/env");
  getServerEnv(); // throws EnvValidationError with variable names (never values)
}
