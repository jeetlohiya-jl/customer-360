-- One-off: re-score facts already awaiting review under the 0009 rules.
-- Run AFTER migration 0009. Touches only unreviewed facts in 'needs_review';
-- facts a person already confirmed, corrected or rejected are left alone.
-- Free: no AI calls. Safe to run more than once.
with rescored as (
  select f.id,
         private.fact_review_reasons(
           f.fact_type, f.stance, f.basis, f.status_basis, f.confidence,
           array(select r from unnest(f.review_reasons) r
                  where r not in ('low_confidence', 'inferred_status', 'commitment_needs_check')
                 union all
                 select 'inferred_status' where f.status in ('resolved', 'cancelled') and f.status_basis = 'inferred')
         ) as reasons
    from private.customer_facts f
   where f.review_state = 'needs_review' and f.reviewed_at is null
)
update private.customer_facts f
   set review_reasons = r.reasons,
       review_state = case when cardinality(r.reasons) = 0 then 'auto' else 'needs_review' end
  from rescored r
 where f.id = r.id;

-- Result:
select review_state, count(*) from private.customer_facts group by 1 order by 1;
select r as reason, count(*) from private.customer_facts, unnest(review_reasons) r
 where review_state = 'needs_review' group by 1 order by 2 desc;
