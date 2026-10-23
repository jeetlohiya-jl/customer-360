import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { GmailError, type MessageHeaders } from "@/lib/gmail/google";
import { parseSyncConfig } from "@/lib/sync/config";
import { parsePush, verifyPushToken } from "@/lib/sync/oidc";
import { CATCHUP_PAGES, runSyncTick, type SyncDb, type SyncGmail, type SyncItem, type SyncState } from "@/lib/sync/run";

// ---- OIDC (Pub/Sub push authentication) ----------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const AUD = "https://c360.example/api/gmail/push";
const SA = "gmail-push@cirkla-c360.iam.gserviceaccount.com";
const NOW = 1_800_000_000;
function jwt(claims: Record<string, unknown>, kid = "k1") {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `Bearer ${head}.${body}.${sig}`;
}
const good = { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, iat: NOW - 10, exp: NOW + 3600 };
const keys = async () => [jwk];

describe("Pub/Sub push authentication", () => {
  it("accepts a Google-signed token for our URL from the configured service account", async () => {
    expect(await verifyPushToken(jwt(good), { audience: AUD, email: SA }, keys, NOW)).toBe(true);
  });
  it.each([
    ["another audience", { ...good, aud: "https://evil.example/api/gmail/push" }],
    ["another service account", { ...good, email: "x@other-proj.iam.gserviceaccount.com" }],
    ["an unverified email", { ...good, email_verified: false }],
    ["an expired token", { ...good, exp: NOW - 120 }],
    ["another issuer", { ...good, iss: "https://evil.example" }],
  ])("refuses %s", async (_, claims) => {
    expect(await verifyPushToken(jwt(claims), { audience: AUD, email: SA }, keys, NOW)).toBe(false);
  });
  it("refuses a tampered token, an unknown key or no token", async () => {
    const t = jwt(good);
    const [h, , s] = t.slice(7).split(".");
    const forged = `Bearer ${h}.${Buffer.from(JSON.stringify({ ...good, email: "attacker@x.iam.gserviceaccount.com" })).toString("base64url")}.${s}`;
    expect(await verifyPushToken(forged, { audience: AUD, email: SA }, keys, NOW)).toBe(false);
    expect(await verifyPushToken(jwt(good, "k9"), { audience: AUD, email: SA }, keys, NOW)).toBe(false);
    expect(await verifyPushToken(null, { audience: AUD, email: SA }, keys, NOW)).toBe(false);
  });
  it("reads the mailbox and history id from a push body, and rejects anything else", () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "Glenn.Divers@gocirkla.com", historyId: 98765 })).toString("base64");
    expect(parsePush({ message: { data }, subscription: "s" })).toEqual({ emailAddress: "glenn.divers@gocirkla.com", historyId: "98765" });
    expect(parsePush({ message: { data: Buffer.from('{"emailAddress":"x","historyId":"1"}').toString("base64") } })).toBeNull();
    expect(parsePush({})).toBeNull();
  });
});

// ---- Configuration ---------------------------------------------------------------------------
describe("sync configuration is fail-safe", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-publishable-key-0123456789",
    APP_BASE_URL: "https://c360.example", WORKSPACE_DOMAIN: "gocirkla.com", FEATURE_SLACK: "off", FEATURE_GMAIL: "on",
    GOOGLE_GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    FEATURE_SCAN: "on", CRON_SECRET: "x".repeat(40), WORKER_DATABASE_URL: "postgresql://c360_worker.abc:pw@aws-0.pooler.supabase.com:5432/postgres",
  };
  const sync = { FEATURE_SYNC: "on", GMAIL_PUSH_TOPIC: "projects/cirkla-c360/topics/gmail-push", GMAIL_PUSH_SERVICE_ACCOUNT: SA };
  it("is off by default and when anything is missing or malformed", () => {
    expect(parseSyncConfig(parseServerEnv(base)).enabled).toBe(false);
    expect(parseSyncConfig(parseServerEnv({ ...base, FEATURE_SYNC: "on" }))).toMatchObject({ enabled: false, reason: "misconfigured" });
    expect(parseSyncConfig(parseServerEnv({ ...base, ...sync, GMAIL_PUSH_TOPIC: "gmail-push" })).enabled).toBe(false);
    expect(parseSyncConfig(parseServerEnv({ ...base, ...sync, FEATURE_SCAN: "off" })).enabled).toBe(false);
  });
  it("is on with every setting valid; the push audience is our own URL", () => {
    expect(parseSyncConfig(parseServerEnv({ ...base, ...sync }))).toMatchObject({ enabled: true, pushAudience: AUD });
  });
});

// ---- The worker --------------------------------------------------------------------------------
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const ACME = "00000000-0000-4000-8000-00000000c0a1";
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");
const master = {
  workspace_domain: "gocirkla.com",
  customers: [{ id: ACME, canonical_name: "Acme Foods", status: "active" as const, names: [{ value: "Acme Foods", kind: "legal" as const }], domains: [{ value: "acmefoods.com", shared: false }], emails: [] }],
  distinctions: [] as [string, string][],
  rejections: [] as string[],
};
const msg = (id: string, at: number, from = "Jane <jane@acmefoods.com>"): MessageHeaders => ({
  id, threadId: `t${id}`, labelIds: ["INBOX"], internalDate: at, headers: { from, to: "ann@gocirkla.com", subject: "Order" },
});

function harness(item: Partial<SyncItem>, opts: { pages?: MessageHeaders[][]; history?: MessageHeaders[]; historyError?: GmailError } = {}) {
  const all = new Map<string, MessageHeaders>();
  for (const p of opts.pages ?? []) for (const m of p) all.set(m.id, m);
  for (const m of opts.history ?? []) all.set(m.id, m);
  const commits: { state: SyncState; links: number; processed: number }[] = [];
  const fails: string[] = [];
  const calls = { watch: 0, list: 0, history: 0 };
  const row: SyncItem = { owner_id: OWNER, mailbox_email: "ann@gocirkla.com", history_id: null, catchup_history_id: null, catchup_page_token: null,
    floor_at: new Date(T0 - 3 * DAY).toISOString(), watch_expires_at: new Date(T0 + 5 * DAY).toISOString(), ...item };
  const db: SyncDb = {
    claim: async () => [row],
    token: async () => ({ refresh_token_enc: "v1.x.y.z", key_version: 1 }),
    customerMaster: async () => master,
    commit: async (_o, state, links, _r, processed) => void commits.push({ state, links: links.length, processed }),
    fail: async (_o, code) => void fails.push(code),
  };
  const gmail: SyncGmail = {
    accessToken: async () => "at",
    listLabels: async () => [],
    listIds: async (_at, token) => {
      calls.list++;
      const i = token ? Number(token) : 0;
      const pages = opts.pages ?? [];
      return { messages: (pages[i] ?? []).map((m) => ({ id: m.id })), nextPageToken: i + 1 < pages.length ? String(i + 1) : null };
    },
    listHistory: async () => {
      calls.history++;
      if (opts.historyError) throw opts.historyError;
      return { messages: (opts.history ?? []).map((m) => ({ id: m.id })), historyId: "7000", nextPageToken: null };
    },
    getHeaders: async (_at, id) => all.get(id)!,
    getThread: async (_at, threadId) => [...all.values()].filter((m) => m.threadId === threadId),
    getHistoryId: async () => "5000",
    watch: async () => (calls.watch++, { historyId: "5000", expiration: new Date(T0 + 7 * DAY).toISOString() }),
  };
  const logs: string[] = [];
  return { commits, fails, calls, deps: { db, gmail, decrypt: () => "refresh", now: () => T0, log: (e: Record<string, unknown>) => void logs.push(JSON.stringify(e)) }, logs };
}

describe("sync worker", () => {
  it("catch-up: newest first back to the floor, then live from the history id recorded at the start", async () => {
    const h = harness({}, { pages: [[msg("m1", T0 - DAY), msg("m2", T0 - 2 * DAY)], [msg("m3", T0 - 2.5 * DAY), msg("m4", T0 - 4 * DAY)]] });
    const sum = await runSyncTick(h.deps);
    expect(sum.synced).toBe(1);
    expect(h.commits[0]).toEqual({ state: { history_id: "5000", catchup_history_id: null, catchup_page_token: null, done: true }, links: 3, processed: 3 });
  });

  it("a long catch-up stops after a few pages and resumes from the saved page", async () => {
    const pages = Array.from({ length: CATCHUP_PAGES + 2 }, (_, i) => [msg(`p${i}`, T0 - DAY + i)]);
    const h = harness({}, { pages });
    await runSyncTick(h.deps);
    expect(h.commits[0].state).toEqual({ history_id: null, catchup_history_id: "5000", catchup_page_token: String(CATCHUP_PAGES), done: false });
    expect(h.calls.list).toBe(CATCHUP_PAGES);
  });

  it("live: only messages added since the stored history id; internal and other mail is not linked", async () => {
    const h = harness({ history_id: "6000" }, { history: [msg("n1", T0), msg("n2", T0, "Bob <bob@gocirkla.com>"), msg("n3", T0, "News <news@example.org>")] });
    await runSyncTick(h.deps);
    expect(h.commits[0]).toEqual({ state: { history_id: "7000", catchup_history_id: null, catchup_page_token: null, done: true }, links: 1, processed: 3 });
    expect(h.calls.list).toBe(0);
  });

  it("history too old (404): falls back to a catch-up from 8 days back, nothing lost", async () => {
    const h = harness({ history_id: "10" }, { historyError: new GmailError("gmail_api_error", 404, "notFound") });
    await runSyncTick(h.deps);
    expect(h.commits[0].state).toMatchObject({ history_id: null, catchup_history_id: null, done: false, floor_at: new Date(T0 - 8 * DAY).toISOString() });
    expect(h.logs.join("\n")).toContain('"reason":"history_expired"');
  });

  it("an email deleted after its history entry (404 on fetch) is skipped, not a mailbox failure", async () => {
    const h = harness({ history_id: "6000" }, { history: [msg("n1", T0), msg("gone1", T0), msg("n3", T0 - 1)] });
    const getHeaders = h.deps.gmail.getHeaders;
    h.deps.gmail.getHeaders = async (at, id) => {
      if (id === "gone1") throw new GmailError("gmail_api_error", 404, "notFound");
      return getHeaders(at, id);
    };
    const sum = await runSyncTick(h.deps);
    expect(sum).toMatchObject({ synced: 1, failed: 0, gone: 1, links: 2 });
    expect(h.fails).toEqual([]);
    expect(h.commits[0]).toEqual({ state: { history_id: "7000", catchup_history_id: null, catchup_page_token: null, done: true }, links: 2, processed: 2 });
  });

  it("live: an internal reply is a thread follow-up; a newly linked thread's earlier internal replies are read once", async () => {
    const newCustomer = { ...msg("c9", T0), threadId: "TH" };
    const earlierReply = { ...msg("r8", T0 - DAY, "VB <vb@gocirkla.com>"), threadId: "TH" };
    const liveReply = { ...msg("r9", T0, "VB <vb@gocirkla.com>"), threadId: "OLD" };
    const h = harness({ history_id: "6000" }, { history: [newCustomer, liveReply], pages: [[earlierReply]] });
    const sent: string[] = [];
    h.deps.db.customerMaster = async () => ({ ...master, internal_linking: "thread" });
    h.deps.db.commit = async (_o, _s, _l, _r, _p, f = []) => void sent.push(...f.map((x) => x.gmail_message_id));
    const sum = await runSyncTick(h.deps);
    expect(sent.sort()).toEqual(["r8", "r9"]);
    expect(sum.followups).toBe(2);
  });

  it("other fetch errors still fail the step (position kept, retried later)", async () => {
    const h = harness({ history_id: "6000" }, { history: [msg("n1", T0)] });
    h.deps.gmail.getHeaders = async () => {
      throw new GmailError("gmail_api_error", 500, "backendError");
    };
    const sum = await runSyncTick(h.deps);
    expect(sum).toMatchObject({ synced: 0, failed: 1 });
    expect(h.fails).toEqual(["gmail_get:gmail:gmail_api_error_500"]);
    expect(h.commits).toEqual([]);
  });

  it("renews the Gmail watch when it expires within 2 days, and only then", async () => {
    const soon = harness({ history_id: "6000", watch_expires_at: new Date(T0 + DAY).toISOString() }, { history: [] });
    await runSyncTick(soon.deps);
    expect(soon.calls.watch).toBe(1);
    expect(soon.commits[0].state.watch_expires_at).toBe(new Date(T0 + 7 * DAY).toISOString());
    const later = harness({ history_id: "6000" }, { history: [] });
    await runSyncTick(later.deps);
    expect(later.calls.watch).toBe(0);
  });

  it("errors are recorded with a safe code and never contain addresses or subjects", async () => {
    const h = harness({ history_id: "6000" }, { historyError: new GmailError("gmail_api_error", 500, "backendError") });
    const sum = await runSyncTick(h.deps);
    expect(sum.failed).toBe(1);
    expect(h.fails).toEqual(["gmail_history:gmail:gmail_api_error_500"]);
    expect(h.logs.join("\n")).not.toMatch(/acmefoods|gocirkla|Order/);
  });
});
