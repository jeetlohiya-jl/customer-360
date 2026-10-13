/**
 * Stage 3.1: decides what happens to ONE message from its headers only.
 * Pure function; no I/O. Order matters:
 *   newer than the scan cutoff -> system labels -> employee's exclude label
 *   -> privacy rules -> internal-only (CS5) -> customer matching.
 *
 * What may leave this function (and be stored): customer ID, Gmail message and
 * thread ID, date, direction, which evidence matched (an approved name, a
 * verified domain or an approved address), and customer-side addresses on
 * verified customer domains (CS4). Never the subject (CS3), never colleagues'
 * addresses. Review items carry only the matched name fragment.
 */
import type { MessageHeaders } from "@/lib/gmail/google";
import { findNames, matchAddress, type MatcherIndex, type NameHit, type AddressHit } from "@/lib/customers/matcher";
import { normalizeEmail } from "@/lib/customers/normalize";

export type Bucket =
  | "newer_than_cutoff"
  | "excluded_rule"
  | "excluded_privacy"
  | "excluded_internal"
  | "matched"
  | "in_review"
  | "unmatched";

export interface LinkOut {
  customer_id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  message_at: string;
  direction: "inbound" | "outbound";
  customer_addresses: string[];
  evidence: { type: string; value: string }[];
  score: number;
}

export interface ReviewOut {
  observed: string;
  reason: string;
  candidates: { customer_id: string; score: number; evidence: string }[];
}

export interface Outcome {
  bucket: Bucket;
  rule?: string; // which exclusion rule fired (counted, never stored per message)
  links: LinkOut[];
  reviews: ReviewOut[];
  weakEvidenceOnly: boolean;
}

export interface ClassifyContext {
  ownerEmail: string;
  workspaceDomain: string;
  cutoffMs: number;
  excludeLabelIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface Address {
  name: string;
  email: string;
}

/** Splits an address header ("A" <a@x.com>, b@y.com) on commas outside quotes and brackets. */
export function parseAddresses(header: string | undefined): Address[] {
  if (!header) return [];
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);

  const out: Address[] = [];
  for (const raw of parts.slice(0, 100)) {
    const p = raw.trim();
    if (!p) continue;
    const m = /<([^<>]+)>/.exec(p);
    const email = normalizeEmail(m ? m[1] : p);
    if (!email) continue;
    const name = (m ? p.slice(0, m.index) : "").replace(/["\\]/g, "").trim();
    out.push({ name, email });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exclusion rules (deterministic; headers only)
// ---------------------------------------------------------------------------

export const SYSTEM_EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CHAT"]);

/** An employee can keep any message out by applying a Gmail label named C360-Exclude. */
export const EXCLUDE_LABEL_RE = /^c360[-_ ]?exclude$/i;

const PRIVACY_SUBJECT: { rule: string; re: RegExp }[] = [
  { rule: "marked_private", re: /\b(private|confidential|personal)\b/i },
  {
    rule: "credentials",
    re: /\b(password|passcode|verification code|security code|one[- ]time (pass)?code|otp|2fa|two[- ]factor|sign[- ]in (alert|attempt)|login alert|new sign[- ]in)\b/i,
  },
  {
    rule: "hr_and_pay",
    re: /\b(payroll|salary|salaries|payslip|pay slip|offer letter|appraisal|performance review|leave (application|request)|medical|insurance claim|health insurance|background check|resignation)\b/i,
  },
  {
    rule: "personal_finance_or_id",
    re: /\b(bank statement|tax return|passport|aadhaar|social security|credit card statement|form 16)\b/i,
  },
];
const PRIVACY_SUBJECT_CASE_SENSITIVE: { rule: string; re: RegExp }[] = [{ rule: "personal_finance_or_id", re: /\b(PAN|SSN|W-2)\b/ }];
const SECURITY_SENDER_DOMAINS = new Set(["accounts.google.com", "account.microsoft.com", "id.apple.com"]);

export function exclusionRule(msg: MessageHeaders, ctx: ClassifyContext): { bucket: Bucket; rule: string } | null {
  const sys = msg.labelIds.find((l) => SYSTEM_EXCLUDED_LABELS.has(l));
  if (sys) return { bucket: "excluded_rule", rule: `label_${sys.toLowerCase()}` };
  if (msg.labelIds.some((l) => ctx.excludeLabelIds.has(l))) return { bucket: "excluded_rule", rule: "employee_exclude_label" };

  const sensitivity = (msg.headers["sensitivity"] ?? "").toLowerCase();
  if (/(private|personal|company-confidential)/.test(sensitivity)) return { bucket: "excluded_privacy", rule: "sensitivity_header" };
  const subject = msg.headers["subject"] ?? "";
  for (const r of [...PRIVACY_SUBJECT, ...PRIVACY_SUBJECT_CASE_SENSITIVE]) {
    if (r.re.test(subject)) return { bucket: "excluded_privacy", rule: r.rule };
  }
  const from = parseAddresses(msg.headers["from"])[0];
  if (from && SECURITY_SENDER_DOMAINS.has(from.email.split("@")[1])) return { bucket: "excluded_privacy", rule: "security_sender" };

  const people = [...parseAddresses(msg.headers["from"]), ...parseAddresses(msg.headers["to"]), ...parseAddresses(msg.headers["cc"])];
  if (people.length > 0 && people.every((p) => p.email.endsWith(`@${ctx.workspaceDomain}`))) {
    return { bucket: "excluded_internal", rule: "internal_only" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching one message
// ---------------------------------------------------------------------------

const STRONG_NAME = (h: NameHit) => h.evidence === "E3";
const STRONG_ADDR = (h: AddressHit) => h.evidence === "E1" || h.evidence === "E2";

export function classifyMessage(msg: MessageHeaders, index: MatcherIndex, ctx: ClassifyContext): Outcome {
  const none: Outcome = { bucket: "unmatched", links: [], reviews: [], weakEvidenceOnly: false };
  if (!Number.isFinite(msg.internalDate) || msg.internalDate <= 0) return { ...none, bucket: "excluded_rule", rule: "no_date" };
  if (msg.internalDate > ctx.cutoffMs) return { ...none, bucket: "newer_than_cutoff" };

  const excluded = exclusionRule(msg, ctx);
  if (excluded) return { ...none, bucket: excluded.bucket, rule: excluded.rule };

  const owner = ctx.ownerEmail.toLowerCase();
  const from = parseAddresses(msg.headers["from"]);
  const others = [...from, ...parseAddresses(msg.headers["to"]), ...parseAddresses(msg.headers["cc"])].filter(
    (p) => p.email !== owner && !p.email.endsWith(`@${ctx.workspaceDomain}`),
  );
  const direction: LinkOut["direction"] = from[0]?.email === owner ? "outbound" : "inbound";

  const addressHits = others.map((p) => matchAddress(index, p.email)).filter((h): h is AddressHit => h !== null);
  const nameHits: NameHit[] = [
    ...findNames(index, msg.headers["subject"] ?? ""),
    ...others.filter((p) => p.name).flatMap((p) => findNames(index, p.name)),
  ];

  const customers = new Set([...addressHits.map((h) => h.customerId), ...nameHits.map((h) => h.customerId)]);
  const links: LinkOut[] = [];
  const reviews = new Map<string, ReviewOut>();
  let weakAddressOnly = false;

  for (const c of customers) {
    const addr = addressHits.filter((h) => h.customerId === c);
    const names = nameHits.filter((h) => h.customerId === c);
    const strongAddr = addr.filter(STRONG_ADDR);
    const strongName = names.filter(STRONG_NAME);
    if (strongAddr.length || strongName.length) {
      const evidence = [
        ...strongAddr.map((h) => ({ type: h.evidence, value: h.evidence === "E1" ? h.address : h.address.split("@")[1] })),
        ...strongName.map((h) => ({ type: "E3", value: h.matched })),
      ];
      links.push({
        customer_id: c,
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId ?? null,
        message_at: new Date(msg.internalDate).toISOString(),
        direction,
        customer_addresses: [...new Set(strongAddr.map((h) => h.address))].slice(0, 20),
        evidence: dedupe(evidence),
        score: strongAddr.length ? 1 : 0.95,
      });
      continue;
    }
    const weakNames = names.filter((h) => h.evidence === "E4" || h.evidence === "E3-generic");
    for (const h of weakNames) {
      const r = reviews.get(h.observed) ?? {
        observed: h.observed,
        reason: h.evidence === "E4" ? "possible spelling variation" : "name is too generic to link alone",
        candidates: [],
      };
      if (!r.candidates.some((x) => x.customer_id === c) && r.candidates.length < 5) {
        r.candidates.push({ customer_id: c, score: Math.round(h.score * 1000) / 1000, evidence: h.evidence });
      }
      reviews.set(h.observed, r);
    }
    if (!weakNames.length && addr.length) weakAddressOnly = true;
  }

  if (links.length) return { bucket: "matched", links, reviews: [...reviews.values()], weakEvidenceOnly: false };
  if (reviews.size) return { bucket: "in_review", links: [], reviews: [...reviews.values()], weakEvidenceOnly: false };
  return { ...none, weakEvidenceOnly: weakAddressOnly };
}

function dedupe<T extends { type: string; value: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.type}|${i.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
