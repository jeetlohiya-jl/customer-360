import "server-only";
import { Pool } from "pg";
import type { ClaimedItem, ExtractDb, OpenFact } from "./run";
import { MODEL_ID, PROMPT_VERSION } from "./prompt";

/**
 * Extraction worker database access through the c360_worker login. That login
 * has no table rights; it can only run the private.worker_extract_* and
 * private.worker_budget_* functions.
 */
export function createExtractDb(url: string, ca?: string): { db: ExtractDb; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await pool.query(sql, params)).rows[0] as T | undefined;

  const db: ExtractDb = {
    async cleanup() {
      return (await one<{ n: number }>("select private.worker_extract_cleanup() as n", []))?.n ?? 0;
    },
    async claim(limit, leaseSeconds) {
      const r = await pool.query<ClaimedItem & { message_at: Date | string }>(
        "select owner_id, mailbox_email, gmail_message_id, gmail_thread_id, message_at, direction, customers from private.worker_extract_claim($1, $2)",
        [limit, leaseSeconds],
      );
      return r.rows.map((x) => ({ ...x, message_at: new Date(x.message_at).toISOString(), customers: x.customers ?? [] }));
    },
    async token(ownerId) {
      return (await one("select refresh_token_enc, key_version from private.worker_extract_token($1)", [ownerId])) ?? null;
    },
    async context(ownerId, messageId) {
      const r = await one<{ c: OpenFact[] }>("select private.worker_extract_context($1, $2) as c", [ownerId, messageId]);
      return r?.c ?? [];
    },
    async reserve(microUsd) {
      return (await one<{ id: string | null }>("select private.worker_budget_reserve($1) as id", [microUsd]))?.id ?? null;
    },
    async settle(reservationId, usage) {
      await pool.query("select private.worker_budget_settle($1, $2::jsonb)", [
        reservationId,
        JSON.stringify({
          actual_microusd: usage.actual_microusd,
          input_tokens: usage.input_tokens,
          cache_read_tokens: usage.cache_read_input_tokens,
          cache_write_tokens: usage.cache_creation_input_tokens,
          output_tokens: usage.output_tokens,
          model: usage.model,
        }),
      ]);
    },
    async commit(ownerId, messageId, facts) {
      const r = await one<{ n: number }>("select private.worker_extract_commit($1, $2, $3::jsonb, $4::jsonb) as n", [
        ownerId,
        messageId,
        JSON.stringify({ model: MODEL_ID, prompt_version: PROMPT_VERSION }),
        JSON.stringify(facts),
      ]);
      return r?.n ?? 0;
    },
    async skip(ownerId, messageId, reason) {
      await pool.query("select private.worker_extract_skip($1, $2, $3)", [ownerId, messageId, reason]);
    },
    async fail(ownerId, messageId, code) {
      return (await one<{ s: string }>("select private.worker_extract_fail($1, $2, $3) as s", [ownerId, messageId, code]))?.s ?? "failed";
    },
    async release(ownerId, messageId) {
      await pool.query("select private.worker_extract_release($1, $2)", [ownerId, messageId]);
    },
  };
  return { db, close: () => pool.end() };
}
