-- =============================================================================
-- Gmail automatic sync: scheduler authentication and real health status
--
-- Production finding (21 Nov 2026): every scheduled request of alton-gmail-sync (20261225090000) was answered
-- HTTP 401 "Not allowed." by google-gmail-sync, because the Vault secret alton_gmail_cron_secret sent by the
-- scheduler is a different value from the Edge Function secret GOOGLE_CRON_SECRET. pg_cron still reported every run
-- as "succeeded" (the tick only queues the HTTP request with pg_net), so the settings screen said "Up to date" while
-- no scheduled sync ever reached Gmail; mail arrived only with Sync now.
--
-- Additive:
--   * public.support_gmail_scheduler_secret_ok(secret): service role only; google-gmail-sync also accepts the Vault
--     scheduler secret, so the database scheduler has one source of truth (its own Vault secret).
--   * private.support_gmail_scheduler_calls: the pg_net request id of every scheduled request (kept 3 days), so the
--     answer of each run can be read from net._http_response.
--   * private.support_gmail_sync_tick(): unchanged request; records the call.
--   * public.support_gmail_schedule_status(): adds the answers of the recent runs, a health verdict and diagnosis,
--     the last successful scheduled and mailbox sync, and the last email stored. Never a secret.
--
-- No email, attachment, credential, checkpoint or queue row is changed.
-- Rollback: supabase/rollback/20261229090000_gmail_scheduler_health_down.sql
-- =============================================================================

create table if not exists private.support_gmail_scheduler_calls (
  id          bigint generated always as identity primary key,
  called_at   timestamptz not null default now(),
  outcome     text not null check (outcome in ('requested', 'no connected mailbox', 'pg_net / vault not available', 'not configured')),
  request_id  bigint
);
create index if not exists support_gmail_scheduler_calls_at_idx on private.support_gmail_scheduler_calls (called_at desc);
revoke all on table private.support_gmail_scheduler_calls from public, anon, authenticated;

-- The scheduler's Vault secret, compared inside the database (the value never leaves it).
create or replace function public.support_gmail_scheduler_secret_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_secret is null or length(p_secret) < 16 or to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using 'alton_gmail_cron_secret';
  return v is not null and length(btrim(v)) >= 16 and btrim(v) = p_secret;
end;
$$;
revoke all on function public.support_gmail_scheduler_secret_ok(text) from public, anon, authenticated;
grant execute on function public.support_gmail_scheduler_secret_ok(text) to service_role;

-- A response body as JSON, or null when it is not JSON.
create or replace function private.support_try_jsonb(p text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p::jsonb;
exception when others then
  return null;
end;
$$;
revoke all on function private.support_try_jsonb(text) from public, anon, authenticated;

create or replace function private.support_gmail_sync_tick()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_req bigint;
begin
  delete from private.support_gmail_scheduler_calls where called_at < now() - interval '3 days';
  if not exists (select 1 from public.support_email_config where is_enabled) then
    insert into private.support_gmail_scheduler_calls (outcome) values ('no connected mailbox');
    return 'no connected mailbox';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    insert into private.support_gmail_scheduler_calls (outcome) values ('pg_net / vault not available');
    return 'pg_net / vault not available';
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_url using 'alton_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'alton_gmail_cron_secret';
  if v_url is null or v_secret is null or v_url !~ '^https://[a-z0-9-]+\.supabase\.(co|in)/?$' then
    raise warning 'Gmail auto-sync: Vault secrets alton_project_url / alton_gmail_cron_secret are missing or invalid.';
    insert into private.support_gmail_scheduler_calls (outcome) values ('not configured');
    return 'not configured';
  end if;
  -- Asynchronous: pg_net sends the request in the background; its answer lands in net._http_response (request id).
  execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
    into v_req
    using rtrim(v_url, '/') || '/functions/v1/google-gmail-sync', '{"action":"sync"}'::jsonb, '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', btrim(v_secret)), 60000;
  insert into private.support_gmail_scheduler_calls (outcome, request_id) values ('requested', v_req);
  return 'requested';
end;
$$;
revoke all on function private.support_gmail_sync_tick() from public, anon, authenticated;

-- Settings → Email: the scheduler and what its runs actually did for this company's mailbox (never a secret).
--   health: OK (the latest answered run synced this mailbox) | FAILING (refused, timed out, errored or Gmail failed)
--           | WAITING (no answer yet) | NOT_CONFIGURED | NOT_SCHEDULED
create or replace function public.support_gmail_schedule_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  v_account uuid := (select channel_account_id from public.support_email_config where company_id = v_company);
  v_job jsonb;
  v_last jsonb;
  v_secrets boolean := false;
  v_calls jsonb := '[]'::jsonb;
  v_latest jsonb;
  v_health text;
  v_diag text;
  v_last_ok timestamptz;
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

  -- The answers of the recent scheduled requests (pg_net keeps them for a few hours).
  if to_regclass('net._http_response') is not null then
    execute $q$
      select coalesce(jsonb_agg(x.c order by x.id desc), '[]'::jsonb) from (
        select k.id, jsonb_build_object('id', k.id, 'called_at', k.called_at, 'outcome', k.outcome, 'http_status', r.status_code, 'timed_out', r.timed_out,
          'error', left(r.error_msg, 200), 'answered', r.id is not null,
          'result', (select e from jsonb_array_elements(coalesce(private.support_try_jsonb(r.content::text) -> 'results', '[]'::jsonb)) e where e ->> 'account' = $1::text limit 1),
          'refusal', case when r.status_code >= 400 then left(private.support_try_jsonb(r.content::text) ->> 'error', 200) end) as c
        from private.support_gmail_scheduler_calls k left join net._http_response r on r.id = k.request_id
        order by k.id desc limit 10) x $q$ into v_calls using v_account;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'called_at', k.called_at, 'outcome', k.outcome, 'answered', false) order by k.id desc), '[]'::jsonb) into v_calls
    from (select * from private.support_gmail_scheduler_calls order by id desc limit 10) k;
  end if;
  select c into v_latest from jsonb_array_elements(v_calls) c
  where c ->> 'outcome' <> 'requested' or (c ->> 'answered')::boolean order by (c ->> 'id')::bigint desc limit 1;
  select max((c ->> 'called_at')::timestamptz) into v_last_ok from jsonb_array_elements(v_calls) c
  where (c ->> 'http_status')::int between 200 and 299 and coalesce((c -> 'result' ->> 'ok')::boolean, false);

  v_health := case
    when v_job is null then 'NOT_SCHEDULED'
    when not v_secrets then 'NOT_CONFIGURED'
    when v_latest is null then 'WAITING'
    when v_latest ->> 'outcome' = 'not configured' then 'NOT_CONFIGURED'
    when v_latest ->> 'outcome' <> 'requested' then 'FAILING'
    when coalesce((v_latest ->> 'timed_out')::boolean, false) or v_latest ->> 'error' is not null then 'FAILING'
    when (v_latest ->> 'http_status')::int not between 200 and 299 then 'FAILING'
    when v_latest -> 'result' is null or v_latest -> 'result' = 'null'::jsonb then 'FAILING'
    when not coalesce((v_latest -> 'result' ->> 'ok')::boolean, false) then 'FAILING'
    else 'OK' end;
  v_diag := case
    when v_health = 'NOT_SCHEDULED' then 'The database job alton-gmail-sync is not scheduled.'
    when v_health = 'NOT_CONFIGURED' then 'The Vault secrets alton_project_url / alton_gmail_cron_secret are missing or invalid.'
    when v_health <> 'FAILING' then null
    when v_latest ->> 'outcome' <> 'requested' then 'The scheduler could not send its request: ' || (v_latest ->> 'outcome') || '.'
    when (v_latest ->> 'http_status')::int = 401 then 'google-gmail-sync refused the scheduler (HTTP 401): the Vault secret alton_gmail_cron_secret is not accepted. '
      || 'Deploy the updated google-gmail-sync function (it accepts the Vault secret) or store the GOOGLE_CRON_SECRET value in Vault.'
    when coalesce((v_latest ->> 'timed_out')::boolean, false) then 'The request to google-gmail-sync timed out.'
    when v_latest ->> 'error' is not null then 'The request to google-gmail-sync failed: ' || (v_latest ->> 'error')
    when (v_latest ->> 'http_status')::int not between 200 and 299 then 'google-gmail-sync answered HTTP ' || (v_latest ->> 'http_status') || coalesce(': ' || (v_latest ->> 'refusal'), '') || '.'
    when v_latest -> 'result' is null or v_latest -> 'result' = 'null'::jsonb then 'The scheduled run did not process this mailbox (is it connected and enabled?).'
    else 'The scheduled run reached Gmail but failed: ' || coalesce(v_latest -> 'result' ->> 'message', 'unknown error') end;

  return jsonb_build_object('scheduler_available', to_regclass('cron.job') is not null, 'scheduled', v_job is not null, 'job', v_job,
    'secrets_configured', v_secrets, 'last_run', v_last,
    'health', v_health, 'diagnosis', v_diag, 'calls', v_calls, 'last_call', v_latest,
    'last_scheduled_success_at', v_last_ok,
    'last_invocation_at', (select max(called_at) from private.support_gmail_scheduler_calls),
    'mailbox', (select jsonb_build_object(
        'last_batch_at', s.last_batch_at,
        'last_success_at', case when s.last_error_at is null or s.last_batch_at > s.last_error_at then s.last_batch_at end,
        'last_error', s.last_error, 'last_error_at', s.last_error_at, 'history_at', s.history_at)
      from public.support_email_sync_state s where s.channel_account_id = v_account),
    'last_email_stored_at', (select max(m.created_at) from public.support_email_messages m where m.channel_account_id = v_account and m.direction = 'INBOUND'),
    'emails_stored_24h', (select count(*) from public.support_email_messages m where m.channel_account_id = v_account and m.direction = 'INBOUND' and m.created_at > now() - interval '24 hours'));
end;
$$;
revoke all on function public.support_gmail_schedule_status() from public, anon;
grant execute on function public.support_gmail_schedule_status() to authenticated;
