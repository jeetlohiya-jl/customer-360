import "server-only";
import { getServerEnv } from "@/lib/env";
import {
  getHistoryId, getMessageHeaders, getThreadHeaders, gmailTokenContext, listHistory, listLabels, listMessageIds, refreshAccessToken, watchMailbox, withRetry,
} from "@/lib/gmail/google";
import { decryptSecret } from "@/lib/security/crypto";
import type { SyncConfig } from "./config";
import type { SyncGmail } from "./run";

/** Real Gmail calls and token decryption for the sync worker, or null when Gmail settings are missing. */
export function syncIo(cfg: Extract<SyncConfig, { enabled: true }>): { gmail: SyncGmail; decrypt: (enc: string, v: number, owner: string) => string } | null {
  const env = getServerEnv();
  const { GOOGLE_GMAIL_CLIENT_ID: clientId, GOOGLE_GMAIL_CLIENT_SECRET: clientSecret, TOKEN_ENCRYPTION_KEY: key } = env;
  if (!clientId || !clientSecret || !key) return null;
  return {
    decrypt: (enc, version, ownerId) => decryptSecret(enc, key, version, gmailTokenContext(ownerId)),
    gmail: {
      accessToken: (refreshToken) => refreshAccessToken({ refreshToken, clientId, clientSecret }),
      listLabels: (at) => withRetry(() => listLabels(at)),
      listIds: (at, pageToken) => withRetry(() => listMessageIds(at, pageToken)),
      listHistory: (at, start, pageToken) => withRetry(() => listHistory(at, start, pageToken)),
      getHeaders: (at, id) => withRetry(() => getMessageHeaders(at, id)),
      getThread: (at, threadId) => withRetry(() => getThreadHeaders(at, threadId)),
      getHistoryId: (at) => withRetry(() => getHistoryId(at)),
      watch: (at) => withRetry(() => watchMailbox(at, cfg.topic)),
    },
  };
}
