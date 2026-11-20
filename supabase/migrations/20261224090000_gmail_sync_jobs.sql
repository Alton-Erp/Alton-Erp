-- =============================================================================
-- Resumable Gmail synchronisation (google-gmail-sync, google-gmail-webhook).
--
-- Additive only: three new tables and new functions. No email, attachment, credential or mailbox-state row is
-- changed or deleted; support_gmail_ingest, support_gmail_attachment_result and the sending functions are unchanged.
--
-- Why: one invocation used to list up to 2,000 message ids, fetch up to 300 messages (format=full) and download
-- and upload every attachment of each, sequentially. That exceeds the Edge Function resource limits (HTTP 546).
-- Work is now split into small batches whose progress is stored here, so any invocation can stop at any point
-- (time budget, worker limit, network error) and the next one continues where it stopped.
--
--   support_email_sync_state   one row per mailbox: the database lock (owner + expiry, stale locks are taken
--                              over), the history checkpoint (mirrored to support_email_config.last_history_id
--                              at the end of a run), last batch diagnostics.
--   support_email_sync_jobs    full re-syncs: Gmail query and date range, start history id, page token, discovery
--                              state, counts, status (RUNNING / COMPLETED / FAILED). One RUNNING job per mailbox.
--   support_email_sync_queue   durable list of Gmail message ids still to fetch (unique per mailbox): from history,
--                              full-sync discovery, reconciliation or replay; attempts with backoff; DONE / FAILED.
--
-- Attachments are a separate stage: ingest records the parts (PENDING, as before); later batches download a few
-- at a time. support_gmail_attachment_failed keeps an attempt count (5 tries with backoff) in the part.
--
-- Every write function checks that the caller still holds the mailbox lock, so a worker that lost its lock (it
-- ran past the expiry and another worker took over) cannot change progress.
-- Rollback: supabase/rollback/20261224090000_gmail_sync_jobs_down.sql
-- =============================================================================

create table if not exists public.support_email_sync_state (
  channel_account_id  uuid primary key,
  company_id          uuid not null references public.companies (id) on delete restrict,
  lock_owner          uuid,
  lock_until          timestamptz,
  lock_acquired_at    timestamptz,
  lock_ttl_seconds    integer not null default 120 check (lock_ttl_seconds between 30 and 900),
  -- Every message added to the mailbox up to this history id is stored or in the queue.
  history_id          text check (history_id is null or history_id ~ '^[0-9]{1,20}$'),
  history_at          timestamptz,
  last_reconcile_at   timestamptz,
  -- A Full re-sync asked for while another batch held the lock: the next batch starts it.
  full_requested_at   timestamptz,
  full_requested_by   uuid,
  batch_no            bigint not null default 0,
  last_batch_at       timestamptz,
  last_batch          jsonb not null default '{}'::jsonb,
  last_error          text check (last_error is null or length(last_error) <= 1000),
  last_error_stage    text check (last_error_stage is null or length(last_error_stage) <= 40),
  last_error_at       timestamptz,
  published_at        timestamptz,
  updated_at          timestamptz not null default now(),
  constraint support_email_sync_state_account_fk foreign key (channel_account_id, company_id)
    references public.support_channel_accounts (id, company_id) on delete cascade
);

create table if not exists public.support_email_sync_jobs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  kind                text not null default 'FULL' check (kind = 'FULL'),
  reason              text not null check (reason in ('MANUAL', 'INITIAL', 'HISTORY_EXPIRED')),
  status              text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  query               text not null check (length(query) <= 500),
  days                integer not null check (days between 1 and 30),
  start_history_id    text check (start_history_id is null or start_history_id ~ '^[0-9]{1,20}$'),
  page_token          text check (page_token is null or length(page_token) <= 4000),
  pages               integer not null default 0,
  discovery_restarts  integer not null default 0,
  discovery_done      boolean not null default false,
  discovered          integer not null default 0,
  processed           integer not null default 0,
  stored              integer not null default 0,
  duplicates          integer not null default 0,
  confirmed           integer not null default 0,
  ignored             integer not null default 0,
  failed              integer not null default 0,
  batches             integer not null default 0,
  last_batch_at       timestamptz,
  last_error          text check (last_error is null or length(last_error) <= 1000),
  failure_stage       text check (failure_stage is null or length(failure_stage) <= 40),
  requested_by        uuid,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  updated_at          timestamptz not null default now(),
  constraint support_email_sync_jobs_account_fk foreign key (channel_account_id, company_id)
    references public.support_channel_accounts (id, company_id) on delete cascade
);
create unique index if not exists support_email_sync_jobs_one_running on public.support_email_sync_jobs (channel_account_id) where status = 'RUNNING';
create index if not exists support_email_sync_jobs_account_idx on public.support_email_sync_jobs (channel_account_id, started_at desc);

create table if not exists public.support_email_sync_queue (
  id                  bigint generated always as identity primary key,
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  gmail_message_id    text not null check (gmail_message_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  source              text not null check (source in ('HISTORY', 'FULL', 'RECONCILE', 'REPLAY')),
  job_id              uuid references public.support_email_sync_jobs (id) on delete set null,
  state               text not null default 'PENDING' check (state in ('PENDING', 'DONE', 'FAILED')),
  result              text check (result is null or result in ('STORED', 'DUPLICATE', 'CONFIRMED', 'IGNORED')),
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  last_error          text check (last_error is null or length(last_error) <= 500),
  created_at          timestamptz not null default now(),
  done_at             timestamptz,
  constraint support_email_sync_queue_unique unique (channel_account_id, gmail_message_id),
  constraint support_email_sync_queue_account_fk foreign key (channel_account_id, company_id)
    references public.support_channel_accounts (id, company_id) on delete cascade
);
create index if not exists support_email_sync_queue_todo_idx on public.support_email_sync_queue (channel_account_id, next_attempt_at) where state = 'PENDING';
create index if not exists support_email_sync_queue_job_idx on public.support_email_sync_queue (job_id, state);

-- Emails with attachment parts still to download (the attachment stage reads only these).
create index if not exists support_email_messages_parts_todo_idx on public.support_email_messages (channel_account_id, created_at)
  where attachment_parts::text ~ '"state": "(PENDING|FAILED)"';

do $$
declare
  t text;
begin
  foreach t in array array['support_email_sync_state', 'support_email_sync_jobs', 'support_email_sync_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- The caller must still hold the lock; extends it (heartbeat). Raises LOCK_LOST otherwise.
create or replace function private.support_gmail_sync_hold(p_account uuid, p_owner uuid)
returns public.support_email_sync_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state;
begin
  update public.support_email_sync_state set lock_until = now() + make_interval(secs => lock_ttl_seconds), updated_at = now()
  where channel_account_id = p_account and lock_owner = p_owner and lock_until > now()
  returning * into s;
  if not found then
    raise exception 'LOCK_LOST: another sync took over this mailbox.' using errcode = 'P0001';
  end if;
  return s;
end;
$$;

-- Marks a job COMPLETED once discovery is done and none of its messages is still pending.
create or replace function private.support_gmail_sync_job_check(p_job uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.support_email_sync_jobs;
begin
  select * into j from public.support_email_sync_jobs where id = p_job for update;
  if not found or j.status <> 'RUNNING' or not j.discovery_done then
    return;
  end if;
  if exists (select 1 from public.support_email_sync_queue where job_id = j.id and state = 'PENDING') then
    return;
  end if;
  update public.support_email_sync_jobs set status = 'COMPLETED', finished_at = now(), page_token = null, updated_at = now() where id = j.id;
  update public.support_email_config set last_full_sync_at = now() where channel_account_id = j.channel_account_id;
  perform private.support_gmail_event(j.company_id, j.channel_account_id, 'MAIL_SYNC',
    format('Full re-sync completed: %s found, %s new, %s already stored, %s failed.', j.discovered, j.stored, j.duplicates, j.failed),
    jsonb_build_object('kind', 'FULL', 'job_id', j.id, 'discovered', j.discovered, 'stored', j.stored, 'duplicates', j.duplicates,
      'confirmed', j.confirmed, 'ignored', j.ignored, 'failed', j.failed, 'batches', j.batches), 'PROCESSED', null);
end;
$$;

-- Work left for a mailbox (also used by the status screen).
create or replace function private.support_gmail_sync_remaining(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'queue', (select count(*) from public.support_email_sync_queue q where q.channel_account_id = p_account and q.state = 'PENDING'),
    'queue_ready', (select count(*) from public.support_email_sync_queue q where q.channel_account_id = p_account and q.state = 'PENDING'
                      and q.next_attempt_at <= now()
                      and (q.source <> 'FULL' or q.job_id is null or exists (select 1 from public.support_email_sync_jobs j where j.id = q.job_id and j.discovery_done))),
    'failed', (select count(*) from public.support_email_sync_queue q where q.channel_account_id = p_account and q.state = 'FAILED'),
    'attachments', (select count(*) from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a
                    where m.channel_account_id = p_account and m.attachment_parts::text ~ '"state": "(PENDING|FAILED)"'
                      and a ->> 'state' in ('PENDING', 'FAILED') and coalesce((a ->> 'attempts')::integer, 0) < 5),
    'attachments_ready', (select count(*) from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a
                    where m.channel_account_id = p_account and m.gmail_message_id is not null and m.attachment_parts::text ~ '"state": "(PENDING|FAILED)"'
                      and a ->> 'state' in ('PENDING', 'FAILED') and coalesce((a ->> 'attempts')::integer, 0) < 5
                      and coalesce((a ->> 'retry_at')::timestamptz, '-infinity'::timestamptz) <= now()),
    'attachments_failed', (select count(*) from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a
                    where m.channel_account_id = p_account and m.attachment_parts::text ~ '"state": "(PENDING|FAILED)"'
                      and a ->> 'state' = 'FAILED' and coalesce((a ->> 'attempts')::integer, 0) >= 5),
    'discovery', exists (select 1 from public.support_email_sync_jobs j where j.channel_account_id = p_account and j.status = 'RUNNING' and not j.discovery_done));
$$;

-- -----------------------------------------------------------------------------
-- Service role (google-gmail-sync / google-gmail-webhook)
-- -----------------------------------------------------------------------------
-- Takes the mailbox lock (or reports BUSY). A lock past its expiry is stale (the worker died) and is taken over.
create or replace function public.support_gmail_sync_begin(p_account uuid, p_owner uuid, p_ttl_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
  s public.support_email_sync_state;
  v_stale boolean := false;
  j public.support_email_sync_jobs;
begin
  select * into c from public.support_email_config where channel_account_id = p_account;
  if not found then
    raise exception 'Email settings not found.' using errcode = 'P0001';
  end if;
  insert into public.support_email_sync_state (channel_account_id, company_id, history_id, history_at)
  values (p_account, c.company_id, c.last_history_id, case when c.last_history_id is not null then now() end)
  on conflict (channel_account_id) do nothing;
  select * into s from public.support_email_sync_state where channel_account_id = p_account for update;
  if s.lock_owner is not null and s.lock_until > now() and s.lock_owner <> p_owner then
    return jsonb_build_object('acquired', false, 'busy_until', s.lock_until);
  end if;
  v_stale := s.lock_owner is not null and s.lock_until <= now();
  update public.support_email_sync_state set lock_owner = p_owner, lock_acquired_at = now(),
    lock_ttl_seconds = greatest(30, least(900, coalesce(p_ttl_seconds, 120))),
    lock_until = now() + make_interval(secs => greatest(30, least(900, coalesce(p_ttl_seconds, 120)))), updated_at = now()
  where channel_account_id = p_account
  returning * into s;
  select * into j from public.support_email_sync_jobs where channel_account_id = p_account and status = 'RUNNING';
  return jsonb_build_object('acquired', true, 'stale_lock_recovered', v_stale, 'history_id', s.history_id, 'batch_no', s.batch_no,
    'needs_full', s.history_id is null or (c.last_full_sync_at is null and not exists (select 1 from public.support_email_sync_jobs x where x.channel_account_id = p_account)),
    'full_requested', s.full_requested_at is not null, 'full_requested_by', s.full_requested_by,
    'reconcile_due', s.last_reconcile_at is null or s.last_reconcile_at < now() - interval '15 minutes',
    'job', case when j.id is null then null else to_jsonb(j) end);
end;
$$;

-- Starts a full re-sync, or returns the one already running (a second click resumes it).
-- With no checkpoint yet, or when Gmail said the old one expired, history continues from now: older mail is
-- covered by this job's search.
create or replace function public.support_gmail_sync_job_start(p_account uuid, p_owner uuid, p_history_id text, p_query text, p_days integer, p_reason text,
  p_by uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
  j public.support_email_sync_jobs;
begin
  if p_history_id is not null and p_history_id !~ '^[0-9]{1,20}$' then
    raise exception 'Invalid history id.' using errcode = 'P0001';
  end if;
  select * into j from public.support_email_sync_jobs where channel_account_id = p_account and status = 'RUNNING';
  if found then
    update public.support_email_sync_state set full_requested_at = null, full_requested_by = null where channel_account_id = p_account;
    return jsonb_build_object('created', false, 'job', to_jsonb(j));
  end if;
  insert into public.support_email_sync_jobs (company_id, channel_account_id, reason, query, days, start_history_id, requested_by)
  values (s.company_id, p_account, p_reason, left(p_query, 500), p_days, p_history_id, p_by)
  returning * into j;
  if p_history_id is not null and (s.history_id is null or p_reason = 'HISTORY_EXPIRED') then
    update public.support_email_sync_state set history_id = p_history_id, history_at = now() where channel_account_id = p_account;
  end if;
  update public.support_email_sync_state set full_requested_at = null, full_requested_by = null where channel_account_id = p_account;
  perform private.support_gmail_event(s.company_id, p_account, 'MAIL_SYNC', 'Full re-sync started (' || lower(replace(p_reason, '_', ' ')) || ').',
    jsonb_build_object('kind', 'FULL', 'job_id', j.id, 'query', j.query), null, null);
  return jsonb_build_object('created', true, 'job', to_jsonb(j));
end;
$$;

-- One page of full-sync discovery: queues the ids not stored yet and saves the page token. p_restart: the page
-- token expired, discovery starts again from the first page (ids already queued or stored are skipped).
create or replace function public.support_gmail_sync_discovered(p_account uuid, p_owner uuid, p_job uuid, p_ids text[], p_next_page text, p_restart boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
  j public.support_email_sync_jobs;
  v_added integer := 0;
begin
  select * into j from public.support_email_sync_jobs where id = p_job and channel_account_id = p_account for update;
  if not found or j.status <> 'RUNNING' then
    raise exception 'Full re-sync job not running.' using errcode = 'P0001';
  end if;
  if p_restart then
    update public.support_email_sync_jobs set page_token = null, pages = 0, discovery_restarts = discovery_restarts + 1, updated_at = now() where id = j.id;
    return jsonb_build_object('added', 0, 'restarts', j.discovery_restarts + 1);
  end if;
  -- Ids keep Gmail's order (queue ids follow it: the processing order depends on it).
  with ids as (
    select x, min(o) as o from unnest(coalesce(p_ids, '{}')) with ordinality u (x, o) where x ~ '^[A-Za-z0-9_-]{6,64}$' group by x
  ), todo as (
    select x, o from ids where not exists (select 1 from public.support_email_messages m where m.company_id = s.company_id and m.gmail_message_id = ids.x)
  ), ins as (
    insert into public.support_email_sync_queue (company_id, channel_account_id, gmail_message_id, source, job_id)
    select s.company_id, p_account, x, 'FULL', j.id from todo order by o
    on conflict (channel_account_id, gmail_message_id) do update
      set state = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null, job_id = excluded.job_id, source = 'FULL', done_at = null
      where public.support_email_sync_queue.state = 'FAILED'
    returning 1
  )
  select count(*) into v_added from ins;
  update public.support_email_sync_jobs set pages = pages + 1, page_token = p_next_page, discovery_done = p_next_page is null,
    discovered = discovered + v_added, updated_at = now() where id = j.id;
  perform private.support_gmail_sync_job_check(j.id);
  return jsonb_build_object('added', v_added, 'done', p_next_page is null);
end;
$$;

-- Queues message ids from history, reconciliation or a replay. For HISTORY the checkpoint moves forward in the
-- same transaction: ids up to it are durable here even if this worker dies right after.
create or replace function public.support_gmail_sync_enqueue(p_account uuid, p_owner uuid, p_ids text[], p_source text, p_history_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
  v_added integer := 0;
begin
  if p_source not in ('HISTORY', 'RECONCILE', 'REPLAY') then
    raise exception 'Unknown source %.', p_source using errcode = 'P0001';
  end if;
  if p_history_id is not null and (p_history_id !~ '^[0-9]{1,20}$' or p_source <> 'HISTORY') then
    raise exception 'Invalid history id.' using errcode = 'P0001';
  end if;
  with ids as (
    select x, min(o) as o from unnest(coalesce(p_ids, '{}')) with ordinality u (x, o) where x ~ '^[A-Za-z0-9_-]{6,64}$' group by x
  ), ins as (
    insert into public.support_email_sync_queue (company_id, channel_account_id, gmail_message_id, source)
    select s.company_id, p_account, x, p_source from ids
    where not exists (select 1 from public.support_email_messages m where m.company_id = s.company_id and m.gmail_message_id = ids.x)
    order by o
    on conflict (channel_account_id, gmail_message_id) do update
      set state = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null, done_at = null
      where public.support_email_sync_queue.state = 'FAILED' and excluded.source = 'REPLAY'
    returning 1
  )
  select count(*) into v_added from ins;
  update public.support_email_sync_state set
    history_id = case when p_history_id is not null and (history_id is null or p_history_id::numeric > history_id::numeric) then p_history_id else history_id end,
    history_at = case when p_history_id is not null then now() else history_at end,
    last_reconcile_at = case when p_source = 'RECONCILE' then now() else last_reconcile_at end
  where channel_account_id = p_account;
  return jsonb_build_object('added', v_added);
end;
$$;

-- The next messages to fetch: history / reconciliation / replay first (oldest first), then full-sync messages
-- once their discovery is complete (discovered newest first, so the highest id is the oldest).
create or replace function public.support_gmail_sync_next(p_account uuid, p_owner uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'gmail_message_id', q.gmail_message_id, 'source', q.source, 'attempts', q.attempts, 'job_id', q.job_id)
                                    order by q.k1, q.k2)
    from (select q.*, case when q.source = 'FULL' then 1 else 0 end as k1, case when q.source = 'FULL' then -q.id else q.id end as k2
          from public.support_email_sync_queue q
          where q.channel_account_id = p_account and q.state = 'PENDING' and q.next_attempt_at <= now()
            and (q.source <> 'FULL' or q.job_id is null or exists (select 1 from public.support_email_sync_jobs j where j.id = q.job_id and j.discovery_done))
          order by k1, k2 limit greatest(1, least(coalesce(p_limit, 10), 100))) q), '[]'::jsonb);
end;
$$;

-- Outcome of one message. Failures are retried with backoff (1, 2, 4, 8 minutes); after 5 attempts the message is
-- FAILED (shown on the status screen; Retry puts it back).
create or replace function public.support_gmail_sync_item_result(p_account uuid, p_owner uuid, p_item bigint, p_ok boolean, p_result text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
  q public.support_email_sync_queue;
  v_final boolean := false;
begin
  select * into q from public.support_email_sync_queue where id = p_item and channel_account_id = p_account for update;
  if not found then
    raise exception 'Queue item not found.' using errcode = 'P0001';
  end if;
  if q.state <> 'PENDING' then
    return jsonb_build_object('state', q.state);
  end if;
  if p_ok then
    if p_result not in ('STORED', 'DUPLICATE', 'CONFIRMED', 'IGNORED') then
      raise exception 'Unknown result %.', p_result using errcode = 'P0001';
    end if;
    update public.support_email_sync_queue set state = 'DONE', result = p_result, done_at = now(), last_error = null where id = q.id;
  else
    v_final := q.attempts + 1 >= 5;
    update public.support_email_sync_queue set attempts = attempts + 1, last_error = left(p_error, 500),
      state = case when v_final then 'FAILED' else 'PENDING' end,
      next_attempt_at = now() + make_interval(mins => power(2, q.attempts)::integer)
    where id = q.id;
  end if;
  if q.job_id is not null and (p_ok or v_final) then
    update public.support_email_sync_jobs set processed = processed + 1,
      stored = stored + (p_ok and p_result = 'STORED')::integer, duplicates = duplicates + (p_ok and p_result = 'DUPLICATE')::integer,
      confirmed = confirmed + (p_ok and p_result = 'CONFIRMED')::integer, ignored = ignored + (p_ok and p_result = 'IGNORED')::integer,
      failed = failed + (not p_ok)::integer, updated_at = now()
    where id = q.job_id;
    perform private.support_gmail_sync_job_check(q.job_id);
  end if;
  return jsonb_build_object('state', case when p_ok then 'DONE' when v_final then 'FAILED' else 'PENDING' end);
end;
$$;

-- Attachment parts to download next (oldest emails first), skipping parts waiting for their retry time.
create or replace function public.support_gmail_sync_attachments_next(p_account uuid, p_owner uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
begin
  return coalesce((select jsonb_agg(x order by x.at, x.part_id) from (
      select m.id as email_id, m.gmail_message_id, a ->> 'part_id' as part_id, a ->> 'attachment_id' as attachment_id, a ->> 'filename' as filename,
             a ->> 'mime_type' as mime_type, nullif(a ->> 'size', '')::bigint as size, coalesce((a ->> 'attempts')::integer, 0) as attempts, m.created_at as at
      from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a
      where m.channel_account_id = p_account and m.gmail_message_id is not null and m.attachment_parts::text ~ '"state": "(PENDING|FAILED)"'
        and a ->> 'state' in ('PENDING', 'FAILED') and coalesce((a ->> 'attempts')::integer, 0) < 5
        and coalesce((a ->> 'retry_at')::timestamptz, '-infinity'::timestamptz) <= now()
      order by m.created_at, a ->> 'part_id'
      limit greatest(1, least(coalesce(p_limit, 5), 50))) x), '[]'::jsonb);
end;
$$;

-- A download or upload failed: the part stays FAILED with an attempt count and a retry time; after 5 attempts it is
-- no longer tried (Retry on the status screen resets it).
create or replace function public.support_gmail_attachment_failed(p_email uuid, p_part_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_email_messages;
begin
  select * into m from public.support_email_messages where id = p_email for update;
  if not found then
    raise exception 'Email not found.' using errcode = 'P0001';
  end if;
  update public.support_email_messages set attachment_parts = (
    select jsonb_agg(case when a ->> 'part_id' = p_part_id and a ->> 'state' in ('PENDING', 'FAILED')
                          then a || jsonb_build_object('state', 'FAILED', 'attempts', coalesce((a ->> 'attempts')::integer, 0) + 1,
                                                       'retry_at', now() + make_interval(mins => power(2, coalesce((a ->> 'attempts')::integer, 0))::integer),
                                                       'reason', left(case when coalesce((a ->> 'attempts')::integer, 0) + 1 >= 5 then 'Gave up after 5 attempts: ' else '' end
                                                                      || coalesce(p_reason, 'Download failed.'), 200))
                          else a end order by o)
    from jsonb_array_elements(m.attachment_parts) with ordinality as x (a, o))
  where id = m.id;
end;
$$;

-- Full re-sync asked for while another batch holds the lock (no lock needed: only the request is recorded).
create or replace function public.support_gmail_sync_request_full(p_account uuid, p_by uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.support_email_sync_state set full_requested_at = coalesce(full_requested_at, now()), full_requested_by = coalesce(full_requested_by, p_by)
  where channel_account_id = p_account
    and not exists (select 1 from public.support_email_sync_jobs j where j.channel_account_id = p_account and j.status = 'RUNNING');
$$;

-- A job-level failure (for example discovery could not continue). The job's queued messages stay queued.
create or replace function public.support_gmail_sync_job_fail(p_account uuid, p_owner uuid, p_job uuid, p_error text, p_stage text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state := private.support_gmail_sync_hold(p_account, p_owner);
begin
  update public.support_email_sync_jobs set status = 'FAILED', finished_at = now(), last_error = left(p_error, 1000), failure_stage = left(p_stage, 40), updated_at = now()
  where id = p_job and channel_account_id = p_account and status = 'RUNNING';
end;
$$;

-- End of one invocation: diagnostics, lock released, and (at the end of a run, on errors, or every 10 minutes)
-- the existing mailbox status: config last sync / last_history_id and the integration health.
create or replace function public.support_gmail_sync_finish(p_account uuid, p_owner uuid, p_summary jsonb, p_ok boolean, p_message text, p_stage text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_email_sync_state;
  j public.support_email_sync_jobs;
  v_left jsonb := private.support_gmail_sync_remaining(p_account);
  v_more boolean;
  v_publish boolean;
begin
  select * into s from public.support_email_sync_state where channel_account_id = p_account for update;
  if not found or s.lock_owner is distinct from p_owner then
    return jsonb_build_object('released', false, 'remaining', v_left);
  end if;
  v_more := (v_left ->> 'queue_ready')::integer > 0 or (v_left ->> 'attachments_ready')::integer > 0 or (v_left ->> 'discovery')::boolean;
  select * into j from public.support_email_sync_jobs where channel_account_id = p_account and status = 'RUNNING';
  if j.id is not null then
    update public.support_email_sync_jobs set batches = batches + 1, last_batch_at = now(),
      last_error = case when p_ok then last_error else left(p_message, 1000) end, failure_stage = case when p_ok then failure_stage else left(p_stage, 40) end,
      updated_at = now() where id = j.id;
  end if;
  v_publish := not p_ok or not v_more or s.published_at is null or s.published_at < now() - interval '10 minutes';
  update public.support_email_sync_state set lock_owner = null, lock_until = null, batch_no = batch_no + 1, last_batch_at = now(),
    last_batch = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('ok', p_ok, 'stage', p_stage, 'remaining', v_left),
    last_error = case when p_ok then last_error else left(p_message, 1000) end,
    last_error_stage = case when p_ok then last_error_stage else left(p_stage, 40) end,
    last_error_at = case when p_ok then last_error_at else now() end,
    published_at = case when v_publish then now() else published_at end, updated_at = now()
  where channel_account_id = p_account;
  if v_publish then
    -- Mirror the checkpoint for the status screen and earlier code; the existing function records health and the event.
    perform public.support_gmail_sync_state(p_account, s.history_id, p_ok, p_message, 'HISTORY', coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('remaining', v_left));
  end if;
  return jsonb_build_object('released', true, 'more', v_more, 'remaining', v_left);
end;
$$;

-- Administrator Retry (called by google-gmail-sync after its own permission check): failed messages and attachment
-- parts that gave up are tried again; a FAILED full re-sync continues as a new job from its own position.
create or replace function public.support_gmail_sync_retry(p_account uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
  v_parts integer;
begin
  update public.support_email_sync_queue set state = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null
  where channel_account_id = p_account and state = 'FAILED';
  get diagnostics v_items = row_count;
  with upd as (
    update public.support_email_messages m set attachment_parts = (
      select jsonb_agg(case when a ->> 'state' = 'FAILED' then a - 'attempts' - 'retry_at' else a end order by o)
      from jsonb_array_elements(m.attachment_parts) with ordinality as x (a, o))
    where m.channel_account_id = p_account and m.attachment_parts::text ~ '"state": "FAILED"'
    returning 1)
  select count(*) into v_parts from upd;
  update public.support_email_sync_state set last_error = null, last_error_stage = null, last_error_at = null where channel_account_id = p_account;
  -- A failed job is resumed: back to RUNNING (only when no other job runs), keeping its page token and counts.
  update public.support_email_sync_jobs j set status = 'RUNNING', finished_at = null, last_error = null, failure_stage = null, updated_at = now()
  where j.id = (select id from public.support_email_sync_jobs where channel_account_id = p_account and status = 'FAILED' order by started_at desc limit 1)
    and not exists (select 1 from public.support_email_sync_jobs r where r.channel_account_id = p_account and r.status = 'RUNNING');
  return jsonb_build_object('messages', v_items, 'emails_with_attachments', v_parts);
end;
$$;

-- -----------------------------------------------------------------------------
-- Status for the settings screen (support.view; counts only, no message content)
-- -----------------------------------------------------------------------------
create or replace function public.support_email_sync_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_email_config;
  s public.support_email_sync_state;
  j public.support_email_sync_jobs;
begin
  select * into c from public.support_email_config where company_id = v_company;
  if not found then
    return null;
  end if;
  select * into s from public.support_email_sync_state where channel_account_id = c.channel_account_id;
  select * into j from public.support_email_sync_jobs where channel_account_id = c.channel_account_id order by (status = 'RUNNING') desc, started_at desc limit 1;
  return jsonb_build_object(
    'running', s.lock_owner is not null and s.lock_until > now(),
    'full_requested', s.full_requested_at is not null,
    'last_batch_at', s.last_batch_at, 'batch_no', coalesce(s.batch_no, 0),
    'last_batch', coalesce(s.last_batch - 'remaining', '{}'::jsonb),
    'last_error', s.last_error, 'last_error_stage', s.last_error_stage, 'last_error_at', s.last_error_at,
    'remaining', private.support_gmail_sync_remaining(c.channel_account_id),
    'job', case when j.id is null then null else jsonb_build_object('id', j.id, 'reason', j.reason, 'status', j.status, 'days', j.days,
      'discovery_done', j.discovery_done, 'pages', j.pages, 'discovered', j.discovered, 'processed', j.processed, 'stored', j.stored,
      'duplicates', j.duplicates, 'confirmed', j.confirmed, 'ignored', j.ignored, 'failed', j.failed, 'batches', j.batches,
      'remaining', (select count(*) from public.support_email_sync_queue q where q.job_id = j.id and q.state = 'PENDING'),
      'started_at', j.started_at, 'finished_at', j.finished_at, 'last_batch_at', j.last_batch_at, 'last_error', j.last_error, 'failure_stage', j.failure_stage) end);
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_gmail_sync_begin', 'support_gmail_sync_job_start', 'support_gmail_sync_discovered',
             'support_gmail_sync_enqueue', 'support_gmail_sync_next', 'support_gmail_sync_item_result', 'support_gmail_sync_attachments_next',
             'support_gmail_attachment_failed', 'support_gmail_sync_job_fail', 'support_gmail_sync_request_full', 'support_gmail_sync_finish', 'support_gmail_sync_retry') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'support_email_sync_status' loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function private.support_gmail_sync_hold(uuid, uuid) from public, anon, authenticated;
revoke all on function private.support_gmail_sync_job_check(uuid) from public, anon, authenticated;
revoke all on function private.support_gmail_sync_remaining(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- ERP reset allowlist (20261222090000 plus the three sync tables; the queue before its jobs)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (2, 'support_ticket_escalations', 'Support Centre', 'SLA warnings, breaches and escalations'),
    (3, 'support_ticket_rules', 'Support Centre', 'Ticket automation rules'),
    (3, 'support_business_calendar', 'Support Centre', 'Business hours'),
    (3, 'support_holidays', 'Support Centre', 'Holidays'),
    (3, 'support_sla_escalation_levels', 'Support Centre', 'SLA escalation levels'),
    (3, 'support_assignment_rules', 'Support Centre', 'Ticket assignment rules'),
    (0, 'support_whatsapp_messages', 'Support Centre', 'WhatsApp messages'),
    (0, 'support_whatsapp_statuses', 'Support Centre', 'WhatsApp delivery statuses'),
    (1, 'support_whatsapp_threads', 'Support Centre', 'WhatsApp contacts per conversation'),
    (3, 'support_whatsapp_templates', 'Support Centre', 'WhatsApp templates (from Meta)'),
    (3, 'support_whatsapp_webhook_events', 'Support Centre', 'WhatsApp webhook events'),
    (3, 'support_whatsapp_config', 'Support Centre', 'WhatsApp settings'),
    (0, 'support_email_messages', 'Support Centre', 'Email messages (Gmail)'),
    (1, 'support_email_templates', 'Support Centre', 'Email templates'),
    (3, 'support_email_config', 'Support Centre', 'Email settings'),
    (3, 'support_email_credentials', 'Support Centre', 'Email connection (encrypted)'),
    (3, 'support_oauth_states', 'Support Centre', 'Email authorisation requests'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_conversation_prefs', 'Support Centre', 'Pinned / muted / favourite conversations'),
    (0, 'support_email_thread_state', 'Support Centre', 'Email starred / snoozed / folder state'),
    (0, 'support_email_sync_queue', 'Support Centre', 'Email sync queue'),
    (1, 'support_email_sync_jobs', 'Support Centre', 'Email full re-sync jobs'),
    (0, 'support_email_sync_state', 'Support Centre', 'Email sync lock and progress'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (4, 'support_agents', 'Support Centre', 'Support agents'),
    (4, 'support_channel_accounts', 'Support Centre', 'Support channel accounts'),
    (4, 'support_customers', 'Support Centre', 'Support customers'),
    (4, 'support_sla_policies', 'Support Centre', 'Support SLA policies'),
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'bom_cost_snapshots', 'Production & BOMs', 'BOM cost calculations'),
    (0, 'bom_change_batch_lines', 'Production & BOMs', 'Bulk BOM change lines'),
    (0, 'bom_change_approvals', 'Production & BOMs', 'Bulk BOM change approvals and history'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'product_cost_history', 'Products & catalogue', 'Product cost history'),
    (0, 'product_cost_profiles', 'Products & catalogue', 'Product cost sources'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
    (1, 'bom_change_batches', 'Production & BOMs', 'Bulk BOM change batches'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
