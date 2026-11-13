/**
 * End-to-end: a customer email with numbers -> real extraction worker -> real
 * c360_worker login -> private.customer_metrics -> what people and Slack see.
 * Gmail and the model are scripted fakes. Synthetic data only.
 * Run with scripts/scan-e2e-local.sh (temporary local PostgreSQL).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtractDb } from "@/lib/extract/db";
import { runExtractTick } from "@/lib/extract/run";
import { createSlackDb } from "@/lib/slack/db";
import { mkMessage } from "../fixtures/synthetic-emails";

const ADMIN_URL = process.env.E2E_DB_ADMIN_URL!;
const WORKER_URL = process.env.E2E_DB_WORKER_URL!;
const ANN = "00000000-0000-4000-8000-0000000e7a01";
const ANN_EMAIL = "e7.ann@gocirkla.com";
const CUST = "00000000-0000-4000-8000-0000000e7f01";
const BODY = "Hi Ann,\n\nOur Gainesville plant runs about 250,000 birds a day and we use roughly 1.2M #4 trays a month. Tyson uses 9 million.\n\nJane";
const usage = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const base = { customer_id: CUST, party: "customer", kind: "actual", confidence: 0.92 };

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"custom_claims":{"hd":"gocirkla.com"}}')`, [ANN, ANN_EMAIL]);
  await admin.query("insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values ($1, $2, 'v1.iv.ct.tag', 1, $3)",
    [ANN, ANN_EMAIL, ["https://www.googleapis.com/auth/gmail.readonly"]]);
  await admin.query("update private.settings set value = $1 where key = 'extract_allowed_mailboxes'", [ANN_EMAIL]);
  await admin.query("insert into public.customers (id, canonical_name) values ($1, 'E7 Sevenfold Poultry')", [CUST]);
  // Other test files may leave work queued: park it so this run reads only our email.
  await admin.query("update private.extraction_state set next_attempt_at = now() + interval '1 day' where status = 'pending'");
  await admin.query(`insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
    values ($1, $2, 'e7m1', now() - interval '1 day', 'inbound', '[]', 1, 'm2', 'auto')`, [ANN, CUST]);
});

afterAll(async () => {
  await admin.query("update private.settings set value = 'reviewers' where key = 'facts_visibility'");
  await admin.end();
});

describe("customer numbers end to end", () => {
  it("an email's numbers are stored with the facts; another company's number is not", async () => {
    const { db, close } = createExtractDb(WORKER_URL);
    try {
      const sum = await runExtractTick({
        db,
        gmail: { accessToken: async () => "at", listLabels: async () => [], getMessage: async (_a, id) => mkMessage({ id, body: BODY, to: ANN_EMAIL }) },
        model: {
          extract: async () => ({
            usage,
            output: {
              facts: [],
              metrics: [
                { ...base, category: "production", metric: "birds processed", value: 250000, unit: "birds", period: "day", scope: "Gainesville plant", summary: "Jane said Gainesville runs 250,000 birds a day.", evidence_quote: "Our Gainesville plant runs about 250,000 birds a day" },
                { ...base, category: "packaging_usage", metric: "#4 trays used", value: 1200000, unit: "trays", period: "month", summary: "Uses 1.2M #4 trays a month.", evidence_quote: "roughly 1.2M #4 trays a month" },
                { ...base, category: "packaging_usage", metric: "trays used", value: 9000000, unit: "trays", period: "year", about_other_customer: true, summary: "Tyson uses 9M.", evidence_quote: "Tyson uses 9 million." },
              ],
            },
          }),
        },
        decrypt: () => "refresh",
      });
      expect(sum).toMatchObject({ extracted: 1, failed: 0, metrics: 2 });
    } finally {
      await close();
    }
    const rows = (await admin.query("select metric, value::float8 as value, period, review_state, prompt_version from private.customer_metrics where gmail_message_id = 'e7m1' order by metric_index")).rows;
    expect(rows).toEqual([
      { metric: "birds processed", value: 250000, period: "day", review_state: "auto", prompt_version: "x7" },
      { metric: "#4 trays used", value: 1200000, period: "month", review_state: "auto", prompt_version: "x7" },
    ]);
  });

  it("the owner sees them on the Numbers page and in Slack", async () => {
    await admin.query("begin");
    try {
      await admin.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: ANN, role: "authenticated" }), ANN]);
      await admin.query("set local role authenticated");
      const page = (await admin.query("select metric, gmail_message_id from public.customer_metrics($1)", [CUST])).rows;
      expect(page).toHaveLength(2);
      expect(page[0].gmail_message_id).toBe("e7m1");
    } finally {
      await admin.query("rollback");
    }
    const { db, close } = createSlackDb(WORKER_URL);
    try {
      const slack = await db.metrics!(ANN, [CUST], 50);
      expect(slack.map((m) => m.metric).sort()).toEqual(["#4 trays used", "birds processed"]);
    } finally {
      await close();
    }
  });

  it("disconnecting Gmail deletes the numbers with the links", async () => {
    await admin.query("delete from private.gmail_connections where user_id = $1", [ANN]);
    const n = (await admin.query("select count(*)::int as n from private.customer_metrics where owner_id = $1", [ANN])).rows[0].n;
    expect(n).toBe(0);
  });
});
