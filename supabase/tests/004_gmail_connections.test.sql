-- Gmail connections: each user can only ever reach their own. Synthetic data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000e1', 't4.alice@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000000e2', 't4.bob@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;

-- Table is closed to clients.
select ok(not has_table_privilege('authenticated', 'private.gmail_connections', 'select'), 'authenticated cannot read gmail_connections');
select ok(not has_function_privilege('anon', 'public.my_gmail_token()', 'execute'), 'anon cannot fetch tokens');
select ok(not has_function_privilege('anon', 'public.connect_gmail(text, text, smallint, text[])', 'execute'), 'anon cannot connect');

set local role authenticated;

-- ---- Alice connects her own mailbox -------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1');
select lives_ok(
  $$ select public.connect_gmail('T4.Alice@gocirkla.com', 'v1.iv.ct.tag', 1::smallint,
       array['https://www.googleapis.com/auth/gmail.metadata']) $$,
  'user can connect their own mailbox');
select throws_ok(
  $$ select public.connect_gmail('t4.bob@gocirkla.com', 'v1.iv.ct.tag', 1::smallint,
       array['https://www.googleapis.com/auth/gmail.metadata']) $$,
  '42501', null, 'user cannot attach someone else''s mailbox');
select throws_ok(
  $$ select public.connect_gmail('t4.alice@gocirkla.com', 'v1.iv.ct.tag', 1::smallint,
       array['https://www.googleapis.com/auth/gmail.send']) $$,
  '22023', null, 'connection without an accepted Gmail scope is rejected');
select is((select mailbox_email from public.my_gmail_connection()), 't4.alice@gocirkla.com', 'Alice sees her connection');
select is((select count(*)::int from public.my_gmail_token()), 1, 'Alice can fetch her own encrypted token');
select throws_ok($$ select * from private.gmail_connections $$, '42501', null, 'direct table read is denied');

-- ---- Bob cannot see or touch Alice's connection --------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000000e2');
select is((select count(*)::int from public.my_gmail_connection()), 0, 'Bob sees no connection');
select is((select count(*)::int from public.my_gmail_token()), 0, 'Bob gets no token');
select lives_ok($$ select public.disconnect_gmail(true) $$, 'Bob''s disconnect runs (on his own, empty, connection)');

select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1');
select is((select count(*)::int from public.my_gmail_connection()), 1, 'Alice''s connection survived Bob''s calls');

-- ---- Revocation and disconnect -------------------------------------------
select lives_ok($$ select public.mark_my_gmail_revoked() $$, 'revocation can be recorded');
select is((select count(*)::int from public.my_gmail_token()), 0, 'no token is handed out for a revoked connection');
select lives_ok($$ select public.disconnect_gmail(true) $$, 'Alice can disconnect');

reset role;
select is(
  (select array_agg(action order by id)::text from public.audit_log
    where target = '00000000-0000-4000-8000-0000000000e1' and action like 'gmail.%'),
  '{gmail.connected,gmail.revoked_detected,gmail.disconnected}',
  'connect, revocation and disconnect are audited (no token values)');

select * from finish();
rollback;
