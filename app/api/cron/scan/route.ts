import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/env";
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
 * Called by Vercel Cron once a minute. Does nothing unless FEATURE_SCAN=on.
 * Requires the CRON_SECRET bearer token Vercel sends. Processes at most one
 * page of one approved, owner-started scan. Logs counts only.
 */
export async function GET(request: NextRequest) {
  const env = getServerEnv();
  if (env.FEATURE_SCAN !== "on") return new NextResponse(null, { status: 204 });

  const auth = request.headers.get("authorization") ?? "";
  if (!env.CRON_SECRET || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.WORKER_DATABASE_URL || !env.GOOGLE_GMAIL_CLIENT_ID || !env.GOOGLE_GMAIL_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) {
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const key = env.TOKEN_ENCRYPTION_KEY;
  const clientId = env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret = env.GOOGLE_GMAIL_CLIENT_SECRET;
  const { db, close } = createWorkerDb(env.WORKER_DATABASE_URL, env.WORKER_DATABASE_CA);
  try {
    const result = await runTick({
      db,
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
  } catch {
    console.warn(JSON.stringify({ event: "scan_tick_error" }));
    return NextResponse.json({ error: "tick failed" }, { status: 500 });
  } finally {
    await close();
  }
}
