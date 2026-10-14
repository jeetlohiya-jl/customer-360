-- Stage B + C (DRAFT FOR REVIEW, not approved): customer facts extracted from
-- customer-linked emails.
--
-- Stores structured facts only. No email bodies are stored anywhere. Facts
-- carry a short redacted evidence quote (max 200 chars), their source
-- reference, stance (request/proposal/commitment/report/cancellation),
-- explicit vs inferred basis, open/resolved status and a confidence score.
--
-- Safe defaults: nothing is extracted until FEATURE_EXTRACT=on in the app AND
-- a mailbox is on 'extract_allowed_mailboxes' (empty here) AND its owner has
-- reconnected with gmail.readonly. Monthly AI spend has a hard cap ($50).
--
-- Access:
--   * All active employees: facts that passed checks or were reviewed
--     (decision 2026-10-13), but only once 'facts_visibility' = 'all'. It is
--     'reviewers' here (D10: owners and admins only during the pilot).
--     Gmail message ids only for the mailbox owner.
--     The source mailbox owner is shown to others only if the setting
--     'facts_show_source_owner' is 'on' (off here; decision D2).
--   * Needs-review facts: mailbox owner and admins only. Rejected: hidden.
--   * The worker (c360_worker) only through private.worker_extract_* and
--     private.worker_budget_* functions.
--
-- Deletion: facts reference their message link (ON DELETE CASCADE), so the
-- existing CS9 rules (disconnect, departure, customer inactive) delete facts.
--
-- Reverse: supabase/rollback/20261016000008_fact_extraction.down.sql

-- ---------------------------------------------------------------------------
-- Settings (safe defaults)
-- ---------------------------------------------------------------------------
insert into private.settings (key, value) values
  ('extract_allowed_mailboxes', ''),
  ('extract_monthly_cap_usd', '50'),
  ('facts_show_source_owner', 'off'),
  ('facts_visibility', 'reviewers')
on conflict (key) do nothing;

create or replace function private.extract_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(p_email)) = any (
    string_to_array(replace(lower(coalesce(
      (select value from private.settings where key = 'extract_allowed_mailboxes'), '')), ' ', ''), ','))
    and btrim(coalesce(p_email, '')) <> ''
$$;

create or replace function private.readonly_scope()
returns text
language sql
immutable
set search_path = ''
as $$ select 'https://www.googleapis.com/auth/gmail.readonly'::text $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per (mailbox, message) waiting for or done with extraction.
-- Holds state only: no subject, body or snippet.
create table private.extraction_state (
  owner_id         uuid not null references public.app_users (id) on delete cascade,
  gmail_message_id text not null check (gmail_message_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  gmail_thread_id  text check (gmail_thread_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  message_at       timestamptz not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'claimed', 'extracted', 'skipped', 'failed', 'needs_reconnect')),
  skip_reason      text check (skip_reason in ('auto_reply', 'bulk', 'calendar', 'delivery_notice', 'too_short',
                                               'acknowledgement', 'empty', 'excluded', 'not_customer_related')),
  attempts         smallint not null default 0 check (attempts between 0 and 10),
  last_error       text check (length(last_error) <= 64),
  lease_until      timestamptz,
  -- Retry with backoff: a failed item is retried after 15, then 30 minutes; the third failure is final.
  next_attempt_at  timestamptz,
  model            text check (length(model) <= 64),
  prompt_version   text check (length(prompt_version) <= 32),
  facts_count      smallint check (facts_count between 0 and 20),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (owner_id, gmail_message_id),
  constraint extraction_skip_reason check ((status = 'skipped') = (skip_reason is not null))
);

create index extraction_state_pending on private.extraction_state (status, message_at desc)
  where status in ('pending', 'claimed');

create table private.customer_facts (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null,
  customer_id      uuid not null,
  gmail_message_id text not null,
  gmail_thread_id  text check (gmail_thread_id ~ '^[0-9a-zA-Z_-]{1,64}$'),
  message_at       timestamptz not null,
  direction        text not null check (direction in ('inbound', 'outbound')),
  fact_index       smallint not null check (fact_index between 0 and 19),
  fact_type        text not null check (fact_type in ('requirement', 'order', 'pricing', 'delivery', 'quality_issue', 'follow_up')),
  stance           text not null check (stance in ('request', 'proposal', 'commitment', 'report', 'cancellation')),
  party            text not null check (party in ('customer', 'cirkla', 'unclear')),
  basis            text not null check (basis in ('explicit', 'inferred')),
  status           text not null check (status in ('open', 'resolved', 'cancelled', 'not_applicable', 'unknown')),
  status_basis     text not null check (status_basis in ('explicit', 'inferred', 'none')),
  resolves_fact_id uuid references private.customer_facts (id) on delete set null,
  product          text check (length(product) <= 120),
  quantity         numeric(14, 3) check (quantity >= 0),
  unit             text check (length(unit) <= 24),
  unit_price       numeric(14, 4) check (unit_price >= 0),
  currency         text check (currency ~ '^[A-Z]{3}$'),
  price_basis      text check (length(price_basis) <= 40),
  due_date         date,
  due_text         text check (length(due_text) <= 60),
  reference        text check (length(reference) <= 60),
  summary          text not null check (length(btrim(summary)) between 1 and 300),
  evidence_quote   text check (length(evidence_quote) <= 200),
  confidence       numeric(3, 2) not null check (confidence between 0 and 1),
  review_state     text not null check (review_state in ('auto', 'needs_review', 'confirmed', 'corrected', 'rejected')),
  review_reasons   text[] not null default '{}' check (cardinality(review_reasons) <= 10),
  reviewed_by      uuid references public.app_users (id) on delete set null,
  reviewed_at      timestamptz,
  review_note      text check (length(review_note) <= 300),
  model            text not null check (length(model) <= 64),
  prompt_version   text not null check (length(prompt_version) <= 32),
  extracted_at     timestamptz not null default now(),
  -- Deleting the message link (disconnect, departure, customer inactive) deletes the fact.
  constraint customer_facts_link foreign key (owner_id, gmail_message_id, customer_id)
    references private.message_links (owner_id, gmail_message_id, customer_id) on delete cascade,
  constraint customer_facts_position unique (owner_id, gmail_message_id, customer_id, fact_index),
  -- A request or proposal is never a commitment; a commitment is never inferred.
  constraint customer_facts_commitment_explicit check (stance <> 'commitment' or basis = 'explicit'),
  constraint customer_facts_status_basis check ((status in ('unknown', 'not_applicable')) = (status_basis = 'none')),
  constraint customer_facts_price_currency check (unit_price is null or currency is not null),
  constraint customer_facts_reviewed check ((review_state in ('confirmed', 'corrected', 'rejected')) = (reviewed_at is not null))
);

create index customer_facts_customer_time on private.customer_facts (customer_id, message_at desc, id desc);
create index customer_facts_time on private.customer_facts (message_at desc, id desc);
create index customer_facts_owner_review on private.customer_facts (owner_id, review_state);
create index customer_facts_resolves on private.customer_facts (resolves_fact_id) where resolves_fact_id is not null;

comment on table private.customer_facts is
  'Structured facts from customer-linked emails. No bodies. Evidence quotes are redacted and at most 200 characters.';

-- Monthly AI budget with a hard stop. Amounts in micro-USD (1 USD = 1,000,000).
create table private.ai_budget (
  month             date primary key check (extract(day from month) = 1),
  cap_microusd      bigint not null check (cap_microusd between 0 and 500000000),
  spent_microusd    bigint not null default 0 check (spent_microusd >= 0),
  reserved_microusd bigint not null default 0 check (reserved_microusd >= 0),
  paused_at         timestamptz
);

-- One row per AI call. Token counts and cost only: no owner, message or content.
create table private.ai_usage (
  id                 uuid primary key default gen_random_uuid(),
  month              date not null references private.ai_budget (month),
  reserved_microusd  bigint not null check (reserved_microusd > 0),
  actual_microusd    bigint check (actual_microusd >= 0),
  input_tokens       integer check (input_tokens >= 0),
  cache_read_tokens  integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  output_tokens      integer check (output_tokens >= 0),
  model              text check (length(model) <= 64),
  status             text not null default 'reserved' check (status in ('reserved', 'settled', 'expired')),
  created_at         timestamptz not null default now(),
  settled_at         timestamptz
);

create index ai_usage_open on private.ai_usage (created_at) where status = 'reserved';

revoke all on private.extraction_state, private.customer_facts, private.ai_budget, private.ai_usage
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Keep extraction state in step with message links
-- ---------------------------------------------------------------------------
create or replace function private.on_message_link_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.extraction_state (owner_id, gmail_message_id, gmail_thread_id, message_at)
  values (new.owner_id, new.gmail_message_id, new.gmail_thread_id, new.message_at)
  on conflict (owner_id, gmail_message_id) do nothing;
  return new;
end;
$$;

create trigger on_message_link_added
  after insert on private.message_links
  for each row execute function private.on_message_link_added();

create or replace function private.on_message_link_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.message_links
                  where owner_id = old.owner_id and gmail_message_id = old.gmail_message_id) then
    delete from private.extraction_state where owner_id = old.owner_id and gmail_message_id = old.gmail_message_id;
  end if;
  return old;
end;
$$;

create trigger on_message_link_removed
  after delete on private.message_links
  for each row execute function private.on_message_link_removed();

-- Existing links (none on hosted today) become pending.
insert into private.extraction_state (owner_id, gmail_message_id, gmail_thread_id, message_at)
select distinct on (owner_id, gmail_message_id) owner_id, gmail_message_id, gmail_thread_id, message_at
  from private.message_links
on conflict (owner_id, gmail_message_id) do nothing;

-- Reconnecting with gmail.readonly releases items waiting for it.
create or replace function private.on_gmail_scopes_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.readonly_scope() = any (new.scopes) and new.status = 'active' then
    update private.extraction_state set status = 'pending', updated_at = now()
     where owner_id = new.user_id and status = 'needs_reconnect';
  end if;
  return new;
end;
$$;

create trigger on_gmail_scopes_changed
  after insert or update of scopes, status on private.gmail_connections
  for each row execute function private.on_gmail_scopes_changed();

-- ---------------------------------------------------------------------------
-- Budget (hard stop)
-- ---------------------------------------------------------------------------
create or replace function private.budget_month()
returns date
language sql
stable
set search_path = ''
as $$ select date_trunc('month', now() at time zone 'UTC')::date $$;

-- Ensures this month's row exists and settles reservations older than 15
-- minutes at their full reserved amount (a crashed call is assumed to have
-- cost the maximum, so the cap can never be exceeded by lost settlements).
create or replace function private.budget_prepare()
returns private.ai_budget
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := private.budget_month();
  v_cap   bigint;
  v_row   private.ai_budget;
  v_stale bigint;
begin
  v_cap := round(coalesce(nullif((select value from private.settings where key = 'extract_monthly_cap_usd'), '')::numeric, 0) * 1000000);
  insert into private.ai_budget (month, cap_microusd) values (v_month, least(greatest(v_cap, 0), 500000000))
  on conflict (month) do nothing;
  select * into v_row from private.ai_budget where month = v_month for update;

  with expired as (
    update private.ai_usage set status = 'expired', settled_at = now()
     where status = 'reserved' and month = v_month and created_at < now() - interval '15 minutes'
    returning reserved_microusd
  )
  select coalesce(sum(reserved_microusd), 0) into v_stale from expired;
  if v_stale > 0 then
    update private.ai_budget
       set spent_microusd = spent_microusd + v_stale, reserved_microusd = greatest(reserved_microusd - v_stale, 0)
     where month = v_month
    returning * into v_row;
  end if;
  return v_row;
end;
$$;

-- Reserve the worst-case cost of one AI call before making it. Returns null
-- (and pauses extraction for the rest of the month) when it would exceed the cap.
create or replace function private.worker_budget_reserve(p_microusd bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.ai_budget;
  v_id  uuid;
begin
  if p_microusd is null or p_microusd <= 0 or p_microusd > 100000 then
    raise exception 'reservation must be between 1 and 100000 micro-USD' using errcode = '22023';
  end if;
  v_row := private.budget_prepare();
  if v_row.paused_at is not null
     or v_row.spent_microusd + v_row.reserved_microusd + p_microusd > v_row.cap_microusd then
    if v_row.paused_at is null then
      update private.ai_budget set paused_at = now() where month = v_row.month;
      insert into public.audit_log (actor, action, target, detail)
      values (null, 'extract.budget_paused', v_row.month::text,
              jsonb_build_object('cap_usd', v_row.cap_microusd / 1000000.0, 'spent_usd', v_row.spent_microusd / 1000000.0));
    end if;
    return null;
  end if;
  update private.ai_budget set reserved_microusd = reserved_microusd + p_microusd where month = v_row.month;
  insert into private.ai_usage (month, reserved_microusd) values (v_row.month, p_microusd) returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.worker_budget_settle(p_id uuid, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_use    private.ai_usage;
  v_actual bigint := (p_usage ->> 'actual_microusd')::bigint;
begin
  if v_actual is null or v_actual < 0 then
    raise exception 'actual_microusd required' using errcode = '22023';
  end if;
  select * into v_use from private.ai_usage where id = p_id for update;
  if not found or v_use.status <> 'reserved' then
    raise exception 'reservation not open' using errcode = '55000';
  end if;
  update private.ai_usage
     set status = 'settled', settled_at = now(), actual_microusd = v_actual,
         input_tokens = (p_usage ->> 'input_tokens')::integer,
         cache_read_tokens = (p_usage ->> 'cache_read_tokens')::integer,
         cache_write_tokens = (p_usage ->> 'cache_write_tokens')::integer,
         output_tokens = (p_usage ->> 'output_tokens')::integer,
         model = left(p_usage ->> 'model', 64)
   where id = p_id;
  update private.ai_budget
     set reserved_microusd = greatest(reserved_microusd - v_use.reserved_microusd, 0),
         spent_microusd = spent_microusd + v_actual,
         -- An under-estimate that crosses the cap stops further calls at once.
         paused_at = case when spent_microusd + v_actual >= cap_microusd then coalesce(paused_at, now()) else paused_at end
   where month = v_use.month;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker: claim, token, context, commit
-- ---------------------------------------------------------------------------

-- Leases up to p_limit pending messages from approved mailboxes. Returns
-- nothing while the month's budget is paused. Items whose owner has not yet
-- granted gmail.readonly are parked as 'needs_reconnect'.
create or replace function private.worker_extract_claim(p_limit integer, p_lease_seconds integer)
returns table (owner_id uuid, mailbox_email text, gmail_message_id text, gmail_thread_id text,
               message_at timestamptz, direction text, customers jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget private.ai_budget;
begin
  v_budget := private.budget_prepare();
  if v_budget.paused_at is not null or v_budget.spent_microusd + v_budget.reserved_microusd >= v_budget.cap_microusd then
    return;
  end if;

  update private.extraction_state s set status = 'needs_reconnect', lease_until = null, updated_at = now()
    from private.gmail_connections c
   where c.user_id = s.owner_id and s.status = 'pending'
     and not (private.readonly_scope() = any (c.scopes));

  return query
  with picked as (
    select s.owner_id, s.gmail_message_id
      from private.extraction_state s
      join private.gmail_connections c on c.user_id = s.owner_id and c.status = 'active'
      join public.app_users u on u.id = s.owner_id and u.status = 'active'
     where (s.status = 'pending' or (s.status = 'claimed' and s.lease_until < now()))
       and (s.next_attempt_at is null or s.next_attempt_at <= now())
       and private.extract_allowed(c.mailbox_email)
       and private.readonly_scope() = any (c.scopes)
     order by s.message_at desc
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
       for update of s skip locked
  ), claimed as (
    update private.extraction_state s
       set status = 'claimed', lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600)),
           updated_at = now()
      from picked p
     where s.owner_id = p.owner_id and s.gmail_message_id = p.gmail_message_id
    returning s.owner_id, s.gmail_message_id, s.gmail_thread_id, s.message_at
  )
  select k.owner_id, c.mailbox_email, k.gmail_message_id, k.gmail_thread_id, k.message_at,
         (select l.direction from private.message_links l
           where l.owner_id = k.owner_id and l.gmail_message_id = k.gmail_message_id limit 1),
         (select jsonb_agg(jsonb_build_object('id', cu.id, 'name', cu.canonical_name) order by cu.canonical_name)
            from private.message_links l join public.customers cu on cu.id = l.customer_id
           where l.owner_id = k.owner_id and l.gmail_message_id = k.gmail_message_id)
    from claimed k
    join private.gmail_connections c on c.user_id = k.owner_id;
end;
$$;

-- Encrypted refresh token, only for an owner with a live claimed item.
create or replace function private.worker_extract_token(p_owner uuid)
returns table (refresh_token_enc text, key_version smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.refresh_token_enc, c.key_version
    from private.gmail_connections c
    join public.app_users u on u.id = c.user_id and u.status = 'active'
   where c.user_id = p_owner and c.status = 'active'
     and private.extract_allowed(c.mailbox_email)
     and private.readonly_scope() = any (c.scopes)
     and exists (select 1 from private.extraction_state s
                  where s.owner_id = p_owner and s.status = 'claimed' and s.lease_until > now())
$$;

-- Open facts for the customers of a claimed message (id, type, summary, date):
-- the only stored data sent to the model as context, so it can mark updates.
create or replace function private.worker_extract_context(p_owner uuid, p_message text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'customer_id', f.customer_id, 'type', f.fact_type,
                                               'summary', f.summary, 'date', f.message_at::date)
                            order by f.message_at desc), '[]'::jsonb)
    from (
      select f.* from private.customer_facts f
       where f.customer_id in (select l.customer_id from private.message_links l
                                where l.owner_id = p_owner and l.gmail_message_id = p_message)
         and f.status = 'open' and f.review_state <> 'rejected'
         and exists (select 1 from private.extraction_state s
                      where s.owner_id = p_owner and s.gmail_message_id = p_message
                        and s.status = 'claimed' and s.lease_until > now())
       order by f.message_at desc
       limit 20
    ) f
$$;

-- Applies the database's own review rules on top of the worker's checks.
create or replace function private.fact_review_reasons(p_type text, p_stance text, p_basis text, p_status_basis text,
                                                       p_confidence numeric, p_worker_reasons text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array(select distinct r from unnest(
    coalesce(p_worker_reasons, '{}')
    || case when p_confidence < 0.70 then array['low_confidence'] else '{}'::text[] end
    || case when p_stance = 'commitment' and p_type in ('order', 'pricing', 'delivery') and p_confidence < 0.90
            then array['commitment_needs_check'] else '{}'::text[] end
    || case when p_status_basis = 'inferred' then array['inferred_status'] else '{}'::text[] end
  ) as r order by r)
$$;

create or replace function private.worker_extract_commit(p_owner uuid, p_message text, p_meta jsonb, p_facts jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state   private.extraction_state;
  v_link    private.message_links;
  f         jsonb;
  v_reasons text[];
  v_id      uuid;
  v_prev    private.customer_facts;
  v_n       integer := 0;
  v_model   text := left(p_meta ->> 'model', 64);
  v_prompt  text := left(p_meta ->> 'prompt_version', 32);
begin
  select * into v_state from private.extraction_state
   where owner_id = p_owner and gmail_message_id = p_message for update;
  if not found or v_state.status <> 'claimed' or v_state.lease_until < now() then
    raise exception 'message not claimed' using errcode = '55000';
  end if;
  if jsonb_typeof(p_facts) <> 'array' or jsonb_array_length(p_facts) > 20 then
    raise exception 'facts must be an array of at most 20' using errcode = '22023';
  end if;
  if v_model is null or v_prompt is null then
    raise exception 'model and prompt_version required' using errcode = '22023';
  end if;

  -- Re-extraction replaces this message's earlier facts.
  delete from private.customer_facts where owner_id = p_owner and gmail_message_id = p_message;

  for f in select value from jsonb_array_elements(p_facts) loop
   -- Any failure inside is re-raised WITHOUT the row's values, so neither the
   -- caller nor the database server log ever sees fact text (see 008 tests).
   begin
    select * into v_link from private.message_links
     where owner_id = p_owner and gmail_message_id = p_message and customer_id = (f ->> 'customer_id')::uuid;
    if not found then
      raise exception 'fact customer is not linked to this message' using errcode = '22023';
    end if;
    v_reasons := private.fact_review_reasons(f ->> 'fact_type', f ->> 'stance', f ->> 'basis', f ->> 'status_basis',
                   (f ->> 'confidence')::numeric,
                   array(select jsonb_array_elements_text(coalesce(f -> 'review_reasons', '[]'::jsonb))));

    v_prev := null;
    if f ->> 'resolves_fact_id' is not null then
      select * into v_prev from private.customer_facts
       where id = (f ->> 'resolves_fact_id')::uuid and customer_id = v_link.customer_id for update;
      if not found then
        v_reasons := array(select distinct r from unnest(v_reasons || array['unknown_related_fact']) r order by r);
      end if;
    end if;

    insert into private.customer_facts (
      owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at, direction, fact_index,
      fact_type, stance, party, basis, status, status_basis, resolves_fact_id,
      product, quantity, unit, unit_price, currency, price_basis, due_date, due_text, reference,
      summary, evidence_quote, confidence, review_state, review_reasons, model, prompt_version)
    values (
      p_owner, v_link.customer_id, p_message, v_link.gmail_thread_id, v_link.message_at, v_link.direction,
      (f ->> 'fact_index')::smallint,
      f ->> 'fact_type', f ->> 'stance', f ->> 'party', f ->> 'basis', f ->> 'status', f ->> 'status_basis',
      v_prev.id,
      f ->> 'product', (f ->> 'quantity')::numeric, f ->> 'unit', (f ->> 'unit_price')::numeric, f ->> 'currency',
      f ->> 'price_basis', (f ->> 'due_date')::date, f ->> 'due_text', f ->> 'reference',
      f ->> 'summary', f ->> 'evidence_quote', (f ->> 'confidence')::numeric,
      case when cardinality(v_reasons) > 0 then 'needs_review' else 'auto' end, v_reasons, v_model, v_prompt)
    returning id into v_id;

    -- An update to an earlier open fact: explicit closes it, inferred sends it to review.
    if v_prev.id is not null and f ->> 'status' in ('resolved', 'cancelled') and v_prev.status = 'open' then
      update private.customer_facts
         set status = f ->> 'status',
             status_basis = f ->> 'status_basis',
             review_state = case when f ->> 'status_basis' = 'inferred' and review_state = 'auto' then 'needs_review' else review_state end,
             review_reasons = case when f ->> 'status_basis' = 'inferred'
                                   then array(select distinct r from unnest(review_reasons || array['inferred_status']) r order by r)
                                   else review_reasons end
       where id = v_prev.id;
    end if;
   exception when others then
    raise exception 'fact % rejected by a database check (%)', v_n, sqlstate using errcode = sqlstate;
   end;
    v_n := v_n + 1;
  end loop;

  update private.extraction_state
     set status = 'extracted', lease_until = null, model = v_model, prompt_version = v_prompt,
         facts_count = v_n, last_error = null, updated_at = now()
   where owner_id = p_owner and gmail_message_id = p_message;
  return v_n;
end;
$$;

create or replace function private.worker_extract_skip(p_owner uuid, p_message text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.extraction_state
     set status = 'skipped', skip_reason = p_reason, lease_until = null, updated_at = now()
   where owner_id = p_owner and gmail_message_id = p_message and status = 'claimed';
  if not found then
    raise exception 'message not claimed' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.worker_extract_fail(p_owner uuid, p_message text, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  update private.extraction_state
     set attempts = attempts + 1,
         status = case when attempts + 1 >= 3 then 'failed' else 'pending' end,
         next_attempt_at = case when attempts + 1 >= 3 then null else now() + make_interval(mins => 15 * (attempts + 1)) end,
         last_error = left(coalesce(p_code, 'unknown'), 64), lease_until = null, updated_at = now()
   where owner_id = p_owner and gmail_message_id = p_message and status = 'claimed'
  returning status into v_status;
  if v_status is null then
    raise exception 'message not claimed' using errcode = '55000';
  end if;
  return v_status;
end;
$$;

-- Returns a claimed item to the queue without counting an attempt (used when
-- the budget stops a run before the item was processed).
create or replace function private.worker_extract_release(p_owner uuid, p_message text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.extraction_state
     set status = 'pending', lease_until = null, updated_at = now()
   where owner_id = p_owner and gmail_message_id = p_message and status = 'claimed'
$$;

-- Retention: rejected facts after 30 days, usage rows after 13 months.
create or replace function private.worker_extract_cleanup()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n1 integer;
  n2 integer;
begin
  perform private.budget_prepare();
  delete from private.customer_facts where review_state = 'rejected' and reviewed_at < now() - interval '30 days';
  get diagnostics n1 = row_count;
  delete from private.ai_usage where month < (private.budget_month() - interval '13 months');
  get diagnostics n2 = row_count;
  return n1 + n2;
end;
$$;

-- ---------------------------------------------------------------------------
-- Employees: search and inspect facts
-- ---------------------------------------------------------------------------

-- Who may see a fact: its mailbox owner and admins always; everyone else only
-- checked facts, and only once facts_visibility = 'all'. Rejected: nobody here.
create or replace function private.can_see_fact(p_owner uuid, p_review text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_user() and (
    (p_review in ('auto', 'confirmed', 'corrected')
      and (p_owner = auth.uid() or private.is_admin()
           or coalesce((select value from private.settings where key = 'facts_visibility'), 'reviewers') = 'all'))
    or (p_review = 'needs_review' and (p_owner = auth.uid() or private.is_admin())))
$$;
create or replace function public.facts_search(
  p_query     text        default null,
  p_customer  uuid        default null,
  p_type      text        default null,
  p_status    text        default null,
  p_from      date        default null,
  p_to        date        default null,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid        default null,
  p_limit     integer     default 50,
  p_stance    text        default null,
  p_review    text        default null
)
returns table (
  fact_id uuid, customer_id uuid, customer_name text, fact_type text, stance text, party text, basis text,
  status text, status_basis text, stale boolean, resolves_fact_id uuid,
  product text, quantity numeric, unit text, unit_price numeric, currency text, price_basis text,
  due_date date, due_text text, reference text, summary text, evidence_quote text, confidence numeric,
  review_state text, message_at timestamptz, direction text, is_mine boolean, source_owner_email text,
  gmail_message_id text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_show  boolean := coalesce((select value from private.settings where key = 'facts_show_source_owner'), 'off') = 'on';
  v_raw   text := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_like  text;
begin
  if v_uid is null or not private.is_active_user() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_raw is not null and (length(v_raw) < 2 or length(v_raw) > 100) then
    raise exception 'search text must be 2 to 100 characters' using errcode = '22023';
  end if;
  if p_type is not null and p_type not in ('requirement', 'order', 'pricing', 'delivery', 'quality_issue', 'follow_up') then
    raise exception 'unknown fact type' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('open', 'resolved', 'cancelled', 'not_applicable', 'unknown') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  if p_stance is not null and p_stance not in ('request', 'proposal', 'commitment', 'report', 'cancellation') then
    raise exception 'unknown stance' using errcode = '22023';
  end if;
  if p_review is not null and p_review not in ('unreviewed', 'needs_review', 'reviewed') then
    raise exception 'unknown review filter' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'from date is after to date' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'cursor needs both a time and an id' using errcode = '22023';
  end if;
  v_like := '%' || private.like_escape(coalesce(v_raw, '')) || '%';

  return query
  select f.id, f.customer_id, c.canonical_name, f.fact_type, f.stance, f.party, f.basis,
         f.status, f.status_basis,
         (f.status = 'open' and f.message_at < now() - interval '30 days'
          and not exists (select 1 from private.customer_facts g where g.resolves_fact_id = f.id)),
         f.resolves_fact_id,
         f.product, f.quantity, f.unit, f.unit_price, f.currency, f.price_basis,
         f.due_date, f.due_text, f.reference, f.summary, f.evidence_quote, f.confidence,
         f.review_state, f.message_at, f.direction, f.owner_id = v_uid,
         case when f.owner_id = v_uid or v_show then u.email end,
         case when f.owner_id = v_uid then f.gmail_message_id end
    from private.customer_facts f
    join public.customers c on c.id = f.customer_id
    join public.app_users u on u.id = f.owner_id
   where private.can_see_fact(f.owner_id, f.review_state)
     and (p_stance is null or f.stance = p_stance)
     and (p_review is null
          or (p_review = 'unreviewed' and f.review_state = 'auto')
          or (p_review = 'needs_review' and f.review_state = 'needs_review')
          or (p_review = 'reviewed' and f.review_state in ('confirmed', 'corrected')))
     and (p_customer is null or f.customer_id = p_customer)
     and (p_type is null or f.fact_type = p_type)
     and (p_status is null or f.status = p_status)
     and (p_from is null or f.message_at >= (p_from::timestamp at time zone 'UTC'))
     and (p_to is null or f.message_at < ((p_to + 1)::timestamp at time zone 'UTC'))
     and (v_raw is null
          or lower(f.summary) like v_like
          or lower(coalesce(f.product, '')) like v_like
          or lower(coalesce(f.reference, '')) like v_like
          or lower(coalesce(f.evidence_quote, '')) like v_like
          or c.normalized_name like '%' || private.like_escape(private.normalize_name(v_raw)) || '%')
     and (p_cursor_at is null or (f.message_at, f.id) < (p_cursor_at, p_cursor_id))
   order by f.message_at desc, f.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

-- ---------------------------------------------------------------------------
-- Review: mailbox owner and admins
-- ---------------------------------------------------------------------------
create or replace function public.facts_review_queue(p_limit integer default 100)
returns table (fact_id uuid, customer_id uuid, customer_name text, fact_type text, stance text, basis text, status text,
               status_basis text, summary text, evidence_quote text, confidence numeric,
               review_reasons text[], message_at timestamptz, is_mine boolean, gmail_message_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.customer_id, c.canonical_name, f.fact_type, f.stance, f.basis, f.status, f.status_basis, f.summary,
         f.evidence_quote, f.confidence, f.review_reasons, f.message_at, f.owner_id = auth.uid(),
         case when f.owner_id = auth.uid() then f.gmail_message_id end
    from private.customer_facts f
    join public.customers c on c.id = f.customer_id
   where f.review_state = 'needs_review' and private.is_active_user()
     and (f.owner_id = auth.uid() or private.is_admin())
   order by f.message_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

create or replace function public.fact_review(p_fact uuid, p_action text, p_changes jsonb default '{}'::jsonb,
                                              p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact private.customer_facts;
  v_key  text;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_fact from private.customer_facts where id = p_fact for update;
  if not found or not (v_fact.owner_id = auth.uid() or private.is_admin()) then
    raise exception 'fact not found' using errcode = 'P0002';
  end if;
  if p_action not in ('confirm', 'reject', 'correct') then
    raise exception 'action must be confirm, reject or correct' using errcode = '22023';
  end if;
  if p_note is not null and length(p_note) > 300 then
    raise exception 'note is limited to 300 characters' using errcode = '22023';
  end if;

  begin
  if p_action = 'correct' then
    for v_key in select jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) loop
      if v_key not in ('fact_type', 'stance', 'status', 'product', 'quantity', 'unit', 'unit_price', 'currency',
                       'due_date', 'summary') then
        raise exception 'field % cannot be corrected', v_key using errcode = '22023';
      end if;
    end loop;
    update private.customer_facts set
      fact_type  = coalesce(p_changes ->> 'fact_type', fact_type),
      stance     = coalesce(p_changes ->> 'stance', stance),
      -- A person confirming a commitment makes it explicit.
      basis      = case when coalesce(p_changes ->> 'stance', stance) = 'commitment' then 'explicit' else basis end,
      status     = coalesce(p_changes ->> 'status', status),
      status_basis = case when p_changes ? 'status'
                          then case when p_changes ->> 'status' in ('unknown', 'not_applicable') then 'none' else 'explicit' end
                          else status_basis end,
      product    = case when p_changes ? 'product' then p_changes ->> 'product' else product end,
      quantity   = case when p_changes ? 'quantity' then (p_changes ->> 'quantity')::numeric else quantity end,
      unit       = case when p_changes ? 'unit' then p_changes ->> 'unit' else unit end,
      unit_price = case when p_changes ? 'unit_price' then (p_changes ->> 'unit_price')::numeric else unit_price end,
      currency   = case when p_changes ? 'currency' then p_changes ->> 'currency' else currency end,
      due_date   = case when p_changes ? 'due_date' then (p_changes ->> 'due_date')::date else due_date end,
      summary    = coalesce(p_changes ->> 'summary', summary),
      review_state = 'corrected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
     where id = p_fact;
  else
    update private.customer_facts
       set review_state = case p_action when 'confirm' then 'confirmed' else 'rejected' end,
           reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
     where id = p_fact;
  end if;
  exception
    when sqlstate '22023' then raise;  -- our own messages carry no values
    when others then
      raise exception 'correction rejected by a database check (%)', sqlstate using errcode = sqlstate;
  end;

  insert into public.audit_log (actor, action, target)
  values (auth.uid(), 'fact.' || p_action, p_fact::text);
end;
$$;

-- Customers that have facts the caller may see, with counts (customer filter and overview).
create or replace function public.facts_customers()
returns table (customer_id uuid, customer_name text, facts integer, open_facts integer, needs_review integer, last_fact_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.canonical_name, count(*)::int,
         count(*) filter (where f.status = 'open')::int,
         count(*) filter (where f.review_state = 'needs_review')::int,
         max(f.message_at)
    from private.customer_facts f
    join public.customers c on c.id = f.customer_id
   where private.can_see_fact(f.owner_id, f.review_state)
   group by c.id, c.canonical_name
   order by max(f.message_at) desc
$$;

-- The caller's own extraction progress (counts only).
create or replace function public.my_extraction_status()
returns table (pending integer, extracted integer, skipped integer, failed integer, needs_reconnect integer,
               facts integer, facts_needs_review integer)
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*)::int from private.extraction_state where owner_id = auth.uid() and status in ('pending', 'claimed')),
         (select count(*)::int from private.extraction_state where owner_id = auth.uid() and status = 'extracted'),
         (select count(*)::int from private.extraction_state where owner_id = auth.uid() and status = 'skipped'),
         (select count(*)::int from private.extraction_state where owner_id = auth.uid() and status = 'failed'),
         (select count(*)::int from private.extraction_state where owner_id = auth.uid() and status = 'needs_reconnect'),
         (select count(*)::int from private.customer_facts where owner_id = auth.uid()),
         (select count(*)::int from private.customer_facts where owner_id = auth.uid() and review_state = 'needs_review')
   where private.is_active_user()
$$;

-- ---------------------------------------------------------------------------
-- Admin: budget and progress (counts only)
-- ---------------------------------------------------------------------------

-- Error codes of failed or retrying items (codes only; no mailbox, message or content).
create or replace function public.extraction_failures()
returns table (code text, failed integer, retrying integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
  select coalesce(last_error, 'unknown'),
         count(*) filter (where status = 'failed')::int,
         count(*) filter (where status = 'pending' and attempts > 0)::int
    from private.extraction_state
   where status = 'failed' or (status = 'pending' and attempts > 0)
   group by 1
   order by 2 desc, 3 desc;
end;
$$;

-- Sends every failed item back to the queue (after a fix). Audited.
create or replace function public.extraction_retry_failed()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform private.require_admin();
  update private.extraction_state
     set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
   where status = 'failed';
  get diagnostics n = row_count;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'extract.retry_failed', null, jsonb_build_object('items', n));
  return n;
end;
$$;
create or replace function public.extraction_overview()
returns table (month date, cap_usd numeric, spent_usd numeric, reserved_usd numeric, paused boolean,
               pending integer, extracted integer, skipped integer, failed integer, needs_reconnect integer,
               facts_auto integer, facts_needs_review integer, facts_reviewed integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
  select private.budget_month(),
         coalesce(b.cap_microusd, round(coalesce(nullif((select value from private.settings where key = 'extract_monthly_cap_usd'), '')::numeric, 0) * 1000000)::bigint) / 1000000.0,
         coalesce(b.spent_microusd, 0) / 1000000.0,
         coalesce(b.reserved_microusd, 0) / 1000000.0,
         b.paused_at is not null,
         (select count(*)::int from private.extraction_state where status in ('pending', 'claimed')),
         (select count(*)::int from private.extraction_state where status = 'extracted'),
         (select count(*)::int from private.extraction_state where status = 'skipped'),
         (select count(*)::int from private.extraction_state where status = 'failed'),
         (select count(*)::int from private.extraction_state where status = 'needs_reconnect'),
         (select count(*)::int from private.customer_facts where review_state = 'auto'),
         (select count(*)::int from private.customer_facts where review_state = 'needs_review'),
         (select count(*)::int from private.customer_facts where review_state in ('confirmed', 'corrected'))
    from (select 1) one
    left join private.ai_budget b on b.month = private.budget_month();
end;
$$;

-- Changing the cap is audited. Raising it above what is spent and reserved lifts the pause.
create or replace function public.extraction_set_cap(p_usd numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.ai_budget;
begin
  perform private.require_admin();
  if p_usd is null or p_usd < 0 or p_usd > 500 then
    raise exception 'cap must be between 0 and 500 USD' using errcode = '22023';
  end if;
  update private.settings set value = p_usd::text where key = 'extract_monthly_cap_usd';
  v_row := private.budget_prepare();
  update private.ai_budget
     set cap_microusd = round(p_usd * 1000000),
         paused_at = case when round(p_usd * 1000000) > spent_microusd + reserved_microusd then null else coalesce(paused_at, now()) end
   where month = v_row.month;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'extract.cap_changed', v_row.month::text, jsonb_build_object('cap_usd', p_usd));
end;
$$;

-- ---------------------------------------------------------------------------
-- Gmail connection: accept gmail.readonly (Stage B, requested only when the app
-- runs with GMAIL_CONTENT_ACCESS=on) as well as gmail.metadata. Same function
-- as migration 0004 otherwise.
-- ---------------------------------------------------------------------------
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
  if p_scopes is null or not (p_scopes && array['https://www.googleapis.com/auth/gmail.metadata', private.readonly_scope()]) then
    raise exception 'gmail.metadata or gmail.readonly scope missing' using errcode = '22023';
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function private.extract_allowed(text), private.readonly_scope(), private.budget_month(),
                       private.budget_prepare(), private.fact_review_reasons(text, text, text, text, numeric, text[]),
                       private.on_message_link_added(), private.on_message_link_removed(), private.on_gmail_scopes_changed()
  from public;

revoke all on function private.worker_budget_reserve(bigint), private.worker_budget_settle(uuid, jsonb),
                       private.worker_extract_claim(integer, integer), private.worker_extract_token(uuid),
                       private.worker_extract_context(uuid, text), private.worker_extract_commit(uuid, text, jsonb, jsonb),
                       private.worker_extract_skip(uuid, text, text), private.worker_extract_fail(uuid, text, text),
                       private.worker_extract_release(uuid, text), private.worker_extract_cleanup()
  from public, anon, authenticated;
grant execute on function private.worker_budget_reserve(bigint), private.worker_budget_settle(uuid, jsonb),
                          private.worker_extract_claim(integer, integer), private.worker_extract_token(uuid),
                          private.worker_extract_context(uuid, text), private.worker_extract_commit(uuid, text, jsonb, jsonb),
                          private.worker_extract_skip(uuid, text, text), private.worker_extract_fail(uuid, text, text),
                          private.worker_extract_release(uuid, text), private.worker_extract_cleanup()
  to c360_worker;

revoke execute on function public.facts_search(text, uuid, text, text, date, date, timestamptz, uuid, integer, text, text),
                           public.facts_review_queue(integer), public.fact_review(uuid, text, jsonb, text),
                           public.extraction_overview(), public.extraction_set_cap(numeric),
                           public.facts_customers(), public.my_extraction_status(),
                           public.extraction_failures(), public.extraction_retry_failed()
  from public, anon;
grant execute on function public.facts_search(text, uuid, text, text, date, date, timestamptz, uuid, integer, text, text),
                          public.facts_review_queue(integer), public.fact_review(uuid, text, jsonb, text),
                          public.extraction_overview(), public.extraction_set_cap(numeric),
                          public.facts_customers(), public.my_extraction_status(),
                          public.extraction_failures(), public.extraction_retry_failed()
  to authenticated;
revoke all on function private.can_see_fact(uuid, text) from public;
