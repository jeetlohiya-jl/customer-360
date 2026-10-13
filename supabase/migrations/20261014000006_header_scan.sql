-- Stage 3.1: header scan of one authorized mailbox (gmail.metadata only).
--
-- Approved: CS3 no subjects stored · CS4 customer-side addresses on verified
-- customer domains only · CS5 internal-only mail excluded · CS8 dedicated
-- worker role · CS9 retention (links live while the mailbox is connected and
-- the customer active; review 30 days; failures 14 days; batch counts 90 days).
--
-- Safety: scanning stays OFF until (1) the app has FEATURE_SCAN=on, (2) the
-- mailbox is listed in private.settings 'scan_allowed_mailboxes' (empty here),
-- (3) the worker login has a password (none here), and (4) the mailbox owner
-- starts the scan. This migration sets none of those.
--
-- Reverse: supabase/rollback/20261014000006_header_scan.down.sql

-- ---------------------------------------------------------------------------
-- Settings: the scan allowlist starts EMPTY (no mailbox can be scanned).
-- ---------------------------------------------------------------------------
insert into private.settings (key, value) values ('scan_allowed_mailboxes', '')
on conflict (key) do nothing;

create or replace function private.scan_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(p_email)) = any (
    string_to_array(replace(lower(coalesce(
      (select value from private.settings where key = 'scan_allowed_mailboxes'), '')), ' ', ''), ','))
    and btrim(coalesce(p_email, '')) <> ''
$$;

-- ---------------------------------------------------------------------------
-- Tables (private schema: not reachable through the Data API)
-- ---------------------------------------------------------------------------

create table private.scan_jobs (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.app_users (id) on delete cascade,
  mailbox_email      text not null,
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'cancelling', 'cancelled', 'paused_auth', 'completed', 'failed')),
  rules_version      text not null,
  cutoff_at          timestamptz not null default now(),
  page_token         text,
  pages_done         integer not null default 0,
  enumerated         integer not null default 0,
  excluded_rule      integer not null default 0,
  excluded_privacy   integer not null default 0,
  excluded_internal  integer not null default 0,
  matched            integer not null default 0,
  in_review          integer not null default 0,
  unmatched          integer not null default 0,
  weak_evidence_only integer not null default 0, -- subset of unmatched (look-alike or shared domain only)
  failed             integer not null default 0,
  newer_than_cutoff  integer not null default 0,
  error_count        integer not null default 0,
  last_error         text check (length(last_error) <= 64),
  lease_until        timestamptz,
  started_by         uuid references public.app_users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz,
  constraint scan_jobs_reconciles check (
    enumerated = excluded_rule + excluded_privacy + excluded_internal + matched + in_review + unmatched + failed + newer_than_cutoff)
);

create unique index scan_jobs_one_active_per_owner on private.scan_jobs (owner_id)
  where status in ('queued', 'running', 'cancelling', 'paused_auth');

create table private.scan_batches (
  job_id       uuid not null references private.scan_jobs (id) on delete cascade,
  page_no      integer not null check (page_no >= 1),
  counts       jsonb not null,
  committed_at timestamptz not null default now(),
  primary key (job_id, page_no)
);

create table private.scan_failures (
  job_id           uuid not null references private.scan_jobs (id) on delete cascade,
  gmail_message_id text not null check (gmail_message_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  error_code       text not null check (length(error_code) <= 64),
  attempts         integer not null default 1,
  created_at       timestamptz not null default now(),
  primary key (job_id, gmail_message_id)
);

create table private.message_links (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.app_users (id) on delete cascade,
  customer_id        uuid not null references public.customers (id) on delete cascade,
  gmail_message_id   text not null check (gmail_message_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  gmail_thread_id    text check (gmail_thread_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  message_at         timestamptz not null,
  direction          text not null check (direction in ('inbound', 'outbound')),
  customer_addresses text[] not null default '{}' check (cardinality(customer_addresses) <= 20),
  evidence           jsonb not null check (jsonb_typeof(evidence) = 'array'),
  score              numeric(4, 3) not null check (score between 0 and 1),
  rules_version      text not null,
  link_status        text not null check (link_status in ('auto', 'confirmed')),
  job_id             uuid references private.scan_jobs (id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint message_links_unique unique (owner_id, gmail_message_id, customer_id)
);

create index message_links_customer_time on private.message_links (customer_id, message_at desc);
create index message_links_owner_time on private.message_links (owner_id, message_at desc);

comment on table private.message_links is
  'One row per (mailbox, message, customer). No subject, body or snippet (CS3). Addresses only on verified customer domains (CS4).';

-- Which messages are waiting on a review decision. Message references only.
create table private.review_occurrences (
  review_item_id   uuid not null references private.review_items (id) on delete cascade,
  owner_id         uuid not null references public.app_users (id) on delete cascade,
  gmail_message_id text not null check (gmail_message_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  gmail_thread_id  text check (gmail_thread_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  message_at       timestamptz not null,
  direction        text not null check (direction in ('inbound', 'outbound')),
  job_id           uuid references private.scan_jobs (id) on delete set null,
  primary key (review_item_id, owner_id, gmail_message_id)
);

revoke all on private.scan_jobs, private.scan_batches, private.scan_failures,
              private.message_links, private.review_occurrences
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The worker login (CS8). NOLOGIN here; an operator enables it later with a
-- password set directly in the SQL editor (never in code or chat):
--   alter role c360_worker with login password '<generated>';
-- It owns nothing and may only run the worker_* functions below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'c360_worker') then
    create role c360_worker nologin noinherit;
  end if;
end;
$$;

grant usage on schema private to c360_worker;

-- ---------------------------------------------------------------------------
-- Owner-facing functions (signed-in employee, own mailbox only)
-- ---------------------------------------------------------------------------

create or replace function public.scan_start()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_id    uuid;
begin
  if not private.is_active_user() then
    raise exception 'not an active user' using errcode = '42501';
  end if;
  select mailbox_email into v_email from private.gmail_connections
   where user_id = auth.uid() and status = 'active';
  if v_email is null then
    raise exception 'connect Gmail first' using errcode = '22023';
  end if;
  if not private.scan_allowed(v_email) then
    raise exception 'this mailbox is not approved for scanning' using errcode = '42501';
  end if;
  if exists (select 1 from private.scan_jobs where owner_id = auth.uid()
              and status in ('queued', 'running', 'cancelling', 'paused_auth')) then
    raise exception 'a scan is already in progress' using errcode = '23505';
  end if;
  insert into private.scan_jobs (owner_id, mailbox_email, rules_version, started_by)
  values (auth.uid(), v_email, 'm1', auth.uid())
  returning id into v_id;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'scan.started', v_id::text, jsonb_build_object('mailbox', v_email, 'scope', 'gmail.metadata'));
  return v_id;
end;
$$;

create or replace function public.scan_cancel()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.scan_jobs;
begin
  select * into v_job from private.scan_jobs
   where owner_id = auth.uid() and status in ('queued', 'running', 'paused_auth')
   for update;
  if not found then
    raise exception 'no scan to cancel' using errcode = 'P0002';
  end if;
  update private.scan_jobs
     set status = case when v_job.status = 'running' then 'cancelling' else 'cancelled' end,
         finished_at = case when v_job.status = 'running' then null else now() end,
         updated_at = now()
   where id = v_job.id;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'scan.cancel_requested', v_job.id::text);
end;
$$;

-- After reconnecting Gmail, continue a scan that lost authorization.
create or replace function public.scan_resume()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from private.gmail_connections where user_id = auth.uid() and status = 'active') then
    raise exception 'connect Gmail first' using errcode = '22023';
  end if;
  update private.scan_jobs set status = 'queued', lease_until = null, error_count = 0, updated_at = now()
   where owner_id = auth.uid() and status = 'paused_auth'
  returning id into v_id;
  if v_id is null then
    raise exception 'no paused scan' using errcode = 'P0002';
  end if;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'scan.resumed', v_id::text);
end;
$$;

create or replace function public.my_scan_jobs()
returns table (id uuid, status text, created_at timestamptz, finished_at timestamptz, pages_done integer,
               enumerated integer, excluded_rule integer, excluded_privacy integer, excluded_internal integer,
               matched integer, in_review integer, unmatched integer, weak_evidence_only integer,
               failed integer, newer_than_cutoff integer, last_error text)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.status, j.created_at, j.finished_at, j.pages_done, j.enumerated, j.excluded_rule,
         j.excluded_privacy, j.excluded_internal, j.matched, j.in_review, j.unmatched,
         j.weak_evidence_only, j.failed, j.newer_than_cutoff, j.last_error
    from private.scan_jobs j
   where j.owner_id = auth.uid() and private.is_active_user()
   order by (j.status in ('queued', 'running', 'cancelling', 'paused_auth')) desc, j.created_at desc
   limit 10
$$;

-- The caller's own customer-linked messages. Never another person's.
create or replace function public.my_message_links(p_customer uuid default null, p_limit integer default 200)
returns table (customer_id uuid, customer_name text, gmail_message_id text, gmail_thread_id text,
               message_at timestamptz, direction text, customer_addresses text[], evidence jsonb, link_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.customer_id, c.canonical_name, l.gmail_message_id, l.gmail_thread_id, l.message_at, l.direction,
         l.customer_addresses, l.evidence, l.link_status
    from private.message_links l
    join public.customers c on c.id = l.customer_id
   where l.owner_id = auth.uid() and private.is_active_user()
     and (p_customer is null or l.customer_id = p_customer)
   order by l.message_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

-- Admin oversight: counts per scan, never message references.
create or replace function public.scan_jobs_overview()
returns table (mailbox_email text, status text, created_at timestamptz, finished_at timestamptz,
               enumerated integer, matched integer, in_review integer, unmatched integer, failed integer,
               excluded integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
    select j.mailbox_email, j.status, j.created_at, j.finished_at, j.enumerated, j.matched, j.in_review,
           j.unmatched, j.failed, j.excluded_rule + j.excluded_privacy + j.excluded_internal
      from private.scan_jobs j
     order by j.created_at desc
     limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (c360_worker only)
-- ---------------------------------------------------------------------------

-- Leases one job. A cancelling job that is not mid-page is closed here.
create or replace function private.worker_claim_job(p_lease_seconds integer default 180)
returns table (job_id uuid, owner_id uuid, mailbox_email text, cutoff_at timestamptz, page_token text,
               pages_done integer, rules_version text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.scan_jobs;
begin
  -- Close cancellations whose lease has expired.
  for v_job in
    select * from private.scan_jobs j
     where j.status = 'cancelling' and (j.lease_until is null or j.lease_until < now())
     for update skip locked
  loop
    update private.scan_jobs set status = 'cancelled', finished_at = now(), lease_until = null, updated_at = now()
     where id = v_job.id;
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'scan.cancelled', v_job.id::text, jsonb_build_object('pages_done', v_job.pages_done));
  end loop;

  select * into v_job from private.scan_jobs j
   where j.status in ('queued', 'running')
     and (j.lease_until is null or j.lease_until < now())
     and private.scan_allowed(j.mailbox_email)
   order by j.created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  update private.scan_jobs
     set status = 'running',
         lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 180), 30), 900)),
         updated_at = now()
   where id = v_job.id;
  return query select v_job.id, v_job.owner_id, v_job.mailbox_email, v_job.cutoff_at, v_job.page_token,
                      v_job.pages_done, v_job.rules_version;
end;
$$;

-- The encrypted token for a job the worker holds. Useless without the app key.
create or replace function private.worker_job_token(p_job uuid)
returns table (refresh_token_enc text, key_version smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.refresh_token_enc, c.key_version
    from private.scan_jobs j
    join private.gmail_connections c on c.user_id = j.owner_id and c.status = 'active'
    join public.app_users u on u.id = j.owner_id and u.status = 'active'
   where j.id = p_job and j.status = 'running' and j.lease_until > now()
     and c.mailbox_email = j.mailbox_email and private.scan_allowed(j.mailbox_email)
$$;

-- Read-only snapshot of the active customer master for matching.
create or replace function private.worker_customer_master()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspace_domain', private.workspace_domain(),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'canonical_name', c.canonical_name, 'status', c.status,
        'names', coalesce((select jsonb_agg(jsonb_build_object('value', a.alias, 'kind', a.kind))
                             from public.customer_aliases a where a.customer_id = c.id), '[]'::jsonb),
        'domains', coalesce((select jsonb_agg(jsonb_build_object('value', i.value, 'shared', i.shared))
                               from public.customer_identifiers i where i.customer_id = c.id and i.kind = 'domain'), '[]'::jsonb),
        'emails', coalesce((select jsonb_agg(i.value)
                              from public.customer_identifiers i where i.customer_id = c.id and i.kind = 'email'), '[]'::jsonb)))
        from public.customers c where c.status = 'active'), '[]'::jsonb),
    'distinctions', coalesce((select jsonb_agg(jsonb_build_array(d.customer_a, d.customer_b)) from public.customer_distinctions d), '[]'::jsonb),
    'rejections', coalesce((select jsonb_agg(r.normalized) from public.name_rejections r), '[]'::jsonb))
$$;

-- Commits one page atomically: outcomes, counters and the resume point.
-- Re-sending an already committed page is a no-op (returns 'duplicate').
create or replace function private.worker_commit_page(
  p_job uuid, p_page_no integer, p_next_page_token text, p_counts jsonb,
  p_links jsonb, p_reviews jsonb, p_failures jsonb, p_done boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      private.scan_jobs;
  k          text;
  v_total    integer := 0;
  item       jsonb;
  occ        jsonb;
  v_review   uuid;
  v_norm     text;
  v_status   text;
  v_cand     jsonb;
begin
  select * into v_job from private.scan_jobs where id = p_job for update;
  if not found then
    raise exception 'job not found' using errcode = 'P0002';
  end if;
  if p_page_no <= v_job.pages_done then
    return 'duplicate';
  end if;
  if v_job.status not in ('running', 'cancelling') or v_job.lease_until is null or v_job.lease_until < now() then
    raise exception 'job is not leased by this worker' using errcode = '55000';
  end if;
  if p_page_no <> v_job.pages_done + 1 then
    raise exception 'pages must be committed in order' using errcode = '22023';
  end if;

  foreach k in array array['enumerated','excluded_rule','excluded_privacy','excluded_internal','matched',
                           'in_review','unmatched','weak_evidence_only','failed','newer_than_cutoff'] loop
    if coalesce((p_counts ->> k)::integer, -1) < 0 then
      raise exception 'count % missing or negative', k using errcode = '22023';
    end if;
  end loop;
  v_total := (p_counts ->> 'excluded_rule')::int + (p_counts ->> 'excluded_privacy')::int
           + (p_counts ->> 'excluded_internal')::int + (p_counts ->> 'matched')::int
           + (p_counts ->> 'in_review')::int + (p_counts ->> 'unmatched')::int
           + (p_counts ->> 'failed')::int + (p_counts ->> 'newer_than_cutoff')::int;
  if v_total <> (p_counts ->> 'enumerated')::int or (p_counts ->> 'enumerated')::int > 500 then
    raise exception 'page counts do not reconcile' using errcode = '22023';
  end if;
  if (p_counts ->> 'weak_evidence_only')::int > (p_counts ->> 'unmatched')::int then
    raise exception 'weak_evidence_only must be part of unmatched' using errcode = '22023';
  end if;

  -- Links (only active customers; unique per mailbox, message and customer).
  for item in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at,
                                       direction, customer_addresses, evidence, score, rules_version, link_status, job_id)
    select v_job.owner_id, c.id, item ->> 'gmail_message_id', item ->> 'gmail_thread_id',
           (item ->> 'message_at')::timestamptz, item ->> 'direction',
           coalesce(array(select jsonb_array_elements_text(item -> 'customer_addresses')), '{}'),
           coalesce(item -> 'evidence', '[]'::jsonb), (item ->> 'score')::numeric, v_job.rules_version, 'auto', v_job.id
      from public.customers c
     where c.id = (item ->> 'customer_id')::uuid and c.status = 'active'
    on conflict on constraint message_links_unique do nothing;
  end loop;

  -- Uncertain names: one review item per normalized name, plus message references.
  for item in select * from jsonb_array_elements(coalesce(p_reviews, '[]'::jsonb)) loop
    v_norm := private.normalize_name(item ->> 'observed');
    continue when v_norm is null or v_norm = '' or length(v_norm) > 120;
    continue when exists (select 1 from public.name_rejections where normalized = v_norm);
    continue when exists (select 1 from public.customer_aliases where normalized = v_norm)
               or exists (select 1 from public.customers where normalized_name = v_norm);
    select coalesce(jsonb_agg(jsonb_build_object(
             'customer_id', c.id,
             'score', least(greatest(coalesce((e ->> 'score')::numeric, 0), 0), 1),
             'evidence', left(coalesce(e ->> 'evidence', ''), 16))), '[]'::jsonb)
      into v_cand
      from jsonb_array_elements(coalesce(item -> 'candidates', '[]'::jsonb)) e
      join public.customers c on c.id = (e ->> 'customer_id')::uuid;
    insert into private.review_items as ri (observed, observed_normalized, candidates, reason, source, occurrences)
    values (left(btrim(item ->> 'observed'), 200), v_norm, v_cand, left(coalesce(item ->> 'reason', ''), 120), 'gmail_scan', 1)
    on conflict (observed_normalized) do update
       set occurrences = ri.occurrences + 1, last_seen = now(), expires_at = now() + interval '30 days'
    returning id into v_review;
    for occ in select * from jsonb_array_elements(coalesce(item -> 'messages', '[]'::jsonb)) loop
      insert into private.review_occurrences (review_item_id, owner_id, gmail_message_id, gmail_thread_id,
                                              message_at, direction, job_id)
      values (v_review, v_job.owner_id, occ ->> 'gmail_message_id', occ ->> 'gmail_thread_id',
              (occ ->> 'message_at')::timestamptz, occ ->> 'direction', v_job.id)
      on conflict do nothing;
    end loop;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_failures, '[]'::jsonb)) loop
    insert into private.scan_failures (job_id, gmail_message_id, error_code)
    values (v_job.id, item ->> 'gmail_message_id', left(coalesce(item ->> 'error_code', 'unknown'), 64))
    on conflict (job_id, gmail_message_id) do update set attempts = private.scan_failures.attempts + 1;
  end loop;

  insert into private.scan_batches (job_id, page_no, counts) values (v_job.id, p_page_no, p_counts);

  v_status := case
    when v_job.status = 'cancelling' then 'cancelled'
    when p_done then 'completed'
    else 'running' end;

  update private.scan_jobs set
    enumerated         = enumerated + (p_counts ->> 'enumerated')::int,
    excluded_rule      = excluded_rule + (p_counts ->> 'excluded_rule')::int,
    excluded_privacy   = excluded_privacy + (p_counts ->> 'excluded_privacy')::int,
    excluded_internal  = excluded_internal + (p_counts ->> 'excluded_internal')::int,
    matched            = matched + (p_counts ->> 'matched')::int,
    in_review          = in_review + (p_counts ->> 'in_review')::int,
    unmatched          = unmatched + (p_counts ->> 'unmatched')::int,
    weak_evidence_only = weak_evidence_only + (p_counts ->> 'weak_evidence_only')::int,
    failed             = failed + (p_counts ->> 'failed')::int,
    newer_than_cutoff  = newer_than_cutoff + (p_counts ->> 'newer_than_cutoff')::int,
    page_token         = p_next_page_token,
    pages_done         = p_page_no,
    error_count        = 0,
    last_error         = null,
    status             = v_status,
    lease_until        = null, -- released after every page; the next tick re-claims
    finished_at        = case when v_status = 'running' then null else now() end,
    updated_at         = now()
  where id = v_job.id;

  if v_status <> 'running' then
    insert into public.audit_log (actor, action, target, detail)
    select null, 'scan.' || v_status, j.id::text, jsonb_build_object(
      'pages', j.pages_done, 'enumerated', j.enumerated, 'matched', j.matched, 'in_review', j.in_review,
      'unmatched', j.unmatched, 'failed', j.failed,
      'excluded', j.excluded_rule + j.excluded_privacy + j.excluded_internal)
      from private.scan_jobs j where j.id = v_job.id;
  end if;
  return v_status;
end;
$$;

-- Google refused the token: pause until the owner reconnects and resumes.
create or replace function private.worker_auth_lost(p_job uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.scan_jobs set status = 'paused_auth', lease_until = null, last_error = 'authorization_lost', updated_at = now()
   where id = p_job and status in ('running', 'cancelling');
  if found then
    insert into public.audit_log (actor, action, target) values (null, 'scan.paused_auth', p_job::text);
  end if;
end;
$$;

-- A page could not be finished: release it for retry; give up after 10 errors in a row.
create or replace function private.worker_release(p_job uuid, p_error_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update private.scan_jobs
     set error_count = error_count + 1, last_error = left(coalesce(p_error_code, 'unknown'), 64),
         lease_until = null, updated_at = now()
   where id = p_job and status in ('running', 'cancelling')
  returning error_count into v_count;
  if v_count >= 10 then
    update private.scan_jobs set status = 'failed', finished_at = now() where id = p_job;
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'scan.failed', p_job::text, jsonb_build_object('error', left(coalesce(p_error_code, 'unknown'), 64)));
    return 'failed';
  end if;
  return 'released';
end;
$$;

-- CS9 retention; run by the worker on each tick. Returns rows deleted.
create or replace function private.worker_retention_cleanup()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  m integer;
begin
  delete from private.review_items where expires_at < now();
  get diagnostics m = row_count; n := n + m;
  delete from private.scan_failures where created_at < now() - interval '14 days';
  get diagnostics m = row_count; n := n + m;
  delete from private.scan_batches where committed_at < now() - interval '90 days';
  get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- CS9: links disappear with the mailbox connection or the customer's activity
-- ---------------------------------------------------------------------------

create or replace function private.on_gmail_connection_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.message_links where owner_id = old.user_id;
  delete from private.review_occurrences where owner_id = old.user_id;
  update private.scan_jobs set status = 'cancelled', finished_at = now(), lease_until = null, updated_at = now()
   where owner_id = old.user_id and status in ('queued', 'running', 'cancelling', 'paused_auth');
  insert into public.audit_log (actor, action, target) values (null, 'scan.data_deleted_on_disconnect', old.user_id::text);
  return old;
end;
$$;

create trigger on_gmail_connection_deleted
  after delete on private.gmail_connections
  for each row execute function private.on_gmail_connection_deleted();

create or replace function private.on_customer_inactive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'inactive' and old.status = 'active' then
    delete from private.message_links where customer_id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_customer_inactive
  after update of status on public.customers
  for each row execute function private.on_customer_inactive();

-- ---------------------------------------------------------------------------
-- Review decisions now also settle the waiting messages.
-- ---------------------------------------------------------------------------

create or replace function public.review_resolve(p_item uuid, p_action text, p_customer uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item    private.review_items;
  v_linked  integer := 0;
begin
  perform private.require_admin();
  select * into v_item from private.review_items where id = p_item for update;
  if not found then
    raise exception 'review item not found' using errcode = 'P0002';
  end if;

  if p_action = 'same_customer' then
    if p_customer is null or not exists (select 1 from public.customers where id = p_customer and status = 'active') then
      raise exception 'choose an active customer' using errcode = '22023';
    end if;
    perform private.add_alias(p_customer, v_item.observed, 'alias', 'review');
    insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at,
                                       direction, customer_addresses, evidence, score, rules_version, link_status, job_id)
    select o.owner_id, p_customer, o.gmail_message_id, o.gmail_thread_id, o.message_at, o.direction, '{}',
           jsonb_build_array(jsonb_build_object('type', 'review', 'value', v_item.observed_normalized)),
           1, 'm1', 'confirmed', o.job_id
      from private.review_occurrences o
     where o.review_item_id = p_item
    on conflict on constraint message_links_unique do nothing;
    get diagnostics v_linked = row_count;
  elsif p_action = 'not_a_customer' then
    insert into public.name_rejections (normalized, decided_by)
    values (v_item.observed_normalized, auth.uid())
    on conflict do nothing;
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;

  delete from private.review_items where id = p_item; -- occurrences go with it
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'review.resolved', p_item::text, jsonb_build_object(
    'decision', p_action, 'customer', p_customer, 'name', v_item.observed_normalized, 'messages_linked', v_linked));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;

grant execute on function private.worker_claim_job(integer) to c360_worker;
grant execute on function private.worker_job_token(uuid) to c360_worker;
grant execute on function private.worker_customer_master() to c360_worker;
grant execute on function private.worker_commit_page(uuid, integer, text, jsonb, jsonb, jsonb, jsonb, boolean) to c360_worker;
grant execute on function private.worker_auth_lost(uuid) to c360_worker;
grant execute on function private.worker_release(uuid, text) to c360_worker;
grant execute on function private.worker_retention_cleanup() to c360_worker;

revoke execute on function public.scan_start() from public, anon;
revoke execute on function public.scan_cancel() from public, anon;
revoke execute on function public.scan_resume() from public, anon;
revoke execute on function public.my_scan_jobs() from public, anon;
revoke execute on function public.my_message_links(uuid, integer) from public, anon;
revoke execute on function public.scan_jobs_overview() from public, anon;
grant execute on function public.scan_start() to authenticated;
grant execute on function public.scan_cancel() to authenticated;
grant execute on function public.scan_resume() to authenticated;
grant execute on function public.my_scan_jobs() to authenticated;
grant execute on function public.my_message_links(uuid, integer) to authenticated;
grant execute on function public.scan_jobs_overview() to authenticated;
