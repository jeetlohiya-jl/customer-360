-- Read customer numbers from emails that were extracted before prompt x7 (migration 0018).
--
-- Run ONLY after the x7 code is live and you have looked at the first numbers on
-- the Customer numbers page. The guard below refuses to run until at least one
-- email has been extracted with x7.
--
-- What it does: puts already-extracted emails back in the extraction queue. The
-- worker re-reads each one (newest first, 25 a minute) in ONE AI call that
-- returns both its facts (replacing the old AI facts) and its numbers. Emails
-- with any fact a person has confirmed, corrected or rejected are left alone, so
-- no review work is lost (those emails get no numbers). Cost: about $0.0005 per
-- email, charged to the monthly cap (extraction pauses if the cap is reached).
--
-- Step 1 (preview, changes nothing): how many emails, and the cost estimate.
select count(*) as emails_to_read, round(count(*) * 0.0005, 2) as approx_usd
  from private.extraction_state s
 where s.status = 'extracted' and s.prompt_version is distinct from 'x7'
   and not exists (select 1 from private.customer_facts f
                    where f.owner_id = s.owner_id and f.gmail_message_id = s.gmail_message_id
                      and f.review_state in ('confirmed', 'corrected', 'rejected'));

-- Step 2: queue them.
begin;

do $$
begin
  if not exists (select 1 from private.extraction_state where prompt_version = 'x7') then
    raise exception 'x7 is not live yet: wait until the new code has extracted at least one email, then run this again';
  end if;
end $$;

with requeue as (
  select s.owner_id, s.gmail_message_id
    from private.extraction_state s
   where s.status = 'extracted'
     and s.prompt_version is distinct from 'x7'
     and not exists (select 1 from private.customer_facts f
                      where f.owner_id = s.owner_id and f.gmail_message_id = s.gmail_message_id
                        and f.review_state in ('confirmed', 'corrected', 'rejected'))
)
update private.extraction_state s
   set status = 'pending', attempts = 0, next_attempt_at = null, lease_until = null, last_error = null, updated_at = now()
  from requeue r
 where s.owner_id = r.owner_id and s.gmail_message_id = r.gmail_message_id;

insert into public.audit_log (actor, action, target, detail)
select null, 'extraction.requeued', 'prompt x7',
       jsonb_build_object('reason', 'customer numbers (0018)',
                          'pending', (select count(*) from private.extraction_state where status = 'pending'));

select count(*) as queued_for_reextraction from private.extraction_state where status = 'pending';
commit;

-- Progress (re-run): emails read with x7 and numbers stored so far.
-- select prompt_version, count(*) from private.extraction_state where status = 'extracted' group by 1 order by 1;
-- select category, count(*) from private.customer_metrics group by 1 order by 2 desc;
