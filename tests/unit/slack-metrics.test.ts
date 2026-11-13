import { describe, expect, it } from "vitest";
import { metricAsFact, renderAnswer, topicTypes, type SlackFact, type SlackMetric } from "@/lib/slack/answer";
import { handleDm, type SlackDb } from "@/lib/slack/run";

const metric = (over: Partial<SlackMetric> = {}): SlackMetric => ({
  metric_id: "m1", customer_id: "c1", customer_name: "Acme Foods", category: "production", metric: "birds processed",
  value: "250000", value_max: null, unit: "birds", currency: null, period: "day", scope: "Gainesville plant", kind: "actual",
  as_of: null, party: "customer", summary: "Jane (Acme Foods) said Gainesville runs 250,000 birds a day.",
  evidence_quote: "runs about 250,000 birds a day", confidence: "0.92", review_state: "auto",
  message_at: "2026-11-01T10:00:00.000Z", direction: "inbound", ...over,
});

const fact: SlackFact = metricAsFact(metric({ metric_id: "f-pricing" }));

describe("customer numbers in Slack", () => {
  it("size, volume and usage questions ask for numbers", () => {
    expect(topicTypes("How many birds a day does Acme process?")).toContain("metric");
    expect(topicTypes("what is their annual tray usage")).toContain("metric");
    expect(topicTypes("forecast for next year")).toContain("metric");
    expect(topicTypes("any quality complaints")).not.toContain("metric");
  });

  it("a number is written out for the model, with the yearly equivalent worked out here", () => {
    const f = metricAsFact(metric());
    expect(f.fact_type).toBe("metric");
    expect(f.stance).toBe("actual");
    expect(f.summary).toContain("Production: birds processed (Gainesville plant) = 250K birds per day; ≈ 65M birds per year (260 working days).");
    const money = metricAsFact(metric({ category: "spend_price", metric: "target price", value: "0.11", unit: "per tray", currency: "USD", period: "none", scope: null, kind: "target" }));
    expect(money.summary).toContain("Spend / price: target price = USD 0.11 per tray.");
  });

  it("an answer citing a number links to the customer's numbers", () => {
    const out = renderAnswer("Acme runs 250K birds a day [F1].", [fact], { customers: [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }], appUrl: "https://c360.example" });
    expect(out.text).toContain("<https://c360.example/numbers?customer=c1|numbers>");
  });

  it("the bot reads numbers only for number questions, and they reach the model", async () => {
    const prompts: string[] = [];
    const calls = { metrics: 0 };
    const db: SlackDb = {
      eventSeen: async () => false,
      user: async () => ({ user_id: "u1", is_admin: false }),
      allow: async () => true,
      customers: async () => [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }],
      facts: async () => [],
      metrics: async () => (calls.metrics++, [metric()]),
      reserve: async () => "r1",
      settle: async () => undefined,
    };
    const deps = {
      db,
      slack: { userEmail: async () => "ann@gocirkla.com", post: async () => undefined, earlierMessages: async () => [] },
      model: { answer: async (p: string) => (prompts.push(p), { text: "250K birds a day [F1].", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
      appUrl: "https://c360.example",
      today: "2026-11-13",
    };
    expect(await handleDm(deps, { eventId: "E1", user: "U01ANN", channel: "D01", text: "How many birds a day does Acme Foods process?" })).toBe("answered");
    expect(prompts[0]).toContain("metric/actual");
    expect(prompts[0]).toContain("250K birds per day");
    expect(await handleDm(deps, { eventId: "E2", user: "U01ANN", channel: "D01", text: "What's open with Acme Foods?" })).toBe("no_facts");
    expect(calls.metrics).toBe(1);
  });
});
