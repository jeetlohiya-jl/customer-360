import { describe, expect, it } from "vitest";
import { OUTPUT_SCHEMA, PROMPT_VERSION, SYSTEM_PROMPT } from "@/lib/extract/prompt";
import { runExtractTick, type ClaimedItem, type ExtractDb } from "@/lib/extract/run";
import { validateMetrics, type CommitMetric } from "@/lib/extract/validate";
import { annualize, formatValue } from "@/lib/metrics/format";
import { CUSTOMERS, mkMessage, OWNER_EMAIL, PLANTED } from "../fixtures/synthetic-emails";

const ACME = CUSTOMERS[0].id;
const TEXT = `Hi Ravi,

Our Gainesville plant runs about 250,000 birds a day and we go through roughly 1.2M #4 trays a month.
Next year we expect 15-18 million trays. Our target is $0.11 per tray; Tyson in Texas uses 9 million a year.
Please send 5 samples. Card ${PLANTED.card}.

Jane`;
const ctx = { text: TEXT, customers: CUSTOMERS, openFacts: [], truncated: false };
const base = { customer_id: ACME, party: "customer", kind: "actual", confidence: 0.92 };
const m = (o: Record<string, unknown>) => ({ ...base, ...o });

describe("customer numbers (x7)", () => {
  it("the instructions and schema ask for metrics in the same call", () => {
    expect(PROMPT_VERSION).toBe("x7");
    expect(SYSTEM_PROMPT).toContain("Customer numbers");
    expect(OUTPUT_SCHEMA.required).toEqual(["facts", "metrics"]);
    expect(OUTPUT_SCHEMA.properties.metrics.items.properties.category.enum).toContain("packaging_usage");
  });

  it("keeps numbers that are in the email, with ranges, scope and money", () => {
    const { metrics, dropped } = validateMetrics({
      metrics: [
        m({ category: "production", metric: "birds processed", value: 250000, unit: "birds", period: "day", scope: "Gainesville plant", summary: "Jane (Acme) said Gainesville runs 250,000 birds a day.", evidence_quote: "Our Gainesville plant runs about 250,000 birds a day" }),
        m({ category: "packaging_usage", metric: "#4 trays used", value: 1200000, unit: "trays", period: "month", summary: "Uses 1.2M #4 trays a month.", evidence_quote: "roughly 1.2M #4 trays a month" }),
        m({ category: "requirement_forecast", metric: "trays needed", value: 15000000, value_max: 18000000, unit: "trays", period: "year", kind: "forecast", as_of: "2027", summary: "Expects 15-18M trays next year.", evidence_quote: "Next year we expect 15-18 million trays." }),
        m({ category: "spend_price", metric: "target price per tray", value: 0.11, currency: "usd", unit: "per tray", period: "none", kind: "target", summary: "Target $0.11 per tray.", evidence_quote: "Our target is $0.11 per tray" }),
      ],
    }, ctx);
    expect(dropped).toEqual({});
    expect(metrics.map((x) => [x.metric, x.value, x.value_max, x.period, x.review_reasons])).toEqual([
      ["birds processed", 250000, null, "day", []],
      ["#4 trays used", 1200000, null, "month", []],
      ["trays needed", 15000000, 18000000, "year", []],
      ["target price per tray", 0.11, null, "none", []],
    ]);
    expect(metrics[3].currency).toBe("USD");
    expect(metrics[2].as_of).toBe("2027");
  });

  it("flags or drops what it cannot trust", () => {
    const { metrics, dropped } = validateMetrics({
      metrics: [
        m({ category: "production", metric: "lbs processed", value: 900000, unit: "lbs", period: "week", summary: "Processes 900,000 lbs a week.", evidence_quote: "we process 900,000 lbs" }),
        m({ category: "packaging_usage", metric: "trays used", value: 9000000, unit: "trays", period: "year", about_other_customer: true, summary: "Tyson uses 9M a year.", evidence_quote: "Tyson in Texas uses 9 million a year" }),
        m({ category: "spend_price", metric: "budget", value: 0.11, period: "none", summary: "Budget 0.11.", evidence_quote: null }),
        m({ category: "production", metric: "birds processed", value: 250000, unit: "birds", period: "day", summary: "dup", evidence_quote: null }),
        m({ category: "production", metric: "birds processed", value: 250000, unit: "birds", period: "day", summary: "dup", evidence_quote: null }),
        m({ category: "company_size", metric: "plants", value: 3, period: "none", summary: "They have 3 plants after her surgery", evidence_quote: null }),
        { category: "production", metric: "no customer id", value: 1 },
      ],
    }, ctx);
    expect(metrics[0].review_reasons).toEqual(["number_not_in_text", "quote_not_found"]); // invented number and quote
    expect(metrics[1].review_reasons).toEqual(["no_quote"]);
    expect(metrics).toHaveLength(2);
    expect(dropped).toEqual({ other_company: 1, money_without_unit: 1, duplicate: 1, sensitive_topic: 1, invalid_shape: 1 });
  });

  it("stored strings are redacted again", () => {
    const { metrics } = validateMetrics({ metrics: [m({ category: "production", metric: "birds processed", value: 250000, period: "day", summary: `Card ${PLANTED.card} 250,000 birds`, evidence_quote: null })] }, ctx);
    expect(JSON.stringify(metrics)).not.toContain(PLANTED.card);
  });

  it("yearly equivalents use stated periods only, with the working-day assumption for daily figures", () => {
    expect(annualize(250000, "day")).toBe(65_000_000);
    expect(annualize(1_200_000, "month")).toBe(14_400_000);
    expect(annualize(50_000, "week")).toBe(2_600_000);
    expect(annualize(3, "none")).toBeNull();
    expect(annualize(10, "shift")).toBeNull();
    expect(formatValue(1_200_000)).toBe("1.2M");
    expect(formatValue(0.11)).toBe("0.11");
    expect(formatValue(250_000)).toBe("250K");
  });

  it("the extraction run stores an email's numbers before its facts, while it is still claimed", async () => {
    const order: string[] = [];
    let stored: CommitMetric[] = [];
    const item: ClaimedItem = { owner_id: "o1", mailbox_email: OWNER_EMAIL, gmail_message_id: "mx1", gmail_thread_id: null,
      message_at: "2026-11-01T10:00:00.000Z", direction: "inbound", customers: CUSTOMERS };
    const db: ExtractDb = {
      cleanup: async () => 0, claim: async () => [item], token: async () => ({ refresh_token_enc: "x", key_version: 1 }),
      context: async () => [], reserve: async () => "r1", settle: async () => undefined,
      metrics: async (_o, _m, ms) => (order.push("metrics"), (stored = ms), ms.length),
      commit: async () => (order.push("facts"), 0),
      skip: async () => undefined, fail: async () => "failed", release: async () => undefined,
    };
    const sum = await runExtractTick({
      db,
      gmail: { accessToken: async () => "at", listLabels: async () => [], getMessage: async () => mkMessage({ id: "mx1", body: TEXT }) },
      model: { extract: async () => ({ output: { facts: [], metrics: [m({ category: "production", metric: "birds processed", value: 250000, unit: "birds", period: "day", summary: "250,000 birds a day.", evidence_quote: "250,000 birds a day" })] }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
      decrypt: () => "refresh",
    });
    expect(order).toEqual(["metrics", "facts"]);
    expect(sum.metrics).toBe(1);
    expect(stored[0].metric).toBe("birds processed");
  });
});

describe("grouping numbers for the Numbers page", () => {
  it("shows the newest figure per measure and flags an earlier one that differs", async () => {
    const { groupMetrics } = await import("@/lib/metrics/group");
    const row = (o: Record<string, unknown>) => ({
      metric_id: String(o.id), customer_id: "c1", customer_name: "Acme", category: "production", metric: "Birds processed",
      value: 250000, value_max: null, unit: "birds", currency: null, period: "day", scope: "Gainesville", kind: "actual",
      as_of: null, party: "customer", summary: "s", evidence_quote: null, confidence: 0.9, review_state: "auto",
      message_at: "2026-11-01T00:00:00Z", direction: "inbound", is_mine: false, gmail_message_id: null, mailbox_email: null, ...o,
    });
    const groups = groupMetrics([
      row({ id: "old", message_at: "2026-03-01T00:00:00Z", value: 180000 }),
      row({ id: "new" }),
      row({ id: "same-ish", message_at: "2026-06-01T00:00:00Z", value: 240000 }),
      row({ id: "weekly", period: "week", value: 1250000, metric: "birds processed", message_at: "2026-05-01T00:00:00Z" }),
      row({ id: "other-plant", scope: "Baldwin" }),
    ]);
    const gaines = groups.find((g) => g.latest.metric_id === "new")!;
    expect(gaines.earlier.map((e) => e.metric_id)).toEqual(["same-ish", "weekly", "old"]);
    expect(gaines.conflict?.metric_id).toBe("old"); // 180K vs 250K a day; 1.25M a week = 250K a day on 5 days, not flagged
    expect(groups).toHaveLength(2);
  });
});
