-- Migration 0018: customer numbers. Storage rules, checks, visibility, review, Slack. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);
grant c360_worker to current_user;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000018a1', 't18.ann@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000018b1', 't18.ben@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000018c1', 't18.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000018c1';
insert into public.customers (id, canonical_name) values ('00000000-0000-4000-8000-00000000c18a', 'T18 Eighteen Poultry');
insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status) values
  ('00000000-0000-4000-8000-0000000018a1', '00000000-0000-4000-8000-00000000c18a', 'm18a', '2026-11-01T10:00:00Z', 'inbound', '[]', 1, 'm2', 'auto');
update private.extraction_state set status = 'claimed', lease_until = now() + interval '5 minutes' where gmail_message_id = 'm18a';

create function pg_temp.metric(p_idx int, p_value numeric, p_conf numeric, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('customer_id', '00000000-0000-4000-8000-00000000c18a', 'metric_index', p_idx,
    'category', 'production', 'metric', 'birds processed', 'value', p_value, 'unit', 'birds', 'period', 'day',
    'scope', 'Gainesville plant', 'kind', 'actual', 'party', 'customer', 'summary', 'Synthetic: birds per day',
    'evidence_quote', 'synthetic quote', 'confidence', p_conf, 'review_reasons', '[]'::jsonb) || p_extra
$$;
create function pg_temp.err(p jsonb) returns text language plpgsql as $$
declare v text;
begin
  perform private.worker_extract_metrics('00000000-0000-4000-8000-0000000018a1', 'm18a', '{"model":"m","prompt_version":"x7"}', p);
  return 'no error';
exception when others then
  get stacked diagnostics v = message_text;
  return v;
end $$;
create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
grant execute on function pg_temp.metric(int, numeric, numeric, jsonb), pg_temp.err(jsonb) to c360_worker;

-- ---- Privileges --------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.customer_metrics', 'select'), 'clients cannot read numbers directly');
select ok(not has_function_privilege('authenticated', 'private.worker_extract_metrics(uuid, text, jsonb, jsonb)', 'execute'), 'clients cannot store numbers');
select ok(has_function_privilege('c360_worker', 'private.worker_slack_metrics(uuid, uuid[], integer)', 'execute'), 'the Slack worker can read numbers');
select ok(not has_function_privilege('anon', 'public.customer_metrics(uuid, text, integer)', 'execute'), 'anonymous callers cannot read numbers');

-- ---- Storing ------------------------------------------------------------------------------------
set local role c360_worker;
select is(private.worker_extract_metrics('00000000-0000-4000-8000-0000000018a1', 'm18a', '{"model":"m","prompt_version":"x7"}',
  jsonb_build_array(pg_temp.metric(0, 250000, 0.92), pg_temp.metric(1, 3000000, 0.40, '{"category":"packaging_usage","metric":"trays used","unit":"trays","period":"month","scope":null}'))),
  2, 'an email''s numbers are stored');
select is(pg_temp.err(jsonb_build_array(pg_temp.metric(0, 1, 0.9, '{"period":"fortnight"}'))), 'metric 0 rejected by a database check (23514)',
  'a bad value is refused without echoing it');
select is(pg_temp.err(jsonb_build_array(pg_temp.metric(0, 1, 0.9, '{"customer_id":"00000000-0000-4000-8000-00000000ffff"}'))),
  'metric 0 rejected by a database check (22023)', 'a number for a customer the email is not linked to is refused');
select is(pg_temp.err(jsonb_build_array(pg_temp.metric(0, 1, 0.9, '{"category":"spend_price","unit":null,"currency":null}'))),
  'metric 0 rejected by a database check (23514)', 'money needs a currency or unit');
select is(private.worker_extract_metrics('00000000-0000-4000-8000-0000000018a1', 'm18a', '{"model":"m","prompt_version":"x7"}',
  jsonb_build_array(pg_temp.metric(0, 250000, 0.92), pg_temp.metric(1, 3000000, 0.40, '{"category":"packaging_usage","metric":"trays used","unit":"trays","period":"month","scope":null}'))),
  2, 're-extraction replaces the email''s numbers (no duplicates)');
reset role;
select is((select review_state from private.customer_metrics where gmail_message_id = 'm18a' and metric_index = 1), 'needs_review',
  'a low-confidence number awaits review');
select is((select count(*) from private.customer_metrics where gmail_message_id = 'm18a'), 2::bigint, 'two numbers stored');
update private.extraction_state set status = 'extracted', lease_until = null where gmail_message_id = 'm18a';
set local role c360_worker;
select is(pg_temp.err('[]'::jsonb), 'message not claimed', 'numbers can only be stored while the email is being extracted');
reset role;

-- ---- Visibility: same rules as facts -----------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000018a1');
select is((select count(*) from public.customer_metrics('00000000-0000-4000-8000-00000000c18a')), 2::bigint, 'the owner sees all her numbers');
select pg_temp.act_as('00000000-0000-4000-8000-0000000018b1');
select is((select count(*) from public.customer_metrics('00000000-0000-4000-8000-00000000c18a')), 0::bigint, 'a colleague sees none during the pilot');
reset role;
update private.settings set value = 'all' where key = 'facts_visibility';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000018b1');
select is((select count(*) from public.customer_metrics('00000000-0000-4000-8000-00000000c18a')), 1::bigint, 'with visibility all: checked numbers only');
select is((select gmail_message_id from public.customer_metrics('00000000-0000-4000-8000-00000000c18a')), null, 'email ids only for the owner');
select throws_ok($$ select public.metric_review((select id from private.customer_metrics limit 1), 'reject') $$, '42501', null,
  'a colleague cannot review someone else''s number');

-- ---- Review ---------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000018c1');
select lives_ok($$ select public.metric_review((select metric_id from public.customer_metrics('00000000-0000-4000-8000-00000000c18a') where metric = 'birds processed'), 'reject') $$,
  'an admin can reject a number');
select pg_temp.act_as('00000000-0000-4000-8000-0000000018b1');
select is((select count(*) from public.customer_metrics('00000000-0000-4000-8000-00000000c18a')), 0::bigint, 'a rejected number is hidden');
reset role;

-- ---- Slack ------------------------------------------------------------------------------------------
set local role c360_worker;
select is((select count(*) from private.worker_slack_metrics('00000000-0000-4000-8000-0000000018a1', array['00000000-0000-4000-8000-00000000c18a']::uuid[], 50)),
  1::bigint, 'Slack shows the owner her numbers that are not rejected');
reset role;

select * from finish();
rollback;
