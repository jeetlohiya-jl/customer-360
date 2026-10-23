-- Operator script, 2026-10-23: Preferred Packaging data fix and turning on 0013.
-- Run in the Supabase SQL editor AFTER migration 20261023000013 is applied AND
-- the matching app code is deployed (an older worker would treat a targeted
-- re-scan as a full scan). Every change below is written to the audit log.

begin;

-- 1. The domains Preferred Packaging writes from. cpflexpack.com is C-P Flexible
--    Packaging, of which Preferred Packaging is a division; no other customer
--    on the list uses it, so it is an exclusive (not shared) domain.
do $$
declare
  v_pp uuid := (select id from public.customers where normalized_name = 'preferred packaging');
  d    text;
begin
  if v_pp is null then
    raise exception 'Preferred Packaging not found';
  end if;
  foreach d in array array['cpflexpack.com', 'prefpkg.com'] loop
    if private.add_identifier(v_pp, 'domain', d, false, 'manual') then
      insert into public.audit_log (actor, action, target, detail)
      values (null, 'customer.identifier_added', v_pp::text, jsonb_build_object('kind', 'domain', 'value', d, 'shared', false, 'by', 'operator 2026-10-23'));
    end if;
  end loop;
  -- "Pref" is how CRM tickets and colleagues name it ("[Ticket] - Pref 1CP & 2CP").
  if private.add_alias(v_pp, 'Pref', 'alias', 'manual') then
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'customer.alias_added', v_pp::text, jsonb_build_object('alias', 'Pref', 'kind', 'alias', 'by', 'operator 2026-10-23'));
  end if;
  perform private.bump_alias_version();
end $$;

-- 2. Colleagues' internal emails in customer threads and CRM tickets (0013).
update private.settings set value = 'thread_and_named' where key = 'internal_linking';

-- 3. Approve the mailboxes of the people on these threads. Nothing is read until
--    each person signs in, connects Gmail and starts their own scan.
do $$
declare
  addr text;
begin
  foreach addr in array array['vaishnavi.bhondve@gocirkla.com', 'jennifer.martineau@gocirkla.com',
                              'umar.khan@gocirkla.com', 'abhijit.biswas@gocirkla.com', 'jeet.lohiya@gocirkla.com'] loop
    update private.settings
       set value = concat_ws(',', nullif(value, ''), addr)
     where key in ('scan_allowed_mailboxes', 'extract_allowed_mailboxes')
       and not (addr = any (string_to_array(replace(lower(value), ' ', ''), ',')));
  end loop;
end $$;

-- 4. Mailboxes whose sync was stuck on a deleted email: retry now.
update private.gmail_sync set next_attempt_at = null, dirty = true, updated_at = now() where error_count > 0;

commit;

-- 5. Find Preferred Packaging's past email again in every fully scanned mailbox
--    (targeted re-scan; one or two pages each; the scan cron runs every minute).
select private.customer_backfill_as_owner(
  (select id from public.customers where normalized_name = 'preferred packaging'),
  'Preferred Packaging: cpflexpack.com, prefpkg.com and "Pref" added (2026-10-23)');

-- ---------------------------------------------------------------------------
-- Checks (read-only). Re-run until the targeted scans are completed and
-- extraction has caught up.
-- ---------------------------------------------------------------------------
-- select mailbox_email, status, pages_done, matched, purpose from private.scan_jobs where search_query is not null order by created_at desc;
-- select direction, count(*), max(message_at) from private.message_links
--  where customer_id = (select id from public.customers where normalized_name = 'preferred packaging') group by 1;
-- select s.status, count(*) from private.extraction_state s join private.message_links l using (owner_id, gmail_message_id)
--  where l.customer_id = (select id from public.customers where normalized_name = 'preferred packaging') group by 1;
-- select message_at::date, fact_type, status, summary from private.customer_facts
--  where customer_id = (select id from public.customers where normalized_name = 'preferred packaging')
--    and message_at > '2026-10-01' order by message_at desc;
