-- Migration 0014: invite-only access to Customer 360 and the Slack assistant.
--
-- Before: any @gocirkla.com Google Workspace account could sign in, and the
-- Slack assistant answered anyone who had signed in once.
-- After ('access_mode' = 'invite'): only invited addresses get access.
--   * Admins invite and remove people on the Admin page (public.access_invite /
--     public.access_revoke). Every change is in the audit log.
--   * Someone not invited can still complete Google sign-in, but their account
--     is created 'suspended': no pages, no Slack answers, no scans. Inviting them
--     later makes it active.
--   * Removing an invite suspends the person at once (every page load and every
--     Slack question checks status = 'active'). Their Gmail connection, linked
--     emails and facts are KEPT (unlike 'departed'), and their mailbox is no
--     longer scanned or synced. Re-inviting restores access.
--   * Every active user at the time of this migration is invited, so nobody
--     already using the app is locked out.
-- 'access_mode' = 'workspace' returns to the old rule (any Workspace account).
--
-- Reverse: supabase/rollback/20261026000014_invite_only.down.sql

-- ---------------------------------------------------------------------------
-- Status 'suspended' and the invite list
-- ---------------------------------------------------------------------------
alter table public.app_users drop constraint if exists app_users_status_check;
alter table public.app_users add constraint app_users_status_check
  check (status in ('active', 'suspended', 'departed'));

create table private.access_invites (
  email      text primary key check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]{1,64}@[^@[:space:]]+$'),
  invited_by uuid references public.app_users (id) on delete set null,
  invited_at timestamptz not null default now(),
  note       text check (length(note) <= 200)
);
revoke all on private.access_invites from public, anon, authenticated;

insert into private.settings (key, value) values ('access_mode', 'invite')
on conflict (key) do nothing;

-- Everyone already active keeps access.
insert into private.access_invites (email, note)
select lower(email), 'active when invite-only access started' from public.app_users where status = 'active'
on conflict (email) do nothing;

create or replace function private.access_mode()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when v = 'workspace' then 'workspace' else 'invite' end
    from (select coalesce((select value from private.settings where key = 'access_mode'), 'invite') as v) s
$$;

create or replace function private.is_invited(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.access_mode() = 'workspace'
      or exists (select 1 from private.access_invites where email = lower(btrim(coalesce(p_email, ''))))
$$;

-- New Workspace accounts: active only if invited; otherwise suspended (no access).
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := case when private.is_invited(new.email) then 'active' else 'suspended' end;
begin
  insert into public.app_users (id, email, status)
  values (new.id, lower(new.email), v_status)
  on conflict (id) do nothing;

  insert into public.audit_log (actor, action, target, detail)
  values (new.id, 'user.created', new.id::text, jsonb_build_object('status', v_status));
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin functions
-- ---------------------------------------------------------------------------
create or replace function public.access_invites_list()
returns table (email text, invited_at timestamptz, invited_by_email text, note text, user_status text, signed_in boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
    select i.email, i.invited_at, b.email, i.note, u.status, u.id is not null
      from private.access_invites i
      left join public.app_users b on b.id = i.invited_by
      left join public.app_users u on lower(u.email) = i.email
    union all
    -- People who signed in without an invite (suspended), so an admin can let them in.
    select u.email, null::timestamptz, null::text, 'not invited'::text, u.status, true
      from public.app_users u
     where u.status = 'suspended' and not exists (select 1 from private.access_invites i where i.email = lower(u.email))
     order by 1;
end;
$$;

create or replace function public.access_invite(p_email text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  public.app_users;
  v_reactivated boolean := false;
begin
  perform private.require_admin();
  if v_email !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+$' or split_part(v_email, '@', 2) <> private.workspace_domain() then
    raise exception 'only % addresses can be invited', private.workspace_domain() using errcode = '22023';
  end if;
  insert into private.access_invites (email, invited_by, note)
  values (v_email, auth.uid(), nullif(left(btrim(coalesce(p_note, '')), 200), ''))
  on conflict (email) do nothing;

  select * into v_user from public.app_users where lower(email) = v_email for update;
  if found and v_user.status = 'suspended' then
    update public.app_users set status = 'active', updated_at = now() where id = v_user.id;
    update public.meta set value = value + 1 where key = 'acl_ver';
    v_reactivated := true;
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'access.invited', v_email, jsonb_build_object('reactivated', v_reactivated));
end;
$$;

create or replace function public.access_revoke(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  public.app_users;
  v_suspended boolean := false;
begin
  perform private.require_admin();
  if v_email = (select lower(email) from public.app_users where id = auth.uid()) then
    raise exception 'admins cannot remove their own access' using errcode = '42501';
  end if;
  delete from private.access_invites where email = v_email;

  select * into v_user from public.app_users where lower(email) = v_email for update;
  if found and v_user.status = 'active' then
    if v_user.role = 'admin' and not exists (
         select 1 from public.app_users where role = 'admin' and status = 'active' and id <> v_user.id) then
      raise exception 'at least one active admin must remain' using errcode = '42501';
    end if;
    update public.app_users set status = 'suspended', updated_at = now() where id = v_user.id;
    update public.meta set value = value + 1 where key = 'acl_ver';
    v_suspended := true;
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'access.revoked', v_email, jsonb_build_object('suspended', v_suspended));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function private.access_mode(), private.is_invited(text) from public, anon, authenticated;
revoke execute on function public.access_invites_list(), public.access_invite(text, text), public.access_revoke(text) from public, anon;
grant execute on function public.access_invites_list(), public.access_invite(text, text), public.access_revoke(text) to authenticated;
