import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/security/crypto";

/** Slack signs every request; anything older than 5 minutes is refused (replay protection). */
export const MAX_SKEW_SECONDS = 300;

/**
 * Verifies Slack's request signature (v0 HMAC-SHA256 over "v0:<timestamp>:<raw body>").
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return safeEqual(expected, signature);
}

/** The parts of a Slack Events API payload the bot uses. Everything else is ignored. */
export type SlackEnvelope =
  | { kind: "url_verification"; challenge: string }
  | { kind: "dm"; eventId: string; user: string; channel: string; text: string }
  | { kind: "ignore" };

/** Only plain messages a person types in a DM with the bot. Bot messages, edits, joins, files etc. are ignored. */
export function parseEnvelope(body: unknown): SlackEnvelope {
  if (!body || typeof body !== "object") return { kind: "ignore" };
  const b = body as Record<string, unknown>;
  if (b.type === "url_verification" && typeof b.challenge === "string" && b.challenge.length <= 200) {
    return { kind: "url_verification", challenge: b.challenge };
  }
  if (b.type !== "event_callback" || typeof b.event_id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(b.event_id)) return { kind: "ignore" };
  const e = (b.event ?? {}) as Record<string, unknown>;
  if (e.type !== "message" || e.channel_type !== "im" || e.subtype !== undefined || e.bot_id !== undefined) return { kind: "ignore" };
  if (typeof e.user !== "string" || !/^[UW][A-Z0-9]{2,20}$/.test(e.user)) return { kind: "ignore" };
  if (typeof e.channel !== "string" || !/^D[A-Z0-9]{2,20}$/.test(e.channel)) return { kind: "ignore" };
  if (typeof e.text !== "string" || e.text.trim() === "") return { kind: "ignore" };
  return { kind: "dm", eventId: b.event_id, user: e.user, channel: e.channel, text: e.text };
}
