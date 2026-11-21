-- =============================================================================
-- Customer Support pipelines (Kanban stages for support tickets)
--
-- Additive. The ticket status of 20261210090000 stays the single source of truth for SLA, closure, reopening,
-- automation and reports; a pipeline stage is a configurable column that stands for a ticket status:
--
--   * support_pipelines            pipelines per company ("Customer Support" is created for every company)
--   * support_pipeline_stages      OPEN / CLOSED stages; CLOSED stages carry a POSITIVE / NEGATIVE outcome;
--                                  ticket_status = the status a ticket gets when it is moved into the stage
--   * support_ticket_stage_history every stage change (from / to stage and status, user, time, source, note)
--   * support_tickets.pipeline_id / stage_id (new columns, kept in step with the status by triggers)
--
--   Moving a ticket (support_ticket_move_stage) never writes the status itself: it calls the existing
--   support_ticket_update (closing, status rules, SLA pause) and support_ticket_reopen (reason, reopen count),
--   then sets the stage, all in one transaction with an expected-stage check against concurrent moves.
--   A status changed anywhere else (ticket page, inbound reply reopening, automation) moves the card to the
--   matching stage and is recorded in the stage history too.
--
--   Existing tickets: statuses are NOT changed. They are placed by status:
--     NEW → New Ticket · OPEN, IN_PROGRESS → In Progress · WAITING_CUSTOMER, WAITING_INTERNAL → On Hold ·
--     RESOLVED, CLOSED → Closed – Positive.   History starts at the ticket's last status change (from its events).
--
--   Permissions: support_pipelines.view / create / update / delete / manage_stages, support_tickets.move_stage.
--
-- Rollback: supabase/rollback/20261227090000_support_pipelines_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('support_pipelines', 'view', 'See support pipelines (Kanban board, list and pipeline reports)'),
  ('support_pipelines', 'create', 'Create support pipelines'),
  ('support_pipelines', 'update', 'Rename support pipelines and choose the default pipeline'),
  ('support_pipelines', 'delete', 'Deactivate support pipelines'),
  ('support_pipelines', 'manage_stages', 'Add, rename, reorder, classify and deactivate pipeline stages'),
  ('support_tickets', 'move_stage', 'Move support tickets between pipeline stages (status rules still apply)')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.resource = 'support_pipelines' or p.code = 'support_tickets.move_stage'
where r.code in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;
-- Other roles follow their existing Support Centre access: viewing the board with support.view,
-- moving tickets with support.manage_tickets (which the status changes behind a move need anyway).
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, p.id from public.role_permissions rp join public.permissions src on src.id = rp.permission_id and src.code = 'support.view'
join public.permissions p on p.code = 'support_pipelines.view'
on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, p.id from public.role_permissions rp join public.permissions src on src.id = rp.permission_id and src.code = 'support.manage_tickets'
join public.permissions p on p.code = 'support_tickets.move_stage'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.support_pipelines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  name         text not null check (length(btrim(name)) between 1 and 80 and name = btrim(name)),
  description  text check (description is null or length(description) <= 500),
  is_default   boolean not null default false,
  is_active    boolean not null default true,
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint support_pipelines_id_company_unique unique (id, company_id),
  constraint support_pipelines_default_active check (not is_default or is_active)
);
create unique index if not exists support_pipelines_name_unique on public.support_pipelines (company_id, lower(name));
create unique index if not exists support_pipelines_one_default on public.support_pipelines (company_id) where is_default;

create table if not exists public.support_pipeline_stages (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  pipeline_id        uuid not null,
  stage_name         text not null check (length(btrim(stage_name)) between 1 and 60 and stage_name = btrim(stage_name)),
  stage_description  text check (stage_description is null or length(stage_description) <= 300),
  stage_type         text not null check (stage_type in ('OPEN', 'CLOSED')),
  outcome_type       text check (outcome_type is null or outcome_type in ('POSITIVE', 'NEGATIVE')),
  ticket_status      text not null check (ticket_status in ('NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED')),
  display_order      integer not null check (display_order between 0 and 100000),
  color              text not null default '#64748b' check (color ~ '^#[0-9a-f]{6}$'),
  is_default         boolean not null default false,
  is_active          boolean not null default true,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint support_pipeline_stages_id_company_unique unique (id, company_id),
  constraint support_pipeline_stages_full_unique unique (id, pipeline_id, company_id),
  constraint support_pipeline_stages_pipeline_fk foreign key (pipeline_id, company_id) references public.support_pipelines (id, company_id) on delete restrict,
  constraint support_pipeline_stages_outcome check ((stage_type = 'CLOSED') = (outcome_type is not null)),
  constraint support_pipeline_stages_status_fits check (
    (stage_type = 'OPEN' and ticket_status in ('NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'))
    or (stage_type = 'CLOSED' and ticket_status in ('RESOLVED', 'CLOSED'))),
  constraint support_pipeline_stages_default_open check (not is_default or (stage_type = 'OPEN' and is_active))
);
create unique index if not exists support_pipeline_stages_name_unique on public.support_pipeline_stages (pipeline_id, lower(stage_name));
create unique index if not exists support_pipeline_stages_one_default on public.support_pipeline_stages (pipeline_id) where is_default;
create index if not exists support_pipeline_stages_pipeline_idx on public.support_pipeline_stages (pipeline_id, stage_type, display_order);

alter table public.support_tickets add column if not exists pipeline_id uuid;
alter table public.support_tickets add column if not exists stage_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_pipeline_fk') then
    alter table public.support_tickets add constraint support_tickets_pipeline_fk foreign key (pipeline_id, company_id)
      references public.support_pipelines (id, company_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_stage_fk') then
    alter table public.support_tickets add constraint support_tickets_stage_fk foreign key (stage_id, pipeline_id, company_id)
      references public.support_pipeline_stages (id, pipeline_id, company_id) on delete restrict;
  end if;
end;
$$;
create index if not exists support_tickets_pipeline_stage_idx on public.support_tickets (company_id, pipeline_id, stage_id);
create index if not exists support_tickets_stage_idx on public.support_tickets (stage_id);

create table if not exists public.support_ticket_stage_history (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  ticket_id      uuid not null,
  pipeline_id    uuid not null,
  from_stage_id  uuid,
  to_stage_id    uuid not null,
  from_status    text,
  to_status      text not null,
  source         text not null check (source in ('CREATED', 'MOVE', 'STATUS_CHANGE', 'STAGE_DEACTIVATED', 'MIGRATION')),
  changed_by     uuid,
  changed_at     timestamptz not null default now(),
  notes          text check (notes is null or length(notes) <= 500),
  constraint support_ticket_stage_history_ticket_fk foreign key (ticket_id, company_id) references public.support_tickets (id, company_id) on delete restrict,
  constraint support_ticket_stage_history_pipeline_fk foreign key (pipeline_id, company_id) references public.support_pipelines (id, company_id) on delete restrict,
  constraint support_ticket_stage_history_to_fk foreign key (to_stage_id, company_id) references public.support_pipeline_stages (id, company_id) on delete restrict,
  constraint support_ticket_stage_history_from_fk foreign key (from_stage_id, company_id) references public.support_pipeline_stages (id, company_id) on delete restrict
);
create index if not exists support_ticket_stage_history_ticket_idx on public.support_ticket_stage_history (ticket_id, changed_at);
create index if not exists support_ticket_stage_history_pipeline_idx on public.support_ticket_stage_history (company_id, pipeline_id, changed_at);
create index if not exists support_ticket_stage_history_to_idx on public.support_ticket_stage_history (to_stage_id);
create index if not exists support_ticket_stage_history_from_idx on public.support_ticket_stage_history (from_stage_id);

-- Stage changes appear in the ticket's activity history as well.
alter table public.support_ticket_events drop constraint if exists support_ticket_events_event_type_check;
alter table public.support_ticket_events add constraint support_ticket_events_event_type_check
  check (event_type in ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'UPDATED', 'MERGED', 'MERGED_INTO',
                        'REOPENED', 'NOTE_ADDED', 'ATTACHMENT_ADDED', 'CONVERSATION_LINKED', 'FIRST_RESPONSE', 'AUTOMATION', 'CSAT_RECORDED',
                        'SLA_WARNING', 'SLA_BREACHED', 'ESCALATED', 'STAGE_CHANGED'));

-- RLS: select only; writes go through the functions below. History is append-only.
do $$
declare
  t text;
begin
  foreach t in array array['support_pipelines', 'support_pipeline_stages', 'support_ticket_stage_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  -- No row-audit trigger here: the save functions write their own audit entries, and an ERP reset deleting a
  -- pipeline must not write audit rows after the support activity log was cleared.
  foreach t in array array['support_pipelines', 'support_pipeline_stages'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end;
$$;
drop policy if exists support_pipelines_select on public.support_pipelines;
create policy support_pipelines_select on public.support_pipelines for select to authenticated
  using (private.has_permission(company_id, 'support.view') and private.has_permission(company_id, 'support_pipelines.view'));
drop policy if exists support_pipeline_stages_select on public.support_pipeline_stages;
create policy support_pipeline_stages_select on public.support_pipeline_stages for select to authenticated
  using (private.has_permission(company_id, 'support.view') and private.has_permission(company_id, 'support_pipelines.view'));
drop policy if exists support_ticket_stage_history_select on public.support_ticket_stage_history;
create policy support_ticket_stage_history_select on public.support_ticket_stage_history for select to authenticated
  using (private.has_permission(company_id, 'support.view'));

create or replace function private.support_stage_history_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Ticket stage history cannot be changed.' using errcode = 'P0001';
end;
$$;
drop trigger if exists support_ticket_stage_history_immutable on public.support_ticket_stage_history;
create trigger support_ticket_stage_history_immutable before update on public.support_ticket_stage_history
  for each row execute function private.support_stage_history_immutable();

-- -----------------------------------------------------------------------------
-- 3. Default pipeline, stage lookup
-- -----------------------------------------------------------------------------
-- The default stages (also used for pipelines created later).
create or replace function private.support_pipeline_default_stages()
returns table (stage_name text, stage_description text, stage_type text, outcome_type text, ticket_status text, display_order int, color text, is_default boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('New Ticket', 'Just received; not yet picked up.', 'OPEN', null, 'NEW', 10, '#3b82f6', true),
    ('In Progress', 'An agent is working on it.', 'OPEN', null, 'IN_PROGRESS', 20, '#f59e0b', false),
    ('On Hold', 'Waiting for the customer (the SLA clock pauses when business hours say so).', 'OPEN', null, 'WAITING_CUSTOMER', 30, '#8b5cf6', false),
    ('Closed – Positive', 'Resolved to the customer''s satisfaction.', 'CLOSED', 'POSITIVE', 'RESOLVED', 40, '#16a34a', false),
    ('Deferred – Negative', 'Closed without a fix for now.', 'CLOSED', 'NEGATIVE', 'RESOLVED', 50, '#dc2626', false),
    ('Not an Issue – Negative', 'Closed: no fault found or not a support issue.', 'CLOSED', 'NEGATIVE', 'RESOLVED', 60, '#e11d48', false)
  ) t (stage_name, stage_description, stage_type, outcome_type, ticket_status, display_order, color, is_default);
$$;

create or replace function private.support_pipeline_add_stages(p_company uuid, p_pipeline uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.support_pipeline_stages (company_id, pipeline_id, stage_name, stage_description, stage_type, outcome_type, ticket_status, display_order, color, is_default, created_by, updated_by)
  select p_company, p_pipeline, s.stage_name, s.stage_description, s.stage_type, s.outcome_type, s.ticket_status, s.display_order, s.color, s.is_default, auth.uid(), auth.uid()
  from private.support_pipeline_default_stages() s;
$$;

-- The company's default pipeline, created ("Customer Support" with the six default stages) when it has none.
create or replace function private.support_pipeline_ensure(p_company uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.support_pipelines where company_id = p_company and is_default;
  if v_id is not null then return v_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('support_pipeline:' || p_company::text, 0));
  select id into v_id from public.support_pipelines where company_id = p_company and is_default;
  if v_id is not null then return v_id; end if;
  select id into v_id from public.support_pipelines where company_id = p_company and is_active order by created_at limit 1;
  if v_id is not null then
    update public.support_pipelines set is_default = true where id = v_id;
    return v_id;
  end if;
  insert into public.support_pipelines (company_id, name, description, is_default, created_by, updated_by)
  values (p_company, 'Customer Support', 'Support tickets from every channel.', true, auth.uid(), auth.uid())
  returning id into v_id;
  perform private.support_pipeline_add_stages(p_company, v_id);
  return v_id;
end;
$$;

create or replace function private.support_pipeline_company_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.support_pipeline_ensure(new.id);
  return null;
end;
$$;
drop trigger if exists companies_support_pipeline on public.companies;
create trigger companies_support_pipeline after insert on public.companies for each row execute function private.support_pipeline_company_defaults();

-- The stage that stands for a status in a pipeline. Prefers a stage with that exact status; OPEN falls back to an
-- In-Progress-like stage; otherwise the current stage is kept when it is of the right kind (open / closed), else
-- the default open stage or the first positive closed stage.
create or replace function private.support_stage_for_status(p_pipeline uuid, p_status text, p_current uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from public.support_pipeline_stages where pipeline_id = p_pipeline and is_active),
  kind as (select case when p_status in ('RESOLVED', 'CLOSED') then 'CLOSED' else 'OPEN' end as k)
  select coalesce(
    (select id from s where ticket_status = p_status and id = p_current),
    (select id from s where ticket_status = p_status order by display_order limit 1),
    (select id from s where p_status = 'OPEN' and ticket_status = 'IN_PROGRESS' order by display_order limit 1),
    (select id from s where p_status like 'WAITING%' and ticket_status like 'WAITING%' order by display_order limit 1),
    (select s.id from s, kind where s.id = p_current and s.stage_type = kind.k),
    (select s.id from s, kind where kind.k = 'OPEN' and s.is_default),
    (select s.id from s, kind where s.stage_type = kind.k order by (s.outcome_type = 'POSITIVE') desc nulls last, s.display_order limit 1));
$$;

-- -----------------------------------------------------------------------------
-- 4. Tickets follow their status into the right stage; every stage change is recorded
-- -----------------------------------------------------------------------------
create or replace function private.support_ticket_stage_before()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline uuid;
  v_wanted text := nullif(current_setting('app.support_pipeline', true), '');
begin
  if tg_op = 'INSERT' then
    if new.pipeline_id is null then
      if v_wanted is not null then
        select id into v_pipeline from public.support_pipelines where id = v_wanted::uuid and company_id = new.company_id and is_active;
      end if;
      new.pipeline_id := coalesce(v_pipeline, private.support_pipeline_ensure(new.company_id));
    end if;
    if new.stage_id is null then
      -- New tickets enter the pipeline's default open stage (closed ones, e.g. imported, the matching closed stage).
      new.stage_id := case when new.status in ('RESOLVED', 'CLOSED') then private.support_stage_for_status(new.pipeline_id, new.status, null)
                           else coalesce((select id from public.support_pipeline_stages where pipeline_id = new.pipeline_id and is_default),
                                         private.support_stage_for_status(new.pipeline_id, new.status, null)) end;
    end if;
    return new;
  end if;
  -- A status change made outside a pipeline move takes the card to the matching stage.
  if new.status is distinct from old.status and coalesce(current_setting('app.support_stage_move', true), '') = ''
     and new.pipeline_id is not null then
    new.stage_id := private.support_stage_for_status(new.pipeline_id, new.status, old.stage_id);
  end if;
  return new;
end;
$$;

create or replace function private.support_ticket_stage_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text := coalesce(nullif(current_setting('app.support_stage_source', true), ''), case when tg_op = 'INSERT' then 'CREATED' else 'STATUS_CHANGE' end);
  v_note text := nullif(current_setting('app.support_stage_note', true), '');
  -- A move changes the status first (existing rules), then the stage: the status before the move is passed on.
  v_from_status text := nullif(current_setting('app.support_stage_from_status', true), '');
begin
  if new.stage_id is null then return null; end if;
  if tg_op = 'INSERT' then
    insert into public.support_ticket_stage_history (company_id, ticket_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, source, changed_by, changed_at)
    values (new.company_id, new.id, new.pipeline_id, null, new.stage_id, null, new.status, 'CREATED', auth.uid(), new.created_at);
    return null;
  end if;
  -- First placement of an existing ticket is recorded by the migration itself.
  if old.stage_id is null or new.stage_id is not distinct from old.stage_id then return null; end if;
  insert into public.support_ticket_stage_history (company_id, ticket_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, source, changed_by, notes)
  values (new.company_id, new.id, new.pipeline_id, old.stage_id, new.stage_id, coalesce(v_from_status, old.status), new.status,
          case when tg_op = 'UPDATE' and v_source = 'CREATED' then 'STATUS_CHANGE' else v_source end, auth.uid(), left(v_note, 500));
  insert into public.support_ticket_events (company_id, ticket_id, event_type, from_value, to_value, details, actor_user_id)
  values (new.company_id, new.id, 'STAGE_CHANGED', (select stage_name from public.support_pipeline_stages where id = old.stage_id),
          (select stage_name from public.support_pipeline_stages where id = new.stage_id),
          jsonb_strip_nulls(jsonb_build_object('source', v_source, 'note', left(v_note, 500))), auth.uid());
  return null;
end;
$$;

drop trigger if exists support_tickets_stage_before on public.support_tickets;
create trigger support_tickets_stage_before before insert or update on public.support_tickets
  for each row execute function private.support_ticket_stage_before();
drop trigger if exists support_tickets_stage_after on public.support_tickets;
-- Any update (not "update of stage_id"): the stage also changes through the before-trigger when only the status is set.
create trigger support_tickets_stage_after after insert or update on public.support_tickets
  for each row execute function private.support_ticket_stage_after();

-- -----------------------------------------------------------------------------
-- 5. Existing companies and tickets (statuses unchanged; ticket rows otherwise untouched)
-- -----------------------------------------------------------------------------
do $$
declare
  c uuid;
begin
  for c in select id from public.companies loop
    perform private.support_pipeline_ensure(c);
  end loop;
end;
$$;

-- Placement without firing updated_at / audit triggers: the tickets' own data does not change.
alter table public.support_tickets disable trigger user;
update public.support_tickets t set pipeline_id = p.id,
  stage_id = (select s.id from public.support_pipeline_stages s where s.pipeline_id = p.id and s.stage_name = case
      when t.status = 'NEW' then 'New Ticket'
      when t.status in ('OPEN', 'IN_PROGRESS') then 'In Progress'
      when t.status in ('WAITING_CUSTOMER', 'WAITING_INTERNAL') then 'On Hold'
      else 'Closed – Positive' end)
from public.support_pipelines p
where p.company_id = t.company_id and p.is_default and t.pipeline_id is null;
alter table public.support_tickets enable trigger user;

-- History starts when the ticket last changed status (from its own events), else when it was created.
insert into public.support_ticket_stage_history (company_id, ticket_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, source, changed_by, changed_at, notes)
select t.company_id, t.id, t.pipeline_id, null, t.stage_id, null, t.status, 'MIGRATION', null,
  coalesce((select max(e.created_at) from public.support_ticket_events e where e.ticket_id = t.id and e.event_type in ('STATUS_CHANGED', 'REOPENED', 'MERGED_INTO')), t.created_at),
  'Placed by status ' || t.status || ' when pipelines were introduced'
from public.support_tickets t
where t.stage_id is not null and not exists (select 1 from public.support_ticket_stage_history h where h.ticket_id = t.id);

-- -----------------------------------------------------------------------------
-- 6. Moving tickets
-- -----------------------------------------------------------------------------
-- Move one ticket to a stage through the existing status rules (closing, reopening, SLA pause), then set the
-- stage. The history row and the STAGE_CHANGED event are written by the trigger in the same transaction.
create or replace function private.support_ticket_move(p_ticket uuid, p_stage uuid, p_note text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.support_tickets;
  st public.support_pipeline_stages;
  v_closed_now boolean;
  v_wanted text;
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  select * into st from public.support_pipeline_stages where id = p_stage;
  if st.pipeline_id is distinct from t.pipeline_id then
    raise exception 'That stage belongs to another pipeline.' using errcode = 'P0001';
  end if;
  if not st.is_active then
    raise exception 'Stage "%" is inactive.', st.stage_name using errcode = 'P0001';
  end if;
  if t.merged_into_ticket_id is not null then
    raise exception 'Ticket % was merged into another ticket and cannot be moved.', t.ticket_number using errcode = 'P0001';
  end if;
  perform set_config('app.support_stage_move', '1', true);
  perform set_config('app.support_stage_from_status', t.status, true);
  v_closed_now := t.status in ('RESOLVED', 'CLOSED');
  if v_closed_now and st.stage_type = 'OPEN' then
    -- Reopening: the existing reopen (reason required, reopen count, REOPENED event), then the stage's status.
    perform public.support_ticket_reopen(p_ticket, p_note);
    if st.ticket_status not in ('NEW', 'OPEN') then
      perform public.support_ticket_update(p_ticket, jsonb_build_object('status', st.ticket_status));
    end if;
  elsif not v_closed_now then
    -- Open ticket: a ticket that has left New never goes back to New (existing rule); it becomes Open.
    v_wanted := case when st.ticket_status = 'NEW' and t.status <> 'NEW' then 'OPEN' else st.ticket_status end;
    if v_wanted is distinct from t.status then
      perform public.support_ticket_update(p_ticket, jsonb_build_object('status', v_wanted));
    end if;
  elsif t.status = 'RESOLVED' and st.ticket_status = 'CLOSED' then
    perform public.support_ticket_update(p_ticket, jsonb_build_object('status', 'CLOSED'));
  end if;
  -- Closed → closed (e.g. Positive → Negative) keeps the status; a closed ticket is never moved back to Resolved.
  perform set_config('app.support_stage_source', p_source, true);
  perform set_config('app.support_stage_note', coalesce(left(p_note, 500), ''), true);
  update public.support_tickets set stage_id = p_stage, updated_by = auth.uid() where id = p_ticket;
  perform set_config('app.support_stage_move', '', true);
  perform set_config('app.support_stage_source', '', true);
  perform set_config('app.support_stage_note', '', true);
  perform set_config('app.support_stage_from_status', '', true);
  select * into t from public.support_tickets where id = p_ticket;
  return jsonb_build_object('id', t.id, 'stage_id', t.stage_id, 'status', t.status, 'sla_status', private.support_sla_status(t), 'updated_at', t.updated_at);
end;
$$;

-- p_expected_stage: the stage the user saw; a ticket moved by someone else meanwhile is refused (no overwrite).
create or replace function public.support_ticket_move_stage(p_ticket uuid, p_stage uuid, p_expected_stage uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_tickets.move_stage');
  t public.support_tickets;
begin
  perform private.require_permission('support.manage_tickets');
  select * into t from public.support_tickets where id = p_ticket and company_id = v_company for update;
  if not found then
    raise exception 'Ticket not found in your company.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.support_pipeline_stages where id = p_stage and company_id = v_company) then
    raise exception 'Stage not found in your company.' using errcode = 'P0001';
  end if;
  if p_expected_stage is not null and t.stage_id is distinct from p_expected_stage then
    raise exception 'Ticket % was moved to "%" by someone else. The board has been refreshed.', t.ticket_number,
      (select stage_name from public.support_pipeline_stages where id = t.stage_id) using errcode = 'P0001';
  end if;
  if t.stage_id = p_stage then
    return jsonb_build_object('id', t.id, 'stage_id', t.stage_id, 'status', t.status, 'unchanged', true);
  end if;
  return private.support_ticket_move(p_ticket, p_stage, nullif(btrim(coalesce(p_note, '')), ''), 'MOVE');
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Pipelines and stages (Manage Stages)
-- -----------------------------------------------------------------------------
create or replace function private.support_stages_stamp(p_pipeline uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(coalesce(string_agg(concat_ws('|', id, stage_name, stage_description, stage_type, outcome_type, ticket_status, display_order, color, is_default, is_active),
    ',' order by id), '')) from public.support_pipeline_stages where pipeline_id = p_pipeline;
$$;

create or replace function private.support_stage_json(s public.support_pipeline_stages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'stage_name', s.stage_name, 'stage_description', s.stage_description, 'stage_type', s.stage_type, 'outcome_type', s.outcome_type,
    'ticket_status', s.ticket_status, 'display_order', s.display_order, 'color', s.color, 'is_default', s.is_default, 'is_active', s.is_active,
    'tickets', (select count(*) from public.support_tickets t where t.stage_id = s.id and t.merged_into_ticket_id is null),
    'used', exists (select 1 from public.support_ticket_stage_history h where h.to_stage_id = s.id or h.from_stage_id = s.id)
            or exists (select 1 from public.support_tickets t where t.stage_id = s.id));
$$;

create or replace function public.support_pipelines_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_pipelines.view');
begin
  perform private.require_permission('support.view');
  return jsonb_build_object(
    'pipelines', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description, 'is_default', p.is_default, 'is_active', p.is_active,
        'stamp', private.support_stages_stamp(p.id),
        'tickets', (select count(*) from public.support_tickets t where t.pipeline_id = p.id and t.merged_into_ticket_id is null),
        'stages', coalesce((select jsonb_agg(private.support_stage_json(s) order by s.stage_type desc, s.display_order) from public.support_pipeline_stages s where s.pipeline_id = p.id), '[]'::jsonb))
        order by p.is_default desc, p.is_active desc, p.name)
      from public.support_pipelines p where p.company_id = v_company), '[]'::jsonb),
    'can', jsonb_build_object('create', private.has_permission(v_company, 'support_pipelines.create'),
      'update', private.has_permission(v_company, 'support_pipelines.update'), 'delete', private.has_permission(v_company, 'support_pipelines.delete'),
      'manage_stages', private.has_permission(v_company, 'support_pipelines.manage_stages'),
      'move', private.has_permission(v_company, 'support_tickets.move_stage') and private.has_permission(v_company, 'support.manage_tickets'),
      'products', private.has_permission(v_company, 'support_ticket_products.view')));
end;
$$;

-- Create (p_id null: with the six default stages) or edit a pipeline. Deactivating needs support_pipelines.delete
-- and is refused for the default pipeline or while it has open tickets.
create or replace function public.support_pipeline_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_pipelines.view');
  r public.support_pipelines;
  v_name text := private.support_text(p, 'name', 80);
begin
  if p ? 'name' or p_id is null then
    if v_name is null then raise exception 'Enter the pipeline name.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.support_pipelines where company_id = v_company and lower(name) = lower(v_name) and id is distinct from p_id) then
      raise exception 'A pipeline named "%" already exists.', v_name using errcode = 'P0001';
    end if;
  end if;
  if p_id is null then
    perform private.require_permission('support_pipelines.create');
    perform private.support_pipeline_ensure(v_company);
    insert into public.support_pipelines (company_id, name, description, created_by, updated_by)
    values (v_company, v_name, private.support_text(p, 'description', 500), auth.uid(), auth.uid()) returning * into r;
    perform private.support_pipeline_add_stages(v_company, r.id);
  else
    select * into r from public.support_pipelines where id = p_id and company_id = v_company for update;
    if not found then raise exception 'Pipeline not found in your company.' using errcode = 'P0001'; end if;
    if (p - 'is_active') <> '{}'::jsonb then perform private.require_permission('support_pipelines.update'); end if;
    if p ? 'is_active' and (p ->> 'is_active')::boolean is distinct from r.is_active then
      perform private.require_permission(case when (p ->> 'is_active')::boolean then 'support_pipelines.update' else 'support_pipelines.delete' end);
      if not (p ->> 'is_active')::boolean then
        if r.is_default then raise exception 'The default pipeline cannot be deactivated. Make another pipeline the default first.' using errcode = 'P0001'; end if;
        if exists (select 1 from public.support_tickets t join public.support_pipeline_stages s on s.id = t.stage_id
                   where t.pipeline_id = r.id and s.stage_type = 'OPEN' and t.merged_into_ticket_id is null) then
          raise exception 'Pipeline "%" still has open tickets. Close or move them first.', r.name using errcode = 'P0001';
        end if;
      end if;
    end if;
    if coalesce((p ->> 'is_default')::boolean, false) and not r.is_default then
      update public.support_pipelines set is_default = false, updated_by = auth.uid() where company_id = v_company and is_default;
    end if;
    update public.support_pipelines set
      name = case when p ? 'name' then v_name else name end,
      description = case when p ? 'description' then private.support_text(p, 'description', 500) else description end,
      is_active = case when p ? 'is_active' then (p ->> 'is_active')::boolean else is_active end,
      is_default = case when coalesce((p ->> 'is_default')::boolean, false) then true else is_default end,
      updated_by = auth.uid()
    where id = p_id returning * into r;
  end if;
  perform private.support_audit(v_company, case when p_id is null then 'pipeline.created' else 'pipeline.updated' end, 'pipeline', r.id::text,
    jsonb_build_object('name', r.name, 'is_default', r.is_default, 'is_active', r.is_active));
  return jsonb_build_object('id', r.id, 'name', r.name, 'is_default', r.is_default, 'is_active', r.is_active);
end;
$$;

-- Manage Stages: p_stages = every stage of the pipeline in display order (open first, then closed):
--   [{id | null, stage_name, stage_description, stage_type, outcome_type, ticket_status, color, is_default, is_active}]
-- A stage left out is deleted (only when it never held a ticket). p_moves = {stage_id: destination_stage_id} for
-- stages being deactivated or deleted while tickets are in them: those tickets move through the normal, audited
-- stage move. p_stamp = the stamp read with the stages (refused when someone saved meanwhile).
create or replace function public.support_pipeline_save_stages(p_pipeline uuid, p_stages jsonb, p_moves jsonb, p_stamp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_pipelines.manage_stages');
  pl public.support_pipelines;
  it jsonb;
  i int := 0;
  s public.support_pipeline_stages;
  v_ids uuid[] := '{}';
  v_names text[] := '{}';
  v_name text;
  v_type text;
  v_outcome text;
  v_status text;
  v_open_active int := 0;
  v_closed_active int := 0;
  v_defaults int := 0;
  v_dest uuid;
  v_moved int := 0;
  v_tid uuid;
  v_new_ids jsonb := '{}'::jsonb;
  v_id uuid;
begin
  perform private.require_permission('support.view');
  select * into pl from public.support_pipelines where id = p_pipeline and company_id = v_company for update;
  if not found then raise exception 'Pipeline not found in your company.' using errcode = 'P0001'; end if;
  if p_stamp is distinct from private.support_stages_stamp(p_pipeline) then
    raise exception 'Someone else changed the stages of this pipeline since you opened it. Reload to see their changes, then make yours again.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_stages) is distinct from 'array' or jsonb_array_length(p_stages) = 0 then
    raise exception 'The pipeline needs its stages.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_stages) > 30 then
    raise exception 'A pipeline can have at most 30 stages.' using errcode = 'P0001';
  end if;

  -- Checks on the whole list first.
  for it in select * from jsonb_array_elements(p_stages) loop
    v_name := private.support_text(it, 'stage_name', 60);
    if v_name is null then raise exception 'Every stage needs a name.' using errcode = 'P0001'; end if;
    if lower(v_name) = any (v_names) then raise exception 'Stage names must be unique in a pipeline: "%" is used twice.', v_name using errcode = 'P0001'; end if;
    v_names := v_names || lower(v_name);
    v_type := upper(coalesce(it ->> 'stage_type', ''));
    if v_type not in ('OPEN', 'CLOSED') then raise exception 'Stage "%" must be Open or Closed.', v_name using errcode = 'P0001'; end if;
    v_outcome := upper(nullif(it ->> 'outcome_type', ''));
    if v_type = 'CLOSED' and coalesce(v_outcome, '') not in ('POSITIVE', 'NEGATIVE') then
      raise exception 'Closed stage "%" needs a Positive or Negative outcome.', v_name using errcode = 'P0001';
    end if;
    v_status := upper(coalesce(nullif(it ->> 'ticket_status', ''), case when v_type = 'OPEN' then 'IN_PROGRESS' else 'RESOLVED' end));
    if (v_type = 'OPEN' and v_status not in ('NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'))
       or (v_type = 'CLOSED' and v_status not in ('RESOLVED', 'CLOSED')) then
      raise exception 'Stage "%": the ticket status must fit an % stage.', v_name, lower(v_type) using errcode = 'P0001';
    end if;
    if coalesce((it ->> 'is_active')::boolean, true) then
      if v_type = 'OPEN' then v_open_active := v_open_active + 1; else v_closed_active := v_closed_active + 1; end if;
      if coalesce((it ->> 'is_default')::boolean, false) then
        if v_type <> 'OPEN' then raise exception 'Only an open stage can be the default stage.' using errcode = 'P0001'; end if;
        v_defaults := v_defaults + 1;
      end if;
    elsif coalesce((it ->> 'is_default')::boolean, false) then
      raise exception 'The default stage must be active.' using errcode = 'P0001';
    end if;
    if nullif(it ->> 'id', '') is not null then
      select * into s from public.support_pipeline_stages where id = (it ->> 'id')::uuid and pipeline_id = p_pipeline;
      if s.id is null then raise exception 'Stage not found in this pipeline.' using errcode = 'P0001'; end if;
      if s.stage_type <> v_type and exists (select 1 from public.support_tickets where stage_id = s.id) then
        raise exception 'Stage "%" has tickets, so it cannot change between Open and Closed.', s.stage_name using errcode = 'P0001';
      end if;
      v_ids := v_ids || s.id;
      s := null;
    end if;
    if coalesce(it ->> 'color', '#64748b') !~ '^#[0-9a-f]{6}$' then
      raise exception 'Stage colours are written like #3b82f6.' using errcode = 'P0001';
    end if;
  end loop;
  if v_open_active = 0 then raise exception 'At least one active Open stage is needed.' using errcode = 'P0001'; end if;
  if v_closed_active = 0 then raise exception 'At least one active Closed stage is needed.' using errcode = 'P0001'; end if;
  if v_defaults <> 1 then raise exception 'Choose exactly one default stage (an active Open stage) for new tickets.' using errcode = 'P0001'; end if;

  -- Stages removed from the list: deleted only when never used; otherwise refused (deactivate instead).
  for s in select * from public.support_pipeline_stages where pipeline_id = p_pipeline and not (id = any (v_ids)) loop
    if exists (select 1 from public.support_tickets where stage_id = s.id) then
      raise exception 'Stage "%" contains tickets and cannot be deleted. Deactivate it and choose where its tickets go.', s.stage_name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.support_ticket_stage_history where to_stage_id = s.id or from_stage_id = s.id) then
      raise exception 'Stage "%" appears in ticket history and cannot be deleted. Deactivate it instead.', s.stage_name using errcode = 'P0001';
    end if;
    delete from public.support_pipeline_stages where id = s.id;
  end loop;

  -- Names and the default flag through temporary values, so swaps never collide with the unique indexes.
  update public.support_pipeline_stages set stage_name = 'tmp ' || id::text, is_default = false where pipeline_id = p_pipeline;
  for it in select * from jsonb_array_elements(p_stages) loop
    i := i + 1;
    v_type := upper(it ->> 'stage_type');
    v_status := upper(coalesce(nullif(it ->> 'ticket_status', ''), case when v_type = 'OPEN' then 'IN_PROGRESS' else 'RESOLVED' end));
    if nullif(it ->> 'id', '') is null then
      insert into public.support_pipeline_stages (company_id, pipeline_id, stage_name, stage_description, stage_type, outcome_type, ticket_status, display_order, color,
        is_default, is_active, created_by, updated_by)
      values (v_company, p_pipeline, private.support_text(it, 'stage_name', 60), private.support_text(it, 'stage_description', 300), v_type,
        case when v_type = 'CLOSED' then upper(it ->> 'outcome_type') end, v_status, i * 10, coalesce(it ->> 'color', '#64748b'),
        coalesce((it ->> 'is_default')::boolean, false), coalesce((it ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
      returning id into v_id;
      if it ? 'client_key' then v_new_ids := v_new_ids || jsonb_build_object(it ->> 'client_key', v_id); end if;
    else
      update public.support_pipeline_stages set stage_name = private.support_text(it, 'stage_name', 60), stage_description = private.support_text(it, 'stage_description', 300),
        stage_type = v_type, outcome_type = case when v_type = 'CLOSED' then upper(it ->> 'outcome_type') end, ticket_status = v_status, display_order = i * 10,
        color = coalesce(it ->> 'color', '#64748b'), is_default = coalesce((it ->> 'is_default')::boolean, false), updated_by = auth.uid()
      where id = (it ->> 'id')::uuid;
    end if;
  end loop;

  -- Deactivations: tickets in a stage being deactivated go to the chosen stage through normal moves.
  for it in select * from jsonb_array_elements(p_stages) loop
    if nullif(it ->> 'id', '') is null or coalesce((it ->> 'is_active')::boolean, true) then continue; end if;
    select * into s from public.support_pipeline_stages where id = (it ->> 'id')::uuid;
    if s.is_active and exists (select 1 from public.support_tickets where stage_id = s.id) then
      v_dest := nullif(p_moves ->> s.id::text, '')::uuid;
      if v_dest is null or v_dest = s.id or not exists (select 1 from public.support_pipeline_stages d where d.id = v_dest and d.pipeline_id = p_pipeline)
         or exists (select 1 from jsonb_array_elements(p_stages) x where x ->> 'id' = v_dest::text and not coalesce((x ->> 'is_active')::boolean, true)) then
        raise exception 'Stage "%" contains tickets: choose an active stage to move them to before deactivating it.', s.stage_name using errcode = 'P0001';
      end if;
      perform private.require_permission('support.manage_tickets');
      for v_tid in select id from public.support_tickets where stage_id = s.id order by created_at loop
        perform private.support_ticket_move(v_tid, v_dest, format('Stage "%s" was deactivated', s.stage_name), 'STAGE_DEACTIVATED');
        v_moved := v_moved + 1;
      end loop;
    end if;
    update public.support_pipeline_stages set is_active = false, updated_by = auth.uid() where id = s.id;
    s := null;
  end loop;
  -- Reactivations.
  update public.support_pipeline_stages ps set is_active = true, updated_by = auth.uid()
  from jsonb_array_elements(p_stages) x
  where ps.pipeline_id = p_pipeline and x ->> 'id' = ps.id::text and coalesce((x ->> 'is_active')::boolean, true) and not ps.is_active;

  perform private.support_audit(v_company, 'pipeline.stages_saved', 'pipeline', p_pipeline::text, jsonb_build_object('stages', jsonb_array_length(p_stages), 'moved', v_moved));
  return jsonb_build_object('stamp', private.support_stages_stamp(p_pipeline), 'moved', v_moved, 'new_ids', v_new_ids);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Board, list and ticket stage
-- -----------------------------------------------------------------------------
-- p: {pipeline_id, mode: 'board' | 'list', scope: ALL | MINE | UNASSIGNED | OPEN | CLOSED, search, priority, agent_id, customer_id,
--     category, product (id, SKU or name), from, to, sort: created_desc | created_asc | updated_desc | priority | sla, per_stage, limit, offset}
create or replace function public.support_pipeline_board(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support_pipelines.view');
  v_pipeline uuid;
  v_products boolean := private.has_permission(v_company, 'support_ticket_products.view');
  v_term text := nullif(btrim(left(coalesce(p ->> 'search', ''), 80)), '');
  v_like text;
  v_prod text := nullif(btrim(left(coalesce(p ->> 'product', ''), 80)), '');
  v_plike text;
  v_sort text := coalesce(nullif(p ->> 'sort', ''), 'created_desc');
  v_per int := least(greatest(coalesce((p ->> 'per_stage')::int, 50), 1), 200);
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 500);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_result jsonb;
begin
  perform private.require_permission('support.view');
  v_pipeline := coalesce(nullif(p ->> 'pipeline_id', '')::uuid, (select id from public.support_pipelines where company_id = v_company and is_default));
  if not exists (select 1 from public.support_pipelines where id = v_pipeline and company_id = v_company) then
    raise exception 'Pipeline not found in your company.' using errcode = 'P0001';
  end if;
  if v_term is not null then v_like := '%' || replace(replace(replace(lower(v_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  if v_prod is not null then v_plike := '%' || replace(replace(replace(lower(v_prod), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;

  -- PostgREST runs STABLE functions read-only (no temporary tables): everything below is one query.
  with base as (
    select t.*, c.display_name as customer_name, a.display_name as agent_name, s.stage_type, s.outcome_type, private.support_sla_status(t) as sla
    from public.support_tickets t
    join public.support_pipeline_stages s on s.id = t.stage_id
    left join public.support_customers c on c.id = t.customer_id
    left join public.support_agents a on a.id = t.assigned_agent_id
    where t.company_id = v_company and t.pipeline_id = v_pipeline and t.merged_into_ticket_id is null
      and (coalesce(p ->> 'scope', 'ALL') = 'ALL'
           or (p ->> 'scope' = 'MINE' and a.user_id = auth.uid())
           or (p ->> 'scope' = 'UNASSIGNED' and t.assigned_agent_id is null)
           or (p ->> 'scope' = 'OPEN' and s.stage_type = 'OPEN')
           or (p ->> 'scope' = 'CLOSED' and s.stage_type = 'CLOSED'))
      and (v_like is null or lower(t.ticket_number) like v_like escape '\' or lower(t.subject) like v_like escape '\'
           or lower(coalesce(c.display_name, '')) like v_like escape '\' or lower(coalesce(t.customer_email, '')) like v_like escape '\'
           or lower(coalesce(t.customer_phone, '')) like v_like escape '\'
           or (length(regexp_replace(v_term, '[^0-9]', '', 'g')) >= 4 and regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g') like '%' || regexp_replace(v_term, '[^0-9]', '', 'g') || '%'))
      and (nullif(p ->> 'priority', '') is null or t.priority = p ->> 'priority')
      and (nullif(p ->> 'agent_id', '') is null or t.assigned_agent_id = (p ->> 'agent_id')::uuid)
      and (nullif(p ->> 'customer_id', '') is null or t.customer_id = (p ->> 'customer_id')::uuid)
      and (nullif(p ->> 'category', '') is null or lower(coalesce(t.category, '')) = lower(p ->> 'category'))
      and (nullif(p ->> 'from', '') is null or t.created_at >= (p ->> 'from')::date)
      and (nullif(p ->> 'to', '') is null or t.created_at < (p ->> 'to')::date + 1)
      and (v_plike is null or (v_products and exists (select 1 from public.support_ticket_products x where x.ticket_id = t.id
           and (x.product_id::text = v_prod or lower(x.sku_snapshot) like v_plike escape '\' or lower(x.product_name_snapshot) like v_plike escape '\'))))
  ),
  cards as (
    select b.stage_id, b.created_at, b.updated_at, b.due_at,
      case b.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end as prio,
      jsonb_build_object('id', b.id, 'ticket_number', b.ticket_number, 'subject', b.subject, 'customer_id', b.customer_id, 'customer_name', b.customer_name,
        'customer_phone', b.customer_phone, 'customer_email', b.customer_email, 'priority', b.priority, 'status', b.status, 'category', b.category,
        'assigned_agent_id', b.assigned_agent_id, 'assigned_agent', b.agent_name, 'created_at', b.created_at, 'updated_at', b.updated_at,
        'due_at', b.due_at, 'first_response_due_at', b.first_response_due_at, 'first_response_at', b.first_response_at, 'sla_paused_at', b.sla_paused_at,
        'sla_status', b.sla, 'stage_id', b.stage_id, 'stage_type', b.stage_type, 'outcome_type', b.outcome_type,
        'reopen_count', b.reopen_count,
        'products', case when v_products then coalesce((select jsonb_agg(jsonb_build_object('sku', x.sku_snapshot, 'name', x.product_name_snapshot, 'quantity', x.quantity) order by x.created_at)
                    from public.support_ticket_products x where x.ticket_id = b.id), '[]'::jsonb) end) as card
    from base b
  ),
  ordered as (
    select c.*, row_number() over (partition by c.stage_id order by
        case when v_sort = 'priority' then c.prio end, case when v_sort = 'sla' then c.due_at end nulls last,
        case when v_sort = 'created_asc' then c.created_at end, case when v_sort = 'updated_desc' then c.updated_at end desc,
        c.created_at desc) as rn_stage,
      row_number() over (order by
        case when v_sort = 'priority' then c.prio end, case when v_sort = 'sla' then c.due_at end nulls last,
        case when v_sort = 'created_asc' then c.created_at end, case when v_sort = 'updated_desc' then c.updated_at end desc,
        c.created_at desc) as rn_all
    from cards c
  )
  select case when coalesce(p ->> 'mode', 'board') = 'list' then
      jsonb_build_object('total', (select count(*) from ordered),
        'rows', coalesce((select jsonb_agg(o.card order by o.rn_all) from ordered o where o.rn_all > v_offset and o.rn_all <= v_offset + v_limit), '[]'::jsonb))
    else
      jsonb_build_object('total', (select count(*) from ordered),
        'stages', coalesce((select jsonb_agg(private.support_stage_json(s) || jsonb_build_object(
            'count', (select count(*) from ordered o where o.stage_id = s.id),
            'cards', coalesce((select jsonb_agg(o.card order by o.rn_stage) from ordered o where o.stage_id = s.id and o.rn_stage <= v_per), '[]'::jsonb))
          order by s.stage_type desc, s.display_order)
          from public.support_pipeline_stages s where s.pipeline_id = v_pipeline and (s.is_active or exists (select 1 from ordered o where o.stage_id = s.id))), '[]'::jsonb))
    end
  into v_result;
  return v_result || jsonb_build_object('pipeline_id', v_pipeline);
end;
$$;

-- Stage, pipeline stages and stage history of one ticket (ticket page).
create or replace function public.support_ticket_stage_info(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view');
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_ticket and company_id = v_company;
  if not found then raise exception 'Ticket not found in your company.' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'pipeline', (select jsonb_build_object('id', p.id, 'name', p.name) from public.support_pipelines p where p.id = t.pipeline_id),
    'stage_id', t.stage_id,
    'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'stage_name', s.stage_name, 'stage_type', s.stage_type, 'outcome_type', s.outcome_type,
        'ticket_status', s.ticket_status, 'color', s.color, 'is_active', s.is_active) order by s.stage_type desc, s.display_order)
      from public.support_pipeline_stages s where s.pipeline_id = t.pipeline_id and (s.is_active or s.id = t.stage_id)), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'from_stage', fs.stage_name, 'to_stage', ts.stage_name, 'from_status', h.from_status, 'to_status', h.to_status,
        'source', h.source, 'notes', h.notes, 'changed_at', h.changed_at, 'changed_by', (select coalesce(u.full_name, u.email) from public.profiles u where u.id = h.changed_by),
        'outcome_type', ts.outcome_type) order by h.changed_at desc, h.id)
      from public.support_ticket_stage_history h join public.support_pipeline_stages ts on ts.id = h.to_stage_id
      left join public.support_pipeline_stages fs on fs.id = h.from_stage_id where h.ticket_id = t.id), '[]'::jsonb),
    'can_move', private.has_permission(v_company, 'support_tickets.move_stage') and private.has_permission(v_company, 'support.manage_tickets')
      and t.merged_into_ticket_id is null);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Pipeline report (stage durations from the stage history)
-- -----------------------------------------------------------------------------
create or replace function public.support_pipeline_report(p_pipeline uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.view_reports');
  v_pipeline uuid;
  v_from timestamptz := coalesce(p_from, current_date - 90)::timestamptz;
  v_to timestamptz := (coalesce(p_to, current_date) + 1)::timestamptz;
begin
  perform private.require_permission('support_pipelines.view');
  v_pipeline := coalesce(p_pipeline, (select id from public.support_pipelines where company_id = v_company and is_default));
  if not exists (select 1 from public.support_pipelines where id = v_pipeline and company_id = v_company) then
    raise exception 'Pipeline not found in your company.' using errcode = 'P0001';
  end if;
  return (
    with tk as (
      select t.*, s.stage_type, s.outcome_type, private.support_sla_status(t) as sla
      from public.support_tickets t join public.support_pipeline_stages s on s.id = t.stage_id
      where t.pipeline_id = v_pipeline and t.company_id = v_company and t.merged_into_ticket_id is null),
    period as (select * from tk where created_at >= v_from and created_at < v_to),
    -- Time in a stage = from entering it until the next stage change (or now for the current stage).
    spans as (
      select h.ticket_id, h.to_stage_id, h.from_stage_id, h.changed_at,
        coalesce(lead(h.changed_at) over (partition by h.ticket_id order by h.changed_at, h.id), now()) - h.changed_at as spent
      from public.support_ticket_stage_history h where h.pipeline_id = v_pipeline and h.company_id = v_company),
    stages as (select * from public.support_pipeline_stages where pipeline_id = v_pipeline)
    select jsonb_build_object(
      'pipeline_id', v_pipeline, 'from', v_from::date, 'to', (v_to - interval '1 day')::date,
      'by_stage', coalesce((select jsonb_agg(jsonb_build_object('stage_id', s.id, 'stage_name', s.stage_name, 'stage_type', s.stage_type, 'outcome_type', s.outcome_type,
          'color', s.color, 'is_active', s.is_active,
          'tickets', (select count(*) from tk where tk.stage_id = s.id),
          'avg_hours', (select round(extract(epoch from avg(sp.spent)) / 3600.0, 1) from spans sp where sp.to_stage_id = s.id),
          'entered', (select count(distinct sp.ticket_id) from spans sp join period pd on pd.id = sp.ticket_id where sp.to_stage_id = s.id),
          'conversion_percent', case when (select count(*) from period) = 0 then null else round(100.0 * (select count(distinct sp.ticket_id) from spans sp join period pd on pd.id = sp.ticket_id
              where sp.to_stage_id = s.id) / (select count(*) from period), 1) end)
          order by s.stage_type desc, s.display_order) from stages s), '[]'::jsonb),
      'open', (select count(*) from tk where stage_type = 'OPEN'),
      'closed', (select count(*) from tk where stage_type = 'CLOSED'),
      'positive', (select count(*) from tk where outcome_type = 'POSITIVE'),
      'negative', (select count(*) from tk where outcome_type = 'NEGATIVE'),
      'awaiting_action', (select count(*) from tk where stage_type = 'OPEN' and status <> 'WAITING_CUSTOMER' and (assigned_agent_id is null or first_response_at is null)),
      'overdue', (select count(*) from tk where stage_type = 'OPEN' and sla = 'OVERDUE'),
      'created_in_period', (select count(*) from period),
      'reopened', (select count(*) from spans sp join stages f on f.id = sp.from_stage_id join stages tt on tt.id = sp.to_stage_id
                   where f.stage_type = 'CLOSED' and tt.stage_type = 'OPEN' and sp.changed_at >= v_from and sp.changed_at < v_to),
      'reopened_tickets', (select count(distinct sp.ticket_id) from spans sp join stages f on f.id = sp.from_stage_id join stages tt on tt.id = sp.to_stage_id
                   where f.stage_type = 'CLOSED' and tt.stage_type = 'OPEN' and sp.changed_at >= v_from and sp.changed_at < v_to),
      'by_agent', coalesce((select jsonb_agg(x order by x ->> 'agent') from (
          select jsonb_build_object('agent_id', tk.assigned_agent_id, 'agent', coalesce(a.display_name, 'Unassigned'),
            'stages', jsonb_object_agg(tk.stage_id, tk.n)) as x
          from (select assigned_agent_id, stage_id, count(*) as n from tk group by 1, 2) tk
          left join public.support_agents a on a.id = tk.assigned_agent_id
          group by tk.assigned_agent_id, a.display_name) q), '[]'::jsonb),
      'by_product', case when private.has_permission(v_company, 'support_ticket_products.view') then coalesce((select jsonb_agg(x order by (x ->> 'tickets')::int desc, x ->> 'sku') from (
          select jsonb_build_object('product_id', x.product_id, 'sku', max(x.sku_snapshot), 'product_name', max(x.product_name_snapshot), 'tickets', count(distinct x.ticket_id),
            'negative', count(distinct x.ticket_id) filter (where pd.outcome_type = 'NEGATIVE')) as x
          from public.support_ticket_products x join period pd on pd.id = x.ticket_id group by x.product_id limit 50) q), '[]'::jsonb) end));
end;
$$;

revoke all on function private.support_stage_history_immutable(), private.support_pipeline_default_stages(), private.support_pipeline_add_stages(uuid, uuid),
  private.support_pipeline_ensure(uuid), private.support_pipeline_company_defaults(), private.support_stage_for_status(uuid, text, uuid),
  private.support_ticket_stage_before(), private.support_ticket_stage_after(), private.support_ticket_move(uuid, uuid, text, text),
  private.support_stages_stamp(uuid), private.support_stage_json(public.support_pipeline_stages)
  from public, anon, authenticated;
revoke all on function public.support_ticket_move_stage(uuid, uuid, uuid, text), public.support_pipelines_list(), public.support_pipeline_save(uuid, jsonb),
  public.support_pipeline_save_stages(uuid, jsonb, jsonb, text), public.support_pipeline_board(jsonb), public.support_ticket_stage_info(uuid),
  public.support_pipeline_report(uuid, date, date) from public, anon;
grant execute on function public.support_ticket_move_stage(uuid, uuid, uuid, text), public.support_pipelines_list(), public.support_pipeline_save(uuid, jsonb),
  public.support_pipeline_save_stages(uuid, jsonb, jsonb, text), public.support_pipeline_board(jsonb), public.support_ticket_stage_info(uuid),
  public.support_pipeline_report(uuid, date, date) to authenticated;

-- -----------------------------------------------------------------------------
-- 10. New tickets from a pipeline board enter that pipeline (20261226090000 version plus the pipeline)
-- -----------------------------------------------------------------------------
-- Create a ticket with its custom field values and products in one transaction (the existing
-- support_ticket_create does the ticket itself: number, SLA, automation, notifications).
create or replace function public.support_ticket_create_v2(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('support.manage_tickets');
  r jsonb;
  s record;
  v_products jsonb := p -> 'products';
  v_has_products boolean := jsonb_typeof(p -> 'products') = 'array' and jsonb_array_length(p -> 'products') > 0;
  v_missing text[] := '{}';
  v_values text[];
begin
  -- Standard fields the administrator made required on the form.
  for s in select f.standard_key, f.label from private.support_ticket_layout(v_company) l join private.support_ticket_standard_fields() f on f.standard_key = l.standard_key
           where l.is_visible and f.required_editable and l.is_required_override loop
    if (s.standard_key = 'products' and not v_has_products)
       or (s.standard_key = 'assigned_agent' and nullif(p ->> 'assigned_agent_id', '') is null)
       or (s.standard_key in ('category', 'subcategory', 'department', 'description') and nullif(btrim(coalesce(p ->> s.standard_key, '')), '') is null) then
      v_missing := v_missing || s.label;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception 'Fill in the required fields: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;
  if v_has_products and not (private.has_permission(v_company, 'support_ticket_products.manage') and private.has_permission(v_company, 'products.read')) then
    raise exception 'You are not allowed to add products to tickets (requires support_ticket_products.manage and products.read).' using errcode = '42501';
  end if;
  -- The pipeline the ticket was created from (the board); the insert trigger checks it belongs to the company.
  perform set_config('app.support_pipeline', coalesce(p ->> 'pipeline_id', ''), true);
  r := public.support_ticket_create(p - 'custom_fields' - 'products' - 'allow_archived_products' - 'pipeline_id');
  perform set_config('app.support_pipeline', '', true);
  v_values := private.support_ticket_values_apply(v_company, (r ->> 'id')::uuid, coalesce(p -> 'custom_fields', '{}'::jsonb), true);
  if v_has_products then
    perform private.support_ticket_products_apply(v_company, (r ->> 'id')::uuid, v_products, coalesce((p ->> 'allow_archived_products')::boolean, false));
  end if;
  return r || jsonb_build_object('custom_fields', cardinality(v_values), 'products', case when v_has_products then jsonb_array_length(v_products) else 0 end);
end;
$$;


-- -----------------------------------------------------------------------------
-- 11. ERP reset allowlist (20261226090000 plus the three pipeline tables; history first, pipelines last)
--     A reset company gets its default pipeline again with its next ticket.
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (0, 'support_ticket_field_values', 'Support Centre', 'Custom ticket field values'),
    (0, 'support_ticket_products', 'Support Centre', 'Products on support tickets'),
    (0, 'support_ticket_field_layout', 'Support Centre', 'New Ticket form layout'),
    (1, 'support_ticket_field_definitions', 'Support Centre', 'Custom ticket fields'),
    (0, 'support_ticket_stage_history', 'Support Centre', 'Ticket stage history'),
    (4, 'support_pipeline_stages', 'Support Centre', 'Pipeline stages'),
    (5, 'support_pipelines', 'Support Centre', 'Support pipelines'),
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
