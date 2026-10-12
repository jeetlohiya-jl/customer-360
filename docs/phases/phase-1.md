# Phase 1 report: skeleton, sign-in, secure configuration

Date: 2026-10-12 · Status: **ready for review** · Data used: synthetic only

## Scope delivered

- Next.js 16 app (TypeScript strict) with routes `/login`, `/auth/callback`, `/dashboard`, `/admin`, `/api/health`.
- Google sign-in through Supabase Auth with identity scopes only, restricted to the `gocirkla.com` Workspace (email domain **and** hosted-domain claim), enforced in app code and in a database trigger.
- `app_users` (roles `member`/`admin`, status `active`/`departed`), `audit_log`, `meta` version counters; `private` schema for settings and helpers.
- Row Level Security on every table; no client writes; checked functions for sign-in audit, role and status changes, audit feed, and one-time first-admin bootstrap.
- Configuration schema that fails closed and hard-disables Gmail and Slack.
- Per-request nonce CSP and security headers; session refresh and sign-in redirect in `proxy.ts`.
- CI workflow (app checks, database tests on a local Supabase stack, gitleaks), client-bundle secret scan, live header/route checks, a no-Docker database test runner, reverse migrations, README.

## Tests run in the build environment

| Check | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | Pass, 0 problems |
| Types | `npm run typecheck` | Pass |
| Unit tests | `npm test` | **52 passed** (4 files) |
| Production build | `npm run build` | Pass; all routes dynamic (needed for CSP nonces) |
| Client bundle scan | `npm run check:bundle` | Pass: 12 files, 6 patterns incl. 2 sentinel secret values, 0 hits |
| Headers and routes | `npm run check:headers` | **18/18 checks passed** |
| Database tests | `npm run db:test:local` (PostgreSQL 16 + pgTAP, Supabase auth stub, seed loaded) | **39 passed** (3 files) |
| Rollback | same script: reverse all migrations, re-apply, re-test | Pass |
| Mutation check | weakened the member RLS policy on a copy | Tests failed as expected (proves they detect leaks) |
| Bad configuration | started with `FEATURE_GMAIL=on` | Server logged `FEATURE_GMAIL: Phase 1: FEATURE_GMAIL must be 'off'` and returned HTTP 500 for every request |

## Phase 1 acceptance criteria

| Criterion | Status |
| --- | --- |
| Repo structure, TypeScript strict, `.env.example` with no values | Met |
| CI green on every push (lint, types, unit, pgTAP) | Written; **runs on your first push** |
| Secret scanner in CI finds 0 secrets | Written (gitleaks); **runs on your first push** |
| Google sign-in works for a gocirkla.com account | **Pending**: needs the Google OAuth client and Supabase project at the review checkpoint |
| Non-gocirkla.com accounts rejected on the server | Met in code and database (unit + pgTAP); end-to-end confirmation pending with real Google |
| First admin by owner-only bootstrap; only admins grant roles; changes audited | Met (pgTAP) |
| Sessions expire; sign-out invalidates | Implemented (1-hour JWT, refresh rotation, server-side sign-out); end-to-end test pending with real sign-in |
| Migrations apply cleanly from empty; tested reverse scripts | Met. Re-running is prevented by Supabase's migration history rather than by idempotent SQL |
| 0 public tables without RLS | Met (pgTAP) |
| Anonymous reads nothing; members can't read others; departed users read nothing | Met (pgTAP) |
| `private` schema not reachable through the Data API | Met by configuration and privileges; a live PostgREST check runs once the local stack or CI is up |
| App refuses to start on missing/malformed config | Met, with one nuance: Next.js keeps the process alive and serves HTTP 500 rather than exiting |
| No server-only secrets in client bundles; only allowlisted `NEXT_PUBLIC_` variables | Met |
| Security headers present | Met (live check) |
| No Gmail scope requested while Gmail is off | Met (unit test scans all app source) |
| Performance baseline from an `iad1` preview | **Pending**: needs the Vercel preview |
| Rollback documented and rehearsed | Database rollback rehearsed; Vercel rollback rehearsal pending the first deployment |

## Known limitations

- **Hosted pieces not exercised.** Real Google sign-in, the hosted Supabase project, Vercel deployment and the `iad1` latency baseline happen at the review checkpoint; no hosted resource was touched.
- **Hosted-domain claim location.** The app reads Google's `hd` claim from `user_metadata.custom_claims.hd` (or `user_metadata.hd`). If Supabase stores it elsewhere, sign-in fails closed (everyone is rejected, nobody unauthorized gets in). This is the first thing to confirm at the checkpoint.
- **Database tests in this environment** used plain PostgreSQL 16 with a minimal stand-in for Supabase's `auth` schema. CI runs the same tests on the real local Supabase stack (PostgreSQL 17).
- **Dev-only advisory:** `npm audit` reports a high-severity issue in `braces`, pulled in by the ESLint toolchain (`eslint-config-next`). It is not part of the deployed app (`npm audit --omit=dev` reports 0 vulnerabilities). Revisit when `eslint-config-next` updates.
- Next.js 16 renamed "middleware" to "proxy"; `proxy.ts` uses the new convention.

## Revision 1.1 (before first push)

- Added `.gitattributes` so Windows checkouts keep LF line endings (prevents CRLF from breaking scripts and line-based tests).
- Line-based tests now accept CRLF as well.
- `check:headers` stops its test server correctly on Windows (`taskkill /T`).
- Added `vercel.json` pinning functions to `iad1` (US East).
- Re-verified: lint, types, 52 unit tests, build, bundle scan, 18 header checks.

## Revision 1.2 (before first push)

- Fixed: blank optional values in `.env.local` (for example `DATABASE_URL=`) were rejected at server start. Blank now means "not set". Found on the first Windows run.
- `check:headers` stops early and prints a short log when the server fails to start.
- Re-verified with only a copied `.env.local`: 54 unit tests, build, bundle scan, header checks.

## Rollback

- Code: `git revert` the Phase 1 merge commit (no force-push).
- App: Vercel Instant Rollback (after the first deployment exists).
- Database (local/disposable only): `supabase/rollback/*.down.sql` in reverse order.

## Needed from you for Phase 2

1. Review and push this code (instructions in the delivery message).
2. At the review checkpoint: Supabase project (`us-east-1`), Google Cloud project with Internal consent screen and "Sign-in" client, Vercel project (`iad1`), per section 7 of the plan.
3. Approve C2 and R1–R11 before any real mailbox connects (Phase 2).
