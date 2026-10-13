# Stage 3.1 report: header scan of one authorized mailbox

Date: 2026-10-14 · Status: **built and tested locally; scanning OFF; migration NOT applied** · Data used: synthetic only

Approved: CS3 no subjects stored · CS4 customer-side addresses on verified customer domains only · CS5 internal-only mail excluded · CS8 dedicated worker login · CS9 retention.

## What it does

1. The mailbox owner clicks **Scan my mailbox** on the dashboard.
2. Once a minute a Vercel cron job calls `/api/cron/scan`, which processes one page (up to 250 messages) of one job:
   list message IDs (no spam/trash) → read headers only (`format=metadata`: From, To, Cc, Subject, Date, Sensitivity, List-Unsubscribe) →
   exclusion rules → customer matching → commit outcomes, counters and the resume point in one transaction.
3. The owner sees progress on the dashboard and their own links at `/my-customers`. Admins see counts only (`/admin`). Uncertain names go to `/customers/review`; a "same customer" decision links the waiting messages.

## Four switches, all off after this release

| Switch | Where | Default |
| --- | --- | --- |
| `FEATURE_SCAN` | Vercel env | `off`: the cron route returns 204 and does nothing |
| Mailbox allowlist | `private.settings` `scan_allowed_mailboxes` | empty: no mailbox can be scanned |
| Worker login | `c360_worker` role | `NOLOGIN`, no password |
| Owner start | Dashboard button | nobody has started a scan |

Removing a mailbox from the allowlist stops its scan at the next claim.

## Rules (rules version m1)

- Excluded by rule: labels SPAM, TRASH, DRAFT, CHAT; an employee's own `C360-Exclude` label.
- Excluded for privacy: `Sensitivity: private/personal/company-confidential`; subject terms for credentials, HR/pay, personal finance/ID, "private/confidential/personal"; security senders.
- Excluded internal (CS5): every participant @gocirkla.com.
- Linked: approved address (E1), verified exclusive customer domain (E2) or exact customer name/alias in the subject or a participant's display name (E3).
- Review: misspelling (E4) or a too-generic name; only the name fragment is stored, with message references.
- Unmatched: no evidence. Shared or look-alike domains alone are counted as `weak_evidence_only` (part of unmatched); domain review comes later.
- **Refinement to the design:** a message with strong evidence for two customers is linked to both. Two-customer ambiguity only goes to review when the evidence is weak.

## Stored per linked message

Customer, owner, Gmail message and thread ID, date, direction, evidence (approved name/domain/address), customer-side addresses on verified domains, rules version, link status. **No subject, snippet, body or attachment.**

## Retention (CS9)

Links: deleted when the mailbox is disconnected, the owner departs, or the customer is marked inactive. Review items: 30 days. Failed-message list: 14 days. Batch counts: 90 days. Cleanup runs on every worker tick.

## Tests run here

| Suite | Result |
| --- | --- |
| Unit (Vitest) | **174 passed** (30 new): exclusions, matching, address parsing, no subject leakage, worker resume/dedupe/cancel/auth-loss/failures, metadata-only requests, env rules, guards |
| Database (pgTAP) | **181 passed** (52 new): worker role has no table access and no login, allowlist enforced, owner-only start, one scan at a time, ordered idempotent commits, reconciliation constraint, owner-only links (admins and colleagues see none), review links waiting messages, cancel, auth loss + resume, allowlist removal, retention, CS9 deletions, audit trail |
| End to end | **8 passed**: 620-message synthetic mailbox through the real worker login and functions; a failed page repeated without duplicates; every message counted once; no subject/snippet/unrelated address anywhere in the database; only metadata requested |
| Rollback | Down migrations, re-apply, tests pass |
| Build, bundle scan (13 patterns), header checks | Pass; cron route returns 401 without the secret |

## Known limitations

- Messages that fail after 3 retries are counted and listed (14 days), not retried automatically yet.
- Review handles names only; shared/look-alike domain evidence is counted, not queued.
- The worker connects through Supabase's pooler as `c360_worker`; custom-role pooling and TLS verification (`WORKER_DATABASE_CA`) must be confirmed at go-live.
- The "Gmail" link on `/my-customers` opens the message only in the owner's own browser session.
