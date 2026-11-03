-- =============================================================================
-- ALTON ERP V2 — Stage 3: Purchase Orders and Goods Received Notes
--
-- Builds on the existing purchase order and goods receipt module (no new
-- order or receipt tables):
--   * Direct goods receipts without a purchase order (receipt_type DIRECT).
--     They post accepted goods to stock like any receipt and are always shown
--     as "unlinked". Supplier optional; the line value (cost + GST) is kept on
--     the line so supplier payables stay right.
--   * One reversal function for both kinds of receipt (goods_receipt_reverse).
--   * Correction = reversal + corrected repost in ONE transaction
--     (goods_receipt_correct). The original receipt and its stock postings are
--     never changed; the new receipt points at the one it corrects.
--   * Delivery date, reference and notes of an open order can be changed
--     without a new revision (purchase_order_update_details); prices and
--     quantities still go through an amendment (new revision, history kept).
--   * Attachments on supplier purchase orders and goods receipts through the
--     existing documents module (entity types SUPPLIER_PO, GOODS_RECEIPT).
--   * Supplier payables and party history include direct receipts.
-- Stock still changes only by accepted quantities on posted receipts.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Receipts without a purchase order
-- -----------------------------------------------------------------------------
alter table public.goods_receipts alter column purchase_order_id drop not null;
alter table public.goods_receipts alter column po_revision drop not null;
alter table public.goods_receipts alter column supplier_id drop not null;
alter table public.goods_receipts add column if not exists receipt_type text not null default 'PURCHASE_ORDER';
alter table public.goods_receipts add column if not exists corrects_receipt_id uuid;

alter table public.goods_receipt_lines alter column purchase_order_id drop not null;
alter table public.goods_receipt_lines alter column purchase_order_line_id drop not null;
alter table public.goods_receipt_lines add column if not exists gst_rate numeric(5,2);
alter table public.goods_receipt_lines add column if not exists line_value numeric(16,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goods_receipts_type_check') then
    alter table public.goods_receipts add constraint goods_receipts_type_check check (
      receipt_type in ('PURCHASE_ORDER', 'DIRECT')
      and (receipt_type = 'PURCHASE_ORDER') = (purchase_order_id is not null)
      and (purchase_order_id is null or po_revision is not null)
      and (receipt_type = 'DIRECT' or supplier_id is not null)
      and (receipt_type = 'PURCHASE_ORDER' or warehouse_id is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goods_receipts_corrects_fk') then
    alter table public.goods_receipts add constraint goods_receipts_corrects_fk
      foreign key (corrects_receipt_id, company_id) references public.goods_receipts (id, company_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goods_receipt_lines_link_check') then
    alter table public.goods_receipt_lines add constraint goods_receipt_lines_link_check check (
      (purchase_order_id is null) = (purchase_order_line_id is null)
      and (purchase_order_line_id is not null or (line_type = 'GOODS' and product_id is not null))
      and (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100))
      and (line_value is null or line_value >= 0));
  end if;
end;
$$;

comment on column public.goods_receipts.receipt_type is 'PURCHASE_ORDER: received against an order. DIRECT: received without a purchase order (unlinked).';
comment on column public.goods_receipts.corrects_receipt_id is 'The (reversed) receipt this receipt corrects.';
comment on column public.goods_receipt_lines.line_value is 'Direct receipts only: accepted quantity x unit cost incl. GST (for supplier payables). PO receipts are valued from the order line.';

create index if not exists goods_receipts_supplier_idx on public.goods_receipts (company_id, supplier_id, receipt_date);

-- Lists: same columns as before (so the original migration can be re-applied),
-- now including direct receipts.
drop view if exists public.goods_receipt_list;
create view public.goods_receipt_list
with (security_invoker = true) as
select r.*, o.po_number, coalesce(o.supplier_name, s.legal_name) as supplier_name, coalesce(o.supplier_code, s.supplier_code) as supplier_code,
  coalesce(o.warehouse_code, w.warehouse_code) as warehouse_code,
  coalesce(x.lines, 0) as line_count, coalesce(x.received, 0) as total_received, coalesce(x.accepted, 0) as total_accepted, coalesce(x.rejected, 0) as total_rejected
from public.goods_receipts r
left join public.purchase_orders o on o.id = r.purchase_order_id
left join public.suppliers s on s.id = r.supplier_id
left join public.warehouses w on w.id = r.warehouse_id
left join (
  select goods_receipt_id, count(*) as lines, sum(received_quantity) as received, sum(accepted_quantity) as accepted, sum(rejected_quantity) as rejected
  from public.goods_receipt_lines group by goods_receipt_id
) x on x.goods_receipt_id = r.id;

drop view if exists public.goods_receipt_line_list;
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

revoke all on public.goods_receipt_list, public.goods_receipt_line_list from anon, authenticated;
grant select on public.goods_receipt_list, public.goods_receipt_line_list to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Value of a receipt for payables (both kinds)
-- -----------------------------------------------------------------------------
create or replace function private.goods_receipt_value(p_receipt uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total), 0)), 0)
  from public.goods_receipt_lines l
  left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
  where l.goods_receipt_id = p_receipt;
$$;

revoke all on function private.goods_receipt_value(uuid) from public, anon, authenticated;

create or replace function private.supplier_payable(p_supplier uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_supplier is null then 0 else
    coalesce((select sum(private.goods_receipt_value(r.id)) from public.goods_receipts r where r.supplier_id = p_supplier and r.status = 'POSTED'), 0)
    - coalesce((select sum(amount) from public.supplier_payments where supplier_id = p_supplier and status = 'RECORDED'), 0)
  end;
$$;

revoke all on function private.supplier_payable(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Direct (unlinked) goods receipt
-- p_header: {receipt_date?, supplier_id?, warehouse_id, supplier_document_number?, supporting_document_ref?, notes?}
-- p_lines:  [{product_id, received_quantity, accepted_quantity, rejected_quantity, unit_cost?, gst_rate?,
--             accepted_location_id, rejected_location_id?, batch_number?, manufacturing_date?, expiry_date?,
--             serial_numbers?, rejection_reason?}]
-- unit_cost / gst_rate default to the product's standard purchase cost and GST rate.
-- -----------------------------------------------------------------------------
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

revoke all on function public.goods_receipt_direct_post(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.goods_receipt_direct_post(jsonb, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Reverse any goods receipt (PO or direct). Stock that was received must
-- still be there; the receipt stays in the history as REVERSED.
-- -----------------------------------------------------------------------------
create or replace function public.goods_receipt_reverse(p_receipt_id uuid, p_reason text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_exception.approve');
  v_previous jsonb;
  v_r        public.goods_receipts;
  v_l        public.goods_receipt_lines;
  v_numbers  text[] := '{}';
  v_result   jsonb;
begin
  select * into v_r from public.goods_receipts where id = p_receipt_id and company_id = v_company;
  if not found then
    raise exception 'Goods receipt not found in your company.' using errcode = 'P0001';
  end if;
  if v_r.receipt_type = 'PURCHASE_ORDER' then
    return public.purchase_receipt_reverse(p_receipt_id, p_reason, p_idempotency_key);
  end if;

  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'goods_receipt_reversal');
  if v_previous is not null then return v_previous; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'Enter the reason for the reversal (at least 5 characters).' using errcode = 'P0001';
  end if;
  select * into v_r from public.goods_receipts where id = p_receipt_id for update;
  if v_r.status <> 'POSTED' then
    raise exception 'This goods receipt has already been reversed.' using errcode = 'P0001';
  end if;
  for v_l in select * from public.goods_receipt_lines where goods_receipt_id = v_r.id loop
    if v_l.accepted_transaction_id is not null then
      v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_l.accepted_transaction_id, p_reason);
    end if;
    if v_l.rejected_transaction_id is not null then
      v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_l.rejected_transaction_id, p_reason);
    end if;
  end loop;
  update public.goods_receipts set status = 'REVERSED', reversal_transaction_ids = v_numbers, reversal_reason = btrim(p_reason),
    reversed_by = auth.uid(), reversed_at = now() where id = v_r.id;
  perform private.write_audit_log(v_company, 'goods_receipt.reversed', 'goods_receipt', v_r.id::text,
    jsonb_build_object('receipt_number', v_r.receipt_number, 'reason', btrim(p_reason), 'reversal_numbers', to_jsonb(v_numbers)));
  v_result := jsonb_build_object('reversal_numbers', to_jsonb(v_numbers), 'po_status', null);
  return private.idempotency_finish(v_company, p_idempotency_key, v_result);
end;
$$;

revoke all on function public.goods_receipt_reverse(uuid, text, uuid) from public, anon;
grant execute on function public.goods_receipt_reverse(uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Correct a goods receipt: reverse it and post the corrected receipt in one
-- transaction (both stay in the history; the new one points at the original).
-- p_header / p_lines: as purchase_receipt_post (PO receipts) or
-- goods_receipt_direct_post (direct receipts). A missing receipt date, supplier
-- or warehouse is taken from the original receipt.
-- -----------------------------------------------------------------------------
create or replace function public.goods_receipt_correct(p_receipt_id uuid, p_reason text, p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_exception.approve');
  v_previous jsonb;
  v_r        public.goods_receipts;
  v_rev      jsonb;
  v_new      jsonb;
  v_h        jsonb := coalesce(p_header, '{}'::jsonb);
begin
  perform private.require_permission('purchase_receipt.create');
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'goods_receipt_correction');
  if v_previous is not null then return v_previous; end if;
  select * into v_r from public.goods_receipts where id = p_receipt_id and company_id = v_company;
  if not found then
    raise exception 'Goods receipt not found in your company.' using errcode = 'P0001';
  end if;
  if v_r.status <> 'POSTED' then
    raise exception 'Only a posted goods receipt can be corrected (% is already reversed).', v_r.receipt_number using errcode = 'P0001';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'Enter the reason for the correction (at least 5 characters).' using errcode = 'P0001';
  end if;

  v_rev := public.goods_receipt_reverse(v_r.id, 'Corrected: ' || btrim(p_reason), gen_random_uuid());
  v_h := jsonb_build_object('receipt_date', v_r.receipt_date, 'supplier_document_number', v_r.supplier_document_number,
           'supporting_document_ref', v_r.supporting_document_ref, 'notes', v_r.notes, 'supplier_id', v_r.supplier_id, 'warehouse_id', v_r.warehouse_id)
         || jsonb_strip_nulls(v_h);
  -- Posted receipts are immutable, so the link is set while the new receipt is
  -- inserted (goods_receipts_set_corrects reads this transaction-local setting).
  perform set_config('app.grn_corrects', v_r.id::text, true);
  if v_r.receipt_type = 'PURCHASE_ORDER' then
    v_new := public.purchase_receipt_post(v_r.purchase_order_id, v_h, p_lines, gen_random_uuid());
  else
    v_new := public.goods_receipt_direct_post(v_h, p_lines, gen_random_uuid());
  end if;
  perform set_config('app.grn_corrects', '', true);
  if v_r.purchase_order_id is not null then
    perform private.log_purchase_event(v_company, v_r.purchase_order_id, 'RECEIPT_CORRECTED', null, v_new ->> 'po_status', btrim(p_reason),
      jsonb_build_object('original', v_r.receipt_number, 'corrected_by', v_new ->> 'receipt_number'));
  end if;
  perform private.write_audit_log(v_company, 'goods_receipt.corrected', 'goods_receipt', v_r.id::text,
    jsonb_build_object('receipt_number', v_r.receipt_number, 'corrected_by', v_new ->> 'receipt_number', 'reason', btrim(p_reason)));
  return private.idempotency_finish(v_company, p_idempotency_key, v_new || jsonb_build_object(
    'corrects_receipt_number', v_r.receipt_number, 'reversal_numbers', v_rev -> 'reversal_numbers'));
end;
$$;

create or replace function private.goods_receipts_set_corrects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := nullif(coalesce(current_setting('app.grn_corrects', true), ''), '');
begin
  if v_id is not null then
    new.corrects_receipt_id := v_id::uuid;
  end if;
  return new;
end;
$$;

revoke all on function private.goods_receipts_set_corrects() from public, anon, authenticated;
drop trigger if exists goods_receipts_set_corrects on public.goods_receipts;
create trigger goods_receipts_set_corrects before insert on public.goods_receipts
  for each row execute function private.goods_receipts_set_corrects();

revoke all on function public.goods_receipt_correct(uuid, text, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.goods_receipt_correct(uuid, text, jsonb, jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Change delivery details of an order without a new revision
-- p_changes: any of {expected_delivery_date, reference_number, delivery_instructions, internal_notes, purchase_conditions}
-- (amounts, quantities and supplier still need an amendment: new revision, history kept)
-- -----------------------------------------------------------------------------
create or replace function public.purchase_order_update_details(p_po_id uuid, p_changes jsonb, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_order.update', 'purchase_order.amend']);
  v_po      public.purchase_orders;
  v_c       jsonb := coalesce(p_changes, '{}'::jsonb);
  v_date    date;
  v_changed jsonb := '{}'::jsonb;
  k         text;
begin
  select * into v_po from public.purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_po.updated_at <> p_expected_updated_at then
    raise exception 'This purchase order was changed by someone else. Reload it and try again.' using errcode = 'P0001';
  end if;
  if v_po.status in ('CANCELLED', 'CLOSED') then
    raise exception 'A % order cannot be changed.', lower(v_po.status) using errcode = 'P0001';
  end if;
  for k in select jsonb_object_keys(v_c) loop
    if k not in ('expected_delivery_date', 'reference_number', 'delivery_instructions', 'internal_notes', 'purchase_conditions') then
      raise exception 'Only the delivery date, reference and notes can be changed here; edit the order (new revision) to change % .', k using errcode = 'P0001';
    end if;
  end loop;
  if v_c ? 'expected_delivery_date' then
    v_date := private.purchase_json_date(v_c, 'expected_delivery_date', 'Expected delivery date');
    if v_date is not null and v_date < v_po.po_date then
      raise exception 'The expected delivery date cannot be before the PO date (%).', v_po.po_date using errcode = 'P0001';
    end if;
    if v_date is distinct from v_po.expected_delivery_date then
      v_changed := v_changed || jsonb_build_object('expected_delivery_date', jsonb_build_array(v_po.expected_delivery_date, v_date));
    end if;
  end if;
  update public.purchase_orders set
    expected_delivery_date = case when v_c ? 'expected_delivery_date' then v_date else expected_delivery_date end,
    reference_number = case when v_c ? 'reference_number' then left(private.purchase_text(v_c, 'reference_number'), 100) else reference_number end,
    delivery_instructions = case when v_c ? 'delivery_instructions' then left(private.purchase_text(v_c, 'delivery_instructions'), 2000) else delivery_instructions end,
    internal_notes = case when v_c ? 'internal_notes' then left(private.purchase_text(v_c, 'internal_notes'), 2000) else internal_notes end,
    purchase_conditions = case when v_c ? 'purchase_conditions' then left(private.purchase_text(v_c, 'purchase_conditions'), 4000) else purchase_conditions end,
    updated_by = auth.uid()
  where id = v_po.id
  returning * into v_po;
  perform private.log_purchase_event(v_company, v_po.id, 'DETAILS_UPDATED', v_po.status, v_po.status, null,
    jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(v_c) x), 'changes', v_changed));
  return jsonb_build_object('po_id', v_po.id, 'updated_at', v_po.updated_at, 'expected_delivery_date', v_po.expected_delivery_date);
end;
$$;

revoke all on function public.purchase_order_update_details(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.purchase_order_update_details(uuid, jsonb, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Attachments on supplier purchase orders and goods receipts
-- -----------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.documents'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%related_entity_type%'
  loop
    execute format('alter table public.documents drop constraint %I', v_name);
  end loop;
end;
$$;
alter table public.documents add constraint documents_related_entity_type_check check (related_entity_type in ('PRODUCT', 'BATCH', 'WAREHOUSE',
  'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER', 'COMPANY',
  'SUPPLIER_PO', 'GOODS_RECEIPT'));

create or replace function private.document_entity(p_company uuid, p_type text, p_id uuid)
returns table (reference text, read_permission text, link text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select x.reference, x.perm, x.link from (
    select p.sku as reference, 'products.read' as perm, '/products/' || p.id as link from public.products p where p_type = 'PRODUCT' and p.id = p_id and p.company_id = p_company
    union all select coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku, 'inventory.read', '/inventory/stock/' || p.id
      from public.inventory_batches b join public.products p on p.id = b.product_id where p_type = 'BATCH' and b.id = p_id and b.company_id = p_company
    union all select w.warehouse_code, 'inventory.read', '/inventory/warehouses' from public.warehouses w where p_type = 'WAREHOUSE' and w.id = p_id and w.company_id = p_company
    union all select o.production_order_number, 'manufacturing.read', '/production/orders/' || o.id from public.production_orders o where p_type = 'PRODUCTION_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.outsourcing_order_number, 'outsourcing.read', '/production/outsourcing/' || o.id from public.outsourcing_orders o where p_type = 'OUTSOURCING_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.customer_po_number || ' (' || o.po_reference || ')', 'customer_po.read', '/customer-pos/' || o.id from public.customer_purchase_orders o where p_type = 'CUSTOMER_PO' and o.id = p_id and o.company_id = p_company
    union all select s.sales_order_number, 'sales_orders.read', '/sales/order-details?so=' || s.id from public.sales_orders s where p_type = 'SALES_ORDER' and s.id = p_id and s.company_id = p_company
    union all select f.fulfilment_number, 'fulfilment.read', '/sales/delivery?f=' || f.id from public.fulfilments f where p_type = 'DISPATCH' and f.id = p_id and f.company_id = p_company
    union all select coalesce(i.invoice_number, 'Draft invoice'), 'invoices.read', '/billing/invoices/' || i.id from public.sales_invoices i where p_type = 'INVOICE' and i.id = p_id and i.company_id = p_company
    union all select coalesce(n.note_number, 'Draft note'), 'invoices.read', '/billing/notes/' || n.id from public.invoice_adjustment_notes n where p_type = 'ADJUSTMENT_NOTE' and n.id = p_id and n.company_id = p_company
    union all select c.customer_code || ' — ' || c.customer_name, 'customers.read', '/customers' from public.customers c where p_type = 'CUSTOMER' and c.id = p_id and c.company_id = p_company
    union all select c.legal_name, 'settings.manage', '/settings' from public.companies c where p_type = 'COMPANY' and c.id = p_id and c.id = p_company
    union all select o.po_number, 'purchases.read', '/purchase-orders/' || o.id from public.purchase_orders o where p_type = 'SUPPLIER_PO' and o.id = p_id and o.company_id = p_company
    union all select g.receipt_number, 'purchases.read', '/goods-receipts/' || g.id from public.goods_receipts g where p_type = 'GOODS_RECEIPT' and g.id = p_id and g.company_id = p_company
  ) x;
end;
$$;

create or replace function private.document_entity_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCT' then 'products.read' when 'BATCH' then 'inventory.read' when 'WAREHOUSE' then 'inventory.read'
    when 'PRODUCTION_ORDER' then 'manufacturing.read' when 'OUTSOURCING_ORDER' then 'outsourcing.read' when 'CUSTOMER_PO' then 'customer_po.read'
    when 'SALES_ORDER' then 'sales_orders.read' when 'DISPATCH' then 'fulfilment.read' when 'INVOICE' then 'invoices.read'
    when 'ADJUSTMENT_NOTE' then 'invoices.read' when 'CUSTOMER' then 'customers.read' when 'COMPANY' then 'settings.manage'
    when 'SUPPLIER_PO' then 'purchases.read' when 'GOODS_RECEIPT' then 'purchases.read' end;
$$;

revoke all on function private.document_entity(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.document_entity_permission(text) from public, anon, authenticated;

create or replace function public.document_entity_search(p_entity_type text, p_term text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('documents.read');
  v_t       text := '%' || replace(replace(btrim(coalesce(p_term, '')), '%', ''), '_', '') || '%';
begin
  if private.document_entity_permission(p_entity_type) is null or not private.has_permission(v_company, private.document_entity_permission(p_entity_type)) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'reference', reference)) from (
    select p.id, p.sku || ' — ' || p.product_name as reference from public.products p where p_entity_type = 'PRODUCT' and p.company_id = v_company and (p.sku ilike v_t or p.product_name ilike v_t)
    union all select b.id, coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku from public.inventory_batches b join public.products p on p.id = b.product_id
      where p_entity_type = 'BATCH' and b.company_id = v_company and (b.batch_number ilike v_t or p.sku ilike v_t)
    union all select w.id, w.warehouse_code || ' — ' || w.warehouse_name from public.warehouses w where p_entity_type = 'WAREHOUSE' and w.company_id = v_company and (w.warehouse_code ilike v_t or w.warehouse_name ilike v_t)
    union all select o.id, o.production_order_number from public.production_orders o where p_entity_type = 'PRODUCTION_ORDER' and o.company_id = v_company and o.production_order_number ilike v_t
    union all select o.id, o.outsourcing_order_number || ' · ' || o.supplier_name from public.outsourcing_orders o where p_entity_type = 'OUTSOURCING_ORDER' and o.company_id = v_company and (o.outsourcing_order_number ilike v_t or o.supplier_name ilike v_t)
    union all select o.id, o.customer_po_number || ' (' || o.po_reference || ')' from public.customer_purchase_orders o where p_entity_type = 'CUSTOMER_PO' and o.company_id = v_company and o.is_current and (o.customer_po_number ilike v_t or o.po_reference ilike v_t)
    union all select s.id, s.sales_order_number || ' · ' || s.customer_name_snapshot from public.sales_orders s where p_entity_type = 'SALES_ORDER' and s.company_id = v_company and (s.sales_order_number ilike v_t or s.customer_name_snapshot ilike v_t)
    union all select f.id, f.fulfilment_number from public.fulfilments f where p_entity_type = 'DISPATCH' and f.company_id = v_company and f.fulfilment_number ilike v_t
    union all select i.id, coalesce(i.invoice_number, 'Draft') || ' · ' || i.customer_legal_name from public.sales_invoices i where p_entity_type = 'INVOICE' and i.company_id = v_company and i.status <> 'DISCARDED' and (i.invoice_number ilike v_t or i.customer_legal_name ilike v_t)
    union all select n.id, coalesce(n.note_number, 'Draft note') from public.invoice_adjustment_notes n where p_entity_type = 'ADJUSTMENT_NOTE' and n.company_id = v_company and n.status <> 'DISCARDED' and coalesce(n.note_number, '') ilike v_t
    union all select c.id, c.customer_code || ' — ' || c.customer_name from public.customers c where p_entity_type = 'CUSTOMER' and c.company_id = v_company and (c.customer_code ilike v_t or c.customer_name ilike v_t)
    union all select c.id, c.legal_name from public.companies c where p_entity_type = 'COMPANY' and c.id = v_company
    union all select o.id, o.po_number || ' · ' || o.supplier_name from public.purchase_orders o where p_entity_type = 'SUPPLIER_PO' and o.company_id = v_company and (o.po_number ilike v_t or o.supplier_name ilike v_t)
    union all select g.id, g.receipt_number from public.goods_receipts g where p_entity_type = 'GOODS_RECEIPT' and g.company_id = v_company and g.receipt_number ilike v_t
    limit 20) x), '[]'::jsonb);
end;
$$;

revoke all on function public.document_entity_search(text, text) from public, anon;
grant execute on function public.document_entity_search(text, text) to authenticated;

-- Documents of purged records block the standard reset (they are archived, never deleted).
create or replace function private.erp_reset_document_entity_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['BATCH', 'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER',
    'SUPPLIER_PO', 'GOODS_RECEIPT'];
$$;

revoke all on function private.erp_reset_document_entity_types() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 8. Party history: goods receipts valued for both kinds (same function as
-- 20261103090000 except the receipt value, which now covers direct receipts).
-- -----------------------------------------------------------------------------
create or replace function public.party_transactions(p_party_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('ledger.read');
  v_party   public.parties;
  v_c       uuid;
  v_s       uuid;
  v_tz      text := private.company_tz(v_company);
  v_rows    jsonb;
begin
  select * into v_party from public.parties where id = p_party_id and company_id = v_company;
  if not found then
    raise exception 'Party not found in your company.' using errcode = 'P0001';
  end if;
  if v_party.customer_id is not null and (private.has_permission(v_company, 'customers.read') or private.has_permission(v_company, 'invoices.read')
       or private.has_permission(v_company, 'payments.read')) then
    v_c := v_party.customer_id;
  end if;
  if v_party.supplier_id is not null and private.has_permission(v_company, 'suppliers.read') then
    v_s := v_party.supplier_id;
  end if;

  with t (entry_date, sort_at, kind, document, ref_id, description, status, amount, receivable, payable) as (
    select v_party.opening_balance_date, '-infinity'::timestamptz, 'OPENING', v_party.party_code, v_party.id,
      'Opening balance (' || lower(v_party.opening_balance_type) || ')', null::text, v_party.opening_balance,
      case when v_party.opening_balance_type = 'RECEIVABLE' and (v_c is not null) then v_party.opening_balance else 0 end,
      case when v_party.opening_balance_type = 'PAYABLE' and (v_s is not null) then v_party.opening_balance else 0 end
    where v_party.opening_balance > 0
    -- customer side
    union all
    select po_date, created_at, 'CUSTOMER_PO', customer_po_number, id, 'Customer purchase order received', status, null::numeric, 0::numeric, 0::numeric
    from public.customer_purchase_orders where v_c is not null and customer_id = v_c
    union all
    select order_date, created_at, 'SALES_ORDER', sales_order_number, id, 'Sales order', order_status, null, 0, 0
    from public.sales_orders where v_c is not null and customer_id = v_c
    union all
    select invoice_date, coalesce(issued_at, created_at), 'INVOICE', invoice_number, id,
      'Invoice' || coalesce(' · ' || order_references, '') || case when due_date is not null then ' · due ' || to_char(due_date, 'DD Mon YYYY') else '' end,
      status, grand_total, grand_total, 0
    from public.sales_invoices where v_c is not null and customer_id = v_c and status in ('ISSUED', 'CANCELLED')
    union all
    select (cancelled_at at time zone v_tz)::date, cancelled_at, 'INVOICE_CANCELLED', invoice_number, id, 'Invoice cancelled: ' || coalesce(cancellation_reason, ''),
      status, grand_total, -grand_total, 0
    from public.sales_invoices where v_c is not null and customer_id = v_c and status = 'CANCELLED'
    union all
    select note_date, coalesce(issued_at, created_at), case when note_type = 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, note_number, id,
      case when note_type = 'CREDIT' then 'Credit note' else 'Debit note' end || coalesce(': ' || reason, ''), status, total_amount,
      case when note_type = 'DEBIT' then total_amount else -total_amount end, 0
    from public.invoice_adjustment_notes where v_c is not null and customer_id = v_c and status in ('ISSUED', 'CANCELLED')
    union all
    select (cancelled_at at time zone v_tz)::date, cancelled_at, 'NOTE_CANCELLED', note_number, id, 'Note cancelled', status, total_amount,
      case when note_type = 'DEBIT' then -total_amount else total_amount end, 0
    from public.invoice_adjustment_notes where v_c is not null and customer_id = v_c and status = 'CANCELLED'
    union all
    select receipt_date, created_at, 'RECEIPT', receipt_number, id,
      'Payment received (' || lower(replace(payment_method, '_', ' ')) || coalesce(', ref ' || transaction_reference, '') || ')', status, amount_received, -amount_received, 0
    from public.customer_payments where v_c is not null and customer_id = v_c
    union all
    select (reversed_at at time zone v_tz)::date, reversed_at, 'RECEIPT_REVERSED', receipt_number, id, 'Receipt reversed: ' || coalesce(reversal_reason, ''),
      status, amount_received, amount_received, 0
    from public.customer_payments where v_c is not null and customer_id = v_c and status = 'REVERSED'
    -- supplier side
    union all
    select po_date, created_at, 'PURCHASE_ORDER', po_number, id, 'Purchase order (' || lower(replace(status, '_', ' ')) || ')', status, grand_total, 0, 0
    from public.purchase_orders where v_s is not null and supplier_id = v_s
    union all
    select r.receipt_date, r.created_at, 'GOODS_RECEIPT', r.receipt_number, r.id,
      case when r.purchase_order_id is null then 'Goods received without a purchase order' else 'Goods received' end || coalesce(' · supplier doc ' || r.supplier_document_number, ''), r.status, x.value, 0, x.value
    from public.goods_receipts r
    cross join lateral (select private.goods_receipt_value(r.id) as value) x

    where v_s is not null and r.supplier_id = v_s
    union all
    select (r.reversed_at at time zone v_tz)::date, r.reversed_at, 'GOODS_RECEIPT_REVERSED', r.receipt_number, r.id,
      'Goods receipt reversed: ' || coalesce(r.reversal_reason, ''), r.status, x.value, 0, -x.value
    from public.goods_receipts r
    cross join lateral (select private.goods_receipt_value(r.id) as value) x

    where v_s is not null and r.supplier_id = v_s and r.status = 'REVERSED'
    union all
    select payment_date, created_at, 'SUPPLIER_PAYMENT', payment_number, id,
      'Payment made (' || lower(replace(payment_method, '_', ' ')) || coalesce(', ref ' || reference, '') || ')', status, amount, 0, -amount
    from public.supplier_payments where v_s is not null and supplier_id = v_s
    union all
    select (reversed_at at time zone v_tz)::date, reversed_at, 'SUPPLIER_PAYMENT_REVERSED', payment_number, id, 'Payment reversed: ' || coalesce(reversal_reason, ''),
      status, amount, 0, amount
    from public.supplier_payments where v_s is not null and supplier_id = v_s and status = 'REVERSED'
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', s.entry_date, 'kind', s.kind, 'document', s.document, 'ref_id', s.ref_id,
      'description', s.description, 'status', s.status, 'amount', s.amount, 'receivable', s.receivable, 'payable', s.payable,
      'receivable_balance', s.rb, 'payable_balance', s.pb) order by s.seq desc), '[]'::jsonb)
  into v_rows
  -- seq: one total order (date, time, document, kind) so the running balances
  -- and the listed order always agree; the opening balance is first on its day.
  from (select t.*, sum(t.receivable) over w as rb, sum(t.payable) over w as pb, row_number() over w as seq from t
        window w as (order by t.entry_date, t.sort_at, t.document, t.kind rows unbounded preceding)) s;

  return jsonb_build_object('party_id', v_party.id, 'entries', v_rows,
    'customer_visible', v_c is not null, 'supplier_visible', v_s is not null, 'generated_at', now());
end;
$$;

revoke all on function public.party_transactions(uuid) from public, anon;
grant execute on function public.party_transactions(uuid) to authenticated;
