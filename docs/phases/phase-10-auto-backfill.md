# Phase 10: past email found automatically for new customers (migration 0017)

Before, adding a customer only affected new email; past email needed an admin
to click **Find past emails** (0013), which did nothing for a mailbox that had
another scan running.

Now adding a customer, re-activating or renaming one, or adding an alias,
domain or address files a backfill request for every approved mailbox that
has had a full scan. Each request becomes a targeted Gmail search (a 0013 scan
job with a `search_query`) as soon as that mailbox has no scan running; the
next waiting request starts when a scan ends. A search usually finishes in a
minute or two per mailbox. Found emails are matched by the normal rules and
extracted as usual.

- The search covers the customer's domains and addresses (From/To/Cc), its name
  and aliases in the subject, and, when no domain is on file, `<name>.com`
  (e.g. `gloryfoods.com`). Matching still decides what links.
- More than 20 customers/aliases/identifiers in one statement (a CSV import)
  files nothing and writes `customer.backfill_skipped_bulk` to the audit log:
  run a full re-scan instead.
- Switch: `update private.settings set value = 'off' where key = 'auto_backfill';`
- Waiting requests (admins): `select * from public.backfill_waiting();`
- For a customer added before 0017:
  `select private.request_backfill(id, 'manual') from public.customers where canonical_name ilike 'glory%';`

Reverse: `supabase/rollback/20261030000017_auto_backfill.down.sql`.
