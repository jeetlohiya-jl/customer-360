/**
 * Stage 3.2 search: parsing of page parameters, cursors and Gmail links.
 * Pure functions (no I/O) so they are unit tested. The database re-validates
 * everything and enforces access; this layer only gives friendly errors.
 */
import { z } from "zod";

export const PAGE_SIZE = 50;
const GMAIL_ID = /^[0-9a-zA-Z_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const validDay = (v: string) => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : Array.isArray(v) ? v[0] : v);

const schema = z
  .object({
    q: z.preprocess(blankToUndef, z.string().trim().min(2, "Search text needs at least 2 characters").max(100, "Search text is limited to 100 characters").optional()),
    customer: z.preprocess(blankToUndef, z.string().regex(UUID, "Unknown customer").optional()),
    from: z.preprocess(blankToUndef, z.string().refine(validDay, "From date must be a real date (YYYY-MM-DD)").optional()),
    to: z.preprocess(blankToUndef, z.string().refine(validDay, "To date must be a real date (YYYY-MM-DD)").optional()),
    direction: z.preprocess(blankToUndef, z.enum(["inbound", "outbound", "internal"], { error: "Unknown direction" }).optional()),
    mailbox: z.preprocess(blankToUndef, z.string().trim().max(254).optional()),
    after: z.preprocess(blankToUndef, z.string().max(200).optional()),
  })
  .refine((p) => !p.from || !p.to || p.from <= p.to, { message: "From date is after the to date", path: ["from"] });

export type SearchParams = {
  q?: string;
  customer?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound" | "internal";
  mailbox?: string;
  cursor?: Cursor;
};
export type Cursor = { at: string; id: string };

export function parseSearchParams(raw: Record<string, string | string[] | undefined>): { ok: true; params: SearchParams } | { ok: false; errors: string[] } {
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, errors: [...new Set(r.error.issues.map((i) => i.message))] };
  const { after, ...rest } = r.data;
  const cursor = after ? decodeCursor(after) : undefined;
  if (after && !cursor) return { ok: false, errors: ["That page link is no longer valid. Start the search again."] };
  return { ok: true, params: { ...rest, cursor } };
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return undefined;
  const [at, id, extra] = Buffer.from(s, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) return undefined;
  return { at: new Date(at).toISOString(), id: id.toLowerCase() };
}

/** Arguments for public.search_my_links. Asks for one extra row to know if there is a next page. */
export function rpcArgs(p: SearchParams, pageSize = PAGE_SIZE) {
  return {
    p_query: p.q ?? null,
    p_customer: p.customer ?? null,
    p_from: p.from ?? null,
    p_to: p.to ?? null,
    p_direction: p.direction ?? null,
    p_mailbox: p.mailbox ?? null,
    p_cursor_at: p.cursor?.at ?? null,
    p_cursor_id: p.cursor?.id ?? null,
    p_limit: pageSize + 1,
  };
}

export type ResultRow = { link_id: string; message_at: string };

/** Splits the extra row off and returns the cursor for the next page, if any. */
export function paginate<T extends ResultRow>(rows: T[], pageSize = PAGE_SIZE): { rows: T[]; next?: string } {
  if (rows.length <= pageSize) return { rows };
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { rows: page, next: encodeCursor({ at: last.message_at, id: last.link_id }) };
}

/** Query string for a page link, keeping the filters. */
export function pageHref(p: SearchParams, after?: string): string {
  const qs = new URLSearchParams();
  for (const k of ["q", "customer", "from", "to", "direction", "mailbox"] as const) {
    const v = p[k];
    if (v) qs.set(k, v);
  }
  if (after) qs.set("after", after);
  const s = qs.toString();
  return s ? `/search?${s}` : "/search";
}

/**
 * Link that opens the message in Gmail. `authuser` makes Gmail pick the right
 * account when several are signed in. It only opens for someone signed in to
 * that mailbox. Returns null for anything that is not a plain Gmail id.
 */
export function gmailMessageUrl(messageId: string, mailbox?: string | null): string | null {
  if (!GMAIL_ID.test(messageId)) return null;
  const who = mailbox && /^[^@\s]{1,64}@[^@\s]{1,253}$/.test(mailbox) ? `?authuser=${encodeURIComponent(mailbox.toLowerCase())}` : "u/0/";
  return `https://mail.google.com/mail/${who}#all/${messageId}`;
}
