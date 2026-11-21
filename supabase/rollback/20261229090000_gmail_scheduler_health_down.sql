-- Rollback of 20261229090000_gmail_scheduler_health: the scheduler tick and the schedule status of 20261225090000.
-- After this, deploy the earlier google-gmail-sync too (or keep the new one: it still accepts GOOGLE_CRON_SECRET;
-- without public.support_gmail_scheduler_secret_ok it simply refuses any other secret).

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

drop function if exists public.support_gmail_scheduler_secret_ok(text);
drop function if exists private.support_try_jsonb(text);
drop table if exists private.support_gmail_scheduler_calls;
