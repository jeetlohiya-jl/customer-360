-- Migration 0015: the faster fact functions return EXACTLY what the per-row
-- rule (private.can_see_fact / user_can_see_fact) allows. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
grant c360_worker to current_user;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000015a1', 't15.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000015b1', 't15.ann@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000015c1', 't15.ben@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000015d1', 't15.gone@gocirkla.com',  '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000015a1';
update public.app_users set status = 'departed' where id = '00000000-0000-4000-8000-0000000015d1';
insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c15a', 'T15 Fifteen Foods'),
  ('00000000-0000-4000-8000-00000000c15b', 'T15 Other Trays');

-- One linked email per (owner, customer), then facts in every review state.
insert into private.message_links (owner_id, customer_id, gmail_message_id, message_at, direction, evidence, score, rules_version, link_status)
select o, c, 'm15' || substr(o::text, 33, 2) || substr(c::text, 36, 1), now() - interval '1 day', 'inbound', '[]', 1, 'm2', 'auto'
  from unnest(array['00000000-0000-4000-8000-0000000015b1', '00000000-0000-4000-8000-0000000015c1']::uuid[]) o,
       unnest(array['00000000-0000-4000-8000-00000000c15a', '00000000-0000-4000-8000-00000000c15b']::uuid[]) c;
insert into private.customer_facts (owner_id, customer_id, gmail_message_id, message_at, direction, fact_index, fact_type, stance,
  party, basis, status, status_basis, summary, confidence, review_state, reviewed_at, model, prompt_version)
select l.owner_id, l.customer_id, l.gmail_message_id, l.message_at - (i || ' minutes')::interval, 'inbound', i, 'follow_up', 'request',
       'customer', 'explicit', case when i % 2 = 0 then 'open' else 'resolved' end, 'explicit', 'synthetic samples fact ' || i, 0.9,
       (array['auto', 'needs_review', 'confirmed', 'corrected', 'rejected'])[i % 5 + 1],
       case when (array['auto', 'needs_review', 'confirmed', 'corrected', 'rejected'])[i % 5 + 1] in ('confirmed', 'corrected', 'rejected') then now() end,
       'm', 'x5'
  from private.message_links l, generate_series(0, 9) i
 where l.gmail_message_id like 'm15%';

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
-- What the original per-row rule allows, as counts per customer (customer, facts, open, needs_review).
create function pg_temp.expected() returns text language sql security definer as $$
  select coalesce(string_agg(x, ';' order by x), '') from (
    select c.canonical_name || ':' || count(*) || '/' || count(*) filter (where f.status = 'open')
           || '/' || count(*) filter (where f.review_state = 'needs_review') as x
      from private.customer_facts f join public.customers c on c.id = f.customer_id
     where f.gmail_message_id like 'm15%' and private.can_see_fact(f.owner_id, f.review_state)
     group by c.canonical_name) s
$$;
create function pg_temp.actual() returns text language sql as $$
  select coalesce(string_agg(customer_name || ':' || facts || '/' || open_facts || '/' || needs_review, ';' order by customer_name || ':' || facts), '')
    from public.facts_customers() where customer_name like 'T15%'
$$;
create function pg_temp.search_expected() returns bigint language sql security definer as $$
  select count(*) from private.customer_facts f where f.gmail_message_id like 'm15%' and private.can_see_fact(f.owner_id, f.review_state)
$$;
create function pg_temp.slack_expected(p_user uuid) returns bigint language sql security definer as $$
  select count(*) from private.customer_facts f where f.gmail_message_id like 'm15%' and private.user_can_see_fact(p_user, f.owner_id, f.review_state)
$$;
grant execute on function pg_temp.expected(), pg_temp.actual(), pg_temp.search_expected() to authenticated;
grant execute on function pg_temp.slack_expected(uuid) to c360_worker;

-- ---- Same answers, for every kind of caller and both visibility settings ---------------------
update private.settings set value = 'reviewers' where key = 'facts_visibility';

select pg_temp.act_as('00000000-0000-4000-8000-0000000015a1');
set local role authenticated;
select is(pg_temp.actual(), pg_temp.expected(), 'reviewers mode, admin: facts_customers matches the per-row rule');
select is((select count(*) from public.facts_search(p_query => 'samples', p_limit => 100) where summary like 'synthetic%'), pg_temp.search_expected(),
  'reviewers mode, admin: facts_search matches');
select is((select count(*) from public.facts_review_queue(500) where summary like 'synthetic%'), 8::bigint, 'admin review queue: every needs_review fact');
reset role;

select pg_temp.act_as('00000000-0000-4000-8000-0000000015b1');
set local role authenticated;
select is(pg_temp.actual(), pg_temp.expected(), 'reviewers mode, member: facts_customers matches (own facts only)');
select is((select count(*) from public.facts_search(p_query => 'samples', p_limit => 100) where summary like 'synthetic%'), pg_temp.search_expected(),
  'reviewers mode, member: facts_search matches');
select is((select count(*) from public.facts_review_queue(500) where summary like 'synthetic%'), 4::bigint, 'member review queue: own needs_review facts only');
select ok((select bool_and(is_mine) from public.facts_review_queue(500) where summary like 'synthetic%'), 'and they are all theirs');
reset role;

update private.settings set value = 'all' where key = 'facts_visibility';
select pg_temp.act_as('00000000-0000-4000-8000-0000000015c1');
set local role authenticated;
select is(pg_temp.actual(), pg_temp.expected(), 'all mode, member: facts_customers matches (checked facts of everyone + own unverified)');
select is((select count(*) from public.facts_search(p_query => 'samples', p_limit => 100) where summary like 'synthetic%'), pg_temp.search_expected(),
  'all mode, member: facts_search matches');
select ok(pg_temp.expected() <> '', 'the comparison is not vacuous');
reset role;

select pg_temp.act_as('00000000-0000-4000-8000-0000000015d1');
set local role authenticated;
select is(pg_temp.actual(), '', 'a departed person sees nothing');
select is((select count(*) from public.facts_review_queue(500)), 0::bigint, 'and has no review queue');
reset role;

-- ---- Slack: same answers as user_can_see_fact ----------------------------------------------------
set local role c360_worker;
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000015b1',
  array['00000000-0000-4000-8000-00000000c15a', '00000000-0000-4000-8000-00000000c15b']::uuid[], true, 120)),
  pg_temp.slack_expected('00000000-0000-4000-8000-0000000015b1'), 'Slack, member: matches user_can_see_fact');
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000015a1',
  array['00000000-0000-4000-8000-00000000c15a', '00000000-0000-4000-8000-00000000c15b']::uuid[], true, 120)),
  pg_temp.slack_expected('00000000-0000-4000-8000-0000000015a1'), 'Slack, admin: matches');
select is((select count(*) from private.worker_slack_facts('00000000-0000-4000-8000-0000000015d1',
  array['00000000-0000-4000-8000-00000000c15a']::uuid[], true, 120)), 0::bigint, 'Slack, departed: nothing');
reset role;

-- ---- RLS: unchanged access ---------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000015b1');
set local role authenticated;
select is((select count(*) from public.customers where canonical_name like 'T15%'), 0::bigint, 'members still cannot read the customer list');
reset role;

select * from finish();
rollback;
