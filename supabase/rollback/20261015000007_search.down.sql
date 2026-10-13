-- Reverse of 20261015000007_search.sql (Stage 3.2 search).
-- Removes the search functions and the pagination index only. No table or
-- data is touched; every message link stays exactly as it was.
drop function if exists public.admin_link_counts(text, uuid, date, date, integer, integer);
drop function if exists public.my_linked_customers();
drop function if exists public.search_my_links(text, uuid, date, date, text, text, timestamptz, uuid, integer);
drop function if exists private.like_escape(text);
drop index if exists private.message_links_owner_time_id;
