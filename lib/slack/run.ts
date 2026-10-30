/**
 * Slack DM assistant: one question in, one reply out. All I/O is injected.
 *
 * The question text exists only in this function. It is redacted before it
 * goes to the AI provider, and it is never logged or stored; logs carry event
 * names, counts and safe codes only.
 */
import { costMicroUsd, ModelError, type Usage } from "@/lib/extract/model";
import { MODEL_ID } from "@/lib/extract/prompt";
import { redact } from "@/lib/extract/redact";
import { errorCode } from "@/lib/scan/errors";
import { buildAnswerPrompt, focusPeople, HELP_TEXT, HISTORY_FETCH, isHelp, LATEST_FACTS, noTopicFacts, pickCustomers, renderAnswer, selectFacts, selectHistory, topicTypes, wantsHistory, wantsLatest, wantsOpenItems, type CustomerMatch, type SlackFact } from "./answer";
import { SlackError, type SlackApi } from "./api";
import { answerReservationMicroUsd, type AnswerModel } from "./model";

export interface SlackDb {
  eventSeen(eventId: string): Promise<boolean>;
  user(slackId: string, email?: string | null): Promise<{ user_id: string; is_admin: boolean } | null>;
  allow(userId: string): Promise<boolean>;
  customers(question: string): Promise<CustomerMatch[]>;
  facts(userId: string, customerIds: string[], showOwner: boolean, limit: number): Promise<SlackFact[]>;
  reserve(microUsd: number): Promise<string | null>;
  settle(reservationId: string, usage: Usage & { actual_microusd: number; model: string }): Promise<void>;
}

export interface SlackDeps {
  db: SlackDb;
  slack: SlackApi;
  model: AnswerModel;
  appUrl: string;
  today?: string;
  log?: (event: Record<string, unknown>) => void;
}

export interface DmEvent {
  eventId: string;
  user: string;
  channel: string;
  text: string;
  /** Slack message timestamp; lets a follow-up use the person's previous message. */
  ts?: string;
}

/** Earlier messages count as the same conversation for this long. */
export const FOLLOW_UP_SECONDS = 30 * 60;

/** Words left once the customer's name is removed: "Premio" or "for premio?" leaves none that matter. */
const FILLER = new Set(["for", "on", "about", "with", "the", "of", "customer", "account", "please", "pls", "plz", "and", "to", "in", "it", "is"]);
export function isBareName(question: string, customers: CustomerMatch[]): boolean {
  const rest = customers.reduce((q, c) => q.replace(new RegExp(c.matched.split(" ").map((w) => w.replace(/[^a-z0-9]/gi, "")).filter(Boolean).join("[^a-z0-9]+"), "gi"), " "), question);
  return rest.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w && !FILLER.has(w)).length === 0;
}

export type DmOutcome =
  | "duplicate" | "not_allowed" | "help" | "rate_limited" | "no_customer" | "no_facts" | "no_topic_facts" | "budget" | "answered" | "error";

export const MESSAGES = {
  notAllowed: (appUrl: string) =>
    `Sorry, this assistant is only for people invited to Customer 360. If a Customer 360 admin has invited you, sign in once at ${appUrl} with your Cirkla Google account, then ask again.`,
  rateLimited: "You've reached the hourly limit for questions. Please try again in a little while.",
  noCustomer: "Which customer do you mean? I couldn't find a customer name in your question. Use the name as it appears in Customer 360, e.g. _What's open with Acme Foods?_",
  noFacts: (names: string) => `I don't have any stored facts you can see for ${names} yet.`,
  budget: "The monthly AI budget for Customer 360 has been reached, so I can't answer right now. An admin can raise it on the Admin page.",
  error: "Sorry, something went wrong while answering. Please try again in a minute.",
};

export async function handleDm(deps: SlackDeps, ev: DmEvent): Promise<DmOutcome> {
  const log = deps.log ?? (() => {});
  const reply = (text: string) => deps.slack.post(ev.channel, text);
  let outcome: DmOutcome = "error";
  let reservation: string | null = null;
  const counts: Record<string, number> = {};
  try {
    if (await deps.db.eventSeen(ev.eventId)) return (outcome = "duplicate");

    let who = await deps.db.user(ev.user);
    if (!who) {
      const email = await deps.slack.userEmail(ev.user);
      who = email ? await deps.db.user(ev.user, email) : null;
    }
    if (!who) {
      await reply(MESSAGES.notAllowed(deps.appUrl));
      return (outcome = "not_allowed");
    }
    if (isHelp(ev.text)) {
      await reply(HELP_TEXT);
      return (outcome = "help");
    }
    if (!(await deps.db.allow(who.user_id))) {
      await reply(MESSAGES.rateLimited);
      return (outcome = "rate_limited");
    }

    let question = redact(ev.text.slice(0, 1000)).text;
    let customers = pickCustomers(await deps.db.customers(question));
    // Follow-ups: "summary since the beginning of this account" after asking about Premio
    // uses Premio; a bare "Premio" after a question with no customer answers that question.
    // The earlier messages are read from Slack for this reply only, never stored.
    if (ev.ts && (customers.length === 0 || isBareName(question, customers))) {
      const earlier = await deps.slack.earlierMessages(ev.channel, ev.user, ev.ts, FOLLOW_UP_SECONDS).catch(() => []);
      for (const m of earlier.slice(0, 3)) {
        const text = redact(m.text).text;
        const theirs = pickCustomers(await deps.db.customers(text));
        if (customers.length === 0 && theirs.length > 0) {
          customers = theirs;
          counts.follow_up = 1;
          break;
        }
        if (customers.length > 0 && theirs.length === 0 && !isHelp(text)) {
          question = `${text}\n${question}`.slice(0, 1500);
          counts.follow_up = 1;
          break;
        }
        if (customers.length > 0) break; // the earlier message named a customer: the bare name is a new question
      }
    }
    counts.customers = customers.length;
    if (customers.length === 0) {
      await reply(MESSAGES.noCustomer);
      return (outcome = "no_customer");
    }

    // Colleagues' names are always shown (decision D2 changed 2026-10-22: answers name people).
    // Topic words come from the question minus the customer's name ("Quality Meats" is not a quality question).
    const topicText = customers.reduce((q, c) => q.replace(new RegExp(c.matched.split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join("[^a-z0-9]+"), "gi"), " "), question);
    const openItems = wantsOpenItems(topicText);
    const history = !openItems && wantsHistory(question);
    const all = await deps.db.facts(who.user_id, customers.map((c) => c.customer_id), true, history ? HISTORY_FETCH : 120);
    if (all.length === 0) {
      await reply(MESSAGES.noFacts(customers.map((c) => c.customer_name).join(", ")));
      return (outcome = "no_facts");
    }
    const types = topicTypes(topicText);
    const latest = !history && !openItems && wantsLatest(question);
    const selected = history ? selectHistory(types.length ? all.filter((f) => types.includes(f.fact_type)) : all) : selectFacts(all, types, { openFirst: openItems });
    const facts = latest ? selected.slice(0, LATEST_FACTS) : selected;
    counts.facts = facts.length;
    if (facts.length === 0) {
      // The customer has facts, just none on this topic: say so without an AI call.
      await reply(noTopicFacts(customers, types, all[0], deps.appUrl));
      return (outcome = "no_topic_facts");
    }

    const prompt = buildAnswerPrompt(question, customers, facts, deps.today ?? new Date().toISOString().slice(0, 10), {
      latest,
      history,
      openItems,
      focus: focusPeople(question, facts),
    });
    reservation = await deps.db.reserve(answerReservationMicroUsd(prompt.length));
    if (!reservation) {
      await reply(MESSAGES.budget);
      return (outcome = "budget");
    }
    const res = reservation;
    let result;
    try {
      result = await deps.model.answer(prompt);
    } catch (e) {
      if (e instanceof ModelError && !e.maybeBilled) {
        const u = (e as ModelError & { usage?: Usage }).usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        await deps.db.settle(res, { ...u, actual_microusd: costMicroUsd(u), model: MODEL_ID });
      } // maybe billed: left open; the database charges the full reservation after 15 minutes
      throw e;
    }
    const cost = costMicroUsd(result.usage);
    await deps.db.settle(res, { ...result.usage, actual_microusd: cost, model: MODEL_ID });
    counts.cost_microusd = cost;

    const rendered = renderAnswer(result.text, facts, { customers, appUrl: deps.appUrl });
    counts.cited = rendered.cited;
    await reply(rendered.text);
    return (outcome = "answered");
  } catch (e) {
    const code = (
      e instanceof ModelError ? `anthropic:${e.code}_${e.httpStatus ?? ""}${e.type ? `_${e.type}` : ""}`
      : e instanceof SlackError ? `slack:${e.code}`
      : errorCode(e)
    ).slice(0, 64);
    counts.failed = 1;
    log({ event: "slack_dm_error", code });
    // The code is safe to show (status and error type only, never content) and makes problems easy to report.
    await reply(`${MESSAGES.error} (ref: ${code})`).catch(() => undefined);
    return (outcome = "error");
  } finally {
    if (outcome !== "duplicate") log({ event: "slack_dm", outcome, ...counts });
  }
}
