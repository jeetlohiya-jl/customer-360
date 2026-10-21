-- One-off: re-extract emails with the improved instructions (prompt x3).
-- Run AFTER the x3 code is deployed. Costs roughly what the first pass cost
-- (about $1-3 for the current pilot); the $50 monthly cap still applies.
--
-- Leaves alone any email where a person has already confirmed, corrected or
-- rejected a fact, so human review work is never overwritten.

-- 1. Preview: how many emails would be re-extracted
select s.status, coalesce(s.prompt_version, s.skip_reason) as version_or_skip, count(*)
  from private.extraction_state s
 where ((s.status = 'extracted' and s.prompt_version is distinct from 'x3')
        or (s.status = 'skipped' and s.skip_reason in ('too_short', 'acknowledgement')))
   and not exists (select 1 from private.customer_facts f
                    where f.owner_id = s.owner_id and f.gmail_message_id = s.gmail_message_id
                      and f.review_state in ('confirmed', 'corrected', 'rejected'))
 group by 1, 2 order by 1, 2;

-- 2. Requeue them (extraction picks them up within a minute, newest first)
update private.extraction_state s
   set status = 'pending', skip_reason = null, attempts = 0, next_attempt_at = null,
       last_error = null, lease_until = null, updated_at = now()
 where ((s.status = 'extracted' and s.prompt_version is distinct from 'x3')
        or (s.status = 'skipped' and s.skip_reason in ('too_short', 'acknowledgement')))
   and not exists (select 1 from private.customer_facts f
                    where f.owner_id = s.owner_id and f.gmail_message_id = s.gmail_message_id
                      and f.review_state in ('confirmed', 'corrected', 'rejected'));

-- 3. Progress (re-run until pending is 0)
select status, prompt_version, count(*) from private.extraction_state group by 1, 2 order by 1, 2;
