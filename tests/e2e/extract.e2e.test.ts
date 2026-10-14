/**
 * End-to-end: synthetic emails -> real extraction worker -> real c360_worker
 * login -> real database functions and access rules. No Google, no AI
 * provider: Gmail and the model are scripted fakes. Run with
 * scripts/scan-e2e-local.sh (temporary local PostgreSQL).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtractDb } from "@/lib/extract/db";
import { runExtractTick, type ExtractGmail } from "@/lib/extract/run";
import type { ExtractModel, Usage } from "@/lib/extract/model";
import { mkMessage, PLANTED } from "../fixtures/synthetic-emails";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const ANN = "00000000-0000-4000-8000-0000000e3a01";
const BEN = "00000000-0000-4000-8000-0000000e3b01";
const BOSS = "00000000-0000-4000-8000-0000000e3c01";
const ANN_EMAIL = "e3.ann@gocirkla.com";
const ACME = "00000000-0000-4000-8000-0000000e3f01";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const NOT_STORED = "Photos are in the shared folder from our QA lead";

const usage: Usage = { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 };
const base = { customer_id: ACME, party: "customer", basis: "explicit", status: "open", status_basis: "explicit", confidence: 0.94 };

// The emails, oldest first, and what a model would say about each.
const EMAILS: { id: string; at: string; body: string; headers?: Record<string, string>; answer: (openIds: Record<string, string>) => unknown[] }[] = [
  {
    id: "e3m1", at: "2026-09-01T10:00:00Z",
    body: "Hello Ravi,\n\nPlease find PO 4512 attached. Please proceed with 5,000 cases of 8x6, delivery by November 12.\n\nJane",
    answer: () => [{ ...base, fact_type: "order", stance: "commitment", quantity: 5000, unit: "cases", reference: "PO 4512", summary: "PO 4512 for 5,000 cases of 8x6", evidence_quote: "Please find PO 4512 attached. Please proceed with 5,000 cases of 8x6" }],
  },
  {
    id: "e3m2", at: "2026-09-05T10:00:00Z",
    body: `Hi Ravi,\n\nPurge is leaking through the lot 42 trays at two stores. ${NOT_STORED}.\n\nJane`,
    answer: () => [{ ...base, fact_type: "quality_issue", stance: "report", reference: "lot 42", summary: "Purge leaking through lot 42 trays at two stores", evidence_quote: "Purge is leaking through the lot 42 trays at two stores." }],
  },
  {
    id: "e3m3", at: "2026-09-10T10:00:00Z",
    body: "Hi Ravi,\n\nPlease hold PO 4512, we need to cancel the November order due to a line change.\n\nJane",
    answer: (open) => [{ ...base, fact_type: "order", stance: "cancellation", status: "cancelled", resolves_fact_id: open.order, summary: "Customer cancelled the November order (PO 4512)", evidence_quote: "we need to cancel the November order" }],
  },
  {
    id: "e3m4", at: "2026-09-20T10:00:00Z",
    body: "Hi Ravi,\n\nReceived the new shipment of lot 43 on Monday, thanks for turning it around so quickly.\n\nJane",
    answer: (open) => [{ ...base, fact_type: "quality_issue", stance: "report", status: "resolved", status_basis: "inferred", resolves_fact_id: open.quality_issue, confidence: 0.75, summary: "New shipment received; lot 42 issue probably resolved", evidence_quote: "Received the new shipment of lot 43 on Monday" }],
  },
  {
    id: "e3m5", at: "2026-09-21T10:00:00Z", headers: { "Auto-Submitted": "auto-replied" },
    body: "I am out of office until Monday with limited access to email.",
    answer: () => { throw new Error("an auto-reply must never reach the model"); },
  },
  {
    id: "e3m6", at: "2026-09-22T10:00:00Z",
    body: "Hi team,\n\nCan you do 5,000 cases of 8x6 trays by Nov 12 at last price?\n\nThanks,\nJane",
    // The model gets it wrong: calls a question a commitment.
    answer: () => [{ ...base, fact_type: "order", stance: "commitment", quantity: 5000, confidence: 0.97, summary: "Customer orders 5,000 cases", evidence_quote: "Can you do 5,000 cases of 8x6 trays by Nov 12 at last price?" }],
  },
  {
    id: "e3m7", at: "2026-09-23T10:00:00Z",
    body: `Hi Ravi,\n\nPlease confirm 1,200 cases for the trial. Refund to card ${PLANTED.card}, A/C No: ${PLANTED.bankAccount}, IFSC ${PLANTED.ifsc}.\nPAN ${PLANTED.pan}. Call ${PLANTED.phone} or ${PLANTED.email}. Portal password: ${PLANTED.password}\n\nJane`,
    answer: () => [{ ...base, fact_type: "order", stance: "request", quantity: 1200, summary: `Customer asks to confirm 1,200 cases; card ${PLANTED.card}; call ${PLANTED.phone}`, evidence_quote: "Please confirm 1,200 cases for the trial." }],
  },
];

let admin: Client;
const prompts: string[] = [];
const fetched: string[] = [];

const gmail: ExtractGmail = {
  accessToken: async () => "synthetic-access",
  listLabels: async () => [{ id: "INBOX", name: "INBOX" }],
  getMessage: async (_at, id) => {
    fetched.push(id);
    const e = EMAILS.find((x) => x.id === id)!;
    return mkMessage({ id, body: e.body, headers: e.headers, to: ANN_EMAIL });
  },
};
const model: ExtractModel = {
  extract: async (prompt) => {
    prompts.push(prompt);
    const open: Record<string, string> = {};
    for (const m of prompt.matchAll(/id ([0-9a-f-]{36}) · (\w+) ·/g)) open[m[2]] = m[1];
    const e = EMAILS.find((x) => x.id === fetched.at(-1))!;
    return { output: { facts: e.answer(open) }, usage };
  },
};

async function link(ids: string[]) {
  for (const id of ids) {
    const e = EMAILS.find((x) => x.id === id)!;
    await admin.query(
      `insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
       values ($1, $2, $3, $4, 'inbound', '[]', 1, 'm1', 'auto')`,
      [ANN, ACME, id, e.at],
    );
  }
}

async function tick(limit = 10) {
  const { db, close } = createExtractDb(WORKER_URL);
  try {
    return await runExtractTick({ db, gmail, model, decrypt: () => "synthetic-refresh", limit });
  } finally {
    await close();
  }
}

async function as<T>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await admin.query("begin");
  try {
    await admin.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: user, role: "authenticated" }), user]);
    await admin.query("set local role authenticated");
    return (await admin.query(sql, params)).rows as T[];
  } finally {
    await admin.query("rollback");
  }
}

const fact = async (msg: string) =>
  (await admin.query("select * from private.customer_facts where gmail_message_id = $1 order by fact_index", [msg])).rows;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values
    ($1, $4, '{"custom_claims":{"hd":"gocirkla.com"}}'), ($2, 'e3.ben@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
    ($3, 'e3.boss@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}')`, [ANN, BEN, BOSS, ANN_EMAIL]);
  await admin.query("update public.app_users set role = 'admin' where id = $1", [BOSS]);
  await admin.query("insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values ($1, $2, 'v1.iv.ct.tag', 1, $3)", [ANN, ANN_EMAIL, [READONLY]]);
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'E3 Acme Fresh Meats')", [ACME]);
});

afterAll(async () => {
  await admin?.end();
});

describe("extraction end to end (synthetic)", () => {
  it("nothing happens while no mailbox is approved for extraction", async () => {
    await link(["e3m1", "e3m2"]);
    expect((await tick()).status).toBe("idle");
    expect(fetched).toHaveLength(0);
    await admin.query("update private.settings set value = $1 where key = 'extract_allowed_mailboxes'", [ANN_EMAIL]);
  });

  it("an explicit PO is stored as a commitment, a complaint as an open quality issue", async () => {
    const s = await tick();
    expect(s.extracted).toBe(2);
    expect((await fact("e3m1"))[0]).toMatchObject({ fact_type: "order", stance: "commitment", status: "open", review_state: "auto" });
    expect((await fact("e3m2"))[0]).toMatchObject({ fact_type: "quality_issue", stance: "report", status: "open", review_state: "auto" });
  });

  it("a cancellation cancels the earlier order; an inferred resolution sends the issue to review instead of closing it", async () => {
    await link(["e3m3", "e3m4"]);
    await tick();
    const order = (await fact("e3m1"))[0];
    expect(order).toMatchObject({ status: "cancelled", status_basis: "explicit" });
    expect((await fact("e3m3"))[0]).toMatchObject({ stance: "cancellation", resolves_fact_id: order.id });
    const issue = (await fact("e3m2"))[0];
    expect(issue).toMatchObject({ status: "resolved", status_basis: "inferred", review_state: "needs_review" });
    expect(issue.review_reasons).toContain("inferred_status");
    expect((await fact("e3m4"))[0].review_state).toBe("needs_review");
  });

  it("auto-replies are skipped before the model; a question labelled as a commitment is stored as a request for review", async () => {
    const before = prompts.length;
    await link(["e3m5", "e3m6", "e3m7"]);
    const s = await tick();
    expect(s.skip_reasons).toEqual({ auto_reply: 1 });
    expect(prompts.length - before).toBe(2);
    const q = (await fact("e3m6"))[0];
    expect(q).toMatchObject({ stance: "request", review_state: "needs_review" });
    expect(q.review_reasons).toContain("stance_downgraded");
  });

  it("no planted secret or unquoted email text is stored anywhere in the database, or sent to the model", async () => {
    const tables = (await admin.query(`select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname in ('public', 'private')`)).rows.map((r) => r.t as string);
    let dump = "";
    for (const t of tables) dump += (await admin.query(`select coalesce(string_agg(x::text, E'\\n'), '') as d from ${t} x`)).rows[0].d;
    for (const [kind, v] of Object.entries(PLANTED)) {
      expect(dump, `${kind} in database`).not.toContain(v);
      expect(prompts.join("\n"), `${kind} in prompt`).not.toContain(v);
    }
    expect(dump).not.toContain(NOT_STORED);
    expect(dump).not.toContain("Hello Ravi");
    expect((await fact("e3m7"))[0].summary).toContain("[CARD]");
  });

  it("during the pilot a colleague sees nothing; an admin sees facts but never Gmail ids", async () => {
    expect(await as(BEN, "select * from public.facts_search()")).toHaveLength(0);
    expect(await as(BEN, "select * from public.search_my_links()")).toHaveLength(0);
    expect(await as(BEN, "select * from public.facts_review_queue()")).toHaveLength(0);
    const seen = await as<{ gmail_message_id: string | null; review_state: string }>(BOSS, "select * from public.facts_search()");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.gmail_message_id === null)).toBe(true);
    const own = await as<{ gmail_message_id: string | null }>(ANN, "select * from public.facts_search()");
    expect(own.every((r) => r.gmail_message_id !== null)).toBe(true);
  });

  it("team-wide visibility shows only checked facts to colleagues", async () => {
    await admin.query("update private.settings set value = 'all' where key = 'facts_visibility'");
    const rows = await as<{ review_state: string; gmail_message_id: string | null; source_owner_email: string | null }>(BEN, "select * from public.facts_search()");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.review_state !== "needs_review" && r.gmail_message_id === null && r.source_owner_email === null)).toBe(true);
    await admin.query("update private.settings set value = 'reviewers' where key = 'facts_visibility'");
  });

  it("the budget hard stop leaves new emails queued and calls no model", async () => {
    await admin.query("update private.ai_budget set cap_microusd = spent_microusd + 1");
    await admin.query(`insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
      values ($1, $2, 'e3m8', '2026-09-24T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto')`, [ANN, ACME]);
    EMAILS.push({ id: "e3m8", at: "2026-09-24T10:00:00Z", body: "Hi Ravi,\n\nWe need 800 cases of 9x6 next month, please share a quote.\n\nJane", answer: () => [] });
    const before = prompts.length;
    const s = await tick();
    expect(s.status).toBe("budget_stopped");
    expect(prompts.length).toBe(before);
    expect((await admin.query("select status from private.extraction_state where gmail_message_id = 'e3m8'")).rows[0].status).toBe("pending");
    expect((await admin.query("select paused_at is not null as p from private.ai_budget")).rows[0].p).toBe(true);
    expect((await tick()).status).toBe("idle"); // stays stopped
  });

  it("a rejected fact write reports no fact text (the shell script also checks the server log)", async () => {
    await admin.query("update private.ai_budget set cap_microusd = 50000000, paused_at = null");
    await admin.query(`insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
      values ($1, $2, 'e3m9', '2026-09-25T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto')`, [ANN, ACME]);
    const { db, close } = createExtractDb(WORKER_URL);
    try {
      const claimed = await db.claim(10, 120);
      expect(claimed.map((c) => c.gmail_message_id)).toContain("e3m9");
      const bad = [{ ...base, fact_index: 0, fact_type: "order", stance: "request", status: "LOGLEAK-STATUS", status_basis: "explicit", resolves_fact_id: null, product: "LOGLEAK-PRODUCT", quantity: null, unit: null, unit_price: null, currency: null, price_basis: null, due_date: null, due_text: null, reference: null, summary: "LOGLEAK-SUMMARY customer text", evidence_quote: "LOGLEAK-QUOTE", review_reasons: [] }];
      const err = await db.commit(ANN, "e3m9", bad as never).catch((e: { message: string; detail?: string; code?: string }) => e);
      expect(err).toMatchObject({ code: "23514" });
      const e = err as { message: string; detail?: string };
      expect(e.message).toBe("fact 0 rejected by a database check (23514)");
      expect(`${e.message} ${e.detail ?? ""}`).not.toContain("LOGLEAK");
      await db.release(ANN, "e3m9");
    } finally {
      await close();
    }
  });

  it("disconnecting Gmail deletes that mailbox's facts and extraction state", async () => {
    await admin.query("delete from private.gmail_connections where user_id = $1", [ANN]);
    expect((await admin.query("select count(*)::int as n from private.customer_facts where owner_id = $1", [ANN])).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int as n from private.extraction_state where owner_id = $1", [ANN])).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int as n from private.ai_usage")).rows[0].n).toBeGreaterThan(0); // cost rows: no mailbox, kept
  });
});
