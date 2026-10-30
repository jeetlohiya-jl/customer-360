-- Re-extract stored emails with prompt x6, which tells the AI who wrote and who
-- received each email. Fixes facts that credit the wrong person ("Glenn" for
-- Vaibhav's email, the mailbox owner instead of the writer).
--
-- Run ONLY after the x6 code is live. The guard below refuses to run until at
-- least one email has been extracted with x6.
--
-- What it does: puts already-extracted emails back in the extraction queue.
-- The worker re-reads each one (newest first, 25 a minute) and replaces that
-- email's AI facts with new ones. Emails with any fact a person has confirmed,
-- corrected or rejected are left alone, so no review work is lost. Links,
-- customers and emails are not touched. Cost: about $0.0004 per email.
begin;

do $$
begin
  if not exists (select 1 from private.extraction_state where prompt_version = 'x6') then
    raise exception 'x6 is not live yet: wait until the new code has extracted at least one email, then run this again';
  end if;
end $$;

with requeue as (
  select s.owner_id, s.gmail_message_id
    from private.extraction_state s
   where s.status = 'extracted'
     and s.prompt_version in ('x3', 'x4', 'x5')
     and not exists (select 1 from private.customer_facts f
                      where f.owner_id = s.owner_id and f.gmail_message_id = s.gmail_message_id
                        and f.review_state in ('confirmed', 'corrected', 'rejected'))
)
update private.extraction_state s
   set status = 'pending', attempts = 0, next_attempt_at = null, lease_until = null, last_error = null, updated_at = now()
  from requeue r
 where s.owner_id = r.owner_id and s.gmail_message_id = r.gmail_message_id;

insert into public.audit_log (actor, action, target, detail)
select null, 'extraction.requeued', 'prompt x6',
       jsonb_build_object('reason', 'names from From/To/Cc headers',
                          'pending', (select count(*) from private.extraction_state where status = 'pending'));

select count(*) as queued_for_reextraction from private.extraction_state where status = 'pending';
commit;
