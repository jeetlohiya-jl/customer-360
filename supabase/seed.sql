-- SYNTHETIC local development data. Loaded only by `supabase db reset` on a
-- local stack. Never run against a hosted project. No real people or email.

-- Local stacks and database tests: any synthetic Workspace account is active.
-- (Hosted: invite-only since 0014; supabase/tests/014 covers invite mode.)
update private.settings set value = 'workspace' where key = 'access_mode';

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
values
  ('11111111-1111-4111-8111-111111111111', 'synthetic.admin@gocirkla.com',
   '{"custom_claims":{"hd":"gocirkla.com"},"full_name":"Synthetic Admin"}', '{"provider":"google","providers":["google"]}', now()),
  ('22222222-2222-4222-8222-222222222222', 'synthetic.sales@gocirkla.com',
   '{"custom_claims":{"hd":"gocirkla.com"},"full_name":"Synthetic Sales"}', '{"provider":"google","providers":["google"]}', now()),
  ('33333333-3333-4333-8333-333333333333', 'synthetic.ops@gocirkla.com',
   '{"custom_claims":{"hd":"gocirkla.com"},"full_name":"Synthetic Ops"}', '{"provider":"google","providers":["google"]}', now())
on conflict (id) do nothing;

select private.grant_initial_admin('synthetic.admin@gocirkla.com');
