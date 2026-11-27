-- =============================================================================
-- Generate Multiple BOMs: components from an existing BOM per product (template provenance)
--
-- The Generate Multiple page can now fill a product's component list from any saved, non-archived BOM of the company
-- ("Add Components from Existing BOM"). The page reads that BOM through the existing views (row-level security applies) and
-- copies its component lines into the product's own editable list; they are saved exactly like typed components, as new
-- component rows of the new draft BOM (public.production_save_bom). Nothing references the template's component rows.
--
-- This migration only lets each entry of public.bom_generate_multiple carry an optional template_bom_id:
--   * checked to be a BOM of the caller's company (refused otherwise), read only - the template BOM and its components are
--     never updated, deleted or locked;
--   * recorded as provenance: appended to the new BOM's change reason ("…; components copied from BOM-000123 v2 (SKU)"),
--     in the audit log (production.bom_generated, and production.bom_components_copied) and in the result.
-- Entries without template_bom_id behave exactly as before. No table, column, trigger or other function changes; no data
-- is written by the migration. Redefined from 20261207090000 (its only definition).
--
-- Rollback: supabase/rollback/20261231091000_bom_generate_templates_down.sql (restores the function of 20261207090000 verbatim).
-- =============================================================================

create or replace function public.bom_generate_multiple(p_source jsonb, p_entries jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.create');
  v_prev    jsonb;
  v_src     jsonb := coalesce(p_source, '{}'::jsonb);
  v_bom     public.boms;
  v_from    text;
  v_entry   jsonb;
  v_b       jsonb;
  v_i       int := 0;
  v_pid     uuid;
  v_ids     uuid[] := '{}';
  v_product public.products;
  v_saved   jsonb;
  v_made    jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_today   date;
  -- Optional per-product template BOM (20261231091000): provenance only.
  v_tpl     public.boms;
  v_tpl_id  uuid;
  v_tpl_sku text;
  v_note    text;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'bom_generate_multiple');
  if v_prev is not null then return v_prev; end if;
  v_today := private.company_today(v_company);

  select * into v_bom from public.boms where id = nullif(v_src ->> 'bom_id', '')::uuid and company_id = v_company;
  if v_bom.id is null then
    raise exception 'Base BOM not found in your company.' using errcode = 'P0001';
  end if;
  select sku into v_from from public.products where id = v_bom.finished_product_id;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'Add at least one product.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_entries) > 50 then
    raise exception 'At most 50 products can be generated at once.' using errcode = 'P0001';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_i := v_i + 1;
    v_b := coalesce(v_entry -> 'bom', '{}'::jsonb);
    if jsonb_typeof(coalesce(v_entry -> 'items', 'null'::jsonb)) <> 'array' or jsonb_array_length(v_entry -> 'items') = 0 then
      raise exception 'Product %: add at least one component.', v_i using errcode = 'P0001';
    end if;
    -- Template BOM (20261231091000): the page copied its components into this entry's items, which are saved as new component
    -- rows like any others. The template is only read here (company-checked) and recorded as provenance; it is never changed.
    v_tpl := null;
    v_note := '';
    if nullif(v_entry ->> 'template_bom_id', '') is not null then
      begin
        v_tpl_id := (v_entry ->> 'template_bom_id')::uuid;
      exception when others then
        raise exception 'Product %: invalid template BOM.', v_i using errcode = 'P0001';
      end;
      select * into v_tpl from public.boms where id = v_tpl_id and company_id = v_company;
      if v_tpl.id is null then
        raise exception 'Product %: template BOM not found in your company.', v_i using errcode = 'P0001';
      end if;
      select sku into v_tpl_sku from public.products where id = v_tpl.finished_product_id;
      v_note := format('; components copied from %s v%s (%s)', v_tpl.bom_code, v_tpl.version, v_tpl_sku);
    end if;
    if nullif(v_entry ->> 'product_id', '') is not null then
      -- An existing Product Master product: a new draft BOM for it.
      begin
        v_pid := (v_entry ->> 'product_id')::uuid;
      exception when others then
        raise exception 'Product %: invalid product.', v_i using errcode = 'P0001';
      end;
      if v_pid = any (v_ids) then
        raise exception 'Product %: this product is already in the batch. Each product can be generated once.', v_i using errcode = 'P0001';
      end if;
      v_ids := v_ids || v_pid;
      select * into v_product from public.products where id = v_pid and company_id = v_company;
      if v_product.id is null then
        raise exception 'Product %: product not found in your company.', v_i using errcode = 'P0001';
      end if;
      begin
        v_saved := public.production_save_bom(null, v_pid,
          coalesce(nullif(v_b ->> 'effective_from', '')::date, v_today), nullif(v_b ->> 'effective_to', '')::date,
          coalesce(nullif(v_b ->> 'output_quantity', '')::numeric, 1), nullif(btrim(coalesce(v_b ->> 'notes', '')), ''),
          v_entry -> 'items', gen_random_uuid());
      exception when others then
        raise exception 'Product % (%): %', v_i, v_product.sku, sqlerrm using errcode = case when sqlstate = '42501' then '42501' else 'P0001' end;
      end;
      perform public.bom_version_details_save((v_saved ->> 'bom_id')::uuid,
        format('Generated from %s v%s (%s)', v_bom.bom_code, v_bom.version, v_from) || v_note, null);
      perform private.write_audit_log(v_company, 'production.bom_generated', 'bom', v_saved ->> 'bom_id',
        jsonb_build_object('product_sku', v_product.sku, 'product_id', v_pid, 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int,
          'source_bom', v_bom.bom_code || ' v' || v_bom.version, 'source_bom_id', v_bom.id, 'components', (v_saved ->> 'components')::int,
          'template_bom', case when v_tpl.id is null then null else v_tpl.bom_code || ' v' || v_tpl.version end, 'template_bom_id', v_tpl.id));
      v_out := v_out || jsonb_build_array(jsonb_build_object('product_id', v_pid, 'sku', v_product.sku, 'product_name', v_product.product_name,
        'bom_id', v_saved ->> 'bom_id', 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int, 'status', 'DRAFT',
        'components', (v_saved ->> 'components')::int, 'existing_product', true, 'template_bom_id', v_tpl.id));
    else
      -- A new product: the existing function (its own checks, products.create, automatic SKU).
      begin
        -- With a template, its provenance goes into the new BOM's change reason (the function's own lineage text otherwise).
        v_made := public.bom_create_similar_products(jsonb_build_object('bom_id', v_bom.id),
          jsonb_build_array(case when v_tpl.id is null then v_entry - 'product_id' - 'template_bom_id'
            else (v_entry - 'product_id' - 'template_bom_id') || jsonb_build_object('bom', coalesce(v_entry -> 'bom', '{}'::jsonb)
              || jsonb_build_object('change_reason', format('Created from %s v%s (%s)', v_bom.bom_code, v_bom.version, v_from) || v_note)) end),
          gen_random_uuid());
      exception when others then
        raise exception '%', regexp_replace(sqlerrm, '^Product 1\M', 'Product ' || v_i)
          using errcode = case when sqlstate = '42501' then '42501' else 'P0001' end;
      end;
      v_out := v_out || jsonb_build_array((v_made -> 'products' -> 0) || jsonb_build_object('existing_product', false, 'template_bom_id', v_tpl.id));
    end if;
    if v_tpl.id is not null then
      perform private.write_audit_log(v_company, 'production.bom_components_copied', 'bom', v_out -> -1 ->> 'bom_id',
        jsonb_build_object('template_bom_id', v_tpl.id, 'template_bom', v_tpl.bom_code || ' v' || v_tpl.version, 'source_bom_id', v_bom.id,
          'product_sku', v_out -> -1 ->> 'sku', 'components', jsonb_array_length(v_entry -> 'items')));
    end if;
  end loop;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('created', jsonb_array_length(v_out), 'products', v_out,
    'source', jsonb_build_object('bom_id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version)));
end;
$$;
revoke all on function public.bom_generate_multiple(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.bom_generate_multiple(jsonb, jsonb, uuid) to authenticated;
