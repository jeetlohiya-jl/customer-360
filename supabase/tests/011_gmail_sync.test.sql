-- Migration 0011: Gmail sync (push + safety net). Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000011a1', 't11.ann@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000011b1', 't11.ben@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000011c1', 't11.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000011c1';
insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000011a1', 't11.ann@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']),
  ('00000000-0000-4000-8000-0000000011b1', 't11.ben@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']);
update private.settings set value = 't11.ann@gocirkla.com, t11.ben@gocirkla.com' where key = 'scan_allowed_mailboxes';
-- Ann's scan completed; Ben's has not.
insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at) values
  ('00000000-0000-4000-8000-0000000011a1', 't11.ann@gocirkla.com', 'completed', 'm1', '2026-10-15T00:00:00Z', now()),
  ('00000000-0000-4000-8000-0000000011b1', 't11.ben@gocirkla.com', 'running', 'm1', '2026-10-15T00:00:00Z', null);
insert into public.customers (id, canonical_name) values ('00000000-0000-4000-8000-00000000c11a', 'T11 Elevenfold Foods');

create function pg_temp.sync(p_owner uuid) returns private.gmail_sync language sql security definer as $$
  select * from private.gmail_sync where user_id = p_owner
$$;
create function pg_temp.links(p_owner uuid) returns bigint language sql security definer as $$
  select count(*) from private.message_links where owner_id = p_owner
$$;
create function pg_temp.pending(p_owner uuid) returns bigint language sql security definer as $$
  select count(*) from private.extraction_state where owner_id = p_owner and status = 'pending'
$$;
grant execute on function pg_temp.sync(uuid), pg_temp.links(uuid), pg_temp.pending(uuid) to c360_worker;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

-- ---- Privileges ----------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.worker_sync_commit(uuid, jsonb, jsonb, jsonb, jsonb, text)', 'execute'), 'clients cannot commit sync results');
select ok(not has_function_privilege('anon', 'private.worker_sync_push(text, text)', 'execute'), 'anonymous callers cannot mark mailboxes');
select ok(not has_table_privilege('c360_worker', 'private.gmail_sync', 'select'), 'the worker cannot read sync state directly');
select ok(not has_function_privilege('c360_worker', 'public.sync_overview()', 'execute'), 'the worker cannot read the admin overview');

-- ---- Eligibility and first claim --------------------------------------------------------
set local role c360_worker;
select is((select count(*) from private.worker_sync_claim(5, 120)), 1::bigint, 'only a mailbox with a completed scan is synced');
reset role;
select is((pg_temp.sync('00000000-0000-4000-8000-0000000011a1')).floor_at, '2026-10-14T00:00:00Z'::timestamptz,
  'catch-up starts one day before the last scan''s cutoff (overlap is harmless: links are unique)');
select is((select count(*) from private.gmail_sync where user_id = '00000000-0000-4000-8000-0000000011b1'), 0::bigint,
  'a mailbox whose scan has not completed gets no sync row');
set local role c360_worker;
select is((select count(*) from private.worker_sync_claim(5, 120)), 0::bigint, 'a leased mailbox is not claimed twice');
select ok((select refresh_token_enc from private.worker_sync_token('00000000-0000-4000-8000-0000000011a1')) is not null, 'the leased mailbox''s token is available');
select is((select count(*) from private.worker_sync_token('00000000-0000-4000-8000-0000000011b1')), 0::bigint, 'no token for a mailbox the worker does not hold');

-- ---- Commit: links feed extraction ------------------------------------------------------------
select is(private.worker_sync_commit('00000000-0000-4000-8000-0000000011a1',
  '{"history_id":null,"catchup_history_id":"5001","catchup_page_token":"tok2","done":false,"watch_expires_at":"2026-10-30T00:00:00Z"}',
  '[{"customer_id":"00000000-0000-4000-8000-00000000c11a","gmail_message_id":"s11m1","gmail_thread_id":null,"message_at":"2026-10-20T10:00:00Z","direction":"inbound","customer_addresses":[],"evidence":[],"score":0.9}]',
  '[]', '{"processed":3}', 'm1'), 'ok', 'a catch-up step commits');
select is(pg_temp.links('00000000-0000-4000-8000-0000000011a1'), 1::bigint, 'the new customer email is linked');
select is(pg_temp.pending('00000000-0000-4000-8000-0000000011a1'), 1::bigint, 'and queued for extraction automatically');
select is((pg_temp.sync('00000000-0000-4000-8000-0000000011a1')).dirty, true, 'an unfinished catch-up asks for another run');
select throws_ok($$ select private.worker_sync_commit('00000000-0000-4000-8000-0000000011a1', '{}', '[]', '[]', '{}', 'm1') $$,
  '55000', null, 'committing without holding the lease is refused');

-- ---- Finish catch-up, then live --------------------------------------------------------------
select is((select catchup_page_token from private.worker_sync_claim(5, 120)), 'tok2', 'the next run resumes the catch-up where it stopped');
select lives_ok($$ select private.worker_sync_commit('00000000-0000-4000-8000-0000000011a1',
  '{"history_id":"5001","catchup_history_id":null,"catchup_page_token":null,"done":true}', '[]', '[]', '{"processed":2}', 'm1') $$,
  'the last catch-up step commits');
reset role;
select is((pg_temp.sync('00000000-0000-4000-8000-0000000011a1')).history_id, '5001', 'after catch-up the mailbox is live from the recorded history id');
select is((pg_temp.sync('00000000-0000-4000-8000-0000000011a1')).processed, 5::bigint, 'processed counts add up');
set local role c360_worker;
select is((select count(*) from private.worker_sync_claim(5, 120)), 0::bigint, 'a live, recently synced mailbox is left alone');

-- ---- Push ---------------------------------------------------------------------------------------
select is(private.worker_sync_push('T11.Ann@gocirkla.com', '5009'), '00000000-0000-4000-8000-0000000011a1'::uuid, 'a push marks the mailbox and returns its owner');
select is(private.worker_sync_push('stranger@gocirkla.com', '1'), null, 'a push for an unknown mailbox is ignored');
select is((select count(*) from private.worker_sync_claim(5, 120, '00000000-0000-4000-8000-0000000011a1')), 1::bigint, 'the pushed mailbox is synced at once');

-- ---- Failure backs off ----------------------------------------------------------------------------
select private.worker_sync_fail('00000000-0000-4000-8000-0000000011a1', 'gmail_history:gmail:gmail_api_error_500');
reset role;
select ok((pg_temp.sync('00000000-0000-4000-8000-0000000011a1')).next_attempt_at > now(), 'a failed sync waits before retrying');

-- ---- Disconnect removes sync state ----------------------------------------------------------------
delete from private.gmail_connections where user_id = '00000000-0000-4000-8000-0000000011a1';
select is((select count(*) from private.gmail_sync where user_id = '00000000-0000-4000-8000-0000000011a1'), 0::bigint,
  'disconnecting Gmail removes the sync state');

select * from finish();
rollback;
