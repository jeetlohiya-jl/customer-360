/**
 * Name, domain and email normalization for customer matching.
 *
 * IMPORTANT: normalizeName() must give exactly the same result as the SQL
 * function private.normalize_name() (migration 20261013000005). Both are
 * checked against tests/fixtures/normalize-cases.json, so a change to one
 * without the other fails the tests.
 */

/** Single-word legal suffixes removed from the END of a name (repeatedly). */
export const LEGAL_SUFFIXES: readonly string[] = [
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "pvt", "private", "plc", "gmbh", "llp", "lp", "pte", "pty", "srl", "spa", "bv", "nv",
  "ag", "sa", "sarl", "oy", "kk",
];

/** Suffixes written with dots (L.L.C., S.A.) become single letters after normalizing. */
export const SPLIT_SUFFIXES: readonly (readonly string[])[] = [
  ["l", "l", "c"], ["l", "l", "p"], ["p", "l", "c"], ["l", "t", "d"], ["p", "v", "t"], ["p", "t", "e"],
  ["s", "a"], ["b", "v"], ["n", "v"], ["a", "g"],
];

function endsWith(tokens: string[], suffix: readonly string[]): boolean {
  if (tokens.length <= suffix.length) return false; // always keep at least one word
  return suffix.every((s, i) => tokens[tokens.length - suffix.length + i] === s);
}

/**
 * "ACME Packaging, Ltd." -> "acme packaging"; "Café & Co" -> "cafe";
 * "McDonald's" -> "mcdonalds". Returns "" when nothing usable is left.
 */
export function normalizeName(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (s === "") return "";
  let tokens = s.split(" ");
  if (tokens.length > 1 && tokens[0] === "the") tokens = tokens.slice(1);

  for (;;) {
    const n = tokens.length;
    if (n <= 1) break;
    const last = tokens[n - 1];
    if (LEGAL_SUFFIXES.includes(last) || last === "and") {
      tokens = tokens.slice(0, n - 1);
      continue;
    }
    const split = SPLIT_SUFFIXES.find((suf) => endsWith(tokens, suf));
    if (split) {
      tokens = tokens.slice(0, n - split.length);
      continue;
    }
    break;
  }
  return tokens.join(" ");
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_LOCAL_RE = /^[^@\s]{1,64}$/;

/** "https://www.AcmePack.com/about" -> "acmepack.com". Returns null if not a valid domain. */
export function normalizeDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^@/, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

/** Lowercased, trimmed address, or null if not a valid email. */
export function normalizeEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!EMAIL_LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  return e;
}

/**
 * Free-mail providers: never accepted as a customer DOMAIN (a specific
 * approved address on them is allowed). Mirrored in SQL.
 */
export const FREEMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "zoho.com", "zohomail.com", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "rediffmail.com", "qq.com", "163.com",
];

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.includes(domain);
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Words common across business names; they carry little weight in matching. */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "packaging", "pack", "packs", "packers", "foods", "food", "group", "international", "intl", "industries",
  "industry", "enterprises", "enterprise", "solutions", "services", "service", "trading", "traders", "global",
  "holdings", "products", "product", "manufacturing", "mfg", "meats", "meat", "farms", "farm", "market",
  "markets", "supply", "supplies", "distribution", "distributors", "brands", "usa", "us", "america",
  "american", "india", "north", "south", "east", "west", "new", "and", "of", "fresh", "foodservice",
  "retail", "store", "stores", "wholesale", "partners", "systems", "technologies", "inc",
]);

export function isDistinctiveToken(token: string, extraGeneric?: ReadonlySet<string>): boolean {
  return token.length >= 3 && !GENERIC_WORDS.has(token) && !(extraGeneric?.has(token) ?? false);
}
