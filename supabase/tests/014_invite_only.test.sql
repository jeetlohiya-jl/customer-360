-- Migration 0014: invite-only access. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
create function pg_temp.status(p_email text) returns text language sql security definer as $$
  select status from public.app_users where email = p_email
$$;
grant usage on schema extensions to c360_worker;  -- test-only, rolled back

-- An admin who signed in before invite-only access (as the migration found them).
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000014a1', 't14.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000014a1';
insert into private.access_invites (email) values ('t14.admin@gocirkla.com');

-- ---- Invite mode ------------------------------------------------------------------------------
update private.settings set value = 'invite' where key = 'access_mode';
select is(private.access_mode(), 'invite', 'invite-only access is on');
update private.settings set value = 'something else' where key = 'access_mode';
select is(private.access_mode(), 'invite', 'an unknown value means invite-only (fails closed)');
update private.settings set value = 'invite' where key = 'access_mode';
select ok(not has_table_privilege('authenticated', 'private.access_invites', 'select'), 'clients cannot read the invite list directly');
select ok(not has_function_privilege('anon', 'public.access_invite(text, text)', 'execute'), 'anonymous callers cannot invite');

-- Someone not invited completes Google sign-in: their account exists but has no access.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000014b1', 't14.walkin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
select is(pg_temp.status('t14.walkin@gocirkla.com'), 'suspended', 'an uninvited Workspace account is created suspended');
select pg_temp.act_as('00000000-0000-4000-8000-0000000014b1');
set local role authenticated;
select throws_ok($$ select public.record_sign_in() $$, '42501', null, 'an uninvited person cannot complete sign-in');
select is((select count(*) from public.app_users), 0::bigint, 'they can read nothing, not even their own row');
select throws_ok($$ select * from public.access_invites_list() $$, '42501', null, 'members cannot see the invite list');
reset role;
set local role c360_worker;
select is((select count(*) from private.worker_slack_user('U14WALKIN', 't14.walkin@gocirkla.com')), 0::bigint, 'the Slack assistant refuses them');
reset role;

-- An invited person signs in: active at once.
select pg_temp.act_as('00000000-0000-4000-8000-0000000014a1');
set local role authenticated;
select lives_ok($$ select public.access_invite('T14.New@gocirkla.com', 'sales pilot') $$, 'an admin invites someone');
select throws_ok($$ select public.access_invite('someone@gmail.com') $$, '22023', null, 'only Workspace addresses can be invited');
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000014c1', 't14.new@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
select is(pg_temp.status('t14.new@gocirkla.com'), 'active', 'an invited person is active on first sign-in');
set local role c360_worker;
select is((select count(*) from private.worker_slack_user('U14NEW', 't14.new@gocirkla.com')), 1::bigint, 'and the Slack assistant answers them');
reset role;

-- Letting in someone who already tried.
select pg_temp.act_as('00000000-0000-4000-8000-0000000014a1');
set local role authenticated;
select is((select user_status from public.access_invites_list() where email = 't14.walkin@gocirkla.com'), 'suspended',
  'admins see people who signed in without an invite');
select lives_ok($$ select public.access_invite('t14.walkin@gocirkla.com') $$, 'inviting them later');
reset role;
select is(pg_temp.status('t14.walkin@gocirkla.com'), 'active', 'makes their existing account active');

-- Removing access.
insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000014c1', 't14.new@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']);
update private.settings set value = 't14.new@gocirkla.com' where key = 'scan_allowed_mailboxes';
insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at) values
  ('00000000-0000-4000-8000-0000000014c1', 't14.new@gocirkla.com', 'completed', 'm2', now(), now());
select is((select count(*) from private.sync_eligible() where user_id = '00000000-0000-4000-8000-0000000014c1'), 1::bigint, 'before: their mailbox syncs');
select pg_temp.act_as('00000000-0000-4000-8000-0000000014a1');
set local role authenticated;
select lives_ok($$ select public.access_revoke('t14.new@gocirkla.com') $$, 'an admin removes access');
select throws_ok($$ select public.access_revoke('t14.admin@gocirkla.com') $$, '42501', null, 'admins cannot remove their own access');
reset role;
select is(pg_temp.status('t14.new@gocirkla.com'), 'suspended', 'removing access suspends them at once');
select is((select count(*) from private.gmail_connections where user_id = '00000000-0000-4000-8000-0000000014c1'), 1::bigint,
  'their Gmail connection (and so their links and facts) is kept');
select is((select count(*) from private.sync_eligible() where user_id = '00000000-0000-4000-8000-0000000014c1'), 0::bigint, 'their mailbox is no longer synced');
set local role c360_worker;
select is((select count(*) from private.worker_slack_user('U14NEW', null)), 0::bigint, 'the Slack assistant stops answering them');
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000014c1');
set local role authenticated;
select ok(not private.is_active_user(), 'every page check refuses them');
reset role;

select is((select count(*) from public.audit_log where action in ('access.invited', 'access.revoked')), 3::bigint, 'invites and removals are audited (2 invites, 1 removal)');

-- ---- Workspace mode (the old rule) ---------------------------------------------------------------
update private.settings set value = 'workspace' where key = 'access_mode';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000014d1', 't14.any@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
select is(pg_temp.status('t14.any@gocirkla.com'), 'active', 'in workspace mode any Workspace account is active');
select throws_ok($$ insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000014e1', 't14.x@gmail.com', '{"custom_claims":{"hd":"gmail.com"}}') $$,
  '42501', null, 'non-Workspace accounts are still refused in every mode');

select * from finish();
rollback;
