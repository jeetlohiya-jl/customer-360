import { describe, expect, it } from "vitest";
import { API_CSP, STATIC_SECURITY_HEADERS, buildCsp, generateNonce } from "@/lib/security/headers";

describe("buildCsp", () => {
  const nonce = generateNonce();

  it("uses a per-request nonce and blocks framing, plugins and inline scripts", () => {
    const csp = buildCsp({ nonce, isDev: false, supabaseUrl: "https://abc.supabase.co" });
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("only allows unsafe-eval in development (React dev tooling)", () => {
    expect(buildCsp({ nonce, isDev: true })).toContain("'unsafe-eval'");
  });

  it("rejects a weak nonce", () => {
    expect(() => buildCsp({ nonce: "abc", isDev: false })).toThrow();
  });

  it("generates unique nonces", () => {
    const set = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(set.size).toBe(100);
  });
});

describe("static headers", () => {
  const names = STATIC_SECURITY_HEADERS.map((h) => h.key);
  it.each(["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"])(
    "includes %s",
    (h) => expect(names).toContain(h),
  );
  it("API responses get a deny-all CSP", () => {
    expect(API_CSP).toContain("default-src 'none'");
  });
});
