-- Customer master, CSV import, review queue (Stage 3.0). Synthetic data only.
-- Creates its own synthetic admin and member (does not depend on the seed).
begin;
create extension if not exists pgtap with schema extensions;
select plan(73);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000005a1', 't5.admin@gocirkla.com',  '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000005b1', 't5.member@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000005a1';

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
create function pg_temp.cid(p_name text) returns uuid language sql as $$
  select id from public.customers where canonical_name = p_name
$$;
create function pg_temp.queue_id(p_observed text) returns uuid language sql as $$
  select id from public.review_queue_list(500) where observed = p_observed
$$;

-- ---- Privileges -----------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.review_items', 'select'), 'review items are not readable directly');
select ok(not has_table_privilege('anon', 'public.customers', 'select'), 'anon cannot read customers');
select ok(not has_table_privilege('authenticated', 'public.customers', 'insert,update,delete'), 'no direct writes to customers');
select ok(not has_table_privilege('authenticated', 'public.customer_aliases', 'insert,update,delete'), 'no direct writes to aliases');
select ok(not has_function_privilege('anon', 'public.import_customers(jsonb, text)', 'execute'), 'anon cannot import');
select ok(not has_function_privilege('authenticated', 'private.add_alias(uuid, text, text, text)', 'execute'), 'internal helpers are not callable');

-- ---- Normalization: the same cases as tests/fixtures/normalize-cases.json ----
select is(private.normalize_name('Acme Packaging Limited'), 'acme packaging', 'normalize: ' || 'Acme Packaging Limited');
select is(private.normalize_name('ACME PACKAGING LIMITED'), 'acme packaging', 'normalize: ' || 'ACME PACKAGING LIMITED');
select is(private.normalize_name('Acme Packaging Ltd.'), 'acme packaging', 'normalize: ' || 'Acme Packaging Ltd.');
select is(private.normalize_name('  Acme   Packaging  '), 'acme packaging', 'normalize: ' || '  Acme   Packaging  ');
select is(private.normalize_name('Acme Packaging, L.L.C.'), 'acme packaging', 'normalize: ' || 'Acme Packaging, L.L.C.');
select is(private.normalize_name('Acme Packaging Pvt. Ltd.'), 'acme packaging', 'normalize: ' || 'Acme Packaging Pvt. Ltd.');
select is(private.normalize_name('The Acme Company'), 'acme', 'normalize: ' || 'The Acme Company');
select is(private.normalize_name('Smith & Co'), 'smith', 'normalize: ' || 'Smith & Co');
select is(private.normalize_name('Smith & Sons Inc'), 'smith and sons', 'normalize: ' || 'Smith & Sons Inc');
select is(private.normalize_name('McDonald''s'), 'mcdonalds', 'normalize: ' || 'McDonald''s');
select is(private.normalize_name('Café Rouge S.A.'), 'cafe rouge', 'normalize: ' || 'Café Rouge S.A.');
select is(private.normalize_name('Nestlé GmbH'), 'nestle', 'normalize: ' || 'Nestlé GmbH');
select is(private.normalize_name('Ltd'), 'ltd', 'normalize: ' || 'Ltd');
select is(private.normalize_name('The'), 'the', 'normalize: ' || 'The');
select is(private.normalize_name('!!!'), '', 'normalize: ' || '!!!');
select is(private.normalize_name('Bravo-Foods International Corp.'), 'bravo foods international', 'normalize: ' || 'Bravo-Foods International Corp.');
select is(private.normalize_name('3M Company'), '3m', 'normalize: ' || '3M Company');

set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000005a1');

-- ---- Import ---------------------------------------------------------------
select is(
  public.import_customers($j$[
    {"ref":2,"action":"create","customer_id":null,"canonical_name":"Acme Packaging Limited",
     "names":[{"value":"Acme Pack","kind":"trading"}],
     "domains":[{"value":"acmepackaging.com","shared":false}],"emails":["buyer@outlook.com"],
     "notes":"Ohio processor","status":"active","distinct_from_customers":[],"distinct_from_refs":[]},
    {"ref":3,"action":"create","customer_id":null,"canonical_name":"Bravo Foods Inc",
     "names":[],"domains":[{"value":"bravofoods.com","shared":false}],"emails":[],
     "notes":null,"status":null,"distinct_from_customers":[],"distinct_from_refs":[2]}
  ]$j$::jsonb, repeat('a', 64)) ->> 'created',
  '2', 'admin imports two customers');
select is((select count(*)::int from public.customers), 2, 'admin sees both customers');
select is((select normalized_name from public.customers where id = pg_temp.cid('Acme Packaging Limited')), 'acme packaging', 'normalized name is stored');
select is((select count(*)::int from public.customer_aliases where customer_id = pg_temp.cid('Acme Packaging Limited')), 1, 'alias imported');
select is((select count(*)::int from public.customer_identifiers), 3, 'domains and email imported');
select is((select count(*)::int from public.customer_distinctions), 1, 'rows from the same file marked as different customers');

-- Re-importing a customer updates it and adds only what is new.
select is(
  public.import_customers(format($j$[
    {"ref":2,"action":"update","customer_id":"%s","canonical_name":"ACME PACKAGING LTD",
     "names":[{"value":"Acme Pack","kind":"trading"},{"value":"APL","kind":"alias"}],
     "domains":[{"value":"acmepackaging.com","shared":false}],"emails":[],
     "notes":null,"status":null,"distinct_from_customers":[],"distinct_from_refs":[]}
  ]$j$, pg_temp.cid('Acme Packaging Limited'))::jsonb, repeat('b', 64)) ->> 'aliases_added',
  '1', 'update adds only the new alias');
select is((select notes from public.customers where id = pg_temp.cid('Acme Packaging Limited')), 'Ohio processor', 'empty notes in an update keep the old notes');

-- A conflict anywhere rolls back the whole import.
select throws_ok(
  $$ select public.import_customers('[
       {"ref":2,"action":"create","canonical_name":"Charlie Meats","names":[],"domains":[],"emails":[]},
       {"ref":3,"action":"create","canonical_name":"Delta Trays","names":[{"value":"Acme Pack","kind":"alias"}],"domains":[],"emails":[]}
     ]'::jsonb, repeat('c', 64)) $$,
  '23505', null, 'an alias owned by another customer fails the import');
select is((select count(*)::int from public.customers), 2, 'nothing from the failed import was kept');
select throws_ok(
  $$ select public.import_customers('[{"ref":2,"action":"create","canonical_name":"Echo Farms","domains":[{"value":"gmail.com","shared":false}]}]'::jsonb, repeat('d', 64)) $$,
  '22023', null, 'a free-mail domain is refused');
select throws_ok(
  $$ select public.import_customers('[{"ref":2,"action":"create","canonical_name":"Echo Farms","domains":[{"value":"gocirkla.com","shared":false}]}]'::jsonb, repeat('d', 64)) $$,
  '22023', null, 'Cirkla''s own domain is refused');
select throws_ok(
  $$ select public.import_customers('[{"ref":2,"action":"create","canonical_name":"Acme Packaging, L.L.C."}]'::jsonb, repeat('d', 64)) $$,
  '23505', null, 'a second customer with the same normalized name is refused');
select throws_ok(
  $$ select public.import_customers('[{"ref":2,"action":"create","canonical_name":"Echo Farms"}]'::jsonb, 'not-a-checksum') $$,
  '22023', null, 'an import without a file checksum is refused');

-- ---- Single edits ---------------------------------------------------------
select throws_ok(
  format($$ select public.customer_add_alias('%s', 'Acme Packaging') $$, pg_temp.cid('Bravo Foods Inc')),
  '23505', null, 'cannot give Bravo the name of Acme');
select lives_ok(format($$ select public.customer_add_alias('%s', 'Bravo', 'trading') $$, pg_temp.cid('Bravo Foods Inc')), 'admin adds an alias');
select throws_ok(
  format($$ select public.customer_add_identifier('%s', 'domain', 'acmepackaging.com') $$, pg_temp.cid('Bravo Foods Inc')),
  '23505', null, 'a domain cannot belong to two customers');
select lives_ok(
  format($$ select public.customer_add_identifier('%s', 'domain', 'https://www.Bravo-Group.com/', true) $$, pg_temp.cid('Bravo Foods Inc')),
  'admin adds a shared domain');
select is((select value from public.customer_identifiers where customer_id = pg_temp.cid('Bravo Foods Inc') and shared), 'bravo-group.com', 'domain stored normalized and marked shared');
select lives_ok(format($$ select public.customer_set_status('%s', 'inactive') $$, pg_temp.cid('Bravo Foods Inc')), 'admin marks a customer inactive');
select lives_ok(format($$ select public.customers_unmark_distinct('%s', '%s') $$, pg_temp.cid('Acme Packaging Limited'), pg_temp.cid('Bravo Foods Inc')), 'admin removes a "different customers" mark');
select is((select count(*)::int from public.customer_distinctions), 0, 'mark removed');
select lives_ok(format($$ select public.customers_mark_distinct('%s', '%s') $$, pg_temp.cid('Bravo Foods Inc'), pg_temp.cid('Acme Packaging Limited')), 'admin marks them different again, in either order');
select is((select count(*)::int from public.customer_distinctions), 1, 'one ordered pair stored');

-- ---- Review queue ---------------------------------------------------------
select isnt(
  public.review_queue_add('Acme Packagng', format('[{"customer_id":"%s","score":0.93,"evidence":"E4"}]', pg_temp.cid('Acme Packaging Limited'))::jsonb, 'possible spelling variation'),
  null, 'an uncertain name is queued');
select lives_ok(
  format($$ select public.review_queue_add('ACME  packagng', '[{"customer_id":"%s","score":0.93,"evidence":"E4"}]'::jsonb, 'possible spelling variation') $$, pg_temp.cid('Acme Packaging Limited')),
  'the same name, written differently, is queued again');
select is((select occurrences from public.review_queue_list(10) where observed = 'Acme Packagng'), 2, 'repeats are counted on one item');
select is(public.review_queue_add('Acme Pack', '[]'::jsonb, 'x'), null, 'an approved name is never queued');
select lives_ok(
  format($$ select public.review_resolve(pg_temp.queue_id('Acme Packagng'), 'same_customer', '%s') $$, pg_temp.cid('Acme Packaging Limited')),
  'reviewer approves the spelling as Acme');
select is((select count(*)::int from public.customer_aliases where normalized = 'acme packagng' and customer_id = pg_temp.cid('Acme Packaging Limited') and source = 'review'), 1,
  'the spelling is now an approved alias of Acme');
select is((select count(*)::int from public.review_queue_list(10)), 0, 'the decided item is gone from the queue');
select is(public.review_queue_add('Acme Packagng', '[]'::jsonb, 'x'), null, 'the approved spelling is not asked again');

select lives_ok($$ select public.review_queue_add('Zulu Trays', '[]'::jsonb, 'no customer evidence') $$, 'another name queued');
select lives_ok($$ select public.review_resolve(pg_temp.queue_id('Zulu Trays'), 'not_a_customer') $$, 'reviewer rejects it');
select is((select count(*)::int from public.name_rejections where normalized = 'zulu trays'), 1, 'rejection stored as normalized words only');
select is(public.review_queue_add('ZULU TRAYS', '[]'::jsonb, 'x'), null, 'a rejected name is not asked again');
select throws_ok(
  $$ select public.review_resolve(gen_random_uuid(), 'not_a_customer') $$,
  'P0002', null, 'deciding an unknown item fails');

-- Undo is a new, audited action.
select lives_ok($$ select public.name_rejection_remove('zulu trays') $$, 'rejection can be undone');
select lives_ok(
  $$ select public.customer_remove_alias((select id from public.customer_aliases where normalized = 'acme packagng')) $$,
  'approved alias can be undone');

-- ---- A member sees and changes nothing --------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000005b1');
select is((select count(*)::int from public.customers), 0, 'member cannot read customers (RLS)');
select is((select count(*)::int from public.customer_aliases), 0, 'member cannot read aliases (RLS)');
select throws_ok($$ select public.import_customers('[{"ref":2,"action":"create","canonical_name":"X Co"}]'::jsonb, repeat('e', 64)) $$,
  '42501', null, 'member cannot import');
select throws_ok($$ select * from public.review_queue_list(10) $$, '42501', null, 'member cannot see the review queue');
select throws_ok($$ select public.review_queue_add('Acme', '[]'::jsonb, 'x') $$, '42501', null, 'member cannot add to the queue');
select throws_ok($$ insert into public.customers (canonical_name) values ('Sneaky Ltd') $$, '42501', null, 'member cannot insert directly');
select throws_ok($$ select * from private.review_items $$, '42501', null, 'member cannot read review items directly');

-- ---- Audit trail ------------------------------------------------------------
reset role;
select is(
  (select count(*)::int from public.audit_log where action = 'customer.import' and detail ? 'file_sha256'),
  2, 'each successful import is audited with its checksum, not its contents');
select is(
  (select array_agg(detail ->> 'decision' order by id)::text from public.audit_log where action = 'review.resolved'),
  '{same_customer,not_a_customer}', 'review decisions are audited');
select ok(
  (select count(*) from public.audit_log where action in ('review.rejection_removed', 'customer.alias_removed')) = 2,
  'undo actions are audited');
select ok((select value from public.meta where key = 'alias_ver') > 0, 'alias version bumped for cache refresh');

select * from finish();
rollback;
