-- Reverse of 20261023000011_gmail_sync.sql. Links and facts already created by
-- sync are kept (they are ordinary links); only the sync state is removed.
drop function if exists public.sync_overview();
drop function if exists private.worker_sync_fail(uuid, text);
drop function if exists private.worker_sync_commit(uuid, jsonb, jsonb, jsonb, jsonb, text);
drop function if exists private.worker_sync_token(uuid);
drop function if exists private.worker_sync_claim(integer, integer, uuid);
drop function if exists private.worker_sync_push(text, text);
drop function if exists private.sync_eligible();
drop table if exists private.gmail_sync;
