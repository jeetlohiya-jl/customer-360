-- Migration 0017: find a customer's past email automatically.
--
-- Before: adding a customer (or a domain, address or alias) only affected NEW
-- email. Past email was found only when an admin clicked "Find past emails"
-- (0013 targeted re-scan), and that click did nothing for a mailbox that had
-- another scan running.
--
-- Now:
--   * Adding a customer, re-activating or renaming one, or adding an alias,
--     domain or address files a backfill request for every approved mailbox
--     that has had a full scan (the same mailboxes 0013 backfills use).
--   * A request becomes a targeted Gmail search (0013 scan job with a
--     search_query) as soon as that mailbox has no scan running, and the next
--     waiting request follows when a scan finishes. Nothing waits on a person.
--   * The search also tries <name>.com as a domain ("gloryfoods.com" for
--     "Glory Foods"), since a new customer often has no domain on file yet.
--     Matching still decides what links (m2: a domain that IS the name links).
--   * Setting 'auto_backfill' ('on' by default; 'off' stops new requests).
--   * Bulk changes (more than 20 customers, aliases or identifiers in one
--     statement, e.g. a CSV import) file no requests: a full re-scan is the
--     better tool then. This is logged.
--
-- Gmail search needs gmail.readonly, which every connected mailbox has. Header
-- data only, no AI cost for the search itself; new links go to extraction as usual.
--
-- Reverse: supabase/rollback/20261030000017_auto_backfill.down.sql

-- Admin switch: 'on' (default) or 'off'.
insert into private.settings (key, value) values ('auto_backfill', 'on')
on conflict (key) do nothing;

create table private.backfill_requests (
  customer_id  uuid not null references public.customers (id) on delete cascade,
  owner_id     uuid not null references public.app_users (id) on delete cascade,
  reason       text not null check (length(reason) <= 200),
  requested_at timestamptz not null default now(),
  primary key (customer_id, owner_id)
);

create index backfill_requests_owner on private.backfill_requests (owner_id, requested_at);

revoke all on private.backfill_requests from public, anon, authenticated;

-- 0013's search, plus <name>.com as a likely domain for names with no domain on file.
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
  for t in
    select x.t from (
      select 'from:' || i.value as t, 1 as o, i.value as v from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'to:' || i.value, 2, i.value from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'cc:' || i.value, 3, i.value from public.customer_identifiers i where i.customer_id = p_customer
      union all select 'subject:"' || n || '"', 4, n from (
        select c.normalized_name as n from public.customers c where c.id = p_customer
        union select a.normalized from public.customer_aliases a where a.customer_id = p_customer
      ) names where n ~ '^[a-z0-9 ]+$' and length(n) between 3 and 60
      -- 0017: the name as a domain, unless a domain is already on file.
      union all select d || ':' || replace(c.normalized_name, ' ', '') || '.com', 5, d
        from public.customers c, unnest(array['from', 'to']) d
       where c.id = p_customer
         and replace(c.normalized_name, ' ', '') ~ '^[a-z0-9]{6,40}$'
         and not exists (select 1 from public.customer_identifiers i where i.customer_id = p_customer and i.kind = 'domain')
    ) x
    where x.t ~ '^(from|to|cc):[A-Za-z0-9@._+-]+$' or x.t ~ '^subject:"[a-z0-9 ]+"$'
    order by x.o, x.v
  loop
    continue when length(v_q) + length(t) + 3 > 500;
    v_q := v_q || case when v_q = '' then '' else ' ' end || t;
  end loop;
  return case when v_q = '' then null else '{' || v_q || '}' end;
end;
$$;

-- Mailboxes a backfill may search: the same rule as 0013's customer_backfill.
create or replace function private.backfill_mailboxes()
returns table (owner_id uuid, mailbox_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.user_id, g.mailbox_email
    from private.gmail_connections g
    join public.app_users u on u.id = g.user_id and u.status = 'active'
   where g.status = 'active' and private.scan_allowed(g.mailbox_email)
     and exists (select 1 from private.scan_jobs j where j.owner_id = g.user_id and j.mailbox_email = g.mailbox_email
                  and j.status = 'completed' and j.search_query is null)
$$;

-- Turns this mailbox's oldest waiting request into a targeted scan, if it has
-- no scan running. Requests whose customer has nothing searchable are dropped.
create or replace function private.queue_backfills(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       private.backfill_requests;
  v_email text;
  v_query text;
  v_name  text;
begin
  if exists (select 1 from private.scan_jobs where owner_id = p_owner
              and status in ('queued', 'running', 'cancelling', 'paused_auth')) then
    return;
  end if;
  select mailbox_email into v_email from private.backfill_mailboxes() where owner_id = p_owner;
  if v_email is null then
    delete from private.backfill_requests where owner_id = p_owner;  -- no longer eligible
    return;
  end if;
  for r in select * from private.backfill_requests where owner_id = p_owner order by requested_at for update skip locked loop
    delete from private.backfill_requests where customer_id = r.customer_id and owner_id = r.owner_id;
    select canonical_name into v_name from public.customers where id = r.customer_id and status = 'active';
    v_query := case when v_name is null then null else private.customer_search_query(r.customer_id) end;
    continue when v_query is null;
    insert into private.scan_jobs (owner_id, mailbox_email, rules_version, search_query, purpose)
    values (p_owner, v_email, 'm2', v_query, left('auto backfill: ' || v_name || ' (' || r.reason || ')', 200));
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'customer.backfill_queued', r.customer_id::text,
            jsonb_build_object('mailbox', v_email, 'reason', r.reason, 'automatic', true));
    return;  -- one scan at a time per mailbox; the next follows when this one ends
  end loop;
end;
$$;

-- Files a request for every eligible mailbox and starts those that are free.
create or replace function private.request_backfill(p_customer uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  n integer := 0;
begin
  if not exists (select 1 from public.customers where id = p_customer and status = 'active') then
    return 0;
  end if;
  for m in select * from private.backfill_mailboxes() loop
    insert into private.backfill_requests (customer_id, owner_id, reason)
    values (p_customer, m.owner_id, left(coalesce(p_reason, 'backfill'), 200))
    on conflict (customer_id, owner_id) do update set requested_at = least(private.backfill_requests.requested_at, now());
    perform private.queue_backfills(m.owner_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers (statement level: a bulk change files nothing, see header)
-- ---------------------------------------------------------------------------
create or replace function private.on_customer_terms_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids    uuid[];
  v_reason text;
  c        uuid;
begin
  if coalesce((select value from private.settings where key = 'auto_backfill'), 'on') <> 'on' then
    return null;
  end if;
  if tg_table_name = 'customers' then
    if tg_op = 'INSERT' then
      select array_agg(distinct a.id) into v_ids from added a where a.status = 'active';
      v_reason := 'customer added';
    else
      select array_agg(distinct a.id) into v_ids
        from added a join removed b on b.id = a.id
       where a.status = 'active' and (b.status <> 'active' or b.canonical_name is distinct from a.canonical_name);
      v_reason := 'customer re-activated or renamed';
    end if;
  elsif tg_table_name = 'customer_aliases' then
    select array_agg(distinct a.customer_id) into v_ids from added a;
    v_reason := 'alias added';
  else
    select array_agg(distinct a.customer_id) into v_ids from added a;
    v_reason := 'domain or address added';
  end if;

  if v_ids is null then
    return null;
  end if;
  if cardinality(v_ids) > 20 then
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'customer.backfill_skipped_bulk', tg_table_name, jsonb_build_object('customers', cardinality(v_ids)));
    return null;
  end if;
  foreach c in array v_ids loop
    perform private.request_backfill(c, v_reason);
  end loop;
  return null;
end;
$$;

create trigger backfill_on_customer_added
  after insert on public.customers
  referencing new table as added
  for each statement execute function private.on_customer_terms_added();

create trigger backfill_on_customer_changed
  after update on public.customers
  referencing new table as added old table as removed
  for each statement execute function private.on_customer_terms_added();

create trigger backfill_on_alias_added
  after insert on public.customer_aliases
  referencing new table as added
  for each statement execute function private.on_customer_terms_added();

create trigger backfill_on_identifier_added
  after insert on public.customer_identifiers
  referencing new table as added
  for each statement execute function private.on_customer_terms_added();

-- When a scan ends, the mailbox's next waiting request starts.
create or replace function private.on_scan_job_finished()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('completed', 'cancelled', 'failed') and old.status is distinct from new.status then
    perform private.queue_backfills(new.owner_id);
  end if;
  return null;
end;
$$;

create trigger backfill_after_scan
  after update of status on private.scan_jobs
  for each row execute function private.on_scan_job_finished();

-- Admins: what is waiting (customer names and mailboxes only).
create or replace function public.backfill_waiting()
returns table (customer_name text, mailbox_email text, reason text, requested_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
  select c.canonical_name, g.mailbox_email, r.reason, r.requested_at
    from private.backfill_requests r
    join public.customers c on c.id = r.customer_id
    left join private.gmail_connections g on g.user_id = r.owner_id
   order by r.requested_at;
end;
$$;

revoke all on function private.backfill_mailboxes(), private.queue_backfills(uuid), private.request_backfill(uuid, text),
                       private.on_customer_terms_added(), private.on_scan_job_finished()
  from public, anon, authenticated;
revoke execute on function public.backfill_waiting() from public, anon;
grant execute on function public.backfill_waiting() to authenticated;
