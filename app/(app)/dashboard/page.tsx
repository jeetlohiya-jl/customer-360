import { requireUser } from "@/lib/auth/session";
import { PHASE, PHASE_LABEL, featureSummary } from "@/lib/features";
import { loadGmailPanel, type GmailPanel } from "@/lib/gmail/connection";
import { GMAIL_READONLY_SCOPE, MAX_MESSAGES } from "@/lib/gmail/google";
import { connectGmail, disconnectGmail } from "../gmail-actions";
import { cancelScan, resumeScan, startScan } from "../scan-actions";
import { getScanConfig } from "@/lib/scan/config";
import { getExtractConfig } from "@/lib/extract/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";

type ScanJob = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  pages_done: number;
  enumerated: number;
  excluded_rule: number;
  excluded_privacy: number;
  excluded_internal: number;
  matched: number;
  in_review: number;
  unmatched: number;
  weak_evidence_only: number;
  failed: number;
  newer_than_cutoff: number;
  last_error: string | null;
};

const SCAN_NOTICES: Record<string, string> = {
  started: "Scan requested. It runs in the background, one page of up to 250 messages a minute, reading headers only.",
  cancel_requested: "Cancel requested. The scan stops after the current page.",
  resumed: "Scan resumed.",
  disabled: "Mailbox scanning is turned off in this environment.",
};

const NOTICES: Record<string, { text: string; alert?: boolean }> = {
  connected: { text: "Gmail connected. The five most recent messages were read through the Gmail API below." },
  disconnected: { text: "Gmail disconnected. Access was revoked at Google and the stored authorization was deleted." },
  disconnected_local: {
    text: "Gmail disconnected here. Google did not confirm revocation; you can also remove access at myaccount.google.com/permissions.",
    alert: true,
  },
  denied: { text: "You declined Gmail access. Nothing was stored.", alert: true },
  invalid_state: { text: "The Gmail authorization could not be verified. Please try again.", alert: true },
  token_exchange_failed: { text: "Google did not complete the authorization. Please try again.", alert: true },
  no_refresh_token: { text: "Google did not grant lasting access. Please try again.", alert: true },
  scope_not_granted: { text: "The Gmail permission was not granted, so nothing was connected.", alert: true },
  mailbox_mismatch: {
    text: "That Google account is not your Customer 360 account. Only your own mailbox can be connected; the authorization was revoked.",
    alert: true,
  },
  store_failed: { text: "The connection could not be saved. The authorization was revoked; please try again.", alert: true },
  disabled: { text: "Gmail connection is turned off in this environment.", alert: true },
};

const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (iso: string) => (iso ? `${fmt.format(new Date(iso))} UTC` : "unknown date");

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; gmail?: string; scan?: string; scan_error?: string }>;
}) {
  const user = await requireUser();
  const { error, gmail, scan, scan_error } = await searchParams;
  const scanConfig = getScanConfig();
  const scanOn = scanConfig.enabled;
  const scanMisconfigured = !scanConfig.enabled && scanConfig.reason === "misconfigured";
  const supabase = await createSupabaseServerClient();
  const { data: jobsData } = await supabase.rpc("my_scan_jobs");
  const jobs = (jobsData ?? []) as ScanJob[];
  const extractOn = getExtractConfig().enabled;
  const { data: exData } = extractOn ? await supabase.rpc("my_extraction_status") : { data: null };
  const ex = ((exData ?? []) as { pending: number; extracted: number; skipped: number; failed: number; needs_reconnect: number; facts: number; facts_needs_review: number }[])[0];
  const features = featureSummary();
  const panel = await loadGmailPanel(user);
  const notice = gmail ? NOTICES[gmail] : undefined;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Dashboard</span>
        <h1 className="h1">
          Your <em>Customer 360</em> workspace.
        </h1>
        <p className="lead">Connect your mailbox to test read access. Only message headers are read, and nothing is stored.</p>
      </div>

      {error === "forbidden" ? (
        <p className="notice alert" role="alert">
          That page is for administrators.
        </p>
      ) : null}
      {scan && SCAN_NOTICES[scan] ? <p className="notice" role="status">{SCAN_NOTICES[scan]}</p> : null}
      {scan_error ? <p className="notice alert" role="alert">Scan not changed: {scan_error}</p> : null}
      {notice ? (
        <p className={notice.alert ? "notice alert" : "notice"} role="status">
          {notice.text}
        </p>
      ) : null}

      <section className="section">
        <div className="section-num">01 · Gmail connection</div>
        <div className="grid">
          <GmailCard panel={panel} />
          <div className="card cream">
            <span className="eyebrow">Your account</span>
            <h3>{user.email}</h3>
            <dl>
              <dt>Role</dt>
              <dd>{user.role}</dd>
              <dt>Status</dt>
              <dd>{user.status}</dd>
              <dt>Build</dt>
              <dd>Phase {PHASE} · {PHASE_LABEL}</dd>
              <dt>Slack</dt>
              <dd>
                <span className="pill off">{features.slack}</span>
              </dd>
            </dl>
          </div>
        </div>
      </section>

      {panel.state === "connected" || panel.state === "revoked" || jobs.length ? (
        <section className="section">
          <div className="section-num">03 · Customer email scan</div>
          <ScanCard jobs={jobs} enabled={scanOn} misconfigured={scanMisconfigured} />
        </section>
      ) : null}

      {extractOn && ex ? (
        <section className="section">
          <div className="section-num">04 · Customer facts from your mailbox</div>
          <div className="card">
            <span className="eyebrow">AI extraction · your mailbox only</span>
            <div className="stats mt-16">
              <span className="stat"><strong>{ex.extracted}</strong>emails processed</span>
              <span className="stat"><strong>{ex.pending}</strong>waiting</span>
              <span className="stat"><strong>{ex.skipped}</strong>skipped</span>
              <span className="stat"><strong>{ex.failed}</strong>failed</span>
              <span className="stat"><strong>{ex.facts}</strong>facts</span>
              <span className="stat"><strong>{ex.facts_needs_review}</strong>to review</span>
            </div>
            {ex.needs_reconnect ? <p className="small">{ex.needs_reconnect} emails wait until you reconnect Gmail with content access.</p> : null}
            <div className="card-actions"><Link href="/facts" className="small">Open customer facts</Link></div>
          </div>
        </section>
      ) : null}

      {panel.state === "connected" ? (
        <section className="section">
          <div className="section-num">02 · Recent messages</div>
          <div className="card">
            <span className="eyebrow">
              Live from the Gmail API · {panel.messages.length} of max {MAX_MESSAGES}
            </span>
            <h3>
              Latest in <em>{panel.mailbox}</em>
            </h3>
            {panel.messages.length === 0 ? (
              <p className="small">The mailbox returned no messages.</p>
            ) : (
              <ul className="messages">
                {panel.messages.map((m) => (
                  <li key={m.id}>
                    <span className="msg-subject">{m.subject}</span>
                    <span className="msg-meta">
                      <span>{m.from}</span>
                      <span>{when(m.date)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine">
              Read at {when(panel.fetchedAt)} in {panel.elapsedMs} ms with the gmail.metadata permission (headers only).
              Shown for this page view; not saved.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}

function GmailCard({ panel }: { panel: GmailPanel }) {
  if (panel.state === "disabled") {
    return (
      <div className="card">
        <span className="eyebrow">Gmail</span>
        <h3>Not available here</h3>
        <span className="pill off">off</span>
        <p className="small">
          Gmail connection is turned off in this environment.
        </p>
      </div>
    );
  }

  if (panel.state === "not_connected") {
    return (
      <div className="card dark">
        <span className="eyebrow">Gmail · not connected</span>
        <h3>Connect your mailbox</h3>
        <p className="small">
          Google will ask you to allow Customer 360 to view your email message metadata (subjects, senders, dates; never
          the content). You can disconnect at any time.
        </p>
        <form action={connectGmail} className="card-actions">
          <button type="submit" className="btn-secondary">
            Connect Gmail
          </button>
        </form>
      </div>
    );
  }

  const disconnectForm = (
    <form action={disconnectGmail} className="card-actions">
      <button type="submit" className="btn-secondary">
        Disconnect Gmail
      </button>
    </form>
  );

  if (panel.state === "revoked") {
    return (
      <div className="card">
        <span className="eyebrow">Gmail</span>
        <h3>{panel.mailbox}</h3>
        <span className="pill warn">access revoked</span>
        <p className="small">Google no longer accepts this authorization. Disconnect, then connect again.</p>
        {disconnectForm}
      </div>
    );
  }

  if (panel.state === "error") {
    return (
      <div className="card">
        <span className="eyebrow">Gmail</span>
        <h3>{panel.mailbox}</h3>
        <span className="pill warn">temporarily unavailable</span>
        <p className="small">The Gmail API request failed ({panel.code}). Reload to try again.</p>
        {disconnectForm}
      </div>
    );
  }

  return (
    <div className="card">
      <span className="eyebrow">Gmail · connected</span>
      <h3>{panel.mailbox}</h3>
      <span className="pill">connected</span>
      <dl>
        <dt>Since</dt>
        <dd>{when(panel.connectedAt)}</dd>
        <dt>Permission</dt>
        <dd>
          {panel.scopes.includes(GMAIL_READONLY_SCOPE)
            ? "gmail.readonly (read-only, includes email content)"
            : "gmail.metadata (read-only headers)"}
        </dd>
      </dl>
      {disconnectForm}
    </div>
  );
}

const fmtDay = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function ScanCard({ jobs, enabled, misconfigured }: { jobs: ScanJob[]; enabled: boolean; misconfigured: boolean }) {
  const job = jobs[0];
  const active = job && ["queued", "running", "cancelling", "paused_auth"].includes(job.status);
  return (
    <div className="card">
      <span className="eyebrow">Headers only · your mailbox only</span>
      <h3>{job ? `Last scan: ${job.status.replace("_", " ")}` : "No scan yet"}</h3>
      <p className="small">
        Reads sender, recipients, subject and date of each message (never the content), matches them against the customer list and
        keeps only customer-linked references. Subjects are not stored. Internal-only, private and credential emails are skipped. Label an
        email <code>C360-Exclude</code> in Gmail to keep it out.
      </p>
      {job ? (
        <div className="stats mt-16">
          <span className="stat"><strong>{job.enumerated}</strong>examined</span>
          <span className="stat"><strong>{job.matched}</strong>linked to customers</span>
          <span className="stat"><strong>{job.in_review}</strong>awaiting review</span>
          <span className="stat"><strong>{job.unmatched}</strong>no customer</span>
          <span className="stat"><strong>{job.excluded_rule + job.excluded_privacy + job.excluded_internal}</strong>excluded</span>
          {job.failed ? <span className="stat"><strong>{job.failed}</strong>failed</span> : null}
        </div>
      ) : null}
      {job ? (
        <p className="fine">
          Started {fmtDay.format(new Date(job.created_at))} UTC · {job.pages_done} pages
          {job.finished_at ? ` · finished ${fmtDay.format(new Date(job.finished_at))} UTC` : ""}
          {job.last_error ? ` · last error: ${job.last_error}` : ""}
        </p>
      ) : null}
      <div className="card-actions">
        {!enabled ? <span className="pill off">{misconfigured ? "scanning off: setting needs attention" : "scanning off"}</span> : null}
        {enabled && !active ? (
          <form action={startScan}><button type="submit" className="btn-primary">Scan my mailbox</button></form>
        ) : null}
        {enabled && job && ["queued", "running", "paused_auth"].includes(job.status) ? (
          <form action={cancelScan}><button type="submit" className="btn-secondary">Cancel scan</button></form>
        ) : null}
        {enabled && job?.status === "paused_auth" ? (
          <form action={resumeScan}><button type="submit" className="btn-secondary">Resume after reconnecting</button></form>
        ) : null}
        <Link href="/my-customers" className="small">My customer-linked emails</Link>
        <Link href="/search" className="small">Search</Link>
      </div>
    </div>
  );
}
