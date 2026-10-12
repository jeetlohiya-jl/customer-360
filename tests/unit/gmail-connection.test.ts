import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises the Gmail callback checks end to end with Google and Supabase
 * replaced by fakes. No network, no real accounts.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc }) }));

const ALICE = { id: "11111111-1111-4111-8111-111111111111", email: "alice@gocirkla.com", role: "member" as const, status: "active" as const };
const BOB = { ...ALICE, id: "22222222-2222-4222-8222-222222222222", email: "bob@gocirkla.com" };

type Mod = typeof import("@/lib/gmail/connection");
let mod: Mod;
let env: NonNullable<ReturnType<Mod["gmailEnv"]>>;
let crypto: typeof import("@/lib/security/crypto");

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-publishable-key-0123456789",
    APP_BASE_URL: "https://c360.example",
    WORKSPACE_DOMAIN: "gocirkla.com",
    FEATURE_GMAIL: "on",
    FEATURE_SLACK: "off",
    GOOGLE_GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret",
    TOKEN_ENCRYPTION_KEY: KEY,
  });
  mod = await import("@/lib/gmail/connection");
  crypto = await import("@/lib/security/crypto");
  env = mod.gmailEnv()!;
});

let googleCalls: string[] = [];
function fakeGoogle(mailbox: string) {
  googleCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      googleCalls.push(u);
      const res = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("oauth2.googleapis.com/token"))
        return res({ access_token: "synthetic-access", refresh_token: "synthetic-refresh-SECRET", scope: "https://www.googleapis.com/auth/gmail.metadata" });
      if (u.includes("/profile")) return res({ emailAddress: mailbox });
      if (u.includes("oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
      return new Response("", { status: 404 });
    }),
  );
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

function startFor(user: typeof ALICE) {
  const { url, cookie } = mod.beginAuthorization(user, env);
  return { state: new URL(url).searchParams.get("state")!, cookie: cookie.value, cookieOptions: cookie.options };
}

describe("Gmail authorization callback", () => {
  it("state cookie is httpOnly, Secure on https, Lax, scoped to the OAuth path, short-lived", () => {
    const { cookieOptions } = startFor(ALICE);
    expect(cookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/api/oauth/gmail", maxAge: 600 });
  });

  it("declined consent stores nothing", async () => {
    fakeGoogle("alice@gocirkla.com");
    const { cookie } = startFor(ALICE);
    expect(await mod.completeAuthorization(ALICE, env, { code: null, state: null, error: "access_denied" }, cookie)).toBe("denied");
    expect(rpc).not.toHaveBeenCalled();
    expect(googleCalls).toEqual([]);
  });

  it("rejects a missing cookie, a wrong state, another user's flow, and an expired flow", async () => {
    fakeGoogle("alice@gocirkla.com");
    const a = startFor(ALICE);
    const b = startFor(BOB);
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: a.state, error: null }, undefined)).toBe("invalid_state");
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: "forged", error: null }, a.cookie)).toBe("invalid_state");
    // Bob's flow (cookie + state) presented while Alice is signed in:
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: b.state, error: null }, b.cookie)).toBe("invalid_state");
    const expired = crypto.signValue({ s: "s1", v: "v1", u: ALICE.id, e: Date.now() - 1 }, KEY);
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: "s1", error: null }, expired)).toBe("invalid_state");
    expect(googleCalls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a different mailbox and revokes that authorization", async () => {
    fakeGoogle("someone.else@gocirkla.com");
    const a = startFor(ALICE);
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: a.state, error: null }, a.cookie)).toBe("mailbox_mismatch");
    expect(googleCalls.some((u) => u.includes("/revoke"))).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores only an encrypted token bound to the user, then succeeds", async () => {
    fakeGoogle("Alice@GoCirkla.com");
    const a = startFor(ALICE);
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: a.state, error: null }, a.cookie)).toBe("connected");
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("connect_gmail");
    expect(args.p_mailbox_email).toBe("alice@gocirkla.com");
    expect(String(args.p_refresh_token_enc)).not.toContain("synthetic-refresh-SECRET");
    expect(crypto.decryptSecret(String(args.p_refresh_token_enc), KEY, 1, `gmail-refresh-token:${ALICE.id}`)).toBe("synthetic-refresh-SECRET");
    expect(() => crypto.decryptSecret(String(args.p_refresh_token_enc), KEY, 1, `gmail-refresh-token:${BOB.id}`)).toThrow();
  });

  it("revokes at Google if the database refuses to store", async () => {
    fakeGoogle("alice@gocirkla.com");
    rpc.mockResolvedValue({ data: null, error: { message: "denied" } });
    const a = startFor(ALICE);
    expect(await mod.completeAuthorization(ALICE, env, { code: "c", state: a.state, error: null }, a.cookie)).toBe("store_failed");
    expect(googleCalls.some((u) => u.includes("/revoke"))).toBe(true);
  });
});
