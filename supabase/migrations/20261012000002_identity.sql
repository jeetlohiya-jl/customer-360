-- Phase 1 / migration 2: identity, roles, audit log, Workspace-only sign-up.
--
-- Reverse: see supabase/rollback/20261012000002_identity.down.sql

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.app_users (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique,
  slack_user_id text unique,
  role          text not null default 'member' check (role in ('member', 'admin')),
  status        text not null default 'active' check (status in ('active', 'departed')),
  -- Compact id used later for mailbox ACL arrays (reader_ids).
  reader_slot   integer generated always as identity unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.app_users is
  'One row per signed-in Cirkla employee. Created by trigger on auth.users; changed only through security-definer functions.';

create table public.audit_log (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  uuid,
  action text not null check (length(action) <= 64),
  target text check (length(target) <= 200),
  detail jsonb not null default '{}'::jsonb
);

comment on table public.audit_log is
  'Security-relevant events. Never stores message content, tokens or secrets.';

create index audit_log_at_brin on public.audit_log using brin (at);

create table public.meta (
  key   text primary key,
  value bigint not null default 0
);

comment on table public.meta is 'Version counters used for cache invalidation.';

insert into public.meta (key) values ('alias_ver'), ('acl_ver'), ('extractor_ver')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Helper functions (private schema, security definer, fixed search_path)
-- ---------------------------------------------------------------------------

create or replace function private.workspace_domain()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select value from private.settings where key = 'workspace_domain'
$$;

-- True only if the email is exactly <local>@<workspace domain> AND Google's
-- hosted-domain claim (hd) equals the workspace domain. Fails closed.
create or replace function private.is_workspace_identity(p_email text, p_user_meta jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_domain text := private.workspace_domain();
  v_hd     text := lower(btrim(coalesce(p_user_meta -> 'custom_claims' ->> 'hd', p_user_meta ->> 'hd', '')));
begin
  if v_domain is null or v_domain = '' then
    return false;
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    return false;
  end if;
  if split_part(v_email, '@', 2) <> v_domain then
    return false;
  end if;
  return v_hd = v_domain;
end;
$$;

create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users
    where id = auth.uid() and status = 'active'
  )
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users
    where id = auth.uid() and status = 'active' and role = 'admin'
  )
$$;

-- ---------------------------------------------------------------------------
-- Triggers on auth.users
-- ---------------------------------------------------------------------------

-- Blocks creation (or email/metadata change) of any non-Workspace identity.
create or replace function private.enforce_workspace_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_identity(new.email, new.raw_user_meta_data) then
    raise exception 'Sign-in is restricted to the % Google Workspace', private.workspace_domain()
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger enforce_workspace_identity
  before insert or update of email, raw_user_meta_data on auth.users
  for each row execute function private.enforce_workspace_identity();

-- Creates the matching app_users row (role member) and audits it.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.app_users (id, email)
  values (new.id, lower(new.email))
  on conflict (id) do nothing;

  insert into public.audit_log (actor, action, target)
  values (new.id, 'user.created', new.id::text);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Keeps app_users.email in sync if the identity's email changes.
create or replace function private.handle_auth_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.app_users
     set email = lower(new.email), updated_at = now()
   where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function private.handle_auth_email_change();

-- ---------------------------------------------------------------------------
-- Callable functions (RPC). Each re-checks the caller; none trusts the client.
-- ---------------------------------------------------------------------------

create or replace function public.record_sign_in()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'not an active user' using errcode = '42501';
  end if;
  insert into public.audit_log (actor, action) values (auth.uid(), 'auth.sign_in');
end;
$$;

create or replace function public.set_user_role(target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if new_role not in ('member', 'admin') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  -- An admin can never demote themselves, so at least one admin always remains.
  if target_user = auth.uid() then
    raise exception 'admins cannot change their own role' using errcode = '42501';
  end if;

  select role into v_old from public.app_users where id = target_user for update;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if v_old = new_role then
    return;
  end if;

  update public.app_users set role = new_role, updated_at = now() where id = target_user;
  update public.meta set value = value + 1 where key = 'acl_ver';
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'user.role_changed', target_user::text,
          jsonb_build_object('from', v_old, 'to', new_role));
end;
$$;

create or replace function public.set_user_status(target_user uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if new_status not in ('active', 'departed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if target_user = auth.uid() then
    raise exception 'admins cannot change their own status' using errcode = '42501';
  end if;

  select status into v_old from public.app_users where id = target_user for update;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if v_old = new_status then
    return;
  end if;

  update public.app_users set status = new_status, updated_at = now() where id = target_user;
  update public.meta set value = value + 1 where key = 'acl_ver';
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'user.status_changed', target_user::text,
          jsonb_build_object('from', v_old, 'to', new_status));
end;
$$;

create or replace function public.recent_audit(max_rows integer default 50)
returns table (id bigint, at timestamptz, action text, target text, actor_email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select a.id, a.at, a.action, a.target, u.email
      from public.audit_log a
      left join public.app_users u on u.id = a.actor
     order by a.at desc, a.id desc
     limit least(greatest(coalesce(max_rows, 50), 1), 200);
end;
$$;

-- One-time bootstrap: makes an existing, active user the first admin.
-- Refuses if any active admin already exists. Run by the database owner only
-- (Supabase SQL editor), after that person has signed in once:
--   select private.grant_initial_admin('name@gocirkla.com');
create or replace function private.grant_initial_admin(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.app_users where role = 'admin' and status = 'active') then
    raise exception 'an active admin already exists; use set_user_role instead' using errcode = '42501';
  end if;
  select id into v_id from public.app_users where email = lower(btrim(p_email)) and status = 'active';
  if v_id is null then
    raise exception 'no active user with that email has signed in yet' using errcode = 'P0002';
  end if;
  update public.app_users set role = 'admin', updated_at = now() where id = v_id;
  update public.meta set value = value + 1 where key = 'acl_ver';
  insert into public.audit_log (actor, action, target) values (null, 'user.bootstrap_admin', v_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: nothing is executable by default.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.record_sign_in() from public, anon;
revoke execute on function public.set_user_role(uuid, text) from public, anon;
revoke execute on function public.set_user_status(uuid, text) from public, anon;
revoke execute on function public.recent_audit(integer) from public, anon;

grant execute on function public.record_sign_in() to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.set_user_status(uuid, text) to authenticated;
grant execute on function public.recent_audit(integer) to authenticated;

-- RLS policies (next migration) call these two helpers, so the signed-in role
-- needs to reach them. They only answer questions about the caller.
grant usage on schema private to authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;
