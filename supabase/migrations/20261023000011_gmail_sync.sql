-- Migration 0011: keep each approved mailbox in step with new email (push + safety net).
--
-- After a mailbox's one-off scan has completed, new mail is picked up
-- continuously:
--   * Gmail push: Gmail notifies a Google Pub/Sub topic when a mailbox
--     changes; Pub/Sub calls the app; the app marks that mailbox "dirty" and
--     syncs it at once.
--   * Safety net: a cron run every 10 minutes syncs dirty mailboxes, any
--     mailbox not synced for an hour, and renews Gmail's watch (it expires
--     after 7 days).
--   * First run per mailbox: catch-up from just before its last scan's cutoff
--     to now, then incremental (Gmail history ids) from there.
--
-- Same rules as the scan: header data only, same exclusions and matching, the
-- same message_links / review tables, and extraction follows automatically
-- (0008 trigger on new links). Only mailboxes on the scan allowlist with a
-- completed scan are synced. Nothing here stores email content.
--
-- Reverse: supabase/rollback/20261023000011_gmail_sync.down.sql

create table private.gmail_sync (
  user_id            uuid primary key references private.gmail_connections (user_id) on delete cascade,
  mailbox_email      text not null,
  -- Gmail history ids are unsigned 64-bit integers: stored as digits.
  history_id         text check (history_id ~ '^[0-9]{1,20}$'),
  catchup_history_id text check (catchup_history_id ~ '^[0-9]{1,20}$'),
  catchup_page_token text check (length(catchup_page_token) <= 512),
  floor_at           timestamptz not null,
  watch_expires_at   timestamptz,
  dirty              boolean not null default true,
  last_push_at       timestamptz,
  last_synced_at     timestamptz,
  lease_until        timestamptz,
  next_attempt_at    timestamptz,
  error_count        integer not null default 0,
  last_error         text check (length(last_error) <= 64),
  processed          bigint not null default 0,
  linked             bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

revoke all on private.gmail_sync from public, anon, authenticated;

-- Mailboxes that may be synced: active connection, active employee, on the
-- scan allowlist, and a completed scan (its cutoff is where sync starts).
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
   where c.status = 'active' and private.scan_allowed(c.mailbox_email)
   group by c.user_id, c.mailbox_email
$$;

-- Pub/Sub said this mailbox changed. Returns its owner (to sync now) or null.
create or replace function private.worker_sync_push(p_mailbox text, p_history_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_history_id is null or p_history_id !~ '^[0-9]{1,20}$' then
    raise exception 'bad history id' using errcode = '22023';
  end if;
  update private.gmail_sync s
     set dirty = true, last_push_at = now(), updated_at = now()
   where lower(s.mailbox_email) = lower(btrim(coalesce(p_mailbox, '')))
     and exists (select 1 from private.sync_eligible() e where e.user_id = s.user_id)
  returning s.user_id into v_owner;
  return v_owner;
end;
$$;

-- Leases mailboxes that need a sync: just notified, catching up, not synced
-- for an hour, or whose Gmail watch expires within 2 days. Creates the sync
-- row for a newly eligible mailbox. p_owner limits the run to one mailbox.
create or replace function private.worker_sync_claim(p_limit integer, p_lease_seconds integer, p_owner uuid default null)
returns table (owner_id uuid, mailbox_email text, history_id text, catchup_history_id text, catchup_page_token text,
               floor_at timestamptz, watch_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.gmail_sync (user_id, mailbox_email, floor_at)
  select e.user_id, e.mailbox_email, e.scanned_to - interval '1 day'
    from private.sync_eligible() e
  on conflict (user_id) do nothing;

  return query
  with picked as (
    select s.user_id
      from private.gmail_sync s
      join private.sync_eligible() e on e.user_id = s.user_id and e.mailbox_email = s.mailbox_email
     where (p_owner is null or s.user_id = p_owner)
       and (s.lease_until is null or s.lease_until < now())
       and (s.next_attempt_at is null or s.next_attempt_at <= now() or (p_owner is not null and s.dirty))
       and (s.dirty or s.history_id is null or s.last_synced_at is null
            or s.last_synced_at < now() - interval '1 hour'
            or s.watch_expires_at is null or s.watch_expires_at < now() + interval '2 days')
     order by s.dirty desc, s.last_synced_at nulls first
     limit least(greatest(coalesce(p_limit, 5), 1), 20)
     for update of s skip locked
  )
  update private.gmail_sync s
     set lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 240), 30), 900)),
         dirty = false, -- a push that arrives while this run works sets it again
         updated_at = now()
    from picked
   where s.user_id = picked.user_id
  returning s.user_id, s.mailbox_email, s.history_id, s.catchup_history_id, s.catchup_page_token, s.floor_at, s.watch_expires_at;
end;
$$;

-- The encrypted token of a leased mailbox. Useless without the app key.
create or replace function private.worker_sync_token(p_owner uuid)
returns table (refresh_token_enc text, key_version smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.refresh_token_enc, c.key_version
    from private.gmail_sync s
    join private.gmail_connections c on c.user_id = s.user_id and c.status = 'active' and c.mailbox_email = s.mailbox_email
    join public.app_users u on u.id = s.user_id and u.status = 'active'
   where s.user_id = p_owner and s.lease_until > now() and private.scan_allowed(s.mailbox_email)
$$;

-- Commits one sync step: links and review items (same rules as the scan) and
-- the new position. p_state: history_id, catchup_history_id, catchup_page_token,
-- watch_expires_at (all optional, null clears the catch-up fields), done.
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
  if jsonb_array_length(coalesce(p_links, '[]')) > 5000 then
    raise exception 'too many links in one step' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
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

-- A sync step failed: back off (2, 4, 8 ... up to 360 minutes) and keep the position.
create or replace function private.worker_sync_fail(p_owner uuid, p_code text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.gmail_sync
     set error_count = error_count + 1,
         last_error = left(coalesce(p_code, 'unknown'), 64),
         lease_until = null,
         dirty = true,
         next_attempt_at = now() + make_interval(mins => least(power(2, least(error_count + 1, 9))::integer, 360)),
         updated_at = now()
   where user_id = p_owner
$$;

-- Admins: one row per synced mailbox (counts and times only).
create or replace function public.sync_overview()
returns table (mailbox_email text, mode text, last_synced_at timestamptz, last_push_at timestamptz,
               watch_expires_at timestamptz, processed bigint, linked bigint, last_error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select s.mailbox_email, case when s.history_id is null then 'catching up' else 'live' end,
         s.last_synced_at, s.last_push_at, s.watch_expires_at, s.processed, s.linked, s.last_error
    from private.gmail_sync s order by s.mailbox_email;
end;
$$;

revoke all on function private.sync_eligible(), private.worker_sync_push(text, text),
                       private.worker_sync_claim(integer, integer, uuid), private.worker_sync_token(uuid),
                       private.worker_sync_commit(uuid, jsonb, jsonb, jsonb, jsonb, text),
                       private.worker_sync_fail(uuid, text)
  from public, anon, authenticated;
grant execute on function private.worker_sync_push(text, text), private.worker_sync_claim(integer, integer, uuid),
                          private.worker_sync_token(uuid), private.worker_sync_commit(uuid, jsonb, jsonb, jsonb, jsonb, text),
                          private.worker_sync_fail(uuid, text)
  to c360_worker;
revoke execute on function public.sync_overview() from public, anon;
grant execute on function public.sync_overview() to authenticated;
