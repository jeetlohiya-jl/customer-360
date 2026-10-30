-- Apply migration 0013 in the Supabase SQL editor (production), then record it so 'supabase db push' never re-applies it.
begin;
-- Migration 0013: colleagues' internal emails about a customer, targeted
-- re-scans, deleted emails, and an audit trail for direct changes.
--
-- Why (2026-10-23): the Preferred Packaging thread "1C & 2C fiber trays" was
-- never linked. The customer writes from cpflexpack.com (not on file), and
-- most next steps were in internal-only replies, CRM ticket emails and
-- colleagues' forwards, which CS5 always dropped.
--
-- 1. Setting 'internal_linking' (default 'off' here; an admin turns it on):
--      off              internal-only mail is never linked (CS5 as before)
--      thread           an internal-only message is linked to the customers its
--                       mailbox ALREADY has in the same Gmail thread (evidence T1)
--      thread_and_named also when its subject names exactly one customer by an
--                       exact name or approved alias (evidence I1, set by the app)
--    Privacy rules (labels, sensitivity, private/HR/credential subjects) still
--    apply first. Links get direction 'internal'. Nothing is stored for
--    internal mail that never links to a customer.
-- 2. Targeted scans: a scan job may carry a Gmail search (scan_jobs.search_query)
--    so a customer's past email can be found again after a domain or alias is
--    added, without re-reading whole mailboxes. public.customer_backfill() (admin)
--    queues one for every approved, connected mailbox with no scan in progress.
-- 3. Extraction: skip reason 'deleted' (Gmail no longer has the email).
-- 4. Audit: role and status changes made outside set_user_role, and every
--    change to private.settings, are written to the audit log.
--
-- Reverse: supabase/rollback/20261023000013_internal_threads.down.sql

-- ---------------------------------------------------------------------------
-- 1. Settings and directions
-- ---------------------------------------------------------------------------
insert into private.settings (key, value) values ('internal_linking', 'off')
on conflict (key) do nothing;

create or replace function private.internal_linking()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when v in ('off', 'thread', 'thread_and_named') then v else 'off' end
    from (select coalesce((select value from private.settings where key = 'internal_linking'), 'off') as v) s
$$;

alter table private.message_links drop constraint if exists message_links_direction_check;
alter table private.message_links add constraint message_links_direction_check
  check (direction in ('inbound', 'outbound', 'internal'));
alter table private.customer_facts drop constraint if exists customer_facts_direction_check;
alter table private.customer_facts add constraint customer_facts_direction_check
  check (direction in ('inbound', 'outbound', 'internal'));

alter table private.extraction_state drop constraint if exists extraction_state_skip_reason_check;
alter table private.extraction_state add constraint extraction_state_skip_reason_check
  check (skip_reason in ('auto_reply', 'bulk', 'calendar', 'delivery_notice', 'too_short',
                         'acknowledgement', 'empty', 'excluded', 'not_customer_related', 'deleted'));

-- Thread look-ups for follow-ups.
create index if not exists message_links_owner_thread on private.message_links (owner_id, gmail_thread_id)
  where gmail_thread_id is not null;

-- The app reads the setting with the customer master (one call per page).
create or replace function private.worker_customer_master()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workspace_domain', private.workspace_domain(),
    'internal_linking', private.internal_linking(),
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

-- Thread follow-ups: items in p_links marked "thread_followup": true, with a
-- message id, thread id and date and NO customer. Each is linked to every
-- active customer the SAME mailbox already has a link for in that thread.
-- Returns the number of links added. Does nothing when the setting is 'off'.
create or replace function private.link_thread_followups(p_owner uuid, p_links jsonb, p_rules_version text, p_job uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  item     jsonb;
  n        integer;
  v_linked integer := 0;
  v_seen   integer := 0;
  v_mode   text := private.internal_linking();
begin
  if v_mode = 'off' then
    return 0;
  end if;
  for item in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    continue when not coalesce((item ->> 'thread_followup')::boolean, false);
    v_seen := v_seen + 1;
    exit when v_seen > 5000;  -- a bounded amount of work per step; extra follow-ups are ignored, never an error
    continue when coalesce(item ->> 'gmail_thread_id', '') !~ '^[0-9a-zA-Z_-]{1,64}$'
               or coalesce(item ->> 'gmail_message_id', '') !~ '^[0-9a-zA-Z_-]{1,64}$';
    insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at,
                                       direction, customer_addresses, evidence, score, rules_version, link_status, job_id)
    select distinct p_owner, l.customer_id, item ->> 'gmail_message_id', item ->> 'gmail_thread_id',
           (item ->> 'message_at')::timestamptz, 'internal', '{}'::text[],
           jsonb_build_array(jsonb_build_object('type', 'T1', 'value', 'same thread')), 0.9::numeric,
           p_rules_version, 'auto', p_job
      from private.message_links l
      join public.customers c on c.id = l.customer_id and c.status = 'active'
     where l.owner_id = p_owner
       and l.gmail_thread_id = item ->> 'gmail_thread_id'
       and l.gmail_message_id <> item ->> 'gmail_message_id'
       -- A thread belongs to a customer through customer mail; subject-named internal mail (I1)
       -- counts only while that rule is on. Thread links (T1) never seed further links.
       and (l.direction <> 'internal'
            or (v_mode = 'thread_and_named' and l.evidence @> '[{"type":"I1"}]'::jsonb))
    on conflict on constraint message_links_unique do nothing;
    get diagnostics n = row_count;
    v_linked := v_linked + n;
  end loop;
  return v_linked;
end;
$$;

-- Commit functions: as in 0006 / 0011, plus thread follow-ups.
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
    continue when coalesce((item ->> 'thread_followup')::boolean, false);
    -- Internal mail named in its subject (I1) only while the setting allows it (checked here too: the
    -- worker may have read the setting before an admin switched it off).
    continue when item ->> 'direction' = 'internal' and private.internal_linking() <> 'thread_and_named';
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

  -- 0013: internal replies in threads this mailbox already links to a customer (after the links above).
  perform private.link_thread_followups(v_job.owner_id, p_links, v_job.rules_version, v_job.id);

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

create or replace function private.worker_sync_commit(p_owner uuid, p_state jsonb, p_links jsonb, p_reviews jsonb,
                                                      p_counts jsonb, p_rules_version text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sync   private.gmail_sync;
  item     jsonb;
  occ      jsonb;
  v_review uuid;
  v_norm   text;
  v_cand   jsonb;
  v_linked integer := 0;
  n        integer;
begin
  select * into v_sync from private.gmail_sync where user_id = p_owner for update;
  if not found or v_sync.lease_until is null or v_sync.lease_until < now() then
    raise exception 'mailbox is not leased by this worker' using errcode = '55000';
  end if;
  if p_rules_version is null or length(p_rules_version) > 16 then
    raise exception 'rules version required' using errcode = '22023';
  end if;
  if (p_state ->> 'history_id') !~ '^[0-9]{1,20}$' and (p_state ->> 'history_id') is not null then
    raise exception 'bad history id' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_links, '[]')) > 10000 then
    raise exception 'too many links in one step' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    continue when coalesce((item ->> 'thread_followup')::boolean, false);
    -- Internal mail named in its subject (I1) only while the setting allows it (checked here too: the
    -- worker may have read the setting before an admin switched it off).
    continue when item ->> 'direction' = 'internal' and private.internal_linking() <> 'thread_and_named';
    insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at,
                                       direction, customer_addresses, evidence, score, rules_version, link_status, job_id)
    select p_owner, c.id, item ->> 'gmail_message_id', item ->> 'gmail_thread_id',
           (item ->> 'message_at')::timestamptz, item ->> 'direction',
           coalesce(array(select jsonb_array_elements_text(item -> 'customer_addresses')), '{}'),
           coalesce(item -> 'evidence', '[]'::jsonb), (item ->> 'score')::numeric, p_rules_version, 'auto', null
      from public.customers c
     where c.id = (item ->> 'customer_id')::uuid and c.status = 'active'
    on conflict on constraint message_links_unique do nothing;
    get diagnostics n = row_count;
    v_linked := v_linked + n;
  end loop;

  -- 0013: internal replies in threads this mailbox already links to a customer (after the links above).
  v_linked := v_linked + private.link_thread_followups(p_owner, p_links, p_rules_version, null);

  -- Uncertain names: identical to private.worker_commit_page (0006).
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
      values (v_review, p_owner, occ ->> 'gmail_message_id', occ ->> 'gmail_thread_id',
              (occ ->> 'message_at')::timestamptz, occ ->> 'direction', null)
      on conflict do nothing;
    end loop;
  end loop;

  update private.gmail_sync set
    history_id         = coalesce(p_state ->> 'history_id', history_id),
    catchup_history_id = p_state ->> 'catchup_history_id',
    catchup_page_token = left(p_state ->> 'catchup_page_token', 512),
    floor_at           = coalesce((p_state ->> 'floor_at')::timestamptz, floor_at),
    watch_expires_at   = coalesce((p_state ->> 'watch_expires_at')::timestamptz, watch_expires_at),
    -- Not finished (catch-up continues, or more history): come back on the next run.
    dirty              = dirty or not coalesce((p_state ->> 'done')::boolean, true),
    last_synced_at     = case when coalesce((p_state ->> 'done')::boolean, true) then now() else last_synced_at end,
    lease_until        = null,
    next_attempt_at    = null,
    error_count        = 0,
    last_error         = null,
    processed          = processed + greatest(coalesce((p_counts ->> 'processed')::bigint, 0), 0),
    linked             = linked + v_linked,
    updated_at         = now()
  where user_id = p_owner;
  return 'ok';
end;
$$;

-- Search: the direction filter accepts 'internal'.
create or replace function public.search_my_links(
  p_query     text        default null,
  p_customer  uuid        default null,
  p_from      date        default null,
  p_to        date        default null,
  p_direction text        default null,
  p_mailbox   text        default null,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid        default null,
  p_limit     integer     default 50
)
returns table (
  link_id            uuid,
  customer_id        uuid,
  customer_name      text,
  mailbox_email      text,
  gmail_message_id   text,
  gmail_thread_id    text,
  message_at         timestamptz,
  direction          text,
  customer_addresses text[],
  link_status        text,
  matched_on         text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_mailbox text;
  v_raw     text := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_norm    text;
  v_like    text;
  v_limit   integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_uid is null or not private.is_active_user() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_raw is not null and (length(v_raw) < 2 or length(v_raw) > 100) then
    raise exception 'search text must be 2 to 100 characters' using errcode = '22023';
  end if;
  if p_direction is not null and p_direction not in ('inbound', 'outbound', 'internal') then
    raise exception 'direction must be inbound, outbound or internal' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'from date is after to date' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor needs both a time and an id' using errcode = '22023';
  end if;

  select g.mailbox_email into v_mailbox from private.gmail_connections g where g.user_id = v_uid;
  -- Mailbox filter: only the caller's own mailbox can ever match.
  if p_mailbox is not null and (v_mailbox is null or lower(btrim(p_mailbox)) <> lower(v_mailbox)) then
    return;
  end if;

  v_norm := nullif(private.normalize_name(coalesce(v_raw, '')), '');
  v_like := '%' || private.like_escape(coalesce(v_raw, '')) || '%';

  return query
  select l.id, l.customer_id, c.canonical_name, v_mailbox, l.gmail_message_id, l.gmail_thread_id,
         l.message_at, l.direction, l.customer_addresses, l.link_status, m.matched_on
    from private.message_links l
    join public.customers c on c.id = l.customer_id
    cross join lateral (
      select case when v_raw is null then array[]::text[] else array_remove(array[
        case when v_norm is not null
              and (' ' || c.normalized_name || ' ') like ('% ' || private.like_escape(v_norm) || '%')
             then 'customer name' end,
        case when v_norm is not null and exists (
               select 1 from public.customer_aliases a
                where a.customer_id = c.id
                  and (' ' || a.normalized || ' ') like ('% ' || private.like_escape(v_norm) || '%'))
             then 'customer alias' end,
        case when exists (
               select 1 from public.customer_identifiers i
                where i.customer_id = c.id and i.value like v_like)
             then 'customer domain or address' end,
        case when exists (
               select 1 from unnest(l.customer_addresses) as x(addr)
                where lower(x.addr) like v_like)
             then 'contact address' end
      ], null) end as matched_on
    ) m
   where l.owner_id = v_uid
     and (p_customer is null or l.customer_id = p_customer)
     and (p_from is null or l.message_at >= (p_from::timestamp at time zone 'UTC'))
     and (p_to is null or l.message_at < ((p_to + 1)::timestamp at time zone 'UTC'))
     and (p_direction is null or l.direction = p_direction)
     and (v_raw is null or cardinality(m.matched_on) > 0)
     and (p_cursor_at is null or (l.message_at, l.id) < (p_cursor_at, p_cursor_id))
   order by l.message_at desc, l.id desc
   limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Targeted scans
-- ---------------------------------------------------------------------------
alter table private.scan_jobs add column if not exists search_query text
  check (search_query is null or (length(search_query) <= 500 and search_query ~ '^[A-Za-z0-9@._:"(){} &''+-]+$'));
alter table private.scan_jobs add column if not exists purpose text
  check (purpose is null or length(purpose) <= 200);

-- Sync starts only after a FULL scan of the mailbox (0011); a completed targeted
-- re-scan does not make a mailbox eligible, nor move where its sync starts.
create or replace function private.sync_eligible()
returns table (user_id uuid, mailbox_email text, scanned_to timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.user_id, c.mailbox_email, max(j.cutoff_at)
    from private.gmail_connections c
    join public.app_users u on u.id = c.user_id and u.status = 'active'
    join private.scan_jobs j on j.owner_id = c.user_id and j.status = 'completed' and j.mailbox_email = c.mailbox_email
                            and j.search_query is null  -- 0013: a targeted re-scan is not a mailbox scan
   where c.status = 'active' and private.scan_allowed(c.mailbox_email)
   group by c.user_id, c.mailbox_email
$$;

-- The Gmail search for a claimed job (null: the whole mailbox).
create or replace function private.worker_job_query(p_job uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select j.search_query from private.scan_jobs j
   where j.id = p_job and j.status in ('running', 'cancelling') and j.lease_until > now()
$$;

-- The Gmail search that finds a customer's email: its domains and addresses in
-- From/To/Cc, and its name and aliases in the subject. Null if it has none.
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

-- Admin: find a customer's past email again (after adding a domain, address or
-- alias). Queues a targeted scan for each approved, connected mailbox that has
-- had a full scan and has no scan in progress. Returns how many were queued.
create or replace function public.customer_backfill(p_customer uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_query text;
  v_name  text;
  n       integer;
begin
  perform private.require_admin();
  select canonical_name into v_name from public.customers where id = p_customer and status = 'active';
  if v_name is null then
    raise exception 'customer not found or inactive' using errcode = 'P0002';
  end if;
  v_query := private.customer_search_query(p_customer);
  if v_query is null then
    raise exception 'the customer has no domain, address or searchable name' using errcode = '22023';
  end if;
  insert into private.scan_jobs (owner_id, mailbox_email, rules_version, started_by, search_query, purpose)
  select g.user_id, g.mailbox_email, 'm2', auth.uid(), v_query, left('backfill: ' || v_name, 200)
    from private.gmail_connections g
    join public.app_users u on u.id = g.user_id and u.status = 'active'
   where g.status = 'active' and private.scan_allowed(g.mailbox_email)
     -- Only mailboxes whose owner already ran a full scan: a backfill finds past email again, it never starts scanning a new mailbox.
     and exists (select 1 from private.scan_jobs j where j.owner_id = g.user_id and j.mailbox_email = g.mailbox_email
                  and j.status = 'completed' and j.search_query is null)
     and not exists (select 1 from private.scan_jobs j where j.owner_id = g.user_id
                      and j.status in ('queued', 'running', 'cancelling', 'paused_auth'));
  get diagnostics n = row_count;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'customer.backfill_queued', p_customer::text, jsonb_build_object('mailboxes', n));
  return n;
end;
$$;

-- Operators (SQL editor, database owner): the same, without a signed-in admin.
create or replace function private.customer_backfill_as_owner(p_customer uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_query text := private.customer_search_query(p_customer);
  n       integer;
begin
  if v_query is null then
    raise exception 'the customer has no domain, address or searchable name' using errcode = '22023';
  end if;
  insert into private.scan_jobs (owner_id, mailbox_email, rules_version, search_query, purpose)
  select g.user_id, g.mailbox_email, 'm2', v_query, left(coalesce(p_reason, 'backfill'), 200)
    from private.gmail_connections g
    join public.app_users u on u.id = g.user_id and u.status = 'active'
   where g.status = 'active' and private.scan_allowed(g.mailbox_email)
     -- Only mailboxes whose owner already ran a full scan: a backfill finds past email again, it never starts scanning a new mailbox.
     and exists (select 1 from private.scan_jobs j where j.owner_id = g.user_id and j.mailbox_email = g.mailbox_email
                  and j.status = 'completed' and j.search_query is null)
     and not exists (select 1 from private.scan_jobs j where j.owner_id = g.user_id
                      and j.status in ('queued', 'running', 'cancelling', 'paused_auth'));
  get diagnostics n = row_count;
  insert into public.audit_log (actor, action, target, detail)
  values (null, 'customer.backfill_queued', p_customer::text, jsonb_build_object('mailboxes', n, 'reason', left(coalesce(p_reason, ''), 200)));
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Audit trail for direct changes
-- ---------------------------------------------------------------------------
-- set_user_role() already audits changes made by a signed-in admin. Changes
-- made any other way (SQL editor, scripts: no signed-in user) are recorded here.
create or replace function private.on_app_user_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null and (new.role is distinct from old.role or new.status is distinct from old.status) then
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'user.changed_directly', new.id::text, jsonb_build_object(
      'role_from', old.role, 'role_to', new.role, 'status_from', old.status, 'status_to', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists on_app_user_changed on public.app_users;
create trigger on_app_user_changed
  after update of role, status on public.app_users
  for each row execute function private.on_app_user_changed();

create or replace function private.on_setting_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'setting.changed', coalesce(new.key, old.key), jsonb_build_object(
    'from', left(case when tg_op = 'INSERT' then null else old.value end, 500),
    'to', left(case when tg_op = 'DELETE' then null else new.value end, 500)));
  return coalesce(new, old);
end;
$$;

drop trigger if exists on_setting_changed on private.settings;
create trigger on_setting_changed
  after insert or update or delete on private.settings
  for each row when (pg_trigger_depth() < 2)
  execute function private.on_setting_changed();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function private.internal_linking(), private.link_thread_followups(uuid, jsonb, text, uuid),
                       private.worker_job_query(uuid), private.customer_search_query(uuid),
                       private.customer_backfill_as_owner(uuid, text),
                       private.on_app_user_changed(), private.on_setting_changed()
  from public, anon, authenticated;
grant execute on function private.worker_job_query(uuid) to c360_worker;
revoke execute on function public.customer_backfill(uuid) from public, anon;
grant execute on function public.customer_backfill(uuid) to authenticated;

insert into supabase_migrations.schema_migrations (version, name) values ('20261023000013', 'internal_threads') on conflict (version) do nothing;
commit;
