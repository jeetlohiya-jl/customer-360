-- Reverse of 20261020000009_review_rules.sql: the original 0008 review rules.
create or replace function private.fact_review_reasons(p_type text, p_stance text, p_basis text, p_status_basis text,
                                                       p_confidence numeric, p_worker_reasons text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array(select distinct r from unnest(
    coalesce(p_worker_reasons, '{}')
    || case when p_confidence < 0.70 then array['low_confidence'] else '{}'::text[] end
    || case when p_stance = 'commitment' and p_type in ('order', 'pricing', 'delivery') and p_confidence < 0.90
            then array['commitment_needs_check'] else '{}'::text[] end
    || case when p_status_basis = 'inferred' then array['inferred_status'] else '{}'::text[] end
  ) as r order by r)
$$;
