/**
 * Stage C: checks every fact the model returns before anything is stored.
 *
 * Guarantees (each covered by tests/unit/extract-*.test.ts):
 *  - a request or proposal is never stored as a commitment;
 *  - a commitment is never inferred, and needs a verbatim quote;
 *  - evidence quotes must appear word for word in the redacted email;
 *  - quantities and prices must appear in the email text;
 *  - every stored string is redacted again and length-capped;
 *  - facts about personal matters are dropped, not stored;
 *  - links to earlier facts must point at a fact the model was shown.
 * Anything uncertain gets a review reason, which sends it to review.
 */
import { z } from "zod";
import { redactField } from "./redact";
import { FACT_TYPES, METRIC_CATEGORIES, METRIC_KINDS, METRIC_PERIODS, STANCES, STATUSES } from "./prompt";

export type ReviewReason =
  | "quote_not_found"
  | "no_quote"
  | "number_not_in_text"
  | "date_not_in_text"
  | "unknown_currency"
  | "price_without_currency"
  | "stance_downgraded"
  | "inferred_commitment"
  | "commitment_unverified"
  | "unknown_related_fact"
  | "inferred_status"
  | "other_customer"
  | "truncated_email"
  | "possible_injection";

export type DropReason = "invalid_shape" | "unknown_customer" | "sensitive_topic" | "duplicate" | "over_limit";

export interface CommitFact {
  customer_id: string;
  fact_index: number;
  fact_type: (typeof FACT_TYPES)[number];
  stance: (typeof STANCES)[number];
  party: "customer" | "cirkla" | "unclear";
  basis: "explicit" | "inferred";
  status: (typeof STATUSES)[number];
  status_basis: "explicit" | "inferred" | "none";
  resolves_fact_id: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  currency: string | null;
  price_basis: string | null;
  due_date: string | null;
  due_text: string | null;
  reference: string | null;
  summary: string;
  evidence_quote: string | null;
  confidence: number;
  review_reasons: ReviewReason[];
}

export interface ValidationContext {
  /** The redacted, cleaned text that was sent to the model. Quotes must come from here. */
  text: string;
  /** Redacted earlier-message context sent with a short reply. Numbers and dates may come from here, quotes may not. */
  context?: string;
  /** Email date (YYYY-MM-DD). */
  messageDate?: string;
  customers: { id: string; name: string }[];
  openFacts: { id: string; customer_id: string }[];
  truncated: boolean;
}

export interface ValidationResult {
  facts: CommitFact[];
  dropped: Partial<Record<DropReason, number>>;
}

const nullableString = z.string().nullish().transform((v) => v ?? null);
const nullableNumber = z.number().finite().nonnegative().nullish().transform((v) => v ?? null);

const modelFact = z.object({
  customer_id: z.string(),
  fact_type: z.enum(FACT_TYPES),
  stance: z.enum(STANCES),
  party: z.enum(["customer", "cirkla", "unclear"]),
  basis: z.enum(["explicit", "inferred"]),
  status: z.enum(STATUSES),
  status_basis: z.enum(["explicit", "inferred", "none"]),
  resolves_fact_id: nullableString,
  product: nullableString,
  quantity: nullableNumber,
  unit: nullableString,
  unit_price: nullableNumber,
  currency: nullableString,
  price_basis: nullableString,
  due_date: nullableString,
  due_text: nullableString,
  reference: nullableString,
  summary: z.string().min(1),
  evidence_quote: nullableString,
  confidence: z.number().finite(),
  about_other_customer: z.boolean().optional(),
});

/** Personal matters that must never become a stored fact (dropped, not reviewed). */
export const SENSITIVE_TOPIC =
  /\b(?:diagnos\w*|illness|sick leave|medical|hospital\w*|surgery|pregnan\w*|maternity|therapy|mental health|disabilit\w*|salary|salaries|compensation package|payslip|bonus|appraisal|resign\w*|termination of employment|fired|layoff|visa status|immigration|green card|divorce|funeral|bereavement|lawsuit|litigation|arrest\w*|police)\b/i;

const REQUEST_MARKERS = /\?|\b(?:can|could|would|will) you\b|\bplease (?:quote|send|share|advise|confirm|let us know|provide)\b|\b(?:requesting|we (?:need|require|are looking for)|interested in|looking for|kindly (?:quote|send|share|confirm))\b/i;
const PROPOSAL_MARKERS = /\b(?:we can offer|we could offer|our (?:price|offer|quote) (?:is|would be)|quot(?:e|ed|ing)|propos(?:e|al|ed)|offer(?:ing)?|estimate|indicative)\b/i;

/** Text that tries to instruct the model. Every fact from such an email goes to review. */
export const INJECTION_MARKERS =
  /\b(?:ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|rules)|disregard (?:the|your|all) (?:instructions|rules)|system prompt|you are (?:an? )?(?:ai|assistant|language model)|record_facts|mark (?:this|it) as (?:an? )?(?:agreed|confirmed|committed))\b/i;

const CURRENCIES = new Set(["USD", "INR", "EUR", "GBP", "CAD", "AUD", "MXN", "CNY", "JPY", "AED", "SGD"]);

const ws = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Every number written in the text, with k / lakh / million expanded. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|million|mn|m)?\b/gi;
  for (const m of text.matchAll(re)) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    out.push(base);
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k") out.push(base * 1_000);
    else if (unit.startsWith("lakh") || unit.startsWith("lac")) out.push(base * 100_000);
    else if (unit === "million" || unit === "mn" || unit === "m") out.push(base * 1_000_000);
  }
  // A range whose multiplier is written once, after the second number: "15-18 million", "200 to 250k".
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*\d[\d,]*(?:\.\d+)?\s*(k|lakhs?|lacs?|million|mn|m)\b/gi)) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const unit = m[2].toLowerCase();
    out.push(base * (unit === "k" ? 1_000 : unit.startsWith("la") ? 100_000 : 1_000_000));
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

function dayInText(iso: string, text: string): boolean {
  const d = Number(iso.slice(8, 10));
  return new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\b`).test(text);
}

export function validateFacts(raw: unknown, ctx: ValidationContext): ValidationResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => (dropped[r] = (dropped[r] ?? 0) + 1);
  const list = raw && typeof raw === "object" && Array.isArray((raw as { facts?: unknown }).facts) ? ((raw as { facts: unknown[] }).facts) : [];
  const customerIds = new Set(ctx.customers.map((c) => c.id));
  const textNorm = ws(ctx.text);
  const numbers = numbersIn(`${ctx.text}\n${ctx.context ?? ""}`);
  const seen = new Set<string>();
  const facts: CommitFact[] = [];

  for (const item of list) {
    if (facts.length >= 20) {
      drop("over_limit");
      continue;
    }
    const parsed = modelFact.safeParse(item);
    if (!parsed.success) {
      drop("invalid_shape");
      continue;
    }
    const f = parsed.data;
    if (!customerIds.has(f.customer_id)) {
      drop("unknown_customer");
      continue;
    }
    if ([f.summary, f.evidence_quote, f.product, f.due_text, f.reference, f.price_basis].some((v) => v && SENSITIVE_TOPIC.test(v))) {
      drop("sensitive_topic");
      continue;
    }

    const reasons = new Set<ReviewReason>();
    if (f.about_other_customer) reasons.add("other_customer");
    if (ctx.truncated) reasons.add("truncated_email");
    if (INJECTION_MARKERS.test(ctx.text)) reasons.add("possible_injection");

    // Evidence quote: verbatim from the redacted text, then redacted again.
    let quote = redactField(f.evidence_quote, 200);
    if (quote && !textNorm.includes(ws(quote))) {
      quote = null;
      reasons.add("quote_not_found");
    } else if (!quote) {
      reasons.add("no_quote");
    }

    // Numbers must be in the email.
    let quantity = f.quantity;
    let unitPrice = f.unit_price;
    if (quantity !== null && !numbers.some((n) => near(n, quantity!))) reasons.add("number_not_in_text");
    if (unitPrice !== null && !numbers.some((n) => near(n, unitPrice!))) reasons.add("number_not_in_text");
    if (quantity !== null && quantity > 1e11) quantity = null;
    if (unitPrice !== null && unitPrice > 1e9) unitPrice = null;

    // Currency.
    let currency = f.currency ? f.currency.trim().toUpperCase() : null;
    if (currency && !CURRENCIES.has(currency)) {
      currency = null;
      reasons.add("unknown_currency");
    }
    if (unitPrice !== null && !currency) {
      unitPrice = null;
      reasons.add("price_without_currency");
    }

    // Dates.
    let dueDate = f.due_date && /^\d{4}-\d{2}-\d{2}$/.test(f.due_date) && !Number.isNaN(Date.parse(`${f.due_date}T00:00:00Z`)) ? f.due_date : null;
    if (f.due_date && !dueDate) reasons.add("date_not_in_text");
    if (dueDate && !dayInText(dueDate, `${ctx.text}\n${ctx.context ?? ""}`)) {
      reasons.add("date_not_in_text");
      dueDate = null;
    }

    // Stance: never store a request or proposal as a commitment.
    let stance = f.stance;
    let basis = f.basis;
    if (stance === "commitment" && basis === "inferred") {
      stance = "report";
      reasons.add("inferred_commitment");
    }
    if (stance === "commitment") {
      if (!quote) {
        stance = "report";
        reasons.add("commitment_unverified");
      } else if (REQUEST_MARKERS.test(quote)) {
        stance = "request";
        reasons.add("stance_downgraded");
      } else if (PROPOSAL_MARKERS.test(quote)) {
        stance = "proposal";
        reasons.add("stance_downgraded");
      }
    }

    // Status.
    let status = f.status;
    let statusBasis = f.status_basis;
    if (stance === "cancellation") {
      status = "cancelled";
      statusBasis = basis === "explicit" ? "explicit" : "inferred";
    }
    // A commitment to a future delivery is open until an email says it arrived.
    if (stance === "commitment" && f.fact_type === "delivery" && status === "resolved" && (!dueDate || !ctx.messageDate || dueDate >= ctx.messageDate)) {
      status = "open";
      statusBasis = "explicit";
    }
    if (status === "unknown" || status === "not_applicable") statusBasis = "none";
    else if (statusBasis === "none") statusBasis = "inferred";

    // Links to earlier facts must be ones the model was shown, for the same customer.
    let resolves = f.resolves_fact_id;
    if (resolves && !ctx.openFacts.some((o) => o.id === resolves && o.customer_id === f.customer_id)) {
      resolves = null;
      reasons.add("unknown_related_fact");
    }
    if (statusBasis === "inferred" && (resolves || status === "resolved" || status === "cancelled")) reasons.add("inferred_status");
    if (basis === "inferred" && stance === "commitment") basis = "explicit"; // unreachable: kept for the database check

    const summary = redactField(f.summary, 300);
    if (!summary) {
      drop("invalid_shape");
      continue;
    }
    const key = `${f.customer_id}|${f.fact_type}|${ws(summary)}`;
    if (seen.has(key)) {
      drop("duplicate");
      continue;
    }
    seen.add(key);

    facts.push({
      customer_id: f.customer_id,
      fact_index: facts.length,
      fact_type: f.fact_type,
      stance,
      party: f.party,
      basis,
      status,
      status_basis: statusBasis,
      resolves_fact_id: resolves,
      product: redactField(f.product, 120),
      quantity,
      unit: redactField(f.unit, 24),
      unit_price: unitPrice,
      currency,
      price_basis: redactField(f.price_basis, 40),
      due_date: dueDate,
      due_text: redactField(f.due_text, 60),
      reference: redactField(f.reference, 60),
      summary,
      evidence_quote: quote,
      confidence: Math.round(Math.min(1, Math.max(0, f.confidence)) * 100) / 100,
      review_reasons: [...reasons].sort(),
    });
  }
  return { facts, dropped };
}

// ---------------------------------------------------------------------------
// x7: customer numbers (metrics). Same guarantees as facts: the number must be
// in the email, quotes verbatim, every string re-redacted and capped, personal
// matters dropped. A number about another company is dropped, not reviewed.
// ---------------------------------------------------------------------------

export type MetricDropReason = DropReason | "other_company" | "money_without_unit";

export interface CommitMetric {
  customer_id: string;
  metric_index: number;
  category: (typeof METRIC_CATEGORIES)[number];
  metric: string;
  value: number;
  value_max: number | null;
  unit: string | null;
  currency: string | null;
  period: (typeof METRIC_PERIODS)[number];
  scope: string | null;
  kind: (typeof METRIC_KINDS)[number];
  as_of: string | null;
  party: "customer" | "cirkla" | "unclear";
  summary: string;
  evidence_quote: string | null;
  confidence: number;
  review_reasons: ReviewReason[];
}

const modelMetric = z.object({
  customer_id: z.string(),
  category: z.enum(METRIC_CATEGORIES),
  metric: z.string().min(1),
  value: z.number().finite().nonnegative(),
  value_max: nullableNumber,
  unit: nullableString,
  currency: nullableString,
  period: z.enum(METRIC_PERIODS).catch("none"),
  scope: nullableString,
  kind: z.enum(METRIC_KINDS),
  as_of: nullableString,
  party: z.enum(["customer", "cirkla", "unclear"]),
  summary: z.string().min(1),
  evidence_quote: nullableString,
  confidence: z.number().finite(),
  about_other_customer: z.boolean().optional(),
});

export function validateMetrics(raw: unknown, ctx: ValidationContext): { metrics: CommitMetric[]; dropped: Partial<Record<MetricDropReason, number>> } {
  const dropped: Partial<Record<MetricDropReason, number>> = {};
  const drop = (r: MetricDropReason) => (dropped[r] = (dropped[r] ?? 0) + 1);
  const list = raw && typeof raw === "object" && Array.isArray((raw as { metrics?: unknown }).metrics) ? ((raw as { metrics: unknown[] }).metrics) : [];
  const customerIds = new Set(ctx.customers.map((c) => c.id));
  const textNorm = ws(ctx.text);
  const numbers = numbersIn(`${ctx.text}\n${ctx.context ?? ""}`);
  const seen = new Set<string>();
  const metrics: CommitMetric[] = [];

  for (const item of list) {
    if (metrics.length >= 15) {
      drop("over_limit");
      continue;
    }
    const parsed = modelMetric.safeParse(item);
    if (!parsed.success) {
      drop("invalid_shape");
      continue;
    }
    const m = parsed.data;
    if (!customerIds.has(m.customer_id)) {
      drop("unknown_customer");
      continue;
    }
    if (m.about_other_customer) {
      drop("other_company");
      continue;
    }
    if ([m.metric, m.summary, m.evidence_quote, m.scope].some((v) => v && SENSITIVE_TOPIC.test(v))) {
      drop("sensitive_topic");
      continue;
    }

    const reasons = new Set<ReviewReason>();
    if (ctx.truncated) reasons.add("truncated_email");
    if (INJECTION_MARKERS.test(ctx.text)) reasons.add("possible_injection");

    let quote = redactField(m.evidence_quote, 200);
    if (quote && !textNorm.includes(ws(quote))) {
      quote = null;
      reasons.add("quote_not_found");
    } else if (!quote) {
      reasons.add("no_quote");
    }

    if (m.value > 1e13 || (m.value_max !== null && m.value_max > 1e13)) {
      drop("invalid_shape");
      continue;
    }
    if (!numbers.some((n) => near(n, m.value))) reasons.add("number_not_in_text");
    let valueMax = m.value_max;
    if (valueMax !== null && (valueMax < m.value || !numbers.some((n) => near(n, valueMax!)))) {
      if (valueMax >= m.value) reasons.add("number_not_in_text");
      else valueMax = null;
    }

    let currency = m.currency ? m.currency.trim().toUpperCase() : null;
    if (currency && !CURRENCIES.has(currency)) {
      currency = null;
      reasons.add("unknown_currency");
    }
    const unit = redactField(m.unit, 30);
    if (m.category === "spend_price" && !unit && !currency) {
      drop("money_without_unit");
      continue;
    }

    const metric = redactField(m.metric, 80);
    const summary = redactField(m.summary, 300);
    if (!metric || !summary) {
      drop("invalid_shape");
      continue;
    }
    const key = `${m.customer_id}|${ws(metric)}|${m.value}|${m.period}|${ws(m.scope ?? "")}`;
    if (seen.has(key)) {
      drop("duplicate");
      continue;
    }
    seen.add(key);

    metrics.push({
      customer_id: m.customer_id,
      metric_index: metrics.length,
      category: m.category,
      metric,
      value: m.value,
      value_max: valueMax,
      unit,
      currency,
      period: m.period,
      scope: redactField(m.scope, 80),
      kind: m.kind,
      as_of: m.as_of && /^\d{4}(-\d{2})?$/.test(m.as_of) ? m.as_of : null,
      party: m.party,
      summary,
      evidence_quote: quote,
      confidence: Math.round(Math.min(1, Math.max(0, m.confidence)) * 100) / 100,
      review_reasons: [...reasons].sort(),
    });
  }
  return { metrics, dropped };
}
