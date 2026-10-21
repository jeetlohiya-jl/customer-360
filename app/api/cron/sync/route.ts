import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/security/crypto";
import { getSyncConfig } from "@/lib/sync/config";
import { createSyncDb } from "@/lib/sync/db";
import { syncIo } from "@/lib/sync/deps";
import { runSyncTick } from "@/lib/sync/run";
import { tickErrorEvent } from "@/lib/scan/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Sync safety net, every 10 minutes (vercel.json). Does nothing unless
 * FEATURE_SYNC and every related setting are valid. Syncs mailboxes a push
 * marked but could not finish, any mailbox not synced for an hour, catch-ups
 * in progress, and renews Gmail watches before they expire. Requires the
 * CRON_SECRET bearer token. Logs counts and safe codes only.
 */
export async function GET(request: NextRequest) {
  const cfg = getSyncConfig();
  if (!cfg.enabled) {
    if (cfg.reason === "misconfigured") {
      console.warn(JSON.stringify({ event: "sync_config_invalid", problems: cfg.problems }));
      return NextResponse.json({ error: "sync disabled: configuration" }, { status: 503 });
    }
    return new NextResponse(null, { status: 204 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${cfg.cronSecret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const io = syncIo(cfg);
  if (!io) return NextResponse.json({ error: "not configured" }, { status: 503 });

  const worker = createSyncDb(cfg.workerDatabaseUrl, cfg.workerDatabaseCa);
  try {
    const sum = await runSyncTick({ db: worker.db, ...io, limit: 5, log: (e) => console.info(JSON.stringify(e)) });
    return NextResponse.json({ mailboxes: sum.mailboxes }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn(JSON.stringify({ ...tickErrorEvent(e), event: "sync_tick_error" }));
    return NextResponse.json({ error: "tick failed" }, { status: 500 });
  } finally {
    await worker.close().catch(() => {});
  }
}
