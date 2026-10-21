/**
 * End-to-end: a Slack DM -> real handler -> real c360_worker login -> real
 * database functions (identity, rate limit, customer matching, visibility,
 * budget). Slack and the AI model are scripted fakes. Synthetic data only.
 * Run with scripts/scan-e2e-local.sh (temporary local PostgreSQL).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerModel } from "@/lib/slack/model";
import { createSlackDb } from "@/lib/slack/db";
import { handleDm, MESSAGES } from "@/lib/slack/run";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const ANN = "00000000-0000-4000-8000-0000000e5a01";
const BEN = "00000000-0000-4000-8000-0000000e5b01";
const ACME = "00000000-0000-4000-8000-0000000e5f01";
const usage = { input_tokens: 4000, output_tokens: 90, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 };

let admin: Client;
const posts: { channel: string; text: string }[] = [];
const prompts: string[] = [];
const slack = {
  userEmail: async (id: string) => ({ U0E5ANN: "e5.ann@gocirkla.com", U0E5BEN: "e5.ben@gocirkla.com", U0E5OUT: "x@othercorp.com" })[id] ?? null,
  post: async (channel: string, text: string) => void posts.push({ channel, text }),
};
const model: AnswerModel = {
  answer: async (p) => {
    prompts.push(p);
    return { text: "Cirkla quoted $0.21 per tray FOB [F1]; the customer asked for 5,000 cases [F2].", usage };
  },
};

async function ask(user: string, text: string, eventId: string) {
  const { db, close } = createSlackDb(WORKER_URL);
  try {
    return await handleDm({ db, slack, model, appUrl: "https://c360.example", today: "2026-10-21" }, { eventId, user, channel: "D0E5", text });
  } finally {
    await close();
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values
    ($1, 'e5.ann@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
    ($2, 'e5.ben@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}')`, [ANN, BEN]);
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'Acmeport Fresh Meats LLC')", [ACME]);
  for (const [id, at] of [["e5m1", "2026-09-01T10:00:00Z"], ["e5m2", "2026-09-05T10:00:00Z"]]) {
    await admin.query(
      `insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
       values ($1, $2, $3, $4, 'inbound', '[]', 1, 'm1', 'auto')`, [ANN, ACME, id, at]);
  }
  const cols = `owner_id, customer_id, gmail_message_id, message_at, direction, fact_index, fact_type, stance, party, basis, status,
                status_basis, unit_price, currency, quantity, summary, evidence_quote, confidence, review_state, model, prompt_version`;
  await admin.query(`insert into private.customer_facts (${cols}) values
    ($1, $2, 'e5m1', '2026-09-01T10:00:00Z', 'outbound', 0, 'pricing', 'proposal', 'cirkla', 'explicit', 'open', 'explicit', 0.21, 'USD', null,
     'Cirkla quoted $0.21 per tray FOB', 'we can offer $0.21/tray FOB', 0.93, 'auto', 'm', 'x3'),
    ($1, $2, 'e5m2', '2026-09-05T10:00:00Z', 'inbound', 0, 'order', 'request', 'customer', 'explicit', 'open', 'explicit', null, null, 5000,
     'Customer asked for 5,000 cases', 'Can you do 5,000 cases?', 0.62, 'needs_review', 'm', 'x3')`, [ANN, ACME]);
});

afterAll(async () => {
  await admin.query("update private.settings set value = 'reviewers' where key = 'facts_visibility'");
  await admin.end();
});

describe("Slack DM assistant end to end", () => {
  it("refuses someone outside Cirkla, and never calls the model", async () => {
    expect(await ask("U0E5OUT", "What's open with Acmeport Fresh Meats?", "EvE5a")).toBe("not_allowed");
    expect(posts.at(-1)!.text).toBe(MESSAGES.notAllowed("https://c360.example"));
    expect(prompts).toHaveLength(0);
  });

  it("the mailbox owner gets an answer with sources, own Gmail links and unverified marks; the cost is settled", async () => {
    expect(await ask("U0E5ANN", "What have we quoted acmeport fresh meats?", "EvE5b")).toBe("answered");
    const text = posts.at(-1)!.text;
    expect(text).toContain("[1]");
    expect(text).toContain("*unverified*");
    expect(text).toContain("mail.google.com");
    expect(prompts[0]).toContain("Acmeport Fresh Meats LLC");
    const linked = (await admin.query("select slack_user_id from public.app_users where id = $1", [ANN])).rows[0];
    expect(linked.slack_user_id).toBe("U0E5ANN");
    const usageRow = (await admin.query("select status, actual_microusd from private.ai_usage order by created_at desc limit 1")).rows[0];
    expect(usageRow.status).toBe("settled");
    expect(Number(usageRow.actual_microusd)).toBeGreaterThan(0);
  });

  it("a retry of the same Slack event is ignored", async () => {
    const before = posts.length;
    expect(await ask("U0E5ANN", "What have we quoted acmeport fresh meats?", "EvE5b")).toBe("duplicate");
    expect(posts.length).toBe(before);
  });

  it("a colleague sees nothing during the pilot, then only checked facts once visibility is 'all'", async () => {
    expect(await ask("U0E5BEN", "what's open with Acmeport Fresh Meats", "EvE5c")).toBe("no_facts");
    await admin.query("update private.settings set value = 'all' where key = 'facts_visibility'");
    const n = prompts.length;
    expect(await ask("U0E5BEN", "what's open with Acmeport Fresh Meats", "EvE5d")).toBe("answered");
    const prompt = prompts[n];
    expect(prompt).toContain("we can offer $0.21/tray FOB");
    expect(prompt).not.toContain("5,000 cases"); // awaiting review: owner and admins only
    expect(prompt).not.toContain("e5.ann@"); // not asked who
    expect(posts.at(-1)!.text).not.toContain("mail.google.com"); // not his mailbox
  });

  it("asking who brings in the source mailbox (D2)", async () => {
    const n = prompts.length;
    expect(await ask("U0E5BEN", "Who has been emailing Acmeport Fresh Meats?", "EvE5e")).toBe("answered");
    expect(prompts[n]).toContain("source: e5.ann@gocirkla.com");
  });

  it("the first word of a name is enough, and the reply says which customer it is about", async () => {
    expect(await ask("U0E5ANN", "anything new from acmeport?", "EvE5g")).toBe("answered");
    expect(posts.at(-1)!.text.startsWith("_About Acmeport Fresh Meats LLC:_")).toBe(true);
  });

  it("no customer named: a short question back, no model call", async () => {
    const n = prompts.length;
    expect(await ask("U0E5BEN", "what's open?", "EvE5f")).toBe("no_customer");
    expect(prompts.length).toBe(n);
  });
});
