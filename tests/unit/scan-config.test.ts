import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { isPemCertificate, parseScanConfig } from "@/lib/scan/config";
import { errorCode, inStage, StageError, tickErrorEvent } from "@/lib/scan/errors";
import { GmailError } from "@/lib/gmail/google";

const PEM = readFileSync(join(__dirname, "../fixtures/test-ca.pem"), "utf8");
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
};
const good = {
  ...base,
  FEATURE_SCAN: "on",
  CRON_SECRET: "c".repeat(40),
  WORKER_DATABASE_URL: "postgresql://c360_worker.abcd:SENTINEL-PW@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  WORKER_DATABASE_CA: PEM,
};
const cfg = (src: Record<string, string | undefined>) => parseScanConfig(parseServerEnv(src));

describe("scan configuration is fail-safe (Stage 3.1.1)", () => {
  it("is enabled only when every setting is valid", () => {
    const c = cfg(good);
    expect(c.enabled).toBe(true);
    if (c.enabled) expect(c.workerDatabaseCa).toContain("BEGIN CERTIFICATE");
  });

  it("is plainly off by default, with no problems reported", () => {
    expect(cfg(base)).toEqual({ enabled: false, reason: "off", problems: [] });
    expect(cfg({ ...base, FEATURE_SCAN: "off", WORKER_DATABASE_CA: "garbage" })).toEqual({ enabled: false, reason: "off", problems: [] });
  });

  it.each([
    ["an invalid CA certificate (the outage we had)", { WORKER_DATABASE_CA: "-----BEGIN CERTIFICATE-----\nnot really\n-----END CERTIFICATE-----" }, "WORKER_DATABASE_CA"],
    ["text that is not a certificate", { WORKER_DATABASE_CA: "hello" }, "WORKER_DATABASE_CA"],
    ["a URL split across lines", { WORKER_DATABASE_URL: "postgresql://c360_worker.abcd:pw@aws-0-us-east-1.pooler\n.supabase.com:5432/postgres" }, "WORKER_DATABASE_URL"],
    ["a URL for the wrong login", { WORKER_DATABASE_URL: "postgresql://postgres:pw@h:5432/postgres" }, "WORKER_DATABASE_URL"],
    ["a missing worker URL", { WORKER_DATABASE_URL: undefined }, "WORKER_DATABASE_URL"],
    ["a short cron secret", { CRON_SECRET: "short" }, "CRON_SECRET"],
    ["a missing cron secret", { CRON_SECRET: "" }, "CRON_SECRET"],
    ["a typo in FEATURE_SCAN", { FEATURE_SCAN: "yes" }, "FEATURE_SCAN"],
    ["Gmail switched off", { FEATURE_GMAIL: "off" }, "FEATURE_SCAN"],
  ])("%s turns scanning off instead of crashing the site", (_label, override, name) => {
    const src = { ...good, ...override } as Record<string, string | undefined>;
    expect(() => parseServerEnv(src)).not.toThrow();
    const c = cfg(src);
    expect(c.enabled).toBe(false);
    if (!c.enabled) {
      expect(c.reason).toBe("misconfigured");
      expect(c.problems.join("\n")).toContain(name);
      expect(c.problems.join("\n")).not.toContain("SENTINEL");
      expect(c.problems.join("\n")).not.toContain("not really");
    }
  });

  it("accepts a CA pasted with literal \\n sequences", () => {
    expect(isPemCertificate(PEM.replace(/\n/g, "\\n"))).toBe(true);
  });

  it("the rest of the app still fails closed on its own settings", () => {
    expect(() => parseServerEnv({ ...good, WORKSPACE_DOMAIN: "" })).toThrow(/WORKSPACE_DOMAIN/);
    expect(() => parseServerEnv({ ...good, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe("safe error codes (Stage 3.1.1)", () => {
  const secret = "postgresql://c360_worker.x:SENTINEL@host/db ya29.SENTINEL-token jeet@customer.com";

  it.each([
    [Object.assign(new Error(`password authentication failed ${secret}`), { code: "28P01" }), "pg_28P01"],
    [Object.assign(new Error(`getaddrinfo ENOTFOUND ${secret}`), { code: "ENOTFOUND" }), "sys_ENOTFOUND"],
    [Object.assign(new Error(`self-signed certificate in chain ${secret}`), { code: "SELF_SIGNED_CERT_IN_CHAIN" }), "sys_SELF_SIGNED_CERT_IN_CHAIN"],
    [new Error(`The server does not support SSL connections ${secret}`), "ssl_unsupported"],
    [new Error(`Connection terminated due to connection timeout ${secret}`), "timeout"],
    [new Error(`Unsupported state or unable to authenticate data`), "decrypt_failed"],
    [new GmailError("gmail_api_error", 429), "gmail:gmail_api_error_429"],
    [new TypeError(secret), "TypeError"],
    [Object.assign(new Error(secret), { name: secret, code: secret }), "error"],
    ["a thrown string " + secret, "error"],
    [null, "error"],
  ])("maps %#", (err, expected) => {
    expect(errorCode(err)).toBe(expected);
    expect(errorCode(err)).not.toContain("SENTINEL");
  });

  it("keeps the stage and never the message", async () => {
    const e = await inStage("db_claim", () => {
      throw Object.assign(new Error(secret), { code: "28P01" });
    }).catch((x) => x);
    expect(e).toBeInstanceOf(StageError);
    const ev = tickErrorEvent(e);
    expect(ev).toEqual({ event: "scan_tick_error", stage: "db_claim", code: "pg_28P01" });
    expect(JSON.stringify(ev)).not.toMatch(/SENTINEL|jeet@|postgresql/);
  });

  it("an untagged error is logged as stage unknown", () => {
    expect(tickErrorEvent(new Error(secret))).toEqual({ event: "scan_tick_error", stage: "unknown", code: "Error" });
  });
});
