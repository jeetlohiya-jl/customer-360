# Phase 6: colleagues' emails about a customer, targeted re-scans, sync fixes

Migration `20261023000013_internal_threads.sql` (+ rollback, pgTAP `013`).

## Why

On 23 Oct 2026 the Slack assistant answered "I don't have any stored facts you
can see for Preferred Packaging yet" to a question about the October 1C/2C
fiber tray work. Investigation found:

1. **The customer had no domain on file.** Preferred Packaging writes from
   `cpflexpack.com`; its subjects and sender names never say "Preferred
   Packaging", so header matching linked nothing from the October threads.
2. **Internal replies were always dropped (CS5).** Most next steps were in
   colleague-only emails: tooling options, the FedEx pickup, CRM ticket
   updates ("[Ticket] - Pref 1CP & 2CP").
3. **Sync stalled on deleted emails.** One message deleted between Gmail's
   history entry and the fetch (HTTP 404) failed the whole mailbox; two
   mailboxes had not synced for hours.
4. **The asker's access was changed by direct SQL** (no audit trail), and the
   answer was most likely given before it changed.
5. **"What does David need as next steps"** was filtered to requirement and
   follow-up facts only (because of the word "need"), so pricing, delivery and
   order items were left out.

## What changed

### Internal email linking (setting `internal_linking`)

| Value | Internal-only email (only @gocirkla.com addresses) |
| --- | --- |
| `off` (migration default) | never linked: CS5 as before |
| `thread` | linked to the customers **the same mailbox** already has in that Gmail thread (evidence `T1`) |
| `thread_and_named` | also linked when its subject names exactly **one** customer by an exact name or approved alias (evidence `I1`); for example CRM ticket emails |

- Privacy exclusions run first: Gmail system labels, the C360-Exclude label,
  the Sensitivity header, private/HR/credential subjects.
- Generic names, typos and subjects naming two customers never link internal
  email.
- Links are stored with direction `internal`. Nothing is stored for internal
  email that does not link: the follow-up ids are only used inside the commit.
- Order does not matter: a scan reads newest first, so colleagues' replies
  usually come before the customer's first email. When a page links a thread,
  the worker reads that thread's headers once (`threads.get`, metadata only)
  and offers its internal messages too.
- Extraction reads internal email only when it is linked as internal; the
  prompt tells the model it is internal (prompt version `x5`). Colleagues'
  opinions of people and anything personal are never recorded.
- The UI (search, My customers, Facts) and Slack show "internal (Cirkla only)".

Turn on (audited): `update private.settings set value = 'thread_and_named' where key = 'internal_linking';`
Turn off at once: set it to `off`. Existing internal links remain until the
mailbox is disconnected or the customer is marked inactive (CS9).

### Targeted re-scans ("Find past emails")

After adding a domain, address or name to a customer, an admin opens the
customer and clicks **Find past emails** (`public.customer_backfill`). Each
approved, connected mailbox without a scan in progress gets a scan limited to a
Gmail search built from the customer's domains (From/To/Cc) and names
(subject). Same rules as a normal scan; usually one or two pages per mailbox.
Operators can do the same from the SQL editor with
`select private.customer_backfill_as_owner('<customer id>', '<reason>');`.

### Sync and extraction

- A message Gmail no longer has (404) is skipped and counted (`gone`), instead
  of failing the mailbox.
- Extraction marks such messages `skipped` with reason `deleted`.

### Slack answers

- "Next steps", "actionables", "what's open", "pending", "outstanding": every
  kind of open item, open ones first, no type filter.
- A colleague named in the question ("what does David need…") is passed as the
  focus, so their items come first.

### Audit

- Role or status changes made without a signed-in admin (SQL editor, scripts)
  are logged as `user.changed_directly`.
- Every change to `private.settings` is logged as `setting.changed` with the
  old and new value.

## Tests

- Unit: classification modes, thread expansion, targeted search, 404 handling
  in sync and extraction, internal prompt, Slack open items and focus.
- Database (pgTAP `013`): defaults, privileges, follow-ups per mailbox only,
  I1/T1 links feed extraction, search filter, backfill rights and queueing,
  query validation, audit triggers; rollback and re-apply.
- End to end (`scripts/scan-e2e-local.sh`): sync with internal linking on, a
  vanished email, real worker login and database.

Rollback: set `internal_linking` to `off` (immediate). Database:
`supabase/rollback/20261023000013_internal_threads.down.sql` (removes internal
links and their facts).
