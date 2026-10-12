import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SIGN_IN_SCOPES, containsGmailScope, signInScopeString } from "@/lib/auth/scopes";
import { isSlackEnabled } from "@/lib/features";
import { GMAIL_SCOPE } from "@/lib/gmail/google";
import { isPublicPath } from "@/proxy";

const ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });
}

describe("Gmail access is narrow and contained", () => {
  it("sign-in requests identity scopes only", () => {
    expect([...SIGN_IN_SCOPES]).toEqual(["openid", "email", "profile"]);
    expect(signInScopeString()).toBe("openid email profile");
    expect(containsGmailScope(SIGN_IN_SCOPES)).toBe(false);
  });

  it("detects Gmail scopes if someone adds one", () => {
    expect(containsGmailScope(["openid", "https://www.googleapis.com/auth/gmail.readonly"])).toBe(true);
  });

  it("Gmail scopes and the Gmail API appear in exactly one module", () => {
    const files = ["app", "lib"].flatMap((d) => sourceFiles(join(ROOT, d))).concat([join(ROOT, "proxy.ts")]);
    const users = files.filter((f) => /googleapis\.com\/auth\/gmail|gmail\.googleapis\.com/i.test(readFileSync(f, "utf8")));
    expect(users.map((f) => relative(ROOT, f).replace(/\\/g, "/"))).toEqual(["lib/gmail/google.ts"]);
  });

  it("the only Gmail permission ever requested is gmail.metadata (no bodies, read-only)", () => {
    expect(GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.metadata");
    const src = readFileSync(join(ROOT, "lib", "gmail", "google.ts"), "utf8");
    const scopes = src.match(/googleapis\.com\/auth\/[a-z.]+/g) ?? [];
    expect([...new Set(scopes)]).toEqual(["googleapis.com/auth/gmail.metadata"]);
  });

  it("Slack stays disabled", () => {
    expect(isSlackEnabled()).toBe(false);
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
