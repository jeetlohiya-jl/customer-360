import { describe, expect, it } from "vitest";
import { EnvValidationError, parseServerEnv } from "@/lib/env";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-publishable-key-0123456789",
  APP_BASE_URL: "http://localhost:3000/",
  WORKSPACE_DOMAIN: " GoCirkla.com ",
  FEATURE_GMAIL: "off",
  FEATURE_SLACK: "off",
};

describe("parseServerEnv", () => {
  it("accepts a valid configuration and normalizes values", () => {
    const env = parseServerEnv(valid);
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
    expect(env.WORKSPACE_DOMAIN).toBe("gocirkla.com");
  });

  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "APP_BASE_URL", "WORKSPACE_DOMAIN", "FEATURE_GMAIL", "FEATURE_SLACK"])(
    "refuses to start when %s is missing",
    (key) => {
      const source: Record<string, string | undefined> = { ...valid, [key]: undefined };
      expect(() => parseServerEnv(source)).toThrow(EnvValidationError);
    },
  );

  it("treats blank optional values (NAME= in .env files) as not set", () => {
    const env = parseServerEnv({ ...valid, SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "  " });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("still requires required values even if present but blank", () => {
    expect(() => parseServerEnv({ ...valid, WORKSPACE_DOMAIN: "" })).toThrow(/WORKSPACE_DOMAIN/);
  });

  it("Slack cannot be enabled", () => {
    expect(() => parseServerEnv({ ...valid, FEATURE_SLACK: "on" })).toThrow(/FEATURE_SLACK/);
  });

  it("Gmail can be enabled only with its client and encryption key", () => {
    expect(() => parseServerEnv({ ...valid, FEATURE_GMAIL: "on" })).toThrow(
      /GOOGLE_GMAIL_CLIENT_ID[\s\S]*GOOGLE_GMAIL_CLIENT_SECRET[\s\S]*TOKEN_ENCRYPTION_KEY/,
    );
    const env = parseServerEnv({
      ...valid,
      FEATURE_GMAIL: "on",
      GOOGLE_GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(env.FEATURE_GMAIL).toBe("on");
    expect(env.TOKEN_ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it("rejects a weak or malformed encryption key and a malformed client id", () => {
    const on = { ...valid, FEATURE_GMAIL: "on", GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret" };
    expect(() =>
      parseServerEnv({ ...on, GOOGLE_GMAIL_CLIENT_ID: "x.apps.googleusercontent.com", TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(() =>
      parseServerEnv({ ...on, GOOGLE_GMAIL_CLIENT_ID: "not-a-client-id", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") }),
    ).toThrow(/GOOGLE_GMAIL_CLIENT_ID/);
  });

  it("rejects malformed values", () => {
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ ...valid, WORKSPACE_DOMAIN: "https://gocirkla.com" })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(EnvValidationError);
  });

  it("rejects NEXT_PUBLIC_ variables outside the allowlist", () => {
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SERVICE_ROLE_KEY: "oops-0123456789012345" })).toThrow(
      /not in the public allowlist/,
    );
  });

  it("tolerates the integration's publishable key but rejects a secret key under that name", () => {
    const anonJwt = `x.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.y`;
    const serviceJwt = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.y`;
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic123" })).not.toThrow();
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonJwt })).not.toThrow();
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_synthetic123" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: serviceJwt })).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  it("never echoes secret values in error messages", () => {
    const secret = "sentinel-super-secret-value-should-not-appear";
    try {
      parseServerEnv({ ...valid, DATABASE_URL: secret });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
      expect(String((e as Error).message)).toContain("DATABASE_URL");
    }
  });
});
