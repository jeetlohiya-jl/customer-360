import { z } from "zod";

/**
 * Environment validation.
 *
 * - Server variables are validated once at boot (see instrumentation.ts).
 *   A missing or malformed value stops the server from starting.
 * - Public (NEXT_PUBLIC_*) variables are inlined into the browser bundle by
 *   Next.js, so they must never hold secrets. Only the allowlisted names in
 *   PUBLIC_ENV_ALLOWLIST may exist.
 * - Phase 1: Gmail and Slack must be "off". The schema rejects anything else.
 */

export const PUBLIC_ENV_ALLOWLIST = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const domainRegex = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, "looks too short to be a Supabase publishable/anon key"),
});

export const serverEnvSchema = publicEnvSchema.extend({
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  WORKSPACE_DOMAIN: z
    .string()
    .transform((d) => d.trim().toLowerCase())
    .refine((d) => domainRegex.test(d), "must be a bare domain such as gocirkla.com"),
  // Phase 1 hard stop: integrations cannot be enabled by configuration.
  FEATURE_GMAIL: z.literal("off", { error: "Phase 1: FEATURE_GMAIL must be 'off'" }),
  FEATURE_SLACK: z.literal("off", { error: "Phase 1: FEATURE_SLACK must be 'off'" }),
  // Not used by Phase 1 code paths. Validated only if present so that a
  // malformed value is caught early. Never exposed to the browser.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string")
    .optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n` +
        "See .env.example for every required variable.",
    );
    this.name = "EnvValidationError";
  }
}

function formatIssues(error: z.ZodError): string[] {
  // Report variable names and the problem only, never the offending value.
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/**
 * Treat blank values as "not set". Next.js loads `NAME=` from .env files as an
 * empty string, which must behave the same as an absent optional variable.
 */
function withoutBlanks(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) out[k] = typeof v === "string" && v.trim() === "" ? undefined : v;
  return out;
}

/** Pure function: validates any env-like record. Used by tests and at boot. */
export function parseServerEnv(rawSource: Record<string, string | undefined>): ServerEnv {
  const source = withoutBlanks(rawSource);
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(formatIssues(result.error));

  const unexpectedPublic = Object.keys(source).filter(
    (k) => k.startsWith("NEXT_PUBLIC_") && !(PUBLIC_ENV_ALLOWLIST as readonly string[]).includes(k),
  );
  if (unexpectedPublic.length > 0) {
    throw new EnvValidationError(
      unexpectedPublic.map((k) => `${k}: not in the public allowlist; NEXT_PUBLIC_ variables are shipped to browsers`),
    );
  }
  return result.data;
}

let cachedServerEnv: ServerEnv | undefined;

/** Server-only accessor. Throws EnvValidationError on bad configuration. */
export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() must never run in the browser");
  }
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}

/**
 * Public values. Next.js inlines NEXT_PUBLIC_* only when referenced literally,
 * so each variable is spelled out here.
 */
export function getPublicEnv(): PublicEnv {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!result.success) throw new EnvValidationError(formatIssues(result.error));
  return result.data;
}
