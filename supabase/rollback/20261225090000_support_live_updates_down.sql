-- Rollback of 20261225090000_support_live_updates.
-- Stops the automatic Gmail sync job, removes the badge / handled-call functions, the two tables from the Realtime
-- publication and the indexes, and the handled_at / handled_by columns of support_calls (only the "handled" marks
-- made since; no call, message or email is deleted). pg_cron and pg_net stay enabled (other jobs may use them).
-- The Vault secrets alton_project_url / alton_gmail_cron_secret are left for an administrator to delete.
do $$
begin
  if to_regclass('cron.job') is not null and exists (select 1 from cron.job where jobname = 'alton-gmail-sync') then
    perform cron.unschedule('alton-gmail-sync');
  end if;
end;
$$;
drop function if exists public.support_gmail_schedule_status();
drop function if exists private.support_gmail_sync_tick();
drop function if exists public.support_live_summary();
drop function if exists public.support_calls_mark_handled(uuid[]);
drop function if exists private.support_missed_calls(uuid);
do $$
declare
  t text;
begin
  foreach t in array array['support_conversations', 'support_whatsapp_messages'] loop
    if exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end;
$$;
drop index if exists public.support_calls_missed_idx;
drop index if exists public.support_calls_number_idx;
drop index if exists public.support_conversations_unread_idx;
drop index if exists public.support_conversations_updated_idx;
drop index if exists public.support_whatsapp_messages_updated_idx;
drop index if exists public.support_email_messages_updated_idx;
alter table public.support_calls drop column if exists handled_by;
alter table public.support_calls drop column if exists handled_at;
