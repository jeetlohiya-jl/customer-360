import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SIGN_IN_SCOPES, containsGmailScope, signInScopeString } from "@/lib/auth/scopes";
import { featureSummary, isGmailEnabled, isSlackEnabled } from "@/lib/features";
import { isPublicPath } from "@/proxy";

const ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });
}

describe("Phase 1: no Gmail access anywhere", () => {
  it("sign-in requests identity scopes only", () => {
    expect([...SIGN_IN_SCOPES]).toEqual(["openid", "email", "profile"]);
    expect(signInScopeString()).toBe("openid email profile");
    expect(containsGmailScope(SIGN_IN_SCOPES)).toBe(false);
  });

  it("detects Gmail scopes if someone adds one", () => {
    expect(containsGmailScope(["openid", "https://www.googleapis.com/auth/gmail.readonly"])).toBe(true);
  });

  it("no application source references a Gmail OAuth scope or the Gmail API", () => {
    const files = ["app", "lib"].flatMap((d) => sourceFiles(join(ROOT, d))).concat([join(ROOT, "proxy.ts")]);
    const offenders = files.filter((f) => /googleapis\.com\/auth\/gmail|gmail\.googleapis\.com/i.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("integrations report disabled", () => {
    expect(isGmailEnabled()).toBe(false);
    expect(isSlackEnabled()).toBe(false);
    expect(featureSummary()).toEqual({ gmail: "off", slack: "off" });
  });
});

describe("route protection", () => {
  it.each(["/login", "/auth/callback", "/api/health"])("%s is public", (p) => expect(isPublicPath(p)).toBe(true));
  it.each(["/", "/dashboard", "/admin", "/loginx", "/api/other"])("%s requires sign-in", (p) =>
    expect(isPublicPath(p)).toBe(false),
  );
});

describe("Data API exposure", () => {
  it("the private schema is not exposed by supabase/config.toml", () => {
    const toml = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
    const line = toml.split(/\r?\n/).find((l) => /^schemas\s*=/.test(l.trim()));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/private/);
  });
});

describe("repository hygiene", () => {
  it(".env.example contains placeholders only", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const assignments = example.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l));
    for (const line of assignments) {
      const value = line.slice(line.indexOf("=") + 1);
      // Allowed: empty, obvious placeholders, local defaults, flags.
      expect(value, line).toMatch(/^$|^(off|gocirkla\.com|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?|<[^>]+>)$/);
    }
  });
});
