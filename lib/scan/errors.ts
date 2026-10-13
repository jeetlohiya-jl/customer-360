/**
 * Stage 3.1.1: turn any error into a short, safe code for logs.
 *
 * Never logs error messages, stack traces, URLs, connection strings, tokens or
 * email data. Only allowlisted shapes are kept:
 *   - GmailError       -> gmail:<code>_<http status>   (e.g. gmail:gmail_api_error_429)
 *   - Postgres error   -> pg_<SQLSTATE>            (e.g. pg_28P01 bad password)
 *   - Node system/TLS  -> sys_<CODE>               (e.g. sys_ENOTFOUND)
 *   - a few well-known messages are recognised (matched, never copied):
 *       ssl_unsupported, timeout, conn_terminated, decrypt_failed
 *   - otherwise        -> the error class name if it is a plain identifier,
 *                         else "error".
 */
import { GmailError } from "@/lib/gmail/google";

export type ScanStage =
  | "config"
  | "db_cleanup"
  | "db_claim"
  | "db_token"
  | "decrypt"
  | "gmail_auth"
  | "db_master"
  | "gmail_labels"
  | "gmail_list"
  | "db_commit"
  | "db_auth_lost"
  | "db_release"
  | "unknown";

/** Wraps an error with the step it happened in. The cause is kept for code only. */
export class StageError extends Error {
  constructor(
    public readonly stage: ScanStage,
    public readonly cause: unknown,
  ) {
    super(`scan stage ${stage} failed`);
    this.name = "StageError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const SYS_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const IDENT = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

const KNOWN_MESSAGES: [RegExp, string][] = [
  [/does not support SSL/i, "ssl_unsupported"],
  [/timeout|timed out/i, "timeout"],
  [/Connection terminated/i, "conn_terminated"],
  [/unable to authenticate data|ciphertext format|key version mismatch|bad decrypt/i, "decrypt_failed"],
];

export function errorCode(e: unknown): string {
  if (e instanceof StageError) return errorCode(e.cause);
  if (e instanceof GmailError) return `gmail:${e.code}_${e.httpStatus ?? ""}`.slice(0, 48);
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") {
      if (SQLSTATE.test(code)) return `pg_${code}`;
      if (SYS_CODE.test(code)) return `sys_${code}`;
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") {
      for (const [re, known] of KNOWN_MESSAGES) if (re.test(message)) return known;
    }
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && IDENT.test(name)) return name;
  }
  return "error";
}

export function errorStage(e: unknown): ScanStage {
  return e instanceof StageError ? e.stage : "unknown";
}

/** Runs a step and tags any failure with its stage. */
export async function inStage<T>(stage: ScanStage, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError(stage, e);
  }
}

/** The only shape the cron route logs on failure. */
export function tickErrorEvent(e: unknown): { event: "scan_tick_error"; stage: ScanStage; code: string } {
  return { event: "scan_tick_error", stage: errorStage(e), code: errorCode(e) };
}
