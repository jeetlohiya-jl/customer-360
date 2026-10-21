# Phase 5: new email sync (Gmail push + safety net)

Keeps every approved mailbox in step with new email after its one-off scan.
Off until `FEATURE_SYNC=on` and its settings are valid.

## How it works

1. **Watch.** For each mailbox that is on the scan allowlist, is connected and
   has a completed scan, the app asks Gmail to notify a Google Pub/Sub topic
   when new mail arrives in Inbox or Sent. Gmail keeps a watch for 7 days; the
   app renews it 2 days before it expires.
2. **Push.** Pub/Sub calls `POST /api/gmail/push` with a Google-signed token.
   The app checks the token (Google's signature, our URL as audience, the
   configured service account, not expired). The notification holds only the
   mailbox address and a history id. The app answers at once and syncs that
   mailbox right after.
3. **Sync.** First run per mailbox: catch-up from one day before its last
   scan's cutoff to now (newest first, a few pages per run, resumable). After
   that: only the messages Gmail reports as added since the last history id.
   Same header-only matching and exclusions as the scan; new customer emails
   become message links, and extraction picks them up within a minute.
4. **Safety net.** `/api/cron/sync` every 10 minutes: mailboxes a push marked
   but could not finish, anything not synced for an hour, catch-ups in
   progress, watch renewals. Failures back off (2, 4, 8 … up to 360 minutes).
   If Gmail's history is too old (about a week) the mailbox catches up again
   from 8 days back; links are unique, so overlap is harmless.

Unchanged: Gmail permissions (works with gmail.metadata), privacy rules, who
sees what, the $50 AI cap. Nothing stores email content. Disconnecting Gmail
removes the sync state. The service account below only signs Pub/Sub's
requests to the app; it has no access to any mailbox and no domain-wide
delegation.

## Google Cloud setup (once)

Use the **same Google Cloud project as the "Customer 360 - Gmail" OAuth client**.

1. **APIs & Services → Library → Cloud Pub/Sub API → Enable.**
2. **Pub/Sub → Topics → Create topic.** Topic ID `gmail-push`. Untick "Add a
   default subscription". Create.
3. **Let Gmail publish to it.** Open the topic → **Permissions** (or "Show info
   panel") → **Add principal**: `gmail-api-push@system.gserviceaccount.com`,
   role **Pub/Sub Publisher** → Save. (If an organisation policy blocks this
   outside principal, an organisation admin must allow it for this project.)
4. **IAM & Admin → Service accounts → Create service account.** Name
   `gmail-push`. No roles, no keys. Note its email:
   `gmail-push@<project-id>.iam.gserviceaccount.com`.
5. **Pub/Sub → Subscriptions → Create subscription.**
   - ID `gmail-push-app`, topic `gmail-push`
   - Delivery type **Push**
   - Endpoint URL `https://customer-360-zeta.vercel.app/api/gmail/push`
   - Tick **Enable authentication**, service account `gmail-push@…`
   - Audience: the same endpoint URL
   - Acknowledgement deadline 60 seconds; message retention 1 day;
     retry policy **Retry after exponential backoff delay**
   - Create.

## Vercel

Add (Production): `FEATURE_SYNC=on`,
`GMAIL_PUSH_TOPIC=projects/<project-id>/topics/gmail-push`,
`GMAIL_PUSH_SERVICE_ACCOUNT=gmail-push@<project-id>.iam.gserviceaccount.com`.
`APP_BASE_URL` must be exactly `https://customer-360-zeta.vercel.app` (the
push audience is built from it). Redeploy.

## Check

- Admin page → **New email sync**: one row per mailbox, mode "catching up",
  then "live" within about 10–20 minutes; "Watch until" about 7 days ahead.
- Send a test email from a customer address (or reply in a customer thread):
  "Last push" updates within seconds and "Linked" goes up.
- Vercel logs: `sync_tick`, `sync_mailbox_failed` (safe codes only).

Turn off: `FEATURE_SYNC=off` (immediate; pushes then get 404 and Pub/Sub drops
them after a day). Database rollback:
`supabase/rollback/20261023000011_gmail_sync.down.sql`.
