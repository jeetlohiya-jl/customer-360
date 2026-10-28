/**
 * The two Slack Web API calls the bot makes: who is asking (users.info) and
 * the reply (chat.postMessage). Errors carry Slack's machine-readable error
 * code only, never a response body.
 */
type Fetch = typeof fetch;

export class SlackError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    super(code);
    this.name = "SlackError";
  }
}

const safe = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : "error");

export interface SlackApi {
  /** The email on the person's Slack profile; null for bots, deleted users or no email. */
  userEmail(userId: string): Promise<string | null>;
  post(channel: string, text: string): Promise<void>;
  /**
   * The person's own earlier messages in this DM (newest first), sent within
   * `withinSeconds` before `beforeTs`. Used only to understand a follow-up
   * ("this account", or a bare customer name); never logged or stored.
   */
  earlierMessages(channel: string, user: string, beforeTs: string, withinSeconds: number): Promise<{ text: string; ts: string }[]>;
}

export function slackApi(botToken: string, fetchImpl: Fetch = fetch): SlackApi {
  const call = async (method: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(`https://slack.com/api/${method}`, {
        ...init,
        headers: { authorization: `Bearer ${botToken}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SlackError("network_error");
    }
    if (!res.ok) throw new SlackError("http_error", res.status);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.ok !== true) throw new SlackError(safe(body.error), res.status);
    return body;
  };
  return {
    async userEmail(userId) {
      if (!/^[UW][A-Z0-9]{2,20}$/.test(userId)) throw new SlackError("bad_user_id");
      const body = await call(`users.info?user=${encodeURIComponent(userId)}`, { method: "GET" });
      const u = (body.user ?? {}) as { deleted?: boolean; is_bot?: boolean; profile?: { email?: unknown } };
      if (u.deleted || u.is_bot) return null;
      return typeof u.profile?.email === "string" ? u.profile.email.toLowerCase() : null;
    },
    async earlierMessages(channel, user, beforeTs, withinSeconds) {
      if (!/^D[A-Z0-9]{2,20}$/.test(channel) || !/^\d{9,11}\.\d{1,8}$/.test(beforeTs)) throw new SlackError("bad_history_args");
      const oldest = (Number(beforeTs) - withinSeconds).toFixed(6);
      const body = await call(
        `conversations.history?channel=${encodeURIComponent(channel)}&latest=${beforeTs}&oldest=${oldest}&inclusive=false&limit=10`,
        { method: "GET" },
      );
      const msgs = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
      return msgs
        .filter((m) => m.user === user && m.bot_id === undefined && m.subtype === undefined && typeof m.text === "string" && typeof m.ts === "string")
        .map((m) => ({ text: (m.text as string).slice(0, 1000), ts: m.ts as string }));
    },
    async post(channel, text) {
      await call("chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      });
    },
  };
}
