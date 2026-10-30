-- Migration 0017: past email is searched automatically when a customer, alias,
-- domain or address is added. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000017a1', 't17.ann@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000017b1', 't17.ben@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}'),
  ('00000000-0000-4000-8000-0000000017c1', 't17.cat@gocirkla.com', '{"custom_claims":{"hd":"gocirkla.com"}}');
insert into private.gmail_connections (user_id, mailbox_email, refresh_token_enc, key_version, scopes) values
  ('00000000-0000-4000-8000-0000000017a1', 't17.ann@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000017b1', 't17.ben@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']),
  ('00000000-0000-4000-8000-0000000017c1', 't17.cat@gocirkla.com', 'v1.iv.ct.tag', 1, array['https://www.googleapis.com/auth/gmail.readonly']);
update private.settings set value = 't17.ann@gocirkla.com,t17.ben@gocirkla.com,t17.cat@gocirkla.com' where key = 'scan_allowed_mailboxes';
-- Ann and Ben finished full scans; Ben is in the middle of another scan. Cat never scanned.
insert into private.scan_jobs (owner_id, mailbox_email, status, rules_version, cutoff_at, finished_at) values
  ('00000000-0000-4000-8000-0000000017a1', 't17.ann@gocirkla.com', 'completed', 'm2', now() - interval '3 days', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000017b1', 't17.ben@gocirkla.com', 'completed', 'm2', now() - interval '3 days', now() - interval '3 days');
insert into private.scan_jobs (id, owner_id, mailbox_email, status, rules_version, cutoff_at) values
  ('00000000-0000-4000-8000-0000000b017a', '00000000-0000-4000-8000-0000000017b1', 't17.ben@gocirkla.com', 'running', 'm2', now());

create function pg_temp.queued(p_owner uuid) returns text language sql as $$
  select string_agg(search_query, ' | ' order by created_at) from private.scan_jobs
   where owner_id = p_owner and status = 'queued' and search_query is not null
$$;

select ok(not has_function_privilege('authenticated', 'private.request_backfill(uuid, text)', 'execute'), 'clients cannot file backfill requests');
select ok(not has_function_privilege('anon', 'public.backfill_waiting()', 'execute'), 'anonymous callers cannot see waiting backfills');
select is((select value from private.settings where key = 'auto_backfill'), 'on', 'automatic backfill is on by default');

-- ---- A new customer is searched for at once in every free, scanned mailbox ------------------------
insert into public.customers (id, canonical_name) values ('00000000-0000-4000-8000-00000000c17a', 'T17 Gloryfold Foods');
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017a1'),
  '{subject:"t17 gloryfold foods" from:t17gloryfoldfoods.com to:t17gloryfoldfoods.com}',
  'adding a customer queues a search for its name (and <name>.com) in a free mailbox');
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017b1'), null, 'a mailbox with a scan running gets nothing yet');
select is((select count(*) from private.backfill_requests where owner_id = '00000000-0000-4000-8000-0000000017b1'), 1::bigint, '... the request waits for it');
select is((select count(*) from private.scan_jobs where owner_id = '00000000-0000-4000-8000-0000000017c1'), 0::bigint, 'a mailbox that never had a full scan is never searched');
select ok(exists (select 1 from public.audit_log where action = 'customer.backfill_queued' and detail ->> 'automatic' = 'true'), 'automatic searches are audited');

-- ---- The waiting request starts when the running scan ends --------------------------------------
update private.scan_jobs set status = 'completed', finished_at = now() where id = '00000000-0000-4000-8000-0000000b017a';
select ok(pg_temp.queued('00000000-0000-4000-8000-0000000017b1') like '{subject:"t17 gloryfold foods"%', 'when the scan finishes, the waiting search starts');
select is((select count(*) from private.backfill_requests), 0::bigint, 'nothing is left waiting');

-- ---- A domain on file replaces the guess; adding it searches again ---------------------------------
update private.scan_jobs set status = 'completed', finished_at = now() where search_query is not null;
insert into public.customer_identifiers (customer_id, kind, value, source) values ('00000000-0000-4000-8000-00000000c17a', 'domain', 't17glory.example', 'manual');
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017a1'),
  '{from:t17glory.example to:t17glory.example cc:t17glory.example subject:"t17 gloryfold foods"}',
  'adding a domain searches again, by the real domain (no guess)');
update private.scan_jobs set status = 'completed', finished_at = now() where search_query is not null;

-- ---- Aliases, re-activation ----------------------------------------------------------------------
insert into public.customer_aliases (customer_id, alias, kind, source) values ('00000000-0000-4000-8000-00000000c17a', 'T17 GF Poultry', 'trading', 'manual');
select ok(pg_temp.queued('00000000-0000-4000-8000-0000000017a1') like '%subject:"t17 gf poultry"%', 'adding an alias searches again, including the alias');
update private.scan_jobs set status = 'completed', finished_at = now() where search_query is not null;
update public.customers set notes = 'met at IPPE' where id = '00000000-0000-4000-8000-00000000c17a';
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017a1'), null, 'an unrelated edit searches nothing');
update public.customers set status = 'inactive' where id = '00000000-0000-4000-8000-00000000c17a';
update public.customers set status = 'active' where id = '00000000-0000-4000-8000-00000000c17a';
select ok(pg_temp.queued('00000000-0000-4000-8000-0000000017a1') is not null, 're-activating a customer searches again');
update private.scan_jobs set status = 'completed', finished_at = now() where search_query is not null;

-- ---- Bulk imports and the switch --------------------------------------------------------------------
insert into public.customers (canonical_name) select 'T17 Bulk Customer ' || g from generate_series(1, 21) g;
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017a1'), null, 'a bulk import (over 20 customers) files no searches');
select ok(exists (select 1 from public.audit_log where action = 'customer.backfill_skipped_bulk'), '... and says so in the audit log');
update private.settings set value = 'off' where key = 'auto_backfill';
insert into public.customers (canonical_name) values ('T17 Switched Off Farms');
select is(pg_temp.queued('00000000-0000-4000-8000-0000000017a1'), null, 'with the switch off, nothing is searched automatically');

select * from finish();
rollback;
