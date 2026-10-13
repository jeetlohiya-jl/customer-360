-- Stage 3.0: customer master, aliases, verified identifiers, review queue.
--
-- No Gmail access, no message data. Approved decisions: CS1 A, CS2 A, CS7 A
-- (admins review), CS8 A (worker role comes in Stage 3.1), CS12 (CSV import).
--
-- Access: admins only, through Row Level Security (read) and checked
-- security-definer functions (write). Every change writes an audit entry.
-- Reverse: supabase/rollback/20261013000005_customer_master.down.sql

-- Name normalization uses Unicode NFKD, which needs a UTF-8 database (Supabase is).
do $$
begin
  if pg_encoding_to_char(encoding) <> 'UTF8' from pg_database where datname = current_database() then
    raise exception 'this migration needs a UTF8 database';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Normalization (must match lib/customers/normalize.ts exactly; both are
-- tested against tests/fixtures/normalize-cases.json)
-- ---------------------------------------------------------------------------

create or replace function private.normalize_name(p text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text;
  t text[];
  n integer;
  single_suffixes constant text[] := array[
    'inc','incorporated','llc','ltd','limited','corp','corporation','co','company',
    'pvt','private','plc','gmbh','llp','lp','pte','pty','srl','spa','bv','nv',
    'ag','sa','sarl','oy','kk'];
begin
  if p is null then
    return null;
  end if;
  s := normalize(p, NFKD);
  s := regexp_replace(s, '[̀-ͯ]', '', 'g');
  s := lower(s);
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '[''’]', '', 'g');
  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');
  s := btrim(s);
  if s = '' then
    return '';
  end if;
  t := string_to_array(s, ' ');
  if array_length(t, 1) > 1 and t[1] = 'the' then
    t := t[2:];
  end if;
  loop
    n := array_length(t, 1);
    exit when n <= 1;
    if t[n] = any (single_suffixes) or t[n] = 'and' then
      t := t[1:n - 1];
      continue;
    end if;
    if n > 3 and array[t[n - 2], t[n - 1], t[n]]::text[] in (
         array['l','l','c'], array['l','l','p'], array['p','l','c'],
         array['l','t','d'], array['p','v','t'], array['p','t','e']) then
      t := t[1:n - 3];
      continue;
    end if;
    if n > 2 and array[t[n - 1], t[n]]::text[] in (
         array['s','a'], array['b','v'], array['n','v'], array['a','g']) then
      t := t[1:n - 2];
      continue;
    end if;
    exit;
  end loop;
  return array_to_string(t, ' ');
end;
$$;

create or replace function private.normalize_domain(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(btrim(p)), '^https?://', ''),
               '^@', ''),
             '^www\.', ''),
           '/.*$', ''),
         '\.$', '')
$$;

create or replace function private.is_valid_domain(p text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select length(p) between 1 and 253
     and p ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
$$;

-- Free-mail providers and Cirkla's own domain are never customer domains.
create or replace function private.is_blocked_customer_domain(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p = any (array[
      'gmail.com','googlemail.com','yahoo.com','yahoo.co.in','yahoo.co.uk','ymail.com','rocketmail.com',
      'outlook.com','hotmail.com','live.com','msn.com','icloud.com','me.com','mac.com','aol.com',
      'proton.me','protonmail.com','zoho.com','zohomail.com','gmx.com','gmx.net','mail.com',
      'yandex.com','rediffmail.com','qq.com','163.com'])
      or p = private.workspace_domain()
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null check (length(btrim(canonical_name)) between 1 and 200),
  normalized_name text generated always as (private.normalize_name(canonical_name)) stored,
  notes           text check (length(notes) <= 1000),
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_by      uuid references public.app_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_by      uuid references public.app_users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint customers_name_usable check (normalized_name <> ''),
  constraint customers_normalized_unique unique (normalized_name)
);

comment on table public.customers is
  'Authoritative customer list. Customers are never created from email; only by import or an admin.';

create table public.customer_aliases (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  alias       text not null check (length(btrim(alias)) between 1 and 200),
  kind        text not null check (kind in ('legal', 'trading', 'alias')),
  normalized  text generated always as (private.normalize_name(alias)) stored,
  source      text not null check (source in ('import', 'review', 'manual')),
  created_by  uuid references public.app_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint customer_aliases_usable check (normalized <> ''),
  -- One approved name belongs to exactly one customer.
  constraint customer_aliases_normalized_unique unique (normalized)
);

create index customer_aliases_customer on public.customer_aliases (customer_id);

create table public.customer_identifiers (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind        text not null check (kind in ('domain', 'email')),
  value       text not null,
  shared      boolean not null default false,
  verified    boolean not null default true,
  source      text not null check (source in ('import', 'review', 'manual')),
  created_by  uuid references public.app_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint customer_identifiers_unique unique (kind, value),
  constraint customer_identifiers_shared_domain_only check (kind = 'domain' or not shared),
  constraint customer_identifiers_format check (
    (kind = 'domain' and value = private.normalize_domain(value) and private.is_valid_domain(value))
    or (kind = 'email' and value = lower(btrim(value))
        and value ~ '^[^@[:space:]]{1,64}@[^@[:space:]]+$'
        and private.is_valid_domain(split_part(value, '@', 2))))
);

create index customer_identifiers_customer on public.customer_identifiers (customer_id);

create table public.customer_distinctions (
  customer_a uuid not null references public.customers (id) on delete cascade,
  customer_b uuid not null references public.customers (id) on delete cascade,
  decided_by uuid references public.app_users (id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (customer_a, customer_b),
  constraint customer_distinctions_ordered check (customer_a < customer_b)
);

comment on table public.customer_distinctions is
  'Pairs confirmed as different businesses; similar names between them are not proposed again.';

create table public.name_rejections (
  normalized text primary key check (normalized <> '' and length(normalized) <= 120),
  decided_by uuid references public.app_users (id) on delete set null,
  decided_at timestamptz not null default now()
);

comment on table public.name_rejections is
  'Normalized strings confirmed as "not a customer". Stores the normalized words only.';

-- Review queue: private (not reachable through the Data API), admin functions only.
create table private.review_items (
  id                  uuid primary key default gen_random_uuid(),
  observed            text not null check (length(observed) between 1 and 200),
  observed_normalized text not null check (observed_normalized <> '' and length(observed_normalized) <= 120),
  candidates          jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  reason              text not null check (length(reason) <= 120),
  source              text not null check (source in ('manual', 'gmail_scan')),
  occurrences         integer not null default 1 check (occurrences >= 1),
  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '30 days',
  created_by          uuid references public.app_users (id) on delete set null,
  constraint review_items_one_open_per_name unique (observed_normalized)
);

comment on table private.review_items is
  'Open uncertain matches. Holds the observed name only (no subject, sender or body). Deleted when decided or after 30 days.';

-- ---------------------------------------------------------------------------
-- Integrity triggers: a name can't belong to two customers across tables, and
-- blocked domains can't be stored.
-- ---------------------------------------------------------------------------

create or replace function private.customers_name_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.customer_aliases a
              where a.normalized = private.normalize_name(new.canonical_name)
                and a.customer_id <> new.id) then
    raise exception 'name "%" is already an alias of another customer', new.canonical_name using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger customers_name_guard
  before insert or update of canonical_name on public.customers
  for each row execute function private.customers_name_guard();

create or replace function private.aliases_name_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.customers c
              where c.normalized_name = private.normalize_name(new.alias)
                and c.id <> new.customer_id) then
    raise exception 'alias "%" is another customer''s name', new.alias using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger aliases_name_guard
  before insert or update of alias, customer_id on public.customer_aliases
  for each row execute function private.aliases_name_guard();

create or replace function private.identifiers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := case when new.kind = 'domain' then new.value else split_part(new.value, '@', 2) end;
begin
  if new.kind = 'domain' and private.is_blocked_customer_domain(v_domain) then
    raise exception '% cannot be a customer domain', v_domain using errcode = '22023';
  end if;
  if new.kind = 'email' and v_domain = private.workspace_domain() then
    raise exception 'a Cirkla address cannot be a customer address' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger identifiers_guard
  before insert or update on public.customer_identifiers
  for each row execute function private.identifiers_guard();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function private.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.bump_alias_version()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.meta set value = value + 1 where key = 'alias_ver'
$$;

-- Adds an alias unless the customer already has that name. Returns true if added.
create or replace function private.add_alias(p_customer uuid, p_alias text, p_kind text, p_source text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_norm  text := private.normalize_name(p_alias);
  v_owner uuid;
begin
  if v_norm is null or v_norm = '' then
    raise exception 'alias "%" has no letters or digits', p_alias using errcode = '22023';
  end if;
  if exists (select 1 from public.customers where id = p_customer and normalized_name = v_norm) then
    return false;
  end if;
  select customer_id into v_owner from public.customer_aliases where normalized = v_norm;
  if v_owner = p_customer then
    return false;
  elsif v_owner is not null then
    raise exception 'alias "%" already belongs to another customer', p_alias using errcode = '23505';
  end if;
  insert into public.customer_aliases (customer_id, alias, kind, source, created_by)
  values (p_customer, btrim(p_alias), p_kind, p_source, auth.uid());
  return true;
end;
$$;

-- Adds a domain or email unless the customer already has it. Returns true if added.
create or replace function private.add_identifier(p_customer uuid, p_kind text, p_value text, p_shared boolean, p_source text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value text := case when p_kind = 'domain' then private.normalize_domain(p_value) else lower(btrim(p_value)) end;
  v_owner uuid;
begin
  select customer_id into v_owner from public.customer_identifiers where kind = p_kind and value = v_value;
  if v_owner = p_customer then
    return false;
  elsif v_owner is not null then
    raise exception '% already belongs to another customer', v_value using errcode = '23505';
  end if;
  insert into public.customer_identifiers (customer_id, kind, value, shared, source, created_by)
  values (p_customer, p_kind, v_value, coalesce(p_shared, false) and p_kind = 'domain', p_source, auth.uid());
  return true;
end;
$$;

create or replace function private.mark_distinct(p_a uuid, p_b uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_a is null or p_b is null or p_a = p_b then
    raise exception 'two different customers are required' using errcode = '22023';
  end if;
  insert into public.customer_distinctions (customer_a, customer_b, decided_by)
  values (least(p_a, p_b), greatest(p_a, p_b), auth.uid())
  on conflict do nothing;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- CSV import (one transaction; any error rolls everything back)
-- ---------------------------------------------------------------------------

create or replace function public.import_customers(p_rows jsonb, p_file_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          jsonb;
  v_ref      integer;
  v_id       uuid;
  v_ids      jsonb := '{}'::jsonb;
  item       jsonb;
  v_created  integer := 0;
  v_updated  integer := 0;
  v_aliases  integer := 0;
  v_idents   integer := 0;
  v_distinct integer := 0;
begin
  perform private.require_admin();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'nothing to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'too many rows (max 5000)' using errcode = '22023';
  end if;
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid file checksum' using errcode = '22023';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_ref := (r ->> 'ref')::integer;
    begin
      if r ->> 'action' = 'create' then
        insert into public.customers (canonical_name, notes, status, created_by, updated_by)
        values (btrim(r ->> 'canonical_name'), nullif(r ->> 'notes', ''),
                coalesce(nullif(r ->> 'status', ''), 'active'), auth.uid(), auth.uid())
        returning id into v_id;
        v_created := v_created + 1;
      elsif r ->> 'action' = 'update' then
        v_id := (r ->> 'customer_id')::uuid;
        update public.customers
           set notes = coalesce(nullif(r ->> 'notes', ''), notes),
               status = coalesce(nullif(r ->> 'status', ''), status),
               updated_by = auth.uid(), updated_at = now()
         where id = v_id;
        if not found then
          raise exception 'customer to update was not found' using errcode = 'P0002';
        end if;
        v_updated := v_updated + 1;
      else
        raise exception 'unknown action' using errcode = '22023';
      end if;
      v_ids := v_ids || jsonb_build_object(v_ref::text, v_id);

      for item in select * from jsonb_array_elements(coalesce(r -> 'names', '[]'::jsonb)) loop
        if private.add_alias(v_id, item ->> 'value', item ->> 'kind', 'import') then
          v_aliases := v_aliases + 1;
        end if;
      end loop;
      for item in select * from jsonb_array_elements(coalesce(r -> 'domains', '[]'::jsonb)) loop
        if private.add_identifier(v_id, 'domain', item ->> 'value', (item ->> 'shared')::boolean, 'import') then
          v_idents := v_idents + 1;
        end if;
      end loop;
      for item in select * from jsonb_array_elements(coalesce(r -> 'emails', '[]'::jsonb)) loop
        if private.add_identifier(v_id, 'email', item #>> '{}', false, 'import') then
          v_idents := v_idents + 1;
        end if;
      end loop;
      for item in select * from jsonb_array_elements(coalesce(r -> 'distinct_from_customers', '[]'::jsonb)) loop
        if private.mark_distinct(v_id, (item #>> '{}')::uuid) then
          v_distinct := v_distinct + 1;
        end if;
      end loop;
    exception when others then
      raise exception 'line %: %', v_ref, sqlerrm using errcode = sqlstate;
    end;
  end loop;

  -- Pairs between rows of this file, now that every created row has an id.
  for r in select * from jsonb_array_elements(p_rows) loop
    for item in select * from jsonb_array_elements(coalesce(r -> 'distinct_from_refs', '[]'::jsonb)) loop
      if v_ids ? (item #>> '{}') and private.mark_distinct(
           (v_ids ->> (r ->> 'ref'))::uuid, (v_ids ->> (item #>> '{}'))::uuid) then
        v_distinct := v_distinct + 1;
      end if;
    end loop;
  end loop;

  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'customer.import', null, jsonb_build_object(
    'file_sha256', p_file_sha256, 'rows', jsonb_array_length(p_rows),
    'created', v_created, 'updated', v_updated, 'aliases_added', v_aliases,
    'identifiers_added', v_idents, 'distinctions_added', v_distinct));

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'aliases_added', v_aliases,
                            'identifiers_added', v_idents, 'distinctions_added', v_distinct);
end;
$$;

-- ---------------------------------------------------------------------------
-- Single edits (customer page)
-- ---------------------------------------------------------------------------

create or replace function public.customer_add_alias(p_customer uuid, p_alias text, p_kind text default 'alias')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_kind not in ('legal', 'trading', 'alias') then
    raise exception 'invalid alias kind' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where id = p_customer) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if private.add_alias(p_customer, p_alias, p_kind, 'manual') then
    perform private.bump_alias_version();
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'customer.alias_added', p_customer::text,
            jsonb_build_object('alias', left(btrim(p_alias), 200), 'kind', p_kind));
  end if;
end;
$$;

create or replace function public.customer_remove_alias(p_alias_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.customer_aliases;
begin
  perform private.require_admin();
  delete from public.customer_aliases where id = p_alias_id returning * into v_row;
  if not found then
    raise exception 'alias not found' using errcode = 'P0002';
  end if;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'customer.alias_removed', v_row.customer_id::text,
          jsonb_build_object('alias', v_row.alias, 'kind', v_row.kind, 'source', v_row.source));
end;
$$;

create or replace function public.customer_add_identifier(p_customer uuid, p_kind text, p_value text, p_shared boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_kind not in ('domain', 'email') then
    raise exception 'invalid identifier kind' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where id = p_customer) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if private.add_identifier(p_customer, p_kind, p_value, p_shared, 'manual') then
    perform private.bump_alias_version();
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'customer.identifier_added', p_customer::text,
            jsonb_build_object('kind', p_kind, 'value', left(lower(btrim(p_value)), 254), 'shared', coalesce(p_shared, false)));
  end if;
end;
$$;

create or replace function public.customer_remove_identifier(p_identifier_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.customer_identifiers;
begin
  perform private.require_admin();
  delete from public.customer_identifiers where id = p_identifier_id returning * into v_row;
  if not found then
    raise exception 'identifier not found' using errcode = 'P0002';
  end if;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'customer.identifier_removed', v_row.customer_id::text,
          jsonb_build_object('kind', v_row.kind, 'value', v_row.value));
end;
$$;

create or replace function public.customer_set_status(p_customer uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  perform private.require_admin();
  if p_status not in ('active', 'inactive') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select status into v_old from public.customers where id = p_customer for update;
  if not found then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if v_old = p_status then
    return;
  end if;
  update public.customers set status = p_status, updated_by = auth.uid(), updated_at = now() where id = p_customer;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'customer.status_changed', p_customer::text, jsonb_build_object('from', v_old, 'to', p_status));
end;
$$;

create or replace function public.customers_mark_distinct(p_a uuid, p_b uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if private.mark_distinct(p_a, p_b) then
    perform private.bump_alias_version();
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'customer.distinct_marked', least(p_a, p_b)::text,
            jsonb_build_object('other', greatest(p_a, p_b)));
  end if;
end;
$$;

create or replace function public.customers_unmark_distinct(p_a uuid, p_b uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  delete from public.customer_distinctions where customer_a = least(p_a, p_b) and customer_b = greatest(p_a, p_b);
  if found then
    perform private.bump_alias_version();
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'customer.distinct_removed', least(p_a, p_b)::text,
            jsonb_build_object('other', greatest(p_a, p_b)));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Review queue
-- ---------------------------------------------------------------------------

-- Adds (or counts again) an uncertain name. Stage 3.0 source: the admin name checker.
create or replace function public.review_queue_add(p_observed text, p_candidates jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_norm text := private.normalize_name(p_observed);
  v_id   uuid;
  v_cand jsonb;
begin
  perform private.require_admin();
  if v_norm is null or v_norm = '' or length(v_norm) > 120 then
    raise exception 'observed name is empty or too long' using errcode = '22023';
  end if;
  if exists (select 1 from public.name_rejections where normalized = v_norm) then
    return null; -- already decided: not a customer
  end if;
  if exists (select 1 from public.customer_aliases where normalized = v_norm)
     or exists (select 1 from public.customers where normalized_name = v_norm) then
    return null; -- already an approved name
  end if;
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 5 then
    raise exception 'candidates must be a list of at most 5' using errcode = '22023';
  end if;
  -- Keep only candidate fields we expect, and only customers that exist.
  select coalesce(jsonb_agg(jsonb_build_object(
           'customer_id', c.id,
           'score', least(greatest(coalesce((e ->> 'score')::numeric, 0), 0), 1),
           'evidence', left(coalesce(e ->> 'evidence', ''), 16))), '[]'::jsonb)
    into v_cand
    from jsonb_array_elements(p_candidates) e
    join public.customers c on c.id = (e ->> 'customer_id')::uuid;

  insert into private.review_items as ri (observed, observed_normalized, candidates, reason, source, created_by)
  values (left(btrim(p_observed), 200), v_norm, v_cand, left(coalesce(p_reason, ''), 120), 'manual', auth.uid())
  on conflict (observed_normalized) do update
     set occurrences = ri.occurrences + 1,
         last_seen = now(),
         candidates = excluded.candidates,
         expires_at = now() + interval '30 days'
  returning id into v_id;

  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'review.queued', v_id::text, jsonb_build_object('source', 'manual'));
  return v_id;
end;
$$;

create or replace function public.review_queue_list(p_limit integer default 100)
returns table (id uuid, observed text, candidates jsonb, reason text, occurrences integer,
               first_seen timestamptz, last_seen timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  delete from private.review_items ri where ri.expires_at < now();
  return query
    select ri.id, ri.observed, ri.candidates, ri.reason, ri.occurrences, ri.first_seen, ri.last_seen, ri.expires_at
      from private.review_items ri
     order by ri.occurrences desc, ri.last_seen desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- Decides one item. same_customer -> approved alias; not_a_customer -> rejection.
-- The item is deleted either way: the alias or rejection plus the audit entry
-- record the outcome, and no observed text lingers.
create or replace function public.review_resolve(p_item uuid, p_action text, p_customer uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item private.review_items;
begin
  perform private.require_admin();
  select * into v_item from private.review_items where id = p_item for update;
  if not found then
    raise exception 'review item not found' using errcode = 'P0002';
  end if;

  if p_action = 'same_customer' then
    if p_customer is null or not exists (select 1 from public.customers where id = p_customer) then
      raise exception 'choose an existing customer' using errcode = '22023';
    end if;
    perform private.add_alias(p_customer, v_item.observed, 'alias', 'review');
  elsif p_action = 'not_a_customer' then
    insert into public.name_rejections (normalized, decided_by)
    values (v_item.observed_normalized, auth.uid())
    on conflict do nothing;
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;

  delete from private.review_items where id = p_item;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'review.resolved', p_item::text, jsonb_build_object(
    'decision', p_action, 'customer', p_customer, 'name', v_item.observed_normalized));
end;
$$;

create or replace function public.name_rejection_remove(p_normalized text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  delete from public.name_rejections where normalized = p_normalized;
  if not found then
    raise exception 'rejection not found' using errcode = 'P0002';
  end if;
  perform private.bump_alias_version();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'review.rejection_removed', null, jsonb_build_object('name', p_normalized));
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------

alter table public.customers             enable row level security;
alter table public.customer_aliases      enable row level security;
alter table public.customer_identifiers  enable row level security;
alter table public.customer_distinctions enable row level security;
alter table public.name_rejections       enable row level security;

revoke all on public.customers, public.customer_aliases, public.customer_identifiers,
              public.customer_distinctions, public.name_rejections from public, anon;
revoke insert, update, delete, truncate, references, trigger
    on public.customers, public.customer_aliases, public.customer_identifiers,
       public.customer_distinctions, public.name_rejections from authenticated;
grant select on public.customers, public.customer_aliases, public.customer_identifiers,
                public.customer_distinctions, public.name_rejections to authenticated;

-- Stage 3.0: only active admins can read the customer master (CS7 A).
create policy customers_select_admin on public.customers for select to authenticated using (private.is_admin());
create policy customer_aliases_select_admin on public.customer_aliases for select to authenticated using (private.is_admin());
create policy customer_identifiers_select_admin on public.customer_identifiers for select to authenticated using (private.is_admin());
create policy customer_distinctions_select_admin on public.customer_distinctions for select to authenticated using (private.is_admin());
create policy name_rejections_select_admin on public.name_rejections for select to authenticated using (private.is_admin());

-- private.review_items: no grants at all (private schema).
revoke all on private.review_items from public, anon, authenticated;

-- Functions: nothing executable by default; admin entry points for signed-in users only.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_admin() to authenticated;

revoke execute on function public.import_customers(jsonb, text) from public, anon;
revoke execute on function public.customer_add_alias(uuid, text, text) from public, anon;
revoke execute on function public.customer_remove_alias(uuid) from public, anon;
revoke execute on function public.customer_add_identifier(uuid, text, text, boolean) from public, anon;
revoke execute on function public.customer_remove_identifier(uuid) from public, anon;
revoke execute on function public.customer_set_status(uuid, text) from public, anon;
revoke execute on function public.customers_mark_distinct(uuid, uuid) from public, anon;
revoke execute on function public.customers_unmark_distinct(uuid, uuid) from public, anon;
revoke execute on function public.review_queue_add(text, jsonb, text) from public, anon;
revoke execute on function public.review_queue_list(integer) from public, anon;
revoke execute on function public.review_resolve(uuid, text, uuid) from public, anon;
revoke execute on function public.name_rejection_remove(text) from public, anon;

grant execute on function public.import_customers(jsonb, text) to authenticated;
grant execute on function public.customer_add_alias(uuid, text, text) to authenticated;
grant execute on function public.customer_remove_alias(uuid) to authenticated;
grant execute on function public.customer_add_identifier(uuid, text, text, boolean) to authenticated;
grant execute on function public.customer_remove_identifier(uuid) to authenticated;
grant execute on function public.customer_set_status(uuid, text) to authenticated;
grant execute on function public.customers_mark_distinct(uuid, uuid) to authenticated;
grant execute on function public.customers_unmark_distinct(uuid, uuid) to authenticated;
grant execute on function public.review_queue_add(text, jsonb, text) to authenticated;
grant execute on function public.review_queue_list(integer) to authenticated;
grant execute on function public.review_resolve(uuid, text, uuid) to authenticated;
grant execute on function public.name_rejection_remove(text) to authenticated;
