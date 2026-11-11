-- =============================================================================
-- ALTON ERP V2: BOM templates and similar finished products
--
-- Reuses the existing BOM system (boms / bom_items, production_save_bom, versions, activation) and the
-- existing permissions (no new authorisation system):
--   production_bom.read    view templates, compare BOMs
--   production_bom.create  create templates, clone BOMs, create similar products (+ products.create)
--   production_bom.update  edit / archive any template (creators may edit their own)
--   production_bom.approve activate BOMs (existing workflow, unchanged)
--
-- * bom_templates / bom_template_items: reusable component lists (name, description, product category,
--   default quantities and wastage, status ACTIVE / ARCHIVED). Read: production_bom.read (RLS, per
--   company). Written only through the functions below; every change is audit logged.
-- * bom_create_similar_products: creates one or more new finished products and, for each, a new DRAFT
--   BOM through the existing production_save_bom (same validation, versioning and no stock movement),
--   all in one transaction. The source BOM / template is only read: it is never changed. Nothing is
--   activated; activation stays the existing, separately authorised step.
-- * erp_reset_tables lists the two new tables (the ERP reset classifies every company table).
--
-- Not changed: boms, bom_items, products (structure), production orders, stock, costs, GRNs.
-- Rollback: supabase/rollback/20261203090000_bom_templates_similar_products_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Templates
-- -----------------------------------------------------------------------------
create table if not exists public.bom_templates (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  template_name      text not null check (length(btrim(template_name)) between 2 and 120 and template_name = btrim(template_name)),
  description        text check (description is null or length(description) <= 2000),
  category_id        uuid,
  output_quantity    numeric(14,3) not null default 1 check (output_quantity > 0),
  output_unit        text not null check (output_unit ~ '^[A-Z]{1,10}$'),
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  -- Where the template was taken from (for reference only: a BOM is never blocked or changed by a template).
  source_bom_id      uuid,
  source_bom_code    text,
  source_bom_version integer,
  created_by         uuid,
  updated_by         uuid,
  archived_by        uuid,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint bom_templates_id_company_unique unique (id, company_id),
  constraint bom_templates_category_fk foreign key (category_id, company_id)
    references public.product_categories (id, company_id) on delete restrict,
  constraint bom_templates_archived check ((status = 'ARCHIVED') = (archived_at is not null))
);

create unique index if not exists bom_templates_company_name_unique on public.bom_templates (company_id, lower(template_name));
create index if not exists bom_templates_company_status_idx on public.bom_templates (company_id, status);

comment on table public.bom_templates is 'Reusable BOM component lists for creating new finished products. Written only through bom_template_save / bom_template_set_status.';

create table if not exists public.bom_template_items (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  template_id           uuid not null,
  line_no               integer not null check (line_no between 1 and 500),
  component_product_id  uuid not null,
  quantity_required     numeric(18,6) not null check (quantity_required > 0),
  unit                  text not null,
  wastage_percentage    numeric(5,2) not null default 0 check (wastage_percentage >= 0 and wastage_percentage < 100),
  notes                 text check (notes is null or length(notes) <= 500),
  source_type           text check (source_type is null or source_type in ('IN_HOUSE', 'OUTSOURCED', 'PURCHASED')),
  preferred_supplier_id uuid,
  created_at            timestamptz not null default now(),
  constraint bom_template_items_template_fk foreign key (template_id, company_id)
    references public.bom_templates (id, company_id) on delete cascade,
  constraint bom_template_items_component_fk foreign key (component_product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint bom_template_items_component_unique unique (template_id, component_product_id),
  constraint bom_template_items_line_unique unique (template_id, line_no)
);

create index if not exists bom_template_items_component_idx on public.bom_template_items (company_id, component_product_id);

comment on column public.bom_template_items.quantity_required is 'Default quantity of the component for bom_templates.output_quantity units of output, before wastage.';

drop trigger if exists bom_templates_set_updated_at on public.bom_templates;
create trigger bom_templates_set_updated_at before update on public.bom_templates
  for each row execute function private.set_updated_at();

alter table public.bom_templates enable row level security;
alter table public.bom_template_items enable row level security;
revoke all on table public.bom_templates, public.bom_template_items from anon, authenticated;
grant select on public.bom_templates, public.bom_template_items to authenticated;
grant all on table public.bom_templates, public.bom_template_items to service_role;

drop policy if exists bom_templates_select on public.bom_templates;
create policy bom_templates_select on public.bom_templates for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));
drop policy if exists bom_template_items_select on public.bom_template_items;
create policy bom_template_items_select on public.bom_template_items for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));

-- -----------------------------------------------------------------------------
-- 2. Save a template (create or edit). p_template: {template_name, description?, category_id?,
--    output_quantity?, output_unit, source_bom_id?}; p_items as for production_save_bom.
-- -----------------------------------------------------------------------------
create or replace function public.bom_template_save(p_template_id uuid, p_template jsonb, p_items jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_prev      jsonb;
  v_t         public.bom_templates;
  v_h         jsonb := coalesce(p_template, '{}'::jsonb);
  v_items     jsonb := coalesce(p_items, '[]'::jsonb);
  v_name      text := btrim(coalesce(v_h ->> 'template_name', ''));
  v_desc      text := nullif(btrim(coalesce(v_h ->> 'description', '')), '');
  v_category  uuid;
  v_output    numeric;
  v_unit      text := upper(btrim(coalesce(v_h ->> 'output_unit', '')));
  v_src       public.boms;
  v_item      jsonb;
  v_comp      public.products;
  v_line      int := 0;
  v_qty       numeric;
  v_wastage   numeric;
  v_source    text;
  v_supplier  uuid;
  v_seen      uuid[] := '{}';
  v_out       jsonb;
begin
  if p_template_id is null then
    if not private.has_permission(v_company, 'production_bom.create') then
      raise exception 'You are not allowed to create BOM templates (requires production_bom.create).' using errcode = '42501';
    end if;
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'bom_template_create');
    if v_prev is not null then return v_prev; end if;
  else
    select * into v_t from public.bom_templates where id = p_template_id and company_id = v_company for update;
    if not found then
      raise exception 'BOM template not found in your company.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or v_t.created_by = auth.uid()) then
      raise exception 'You can only edit your own BOM templates (requires production_bom.update).' using errcode = '42501';
    end if;
    if v_t.status = 'ARCHIVED' then
      raise exception 'Template "%" is archived. Reactivate it before editing.', v_t.template_name using errcode = 'P0001';
    end if;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter a template name (2 to 120 characters).' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.bom_templates where company_id = v_company and lower(template_name) = lower(v_name) and id is distinct from p_template_id) then
    raise exception 'A BOM template named "%" already exists.', v_name using errcode = 'P0001';
  end if;
  if v_desc is not null and length(v_desc) > 2000 then
    raise exception 'The description is limited to 2000 characters.' using errcode = 'P0001';
  end if;
  begin
    v_category := nullif(v_h ->> 'category_id', '')::uuid;
    v_output := coalesce(nullif(v_h ->> 'output_quantity', '')::numeric, 1);
  exception when others then
    raise exception 'The category or output quantity is not valid.' using errcode = 'P0001';
  end;
  if v_category is not null and not exists (select 1 from public.product_categories where id = v_category and company_id = v_company) then
    raise exception 'Product category not found in your company.' using errcode = 'P0001';
  end if;
  if v_output <= 0 or v_output <> round(v_output, 3) then
    raise exception 'Output quantity must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if v_unit !~ '^[A-Z]{1,10}$' then
    raise exception 'Enter the output unit of measurement.' using errcode = 'P0001';
  end if;
  if nullif(v_h ->> 'source_bom_id', '') is not null then
    select * into v_src from public.boms where id = (v_h ->> 'source_bom_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'Source BOM not found in your company.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Add at least one component to the template.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_items) > 500 then
    raise exception 'A template can have at most 500 components.' using errcode = 'P0001';
  end if;
  -- Same component rules as production_save_bom.
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_line := v_line + 1;
    begin
      v_qty := (v_item ->> 'quantity_required')::numeric;
      v_wastage := coalesce(nullif(v_item ->> 'wastage_percentage', '')::numeric, 0);
      v_supplier := nullif(v_item ->> 'preferred_supplier_id', '')::uuid;
      select * into v_comp from public.products where id = (v_item ->> 'component_product_id')::uuid and company_id = v_company;
    exception when others then
      raise exception 'Line %: component, quantity and wastage must be valid.', v_line using errcode = 'P0001';
    end;
    if v_comp.id is null then
      raise exception 'Line %: component not found in your company.', v_line using errcode = 'P0001';
    end if;
    if v_comp.status <> 'ACTIVE' or v_comp.archived_at is not null then
      raise exception 'Line %: component % is inactive.', v_line, v_comp.sku using errcode = 'P0001';
    end if;
    if v_comp.id = any(v_seen) then
      raise exception 'Line %: % is listed more than once. Combine the quantities on one line.', v_line, v_comp.sku using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_comp.id;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 6) then
      raise exception 'Line %: quantity must be greater than zero (up to 6 decimals).', v_line using errcode = 'P0001';
    end if;
    if v_wastage < 0 or v_wastage >= 100 or v_wastage <> round(v_wastage, 2) then
      raise exception 'Line %: wastage must be between 0 and 99.99 percent.', v_line using errcode = 'P0001';
    end if;
    if upper(btrim(coalesce(nullif(v_item ->> 'unit', ''), v_comp.base_unit))) <> v_comp.base_unit then
      raise exception 'Line %: enter the quantity of % in its inventory unit (%). No unit conversion is configured.', v_line, v_comp.sku, v_comp.base_unit
        using errcode = 'P0001';
    end if;
    v_source := upper(nullif(btrim(coalesce(v_item ->> 'source_type', '')), ''));
    if v_source is not null and v_source not in ('IN_HOUSE', 'OUTSOURCED', 'PURCHASED') then
      raise exception 'Line %: source must be In-house, Outsourced or Purchased.', v_line using errcode = 'P0001';
    end if;
    if v_supplier is not null and not exists (select 1 from public.suppliers where id = v_supplier and company_id = v_company) then
      raise exception 'Line %: preferred supplier not found in your company.', v_line using errcode = 'P0001';
    end if;
    v_comp := null;
  end loop;

  if p_template_id is null then
    insert into public.bom_templates (company_id, template_name, description, category_id, output_quantity, output_unit,
      source_bom_id, source_bom_code, source_bom_version, created_by, updated_by)
    values (v_company, v_name, v_desc, v_category, v_output, v_unit, v_src.id, v_src.bom_code, v_src.version, auth.uid(), auth.uid())
    returning * into v_t;
  else
    update public.bom_templates set template_name = v_name, description = v_desc, category_id = v_category, output_quantity = v_output,
      output_unit = v_unit, updated_by = auth.uid()
    where id = v_t.id returning * into v_t;
    delete from public.bom_template_items where template_id = v_t.id;
  end if;

  v_line := 0;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_line := v_line + 1;
    insert into public.bom_template_items (company_id, template_id, line_no, component_product_id, quantity_required, unit, wastage_percentage,
      notes, source_type, preferred_supplier_id)
    select v_company, v_t.id, v_line, p.id, (v_item ->> 'quantity_required')::numeric, p.base_unit,
      coalesce(nullif(v_item ->> 'wastage_percentage', '')::numeric, 0), left(nullif(btrim(coalesce(v_item ->> 'notes', '')), ''), 500),
      upper(nullif(btrim(coalesce(v_item ->> 'source_type', '')), '')), nullif(v_item ->> 'preferred_supplier_id', '')::uuid
    from public.products p where p.id = (v_item ->> 'component_product_id')::uuid;
  end loop;

  perform private.write_audit_log(v_company, case when p_template_id is null then 'production.bom_template_created' else 'production.bom_template_updated' end,
    'bom_template', v_t.id::text, jsonb_build_object('template_name', v_t.template_name, 'components', v_line,
      'source_bom', case when v_src.id is null then null else v_src.bom_code || ' v' || v_src.version end));
  v_out := jsonb_build_object('template_id', v_t.id, 'template_name', v_t.template_name, 'components', v_line);
  if p_template_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_out);
  end if;
  return v_out;
end;
$$;

create or replace function public.bom_template_set_status(p_template_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_t       public.bom_templates;
  v_status  text := upper(btrim(coalesce(p_status, '')));
begin
  if v_status not in ('ACTIVE', 'ARCHIVED') then
    raise exception 'Status must be ACTIVE or ARCHIVED.' using errcode = 'P0001';
  end if;
  select * into v_t from public.bom_templates where id = p_template_id and company_id = v_company for update;
  if not found then
    raise exception 'BOM template not found in your company.' using errcode = 'P0001';
  end if;
  if not (private.has_permission(v_company, 'production_bom.update') or v_t.created_by = auth.uid()) then
    raise exception 'You can only archive or reactivate your own BOM templates (requires production_bom.update).' using errcode = '42501';
  end if;
  if v_t.status = v_status then
    return jsonb_build_object('template_id', v_t.id, 'status', v_t.status, 'changed', false);
  end if;
  update public.bom_templates set status = v_status, updated_by = auth.uid(),
    archived_by = case when v_status = 'ARCHIVED' then auth.uid() end, archived_at = case when v_status = 'ARCHIVED' then now() end
  where id = v_t.id;
  perform private.write_audit_log(v_company, case when v_status = 'ARCHIVED' then 'production.bom_template_archived' else 'production.bom_template_reactivated' end,
    'bom_template', v_t.id::text, jsonb_build_object('template_name', v_t.template_name));
  return jsonb_build_object('template_id', v_t.id, 'status', v_status, 'changed', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Similar finished products: new products + a new DRAFT BOM each, in one transaction.
--    p_source:   {bom_id} or {template_id} (read only, for the record) or {}
--    p_products: [{product: {Product Master fields}, bom: {output_quantity, effective_from?, effective_to?,
--                  notes?, change_reason?, process_instructions?}, items: [as production_save_bom]}]
-- -----------------------------------------------------------------------------
create or replace function public.bom_create_similar_products(p_source jsonb, p_products jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_bom.create');
  v_prev     jsonb;
  v_src      jsonb := coalesce(p_source, '{}'::jsonb);
  v_bom      public.boms;
  v_tpl      public.bom_templates;
  v_from_sku text;
  v_lineage  text;
  v_entry    jsonb;
  v_p        jsonb;
  v_b        jsonb;
  v_i        int := 0;
  v_name     text;
  v_sku      text;
  v_skus     text[] := '{}';
  v_cols     text;
  v_pid      uuid;
  v_new_sku  text;
  v_saved    jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_today    date;
  -- Product Master fields a new product may be given (identity, status and audit columns are set by the database).
  v_allowed  text[] := array['sku', 'product_name', 'description', 'category_id', 'brand', 'model_number', 'barcode', 'ean', 'product_type',
    'default_source_type', 'base_unit', 'track_batches', 'track_expiry', 'inventory_tracked', 'hsn_code', 'gst_rate', 'selling_price',
    'standard_cost', 'minimum_selling_price', 'reorder_level', 'minimum_level', 'lead_time_days', 'reorder_level_days', 'mrp', 'length_cm',
    'width_cm', 'height_cm', 'supplier_model_number', 'supplier_product_name', 'preferred_supplier_id', 'remarks', 'is_manufacturable',
    'production_notes', 'group_head', 'minimum_cover_days', 'image_url'];
begin
  if not private.has_permission(v_company, 'products.create') then
    raise exception 'Creating a similar product adds it to the Product Master (requires products.create).' using errcode = '42501';
  end if;
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'bom_similar_products');
  if v_prev is not null then return v_prev; end if;
  v_today := private.company_today(v_company);

  if nullif(v_src ->> 'bom_id', '') is not null then
    select * into v_bom from public.boms where id = (v_src ->> 'bom_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'Source BOM not found in your company.' using errcode = 'P0001';
    end if;
    select sku into v_from_sku from public.products where id = v_bom.finished_product_id;
    v_lineage := format('Created from %s v%s (%s)', v_bom.bom_code, v_bom.version, v_from_sku);
  elsif nullif(v_src ->> 'template_id', '') is not null then
    select * into v_tpl from public.bom_templates where id = (v_src ->> 'template_id')::uuid and company_id = v_company;
    if not found then
      raise exception 'BOM template not found in your company.' using errcode = 'P0001';
    end if;
    if v_tpl.status <> 'ACTIVE' then
      raise exception 'Template "%" is archived. Reactivate it to create products from it.', v_tpl.template_name using errcode = 'P0001';
    end if;
    v_lineage := format('Created from BOM template "%s"', v_tpl.template_name);
  end if;

  if p_products is null or jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) = 0 then
    raise exception 'Add at least one new product.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_products) > 50 then
    raise exception 'At most 50 products can be created at once.' using errcode = 'P0001';
  end if;

  -- SKUs: unique within this request and in the company (blank = next automatic code).
  for v_entry in select value from jsonb_array_elements(p_products) loop
    v_i := v_i + 1;
    v_sku := nullif(btrim(coalesce(v_entry -> 'product' ->> 'sku', '')), '');
    if v_sku is null then continue; end if;
    if lower(v_sku) = any(v_skus) then
      raise exception 'Product %: SKU % is used for more than one new product.', v_i, v_sku using errcode = 'P0001';
    end if;
    v_skus := v_skus || lower(v_sku);
    if exists (select 1 from public.products where company_id = v_company and lower(sku) = lower(v_sku)) then
      raise exception 'Product %: SKU % already exists in the Product Master.', v_i, v_sku using errcode = 'P0001';
    end if;
  end loop;

  v_i := 0;
  for v_entry in select value from jsonb_array_elements(p_products) loop
    v_i := v_i + 1;
    v_p := coalesce(v_entry -> 'product', '{}'::jsonb);
    v_b := coalesce(v_entry -> 'bom', '{}'::jsonb);
    v_name := btrim(coalesce(v_p ->> 'product_name', ''));
    if v_name = '' then
      raise exception 'Product %: enter the finished product name.', v_i using errcode = 'P0001';
    end if;
    if jsonb_typeof(coalesce(v_entry -> 'items', 'null'::jsonb)) <> 'array' or jsonb_array_length(v_entry -> 'items') = 0 then
      raise exception 'Product % (%): add at least one component.', v_i, v_name using errcode = 'P0001';
    end if;
    -- Only allowed, non-null fields; columns missing from this database are skipped. Status is ACTIVE (default):
    -- the BOM needs an active output product. Nothing is copied implicitly from the source product.
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'products' and c.column_name = any(v_allowed)
      and v_p ? c.column_name and jsonb_typeof(v_p -> c.column_name) <> 'null';
    -- The Product Master's own triggers apply (SKU numbering setting, defaults, version 1, audit).
    begin
      execute format('insert into public.products (company_id, %s) select $1, %s from jsonb_populate_record(null::public.products, $2) returning id, sku',
        v_cols, v_cols)
        using v_company, v_p into v_pid, v_new_sku;
    exception
      when unique_violation then
        raise exception 'Product % (%): the SKU, barcode or EAN is already used by another product.', v_i, v_name using errcode = 'P0001';
      when others then
        raise exception 'Product % (%): %', v_i, v_name, sqlerrm using errcode = case when sqlstate = '42501' then '42501' else 'P0001' end;
    end;
    -- The BOM: the existing save (validation, BOM code, version 1, audit). It is a draft; never activated here.
    begin
      v_saved := public.production_save_bom(null, v_pid,
        coalesce(nullif(v_b ->> 'effective_from', '')::date, v_today), nullif(v_b ->> 'effective_to', '')::date,
        coalesce(nullif(v_b ->> 'output_quantity', '')::numeric, 1), nullif(btrim(coalesce(v_b ->> 'notes', '')), ''),
        v_entry -> 'items', gen_random_uuid());
    exception when others then
      raise exception 'Product % (%): %', v_i, v_name, sqlerrm using errcode = case when sqlstate = '42501' then '42501' else 'P0001' end;
    end;
    perform public.bom_version_details_save((v_saved ->> 'bom_id')::uuid,
      coalesce(nullif(btrim(coalesce(v_b ->> 'change_reason', '')), ''), v_lineage, 'New similar product'),
      nullif(btrim(coalesce(v_b ->> 'process_instructions', '')), ''));
    perform private.write_audit_log(v_company, 'production.similar_product_created', 'bom', v_saved ->> 'bom_id',
      jsonb_build_object('product_sku', v_new_sku, 'product_name', v_name, 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int,
        'source_bom', case when v_bom.id is null then null else v_bom.bom_code || ' v' || v_bom.version end, 'source_bom_id', v_bom.id,
        'source_template', v_tpl.template_name, 'source_template_id', v_tpl.id, 'components', (v_saved ->> 'components')::int));
    v_out := v_out || jsonb_build_array(jsonb_build_object('product_id', v_pid, 'sku', v_new_sku, 'product_name', v_name,
      'bom_id', v_saved ->> 'bom_id', 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int, 'status', 'DRAFT',
      'components', (v_saved ->> 'components')::int));
  end loop;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('created', jsonb_array_length(v_out), 'products', v_out,
    'source', case when v_bom.id is not null then jsonb_build_object('bom_id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version)
                   when v_tpl.id is not null then jsonb_build_object('template_id', v_tpl.id, 'template_name', v_tpl.template_name) end));
end;
$$;

revoke all on function public.bom_template_save(uuid, jsonb, jsonb, uuid) from public, anon;
revoke all on function public.bom_template_set_status(uuid, text) from public, anon;
revoke all on function public.bom_create_similar_products(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.bom_template_save(uuid, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.bom_template_set_status(uuid, text) to authenticated;
grant execute on function public.bom_create_similar_products(jsonb, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. ERP reset catalogue: same list as 20261123090000 plus the two template tables
--    (components before templates; neither is referenced by other tables).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

notify pgrst, 'reload schema';
