-- Migration 0010: keep facts when an employee leaves (decision D4) and the
-- database side of the Slack DM assistant (behind FEATURE_SLACK, off).
--
-- D4 (2026-10-21, Kartik): when an employee DEPARTS, the customer facts from
-- their mailbox are kept. Their Gmail authorization is still deleted at once
-- (nothing more can be read), but the header-only message links that facts
-- hang off are kept. A still-employed person who DISCONNECTS Gmail is a
-- different case and is unchanged: their links and facts are deleted (CS9).
-- A customer marked inactive is also unchanged (links and facts deleted).
--
-- Slack: the bot answers questions in a direct message from stored facts only.
--   * Only active Cirkla employees, matched by their Slack account's email.
--   * Each person sees exactly the facts they could see on the Facts page
--     (same rules as private.can_see_fact, evaluated for that person).
--   * The source mailbox owner is returned only when the question asks for it
--     (decision D2) and the fact is visible anyway.
--   * Questions and answers are never stored. Only an hourly per-person count
--     (rate limit) and Slack event ids (to ignore Slack's retries, kept 1 day).
--   * The worker login reaches all of this through private.worker_slack_*
--     functions only; clients cannot call them.
--
-- Reverse: supabase/rollback/20261022000010_slack_and_retention.down.sql

-- ---------------------------------------------------------------------------
-- D4: keep facts on departure
-- ---------------------------------------------------------------------------
create or replace function private.on_gmail_connection_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_departed boolean := exists (select 1 from public.app_users where id = old.user_id and status = 'departed');
begin
  if v_departed then
    -- D4: keep the links (and so the facts); stop any work still waiting on this mailbox.
    update private.extraction_state set status = 'needs_reconnect', lease_until = null, updated_at = now()
     where owner_id = old.user_id and status in ('pending', 'claimed', 'failed');
  else
    delete from private.message_links where owner_id = old.user_id;
  end if;
  delete from private.review_occurrences where owner_id = old.user_id;
  update private.scan_jobs set status = 'cancelled', finished_at = now(), lease_until = null, updated_at = now()
   where owner_id = old.user_id and status in ('queued', 'running', 'cancelling', 'paused_auth');
  insert into public.audit_log (actor, action, target)
  values (null, case when v_departed then 'scan.data_kept_on_departure' else 'scan.data_deleted_on_disconnect' end,
          old.user_id::text);
  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- Slack: settings and small bookkeeping tables (no message content)
-- ---------------------------------------------------------------------------
insert into private.settings (key, value) values ('slack_questions_per_hour', '30')
on conflict (key) do nothing;

create table private.slack_events (
  event_id text primary key check (event_id ~ '^[A-Za-z0-9]{1,64}$'),
  seen_at  timestamptz not null default now()
);

create table private.slack_usage (
  user_id uuid not null references public.app_users (id) on delete cascade,
  hour    timestamptz not null,
  n       integer not null default 0 check (n >= 0),
  primary key (user_id, hour)
);

revoke all on private.slack_events, private.slack_usage from public, anon, authenticated;

-- The same rule as private.can_see_fact, for a named person instead of auth.uid().
create or replace function private.user_can_see_fact(p_user uuid, p_owner uuid, p_review text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with u as (select id, role from public.app_users where id = p_user and status = 'active')
  select exists (select 1 from u) and (
    (p_review in ('auto', 'confirmed', 'corrected')
      and (p_owner = p_user or exists (select 1 from u where role = 'admin')
           or coalesce((select value from private.settings where key = 'facts_visibility'), 'reviewers') = 'all'))
    or (p_review = 'needs_review' and (p_owner = p_user or exists (select 1 from u where role = 'admin'))))
$$;

-- Slack delivers an event again if it thinks we were slow. True = already handled.
create or replace function private.worker_slack_event_seen(p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_event_id is null or p_event_id !~ '^[A-Za-z0-9]{1,64}$' then
    raise exception 'bad event id' using errcode = '22023';
  end if;
  delete from private.slack_events where seen_at < now() - interval '1 day';
  insert into private.slack_events (event_id) values (p_event_id) on conflict (event_id) do nothing;
  get diagnostics n = row_count;
  return n = 0;
end;
$$;

-- Who is asking. First by the Slack id linked earlier; otherwise by the email
-- Slack reports for that account (must be an active employee in the
-- workspace domain), which then links the Slack id. Null: not allowed.
create or replace function private.worker_slack_user(p_slack_id text, p_email text default null)
returns table (user_id uuid, is_admin boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.app_users;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if p_slack_id is null or p_slack_id !~ '^[UW][A-Z0-9]{2,20}$' then
    raise exception 'bad slack user id' using errcode = '22023';
  end if;
  select * into v_user from public.app_users where slack_user_id = p_slack_id;
  if found then
    if v_user.status = 'active' then
      return query select v_user.id, v_user.role = 'admin';
    end if;
    return;  -- a departed person's Slack account gets nothing
  end if;
  if v_email = '' or split_part(v_email, '@', 2) <> private.workspace_domain() then
    return;
  end if;
  select * into v_user from public.app_users where lower(email) = v_email and status = 'active';
  if not found then
    return;
  end if;
  update public.app_users set slack_user_id = p_slack_id, updated_at = now() where id = v_user.id;
  insert into public.audit_log (actor, action, target) values (v_user.id, 'slack.linked', v_user.id::text);
  return query select v_user.id, v_user.role = 'admin';
end;
$$;

-- Hourly question limit per person. True = allowed (and counted).
create or replace function private.worker_slack_allow(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(nullif((select value from private.settings where key = 'slack_questions_per_hour'), '')::integer, 30);
  v_hour  timestamptz := date_trunc('hour', now());
  v_n     integer;
begin
  delete from private.slack_usage where hour < now() - interval '2 days';
  insert into private.slack_usage (user_id, hour, n) values (p_user, v_hour, 1)
  on conflict (user_id, hour) do update set n = private.slack_usage.n + 1
  returning n into v_n;
  return v_n <= v_limit;
end;
$$;

-- Customers named in the question. A full name or approved alias (whole
-- words, after the same normalisation used for matching email) wins. Only if
-- there is none, a distinctive first word of a customer's name also counts
-- ("Catelli" for "Catelli Brothers"); generic first words never do.
create or replace function private.worker_slack_customers(p_question text)
returns table (customer_id uuid, customer_name text, matched text, match_kind text)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (select ' ' || private.normalize_name(left(coalesce(p_question, ''), 500)) || ' ' as t),
  names as (
    select c.id, c.canonical_name, c.normalized_name as n from public.customers c where c.status = 'active'
    union
    select c.id, c.canonical_name, a.normalized from public.customer_aliases a
      join public.customers c on c.id = a.customer_id and c.status = 'active'
  ),
  full_match as (
    select distinct on (names.id) names.id, names.canonical_name, names.n
      from names, q
     where length(names.n) >= 3 and position(' ' || names.n || ' ' in q.t) > 0
     order by names.id, length(names.n) desc
  ),
  first_word as (
    select c.id, c.canonical_name, split_part(c.normalized_name, ' ', 1) as w
      from public.customers c
     where c.status = 'active' and position(' ' in c.normalized_name) > 0
  )
  select id, canonical_name, n, 'full' from full_match
  union all
  select fw.id, fw.canonical_name, fw.w, 'partial'
    from first_word fw, q
   where not exists (select 1 from full_match)
     and length(fw.w) >= 4
     and fw.w <> all (array['fresh', 'food', 'foods', 'meat', 'meats', 'farm', 'farms', 'global', 'american', 'united',
                            'national', 'international', 'premium', 'quality', 'best', 'great', 'prime', 'golden', 'royal',
                            'first', 'general', 'pacific', 'atlantic', 'north', 'south', 'east', 'west', 'northern',
                            'southern', 'eastern', 'western', 'central', 'city', 'county', 'state', 'super', 'market',
                            'markets', 'packaging', 'pack', 'group', 'brands', 'company', 'trading', 'natural', 'organic',
                            'family', 'home', 'pure', 'true', 'good', 'happy', 'little', 'big', 'green', 'blue', 'gold',
                            'silver', 'star', 'sun', 'sunny', 'valley', 'river', 'lake', 'mountain', 'hill', 'country',
                            'kitchen', 'kitchens', 'poultry', 'beef', 'pork', 'seafood', 'chicken', 'produce', 'dairy',
                            'bakery', 'deli', 'grocery', 'grocers', 'wholesale', 'retail', 'store', 'stores', 'what', 'with'])
     and position(' ' || fw.w || ' ' in q.t) > 0
$$;

-- Facts for the named customers that this person may see, newest first.
create or replace function private.worker_slack_facts(p_user uuid, p_customers uuid[], p_show_owner boolean, p_limit integer)
returns table (
  fact_id uuid, customer_id uuid, customer_name text, fact_type text, stance text, party text, basis text,
  status text, status_basis text, stale boolean, product text, quantity numeric, unit text, unit_price numeric,
  currency text, price_basis text, due_date date, due_text text, reference text, summary text, evidence_quote text,
  confidence numeric, review_state text, message_at timestamptz, direction text, is_mine boolean,
  source_owner_email text, mailbox_email text, gmail_message_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.customer_id, c.canonical_name, f.fact_type, f.stance, f.party, f.basis,
         f.status, f.status_basis,
         (f.status = 'open' and f.message_at < now() - interval '30 days'
          and not exists (select 1 from private.customer_facts g where g.resolves_fact_id = f.id)),
         f.product, f.quantity, f.unit, f.unit_price, f.currency, f.price_basis,
         f.due_date, f.due_text, f.reference, f.summary, f.evidence_quote, f.confidence,
         f.review_state, f.message_at, f.direction, f.owner_id = p_user,
         case when f.owner_id = p_user or coalesce(p_show_owner, false) then u.email end,
         case when f.owner_id = p_user then u.email end,
         case when f.owner_id = p_user then f.gmail_message_id end
    from private.customer_facts f
    join public.customers c on c.id = f.customer_id
    join public.app_users u on u.id = f.owner_id
   where f.customer_id = any (coalesce(p_customers, '{}'))
     and cardinality(p_customers) between 1 and 5
     and private.user_can_see_fact(p_user, f.owner_id, f.review_state)
   order by f.message_at desc, f.id desc
   limit least(greatest(coalesce(p_limit, 60), 1), 120)
$$;

revoke all on function private.user_can_see_fact(uuid, uuid, text),
                       private.worker_slack_event_seen(text), private.worker_slack_user(text, text),
                       private.worker_slack_allow(uuid), private.worker_slack_customers(text),
                       private.worker_slack_facts(uuid, uuid[], boolean, integer)
  from public, anon, authenticated;
grant execute on function private.worker_slack_event_seen(text), private.worker_slack_user(text, text),
                          private.worker_slack_allow(uuid), private.worker_slack_customers(text),
                          private.worker_slack_facts(uuid, uuid[], boolean, integer)
  to c360_worker;
