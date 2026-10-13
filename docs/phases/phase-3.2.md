# Stage 3.1.1 and Stage 3.2: scan hardening and customer email search

Built and tested on synthetic data only. Nothing applied to the hosted database, no scan enabled, triggered or restarted, no production setting changed.

## Stage 3.1.1: scan hardening

| Change | Before | After |
|---|---|---|
| Error logging | `{"event":"scan_tick_error"}` with no detail | `{"event":"scan_tick_error","stage":"db_claim","code":"pg_28P01"}`: the step that failed plus a safe code |
| Bad scan setting (e.g. broken CA certificate) | The whole site failed to start | Scanning switches off; the site works; logs show `{"event":"scan_config_invalid","problems":["WORKER_DATABASE_CA: must be a valid PEM certificate …"]}` |
| Dashboard "Build" label | Phase 3.0 · Customer list and matching | Phase 3.2 · Customer email search (header data only, no email content) |

**Safe codes.** Only these shapes are logged; messages, stack traces, URLs, passwords, tokens and email data never are:

- `pg_<SQLSTATE>`, e.g. `pg_28P01` (wrong password);
- `sys_<CODE>`, e.g. `sys_ENOTFOUND` (bad host) or `sys_SELF_SIGNED_CERT_IN_CHAIN`;
- `gmail:<code>_<http status>`;
- the recognized names `ssl_unsupported`, `timeout`, `conn_terminated` and `decrypt_failed`;
- otherwise the error class name, or plain `error`.

**Stages:** `db_cleanup`, `db_claim`, `db_token`, `decrypt`, `gmail_auth`, `db_master`, `gmail_labels`, `gmail_list`, `db_commit`, `db_auth_lost`, `db_release`, or `unknown` if the stage can't be determined.

The same `stage:code` value is stored in the job's `last_error`, which the mailbox owner sees on the dashboard.

**Fail-safe scope.** The fail-safe applies only to `FEATURE_SCAN`, `CRON_SECRET`, `WORKER_DATABASE_URL` and `WORKER_DATABASE_CA`. Every other setting still fails closed. When `FEATURE_SCAN=on` but a scan setting is wrong:

- the cron route returns `503 {"error":"scanning disabled: configuration"}`;
- the dashboard shows "scanning off: setting needs attention";
- Start, Cancel and Resume are refused.

## Stage 3.2: search

### What is searchable

Each linked email stores: customer, mailbox owner, Gmail message and thread IDs, date, direction, customer-side contact addresses on verified domains, matching evidence, and auto/confirmed. **No subject, body, snippet or attachment is stored (CS3), so none can be searched.**

| Search text matches | Example |
|---|---|
| Customer name (start of any word) | `acme`, `pack` |
| Approved alias | `zenith` |
| Verified domain or approved address | `acme.com` |
| Stored contact address | `jane@`, `jane@acme.com` |

Words that would only appear inside an email ("invoice", "delay") return nothing, and the page says so.

### Filters and paging

- Search text: 2–100 characters, matched literally (`%` and `_` are not wildcards).
- Customer: from the customers in your own links.
- From/To dates: inclusive, UTC.
- Direction: from or to the customer.
- Mailbox: only your own.
- 50 per page, newest first, with "Next page" links based on date and ID, so nothing repeats or is skipped.

### Access, enforced in the database

| Who | Can see |
|---|---|
| Employee | Only links from their own mailbox. `auth.uid()` is used; the app never passes a user ID. Asking for any other mailbox returns nothing. |
| Admin | Their own links like any employee, plus counts per customer across all mailboxes (linked emails, number of mailboxes). No message IDs, addresses, links or per-mailbox split (decision 2026-10-13). |
| Departed user, anonymous caller, scan worker | Nothing |

### Gmail links

The link format is `https://mail.google.com/mail/?authuser=<own mailbox>#all/<message id>`:

- it opens only for someone signed in to that mailbox;
- message IDs must match `^[0-9a-zA-Z_-]{1,64}$`, otherwise no link is shown;
- the "My customer emails" page now uses the same link, so the right Google account opens when several are signed in.

## Changes

### Files

| File | Change |
|---|---|
| `lib/scan/errors.ts` | new: safe error codes and stage tagging |
| `lib/scan/config.ts` | new: fail-safe scan settings |
| `lib/scan/worker.ts` | tags each step with a stage; release code is `stage:code` |
| `lib/env.ts` | scan variables read leniently, validated in `lib/scan/config.ts`; `formatIssues` exported |
| `instrumentation.ts` | logs `scan_config_invalid` at start-up instead of crashing |
| `app/api/cron/scan/route.ts` | uses scan config; logs stage and code; 503 when misconfigured |
| `app/(app)/scan-actions.ts`, `app/(app)/dashboard/page.tsx` | use scan config; misconfigured notice; Search link |
| `lib/features.ts` | build label 3.2 |
| `lib/search/params.ts` | new: parameter validation, cursors, Gmail links |
| `app/(app)/search/page.tsx` | new: search page and admin counts |
| `app/(app)/layout.tsx` | "Search" nav link |
| `app/(app)/my-customers/page.tsx` | uses the shared Gmail link helper |
| `app/globals.css` | date inputs styled like other inputs |
| `supabase/migrations/20261015000007_search.sql` | new |
| `supabase/rollback/20261015000007_search.down.sql` | new |
| `supabase/tests/007_search.test.sql` | new, 55 pgTAP tests |
| `tests/unit/scan-config.test.ts`, `tests/unit/search-params.test.ts` | new |
| `tests/unit/env.test.ts`, `tests/unit/scan-worker.test.ts`, `tests/unit/stage3-guards.test.ts` | updated and extended |
| `tests/fixtures/test-ca.pem` | new: synthetic self-signed certificate (public, no key) |
| `.env.example`, `README.md` | notes |

### Database objects (migration 0007)

- Functions:
  - `public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer)`;
  - `public.my_linked_customers()`;
  - `public.admin_link_counts(text, uuid, date, date, integer, integer)`;
  - `private.like_escape(text)`.
- Index: `private.message_links_owner_time_id` on `(owner_id, message_at desc, id desc)`.
- Grants: execute on the three public functions to `authenticated` only (not `anon`, not `c360_worker`).
- **No table, column, row or setting is created, changed or deleted.**

## Migration dry run

A local catalog diff ran on PostgreSQL 16 with migrations 0001–0006 and the seed:

```
+ function private.like_escape(p text)
+ function public.admin_link_counts(p_query text, p_customer uuid, p_from date, p_to date, p_limit integer, p_offset integer)
+ function public.my_linked_customers()
+ function public.search_my_links(p_query text, p_customer uuid, p_from date, p_to date, p_direction text, p_mailbox text, p_cursor_at timestamp with time zone, p_cursor_id uuid, p_limit integer)
+ grant execute public.admin_link_counts -> authenticated
+ grant execute public.my_linked_customers -> authenticated
+ grant execute public.search_my_links -> authenticated
+ index private.message_links_owner_time_id
rollback restores the exact pre-migration catalog
```

Against hosted, `npx supabase@2.120.0 db push --dry-run` should list only `20261015000007_search.sql`.

## Rollback

- **Code:** revert the commit. No data migration is involved.
- **Database:** run `supabase/rollback/20261015000007_search.down.sql` in the SQL editor. It drops the four functions and the index only. Every message link and every other object is untouched. This was tested locally (rollback, then re-apply, then all tests pass again).

## Environment variables

None are new and none are required to change. Optional: once deployed, a bad `WORKER_DATABASE_CA`/`WORKER_DATABASE_URL` no longer takes the site down.

## Tests

| Suite | Result |
|---|---|
| Unit tests (vitest) | 235 passed (was 174) |
| pgTAP | 236 passed (was 181; +55 search) |
| Rollback and re-apply of all migrations | passed |
| Scan end-to-end (local Postgres, synthetic mailbox) | 8 passed |
| lint, typecheck, build, client-bundle secret scan, headers/CSP check | passed |
| Smoke: broken CA | `/api/health` 200, `/login` 200, cron 503 + `scan_config_invalid` |
| Smoke: unreachable DB | cron 500 + `{"stage":"db_cleanup","code":"sys_ECONNREFUSED"}`, password not in logs |
| Mutation check | removing the owner filter makes 15 isolation tests fail |

## Not in this stage

The following are not part of this stage: new Gmail scopes, email bodies, AI extraction, embeddings and Slack. Scanning activation stays a separate approval, as do CS13 (written consent) and the two-customer linking refinement.
