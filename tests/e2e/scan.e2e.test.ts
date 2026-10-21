/**
 * End-to-end: synthetic mailbox -> real worker code -> real c360_worker login
 * -> real database functions. No Google, no real email. Run with
 * scripts/scan-e2e-local.sh (temporary local PostgreSQL).
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import {
  getMessageHeaders,
  gmailTokenContext,
  listLabels,
  listMessageIds,
  refreshAccessToken,
  withRetry,
} from "@/lib/gmail/google";
import { createWorkerDb } from "@/lib/scan/db";
import { runTick, type WorkerGmail } from "@/lib/scan/worker";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const OWNER = "00000000-0000-4000-8000-0000000e2e01";
const OTHER = "00000000-0000-4000-8000-0000000e2e02";
const OWNER_EMAIL = "e2e.owner@gocirkla.com";
const ACME = "00000000-0000-4000-8000-0000000ec001";
const KEY = randomBytes(32).toString("base64");
const REFRESH = "synthetic-refresh-token-not-real";
const TOTAL = 620;
const MARK = "SUBJ-MARKER";

type Kind = "acme_domain" | "acme_name" | "acme_typo" | "internal" | "privacy" | "newsletter" | "spam" | "newer";
function kindOf(i: number): Kind {
  if (i === TOTAL - 1) return "newer";
  const k: Kind[] = ["acme_domain", "acme_name", "acme_typo", "internal", "privacy", "newsletter", "spam"];
  return k[i % k.length];
}
const ids = Array.from({ length: TOTAL }, (_, i) => `e2e${i.toString(16).padStart(5, "0")}`);
const base = Date.parse("2026-03-01T00:00:00Z");

function message(i: number) {
  const kind = kindOf(i);
  const h = (name: string, value: string) => ({ name, value });
  const headers = {
    acme_domain: [h("From", "Jane Buyer <jane@acmepackaging.example>"), h("To", OWNER_EMAIL), h("Subject", `${MARK} quote ${i}`)],
    acme_name: [h("From", OWNER_EMAIL), h("To", "someone@gmail.com"), h("Subject", `${MARK} Acme Packaging Ltd trays ${i}`)],
    acme_typo: [h("From", "x@unknown.example"), h("To", OWNER_EMAIL), h("Subject", `${MARK} Acme Packagng delivery ${i}`)],
    internal: [h("From", "colleague@gocirkla.com"), h("To", OWNER_EMAIL), h("Subject", `${MARK} Acme Packaging internal ${i}`)],
    privacy: [h("From", "jane@acmepackaging.example"), h("To", OWNER_EMAIL), h("Subject", `${MARK} your verification code ${i}`)],
    newsletter: [h("From", "news@vendor.example"), h("To", OWNER_EMAIL), h("Subject", `${MARK} digest ${i}`), h("List-Unsubscribe", "<x>")],
    spam: [h("From", "jane@acmepackaging.example"), h("To", OWNER_EMAIL), h("Subject", `${MARK} spam ${i}`)],
    newer: [h("From", "jane@acmepackaging.example"), h("To", OWNER_EMAIL), h("Subject", `${MARK} brand new ${i}`)],
  }[kind];
  return {
    id: ids[i],
    threadId: `th${i}`,
    labelIds: kind === "spam" ? ["SPAM"] : ["INBOX"],
    internalDate: String(kind === "newer" ? Date.now() + 3_600_000 : base + i * 60_000),
    payload: { headers },
    snippet: "SNIPPET SHOULD NEVER BE STORED",
  };
}

const requests: string[] = [];
let crashPage1 = 3; // the first page-2 listing fails 3 times (all retries) -> page is released and repeated
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  requests.push(url.pathname + url.search);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "oauth2.googleapis.com") {
    const body = new URLSearchParams(String(init?.body));
    return body.get("refresh_token") === REFRESH ? json({ access_token: "synthetic-access" }) : json({ error: "invalid_grant" }, 400);
  }
  if (url.pathname.endsWith("/labels")) return json({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "Label_7", name: "C360-Exclude" }] });
  if (url.pathname.endsWith("/messages")) {
    const page = Number((url.searchParams.get("pageToken") ?? "p0").slice(1));
    if (page === 1 && crashPage1 > 0) {
      crashPage1--;
      return json({ error: { status: "UNAVAILABLE" } }, 503);
    }
    const size = Number(url.searchParams.get("maxResults"));
    const slice = ids.slice(page * size, page * size + size);
    return json({ messages: slice.map((id) => ({ id })), nextPageToken: (page + 1) * size < ids.length ? `p${page + 1}` : undefined });
  }
  const m = /\/messages\/([^/?]+)$/.exec(url.pathname);
  if (m) return json(message(ids.indexOf(decodeURIComponent(m[1]))));
  return json({ error: "not found" }, 404);
}) as unknown as typeof fetch;

const gmail: WorkerGmail = {
  accessToken: (rt) => refreshAccessToken({ refreshToken: rt, clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic" }, fakeFetch),
  listLabels: (at) => withRetry(() => listLabels(at, fakeFetch), { sleep: async () => {} }),
  listIds: (at, t) => withRetry(() => listMessageIds(at, t, fakeFetch), { sleep: async () => {} }),
  getHeaders: (at, id) => withRetry(() => getMessageHeaders(at, id, fakeFetch), { sleep: async () => {} }),
};

let admin: Client;
async function asUser(user: string, sql: string) {
  await admin.query("begin");
  try {
    await admin.query("set local role authenticated");
    await admin.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [
      user,
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    const r = await admin.query(sql);
    await admin.query("commit");
    return r.rows;
  } catch (e) {
    await admin.query("rollback");
    throw e;
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, $2, '{"custom_claims":{"hd":"gocirkla.com"}}'), ($3, 'e2e.other@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}')`,
    [OWNER, OWNER_EMAIL, OTHER],
  );
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'Acme Packaging Limited')", [ACME]);
  await admin.query("insert into public.customer_identifiers (customer_id, kind, value, source) values ($1, 'domain', 'acmepackaging.example', 'import')", [ACME]);
  const enc = encryptSecret(REFRESH, KEY, 1, gmailTokenContext(OWNER));
  await admin.query(
    "insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values ($1, $2, $3, 1, $4)",
    [OWNER, OWNER_EMAIL, enc, ["https://www.googleapis.com/auth/gmail.metadata"]],
  );
  await admin.query("update private.settings set value = $1 where key = 'scan_allowed_mailboxes'", [OWNER_EMAIL]);
  await asUser(OWNER, "select public.scan_start()");
});

afterAll(async () => {
  await admin?.end();
});

describe("Stage 3.1 scan, end to end on a synthetic mailbox", () => {
  const statuses: string[] = [];

  it("runs to completion through the worker login, surviving a failed page", async () => {
    const { db, close } = createWorkerDb(WORKER_URL);
    try {
      for (let i = 0; i < 20; i++) {
        const r = await runTick({ db, gmail, decrypt: (e, v, owner) => decryptSecret(e, KEY, v, gmailTokenContext(owner)) });
        statuses.push(r.status);
        if (r.status === "idle") break;
      }
    } finally {
      await close();
    }
    expect(statuses).toEqual(["running", "released", "running", "completed", "idle"]);
  });

  it("accounts for every message exactly once", async () => {
    const { rows } = await admin.query("select * from private.scan_jobs where owner_id = $1", [OWNER]);
    const j = rows[0];
    expect(j.status).toBe("completed");
    expect(j.enumerated).toBe(TOTAL);
    const expected = { acme_domain: 0, acme_name: 0, acme_typo: 0, internal: 0, privacy: 0, newsletter: 0, spam: 0, newer: 0 };
    for (let i = 0; i < TOTAL; i++) expected[kindOf(i)]++;
    expect(j.matched).toBe(expected.acme_domain + expected.acme_name);
    expect(j.in_review).toBe(expected.acme_typo);
    expect(j.excluded_internal).toBe(expected.internal);
    expect(j.excluded_privacy).toBe(expected.privacy);
    expect(j.excluded_rule).toBe(expected.spam);
    expect(j.unmatched).toBe(expected.newsletter);
    expect(j.newer_than_cutoff).toBe(expected.newer);
    expect(j.failed).toBe(0);
  });

  it("stores one link per customer-linked message, no duplicates despite the repeated page", async () => {
    const { rows } = await admin.query(
      "select count(*)::int as n, count(distinct gmail_message_id)::int as d from private.message_links where owner_id = $1",
      [OWNER],
    );
    expect(rows[0].n).toBe(rows[0].d);
    const { rows: j } = await admin.query("select matched from private.scan_jobs where owner_id = $1", [OWNER]);
    expect(rows[0].n).toBe(j[0].matched);
  });

  it("queues the misspelt name once, with every waiting message referenced", async () => {
    const { rows } = await admin.query(
      "select ri.observed, (select count(*)::int from private.review_occurrences o where o.review_item_id = ri.id) as msgs from private.review_items ri",
    );
    expect(rows).toEqual([{ observed: "acme packagng", msgs: (await admin.query("select in_review from private.scan_jobs where owner_id = $1", [OWNER])).rows[0].in_review }]);
  });

  it("stores no subject, snippet or unrelated email anywhere in the database", async () => {
    const { rows } = await admin.query(`
      select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('public', 'private')`);
    for (const { t } of rows) {
      const dump = await admin.query(`select coalesce(string_agg(row_to_json(x)::text, ''), '') as s from ${t} x`);
      expect(dump.rows[0].s, t).not.toContain(MARK);
      expect(dump.rows[0].s, t).not.toContain("SNIPPET");
      expect(dump.rows[0].s, t).not.toContain("news@vendor.example");
      expect(dump.rows[0].s, t).not.toContain("colleague@gocirkla.com");
    }
  });

  it("asked Gmail only for metadata", () => {
    const detail = requests.filter((r) => /\/messages\/[^/?]+\?/.test(r));
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.every((r) => r.includes("format=metadata"))).toBe(true);
    expect(requests.some((r) => /format=(full|raw)|\/attachments/.test(r))).toBe(false);
  });

  it("only the owner can read the links; the worker login cannot read tables", async () => {
    const own = await asUser(OWNER, "select count(*)::int as n from public.my_message_links(null, 1000)");
    const other = await asUser(OTHER, "select count(*)::int as n from public.my_message_links(null, 1000)");
    expect(own[0].n).toBeGreaterThan(0);
    expect(other[0].n).toBe(0);
    const worker = new Client({ connectionString: WORKER_URL });
    await worker.connect();
    await expect(worker.query("select * from private.message_links")).rejects.toThrow(/permission denied/);
    await expect(worker.query("select * from public.customers")).rejects.toThrow(/permission denied/);
    await worker.end();
  });

  it("a second scan of the same mailbox adds no duplicates", async () => {
    const before = (await admin.query("select count(*)::int as n from private.message_links")).rows[0].n;
    await asUser(OWNER, "select public.scan_start()");
    const { db, close } = createWorkerDb(WORKER_URL);
    try {
      for (let i = 0; i < 10; i++) {
        const r = await runTick({ db, gmail, decrypt: (e, v, owner) => decryptSecret(e, KEY, v, gmailTokenContext(owner)) });
        if (r.status === "idle") break;
      }
    } finally {
      await close();
    }
    expect((await admin.query("select count(*)::int as n from private.message_links")).rows[0].n).toBe(before);
  });
});
