import { after, NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/env";
import { slackApi } from "@/lib/slack/api";
import { getSlackConfig } from "@/lib/slack/config";
import { createSlackDb } from "@/lib/slack/db";
import { anthropicAnswerModel } from "@/lib/slack/model";
import { handleDm } from "@/lib/slack/run";
import { parseEnvelope, verifySlackSignature } from "@/lib/slack/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Slack Events API endpoint for the DM assistant (behind FEATURE_SLACK, off).
 * Every request must carry a valid Slack signature less than 5 minutes old.
 * Slack needs an answer within 3 seconds, so the request is acknowledged at
 * once and the question is answered right after (next/server `after`).
 * Message text is never logged.
 */
export async function POST(request: NextRequest) {
  const cfg = getSlackConfig();
  if (!cfg.enabled) {
    if (cfg.reason === "misconfigured") console.warn(JSON.stringify({ event: "slack_config_invalid", problems: cfg.problems }));
    return new NextResponse(null, { status: 404 });
  }
  const raw = await request.text();
  if (raw.length > 100_000) return new NextResponse(null, { status: 413 });
  const ok = verifySlackSignature(cfg.signingSecret, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), raw);
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const envelope = parseEnvelope(body);
  if (envelope.kind === "url_verification") return NextResponse.json({ challenge: envelope.challenge });
  if (envelope.kind === "ignore") return new NextResponse(null, { status: 200 });

  const appUrl = getServerEnv().APP_BASE_URL;
  after(async () => {
    const worker = createSlackDb(cfg.workerDatabaseUrl, cfg.workerDatabaseCa);
    try {
      await handleDm(
        {
          db: worker.db,
          slack: slackApi(cfg.botToken),
          model: anthropicAnswerModel(cfg.anthropicApiKey),
          appUrl,
          log: (e) => console.info(JSON.stringify(e)),
        },
        { eventId: envelope.eventId, user: envelope.user, channel: envelope.channel, text: envelope.text, ts: envelope.ts },
      );
    } finally {
      await worker.close().catch(() => {});
    }
  });
  return new NextResponse(null, { status: 200 });
}
