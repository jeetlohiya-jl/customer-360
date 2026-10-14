import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/env";
import { decryptSecret, safeEqual } from "@/lib/security/crypto";
import { getMessageFull, gmailTokenContext, listLabels, refreshAccessToken, withRetry } from "@/lib/gmail/google";
import { getExtractConfig } from "@/lib/extract/config";
import { createExtractDb } from "@/lib/extract/db";
import { anthropicModel } from "@/lib/extract/model";
import { runExtractTick } from "@/lib/extract/run";
import { tickErrorEvent } from "@/lib/scan/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stage B + C extraction run. NOT scheduled: vercel.json has no cron entry for
 * this route until extraction is approved. Does nothing unless FEATURE_EXTRACT
 * and every related setting are valid (lib/extract/config.ts). Requires the
 * CRON_SECRET bearer token. Logs event names, counts and safe codes only.
 */
export async function GET(request: NextRequest) {
  const cfg = getExtractConfig();
  if (!cfg.enabled) {
    if (cfg.reason === "misconfigured") {
      console.warn(JSON.stringify({ event: "extract_config_invalid", problems: cfg.problems }));
      return NextResponse.json({ error: "extraction disabled: configuration" }, { status: 503 });
    }
    return new NextResponse(null, { status: 204 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${cfg.cronSecret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = getServerEnv();
  if (!env.GOOGLE_GMAIL_CLIENT_ID || !env.GOOGLE_GMAIL_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) {
    console.warn(JSON.stringify({ event: "extract_tick_error", stage: "config", code: "gmail_settings_missing" }));
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const key = env.TOKEN_ENCRYPTION_KEY;
  const clientId = env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret = env.GOOGLE_GMAIL_CLIENT_SECRET;
  let close: (() => Promise<void>) | undefined;
  try {
    const worker = createExtractDb(cfg.workerDatabaseUrl, cfg.workerDatabaseCa);
    close = worker.close;
    const summary = await runExtractTick({
      db: worker.db,
      model: anthropicModel(cfg.anthropicApiKey),
      decrypt: (enc, version, ownerId) => decryptSecret(enc, key, version, gmailTokenContext(ownerId)),
      gmail: {
        accessToken: (refreshToken) => refreshAccessToken({ refreshToken, clientId, clientSecret }),
        listLabels: (at) => withRetry(() => listLabels(at)),
        getMessage: (at, id) => withRetry(() => getMessageFull(at, id)),
      },
      limit: 25,
      log: (e) => console.info(JSON.stringify(e)),
    });
    return NextResponse.json({ status: summary.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn(JSON.stringify({ ...tickErrorEvent(e), event: "extract_tick_error" }));
    return NextResponse.json({ error: "tick failed" }, { status: 500 });
  } finally {
    await close?.().catch(() => {});
  }
}
