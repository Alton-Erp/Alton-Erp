-- =============================================================================
-- Phase 5: bills of materials (BOM)
--
--   boms       one row per BOM version of a finished product / sub-assembly
--   bom_items  components required for output_quantity units of output
--
-- Clients have SELECT only; every change goes through SECURITY DEFINER RPCs.
-- Approved BOMs are immutable (a change is a new version), so a production
-- order always keeps the exact BOM version it was created from.
-- Creating or editing a BOM never moves stock.
--
-- Units: there is no unit-conversion master yet, so a component's BOM unit
-- must equal its inventory (base) unit. If a product's unit is changed later,
-- planning flags the line as UNIT_MISMATCH instead of calculating with it.
-- =============================================================================

-- Caller's company if it holds ANY of the permissions.
create or replace function private.require_any_permission(p_permissions text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_code    text;
begin
  if v_company is not null then
    foreach v_code in array p_permissions loop
      if private.has_permission(v_company, v_code) then
        return v_company;
      end if;
    end loop;
  end if;
  raise exception 'You are not allowed to perform this action (requires %).', array_to_string(p_permissions, ' or ') using errcode = '42501';
end;
$$;

revoke all on function private.require_any_permission(text[]) from public, anon, authenticated;

-- Production policy from company_settings (secure defaults). Segregation of
-- duties reuses the inventory setting so there is one company-wide switch.
create or replace function private.production_policy(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'segregation_of_duties', (private.inventory_policy(p_company) ->> 'segregation_of_duties')::boolean);
$$;

revoke all on function private.production_policy(uuid) from public, anon, authenticated;

-- Rounds a material quantity UP to the 3 decimals stock is kept in, so a
-- requirement is never understated.
create or replace function private.ceil_qty(p_value numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(ceil(p_value * 1000) / 1000, 3);
$$;

revoke all on function private.ceil_qty(numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table if not exists public.boms (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  bom_code            text not null check (bom_code ~ '^BOM-[0-9]{6,}$'),
  finished_product_id uuid not null,
  version             integer not null check (version between 1 and 9999),
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED')),
  effective_from      date not null,
  effective_to        date,
  output_quantity     numeric(14,3) not null check (output_quantity > 0),
  output_unit         text not null,
  notes               text check (notes is null or length(notes) <= 2000),
  created_by          uuid,
  submitted_by        uuid,
  submitted_at        timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  review_note         text check (review_note is null or length(review_note) <= 1000),
  archived_by         uuid,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint boms_dates check (effective_to is null or effective_to >= effective_from),
  constraint boms_product_version_unique unique (company_id, finished_product_id, version),
  constraint boms_code_version_unique unique (company_id, bom_code, version),
  constraint boms_id_company_unique unique (id, company_id),
  constraint boms_product_fk foreign key (finished_product_id, company_id)
    references public.products (id, company_id) on delete restrict
);

create index if not exists boms_company_product_idx on public.boms (company_id, finished_product_id, status);

comment on table public.boms is
  'Bill of materials versions. One bom_code per finished product; each change is a new version. Approved versions are immutable.';

create table if not exists public.bom_items (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  bom_id               uuid not null,
  line_no              integer not null check (line_no between 1 and 500),
  component_product_id uuid not null,
  quantity_required    numeric(18,6) not null check (quantity_required > 0),
  unit                 text not null,
  wastage_percentage   numeric(5,2) not null default 0 check (wastage_percentage >= 0 and wastage_percentage < 100),
  notes                text check (notes is null or length(notes) <= 500),
  created_at           timestamptz not null default now(),
  constraint bom_items_bom_fk foreign key (bom_id, company_id) references public.boms (id, company_id) on delete restrict,
  constraint bom_items_component_fk foreign key (component_product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint bom_items_component_unique unique (bom_id, component_product_id),
  constraint bom_items_line_unique unique (bom_id, line_no)
);

create index if not exists bom_items_component_idx on public.bom_items (company_id, component_product_id);

comment on column public.bom_items.quantity_required is 'Quantity of the component (in unit) needed for boms.output_quantity units of output, before wastage.';

-- -----------------------------------------------------------------------------
-- Immutability guards
-- -----------------------------------------------------------------------------
create or replace function private.guard_bom_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOMs are never deleted; archive them instead.' using errcode = '42501';
  end if;
  new.company_id := old.company_id;
  new.bom_code := old.bom_code;
  new.finished_product_id := old.finished_product_id;
  new.version := old.version;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if old.status in ('APPROVED', 'ARCHIVED')
     and (new.effective_from is distinct from old.effective_from
          or new.output_quantity is distinct from old.output_quantity
          or new.output_unit is distinct from old.output_unit
          or new.notes is distinct from old.notes
          or new.approved_by is distinct from old.approved_by) then
    raise exception 'An approved BOM cannot be changed. Create a new version instead.' using errcode = 'P0001';
  end if;
  if old.status = 'ARCHIVED' and new.status <> 'ARCHIVED' then
    raise exception 'An archived BOM cannot be reactivated. Create a new version instead.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function private.guard_bom_item_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.boms where id = coalesce(new.bom_id, old.bom_id);
  if v_status not in ('DRAFT', 'REJECTED') then
    raise exception 'Components of a % BOM cannot be changed. Create a new version instead.', lower(v_status) using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.guard_bom_write() from public, anon, authenticated;
revoke all on function private.guard_bom_item_write() from public, anon, authenticated;

drop trigger if exists boms_guard on public.boms;
create trigger boms_guard before update or delete on public.boms
  for each row execute function private.guard_bom_write();
drop trigger if exists boms_set_updated_at on public.boms;
create trigger boms_set_updated_at before update on public.boms
  for each row execute function private.set_updated_at();
drop trigger if exists bom_items_guard on public.bom_items;
create trigger bom_items_guard before insert or update or delete on public.bom_items
  for each row execute function private.guard_bom_item_write();

-- -----------------------------------------------------------------------------
-- RLS: read only for clients
-- -----------------------------------------------------------------------------
alter table public.boms enable row level security;
alter table public.bom_items enable row level security;
revoke all on table public.boms, public.bom_items from anon, authenticated;
grant select on public.boms, public.bom_items to authenticated;
grant all on table public.boms, public.bom_items to service_role;

drop policy if exists boms_select on public.boms;
create policy boms_select on public.boms for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));
drop policy if exists bom_items_select on public.bom_items;
create policy bom_items_select on public.bom_items for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));

-- -----------------------------------------------------------------------------
-- Validation helpers
-- -----------------------------------------------------------------------------

-- True when any of p_components (directly or through their own non-archived
-- BOMs) requires p_finished: the BOM would be circular.
create or replace function private.bom_creates_cycle(p_company uuid, p_finished uuid, p_components uuid[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive reach (product_id, depth) as (
    select unnest(p_components), 1
    union
    select bi.component_product_id, r.depth + 1
    from reach r
    join public.boms b on b.company_id = p_company and b.finished_product_id = r.product_id
      and b.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')
    join public.bom_items bi on bi.bom_id = b.id
    where r.depth < 25
  )
  select exists (select 1 from reach where product_id = p_finished);
$$;

revoke all on function private.bom_creates_cycle(uuid, uuid, uuid[]) from public, anon, authenticated;

-- Re-validates a stored BOM (used on submit and approve). Raises on problems.
create or replace function private.validate_bom(p_bom public.boms)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_item    record;
begin
  select * into v_product from public.products where id = p_bom.finished_product_id;
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    raise exception 'The output product % is inactive.', v_product.sku using errcode = 'P0001';
  end if;
  if v_product.product_type not in ('FINISHED_GOOD', 'COMPONENT') then
    raise exception 'Product % is a % and cannot be the output of a BOM.', v_product.sku, lower(v_product.product_type) using errcode = 'P0001';
  end if;
  if p_bom.output_unit <> v_product.base_unit then
    raise exception 'The BOM output unit (%) no longer matches the unit of % (%).', p_bom.output_unit, v_product.sku, v_product.base_unit
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.bom_items where bom_id = p_bom.id) then
    raise exception 'Add at least one component.' using errcode = 'P0001';
  end if;
  for v_item in
    select bi.line_no, bi.unit, p.sku, p.base_unit, p.status, p.archived_at, p.product_type
    from public.bom_items bi join public.products p on p.id = bi.component_product_id
    where bi.bom_id = p_bom.id order by bi.line_no
  loop
    if v_item.status <> 'ACTIVE' or v_item.archived_at is not null then
      raise exception 'Line %: component % is inactive.', v_item.line_no, v_item.sku using errcode = 'P0001';
    end if;
    if v_item.product_type not in ('RAW_MATERIAL', 'COMPONENT', 'PACKAGING_MATERIAL') then
      raise exception 'Line %: % is a % and cannot be used as a BOM component.', v_item.line_no, v_item.sku, lower(v_item.product_type)
        using errcode = 'P0001';
    end if;
    if v_item.unit <> v_item.base_unit then
      raise exception 'Line %: the BOM unit % does not match the inventory unit of % (%). No unit conversion is configured.',
        v_item.line_no, v_item.unit, v_item.sku, v_item.base_unit using errcode = 'P0001';
    end if;
  end loop;
  if private.bom_creates_cycle(p_bom.company_id, p_bom.finished_product_id,
       array(select component_product_id from public.bom_items where bom_id = p_bom.id)) then
    raise exception 'Circular BOM: a component (directly or through its own BOM) requires %.', v_product.sku using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.validate_bom(public.boms) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Create / edit (draft) — items replace the previous draft items
-- p_items: [{line_no?, component_product_id, quantity_required, unit?, wastage_percentage?, notes?}]
-- -----------------------------------------------------------------------------
create or replace function public.production_save_bom(
  p_bom_id              uuid,
  p_finished_product_id uuid,
  p_effective_from      date,
  p_effective_to        date,
  p_output_quantity     numeric,
  p_notes               text,
  p_items               jsonb,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_previous  jsonb;
  v_bom       public.boms;
  v_product   public.products;
  v_component public.products;
  v_item      jsonb;
  v_line      int := 0;
  v_qty       numeric;
  v_wastage   numeric;
  v_unit      text;
  v_seen      uuid[] := '{}';
  v_version   int;
  v_code      text;
begin
  if p_bom_id is null then
    if not private.has_permission(v_company, 'production_bom.create') then
      raise exception 'You are not allowed to create BOMs (requires production_bom.create).' using errcode = '42501';
    end if;
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'bom_create');
    if v_previous is not null then return v_previous; end if;
  else
    select * into v_bom from public.boms where id = p_bom_id and company_id = v_company for update;
    if not found then
      raise exception 'BOM not found in your company.' using errcode = 'P0001';
    end if;
    if v_bom.status not in ('DRAFT', 'REJECTED') then
      raise exception 'Only draft or rejected BOMs can be edited. Create a new version of % v%.', v_bom.bom_code, v_bom.version
        using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or v_bom.created_by = auth.uid()) then
      raise exception 'You can only edit your own draft BOMs (requires production_bom.update).' using errcode = '42501';
    end if;
    if p_finished_product_id is distinct from v_bom.finished_product_id then
      raise exception 'The output product of an existing BOM cannot be changed. Create a BOM for the other product.' using errcode = 'P0001';
    end if;
  end if;

  select * into v_product from public.products where id = p_finished_product_id and company_id = v_company;
  if not found then
    raise exception 'Output product not found in your company.' using errcode = 'P0001';
  end if;
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    raise exception 'Product % is inactive.', v_product.sku using errcode = 'P0001';
  end if;
  if v_product.product_type not in ('FINISHED_GOOD', 'COMPONENT') then
    raise exception 'Only finished goods and components (sub-assemblies) can have a BOM; % is a %.', v_product.sku, lower(v_product.product_type)
      using errcode = 'P0001';
  end if;
  if p_effective_from is null then
    raise exception 'Enter the date the BOM is effective from.' using errcode = 'P0001';
  end if;
  if p_effective_to is not null and p_effective_to < p_effective_from then
    raise exception 'The effective-to date cannot be before the effective-from date.' using errcode = 'P0001';
  end if;
  if p_output_quantity is null or p_output_quantity <= 0 or p_output_quantity <> round(p_output_quantity, 3) then
    raise exception 'Output quantity must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'Notes are limited to 2000 characters.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one component.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'A BOM can have at most 500 components.' using errcode = 'P0001';
  end if;

  -- Validate every component before writing anything.
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    begin
      v_qty := (v_item ->> 'quantity_required')::numeric;
      v_wastage := coalesce((v_item ->> 'wastage_percentage')::numeric, 0);
    exception when others then
      raise exception 'Line %: quantity and wastage must be numbers.', v_line using errcode = 'P0001';
    end;
    select * into v_component from public.products
    where id = (v_item ->> 'component_product_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'Line %: component not found in your company.', v_line using errcode = 'P0001';
    end if;
    if v_component.id = v_product.id then
      raise exception 'Line %: a product cannot be a component of itself.', v_line using errcode = 'P0001';
    end if;
    if v_component.status <> 'ACTIVE' or v_component.archived_at is not null then
      raise exception 'Line %: component % is inactive.', v_line, v_component.sku using errcode = 'P0001';
    end if;
    if v_component.product_type not in ('RAW_MATERIAL', 'COMPONENT', 'PACKAGING_MATERIAL') then
      raise exception 'Line %: % is a % and cannot be used as a BOM component (use raw materials, components or packaging).',
        v_line, v_component.sku, lower(v_component.product_type) using errcode = 'P0001';
    end if;
    if v_component.id = any(v_seen) then
      raise exception 'Line %: % is listed more than once. Combine the quantities on one line.', v_line, v_component.sku using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_component.id;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 6) then
      raise exception 'Line %: quantity must be greater than zero (up to 6 decimals).', v_line using errcode = 'P0001';
    end if;
    if v_wastage < 0 or v_wastage >= 100 or v_wastage <> round(v_wastage, 2) then
      raise exception 'Line %: wastage must be between 0 and 99.99 percent.', v_line using errcode = 'P0001';
    end if;
    v_unit := upper(btrim(coalesce(v_item ->> 'unit', v_component.base_unit)));
    if v_unit <> v_component.base_unit then
      raise exception 'Line %: unit % does not match the inventory unit of % (%). No unit conversion is configured, so enter the quantity in %.',
        v_line, v_unit, v_component.sku, v_component.base_unit, v_component.base_unit using errcode = 'P0001';
    end if;
  end loop;

  if private.bom_creates_cycle(v_company, v_product.id, v_seen) then
    raise exception 'Circular BOM: a component (directly or through its own BOM) requires %.', v_product.sku using errcode = 'P0001';
  end if;

  if p_bom_id is null then
    select coalesce(max(version), 0) + 1, min(bom_code) into v_version, v_code
    from public.boms where company_id = v_company and finished_product_id = v_product.id;
    v_code := coalesce(v_code, private.next_document_number(v_company, 'BOM'));
    insert into public.boms (company_id, bom_code, finished_product_id, version, effective_from, effective_to,
      output_quantity, output_unit, notes, created_by)
    values (v_company, v_code, v_product.id, v_version, p_effective_from, p_effective_to,
      p_output_quantity, v_product.base_unit, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
    returning * into v_bom;
  else
    update public.boms
    set effective_from = p_effective_from, effective_to = p_effective_to, output_quantity = p_output_quantity,
        output_unit = v_product.base_unit, notes = nullif(btrim(coalesce(p_notes, '')), ''),
        status = 'DRAFT', review_note = case when status = 'REJECTED' then review_note end
    where id = v_bom.id
    returning * into v_bom;
    delete from public.bom_items where bom_id = v_bom.id;
  end if;

  v_line := 0;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes)
    select v_company, v_bom.id, v_line, p.id, (v_item ->> 'quantity_required')::numeric, p.base_unit,
      coalesce((v_item ->> 'wastage_percentage')::numeric, 0), nullif(btrim(coalesce(v_item ->> 'notes', '')), '')
    from public.products p where p.id = (v_item ->> 'component_product_id')::uuid;
  end loop;

  perform private.write_audit_log(v_company, case when p_bom_id is null then 'production.bom_created' else 'production.bom_updated' end,
    'bom', v_bom.id::text, jsonb_build_object('bom_code', v_bom.bom_code, 'version', v_bom.version, 'components', v_line));

  v_previous := jsonb_build_object('bom_id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version);
  if p_bom_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- New draft version copied from an existing version (any status).
create or replace function public.production_new_bom_version(p_source_bom_id uuid, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_bom.create');
  v_previous jsonb;
  v_source   public.boms;
  v_new      public.boms;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'bom_new_version');
  if v_previous is not null then return v_previous; end if;

  select * into v_source from public.boms where id = p_source_bom_id and company_id = v_company;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  insert into public.boms (company_id, bom_code, finished_product_id, version, effective_from, output_quantity, output_unit, notes, created_by)
  select v_company, v_source.bom_code, v_source.finished_product_id,
    (select max(version) + 1 from public.boms where company_id = v_company and finished_product_id = v_source.finished_product_id),
    greatest(private.company_today(v_company), v_source.effective_from), v_source.output_quantity, v_source.output_unit, v_source.notes, auth.uid()
  returning * into v_new;
  insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes)
  select v_company, v_new.id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes
  from public.bom_items where bom_id = v_source.id;

  perform private.write_audit_log(v_company, 'production.bom_version_created', 'bom', v_new.id::text,
    jsonb_build_object('bom_code', v_new.bom_code, 'version', v_new.version, 'copied_from_version', v_source.version));
  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('bom_id', v_new.id, 'bom_code', v_new.bom_code, 'version', v_new.version));
end;
$$;

-- SUBMIT | WITHDRAW | APPROVE | REJECT | ARCHIVE
create or replace function public.production_bom_action(p_bom_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update', 'production_bom.approve']);
  v_bom     public.boms;
  v_other   public.boms;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_closed  text[] := '{}';
begin
  select * into v_bom from public.boms where id = p_bom_id and company_id = v_company for update;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'The note is limited to 1000 characters.' using errcode = 'P0001';
  end if;

  if p_action = 'SUBMIT' then
    if v_bom.status not in ('DRAFT', 'REJECTED') then
      raise exception 'Only draft BOMs can be submitted.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update')
            or (private.has_permission(v_company, 'production_bom.create') and v_bom.created_by = auth.uid())) then
      raise exception 'You are not allowed to submit this BOM.' using errcode = '42501';
    end if;
    perform private.validate_bom(v_bom);
    update public.boms set status = 'PENDING_APPROVAL', submitted_by = auth.uid(), submitted_at = now(), review_note = null
    where id = v_bom.id;

  elsif p_action = 'WITHDRAW' then
    if v_bom.status <> 'PENDING_APPROVAL' then
      raise exception 'Only a BOM awaiting approval can be withdrawn.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or v_bom.submitted_by = auth.uid()) then
      raise exception 'You are not allowed to withdraw this BOM.' using errcode = '42501';
    end if;
    update public.boms set status = 'DRAFT' where id = v_bom.id;

  elsif p_action in ('APPROVE', 'REJECT') then
    perform private.require_permission('production_bom.approve');
    if v_bom.status <> 'PENDING_APPROVAL' then
      raise exception 'This BOM is not awaiting approval.' using errcode = 'P0001';
    end if;
    if p_action = 'REJECT' then
      if v_note is null then
        raise exception 'Enter the reason for rejecting the BOM.' using errcode = 'P0001';
      end if;
      update public.boms set status = 'REJECTED', review_note = v_note where id = v_bom.id;
    else
      perform private.assert_not_self_approval(v_company, v_bom.created_by, v_bom.submitted_by);
      perform private.validate_bom(v_bom);
      -- One approved version per product at any date: an earlier version is
      -- closed the day before this one starts; a later or same-day start is a conflict.
      for v_other in
        select * from public.boms
        where company_id = v_company and finished_product_id = v_bom.finished_product_id and status = 'APPROVED' and id <> v_bom.id
          and effective_from <= coalesce(v_bom.effective_to, 'infinity'::date)
          and coalesce(effective_to, 'infinity'::date) >= v_bom.effective_from
        for update
      loop
        if v_other.effective_from >= v_bom.effective_from then
          raise exception 'Version % of this BOM is effective from %, which overlaps this version. Archive it or change the dates first.',
            v_other.version, v_other.effective_from using errcode = 'P0001';
        end if;
        update public.boms set effective_to = v_bom.effective_from - 1 where id = v_other.id;
        v_closed := v_closed || ('v' || v_other.version);
      end loop;
      update public.boms set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), review_note = v_note
      where id = v_bom.id;
    end if;

  elsif p_action = 'ARCHIVE' then
    perform private.require_permission('production_bom.update');
    if v_bom.status = 'ARCHIVED' then
      raise exception 'This BOM is already archived.' using errcode = 'P0001';
    end if;
    update public.boms set status = 'ARCHIVED', archived_by = auth.uid(), archived_at = now(),
      review_note = coalesce(v_note, review_note)
    where id = v_bom.id;
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end if;

  perform private.write_audit_log(v_company, 'production.bom_' || lower(p_action) ||
      case p_action when 'SUBMIT' then 'ted' when 'APPROVE' then 'd' when 'ARCHIVE' then 'd' when 'WITHDRAW' then 'n' else 'ed' end,
    'bom', v_bom.id::text,
    jsonb_build_object('bom_code', v_bom.bom_code, 'version', v_bom.version, 'note', v_note, 'closed_versions', to_jsonb(v_closed)));
  return (select jsonb_build_object('status', status, 'closed_versions', to_jsonb(v_closed)) from public.boms where id = v_bom.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Material requirements
-- -----------------------------------------------------------------------------

-- Usable stock (STORAGE locations of active warehouses) of a product,
-- optionally limited to one warehouse.
create or replace function private.storage_stock(p_company uuid, p_product uuid, p_warehouse uuid)
returns table (on_hand numeric, reserved numeric, available numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(b.on_hand), 0), coalesce(sum(b.reserved), 0), coalesce(sum(b.on_hand - b.reserved), 0)
  from public.inventory_balances b
  join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
  join public.warehouses w on w.id = b.warehouse_id and w.status = 'ACTIVE'
  where b.company_id = p_company and b.product_id = p_product and (p_warehouse is null or b.warehouse_id = p_warehouse);
$$;

revoke all on function private.storage_stock(uuid, uuid, uuid) from public, anon, authenticated;

-- Requirement lines for producing p_quantity units with a BOM:
--   base requirement  = quantity_required / output_quantity * p_quantity
--   total requirement = base * (1 + wastage% / 100), rounded UP to 3 decimals
create or replace function private.bom_requirement_lines(p_bom_id uuid, p_quantity numeric)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  component_active boolean, quantity_per_unit numeric, wastage_percentage numeric,
  base_requirement numeric, wastage_allowance numeric, total_requirement numeric, unit_matches boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select bi.line_no, p.id, p.sku, p.product_name, p.product_type, bi.unit, p.base_unit,
    (p.status = 'ACTIVE' and p.archived_at is null),
    round(bi.quantity_required / b.output_quantity, 6),
    bi.wastage_percentage,
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity),
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100))
      - private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity),
    private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity * (1 + bi.wastage_percentage / 100)),
    bi.unit = p.base_unit
  from public.boms b
  join public.bom_items bi on bi.bom_id = b.id
  join public.products p on p.id = bi.component_product_id
  where b.id = p_bom_id
  order by bi.line_no;
$$;

revoke all on function private.bom_requirement_lines(uuid, numeric) from public, anon, authenticated;

-- Planning: requirements with live availability. Never moves stock.
-- Suggested replenishment = shortage, plus enough to bring usable stock back
-- to the component's reorder level when one is set.
create or replace function public.production_bom_requirements(p_bom_id uuid, p_quantity numeric, p_warehouse_id uuid default null)
returns table (
  line_no int, component_product_id uuid, sku text, product_name text, product_type text, unit text, inventory_unit text,
  quantity_per_unit numeric, wastage_percentage numeric, base_requirement numeric, wastage_allowance numeric,
  total_requirement numeric, on_hand numeric, reserved numeric, available numeric, shortage numeric,
  suggested_quantity numeric, reorder_level numeric, line_status text, message text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_plan.create', 'production_bom.read', 'manufacturing.read']);
begin
  if not exists (select 1 from public.boms where id = p_bom_id and company_id = v_company) then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if p_warehouse_id is not null and not exists (select 1 from public.warehouses where id = p_warehouse_id and company_id = v_company) then
    raise exception 'Warehouse not found in your company.' using errcode = 'P0001';
  end if;
  return query
  select r.line_no, r.component_product_id, r.sku, r.product_name, r.product_type, r.unit, r.inventory_unit,
    r.quantity_per_unit, r.wastage_percentage, r.base_requirement, r.wastage_allowance, r.total_requirement,
    s.on_hand, s.reserved,
    case when r.unit_matches then s.available end,
    case when r.unit_matches then greatest(r.total_requirement - s.available, 0) end,
    case when r.unit_matches then greatest(r.total_requirement + coalesce(p.reorder_level, 0) - s.available,
                                           greatest(r.total_requirement - s.available, 0)) end,
    p.reorder_level,
    case
      when not r.unit_matches then 'UNIT_MISMATCH'
      when not r.component_active then 'INACTIVE'
      when s.available >= r.total_requirement then 'SUFFICIENT'
      when s.available > 0 then 'PARTIAL'
      else 'SHORTAGE'
    end,
    case
      when not r.unit_matches then format('BOM unit %s differs from inventory unit %s; no conversion is configured, so availability is not calculated.', r.unit, r.inventory_unit)
      when not r.component_active then 'Component is inactive or archived.'
      when s.available >= r.total_requirement then null
      when s.available > 0 then 'Only part of the requirement is available.'
      else 'No usable stock available.'
    end
  from private.bom_requirement_lines(p_bom_id, p_quantity) r
  join public.products p on p.id = r.component_product_id
  cross join lateral private.storage_stock(v_company, r.component_product_id, p_warehouse_id) s
  order by r.line_no;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.production_save_bom(uuid, uuid, date, date, numeric, text, jsonb, uuid)',
    'public.production_new_bom_version(uuid, uuid)',
    'public.production_bom_action(uuid, text, text)',
    'public.production_bom_requirements(uuid, numeric, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- List views (security_invoker: RLS of the underlying tables applies)
-- -----------------------------------------------------------------------------
create or replace view public.bom_list
with (security_invoker = true) as
select b.*, p.sku, p.product_name, p.product_type, p.status as product_status,
  (select count(*) from public.bom_items bi where bi.bom_id = b.id) as item_count
from public.boms b
join public.products p on p.id = b.finished_product_id;

create or replace view public.bom_item_list
with (security_invoker = true) as
select bi.*, p.sku, p.product_name, p.product_type, p.base_unit as inventory_unit, p.status as product_status,
  (p.archived_at is not null) as product_archived, p.standard_cost
from public.bom_items bi
join public.products p on p.id = bi.component_product_id;

revoke all on public.bom_list, public.bom_item_list from anon, authenticated;
grant select on public.bom_list, public.bom_item_list to authenticated;
