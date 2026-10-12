-- Reverses 20261012000004_gmail_connections.sql. DESTRUCTIVE: deletes stored
-- Gmail connections. Revoke tokens at Google first (users can disconnect, or
-- an admin can remove the app's access). Run only with explicit approval.
drop trigger if exists drop_gmail_on_departure on public.app_users;
drop function if exists private.drop_gmail_on_departure();
drop function if exists public.disconnect_gmail(boolean);
drop function if exists public.mark_my_gmail_revoked();
drop function if exists public.my_gmail_token();
drop function if exists public.my_gmail_connection();
drop function if exists public.connect_gmail(text, text, smallint, text[]);
drop table if exists private.gmail_connections;
