-- Phase 2 / migration 4: Gmail connection (proof of concept).
--
-- One row per user in the PRIVATE schema (not exposed via the Data API).
-- The refresh token is encrypted by the application (AES-256-GCM) before it
-- reaches the database; the database never sees the plaintext or the key.
-- Every function acts only on the caller (auth.uid()); none accepts a user id,
-- so one user cannot read or change another user's connection.
--
-- Reverse: see supabase/rollback/20261012000004_gmail_connections.down.sql

create table private.gmail_connections (
  user_id           uuid primary key references public.app_users (id) on delete cascade,
  mailbox_email     text not null,
  refresh_token_enc text not null check (refresh_token_enc ~ '^v[0-9]+\.'),
  key_version       smallint not null check (key_version >= 1),
  scopes            text[] not null,
  status            text not null default 'active' check (status in ('active', 'revoked')),
  connected_at      timestamptz not null default now(),
  last_used_at      timestamptz,
  updated_at        timestamptz not null default now()
);

revoke all on private.gmail_connections from public, anon, authenticated;

-- Connect (or reconnect) the caller's own mailbox. The mailbox address must
-- equal the caller's own Workspace email: employees connect only themselves.
create or replace function public.connect_gmail(
  p_mailbox_email text,
  p_refresh_token_enc text,
  p_key_version smallint,
  p_scopes text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if not private.is_active_user() then
    raise exception 'not an active user' using errcode = '42501';
  end if;
  select email into v_email from public.app_users where id = auth.uid();
  if lower(btrim(p_mailbox_email)) <> v_email then
    raise exception 'mailbox does not belong to the signed-in user' using errcode = '42501';
  end if;
  if p_scopes is null or not ('https://www.googleapis.com/auth/gmail.metadata' = any (p_scopes)) then
    raise exception 'gmail.metadata scope missing' using errcode = '22023';
  end if;

  insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes)
  values (auth.uid(), v_email, p_refresh_token_enc, p_key_version, p_scopes)
  on conflict (user_id) do update
     set mailbox_email = excluded.mailbox_email,
         refresh_token_enc = excluded.refresh_token_enc,
         key_version = excluded.key_version,
         scopes = excluded.scopes,
         status = 'active',
         connected_at = now(),
         updated_at = now();

  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'gmail.connected', auth.uid()::text, jsonb_build_object('scopes', p_scopes));
end;
$$;

-- Status for the UI. Never returns the token.
create or replace function public.my_gmail_connection()
returns table (mailbox_email text, status text, scopes text[], connected_at timestamptz, last_used_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.mailbox_email, c.status, c.scopes, c.connected_at, c.last_used_at
    from private.gmail_connections c
   where c.user_id = auth.uid() and private.is_active_user()
$$;

-- Encrypted token for the caller's own active connection (server use only;
-- useless without the application's key). Marks the connection as used.
create or replace function public.my_gmail_token()
returns table (refresh_token_enc text, key_version smallint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_active_user() then
    raise exception 'not an active user' using errcode = '42501';
  end if;
  update private.gmail_connections set last_used_at = now()
   where user_id = auth.uid() and status = 'active';
  return query
    select c.refresh_token_enc, c.key_version
      from private.gmail_connections c
     where c.user_id = auth.uid() and c.status = 'active';
end;
$$;

create or replace function public.mark_my_gmail_revoked()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.gmail_connections set status = 'revoked', updated_at = now()
   where user_id = auth.uid();
  if found then
    insert into public.audit_log (actor, action, target)
    values (auth.uid(), 'gmail.revoked_detected', auth.uid()::text);
  end if;
end;
$$;

-- Deletes the caller's connection (the app revokes at Google first).
create or replace function public.disconnect_gmail(p_revoked_at_google boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.gmail_connections where user_id = auth.uid();
  if found then
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'gmail.disconnected', auth.uid()::text,
            jsonb_build_object('revoked_at_google', coalesce(p_revoked_at_google, false)));
  end if;
end;
$$;

-- A departed user's stored Gmail authorization is deleted immediately.
create or replace function private.drop_gmail_on_departure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'departed' and old.status is distinct from 'departed' then
    delete from private.gmail_connections where user_id = new.id;
  end if;
  return new;
end;
$$;

create trigger drop_gmail_on_departure
  after update of status on public.app_users
  for each row execute function private.drop_gmail_on_departure();

-- Privileges: callable only by signed-in users; nothing for anon.
revoke execute on function private.drop_gmail_on_departure() from public, anon, authenticated;
revoke execute on function public.connect_gmail(text, text, smallint, text[]) from public, anon;
revoke execute on function public.my_gmail_connection() from public, anon;
revoke execute on function public.my_gmail_token() from public, anon;
revoke execute on function public.mark_my_gmail_revoked() from public, anon;
revoke execute on function public.disconnect_gmail(boolean) from public, anon;
grant execute on function public.connect_gmail(text, text, smallint, text[]) to authenticated;
grant execute on function public.my_gmail_connection() to authenticated;
grant execute on function public.my_gmail_token() to authenticated;
grant execute on function public.mark_my_gmail_revoked() to authenticated;
grant execute on function public.disconnect_gmail(boolean) to authenticated;
