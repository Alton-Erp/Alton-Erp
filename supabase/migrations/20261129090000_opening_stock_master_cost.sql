-- =============================================================================
-- Opening stock: unit cost = Product Master Cost, fetched on the server
--
-- Manual opening stock and the Excel import now take each line's unit cost from the
-- Product Master Cost: public.product_master_list (20261128090000), the same value the
-- Product Master list shows (second-most-recent valid posted GRN, else the Standard
-- Manufacturing Cost products.standard_cost). No other cost is calculated here; Last
-- Purchase Cost, PO prices and any cost sent by the browser or an Excel file are ignored.
--
--   * public.opening_stock_product_costs(ids)     the costs for the entry screen / import
--     preview, and whether an override is allowed.
--   * public.inventory_submit_opening_stock_at_cost / inventory_post_opening_stock_at_cost
--     price every line again at submission (server-side), reject lines whose product
--     has no cost (missing or zero: never posted at zero), then call the existing
--     inventory_submit_opening_stock / inventory_post_opening_stock unchanged, so their
--     validation, duplicate protection (product + location + batch, request id), stock
--     ledger, lot valuation and audit stay exactly as they are.
--   * Override: ERP setting inventory.opening_cost_override (default off). When it is on,
--     a user with settings.manage may send "cost_override": true with a unit cost on a
--     line; every override is listed in the audit entry.
--
-- The two settings functions are copied from 20261123090000 with one key added.
-- No table, trigger or posted data changes. The existing functions keep working.
-- Rollback: supabase/rollback/20261129090000_opening_stock_master_cost_down.sql
-- =============================================================================

-- 1. The override setting (off by default)
create or replace function private.erp_setting_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'general.date_format', 'DD MMM YYYY',
    'numbering.po_prefix', 'PO',
    'numbering.grn_prefix', 'GRN',
    'numbering.production_prefix', 'PRD',
    'numbering.sales_order_prefix', 'SO',
    'product.auto_sku', true,
    'product.sku_prefixes', jsonb_build_object('FINISHED_GOOD', 'FG', 'RAW_MATERIAL', 'RM', 'COMPONENT', 'CMP', 'SUBASSEMBLY', 'SUB',
      'OUTSOURCED_COMPONENT', 'OSC', 'PACKAGING_MATERIAL', 'PKG', 'CONSUMABLE', 'CON', 'OTHER', 'ITM'),
    'product.units', jsonb_build_array('PCS', 'NOS', 'SET', 'PAIR', 'BOX', 'KG', 'G', 'LTR', 'ML', 'MTR', 'SQM'),
    'product.default_gst_rate', 18,
    'product.hsn_codes', '[]'::jsonb,
    'product.group_heads', '[]'::jsonb,
    'product.import_match_key', 'SKU',
    'product.purchase_cost_auto_update', true,
    'product.purchase_cost_increase_alerts', true,
    'product.purchase_cost_decrease_alerts', true,
    'product.purchase_cost_alert_percent', 10,
    'product.purchase_cost_zero_policy', 'IGNORE',
    'product.purchase_cost_override_permission', 'purchase_exception.approve',
    'inventory.opening_cost_override', false,
    'inventory.adjustment_reasons', jsonb_build_array('Damaged', 'Count correction', 'Expired', 'Sample issued', 'Found in stock', 'Other'),
    'purchase.default_payment_terms', 'DAYS_30',
    'purchase.default_delivery_terms', null,
    'production.default_wastage_percent', 0,
    'production.consumption_prefill', 'STANDARD',
    'sales.default_payment_terms', null,
    'sales.default_delivery_instructions', null,
    'sales.default_warehouse_id', null,
    'import.date_order', 'DMY');
$$;

create or replace function private.company_settings_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_t text := jsonb_typeof(new.setting_value);
begin
  if new.setting_key = 'product.group_heads' and not (
       jsonb_typeof(new.setting_value) = 'array' and jsonb_array_length(new.setting_value) <= 200
       and not exists (select 1 from jsonb_array_elements(new.setting_value) e
                       where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 100)
       and (select count(*) from jsonb_array_elements_text(new.setting_value) e)
           = (select count(distinct lower(btrim(e))) from jsonb_array_elements_text(new.setting_value) e)) then
    raise exception 'Group heads: up to 200 different names of 1 to 100 characters.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.import_match_key' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('SKU', 'BARCODE', 'EAN', 'MODEL_NUMBER', 'PRODUCT_NAME', 'NONE')) then
    raise exception 'Import match key: SKU, Barcode, EAN, Model Number, Product Name or None.' using errcode = 'P0001';
  end if;
  if new.setting_key in ('product.purchase_cost_auto_update', 'product.purchase_cost_increase_alerts', 'product.purchase_cost_decrease_alerts')
     and v_t <> 'boolean' then
    raise exception 'This purchase cost option is on or off.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_alert_percent' and not (
       v_t = 'number' and (new.setting_value #>> '{}')::numeric between 0 and 1000
       and (new.setting_value #>> '{}')::numeric = round((new.setting_value #>> '{}')::numeric, 2)) then
    raise exception 'The significant change threshold is a percentage from 0 to 1000 (up to 2 decimals).' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_zero_policy' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('IGNORE', 'APPLY', 'INITIAL_ONLY')) then
    raise exception 'Zero-cost receipts: ignore, apply, or apply only when the product has no cost yet.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'product.purchase_cost_override_permission' and not (
       v_t = 'string' and (new.setting_value #>> '{}') in ('purchase_exception.approve', 'purchase_order.approve', 'products.update', 'settings.manage')) then
    raise exception 'Cost overrides: purchase exception approvers, purchase order approvers, product editors or settings managers.' using errcode = 'P0001';
  end if;
  if new.setting_key = 'inventory.opening_cost_override' and v_t <> 'boolean' then
    raise exception 'Opening stock cost override is on or off.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- 2. Costs and submission

-- Product Master Cost of the given products (the view's master_cost), company of the caller.
create or replace function private.opening_master_costs(p_company uuid, p_ids uuid[])
returns table (product_id uuid, sku text, product_name text, cost numeric, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.sku, v.product_name, v.master_cost, v.master_cost_source
  from public.product_master_list v
  where v.company_id = p_company and v.id = any (coalesce(p_ids, '{}'));
$$;

-- An override is allowed only when the company switched it on and the user may manage settings.
create or replace function private.opening_cost_override_allowed(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((private.erp_setting(p_company, 'inventory.opening_cost_override') #>> '{}')::boolean, false)
     and private.has_permission(p_company, 'settings.manage');
$$;

-- Sets every line's unit cost from the Product Master Cost (or a permitted override).
-- Returns { lines, errors, overrides }; a line whose product has no usable cost is an error.
create or replace function private.opening_price_lines(p_company uuid, p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_allowed   boolean := private.opening_cost_override_allowed(p_company);
  v_out       jsonb := '[]'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
  v_overrides jsonb := '[]'::jsonb;
  v_line      jsonb;
  v_no        int;
  v_pid       uuid;
  v_master    record;
  v_cost      numeric;
  v_override  boolean;
  v_given     numeric;
begin
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Provide the opening stock lines as a list.' using errcode = 'P0001';
  end if;
  for v_line, v_no in select value, coalesce((value ->> 'line_no')::int, ordinality::int) from jsonb_array_elements(p_lines) with ordinality loop
    v_pid := null;
    begin
      v_pid := (v_line ->> 'product_id')::uuid;
    exception when others then
      v_pid := null;
    end;
    select * into v_master from private.opening_master_costs(p_company, array[v_pid]);
    v_override := coalesce((v_line ->> 'cost_override')::boolean, false);
    v_given := null;
    if v_override then
      begin
        v_given := nullif(v_line ->> 'unit_cost', '')::numeric;
      exception when others then
        v_given := null;
      end;
    end if;
    if v_master.product_id is null then
      -- Unknown product: the existing validation reports it ("Product not found in your company").
      v_out := v_out || jsonb_build_array((v_line - 'cost_override') || jsonb_build_object('unit_cost', null));
    elsif v_override and not v_allowed then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message',
        v_master.sku || ': the unit cost cannot be changed here. It is the Product Master Cost; an override must be enabled in ERP Settings for a settings manager.');
    elsif v_override and (v_given is null or v_given <= 0 or v_given <> round(v_given, 4)) then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message', v_master.sku || ': enter an override cost greater than zero (up to 4 decimals).');
    elsif v_override then
      v_out := v_out || jsonb_build_array((v_line - 'cost_override') || jsonb_build_object('unit_cost', v_given));
      v_overrides := v_overrides || jsonb_build_object('line_no', v_no, 'sku', v_master.sku, 'product_master_cost', v_master.cost, 'unit_cost', v_given);
    else
      v_cost := round(v_master.cost, 4);
      if v_cost is null or v_cost <= 0 then
        v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message',
          v_master.sku || ': the Product Master Cost is ' || case when v_cost is null then 'missing' else 'zero' end
          || '. Set the Standard Manufacturing Cost on the Product Master, then try again (opening stock is never posted at zero cost).');
      else
        v_out := v_out || jsonb_build_array((v_line - 'cost_override') || jsonb_build_object('unit_cost', v_cost));
      end if;
    end if;
  end loop;
  return jsonb_build_object('lines', v_out, 'errors', v_errors, 'overrides', v_overrides);
end;
$$;

revoke all on function private.opening_master_costs(uuid, uuid[]), private.opening_cost_override_allowed(uuid),
  private.opening_price_lines(uuid, jsonb) from public, anon, authenticated;

-- Costs for the entry screen and the import preview (read only).
create or replace function public.opening_stock_product_costs(p_product_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['inventory_opening.create', 'inventory_opening.approve']);
begin
  if coalesce(cardinality(p_product_ids), 0) > 5000 then
    raise exception 'Ask for at most 5000 products at a time.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'override_allowed', private.opening_cost_override_allowed(v_company),
    'costs', coalesce((select jsonb_agg(jsonb_build_object('product_id', c.product_id, 'sku', c.sku, 'product_name', c.product_name,
        'cost', round(c.cost, 4), 'source', c.source, 'valid', coalesce(c.cost > 0, false)) order by c.sku)
      from private.opening_master_costs(v_company, p_product_ids) c), '[]'::jsonb));
end;
$$;

-- Submit (for approval) with the costs set on the server.
create or replace function public.inventory_submit_opening_stock_at_cost(
  p_lines jsonb, p_source text default 'MANUAL', p_file_name text default null, p_notes text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_opening.create');
  v_priced  jsonb;
  v_result  jsonb;
begin
  v_priced := private.opening_price_lines(v_company, p_lines);
  if jsonb_array_length(v_priced -> 'errors') > 0 then
    return jsonb_build_object('ok', false, 'errors', v_priced -> 'errors', 'valid_lines', jsonb_array_length(v_priced -> 'lines'));
  end if;
  v_result := public.inventory_submit_opening_stock(v_priced -> 'lines', p_source, p_file_name, p_notes, p_idempotency_key);
  perform private.opening_cost_audit(v_company, v_result, v_priced);
  return v_result;
end;
$$;

-- Submit and post in one step (single operator) with the costs set on the server.
create or replace function public.inventory_post_opening_stock_at_cost(
  p_lines jsonb, p_source text default 'MANUAL', p_file_name text default null, p_notes text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_opening.create');
  v_priced  jsonb;
  v_result  jsonb;
begin
  v_priced := private.opening_price_lines(v_company, p_lines);
  if jsonb_array_length(v_priced -> 'errors') > 0 then
    return jsonb_build_object('ok', false, 'errors', v_priced -> 'errors', 'valid_lines', jsonb_array_length(v_priced -> 'lines'));
  end if;
  v_result := public.inventory_post_opening_stock(v_priced -> 'lines', p_source, p_file_name, p_notes, p_idempotency_key);
  perform private.opening_cost_audit(v_company, v_result, v_priced);
  return v_result;
end;
$$;

-- Audit: where the costs came from, and every override (only for a new document, not a replayed request).
create or replace function private.opening_cost_audit(p_company uuid, p_result jsonb, p_priced jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((p_result ->> 'ok')::boolean, false) and not coalesce((p_result ->> 'duplicate')::boolean, false) then
    perform private.write_audit_log(p_company, 'inventory.opening_cost_from_product_master', 'inventory_opening_batch', p_result ->> 'opening_batch_id',
      jsonb_build_object('document_number', p_result ->> 'document_number', 'lines', jsonb_array_length(p_priced -> 'lines'),
        'cost_source', 'product_master_list.master_cost', 'overrides', p_priced -> 'overrides'));
  end if;
end;
$$;
revoke all on function private.opening_cost_audit(uuid, jsonb, jsonb) from public, anon, authenticated;

revoke all on function public.opening_stock_product_costs(uuid[]), public.inventory_submit_opening_stock_at_cost(jsonb, text, text, text, uuid),
  public.inventory_post_opening_stock_at_cost(jsonb, text, text, text, uuid) from public, anon;
grant execute on function public.opening_stock_product_costs(uuid[]), public.inventory_submit_opening_stock_at_cost(jsonb, text, text, text, uuid),
  public.inventory_post_opening_stock_at_cost(jsonb, text, text, text, uuid) to authenticated;
