import { z } from "zod";

/**
 * Environment validation.
 *
 * - Server variables are validated once at boot (see instrumentation.ts).
 *   A missing or malformed value stops the server from starting.
 * - Public (NEXT_PUBLIC_*) variables are inlined into the browser bundle by
 *   Next.js, so they must never hold secrets. Only the allowlisted names in
 *   PUBLIC_ENV_ALLOWLIST may exist.
 * - Gmail (Phase 2 proof of concept) may be "on" only together with its OAuth
 *   client and token-encryption key. Slack must still be "off".
 */

export const PUBLIC_ENV_ALLOWLIST = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  // Added automatically by the Vercel-Supabase integration. Public by design,
  // tolerated but not referenced by app code (so never inlined). Checked below
  // to make sure it is not a secret key placed under a public name.
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;

/** True only for values that are safe to publish: sb_publishable_ keys or legacy anon JWTs. */
export function isPublishableKey(v: string): boolean {
  if (v.startsWith("sb_publishable_")) return true;
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "anon";
  } catch {
    return false;
  }
}

const domainRegex = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, "looks too short to be a Supabase publishable/anon key"),
});

const base64Key32 = z
  .string()
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be 32 random bytes, base64-encoded (see README)");

export const serverEnvSchema = publicEnvSchema.extend({
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  WORKSPACE_DOMAIN: z
    .string()
    .transform((d) => d.trim().toLowerCase())
    .refine((d) => domainRegex.test(d), "must be a bare domain such as gocirkla.com"),
  FEATURE_GMAIL: z.enum(["on", "off"], { error: "FEATURE_GMAIL must be 'on' or 'off'" }),
  // Slack is not built yet; it cannot be enabled by configuration.
  FEATURE_SLACK: z.literal("off", { error: "FEATURE_SLACK must be 'off' (Slack is not built yet)" }),
  // Gmail connection (required when FEATURE_GMAIL=on). Server-only.
  GOOGLE_GMAIL_CLIENT_ID: z.string().regex(/\.apps\.googleusercontent\.com$/, "must be a Google OAuth client ID").optional(),
  GOOGLE_GMAIL_CLIENT_SECRET: z.string().min(10).optional(),
  TOKEN_ENCRYPTION_KEY: base64Key32.optional(),
  TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .refine(isPublishableKey, "must be a publishable (sb_publishable_) or anon key, never a secret/service key")
    .optional(),
  // Not used by Phase 1 code paths. Validated only if present so that a
  // malformed value is caught early. Never exposed to the browser.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string")
    .optional(),
}).superRefine((env, ctx) => {
  if (env.FEATURE_GMAIL !== "on") return;
  for (const key of ["GOOGLE_GMAIL_CLIENT_ID", "GOOGLE_GMAIL_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"] as const) {
    if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required when FEATURE_GMAIL=on" });
  }
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
