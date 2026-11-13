-- Migration 0018: customer numbers ("metrics") read from customer emails.
--
-- Any number that describes a customer's business or needs: production and
-- throughput (lbs/week, birds/day), packaging usage (trays/month), requirements
-- and forecasts, order run-rate, spend / budget / target price, company size
-- (plants, stores, SKUs, revenue) and supplier situation. Extracted in the
-- SAME AI call as facts (prompt x7), checked like facts (the number must be in
-- the email, quotes verbatim, re-redacted, other companies' numbers dropped)
-- and stored with value, unit, period, scope, kind, who said it, the email
-- date and an evidence quote. No email text is stored.
--
-- Access: exactly the facts rules (private.can_see_fact): the mailbox owner and
-- admins always; colleagues only checked numbers and only when
-- facts_visibility = 'all'; numbers awaiting review: owner and admins only.
-- Deleting the message link deletes the number (same as facts).
--
-- Reverse: supabase/rollback/20261113000018_customer_metrics.down.sql

create table private.customer_metrics (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null,
  customer_id      uuid not null,
  gmail_message_id text not null,
  message_at       timestamptz not null,
  direction        text not null check (direction in ('inbound', 'outbound', 'internal')),
  metric_index     smallint not null check (metric_index between 0 and 14),
  category         text not null check (category in ('production', 'packaging_usage', 'requirement_forecast',
                                                     'order_volume', 'spend_price', 'company_size', 'supplier')),
  metric           text not null check (length(btrim(metric)) between 1 and 80),
  value            numeric(18, 4) not null check (value >= 0),
  value_max        numeric(18, 4) check (value_max is null or value_max >= value),
  unit             text check (length(unit) <= 30),
  currency         text check (currency ~ '^[A-Z]{3}$'),
  period           text not null check (period in ('day', 'week', 'month', 'quarter', 'year', 'shift', 'none')),
  scope            text check (length(scope) <= 80),
  kind             text not null check (kind in ('actual', 'capacity', 'forecast', 'target', 'estimate')),
  as_of            text check (as_of ~ '^[0-9]{4}(-[0-9]{2})?$'),
  party            text not null check (party in ('customer', 'cirkla', 'unclear')),
  summary          text not null check (length(btrim(summary)) between 1 and 300),
  evidence_quote   text check (length(evidence_quote) <= 200),
  confidence       numeric(3, 2) not null check (confidence between 0 and 1),
  review_state     text not null check (review_state in ('auto', 'needs_review', 'confirmed', 'rejected')),
  review_reasons   text[] not null default '{}' check (cardinality(review_reasons) <= 10),
  reviewed_by      uuid references public.app_users (id) on delete set null,
  reviewed_at      timestamptz,
  model            text not null check (length(model) <= 64),
  prompt_version   text not null check (length(prompt_version) <= 32),
  extracted_at     timestamptz not null default now(),
  constraint customer_metrics_link foreign key (owner_id, gmail_message_id, customer_id)
    references private.message_links (owner_id, gmail_message_id, customer_id) on delete cascade,
  constraint customer_metrics_position unique (owner_id, gmail_message_id, customer_id, metric_index),
  constraint customer_metrics_price_currency check (category <> 'spend_price' or unit is not null or currency is not null)
);

create index customer_metrics_customer_time on private.customer_metrics (customer_id, message_at desc);
revoke all on private.customer_metrics from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Worker: store one email's numbers (called while the email is still claimed,
-- just before worker_extract_commit). Re-extraction replaces them.
-- ---------------------------------------------------------------------------
create or replace function private.worker_extract_metrics(p_owner uuid, p_message text, p_meta jsonb, p_metrics jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state  private.extraction_state;
  v_link   private.message_links;
  m        jsonb;
  v_n      integer := 0;
  v_model  text := left(p_meta ->> 'model', 64);
  v_prompt text := left(p_meta ->> 'prompt_version', 32);
  v_reasons text[];
begin
  select * into v_state from private.extraction_state
   where owner_id = p_owner and gmail_message_id = p_message for update;
  if not found or v_state.status <> 'claimed' or v_state.lease_until < now() then
    raise exception 'message not claimed' using errcode = '55000';
  end if;
  if jsonb_typeof(p_metrics) <> 'array' or jsonb_array_length(p_metrics) > 15 then
    raise exception 'metrics must be an array of at most 15' using errcode = '22023';
  end if;
  if v_model is null or v_prompt is null then
    raise exception 'model and prompt_version required' using errcode = '22023';
  end if;

  delete from private.customer_metrics where owner_id = p_owner and gmail_message_id = p_message;

  for m in select value from jsonb_array_elements(p_metrics) loop
   -- Failures are re-raised WITHOUT the row's values (no email-derived text in errors or server logs).
   begin
    select * into v_link from private.message_links
     where owner_id = p_owner and gmail_message_id = p_message and customer_id = (m ->> 'customer_id')::uuid;
    if not found then
      raise exception 'metric customer is not linked to this message' using errcode = '22023';
    end if;
    v_reasons := coalesce(array(select jsonb_array_elements_text(m -> 'review_reasons')), '{}');
    if (m ->> 'confidence')::numeric < 0.5 and not 'low_confidence' = any (v_reasons) then
      v_reasons := array_append(v_reasons, 'low_confidence');
    end if;
    insert into private.customer_metrics (owner_id, customer_id, gmail_message_id, message_at, direction, metric_index,
      category, metric, value, value_max, unit, currency, period, scope, kind, as_of, party, summary, evidence_quote,
      confidence, review_state, review_reasons, model, prompt_version)
    values (p_owner, v_link.customer_id, p_message, v_link.message_at, v_link.direction, (m ->> 'metric_index')::smallint,
      m ->> 'category', m ->> 'metric', (m ->> 'value')::numeric, (m ->> 'value_max')::numeric, m ->> 'unit', m ->> 'currency',
      m ->> 'period', m ->> 'scope', m ->> 'kind', m ->> 'as_of', m ->> 'party', m ->> 'summary', m ->> 'evidence_quote',
      (m ->> 'confidence')::numeric,
      case when cardinality(v_reasons) = 0 then 'auto' else 'needs_review' end, v_reasons[1:10], v_model, v_prompt);
    v_n := v_n + 1;
   exception when others then
    raise exception 'metric % rejected by a database check (%)', coalesce(m ->> 'metric_index', '?'), sqlstate using errcode = '22023';
   end;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- People: read and review numbers (same visibility as facts)
-- ---------------------------------------------------------------------------
create or replace function public.customer_metrics(p_customer uuid default null, p_category text default null, p_limit integer default 300)
returns table (
  metric_id uuid, customer_id uuid, customer_name text, category text, metric text, value numeric, value_max numeric,
  unit text, currency text, period text, scope text, kind text, as_of text, party text, summary text,
  evidence_quote text, confidence numeric, review_state text, message_at timestamptz, direction text,
  is_mine boolean, gmail_message_id text, mailbox_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean := private.is_admin();
  v_all   boolean := coalesce((select s.value from private.settings s where s.key = 'facts_visibility'), 'reviewers') = 'all';
begin
  if v_uid is null or not private.is_active_user() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_category is not null and p_category not in ('production', 'packaging_usage', 'requirement_forecast', 'order_volume',
                                                    'spend_price', 'company_size', 'supplier') then
    raise exception 'unknown category' using errcode = '22023';
  end if;
  return query
  select m.id, m.customer_id, c.canonical_name, m.category, m.metric, m.value, m.value_max, m.unit, m.currency, m.period,
         m.scope, m.kind, m.as_of, m.party, m.summary, m.evidence_quote, m.confidence, m.review_state, m.message_at,
         m.direction, m.owner_id = v_uid,
         case when m.owner_id = v_uid then m.gmail_message_id end,
         case when m.owner_id = v_uid then g.mailbox_email end
    from private.customer_metrics m
    join public.customers c on c.id = m.customer_id
    left join private.gmail_connections g on g.user_id = m.owner_id
   where (p_customer is null or m.customer_id = p_customer)
     and (p_category is null or m.category = p_category)
     and ((m.review_state in ('auto', 'confirmed') and (m.owner_id = v_uid or v_admin or v_all))
          or (m.review_state = 'needs_review' and (m.owner_id = v_uid or v_admin)))
   order by c.canonical_name, m.message_at desc, m.metric_index
   limit least(greatest(coalesce(p_limit, 300), 1), 1000);
end;
$$;

-- Owner or admin: confirm or reject a number. Rejected numbers are hidden.
create or replace function public.metric_review(p_metric uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if not private.is_active_user() then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_action not in ('confirm', 'reject') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  select owner_id into v_owner from private.customer_metrics where id = p_metric for update;
  if not found then
    raise exception 'number not found' using errcode = 'P0002';
  end if;
  if v_owner <> auth.uid() and not private.is_admin() then
    raise exception 'only the mailbox owner or an admin can review this number' using errcode = '42501';
  end if;
  update private.customer_metrics
     set review_state = case when p_action = 'confirm' then 'confirmed' else 'rejected' end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_metric;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'metric.reviewed', p_metric::text, jsonb_build_object('decision', p_action));
end;
$$;

-- ---------------------------------------------------------------------------
-- Slack: the numbers a named person may see, for the customers asked about
-- ---------------------------------------------------------------------------
create or replace function private.worker_slack_metrics(p_user uuid, p_customers uuid[], p_limit integer)
returns table (
  metric_id uuid, customer_id uuid, customer_name text, category text, metric text, value numeric, value_max numeric,
  unit text, currency text, period text, scope text, kind text, as_of text, party text, summary text,
  evidence_quote text, confidence numeric, review_state text, message_at timestamptz, direction text
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select u.id, u.role = 'admin' as admin,
           coalesce((select value from private.settings where key = 'facts_visibility'), 'reviewers') = 'all' as see_all
      from public.app_users u where u.id = p_user and u.status = 'active'
  )
  select m.id, m.customer_id, c.canonical_name, m.category, m.metric, m.value, m.value_max, m.unit, m.currency, m.period,
         m.scope, m.kind, m.as_of, m.party, m.summary, m.evidence_quote, m.confidence, m.review_state, m.message_at, m.direction
    from private.customer_metrics m
    join public.customers c on c.id = m.customer_id
    cross join me
   where m.customer_id = any (coalesce(p_customers, '{}'))
     and cardinality(p_customers) between 1 and 5
     and ((m.review_state in ('auto', 'confirmed') and (m.owner_id = me.id or me.admin or me.see_all))
          or (m.review_state = 'needs_review' and (m.owner_id = me.id or me.admin)))
   order by m.message_at desc, m.metric_index
   limit least(greatest(coalesce(p_limit, 60), 1), 200)
$$;

revoke all on function private.worker_extract_metrics(uuid, text, jsonb, jsonb), private.worker_slack_metrics(uuid, uuid[], integer)
  from public, anon, authenticated;
grant execute on function private.worker_extract_metrics(uuid, text, jsonb, jsonb), private.worker_slack_metrics(uuid, uuid[], integer)
  to c360_worker;
revoke execute on function public.customer_metrics(uuid, text, integer), public.metric_review(uuid, text) from public, anon;
grant execute on function public.customer_metrics(uuid, text, integer), public.metric_review(uuid, text) to authenticated;
