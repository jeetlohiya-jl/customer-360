-- Reverse of 0016: the Slack worker reads at most 120 facts per question again (the 0015 definition).

create or replace function private.worker_slack_facts(p_user uuid, p_customers uuid[], p_show_owner boolean, p_limit integer)
returns table (
  fact_id uuid, customer_id uuid, customer_name text, fact_type text, stance text, party text, basis text,
  status text, status_basis text, stale boolean, product text, quantity numeric, unit text, unit_price numeric,
  currency text, price_basis text, due_date date, due_text text, reference text, summary text, evidence_quote text,
  confidence numeric, review_state text, message_at timestamptz, direction text, is_mine boolean,
  source_owner_email text, mailbox_email text, gmail_message_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.customer_id, c.canonical_name, f.fact_type, f.stance, f.party, f.basis,
         f.status, f.status_basis,
         (f.status = 'open' and f.message_at < now() - interval '30 days'
          and not exists (select 1 from private.customer_facts g where g.resolves_fact_id = f.id)),
         f.product, f.quantity, f.unit, f.unit_price, f.currency, f.price_basis,
         f.due_date, f.due_text, f.reference, f.summary, f.evidence_quote, f.confidence,
         f.review_state, f.message_at, f.direction, f.owner_id = p_user,
         case when f.owner_id = p_user or coalesce(p_show_owner, false) then u.email end,
         case when f.owner_id = p_user then u.email end,
         case when f.owner_id = p_user then f.gmail_message_id end
    from private.customer_facts f
    join public.customers c on c.id = f.customer_id
    join public.app_users u on u.id = f.owner_id
    -- 0015: the asker's rights are read once (me), not per fact; same rule as private.user_can_see_fact.
    cross join (
      select a.id, a.role = 'admin' as admin,
             coalesce((select value from private.settings where key = 'facts_visibility'), 'reviewers') = 'all' as see_all
        from public.app_users a
       where a.id = p_user and a.status = 'active'
    ) me
   where f.customer_id = any (coalesce(p_customers, '{}'))
     and cardinality(p_customers) between 1 and 5
     and ((f.review_state in ('auto', 'confirmed', 'corrected') and (f.owner_id = me.id or me.admin or me.see_all))
          or (f.review_state = 'needs_review' and (f.owner_id = me.id or me.admin)))
   order by f.message_at desc, f.id desc
   limit least(greatest(coalesce(p_limit, 60), 1), 120)
$$;
