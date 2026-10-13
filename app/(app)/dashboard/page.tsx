import { requireUser } from "@/lib/auth/session";
import { PHASE, PHASE_LABEL, featureSummary } from "@/lib/features";
import { loadGmailPanel, type GmailPanel } from "@/lib/gmail/connection";
import { MAX_MESSAGES } from "@/lib/gmail/google";
import { connectGmail, disconnectGmail } from "../gmail-actions";

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
  searchParams: Promise<{ error?: string; gmail?: string }>;
}) {
  const user = await requireUser();
  const { error, gmail } = await searchParams;
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
        <dd>gmail.metadata (read-only headers)</dd>
      </dl>
      {disconnectForm}
    </div>
  );
}
