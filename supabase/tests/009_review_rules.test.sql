-- Review rules after the first real pilot (migration 0009).
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is(private.fact_review_reasons('follow_up', 'request', 'explicit', 'inferred', 0.62, '{}'), '{}'::text[],
  'an open fact with an inferred status and ordinary confidence is not sent to review');
select is(private.fact_review_reasons('requirement', 'report', 'explicit', 'explicit', 0.55, '{}'), '{}'::text[],
  'confidence 0.55 is no longer flagged on its own');
select is(private.fact_review_reasons('requirement', 'report', 'explicit', 'explicit', 0.45, '{}'), array['low_confidence'],
  'confidence under 0.50 is still flagged');
select is(private.fact_review_reasons('pricing', 'commitment', 'explicit', 'none', 0.85, '{}'), array['commitment_needs_check'],
  'an agreed price under 0.90 is still flagged');
select is(private.fact_review_reasons('order', 'commitment', 'explicit', 'explicit', 0.95, '{}'), '{}'::text[],
  'a confident, checked order commitment passes');
select is(private.fact_review_reasons('quality_issue', 'report', 'explicit', 'inferred', 0.9, array['inferred_status']), array['inferred_status'],
  'an inferred resolution flagged by the worker still goes to review');
select is(private.fact_review_reasons('order', 'request', 'explicit', 'explicit', 0.9, array['quote_not_found', 'number_not_in_text']),
  array['number_not_in_text', 'quote_not_found'], 'every check-based reason from the worker is kept');

select * from finish();
rollback;
