-- Row Level Security and role management, exercised as each synthetic user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Synthetic test users (local test data only; distinct from seed users).
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000000a', 't3.admin@gocirkla.com',    '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-00000000000b', 't3.member1@gocirkla.com',  '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-00000000000c', 't3.member2@gocirkla.com',  '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-00000000000d', 't3.departed@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');

-- Make the test independent of seed data: within this transaction (rolled
-- back at the end), no admin exists yet, and we record the expected row count.
update public.app_users set role = 'member' where role = 'admin';
create temp table expected_users as select count(*)::int as n from public.app_users;
grant select on expected_users to authenticated;

-- Bootstrap the first admin (database owner only).
select lives_ok($$ select private.grant_initial_admin('t3.admin@gocirkla.com') $$, 'first admin can be bootstrapped');
select throws_ok($$ select private.grant_initial_admin('t3.member1@gocirkla.com') $$, '42501', null,
  'bootstrap refuses once an admin exists');

-- Helper: act as a given user for the rest of the transaction (or until reset).
create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;

-- Mark one user departed (as admin) before switching roles.
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select lives_ok($$ select public.set_user_status('00000000-0000-4000-8000-00000000000d', 'departed') $$,
  'admin can mark a user departed');

-- ---- member1 ------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.app_users), 1, 'member sees exactly one app_users row');
select is((select email from public.app_users), 't3.member1@gocirkla.com', 'that row is their own');
select is((select count(*)::int from public.audit_log), 0, 'member sees no audit entries');
select throws_ok($$ update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-00000000000b' $$,
  '42501', null, 'member cannot update app_users directly');
select throws_ok($$ select public.set_user_role('00000000-0000-4000-8000-00000000000b', 'admin') $$,
  '42501', null, 'member cannot grant roles');
select throws_ok($$ select * from public.recent_audit(10) $$, '42501', null, 'member cannot read the audit feed');
select lives_ok($$ select public.record_sign_in() $$, 'active member can record a sign-in');

-- ---- departed user ------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-00000000000d');
select is((select count(*)::int from public.app_users), 0, 'departed user sees no rows, not even their own');
select throws_ok($$ select public.record_sign_in() $$, '42501', null, 'departed user cannot record a sign-in');

-- ---- admin --------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.app_users), (select n from expected_users), 'admin sees all users');
select lives_ok($$ select public.set_user_role('00000000-0000-4000-8000-00000000000c', 'admin') $$,
  'admin can promote a member');
select throws_ok($$ select public.set_user_role('00000000-0000-4000-8000-00000000000a', 'member') $$,
  '42501', null, 'admin cannot change their own role (last-admin protection)');
select throws_ok($$ select public.set_user_role('00000000-0000-4000-8000-00000000000b', 'owner') $$,
  '22023', null, 'invalid role is rejected');
select ok(
  exists (select 1 from public.recent_audit(50) where action = 'user.role_changed'
           and target = '00000000-0000-4000-8000-00000000000c'),
  'role change is audited and visible to admins');

-- ---- anonymous ----------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$ select count(*) from public.app_users $$, '42501', null, 'anon cannot read app_users');
select throws_ok($$ select count(*) from public.audit_log $$, '42501', null, 'anon cannot read audit_log');

reset role;
select is(
  (select value from public.meta where key = 'acl_ver') >= 2,
  true,
  'permission changes bump acl_ver for cache invalidation');

select * from finish();
rollback;
