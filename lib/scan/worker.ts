/**
 * Stage 3.1 scan worker: processes at most ONE page (up to 250 messages) of
 * one leased job per run, then commits outcomes, counters and the resume point
 * in a single database transaction (private.worker_commit_page).
 *
 * - Resumable: a crash before commit loses nothing; the next run repeats the
 *   page from the last committed token. Links are unique per message, so a
 *   repeat never duplicates.
 * - Cancellable: the owner's cancel is honoured at the next commit or claim.
 * - Revoked access pauses the job ("paused_auth") until the owner reconnects.
 * - Logs only event names, counts and error codes.
 * All I/O is injected so the logic is tested without Gmail or a database.
 */
import { GmailError, type MessageHeaders } from "@/lib/gmail/google";
import { buildIndex, type CustomerRecord } from "@/lib/customers/matcher";
import { classifyMessage, EXCLUDE_LABEL_RE, parseAddresses, type LinkOut, type ReviewOut } from "./classify";
import { errorCode, errorStage, inStage, StageError } from "./errors";

export interface ClaimedJob {
  job_id: string;
  owner_id: string;
  mailbox_email: string;
  cutoff_at: string;
  page_token: string | null;
  pages_done: number;
  rules_version: string;
}

export interface MasterSnapshot {
  workspace_domain: string;
  customers: { id: string; canonical_name: string; status: "active" | "inactive"; names: CustomerRecord["names"]; domains: CustomerRecord["domains"]; emails: string[] }[];
  distinctions: [string, string][];
  rejections: string[];
}

export interface PageCounts {
  enumerated: number;
  excluded_rule: number;
  excluded_privacy: number;
  excluded_internal: number;
  matched: number;
  in_review: number;
  unmatched: number;
  weak_evidence_only: number;
  failed: number;
  newer_than_cutoff: number;
}

export interface ReviewPayload extends ReviewOut {
  messages: { gmail_message_id: string; gmail_thread_id: string | null; message_at: string; direction: "inbound" | "outbound" }[];
}

export interface WorkerDb {
  retentionCleanup(): Promise<number>;
  claimJob(leaseSeconds: number): Promise<ClaimedJob | null>;
  jobToken(jobId: string): Promise<{ refresh_token_enc: string; key_version: number } | null>;
  customerMaster(): Promise<MasterSnapshot>;
  commitPage(a: {
    jobId: string;
    pageNo: number;
    nextPageToken: string | null;
    counts: PageCounts;
    links: LinkOut[];
    reviews: ReviewPayload[];
    failures: { gmail_message_id: string; error_code: string }[];
    done: boolean;
  }): Promise<string>;
  authLost(jobId: string): Promise<void>;
  release(jobId: string, errorCode: string): Promise<string>;
}

export interface WorkerGmail {
  accessToken(refreshToken: string): Promise<string>;
  listLabels(accessToken: string): Promise<{ id: string; name: string }[]>;
  listIds(accessToken: string, pageToken: string | null): Promise<{ messages: { id: string; threadId?: string }[]; nextPageToken: string | null }>;
  getHeaders(accessToken: string, id: string): Promise<MessageHeaders>;
}

export interface TickDeps {
  db: WorkerDb;
  gmail: WorkerGmail;
  decrypt(enc: string, keyVersion: number, ownerId: string): string;
  concurrency?: number;
  log?: (event: Record<string, unknown>) => void;
}

export type TickResult =
  | { status: "idle" }
  | { status: "auth_lost"; jobId: string }
  | { status: "released" | "failed"; jobId: string; error: string }
  | { status: string; jobId: string; pageNo: number; counts: PageCounts };

class AuthLost extends Error {}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const emptyCounts = (): PageCounts => ({
  enumerated: 0,
  excluded_rule: 0,
  excluded_privacy: 0,
  excluded_internal: 0,
  matched: 0,
  in_review: 0,
  unmatched: 0,
  weak_evidence_only: 0,
  failed: 0,
  newer_than_cutoff: 0,
});

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const log = deps.log ?? (() => {});
  await inStage("db_cleanup", () => deps.db.retentionCleanup());
  const job = await inStage("db_claim", () => deps.db.claimJob(180));
  if (!job) return { status: "idle" };

  try {
    const tok = await inStage("db_token", () => deps.db.jobToken(job.job_id));
    if (!tok) throw new AuthLost();
    const refreshToken = await inStage("decrypt", () => deps.decrypt(tok.refresh_token_enc, tok.key_version, job.owner_id));
    let accessToken: string;
    try {
      accessToken = await deps.gmail.accessToken(refreshToken);
    } catch (e) {
      if (e instanceof GmailError && e.code === "revoked") throw new AuthLost();
      throw new StageError("gmail_auth", e);
    }
    const guard = async <T>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof GmailError && e.code === "revoked") throw new AuthLost();
        throw e;
      }
    };

    const master = await inStage("db_master", () => deps.db.customerMaster());
    const index = buildIndex({
      customers: master.customers.map((c) => ({ id: c.id, canonicalName: c.canonical_name, status: c.status, names: c.names, domains: c.domains, emails: c.emails })),
      distinctions: master.distinctions,
      rejections: master.rejections,
      workspaceDomain: master.workspace_domain,
    });
    const labels = await inStage("gmail_labels", () => guard(deps.gmail.listLabels(accessToken)));
    const excludeLabelIds = new Set(labels.filter((l) => EXCLUDE_LABEL_RE.test(l.name)).map((l) => l.id));
    const page = await inStage("gmail_list", () => guard(deps.gmail.listIds(accessToken, job.page_token)));

    const counts = emptyCounts();
    counts.enumerated = page.messages.length;
    const links: LinkOut[] = [];
    const reviews = new Map<string, ReviewPayload>();
    const failures: { gmail_message_id: string; error_code: string }[] = [];
    const ctx = {
      ownerEmail: job.mailbox_email,
      workspaceDomain: master.workspace_domain,
      cutoffMs: Date.parse(job.cutoff_at),
      excludeLabelIds,
    };

    await mapLimit(page.messages, deps.concurrency ?? 10, async (ref) => {
      let msg: MessageHeaders;
      try {
        msg = await deps.gmail.getHeaders(accessToken, ref.id);
      } catch (e) {
        if (e instanceof GmailError && e.code === "revoked") throw new AuthLost();
        counts.failed++;
        failures.push({ gmail_message_id: ref.id, error_code: e instanceof GmailError ? `${e.code}_${e.httpStatus ?? ""}` : "fetch_error" });
        return;
      }
      const out = classifyMessage(msg, index, ctx);
      counts[out.bucket]++;
      if (out.weakEvidenceOnly) counts.weak_evidence_only++;
      links.push(...out.links);
      for (const r of out.reviews) {
        const cur = reviews.get(r.observed) ?? { ...r, messages: [] };
        cur.messages.push({
          gmail_message_id: msg.id,
          gmail_thread_id: msg.threadId ?? null,
          message_at: new Date(msg.internalDate).toISOString(),
          direction: parseAddresses(msg.headers["from"])[0]?.email === job.mailbox_email.toLowerCase() ? "outbound" : "inbound",
        });
        reviews.set(r.observed, cur);
      }
    });

    const pageNo = job.pages_done + 1;
    const status = await inStage("db_commit", () => deps.db.commitPage({
      jobId: job.job_id,
      pageNo,
      nextPageToken: page.nextPageToken,
      counts,
      links,
      reviews: [...reviews.values()],
      failures,
      done: page.nextPageToken === null,
    }));
    log({ event: "scan_page_committed", status, pageNo, ...counts, links: links.length });
    return { status, jobId: job.job_id, pageNo, counts };
  } catch (e) {
    const inner = e instanceof StageError ? e.cause : e;
    if (inner instanceof AuthLost) {
      await inStage("db_auth_lost", () => deps.db.authLost(job.job_id));
      log({ event: "scan_auth_lost" });
      return { status: "auth_lost", jobId: job.job_id };
    }
    // Safe code only: "<stage>:<code>", e.g. "gmail_list:gmail_quota_429".
    const stage = errorStage(e);
    const code = `${stage}:${errorCode(e)}`.slice(0, 64);
    const status = await inStage("db_release", () => deps.db.release(job.job_id, code));
    log({ event: "scan_page_released", status, stage, code });
    return { status: status === "failed" ? "failed" : "released", jobId: job.job_id, error: code };
  }
}
