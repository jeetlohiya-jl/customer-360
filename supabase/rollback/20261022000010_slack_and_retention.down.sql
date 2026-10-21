-- Reverse of 20261022000010_slack_and_retention.sql.
-- Restores the 0006 disconnect/departure rule (links and facts deleted in both
-- cases) and removes the Slack functions, tables and setting.
-- Slack ids already linked on public.app_users.slack_user_id are left as they are
-- (that column predates 0010).
drop function if exists private.worker_slack_facts(uuid, uuid[], boolean, integer);
drop function if exists private.worker_slack_customers(text);
drop function if exists private.worker_slack_allow(uuid);
drop function if exists private.worker_slack_user(text, text);
drop function if exists private.worker_slack_event_seen(text);
drop function if exists private.user_can_see_fact(uuid, uuid, text);
drop table if exists private.slack_usage;
drop table if exists private.slack_events;
delete from private.settings where key = 'slack_questions_per_hour';

create or replace function private.on_gmail_connection_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.message_links where owner_id = old.user_id;
  delete from private.review_occurrences where owner_id = old.user_id;
  update private.scan_jobs set status = 'cancelled', finished_at = now(), lease_until = null, updated_at = now()
   where owner_id = old.user_id and status in ('queued', 'running', 'cancelling', 'paused_auth');
  insert into public.audit_log (actor, action, target) values (null, 'scan.data_deleted_on_disconnect', old.user_id::text);
  return old;
end;
$$;
