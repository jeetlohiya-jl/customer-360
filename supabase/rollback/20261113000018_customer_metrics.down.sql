-- Reverse of 20261113000018_customer_metrics.sql. Removes the stored numbers.
drop function if exists private.worker_slack_metrics(uuid, uuid[], integer);
drop function if exists public.metric_review(uuid, text);
drop function if exists public.customer_metrics(uuid, text, integer);
drop function if exists private.worker_extract_metrics(uuid, text, jsonb, jsonb);
drop table if exists private.customer_metrics;
