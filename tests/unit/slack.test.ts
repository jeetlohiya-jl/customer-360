import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { ModelError } from "@/lib/extract/model";
import { ANSWER_SYSTEM_PROMPT, buildAnswerPrompt, factLine, focusPeople, HISTORY_FETCH, isHelp, noTopicFacts, personName, pickCustomers, renderAnswer, selectFacts, selectHistory, topicTypes, wantsHistory, wantsLatest, wantsOpenItems, wantsSourceOwner, type SlackFact } from "@/lib/slack/answer";
import { SlackError } from "@/lib/slack/api";
import { parseSlackConfig } from "@/lib/slack/config";
import { answerReservationMicroUsd } from "@/lib/slack/model";
import { handleDm, isBareName, MESSAGES, type SlackDb } from "@/lib/slack/run";
import { parseEnvelope, verifySlackSignature } from "@/lib/slack/verify";

const SECRET = "0123456789abcdef0123456789abcdef";
// Synthetic, assembled at run time so secret scanners don't mistake them for real credentials.
const FAKE_BOT_TOKEN = ["xoxb", "0000000000", "synthetic", "test", "only"].join("-");
const FAKE_USER_TOKEN = ["xoxp", "user", "token", "not", "allowed", "000"].join("-");
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "synthetic0test0only0key000"].join("-");
const sign = (ts: string, body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;

const fact = (over: Partial<SlackFact> = {}): SlackFact => ({
  fact_id: "f1", customer_id: "c1", customer_name: "Acme Foods", fact_type: "pricing", stance: "proposal", party: "cirkla",
  basis: "explicit", status: "open", status_basis: "explicit", stale: false, product: "1012 tray", quantity: null, unit: null,
  unit_price: "0.21", currency: "USD", price_basis: "FOB", due_date: null, due_text: null, reference: null,
  summary: "Cirkla quoted $0.21 per tray FOB.", evidence_quote: "we can offer $0.21/tray FOB", confidence: "0.92",
  review_state: "auto", message_at: "2026-09-12T10:00:00.000Z", direction: "outbound", is_mine: false,
  source_owner_email: null, mailbox_email: null, gmail_message_id: null, ...over,
});

describe("Slack request verification", () => {
  const body = '{"type":"event_callback"}';
  const now = 1_800_000_000;
  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackSignature(SECRET, String(now), sign(String(now), body), body, now)).toBe(true);
  });
  it("refuses a wrong signature, a changed body, an old timestamp or missing headers", () => {
    expect(verifySlackSignature(SECRET, String(now), sign(String(now), body).replace(/.$/, "0"), body, now)).toBe(false);
    expect(verifySlackSignature(SECRET, String(now), sign(String(now), body), `${body} `, now)).toBe(false);
    expect(verifySlackSignature(SECRET, String(now - 301), sign(String(now - 301), body), body, now)).toBe(false);
    expect(verifySlackSignature(SECRET, null, sign(String(now), body), body, now)).toBe(false);
    expect(verifySlackSignature(SECRET, String(now), null, body, now)).toBe(false);
  });
});

describe("Slack event parsing", () => {
  const dm = { type: "event_callback", event_id: "Ev01ABC", event: { type: "message", channel_type: "im", user: "U01ABC", channel: "D01XYZ", text: "What's open with Acme?" } };
  it("passes through a person's DM and the URL check", () => {
    expect(parseEnvelope(dm)).toEqual({ kind: "dm", eventId: "Ev01ABC", user: "U01ABC", channel: "D01XYZ", text: "What's open with Acme?" });
    expect(parseEnvelope({ ...dm, event: { ...dm.event, ts: "1761650100.000100" } })).toMatchObject({ kind: "dm", ts: "1761650100.000100" });
    expect(parseEnvelope({ ...dm, event: { ...dm.event, ts: "x" } })).not.toHaveProperty("ts");
    expect(parseEnvelope({ type: "url_verification", challenge: "abc" })).toEqual({ kind: "url_verification", challenge: "abc" });
  });
  it.each([
    ["a bot's own message", { ...dm, event: { ...dm.event, bot_id: "B1" } }],
    ["an edit", { ...dm, event: { ...dm.event, subtype: "message_changed" } }],
    ["a channel message", { ...dm, event: { ...dm.event, channel_type: "channel", channel: "C01XYZ" } }],
    ["an empty message", { ...dm, event: { ...dm.event, text: "  " } }],
    ["a malformed event id", { ...dm, event_id: "../x" }],
  ])("ignores %s", (_, e) => expect(parseEnvelope(e).kind).toBe("ignore"));
});

describe("question handling (pure)", () => {
  it("detects help and when the asker wants the source colleague (D2)", () => {
    expect(isHelp("help")).toBe(true);
    expect(isHelp("hi!")).toBe(true);
    expect(isHelp("help with Acme pricing")).toBe(false);
    expect(wantsSourceOwner("Who has been emailing Acme Foods?")).toBe(true);
    expect(wantsSourceOwner("which rep handles Acme")).toBe(true);
    expect(wantsSourceOwner("whose mailbox did this come from")).toBe(true);
    expect(wantsSourceOwner("What's open with Acme Foods?")).toBe(false);
    expect(wantsSourceOwner("What pricing did we quote Acme?")).toBe(false);
  });

  it("picks the longest matching customer name and ignores the shorter name inside it", () => {
    const picked = pickCustomers([
      { customer_id: "a", customer_name: "Tenfold Meats Inc", matched: "tenfold meats" },
      { customer_id: "b", customer_name: "Tenfold Meats Wholesale", matched: "tenfold meats wholesale" },
      { customer_id: "c", customer_name: "Quarry Farms", matched: "quarry farms" },
    ]);
    expect(picked.map((p) => p.customer_id)).toEqual(["b", "c"]);
  });

  it("keeps every customer that shares a matched first word (partial matches)", () => {
    const picked = pickCustomers([
      { customer_id: "a", customer_name: "Tenfold Meats Inc", matched: "tenfold", match_kind: "partial" },
      { customer_id: "b", customer_name: "Tenfold Meats Wholesale", matched: "tenfold", match_kind: "partial" },
    ]);
    expect(picked.map((p) => p.customer_id).sort()).toEqual(["a", "b"]);
  });

  const ACME = [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }];

  it("the prompt is compact: one line per fact, review state and staleness, no quotes", () => {
    const p = buildAnswerPrompt("What did we quote?", ACME, [fact(), fact({ fact_id: "f2", review_state: "needs_review", stale: true })], "2026-10-21");
    expect(p).toContain("F1 | 12 Sep 2026 | pricing/proposal | open | 1012 tray, 0.21 USD FOB | said by cirkla | Cirkla quoted $0.21 per tray FOB.");
    expect(p).toContain("UNVERIFIED | STALE");
    expect(p).not.toContain("we can offer"); // evidence quotes stay on the Facts page
    expect(p).toContain("What did we quote?");
  });

  it("never names the mailbox owner: the same email sits in several mailboxes, so names come from the summary only", () => {
    const out = buildAnswerPrompt("x", ACME, [
      fact({ source_owner_email: "glenn.divers@gocirkla.com", direction: "outbound" }),
      fact({ fact_id: "f2", summary: "Greg asked for samples", party: "customer", source_owner_email: "cary.newton@gocirkla.com", direction: "inbound" }),
    ], "2026-10-22");
    expect(out).toContain("email from Cirkla to the customer");
    expect(out).toContain("email from the customer");
    expect(out).not.toMatch(/Glenn|Cary|@gocirkla\.com/);
    expect(personName("vaibhav@gocirkla.com")).toBe("Vaibhav");
    expect(personName(null)).toBeNull();
  });

  it("a 'latest' question asks for one update; a history question does not", () => {
    expect(wantsLatest("what is the latest update about premio?")).toBe(true);
    expect(wantsLatest("where do we stand with Fieldale")).toBe(true);
    expect(wantsLatest("last 3 updates from fieldale")).toBe(false);
    expect(wantsLatest("summarise all pricing for premio")).toBe(false);
    expect(buildAnswerPrompt("latest?", ACME, [fact()], "2026-10-22", { latest: true })).toContain("Answer style: LATEST.");
  });

  it("history questions get one line per month, with every month represented", () => {
    for (const q of ["give me a month wise summary since the beginning of this account", "summary of everything that has happened with Premio till date",
      "full history of Acme", "monthly recap for Acme"]) expect(wantsHistory(q)).toBe(true);
    for (const q of ["what's the latest on premio?", "what's open with Acme?", "summary of the last email"]) expect(wantsHistory(q)).toBe(false);
    const months = ["2026-10", "2026-09", "2026-07", "2025-12"];
    const all = months.flatMap((m, i) => Array.from({ length: 10 }, (_, j) =>
      fact({ fact_id: `${m}-${j}`, message_at: `${m}-${String(10 + j).padStart(2, "0")}T10:00:00.000Z`, summary: `Item ${i}-${j}`, evidence_quote: `q ${i}-${j}`, fact_type: j === 9 ? "order" : "follow_up" })));
    const picked = selectHistory(all);
    expect(new Set(picked.map((f) => f.message_at.slice(0, 7)))).toEqual(new Set(months));
    expect(picked.filter((f) => f.fact_type === "order")).toHaveLength(4); // the order in each month is kept
    expect(picked.map((f) => f.message_at)).toEqual([...picked.map((f) => f.message_at)].sort().reverse());
    expect(buildAnswerPrompt("history", ACME, picked, "2026-10-28", { history: true })).toContain("Answer style: HISTORY.");
    expect(HISTORY_FETCH).toBeGreaterThan(120);
  });

  it("answers write dates with the year", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain("Always write dates with the year");
    expect(factLine(fact(), 0)).toContain("12 Sep 2026");
  });

  it("a bare customer name is a follow-up; a real question is not", () => {
    const premio = [{ customer_id: "c9", customer_name: "Premio Foods", matched: "premio" }];
    expect(isBareName("Premio", premio)).toBe(true);
    expect(isBareName("for premio?", premio)).toBe(true);
    expect(isBareName("latest on premio", premio)).toBe(false);
  });

  it("finds the question's topic from plain words", () => {
    expect(topicTypes("latest update of premio pricing?")).toEqual(["pricing"]);
    expect(topicTypes("any quality complaints from Acme")).toEqual(["quality_issue"]);
    expect(topicTypes("when does the container ship")).toEqual(["delivery"]);
    expect(topicTypes("Recent updates from fieldale?")).toEqual([]);
  });

  it("next steps / actionables: every kind of open item, open ones first, nothing filtered by type", () => {
    const q = "what does David need as next steps on Preferred Packaging? what are the actionables?";
    expect(wantsOpenItems(q)).toBe(true);
    expect(topicTypes(q)).toEqual([]); // not just "requirement" because the question says "need"
    expect(wantsOpenItems("What's open with Acme Foods?")).toBe(true);
    expect(wantsOpenItems("latest update of premio pricing?")).toBe(false);
    const facts = [
      fact({ fact_id: "r1", status: "resolved", summary: "Old quote", evidence_quote: "a" }),
      fact({ fact_id: "o1", fact_type: "delivery", summary: "Pickup on 22 Oct", evidence_quote: "b" }),
      fact({ fact_id: "o2", fact_type: "follow_up", summary: "Send 200 samples", evidence_quote: "c" }),
    ];
    expect(selectFacts(facts, [], { openFirst: true }).map((f) => f.fact_id)).toEqual(["o1", "o2", "r1"]);
    expect(selectFacts(facts, []).map((f) => f.fact_id)).toEqual(["r1", "o1", "o2"]);
    expect(buildAnswerPrompt(q, ACME, facts, "2026-10-23", { openItems: true })).toContain("list the OPEN items, who owes each");
  });

  it("a colleague named in the question becomes the answer's focus", () => {
    const facts = [
      fact({ source_owner_email: "david.woods@gocirkla.com" }),
      fact({ fact_id: "f2", summary: "Umar (Cirkla) needs 4-5 weeks for samples.", source_owner_email: "glenn.divers@gocirkla.com" }),
    ];
    expect(focusPeople("what does David need as next steps?", facts)).toEqual([]); // David is only the mailbox owner
    expect(focusPeople("what does David need as next steps?", [fact({ summary: "Greg asked David (Cirkla) for a quote." })])).toEqual(["David"]);
    expect(focusPeople("when will Umar have the samples", facts)).toEqual(["Umar"]);
    expect(focusPeople("what is open with Acme", facts)).toEqual([]);
    expect(buildAnswerPrompt("what does David need?", ACME, facts, "2026-10-23", { focus: ["David"] })).toContain("Focus: the question is about David (Cirkla)");
  });

  it("internal facts say so instead of from/to the customer", () => {
    expect(factLine(fact({ direction: "internal", source_owner_email: "david.woods@gocirkla.com" }), 0)).toContain("internal Cirkla email");
  });

  it("sends only relevant, de-duplicated facts, newest first, at most 25", () => {
    const many = Array.from({ length: 40 }, (_, i) => fact({ fact_id: `p${i}`, summary: `Quote ${i}`, evidence_quote: `quote ${i}` }));
    expect(selectFacts(many, [])).toHaveLength(25);
    const dupes = [fact({ fact_id: "a" }), fact({ fact_id: "b", summary: "Other words" }), fact({ fact_id: "c", evidence_quote: null, summary: "Cirkla quoted $0.21 per tray FOB." })];
    expect(selectFacts(dupes, []).map((f) => f.fact_id)).toEqual(["a"]); // same quote, same summary: one fact
    const mixed = [fact({ fact_id: "d", fact_type: "delivery", summary: "Ships 3 Nov", evidence_quote: "ships" }), fact({ fact_id: "p" })];
    expect(selectFacts(mixed, ["pricing"]).map((f) => f.fact_id)).toEqual(["p"]);
  });

  it("the reply is short: customer, answer without fact ids, one evidence link", () => {
    const facts = [fact(), fact({ fact_id: "f2", summary: "PO came in", evidence_quote: "PO attached", message_at: "2026-09-13T23:30:00.000Z" })];
    const out = renderAnswer("Quoted $0.21/tray FOB.\n• 12 Sep: quoted $0.21 [F1]\n• 13 Sep: PO came in (unverified) [F2, UNVERIFIED][F9] <!channel>", facts,
      { customers: ACME, appUrl: "https://c360.example/" });
    expect(out.cited).toBe(2);
    expect(out.text).toBe(
      "*Acme Foods*\nQuoted $0.21/tray FOB.\n• 12 Sep: quoted $0.21\n• 13 Sep: PO came in (unverified) &lt;!channel&gt;\n" +
      "_From 2 stored facts · <https://c360.example/facts?customer=c1&from=2026-09-12&to=2026-09-13|evidence and sources>_");
  });

  it("the evidence link opens on the cited days only; no citations means all facts", () => {
    const facts = [fact({ message_at: "2026-10-24T18:06:00Z" }), fact({ fact_id: "f2", summary: "Older", evidence_quote: "older", message_at: "2026-10-20T09:00:00Z" })];
    expect(renderAnswer("24 Oct: kept the old quote. [F1]", facts, { customers: ACME, appUrl: "https://c360.example" }).text)
      .toContain("facts?customer=c1&from=2026-10-24&to=2026-10-24|");
    expect(renderAnswer("Nothing cited.", facts, { customers: ACME, appUrl: "https://c360.example" }).text)
      .toContain("facts?customer=c1|");
  });

  it("no facts on the asked topic: a direct reply with the latest activity, no AI call needed", () => {
    const text = noTopicFacts([{ customer_id: "c9", customer_name: "Premio Foods", matched: "premio" }], ["pricing"],
      fact({ customer_name: "Premio Foods", summary: "Asked for an intro call", message_at: "2024-10-27T10:00:00Z" }), "https://c360.example");
    expect(text).toBe("*Premio Foods*\nNo pricing facts are stored for Premio Foods.\nLatest activity: 27 Oct 2024: Asked for an intro call\n_<https://c360.example/facts?customer=c9|All facts for this customer>_");
  });

  it("an answer costs well under a cent and its reservation stays inside the database's per-call limit", () => {
    const worst = answerReservationMicroUsd(12_000);
    expect(worst).toBeLessThanOrEqual(100_000);
    expect(worst).toBeLessThan(10_000); // < $0.01 even in the worst case
  });
});

describe("Slack configuration is fail-safe", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-publishable-key-0123456789",
    APP_BASE_URL: "http://localhost:3000", WORKSPACE_DOMAIN: "gocirkla.com", FEATURE_SLACK: "on", FEATURE_GMAIL: "on",
    GOOGLE_GMAIL_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_GMAIL_CLIENT_SECRET: "synthetic-client-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  const scan = { FEATURE_SCAN: "on", CRON_SECRET: "x".repeat(40), WORKER_DATABASE_URL: "postgresql://c360_worker.abc:pw@aws-0.pooler.supabase.com:5432/postgres" };
  const slack = { SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: FAKE_BOT_TOKEN, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };
  it("is off by default and when anything is missing or malformed (no values in the problems)", () => {
    expect(parseSlackConfig(parseServerEnv({ ...base, FEATURE_SLACK: "off", ...scan, ...slack })).enabled).toBe(false);
    const missing = parseSlackConfig(parseServerEnv({ ...base, ...scan }));
    expect(missing).toMatchObject({ enabled: false, reason: "misconfigured" });
    const bad = parseSlackConfig(parseServerEnv({ ...base, ...scan, ...slack, SLACK_BOT_TOKEN: FAKE_USER_TOKEN }));
    expect(bad.enabled).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("xoxp-user");
    expect(parseSlackConfig(parseServerEnv({ ...base, ...slack })).enabled).toBe(false); // no worker database
  });
  it("is on with every setting valid", () => {
    expect(parseSlackConfig(parseServerEnv({ ...base, ...scan, ...slack })).enabled).toBe(true);
  });
});

describe("answering a DM", () => {
  const QUESTION = "What did we quote Acme Foods? call me on +1 415 555 0134";
  function harness(over: Partial<SlackDb> & { modelError?: unknown; email?: string | null; earlier?: { text: string; ts: string }[] } = {}) {
    const posts: string[] = [];
    const logs: string[] = [];
    const prompts: string[] = [];
    const settled: number[] = [];
    const db: SlackDb = {
      eventSeen: async () => false,
      user: async (_id, email) => (email === "ann@gocirkla.com" ? { user_id: "u1", is_admin: false } : null),
      allow: async () => true,
      customers: async () => [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }],
      facts: async () => [fact()],
      reserve: async () => "r1",
      settle: async (_r, u) => void settled.push(u.actual_microusd),
      ...over,
    };
    const deps = {
      db,
      slack: { userEmail: async () => (over.email === undefined ? "ann@gocirkla.com" : over.email), post: async (_c: string, t: string) => void posts.push(t),
        earlierMessages: async (): Promise<{ text: string; ts: string }[]> => over.earlier ?? [] },
      model: {
        answer: async (p: string) => {
          prompts.push(p);
          if (over.modelError) throw over.modelError;
          return { text: "Cirkla quoted $0.21 per tray FOB [F1].", usage: { input_tokens: 3000, output_tokens: 80, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } };
        },
      },
      appUrl: "https://c360.example",
      today: "2026-10-21",
      log: (e: Record<string, unknown>) => void logs.push(JSON.stringify(e)),
    };
    return { deps, posts, logs, prompts, settled };
  }
  const ev = { eventId: "Ev1", user: "U01ANN", channel: "D01ANN", text: QUESTION };

  it("answers from stored facts with sources, charges the budget and logs no question text", async () => {
    const h = harness();
    expect(await handleDm(h.deps, ev)).toBe("answered");
    expect(h.posts[0]).toContain("*Acme Foods*\nCirkla quoted $0.21 per tray FOB.");
    expect(h.posts[0]).toContain("|evidence and sources>");
    expect(h.settled).toHaveLength(1);
    expect(h.prompts[0]).not.toContain("415 555 0134"); // the question is redacted before it leaves
    const logs = h.logs.join("\n");
    expect(logs).toContain('"outcome":"answered"');
    expect(logs).not.toMatch(/quote|Acme|415/i);
  });

  it("refuses anyone who is not an active employee", async () => {
    const h = harness({ email: "someone@othercorp.com" });
    expect(await handleDm(h.deps, ev)).toBe("not_allowed");
    expect(h.posts[0]).toBe(MESSAGES.notAllowed("https://c360.example"));
    expect(h.prompts).toHaveLength(0);
  });

  it("ignores Slack's retries of the same event", async () => {
    const h = harness({ eventSeen: async () => true });
    expect(await handleDm(h.deps, ev)).toBe("duplicate");
    expect(h.posts).toHaveLength(0);
  });

  it.each([
    ["rate_limited", { allow: async () => false }, MESSAGES.rateLimited],
    ["no_customer", { customers: async () => [] }, MESSAGES.noCustomer],
    ["no_facts", { facts: async () => [] }, MESSAGES.noFacts("Acme Foods")],
    ["budget", { reserve: async () => null }, MESSAGES.budget],
  ] as const)("%s: explains and makes no AI call", async (outcome, over, msg) => {
    const h = harness(over as Partial<SlackDb>);
    expect(await handleDm(h.deps, ev)).toBe(outcome);
    expect(h.posts).toEqual([msg]);
    expect(h.prompts).toHaveLength(0);
  });

  it("follow-up: no customer named, so the customer comes from the person's previous message", async () => {
    const h = harness({
      customers: async (q: string) => (/acme/i.test(q) ? [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }] : []),
      earlier: [{ text: "what did we quote Acme Foods?", ts: "1761650000.000100" }],
    });
    expect(await handleDm(h.deps, { ...ev, text: "give me a month wise summary since the beginning of this account", ts: "1761650100.000100" })).toBe("answered");
    expect(h.prompts[0]).toContain("Customer: Acme Foods. Answer style: HISTORY.");
    expect(h.logs.join("")).toContain('"follow_up":1');
  });

  it("follow-up: a bare customer name answers the previous question that named none", async () => {
    const h = harness({
      customers: async (q: string) => (/acme/i.test(q) ? [{ customer_id: "c1", customer_name: "Acme Foods", matched: "acme foods" }] : []),
      earlier: [{ text: "give me a month wise summary since the beginning of this account", ts: "1761650000.000100" }],
    });
    expect(await handleDm(h.deps, { ...ev, text: "Acme Foods", ts: "1761650100.000100" })).toBe("answered");
    expect(h.prompts[0]).toContain("Answer style: HISTORY.");
    expect(h.prompts[0]).toContain("month wise summary");
  });

  it("without a Slack timestamp nothing earlier is read", async () => {
    let read = 0;
    const h = harness({ customers: async () => [] });
    h.deps.slack.earlierMessages = async () => { read++; return []; };
    expect(await handleDm(h.deps, { ...ev, text: "summary of this account" })).toBe("no_customer");
    expect(read).toBe(0);
  });

  it("a Slack API error is reported with Slack's error code", async () => {
    const h = harness({ user: async () => null });
    h.deps.slack.userEmail = async () => { throw new SlackError("missing_scope", 200); };
    expect(await handleDm(h.deps, ev)).toBe("error");
    expect(h.posts).toEqual([`${MESSAGES.error} (ref: slack:missing_scope)`]);
  });

  it("the customer has facts, but none on the asked topic: answered directly, no AI call", async () => {
    const h = harness({ facts: async () => [fact({ fact_type: "delivery", summary: "Ships 3 Nov" })] });
    expect(await handleDm(h.deps, ev)).toBe("no_topic_facts");
    expect(h.posts[0]).toContain("No pricing facts are stored for Acme Foods.");
    expect(h.prompts).toHaveLength(0);
  });

  it("a customer name that contains a topic word is not taken as the topic", async () => {
    const h = harness({
      customers: async () => [{ customer_id: "c2", customer_name: "Quality Meats Inc", matched: "quality meats" }],
      facts: async () => [fact({ customer_name: "Quality Meats Inc", fact_type: "order", summary: "PO 77 for 900 cases" })],
    });
    expect(await handleDm(h.deps, { ...ev, text: "anything new from Quality Meats?" })).toBe("answered");
  });

  it("help needs no AI call", async () => {
    const h = harness();
    expect(await handleDm(h.deps, { ...ev, text: "help" })).toBe("help");
    expect(h.prompts).toHaveLength(0);
  });

  it("an API error is settled at its real cost and the person gets a short apology (safe code in the log)", async () => {
    const h = harness({ modelError: new ModelError("http_error", 529, "overloaded_error") });
    expect(await handleDm(h.deps, ev)).toBe("error");
    expect(h.settled).toEqual([0]);
    expect(h.posts).toEqual([`${MESSAGES.error} (ref: anthropic:http_error_529_overloaded_error)`]);
    expect(h.logs.join("\n")).toContain("anthropic:http_error_529");
  });
});

describe("the answer call to Anthropic", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const u = { input_tokens: 10, output_tokens: 5 };

  it("forces the send_answer tool and reads the answer from it", async () => {
    const { anthropicAnswerModel } = await import("@/lib/slack/model");
    let sent: Record<string, unknown> = {};
    const m = anthropicAnswerModel("k", (async (_u: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return ok({ content: [{ type: "tool_use", name: "send_answer", input: { answer: "Quoted $0.21 [F1]." } }], usage: u, stop_reason: "tool_use" });
    }) as typeof fetch);
    expect((await m.answer("p")).text).toBe("Quoted $0.21 [F1].");
    expect(sent.tool_choice).toEqual({ type: "tool", name: "send_answer" });
  });

  it("no answer in the reply: an error carrying only the API's stop reason", async () => {
    const { anthropicAnswerModel } = await import("@/lib/slack/model");
    const m = anthropicAnswerModel("k", (async () => ok({ content: [{ type: "text", text: "" }], usage: u, stop_reason: "max_tokens" })) as typeof fetch);
    await expect(m.answer("p")).rejects.toMatchObject({ code: "no_tool_output", type: "max_tokens" });
  });
});
