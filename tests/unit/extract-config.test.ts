import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { parseExtractConfig } from "@/lib/extract/config";

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-publishable-key-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  WORKSPACE_DOMAIN: "gocirkla.com",
  FEATURE_SLACK: "off",
  FEATURE_GMAIL: "on",
  GOOGLE_GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  FEATURE_SCAN: "on",
  CRON_SECRET: "c".repeat(40),
  WORKER_DATABASE_URL: "postgresql://c360_worker.abcd:pw@h.example:5432/postgres",
};
const key = "sk-ant-api03-SENTINELsyntheticKEY0123456789";
const cfg = (o: Record<string, string | undefined>) => parseExtractConfig(parseServerEnv({ ...base, ...o }));

describe("extraction configuration (fail-safe, off by default)", () => {
  it("is off by default", () => {
    expect(cfg({})).toEqual({ enabled: false, reason: "off", problems: [] });
    expect(cfg({ ANTHROPIC_API_KEY: key })).toEqual({ enabled: false, reason: "off", problems: [] });
  });

  it("is enabled only with the flag, a key and a valid scan setup", () => {
    expect(cfg({ FEATURE_EXTRACT: "on", ANTHROPIC_API_KEY: key }).enabled).toBe(true);
  });

  it.each([
    [{ FEATURE_EXTRACT: "on" }, "ANTHROPIC_API_KEY"],
    [{ FEATURE_EXTRACT: "on", ANTHROPIC_API_KEY: "not-a-key" }, "ANTHROPIC_API_KEY"],
    [{ FEATURE_EXTRACT: "on", ANTHROPIC_API_KEY: key, FEATURE_SCAN: "off" }, "scan configuration"],
    [{ FEATURE_EXTRACT: "yes", ANTHROPIC_API_KEY: key }, "FEATURE_EXTRACT"],
  ])("a bad setting turns extraction off without stopping the site (%#)", (o, name) => {
    expect(() => parseServerEnv({ ...base, ...o })).not.toThrow();
    const c = cfg(o);
    expect(c.enabled).toBe(false);
    if (!c.enabled) {
      expect(c.reason).toBe("misconfigured");
      expect(c.problems.join(" ")).toContain(name);
      expect(c.problems.join(" ")).not.toContain("SENTINEL");
    }
  });
});
