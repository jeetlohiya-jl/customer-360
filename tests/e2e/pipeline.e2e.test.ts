/**
 * Whole pipeline, end to end, on a SYNTHETIC mailbox:
 *   Stage A header scan (real worker) -> customer links
 *   -> Stage B content read (real Gmail client against a fake Gmail API)
 *   -> Stage C extraction (scripted model) -> facts in the database.
 * Proves content is fetched ONLY for customer-linked emails, and that
 * excluded, internal and unrelated emails never reach the content step.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { getMessageFull, getMessageHeaders, gmailTokenContext, listLabels, listMessageIds, refreshAccessToken } from "@/lib/gmail/google";
import { createWorkerDb } from "@/lib/scan/db";
import { runTick } from "@/lib/scan/worker";
import { createExtractDb } from "@/lib/extract/db";
import { runExtractTick } from "@/lib/extract/run";
import type { ExtractModel } from "@/lib/extract/model";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const OWNER = "00000000-0000-4000-8000-0000000e4a01";
const OWNER_EMAIL = "e4.pilot@gocirkla.com";
const NORTHWIND = "00000000-0000-4000-8000-0000000e4f01";
const KEY = randomBytes(32).toString("base64");
const REFRESH = "synthetic-refresh-e4";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const BUYER = "Priya Shah <priya@northwind.example>";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

type Mail = { id: string; from: string; to: string; subject: string; body: string; extra?: Record<string, string>; linked: boolean };
const MAILS: Mail[] = [
  { id: "e4m1", from: BUYER, to: OWNER_EMAIL, subject: "PO 7781", body: "Hi,\n\nPO 7781 attached. Please proceed with 3,000 cases of 9x6 trays, delivery by December 4.\n\nPriya", linked: true },
  { id: "e4m2", from: BUYER, to: OWNER_EMAIL, subject: "Liner option", body: "Hi,\n\nCould you quote 9x6 trays with liner for 10,000 units a month from February?\n\nPriya", linked: true },
  { id: "e4m3", from: "colleague@gocirkla.com", to: OWNER_EMAIL, subject: "Northwind pricing thoughts", body: "INTERNAL-ONLY-MARKER Northwind margin notes", linked: false },
  { id: "e4m4", from: "news@vendor.example", to: OWNER_EMAIL, subject: "Weekly digest", body: "NEWSLETTER-MARKER", extra: { "List-Unsubscribe": "<mailto:u@vendor.example>" }, linked: false },
  { id: "e4m5", from: BUYER, to: OWNER_EMAIL, subject: "Personal", body: "PRIVATE-MARKER", extra: { Sensitivity: "Private" }, linked: false },
  { id: "e4m6", from: BUYER, to: OWNER_EMAIL, subject: "Automatic reply: PO 7781", body: "I am away until Monday with no access to email.", extra: { "Auto-Submitted": "auto-replied" }, linked: true },
  { id: "e4m7", from: OWNER_EMAIL, to: BUYER, subject: "Re: Liner option", body: "Hi Priya,\n\nWe can offer $0.26 per tray for 9x6 with liner at 10,000 units a month.\n\nRavi", linked: true },
  { id: "e4m8", from: "friend@gmail.com", to: OWNER_EMAIL, subject: "Dinner", body: "UNRELATED-PERSONAL-MARKER see you Friday", linked: false },
];

const requests: string[] = [];
const fakeFetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  requests.push(url.pathname + url.search);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "synthetic-access" });
  if (url.pathname.endsWith("/labels")) return json({ labels: [{ id: "INBOX", name: "INBOX" }] });
  if (url.pathname.endsWith("/messages")) return json({ messages: MAILS.map((m) => ({ id: m.id, threadId: `t-${m.id}` })) });
  const id = decodeURIComponent(/\/messages\/([^/?]+)$/.exec(url.pathname)?.[1] ?? "");
  const m = MAILS.find((x) => x.id === id);
  if (!m) return json({ error: "not found" }, 404);
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    { name: "Subject", value: m.subject },
    ...Object.entries(m.extra ?? {}).map(([name, value]) => ({ name, value })),
  ];
  const base = { id: m.id, threadId: `t-${m.id}`, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-09-01T00:00:00Z") + MAILS.indexOf(m) * 3_600_000) };
  if (url.searchParams.get("format") === "full") {
    return json({ ...base, payload: { mimeType: "multipart/mixed", headers, parts: [{ mimeType: "text/plain", body: { data: b64(m.body) } }] } });
  }
  return json({ ...base, payload: { headers } });
}) as unknown as typeof fetch;

const ANSWERS: Record<string, unknown[]> = {
  e4m1: [{ customer_id: NORTHWIND, fact_type: "order", stance: "commitment", party: "customer", basis: "explicit", status: "open", status_basis: "explicit", quantity: 3000, unit: "cases", reference: "PO 7781", due_date: "2026-12-04", summary: "PO 7781 for 3,000 cases of 9x6 trays, delivery by Dec 4", evidence_quote: "PO 7781 attached. Please proceed with 3,000 cases of 9x6 trays", confidence: 0.95 }],
  e4m2: [{ customer_id: NORTHWIND, fact_type: "pricing", stance: "request", party: "customer", basis: "explicit", status: "open", status_basis: "explicit", quantity: 10000, product: "9x6 trays with liner", summary: "Customer asks for a quote for 9x6 with liner, 10,000 a month from February", evidence_quote: "Could you quote 9x6 trays with liner for 10,000 units a month from February?", confidence: 0.92 }],
  e4m7: [{ customer_id: NORTHWIND, fact_type: "pricing", stance: "proposal", party: "cirkla", basis: "explicit", status: "not_applicable", status_basis: "none", unit_price: 0.26, currency: "USD", quantity: 10000, summary: "Cirkla offered $0.26 per tray for 9x6 with liner", evidence_quote: "We can offer $0.26 per tray for 9x6 with liner at 10,000 units a month.", confidence: 0.93 }],
};
const fullFetched: string[] = [];
const model: ExtractModel = { extract: async () => ({ output: { facts: ANSWERS[fullFetched.at(-1)!] ?? [] }, usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 } }) };

let admin: Client;
beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"custom_claims":{"hd":"gocirkla.com"}}')`, [OWNER, OWNER_EMAIL]);
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'Northwind Meats')", [NORTHWIND]);
  await admin.query("insert into public.customer_identifiers (customer_id, kind, value, source) values ($1, 'domain', 'northwind.example', 'import')", [NORTHWIND]);
  await admin.query("insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values ($1, $2, $3, 1, $4)",
    [OWNER, OWNER_EMAIL, encryptSecret(REFRESH, KEY, 1, gmailTokenContext(OWNER)), [READONLY]]);
  await admin.query("update private.settings set value = $1 where key in ('scan_allowed_mailboxes', 'extract_allowed_mailboxes')", [OWNER_EMAIL]);
  await admin.query("update private.ai_budget set cap_microusd = 50000000, paused_at = null");
  await admin.query("begin");
  await admin.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [OWNER, JSON.stringify({ sub: OWNER, role: "authenticated" })]);
  await admin.query("set local role authenticated");
  await admin.query("select public.scan_start()");
  await admin.query("commit");
});
afterAll(async () => admin?.end());

describe("Stage A -> B -> C on a synthetic mailbox", () => {
  const decrypt = (e: string, v: number, owner: string) => decryptSecret(e, KEY, v, gmailTokenContext(owner));
  const gmailAuth = (rt: string) => refreshAccessToken({ refreshToken: rt, clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic" }, fakeFetch);

  it("Stage A: the header scan links only customer emails (unchanged behaviour)", async () => {
    const { db, close } = createWorkerDb(WORKER_URL);
    try {
      for (let i = 0; i < 5; i++) if ((await runTick({ db, decrypt, gmail: { accessToken: gmailAuth, listLabels: (at) => listLabels(at, fakeFetch), listIds: (at, t) => listMessageIds(at, t, fakeFetch), getHeaders: (at, id) => getMessageHeaders(at, id, fakeFetch) } })).status === "idle") break;
    } finally {
      await close();
    }
    const linked = (await admin.query("select gmail_message_id from private.message_links where owner_id = $1 order by 1", [OWNER])).rows.map((r) => r.gmail_message_id);
    expect(linked).toEqual(MAILS.filter((m) => m.linked).map((m) => m.id).sort());
    expect(requests.filter((r) => r.includes("format=full"))).toHaveLength(0); // the scan never reads content
  });

  it("Stage B + C: content is read only for linked emails; facts are stored with source and evidence", async () => {
    const { db, close } = createExtractDb(WORKER_URL);
    try {
      await runExtractTick({ db, model, decrypt, limit: 25, gmail: {
        accessToken: gmailAuth,
        listLabels: (at) => listLabels(at, fakeFetch),
        getMessage: (at, id) => (fullFetched.push(id), getMessageFull(at, id, fakeFetch)),
      } });
    } finally {
      await close();
    }
    expect([...fullFetched].sort()).toEqual(MAILS.filter((m) => m.linked).map((m) => m.id).sort());
    const full = requests.filter((r) => r.includes("format=full")).map((r) => /messages\/([^?]+)/.exec(r)![1]);
    for (const m of MAILS.filter((x) => !x.linked)) expect(full).not.toContain(m.id);

    const facts = (await admin.query(
      "select gmail_message_id, customer_id, fact_type, stance, quantity, unit_price, currency, evidence_quote, review_state, message_at from private.customer_facts where owner_id = $1 order by gmail_message_id",
      [OWNER])).rows;
    expect(facts.map((f) => [f.gmail_message_id, f.fact_type, f.stance, f.review_state])).toEqual([
      ["e4m1", "order", "commitment", "auto"],
      ["e4m2", "pricing", "request", "auto"],
      ["e4m7", "pricing", "proposal", "auto"],
    ]);
    expect(facts.every((f) => f.customer_id === NORTHWIND && f.evidence_quote && f.message_at)).toBe(true);
    const states = (await admin.query("select gmail_message_id, status, skip_reason from private.extraction_state where owner_id = $1 order by 1", [OWNER])).rows;
    expect(states.find((s) => s.gmail_message_id === "e4m6")).toMatchObject({ status: "skipped", skip_reason: "auto_reply" });
  });

  it("no unlinked or unquoted email text exists anywhere in the database", async () => {
    const tables = (await admin.query(`select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('public', 'private')`)).rows.map((r) => r.t as string);
    let dump = "";
    for (const t of tables) dump += (await admin.query(`select coalesce(string_agg(x::text, E'\\n'), '') as d from ${t} x`)).rows[0].d;
    for (const marker of ["INTERNAL-ONLY-MARKER", "NEWSLETTER-MARKER", "PRIVATE-MARKER", "UNRELATED-PERSONAL-MARKER", "away until Monday", "Hi Priya", "delivery by December 4.\n"]) {
      expect(dump, marker).not.toContain(marker);
    }
  });
});
