-- Step 3: run ONLY after the new code is deployed on Vercel (deployment shows Ready).
-- Turns on linking of colleagues' internal emails in customer threads and CRM tickets,
-- then searches past email for Preferred Packaging in David's, Glenn's and Cary's mailboxes.
-- Expected result of the select: 3

update private.settings set value = 'thread_and_named' where key = 'internal_linking';

select private.customer_backfill_as_owner(
  (select id from public.customers where normalized_name = 'preferred packaging'),
  'Preferred Packaging: cpflexpack.com, prefpkg.com and "Pref" added (2026-10-23)');
