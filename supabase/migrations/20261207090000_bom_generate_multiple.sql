-- =============================================================================
-- Generate Multiple BOMs: rows may be existing Product Master products
--
-- The Generate Multiple page now searches the Product Master for each row's product. A row is either
--   * an existing product (product_id): it gets a new DRAFT BOM through the existing public.production_save_bom
--     (next version when the product already has BOMs; validation, BOM code, audit unchanged), or
--   * a new product (product): created with its draft BOM through the existing public.bom_create_similar_products
--     (Product Master triggers, automatic SKU when blank, products.create required) - unchanged.
-- One call, one transaction: if any row fails nothing is saved. Nothing is activated, no stock moves, no cost or
-- existing product / BOM changes. A retry with the same key returns the first result.
--
-- No table, column, trigger or existing function changes. Rollback:
-- supabase/rollback/20261207090000_bom_generate_multiple_down.sql (drops this function).
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
        format('Generated from %s v%s (%s)', v_bom.bom_code, v_bom.version, v_from), null);
      perform private.write_audit_log(v_company, 'production.bom_generated', 'bom', v_saved ->> 'bom_id',
        jsonb_build_object('product_sku', v_product.sku, 'product_id', v_pid, 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int,
          'source_bom', v_bom.bom_code || ' v' || v_bom.version, 'source_bom_id', v_bom.id, 'components', (v_saved ->> 'components')::int));
      v_out := v_out || jsonb_build_array(jsonb_build_object('product_id', v_pid, 'sku', v_product.sku, 'product_name', v_product.product_name,
        'bom_id', v_saved ->> 'bom_id', 'bom_code', v_saved ->> 'bom_code', 'version', (v_saved ->> 'version')::int, 'status', 'DRAFT',
        'components', (v_saved ->> 'components')::int, 'existing_product', true));
    else
      -- A new product: the existing function (its own checks, products.create, automatic SKU).
      begin
        v_made := public.bom_create_similar_products(jsonb_build_object('bom_id', v_bom.id),
          jsonb_build_array(v_entry - 'product_id'), gen_random_uuid());
      exception when others then
        raise exception '%', regexp_replace(sqlerrm, '^Product 1\M', 'Product ' || v_i)
          using errcode = case when sqlstate = '42501' then '42501' else 'P0001' end;
      end;
      v_out := v_out || jsonb_build_array((v_made -> 'products' -> 0) || jsonb_build_object('existing_product', false));
    end if;
  end loop;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('created', jsonb_array_length(v_out), 'products', v_out,
    'source', jsonb_build_object('bom_id', v_bom.id, 'bom_code', v_bom.bom_code, 'version', v_bom.version)));
end;
$$;

revoke all on function public.bom_generate_multiple(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.bom_generate_multiple(jsonb, jsonb, uuid) to authenticated;
