-- Migration 0012: obvious variants in the review queue are settled; everything else waits for a person.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000012a1', 't12.ann@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c12a', 'T12 Taylorwood Farms'),
  ('00000000-0000-4000-8000-00000000c12b', 'T12 Loblawson'),
  ('00000000-0000-4000-8000-00000000c12c', 'T12 Acmeco Packaging');

create function pg_temp.item(p_observed text, p_customer text, p_reason text default 'possible spelling variation') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into private.review_items (observed, observed_normalized, candidates, reason, source)
  values (p_observed, private.normalize_name(p_observed),
          jsonb_build_array(jsonb_build_object('customer_id', p_customer, 'score', 0.97, 'evidence', 'E4')), p_reason, 'gmail_scan')
  returning id into v;
  insert into private.review_occurrences (review_item_id, owner_id, gmail_message_id, message_at, direction)
  values (v, '00000000-0000-4000-8000-0000000012a1', 'm12' || left(md5(p_observed), 8), now(), 'inbound');
  return v;
end $$;

select pg_temp.item('t12taylorwoodfarms', '00000000-0000-4000-8000-00000000c12a');   -- spacing only
select pg_temp.item('T12 Loblawsons', '00000000-0000-4000-8000-00000000c12b');       -- plural
select pg_temp.item('T12 Acmeco Packagng', '00000000-0000-4000-8000-00000000c12c');  -- a real typo
select pg_temp.item('T12 Loblawsons Two', '00000000-0000-4000-8000-00000000c12b');   -- different words

select ok(not has_function_privilege('authenticated', 'private.resolve_obvious_reviews()', 'execute'), 'clients cannot run the clean-up');
select is((select count(*) from private.resolve_obvious_reviews()), 2::bigint, 'two obvious variants are settled');
select is((select count(*) from private.review_items where observed like 'T12%' or observed like 't12%'), 2::bigint, 'the typo and the different name still wait for a person');
select is((select customer_id from private.message_links where gmail_message_id = 'm12' || left(md5('t12taylorwoodfarms'), 8)),
  '00000000-0000-4000-8000-00000000c12a'::uuid, 'the waiting email is linked to the customer');
select is((select count(*) from private.extraction_state where gmail_message_id = 'm12' || left(md5('T12 Loblawsons'), 8) and status = 'pending'),
  1::bigint, 'and queued for extraction');
select ok(exists (select 1 from public.customer_aliases where normalized = 't12taylorwoodfarms'), 'the variant becomes an alias, so it links directly from now on');
select ok(exists (select 1 from public.audit_log where action = 'review.auto_resolved'), 'each automatic decision is audited');

-- A name shared by two customers is never settled automatically.
insert into public.customers (id, canonical_name) values ('00000000-0000-4000-8000-00000000c12d', 'T12 Taylorwoodf Arms');
select pg_temp.item('T12 Taylorwood Farm S', '00000000-0000-4000-8000-00000000c12a');
select is((select count(*) from private.resolve_obvious_reviews()), 0::bigint, 'letters shared by two customers stay in review');
select is((select count(*) from private.resolve_obvious_reviews()), 0::bigint, 'running it again changes nothing');

select * from finish();
rollback;
