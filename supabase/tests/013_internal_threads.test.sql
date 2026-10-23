-- Migration 0013: internal follow-ups in customer threads, targeted scans,
-- deleted emails, audit of direct changes. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000013a1', 't13.ann@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000013b1', 't13.ben@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000013c1', 't13.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000013c1';
insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000013a1', 't13.ann@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000013b1', 't13.ben@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000013c1', 't13.admin@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']);
update private.settings set value = 't13.ann@gocirkla.com,t13.ben@gocirkla.com,t13.admin@gocirkla.com' where key = 'scan_allowed_mailboxes';
-- Ben finished a full scan earlier; the admin never scanned.
insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at) values
  ('00000000-0000-4000-8000-0000000013b1', 't13.ben@gocirkla.com', 'completed', 'm2', now() - interval '3 days', now() - interval '3 days');
insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c13a', 'T13 Thirteenfold Packaging'),
  ('00000000-0000-4000-8000-00000000c13b', 'T13 Other Foods');
insert into private.scan_jobs (id, owner_id, mailbox_email, status, rules_version, cutoff_at, lease_until) values
  ('00000000-0000-4000-8000-0000000a013a', '00000000-0000-4000-8000-0000000013a1', 't13.ann@gocirkla.com', 'running', 'm2', now(), now() + interval '1 hour');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
create function pg_temp.counts(p_enum int, p_matched int, p_internal int) returns jsonb language sql as $$
  select jsonb_build_object('enumerated', p_enum, 'excluded_rule', 0, 'excluded_privacy', 0, 'excluded_internal', p_internal,
    'matched', p_matched, 'in_review', 0, 'unmatched', p_enum - p_matched - p_internal, 'weak_evidence_only', 0, 'failed', 0, 'newer_than_cutoff', 0)
$$;
create function pg_temp.links(p_message text) returns text language sql security definer as $$
  select coalesce(string_agg(c.canonical_name || '/' || l.direction || '/' || (l.evidence -> 0 ->> 'type'), ',' order by c.canonical_name), '')
    from private.message_links l join public.customers c on c.id = l.customer_id where l.gmail_message_id = p_message
$$;
grant execute on function pg_temp.counts(int, int, int), pg_temp.links(text) to c360_worker;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

-- ---- Defaults and privileges ----------------------------------------------------------------------
select is((select value from private.settings where key = 'internal_linking'), 'off', 'internal linking is off until an admin turns it on');
select is(private.internal_linking(), 'off', 'the setting reads as off');
update private.settings set value = 'yes please' where key = 'internal_linking';
select is(private.internal_linking(), 'off', 'an unknown value means off');
select is((private.worker_customer_master() ->> 'internal_linking'), 'off', 'the customer master carries the setting');
select ok(not has_function_privilege('authenticated', 'private.link_thread_followups(uuid, jsonb, text, uuid)', 'execute'), 'clients cannot link follow-ups');
select ok(not has_function_privilege('c360_worker', 'private.link_thread_followups(uuid, jsonb, text, uuid)', 'execute'), 'the worker links follow-ups only through the commit functions');
select ok(has_function_privilege('c360_worker', 'private.worker_job_query(uuid)', 'execute'), 'the worker can read a job''s search');
select ok(not has_function_privilege('authenticated', 'private.customer_backfill_as_owner(uuid, text)', 'execute'), 'clients cannot use the owner backfill');
select ok(not has_function_privilege('anon', 'public.customer_backfill(uuid)', 'execute'), 'anonymous callers cannot queue backfills');

-- ---- Off: follow-ups are ignored ----------------------------------------------------------------------
update private.settings set value = 'off' where key = 'internal_linking';
set local role c360_worker;
select is(private.worker_commit_page('00000000-0000-4000-8000-0000000a013a', 1, 'p1', pg_temp.counts(2, 1, 1),
  '[{"customer_id":"00000000-0000-4000-8000-00000000c13a","gmail_message_id":"x13c1","gmail_thread_id":"th13","message_at":"2026-10-01T10:00:00Z","direction":"inbound","customer_addresses":[],"evidence":[{"type":"E2","value":"t13.example"}],"score":1},
    {"thread_followup":true,"gmail_message_id":"x13r1","gmail_thread_id":"th13","message_at":"2026-10-02T10:00:00Z"}]'::jsonb,
  '[]', '[]', false), 'running', 'a page with a follow-up commits');
select is(pg_temp.links('x13c1'), 'T13 Thirteenfold Packaging/inbound/E2', 'the customer email is linked as before');
select is(pg_temp.links('x13r1'), '', 'with the setting off, the internal reply is not linked');
reset role;

-- ---- Thread mode --------------------------------------------------------------------------------------
update private.settings set value = 'thread' where key = 'internal_linking';
update private.scan_jobs set lease_until = now() + interval '1 hour' where id = '00000000-0000-4000-8000-0000000a013a';
set local role c360_worker;
select is(private.worker_commit_page('00000000-0000-4000-8000-0000000a013a', 2, 'p2', pg_temp.counts(4, 1, 3),
  '[{"thread_followup":true,"gmail_message_id":"x13r2","gmail_thread_id":"th13","message_at":"2026-10-03T10:00:00Z"},
    {"thread_followup":true,"gmail_message_id":"x13r3","gmail_thread_id":"th13new","message_at":"2026-10-03T11:00:00Z"},
    {"customer_id":"00000000-0000-4000-8000-00000000c13b","gmail_message_id":"x13c2","gmail_thread_id":"th13new","message_at":"2026-10-03T09:00:00Z","direction":"inbound","customer_addresses":[],"evidence":[{"type":"E3","value":"t13 other foods"}],"score":0.95},
    {"thread_followup":true,"gmail_message_id":"x13r4","gmail_thread_id":"th13none","message_at":"2026-10-03T12:00:00Z"},
    {"thread_followup":true,"gmail_message_id":"bad id!","gmail_thread_id":"th13","message_at":"2026-10-03T12:00:00Z"},
    {"customer_id":"00000000-0000-4000-8000-00000000c13a","gmail_message_id":"x13i0","gmail_thread_id":"th13i0","message_at":"2026-10-03T08:00:00Z","direction":"internal","customer_addresses":[],"evidence":[{"type":"I1","value":"t13 thirteenfold packaging"}],"score":0.9}]'::jsonb,
  '[]', '[]', false), 'running', 'a page with follow-ups commits in thread mode');
select is(pg_temp.links('x13i0'), '', 'a subject-named internal link (I1) is refused unless thread_and_named is on');
select is(pg_temp.links('x13r2'), 'T13 Thirteenfold Packaging/internal/T1', 'an internal reply in a linked thread is linked as internal (T1)');
select is(pg_temp.links('x13r3'), 'T13 Other Foods/internal/T1', 'a thread linked on the same page counts too (links first, follow-ups after)');
select is(pg_temp.links('x13r4'), '', 'an internal message in a thread with no customer stays unlinked');
select is(pg_temp.links('bad id!'), '', 'malformed ids are ignored');
reset role;
select is((select count(*) from private.message_links where gmail_message_id like 'x13r%' and owner_id <> '00000000-0000-4000-8000-0000000013a1'), 0::bigint,
  'follow-ups never link into another person''s mailbox');
select is((select status from private.extraction_state where gmail_message_id = 'x13r2'), 'pending', 'internal links are queued for extraction');

-- A follow-up only uses links from the SAME mailbox: Ben has the thread id too, but no link.
update private.settings set value = 'thread_and_named' where key = 'internal_linking';
insert into private.gmail_sync (user_id, mailbox_email, floor_at, lease_until) values
  ('00000000-0000-4000-8000-0000000013b1', 't13.ben@gocirkla.com', now(), now() + interval '5 minutes');
set local role c360_worker;
select is(private.worker_sync_commit('00000000-0000-4000-8000-0000000013b1', '{"history_id":"77","done":true}',
  '[{"thread_followup":true,"gmail_message_id":"x13b1","gmail_thread_id":"th13","message_at":"2026-10-04T10:00:00Z"},
    {"customer_id":"00000000-0000-4000-8000-00000000c13a","gmail_message_id":"x13i1","gmail_thread_id":"th13ben","message_at":"2026-10-04T09:00:00Z","direction":"internal","customer_addresses":[],"evidence":[{"type":"I1","value":"t13 thirteenfold packaging"}],"score":0.9},
    {"thread_followup":true,"gmail_message_id":"x13b2","gmail_thread_id":"th13ben","message_at":"2026-10-04T11:00:00Z"}]'::jsonb,
  '[]', '{"processed":3}', 'm2'), 'ok', 'a sync step with follow-ups commits');
select is(pg_temp.links('x13b1'), '', 'another mailbox''s thread links are never used');
select is(pg_temp.links('x13i1'), 'T13 Thirteenfold Packaging/internal/I1', 'an internal email naming the customer (I1) is accepted');
select is(pg_temp.links('x13b2'), 'T13 Thirteenfold Packaging/internal/T1', 'and later replies in its thread follow it');
reset role;
select is((select linked from private.gmail_sync where user_id = '00000000-0000-4000-8000-0000000013b1'), 2::bigint, 'sync counts follow-up links');

-- ---- Search, extraction ---------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000013a1');
set local role authenticated;
select is((select count(*) from public.search_my_links(p_direction => 'internal')), 2::bigint, 'search can filter on internal emails');
select throws_ok($$ select * from public.search_my_links(p_direction => 'sideways') $$, '22023', null, 'other directions are refused');
reset role;
update private.extraction_state set status = 'claimed', lease_until = now() + interval '5 minutes' where gmail_message_id = 'x13r2';
select lives_ok($$ select private.worker_extract_skip('00000000-0000-4000-8000-0000000013a1', 'x13r2', 'deleted') $$, 'an email deleted in Gmail can be skipped');

-- ---- Targeted scans ----------------------------------------------------------------------------------------
insert into public.customer_identifiers (customer_id, kind, value, source) values
  ('00000000-0000-4000-8000-00000000c13a', 'domain', 't13pack.example', 'manual');
insert into public.customer_aliases (customer_id, alias, kind, source) values ('00000000-0000-4000-8000-00000000c13a', 'T13 Pref', 'alias', 'manual');
select is(private.customer_search_query('00000000-0000-4000-8000-00000000c13a'),
  '{from:t13pack.example to:t13pack.example cc:t13pack.example subject:"t13 pref" subject:"t13 thirteenfold packaging"}',
  'a customer''s Gmail search covers its domains and names');
select pg_temp.act_as('00000000-0000-4000-8000-0000000013a1');
set local role authenticated;
select throws_ok($$ select public.customer_backfill('00000000-0000-4000-8000-00000000c13a') $$, '42501', null, 'only admins can queue a backfill');
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000013c1');
set local role authenticated;
select is(public.customer_backfill('00000000-0000-4000-8000-00000000c13a'), 1, 'a backfill is queued for each approved mailbox with no scan in progress (Ann has one)');
reset role;
select is((select count(*) from private.scan_jobs where search_query is not null and owner_id = '00000000-0000-4000-8000-0000000013b1' and status = 'queued'), 1::bigint,
  'Ben''s targeted scan is queued');
select is((select count(*) from private.scan_jobs where owner_id = '00000000-0000-4000-8000-0000000013c1'), 0::bigint,
  'a mailbox that never had a full scan gets no backfill');
-- A completed targeted scan never makes a mailbox eligible for sync, nor moves where sync starts.
update private.scan_jobs set status = 'completed', finished_at = now(), cutoff_at = now() where search_query is not null and owner_id = '00000000-0000-4000-8000-0000000013b1';
insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at, search_query) values
  ('00000000-0000-4000-8000-0000000013c1', 't13.admin@gocirkla.com', 'completed', 'm2', now(), now(), '{from:t13pack.example}');
select is((select count(*) from private.sync_eligible() where user_id = '00000000-0000-4000-8000-0000000013c1'), 0::bigint,
  'a mailbox with only a targeted scan is not synced');
select ok((select scanned_to from private.sync_eligible() where user_id = '00000000-0000-4000-8000-0000000013b1') < now() - interval '2 days',
  'sync still starts from the last FULL scan');
-- Unsupported characters in an address are left out of the search instead of breaking it.
insert into public.customer_identifiers (customer_id, kind, value, source) values
  ('00000000-0000-4000-8000-00000000c13a', 'email', 'orders#1@t13pack.example', 'manual');
select ok(private.customer_search_query('00000000-0000-4000-8000-00000000c13a') not like '%#%', 'an address with unsupported characters is skipped');
insert into public.customer_aliases (customer_id, alias, kind, source)
select '00000000-0000-4000-8000-00000000c13a', 'T13 alias number ' || g || ' with a fairly long name', 'alias', 'manual' from generate_series(1, 30) g;
select ok(length(private.customer_search_query('00000000-0000-4000-8000-00000000c13a')) <= 500
          and private.customer_search_query('00000000-0000-4000-8000-00000000c13a') like '{from:t13pack.example%',
  'many names: the search keeps the domains and stays within limits');
select throws_ok($$ insert into private.scan_jobs (owner_id, mailbox_email, rules_version, search_query) values
  ('00000000-0000-4000-8000-0000000013c1', 't13.admin@gocirkla.com', 'm2', E'x\nlabel:spam') $$, '23514', null, 'a search with other characters is refused');

-- ---- Audit of direct changes ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000013b1';
select is((select detail ->> 'role_to' from public.audit_log where action = 'user.changed_directly' and target = '00000000-0000-4000-8000-0000000013b1'), 'admin',
  'a role change made outside set_user_role is audited');
select ok((select count(*) from public.audit_log where action = 'setting.changed' and target = 'internal_linking') >= 3, 'setting changes are audited');

select * from finish();
rollback;
