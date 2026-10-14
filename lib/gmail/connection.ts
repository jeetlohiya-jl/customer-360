import "server-only";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret, randomToken, signValue, verifySignedValue, safeEqual } from "@/lib/security/crypto";
import {
  GmailError,
  GMAIL_READONLY_SCOPE,
  GMAIL_SCOPE,
  buildAuthUrl,
  exchangeCode,
  getMailboxAddress,
  gmailTokenContext,
  listRecentMessages,
  refreshAccessToken,
  revokeToken,
  type MessageSummary,
} from "@/lib/gmail/google";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Gmail connection service. Every operation is scoped to the signed-in user:
 * database calls run with that user's session through functions that only act
 * on auth.uid(), and tokens are encrypted with the user id bound in.
 */

export const OAUTH_COOKIE = "c360_gmail_oauth";
const OAUTH_COOKIE_PATH = "/api/oauth/gmail";
const STATE_TTL_MS = 10 * 60 * 1000;

type GmailEnv = ServerEnv & {
  GOOGLE_GMAIL_CLIENT_ID: string;
  GOOGLE_GMAIL_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
};

/**
 * The Gmail permission to request. gmail.readonly only when GMAIL_CONTENT_ACCESS
 * is exactly "on" (approval step); anything else keeps header-only access.
 */
export function requestedScope(env: { GMAIL_CONTENT_ACCESS?: string }): typeof GMAIL_SCOPE | typeof GMAIL_READONLY_SCOPE {
  return env.GMAIL_CONTENT_ACCESS === "on" ? GMAIL_READONLY_SCOPE : GMAIL_SCOPE;
}

export function gmailEnv(): GmailEnv | null {
  const env = getServerEnv();
  if (env.FEATURE_GMAIL !== "on") return null;
  return env as GmailEnv;
}

export const redirectUri = (env: ServerEnv) => `${env.APP_BASE_URL}/api/oauth/gmail/callback`;
const tokenContext = gmailTokenContext;

interface OAuthCookie {
  s: string; // state
  v: string; // PKCE verifier
  u: string; // user id that started the flow
  e: number; // expiry (ms)
}

/** Creates the Google consent URL and the signed, short-lived state cookie. */
export function beginAuthorization(user: CurrentUser, env: GmailEnv) {
  const payload: OAuthCookie = { s: randomToken(32), v: randomToken(48), u: user.id, e: Date.now() + STATE_TTL_MS };
  return {
    url: buildAuthUrl({
      clientId: env.GOOGLE_GMAIL_CLIENT_ID,
      redirectUri: redirectUri(env),
      state: payload.s,
      codeVerifier: payload.v,
      loginHint: user.email,
      hostedDomain: env.WORKSPACE_DOMAIN,
      scope: requestedScope(env),
    }),
    cookie: {
      name: OAUTH_COOKIE,
      value: signValue(payload, env.TOKEN_ENCRYPTION_KEY),
      options: {
        httpOnly: true,
        secure: env.APP_BASE_URL.startsWith("https://"),
        sameSite: "lax" as const,
        path: OAUTH_COOKIE_PATH,
        maxAge: STATE_TTL_MS / 1000,
      },
    },
  };
}

/** Diagnostic log for a failed step: step name, HTTP status and Google's error code only. */
function logFailure(step: "token" | "profile", e: unknown) {
  const g = e instanceof GmailError ? e : undefined;
  console.warn(
    JSON.stringify({ event: "gmail_callback_detail", step, status: g?.httpStatus ?? null, reason: g?.reason ?? (g ? g.code : "network") }),
  );
}

export type CallbackResult =
  | "connected"
  | "denied"
  | "invalid_state"
  | "token_exchange_failed"
  | "no_refresh_token"
  | "scope_not_granted"
  | "mailbox_mismatch"
  | "store_failed";

/** Validates the callback and stores the encrypted refresh token. */
export async function completeAuthorization(
  user: CurrentUser,
  env: GmailEnv,
  params: { code: string | null; state: string | null; error: string | null },
  cookieValue: string | undefined,
): Promise<CallbackResult> {
  if (params.error) return "denied";

  const saved = cookieValue ? verifySignedValue<OAuthCookie>(cookieValue, env.TOKEN_ENCRYPTION_KEY) : null;
  if (
    !saved ||
    !params.state ||
    !params.code ||
    saved.e < Date.now() ||
    saved.u !== user.id ||
    !safeEqual(saved.s, params.state)
  ) {
    return "invalid_state";
  }

  let tokens;
  try {
    tokens = await exchangeCode({
      code: params.code,
      codeVerifier: saved.v,
      clientId: env.GOOGLE_GMAIL_CLIENT_ID,
      clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET,
      redirectUri: redirectUri(env),
      expectedScope: requestedScope(env),
    });
  } catch (e) {
    if (e instanceof GmailError && (e.code === "no_refresh_token" || e.code === "scope_not_granted")) return e.code;
    logFailure("token", e);
    return "token_exchange_failed";
  }
  const refreshToken = tokens.refreshToken as string;

  // Identify the mailbox through Gmail itself, never from user input.
  let mailbox: string;
  try {
    mailbox = await getMailboxAddress(tokens.accessToken);
  } catch (e) {
    logFailure("profile", e);
    await revokeToken(refreshToken).catch(() => false);
    return "token_exchange_failed";
  }
  if (mailbox !== user.email.toLowerCase()) {
    await revokeToken(refreshToken).catch(() => false);
    return "mailbox_mismatch";
  }

  const keyVersion = env.TOKEN_ENCRYPTION_KEY_VERSION;
  const encrypted = encryptSecret(refreshToken, env.TOKEN_ENCRYPTION_KEY, keyVersion, tokenContext(user.id));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("connect_gmail", {
    p_mailbox_email: mailbox,
    p_refresh_token_enc: encrypted,
    p_key_version: keyVersion,
    p_scopes: tokens.scopes,
  });
  if (error) {
    await revokeToken(refreshToken).catch(() => false);
    return "store_failed";
  }
  return "connected";
}

export type GmailPanel =
  | { state: "disabled" }
  | { state: "not_connected" }
  | { state: "revoked"; mailbox: string }
  | { state: "error"; mailbox: string; code: string }
  | {
      state: "connected";
      mailbox: string;
      connectedAt: string;
      /** Gmail permissions this connection holds (from the database). */
      scopes: string[];
      messages: MessageSummary[];
      elapsedMs: number;
      fetchedAt: string;
    };

async function loadRefreshToken(user: CurrentUser, env: GmailEnv): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc("my_gmail_token");
  const row = (data as { refresh_token_enc: string; key_version: number }[] | null)?.[0];
  if (!row) return null;
  return decryptSecret(row.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY, row.key_version, tokenContext(user.id));
}

/** Connection status plus up to five recent messages (headers only, not stored). */
export async function loadGmailPanel(user: CurrentUser): Promise<GmailPanel> {
  const env = gmailEnv();
  if (!env) return { state: "disabled" };

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc("my_gmail_connection");
  const conn = (data as { mailbox_email: string; status: string; connected_at: string; scopes: string[] | null }[] | null)?.[0];
  if (!conn) return { state: "not_connected" };
  if (conn.status === "revoked") return { state: "revoked", mailbox: conn.mailbox_email };

  try {
    const refreshToken = await loadRefreshToken(user, env);
    if (!refreshToken) return { state: "not_connected" };
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.GOOGLE_GMAIL_CLIENT_ID,
      clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET,
    });
    const { messages, elapsedMs } = await listRecentMessages(accessToken);
    console.info(JSON.stringify({ event: "gmail_fetch_ok", count: messages.length, elapsedMs }));
    return {
      state: "connected",
      mailbox: conn.mailbox_email,
      connectedAt: conn.connected_at,
      scopes: conn.scopes ?? [],
      messages,
      elapsedMs,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    const code = e instanceof GmailError ? e.code : "decrypt_or_unknown_error";
    console.warn(JSON.stringify({ event: "gmail_fetch_failed", code }));
    if (code === "revoked") {
      await supabase.rpc("mark_my_gmail_revoked");
      return { state: "revoked", mailbox: conn.mailbox_email };
    }
    return { state: "error", mailbox: conn.mailbox_email, code };
  }
}

/** Revokes the authorization at Google, then deletes the stored token. */
export async function disconnect(user: CurrentUser): Promise<boolean> {
  const env = gmailEnv();
  const supabase = await createSupabaseServerClient();
  let revoked = false;
  if (env) {
    try {
      const token = await loadRefreshToken(user, env);
      if (token) revoked = await revokeToken(token);
    } catch {
      revoked = false;
    }
  }
  await supabase.rpc("disconnect_gmail", { p_revoked_at_google: revoked });
  console.info(JSON.stringify({ event: "gmail_disconnected", revokedAtGoogle: revoked }));
  return revoked;
}
