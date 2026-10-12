-- Only Cirkla Google Workspace identities can be created. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Rejected identities (database-level enforcement, independent of app code).
select throws_ok(
  $$ insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), 'someone@example.com', '{"custom_claims":{"hd":"example.com"}}') $$,
  '42501', null, 'non-Workspace email domain is rejected');

select throws_ok(
  $$ insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), 'synthetic.nohd@gocirkla.com', '{}') $$,
  '42501', null, 'Workspace email without the hosted-domain claim is rejected (consumer account)');

select throws_ok(
  $$ insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), 'synthetic.wronghd@gocirkla.com', '{"custom_claims":{"hd":"example.com"}}') $$,
  '42501', null, 'mismatched hosted-domain claim is rejected');

select throws_ok(
  $$ insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), 'synthetic@sub.gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}') $$,
  '42501', null, 'subdomain address is rejected');

select throws_ok(
  $$ insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), 'synthetic@gocirkla.com.evil.test', '{"custom_claims":{"hd":"gocirkla.com"}}') $$,
  '42501', null, 'look-alike suffix domain is rejected');

-- Accepted identity creates an app_users row with role member, and an audit entry.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-0000000000a1', 'Synthetic.Member@GoCirkla.com',
        '{"custom_claims":{"hd":"gocirkla.com"}}');

select is(
  (select email from public.app_users where id = '00000000-0000-4000-8000-0000000000a1'),
  'synthetic.member@gocirkla.com',
  'valid Workspace identity creates a lower-cased app_users row');

select is(
  (select role from public.app_users where id = '00000000-0000-4000-8000-0000000000a1'),
  'member',
  'new users start as member');

select ok(
  exists (select 1 from public.audit_log
           where action = 'user.created' and target = '00000000-0000-4000-8000-0000000000a1'),
  'user creation is audited');

-- Changing an existing identity to a non-Workspace email is also blocked.
select throws_ok(
  $$ update auth.users set email = 'moved@example.com'
      where id = '00000000-0000-4000-8000-0000000000a1' $$,
  '42501', null, 'email change to a non-Workspace address is rejected');

select * from finish();
rollback;
