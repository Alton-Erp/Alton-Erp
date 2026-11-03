-- =============================================================================
-- ALTON ERP V2 — Stage 6: invoicing, GST, payments and Excel import
--
-- Built on the Phase 8 billing module (sales_invoices, sales_invoice_lines,
-- customer_payments, invoice_payment_allocations, invoice_adjustment_notes,
-- invoice_settings, billing_number_sequences). No new tables.
--
--   invoice sources   DISPATCH (Phase 8, unchanged), SALES_ORDER (ordered
--                     quantities, partial invoicing), MANUAL (no order), IMPORT
--   no double billing the quantity of a sales order line on live invoices is
--                     counted across ALL sources; dispatch invoicing is capped by
--                     what the order line has left to invoice
--   GST engine        tax-exclusive or tax-inclusive prices, line and invoice-level
--                     discounts, freight / packing / other charges, CGST+SGST or
--                     IGST from the place of supply, configurable rounding
--                     (nearest / up / down rupee); rates configurable in settings
--   proforma          a draft marked proforma with its own PFI number; never a
--                     tax invoice until converted and issued
--   one step          issue (no approval), credit / debit notes, payment against an
--                     invoice (excess stays as an advance), applying an advance
--   dashboard, Excel import (own invoice numbers; repeated uploads never duplicate)
--
-- Invoices never move stock. Issued documents stay immutable (Phase 8 guards).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns (additive)
-- -----------------------------------------------------------------------------
alter table public.sales_invoices add column if not exists source text not null default 'DISPATCH';
alter table public.sales_invoices add column if not exists sales_order_id uuid;
alter table public.sales_invoices add column if not exists is_proforma boolean not null default false;
alter table public.sales_invoices add column if not exists proforma_number text;
alter table public.sales_invoices add column if not exists pricing_mode text not null default 'EXCLUSIVE';
alter table public.sales_invoices add column if not exists invoice_discount_percent numeric(5,2);
alter table public.sales_invoices add column if not exists invoice_discount_amount numeric(16,2) not null default 0;
alter table public.sales_invoices add column if not exists invoice_discount_total numeric(16,2) not null default 0;
alter table public.sales_invoices add column if not exists transport_details text;
alter table public.sales_invoices add column if not exists vehicle_number text;
alter table public.sales_invoices add column if not exists eway_bill_number text;
alter table public.sales_invoices add column if not exists customer_pan text;

alter table public.sales_invoice_lines add column if not exists charge_kind text;
alter table public.sales_invoice_lines add column if not exists invoice_discount_share numeric(16,2) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_invoices_v2_check') then
    alter table public.sales_invoices add constraint sales_invoices_v2_check check (
      source in ('DISPATCH', 'SALES_ORDER', 'MANUAL', 'IMPORT') and pricing_mode in ('EXCLUSIVE', 'INCLUSIVE')
      and (invoice_discount_percent is null or invoice_discount_percent between 0 and 100) and invoice_discount_amount >= 0 and invoice_discount_total >= 0
      and (transport_details is null or length(transport_details) <= 200) and (vehicle_number is null or length(vehicle_number) <= 20)
      and (eway_bill_number is null or eway_bill_number ~ '^[0-9]{12}$') and (customer_pan is null or customer_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
      and (not is_proforma or status in ('DRAFT', 'DISCARDED')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_invoice_lines_v2_check') then
    alter table public.sales_invoice_lines add constraint sales_invoice_lines_v2_check check (
      (charge_kind is null or (line_type = 'CHARGE' and charge_kind in ('FREIGHT', 'PACKING', 'OTHER'))) and invoice_discount_share >= 0);
  end if;
end;
$$;
create unique index if not exists sales_invoices_proforma_unique on public.sales_invoices (company_id, proforma_number) where proforma_number is not null;
create index if not exists sales_invoices_so_idx on public.sales_invoices (sales_order_id) where sales_order_id is not null;
create index if not exists sales_invoice_lines_so_line_idx on public.sales_invoice_lines (sales_order_line_id) where sales_order_line_id is not null;

-- Product lines no longer need a dispatch line (sales-order and manual invoices);
-- tax-inclusive lines are not "gross - discount" so only the total rule stays.
alter table public.sales_invoice_lines drop constraint if exists sales_invoice_lines_source;
alter table public.sales_invoice_lines drop constraint if exists sales_invoice_lines_amounts;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_invoice_lines_source_v2') then
    alter table public.sales_invoice_lines add constraint sales_invoice_lines_source_v2 check (
      (line_type = 'PRODUCT') = (product_id is not null) and (fulfilment_line_id is null or line_type = 'PRODUCT'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_invoice_lines_amounts_v2') then
    alter table public.sales_invoice_lines add constraint sales_invoice_lines_amounts_v2 check (
      line_total = taxable_value + cgst_amount + sgst_amount + igst_amount and taxable_value >= 0);
  end if;
end;
$$;

-- Settings
alter table public.invoice_settings add column if not exists pricing_mode text not null default 'EXCLUSIVE' check (pricing_mode in ('EXCLUSIVE', 'INCLUSIVE'));
alter table public.invoice_settings add column if not exists rounding_mode text not null default 'NEAREST' check (rounding_mode in ('NEAREST', 'UP', 'DOWN'));
alter table public.invoice_settings add column if not exists gst_rates numeric[] not null default array[0, 5, 12, 18, 28]::numeric[];
alter table public.invoice_settings add column if not exists freight_sac text default '996511' check (freight_sac is null or freight_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');
alter table public.invoice_settings add column if not exists freight_gst_rate numeric(5,2) not null default 18 check (freight_gst_rate between 0 and 100);
alter table public.invoice_settings add column if not exists packing_sac text default '998540' check (packing_sac is null or packing_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');
alter table public.invoice_settings add column if not exists packing_gst_rate numeric(5,2) not null default 18 check (packing_gst_rate between 0 and 100);
alter table public.invoice_settings add column if not exists default_invoice_type text not null default 'TAX_INVOICE' check (default_invoice_type in ('TAX_INVOICE', 'PROFORMA'));
alter table public.invoice_settings add column if not exists invoice_date_format text not null default 'DD-MM-YYYY'
  check (invoice_date_format in ('DD-MM-YYYY', 'DD/MM/YYYY', 'DD MMM YYYY', 'YYYY-MM-DD'));
alter table public.invoice_settings add column if not exists default_payment_method text not null default 'BANK_TRANSFER'
  check (default_payment_method in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER'));
alter table public.invoice_settings add column if not exists bank_accounts jsonb not null default '[]'::jsonb check (jsonb_typeof(bank_accounts) = 'array');
alter table public.invoice_settings add column if not exists authorized_signatory text check (authorized_signatory is null or length(authorized_signatory) <= 120);
alter table public.invoice_settings add column if not exists invoice_template text not null default 'CLASSIC' check (invoice_template in ('CLASSIC', 'COMPACT'));
alter table public.invoice_settings add column if not exists show_logo boolean not null default true;
alter table public.invoice_settings alter column payment_methods set default array['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'OTHER'];

-- The invoice list shows i.*; rebuilt (same definition as Phase 8) to show the new columns.
drop view if exists public.sales_invoice_list;
create view public.sales_invoice_list
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
  (select count(*) from public.sales_invoice_lines l where l.invoice_id = i.id)::int as line_count
from public.sales_invoices i
cross join lateral (
  select
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'CREDIT'), 0) as credited,
    coalesce((select sum(n.total_amount) from public.invoice_adjustment_notes n where n.original_invoice_id = i.id and n.status = 'ISSUED' and n.note_type = 'DEBIT'), 0) as debited,
    coalesce((select sum(a.allocated_amount) from public.invoice_payment_allocations a where a.invoice_id = i.id and a.status = 'ACTIVE'), 0) as paid
) x;

revoke all on public.sales_invoice_list from anon, authenticated;
grant select on public.sales_invoice_list to authenticated;

-- Bulk Operations knows invoice imports.
alter table public.import_jobs drop constraint if exists import_jobs_import_type_check;
alter table public.import_jobs add constraint import_jobs_import_type_check
  check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO', 'SUPPLIER_PO', 'BOMS', 'PRODUCTION', 'SALES_ORDER', 'INVOICE'));

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'CUSTOMER_PO' then 'customer_po.import' when 'SUPPLIER_PO' then 'purchase_order.create'
    when 'BOMS' then 'production_bom.create' when 'PRODUCTION' then 'production_order.create'
    when 'SALES_ORDER' then 'sales_orders.create' when 'INVOICE' then 'invoices.create' end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Invoiced quantity of a sales order line (all sources, live invoices,
--    proforma drafts excluded) and the dispatch cap
-- -----------------------------------------------------------------------------
create or replace function private.so_line_invoiced(p_line uuid, p_exclude_invoice uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.quantity), 0)
  from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.invoice_id
  where l.sales_order_line_id = p_line and l.line_type = 'PRODUCT' and i.status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED') and not i.is_proforma
    and (p_exclude_invoice is null or i.id <> p_exclude_invoice);
$$;

create or replace function private.so_line_invoiceable(p_line uuid, p_exclude_invoice uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(sol.quantity_ordered - sol.quantity_cancelled - private.so_line_invoiced(sol.id, p_exclude_invoice), 0)
  from public.sales_order_lines sol where sol.id = p_line;
$$;

revoke all on function private.so_line_invoiced(uuid, uuid) from public, anon;
revoke all on function private.so_line_invoiceable(uuid, uuid) from public, anon;
grant execute on function private.so_line_invoiced(uuid, uuid), private.so_line_invoiceable(uuid, uuid) to authenticated;

-- Phase 8 rule unchanged, additionally capped by what the order line has left
-- to invoice (so dispatch and sales-order invoices never bill the same quantity).
create or replace function private.dispatch_line_invoiceable(p_fulfilment_line uuid, p_exclude_invoice uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(least(
    case when (select billing_basis from public.invoice_settings where company_id = fl.company_id) = 'DELIVERY' then fl.quantity_delivered else fl.quantity_dispatched end
    - coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id), 0)
    - private.dispatch_line_invoiced(fl.id, p_exclude_invoice),
    sol.quantity_ordered - sol.quantity_cancelled - private.so_line_invoiced(sol.id, p_exclude_invoice)), 0)
  from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
  join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
  where fl.id = p_fulfilment_line and f.actual_dispatch_at is not null;
$$;

revoke all on function private.dispatch_line_invoiceable(uuid, uuid) from public, anon;
grant execute on function private.dispatch_line_invoiceable(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. GST engine (replaces the Phase 8 calculation; identical results for
--    tax-exclusive invoices without an invoice-level discount)
--   gross        = round(qty x rate, 2)
--   line disc.   = round(gross x % / 100, 2) or the amount (never above gross)
--   invoice disc.= % or amount of the products' net value, shared by value
--                  (the rounding remainder goes to the largest line)
--   exclusive:   taxable = net; CGST = SGST = round(taxable x rate/2 / 100, 2); IGST = round(taxable x rate / 100, 2)
--   inclusive:   taxable = round(net x 100 / (100 + rate), 2); tax = net - taxable
--                (intra: CGST = round(tax / 2, 2), SGST = the rest)
--   charges are always tax-exclusive at their own rate
--   grand total  = sum of line totals, rounded to the rupee (nearest / up / down) when enabled
-- -----------------------------------------------------------------------------
create or replace function private.invoice_recalculate(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv       public.sales_invoices;
  v_s         public.invoice_settings;
  v_treatment text;
  v_net_total numeric;
  v_hd        numeric;
  v_rest      numeric;
  v_top       uuid;
  v_sum       numeric;
  v_grand     numeric;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice;
  v_s := private.billing_settings(v_inv.company_id);
  v_treatment := case
    when not v_s.gst_registered or v_inv.supply_category = 'NON_GST' then 'NONE'
    when v_inv.customer_registration_type = 'SEZ' or v_inv.place_of_supply_state_code = '96' then 'INTER_STATE'
    when v_inv.seller_state_code is null or v_inv.place_of_supply_state_code is null then 'UNRESOLVED'
    when v_inv.seller_state_code = v_inv.place_of_supply_state_code then 'INTRA_STATE'
    else 'INTER_STATE' end;

  -- Line gross and line discount.
  update public.sales_invoice_lines l set gross_amount = x.gross, discount_amount = x.discount, invoice_discount_share = 0
  from (
    select id, round(quantity * coalesce(unit_price, 0), 2) as gross,
      least(case when discount_percent > 0 then round(round(quantity * coalesce(unit_price, 0), 2) * discount_percent / 100, 2) else discount_amount end,
            round(quantity * coalesce(unit_price, 0), 2)) as discount
    from public.sales_invoice_lines where invoice_id = p_invoice
  ) x
  where l.id = x.id;

  -- Invoice-level discount, shared over the product lines by net value.
  select coalesce(sum(gross_amount - discount_amount), 0) into v_net_total
  from public.sales_invoice_lines where invoice_id = p_invoice and line_type = 'PRODUCT';
  v_hd := case when coalesce(v_inv.invoice_discount_percent, 0) > 0 then round(v_net_total * v_inv.invoice_discount_percent / 100, 2)
               else least(coalesce(v_inv.invoice_discount_amount, 0), v_net_total) end;
  if v_hd > 0 and v_net_total > 0 then
    update public.sales_invoice_lines set invoice_discount_share = round(v_hd * (gross_amount - discount_amount) / v_net_total, 2)
    where invoice_id = p_invoice and line_type = 'PRODUCT';
    select v_hd - coalesce(sum(invoice_discount_share), 0) into v_rest from public.sales_invoice_lines where invoice_id = p_invoice and line_type = 'PRODUCT';
    if v_rest <> 0 then
      select id into v_top from public.sales_invoice_lines where invoice_id = p_invoice and line_type = 'PRODUCT'
      order by gross_amount - discount_amount desc, line_no limit 1;
      update public.sales_invoice_lines set invoice_discount_share = greatest(invoice_discount_share + v_rest, 0) where id = v_top;
    end if;
  else
    v_hd := 0;
  end if;

  -- Tax
  update public.sales_invoice_lines l set
    taxable_value = t.taxable, cgst_rate = t.half_rate, sgst_rate = t.half_rate, igst_rate = t.igst_rate,
    cgst_amount = t.cgst, sgst_amount = t.sgst, igst_amount = t.igst, line_total = t.taxable + t.cgst + t.sgst + t.igst
  from (
    select id, half_rate, igst_rate, taxable,
      case when inclusive then (case when half_rate > 0 then round((net - taxable) / 2, 2) else 0 end) else round(taxable * half_rate / 100, 2) end as cgst,
      case when inclusive then (case when half_rate > 0 then net - taxable - round((net - taxable) / 2, 2) else 0 end) else round(taxable * half_rate / 100, 2) end as sgst,
      case when inclusive then (case when igst_rate > 0 then net - taxable else 0 end) else round(taxable * igst_rate / 100, 2) end as igst
    from (
      select id, net, half_rate, igst_rate, inclusive,
        case when inclusive then round(net * 100 / (100 + 2 * half_rate + igst_rate), 2) else net end as taxable
      from (
        select id, greatest(gross_amount - discount_amount - invoice_discount_share, 0) as net,
          (v_inv.pricing_mode = 'INCLUSIVE' and line_type = 'PRODUCT') as inclusive,
          case when v_inv.supply_category = 'TAXABLE' and v_treatment = 'INTRA_STATE' and gst_rate is not null then gst_rate / 2 else 0 end as half_rate,
          case when v_inv.supply_category = 'TAXABLE' and v_treatment = 'INTER_STATE' and gst_rate is not null then gst_rate else 0 end as igst_rate
        from public.sales_invoice_lines where invoice_id = p_invoice
      ) a
    ) b
  ) t
  where l.id = t.id;

  select coalesce(sum(line_total), 0) into v_sum from public.sales_invoice_lines where invoice_id = p_invoice;
  v_grand := case when not v_s.round_off_enabled then v_sum
                  when v_s.rounding_mode = 'UP' then ceil(v_sum)
                  when v_s.rounding_mode = 'DOWN' then floor(v_sum)
                  else round(v_sum, 0) end;
  update public.sales_invoices i set
    tax_treatment = v_treatment,
    invoice_type = case when v_inv.supply_category in ('TAXABLE', 'ZERO_RATED') and v_s.gst_registered then 'TAX_INVOICE' else 'BILL_OF_SUPPLY' end,
    gross_total = t.gross, discount_total = t.discount, invoice_discount_total = v_hd, taxable_subtotal = t.taxable, other_charges_total = t.charges,
    cgst_total = t.cgst, sgst_total = t.sgst, igst_total = t.igst, round_off = v_grand - v_sum, grand_total = v_grand,
    updated_by = auth.uid()
  from (
    select coalesce(sum(gross_amount), 0) as gross, coalesce(sum(discount_amount + invoice_discount_share), 0) as discount,
      coalesce(sum(taxable_value), 0) as taxable, coalesce(sum(taxable_value) filter (where line_type = 'CHARGE'), 0) as charges,
      coalesce(sum(cgst_amount), 0) as cgst, coalesce(sum(sgst_amount), 0) as sgst, coalesce(sum(igst_amount), 0) as igst
    from public.sales_invoice_lines where invoice_id = p_invoice
  ) t
  where i.id = p_invoice;
end;
$$;

revoke all on function private.invoice_recalculate(uuid) from public, anon, authenticated;

-- Validation (Phase 8 checks; quantity checks per source; transport fields).
create or replace function private.invoice_issues(p_invoice uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv    public.sales_invoices;
  v_s      public.invoice_settings;
  v_issues jsonb := '[]'::jsonb;
  v_line   record;
  v_today  date;
  v_last   date;
  v_avail  numeric;
  v_here   numeric;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice;
  select * into v_s from public.invoice_settings where company_id = v_inv.company_id;
  if not found then
    raise exception 'Invoice settings are missing.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_inv.company_id);
  if v_inv.seller_address is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SELLER_ADDRESS', 'message', 'Company registered address is missing (Company Settings).');
  end if;
  if v_s.gst_registered and v_inv.seller_gstin is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SELLER_GSTIN', 'message', 'Company GSTIN is missing (Company Settings), or mark the company as not GST-registered in Invoice Settings.');
  end if;
  if v_inv.customer_billing_address is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_ADDRESS', 'message', 'Customer billing address is missing.');
  end if;
  if v_inv.customer_registration_type is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_GST_TYPE', 'message', 'Customer GST registration type is not set (Ledger / Customers).');
  elsif v_inv.customer_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') and v_inv.customer_gstin is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_GSTIN', 'message', 'Customer is registered but has no GSTIN.');
  end if;
  if v_inv.place_of_supply_state_code is null or private.gst_state_name(v_inv.place_of_supply_state_code) is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'PLACE_OF_SUPPLY', 'message', 'Choose a valid place of supply.');
  end if;
  if v_inv.tax_treatment = 'UNRESOLVED' then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'TAX_TREATMENT', 'message', 'Tax treatment cannot be determined (seller GSTIN state or place of supply missing).');
  end if;
  if v_inv.supply_category <> 'TAXABLE' then
    if not (v_inv.supply_category = any(v_s.allowed_special_categories)) then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SUPPLY_CATEGORY', 'message',
        format('Supply category %s is not enabled in Invoice Settings.', lower(replace(v_inv.supply_category, '_', ' '))));
    elsif v_inv.special_category_reason is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SUPPLY_REASON', 'message', 'Record the basis for the exempt / zero-rated / non-GST treatment.');
    else
      v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SPECIAL_CATEGORY', 'message', 'Exempt / zero-rated / non-GST supply: confirm the treatment.');
    end if;
  end if;
  if v_inv.customer_registration_type in ('SEZ', 'OVERSEAS') then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SEZ_EXPORT', 'message', 'SEZ / overseas supply: confirm the treatment (LUT, with or without payment of IGST).');
  end if;
  if v_inv.customer_registration_type in ('REGISTERED', 'COMPOSITION') and v_inv.customer_gstin is not null and v_inv.place_of_supply_state_code is not null
     and left(v_inv.customer_gstin, 2) <> v_inv.place_of_supply_state_code then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'POS_DIFFERS', 'message', 'Place of supply differs from the customer''s GSTIN state; confirm it.');
  end if;
  if v_inv.customer_shipping_state_code is not null and v_inv.place_of_supply_state_code is not null
     and v_inv.customer_shipping_state_code <> v_inv.place_of_supply_state_code then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SHIP_STATE', 'message', 'Shipping state differs from the place of supply (bill-to / ship-to); confirm the place of supply.');
  end if;
  select max((f.actual_dispatch_at at time zone private.company_tz(v_inv.company_id))::date) into v_last
  from public.sales_invoice_lines l join public.fulfilment_lines fl on fl.id = l.fulfilment_line_id join public.fulfilments f on f.id = fl.fulfilment_id
  where l.invoice_id = p_invoice;
  if v_inv.invoice_date > v_today then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'INVOICE_DATE', 'message', 'The invoice date cannot be in the future.');
  end if;
  if v_last is not null and v_inv.invoice_date < v_last then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'INVOICE_DATE_BEFORE_DISPATCH', 'message', format('The invoice date is before the last dispatch (%s).', v_last));
  end if;
  if not exists (select 1 from public.sales_invoice_lines where invoice_id = p_invoice and line_type = 'PRODUCT') then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'NO_LINES', 'message',
      case when v_inv.source = 'DISPATCH' then 'The invoice has no dispatched product lines.' else 'The invoice has no product lines.' end);
  end if;
  for v_line in select * from public.sales_invoice_lines where invoice_id = p_invoice order by line_no loop
    if v_line.unit_price is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'PRICE', 'line_no', v_line.line_no, 'message', format('Line %s (%s): enter the unit price.', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_s.gst_registered and v_inv.supply_category <> 'NON_GST' and v_line.hsn_sac is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'HSN', 'line_no', v_line.line_no, 'message',
        format('Line %s (%s): HSN/SAC code is missing%s.', v_line.line_no, coalesce(v_line.sku, v_line.description),
          case when v_line.line_type = 'CHARGE' then ' (charge SAC in Invoice Settings)' else ' (Product Master or the line)' end));
    end if;
    if v_inv.supply_category = 'TAXABLE' and v_s.gst_registered and v_line.gst_rate is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'GST_RATE', 'line_no', v_line.line_no, 'message', format('Line %s (%s): GST rate is missing.', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_line.line_type = 'PRODUCT' and v_line.fulfilment_line_id is not null then
      v_avail := coalesce(private.dispatch_line_invoiceable(v_line.fulfilment_line_id, p_invoice), 0);
      if v_line.quantity > v_avail then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'QUANTITY', 'line_no', v_line.line_no,
          'message', format('Line %s (%s): only %s is still invoiceable from this dispatch.', v_line.line_no, v_line.sku, v_avail));
      end if;
    elsif v_line.line_type = 'PRODUCT' and v_line.sales_order_line_id is not null and not v_inv.is_proforma then
      v_avail := coalesce(private.so_line_invoiceable(v_line.sales_order_line_id, p_invoice), 0);
      select coalesce(sum(quantity), 0) into v_here from public.sales_invoice_lines
      where invoice_id = p_invoice and sales_order_line_id = v_line.sales_order_line_id and line_no <= v_line.line_no;
      if v_here > v_avail then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'QUANTITY', 'line_no', v_line.line_no,
          'message', format('Line %s (%s): only %s of the sales order line is still to be invoiced.', v_line.line_no, v_line.sku, trim_scale(v_avail)));
      end if;
    end if;
  end loop;
  return v_issues;
end;
$$;

revoke all on function private.invoice_issues(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Create / edit a manual or sales-order invoice (draft or proforma)
-- p_header: {customer_id, sales_order_id, invoice_date, due_date | payment_terms_days,
--            place_of_supply_state_code, supply_category, special_category_reason,
--            billing_address, shipping_address, customer_gstin, customer_pan,
--            transport_details, vehicle_number, eway_bill_number, notes (remarks),
--            internal_notes, pricing_mode, invoice_discount_percent,
--            invoice_discount_amount, is_proforma}
-- p_lines:  [{product_id, sales_order_line_id?, description, hsn_sac, quantity, unit,
--             unit_price, discount_percent, discount_amount, gst_rate}]
-- p_charges:{freight, packing, other}
-- -----------------------------------------------------------------------------
create or replace function private.inv_num(p jsonb, p_key text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(btrim(replace(coalesce(p ->> p_key, ''), '%', '')), '')::numeric;
exception when others then
  raise exception '% must be a number.', p_label using errcode = 'P0001';
end;
$$;

revoke all on function private.inv_num(jsonb, text, text) from public, anon, authenticated;

create or replace function public.sales_invoice_v2_save(p_invoice_id uuid, p_header jsonb, p_lines jsonb, p_charges jsonb default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('invoices.create');
  v_h        jsonb := coalesce(p_header, '{}'::jsonb);
  v_s        public.invoice_settings := private.billing_settings(v_company);
  v_prev     jsonb;
  v_inv      public.sales_invoices;
  v_old      public.sales_invoices;
  v_cust     public.customers;
  v_so       public.sales_orders;
  v_cid      uuid;
  v_so_id    uuid;
  v_entry    jsonb;
  v_no       int := 0;
  v_prod     public.products;
  v_sol      public.sales_order_lines;
  v_qty      numeric;
  v_price    numeric;
  v_pct      numeric;
  v_amt      numeric;
  v_gst      numeric;
  v_hsn      text;
  v_desc     text;
  v_date     date;
  v_due      date;
  v_days     int;
  v_pm       text;
  v_hd_pct   numeric;
  v_hd_amt   numeric;
  v_kind     text;
  v_ch       numeric;
  v_new      boolean := p_invoice_id is null;
  v_changed  boolean := false;
  v_proforma boolean;
  v_avail    numeric;
  v_gstin    text;
  v_pan      text;
  v_result   jsonb;
begin
  if v_new then
    v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_v2_save');
    if v_prev is not null then return v_prev; end if;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 500 then
    raise exception 'Add between 1 and 500 products.' using errcode = 'P0001';
  end if;
  begin
    v_cid := nullif(v_h ->> 'customer_id', '')::uuid;
    v_so_id := nullif(v_h ->> 'sales_order_id', '')::uuid;
    v_date := nullif(v_h ->> 'invoice_date', '')::date;
    v_due := nullif(v_h ->> 'due_date', '')::date;
    v_days := nullif(v_h ->> 'payment_terms_days', '')::int;
  exception when others then
    raise exception 'Enter a valid customer, invoice date, due date and payment terms.' using errcode = 'P0001';
  end;

  if not v_new then
    v_inv := private.lock_invoice(v_company, p_invoice_id);
    v_old := v_inv;
    if v_inv.status <> 'DRAFT' then
      raise exception 'Only draft invoices can be edited (this one is %). Use a credit or debit note, or cancel it.', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
    end if;
    if v_inv.source = 'DISPATCH' then
      raise exception 'This draft was created from dispatches; edit it on the dispatch invoice screen.' using errcode = 'P0001';
    end if;
    v_cid := coalesce(v_cid, v_inv.customer_id);
    v_so_id := case when v_h ? 'sales_order_id' then v_so_id else v_inv.sales_order_id end;
    v_date := coalesce(v_date, v_inv.invoice_date);
  end if;

  if v_so_id is not null then
    select * into v_so from public.sales_orders where id = v_so_id and company_id = v_company;
    if not found then
      raise exception 'Sales order not found in your company.' using errcode = 'P0001';
    end if;
    if v_so.customer_id is null then
      raise exception 'Sales order % has no customer record.', v_so.sales_order_number using errcode = 'P0001';
    end if;
    if v_cid is not null and v_cid <> v_so.customer_id then
      raise exception 'Sales order % belongs to another customer.', v_so.sales_order_number using errcode = 'P0001';
    end if;
    v_cid := v_so.customer_id;
    perform 1 from public.sales_order_lines where sales_order_id = v_so.id order by id for update;
  end if;
  select * into v_cust from public.customers where id = v_cid and company_id = v_company;
  if not found then
    raise exception 'Choose the customer.' using errcode = 'P0001';
  end if;
  if v_cust.status <> 'ACTIVE' then
    raise exception 'Customer % is inactive.', v_cust.customer_code using errcode = 'P0001';
  end if;
  v_date := coalesce(v_date, private.company_today(v_company));
  if v_due is not null then
    v_days := v_due - v_date;
  end if;
  v_days := coalesce(v_days, case when not v_new and v_old.customer_id = v_cust.id then v_old.payment_terms_days end, v_cust.payment_terms_days, v_s.default_payment_terms_days);
  if v_days < 0 or v_days > 365 then
    raise exception 'The due date must be on or after the invoice date and within 365 days.' using errcode = 'P0001';
  end if;
  v_pm := upper(coalesce(nullif(v_h ->> 'pricing_mode', ''), v_old.pricing_mode, v_s.pricing_mode));
  if v_pm not in ('EXCLUSIVE', 'INCLUSIVE') then
    raise exception 'Prices are either tax-exclusive or tax-inclusive.' using errcode = 'P0001';
  end if;
  v_hd_pct := private.inv_num(v_h, 'invoice_discount_percent', 'Invoice discount %');
  v_hd_amt := coalesce(private.inv_num(v_h, 'invoice_discount_amount', 'Invoice discount amount'), 0);
  if v_hd_pct is not null and (v_hd_pct < 0 or v_hd_pct > 100) or v_hd_amt < 0 or v_hd_amt <> round(v_hd_amt, 2) then
    raise exception 'The invoice discount must be 0-100 %% or an amount of zero or more.' using errcode = 'P0001';
  end if;
  if coalesce(v_hd_pct, 0) > 0 and v_hd_amt > 0 then
    raise exception 'Give the invoice discount as a percentage or an amount, not both.' using errcode = 'P0001';
  end if;
  v_proforma := coalesce((v_h ->> 'is_proforma')::boolean, v_old.is_proforma, v_s.default_invoice_type = 'PROFORMA');
  v_gstin := case when v_h ? 'customer_gstin' then nullif(upper(btrim(coalesce(v_h ->> 'customer_gstin', ''))), '') end;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'Customer GSTIN % is not a valid GSTIN.', v_gstin using errcode = 'P0001';
  end if;
  v_pan := case when v_h ? 'customer_pan' then nullif(upper(btrim(coalesce(v_h ->> 'customer_pan', ''))), '') end;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'Customer PAN % is not valid (e.g. ABCDE1234F).', v_pan using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(v_h ->> 'eway_bill_number', '')), '') is not null and btrim(v_h ->> 'eway_bill_number') !~ '^[0-9]{12}$' then
    raise exception 'An e-way bill number has 12 digits.' using errcode = 'P0001';
  end if;

  if v_new then
    insert into public.sales_invoices (company_id, invoice_date, payment_terms_days, due_date, customer_id, customer_code_snapshot, customer_legal_name,
      seller_legal_name, currency, created_by, updated_by, source, sales_order_id)
    values (v_company, v_date, v_days, v_date + v_days, v_cust.id, v_cust.customer_code, coalesce(v_cust.legal_name, v_cust.customer_name), '-',
      (select currency_code from public.companies where id = v_company), auth.uid(), auth.uid(),
      case when v_so_id is not null then 'SALES_ORDER' else coalesce(nullif(v_h ->> 'source', ''), 'MANUAL') end, v_so_id)
    returning * into v_inv;
  else
    v_changed := v_inv.customer_id <> v_cust.id;
    update public.sales_invoices set customer_id = v_cust.id, sales_order_id = v_so_id,
      source = case when v_so_id is not null then 'SALES_ORDER' when source = 'IMPORT' then 'IMPORT' else 'MANUAL' end
    where id = v_inv.id;
    delete from public.sales_invoice_lines where invoice_id = v_inv.id;
  end if;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    v_sol := null;
    select * into v_prod from public.products where id = nullif(v_entry ->> 'product_id', '')::uuid and company_id = v_company and archived_at is null;
    if not found or v_prod.status <> 'ACTIVE' then
      raise exception 'Line %: choose an active product (or add it to the Product Master).', v_no using errcode = 'P0001';
    end if;
    if nullif(v_entry ->> 'sales_order_line_id', '') is not null then
      select * into v_sol from public.sales_order_lines where id = (v_entry ->> 'sales_order_line_id')::uuid and sales_order_id = v_so_id;
      if not found then
        raise exception 'Line %: the sales order line does not belong to the selected sales order.', v_no using errcode = 'P0001';
      end if;
      if v_sol.product_id <> v_prod.id then
        raise exception 'Line %: the product differs from the sales order line (%).', v_no, v_sol.sku_snapshot using errcode = 'P0001';
      end if;
    end if;
    v_qty := private.inv_num(v_entry, 'quantity', format('Line %s quantity', v_no));
    v_price := private.inv_num(v_entry, 'unit_price', format('Line %s rate', v_no));
    v_pct := private.inv_num(v_entry, 'discount_percent', format('Line %s discount %%', v_no));
    v_amt := private.inv_num(v_entry, 'discount_amount', format('Line %s discount amount', v_no));
    v_gst := private.inv_num(v_entry, 'gst_rate', format('Line %s GST rate', v_no));
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Line % (%): quantity must be greater than zero (up to 3 decimals).', v_no, v_prod.sku using errcode = 'P0001';
    end if;
    if private.is_whole_unit(v_prod.base_unit) and v_qty <> trunc(v_qty) then
      raise exception 'Line % (%): % is counted in whole pieces.', v_no, v_prod.sku, v_prod.base_unit using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(v_entry ->> 'unit', '')), '') is not null and upper(btrim(v_entry ->> 'unit')) <> v_prod.base_unit then
      raise exception 'Line % (%): unit % does not match the product unit %.', v_no, v_prod.sku, upper(btrim(v_entry ->> 'unit')), v_prod.base_unit using errcode = 'P0001';
    end if;
    v_price := coalesce(v_price, v_sol.unit_price_snapshot, v_prod.selling_price);
    if v_price is not null and (v_price < 0 or v_price <> round(v_price, 2)) then
      raise exception 'Line % (%): the rate must be zero or more with at most 2 decimals.', v_no, v_prod.sku using errcode = 'P0001';
    end if;
    if v_pct is null and v_amt is null and v_sol.id is not null then
      v_pct := v_sol.discount_percent;
      v_amt := case when v_sol.discount_percent is null and v_sol.discount_amount > 0 and v_sol.quantity_ordered > 0
                    then round(v_sol.discount_amount * v_qty / (v_sol.quantity_ordered - v_sol.quantity_cancelled), 2) end;
    end if;
    if coalesce(v_pct, 0) < 0 or coalesce(v_pct, 0) > 100 or coalesce(v_amt, 0) < 0 or (coalesce(v_pct, 0) > 0 and coalesce(v_amt, 0) > 0) then
      raise exception 'Line %: give either a discount percentage (0-100) or an amount, not both.', v_no using errcode = 'P0001';
    end if;
    v_gst := coalesce(v_gst, v_sol.gst_rate, v_prod.gst_rate);
    if v_gst is not null and (v_gst < 0 or v_gst > 100) then
      raise exception 'Line %: the GST rate must be between 0 and 100.', v_no using errcode = 'P0001';
    end if;
    v_hsn := coalesce(nullif(btrim(coalesce(v_entry ->> 'hsn_sac', '')), ''), v_prod.hsn_code);
    if v_hsn is not null and v_hsn !~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' then
      raise exception 'Line % (%): HSN/SAC must be 4, 6 or 8 digits.', v_no, v_prod.sku using errcode = 'P0001';
    end if;
    v_desc := coalesce(nullif(btrim(coalesce(v_entry ->> 'description', '')), ''), v_prod.product_name);
    if length(v_desc) > 500 then
      raise exception 'Line %: the description is limited to 500 characters.', v_no using errcode = 'P0001';
    end if;
    if v_sol.id is not null and not v_proforma then
      v_avail := private.so_line_invoiceable(v_sol.id, v_inv.id)
        - coalesce((select sum(quantity) from public.sales_invoice_lines where invoice_id = v_inv.id and sales_order_line_id = v_sol.id), 0);
      if v_qty > v_avail then
        raise exception 'Line % (%): only % % of the sales order line is left to invoice (already on other invoices).', v_no, v_prod.sku, trim_scale(greatest(v_avail, 0)), v_prod.base_unit
          using errcode = 'P0001';
      end if;
    end if;
    insert into public.sales_invoice_lines (company_id, invoice_id, line_no, line_type, product_id, sales_order_id, sales_order_line_id, sku, description, hsn_sac,
      unit, quantity, unit_price, discount_percent, discount_amount, gst_rate)
    values (v_company, v_inv.id, v_no, 'PRODUCT', v_prod.id, case when v_sol.id is not null then v_so_id end, v_sol.id, v_prod.sku, v_desc, v_hsn,
      v_prod.base_unit, v_qty, v_price, coalesce(v_pct, 0), case when coalesce(v_pct, 0) > 0 then 0 else round(coalesce(v_amt, 0), 2) end, v_gst);
  end loop;

  foreach v_kind in array array['FREIGHT', 'PACKING', 'OTHER'] loop
    v_ch := coalesce(private.inv_num(coalesce(p_charges, '{}'::jsonb), lower(v_kind), initcap(lower(v_kind)) || ' charges'), 0);
    if v_ch < 0 or v_ch <> round(v_ch, 2) then
      raise exception '% charges must be zero or more with at most 2 decimals.', initcap(lower(v_kind)) using errcode = 'P0001';
    end if;
    continue when v_ch = 0;
    v_no := v_no + 1;
    insert into public.sales_invoice_lines (company_id, invoice_id, line_no, line_type, charge_kind, description, hsn_sac, quantity, unit_price, gst_rate)
    values (v_company, v_inv.id, v_no, 'CHARGE', v_kind,
      case v_kind when 'FREIGHT' then 'Freight charges' when 'PACKING' then 'Packing charges' else coalesce(v_s.other_charge_label, 'Other charges') end,
      case v_kind when 'FREIGHT' then v_s.freight_sac when 'PACKING' then v_s.packing_sac else v_s.other_charge_sac end,
      1, v_ch, case v_kind when 'FREIGHT' then v_s.freight_gst_rate when 'PACKING' then v_s.packing_gst_rate else coalesce(v_s.other_charge_gst_rate, 18) end);
  end loop;

  perform private.invoice_refresh_snapshots(v_inv.id, v_new or v_changed);
  update public.sales_invoices set
    pricing_mode = v_pm, invoice_discount_percent = v_hd_pct, invoice_discount_amount = case when coalesce(v_hd_pct, 0) > 0 then 0 else v_hd_amt end,
    is_proforma = v_proforma,
    proforma_number = case when v_proforma then coalesce(proforma_number, private.next_document_number(v_company, 'PFI')) else proforma_number end,
    customer_billing_address = case when v_h ? 'billing_address' then nullif(btrim(coalesce(v_h ->> 'billing_address', '')), '')
                                    when not v_new and not v_changed then v_old.customer_billing_address else customer_billing_address end,
    customer_shipping_address = case when v_h ? 'shipping_address' then nullif(btrim(coalesce(v_h ->> 'shipping_address', '')), '')
                                     when not v_new and not v_changed then v_old.customer_shipping_address else customer_shipping_address end,
    customer_gstin = case when v_h ? 'customer_gstin' then coalesce(v_gstin, customer_gstin) when not v_new and not v_changed then v_old.customer_gstin else customer_gstin end,
    customer_pan = case when v_h ? 'customer_pan' then v_pan when not v_new and not v_changed then v_old.customer_pan else coalesce(v_cust.pan, customer_pan) end,
    transport_details = case when v_h ? 'transport_details' then nullif(btrim(coalesce(v_h ->> 'transport_details', '')), '') else transport_details end,
    vehicle_number = case when v_h ? 'vehicle_number' then nullif(upper(btrim(coalesce(v_h ->> 'vehicle_number', ''))), '') else vehicle_number end,
    eway_bill_number = case when v_h ? 'eway_bill_number' then nullif(btrim(coalesce(v_h ->> 'eway_bill_number', '')), '') else eway_bill_number end
  where id = v_inv.id;
  select * into v_inv from public.sales_invoices where id = v_inv.id;
  perform private.invoice_apply_header(v_inv, (v_h - 'due_date') || jsonb_build_object('invoice_date', v_date, 'payment_terms_days', v_days));
  perform private.invoice_recalculate(v_inv.id);
  perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, case when v_new then 'DRAFT_CREATED' else 'DRAFT_UPDATED' end, null, 'DRAFT', null,
    jsonb_build_object('source', (select source from public.sales_invoices where id = v_inv.id), 'lines', v_no, 'proforma', v_proforma,
      'previous_total', v_old.grand_total, 'header', v_h - 'notes'));
  select * into v_inv from public.sales_invoices where id = v_inv.id;
  v_result := jsonb_build_object('invoice_id', v_inv.id, 'status', v_inv.status, 'is_proforma', v_inv.is_proforma, 'proforma_number', v_inv.proforma_number,
    'grand_total', v_inv.grand_total, 'issues', private.invoice_issues(v_inv.id));
  if v_new then
    return private.idempotency_finish(v_company, p_idempotency_key, v_result);
  end if;
  return v_result;
end;
$$;

-- Sales order lines with what is already invoiced and what is left.
create or replace function public.sales_order_invoice_lines(p_so_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['invoices.create', 'invoices.read']);
  v_so      public.sales_orders;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('sales_order_id', v_so.id, 'sales_order_number', v_so.sales_order_number, 'customer_id', v_so.customer_id,
    'customer_name', v_so.customer_name_snapshot, 'customer_reference', coalesce(v_so.customer_reference, v_so.customer_po_number),
    'payment_terms', v_so.payment_terms, 'billing_address', v_so.billing_address_snapshot, 'shipping_address', v_so.shipping_address_snapshot,
    'freight_amount', v_so.freight_amount, 'other_charges_amount', v_so.other_charges_amount,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sales_order_line_id', l.id, 'line_no', l.line_no, 'product_id', l.product_id, 'sku', l.sku_snapshot,
        'product_name', l.product_name_snapshot, 'description', coalesce(l.description, l.product_name_snapshot), 'unit', l.unit, 'hsn_code', p.hsn_code,
        'ordered', l.quantity_ordered - l.quantity_cancelled, 'dispatched', l.quantity_dispatched, 'invoiced', private.so_line_invoiced(l.id),
        'pending', private.so_line_invoiceable(l.id), 'unit_price', coalesce(l.unit_price_snapshot, p.selling_price),
        'discount_percent', l.discount_percent, 'gst_rate', coalesce(l.gst_rate, p.gst_rate)) order by l.line_no)
      from public.sales_order_lines l join public.products p on p.id = l.product_id where l.sales_order_id = v_so.id), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Issue in one step (no approval; review points are confirmed by issuing)
-- -----------------------------------------------------------------------------
create or replace function private.invoice_v2_issue_core(p_company uuid, p_invoice uuid, p_number text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv    public.sales_invoices;
  v_s      public.invoice_settings := private.billing_settings(p_company);
  v_issues jsonb;
  v_number jsonb;
  v_fy     text;
  v_seq    bigint;
  v_reviews text;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice for update;
  if v_inv.status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Invoice is already %.', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
  end if;
  if v_inv.is_proforma then
    raise exception 'This is a proforma invoice (%). Convert it to a tax invoice to issue it.', v_inv.proforma_number using errcode = 'P0001';
  end if;
  perform 1 from public.fulfilment_lines where id in (select fulfilment_line_id from public.sales_invoice_lines where invoice_id = v_inv.id and fulfilment_line_id is not null)
  order by id for update;
  perform 1 from public.sales_order_lines where id in (select sales_order_line_id from public.sales_invoice_lines where invoice_id = v_inv.id and sales_order_line_id is not null)
  order by id for update;
  perform private.invoice_recalculate(v_inv.id);
  select * into v_inv from public.sales_invoices where id = v_inv.id;
  v_issues := private.invoice_issues(v_inv.id);
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
    raise exception 'The invoice cannot be issued: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK')
      using errcode = 'P0001';
  end if;
  if v_inv.grand_total <= 0 then
    raise exception 'The invoice total must be greater than zero.' using errcode = 'P0001';
  end if;
  select string_agg(i ->> 'message', ' ') into v_reviews from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'REVIEW';
  if v_reviews is not null and v_inv.tax_review_at is null then
    update public.sales_invoices set tax_review_note = left('Confirmed when issuing: ' || v_reviews, 1000), tax_review_by = auth.uid(), tax_review_at = now()
    where id = v_inv.id;
    perform private.log_billing_event(p_company, 'INVOICE', v_inv.id, v_inv.id, 'TAX_REVIEW_CONFIRMED', v_inv.status, v_inv.status, v_reviews);
  end if;

  if p_number is null then
    v_number := private.next_billing_number(p_company, 'INVOICE', v_inv.invoice_date);
  else
    -- Imported number: kept as given; if it is in this company's own series, the
    -- counter is moved past it so the series never issues it again.
    if exists (select 1 from public.sales_invoices where company_id = p_company and invoice_number = p_number) then
      raise exception 'Invoice number % already exists.', p_number using errcode = 'P0001';
    end if;
    v_fy := private.financial_year(v_inv.invoice_date, v_s.fy_start_month);
    v_seq := nullif(substring(p_number from '([0-9]+)$'), '')::bigint;
    if v_seq is not null and private.format_billing_number(v_s, 'INVOICE', v_fy, v_seq) = p_number then
      insert into public.billing_number_sequences (company_id, scope, last_value)
      values (p_company, 'INVOICE:' || v_s.invoice_prefix || case when v_s.include_fy_in_number then ':' || v_fy else '' end, v_seq)
      on conflict (company_id, scope) do update set last_value = greatest(public.billing_number_sequences.last_value, excluded.last_value);
    end if;
    v_number := jsonb_build_object('number', p_number, 'scope', 'IMPORTED', 'financial_year', v_fy);
  end if;
  update public.sales_invoices set
    status = 'ISSUED', invoice_number = v_number ->> 'number', numbering_scope = v_number ->> 'scope', financial_year = v_number ->> 'financial_year',
    due_date = invoice_date + payment_terms_days, issued_by = auth.uid(), issued_at = now(),
    terms_snapshot = v_s.terms_text, footer_snapshot = v_s.footer_text,
    bank_snapshot = case when v_s.show_bank_details then jsonb_build_object('account_name', v_s.bank_account_name, 'bank_name', v_s.bank_name,
      'account_number', v_s.bank_account_number, 'ifsc', v_s.bank_ifsc, 'branch', v_s.bank_branch) end
  where id = v_inv.id;
  perform private.log_billing_event(p_company, 'INVOICE', v_inv.id, v_inv.id, 'ISSUED', v_inv.status, 'ISSUED', null,
    jsonb_build_object('invoice_number', v_number ->> 'number', 'grand_total', v_inv.grand_total, 'source', v_inv.source, 'review_confirmed', v_reviews));
  return jsonb_build_object('invoice_id', v_inv.id, 'invoice_number', v_number ->> 'number', 'financial_year', v_number ->> 'financial_year',
    'grand_total', v_inv.grand_total, 'warnings', case when v_reviews is null then '[]'::jsonb else jsonb_build_array(v_reviews) end);
end;
$$;

revoke all on function private.invoice_v2_issue_core(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.sales_invoice_v2_issue(p_invoice_id uuid, p_convert_proforma boolean default false, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.issue');
  v_prev    jsonb;
  v_inv     public.sales_invoices;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_v2_issue');
  if v_prev is not null then return v_prev; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.is_proforma and coalesce(p_convert_proforma, false) then
    update public.sales_invoices set is_proforma = false where id = v_inv.id;
    perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'PROFORMA_CONVERTED', 'DRAFT', 'DRAFT', null,
      jsonb_build_object('proforma_number', v_inv.proforma_number));
  end if;
  return private.idempotency_finish(v_company, p_idempotency_key, private.invoice_v2_issue_core(v_company, v_inv.id, null));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Payments against an invoice
-- p_payment: {receipt_date, amount, payment_method, transaction_reference,
--             bank_reference (bank account), notes, confirm_duplicate}
-- -----------------------------------------------------------------------------
create or replace function public.invoice_v2_record_payment(p_invoice_id uuid, p_payment jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('payments.manage');
  v_prev    jsonb;
  v_inv     public.sales_invoices;
  v_p       jsonb := coalesce(p_payment, '{}'::jsonb);
  v_amount  numeric;
  v_balance numeric;
  v_alloc   numeric;
  v_res     jsonb;
  v_dup     text;
  v_warn    jsonb := '[]'::jsonb;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'invoice_v2_record_payment');
  if v_prev is not null then return v_prev; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.status <> 'ISSUED' then
    raise exception 'Payments are recorded against issued invoices (this one is %).', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
  end if;
  v_amount := private.inv_num(v_p, 'amount', 'The amount');
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'The amount received must be greater than zero with at most 2 decimals.' using errcode = 'P0001';
  end if;
  v_balance := private.invoice_balance(v_inv.id);
  if v_balance <= 0 then
    raise exception 'Invoice % is already fully paid.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  -- The same amount on the same day by the same method without a reference looks like a double entry.
  if nullif(btrim(coalesce(v_p ->> 'transaction_reference', '')), '') is null and not coalesce((v_p ->> 'confirm_duplicate')::boolean, false) then
    select p.receipt_number into v_dup from public.customer_payments p join public.invoice_payment_allocations a on a.payment_id = p.id and a.status = 'ACTIVE'
    where a.invoice_id = v_inv.id and p.status = 'RECORDED' and p.amount_received = v_amount
      and p.receipt_date = coalesce(nullif(v_p ->> 'receipt_date', '')::date, private.company_today(v_company))
      and p.payment_method = upper(coalesce(v_p ->> 'payment_method', '')) limit 1;
    if v_dup is not null then
      raise exception 'Receipt % already records % on that date by the same method for this invoice. If this is a second payment, add its reference or confirm it as a separate payment.',
        v_dup, v_amount using errcode = 'P0001';
    end if;
  end if;
  v_alloc := least(v_amount, v_balance);
  v_res := public.customer_payment_record(
    (v_p - 'confirm_duplicate') || jsonb_build_object('customer_id', v_inv.customer_id, 'amount', v_amount),
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', v_alloc)), gen_random_uuid());
  if v_amount > v_alloc then
    v_warn := v_warn || to_jsonb(format('%s is more than the balance; %s is kept as an advance on the customer''s account.', v_amount, v_amount - v_alloc));
  end if;
  return private.idempotency_finish(v_company, p_idempotency_key, v_res || jsonb_build_object('allocated', v_alloc, 'advance', v_amount - v_alloc,
    'balance_due', private.invoice_balance(v_inv.id), 'warnings', v_warn));
end;
$$;

-- Applies an advance (unallocated receipt of the same customer) to an invoice.
create or replace function public.invoice_v2_apply_advance(p_invoice_id uuid, p_payment_id uuid, p_amount numeric default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('payments.manage');
  v_prev    jsonb;
  v_pay     public.customer_payments;
  v_inv     public.sales_invoices;
  v_amount  numeric;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'invoice_v2_apply_advance');
  if v_prev is not null then return v_prev; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  select * into v_pay from public.customer_payments where id = p_payment_id and company_id = v_company for update;
  if not found or v_pay.status <> 'RECORDED' then
    raise exception 'The receipt was not found or is reversed.' using errcode = 'P0001';
  end if;
  v_amount := coalesce(p_amount, least(v_pay.amount_received - private.payment_allocated(v_pay.id), private.invoice_balance(v_inv.id)));
  if v_amount <= 0 then
    raise exception 'Nothing to apply: the receipt has no unallocated amount or the invoice is paid.' using errcode = 'P0001';
  end if;
  perform private.allocate_payment(v_company, v_pay, v_inv.id, v_amount);
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('applied', v_amount, 'balance_due', private.invoice_balance(v_inv.id),
    'receipt_number', v_pay.receipt_number, 'unallocated', v_pay.amount_received - private.payment_allocated(v_pay.id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Credit / debit note in one step (create, confirm review points, issue)
-- -----------------------------------------------------------------------------
create or replace function public.adjustment_note_v2_issue(p_invoice_id uuid, p_type text, p_header jsonb, p_lines jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoice_adjustments.issue');
  v_prev    jsonb;
  v_res     jsonb;
  v_id      uuid;
  v_reviews text;
  v_out     jsonb;
begin
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'adjustment_note_v2_issue');
  if v_prev is not null then return v_prev; end if;
  if (private.billing_settings(v_company)).require_approval then
    raise exception 'Invoice Settings require approval for notes; switch it off for the single-operator flow.' using errcode = 'P0001';
  end if;
  v_res := public.adjustment_note_create(p_invoice_id, p_type, p_header, p_lines, gen_random_uuid());
  v_id := (v_res ->> 'note_id')::uuid;
  select string_agg(i ->> 'message', ' ') into v_reviews from jsonb_array_elements(v_res -> 'issues') i where i ->> 'severity' = 'REVIEW';
  if v_reviews is not null then
    update public.invoice_adjustment_notes set tax_review_note = left('Confirmed when issuing: ' || v_reviews, 1000), tax_review_by = auth.uid(), tax_review_at = now()
    where id = v_id;
  end if;
  v_out := public.adjustment_note_issue(v_id, gen_random_uuid());
  return private.idempotency_finish(v_company, p_idempotency_key, v_out || jsonb_build_object('note_type', p_type,
    'balance_due', private.invoice_balance(p_invoice_id), 'review_confirmed', v_reviews));
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Settings (Phase 8 update plus the new fields)
-- -----------------------------------------------------------------------------
create or replace function public.billing_settings_update(p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('billing_settings.manage');
  v_old     public.invoice_settings := private.billing_settings(v_company);
  v_new     public.invoice_settings;
  v_key     text;
  v_fy      text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'Nothing to change.' using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key in ('company_id', 'e_invoice_status', 'updated_by', 'updated_at') then
      raise exception 'Setting % cannot be changed here.', v_key using errcode = 'P0001';
    end if;
  end loop;
  begin
    v_new := jsonb_populate_record(v_old, p_changes);
  exception when others then
    raise exception 'Invalid setting value: %', sqlerrm using errcode = 'P0001';
  end;
  v_new.seller_pan := nullif(upper(btrim(coalesce(v_new.seller_pan, ''))), '');
  v_new.invoice_prefix := upper(btrim(v_new.invoice_prefix));
  v_new.credit_note_prefix := upper(btrim(v_new.credit_note_prefix));
  v_new.debit_note_prefix := upper(btrim(v_new.debit_note_prefix));
  v_new.receipt_prefix := upper(btrim(v_new.receipt_prefix));
  v_new.bank_ifsc := nullif(upper(btrim(coalesce(v_new.bank_ifsc, ''))), '');
  v_new.bank_account_number := nullif(upper(regexp_replace(coalesce(v_new.bank_account_number, ''), '\s', '', 'g')), '');
  v_fy := private.financial_year(private.company_today(v_company), v_new.fy_start_month);
  if length(private.format_billing_number(v_new, 'INVOICE', v_fy, 1)) > 16 or length(private.format_billing_number(v_new, 'CREDIT_NOTE', v_fy, 1)) > 16
     or length(private.format_billing_number(v_new, 'DEBIT_NOTE', v_fy, 1)) > 16 then
    raise exception 'Invoice / note numbers would exceed 16 characters (e.g. %). Shorten the prefix or padding.', private.format_billing_number(v_new, 'INVOICE', v_fy, 1)
      using errcode = 'P0001';
  end if;
  if cardinality(v_new.gst_rates) = 0 or exists (select 1 from unnest(v_new.gst_rates) r where r < 0 or r > 100 or r <> round(r, 2)) then
    raise exception 'GST rates must be between 0 and 100 (up to 2 decimals).' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_new.bank_accounts) b
             where coalesce(b ->> 'account_number', '') !~ '^[0-9A-Z]{6,34}$' or coalesce(b ->> 'ifsc', '') !~ '^[A-Z]{4}0[A-Z0-9]{6}$') then
    raise exception 'Each bank account needs an account number (6-34 letters or digits) and a valid IFSC.' using errcode = 'P0001';
  end if;
  update public.invoice_settings set
    gst_registered = v_new.gst_registered, seller_pan = v_new.seller_pan, invoice_prefix = v_new.invoice_prefix, credit_note_prefix = v_new.credit_note_prefix,
    debit_note_prefix = v_new.debit_note_prefix, receipt_prefix = v_new.receipt_prefix, include_fy_in_number = v_new.include_fy_in_number,
    number_padding = v_new.number_padding, fy_start_month = v_new.fy_start_month, default_payment_terms_days = v_new.default_payment_terms_days,
    billing_basis = v_new.billing_basis, allow_partial_dispatch_invoicing = v_new.allow_partial_dispatch_invoicing, allow_line_discount = v_new.allow_line_discount,
    require_approval = v_new.require_approval, round_off_enabled = v_new.round_off_enabled, other_charge_enabled = v_new.other_charge_enabled,
    other_charge_label = v_new.other_charge_label, other_charge_sac = v_new.other_charge_sac, other_charge_gst_rate = v_new.other_charge_gst_rate,
    allowed_special_categories = v_new.allowed_special_categories, payment_methods = v_new.payment_methods, terms_text = v_new.terms_text,
    footer_text = v_new.footer_text, bank_account_name = v_new.bank_account_name, bank_name = v_new.bank_name, bank_account_number = v_new.bank_account_number,
    bank_ifsc = v_new.bank_ifsc, bank_branch = v_new.bank_branch, show_bank_details = v_new.show_bank_details,
    pricing_mode = v_new.pricing_mode, rounding_mode = v_new.rounding_mode, gst_rates = v_new.gst_rates, freight_sac = v_new.freight_sac,
    freight_gst_rate = v_new.freight_gst_rate, packing_sac = v_new.packing_sac, packing_gst_rate = v_new.packing_gst_rate,
    default_invoice_type = v_new.default_invoice_type, invoice_date_format = v_new.invoice_date_format, default_payment_method = v_new.default_payment_method,
    bank_accounts = v_new.bank_accounts, authorized_signatory = nullif(btrim(coalesce(v_new.authorized_signatory, '')), ''),
    invoice_template = v_new.invoice_template, show_logo = v_new.show_logo,
    updated_by = auth.uid(), updated_at = now()
  where company_id = v_company;
  if cardinality(v_new.payment_methods) = 0 or not (v_new.payment_methods <@ array['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER']) then
    raise exception 'Choose at least one payment method from the supported list.' using errcode = 'P0001';
  end if;
  if not (v_new.default_payment_method = any(v_new.payment_methods)) then
    raise exception 'The default payment method must be one of the enabled methods.' using errcode = 'P0001';
  end if;
  perform private.log_billing_event(v_company, 'SETTINGS', null, null, 'UPDATED', null, null, null, jsonb_build_object('changes', p_changes));
  return public.billing_settings_get();
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Invoice dashboard
-- -----------------------------------------------------------------------------
create or replace function public.invoice_dashboard(p_from date, p_to date, p_customer_id uuid default null, p_invoice_status text default null, p_payment_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['invoices.read', 'billing_reports.read']);
  v_today   date := private.company_today(v_company);
  v_tz      text := private.company_tz(v_company);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3700 then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  return (
    with base as (
      select l.*, case when l.is_proforma then 'PROFORMA' when l.status in ('DRAFT', 'PENDING_APPROVAL') then 'DRAFT' else l.status end as inv_status,
        case when l.status <> 'ISSUED' then null when l.display_status = 'OVERDUE' then 'OVERDUE' else l.payment_status end as pay_status
      from public.sales_invoice_list l
      where l.company_id = v_company and l.status <> 'DISCARDED' and (p_customer_id is null or l.customer_id = p_customer_id)
    ),
    f as (select * from base where invoice_date between p_from and p_to
            and (p_invoice_status is null or inv_status = p_invoice_status) and (p_payment_status is null or pay_status = p_payment_status)),
    issued as (select * from f where status = 'ISSUED'),
    months as (select generate_series(date_trunc('month', (p_to - interval '11 months')::timestamp), date_trunc('month', p_to::timestamp), interval '1 month')::date as m)
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'today', v_today, 'currency', (select currency_code from public.companies where id = v_company),
      'total_invoices', (select count(*) from issued),
      'created_today', (select count(*) from base where (created_at at time zone v_tz)::date = v_today),
      'this_month', (select count(*) from base where status = 'ISSUED' and invoice_date >= date_trunc('month', v_today)::date and invoice_date <= v_today),
      'total_value', (select coalesce(sum(grand_total), 0) from issued),
      'taxable_value', (select coalesce(sum(taxable_subtotal), 0) from issued),
      'gst_collected', (select coalesce(sum(cgst_total + sgst_total + igst_total), 0) from issued),
      'amount_received', (select coalesce(sum(paid), 0) from issued),
      'outstanding', (select coalesce(sum(balance_due), 0) from issued where balance_due > 0),
      'overdue_amount', (select coalesce(sum(balance_due), 0) from issued where display_status = 'OVERDUE'),
      'partially_paid', (select count(*) from issued where payment_status = 'PARTIALLY_PAID'),
      'fully_paid', (select count(*) from issued where payment_status = 'PAID'),
      'drafts', (select count(*) from f where inv_status = 'DRAFT'),
      'proforma', (select count(*) from f where inv_status = 'PROFORMA'),
      'cancelled', (select count(*) from f where status = 'CANCELLED'),
      'recent', (select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) from (
          select jsonb_build_object('id', id, 'invoice_number', coalesce(invoice_number, proforma_number), 'invoice_date', invoice_date, 'customer_name', customer_legal_name,
            'grand_total', grand_total, 'balance_due', balance_due, 'status', inv_status, 'payment_status', pay_status, 'created_at', created_at) as r
          from f order by created_at desc limit 10) z),
      'overdue', (select coalesce(jsonb_agg(r order by (r ->> 'days_overdue')::int desc), '[]'::jsonb) from (
          select jsonb_build_object('id', id, 'invoice_number', invoice_number, 'customer_name', customer_legal_name, 'due_date', due_date,
            'balance_due', balance_due, 'days_overdue', days_overdue) as r
          from base where status = 'ISSUED' and display_status = 'OVERDUE' order by days_overdue desc limit 15) z),
      'monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'invoiced', inv, 'received', rec, 'gst', gst) order by m), '[]'::jsonb) from (
          select months.m,
            (select coalesce(sum(grand_total), 0) from base where status = 'ISSUED' and date_trunc('month', invoice_date::timestamp)::date = months.m) as inv,
            (select coalesce(sum(cgst_total + sgst_total + igst_total), 0) from base where status = 'ISSUED' and date_trunc('month', invoice_date::timestamp)::date = months.m) as gst,
            (select coalesce(sum(amount_received), 0) from public.customer_payments p where p.company_id = v_company and p.status = 'RECORDED'
               and (p_customer_id is null or p.customer_id = p_customer_id) and date_trunc('month', p.receipt_date::timestamp)::date = months.m) as rec
          from months) x),
      'gst_summary', (select coalesce(jsonb_agg(g order by (g ->> 'gst_rate')::numeric nulls first), '[]'::jsonb) from (
          select jsonb_build_object('gst_rate', il.gst_rate, 'taxable', sum(il.taxable_value), 'cgst', sum(il.cgst_amount), 'sgst', sum(il.sgst_amount),
            'igst', sum(il.igst_amount), 'tax', sum(il.cgst_amount + il.sgst_amount + il.igst_amount), 'lines', count(*)) as g
          from public.sales_invoice_lines il join issued i on i.id = il.invoice_id group by il.gst_rate) z),
      'hsn_summary', (select coalesce(jsonb_agg(g order by g ->> 'hsn_sac'), '[]'::jsonb) from (
          select jsonb_build_object('hsn_sac', coalesce(il.hsn_sac, '—'), 'gst_rate', il.gst_rate, 'taxable', sum(il.taxable_value),
            'tax', sum(il.cgst_amount + il.sgst_amount + il.igst_amount)) as g
          from public.sales_invoice_lines il join issued i on i.id = il.invoice_id group by il.hsn_sac, il.gst_rate) z)
    )
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Excel import (invoices with their own numbers)
-- p_rows: [{row_number, invoice_number, invoice_date, due_date, customer_name,
--           customer_gstin, sales_order_number, sku, product_name, hsn_code, quantity,
--           unit, rate, discount, gst_rate, place_of_supply, payment_terms, remarks}]
-- Rows with the same invoice number form one invoice; an invoice with any bad
-- row is held back. An invoice number that already exists is reported and never
-- imported again.
-- -----------------------------------------------------------------------------
create or replace function private.invoice_import_check(p_company uuid, p_rows jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s       public.invoice_settings := private.billing_settings(p_company);
  v_row     jsonb;
  v_rows    jsonb := '[]'::jsonb;
  v_err     text[];
  v_warn    text[];
  v_cust    public.customers;
  v_prod    public.products;
  v_so      public.sales_orders;
  v_sol     public.sales_order_lines;
  v_txt     text;
  v_num     text;
  v_date    date;
  v_due     date;
  v_qty     numeric;
  v_rate    numeric;
  v_disc    numeric;
  v_gst     numeric;
  v_pos     text;
  v_terms   int;
  v_used    jsonb := '{}'::jsonb;
  v_left    numeric;
  v_groups  jsonb := '[]'::jsonb;
  v_g       record;
  v_gerr    text[];
  v_gwarn   text[];
  v_total   numeric;
  v_line    jsonb;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_err := '{}'; v_warn := '{}'; v_cust := null; v_prod := null; v_so := null; v_sol := null;
    v_date := null; v_due := null; v_qty := null; v_rate := null; v_disc := null; v_gst := null; v_pos := null; v_terms := null;
    v_num := upper(nullif(btrim(coalesce(v_row ->> 'invoice_number', '')), ''));
    if v_num is null then
      v_err := v_err || 'Invoice Number is required (rows with the same number form one invoice).'::text;
    elsif v_num !~ '^[A-Z0-9/-]{1,16}$' then
      v_err := v_err || format('Invoice Number "%s" may only use letters, digits, / and - (at most 16 characters).', left(v_num, 30));
    end if;
    v_txt := nullif(btrim(coalesce(v_row ->> 'invoice_date', '')), '');
    if v_txt is null then
      v_err := v_err || 'Invoice Date is required.'::text;
    else
      begin
        if v_txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_date := v_txt::date;
        if v_date > private.company_today(p_company) then v_err := v_err || 'Invoice Date cannot be in the future.'::text; end if;
      exception when others then v_err := v_err || format('Invoice Date "%s" is not a valid date (use YYYY-MM-DD).', left(v_txt, 30));
      end;
    end if;
    v_txt := nullif(btrim(coalesce(v_row ->> 'due_date', '')), '');
    if v_txt is not null then
      begin
        if v_txt !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_due := v_txt::date;
        if v_date is not null and (v_due < v_date or v_due - v_date > 365) then v_err := v_err || 'Due Date must be on or after the Invoice Date (within 365 days).'::text; end if;
      exception when others then v_err := v_err || format('Due Date "%s" is not a valid date.', left(v_txt, 30));
      end;
    end if;
    begin
      v_terms := nullif(regexp_replace(coalesce(v_row ->> 'payment_terms', ''), '[^0-9]', '', 'g'), '')::int;
    exception when others then v_terms := null;
    end;

    -- Customer by GSTIN, then name.
    v_txt := nullif(upper(btrim(coalesce(v_row ->> 'customer_gstin', ''))), '');
    if v_txt is not null then
      if v_txt !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
        v_err := v_err || format('Customer GSTIN %s is not a valid GSTIN.', v_txt);
      end if;
      select * into v_cust from public.customers where company_id = p_company and upper(gstin) = v_txt and status = 'ACTIVE' limit 1;
    end if;
    if v_cust.id is null and nullif(btrim(coalesce(v_row ->> 'customer_name', '')), '') is not null then
      select * into v_cust from public.customers where company_id = p_company and status = 'ACTIVE'
        and (lower(customer_name) = lower(btrim(v_row ->> 'customer_name')) or lower(coalesce(legal_name, '')) = lower(btrim(v_row ->> 'customer_name')))
      order by customer_code limit 1;
    end if;
    if v_cust.id is null then
      v_err := v_err || format('Customer "%s" was not found. Add it (Quick Add) and check the file again.',
        left(coalesce(nullif(btrim(v_row ->> 'customer_name'), ''), v_txt, '?'), 80));
    end if;

    -- Product by SKU.
    v_txt := nullif(btrim(coalesce(v_row ->> 'sku', '')), '');
    if v_txt is null then
      v_err := v_err || 'Product SKU is required.'::text;
    else
      select * into v_prod from public.products where company_id = p_company and lower(sku) = lower(v_txt) and archived_at is null;
      if v_prod.id is null then
        v_err := v_err || format('Product SKU "%s" was not found. Add the product (Quick Add) and check the file again.', left(v_txt, 60));
      elsif v_prod.status <> 'ACTIVE' then
        v_err := v_err || format('%s is inactive.', v_prod.sku);
      elsif nullif(btrim(coalesce(v_row ->> 'unit', '')), '') is not null and upper(btrim(v_row ->> 'unit')) <> v_prod.base_unit then
        v_err := v_err || format('Unit %s does not match the unit of %s (%s).', upper(btrim(v_row ->> 'unit')), v_prod.sku, v_prod.base_unit);
      end if;
    end if;
    v_txt := coalesce(nullif(btrim(coalesce(v_row ->> 'hsn_code', '')), ''), v_prod.hsn_code);
    if v_txt is not null and v_txt !~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' then
      v_err := v_err || format('HSN Code "%s" must be 4, 6 or 8 digits.', left(v_txt, 20));
    elsif v_txt is null and v_s.gst_registered then
      v_err := v_err || 'HSN Code is required (not in the file or the Product Master).'::text;
    end if;

    begin v_qty := nullif(btrim(coalesce(v_row ->> 'quantity', '')), '')::numeric;
    exception when others then v_err := v_err || format('Quantity "%s" is not a number.', left(v_row ->> 'quantity', 30)); end;
    if v_qty is null then
      if not exists (select 1 from unnest(v_err) e where e like 'Quantity%') then v_err := v_err || 'Quantity is required.'::text; end if;
    elsif v_qty <= 0 or v_qty <> round(v_qty, 3) then
      v_err := v_err || 'Quantity must be greater than zero (up to 3 decimals).'::text;
    elsif v_prod.id is not null and private.is_whole_unit(v_prod.base_unit) and v_qty <> trunc(v_qty) then
      v_err := v_err || format('%s is counted in whole pieces (%s).', v_prod.sku, v_prod.base_unit);
    end if;
    begin v_rate := nullif(btrim(coalesce(v_row ->> 'rate', '')), '')::numeric;
    exception when others then v_err := v_err || format('Rate "%s" is not a number.', left(v_row ->> 'rate', 30)); end;
    if exists (select 1 from unnest(v_err) e where e like 'Rate%') then
      null;
    elsif v_rate is null and v_prod.id is not null and v_prod.selling_price is not null then
      v_rate := v_prod.selling_price;
      v_warn := v_warn || format('Rate taken from the Product Master (%s).', trim_scale(v_rate));
    elsif v_rate is null then
      v_err := v_err || 'Rate is required.'::text;
    elsif v_rate < 0 or v_rate <> round(v_rate, 2) then
      v_err := v_err || 'Rate must be zero or more with at most 2 decimals.'::text;
    end if;
    begin v_disc := nullif(btrim(replace(coalesce(v_row ->> 'discount', ''), '%', '')), '')::numeric;
    exception when others then v_err := v_err || format('Discount "%s" is not a number (a percentage).', left(v_row ->> 'discount', 30)); end;
    if v_disc is not null and (v_disc < 0 or v_disc > 100) then v_err := v_err || 'Discount must be a percentage between 0 and 100.'::text; end if;
    begin v_gst := nullif(btrim(replace(coalesce(v_row ->> 'gst_rate', ''), '%', '')), '')::numeric;
    exception when others then v_err := v_err || format('GST Rate "%s" is not a number.', left(v_row ->> 'gst_rate', 30)); end;
    v_gst := coalesce(v_gst, v_prod.gst_rate);
    if v_gst is null and v_s.gst_registered then
      v_err := v_err || 'GST Rate is required (not in the file or the Product Master).'::text;
    elsif v_gst is not null and (v_gst < 0 or v_gst > 100) then
      v_err := v_err || 'GST Rate must be between 0 and 100.'::text;
    elsif v_gst is not null and not (v_gst = any(v_s.gst_rates)) then
      v_warn := v_warn || format('GST rate %s%% is not one of the configured rates (%s).', trim_scale(v_gst), array_to_string(v_s.gst_rates, ', '));
    end if;
    -- Place of supply: a state code (27) or a name (Maharashtra); blank = from the customer.
    v_txt := nullif(btrim(coalesce(v_row ->> 'place_of_supply', '')), '');
    if v_txt is not null then
      v_pos := case when v_txt ~ '^[0-9]{1,2}$' then lpad(v_txt, 2, '0')
                    else (select g.code from public.gst_state_codes() g where lower(g.name) = lower(v_txt) limit 1) end;
      if v_pos is null or private.gst_state_name(v_pos) is null then
        v_err := v_err || format('Place of Supply "%s" is not a known GST state code or name.', left(v_txt, 40));
        v_pos := null;
      end if;
    end if;
    -- Sales order (optional): same customer; the product must be on it.
    v_txt := nullif(btrim(coalesce(v_row ->> 'sales_order_number', '')), '');
    if v_txt is not null then
      select * into v_so from public.sales_orders where company_id = p_company and lower(sales_order_number) = lower(v_txt);
      if v_so.id is null then
        v_err := v_err || format('Sales Order %s was not found.', left(v_txt, 40));
      elsif v_cust.id is not null and v_so.customer_id is distinct from v_cust.id then
        v_err := v_err || format('Sales Order %s belongs to another customer.', v_so.sales_order_number);
      elsif v_prod.id is not null then
        select * into v_sol from public.sales_order_lines where sales_order_id = v_so.id and product_id = v_prod.id order by line_no limit 1;
        if v_sol.id is null then
          v_err := v_err || format('%s is not on Sales Order %s.', v_prod.sku, v_so.sales_order_number);
        elsif v_qty is not null then
          v_left := private.so_line_invoiceable(v_sol.id) - coalesce((v_used ->> v_sol.id::text)::numeric, 0);
          if v_qty > v_left then
            v_err := v_err || format('Only %s %s of %s on %s is left to invoice.', trim_scale(greatest(v_left, 0)), v_sol.unit, v_prod.sku, v_so.sales_order_number);
          else
            v_used := v_used || jsonb_build_object(v_sol.id::text, coalesce((v_used ->> v_sol.id::text)::numeric, 0) + v_qty);
          end if;
        end if;
      end if;
    end if;
    if length(coalesce(v_row ->> 'remarks', '')) > 1000 then
      v_err := v_err || 'Remarks are limited to 1000 characters.'::text;
    end if;

    v_rows := v_rows || jsonb_build_object('row_number', (v_row ->> 'row_number')::int, 'errors', to_jsonb(v_err), 'warnings', to_jsonb(v_warn),
      'invoice_number', v_num, 'invoice_date', v_date, 'due_date', v_due, 'payment_terms', v_terms,
      'customer_id', v_cust.id, 'customer_name', coalesce(v_cust.customer_name, v_row ->> 'customer_name'),
      'customer_gstin', coalesce(v_cust.gstin, nullif(upper(btrim(coalesce(v_row ->> 'customer_gstin', ''))), '')),
      'sales_order_id', v_so.id, 'sales_order_number', v_so.sales_order_number, 'sales_order_line_id', v_sol.id,
      'product_id', v_prod.id, 'sku', coalesce(v_prod.sku, v_row ->> 'sku'), 'product_name', coalesce(nullif(btrim(coalesce(v_row ->> 'product_name', '')), ''), v_prod.product_name),
      'hsn_code', coalesce(nullif(btrim(coalesce(v_row ->> 'hsn_code', '')), ''), v_prod.hsn_code), 'unit', v_prod.base_unit,
      'quantity', v_qty, 'rate', v_rate, 'discount_percent', v_disc, 'gst_rate', v_gst, 'place_of_supply', v_pos,
      'remarks', nullif(btrim(coalesce(v_row ->> 'remarks', '')), ''),
      'line_value', case when v_qty is not null and v_rate is not null then round(round(round(v_qty * v_rate, 2) * (1 - coalesce(v_disc, 0) / 100), 2) * (1 + coalesce(v_gst, 0) / 100), 2) end);
  end loop;

  for v_g in
    select coalesce(r ->> 'invoice_number', '#' || (r ->> 'row_number')) as k, min((r ->> 'row_number')::int) as first_row, jsonb_agg(r order by (r ->> 'row_number')::int) as rs
    from jsonb_array_elements(v_rows) r group by 1 order by 2
  loop
    v_gerr := '{}'; v_gwarn := '{}'; v_total := 0;
    if exists (select 1 from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'errors') > 0) then
      v_gerr := v_gerr || format('%s row(s) of this invoice have errors, so the invoice is held back.',
        (select count(*) from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'errors') > 0));
    end if;
    if (select count(distinct coalesce(r ->> 'customer_id', r ->> 'customer_name')) from jsonb_array_elements(v_g.rs) r) > 1 then
      v_gerr := v_gerr || 'Rows of this invoice name different customers.'::text;
    end if;
    if (select count(distinct r ->> 'invoice_date') from jsonb_array_elements(v_g.rs) r where r ->> 'invoice_date' is not null) > 1 then
      v_gerr := v_gerr || 'Rows of this invoice have different Invoice Dates.'::text;
    end if;
    if (select count(distinct r ->> 'sales_order_id') from jsonb_array_elements(v_g.rs) r where r ->> 'sales_order_id' is not null) > 1 then
      v_gerr := v_gerr || 'One invoice can refer to one sales order only.'::text;
    end if;
    if v_g.rs -> 0 ->> 'invoice_number' is not null
       and exists (select 1 from public.sales_invoices where company_id = p_company and upper(invoice_number) = v_g.rs -> 0 ->> 'invoice_number') then
      v_gerr := v_gerr || format('Invoice number %s already exists (already imported or issued); it is not imported again.', v_g.rs -> 0 ->> 'invoice_number');
    end if;
    for v_line in select value from jsonb_array_elements(v_g.rs) loop
      v_total := v_total + coalesce((v_line ->> 'line_value')::numeric, 0);
    end loop;
    v_groups := v_groups || jsonb_build_object('invoice_number', v_g.rs -> 0 -> 'invoice_number', 'first_row', v_g.first_row,
      'status', case when cardinality(v_gerr) > 0 then 'ERROR'
                     when exists (select 1 from jsonb_array_elements(v_g.rs) r where jsonb_array_length(r -> 'warnings') > 0) then 'WARNING' else 'VALID' end,
      'errors', to_jsonb(v_gerr), 'warnings', to_jsonb(v_gwarn),
      'invoice_date', v_g.rs -> 0 -> 'invoice_date', 'due_date', v_g.rs -> 0 -> 'due_date', 'payment_terms', v_g.rs -> 0 -> 'payment_terms',
      'customer_id', v_g.rs -> 0 -> 'customer_id', 'customer_name', v_g.rs -> 0 -> 'customer_name', 'customer_gstin', v_g.rs -> 0 -> 'customer_gstin',
      'sales_order_id', (select r -> 'sales_order_id' from jsonb_array_elements(v_g.rs) r where r ->> 'sales_order_id' is not null limit 1),
      'sales_order_number', (select r -> 'sales_order_number' from jsonb_array_elements(v_g.rs) r where r ->> 'sales_order_id' is not null limit 1),
      'place_of_supply', (select r -> 'place_of_supply' from jsonb_array_elements(v_g.rs) r where r ->> 'place_of_supply' is not null limit 1),
      'remarks', v_g.rs -> 0 -> 'remarks', 'estimated_total', v_total, 'rows', v_g.rs);
  end loop;
  return v_groups;
end;
$$;

revoke all on function private.invoice_import_check(uuid, jsonb) from public, anon, authenticated;

create or replace function public.invoice_import_preview(p_rows jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.create');
  v_groups  jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 rows per file.' using errcode = 'P0001';
  end if;
  v_groups := private.invoice_import_check(v_company, p_rows);
  return jsonb_build_object('invoices', v_groups, 'rows', jsonb_array_length(p_rows),
    'valid', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'VALID'),
    'warnings', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'WARNING'),
    'errors', (select count(*) from jsonb_array_elements(v_groups) g where g ->> 'status' = 'ERROR'),
    'missing_customers', coalesce((select jsonb_agg(distinct jsonb_build_object('name', r ->> 'customer_name', 'gstin', r ->> 'customer_gstin'))
       from jsonb_array_elements(v_groups) g cross join jsonb_array_elements(g -> 'rows') r where r ->> 'customer_id' is null and coalesce(r ->> 'customer_name', r ->> 'customer_gstin') is not null), '[]'::jsonb),
    'missing_products', coalesce((select jsonb_agg(distinct jsonb_build_object('sku', r ->> 'sku', 'name', r ->> 'product_name'))
       from jsonb_array_elements(v_groups) g cross join jsonb_array_elements(g -> 'rows') r where r ->> 'product_id' is null and coalesce(r ->> 'sku', '') <> ''), '[]'::jsonb));
end;
$$;

create or replace function public.invoice_import(p_rows jsonb, p_file jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.create');
  v_prev    jsonb;
  v_groups  jsonb;
  v_g       jsonb;
  v_save    jsonb;
  v_issue   jsonb;
  v_created jsonb := '[]'::jsonb;
  v_failed  jsonb := '[]'::jsonb;
  v_hist    jsonb := '[]'::jsonb;
  v_file    jsonb := coalesce(p_file, '{}'::jsonb);
  v_ok      int := 0;
  v_bad     int := 0;
  v_msgs    jsonb;
  v_job     public.import_jobs;
begin
  perform private.require_permission('invoices.issue');
  v_prev := private.idempotency_begin(v_company, p_idempotency_key, 'invoice_import');
  if v_prev is not null then return v_prev; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no data rows.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 rows per file.' using errcode = 'P0001';
  end if;
  -- Re-validated here; the preview is never trusted.
  v_groups := private.invoice_import_check(v_company, p_rows);
  for v_g in select value from jsonb_array_elements(v_groups) loop
    if v_g ->> 'status' = 'ERROR' then
      v_msgs := v_g -> 'errors';
    else
      begin
        v_save := public.sales_invoice_v2_save(null,
          jsonb_strip_nulls(jsonb_build_object('customer_id', v_g ->> 'customer_id', 'sales_order_id', v_g ->> 'sales_order_id', 'invoice_date', v_g ->> 'invoice_date',
            'due_date', v_g ->> 'due_date', 'payment_terms_days', v_g ->> 'payment_terms', 'place_of_supply_state_code', v_g ->> 'place_of_supply',
            'notes', v_g ->> 'remarks', 'source', 'IMPORT', 'is_proforma', false, 'pricing_mode', 'EXCLUSIVE')),
          (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('product_id', r ->> 'product_id', 'sales_order_line_id', r ->> 'sales_order_line_id',
             'description', r ->> 'product_name', 'hsn_sac', r ->> 'hsn_code', 'quantity', r ->> 'quantity', 'unit_price', r ->> 'rate',
             'discount_percent', r ->> 'discount_percent', 'gst_rate', r ->> 'gst_rate')) order by (r ->> 'row_number')::int) from jsonb_array_elements(v_g -> 'rows') r),
          null, gen_random_uuid());
        update public.sales_invoices set source = 'IMPORT' where id = (v_save ->> 'invoice_id')::uuid;
        v_issue := private.invoice_v2_issue_core(v_company, (v_save ->> 'invoice_id')::uuid, v_g ->> 'invoice_number');
        v_created := v_created || jsonb_build_object('first_row', v_g -> 'first_row', 'invoice_id', v_save -> 'invoice_id', 'invoice_number', v_issue -> 'invoice_number',
          'grand_total', v_issue -> 'grand_total', 'rows', (select jsonb_agg(r -> 'row_number') from jsonb_array_elements(v_g -> 'rows') r));
        v_ok := v_ok + jsonb_array_length(v_g -> 'rows');
        continue;
      exception when others then
        v_msgs := jsonb_build_array(sqlerrm);
      end;
    end if;
    v_failed := v_failed || jsonb_build_object('first_row', v_g -> 'first_row', 'invoice_number', v_g -> 'invoice_number', 'messages', v_msgs,
      'rows', (select jsonb_agg(r -> 'row_number') from jsonb_array_elements(v_g -> 'rows') r));
    v_bad := v_bad + jsonb_array_length(v_g -> 'rows');
    v_hist := v_hist || coalesce((select jsonb_agg(jsonb_build_object('row_number', r -> 'row_number', 'outcome', 'FAILED',
        'reference', left(coalesce(v_g ->> 'invoice_number', '') || ' / ' || coalesce(r ->> 'sku', ''), 200), 'messages', (r -> 'errors') || v_msgs))
      from jsonb_array_elements(v_g -> 'rows') r), '[]'::jsonb);
  end loop;

  v_job := private.import_job_write(v_company, auth.uid(), jsonb_build_object(
    'import_type', 'INVOICE', 'client_job_key', p_idempotency_key, 'file_name', left(v_file ->> 'file_name', 255),
    'status', case when jsonb_array_length(v_created) = 0 then 'FAILED' end,
    'total_rows', jsonb_array_length(p_rows), 'success_rows', v_ok, 'failed_rows', v_bad,
    'notes', format('%s invoice(s) imported, %s invoice(s) not imported.', jsonb_array_length(v_created), jsonb_array_length(v_failed))), v_hist);
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('job_id', v_job.id, 'created', v_created, 'failed', v_failed,
    'created_count', jsonb_array_length(v_created), 'failed_count', jsonb_array_length(v_failed)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sales_invoice_v2_save(uuid, jsonb, jsonb, jsonb, uuid)',
    'public.sales_order_invoice_lines(uuid)',
    'public.sales_invoice_v2_issue(uuid, boolean, uuid)',
    'public.invoice_v2_record_payment(uuid, jsonb, uuid)',
    'public.invoice_v2_apply_advance(uuid, uuid, numeric, uuid)',
    'public.adjustment_note_v2_issue(uuid, text, jsonb, jsonb, uuid)',
    'public.invoice_dashboard(date, date, uuid, text, text)',
    'public.invoice_import_preview(jsonb)',
    'public.invoice_import(jsonb, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
