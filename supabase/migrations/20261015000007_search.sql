-- Stage 3.2: search over customer-linked email references (header data only).
--
-- What can be searched: the customer (name, aliases, verified domains and
-- approved addresses from the customer list) and the customer-side addresses
-- stored on each link. Email subjects, bodies and snippets are NOT stored
-- (CS3), so they cannot be searched.
--
-- Access (unchanged from Stage 3.1):
--   * Employees: only links from their OWN mailbox. Enforced here with
--     auth.uid(); the app cannot pass another user's id. A mailbox filter for
--     any mailbox other than the caller's own returns nothing.
--   * Admins: aggregate counts per customer only (no message ids, addresses
--     or links), and no per-mailbox breakdown (decision 2026-10-13).
--
-- Adds functions and one index only. No table, column or data changes.
-- Reverse: supabase/rollback/20261015000007_search.down.sql

-- Keyset pagination needs a stable order: newest first, then id.
create index if not exists message_links_owner_time_id
  on private.message_links (owner_id, message_at desc, id desc);

-- Escapes LIKE wildcards so user text is matched literally.
create or replace function private.like_escape(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- ---------------------------------------------------------------------------
-- Employee search: own mailbox only
-- ---------------------------------------------------------------------------
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
  if p_direction is not null and p_direction not in ('inbound', 'outbound') then
    raise exception 'direction must be inbound or outbound' using errcode = '22023';
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

comment on function public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer) is
  'Stage 3.2. Caller''s own customer-linked email references. Keyword matches customer list data and stored contact addresses only; no email content exists to search.';

-- Customers that appear in the caller's own links (for the customer filter).
-- Employees cannot read the customer list itself; this reveals nothing beyond
-- what their own links already show.
create or replace function public.my_linked_customers()
returns table (customer_id uuid, customer_name text, link_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.canonical_name, count(*)::int
    from private.message_links l
    join public.customers c on c.id = l.customer_id
   where l.owner_id = auth.uid() and private.is_active_user()
   group by c.id, c.canonical_name
   order by c.canonical_name
$$;

-- ---------------------------------------------------------------------------
-- Admin oversight: aggregate counts per customer across all mailboxes.
-- No message ids, addresses, dates of individual emails, or mailbox split.
-- ---------------------------------------------------------------------------
create or replace function public.admin_link_counts(
  p_query    text    default null,
  p_customer uuid    default null,
  p_from     date    default null,
  p_to       date    default null,
  p_limit    integer default 100,
  p_offset   integer default 0
)
returns table (customer_id uuid, customer_name text, link_count integer, mailbox_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw  text := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_norm text;
begin
  perform private.require_admin();
  if v_raw is not null and (length(v_raw) < 2 or length(v_raw) > 100) then
    raise exception 'search text must be 2 to 100 characters' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'from date is after to date' using errcode = '22023';
  end if;
  v_norm := nullif(private.normalize_name(coalesce(v_raw, '')), '');

  return query
  select c.id, c.canonical_name, count(*)::int, count(distinct l.owner_id)::int
    from private.message_links l
    join public.customers c on c.id = l.customer_id
   where (p_customer is null or l.customer_id = p_customer)
     and (p_from is null or l.message_at >= (p_from::timestamp at time zone 'UTC'))
     and (p_to is null or l.message_at < ((p_to + 1)::timestamp at time zone 'UTC'))
     and (v_raw is null
          or (v_norm is not null and (' ' || c.normalized_name || ' ') like ('% ' || private.like_escape(v_norm) || '%'))
          or (v_norm is not null and exists (
                select 1 from public.customer_aliases a
                 where a.customer_id = c.id
                   and (' ' || a.normalized || ' ') like ('% ' || private.like_escape(v_norm) || '%')))
          or exists (
                select 1 from public.customer_identifiers i
                 where i.customer_id = c.id and i.value like ('%' || private.like_escape(v_raw) || '%')))
   group by c.id, c.canonical_name
   order by count(*) desc, c.canonical_name
   limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.admin_link_counts(text, uuid, date, date, integer, integer) is
  'Stage 3.2. Admin only. Counts per customer across all mailboxes; never message references or a per-mailbox split.';

revoke all on function private.like_escape(text) from public;
revoke execute on function public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer) from public, anon;
revoke execute on function public.my_linked_customers() from public, anon;
revoke execute on function public.admin_link_counts(text, uuid, date, date, integer, integer) from public, anon;
grant execute on function public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer) to authenticated;
grant execute on function public.my_linked_customers() to authenticated;
grant execute on function public.admin_link_counts(text, uuid, date, date, integer, integer) to authenticated;
