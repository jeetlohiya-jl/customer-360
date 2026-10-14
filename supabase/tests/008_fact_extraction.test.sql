-- Stage B + C draft: extraction state, budget hard stop, fact rules, access,
-- review and deletion. Synthetic data only; no email content anywhere.
begin;
create extension if not exists pgtap with schema extensions;
select plan(101);

-- ---- Fixtures ----------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000008a1', 't8.ann@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000008b1', 't8.ben@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000008c1', 't8.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000008d1', 't8.dee@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000008c1';

insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000008a1', 't8.ann@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000008b1', 't8.ben@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']);

insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c8a1', 'T8 Xeno Meats'),
  ('00000000-0000-4000-8000-00000000c8b1', 'T8 Yarrow Foods');

insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at, direction, evidence, score, rules_version, link_status) values
  ('00000000-0000-4000-8000-0000000008a1', '00000000-0000-4000-8000-00000000c8a1', 'a8m1', 'a8t1', '2026-08-01T10:00:00Z', 'inbound',  '[]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000008a1', '00000000-0000-4000-8000-00000000c8a1', 'a8m2', 'a8t1', '2026-09-20T10:00:00Z', 'inbound',  '[]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000008a1', '00000000-0000-4000-8000-00000000c8b1', 'a8m3', null,   '2026-09-25T10:00:00Z', 'outbound', '[]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000008b1', '00000000-0000-4000-8000-00000000c8b1', 'b8m1', null,   '2026-09-26T10:00:00Z', 'inbound',  '[]', 1, 'm1', 'auto');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
-- Test helpers read state as the test owner (the worker cannot read tables).
create function pg_temp.state(p_msg text) returns text language sql security definer as $$
  select status from private.extraction_state where gmail_message_id = p_msg
$$;
create function pg_temp.fact(p_msg text, p_idx int) returns private.customer_facts language sql security definer as $$
  select * from private.customer_facts where gmail_message_id = p_msg and fact_index = p_idx
$$;
create function pg_temp.f(p_customer text, p_idx int, p_type text, p_stance text, p_basis text, p_status text,
                          p_sbasis text, p_conf numeric, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('customer_id', p_customer, 'fact_index', p_idx, 'fact_type', p_type, 'stance', p_stance,
    'party', 'customer', 'basis', p_basis, 'status', p_status, 'status_basis', p_sbasis, 'confidence', p_conf,
    'summary', 'Synthetic ' || p_type || ' ' || p_idx, 'evidence_quote', 'synthetic quote') || p_extra
$$;
create function pg_temp.commit_error(p_owner uuid, p_msg text, p_facts jsonb) returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform private.worker_extract_commit(p_owner, p_msg, '{"model":"m","prompt_version":"x1"}', p_facts);
  return 'no error';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return v_msg || '|' || coalesce(v_detail, '');
end $$;
create function pg_temp.review_error(p_fact uuid, p_changes jsonb) returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform public.fact_review(p_fact, 'correct', p_changes);
  return 'no error';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return v_msg || '|' || coalesce(v_detail, '');
end $$;
grant execute on function pg_temp.commit_error(uuid, text, jsonb), pg_temp.review_error(uuid, jsonb) to c360_worker, authenticated;
grant execute on function pg_temp.state(text), pg_temp.fact(text, int), pg_temp.f(text, int, text, text, text, text, text, numeric, jsonb) to c360_worker, authenticated;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

create temp table ctx (k text primary key, v text) on commit drop;
grant all on ctx to c360_worker, authenticated;

-- ---- Privileges and defaults -----------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.customer_facts', 'select'), 'clients cannot read facts directly');
select ok(not has_table_privilege('c360_worker', 'private.customer_facts', 'select'), 'the worker cannot read facts directly');
select ok(not has_table_privilege('c360_worker', 'private.extraction_state', 'select'), 'the worker cannot read extraction state directly');
select ok(not has_function_privilege('authenticated', 'private.worker_extract_commit(uuid, text, jsonb, jsonb)', 'execute'), 'clients cannot commit facts');
select ok(not has_function_privilege('authenticated', 'private.worker_budget_reserve(bigint)', 'execute'), 'clients cannot touch the budget');
select ok(not has_function_privilege('anon', 'public.facts_search(text, uuid, text, text, date, date, timestamptz, uuid, integer, text, text)', 'execute'), 'anonymous callers cannot search facts');
select ok(not has_function_privilege('c360_worker', 'public.facts_search(text, uuid, text, text, date, date, timestamptz, uuid, integer, text, text)', 'execute'), 'the worker cannot search facts');
select is((select value from private.settings where key = 'extract_allowed_mailboxes'), '', 'no mailbox is approved for extraction by default');
select is((select value from private.settings where key = 'extract_monthly_cap_usd'), '50', 'the monthly cap defaults to $50');
select is((select value from private.settings where key = 'facts_show_source_owner'), 'off', 'source mailbox owner hidden by default');
select is((select count(*)::int from information_schema.columns where table_schema = 'private' and table_name = 'customer_facts'
           and column_name in ('body', 'subject', 'snippet', 'content', 'raw')), 0, 'facts have no body, subject or snippet column');
select is((select count(*)::int from information_schema.columns where table_schema = 'private' and table_name = 'ai_usage'
           and column_name in ('owner_id', 'gmail_message_id', 'customer_id')), 0, 'usage records name no mailbox, message or customer');

-- ---- Extraction state follows links ---------------------------------------------------
select is((select count(*)::int from private.extraction_state where owner_id = '00000000-0000-4000-8000-0000000008a1'), 3, 'each linked message gets one pending item');
select is(pg_temp.state('a8m1'), 'pending', 'new items start pending');

-- ---- Claiming: allowlist and permission ------------------------------------------------
set local role c360_worker;
select is((select count(*)::int from private.worker_extract_claim(10, 120)), 0, 'nothing is claimed while no mailbox is approved');
reset role;
update private.settings set value = 't8.ann@gocirkla.com, t8.ben@gocirkla.com' where key = 'extract_allowed_mailboxes';
set local role c360_worker;
select is((select string_agg(gmail_message_id, ',' order by message_at desc) from private.worker_extract_claim(10, 120)),
          'a8m3,a8m2,a8m1', 'approved mailbox with gmail.readonly: newest first');
select is(pg_temp.state('b8m1'), 'needs_reconnect', 'a mailbox with header-only permission waits for reconnect');
select is((select count(*)::int from private.worker_extract_token('00000000-0000-4000-8000-0000000008a1')), 1, 'token released for an owner with claimed items');
select is((select count(*)::int from private.worker_extract_token('00000000-0000-4000-8000-0000000008b1')), 0, 'no token without gmail.readonly');
reset role;
update private.gmail_connections set scopes = array['https://www.googleapis.com/auth/gmail.readonly'] where user_id = '00000000-0000-4000-8000-0000000008b1';
select is(pg_temp.state('b8m1'), 'pending', 'reconnecting with gmail.readonly releases the item');

-- ---- Budget: reservations and the hard stop -------------------------------------------
set local role c360_worker;
insert into ctx values ('r1', private.worker_budget_reserve(1400)::text);
select isnt((select v from ctx where k = 'r1'), null, 'a call within the cap is reserved');
select lives_ok($$ select private.worker_budget_settle((select v from ctx where k = 'r1')::uuid,
  '{"actual_microusd":350,"input_tokens":1000,"cache_read_tokens":2500,"cache_write_tokens":0,"output_tokens":400,"model":"claude-haiku-5-5"}') $$,
  'the call is settled at its actual cost');
select throws_ok($$ select private.worker_budget_settle((select v from ctx where k = 'r1')::uuid, '{"actual_microusd":1}') $$,
  '55000', null, 'a reservation settles once');
select throws_ok($$ select private.worker_budget_reserve(500000) $$, '22023', null, 'one call cannot reserve more than $0.10');
reset role;
select is((select spent_microusd from private.ai_budget where month = private.budget_month()), 350::bigint, 'spend is recorded in micro-USD');
-- Lower the cap to just above what is spent: the next reservation must stop everything.
update private.ai_budget set cap_microusd = 1000 where month = private.budget_month();
set local role c360_worker;
select is(private.worker_budget_reserve(1400), null, 'a call that would cross the cap is refused');
select is((select count(*)::int from private.worker_extract_claim(10, 120)), 0, 'after the hard stop nothing more is claimed');
select is(private.worker_budget_reserve(1), null, 'even a tiny call is refused for the rest of the month');
reset role;
select ok((select paused_at is not null from private.ai_budget where month = private.budget_month()), 'the month is marked paused');
select is((select count(*)::int from public.audit_log where action = 'extract.budget_paused'), 1, 'the stop is audited once');
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008a1');
select throws_ok($$ select public.extraction_set_cap(100) $$, '42501', null, 'only an admin can change the cap');
select pg_temp.act_as('00000000-0000-4000-8000-0000000008c1');
select throws_ok($$ select public.extraction_set_cap(1000) $$, '22023', null, 'the cap cannot exceed $500');
select lives_ok($$ select public.extraction_set_cap(50) $$, 'an admin restores the cap');
select is((select paused from public.extraction_overview()), false, 'raising the cap lifts the pause');
reset role;
-- A crashed call is counted at its full reservation after 15 minutes.
set local role c360_worker;
insert into ctx values ('r2', private.worker_budget_reserve(1400)::text);
reset role;
update private.ai_usage set created_at = now() - interval '20 minutes' where id = (select v from ctx where k = 'r2')::uuid;
select is((private.budget_prepare()).spent_microusd, 1750::bigint, 'an unsettled call is charged at its maximum');

-- ---- Commit: fact rules ----------------------------------------------------------------
set local role c360_worker;
select is(private.worker_extract_commit('00000000-0000-4000-8000-0000000008a1', 'a8m1',
  '{"model":"claude-haiku-5-5","prompt_version":"x1"}',
  jsonb_build_array(
    pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'order', 'request', 'explicit', 'open', 'explicit', 0.95, '{"quantity":5000,"unit":"cases","due_date":"2026-11-12"}'),
    pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 1, 'quality_issue', 'report', 'explicit', 'open', 'explicit', 0.92),
    pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 2, 'pricing', 'commitment', 'explicit', 'not_applicable', 'none', 0.80, '{"unit_price":0.21,"currency":"USD"}'),
    pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 3, 'follow_up', 'request', 'explicit', 'open', 'explicit', 0.55)
  )), 4, 'four facts committed for one email');
select is(pg_temp.state('a8m1'), 'extracted', 'the item is marked extracted');
select is((pg_temp.fact('a8m1', 0)).stance, 'request', 'a customer request stays a request');
select is((pg_temp.fact('a8m1', 0)).review_state, 'auto', 'a confident, checked fact is visible without review');
select is((pg_temp.fact('a8m1', 2)).review_state, 'needs_review', 'a price commitment under 0.90 confidence goes to review');
select is((pg_temp.fact('a8m1', 3)).review_reasons, array['low_confidence'], 'low confidence goes to review with its reason');
select throws_ok($$ select private.worker_extract_commit('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  '{"model":"m","prompt_version":"x1"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'order', 'commitment', 'inferred', 'open', 'explicit', 0.99))) $$,
  '23514', null, 'an inferred commitment is refused by the database');
select throws_ok($$ select private.worker_extract_commit('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  '{"model":"m","prompt_version":"x1"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8b1', 0, 'order', 'request', 'explicit', 'open', 'explicit', 0.9))) $$,
  '22023', null, 'a fact for a customer not linked to the email is refused');
select throws_ok($$ select private.worker_extract_commit('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  '{"model":"m","prompt_version":"x1"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'pricing', 'proposal', 'explicit', 'not_applicable', 'none', 0.9, '{"unit_price":0.2}'))) $$,
  '23514', null, 'a price without a currency is refused');
select throws_ok($$ select private.worker_extract_commit('00000000-0000-4000-8000-0000000008b1', 'b8m1', '{"model":"m","prompt_version":"x1"}', '[]') $$,
  '55000', null, 'an unclaimed message cannot be committed');
-- Error messages never carry fact text (so it cannot reach the database server log).
select is(pg_temp.commit_error('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'order', 'request', 'explicit', 'bogus-status', 'explicit', 0.9,
    '{"summary":"SECRET-SUMMARY-TEXT for the log test"}'))),
  'fact 0 rejected by a database check (23514)|', 'a constraint failure reports no values and no detail');
select is(pg_temp.commit_error('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'order', 'request', 'explicit', 'open', 'explicit', 0.9,
    '{"quantity":"SECRET-QTY-TEXT"}'))) ~ 'SECRET', false, 'a type error reports no values');
insert into ctx values ('issue', (pg_temp.fact('a8m1', 1)).id::text);
-- A later email explicitly resolves the quality issue; another only implies the order shipped.
select is(private.worker_extract_commit('00000000-0000-4000-8000-0000000008a1', 'a8m2',
  '{"model":"claude-haiku-5-5","prompt_version":"x1"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'quality_issue', 'report', 'explicit', 'resolved', 'explicit', 0.93,
    jsonb_build_object('resolves_fact_id', (select v from ctx where k = 'issue'))))), 1, 'a resolving fact is committed');
reset role;
select is((select status || '/' || status_basis from private.customer_facts where id = (select v from ctx where k = 'issue')::uuid),
          'resolved/explicit', 'an explicit resolution closes the earlier issue');
set local role c360_worker;
select is(private.worker_extract_skip('00000000-0000-4000-8000-0000000008a1', 'a8m3', 'auto_reply')::text, '', 'pre-filtered emails are skipped with a reason');
reset role;
select is((select status || '/' || status_basis || '/' || review_state from private.customer_facts
            where id = (pg_temp.fact('a8m1', 0)).id), 'open/explicit/auto', 'the order is untouched until something updates it');

-- Inferred status change goes to review
set local role c360_worker;
select is((select count(*)::int from private.worker_extract_claim(10, 120) where gmail_message_id = 'b8m1'), 1, 'Ben''s email is claimed after reconnect');
reset role;
insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
values ('00000000-0000-4000-8000-0000000008b1', '00000000-0000-4000-8000-00000000c8a1', 'b8m1', '2026-09-26T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto');
insert into ctx values ('order', (pg_temp.fact('a8m1', 0)).id::text);
set local role c360_worker;
select is(private.worker_extract_commit('00000000-0000-4000-8000-0000000008b1', 'b8m1',
  '{"model":"claude-haiku-5-5","prompt_version":"x1"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c8a1', 0, 'delivery', 'report', 'explicit', 'resolved', 'inferred', 0.88,
    jsonb_build_object('resolves_fact_id', (select v from ctx where k = 'order'))))), 1, 'a fact implying the order shipped is committed');
reset role;
select is((select review_state from private.customer_facts where id = (select v from ctx where k = 'order')::uuid), 'needs_review',
          'an inferred resolution never closes silently: the earlier fact goes to review');

-- ---- Access ----------------------------------------------------------------------------
select is((select value from private.settings where key = 'facts_visibility'), 'reviewers', 'pilot default: only owners and admins see facts');
select ok(not has_function_privilege('authenticated', 'private.worker_extract_context(uuid, text)', 'execute'), 'clients cannot read the worker''s fact context');
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008b1');
select is((select count(*)::int from public.facts_search() where not is_mine), 0, 'during the pilot a colleague sees no facts from another mailbox');
select is((select count(*)::int from public.search_my_links() where gmail_message_id like 'a8%'), 0, 'a colleague cannot reach another mailbox''s email references');
select pg_temp.act_as('00000000-0000-4000-8000-0000000008c1');
select ok((select count(*) from public.facts_search() where not is_mine) >= 1, 'an admin sees facts from every mailbox during the pilot');
select is((select count(*)::int from public.facts_search() where not is_mine and gmail_message_id is not null), 0, 'even an admin never gets another mailbox''s Gmail ids');
reset role;
update private.settings set value = 'all' where key = 'facts_visibility';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008b1');
select ok((select count(*) from public.facts_search(p_customer => '00000000-0000-4000-8000-00000000c8a1') where not is_mine) >= 1,
          'a colleague sees checked facts from another mailbox');
select is((select count(*)::int from public.facts_search() where not is_mine and gmail_message_id is not null), 0,
          'Gmail message ids are never shown to someone else');
select is((select count(*)::int from public.facts_search() where not is_mine and source_owner_email is not null), 0,
          'the source mailbox owner is hidden while the setting is off');
select is((select count(*)::int from public.facts_search() where not is_mine and review_state = 'needs_review'), 0,
          'unreviewed facts from someone else''s mailbox are hidden');
select is((select count(*)::int from public.facts_review_queue() where not is_mine), 0, 'a colleague cannot review someone else''s facts');
select throws_ok($$ select public.fact_review((select v from ctx where k = 'order')::uuid, 'confirm') $$, 'P0002', null,
          'a colleague cannot confirm someone else''s fact');
select pg_temp.act_as('00000000-0000-4000-8000-0000000008a1');
select ok((select count(*) from public.facts_search() where is_mine and review_state = 'needs_review') >= 1, 'the owner sees their own facts awaiting review');
select throws_ok($$ select public.fact_review((pg_temp.fact('a8m1', 3)).id, 'correct', '{"owner_id":"x"}') $$, '22023', null,
          'only listed fields can be corrected');
select lives_ok($$ select public.fact_review((pg_temp.fact('a8m1', 3)).id, 'reject', '{}', 'not a real follow-up') $$, 'the owner rejects a wrong fact');
select is((select count(*)::int from public.facts_search() where fact_id = (pg_temp.fact('a8m1', 3)).id), 0, 'rejected facts are hidden');
select pg_temp.act_as('00000000-0000-4000-8000-0000000008c1');
select lives_ok($$ select public.fact_review((pg_temp.fact('a8m1', 2)).id, 'correct', '{"unit_price":0.22}', 'checked with sales') $$,
          'an admin corrects a fact from any mailbox');
select is((select review_state from public.facts_search() where fact_id = (pg_temp.fact('a8m1', 2)).id), 'corrected', 'the corrected fact is visible as reviewed');
select is((select count(*)::int from public.audit_log where action in ('fact.reject', 'fact.correct') and detail = '{}'::jsonb), 2,
          'review actions are audited without content');
reset role;
update private.settings set value = 'on' where key = 'facts_show_source_owner';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008b1');
select ok((select bool_and(source_owner_email = 't8.ann@gocirkla.com') from public.facts_search() where not is_mine), 'with the setting on, the source mailbox owner is shown');
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$ select * from public.facts_search() $$, '42501', null, 'no signed-in user, no facts');
reset role;

-- ---- Sanitised review errors, filters, inspection, retries, scopes ----------------------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008c1');
select is(pg_temp.review_error((pg_temp.fact('a8m1', 0)).id, '{"currency":"SECRETX"}'),
  'correction rejected by a database check (23514)|', 'a bad correction reports no values');
select is((select count(*)::int from public.facts_search(p_stance => 'cancellation')), 0, 'stance filter');
select ok((select count(*) from public.facts_search(p_review => 'needs_review')) >= 1, 'review filter: awaiting review');
select is((select count(*)::int from public.facts_search(p_review => 'reviewed') where review_state not in ('confirmed', 'corrected')), 0, 'review filter: reviewed');
select throws_ok($$ select * from public.facts_search(p_stance => 'maybe') $$, '22023', null, 'unknown stance refused');
select ok((select count(*) from public.facts_customers()) >= 1, 'admin: customer overview lists customers with facts');
select pg_temp.act_as('00000000-0000-4000-8000-0000000008a1');
select ok((select facts from public.my_extraction_status()) >= 1, 'owner: own extraction status');
select throws_ok($$ select * from public.extraction_failures() $$, '42501', null, 'only admins see failure codes');
reset role;
update private.settings set value = 'reviewers' where key = 'facts_visibility';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008b1');
select is((select facts from public.facts_customers() where customer_id = '00000000-0000-4000-8000-00000000c8a1'), 1,
  'during the pilot a colleague''s customer counts include only their own facts');
select lives_ok($$ select public.connect_gmail('t8.ben@gocirkla.com', 'v1.iv.ct.tag', 1::smallint, array['https://www.googleapis.com/auth/gmail.readonly']) $$,
  'connecting with gmail.readonly alone is accepted');
select throws_ok($$ select public.connect_gmail('t8.ben@gocirkla.com', 'v1.iv.ct.tag', 1::smallint, array['openid']) $$, '22023', null,
  'a connection without a Gmail scope is refused');
reset role;
-- Retries with backoff: 15 then 30 minutes, then failed; an admin can requeue.
insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
values ('00000000-0000-4000-8000-0000000008b1', '00000000-0000-4000-8000-00000000c8a1', 'b8m9', '2026-09-28T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto');
set local role c360_worker;
select is((select count(*)::int from private.worker_extract_claim(10, 120) where gmail_message_id = 'b8m9'), 1, 'new item claimed');
select is(private.worker_extract_fail('00000000-0000-4000-8000-0000000008b1', 'b8m9', 'model:anthropic:http_error_529_overloaded_error'), 'pending', 'first failure: retried later');
select is((select count(*)::int from private.worker_extract_claim(10, 120) where gmail_message_id = 'b8m9'), 0, 'not retried before its backoff');
reset role;
select ok((select next_attempt_at between now() + interval '14 minutes' and now() + interval '16 minutes' from private.extraction_state where gmail_message_id = 'b8m9'), 'first backoff is 15 minutes');
update private.extraction_state set next_attempt_at = now() - interval '1 second' where gmail_message_id = 'b8m9';
set local role c360_worker;
select is((select count(*)::int from private.worker_extract_claim(10, 120) where gmail_message_id = 'b8m9'), 1, 'retried after the backoff');
select is(private.worker_extract_fail('00000000-0000-4000-8000-0000000008b1', 'b8m9', 'model:anthropic:http_error_529_overloaded_error'), 'pending', 'second failure: retried later');
reset role;
update private.extraction_state set next_attempt_at = now() - interval '1 second' where gmail_message_id = 'b8m9';
set local role c360_worker;
select is((select count(*)::int from private.worker_extract_claim(10, 120) where gmail_message_id = 'b8m9'), 1, 'third attempt');
select is(private.worker_extract_fail('00000000-0000-4000-8000-0000000008b1', 'b8m9', 'model:anthropic:http_error_529_overloaded_error'), 'failed', 'third failure is final');
reset role;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000008c1');
select results_eq($$ select code, failed from public.extraction_failures() $$,
  $$ values ('model:anthropic:http_error_529_overloaded_error'::text, 1) $$, 'admin sees failure codes, nothing else');
select is(public.extraction_retry_failed(), 1, 'admin requeues failed items');
reset role;
select is(pg_temp.state('b8m9'), 'pending', 'the item is back in the queue');

-- ---- Deletion --------------------------------------------------------------------------
delete from private.gmail_connections where user_id = '00000000-0000-4000-8000-0000000008a1';
select is((select count(*)::int from private.customer_facts where owner_id = '00000000-0000-4000-8000-0000000008a1'), 0,
          'disconnecting Gmail deletes that mailbox''s facts');
select is((select count(*)::int from private.extraction_state where owner_id = '00000000-0000-4000-8000-0000000008a1'), 0,
          'and its extraction state');
select is((select count(*)::int from private.customer_facts where owner_id = '00000000-0000-4000-8000-0000000008b1'), 1,
          'another mailbox''s facts are untouched');
update public.customers set status = 'inactive' where id = '00000000-0000-4000-8000-00000000c8a1';
select is((select count(*)::int from private.customer_facts where customer_id = '00000000-0000-4000-8000-00000000c8a1'), 0,
          'marking a customer inactive deletes its facts');

select * from finish();
rollback;
