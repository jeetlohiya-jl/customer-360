import { describe, expect, it } from "vitest";
import { GmailError } from "@/lib/gmail/google";
import { ModelError, reservationMicroUsd, costMicroUsd } from "@/lib/extract/model";
import { prepareMessage, runExtractTick, type ClaimedItem, type ExtractDb, type ExtractGmail } from "@/lib/extract/run";
import { buildUserMessage, headerPeople } from "@/lib/extract/prompt";
import type { CommitFact } from "@/lib/extract/validate";
import { CASES, CUSTOMERS, mkMessage, OWNER_EMAIL, PLANTED } from "../fixtures/synthetic-emails";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const usage = { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 };

function harness(opts: { reserveLimit?: number; modelError?: unknown; revoked?: boolean; rateLimit?: "labels" | "get"; forbidden?: boolean } = {}) {
  const items: ClaimedItem[] = CASES.map((c) => ({
    owner_id: OWNER, mailbox_email: OWNER_EMAIL, gmail_message_id: c.msg.id, gmail_thread_id: null,
    message_at: "2026-09-15T10:00:00.000Z", direction: c.direction, customers: CUSTOMERS,
  }));
  const calls = { commits: new Map<string, CommitFact[]>(), skips: new Map<string, string>(), fails: new Map<string, string>(), released: [] as string[], settled: [] as number[], reserved: 0, fetched: [] as string[], model: 0 };
  const db: ExtractDb = {
    cleanup: async () => 0,
    claim: async () => items,
    token: async () => ({ refresh_token_enc: "v1.x.y.z", key_version: 1 }),
    context: async (_o, id) => CASES.find((c) => c.msg.id === id)?.openFacts ?? [],
    reserve: async (m) => {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(100_000); // the database refuses more than $0.10 per call
      if (opts.reserveLimit !== undefined && calls.reserved >= opts.reserveLimit) return null;
      calls.reserved++;
      return `r${calls.reserved}`;
    },
    settle: async (_id, u) => void calls.settled.push(u.actual_microusd),
    commit: async (_o, id, facts) => (calls.commits.set(id, facts), facts.length),
    skip: async (_o, id, reason) => void calls.skips.set(id, reason),
    fail: async (_o, id, code) => (calls.fails.set(id, code), "pending"),
    release: async (_o, id) => void calls.released.push(id),
  };
  const gmail: ExtractGmail = {
    accessToken: async () => {
      if (opts.revoked) throw new GmailError("revoked", 400, "invalid_grant");
      return "access";
    },
    listLabels: async () => {
      if (opts.rateLimit === "labels") throw new GmailError("gmail_api_error", 403, "userRateLimitExceeded");
      return [{ id: "Label_9", name: "C360-Exclude" }];
    },
    getMessage: async (_at, id) => {
      calls.fetched.push(id);
      if (opts.rateLimit === "get" && calls.fetched.length === 3) throw new GmailError("gmail_api_error", 403, "userRateLimitExceeded");
      if (opts.forbidden && calls.fetched.length === 3) throw new GmailError("gmail_api_error", 403, "insufficientPermissions");
      return CASES.find((c) => c.msg.id === id)!.msg;
    },
  };
  // Items are processed one at a time, so the model answers for the email fetched last.
  const model = {
    extract: async () => {
      calls.model++;
      if (opts.modelError) throw opts.modelError;
      const c = CASES.find((x) => x.msg.id === calls.fetched.at(-1))!;
      return { output: c.model, usage };
    },
  };
  const logs: string[] = [];
  return { items, calls, deps: { db, gmail, model, decrypt: () => "refresh", log: (e: Record<string, unknown>) => void logs.push(JSON.stringify(e)) }, logs };
}

describe("extraction run", () => {
  it("processes every synthetic email: skips, commits and counts", async () => {
    const h = harness();
    const sum = await runExtractTick(h.deps);
    expect(sum.claimed).toBe(CASES.length);
    expect(sum.skipped).toBe(CASES.filter((c) => "skip" in c.expect).length);
    expect(sum.extracted).toBe(CASES.filter((c) => !("skip" in c.expect)).length);
    expect(sum.failed).toBe(0);
    expect(h.calls.fetched.sort()).toEqual(h.items.map((i) => i.gmail_message_id).sort()); // only claimed ids are fetched
    expect(h.calls.model).toBe(sum.extracted); // skipped emails never reach the model
    expect(h.calls.settled).toHaveLength(sum.extracted);
    expect(sum.cost_microusd).toBe(costMicroUsd(usage) * sum.extracted);
    expect(sum.redactions.card).toBeGreaterThanOrEqual(1);
  });

  it("logs and failure codes never contain email text or planted secrets", async () => {
    for (const opts of [{}, { modelError: new ModelError("http_error", 500, "api_error") }, { revoked: true }]) {
      const h = harness(opts);
      await runExtractTick(h.deps);
      const out = h.logs.join("\n") + [...h.calls.fails.values()].join("\n");
      for (const [kind, v] of Object.entries(PLANTED)) expect(out, kind).not.toContain(v);
      expect(out).not.toMatch(/Can you do|Please find PO|Hi Ravi|Hi team/);
      for (const code of h.calls.fails.values()) expect(code).toMatch(/^[a-z_]+:[A-Za-z0-9_:.-]{1,60}$/);
    }
  });

  it("budget hard stop: no more model calls; the rest go back to the queue unpenalised", async () => {
    const h = harness({ reserveLimit: 3 });
    const sum = await runExtractTick(h.deps);
    expect(sum.status).toBe("budget_stopped");
    expect(h.calls.model).toBe(3);
    expect(sum.released).toBeGreaterThan(0);
    expect(sum.failed).toBe(0);
    expect(sum.extracted + sum.skipped + sum.released).toBe(CASES.length);
  });

  it("an API error is charged at its real cost (zero) and the email is retried later", async () => {
    const h = harness({ modelError: new ModelError("http_error", 500, "api_error") });
    const sum = await runExtractTick(h.deps);
    expect(sum.failed).toBe(sum.claimed - sum.skipped);
    expect(h.calls.settled.every((c) => c === 0)).toBe(true);
    expect([...h.calls.fails.values()][0]).toBe("model:anthropic:http_error_500_api_error");
  });

  it("a network error may have been billed: the reservation stays open (charged in full later)", async () => {
    const h = harness({ modelError: new ModelError("network_error", undefined, undefined, true) });
    await runExtractTick(h.deps);
    expect(h.calls.settled).toHaveLength(0);
  });

  it("revoked Gmail access: nothing is fetched or sent", async () => {
    const h = harness({ revoked: true });
    const sum = await runExtractTick(h.deps);
    expect(h.calls.fetched).toHaveLength(0);
    expect(h.calls.model).toBe(0);
    expect(sum.failed).toBe(CASES.length);
    expect(new Set(h.calls.fails.values())).toEqual(new Set(["gmail_auth:revoked"]));
  });

  it("Gmail rate limit while listing labels: every item goes back to the queue, none fail", async () => {
    const h = harness({ rateLimit: "labels" });
    const sum = await runExtractTick(h.deps);
    expect(sum.failed).toBe(0);
    expect(sum.released).toBe(h.items.length);
    expect(h.calls.fetched).toHaveLength(0);
  });

  it("Gmail rate limit on a message: that and the mailbox's remaining items go back to the queue", async () => {
    const h = harness({ rateLimit: "get" });
    const sum = await runExtractTick(h.deps);
    expect(sum.failed).toBe(0);
    expect(h.calls.fetched).toHaveLength(3); // nothing more is fetched from that mailbox this run
    expect(sum.released).toBe(h.items.length - 2);
    expect(h.logs.join("\n")).toContain("extract_rate_limited");
  });

  it("a 403 that is NOT a rate limit still fails the item (with a safe code)", async () => {
    const h = harness({ forbidden: true });
    const sum = await runExtractTick(h.deps);
    expect(sum.failed).toBe(1);
    expect([...h.calls.fails.values()][0]).toBe("gmail_get:gmail:gmail_api_error_403");
  });

  it("an email deleted after it was linked (404) is skipped as 'deleted', not failed or retried", async () => {
    const h = harness();
    const get = h.deps.gmail.getMessage;
    h.deps.gmail.getMessage = async (at, id) => {
      if (id === h.items[0].gmail_message_id) throw new GmailError("gmail_api_error", 404, "notFound");
      return get(at, id);
    };
    const sum = await runExtractTick(h.deps);
    expect(h.calls.skips.get(h.items[0].gmail_message_id)).toBe("deleted");
    expect(h.calls.fails.has(h.items[0].gmail_message_id)).toBe(false);
    expect(sum.skip_reasons.deleted).toBe(1);
  });

  it("internal emails (0013) are read only when linked as internal; the prompt says they are internal", () => {
    const body = "Hi David, please check the options for the 1C tray: we can send 200 samples once the $2000 prototype tool cost is approved. Thanks, VB";
    const internal = mkMessage({ id: "int1", from: "VB <vb@gocirkla.com>", to: OWNER_EMAIL, subject: "RE: trays", body });
    const base = { mailbox_email: OWNER_EMAIL, message_at: "2026-10-09T10:00:00.000Z", customers: CUSTOMERS };
    // Linked as internal (thread or subject rule): prepared, and labelled internal for the model.
    const ok = prepareMessage(internal, { ...base, direction: "internal" }, [], new Set());
    expect(ok.kind).toBe("ready");
    if (ok.kind === "ready") expect(ok.prompt).toContain("Direction: internal: between Cirkla colleagues about the customer");
    // Any other direction keeps the internal-only exclusion.
    expect(prepareMessage(internal, { ...base, direction: "inbound" }, [], new Set())).toEqual({ kind: "skip", reason: "excluded" });
    // Privacy rules still apply to internal mail.
    const priv = mkMessage({ id: "int2", from: "vb@gocirkla.com", to: OWNER_EMAIL, subject: "Confidential salary review", body });
    expect(prepareMessage(priv, { ...base, direction: "internal" }, [], new Set())).toEqual({ kind: "skip", reason: "excluded" });
    expect(buildUserMessage({ customers: CUSTOMERS, date: "2026-10-09", direction: "outbound", openFacts: [], text: "x" })).toContain("sent BY Cirkla to the customer");
  });

  it("the prompt says who wrote the email and who received it, by name only (x6)", () => {
    expect(headerPeople('"Agarwal, Vaibhav" <vaibhav.agarwal@gocirkla.com>, greg@premiofoods.com, Glenn Divers <glenn.divers@gocirkla.com>', "gocirkla.com"))
      .toEqual(["Agarwal, Vaibhav (Cirkla)", "Greg (premiofoods.com)", "Glenn Divers (Cirkla)"]);
    expect(headerPeople("x9@example.com", "gocirkla.com")).toEqual([]); // no readable name: left out
    expect(headerPeople(undefined, "gocirkla.com")).toEqual([]);
    const body = "Glenn, we can stick to the old quote. Please update the contract terms page and send it to me.";
    const msg = mkMessage({ id: "ppl1", from: "Vaibhav <vaibhav@gocirkla.com>", to: "Glenn Divers <glenn.divers@gocirkla.com>",
      headers: { Cc: "david.woods@gocirkla.com" }, subject: "Premio Pricing", body });
    const ok = prepareMessage(msg, { mailbox_email: "glenn.divers@gocirkla.com", message_at: "2026-10-24T18:06:00.000Z", customers: CUSTOMERS, direction: "internal" }, [], new Set());
    expect(ok.kind).toBe("ready");
    if (ok.kind !== "ready") return;
    expect(ok.prompt).toContain("From (the writer): Vaibhav (Cirkla)");
    expect(ok.prompt).toContain("To: Glenn Divers (Cirkla)");
    expect(ok.prompt).toContain("Cc: David Woods (Cirkla)");
    expect(ok.prompt).not.toContain("@");
  });

  it("the worst-case reservation always covers the real cost", () => {
    const big = { input_tokens: 9000, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 };
    expect(reservationMicroUsd(14_000)).toBeGreaterThan(costMicroUsd(big));
    expect(reservationMicroUsd(14_000)).toBeLessThan(100_000);
  });
});
