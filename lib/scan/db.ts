import "server-only";
import { Pool } from "pg";
import { followupItems } from "./threads";
import type { WorkerDb, ClaimedJob, MasterSnapshot } from "./worker";

/**
 * Worker database access through the dedicated c360_worker login (CS8). That
 * login has no table rights; it can only run the private.worker_* functions.
 * Each call is one statement, so each function runs in its own transaction.
 */
export function createWorkerDb(url: string, ca?: string): { db: WorkerDb; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });

  const db: WorkerDb = {
    async retentionCleanup() {
      const r = await pool.query<{ n: number }>("select private.worker_retention_cleanup() as n");
      return r.rows[0]?.n ?? 0;
    },
    async claimJob(leaseSeconds) {
      const r = await pool.query<ClaimedJob>(
        "select job_id, owner_id, mailbox_email, cutoff_at::text as cutoff_at, page_token, pages_done, rules_version from private.worker_claim_job($1)",
        [leaseSeconds],
      );
      return r.rows[0] ?? null;
    },
    async jobToken(jobId) {
      const r = await pool.query<{ refresh_token_enc: string; key_version: number }>(
        "select refresh_token_enc, key_version from private.worker_job_token($1)",
        [jobId],
      );
      return r.rows[0] ?? null;
    },
    async jobQuery(jobId) {
      const r = await pool.query<{ q: string | null }>("select private.worker_job_query($1) as q", [jobId]);
      return r.rows[0]?.q ?? null;
    },
    async customerMaster() {
      const r = await pool.query<{ m: MasterSnapshot }>("select private.worker_customer_master() as m");
      return r.rows[0].m;
    },
    async commitPage(a) {
      const r = await pool.query<{ s: string }>(
        "select private.worker_commit_page($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8) as s",
        [
          a.jobId,
          a.pageNo,
          a.nextPageToken,
          JSON.stringify(a.counts),
          // Thread follow-ups ride in the links list, marked and without a customer (0013).
          JSON.stringify([...a.links, ...followupItems(a.followups)]),
          JSON.stringify(a.reviews),
          JSON.stringify(a.failures),
          a.done,
        ],
      );
      return r.rows[0].s;
    },
    async authLost(jobId) {
      await pool.query("select private.worker_auth_lost($1)", [jobId]);
    },
    async release(jobId, code) {
      const r = await pool.query<{ s: string }>("select private.worker_release($1, $2) as s", [jobId, code]);
      return r.rows[0].s;
    },
  };
  return { db, close: () => pool.end() };
}
