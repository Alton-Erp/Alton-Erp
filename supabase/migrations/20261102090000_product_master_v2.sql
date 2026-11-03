-- =============================================================================
-- ALTON ERP V2 â€” Stage 1: Product Master and BOM
--
-- Extends the existing tables (nothing is dropped, reset or re-keyed):
--   products
--     * three more product types: SUBASSEMBLY, OUTSOURCED_COMPONENT, CONSUMABLE
--     * new optional fields: standard_manufacturing_cost, minimum_level, remarks
--     * preferred_supplier_id becomes writable (FK to suppliers already exists)
--     * incomplete products are accepted: a blank SKU gets the next automatic
--       code for its type (FG-000001 â€¦), a blank source type and unit are
--       filled from the product type. Only the name and type are required.
--     * has_bom follows the BOM: it turns on when a BOM version is activated
--       and off when the last active version is archived
--     * product_kpis(): counts per type, products without an active BOM and
--       products with missing information (existing keys unchanged)
--   bom_items
--     * source_type per component: IN_HOUSE / OUTSOURCED / PURCHASED
--     * preferred_supplier_id per component (same-company supplier)
--   BOM functions
--     * any product type except raw / packaging / consumable can have a BOM;
--       any product can be a component (circular BOMs are still refused)
--     * a draft BOM can be saved without components (activation still needs one)
--     * activating a revised version supersedes older active versions that start
--       on the same day or later (they are archived, history is kept)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. products: types and new fields
-- -----------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.products'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%product_type%'
  loop
    execute format('alter table public.products drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.products add constraint products_product_type_check check (product_type in (
  'FINISHED_GOOD', 'RAW_MATERIAL', 'COMPONENT', 'SUBASSEMBLY', 'OUTSOURCED_COMPONENT', 'PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER'));

alter table public.products add column if not exists standard_manufacturing_cost numeric(14,2);
alter table public.products add column if not exists minimum_level numeric(14,3);
alter table public.products add column if not exists remarks text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_mfg_cost_non_negative') then
    alter table public.products add constraint products_mfg_cost_non_negative
      check (standard_manufacturing_cost is null or standard_manufacturing_cost >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_min_level_non_negative') then
    alter table public.products add constraint products_min_level_non_negative
      check (minimum_level is null or minimum_level >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_remarks_length') then
    alter table public.products add constraint products_remarks_length
      check (remarks is null or length(remarks) <= 2000);
  end if;
end;
$$;

comment on column public.products.standard_cost is 'Standard purchase cost per base unit (optional).';
comment on column public.products.standard_manufacturing_cost is 'Standard manufacturing cost per base unit (optional).';
comment on column public.products.minimum_level is 'Minimum stock to keep (optional). Reorder level is the point at which to buy or make more.';

grant insert (standard_manufacturing_cost, minimum_level, remarks, preferred_supplier_id) on public.products to authenticated;
grant update (standard_manufacturing_cost, minimum_level, remarks, preferred_supplier_id) on public.products to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Defaults for incomplete products (runs before products_before_write)
-- -----------------------------------------------------------------------------
create or replace function private.product_sku_prefix(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'FINISHED_GOOD' then 'FG'
    when 'RAW_MATERIAL' then 'RM'
    when 'COMPONENT' then 'CMP'
    when 'SUBASSEMBLY' then 'SUB'
    when 'OUTSOURCED_COMPONENT' then 'OSC'
    when 'PACKAGING_MATERIAL' then 'PKG'
    when 'CONSUMABLE' then 'CON'
    else 'ITM' end;
$$;

create or replace function private.product_default_source(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_type in ('FINISHED_GOOD', 'SUBASSEMBLY', 'COMPONENT') then 'IN_HOUSE' else 'OUTSOURCED' end;
$$;

-- Next free automatic SKU for a type in a company: PREFIX-000001. Skips codes
-- already taken by manually entered SKUs. Uses the shared numbering table
-- under its own key (SKU + prefix), so it never collides with document numbers.
create or replace function private.next_product_sku(p_company uuid, p_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := private.product_sku_prefix(p_type);
  v_key    text := left('SKU' || v_prefix, 5);
  v_next   bigint;
  v_sku    text;
begin
  loop
    insert into public.inventory_number_sequences (company_id, prefix, last_value)
    values (p_company, v_key, 1)
    on conflict (company_id, prefix) do update set last_value = public.inventory_number_sequences.last_value + 1
    returning last_value into v_next;
    v_sku := v_prefix || '-' || lpad(v_next::text, 6, '0');
    exit when not exists (select 1 from public.products where company_id = p_company and lower(sku) = lower(v_sku));
  end loop;
  return v_sku;
end;
$$;

create or replace function private.product_fill_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.product_type is null then
    raise exception 'Select the product type.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' and nullif(btrim(coalesce(new.sku, '')), '') is null then
    new.sku := private.next_product_sku(new.company_id, new.product_type);
  end if;
  new.sku := btrim(new.sku);
  if new.default_source_type is null then
    new.default_source_type := private.product_default_source(new.product_type);
  end if;
  if nullif(btrim(coalesce(new.base_unit, '')), '') is null then
    new.base_unit := 'PCS';
  end if;
  new.remarks := nullif(btrim(coalesce(new.remarks, '')), '');
  return new;
end;
$$;

revoke all on function private.product_sku_prefix(text) from public, anon, authenticated;
revoke all on function private.product_default_source(text) from public, anon, authenticated;
revoke all on function private.next_product_sku(uuid, text) from public, anon, authenticated;
revoke all on function private.product_fill_defaults() from public, anon, authenticated;

-- Trigger names fire in alphabetical order: products_a_fill_defaults runs
-- before products_before_write (normalisation and permission guards).
drop trigger if exists products_a_fill_defaults on public.products;
create trigger products_a_fill_defaults
  before insert or update on public.products
  for each row execute function private.product_fill_defaults();

-- Preview of the SKU a new product of this type would get (not reserved).
create or replace function public.product_sku_preview(p_product_type text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.product_sku_prefix(p_product_type) || '-' || lpad((coalesce((
    select last_value from public.inventory_number_sequences
    where company_id = private.current_company_id() and prefix = left('SKU' || private.product_sku_prefix(p_product_type), 5)), 0) + 1)::text, 6, '0')
  where private.has_permission(private.current_company_id(), 'products.create');
$$;

revoke all on function public.product_sku_preview(text) from public, anon;
grant execute on function public.product_sku_preview(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. bom_items: source type and preferred supplier per component
-- -----------------------------------------------------------------------------
alter table public.bom_items add column if not exists source_type text;
alter table public.bom_items add column if not exists preferred_supplier_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bom_items_source_type_check') then
    alter table public.bom_items add constraint bom_items_source_type_check
      check (source_type is null or source_type in ('IN_HOUSE', 'OUTSOURCED', 'PURCHASED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bom_items_supplier_fk') then
    alter table public.bom_items add constraint bom_items_supplier_fk
      foreign key (preferred_supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict;
  end if;
end;
$$;

comment on column public.bom_items.source_type is 'How this component is obtained: IN_HOUSE (made), OUTSOURCED (processed by a supplier) or PURCHASED (bought).';

-- Default component source from the product master.
create or replace function private.default_bom_source(p_product public.products)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_product.default_source_type = 'IN_HOUSE' then 'IN_HOUSE'
    when p_product.product_type in ('RAW_MATERIAL', 'PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER') then 'PURCHASED'
    when p_product.default_source_type = 'OUTSOURCED' then 'OUTSOURCED'
    else 'IN_HOUSE' end;
$$;

revoke all on function private.default_bom_source(public.products) from public, anon, authenticated;

-- The view lists bi.*, so it is rebuilt to pick up the new columns. Its shape is
-- kept identical to the Phase 5 definition (bi.* first) so re-applying that
-- migration stays valid; supplier names are read from public.suppliers.
drop view if exists public.bom_item_list;
create view public.bom_item_list
with (security_invoker = true) as
select bi.*, p.sku, p.product_name, p.product_type, p.base_unit as inventory_unit, p.status as product_status,
  (p.archived_at is not null) as product_archived, p.standard_cost
from public.bom_items bi
join public.products p on p.id = bi.component_product_id;

revoke all on public.bom_item_list from anon, authenticated;
grant select on public.bom_item_list to authenticated;

-- -----------------------------------------------------------------------------
-- 4. BOM validation and save (replaces the Phase 5 versions)
-- -----------------------------------------------------------------------------
create or replace function private.bom_output_type_ok(p_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('FINISHED_GOOD', 'SUBASSEMBLY', 'COMPONENT', 'OUTSOURCED_COMPONENT', 'OTHER');
$$;

revoke all on function private.bom_output_type_ok(text) from public, anon, authenticated;

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
  if not private.bom_output_type_ok(v_product.product_type) then
    raise exception 'Product % is a % and cannot be the output of a BOM.', v_product.sku, lower(replace(v_product.product_type, '_', ' ')) using errcode = 'P0001';
  end if;
  if p_bom.output_unit <> v_product.base_unit then
    raise exception 'The BOM output unit (%) no longer matches the unit of % (%).', p_bom.output_unit, v_product.sku, v_product.base_unit
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.bom_items where bom_id = p_bom.id) then
    raise exception 'Add at least one component.' using errcode = 'P0001';
  end if;
  for v_item in
    select bi.line_no, bi.unit, p.sku, p.base_unit, p.status, p.archived_at
    from public.bom_items bi join public.products p on p.id = bi.component_product_id
    where bi.bom_id = p_bom.id order by bi.line_no
  loop
    if v_item.status <> 'ACTIVE' or v_item.archived_at is not null then
      raise exception 'Line %: component % is inactive.', v_item.line_no, v_item.sku using errcode = 'P0001';
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

-- p_items: [{component_product_id, quantity_required, unit?, wastage_percentage?, notes?,
--            source_type?, preferred_supplier_id?}]
-- Missing source type / supplier default from the component's product master.
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
  v_items     jsonb := coalesce(p_items, '[]'::jsonb);
  v_line      int := 0;
  v_qty       numeric;
  v_wastage   numeric;
  v_unit      text;
  v_source    text;
  v_supplier  uuid;
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
      raise exception 'Only draft BOMs can be edited. Use "Edit components" on % v% to start a new version.', v_bom.bom_code, v_bom.version
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
  if not private.bom_output_type_ok(v_product.product_type) then
    raise exception 'Raw materials, packaging and consumables cannot have a BOM; % is a %.', v_product.sku, lower(replace(v_product.product_type, '_', ' '))
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
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'Components must be a list.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_items) > 500 then
    raise exception 'A BOM can have at most 500 components.' using errcode = 'P0001';
  end if;

  -- Validate every component before writing anything.
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_line := v_line + 1;
    begin
      v_qty := (v_item ->> 'quantity_required')::numeric;
      v_wastage := coalesce(nullif(v_item ->> 'wastage_percentage', '')::numeric, 0);
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
      raise exception 'Line %: component % is inactive. Activate it in the Product Master first.', v_line, v_component.sku using errcode = 'P0001';
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
    v_unit := upper(btrim(coalesce(nullif(v_item ->> 'unit', ''), v_component.base_unit)));
    if v_unit <> v_component.base_unit then
      raise exception 'Line %: unit % does not match the inventory unit of % (%). No unit conversion is configured, so enter the quantity in %.',
        v_line, v_unit, v_component.sku, v_component.base_unit, v_component.base_unit using errcode = 'P0001';
    end if;
    v_source := upper(nullif(btrim(coalesce(v_item ->> 'source_type', '')), ''));
    if v_source is not null and v_source not in ('IN_HOUSE', 'OUTSOURCED', 'PURCHASED') then
      raise exception 'Line %: source must be In-house, Outsourced or Purchased.', v_line using errcode = 'P0001';
    end if;
    v_supplier := nullif(v_item ->> 'preferred_supplier_id', '')::uuid;
    if v_supplier is not null and not exists (select 1 from public.suppliers where id = v_supplier and company_id = v_company) then
      raise exception 'Line %: preferred supplier not found in your company.', v_line using errcode = 'P0001';
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
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_line := v_line + 1;
    insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes,
      source_type, preferred_supplier_id)
    select v_company, v_bom.id, v_line, p.id, (v_item ->> 'quantity_required')::numeric, p.base_unit,
      coalesce(nullif(v_item ->> 'wastage_percentage', '')::numeric, 0), nullif(btrim(coalesce(v_item ->> 'notes', '')), ''),
      coalesce(upper(nullif(btrim(coalesce(v_item ->> 'source_type', '')), '')), private.default_bom_source(p)),
      coalesce(nullif(v_item ->> 'preferred_supplier_id', '')::uuid, p.preferred_supplier_id)
    from public.products p where p.id = (v_item ->> 'component_product_id')::uuid;
  end loop;

  perform private.write_audit_log(v_company, case when p_bom_id is null then 'production.bom_created' else 'production.bom_updated' end,
    'bom', v_bom.id::text, jsonb_build_object('bom_code', v_bom.bom_code, 'version', v_bom.version, 'components', v_line));

  v_previous := jsonb_build_object('bom_id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version, 'components', v_line);
  if p_bom_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- New draft version copied from an existing version (any status), including
-- the component source and supplier.
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
  insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes,
    source_type, preferred_supplier_id)
  select v_company, v_new.id, line_no, component_product_id, quantity_required, unit, wastage_percentage, notes, source_type, preferred_supplier_id
  from public.bom_items where bom_id = v_source.id;

  perform private.write_audit_log(v_company, 'production.bom_version_created', 'bom', v_new.id::text,
    jsonb_build_object('bom_code', v_new.bom_code, 'version', v_new.version, 'copied_from_version', v_source.version));
  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('bom_id', v_new.id, 'bom_code', v_new.bom_code, 'version', v_new.version));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. One-step activation supersedes older versions starting the same day or later
-- -----------------------------------------------------------------------------
create or replace function public.production_bom_activate(p_bom_id uuid, p_note text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bom    public.boms;
  v_old    public.boms;
  v_result jsonb;
  v_superseded text[] := '{}';
begin
  select * into v_bom from public.boms where id = p_bom_id;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if v_bom.status in ('DRAFT', 'REJECTED') then
    perform public.production_bom_action(p_bom_id, 'SUBMIT', p_note);
  elsif v_bom.status <> 'PENDING_APPROVAL' then
    raise exception 'This BOM is already %.', lower(replace(v_bom.status, '_', ' ')) using errcode = 'P0001';
  end if;
  -- An older active version that starts on or after this one would block the
  -- approval as "overlapping": it is replaced by this newer version.
  for v_old in
    select * from public.boms
    where finished_product_id = v_bom.finished_product_id and status = 'APPROVED' and id <> v_bom.id
      and version < v_bom.version and effective_from >= v_bom.effective_from
  loop
    perform public.production_bom_action(v_old.id, 'ARCHIVE', 'Superseded by version ' || v_bom.version || '.');
    v_superseded := v_superseded || ('v' || v_old.version);
  end loop;
  v_result := public.production_bom_action(p_bom_id, 'APPROVE', p_note);
  return v_result || jsonb_build_object('superseded_versions', to_jsonb(v_superseded));
end;
$$;

revoke all on function public.production_bom_activate(uuid, text) from public, anon;
grant execute on function public.production_bom_activate(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. has_bom follows the active BOM versions
-- -----------------------------------------------------------------------------
create or replace function private.sync_product_has_bom()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  v_active := exists (select 1 from public.boms where finished_product_id = new.finished_product_id and status = 'APPROVED');
  update public.products set has_bom = v_active, is_manufacturable = is_manufacturable or v_active
  where id = new.finished_product_id and (has_bom is distinct from v_active or (v_active and not is_manufacturable));
  return null;
end;
$$;

revoke all on function private.sync_product_has_bom() from public, anon, authenticated;

drop trigger if exists boms_sync_product_has_bom on public.boms;
create trigger boms_sync_product_has_bom
  after insert or update of status on public.boms
  for each row execute function private.sync_product_has_bom();

-- -----------------------------------------------------------------------------
-- 7. Product KPIs (existing keys unchanged; new keys added)
--   incomplete = active product missing HSN, GST rate or category, or the price
--   that matters for its type (selling price for finished goods, otherwise a cost)
--   without_bom = active finished good / subassembly with no active BOM version
-- -----------------------------------------------------------------------------
create or replace function public.product_kpis()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'active',      count(*) filter (where status = 'ACTIVE'),
    'in_house',    count(*) filter (where status = 'ACTIVE' and default_source_type = 'IN_HOUSE'),
    'outsourced',  count(*) filter (where status = 'ACTIVE' and default_source_type = 'OUTSOURCED'),
    'hybrid',      count(*) filter (where status = 'ACTIVE' and default_source_type = 'HYBRID'),
    'inactive',    count(*) filter (where status = 'INACTIVE' and archived_at is null),
    'archived',    count(*) filter (where archived_at is not null),
    'total',       count(*),
    'finished_goods',        count(*) filter (where status = 'ACTIVE' and product_type = 'FINISHED_GOOD'),
    'raw_materials',         count(*) filter (where status = 'ACTIVE' and product_type = 'RAW_MATERIAL'),
    'components',            count(*) filter (where status = 'ACTIVE' and product_type = 'COMPONENT'),
    'subassemblies',         count(*) filter (where status = 'ACTIVE' and product_type = 'SUBASSEMBLY'),
    'outsourced_components', count(*) filter (where status = 'ACTIVE' and product_type = 'OUTSOURCED_COMPONENT'),
    'packaging',             count(*) filter (where status = 'ACTIVE' and product_type = 'PACKAGING_MATERIAL'),
    'consumables',           count(*) filter (where status = 'ACTIVE' and product_type = 'CONSUMABLE'),
    'without_bom', count(*) filter (where status = 'ACTIVE' and product_type in ('FINISHED_GOOD', 'SUBASSEMBLY')
                     and not exists (select 1 from public.boms b where b.finished_product_id = p.id and b.status = 'APPROVED')),
    'incomplete',  count(*) filter (where status = 'ACTIVE' and (hsn_code is null or gst_rate is null or category_id is null
                     or (product_type = 'FINISHED_GOOD' and selling_price is null)
                     or (product_type <> 'FINISHED_GOOD' and standard_cost is null and standard_manufacturing_cost is null)))
  )
  from public.products p
  where company_id = private.current_company_id();
$$;

revoke all on function public.product_kpis() from public, anon;
grant execute on function public.product_kpis() to authenticated;

-- -----------------------------------------------------------------------------
-- 8. BOM Excel imports are recorded in Bulk Operations like other imports
-- -----------------------------------------------------------------------------
alter table public.import_jobs drop constraint if exists import_jobs_import_type_check;
alter table public.import_jobs add constraint import_jobs_import_type_check
  check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO', 'SUPPLIER_PO', 'BOMS'));

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'CUSTOMER_PO' then 'customer_po.import' when 'SUPPLIER_PO' then 'purchase_order.create'
    when 'BOMS' then 'production_bom.create' end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;

create or replace function public.import_job_record(p_job jsonb, p_rows jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_type    text := p_job ->> 'import_type';
  v_job     public.import_jobs;
  v_retry   public.import_jobs;
begin
  if v_type not in ('PRODUCTS', 'OPENING_STOCK', 'BOMS') then
    raise exception 'Only product, BOM and opening-stock runs are recorded here (customer and supplier PO imports are recorded automatically).' using errcode = 'P0001';
  end if;
  if v_company is null or not private.has_permission(v_company, private.import_permission(v_type)) then
    raise exception 'You are not allowed to record this import (requires %).', private.import_permission(v_type) using errcode = '42501';
  end if;
  begin
    if (p_job ->> 'client_job_key') is null then
      raise exception using errcode = '22P02';
    end if;
    perform (p_job ->> 'client_job_key')::uuid;
  exception when others then
    raise exception 'A valid import id (client_job_key) is required.' using errcode = 'P0001';
  end;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then
    raise exception 'Row details must be a list of at most 5000 rows.' using errcode = 'P0001';
  end if;
  if (p_job ->> 'retry_of_job_id') is not null then
    select * into v_retry from public.import_jobs where id = (p_job ->> 'retry_of_job_id')::uuid and company_id = v_company;
    if not found or v_retry.import_type <> v_type then
      raise exception 'The import being retried was not found or is of another type.' using errcode = 'P0001';
    end if;
  end if;
  if v_type = 'OPENING_STOCK' and (p_job ->> 'source_id') is not null
     and not exists (select 1 from public.inventory_opening_batches b where b.id = (p_job ->> 'source_id')::uuid and b.company_id = v_company and b.source = 'IMPORT') then
    raise exception 'The opening-stock document was not found in your company.' using errcode = 'P0001';
  end if;
  begin
    v_job := private.import_job_write(v_company, auth.uid(), p_job, p_rows);
  exception
    when check_violation then raise exception 'The row counts do not add up to the total.' using errcode = 'P0001';
    when invalid_text_representation then raise exception 'Counts must be whole numbers.' using errcode = 'P0001';
  end;
  return jsonb_build_object('job_id', v_job.id, 'status', v_job.status);
end;
$$;

revoke all on function public.import_job_record(jsonb, jsonb) from public, anon;
grant execute on function public.import_job_record(jsonb, jsonb) to authenticated;
