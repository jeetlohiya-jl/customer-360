# Stage 3.0 report: customer list, name matching, review queue

Date: 2026-10-13 · Status: **built and tested locally; migration NOT applied** · Data used: synthetic only

Approved decisions: CS1 A (customer-scoped), CS2 A (`gmail.metadata` only), CS7 A (admins review), CS8 A (worker role, built in 3.1), CS12 (CSV import with validation).

## What this stage does

| Feature | Where | Notes |
| --- | --- | --- |
| Customer list | `/customers` (admins only) | Search by name, alias, domain |
| Customer page | `/customers/[id]` | Add/remove names, domains, emails; mark inactive; undo "different businesses" |
| CSV import | `/customers/import` | Preview first: new / adds to existing / possible duplicate / rejected, with reasons. All-or-nothing commit |
| Review queue | `/customers/review` | One decision per spelling: "same customer" (becomes an approved alias) or "not a customer". Undo for both |
| Name checker | `/customers/check` | Paste names or emails; see link / review / no match and why; optionally queue uncertain names |

**Not in this stage:** Gmail scanning, background jobs, new OAuth scopes, the worker role, member access to customers. A unit test fails if customer code imports Gmail code, if any file other than `lib/gmail/google.ts` calls the Gmail API, or if a cron job is configured.

## Matching rules (rules version m1)

1. Normalize: lowercase, accents and punctuation removed, `&` → and, legal suffixes (Inc, LLC, Ltd, Limited, Pvt, GmbH, L.L.C., …) and a leading "The" dropped. Same function in TypeScript and SQL, checked against the same 17 fixture cases.
2. Exact canonical name or approved alias → **link**, unless the name has no distinctive word (e.g. "Fresh Foods") → review.
3. Typos → **review only**: one edit allowed in words of 4–7 letters, two from 8 letters; a distinctive word must match exactly unless the total is one edit; joined/split words ("AcmePackaging") count. Single words shorter than 6 letters are never fuzzy-matched.
4. Approved email (E1) or verified exclusive domain (E2) → link. Shared domain or look-alike domain (E5) → review. Free-mail and gocirkla.com → no evidence.
5. Two or more customers in one item → review. Pairs marked "different businesses" are never cross-proposed. Rejected spellings are never proposed again.

Design-doc change: section 7 mentioned trigram similarity; the implementation uses per-word edit distance with a fast deletion index instead (no database extension needed, explainable per word).

## Database (migration `20261013000005_customer_master.sql`)

| Object | Purpose | Access |
| --- | --- | --- |
| `public.customers` | Canonical names (unique after normalizing), notes, status | RLS: admins read; writes via functions |
| `public.customer_aliases` | Legal, trading, alias names; one name → one customer | Same |
| `public.customer_identifiers` | Domains (exclusive or shared) and emails; free-mail and gocirkla.com refused | Same |
| `public.customer_distinctions` | Pairs confirmed as different businesses | Same |
| `public.name_rejections` | Normalized spellings marked "not a customer" | Same |
| `private.review_items` | Open uncertain names; deleted on decision or after 30 days | No direct access; admin functions only |
| 12 `public.*` functions | Import, single edits, review | `authenticated` may call; each checks admin and writes `audit_log` |

Retention: review items 30 days or until decided; everything else is customer master data kept until changed. No email content exists anywhere in this stage.

## Tests run here

| Suite | Result |
| --- | --- |
| Unit (Vitest) | **144 passed** (63 new): normalization, edit distance, matching acceptance cases, CSV parsing, import preview and commit plan, guards |
| Database (pgTAP) | **129 passed** (73 new): privileges, RLS, normalization parity, import atomicity, free-mail and own-domain refusal, alias uniqueness across customers, review queue, undo, member denied everywhere, audit trail |
| Rollback | Down migrations then re-apply; tests still pass |
| Mutation | Opening the customers read policy to everyone makes the database tests fail |
| Build, bundle scan, header checks | Pass |

## Known limitations

- Review items in this stage come only from the name checker; Gmail-sourced items arrive in Stage 3.1.
- The review page lists up to 1,000 active customers in its selector.
- Matching thresholds are starting values; tune them on the real customer list and the pilot.
