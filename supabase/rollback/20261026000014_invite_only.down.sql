-- Reverse of 20261026000014_invite_only.sql: back to "any Workspace account".
-- Suspended people become active again (they could sign in before 0014).
drop function if exists public.access_revoke(text);
drop function if exists public.access_invite(text, text);
drop function if exists public.access_invites_list();
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

drop function if exists private.is_invited(text);
drop function if exists private.access_mode();
update public.app_users set status = 'active', updated_at = now() where status = 'suspended';
alter table public.app_users drop constraint if exists app_users_status_check;
alter table public.app_users add constraint app_users_status_check check (status in ('active', 'departed'));
delete from private.settings where key = 'access_mode';
drop table if exists private.access_invites;
