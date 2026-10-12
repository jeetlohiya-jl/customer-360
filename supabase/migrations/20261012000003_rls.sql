-- Phase 1 / migration 3: Row Level Security and table privileges.
--
-- Rule: every table in `public` has RLS enabled. No table is writable by
-- clients; all changes go through the security-definer functions above.
--
-- Reverse: see supabase/rollback/20261012000003_rls.down.sql

alter table public.app_users enable row level security;
alter table public.audit_log enable row level security;
alter table public.meta      enable row level security;

-- Table privileges (defence in depth on top of RLS).
revoke all on public.app_users, public.audit_log, public.meta from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on public.app_users, public.audit_log, public.meta from authenticated;
grant select on public.app_users, public.audit_log to authenticated;
-- public.meta: no client access at all.
revoke select on public.meta from authenticated;

-- app_users: an active user sees their own row; an active admin sees all rows.
create policy app_users_select_self on public.app_users
  for select to authenticated
  using (id = auth.uid() and private.is_active_user());

create policy app_users_select_admin on public.app_users
  for select to authenticated
  using (private.is_admin());

-- audit_log: active admins only.
create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (private.is_admin());

-- meta: RLS on, no policies => no rows for any client role.
