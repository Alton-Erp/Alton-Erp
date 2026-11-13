-- =============================================================================
-- Unified Support Centre: one conversation engine for Acefone, Gmail and WhatsApp, ticket automation,
-- business-hours SLA with escalation, agent notifications, unified reports and integration health.
--
-- Additive; builds on 20261210 (Support Centre), 20261211 (Acefone), 20261212 (Gmail), 20261213 (WhatsApp).
--
--   * Every provider already stores inbound traffic idempotently in support_messages (unique provider ids).
--     One AFTER INSERT trigger on support_messages (source CHANNEL, direction INBOUND) now runs the common
--     steps for all channels: integration event, notifications, reopen-on-reply and ticket creation rules.
--     A provider retry never inserts a second row, so the trigger never runs twice for one event; its own
--     writes are de-duplicated as well (event key, notification key, one ticket per conversation).
--   * Ticket rules (support_ticket_rules): agent request only / every new conversation, missed calls, email and
--     WhatsApp keywords, reopen on customer reply, escalation of breached tickets. Each can be switched on/off.
--   * SLA: business calendar (working days, hours, holidays, time zone); due dates count business minutes; the
--     clock pauses while a ticket waits for the customer; support_sla_run (scheduled) sends warnings, records
--     breaches and applies escalation levels exactly once each (support_ticket_escalations).
--   * Notifications use the ERP's existing private.notify / notify_permission (deduplicated, preferences respected).
--
-- Rollback: supabase/rollback/20261214090000_support_unified_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Event types
-- -----------------------------------------------------------------------------
alter table public.support_integration_events drop constraint if exists support_integration_events_event_type_check;
alter table public.support_integration_events add constraint support_integration_events_event_type_check
  check (event_type in ('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'HEALTH_CHECK', 'WEBHOOK', 'DELIVERY', 'ERROR', 'CLICK_TO_CALL', 'CDR_SYNC', 'RECORDING_SYNC', 'REPLAY',
                         'DISCONNECTED', 'REJECTED', 'OAUTH', 'MAIL_SYNC', 'WATCH', 'SEND', 'SETUP', 'TEMPLATE_SYNC', 'MEDIA', 'INBOUND', 'AUTOMATION'));
alter table public.support_ticket_events drop constraint if exists support_ticket_events_event_type_check;
alter table public.support_ticket_events add constraint support_ticket_events_event_type_check
  check (event_type in ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'UPDATED', 'MERGED', 'MERGED_INTO',
                        'REOPENED', 'NOTE_ADDED', 'ATTACHMENT_ADDED', 'CONVERSATION_LINKED', 'FIRST_RESPONSE', 'AUTOMATION', 'CSAT_RECORDED',
                        'SLA_WARNING', 'SLA_BREACHED', 'ESCALATED'));

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_ticket_rules (
  company_id                   uuid primary key references public.companies (id) on delete restrict,
  ticket_mode                  text not null default 'AGENT_REQUEST_ONLY' check (ticket_mode in ('AGENT_REQUEST_ONLY', 'EVERY_NEW_CONVERSATION')),
  new_conversation_priority    text not null default 'NORMAL' check (new_conversation_priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  missed_call_enabled          boolean not null default false,
  missed_call_priority         text not null default 'HIGH' check (missed_call_priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  email_keywords_enabled       boolean not null default false,
  email_keywords               text[] not null default '{}' check (cardinality(email_keywords) <= 50),
  email_match_body             boolean not null default false,
  whatsapp_keywords_enabled    boolean not null default false,
  whatsapp_keywords            text[] not null default '{}' check (cardinality(whatsapp_keywords) <= 50),
  keyword_priority             text not null default 'NORMAL' check (keyword_priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  reopen_on_reply_enabled      boolean not null default true,
  escalate_on_breach_enabled   boolean not null default false,
  escalate_priorities          text[] not null default array['URGENT'] check (escalate_priorities <@ array['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  sla_warning_percent          integer not null default 80 check (sla_warning_percent between 50 and 95),
  updated_by                   uuid,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create table if not exists public.support_business_calendar (
  company_id                   uuid primary key references public.companies (id) on delete restrict,
  -- Off: SLA counts every minute (24×7), as before.
  enabled                      boolean not null default false,
  timezone                     text check (timezone is null or length(timezone) <= 60),
  working_days                 integer[] not null default array[1, 2, 3, 4, 5, 6] check (working_days <@ array[1, 2, 3, 4, 5, 6, 7] and cardinality(working_days) between 1 and 7),
  start_time                   time not null default '09:30',
  end_time                     time not null default '18:30',
  -- Customer waiting-time exclusion: the SLA clock stops while a ticket waits for the customer.
  pause_when_waiting_customer  boolean not null default true,
  updated_by                   uuid,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint support_business_calendar_hours check (end_time > start_time)
);

create table if not exists public.support_holidays (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete restrict,
  holiday_date  date not null,
  name          text not null check (length(btrim(name)) between 1 and 120),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint support_holidays_unique unique (company_id, holiday_date)
);

create table if not exists public.support_sla_escalation_levels (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  level              integer not null check (level between 1 and 5),
  -- Minutes after the breach (resolution or first response) before this level applies.
  after_minutes      integer not null default 0 check (after_minutes between 0 and 43200),
  priorities         text[] not null default '{}' check (priorities <@ array['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  notify_assignee    boolean not null default true,
  notify_managers    boolean not null default true,
  reassign_agent_id  uuid,
  set_department     text check (set_department is null or length(set_department) <= 80),
  raise_priority     boolean not null default false,
  is_active          boolean not null default true,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint support_sla_escalation_levels_unique unique (company_id, level),
  constraint support_sla_escalation_levels_agent_fk foreign key (reassign_agent_id, company_id) references public.support_agents (id, company_id) on delete restrict
);

-- Agent and department assignment for new tickets without an agent (first matching rule wins).
create table if not exists public.support_assignment_rules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  name         text not null check (length(btrim(name)) between 1 and 120),
  channel      text check (channel is null or channel in ('PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL')),
  priority     text check (priority is null or priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  department   text check (department is null or length(department) <= 80),
  agent_id     uuid,
  run_order    integer not null default 100 check (run_order between 0 and 10000),
  is_active    boolean not null default true,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint support_assignment_rules_target check (department is not null or agent_id is not null),
  constraint support_assignment_rules_agent_fk foreign key (agent_id, company_id) references public.support_agents (id, company_id) on delete restrict
);

-- SLA warnings, breaches and escalations: each at most once per ticket, target and level.
create table if not exists public.support_ticket_escalations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  ticket_id   uuid not null,
  kind        text not null check (kind in ('WARNING', 'BREACH', 'ESCALATION')),
  target      text not null check (target in ('FIRST_RESPONSE', 'RESOLUTION')),
  level       integer not null default 0 check (level between 0 and 5),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint support_ticket_escalations_unique unique (ticket_id, kind, target, level),
  constraint support_ticket_escalations_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict
);
create index if not exists support_ticket_escalations_company_idx on public.support_ticket_escalations (company_id, created_at desc);

alter table public.support_tickets add column if not exists sla_paused_minutes integer not null default 0 check (sla_paused_minutes >= 0);
alter table public.support_tickets add column if not exists sla_paused_at timestamptz;
alter table public.support_tickets add column if not exists first_response_breached_at timestamptz;
alter table public.support_tickets add column if not exists resolution_breached_at timestamptz;

do $$
declare
  t text;
begin
  foreach t in array array['support_ticket_rules', 'support_business_calendar', 'support_holidays', 'support_sla_escalation_levels', 'support_assignment_rules',
                           'support_ticket_escalations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))', t || '_select', t, 'support.view');
  end loop;
  foreach t in array array['support_ticket_rules', 'support_business_calendar', 'support_sla_escalation_levels', 'support_assignment_rules'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.support_audit_row()', t || '_audit', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Business calendar and SLA arithmetic
-- -----------------------------------------------------------------------------
-- p_minutes business minutes after p_start (24×7 when the calendar is off).
create or replace function private.support_business_add(p_company uuid, p_start timestamptz, p_minutes integer)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cal public.support_business_calendar;
  v_tz text;
  v_local timestamp;
  v_day date;
  v_s timestamp;
  v_e timestamp;
  v_left numeric := greatest(coalesce(p_minutes, 0), 0);
  v_avail numeric;
  i integer := 0;
begin
  select * into cal from public.support_business_calendar where company_id = p_company;
  if not found or not cal.enabled then
    return p_start + make_interval(mins => coalesce(p_minutes, 0));
  end if;
  v_tz := coalesce(cal.timezone, private.company_tz(p_company), 'Asia/Kolkata');
  v_local := p_start at time zone v_tz;
  v_day := v_local::date;
  while i < 800 loop
    if extract(isodow from v_day)::int = any (cal.working_days)
       and not exists (select 1 from public.support_holidays h where h.company_id = p_company and h.holiday_date = v_day) then
      v_s := greatest(v_day + cal.start_time, v_local);
      v_e := v_day + cal.end_time;
      if v_e > v_s then
        v_avail := extract(epoch from (v_e - v_s)) / 60;
        if v_avail >= v_left then
          return (v_s + make_interval(secs => v_left * 60)) at time zone v_tz;
        end if;
        v_left := v_left - v_avail;
      end if;
    end if;
    v_day := v_day + 1;
    i := i + 1;
  end loop;
  return p_start + make_interval(mins => coalesce(p_minutes, 0));
end;
$$;

-- Business minutes between two moments (all minutes when the calendar is off).
create or replace function private.support_business_minutes(p_company uuid, p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cal public.support_business_calendar;
  v_tz text;
  a timestamp;
  b timestamp;
  v_day date;
  v_total numeric := 0;
  v_s timestamp;
  v_e timestamp;
  i integer := 0;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;
  select * into cal from public.support_business_calendar where company_id = p_company;
  if not found or not cal.enabled then
    return floor(extract(epoch from (p_to - p_from)) / 60)::int;
  end if;
  v_tz := coalesce(cal.timezone, private.company_tz(p_company), 'Asia/Kolkata');
  a := p_from at time zone v_tz;
  b := p_to at time zone v_tz;
  v_day := a::date;
  while v_day <= b::date and i < 800 loop
    if extract(isodow from v_day)::int = any (cal.working_days)
       and not exists (select 1 from public.support_holidays h where h.company_id = p_company and h.holiday_date = v_day) then
      v_s := greatest(v_day + cal.start_time, a);
      v_e := least(v_day + cal.end_time, b);
      if v_e > v_s then
        v_total := v_total + extract(epoch from (v_e - v_s)) / 60;
      end if;
    end if;
    v_day := v_day + 1;
    i := i + 1;
  end loop;
  return floor(v_total)::int;
end;
$$;

-- SLA due dates from the policy, in business minutes, extended by time paused while waiting for the customer.
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
    first_response_due_at = case when v_p.id is null then null
                                 else private.support_business_add(v_t.company_id, v_t.created_at, v_p.first_response_minutes + coalesce(v_t.sla_paused_minutes, 0)) end,
    due_at = case when v_p.id is null then null
                  else private.support_business_add(v_t.company_id, v_t.created_at, v_p.resolution_minutes + coalesce(v_t.sla_paused_minutes, 0)) end
  where id = p_ticket;
end;
$$;

create or replace function private.support_sla_status(t public.support_tickets, p_now timestamptz default now())
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when t.due_at is null then 'NO_SLA'
    when t.status in ('RESOLVED', 'CLOSED') then case when t.resolved_at <= t.due_at then 'MET' else 'BREACHED' end
    when t.sla_paused_at is not null then 'PAUSED'
    when p_now > t.due_at or (t.first_response_at is null and t.first_response_due_at is not null and p_now > t.first_response_due_at) then 'OVERDUE'
    when t.due_at - p_now < (t.due_at - t.created_at) * 0.2 then 'AT_RISK'
    else 'ON_TRACK' end;
$$;

-- Customer waiting-time exclusion: pause on WAITING_CUSTOMER, resume (and push the due dates) when it leaves it.
create or replace function private.support_ticket_sla_pause()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cal public.support_business_calendar;
  v_p public.support_sla_policies;
begin
  select * into cal from public.support_business_calendar where company_id = new.company_id;
  if not found or not cal.pause_when_waiting_customer then
    return new;
  end if;
  if new.status = 'WAITING_CUSTOMER' and old.status is distinct from 'WAITING_CUSTOMER' then
    new.sla_paused_at := now();
  elsif old.status = 'WAITING_CUSTOMER' and new.status <> 'WAITING_CUSTOMER' and old.sla_paused_at is not null then
    new.sla_paused_minutes := coalesce(old.sla_paused_minutes, 0) + private.support_business_minutes(new.company_id, old.sla_paused_at, now());
    new.sla_paused_at := null;
    select * into v_p from public.support_sla_policies where id = new.sla_policy_id;
    if v_p.id is not null then
      if new.first_response_at is null then
        new.first_response_due_at := private.support_business_add(new.company_id, new.created_at, v_p.first_response_minutes + new.sla_paused_minutes);
      end if;
      new.due_at := private.support_business_add(new.company_id, new.created_at, v_p.resolution_minutes + new.sla_paused_minutes);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists support_tickets_sla_pause on public.support_tickets;
create trigger support_tickets_sla_pause before update of status on public.support_tickets
  for each row execute function private.support_ticket_sla_pause();

-- -----------------------------------------------------------------------------
-- 4. Notifications (ERP notification centre)
-- -----------------------------------------------------------------------------
-- The assigned agent when there is one, otherwise everyone who can reply (support.reply).
create or replace function private.support_notify(p_company uuid, p_agent uuid, p_type text, p_title text, p_message text, p_severity text,
  p_entity_type text, p_entity_id text, p_link text, p_dedup text, p_also_managers boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_n integer := 0;
begin
  select user_id into v_user from public.support_agents where id = p_agent and company_id = p_company and is_active;
  if v_user is not null then
    if private.notify(p_company, v_user, p_type, p_title, p_message, p_severity, p_entity_type, p_entity_id, p_link, p_dedup) then
      v_n := 1;
    end if;
  else
    v_n := private.notify_permission(p_company, 'support.reply', p_type, p_title, p_message, p_severity, p_entity_type, p_entity_id, p_link, p_dedup);
  end if;
  if p_also_managers then
    v_n := v_n + private.notify_permission(p_company, 'support.manage_tickets', p_type, p_title, p_message, p_severity, p_entity_type, p_entity_id, p_link, p_dedup, v_user);
  end if;
  return v_n;
end;
$$;

-- New / changed ticket assignment.
create or replace function private.support_ticket_assigned_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_agent_id is not null and (tg_op = 'INSERT' or new.assigned_agent_id is distinct from old.assigned_agent_id) then
    perform private.support_notify(new.company_id, new.assigned_agent_id, 'SUPPORT_TICKET_ASSIGNED', 'Ticket assigned: ' || new.ticket_number,
      left(new.subject, 200) || ' (' || lower(new.priority) || ')', case when new.priority = 'URGENT' then 'HIGH' else 'INFO' end,
      'SUPPORT_TICKET', new.id::text, '/support/tickets/' || new.id, 'support:assigned:' || new.id || ':' || new.assigned_agent_id);
  end if;
  return null;
end;
$$;
drop trigger if exists support_tickets_assigned_notify on public.support_tickets;
create trigger support_tickets_assigned_notify after insert or update of assigned_agent_id on public.support_tickets
  for each row execute function private.support_ticket_assigned_notify();

-- Agent / department assignment rules for tickets created without an agent.
create or replace function private.support_ticket_assign_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.support_assignment_rules;
begin
  if new.assigned_agent_id is not null and new.department is not null then
    return null;
  end if;
  select * into r from public.support_assignment_rules x
  where x.company_id = new.company_id and x.is_active and (x.channel is null or x.channel = new.channel) and (x.priority is null or x.priority = new.priority)
    and (x.agent_id is null or exists (select 1 from public.support_agents a where a.id = x.agent_id and a.is_active))
  order by x.run_order, x.created_at limit 1;
  if found then
    update public.support_tickets set assigned_agent_id = coalesce(assigned_agent_id, r.agent_id), department = coalesce(department, r.department) where id = new.id;
    perform private.support_ticket_event(new.id, 'AUTOMATION', null, 'Assignment rule: ' || r.name, jsonb_build_object('assignment_rule_id', r.id));
  end if;
  return null;
end;
$$;
drop trigger if exists support_tickets_assign_rules on public.support_tickets;
create trigger support_tickets_assign_rules after insert on public.support_tickets
  for each row execute function private.support_ticket_assign_rules();

-- Incoming call (ringing) for the agents.
create or replace function private.support_call_incoming_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if new.direction = 'INBOUND' and new.status in ('INITIATED', 'RINGING', 'CONNECTED') then
    select display_name into v_name from public.support_customers where id = new.customer_id;
    perform private.support_notify(new.company_id, null, 'SUPPORT_CALL_INCOMING', 'Incoming call: ' || coalesce(v_name, new.customer_number_e164, 'unknown caller'),
      'Toll-free call ringing.', 'INFO', 'SUPPORT_CALL', new.id::text, '/support/calls/' || new.id, 'support:call-in:' || new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists support_calls_incoming_notify on public.support_calls;
create trigger support_calls_incoming_notify after insert on public.support_calls
  for each row execute function private.support_call_incoming_notify();

-- -----------------------------------------------------------------------------
-- 5. Ticket rules and the unified inbound step
-- -----------------------------------------------------------------------------
create or replace function private.support_rules(p_company uuid)
returns public.support_ticket_rules
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.support_ticket_rules;
begin
  select * into r from public.support_ticket_rules where company_id = p_company;
  if not found then
    r := row(p_company, 'AGENT_REQUEST_ONLY', 'NORMAL', false, 'HIGH', false, '{}'::text[], false, false, '{}'::text[], 'NORMAL', true, false,
             array['URGENT'], 80, null, now(), now())::public.support_ticket_rules;
  end if;
  return r;
end;
$$;

create or replace function private.support_keyword_hit(p_text text, p_keywords text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select k from unnest(coalesce(p_keywords, '{}')) k
  where length(btrim(k)) > 0 and position(lower(btrim(k)) in lower(coalesce(p_text, ''))) > 0 limit 1;
$$;

-- System-created ticket for a conversation (no user context); one per conversation.
create or replace function private.support_ticket_auto(p_conversation uuid, p_reason text, p_priority text, p_subject text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_conversations;
  v_id uuid;
  v_number text;
  v_subject text;
begin
  select * into c from public.support_conversations where id = p_conversation for update;
  if not found or c.ticket_id is not null then
    return null;
  end if;
  v_subject := left(coalesce(nullif(btrim(p_subject), ''), c.subject, initcap(lower(c.channel)) || ' from ' || coalesce(c.contact_name, c.contact_phone, c.contact_email, 'customer')), 200);
  if length(v_subject) < 3 then
    v_subject := v_subject || ' — support';
  end if;
  v_number := private.support_next_number(c.company_id, 'SUPT', 'ALT-SUP');
  insert into public.support_tickets (company_id, ticket_number, subject, customer_id, customer_phone, customer_email, channel, priority, status, created_by, updated_by)
  values (c.company_id, v_number, v_subject, c.customer_id, c.contact_phone, c.contact_email, c.channel, p_priority, 'NEW', null, null)
  returning id into v_id;
  perform private.support_apply_sla(v_id);
  perform private.support_ticket_event(v_id, 'CREATED', null, 'NEW', jsonb_build_object('channel', c.channel, 'conversation_id', c.id, 'automatic', true, 'rule', p_reason));
  update public.support_conversations set ticket_id = v_id where id = c.id;
  perform private.support_ticket_event(v_id, 'CONVERSATION_LINKED', null, c.id::text);
  if exists (select 1 from public.support_messages where conversation_id = c.id and direction = 'OUTBOUND') then
    perform private.support_mark_first_response(c.id, (select min(occurred_at) from public.support_messages where conversation_id = c.id and direction = 'OUTBOUND'));
  end if;
  perform private.support_run_automation(c.company_id, 'TICKET_CREATED', v_id, null);
  perform private.support_gmail_event(c.company_id, coalesce(c.channel_account_id, (select id from public.support_channel_accounts where company_id = c.company_id and channel = c.channel order by created_at limit 1)),
    'AUTOMATION', format('Ticket %s created automatically (%s).', v_number, lower(replace(p_reason, '_', ' '))), jsonb_build_object('ticket_id', v_id, 'conversation_id', c.id),
    'PROCESSED', null, 'auto-ticket:' || c.id);
  return v_id;
end;
$$;

-- The common steps for every inbound provider message / call (all channels).
create or replace function private.support_on_inbound()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.support_conversations;
  t public.support_tickets;
  r public.support_ticket_rules;
  v_provider text;
  v_account uuid;
  v_type text;
  v_title text;
  v_reason text;
  v_priority text;
  v_hit text;
  v_replied boolean;
  v_first boolean;
begin
  if new.source <> 'CHANNEL' or new.direction <> 'INBOUND' then
    return null;
  end if;
  select * into c from public.support_conversations where id = new.conversation_id;
  select a.provider, a.id into v_provider, v_account from public.support_channel_accounts a where a.id = c.channel_account_id;
  begin
    -- Troubleshooting trail (once per provider message).
    if v_account is not null then
      perform private.support_gmail_event(new.company_id, v_account, 'INBOUND', format('%s %s received', initcap(lower(c.channel)), lower(new.kind)),
        jsonb_build_object('message_id', new.id, 'conversation_id', c.id, 'provider', v_provider, 'external_id', new.external_message_id, 'kind', new.kind,
          'call_status', new.call_status), 'PROCESSED', null, 'inbound:' || new.id);
    end if;
    r := private.support_rules(new.company_id);
    if c.ticket_id is not null then
      select * into t from public.support_tickets where id = c.ticket_id for update;
    end if;
    v_replied := exists (select 1 from public.support_messages m where m.conversation_id = c.id and m.direction = 'OUTBOUND' and m.occurred_at <= new.occurred_at);
    v_first := not exists (select 1 from public.support_messages m where m.conversation_id = c.id and m.direction = 'INBOUND' and m.id <> new.id);

    -- Notification for the agents
    v_type := case when new.kind = 'CALL' and new.call_status = 'MISSED' then 'SUPPORT_CALL_MISSED'
                   when new.kind = 'CALL' then null
                   when v_replied or t.id is not null then 'SUPPORT_CUSTOMER_REPLY'
                   when new.kind = 'EMAIL' then 'SUPPORT_EMAIL_RECEIVED'
                   else 'SUPPORT_WHATSAPP_RECEIVED' end;
    if v_type is not null then
      v_title := case v_type when 'SUPPORT_CALL_MISSED' then 'Missed call: ' when 'SUPPORT_CUSTOMER_REPLY' then 'Customer replied: '
                             when 'SUPPORT_EMAIL_RECEIVED' then 'New email: ' else 'New WhatsApp message: ' end
                 || coalesce((select display_name from public.support_customers where id = c.customer_id), c.contact_name, c.contact_phone, c.contact_email, 'customer');
      perform private.support_notify(new.company_id, coalesce(t.assigned_agent_id, c.assigned_agent_id), v_type, v_title,
        left(coalesce(case when new.kind = 'EMAIL' then new.email_subject end, new.body, ''), 140), case when v_type = 'SUPPORT_CALL_MISSED' then 'MEDIUM' else 'INFO' end,
        'SUPPORT_CONVERSATION', c.id::text, case c.channel when 'PHONE' then '/support/calls?tab=conversations&c=' when 'EMAIL' then '/support/emails?c=' else '/support/whatsapp?c=' end || c.id,
        'support:msg:' || new.id);
    end if;

    -- Reopen a resolved ticket when the customer replies
    if t.id is not null then
      if t.status in ('RESOLVED', 'CLOSED') and t.merged_into_ticket_id is null and r.reopen_on_reply_enabled then
        update public.support_tickets set status = 'OPEN', resolved_at = null, closed_at = null, reopen_count = reopen_count + 1 where id = t.id;
        perform private.support_ticket_event(t.id, 'REOPENED', t.status, 'OPEN', jsonb_build_object('reason', 'Customer replied', 'automatic', true, 'message_id', new.id));
        perform private.support_notify(new.company_id, t.assigned_agent_id, 'SUPPORT_CUSTOMER_REPLY', 'Ticket reopened: ' || t.ticket_number,
          'The customer replied to a resolved ticket.', 'MEDIUM', 'SUPPORT_TICKET', t.id::text, '/support/tickets/' || t.id, 'support:reopen:' || new.id);
      end if;
      return null;
    end if;

    -- Ticket creation rules (no ticket yet)
    if new.kind = 'CALL' and new.call_status = 'MISSED' and r.missed_call_enabled then
      v_reason := 'MISSED_CALL'; v_priority := r.missed_call_priority;
    elsif new.kind = 'EMAIL' and r.email_keywords_enabled then
      v_hit := coalesce(private.support_keyword_hit(new.email_subject, r.email_keywords), case when r.email_match_body then private.support_keyword_hit(new.body, r.email_keywords) end);
      if v_hit is not null then v_reason := 'EMAIL_KEYWORD'; v_priority := r.keyword_priority; end if;
    elsif c.channel = 'WHATSAPP' and new.kind = 'MESSAGE' and r.whatsapp_keywords_enabled then
      v_hit := private.support_keyword_hit(new.body, r.whatsapp_keywords);
      if v_hit is not null then v_reason := 'WHATSAPP_KEYWORD'; v_priority := r.keyword_priority; end if;
    end if;
    if v_reason is null and r.ticket_mode = 'EVERY_NEW_CONVERSATION' and v_first then
      v_reason := 'NEW_CONVERSATION'; v_priority := r.new_conversation_priority;
    end if;
    if v_reason is not null then
      perform private.support_ticket_auto(c.id, v_reason || coalesce(':' || v_hit, ''), v_priority,
        case when v_reason = 'MISSED_CALL' then 'Missed call from ' || coalesce(c.contact_name, c.contact_phone, 'customer')
             when new.kind = 'EMAIL' then new.email_subject else c.subject end);
    end if;
  exception when others then
    -- Never lose the provider's message because of a rule: record the failure for the health dashboard.
    if v_account is not null then
      perform private.support_gmail_event(new.company_id, v_account, 'ERROR', left('Support automation failed: ' || sqlerrm, 1000), jsonb_build_object('message_id', new.id),
        'ERROR', left(sqlerrm, 1000), 'inbound-error:' || new.id);
    end if;
  end;
  return null;
end;
$$;
drop trigger if exists support_messages_on_inbound on public.support_messages;
create trigger support_messages_on_inbound after insert on public.support_messages
  for each row execute function private.support_on_inbound();

-- -----------------------------------------------------------------------------
-- 6. SLA monitor: warnings, breaches, escalation levels (each once)
-- -----------------------------------------------------------------------------
create or replace function public.support_sla_run(p_company uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.support_tickets;
  p public.support_sla_policies;
  r public.support_ticket_rules;
  lv public.support_sla_escalation_levels;
  v_now timestamptz := now();
  v_warn integer := 0;
  v_breach integer := 0;
  v_esc integer := 0;
  v_target text;
  v_due timestamptz;
  v_total integer;
  v_elapsed integer;
  v_rows integer;
begin
  for t in select * from public.support_tickets x
           where (p_company is null or x.company_id = p_company) and x.status not in ('RESOLVED', 'CLOSED') and x.merged_into_ticket_id is null
             and x.sla_paused_at is null and x.sla_policy_id is not null
           order by x.company_id, x.created_at loop
    select * into p from public.support_sla_policies where id = t.sla_policy_id;
    r := private.support_rules(t.company_id);
    foreach v_target in array array['FIRST_RESPONSE', 'RESOLUTION'] loop
      continue when v_target = 'FIRST_RESPONSE' and t.first_response_at is not null;
      v_due := case v_target when 'FIRST_RESPONSE' then t.first_response_due_at else t.due_at end;
      continue when v_due is null;
      v_total := case v_target when 'FIRST_RESPONSE' then p.first_response_minutes else p.resolution_minutes end;
      v_elapsed := private.support_business_minutes(t.company_id, t.created_at, v_now) - t.sla_paused_minutes;
      if v_now >= v_due then
        insert into public.support_ticket_escalations (company_id, ticket_id, kind, target, level, details)
        values (t.company_id, t.id, 'BREACH', v_target, 0, jsonb_build_object('due_at', v_due)) on conflict do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then
          v_breach := v_breach + 1;
          if v_target = 'FIRST_RESPONSE' then
            update public.support_tickets set first_response_breached_at = v_now where id = t.id;
          else
            update public.support_tickets set resolution_breached_at = v_now where id = t.id;
          end if;
          perform private.support_ticket_event(t.id, 'SLA_BREACHED', null, v_target, jsonb_build_object('due_at', v_due));
          perform private.support_notify(t.company_id, t.assigned_agent_id, 'SUPPORT_SLA_BREACH', 'SLA breached: ' || t.ticket_number,
            replace(lower(v_target), '_', ' ') || ' target passed — ' || left(t.subject, 120), 'HIGH', 'SUPPORT_TICKET', t.id::text, '/support/tickets/' || t.id,
            'support:sla-breach:' || t.id || ':' || v_target, true);
        end if;
        -- Escalation levels for breached tickets of the configured priorities.
        if r.escalate_on_breach_enabled and t.priority = any (r.escalate_priorities) then
          for lv in select * from public.support_sla_escalation_levels l
                    where l.company_id = t.company_id and l.is_active and (cardinality(l.priorities) = 0 or t.priority = any (l.priorities))
                      and v_now >= v_due + make_interval(mins => l.after_minutes)
                    order by l.level loop
            insert into public.support_ticket_escalations (company_id, ticket_id, kind, target, level, details)
            values (t.company_id, t.id, 'ESCALATION', v_target, lv.level, jsonb_build_object('reassign_agent_id', lv.reassign_agent_id, 'department', lv.set_department,
              'raise_priority', lv.raise_priority)) on conflict do nothing;
            get diagnostics v_rows = row_count;
            continue when v_rows = 0;
            v_esc := v_esc + 1;
            update public.support_tickets set
              assigned_agent_id = coalesce(lv.reassign_agent_id, assigned_agent_id),
              department = coalesce(lv.set_department, department),
              priority = case when lv.raise_priority then case priority when 'LOW' then 'NORMAL' when 'NORMAL' then 'HIGH' else 'URGENT' end else priority end
            where id = t.id;
            perform private.support_ticket_event(t.id, 'ESCALATED', null, 'Level ' || lv.level, jsonb_build_object('target', v_target, 'level', lv.level));
            if lv.notify_assignee or lv.notify_managers then
              perform private.support_notify(t.company_id, case when lv.notify_assignee then coalesce(lv.reassign_agent_id, t.assigned_agent_id) end,
                'SUPPORT_SLA_BREACH', format('Escalation level %s: %s', lv.level, t.ticket_number), 'Breached ' || replace(lower(v_target), '_', ' ') || ' — ' || left(t.subject, 120),
                'CRITICAL', 'SUPPORT_TICKET', t.id::text, '/support/tickets/' || t.id, 'support:sla-esc:' || t.id || ':' || v_target || ':' || lv.level, lv.notify_managers);
            end if;
          end loop;
        end if;
      elsif v_total > 0 and v_elapsed * 100 >= v_total * r.sla_warning_percent then
        insert into public.support_ticket_escalations (company_id, ticket_id, kind, target, level, details)
        values (t.company_id, t.id, 'WARNING', v_target, 0, jsonb_build_object('due_at', v_due, 'elapsed_minutes', v_elapsed, 'target_minutes', v_total)) on conflict do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then
          v_warn := v_warn + 1;
          perform private.support_ticket_event(t.id, 'SLA_WARNING', null, v_target, jsonb_build_object('due_at', v_due));
          perform private.support_notify(t.company_id, t.assigned_agent_id, 'SUPPORT_SLA_WARNING', 'SLA at risk: ' || t.ticket_number,
            replace(lower(v_target), '_', ' ') || ' due ' || to_char(v_due at time zone coalesce(private.company_tz(t.company_id), 'Asia/Kolkata'), 'DD Mon HH24:MI') || ' — ' || left(t.subject, 100),
            'MEDIUM', 'SUPPORT_TICKET', t.id::text, '/support/tickets/' || t.id, 'support:sla-warn:' || t.id || ':' || v_target);
        end if;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('warnings', v_warn, 'breaches', v_breach, 'escalations', v_esc, 'at', v_now);
end;
$$;

-- Administrators can run the monitor now for their own company.
create or replace function public.support_sla_run_now()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
begin
  return public.support_sla_run(v_company);
end;
$$;

-- Remaining SLA time, breaches, pause and escalation history of a ticket.
create or replace function public.support_ticket_sla(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  t public.support_tickets;
  p public.support_sla_policies;
begin
  select * into t from public.support_tickets where id = p_ticket and company_id = v_company;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  select * into p from public.support_sla_policies where id = t.sla_policy_id;
  return jsonb_build_object(
    'policy', case when p.id is null then null else jsonb_build_object('name', p.name, 'first_response_minutes', p.first_response_minutes, 'resolution_minutes', p.resolution_minutes) end,
    'status', private.support_sla_status(t),
    'business_hours', coalesce((select enabled from public.support_business_calendar where company_id = v_company), false),
    'paused', t.sla_paused_at is not null, 'paused_since', t.sla_paused_at, 'paused_minutes', t.sla_paused_minutes,
    'first_response', jsonb_build_object('due_at', t.first_response_due_at, 'done_at', t.first_response_at, 'breached_at', t.first_response_breached_at,
      'breached', t.first_response_due_at is not null and coalesce(t.first_response_at, now()) > t.first_response_due_at,
      'remaining_minutes', case when t.first_response_at is null and t.first_response_due_at is not null and t.sla_paused_at is null then
        case when now() < t.first_response_due_at then private.support_business_minutes(v_company, now(), t.first_response_due_at)
             else -private.support_business_minutes(v_company, t.first_response_due_at, now()) end end),
    'resolution', jsonb_build_object('due_at', t.due_at, 'done_at', t.resolved_at, 'breached_at', t.resolution_breached_at,
      'breached', t.due_at is not null and coalesce(t.resolved_at, now()) > t.due_at,
      'remaining_minutes', case when t.resolved_at is null and t.due_at is not null and t.sla_paused_at is null then
        case when now() < t.due_at then private.support_business_minutes(v_company, now(), t.due_at)
             else -private.support_business_minutes(v_company, t.due_at, now()) end end),
    'history', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'target', e.target, 'level', e.level, 'at', e.created_at, 'details', e.details) order by e.created_at)
                         from public.support_ticket_escalations e where e.ticket_id = t.id), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Settings (support.manage_settings)
-- -----------------------------------------------------------------------------
create or replace function public.support_automation_settings_get()
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
    'rules', to_jsonb(private.support_rules(v_company)) - 'company_id' - 'updated_by',
    'calendar', coalesce((select to_jsonb(c) - 'company_id' - 'updated_by' from public.support_business_calendar c where c.company_id = v_company),
                         jsonb_build_object('enabled', false, 'timezone', private.company_tz(v_company), 'working_days', array[1, 2, 3, 4, 5, 6], 'start_time', '09:30:00',
                           'end_time', '18:30:00', 'pause_when_waiting_customer', true)),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'date', h.holiday_date, 'name', h.name) order by h.holiday_date)
                          from public.support_holidays h where h.company_id = v_company and h.holiday_date >= current_date - 30), '[]'::jsonb),
    'levels', coalesce((select jsonb_agg(to_jsonb(l) - 'company_id' - 'updated_by' order by l.level) from public.support_sla_escalation_levels l where l.company_id = v_company), '[]'::jsonb),
    'assignment', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' - 'updated_by' order by a.run_order, a.created_at) from public.support_assignment_rules a where a.company_id = v_company), '[]'::jsonb),
    'can_edit', private.has_permission(v_company, 'support.manage_settings'));
end;
$$;

create or replace function public.support_ticket_rules_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_email text[];
  v_wa text[];
begin
  select coalesce(array_agg(distinct left(btrim(k), 80)) filter (where btrim(k) <> ''), '{}') into v_email from jsonb_array_elements_text(coalesce(p -> 'email_keywords', '[]'::jsonb)) k;
  select coalesce(array_agg(distinct left(btrim(k), 80)) filter (where btrim(k) <> ''), '{}') into v_wa from jsonb_array_elements_text(coalesce(p -> 'whatsapp_keywords', '[]'::jsonb)) k;
  if coalesce((p ->> 'email_keywords_enabled')::boolean, false) and cardinality(v_email) = 0 then
    raise exception 'Enter at least one email keyword or switch the email rule off.' using errcode = 'P0001';
  end if;
  if coalesce((p ->> 'whatsapp_keywords_enabled')::boolean, false) and cardinality(v_wa) = 0 then
    raise exception 'Enter at least one WhatsApp keyword or switch the WhatsApp rule off.' using errcode = 'P0001';
  end if;
  insert into public.support_ticket_rules (company_id, ticket_mode, new_conversation_priority, missed_call_enabled, missed_call_priority, email_keywords_enabled, email_keywords,
    email_match_body, whatsapp_keywords_enabled, whatsapp_keywords, keyword_priority, reopen_on_reply_enabled, escalate_on_breach_enabled, escalate_priorities, sla_warning_percent, updated_by)
  values (v_company, coalesce(p ->> 'ticket_mode', 'AGENT_REQUEST_ONLY'), coalesce(p ->> 'new_conversation_priority', 'NORMAL'), coalesce((p ->> 'missed_call_enabled')::boolean, false),
    coalesce(p ->> 'missed_call_priority', 'HIGH'), coalesce((p ->> 'email_keywords_enabled')::boolean, false), v_email, coalesce((p ->> 'email_match_body')::boolean, false),
    coalesce((p ->> 'whatsapp_keywords_enabled')::boolean, false), v_wa, coalesce(p ->> 'keyword_priority', 'NORMAL'), coalesce((p ->> 'reopen_on_reply_enabled')::boolean, true),
    coalesce((p ->> 'escalate_on_breach_enabled')::boolean, false),
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'escalate_priorities', '["URGENT"]'::jsonb)) x), array['URGENT']),
    coalesce(nullif(p ->> 'sla_warning_percent', '')::integer, 80), auth.uid())
  on conflict (company_id) do update set ticket_mode = excluded.ticket_mode, new_conversation_priority = excluded.new_conversation_priority,
    missed_call_enabled = excluded.missed_call_enabled, missed_call_priority = excluded.missed_call_priority, email_keywords_enabled = excluded.email_keywords_enabled,
    email_keywords = excluded.email_keywords, email_match_body = excluded.email_match_body, whatsapp_keywords_enabled = excluded.whatsapp_keywords_enabled,
    whatsapp_keywords = excluded.whatsapp_keywords, keyword_priority = excluded.keyword_priority, reopen_on_reply_enabled = excluded.reopen_on_reply_enabled,
    escalate_on_breach_enabled = excluded.escalate_on_breach_enabled, escalate_priorities = excluded.escalate_priorities, sla_warning_percent = excluded.sla_warning_percent,
    updated_by = auth.uid();
  return public.support_automation_settings_get();
end;
$$;

create or replace function public.support_business_calendar_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_days integer[];
  v_tz text := nullif(btrim(coalesce(p ->> 'timezone', '')), '');
begin
  select coalesce(array_agg(distinct x::int order by x::int), '{}') into v_days from jsonb_array_elements_text(coalesce(p -> 'working_days', '[]'::jsonb)) x;
  if cardinality(v_days) = 0 or not (v_days <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'Choose at least one working day.' using errcode = 'P0001';
  end if;
  if v_tz is not null and not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone %.', v_tz using errcode = 'P0001';
  end if;
  if (p ->> 'end_time')::time <= (p ->> 'start_time')::time then
    raise exception 'The working day must end after it starts.' using errcode = 'P0001';
  end if;
  insert into public.support_business_calendar (company_id, enabled, timezone, working_days, start_time, end_time, pause_when_waiting_customer, updated_by)
  values (v_company, coalesce((p ->> 'enabled')::boolean, false), v_tz, v_days, (p ->> 'start_time')::time, (p ->> 'end_time')::time,
    coalesce((p ->> 'pause_when_waiting_customer')::boolean, true), auth.uid())
  on conflict (company_id) do update set enabled = excluded.enabled, timezone = excluded.timezone, working_days = excluded.working_days, start_time = excluded.start_time,
    end_time = excluded.end_time, pause_when_waiting_customer = excluded.pause_when_waiting_customer, updated_by = auth.uid();
  return public.support_automation_settings_get();
end;
$$;

create or replace function public.support_holiday_save(p_date date, p_name text, p_delete boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
begin
  if p_date is null then
    raise exception 'Choose the date.' using errcode = 'P0001';
  end if;
  if p_delete then
    delete from public.support_holidays where company_id = v_company and holiday_date = p_date;
  else
    if nullif(btrim(coalesce(p_name, '')), '') is null then
      raise exception 'Enter the holiday name.' using errcode = 'P0001';
    end if;
    insert into public.support_holidays (company_id, holiday_date, name, created_by) values (v_company, p_date, left(btrim(p_name), 120), auth.uid())
    on conflict (company_id, holiday_date) do update set name = excluded.name;
  end if;
  return public.support_automation_settings_get();
end;
$$;

create or replace function public.support_escalation_level_save(p_level integer, p jsonb, p_delete boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_agent uuid := nullif(p ->> 'reassign_agent_id', '')::uuid;
begin
  if p_level is null or p_level not between 1 and 5 then
    raise exception 'Escalation levels are 1 to 5.' using errcode = 'P0001';
  end if;
  if p_delete then
    delete from public.support_sla_escalation_levels where company_id = v_company and level = p_level;
    return public.support_automation_settings_get();
  end if;
  if v_agent is not null then
    perform private.support_agent_of(v_company, v_agent);
  end if;
  insert into public.support_sla_escalation_levels (company_id, level, after_minutes, priorities, notify_assignee, notify_managers, reassign_agent_id, set_department, raise_priority,
    is_active, updated_by)
  values (v_company, p_level, coalesce(nullif(p ->> 'after_minutes', '')::integer, 0),
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'priorities', '[]'::jsonb)) x), '{}'),
    coalesce((p ->> 'notify_assignee')::boolean, true), coalesce((p ->> 'notify_managers')::boolean, true), v_agent, private.support_text(p, 'set_department', 80),
    coalesce((p ->> 'raise_priority')::boolean, false), coalesce((p ->> 'is_active')::boolean, true), auth.uid())
  on conflict (company_id, level) do update set after_minutes = excluded.after_minutes, priorities = excluded.priorities, notify_assignee = excluded.notify_assignee,
    notify_managers = excluded.notify_managers, reassign_agent_id = excluded.reassign_agent_id, set_department = excluded.set_department, raise_priority = excluded.raise_priority,
    is_active = excluded.is_active, updated_by = auth.uid();
  return public.support_automation_settings_get();
end;
$$;

create or replace function public.support_assignment_rule_save(p_id uuid, p jsonb, p_delete boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_settings');
  v_agent uuid := nullif(p ->> 'agent_id', '')::uuid;
  v_name text := private.support_text(p, 'name', 120);
begin
  if p_delete then
    delete from public.support_assignment_rules where id = p_id and company_id = v_company;
    return public.support_automation_settings_get();
  end if;
  if v_name is null then
    raise exception 'Enter the rule name.' using errcode = 'P0001';
  end if;
  if v_agent is not null then
    perform private.support_agent_of(v_company, v_agent);
  end if;
  if v_agent is null and private.support_text(p, 'department', 80) is null then
    raise exception 'Choose an agent or a department.' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.support_assignment_rules (company_id, name, channel, priority, department, agent_id, run_order, is_active, updated_by)
    values (v_company, v_name, nullif(upper(p ->> 'channel'), ''), nullif(upper(p ->> 'priority'), ''), private.support_text(p, 'department', 80), v_agent,
      coalesce(nullif(p ->> 'run_order', '')::integer, 100), coalesce((p ->> 'is_active')::boolean, true), auth.uid());
  else
    update public.support_assignment_rules set name = v_name, channel = nullif(upper(p ->> 'channel'), ''), priority = nullif(upper(p ->> 'priority'), ''),
      department = private.support_text(p, 'department', 80), agent_id = v_agent, run_order = coalesce(nullif(p ->> 'run_order', '')::integer, run_order),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active), updated_by = auth.uid()
    where id = p_id and company_id = v_company;
    if not found then
      raise exception 'Rule not found in your company.' using errcode = 'P0001';
    end if;
  end if;
  return public.support_automation_settings_get();
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Unified reports (support.view_reports)
-- -----------------------------------------------------------------------------
create or replace function public.support_reports_unified(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view_reports');
  v_tz text := coalesce(private.company_tz(v_company), 'Asia/Kolkata');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  return (
    with m as (
      select x.*, c.channel, (x.occurred_at at time zone v_tz)::date as day from public.support_messages x join public.support_conversations c on c.id = x.conversation_id
      where x.company_id = v_company and (x.occurred_at at time zone v_tz)::date between p_from and p_to),
    seq as (
      -- Customer turns: an inbound message that follows an outbound one (or opens the conversation); response = next outbound.
      select x.id, x.conversation_id, c.channel, x.occurred_at, x.direction,
        lag(x.direction) over (partition by x.conversation_id order by x.occurred_at, x.created_at) as prev_dir
      from public.support_messages x join public.support_conversations c on c.id = x.conversation_id
      where x.company_id = v_company and c.channel in ('EMAIL', 'WHATSAPP') and x.kind <> 'CALL'),
    turns as (
      select s.channel, s.occurred_at,
        (select min(o.occurred_at) from public.support_messages o where o.conversation_id = s.conversation_id and o.direction = 'OUTBOUND' and o.occurred_at >= s.occurred_at) as replied_at
      from seq s where s.direction = 'INBOUND' and (s.prev_dir is null or s.prev_dir = 'OUTBOUND') and (s.occurred_at at time zone v_tz)::date between p_from and p_to),
    calls as (
      select x.* from public.support_calls x where x.company_id = v_company and x.direction = 'INBOUND' and (coalesce(x.started_at, x.created_at) at time zone v_tz)::date between p_from and p_to),
    t as (select x.*, (x.created_at at time zone v_tz)::date as cday from public.support_tickets x where x.company_id = v_company and x.merged_into_ticket_id is null)
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'channel_volume', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'phone', ph, 'whatsapp', wa, 'email', em) order by d) from (
          select day d, count(*) filter (where channel = 'PHONE') ph, count(*) filter (where channel = 'WHATSAPP') wa, count(*) filter (where channel = 'EMAIL') em
          from m where direction = 'INBOUND' group by day) z), '[]'::jsonb),
      'channel_totals', jsonb_build_object('phone', (select count(*) from m where direction = 'INBOUND' and channel = 'PHONE'),
          'whatsapp', (select count(*) from m where direction = 'INBOUND' and channel = 'WHATSAPP'), 'email', (select count(*) from m where direction = 'INBOUND' and channel = 'EMAIL')),
      'calls', (select jsonb_build_object('inbound', count(*) filter (where status in ('COMPLETED', 'MISSED')),
          'answered', count(*) filter (where status = 'COMPLETED'), 'missed', count(*) filter (where status = 'MISSED'),
          'answer_rate', round(100.0 * count(*) filter (where status = 'COMPLETED') / nullif(count(*) filter (where status in ('COMPLETED', 'MISSED')), 0), 1),
          'missed_rate', round(100.0 * count(*) filter (where status = 'MISSED') / nullif(count(*) filter (where status in ('COMPLETED', 'MISSED')), 0), 1),
          'avg_talk_seconds', round(avg(talk_seconds) filter (where status = 'COMPLETED'))) from calls),
      'response_times', (select jsonb_object_agg(ch, v) from (
          select ch, jsonb_build_object('turns', count(*), 'answered', count(replied_at),
            'avg_minutes', round(avg(extract(epoch from (replied_at - occurred_at)) / 60)::numeric, 1),
            'median_minutes', round((percentile_cont(0.5) within group (order by extract(epoch from (replied_at - occurred_at)) / 60))::numeric, 1),
            'within_1h_percent', round(100.0 * count(*) filter (where replied_at - occurred_at <= interval '1 hour') / nullif(count(replied_at), 0), 1)) v
          from (select lower(channel) ch, occurred_at, replied_at from turns) x group by ch) y),
      'tickets', (select jsonb_build_object('created', count(*) filter (where cday between p_from and p_to),
          'closed', count(*) filter (where cday between p_from and p_to and status in ('RESOLVED', 'CLOSED')),
          'closure_rate', round(100.0 * count(*) filter (where cday between p_from and p_to and status in ('RESOLVED', 'CLOSED')) / nullif(count(*) filter (where cday between p_from and p_to), 0), 1),
          'resolved_in_period', count(*) filter (where (resolved_at at time zone v_tz)::date between p_from and p_to),
          'open_now', count(*) filter (where status not in ('RESOLVED', 'CLOSED')),
          'reopened', count(*) filter (where cday between p_from and p_to and reopen_count > 0),
          'by_channel', (select jsonb_object_agg(lower(channel), n) from (select channel, count(*) n from t where cday between p_from and p_to group by channel) q)) from t),
      'agents', coalesce((select jsonb_agg(jsonb_build_object('agent', a.display_name, 'open_tickets',
            (select count(*) from t where t.assigned_agent_id = a.id and t.status not in ('RESOLVED', 'CLOSED')),
          'open_conversations', (select count(*) from public.support_conversations c where c.assigned_agent_id = a.id and c.status <> 'RESOLVED'),
          'resolved', (select count(*) from t where t.assigned_agent_id = a.id and (t.resolved_at at time zone v_tz)::date between p_from and p_to),
          'replies', (select count(*) from m where m.direction = 'OUTBOUND' and m.author_user_id = a.user_id)) order by a.display_name)
          from public.support_agents a where a.company_id = v_company and a.is_active), '[]'::jsonb),
      'sla', (select jsonb_build_object('tickets', count(*),
          'first_response_met', count(*) filter (where first_response_at is not null and first_response_at <= first_response_due_at),
          'first_response_breached', count(*) filter (where coalesce(first_response_at, now()) > first_response_due_at),
          'resolution_met', count(*) filter (where resolved_at is not null and resolved_at <= due_at),
          'resolution_breached', count(*) filter (where coalesce(resolved_at, now()) > due_at),
          'compliance_percent', round(100.0 * count(*) filter (where (resolved_at is not null and resolved_at <= due_at) or (resolved_at is null and now() <= due_at))
                                       / nullif(count(*), 0), 1),
          'escalations', (select count(*) from public.support_ticket_escalations e where e.company_id = v_company and e.kind = 'ESCALATION'
                            and (e.created_at at time zone v_tz)::date between p_from and p_to))
          from t where due_at is not null and cday between p_from and p_to),
      'csat', (select jsonb_build_object('responses', count(csat_rating), 'average', round(avg(csat_rating)::numeric, 2),
          'distribution', (select jsonb_object_agg(r, n) from (select csat_rating r, count(*) n from t where csat_rating is not null and cday between p_from and p_to group by 1) q))
          from t where cday between p_from and p_to)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Integration health (support.manage_integrations)
-- -----------------------------------------------------------------------------
create or replace function public.support_integration_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_integrations');
  ph public.support_phone_config;
  em public.support_email_config;
  wa public.support_whatsapp_config;
  v jsonb := '[]'::jsonb;
  acc public.support_channel_accounts;
begin
  select * into ph from public.support_phone_config where company_id = v_company;
  select * into em from public.support_email_config where company_id = v_company;
  select * into wa from public.support_whatsapp_config where company_id = v_company;

  -- Acefone: CONNECTED is only ever set by a successful API connection test.
  select * into acc from public.support_channel_accounts where id = ph.channel_account_id;
  v := v || jsonb_build_array(jsonb_build_object('provider', 'ACEFONE', 'channel', 'PHONE', 'configured', ph.company_id is not null,
    'status', coalesce(acc.status, 'NOT_CONNECTED'), 'status_detail', acc.status_detail,
    'verified_by_test_at', case when acc.status = 'CONNECTED' then ph.last_test_at end,
    'last_sync_at', ph.last_sync_at, 'last_sync_status', ph.last_sync_status, 'last_webhook_at', ph.last_event_at,
    'last_outbound_at', (select max(created_at) from public.support_calls where company_id = v_company and direction = 'OUTBOUND' and request_state = 'ACCEPTED'),
    'failed_events_7d', (select count(*) from public.support_integration_events where company_id = v_company and channel_account_id = ph.channel_account_id
                         and processing_result in ('ERROR', 'REJECTED') and created_at > now() - interval '7 days'),
    'retry_queue', (select count(*) from public.support_integration_events where company_id = v_company and channel_account_id = ph.channel_account_id and processing_result = 'ERROR')
                   + (select count(*) from public.support_calls where company_id = v_company and request_state = 'ERROR' and status = 'INITIATED'),
    'expired_credentials', false,
    'errors', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'message', coalesce(e.processing_error, e.message)) order by e.created_at desc) from (
        select * from public.support_integration_events where company_id = v_company and channel_account_id = ph.channel_account_id
          and (processing_result in ('ERROR', 'REJECTED') or event_type = 'ERROR') order by created_at desc limit 5) e), '[]'::jsonb),
    'test_action', 'acefone-click-to-call'));

  -- Gmail: CONNECTED only after the OAuth code exchange and a Gmail API call succeeded.
  select * into acc from public.support_channel_accounts where id = em.channel_account_id;
  v := v || jsonb_build_array(jsonb_build_object('provider', 'GOOGLE_WORKSPACE', 'channel', 'EMAIL', 'configured', em.company_id is not null,
    'status', coalesce(acc.status, 'NOT_CONNECTED'), 'status_detail', acc.status_detail,
    'verified_by_test_at', case when acc.status = 'CONNECTED' then coalesce(em.last_sync_at, em.connected_at) end,
    'last_sync_at', em.last_sync_at, 'last_sync_status', em.last_sync_status, 'last_webhook_at', em.last_push_at,
    'last_outbound_at', (select max(internal_date) from public.support_email_messages where company_id = v_company and send_state = 'SENT' and requested_by is not null),
    'failed_events_7d', (select count(*) from public.support_integration_events where company_id = v_company and channel_account_id = em.channel_account_id
                         and processing_result = 'ERROR' and created_at > now() - interval '7 days'),
    'retry_queue', (select count(*) from public.support_email_messages where company_id = v_company and send_state = 'PENDING')
                   + (select count(*) from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where m.company_id = v_company and a ->> 'state' in ('PENDING', 'FAILED')),
    'expired_credentials', acc.status = 'REAUTHORIZATION_REQUIRED',
    'errors', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'message', coalesce(e.processing_error, e.message)) order by e.created_at desc) from (
        select * from public.support_integration_events where company_id = v_company and channel_account_id = em.channel_account_id
          and (processing_result = 'ERROR' or event_type = 'ERROR' or status = 'REAUTHORIZATION_REQUIRED') order by created_at desc limit 5) e), '[]'::jsonb),
    'test_action', 'google-oauth-start'));

  -- WhatsApp: CONNECTED only after the Meta connection test, webhook verification and the switch-on.
  select * into acc from public.support_channel_accounts where id = wa.channel_account_id;
  v := v || jsonb_build_array(jsonb_build_object('provider', 'META_WHATSAPP', 'channel', 'WHATSAPP', 'configured', wa.company_id is not null,
    'status', coalesce(acc.status, 'NOT_CONNECTED'), 'status_detail', acc.status_detail, 'setup_state', wa.setup_state, 'enabled', wa.integration_enabled,
    'verified_by_test_at', case when acc.status = 'CONNECTED' and wa.last_test_ok then wa.last_test_at end,
    'last_sync_at', greatest(wa.templates_synced_at, wa.last_test_at), 'last_sync_status', wa.last_test_result, 'last_webhook_at', wa.last_webhook_at,
    'last_outbound_at', wa.last_outbound_success_at,
    'failed_events_7d', (select count(*) from public.support_whatsapp_webhook_events where company_id = v_company and result in ('ERROR', 'REJECTED') and received_at > now() - interval '7 days')
                        + (select count(*) from public.support_whatsapp_messages where company_id = v_company and status = 'FAILED' and created_at > now() - interval '7 days'),
    'retry_queue', (select count(*) from public.support_whatsapp_webhook_events where company_id = v_company and result in ('ERROR', 'HELD'))
                   + (select count(*) from public.support_whatsapp_messages where company_id = v_company and media_state in ('PENDING', 'FAILED')),
    'expired_credentials', coalesce(wa.last_test_ok = false and wa.last_test_result ilike '%(190)%', false),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('at', x.at, 'message', x.message) order by x.at desc) from (
        select received_at at, coalesce(error, result) message from public.support_whatsapp_webhook_events where company_id = v_company and result in ('ERROR', 'REJECTED')
        union all select last_error_at, last_error from public.support_whatsapp_config where company_id = v_company and last_error is not null
        order by 1 desc limit 5) x), '[]'::jsonb),
    'test_action', 'whatsapp-sync-status'));
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------
revoke all on function private.support_business_add(uuid, timestamptz, integer), private.support_business_minutes(uuid, timestamptz, timestamptz),
  private.support_ticket_sla_pause(), private.support_notify(uuid, uuid, text, text, text, text, text, text, text, text, boolean), private.support_ticket_assigned_notify(),
  private.support_ticket_assign_rules(), private.support_call_incoming_notify(), private.support_rules(uuid), private.support_keyword_hit(text, text[]),
  private.support_ticket_auto(uuid, text, text, text), private.support_on_inbound() from public, anon, authenticated;
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('support_sla_run_now', 'support_ticket_sla', 'support_automation_settings_get', 'support_ticket_rules_save',
             'support_business_calendar_save', 'support_holiday_save', 'support_escalation_level_save', 'support_assignment_rule_save', 'support_reports_unified',
             'support_integration_health') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function public.support_sla_run(uuid) from public, anon, authenticated;
grant execute on function public.support_sla_run(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 11. ERP reset allowlist (20261213090000 plus the new support tables)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
