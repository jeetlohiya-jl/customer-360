# Phase 2 report: Gmail connection proof of concept + Cirkla visual identity

Date: 2026-10-12 · Status: **ready for deployment and the real-account test** · Data used: synthetic only

## Goal

One employee signs in, separately authorizes Gmail, sees which mailbox is connected and up to five recent messages (subject, sender, date) fetched through a real Gmail API request, and can disconnect. Another user can never reach that connection.

## What changed

| Area | Change |
| --- | --- |
| Gmail OAuth | Separate "Connect Gmail" flow, authorization code + PKCE (S256), signed 10-minute state cookie bound to the signed-in user, `access_type=offline`, `prompt=consent`, only `gmail.metadata` requested |
| Mailbox identity | Read from Gmail's own profile endpoint; must equal the signed-in user's email or the authorization is revoked and nothing is stored |
| Token storage | Refresh token encrypted with AES-256-GCM (key only in server env; user id bound as associated data) and stored in `private.gmail_connections`, unreachable through the Data API |
| Database | Migration `20261012000004_gmail_connections.sql`: table + caller-only functions (`connect_gmail`, `my_gmail_connection`, `my_gmail_token`, `mark_my_gmail_revoked`, `disconnect_gmail`), audit entries, departure trigger that deletes a departed user's connection. Reverse script included |
| Fetch | Fresh access token per page view; `messages.list?maxResults=5`, then `format=metadata` with Subject/From/Date only, in parallel; nothing stored |
| Disconnect | Revokes at Google first, then deletes the stored token; result shown and audited |
| Failure handling | Declined consent, invalid/forged/expired state, missing refresh token, scope not granted, wrong mailbox, store failure, revoked access (`invalid_grant`/401), API errors |
| Config | `FEATURE_GMAIL` may be `on` only with `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 bytes). Slack still forced off |
| UI | Cirkla visual identity: Fraunces / Inter / JetBrains Mono (self-hosted, CSP-safe), Paper/Cream/Green/Butter palette, pill buttons, cards; sign-in, dashboard, admin restyled |

## Tests run here

| Suite | Result |
| --- | --- |
| Unit (Vitest) | **79 passed**: env rules, encryption (tamper, wrong key, wrong user), signed state, consent URL, token exchange, revocation, 5-message cap, metadata-only requests, full callback checks (forged state, another user's flow, expired flow, wrong mailbox, store failure) |
| Database (pgTAP) | **56 passed**, including 17 new Gmail tests: user can connect only their own mailbox, another user sees nothing and gets no token, direct table reads denied, anon denied, revoked connections hand out no token, audit trail |
| Mutation checks | Removing the user check in the callback, or weakening the member RLS policy, makes the tests fail |
| Build + bundle scan | Pass; Gmail client secret, encryption key, service key and DB URL sentinels absent from browser files |
| Live header checks | 18/18 pass |
| Visual | Sign-in (desktop + mobile) and dashboard rendered in Chromium; brand fonts load under the CSP |

Not yet verified (needs real services): the real Google consent screen, a real Gmail API response, and revocation at Google.

## Known limitations

- Messages are fetched on every dashboard view (one token refresh + 6 Gmail calls). Fine for one user; later phases replace this with background sync.
- Times are shown in UTC.
- A departed user's token is deleted from our database but not revoked at Google (we no longer hold their session). An admin can remove the app's access in the Workspace Admin console; automated revocation comes with the retention policy work.
- Preview deployments on Vercel have changing URLs; Gmail connect works only on URLs registered in the Google client (production and localhost).
- `upgrade-insecure-requests` in the production CSP means `next start` over plain `http://` on a laptop may block some assets; use `npm run dev` locally or HTTPS in production.

## Rollback

- App: Vercel Instant Rollback, or set `FEATURE_GMAIL=off` (connections stay stored but unused).
- Users: Disconnect revokes at Google. Workspace admins can also remove the app's access centrally.
- Database (with approval only): `supabase/rollback/20261012000004_gmail_connections.down.sql` (revoke tokens first).
