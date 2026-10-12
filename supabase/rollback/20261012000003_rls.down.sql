-- Reverses 20261012000003_rls.sql. Run only against a local or disposable database
-- unless explicitly approved. Leaves tables in place (they are dropped by the 0002 rollback).
drop policy if exists audit_log_select_admin on public.audit_log;
drop policy if exists app_users_select_admin on public.app_users;
drop policy if exists app_users_select_self on public.app_users;
alter table if exists public.meta      disable row level security;
alter table if exists public.audit_log disable row level security;
alter table if exists public.app_users disable row level security;
