/**
 * Thread follow-ups (0013): internal-only replies and forwards in a customer's
 * Gmail thread ("RE: 1C & 2C fiber trays" between colleagues) carry most of the
 * next steps, but a header-only rule can't tie them to the customer. Two parts:
 *
 *  1. Each internal-only message is handed to the database as a follow-up. It
 *     is linked only to customers the SAME mailbox already has in that thread.
 *  2. When a page or sync step links messages in a thread, the thread's other
 *     messages may already have been seen (a scan reads newest first, so
 *     colleagues' later replies come before the customer's first email). The
 *     thread's headers are read (once per page or step, at most
 *     MAX_THREADS_PER_STEP threads) and its internal-only messages become
 *     follow-ups too. Re-reading an already known thread is harmless: links
 *     are unique.
 *
 * Nothing is stored for a thread that never links to a customer. Pure apart
 * from the injected Gmail call; errors here never fail a page (the follow-ups
 * are a bonus, the page's own links are what matter).
 */
import type { MessageHeaders } from "@/lib/gmail/google";
import type { MatcherIndex } from "@/lib/customers/matcher";
import { classifyMessage, type ClassifyContext, type LinkOut, type ThreadFollowup } from "./classify";

/** At most this many threads are read per page or sync step (Gmail quota: threads.get costs 10 units). */
export const MAX_THREADS_PER_STEP = 100;
/** At most this many follow-ups are sent per page or step (the database ignores more). */
export const MAX_FOLLOWUPS = 5000;

export async function expandThreads(opts: {
  links: LinkOut[];
  seenIds: Set<string>;
  getThread: (threadId: string) => Promise<MessageHeaders[]>;
  index: MatcherIndex;
  ctx: ClassifyContext;
  concurrency?: number;
  log?: (event: Record<string, unknown>) => void;
}): Promise<ThreadFollowup[]> {
  if ((opts.ctx.internalLinking ?? "off") === "off") return [];
  const threads = [...new Set(opts.links.map((l) => l.gmail_thread_id).filter((t): t is string => !!t))].slice(0, MAX_THREADS_PER_STEP);
  const out: ThreadFollowup[] = [];
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, threads.length) }, async () => {
      while (next < threads.length) {
        const threadId = threads[next++];
        let messages: MessageHeaders[];
        try {
          messages = await opts.getThread(threadId);
        } catch {
          failed++;
          continue;
        }
        for (const m of messages) {
          if (opts.seenIds.has(m.id)) continue;
          const r = classifyMessage(m, opts.index, opts.ctx);
          if (r.followup) out.push(r.followup);
        }
      }
    }),
  );
  if (failed) opts.log?.({ event: "thread_expand_failed", threads: failed });
  return out.slice(0, MAX_FOLLOWUPS);
}

/** Follow-ups are sent to the database in the links list, marked, with no customer. */
export function followupItems(f: ThreadFollowup[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return f
    .filter((x) => (seen.has(x.gmail_message_id) ? false : (seen.add(x.gmail_message_id), true)))
    .slice(0, MAX_FOLLOWUPS)
    .map((x) => ({ thread_followup: true, ...x }));
}
