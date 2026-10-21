import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Verifies the OIDC token Google Pub/Sub attaches to every push request
 * (Authorization: Bearer <JWT>, RS256, signed by Google). The token must be
 * for our push URL (audience), from the configured service account, and
 * current. https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

type Jwk = JsonWebKey & { kid?: string; alg?: string };
type Fetch = typeof fetch;

let cache: { keys: Jwk[]; until: number } | null = null;

export async function googleKeys(fetchImpl: Fetch = fetch, now = Date.now()): Promise<Jwk[]> {
  if (cache && cache.until > now) return cache.keys;
  const res = await fetchImpl(GOOGLE_CERTS_URL, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error("certs_unavailable");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = (body.keys ?? []).filter((k) => k.kty === "RSA" && typeof k.kid === "string");
  cache = { keys, until: now + 60 * 60 * 1000 };
  return keys;
}

/** For tests: forget cached keys. */
export function resetKeyCache() {
  cache = null;
}

const b64json = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

export async function verifyPushToken(
  authorization: string | null,
  expect: { audience: string; email: string },
  getKeys: () => Promise<Jwk[]> = () => googleKeys(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) return false;
  const [, h, p, sig] = m;
  const header = b64json(h);
  const claims = b64json(p);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;
  const key = (await getKeys()).find((k) => k.kid === header.kid);
  if (!key) return false;
  let ok = false;
  try {
    ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key, format: "jwk" }), Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
  if (!ok) return false;
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  return (
    ISSUERS.has(String(claims.iss)) &&
    claims.aud === expect.audience &&
    claims.email === expect.email &&
    claims.email_verified === true &&
    Number.isFinite(exp) && exp > nowSeconds - 30 &&
    Number.isFinite(iat) && iat < nowSeconds + 300
  );
}

/** The Gmail notification inside a Pub/Sub push body: the mailbox and its new history id. */
export function parsePush(body: unknown): { emailAddress: string; historyId: string } | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string" || data.length > 2000) return null;
  try {
    const n = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { emailAddress?: unknown; historyId?: unknown };
    const email = typeof n.emailAddress === "string" ? n.emailAddress.trim().toLowerCase() : "";
    const hid = typeof n.historyId === "number" || typeof n.historyId === "string" ? String(n.historyId) : "";
    if (!/^[^@\s]{1,64}@[^@\s]{1,253}$/.test(email) || !/^[0-9]{1,20}$/.test(hid)) return null;
    return { emailAddress: email, historyId: hid };
  } catch {
    return null;
  }
}
