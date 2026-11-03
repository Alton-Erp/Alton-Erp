-- =============================================================================
-- Phase 8: sales invoices
--
--   sales_invoices                       header + immutable snapshots (seller,
--                                        customer, place of supply, totals)
--   sales_invoice_lines                  product lines (from actual dispatch
--                                        lines) and an optional charge line
--   sales_invoice_dispatch_allocations   how much of each dispatch line an
--                                        invoice bills
--
-- Invoice source: actual dispatches (fulfilment_lines.quantity_dispatched, or
-- delivered quantity when the billing basis is DELIVERY). Reserved, picked or
-- packed quantities are never invoiceable.
--   invoiceable = basis quantity - quantity received back on returns
--                 - quantity on live invoices (draft, pending approval, issued)
-- Re-checked under row locks when an invoice is issued.
--
-- Money: numeric with fixed scale, computed only in the database.
--   gross     = round(quantity x unit price, 2)
--   discount  = round(gross x discount % / 100, 2) or a fixed amount
--   taxable   = gross - discount
--   intra-state: CGST = SGST = round(taxable x rate/2 / 100, 2)
--   inter-state: IGST = round(taxable x rate / 100, 2)
--   totals are sums of line values; optional round-off to the nearest rupee.
-- Half-up rounding (PostgreSQL round on numeric). Issued invoices are never
-- recalculated.
--
-- Lifecycle (stored): DRAFT -> (PENDING_APPROVAL) -> ISSUED -> CANCELLED; drafts
-- may be DISCARDED. Payment state (unpaid / partially paid / paid / overdue)
-- is derived from balances in sales_invoice_list and is never stored.
-- Invoices never change inventory.
-- =============================================================================

create table if not exists public.sales_invoices (
  id                           uuid primary key default gen_random_uuid(),
  company_id                   uuid not null references public.companies (id) on delete restrict,
  invoice_number               text,
  numbering_scope              text,
  financial_year               text,
  invoice_type                 text not null default 'TAX_INVOICE' check (invoice_type in ('TAX_INVOICE', 'BILL_OF_SUPPLY')),
  invoice_date                 date not null,
  due_date                     date,
  payment_terms_days           integer not null check (payment_terms_days between 0 and 365),
  customer_id                  uuid not null,
  customer_code_snapshot       text not null,
  customer_legal_name          text not null,
  customer_billing_address     text,
  customer_shipping_address    text,
  customer_gstin               text,
  customer_registration_type   text,
  customer_billing_state_code  text,
  customer_shipping_state_code text,
  seller_legal_name            text not null,
  seller_address               text,
  seller_gstin                 text,
  seller_pan                   text,
  seller_state_code            text,
  place_of_supply_state_code   text check (place_of_supply_state_code is null or place_of_supply_state_code ~ '^[0-9]{2}$'),
  supply_category              text not null default 'TAXABLE' check (supply_category in ('TAXABLE', 'EXEMPT', 'ZERO_RATED', 'NON_GST')),
  special_category_reason      text check (special_category_reason is null or length(special_category_reason) <= 500),
  tax_treatment                text not null default 'UNRESOLVED' check (tax_treatment in ('INTRA_STATE', 'INTER_STATE', 'NONE', 'UNRESOLVED')),
  order_references             text,
  dispatch_references          text,
  currency                     text not null check (currency ~ '^[A-Z]{3}$'),
  gross_total                  numeric(16,2) not null default 0,
  discount_total               numeric(16,2) not null default 0,
  taxable_subtotal             numeric(16,2) not null default 0,
  other_charges_total          numeric(16,2) not null default 0,
  cgst_total                   numeric(16,2) not null default 0,
  sgst_total                   numeric(16,2) not null default 0,
  igst_total                   numeric(16,2) not null default 0,
  round_off                    numeric(6,2) not null default 0 check (round_off between -1 and 1),
  grand_total                  numeric(16,2) not null default 0 check (grand_total >= 0),
  status                       text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED', 'DISCARDED')),
  notes                        text check (notes is null or length(notes) <= 1000),
  internal_notes               text check (internal_notes is null or length(internal_notes) <= 1000),
  terms_snapshot               text,
  footer_snapshot              text,
  bank_snapshot                jsonb,
  tax_review_note              text,
  tax_review_by                uuid,
  tax_review_at                timestamptz,
  e_invoice_status             text not null default 'NOT_CONFIGURED' check (e_invoice_status in ('NOT_CONFIGURED')),
  submitted_by                 uuid,
  submitted_at                 timestamptz,
  issued_by                    uuid,
  issued_at                    timestamptz,
  cancelled_by                 uuid,
  cancelled_at                 timestamptz,
  cancellation_reason          text check (cancellation_reason is null or length(cancellation_reason) <= 1000),
  created_by                   uuid,
  created_at                   timestamptz not null default now(),
  updated_by                   uuid,
  updated_at                   timestamptz not null default now(),
  constraint sales_invoices_id_company_unique unique (id, company_id),
  constraint sales_invoices_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint sales_invoices_issued_state check ((status in ('ISSUED', 'CANCELLED')) = (invoice_number is not null and issued_at is not null and issued_by is not null)),
  constraint sales_invoices_cancel_state check ((status = 'CANCELLED') = (cancelled_at is not null)),
  constraint sales_invoices_due check (due_date is null or due_date >= invoice_date),
  constraint sales_invoices_totals check (grand_total = taxable_subtotal + cgst_total + sgst_total + igst_total + round_off)
);

create unique index if not exists sales_invoices_number_unique on public.sales_invoices (company_id, invoice_number) where invoice_number is not null;
create index if not exists sales_invoices_status_idx on public.sales_invoices (company_id, status);
create index if not exists sales_invoices_customer_idx on public.sales_invoices (company_id, customer_id);
create index if not exists sales_invoices_date_idx on public.sales_invoices (company_id, invoice_date desc);
create index if not exists sales_invoices_due_idx on public.sales_invoices (company_id, due_date) where status = 'ISSUED';

create table if not exists public.sales_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  invoice_id          uuid not null,
  line_no             integer not null check (line_no > 0),
  line_type           text not null default 'PRODUCT' check (line_type in ('PRODUCT', 'CHARGE')),
  product_id          uuid,
  sales_order_id      uuid,
  sales_order_line_id uuid,
  fulfilment_line_id  uuid,
  sku                 text,
  description         text not null check (length(description) between 1 and 500),
  hsn_sac             text check (hsn_sac is null or hsn_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  unit                text,
  quantity            numeric(14,3) not null check (quantity > 0),
  unit_price          numeric(14,2) check (unit_price is null or unit_price >= 0),
  discount_percent    numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
  discount_amount     numeric(14,2) not null default 0 check (discount_amount >= 0),
  gross_amount        numeric(16,2) not null default 0,
  taxable_value       numeric(16,2) not null default 0 check (taxable_value >= 0),
  gst_rate            numeric(5,2) check (gst_rate is null or gst_rate between 0 and 100),
  cgst_rate           numeric(5,2) not null default 0,
  sgst_rate           numeric(5,2) not null default 0,
  igst_rate           numeric(5,2) not null default 0,
  cgst_amount         numeric(16,2) not null default 0,
  sgst_amount         numeric(16,2) not null default 0,
  igst_amount         numeric(16,2) not null default 0,
  line_total          numeric(16,2) not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint sales_invoice_lines_unique unique (invoice_id, line_no),
  constraint sales_invoice_lines_id_company_unique unique (id, company_id),
  constraint sales_invoice_lines_invoice_fk foreign key (invoice_id, company_id) references public.sales_invoices (id, company_id) on delete restrict,
  constraint sales_invoice_lines_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint sales_invoice_lines_so_line_fk foreign key (sales_order_line_id, company_id) references public.sales_order_lines (id, company_id) on delete restrict,
  constraint sales_invoice_lines_fl_fk foreign key (fulfilment_line_id, company_id) references public.fulfilment_lines (id, company_id) on delete restrict,
  constraint sales_invoice_lines_source check ((line_type = 'PRODUCT') = (fulfilment_line_id is not null and product_id is not null)),
  constraint sales_invoice_lines_amounts check (taxable_value = gross_amount - discount_amount and line_total = taxable_value + cgst_amount + sgst_amount + igst_amount)
);

create index if not exists sales_invoice_lines_invoice_idx on public.sales_invoice_lines (invoice_id);
create index if not exists sales_invoice_lines_fl_idx on public.sales_invoice_lines (fulfilment_line_id);

create table if not exists public.sales_invoice_dispatch_allocations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete restrict,
  invoice_id         uuid not null,
  invoice_line_id    uuid not null unique,
  fulfilment_line_id uuid not null,
  quantity           numeric(14,3) not null check (quantity > 0),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint invoice_dispatch_alloc_unique unique (invoice_id, fulfilment_line_id),
  constraint invoice_dispatch_alloc_invoice_fk foreign key (invoice_id, company_id) references public.sales_invoices (id, company_id) on delete restrict,
  constraint invoice_dispatch_alloc_line_fk foreign key (invoice_line_id, company_id) references public.sales_invoice_lines (id, company_id) on delete restrict,
  constraint invoice_dispatch_alloc_fl_fk foreign key (fulfilment_line_id, company_id) references public.fulfilment_lines (id, company_id) on delete restrict
);

create index if not exists invoice_dispatch_alloc_fl_idx on public.sales_invoice_dispatch_allocations (fulfilment_line_id);

drop trigger if exists sales_invoices_set_updated_at on public.sales_invoices;
create trigger sales_invoices_set_updated_at before update on public.sales_invoices for each row execute function private.set_updated_at();
drop trigger if exists sales_invoice_lines_set_updated_at on public.sales_invoice_lines;
create trigger sales_invoice_lines_set_updated_at before update on public.sales_invoice_lines for each row execute function private.set_updated_at();

-- Issued invoices are immutable: only cancellation fields may change (and only
-- ISSUED -> CANCELLED). Nothing is ever deleted (drafts are discarded).
create or replace function private.guard_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Invoices are never deleted. Discard a draft or cancel an issued invoice.' using errcode = 'P0001';
  end if;
  if old.status in ('CANCELLED', 'DISCARDED') then
    raise exception 'A % invoice cannot be changed.', lower(old.status) using errcode = 'P0001';
  end if;
  if old.status = 'ISSUED' then
    if new.status <> 'CANCELLED'
       or (to_jsonb(new) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by'])
          is distinct from (to_jsonb(old) - array['status', 'cancelled_by', 'cancelled_at', 'cancellation_reason', 'updated_at', 'updated_by']) then
      raise exception 'Issued invoice % cannot be edited. Use a credit or debit note, or cancel it through the approved workflow.', old.invoice_number
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_invoice_line_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.sales_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- Drafts are edited; invoices pending approval are only recalculated at issue.
  if v_status is null or v_status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Lines of a % invoice cannot be changed.', replace(lower(coalesce(v_status, 'unknown')), '_', ' ') using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.guard_invoice_change() from public, anon, authenticated;
revoke all on function private.guard_invoice_line_change() from public, anon, authenticated;

drop trigger if exists sales_invoices_guard on public.sales_invoices;
create trigger sales_invoices_guard before update or delete on public.sales_invoices for each row execute function private.guard_invoice_change();
drop trigger if exists sales_invoice_lines_guard on public.sales_invoice_lines;
create trigger sales_invoice_lines_guard before insert or update or delete on public.sales_invoice_lines for each row execute function private.guard_invoice_line_change();
drop trigger if exists invoice_dispatch_alloc_guard on public.sales_invoice_dispatch_allocations;
create trigger invoice_dispatch_alloc_guard before insert or update or delete on public.sales_invoice_dispatch_allocations
  for each row execute function private.guard_invoice_line_change();

do $$
declare
  t text;
begin
  foreach t in array array['sales_invoices', 'sales_invoice_lines', 'sales_invoice_dispatch_allocations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'invoices.read', 'payments.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Invoiceable quantities
-- -----------------------------------------------------------------------------
create or replace function private.dispatch_line_invoiced(p_fulfilment_line uuid, p_exclude_invoice uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(a.quantity), 0)
  from public.sales_invoice_dispatch_allocations a join public.sales_invoices i on i.id = a.invoice_id
  where a.fulfilment_line_id = p_fulfilment_line and i.status in ('DRAFT', 'PENDING_APPROVAL', 'ISSUED')
    and (p_exclude_invoice is null or i.id <> p_exclude_invoice);
$$;

create or replace function private.dispatch_line_invoiceable(p_fulfilment_line uuid, p_exclude_invoice uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    case when (select billing_basis from public.invoice_settings where company_id = fl.company_id) = 'DELIVERY' then fl.quantity_delivered else fl.quantity_dispatched end
    - coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id), 0)
    - private.dispatch_line_invoiced(fl.id, p_exclude_invoice), 0)
  from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
  where fl.id = p_fulfilment_line and f.actual_dispatch_at is not null;
$$;

revoke all on function private.dispatch_line_invoiced(uuid, uuid) from public, anon;
revoke all on function private.dispatch_line_invoiceable(uuid, uuid) from public, anon;
grant execute on function private.dispatch_line_invoiced(uuid, uuid), private.dispatch_line_invoiceable(uuid, uuid) to authenticated;

-- Dispatched lines with their invoicing position (only dispatched lines appear).
create or replace view public.invoiceable_dispatch_list
with (security_invoker = true) as
select fl.id as fulfilment_line_id, fl.company_id, fl.fulfilment_id, f.fulfilment_number, f.actual_dispatch_at, f.fulfilment_status,
  so.id as sales_order_id, so.sales_order_number, so.customer_id, so.customer_name_snapshot, so.customer_po_number, so.currency as order_currency,
  sol.id as sales_order_line_id, sol.line_no as order_line_no, sol.quantity_ordered - sol.quantity_cancelled as quantity_ordered,
  sol.quantity_dispatched as order_line_dispatched, sol.unit_price_snapshot,
  p.id as product_id, p.sku, p.product_name, p.hsn_code, p.gst_rate, p.selling_price, sol.unit,
  fl.quantity_dispatched, fl.quantity_delivered,
  coalesce((select sum(rl.quantity_received) from public.customer_return_lines rl where rl.fulfilment_line_id = fl.id), 0) as quantity_returned,
  private.dispatch_line_invoiced(fl.id) as quantity_invoiced,
  coalesce(private.dispatch_line_invoiceable(fl.id), 0) as quantity_invoiceable
from public.fulfilment_lines fl
join public.fulfilments f on f.id = fl.fulfilment_id
join public.sales_orders so on so.id = f.sales_order_id
join public.sales_order_lines sol on sol.id = fl.sales_order_line_id
join public.products p on p.id = fl.product_id
where fl.quantity_dispatched > 0 and f.actual_dispatch_at is not null;

revoke all on public.invoiceable_dispatch_list from anon, authenticated;
grant select on public.invoiceable_dispatch_list to authenticated;

-- -----------------------------------------------------------------------------
-- Snapshots, tax treatment and calculation
-- -----------------------------------------------------------------------------
-- Copies the current seller and customer details onto a draft and suggests the
-- place of supply when none is set. Issued invoices keep what they had.
create or replace function private.invoice_refresh_snapshots(p_invoice uuid, p_reset_pos boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.sales_invoices;
  v_c   public.customers;
  v_co  public.companies;
  v_s   public.invoice_settings;
  v_pos text;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice;
  select * into v_c from public.customers where id = v_inv.customer_id;
  select * into v_co from public.companies where id = v_inv.company_id;
  v_s := private.billing_settings(v_inv.company_id);
  -- Suggested place of supply: registered customers -> GSTIN state; overseas -> 96;
  -- otherwise the shipping state, then the billing state. Always reviewable.
  v_pos := case when v_c.gst_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') and v_c.gstin is not null then left(v_c.gstin, 2)
                when v_c.gst_registration_type = 'OVERSEAS' then '96'
                else coalesce(v_c.shipping_state_code, v_c.billing_state_code) end;
  update public.sales_invoices set
    customer_code_snapshot = v_c.customer_code, customer_legal_name = coalesce(v_c.legal_name, v_c.customer_name),
    customer_billing_address = v_c.billing_address, customer_shipping_address = v_c.shipping_address, customer_gstin = v_c.gstin,
    customer_registration_type = v_c.gst_registration_type, customer_billing_state_code = v_c.billing_state_code,
    customer_shipping_state_code = v_c.shipping_state_code,
    seller_legal_name = v_co.legal_name, seller_address = v_co.legal_address, seller_gstin = v_co.gstin, seller_pan = v_s.seller_pan,
    seller_state_code = left(v_co.gstin, 2),
    place_of_supply_state_code = case when p_reset_pos or place_of_supply_state_code is null then v_pos else place_of_supply_state_code end,
    order_references = (select string_agg(distinct so.sales_order_number || coalesce(' (PO ' || so.customer_po_number || ')', ''), ', ')
      from public.sales_invoice_lines l join public.sales_orders so on so.id = l.sales_order_id where l.invoice_id = p_invoice),
    dispatch_references = (select string_agg(distinct f.fulfilment_number, ', ')
      from public.sales_invoice_lines l join public.fulfilment_lines fl on fl.id = l.fulfilment_line_id join public.fulfilments f on f.id = fl.fulfilment_id
      where l.invoice_id = p_invoice),
    updated_by = auth.uid()
  where id = p_invoice;
end;
$$;

revoke all on function private.invoice_refresh_snapshots(uuid, boolean) from public, anon, authenticated;

-- Recomputes every line and the totals of a DRAFT invoice from its snapshot values.
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

  update public.sales_invoice_lines l set
    gross_amount = x.gross, discount_amount = x.discount, taxable_value = x.gross - x.discount,
    cgst_rate = x.cgst_rate, sgst_rate = x.cgst_rate, igst_rate = x.igst_rate,
    cgst_amount = round((x.gross - x.discount) * x.cgst_rate / 100, 2), sgst_amount = round((x.gross - x.discount) * x.cgst_rate / 100, 2),
    igst_amount = round((x.gross - x.discount) * x.igst_rate / 100, 2),
    line_total = (x.gross - x.discount) + 2 * round((x.gross - x.discount) * x.cgst_rate / 100, 2) + round((x.gross - x.discount) * x.igst_rate / 100, 2)
  from (
    select id,
      round(quantity * coalesce(unit_price, 0), 2) as gross,
      least(case when discount_percent > 0 then round(round(quantity * coalesce(unit_price, 0), 2) * discount_percent / 100, 2) else discount_amount end,
            round(quantity * coalesce(unit_price, 0), 2)) as discount,
      case when v_inv.supply_category = 'TAXABLE' and v_treatment = 'INTRA_STATE' and gst_rate is not null then gst_rate / 2 else 0 end as cgst_rate,
      case when v_inv.supply_category = 'TAXABLE' and v_treatment = 'INTER_STATE' and gst_rate is not null then gst_rate else 0 end as igst_rate
    from public.sales_invoice_lines where invoice_id = p_invoice
  ) x
  where l.id = x.id;

  select coalesce(sum(line_total), 0) into v_sum from public.sales_invoice_lines where invoice_id = p_invoice;
  v_grand := case when v_s.round_off_enabled then round(v_sum, 0) else v_sum end;
  update public.sales_invoices i set
    tax_treatment = v_treatment,
    invoice_type = case when v_inv.supply_category in ('TAXABLE', 'ZERO_RATED') and v_s.gst_registered then 'TAX_INVOICE' else 'BILL_OF_SUPPLY' end,
    gross_total = t.gross, discount_total = t.discount, taxable_subtotal = t.taxable, other_charges_total = t.charges,
    cgst_total = t.cgst, sgst_total = t.sgst, igst_total = t.igst, round_off = v_grand - v_sum, grand_total = v_grand,
    updated_by = auth.uid()
  from (
    select coalesce(sum(gross_amount), 0) as gross, coalesce(sum(discount_amount), 0) as discount, coalesce(sum(taxable_value), 0) as taxable,
      coalesce(sum(taxable_value) filter (where line_type = 'CHARGE'), 0) as charges,
      coalesce(sum(cgst_amount), 0) as cgst, coalesce(sum(sgst_amount), 0) as sgst, coalesce(sum(igst_amount), 0) as igst
    from public.sales_invoice_lines where invoice_id = p_invoice
  ) t
  where i.id = p_invoice;
end;
$$;

revoke all on function private.invoice_recalculate(uuid) from public, anon, authenticated;

-- Problems with an invoice: severity BLOCK (cannot be issued) or REVIEW (needs
-- an approver's acknowledgement before issue).
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
begin
  select * into v_inv from public.sales_invoices where id = p_invoice;
  select * into v_s from public.invoice_settings where company_id = v_inv.company_id;
  if not found then
    raise exception 'Invoice settings are missing.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_inv.company_id);
  -- Seller
  if v_inv.seller_address is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SELLER_ADDRESS', 'message', 'Company registered address is missing (Company Settings).');
  end if;
  if v_s.gst_registered and v_inv.seller_gstin is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'SELLER_GSTIN', 'message', 'Company GSTIN is missing (Company Settings), or mark the company as not GST-registered in Invoice Settings.');
  end if;
  -- Customer
  if v_inv.customer_billing_address is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_ADDRESS', 'message', 'Customer billing address is missing (Customers).');
  end if;
  if v_inv.customer_registration_type is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_GST_TYPE', 'message', 'Customer GST registration type is not set (Customers).');
  elsif v_inv.customer_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') and v_inv.customer_gstin is null then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'CUSTOMER_GSTIN', 'message', 'Customer is registered but has no GSTIN (Customers).');
  end if;
  -- Place of supply and treatment
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
      v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SPECIAL_CATEGORY', 'message', 'Exempt / zero-rated / non-GST supply needs an authorised tax review.');
    end if;
  end if;
  if v_inv.customer_registration_type in ('SEZ', 'OVERSEAS') then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SEZ_EXPORT', 'message', 'SEZ / overseas supply: confirm the treatment (LUT, with or without payment of IGST) with an authorised reviewer.');
  end if;
  if v_inv.customer_registration_type in ('REGISTERED', 'COMPOSITION') and v_inv.customer_gstin is not null and v_inv.place_of_supply_state_code is not null
     and left(v_inv.customer_gstin, 2) <> v_inv.place_of_supply_state_code then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'POS_DIFFERS', 'message', 'Place of supply differs from the customer''s GSTIN state; confirm it.');
  end if;
  if v_inv.customer_shipping_state_code is not null and v_inv.place_of_supply_state_code is not null
     and v_inv.customer_shipping_state_code <> v_inv.place_of_supply_state_code then
    v_issues := v_issues || jsonb_build_object('severity', 'REVIEW', 'code', 'SHIP_STATE', 'message', 'Shipping state differs from the place of supply (bill-to / ship-to); confirm the place of supply.');
  end if;
  -- Dates
  select max((f.actual_dispatch_at at time zone private.company_tz(v_inv.company_id))::date) into v_last
  from public.sales_invoice_lines l join public.fulfilment_lines fl on fl.id = l.fulfilment_line_id join public.fulfilments f on f.id = fl.fulfilment_id
  where l.invoice_id = p_invoice;
  if v_inv.invoice_date > v_today then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'INVOICE_DATE', 'message', 'The invoice date cannot be in the future.');
  end if;
  if v_last is not null and v_inv.invoice_date < v_last then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'INVOICE_DATE_BEFORE_DISPATCH', 'message', format('The invoice date is before the last dispatch (%s).', v_last));
  end if;
  -- Lines
  if not exists (select 1 from public.sales_invoice_lines where invoice_id = p_invoice and line_type = 'PRODUCT') then
    v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'NO_LINES', 'message', 'The invoice has no dispatched product lines.');
  end if;
  for v_line in select * from public.sales_invoice_lines where invoice_id = p_invoice order by line_no loop
    if v_line.unit_price is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'PRICE', 'line_no', v_line.line_no, 'message', format('Line %s (%s): enter the unit price.', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_s.gst_registered and v_inv.supply_category <> 'NON_GST' and v_line.hsn_sac is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'HSN', 'line_no', v_line.line_no, 'message', format('Line %s (%s): HSN/SAC code is missing (Product Master).', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_inv.supply_category = 'TAXABLE' and v_s.gst_registered and v_line.gst_rate is null then
      v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'GST_RATE', 'line_no', v_line.line_no, 'message', format('Line %s (%s): GST rate is missing (Product Master).', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_line.line_type = 'PRODUCT' then
      v_avail := coalesce(private.dispatch_line_invoiceable(v_line.fulfilment_line_id, p_invoice), 0);
      if v_line.quantity > v_avail then
        v_issues := v_issues || jsonb_build_object('severity', 'BLOCK', 'code', 'QUANTITY', 'line_no', v_line.line_no,
          'message', format('Line %s (%s): only %s is still invoiceable from this dispatch.', v_line.line_no, v_line.sku, v_avail));
      end if;
    end if;
  end loop;
  return v_issues;
end;
$$;

revoke all on function private.invoice_issues(uuid) from public, anon, authenticated;

create or replace function private.lock_invoice(p_company uuid, p_id uuid)
returns public.sales_invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sales_invoices;
begin
  select * into v from public.sales_invoices where id = p_id and company_id = p_company for update;
  if not found then
    raise exception 'Invoice not found in your company.' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

revoke all on function private.lock_invoice(uuid, uuid) from public, anon, authenticated;

-- Applies header changes from jsonb (draft only).
create or replace function private.invoice_apply_header(p_invoice public.sales_invoices, p_header jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h    jsonb := coalesce(p_header, '{}'::jsonb);
  v_date date;
  v_pos  text;
  v_cat  text;
  v_days int;
begin
  begin
    v_date := coalesce(nullif(v_h ->> 'invoice_date', '')::date, p_invoice.invoice_date);
    v_days := coalesce(nullif(v_h ->> 'payment_terms_days', '')::int, p_invoice.payment_terms_days);
  exception when others then
    raise exception 'Enter a valid invoice date and payment terms.' using errcode = 'P0001';
  end;
  v_pos := case when v_h ? 'place_of_supply_state_code' then nullif(btrim(v_h ->> 'place_of_supply_state_code'), '') else p_invoice.place_of_supply_state_code end;
  v_cat := coalesce(nullif(v_h ->> 'supply_category', ''), p_invoice.supply_category);
  if v_pos is not null and private.gst_state_name(v_pos) is null then
    raise exception 'Unknown place of supply state code %.', v_pos using errcode = 'P0001';
  end if;
  if v_cat not in ('TAXABLE', 'EXEMPT', 'ZERO_RATED', 'NON_GST') then
    raise exception 'Unknown supply category %.', v_cat using errcode = 'P0001';
  end if;
  if v_days < 0 or v_days > 365 then
    raise exception 'Payment terms must be between 0 and 365 days.' using errcode = 'P0001';
  end if;
  update public.sales_invoices set
    invoice_date = v_date, payment_terms_days = v_days, due_date = v_date + v_days,
    place_of_supply_state_code = v_pos, supply_category = v_cat,
    special_category_reason = case when v_h ? 'special_category_reason' then nullif(btrim(v_h ->> 'special_category_reason'), '') else special_category_reason end,
    notes = case when v_h ? 'notes' then nullif(btrim(v_h ->> 'notes'), '') else notes end,
    internal_notes = case when v_h ? 'internal_notes' then nullif(btrim(v_h ->> 'internal_notes'), '') else internal_notes end,
    -- Any header change invalidates an earlier tax review acknowledgement.
    tax_review_note = null, tax_review_by = null, tax_review_at = null,
    updated_by = auth.uid()
  where id = p_invoice.id;
end;
$$;

revoke all on function private.invoice_apply_header(public.sales_invoices, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Draft creation from dispatch lines
-- p_lines:  [{fulfilment_line_id, quantity?}]  (quantity defaults to all invoiceable)
-- p_header: {invoice_date, payment_terms_days, place_of_supply_state_code, supply_category,
--            special_category_reason, notes, internal_notes}
-- -----------------------------------------------------------------------------
create or replace function public.sales_invoice_create_draft(p_lines jsonb, p_header jsonb default '{}'::jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('invoices.create');
  v_previous jsonb;
  v_s        public.invoice_settings := private.billing_settings(v_company);
  v_currency text;
  v_entry    jsonb;
  v_fl       record;
  v_customer uuid;
  v_cust     public.customers;
  v_inv      public.sales_invoices;
  v_qty      numeric;
  v_avail    numeric;
  v_no       int := 0;
  v_line     uuid;
  v_today    date := private.company_today(v_company);
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_create_draft');
  if v_previous is not null then return v_previous; end if;
  select currency_code into v_currency from public.companies where id = v_company;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 500 then
    raise exception 'Select between 1 and 500 dispatched lines to invoice.' using errcode = 'P0001';
  end if;
  if (select count(distinct e ->> 'fulfilment_line_id') from jsonb_array_elements(p_lines) e) <> jsonb_array_length(p_lines) then
    raise exception 'A dispatch line was selected twice.' using errcode = 'P0001';
  end if;

  -- Lock the dispatch lines in a fixed order: concurrent drafts for the same
  -- dispatch serialise here and see each other's quantities.
  perform 1 from public.fulfilment_lines
  where company_id = v_company and id in (select (e ->> 'fulfilment_line_id')::uuid from jsonb_array_elements(p_lines) e)
  order by id for update;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    select fl.id, fl.company_id, so.customer_id, so.sales_order_number, so.currency, f.actual_dispatch_at
      into v_fl
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id join public.sales_orders so on so.id = f.sales_order_id
    where fl.id = (v_entry ->> 'fulfilment_line_id')::uuid and fl.company_id = v_company;
    if not found then
      raise exception 'A selected dispatch line was not found in your company.' using errcode = 'P0001';
    end if;
    if v_fl.actual_dispatch_at is null then
      raise exception 'Only dispatched quantities can be invoiced (reserved, picked or packed goods cannot).' using errcode = 'P0001';
    end if;
    if v_fl.customer_id is null then
      raise exception 'Sales order % has no customer record. Link the order to a customer with billing details before invoicing.', v_fl.sales_order_number using errcode = 'P0001';
    end if;
    if v_customer is not null and v_fl.customer_id <> v_customer then
      raise exception 'All lines of an invoice must belong to the same customer.' using errcode = 'P0001';
    end if;
    if v_fl.currency is not null and v_fl.currency <> v_currency then
      raise exception 'Sales order % is in %; invoices are issued in % only.', v_fl.sales_order_number, v_fl.currency, v_currency using errcode = 'P0001';
    end if;
    v_customer := v_fl.customer_id;
  end loop;

  select * into v_cust from public.customers where id = v_customer;
  insert into public.invoice_settings (company_id) values (v_company) on conflict do nothing;
  insert into public.sales_invoices (company_id, invoice_date, payment_terms_days, due_date, customer_id, customer_code_snapshot, customer_legal_name,
    seller_legal_name, currency, created_by, updated_by)
  values (v_company, v_today, coalesce(v_cust.payment_terms_days, v_s.default_payment_terms_days), v_today + coalesce(v_cust.payment_terms_days, v_s.default_payment_terms_days),
    v_customer, v_cust.customer_code, coalesce(v_cust.legal_name, v_cust.customer_name), '-', v_currency, auth.uid(), auth.uid())
  returning * into v_inv;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    select fl.*, f.sales_order_id, sol.unit, sol.unit_price_snapshot, p.sku, p.product_name, p.hsn_code, p.gst_rate, p.selling_price
      into v_fl
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    join public.sales_order_lines sol on sol.id = fl.sales_order_line_id join public.products p on p.id = fl.product_id
    where fl.id = (v_entry ->> 'fulfilment_line_id')::uuid;
    v_avail := coalesce(private.dispatch_line_invoiceable(v_fl.id, v_inv.id), 0);
    begin
      v_qty := coalesce(nullif(v_entry ->> 'quantity', '')::numeric, v_avail);
    exception when others then
      raise exception 'Quantities must be numbers.' using errcode = 'P0001';
    end;
    if v_avail <= 0 then
      raise exception '% line %: nothing is left to invoice from this dispatch.', (select fulfilment_number from public.fulfilments where id = v_fl.fulfilment_id), v_fl.line_no
        using errcode = 'P0001';
    end if;
    if v_qty <= 0 or v_qty <> round(v_qty, 3) or v_qty > v_avail then
      raise exception '% (%): invoice between 0 and % (dispatched and not yet invoiced).', v_fl.sku, (select fulfilment_number from public.fulfilments where id = v_fl.fulfilment_id), v_avail
        using errcode = 'P0001';
    end if;
    if v_qty < v_avail and not v_s.allow_partial_dispatch_invoicing then
      raise exception '% (%): company policy requires invoicing the whole dispatched quantity (%).', v_fl.sku, (select fulfilment_number from public.fulfilments where id = v_fl.fulfilment_id), v_avail
        using errcode = 'P0001';
    end if;
    v_no := v_no + 1;
    insert into public.sales_invoice_lines (company_id, invoice_id, line_no, line_type, product_id, sales_order_id, sales_order_line_id, fulfilment_line_id, sku,
      description, hsn_sac, unit, quantity, unit_price, gst_rate)
    values (v_company, v_inv.id, v_no, 'PRODUCT', v_fl.product_id, v_fl.sales_order_id, v_fl.sales_order_line_id, v_fl.id, v_fl.sku, v_fl.product_name,
      v_fl.hsn_code, v_fl.unit, v_qty, coalesce(v_fl.unit_price_snapshot, v_fl.selling_price), v_fl.gst_rate)
    returning id into v_line;
    insert into public.sales_invoice_dispatch_allocations (company_id, invoice_id, invoice_line_id, fulfilment_line_id, quantity, created_by)
    values (v_company, v_inv.id, v_line, v_fl.id, v_qty, auth.uid());
  end loop;

  perform private.invoice_refresh_snapshots(v_inv.id, true);
  select * into v_inv from public.sales_invoices where id = v_inv.id;
  perform private.invoice_apply_header(v_inv, p_header);
  perform private.invoice_recalculate(v_inv.id);
  perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'DRAFT_CREATED', null, 'DRAFT', null, jsonb_build_object('lines', v_no));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('invoice_id', v_inv.id, 'lines', v_no));
end;
$$;

-- Draft editing.
-- p_lines: [{line_id, quantity?, unit_price?, discount_percent?, discount_amount?}]
-- p_charge: {amount} adds / updates the configured other-charge line; {amount: 0} removes it; null leaves it.
-- p_remove_line_ids: product lines to drop from the draft.
create or replace function public.sales_invoice_update_draft(
  p_invoice_id      uuid,
  p_header          jsonb default null,
  p_lines           jsonb default null,
  p_charge          jsonb default null,
  p_remove_line_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.create');
  v_inv     public.sales_invoices;
  v_s       public.invoice_settings := private.billing_settings(v_company);
  v_entry   jsonb;
  v_line    public.sales_invoice_lines;
  v_qty     numeric;
  v_price   numeric;
  v_pct     numeric;
  v_amt     numeric;
  v_avail   numeric;
  v_charge  numeric;
begin
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  if v_inv.status <> 'DRAFT' then
    raise exception 'Only draft invoices can be edited (this one is %).', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
  end if;

  if p_remove_line_ids is not null and cardinality(p_remove_line_ids) > 0 then
    delete from public.sales_invoice_dispatch_allocations where invoice_id = v_inv.id and invoice_line_id = any(p_remove_line_ids);
    delete from public.sales_invoice_lines where invoice_id = v_inv.id and id = any(p_remove_line_ids) and line_type = 'PRODUCT';
  end if;

  perform 1 from public.fulfilment_lines where id in (select fulfilment_line_id from public.sales_invoice_lines where invoice_id = v_inv.id and fulfilment_line_id is not null)
  order by id for update;

  for v_entry in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into v_line from public.sales_invoice_lines where id = (v_entry ->> 'line_id')::uuid and invoice_id = v_inv.id;
    if not found then
      raise exception 'A line does not belong to this invoice.' using errcode = 'P0001';
    end if;
    begin
      v_qty := coalesce(nullif(v_entry ->> 'quantity', '')::numeric, v_line.quantity);
      v_price := case when v_entry ? 'unit_price' then nullif(v_entry ->> 'unit_price', '')::numeric else v_line.unit_price end;
      v_pct := coalesce(nullif(v_entry ->> 'discount_percent', '')::numeric, v_line.discount_percent);
      v_amt := coalesce(nullif(v_entry ->> 'discount_amount', '')::numeric, v_line.discount_amount);
    exception when others then
      raise exception 'Line %: quantity, price and discount must be numbers.', v_line.line_no using errcode = 'P0001';
    end;
    if v_price is not null and (v_price < 0 or v_price <> round(v_price, 2)) then
      raise exception 'Line %: the price must be zero or more with at most 2 decimals.', v_line.line_no using errcode = 'P0001';
    end if;
    if (v_pct <> 0 or v_amt <> 0) and not v_s.allow_line_discount then
      raise exception 'Line discounts are not enabled in Invoice Settings.' using errcode = 'P0001';
    end if;
    if v_pct < 0 or v_pct > 100 or v_amt < 0 or (v_pct > 0 and v_amt > 0) then
      raise exception 'Line %: give either a discount percentage (0-100) or an amount, not both.', v_line.line_no using errcode = 'P0001';
    end if;
    if v_line.line_type = 'PRODUCT' and v_qty <> v_line.quantity then
      v_avail := coalesce(private.dispatch_line_invoiceable(v_line.fulfilment_line_id, v_inv.id), 0);
      if v_qty <= 0 or v_qty <> round(v_qty, 3) or v_qty > v_avail then
        raise exception 'Line % (%): invoice between 0 and % (dispatched and not on another invoice).', v_line.line_no, v_line.sku, v_avail using errcode = 'P0001';
      end if;
      if v_qty < v_avail and not v_s.allow_partial_dispatch_invoicing then
        raise exception 'Line % (%): company policy requires invoicing the whole dispatched quantity (%).', v_line.line_no, v_line.sku, v_avail using errcode = 'P0001';
      end if;
      update public.sales_invoice_dispatch_allocations set quantity = v_qty, updated_at = now() where invoice_line_id = v_line.id;
    end if;
    update public.sales_invoice_lines set quantity = case when line_type = 'PRODUCT' then v_qty else quantity end, unit_price = v_price,
      discount_percent = v_pct, discount_amount = case when v_pct > 0 then 0 else v_amt end
    where id = v_line.id;
  end loop;

  if p_charge is not null then
    begin
      v_charge := coalesce(nullif(p_charge ->> 'amount', '')::numeric, 0);
    exception when others then
      raise exception 'The charge amount must be a number.' using errcode = 'P0001';
    end;
    if v_charge < 0 or v_charge <> round(v_charge, 2) then
      raise exception 'The charge must be zero or more with at most 2 decimals.' using errcode = 'P0001';
    end if;
    delete from public.sales_invoice_lines where invoice_id = v_inv.id and line_type = 'CHARGE';
    if v_charge > 0 then
      if not v_s.other_charge_enabled then
        raise exception 'Other charges are not configured in Invoice Settings.' using errcode = 'P0001';
      end if;
      insert into public.sales_invoice_lines (company_id, invoice_id, line_no, line_type, description, hsn_sac, quantity, unit_price, gst_rate)
      values (v_company, v_inv.id, coalesce((select max(line_no) from public.sales_invoice_lines where invoice_id = v_inv.id), 0) + 1, 'CHARGE',
        v_s.other_charge_label, v_s.other_charge_sac, 1, v_charge, v_s.other_charge_gst_rate);
    end if;
  end if;

  if p_header is not null then
    perform private.invoice_apply_header(v_inv, p_header);
  end if;
  perform private.invoice_refresh_snapshots(v_inv.id, false);
  perform private.invoice_recalculate(v_inv.id);
  perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'DRAFT_UPDATED', 'DRAFT', 'DRAFT', null,
    jsonb_build_object('header', p_header, 'lines', p_lines, 'charge', p_charge, 'removed', p_remove_line_ids));
  if not exists (select 1 from public.sales_invoice_lines where invoice_id = v_inv.id and line_type = 'PRODUCT') then
    raise exception 'An invoice needs at least one dispatched product line. Discard the draft instead.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('invoice_id', v_inv.id, 'issues', private.invoice_issues(v_inv.id));
end;
$$;

create or replace function public.sales_invoice_validate(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('invoices.read');
begin
  if not exists (select 1 from public.sales_invoices where id = p_invoice_id and company_id = v_company) then
    raise exception 'Invoice not found in your company.' using errcode = 'P0001';
  end if;
  return private.invoice_issues(p_invoice_id);
end;
$$;

-- SUBMIT | RETURN_TO_DRAFT | ACK_TAX_REVIEW | REFRESH | DISCARD | CANCEL
create or replace function public.sales_invoice_action(p_invoice_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_inv     public.sales_invoices;
  v_s       public.invoice_settings;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_issues  jsonb;
  v_to      text;
  v_count   int;
begin
  case p_action
    when 'SUBMIT' then v_company := private.require_permission('invoices.create');
    when 'RETURN_TO_DRAFT' then v_company := private.require_any_permission(array['invoices.create', 'invoices.approve']);
    when 'ACK_TAX_REVIEW' then v_company := private.require_permission('invoices.approve');
    when 'REFRESH' then v_company := private.require_permission('invoices.create');
    when 'DISCARD' then v_company := private.require_permission('invoices.create');
    when 'CANCEL' then v_company := private.require_permission('invoices.cancel');
    else raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  v_s := private.billing_settings(v_company);
  v_to := v_inv.status;

  if p_action = 'SUBMIT' then
    if v_inv.status <> 'DRAFT' then
      raise exception 'Only drafts can be submitted for approval.' using errcode = 'P0001';
    end if;
    v_issues := private.invoice_issues(v_inv.id);
    if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
      raise exception 'Resolve the validation problems first: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK')
        using errcode = 'P0001';
    end if;
    v_to := 'PENDING_APPROVAL';
    update public.sales_invoices set status = v_to, submitted_by = auth.uid(), submitted_at = now() where id = v_inv.id;
  elsif p_action = 'RETURN_TO_DRAFT' then
    if v_inv.status <> 'PENDING_APPROVAL' then
      raise exception 'Only invoices pending approval can be returned to draft.' using errcode = 'P0001';
    end if;
    v_to := 'DRAFT';
    update public.sales_invoices set status = v_to, submitted_by = null, submitted_at = null where id = v_inv.id;
  elsif p_action = 'ACK_TAX_REVIEW' then
    if v_inv.status not in ('DRAFT', 'PENDING_APPROVAL') then
      raise exception 'Tax review can only be acknowledged before issue.' using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Record the tax review conclusion.' using errcode = 'P0001';
    end if;
    update public.sales_invoices set tax_review_note = left(v_note, 1000), tax_review_by = auth.uid(), tax_review_at = now() where id = v_inv.id;
  elsif p_action = 'REFRESH' then
    if v_inv.status <> 'DRAFT' then
      raise exception 'Only drafts can be refreshed.' using errcode = 'P0001';
    end if;
    update public.sales_invoice_lines l set hsn_sac = p.hsn_code, gst_rate = p.gst_rate, description = p.product_name, sku = p.sku
    from public.products p where l.invoice_id = v_inv.id and l.product_id = p.id;
    update public.sales_invoice_lines set hsn_sac = v_s.other_charge_sac, gst_rate = v_s.other_charge_gst_rate, description = coalesce(v_s.other_charge_label, description)
    where invoice_id = v_inv.id and line_type = 'CHARGE';
    perform private.invoice_refresh_snapshots(v_inv.id, true);
    update public.sales_invoices set tax_review_note = null, tax_review_by = null, tax_review_at = null where id = v_inv.id;
    perform private.invoice_recalculate(v_inv.id);
  elsif p_action = 'DISCARD' then
    if v_inv.status not in ('DRAFT', 'PENDING_APPROVAL') then
      raise exception 'Only drafts can be discarded. Issued invoices are cancelled instead.' using errcode = 'P0001';
    end if;
    v_to := 'DISCARDED';
    update public.sales_invoices set status = v_to where id = v_inv.id;
  else
    if v_inv.status <> 'ISSUED' then
      raise exception 'Only issued invoices can be cancelled (this one is %).', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Enter the reason for cancelling the invoice.' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.invoice_payment_allocations where invoice_id = v_inv.id and status = 'ACTIVE';
    if v_count > 0 then
      raise exception 'Invoice % has % active payment allocation(s). Reverse them first; nothing is undone silently.', v_inv.invoice_number, v_count using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.invoice_adjustment_notes where original_invoice_id = v_inv.id and status in ('PENDING_APPROVAL', 'ISSUED', 'DRAFT');
    if v_count > 0 then
      raise exception 'Invoice % has credit/debit notes. Cancel those first or correct the invoice with a note instead.', v_inv.invoice_number using errcode = 'P0001';
    end if;
    v_to := 'CANCELLED';
    update public.sales_invoices set status = v_to, cancelled_by = auth.uid(), cancelled_at = now(), cancellation_reason = left(v_note, 1000) where id = v_inv.id;
  end if;

  perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, p_action, v_inv.status, v_to, v_note,
    jsonb_build_object('invoice_number', v_inv.invoice_number));
  return jsonb_build_object('status', v_to);
end;
$$;

-- Issue: re-checks invoiceable quantities under lock, validates, assigns the
-- official number atomically and freezes the invoice.
create or replace function public.sales_invoice_issue(p_invoice_id uuid, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('invoices.issue');
  v_previous jsonb;
  v_inv      public.sales_invoices;
  v_s        public.invoice_settings;
  v_issues   jsonb;
  v_number   jsonb;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_invoice_issue');
  if v_previous is not null then return v_previous; end if;
  v_inv := private.lock_invoice(v_company, p_invoice_id);
  v_s := private.billing_settings(v_company);
  if v_s.require_approval then
    if v_inv.status <> 'PENDING_APPROVAL' then
      raise exception 'Company policy requires approval: submit the draft for approval first (invoice is %).', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
    end if;
    perform private.require_permission('invoices.approve');
    if v_inv.submitted_by = auth.uid() then
      raise exception 'Segregation of duties: the person who submitted the invoice cannot approve and issue it.' using errcode = '42501';
    end if;
  elsif v_inv.status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception 'Invoice is already %.', replace(lower(v_inv.status), '_', ' ') using errcode = 'P0001';
  end if;

  -- Lock the dispatch lines and re-validate everything on the current data.
  perform 1 from public.fulfilment_lines where id in (select fulfilment_line_id from public.sales_invoice_lines where invoice_id = v_inv.id and fulfilment_line_id is not null)
  order by id for update;
  perform private.invoice_recalculate(v_inv.id);
  select * into v_inv from public.sales_invoices where id = v_inv.id;
  v_issues := private.invoice_issues(v_inv.id);
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK') then
    raise exception 'The invoice cannot be issued: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'BLOCK')
      using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'REVIEW') and v_inv.tax_review_at is null then
    raise exception 'Tax review required before issue: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i where i ->> 'severity' = 'REVIEW')
      using errcode = 'P0001';
  end if;
  if v_inv.grand_total <= 0 then
    raise exception 'The invoice total must be greater than zero.' using errcode = 'P0001';
  end if;

  v_number := private.next_billing_number(v_company, 'INVOICE', v_inv.invoice_date);
  update public.sales_invoices set
    status = 'ISSUED', invoice_number = v_number ->> 'number', numbering_scope = v_number ->> 'scope', financial_year = v_number ->> 'financial_year',
    due_date = invoice_date + payment_terms_days, issued_by = auth.uid(), issued_at = now(),
    terms_snapshot = v_s.terms_text, footer_snapshot = v_s.footer_text,
    bank_snapshot = case when v_s.show_bank_details then jsonb_build_object('account_name', v_s.bank_account_name, 'bank_name', v_s.bank_name,
      'account_number', v_s.bank_account_number, 'ifsc', v_s.bank_ifsc, 'branch', v_s.bank_branch) end
  where id = v_inv.id;
  perform private.log_billing_event(v_company, 'INVOICE', v_inv.id, v_inv.id, 'ISSUED', v_inv.status, 'ISSUED', null,
    jsonb_build_object('invoice_number', v_number ->> 'number', 'grand_total', v_inv.grand_total, 'issues_acknowledged', v_issues));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'invoice_id', v_inv.id, 'invoice_number', v_number ->> 'number', 'financial_year', v_number ->> 'financial_year', 'grand_total', v_inv.grand_total));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sales_invoice_create_draft(jsonb, jsonb, uuid)', 'public.sales_invoice_update_draft(uuid, jsonb, jsonb, jsonb, uuid[])',
    'public.sales_invoice_validate(uuid)', 'public.sales_invoice_action(uuid, text, text)', 'public.sales_invoice_issue(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
