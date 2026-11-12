-- =============================================================================
-- Opening stock Excel import: existing records are matched and quantities added
--
-- Before: a row whose product + location + batch already had an opening stock record was rejected
-- ("Opening stock for this product, location and batch already exists (OS-000003)").
-- Now the import (only the import; manual entry is unchanged) matches such rows to the POSTED opening
-- record and ADDS the imported quantity:
--
--   * the opening record itself is never changed (one record per product + location + batch + source stays,
--     the unique index inventory_opening_lines_no_duplicate is untouched);
--   * the added quantity is posted through the existing private.post_movement into the same stock lot and
--     location, as transaction type OPENING_STOCK with reference_type OPENING_ADDITION and reference_id = the
--     opening record: a separate, auditable ledger entry. Existing quantity = the opening record's quantity +
--     earlier additions. Balances only change through the ledger;
--   * cost of the added quantity: the lot's current cost (private.lot_average_cost), so stock already posted
--     keeps its valuation. With "Unit Cost" selected, an Excel cost equal to the lot's cost is accepted; a
--     different cost is refused (it would re-average that lot: use a new batch for a separate cost); a cost for
--     a lot without one needs the existing authorised opening cost override. Blank or missing costs never
--     change anything and are never turned into zero;
--   * new records go through the existing inventory_post_opening_stock_at_cost / _submit_ (optional Product
--     Master Cost, approval workflow, validation) unchanged;
--   * additions post at once, so they need the existing posting permission (inventory_opening.approve with
--     segregation of duties off); a record awaiting approval is not added to;
--   * one transaction for the whole import; a retried request returns the first result (no second addition);
--     every addition is audit logged (previous, added and new quantity, cost and its source, file, row).
--
-- No table, column, trigger, index or posted record changes. Rollback: drop the two functions
-- (supabase/rollback/20261206090000_opening_import_additive_down.sql).
-- =============================================================================

-- Opening records of these products (pending or posted) with what the import needs to match and preview them.
create or replace function public.opening_stock_import_matches(p_product_ids uuid[])
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'opening_line_id', l.id, 'document_number', b.document_number, 'status', l.status, 'product_id', l.product_id,
      'location_id', l.location_id, 'batch_number', l.batch_number, 'source_type', l.source_type,
      'quantity', l.quantity, 'added_quantity', a.added, 'unit_cost', l.unit_cost,
      'lot_id', t.batch_id, 'lot_cost', round(private.lot_average_cost(t.batch_id), 4),
      'on_hand', coalesce((select bal.on_hand from public.inventory_balances bal where bal.batch_id = t.batch_id and bal.location_id = l.location_id), 0))
      order by b.document_number, l.line_no)
    from public.inventory_opening_lines l
    join public.inventory_opening_batches b on b.id = l.opening_batch_id
    left join public.inventory_transactions t on t.id = l.posted_transaction_id
    cross join lateral (select private.opening_added_quantity(l.id) as added) a
    where l.company_id = v_company and l.product_id = any (coalesce(p_product_ids, '{}')) and l.status in ('PENDING_APPROVAL', 'POSTED')), '[]'::jsonb);
end;
$$;

-- Quantity already added to an opening record by imports (not reversed).
create or replace function private.opening_added_quantity(p_opening_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(t.quantity), 0)
  from public.inventory_transactions t
  where t.reference_type = 'OPENING_ADDITION' and t.reference_id = p_opening_line and t.transaction_type = 'OPENING_STOCK'
    and not exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = t.id);
$$;

-- Why an Excel cost cannot be given to quantity added to a lot (null when it can).
create or replace function private.opening_addition_cost_error(p_company uuid, p_excel numeric, p_lot_cost numeric, p_doc text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_excel is null then null
    when p_lot_cost is not null and round(p_excel, 4) <> p_lot_cost then
      'Unit cost ' || trim_scale(p_excel)::text || ' differs from the cost of the existing stock in ' || p_doc || ' (' || trim_scale(p_lot_cost)::text
      || '). Adding it would re-value that stock: keep the existing cost, or import it under a new batch number to keep a separate cost.'
    when p_lot_cost is null and not private.opening_cost_override_allowed(p_company) then
      'The existing stock in ' || p_doc || ' has no cost; giving the added quantity a cost needs the opening stock cost override (ERP Settings, settings manager). Leave the cost blank to keep it pending.'
  end;
$$;

-- The import. p_lines: the opening stock lines of the file (as for inventory_post_opening_stock_at_cost), each
-- may carry unit_cost (used only for matched records when "unit_cost" is selected) and notes.
-- p_fields: {"quantity": true, "unit_cost": false, "remarks": false} — what to change for matched records.
-- p_post: post at once (single operator) or submit new records for approval.
create or replace function public.inventory_import_opening_stock(
  p_lines jsonb, p_fields jsonb, p_post boolean, p_file_name text default null, p_notes text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('inventory_opening.create');
  v_prev      jsonb;
  v_fields    jsonb := coalesce(p_fields, '{}'::jsonb);
  v_add       boolean := coalesce((v_fields ->> 'quantity')::boolean, true);
  v_use_cost  boolean := coalesce((v_fields ->> 'unit_cost')::boolean, false);
  v_use_notes boolean := coalesce((v_fields ->> 'remarks')::boolean, false);
  v_can_post  boolean;
  v_today     date;
  v_line      jsonb;
  v_no        int;
  v_pid       uuid;
  v_lid       uuid;
  v_batch     text;
  v_key       text;
  v_seen      text[] := '{}';
  v_new       jsonb := '[]'::jsonb;
  v_adds      jsonb := '[]'::jsonb;
  v_kept      jsonb := '[]'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
  v_result    jsonb;
  v_added     jsonb := '[]'::jsonb;
  v_match     record;
  v_n         int;
  v_a         jsonb;
  v_ol        public.inventory_opening_lines;
  v_doc       text;
  v_product   public.products;
  v_qty       numeric;
  v_cost      numeric;
  v_excel     numeric;
  v_lot       uuid;
  v_lot_cost  numeric;
  v_prev_qty  numeric;
  v_eff       date;
  v_notes     text;
  v_source    text;
  v_tx        uuid;
  v_tx_no     text;
  v_msg       text;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'opening_import');
  if v_prev is not null then return v_prev; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Provide at least one opening stock line.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'At most 5000 lines can be imported at once.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);
  v_can_post := coalesce(p_post, false) and private.has_permission(v_company, 'inventory_opening.approve')
    and not coalesce((private.inventory_policy(v_company) ->> 'segregation_of_duties')::boolean, false);

  -- 1. Each row is a new record, an addition to an existing (posted) record, or an error.
  for v_line, v_no in select value, coalesce((value ->> 'line_no')::int, ordinality::int) from jsonb_array_elements(p_lines) with ordinality loop
    begin
      v_pid := (v_line ->> 'product_id')::uuid;
      v_lid := (v_line ->> 'location_id')::uuid;
    exception when others then
      v_pid := null; v_lid := null;
    end;
    v_batch := nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '');
    v_key := coalesce(v_pid::text, '') || '|' || coalesce(v_lid::text, '') || '|' || coalesce(lower(v_batch), '');
    select count(*) as n, min(l.id::text) as id, min(l.status) as status, min(b.document_number) as doc into v_match
    from public.inventory_opening_lines l join public.inventory_opening_batches b on b.id = l.opening_batch_id
    where l.company_id = v_company and l.product_id = v_pid and l.location_id = v_lid
      and coalesce(lower(l.batch_number), '') = coalesce(lower(v_batch), '') and l.status in ('PENDING_APPROVAL', 'POSTED');
    if v_match.n > 1 then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message', 'This product, location and batch has more than one opening stock record (different sources); add to it by manual stock adjustment instead.');
    elsif v_match.n = 1 and v_match.status = 'PENDING_APPROVAL' then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message',
        'Opening stock for this product, location and batch is awaiting approval (' || v_match.doc || '). Approve or reject it before adding to it.');
    elsif v_match.n = 1 then
      if v_add then
        v_adds := v_adds || jsonb_build_array(jsonb_build_object('line', v_line, 'line_no', v_no, 'opening_line_id', v_match.id));
      else
        v_kept := v_kept || jsonb_build_object('line_no', v_no, 'document_number', v_match.doc);
      end if;
    elsif v_key = any (v_seen) then
      -- The same new record again in the file: added to it once it is posted by this import.
      if v_add then
        v_adds := v_adds || jsonb_build_array(jsonb_build_object('line', v_line, 'line_no', v_no, 'opening_line_id', null, 'key', v_key));
      else
        v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message', 'This product, location and batch appears more than once in the file; select "Quantity" to add the rows together.');
      end if;
    else
      v_seen := v_seen || v_key;
      v_new := v_new || jsonb_build_array(v_line);
    end if;
  end loop;

  -- 2. Additions post at once: the posting permission is needed.
  if jsonb_array_length(v_adds) > 0 and not v_can_post then
    for v_a in select value from jsonb_array_elements(v_adds) loop
      v_errors := v_errors || jsonb_build_object('line_no', (v_a ->> 'line_no')::int, 'message', case when coalesce(p_post, false)
        then 'Adding to existing opening stock posts at once and needs permission to post opening stock (inventory_opening.approve, with segregation of duties off).'
        else 'Adding to existing opening stock posts at once; it cannot be staged for approval. Ask a user who may post opening stock to import it.' end);
    end loop;
  end if;

  -- 3. Checks of the additions that do not depend on this import's own postings.
  for v_a in select value from jsonb_array_elements(v_adds) loop
    v_line := v_a -> 'line';
    v_no := (v_a ->> 'line_no')::int;
    v_msg := null;
    begin
      v_qty := (v_line ->> 'quantity')::numeric;
      v_eff := coalesce(nullif(v_line ->> 'effective_date', '')::date, v_today);
      v_excel := case when v_use_cost then nullif(btrim(coalesce(v_line ->> 'unit_cost', '')), '')::numeric end;
      select * into v_product from public.products where id = (v_line ->> 'product_id')::uuid and company_id = v_company;
    exception when others then
      v_msg := 'Invalid value: ' || sqlerrm;
    end;
    if v_msg is null then
      if v_product.id is null then v_msg := 'Product not found in your company.';
      elsif v_product.status <> 'ACTIVE' or v_product.archived_at is not null then v_msg := 'Product ' || v_product.sku || ' is inactive.';
      elsif not exists (select 1 from public.inventory_locations il join public.warehouses w on w.id = il.warehouse_id
                        where il.id = (v_line ->> 'location_id')::uuid and il.company_id = v_company and il.status = 'ACTIVE' and w.status = 'ACTIVE') then
        v_msg := 'Location not found or inactive.';
      elsif v_qty is null or v_qty <= 0 then v_msg := 'Quantity must be greater than zero.';
      elsif v_qty <> round(v_qty, 3) or v_qty >= 1e10 then v_msg := 'Quantity has too many decimals or is too large.';
      elsif coalesce(v_line ->> 'unit', '') <> '' and upper(v_line ->> 'unit') <> v_product.base_unit then
        v_msg := 'Unit ' || (v_line ->> 'unit') || ' does not match the product unit ' || v_product.base_unit || '.';
      elsif v_eff > v_today then v_msg := 'Effective date cannot be in the future.';
      elsif v_eff < date '2000-01-01' then v_msg := 'Effective date is too far in the past.';
      elsif v_excel is not null and (v_excel <= 0 or v_excel <> round(v_excel, 4)) then v_msg := 'Unit cost must be greater than zero (up to 4 decimals), or left blank to keep the existing cost.';
      end if;
    end if;
    -- Cost against the existing stock (records posted before this import; a record created by this import is
    -- checked when it is added to, below).
    if v_msg is null and v_excel is not null and v_a ->> 'opening_line_id' is not null then
      select b.document_number, round(private.lot_average_cost(t.batch_id), 4) into v_doc, v_lot_cost
      from public.inventory_opening_lines l join public.inventory_opening_batches b on b.id = l.opening_batch_id
      join public.inventory_transactions t on t.id = l.posted_transaction_id
      where l.id = (v_a ->> 'opening_line_id')::uuid;
      v_msg := private.opening_addition_cost_error(v_company, v_excel, v_lot_cost, v_doc);
    end if;
    if v_msg is not null then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message', v_msg);
    end if;
  end loop;

  -- 4. New records: the existing opening stock functions (validation, optional Product Master Cost, approval).
  --    Run inside a block that is undone when anything in this import is invalid, so nothing is half done.
  if jsonb_array_length(v_new) > 0 then
    begin
      v_result := case when coalesce(p_post, false)
        then public.inventory_post_opening_stock_at_cost(v_new, 'IMPORT', p_file_name, p_notes, gen_random_uuid())
        else public.inventory_submit_opening_stock_at_cost(v_new, 'IMPORT', p_file_name, p_notes, gen_random_uuid()) end;
      if not coalesce((v_result ->> 'ok')::boolean, false) or jsonb_array_length(v_errors) > 0 then
        raise exception 'undo' using errcode = 'P0099';
      end if;
    exception when sqlstate 'P0099' then
      null;
    end;
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      v_errors := v_errors || coalesce(v_result -> 'errors', '[]'::jsonb);
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('ok', false,
      'errors', (select jsonb_agg(e order by (e ->> 'line_no')::int) from jsonb_array_elements(v_errors) e),
      'new_lines', jsonb_array_length(v_new), 'added_lines', jsonb_array_length(v_adds)));
  end if;

  -- 5. Additions, through the stock ledger (one movement each, into the record's lot and location).
  for v_a in select value from jsonb_array_elements(v_adds) loop
    v_line := v_a -> 'line';
    v_no := (v_a ->> 'line_no')::int;
    if v_a ->> 'opening_line_id' is not null then
      select * into v_ol from public.inventory_opening_lines where id = (v_a ->> 'opening_line_id')::uuid for update;
    else
      -- The record this import has just posted for the same product, location and batch.
      select l.* into v_ol from public.inventory_opening_lines l
      where l.company_id = v_company and l.status = 'POSTED' and l.product_id = (v_line ->> 'product_id')::uuid and l.location_id = (v_line ->> 'location_id')::uuid
        and coalesce(lower(l.batch_number), '') = coalesce(lower(nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '')), '')
      for update;
    end if;
    if v_ol.id is null or v_ol.status <> 'POSTED' or v_ol.posted_transaction_id is null then
      raise exception 'Line %: the opening stock record to add to is not posted.', v_no using errcode = 'P0001';
    end if;
    select b.document_number into v_doc from public.inventory_opening_batches b where b.id = v_ol.opening_batch_id;
    select t.batch_id into v_lot from public.inventory_transactions t where t.id = v_ol.posted_transaction_id;
    v_lot_cost := round(private.lot_average_cost(v_lot), 4);
    v_qty := (v_line ->> 'quantity')::numeric;
    v_eff := coalesce(nullif(v_line ->> 'effective_date', '')::date, v_today);
    v_excel := case when v_use_cost then nullif(btrim(coalesce(v_line ->> 'unit_cost', '')), '')::numeric end;
    -- Cost of the added quantity: the lot's cost (valuation of posted stock unchanged), or a permitted Excel cost.
    v_msg := case when v_excel is not null then private.opening_addition_cost_error(v_company, v_excel, v_lot_cost, v_doc) end;
    if v_msg is not null then
      raise exception 'Line %: %', v_no, v_msg using errcode = 'P0001';
    end if;
    v_cost := coalesce(v_excel, v_lot_cost);
    v_source := case when v_excel is not null and v_lot_cost is null then 'EXCEL_OVERRIDE' when v_lot_cost is not null then 'EXISTING_LOT_COST' else 'PENDING' end;
    v_prev_qty := v_ol.quantity + private.opening_added_quantity(v_ol.id);
    v_notes := case when v_use_notes then nullif(btrim(coalesce(v_line ->> 'notes', '')), '') end;
    begin
      v_tx := private.post_movement(v_company, 'OPENING_STOCK', v_lot, v_ol.location_id, v_qty, v_cost,
        'OPENING_ADDITION', v_doc, v_ol.id, 'Opening stock added to ' || v_doc || ' by import' || coalesce(' (' || left(p_file_name, 100) || ')', ''),
        v_notes, private.company_day_start(v_company, v_eff), 'OPENING', v_ol.opening_batch_id, null, null, auth.uid());
    exception when others then
      raise exception 'Line %: %', v_no, sqlerrm using errcode = 'P0001';
    end;
    select transaction_number into v_tx_no from public.inventory_transactions where id = v_tx;
    perform private.write_audit_log(v_company, 'inventory.opening_quantity_added', 'inventory_opening_line', v_ol.id::text,
      jsonb_build_object('document_number', v_doc, 'product_id', v_ol.product_id, 'location_id', v_ol.location_id, 'batch_number', v_ol.batch_number,
        'previous_quantity', v_prev_qty, 'added_quantity', v_qty, 'new_quantity', v_prev_qty + v_qty, 'unit_cost', v_cost, 'cost_source', v_source,
        'transaction_number', v_tx_no, 'file_name', p_file_name, 'import_line_no', v_no));
    v_added := v_added || jsonb_build_array(jsonb_build_object('line_no', v_no, 'document_number', v_doc, 'opening_line_id', v_ol.id,
      'previous_quantity', v_prev_qty, 'added_quantity', v_qty, 'new_quantity', v_prev_qty + v_qty, 'unit_cost', v_cost, 'cost_source', v_source,
      'transaction_number', v_tx_no));
    v_ol := null;
  end loop;

  return private.idempotency_finish(v_company, p_idempotency_key, coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'ok', true, 'new_lines', jsonb_array_length(v_new), 'additions', v_added, 'kept', v_kept,
    'status', coalesce(v_result ->> 'status', case when jsonb_array_length(v_added) > 0 then 'POSTED' end)));
end;
$$;

revoke all on function private.opening_added_quantity(uuid), private.opening_addition_cost_error(uuid, numeric, numeric, text) from public, anon, authenticated;
revoke all on function public.opening_stock_import_matches(uuid[]), public.inventory_import_opening_stock(jsonb, jsonb, boolean, text, text, uuid) from public, anon;
grant execute on function public.opening_stock_import_matches(uuid[]), public.inventory_import_opening_stock(jsonb, jsonb, boolean, text, text, uuid) to authenticated;
