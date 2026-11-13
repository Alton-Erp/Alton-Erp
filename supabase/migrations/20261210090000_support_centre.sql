-- =============================================================================
-- Support Centre (omnichannel customer support inside the ERP)
--
-- Additive. Reuses the ERP's authentication, company tenancy (profiles.company_id),
-- RBAC (permissions / role_permissions, private.has_permission) and audit conventions.
--
--   * 16 tables (support_*), UUID keys, company_id on every row, composite tenant
--     foreign keys, RLS on every table (select policies only; no anonymous access).
--   * Every write goes through a SECURITY DEFINER function that checks a support.*
--     permission (same pattern as the rest of the ERP); the tables grant SELECT only.
--   * Channel integrations are honest: a channel account can only be created as
--     NOT_CONNECTED / SETUP_REQUIRED from the app. CONNECTED, ERROR and
--     REAUTHORIZATION_REQUIRED are written only by the server-side health check
--     (service role, private.support_record_integration_health). No connector is
--     built here, so nothing reports CONNECTED until one is.
--   * Replies through a channel are accepted only while that channel is CONNECTED
--     (queued for the connector). Activity that happened outside the ERP (a call
--     taken on a phone, an email answered elsewhere) can be logged and is marked
--     "logged manually".
--   * Customers are matched by normalised phone (last 10 digits for Indian numbers)
--     and lower-cased email. A conversation is linked automatically only when every
--     match points to one customer; customers are never merged automatically.
--
-- Rollback: supabase/rollback/20261210090000_support_centre_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('support', 'view', 'View the Support Centre: conversations, tickets, customers and channel status'),
  ('support', 'manage_tickets', 'Create, update, merge, reopen and export support tickets; view recordings and sensitive attachments'),
  ('support', 'assign', 'Assign and reassign support conversations and tickets to agents'),
  ('support', 'reply', 'Reply to customers, log calls and messages, add internal notes and maintain support customers'),
  ('support', 'manage_integrations', 'Set up WhatsApp, email and phone channel accounts and see their health'),
  ('support', 'view_reports', 'View Support Centre reports and agent performance'),
  ('support', 'manage_settings', 'Manage support agents, SLA policies, tags, automation rules and the knowledge base')
on conflict (code) do nothing;

-- Administrators: every support permission.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code like 'support.%'
where r.code in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;

-- Sales Manager: day-to-day support work and reports.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.code in ('support.view', 'support.manage_tickets', 'support.assign', 'support.reply', 'support.view_reports')
where r.code = 'SALES_MANAGER'
on conflict do nothing;

-- Read-only roles (Management Viewer, Reports Viewer) keep holding only *.read permissions (an ERP-wide rule
-- checked by the RLS suites), so they get no support permission here; grant support.view to a role deliberately.

-- -----------------------------------------------------------------------------
-- 2. Helpers
-- -----------------------------------------------------------------------------
-- Phone digits for matching: +91 / 0 prefixes of Indian numbers removed (last 10 digits).
create or replace function private.support_normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d is null or length(d) < 6 then null
    when length(d) = 12 and d like '91%' then right(d, 10)
    when length(d) = 11 and d like '0%' then right(d, 10)
    else d end
  from (select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '') as d) x;
$$;

create or replace function private.support_normalize_email(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when e ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then e end from (select lower(btrim(coalesce(p, ''))) as e) x;
$$;

create or replace function private.support_text(p jsonb, p_key text, p_max int)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is not null and length(v) > p_max then
    raise exception '% is too long (at most % characters).', initcap(replace(p_key, '_', ' ')), p_max using errcode = 'P0001';
  end if;
  return v;
end;
$$;

revoke all on function private.support_normalize_phone(text), private.support_normalize_email(text), private.support_text(jsonb, text, int)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_agents (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  user_id                 uuid not null,
  display_name            text not null check (length(btrim(display_name)) between 1 and 120),
  department              text check (department is null or length(department) <= 80),
  presence                text not null default 'OFFLINE' check (presence in ('AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE')),
  presence_updated_at     timestamptz,
  max_open_conversations  integer not null default 25 check (max_open_conversations between 1 and 500),
  is_active               boolean not null default true,
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint support_agents_id_company_unique unique (id, company_id),
  constraint support_agents_user_unique unique (company_id, user_id),
  constraint support_agents_user_fk foreign key (user_id, company_id) references public.profiles (id, company_id) on delete restrict
);

create table if not exists public.support_customers (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  customer_code      text not null check (customer_code ~ '^SC-[0-9]{6,}$'),
  display_name       text not null check (length(btrim(display_name)) between 1 and 200),
  company_name       text check (company_name is null or length(company_name) <= 200),
  phones             text[] not null default '{}' check (cardinality(phones) <= 10),
  emails             text[] not null default '{}' check (cardinality(emails) <= 10),
  normalized_phones  text[] not null default '{}',
  normalized_emails  text[] not null default '{}',
  address            text check (address is null or length(address) <= 1000),
  erp_customer_id    uuid,
  notes              text check (notes is null or length(notes) <= 2000),
  is_active          boolean not null default true,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint support_customers_id_company_unique unique (id, company_id),
  constraint support_customers_code_unique unique (company_id, customer_code),
  constraint support_customers_erp_fk foreign key (erp_customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint support_customers_contact check (cardinality(phones) + cardinality(emails) > 0 or erp_customer_id is not null)
);

create table if not exists public.support_channel_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  channel          text not null check (channel in ('PHONE', 'WHATSAPP', 'EMAIL')),
  display_name     text not null check (length(btrim(display_name)) between 1 and 120),
  -- Public identifier only (the WhatsApp number, support mailbox or phone line). Never a secret.
  identifier       text check (identifier is null or length(identifier) <= 200),
  provider         text check (provider is null or length(provider) <= 60),
  -- Name of the server-side secret holding the credentials (e.g. an Edge Function secret). Never the secret.
  credentials_ref  text check (credentials_ref is null or credentials_ref ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  status           text not null default 'NOT_CONNECTED'
                     check (status in ('NOT_CONNECTED', 'SETUP_REQUIRED', 'CONNECTED', 'ERROR', 'REAUTHORIZATION_REQUIRED')),
  status_detail    text check (status_detail is null or length(status_detail) <= 500),
  last_checked_at  timestamptz,
  connected_at     timestamptz,
  is_active        boolean not null default true,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint support_channel_accounts_id_company_unique unique (id, company_id),
  constraint support_channel_accounts_connected check (status <> 'CONNECTED' or last_checked_at is not null)
);

create table if not exists public.support_sla_policies (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  name                     text not null check (length(btrim(name)) between 1 and 120),
  -- null = the default policy for priorities without their own policy.
  priority                 text check (priority is null or priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  first_response_minutes   integer not null check (first_response_minutes between 1 and 43200),
  resolution_minutes       integer not null check (resolution_minutes between 1 and 129600),
  is_active                boolean not null default true,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint support_sla_policies_id_company_unique unique (id, company_id),
  constraint support_sla_policies_order check (first_response_minutes <= resolution_minutes)
);
create unique index if not exists support_sla_policies_active_priority on public.support_sla_policies (company_id, coalesce(priority, '*')) where is_active;

create table if not exists public.support_tickets (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  ticket_number            text not null check (ticket_number ~ '^ALT-SUP-[0-9]{6,}$'),
  subject                  text not null check (length(btrim(subject)) between 3 and 200),
  customer_id              uuid,
  customer_phone           text check (customer_phone is null or length(customer_phone) <= 30),
  customer_email           text check (customer_email is null or length(customer_email) <= 320),
  channel                  text not null check (channel in ('PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL')),
  category                 text check (category is null or length(category) <= 80),
  subcategory              text check (subcategory is null or length(subcategory) <= 80),
  description              text check (description is null or length(description) <= 10000),
  priority                 text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status                   text not null default 'NEW'
                             check (status in ('NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED')),
  department               text check (department is null or length(department) <= 80),
  assigned_agent_id        uuid,
  sla_policy_id            uuid,
  first_response_due_at    timestamptz,
  due_at                   timestamptz,
  first_response_at        timestamptz,
  resolved_at              timestamptz,
  closed_at                timestamptz,
  reopen_count             integer not null default 0,
  merged_into_ticket_id    uuid,
  related_type             text check (related_type is null or related_type in ('PRODUCT', 'SALES_ORDER', 'INVOICE')),
  related_id               uuid,
  related_reference        text check (related_reference is null or length(related_reference) <= 80),
  csat_rating              smallint check (csat_rating is null or csat_rating between 1 and 5),
  csat_comment             text check (csat_comment is null or length(csat_comment) <= 1000),
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint support_tickets_id_company_unique unique (id, company_id),
  constraint support_tickets_number_unique unique (company_id, ticket_number),
  constraint support_tickets_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_tickets_agent_fk foreign key (assigned_agent_id, company_id) references public.support_agents (id, company_id) on delete restrict,
  constraint support_tickets_sla_fk foreign key (sla_policy_id, company_id) references public.support_sla_policies (id, company_id) on delete restrict,
  constraint support_tickets_merged_fk foreign key (merged_into_ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_tickets_not_self_merged check (merged_into_ticket_id is null or merged_into_ticket_id <> id),
  constraint support_tickets_resolved check ((status in ('RESOLVED', 'CLOSED')) = (resolved_at is not null)),
  constraint support_tickets_closed check ((status = 'CLOSED') = (closed_at is not null)),
  constraint support_tickets_related check (related_type is not null or (related_id is null and related_reference is null))
);

create table if not exists public.support_conversations (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  channel               text not null check (channel in ('PHONE', 'WHATSAPP', 'EMAIL')),
  channel_account_id    uuid,
  customer_id           uuid,
  ticket_id             uuid,
  subject               text check (subject is null or length(subject) <= 200),
  contact_name          text check (contact_name is null or length(contact_name) <= 200),
  contact_phone         text check (contact_phone is null or length(contact_phone) <= 30),
  contact_email         text check (contact_email is null or length(contact_email) <= 320),
  normalized_phone      text,
  normalized_email      text,
  status                text not null default 'OPEN' check (status in ('OPEN', 'PENDING', 'RESOLVED')),
  priority              text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  assigned_agent_id     uuid,
  unread_count          integer not null default 0 check (unread_count >= 0),
  last_message_preview  text check (last_message_preview is null or length(last_message_preview) <= 300),
  last_activity_at      timestamptz not null default now(),
  external_thread_id    text check (external_thread_id is null or length(external_thread_id) <= 200),
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint support_conversations_id_company_unique unique (id, company_id),
  constraint support_conversations_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_conversations_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_conversations_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_conversations_agent_fk foreign key (assigned_agent_id, company_id) references public.support_agents (id, company_id) on delete restrict,
  constraint support_conversations_contact check (customer_id is not null or contact_phone is not null or contact_email is not null or contact_name is not null)
);
create unique index if not exists support_conversations_thread_unique on public.support_conversations (company_id, channel_account_id, external_thread_id)
  where external_thread_id is not null;

create table if not exists public.support_messages (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  conversation_id        uuid not null,
  kind                   text not null check (kind in ('MESSAGE', 'EMAIL', 'CALL')),
  direction              text not null check (direction in ('INBOUND', 'OUTBOUND')),
  -- CHANNEL: received from / sent through a connected channel. MANUAL: logged by an agent.
  source                 text not null check (source in ('CHANNEL', 'MANUAL')),
  body                   text check (body is null or length(body) <= 20000),
  email_subject          text check (email_subject is null or length(email_subject) <= 300),
  call_status            text check (call_status is null or call_status in ('ANSWERED', 'MISSED', 'VOICEMAIL', 'FAILED')),
  call_duration_seconds  integer check (call_duration_seconds is null or call_duration_seconds between 0 and 86400),
  delivery_status        text check (delivery_status is null or delivery_status in ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  delivery_error         text check (delivery_error is null or length(delivery_error) <= 500),
  external_message_id    text check (external_message_id is null or length(external_message_id) <= 200),
  author_user_id         uuid,
  occurred_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint support_messages_id_company_unique unique (id, company_id),
  constraint support_messages_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_messages_call check ((kind = 'CALL') = (call_status is not null)),
  constraint support_messages_content check (kind = 'CALL' or body is not null),
  constraint support_messages_delivery check (delivery_status is null or (direction = 'OUTBOUND' and source = 'CHANNEL')),
  constraint support_messages_outbound_channel check (not (direction = 'OUTBOUND' and source = 'CHANNEL') or delivery_status is not null)
);
create unique index if not exists support_messages_external_unique on public.support_messages (company_id, external_message_id) where external_message_id is not null;

create table if not exists public.support_ticket_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  ticket_id      uuid not null,
  event_type     text not null check (event_type in ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'UPDATED', 'MERGED', 'MERGED_INTO',
                   'REOPENED', 'NOTE_ADDED', 'ATTACHMENT_ADDED', 'CONVERSATION_LINKED', 'FIRST_RESPONSE', 'AUTOMATION', 'CSAT_RECORDED')),
  from_value     text,
  to_value       text,
  details        jsonb not null default '{}'::jsonb,
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  constraint support_ticket_events_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict
);

create table if not exists public.support_internal_notes (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  conversation_id  uuid,
  ticket_id        uuid,
  customer_id      uuid,
  body             text not null check (length(btrim(body)) between 1 and 5000),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint support_notes_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_notes_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_notes_customer_fk foreign key (customer_id, company_id) references public.support_customers (id, company_id) on delete restrict,
  constraint support_notes_one_target check (num_nonnulls(conversation_id, ticket_id, customer_id) = 1)
);

create table if not exists public.support_attachments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  conversation_id  uuid,
  message_id       uuid,
  ticket_id        uuid,
  file_name        text not null check (length(btrim(file_name)) between 1 and 255),
  storage_path     text not null check (length(storage_path) <= 500),
  content_type     text check (content_type is null or length(content_type) <= 120),
  size_bytes       bigint check (size_bytes is null or size_bytes between 0 and 26214400),
  is_recording     boolean not null default false,
  -- Recordings are always sensitive; sensitive files need support.manage_tickets to open.
  is_sensitive     boolean not null default false,
  uploaded_by      uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint support_attachments_path_unique unique (storage_path),
  constraint support_attachments_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_attachments_message_fk foreign key (message_id, company_id) references public.support_messages (id, company_id) on delete restrict,
  constraint support_attachments_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_attachments_target check (num_nonnulls(conversation_id, message_id, ticket_id) >= 1),
  constraint support_attachments_recording_sensitive check (not is_recording or is_sensitive),
  constraint support_attachments_company_path check (storage_path like company_id::text || '/%')
);

create table if not exists public.support_tags (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 40),
  color       text not null default 'neutral' check (color in ('neutral', 'info', 'success', 'warning', 'danger', 'outsourced')),
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint support_tags_id_company_unique unique (id, company_id)
);
create unique index if not exists support_tags_name_unique on public.support_tags (company_id, lower(name));

create table if not exists public.support_conversation_tags (
  company_id       uuid not null references public.companies (id) on delete restrict,
  conversation_id  uuid not null,
  tag_id           uuid not null,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  primary key (conversation_id, tag_id),
  constraint support_conversation_tags_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_conversation_tags_tag_fk foreign key (tag_id, company_id) references public.support_tags (id, company_id) on delete restrict
);

create table if not exists public.support_automation_rules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  name         text not null check (length(btrim(name)) between 1 and 120),
  trigger      text not null check (trigger in ('TICKET_CREATED', 'CONVERSATION_CREATED')),
  -- {channel?, priority?, category?, subject_contains?}: every given condition must match.
  conditions   jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  -- {set_priority?, set_department?, assign_agent_id?, add_tag_id?}
  actions      jsonb not null check (jsonb_typeof(actions) = 'object' and actions <> '{}'::jsonb),
  run_order    integer not null default 100 check (run_order between 1 and 10000),
  is_active    boolean not null default true,
  run_count    integer not null default 0,
  last_run_at  timestamptz,
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint support_automation_rules_id_company_unique unique (id, company_id)
);

create table if not exists public.support_integration_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  event_type          text not null check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR')),
  status              text check (status is null or status in ('NOT_CONNECTED', 'SETUP_REQUIRED', 'CONNECTED', 'ERROR', 'REAUTHORIZATION_REQUIRED')),
  message             text check (message is null or length(message) <= 1000),
  -- Redacted metadata only; never credentials or message bodies.
  details             jsonb not null default '{}'::jsonb,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  constraint support_integration_events_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);

create table if not exists public.support_kb_articles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  title       text not null check (length(btrim(title)) between 3 and 200),
  body        text not null check (length(btrim(body)) between 1 and 50000),
  category    text check (category is null or length(category) <= 80),
  tags        text[] not null default '{}' check (cardinality(tags) <= 20),
  status      text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint support_kb_articles_id_company_unique unique (id, company_id)
);

create table if not exists public.support_audit_logs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  actor_user_id  uuid,
  action         text not null check (length(action) <= 120),
  entity_type    text not null check (length(entity_type) <= 60),
  entity_id      text,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

-- Indexes (tenant, status, assignee, channel, customer, ticket number, activity)
create index if not exists support_agents_company_idx on public.support_agents (company_id, is_active);
create index if not exists support_customers_company_idx on public.support_customers (company_id, lower(display_name));
create index if not exists support_customers_phones_idx on public.support_customers using gin (normalized_phones);
create index if not exists support_customers_emails_idx on public.support_customers using gin (normalized_emails);
create index if not exists support_customers_erp_idx on public.support_customers (erp_customer_id) where erp_customer_id is not null;
create index if not exists support_conversations_company_idx on public.support_conversations (company_id, last_activity_at desc);
create index if not exists support_conversations_status_idx on public.support_conversations (company_id, status);
create index if not exists support_conversations_agent_idx on public.support_conversations (company_id, assigned_agent_id);
create index if not exists support_conversations_channel_idx on public.support_conversations (company_id, channel);
create index if not exists support_conversations_customer_idx on public.support_conversations (customer_id);
create index if not exists support_conversations_ticket_idx on public.support_conversations (ticket_id);
create index if not exists support_conversations_phone_idx on public.support_conversations (company_id, normalized_phone);
create index if not exists support_messages_conversation_idx on public.support_messages (conversation_id, occurred_at);
create index if not exists support_messages_company_idx on public.support_messages (company_id, kind, occurred_at);
create index if not exists support_tickets_company_idx on public.support_tickets (company_id, created_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets (company_id, status);
create index if not exists support_tickets_agent_idx on public.support_tickets (company_id, assigned_agent_id);
create index if not exists support_tickets_channel_idx on public.support_tickets (company_id, channel);
create index if not exists support_tickets_customer_idx on public.support_tickets (customer_id);
create index if not exists support_tickets_number_idx on public.support_tickets (company_id, ticket_number);
create index if not exists support_ticket_events_ticket_idx on public.support_ticket_events (ticket_id, created_at);
create index if not exists support_ticket_events_company_idx on public.support_ticket_events (company_id, created_at);
create index if not exists support_notes_company_idx on public.support_internal_notes (company_id, created_at);
create index if not exists support_notes_targets_idx on public.support_internal_notes (conversation_id, ticket_id, customer_id);
create index if not exists support_attachments_company_idx on public.support_attachments (company_id);
create index if not exists support_attachments_targets_idx on public.support_attachments (conversation_id, ticket_id, message_id);
create index if not exists support_conversation_tags_company_idx on public.support_conversation_tags (company_id, tag_id);
create index if not exists support_automation_rules_company_idx on public.support_automation_rules (company_id, trigger, is_active);
create index if not exists support_channel_accounts_company_idx on public.support_channel_accounts (company_id, channel);
create index if not exists support_integration_events_company_idx on public.support_integration_events (company_id, created_at desc);
create index if not exists support_kb_articles_company_idx on public.support_kb_articles (company_id, status);
create index if not exists support_audit_logs_company_idx on public.support_audit_logs (company_id, created_at desc);
create index if not exists support_audit_logs_actor_idx on public.support_audit_logs (company_id, actor_user_id, created_at desc);
create index if not exists support_sla_policies_company_idx on public.support_sla_policies (company_id);

-- -----------------------------------------------------------------------------
-- 4. Row-level security: SELECT only, by permission. No anonymous access.
--    Writes go through the SECURITY DEFINER functions below.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['support_agents', 'support_customers', 'support_channel_accounts', 'support_sla_policies', 'support_tickets',
    'support_conversations', 'support_messages', 'support_ticket_events', 'support_internal_notes', 'support_attachments', 'support_tags',
    'support_conversation_tags', 'support_automation_rules', 'support_integration_events', 'support_kb_articles', 'support_audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

drop policy if exists support_agents_select on public.support_agents;
create policy support_agents_select on public.support_agents for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_customers_select on public.support_customers;
create policy support_customers_select on public.support_customers for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_channel_accounts_select on public.support_channel_accounts;
create policy support_channel_accounts_select on public.support_channel_accounts for select to authenticated
  using (private.has_permission(company_id, 'support.manage_integrations'));
drop policy if exists support_sla_policies_select on public.support_sla_policies;
create policy support_sla_policies_select on public.support_sla_policies for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_tickets_select on public.support_tickets;
create policy support_tickets_select on public.support_tickets for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_conversations_select on public.support_conversations;
create policy support_conversations_select on public.support_conversations for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_messages_select on public.support_messages;
create policy support_messages_select on public.support_messages for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_ticket_events_select on public.support_ticket_events;
create policy support_ticket_events_select on public.support_ticket_events for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_internal_notes_select on public.support_internal_notes;
create policy support_internal_notes_select on public.support_internal_notes for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_attachments_select on public.support_attachments;
create policy support_attachments_select on public.support_attachments for select to authenticated
  using (private.has_permission(company_id, 'support.view') and (not is_sensitive or private.has_permission(company_id, 'support.manage_tickets')));
drop policy if exists support_tags_select on public.support_tags;
create policy support_tags_select on public.support_tags for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_conversation_tags_select on public.support_conversation_tags;
create policy support_conversation_tags_select on public.support_conversation_tags for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_automation_rules_select on public.support_automation_rules;
create policy support_automation_rules_select on public.support_automation_rules for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_integration_events_select on public.support_integration_events;
create policy support_integration_events_select on public.support_integration_events for select to authenticated
  using (private.has_permission(company_id, 'support.manage_integrations'));
drop policy if exists support_kb_articles_select on public.support_kb_articles;
create policy support_kb_articles_select on public.support_kb_articles for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_audit_logs_select on public.support_audit_logs;
create policy support_audit_logs_select on public.support_audit_logs for select to authenticated
  using (private.has_permission(company_id, 'support.manage_settings') or private.has_permission(company_id, 'support.view_reports')
         or (actor_user_id = auth.uid() and private.has_permission(company_id, 'support.view')));

-- -----------------------------------------------------------------------------
-- 5. Triggers: updated_at, audit, append-only audit log, contact normalisation
-- -----------------------------------------------------------------------------
create or replace function private.support_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_values jsonb := '{}'::jsonb;
  -- Values worth keeping in the log (never phone numbers, emails or message bodies).
  v_keep text[] := array['status', 'priority', 'assigned_agent_id', 'presence', 'is_active', 'ticket_id', 'customer_id', 'merged_into_ticket_id',
                         'trigger', 'channel', 'department', 'category', 'name', 'display_name', 'ticket_number', 'customer_code', 'title', 'erp_customer_id'];
  k text;
begin
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) n
    where n.key not in ('updated_at', 'updated_by', 'unread_count', 'last_activity_at', 'last_message_preview', 'normalized_phones', 'normalized_emails',
                        'presence_updated_at', 'run_count', 'last_run_at')
      and n.value is distinct from (v_old -> n.key);
    if v_changed is null then
      return null;
    end if;
    foreach k in array v_changed loop
      if k = any (v_keep) then
        v_values := v_values || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
  elsif tg_op = 'INSERT' then
    foreach k in array v_keep loop
      if v_new ? k and v_new -> k <> 'null'::jsonb then
        v_values := v_values || jsonb_build_object(k, v_new -> k);
      end if;
    end loop;
  end if;
  insert into public.support_audit_logs (company_id, actor_user_id, action, entity_type, entity_id, details)
  values ((v_row ->> 'company_id')::uuid, auth.uid(),
          replace(tg_table_name, 'support_', '') || '.' || lower(tg_op),
          replace(tg_table_name, 'support_', ''),
          v_row ->> 'id',
          jsonb_build_object('changed', coalesce(to_jsonb(v_changed), '[]'::jsonb), 'values', v_values));
  return null;
end;
$$;

create or replace function private.support_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Support audit log entries cannot be changed.' using errcode = 'P0001';
end;
$$;

create or replace function private.support_customer_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phones := coalesce(array(select distinct btrim(p) from unnest(new.phones) p where btrim(p) <> ''), '{}');
  new.emails := coalesce(array(select distinct lower(btrim(e)) from unnest(new.emails) e where btrim(e) <> ''), '{}');
  new.normalized_phones := coalesce(array(select distinct x from (select private.support_normalize_phone(p) x from unnest(new.phones) p) z where x is not null), '{}');
  new.normalized_emails := coalesce(array(select distinct x from (select private.support_normalize_email(e) x from unnest(new.emails) e) z where x is not null), '{}');
  return new;
end;
$$;

create or replace function private.support_conversation_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.normalized_phone := private.support_normalize_phone(new.contact_phone);
  new.normalized_email := private.support_normalize_email(new.contact_email);
  return new;
end;
$$;

revoke all on function private.support_audit_row(), private.support_audit_immutable(), private.support_customer_normalize(), private.support_conversation_normalize()
  from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['support_agents', 'support_customers', 'support_channel_accounts', 'support_sla_policies', 'support_tickets',
    'support_conversations', 'support_messages', 'support_internal_notes', 'support_attachments', 'support_tags', 'support_automation_rules', 'support_kb_articles'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
  foreach t in array array['support_agents', 'support_customers', 'support_channel_accounts', 'support_sla_policies', 'support_tickets',
    'support_conversations', 'support_internal_notes', 'support_attachments', 'support_tags', 'support_automation_rules', 'support_kb_articles'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;

drop trigger if exists support_audit_logs_immutable on public.support_audit_logs;
create trigger support_audit_logs_immutable before update on public.support_audit_logs
  for each row execute function private.support_audit_immutable();
drop trigger if exists support_customers_normalize on public.support_customers;
create trigger support_customers_normalize before insert or update of phones, emails on public.support_customers
  for each row execute function private.support_customer_normalize();
drop trigger if exists support_conversations_normalize on public.support_conversations;
create trigger support_conversations_normalize before insert or update of contact_phone, contact_email on public.support_conversations
  for each row execute function private.support_conversation_normalize();

-- -----------------------------------------------------------------------------
-- 6. Internal helpers
-- -----------------------------------------------------------------------------
create or replace function private.support_next_number(p_company uuid, p_prefix text, p_display text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v bigint;
begin
  insert into public.inventory_number_sequences (company_id, prefix, last_value) values (p_company, p_prefix, 1)
  on conflict (company_id, prefix) do update set last_value = public.inventory_number_sequences.last_value + 1
  returning last_value into v;
  return p_display || '-' || lpad(v::text, 6, '0');
end;
$$;

-- SLA state of a ticket: NO_SLA, ON_TRACK, AT_RISK (less than 20% of the window left), OVERDUE, MET, BREACHED.
create or replace function private.support_sla_status(t public.support_tickets, p_now timestamptz default now())
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when t.due_at is null then 'NO_SLA'
    when t.status in ('RESOLVED', 'CLOSED') then case when t.resolved_at <= t.due_at then 'MET' else 'BREACHED' end
    when p_now > t.due_at or (t.first_response_at is null and t.first_response_due_at is not null and p_now > t.first_response_due_at) then 'OVERDUE'
    when t.due_at - p_now < (t.due_at - t.created_at) * 0.2 then 'AT_RISK'
    else 'ON_TRACK' end;
$$;

-- Applies the SLA policy of the ticket's priority (or the default policy).
create or replace function private.support_apply_sla(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.support_tickets;
  v_p public.support_sla_policies;
begin
  select * into v_t from public.support_tickets where id = p_ticket;
  select * into v_p from public.support_sla_policies
  where company_id = v_t.company_id and is_active and (priority = v_t.priority or priority is null)
  order by (priority is null), created_at limit 1;
  update public.support_tickets set
    sla_policy_id = v_p.id,
    first_response_due_at = case when v_p.id is null then null else v_t.created_at + make_interval(mins => v_p.first_response_minutes) end,
    due_at = case when v_p.id is null then null else v_t.created_at + make_interval(mins => v_p.resolution_minutes) end
  where id = p_ticket;
end;
$$;

create or replace function private.support_ticket_event(p_ticket uuid, p_type text, p_from text, p_to text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.support_ticket_events (company_id, ticket_id, event_type, from_value, to_value, details, actor_user_id)
  select company_id, id, p_type, p_from, p_to, coalesce(p_details, '{}'::jsonb), auth.uid() from public.support_tickets where id = p_ticket;
$$;

create or replace function private.support_audit(p_company uuid, p_action text, p_type text, p_id text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.support_audit_logs (company_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_company, auth.uid(), p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Customers whose phone or email matches. ambiguous = more than one customer.
create or replace function private.support_match_customers(p_company uuid, p_phone text, p_email text)
returns table (customer_id uuid, matched_on text[])
language sql
stable
security definer
set search_path = ''
as $$
  with keys as (select private.support_normalize_phone(p_phone) as ph, private.support_normalize_email(p_email) as em)
  select c.id, array_remove(array[case when k.ph is not null and k.ph = any (c.normalized_phones) then 'phone' end,
                                  case when k.em is not null and k.em = any (c.normalized_emails) then 'email' end], null)
  from public.support_customers c cross join keys k
  where c.company_id = p_company and c.is_active
    and ((k.ph is not null and k.ph = any (c.normalized_phones)) or (k.em is not null and k.em = any (c.normalized_emails)))
  order by c.created_at;
$$;

create or replace function private.support_agent_of(p_company uuid, p_agent uuid)
returns public.support_agents
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.support_agents;
begin
  if p_agent is null then
    return null;
  end if;
  select * into v from public.support_agents where id = p_agent and company_id = p_company;
  if not found then
    raise exception 'Agent not found in your company.' using errcode = 'P0001';
  end if;
  if not v.is_active then
    raise exception 'Agent % is inactive.', v.display_name using errcode = 'P0001';
  end if;
  return v;
end;
$$;

-- Automation: rules of a trigger whose conditions all match, in run order.
create or replace function private.support_run_automation(p_company uuid, p_trigger text, p_ticket uuid, p_conversation uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.support_automation_rules;
  v_channel text; v_priority text; v_category text; v_subject text;
  v_c jsonb; v_a jsonb;
  v_n integer := 0;
begin
  if p_ticket is not null then
    select channel, priority, category, subject into v_channel, v_priority, v_category, v_subject from public.support_tickets where id = p_ticket;
  else
    select channel, priority, null, subject into v_channel, v_priority, v_category, v_subject from public.support_conversations where id = p_conversation;
  end if;
  for r in select * from public.support_automation_rules where company_id = p_company and trigger = p_trigger and is_active order by run_order, created_at loop
    v_c := r.conditions; v_a := r.actions;
    continue when v_c ? 'channel' and v_c ->> 'channel' is distinct from v_channel;
    continue when v_c ? 'priority' and v_c ->> 'priority' is distinct from v_priority;
    continue when v_c ? 'category' and lower(coalesce(v_category, '')) <> lower(v_c ->> 'category');
    continue when v_c ? 'subject_contains' and position(lower(v_c ->> 'subject_contains') in lower(coalesce(v_subject, ''))) = 0;
    if p_ticket is not null then
      update public.support_tickets set
        priority = coalesce(v_a ->> 'set_priority', priority),
        department = coalesce(v_a ->> 'set_department', department),
        assigned_agent_id = coalesce((select a.id from public.support_agents a where a.id = (v_a ->> 'assign_agent_id')::uuid and a.company_id = p_company and a.is_active),
                                     assigned_agent_id)
      where id = p_ticket;
      if v_a ? 'set_priority' then perform private.support_apply_sla(p_ticket); end if;
      perform private.support_ticket_event(p_ticket, 'AUTOMATION', null, r.name, jsonb_build_object('rule_id', r.id, 'actions', v_a));
    else
      update public.support_conversations set
        priority = coalesce(v_a ->> 'set_priority', priority),
        assigned_agent_id = coalesce((select a.id from public.support_agents a where a.id = (v_a ->> 'assign_agent_id')::uuid and a.company_id = p_company and a.is_active),
                                     assigned_agent_id)
      where id = p_conversation;
      if v_a ? 'add_tag_id' then
        insert into public.support_conversation_tags (company_id, conversation_id, tag_id, created_by)
        select p_company, p_conversation, t.id, auth.uid() from public.support_tags t where t.id = (v_a ->> 'add_tag_id')::uuid and t.company_id = p_company
        on conflict do nothing;
      end if;
    end if;
    update public.support_automation_rules set run_count = run_count + 1, last_run_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Last message preview / activity time of a conversation.
create or replace function private.support_touch_conversation(p_conversation uuid, p_preview text, p_at timestamptz, p_unread integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.support_conversations set
    last_message_preview = left(coalesce(p_preview, last_message_preview), 300),
    last_activity_at = greatest(last_activity_at, coalesce(p_at, now())),
    unread_count = unread_count + coalesce(p_unread, 0)
  where id = p_conversation;
$$;

-- First response: the first outbound activity on a conversation of the ticket.
create or replace function private.support_mark_first_response(p_conversation uuid, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket uuid;
begin
  select ticket_id into v_ticket from public.support_conversations where id = p_conversation;
  if v_ticket is not null and exists (select 1 from public.support_tickets where id = v_ticket and first_response_at is null) then
    update public.support_tickets set first_response_at = p_at,
      status = case when status = 'NEW' then 'OPEN' else status end where id = v_ticket;
    perform private.support_ticket_event(v_ticket, 'FIRST_RESPONSE', null, null, jsonb_build_object('conversation_id', p_conversation));
  end if;
end;
$$;

-- Channel health as the app may show it: the best status of the channel's active accounts, or NOT_CONNECTED.
create or replace function private.support_channel_health(p_company uuid, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select status from public.support_channel_accounts where company_id = p_company and channel = p_channel and is_active
                   order by case status when 'CONNECTED' then 1 when 'REAUTHORIZATION_REQUIRED' then 2 when 'ERROR' then 3 when 'SETUP_REQUIRED' then 4 else 5 end
                   limit 1), 'NOT_CONNECTED');
$$;

revoke all on function private.support_next_number(uuid, text, text), private.support_sla_status(public.support_tickets, timestamptz),
  private.support_apply_sla(uuid), private.support_ticket_event(uuid, text, text, text, jsonb), private.support_audit(uuid, text, text, text, jsonb),
  private.support_match_customers(uuid, text, text), private.support_agent_of(uuid, uuid), private.support_run_automation(uuid, text, uuid, uuid),
  private.support_touch_conversation(uuid, text, timestamptz, integer), private.support_mark_first_response(uuid, timestamptz),
  private.support_channel_health(uuid, text)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Channel status and integration accounts
-- -----------------------------------------------------------------------------
create or replace function public.support_channel_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return (select jsonb_agg(jsonb_build_object('channel', ch, 'status', private.support_channel_health(v_company, ch),
            'accounts', (select count(*) from public.support_channel_accounts a where a.company_id = v_company and a.channel = ch and a.is_active)) order by o)
          from unnest(array['PHONE', 'WHATSAPP', 'EMAIL']) with ordinality u(ch, o));
end;
$$;

-- Creates or updates a channel account. The app can never mark it CONNECTED: a new or changed account is
-- SETUP_REQUIRED when it has an identifier and a credentials reference, otherwise NOT_CONNECTED, until the
-- server-side health check reports otherwise.
create or replace function public.support_channel_account_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  v_channel text := upper(coalesce(p ->> 'channel', ''));
  v_name text := private.support_text(p, 'display_name', 120);
  v_ident text := private.support_text(p, 'identifier', 200);
  v_provider text := private.support_text(p, 'provider', 60);
  v_ref text := upper(private.support_text(p, 'credentials_ref', 80));
  v_active boolean := coalesce((p ->> 'is_active')::boolean, true);
  v_status text;
  v_old public.support_channel_accounts;
  v_id uuid;
begin
  if p ? 'status' then
    raise exception 'The connection status is set by the server-side health check, not from the app.' using errcode = 'P0001';
  end if;
  if v_name is null then
    raise exception 'Enter a name for the channel account.' using errcode = 'P0001';
  end if;
  if v_ref is not null and v_ref !~ '^[A-Z][A-Z0-9_]{2,79}$' then
    raise exception 'The credentials reference is the NAME of a server-side secret (letters, digits and _), never the secret itself.' using errcode = 'P0001';
  end if;
  v_status := case when v_ident is not null and v_ref is not null then 'SETUP_REQUIRED' else 'NOT_CONNECTED' end;
  if p_id is null then
    if v_channel not in ('PHONE', 'WHATSAPP', 'EMAIL') then
      raise exception 'Choose the channel: phone, WhatsApp or email.' using errcode = 'P0001';
    end if;
    insert into public.support_channel_accounts (company_id, channel, display_name, identifier, provider, credentials_ref, status, is_active, created_by, updated_by)
    values (v_company, v_channel, v_name, v_ident, v_provider, v_ref, v_status, v_active, auth.uid(), auth.uid())
    returning id into v_id;
    insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, created_by)
    values (v_company, v_id, 'ACCOUNT_CREATED', v_status, 'Account created from the app; awaiting the server-side connection check.', auth.uid());
  else
    select * into v_old from public.support_channel_accounts where id = p_id and company_id = v_company for update;
    if not found then
      raise exception 'Channel account not found in your company.' using errcode = 'P0001';
    end if;
    -- Changing what the connection depends on resets it until it is checked again.
    if v_old.identifier is distinct from v_ident or v_old.credentials_ref is distinct from v_ref or v_old.provider is distinct from v_provider then
      update public.support_channel_accounts set display_name = v_name, identifier = v_ident, provider = v_provider, credentials_ref = v_ref,
        status = v_status, status_detail = null, connected_at = null, is_active = v_active, updated_by = auth.uid() where id = p_id;
    else
      update public.support_channel_accounts set display_name = v_name, is_active = v_active, updated_by = auth.uid() where id = p_id;
    end if;
    v_id := p_id;
    insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, created_by)
    select v_company, v_id, 'ACCOUNT_UPDATED', status, 'Account updated from the app.', auth.uid() from public.support_channel_accounts where id = v_id;
  end if;
  return (select to_jsonb(a) - 'company_id' from public.support_channel_accounts a where id = v_id);
end;
$$;

-- Server-side health check result (service role only: the connector / Edge Function that holds the secret).
create or replace function public.support_record_integration_health(p_account uuid, p_status text, p_detail text default null, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.support_channel_accounts;
begin
  if p_status not in ('NOT_CONNECTED', 'SETUP_REQUIRED', 'CONNECTED', 'ERROR', 'REAUTHORIZATION_REQUIRED') then
    raise exception 'Unknown integration status %.', p_status using errcode = 'P0001';
  end if;
  select * into v from public.support_channel_accounts where id = p_account for update;
  if not found then
    raise exception 'Channel account not found.' using errcode = 'P0001';
  end if;
  update public.support_channel_accounts set status = p_status, status_detail = left(p_detail, 500), last_checked_at = now(),
    connected_at = case when p_status = 'CONNECTED' then coalesce(connected_at, now()) else null end
  where id = p_account;
  insert into public.support_integration_events (company_id, channel_account_id, event_type, status, message, details)
  values (v.company_id, p_account, 'HEALTH_CHECK', p_status, left(p_detail, 1000), coalesce(p_details, '{}'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Customers
-- -----------------------------------------------------------------------------
create or replace function public.support_customer_matches(p_phone text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name,
           'company_name', c.company_name, 'phones', c.phones, 'emails', c.emails, 'matched_on', m.matched_on) order by c.created_at)
         from private.support_match_customers(v_company, p_phone, p_email) m join public.support_customers c on c.id = m.customer_id), '[]'::jsonb);
end;
$$;

-- Creates (p_id null) or updates a support customer. A phone or email that already belongs to another customer is
-- refused unless p_allow_duplicate (the agent confirmed it is a different person); nothing is ever merged.
create or replace function public.support_customer_save(p_id uuid, p jsonb, p_allow_duplicate boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_name text := private.support_text(p, 'display_name', 200);
  v_phones text[] := coalesce(array(select btrim(x) from jsonb_array_elements_text(coalesce(p -> 'phones', '[]'::jsonb)) x where btrim(x) <> ''), '{}');
  v_emails text[] := coalesce(array(select lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> 'emails', '[]'::jsonb)) x where btrim(x) <> ''), '{}');
  v_erp uuid := nullif(p ->> 'erp_customer_id', '')::uuid;
  v_dupes jsonb;
  v_id uuid;
  x text;
begin
  if v_name is null then
    raise exception 'Enter the customer''s name.' using errcode = 'P0001';
  end if;
  foreach x in array v_phones loop
    if private.support_normalize_phone(x) is null or length(x) > 30 then
      raise exception 'Phone number "%" is not valid.', x using errcode = 'P0001';
    end if;
  end loop;
  foreach x in array v_emails loop
    if private.support_normalize_email(x) is null then
      raise exception 'Email address "%" is not valid.', x using errcode = 'P0001';
    end if;
  end loop;
  if cardinality(v_phones) + cardinality(v_emails) = 0 and v_erp is null then
    raise exception 'Enter at least one phone number or email address.' using errcode = 'P0001';
  end if;
  if v_erp is not null and not exists (select 1 from public.customers where id = v_erp and company_id = v_company) then
    raise exception 'ERP customer not found in your company.' using errcode = 'P0001';
  end if;
  select jsonb_agg(distinct jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name))
  into v_dupes
  from public.support_customers c
  where c.company_id = v_company and c.id is distinct from p_id
    and (c.normalized_phones && array(select private.support_normalize_phone(y) from unnest(v_phones) y)
         or c.normalized_emails && array(select private.support_normalize_email(y) from unnest(v_emails) y));
  if v_dupes is not null and not coalesce(p_allow_duplicate, false) then
    return jsonb_build_object('ok', false, 'duplicates', v_dupes);
  end if;
  if p_id is null then
    insert into public.support_customers (company_id, customer_code, display_name, company_name, phones, emails, address, erp_customer_id, notes, created_by, updated_by)
    values (v_company, private.support_next_number(v_company, 'SCUS', 'SC'), v_name, private.support_text(p, 'company_name', 200), v_phones, v_emails,
            private.support_text(p, 'address', 1000), v_erp, private.support_text(p, 'notes', 2000), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_customers set display_name = v_name, company_name = private.support_text(p, 'company_name', 200), phones = v_phones, emails = v_emails,
      address = private.support_text(p, 'address', 1000), erp_customer_id = v_erp, notes = private.support_text(p, 'notes', 2000), updated_by = auth.uid()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Customer not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'customer_code', (select customer_code from public.support_customers where id = v_id),
                            'duplicates', coalesce(v_dupes, '[]'::jsonb));
end;
$$;

create or replace function public.support_customer_list(p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_ph text := private.support_normalize_phone(p_search);
begin
  return (
    with f as (
      select c.* from public.support_customers c
      where c.company_id = v_company
        and (v_term is null or c.display_name ilike '%' || v_term || '%' or c.company_name ilike '%' || v_term || '%' or c.customer_code ilike '%' || v_term || '%'
             or lower(v_term) = any (c.normalized_emails) or exists (select 1 from unnest(c.emails) e where e ilike '%' || v_term || '%')
             or (v_ph is not null and exists (select 1 from unnest(c.normalized_phones) n where n like '%' || v_ph || '%'))))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(r order by r ->> 'display_name') from (
      select jsonb_build_object('id', f.id, 'customer_code', f.customer_code, 'display_name', f.display_name, 'company_name', f.company_name,
        'phones', f.phones, 'emails', f.emails, 'erp_customer_id', f.erp_customer_id,
        'erp_customer_code', (select customer_code from public.customers where id = f.erp_customer_id),
        'open_tickets', (select count(*) from public.support_tickets t where t.customer_id = f.id and t.status not in ('RESOLVED', 'CLOSED')),
        'conversations', (select count(*) from public.support_conversations s where s.customer_id = f.id),
        'last_activity_at', (select max(s.last_activity_at) from public.support_conversations s where s.customer_id = f.id)) r
      from f order by lower(f.display_name), f.id limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) z), '[]'::jsonb)));
end;
$$;

create or replace function public.support_customer_profile(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_customers;
  v_erp jsonb;
  v_orders jsonb := null;
  v_invoices jsonb := null;
begin
  select * into c from public.support_customers where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Customer not found in your company.' using errcode = 'P0001';
  end if;
  if c.erp_customer_id is not null and (private.has_permission(v_company, 'customers.read') or private.has_permission(v_company, 'ledger.read')) then
    select jsonb_build_object('id', e.id, 'customer_code', e.customer_code, 'customer_name', e.customer_name, 'contact_email', e.contact_email,
             'gstin', e.gstin, 'billing_address', e.billing_address, 'status', e.status)
    into v_erp from public.customers e where e.id = c.erp_customer_id;
  end if;
  -- Purchase / order history only for users who may see it in the ERP.
  if c.erp_customer_id is not null and private.has_permission(v_company, 'sales_orders.read') then
    v_orders := coalesce((select jsonb_agg(o order by o ->> 'order_date' desc) from (
      select jsonb_build_object('id', so.id, 'number', so.sales_order_number, 'order_date', so.order_date, 'status', so.order_status, 'value', so.grand_total) o
      from public.sales_orders so where so.customer_id = c.erp_customer_id order by so.order_date desc limit 20) z), '[]'::jsonb);
  end if;
  if c.erp_customer_id is not null and private.has_permission(v_company, 'invoices.read') then
    v_invoices := coalesce((select jsonb_agg(i order by i ->> 'invoice_date' desc) from (
      select jsonb_build_object('id', si.id, 'number', si.invoice_number, 'invoice_date', si.invoice_date, 'status', si.status, 'value', si.grand_total) i
      from public.sales_invoices si where si.customer_id = c.erp_customer_id and si.status in ('ISSUED', 'CANCELLED') order by si.invoice_date desc limit 20) z), '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'customer', to_jsonb(c) - 'company_id' - 'normalized_phones' - 'normalized_emails',
    'erp_customer', v_erp,
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status,
        'priority', t.priority, 'channel', t.channel, 'created_at', t.created_at, 'sla_status', private.support_sla_status(t)) order by t.created_at desc)
        from public.support_tickets t where t.customer_id = c.id), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'channel', s.channel, 'subject', s.subject, 'status', s.status,
        'last_message_preview', s.last_message_preview, 'last_activity_at', s.last_activity_at) order by s.last_activity_at desc)
        from public.support_conversations s where s.customer_id = c.id), '[]'::jsonb),
    'calls', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'direction', m.direction, 'call_status', m.call_status,
        'duration_seconds', m.call_duration_seconds, 'occurred_at', m.occurred_at, 'summary', m.body, 'source', m.source) order by m.occurred_at desc)
        from public.support_messages m join public.support_conversations s on s.id = m.conversation_id where s.customer_id = c.id and m.kind = 'CALL'), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'direction', m.direction, 'subject', m.email_subject,
        'occurred_at', m.occurred_at, 'source', m.source) order by m.occurred_at desc)
        from public.support_messages m join public.support_conversations s on s.id = m.conversation_id where s.customer_id = c.id and m.kind = 'EMAIL'), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_by', n.created_by,
        'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = n.created_by), 'created_at', n.created_at) order by n.created_at desc)
        from public.support_internal_notes n where n.customer_id = c.id), '[]'::jsonb),
    'orders', v_orders, 'invoices', v_invoices,
    'can_see_orders', v_orders is not null, 'can_see_invoices', v_invoices is not null);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Conversations and messages
-- -----------------------------------------------------------------------------
-- Logs a conversation that started outside the ERP (a call taken, a WhatsApp or email received elsewhere)
-- with its first activity. Links the customer only when the phone / email match exactly one customer.
create or replace function public.support_conversation_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_channel text := upper(coalesce(p ->> 'channel', ''));
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_phone text := private.support_text(p, 'contact_phone', 30);
  v_email text := lower(private.support_text(p, 'contact_email', 320));
  v_name text := private.support_text(p, 'contact_name', 200);
  v_direction text := upper(coalesce(p ->> 'direction', 'INBOUND'));
  v_body text := private.support_text(p, 'body', 20000);
  v_call text := upper(nullif(p ->> 'call_status', ''));
  v_duration integer := nullif(p ->> 'call_duration_seconds', '')::integer;
  v_at timestamptz := coalesce(nullif(p ->> 'occurred_at', '')::timestamptz, now());
  v_kind text;
  v_matches jsonb := '[]'::jsonb;
  v_match_state text := 'PROVIDED';
  v_id uuid;
  v_msg uuid;
begin
  if v_channel not in ('PHONE', 'WHATSAPP', 'EMAIL') then
    raise exception 'Choose the channel: phone, WhatsApp or email.' using errcode = 'P0001';
  end if;
  if v_direction not in ('INBOUND', 'OUTBOUND') then
    raise exception 'Direction must be inbound or outbound.' using errcode = 'P0001';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'The time cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_phone is not null and private.support_normalize_phone(v_phone) is null then
    raise exception 'Phone number "%" is not valid.', v_phone using errcode = 'P0001';
  end if;
  if v_email is not null and private.support_normalize_email(v_email) is null then
    raise exception 'Email address "%" is not valid.', v_email using errcode = 'P0001';
  end if;
  v_kind := case v_channel when 'PHONE' then 'CALL' when 'EMAIL' then 'EMAIL' else 'MESSAGE' end;
  if v_kind = 'CALL' and coalesce(v_call, '') not in ('ANSWERED', 'MISSED', 'VOICEMAIL', 'FAILED') then
    raise exception 'Choose the call result: answered, missed, voicemail or failed.' using errcode = 'P0001';
  end if;
  if v_kind <> 'CALL' and v_body is null then
    raise exception 'Enter the message.' using errcode = 'P0001';
  end if;
  if coalesce(nullif(upper(p ->> 'priority'), ''), 'NORMAL') not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001';
  end if;
  if v_customer is not null then
    if not exists (select 1 from public.support_customers where id = v_customer and company_id = v_company) then
      raise exception 'Customer not found in your company.' using errcode = 'P0001';
    end if;
  else
    if v_phone is null and v_email is null and v_name is null then
      raise exception 'Enter the customer, or their phone number or email address.' using errcode = 'P0001';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', m.customer_id, 'matched_on', m.matched_on)), '[]'::jsonb) into v_matches
    from private.support_match_customers(v_company, v_phone, v_email) m;
    if jsonb_array_length(v_matches) = 1 then
      v_customer := (v_matches -> 0 ->> 'id')::uuid;
      v_match_state := 'MATCHED';
    elsif jsonb_array_length(v_matches) > 1 then
      v_match_state := 'AMBIGUOUS';
    else
      v_match_state := 'NO_MATCH';
    end if;
  end if;
  insert into public.support_conversations (company_id, channel, customer_id, subject, contact_name, contact_phone, contact_email, status, priority,
    last_message_preview, last_activity_at, created_by, updated_by)
  values (v_company, v_channel, v_customer, private.support_text(p, 'subject', 200), v_name, v_phone, v_email, 'OPEN',
    coalesce(nullif(upper(p ->> 'priority'), ''), 'NORMAL'),
    left(coalesce(v_body, initcap(lower(v_call)) || ' call'), 300), v_at, auth.uid(), auth.uid())
  returning id into v_id;
  insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, call_status, call_duration_seconds, author_user_id, occurred_at)
  values (v_company, v_id, v_kind, v_direction, 'MANUAL', v_body, case when v_kind = 'EMAIL' then private.support_text(p, 'subject', 200) end,
    case when v_kind = 'CALL' then v_call end, case when v_kind = 'CALL' then v_duration end, auth.uid(), v_at)
  returning id into v_msg;
  perform private.support_run_automation(v_company, 'CONVERSATION_CREATED', null, v_id);
  return jsonb_build_object('id', v_id, 'message_id', v_msg, 'customer_id', v_customer, 'match', v_match_state, 'candidates', v_matches);
end;
$$;

-- Inbox: server-side filters, search (including message history) and pagination.
--   p_view: ALL / PHONE / WHATSAPP / EMAIL / UNASSIGNED / MINE / OPEN / PENDING / RESOLVED
create or replace function public.support_inbox(p_view text default 'ALL', p_channel text default null, p_search text default null,
  p_limit integer default 25, p_offset integer default 0, p_customer uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_view text := upper(coalesce(p_view, 'ALL'));
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_ph text := private.support_normalize_phone(p_search);
  v_me uuid := (select id from public.support_agents where company_id = v_company and user_id = auth.uid());
begin
  if v_view not in ('ALL', 'PHONE', 'WHATSAPP', 'EMAIL', 'UNASSIGNED', 'MINE', 'OPEN', 'PENDING', 'RESOLVED') then
    raise exception 'Unknown inbox view %.', p_view using errcode = 'P0001';
  end if;
  return (
    with f as (
      select s.* from public.support_conversations s
      left join public.support_customers c on c.id = s.customer_id
      where s.company_id = v_company
        and (p_channel is null or s.channel = upper(p_channel))
        and (p_customer is null or s.customer_id = p_customer)
        and case v_view
              when 'PHONE' then s.channel = 'PHONE' when 'WHATSAPP' then s.channel = 'WHATSAPP' when 'EMAIL' then s.channel = 'EMAIL'
              when 'UNASSIGNED' then s.assigned_agent_id is null and s.status <> 'RESOLVED'
              when 'MINE' then v_me is not null and s.assigned_agent_id = v_me
              when 'OPEN' then s.status = 'OPEN' when 'PENDING' then s.status = 'PENDING' when 'RESOLVED' then s.status = 'RESOLVED'
              else true end
        and (v_term is null
             or s.subject ilike '%' || v_term || '%' or s.contact_name ilike '%' || v_term || '%' or s.contact_email ilike '%' || v_term || '%'
             or c.display_name ilike '%' || v_term || '%' or c.customer_code ilike '%' || v_term || '%'
             or (v_ph is not null and (s.normalized_phone like '%' || v_ph || '%' or exists (select 1 from unnest(c.normalized_phones) n where n like '%' || v_ph || '%')))
             or exists (select 1 from public.support_tickets t where t.id = s.ticket_id and t.ticket_number ilike '%' || v_term || '%')
             or exists (select 1 from public.support_messages m where m.conversation_id = s.id and (m.body ilike '%' || v_term || '%' or m.email_subject ilike '%' || v_term || '%'))))
    select jsonb_build_object(
      'total', (select count(*) from f),
      'me', v_me,
      'rows', coalesce((select jsonb_agg(r order by (r ->> 'last_activity_at') desc) from (
        select jsonb_build_object('id', f.id, 'channel', f.channel, 'subject', f.subject, 'status', f.status, 'priority', f.priority,
          'customer_id', f.customer_id,
          'customer_name', coalesce(c.display_name, f.contact_name, f.contact_phone, f.contact_email),
          'phone', coalesce(f.contact_phone, c.phones[1]), 'email', coalesce(f.contact_email, c.emails[1]),
          'last_message_preview', f.last_message_preview, 'last_activity_at', f.last_activity_at, 'unread_count', f.unread_count,
          'assigned_agent_id', f.assigned_agent_id, 'assigned_agent', a.display_name,
          'ticket_id', f.ticket_id, 'ticket_number', t.ticket_number,
          'tags', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color) order by g.name)
                            from public.support_conversation_tags ct join public.support_tags g on g.id = ct.tag_id where ct.conversation_id = f.id), '[]'::jsonb)) r
        from f
        left join public.support_customers c on c.id = f.customer_id
        left join public.support_agents a on a.id = f.assigned_agent_id
        left join public.support_tickets t on t.id = f.ticket_id
        order by f.last_activity_at desc, f.id
        limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) z), '[]'::jsonb),
      'counts', jsonb_build_object(
        'ALL', (select count(*) from public.support_conversations where company_id = v_company),
        'UNASSIGNED', (select count(*) from public.support_conversations where company_id = v_company and assigned_agent_id is null and status <> 'RESOLVED'),
        'MINE', (select count(*) from public.support_conversations where company_id = v_company and v_me is not null and assigned_agent_id = v_me),
        'OPEN', (select count(*) from public.support_conversations where company_id = v_company and status = 'OPEN'),
        'PENDING', (select count(*) from public.support_conversations where company_id = v_company and status = 'PENDING'),
        'UNREAD', (select coalesce(sum(unread_count), 0) from public.support_conversations where company_id = v_company)))
  );
end;
$$;

create or replace function public.support_conversation_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  s public.support_conversations;
  v_sensitive boolean;
begin
  select * into s from public.support_conversations where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  v_sensitive := private.has_permission(v_company, 'support.manage_tickets');
  return jsonb_build_object(
    'conversation', to_jsonb(s) - 'company_id' - 'normalized_phone' - 'normalized_email',
    'channel_status', private.support_channel_health(v_company, s.channel),
    'customer', (select jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name, 'company_name', c.company_name,
                   'phones', c.phones, 'emails', c.emails) from public.support_customers c where c.id = s.customer_id),
    'candidates', case when s.customer_id is null then coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'customer_code', c.customer_code,
                     'display_name', c.display_name, 'matched_on', m.matched_on)) from private.support_match_customers(v_company, s.contact_phone, s.contact_email) m
                     join public.support_customers c on c.id = m.customer_id), '[]'::jsonb) else '[]'::jsonb end,
    'ticket', (select jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority,
                 'sla_status', private.support_sla_status(t)) from public.support_tickets t where t.id = s.ticket_id),
    'agent', (select jsonb_build_object('id', a.id, 'display_name', a.display_name) from public.support_agents a where a.id = s.assigned_agent_id),
    'tags', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color) order by g.name)
                      from public.support_conversation_tags ct join public.support_tags g on g.id = ct.tag_id where ct.conversation_id = s.id), '[]'::jsonb),
    -- Chronological timeline: messages, calls, emails, notes, attachments and ticket events.
    'timeline', coalesce((select jsonb_agg(e order by e ->> 'at', e ->> 'id') from (
        select jsonb_build_object('type', lower(m.kind), 'id', m.id, 'at', m.occurred_at, 'direction', m.direction, 'source', m.source, 'body', m.body,
          'email_subject', m.email_subject, 'call_status', m.call_status, 'duration_seconds', m.call_duration_seconds, 'delivery_status', m.delivery_status,
          'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = m.author_user_id)) e
        from public.support_messages m where m.conversation_id = s.id
        union all
        select jsonb_build_object('type', 'note', 'id', n.id, 'at', n.created_at, 'body', n.body,
          'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = n.created_by))
        from public.support_internal_notes n where n.conversation_id = s.id or (s.ticket_id is not null and n.ticket_id = s.ticket_id)
        union all
        select jsonb_build_object('type', 'attachment', 'id', a.id, 'at', a.created_at, 'file_name', a.file_name, 'content_type', a.content_type,
          'size_bytes', a.size_bytes, 'is_recording', a.is_recording, 'is_sensitive', a.is_sensitive,
          'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end, 'restricted', a.is_sensitive and not v_sensitive)
        from public.support_attachments a where a.conversation_id = s.id or a.message_id in (select id from public.support_messages where conversation_id = s.id)
        union all
        select jsonb_build_object('type', 'event', 'id', ev.id, 'at', ev.created_at, 'event_type', ev.event_type, 'from', ev.from_value, 'to', ev.to_value,
          'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = ev.actor_user_id))
        from public.support_ticket_events ev where s.ticket_id is not null and ev.ticket_id = s.ticket_id) z), '[]'::jsonb));
end;
$$;

-- Replies, logged messages and logged calls.
--   p.mode: REPLY (sent through the connected channel; refused when the channel is not connected)
--           LOG   (activity that happened outside the ERP: kind from the channel, direction given)
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
    v_health := private.support_channel_health(v_company, s.channel);
    if v_health <> 'CONNECTED' then
      raise exception 'Cannot reply through % : the channel is %. Log the reply instead if it was sent elsewhere.',
        initcap(lower(s.channel)), replace(lower(v_health), '_', ' ') using errcode = 'P0001';
    end if;
    if v_body is null then
      raise exception 'Enter the reply.' using errcode = 'P0001';
    end if;
    insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, delivery_status, author_user_id, occurred_at)
    values (v_company, s.id, v_kind, 'OUTBOUND', 'CHANNEL', v_body, case when v_kind = 'EMAIL' then coalesce(private.support_text(p, 'email_subject', 300), 'Re: ' || coalesce(s.subject, '')) end,
            'QUEUED', auth.uid(), now())
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

create or replace function public.support_conversation_update(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  s public.support_conversations;
  v_status text := upper(coalesce(p ->> 'status', ''));
  v_priority text := upper(coalesce(p ->> 'priority', ''));
begin
  select * into s from public.support_conversations where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  if p ? 'status' and v_status not in ('OPEN', 'PENDING', 'RESOLVED') then
    raise exception 'Status must be open, pending or resolved.' using errcode = 'P0001';
  end if;
  if p ? 'priority' and v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001';
  end if;
  update public.support_conversations set
    status = case when p ? 'status' then v_status else status end,
    priority = case when p ? 'priority' then v_priority else priority end,
    subject = case when p ? 'subject' then private.support_text(p, 'subject', 200) else subject end,
    updated_by = auth.uid()
  where id = p_id;
end;
$$;

create or replace function public.support_conversation_assign(p_id uuid, p_agent uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.assign');
  v_agent public.support_agents := private.support_agent_of(v_company, p_agent);
begin
  update public.support_conversations set assigned_agent_id = v_agent.id, updated_by = auth.uid() where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.support_conversation_set_tags(p_id uuid, p_tags uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
begin
  if not exists (select 1 from public.support_conversations where id = p_id and company_id = v_company) then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(coalesce(p_tags, '{}')) t where not exists (select 1 from public.support_tags g where g.id = t and g.company_id = v_company)) then
    raise exception 'Tag not found in your company.' using errcode = 'P0001';
  end if;
  delete from public.support_conversation_tags where conversation_id = p_id and not (tag_id = any (coalesce(p_tags, '{}')));
  insert into public.support_conversation_tags (company_id, conversation_id, tag_id, created_by)
  select v_company, p_id, t, auth.uid() from unnest(coalesce(p_tags, '{}')) t on conflict do nothing;
  perform private.support_audit(v_company, 'conversations.tags_set', 'conversations', p_id::text, jsonb_build_object('tags', coalesce(p_tags, '{}')));
end;
$$;

create or replace function public.support_conversation_mark_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  update public.support_conversations set unread_count = 0 where id = p_id and company_id = v_company and unread_count <> 0;
end;
$$;

create or replace function public.support_conversation_link_customer(p_id uuid, p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
begin
  if p_customer is not null and not exists (select 1 from public.support_customers where id = p_customer and company_id = v_company) then
    raise exception 'Customer not found in your company.' using errcode = 'P0001';
  end if;
  update public.support_conversations set customer_id = p_customer, updated_by = auth.uid() where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
end;
$$;

-- Internal notes on a conversation, ticket or customer. Never sent to the customer.
create or replace function public.support_note_add(p_target text, p_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
begin
  if v_body is null then
    raise exception 'Enter the note.' using errcode = 'P0001';
  end if;
  if length(v_body) > 5000 then
    raise exception 'The note is too long (at most 5000 characters).' using errcode = 'P0001';
  end if;
  case upper(coalesce(p_target, ''))
    when 'CONVERSATION' then
      if not exists (select 1 from public.support_conversations where id = p_id and company_id = v_company) then
        raise exception 'Conversation not found in your company.' using errcode = 'P0001';
      end if;
      insert into public.support_internal_notes (company_id, conversation_id, body, created_by) values (v_company, p_id, v_body, auth.uid()) returning id into v_id;
    when 'TICKET' then
      if not exists (select 1 from public.support_tickets where id = p_id and company_id = v_company) then
        raise exception 'Ticket not found in your company.' using errcode = 'P0001';
      end if;
      insert into public.support_internal_notes (company_id, ticket_id, body, created_by) values (v_company, p_id, v_body, auth.uid()) returning id into v_id;
      perform private.support_ticket_event(p_id, 'NOTE_ADDED', null, null, jsonb_build_object('note_id', v_id));
    when 'CUSTOMER' then
      if not exists (select 1 from public.support_customers where id = p_id and company_id = v_company) then
        raise exception 'Customer not found in your company.' using errcode = 'P0001';
      end if;
      insert into public.support_internal_notes (company_id, customer_id, body, created_by) values (v_company, p_id, v_body, auth.uid()) returning id into v_id;
    else
      raise exception 'Notes can be added to a conversation, ticket or customer.' using errcode = 'P0001';
  end case;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Tickets
-- -----------------------------------------------------------------------------
create or replace function public.support_ticket_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  v_conv public.support_conversations;
  v_conv_id uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_subject text := private.support_text(p, 'subject', 200);
  v_priority text := upper(coalesce(nullif(p ->> 'priority', ''), 'NORMAL'));
  v_channel text := upper(coalesce(nullif(p ->> 'channel', ''), 'MANUAL'));
  v_agent uuid := nullif(p ->> 'assigned_agent_id', '')::uuid;
  v_related text := upper(nullif(p ->> 'related_type', ''));
  v_id uuid;
  v_number text;
  v_phone text := private.support_text(p, 'customer_phone', 30);
  v_email text := lower(private.support_text(p, 'customer_email', 320));
begin
  if v_subject is null or length(v_subject) < 3 then
    raise exception 'Enter a subject (at least 3 characters).' using errcode = 'P0001';
  end if;
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001';
  end if;
  if v_conv_id is not null then
    select * into v_conv from public.support_conversations where id = v_conv_id and company_id = v_company for update;
    if not found then
      raise exception 'Conversation not found in your company.' using errcode = 'P0001';
    end if;
    if v_conv.ticket_id is not null then
      raise exception 'This conversation already has ticket %.', (select ticket_number from public.support_tickets where id = v_conv.ticket_id) using errcode = 'P0001';
    end if;
    v_channel := v_conv.channel;
    v_customer := coalesce(v_customer, v_conv.customer_id);
    v_phone := coalesce(v_phone, v_conv.contact_phone);
    v_email := coalesce(v_email, v_conv.contact_email);
  end if;
  if v_channel not in ('PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL') then
    raise exception 'Unknown channel %.', v_channel using errcode = 'P0001';
  end if;
  if v_customer is not null then
    if not exists (select 1 from public.support_customers where id = v_customer and company_id = v_company) then
      raise exception 'Customer not found in your company.' using errcode = 'P0001';
    end if;
    select coalesce(v_phone, phones[1]), coalesce(v_email, emails[1]) into v_phone, v_email from public.support_customers where id = v_customer;
  end if;
  if v_customer is null and v_phone is null and v_email is null then
    raise exception 'Choose the customer or enter their phone number or email address.' using errcode = 'P0001';
  end if;
  if v_phone is not null and private.support_normalize_phone(v_phone) is null then
    raise exception 'Phone number "%" is not valid.', v_phone using errcode = 'P0001';
  end if;
  if v_email is not null and private.support_normalize_email(v_email) is null then
    raise exception 'Email address "%" is not valid.', v_email using errcode = 'P0001';
  end if;
  if v_related is not null then
    if v_related not in ('PRODUCT', 'SALES_ORDER', 'INVOICE') then
      raise exception 'Related record must be a product, sales order or invoice.' using errcode = 'P0001';
    end if;
    if nullif(p ->> 'related_id', '') is not null and not (case v_related
        when 'PRODUCT' then exists (select 1 from public.products where id = (p ->> 'related_id')::uuid and company_id = v_company)
        when 'SALES_ORDER' then exists (select 1 from public.sales_orders where id = (p ->> 'related_id')::uuid and company_id = v_company)
        else exists (select 1 from public.sales_invoices where id = (p ->> 'related_id')::uuid and company_id = v_company) end) then
      raise exception 'The related record was not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  perform private.support_agent_of(v_company, v_agent);
  v_number := private.support_next_number(v_company, 'SUPT', 'ALT-SUP');
  insert into public.support_tickets (company_id, ticket_number, subject, customer_id, customer_phone, customer_email, channel, category, subcategory, description,
    priority, status, department, assigned_agent_id, related_type, related_id, related_reference, created_by, updated_by)
  values (v_company, v_number, v_subject, v_customer, v_phone, v_email, v_channel, private.support_text(p, 'category', 80), private.support_text(p, 'subcategory', 80),
    private.support_text(p, 'description', 10000), v_priority, 'NEW', private.support_text(p, 'department', 80), v_agent,
    v_related, case when v_related is not null then nullif(p ->> 'related_id', '')::uuid end, case when v_related is not null then private.support_text(p, 'related_reference', 80) end,
    auth.uid(), auth.uid())
  returning id into v_id;
  perform private.support_apply_sla(v_id);
  perform private.support_ticket_event(v_id, 'CREATED', null, 'NEW', jsonb_build_object('channel', v_channel, 'conversation_id', v_conv_id));
  if v_conv_id is not null then
    update public.support_conversations set ticket_id = v_id, updated_by = auth.uid() where id = v_conv_id;
    perform private.support_ticket_event(v_id, 'CONVERSATION_LINKED', null, v_conv_id::text);
    -- An outbound reply before the ticket existed counts as its first response.
    if exists (select 1 from public.support_messages where conversation_id = v_conv_id and direction = 'OUTBOUND') then
      perform private.support_mark_first_response(v_conv_id, (select min(occurred_at) from public.support_messages where conversation_id = v_conv_id and direction = 'OUTBOUND'));
    end if;
  end if;
  perform private.support_run_automation(v_company, 'TICKET_CREATED', v_id, null);
  return jsonb_build_object('id', v_id, 'ticket_number', v_number);
end;
$$;

create or replace function public.support_ticket_update(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  t public.support_tickets;
  v_status text := upper(coalesce(p ->> 'status', ''));
  v_priority text := upper(coalesce(p ->> 'priority', ''));
  v_rating smallint := nullif(p ->> 'csat_rating', '')::smallint;
begin
  select * into t from public.support_tickets where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if t.merged_into_ticket_id is not null then
    raise exception 'Ticket % was merged into another ticket and cannot be changed.', t.ticket_number using errcode = 'P0001';
  end if;
  if t.status = 'CLOSED' and (p - 'csat_rating' - 'csat_comment') <> '{}'::jsonb then
    raise exception 'Ticket % is closed. Reopen it to make changes.', t.ticket_number using errcode = 'P0001';
  end if;
  if p ? 'status' and v_status not in ('NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED') then
    raise exception 'Unknown ticket status %.', p ->> 'status' using errcode = 'P0001';
  end if;
  if p ? 'status' and v_status = 'NEW' and t.status <> 'NEW' then
    raise exception 'A ticket cannot go back to New.' using errcode = 'P0001';
  end if;
  if p ? 'status' and t.status = 'RESOLVED' and v_status not in ('RESOLVED', 'CLOSED') then
    raise exception 'Ticket % is resolved. Use Reopen (with a reason) to work on it again.', t.ticket_number using errcode = 'P0001';
  end if;
  if p ? 'priority' and v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001';
  end if;
  if p ? 'subject' and (private.support_text(p, 'subject', 200) is null or length(private.support_text(p, 'subject', 200)) < 3) then
    raise exception 'Enter a subject (at least 3 characters).' using errcode = 'P0001';
  end if;
  if v_rating is not null and v_rating not between 1 and 5 then
    raise exception 'The satisfaction rating is 1 to 5.' using errcode = 'P0001';
  end if;
  update public.support_tickets set
    subject = case when p ? 'subject' then private.support_text(p, 'subject', 200) else subject end,
    category = case when p ? 'category' then private.support_text(p, 'category', 80) else category end,
    subcategory = case when p ? 'subcategory' then private.support_text(p, 'subcategory', 80) else subcategory end,
    description = case when p ? 'description' then private.support_text(p, 'description', 10000) else description end,
    department = case when p ? 'department' then private.support_text(p, 'department', 80) else department end,
    priority = case when p ? 'priority' then v_priority else priority end,
    status = case when p ? 'status' then v_status else status end,
    resolved_at = case when p ? 'status' then case when v_status in ('RESOLVED', 'CLOSED') then coalesce(resolved_at, now()) else null end else resolved_at end,
    closed_at = case when p ? 'status' then case when v_status = 'CLOSED' then coalesce(closed_at, now()) else null end else closed_at end,
    due_at = case when p ? 'due_at' then nullif(p ->> 'due_at', '')::timestamptz else due_at end,
    csat_rating = case when p ? 'csat_rating' then v_rating else csat_rating end,
    csat_comment = case when p ? 'csat_comment' then private.support_text(p, 'csat_comment', 1000) else csat_comment end,
    updated_by = auth.uid()
  where id = p_id;
  if p ? 'status' and v_status is distinct from t.status then
    perform private.support_ticket_event(p_id, 'STATUS_CHANGED', t.status, v_status);
  end if;
  if p ? 'priority' and v_priority is distinct from t.priority then
    perform private.support_ticket_event(p_id, 'PRIORITY_CHANGED', t.priority, v_priority);
    if not (p ? 'due_at') then perform private.support_apply_sla(p_id); end if;
  end if;
  if p ? 'csat_rating' and v_rating is distinct from t.csat_rating then
    perform private.support_ticket_event(p_id, 'CSAT_RECORDED', t.csat_rating::text, v_rating::text);
  end if;
  if (p - 'status' - 'priority' - 'csat_rating' - 'csat_comment') <> '{}'::jsonb then
    perform private.support_ticket_event(p_id, 'UPDATED', null, null, jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p - 'status' - 'priority' - 'csat_rating' - 'csat_comment') k)));
  end if;
end;
$$;

create or replace function public.support_ticket_assign(p_id uuid, p_agent uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.assign');
  t public.support_tickets;
  v_agent public.support_agents := private.support_agent_of(v_company, p_agent);
begin
  select * into t from public.support_tickets where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if t.status = 'CLOSED' or t.merged_into_ticket_id is not null then
    raise exception 'Ticket % is closed. Reopen it to reassign.', t.ticket_number using errcode = 'P0001';
  end if;
  update public.support_tickets set assigned_agent_id = v_agent.id, updated_by = auth.uid() where id = p_id;
  perform private.support_ticket_event(p_id, 'ASSIGNED', (select display_name from public.support_agents where id = t.assigned_agent_id), v_agent.display_name);
end;
$$;

-- Merges a duplicate (source) into the ticket that stays (target). The source is closed and points to the target;
-- its conversations move to the target. Nothing is deleted.
create or replace function public.support_ticket_merge(p_source uuid, p_target uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  s public.support_tickets;
  t public.support_tickets;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_source = p_target then
    raise exception 'Choose two different tickets.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Enter the reason for merging.' using errcode = 'P0001';
  end if;
  select * into s from public.support_tickets where id = p_source and company_id = v_company for update;
  select * into t from public.support_tickets where id = p_target and company_id = v_company for update;
  if s.id is null or t.id is null then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if s.merged_into_ticket_id is not null or t.merged_into_ticket_id is not null then
    raise exception 'A merged ticket cannot be merged again.' using errcode = 'P0001';
  end if;
  if t.status = 'CLOSED' then
    raise exception 'Ticket % is closed. Reopen it before merging into it.', t.ticket_number using errcode = 'P0001';
  end if;
  update public.support_conversations set ticket_id = t.id, updated_by = auth.uid() where ticket_id = s.id;
  update public.support_tickets set merged_into_ticket_id = t.id, status = 'CLOSED', resolved_at = coalesce(resolved_at, now()), closed_at = now(), updated_by = auth.uid()
  where id = s.id;
  perform private.support_ticket_event(s.id, 'MERGED_INTO', s.ticket_number, t.ticket_number, jsonb_build_object('reason', v_reason, 'target_id', t.id));
  perform private.support_ticket_event(t.id, 'MERGED', s.ticket_number, t.ticket_number, jsonb_build_object('reason', v_reason, 'source_id', s.id));
end;
$$;

create or replace function public.support_ticket_reopen(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  t public.support_tickets;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Enter the reason for reopening.' using errcode = 'P0001';
  end if;
  select * into t from public.support_tickets where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if t.merged_into_ticket_id is not null then
    raise exception 'Ticket % was merged into another ticket; work on that ticket instead.', t.ticket_number using errcode = 'P0001';
  end if;
  if t.status not in ('RESOLVED', 'CLOSED') then
    raise exception 'Only resolved or closed tickets can be reopened.' using errcode = 'P0001';
  end if;
  update public.support_tickets set status = 'OPEN', resolved_at = null, closed_at = null, reopen_count = reopen_count + 1, updated_by = auth.uid() where id = p_id;
  perform private.support_ticket_event(p_id, 'REOPENED', t.status, 'OPEN', jsonb_build_object('reason', left(p_reason, 500)));
end;
$$;

create or replace function public.support_ticket_link_conversation(p_ticket uuid, p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  s public.support_conversations;
begin
  if not exists (select 1 from public.support_tickets where id = p_ticket and company_id = v_company and merged_into_ticket_id is null) then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  select * into s from public.support_conversations where id = p_conversation and company_id = v_company for update;
  if not found then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  if s.ticket_id is not null and s.ticket_id <> p_ticket then
    raise exception 'This conversation already belongs to ticket %.', (select ticket_number from public.support_tickets where id = s.ticket_id) using errcode = 'P0001';
  end if;
  update public.support_conversations set ticket_id = p_ticket, updated_by = auth.uid() where id = p_conversation;
  perform private.support_ticket_event(p_ticket, 'CONVERSATION_LINKED', null, p_conversation::text);
end;
$$;

-- Ticket list: server-side filters, search, sort and pagination (also the export source).
--   p: {status?, statuses?[], priority?, channel?, agent_id?, unassigned?, sla?, customer_id?, from?, to?, search?, sort?, limit?, offset?}
create or replace function public.support_ticket_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_term text := nullif(btrim(coalesce(p ->> 'search', '')), '');
  v_limit integer := least(greatest(coalesce((p ->> 'limit')::integer, 25), 1), 5000);
  v_offset integer := greatest(coalesce((p ->> 'offset')::integer, 0), 0);
  v_sort text := coalesce(p ->> 'sort', 'created_desc');
begin
  if v_limit > 200 and not private.has_permission(v_company, 'support.manage_tickets') then
    raise exception 'Exporting tickets requires support.manage_tickets.' using errcode = '42501';
  end if;
  return (
    with base as (
      select t.*, private.support_sla_status(t) as sla from public.support_tickets t where t.company_id = v_company),
    f as (
      select b.* from base b
      left join public.support_customers c on c.id = b.customer_id
      where (nullif(p ->> 'status', '') is null or b.status = upper(p ->> 'status'))
        and (p -> 'statuses' is null or b.status in (select upper(x) from jsonb_array_elements_text(p -> 'statuses') x))
        and (nullif(p ->> 'priority', '') is null or b.priority = upper(p ->> 'priority'))
        and (nullif(p ->> 'channel', '') is null or b.channel = upper(p ->> 'channel'))
        and (nullif(p ->> 'agent_id', '') is null or b.assigned_agent_id = (p ->> 'agent_id')::uuid)
        and (not coalesce((p ->> 'unassigned')::boolean, false) or b.assigned_agent_id is null)
        and (nullif(p ->> 'sla', '') is null or b.sla = upper(p ->> 'sla'))
        and (nullif(p ->> 'customer_id', '') is null or b.customer_id = (p ->> 'customer_id')::uuid)
        and (nullif(p ->> 'from', '') is null or b.created_at >= (p ->> 'from')::date)
        and (nullif(p ->> 'to', '') is null or b.created_at < (p ->> 'to')::date + 1)
        and (v_term is null or b.ticket_number ilike '%' || v_term || '%' or b.subject ilike '%' || v_term || '%' or b.customer_email ilike '%' || v_term || '%'
             or b.customer_phone ilike '%' || v_term || '%' or c.display_name ilike '%' || v_term || '%' or b.category ilike '%' || v_term || '%'))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(r order by ord) from (
      select row_number() over (order by
          case when v_sort = 'created_asc' then f.created_at end asc,
          case when v_sort = 'due_asc' then f.due_at end asc nulls last,
          case when v_sort = 'priority' then case f.priority when 'URGENT' then 1 when 'HIGH' then 2 when 'NORMAL' then 3 else 4 end end asc,
          case when v_sort = 'updated_desc' then f.updated_at end desc,
          f.created_at desc, f.id) as ord,
        jsonb_build_object('id', f.id, 'ticket_number', f.ticket_number, 'subject', f.subject, 'customer_id', f.customer_id,
          'customer_name', (select display_name from public.support_customers where id = f.customer_id),
          'customer_phone', f.customer_phone, 'customer_email', f.customer_email, 'channel', f.channel, 'category', f.category, 'subcategory', f.subcategory,
          'priority', f.priority, 'status', f.status, 'department', f.department, 'assigned_agent_id', f.assigned_agent_id,
          'assigned_agent', (select display_name from public.support_agents where id = f.assigned_agent_id),
          'created_at', f.created_at, 'first_response_at', f.first_response_at, 'due_at', f.due_at, 'resolved_at', f.resolved_at, 'closed_at', f.closed_at,
          'sla_status', f.sla, 'merged_into', (select ticket_number from public.support_tickets where id = f.merged_into_ticket_id),
          'related_type', f.related_type, 'related_reference', f.related_reference, 'csat_rating', f.csat_rating, 'reopen_count', f.reopen_count) r
      from f order by 1 limit v_limit offset v_offset) z), '[]'::jsonb)));
end;
$$;

create or replace function public.support_ticket_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  t public.support_tickets;
  v_sensitive boolean;
begin
  select * into t from public.support_tickets where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  v_sensitive := private.has_permission(v_company, 'support.manage_tickets');
  return jsonb_build_object(
    'ticket', to_jsonb(t) - 'company_id' || jsonb_build_object('sla_status', private.support_sla_status(t),
      'merged_into', (select jsonb_build_object('id', m.id, 'ticket_number', m.ticket_number) from public.support_tickets m where m.id = t.merged_into_ticket_id),
      'merged_from', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'ticket_number', m.ticket_number)) from public.support_tickets m where m.merged_into_ticket_id = t.id), '[]'::jsonb)),
    'customer', (select jsonb_build_object('id', c.id, 'customer_code', c.customer_code, 'display_name', c.display_name, 'phones', c.phones, 'emails', c.emails)
                 from public.support_customers c where c.id = t.customer_id),
    'agent', (select jsonb_build_object('id', a.id, 'display_name', a.display_name) from public.support_agents a where a.id = t.assigned_agent_id),
    'sla_policy', (select jsonb_build_object('name', s.name, 'first_response_minutes', s.first_response_minutes, 'resolution_minutes', s.resolution_minutes)
                   from public.support_sla_policies s where s.id = t.sla_policy_id),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'channel', s.channel, 'subject', s.subject, 'status', s.status,
        'last_message_preview', s.last_message_preview, 'last_activity_at', s.last_activity_at) order by s.last_activity_at desc)
        from public.support_conversations s where s.ticket_id = t.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'event_type', e.event_type, 'from', e.from_value, 'to', e.to_value, 'details', e.details,
        'at', e.created_at, 'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = e.actor_user_id)) order by e.created_at, e.id)
        from public.support_ticket_events e where e.ticket_id = t.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at,
        'author', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = n.created_by)) order by n.created_at)
        from public.support_internal_notes n where n.ticket_id = t.id), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type, 'size_bytes', a.size_bytes,
        'is_sensitive', a.is_sensitive, 'is_recording', a.is_recording, 'at', a.created_at,
        'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end, 'restricted', a.is_sensitive and not v_sensitive) order by a.created_at)
        from public.support_attachments a where a.ticket_id = t.id), '[]'::jsonb));
end;
$$;

-- Attachment metadata after the file was uploaded to the support-attachments bucket.
create or replace function public.support_attachment_register(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_ticket uuid := nullif(p ->> 'ticket_id', '')::uuid;
  v_path text := private.support_text(p, 'storage_path', 500);
  v_recording boolean := coalesce((p ->> 'is_recording')::boolean, false);
  v_id uuid;
begin
  if v_conv is null and v_ticket is null then
    raise exception 'Attach the file to a conversation or ticket.' using errcode = 'P0001';
  end if;
  if v_conv is not null and not exists (select 1 from public.support_conversations where id = v_conv and company_id = v_company) then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  if v_ticket is not null and not exists (select 1 from public.support_tickets where id = v_ticket and company_id = v_company) then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if v_path is null or v_path not like v_company::text || '/%' then
    raise exception 'The file must be stored under your company''s folder.' using errcode = 'P0001';
  end if;
  if v_recording and not private.has_permission(v_company, 'support.manage_tickets') then
    raise exception 'Adding call recordings requires support.manage_tickets.' using errcode = '42501';
  end if;
  insert into public.support_attachments (company_id, conversation_id, ticket_id, file_name, storage_path, content_type, size_bytes, is_recording, is_sensitive, uploaded_by)
  values (v_company, v_conv, v_ticket, coalesce(private.support_text(p, 'file_name', 255), 'file'), v_path, private.support_text(p, 'content_type', 120),
    nullif(p ->> 'size_bytes', '')::bigint, v_recording, v_recording or coalesce((p ->> 'is_sensitive')::boolean, false), auth.uid())
  returning id into v_id;
  if v_ticket is not null then
    perform private.support_ticket_event(v_ticket, 'ATTACHMENT_ADDED', null, private.support_text(p, 'file_name', 255), jsonb_build_object('attachment_id', v_id));
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Agents, presence and workspace
-- -----------------------------------------------------------------------------
create or replace function public.support_agent_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_name text := private.support_text(p, 'display_name', 120);
  v_id uuid;
begin
  if v_name is null then
    raise exception 'Enter the agent''s display name.' using errcode = 'P0001';
  end if;
  if p_id is null then
    if v_user is null or not exists (select 1 from public.profiles where id = v_user and company_id = v_company and is_active) then
      raise exception 'Choose an active user of your company.' using errcode = 'P0001';
    end if;
    if not private.user_has_permission_code(v_user, v_company, 'support.view') then
      raise exception 'This user cannot open the Support Centre. Give their role support.view first.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.support_agents where company_id = v_company and user_id = v_user) then
      raise exception 'This user is already an agent.' using errcode = 'P0001';
    end if;
    insert into public.support_agents (company_id, user_id, display_name, department, max_open_conversations, is_active, created_by, updated_by)
    values (v_company, v_user, v_name, private.support_text(p, 'department', 80), coalesce(nullif(p ->> 'max_open_conversations', '')::integer, 25),
            coalesce((p ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_agents set display_name = v_name, department = private.support_text(p, 'department', 80),
      max_open_conversations = coalesce(nullif(p ->> 'max_open_conversations', '')::integer, max_open_conversations),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      presence = case when coalesce((p ->> 'is_active')::boolean, is_active) then presence else 'OFFLINE' end,
      updated_by = auth.uid()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Agent not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

-- Whether a (possibly other) user holds a permission in a company.
create or replace function private.user_has_permission_code(p_user uuid, p_company uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id
                 join public.permissions perm on perm.id = rp.permission_id
                 where ur.user_id = p_user and ur.company_id = p_company and perm.code = p_permission);
$$;
revoke all on function private.user_has_permission_code(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.support_agent_set_presence(p_presence text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_presence text := upper(coalesce(p_presence, ''));
begin
  if v_presence not in ('AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE') then
    raise exception 'Presence must be available, busy, away or offline.' using errcode = 'P0001';
  end if;
  update public.support_agents set presence = v_presence, presence_updated_at = now()
  where company_id = v_company and user_id = auth.uid() and is_active;
  if not found then
    raise exception 'You are not set up as an active support agent. Ask an administrator to add you in Support Settings.' using errcode = 'P0001';
  end if;
  perform private.support_audit(v_company, 'agents.presence', 'agents', (select id::text from public.support_agents where company_id = v_company and user_id = auth.uid()),
    jsonb_build_object('presence', v_presence));
end;
$$;

create or replace function public.support_agent_workspace(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  a public.support_agents;
begin
  select * into a from public.support_agents where company_id = v_company and user_id = auth.uid();
  if not found then
    return jsonb_build_object('agent', null);
  end if;
  return jsonb_build_object(
    'agent', to_jsonb(a) - 'company_id',
    'workload', jsonb_build_object(
      'open_conversations', (select count(*) from public.support_conversations where assigned_agent_id = a.id and status <> 'RESOLVED'),
      'unread', (select coalesce(sum(unread_count), 0) from public.support_conversations where assigned_agent_id = a.id),
      'open_tickets', (select count(*) from public.support_tickets where assigned_agent_id = a.id and status not in ('RESOLVED', 'CLOSED')),
      'overdue_tickets', (select count(*) from public.support_tickets t where t.assigned_agent_id = a.id and private.support_sla_status(t) = 'OVERDUE'),
      'capacity', a.max_open_conversations),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'channel', s.channel, 'subject', s.subject, 'status', s.status, 'priority', s.priority,
        'customer_name', coalesce((select display_name from public.support_customers where id = s.customer_id), s.contact_name, s.contact_phone, s.contact_email),
        'unread_count', s.unread_count, 'last_activity_at', s.last_activity_at) order by s.last_activity_at desc)
        from (select * from public.support_conversations where assigned_agent_id = a.id and status <> 'RESOLVED' order by last_activity_at desc limit 50) s), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status, 'priority', t.priority,
        'due_at', t.due_at, 'sla_status', t.sla) order by t.due_at nulls last)
        from (select x.*, private.support_sla_status(x) as sla from public.support_tickets x
              where x.assigned_agent_id = a.id and x.status not in ('RESOLVED', 'CLOSED') order by x.due_at nulls last limit 50) t), '[]'::jsonb),
    'performance', (select jsonb_build_object(
        'resolved', count(*) filter (where t.resolved_at::date between p_from and p_to),
        'avg_resolution_minutes', round(avg(extract(epoch from t.resolved_at - t.created_at) / 60) filter (where t.resolved_at::date between p_from and p_to)),
        'avg_first_response_minutes', round(avg(extract(epoch from t.first_response_at - t.created_at) / 60) filter (where t.created_at::date between p_from and p_to)),
        'sla_met', count(*) filter (where t.resolved_at::date between p_from and p_to and private.support_sla_status(t) = 'MET'),
        'sla_breached', count(*) filter (where t.resolved_at::date between p_from and p_to and private.support_sla_status(t) = 'BREACHED'),
        'csat_avg', round(avg(t.csat_rating) filter (where t.resolved_at::date between p_from and p_to), 2))
      from public.support_tickets t where t.assigned_agent_id = a.id),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'action', l.action, 'entity_type', l.entity_type, 'entity_id', l.entity_id,
        'details', l.details, 'at', l.created_at) order by l.created_at desc)
        from (select * from public.support_audit_logs where company_id = v_company and actor_user_id = auth.uid() order by created_at desc limit 50) l), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Settings: tags, SLA policies, automation rules, knowledge base
-- -----------------------------------------------------------------------------
create or replace function public.support_tag_save(p_id uuid, p_name text, p_color text default 'neutral')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id uuid;
begin
  if v_name is null or length(v_name) > 40 then
    raise exception 'Enter a tag name of up to 40 characters.' using errcode = 'P0001';
  end if;
  if coalesce(p_color, 'neutral') not in ('neutral', 'info', 'success', 'warning', 'danger', 'outsourced') then
    raise exception 'Unknown tag colour.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.support_tags where company_id = v_company and lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A tag named % already exists.', v_name using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_tags (company_id, name, color, created_by, updated_by) values (v_company, v_name, coalesce(p_color, 'neutral'), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_tags set name = v_name, color = coalesce(p_color, color), updated_by = auth.uid() where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Tag not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.support_tag_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
begin
  if exists (select 1 from public.support_conversation_tags where tag_id = p_id) then
    raise exception 'This tag is used on conversations; remove it from them first.' using errcode = 'P0001';
  end if;
  delete from public.support_tags where id = p_id and company_id = v_company;
  if not found then
    raise exception 'Tag not found in your company.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.support_sla_policy_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_name text := private.support_text(p, 'name', 120);
  v_priority text := upper(nullif(p ->> 'priority', ''));
  v_first integer := nullif(p ->> 'first_response_minutes', '')::integer;
  v_res integer := nullif(p ->> 'resolution_minutes', '')::integer;
  v_active boolean := coalesce((p ->> 'is_active')::boolean, true);
  v_id uuid;
begin
  if v_name is null then
    raise exception 'Enter a policy name.' using errcode = 'P0001';
  end if;
  if v_priority is not null and v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be low, normal, high or urgent (or empty for the default policy).' using errcode = 'P0001';
  end if;
  if v_first is null or v_res is null or v_first < 1 or v_res < 1 then
    raise exception 'Enter the first-response and resolution targets in minutes.' using errcode = 'P0001';
  end if;
  if v_first > v_res then
    raise exception 'The first-response target cannot be longer than the resolution target.' using errcode = 'P0001';
  end if;
  if v_active and exists (select 1 from public.support_sla_policies where company_id = v_company and is_active and priority is not distinct from v_priority and id is distinct from p_id) then
    raise exception 'An active policy for % already exists.', coalesce(initcap(lower(v_priority)), 'the default') using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_sla_policies (company_id, name, priority, first_response_minutes, resolution_minutes, is_active, created_by, updated_by)
    values (v_company, v_name, v_priority, v_first, v_res, v_active, auth.uid(), auth.uid()) returning id into v_id;
  else
    update public.support_sla_policies set name = v_name, priority = v_priority, first_response_minutes = v_first, resolution_minutes = v_res, is_active = v_active,
      updated_by = auth.uid() where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Policy not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  -- Existing tickets keep the targets they were given; new tickets use the new policy.
  return v_id;
end;
$$;

create or replace function public.support_automation_rule_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_name text := private.support_text(p, 'name', 120);
  v_trigger text := upper(coalesce(p ->> 'trigger', ''));
  v_c jsonb := coalesce(p -> 'conditions', '{}'::jsonb);
  v_a jsonb := coalesce(p -> 'actions', '{}'::jsonb);
  v_id uuid;
  k text;
begin
  if v_name is null then
    raise exception 'Enter a rule name.' using errcode = 'P0001';
  end if;
  if v_trigger not in ('TICKET_CREATED', 'CONVERSATION_CREATED') then
    raise exception 'Choose when the rule runs: ticket created or conversation created.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_c) <> 'object' or jsonb_typeof(v_a) <> 'object' then
    raise exception 'Conditions and actions must be objects.' using errcode = 'P0001';
  end if;
  for k in select jsonb_object_keys(v_c) loop
    if k not in ('channel', 'priority', 'category', 'subject_contains') then
      raise exception 'Unknown condition %.', k using errcode = 'P0001';
    end if;
  end loop;
  -- Drop empty values.
  v_c := coalesce((select jsonb_object_agg(key, value) from jsonb_each(v_c) where nullif(btrim(value #>> '{}'), '') is not null), '{}'::jsonb);
  v_a := coalesce((select jsonb_object_agg(key, value) from jsonb_each(v_a) where nullif(btrim(value #>> '{}'), '') is not null), '{}'::jsonb);
  for k in select jsonb_object_keys(v_a) loop
    if k not in ('set_priority', 'set_department', 'assign_agent_id', 'add_tag_id') then
      raise exception 'Unknown action %.', k using errcode = 'P0001';
    end if;
  end loop;
  if v_a = '{}'::jsonb then
    raise exception 'Choose at least one action.' using errcode = 'P0001';
  end if;
  if v_c ? 'channel' and v_c ->> 'channel' not in ('PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL') then
    raise exception 'Unknown channel condition.' using errcode = 'P0001';
  end if;
  if (v_c ? 'priority' and v_c ->> 'priority' not in ('LOW', 'NORMAL', 'HIGH', 'URGENT'))
     or (v_a ? 'set_priority' and v_a ->> 'set_priority' not in ('LOW', 'NORMAL', 'HIGH', 'URGENT')) then
    raise exception 'Priority must be low, normal, high or urgent.' using errcode = 'P0001';
  end if;
  if v_a ? 'assign_agent_id' then
    perform private.support_agent_of(v_company, (v_a ->> 'assign_agent_id')::uuid);
  end if;
  if v_a ? 'add_tag_id' and not exists (select 1 from public.support_tags where id = (v_a ->> 'add_tag_id')::uuid and company_id = v_company) then
    raise exception 'Tag not found in your company.' using errcode = 'P0001';
  end if;
  if v_a ? 'add_tag_id' and v_trigger <> 'CONVERSATION_CREATED' then
    raise exception 'Tags are added to conversations: use the conversation-created trigger.' using errcode = 'P0001';
  end if;
  if v_a ? 'set_department' and v_trigger <> 'TICKET_CREATED' then
    raise exception 'Departments are set on tickets: use the ticket-created trigger.' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_automation_rules (company_id, name, trigger, conditions, actions, run_order, is_active, created_by, updated_by)
    values (v_company, v_name, v_trigger, v_c, v_a, coalesce(nullif(p ->> 'run_order', '')::integer, 100), coalesce((p ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_automation_rules set name = v_name, trigger = v_trigger, conditions = v_c, actions = v_a,
      run_order = coalesce(nullif(p ->> 'run_order', '')::integer, run_order), is_active = coalesce((p ->> 'is_active')::boolean, is_active), updated_by = auth.uid()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Rule not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.support_kb_article_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_title text := private.support_text(p, 'title', 200);
  v_body text := private.support_text(p, 'body', 50000);
  v_status text := upper(coalesce(nullif(p ->> 'status', ''), 'DRAFT'));
  v_tags text[] := coalesce(array(select distinct lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> 'tags', '[]'::jsonb)) x where btrim(x) <> ''), '{}');
  v_id uuid;
begin
  if v_title is null or length(v_title) < 3 then
    raise exception 'Enter a title (at least 3 characters).' using errcode = 'P0001';
  end if;
  if v_body is null then
    raise exception 'Enter the article text.' using errcode = 'P0001';
  end if;
  if v_status not in ('DRAFT', 'PUBLISHED', 'ARCHIVED') then
    raise exception 'Status must be draft, published or archived.' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_kb_articles (company_id, title, body, category, tags, status, created_by, updated_by)
    values (v_company, v_title, v_body, private.support_text(p, 'category', 80), v_tags, v_status, auth.uid(), auth.uid()) returning id into v_id;
  else
    update public.support_kb_articles set title = v_title, body = v_body, category = private.support_text(p, 'category', 80), tags = v_tags, status = v_status,
      updated_by = auth.uid() where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Article not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Overview and reports
-- -----------------------------------------------------------------------------
-- Satisfaction ratings recorded in a period: the latest rating of each ticket rated in it.
create or replace function private.support_csat(p_company uuid, p_from date, p_to date)
returns table (ticket_id uuid, r integer)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (e.ticket_id) e.ticket_id, e.to_value::integer
  from public.support_ticket_events e
  where e.company_id = p_company and e.event_type = 'CSAT_RECORDED' and e.to_value is not null
    and (e.created_at at time zone private.company_tz(p_company))::date between p_from and p_to
  order by e.ticket_id, e.created_at desc, e.id desc;
$$;
revoke all on function private.support_csat(uuid, date, date) from public, anon, authenticated;

create or replace function public.support_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_today date := private.company_today(v_company);
  v_tz text := private.company_tz(v_company);
  v_reports boolean := private.has_permission(v_company, 'support.view_reports');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  return (
    with t as (select x.*, private.support_sla_status(x) as sla, (x.created_at at time zone v_tz)::date as cday,
                 (x.resolved_at at time zone v_tz)::date as rday from public.support_tickets x where x.company_id = v_company),
    m as (select x.*, (x.occurred_at at time zone v_tz)::date as day from public.support_messages x where x.company_id = v_company),
    c as (select x.*, (x.created_at at time zone v_tz)::date as day from public.support_conversations x where x.company_id = v_company)
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'today', v_today, 'generated_at', now(),
      'kpis', jsonb_build_object(
        'total_tickets', (select count(*) from t where cday between p_from and p_to),
        'open_tickets', (select count(*) from t where status not in ('RESOLVED', 'CLOSED')),
        'unassigned_tickets', (select count(*) from t where status not in ('RESOLVED', 'CLOSED') and assigned_agent_id is null),
        'pending_customer', (select count(*) from t where status = 'WAITING_CUSTOMER'),
        'resolved_tickets', (select count(*) from t where rday between p_from and p_to),
        'overdue_tickets', (select count(*) from t where sla = 'OVERDUE'),
        'calls_today', (select count(*) from m where kind = 'CALL' and direction = 'INBOUND' and day = v_today),
        'missed_calls', (select count(*) from m where kind = 'CALL' and direction = 'INBOUND' and call_status = 'MISSED' and day between p_from and p_to),
        'whatsapp_conversations', (select count(*) from c where channel = 'WHATSAPP' and day between p_from and p_to),
        'incoming_emails', (select count(*) from m where kind = 'EMAIL' and direction = 'INBOUND' and day between p_from and p_to),
        'avg_first_response_minutes', (select round(avg(extract(epoch from first_response_at - created_at) / 60)) from t where cday between p_from and p_to and first_response_at is not null),
        'avg_resolution_minutes', (select round(avg(extract(epoch from resolved_at - created_at) / 60)) from t where rday between p_from and p_to),
        'csat_average', (select round(avg(r), 2) from private.support_csat(v_company, p_from, p_to)),
        'csat_responses', (select count(*) from private.support_csat(v_company, p_from, p_to))),
      'by_channel', coalesce((select jsonb_agg(jsonb_build_object('channel', channel, 'tickets', n) order by n desc, channel) from (
          select channel, count(*) n from t where cday between p_from and p_to group by channel) x), '[]'::jsonb),
      'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'tickets', n) order by status) from (
          select status, count(*) n from t where cday between p_from and p_to group by status) x), '[]'::jsonb),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'created', (select count(*) from t where cday = d), 'resolved', (select count(*) from t where rday = d)) order by d)
          from generate_series(p_from, p_to, interval '1 day') g(dd) cross join lateral (select g.dd::date as d) y where p_to - p_from <= 366), '[]'::jsonb),
      'sla', jsonb_build_object(
          'met', (select count(*) from t where rday between p_from and p_to and sla = 'MET'),
          'breached', (select count(*) from t where rday between p_from and p_to and sla = 'BREACHED'),
          'no_sla', (select count(*) from t where rday between p_from and p_to and sla = 'NO_SLA')),
      'resolution_buckets', coalesce((select jsonb_agg(jsonb_build_object('bucket', b, 'tickets', n) order by o) from (
          select b, o, count(*) n from (
            select case when mins < 60 then 'Under 1 hour' when mins < 240 then '1–4 hours' when mins < 1440 then '4–24 hours'
                        when mins < 4320 then '1–3 days' else 'Over 3 days' end b,
                   case when mins < 60 then 1 when mins < 240 then 2 when mins < 1440 then 3 when mins < 4320 then 4 else 5 end o
            from (select extract(epoch from resolved_at - created_at) / 60 mins from t where rday between p_from and p_to) r) q group by b, o) x), '[]'::jsonb),
      'agents', case when v_reports then coalesce((select jsonb_agg(r order by r ->> 'name') from (
          select jsonb_build_object('agent_id', a.id, 'name', a.display_name, 'presence', a.presence, 'is_active', a.is_active,
            'assigned_open', (select count(*) from t where assigned_agent_id = a.id and status not in ('RESOLVED', 'CLOSED')),
            'resolved', (select count(*) from t where assigned_agent_id = a.id and rday between p_from and p_to),
            'avg_resolution_minutes', (select round(avg(extract(epoch from resolved_at - created_at) / 60)) from t where assigned_agent_id = a.id and rday between p_from and p_to),
            'sla_met', (select count(*) from t where assigned_agent_id = a.id and rday between p_from and p_to and sla = 'MET'),
            'sla_breached', (select count(*) from t where assigned_agent_id = a.id and rday between p_from and p_to and sla = 'BREACHED'),
            'open_conversations', (select count(*) from c where assigned_agent_id = a.id and status <> 'RESOLVED')) r
          from public.support_agents a where a.company_id = v_company) z), '[]'::jsonb) else null end,
      'channels', public.support_channel_status())
  );
end;
$$;

create or replace function public.support_reports(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view_reports');
  v_tz text := private.company_tz(v_company);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  return public.support_overview(p_from, p_to) || (
    with t as (select x.*, private.support_sla_status(x) as sla, (x.created_at at time zone v_tz)::date as cday from public.support_tickets x where x.company_id = v_company),
    m as (select x.*, (x.occurred_at at time zone v_tz)::date as day from public.support_messages x where x.company_id = v_company)
    select jsonb_build_object(
      'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', k, 'tickets', n) order by n desc, k) from (
          select coalesce(category, 'Uncategorised') k, count(*) n from t where cday between p_from and p_to group by 1) x), '[]'::jsonb),
      'by_priority', coalesce((select jsonb_agg(jsonb_build_object('priority', priority, 'tickets', n) order by priority) from (
          select priority, count(*) n from t where cday between p_from and p_to group by 1) x), '[]'::jsonb),
      'calls', jsonb_build_object(
          'inbound', (select count(*) from m where kind = 'CALL' and direction = 'INBOUND' and day between p_from and p_to),
          'outbound', (select count(*) from m where kind = 'CALL' and direction = 'OUTBOUND' and day between p_from and p_to),
          'answered', (select count(*) from m where kind = 'CALL' and call_status = 'ANSWERED' and day between p_from and p_to),
          'missed', (select count(*) from m where kind = 'CALL' and call_status = 'MISSED' and day between p_from and p_to),
          'avg_duration_seconds', (select round(avg(call_duration_seconds)) from m where kind = 'CALL' and call_status = 'ANSWERED' and day between p_from and p_to)),
      'messages', jsonb_build_object(
          'whatsapp_inbound', (select count(*) from m where kind = 'MESSAGE' and direction = 'INBOUND' and day between p_from and p_to),
          'whatsapp_outbound', (select count(*) from m where kind = 'MESSAGE' and direction = 'OUTBOUND' and day between p_from and p_to),
          'email_inbound', (select count(*) from m where kind = 'EMAIL' and direction = 'INBOUND' and day between p_from and p_to),
          'email_outbound', (select count(*) from m where kind = 'EMAIL' and direction = 'OUTBOUND' and day between p_from and p_to)),
      'csat', coalesce((select jsonb_agg(jsonb_build_object('rating', r, 'tickets', n) order by r) from (
          select r, count(*) n from private.support_csat(v_company, p_from, p_to) group by 1) x), '[]'::jsonb),
      'reopened', (select count(*) from t where reopen_count > 0 and cday between p_from and p_to))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. Grants on the functions
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'support\_%' loop
    execute format('revoke all on function %s from public, anon', f);
    if f not like 'support_record_integration_health%' then
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end;
$$;
revoke all on function public.support_record_integration_health(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.support_record_integration_health(uuid, text, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 15. Attachments storage (private bucket; company folder; sensitive files need support.manage_tickets)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 26214400, null)
on conflict (id) do nothing;

create or replace function private.support_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.support_attachments a
    where a.storage_path = p_name
      and private.has_permission(a.company_id, 'support.view')
      and (not a.is_sensitive or private.has_permission(a.company_id, 'support.manage_tickets')));
$$;

create or replace function private.support_object_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_company_id() is not null
    and split_part(p_name, '/', 1) = private.current_company_id()::text
    and private.has_permission(private.current_company_id(), 'support.reply');
$$;

revoke all on function private.support_object_readable(text), private.support_object_writable(text) from public, anon;
grant execute on function private.support_object_readable(text), private.support_object_writable(text) to authenticated;

drop policy if exists support_attachments_objects_select on storage.objects;
create policy support_attachments_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'support-attachments' and private.support_object_readable(name));
drop policy if exists support_attachments_objects_insert on storage.objects;
create policy support_attachments_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'support-attachments' and private.support_object_writable(name));
-- No update or delete policies: uploaded files are immutable through the API.

-- -----------------------------------------------------------------------------
-- 16. ERP reset allowlist (copied from 20261208090000 plus the support tables, children first)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
