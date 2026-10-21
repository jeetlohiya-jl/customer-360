-- Review rules, tuned on the first real pilot (2026-10-20).
--
-- Findings on 2,636 real facts: 71% went to review, driven by two rules:
--   * low_confidence (< 0.70): the model scores itself 0.55-0.75 on almost
--     everything, so this rule flagged most facts without separating good
--     from bad. Now < 0.50.
--   * inferred_status: fired for ANY inferred status, including a new fact
--     simply being "open". Intended only for inferred CLOSING of something
--     (resolved / cancelled). The extraction worker adds that reason itself
--     (lib/extract/validate.ts), and closing an EARLIER fact on inferred
--     grounds still sends that fact to review (worker_extract_commit).
-- Unchanged: commitments on orders, prices and deliveries below 0.90 still
-- go to review, as do every check-based reason from the worker.
--
-- Same signature; replaces one function. No table or data change.
-- Reverse: supabase/rollback/20261020000009_review_rules.down.sql
create or replace function private.fact_review_reasons(p_type text, p_stance text, p_basis text, p_status_basis text,
                                                       p_confidence numeric, p_worker_reasons text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array(select distinct r from unnest(
    coalesce(p_worker_reasons, '{}')
    || case when p_confidence < 0.50 then array['low_confidence'] else '{}'::text[] end
    || case when p_stance = 'commitment' and p_type in ('order', 'pricing', 'delivery') and p_confidence < 0.90
            then array['commitment_needs_check'] else '{}'::text[] end
  ) as r order by r)
$$;
