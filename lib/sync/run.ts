/**
 * Gmail sync worker: keeps approved mailboxes in step with new email after
 * their one-off scan. Triggered by Gmail push (one mailbox, at once) and by a
 * safety-net cron (anything dirty, stale for an hour, or whose watch needs
 * renewing). Header data only; the same matching and exclusion rules as the
 * scan (lib/scan/classify.ts). All I/O is injected. Logs counts and safe codes only.
 *
 * Per mailbox:
 *   1. renew Gmail's watch (push registration) when it expires within 2 days
 *   2a. catch-up (first run, or after a gap): newest-first pages back to the
 *       floor date, at most CATCHUP_PAGES per run, resumable
 *   2b. live: the messages added since the stored history id
 *   3. one commit: links + review items + new position (links feed extraction)
 */
import { GmailError, type MessageHeaders, type MessageRef } from "@/lib/gmail/google";
import { buildIndex, RULES_VERSION } from "@/lib/customers/matcher";
import { classifyMessage, EXCLUDE_LABEL_RE, parseAddresses, type LinkOut } from "@/lib/scan/classify";
import { errorCode, errorStage, inStage, StageError } from "@/lib/scan/errors";
import type { MasterSnapshot, ReviewPayload } from "@/lib/scan/worker";

export const CATCHUP_PAGES = 2;
export const MAX_LIVE_MESSAGES = 2000;
const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
const GAP_FLOOR_MS = 8 * 24 * 60 * 60 * 1000;

export interface SyncItem {
  owner_id: string;
  mailbox_email: string;
  history_id: string | null;
  catchup_history_id: string | null;
  catchup_page_token: string | null;
  floor_at: string;
  watch_expires_at: string | null;
}

export interface SyncState {
  history_id: string | null;
  catchup_history_id: string | null;
  catchup_page_token: string | null;
  floor_at?: string;
  watch_expires_at?: string;
  done: boolean;
}

export interface SyncDb {
  claim(limit: number, leaseSeconds: number, owner?: string): Promise<SyncItem[]>;
  token(ownerId: string): Promise<{ refresh_token_enc: string; key_version: number } | null>;
  customerMaster(): Promise<MasterSnapshot>;
  commit(ownerId: string, state: SyncState, links: LinkOut[], reviews: ReviewPayload[], processed: number): Promise<void>;
  fail(ownerId: string, code: string): Promise<void>;
}

export interface SyncGmail {
  accessToken(refreshToken: string): Promise<string>;
  listLabels(accessToken: string): Promise<{ id: string; name: string }[]>;
  listIds(accessToken: string, pageToken: string | null): Promise<{ messages: MessageRef[]; nextPageToken: string | null }>;
  listHistory(accessToken: string, startHistoryId: string, pageToken: string | null): Promise<{ messages: MessageRef[]; historyId: string; nextPageToken: string | null }>;
  getHeaders(accessToken: string, id: string): Promise<MessageHeaders>;
  getHistoryId(accessToken: string): Promise<string>;
  watch(accessToken: string): Promise<{ historyId: string; expiration: string }>;
}

export interface SyncDeps {
  db: SyncDb;
  gmail: SyncGmail;
  decrypt(enc: string, keyVersion: number, ownerId: string): string;
  owner?: string;
  limit?: number;
  concurrency?: number;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

export interface SyncSummary {
  mailboxes: number;
  synced: number;
  failed: number;
  processed: number;
  links: number;
  watches_renewed: number;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function runSyncTick(deps: SyncDeps): Promise<SyncSummary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const sum: SyncSummary = { mailboxes: 0, synced: 0, failed: 0, processed: 0, links: 0, watches_renewed: 0 };
  const items = await inStage("db_claim", () => deps.db.claim(deps.limit ?? 5, 240, deps.owner));
  sum.mailboxes = items.length;
  if (items.length === 0) return sum;
  let master: MasterSnapshot | null = null;

  for (const item of items) {
    try {
      const tok = await inStage("db_token", () => deps.db.token(item.owner_id));
      if (!tok) throw new StageError("db_token", new Error("no_token"));
      const refresh = await inStage("decrypt", () => deps.decrypt(tok.refresh_token_enc, tok.key_version, item.owner_id));
      const at = await inStage("gmail_auth", () => deps.gmail.accessToken(refresh));
      master ??= await inStage("db_master", () => deps.db.customerMaster());
      const index = buildIndex({
        customers: master.customers.map((c) => ({ id: c.id, canonicalName: c.canonical_name, status: c.status, names: c.names, domains: c.domains, emails: c.emails })),
        distinctions: master.distinctions,
        rejections: master.rejections,
        workspaceDomain: master.workspace_domain,
      });
      const labels = await inStage("gmail_labels", () => deps.gmail.listLabels(at));
      const ctx = {
        ownerEmail: item.mailbox_email,
        workspaceDomain: master.workspace_domain,
        cutoffMs: Number.MAX_SAFE_INTEGER,
        excludeLabelIds: new Set(labels.filter((l) => EXCLUDE_LABEL_RE.test(l.name)).map((l) => l.id)),
      };

      // 1. Keep the push registration alive.
      let watchExpires: string | undefined;
      if (!item.watch_expires_at || Date.parse(item.watch_expires_at) - now() < RENEW_BEFORE_MS) {
        watchExpires = (await inStage("gmail_watch", () => deps.gmail.watch(at))).expiration;
        sum.watches_renewed++;
      }

      const links: LinkOut[] = [];
      const reviews = new Map<string, ReviewPayload>();
      let processed = 0;
      const handle = async (ids: MessageRef[], floorMs: number): Promise<boolean> => {
        let reachedFloor = false;
        await mapLimit(ids, deps.concurrency ?? 10, async (ref) => {
          const msg = await inStage("gmail_get", () => deps.gmail.getHeaders(at, ref.id));
          if (msg.internalDate < floorMs) {
            reachedFloor = true;
            return;
          }
          processed++;
          const out = classifyMessage(msg, index, ctx);
          links.push(...out.links);
          for (const r of out.reviews) {
            const cur = reviews.get(r.observed) ?? { ...r, messages: [] };
            cur.messages.push({
              gmail_message_id: msg.id,
              gmail_thread_id: msg.threadId ?? null,
              message_at: new Date(msg.internalDate).toISOString(),
              direction: parseAddresses(msg.headers["from"])[0]?.email === item.mailbox_email.toLowerCase() ? "outbound" : "inbound",
            });
            reviews.set(r.observed, cur);
          }
        });
        return reachedFloor;
      };

      let state: SyncState;
      if (item.history_id === null) {
        // 2a. Catch-up: newest first, back to the floor. Live sync then starts from
        // the history id recorded when the catch-up began, so nothing is missed.
        const start = item.catchup_history_id ?? (await inStage("gmail_profile", () => deps.gmail.getHistoryId(at)));
        let pageToken = item.catchup_page_token;
        let done = false;
        for (let p = 0; p < CATCHUP_PAGES && !done; p++) {
          const page = await inStage("gmail_list", () => deps.gmail.listIds(at, pageToken));
          const reached = await handle(page.messages, Date.parse(item.floor_at));
          pageToken = page.nextPageToken;
          done = reached || pageToken === null;
        }
        state = done
          ? { history_id: start, catchup_history_id: null, catchup_page_token: null, done: true }
          : { history_id: null, catchup_history_id: start, catchup_page_token: pageToken, done: false };
      } else {
        // 2b. Live: what was added since the stored history id.
        const ids = new Map<string, MessageRef>();
        let pageToken: string | null = null;
        let latest = item.history_id;
        let gap = false;
        try {
          do {
            const h = await inStage("gmail_history", () => deps.gmail.listHistory(at, item.history_id!, pageToken));
            for (const m of h.messages) ids.set(m.id, m);
            latest = h.historyId;
            pageToken = h.nextPageToken;
            if (ids.size > MAX_LIVE_MESSAGES) gap = true;
          } while (pageToken && !gap);
        } catch (e) {
          const inner = e instanceof StageError ? e.cause : e;
          if (inner instanceof GmailError && inner.httpStatus === 404) gap = true; // history id too old
          else throw e;
        }
        if (gap) {
          // Too much or too old to replay: catch up from 8 days back instead (links are unique, so overlap is harmless).
          state = { history_id: null, catchup_history_id: null, catchup_page_token: null, floor_at: new Date(now() - GAP_FLOOR_MS).toISOString(), done: false };
          log({ event: "sync_gap", reason: ids.size > MAX_LIVE_MESSAGES ? "too_many" : "history_expired" });
        } else {
          await handle([...ids.values()], 0);
          state = { history_id: latest, catchup_history_id: null, catchup_page_token: null, done: true };
        }
      }
      if (watchExpires) state.watch_expires_at = watchExpires;

      await inStage("db_commit", () => deps.db.commit(item.owner_id, state, links, [...reviews.values()], processed));
      sum.synced++;
      sum.processed += processed;
      sum.links += links.length;
    } catch (e) {
      const inner = e instanceof StageError ? e.cause : e;
      const code = (inner instanceof GmailError && inner.code === "revoked" ? "gmail_auth:revoked" : `${errorStage(e)}:${errorCode(e)}`).slice(0, 64);
      await deps.db.fail(item.owner_id, code).catch(() => undefined);
      sum.failed++;
      log({ event: "sync_mailbox_failed", stage: errorStage(e), code });
    }
  }
  log({ event: "sync_tick", ...sum });
  return sum;
}

export { RULES_VERSION };
