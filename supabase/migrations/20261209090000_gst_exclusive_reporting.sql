-- =============================================================================
-- GST-exclusive reporting for the dashboards (display only)
--
-- Adds read-only functions and views that report amounts excluding GST. Nothing here
-- changes a posted document, a ledger, a payable or receivable, a GST calculation or
-- the inventory valuation method; no existing function, view or table is replaced.
--
-- Rules (amount excl. GST = the document's taxable value; CGST, SGST and IGST left out;
-- the invoice / PO round-off, at most 1 rupee, is neither taxable value nor GST and is left out):
--   Purchase orders   taxable_total; still to receive: pending share of each line's taxable_value.
--   Goods received    per accepted line, mirroring how its payable was built:
--                       direct receipt          round(accepted x unit_cost, 2)   (unit_cost excl. GST)
--                       PO, price changed       round(accepted x unit_cost, 2)   (actual cost after discount)
--                       PO, price as ordered    accepted share of the order line's taxable_value
--   Sales orders      taxable_total (charges included, GST left out).
--   Invoices          taxable_subtotal; credit / debit notes use their own taxable_amount.
--   Stock value       unchanged: stock lots are already costed excluding GST.
--   Outstanding       Payments are recorded as one amount per invoice (customers) or per supplier,
--                     never split into taxable value and GST, so a GST-exclusive balance is
--                     reported only where no split is needed:
--                       nothing paid yet           -> the net taxable value still open (EXACT)
--                       fully settled (<= 0)       -> 0 (SETTLED)
--                       partly paid / opening bal. -> no figure; flagged for review (REVIEW)
--
-- Rollback: supabase/rollback/20261209090000_gst_exclusive_reporting_down.sql (drops only what
-- this file creates).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Goods receipt taxable value (the GST-exclusive twin of private.goods_receipt_value)
-- -----------------------------------------------------------------------------
create or replace function private.goods_receipt_taxable_value(p_receipt uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case
      when l.purchase_order_line_id is null then round(l.accepted_quantity * coalesce(l.unit_cost, 0), 2)
      when l.po_unit_price is not null and l.actual_unit_price is not null and l.actual_unit_price <> l.po_unit_price
        then round(l.accepted_quantity * coalesce(l.unit_cost, 0), 2)
      else coalesce(private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.taxable_value), 0) end), 0)
  from public.goods_receipt_lines l
  left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
  where l.goods_receipt_id = p_receipt;
$$;

revoke all on function private.goods_receipt_taxable_value(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Invoices with their GST-exclusive outstanding (drill-down source; RLS of the invoker applies)
-- -----------------------------------------------------------------------------
-- Built on the tables, not on public.sales_invoice_list (an earlier migration drops and re-creates that view):
-- the same columns as sales_invoice_list, then the GST-exclusive ones.
create or replace view public.sales_invoice_list_excl_gst
with (security_invoker = true) as
select i.*, x.credited, x.debited, x.paid,
  case when i.status = 'ISSUED' then i.grand_total - x.credited + x.debited - x.paid end as balance_due,
  case when i.status <> 'ISSUED' then null
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 'PAID'
       when x.paid > 0 then 'PARTIALLY_PAID' else 'UNPAID' end as payment_status,
  case when i.status <> 'ISSUED' then i.status
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 'PAID'
       when i.due_date < private.so_today() then 'OVERDUE'
       when x.paid > 0 then 'PARTIALLY_PAID' else 'ISSUED' end as display_status,
  case when i.status = 'ISSUED' and i.grand_total - x.credited + x.debited - x.paid > 0 and i.due_date < private.so_today()
       then private.so_today() - i.due_date end as days_overdue,
  (select count(*) from public.sales_invoice_lines l where l.invoice_id = i.id)::int as line_count,
  x.credited_taxable,
  x.debited_taxable,
  i.taxable_subtotal - x.credited_taxable + x.debited_taxable as net_taxable,
  case when i.status <> 'ISSUED' then null
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 0
       when x.paid = 0 then greatest(i.taxable_subtotal - x.credited_taxable + x.debited_taxable, 0) end as outstanding_excl_gst,
  case when i.status <> 'ISSUED' then null
       when i.grand_total - x.credited + x.debited - x.paid <= 0 then 'SETTLED'
       when x.paid = 0 then 'EXACT' else 'REVIEW' end as excl_gst_status
from public.sales_invoices i
cross join lateral (
  select
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0) as credited,
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0) as debited,
    coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.status = 'ACTIVE'), 0) as paid,
    coalesce((select sum(n.taxable_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0) as credited_taxable,
    coalesce((select sum(n.taxable_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0) as debited_taxable
) x;

revoke all on public.sales_invoice_list_excl_gst from anon, authenticated;
grant select on public.sales_invoice_list_excl_gst to authenticated;

-- Same figures for the security-definer dashboard function (company passed in, no RLS).
create or replace function private.invoice_excl_gst(p_company uuid)
returns table (invoice_id uuid, customer_id uuid, invoice_date date, due_date date, taxable numeric, gst numeric,
  balance_due numeric, outstanding_excl_gst numeric, excl_gst_status text, overdue boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.customer_id, i.invoice_date, i.due_date, i.taxable_subtotal, i.cgst_total + i.sgst_total + i.igst_total,
    x.balance,
    case when x.balance <= 0 then 0 when x.paid = 0 then greatest(i.taxable_subtotal - x.cn_taxable + x.dn_taxable, 0) end,
    case when x.balance <= 0 then 'SETTLED' when x.paid = 0 then 'EXACT' else 'REVIEW' end,
    x.balance > 0 and i.due_date < private.company_today(p_company)
  from public.sales_invoices i
  cross join lateral (
    select
      i.grand_total
        - coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0)
        + coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0)
        - coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.status = 'ACTIVE'), 0) as balance,
      coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.status = 'ACTIVE'), 0) as paid,
      coalesce((select sum(n.taxable_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0) as cn_taxable,
      coalesce((select sum(n.taxable_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0) as dn_taxable
  ) x
  where i.company_id = p_company and i.status = 'ISSUED';
$$;

revoke all on function private.invoice_excl_gst(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Party balances excluding GST (customers: ledger receivable; suppliers: goods received - payments)
-- -----------------------------------------------------------------------------
create or replace function private.party_balances_excl_gst(p_company uuid)
returns table (party_id uuid, customer_id uuid, supplier_id uuid,
  receivable numeric, receivable_excl_gst numeric, receivable_status text,
  payable numeric, payable_excl_gst numeric, payable_status text,
  grn_outstanding numeric, grn_outstanding_excl_gst numeric, grn_outstanding_status text)
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select pb.party_id, pb.customer_id, pb.supplier_id, pb.receivable, pb.payable, p.opening_balance, p.opening_balance_type,
      coalesce((select sum(amount_received) from public.customer_payments cp where cp.customer_id = pb.customer_id and cp.status = 'RECORDED'), 0) as cust_paid,
      coalesce((select sum(i.taxable_subtotal) from public.sales_invoices i where i.customer_id = pb.customer_id and i.status = 'ISSUED'), 0)
        + coalesce((select sum(case when n.note_type = 'DEBIT' then n.taxable_amount else -n.taxable_amount end) from public.invoice_adjustment_notes n
                    where n.customer_id = pb.customer_id and n.status = 'ISSUED'), 0) as cust_taxable,
      coalesce((select sum(amount) from public.supplier_payments sp where sp.supplier_id = pb.supplier_id and sp.status = 'RECORDED'), 0) as sup_paid,
      coalesce((select sum(private.goods_receipt_taxable_value(r.id)) from public.goods_receipts r where r.supplier_id = pb.supplier_id and r.status = 'POSTED'), 0) as sup_taxable,
      case when pb.supplier_id is not null then private.supplier_payable(pb.supplier_id) else 0 end as grn_payable
    from private.party_balances(p_company) pb
    join public.parties p on p.id = pb.party_id
  )
  select party_id, customer_id, supplier_id,
    receivable,
    case when receivable <= 0 then 0 when cust_paid = 0 and not (opening_balance_type = 'RECEIVABLE' and opening_balance > 0) then greatest(cust_taxable, 0) end,
    case when receivable <= 0 then 'SETTLED' when cust_paid = 0 and not (opening_balance_type = 'RECEIVABLE' and opening_balance > 0) then 'EXACT' else 'REVIEW' end,
    payable,
    case when payable <= 0 then 0 when sup_paid = 0 and not (opening_balance_type = 'PAYABLE' and opening_balance > 0) then greatest(sup_taxable, 0) end,
    case when payable <= 0 then 'SETTLED' when sup_paid = 0 and not (opening_balance_type = 'PAYABLE' and opening_balance > 0) then 'EXACT' else 'REVIEW' end,
    grn_payable,
    case when grn_payable <= 0 then 0 when sup_paid = 0 then greatest(sup_taxable, 0) end,
    case when grn_payable <= 0 then 'SETTLED' when sup_paid = 0 then 'EXACT' else 'REVIEW' end
  from b;
$$;

revoke all on function private.party_balances_excl_gst(uuid) from public, anon, authenticated;

-- Ledger drill-down rows: public.ledger_parties (same permissions and filters) with the GST-exclusive balances.
create or replace function public.ledger_parties_excl_gst(p_search text default null, p_type text default null, p_status text default null, p_party_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('ledger.read');
begin
  return coalesce((
    select jsonb_agg(to_jsonb(lp) || jsonb_build_object(
      'receivable_excl_gst', x.receivable_excl_gst, 'receivable_gst_status', x.receivable_status,
      'payable_excl_gst', x.payable_excl_gst, 'payable_gst_status', x.payable_status))
    from public.ledger_parties(p_search, p_type, p_status, p_party_id) lp
    left join private.party_balances_excl_gst(v_company) x on x.party_id = lp.party_id), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Purchase orders with the GST-exclusive value still to receive (drill-down source)
-- -----------------------------------------------------------------------------
create or replace view public.purchase_order_list_excl_gst
with (security_invoker = true) as
select v.*,
  coalesce((select sum(case when ll.line_type in ('GOODS', 'SERVICE') and ll.ordered_quantity > 0
                            then round(ll.pending_quantity / ll.ordered_quantity * ll.taxable_value, 2) else 0 end)
            from public.purchase_order_line_list ll where ll.purchase_order_id = v.id), 0) as pending_taxable_value
from public.purchase_order_list_v2 v;

revoke all on public.purchase_order_list_excl_gst from anon, authenticated;
grant select on public.purchase_order_list_excl_gst to authenticated;

create or replace function private.po_pending_taxable(p_company uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when ll.line_type in ('GOODS', 'SERVICE') and ll.ordered_quantity > 0
                           then round(ll.pending_quantity / ll.ordered_quantity * ll.taxable_value, 2) else 0 end), 0)
  from public.purchase_order_line_list ll join public.purchase_orders o on o.id = ll.purchase_order_id
  where o.company_id = p_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED');
$$;

revoke all on function private.po_pending_taxable(uuid) from public, anon, authenticated;

-- Sales order drill-down rows: public.sales_orders_v2_list (same permissions and filters) plus taxable_total.
create or replace function public.sales_orders_v2_list_excl_gst(p_from date default null, p_to date default null, p_customer_id uuid default null, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['sales_orders.read', 'fulfilment.read']);
begin
  return coalesce((
    select jsonb_agg(r || jsonb_build_object('taxable_total', so.taxable_total) order by ord)
    from jsonb_array_elements(coalesce(public.sales_orders_v2_list(p_from, p_to, p_customer_id, p_status), '[]'::jsonb)) with ordinality e(r, ord)
    left join public.sales_orders so on so.id = (r ->> 'id')::uuid and so.company_id = v_company), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Dashboard figures excluding GST
--   p_scope: MANAGEMENT / PURCHASE / GRN / SALES / BILLING / LEDGER; the filters mirror the
--   dashboard function each scope accompanies (management_overview, module_dashboard,
--   sales_dashboard, invoice_dashboard), and so do the permissions.
-- -----------------------------------------------------------------------------
create or replace function public.gst_exclusive_dashboard(p_scope text, p_from date, p_to date,
  p_customer_id uuid default null, p_status text default null, p_payment_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope   text := upper(coalesce(p_scope, ''));
  v_company uuid;
  v_today   date;
  v_month0  date;
  v_out     jsonb := '{}'::jsonb;
begin
  v_company := case v_scope
    when 'MANAGEMENT' then private.require_permission('dashboard.read')
    when 'PURCHASE' then private.require_permission('purchases.read')
    when 'GRN' then private.require_permission('purchases.read')
    when 'SALES' then private.require_any_permission(array['sales_orders.read', 'fulfilment.read'])
    when 'BILLING' then private.require_any_permission(array['invoices.read', 'billing_reports.read'])
    when 'LEDGER' then private.require_permission('ledger.read') end;
  if v_company is null then
    raise exception 'Unknown dashboard %.', p_scope using errcode = 'P0001';
  end if;
  if v_scope <> 'SALES' and (p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700) then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);
  v_month0 := (date_trunc('month', coalesce(p_to, v_today)::timestamp) - interval '11 months')::date;

  if v_scope in ('MANAGEMENT', 'PURCHASE', 'GRN') and (v_scope <> 'MANAGEMENT' or private.has_permission(v_company, 'purchases.read')) then
    v_out := v_out || jsonb_build_object('purchase', jsonb_build_object('available', true,
      'period_value', (select coalesce(sum(taxable_total), 0) from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
                         and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')),
      'outstanding_receipt_value', private.po_pending_taxable(v_company),
      'received_value', (select coalesce(sum(private.goods_receipt_taxable_value(r.id)), 0) from public.goods_receipts r
                           where r.company_id = v_company and r.status = 'POSTED' and r.receipt_date between p_from and p_to),
      'top_suppliers', coalesce((select jsonb_agg(jsonb_build_object('supplier', supplier_name, 'value', v, 'orders', n) order by v desc, supplier_name) from (
          select supplier_name, sum(taxable_total) v, count(*) n from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
            and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') group by 1 order by 2 desc, 1 limit 10) x), '[]'::jsonb),
      'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'ordered', o, 'received', r) order by m) from (
          select gs::date m,
            (select coalesce(sum(taxable_total), 0) from public.purchase_orders where company_id = v_company and date_trunc('month', po_date::timestamp) = gs
               and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')) o,
            (select coalesce(sum(private.goods_receipt_taxable_value(r.id)), 0) from public.goods_receipts r where r.company_id = v_company and r.status = 'POSTED'
               and date_trunc('month', r.receipt_date::timestamp) = gs) r
          from generate_series(v_month0::timestamp, date_trunc('month', p_to::timestamp), interval '1 month') gs) x), '[]'::jsonb)));
  elsif v_scope = 'MANAGEMENT' then
    v_out := v_out || jsonb_build_object('purchase', jsonb_build_object('available', false, 'reason', 'No purchase access.'));
  end if;

  if v_scope = 'SALES' or (v_scope = 'MANAGEMENT' and private.has_permission(v_company, 'sales_orders.read')) then
    v_out := v_out || jsonb_build_object('sales', (
      with f as (
        select so.id, so.order_date, so.created_at, so.taxable_total, so.order_status, private.so_v2_status(so.id) as v2
        from public.sales_orders so
        where so.company_id = v_company and (p_customer_id is null or so.customer_id = p_customer_id)
          and so.order_date between coalesce(p_from, date_trunc('month', v_today)::date) and coalesce(p_to, v_today))
      select jsonb_build_object('available', true,
        -- sales_dashboard.total_value basis (status filter, cancelled left out)
        'total_value', (select coalesce(sum(taxable_total), 0) from f where v2 <> 'CANCELLED' and (p_status is null or v2 = p_status)),
        -- management_overview basis (drafts and cancelled left out)
        'order_value', (select coalesce(sum(taxable_total), 0) from f where order_status not in ('DRAFT', 'CANCELLED')),
        'daily', coalesce((select jsonb_agg(jsonb_build_object('day', order_date, 'value', v, 'orders', n) order by order_date) from (
            select order_date, sum(taxable_total) v, count(*) n from f where order_status not in ('DRAFT', 'CANCELLED') group by order_date) x), '[]'::jsonb),
        'orders', coalesce((select jsonb_object_agg(id, taxable_total) from (
            select id, taxable_total from f where (p_status is null or v2 = p_status) order by created_at desc limit 50) x), '{}'::jsonb))));
  elsif v_scope = 'MANAGEMENT' then
    v_out := v_out || jsonb_build_object('sales', jsonb_build_object('available', false, 'reason', 'No sales order access.'));
  end if;

  if v_scope = 'BILLING' or (v_scope = 'MANAGEMENT' and private.has_permission(v_company, 'invoices.read')) then
    v_out := v_out || jsonb_build_object('invoicing', (
      with base as (
        select l.*, case when l.is_proforma then 'PROFORMA' when l.status in ('DRAFT', 'PENDING_APPROVAL') then 'DRAFT' else l.status end as inv_status,
          case when l.status <> 'ISSUED' then null when l.display_status = 'OVERDUE' then 'OVERDUE' else l.payment_status end as pay_status
        from public.sales_invoice_list_excl_gst l
        where l.company_id = v_company and l.status <> 'DISCARDED' and (p_customer_id is null or l.customer_id = p_customer_id)
      ),
      f as (select * from base where invoice_date between p_from and p_to
              and (p_status is null or inv_status = p_status) and (p_payment_status is null or pay_status = p_payment_status)),
      issued as (select * from f where status = 'ISSUED'),
      months as (select generate_series(date_trunc('month', (p_to - interval '11 months')::timestamp), date_trunc('month', p_to::timestamp), interval '1 month')::date as m)
      select jsonb_build_object('available', true,
        'taxable_value', (select coalesce(sum(taxable_subtotal), 0) from issued),
        'gst', (select coalesce(sum(cgst_total + sgst_total + igst_total), 0) from issued),
        'invoices', (select count(*) from issued),
        'outstanding_excl_gst', (select coalesce(sum(outstanding_excl_gst), 0) from issued where balance_due > 0),
        'outstanding_review', (select jsonb_build_object('count', count(*), 'balance', coalesce(sum(balance_due), 0)) from issued where balance_due > 0 and excl_gst_status = 'REVIEW'),
        'overdue_excl_gst', (select coalesce(sum(outstanding_excl_gst), 0) from issued where display_status = 'OVERDUE'),
        'overdue_review', (select jsonb_build_object('count', count(*), 'balance', coalesce(sum(balance_due), 0)) from issued where display_status = 'OVERDUE' and excl_gst_status = 'REVIEW'),
        'monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'taxable', tx, 'gst', gst, 'received', rec) order by m), '[]'::jsonb) from (
            select months.m,
              (select coalesce(sum(taxable_subtotal), 0) from base where status = 'ISSUED' and date_trunc('month', invoice_date::timestamp)::date = months.m) as tx,
              (select coalesce(sum(cgst_total + sgst_total + igst_total), 0) from base where status = 'ISSUED' and date_trunc('month', invoice_date::timestamp)::date = months.m) as gst,
              (select coalesce(sum(amount_received), 0) from public.customer_payments p where p.company_id = v_company and p.status = 'RECORDED'
                 and (p_customer_id is null or p.customer_id = p_customer_id) and date_trunc('month', p.receipt_date::timestamp)::date = months.m) as rec
            from months) x),
        -- Per invoice (recent and overdue lists of the dashboard): taxable value and GST-exclusive outstanding.
        'by_invoice', coalesce((select jsonb_object_agg(id, jsonb_build_object('taxable', taxable_subtotal, 'outstanding_excl_gst', outstanding_excl_gst, 'status', excl_gst_status)) from (
            select id, taxable_subtotal, outstanding_excl_gst, excl_gst_status from (select * from f order by created_at desc limit 10) a
            union select id, taxable_subtotal, outstanding_excl_gst, excl_gst_status from (select * from base where status = 'ISSUED' and display_status = 'OVERDUE' order by days_overdue desc limit 15) b) x), '{}'::jsonb))));
  elsif v_scope = 'MANAGEMENT' then
    v_out := v_out || jsonb_build_object('invoicing', jsonb_build_object('available', false, 'reason', 'No invoice access.'));
  end if;

  if v_scope = 'MANAGEMENT' then
    v_out := v_out || jsonb_build_object(
      'sales_invoiced', (select coalesce(sum(taxable_subtotal), 0) from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to),
      'invoices', (select count(*) from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to),
      'receivables', (select jsonb_build_object(
          'outstanding_excl_gst', coalesce(sum(outstanding_excl_gst) filter (where balance_due > 0), 0),
          'outstanding_incl_gst', coalesce(sum(balance_due) filter (where balance_due > 0), 0),
          'review_count', count(*) filter (where balance_due > 0 and excl_gst_status = 'REVIEW'),
          'review_balance', coalesce(sum(balance_due) filter (where balance_due > 0 and excl_gst_status = 'REVIEW'), 0))
        from private.invoice_excl_gst(v_company)),
      'payables', (select jsonb_build_object(
          'outstanding_excl_gst', coalesce(sum(grn_outstanding_excl_gst) filter (where grn_outstanding > 0), 0),
          'outstanding_incl_gst', coalesce(sum(grn_outstanding) filter (where grn_outstanding > 0), 0),
          'review_count', count(*) filter (where grn_outstanding > 0 and grn_outstanding_status = 'REVIEW'),
          'review_balance', coalesce(sum(grn_outstanding) filter (where grn_outstanding > 0 and grn_outstanding_status = 'REVIEW'), 0))
        from private.party_balances_excl_gst(v_company) where supplier_id is not null),
      -- Customer balances list: same customers and order as management_overview.invoicing.customer_outstanding.
      'customer_outstanding', case when private.has_permission(v_company, 'invoices.read') then coalesce((
          select jsonb_agg(jsonb_build_object('party_id', pb.party_id, 'outstanding_excl_gst', x.excl, 'overdue_excl_gst', x.overdue_excl,
            'review_invoices', x.review, 'review_balance', x.review_balance) order by pb.invoice_outstanding desc)
          from (select * from private.party_balances(v_company) where invoice_outstanding > 0 order by invoice_outstanding desc limit 10) pb
          cross join lateral (
            select coalesce(sum(e.outstanding_excl_gst) filter (where e.balance_due > 0), 0) as excl,
              coalesce(sum(e.outstanding_excl_gst) filter (where e.overdue), 0) as overdue_excl,
              count(*) filter (where e.balance_due > 0 and e.excl_gst_status = 'REVIEW') as review,
              coalesce(sum(e.balance_due) filter (where e.balance_due > 0 and e.excl_gst_status = 'REVIEW'), 0) as review_balance
            from private.invoice_excl_gst(v_company) e where e.customer_id = pb.customer_id) x), '[]'::jsonb) else '[]'::jsonb end);
  end if;

  if v_scope = 'LEDGER' then
    v_out := v_out || (
      with b as (select x.*, pt.is_customer, pt.is_supplier from private.party_balances_excl_gst(v_company) x join public.parties pt on pt.id = x.party_id)
      select jsonb_build_object(
        'receivables_excl_gst', coalesce(sum(receivable_excl_gst) filter (where receivable > 0), 0),
        'receivables_review', jsonb_build_object('count', count(*) filter (where receivable > 0 and receivable_status = 'REVIEW'),
                                                 'balance', coalesce(sum(receivable) filter (where receivable > 0 and receivable_status = 'REVIEW'), 0)),
        'payables_excl_gst', coalesce(sum(payable_excl_gst) filter (where payable > 0), 0),
        'payables_review', jsonb_build_object('count', count(*) filter (where payable > 0 and payable_status = 'REVIEW'),
                                              'balance', coalesce(sum(payable) filter (where payable > 0 and payable_status = 'REVIEW'), 0)),
        'by_party', coalesce(jsonb_object_agg(party_id, jsonb_build_object('receivable_excl_gst', receivable_excl_gst, 'receivable_status', receivable_status,
            'payable_excl_gst', payable_excl_gst, 'payable_status', payable_status)) filter (where receivable <> 0 or payable <> 0), '{}'::jsonb),
        'top_customers', coalesce((select jsonb_agg(jsonb_build_object('party_id', b2.party_id, 'invoiced', t.v) order by t.v desc) from (
            select customer_id, sum(taxable_subtotal) v from public.sales_invoices where company_id = v_company and status = 'ISSUED' and invoice_date between p_from and p_to
            group by customer_id order by 2 desc limit 8) t join b b2 on b2.customer_id = t.customer_id), '[]'::jsonb),
        'top_suppliers', coalesce((select jsonb_agg(jsonb_build_object('party_id', b2.party_id, 'received', t.v) order by t.v desc) from (
            select supplier_id, sum(private.goods_receipt_taxable_value(id)) v from public.goods_receipts where company_id = v_company and status = 'POSTED'
              and supplier_id is not null and receipt_date between p_from and p_to group by supplier_id order by 2 desc limit 8) t join b b2 on b2.supplier_id = t.supplier_id), '[]'::jsonb))
      from b);
  end if;

  return v_out || jsonb_build_object('scope', v_scope, 'basis', 'EXCL_GST', 'generated_at', now());
end;
$$;

revoke all on function public.gst_exclusive_dashboard(text, date, date, uuid, text, text), public.ledger_parties_excl_gst(text, text, text, uuid),
  public.sales_orders_v2_list_excl_gst(date, date, uuid, text) from public, anon;
grant execute on function public.gst_exclusive_dashboard(text, date, date, uuid, text, text), public.ledger_parties_excl_gst(text, text, text, uuid),
  public.sales_orders_v2_list_excl_gst(date, date, uuid, text) to authenticated;
