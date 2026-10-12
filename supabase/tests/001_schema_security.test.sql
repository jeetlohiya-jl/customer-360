-- Schema-level security checks. Run with `supabase test db` (or scripts/db-test-local.sh).
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Every table in the public schema has Row Level Security enabled.
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0,
  'every public table has RLS enabled'
);

-- The private schema is closed to anonymous callers and its tables to everyone.
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on schema private');
select ok(not has_table_privilege('authenticated', 'private.settings', 'select'), 'authenticated cannot read private.settings');
select ok(not has_table_privilege('anon', 'private.settings', 'select'), 'anon cannot read private.settings');

-- Clients can never write identity tables directly.
select ok(not has_table_privilege('authenticated', 'public.app_users', 'insert,update,delete'), 'authenticated cannot write app_users');
select ok(not has_table_privilege('authenticated', 'public.audit_log', 'insert,update,delete'), 'authenticated cannot write audit_log');
select ok(not has_table_privilege('anon', 'public.app_users', 'select'), 'anon cannot read app_users');

-- Function privileges.
select ok(not has_function_privilege('anon', 'public.set_user_role(uuid, text)', 'execute'), 'anon cannot call set_user_role');
select ok(not has_function_privilege('authenticated', 'private.grant_initial_admin(text)', 'execute'), 'authenticated cannot call grant_initial_admin');
select ok(not has_function_privilege('anon', 'public.record_sign_in()', 'execute'), 'anon cannot call record_sign_in');

select * from finish();
rollback;
