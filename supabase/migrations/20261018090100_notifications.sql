-- =============================================================================
-- Phase 10: in-app notifications, notification preferences, error log
--
-- Notifications are private to their recipient (RLS). They are written only by
-- trusted functions (approval engine, import history, error log) and by
-- notifications_sync(), which turns the caller's own Phase 9 alerts into
-- notifications. Every notification carries a deduplication key that is
-- unique per recipient, so refreshing never creates duplicates.
--
-- External delivery (email / push): no provider is configured. The delivery
-- interface is documented in docs/SUPABASE_SETUP.md; nothing is sent outside
-- the application and the UI shows those channels as "Not configured".
-- =============================================================================

create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  recipient_user_id   uuid not null,
  notification_type   text not null check (notification_type ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  title               text not null check (length(btrim(title)) between 1 and 200),
  message             text not null check (length(message) <= 1000),
  severity            text not null default 'INFO' check (severity in ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  related_entity_type text check (related_entity_type is null or related_entity_type ~ '^[A-Z][A-Z_]{1,59}$'),
  related_entity_id   text check (related_entity_id is null or length(related_entity_id) <= 200),
  -- Internal, relative application links only (never external URLs or tokens).
  link                text check (link is null or (length(link) <= 300 and link ~ '^/[A-Za-z0-9/_?=&.:%-]*$')),
  deduplication_key   text check (deduplication_key is null or length(deduplication_key) <= 300),
  created_at          timestamptz not null default now(),
  read_at             timestamptz,
  dismissed_at        timestamptz,
  constraint notifications_dedup_unique unique (company_id, recipient_user_id, deduplication_key)
);

create index if not exists notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (recipient_user_id) where read_at is null and dismissed_at is null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (recipient_user_id = auth.uid() and company_id = private.current_company_id());

-- Per-user preferences (in-app only; external channels are not configured).
create table if not exists public.notification_preferences (
  company_id        uuid not null references public.companies (id) on delete restrict,
  user_id           uuid not null,
  notification_type text not null check (notification_type ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  in_app            boolean not null default true,
  updated_at        timestamptz not null default now(),
  primary key (user_id, notification_type)
);

alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;
grant select on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_select_own on public.notification_preferences;
create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated
  using (user_id = auth.uid() and company_id = private.current_company_id());

-- Throttle for notifications_sync (one evaluation per user per 2 minutes).
create table if not exists public.notification_sync_state (
  user_id        uuid primary key,
  company_id     uuid not null references public.companies (id) on delete restrict,
  last_synced_at timestamptz not null
);

alter table public.notification_sync_state enable row level security;
revoke all on public.notification_sync_state from anon, authenticated;

-- Types that a user may not mute (approval work assigned to them).
create or replace function private.notification_mandatory(p_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('APPROVAL_REQUESTED', 'APPROVAL_ESCALATED');
$$;

-- Writes one notification (deduplicated, respecting the recipient's preference).
create or replace function private.notify(
  p_company uuid, p_recipient uuid, p_type text, p_title text, p_message text, p_severity text default 'INFO',
  p_entity_type text default null, p_entity_id text default null, p_link text default null, p_dedup text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_recipient is null or p_company is null then
    return false;
  end if;
  if not private.notification_mandatory(p_type) and exists (
      select 1 from public.notification_preferences np where np.user_id = p_recipient and np.notification_type = p_type and not np.in_app) then
    return false;
  end if;
  insert into public.notifications (company_id, recipient_user_id, notification_type, title, message, severity, related_entity_type,
    related_entity_id, link, deduplication_key)
  values (p_company, p_recipient, p_type, left(p_title, 200), left(coalesce(p_message, ''), 1000), p_severity, p_entity_type, p_entity_id,
    case when p_link ~ '^/[A-Za-z0-9/_?=&.:%-]*$' then left(p_link, 300) end, p_dedup)
  on conflict on constraint notifications_dedup_unique do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Notifies every active user of the company holding a permission.
create or replace function private.notify_permission(
  p_company uuid, p_permission text, p_type text, p_title text, p_message text, p_severity text, p_entity_type text, p_entity_id text,
  p_link text, p_dedup text, p_exclude uuid default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_n    int := 0;
begin
  for v_user in
    select distinct p.id from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p_company
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id and pm.code = p_permission
    where p.company_id = p_company and p.is_active and p.id is distinct from p_exclude
  loop
    if private.notify(p_company, v_user, p_type, p_title, p_message, p_severity, p_entity_type, p_entity_id, p_link, p_dedup) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function private.notification_mandatory(text) from public, anon, authenticated;
revoke all on function private.notify(uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function private.notify_permission(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Client actions (own notifications only)
-- -----------------------------------------------------------------------------
create or replace function public.notifications_mark_read(p_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_rows    int;
begin
  if v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.notifications set read_at = now()
  where recipient_user_id = auth.uid() and company_id = v_company and read_at is null
    and (p_ids is null or id = any (p_ids));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.notifications_dismiss(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_rows    int;
begin
  if v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.notifications set dismissed_at = now(), read_at = coalesce(read_at, now())
  where recipient_user_id = auth.uid() and company_id = v_company and dismissed_at is null and id = any (coalesce(p_ids, '{}'));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.notification_preference_set(p_type text, p_in_app boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_type is null or p_type !~ '^[A-Z][A-Z0-9_]{1,59}$' then
    raise exception 'Unknown notification type.' using errcode = 'P0001';
  end if;
  if private.notification_mandatory(p_type) and not coalesce(p_in_app, true) then
    raise exception 'Approval notifications assigned to you cannot be turned off.' using errcode = 'P0001';
  end if;
  insert into public.notification_preferences (company_id, user_id, notification_type, in_app, updated_at)
  values (v_company, auth.uid(), p_type, coalesce(p_in_app, true), now())
  on conflict (user_id, notification_type) do update set in_app = excluded.in_app, updated_at = now(), company_id = excluded.company_id;
end;
$$;

-- Turns the caller's current alerts (Phase 9 rules, the caller's permissions)
-- into notifications. One notification per alert occurrence and user.
create or replace function public.notifications_sync(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_uid     uuid := auth.uid();
  v_last    timestamptz;
  v_alerts  jsonb;
  v_a       jsonb;
  v_new     int := 0;
begin
  if v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select last_synced_at into v_last from public.notification_sync_state where user_id = v_uid;
  if not p_force and v_last is not null and v_last > now() - interval '2 minutes' then
    return jsonb_build_object('created', 0, 'skipped', true, 'last_synced_at', v_last);
  end if;
  insert into public.notification_sync_state (user_id, company_id, last_synced_at) values (v_uid, v_company, now())
  on conflict (user_id) do update set last_synced_at = now(), company_id = excluded.company_id;

  perform private.approval_escalate(v_company);

  if private.has_permission(v_company, 'dashboard.read') then
    v_alerts := public.analytics_alerts(null) -> 'alerts';
    for v_a in select value from jsonb_array_elements(coalesce(v_alerts, '[]'::jsonb)) loop
      if private.notify(v_company, v_uid, 'ALERT_' || (v_a ->> 'type'), v_a ->> 'title',
           coalesce(v_a ->> 'reference', '') || ': ' || coalesce(v_a ->> 'explanation', '') || ' ' || coalesce(v_a ->> 'action', ''),
           v_a ->> 'severity', 'ALERT', v_a ->> 'record_id', v_a ->> 'link',
           'ALERT:' || (v_a ->> 'id') || ':' || (v_a ->> 'detected_at')) then
        v_new := v_new + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('created', v_new, 'skipped', false, 'last_synced_at', now());
end;
$$;

revoke all on function public.notifications_mark_read(uuid[]) from public, anon;
revoke all on function public.notifications_dismiss(uuid[]) from public, anon;
revoke all on function public.notification_preference_set(text, boolean) from public, anon;
revoke all on function public.notifications_sync(boolean) from public, anon;
grant execute on function public.notifications_mark_read(uuid[]), public.notifications_dismiss(uuid[]),
  public.notification_preference_set(text, boolean), public.notifications_sync(boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Structured error log (troubleshooting without secrets)
-- -----------------------------------------------------------------------------
create table if not exists public.error_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid references public.companies (id) on delete restrict,
  user_id        uuid,
  correlation_id text not null check (correlation_id ~ '^[A-Za-z0-9-]{8,64}$'),
  source         text not null check (source ~ '^[a-z][a-z0-9_.:/-]{1,99}$'),
  severity       text not null default 'ERROR' check (severity in ('WARNING', 'ERROR')),
  code           text check (code is null or length(code) <= 40),
  message        text not null check (length(message) <= 500),
  context        jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 4096),
  created_at     timestamptz not null default now()
);

create index if not exists error_events_company_time_idx on public.error_events (company_id, created_at desc);
create index if not exists error_events_user_time_idx on public.error_events (user_id, created_at desc);

alter table public.error_events enable row level security;
revoke all on public.error_events from anon, authenticated;
grant select on public.error_events to authenticated;

drop policy if exists error_events_select_health on public.error_events;
create policy error_events_select_health on public.error_events
  for select to authenticated
  using (private.has_permission(company_id, 'system_health.read'));

-- Removes secrets and personal identifiers from free text.
create or replace function private.redact(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''),
    'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*', '[redacted-token]', 'g'),
    '(?i)bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [redacted]', 'g'),
    '(?i)(password|passwd|secret|token|api[_-]?key|apikey|authorization|service[_-]?role)("?\s*[:=]\s*"?)[^\s",}]+', '\1\2[redacted]', 'g'),
    '(?i)sb_(secret|publishable)_[A-Za-z0-9_-]+', '[redacted-key]', 'g'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'), 500);
$$;

create or replace function private.redact_context(p_context jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(left(key, 60),
           case when key ~* '(token|password|secret|authorization|cookie|api_?key|session|jwt|credential)' then '"[redacted]"'::jsonb
                when jsonb_typeof(value) = 'string' then to_jsonb(private.redact(value #>> '{}'))
                when jsonb_typeof(value) in ('number', 'boolean', 'null') then value
                else to_jsonb(left(private.redact(value::text), 300)) end), '{}'::jsonb)
  from (select * from jsonb_each(case when jsonb_typeof(p_context) = 'object' then p_context else '{}'::jsonb end) limit 20) e;
$$;

revoke all on function private.redact(text) from public, anon, authenticated;
revoke all on function private.redact_context(jsonb) from public, anon, authenticated;

create or replace function public.log_client_error(
  p_correlation_id text, p_source text, p_message text, p_code text default null, p_context jsonb default '{}'::jsonb, p_severity text default 'ERROR'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_uid     uuid := auth.uid();
  v_source  text := lower(left(coalesce(nullif(btrim(p_source), ''), 'app'), 100));
begin
  if v_uid is null or v_company is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_correlation_id is null or p_correlation_id !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'Invalid correlation id.' using errcode = 'P0001';
  end if;
  if v_source !~ '^[a-z][a-z0-9_.:/-]{1,99}$' then
    v_source := 'app';
  end if;
  -- Rate limit: at most 60 events per user per hour.
  if (select count(*) from public.error_events where user_id = v_uid and created_at > now() - interval '1 hour') >= 60 then
    return false;
  end if;
  insert into public.error_events (company_id, user_id, correlation_id, source, severity, code, message, context)
  values (v_company, v_uid, p_correlation_id, v_source, case when p_severity = 'WARNING' then 'WARNING' else 'ERROR' end,
    left(private.redact(p_code), 40), coalesce(nullif(private.redact(p_message), ''), 'Unknown error'), private.redact_context(p_context));
  if coalesce(p_severity, 'ERROR') <> 'WARNING' then
    perform private.notify_permission(v_company, 'system_health.read', 'SYSTEM_ERROR', 'Application errors reported',
      'Errors were reported from ' || v_source || '. See System Health for details.', 'MEDIUM', null, null, '/admin/system-health',
      'SYSTEM_ERROR:' || v_source || ':' || to_char(date_trunc('hour', now()), 'YYYY-MM-DD"T"HH24'));
  end if;
  return true;
end;
$$;

revoke all on function public.log_client_error(text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.log_client_error(text, text, text, text, jsonb, text) to authenticated;
