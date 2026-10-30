-- Reverse of 20261030000017_auto_backfill.sql: no automatic backfills; the
-- 0013 search (without the <name>.com guess). Scan jobs already queued stay.
drop trigger if exists backfill_after_scan on private.scan_jobs;
drop trigger if exists backfill_on_identifier_added on public.customer_identifiers;
drop trigger if exists backfill_on_alias_added on public.customer_aliases;
drop trigger if exists backfill_on_customer_changed on public.customers;
drop trigger if exists backfill_on_customer_added on public.customers;
drop function if exists public.backfill_waiting();
drop function if exists private.on_scan_job_finished();
drop function if exists private.on_customer_terms_added();
drop function if exists private.request_backfill(uuid, text);
drop function if exists private.queue_backfills(uuid);
drop function if exists private.backfill_mailboxes();
drop table if exists private.backfill_requests;
delete from private.settings where key = 'auto_backfill';

-- 0013's customer search, as it was.
create or replace function private.customer_search_query(p_customer uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t   text;
  v_q text := '';
begin
  -- Addresses and domains first (the strongest evidence), then names, while the search stays under 500 characters.
  for t in
    select x.t from (
      select 'from:' || i.value as t, 1 as o, i.value as v from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'to:' || i.value, 2, i.value from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'cc:' || i.value, 3, i.value from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'subject:"' || n || '"', 4, n from (
        select c.normalized_name as n from public.customers c where c.id = p_customer
        union select a.normalized from public.customer_aliases a where a.customer_id = p_customer
      ) names where n ~ '^[a-z0-9 ]+$' and length(n) between 3 and 60
    ) x
    -- Only terms the scan_jobs.search_query check accepts (an address such as a#b@x.com is left out, not fatal).
    where x.t ~ '^(from|to|cc):[A-Za-z0-9@._+-]+$' or x.t ~ '^subject:"[a-z0-9 ]+"$'
    order by x.o, x.v
  loop
    continue when length(v_q) + length(t) + 3 > 500;
    v_q := v_q || case when v_q = '' then '' else ' ' end || t;
  end loop;
  return case when v_q = '' then null else '{' || v_q || '}' end;
end;
$$;
