import "server-only";
import { Pool } from "pg";
import { RULES_VERSION } from "@/lib/customers/matcher";
import type { MasterSnapshot } from "@/lib/scan/worker";
import type { SyncDb, SyncItem } from "./run";

/**
 * Sync worker database access through the c360_worker login, which can only
 * run the private.worker_sync_* functions (and the shared customer master).
 */
export function createSyncDb(url: string, ca?: string): { db: SyncDb & { push(mailbox: string, historyId: string): Promise<string | null> }; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  const db = {
    async push(mailbox: string, historyId: string) {
      const r = await pool.query<{ owner: string | null }>("select private.worker_sync_push($1, $2) as owner", [mailbox, historyId]);
      return r.rows[0]?.owner ?? null;
    },
    async claim(limit: number, leaseSeconds: number, owner?: string): Promise<SyncItem[]> {
      const r = await pool.query(
        "select owner_id, mailbox_email, history_id, catchup_history_id, catchup_page_token, floor_at, watch_expires_at from private.worker_sync_claim($1, $2, $3)",
        [limit, leaseSeconds, owner ?? null],
      );
      return r.rows.map((x) => ({ ...x, floor_at: ts(x.floor_at)!, watch_expires_at: ts(x.watch_expires_at) }));
    },
    async token(ownerId: string) {
      const r = await pool.query<{ refresh_token_enc: string; key_version: number }>(
        "select refresh_token_enc, key_version from private.worker_sync_token($1)",
        [ownerId],
      );
      return r.rows[0] ?? null;
    },
    async customerMaster() {
      const r = await pool.query<{ m: MasterSnapshot }>("select private.worker_customer_master() as m");
      return r.rows[0].m;
    },
    async commit(ownerId, state, links, reviews, processed) {
      await pool.query("select private.worker_sync_commit($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)", [
        ownerId,
        JSON.stringify(state),
        JSON.stringify(links),
        JSON.stringify(reviews),
        JSON.stringify({ processed }),
        RULES_VERSION,
      ]);
    },
    async fail(ownerId: string, code: string) {
      await pool.query("select private.worker_sync_fail($1, $2)", [ownerId, code]);
    },
  } satisfies SyncDb & { push(mailbox: string, historyId: string): Promise<string | null> };
  return { db, close: () => pool.end() };
}
