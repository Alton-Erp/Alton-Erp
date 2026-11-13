-- =============================================================================
-- Google Workspace Gmail for the Support Centre (shared support mailbox)
--
-- Additive; builds on 20261210090000_support_centre and 20261211090000_acefone_telephony.
--
--   * Gmail API with server-side OAuth 2.0 (Edge Functions google-oauth-start / google-oauth-callback).
--     The OAuth client secret, the token-encryption key and the Pub/Sub push token live ONLY in Edge
--     Function secrets. The refresh token is encrypted (AES-256-GCM) by the Edge Function before it
--     reaches the database; support_email_credentials holds only ciphertext and is readable by the
--     service role alone. Access tokens are never stored.
--   * OAuth state: a random value whose SHA-256 hash is stored, single use, 10 minutes, created by an
--     administrator (support.manage_integrations). The plaintext state is never stored.
--   * Incoming mail: Pub/Sub push (google-gmail-webhook) and a scheduled reconciliation
--     (google-gmail-sync) read the mailbox history and fetch every message from the Gmail API;
--     support_gmail_ingest stores each Gmail message once (unique Gmail message id), threads it by
--     Gmail thread id or In-Reply-To / References, and links a customer only on exactly one match.
--   * Sending (google-gmail-send): support_gmail_send_prepare records the email as PENDING; it becomes
--     SENT only when Gmail returns the sent message id, FAILED when Gmail refuses it, and stays PENDING
--     when the outcome is unknown (the next sync confirms it by its Message-ID).
--   * Sanitised HTML only: the Edge Function sanitises HTML before it is stored; the app shows it in a
--     sandboxed frame without scripts or remote content.
--
-- Rollback: supabase/rollback/20261212090000_gmail_support_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Integration event log: Gmail event types
-- -----------------------------------------------------------------------------
alter table public.support_integration_events drop constraint if exists support_integration_events_event_type_check;
alter table public.support_integration_events add constraint support_integration_events_event_type_check
  check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR', 'CLICK_TO_CALL', 'CDR_SYNC', 'RECORDING_SYNC', 'REPLAY',
                         'DISCONNECTED', 'REJECTED', 'OAUTH', 'MAIL_SYNC', 'WATCH', 'SEND'));

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_email_config (
  company_id              uuid primary key references public.companies (id) on delete restrict,
  channel_account_id      uuid not null,
  provider                text not null default 'GOOGLE_WORKSPACE' check (provider = 'GOOGLE_WORKSPACE'),
  -- The shared support mailbox to connect (e.g. support@company.com). Signing in with another account is refused.
  mailbox_address         text not null check (mailbox_address ~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' and length(mailbox_address) <= 254),
  display_name            text check (display_name is null or length(btrim(display_name)) between 1 and 120),
  signature               text check (signature is null or length(signature) <= 2000),
  -- Pub/Sub topic for push notifications: projects/<project>/topics/<topic>. Empty = scheduled sync only.
  pubsub_topic            text check (pubsub_topic is null or pubsub_topic ~ '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/topics/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$'),
  push_enabled            boolean not null default false,
  -- gmail.modify is requested only when this is on (mirror "read" to the mailbox).
  mailbox_modify_enabled  boolean not null default false,
  initial_sync_days       integer not null default 7 check (initial_sync_days between 1 and 30),
  max_attachment_mb       integer not null default 10 check (max_attachment_mb between 1 and 25),
  connected_address       text check (connected_address is null or length(connected_address) <= 254),
  granted_scopes          text[] not null default '{}',
  last_history_id         text check (last_history_id is null or last_history_id ~ '^[0-9]{1,20}$'),
  watch_expiration        timestamptz,
  watch_renewed_at        timestamptz,
  watch_status            text check (watch_status is null or length(watch_status) <= 500),
  last_push_at            timestamptz,
  last_sync_at            timestamptz,
  last_sync_status        text check (last_sync_status is null or length(last_sync_status) <= 500),
  last_full_sync_at       timestamptz,
  is_enabled              boolean not null default false,
  connected_at            timestamptz,
  connected_by            uuid,
  disconnected_at         timestamptz,
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint support_email_config_account_unique unique (channel_account_id),
  constraint support_email_config_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_email_config_push check (not push_enabled or pubsub_topic is not null)
);

-- Encrypted OAuth refresh token (AES-256-GCM, encrypted and decrypted only in the Edge Functions).
-- No app access at all: RLS on, no policies, no grants to anon / authenticated, never audited.
create table if not exists public.support_email_credentials (
  company_id                uuid primary key references public.companies (id) on delete restrict,
  channel_account_id        uuid not null,
  refresh_token_ciphertext  text not null check (length(refresh_token_ciphertext) between 24 and 8192 and refresh_token_ciphertext ~ '^[A-Za-z0-9+/=_-]+$'
                                                   -- A Google refresh token starts with 1//: refuse anything that looks like plaintext.
                                                   and refresh_token_ciphertext !~ '^1//'),
  iv                        text not null check (iv ~ '^[A-Za-z0-9+/=_-]{12,32}$'),
  key_version               integer not null default 1 check (key_version between 1 and 1000),
  stored_at                 timestamptz not null default now(),
  constraint support_email_credentials_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);

create table if not exists public.support_oauth_states (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  channel_account_id  uuid not null,
  -- SHA-256 (hex) of the random state; the state itself is never stored.
  state_hash          text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  scopes              text[] not null,
  created_by          uuid not null,
  expires_at          timestamptz not null,
  used_at             timestamptz,
  outcome             text check (outcome is null or length(outcome) <= 200),
  created_at          timestamptz not null default now(),
  constraint support_oauth_states_hash_unique unique (state_hash),
  constraint support_oauth_states_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict
);
create index if not exists support_oauth_states_user_idx on public.support_oauth_states (created_by, created_at desc);

create table if not exists public.support_email_templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 120),
  subject     text check (subject is null or length(subject) <= 300),
  body        text not null check (length(btrim(body)) between 1 and 20000),
  -- Only approved (active) templates can be used by agents.
  is_active   boolean not null default true,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint support_email_templates_id_company_unique unique (id, company_id)
);
create unique index if not exists support_email_templates_name_unique on public.support_email_templates (company_id, lower(name));

-- One row per email (1:1 with the support_messages row that carries it on the timeline).
create table if not exists public.support_email_messages (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  message_id          uuid not null,
  conversation_id     uuid not null,
  channel_account_id  uuid not null,
  direction           text not null check (direction in ('INBOUND', 'OUTBOUND')),
  gmail_message_id    text check (gmail_message_id is null or gmail_message_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  gmail_thread_id     text check (gmail_thread_id is null or gmail_thread_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  rfc_message_id      text check (rfc_message_id is null or length(rfc_message_id) <= 998),
  in_reply_to         text check (in_reply_to is null or length(in_reply_to) <= 998),
  references_header   text check (references_header is null or length(references_header) <= 8000),
  from_address        text check (from_address is null or length(from_address) <= 320),
  from_name           text check (from_name is null or length(from_name) <= 200),
  to_addresses        jsonb not null default '[]'::jsonb check (jsonb_typeof(to_addresses) = 'array'),
  cc_addresses        jsonb not null default '[]'::jsonb check (jsonb_typeof(cc_addresses) = 'array'),
  bcc_addresses       jsonb not null default '[]'::jsonb check (jsonb_typeof(bcc_addresses) = 'array'),
  reply_to_address    text check (reply_to_address is null or length(reply_to_address) <= 320),
  subject             text check (subject is null or length(subject) <= 998),
  body_text           text check (body_text is null or length(body_text) <= 500000),
  -- Sanitised by the Edge Function before it is stored; shown only in a sandboxed frame.
  body_html           text check (body_html is null or length(body_html) <= 1000000),
  html_truncated      boolean not null default false,
  label_ids           text[] not null default '{}',
  -- MIME structure summary (part ids, types, sizes, file names); never the content.
  mime                jsonb not null default '{}'::jsonb,
  -- Attachment parts and what happened to each: PENDING, STORED, BLOCKED, TOO_LARGE, FAILED.
  attachment_parts    jsonb not null default '[]'::jsonb check (jsonb_typeof(attachment_parts) = 'array'),
  internal_date       timestamptz,
  size_estimate       integer check (size_estimate is null or size_estimate >= 0),
  -- Outbound sends from the ERP: PENDING until Gmail confirms (SENT) or refuses (FAILED).
  send_state          text check (send_state is null or send_state in ('PENDING', 'SENT', 'FAILED')),
  send_error          text check (send_error is null or length(send_error) <= 500),
  send_http           integer,
  send_attempts       integer not null default 0,
  idempotency_key     text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9-]{16,64}$'),
  template_id         uuid,
  reply_to_email_id   uuid,
  -- Set when the mailbox sync stored Gmail's copy of an ERP-sent email before Gmail's answer arrived.
  duplicate_of        uuid,
  requested_by        uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint support_email_messages_message_unique unique (message_id),
  constraint support_email_messages_message_fk foreign key (message_id, company_id) references public.support_messages (id, company_id) on delete restrict,
  constraint support_email_messages_conversation_fk foreign key (conversation_id, company_id) references public.support_conversations (id, company_id) on delete restrict,
  constraint support_email_messages_account_fk foreign key (channel_account_id, company_id) references public.support_channel_accounts (id, company_id) on delete restrict,
  constraint support_email_messages_template_fk foreign key (template_id, company_id) references public.support_email_templates (id, company_id) on delete restrict,
  constraint support_email_messages_inbound_state check (direction = 'OUTBOUND' or send_state is null),
  constraint support_email_messages_sent_has_id check (send_state is distinct from 'SENT' or gmail_message_id is not null or duplicate_of is not null)
);
create unique index if not exists support_email_messages_gmail_unique on public.support_email_messages (company_id, gmail_message_id) where gmail_message_id is not null;
create unique index if not exists support_email_messages_idem_unique on public.support_email_messages (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists support_email_messages_rfc_idx on public.support_email_messages (company_id, rfc_message_id);
create index if not exists support_email_messages_conversation_idx on public.support_email_messages (conversation_id, internal_date);
create index if not exists support_email_messages_pending_idx on public.support_email_messages (company_id, send_state) where send_state = 'PENDING';

-- Email attachment details on the existing attachment table.
alter table public.support_attachments add column if not exists email_part_id text check (email_part_id is null or length(email_part_id) <= 50);
alter table public.support_attachments add column if not exists email_content_id text check (email_content_id is null or length(email_content_id) <= 250);
alter table public.support_attachments add column if not exists email_inline boolean not null default false;

-- RLS: settings, templates and emails are read by permission; credentials and OAuth states are never readable by the app.
do $$
declare
  t text;
begin
  foreach t in array array['support_email_config', 'support_email_credentials', 'support_oauth_states', 'support_email_templates', 'support_email_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end;
$$;
grant select on public.support_email_config, public.support_email_templates, public.support_email_messages to authenticated;
drop policy if exists support_email_config_select on public.support_email_config;
create policy support_email_config_select on public.support_email_config for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_email_templates_select on public.support_email_templates;
create policy support_email_templates_select on public.support_email_templates for select to authenticated using (private.has_permission(company_id, 'support.view'));
drop policy if exists support_email_messages_select on public.support_email_messages;
create policy support_email_messages_select on public.support_email_messages for select to authenticated using (private.has_permission(company_id, 'support.view'));

do $$
declare
  t text;
begin
  foreach t in array array['support_email_config', 'support_email_templates', 'support_email_messages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
  -- Settings and templates are audited (field names and safe values only). Credentials never are.
  foreach t in array array['support_email_config', 'support_email_templates'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Helpers
-- -----------------------------------------------------------------------------
create or replace function private.support_gmail_scopes(p_modify boolean)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
         || case when p_modify then array['https://www.googleapis.com/auth/gmail.modify'] else array[]::text[] end;
$$;

-- Address list from the app: array of strings or {email, name}. Returns [{email, name}] with normalised emails.
create or replace function private.support_email_list(p jsonb, p_label text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := '[]'::jsonb;
  e jsonb;
  v_email text;
  v_name text;
begin
  if p is null or jsonb_typeof(p) = 'null' then
    return v;
  end if;
  if jsonb_typeof(p) <> 'array' then
    raise exception '% must be a list of email addresses.', p_label using errcode = 'P0001';
  end if;
  for e in select * from jsonb_array_elements(p) loop
    v_email := private.support_normalize_email(case when jsonb_typeof(e) = 'string' then e #>> '{}' else e ->> 'email' end);
    v_name := case when jsonb_typeof(e) = 'object' then nullif(btrim(regexp_replace(coalesce(e ->> 'name', ''), '[\r\n<>"]', '', 'g')), '') end;
    if v_email is null or length(v_email) > 254 then
      raise exception '% contains an invalid email address: %', p_label, left(coalesce(case when jsonb_typeof(e) = 'string' then e #>> '{}' else e ->> 'email' end, ''), 80)
        using errcode = 'P0001';
    end if;
    if not v @> jsonb_build_array(jsonb_build_object('email', v_email)) then
      v := v || jsonb_build_array(jsonb_build_object('email', v_email, 'name', left(v_name, 120)));
    end if;
  end loop;
  return v;
end;
$$;

-- Subject without leading Re: / Fwd: prefixes (for "Re: <subject>").
create or replace function private.support_email_base_subject(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p, ''), '^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+', '', 'i')), '');
$$;

-- The last 20 Message-IDs of a References header plus the replied message (RFC 5322 threading).
create or replace function private.support_email_references(p_refs text, p_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(array_to_string((select array_agg(x order by o) from (
      select x, o from unnest(regexp_split_to_array(btrim(coalesce(p_refs, '') || ' ' || coalesce(p_id, '')), '\s+')) with ordinality as u (x, o)
      where x ~ '^<[^<>\s]+>$' order by o desc limit 20) z), ' '), 8000), '');
$$;

create or replace function private.support_gmail_event(p_company uuid, p_account uuid, p_type text, p_message text, p_details jsonb, p_result text default null,
  p_error text default null, p_key text default null, p_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.support_integration_events (company_id, channel_account_id, event_type, message, details, processing_result, processing_error, event_key, processed_at, created_by)
  values (p_company, p_account, p_type, left(p_message, 1000), coalesce(p_details, '{}'::jsonb), p_result, left(p_error, 1000), p_key,
          case when p_result is not null then now() end, p_by)
  on conflict (company_id, event_key) where event_key is not null do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Health changes only on a real transition (no event per sync run).
create or replace function private.support_gmail_health(p_account uuid, p_status text, p_detail text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.support_channel_accounts where id = p_account and (status <> p_status or status_detail is distinct from left(p_detail, 500))) then
    perform public.support_record_integration_health(p_account, p_status, p_detail);
  end if;
end;
$$;

revoke all on function private.support_gmail_scopes(boolean), private.support_email_list(jsonb, text), private.support_email_base_subject(text),
  private.support_email_references(text, text), private.support_gmail_event(uuid, uuid, text, text, jsonb, text, text, text, uuid),
  private.support_gmail_health(uuid, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Settings (support.manage_integrations) and templates (support.manage_settings)
-- -----------------------------------------------------------------------------
create or replace function public.support_email_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_email_config;
begin
  select * into c from public.support_email_config where company_id = v_company;
  return jsonb_build_object(
    'config', case when c.company_id is null then null else to_jsonb(c) - 'company_id' - 'created_by' - 'updated_by' end,
    'account', (select jsonb_build_object('id', a.id, 'status', a.status, 'status_detail', a.status_detail, 'last_checked_at', a.last_checked_at, 'connected_at', a.connected_at)
                from public.support_channel_accounts a where a.id = c.channel_account_id),
    'has_credentials', exists (select 1 from public.support_email_credentials where company_id = v_company),
    'requested_scopes', to_jsonb(private.support_gmail_scopes(coalesce(c.mailbox_modify_enabled, false))),
    'counts', jsonb_build_object(
      'received', (select count(*) from public.support_email_messages where company_id = v_company and direction = 'INBOUND'),
      'sent', (select count(*) from public.support_email_messages where company_id = v_company and send_state = 'SENT'),
      'pending', (select count(*) from public.support_email_messages where company_id = v_company and send_state = 'PENDING'),
      'failed', (select count(*) from public.support_email_messages where company_id = v_company and send_state = 'FAILED')),
    'events', coalesce((select jsonb_agg(e order by e ->> 'created_at' desc) from (
                select jsonb_build_object('id', e.id, 'event_type', e.event_type, 'status', e.status, 'message', e.message, 'processing_result', e.processing_result,
                  'processing_error', e.processing_error, 'replay_count', e.replay_count, 'created_at', e.created_at, 'history_id', e.details ->> 'history_id') e
                from public.support_integration_events e
                where e.company_id = v_company and e.channel_account_id = c.channel_account_id order by e.created_at desc limit 50) z), '[]'::jsonb));
end;
$$;

create or replace function public.support_email_config_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  v_mailbox text := private.support_normalize_email(p ->> 'mailbox_address');
  v_topic text := nullif(btrim(coalesce(p ->> 'pubsub_topic', '')), '');
  v_push boolean := coalesce((p ->> 'push_enabled')::boolean, false);
  v_modify boolean := coalesce((p ->> 'mailbox_modify_enabled')::boolean, false);
  v_days integer := coalesce(nullif(p ->> 'initial_sync_days', '')::integer, 7);
  v_mb integer := coalesce(nullif(p ->> 'max_attachment_mb', '')::integer, 10);
  c public.support_email_config;
  v_account uuid;
  v_status text;
begin
  if p ?| array['client_secret', 'refresh_token', 'access_token', 'token', 'password', 'status', 'connected_address', 'granted_scopes', 'is_enabled'] then
    raise exception 'Passwords, tokens and secrets are never saved here, and the connection status is set by the server. Use Connect Google Workspace.' using errcode = 'P0001';
  end if;
  if v_mailbox is null then
    raise exception 'Enter the shared support mailbox address (e.g. support@yourcompany.com).' using errcode = 'P0001';
  end if;
  if v_push and v_topic is null then
    raise exception 'Enter the Pub/Sub topic (projects/<project>/topics/<topic>) to use push notifications.' using errcode = 'P0001';
  end if;
  if v_topic is not null and v_topic !~ '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/topics/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$' then
    raise exception 'The Pub/Sub topic must look like projects/<project-id>/topics/<topic-name>.' using errcode = 'P0001';
  end if;
  if v_days not between 1 and 30 or v_mb not between 1 and 25 then
    raise exception 'First sync: 1 to 30 days; attachments: 1 to 25 MB.' using errcode = 'P0001';
  end if;
  select * into c from public.support_email_config where company_id = v_company for update;
  if found then
    if c.is_enabled and c.mailbox_address <> v_mailbox then
      raise exception 'Disconnect the mailbox before changing its address.' using errcode = 'P0001';
    end if;
    if c.is_enabled and v_modify and not c.mailbox_modify_enabled then
      v_status := 'REAUTHORIZATION_REQUIRED';
    end if;
    update public.support_email_config set mailbox_address = v_mailbox, display_name = private.support_text(p, 'display_name', 120),
      signature = private.support_text(p, 'signature', 2000), pubsub_topic = v_topic, push_enabled = v_push, mailbox_modify_enabled = v_modify,
      initial_sync_days = v_days, max_attachment_mb = v_mb, updated_by = auth.uid()
    where company_id = v_company;
    update public.support_channel_accounts set identifier = v_mailbox, updated_by = auth.uid() where id = c.channel_account_id and identifier is distinct from v_mailbox;
    v_account := c.channel_account_id;
    if v_status is not null then
      -- Turning on mailbox changes needs gmail.modify: the administrator must grant it.
      perform public.support_record_integration_health(v_account, v_status, 'Reconnect Google Workspace to grant the gmail.modify permission.');
    end if;
  else
    insert into public.support_channel_accounts (company_id, channel, display_name, identifier, provider, credentials_ref, status, status_detail, is_active, created_by, updated_by)
    values (v_company, 'EMAIL', 'Support mailbox (Gmail)', v_mailbox, 'Google Workspace (Gmail API)', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SETUP_REQUIRED',
            'Not connected yet: use Connect Google Workspace.', true, auth.uid(), auth.uid())
    returning id into v_account;
    insert into public.support_email_config (company_id, channel_account_id, mailbox_address, display_name, signature, pubsub_topic, push_enabled,
      mailbox_modify_enabled, initial_sync_days, max_attachment_mb, created_by, updated_by)
    values (v_company, v_account, v_mailbox, private.support_text(p, 'display_name', 120), private.support_text(p, 'signature', 2000), v_topic, v_push,
      v_modify, v_days, v_mb, auth.uid(), auth.uid());
    perform private.support_gmail_event(v_company, v_account, 'ACCOUNT_CREATED', 'Email settings saved; not connected until Google Workspace is authorised.', '{}'::jsonb,
      null, null, null, auth.uid());
  end if;
  return public.support_email_config_get();
end;
$$;

-- For the Edge Functions: the caller's company and email account when the caller manages integrations.
create or replace function public.support_email_admin_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
begin
  return (select jsonb_build_object('company_id', c.company_id, 'account_id', c.channel_account_id, 'user_id', auth.uid())
          from public.support_email_config c where c.company_id = v_company);
end;
$$;

create or replace function public.support_email_template_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_name text := private.support_text(p, 'name', 120);
  v_body text := private.support_text(p, 'body', 20000);
  v_id uuid;
begin
  if v_name is null or v_body is null then
    raise exception 'Enter the template name and text.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.support_email_templates where company_id = v_company and lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A template named "%" already exists.', v_name using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_email_templates (company_id, name, subject, body, is_active, created_by, updated_by)
    values (v_company, v_name, private.support_text(p, 'subject', 300), v_body, coalesce((p ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.support_email_templates set name = v_name, subject = private.support_text(p, 'subject', 300), body = v_body,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active), updated_by = auth.uid()
    where id = p_id and company_id = v_company returning id into v_id;
    if v_id is null then
      raise exception 'Template not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

-- What the compose dialog needs: the connected mailbox, the signature and the approved templates.
create or replace function public.support_email_compose_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_email_config;
begin
  select * into c from public.support_email_config where company_id = v_company;
  return jsonb_build_object(
    'configured', c.company_id is not null,
    'status', private.support_channel_health(v_company, 'EMAIL'),
    'can_send', c.is_enabled and coalesce((select status = 'CONNECTED' from public.support_channel_accounts where id = c.channel_account_id), false)
                and private.has_permission(v_company, 'support.reply'),
    'mailbox', coalesce(c.connected_address, c.mailbox_address),
    'display_name', c.display_name,
    'signature', c.signature,
    'mailbox_modify', coalesce(c.is_enabled and c.mailbox_modify_enabled and 'https://www.googleapis.com/auth/gmail.modify' = any (c.granted_scopes), false),
    'max_attachment_mb', 10,
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'subject', t.subject, 'body', t.body) order by t.name)
                           from public.support_email_templates t where t.company_id = v_company and t.is_active), '[]'::jsonb));
end;
$$;

create or replace function public.support_email_templates_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'subject', t.subject, 'body', t.body, 'is_active', t.is_active, 'updated_at', t.updated_at)
                                    order by t.name) from public.support_email_templates t where t.company_id = v_company), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. OAuth (state created by an administrator; consumed once by the callback)
-- -----------------------------------------------------------------------------
create or replace function public.support_gmail_oauth_begin(p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  c public.support_email_config;
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid OAuth state.' using errcode = 'P0001';
  end if;
  select * into c from public.support_email_config where company_id = v_company;
  if not found then
    raise exception 'Save the email settings (support mailbox address) first.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.support_oauth_states where created_by = auth.uid() and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many connection attempts. Wait a few minutes and try again.' using errcode = 'P0001';
  end if;
  delete from public.support_oauth_states where company_id = v_company and expires_at < now() - interval '1 day';
  insert into public.support_oauth_states (company_id, channel_account_id, state_hash, scopes, created_by, expires_at)
  values (v_company, c.channel_account_id, p_state_hash, private.support_gmail_scopes(c.mailbox_modify_enabled), auth.uid(), now() + interval '10 minutes');
  perform private.support_gmail_event(v_company, c.channel_account_id, 'OAUTH', 'Google authorisation started.', '{}'::jsonb, null, null, null, auth.uid());
  return jsonb_build_object('account_id', c.channel_account_id, 'mailbox_address', c.mailbox_address, 'scopes', to_jsonb(private.support_gmail_scopes(c.mailbox_modify_enabled)));
end;
$$;

-- Service role: single use, unexpired, and the administrator still has the permission.
create or replace function public.support_gmail_oauth_consume(p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.support_oauth_states;
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'INVALID');
  end if;
  update public.support_oauth_states set used_at = now(), outcome = 'CONSUMED'
  where state_hash = p_state_hash and used_at is null and expires_at > now()
  returning * into s;
  if not found then
    select * into s from public.support_oauth_states where state_hash = p_state_hash;
    return jsonb_build_object('ok', false, 'reason', case when s.id is null then 'UNKNOWN' when s.used_at is not null then 'USED' else 'EXPIRED' end);
  end if;
  if not private.user_has_permission_code(s.created_by, s.company_id, 'support.manage_integrations') then
    return jsonb_build_object('ok', false, 'reason', 'NOT_ALLOWED');
  end if;
  return jsonb_build_object('ok', true, 'company_id', s.company_id, 'account_id', s.channel_account_id, 'user_id', s.created_by, 'scopes', to_jsonb(s.scopes),
    'mailbox_address', (select mailbox_address from public.support_email_config where company_id = s.company_id));
end;
$$;

create or replace function public.support_gmail_oauth_failed(p_account uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
begin
  select * into c from public.support_email_config where channel_account_id = p_account;
  if found then
    perform private.support_gmail_event(c.company_id, p_account, 'OAUTH', 'Google authorisation failed.', '{}'::jsonb, 'ERROR', p_reason);
  end if;
end;
$$;

-- Service role: store the encrypted refresh token after the code exchange and the mailbox check.
create or replace function public.support_gmail_connect(p_account uuid, p_user uuid, p_address text, p_ciphertext text, p_iv text, p_key_version integer,
  p_scopes text[], p_history_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
  v_address text := private.support_normalize_email(p_address);
begin
  select * into c from public.support_email_config where channel_account_id = p_account for update;
  if not found then
    raise exception 'Email settings not found.' using errcode = 'P0001';
  end if;
  if v_address is null or v_address <> c.mailbox_address then
    raise exception 'Signed in as %, but the support mailbox is %.', coalesce(v_address, 'an unknown account'), c.mailbox_address using errcode = 'P0001';
  end if;
  if not (p_scopes @> array['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']) then
    raise exception 'Google did not grant the Gmail read and send permissions.' using errcode = 'P0001';
  end if;
  insert into public.support_email_credentials (company_id, channel_account_id, refresh_token_ciphertext, iv, key_version, stored_at)
  values (c.company_id, p_account, p_ciphertext, p_iv, coalesce(p_key_version, 1), now())
  on conflict (company_id) do update set channel_account_id = excluded.channel_account_id, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
    iv = excluded.iv, key_version = excluded.key_version, stored_at = now();
  update public.support_email_config set connected_address = v_address, granted_scopes = p_scopes, is_enabled = true, connected_at = now(), connected_by = p_user,
    disconnected_at = null,
    -- A different mailbox (or none before): start reading history from now; the first sync back-fills recent mail.
    last_history_id = case when c.connected_address is distinct from v_address or c.last_history_id is null then p_history_id else c.last_history_id end,
    last_full_sync_at = case when c.connected_address is distinct from v_address then null else c.last_full_sync_at end
  where company_id = c.company_id;
  perform public.support_record_integration_health(p_account, 'CONNECTED', 'Connected as ' || v_address || '.');
  perform private.support_gmail_event(c.company_id, p_account, 'OAUTH', 'Google Workspace connected as ' || v_address || '.',
    jsonb_build_object('scopes', to_jsonb(p_scopes)), 'PROCESSED', null, null, p_user);
  return jsonb_build_object('company_id', c.company_id, 'push_enabled', c.push_enabled, 'pubsub_topic', c.pubsub_topic);
end;
$$;

create or replace function public.support_gmail_credentials(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ciphertext', k.refresh_token_ciphertext, 'iv', k.iv, 'key_version', k.key_version)
  from public.support_email_credentials k where k.channel_account_id = p_account;
$$;

create or replace function public.support_gmail_runtime(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('company_id', c.company_id, 'account_id', c.channel_account_id, 'mailbox_address', c.mailbox_address,
    'connected_address', c.connected_address, 'display_name', c.display_name, 'is_enabled', c.is_enabled, 'status', a.status,
    'pubsub_topic', c.pubsub_topic, 'push_enabled', c.push_enabled, 'mailbox_modify_enabled', c.mailbox_modify_enabled, 'granted_scopes', to_jsonb(c.granted_scopes),
    'initial_sync_days', c.initial_sync_days, 'max_attachment_mb', c.max_attachment_mb, 'last_history_id', c.last_history_id,
    'last_full_sync_at', c.last_full_sync_at, 'watch_expiration', c.watch_expiration,
    'has_credentials', exists (select 1 from public.support_email_credentials k where k.channel_account_id = c.channel_account_id))
  from public.support_email_config c join public.support_channel_accounts a on a.id = c.channel_account_id
  where c.channel_account_id = p_account;
$$;

create or replace function public.support_gmail_accounts()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.channel_account_id from public.support_email_config c
  where c.is_enabled and exists (select 1 from public.support_email_credentials k where k.channel_account_id = c.channel_account_id);
$$;

create or replace function public.support_gmail_disconnected(p_account uuid, p_reason text, p_revoked boolean, p_by uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
begin
  select * into c from public.support_email_config where channel_account_id = p_account for update;
  if not found then
    raise exception 'Email settings not found.' using errcode = 'P0001';
  end if;
  delete from public.support_email_credentials where channel_account_id = p_account;
  update public.support_email_config set is_enabled = false, disconnected_at = now(), watch_expiration = null, watch_status = 'Stopped (disconnected).'
  where company_id = c.company_id;
  perform public.support_record_integration_health(p_account, 'NOT_CONNECTED',
    'Disconnected' || case when p_revoked then ' and access revoked at Google.' else '. Google did not confirm the revocation; remove the app in the Google Account / Admin console if needed.' end);
  perform private.support_gmail_event(c.company_id, p_account, 'DISCONNECTED', left('Disconnected: ' || coalesce(p_reason, 'no reason given'), 1000),
    jsonb_build_object('revoked', p_revoked), 'PROCESSED', null, null, p_by);
end;
$$;

-- Service role: the refresh token no longer works (consent revoked, password change, admin policy).
create or replace function public.support_gmail_reauth_required(p_account uuid, p_detail text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.support_email_credentials where channel_account_id = p_account;
  perform private.support_gmail_health(p_account, 'REAUTHORIZATION_REQUIRED', coalesce(p_detail, 'Google refused the stored authorisation. Reconnect Google Workspace.'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Sync state, watch state, push notifications, replay
-- -----------------------------------------------------------------------------
create or replace function public.support_gmail_sync_state(p_account uuid, p_history_id text, p_ok boolean, p_message text, p_kind text, p_counts jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
begin
  select * into c from public.support_email_config where channel_account_id = p_account for update;
  if not found then
    return;
  end if;
  if p_history_id is not null and p_history_id !~ '^[0-9]{1,20}$' then
    raise exception 'Invalid history id.' using errcode = 'P0001';
  end if;
  update public.support_email_config set
    -- History only moves forward, except after a full re-sync (Gmail said the old position had expired).
    last_history_id = case when p_history_id is null then last_history_id
                           when p_kind = 'FULL' or last_history_id is null or p_history_id::numeric > last_history_id::numeric then p_history_id
                           else last_history_id end,
    last_sync_at = case when p_ok then now() else last_sync_at end,
    last_sync_status = left(coalesce(p_message, case when p_ok then 'OK' else 'Failed' end), 500),
    last_full_sync_at = case when p_ok and p_kind = 'FULL' then now() else last_full_sync_at end
  where company_id = c.company_id;
  if p_ok then
    perform private.support_gmail_health(p_account, 'CONNECTED', 'Connected as ' || coalesce(c.connected_address, c.mailbox_address) || '.');
  elsif (select status from public.support_channel_accounts where id = p_account) = 'CONNECTED' then
    perform private.support_gmail_health(p_account, 'ERROR', left('Mailbox sync failed: ' || coalesce(p_message, 'unknown error'), 500));
  end if;
  perform private.support_gmail_event(c.company_id, p_account, 'MAIL_SYNC', left(coalesce(p_message, ''), 1000), coalesce(p_counts, '{}'::jsonb) || jsonb_build_object('kind', p_kind),
    case when p_ok then 'PROCESSED' else 'ERROR' end, case when p_ok then null else p_message end);
end;
$$;

create or replace function public.support_gmail_watch_state(p_account uuid, p_ok boolean, p_expiration_ms text, p_message text, p_stopped boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
begin
  select * into c from public.support_email_config where channel_account_id = p_account for update;
  if not found then
    return;
  end if;
  update public.support_email_config set
    watch_expiration = case when p_stopped then null when p_ok and p_expiration_ms ~ '^[0-9]{10,16}$' then to_timestamp(p_expiration_ms::numeric / 1000) else watch_expiration end,
    watch_renewed_at = case when p_ok and not p_stopped then now() else watch_renewed_at end,
    watch_status = left(p_message, 500)
  where company_id = c.company_id;
  perform private.support_gmail_event(c.company_id, p_account, 'WATCH', left(p_message, 1000), jsonb_build_object('stopped', p_stopped),
    case when p_ok then 'PROCESSED' else 'ERROR' end, case when p_ok then null else p_message end);
end;
$$;

-- Service role: log one Pub/Sub notification (de-duplicated by the Pub/Sub message id).
create or replace function public.support_gmail_push(p_address text, p_pubsub_id text, p_history_id text, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
  v_id uuid;
begin
  select * into c from public.support_email_config
  where connected_address = private.support_normalize_email(p_address) and is_enabled
  order by connected_at desc limit 1;
  if not found then
    return jsonb_build_object('result', 'UNKNOWN');
  end if;
  if p_pubsub_id is null or length(p_pubsub_id) > 200 or (p_history_id is not null and p_history_id !~ '^[0-9]{1,20}$') then
    return jsonb_build_object('result', 'INVALID');
  end if;
  if (select count(*) from public.support_integration_events where company_id = c.company_id and channel_account_id = c.channel_account_id
      and event_type = 'WEBHOOK' and created_at > now() - interval '1 minute') >= 300 then
    return jsonb_build_object('result', 'RATE_LIMITED', 'account_id', c.channel_account_id);
  end if;
  v_id := private.support_gmail_event(c.company_id, c.channel_account_id, 'WEBHOOK', 'Gmail push notification',
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('history_id', p_history_id), null, null, 'gmail-push:' || p_pubsub_id);
  update public.support_email_config set last_push_at = now() where company_id = c.company_id;
  if v_id is null then
    return jsonb_build_object('result', 'DUPLICATE', 'account_id', c.channel_account_id);
  end if;
  return jsonb_build_object('result', 'LOGGED', 'account_id', c.channel_account_id, 'event_id', v_id);
end;
$$;

create or replace function public.support_gmail_event_done(p_event uuid, p_result text, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.support_integration_events set processed_at = now(), processing_result = left(p_result, 40), processing_error = left(p_error, 1000)
  where id = p_event and event_type in ('WEBHOOK', 'REPLAY');
$$;

-- Administrator: replay a notification (re-reads the mailbox history from its position; storing is idempotent).
create or replace function public.support_gmail_replay(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  e public.support_integration_events;
  c public.support_email_config;
begin
  select * into c from public.support_email_config where company_id = v_company;
  select * into e from public.support_integration_events
  where id = p_event and company_id = v_company and channel_account_id = c.channel_account_id and event_type = 'WEBHOOK' for update;
  if not found then
    raise exception 'Gmail notification not found.' using errcode = 'P0001';
  end if;
  if not c.is_enabled then
    raise exception 'Connect the mailbox before replaying notifications.' using errcode = 'P0001';
  end if;
  update public.support_integration_events set replay_count = replay_count + 1 where id = e.id;
  perform private.support_gmail_event(v_company, c.channel_account_id, 'REPLAY', 'Notification replayed by an administrator.',
    jsonb_build_object('event_id', e.id, 'history_id', e.details ->> 'history_id'), null, null, null, auth.uid());
  -- A notification carries the mailbox position AFTER the change: re-read from the previous notification's position.
  return jsonb_build_object('account_id', c.channel_account_id, 'event_id', e.id, 'history_id', e.details ->> 'history_id',
    'start_history_id', coalesce((select p.details ->> 'history_id' from public.support_integration_events p
                                  where p.company_id = v_company and p.channel_account_id = c.channel_account_id and p.event_type = 'WEBHOOK'
                                    and p.created_at < e.created_at and p.details ->> 'history_id' ~ '^[0-9]{1,20}$'
                                  order by p.created_at desc limit 1), e.details ->> 'history_id'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Incoming (and externally sent) mail
-- -----------------------------------------------------------------------------
create or replace function public.support_gmail_known(p_account uuid, p_ids text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.gmail_message_id), '{}') from public.support_email_messages m
  join public.support_email_config c on c.company_id = m.company_id and c.channel_account_id = p_account
  where m.gmail_message_id = any (p_ids);
$$;

-- p: gmail_message_id, gmail_thread_id, label_ids[], rfc_message_id, in_reply_to, references, from {email,name}, to[], cc[], bcc[],
--    reply_to, subject, body_text, body_html (already sanitised), html_truncated, internal_date (ms), size_estimate, mime, attachments[]
create or replace function public.support_gmail_ingest(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_email_config;
  v_gid text := p ->> 'gmail_message_id';
  v_tid text := p ->> 'gmail_thread_id';
  v_labels text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'label_ids', '[]'::jsonb)) x), '{}');
  v_from text := private.support_normalize_email(p #>> '{from,email}');
  v_from_name text := left(nullif(btrim(p #>> '{from,name}'), ''), 200);
  v_rfc text := left(nullif(btrim(p ->> 'rfc_message_id'), ''), 998);
  v_irt text := left(nullif(btrim(p ->> 'in_reply_to'), ''), 998);
  v_refs text := left(nullif(btrim(p ->> 'references'), ''), 8000);
  v_subject text := left(nullif(btrim(p ->> 'subject'), ''), 998);
  v_text text := left(p ->> 'body_text', 500000);
  v_at timestamptz := case when p ->> 'internal_date' ~ '^[0-9]{10,16}$' then to_timestamp((p ->> 'internal_date')::numeric / 1000) else now() end;
  v_dir text;
  v_to jsonb;
  v_cc jsonb;
  v_bcc jsonb;
  v_contact text;
  v_contact_name text;
  v_conv uuid;
  v_new_conv boolean := false;
  v_msg uuid;
  v_email uuid;
  v_existing public.support_email_messages;
  v_match text := 'NONE';
  v_customer uuid;
  v_n integer;
  v_parts jsonb;
begin
  select * into c from public.support_email_config where channel_account_id = p_account;
  if not found or not c.is_enabled then
    return jsonb_build_object('result', 'IGNORED', 'reason', 'Mailbox not connected.');
  end if;
  if v_gid is null or v_gid !~ '^[A-Za-z0-9_-]{6,64}$' or (v_tid is not null and v_tid !~ '^[A-Za-z0-9_-]{6,64}$') then
    raise exception 'Invalid Gmail message or thread id.' using errcode = 'P0001';
  end if;

  -- Already stored: nothing changes; attachment parts still waiting are returned for another try.
  select * into v_existing from public.support_email_messages where company_id = c.company_id and gmail_message_id = v_gid;
  if found then
    return jsonb_build_object('result', 'DUPLICATE', 'email_id', v_existing.id, 'message_id', v_existing.message_id, 'conversation_id', v_existing.conversation_id,
      'attachments', coalesce((select jsonb_agg(a) from jsonb_array_elements(v_existing.attachment_parts) a where a ->> 'state' in ('PENDING', 'FAILED')), '[]'::jsonb));
  end if;
  if v_labels && array['DRAFT', 'SPAM', 'TRASH'] or not (v_labels && array['INBOX', 'SENT']) then
    return jsonb_build_object('result', 'IGNORED', 'reason', 'Not in the inbox or sent mail.');
  end if;
  v_to := coalesce((select jsonb_agg(jsonb_build_object('email', private.support_normalize_email(x ->> 'email'), 'name', left(x ->> 'name', 200)))
                    from jsonb_array_elements(coalesce(p -> 'to', '[]'::jsonb)) x where private.support_normalize_email(x ->> 'email') is not null), '[]'::jsonb);
  v_cc := coalesce((select jsonb_agg(jsonb_build_object('email', private.support_normalize_email(x ->> 'email'), 'name', left(x ->> 'name', 200)))
                    from jsonb_array_elements(coalesce(p -> 'cc', '[]'::jsonb)) x where private.support_normalize_email(x ->> 'email') is not null), '[]'::jsonb);
  v_bcc := coalesce((select jsonb_agg(jsonb_build_object('email', private.support_normalize_email(x ->> 'email'), 'name', left(x ->> 'name', 200)))
                     from jsonb_array_elements(coalesce(p -> 'bcc', '[]'::jsonb)) x where private.support_normalize_email(x ->> 'email') is not null), '[]'::jsonb);
  v_dir := case when 'SENT' = any (v_labels) or v_from = coalesce(c.connected_address, c.mailbox_address) then 'OUTBOUND' else 'INBOUND' end;

  -- Sent from the ERP and not yet confirmed: Gmail's copy confirms it (matched by our Message-ID).
  if v_dir = 'OUTBOUND' and v_rfc is not null then
    select * into v_existing from public.support_email_messages
    where company_id = c.company_id and rfc_message_id = v_rfc and direction = 'OUTBOUND' and gmail_message_id is null and send_state in ('PENDING', 'FAILED')
    order by created_at desc limit 1 for update;
    if found then
      update public.support_email_messages set gmail_message_id = v_gid, gmail_thread_id = coalesce(v_tid, gmail_thread_id), send_state = 'SENT', send_error = null,
        label_ids = v_labels, internal_date = v_at where id = v_existing.id;
      update public.support_messages set delivery_status = 'SENT', delivery_error = null, external_message_id = v_gid where id = v_existing.message_id;
      update public.support_conversations set external_thread_id = v_tid
      where id = v_existing.conversation_id and external_thread_id is null and v_tid is not null
        and not exists (select 1 from public.support_conversations o where o.company_id = c.company_id and o.channel_account_id = p_account and o.external_thread_id = v_tid);
      return jsonb_build_object('result', 'CONFIRMED', 'email_id', v_existing.id, 'message_id', v_existing.message_id, 'conversation_id', v_existing.conversation_id, 'attachments', '[]'::jsonb);
    end if;
  end if;

  -- Conversation: the Gmail thread, else the message it replies to, else a new conversation.
  if v_tid is not null then
    select id into v_conv from public.support_conversations where company_id = c.company_id and channel_account_id = p_account and external_thread_id = v_tid;
  end if;
  if v_conv is null and (v_irt is not null or v_refs is not null) then
    select m.conversation_id into v_conv from public.support_email_messages m
    where m.company_id = c.company_id and m.rfc_message_id is not null
      and (m.rfc_message_id = v_irt or m.rfc_message_id = any (regexp_split_to_array(coalesce(v_refs, ''), '\s+')))
    order by m.created_at desc limit 1;
  end if;
  if v_dir = 'INBOUND' then
    v_contact := v_from;
    v_contact_name := v_from_name;
  else
    v_contact := v_to -> 0 ->> 'email';
    v_contact_name := v_to -> 0 ->> 'name';
  end if;
  if v_conv is null then
    -- Link a customer only when exactly one customer has this address; never merge identities automatically.
    select count(*), (array_agg(customer_id))[1] into v_n, v_customer from private.support_match_customers(c.company_id, null, v_contact);
    v_match := case when v_n = 1 then 'MATCHED' when v_n > 1 then 'AMBIGUOUS' else 'NONE' end;
    insert into public.support_conversations (company_id, channel, channel_account_id, customer_id, subject, contact_name, contact_email, status,
      external_thread_id, last_activity_at)
    values (c.company_id, 'EMAIL', p_account, case when v_n = 1 then v_customer end, left(coalesce(private.support_email_base_subject(v_subject), v_subject, '(no subject)'), 200),
      left(v_contact_name, 200), v_contact, 'OPEN', v_tid, v_at)
    on conflict (company_id, channel_account_id, external_thread_id) where external_thread_id is not null do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from public.support_conversations where company_id = c.company_id and channel_account_id = p_account and external_thread_id = v_tid;
    else
      v_new_conv := true;
    end if;
  end if;

  insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, delivery_status, external_message_id, occurred_at)
  values (c.company_id, v_conv, 'EMAIL', v_dir, 'CHANNEL', left(coalesce(nullif(btrim(v_text), ''), '(no text content)'), 20000), left(v_subject, 300),
          case when v_dir = 'OUTBOUND' then 'SENT' end, v_gid, v_at)
  returning id into v_msg;
  v_parts := coalesce((select jsonb_agg(jsonb_build_object('part_id', left(a ->> 'part_id', 50), 'attachment_id', left(a ->> 'attachment_id', 1000),
               'filename', left(a ->> 'filename', 255), 'mime_type', left(a ->> 'mime_type', 120), 'size', nullif(a ->> 'size', '')::bigint,
               'content_id', left(a ->> 'content_id', 250), 'inline', coalesce((a ->> 'inline')::boolean, false),
               'state', case when a ->> 'state' in ('BLOCKED', 'TOO_LARGE') then a ->> 'state' else 'PENDING' end, 'reason', left(a ->> 'reason', 200)))
             from jsonb_array_elements(coalesce(p -> 'attachments', '[]'::jsonb)) a), '[]'::jsonb);
  insert into public.support_email_messages (company_id, message_id, conversation_id, channel_account_id, direction, gmail_message_id, gmail_thread_id, rfc_message_id,
    in_reply_to, references_header, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to_address, subject, body_text, body_html,
    html_truncated, label_ids, mime, attachment_parts, internal_date, size_estimate, send_state)
  values (c.company_id, v_msg, v_conv, p_account, v_dir, v_gid, v_tid, v_rfc, v_irt, v_refs, v_from, v_from_name, v_to, v_cc, v_bcc,
    private.support_normalize_email(p ->> 'reply_to'), v_subject, v_text, left(p ->> 'body_html', 1000000), coalesce((p ->> 'html_truncated')::boolean, false)
      or coalesce(length(p ->> 'body_html') > 1000000, false),
    v_labels, coalesce(p -> 'mime', '{}'::jsonb), v_parts, v_at, nullif(p ->> 'size_estimate', '')::integer, case when v_dir = 'OUTBOUND' then 'SENT' end)
  returning id into v_email;

  perform private.support_touch_conversation(v_conv, left(coalesce(v_subject, '') || ' — ' || coalesce(v_text, ''), 300), v_at, case when v_dir = 'INBOUND' then 1 else 0 end);
  if v_dir = 'INBOUND' then
    update public.support_conversations set status = 'OPEN' where id = v_conv and status <> 'OPEN';
  else
    perform private.support_mark_first_response(v_conv, v_at);
    update public.support_conversations set status = case when status = 'RESOLVED' then status else 'PENDING' end where id = v_conv;
  end if;
  if v_new_conv then
    perform private.support_run_automation(c.company_id, 'CONVERSATION_CREATED', null, v_conv);
  end if;
  return jsonb_build_object('result', 'STORED', 'direction', v_dir, 'email_id', v_email, 'message_id', v_msg, 'conversation_id', v_conv,
    'new_conversation', v_new_conv, 'customer_match', case when v_new_conv then v_match end,
    'attachments', coalesce((select jsonb_agg(a) from jsonb_array_elements(v_parts) a where a ->> 'state' = 'PENDING'), '[]'::jsonb));
end;
$$;

-- Service role: an attachment part was copied into the private bucket (or could not be).
create or replace function public.support_gmail_attachment_result(p_email uuid, p_part_id text, p_ok boolean, p_path text, p_file_name text, p_content_type text,
  p_size bigint, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_email_messages;
  v_id uuid;
  v_part jsonb;
begin
  select * into m from public.support_email_messages where id = p_email for update;
  if not found then
    raise exception 'Email not found.' using errcode = 'P0001';
  end if;
  select a into v_part from jsonb_array_elements(m.attachment_parts) a where a ->> 'part_id' = p_part_id;
  if v_part is null then
    raise exception 'Attachment part not found.' using errcode = 'P0001';
  end if;
  if p_ok then
    if p_path is null or p_path not like m.company_id::text || '/email/' || m.id::text || '/%' or p_path like '%..%' then
      raise exception 'Invalid attachment path.' using errcode = 'P0001';
    end if;
    if p_size is null or p_size < 0 or p_size > 26214400 then
      raise exception 'Invalid attachment size.' using errcode = 'P0001';
    end if;
    insert into public.support_attachments (company_id, conversation_id, message_id, file_name, storage_path, content_type, size_bytes, email_part_id, email_content_id, email_inline)
    values (m.company_id, m.conversation_id, m.message_id, left(coalesce(nullif(btrim(p_file_name), ''), 'attachment'), 255), p_path, left(p_content_type, 120), p_size,
      p_part_id, v_part ->> 'content_id', coalesce((v_part ->> 'inline')::boolean, false))
    on conflict (storage_path) do nothing
    returning id into v_id;
  end if;
  update public.support_email_messages set attachment_parts = (
    select jsonb_agg(case when a ->> 'part_id' = p_part_id
                          then a || jsonb_build_object('state', case when p_ok then 'STORED' else 'FAILED' end, 'reason', left(p_reason, 200),
                                                       'attachment_row_id', coalesce(v_id::text, a ->> 'attachment_row_id'))
                          else a end order by o)
    from jsonb_array_elements(m.attachment_parts) with ordinality as x (a, o))
  where id = m.id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Sending
-- -----------------------------------------------------------------------------
-- Called by google-gmail-send with the agent's JWT (support.reply). Records the email as PENDING and returns
-- what the Edge Function needs to build the MIME message. A repeated key returns the existing email.
create or replace function public.support_gmail_send_prepare(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.reply');
  c public.support_email_config;
  v_key text := p ->> 'idempotency_key';
  v_mode text := upper(coalesce(p ->> 'mode', 'NEW'));
  v_to jsonb := private.support_email_list(p -> 'to', 'To');
  v_cc jsonb := private.support_email_list(p -> 'cc', 'Cc');
  v_bcc jsonb := private.support_email_list(p -> 'bcc', 'Bcc');
  v_body text := private.support_text(p, 'body', 20000);
  v_subject text := private.support_text(p, 'subject', 300);
  v_template uuid := nullif(p ->> 'template_id', '')::uuid;
  v_reply_id uuid := nullif(p ->> 'reply_to_email_id', '')::uuid;
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_ticket uuid := nullif(p ->> 'ticket_id', '')::uuid;
  r public.support_email_messages;
  e public.support_email_messages;
  v_irt text;
  v_refs text;
  v_thread text;
  v_rfc text;
  v_msg uuid;
  v_email uuid;
  v_att jsonb := '[]'::jsonb;
  a jsonb;
  v_total bigint := 0;
  v_n integer;
  v_path text;
  v_ext text;
  v_size bigint;
  v_att_id uuid;
  v_conv_row public.support_conversations;
begin
  if v_key is null or v_key !~ '^[A-Za-z0-9-]{16,64}$' then
    raise exception 'Missing request key.' using errcode = 'P0001';
  end if;
  select * into e from public.support_email_messages where company_id = v_company and idempotency_key = v_key;
  if found then
    return jsonb_build_object('existing', true, 'email_id', e.id, 'message_id', e.message_id, 'conversation_id', e.conversation_id, 'send_state', e.send_state,
      'send_error', e.send_error);
  end if;
  select * into c from public.support_email_config where company_id = v_company;
  if not found or not c.is_enabled or (select status from public.support_channel_accounts where id = c.channel_account_id) <> 'CONNECTED' then
    raise exception 'The support mailbox is not connected. An administrator connects it in Support Settings → Email.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.support_email_messages where company_id = v_company and requested_by = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many emails in a minute. Wait a moment and try again.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_to) = 0 then
    raise exception 'Enter at least one recipient.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_to) + jsonb_array_length(v_cc) + jsonb_array_length(v_bcc) > 50 then
    raise exception 'At most 50 recipients.' using errcode = 'P0001';
  end if;
  if v_body is null then
    raise exception 'Enter the message.' using errcode = 'P0001';
  end if;
  if v_mode not in ('NEW', 'REPLY', 'REPLY_ALL') then
    raise exception 'Unknown mode %.', v_mode using errcode = 'P0001';
  end if;
  if v_template is not null and not exists (select 1 from public.support_email_templates where id = v_template and company_id = v_company and is_active) then
    raise exception 'Only approved (active) templates can be used.' using errcode = 'P0001';
  end if;

  if v_mode in ('REPLY', 'REPLY_ALL') then
    select * into r from public.support_email_messages where id = v_reply_id and company_id = v_company;
    if not found then
      raise exception 'The email you are replying to was not found.' using errcode = 'P0001';
    end if;
    v_conv := r.conversation_id;
    -- Threading: In-Reply-To / References from the replied message, the same subject and the Gmail thread.
    v_irt := r.rfc_message_id;
    v_refs := private.support_email_references(r.references_header, r.rfc_message_id);
    v_subject := left('Re: ' || coalesce(private.support_email_base_subject(r.subject), r.subject, ''), 300);
    v_thread := coalesce(r.gmail_thread_id, (select external_thread_id from public.support_conversations where id = r.conversation_id));
  else
    if v_subject is null then
      raise exception 'Enter the subject.' using errcode = 'P0001';
    end if;
    if v_conv is not null then
      select * into v_conv_row from public.support_conversations where id = v_conv and company_id = v_company;
      if not found or v_conv_row.channel <> 'EMAIL' then
        raise exception 'Email conversation not found in your company.' using errcode = 'P0001';
      end if;
    else
      if v_customer is not null and not exists (select 1 from public.support_customers where id = v_customer and company_id = v_company) then
        raise exception 'Customer not found in your company.' using errcode = 'P0001';
      end if;
      if v_ticket is not null and not exists (select 1 from public.support_tickets where id = v_ticket and company_id = v_company) then
        raise exception 'Ticket not found in your company.' using errcode = 'P0001';
      end if;
      if v_customer is null then
        select count(*), (array_agg(customer_id))[1] into v_n, v_customer from private.support_match_customers(v_company, null, v_to -> 0 ->> 'email');
        if v_n <> 1 then
          v_customer := null;
        end if;
      end if;
      insert into public.support_conversations (company_id, channel, channel_account_id, customer_id, ticket_id, subject, contact_name, contact_email, status, created_by, updated_by)
      values (v_company, 'EMAIL', c.channel_account_id, v_customer, v_ticket, left(v_subject, 200), v_to -> 0 ->> 'name', v_to -> 0 ->> 'email', 'PENDING', auth.uid(), auth.uid())
      returning id into v_conv;
    end if;
  end if;

  if coalesce((p ->> 'include_signature')::boolean, false) and c.signature is not null then
    v_body := left(v_body || E'\n\n-- \n' || c.signature, 22100);
  end if;

  -- Attachments were uploaded by the agent to <company>/outbox/<request key>/ in the private bucket.
  if jsonb_typeof(coalesce(p -> 'attachments', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'attachments', '[]'::jsonb)) > 10 then
    raise exception 'At most 10 attachments.' using errcode = 'P0001';
  end if;
  for a in select * from jsonb_array_elements(coalesce(p -> 'attachments', '[]'::jsonb)) loop
    v_path := a ->> 'path';
    v_ext := lower(substring(coalesce(a ->> 'file_name', '') from '\.([A-Za-z0-9]{1,8})$'));
    v_size := nullif(a ->> 'size_bytes', '')::bigint;
    if v_path is null or v_path not like v_company::text || '/outbox/' || v_key || '/%' or v_path like '%..%' or length(v_path) > 500 then
      raise exception 'Attachments must be uploaded for this email first.' using errcode = 'P0001';
    end if;
    if v_ext is null or v_ext <> all (array['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'txt', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']) then
      raise exception 'File type not permitted: %. Allowed: PDF, images, text, CSV and Office documents.', coalesce(a ->> 'file_name', 'file') using errcode = 'P0001';
    end if;
    if v_size is null or v_size <= 0 or v_size > 10485760 then
      raise exception 'Each attachment must be at most 10 MB.' using errcode = 'P0001';
    end if;
    v_total := v_total + v_size;
  end loop;
  if v_total > 10485760 then
    raise exception 'Attachments together must be at most 10 MB.' using errcode = 'P0001';
  end if;

  v_rfc := '<' || replace(gen_random_uuid()::text, '-', '') || '.alton@' || split_part(coalesce(c.connected_address, c.mailbox_address), '@', 2) || '>';
  insert into public.support_messages (company_id, conversation_id, kind, direction, source, body, email_subject, delivery_status, author_user_id, occurred_at)
  values (v_company, v_conv, 'EMAIL', 'OUTBOUND', 'CHANNEL', left(v_body, 20000), left(v_subject, 300), 'QUEUED', auth.uid(), now())
  returning id into v_msg;
  insert into public.support_email_messages (company_id, message_id, conversation_id, channel_account_id, direction, gmail_thread_id, rfc_message_id, in_reply_to,
    references_header, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject, body_text, send_state, idempotency_key, template_id,
    reply_to_email_id, requested_by, internal_date, label_ids)
  values (v_company, v_msg, v_conv, c.channel_account_id, 'OUTBOUND', v_thread, v_rfc, v_irt, v_refs, coalesce(c.connected_address, c.mailbox_address), c.display_name,
    v_to, v_cc, v_bcc, v_subject, v_body, 'PENDING', v_key, v_template, v_reply_id, auth.uid(), now(), '{}')
  returning id into v_email;
  for a in select * from jsonb_array_elements(coalesce(p -> 'attachments', '[]'::jsonb)) loop
    insert into public.support_attachments (company_id, conversation_id, message_id, file_name, storage_path, content_type, size_bytes, uploaded_by)
    values (v_company, v_conv, v_msg, left(regexp_replace(coalesce(a ->> 'file_name', 'file'), '[\r\n"\\/]', '_', 'g'), 255), a ->> 'path',
      left(a ->> 'content_type', 120), (a ->> 'size_bytes')::bigint, auth.uid())
    returning id into v_att_id;
    v_att := v_att || jsonb_build_array(jsonb_build_object('id', v_att_id, 'path', a ->> 'path', 'file_name', left(regexp_replace(coalesce(a ->> 'file_name', 'file'), '[\r\n"\\/]', '_', 'g'), 255),
      'content_type', left(a ->> 'content_type', 120), 'size_bytes', (a ->> 'size_bytes')::bigint));
  end loop;

  perform private.support_touch_conversation(v_conv, left(v_subject || ' — ' || v_body, 300), now(), 0);
  perform private.support_mark_first_response(v_conv, now());
  update public.support_conversations set unread_count = 0, status = case when status = 'RESOLVED' then status else 'PENDING' end where id = v_conv;

  return jsonb_build_object('existing', false, 'email_id', v_email, 'message_id', v_msg, 'conversation_id', v_conv, 'account_id', c.channel_account_id,
    'from', jsonb_build_object('email', coalesce(c.connected_address, c.mailbox_address), 'name', c.display_name),
    'to', v_to, 'cc', v_cc, 'bcc', v_bcc, 'subject', v_subject, 'body', v_body, 'rfc_message_id', v_rfc, 'in_reply_to', v_irt, 'references', v_refs,
    'thread_id', v_thread, 'attachments', v_att);
end;
$$;

-- Service role: Gmail's answer. SENT only with Gmail's message id; FAILED when Gmail refused it; UNCONFIRMED keeps it PENDING.
create or replace function public.support_gmail_send_result(p_email uuid, p_outcome text, p_gmail_id text, p_thread_id text, p_error text, p_http integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.support_email_messages;
begin
  if p_outcome not in ('SENT', 'FAILED', 'UNCONFIRMED') then
    raise exception 'Unknown send outcome %.', p_outcome using errcode = 'P0001';
  end if;
  select * into m from public.support_email_messages where id = p_email for update;
  if not found or m.direction <> 'OUTBOUND' then
    raise exception 'Email not found.' using errcode = 'P0001';
  end if;
  if m.send_state = 'SENT' then
    return jsonb_build_object('send_state', 'SENT', 'changed', false);
  end if;
  if p_outcome = 'SENT' then
    if p_gmail_id is null or p_gmail_id !~ '^[A-Za-z0-9_-]{6,64}$' then
      raise exception 'Gmail did not return a message id; the email cannot be marked as sent.' using errcode = 'P0001';
    end if;
    -- Normally Gmail's id is new. If the mailbox sync already stored Gmail's copy, link to it instead of storing the id twice.
    update public.support_email_messages set send_state = 'SENT', send_error = null, send_http = p_http, send_attempts = send_attempts + 1,
      duplicate_of = (select o.id from public.support_email_messages o where o.company_id = m.company_id and o.gmail_message_id = p_gmail_id and o.id <> m.id),
      gmail_message_id = case when exists (select 1 from public.support_email_messages o where o.company_id = m.company_id and o.gmail_message_id = p_gmail_id and o.id <> m.id)
                              then null else p_gmail_id end,
      gmail_thread_id = coalesce(p_thread_id, gmail_thread_id), label_ids = array['SENT'] where id = m.id;
    update public.support_messages set delivery_status = 'SENT', delivery_error = null,
      external_message_id = (select gmail_message_id from public.support_email_messages where id = m.id) where id = m.message_id;
    if p_thread_id is not null then
      update public.support_conversations set external_thread_id = p_thread_id
      where id = m.conversation_id and external_thread_id is null
        and not exists (select 1 from public.support_conversations o where o.company_id = m.company_id and o.channel_account_id = m.channel_account_id and o.external_thread_id = p_thread_id);
    end if;
  elsif p_outcome = 'FAILED' then
    update public.support_email_messages set send_state = 'FAILED', send_error = left(coalesce(p_error, 'Gmail refused the message.'), 500), send_http = p_http,
      send_attempts = send_attempts + 1 where id = m.id;
    update public.support_messages set delivery_status = 'FAILED', delivery_error = left(coalesce(p_error, 'Gmail refused the message.'), 500) where id = m.message_id;
  else
    update public.support_email_messages set send_error = left(coalesce(p_error, 'Gmail did not confirm the message. It is confirmed by the next mailbox sync if it was sent.'), 500),
      send_http = p_http, send_attempts = send_attempts + 1 where id = m.id;
  end if;
  perform private.support_gmail_event(m.company_id, m.channel_account_id, 'SEND', 'Email ' || lower(p_outcome),
    jsonb_build_object('email_id', m.id, 'http', p_http), case when p_outcome = 'SENT' then 'PROCESSED' when p_outcome = 'FAILED' then 'ERROR' else 'PENDING' end,
    case when p_outcome <> 'SENT' then p_error end);
  return jsonb_build_object('send_state', (select send_state from public.support_email_messages where id = m.id), 'changed', true);
end;
$$;

-- Agent (support.view): inbound Gmail ids of a conversation, for mirroring "read" when gmail.modify is enabled and granted.
create or replace function public.support_gmail_mark_read_targets(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  c public.support_email_config;
begin
  select * into c from public.support_email_config where company_id = v_company;
  if not found or not c.is_enabled or not c.mailbox_modify_enabled or not ('https://www.googleapis.com/auth/gmail.modify' = any (c.granted_scopes)) then
    return jsonb_build_object('enabled', false);
  end if;
  return jsonb_build_object('enabled', true, 'account_id', c.channel_account_id,
    'ids', coalesce((select jsonb_agg(m.gmail_message_id) from (select gmail_message_id from public.support_email_messages
                     where company_id = v_company and conversation_id = p_conversation and direction = 'INBOUND' and gmail_message_id is not null
                       and 'UNREAD' = any (label_ids) order by internal_date desc limit 100) m), '[]'::jsonb));
end;
$$;

create or replace function public.support_gmail_marked_read(p_account uuid, p_ids text[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.support_email_messages m set label_ids = array_remove(m.label_ids, 'UNREAD')
  from public.support_email_config c
  where c.channel_account_id = p_account and m.company_id = c.company_id and m.gmail_message_id = any (p_ids);
$$;

-- -----------------------------------------------------------------------------
-- 9. Reading emails (support.view)
-- -----------------------------------------------------------------------------
create or replace function public.support_email_thread(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  v_sensitive boolean;
begin
  if not exists (select 1 from public.support_conversations where id = p_conversation and company_id = v_company) then
    raise exception 'Conversation not found in your company.' using errcode = 'P0001';
  end if;
  v_sensitive := private.has_permission(v_company, 'support.manage_tickets');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'message_id', m.message_id, 'direction', m.direction, 'from_address', m.from_address, 'from_name', m.from_name,
      'to', m.to_addresses, 'cc', m.cc_addresses, 'bcc', m.bcc_addresses, 'reply_to', m.reply_to_address, 'subject', m.subject, 'body_text', m.body_text,
      'has_html', m.body_html is not null, 'html_truncated', m.html_truncated, 'at', coalesce(m.internal_date, m.created_at), 'send_state', m.send_state,
      'send_error', m.send_error, 'gmail_message_id', m.gmail_message_id, 'gmail_thread_id', m.gmail_thread_id, 'rfc_message_id', m.rfc_message_id,
      'in_reply_to', m.in_reply_to, 'unread', 'UNREAD' = any (m.label_ids),
      'author', (select coalesce(pr.full_name, pr.email) from public.profiles pr where pr.id = m.requested_by),
      'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type, 'size_bytes', a.size_bytes,
                         'inline', a.email_inline, 'storage_path', case when v_sensitive or not a.is_sensitive then a.storage_path end,
                         'restricted', a.is_sensitive and not v_sensitive) order by a.created_at)
                       from public.support_attachments a where a.message_id = m.message_id), '[]'::jsonb),
      'skipped_attachments', coalesce((select jsonb_agg(jsonb_build_object('filename', x ->> 'filename', 'state', x ->> 'state', 'reason', x ->> 'reason'))
                       from jsonb_array_elements(m.attachment_parts) x where x ->> 'state' <> 'STORED'), '[]'::jsonb))
    order by coalesce(m.internal_date, m.created_at), m.created_at)
    from public.support_email_messages m where m.company_id = v_company and m.conversation_id = p_conversation), '[]'::jsonb);
end;
$$;

create or replace function public.support_email_html(p_email uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
begin
  return (select body_html from public.support_email_messages where id = p_email and company_id = v_company);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Replies to email conversations go through the mailbox (google-gmail-send), never the generic queue
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
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_email_config_get', 'support_email_config_save', 'support_email_admin_check', 'support_email_template_save',
             'support_email_compose_context', 'support_email_templates_list', 'support_gmail_oauth_begin', 'support_gmail_replay', 'support_gmail_send_prepare',
             'support_gmail_mark_read_targets', 'support_email_thread', 'support_email_html', 'support_message_add') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Service role only: called by the Edge Functions after their own checks.
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_gmail_oauth_consume', 'support_gmail_oauth_failed', 'support_gmail_connect', 'support_gmail_credentials',
             'support_gmail_runtime', 'support_gmail_accounts', 'support_gmail_disconnected', 'support_gmail_reauth_required', 'support_gmail_sync_state',
             'support_gmail_watch_state', 'support_gmail_push', 'support_gmail_event_done', 'support_gmail_known', 'support_gmail_ingest',
             'support_gmail_attachment_result', 'support_gmail_send_result', 'support_gmail_marked_read') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. ERP reset allowlist (20261211090000 plus the email tables, children first)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
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
