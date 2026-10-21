/**
 * Stage B + C worker (behind FEATURE_EXTRACT, off by default).
 *
 * One run: claim up to N customer-linked emails from approved mailboxes, and
 * for each one:
 *   fetch -> exclusions -> plain text -> cleanup -> pre-filter -> redact
 *   -> reserve worst-case cost -> model -> settle cost -> validate -> commit facts
 *
 * The email text exists only inside prepareMessage()/runExtractTick() as a
 * local variable. It is never logged, stored, thrown or put in an error code.
 * Logs carry event names, counts and safe codes only. All I/O is injected.
 */
import { GmailError, type FullMessage, type MessageHeaders } from "@/lib/gmail/google";
import { EXCLUDE_LABEL_RE, exclusionRule } from "@/lib/scan/classify";
import { errorCode, errorStage, inStage, StageError } from "@/lib/scan/errors";
import { costMicroUsd, ModelError, reservationMicroUsd, type ExtractModel, type Usage } from "./model";
import { buildUserMessage, MODEL_ID } from "./prompt";
import { redact, type RedactionKind } from "./redact";
import { cleanBody, mimeText, prefilter, SHORT_REPLY_CHARS, type SkipReason } from "./text";
import { validateFacts, type CommitFact, type DropReason, type ReviewReason } from "./validate";

export interface ClaimedItem {
  owner_id: string;
  mailbox_email: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  message_at: string;
  direction: "inbound" | "outbound";
  customers: { id: string; name: string }[];
}

export interface OpenFact {
  id: string;
  customer_id: string;
  type: string;
  summary: string;
  date: string;
}

export interface ExtractDb {
  cleanup(): Promise<number>;
  claim(limit: number, leaseSeconds: number): Promise<ClaimedItem[]>;
  token(ownerId: string): Promise<{ refresh_token_enc: string; key_version: number } | null>;
  context(ownerId: string, messageId: string): Promise<OpenFact[]>;
  reserve(microUsd: number): Promise<string | null>;
  settle(reservationId: string, usage: Usage & { actual_microusd: number; model: string }): Promise<void>;
  commit(ownerId: string, messageId: string, facts: CommitFact[]): Promise<number>;
  skip(ownerId: string, messageId: string, reason: SkipReason | "excluded"): Promise<void>;
  fail(ownerId: string, messageId: string, code: string): Promise<string>;
  release(ownerId: string, messageId: string): Promise<void>;
}

export interface ExtractGmail {
  accessToken(refreshToken: string): Promise<string>;
  listLabels(accessToken: string): Promise<{ id: string; name: string }[]>;
  getMessage(accessToken: string, id: string): Promise<FullMessage>;
}

export interface ExtractDeps {
  db: ExtractDb;
  gmail: ExtractGmail;
  model: ExtractModel;
  decrypt(enc: string, keyVersion: number, ownerId: string): string;
  limit?: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface TickSummary {
  status: "idle" | "done" | "budget_stopped";
  claimed: number;
  extracted: number;
  skipped: number;
  failed: number;
  released: number;
  facts: number;
  facts_for_review: number;
  dropped: Partial<Record<DropReason, number>>;
  review_reasons: Partial<Record<ReviewReason, number>>;
  skip_reasons: Partial<Record<SkipReason | "excluded", number>>;
  redactions: Partial<Record<RedactionKind, number>>;
  cost_microusd: number;
}

/** Everything needed to call the model, or a skip reason. Pure; used by tests directly. */
export type Prepared =
  | { kind: "skip"; reason: SkipReason | "excluded" }
  | {
      kind: "ready";
      prompt: string;
      text: string;
      /** Redacted earlier-message context sent with a short reply ("" if none). */
      context: string;
      truncated: boolean;
      redactions: Partial<Record<RedactionKind, number>>;
    };

const HEADER_KEYS = ["from", "to", "cc", "subject", "date", "sensitivity", "list-unsubscribe", "list-id", "precedence", "auto-submitted", "x-autoreply", "x-autorespond"];

export function headerMap(msg: FullMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload.headers ?? []) {
    const k = h.name.toLowerCase();
    if (HEADER_KEYS.includes(k) && !(k in out)) out[k] = h.value;
  }
  return out;
}

export function prepareMessage(
  msg: FullMessage,
  item: Pick<ClaimedItem, "mailbox_email" | "message_at" | "direction" | "customers">,
  openFacts: OpenFact[],
  excludeLabelIds: Set<string>,
): Prepared {
  const headers = headerMap(msg);
  const asHeaders: MessageHeaders = { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, internalDate: msg.internalDate, headers };
  // The scan's exclusions are re-checked now: a label or header may have changed since the link was made.
  const excluded = exclusionRule(asHeaders, {
    ownerEmail: item.mailbox_email,
    workspaceDomain: item.mailbox_email.split("@")[1] ?? "",
    cutoffMs: Number.MAX_SAFE_INTEGER,
    excludeLabelIds,
  });
  if (excluded) return { kind: "skip", reason: "excluded" };

  const mime = mimeText(msg.payload);
  const clean = cleanBody(mime.text);
  const skip = prefilter(headers, clean.text, mime);
  if (skip) return { kind: "skip", reason: skip };

  const red = redact(clean.text);
  const subject = headers["subject"] ? redact(headers["subject"].slice(0, 200)).text : undefined;
  const context = clean.text.length < SHORT_REPLY_CHARS && clean.replyContext ? redact(clean.replyContext).text : "";
  const prompt = buildUserMessage({
    customers: item.customers,
    date: item.message_at.slice(0, 10),
    direction: item.direction,
    openFacts,
    text: red.text,
    subject,
    replyContext: context || undefined,
  });
  return { kind: "ready", prompt, text: red.text, context, truncated: clean.truncated, redactions: red.counts };
}

function add<K extends string>(into: Partial<Record<K, number>>, from: Partial<Record<K, number>>) {
  for (const [k, v] of Object.entries(from) as [K, number][]) into[k] = (into[k] ?? 0) + v;
}

export async function runExtractTick(deps: ExtractDeps): Promise<TickSummary> {
  const log = deps.log ?? (() => {});
  const sum: TickSummary = {
    status: "idle", claimed: 0, extracted: 0, skipped: 0, failed: 0, released: 0, facts: 0, facts_for_review: 0,
    dropped: {}, review_reasons: {}, skip_reasons: {}, redactions: {}, cost_microusd: 0,
  };

  await inStage("db_cleanup", () => deps.db.cleanup());
  const items = await inStage("db_claim", () => deps.db.claim(Math.min(Math.max(deps.limit ?? 10, 1), 50), 300));
  sum.claimed = items.length;
  if (items.length === 0) return sum;
  sum.status = "done";

  const byOwner = new Map<string, ClaimedItem[]>();
  for (const it of items) byOwner.set(it.owner_id, [...(byOwner.get(it.owner_id) ?? []), it]);

  let budgetStopped = false;
  for (const [ownerId, list] of byOwner) {
    let accessToken: string | null = null;
    let excludeLabelIds = new Set<string>();
    let ownerError: string | null = null;
    try {
      const tok = await inStage("db_token", () => deps.db.token(ownerId));
      if (!tok) throw new StageError("db_token", new Error("no_token"));
      const refresh = await inStage("decrypt", () => deps.decrypt(tok.refresh_token_enc, tok.key_version, ownerId));
      accessToken = await inStage("gmail_auth", () => deps.gmail.accessToken(refresh));
      const labels = await inStage("gmail_labels", () => deps.gmail.listLabels(accessToken!));
      excludeLabelIds = new Set(labels.filter((l) => EXCLUDE_LABEL_RE.test(l.name)).map((l) => l.id));
    } catch (e) {
      const inner = e instanceof StageError ? e.cause : e;
      ownerError = inner instanceof GmailError && inner.code === "revoked" ? "gmail_auth:revoked" : `${errorStage(e)}:${errorCode(e)}`;
    }

    for (const item of list) {
      if (budgetStopped) {
        await deps.db.release(ownerId, item.gmail_message_id);
        sum.released++;
        continue;
      }
      if (ownerError || !accessToken) {
        await deps.db.fail(ownerId, item.gmail_message_id, (ownerError ?? "gmail_auth:error").slice(0, 64));
        sum.failed++;
        continue;
      }
      let reservation: string | null = null;
      try {
        const msg = await inStage("gmail_get", () => deps.gmail.getMessage(accessToken!, item.gmail_message_id));
        if (msg.id !== item.gmail_message_id) throw new StageError("gmail_get", new Error("id_mismatch"));
        const openFacts = await inStage("db_context", () => deps.db.context(ownerId, item.gmail_message_id));
        const prep = prepareMessage(msg, item, openFacts, excludeLabelIds);
        if (prep.kind === "skip") {
          await inStage("db_skip", () => deps.db.skip(ownerId, item.gmail_message_id, prep.reason));
          sum.skipped++;
          sum.skip_reasons[prep.reason] = (sum.skip_reasons[prep.reason] ?? 0) + 1;
          continue;
        }
        add(sum.redactions, prep.redactions);

        reservation = await inStage("db_reserve", () => deps.db.reserve(reservationMicroUsd(prep.prompt.length)));
        if (!reservation) {
          budgetStopped = true;
          await deps.db.release(ownerId, item.gmail_message_id);
          sum.released++;
          continue;
        }
        const res = reservation;
        let result;
        try {
          result = await deps.model.extract(prep.prompt);
        } catch (e) {
          if (e instanceof ModelError && !e.maybeBilled) {
            const usage = (e as ModelError & { usage?: Usage }).usage;
            const u = usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
            await deps.db.settle(res, { ...u, actual_microusd: costMicroUsd(u), model: MODEL_ID });
            sum.cost_microusd += costMicroUsd(u);
          } // maybe billed: left open; the database charges the full reservation after 15 minutes
          throw new StageError("model", e);
        }
        const cost = costMicroUsd(result.usage);
        await inStage("db_settle", () => deps.db.settle(res, { ...result.usage, actual_microusd: cost, model: MODEL_ID }));
        sum.cost_microusd += cost;

        const v = validateFacts(result.output, {
          text: prep.text,
          context: prep.context,
          messageDate: item.message_at.slice(0, 10),
          customers: item.customers,
          openFacts: openFacts.map((f) => ({ id: f.id, customer_id: f.customer_id })),
          truncated: prep.truncated,
        });
        add(sum.dropped, v.dropped);
        for (const f of v.facts) for (const r of f.review_reasons) sum.review_reasons[r] = (sum.review_reasons[r] ?? 0) + 1;
        const n = await inStage("db_commit", () => deps.db.commit(ownerId, item.gmail_message_id, v.facts));
        sum.extracted++;
        sum.facts += n;
        sum.facts_for_review += v.facts.filter((f) => f.review_reasons.length > 0).length;
      } catch (e) {
        const code = `${errorStage(e)}:${modelOrErrorCode(e)}`.slice(0, 64);
        await deps.db.fail(ownerId, item.gmail_message_id, code).catch(() => undefined);
        sum.failed++;
        log({ event: "extract_item_failed", stage: errorStage(e), code });
      }
    }
  }
  if (budgetStopped) sum.status = "budget_stopped";
  log({ event: "extract_tick", ...sum });
  return sum;
}

/** Safe code for model errors (status and Anthropic's error type only). */
function modelOrErrorCode(e: unknown): string {
  const inner = e instanceof StageError ? e.cause : e;
  if (inner instanceof ModelError) return `anthropic:${inner.code}_${inner.httpStatus ?? ""}${inner.type ? `_${inner.type}` : ""}`;
  return errorCode(e);
}
