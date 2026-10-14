# Stage B + C: content access and AI fact extraction

Status: **complete and tested on synthetic data; everything is OFF.** Nothing reads real email or calls the Anthropic API until the activation steps below are approved and done. Design, decisions and costs are in the Claude doc "Customer 360 · Stage B + C design".

## What runs, end to end

1. **Stage A (unchanged):** the header scan links emails to customers (`private.message_links`). Each new link queues one extraction item (trigger).
2. **Stage B:** the extraction worker claims queued items. It only takes items from mailboxes that are both allowlisted and connected with `gmail.readonly`. For each item it:
    - fetches only that message (`format=full`);
    - re-checks the exclusions;
    - extracts the plain text, dropping attachments, quoted history and signatures;
    - runs the free pre-filter;
    - redacts the text.

   The text is never stored, logged or thrown.
3. **Stage C:**
    - The worker reserves the call's worst-case cost (the $50 cap is a hard stop) and calls Claude Haiku 5.5 with a fixed schema.
    - It then validates every fact: no request or offer stored as a commitment, verbatim quotes, numbers present in the text, sensitive topics dropped, injection attempts flagged.
    - Facts are stored with customer, source, quote, confidence, status and review state.
4. **Inspect and review:**
    - `/facts`: customer overview, search, filters (customer, type, stance, status, review state, dates), paging, review queue, confirm, reject, correct.
    - Dashboard card with your own progress.
    - Admin page: budget, counts, error codes, "retry failed".
    - A link from each customer page.

## Database (migration 0008, kept in `supabase/pending/` so `db push` cannot apply it)

| Table | One row per | Stores | Never stores |
|---|---|---|---|
| `private.extraction_state` | mailbox × message | Status, skip reason, attempts, next retry time, last error code, model and prompt version, fact count | Subject, body, addresses |
| `private.customer_facts` | fact | Customer, source (mailbox owner, Gmail message and thread ID, date, direction), type, stance, party, basis, status and its basis, link to an earlier fact, product, quantity, unit, price, currency, due date, reference, summary (≤300, redacted), quote (≤200, redacted, verbatim), confidence, review state, reasons, reviewer and note | Body, subject, attachments, addresses |
| `private.ai_budget` | month | Cap, spent, reserved, paused | Mailbox or email data |
| `private.ai_usage` | AI call | Tokens and cost | Mailbox, message, customer, content |

**Functions:**

- *Employees:*
    - `facts_search`, `facts_customers`, `facts_review_queue`, `fact_review`;
    - `my_extraction_status`.
- *Admins:*
    - `extraction_overview`, `extraction_failures`;
    - `extraction_retry_failed`, `extraction_set_cap`.
- *Worker:* the `worker_extract_*` and `worker_budget_*` functions.
- *Replaced:* `connect_gmail`, so it also accepts `gmail.readonly`. The rollback restores the original.

**Rules:**

- **Retries:** after a failure, the item is retried after 15 minutes, then after 30. The third failure is final. An admin can requeue failed items.
- **Deletion:** facts follow their link through a cascade, so disconnect, departure and a customer marked inactive all delete them. Rejected facts are deleted after 30 days. Usage rows are deleted after 13 months.
- **Errors:** any rejected fact write is re-raised as `fact N rejected by a database check (SQLSTATE)`. Neither the caller nor the database server log sees fact values. The end-to-end script checks the real server log.

## Tests (all synthetic; no real email, no API calls)

| Suite | Command | Result |
|---|---|---|
| Unit | `npm test` | 321 passed |
| Database incl. pending 0008, rollback and re-apply | `bash scripts/db-test-local.sh` (CI job `database-all`) | 337 passed |
| End to end: scan, extraction, full Stage A→B→C pipeline, server-log check | `bash scripts/scan-e2e-local.sh` (CI job `scan-e2e`) | 21 passed |
| Lint, types, build, client-bundle secret scan, security headers | `npm run verify` | Passed |
| Paid model evaluation | `npm run eval:extract` (needs approval) | Not run |

## Paid evaluation (approval 1, about $0.02 to $0.05)

This sends 35 synthetic emails with 38 labelled facts to Claude Haiku 5.5. Run it in PowerShell, from the repo:

```powershell
$s = Read-Host "Anthropic API key" -AsSecureString
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuth([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:EVAL_APPROVED = "yes"
npm.cmd run eval:extract
Remove-Item Env:ANTHROPIC_API_KEY; Remove-Item Env:EVAL_APPROVED
```

It writes `extract-eval-result.json`, which contains per-email counts on synthetic data only and is safe to share.

**Pass bars:**

- no request or offer stored as an unreviewed commitment;
- at least 80% of labelled facts found;
- at least 90% of order, price and delivery facts correct;
- at least 90% of quotes verbatim.

## Activation (each step needs approval, in this order)

1. **Hosted database:**
    - move `supabase/pending/20261016000008_fact_extraction.sql` to `supabase/migrations/`;
    - move `supabase/pending/tests/008_fact_extraction.test.sql` to `supabase/tests/`;
    - commit, then run `npx supabase@2.120.0 db push --dry-run`. Expect 0007 and 0008 only. Then push.
2. **Google Cloud** (project `customer-360-511408`): under Data Access, add `https://www.googleapis.com/auth/gmail.readonly`.
3. **Vercel environment:** set `GMAIL_CONTENT_ACCESS=on`, `ANTHROPIC_API_KEY=sk-ant-...` and `FEATURE_EXTRACT=on`, then redeploy. The same build stays dormant until step 5.
4. **Pilot person:** gives written consent, then disconnects and connects Gmail on the dashboard to grant content access.
5. **Allowlist** (SQL editor), adding that address to both lists:
   ```sql
   update private.settings set value = concat_ws(',', nullif(value, ''), 'person@gocirkla.com')
    where key in ('scan_allowed_mailboxes', 'extract_allowed_mailboxes');
   ```
6. The person runs "Scan my mailbox" if they haven't. Extraction then runs every minute on the linked emails.
7. **Team-wide visibility, later:** `update private.settings set value = 'all' where key = 'facts_visibility';`

**Rollback:**

- **App:** set `FEATURE_EXTRACT=off`, which stops extraction within a minute. Setting `GMAIL_CONTENT_ACCESS=off` makes new connections header-only.
- **Database:** run `supabase/rollback/20261016000008_fact_extraction.down.sql`. It removes facts, extraction state and usage rows, and restores `connect_gmail`. Links and customers are untouched.

## Verifying in Supabase (read-only SQL)

```sql
-- latest facts with their evidence and source
select c.canonical_name, f.fact_type, f.stance, f.status, f.status_basis, f.review_state, f.confidence,
       f.quantity, f.unit_price, f.currency, f.due_date, f.summary, f.evidence_quote, f.message_at, f.gmail_message_id
  from private.customer_facts f join public.customers c on c.id = f.customer_id
 order by f.message_at desc limit 100;

-- progress and skip reasons
select status, skip_reason, count(*) from private.extraction_state group by 1, 2 order by 1, 2;

-- error codes (no content)
select last_error, status, count(*) from private.extraction_state where last_error is not null group by 1, 2;

-- spend this month
select month, cap_microusd / 1e6 as cap_usd, spent_microusd / 1e6 as spent_usd, paused_at from private.ai_budget order by month desc;
```
