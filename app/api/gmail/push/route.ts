import { after, NextResponse, type NextRequest } from "next/server";
import { getSyncConfig } from "@/lib/sync/config";
import { createSyncDb } from "@/lib/sync/db";
import { syncIo } from "@/lib/sync/deps";
import { parsePush, verifyPushToken } from "@/lib/sync/oidc";
import { runSyncTick } from "@/lib/sync/run";
import { tickErrorEvent } from "@/lib/scan/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Gmail push endpoint (behind FEATURE_SYNC, off). Google Pub/Sub calls it when
 * an approved mailbox changes. Every request must carry a Google-signed OIDC
 * token for this URL from the configured service account. The notification
 * holds only a mailbox address and a history id; the mailbox is synced right
 * after the request is acknowledged. Logs counts and safe codes only.
 */
export async function POST(request: NextRequest) {
  const cfg = getSyncConfig();
  if (!cfg.enabled) {
    if (cfg.reason === "misconfigured") console.warn(JSON.stringify({ event: "sync_config_invalid", problems: cfg.problems }));
    return new NextResponse(null, { status: 404 });
  }
  const ok = await verifyPushToken(request.headers.get("authorization"), { audience: cfg.pushAudience, email: cfg.pushServiceAccount }).catch(() => false);
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = await request.text();
  if (raw.length > 20_000) return new NextResponse(null, { status: 204 });
  let note: ReturnType<typeof parsePush> = null;
  try {
    note = parsePush(JSON.parse(raw));
  } catch {
    note = null;
  }
  // Malformed notifications are acknowledged and dropped (a retry would not fix them).
  if (!note) return new NextResponse(null, { status: 204 });

  const io = syncIo(cfg);
  if (!io) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const worker = createSyncDb(cfg.workerDatabaseUrl, cfg.workerDatabaseCa);
  let owner: string | null;
  try {
    owner = await worker.db.push(note.emailAddress, note.historyId);
  } catch (e) {
    await worker.close().catch(() => {});
    console.warn(JSON.stringify({ ...tickErrorEvent(e), event: "sync_push_error" }));
    return NextResponse.json({ error: "retry" }, { status: 500 }); // Pub/Sub retries
  }
  if (!owner) {
    await worker.close().catch(() => {});
    return new NextResponse(null, { status: 204 }); // not an approved, scanned mailbox: ignore
  }
  after(async () => {
    try {
      await runSyncTick({ db: worker.db, ...io, owner: owner!, limit: 1, log: (e) => console.info(JSON.stringify(e)) });
    } catch (e) {
      console.warn(JSON.stringify({ ...tickErrorEvent(e), event: "sync_push_error" }));
    } finally {
      await worker.close().catch(() => {});
    }
  });
  return new NextResponse(null, { status: 204 });
}
