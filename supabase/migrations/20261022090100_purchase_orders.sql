-- =============================================================================
-- Supplier purchase orders and goods receipts
--
-- No purchase order, goods receipt or payables tables existed (the Supplier
-- Purchase Orders page was a layout preview). This migration is ADDITIVE:
--
--   purchase_orders            header with supplier / buyer / delivery snapshots,
--                              tax treatment and totals (calculated here, never
--                              trusted from the browser)
--   purchase_order_lines       goods (inventory), service and charge lines with
--                              product, price and GST snapshots
--   purchase_order_events      append-only history (mirrored to audit_logs)
--   purchase_order_amendments  previous version of an amended order
--   goods_receipts / _lines    receipts against approved orders. Accepted goods
--                              are posted to the EXISTING stock ledger through
--                              private.post_movement in the same transaction.
--
-- Clients have SELECT only (purchases.read). Every change goes through the
-- SECURITY DEFINER functions below, which take the company from the caller's
-- profile, check permissions, lock rows and validate.
--
-- Existing objects changed (behaviour kept, one value added):
--   inventory_transactions document_type  + 'PURCHASE_ORDER'
--   public.inventory_reverse_transaction   refuses PURCHASE_ORDER postings
--                                          (reverse them from the goods receipt)
--   public.approval_inbox                  lists purchase orders awaiting approval
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies (id) on delete restrict,
  po_number                  text not null check (po_number ~ '^PO-[0-9]{6,}$'),
  revision                   integer not null default 0 check (revision between 0 and 999),
  status                     text not null default 'DRAFT' check (status in
                               ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  -- Supplier (reference + snapshot taken while the order is a draft)
  supplier_id                uuid not null,
  supplier_code              text not null,
  supplier_name              text not null,
  supplier_gstin             text,
  supplier_pan               text,
  supplier_state_code        text,
  supplier_country           text not null,
  supplier_billing_address   text,
  supplier_shipping_address  text,
  supplier_contact_person    text,
  supplier_email             text,
  supplier_phone             text,
  -- Buyer (the company) snapshot
  buyer_legal_name           text,
  buyer_address              text,
  buyer_gstin                text,
  place_of_supply_state_code text check (place_of_supply_state_code is null or place_of_supply_state_code ~ '^[0-9]{2}$'),
  -- INTRA_STATE: CGST + SGST. INTER_STATE: IGST. NO_GST: supplier has no GSTIN
  -- (no GST charged on the PO). IMPORT: overseas supplier (customs duty / IGST
  -- on import is not calculated here). UNRESOLVED: company GSTIN missing.
  tax_treatment              text not null default 'UNRESOLVED'
                             check (tax_treatment in ('INTRA_STATE', 'INTER_STATE', 'NO_GST', 'IMPORT', 'UNRESOLVED')),
  po_date                    date not null,
  expected_delivery_date     date,
  warehouse_id               uuid,
  warehouse_code             text,
  warehouse_name             text,
  delivery_address           text,
  purchase_type              text not null check (purchase_type in ('RAW_MATERIAL', 'FINISHED_GOODS', 'PACKAGING', 'MACHINERY', 'SERVICES', 'OTHER')),
  currency_code              text not null default 'INR' check (currency_code = 'INR'),
  payment_terms              text not null check (payment_terms in ('IMMEDIATE', 'DAYS_7', 'DAYS_15', 'DAYS_30', 'DAYS_45', 'CUSTOM')),
  custom_payment_days        integer check (custom_payment_days is null or custom_payment_days between 1 and 365),
  payment_terms_overridden   boolean not null default false,
  reference_number           text check (reference_number is null or length(reference_number) <= 100),
  delivery_instructions      text check (delivery_instructions is null or length(delivery_instructions) <= 2000),
  internal_notes             text check (internal_notes is null or length(internal_notes) <= 2000),
  purchase_conditions        text check (purchase_conditions is null or length(purchase_conditions) <= 4000),
  gross_total                numeric(16,2) not null default 0,
  discount_total             numeric(16,2) not null default 0,
  taxable_total              numeric(16,2) not null default 0,
  other_charges_total        numeric(16,2) not null default 0,
  cgst_total                 numeric(16,2) not null default 0,
  sgst_total                 numeric(16,2) not null default 0,
  igst_total                 numeric(16,2) not null default 0,
  round_off                  numeric(6,2) not null default 0 check (round_off between -1 and 1),
  grand_total                numeric(16,2) not null default 0,
  submitted_by               uuid,
  submitted_at               timestamptz,
  approved_by                uuid,
  approved_at                timestamptz,
  rejected_by                uuid,
  rejected_at                timestamptz,
  rejection_reason           text check (rejection_reason is null or length(rejection_reason) <= 1000),
  sent_by                    uuid,
  sent_at                    timestamptz,
  cancelled_by               uuid,
  cancelled_at               timestamptz,
  cancel_reason              text check (cancel_reason is null or length(cancel_reason) <= 1000),
  closed_by                  uuid,
  closed_at                  timestamptz,
  close_reason               text check (close_reason is null or length(close_reason) <= 1000),
  created_by                 uuid,
  updated_by                 uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint purchase_orders_number_unique unique (company_id, po_number),
  constraint purchase_orders_id_company_unique unique (id, company_id),
  constraint purchase_orders_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict,
  constraint purchase_orders_warehouse_fk foreign key (warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict,
  constraint purchase_orders_dates check (expected_delivery_date is null or expected_delivery_date >= po_date),
  constraint purchase_orders_custom_terms check ((payment_terms = 'CUSTOM') = (custom_payment_days is not null)),
  constraint purchase_orders_totals check (taxable_total = gross_total - discount_total
                                           and grand_total = taxable_total + cgst_total + sgst_total + igst_total + round_off),
  -- Never CGST/SGST and IGST on the same order.
  constraint purchase_orders_tax_exclusive check (not (igst_total <> 0 and (cgst_total <> 0 or sgst_total <> 0)) and cgst_total = sgst_total)
);

create index if not exists purchase_orders_company_status_idx on public.purchase_orders (company_id, status);
create index if not exists purchase_orders_company_date_idx on public.purchase_orders (company_id, po_date desc);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders (company_id, supplier_id);

comment on table public.purchase_orders is
  'Supplier purchase orders. Written only by purchase_order_* functions. Totals are calculated in the database from the lines.';

create table if not exists public.purchase_order_lines (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  purchase_order_id      uuid not null,
  line_no                integer not null check (line_no between 1 and 999),
  -- GOODS: stocked product, received into inventory. SERVICE: confirmed on a
  -- receipt but never posted to stock. CHARGE: freight, packing etc.
  line_type              text not null check (line_type in ('GOODS', 'SERVICE', 'CHARGE')),
  product_id             uuid,
  sku                    text,
  description            text not null check (length(btrim(description)) between 1 and 500),
  hsn_sac                text check (hsn_sac is null or hsn_sac ~ '^[0-9]{4,8}$'),
  unit                   text not null check (unit ~ '^[A-Z]{1,10}$'),
  ordered_quantity       numeric(14,3) not null check (ordered_quantity > 0),
  unit_price             numeric(16,4) check (unit_price is null or unit_price >= 0),
  -- Product master price when the line was added (for comparison).
  master_cost_snapshot   numeric(14,4),
  discount_percent       numeric(5,2) check (discount_percent is null or discount_percent between 0 and 100),
  discount_value_input   numeric(16,2) not null default 0 check (discount_value_input >= 0),
  gross_amount           numeric(16,2) not null default 0,
  discount_amount        numeric(16,2) not null default 0 check (discount_amount >= 0),
  taxable_value          numeric(16,2) not null default 0,
  gst_rate               numeric(5,2) check (gst_rate is null or gst_rate between 0 and 100),
  cgst_rate              numeric(6,3) not null default 0,
  sgst_rate              numeric(6,3) not null default 0,
  igst_rate              numeric(5,2) not null default 0,
  cgst_amount            numeric(16,2) not null default 0,
  sgst_amount            numeric(16,2) not null default 0,
  igst_amount            numeric(16,2) not null default 0,
  line_total             numeric(16,2) not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint purchase_order_lines_po_fk foreign key (purchase_order_id, company_id)
    references public.purchase_orders (id, company_id) on delete restrict,
  constraint purchase_order_lines_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint purchase_order_lines_no_unique unique (purchase_order_id, line_no) deferrable initially deferred,
  constraint purchase_order_lines_id_po_unique unique (id, purchase_order_id),
  constraint purchase_order_lines_goods_product check (line_type <> 'GOODS' or product_id is not null),
  constraint purchase_order_lines_discount check (not (coalesce(discount_percent, 0) > 0 and discount_value_input > 0)),
  constraint purchase_order_lines_amounts check (taxable_value = gross_amount - discount_amount
    and line_total = taxable_value + cgst_amount + sgst_amount + igst_amount and cgst_amount = sgst_amount
    and not (igst_amount <> 0 and cgst_amount <> 0))
);

create index if not exists purchase_order_lines_po_idx on public.purchase_order_lines (purchase_order_id, line_no);
create index if not exists purchase_order_lines_product_idx on public.purchase_order_lines (company_id, product_id) where product_id is not null;

create table if not exists public.purchase_order_events (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  event_type        text not null check (event_type ~ '^[A-Z_]{3,40}$'),
  from_status       text,
  to_status         text,
  note              text check (note is null or length(note) <= 1000),
  details           jsonb not null default '{}'::jsonb,
  actor_user_id     uuid,
  created_at        timestamptz not null default now(),
  constraint purchase_order_events_po_fk foreign key (purchase_order_id, company_id)
    references public.purchase_orders (id, company_id) on delete restrict
);

create index if not exists purchase_order_events_po_idx on public.purchase_order_events (purchase_order_id, created_at);

create table if not exists public.purchase_order_amendments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  from_revision     integer not null,
  to_revision       integer not null,
  reason            text not null check (length(btrim(reason)) between 5 and 1000),
  previous_version  jsonb not null,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  constraint purchase_order_amendments_po_fk foreign key (purchase_order_id, company_id)
    references public.purchase_orders (id, company_id) on delete restrict,
  constraint purchase_order_amendments_revision_unique unique (purchase_order_id, to_revision)
);

create table if not exists public.goods_receipts (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies (id) on delete restrict,
  receipt_number             text not null check (receipt_number ~ '^GRN-[0-9]{6,}$'),
  purchase_order_id          uuid not null,
  po_revision                integer not null,
  supplier_id                uuid not null,
  warehouse_id               uuid,
  receipt_date               date not null,
  supplier_document_number   text check (supplier_document_number is null or length(supplier_document_number) <= 100),
  supporting_document_ref    text check (supporting_document_ref is null or length(supporting_document_ref) <= 200),
  notes                      text check (notes is null or length(notes) <= 2000),
  status                     text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_transaction_ids   text[],
  reversal_reason            text,
  reversed_by                uuid,
  reversed_at                timestamptz,
  created_by                 uuid,
  created_at                 timestamptz not null default now(),
  constraint goods_receipts_number_unique unique (company_id, receipt_number),
  constraint goods_receipts_id_company_unique unique (id, company_id),
  constraint goods_receipts_po_fk foreign key (purchase_order_id, company_id) references public.purchase_orders (id, company_id) on delete restrict,
  constraint goods_receipts_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict
);

create index if not exists goods_receipts_po_idx on public.goods_receipts (purchase_order_id, receipt_date);
create index if not exists goods_receipts_company_date_idx on public.goods_receipts (company_id, receipt_date desc);

create table if not exists public.goods_receipt_lines (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  goods_receipt_id         uuid not null,
  purchase_order_id        uuid not null,
  purchase_order_line_id   uuid not null,
  line_type                text not null check (line_type in ('GOODS', 'SERVICE')),
  product_id               uuid,
  unit                     text not null,
  received_quantity        numeric(14,3) not null check (received_quantity > 0),
  accepted_quantity        numeric(14,3) not null check (accepted_quantity >= 0),
  rejected_quantity        numeric(14,3) not null check (rejected_quantity >= 0),
  inspection_status        text not null check (inspection_status in ('ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED')),
  rejection_reason         text check (rejection_reason is null or length(rejection_reason) <= 500),
  accepted_location_id     uuid,
  rejected_location_id     uuid,
  batch_id                 uuid,
  batch_number             text,
  manufacturing_date       date,
  expiry_date              date,
  -- Reference only: the inventory module does not track individual serial numbers.
  serial_numbers           text check (serial_numbers is null or length(serial_numbers) <= 2000),
  unit_cost                numeric(14,4),
  accepted_transaction_id  uuid references public.inventory_transactions (id) on delete restrict,
  rejected_transaction_id  uuid references public.inventory_transactions (id) on delete restrict,
  over_receipt_reason      text,
  created_at               timestamptz not null default now(),
  constraint goods_receipt_lines_receipt_fk foreign key (goods_receipt_id, company_id) references public.goods_receipts (id, company_id) on delete restrict,
  constraint goods_receipt_lines_po_line_fk foreign key (purchase_order_line_id, purchase_order_id)
    references public.purchase_order_lines (id, purchase_order_id) on delete restrict,
  constraint goods_receipt_lines_split check (accepted_quantity + rejected_quantity = received_quantity),
  constraint goods_receipt_lines_reject_reason check (rejected_quantity = 0 or rejection_reason is not null),
  constraint goods_receipt_lines_service_no_stock check (line_type = 'GOODS' or (accepted_transaction_id is null and rejected_transaction_id is null))
);

create index if not exists goods_receipt_lines_receipt_idx on public.goods_receipt_lines (goods_receipt_id);
create index if not exists goods_receipt_lines_po_line_idx on public.goods_receipt_lines (purchase_order_line_id);

-- -----------------------------------------------------------------------------
-- 2. Immutability, timestamps and audit
-- -----------------------------------------------------------------------------
drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function private.set_updated_at();
drop trigger if exists purchase_order_lines_set_updated_at on public.purchase_order_lines;
create trigger purchase_order_lines_set_updated_at before update on public.purchase_order_lines
  for each row execute function private.set_updated_at();
drop trigger if exists purchase_order_events_append_only on public.purchase_order_events;
create trigger purchase_order_events_append_only before update or delete on public.purchase_order_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists purchase_order_amendments_append_only on public.purchase_order_amendments;
create trigger purchase_order_amendments_append_only before update or delete on public.purchase_order_amendments
  for each row execute function private.prevent_history_mutation();
drop trigger if exists goods_receipts_guard on public.goods_receipts;
create trigger goods_receipts_guard before update or delete on public.goods_receipts
  for each row execute function private.guard_posted_document();
drop trigger if exists goods_receipt_lines_immutable on public.goods_receipt_lines;
create trigger goods_receipt_lines_immutable before update or delete on public.goods_receipt_lines
  for each row execute function private.prevent_history_mutation();
-- Every purchase order event is also written to the audit log.
drop trigger if exists audit_mirror on public.purchase_order_events;
create trigger audit_mirror after insert on public.purchase_order_events
  for each row execute function private.audit_mirror_event('purchasing', 'purchase_order', 'purchase_order_id');

-- -----------------------------------------------------------------------------
-- 3. RLS: read-only for clients with purchases.read
-- -----------------------------------------------------------------------------
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_order_events enable row level security;
alter table public.purchase_order_amendments enable row level security;
alter table public.goods_receipts enable row level security;
alter table public.goods_receipt_lines enable row level security;

revoke all on table public.purchase_orders, public.purchase_order_lines, public.purchase_order_events, public.purchase_order_amendments,
  public.goods_receipts, public.goods_receipt_lines from anon, authenticated;
grant select on public.purchase_orders, public.purchase_order_lines, public.purchase_order_events, public.purchase_order_amendments,
  public.goods_receipts, public.goods_receipt_lines to authenticated;
grant all on table public.purchase_orders, public.purchase_order_lines, public.purchase_order_events, public.purchase_order_amendments,
  public.goods_receipts, public.goods_receipt_lines to service_role;

drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));
drop policy if exists purchase_order_lines_select on public.purchase_order_lines;
create policy purchase_order_lines_select on public.purchase_order_lines for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));
drop policy if exists purchase_order_events_select on public.purchase_order_events;
create policy purchase_order_events_select on public.purchase_order_events for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));
drop policy if exists purchase_order_amendments_select on public.purchase_order_amendments;
create policy purchase_order_amendments_select on public.purchase_order_amendments for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));
drop policy if exists goods_receipts_select on public.goods_receipts;
create policy goods_receipts_select on public.goods_receipts for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));
drop policy if exists goods_receipt_lines_select on public.goods_receipt_lines;
create policy goods_receipt_lines_select on public.goods_receipt_lines for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));

-- -----------------------------------------------------------------------------
-- 4. Inventory: new document type; generic reversal refuses PO postings
-- -----------------------------------------------------------------------------
alter table public.inventory_transactions drop constraint if exists inventory_transactions_document_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_document_type_check check (
  document_type is null or document_type in
  ('OPENING', 'ADJUSTMENT', 'COUNT', 'RESERVATION', 'TRANSFER', 'RECEIPT', 'ISSUE', 'REVERSAL', 'PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO',
   'SALES_ORDER', 'CUSTOMER_RETURN', 'PURCHASE_ORDER'));

create or replace function public.inventory_reverse_transaction(
  p_transaction_id  uuid,
  p_reason          text,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.approve_adjustment');
  v_previous jsonb;
  v_tx       public.inventory_transactions;
  v_numbers  text[];
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'reversal');
  if v_previous is not null then return v_previous; end if;

  select * into v_tx from public.inventory_transactions where id = p_transaction_id and company_id = v_company;
  if not found then
    raise exception 'Transaction not found in your company.' using errcode = 'P0001';
  end if;
  if v_tx.document_type in ('PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO', 'SALES_ORDER', 'CUSTOMER_RETURN', 'PURCHASE_ORDER') then
    raise exception 'Transaction % belongs to a %. Reverse it from that order so it stays consistent.',
      v_tx.transaction_number,
      case v_tx.document_type when 'PRODUCTION' then 'production order' when 'OUTSOURCING' then 'outsourcing order'
        when 'CUSTOMER_PO' then 'customer purchase order' when 'SALES_ORDER' then 'sales order dispatch'
        when 'PURCHASE_ORDER' then 'supplier purchase order goods receipt'
        else 'customer return' end
      using errcode = 'P0001';
  end if;

  v_numbers := private.reverse_ledger_transaction(v_company, p_transaction_id, p_reason);

  perform private.write_audit_log(v_company, 'inventory.transaction_reversed', 'inventory_transaction', v_tx.id::text,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Helpers
-- -----------------------------------------------------------------------------
-- company_settings 'purchases.round_off_enabled' (boolean, default false).
create or replace function private.purchase_policy(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('round_off_enabled', coalesce((
    select case when jsonb_typeof(setting_value) = 'boolean' then (setting_value)::text::boolean end
    from public.company_settings where company_id = p_company and setting_key = 'purchases.round_off_enabled'), false));
$$;

create or replace function private.purchase_json_num(p jsonb, p_key text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then return null; end if;
  if jsonb_typeof(p -> p_key) = 'number' then return (p ->> p_key)::numeric; end if;
  if jsonb_typeof(p -> p_key) = 'string' then
    if btrim(p ->> p_key) = '' then return null; end if;
    if btrim(p ->> p_key) ~ '^-?[0-9]+(\.[0-9]+)?$' then return btrim(p ->> p_key)::numeric; end if;
  end if;
  raise exception '% must be a number.', p_label using errcode = 'P0001';
end;
$$;

create or replace function private.purchase_json_uuid(p jsonb, p_key text, p_label text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' or btrim(p ->> p_key) = '' then return null; end if;
  if (p ->> p_key) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return (p ->> p_key)::uuid; end if;
  raise exception '% is not valid.', p_label using errcode = 'P0001';
end;
$$;

create or replace function private.purchase_json_date(p jsonb, p_key text, p_label text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' or btrim(p ->> p_key) = '' then return null; end if;
  if (p ->> p_key) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
      return (p ->> p_key)::date;
    exception when others then null;
    end;
  end if;
  raise exception '% must be a valid date (YYYY-MM-DD).', p_label using errcode = 'P0001';
end;
$$;

create or replace function private.purchase_text(p jsonb, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(coalesce(p ->> p_key, '')), '');
$$;

create or replace function private.log_purchase_event(
  p_company uuid, p_po uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.purchase_order_events (company_id, purchase_order_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_po, p_event, p_from, p_to, left(nullif(btrim(coalesce(p_note, '')), ''), 1000), coalesce(p_details, '{}'::jsonb), auth.uid());
end;
$$;

-- Quantities received on a PO line from POSTED receipts (never a stored counter).
create or replace function private.po_line_receipts(p_line uuid)
returns table (received numeric, accepted numeric, rejected numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.received_quantity), 0), coalesce(sum(l.accepted_quantity), 0), coalesce(sum(l.rejected_quantity), 0)
  from public.goods_receipt_lines l
  join public.goods_receipts r on r.id = l.goods_receipt_id
  where l.purchase_order_line_id = p_line and r.status = 'POSTED';
$$;

-- Copies supplier, buyer and delivery details onto a DRAFT and sets the tax
-- treatment. Place of supply = the company's GST registration state.
create or replace function private.po_refresh_snapshots(p_po uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po  public.purchase_orders;
  v_s   public.suppliers;
  v_co  public.companies;
  v_w   public.warehouses;
begin
  select * into v_po from public.purchase_orders where id = p_po;
  select * into v_s from public.suppliers where id = v_po.supplier_id;
  select * into v_co from public.companies where id = v_po.company_id;
  select * into v_w from public.warehouses where id = v_po.warehouse_id;
  update public.purchase_orders set
    supplier_code = v_s.supplier_code, supplier_name = v_s.legal_name, supplier_gstin = v_s.gstin,
    supplier_pan = coalesce(v_s.pan, case when v_s.gstin is not null then substr(v_s.gstin, 3, 10) end),
    supplier_state_code = coalesce(left(v_s.gstin, 2), v_s.state_code), supplier_country = v_s.country,
    supplier_billing_address = v_s.billing_address, supplier_shipping_address = v_s.shipping_address,
    supplier_contact_person = v_s.contact_person, supplier_email = v_s.email, supplier_phone = v_s.phone,
    buyer_legal_name = v_co.legal_name, buyer_address = v_co.legal_address, buyer_gstin = v_co.gstin,
    place_of_supply_state_code = left(v_co.gstin, 2),
    tax_treatment = case
      when lower(btrim(v_s.country)) <> 'india' then 'IMPORT'
      when v_s.gstin is null then 'NO_GST'
      when v_co.gstin is null then 'UNRESOLVED'
      when left(v_s.gstin, 2) = left(v_co.gstin, 2) then 'INTRA_STATE'
      else 'INTER_STATE' end,
    warehouse_code = v_w.warehouse_code, warehouse_name = v_w.warehouse_name, delivery_address = v_w.address
  where id = p_po;
end;
$$;

-- Recomputes every line and the totals from quantities, prices, discounts,
-- GST rates and the tax treatment. Same rounding as src/features/purchasing/po-calc.ts:
--   gross    = round(qty x price, 2)
--   discount = round(gross x % / 100, 2) or the entered amount (capped at gross)
--   taxable  = gross - discount
--   CGST = SGST = round(taxable x rate/2 / 100, 2) intra-state; IGST = round(taxable x rate / 100, 2) inter-state
--   grand    = sum(line totals), rounded to the rupee only when purchases.round_off_enabled
create or replace function private.po_recalculate(p_po uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po    public.purchase_orders;
  v_round boolean;
  v_sum   numeric;
  v_grand numeric;
begin
  select * into v_po from public.purchase_orders where id = p_po;
  v_round := (private.purchase_policy(v_po.company_id) ->> 'round_off_enabled')::boolean;

  update public.purchase_order_lines l set
    gross_amount = x.gross, discount_amount = x.discount, taxable_value = x.gross - x.discount,
    cgst_rate = x.half, sgst_rate = x.half, igst_rate = x.full,
    cgst_amount = round((x.gross - x.discount) * x.half / 100, 2),
    sgst_amount = round((x.gross - x.discount) * x.half / 100, 2),
    igst_amount = round((x.gross - x.discount) * x.full / 100, 2),
    line_total = (x.gross - x.discount) + 2 * round((x.gross - x.discount) * x.half / 100, 2) + round((x.gross - x.discount) * x.full / 100, 2)
  from (
    select y.id, y.gross,
      least(case when coalesce(y.discount_percent, 0) > 0 then round(y.gross * y.discount_percent / 100, 2) else y.discount_value_input end, y.gross) as discount,
      case when v_po.tax_treatment = 'INTRA_STATE' and y.gst_rate is not null then y.gst_rate / 2 else 0 end as half,
      case when v_po.tax_treatment = 'INTER_STATE' and y.gst_rate is not null then y.gst_rate else 0 end as full
    from (select pl.*, round(pl.ordered_quantity * coalesce(pl.unit_price, 0), 2) as gross
          from public.purchase_order_lines pl where pl.purchase_order_id = p_po) y
  ) x
  where l.id = x.id;

  select coalesce(sum(line_total), 0) into v_sum from public.purchase_order_lines where purchase_order_id = p_po;
  v_grand := case when v_round then round(v_sum, 0) else v_sum end;
  update public.purchase_orders o set
    gross_total = t.gross, discount_total = t.discount, taxable_total = t.taxable, other_charges_total = t.charges,
    cgst_total = t.cgst, sgst_total = t.sgst, igst_total = t.igst, round_off = v_grand - v_sum, grand_total = v_grand
  from (
    select coalesce(sum(gross_amount), 0) as gross, coalesce(sum(discount_amount), 0) as discount, coalesce(sum(taxable_value), 0) as taxable,
      coalesce(sum(taxable_value) filter (where line_type = 'CHARGE'), 0) as charges,
      coalesce(sum(cgst_amount), 0) as cgst, coalesce(sum(sgst_amount), 0) as sgst, coalesce(sum(igst_amount), 0) as igst
    from public.purchase_order_lines where purchase_order_id = p_po
  ) t
  where o.id = p_po;
end;
$$;

-- Blocking problems before a PO can be submitted or approved.
create or replace function private.po_issues(p_po uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_po     public.purchase_orders;
  v_s      public.suppliers;
  v_w      public.warehouses;
  v_issues jsonb := '[]'::jsonb;
  v_line   record;
  v_taxed  boolean;
begin
  select * into v_po from public.purchase_orders where id = p_po;
  select * into v_s from public.suppliers where id = v_po.supplier_id;
  v_taxed := v_po.tax_treatment in ('INTRA_STATE', 'INTER_STATE');
  if v_s.status <> 'ACTIVE' and v_po.revision = 0 then
    v_issues := v_issues || jsonb_build_object('code', 'SUPPLIER_INACTIVE', 'message', format('Supplier %s is inactive. Choose an active supplier.', v_s.supplier_code));
  end if;
  if v_po.tax_treatment = 'UNRESOLVED' then
    v_issues := v_issues || jsonb_build_object('code', 'COMPANY_GSTIN', 'message', 'The company GSTIN is missing (Company Settings), so CGST/SGST or IGST cannot be determined.');
  end if;
  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = p_po and line_type in ('GOODS', 'SERVICE')) then
    v_issues := v_issues || jsonb_build_object('code', 'NO_LINES', 'message', 'Add at least one goods or service line.');
  end if;
  if exists (select 1 from public.purchase_order_lines where purchase_order_id = p_po and line_type = 'GOODS') then
    select * into v_w from public.warehouses where id = v_po.warehouse_id;
    if v_po.warehouse_id is null then
      v_issues := v_issues || jsonb_build_object('code', 'WAREHOUSE', 'message', 'Choose the delivery warehouse for the goods.');
    elsif v_w.status <> 'ACTIVE' then
      v_issues := v_issues || jsonb_build_object('code', 'WAREHOUSE', 'message', format('Warehouse %s is inactive.', v_w.warehouse_code));
    end if;
  end if;
  for v_line in
    select l.*, p.sku as p_sku, p.status as p_status, p.archived_at as p_archived
    from public.purchase_order_lines l left join public.products p on p.id = l.product_id
    where l.purchase_order_id = p_po order by l.line_no
  loop
    if v_line.unit_price is null then
      v_issues := v_issues || jsonb_build_object('code', 'PRICE', 'line_no', v_line.line_no, 'message', format('Line %s: enter the unit price.', v_line.line_no));
    end if;
    if v_taxed and v_line.gst_rate is null then
      v_issues := v_issues || jsonb_build_object('code', 'GST_RATE', 'line_no', v_line.line_no,
        'message', format('Line %s (%s): the GST rate is missing. Set it on the line or in the Product Master.', v_line.line_no, coalesce(v_line.sku, v_line.description)));
    end if;
    if v_line.line_type = 'GOODS' and (v_line.p_status <> 'ACTIVE' or v_line.p_archived is not null) and v_po.revision = 0 then
      v_issues := v_issues || jsonb_build_object('code', 'PRODUCT_INACTIVE', 'line_no', v_line.line_no, 'message', format('Line %s: product %s is inactive.', v_line.line_no, v_line.p_sku));
    end if;
  end loop;
  if v_po.grand_total <= 0 then
    v_issues := v_issues || jsonb_build_object('code', 'TOTAL', 'message', 'The order total must be greater than zero.');
  end if;
  return v_issues;
end;
$$;

-- Status of an approved order from its posted receipts.
create or replace function private.po_receipt_status(p_po uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_po      public.purchase_orders;
  v_any     boolean;
  v_pending boolean;
begin
  select * into v_po from public.purchase_orders where id = p_po;
  v_any := exists (select 1 from public.goods_receipts where purchase_order_id = p_po and status = 'POSTED');
  v_pending := exists (
    select 1 from public.purchase_order_lines l cross join lateral private.po_line_receipts(l.id) r
    where l.purchase_order_id = p_po and l.line_type in ('GOODS', 'SERVICE') and r.accepted < l.ordered_quantity);
  return case when v_any and not v_pending then 'RECEIVED' when v_any then 'PARTIALLY_RECEIVED'
              when v_po.sent_at is not null then 'SENT' else 'APPROVED' end;
end;
$$;

revoke all on function private.purchase_policy(uuid), private.purchase_json_num(jsonb, text, text), private.purchase_json_uuid(jsonb, text, text),
  private.purchase_json_date(jsonb, text, text), private.purchase_text(jsonb, text),
  private.log_purchase_event(uuid, uuid, text, text, text, text, jsonb), private.po_line_receipts(uuid), private.po_refresh_snapshots(uuid),
  private.po_recalculate(uuid), private.po_issues(uuid), private.po_receipt_status(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Create / edit a draft
-- p_header: {supplier_id, po_date, expected_delivery_date, warehouse_id, purchase_type,
--            payment_terms, custom_payment_days, reference_number, delivery_instructions,
--            internal_notes, purchase_conditions}
-- p_lines:  [{id?, line_type, product_id, description, unit, hsn_sac, quantity, unit_price,
--             discount_percent, discount_amount, gst_rate}]   (gst_rate omitted = product's)
-- The company is always the caller's; totals are calculated here.
-- -----------------------------------------------------------------------------
create or replace function public.purchase_order_save(
  p_po_id               uuid,
  p_header              jsonb,
  p_lines               jsonb,
  p_expected_updated_at timestamptz default null,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_any_permission(array['purchase_order.create', 'purchase_order.update']);
  v_uid       uuid := auth.uid();
  v_previous  jsonb;
  v_po        public.purchase_orders;
  v_sup       public.suppliers;
  v_wh        public.warehouses;
  v_h         jsonb := coalesce(p_header, '{}'::jsonb);
  v_today     date;
  v_sup_id    uuid;
  v_wh_id     uuid;
  v_po_date   date;
  v_exp       date;
  v_type      text;
  v_terms     text;
  v_days      int;
  v_line      jsonb;
  v_idx       int := 0;
  v_line_id   uuid;
  v_existing  public.purchase_order_lines;
  v_ltype     text;
  v_pid       uuid;
  v_product   public.products;
  v_qty       numeric;
  v_price     numeric;
  v_dpct      numeric;
  v_damt      numeric;
  v_rate      numeric;
  v_desc      text;
  v_unit      text;
  v_hsn       text;
  v_accepted  numeric;
  v_keep      uuid[] := '{}';
  v_event     text := 'UPDATED';
  v_result    jsonb;
begin
  if p_po_id is null then
    if not private.has_permission(v_company, 'purchase_order.create') then
      raise exception 'You are not allowed to perform this action (requires purchase_order.create).' using errcode = '42501';
    end if;
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'purchase_order_create');
    if v_previous is not null then return v_previous; end if;
    v_event := 'CREATED';
  else
    select * into v_po from public.purchase_orders where id = p_po_id and company_id = v_company for update;
    if not found then
      raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
    end if;
    if v_po.status <> 'DRAFT' then
      raise exception 'Only draft purchase orders can be edited (this one is %). Amend an approved order instead.', lower(replace(v_po.status, '_', ' '))
        using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'purchase_order.update')
            or (private.has_permission(v_company, 'purchase_order.create') and v_po.created_by = v_uid)) then
      raise exception 'You can edit only your own draft purchase orders (editing others requires purchase_order.update).' using errcode = '42501';
    end if;
    if p_expected_updated_at is not null and v_po.updated_at <> p_expected_updated_at then
      raise exception 'This purchase order was changed by someone else. Reload it and try again.' using errcode = 'P0001';
    end if;
  end if;
  v_today := private.company_today(v_company);

  -- Header ---------------------------------------------------------------
  v_sup_id := private.purchase_json_uuid(v_h, 'supplier_id', 'Supplier');
  if v_sup_id is null then
    raise exception 'Select a supplier.' using errcode = 'P0001';
  end if;
  if p_po_id is null or v_sup_id <> v_po.supplier_id then
    if p_po_id is not null and (v_po.revision > 0 or exists (select 1 from public.goods_receipts where purchase_order_id = v_po.id)) then
      raise exception 'The supplier of an amended or received purchase order cannot be changed.' using errcode = 'P0001';
    end if;
    -- Only valid, ACTIVE suppliers of the caller's company.
    v_sup := private.require_active_supplier(v_company, v_sup_id);
  else
    select * into v_sup from public.suppliers where id = v_sup_id and company_id = v_company;
  end if;

  v_po_date := coalesce(private.purchase_json_date(v_h, 'po_date', 'PO date'), v_today);
  if v_po_date > v_today then
    raise exception 'The PO date cannot be in the future.' using errcode = 'P0001';
  end if;
  v_exp := private.purchase_json_date(v_h, 'expected_delivery_date', 'Expected delivery date');
  if v_exp is not null and v_exp < v_po_date then
    raise exception 'The expected delivery date cannot be before the PO date.' using errcode = 'P0001';
  end if;
  v_wh_id := private.purchase_json_uuid(v_h, 'warehouse_id', 'Delivery warehouse');
  if v_wh_id is not null then
    select * into v_wh from public.warehouses where id = v_wh_id and company_id = v_company;
    if not found or (v_wh.status <> 'ACTIVE' and v_wh_id is distinct from v_po.warehouse_id) then
      raise exception 'Select an active delivery warehouse of your company.' using errcode = 'P0001';
    end if;
  end if;
  v_type := private.purchase_text(v_h, 'purchase_type');
  if v_type is null or v_type not in ('RAW_MATERIAL', 'FINISHED_GOODS', 'PACKAGING', 'MACHINERY', 'SERVICES', 'OTHER') then
    raise exception 'Select the purchase type.' using errcode = 'P0001';
  end if;
  v_terms := coalesce(private.purchase_text(v_h, 'payment_terms'), v_sup.payment_terms);
  if v_terms not in ('IMMEDIATE', 'DAYS_7', 'DAYS_15', 'DAYS_30', 'DAYS_45', 'CUSTOM') then
    raise exception 'Payment terms are not valid.' using errcode = 'P0001';
  end if;
  if v_terms = 'CUSTOM' then
    v_days := coalesce(private.purchase_json_num(v_h, 'custom_payment_days', 'Custom payment days')::int,
                       case when v_sup.payment_terms = 'CUSTOM' then v_sup.custom_payment_days end);
    if v_days is null or v_days not between 1 and 365 then
      raise exception 'Enter custom payment terms of 1–365 days.' using errcode = 'P0001';
    end if;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'A purchase order can have at most 200 lines.' using errcode = 'P0001';
  end if;

  if p_po_id is null then
    insert into public.purchase_orders (company_id, po_number, supplier_id, supplier_code, supplier_name, supplier_country,
      po_date, purchase_type, payment_terms, custom_payment_days, created_by, updated_by)
    values (v_company, private.next_document_number(v_company, 'PO'), v_sup.id, v_sup.supplier_code, v_sup.legal_name, v_sup.country,
      v_po_date, v_type, v_terms, v_days, v_uid, v_uid)
    returning * into v_po;
  end if;

  update public.purchase_orders set
    supplier_id = v_sup.id, po_date = v_po_date, expected_delivery_date = v_exp, warehouse_id = v_wh_id, purchase_type = v_type,
    payment_terms = v_terms, custom_payment_days = v_days,
    payment_terms_overridden = (v_terms is distinct from v_sup.payment_terms
                                or (v_terms = 'CUSTOM' and v_days is distinct from v_sup.custom_payment_days)),
    reference_number = private.purchase_text(v_h, 'reference_number'),
    delivery_instructions = private.purchase_text(v_h, 'delivery_instructions'),
    internal_notes = private.purchase_text(v_h, 'internal_notes'),
    purchase_conditions = private.purchase_text(v_h, 'purchase_conditions'),
    updated_by = v_uid
  where id = v_po.id;

  -- Lines ----------------------------------------------------------------
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_idx := v_idx + 1;
    v_existing := null;
    v_product := null;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Line %: invalid line.', v_idx using errcode = 'P0001';
    end if;
    v_line_id := private.purchase_json_uuid(v_line, 'id', format('Line %s', v_idx));
    if v_line_id is not null then
      select * into v_existing from public.purchase_order_lines where id = v_line_id and purchase_order_id = v_po.id;
      if not found or v_line_id = any(v_keep) then
        raise exception 'Line %: this line is not part of the purchase order.', v_idx using errcode = 'P0001';
      end if;
    end if;
    v_ltype := coalesce(private.purchase_text(v_line, 'line_type'), 'GOODS');
    if v_ltype not in ('GOODS', 'SERVICE', 'CHARGE') then
      raise exception 'Line %: line type must be goods, service or charge.', v_idx using errcode = 'P0001';
    end if;
    v_pid := private.purchase_json_uuid(v_line, 'product_id', format('Line %s product', v_idx));
    if v_ltype = 'GOODS' and v_pid is null then
      raise exception 'Line %: select a product from the Product Master.', v_idx using errcode = 'P0001';
    end if;
    if v_pid is not null then
      select * into v_product from public.products where id = v_pid and company_id = v_company;
      if not found then
        raise exception 'Line %: product not found in your company.', v_idx using errcode = 'P0001';
      end if;
      if v_ltype = 'GOODS' and (v_product.status <> 'ACTIVE' or v_product.archived_at is not null)
         and v_pid is distinct from v_existing.product_id then
        raise exception 'Line %: product % is inactive and cannot be ordered.', v_idx, v_product.sku using errcode = 'P0001';
      end if;
    end if;
    v_qty := private.purchase_json_num(v_line, 'quantity', format('Line %s quantity', v_idx));
    if v_qty is null or v_qty <= 0 then
      raise exception 'Line %: the quantity must be greater than zero.', v_idx using errcode = 'P0001';
    end if;
    if v_qty <> round(v_qty, 3) or v_qty >= 100000000000 then
      raise exception 'Line %: quantities support at most 3 decimal places.', v_idx using errcode = 'P0001';
    end if;
    v_price := private.purchase_json_num(v_line, 'unit_price', format('Line %s unit price', v_idx));
    if v_price is not null and (v_price < 0 or v_price <> round(v_price, 4) or v_price >= 1000000000000) then
      raise exception 'Line %: the unit price must be zero or more (up to 4 decimals).', v_idx using errcode = 'P0001';
    end if;
    v_dpct := private.purchase_json_num(v_line, 'discount_percent', format('Line %s discount %%', v_idx));
    if v_dpct is not null and (v_dpct < 0 or v_dpct > 100 or v_dpct <> round(v_dpct, 2)) then
      raise exception 'Line %: the discount percentage must be between 0 and 100.', v_idx using errcode = 'P0001';
    end if;
    v_damt := coalesce(private.purchase_json_num(v_line, 'discount_amount', format('Line %s discount', v_idx)), 0);
    if v_damt < 0 or v_damt <> round(v_damt, 2) then
      raise exception 'Line %: the discount amount must be zero or more (2 decimals).', v_idx using errcode = 'P0001';
    end if;
    if coalesce(v_dpct, 0) > 0 and v_damt > 0 then
      raise exception 'Line %: enter either a discount percentage or an amount, not both.', v_idx using errcode = 'P0001';
    end if;
    if v_damt > round(v_qty * coalesce(v_price, 0), 2) then
      raise exception 'Line %: the discount cannot exceed the line amount.', v_idx using errcode = 'P0001';
    end if;
    v_rate := case when v_line ? 'gst_rate' then private.purchase_json_num(v_line, 'gst_rate', format('Line %s GST rate', v_idx)) else v_product.gst_rate end;
    if v_rate is not null and (v_rate < 0 or v_rate > 100 or v_rate <> round(v_rate, 2)) then
      raise exception 'Line %: the GST rate must be between 0 and 100.', v_idx using errcode = 'P0001';
    end if;
    v_desc := coalesce(private.purchase_text(v_line, 'description'), v_product.product_name);
    if v_desc is null or length(v_desc) > 500 then
      raise exception 'Line %: enter a description (up to 500 characters).', v_idx using errcode = 'P0001';
    end if;
    v_unit := case when v_ltype = 'GOODS' then v_product.base_unit
                   else upper(coalesce(private.purchase_text(v_line, 'unit'), v_product.base_unit, 'NOS')) end;
    if v_unit !~ '^[A-Z]{1,10}$' then
      raise exception 'Line %: the unit must be 1–10 letters.', v_idx using errcode = 'P0001';
    end if;
    v_hsn := coalesce(private.purchase_text(v_line, 'hsn_sac'), v_product.hsn_code);
    if v_hsn is not null and v_hsn !~ '^[0-9]{4,8}$' then
      raise exception 'Line %: HSN/SAC must be 4–8 digits.', v_idx using errcode = 'P0001';
    end if;

    if v_existing.id is not null then
      select r.accepted into v_accepted from private.po_line_receipts(v_existing.id) r;
      if exists (select 1 from public.goods_receipt_lines where purchase_order_line_id = v_existing.id) then
        if v_ltype <> v_existing.line_type or v_pid is distinct from v_existing.product_id then
          raise exception 'Line %: goods were received on this line, so its product cannot be changed.', v_idx using errcode = 'P0001';
        end if;
        if v_qty < v_accepted then
          raise exception 'Line %: the quantity cannot be less than the % already received.', v_idx, v_accepted using errcode = 'P0001';
        end if;
      end if;
      update public.purchase_order_lines set
        line_no = v_idx, line_type = v_ltype, product_id = v_pid, sku = v_product.sku, description = v_desc, hsn_sac = v_hsn, unit = v_unit,
        ordered_quantity = v_qty, unit_price = v_price, discount_percent = nullif(v_dpct, 0), discount_value_input = v_damt, gst_rate = v_rate,
        master_cost_snapshot = case when v_pid is distinct from v_existing.product_id then v_product.standard_cost else master_cost_snapshot end,
        gross_amount = 0, discount_amount = 0, taxable_value = 0, cgst_amount = 0, sgst_amount = 0, igst_amount = 0, line_total = 0
      where id = v_existing.id;
      v_line_id := v_existing.id;
    else
      insert into public.purchase_order_lines (company_id, purchase_order_id, line_no, line_type, product_id, sku, description, hsn_sac, unit,
        ordered_quantity, unit_price, master_cost_snapshot, discount_percent, discount_value_input, gst_rate)
      values (v_company, v_po.id, v_idx, v_ltype, v_pid, v_product.sku, v_desc, v_hsn, v_unit,
        v_qty, v_price, v_product.standard_cost, nullif(v_dpct, 0), v_damt, v_rate)
      returning id into v_line_id;
    end if;
    v_keep := v_keep || v_line_id;
  end loop;

  if exists (select 1 from public.purchase_order_lines l where l.purchase_order_id = v_po.id and not (l.id = any(v_keep))
             and exists (select 1 from public.goods_receipt_lines g where g.purchase_order_line_id = l.id)) then
    raise exception 'A line with received goods cannot be removed.' using errcode = 'P0001';
  end if;
  delete from public.purchase_order_lines where purchase_order_id = v_po.id and not (id = any(v_keep));

  perform private.po_refresh_snapshots(v_po.id);
  perform private.po_recalculate(v_po.id);
  select * into v_po from public.purchase_orders where id = v_po.id;
  perform private.log_purchase_event(v_company, v_po.id, v_event, null, v_po.status, null,
    jsonb_build_object('po_number', v_po.po_number, 'revision', v_po.revision, 'lines', v_idx, 'grand_total', v_po.grand_total));

  v_result := jsonb_build_object('po_id', v_po.id, 'po_number', v_po.po_number, 'status', v_po.status, 'updated_at', v_po.updated_at,
    'grand_total', v_po.grand_total);
  if p_po_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_result);
  end if;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Workflow
--   SUBMIT    DRAFT -> PENDING_APPROVAL       creator (own) or purchase_order.update
--   WITHDRAW  PENDING_APPROVAL -> DRAFT       submitter or purchase_order.update
--   APPROVE   PENDING_APPROVAL -> APPROVED*   purchase_order.approve, not own (SoD)
--   REJECT    PENDING_APPROVAL -> DRAFT       purchase_order.approve, reason
--   SEND      APPROVED -> SENT                purchase_order.send
--   AMEND     APPROVED / SENT / PARTIALLY_RECEIVED -> DRAFT (revision + 1)  purchase_order.amend, reason
--   CANCEL    DRAFT..SENT without receipts -> CANCELLED   purchase_order.cancel (or own draft), reason
--   CLOSE     PARTIALLY_RECEIVED -> CLOSED (short close)  purchase_order.cancel, reason
--   * re-approval of an amended order with receipts returns to PARTIALLY_RECEIVED / RECEIVED.
-- -----------------------------------------------------------------------------
create or replace function public.purchase_order_action(
  p_po_id               uuid,
  p_action              text,
  p_note                text default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchases.read');
  v_uid      uuid := auth.uid();
  v_po       public.purchase_orders;
  v_action   text := upper(btrim(coalesce(p_action, '')));
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_issues   jsonb;
  v_to       text;
  v_snapshot jsonb;
  v_has_receipts boolean;
begin
  select * into v_po from public.purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_po.updated_at <> p_expected_updated_at then
    raise exception 'This purchase order was changed by someone else. Reload it and try again.' using errcode = 'P0001';
  end if;
  v_has_receipts := exists (select 1 from public.goods_receipts where purchase_order_id = v_po.id and status = 'POSTED');

  if v_action = 'SUBMIT' then
    if v_po.status <> 'DRAFT' then
      raise exception 'Only a draft can be submitted for approval.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'purchase_order.update')
            or (private.has_permission(v_company, 'purchase_order.create') and v_po.created_by = v_uid)) then
      raise exception 'You can submit only your own drafts (others require purchase_order.update).' using errcode = '42501';
    end if;
    perform private.po_refresh_snapshots(v_po.id);
    perform private.po_recalculate(v_po.id);
    v_issues := private.po_issues(v_po.id);
    if jsonb_array_length(v_issues) > 0 then
      raise exception 'The purchase order cannot be submitted: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i)
        using errcode = 'P0001';
    end if;
    v_to := 'PENDING_APPROVAL';
    update public.purchase_orders set status = v_to, submitted_by = v_uid, submitted_at = now(),
      rejected_by = null, rejected_at = null, rejection_reason = null, updated_by = v_uid where id = v_po.id;

  elsif v_action = 'WITHDRAW' then
    if v_po.status <> 'PENDING_APPROVAL' then
      raise exception 'Only an order awaiting approval can be withdrawn.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'purchase_order.update') or v_po.submitted_by = v_uid) then
      raise exception 'Only the submitter (or a user with purchase_order.update) can withdraw this order.' using errcode = '42501';
    end if;
    v_to := 'DRAFT';
    update public.purchase_orders set status = v_to, submitted_by = null, submitted_at = null, updated_by = v_uid where id = v_po.id;

  elsif v_action in ('APPROVE', 'REJECT') then
    perform private.require_permission('purchase_order.approve');
    if v_po.status <> 'PENDING_APPROVAL' then
      raise exception 'This order is not awaiting approval.' using errcode = 'P0001';
    end if;
    if v_action = 'APPROVE' then
      -- Company-wide segregation-of-duties switch (inventory.segregation_of_duties, default on).
      perform private.assert_not_self_approval(v_company, v_po.submitted_by, v_po.created_by);
      v_issues := private.po_issues(v_po.id);
      if jsonb_array_length(v_issues) > 0 then
        raise exception 'The purchase order cannot be approved: %', (select string_agg(i ->> 'message', ' ') from jsonb_array_elements(v_issues) i)
          using errcode = 'P0001';
      end if;
      update public.purchase_orders set status = 'APPROVED', approved_by = v_uid, approved_at = now(), updated_by = v_uid where id = v_po.id;
      v_to := private.po_receipt_status(v_po.id);
      update public.purchase_orders set status = v_to where id = v_po.id;
    else
      if v_note is null or length(v_note) < 3 then
        raise exception 'Enter the reason for rejecting the order.' using errcode = 'P0001';
      end if;
      v_to := 'DRAFT';
      update public.purchase_orders set status = v_to, rejected_by = v_uid, rejected_at = now(), rejection_reason = v_note,
        submitted_by = null, submitted_at = null, updated_by = v_uid where id = v_po.id;
    end if;

  elsif v_action = 'SEND' then
    perform private.require_permission('purchase_order.send');
    if v_po.status <> 'APPROVED' then
      raise exception 'Only an approved order that has not been sent can be marked as sent.' using errcode = 'P0001';
    end if;
    v_to := 'SENT';
    update public.purchase_orders set status = v_to, sent_by = v_uid, sent_at = now(), updated_by = v_uid where id = v_po.id;

  elsif v_action = 'AMEND' then
    perform private.require_permission('purchase_order.amend');
    if v_po.status not in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') then
      raise exception 'Only approved, sent or partially received orders can be amended.' using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Enter the reason for the amendment (at least 5 characters).' using errcode = 'P0001';
    end if;
    select to_jsonb(v_po) || jsonb_build_object('lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no)
      from public.purchase_order_lines l where l.purchase_order_id = v_po.id), '[]'::jsonb)) into v_snapshot;
    insert into public.purchase_order_amendments (company_id, purchase_order_id, from_revision, to_revision, reason, previous_version, created_by)
    values (v_company, v_po.id, v_po.revision, v_po.revision + 1, v_note, v_snapshot, v_uid);
    v_to := 'DRAFT';
    update public.purchase_orders set status = v_to, revision = revision + 1, submitted_by = null, submitted_at = null,
      approved_by = null, approved_at = null, sent_by = null, sent_at = null, updated_by = v_uid where id = v_po.id;

  elsif v_action = 'CANCEL' then
    if not (private.has_permission(v_company, 'purchase_order.cancel')
            or (v_po.status = 'DRAFT' and v_po.revision = 0 and private.has_permission(v_company, 'purchase_order.create') and v_po.created_by = v_uid)) then
      raise exception 'You are not allowed to perform this action (requires purchase_order.cancel).' using errcode = '42501';
    end if;
    if v_po.status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT') then
      raise exception 'A % order cannot be cancelled.', lower(replace(v_po.status, '_', ' ')) using errcode = 'P0001';
    end if;
    if v_has_receipts then
      raise exception 'Goods have been received on this order, so it cannot be cancelled. Short-close it instead.' using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Enter the reason for the cancellation (at least 5 characters).' using errcode = 'P0001';
    end if;
    v_to := 'CANCELLED';
    update public.purchase_orders set status = v_to, cancelled_by = v_uid, cancelled_at = now(), cancel_reason = v_note, updated_by = v_uid where id = v_po.id;

  elsif v_action = 'CLOSE' then
    perform private.require_permission('purchase_order.cancel');
    if v_po.status <> 'PARTIALLY_RECEIVED' then
      raise exception 'Only a partially received order can be short-closed.' using errcode = 'P0001';
    end if;
    if v_note is null or length(v_note) < 5 then
      raise exception 'Enter the reason for closing the order with quantities still pending (at least 5 characters).' using errcode = 'P0001';
    end if;
    v_to := 'CLOSED';
    update public.purchase_orders set status = v_to, closed_by = v_uid, closed_at = now(), close_reason = v_note, updated_by = v_uid where id = v_po.id;

  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end if;

  perform private.log_purchase_event(v_company, v_po.id, case v_action when 'SUBMIT' then 'SUBMITTED' when 'WITHDRAW' then 'WITHDRAWN'
      when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' when 'SEND' then 'SENT' when 'AMEND' then 'AMENDED'
      when 'CANCEL' then 'CANCELLED' else 'CLOSED' end,
    v_po.status, v_to, v_note,
    jsonb_build_object('po_number', v_po.po_number, 'revision', case when v_action = 'AMEND' then v_po.revision + 1 else v_po.revision end,
      'grand_total', (select grand_total from public.purchase_orders where id = v_po.id)));
  return jsonb_build_object('po_id', v_po.id, 'status', v_to, 'updated_at', (select updated_at from public.purchase_orders where id = v_po.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Goods receipts
-- p_header: {receipt_date, supplier_document_number, supporting_document_ref, notes}
-- p_lines:  [{po_line_id, received_quantity, accepted_quantity, rejected_quantity,
--             accepted_location_id, rejected_location_id, batch_number, manufacturing_date,
--             expiry_date, serial_numbers, rejection_reason, over_receipt_reason}]
-- Goods lines: accepted stock is posted as RECEIPT into a STORAGE location of the
-- order's warehouse; rejected goods go to a REJECTED / QUARANTINE location (never
-- available stock) or are recorded only. Service lines post nothing. The receipt and
-- every stock posting commit together or not at all. Retries with the same
-- idempotency key return the first result.
-- -----------------------------------------------------------------------------
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
      -- Cost per unit excluding GST, from the order line (after discount).
      v_cost := round(v_pl.taxable_value / v_pl.ordered_quantity, 4);
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
      batch_id, batch_number, manufacturing_date, expiry_date, serial_numbers, unit_cost, accepted_transaction_id, rejected_transaction_id, over_receipt_reason)
    values (v_company, v_receipt, v_po.id, v_pl.id, v_pl.line_type, v_pl.product_id, v_pl.unit,
      v_recv, v_acc, v_rej, case when v_rej = 0 then 'ACCEPTED' when v_acc = 0 then 'REJECTED' else 'PARTIALLY_ACCEPTED' end, v_rej_note,
      v_acc_loc.id, v_rej_loc.id, v_lot, (select batch_number from public.inventory_batches where id = v_lot),
      private.purchase_json_date(v_in, 'manufacturing_date', 'Manufacturing date'), private.purchase_json_date(v_in, 'expiry_date', 'Expiry date'),
      private.purchase_text(v_in, 'serial_numbers'), case when v_pl.line_type = 'GOODS' then v_cost end, v_acc_tx, v_rej_tx, v_over);
  end loop;

  v_from := v_po.status;
  v_to := private.po_receipt_status(v_po.id);
  update public.purchase_orders set status = v_to, updated_by = v_uid where id = v_po.id;
  perform private.log_purchase_event(v_company, v_po.id, 'RECEIPT_POSTED', v_from, v_to, private.purchase_text(v_h, 'notes'),
    jsonb_build_object('receipt_number', v_number, 'lines', v_idx, 'transactions', to_jsonb(v_txns)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'receipt_id', v_receipt, 'receipt_number', v_number, 'po_status', v_to, 'transaction_numbers', to_jsonb(v_txns)));
end;
$$;

-- Reverses a posted goods receipt (all its stock postings) with a reason.
create or replace function public.purchase_receipt_reverse(p_receipt_id uuid, p_reason text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_exception.approve');
  v_previous jsonb;
  v_r        public.goods_receipts;
  v_po       public.purchase_orders;
  v_l        public.goods_receipt_lines;
  v_numbers  text[] := '{}';
  v_to       text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'purchase_receipt_reversal');
  if v_previous is not null then return v_previous; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'Enter the reason for the reversal (at least 5 characters).' using errcode = 'P0001';
  end if;
  select * into v_r from public.goods_receipts where id = p_receipt_id and company_id = v_company;
  if not found then
    raise exception 'Goods receipt not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_po from public.purchase_orders where id = v_r.purchase_order_id for update;
  select * into v_r from public.goods_receipts where id = p_receipt_id for update;
  if v_r.status <> 'POSTED' then
    raise exception 'This goods receipt has already been reversed.' using errcode = 'P0001';
  end if;
  if v_po.status in ('CLOSED', 'CANCELLED') then
    raise exception 'Receipts of a % order cannot be reversed.', lower(v_po.status) using errcode = 'P0001';
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
  v_to := case when v_po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED') then private.po_receipt_status(v_po.id) else v_po.status end;
  update public.purchase_orders set status = v_to, updated_by = auth.uid() where id = v_po.id;
  perform private.log_purchase_event(v_company, v_po.id, 'RECEIPT_REVERSED', v_po.status, v_to, p_reason,
    jsonb_build_object('receipt_number', v_r.receipt_number, 'reversal_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers), 'po_status', v_to));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Read helpers
-- -----------------------------------------------------------------------------
-- Problems that block submission, for the draft page.
create or replace function public.purchase_order_validate(p_po_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchases.read');
begin
  if not exists (select 1 from public.purchase_orders where id = p_po_id and company_id = v_company) then
    raise exception 'Purchase order not found in your company.' using errcode = 'P0001';
  end if;
  return private.po_issues(p_po_id);
end;
$$;

-- Active suppliers for a new order (no suppliers.read needed to create POs).
create or replace function public.purchase_supplier_options()
returns table (id uuid, supplier_code text, legal_name text, display_name text, category text, gstin text, state_code text, country text,
               payment_terms text, custom_payment_days int, billing_address text, shipping_address text, contact_person text, email text, phone text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_order.create', 'purchase_order.update']);
begin
  return query
    select s.id, s.supplier_code, s.legal_name, s.display_name, s.category, s.gstin, coalesce(left(s.gstin, 2), s.state_code), s.country,
           s.payment_terms, s.custom_payment_days, s.billing_address, s.shipping_address, s.contact_person, s.email, s.phone
    from public.suppliers s
    where s.company_id = v_company and s.status = 'ACTIVE'
    order by s.legal_name
    limit 5000;
end;
$$;

create or replace view public.purchase_order_line_list
with (security_invoker = true) as
select l.*, r.received as received_quantity, r.accepted as accepted_quantity, r.rejected as rejected_quantity,
  case when l.line_type in ('GOODS', 'SERVICE') then greatest(l.ordered_quantity - r.accepted, 0) else 0 end as pending_quantity,
  case when l.line_type in ('GOODS', 'SERVICE') then round(greatest(l.ordered_quantity - r.accepted, 0) / l.ordered_quantity * l.line_total, 2) else 0 end as pending_value
from public.purchase_order_lines l
cross join lateral (
  select coalesce(sum(g.received_quantity), 0) as received, coalesce(sum(g.accepted_quantity), 0) as accepted, coalesce(sum(g.rejected_quantity), 0) as rejected
  from public.goods_receipt_lines g join public.goods_receipts gr on gr.id = g.goods_receipt_id
  where g.purchase_order_line_id = l.id and gr.status = 'POSTED'
) r;

create or replace view public.purchase_order_list
with (security_invoker = true) as
select o.*,
  coalesce(a.line_count, 0) as line_count,
  coalesce(a.ordered_quantity, 0) as total_ordered_quantity,
  coalesce(a.received_quantity, 0) as total_received_quantity,
  coalesce(a.accepted_quantity, 0) as total_accepted_quantity,
  coalesce(a.pending_quantity, 0) as total_pending_quantity,
  coalesce(a.pending_value, 0) as pending_value,
  coalesce(a.skus, '') as skus,
  coalesce(a.product_ids, '{}') as product_ids,
  (select count(*) from public.goods_receipts g where g.purchase_order_id = o.id and g.status = 'POSTED') as receipt_count
from public.purchase_orders o
left join (
  select v.purchase_order_id, count(*) as line_count,
    sum(v.ordered_quantity) filter (where v.line_type <> 'CHARGE') as ordered_quantity,
    sum(v.received_quantity) as received_quantity, sum(v.accepted_quantity) as accepted_quantity,
    sum(v.pending_quantity) as pending_quantity, sum(v.pending_value) as pending_value,
    string_agg(distinct v.sku, ' ') as skus, array_agg(distinct v.product_id) filter (where v.product_id is not null) as product_ids
  from public.purchase_order_line_list v group by v.purchase_order_id
) a on a.purchase_order_id = o.id;

create or replace view public.goods_receipt_line_list
with (security_invoker = true) as
select g.*, r.receipt_number, r.receipt_date, r.status as receipt_status, r.supplier_document_number,
  pl.line_no as po_line_no, pl.sku, pl.description, pl.ordered_quantity,
  al.location_code as accepted_location_code, rl.location_code as rejected_location_code,
  at.transaction_number as accepted_transaction_number, rt.transaction_number as rejected_transaction_number
from public.goods_receipt_lines g
join public.goods_receipts r on r.id = g.goods_receipt_id
join public.purchase_order_lines pl on pl.id = g.purchase_order_line_id
left join public.inventory_locations al on al.id = g.accepted_location_id
left join public.inventory_locations rl on rl.id = g.rejected_location_id
left join public.inventory_transactions at on at.id = g.accepted_transaction_id
left join public.inventory_transactions rt on rt.id = g.rejected_transaction_id;

create or replace view public.goods_receipt_list
with (security_invoker = true) as
select r.*, o.po_number, o.supplier_name, o.supplier_code, o.warehouse_code,
  coalesce(s.lines, 0) as line_count, coalesce(s.received, 0) as total_received, coalesce(s.accepted, 0) as total_accepted, coalesce(s.rejected, 0) as total_rejected
from public.goods_receipts r
join public.purchase_orders o on o.id = r.purchase_order_id
left join (
  select goods_receipt_id, count(*) as lines, sum(received_quantity) as received, sum(accepted_quantity) as accepted, sum(rejected_quantity) as rejected
  from public.goods_receipt_lines group by goods_receipt_id
) s on s.goods_receipt_id = r.id;

revoke all on public.purchase_order_line_list, public.purchase_order_list, public.goods_receipt_line_list, public.goods_receipt_list from anon, authenticated;
grant select on public.purchase_order_line_list, public.purchase_order_list, public.goods_receipt_line_list, public.goods_receipt_list to authenticated;

-- Dashboard figures from records only. Counts are the current position; the
-- order value is for POs dated in the period that were approved (not drafts,
-- pending or cancelled); outstanding receipt value is the pending quantity of
-- open orders x the line's value per unit (incl. GST).
create or replace function public.purchase_order_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchases.read');
  v_today   date;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid period.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);
  return jsonb_build_object(
    'total', (select count(*) from public.purchase_orders where company_id = v_company),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.purchase_orders
                           where company_id = v_company group by status) s), '{}'::jsonb),
    'open', (select count(*) from public.purchase_orders where company_id = v_company and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')),
    'overdue', (select count(*) from public.purchase_orders where company_id = v_company and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
                and expected_delivery_date < v_today),
    'period_value', (select coalesce(sum(grand_total), 0) from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
                     and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')),
    'period_orders', (select count(*) from public.purchase_orders where company_id = v_company and po_date between p_from and p_to
                      and status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')),
    'outstanding_receipt_value', (select coalesce(sum(v.pending_value), 0) from public.purchase_order_line_list v
                                  join public.purchase_orders o on o.id = v.purchase_order_id
                                  where o.company_id = v_company and o.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')),
    'generated_at', now());
end;
$$;

revoke all on function public.purchase_order_save(uuid, jsonb, jsonb, timestamptz, uuid), public.purchase_order_action(uuid, text, text, timestamptz),
  public.purchase_receipt_post(uuid, jsonb, jsonb, uuid), public.purchase_receipt_reverse(uuid, text, uuid), public.purchase_order_validate(uuid),
  public.purchase_supplier_options(), public.purchase_order_dashboard(date, date) from public, anon;
grant execute on function public.purchase_order_save(uuid, jsonb, jsonb, timestamptz, uuid), public.purchase_order_action(uuid, text, text, timestamptz),
  public.purchase_receipt_post(uuid, jsonb, jsonb, uuid), public.purchase_receipt_reverse(uuid, text, uuid), public.purchase_order_validate(uuid),
  public.purchase_supplier_options(), public.purchase_order_dashboard(date, date) to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Approval Inbox: purchase orders awaiting approval (module approval)
-- Same function as the approval engine migration plus the PURCHASE_ORDER branch.
-- -----------------------------------------------------------------------------
create or replace function public.approval_inbox(p_scope text default 'TO_DECIDE', p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('approvals.read');
  v_uid     uuid := auth.uid();
  v_reqs    jsonb;
  v_module  jsonb;
begin
  if p_scope not in ('TO_DECIDE', 'MINE', 'ALL') or p_limit not between 1 and 500 then
    raise exception 'Invalid inbox scope.' using errcode = 'P0001';
  end if;
  with r as (
    select q.*, (select s from jsonb_array_elements(q.workflow_snapshot -> 'stages') s where (s ->> 'stage_no')::int = q.current_stage) as stage,
      d.fingerprint as current_fingerprint, d.state as document_state, d.link
    from public.approval_requests q
    left join lateral private.approval_document(v_company, q.document_type, q.document_id) d on true
    where q.company_id = v_company
      and (q.requested_by = v_uid or private.has_permission(v_company, 'approvals.manage')
           or private.has_permission(v_company, private.approval_read_permission(q.document_type)))
  ),
  x as (
    select r.*, (r.status = 'PENDING_APPROVAL'
        and exists (select 1 from private.approval_stage_users(v_company, r.stage) u where u.user_id = v_uid)
        and (r.requested_by is distinct from v_uid or coalesce((r.workflow_snapshot ->> 'allow_self_approval')::boolean, false))
        and not exists (select 1 from public.approval_decisions dd where dd.request_id = r.id and dd.approver_user_id = v_uid
                        and (dd.stage_no = r.current_stage or coalesce((r.workflow_snapshot ->> 'distinct_stage_approvers')::boolean, true)))) as can_decide
    from r
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'document_type', x.document_type, 'document_id', x.document_id, 'reference', x.document_reference,
      'amount', x.amount, 'status', x.status, 'workflow', x.workflow_snapshot ->> 'name', 'workflow_version', x.workflow_version,
      'stage', x.current_stage, 'stages', jsonb_array_length(x.workflow_snapshot -> 'stages'), 'stage_name', x.stage ->> 'name',
      'required_approvals', x.stage -> 'required_approvals',
      'stage_approvals', (select count(*) from public.approval_decisions dd where dd.request_id = x.id and dd.stage_no = x.current_stage and dd.decision = 'APPROVE'),
      'requested_by', x.requested_by, 'requested_by_name', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = x.requested_by),
      'requested_at', x.requested_at, 'comment', x.request_comment, 'decided_at', x.decided_at, 'cancel_reason', x.cancel_reason,
      'consumed_at', x.consumed_at, 'can_decide', x.can_decide, 'mine', x.requested_by = v_uid, 'link', x.link,
      'stale', x.status = 'PENDING_APPROVAL' and (x.current_fingerprint is distinct from x.document_fingerprint or x.document_state is distinct from 'PENDING'),
      'require_rejection_reason', coalesce((x.workflow_snapshot ->> 'require_rejection_reason')::boolean, true),
      'decisions', coalesce((select jsonb_agg(jsonb_build_object('stage', dd.stage_no, 'decision', dd.decision, 'comment', dd.comment, 'decided_at', dd.decided_at,
          'approver', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = dd.approver_user_id)) order by dd.decided_at)
        from public.approval_decisions dd where dd.request_id = x.id), '[]'::jsonb))
      order by x.requested_at desc), '[]'::jsonb)
  into v_reqs
  from (select * from x where (p_scope = 'ALL') or (p_scope = 'MINE' and x.requested_by = v_uid) or (p_scope = 'TO_DECIDE' and x.can_decide)
        order by x.requested_at desc limit p_limit) x;

  -- Module approvals with no engine request (the module page decides them).
  select coalesce(jsonb_agg(m order by m ->> 'submitted_at'), '[]'::jsonb) into v_module from (
    select jsonb_build_object('document_type', 'STOCK_ADJUSTMENT', 'reference', a.adjustment_number, 'link', '/inventory/adjustments', 'submitted_at', a.requested_at,
      'mine', a.requested_by = v_uid, 'summary', lower(replace(a.reason_code, '_', ' '))) m
    from public.inventory_adjustments a where a.company_id = v_company and a.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'inventory.approve_adjustment')
      and not exists (select 1 from public.approval_requests q where q.document_id = a.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'STOCK_COUNT', 'reference', c.count_number, 'link', '/inventory/counts/' || c.id, 'submitted_at', c.submitted_at,
      'mine', c.submitted_by = v_uid, 'summary', 'count variance review')
    from public.inventory_counts c where c.company_id = v_company and c.status = 'SUBMITTED' and private.has_permission(v_company, 'inventory_count.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = c.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'OPENING_STOCK', 'reference', o.document_number, 'link', '/inventory/opening-stock', 'submitted_at', o.requested_at,
      'mine', o.requested_by = v_uid, 'summary', o.line_count || ' line(s)')
    from public.inventory_opening_batches o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'inventory_opening.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'PRODUCTION_ORDER', 'reference', o.production_order_number, 'link', '/production/orders/' || o.id, 'submitted_at', o.submitted_at,
      'mine', o.submitted_by = v_uid, 'summary', trim_scale(o.planned_quantity) || ' ' || o.unit)
    from public.production_orders o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'production_order.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'BOM', 'reference', b.bom_code || ' v' || b.version, 'link', '/production/boms/' || b.id, 'submitted_at', coalesce(b.submitted_at, b.updated_at),
      'mine', coalesce(b.submitted_by, b.created_by) = v_uid, 'summary', 'bill of materials')
    from public.boms b where b.company_id = v_company and b.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'production_bom.approve')
    union all
    select jsonb_build_object('document_type', 'OUTSOURCING_ORDER', 'reference', o.outsourcing_order_number, 'link', '/production/outsourcing/' || o.id, 'submitted_at', o.submitted_at,
      'mine', o.submitted_by = v_uid, 'summary', o.supplier_name)
    from public.outsourcing_orders o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'outsourcing_order.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = o.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'INVOICE', 'reference', 'Draft · ' || i.customer_legal_name, 'link', '/billing/invoices/' || i.id, 'submitted_at', i.submitted_at,
      'mine', i.submitted_by = v_uid, 'summary', to_char(i.grand_total, 'FM999,999,999,990.00'))
    from public.sales_invoices i where i.company_id = v_company and i.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'invoices.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = i.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', n.note_type || '_NOTE', 'reference', 'Draft ' || lower(n.note_type) || ' note', 'link', '/billing/notes/' || n.id,
      'submitted_at', n.submitted_at, 'mine', n.submitted_by = v_uid, 'summary', to_char(n.total_amount, 'FM999,999,999,990.00'))
    from public.invoice_adjustment_notes n where n.company_id = v_company and n.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'invoices.approve')
      and not exists (select 1 from public.approval_requests q where q.document_id = n.id and q.status = 'PENDING_APPROVAL')
    union all
    select jsonb_build_object('document_type', 'PURCHASE_ORDER', 'reference', o.po_number || case when o.revision > 0 then ' rev ' || o.revision else '' end,
      'link', '/purchase-orders/' || o.id, 'submitted_at', o.submitted_at, 'mine', o.submitted_by = v_uid,
      'summary', o.supplier_name || ' · ' || to_char(o.grand_total, 'FM999,999,999,990.00'))
    from public.purchase_orders o where o.company_id = v_company and o.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'purchase_order.approve')
    limit 200
  ) y;

  return jsonb_build_object('requests', v_reqs, 'module_items', v_module, 'generated_at', now());
end;
$$;

revoke all on function public.approval_inbox(text, int) from public, anon;
grant execute on function public.approval_inbox(text, int) to authenticated;
