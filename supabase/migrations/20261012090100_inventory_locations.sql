-- =============================================================================
-- Phase 4: inventory helpers, warehouses and storage locations
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Caller's active company, or an error if the caller lacks the permission.
create or replace function private.require_permission(p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null or not private.has_permission(v_company, p_permission) then
    raise exception 'You are not allowed to perform this action (requires %).', p_permission using errcode = '42501';
  end if;
  return v_company;
end;
$$;

revoke all on function private.require_permission(text) from public, anon, authenticated;

-- Inventory policy from company_settings, with secure defaults:
--   inventory.segregation_of_duties (boolean, default TRUE)
--   inventory.expiry_warning_days   (integer, default 30)
create or replace function private.inventory_policy(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'segregation_of_duties', coalesce((
      select case when jsonb_typeof(setting_value) = 'boolean' then (setting_value)::text::boolean end
      from public.company_settings where company_id = p_company and setting_key = 'inventory.segregation_of_duties'), true),
    'expiry_warning_days', coalesce((
      select case when jsonb_typeof(setting_value) = 'number' then greatest(0, least(365, (setting_value)::text::numeric::int)) end
      from public.company_settings where company_id = p_company and setting_key = 'inventory.expiry_warning_days'), 30)
  );
$$;

revoke all on function private.inventory_policy(uuid) from public, anon, authenticated;

-- "Today" and day boundaries in the company's timezone (reporting timezone).
create or replace function private.company_tz(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select timezone from public.companies where id = p_company), 'UTC');
$$;

create or replace function private.company_today(p_company uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone private.company_tz(p_company))::date;
$$;

-- Start of a calendar day in the company timezone, as timestamptz.
create or replace function private.company_day_start(p_company uuid, p_day date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (p_day::timestamp) at time zone private.company_tz(p_company);
$$;

revoke all on function private.company_tz(uuid) from public, anon, authenticated;
revoke all on function private.company_today(uuid) from public, anon, authenticated;
revoke all on function private.company_day_start(uuid, date) from public, anon, authenticated;

-- Per-company document numbering (TXN-000001, ADJ-000001, ...). The upsert
-- row-locks the counter, so concurrent callers get distinct numbers.
create table if not exists public.inventory_number_sequences (
  company_id uuid not null references public.companies (id) on delete restrict,
  prefix     text not null check (prefix ~ '^[A-Z]{2,5}$'),
  last_value bigint not null default 0,
  primary key (company_id, prefix)
);

alter table public.inventory_number_sequences enable row level security;
revoke all on table public.inventory_number_sequences from anon, authenticated;
grant all on table public.inventory_number_sequences to service_role;

create or replace function private.next_document_number(p_company uuid, p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  insert into public.inventory_number_sequences (company_id, prefix, last_value)
  values (p_company, p_prefix, 1)
  on conflict (company_id, prefix) do update set last_value = public.inventory_number_sequences.last_value + 1
  returning last_value into v_next;
  return p_prefix || '-' || lpad(v_next::text, 6, '0');
end;
$$;

revoke all on function private.next_document_number(uuid, text) from public, anon, authenticated;

-- Idempotency for stock-changing requests (double clicks / retries).
-- The first request inserts the key; a concurrent duplicate blocks on the
-- primary key until the first commits, then receives the stored result.
create table if not exists public.inventory_requests (
  company_id      uuid not null references public.companies (id) on delete restrict,
  idempotency_key uuid not null,
  operation       text not null,
  result          jsonb,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  primary key (company_id, idempotency_key)
);

alter table public.inventory_requests enable row level security;
revoke all on table public.inventory_requests from anon, authenticated;
grant all on table public.inventory_requests to service_role;

-- Returns the stored result if this key was already processed, else NULL
-- (and claims the key for the current transaction).
create or replace function private.idempotency_begin(p_company uuid, p_key uuid, p_operation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.inventory_requests;
begin
  if p_key is null then
    raise exception 'A request id (idempotency key) is required.' using errcode = 'P0001';
  end if;
  insert into public.inventory_requests (company_id, idempotency_key, operation, created_by)
  values (p_company, p_key, p_operation, auth.uid())
  on conflict do nothing;
  if found then
    return null;
  end if;
  select * into v_existing from public.inventory_requests where company_id = p_company and idempotency_key = p_key;
  if v_existing.operation <> p_operation then
    raise exception 'This request id was already used for a different operation.' using errcode = 'P0001';
  end if;
  return coalesce(v_existing.result, '{}'::jsonb) || jsonb_build_object('duplicate', true);
end;
$$;

create or replace function private.idempotency_finish(p_company uuid, p_key uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_requests set result = p_result where company_id = p_company and idempotency_key = p_key;
  return p_result;
end;
$$;

revoke all on function private.idempotency_begin(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.idempotency_finish(uuid, uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Warehouses
-- -----------------------------------------------------------------------------
create table if not exists public.warehouses (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  warehouse_code text not null check (warehouse_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  warehouse_name text not null check (length(btrim(warehouse_name)) between 1 and 120),
  address        text check (address is null or length(address) <= 500),
  status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  is_default     boolean not null default false,
  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint warehouses_company_code_unique unique (company_id, warehouse_code),
  constraint warehouses_id_company_unique unique (id, company_id),
  constraint warehouses_default_is_active check (not is_default or status = 'ACTIVE')
);

create unique index if not exists warehouses_one_default_per_company
  on public.warehouses (company_id) where is_default;

comment on table public.warehouses is 'Company warehouses. Never deleted; deactivated only when empty. The default warehouse is configurable (is_default).';

-- -----------------------------------------------------------------------------
-- Locations (zone / area / rack / shelf / bin hierarchy within a warehouse)
-- -----------------------------------------------------------------------------
create table if not exists public.inventory_locations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  warehouse_id       uuid not null,
  parent_location_id uuid,
  location_code      text not null check (location_code ~ '^[A-Z0-9][A-Z0-9_./-]{0,29}$'),
  location_name      text not null check (length(btrim(location_name)) between 1 and 120),
  location_type      text not null default 'BIN' check (location_type in ('GENERAL', 'ZONE', 'AREA', 'RACK', 'SHELF', 'BIN')),
  is_default         boolean not null default false,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint inventory_locations_wh_code_unique unique (warehouse_id, location_code),
  constraint inventory_locations_id_company_unique unique (id, company_id),
  constraint inventory_locations_id_wh_unique unique (id, warehouse_id),
  constraint inventory_locations_id_wh_company_unique unique (id, warehouse_id, company_id),
  constraint inventory_locations_warehouse_fk foreign key (warehouse_id, company_id)
    references public.warehouses (id, company_id) on delete restrict,
  -- Parent must be in the same warehouse.
  constraint inventory_locations_parent_fk foreign key (parent_location_id, warehouse_id)
    references public.inventory_locations (id, warehouse_id) on delete restrict,
  constraint inventory_locations_not_own_parent check (parent_location_id is null or parent_location_id <> id)
);

create unique index if not exists inventory_locations_one_default_per_wh
  on public.inventory_locations (warehouse_id) where is_default;
create index if not exists inventory_locations_company_idx on public.inventory_locations (company_id, warehouse_id);

comment on table public.inventory_locations is 'Storage locations. Each warehouse has a default GENERAL location created automatically, so stock can be held "in the warehouse" before being put away.';

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create or replace function private.before_warehouse_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.warehouse_code := upper(btrim(new.warehouse_code));
  new.warehouse_name := btrim(new.warehouse_name);
  new.address := nullif(btrim(coalesce(new.address, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.warehouse_code := old.warehouse_code;
    if old.status = 'ACTIVE' and new.status = 'INACTIVE' then
      if exists (select 1 from public.inventory_balances b where b.warehouse_id = old.id and (b.on_hand <> 0 or b.reserved <> 0)) then
        raise exception 'This warehouse still holds stock. Transfer it out before deactivating.' using errcode = 'P0001';
      end if;
      new.is_default := false;
    end if;
  end if;
  new.updated_by := auth.uid();

  -- Making this the default clears any previous default (one per company).
  if new.is_default and (tg_op = 'INSERT' or not old.is_default) then
    update public.warehouses set is_default = false
    where company_id = new.company_id and is_default and id <> new.id;
  end if;
  return new;
end;
$$;

create or replace function private.after_warehouse_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.inventory_locations (company_id, warehouse_id, location_code, location_name, location_type, is_default, created_by)
  values (new.company_id, new.id, 'GENERAL', 'General area', 'GENERAL', true, auth.uid());
  return null;
end;
$$;

create or replace function private.before_location_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_depth int := 0;
begin
  new.location_code := upper(btrim(new.location_code));
  new.location_name := btrim(new.location_name);
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.warehouses w where w.id = new.warehouse_id and w.company_id = new.company_id and w.status = 'ACTIVE') then
      raise exception 'Locations can only be added to an active warehouse of your company.' using errcode = 'P0001';
    end if;
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.warehouse_id := old.warehouse_id;
    new.location_code := old.location_code;
    new.is_default := old.is_default;
    if old.status = 'ACTIVE' and new.status = 'INACTIVE' then
      if old.is_default then
        raise exception 'The default location of a warehouse cannot be deactivated.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.inventory_balances b where b.location_id = old.id and (b.on_hand <> 0 or b.reserved <> 0)) then
        raise exception 'This location still holds stock. Transfer it out before deactivating.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.inventory_locations c where c.parent_location_id = old.id and c.status = 'ACTIVE') then
        raise exception 'Deactivate the child locations first.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  new.updated_by := auth.uid();

  -- Parent must be active and must not create a cycle.
  if new.parent_location_id is not null and (tg_op = 'INSERT' or new.parent_location_id is distinct from old.parent_location_id) then
    if not exists (select 1 from public.inventory_locations p where p.id = new.parent_location_id and p.status = 'ACTIVE') then
      raise exception 'The parent location is inactive or does not exist.' using errcode = 'P0001';
    end if;
    v_cursor := new.parent_location_id;
    while v_cursor is not null loop
      if v_cursor = new.id then
        raise exception 'A location cannot be placed inside itself.' using errcode = 'P0001';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 10 then
        raise exception 'Location hierarchy is limited to 10 levels.' using errcode = 'P0001';
      end if;
      select parent_location_id into v_cursor from public.inventory_locations where id = v_cursor;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function private.before_warehouse_write() from public, anon, authenticated;
revoke all on function private.after_warehouse_insert() from public, anon, authenticated;
revoke all on function private.before_location_write() from public, anon, authenticated;

-- Audit
create or replace function private.audit_storage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := case tg_table_name when 'warehouses' then 'warehouse' else 'inventory_location' end;
  -- Via jsonb: the record type differs per table, so fields can't be referenced directly.
  v_code text := coalesce(to_jsonb(new) ->> 'warehouse_code', to_jsonb(new) ->> 'location_code');
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_log(new.company_id, v_type || '.created', v_type, new.id::text, jsonb_build_object('code', v_code));
  elsif new.status is distinct from old.status then
    perform private.write_audit_log(new.company_id, v_type || case when new.status = 'ACTIVE' then '.activated' else '.deactivated' end,
      v_type, new.id::text, jsonb_build_object('code', v_code));
  else
    perform private.write_audit_log(new.company_id, v_type || '.updated', v_type, new.id::text, jsonb_build_object('code', v_code));
  end if;
  return null;
end;
$$;

revoke all on function private.audit_storage_change() from public, anon, authenticated;

-- Note: the deactivation guards reference public.inventory_balances, created in
-- the next migration (PL/pgSQL resolves table names at execution time).

drop trigger if exists warehouses_before_write on public.warehouses;
create trigger warehouses_before_write before insert or update on public.warehouses
  for each row execute function private.before_warehouse_write();
drop trigger if exists warehouses_set_updated_at on public.warehouses;
create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function private.set_updated_at();
drop trigger if exists warehouses_after_insert on public.warehouses;
create trigger warehouses_after_insert after insert on public.warehouses
  for each row execute function private.after_warehouse_insert();
drop trigger if exists warehouses_audit on public.warehouses;
create trigger warehouses_audit after insert or update on public.warehouses
  for each row execute function private.audit_storage_change();

drop trigger if exists inventory_locations_before_write on public.inventory_locations;
create trigger inventory_locations_before_write before insert or update on public.inventory_locations
  for each row execute function private.before_location_write();
drop trigger if exists inventory_locations_set_updated_at on public.inventory_locations;
create trigger inventory_locations_set_updated_at before update on public.inventory_locations
  for each row execute function private.set_updated_at();
drop trigger if exists inventory_locations_audit on public.inventory_locations;
create trigger inventory_locations_audit after insert or update on public.inventory_locations
  for each row execute function private.audit_storage_change();

-- -----------------------------------------------------------------------------
-- RLS and grants (no DELETE: history references these rows)
-- -----------------------------------------------------------------------------
alter table public.warehouses enable row level security;
alter table public.inventory_locations enable row level security;

revoke all on table public.warehouses, public.inventory_locations from anon, authenticated;
grant all on table public.warehouses, public.inventory_locations to service_role;

grant select on public.warehouses, public.inventory_locations to authenticated;
grant insert (company_id, warehouse_code, warehouse_name, address, status, is_default) on public.warehouses to authenticated;
grant update (warehouse_name, address, status, is_default) on public.warehouses to authenticated;
grant insert (company_id, warehouse_id, parent_location_id, location_code, location_name, location_type, status) on public.inventory_locations to authenticated;
grant update (parent_location_id, location_name, location_type, status) on public.inventory_locations to authenticated;

drop policy if exists warehouses_select on public.warehouses;
create policy warehouses_select on public.warehouses for select to authenticated
  using (private.has_permission(company_id, 'inventory.read') or private.has_permission(company_id, 'inventory_warehouse.manage'));
drop policy if exists warehouses_insert on public.warehouses;
create policy warehouses_insert on public.warehouses for insert to authenticated
  with check (private.has_permission(company_id, 'inventory_warehouse.manage'));
drop policy if exists warehouses_update on public.warehouses;
create policy warehouses_update on public.warehouses for update to authenticated
  using (private.has_permission(company_id, 'inventory_warehouse.manage'))
  with check (private.has_permission(company_id, 'inventory_warehouse.manage'));

drop policy if exists inventory_locations_select on public.inventory_locations;
create policy inventory_locations_select on public.inventory_locations for select to authenticated
  using (private.has_permission(company_id, 'inventory.read') or private.has_permission(company_id, 'inventory_location.manage'));
drop policy if exists inventory_locations_insert on public.inventory_locations;
create policy inventory_locations_insert on public.inventory_locations for insert to authenticated
  with check (private.has_permission(company_id, 'inventory_location.manage'));
drop policy if exists inventory_locations_update on public.inventory_locations;
create policy inventory_locations_update on public.inventory_locations for update to authenticated
  using (private.has_permission(company_id, 'inventory_location.manage'))
  with check (private.has_permission(company_id, 'inventory_location.manage'));
