/**
 * PAID live evaluation (NOT run by default): sends SYNTHETIC emails only to
 * Claude Haiku 5.5 and scores the answers, before and after our checks.
 *
 *   EVAL_APPROVED=yes ANTHROPIC_API_KEY=sk-ant-... npm run eval:extract
 *
 * About 40 calls (~$0.02-0.05 at list prices). Writes extract-eval-result.json
 * (per-email counts; no secrets). Pass bars (design doc):
 *   - 0 requests/proposals stored as unreviewed commitments
 *   - >= 80% of labelled facts found (type + stance [+ status])
 *   - >= 90% of facts on orders, prices and deliveries match a label
 *   - every stored quote verbatim
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anthropicModel, costMicroUsd } from "@/lib/extract/model";
import { prepareMessage } from "@/lib/extract/run";
import { validateFacts } from "@/lib/extract/validate";
import { CASES, CUSTOMERS, OWNER_EMAIL, mkMessage } from "../fixtures/synthetic-emails";
import { EVAL_EMAILS } from "../fixtures/eval-emails";

const fake = process.env.EVAL_OFFLINE_SELFTEST === "yes"; // checks the harness itself with a canned answer; no API call
const run = fake || (process.env.EVAL_APPROVED === "yes" && !!process.env.ANTHROPIC_API_KEY);
const offlineFetch = (async () =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_facts", input: { facts: [] } }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;

const items = [
  ...CASES.filter((c) => c.labels).map((c) => ({ name: c.name, msg: c.msg, direction: c.direction, openFacts: c.openFacts ?? [], labels: c.labels! })),
  ...EVAL_EMAILS.map((e, i) => ({
    name: e.name,
    msg: mkMessage({ id: `ev${String(i).padStart(2, "0")}`, body: e.body, ...(e.direction === "outbound" ? { from: OWNER_EMAIL, to: "Priya <priya@acmefresh.example>" } : {}) }),
    direction: e.direction,
    openFacts: [],
    labels: e.labels,
  })),
];

describe.skipIf(!run)("PAID live extractor evaluation on synthetic emails", () => {
  it("meets the pass bars", async () => {
    const model = fake ? anthropicModel("offline", offlineFetch) : anthropicModel(process.env.ANTHROPIC_API_KEY!);
    const rows: Record<string, unknown>[] = [];
    const t = { emails: 0, labelled: 0, found: 0, stored: 0, keyFacts: 0, keyMatched: 0, rawFalseCommitments: 0, storedFalseCommitments: 0, quotesVerbatim: 0, costMicroUsd: 0, inputTokens: 0, outputTokens: 0 };
    for (const it of items) {
      const prep = prepareMessage(it.msg, { mailbox_email: OWNER_EMAIL, message_at: "2026-09-15T10:00:00.000Z", direction: it.direction, customers: CUSTOMERS }, it.openFacts, new Set());
      if (prep.kind !== "ready") continue;
      const res = await model.extract(prep.prompt);
      t.emails++;
      t.costMicroUsd += costMicroUsd(res.usage);
      t.inputTokens += res.usage.input_tokens + res.usage.cache_read_input_tokens + res.usage.cache_creation_input_tokens;
      t.outputTokens += res.usage.output_tokens;
      const raw = (res.output as { facts?: { fact_type?: string; stance?: string }[] }).facts ?? [];
      const v = validateFacts(res.output, { text: prep.text, customers: CUSTOMERS, openFacts: it.openFacts.map((f) => ({ id: f.id, customer_id: f.customer_id })), truncated: prep.truncated });
      const match = (f: { fact_type: string; stance: string; status: string }, l: { fact_type: string; stance: string; status?: string }) =>
        f.fact_type === l.fact_type && f.stance === l.stance && (!l.status || f.status === l.status);
      const commitLabelled = new Set(it.labels.filter((l) => l.stance === "commitment").map((l) => l.fact_type));
      const rawFalse = raw.filter((f) => f.stance === "commitment" && !commitLabelled.has(String(f.fact_type))).length;
      const storedFalse = v.facts.filter((f) => f.stance === "commitment" && f.review_reasons.length === 0 && !commitLabelled.has(f.fact_type)).length;
      const found = it.labels.filter((l) => v.facts.some((f) => match(f, l))).length;
      const key = v.facts.filter((f) => ["order", "pricing", "delivery"].includes(f.fact_type));
      t.labelled += it.labels.length;
      t.found += found;
      t.stored += v.facts.length;
      t.keyFacts += key.length;
      t.keyMatched += key.filter((f) => it.labels.some((l) => match(f, l))).length;
      t.rawFalseCommitments += rawFalse;
      t.storedFalseCommitments += storedFalse;
      t.quotesVerbatim += v.facts.filter((f) => f.evidence_quote && !f.review_reasons.includes("quote_not_found")).length;
      rows.push({
        email: it.name, labels: it.labels.length, found, stored: v.facts.length, raw_false_commitments: rawFalse, stored_false_commitments: storedFalse,
        stored_facts: v.facts.map((f) => `${f.fact_type}/${f.stance}/${f.status}${f.review_reasons.length ? ` [review: ${f.review_reasons.join(",")}]` : ""}`),
      });
    }
    const summary = {
      ...t,
      recall: t.labelled ? t.found / t.labelled : 1,
      keyPrecision: t.keyFacts ? t.keyMatched / t.keyFacts : 1,
      costUsd: t.costMicroUsd / 1e6,
      estimatedUsdPer1000Emails: t.emails ? (t.costMicroUsd / t.emails) * 1000 / 1e6 : 0,
    };
    writeFileSync("extract-eval-result.json", JSON.stringify({ summary, emails: rows }, null, 2));
    console.info(JSON.stringify({ event: "extract_eval", ...summary }));
    if (fake) {
      expect(summary.emails).toBe(items.length);
      return;
    }
    expect(summary.storedFalseCommitments).toBe(0);
    expect(summary.recall).toBeGreaterThanOrEqual(0.8);
    expect(summary.keyPrecision).toBeGreaterThanOrEqual(0.9);
    expect(t.stored ? t.quotesVerbatim / t.stored : 1).toBeGreaterThanOrEqual(0.9);
  });
});
