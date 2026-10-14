/**
 * Stage B: turning one Gmail message into clean plain text, in memory only.
 *
 *   mime    -> plain text (text/plain preferred, HTML converted), attachments skipped
 *   cleanup -> quoted replies, signatures and disclaimers removed, length capped
 *   prefilter -> free rules that skip emails unlikely to hold business facts
 *
 * Nothing here logs, stores or throws message content. Pure functions.
 */
import type { GmailPart } from "@/lib/gmail/google";

export const MAX_TEXT_CHARS = 12_000;

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

export interface MimeText {
  text: string;
  /** Whether the text came from an HTML part. */
  fromHtml: boolean;
  /** Number of attachments seen (never read). */
  attachments: number;
  /** A text/calendar part was present. */
  calendar: boolean;
}

function decode(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n") // quoted replies in HTML mail
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? " ")
    .replace(/&#(\d{1,5});/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n");
}

export function mimeText(root: GmailPart): MimeText {
  const plain: string[] = [];
  const html: string[] = [];
  let attachments = 0;
  let calendar = false;
  const walk = (p: GmailPart, depth: number) => {
    if (depth > 12) return;
    const type = (p.mimeType ?? "").toLowerCase();
    if (p.filename || p.body?.attachmentId) {
      attachments++;
      if (type === "text/calendar") calendar = true;
      return; // attachments are never read
    }
    if (type === "text/calendar") calendar = true;
    else if (type === "text/plain") plain.push(decode(p.body?.data));
    else if (type === "text/html") html.push(decode(p.body?.data));
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  if (plain.join("").trim()) return { text: plain.join("\n"), fromHtml: false, attachments, calendar };
  return { text: htmlToText(html.join("\n")), fromHtml: true, attachments, calendar };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Lines where an earlier message in the thread starts. Everything from here on is cut. */
const QUOTE_START: RegExp[] = [
  /^On .{1,300}wrote:\s*$/m,
  /^On .{1,200}\n.{1,200}wrote:\s*$/m, // Gmail wraps long "On ... wrote:" lines
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{10,}\s*$/m, // Outlook separator
  /^From:\s.+\n(?:Sent|Date):\s/m,
  /^De\s?:\s.+\n(?:Envoy|Date)/m,
];
/** Signature and footer starts. */
const SIGNATURE_START: RegExp[] = [
  /^--\s*$/m,
  /^(?:Sent from my (?:iPhone|iPad|Android|mobile)|Get Outlook for)/im,
  /^(?:CONFIDENTIALITY NOTICE|DISCLAIMER|This (?:e-?mail|message) (?:and any attachments )?(?:is|may be) confidential)/im,
];

export interface CleanText {
  text: string;
  truncated: boolean;
}

export function cleanBody(raw: string): CleanText {
  let text = raw.replace(/\r\n?/g, "\n");
  let cut = text.length;
  for (const re of [...QUOTE_START, ...SIGNATURE_START]) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);
  text = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l)) // quoted lines
    .join("\n")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = text.length > MAX_TEXT_CHARS;
  return { text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}

// ---------------------------------------------------------------------------
// Pre-filter (free rules; reason codes match private.extraction_state.skip_reason)
// ---------------------------------------------------------------------------

export type SkipReason = "auto_reply" | "bulk" | "calendar" | "delivery_notice" | "too_short" | "acknowledgement" | "empty";

const ACK_ONLY = /^(?:hi|hello|dear)?[\s\w,.!-]{0,20}?(?:thanks?(?: you)?(?: so much)?|thank you|noted|received|ok(?:ay)?|got it|will do|sounds good|great|perfect|appreciate(?:d| it))[\s,.!]*(?:regards|best|cheers|thanks)?[\s\w,.!-]{0,80}$/i;

export function prefilter(headers: Record<string, string>, clean: string, mime: Pick<MimeText, "calendar">): SkipReason | null {
  const h = (k: string) => (headers[k.toLowerCase()] ?? "").toLowerCase();
  const auto = h("auto-submitted");
  if ((auto && auto !== "no") || h("x-autoreply") || h("x-autorespond") || /^(?:automatic reply|auto(?:matic)?[- ]reply|out of (?:the )?office)/.test(h("subject"))) {
    return "auto_reply";
  }
  if (/^(?:mailer-daemon|postmaster)@/.test(h("from").replace(/^.*</, "")) || /^(?:undeliverable|delivery status notification|mail delivery failed)/.test(h("subject"))) {
    return "delivery_notice";
  }
  if (["bulk", "junk", "list"].includes(h("precedence")) || h("list-unsubscribe") || h("list-id")) return "bulk";
  if (mime.calendar || /^(?:invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event):/.test(h("subject"))) {
    return "calendar";
  }
  const body = clean.trim();
  if (!body) return "empty";
  if (body.length < 12 || (body.length < 40 && !/\d/.test(body))) return "too_short";
  if (body.length < 160 && !/\d/.test(body) && ACK_ONLY.test(body.replace(/\s+/g, " "))) return "acknowledgement";
  return null;
}
