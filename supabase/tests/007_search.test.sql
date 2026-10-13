-- Stage 3.2 search: authorization, cross-mailbox isolation, filters, keyword
-- scope, pagination and admin aggregates. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

-- ---- Synthetic fixtures -------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000007a1', 't7.alice@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000007b1', 't7.bob@gocirkla.com',   '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000007c1', 't7.admin@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000007d1', 't7.gone@gocirkla.com',  '{"custom_claims":{"hd":"gocirkla.com"}}');
update public.app_users set role = 'admin' where id = '00000000-0000-4000-8000-0000000007c1';
update public.app_users set status = 'departed' where id = '00000000-0000-4000-8000-0000000007d1';

insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000007a1', 't7.alice@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']),
  ('00000000-0000-4000-8000-0000000007b1', 't7.bob@gocirkla.com',   'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.metadata']);

insert into public.customers (id, canonical_name) values
  ('00000000-0000-4000-8000-00000000c7a1', 'T7 Acme Packaging'),
  ('00000000-0000-4000-8000-00000000c7b1', 'T7 Bravo Foods'),
  ('00000000-0000-4000-8000-00000000c7c1', 'T7 Charlie Meats');
insert into public.customer_aliases (customer_id, alias, kind, source) values
  ('00000000-0000-4000-8000-00000000c7a1', 'Zenith Trays', 'trading', 'manual');
insert into public.customer_identifiers (customer_id, kind, value, source) values
  ('00000000-0000-4000-8000-00000000c7a1', 'domain', 'acme-t7.example', 'manual'),
  ('00000000-0000-4000-8000-00000000c7b1', 'domain', 'bravo-t7.example', 'manual');

-- Alice: 6 links (two share a timestamp to test the tie-break). Bob: 3 links.
insert into private.message_links
  (id, owner_id, customer_id, gmail_message_id, gmail_thread_id, message_at, direction, customer_addresses, evidence, score, rules_version, link_status)
values
  ('00000000-0000-4000-8000-0000000071a1', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7a1', 'a7m1', 'a7t1', '2026-09-01T00:00:00Z', 'inbound',  '{jane@acme-t7.example}', '[{"type":"E2","value":"acme-t7.example"}]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071a2', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7a1', 'a7m2', 'a7t1', '2026-09-01T23:59:59Z', 'outbound', '{jane@acme-t7.example}', '[{"type":"E2","value":"acme-t7.example"}]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071a3', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7b1', 'a7m3', null,   '2026-09-05T10:00:00Z', 'inbound',  '{raj_k@bravo-t7.example}', '[{"type":"E2","value":"bravo-t7.example"}]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071a4', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7b1', 'a7m4', null,   '2026-09-10T10:00:00Z', 'outbound', '{}', '[{"type":"E3","value":"t7 bravo foods"}]', 0.95, 'm1', 'confirmed'),
  ('00000000-0000-4000-8000-0000000071a5', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7a1', 'a7m5', null,   '2026-09-20T10:00:00Z', 'inbound',  '{}', '[{"type":"E3","value":"zenith trays"}]', 0.95, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071a6', '00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-00000000c7a1', 'a7m6', null,   '2026-09-20T10:00:00Z', 'inbound',  '{}', '[{"type":"E3","value":"t7 acme packaging"}]', 0.95, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071b1', '00000000-0000-4000-8000-0000000007b1', '00000000-0000-4000-8000-00000000c7a1', 'b7m1', null,   '2026-09-02T10:00:00Z', 'inbound',  '{tom@acme-t7.example}', '[{"type":"E2","value":"acme-t7.example"}]', 1, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071b2', '00000000-0000-4000-8000-0000000007b1', '00000000-0000-4000-8000-00000000c7c1', 'b7m2', null,   '2026-09-03T10:00:00Z', 'inbound',  '{}', '[{"type":"E3","value":"t7 charlie meats"}]', 0.95, 'm1', 'auto'),
  ('00000000-0000-4000-8000-0000000071b3', '00000000-0000-4000-8000-0000000007b1', '00000000-0000-4000-8000-00000000c7c1', 'b7m3', null,   '2026-09-04T10:00:00Z', 'outbound', '{}', '[{"type":"E3","value":"t7 charlie meats"}]', 0.95, 'm1', 'auto');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;
create function pg_temp.ids(p_query text default null, p_customer uuid default null, p_from date default null, p_to date default null,
                            p_direction text default null, p_mailbox text default null) returns text language sql as $$
  select coalesce(string_agg(gmail_message_id, ',' order by message_at desc, link_id desc), '')
    from public.search_my_links(p_query, p_customer, p_from, p_to, p_direction, p_mailbox, null, null, 100)
$$;

-- ---- Privileges ------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer)', 'execute'), 'signed-in users can search');
select ok(not has_function_privilege('anon', 'public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer)', 'execute'), 'anonymous callers cannot search');
select ok(not has_function_privilege('anon', 'public.admin_link_counts(text, uuid, date, date, integer, integer)', 'execute'), 'anonymous callers cannot read counts');
select ok(not has_function_privilege('anon', 'public.my_linked_customers()', 'execute'), 'anonymous callers cannot list linked customers');
select ok(not has_function_privilege('c360_worker', 'public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer)', 'execute'), 'the scan worker cannot search');
select ok(not has_function_privilege('c360_worker', 'public.admin_link_counts(text, uuid, date, date, integer, integer)', 'execute'), 'the scan worker cannot read counts');
select ok(not has_table_privilege('authenticated', 'private.message_links', 'select'), 'clients still cannot read message links directly');
select ok(position('gmail' in pg_get_function_result('public.admin_link_counts(text, uuid, date, date, integer, integer)'::regprocedure)) = 0
          and position('mailbox_email' in pg_get_function_result('public.admin_link_counts(text, uuid, date, date, integer, integer)'::regprocedure)) = 0
          and position('address' in pg_get_function_result('public.admin_link_counts(text, uuid, date, date, integer, integer)'::regprocedure)) = 0,
          'admin counts return no message ids, mailbox names or addresses');

-- ---- Alice: own mailbox only ------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000007a1');
select is(pg_temp.ids(), 'a7m6,a7m5,a7m4,a7m3,a7m2,a7m1', 'Alice sees exactly her six links, newest first, ties broken by id');
select is((select count(*)::int from public.search_my_links() where gmail_message_id like 'b7%'), 0, 'none of Bob''s links are visible to Alice');
select is((select distinct mailbox_email from public.search_my_links()), 't7.alice@gocirkla.com', 'every result is labelled with Alice''s own mailbox');
select is(pg_temp.ids(p_customer => '00000000-0000-4000-8000-00000000c7c1'), '', 'a customer that only Bob emails returns nothing for Alice');
select is((select string_agg(customer_name, ',' order by customer_name) from public.my_linked_customers()),
          'T7 Acme Packaging,T7 Bravo Foods', 'Alice''s customer filter lists only customers in her own links');

-- Mailbox filter
select is(pg_temp.ids(p_mailbox => 'T7.Alice@GoCirkla.com '), 'a7m6,a7m5,a7m4,a7m3,a7m2,a7m1', 'mailbox filter: own mailbox, any case');
select is(pg_temp.ids(p_mailbox => 't7.bob@gocirkla.com'), '', 'mailbox filter: another employee''s mailbox returns nothing');
select is(pg_temp.ids(p_mailbox => 'nobody@example.com'), '', 'mailbox filter: unknown mailbox returns nothing');

-- Customer, date and direction filters
select is(pg_temp.ids(p_customer => '00000000-0000-4000-8000-00000000c7b1'), 'a7m4,a7m3', 'customer filter');
select is(pg_temp.ids(p_from => '2026-09-01', p_to => '2026-09-01'), 'a7m2,a7m1', 'one-day range includes 00:00:00 and 23:59:59 UTC');
select is(pg_temp.ids(p_from => '2026-09-02'), 'a7m6,a7m5,a7m4,a7m3', 'from date only');
select is(pg_temp.ids(p_to => '2026-09-04'), 'a7m2,a7m1', 'to date only');
select is(pg_temp.ids(p_direction => 'outbound'), 'a7m4,a7m2', 'direction filter');
select is(pg_temp.ids(p_customer => '00000000-0000-4000-8000-00000000c7a1', p_from => '2026-09-02', p_direction => 'inbound'), 'a7m6,a7m5', 'filters combine');

-- Keyword: customer list data and stored contact addresses only
select is(pg_temp.ids('acme'), 'a7m6,a7m5,a7m2,a7m1', 'keyword matches the customer name');
select is(pg_temp.ids('Pack'), 'a7m6,a7m5,a7m2,a7m1', 'keyword matches the start of a word in the name, any case');
select is(pg_temp.ids('ckag'), '', 'keyword does not match the middle of a name word');
select is(pg_temp.ids('zenith'), 'a7m6,a7m5,a7m2,a7m1', 'keyword matches an approved alias');
select ok((select bool_and('customer alias' = any(matched_on)) from public.search_my_links('zenith')), 'results say they matched on the alias');
select is(pg_temp.ids('bravo-t7.example'), 'a7m4,a7m3', 'keyword matches a verified customer domain');
select is(pg_temp.ids('raj_k@'), 'a7m3', 'keyword matches a stored contact address (underscore taken literally)');
select is(pg_temp.ids('jane'), 'a7m2,a7m1', 'keyword matches the local part of a contact address');
select is(pg_temp.ids('invoice'), '', 'words that would only appear in email subjects or bodies find nothing (not stored)');
select is(pg_temp.ids('%%'), '', 'wildcards are matched literally');
select is(pg_temp.ids('tom@acme'), '', 'Bob''s contact addresses are not searchable by Alice');
select is(pg_temp.ids('charlie'), '', 'a customer only Bob emails is not found by Alice''s keyword search');

-- Input validation
select throws_ok($$ select * from public.search_my_links('a') $$, '22023', null, 'one-character search is refused');
select throws_ok($$ select * from public.search_my_links(repeat('x', 101)) $$, '22023', null, 'over-long search is refused');
select throws_ok($$ select * from public.search_my_links(p_direction => 'sideways') $$, '22023', null, 'bad direction is refused');
select throws_ok($$ select * from public.search_my_links(p_from => '2026-09-10', p_to => '2026-09-01') $$, '22023', null, 'from after to is refused');
select throws_ok($$ select * from public.search_my_links(p_cursor_at => now()) $$, '22023', null, 'half a cursor is refused');

-- Pagination (keyset): pages are disjoint, ordered, and complete, including the tie
create temp table pg on commit drop as select * from public.search_my_links(p_limit => 2);
select is((select string_agg(gmail_message_id, ',' order by message_at desc, link_id desc) from pg), 'a7m6,a7m5', 'page 1');
create temp table pg2 on commit drop as
  select * from public.search_my_links(p_cursor_at => (select message_at from pg order by message_at, link_id limit 1),
                                       p_cursor_id => (select link_id from pg order by message_at, link_id limit 1), p_limit => 2);
select is((select string_agg(gmail_message_id, ',' order by message_at desc, link_id desc) from pg2), 'a7m4,a7m3', 'page 2 continues after the tie without repeats');
select is((select string_agg(gmail_message_id, ',' order by message_at desc, link_id desc)
             from public.search_my_links(p_cursor_at => (select message_at from pg2 order by message_at, link_id limit 1),
                                         p_cursor_id => (select link_id from pg2 order by message_at, link_id limit 1), p_limit => 2)),
          'a7m2,a7m1', 'page 3 ends the list');
select is((select count(*)::int from public.search_my_links(p_limit => 0)), 1, 'limit is clamped to at least 1');
select is((select count(*)::int from public.search_my_links(p_limit => 100000)), 6, 'a huge limit is clamped (max 100) and still safe');

select throws_ok($$ select * from public.admin_link_counts() $$, '42501', null, 'a non-admin cannot read aggregate counts');

-- ---- Bob ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000007b1');
select is(pg_temp.ids(), 'b7m3,b7m2,b7m1', 'Bob sees only his own three links');
select is(pg_temp.ids(p_mailbox => 't7.alice@gocirkla.com'), '', 'Bob cannot reach Alice''s mailbox through the filter');

-- ---- Admin: counts only -------------------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000007c1');
select is(pg_temp.ids(), '', 'being admin does not reveal anyone else''s links in search');
select is(pg_temp.ids(p_mailbox => 't7.alice@gocirkla.com'), '', 'admin cannot use the mailbox filter to read Alice''s links');
select results_eq(
  $$ select customer_name, link_count, mailbox_count from public.admin_link_counts() where customer_name like 'T7 %' $$,
  $$ values ('T7 Acme Packaging'::text, 5, 2), ('T7 Bravo Foods'::text, 2, 1), ('T7 Charlie Meats'::text, 2, 1) $$,
  'admin sees totals per customer across all mailboxes');
select results_eq(
  $$ select customer_name, link_count from public.admin_link_counts(p_query => 'zenith') $$,
  $$ values ('T7 Acme Packaging'::text, 5) $$, 'admin keyword filter uses customer list data');
select results_eq(
  $$ select customer_name, link_count from public.admin_link_counts(p_from => '2026-09-02', p_to => '2026-09-04') where customer_name like 'T7 %' $$,
  $$ values ('T7 Charlie Meats'::text, 2), ('T7 Acme Packaging'::text, 1) $$, 'admin date filter');

-- ---- Inactive and anonymous callers ---------------------------------------------------
select pg_temp.act_as('00000000-0000-4000-8000-0000000007d1');
select throws_ok($$ select * from public.search_my_links() $$, '42501', null, 'a departed employee cannot search');
select is((select count(*)::int from public.my_linked_customers()), 0, 'a departed employee lists no customers');
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$ select * from public.search_my_links() $$, '42501', null, 'no signed-in user, no search');

reset role;
select * from finish();
rollback;
