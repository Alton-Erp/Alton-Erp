-- =============================================================================
-- Support Centre live updates: automatic Gmail sync, unread badges, missed calls to handle.
--
-- Additive only. No message, email, call, credential or mailbox row is changed by this migration.
--
--   1. Automatic Gmail sync: pg_cron runs private.support_gmail_sync_tick() every 2 minutes; it POSTs to the
--      existing Edge Function google-gmail-sync with the scheduler secret (x-cron-secret) through pg_net. The
--      secret and the project URL are read from Supabase Vault at run time (never written in a migration):
--        select vault.create_secret('https://<project-ref>.supabase.co', 'alton_project_url');
--        select vault.create_secret('<GOOGLE_CRON_SECRET>', 'alton_gmail_cron_secret');
--      The job is created only where pg_cron and pg_net exist (Supabase); elsewhere nothing is scheduled.
--      Overlapping runs are harmless: the function takes a per-mailbox database lock (20261224090000).
--   2. public.support_live_summary(): the sidebar badge counts and change stamps (support.view; counts only).
--        WhatsApp  conversations with unread messages (the conversation-level read model of the WhatsApp screen)
--        Emails    unread received emails in the Inbox (not archived, snoozed, spam or trash; sent mail never counts)
--        Calls     missed incoming calls not handled yet: no later answered call with the same number, the
--                  conversation not resolved, not marked handled (support_calls.handled_at)
--   3. public.support_calls_mark_handled(ids): marks missed calls handled (support.reply).
--   4. Realtime: support_conversations and support_whatsapp_messages join the supabase_realtime publication (RLS
--      applies: only users with support.view of the company receive changes). support_call_signals already is.
-- Rollback: supabase/rollback/20261225090000_support_live_updates_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Missed calls: handled by an agent
-- -----------------------------------------------------------------------------
alter table public.support_calls add column if not exists handled_at timestamptz;
alter table public.support_calls add column if not exists handled_by uuid;
grant select (handled_at, handled_by) on public.support_calls to authenticated;

create index if not exists support_calls_missed_idx on public.support_calls (company_id, created_at desc)
  where direction = 'INBOUND' and status = 'MISSED' and handled_at is null;
create index if not exists support_calls_number_idx on public.support_calls (company_id, customer_number_e164, created_at);
create index if not exists support_conversations_unread_idx on public.support_conversations (company_id, channel) where unread_count > 0;
create index if not exists support_conversations_updated_idx on public.support_conversations (company_id, channel, updated_at desc);
create index if not exists support_whatsapp_messages_updated_idx on public.support_whatsapp_messages (company_id, updated_at desc);
create index if not exists support_email_messages_updated_idx on public.support_email_messages (company_id, updated_at desc);

-- Missed calls that still need attention (one definition for the badge and for "mark all handled").
create or replace function private.support_missed_calls(p_company uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.support_calls c
  where c.company_id = p_company and c.direction = 'INBOUND' and c.status = 'MISSED' and c.handled_at is null
    and not exists (select 1 from public.support_conversations s where s.id = c.conversation_id and s.status = 'RESOLVED')
    -- Called back or called again and answered: handled.
    and not exists (select 1 from public.support_calls l
                    where l.company_id = c.company_id and c.customer_number_e164 is not null and l.customer_number_e164 = c.customer_number_e164
                      and l.created_at > c.created_at and l.answered_at is not null);
$$;
revoke all on function private.support_missed_calls(uuid) from public, anon, authenticated;

create or replace function public.support_calls_mark_handled(p_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_ids uuid[];
begin
  if p_ids is not null and cardinality(p_ids) > 500 then
    raise exception 'At most 500 calls at a time.' using errcode = 'P0001';
  end if;
  -- null = every missed call that currently needs attention.
  select coalesce(array_agg(id), '{}') into v_ids from private.support_missed_calls(v_company) id
  where p_ids is null or id = any (p_ids);
  update public.support_calls set handled_at = now(), handled_by = auth.uid() where id = any (v_ids) and company_id = v_company;
  -- The call screens and badges listen to the signal rows.
  update public.support_call_signals set updated_at = now() where call_id = any (v_ids);
  if cardinality(v_ids) > 0 then
    perform private.support_audit(v_company, 'call.missed_handled', 'support_calls', null, jsonb_build_object('calls', to_jsonb(v_ids)));
  end if;
  return jsonb_build_object('handled', cardinality(v_ids));
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Badge counts and change stamps (read-only; called every few seconds, so only indexed aggregates)
-- -----------------------------------------------------------------------------
create or replace function public.support_live_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return jsonb_build_object(
    'whatsapp_unread', (select count(*) from public.support_conversations s where s.company_id = v_company and s.channel = 'WHATSAPP' and s.unread_count > 0),
    -- Inbox rule of support_email_mailbox: received mail, not in Spam / Trash, not archived or snoozed unless the
    -- customer wrote after that. Only conversations with unread mail are looked at.
    'email_unread', (
      select coalesce(sum(s.unread_count), 0) from public.support_conversations s
      left join public.support_email_thread_state st on st.conversation_id = s.id
      join lateral (select max(m.created_at) filter (where m.direction = 'INBOUND') as in_stored, bool_or(m.direction = 'INBOUND') as has_in
                    from public.support_email_messages m where m.conversation_id = s.id and m.duplicate_of is null) a on a.has_in
      where s.company_id = v_company and s.channel = 'EMAIL' and s.unread_count > 0
        and coalesce(st.folder, 'INBOX') not in ('SPAM', 'TRASH')
        -- (coalesce: a conversation without mailbox state has no state row; NULL must not exclude it)
        and not coalesce(st.folder = 'ARCHIVE' and (a.in_stored is null or a.in_stored <= st.folder_at), false)
        and not coalesce(st.snoozed_until > now() and (a.in_stored is null or a.in_stored <= st.snoozed_at), false)),
    'missed_calls', (select count(*) from private.support_missed_calls(v_company)),
    -- Change stamps: a page reloads its data only when its stamp moves.
    'stamps', jsonb_build_object(
      'whatsapp', greatest((select max(updated_at) from public.support_conversations where company_id = v_company and channel = 'WHATSAPP'),
                           (select max(updated_at) from public.support_whatsapp_messages where company_id = v_company)),
      'email', greatest((select max(updated_at) from public.support_conversations where company_id = v_company and channel = 'EMAIL'),
                        (select max(updated_at) from public.support_email_messages where company_id = v_company),
                        (select max(updated_at) from public.support_email_thread_state where company_id = v_company)),
      'calls', greatest((select max(updated_at) from public.support_call_signals where company_id = v_company),
                        (select max(updated_at) from public.support_conversations where company_id = v_company and channel = 'PHONE'))),
    'at', now());
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_live_summary', 'support_calls_mark_handled') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Realtime (Supabase only): conversation and WhatsApp message changes reach the screens at once
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['support_conversations', 'support_whatsapp_messages'] loop
      if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Automatic Gmail sync every 2 minutes (pg_cron + pg_net; secrets from Vault)
-- -----------------------------------------------------------------------------
create or replace function private.support_gmail_sync_tick()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.support_email_config where is_enabled) then
    return 'no connected mailbox';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return 'pg_net / vault not available';
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'alton_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'alton_gmail_cron_secret';
  if v_url is null or v_secret is null or v_url !~ '^https://[a-z0-9-]+\.supabase\.(co|in)/?$' then
    raise warning 'Gmail auto-sync: Vault secrets alton_project_url / alton_gmail_cron_secret are missing or invalid.';
    return 'not configured';
  end if;
  -- Asynchronous: pg_net sends the request in the background; the function answers within its own time budget.
  execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
    using rtrim(v_url, '/') || '/functions/v1/google-gmail-sync', '{"action":"sync"}'::jsonb, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret), 60000;
  return 'requested';
end;
$$;
revoke all on function private.support_gmail_sync_tick() from public, anon, authenticated;

-- Settings screen: is the automatic sync scheduled and configured (never the secret's value)?
create or replace function public.support_gmail_schedule_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  v_job jsonb;
  v_last jsonb;
  v_secrets boolean := false;
begin
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', schedule, 'active', active) from cron.job where jobname = 'alton-gmail-sync' limit 1$q$ into v_job;
    if to_regclass('cron.job_run_details') is not null then
      execute $q$select jsonb_build_object('status', d.status, 'start_time', d.start_time, 'message', left(d.return_message, 300))
                 from cron.job_run_details d join cron.job j on j.jobid = d.jobid where j.jobname = 'alton-gmail-sync' order by d.start_time desc limit 1$q$ into v_last;
    end if;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute $q$select count(*) = 2 from vault.decrypted_secrets where name in ('alton_project_url', 'alton_gmail_cron_secret') and decrypted_secret <> ''$q$ into v_secrets;
  end if;
  return jsonb_build_object('scheduler_available', to_regclass('cron.job') is not null, 'scheduled', v_job is not null, 'job', v_job,
    'secrets_configured', v_secrets, 'last_run', v_last);
end;
$$;
revoke all on function public.support_gmail_schedule_status() from public, anon;
grant execute on function public.support_gmail_schedule_status() to authenticated;

do $$
begin
  -- Supabase provides both extensions; they are enabled here only when the server has them.
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'alton-gmail-sync') then
      perform cron.unschedule('alton-gmail-sync');
    end if;
    perform cron.schedule('alton-gmail-sync', '*/2 * * * *', 'select private.support_gmail_sync_tick()');
  end if;
end;
$$;
