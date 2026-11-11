-- =============================================================================
-- Rollback of 20261204090000_opening_stock_optional_cost.sql
--
-- Restores private.opening_price_lines and private.opening_cost_audit exactly as in
-- 20261129090000_opening_stock_master_cost.sql (a product without a valid Product Master Cost is
-- rejected again) and public.inventory_stock_value_summary as in 20261125090000.
-- Opening stock already posted without a cost is kept as it is (not valued); nothing is rewritten.
-- =============================================================================

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

revoke all on function private.opening_price_lines(uuid, jsonb) from public, anon, authenticated;

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

create or replace function public.inventory_stock_value_summary(p_unit text default null, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
  v_like    text;
  v         jsonb;
begin
  if v_term is not null then
    -- Same escaping as the app: \ % _ are literal; , ( ) become spaces.
    v_like := '%' || translate(replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_'), ',()', '   ') || '%';
  end if;
  with rows as (
    select s.* from public.inventory_product_stock_value s
    where s.company_id = v_company and s.archived_at is null and s.on_hand <> 0
      and (p_unit is null or s.base_unit = p_unit)
      and (v_like is null or s.sku ilike v_like or s.product_name ilike v_like or s.barcode ilike v_like)
  )
  select jsonb_build_object(
    'products', count(*),
    'units', coalesce((select jsonb_agg(jsonb_build_object('unit', base_unit, 'on_hand', oh, 'reserved', rs, 'available', av) order by base_unit)
       from (select base_unit, sum(on_hand) oh, sum(reserved) rs, sum(available) av from rows group by base_unit) u), '[]'::jsonb),
    'total_value', coalesce(sum(stock_value), 0),
    'valued_products', count(*) filter (where valuation_status = 'VALUED'),
    'partly_valued_products', count(*) filter (where valuation_status = 'PARTIAL'),
    'not_valued_products', count(*) filter (where valuation_status = 'NOT_VALUED'),
    'method', 'Weighted-average cost of each lot (the stock report valuation) x quantity on hand. Lots without a cost are not valued.'
  ) into v
  from rows;
  return v;
end;
$$;

revoke all on function public.inventory_stock_value_summary(text, text) from public, anon;
grant execute on function public.inventory_stock_value_summary(text, text) to authenticated;
