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
import { buildAnswerPrompt, factsForPrompt, HELP_TEXT, isHelp, pickCustomers, renderAnswer, wantsSourceOwner, type CustomerMatch, type SlackFact } from "./answer";
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
}

export type DmOutcome =
  | "duplicate" | "not_allowed" | "help" | "rate_limited" | "no_customer" | "no_facts" | "budget" | "answered" | "error";

export const MESSAGES = {
  notAllowed: (appUrl: string) =>
    `Sorry, this assistant is only for active Cirkla employees. If you work at Cirkla, sign in once at ${appUrl} with your Cirkla Google account, then ask again.`,
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

    const question = redact(ev.text.slice(0, 1000)).text;
    const customers = pickCustomers(await deps.db.customers(question));
    counts.customers = customers.length;
    if (customers.length === 0) {
      await reply(MESSAGES.noCustomer);
      return (outcome = "no_customer");
    }

    const showOwner = wantsSourceOwner(question);
    const all = await deps.db.facts(who.user_id, customers.map((c) => c.customer_id), showOwner, 120);
    const facts = factsForPrompt(all);
    counts.facts = facts.length;
    if (facts.length === 0) {
      await reply(MESSAGES.noFacts(customers.map((c) => c.customer_name).join(", ")));
      return (outcome = "no_facts");
    }

    const prompt = buildAnswerPrompt(question, customers, facts, deps.today ?? new Date().toISOString().slice(0, 10));
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

    const rendered = renderAnswer(result.text, facts, { showOwner });
    counts.cited = rendered.cited;
    // When the name was only partly given, say which customer(s) the answer is about.
    const about = customers.some((c) => c.match_kind === "partial") ? `_About ${customers.map((c) => c.customer_name).join(", ")}:_\n` : "";
    await reply(about + rendered.text);
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
