# Phase 7: invite-only access

Migration `20261026000014_invite_only.sql` (+ rollback, pgTAP `014`).

Customer 360 and the Slack assistant are now for invited people only, not every
@gocirkla.com account.

## How it works

- **Admin → Access**: invite an address (optional note) or remove access. Only
  workspace-domain addresses can be invited. Every change is in the audit log.
- **Not invited**: Google sign-in completes, but the account is created
  `suspended`; the app signs them out with "Customer 360 is invite-only. Ask a
  Customer 360 admin to invite you". They appear on the Access list as "asked
  to sign in, not invited", with an Invite button.
- **Removing access** sets the person `suspended` at once: every page load,
  Slack question, scan, sync and extraction checks `status = 'active'`. Unlike
  `departed`, their Gmail connection, linked emails and facts are kept, and
  others can still see those facts. Inviting them again restores access.
- Admins cannot remove their own access, and the last active admin cannot be
  removed.
- At migration time every active user was invited, so nobody was locked out.

## Settings

`access_mode`: `invite` (default; unknown values also mean invite) or
`workspace` (the old rule: any Workspace account). Changes are audited.
Local stacks and the test scripts use `workspace` for synthetic users;
`supabase/tests/014` covers invite mode.

## Optional, outside the app

Google Admin console → Security → API controls → App access control: limit the
"Customer 360" sign-in OAuth client to a Google group, so Google blocks
everyone else before they reach the app.
