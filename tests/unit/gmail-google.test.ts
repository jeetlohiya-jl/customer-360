import { describe, expect, it, vi } from "vitest";
import {
  GMAIL_SCOPE,
  GmailError,
  MAX_MESSAGES,
  buildAuthUrl,
  exchangeCode,
  getMailboxAddress,
  listRecentMessages,
  pkceChallenge,
  refreshAccessToken,
  revokeToken,
  summarize,
} from "@/lib/gmail/google";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("consent URL", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "123.apps.googleusercontent.com",
      redirectUri: "https://c360.example/api/oauth/gmail/callback",
      state: "state-123",
      codeVerifier: "verifier-abc",
      loginHint: "person@gocirkla.com",
      hostedDomain: "gocirkla.com",
    }),
  );
  const p = url.searchParams;

  it("asks only for gmail.metadata, offline, with fresh consent", () => {
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(p.get("scope")).toBe(GMAIL_SCOPE);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("include_granted_scopes")).toBe("false");
    expect(p.get("response_type")).toBe("code");
  });

  it("carries state and a PKCE S256 challenge, never the verifier", () => {
    expect(p.get("state")).toBe("state-123");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe(pkceChallenge("verifier-abc"));
    expect(url.toString()).not.toContain("verifier-abc");
    expect(p.get("login_hint")).toBe("person@gocirkla.com");
    expect(p.get("hd")).toBe("gocirkla.com");
  });
});

describe("token exchange", () => {
  const opts = { code: "c", codeVerifier: "v", clientId: "id", clientSecret: "s", redirectUri: "r" };

  it("returns tokens when Google grants gmail.metadata with a refresh token", async () => {
    const f = vi.fn(async () => json(200, { access_token: "at", refresh_token: "rt", scope: GMAIL_SCOPE }));
    const t = await exchangeCode(opts, f as unknown as typeof fetch);
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", scopes: [GMAIL_SCOPE] });
    const body = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("v");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("rejects missing refresh token, missing scope, and HTTP errors", async () => {
    await expect(
      exchangeCode(opts, (async () => json(200, { access_token: "at", scope: GMAIL_SCOPE })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "no_refresh_token" });
    await expect(
      exchangeCode(opts, (async () => json(200, { access_token: "at", refresh_token: "rt", scope: "openid" })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "scope_not_granted" });
    await expect(exchangeCode(opts, (async () => json(400, { error: "invalid_grant" })) as unknown as typeof fetch)).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });

  it("keeps only Google's error code as a safe diagnostic reason", async () => {
    await expect(
      exchangeCode(opts, (async () => json(401, { error: "invalid_client", error_description: "The OAuth client was not found." })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "token_exchange_failed", httpStatus: 401, reason: "invalid_client" });
    await expect(
      exchangeCode(opts, (async () => json(400, { error: "secret value with spaces and @ symbols" })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "token_exchange_failed", reason: undefined });
    await expect(
      getMailboxAddress("at", (async () =>
        json(403, { error: { code: 403, message: "Gmail API has not been used in project 123", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "gmail_api_error", httpStatus: 403, reason: "SERVICE_DISABLED" });
  });

  it("detects revoked access on refresh (invalid_grant)", async () => {
    await expect(
      refreshAccessToken({ refreshToken: "rt", clientId: "id", clientSecret: "s" }, (async () =>
        json(400, { error: "invalid_grant" })) as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(GmailError);
    await expect(
      refreshAccessToken({ refreshToken: "rt", clientId: "id", clientSecret: "s" }, (async () =>
        json(400, { error: "invalid_grant" })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("revocation treats already-invalid tokens as done", async () => {
    expect(await revokeToken("t", (async () => new Response("", { status: 200 })) as unknown as typeof fetch)).toBe(true);
    expect(await revokeToken("t", (async () => new Response("", { status: 400 })) as unknown as typeof fetch)).toBe(true);
    expect(await revokeToken("t", (async () => new Response("", { status: 503 })) as unknown as typeof fetch)).toBe(false);
  });
});

describe("Gmail API reads", () => {
  it("identifies the mailbox from Gmail's profile, lower-cased", async () => {
    const f = (async () => json(200, { emailAddress: "Person@GoCirkla.com" })) as unknown as typeof fetch;
    expect(await getMailboxAddress("at", f)).toBe("person@gocirkla.com");
  });

  it("lists at most five messages and requests headers only", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      urls.push(u);
      if (u.includes("/messages?")) {
        return json(200, { messages: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}` })) });
      }
      const id = u.match(/messages\/([^?]+)/)?.[1];
      return json(200, {
        id,
        internalDate: "1791800000000",
        payload: { headers: [{ name: "Subject", value: `Hello ${id}` }, { name: "From", value: "Buyer <b@x.com>" }] },
      });
    });
    const { messages } = await listRecentMessages("at", f as unknown as typeof fetch);
    expect(messages).toHaveLength(MAX_MESSAGES);
    expect(urls[0]).toContain(`maxResults=${MAX_MESSAGES}`);
    const details = urls.slice(1);
    expect(details).toHaveLength(MAX_MESSAGES);
    for (const u of details) {
      expect(u).toContain("format=metadata");
      expect(u).not.toContain("format=full");
      expect(u).not.toContain("format=raw");
    }
    expect(messages[0]).toMatchObject({ id: "m0", subject: "Hello m0", from: "Buyer <b@x.com>" });
  });

  it("maps 401 to revoked and other failures to gmail_api_error", async () => {
    await expect(getMailboxAddress("at", (async () => json(401, {})) as unknown as typeof fetch)).rejects.toMatchObject({ code: "revoked" });
    await expect(getMailboxAddress("at", (async () => json(500, {})) as unknown as typeof fetch)).rejects.toMatchObject({
      code: "gmail_api_error",
    });
  });

  it("summarize handles missing headers and clips long values", () => {
    expect(summarize({ id: "x" })).toEqual({ id: "x", subject: "(no subject)", from: "(unknown sender)", date: "" });
    const long = summarize({ id: "y", payload: { headers: [{ name: "subject", value: "a".repeat(500) }] } });
    expect(long.subject.length).toBe(200);
  });
});

describe("Stage B content permission (only when GMAIL_CONTENT_ACCESS=on)", () => {
  const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
  const opts = { code: "c", codeVerifier: "v", clientId: "id", clientSecret: "s", redirectUri: "https://x.example/cb" };

  it("asks for gmail.readonly ALONE when told to (with metadata too, Google would limit the token)", () => {
    const u = new URL(buildAuthUrl({ clientId: "1.apps.googleusercontent.com", redirectUri: "https://x.example/cb", state: "s", codeVerifier: "v", loginHint: "a@gocirkla.com", hostedDomain: "gocirkla.com", scope: READONLY }));
    expect(u.searchParams.get("scope")).toBe(READONLY);
  });

  it("requires the permission that was asked for", async () => {
    const ok = (async () => json(200, { access_token: "at", refresh_token: "rt", scope: READONLY })) as unknown as typeof fetch;
    await expect(exchangeCode({ ...opts, expectedScope: READONLY }, ok)).resolves.toMatchObject({ scopes: [READONLY] });
    const meta = (async () => json(200, { access_token: "at", refresh_token: "rt", scope: GMAIL_SCOPE })) as unknown as typeof fetch;
    await expect(exchangeCode({ ...opts, expectedScope: READONLY }, meta)).rejects.toMatchObject({ code: "scope_not_granted" });
  });
});

describe("Gmail rate limits (403 with a rate-limit reason)", () => {
  it("are recognised and retried; permission errors are not", async () => {
    const { isRateLimited, withRetry } = await import("@/lib/gmail/google");
    expect(isRateLimited(new GmailError("gmail_api_error", 403, "userRateLimitExceeded"))).toBe(true);
    expect(isRateLimited(new GmailError("gmail_api_error", 403, "rateLimitExceeded"))).toBe(true);
    expect(isRateLimited(new GmailError("gmail_api_error", 429))).toBe(true);
    expect(isRateLimited(new GmailError("gmail_api_error", 403, "insufficientPermissions"))).toBe(false);
    expect(isRateLimited(new GmailError("gmail_api_error", 403))).toBe(false);

    let n = 0;
    const ok = await withRetry(async () => {
      if (++n < 3) throw new GmailError("gmail_api_error", 403, "userRateLimitExceeded");
      return "done";
    }, { sleep: async () => {} });
    expect(ok).toBe("done");

    n = 0;
    await expect(withRetry(async () => {
      n++;
      throw new GmailError("gmail_api_error", 403, "insufficientPermissions");
    }, { sleep: async () => {} })).rejects.toThrow();
    expect(n).toBe(1);
  });
});
