-- Reverse of 20261026000015_performance.sql: the original (slower) forms.
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

alter policy app_users_select_self on public.app_users using (id = auth.uid() and private.is_active_user());
alter policy app_users_select_admin on public.app_users using (private.is_admin());
alter policy audit_log_select_admin on public.audit_log using (private.is_admin());
alter policy customers_select_admin on public.customers using (private.is_admin());
alter policy customer_aliases_select_admin on public.customer_aliases using (private.is_admin());
alter policy customer_identifiers_select_admin on public.customer_identifiers using (private.is_admin());
alter policy customer_distinctions_select_admin on public.customer_distinctions using (private.is_admin());
alter policy name_rejections_select_admin on public.name_rejections using (private.is_admin());
