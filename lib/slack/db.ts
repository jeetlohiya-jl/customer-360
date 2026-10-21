import "server-only";
import { Pool } from "pg";
import type { CustomerMatch, SlackFact } from "./answer";
import type { SlackDb } from "./run";

/**
 * Slack assistant database access through the c360_worker login, which can
 * only run the private.worker_slack_* and private.worker_budget_* functions.
 * Every visibility rule is enforced inside those functions.
 */
export function createSlackDb(url: string, ca?: string): { db: SlackDb; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await pool.query(sql, params)).rows[0] as T | undefined;

  const db: SlackDb = {
    async eventSeen(eventId) {
      return (await one<{ seen: boolean }>("select private.worker_slack_event_seen($1) as seen", [eventId]))?.seen ?? true;
    },
    async user(slackId, email) {
      return (await one<{ user_id: string; is_admin: boolean }>("select user_id, is_admin from private.worker_slack_user($1, $2)", [slackId, email ?? null])) ?? null;
    },
    async allow(userId) {
      return (await one<{ ok: boolean }>("select private.worker_slack_allow($1) as ok", [userId]))?.ok ?? false;
    },
    async customers(question) {
      return (await pool.query<CustomerMatch>("select customer_id, customer_name, matched, match_kind from private.worker_slack_customers($1)", [question])).rows;
    },
    async facts(userId, customerIds, showOwner, limit) {
      const r = await pool.query<Omit<SlackFact, "message_at" | "due_date"> & { message_at: Date | string; due_date: Date | string | null }>(
        "select * from private.worker_slack_facts($1, $2::uuid[], $3, $4)",
        [userId, customerIds, showOwner, limit],
      );
      return r.rows.map((f) => ({
        ...f,
        message_at: new Date(f.message_at).toISOString(),
        due_date: f.due_date ? (f.due_date instanceof Date ? f.due_date.toISOString().slice(0, 10) : String(f.due_date)) : null,
      }));
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
  };
  return { db, close: () => pool.end() };
}
