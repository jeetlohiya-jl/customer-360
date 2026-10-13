/**
 * Customer matching engine (Stage 3.0). Pure functions, no I/O.
 *
 * Rules (design doc, section 7):
 *  - Exact canonical names and approved aliases are strong name evidence (E3),
 *    unless the name is generic (no distinctive word).
 *  - Typos are only ever *candidates* (E4): they go to review, never link.
 *  - Approved addresses (E1) and verified exclusive domains (E2) are strong.
 *    Shared domains and look-alike domains (E5) only send to review.
 *  - Two or more customers in one item always means review.
 *  - Nothing here creates customers, aliases or merges.
 */
import {
  emailDomain,
  isDistinctiveToken,
  isFreemailDomain,
  normalizeEmail,
  normalizeName,
} from "./normalize";
import { allowedEdits, deletionKeys, editDistance } from "./similarity";

export const RULES_VERSION = "m1";

export type NameKind = "canonical" | "legal" | "trading" | "alias";

export interface CustomerRecord {
  id: string;
  canonicalName: string;
  status: "active" | "inactive";
  names: { value: string; kind: NameKind }[]; // canonical included or not; both work
  domains: { value: string; shared: boolean }[];
  emails: string[];
}

export interface MatcherInput {
  customers: CustomerRecord[];
  distinctions: [string, string][];
  rejections: string[]; // normalized strings marked "not a customer"
  workspaceDomain?: string;
  includeInactive?: boolean;
}

interface Entry {
  customerId: string;
  normalized: string;
  tokens: string[];
  compact: string;
  kind: NameKind;
  generic: boolean;
}

export interface MatcherIndex {
  entries: Entry[];
  exact: Map<string, Entry[]>;
  compact: Map<string, Entry[]>;
  tokenKeys: Map<string, Set<number>>;
  tokenCounts: number[];
  rejections: Set<string>;
  distinct: Set<string>;
  customers: Map<string, CustomerRecord>;
  domains: Map<string, { customerId: string; shared: boolean }>;
  emails: Map<string, string>;
  workspaceDomain?: string;
}

export type Evidence = "E1" | "E2" | "E2-shared" | "E3" | "E3-generic" | "E4" | "E5";

export interface NameHit {
  customerId: string;
  observed: string; // the words as found (normalized)
  matched: string; // the customer name they matched
  evidence: "E3" | "E3-generic" | "E4";
  score: number;
  start: number;
  end: number; // token span [start, end)
}

export interface AddressHit {
  customerId: string;
  address: string;
  evidence: "E1" | "E2" | "E2-shared" | "E5";
}

export interface Decision {
  outcome: "link" | "review" | "none";
  customerIds: string[];
  reason: string;
  rulesVersion: string;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Words that appear in the names of 3 or more different customers are treated as generic. */
function sharedWords(entries: { customerId: string; tokens: string[] }[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const t of e.tokens) {
      if (!owners.has(t)) owners.set(t, new Set());
      owners.get(t)!.add(e.customerId);
    }
  }
  return new Set([...owners].filter(([, s]) => s.size >= 3).map(([t]) => t));
}

export function buildIndex(input: MatcherInput): MatcherIndex {
  const customers = new Map<string, CustomerRecord>();
  const raw: { customerId: string; normalized: string; tokens: string[]; kind: NameKind }[] = [];
  const domains = new Map<string, { customerId: string; shared: boolean }>();
  const emails = new Map<string, string>();

  for (const c of input.customers) {
    if (c.status !== "active" && !input.includeInactive) continue;
    customers.set(c.id, c);
    const seen = new Set<string>();
    for (const n of [{ value: c.canonicalName, kind: "canonical" as NameKind }, ...c.names]) {
      const normalized = normalizeName(n.value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      raw.push({ customerId: c.id, normalized, tokens: normalized.split(" "), kind: n.kind });
    }
    for (const d of c.domains) domains.set(d.value, { customerId: c.id, shared: d.shared });
    for (const e of c.emails) emails.set(e, c.id);
  }

  const extraGeneric = sharedWords(raw);
  const entries: Entry[] = raw.map((r) => ({
    ...r,
    compact: r.tokens.join(""),
    generic: !r.tokens.some((t) => isDistinctiveToken(t, extraGeneric)),
  }));

  const exact = new Map<string, Entry[]>();
  const compact = new Map<string, Entry[]>();
  const tokenKeys = new Map<string, Set<number>>();
  entries.forEach((e, i) => {
    if (!exact.has(e.normalized)) exact.set(e.normalized, []);
    exact.get(e.normalized)!.push(e);
    if (!compact.has(e.compact)) compact.set(e.compact, []);
    compact.get(e.compact)!.push(e);
    for (const t of e.tokens) {
      for (const k of deletionKeys(t)) {
        if (!tokenKeys.has(k)) tokenKeys.set(k, new Set());
        tokenKeys.get(k)!.add(i);
      }
    }
  });

  return {
    entries,
    exact,
    compact,
    tokenKeys,
    tokenCounts: [...new Set(entries.map((e) => e.tokens.length))].sort((a, b) => b - a),
    rejections: new Set(input.rejections),
    distinct: new Set(input.distinctions.map(([a, b]) => pairKey(a, b))),
    customers,
    domains,
    emails,
    workspaceDomain: input.workspaceDomain?.toLowerCase(),
  };
}

/** Lowercase words of free text, without removing legal suffixes (spans keep their positions). */
export function tokenize(text: string): string[] {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s ? s.split(" ") : [];
}

function fuzzyEntryMatch(gram: string[], entry: Entry): number | null {
  if (entry.generic || gram.length !== entry.tokens.length) return null;
  let total = 0;
  let distinctiveExact = false;
  for (let i = 0; i < gram.length; i++) {
    const target = entry.tokens[i];
    const allowed = allowedEdits(target.length);
    const d = editDistance(gram[i], target, allowed);
    if (d > allowed) return null;
    total += d;
    if (d === 0 && isDistinctiveToken(target)) distinctiveExact = true;
  }
  if (total === 0) return null; // exact matches are handled separately
  if (!distinctiveExact && total > 1) return null;
  return 1 - total / entry.compact.length;
}

/** Finds customer names (exact and likely typos) anywhere in a short text such as a subject line. */
export function findNames(index: MatcherIndex, text: string, opts: { exclude?: string } = {}): NameHit[] {
  const tokens = tokenize(text).slice(0, 60);
  const exactHits: NameHit[] = [];

  for (const k of index.tokenCounts) {
    for (let i = 0; i + k <= tokens.length; i++) {
      const key = tokens.slice(i, i + k).join(" ");
      for (const e of index.exact.get(key) ?? []) {
        if (e.customerId === opts.exclude) continue;
        exactHits.push({
          customerId: e.customerId,
          observed: key,
          matched: e.normalized,
          evidence: e.generic ? "E3-generic" : "E3",
          score: 1,
          start: i,
          end: i + k,
        });
      }
    }
  }
  // Keep only the longest exact matches: "acme packaging" beats an alias "acme" inside it.
  const exact = exactHits.filter(
    (h) => !exactHits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start),
  );
  const covered = (s: number, e: number) => exact.some((h) => s < h.end && e > h.start);

  const fuzzy: NameHit[] = [];
  const maxK = Math.max(0, ...index.tokenCounts) + 1;
  for (let k = 1; k <= maxK; k++) {
    for (let i = 0; i + k <= tokens.length; i++) {
      if (covered(i, i + k)) continue;
      const gram = tokens.slice(i, i + k);
      const key = gram.join(" ");
      if (index.rejections.has(key)) continue;

      // Same number of words: per-word typo rules.
      if (!(k === 1 && key.length < 6)) {
        const candidates = new Set<number>();
        for (const t of gram) for (const dk of deletionKeys(t)) for (const idx of index.tokenKeys.get(dk) ?? []) candidates.add(idx);
        for (const idx of candidates) {
          const entry = index.entries[idx];
          if (entry.customerId === opts.exclude) continue;
          const score = fuzzyEntryMatch(gram, entry);
          if (score !== null) {
            fuzzy.push({ customerId: entry.customerId, observed: key, matched: entry.normalized, evidence: "E4", score, start: i, end: i + k });
          }
        }
      }
      // Words run together or split apart: "acmepackaging" vs "acme packaging".
      const compactKey = gram.join("");
      if (compactKey.length >= 6) {
        for (const entry of index.compact.get(compactKey) ?? []) {
          if (entry.generic || entry.tokens.length === k || entry.customerId === opts.exclude) continue;
          fuzzy.push({ customerId: entry.customerId, observed: key, matched: entry.normalized, evidence: "E4", score: 0.97, start: i, end: i + k });
        }
      }
    }
  }

  const exactCustomers = new Set(exact.filter((h) => h.evidence === "E3").map((h) => h.customerId));
  const keptFuzzy = fuzzy.filter(
    (h) =>
      !exactCustomers.has(h.customerId) &&
      ![...exactCustomers].some((c) => index.distinct.has(pairKey(c, h.customerId))),
  );

  // One best hit per customer.
  const best = new Map<string, NameHit>();
  const rank = (h: NameHit) => (h.evidence === "E3" ? 3 : h.evidence === "E3-generic" ? 2 : 1) * 10 + h.score;
  for (const h of [...exact, ...keptFuzzy]) {
    const cur = best.get(h.customerId);
    if (!cur || rank(h) > rank(cur)) best.set(h.customerId, h);
  }
  return [...best.values()].sort((a, b) => rank(b) - rank(a));
}

/** Evidence from one email address. Free-mail and Cirkla's own domain give none. */
export function matchAddress(index: MatcherIndex, rawAddress: string): AddressHit | null {
  const address = normalizeEmail(rawAddress);
  if (!address) return null;
  const domain = emailDomain(address);
  if (index.workspaceDomain && domain === index.workspaceDomain) return null;

  const byEmail = index.emails.get(address);
  if (byEmail) return { customerId: byEmail, address, evidence: "E1" };
  if (isFreemailDomain(domain)) return null;

  const byDomain = index.domains.get(domain);
  if (byDomain) return { customerId: byDomain.customerId, address, evidence: byDomain.shared ? "E2-shared" : "E2" };

  // Look-alike: the domain's first label resembles a customer name ("acmepack" for "Acme Pack").
  const label = domain.split(".")[0].replace(/-/g, "");
  if (label.length >= 5) {
    for (const e of index.entries) {
      if (e.generic || e.compact.length < 5) continue;
      if (editDistance(label, e.compact, 1) <= 1) return { customerId: e.customerId, address, evidence: "E5" };
    }
  }
  return null;
}

/**
 * Combines evidence for one item (a message, or one line in the name checker)
 * into link / review / none. See the decision table in the design doc.
 */
export function decide(nameHits: NameHit[], addressHits: AddressHit[] = []): Decision {
  const customers = new Set<string>([...nameHits.map((h) => h.customerId), ...addressHits.map((h) => h.customerId)]);
  const ids = [...customers];
  const base = { rulesVersion: RULES_VERSION, customerIds: ids };
  if (ids.length === 0) return { ...base, outcome: "none", reason: "no customer evidence" };
  if (ids.length > 1) return { ...base, outcome: "review", reason: "more than one customer matched" };

  const strongAddress = addressHits.some((h) => h.evidence === "E1" || h.evidence === "E2");
  if (strongAddress) {
    const ev = addressHits.find((h) => h.evidence === "E1") ? "approved address" : "verified customer domain";
    return { ...base, outcome: "link", reason: ev };
  }
  if (nameHits.some((h) => h.evidence === "E3")) return { ...base, outcome: "link", reason: "exact customer name or approved alias" };
  if (nameHits.some((h) => h.evidence === "E3-generic")) return { ...base, outcome: "review", reason: "name is too generic to link alone" };
  if (nameHits.some((h) => h.evidence === "E4")) return { ...base, outcome: "review", reason: "possible spelling variation" };
  if (addressHits.some((h) => h.evidence === "E2-shared")) return { ...base, outcome: "review", reason: "shared domain" };
  return { ...base, outcome: "review", reason: "domain resembles a customer name" };
}

/** Convenience for the name checker: one line of text or one email address. */
export function checkLine(index: MatcherIndex, line: string): { decision: Decision; names: NameHit[]; address: AddressHit | null } {
  const trimmed = line.trim();
  const looksLikeEmail = /^[^@\s]+@[^@\s]+$/.test(trimmed);
  const address = looksLikeEmail ? matchAddress(index, trimmed) : null;
  const names = looksLikeEmail ? [] : findNames(index, trimmed);
  return { decision: decide(names, address ? [address] : []), names, address };
}

export { normalizeName };
