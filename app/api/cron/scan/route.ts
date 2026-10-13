import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/env";
import { getScanConfig } from "@/lib/scan/config";
import { tickErrorEvent } from "@/lib/scan/errors";
import { safeEqual, decryptSecret } from "@/lib/security/crypto";
import {
  getMessageHeaders,
  gmailTokenContext,
  listLabels,
  listMessageIds,
  refreshAccessToken,
  withRetry,
} from "@/lib/gmail/google";
import { createWorkerDb } from "@/lib/scan/db";
import { runTick } from "@/lib/scan/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called by Vercel Cron once a minute. Does nothing unless scanning is enabled
 * AND every scan setting is valid (lib/scan/config.ts). Requires the
 * CRON_SECRET bearer token Vercel sends. Processes at most one page of one
 * approved, owner-started scan.
 *
 * Logging (Stage 3.1.1): event names, counts, the failing stage and a safe
 * error code only, e.g. {"event":"scan_tick_error","stage":"db_claim","code":"pg_28P01"}.
 * Never messages, URLs, tokens, addresses or email data.
 */
export async function GET(request: NextRequest) {
  const scan = getScanConfig();
  if (!scan.enabled) {
    if (scan.reason === "misconfigured") {
      console.warn(JSON.stringify({ event: "scan_config_invalid", problems: scan.problems }));
      return NextResponse.json({ error: "scanning disabled: configuration" }, { status: 503 });
    }
    return new NextResponse(null, { status: 204 });
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${scan.cronSecret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = getServerEnv();
  if (!env.GOOGLE_GMAIL_CLIENT_ID || !env.GOOGLE_GMAIL_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) {
    console.warn(JSON.stringify({ event: "scan_tick_error", stage: "config", code: "gmail_settings_missing" }));
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const key = env.TOKEN_ENCRYPTION_KEY;
  const clientId = env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret = env.GOOGLE_GMAIL_CLIENT_SECRET;
  let close: (() => Promise<void>) | undefined;
  try {
    const worker = createWorkerDb(scan.workerDatabaseUrl, scan.workerDatabaseCa);
    close = worker.close;
    const result = await runTick({
      db: worker.db,
      decrypt: (enc, version, ownerId) => decryptSecret(enc, key, version, gmailTokenContext(ownerId)),
      gmail: {
        accessToken: (refreshToken) => refreshAccessToken({ refreshToken, clientId, clientSecret }),
        listLabels: (at) => withRetry(() => listLabels(at)),
        listIds: (at, pageToken) => withRetry(() => listMessageIds(at, pageToken)),
        getHeaders: (at, id) => withRetry(() => getMessageHeaders(at, id)),
      },
      log: (e) => console.info(JSON.stringify(e)),
    });
    return NextResponse.json({ status: result.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn(JSON.stringify(tickErrorEvent(e)));
    return NextResponse.json({ error: "tick failed" }, { status: 500 });
  } finally {
    await close?.().catch(() => {});
  }
}
