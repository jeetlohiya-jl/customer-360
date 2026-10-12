-- Phase 1 / migration 1: private schema and settings.
--
-- The `private` schema holds settings and helper functions. It is NOT listed
-- in the Data API's exposed schemas (supabase/config.toml), so PostgREST never
-- serves it. Its tables are readable only by the database owner.
--
-- Reverse: see supabase/rollback/20261012000001_private_schema.down.sql

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- Functions in `private` must not be executable by everyone by default.
alter default privileges in schema private revoke execute on functions from public;

create table private.settings (
  key   text primary key,
  value text not null
);

revoke all on private.settings from public, anon, authenticated;

-- Workspace domain allowed to sign in. Change only via a reviewed migration.
insert into private.settings (key, value)
values ('workspace_domain', 'gocirkla.com')
on conflict (key) do nothing;
