/**
 * End-to-end: Gmail push -> real sync worker -> real c360_worker login -> real
 * database (eligibility, lease, links, extraction queue). Gmail is a scripted
 * fake. Synthetic data only. Run with scripts/scan-e2e-local.sh.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GmailError, type MessageHeaders } from "@/lib/gmail/google";
import { createSyncDb } from "@/lib/sync/db";
import { runSyncTick, type SyncGmail } from "@/lib/sync/run";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const ANN = "00000000-0000-4000-8000-0000000e6a01";
const MAILBOX = "e6.ann@gocirkla.com";
const CUST = "00000000-0000-4000-8000-0000000e6f01";
const DAY = 86_400_000;
const NOW = Date.now();

let admin: Client;
const mail = new Map<string, MessageHeaders>();
const mk = (id: string, at: number, from: string): MessageHeaders => ({ id, threadId: `t${id}`, labelIds: ["INBOX"], internalDate: at, headers: { from, to: MAILBOX, subject: "PO update" } });
let pages: string[][] = [];
let history: string[] = [];

const gmail: SyncGmail = {
  accessToken: async () => "synthetic-access",
  listLabels: async () => [],
  listIds: async (_at, token) => {
    const i = token ? Number(token) : 0;
    return { messages: (pages[i] ?? []).map((id) => ({ id })), nextPageToken: i + 1 < pages.length ? String(i + 1) : null };
  },
  listHistory: async () => ({ messages: history.map((id) => ({ id })), historyId: "9100", nextPageToken: null }),
  getHeaders: async (_at, id) => mail.get(id)!,
  getThread: async (_at, threadId) => [...mail.values()].filter((m) => m.threadId === threadId),
  getHistoryId: async () => "9000",
  watch: async () => ({ historyId: "9000", expiration: new Date(NOW + 7 * DAY).toISOString() }),
};

async function tick(owner?: string) {
  const { db, close } = createSyncDb(WORKER_URL);
  try {
    return { sum: await runSyncTick({ db, gmail, decrypt: () => "synthetic-refresh", owner }), db };
  } finally {
    await close();
  }
}
const q = async <T>(sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows as T[];

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"custom_claims":{"hd":"gocirkla.com"}}')`, [ANN, MAILBOX]);
  await admin.query("insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values ($1, $2, 'v1.iv.ct.tag', 1, $3)",
    [ANN, MAILBOX, ["https://www.googleapis.com/auth/gmail.metadata"]]);
  await admin.query("update private.settings set value = trim(both ',' from value || ',' || $1) where key = 'scan_allowed_mailboxes'", [MAILBOX]);
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'E6 Sixfold Poultry')", [CUST]);
  await admin.query("insert into public.customer_identifiers (customer_id, kind, value, source) values ($1, 'domain', 'sixfold-poultry.com', 'manual')", [CUST]);
  await admin.query("insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at) values ($1, $2, 'completed', 'm1', $3, now())",
    [ANN, MAILBOX, new Date(NOW - 3 * DAY).toISOString()]);
  // Mail since the scan: two customer emails, one internal, plus one from before the floor.
  mail.set("e6m1", mk("e6m1", NOW - DAY, "Pat <pat@sixfold-poultry.com>"));
  mail.set("e6m2", mk("e6m2", NOW - 2 * DAY, "colleague@gocirkla.com"));
  mail.set("e6m3", mk("e6m3", NOW - 3.5 * DAY, "Pat <pat@sixfold-poultry.com>"));
  mail.set("e6m0", mk("e6m0", NOW - 10 * DAY, "Pat <pat@sixfold-poultry.com>"));
  pages = [["e6m1", "e6m2"], ["e6m3", "e6m0"]];
});

afterAll(async () => {
  await admin.end();
});

describe("Gmail sync end to end", () => {
  it("first run: catches up from the last scan (minus a day of overlap) and goes live", async () => {
    const { sum } = await tick(ANN); // other test files leave scanned mailboxes behind: look at this one only
    expect(sum).toMatchObject({ synced: 1, failed: 0, watches_renewed: 1 });
    const links = await q<{ gmail_message_id: string }>("select gmail_message_id from private.message_links where owner_id = $1 order by 1", [ANN]);
    expect(links.map((l) => l.gmail_message_id)).toEqual(["e6m1", "e6m3"]); // e6m0 is before the floor, e6m2 is internal
    const state = (await q<{ history_id: string; watch_expires_at: Date }>("select history_id, watch_expires_at from private.gmail_sync where user_id = $1", [ANN]))[0];
    expect(state.history_id).toBe("9000");
    expect(state.watch_expires_at).not.toBeNull();
    const pending = await q<{ n: string }>("select count(*) as n from private.extraction_state where owner_id = $1 and status = 'pending'", [ANN]);
    expect(Number(pending[0].n)).toBe(2); // extraction picks them up next
  });

  it("a push for the mailbox syncs only what is new", async () => {
    mail.set("e6m4", mk("e6m4", NOW, "Pat <pat@sixfold-poultry.com>"));
    history = ["e6m4"];
    const { db, close } = createSyncDb(WORKER_URL);
    let owner: string | null;
    try {
      owner = await db.push(MAILBOX.toUpperCase(), "9050");
    } finally {
      await close();
    }
    expect(owner).toBe(ANN);
    const { sum } = await tick(owner!);
    expect(sum).toMatchObject({ synced: 1, processed: 1, links: 1 });
    const n = await q<{ n: string }>("select count(*) as n from private.message_links where owner_id = $1", [ANN]);
    expect(Number(n[0].n)).toBe(3);
    expect((await q<{ history_id: string }>("select history_id from private.gmail_sync where user_id = $1", [ANN]))[0].history_id).toBe("9100");
  });

  it("nothing to do: the safety net leaves a live, recently synced mailbox alone", async () => {
    const { sum } = await tick(ANN);
    expect(sum.mailboxes).toBe(0);
  });

  it("0013: internal replies in a customer thread and internal mail naming the customer are linked as internal; a vanished email is skipped", async () => {
    await admin.query("update private.settings set value = 'thread_and_named' where key = 'internal_linking'");
    try {
      // Internal reply in e6m4's thread, a colleague's email naming the customer, one email deleted before it is fetched.
      mail.set("e6r1", { ...mk("e6r1", NOW + 1000, "VB <vb@gocirkla.com>"), threadId: "te6m4", headers: { from: "VB <vb@gocirkla.com>", to: MAILBOX, subject: "RE: PO update" } });
      mail.set("e6i1", { ...mk("e6i1", NOW + 2000, "CRM <crm@gocirkla.com>"), headers: { from: "CRM <crm@gocirkla.com>", to: MAILBOX, subject: "[Ticket] - E6 Sixfold Poultry samples" } });
      mail.set("e6x1", { ...mk("e6x1", NOW + 3000, "VB <vb@gocirkla.com>"), headers: { from: "VB <vb@gocirkla.com>", to: MAILBOX, subject: "lunch?" } });
      history = ["e6r1", "e6i1", "e6x1", "e6gone"];
      const get = gmail.getHeaders;
      gmail.getHeaders = async (at, id) => {
        if (id === "e6gone") throw new GmailError("gmail_api_error", 404, "notFound");
        return get(at, id);
      };
      const { db, close } = createSyncDb(WORKER_URL);
      try {
        await db.push(MAILBOX, "9200");
      } finally {
        await close();
      }
      const { sum } = await tick(ANN);
      gmail.getHeaders = get;
      expect(sum).toMatchObject({ synced: 1, failed: 0, gone: 1 });
      const rows = await q<{ gmail_message_id: string; direction: string; type: string }>(
        "select gmail_message_id, direction, evidence -> 0 ->> 'type' as type from private.message_links where owner_id = $1 and direction = 'internal' order by 1", [ANN]);
      expect(rows).toEqual([
        { gmail_message_id: "e6i1", direction: "internal", type: "I1" },
        { gmail_message_id: "e6r1", direction: "internal", type: "T1" },
      ]);
      const pending = await q<{ n: string }>("select count(*) as n from private.extraction_state where owner_id = $1 and gmail_message_id in ('e6i1', 'e6r1') and status = 'pending'", [ANN]);
      expect(Number(pending[0].n)).toBe(2);
    } finally {
      await admin.query("update private.settings set value = 'off' where key = 'internal_linking'");
    }
  });
});
