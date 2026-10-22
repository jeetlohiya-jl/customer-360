-- Migration 0012: clear the review queue of names that are obviously one customer.
--
-- Matching rules m2 (lib/customers/matcher.ts) now link these directly:
--   * the same name with spaces removed or added  ("taylorfarms" = "Taylor Farms")
--   * a plural or possessive "s" on the last word  ("loblaws" = "Loblaw")
--   * a sender domain that IS the customer's name  ("premiofoods.com" = "Premio Foods")
-- when exactly one customer has that name. New email is matched this way from
-- the next deploy. This function settles the items already waiting under the
-- old rules exactly as an admin's "Same customer" would (alias + links), and
-- leaves every other item for a person. Run once: select * from private.resolve_obvious_reviews();
--
-- Reverse: supabase/rollback/20261023000012_obvious_name_matches.down.sql
-- (removes the function; aliases and links it created stay, as with manual decisions).

create or replace function private.resolve_obvious_reviews()
returns table (observed text, customer_name text, messages_linked integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item     private.review_items;
  v_customer uuid;
  v_n        integer;
  v_owners   integer;
begin
  for v_item in
    select * from private.review_items ri
     where ri.reason = 'possible spelling variation'
       and jsonb_array_length(ri.candidates) = 1
     order by ri.observed_normalized
     for update
  loop
    -- Every active customer whose name or alias is the same letters, or the same words with a plural "s".
    with names as (
      select c.id, c.normalized_name as n from public.customers c where c.status = 'active'
      union
      select c.id, a.normalized from public.customer_aliases a join public.customers c on c.id = a.customer_id and c.status = 'active'
    )
    select count(distinct id), min(id::text)::uuid into v_owners, v_customer
      from names
     where (replace(n, ' ', '') = replace(v_item.observed_normalized, ' ', '') and length(replace(n, ' ', '')) >= 6)
        or (length(n) >= 5 and (n || 's' = v_item.observed_normalized or v_item.observed_normalized || 's' = n));

    continue when v_owners <> 1
               or v_customer::text <> (v_item.candidates -> 0 ->> 'customer_id');

    perform private.add_alias(v_customer, v_item.observed, 'alias', 'review');
    insert into private.message_links (owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at,
                                       direction, customer_addresses, evidence, score, rules_version, link_status, job_id)
    select o.owner_id, v_customer, o.gmail_message_id, o.gmail_thread_id, o.message_at, o.direction, '{}',
           jsonb_build_array(jsonb_build_object('type', 'm2_obvious_variant', 'value', v_item.observed_normalized)),
           0.97, 'm2', 'auto', o.job_id
      from private.review_occurrences o
     where o.review_item_id = v_item.id
    on conflict on constraint message_links_unique do nothing;
    get diagnostics v_n = row_count;
    delete from private.review_items where id = v_item.id;
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'review.auto_resolved', v_item.id::text, jsonb_build_object(
      'rule', 'm2_obvious_variant', 'customer', v_customer, 'name', v_item.observed_normalized, 'messages_linked', v_n));

    observed := v_item.observed;
    customer_name := (select canonical_name from public.customers where id = v_customer);
    messages_linked := v_n;
    return next;
  end loop;
  perform private.bump_alias_version();
end;
$$;

revoke all on function private.resolve_obvious_reviews() from public, anon, authenticated;
