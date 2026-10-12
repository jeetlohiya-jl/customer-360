import { describe, expect, it } from "vitest";
import { checkWorkspaceUser, isWorkspaceEmail, type AuthUserLike } from "@/lib/auth/domain";

const D = "gocirkla.com";

describe("isWorkspaceEmail", () => {
  it.each(["name@gocirkla.com", "First.Last@GoCirkla.com", "  name@gocirkla.com  "])("accepts %s", (e) => {
    expect(isWorkspaceEmail(e, D)).toBe(true);
  });

  it.each([
    "name@example.com",
    "name@sub.gocirkla.com",
    "name@gocirkla.com.evil.test",
    "name@evilgocirkla.com",
    "a@b@gocirkla.com",
    "@gocirkla.com",
    "name@",
    "na me@gocirkla.com",
    "",
  ])("rejects %s", (e) => {
    expect(isWorkspaceEmail(e, D)).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isWorkspaceEmail(null, D)).toBe(false);
    expect(isWorkspaceEmail(undefined, D)).toBe(false);
  });
});

describe("checkWorkspaceUser", () => {
  const good: AuthUserLike = {
    email: "synthetic.member@gocirkla.com",
    email_confirmed_at: "2026-10-12T00:00:00Z",
    app_metadata: { provider: "google" },
    user_metadata: { custom_claims: { hd: "gocirkla.com" } },
  };

  it("accepts a verified Google Workspace user", () => {
    expect(checkWorkspaceUser(good, D)).toEqual({ ok: true });
  });

  it("rejects a consumer Google account using a company address (no hd claim)", () => {
    expect(checkWorkspaceUser({ ...good, user_metadata: {} }, D)).toEqual({ ok: false, reason: "missing_hosted_domain" });
  });

  it("rejects a mismatched hd claim", () => {
    expect(checkWorkspaceUser({ ...good, user_metadata: { custom_claims: { hd: "example.com" } } }, D)).toEqual({
      ok: false,
      reason: "wrong_hosted_domain",
    });
  });

  it("rejects other email domains, unverified emails and other providers", () => {
    expect(checkWorkspaceUser({ ...good, email: "x@example.com" }, D)).toMatchObject({ reason: "wrong_email_domain" });
    expect(checkWorkspaceUser({ ...good, email_confirmed_at: null }, D)).toMatchObject({ reason: "email_not_verified" });
    expect(checkWorkspaceUser({ ...good, app_metadata: { provider: "email" } }, D)).toMatchObject({
      reason: "wrong_provider",
    });
    expect(checkWorkspaceUser({ ...good, email: null }, D)).toMatchObject({ reason: "no_email" });
  });
});
