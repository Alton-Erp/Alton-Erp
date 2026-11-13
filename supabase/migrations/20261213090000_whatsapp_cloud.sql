-- =============================================================================
-- Meta WhatsApp Cloud API for the Support Centre (direct; no Zoho Bigin, no WhatsApp Web automation)
--
-- Additive; builds on 20261210090000_support_centre and 20261212090000_gmail_support.
--
--   * Credentials (system-user access token, app secret, webhook verify token) live ONLY in Edge Function
--     secrets. The database keeps non-secret identifiers (portfolio, WABA, phone number id, app id) and the
--     Graph API version chosen by the administrator (no version is hard-coded).
--   * Migration safety: the live number is not touched. A setup state (NOT_CONFIGURED, NUMBER_ELIGIBILITY_PENDING,
--     MIGRATION_REQUIRED, COEXISTENCE_PENDING, WEBHOOK_PENDING, CONNECTED, ERROR) is derived from the administrator's
--     confirmations (checklist), the connection test (Meta phone number info: platform CLOUD_API, status CONNECTED),
--     a passed webhook verification challenge and at least one correctly signed webhook. The integration can be
--     switched on only in CONNECTED; until then webhook events are stored and held, and nothing can be sent.
--   * Webhooks: every change is stored raw (server-only table, purged after 30 days), de-duplicated by its hash,
--     and processed idempotently (unique WhatsApp message id; statuses only move forward).
--   * Sending: free-form text / media only inside the 24-hour customer service window (from the customer's last
--     message); otherwise only APPROVED templates synchronised from Meta. A message is Pending until Meta's status
--     webhook reports sent / delivered / read / failed — the API accepting a request is not "sent".
--   * Media is downloaded only through Meta's authenticated media endpoint into the private support-attachments bucket.
--
-- Rollback: supabase/rollback/20261213090000_whatsapp_cloud_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Event log types
-- -----------------------------------------------------------------------------
alter table public.support_integration_events drop constraint if exists support_integration_events_event_type_check;
alter table public.support_integration_events add constraint support_integration_events_event_type_check
  check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR', 'CLICK_TO_CALL', 'CDR_SYNC', 'RECORDING_SYNC', 'REPLAY',
                         'DISCONNECTED', 'REJECTED', 'OAUTH', 'MAIL_SYNC', 'WATCH', 'SEND', 'SETUP', 'TEMPLATE_SYNC', 'MEDIA'));

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_whatsapp_config (
  company_id                  uuid primary key references public.companies (id) on delete restrict,
  channel_account_id          uuid not null,
  business_portfolio_id       text check (business_portfolio_id is null or business_portfolio_id ~ '^[0-9]{5,25}$'),
  waba_id                     text check (waba_id is null or waba_id ~ '^[0-9]{5,25}$'),
  phone_number_id             text check (phone_number_id is null or phone_number_id ~ '^[0-9]{5,25}$'),
  display_phone_number        text check (display_phone_number is null or display_phone_number ~ '^\+?[0-9 ()-]{6,24}$'),
  app_id                      text check (app_id is null or app_id ~ '^[0-9]{5,25}$'),
  -- Chosen by the administrator from Meta's Graph API changelog (e.g. v27.0); never defaulted in code.
  graph_api_version           text check (graph_api_version is null or graph_api_version ~ '^v[0-9]{1,3}\.[0-9]$'),
  -- How the number is used today (preflight): unknown until the administrator confirms it.
  number_path                 text not null default 'UNKNOWN'
                                check (number_path in ('UNKNOWN', 'BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE')),
  checklist                   jsonb not null default '{}'::jsonb check (jsonb_typeof(checklist) = 'object'),
  setup_state                 text not null default 'NOT_CONFIGURED'
                                check (setup_state in ('NOT_CONFIGURED', 'NUMBER_ELIGIBILITY_PENDING', 'MIGRATION_REQUIRED', 'COEXISTENCE_PENDING',
                                                       'WEBHOOK_PENDING', 'CONNECTED', 'ERROR')),
  integration_enabled         boolean not null default false,
  enabled_at                  timestamptz,
  enabled_by                  uuid,
  webhook_verified_at         timestamptz,
  webhook_signed_event_at     timestamptz,
  last_webhook_at             timestamptz,
  last_inbound_at             timestamptz,
  last_outbound_success_at    timestamptz,
  last_test_at                timestamptz,
  last_test_ok                boolean,
  last_test_result            text check (last_test_result is null or length(last_test_result) <= 500),
  phone_info                  jsonb not null default '{}'::jsonb,
  templates_synced_at         timestamptz,
  last_error                  text check (last_error is null or length(last_error) <= 500),
  last_error_at               timestamptz,
  created_by                  uuid,
  updated_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint support_whatsapp_config_account_unique unique (channel_account_id),
  constraint support_whatsapp_config_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_whatsapp_config_enabled check (not integration_enabled or setup_state = 'CONNECTED')
);

-- Raw webhook changes (server only: no app access). Payload removed after 30 days; metadata kept.
create table if not exists public.support_whatsapp_webhook_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  event_key           text not null check (event_key ~ '^[0-9a-f]{64}$'),
  field               text not null check (length(field) <= 80),
  entry_id            text check (entry_id is null or length(entry_id) <= 40),
  payload             jsonb,
  counts              jsonb not null default '{}'::jsonb,
  result              text not null default 'PENDING' check (result in ('PENDING', 'PROCESSED', 'HELD', 'REJECTED', 'IGNORED', 'ERROR')),
  error               text check (error is null or length(error) <= 1000),
  attempts            integer not null default 0,
  replay_count        integer not null default 0,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  payload_purged_at   timestamptz,
  constraint support_whatsapp_webhook_events_key_unique unique (company_id, event_key),
  constraint support_whatsapp_webhook_events_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);
create index if not exists support_whatsapp_webhook_events_recent_idx on public.support_whatsapp_webhook_events (company_id, received_at desc);

create table if not exists public.support_whatsapp_templates (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  meta_template_id    text not null check (meta_template_id ~ '^[0-9]{1,30}$'),
  name                text not null check (name ~ '^[a-z0-9_]+$' and length(name) <= 512),
  language            text not null check (language ~ '^[A-Za-z_]{2,10}$'),
  category            text check (category is null or length(category) <= 40),
  status              text not null check (length(status) <= 40),
  parameter_format    text check (parameter_format is null or parameter_format in ('NAMED', 'POSITIONAL')),
  components          jsonb not null default '[]'::jsonb check (jsonb_typeof(components) = 'array'),
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint support_whatsapp_templates_meta_unique unique (company_id, meta_template_id),
  constraint support_whatsapp_templates_id_company_unique unique (id, company_id),
  constraint support_whatsapp_templates_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);

-- One WhatsApp contact per conversation: wa_id (phone digits) and/or the business-scoped user id (BSUID).
create table if not exists public.support_whatsapp_threads (
  conversation_id     uuid primary key,
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  wa_id               text check (wa_id is null or wa_id ~ '^[0-9]{6,20}$'),
  user_id             text check (user_id is null or length(user_id) between 1 and 128),
  profile_name        text check (profile_name is null or length(profile_name) <= 200),
  -- The customer service window runs 24 hours from this (the customer's last message).
  last_inbound_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint support_whatsapp_threads_contact check (wa_id is not null or user_id is not null),
  constraint support_whatsapp_threads_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_whatsapp_threads_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);
create unique index if not exists support_whatsapp_threads_wa_unique on public.support_whatsapp_threads (company_id, channel_account_id, wa_id) where wa_id is not null;
create unique index if not exists support_whatsapp_threads_user_unique on public.support_whatsapp_threads (company_id, channel_account_id, user_id) where user_id is not null;

create table if not exists public.support_whatsapp_messages (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  message_id          uuid not null,
  conversation_id     uuid not null,
  channel_account_id  uuid not null,
  direction           text not null check (direction in ('INBOUND', 'OUTBOUND')),
  wa_message_id       text check (wa_message_id is null or length(wa_message_id) between 4 and 200),
  waba_id             text,
  phone_number_id     text,
  wa_id               text check (wa_id is null or wa_id ~ '^[0-9]{6,20}$'),
  user_id             text check (user_id is null or length(user_id) <= 128),
  msg_type            text not null check (msg_type ~ '^[a-z_]{2,30}$'),
  wa_timestamp        timestamptz,
  context_wa_message_id text check (context_wa_message_id is null or length(context_wa_message_id) <= 200),
  -- Media (inbound: Meta media id from the webhook; outbound: our uploaded file)
  media_id            text check (media_id is null or media_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  media_mime          text check (media_mime is null or length(media_mime) <= 120),
  media_sha256        text check (media_sha256 is null or length(media_sha256) <= 120),
  media_filename      text check (media_filename is null or length(media_filename) <= 255),
  media_caption       text check (media_caption is null or length(media_caption) <= 3000),
  media_state         text not null default 'NONE' check (media_state in ('NONE', 'PENDING', 'STORED', 'FAILED', 'EXPIRED', 'TOO_LARGE', 'BLOCKED')),
  media_error         text check (media_error is null or length(media_error) <= 300),
  media_attempts      integer not null default 0,
  attachment_id       uuid,
  location            jsonb,
  interactive         jsonb,
  -- Outbound: PENDING until Meta's status webhook; inbound: RECEIVED.
  status              text not null check (status in ('RECEIVED', 'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  status_at           timestamptz,
  error_code          integer,
  error_title         text check (error_title is null or length(error_title) <= 300),
  error_detail        text check (error_detail is null or length(error_detail) <= 1000),
  template_id         uuid,
  template_name       text,
  template_language   text,
  idempotency_key     text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9-]{16,64}$'),
  requested_by        uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint support_whatsapp_messages_message_unique unique (message_id),
  constraint support_whatsapp_messages_message_fk foreign key (message_id, company_id) references public.support_messages (id, company_id) on delete restrict,
  constraint support_whatsapp_messages_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_whatsapp_messages_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_whatsapp_messages_template_fk foreign key (template_id, company_id) references public.support_whatsapp_templates (id, company_id) on delete restrict,
  constraint support_whatsapp_messages_inbound_status check ((direction = 'INBOUND') = (status = 'RECEIVED'))
);
create unique index if not exists support_whatsapp_messages_wa_unique on public.support_whatsapp_messages (company_id, wa_message_id) where wa_message_id is not null;
create unique index if not exists support_whatsapp_messages_idem_unique on public.support_whatsapp_messages (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists support_whatsapp_messages_conversation_idx on public.support_whatsapp_messages (conversation_id, created_at);
create index if not exists support_whatsapp_messages_media_idx on public.support_whatsapp_messages (company_id, media_state) where media_state in ('PENDING', 'FAILED');

-- Every status Meta reported (also before the send result arrived, or for messages sent outside the ERP).
create table if not exists public.support_whatsapp_statuses (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  wa_message_id   text not null check (length(wa_message_id) between 4 and 200),
  status          text not null check (status in ('SENT', 'DELIVERED', 'READ', 'FAILED', 'PLAYED')),
  status_at       timestamptz,
  error_code      integer,
  error_title     text check (error_title is null or length(error_title) <= 300),
  error_detail    text check (error_detail is null or length(error_detail) <= 1000),
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint support_whatsapp_statuses_unique unique (company_id, wa_message_id, status)
);

do $$
declare
  t text;
begin
  foreach t in array array['support_whatsapp_config', 'support_whatsapp_webhook_events', 'support_whatsapp_templates', 'support_whatsapp_threads',
                           'support_whatsapp_messages', 'support_whatsapp_statuses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;
-- Raw webhook payloads are never readable by the app.
grant select on public.support_whatsapp_config, public.support_whatsapp_templates, public.support_whatsapp_threads, public.support_whatsapp_messages,
  public.support_whatsapp_statuses to authenticated;
drop policy if exists support_whatsapp_config_select on public.support_whatsapp_config;
create policy support_whatsapp_config_select on public.support_whatsapp_config for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_whatsapp_templates_select on public.support_whatsapp_templates;
create policy support_whatsapp_templates_select on public.support_whatsapp_templates for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_whatsapp_threads_select on public.support_whatsapp_threads;
create policy support_whatsapp_threads_select on public.support_whatsapp_threads for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_whatsapp_messages_select on public.support_whatsapp_messages;
create policy support_whatsapp_messages_select on public.support_whatsapp_messages for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_whatsapp_statuses_select on public.support_whatsapp_statuses;
create policy support_whatsapp_statuses_select on public.support_whatsapp_statuses for select to authenticated using (private.has_permission(company_id, 'support.view'));

do $$
declare
  t text;
begin
  foreach t in array array['support_whatsapp_config', 'support_whatsapp_templates', 'support_whatsapp_threads', 'support_whatsapp_messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end;
$$;
drop trigger if exists support_whatsapp_config_audit on public.support_whatsapp_config;
create trigger support_whatsapp_config_audit after insert or update or delete on public.support_whatsapp_config
  for each row execute function private.support_audit_row();

-- -----------------------------------------------------------------------------
-- 3. Setup state, checklist and health
-- -----------------------------------------------------------------------------
-- Checklist items an administrator confirms; which ones are required depends on how the number is used today.
create or replace function private.support_whatsapp_checklist_items()
returns table (key text, label text, required_for text[])
language sql
immutable
set search_path = ''
as $$
  values
    ('number_path_confirmed', 'Confirmed how the support number is used today (WhatsApp Business app, Cloud API, a provider such as the current Zoho Bigin connection, or coexistence).',
      array['BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE']),
    ('cloud_api_eligibility', 'Meta confirmed the number can be registered on the WhatsApp Cloud API under this WhatsApp Business Account.',
      array['BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE']),
    ('migration_completed', 'Migration completed through Meta''s supported path (the number released by its current app / provider and registered on Cloud API). Not done by the ERP.',
      array['BUSINESS_APP_ONLY', 'BSP']),
    ('coexistence_approved', 'Coexistence onboarding (WhatsApp Business app + Cloud API) completed through an approved Meta partner.',
      array['COEXISTENCE']),
    ('previous_routing_retired', 'Messages for this number are no longer routed through Zoho Bigin or another provider (or coexistence confirmed what stays in the app).',
      array['BUSINESS_APP_ONLY', 'BSP', 'COEXISTENCE']),
    ('system_user_token', 'A permanent system-user access token with whatsapp_business_messaging and whatsapp_business_management is set as WHATSAPP_ACCESS_TOKEN.',
      array['BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE']),
    ('webhook_subscribed', 'The Meta app is subscribed to this WhatsApp Business Account''s "messages" webhook with the ERP callback URL.',
      array['BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE']),
    ('templates_reviewed', 'Message templates needed for business-initiated messages are approved in WhatsApp Manager (recommended).', array[]::text[]);
$$;

create or replace function private.support_whatsapp_done(c public.support_whatsapp_config, p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((c.checklist -> p_key ->> 'done')::boolean, false);
$$;

create or replace function private.support_whatsapp_compute_state(c public.support_whatsapp_config)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  k record;
begin
  if c.waba_id is null or c.phone_number_id is null or c.display_phone_number is null or c.app_id is null or c.graph_api_version is null then
    return 'NOT_CONFIGURED';
  end if;
  if c.number_path = 'UNKNOWN' or not private.support_whatsapp_done(c, 'number_path_confirmed') or not private.support_whatsapp_done(c, 'cloud_api_eligibility')
     or c.last_test_ok is null then
    return 'NUMBER_ELIGIBILITY_PENDING';
  end if;
  if c.number_path in ('BUSINESS_APP_ONLY', 'BSP') and not (private.support_whatsapp_done(c, 'migration_completed') and private.support_whatsapp_done(c, 'previous_routing_retired')) then
    return 'MIGRATION_REQUIRED';
  end if;
  if c.number_path = 'COEXISTENCE' and not (private.support_whatsapp_done(c, 'coexistence_approved') and private.support_whatsapp_done(c, 'previous_routing_retired')) then
    return 'COEXISTENCE_PENDING';
  end if;
  if c.last_test_ok = false then
    return 'ERROR';
  end if;
  for k in select * from private.support_whatsapp_checklist_items() i where c.number_path = any (i.required_for) loop
    if not private.support_whatsapp_done(c, k.key) then
      return case when k.key in ('webhook_subscribed', 'system_user_token') then 'WEBHOOK_PENDING' else 'NUMBER_ELIGIBILITY_PENDING' end;
    end if;
  end loop;
  if c.webhook_verified_at is null or c.webhook_signed_event_at is null then
    return 'WEBHOOK_PENDING';
  end if;
  return 'CONNECTED';
end;
$$;

-- Recomputes the setup state; switches the integration off when it is no longer CONNECTED; mirrors the channel health.
create or replace function private.support_whatsapp_refresh(p_company uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  v_state text;
  v_health text;
  v_detail text;
begin
  select * into c from public.support_whatsapp_config where company_id = p_company for update;
  if not found then
    return null;
  end if;
  v_state := private.support_whatsapp_compute_state(c);
  update public.support_whatsapp_config set setup_state = v_state,
    integration_enabled = integration_enabled and v_state = 'CONNECTED',
    enabled_at = case when integration_enabled and v_state = 'CONNECTED' then enabled_at end
  where company_id = p_company;
  select * into c from public.support_whatsapp_config where company_id = p_company;
  v_health := case when c.integration_enabled then 'CONNECTED' when v_state = 'ERROR' then 'ERROR' when v_state = 'NOT_CONFIGURED' then 'NOT_CONNECTED' else 'SETUP_REQUIRED' end;
  v_detail := case v_state
    when 'NOT_CONFIGURED' then 'Enter the Meta identifiers and the Graph API version.'
    when 'NUMBER_ELIGIBILITY_PENDING' then 'Confirm the number''s Cloud API eligibility and run Test connection.'
    when 'MIGRATION_REQUIRED' then 'The number must be migrated to the Cloud API through Meta''s supported path first.'
    when 'COEXISTENCE_PENDING' then 'Coexistence onboarding through an approved partner is not confirmed yet.'
    when 'WEBHOOK_PENDING' then 'Waiting for webhook verification and a signed webhook event from Meta.'
    when 'ERROR' then coalesce(c.last_test_result, 'The last connection test failed.')
    else case when c.integration_enabled then 'Connected to the WhatsApp Cloud API.' else 'Ready: an administrator can switch the integration on.' end end;
  if exists (select 1 from public.support_channel_accounts where id = c.channel_account_id and (status <> v_health or status_detail is distinct from left(v_detail, 500))) then
    perform public.support_record_integration_health(c.channel_account_id, v_health, v_detail, jsonb_build_object('setup_state', v_state, 'reason', p_reason));
  end if;
  return v_state;
end;
$$;

revoke all on function private.support_whatsapp_checklist_items(), private.support_whatsapp_done(public.support_whatsapp_config, text),
  private.support_whatsapp_compute_state(public.support_whatsapp_config), private.support_whatsapp_refresh(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Settings (support.manage_integrations)
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
begin
  select * into c from public.support_whatsapp_config where company_id = v_company;
  return jsonb_build_object(
    'config', case when c.company_id is null then null else to_jsonb(c) - 'company_id' - 'created_by' - 'updated_by' end,
    'account', (select jsonb_build_object('id', a.id, 'status', a.status, 'status_detail', a.status_detail, 'last_checked_at', a.last_checked_at)
                from public.support_channel_accounts a where a.id = c.channel_account_id),
    'checklist_items', (select jsonb_agg(jsonb_build_object('key', i.key, 'label', i.label, 'required', coalesce(c.number_path, 'UNKNOWN') = any (i.required_for),
                          'done', coalesce((c.checklist -> i.key ->> 'done')::boolean, false), 'note', c.checklist -> i.key ->> 'note',
                          'by', (select coalesce(p.full_name, p.email) from public.profiles p where p.id::text = c.checklist -> i.key ->> 'by'),
                          'at', c.checklist -> i.key ->> 'at')) from private.support_whatsapp_checklist_items() i),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'language', t.language, 'category', t.category, 'status', t.status) order by t.name, t.language)
                           from public.support_whatsapp_templates t where t.company_id = v_company), '[]'::jsonb),
    'counts', jsonb_build_object(
      'received', (select count(*) from public.support_whatsapp_messages where company_id = v_company and direction = 'INBOUND'),
      'sent', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status in ('SENT', 'DELIVERED', 'READ')),
      'pending', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status = 'PENDING'),
      'failed', (select count(*) from public.support_whatsapp_messages where company_id = v_company and status = 'FAILED'),
      'media_pending', (select count(*) from public.support_whatsapp_messages where company_id = v_company and media_state = 'PENDING')),
    -- Webhook log without message content.
    'events', coalesce((select jsonb_agg(e order by e ->> 'received_at' desc) from (
                select jsonb_build_object('id', w.id, 'field', w.field, 'result', w.result, 'error', w.error, 'counts', w.counts, 'replay_count', w.replay_count,
                  'received_at', w.received_at, 'processed_at', w.processed_at, 'purged', w.payload is null) e
                from public.support_whatsapp_webhook_events w where w.company_id = v_company order by w.received_at desc limit 50) z), '[]'::jsonb));
end;
$$;

create or replace function public.support_whatsapp_config_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
  v_account uuid;
  v_digits text;
  v_ids_changed boolean;
  f text;
begin
  if p ?| array['app_secret', 'access_token', 'token', 'verify_token', 'secret', 'password', 'setup_state', 'status', 'integration_enabled', 'checklist',
                'webhook_verified_at', 'webhook_signed_event_at', 'last_test_ok'] then
    raise exception 'Secrets are never saved here (they are Edge Function secrets), and the setup state is derived by the server.' using errcode = 'P0001';
  end if;
  foreach f in array array['business_portfolio_id', 'waba_id', 'phone_number_id', 'app_id'] loop
    if nullif(btrim(coalesce(p ->> f, '')), '') is not null and btrim(p ->> f) !~ '^[0-9]{5,25}$' then
      raise exception '% must be the numeric id from Meta Business Suite / WhatsApp Manager.', initcap(replace(f, '_', ' ')) using errcode = 'P0001';
    end if;
  end loop;
  if nullif(btrim(coalesce(p ->> 'graph_api_version', '')), '') is not null and btrim(p ->> 'graph_api_version') !~ '^v[0-9]{1,3}\.[0-9]$' then
    raise exception 'The Graph API version looks like v27.0 (see Meta''s Graph API changelog for the supported versions).' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'number_path', 'UNKNOWN') not in ('UNKNOWN', 'BUSINESS_APP_ONLY', 'CLOUD_API', 'BSP', 'COEXISTENCE') then
    raise exception 'Unknown number path.' using errcode = 'P0001';
  end if;
  v_digits := nullif(regexp_replace(coalesce(p ->> 'display_phone_number', ''), '[^0-9]', '', 'g'), '');
  if v_digits is not null and length(v_digits) not between 6 and 15 then
    raise exception 'Enter the display phone number with its country code.' using errcode = 'P0001';
  end if;
  select * into c from public.support_whatsapp_config where company_id = v_company for update;
  if not found then
    insert into public.support_channel_accounts (company_id, channel, display_name, identifier, provider, credentials_ref, status, status_detail, is_active, created_by, updated_by)
    values (v_company, 'WHATSAPP', 'WhatsApp (Meta Cloud API)', case when v_digits is not null then '+' || v_digits end, 'Meta WhatsApp Cloud API', 'WHATSAPP_ACCESS_TOKEN',
            'NOT_CONNECTED', 'Not configured.', true, auth.uid(), auth.uid())
    returning id into v_account;
    insert into public.support_whatsapp_config (company_id, channel_account_id, created_by, updated_by) values (v_company, v_account, auth.uid(), auth.uid());
    select * into c from public.support_whatsapp_config where company_id = v_company for update;
    perform private.support_gmail_event(v_company, v_account, 'ACCOUNT_CREATED', 'WhatsApp settings created; the integration stays off until onboarding is confirmed.',
      '{}'::jsonb, null, null, null, auth.uid());
  end if;
  v_ids_changed := c.waba_id is distinct from nullif(btrim(p ->> 'waba_id'), '') or c.phone_number_id is distinct from nullif(btrim(p ->> 'phone_number_id'), '')
                   or c.number_path is distinct from coalesce(p ->> 'number_path', 'UNKNOWN');
  update public.support_whatsapp_config set
    business_portfolio_id = nullif(btrim(p ->> 'business_portfolio_id'), ''), waba_id = nullif(btrim(p ->> 'waba_id'), ''),
    phone_number_id = nullif(btrim(p ->> 'phone_number_id'), ''), display_phone_number = case when v_digits is not null then '+' || v_digits end,
    app_id = nullif(btrim(p ->> 'app_id'), ''), graph_api_version = nullif(btrim(p ->> 'graph_api_version'), ''),
    number_path = coalesce(p ->> 'number_path', 'UNKNOWN'),
    -- Another account / number / path: earlier evidence no longer applies.
    webhook_signed_event_at = case when v_ids_changed then null else webhook_signed_event_at end,
    last_test_ok = case when v_ids_changed then null else last_test_ok end,
    last_test_result = case when v_ids_changed then null else last_test_result end,
    integration_enabled = integration_enabled and not v_ids_changed,
    updated_by = auth.uid()
  where company_id = v_company;
  update public.support_channel_accounts set identifier = case when v_digits is not null then '+' || v_digits end, updated_by = auth.uid()
  where id = c.channel_account_id and identifier is distinct from case when v_digits is not null then '+' || v_digits end;
  perform private.support_whatsapp_refresh(v_company, 'settings saved');
  return public.support_whatsapp_config_get();
end;
$$;

create or replace function public.support_whatsapp_checklist_set(p_key text, p_done boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
begin
  if not exists (select 1 from private.support_whatsapp_checklist_items() where key = p_key) then
    raise exception 'Unknown checklist item.' using errcode = 'P0001';
  end if;
  select * into c from public.support_whatsapp_config where company_id = v_company for update;
  if not found then
    raise exception 'Save the WhatsApp settings first.' using errcode = 'P0001';
  end if;
  if p_done and p_key in ('migration_completed', 'coexistence_approved', 'cloud_api_eligibility') and length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'Add a note with the evidence (e.g. Meta case or partner reference, date).' using errcode = 'P0001';
  end if;
  update public.support_whatsapp_config set checklist = checklist || jsonb_build_object(p_key, jsonb_build_object('done', coalesce(p_done, false),
      'note', left(nullif(btrim(coalesce(p_note, '')), ''), 500), 'by', auth.uid(), 'at', now())), updated_by = auth.uid()
  where company_id = v_company;
  perform private.support_gmail_event(v_company, c.channel_account_id, 'SETUP', left(format('Checklist: %s %s.', p_key, case when p_done then 'confirmed' else 'cleared' end), 1000),
    jsonb_build_object('item', p_key, 'done', p_done), null, null, null, auth.uid());
  perform private.support_whatsapp_refresh(v_company, 'checklist');
  return public.support_whatsapp_config_get();
end;
$$;

-- The integration can be switched on only when the setup state is CONNECTED.
create or replace function public.support_whatsapp_set_enabled(p_enabled boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_whatsapp_config;
begin
  perform private.support_whatsapp_refresh(v_company, 'activation check');
  select * into c from public.support_whatsapp_config where company_id = v_company for update;
  if not found then
    raise exception 'Save the WhatsApp settings first.' using errcode = 'P0001';
  end if;
  if p_enabled and c.setup_state <> 'CONNECTED' then
    raise exception 'WhatsApp cannot be switched on yet: the setup state is %. Complete the onboarding checklist, the connection test and the webhook verification first.',
      replace(lower(c.setup_state), '_', ' ') using errcode = 'P0001';
  end if;
  update public.support_whatsapp_config set integration_enabled = coalesce(p_enabled, false), enabled_at = case when p_enabled then now() end,
    enabled_by = case when p_enabled then auth.uid() end, updated_by = auth.uid() where company_id = v_company;
  perform private.support_gmail_event(v_company, c.channel_account_id, 'SETUP', left(case when p_enabled then 'WhatsApp integration switched on.' else
    'WhatsApp integration switched off: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given') end, 1000), '{}'::jsonb, null, null, null, auth.uid());
  perform private.support_whatsapp_refresh(v_company, case when p_enabled then 'enabled' else 'disabled' end);
  return public.support_whatsapp_config_get();
end;
$$;

create or replace function public.support_whatsapp_admin_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
begin
  return (select jsonb_build_object('company_id', c.company_id, 'account_id', c.channel_account_id) from public.support_whatsapp_config c where c.company_id = v_company);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Service role: runtime, verification, test, templates
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_runtime(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('company_id', c.company_id, 'account_id', c.channel_account_id, 'waba_id', c.waba_id, 'phone_number_id', c.phone_number_id,
    'display_phone_number', c.display_phone_number, 'app_id', c.app_id, 'graph_api_version', c.graph_api_version, 'setup_state', c.setup_state,
    'integration_enabled', c.integration_enabled, 'number_path', c.number_path)
  from public.support_whatsapp_config c where c.channel_account_id = p_account;
$$;

create or replace function public.support_whatsapp_accounts()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select channel_account_id from public.support_whatsapp_config where waba_id is not null and phone_number_id is not null and graph_api_version is not null;
$$;

-- GET verification challenge answered with the right verify token.
create or replace function public.support_whatsapp_webhook_verified(p_account uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account for update;
  if not found then
    return false;
  end if;
  update public.support_whatsapp_config set webhook_verified_at = now() where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'SETUP', 'Webhook verification challenge answered.', '{}'::jsonb, 'PROCESSED');
  perform private.support_whatsapp_refresh(c.company_id, 'webhook verified');
  return true;
end;
$$;

-- Connection test result (Meta phone number info). p_ok is decided by the Edge Function: status CONNECTED, platform CLOUD_API, same number.
create or replace function public.support_whatsapp_test_result(p_account uuid, p_ok boolean, p_info jsonb, p_message text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account for update;
  if not found then
    raise exception 'WhatsApp settings not found.' using errcode = 'P0001';
  end if;
  update public.support_whatsapp_config set last_test_at = now(), last_test_ok = p_ok, last_test_result = left(p_message, 500),
    phone_info = case when p_info is not null and jsonb_typeof(p_info) = 'object' then p_info else phone_info end,
    last_error = case when p_ok then last_error else left(p_message, 500) end, last_error_at = case when p_ok then last_error_at else now() end
  where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'HEALTH_CHECK', left('Connection test: ' || coalesce(p_message, ''), 1000),
    coalesce(p_info, '{}'::jsonb), case when p_ok then 'PROCESSED' else 'ERROR' end, case when p_ok then null else p_message end);
  return private.support_whatsapp_refresh(c.company_id, 'connection test');
end;
$$;

-- Approved-template catalogue from GET /{WABA-ID}/message_templates. Templates no longer returned are marked REMOVED.
create or replace function public.support_whatsapp_templates_sync(p_account uuid, p_templates jsonb, p_complete boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  t jsonb;
  n integer := 0;
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account for update;
  if not found or jsonb_typeof(p_templates) <> 'array' then
    raise exception 'WhatsApp settings not found.' using errcode = 'P0001';
  end if;
  for t in select * from jsonb_array_elements(p_templates) loop
    if t ->> 'id' !~ '^[0-9]{1,30}$' or t ->> 'name' !~ '^[a-z0-9_]+$' or length(t ->> 'name') > 512 or t ->> 'language' !~ '^[A-Za-z_]{2,10}$' then
      continue;
    end if;
    insert into public.support_whatsapp_templates (company_id, channel_account_id, meta_template_id, name, language, category, status, parameter_format, components, synced_at)
    values (c.company_id, p_account, t ->> 'id', t ->> 'name', t ->> 'language', left(upper(t ->> 'category'), 40), left(upper(coalesce(t ->> 'status', 'UNKNOWN')), 40),
      case upper(t ->> 'parameter_format') when 'NAMED' then 'NAMED' when 'POSITIONAL' then 'POSITIONAL' end,
      case when jsonb_typeof(t -> 'components') = 'array' then t -> 'components' else '[]'::jsonb end, now())
    on conflict (company_id, meta_template_id) do update set name = excluded.name, language = excluded.language, category = excluded.category, status = excluded.status,
      parameter_format = excluded.parameter_format, components = excluded.components, synced_at = now(), channel_account_id = excluded.channel_account_id;
    n := n + 1;
  end loop;
  if p_complete then
    update public.support_whatsapp_templates set status = 'REMOVED', synced_at = now()
    where company_id = c.company_id and status <> 'REMOVED'
      and meta_template_id not in (select x ->> 'id' from jsonb_array_elements(p_templates) x where x ->> 'id' is not null);
  end if;
  update public.support_whatsapp_config set templates_synced_at = now() where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'TEMPLATE_SYNC', format('%s templates synchronised.', n), '{}'::jsonb, 'PROCESSED');
  return n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Webhook ingestion and processing
-- -----------------------------------------------------------------------------
create or replace function private.support_whatsapp_status_rank(p text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case upper(p) when 'PENDING' then 0 when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 when 'PLAYED' then 3 else -1 end;
$$;

-- Recomputes an outbound message's status from every status Meta reported: forward only; FAILED only before delivery.
create or replace function private.support_whatsapp_apply_status(p_company uuid, p_wa_message_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_whatsapp_messages;
  best text;
  best_at timestamptz;
  f public.support_whatsapp_statuses;
begin
  select * into m from public.support_whatsapp_messages where company_id = p_company and wa_message_id = p_wa_message_id and direction = 'OUTBOUND' for update;
  if not found then
    return null;
  end if;
  select case when s.status = 'PLAYED' then 'READ' else s.status end, s.status_at into best, best_at from public.support_whatsapp_statuses s
  where s.company_id = p_company and s.wa_message_id = p_wa_message_id and s.status <> 'FAILED'
  order by private.support_whatsapp_status_rank(s.status) desc limit 1;
  select * into f from public.support_whatsapp_statuses s where s.company_id = p_company and s.wa_message_id = p_wa_message_id and s.status = 'FAILED';
  if f.id is not null and coalesce(private.support_whatsapp_status_rank(best), 0) < 2 then
    best := 'FAILED';
    best_at := f.status_at;
  end if;
  if best is null or (best <> 'FAILED' and private.support_whatsapp_status_rank(best) <= private.support_whatsapp_status_rank(m.status) and m.status <> 'FAILED') then
    return m.status;
  end if;
  if m.status = 'FAILED' and best <> 'FAILED' and private.support_whatsapp_status_rank(best) < 2 then
    return m.status;
  end if;
  update public.support_whatsapp_messages set status = best, status_at = best_at,
    error_code = case when best = 'FAILED' then f.error_code else error_code end,
    error_title = case when best = 'FAILED' then f.error_title else error_title end,
    error_detail = case when best = 'FAILED' then f.error_detail else error_detail end
  where id = m.id;
  update public.support_messages set delivery_status = best,
    delivery_error = case when best = 'FAILED' then left(coalesce(f.error_title, 'Failed') || coalesce(' (' || f.error_code || ')', '') || coalesce(': ' || f.error_detail, ''), 500) end
  where id = m.message_id;
  if best in ('SENT', 'DELIVERED', 'READ') then
    update public.support_whatsapp_config set last_outbound_success_at = greatest(coalesce(last_outbound_success_at, best_at), best_at) where company_id = p_company;
  end if;
  return best;
end;
$$;

create or replace function private.support_whatsapp_process(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.support_whatsapp_webhook_events;
  c public.support_whatsapp_config;
  v jsonb;
  m jsonb;
  s jsonb;
  err jsonb;
  v_type text;
  v_wa text;
  v_user text;
  v_name text;
  v_at timestamptz;
  v_body text;
  v_media jsonb;
  v_conv uuid;
  v_msg uuid;
  v_n integer;
  v_customer uuid;
  v_new boolean;
  v_stored integer := 0;
  v_dup integer := 0;
  v_status integer := 0;
  v_media_n integer := 0;
begin
  select * into e from public.support_whatsapp_webhook_events where id = p_event for update;
  select * into c from public.support_whatsapp_config where company_id = e.company_id;
  v := e.payload;
  -- Inbound messages
  for m in select * from jsonb_array_elements(coalesce(v -> 'messages', '[]'::jsonb)) loop
    if coalesce(m ->> 'id', '') = '' or length(m ->> 'id') > 200 then
      continue;
    end if;
    if exists (select 1 from public.support_whatsapp_messages where company_id = e.company_id and wa_message_id = m ->> 'id') then
      v_dup := v_dup + 1;
      continue;
    end if;
    v_type := lower(left(regexp_replace(coalesce(m ->> 'type', 'unknown'), '[^a-zA-Z_]', '', 'g'), 30));
    if length(v_type) < 2 then v_type := 'unknown'; end if;
    v_wa := nullif(regexp_replace(coalesce(m ->> 'from', ''), '[^0-9]', '', 'g'), '');
    if v_wa is not null and length(v_wa) not between 6 and 20 then v_wa := null; end if;
    v_user := left(nullif(m ->> 'from_user_id', ''), 128);
    if v_wa is null and v_user is null then
      continue;
    end if;
    v_name := left((select x #>> '{profile,name}' from jsonb_array_elements(coalesce(v -> 'contacts', '[]'::jsonb)) x
                    where (v_wa is not null and x ->> 'wa_id' = v_wa) or (v_user is not null and x ->> 'user_id' = v_user) limit 1), 200);
    v_at := case when m ->> 'timestamp' ~ '^[0-9]{9,11}$' then to_timestamp((m ->> 'timestamp')::bigint) else e.received_at end;
    v_media := case when v_type in ('image', 'video', 'audio', 'document', 'sticker') then m -> v_type end;
    v_body := left(case v_type
      when 'text' then m #>> '{text,body}'
      when 'image' then coalesce(nullif(v_media ->> 'caption', ''), '[Image]')
      when 'video' then coalesce(nullif(v_media ->> 'caption', ''), '[Video]')
      when 'audio' then '[Audio message]'
      when 'sticker' then '[Sticker]'
      when 'document' then '[Document] ' || coalesce(v_media ->> 'filename', '') || coalesce(' — ' || nullif(v_media ->> 'caption', ''), '')
      when 'location' then '[Location] ' || concat_ws(', ', nullif(m #>> '{location,name}', ''), nullif(m #>> '{location,address}', ''))
                           || format(' (%s, %s)', m #>> '{location,latitude}', m #>> '{location,longitude}')
      when 'interactive' then coalesce(m #>> '{interactive,button_reply,title}', m #>> '{interactive,list_reply,title}', '[Interactive reply]')
                              || coalesce(' — ' || nullif(m #>> '{interactive,list_reply,description}', ''), '')
      when 'button' then coalesce(m #>> '{button,text}', '[Button reply]')
      when 'reaction' then '[Reaction] ' || coalesce(m #>> '{reaction,emoji}', '')
      when 'contacts' then '[Contact card]'
      else '[Unsupported message type: ' || v_type || ']' end, 20000);
    -- Thread: by wa_id, else by business-scoped user id; else a new conversation.
    select conversation_id into v_conv from public.support_whatsapp_threads t
    where t.company_id = e.company_id and t.channel_account_id = e.channel_account_id
      and ((v_wa is not null and t.wa_id = v_wa) or (v_user is not null and t.user_id = v_user)) limit 1;
    v_new := v_conv is null;
    if v_new then
      v_customer := null;
      v_n := 0;
      if v_wa is not null then
        -- Link a customer only when exactly one customer has this number.
        select count(*), (array_agg(customer_id))[1] into v_n, v_customer from private.support_match_customers(e.company_id, '+' || v_wa, null);
      end if;
      insert into public.support_conversations (company_id, channel, channel_account_id, customer_id, contact_name, contact_phone, status, external_thread_id, last_activity_at)
      values (e.company_id, 'WHATSAPP', e.channel_account_id, case when v_n = 1 then v_customer end, v_name, case when v_wa is not null then '+' || v_wa end, 'OPEN',
              'wa:' || coalesce(v_wa, 'u:' || v_user), v_at)
      returning id into v_conv;
      insert into public.support_whatsapp_threads (conversation_id, company_id, channel_account_id, wa_id, user_id, profile_name)
      values (v_conv, e.company_id, e.channel_account_id, v_wa, v_user, v_name);
    end if;
    update public.support_whatsapp_threads set last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
      wa_id = coalesce(wa_id, v_wa), user_id = coalesce(user_id, v_user), profile_name = coalesce(v_name, profile_name)
    where conversation_id = v_conv;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, external_message_id, occurred_at)
    values (e.company_id, v_conv, 'MESSAGE', 'INBOUND', 'CHANNEL', coalesce(nullif(v_body, ''), '[Empty message]'), m ->> 'id', v_at)
    returning id into v_msg;
    insert into public.support_whatsapp_messages (company_id, message_id, conversation_id, channel_account_id, direction, wa_message_id, waba_id, phone_number_id,
      wa_id, user_id, msg_type, wa_timestamp, context_wa_message_id, media_id, media_mime, media_sha256, media_filename, media_caption, media_state,
      location, interactive, status, status_at, error_code, error_title, error_detail)
    values (e.company_id, v_msg, v_conv, e.channel_account_id, 'INBOUND', m ->> 'id', e.entry_id, v #>> '{metadata,phone_number_id}', v_wa, v_user, v_type, v_at,
      left(m #>> '{context,id}', 200),
      case when v_media ->> 'id' ~ '^[0-9A-Za-z_-]{1,64}$' then v_media ->> 'id' end, left(v_media ->> 'mime_type', 120), left(v_media ->> 'sha256', 120),
      left(v_media ->> 'filename', 255), left(v_media ->> 'caption', 3000),
      case when v_media ->> 'id' ~ '^[0-9A-Za-z_-]{1,64}$' then 'PENDING' else 'NONE' end,
      case when v_type = 'location' then m -> 'location' end, case when v_type in ('interactive', 'button') then coalesce(m -> 'interactive', m -> 'button') end,
      'RECEIVED', v_at, nullif(m #>> '{errors,0,code}', '')::integer, left(m #>> '{errors,0,title}', 300), left(m #>> '{errors,0,error_data,details}', 1000));
    if v_media ->> 'id' ~ '^[0-9A-Za-z_-]{1,64}$' then v_media_n := v_media_n + 1; end if;
    perform private.support_touch_conversation(v_conv, v_body, v_at, 1);
    update public.support_conversations set status = 'OPEN' where id = v_conv and status <> 'OPEN';
    if v_new then
      perform private.support_run_automation(e.company_id, 'CONVERSATION_CREATED', null, v_conv);
    end if;
    update public.support_whatsapp_config set last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at) where company_id = e.company_id;
    v_stored := v_stored + 1;
  end loop;
  -- Status updates (sent / delivered / read / failed)
  for s in select * from jsonb_array_elements(coalesce(v -> 'statuses', '[]'::jsonb)) loop
    if coalesce(s ->> 'id', '') = '' or upper(coalesce(s ->> 'status', '')) not in ('SENT', 'DELIVERED', 'READ', 'FAILED', 'PLAYED') then
      continue;
    end if;
    insert into public.support_whatsapp_statuses (company_id, wa_message_id, status, status_at, error_code, error_title, error_detail, details)
    values (e.company_id, left(s ->> 'id', 200), upper(s ->> 'status'),
      case when s ->> 'timestamp' ~ '^[0-9]{9,11}$' then to_timestamp((s ->> 'timestamp')::bigint) else e.received_at end,
      nullif(s #>> '{errors,0,code}', '')::integer, left(s #>> '{errors,0,title}', 300),
      left(coalesce(s #>> '{errors,0,error_data,details}', s #>> '{errors,0,message}'), 1000),
      jsonb_strip_nulls(jsonb_build_object('pricing', s -> 'pricing', 'conversation', s -> 'conversation')))
    on conflict (company_id, wa_message_id, status) do nothing;
    perform private.support_whatsapp_apply_status(e.company_id, left(s ->> 'id', 200));
    v_status := v_status + 1;
  end loop;
  -- Account / app level errors
  for err in select * from jsonb_array_elements(coalesce(v -> 'errors', '[]'::jsonb)) loop
    update public.support_whatsapp_config set last_error = left(coalesce(err ->> 'title', 'Error') || coalesce(' (' || (err ->> 'code') || ')', '')
      || coalesce(': ' || (err #>> '{error_data,details}'), ''), 500), last_error_at = now() where company_id = e.company_id;
  end loop;
  update public.support_whatsapp_webhook_events set result = 'PROCESSED', processed_at = now(), error = null, attempts = attempts + 1,
    counts = jsonb_build_object('messages', v_stored, 'duplicates', v_dup, 'statuses', v_status, 'media', v_media_n)
  where id = e.id;
  return jsonb_build_object('result', 'PROCESSED', 'messages', v_stored, 'duplicates', v_dup, 'statuses', v_status, 'media', v_media_n);
end;
$$;

-- Service role (whatsapp-webhook, after the signature check): store one webhook change and process it.
create or replace function public.support_whatsapp_ingest(p_account uuid, p_entry_id text, p_field text, p_value jsonb, p_event_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_whatsapp_config;
  v_id uuid;
  v_prev public.support_whatsapp_webhook_events;
  v_out jsonb;
begin
  select * into c from public.support_whatsapp_config where channel_account_id = p_account;
  if not found then
    return jsonb_build_object('result', 'UNKNOWN');
  end if;
  if p_event_key is null or p_event_key !~ '^[0-9a-f]{64}$' or p_value is null or jsonb_typeof(p_value) <> 'object' then
    return jsonb_build_object('result', 'INVALID');
  end if;
  if (select count(*) from public.support_whatsapp_webhook_events where company_id = c.company_id and received_at > now() - interval '1 minute') >= 3000 then
    return jsonb_build_object('result', 'RATE_LIMITED');
  end if;
  select * into v_prev from public.support_whatsapp_webhook_events where company_id = c.company_id and event_key = p_event_key for update;
  if found then
    if v_prev.result <> 'ERROR' then
      return jsonb_build_object('result', 'DUPLICATE', 'event_id', v_prev.id);
    end if;
    v_id := v_prev.id;
  else
    insert into public.support_whatsapp_webhook_events (company_id, channel_account_id, event_key, field, entry_id, payload)
    values (c.company_id, p_account, p_event_key, left(coalesce(p_field, 'unknown'), 80), left(p_entry_id, 40), p_value)
    returning id into v_id;
  end if;
  update public.support_whatsapp_config set last_webhook_at = now() where company_id = c.company_id;
  -- Must be this WhatsApp Business Account and phone number.
  if p_entry_id is distinct from c.waba_id or (p_field = 'messages' and p_value #>> '{metadata,phone_number_id}' is distinct from c.phone_number_id) then
    update public.support_whatsapp_webhook_events set result = 'REJECTED', processed_at = now(), error = 'Not the configured WhatsApp Business Account / phone number.' where id = v_id;
    return jsonb_build_object('result', 'REJECTED', 'event_id', v_id);
  end if;
  -- A correctly signed event for this account: evidence that the webhook subscription works.
  if c.webhook_signed_event_at is null then
    update public.support_whatsapp_config set webhook_signed_event_at = now() where company_id = c.company_id;
    perform private.support_whatsapp_refresh(c.company_id, 'signed webhook received');
  end if;
  if p_field = 'message_template_status_update' then
    update public.support_whatsapp_templates set status = left(upper(p_value ->> 'event'), 40), synced_at = now()
    where company_id = c.company_id and meta_template_id = p_value ->> 'message_template_id' and coalesce(p_value ->> 'event', '') <> '';
    update public.support_whatsapp_webhook_events set result = 'PROCESSED', processed_at = now() where id = v_id;
    return jsonb_build_object('result', 'PROCESSED', 'event_id', v_id);
  end if;
  if p_field <> 'messages' then
    update public.support_whatsapp_webhook_events set result = 'IGNORED', processed_at = now() where id = v_id;
    return jsonb_build_object('result', 'IGNORED', 'event_id', v_id);
  end if;
  -- Held (stored, not turned into conversations) until the integration is switched on.
  select * into c from public.support_whatsapp_config where company_id = c.company_id;
  if not c.integration_enabled then
    update public.support_whatsapp_webhook_events set result = 'HELD', processed_at = now(), error = 'Integration not switched on.' where id = v_id;
    return jsonb_build_object('result', 'HELD', 'event_id', v_id);
  end if;
  begin
    v_out := private.support_whatsapp_process(v_id);
  exception when others then
    update public.support_whatsapp_webhook_events set result = 'ERROR', processed_at = now(), error = left(sqlerrm, 1000), attempts = attempts + 1 where id = v_id;
    return jsonb_build_object('result', 'ERROR', 'event_id', v_id);
  end;
  return v_out || jsonb_build_object('event_id', v_id);
end;
$$;

-- Administrator: reprocess a held or failed webhook event from its stored payload (idempotent).
create or replace function public.support_whatsapp_event_replay(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  e public.support_whatsapp_webhook_events;
  c public.support_whatsapp_config;
  v_out jsonb;
begin
  select * into e from public.support_whatsapp_webhook_events where id = p_event and company_id = v_company for update;
  if not found then
    raise exception 'Webhook event not found.' using errcode = 'P0001';
  end if;
  select * into c from public.support_whatsapp_config where company_id = v_company;
  if e.result not in ('HELD', 'ERROR') or e.field <> 'messages' then
    raise exception 'Only held or failed message events can be replayed.' using errcode = 'P0001';
  end if;
  if e.payload is null then
    raise exception 'The payload of this event was removed after 30 days.' using errcode = 'P0001';
  end if;
  if not c.integration_enabled then
    raise exception 'Switch the WhatsApp integration on before replaying events.' using errcode = 'P0001';
  end if;
  update public.support_whatsapp_webhook_events set replay_count = replay_count + 1 where id = e.id;
  begin
    v_out := private.support_whatsapp_process(e.id);
  exception when others then
    update public.support_whatsapp_webhook_events set result = 'ERROR', processed_at = now(), error = left(sqlerrm, 1000) where id = e.id;
    return jsonb_build_object('result', 'ERROR', 'error', left(sqlerrm, 300));
  end;
  return v_out;
end;
$$;

create or replace function public.support_whatsapp_purge_payloads(p_days integer default 30)
returns integer
language sql
security definer
set search_path = ''
as $$
  with x as (
    update public.support_whatsapp_webhook_events set payload = null, payload_purged_at = now()
    where payload is not null and received_at < now() - make_interval(days => greatest(p_days, 7)) and result in ('PROCESSED', 'REJECTED', 'IGNORED', 'HELD')
    returning 1)
  select count(*)::int from x;
$$;

-- -----------------------------------------------------------------------------
-- 7. Media (asynchronous download through Meta's authenticated media endpoint)
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_media_due(p_limit integer default 20, p_message uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'company_id', m.company_id, 'account_id', m.channel_account_id, 'message_id', m.message_id,
    'conversation_id', m.conversation_id, 'media_id', m.media_id, 'mime', m.media_mime, 'sha256', m.media_sha256, 'filename', m.media_filename,
    'msg_type', m.msg_type, 'received_at', coalesce(m.wa_timestamp, m.created_at), 'attempts', m.media_attempts) order by m.created_at), '[]'::jsonb)
  from (select * from public.support_whatsapp_messages x
        where x.direction = 'INBOUND' and x.media_id is not null and x.media_state in ('PENDING', 'FAILED') and x.media_attempts < 5
          and (p_message is null or x.id = p_message)
        order by x.created_at limit least(greatest(p_limit, 1), 50)) m;
$$;

create or replace function public.support_whatsapp_media_result(p_id uuid, p_state text, p_path text, p_content_type text, p_size bigint, p_error text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_whatsapp_messages;
  v_att uuid;
begin
  if p_state not in ('STORED', 'FAILED', 'EXPIRED', 'TOO_LARGE', 'BLOCKED') then
    raise exception 'Unknown media state.' using errcode = 'P0001';
  end if;
  select * into m from public.support_whatsapp_messages where id = p_id for update;
  if not found then
    raise exception 'WhatsApp message not found.' using errcode = 'P0001';
  end if;
  if m.media_state = 'STORED' then
    return m.attachment_id;
  end if;
  if p_state = 'STORED' then
    if p_path is null or p_path not like m.company_id::text || '/whatsapp/' || m.id::text || '/%' or p_path like '%..%' then
      raise exception 'Invalid media path.' using errcode = 'P0001';
    end if;
    if p_size is null or p_size <= 0 or p_size > 26214400 then
      raise exception 'Invalid media size.' using errcode = 'P0001';
    end if;
    insert into public.support_attachments (company_id, conversation_id, message_id, file_name, storage_path, content_type, size_bytes)
    values (m.company_id, m.conversation_id, m.message_id, left(coalesce(nullif(btrim(m.media_filename), ''), m.msg_type || '-' || left(m.wa_message_id, 12)), 255), p_path,
      left(p_content_type, 120), p_size)
    on conflict (storage_path) do nothing
    returning id into v_att;
  end if;
  update public.support_whatsapp_messages set media_state = p_state, media_error = left(p_error, 300), media_attempts = media_attempts + 1,
    attachment_id = coalesce(v_att, attachment_id) where id = m.id;
  return v_att;
end;
$$;

-- Agent (support.view): ask for one message's media now (the Edge Function then downloads it).
create or replace function public.support_whatsapp_media_request(p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return exists (select 1 from public.support_whatsapp_messages where id = p_id and company_id = v_company and media_state in ('PENDING', 'FAILED') and media_id is not null);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Sending (support.reply): window and template rules are enforced here
-- -----------------------------------------------------------------------------
create or replace function private.support_whatsapp_template_vars(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct m[1]), '{}') from regexp_matches(coalesce(p_text, ''), '\{\{\s*([A-Za-z0-9_]+)\s*\}\}', 'g') as x (m);
$$;

create or replace function public.support_whatsapp_send_prepare(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  c public.support_whatsapp_config;
  v_kind text := upper(coalesce(p ->> 'kind', ''));
  v_key text := p ->> 'idempotency_key';
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  th public.support_whatsapp_threads;
  e public.support_whatsapp_messages;
  tpl public.support_whatsapp_templates;
  v_text text;
  v_caption text;
  v_params jsonb := coalesce(p -> 'parameters', '[]'::jsonb);
  v_vars text[];
  v_header_vars text[];
  v_body_text text;
  v_header jsonb;
  v_components jsonb := '[]'::jsonb;
  v_rendered text;
  v_path text;
  v_ext text;
  v_size bigint;
  v_media_kind text;
  v_context text;
  v_to text;
  v_msg uuid;
  v_wam uuid;
  v_att uuid;
  v_n integer;
  v_customer uuid;
  i integer;
  x jsonb;
begin
  if v_key is null or v_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'Missing request key.' using errcode = 'P0001';
  end if;
  select * into e from public.support_whatsapp_messages where company_id = v_company and idempotency_key = v_key;
  if found then
    return jsonb_build_object('existing', true, 'id', e.id, 'message_id', e.message_id, 'conversation_id', e.conversation_id, 'status', e.status,
      'error_code', e.error_code, 'error_title', e.error_title);
  end if;
  select * into c from public.support_whatsapp_config where company_id = v_company;
  if not found or not c.integration_enabled or c.setup_state <> 'CONNECTED' then
    raise exception 'WhatsApp is not switched on. An administrator completes the onboarding in Support Settings → WhatsApp.' using errcode = 'P0001';
  end if;
  if v_kind not in ('TEXT', 'MEDIA', 'TEMPLATE') then
    raise exception 'Unknown message kind.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.support_whatsapp_messages where company_id = v_company and requested_by = auth.uid() and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Too many messages in a minute. Wait a moment and try again.' using errcode = 'P0001';
  end if;

  if v_conv is not null then
    select * into th from public.support_whatsapp_threads where conversation_id = v_conv and company_id = v_company;
    if not found then
      raise exception 'WhatsApp conversation not found in your company.' using errcode = 'P0001';
    end if;
  elsif v_kind = 'TEMPLATE' then
    -- Business-initiated: a new conversation with a phone number (templates only).
    v_to := nullif(regexp_replace(coalesce(p ->> 'to', ''), '[^0-9]', '', 'g'), '');
    if v_to is null or length(v_to) not between 8 and 15 then
      raise exception 'Enter the WhatsApp number with its country code (e.g. +91 98765 43210).' using errcode = 'P0001';
    end if;
    select * into th from public.support_whatsapp_threads where company_id = v_company and channel_account_id = c.channel_account_id and wa_id = v_to;
    if not found then
      select count(*), (array_agg(customer_id))[1] into v_n, v_customer from private.support_match_customers(v_company, '+' || v_to, null);
      if nullif(p ->> 'customer_id', '') is not null then
        if not exists (select 1 from public.support_customers where id = (p ->> 'customer_id')::uuid and company_id = v_company) then
          raise exception 'Customer not found in your company.' using errcode = 'P0001';
        end if;
        v_customer := (p ->> 'customer_id')::uuid;
        v_n := 1;
      end if;
      insert into public.support_conversations (company_id, channel, channel_account_id, customer_id, contact_phone, status, external_thread_id, created_by, updated_by)
      values (v_company, 'WHATSAPP', c.channel_account_id, case when v_n = 1 then v_customer end, '+' || v_to, 'PENDING', 'wa:' || v_to, auth.uid(), auth.uid())
      returning id into v_conv;
      insert into public.support_whatsapp_threads (conversation_id, company_id, channel_account_id, wa_id) values (v_conv, v_company, c.channel_account_id, v_to)
      returning * into th;
    end if;
    v_conv := th.conversation_id;
  else
    raise exception 'Choose the WhatsApp conversation.' using errcode = 'P0001';
  end if;

  if v_kind in ('TEXT', 'MEDIA') then
    -- Customer service window: free-form messages only within 24 hours of the customer's last message.
    if th.last_inbound_at is null or th.last_inbound_at <= now() - interval '24 hours' then
      raise exception 'The 24-hour customer service window is closed%. Only an approved template can be sent now.',
        coalesce(' (last customer message ' || to_char(th.last_inbound_at at time zone 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC)', '') using errcode = 'P0001';
    end if;
  end if;
  if nullif(p ->> 'reply_to', '') is not null then
    select wa_message_id into v_context from public.support_whatsapp_messages where id = (p ->> 'reply_to')::uuid and conversation_id = v_conv and company_id = v_company;
    if v_context is null then
      raise exception 'The message you reply to is not in this conversation.' using errcode = 'P0001';
    end if;
  end if;

  if v_kind = 'TEXT' then
    v_text := nullif(btrim(coalesce(p ->> 'text', '')), '');
    if v_text is null or length(v_text) > 4096 then
      raise exception 'Enter the message (at most 4,096 characters).' using errcode = 'P0001';
    end if;
    v_rendered := v_text;
  elsif v_kind = 'MEDIA' then
    v_path := p ->> 'path';
    v_ext := lower(substring(coalesce(p ->> 'file_name', '') from '\.([A-Za-z0-9]{1,8})$'));
    v_size := nullif(p ->> 'size_bytes', '')::bigint;
    v_caption := nullif(btrim(coalesce(p ->> 'caption', '')), '');
    if v_path is null or v_path not like v_company::text || '/outbox/' || v_key || '/%' or v_path like '%..%' or length(v_path) > 500 then
      raise exception 'Upload the file for this message first.' using errcode = 'P0001';
    end if;
    v_media_kind := case when v_ext in ('jpg', 'jpeg', 'png') then 'image'
                         when v_ext in ('pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx') then 'document' end;
    if v_media_kind is null then
      raise exception 'WhatsApp accepts images (JPEG, PNG) and documents (PDF, text, Word, Excel, PowerPoint) here.' using errcode = 'P0001';
    end if;
    if v_size is null or v_size <= 0 or (v_media_kind = 'image' and v_size > 5242880) or v_size > 26214400 then
      raise exception 'Too large: images up to 5 MB, documents up to 25 MB.' using errcode = 'P0001';
    end if;
    if v_caption is not null and length(v_caption) > 1024 then
      raise exception 'The caption can have at most 1,024 characters.' using errcode = 'P0001';
    end if;
    v_rendered := coalesce(v_caption, case when v_media_kind = 'image' then '[Image]' else '[Document] ' || (p ->> 'file_name') end);
  else
    select * into tpl from public.support_whatsapp_templates where id = nullif(p ->> 'template_id', '')::uuid and company_id = v_company;
    if not found or tpl.status <> 'APPROVED' then
      raise exception 'Only templates approved by Meta can be sent. Synchronise the templates and choose an approved one.' using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_array_elements(tpl.components) k where upper(k ->> 'type') = 'HEADER' and upper(coalesce(k ->> 'format', 'TEXT')) <> 'TEXT')
       or exists (select 1 from jsonb_array_elements(tpl.components) k, jsonb_array_elements(coalesce(k -> 'buttons', '[]'::jsonb)) b
                  where upper(k ->> 'type') = 'BUTTONS' and (b ->> 'url') ~ '\{\{') then
      raise exception 'This template needs a media header or button parameters, which the ERP does not send. Use another template.' using errcode = 'P0001';
    end if;
    select k ->> 'text' into v_body_text from jsonb_array_elements(tpl.components) k where upper(k ->> 'type') = 'BODY' limit 1;
    select k into v_header from jsonb_array_elements(tpl.components) k where upper(k ->> 'type') = 'HEADER' limit 1;
    v_vars := private.support_whatsapp_template_vars(v_body_text);
    v_header_vars := private.support_whatsapp_template_vars(v_header ->> 'text');
    if jsonb_typeof(v_params) <> 'object' then
      raise exception 'Template values must be given by placeholder.' using errcode = 'P0001';
    end if;
    -- Every placeholder needs a value: no newlines or tabs, at most 1,024 characters.
    for i in 1 .. coalesce(array_length(v_vars || v_header_vars, 1), 0) loop
      if nullif(btrim(coalesce(v_params ->> (v_vars || v_header_vars)[i], '')), '') is null then
        raise exception 'Enter a value for {{%}}.', (v_vars || v_header_vars)[i] using errcode = 'P0001';
      end if;
      if (v_params ->> (v_vars || v_header_vars)[i]) ~ '[\n\t]' or length(v_params ->> (v_vars || v_header_vars)[i]) > 1024 then
        raise exception 'Template values cannot contain line breaks or tabs and have at most 1,024 characters ({{%}}).', (v_vars || v_header_vars)[i] using errcode = 'P0001';
      end if;
    end loop;
    if (select count(*) from jsonb_object_keys(v_params) k where k <> all (v_vars || v_header_vars)) > 0 then
      raise exception 'Values were given for placeholders the template does not have.' using errcode = 'P0001';
    end if;
    if array_length(v_header_vars, 1) > 0 then
      v_components := v_components || jsonb_build_array(jsonb_build_object('type', 'header', 'parameters',
        (select jsonb_agg(case when tpl.parameter_format = 'NAMED' then jsonb_build_object('type', 'text', 'parameter_name', n, 'text', v_params ->> n)
                               else jsonb_build_object('type', 'text', 'text', v_params ->> n) end order by case when n ~ '^[0-9]+$' then n::int end, n)
         from unnest(v_header_vars) n)));
    end if;
    if array_length(v_vars, 1) > 0 then
      v_components := v_components || jsonb_build_array(jsonb_build_object('type', 'body', 'parameters',
        (select jsonb_agg(case when tpl.parameter_format = 'NAMED' then jsonb_build_object('type', 'text', 'parameter_name', n, 'text', v_params ->> n)
                               else jsonb_build_object('type', 'text', 'text', v_params ->> n) end order by case when n ~ '^[0-9]+$' then n::int end, n)
         from unnest(v_vars) n)));
    end if;
    v_rendered := coalesce(v_body_text, tpl.name);
    for i in 1 .. coalesce(array_length(v_vars, 1), 0) loop
      v_rendered := regexp_replace(v_rendered, '\{\{\s*' || v_vars[i] || '\s*\}\}', replace(v_params ->> v_vars[i], '\', '\\'), 'g');
    end loop;
    v_rendered := '[Template ' || tpl.name || '] ' || v_rendered;
  end if;

  insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, delivery_status, author_user_id, occurred_at)
  values (v_company, v_conv, 'MESSAGE', 'OUTBOUND', 'CHANNEL', left(v_rendered, 20000), 'QUEUED', auth.uid(), now())
  returning id into v_msg;
  insert into public.support_whatsapp_messages (company_id, message_id, conversation_id, channel_account_id, direction, waba_id, phone_number_id, wa_id, user_id,
    msg_type, context_wa_message_id, media_filename, media_caption, media_mime, status, template_id, template_name, template_language, idempotency_key, requested_by)
  values (v_company, v_msg, v_conv, c.channel_account_id, 'OUTBOUND', c.waba_id, c.phone_number_id, th.wa_id, th.user_id,
    case v_kind when 'TEXT' then 'text' when 'MEDIA' then v_media_kind else 'template' end, v_context,
    case when v_kind = 'MEDIA' then left(p ->> 'file_name', 255) end, v_caption, case when v_kind = 'MEDIA' then left(p ->> 'content_type', 120) end,
    'PENDING', tpl.id, tpl.name, tpl.language, v_key, auth.uid())
  returning id into v_wam;
  if v_kind = 'MEDIA' then
    insert into public.support_attachments (company_id, conversation_id, message_id, file_name, storage_path, content_type, size_bytes, uploaded_by)
    values (v_company, v_conv, v_msg, left(regexp_replace(coalesce(p ->> 'file_name', 'file'), '[\r\n"\\/]', '_', 'g'), 255), v_path, left(p ->> 'content_type', 120), v_size, auth.uid())
    returning id into v_att;
    update public.support_whatsapp_messages set attachment_id = v_att, media_state = 'STORED' where id = v_wam;
  end if;
  perform private.support_touch_conversation(v_conv, v_rendered, now(), 0);
  perform private.support_mark_first_response(v_conv, now());
  update public.support_conversations set unread_count = 0, status = case when status = 'RESOLVED' then status else 'PENDING' end where id = v_conv;

  return jsonb_build_object('existing', false, 'id', v_wam, 'message_id', v_msg, 'conversation_id', v_conv, 'account_id', c.channel_account_id,
    'phone_number_id', c.phone_number_id, 'graph_api_version', c.graph_api_version, 'kind', v_kind, 'to', th.wa_id, 'user_id', th.user_id,
    'text', v_text, 'context_wa_message_id', v_context,
    'media', case when v_kind = 'MEDIA' then jsonb_build_object('kind', v_media_kind, 'path', v_path, 'file_name', p ->> 'file_name', 'content_type', p ->> 'content_type',
                  'caption', v_caption, 'size_bytes', v_size) end,
    'template', case when v_kind = 'TEMPLATE' then jsonb_build_object('name', tpl.name, 'language', tpl.language, 'components', v_components) end);
end;
$$;

-- Service role: Meta's answer to the send request. ACCEPTED keeps the message PENDING (status webhooks move it on).
create or replace function public.support_whatsapp_send_result(p_id uuid, p_outcome text, p_wa_message_id text, p_wa_id text, p_error_code integer,
  p_error_title text, p_error_detail text, p_http integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_whatsapp_messages;
  v_err text;
begin
  if p_outcome not in ('ACCEPTED', 'FAILED', 'UNCONFIRMED') then
    raise exception 'Unknown send outcome %.', p_outcome using errcode = 'P0001';
  end if;
  select * into m from public.support_whatsapp_messages where id = p_id and direction = 'OUTBOUND' for update;
  if not found then
    raise exception 'WhatsApp message not found.' using errcode = 'P0001';
  end if;
  if m.wa_message_id is not null or m.status <> 'PENDING' then
    return jsonb_build_object('status', m.status, 'changed', false);
  end if;
  if p_outcome = 'ACCEPTED' then
    if p_wa_message_id is null or length(p_wa_message_id) not between 4 and 200 then
      raise exception 'Meta returned no message id.' using errcode = 'P0001';
    end if;
    update public.support_whatsapp_messages set wa_message_id = p_wa_message_id, error_code = null, error_title = null, error_detail = null where id = m.id;
    update public.support_messages set external_message_id = p_wa_message_id where id = m.message_id;
    if p_wa_id ~ '^[0-9]{6,20}$' then
      update public.support_whatsapp_threads set wa_id = coalesce(wa_id, p_wa_id) where conversation_id = m.conversation_id
        and not exists (select 1 from public.support_whatsapp_threads o where o.company_id = m.company_id and o.channel_account_id = m.channel_account_id and o.wa_id = p_wa_id);
    end if;
    -- Statuses that arrived before this answer.
    perform private.support_whatsapp_apply_status(m.company_id, p_wa_message_id);
  elsif p_outcome = 'FAILED' then
    v_err := left(coalesce(p_error_title, 'Meta refused the message') || coalesce(' (' || p_error_code || ')', '') || coalesce(': ' || p_error_detail, ''), 500);
    update public.support_whatsapp_messages set status = 'FAILED', status_at = now(), error_code = p_error_code, error_title = left(p_error_title, 300),
      error_detail = left(p_error_detail, 1000) where id = m.id;
    update public.support_messages set delivery_status = 'FAILED', delivery_error = v_err where id = m.message_id;
    if p_error_code = 190 then
      -- Access token expired or invalid: the integration cannot send until the token is replaced.
      update public.support_whatsapp_config set last_test_ok = false, last_test_result = 'Meta refused the access token (190). Replace WHATSAPP_ACCESS_TOKEN and run Test connection.',
        last_error = 'Access token expired or invalid (190).', last_error_at = now() where company_id = m.company_id;
      perform private.support_whatsapp_refresh(m.company_id, 'token expired');
    end if;
  else
    update public.support_whatsapp_messages set error_title = 'Not confirmed', error_detail = left(coalesce(p_error_detail, 'Meta did not confirm the request (timeout or server error).'), 1000)
    where id = m.id;
  end if;
  perform private.support_gmail_event(m.company_id, m.channel_account_id, 'SEND', 'WhatsApp message ' || lower(p_outcome),
    jsonb_build_object('id', m.id, 'http', p_http, 'code', p_error_code), case when p_outcome = 'ACCEPTED' then 'PROCESSED' when p_outcome = 'FAILED' then 'ERROR' else 'PENDING' end,
    case when p_outcome <> 'ACCEPTED' then left(coalesce(p_error_title, '') || ' ' || coalesce(p_error_detail, ''), 500) end);
  return jsonb_build_object('status', (select status from public.support_whatsapp_messages where id = m.id), 'changed', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Reading (support.view)
-- -----------------------------------------------------------------------------
create or replace function public.support_whatsapp_thread(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  th public.support_whatsapp_threads;
  c public.support_whatsapp_config;
  v_sensitive boolean;
begin
  select * into th from public.support_whatsapp_threads where conversation_id = p_conversation and company_id = v_company;
  if not found then
    return null;
  end if;
  select * into c from public.support_whatsapp_config where company_id = v_company;
  v_sensitive := private.has_permission(v_company, 'support.manage_tickets');
  return jsonb_build_object(
    'contact', jsonb_build_object('wa_id', th.wa_id, 'user_id', th.user_id, 'profile_name', th.profile_name, 'last_inbound_at', th.last_inbound_at),
    'window_open', th.last_inbound_at is not null and th.last_inbound_at > now() - interval '24 hours',
    'window_closes_at', case when th.last_inbound_at is not null then th.last_inbound_at + interval '24 hours' end,
    'can_send', c.integration_enabled and c.setup_state = 'CONNECTED' and private.has_permission(v_company, 'support.reply'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'message_id', m.message_id, 'direction', m.direction, 'type', m.msg_type,
        'body', sm.body, 'at', coalesce(m.wa_timestamp, m.created_at), 'status', m.status, 'status_at', m.status_at, 'error_code', m.error_code,
        'error_title', m.error_title, 'error_detail', m.error_detail, 'media_state', m.media_state, 'media_error', m.media_error, 'media_filename', m.media_filename,
        'media_mime', m.media_mime, 'location', m.location, 'context_wa_message_id', m.context_wa_message_id, 'wa_message_id', m.wa_message_id,
        'template_name', m.template_name, 'author', (select coalesce(pr.full_name, pr.email) from public.profiles pr where pr.id = m.requested_by),
        'attachment', (select jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type, 'size_bytes', a.size_bytes,
                         'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end, 'restricted', a.is_sensitive and not v_sensitive)
                       from public.support_attachments a where a.id = m.attachment_id))
        order by coalesce(m.wa_timestamp, m.created_at), m.created_at)
      from public.support_whatsapp_messages m join public.support_messages sm on sm.id = m.message_id where m.conversation_id = p_conversation), '[]'::jsonb));
end;
$$;

create or replace function public.support_whatsapp_templates_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'language', t.language, 'category', t.category, 'status', t.status,
    'parameter_format', t.parameter_format, 'components', t.components) order by t.name, t.language)
    from public.support_whatsapp_templates t where t.company_id = v_company and t.status = 'APPROVED'), '[]'::jsonb);
end;
$$;

create or replace function public.support_whatsapp_status_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return coalesce((select jsonb_build_object('setup_state', c.setup_state, 'enabled', c.integration_enabled, 'display_phone_number', c.display_phone_number,
    'can_send', c.integration_enabled and c.setup_state = 'CONNECTED' and private.has_permission(v_company, 'support.reply'))
    from public.support_whatsapp_config c where c.company_id = v_company), jsonb_build_object('setup_state', 'NOT_CONFIGURED', 'enabled', false, 'can_send', false));
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Generic replies: WhatsApp goes through whatsapp-send-message / whatsapp-send-template
-- -----------------------------------------------------------------------------
create or replace function public.support_message_add(p_conversation uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  s public.support_conversations;
  v_mode text := upper(coalesce(p ->> 'mode', ''));
  v_body text := private.support_text(p, 'body', 20000);
  v_direction text := upper(coalesce(p ->> 'direction', 'OUTBOUND'));
  v_call text := upper(nullif(p ->> 'call_status', ''));
  v_at timestamptz := coalesce(nullif(p ->> 'occurred_at', '')::timestamptz, now());
  v_kind text;
  v_health text;
  v_id uuid;
begin
  select * into s from public.support_conversations where id = p_conversation and company_id = v_company for update;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  v_kind := case s.channel when 'PHONE' then 'CALL' when 'EMAIL' then 'EMAIL' else 'MESSAGE' end;
  if v_at > now() + interval '5 minutes' then
    raise exception 'The time cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_mode = 'REPLY' then
    if v_kind = 'CALL' then
      raise exception 'Calls cannot be sent as a reply; log the call instead.' using errcode = 'P0001';
    end if;
    if v_kind = 'EMAIL' then
      raise exception 'Email replies are sent from the connected support mailbox: use Reply or Reply all on the email.' using errcode = 'P0001';
    end if;
    if s.channel = 'WHATSAPP' then
      raise exception 'WhatsApp messages are sent through the WhatsApp Cloud API panel of the conversation (window and template rules apply).' using errcode = 'P0001';
    end if;
    v_health := private.support_channel_health(v_company, s.channel);
    if v_health <> 'CONNECTED' then
      raise exception 'Cannot reply through % : the channel is %. Log the reply instead if it was sent elsewhere.',
        initcap(lower(s.channel)), replace(lower(v_health), '_', ' ') using errcode = 'P0001';
    end if;
    if v_body is null then
      raise exception 'Enter the reply.' using errcode = 'P0001';
    end if;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, delivery_status, author_user_id, occurred_at)
    values (v_company, s.id, v_kind, 'OUTBOUND', 'CHANNEL', v_body, null, 'QUEUED', auth.uid(), now())
    returning id into v_id;
    v_direction := 'OUTBOUND';
  elsif v_mode = 'LOG' then
    if v_direction not in ('INBOUND', 'OUTBOUND') then
      raise exception 'Direction must be inbound or outbound.' using errcode = 'P0001';
    end if;
    if v_kind = 'CALL' and coalesce(v_call, '') not in ('ANSWERED', 'MISSED', 'VOICEMAIL', 'FAILED') then
      raise exception 'Choose the call result: answered, missed, voicemail or failed.' using errcode = 'P0001';
    end if;
    if v_kind <> 'CALL' and v_body is null then
      raise exception 'Enter the message.' using errcode = 'P0001';
    end if;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, call_status, call_duration_seconds, author_user_id, occurred_at)
    values (v_company, s.id, v_kind, v_direction, 'MANUAL', v_body, case when v_kind = 'EMAIL' then private.support_text(p, 'email_subject', 300) end,
            case when v_kind = 'CALL' then v_call end, case when v_kind = 'CALL' then nullif(p ->> 'call_duration_seconds', '')::integer end, auth.uid(), v_at)
    returning id into v_id;
  else
    raise exception 'Unknown message mode %.', p ->> 'mode' using errcode = 'P0001';
  end if;
  perform private.support_touch_conversation(s.id, coalesce(v_body, initcap(lower(coalesce(v_call, ''))) || ' call'), v_at, 0);
  if v_direction = 'OUTBOUND' then
    perform private.support_mark_first_response(s.id, v_at);
    update public.support_conversations set unread_count = 0, status = case when status = 'RESOLVED' then status else 'PENDING' end where id = s.id;
  else
    update public.support_conversations set status = 'OPEN' where id = s.id;
  end if;
  return jsonb_build_object('id', v_id, 'delivery_status', (select delivery_status from public.support_messages where id = v_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------
revoke all on function private.support_whatsapp_status_rank(text), private.support_whatsapp_apply_status(uuid, text), private.support_whatsapp_process(uuid),
  private.support_whatsapp_template_vars(text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_whatsapp_config_get', 'support_whatsapp_config_save', 'support_whatsapp_checklist_set',
             'support_whatsapp_set_enabled', 'support_whatsapp_admin_check', 'support_whatsapp_event_replay', 'support_whatsapp_media_request',
             'support_whatsapp_send_prepare', 'support_whatsapp_thread', 'support_whatsapp_templates_list', 'support_whatsapp_status_context', 'support_message_add') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_whatsapp_runtime', 'support_whatsapp_accounts', 'support_whatsapp_webhook_verified',
             'support_whatsapp_test_result', 'support_whatsapp_templates_sync', 'support_whatsapp_ingest', 'support_whatsapp_purge_payloads',
             'support_whatsapp_media_due', 'support_whatsapp_media_result', 'support_whatsapp_send_result') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. ERP reset allowlist (20261212090000 plus the WhatsApp tables, children first)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
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
