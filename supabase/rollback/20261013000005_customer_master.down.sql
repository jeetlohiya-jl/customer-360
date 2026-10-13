-- Reverses 20261013000005_customer_master.sql. DESTRUCTIVE: deletes the
-- customer master, aliases, identifiers, review decisions and queue.
-- Export the customer list first. Run only with explicit approval.
drop function if exists public.name_rejection_remove(text);
drop function if exists public.review_resolve(uuid, text, uuid);
drop function if exists public.review_queue_list(integer);
drop function if exists public.review_queue_add(text, jsonb, text);
drop function if exists public.customers_unmark_distinct(uuid, uuid);
drop function if exists public.customers_mark_distinct(uuid, uuid);
drop function if exists public.customer_set_status(uuid, text);
drop function if exists public.customer_remove_identifier(uuid);
drop function if exists public.customer_add_identifier(uuid, text, text, boolean);
drop function if exists public.customer_remove_alias(uuid);
drop function if exists public.customer_add_alias(uuid, text, text);
drop function if exists public.import_customers(jsonb, text);

drop table if exists private.review_items;
drop table if exists public.name_rejections;
drop table if exists public.customer_distinctions;
drop table if exists public.customer_identifiers;
drop table if exists public.customer_aliases;
drop table if exists public.customers;

drop function if exists private.mark_distinct(uuid, uuid);
drop function if exists private.add_identifier(uuid, text, text, boolean, text);
drop function if exists private.add_alias(uuid, text, text, text);
drop function if exists private.bump_alias_version();
drop function if exists private.require_admin();
drop function if exists private.identifiers_guard();
drop function if exists private.aliases_name_guard();
drop function if exists private.customers_name_guard();
drop function if exists private.is_blocked_customer_domain(text);
drop function if exists private.is_valid_domain(text);
drop function if exists private.normalize_domain(text);
drop function if exists private.normalize_name(text);
