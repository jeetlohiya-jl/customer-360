# Phase 8: speed

Migration `20261026000015_performance.sql` (+ rollback, pgTAP `015`). No data
is changed, added or removed; who can see what is unchanged.

| Where | Before | After |
| --- | --- | --- |
| `facts_customers()` (Facts page, every load) | 2.4-2.7 s | ~18 ms |
| `facts_search` with search text | ~3.4 s | ~60 ms |
| Slack facts, review queue | per-row checks | checked once |

Causes and fixes:

- **Per-row permission checks.** `private.can_see_fact` ran four look-ups for
  every fact row. The rule is now evaluated once per call (pgTAP `015`
  proves the results equal the per-row rule for admins, members, departed
  users and both `facts_visibility` settings).
- **RLS policies** wrap `private.is_admin()` / `is_active_user()` in
  `(select ...)` so Postgres runs them once per query, not per row.
- **Sequential reads.** Admin (4 rounds → 1), Dashboard (database reads and the
  live Gmail panel now in parallel), Customers (list and review queue
  together), Search (admin counts in parallel).
- **Prefetch storm.** Tables of customer links (Customers list, Facts tables)
  no longer prefetch every visible row; each prefetch was a server render.
- **Auth round trip.** `requireUser` verifies the session token with
  `getClaims()` (as `proxy.ts` already does) instead of calling the Auth server
  with `getUser()` on every page. Access changes (suspend, depart, remove
  invite) still apply on the next page load because the app_users row is
  checked every time.
