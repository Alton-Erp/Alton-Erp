-- =============================================================================
-- Acefone (Servetel) telephony for the Support Centre
--
-- Additive; builds on 20261210090000_support_centre. The ERP is the agent interface.
--
--   * Credentials (API token, Click-to-Call Support API key, webhook secret) live ONLY in Supabase
--     Edge Function secrets. The database stores the NAMES of those secrets and non-secret settings.
--   * Edge Functions: acefone-click-to-call (JWT), acefone-webhook (secret URL token), acefone-sync-cdr,
--     acefone-recording-sync. Provider calls run there; the functions call the service-role-only
--     functions below.
--   * Call status only moves forward: INITIATED -> RINGING -> CONNECTED -> COMPLETED | MISSED | FAILED,
--     and only from provider events (webhook / CDR) or a rejected API request. An accepted
--     click-to-call request is INITIATED, never CONNECTED.
--   * Every webhook is logged in support_integration_events with a de-duplication key; a repeat is a
--     no-op. Status transitions are recorded once each in support_call_events.
--   * The provider's recording URL contains an access token: it is kept in a column the app cannot
--     read and is never returned to the browser. Recordings are copied into the private
--     support-attachments bucket only when recording retrieval is enabled.
--
-- Rollback: supabase/rollback/20261211090000_acefone_telephony_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Integration event log: de-duplication, processing outcome, replay
-- -----------------------------------------------------------------------------
alter table public.support_integration_events add column if not exists event_key text;
alter table public.support_integration_events add column if not exists processed_at timestamptz;
alter table public.support_integration_events add column if not exists processing_result text;
alter table public.support_integration_events add column if not exists processing_error text;
alter table public.support_integration_events add column if not exists replay_count integer not null default 0;
alter table public.support_integration_events add column if not exists source_ip text;
alter table public.support_integration_events drop constraint if exists support_integration_events_event_type_check;
alter table public.support_integration_events add constraint support_integration_events_event_type_check
  check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR', 'CLICK_TO_CALL', 'CDR_SYNC', 'RECORDING_SYNC', 'REPLAY', 'DISCONNECTED', 'REJECTED'));
create unique index if not exists support_integration_events_key_unique on public.support_integration_events (company_id, event_key) where event_key is not null;

-- -----------------------------------------------------------------------------
-- 2. Phone settings and agent lines
-- -----------------------------------------------------------------------------
create table if not exists public.support_phone_config (
  company_id                 uuid primary key references public.companies (id) on delete restrict,
  channel_account_id         uuid not null,
  provider                   text not null default 'ACEFONE' check (provider = 'ACEFONE'),
  toll_free_number           text check (toll_free_number is null or length(toll_free_number) <= 20),
  -- Only the documented Acefone API hosts are allowed (no arbitrary server-side URL fetching).
  api_base_url               text not null default 'https://api.acefone.in' check (api_base_url in ('https://api.acefone.in', 'https://api-acefone.com')),
  -- AGENT: POST /v1/click_to_call (agent leg first, Bearer API token).
  -- SUPPORT: POST /v1/click_to_call_support (customer leg first, api_key in the body + Bearer token).
  click_to_call_mode         text not null default 'AGENT' check (click_to_call_mode in ('AGENT', 'SUPPORT')),
  default_caller_id          text check (default_caller_id is null or default_caller_id ~ '^[0-9]{6,15}$'),
  -- Names of the Edge Function secrets (never the values).
  api_token_secret           text not null default 'ACEFONE_API_TOKEN' check (api_token_secret ~ '^ACEFONE_[A-Z0-9_]{2,72}$'),
  support_api_key_secret     text not null default 'ACEFONE_C2C_SUPPORT_API_KEY' check (support_api_key_secret ~ '^ACEFONE_[A-Z0-9_]{2,72}$'),
  webhook_secret_name        text not null default 'ACEFONE_WEBHOOK_SECRET' check (webhook_secret_name ~ '^ACEFONE_[A-Z0-9_]{2,72}$'),
  -- Optional source-IP allowlist for webhooks (Acefone documents no signature).
  webhook_allowed_ips        text[] not null default '{}' check (cardinality(webhook_allowed_ips) <= 20),
  recording_retrieval        boolean not null default false,
  recording_retention_days   integer not null default 90 check (recording_retention_days between 1 and 3650),
  is_enabled                 boolean not null default true,
  disconnected_at            timestamptz,
  last_event_at              timestamptz,
  last_sync_at               timestamptz,
  last_sync_status           text check (last_sync_status is null or length(last_sync_status) <= 300),
  last_test_at               timestamptz,
  last_test_result           text check (last_test_result is null or length(last_test_result) <= 300),
  created_by                 uuid,
  updated_by                 uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint support_phone_config_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_phone_config_disconnected check (is_enabled or disconnected_at is not null)
);

create table if not exists public.support_phone_agents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  agent_id      uuid not null,
  -- Acefone agent identifier: registered mobile number, Agent ID (050...) or extension (060...).
  agent_number  text not null check (agent_number ~ '^[0-9]{6,15}$'),
  label         text check (label is null or length(label) <= 80),
  is_active     boolean not null default true,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint support_phone_agents_id_company_unique unique (id, company_id),
  constraint support_phone_agents_number_unique unique (company_id, agent_number),
  constraint support_phone_agents_agent_fk foreign key (agent_id, company_id) references public.support_agents (id, company_id) on delete restrict
);

-- -----------------------------------------------------------------------------
-- 3. Calls and their status transitions
-- -----------------------------------------------------------------------------
create table if not exists public.support_calls (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  provider                 text not null default 'ACEFONE',
  direction                text not null check (direction in ('INBOUND', 'OUTBOUND')),
  status                   text not null check (status in ('INITIATED', 'RINGING', 'CONNECTED', 'COMPLETED', 'MISSED', 'FAILED')),
  conversation_id          uuid,
  message_id               uuid,
  customer_id              uuid,
  ticket_id                uuid,
  agent_id                 uuid,
  phone_agent_id           uuid,
  agent_number             text,
  agent_name               text,
  caller_number            text,
  destination_number       text,
  customer_number_e164     text,
  caller_id_used           text,
  click_to_call_mode       text check (click_to_call_mode is null or click_to_call_mode in ('AGENT', 'SUPPORT')),
  provider_ref_id          text,
  provider_call_id         text,
  provider_uuid            text,
  request_state            text check (request_state is null or request_state in ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')),
  request_message          text check (request_message is null or length(request_message) <= 500),
  idempotency_key          uuid,
  initiated_by             uuid,
  disposition              text check (disposition is null or length(disposition) <= 120),
  hangup_cause             text check (hangup_cause is null or length(hangup_cause) <= 120),
  started_at               timestamptz,
  answered_at              timestamptz,
  ended_at                 timestamptz,
  ring_seconds             integer check (ring_seconds is null or ring_seconds >= 0),
  talk_seconds             integer check (talk_seconds is null or talk_seconds >= 0),
  duration_seconds         integer check (duration_seconds is null or duration_seconds >= 0),
  -- Provider recording link incl. its access token: NOT readable by app users (column grants below).
  provider_recording_ref   text,
  recording_identifier     text,
  recording_attachment_id  uuid,
  recording_purged_at      timestamptz,
  last_event_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint support_calls_id_company_unique unique (id, company_id),
  constraint support_calls_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_calls_message_fk foreign key (message_id, company_id) references public.support_messages (id, company_id) on delete restrict,
  constraint support_calls_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_calls_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_calls_agent_fk foreign key (agent_id, company_id) references public.support_agents (id, company_id) on delete restrict,
  constraint support_calls_line_fk foreign key (phone_agent_id, company_id) references public.support_phone_agents (id, company_id) on delete restrict,
  constraint support_calls_attachment_fk foreign key (recording_attachment_id) references public.support_attachments (id) on delete set null
);
create unique index if not exists support_calls_ref_unique on public.support_calls (company_id, provider_ref_id) where provider_ref_id is not null;
create unique index if not exists support_calls_call_id_unique on public.support_calls (company_id, provider_call_id) where provider_call_id is not null;
create unique index if not exists support_calls_idem_unique on public.support_calls (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists support_calls_company_idx on public.support_calls (company_id, created_at desc);
create index if not exists support_calls_status_idx on public.support_calls (company_id, status);
create index if not exists support_calls_customer_idx on public.support_calls (customer_id);
create index if not exists support_calls_ticket_idx on public.support_calls (ticket_id);
create index if not exists support_calls_uuid_idx on public.support_calls (company_id, provider_uuid) where provider_uuid is not null;
create index if not exists support_calls_number_idx on public.support_calls (company_id, customer_number_e164);

create table if not exists public.support_call_events (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  call_id               uuid not null,
  integration_event_id  uuid references public.support_integration_events (id) on delete set null,
  event_key             text not null,
  event_name            text not null,
  from_status           text,
  to_status             text,
  occurred_at           timestamptz,
  created_at            timestamptz not null default now(),
  constraint support_call_events_call_fk foreign key (call_id, company_id) references public.support_calls (id, company_id) on delete restrict,
  constraint support_call_events_key_unique unique (company_id, call_id, event_key)
);
create index if not exists support_call_events_company_idx on public.support_call_events (company_id, created_at);

-- RLS: read by permission; writes only through the functions below.
do $$
declare
  t text;
begin
  foreach t in array array['support_phone_config', 'support_phone_agents', 'support_calls', 'support_call_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;
grant select on public.support_phone_config, public.support_phone_agents, public.support_call_events to authenticated;
-- Every column of support_calls except the provider recording link.
grant select (id, company_id, provider, direction, status, conversation_id, message_id, customer_id, ticket_id, agent_id, phone_agent_id, agent_number, agent_name,
  caller_number, destination_number, customer_number_e164, caller_id_used, click_to_call_mode, provider_ref_id, provider_call_id, provider_uuid, request_state,
  request_message, idempotency_key, initiated_by, disposition, hangup_cause, started_at, answered_at, ended_at, ring_seconds, talk_seconds, duration_seconds,
  recording_identifier, recording_attachment_id, recording_purged_at, last_event_at, created_at, updated_at) on public.support_calls to authenticated;

drop policy if exists support_phone_config_select on public.support_phone_config;
create policy support_phone_config_select on public.support_phone_config for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_phone_agents_select on public.support_phone_agents;
create policy support_phone_agents_select on public.support_phone_agents for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_calls_select on public.support_calls;
create policy support_calls_select on public.support_calls for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_call_events_select on public.support_call_events;
create policy support_call_events_select on public.support_call_events for select to authenticated using (private.has_permission(company_id, 'support.view'));

do $$
declare
  t text;
begin
  foreach t in array array['support_phone_config', 'support_phone_agents', 'support_calls'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
  foreach t in array array['support_phone_config', 'support_phone_agents'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;

-- support_phone_config has no id column; the audit trigger uses company_id as the entity id there.

-- -----------------------------------------------------------------------------
-- 4. Helpers
-- -----------------------------------------------------------------------------
-- E.164 for Indian numbers (+91 for 10-digit mobiles, 0-prefixed and 1800 toll-free numbers); other
-- numbers with a country code are kept as +<digits>. Null when it is not a phone number.
create or replace function private.support_e164(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d is null or length(d) < 6 then null
    when left(d, 2) = '00' and length(d) > 10 then '+' || substr(d, 3)
    when length(d) = 10 and d ~ '^[6-9]' then '+91' || d
    when length(d) = 11 and d like '0%' then '+91' || substr(d, 2)
    when length(d) = 12 and d like '91%' then '+' || d
    when d like '1800%' or d like '1860%' then '+91' || d
    when length(coalesce(p, '')) > 0 and btrim(p) like '+%' then '+' || d
    when length(d) between 11 and 15 then '+' || d
    else '+91' || d end
  from (select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '') as d) x;
$$;

-- Acefone number format for the API (10 to 13 digits, no +): national 10 digits for India.
create or replace function private.support_acefone_number(p_e164 text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_e164 like '+91%' and length(p_e164) = 13 then right(p_e164, 10) else regexp_replace(coalesce(p_e164, ''), '[^0-9]', '', 'g') end;
$$;

create or replace function private.support_call_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status when 'INITIATED' then 1 when 'RINGING' then 2 when 'CONNECTED' then 3 when 'COMPLETED' then 4 when 'MISSED' then 4 when 'FAILED' then 4 else 0 end;
$$;

-- Timestamp from a webhook / CDR value: ISO 8601, epoch seconds, or 'Y-m-d H:i:s' in the company time zone.
create or replace function private.support_acefone_ts(p_value text, p_tz text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is null then
    return null;
  end if;
  if v ~ '^[0-9]{9,11}(\.[0-9]+)?$' then
    return to_timestamp(v::numeric);
  end if;
  if v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' then
    return (replace(v, 'T', ' ')::timestamp) at time zone coalesce(p_tz, 'Asia/Kolkata');
  end if;
  return v::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function private.support_int(p_value text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when btrim(coalesce(p_value, '')) ~ '^[0-9]{1,9}$' then btrim(p_value)::integer end;
$$;

-- Payload value by Acefone variable name, accepting the names with or without "$" and common aliases.
create or replace function private.support_pv(p jsonb, variadic p_keys text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select (select nullif(btrim(coalesce(p ->> k, p ->> ('$' || k))), '') from unnest(p_keys) with ordinality u(k, o)
          where nullif(btrim(coalesce(p ->> k, p ->> ('$' || k))), '') is not null order by o limit 1);
$$;

revoke all on function private.support_e164(text), private.support_acefone_number(text), private.support_call_rank(text), private.support_acefone_ts(text, text),
  private.support_int(text), private.support_pv(jsonb, text[]) from public, anon, authenticated;

-- Moves a call forward (never backward; a final status is never changed) and records the transition once.
create or replace function private.support_call_advance(p_call uuid, p_status text, p_event_name text, p_event_key text, p_event uuid, p_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_calls;
  v_to text;
begin
  select * into c from public.support_calls where id = p_call for update;
  if private.support_call_rank(p_status) > private.support_call_rank(c.status) then
    v_to := p_status;
  end if;
  insert into public.support_call_events (company_id, call_id, integration_event_id, event_key, event_name, from_status, to_status, occurred_at)
  values (c.company_id, c.id, p_event, p_event_key, p_event_name, c.status, coalesce(v_to, c.status), p_at)
  on conflict (company_id, call_id, event_key) do nothing;
  if not found then
    return false;
  end if;
  if v_to is not null then
    update public.support_calls set status = v_to, last_event_at = greatest(coalesce(last_event_at, p_at), coalesce(p_at, now())) where id = c.id;
  end if;
  return v_to is not null;
end;
$$;

-- Conversation of a call: the given one, the customer's / number's open phone conversation of the last day, or a new one.
create or replace function private.support_call_conversation(p_company uuid, p_customer uuid, p_number text, p_direction text, p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v uuid;
  v_norm text := private.support_normalize_phone(p_number);
begin
  select id into v from public.support_conversations
  where company_id = p_company and channel = 'PHONE' and status <> 'RESOLVED' and last_activity_at > now() - interval '1 day'
    and ((p_customer is not null and customer_id = p_customer) or (v_norm is not null and normalized_phone = v_norm))
  order by last_activity_at desc limit 1;
  if v is null then
    insert into public.support_conversations (company_id, channel, channel_account_id, customer_id, ticket_id, contact_phone, status, last_message_preview, last_activity_at)
    values (p_company, 'PHONE', (select channel_account_id from public.support_phone_config where company_id = p_company), p_customer, p_ticket, p_number,
            'OPEN', case when p_direction = 'INBOUND' then 'Incoming call' else 'Outgoing call' end, now())
    returning id into v;
  end if;
  return v;
end;
$$;

revoke all on function private.support_call_advance(uuid, text, text, text, uuid, timestamptz), private.support_call_conversation(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Settings (support.manage_integrations)
-- -----------------------------------------------------------------------------
create or replace function public.support_phone_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_phone_config;
begin
  select * into c from public.support_phone_config where company_id = v_company;
  return jsonb_build_object(
    'config', case when c.company_id is null then null else to_jsonb(c) - 'company_id' end,
    'account', (select jsonb_build_object('id', a.id, 'status', a.status, 'status_detail', a.status_detail, 'last_checked_at', a.last_checked_at)
                from public.support_channel_accounts a where a.id = c.channel_account_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'agent_id', l.agent_id, 'agent_name', a.display_name, 'presence', a.presence, 'agent_active', a.is_active,
               'user_id', a.user_id, 'agent_number', l.agent_number, 'label', l.label, 'is_active', l.is_active) order by a.display_name, l.agent_number)
               from public.support_phone_agents l join public.support_agents a on a.id = l.agent_id where l.company_id = v_company), '[]'::jsonb),
    'last_success_event_at', (select max(e.created_at) from public.support_integration_events e
                              where e.company_id = v_company and e.event_type = 'WEBHOOK' and e.processing_result = 'PROCESSED'),
    'events', case when private.has_permission(v_company, 'support.manage_integrations') then coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
                select jsonb_build_object('id', e.id, 'event_type', e.event_type, 'status', e.status, 'message', e.message, 'processing_result', e.processing_result,
                  'processing_error', e.processing_error, 'replay_count', e.replay_count, 'created_at', e.created_at, 'event', e.details ->> 'event') x
                from public.support_integration_events e where e.company_id = v_company and e.channel_account_id = c.channel_account_id
                order by e.created_at desc limit 50) z), '[]'::jsonb) end);
end;
$$;

create or replace function public.support_phone_config_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_phone_config;
  v_account uuid;
  v_toll text := nullif(btrim(coalesce(p ->> 'toll_free_number', '')), '');
  v_mode text := upper(coalesce(nullif(p ->> 'click_to_call_mode', ''), 'AGENT'));
  v_base text := coalesce(nullif(p ->> 'api_base_url', ''), 'https://api.acefone.in');
  v_caller text := nullif(regexp_replace(coalesce(p ->> 'default_caller_id', ''), '[^0-9]', '', 'g'), '');
  v_ips text[] := coalesce(array(select btrim(x) from jsonb_array_elements_text(coalesce(p -> 'webhook_allowed_ips', '[]'::jsonb)) x where btrim(x) <> ''), '{}');
  x text;
begin
  if p ? 'api_token' or p ? 'support_api_key' or p ? 'webhook_secret' or p ? 'status' then
    raise exception 'Secret values and the connection status are never saved from the app. Store secrets as Edge Function secrets.' using errcode = 'P0001';
  end if;
  if v_toll is not null and private.support_e164(v_toll) is null then
    raise exception 'The toll-free number is not a valid phone number.' using errcode = 'P0001';
  end if;
  if v_mode not in ('AGENT', 'SUPPORT') then
    raise exception 'Click-to-Call mode must be Agent (click_to_call) or Support (click_to_call_support).' using errcode = 'P0001';
  end if;
  if v_base not in ('https://api.acefone.in', 'https://api-acefone.com') then
    raise exception 'Choose one of the documented Acefone API hosts.' using errcode = 'P0001';
  end if;
  foreach x in array v_ips loop
    if x !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' then
      raise exception 'Webhook IP "%" is not an IPv4 address or range.', x using errcode = 'P0001';
    end if;
  end loop;
  select * into c from public.support_phone_config where company_id = v_company for update;
  if c.company_id is null then
    insert into public.support_channel_accounts (company_id, channel, display_name, identifier, provider, credentials_ref, status, created_by, updated_by)
    values (v_company, 'PHONE', 'Acefone toll-free', v_toll, 'Acefone / Servetel', 'ACEFONE_API_TOKEN', 'SETUP_REQUIRED', auth.uid(), auth.uid())
    returning id into v_account;
    insert into public.support_phone_config (company_id, channel_account_id, toll_free_number, api_base_url, click_to_call_mode, default_caller_id, webhook_allowed_ips,
      recording_retrieval, recording_retention_days, created_by, updated_by)
    values (v_company, v_account, v_toll, v_base, v_mode, v_caller, v_ips, coalesce((p ->> 'recording_retrieval')::boolean, false),
      coalesce(nullif(p ->> 'recording_retention_days', '')::integer, 90), auth.uid(), auth.uid());
    insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, created_by)
    values (v_company, v_account, 'ACCOUNT_CREATED', 'SETUP_REQUIRED', 'Acefone phone settings saved; awaiting a successful connection test.', auth.uid());
  else
    update public.support_phone_config set toll_free_number = v_toll, api_base_url = v_base, click_to_call_mode = v_mode, default_caller_id = v_caller,
      webhook_allowed_ips = v_ips, recording_retrieval = coalesce((p ->> 'recording_retrieval')::boolean, recording_retrieval),
      recording_retention_days = coalesce(nullif(p ->> 'recording_retention_days', '')::integer, recording_retention_days),
      is_enabled = true, disconnected_at = null, updated_by = auth.uid()
    where company_id = v_company;
    update public.support_channel_accounts set identifier = v_toll, is_active = true,
      status = case when c.is_enabled and c.api_base_url = v_base and c.click_to_call_mode = v_mode then status else 'SETUP_REQUIRED' end, updated_by = auth.uid()
    where id = c.channel_account_id;
    insert into public.support_integration_events (company_id, channel_account_id, event_type, message, created_by)
    values (v_company, c.channel_account_id, 'ACCOUNT_UPDATED', 'Acefone phone settings updated.', auth.uid());
  end if;
  return public.support_phone_config_get();
end;
$$;

-- Settings an Edge Function may act on for an administrator (support.manage_integrations), called with the caller's JWT.
create or replace function public.support_phone_admin_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
begin
  return (select jsonb_build_object('account_id', c.channel_account_id, 'is_enabled', c.is_enabled, 'api_base_url', c.api_base_url, 'mode', c.click_to_call_mode,
            'api_token_secret', c.api_token_secret, 'support_api_key_secret', c.support_api_key_secret, 'webhook_secret_name', c.webhook_secret_name)
          from public.support_phone_config c where c.company_id = v_company);
end;
$$;

-- Stops click-to-call and webhook processing at once (events are still logged as REJECTED).
create or replace function public.support_phone_disconnect(p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_phone_config;
begin
  select * into c from public.support_phone_config where company_id = v_company for update;
  if c.company_id is null then
    raise exception 'Phone settings are not set up.' using errcode = 'P0001';
  end if;
  update public.support_phone_config set is_enabled = false, disconnected_at = now(), updated_by = auth.uid() where company_id = v_company;
  update public.support_channel_accounts set status = 'NOT_CONNECTED', status_detail = 'Disconnected in the ERP', connected_at = null, updated_by = auth.uid()
  where id = c.channel_account_id;
  insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, created_by)
  values (v_company, c.channel_account_id, 'DISCONNECTED', 'NOT_CONNECTED', left(coalesce(nullif(btrim(p_reason), ''), 'Disconnected by an administrator.'), 1000), auth.uid());
end;
$$;

create or replace function public.support_phone_agent_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  v_number text := regexp_replace(coalesce(p ->> 'agent_number', ''), '[^0-9]', '', 'g');
  v_agent uuid := nullif(p ->> 'agent_id', '')::uuid;
  v_id uuid;
begin
  if v_number !~ '^[0-9]{6,15}$' then
    raise exception 'Enter the Acefone agent number, Agent ID (050…) or extension (060…).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.support_agents where id = v_agent and company_id = v_company) then
    raise exception 'Choose a support agent of your company.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.support_phone_agents where company_id = v_company and agent_number = v_number and id is distinct from p_id) then
    raise exception 'Number % is already mapped to an agent.', v_number using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_phone_agents (company_id, agent_id, agent_number, label, is_active, created_by, updated_by)
    values (v_company, v_agent, v_number, left(nullif(btrim(coalesce(p ->> 'label', '')), ''), 80), coalesce((p ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_phone_agents set agent_id = v_agent, agent_number = v_number, label = left(nullif(btrim(coalesce(p ->> 'label', '')), ''), 80),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active), updated_by = auth.uid()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Line not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Outgoing calls
-- -----------------------------------------------------------------------------
-- Lines the caller may use: their own, or any active line with support.assign.
create or replace function public.support_call_lines()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_all boolean := private.has_permission(v_company, 'support.assign');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'agent_number', l.agent_number, 'label', l.label, 'agent_name', a.display_name, 'presence', a.presence,
           'mine', a.user_id = auth.uid()) order by (a.user_id = auth.uid()) desc, a.display_name)
         from public.support_phone_agents l join public.support_agents a on a.id = l.agent_id
         where l.company_id = v_company and l.is_active and a.is_active and (v_all or a.user_id = auth.uid())), '[]'::jsonb);
end;
$$;

-- Step 1 of a click-to-call, called by the Edge Function WITH THE CALLER'S JWT. Checks the caller,
-- the number (it must belong to the customer, ticket or conversation), the line and repeats, and
-- records the call as INITIATED / request PENDING. Returns what the function sends to Acefone.
create or replace function public.support_call_prepare(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  cfg public.support_phone_config;
  v_key uuid := nullif(p ->> 'idempotency_key', '')::uuid;
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_ticket uuid := nullif(p ->> 'ticket_id', '')::uuid;
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_e164 text := private.support_e164(p ->> 'number');
  v_line public.support_phone_agents;
  v_agent public.support_agents;
  v_existing public.support_calls;
  v_allowed text[] := '{}';
  v_id uuid;
begin
  if v_key is null then
    raise exception 'A request key is required.' using errcode = 'P0001';
  end if;
  select * into v_existing from public.support_calls where company_id = v_company and idempotency_key = v_key;
  if found then
    return jsonb_build_object('call_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'request_state', v_existing.request_state);
  end if;
  select * into cfg from public.support_phone_config where company_id = v_company;
  if cfg.company_id is null or not cfg.is_enabled then
    raise exception 'Calling is not available: the Acefone phone integration is not set up or is disconnected.' using errcode = 'P0001';
  end if;
  if v_e164 is null then
    raise exception 'Choose a valid phone number to call.' using errcode = 'P0001';
  end if;
  if v_ticket is not null then
    select coalesce(v_customer, customer_id) into v_customer from public.support_tickets where id = v_ticket and company_id = v_company;
    if not found then raise exception 'Ticket not found in your company.' using errcode = 'P0001'; end if;
    v_allowed := v_allowed || array(select private.support_e164(customer_phone) from public.support_tickets where id = v_ticket);
  end if;
  if v_conv is not null then
    select coalesce(v_customer, customer_id), coalesce(v_ticket, ticket_id) into v_customer, v_ticket from public.support_conversations where id = v_conv and company_id = v_company;
    if not found then raise exception 'Conversation not found in your company.' using errcode = 'P0001'; end if;
    v_allowed := v_allowed || array(select private.support_e164(contact_phone) from public.support_conversations where id = v_conv);
  end if;
  if v_customer is not null then
    if not exists (select 1 from public.support_customers where id = v_customer and company_id = v_company) then
      raise exception 'Customer not found in your company.' using errcode = 'P0001';
    end if;
    v_allowed := v_allowed || array(select private.support_e164(x) from public.support_customers c, unnest(c.phones) x where c.id = v_customer);
  end if;
  if v_customer is null and v_ticket is null and v_conv is null then
    raise exception 'Calls are placed from a customer, ticket or conversation.' using errcode = 'P0001';
  end if;
  if not (v_e164 = any (v_allowed)) then
    raise exception 'This number does not belong to the customer, ticket or conversation.' using errcode = 'P0001';
  end if;
  select * into v_line from public.support_phone_agents where id = nullif(p ->> 'line_id', '')::uuid and company_id = v_company and is_active;
  if not found then
    raise exception 'Choose an agent line to call from.' using errcode = 'P0001';
  end if;
  select * into v_agent from public.support_agents where id = v_line.agent_id;
  if not v_agent.is_active then
    raise exception 'Agent % is inactive.', v_agent.display_name using errcode = 'P0001';
  end if;
  if v_agent.user_id <> auth.uid() and not private.has_permission(v_company, 'support.assign') then
    raise exception 'You can call only from your own line.' using errcode = '42501';
  end if;
  -- Repeated clicks: an unfinished call to the same number from the same line in the last 2 minutes is reused.
  select * into v_existing from public.support_calls
  where company_id = v_company and direction = 'OUTBOUND' and customer_number_e164 = v_e164 and phone_agent_id = v_line.id
    and status in ('INITIATED', 'RINGING', 'CONNECTED') and created_at > now() - interval '2 minutes'
  order by created_at desc limit 1;
  if found then
    return jsonb_build_object('call_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'request_state', v_existing.request_state);
  end if;
  -- Rate limit: 10 call requests per user per minute.
  if (select count(*) from public.support_calls where company_id = v_company and initiated_by = auth.uid() and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Too many call requests. Wait a minute and try again.' using errcode = 'P0001';
  end if;
  v_conv := coalesce(v_conv, private.support_call_conversation(v_company, v_customer, v_e164, 'OUTBOUND', v_ticket));
  insert into public.support_calls (company_id, direction, status, conversation_id, customer_id, ticket_id, agent_id, phone_agent_id, agent_number, agent_name,
    caller_number, destination_number, customer_number_e164, caller_id_used, click_to_call_mode, request_state, idempotency_key, initiated_by, started_at, last_event_at)
  values (v_company, 'OUTBOUND', 'INITIATED', v_conv, v_customer, v_ticket, v_agent.id, v_line.id, v_line.agent_number, v_agent.display_name,
    coalesce(cfg.default_caller_id, cfg.toll_free_number), v_e164, v_e164, cfg.default_caller_id, cfg.click_to_call_mode, 'PENDING', v_key, auth.uid(), now(), now())
  returning id into v_id;
  insert into public.support_call_events (company_id, call_id, event_key, event_name, from_status, to_status, occurred_at)
  values (v_company, v_id, 'requested', 'Call requested in the ERP', null, 'INITIATED', now());
  return jsonb_build_object('call_id', v_id, 'duplicate', false, 'status', 'INITIATED', 'request_state', 'PENDING', 'account_id', cfg.channel_account_id,
    'mode', cfg.click_to_call_mode, 'api_base_url', cfg.api_base_url, 'api_token_secret', cfg.api_token_secret, 'support_api_key_secret', cfg.support_api_key_secret,
    'agent_number', v_line.agent_number, 'destination_number', private.support_acefone_number(v_e164), 'caller_id', cfg.default_caller_id,
    'custom_identifier', jsonb_build_object('erpcall', replace(v_id::text, '-', '')));
end;
$$;

-- Step 2 (service role): Acefone's answer to the request. Accepted -> ref_id stored, still INITIATED.
create or replace function public.support_call_request_result(p_call uuid, p_accepted boolean, p_ref_id text, p_message text, p_http integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_calls;
begin
  select * into c from public.support_calls where id = p_call for update;
  if not found then
    raise exception 'Call not found.' using errcode = 'P0001';
  end if;
  if c.request_state <> 'PENDING' then
    return jsonb_build_object('call_id', c.id, 'status', c.status, 'request_state', c.request_state, 'duplicate', true);
  end if;
  -- No answer / server error: Acefone may still place the call, so the call stays INITIATED and only
  -- provider events move it on. A definite rejection (4xx, or success=false) fails it.
  update public.support_calls set request_state = case when p_accepted then 'ACCEPTED' when p_http is null or p_http >= 500 then 'ERROR' else 'REJECTED' end,
    request_message = left(p_message, 500), provider_ref_id = case when p_accepted then nullif(left(p_ref_id, 120), '') else provider_ref_id end
  where id = c.id;
  if not p_accepted and p_http is not null and p_http < 500 then
    perform private.support_call_advance(c.id, 'FAILED', 'Call request rejected', 'request_result', null, now());
    update public.support_calls set ended_at = now() where id = c.id;
  end if;
  insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, details, processing_result)
  select c.company_id, cfg.channel_account_id, 'CLICK_TO_CALL', null, left(p_message, 1000),
    jsonb_build_object('call_id', c.id, 'http_status', p_http, 'accepted', p_accepted, 'ref_id', p_ref_id), case when p_accepted then 'PROCESSED' else 'FAILED' end
  from public.support_phone_config cfg where cfg.company_id = c.company_id;
  return (select jsonb_build_object('call_id', id, 'status', status, 'request_state', request_state, 'ref_id', provider_ref_id) from public.support_calls where id = c.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Webhook ingestion (service role)
--   p_event: the event name in the webhook URL (one Acefone webhook per trigger):
--     received | ivr | department | dialed_agent | agent_answered | customer_answered | customer_missed |
--     agent_hangup_answered | agent_hangup_missed | hangup | hangup_answered | hangup_missed | dtmf
-- -----------------------------------------------------------------------------
create or replace function private.support_acefone_process(p_company uuid, p_event text, p_payload jsonb, p_event_key text, p_log uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.support_phone_config;
  v_tz text := private.company_tz(p_company);
  v_ref text := private.support_pv(p_payload, 'ref_id');
  v_callid text := private.support_pv(p_payload, 'call_id');
  v_uuid text := private.support_pv(p_payload, 'uuid');
  v_erp text := private.support_pv(p_payload, 'erpcall');
  v_dir text := lower(coalesce(private.support_pv(p_payload, 'direction'), ''));
  v_caller text := private.support_pv(p_payload, 'caller_id_number', 'customer_number', 'customer_number_with_prefix', 'customer_no_with_prefix');
  v_to text := private.support_pv(p_payload, 'call_to_number');
  v_customer_raw text := private.support_pv(p_payload, 'customer_number', 'customer_number_with_prefix', 'customer_no_with_prefix', 'caller_id_number');
  v_agent_no text := regexp_replace(coalesce(private.support_pv(p_payload, 'answered_agent_number', 'answer_agent_number', 'agent_number'), ''), '[^0-9]', '', 'g');
  v_billsec integer := private.support_int(private.support_pv(p_payload, 'billsec', 'answered_seconds'));
  v_duration integer := private.support_int(private.support_pv(p_payload, 'duration', 'call_duration'));
  v_ring integer := private.support_int(private.support_pv(p_payload, 'agent_ring_time'));
  v_start timestamptz := private.support_acefone_ts(private.support_pv(p_payload, 'start_stamp', 'date'), v_tz);
  v_answer timestamptz := private.support_acefone_ts(private.support_pv(p_payload, 'answer_stamp'), v_tz);
  v_end timestamptz := private.support_acefone_ts(private.support_pv(p_payload, 'end_stamp'), v_tz);
  v_call_status text := lower(coalesce(private.support_pv(p_payload, 'call_status'), ''));
  v_direction text;
  v_status text;
  v_c public.support_calls;
  v_e164 text;
  v_customer uuid;
  v_matches integer;
  v_line public.support_phone_agents;
  v_changed boolean;
  v_final boolean;
  v_msg uuid;
begin
  select * into cfg from public.support_phone_config where company_id = p_company;
  v_direction := case when v_dir like 'out%' or v_dir like '%click%' or v_dir = 'c2c' or p_event in ('customer_answered', 'customer_missed') or v_ref like 'C2C%' then 'OUTBOUND'
                      when v_dir like 'in%' then 'INBOUND' else null end;
  -- Find the call: our own id (custom identifier), the click-to-call ref_id, then Acefone's call id / uuid.
  if v_erp ~ '^[0-9a-f]{32}$' then
    select * into v_c from public.support_calls where company_id = p_company and replace(id::text, '-', '') = v_erp;
  end if;
  if v_c.id is null and v_ref is not null then
    select * into v_c from public.support_calls where company_id = p_company and provider_ref_id = v_ref;
  end if;
  if v_c.id is null and v_callid is not null then
    select * into v_c from public.support_calls where company_id = p_company and provider_call_id = v_callid;
  end if;
  if v_c.id is null and v_uuid is not null then
    select * into v_c from public.support_calls where company_id = p_company and provider_uuid = v_uuid order by created_at desc limit 1;
  end if;
  v_direction := coalesce(v_c.direction, v_direction, 'INBOUND');
  -- For inbound calls the customer is the caller; for outbound the customer is the destination.
  v_e164 := coalesce(v_c.customer_number_e164, private.support_e164(case when v_direction = 'INBOUND' then v_caller else coalesce(v_customer_raw, v_to) end));
  v_status := case p_event
    when 'received' then 'RINGING' when 'ivr' then 'RINGING' when 'department' then 'RINGING' when 'dialed_agent' then 'RINGING' when 'dtmf' then 'RINGING'
    when 'agent_answered' then 'CONNECTED'
    when 'customer_answered' then case when coalesce(v_c.click_to_call_mode, cfg.click_to_call_mode) = 'SUPPORT' then 'RINGING' else 'CONNECTED' end
    when 'customer_missed' then 'MISSED'
    when 'agent_hangup_answered' then 'COMPLETED' when 'hangup_answered' then 'COMPLETED'
    when 'agent_hangup_missed' then 'MISSED' when 'hangup_missed' then 'MISSED'
    -- A generic hangup is Completed when the call was answered (talk time, answer time, or already Connected).
    when 'hangup' then case when coalesce(v_billsec, 0) > 0 or v_call_status in ('answered', 'completed') or v_answer is not null
                              or v_c.status = 'CONNECTED' or v_c.answered_at is not null then 'COMPLETED' else 'MISSED' end
    else null end;
  if v_status is null then
    return jsonb_build_object('result', 'IGNORED', 'reason', 'Unknown event ' || coalesce(p_event, ''));
  end if;
  if v_c.id is null then
    -- Calls the ERP did not start (inbound, or dialled from the Acefone app) are recorded too.
    if v_e164 is not null then
      select count(*), min(m.customer_id::text)::uuid into v_matches, v_customer from private.support_match_customers(p_company, v_e164, null) m;
      if v_matches <> 1 then v_customer := null; end if;
    end if;
    insert into public.support_calls (company_id, direction, status, customer_id, caller_number, destination_number, customer_number_e164, provider_ref_id,
      provider_call_id, provider_uuid, started_at, last_event_at)
    values (p_company, v_direction, 'INITIATED', v_customer, v_caller, v_to, v_e164, v_ref, v_callid, v_uuid, coalesce(v_start, now()), now())
    returning * into v_c;
    update public.support_calls set conversation_id = private.support_call_conversation(p_company, v_customer, coalesce(v_e164, v_caller), v_direction, null) where id = v_c.id
    returning * into v_c;
    update public.support_calls set ticket_id = (select ticket_id from public.support_conversations where id = v_c.conversation_id) where id = v_c.id returning * into v_c;
  end if;
  -- Fill what the event knows (never erase known values).
  if v_agent_no <> '' then
    select * into v_line from public.support_phone_agents where company_id = p_company and agent_number = v_agent_no;
  end if;
  update public.support_calls set
    provider_ref_id = coalesce(provider_ref_id, v_ref), provider_call_id = coalesce(provider_call_id, v_callid), provider_uuid = coalesce(provider_uuid, v_uuid),
    caller_number = coalesce(caller_number, v_caller), destination_number = coalesce(destination_number, v_to),
    agent_number = coalesce(nullif(v_agent_no, ''), agent_number),
    agent_name = coalesce(private.support_pv(p_payload, 'answered_agent_name', 'agent_name'), agent_name),
    phone_agent_id = coalesce(phone_agent_id, v_line.id), agent_id = coalesce(agent_id, v_line.agent_id),
    started_at = coalesce(started_at, v_start), answered_at = coalesce(answered_at, v_answer, case when v_status = 'CONNECTED' then coalesce(v_start, now()) end),
    ended_at = coalesce(ended_at, v_end, case when v_status in ('COMPLETED', 'MISSED') then now() end),
    talk_seconds = coalesce(v_billsec, talk_seconds), duration_seconds = coalesce(v_duration, duration_seconds),
    ring_seconds = coalesce(v_ring, ring_seconds, case when v_answer is not null and v_start is not null then greatest(extract(epoch from v_answer - v_start)::integer, 0) end),
    hangup_cause = coalesce(left(private.support_pv(p_payload, 'hangup_cause'), 120), hangup_cause),
    disposition = coalesce(left(private.support_pv(p_payload, 'disposition', 'call_status'), 120), disposition),
    provider_recording_ref = coalesce(nullif(p_payload ->> '__recording_url', ''), provider_recording_ref),
    recording_identifier = coalesce(private.support_pv(p_payload, 'aws_call_recording_identifier'), recording_identifier)
  where id = v_c.id;
  v_changed := private.support_call_advance(v_c.id, v_status, p_event, p_event_key, p_log, coalesce(v_end, v_answer, v_start, now()));
  select * into v_c from public.support_calls where id = v_c.id;
  v_final := v_c.status in ('COMPLETED', 'MISSED', 'FAILED');
  -- Conversation: preview, unread for inbound activity; the final call becomes a CALL message once.
  update public.support_conversations set last_activity_at = greatest(last_activity_at, now()),
    last_message_preview = left(case v_c.status when 'RINGING' then case when v_c.direction = 'INBOUND' then 'Incoming call (ringing)' else 'Outgoing call (ringing)' end
      when 'CONNECTED' then 'Call in progress' when 'COMPLETED' then 'Call completed' when 'MISSED' then 'Missed call' when 'FAILED' then 'Call failed' else last_message_preview end, 300),
    status = case when v_c.direction = 'INBOUND' and v_c.status = 'MISSED' then 'OPEN' else status end
  where id = v_c.conversation_id;
  if v_final and v_c.message_id is null and v_c.conversation_id is not null then
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, call_status, call_duration_seconds, delivery_status, occurred_at)
    values (p_company, v_c.conversation_id, 'CALL', v_c.direction, 'CHANNEL', null,
      case v_c.status when 'COMPLETED' then 'ANSWERED' when 'MISSED' then 'MISSED' else 'FAILED' end, v_c.talk_seconds,
      case when v_c.direction = 'OUTBOUND' then case when v_c.status = 'COMPLETED' then 'DELIVERED' else 'FAILED' end end,
      coalesce(v_c.started_at, v_c.created_at))
    returning id into v_msg;
    update public.support_calls set message_id = v_msg where id = v_c.id;
    if v_c.direction = 'INBOUND' then
      update public.support_conversations set unread_count = unread_count + 1 where id = v_c.conversation_id;
    elsif v_c.status = 'COMPLETED' then
      perform private.support_mark_first_response(v_c.conversation_id, coalesce(v_c.answered_at, now()));
    end if;
  elsif v_final and v_c.message_id is not null then
    update public.support_messages set call_duration_seconds = coalesce(v_c.talk_seconds, call_duration_seconds) where id = v_c.message_id;
  end if;
  update public.support_phone_config set last_event_at = now() where company_id = p_company;
  return jsonb_build_object('result', 'PROCESSED', 'call_id', v_c.id, 'status', v_c.status, 'changed', v_changed);
end;
$$;

create or replace function public.support_acefone_ingest(p_account uuid, p_event text, p_payload jsonb, p_event_key text, p_source_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.support_phone_config;
  v_log uuid;
  v_out jsonb;
  v_safe jsonb := coalesce(p_payload, '{}'::jsonb) - '__recording_url';
begin
  select c.* into cfg from public.support_phone_config c where c.channel_account_id = p_account;
  if cfg.company_id is null then
    return jsonb_build_object('result', 'REJECTED', 'reason', 'unknown account');
  end if;
  -- Rate limit: at most 600 webhook events per minute per account.
  if (select count(*) from public.support_integration_events where company_id = cfg.company_id and channel_account_id = p_account and event_type = 'WEBHOOK'
      and created_at > now() - interval '1 minute') >= 600 then
    return jsonb_build_object('result', 'RATE_LIMITED');
  end if;
  insert into public.support_integration_events (company_id, channel_account_id, event_type, message, details, event_key, source_ip)
  values (cfg.company_id, p_account, case when cfg.is_enabled then 'WEBHOOK' else 'REJECTED' end, left(p_event, 100),
          jsonb_build_object('event', p_event, 'payload', v_safe), p_event_key, left(p_source_ip, 64))
  on conflict (company_id, event_key) where event_key is not null do nothing
  returning id into v_log;
  if v_log is null then
    -- Seen before. Re-process only when the earlier attempt failed (provider retry after an error).
    select id into v_log from public.support_integration_events where company_id = cfg.company_id and event_key = p_event_key and processing_result in ('ERROR');
    if v_log is null then
      return jsonb_build_object('result', 'DUPLICATE');
    end if;
  end if;
  if not cfg.is_enabled then
    update public.support_integration_events set processed_at = now(), processing_result = 'REJECTED', processing_error = 'Integration disconnected' where id = v_log;
    return jsonb_build_object('result', 'REJECTED', 'reason', 'disconnected');
  end if;
  begin
    v_out := private.support_acefone_process(cfg.company_id, p_event, coalesce(p_payload, '{}'::jsonb), p_event_key, v_log);
    update public.support_integration_events set processed_at = now(), processing_result = v_out ->> 'result', processing_error = v_out ->> 'reason' where id = v_log;
  exception when others then
    update public.support_integration_events set processed_at = now(), processing_result = 'ERROR', processing_error = left(sqlerrm, 500) where id = v_log;
    return jsonb_build_object('result', 'ERROR');
  end;
  return v_out;
end;
$$;

-- Administrators re-run a logged webhook (e.g. after fixing agent mapping). Idempotent: transitions
-- already recorded are not repeated.
create or replace function public.support_acefone_replay(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  e public.support_integration_events;
  v_out jsonb;
begin
  select * into e from public.support_integration_events where id = p_event and company_id = v_company and event_type in ('WEBHOOK', 'REJECTED') for update;
  if not found then
    raise exception 'Webhook event not found in your company.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.support_phone_config where company_id = v_company and is_enabled) then
    raise exception 'Reconnect the phone integration before replaying events.' using errcode = 'P0001';
  end if;
  begin
    v_out := private.support_acefone_process(v_company, e.details ->> 'event', coalesce(e.details -> 'payload', '{}'::jsonb), e.event_key, e.id);
    update public.support_integration_events set event_type = 'WEBHOOK', processed_at = now(), processing_result = v_out ->> 'result', processing_error = v_out ->> 'reason',
      replay_count = replay_count + 1 where id = e.id;
  exception when others then
    update public.support_integration_events set processed_at = now(), processing_result = 'ERROR', processing_error = left(sqlerrm, 500), replay_count = replay_count + 1 where id = e.id;
    raise exception 'Replay failed: %', sqlerrm using errcode = 'P0001';
  end;
  perform private.support_audit(v_company, 'phone.event_replayed', 'integration_events', e.id::text, jsonb_build_object('result', v_out ->> 'result'));
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Call records (CDR) sync and recordings (service role)
-- -----------------------------------------------------------------------------
create or replace function public.support_phone_runtime(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('company_id', c.company_id, 'account_id', c.channel_account_id, 'is_enabled', c.is_enabled, 'mode', c.click_to_call_mode,
    'api_base_url', c.api_base_url, 'api_token_secret', c.api_token_secret, 'support_api_key_secret', c.support_api_key_secret,
    'webhook_secret_name', c.webhook_secret_name, 'webhook_allowed_ips', c.webhook_allowed_ips, 'recording_retrieval', c.recording_retrieval,
    'recording_retention_days', c.recording_retention_days, 'last_sync_at', c.last_sync_at, 'timezone', private.company_tz(c.company_id))
  from public.support_phone_config c where c.channel_account_id = p_account;
$$;

create or replace function public.support_phone_accounts()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select channel_account_id from public.support_phone_config where is_enabled;
$$;

-- Fills calls from Acefone call records (GET /v1/call/records). Matches by call_id / uuid; unknown calls
-- are created as missed or completed. Returns counts.
create or replace function public.support_acefone_cdr_upsert(p_account uuid, p_records jsonb, p_sync_ok boolean, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.support_phone_config;
  r jsonb;
  v_out jsonb;
  v_new integer := 0;
  v_seen integer := 0;
  v_status text;
begin
  select * into cfg from public.support_phone_config where channel_account_id = p_account;
  if cfg.company_id is null then
    raise exception 'Unknown phone account.' using errcode = 'P0001';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) loop
    v_seen := v_seen + 1;
    v_status := case when lower(coalesce(r ->> 'status', '')) in ('answered', 'completed') or coalesce((r ->> 'answered_seconds')::numeric, 0) > 0 then 'hangup_answered' else 'hangup_missed' end;
    v_out := private.support_acefone_process(cfg.company_id, v_status,
      jsonb_build_object('call_id', r ->> 'call_id', 'uuid', r ->> 'uuid', 'direction', r ->> 'direction',
        'caller_id_number', case when lower(r ->> 'direction') = 'inbound' then r ->> 'client_number' else r ->> 'did_number' end,
        'call_to_number', case when lower(r ->> 'direction') = 'inbound' then r ->> 'did_number' else r ->> 'client_number' end,
        'customer_number', r ->> 'client_number', 'agent_number', r ->> 'agent_number', 'agent_name', r ->> 'agent_name',
        'billsec', r ->> 'answered_seconds', 'duration', r ->> 'call_duration', 'agent_ring_time', r ->> 'agent_ring_time', 'hangup_cause', r ->> 'hangup_cause',
        'start_stamp', concat_ws(' ', r ->> 'date', r ->> 'time'), 'end_stamp', r ->> 'end_stamp', 'aws_call_recording_identifier', r ->> 'aws_call_recording_identifier',
        '__recording_url', r ->> 'recording_url'),
      'cdr:' || coalesce(r ->> 'call_id', r ->> 'uuid', r ->> 'id'), null);
    if v_out ->> 'changed' = 'true' then v_new := v_new + 1; end if;
  end loop;
  update public.support_phone_config set last_sync_at = case when p_sync_ok then now() else last_sync_at end,
    last_sync_status = left(coalesce(p_message, case when p_sync_ok then 'OK' else 'Failed' end), 300) where company_id = cfg.company_id;
  insert into public.support_integration_events (company_id, channel_account_id, event_type, message, details, processing_result)
  values (cfg.company_id, p_account, 'CDR_SYNC', left(coalesce(p_message, ''), 1000), jsonb_build_object('records', v_seen, 'changed', v_new),
          case when p_sync_ok then 'PROCESSED' else 'ERROR' end);
  return jsonb_build_object('records', v_seen, 'changed', v_new);
end;
$$;

create or replace function public.support_phone_test_result(p_account uuid, p_ok boolean, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.support_phone_config set last_test_at = now(), last_test_result = left(p_message, 300) where channel_account_id = p_account;
  perform public.support_record_integration_health(p_account, case when p_ok then 'CONNECTED' else 'ERROR' end, p_message, '{}'::jsonb);
end;
$$;

-- Recordings to copy (provider link known, retrieval on, not stored yet) and stored ones past retention.
create or replace function public.support_recordings_due(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'fetch', coalesce((select jsonb_agg(jsonb_build_object('call_id', s.id, 'company_id', s.company_id, 'url', s.provider_recording_ref) order by s.ended_at)
       from public.support_calls s join public.support_phone_config c on c.company_id = s.company_id
       where c.channel_account_id = p_account and c.recording_retrieval and s.provider_recording_ref is not null and s.recording_attachment_id is null
         and s.recording_purged_at is null and s.ended_at > now() - make_interval(days => c.recording_retention_days) limit 50), '[]'::jsonb),
    'purge', coalesce((select jsonb_agg(jsonb_build_object('call_id', s.id, 'storage_path', a.storage_path))
       from public.support_calls s join public.support_phone_config c on c.company_id = s.company_id join public.support_attachments a on a.id = s.recording_attachment_id
       where c.channel_account_id = p_account and s.ended_at < now() - make_interval(days => c.recording_retention_days) limit 200), '[]'::jsonb));
$$;

create or replace function public.support_recording_stored(p_call uuid, p_path text, p_content_type text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_calls;
  v uuid;
begin
  select * into c from public.support_calls where id = p_call for update;
  if c.recording_attachment_id is not null then
    return c.recording_attachment_id;
  end if;
  if p_path not like c.company_id::text || '/%' then
    raise exception 'Recording path outside the company folder.' using errcode = 'P0001';
  end if;
  insert into public.support_attachments (company_id, conversation_id, message_id, ticket_id, file_name, storage_path, content_type, size_bytes, is_recording, is_sensitive)
  values (c.company_id, c.conversation_id, c.message_id, c.ticket_id, 'call-recording-' || to_char(coalesce(c.started_at, c.created_at), 'YYYYMMDD-HH24MI') || '.mp3',
          p_path, p_content_type, p_size, true, true)
  returning id into v;
  -- The provider link is no longer needed once the file is stored privately.
  update public.support_calls set recording_attachment_id = v, provider_recording_ref = null where id = c.id;
  return v;
end;
$$;

create or replace function public.support_recording_purged(p_call uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_att uuid;
begin
  select recording_attachment_id into v_att from public.support_calls where id = p_call for update;
  update public.support_calls set recording_attachment_id = null, provider_recording_ref = null, recording_purged_at = now() where id = p_call;
  delete from public.support_attachments where id = v_att;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Call log, call detail and the incoming-call panel
-- -----------------------------------------------------------------------------
create or replace function public.support_call_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_term text := nullif(btrim(coalesce(p ->> 'search', '')), '');
  v_ph text := private.support_normalize_phone(p ->> 'search');
begin
  return (
    with f as (
      select s.* from public.support_calls s left join public.support_customers c on c.id = s.customer_id
      where s.company_id = v_company
        and (nullif(p ->> 'direction', '') is null or s.direction = upper(p ->> 'direction'))
        and (nullif(p ->> 'status', '') is null or s.status = upper(p ->> 'status'))
        and (nullif(p ->> 'customer_id', '') is null or s.customer_id = (p ->> 'customer_id')::uuid)
        and (nullif(p ->> 'ticket_id', '') is null or s.ticket_id = (p ->> 'ticket_id')::uuid)
        and (nullif(p ->> 'agent_id', '') is null or s.agent_id = (p ->> 'agent_id')::uuid)
        and (nullif(p ->> 'from', '') is null or s.created_at >= (p ->> 'from')::date)
        and (nullif(p ->> 'to', '') is null or s.created_at < (p ->> 'to')::date + 1)
        and (v_term is null or c.display_name ilike '%' || v_term || '%' or s.provider_ref_id ilike '%' || v_term || '%' or s.provider_call_id ilike '%' || v_term || '%'
             or (v_ph is not null and private.support_normalize_phone(s.customer_number_e164) like '%' || v_ph || '%')))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(r order by r ->> 'created_at' desc) from (
      select jsonb_build_object('id', f.id, 'direction', f.direction, 'status', f.status, 'customer_id', f.customer_id,
        'customer_name', (select display_name from public.support_customers where id = f.customer_id), 'customer_number', f.customer_number_e164,
        'caller_number', f.caller_number, 'destination_number', f.destination_number, 'agent_name', coalesce((select display_name from public.support_agents where id = f.agent_id), f.agent_name),
        'ticket_id', f.ticket_id, 'ticket_number', (select ticket_number from public.support_tickets where id = f.ticket_id), 'started_at', f.started_at, 'ended_at', f.ended_at,
        'ring_seconds', f.ring_seconds, 'talk_seconds', f.talk_seconds, 'disposition', f.disposition, 'has_recording', f.recording_attachment_id is not null,
        'created_at', f.created_at) r
      from f order by f.created_at desc limit least(greatest(coalesce((p ->> 'limit')::integer, 25), 1), 200) offset greatest(coalesce((p ->> 'offset')::integer, 0), 0)) z), '[]'::jsonb)));
end;
$$;

create or replace function public.support_call_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  s public.support_calls;
  v_sensitive boolean;
begin
  select * into s from public.support_calls where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Call not found in your company.' using errcode = 'P0001';
  end if;
  v_sensitive := private.has_permission(v_company, 'support.manage_tickets');
  return jsonb_build_object(
    'call', to_jsonb(s) - 'company_id' - 'provider_recording_ref' - 'idempotency_key',
    'customer', (select jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name) from public.support_customers c where c.id = s.customer_id),
    'ticket', (select jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status) from public.support_tickets t where t.id = s.ticket_id),
    'agent', (select jsonb_build_object('id', a.id, 'display_name', a.display_name) from public.support_agents a where a.id = s.agent_id),
    'initiated_by', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = s.initiated_by),
    'recording', case when s.recording_attachment_id is null then jsonb_build_object('state', case when s.recording_purged_at is not null then 'PURGED'
                   when s.provider_recording_ref is not null then 'AT_PROVIDER' else 'NONE' end)
                 else (select jsonb_build_object('state', 'STORED', 'attachment_id', a.id, 'file_name', a.file_name,
                   'storage_path', case when v_sensitive then a.storage_path end, 'restricted', not v_sensitive)
                   from public.support_attachments a where a.id = s.recording_attachment_id) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('event_name', e.event_name, 'from', e.from_status, 'to', e.to_status, 'occurred_at', e.occurred_at, 'at', e.created_at)
                order by e.created_at, e.id) from public.support_call_events e where e.call_id = s.id), '[]'::jsonb));
end;
$$;

-- Live inbound calls for the incoming-call panel (support.reply): ringing or connected in the last 15 minutes,
-- with the matched customer, open tickets and previous interactions.
create or replace function public.support_live_calls()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'direction', s.direction, 'status', s.status, 'number', s.customer_number_e164,
      'started_at', coalesce(s.started_at, s.created_at), 'conversation_id', s.conversation_id, 'agent_name', coalesce(a.display_name, s.agent_name),
      'customer', (select jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name, 'company_name', c.company_name)
                   from public.support_customers c where c.id = s.customer_id),
      'candidates', case when s.customer_id is null then (select count(*) from private.support_match_customers(v_company, s.customer_number_e164, null)) else 1 end,
      'open_tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status) order by t.created_at desc)
                       from public.support_tickets t where t.customer_id = s.customer_id and t.status not in ('RESOLVED', 'CLOSED')), '[]'::jsonb),
      'previous_calls', (select count(*) from public.support_calls x where x.company_id = v_company and x.customer_number_e164 = s.customer_number_e164 and x.id <> s.id),
      'previous_conversations', (select count(*) from public.support_conversations v where v.customer_id = s.customer_id)) order by s.created_at desc)
    from (select x.id, x.direction, x.status, x.customer_number_e164, x.started_at, x.created_at, x.conversation_id, x.agent_id, x.agent_name,
            coalesce(x.customer_id, (select v.customer_id from public.support_conversations v where v.id = x.conversation_id)) as customer_id
          from public.support_calls x where x.company_id = v_company and x.status in ('RINGING', 'CONNECTED') and x.created_at > now() - interval '15 minutes') s
    left join public.support_agents a on a.id = s.agent_id), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------
revoke all on function private.support_acefone_process(uuid, text, jsonb, text, uuid) from public, anon, authenticated;
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_phone_config_get', 'support_phone_config_save', 'support_phone_disconnect', 'support_phone_agent_save',
             'support_call_lines', 'support_call_prepare', 'support_acefone_replay', 'support_phone_admin_check', 'support_call_list', 'support_call_detail', 'support_live_calls') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Service role only: called by the Edge Functions after their own checks.
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_call_request_result', 'support_acefone_ingest', 'support_phone_runtime', 'support_phone_accounts',
             'support_acefone_cdr_upsert', 'support_phone_test_result', 'support_recordings_due', 'support_recording_stored', 'support_recording_purged') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. ERP reset allowlist (20261210090000 plus the phone tables)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (0, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
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
