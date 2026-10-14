-- Reverse of 20261016000008_fact_extraction.sql. DESTRUCTIVE: deletes all
-- extracted facts, extraction state and AI usage records. Message links,
-- customers, scan jobs and Gmail connections are not touched.
drop trigger if exists on_gmail_scopes_changed on private.gmail_connections;
drop trigger if exists on_message_link_added on private.message_links;
drop trigger if exists on_message_link_removed on private.message_links;

drop function if exists public.extraction_set_cap(numeric);
drop function if exists public.extraction_overview();
drop function if exists public.fact_review(uuid, text, jsonb, text);
drop function if exists public.facts_review_queue(integer);
drop function if exists public.facts_search(text, uuid, text, text, date, date, timestamptz, uuid, integer, text, text);
drop function if exists public.facts_customers();
drop function if exists public.my_extraction_status();
drop function if exists public.extraction_failures();
drop function if exists public.extraction_retry_failed();
drop function if exists private.can_see_fact(uuid, text);
drop function if exists private.worker_extract_cleanup();
drop function if exists private.worker_extract_release(uuid, text);
drop function if exists private.worker_extract_fail(uuid, text, text);
drop function if exists private.worker_extract_skip(uuid, text, text);
drop function if exists private.worker_extract_commit(uuid, text, jsonb, jsonb);
drop function if exists private.fact_review_reasons(text, text, text, text, numeric, text[]);
drop function if exists private.worker_extract_context(uuid, text);
drop function if exists private.worker_extract_token(uuid);
drop function if exists private.worker_extract_claim(integer, integer);
drop function if exists private.worker_budget_settle(uuid, jsonb);
drop function if exists private.worker_budget_reserve(bigint);
drop function if exists private.budget_prepare();
drop function if exists private.budget_month();
drop function if exists private.on_gmail_scopes_changed();
drop function if exists private.on_message_link_removed();
drop function if exists private.on_message_link_added();

drop table if exists private.ai_usage;
drop table if exists private.ai_budget;
drop table if exists private.customer_facts;
drop table if exists private.extraction_state;

-- Restore connect_gmail from migration 0004 (gmail.metadata only) before readonly_scope() goes.
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
drop function if exists private.readonly_scope();
drop function if exists private.extract_allowed(text);
delete from private.settings where key in ('extract_allowed_mailboxes', 'extract_monthly_cap_usd', 'facts_show_source_owner', 'facts_visibility');
