-- =============================================================================
-- Rollback of 20261205090000_grn_hsn_snapshot.sql
--
-- Restores purchase_receipt_post as in 20261202090000 and goods_receipt_direct_post as in 20261104090000,
-- re-creates goods_receipt_line_list and drops goods_receipt_lines.hsn_code.
-- * REMOVED: the HSN snapshots of GRN lines posted while this migration was installed.
-- * KEPT: Product Master HSN changes made by GRN postings (ordinary product versions) and their audit entries.
-- * Roll back the app's GRN HSN fields first: the restored functions ignore "hsn_code".
-- =============================================================================

create or replace function public.purchase_receipt_post(
  p_po_id           uuid,
  p_header          jsonb,
  p_lines           jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_receipt.create');
  v_uid      uuid := auth.uid();
  v_previous jsonb;
  v_po       public.purchase_orders;
  v_h        jsonb := coalesce(p_header, '{}'::jsonb);
  v_today    date;
  v_date     date;
  v_ts       timestamptz;
  v_number   text;
  v_receipt  uuid;
  v_in       jsonb;
  v_idx      int := 0;
  v_pl       public.purchase_order_lines;
  v_product  public.products;
  v_acc_loc  public.inventory_locations;
  v_rej_loc  public.inventory_locations;
  v_recv     numeric;
  v_acc      numeric;
  v_rej      numeric;
  v_prev     numeric;
  v_pending  numeric;
  v_over     text;
  v_rej_note text;
  v_lot      uuid;
  v_cost     numeric;
  v_po_price numeric;
  v_po_cost  numeric;
  v_actual   numeric;
  v_price_reason text;
  v_unit_disc numeric;
  v_taxable  numeric;
  v_line_value numeric;
  v_changes  jsonb := '[]'::jsonb;
  v_acc_tx   uuid;
  v_rej_tx   uuid;
  v_seen     uuid[] := '{}';
  v_txns     text[] := '{}';
  v_from     text;
  v_to       text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'purchase_receipt');
  if v_previous is not null then return v_previous; end if;

  select * into v_po from public.purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
  end if;
  if v_po.status not in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') then
    raise exception 'Goods can only be received on an approved order (this one is %).', lower(replace(v_po.status, '_', ' ')) using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);
  v_date := coalesce(private.purchase_json_date(v_h, 'receipt_date', 'Receipt date'), v_today);
  if v_date > v_today then
    raise exception 'The receipt date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_date < v_po.po_date then
    raise exception 'The receipt date cannot be before the PO date (%).', v_po.po_date using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Enter the quantity received for at least one line.' using errcode = 'P0001';
  end if;

  v_ts := private.effective_timestamp(v_company, v_date);
  v_number := private.next_document_number(v_company, 'GRN');
  insert into public.goods_receipts (company_id, receipt_number, purchase_order_id, po_revision, supplier_id, warehouse_id, receipt_date,
    supplier_document_number, supporting_document_ref, notes, created_by)
  values (v_company, v_number, v_po.id, v_po.revision, v_po.supplier_id, v_po.warehouse_id, v_date,
    private.purchase_text(v_h, 'supplier_document_number'), private.purchase_text(v_h, 'supporting_document_ref'), private.purchase_text(v_h, 'notes'), v_uid)
  returning id into v_receipt;

  for v_in in select value from jsonb_array_elements(p_lines) loop
    v_idx := v_idx + 1;
    v_product := null; v_acc_loc := null; v_rej_loc := null; v_lot := null; v_acc_tx := null; v_rej_tx := null;
    v_price_reason := null; v_line_value := null; v_taxable := null;
    select * into v_pl from public.purchase_order_lines
    where id = private.purchase_json_uuid(v_in, 'po_line_id', format('Receipt line %s', v_idx)) and purchase_order_id = v_po.id;
    if not found then
      raise exception 'Receipt line %: the order line does not belong to this purchase order.', v_idx using errcode = 'P0001';
    end if;
    if v_pl.id = any(v_seen) then
      raise exception 'Order line % appears more than once in this receipt.', v_pl.line_no using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_pl.id;
    if v_pl.line_type = 'CHARGE' then
      raise exception 'Order line % is a charge; charges are not received.', v_pl.line_no using errcode = 'P0001';
    end if;
    v_recv := coalesce(private.purchase_json_num(v_in, 'received_quantity', format('Line %s received', v_pl.line_no)), 0);
    v_acc := coalesce(private.purchase_json_num(v_in, 'accepted_quantity', format('Line %s accepted', v_pl.line_no)), 0);
    v_rej := coalesce(private.purchase_json_num(v_in, 'rejected_quantity', format('Line %s rejected', v_pl.line_no)), 0);
    if v_recv <= 0 or v_acc < 0 or v_rej < 0 then
      raise exception 'Line %: enter the quantity received (greater than zero) and how much was accepted and rejected.', v_pl.line_no using errcode = 'P0001';
    end if;
    if v_recv <> round(v_recv, 3) or v_acc <> round(v_acc, 3) or v_rej <> round(v_rej, 3) then
      raise exception 'Line %: quantities support at most 3 decimal places.', v_pl.line_no using errcode = 'P0001';
    end if;
    if v_acc + v_rej <> v_recv then
      raise exception 'Line %: accepted (%) plus rejected (%) must equal the quantity received (%).', v_pl.line_no, v_acc, v_rej, v_recv using errcode = 'P0001';
    end if;
    v_rej_note := private.purchase_text(v_in, 'rejection_reason');
    if v_rej > 0 and v_rej_note is null then
      raise exception 'Line %: enter the reason for the rejected / damaged quantity.', v_pl.line_no using errcode = 'P0001';
    end if;

    -- Pending = ordered - accepted so far (rejected goods are expected to be replaced).
    select r.accepted into v_prev from private.po_line_receipts(v_pl.id) r;
    v_pending := greatest(v_pl.ordered_quantity - v_prev, 0);
    v_over := private.purchase_text(v_in, 'over_receipt_reason');
    if v_recv > v_pending then
      if not private.has_permission(v_company, 'purchase_exception.approve') then
        raise exception 'Line %: % received exceeds the % still pending on the order. Receiving more than ordered needs purchase_exception.approve.',
          v_pl.line_no, v_recv, v_pending using errcode = '42501';
      end if;
      if v_over is null or length(v_over) < 5 then
        raise exception 'Line %: receiving more than the pending quantity requires a documented reason.', v_pl.line_no using errcode = 'P0001';
      end if;
    else
      v_over := null;
    end if;

    -- Prices, cost and payable of this line, recorded at posting: later PO amendments never change them,
    -- and the purchase order itself is never changed.
    v_po_price := coalesce(v_pl.unit_price, 0);
    -- PO cost per unit excluding GST, after the order line's discount (the existing rule).
    v_po_cost := round(v_pl.taxable_value / v_pl.ordered_quantity, 4);
    v_cost := v_po_cost;
    v_actual := private.purchase_json_num(v_in, 'actual_unit_price', format('Line %s actual purchase unit cost', v_pl.line_no));
    if v_actual is null or v_actual = v_po_price then
      -- Unchanged price: the accepted share of the order line's own total (price, discount and GST as
      -- ordered) - the same value the payable fallback gives, now stored.
      v_actual := v_po_price;
      v_line_value := private.grn_line_value(v_acc, v_pl.ordered_quantity, v_pl.line_total);
    else
      if v_pl.line_type <> 'GOODS' then
        raise exception 'Line %: the actual purchase unit cost can only be changed on goods lines; services are received at the PO price.', v_pl.line_no
          using errcode = 'P0001';
      end if;
      if v_actual < 0 then
        raise exception 'Line %: the actual purchase unit cost cannot be negative.', v_pl.line_no using errcode = 'P0001';
      end if;
      if v_actual > 999999999999 then
        raise exception 'Line %: the actual purchase unit cost is too large (the maximum is 999,999,999,999).', v_pl.line_no using errcode = 'P0001';
      end if;
      if v_actual <> round(v_actual, 4) then
        raise exception 'Line %: the actual purchase unit cost supports at most 4 decimal places.', v_pl.line_no using errcode = 'P0001';
      end if;
      if v_actual = 0 then
        raise exception 'Line %: the actual purchase unit cost cannot be zero when the PO price is %.', v_pl.line_no, v_po_price using errcode = 'P0001';
      end if;
      v_price_reason := left(private.purchase_text(v_in, 'price_variance_reason'), 500);
      if v_price_reason is null or length(v_price_reason) < 3 then
        raise exception 'Line %: the actual purchase unit cost (%) differs from the PO price (%). Select the reason for the price change.',
          v_pl.line_no, v_actual, v_po_price using errcode = 'P0001';
      end if;
      -- Same discount as the order line: the percentage, or the fixed amount spread over the ordered quantity.
      v_unit_disc := case when coalesce(v_pl.discount_percent, 0) > 0 then v_actual * v_pl.discount_percent / 100
                          else coalesce(v_pl.discount_amount, 0) / v_pl.ordered_quantity end;
      v_cost := round(v_actual - v_unit_disc, 4);
      if v_cost < 0 then
        raise exception 'Line %: the actual purchase unit cost (%) is lower than the discount per unit on the order line.', v_pl.line_no, v_actual using errcode = 'P0001';
      end if;
      if v_cost > 9999999999.9999 then
        raise exception 'Line %: the cost after discount (%) is larger than stock can be valued at (the maximum is 9,999,999,999.9999 per unit).', v_pl.line_no, v_cost
          using errcode = 'P0001';
      end if;
      -- Payable for the accepted quantity at the actual cost, with the order line's own tax components
      -- (CGST + SGST, or IGST; all zero on NO_GST / IMPORT orders), each rounded like the order line.
      v_taxable := round(v_acc * v_cost, 2);
      v_line_value := v_taxable
        + round(v_taxable * coalesce(v_pl.cgst_rate, 0) / 100, 2)
        + round(v_taxable * coalesce(v_pl.sgst_rate, 0) / 100, 2)
        + round(v_taxable * coalesce(v_pl.igst_rate, 0) / 100, 2);
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('po_line_no', v_pl.line_no, 'sku', v_pl.sku, 'po_unit_price', v_po_price,
        'actual_unit_price', v_actual, 'difference', v_actual - v_po_price, 'po_unit_cost', v_po_cost, 'actual_unit_cost', v_cost,
        'variance_percent', case when v_po_price > 0 then round((v_actual - v_po_price) / v_po_price * 100, 2) end, 'reason', v_price_reason,
        'payable', v_line_value));
    end if;
    if v_line_value > 99999999999999.99 or v_recv * v_cost > 99999999999999.99 then
      raise exception 'Line %: the value of this line is too large to record. Check the quantity and the price.', v_pl.line_no using errcode = 'P0001';
    end if;

    if v_pl.line_type = 'GOODS' then
      v_product := private.require_active_product(v_company, v_pl.product_id);
      if v_acc > 0 then
        select * into v_acc_loc from public.inventory_locations
        where id = private.purchase_json_uuid(v_in, 'accepted_location_id', format('Line %s location', v_pl.line_no)) and company_id = v_company;
        if not found or v_acc_loc.warehouse_id is distinct from v_po.warehouse_id or v_acc_loc.stock_usage <> 'STORAGE' then
          raise exception 'Line %: receive accepted goods into a storage location of warehouse %.', v_pl.line_no, coalesce(v_po.warehouse_code, '(not set)')
            using errcode = 'P0001';
        end if;
      end if;
      if private.purchase_json_uuid(v_in, 'rejected_location_id', 'Rejected location') is not null then
        if v_rej = 0 then
          raise exception 'Line %: a rejected-goods location was given but nothing was rejected.', v_pl.line_no using errcode = 'P0001';
        end if;
        select * into v_rej_loc from public.inventory_locations
        where id = private.purchase_json_uuid(v_in, 'rejected_location_id', 'Rejected location') and company_id = v_company;
        if not found or v_rej_loc.stock_usage not in ('REJECTED', 'QUARANTINE') then
          raise exception 'Line %: rejected goods can only be stocked in a rejected-goods or quarantine location (never available stock).', v_pl.line_no
            using errcode = 'P0001';
        end if;
      end if;
      if v_acc_loc.id is not null or v_rej_loc.id is not null then
        -- Purchased stock is externally sourced: lot source OUTSOURCED.
        v_lot := private.ensure_batch(v_company, v_product.id, 'OUTSOURCED', private.purchase_text(v_in, 'batch_number'),
          private.purchase_json_date(v_in, 'manufacturing_date', 'Manufacturing date'), private.purchase_json_date(v_in, 'expiry_date', 'Expiry date'),
          v_cost, 'PURCHASE_ORDER', v_po.id, coalesce(v_acc_loc.warehouse_id, v_rej_loc.warehouse_id), coalesce(v_acc_loc.id, v_rej_loc.id), false);
      end if;
      if v_acc_loc.id is not null then
        v_acc_tx := private.post_movement(v_company, 'RECEIPT', v_lot, v_acc_loc.id, v_acc, v_cost,
          'PURCHASE_ORDER', v_po.po_number, v_po.id, 'Received from ' || v_po.supplier_name || ' (' || v_number || ')',
          private.purchase_text(v_h, 'notes'), v_ts, 'PURCHASE_ORDER', v_po.id);
        v_txns := v_txns || (select transaction_number from public.inventory_transactions where id = v_acc_tx);
      end if;
      if v_rej_loc.id is not null then
        v_rej_tx := private.post_movement(v_company, 'RECEIPT', v_lot, v_rej_loc.id, v_rej, v_cost,
          'PURCHASE_ORDER', v_po.po_number, v_po.id, 'Rejected goods from ' || v_po.supplier_name || ' (' || v_number || '): ' || v_rej_note,
          private.purchase_text(v_h, 'notes'), v_ts, 'PURCHASE_ORDER', v_po.id);
        v_txns := v_txns || (select transaction_number from public.inventory_transactions where id = v_rej_tx);
      end if;
    else
      if private.purchase_json_uuid(v_in, 'accepted_location_id', 'Location') is not null or private.purchase_json_uuid(v_in, 'rejected_location_id', 'Location') is not null
         or private.purchase_text(v_in, 'batch_number') is not null then
        raise exception 'Line %: services are not stocked; leave the location and batch empty.', v_pl.line_no using errcode = 'P0001';
      end if;
    end if;

    insert into public.goods_receipt_lines (company_id, goods_receipt_id, purchase_order_id, purchase_order_line_id, line_type, product_id, unit,
      received_quantity, accepted_quantity, rejected_quantity, inspection_status, rejection_reason, accepted_location_id, rejected_location_id,
      batch_id, batch_number, manufacturing_date, expiry_date, serial_numbers, unit_cost, accepted_transaction_id, rejected_transaction_id, over_receipt_reason,
      po_unit_price, po_unit_cost, actual_unit_price, price_variance_reason, line_value)
    values (v_company, v_receipt, v_po.id, v_pl.id, v_pl.line_type, v_pl.product_id, v_pl.unit,
      v_recv, v_acc, v_rej, case when v_rej = 0 then 'ACCEPTED' when v_acc = 0 then 'REJECTED' else 'PARTIALLY_ACCEPTED' end, v_rej_note,
      v_acc_loc.id, v_rej_loc.id, v_lot, (select batch_number from public.inventory_batches where id = v_lot),
      private.purchase_json_date(v_in, 'manufacturing_date', 'Manufacturing date'), private.purchase_json_date(v_in, 'expiry_date', 'Expiry date'),
      private.purchase_text(v_in, 'serial_numbers'), case when v_pl.line_type = 'GOODS' then v_cost end, v_acc_tx, v_rej_tx, v_over,
      v_po_price, v_po_cost, v_actual, v_price_reason, v_line_value);
  end loop;

  v_from := v_po.status;
  v_to := private.po_receipt_status(v_po.id);
  update public.purchase_orders set status = v_to, updated_by = v_uid where id = v_po.id;
  perform private.log_purchase_event(v_company, v_po.id, 'RECEIPT_POSTED', v_from, v_to, private.purchase_text(v_h, 'notes'),
    jsonb_build_object('receipt_number', v_number, 'lines', v_idx, 'transactions', to_jsonb(v_txns), 'price_changes', v_changes));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'receipt_id', v_receipt, 'receipt_number', v_number, 'po_status', v_to, 'transaction_numbers', to_jsonb(v_txns),
    -- Tells the app this server records actual purchase costs (stored with the result, so replays carry it too).
    'actual_cost_supported', true));
end;
$$;

create or replace function public.goods_receipt_direct_post(p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_receipt.create');
  v_uid      uuid := auth.uid();
  v_previous jsonb;
  v_h        jsonb := coalesce(p_header, '{}'::jsonb);
  v_today    date;
  v_date     date;
  v_ts       timestamptz;
  v_sup      public.suppliers;
  v_wh       public.warehouses;
  v_number   text;
  v_receipt  uuid;
  v_in       jsonb;
  v_idx      int := 0;
  v_product  public.products;
  v_acc_loc  public.inventory_locations;
  v_rej_loc  public.inventory_locations;
  v_recv     numeric;
  v_acc      numeric;
  v_rej      numeric;
  v_rej_note text;
  v_cost     numeric;
  v_gst      numeric;
  v_lot      uuid;
  v_acc_tx   uuid;
  v_rej_tx   uuid;
  v_seen     uuid[] := '{}';
  v_txns     text[] := '{}';
  v_warn     text[] := '{}';
  v_from     text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'goods_receipt_direct');
  if v_previous is not null then return v_previous; end if;

  v_today := private.company_today(v_company);
  v_date := coalesce(private.purchase_json_date(v_h, 'receipt_date', 'Receipt date'), v_today);
  if v_date > v_today then
    raise exception 'The receipt date cannot be in the future.' using errcode = 'P0001';
  end if;
  if private.purchase_json_uuid(v_h, 'supplier_id', 'Supplier') is not null then
    select * into v_sup from public.suppliers where id = private.purchase_json_uuid(v_h, 'supplier_id', 'Supplier') and company_id = v_company;
    if not found then
      raise exception 'Supplier not found in your company.' using errcode = 'P0001';
    end if;
  else
    v_warn := v_warn || 'No supplier: the goods are not added to any supplier''s payable.'::text;
  end if;
  select * into v_wh from public.warehouses where id = private.purchase_json_uuid(v_h, 'warehouse_id', 'Warehouse') and company_id = v_company;
  if not found or v_wh.status <> 'ACTIVE' then
    raise exception 'Choose the active warehouse the goods were received into.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Enter at least one product received.' using errcode = 'P0001';
  end if;

  v_ts := private.effective_timestamp(v_company, v_date);
  v_number := private.next_document_number(v_company, 'GRN');
  insert into public.goods_receipts (company_id, receipt_number, receipt_type, purchase_order_id, po_revision, supplier_id, warehouse_id, receipt_date,
    supplier_document_number, supporting_document_ref, notes, created_by)
  values (v_company, v_number, 'DIRECT', null, null, v_sup.id, v_wh.id, v_date,
    private.purchase_text(v_h, 'supplier_document_number'), private.purchase_text(v_h, 'supporting_document_ref'), private.purchase_text(v_h, 'notes'), v_uid)
  returning id into v_receipt;

  for v_in in select value from jsonb_array_elements(p_lines) loop
    v_idx := v_idx + 1;
    v_acc_loc := null; v_rej_loc := null; v_lot := null; v_acc_tx := null; v_rej_tx := null;
    v_product := private.require_active_product(v_company, private.purchase_json_uuid(v_in, 'product_id', format('Line %s product', v_idx)));
    if v_product.id = any(v_seen) then
      raise exception 'Line %: % is listed more than once. Combine the quantities on one line.', v_idx, v_product.sku using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_product.id;
    v_recv := coalesce(private.purchase_json_num(v_in, 'received_quantity', format('Line %s received', v_idx)), 0);
    v_acc := coalesce(private.purchase_json_num(v_in, 'accepted_quantity', format('Line %s accepted', v_idx)), v_recv);
    v_rej := coalesce(private.purchase_json_num(v_in, 'rejected_quantity', format('Line %s rejected', v_idx)), 0);
    if v_recv <= 0 or v_acc < 0 or v_rej < 0 then
      raise exception 'Line %: enter the quantity received (greater than zero) and how much was accepted and rejected.', v_idx using errcode = 'P0001';
    end if;
    if v_recv <> round(v_recv, 3) or v_acc <> round(v_acc, 3) or v_rej <> round(v_rej, 3) then
      raise exception 'Line %: quantities support at most 3 decimal places.', v_idx using errcode = 'P0001';
    end if;
    if v_acc + v_rej <> v_recv then
      raise exception 'Line %: accepted (%) plus rejected (%) must equal the quantity received (%).', v_idx, v_acc, v_rej, v_recv using errcode = 'P0001';
    end if;
    v_rej_note := private.purchase_text(v_in, 'rejection_reason');
    if v_rej > 0 and v_rej_note is null then
      raise exception 'Line %: enter the reason for the rejected / damaged quantity.', v_idx using errcode = 'P0001';
    end if;
    v_cost := coalesce(private.purchase_json_num(v_in, 'unit_cost', format('Line %s unit cost', v_idx)), v_product.standard_cost);
    v_gst := coalesce(private.purchase_json_num(v_in, 'gst_rate', format('Line %s GST rate', v_idx)), v_product.gst_rate);
    if v_cost is not null and (v_cost < 0 or v_cost <> round(v_cost, 4)) then
      raise exception 'Line %: unit cost must be zero or more (up to 4 decimals).', v_idx using errcode = 'P0001';
    end if;
    if v_gst is not null and (v_gst < 0 or v_gst > 100) then
      raise exception 'Line %: GST rate must be between 0 and 100.', v_idx using errcode = 'P0001';
    end if;
    if v_cost is null then
      v_warn := v_warn || format('Line %s (%s): no unit cost, so the stock value and the supplier payable for it are unknown.', v_idx, v_product.sku);
    end if;

    if v_acc > 0 then
      select * into v_acc_loc from public.inventory_locations
      where id = private.purchase_json_uuid(v_in, 'accepted_location_id', format('Line %s location', v_idx)) and company_id = v_company;
      if not found or v_acc_loc.warehouse_id <> v_wh.id or v_acc_loc.stock_usage <> 'STORAGE' then
        raise exception 'Line %: receive accepted goods into a storage location of warehouse %.', v_idx, v_wh.warehouse_code using errcode = 'P0001';
      end if;
    end if;
    if private.purchase_json_uuid(v_in, 'rejected_location_id', 'Rejected location') is not null then
      if v_rej = 0 then
        raise exception 'Line %: a rejected-goods location was given but nothing was rejected.', v_idx using errcode = 'P0001';
      end if;
      select * into v_rej_loc from public.inventory_locations
      where id = private.purchase_json_uuid(v_in, 'rejected_location_id', 'Rejected location') and company_id = v_company;
      if not found or v_rej_loc.stock_usage not in ('REJECTED', 'QUARANTINE') then
        raise exception 'Line %: rejected goods can only be stocked in a rejected-goods or quarantine location (never available stock).', v_idx using errcode = 'P0001';
      end if;
    end if;
    if v_acc_loc.id is not null or v_rej_loc.id is not null then
      v_lot := private.ensure_batch(v_company, v_product.id, 'OUTSOURCED', private.purchase_text(v_in, 'batch_number'),
        private.purchase_json_date(v_in, 'manufacturing_date', 'Manufacturing date'), private.purchase_json_date(v_in, 'expiry_date', 'Expiry date'),
        v_cost, 'GOODS_RECEIPT', v_receipt, coalesce(v_acc_loc.warehouse_id, v_rej_loc.warehouse_id), coalesce(v_acc_loc.id, v_rej_loc.id), false);
    end if;
    -- Document type PURCHASE_ORDER keeps these postings out of the generic
    -- stock reversal: they are reversed only through the goods receipt.
    if v_acc_loc.id is not null then
      v_acc_tx := private.post_movement(v_company, 'RECEIPT', v_lot, v_acc_loc.id, v_acc, v_cost,
        'GOODS_RECEIPT', v_number, v_receipt, 'Received without a purchase order' || coalesce(' from ' || v_sup.legal_name, '') || ' (' || v_number || ')',
        private.purchase_text(v_h, 'notes'), v_ts, 'PURCHASE_ORDER', v_receipt);
      v_txns := v_txns || (select transaction_number from public.inventory_transactions where id = v_acc_tx);
    end if;
    if v_rej_loc.id is not null then
      v_rej_tx := private.post_movement(v_company, 'RECEIPT', v_lot, v_rej_loc.id, v_rej, v_cost,
        'GOODS_RECEIPT', v_number, v_receipt, 'Rejected goods received without a purchase order (' || v_number || '): ' || v_rej_note,
        private.purchase_text(v_h, 'notes'), v_ts, 'PURCHASE_ORDER', v_receipt);
      v_txns := v_txns || (select transaction_number from public.inventory_transactions where id = v_rej_tx);
    end if;

    insert into public.goods_receipt_lines (company_id, goods_receipt_id, purchase_order_id, purchase_order_line_id, line_type, product_id, unit,
      received_quantity, accepted_quantity, rejected_quantity, inspection_status, rejection_reason, accepted_location_id, rejected_location_id,
      batch_id, batch_number, manufacturing_date, expiry_date, serial_numbers, unit_cost, gst_rate, line_value, accepted_transaction_id, rejected_transaction_id)
    values (v_company, v_receipt, null, null, 'GOODS', v_product.id, v_product.base_unit,
      v_recv, v_acc, v_rej, case when v_rej = 0 then 'ACCEPTED' when v_acc = 0 then 'REJECTED' else 'PARTIALLY_ACCEPTED' end, v_rej_note,
      v_acc_loc.id, v_rej_loc.id, v_lot, (select batch_number from public.inventory_batches where id = v_lot),
      private.purchase_json_date(v_in, 'manufacturing_date', 'Manufacturing date'), private.purchase_json_date(v_in, 'expiry_date', 'Expiry date'),
      private.purchase_text(v_in, 'serial_numbers'), v_cost, v_gst,
      case when v_cost is not null then round(v_acc * v_cost * (1 + coalesce(v_gst, 0) / 100), 2) end, v_acc_tx, v_rej_tx);
  end loop;

  v_from := coalesce(v_sup.legal_name, 'no supplier');
  perform private.write_audit_log(v_company, 'goods_receipt.direct_posted', 'goods_receipt', v_receipt::text,
    jsonb_build_object('receipt_number', v_number, 'supplier', v_from, 'lines', v_idx, 'transactions', to_jsonb(v_txns)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'receipt_id', v_receipt, 'receipt_number', v_number, 'unlinked', true, 'transaction_numbers', to_jsonb(v_txns),
    'warnings', to_jsonb(array['This receipt is not linked to a purchase order.'::text] || v_warn)));
end;
$$;

drop view if exists public.goods_receipt_line_list;
alter table public.goods_receipt_lines drop constraint if exists goods_receipt_lines_hsn_check;
alter table public.goods_receipt_lines drop column if exists hsn_code;

create view public.goods_receipt_line_list
with (security_invoker = true) as
select g.*, r.receipt_number, r.receipt_date, r.status as receipt_status, r.supplier_document_number,
  pl.line_no as po_line_no, coalesce(pl.sku, p.sku) as sku, coalesce(pl.description, p.product_name) as description, pl.ordered_quantity,
  al.location_code as accepted_location_code, rl.location_code as rejected_location_code,
  at.transaction_number as accepted_transaction_number, rt.transaction_number as rejected_transaction_number
from public.goods_receipt_lines g
join public.goods_receipts r on r.id = g.goods_receipt_id
left join public.purchase_order_lines pl on pl.id = g.purchase_order_line_id
left join public.products p on p.id = g.product_id
left join public.inventory_locations al on al.id = g.accepted_location_id
left join public.inventory_locations rl on rl.id = g.rejected_location_id
left join public.inventory_transactions at on at.id = g.accepted_transaction_id
left join public.inventory_transactions rt on rt.id = g.rejected_transaction_id;

revoke all on public.goods_receipt_line_list from anon, authenticated;
grant select on public.goods_receipt_line_list to authenticated;
