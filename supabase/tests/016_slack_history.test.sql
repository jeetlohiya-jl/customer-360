-- Migration 0016: the Slack worker can read more than 120 facts (history answers). Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);
grant c360_worker to current_user;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000016a1', 't16.ann@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000016d1', 't16.gone@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set status = 'departed' where id = '00000000-0000-4000-8000-0000000016d1';
insert into public.customers (id, canonical_name) values ('00000000-0000-4000-8000-00000000c16a', 'T16 Sixteen Foods');
insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
select '00000000-0000-4000-8000-0000000016a1', '00000000-0000-4000-8000-00000000c16a', 'm16-' || m, now() - (m || ' days')::interval, 'inbound', '[]', 1, 'm2', 'auto'
  from generate_series(1, 30) m;
insert into private.customer_facts (owner_id, customer_id, gmail_message_id, message_at, direction, fact_index, fact_type, stance,
  party, basis, status, status_basis, summary, confidence, review_state, model, prompt_version)
select l.owner_id, l.customer_id, l.gmail_message_id, l.message_at, 'inbound', i, 'follow_up', 'request',
       'customer', 'explicit', 'open', 'explicit', 'synthetic fact ' || i, 0.9, 'auto', 'm', 'x6'
  from private.message_links l, generate_series(0, 9) i
 where l.gmail_message_id like 'm16-%';

set local role c360_worker;
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000016a1',
  array['00000000-0000-4000-8000-00000000c16a']::uuid[], true, 1000)), 300::bigint, 'a history question can read all 300 facts');
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000016a1',
  array['00000000-0000-4000-8000-00000000c16a']::uuid[], true, 5000)), 300::bigint, 'and the cap still applies (1000)');
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000016d1',
  array['00000000-0000-4000-8000-00000000c16a']::uuid[], true, 1000)), 0::bigint, 'a departed person still sees nothing');
reset role;

select * from finish();
rollback;
