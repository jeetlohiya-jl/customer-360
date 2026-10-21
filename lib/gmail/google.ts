/**
 * Google OAuth + Gmail API calls for the Gmail connection proof of concept.
 *
 * - The default Gmail permission is gmail.metadata (headers and labels; never
 *   message bodies). See GMAIL_SCOPE. gmail.readonly (Stage B content access)
 *   is requested ONLY when GMAIL_CONTENT_ACCESS=on (off by default; turning it
 *   on is an approval step). See requestedScope() in connection.ts.
 * - Authorization-code flow with PKCE (S256) and a state value.
 * - access_type=offline + prompt=consent so Google returns a refresh token on
 *   every connect (needed to fetch again later and to prove revocation).
 * - All functions take `fetchImpl` so tests can run without network access.
 * - Nothing here logs tokens or message content.
 */
import { createHash } from "node:crypto";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
/** Stage B only, behind GMAIL_CONTENT_ACCESS=on. Requested alone: with gmail.metadata also present, Google limits the token to metadata. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const MAX_MESSAGES = 5;

type Fetch = typeof fetch;

export class GmailError extends Error {
  constructor(
    public readonly code:
      | "token_exchange_failed"
      | "no_refresh_token"
      | "scope_not_granted"
      | "revoked"
      | "gmail_api_error",
    public readonly httpStatus?: number,
    /** Google's machine-readable error code (e.g. invalid_client, SERVICE_DISABLED). Never a message or value. */
    public readonly reason?: string,
  ) {
    super(code);
    this.name = "GmailError";
  }
}

/** Keep only short enum-like error codes from Google responses; drop anything else. */
export function safeReason(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z_]{1,40}$/.test(v) ? v : undefined;
}

async function oauthErrorReason(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return safeReason(body.error);
}

async function apiErrorReason(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { status?: unknown; details?: Array<{ reason?: unknown }>; errors?: Array<{ reason?: unknown }> };
  };
  const e = body.error;
  return safeReason(e?.details?.find((d) => d?.reason)?.reason) ?? safeReason(e?.errors?.[0]?.reason) ?? safeReason(e?.status);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  loginHint: string;
  hostedDomain: string;
  scope?: typeof GMAIL_SCOPE | typeof GMAIL_READONLY_SCOPE;
}): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", opts.scope ?? GMAIL_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", pkceChallenge(opts.codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("login_hint", opts.loginHint);
  u.searchParams.set("hd", opts.hostedDomain);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
}

export async function exchangeCode(
  opts: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string; expectedScope?: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new GmailError("token_exchange_failed", res.status, await oauthErrorReason(res));
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!body.access_token) throw new GmailError("token_exchange_failed", res.status);
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(opts.expectedScope ?? GMAIL_SCOPE)) throw new GmailError("scope_not_granted");
  if (!body.refresh_token) throw new GmailError("no_refresh_token");
  return { accessToken: body.access_token, refreshToken: body.refresh_token, scopes };
}

export async function refreshAccessToken(
  opts: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
    cache: "no-store",
  });
  if (res.status === 400 || res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") throw new GmailError("revoked", res.status);
  }
  if (!res.ok) throw new GmailError("token_exchange_failed", res.status);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new GmailError("token_exchange_failed", res.status);
  return body.access_token;
}

/** Revokes a refresh (or access) token at Google. Returns true if Google confirmed. */
export async function revokeToken(token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    cache: "no-store",
  });
  // 400 invalid_token means it was already revoked/expired: treat as done.
  return res.ok || res.status === 400;
}

async function gmailGet<T>(path: string, accessToken: string, fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new GmailError("revoked", 401, await apiErrorReason(res));
  if (!res.ok) throw new GmailError("gmail_api_error", res.status, await apiErrorReason(res));
  return (await res.json()) as T;
}

/** Mailbox identity as reported by Gmail itself (not by the user). */
export async function getMailboxAddress(accessToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  const p = await gmailGet<{ emailAddress?: string }>("/profile", accessToken, fetchImpl);
  if (!p.emailAddress) throw new GmailError("gmail_api_error");
  return p.emailAddress.trim().toLowerCase();
}

export interface MessageSummary {
  id: string;
  subject: string;
  from: string;
  date: string; // ISO timestamp from Gmail's internalDate
}

type GmailHeader = { name: string; value: string };
type GmailMessage = { id: string; internalDate?: string; payload?: { headers?: GmailHeader[] } };

export function summarize(m: GmailMessage): MessageSummary {
  const header = (name: string) =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const ms = Number(m.internalDate);
  return {
    id: m.id,
    subject: clip(header("Subject") || "(no subject)", 200),
    from: clip(header("From") || "(unknown sender)", 200),
    date: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
  };
}

/**
 * Lists at most MAX_MESSAGES recent messages and reads only the Subject, From
 * and Date headers of each (format=metadata). Requests run in parallel.
 */
export async function listRecentMessages(
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<{ messages: MessageSummary[]; elapsedMs: number }> {
  const started = Date.now();
  const list = await gmailGet<{ messages?: { id: string }[] }>(
    `/messages?maxResults=${MAX_MESSAGES}`,
    accessToken,
    fetchImpl,
  );
  const ids = (list.messages ?? []).slice(0, MAX_MESSAGES).map((m) => m.id);
  const headers = ["Subject", "From", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const full = await Promise.all(
    ids.map((id) =>
      gmailGet<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=metadata&${headers}`, accessToken, fetchImpl),
    ),
  );
  return { messages: full.map(summarize), elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Stage 3.1 header scan. Still gmail.metadata only: message IDs, labels and a
// fixed list of headers. No bodies, snippets or attachments are requested.
// ---------------------------------------------------------------------------

export const SCAN_PAGE_SIZE = 250;
export const SCAN_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Sensitivity", "List-Unsubscribe"] as const;

export interface MessageRef {
  id: string;
  threadId?: string;
}

export interface MessageHeaders {
  id: string;
  threadId?: string;
  labelIds: string[];
  internalDate: number;
  headers: Record<string, string>;
}

/** One page of message IDs, newest first. Spam and trash are not included. */
export async function listMessageIds(
  accessToken: string,
  pageToken: string | null,
  fetchImpl: Fetch = fetch,
): Promise<{ messages: MessageRef[]; nextPageToken: string | null }> {
  const qs = new URLSearchParams({ maxResults: String(SCAN_PAGE_SIZE), includeSpamTrash: "false" });
  if (pageToken) qs.set("pageToken", pageToken);
  const r = await gmailGet<{ messages?: MessageRef[]; nextPageToken?: string }>(`/messages?${qs}`, accessToken, fetchImpl);
  return { messages: r.messages ?? [], nextPageToken: r.nextPageToken ?? null };
}

/** Headers and labels of one message (format=metadata, named headers only). */
export async function getMessageHeaders(accessToken: string, id: string, fetchImpl: Fetch = fetch): Promise<MessageHeaders> {
  const qs = new URLSearchParams({ format: "metadata" });
  for (const h of SCAN_HEADERS) qs.append("metadataHeaders", h);
  const m = await gmailGet<GmailMessage & { threadId?: string; labelIds?: string[] }>(
    `/messages/${encodeURIComponent(id)}?${qs}`,
    accessToken,
    fetchImpl,
  );
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const key = h.name.toLowerCase();
    if ((SCAN_HEADERS as readonly string[]).some((s) => s.toLowerCase() === key) && !(key in headers)) headers[key] = h.value;
  }
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], internalDate: Number(m.internalDate ?? 0), headers };
}

/** One MIME part of a message (format=full). Attachment data is never included by Gmail; only an attachmentId. */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface FullMessage {
  id: string;
  threadId?: string;
  labelIds: string[];
  internalDate: number;
  payload: GmailPart;
}

/**
 * Stage B (behind FEATURE_EXTRACT, off): the full message for ONE message ID
 * that the database handed out as customer-linked. Needs gmail.readonly, which
 * is requested only when GMAIL_CONTENT_ACCESS=on; with gmail.metadata Google
 * refuses this call. Only the extraction route uses it (guard test).
 */
export async function getMessageFull(accessToken: string, id: string, fetchImpl: Fetch = fetch): Promise<FullMessage> {
  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) throw new GmailError("gmail_api_error", 400, "bad_message_id");
  const m = await gmailGet<{ id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }>(
    `/messages/${encodeURIComponent(id)}?format=full`,
    accessToken,
    fetchImpl,
  );
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], internalDate: Number(m.internalDate ?? 0), payload: m.payload ?? {} };
}

/** Label names and IDs (to honour an employee's own exclude label). */
export async function listLabels(accessToken: string, fetchImpl: Fetch = fetch): Promise<{ id: string; name: string }[]> {
  const r = await gmailGet<{ labels?: { id: string; name: string }[] }>("/labels", accessToken, fetchImpl);
  return r.labels ?? [];
}

/** Gmail reports per-user rate limits as 403 with one of these reasons (as well as 429). */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);

/** True for Gmail's "slow down" answers: 429, or 403 with a rate-limit reason. Not for permission errors. */
export function isRateLimited(e: unknown): boolean {
  return e instanceof GmailError && e.code === "gmail_api_error" && (e.httpStatus === 429 || (e.httpStatus === 403 && RATE_LIMIT_REASONS.has(e.reason ?? "")));
}

/** Retries rate limits and server errors with exponential backoff. Never retries a revoked token. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof GmailError && e.code === "gmail_api_error" && (e.httpStatus === 429 || (e.httpStatus ?? 0) >= 500 || isRateLimited(e));
      if (!retryable || attempt >= tries) throw e;
      await sleep((opts.baseMs ?? 500) * 2 ** (attempt - 1));
    }
  }
}

/** Associated data that binds an encrypted refresh token to its owner. */
export const gmailTokenContext = (userId: string) => `gmail-refresh-token:${userId}`;

// ---------------------------------------------------------------------------
// Sync (0011): Gmail push notifications and the history of changes. Still
// gmail.metadata-compatible: these calls return ids, labels and history ids only.
// ---------------------------------------------------------------------------

async function gmailPost<T>(path: string, accessToken: string, body: unknown, fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(`${GMAIL_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (res.status === 401) throw new GmailError("revoked", 401, await apiErrorReason(res));
  if (!res.ok) throw new GmailError("gmail_api_error", res.status, await apiErrorReason(res));
  return (await res.json()) as T;
}

const HISTORY_ID = /^[0-9]{1,20}$/;

/**
 * Asks Gmail to notify the Pub/Sub topic when new mail arrives in Inbox or Sent.
 * Gmail keeps the watch for 7 days; it is renewed well before then.
 */
export async function watchMailbox(
  accessToken: string,
  topicName: string,
  fetchImpl: Fetch = fetch,
): Promise<{ historyId: string; expiration: string }> {
  const r = await gmailPost<{ historyId?: string; expiration?: string }>(
    "/watch",
    accessToken,
    { topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "INCLUDE" },
    fetchImpl,
  );
  const ms = Number(r.expiration);
  if (!r.historyId || !HISTORY_ID.test(r.historyId) || !Number.isFinite(ms)) throw new GmailError("gmail_api_error", 200, "bad_watch_reply");
  return { historyId: r.historyId, expiration: new Date(ms).toISOString() };
}

/** The mailbox's current history id: where a catch-up hands over to live sync. */
export async function getHistoryId(accessToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  const p = await gmailGet<{ historyId?: string }>("/profile", accessToken, fetchImpl);
  if (!p.historyId || !HISTORY_ID.test(p.historyId)) throw new GmailError("gmail_api_error", 200, "bad_profile_reply");
  return p.historyId;
}

/**
 * One page of messages added since a history id. Gmail answers 404 when the
 * id is too old (about a week); the caller then falls back to a catch-up.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken: string | null,
  fetchImpl: Fetch = fetch,
): Promise<{ messages: MessageRef[]; historyId: string; nextPageToken: string | null }> {
  if (!HISTORY_ID.test(startHistoryId)) throw new GmailError("gmail_api_error", 400, "bad_history_id");
  const qs = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
  if (pageToken) qs.set("pageToken", pageToken);
  const r = await gmailGet<{ history?: { messagesAdded?: { message?: MessageRef & { labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string }>(
    `/history?${qs}`,
    accessToken,
    fetchImpl,
  );
  const messages: MessageRef[] = [];
  for (const h of r.history ?? []) {
    for (const a of h.messagesAdded ?? []) {
      const m = a.message;
      if (m?.id && !(m.labelIds ?? []).some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH")) messages.push({ id: m.id, threadId: m.threadId });
    }
  }
  const historyId = r.historyId && HISTORY_ID.test(r.historyId) ? r.historyId : startHistoryId;
  return { messages, historyId, nextPageToken: r.nextPageToken ?? null };
}
