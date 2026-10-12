-- Reverses 20261012000002_identity.sql. DESTRUCTIVE: drops app_users and audit_log.
-- Run only against a local or disposable database unless explicitly approved.
drop trigger if exists on_auth_user_email_changed on auth.users;
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists enforce_workspace_identity on auth.users;
drop function if exists private.grant_initial_admin(text);
drop function if exists public.recent_audit(integer);
drop function if exists public.set_user_status(uuid, text);
drop function if exists public.set_user_role(uuid, text);
drop function if exists public.record_sign_in();
drop function if exists private.handle_auth_email_change();
drop function if exists private.handle_new_auth_user();
drop function if exists private.enforce_workspace_identity();
drop function if exists private.is_admin();
drop function if exists private.is_active_user();
drop function if exists private.is_workspace_identity(text, jsonb);
drop function if exists private.workspace_domain();
drop table if exists public.meta;
drop table if exists public.audit_log;
drop table if exists public.app_users;
revoke usage on schema private from authenticated;
