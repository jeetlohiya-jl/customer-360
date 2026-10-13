import { describe, expect, it } from "vitest";
import { GmailError, type MessageHeaders } from "@/lib/gmail/google";
import { runTick, type ClaimedJob, type MasterSnapshot, type PageCounts, type WorkerDb, type WorkerGmail } from "@/lib/scan/worker";
import type { LinkOut } from "@/lib/scan/classify";

const ACME = "00000000-0000-4000-8000-00000000a001";
const OWNER = "pilot.owner@gocirkla.com";
const master: MasterSnapshot = {
  workspace_domain: "gocirkla.com",
  customers: [{ id: ACME, canonical_name: "Acme Packaging Limited", status: "active", names: [], domains: [{ value: "acmepackaging.com", shared: false }], emails: [] }],
  distinctions: [],
  rejections: [],
};

/** Synthetic mailbox: every 3rd message is from Acme, every 5th is internal-only, the rest are newsletters. */
function mailbox(total: number) {
  const ids = Array.from({ length: total }, (_, i) => `m${(i + 1).toString(16).padStart(6, "0")}`);
  const headers = (id: string, i: number): MessageHeaders => ({
    id,
    threadId: `t${i}`,
    labelIds: ["INBOX"],
    internalDate: Date.parse("2026-01-01T00:00:00Z") + i * 60_000,
    headers:
      i % 3 === 0
        ? { from: "Jane <jane@acmepackaging.com>", to: OWNER, subject: `order ${i}` }
        : i % 5 === 0
          ? { from: "colleague@gocirkla.com", to: OWNER, subject: `internal ${i}` }
          : { from: "news@vendor.example", to: OWNER, subject: `digest ${i}` },
  });
  return { ids, headers };
}

function fakeGmail(total: number, opts: { failIds?: Set<string>; revokeAfter?: number; crashOnce?: { page: number } } = {}) {
  const box = mailbox(total);
  let headerCalls = 0;
  let crashed = false;
  const gmail: WorkerGmail = {
    accessToken: async () => "access",
    listLabels: async () => [],
    listIds: async (_at, token) => {
      const page = token ? Number(token.slice(1)) : 0;
      if (opts.crashOnce && opts.crashOnce.page === page && !crashed) {
        crashed = true;
        throw new Error("simulated crash");
      }
      const slice = box.ids.slice(page * 250, page * 250 + 250);
      return { messages: slice.map((id) => ({ id })), nextPageToken: (page + 1) * 250 < box.ids.length ? `p${page + 1}` : null };
    },
    getHeaders: async (_at, id) => {
      headerCalls++;
      if (opts.revokeAfter !== undefined && headerCalls > opts.revokeAfter) throw new GmailError("revoked", 401);
      if (opts.failIds?.has(id)) throw new GmailError("gmail_api_error", 500);
      return box.headers(id, box.ids.indexOf(id));
    },
  };
  return gmail;
}

function fakeDb() {
  const job = {
    job_id: "job-1",
    owner_id: "owner-1",
    mailbox_email: OWNER,
    cutoff_at: "2026-10-14T00:00:00Z",
    page_token: null as string | null,
    pages_done: 0,
    rules_version: "m1",
    status: "queued",
    counts: {} as Record<string, number>,
  };
  const links = new Map<string, LinkOut>();
  const failures: string[] = [];
  const db: WorkerDb = {
    retentionCleanup: async () => 0,
    claimJob: async (): Promise<ClaimedJob | null> => (["queued", "running", "cancelling"].includes(job.status) ? { ...job } : null),
    jobToken: async () => (job.status === "paused_auth" ? null : { refresh_token_enc: "enc", key_version: 1 }),
    customerMaster: async () => master,
    commitPage: async (a) => {
      if (a.pageNo <= job.pages_done) return "duplicate";
      const c = a.counts as unknown as Record<string, number>;
      const sum = ["excluded_rule", "excluded_privacy", "excluded_internal", "matched", "in_review", "unmatched", "failed", "newer_than_cutoff"].reduce((s, k) => s + c[k], 0);
      if (sum !== c.enumerated) throw new Error("does not reconcile");
      for (const l of a.links) links.set(`${l.gmail_message_id}|${l.customer_id}`, l);
      failures.push(...a.failures.map((f) => f.gmail_message_id));
      for (const [k, v] of Object.entries(c)) job.counts[k] = (job.counts[k] ?? 0) + v;
      job.pages_done = a.pageNo;
      job.page_token = a.nextPageToken;
      job.status = job.status === "cancelling" ? "cancelled" : a.done ? "completed" : "running";
      return job.status;
    },
    authLost: async () => {
      job.status = "paused_auth";
    },
    release: async () => "released",
  };
  return { db, job, links, failures };
}

const deps = (db: WorkerDb, gmail: WorkerGmail) => ({ db, gmail, decrypt: () => "refresh" });

async function runToEnd(db: WorkerDb, gmail: WorkerGmail, max = 20) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = await runTick(deps(db, gmail));
    results.push(r);
    if (r.status === "idle") break;
  }
  return results;
}

describe("scan worker", () => {
  it("scans a 600-message mailbox in 3 pages; every message gets exactly one outcome", async () => {
    const f = fakeDb();
    const results = await runToEnd(f.db, fakeGmail(600));
    expect(results.map((r) => r.status)).toEqual(["running", "running", "completed", "idle"]);
    const c = f.job.counts as unknown as PageCounts;
    expect(c.enumerated).toBe(600);
    expect(c.matched + c.excluded_internal + c.unmatched).toBe(600);
    expect(c.matched).toBe(200); // every 3rd message
    expect(f.links.size).toBe(200);
  });

  it("resumes after a crash without losing or duplicating anything", async () => {
    const f = fakeDb();
    const results = await runToEnd(f.db, fakeGmail(600, { crashOnce: { page: 1 } }));
    expect(results.map((r) => r.status)).toEqual(["running", "released", "running", "completed", "idle"]);
    expect((f.job.counts as unknown as PageCounts).enumerated).toBe(600);
    expect(f.links.size).toBe(200);
  });

  it("re-sending an already committed page is a no-op", async () => {
    const f = fakeDb();
    await runTick(deps(f.db, fakeGmail(600)));
    const linksAfterPage1 = f.links.size;
    const again = await f.db.commitPage({
      jobId: "job-1", pageNo: 1, nextPageToken: "p1", counts: f.job.counts as unknown as PageCounts,
      links: [...f.links.values()], reviews: [], failures: [], done: false,
    });
    expect(again).toBe("duplicate");
    expect(f.links.size).toBe(linksAfterPage1);
    expect(f.job.pages_done).toBe(1);
  });

  it("pauses when Google revokes access, and commits nothing from that page", async () => {
    const f = fakeDb();
    const r = await runTick(deps(f.db, fakeGmail(600, { revokeAfter: 10 })));
    expect(r.status).toBe("auth_lost");
    expect(f.job.status).toBe("paused_auth");
    expect(f.job.pages_done).toBe(0);
    expect(f.links.size).toBe(0);
  });

  it("counts and records messages that fail after retries instead of dropping them silently", async () => {
    const f = fakeDb();
    const failIds = new Set(["m000001", "m000002"]);
    await runToEnd(f.db, fakeGmail(10, { failIds }));
    expect((f.job.counts as unknown as PageCounts).failed).toBe(2);
    expect(f.failures.sort()).toEqual(["m000001", "m000002"]);
    expect((f.job.counts as unknown as PageCounts).enumerated).toBe(10);
  });

  it("honours a cancel at the next commit", async () => {
    const f = fakeDb();
    await runTick(deps(f.db, fakeGmail(600)));
    f.job.status = "cancelling";
    const r = await runTick(deps(f.db, fakeGmail(600)));
    expect(r.status).toBe("cancelled");
    expect((await runTick(deps(f.db, fakeGmail(600)))).status).toBe("idle");
  });

  it("does nothing when no job is approved and started", async () => {
    const f = fakeDb();
    f.job.status = "completed";
    expect((await runTick(deps(f.db, fakeGmail(10)))).status).toBe("idle");
  });

  it("asks Gmail only for headers (the request shape is fixed in lib/gmail/google.ts)", async () => {
    const { getMessageHeaders } = await import("@/lib/gmail/google");
    let url = "";
    await getMessageHeaders("at", "abc", (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ id: "abc", internalDate: "1", payload: { headers: [] } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(url).toContain("format=metadata");
    expect(url).not.toMatch(/format=(full|raw)/);
    expect(new URL(url).searchParams.getAll("metadataHeaders")).toEqual(["From", "To", "Cc", "Subject", "Date", "Sensitivity", "List-Unsubscribe"]);
  });

  it("tags failures with a stage and a safe code (Stage 3.1.1)", async () => {
    const f = fakeDb();
    const codes: string[] = [];
    f.db.release = async (_id, code) => {
      codes.push(code);
      return "released";
    };
    const events: Record<string, unknown>[] = [];
    const secretish = "postgresql://c360_worker.x:SENTINEL-PASSWORD@host/db";
    const r = await runTick({
      ...deps(f.db, fakeGmail(10)),
      decrypt: () => {
        throw new Error(`Unsupported state or unable to authenticate data ${secretish}`);
      },
      log: (e) => events.push(e),
    });
    expect(r.status).toBe("released");
    expect(codes).toEqual(["decrypt:decrypt_failed"]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
    expect(events).toContainEqual(expect.objectContaining({ event: "scan_page_released", stage: "decrypt", code: "decrypt:decrypt_failed" }));
  });

  it("a database failure before a job is claimed surfaces as a stage error, not a raw message", async () => {
    const { StageError, tickErrorEvent } = await import("@/lib/scan/errors");
    const f = fakeDb();
    f.db.claimJob = async () => {
      throw Object.assign(new Error('password authentication failed for user "c360_worker" SENTINEL'), { code: "28P01" });
    };
    const err = await runTick(deps(f.db, fakeGmail(10))).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(tickErrorEvent(err)).toEqual({ event: "scan_tick_error", stage: "db_claim", code: "pg_28P01" });
    expect(JSON.stringify(tickErrorEvent(err))).not.toContain("SENTINEL");
  });

  it("a Gmail listing failure is released with the Gmail code and stage", async () => {
    const f = fakeDb();
    const codes: string[] = [];
    f.db.release = async (_id, code) => {
      codes.push(code);
      return "released";
    };
    const g = fakeGmail(10);
    g.listIds = async () => {
      throw new GmailError("gmail_api_error", 503);
    };
    expect((await runTick(deps(f.db, g))).status).toBe("released");
    expect(codes[0]).toMatch(/^gmail_list:gmail:gmail_api_error_503$/);
  });
});
