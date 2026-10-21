# Phase 4: Slack DM assistant, D4 retention, Gmail rate limits

Built and tested with synthetic data only. Nothing here is live until the
steps under "Activation" are done; `FEATURE_SLACK` stays `off` until then.

## What it does

An employee opens a direct message with the **Customer 360** bot in Slack and
asks about a customer ("What's open with Catelli?"). The bot:

1. Checks the request really comes from Slack (signature, max 5 minutes old) and
   ignores Slack's retries of the same event.
2. Identifies the person by the email on their Slack account. Only active
   Cirkla employees who have signed in to Customer 360 at least once get answers.
3. Applies a limit of 30 questions per person per hour (setting
   `slack_questions_per_hour`).
4. Finds the customer by full name or approved alias; if none, by a distinctive
   first word of a customer's name ("Catelli" → "Catelli Brothers"). No
   customer found → asks which customer, with no AI call.
5. Loads the facts **that person may see**, using exactly the Facts page rules:
   their own facts always; colleagues' checked facts only when
   `facts_visibility = 'all'` (D10); facts awaiting review only for the
   mailbox owner and admins; rejected facts never.
6. Sends the question (redacted) and those facts to Claude Haiku 5.5, which
   must answer only from them and cite each fact.
7. Replies with a short answer and numbered sources (date, customer, evidence
   quote, *unverified* mark, an "open email" link only for the asker's own
   emails). The colleague whose mailbox a fact came from is named only when the
   question asks who (D2).

Not stored: questions and answers. Stored: an hourly count per person (rate
limit, 2 days) and Slack event ids (1 day). Logs carry the outcome, counts and
cost only. Cost: about $0.001–0.003 per question, charged to the same monthly
cap as extraction (hard stop).

## D4: facts kept when someone leaves

Migration 0010 changes what happens when an admin marks someone **departed**:
their Gmail authorization is still deleted at once, but the message links and
facts from their mailbox are kept. Unchanged: a current employee who
**disconnects** Gmail still has their links and facts deleted, and a customer
marked inactive still loses its links and facts.

> Never use **Disconnect** to "refresh" a Gmail connection: it deletes that
> person's links and facts. To change permissions, use **Connect Gmail** again
> without disconnecting.

## Gmail rate limits

Gmail sometimes answers "slow down" with HTTP 403 (reasons
`rateLimitExceeded` / `userRateLimitExceeded`). These are now retried with
backoff like 429s, and if they persist the email is put back in the queue
instead of being marked failed. Real permission errors (other 403s) still fail.

## Files

- `supabase/migrations/20261022000010_slack_and_retention.sql` (+ rollback, pgTAP `010`)
- `lib/slack/*`, `app/api/slack/events/route.ts`
- `lib/gmail/google.ts` (`isRateLimited`), `lib/extract/run.ts`
- `docs/slack/manifest.yml`
- Tests: `tests/unit/slack.test.ts`, `tests/e2e/slack.e2e.test.ts`

## Activation (each step needs Kartik's go-ahead)

1. `db push --dry-run` lists only `20261022000010_slack_and_retention.sql`; then push.
2. Deploy (commit and push). Slack is still off.
3. Create the Slack app from `docs/slack/manifest.yml` (domain filled in) and
   install it to the Cirkla workspace (needs a Slack workspace admin).
4. In Vercel, add `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` (never in chat),
   set `FEATURE_SLACK=on`, redeploy.
5. In the Slack app's Event Subscriptions, confirm the Request URL shows
   **Verified**.
6. Pilot: Kartik and the four salespeople DM the bot. Until
   `facts_visibility = 'all'`, each person sees only their own facts (admins
   see all).
7. After the spot-check: `update private.settings set value = 'all' where key = 'facts_visibility';`

Rollback: `FEATURE_SLACK=off` (immediate). Database:
`supabase/rollback/20261022000010_slack_and_retention.down.sql`.
