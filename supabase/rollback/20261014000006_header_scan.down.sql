-- Reverses 20261014000006_header_scan.sql. DESTRUCTIVE: deletes scan jobs and
-- customer-linked message references. Run only with explicit approval.

-- Restore the Stage 3.0 review decision function (without message linking).
create or replace function public.review_resolve(p_item uuid, p_action text, p_customer uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item private.review_items;
begin
  perform private.require_admin();
  select * into v_item from private.review_items where id = p_item for update;
  if not found then
    raise exception 'review item not found' using errcode = 'P0002';
  end if;
  if p_action = 'same_customer' then
    if p_customer is null or not exists (select 1 from public.customers where id = p_customer) then
      raise exception 'choose an existing customer' using errcode = '22023';
    end if;
    perform private.add_alias(p_customer, v_item.observed, 'alias', 'review');
  elsif p_action = 'not_a_customer' then
    insert into public.name_rejections (normalized, decided_by)
    values (v_item.observed_normalized, auth.uid())
    on conflict do nothing;
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;
  delete from private.review_items where id = p_item;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'review.resolved', p_item::text, jsonb_build_object(
    'decision', p_action, 'customer', p_customer, 'name', v_item.observed_normalized));
end;
$$;

drop trigger if exists on_customer_inactive on public.customers;
drop trigger if exists on_gmail_connection_deleted on private.gmail_connections;
drop function if exists private.on_customer_inactive();
drop function if exists private.on_gmail_connection_deleted();

drop function if exists private.worker_retention_cleanup();
drop function if exists private.worker_release(uuid, text);
drop function if exists private.worker_auth_lost(uuid);
drop function if exists private.worker_commit_page(uuid, integer, text, jsonb, jsonb, jsonb, jsonb, boolean);
drop function if exists private.worker_customer_master();
drop function if exists private.worker_job_token(uuid);
drop function if exists private.worker_claim_job(integer);
drop function if exists public.scan_jobs_overview();
drop function if exists public.my_message_links(uuid, integer);
drop function if exists public.my_scan_jobs();
drop function if exists public.scan_resume();
drop function if exists public.scan_cancel();
drop function if exists public.scan_start();

drop table if exists private.review_occurrences;
drop table if exists private.message_links;
drop table if exists private.scan_failures;
drop table if exists private.scan_batches;
drop table if exists private.scan_jobs;

drop function if exists private.scan_allowed(text);
delete from private.settings where key = 'scan_allowed_mailboxes';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'c360_worker') then
    revoke usage on schema private from c360_worker;
    drop role c360_worker;
  end if;
end;
$$;
