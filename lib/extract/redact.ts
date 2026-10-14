/**
 * Stage B redaction: masks the most damaging data before text leaves our
 * server, and again on everything the model returns before it is stored.
 *
 * Pattern-based, so it has limits (documented in the design doc):
 * free-text sensitive matters are not masked here (see SENSITIVE_TOPIC in
 * validate.ts), unusual number formats can slip through, and long reference
 * numbers can be masked by mistake.
 *
 * Returns counts per kind only, never the masked values.
 */

export type RedactionKind = "link" | "email" | "secret" | "iban" | "ifsc" | "gov_id" | "bank" | "card" | "phone";

export interface Redacted {
  text: string;
  counts: Partial<Record<RedactionKind, number>>;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

type Rule = { kind: RedactionKind; re: RegExp; replace: (m: string, ...g: string[]) => string | null };

const RULES: Rule[] = [
  // Links: tokens often ride in query strings; the link itself is not needed for facts.
  { kind: "link", re: /\bhttps?:\/\/[^\s<>()"']+/gi, replace: () => "[LINK]" },
  { kind: "email", re: /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi, replace: () => "[EMAIL]" },
  {
    kind: "secret",
    re: /\b(passwords?|passcodes?|pwd|otp|one[- ]time (?:pass(?:word|code)|code)|verification code|security code|pin(?: code)?)(\s*(?:is|:|=|-|–)?\s*)([^\s,;]{3,64})/gi,
    replace: (_m, label: string, sep: string) => `${label}${sep}[SECRET]`,
  },
  {
    kind: "card",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    replace: (m: string) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[CARD]" : null;
    },
  },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, replace: () => "[IBAN]" },
  { kind: "ifsc", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, replace: () => "[IFSC]" },
  { kind: "gov_id", re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: () => "[GOV_ID]" }, // US SSN
  { kind: "gov_id", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replace: () => "[GOV_ID]" }, // Indian PAN
  { kind: "gov_id", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, replace: () => "[GOV_ID]" }, // Aadhaar layout
  {
    kind: "gov_id",
    re: /\b((?:passport|aadhaa?r|ssn|social security|pan card|driver'?s? licen[cs]e)\s*(?:no\.?|number|#)?\s*[:\-]?\s*)([A-Z0-9](?:[A-Z0-9-]|\s(?=\d)){4,18}[A-Z0-9])/gi,
    replace: (_m, label: string, value: string) => (/\d/.test(value) ? `${label}[GOV_ID]` : null),
  },
  {
    kind: "bank",
    re: /\b((?:a\/c|acct|account|routing|aba|swift|bic|sort code)\s*(?:no\.?|number|#|code)?\s*[:\-]?\s*)([A-Z0-9](?:[A-Z0-9-]|\s(?=\d)){4,30}[A-Z0-9])/gi,
    // Only when the value is mostly digits (avoids "account for 5,000 trays").
    replace: (_m, label: string, value: string) => ((value.match(/\d/g)?.length ?? 0) >= 6 ? `${label}[BANK]` : null),
  },
  { kind: "phone", re: /\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,5}){2,4}\b/g, replace: () => "[PHONE]" },
  { kind: "phone", re: /\(\d{3}\)\s?\d{3}[-. ]\d{4}\b/g, replace: () => "[PHONE]" },
  { kind: "phone", re: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, replace: () => "[PHONE]" },
  { kind: "phone", re: /\b[6-9]\d{4}[ -]?\d{5}\b/g, replace: () => "[PHONE]" }, // Indian mobile
];

export function redact(input: string): Redacted {
  const counts: Partial<Record<RedactionKind, number>> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const m = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const out = rule.replace(m, ...groups);
      if (out === null) return m;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return out;
    });
  }
  return { text, counts };
}

/** Redacts a short model-produced string and caps its length. */
export function redactField(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const t = redact(String(v)).text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}
