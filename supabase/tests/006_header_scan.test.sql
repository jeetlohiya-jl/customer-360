-- Stage 3.1 header scan: privileges, allowlist, worker, dedupe, cancel, retention. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000006a1', 't6.owner@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000006b1', 't6.other@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000006c1', 't6.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000006c1';
insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000006a1', 't6.owner@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']),
  ('00000000-0000-4000-8000-0000000006b1', 't6.other@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']);
insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c6a1', 'T6 Acme Packaging'),
  ('00000000-0000-4000-8000-00000000c6b1', 'T6 Bravo Foods');
insert into public.customers (canonical_name, status) values ('T6 Zulu Inactive', 'inactive');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
create function pg_temp.page(p_job uuid, p_no int, p_token text, p_done boolean) returns text language sql as $$
  select private.worker_commit_page(p_job, p_no, p_token,
    '{"enumerated":6,"excluded_rule":1,"excluded_privacy":1,"excluded_internal":0,"matched":2,"in_review":1,"unmatched":0,"weak_evidence_only":0,"failed":1,"newer_than_cutoff":0}'::jsonb,
    '[{"customer_id":"00000000-0000-4000-8000-00000000c6a1","gmail_message_id":"aa01","gmail_thread_id":"ta01","message_at":"2026-09-01T10:00:00Z","direction":"inbound","customer_addresses":["jane@acme.example"],"evidence":[{"type":"E2","value":"acme.example"}],"score":1},
      {"customer_id":"00000000-0000-4000-8000-00000000c6b1","gmail_message_id":"aa02","gmail_thread_id":null,"message_at":"2026-09-02T10:00:00Z","direction":"outbound","customer_addresses":[],"evidence":[{"type":"E3","value":"t6 bravo foods"}],"score":0.95}]'::jsonb,
    '[{"observed":"t6 acme packagng","reason":"possible spelling variation","candidates":[{"customer_id":"00000000-0000-4000-8000-00000000c6a1","score":0.93,"evidence":"E4"}],
       "messages":[{"gmail_message_id":"aa03","gmail_thread_id":"ta03","message_at":"2026-09-03T10:00:00Z","direction":"inbound"},
                   {"gmail_message_id":"aa04","gmail_thread_id":null,"message_at":"2026-09-04T10:00:00Z","direction":"inbound"}]}]'::jsonb,
    '[{"gmail_message_id":"aa05","error_code":"gmail_api_error_500"}]'::jsonb, p_done)
$$;
-- Test helper reads the job id as the test owner (the worker itself cannot read tables).
create function pg_temp.job() returns uuid language sql security definer as $$
  select id from private.scan_jobs where owner_id = '00000000-0000-4000-8000-0000000006a1'
   order by (status in ('cancelled', 'completed', 'failed')), created_at desc limit 1
$$;
grant execute on function pg_temp.page(uuid, int, text, boolean), pg_temp.job() to c360_worker;
-- Test-only (rolled back): let the worker role call pgTAP's assertion functions.
grant usage on schema extensions to c360_worker;

-- ---- Privileges and defaults ------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.message_links', 'select'), 'clients cannot read message links directly');
select ok(not has_function_privilege('authenticated', 'private.worker_commit_page(uuid, integer, text, jsonb, jsonb, jsonb, jsonb, boolean)', 'execute'), 'clients cannot call worker functions');
select ok(not has_table_privilege('c360_worker', 'private.message_links', 'select'), 'worker cannot read message links');
select ok(not has_table_privilege('c360_worker', 'public.customers', 'select'), 'worker cannot read tables directly');
select ok(not has_table_privilege('c360_worker', 'private.gmail_connections', 'select'), 'worker cannot read the token table');
select ok(has_function_privilege('c360_worker', 'private.worker_claim_job(integer)', 'execute'), 'worker can claim jobs');
select ok(not has_function_privilege('c360_worker', 'public.scan_start()', 'execute'), 'worker cannot start scans');
select ok(not (select rolcanlogin from pg_roles where rolname = 'c360_worker'), 'worker login is disabled until an operator enables it');
select is((select value from private.settings where key = 'scan_allowed_mailboxes'), '', 'no mailbox is approved for scanning by default');

-- ---- Starting: owner only, approved mailbox only ------------------------------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select throws_ok($$ select public.scan_start() $$, '42501', null, 'an unapproved mailbox cannot be scanned');
reset role;
update private.settings set value = 't6.owner@gocirkla.com' where key = 'scan_allowed_mailboxes';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select lives_ok($$ select public.scan_start() $$, 'the owner starts a scan of their own approved mailbox');
select throws_ok($$ select public.scan_start() $$, '23505', null, 'only one scan at a time');
select is((select status from public.my_scan_jobs() limit 1), 'queued', 'owner sees the queued scan');
select pg_temp.act_as('00000000-0000-4000-8000-0000000006b1');
select throws_ok($$ select public.scan_start() $$, '42501', null, 'another employee''s mailbox is not approved');
select is((select count(*)::int from public.my_scan_jobs()), 0, 'another employee sees no scans');

-- ---- Worker -----------------------------------------------------------------
reset role;
set local role c360_worker;
select is((select mailbox_email from private.worker_claim_job(120)), 't6.owner@gocirkla.com', 'worker leases the approved job');
select is((select count(*)::int from private.worker_job_token(pg_temp.job())), 1, 'worker gets the encrypted token of the leased job only');
select is(jsonb_array_length(private.worker_customer_master() -> 'customers') >= 2, true, 'worker reads the customer master snapshot');
select ok(not (private.worker_customer_master() -> 'customers') @> '[{"canonical_name":"T6 Zulu Inactive"}]', 'inactive customers are not matched');
select is(pg_temp.page(pg_temp.job(), 1, 'tok2', false), 'running', 'page 1 committed');
select is(pg_temp.page(pg_temp.job(), 1, 'tok2', false), 'duplicate', 're-sending page 1 is a no-op');
select throws_ok($$ select pg_temp.page(pg_temp.job(), 2, 'tok3', false) $$, '55000', null, 'a page cannot be committed without holding the lease');
select is((select count(*)::int from private.worker_claim_job(120)), 1, 'the job is claimable again for the next page');
select throws_ok($$ select pg_temp.page(pg_temp.job(), 3, 'tok4', false) $$, '22023', null, 'pages must be committed in order');
select throws_ok(
  $$ select private.worker_commit_page(pg_temp.job(), 2, null,
       '{"enumerated":5,"excluded_rule":0,"excluded_privacy":0,"excluded_internal":0,"matched":1,"in_review":0,"unmatched":0,"weak_evidence_only":0,"failed":0,"newer_than_cutoff":0}'::jsonb,
       '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, true) $$,
  '22023', null, 'counts that do not add up are refused');

-- ---- Owner sees their links; nobody else does ----------------------------------
reset role;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select is((select count(*)::int from public.my_message_links()), 2, 'owner sees their two linked messages');
select is((select customer_addresses from public.my_message_links() where gmail_message_id = 'aa01'), array['jane@acme.example'], 'customer contact stored (CS4)');
select pg_temp.act_as('00000000-0000-4000-8000-0000000006b1');
select is((select count(*)::int from public.my_message_links()), 0, 'another employee sees none of them');
select pg_temp.act_as('00000000-0000-4000-8000-0000000006c1');
select is((select count(*)::int from public.my_message_links()), 0, 'an admin cannot see the owner''s links either');
select is((select enumerated from public.scan_jobs_overview() where mailbox_email = 't6.owner@gocirkla.com'), 6, 'admin sees counts only');
select throws_ok($$ select * from private.message_links $$, '42501', null, 'direct table access is denied');

-- ---- Review decision links the waiting messages ---------------------------------
select is((select occurrences from public.review_queue_list(50) where observed = 't6 acme packagng'), 1, 'uncertain name from the scan is in the queue');
select lives_ok(
  $$ select public.review_resolve((select id from public.review_queue_list(50) where observed = 't6 acme packagng'),
                                  'same_customer', '00000000-0000-4000-8000-00000000c6a1') $$,
  'reviewer confirms the spelling');
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select is((select count(*)::int from public.my_message_links() where link_status = 'confirmed'), 2, 'its two waiting messages are now linked');

-- ---- Cancel ---------------------------------------------------------------------
select lives_ok($$ select public.scan_cancel() $$, 'owner cancels the running scan');
select is((select status from public.my_scan_jobs() limit 1), 'cancelling', 'running scan is marked cancelling');
reset role;
update private.scan_jobs set lease_until = null where id = pg_temp.job();
set local role c360_worker;
select is((select count(*)::int from private.worker_claim_job(120)), 0, 'worker closes the cancelled scan and takes no job');
reset role;
select is((select status from private.scan_jobs where id = pg_temp.job()), 'cancelled', 'scan is cancelled');

-- ---- Lost authorization, then resume ---------------------------------------------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select lives_ok($$ select public.scan_start() $$, 'a new scan can start after cancelling');
reset role;
set local role c360_worker;
select is((select count(*)::int from private.worker_claim_job(120)), 1, 'worker leases it');
select lives_ok($$ select private.worker_auth_lost(pg_temp.job()) $$, 'Google refused the token');
reset role;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select is((select status from public.my_scan_jobs() limit 1), 'paused_auth', 'scan waits for the owner');
select lives_ok($$ select public.scan_resume() $$, 'owner resumes after reconnecting');

-- ---- Allowlist removal stops the worker immediately --------------------------------
reset role;
update private.settings set value = '' where key = 'scan_allowed_mailboxes';
set local role c360_worker;
select is((select count(*)::int from private.worker_claim_job(120)), 0, 'removing the mailbox from the approved list stops the scan');
reset role;
update private.settings set value = 't6.owner@gocirkla.com' where key = 'scan_allowed_mailboxes';

-- ---- Retention (CS9) ---------------------------------------------------------------
insert into private.scan_failures (job_id, gmail_message_id, error_code, created_at)
values (pg_temp.job(), 'old01', 'x', now() - interval '20 days');
set local role c360_worker;
select ok(private.worker_retention_cleanup() >= 1, 'failure records older than 14 days are deleted');
reset role;
select is((select count(*)::int from private.scan_failures where gmail_message_id = 'old01'), 0, 'old failure is gone');
select throws_ok($$ update private.scan_jobs set matched = matched + 1 where id = pg_temp.job() $$, '23514', null, 'job totals must always reconcile');

update public.customers set status = 'inactive' where id = '00000000-0000-4000-8000-00000000c6b1';
select is((select count(*)::int from private.message_links where customer_id = '00000000-0000-4000-8000-00000000c6b1'), 0,
  'links to a customer marked inactive are deleted');

set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000006a1');
select lives_ok($$ select public.disconnect_gmail(true) $$, 'owner disconnects Gmail');
reset role;
select is((select count(*)::int from private.message_links where owner_id = '00000000-0000-4000-8000-0000000006a1'), 0,
  'disconnecting deletes that mailbox''s links (CS9)');
select is((select status from private.scan_jobs where id = pg_temp.job()), 'cancelled', 'and stops its scan');
select is(
  (select array_agg(distinct action order by action)::text from public.audit_log
    where action like 'scan.%' and (target = pg_temp.job()::text or target in (select id::text from private.scan_jobs where owner_id = '00000000-0000-4000-8000-0000000006a1') or target = '00000000-0000-4000-8000-0000000006a1')),
  '{scan.cancel_requested,scan.cancelled,scan.data_deleted_on_disconnect,scan.paused_auth,scan.resumed,scan.started}',
  'every scan step is audited');

select * from finish();
rollback;
