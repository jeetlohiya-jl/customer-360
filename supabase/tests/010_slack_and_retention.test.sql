-- Migration 0010: facts kept on departure (D4), still deleted on disconnect;
-- Slack identity, rate limit, retries, customer matching and fact visibility.
-- Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- ---- Fixtures ----------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000010a1', 't10.ann@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000010b1', 't10.ben@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000010c1', 't10.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000010d1', 't10.dee@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000010c1';

insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000010a1', 't10.ann@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000010b1', 't10.ben@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']);

insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c10a', 'Tenfold Meats Inc'),
  ('00000000-0000-4000-8000-00000000c10b', 'Tenfold Meats Wholesale'),
  ('00000000-0000-4000-8000-00000000c10c', 'Quarry Farms');
insert into public.customer_aliases (customer_id, alias, kind, source) values
  ('00000000-0000-4000-8000-00000000c10c', 'QF Poultry', 'trading', 'manual');

insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at, direction, evidence, score, rules_version, link_status) values
  ('00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-00000000c10a', 'a10m1', null, '2026-09-01T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-00000000c10a', 'a10m2', null, '2026-09-02T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000010b1', '00000000-0000-4000-8000-00000000c10c', 'b10m1', null, '2026-09-03T10:00:00Z', 'inbound', '[]', 1, 'm1', 'auto');

create function pg_temp.f(p_customer text, p_idx int, p_type text, p_conf numeric) returns jsonb language sql as $$
  select jsonb_build_object('customer_id', p_customer, 'fact_index', p_idx, 'fact_type', p_type, 'stance', 'report',
    'party', 'customer', 'basis', 'explicit', 'status', 'open', 'status_basis', 'explicit', 'confidence', p_conf,
    'summary', 'Synthetic ' || p_type || ' ' || p_idx, 'evidence_quote', 'synthetic quote')
$$;
create function pg_temp.n_facts(p_owner uuid) returns bigint language sql security definer as $$
  select count(*) from private.customer_facts where owner_id = p_owner
$$;
create function pg_temp.n_links(p_owner uuid) returns bigint language sql security definer as $$
  select count(*) from private.message_links where owner_id = p_owner
$$;
grant execute on function pg_temp.f(text, int, text, numeric), pg_temp.n_facts(uuid), pg_temp.n_links(uuid) to c360_worker;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

-- Ann: one checked fact (auto) and one that needs review. Ben: one checked fact.
update private.extraction_state set status = 'claimed', lease_until = now() + interval '5 minutes'
 where gmail_message_id in ('a10m1', 'a10m2', 'b10m1');
select private.worker_extract_commit('00000000-0000-4000-8000-0000000010a1', 'a10m1', '{"model":"m","prompt_version":"x3"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c10a', 0, 'order', 0.95)));
select private.worker_extract_commit('00000000-0000-4000-8000-0000000010a1', 'a10m2', '{"model":"m","prompt_version":"x3"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c10a', 0, 'pricing', 0.30)));
select private.worker_extract_commit('00000000-0000-4000-8000-0000000010b1', 'b10m1', '{"model":"m","prompt_version":"x3"}',
  jsonb_build_array(pg_temp.f('00000000-0000-4000-8000-00000000c10c', 0, 'delivery', 0.95)));

-- ---- Privileges -----------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.worker_slack_facts(uuid, uuid[], boolean, integer)', 'execute'), 'clients cannot call the Slack fact lookup');
select ok(not has_function_privilege('anon', 'private.worker_slack_user(text, text)', 'execute'), 'anonymous callers cannot resolve Slack users');
select ok(has_function_privilege('c360_worker', 'private.worker_slack_facts(uuid, uuid[], boolean, integer)', 'execute'), 'the worker can look up facts for Slack');
select ok(not has_function_privilege('c360_worker', 'private.user_can_see_fact(uuid, uuid, text)', 'execute'), 'the worker cannot call the visibility helper directly');
select ok(not has_table_privilege('c360_worker', 'private.slack_usage', 'select'), 'the worker cannot read Slack usage directly');
select is((select value from private.settings where key = 'slack_questions_per_hour'), '30', 'Slack allows 30 questions per person per hour by default');

-- ---- Slack identity -------------------------------------------------------------------
set local role c360_worker;
select is((select count(*) from private.worker_slack_user('U10ANN', null)), 0::bigint, 'an unknown Slack id without an email gets nothing');
select is((select user_id from private.worker_slack_user('U10ANN', 'T10.Ann@gocirkla.com')), '00000000-0000-4000-8000-0000000010a1'::uuid,
  'an active employee is recognised by the email on their Slack account');
select is((select user_id from private.worker_slack_user('U10ANN', null)), '00000000-0000-4000-8000-0000000010a1'::uuid,
  'after that, the linked Slack id is enough');
select is((select count(*) from private.worker_slack_user('U10OUT', 'someone@othercorp.com')), 0::bigint, 'an outside email is refused');
select is((select count(*) from private.worker_slack_user('U10NOB', 'nobody@gocirkla.com')), 0::bigint, 'a workspace email that never signed in is refused');
select is((select is_admin from private.worker_slack_user('U10ADM', 't10.admin@gocirkla.com')), true, 'admins are flagged as admins');
select throws_ok($$ select * from private.worker_slack_user('bad id', null) $$, '22023', null, 'a malformed Slack id is rejected');

-- ---- Retries and rate limit ---------------------------------------------------------------
select is(private.worker_slack_event_seen('Ev10ABC'), false, 'a new Slack event is handled');
select is(private.worker_slack_event_seen('Ev10ABC'), true, 'the same event delivered again is ignored');
reset role;
update private.settings set value = '2' where key = 'slack_questions_per_hour';
set local role c360_worker;
select is(private.worker_slack_allow('00000000-0000-4000-8000-0000000010a1'), true, 'first question allowed');
select is(private.worker_slack_allow('00000000-0000-4000-8000-0000000010a1'), true, 'second question allowed');
select is(private.worker_slack_allow('00000000-0000-4000-8000-0000000010a1'), false, 'over the hourly limit is refused');

-- ---- Customer matching ----------------------------------------------------------------------
select is((select array_agg(customer_name order by customer_name) from private.worker_slack_customers('Any open orders for Tenfold Meats?')),
  array['Tenfold Meats Inc'], 'a customer name in the question is found (legal suffix not needed)');
select is((select array_agg(customer_name order by customer_name) from private.worker_slack_customers('what did qf poultry ask for')),
  array['Quarry Farms'], 'an approved alias finds its customer');
select is((select count(*) from private.worker_slack_customers('tenfoldmeats pricing')), 0::bigint, 'names match whole words only');
select is((select array_agg(customer_name order by customer_name) from private.worker_slack_customers('anything new from Tenfold?')),
  array['Tenfold Meats Inc', 'Tenfold Meats Wholesale'], 'a distinctive first word finds every customer that starts with it');
select is((select array_agg(match_kind) from private.worker_slack_customers('quarry farms and tenfold')),
  array['full'], 'a full name wins: no partial matches are added next to it');
select is((select count(*) from private.worker_slack_customers('any fresh meats news')), 0::bigint, 'generic words never match a customer');

-- ---- Fact visibility: the same rules as the Facts page ------------------------------------
-- Pilot default 'reviewers': Ben sees only his own; Ann sees her own including needs_review.
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000010b1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], false, 50)), 0::bigint, 'with visibility = reviewers, others'' facts are hidden');
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000010a1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], false, 50)), 2::bigint, 'the owner sees her own facts, including ones awaiting review');
reset role;
update private.settings set value = 'all' where key = 'facts_visibility';
set local role c360_worker;
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000010b1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], false, 50)), 1::bigint, 'with visibility = all, others see checked facts but not ones awaiting review');
select is((select source_owner_email from private.worker_slack_facts('00000000-0000-4000-8000-0000000010b1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], false, 50)), null, 'the source mailbox is hidden unless asked');
select is((select source_owner_email from private.worker_slack_facts('00000000-0000-4000-8000-0000000010b1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], true, 50)), 't10.ann@gocirkla.com', 'the source mailbox is shown when asked (D2)');
select is((select gmail_message_id from private.worker_slack_facts('00000000-0000-4000-8000-0000000010b1',
  array['00000000-0000-4000-8000-00000000c10a']::uuid[], true, 50)), null, 'Gmail message ids go only to the mailbox owner');
reset role;

-- ---- D4: departure keeps facts; disconnect still deletes ------------------------------------
select public.set_user_status('00000000-0000-4000-8000-0000000010a1', 'departed')
  from (select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000010c1', true),
               set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000010c1","role":"authenticated"}', true)) s;
select is(pg_temp.n_facts('00000000-0000-4000-8000-0000000010a1'), 2::bigint, 'a departed employee''s facts are kept (D4)');
select is((select count(*) from private.gmail_connections where user_id = '00000000-0000-4000-8000-0000000010a1'), 0::bigint,
  'a departed employee''s Gmail authorization is still deleted');
select is((select count(*) from private.worker_slack_user('U10ANN', null)), 0::bigint, 'a departed employee can no longer ask the Slack bot');

delete from private.gmail_connections where user_id = '00000000-0000-4000-8000-0000000010b1';
select is(pg_temp.n_links('00000000-0000-4000-8000-0000000010b1') + pg_temp.n_facts('00000000-0000-4000-8000-0000000010b1'), 0::bigint,
  'a current employee who disconnects Gmail still has their links and facts deleted');

select * from finish();
rollback;
