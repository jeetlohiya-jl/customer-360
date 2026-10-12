-- Minimal stand-in for Supabase's built-in roles and auth schema, used ONLY by
-- scripts/db-test-local.sh to run the migrations and pgTAP tests on a plain,
-- throwaway PostgreSQL instance (no Docker). `supabase test db` does not use
-- this file: it runs against the real Supabase stack.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension pgtap with schema extensions;

grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Same resolution order as Supabase's auth.uid().
create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase grants these default privileges in public; mirror them so the
-- migrations' explicit revokes are exercised.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
