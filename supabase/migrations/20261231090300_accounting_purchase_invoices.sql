-- =============================================================================
-- ALTON ACCOUNTS — Phase 3: purchase (supplier) invoice accounting
--
-- Additive, on Phases 0-2 (20261231090000 / 090100 / 090200) and the existing purchasing module
-- (purchase_orders, goods_receipts, supplier_payments, parties). Nothing in purchasing changes:
-- no stock movement, no change to receipts, purchase orders or supplier payments.
--
--   purchase_invoices              supplier invoices (DRAFT -> SUBMITTED -> APPROVED -> POSTED -> REVERSED;
--                                  drafts / submitted / approved can be CANCELLED); unique per company,
--                                  supplier and normalized supplier invoice number (cancelled / reversed excluded)
--   purchase_invoice_lines         GRN lines (matched to a goods receipt line, partial quantities allowed) and
--                                  DIRECT lines (service / expense / freight to a chosen ledger)
--   purchase_invoice_allocations   cost-centre split of DIRECT lines (passed to the voucher lines)
--   purchase_invoice_history       append-only status and GST-verification history
--   supplier_payment_allocations   existing supplier payments allocated to posted invoices (no new payment)
--
-- No duplicate payable
--   A goods receipt already posted Dr Purchases + Dr GST Input Pending / Cr Creditors at its payable value
--   (20261231090100). An invoice line matched to that receipt posts ONLY the differences against the
--   receipt's matched share: purchase price variance (net), GST Input Pending (GST) and Creditors (payable).
--   When the invoice equals the receipt no voucher is posted at all. The matched shares are stored on the
--   lines, so "receipt share + adjustment = invoice" is provable per invoice and per receipt line
--   (purchase_invoice_report GRN_RECONCILIATION). DIRECT lines post Dr ledger / Dr GST Input Pending /
--   Cr Creditors (reverse charge: Cr GST payable under reverse charge instead of Creditors for the tax).
--
-- GST is never treated as eligible input credit on posting: it stays in GST Input Pending Verification
-- until an authorised user verifies it (eligible -> input CGST / SGST / IGST / cess ledgers; ineligible ->
-- expense), with a reason and recorded checks. There is no GST portal / GSTR-2B integration.
--
-- Rollback: supabase/rollback/20261231090300_accounting_purchase_invoices_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('purchase_invoices', 'read',       'View supplier (purchase) invoices and their reports'),
  ('purchase_invoices', 'create',     'Create, edit, submit and cancel supplier invoices'),
  ('purchase_invoices', 'approve',    'Approve supplier invoices, including price / quantity variances'),
  ('purchase_invoices', 'post',       'Post approved supplier invoices to the accounts'),
  ('purchase_invoices', 'reverse',    'Reverse posted supplier invoices'),
  ('purchase_invoices', 'verify_gst', 'Verify input GST of posted supplier invoices (eligible / ineligible)')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values ('ACCOUNTS_MANAGER', 'purchase_invoices.read'), ('ACCOUNTS_MANAGER', 'purchase_invoices.create'), ('ACCOUNTS_MANAGER', 'purchase_invoices.approve'),
         ('ACCOUNTS_MANAGER', 'purchase_invoices.post'), ('ACCOUNTS_MANAGER', 'purchase_invoices.reverse'), ('ACCOUNTS_MANAGER', 'purchase_invoices.verify_gst'),
         ('PURCHASE_MANAGER', 'purchase_invoices.read'), ('PURCHASE_MANAGER', 'purchase_invoices.create'),
         ('ADMIN', 'purchase_invoices.read'), ('MANAGEMENT_VIEWER', 'purchase_invoices.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m join public.roles r on r.code = m.role_code join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Settings and posting-rule keys (additive)
-- -----------------------------------------------------------------------------
alter table public.accounting_settings add column if not exists pi_price_tolerance_percent numeric(6,2) not null default 0;
alter table public.accounting_settings add column if not exists pi_amount_tolerance numeric(18,2) not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_settings_pi_tolerance_check') then
    alter table public.accounting_settings add constraint accounting_settings_pi_tolerance_check
      check (pi_price_tolerance_percent between 0 and 100 and pi_amount_tolerance >= 0);
  end if;
  -- New posting-rule keys for supplier invoices (the Phase 0 list plus seven keys).
  if not exists (select 1 from pg_constraint where conname = 'accounting_posting_rules_rule_key_pi_check') then
    execute (select format('alter table public.accounting_posting_rules drop constraint %I', conname) from pg_constraint
             where conrelid = 'public.accounting_posting_rules'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%GST_INPUT_PENDING%'
               and pg_get_constraintdef(oid) like '%rule_key%' limit 1);
    alter table public.accounting_posting_rules add constraint accounting_posting_rules_rule_key_pi_check check (rule_key in ('DEBTORS', 'CREDITORS', 'SALES',
      'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES', 'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
      'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE'));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_invoices (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies (id) on delete restrict,
  invoice_number              text not null check (invoice_number ~ '^PINV-[0-9]{6,}$'),
  supplier_id                 uuid not null,
  party_id                    uuid not null,
  supplier_gstin              text check (supplier_gstin is null or supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  supplier_invoice_number     text not null check (length(btrim(supplier_invoice_number)) between 1 and 60),
  supplier_invoice_number_key text not null,
  supplier_invoice_date       date not null,
  recorded_date               date not null,
  due_date                    date,
  purchase_order_id           uuid,
  invoice_type                text not null check (invoice_type in ('GOODS', 'SERVICE', 'EXPENSE', 'FREIGHT', 'OTHER')),
  supply_category             text not null default 'TAXABLE' check (supply_category in ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST')),
  place_of_supply_state_code  text check (place_of_supply_state_code is null or place_of_supply_state_code ~ '^[0-9]{2}$'),
  tax_treatment               text not null default 'INTRA_STATE' check (tax_treatment in ('INTRA_STATE', 'INTER_STATE')),
  reverse_charge              boolean not null default false,
  currency                    text not null default 'INR' check (currency = 'INR'),
  subtotal                    numeric(18,2) not null default 0,
  discount_total              numeric(18,2) not null default 0,
  taxable_value               numeric(18,2) not null default 0,
  cgst_total                  numeric(18,2) not null default 0,
  sgst_total                  numeric(18,2) not null default 0,
  igst_total                  numeric(18,2) not null default 0,
  cess_total                  numeric(18,2) not null default 0,
  round_off                   numeric(6,2) not null default 0 check (round_off between -1 and 1),
  grand_total                 numeric(18,2) not null default 0 check (grand_total >= 0),
  supplier_stated_total       numeric(18,2),
  narration                   text check (narration is null or length(narration) <= 1000),
  status                      text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED', 'CANCELLED')),
  variance_status             text not null default 'NONE' check (variance_status in ('NONE', 'WITHIN_TOLERANCE', 'EXCEPTION', 'APPROVED')),
  variance_note               text check (variance_note is null or length(variance_note) <= 1000),
  gst_status                  text not null default 'NOT_APPLICABLE' check (gst_status in ('NOT_APPLICABLE', 'PENDING_VERIFICATION', 'ELIGIBLE', 'INELIGIBLE')),
  gst_verified_by             uuid,
  gst_verified_at             timestamptz,
  gst_verification            jsonb,
  voucher_id                  uuid,
  gst_voucher_id              uuid,
  reconciliation              jsonb,
  row_version                 integer not null default 1,
  created_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_by                  uuid,
  updated_at                  timestamptz not null default now(),
  submitted_by                uuid,
  submitted_at                timestamptz,
  approved_by                 uuid,
  approved_at                 timestamptz,
  posted_by                   uuid,
  posted_at                   timestamptz,
  reversed_by                 uuid,
  reversed_at                 timestamptz,
  reversal_reason             text check (reversal_reason is null or length(reversal_reason) <= 1000),
  cancelled_by                uuid,
  cancelled_at                timestamptz,
  cancel_reason               text check (cancel_reason is null or length(cancel_reason) <= 1000),
  constraint purchase_invoices_number_unique unique (company_id, invoice_number),
  constraint purchase_invoices_id_company_unique unique (id, company_id),
  constraint purchase_invoices_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict,
  constraint purchase_invoices_party_fk foreign key (party_id, company_id) references public.parties (id, company_id) on delete restrict,
  constraint purchase_invoices_po_fk foreign key (purchase_order_id, company_id) references public.purchase_orders (id, company_id) on delete restrict,
  constraint purchase_invoices_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint purchase_invoices_gst_voucher_fk foreign key (gst_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint purchase_invoices_totals check (subtotal - discount_total = taxable_value
    and grand_total = taxable_value + round_off + case when reverse_charge then 0 else cgst_total + sgst_total + igst_total + cess_total end),
  constraint purchase_invoices_due check (due_date is null or due_date >= supplier_invoice_date),
  constraint purchase_invoices_posted_state check ((status in ('POSTED', 'REVERSED')) = (posted_at is not null)),
  constraint purchase_invoices_reversed_state check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null)),
  constraint purchase_invoices_cancelled_state check ((status = 'CANCELLED') = (cancelled_at is not null))
);
-- Supplier invoice numbers are unique per supplier (normalized: case, spaces and separators ignored), never globally.
create unique index if not exists purchase_invoices_supplier_number_unique on public.purchase_invoices (company_id, supplier_id, supplier_invoice_number_key)
  where status not in ('CANCELLED', 'REVERSED');
create index if not exists purchase_invoices_company_status_idx on public.purchase_invoices (company_id, status, supplier_invoice_date);

create table if not exists public.purchase_invoice_lines (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  invoice_id            uuid not null,
  line_no               integer not null check (line_no between 1 and 500),
  line_kind             text not null check (line_kind in ('GRN', 'DIRECT')),
  goods_receipt_id      uuid,
  goods_receipt_line_id uuid,
  account_id            uuid,
  description           text check (description is null or length(description) <= 500),
  quantity              numeric(14,3) not null check (quantity > 0),
  unit_price            numeric(16,4) not null check (unit_price >= 0),
  discount              numeric(18,2) not null default 0 check (discount >= 0),
  taxable_value         numeric(18,2) not null check (taxable_value >= 0),
  gst_rate              numeric(5,2) not null default 0 check (gst_rate between 0 and 100),
  cgst                  numeric(18,2) not null default 0 check (cgst >= 0),
  sgst                  numeric(18,2) not null default 0 check (sgst >= 0),
  igst                  numeric(18,2) not null default 0 check (igst >= 0),
  cess                  numeric(18,2) not null default 0 check (cess >= 0),
  -- GRN lines at posting: the receipt's share for this quantity (what the receipt already put in the books).
  matched_net           numeric(18,2),
  matched_gst           numeric(18,2),
  matched_payable       numeric(18,2),
  grn_unit_cost         numeric(16,4),
  grn_gst_rate          numeric(5,2),
  created_at            timestamptz not null default now(),
  constraint purchase_invoice_lines_no_unique unique (invoice_id, line_no),
  constraint purchase_invoice_lines_id_company_unique unique (id, company_id),
  constraint purchase_invoice_lines_invoice_fk foreign key (invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict,
  constraint purchase_invoice_lines_grn_fk foreign key (goods_receipt_id, company_id) references public.goods_receipts (id, company_id) on delete restrict,
  constraint purchase_invoice_lines_grn_line_fk foreign key (goods_receipt_line_id) references public.goods_receipt_lines (id) on delete restrict,
  constraint purchase_invoice_lines_account_fk foreign key (account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint purchase_invoice_lines_kind check ((line_kind = 'GRN') = (goods_receipt_line_id is not null and goods_receipt_id is not null)
    and (line_kind = 'DIRECT') = (account_id is not null)),
  -- A receipt line appears once per invoice.
  constraint purchase_invoice_lines_grn_unique unique (invoice_id, goods_receipt_line_id)
);
create index if not exists purchase_invoice_lines_grn_line_idx on public.purchase_invoice_lines (goods_receipt_line_id) where goods_receipt_line_id is not null;

create table if not exists public.purchase_invoice_allocations (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  invoice_line_id uuid not null,
  cost_centre_id uuid not null,
  amount         numeric(18,2) not null check (amount > 0),
  constraint purchase_invoice_allocations_unique unique (invoice_line_id, cost_centre_id),
  constraint purchase_invoice_allocations_line_fk foreign key (invoice_line_id, company_id) references public.purchase_invoice_lines (id, company_id) on delete restrict,
  constraint purchase_invoice_allocations_centre_fk foreign key (cost_centre_id, company_id) references public.accounting_cost_centres (id, company_id) on delete restrict
);

create table if not exists public.purchase_invoice_history (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  invoice_id uuid not null,
  action     text not null check (action in ('CREATED', 'UPDATED', 'SUBMITTED', 'RETURNED', 'APPROVED', 'POSTED', 'REVERSED', 'CANCELLED', 'GST_VERIFIED',
               'PAYMENT_ALLOCATED', 'PAYMENT_UNALLOCATED')),
  note       text check (note is null or length(note) <= 1000),
  details    jsonb not null default '{}'::jsonb,
  actor_id   uuid,
  created_at timestamptz not null default now(),
  constraint purchase_invoice_history_invoice_fk foreign key (invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict
);
create index if not exists purchase_invoice_history_invoice_idx on public.purchase_invoice_history (invoice_id, created_at);

create table if not exists public.supplier_payment_allocations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  payment_id      uuid not null,
  invoice_id      uuid not null,
  amount          numeric(18,2) not null check (amount > 0),
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVERSED')),
  reversal_reason text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by     uuid,
  reversed_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint supplier_payment_allocations_payment_fk foreign key (payment_id) references public.supplier_payments (id) on delete restrict,
  constraint supplier_payment_allocations_invoice_fk foreign key (invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict,
  constraint supplier_payment_allocations_reversed check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null))
);
create index if not exists supplier_payment_allocations_invoice_idx on public.supplier_payment_allocations (invoice_id) where status = 'ACTIVE';
create index if not exists supplier_payment_allocations_payment_idx on public.supplier_payment_allocations (payment_id) where status = 'ACTIVE';

do $$
declare
  t text;
begin
  foreach t in array array['purchase_invoices', 'purchase_invoice_lines', 'purchase_invoice_allocations', 'purchase_invoice_history', 'supplier_payment_allocations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))', t || '_select', t, 'purchase_invoices.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Guards: posted invoices are immutable (only reversal, GST verification and payment state move on); lines
--    change only while the invoice is a draft (and receive their matched snapshot while being posted); history append-only.
-- -----------------------------------------------------------------------------
create or replace function private.purchase_invoice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_keep   text[] := array['status', 'gst_status', 'gst_verified_by', 'gst_verified_at', 'gst_verification', 'gst_voucher_id', 'reversed_by', 'reversed_at',
                           'reversal_reason', 'updated_by', 'updated_at', 'row_version'];
begin
  if tg_table_name = 'purchase_invoice_history' then
    raise exception 'Purchase invoice history is append-only.' using errcode = '42501';
  end if;
  if tg_table_name = 'purchase_invoices' then
    if new.company_id <> old.company_id or new.supplier_id <> old.supplier_id then
      raise exception 'A purchase invoice cannot move to another company or supplier.' using errcode = '42501';
    end if;
    if old.status in ('REVERSED', 'CANCELLED') then
      raise exception 'A reversed or cancelled purchase invoice cannot be changed.' using errcode = '42501';
    end if;
    if old.status = 'POSTED' and (new.status not in ('POSTED', 'REVERSED') or (to_jsonb(new) - v_keep) <> (to_jsonb(old) - v_keep)) then
      raise exception 'A posted purchase invoice cannot be changed; reverse it instead.' using errcode = '42501';
    end if;
    return new;
  end if;
  select status into v_status from public.purchase_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status is distinct from 'DRAFT' and not (tg_op = 'UPDATE' and v_status = 'APPROVED'
      and (to_jsonb(new) - array['matched_net', 'matched_gst', 'matched_payable', 'grn_unit_cost', 'grn_gst_rate'])
        = (to_jsonb(old) - array['matched_net', 'matched_gst', 'matched_payable', 'grn_unit_cost', 'grn_gst_rate'])) then
    raise exception 'Purchase invoice lines can only be changed while the invoice is a draft.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.purchase_invoice_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id
  where l.id = coalesce(new.invoice_line_id, old.invoice_line_id);
  if v_status is distinct from 'DRAFT' then
    raise exception 'Cost-centre splits of a purchase invoice can only be changed while it is a draft.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.supplier_payment_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'REVERSED' or new.status <> 'REVERSED' or new.amount <> old.amount or new.payment_id <> old.payment_id or new.invoice_id <> old.invoice_id then
    raise exception 'A payment allocation can only be reversed (with a reason); it is never edited.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.purchase_invoice_guard() from public, anon, authenticated;
revoke all on function private.purchase_invoice_allocation_guard() from public, anon, authenticated;
revoke all on function private.supplier_payment_allocation_guard() from public, anon, authenticated;

drop trigger if exists purchase_invoices_guard on public.purchase_invoices;
create trigger purchase_invoices_guard before update on public.purchase_invoices for each row execute function private.purchase_invoice_guard();
drop trigger if exists purchase_invoice_lines_guard on public.purchase_invoice_lines;
create trigger purchase_invoice_lines_guard before insert or update on public.purchase_invoice_lines for each row execute function private.purchase_invoice_guard();
drop trigger if exists purchase_invoice_history_guard on public.purchase_invoice_history;
create trigger purchase_invoice_history_guard before update on public.purchase_invoice_history for each row execute function private.purchase_invoice_guard();
drop trigger if exists purchase_invoice_allocations_guard on public.purchase_invoice_allocations;
create trigger purchase_invoice_allocations_guard before insert or update on public.purchase_invoice_allocations
  for each row execute function private.purchase_invoice_allocation_guard();
drop trigger if exists supplier_payment_allocations_guard on public.supplier_payment_allocations;
create trigger supplier_payment_allocations_guard before update on public.supplier_payment_allocations
  for each row execute function private.supplier_payment_allocation_guard();

-- Goods receipts matched to a live supplier invoice cannot be reversed: the invoice posted only its difference against the
-- receipt's payable, so reversing the receipt would understate Creditors. Cancel / reverse the invoice first. (Guard only;
-- the purchasing functions are unchanged.)
create or replace function private.goods_receipt_invoice_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_numbers text;
begin
  if new.status = 'REVERSED' and old.status is distinct from 'REVERSED' then
    select string_agg(distinct i.invoice_number || ' (' || lower(i.status) || ')', ', ') into v_numbers
    from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id
    where l.goods_receipt_id = new.id and i.status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED');
    if v_numbers is not null then
      raise exception 'Goods receipt % is matched to supplier invoice(s) %; cancel or reverse those invoices before reversing the receipt.', new.receipt_number, v_numbers
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.goods_receipt_invoice_lock() from public, anon, authenticated;
drop trigger if exists goods_receipts_invoice_lock on public.goods_receipts;
create trigger goods_receipts_invoice_lock before update of status on public.goods_receipts for each row execute function private.goods_receipt_invoice_lock();

-- -----------------------------------------------------------------------------
-- 5. Seeding: purchase-invoice ledgers, rules and the PIN voucher type (idempotent; never clashes with a user's accounts)
-- -----------------------------------------------------------------------------
create or replace function private.accounting_seed_purchase_invoices(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if not exists (select 1 from public.account_groups where company_id = p_company and group_code = 'AS.CA.TAX') then
    return;
  end if;
  for r in
    select * from (values
      ('1520', 'Input CGST', 'AS.CA.TAX', 'DEBIT', 'TAX', 'INPUT_CGST'),
      ('1521', 'Input SGST', 'AS.CA.TAX', 'DEBIT', 'TAX', 'INPUT_SGST'),
      ('1522', 'Input IGST', 'AS.CA.TAX', 'DEBIT', 'TAX', 'INPUT_IGST'),
      ('1523', 'Input GST Cess', 'AS.CA.TAX', 'DEBIT', 'TAX', 'INPUT_CESS'),
      ('2240', 'GST Payable under Reverse Charge', 'LI.CL.TAX', 'CREDIT', 'TAX', 'RCM_GST_PAYABLE'),
      ('5150', 'Purchase Price Variance', 'EX.PUR', 'DEBIT', 'GENERAL', 'PURCHASE_PRICE_VARIANCE'),
      ('5910', 'Ineligible Input GST', 'EX.IND', 'DEBIT', 'GENERAL', 'GST_INPUT_INELIGIBLE')
    ) a (code, name, grp, nb, nature, skey)
  loop
    insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature, is_system, system_key)
    select p_company, r.code, r.name, g.id, g.classification, r.nb, r.nature, true, r.skey
    from public.account_groups g
    where g.company_id = p_company and g.group_code = r.grp
      and not exists (select 1 from public.accounts x where x.company_id = p_company
                        and (x.account_code = r.code or lower(x.account_name) = lower(r.name) or x.system_key = r.skey));
    insert into public.accounting_posting_rules (company_id, rule_key, account_id)
    select p_company, r.skey, a.id from public.accounts a where a.company_id = p_company and a.system_key = r.skey
    on conflict (company_id, rule_key, match_value) do nothing;
  end loop;
  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  values (p_company, 'PIN', 'Purchase Invoice', 'PIN', false)
  on conflict (company_id, type_code) do nothing;
end;
$$;
revoke all on function private.accounting_seed_purchase_invoices(uuid) from public, anon, authenticated, service_role;

do $$
declare
  c uuid;
begin
  for c in select company_id from public.accounting_settings loop
    perform private.accounting_seed_purchase_invoices(c);
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Helpers
-- -----------------------------------------------------------------------------
-- Normalized supplier invoice number: upper case, no spaces or separators (INV/23-24/001 = inv 23 24 001).
create or replace function private.pi_number_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- What a goods receipt line put in the books, exactly as the automatic GRN posting computes it (20261231090100).
create or replace function private.pi_grn_line(p_line uuid)
returns table (receipt_id uuid, receipt_number text, receipt_date date, receipt_status text, supplier_id uuid, company_id uuid, purchase_order_id uuid,
  product_id uuid, description text, accepted numeric, payable numeric, net numeric, gst numeric, gst_rate numeric, unit_cost numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.receipt_number, g.receipt_date, g.status, g.supplier_id, g.company_id, g.purchase_order_id, l.product_id,
         coalesce(pol.description, (select p.sku || ' — ' || p.product_name from public.products p where p.id = l.product_id)),
         l.accepted_quantity, y.payable, y.net, y.payable - y.net,
         coalesce(pol.gst_rate, l.gst_rate, 0),
         case when l.accepted_quantity > 0 then round(y.net / l.accepted_quantity, 4) else 0 end
  from public.goods_receipt_lines l
  join public.goods_receipts g on g.id = l.goods_receipt_id
  left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
  cross join lateral (select coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total), 0) as payable) p
  cross join lateral (select p.payable,
      case when l.purchase_order_line_id is not null then
             case when coalesce(pol.line_total, 0) > 0 then round(p.payable * pol.taxable_value / pol.line_total, 2) else p.payable end
           else round(p.payable * 100 / (100 + coalesce(l.gst_rate, 0)), 2) end as net) y
  where l.id = p_line;
$$;

-- Quantity of a receipt line on live invoices (draft, submitted, approved, posted), optionally excluding one invoice.
create or replace function private.pi_grn_invoiced(p_line uuid, p_exclude uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.quantity), 0) from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id
  where l.goods_receipt_line_id = p_line and i.status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED') and (p_exclude is null or i.id <> p_exclude);
$$;

-- Is the receipt's payable in the books (its automatic posting is POSTED, or it pre-dates the books start = in the opening balances)?
create or replace function private.pi_grn_in_books(p_receipt uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.accounting_posting_events e where e.source_type = 'GOODS_RECEIPT' and e.source_id = p_receipt and e.event_action = 'POST'
                   and e.status = 'POSTED')
      or exists (select 1 from public.goods_receipts g join public.accounting_settings s on s.company_id = g.company_id
                 where g.id = p_receipt and g.receipt_date < s.books_start_date);
$$;

create or replace function private.pi_outstanding(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select i.grand_total - coalesce((select sum(a.amount) from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id
                                   where a.invoice_id = i.id and a.status = 'ACTIVE' and p.status = 'RECORDED'), 0)
  from public.purchase_invoices i where i.id = p_invoice;
$$;

create or replace function private.pi_log(p_invoice public.purchase_invoices, p_action text, p_note text, p_details jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.purchase_invoice_history (company_id, invoice_id, action, note, details, actor_id)
  values (p_invoice.company_id, p_invoice.id, p_action, left(p_note, 1000), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_invoice.company_id, 'purchase_invoice.' || lower(p_action), 'purchase_invoice', p_invoice.id::text,
    jsonb_build_object('invoice_number', p_invoice.invoice_number, 'supplier_invoice_number', p_invoice.supplier_invoice_number, 'note', left(p_note, 500))
      || coalesce(p_details, '{}'::jsonb));
end;
$$;

-- Recomputes line taxes and invoice totals from the lines (server-side; the browser's figures are never trusted).
create or replace function private.pi_recalculate(p_invoice uuid)
returns public.purchase_invoices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i public.purchase_invoices;
begin
  select * into i from public.purchase_invoices where id = p_invoice;
  update public.purchase_invoice_lines l
     set cgst = case when i.supply_category = 'TAXABLE' and i.tax_treatment = 'INTRA_STATE' then round(l.taxable_value * l.gst_rate / 200, 2) else 0 end,
         sgst = case when i.supply_category = 'TAXABLE' and i.tax_treatment = 'INTRA_STATE' then round(l.taxable_value * l.gst_rate / 200, 2) else 0 end,
         igst = case when i.supply_category = 'TAXABLE' and i.tax_treatment = 'INTER_STATE' then round(l.taxable_value * l.gst_rate / 100, 2) else 0 end,
         cess = case when i.supply_category = 'TAXABLE' then l.cess else 0 end
   where l.invoice_id = p_invoice;
  update public.purchase_invoices x set
    subtotal = t.gross, discount_total = t.disc, taxable_value = t.taxable, cgst_total = t.cgst, sgst_total = t.sgst, igst_total = t.igst, cess_total = t.cess,
    grand_total = t.taxable + x.round_off + case when x.reverse_charge then 0 else t.cgst + t.sgst + t.igst + t.cess end,
    gst_status = case when t.cgst + t.sgst + t.igst + t.cess > 0 then 'PENDING_VERIFICATION' else 'NOT_APPLICABLE' end
  from (select coalesce(sum(taxable_value + discount), 0) as gross, coalesce(sum(discount), 0) as disc, coalesce(sum(taxable_value), 0) as taxable,
               coalesce(sum(cgst), 0) as cgst, coalesce(sum(sgst), 0) as sgst, coalesce(sum(igst), 0) as igst, coalesce(sum(cess), 0) as cess
        from public.purchase_invoice_lines where invoice_id = p_invoice) t
  where x.id = p_invoice
  returning x.* into i;
  return i;
end;
$$;

-- Every reason an invoice cannot move on: [{code, message, line_no, blocking}]. Variances are not blocking (they need approval).
create or replace function private.pi_issues(p_invoice uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i        public.purchase_invoices;
  s        public.accounting_settings;
  v_issues jsonb := '[]'::jsonb;
  r        record;
  g        record;
  v_rem    numeric;
  v_pct    numeric;
  v_amt    numeric;
begin
  select * into i from public.purchase_invoices where id = p_invoice;
  s := private.accounting_settings_of(i.company_id);
  if not exists (select 1 from public.purchase_invoice_lines where invoice_id = i.id) then
    v_issues := v_issues || jsonb_build_object('code', 'NO_LINES', 'blocking', true, 'message', 'Add at least one line.');
  end if;
  if i.supplier_invoice_date > private.company_today(i.company_id) then
    v_issues := v_issues || jsonb_build_object('code', 'FUTURE_INVOICE_DATE', 'blocking', true, 'message', 'The supplier invoice date is in the future.');
  end if;
  if i.recorded_date < i.supplier_invoice_date then
    v_issues := v_issues || jsonb_build_object('code', 'RECORDED_BEFORE_INVOICE', 'blocking', true, 'message', 'The recording date cannot be before the supplier invoice date.');
  end if;
  if i.supplier_stated_total is not null and i.supplier_stated_total <> i.grand_total then
    v_issues := v_issues || jsonb_build_object('code', 'TOTAL_MISMATCH', 'blocking', true, 'message',
      format('The supplier''s invoice total (%s) differs from the calculated total (%s). Check the lines, tax rates and round-off.',
        to_char(i.supplier_stated_total, 'FM999999999999990.00'), to_char(i.grand_total, 'FM999999999999990.00')));
  end if;
  if i.supplier_stated_total is null then
    v_issues := v_issues || jsonb_build_object('code', 'TOTAL_REQUIRED', 'blocking', true, 'message', 'Enter the total printed on the supplier invoice.');
  end if;
  if i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0 then
    if i.supplier_gstin is null and not i.reverse_charge then
      v_issues := v_issues || jsonb_build_object('code', 'GSTIN_REQUIRED', 'blocking', true, 'message', 'GST is charged, so the supplier''s GSTIN is required.');
    end if;
    if i.place_of_supply_state_code is null then
      v_issues := v_issues || jsonb_build_object('code', 'PLACE_OF_SUPPLY', 'blocking', true, 'message', 'The place of supply is required when GST is charged.');
    end if;
    if i.place_of_supply_state_code is not null and private.gst_state_name(i.place_of_supply_state_code) is null then
      v_issues := v_issues || jsonb_build_object('code', 'PLACE_OF_SUPPLY', 'blocking', true, 'message', 'Unknown place of supply state code.');
    end if;
  end if;
  if i.reverse_charge and exists (select 1 from public.purchase_invoice_lines where invoice_id = i.id and line_kind = 'GRN') then
    v_issues := v_issues || jsonb_build_object('code', 'RCM_GRN', 'blocking', true, 'message', 'Reverse-charge invoices cannot be matched to goods receipts here; enter them as direct lines.');
  end if;
  for r in select l.*, a.account_code, a.is_active as acc_active, a.is_postable, a.account_nature, a.cost_centre_policy from public.purchase_invoice_lines l
           left join public.accounts a on a.id = l.account_id where l.invoice_id = i.id order by l.line_no loop
    if r.line_kind = 'DIRECT' and not (r.acc_active and r.is_postable) then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_INACTIVE', 'blocking', true, 'line_no', r.line_no,
        'message', format('Line %s: account %s is inactive or does not accept postings.', r.line_no, r.account_code));
    end if;
    if r.line_kind = 'DIRECT' and r.account_nature in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL', 'CASH', 'BANK') then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_NOT_ALLOWED', 'blocking', true, 'line_no', r.line_no,
        'message', format('Line %s: a supplier invoice line cannot be posted to account %s.', r.line_no, r.account_code));
    end if;
    if r.line_kind = 'DIRECT' and r.cost_centre_policy = 'REQUIRED' and r.taxable_value > 0
       and not exists (select 1 from public.purchase_invoice_allocations x where x.invoice_line_id = r.id) then
      v_issues := v_issues || jsonb_build_object('code', 'ALLOCATION_REQUIRED', 'blocking', true, 'line_no', r.line_no,
        'message', format('Line %s: account %s needs a cost-centre split (none is assumed).', r.line_no, r.account_code));
    end if;
    if r.line_kind = 'DIRECT' and r.cost_centre_policy = 'NOT_APPLICABLE' and exists (select 1 from public.purchase_invoice_allocations x where x.invoice_line_id = r.id) then
      v_issues := v_issues || jsonb_build_object('code', 'ALLOCATION_NOT_APPLICABLE', 'blocking', true, 'line_no', r.line_no,
        'message', format('Line %s: account %s does not take cost centres; remove the split.', r.line_no, r.account_code));
    end if;
    if r.line_kind = 'DIRECT' and exists (select 1 from public.purchase_invoice_allocations x where x.invoice_line_id = r.id)
       and (select sum(amount) from public.purchase_invoice_allocations x where x.invoice_line_id = r.id) <> r.taxable_value then
      v_issues := v_issues || jsonb_build_object('code', 'ALLOCATION_MISMATCH', 'blocking', true, 'line_no', r.line_no,
        'message', format('Line %s: the cost-centre split must equal the taxable value %s.', r.line_no, to_char(r.taxable_value, 'FM999999999999990.00')));
    end if;
    if r.line_kind = 'GRN' then
      select * into g from private.pi_grn_line(r.goods_receipt_line_id);
      if g.receipt_status <> 'POSTED' then
        v_issues := v_issues || jsonb_build_object('code', 'GRN_REVERSED', 'blocking', true, 'line_no', r.line_no,
          'message', format('Line %s: goods receipt %s has been reversed.', r.line_no, g.receipt_number));
      end if;
      if g.supplier_id is distinct from i.supplier_id then
        v_issues := v_issues || jsonb_build_object('code', 'GRN_SUPPLIER', 'blocking', true, 'line_no', r.line_no,
          'message', format('Line %s: goods receipt %s belongs to another supplier.', r.line_no, g.receipt_number));
      end if;
      v_rem := g.accepted - private.pi_grn_invoiced(r.goods_receipt_line_id, i.id);
      if r.quantity > v_rem then
        v_issues := v_issues || jsonb_build_object('code', 'OVER_INVOICED', 'blocking', true, 'line_no', r.line_no,
          'message', format('Line %s: only %s of goods receipt %s remains uninvoiced (invoice quantity %s).', r.line_no, v_rem, g.receipt_number, r.quantity));
      end if;
      if not private.pi_grn_in_books(g.receipt_id) then
        v_issues := v_issues || jsonb_build_object('code', 'GRN_NOT_POSTED', 'blocking', true, 'line_no', r.line_no,
          'message', format('Line %s: goods receipt %s is not posted to the accounts yet (Posting Monitor).', r.line_no, g.receipt_number));
      end if;
      v_amt := round(r.taxable_value - g.unit_cost * r.quantity, 2);
      v_pct := case when g.unit_cost > 0 then abs(r.unit_price - g.unit_cost) / g.unit_cost * 100 else case when r.unit_price > 0 then 100 else 0 end end;
      if v_amt <> 0 and (v_pct > s.pi_price_tolerance_percent or abs(v_amt) > s.pi_amount_tolerance) then
        v_issues := v_issues || jsonb_build_object('code', 'PRICE_VARIANCE', 'blocking', false, 'line_no', r.line_no, 'amount', v_amt,
          'message', format('Line %s: invoice price %s vs receipt cost %s (difference %s, %s%%) is outside the tolerance and needs approval.', r.line_no,
            to_char(r.unit_price, 'FM999999999990.00##'), to_char(g.unit_cost, 'FM999999999990.00##'), to_char(v_amt, 'FM999999999999990.00'), round(v_pct, 2)));
      end if;
      if r.gst_rate <> g.gst_rate then
        v_issues := v_issues || jsonb_build_object('code', 'GST_RATE_VARIANCE', 'blocking', false, 'line_no', r.line_no,
          'message', format('Line %s: GST rate %s%% differs from the receipt''s %s%% and needs approval.', r.line_no, r.gst_rate, g.gst_rate));
      end if;
    end if;
  end loop;
  return v_issues;
end;
$$;

revoke all on function private.pi_number_key(text) from public, anon, authenticated;
revoke all on function private.pi_grn_line(uuid) from public, anon, authenticated;
revoke all on function private.pi_grn_invoiced(uuid, uuid) from public, anon, authenticated;
revoke all on function private.pi_grn_in_books(uuid) from public, anon, authenticated;
revoke all on function private.pi_outstanding(uuid) from public, anon, authenticated;
revoke all on function private.pi_log(public.purchase_invoices, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.pi_recalculate(uuid) from public, anon, authenticated, service_role;
revoke all on function private.pi_issues(uuid) from public, anon, authenticated;

create or replace function private.pi_json(p_invoice uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(i) || jsonb_build_object(
    'supplier_code', s.supplier_code, 'supplier_name', coalesce(s.display_name, s.legal_name), 'party_code', p.party_code,
    'purchase_order_number', (select po_number from public.purchase_orders where id = i.purchase_order_id),
    'voucher_number', (select voucher_number from public.accounting_vouchers where id = i.voucher_id),
    'gst_voucher_number', (select voucher_number from public.accounting_vouchers where id = i.gst_voucher_id),
    'created_by_name', (select full_name from public.profiles where id = i.created_by),
    'approved_by_name', (select full_name from public.profiles where id = i.approved_by),
    'posted_by_name', (select full_name from public.profiles where id = i.posted_by),
    'outstanding', case when i.status = 'POSTED' then private.pi_outstanding(i.id) end,
    'paid', case when i.status = 'POSTED' then i.grand_total - private.pi_outstanding(i.id) end,
    'lines', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object(
        'account_code', a.account_code, 'account_name', a.account_name,
        'receipt_number', g.receipt_number, 'receipt_date', g.receipt_date, 'product_name', g.description, 'grn_accepted', g.accepted, 'grn_payable', g.payable,
        'grn_net', g.net, 'grn_unit_cost_now', g.unit_cost, 'grn_rate', g.gst_rate,
        'grn_invoiced_elsewhere', case when l.goods_receipt_line_id is not null then private.pi_grn_invoiced(l.goods_receipt_line_id, i.id) end,
        'allocations', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_id', x.cost_centre_id, 'cost_centre_code', c.cost_centre_code,
            'cost_centre_name', c.cost_centre_name, 'amount', x.amount) order by c.cost_centre_code)
          from public.purchase_invoice_allocations x join public.accounting_cost_centres c on c.id = x.cost_centre_id where x.invoice_line_id = l.id), '[]'::jsonb))
        order by l.line_no)
      from public.purchase_invoice_lines l left join public.accounts a on a.id = l.account_id
      left join lateral (select * from private.pi_grn_line(l.goods_receipt_line_id)) g on l.goods_receipt_line_id is not null
      where l.invoice_id = i.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'payment_id', a.payment_id, 'payment_number', sp.payment_number, 'payment_date', sp.payment_date,
        'payment_status', sp.status, 'amount', a.amount, 'status', a.status, 'reversal_reason', a.reversal_reason, 'created_at', a.created_at) order by a.created_at)
      from public.supplier_payment_allocations a join public.supplier_payments sp on sp.id = a.payment_id where a.invoice_id = i.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', h.action, 'note', h.note, 'details', h.details, 'at', h.created_at,
        'by', (select full_name from public.profiles where id = h.actor_id)) order by h.created_at)
      from public.purchase_invoice_history h where h.invoice_id = i.id), '[]'::jsonb))
  from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id join public.parties p on p.id = i.party_id
  where i.id = p_invoice;
$$;
revoke all on function private.pi_json(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Invoice entry and workflow
-- -----------------------------------------------------------------------------
-- Creates (p_invoice_id NULL) or replaces a DRAFT: header + "lines": [{kind GRN | DIRECT, goods_receipt_line_id | account_id, description,
-- quantity, unit_price, discount, gst_rate, cess, allocations: [{cost_centre_id, amount}]}]. Receipt lines are locked while checked,
-- so two invoices cannot take the same remaining quantity.
create or replace function public.purchase_invoice_save(p_invoice_id uuid, p_invoice jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.create');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  i         public.purchase_invoices;
  sup       public.suppliers;
  v_party   uuid;
  v_inv_no  text := private.accounting_text(p_invoice, 'supplier_invoice_number', 60, 'Supplier invoice number');
  v_date    date := private.accounting_date(p_invoice, 'supplier_invoice_date', 'Supplier invoice date');
  v_rec     date := coalesce(private.accounting_date(p_invoice, 'recorded_date', 'Recording date'), private.company_today(v_company));
  v_due     date := private.accounting_date(p_invoice, 'due_date', 'Due date');
  v_type    text := upper(coalesce(private.accounting_text(p_invoice, 'invoice_type', 20, 'Invoice type'), 'GOODS'));
  v_cat     text := upper(coalesce(private.accounting_text(p_invoice, 'supply_category', 20, 'Supply category'), 'TAXABLE'));
  v_pos     text := private.accounting_text(p_invoice, 'place_of_supply_state_code', 2, 'Place of supply');
  v_treat   text := upper(private.accounting_text(p_invoice, 'tax_treatment', 20, 'Tax treatment'));
  v_rcm     boolean := coalesce((p_invoice ->> 'reverse_charge')::boolean, false);
  v_ro      numeric := coalesce(nullif(p_invoice ->> 'round_off', '')::numeric, 0);
  v_stated  numeric;
  v_po      uuid := private.accounting_uuid(p_invoice, 'purchase_order_id', 'Purchase order');
  v_gstin   text := upper(private.accounting_text(p_invoice, 'supplier_gstin', 15, 'Supplier GSTIN'));
  v_company_state text;
  e         jsonb;
  k         int := 0;
  v_kind    text;
  v_line    uuid;
  v_glid    uuid;
  v_acc     uuid;
  v_qty     numeric;
  v_price   numeric;
  v_disc    numeric;
  v_rate    numeric;
  v_cess    numeric;
  v_taxable numeric;
  g         record;
  v_rem     numeric;
  v_new     boolean := p_invoice_id is null;
  v_no      bigint;
begin
  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'The invoice must be an object.' using errcode = '22023';
  end if;
  select * into sup from public.suppliers where id = private.accounting_uuid(p_invoice, 'supplier_id', 'Supplier') and company_id = v_company;
  if not found then
    raise exception 'Select a supplier of this company.' using errcode = '22023';
  end if;
  select id into v_party from public.parties where company_id = v_company and supplier_id = sup.id;
  if v_party is null then
    raise exception 'The supplier has no ledger party; open the Ledger once and try again.' using errcode = 'P0001';
  end if;
  if v_inv_no is null then
    raise exception 'The supplier invoice number is required.' using errcode = '22023';
  end if;
  if v_date is null then
    raise exception 'The supplier invoice date is required.' using errcode = '22023';
  end if;
  if v_type not in ('GOODS', 'SERVICE', 'EXPENSE', 'FREIGHT', 'OTHER') then
    raise exception 'Unknown invoice type %.', v_type using errcode = '22023';
  end if;
  if v_cat not in ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST') then
    raise exception 'Unknown supply category %.', v_cat using errcode = '22023';
  end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'The supplier GSTIN % is not a valid GSTIN.', v_gstin using errcode = '22023';
  end if;
  v_gstin := coalesce(v_gstin, sup.gstin);
  v_pos := coalesce(v_pos, sup.state_code, left(v_gstin, 2));
  if v_pos is not null and v_pos !~ '^[0-9]{2}$' then
    raise exception 'The place of supply must be a 2-digit GST state code.' using errcode = '22023';
  end if;
  select left(gstin, 2) into v_company_state from public.companies where id = v_company;
  v_treat := coalesce(v_treat, case when v_company_state is not null and v_pos is not null and v_company_state <> v_pos then 'INTER_STATE' else 'INTRA_STATE' end);
  if v_treat not in ('INTRA_STATE', 'INTER_STATE') then
    raise exception 'Tax treatment must be INTRA_STATE or INTER_STATE.' using errcode = '22023';
  end if;
  if abs(v_ro) > 1 or v_ro <> round(v_ro, 2) then
    raise exception 'The round-off must be between -1.00 and 1.00.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_invoice ->> 'supplier_stated_total', '')), '') is not null then
    v_stated := private.accounting_amount(p_invoice, 'supplier_stated_total', 'Supplier invoice total');
  end if;
  if v_po is not null and not exists (select 1 from public.purchase_orders where id = v_po and company_id = v_company and supplier_id = sup.id) then
    raise exception 'The purchase order does not belong to this supplier.' using errcode = '22023';
  end if;
  if v_due is null then
    v_due := v_date + case sup.payment_terms when 'IMMEDIATE' then 0 when 'DAYS_7' then 7 when 'DAYS_15' then 15 when 'DAYS_30' then 30 when 'DAYS_45' then 45
                                             else coalesce(sup.custom_payment_days, 30) end;
  end if;

  if v_new then
    perform pg_advisory_xact_lock(hashtextextended('purchase_invoice_number:' || v_company::text, 0));
    select coalesce(max(substr(invoice_number, 6)::bigint), 0) + 1 into v_no from public.purchase_invoices where company_id = v_company;
    insert into public.purchase_invoices (company_id, invoice_number, supplier_id, party_id, supplier_gstin, supplier_invoice_number, supplier_invoice_number_key,
      supplier_invoice_date, recorded_date, due_date, purchase_order_id, invoice_type, supply_category, place_of_supply_state_code, tax_treatment, reverse_charge,
      round_off, supplier_stated_total, narration, created_by, updated_by)
    values (v_company, 'PINV-' || lpad(v_no::text, 6, '0'), sup.id, v_party, v_gstin, v_inv_no, private.pi_number_key(v_inv_no), v_date, v_rec, v_due, v_po, v_type,
      v_cat, v_pos, v_treat, v_rcm, v_ro, v_stated, private.accounting_text(p_invoice, 'narration', 1000, 'Narration'), auth.uid(), auth.uid())
    returning * into i;
  else
    select * into i from public.purchase_invoices where id = p_invoice_id and company_id = v_company for update;
    if not found then
      raise exception 'Purchase invoice not found.' using errcode = 'P0002';
    end if;
    if i.status <> 'DRAFT' then
      raise exception 'Only a draft invoice can be edited (this one is %).', lower(i.status) using errcode = 'P0001';
    end if;
    if p_row_version is not null and i.row_version <> p_row_version then
      raise exception 'This invoice was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    if sup.id <> i.supplier_id then
      raise exception 'The supplier of an invoice cannot change; cancel it and enter a new one.' using errcode = 'P0001';
    end if;
    update public.purchase_invoices set supplier_gstin = v_gstin, supplier_invoice_number = v_inv_no, supplier_invoice_number_key = private.pi_number_key(v_inv_no),
      supplier_invoice_date = v_date, recorded_date = v_rec, due_date = v_due, purchase_order_id = v_po, invoice_type = v_type, supply_category = v_cat,
      place_of_supply_state_code = v_pos, tax_treatment = v_treat, reverse_charge = v_rcm, round_off = v_ro, supplier_stated_total = v_stated,
      narration = private.accounting_text(p_invoice, 'narration', 1000, 'Narration'), updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
     where id = i.id returning * into i;
    delete from public.purchase_invoice_allocations where invoice_line_id in (select id from public.purchase_invoice_lines where invoice_id = i.id);
    delete from public.purchase_invoice_lines where invoice_id = i.id;
  end if;

  if p_invoice ? 'lines' then
    if jsonb_typeof(p_invoice -> 'lines') <> 'array' or jsonb_array_length(p_invoice -> 'lines') > 500 then
      raise exception 'Lines must be a list of at most 500 lines.' using errcode = '22023';
    end if;
    for e in select x from jsonb_array_elements(p_invoice -> 'lines') x loop
      k := k + 1;
      v_kind := upper(coalesce(e ->> 'kind', 'DIRECT'));
      v_qty := coalesce(nullif(e ->> 'quantity', '')::numeric, 1);
      v_price := private.accounting_amount(jsonb_build_object('v', coalesce(e -> 'unit_price', '0'::jsonb)), 'v', format('Line %s unit price', k));
      v_disc := private.accounting_amount(e, 'discount', format('Line %s discount', k));
      v_rate := coalesce(nullif(e ->> 'gst_rate', '')::numeric, 0);
      v_cess := private.accounting_amount(e, 'cess', format('Line %s cess', k));
      if v_qty <= 0 or v_qty <> round(v_qty, 3) then
        raise exception 'Line %: the quantity must be greater than zero (at most 3 decimals).', k using errcode = '22023';
      end if;
      if v_rate not in (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28) then
        raise exception 'Line %: % %% is not a GST rate.', k, v_rate using errcode = '22023';
      end if;
      if v_cat <> 'TAXABLE' and (v_rate <> 0 or v_cess <> 0) then
        raise exception 'Line %: % supplies carry no GST; set the rate and cess to 0.', k, initcap(replace(v_cat, '_', '-')) using errcode = '22023';
      end if;
      v_taxable := round(v_qty * v_price, 2) - v_disc;
      if v_taxable < 0 then
        raise exception 'Line %: the discount is larger than the line value.', k using errcode = '22023';
      end if;
      if v_kind = 'GRN' then
        v_glid := private.accounting_uuid(e, 'goods_receipt_line_id', format('Line %s goods receipt line', k));
        -- Lock the receipt line: a concurrent invoice for the same receipt line waits here and then sees this one.
        perform 1 from public.goods_receipt_lines where id = v_glid and company_id = v_company for update;
        if not found then
          raise exception 'Line %: goods receipt line not found in this company.', k using errcode = '42501';
        end if;
        select * into g from private.pi_grn_line(v_glid);
        if g.supplier_id is distinct from sup.id then
          raise exception 'Line %: goods receipt % belongs to another supplier.', k, g.receipt_number using errcode = 'P0001';
        end if;
        if g.receipt_status <> 'POSTED' then
          raise exception 'Line %: goods receipt % has been reversed.', k, g.receipt_number using errcode = 'P0001';
        end if;
        v_rem := g.accepted - private.pi_grn_invoiced(v_glid, i.id);
        if v_qty > v_rem then
          raise exception 'Line %: only % of goods receipt % remains uninvoiced (other invoices already cover the rest).', k, v_rem, g.receipt_number using errcode = 'P0001';
        end if;
        begin
          insert into public.purchase_invoice_lines (company_id, invoice_id, line_no, line_kind, goods_receipt_id, goods_receipt_line_id, description, quantity,
            unit_price, discount, taxable_value, gst_rate, cess)
          values (v_company, i.id, k, 'GRN', g.receipt_id, v_glid, coalesce(private.accounting_text(e, 'description', 500, 'Description'), g.description), v_qty,
            v_price, v_disc, v_taxable, v_rate, v_cess);
        exception when unique_violation then
          raise exception 'Line %: goods receipt line of % appears twice on this invoice.', k, g.receipt_number using errcode = '23505';
        end;
      elsif v_kind = 'DIRECT' then
        v_acc := private.accounting_uuid(e, 'account_id', format('Line %s account', k));
        if v_acc is null or not exists (select 1 from public.accounts where id = v_acc and company_id = v_company) then
          raise exception 'Line %: select a ledger account of this company.', k using errcode = '22023';
        end if;
        insert into public.purchase_invoice_lines (company_id, invoice_id, line_no, line_kind, account_id, description, quantity, unit_price, discount, taxable_value, gst_rate, cess)
        values (v_company, i.id, k, 'DIRECT', v_acc, private.accounting_text(e, 'description', 500, 'Description'), v_qty, v_price, v_disc, v_taxable, v_rate, v_cess)
        returning id into v_line;
        if jsonb_typeof(e -> 'allocations') = 'array' then
          begin
            insert into public.purchase_invoice_allocations (company_id, invoice_line_id, cost_centre_id, amount)
            select v_company, v_line, c.id, private.accounting_amount(a, 'amount', format('Line %s cost-centre amount', k))
            from jsonb_array_elements(e -> 'allocations') a
            join public.accounting_cost_centres c on c.id = private.accounting_uuid(a, 'cost_centre_id', 'Cost centre') and c.company_id = v_company;
            if (select count(*) from jsonb_array_elements(e -> 'allocations')) <> (select count(*) from public.purchase_invoice_allocations where invoice_line_id = v_line) then
              raise exception 'Line %: a cost centre was not found in this company.', k using errcode = '42501';
            end if;
          exception when unique_violation then
            raise exception 'Line %: the same cost centre appears twice; combine the amounts.', k using errcode = '23505';
          end;
        end if;
      else
        raise exception 'Line %: kind must be GRN or DIRECT.', k using errcode = '22023';
      end if;
    end loop;
  end if;
  i := private.pi_recalculate(i.id);
  perform private.pi_log(i, case when v_new then 'CREATED' else 'UPDATED' end, null, jsonb_build_object('lines', k, 'grand_total', i.grand_total));
  return private.pi_json(i.id) || jsonb_build_object('issues', private.pi_issues(i.id));
exception
  when unique_violation then
    if sqlerrm like '%purchase_invoices_supplier_number_unique%' then
      raise exception 'Supplier invoice % has already been entered for %.', v_inv_no, coalesce(sup.display_name, sup.legal_name) using errcode = '23505';
    end if;
    raise;
  when invalid_text_representation then
    raise exception 'A number or flag in the invoice is not valid.' using errcode = '22023';
end;
$$;

create or replace function public.purchase_invoice_get(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
begin
  if not exists (select 1 from public.purchase_invoices where id = p_invoice_id and company_id = v_company) then
    raise exception 'Purchase invoice not found.' using errcode = 'P0002';
  end if;
  return private.pi_json(p_invoice_id) || jsonb_build_object('issues', private.pi_issues(p_invoice_id));
end;
$$;

create or replace function private.pi_lock(p_company uuid, p_invoice uuid, p_status text[])
returns public.purchase_invoices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i public.purchase_invoices;
begin
  select * into i from public.purchase_invoices where id = p_invoice and company_id = p_company for update;
  if not found then
    raise exception 'Purchase invoice not found.' using errcode = 'P0002';
  end if;
  if not (i.status = any (p_status)) then
    raise exception 'This invoice is % — the action needs it to be %.', lower(i.status), lower(array_to_string(p_status, ' or ')) using errcode = 'P0001';
  end if;
  return i;
end;
$$;
revoke all on function private.pi_lock(uuid, uuid, text[]) from public, anon, authenticated, service_role;

create or replace function public.purchase_invoice_submit(p_invoice_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.create');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['DRAFT']);
  v_issues  jsonb := private.pi_issues(p_invoice_id);
  v_block   jsonb;
begin
  select jsonb_agg(x) into v_block from jsonb_array_elements(v_issues) x where (x ->> 'blocking')::boolean;
  if v_block is not null then
    raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
  end if;
  update public.purchase_invoices set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(),
    variance_status = case when exists (select 1 from jsonb_array_elements(v_issues) x where x ->> 'code' in ('PRICE_VARIANCE', 'GST_RATE_VARIANCE')) then 'EXCEPTION'
                           when exists (select 1 from public.purchase_invoice_lines where invoice_id = i.id and line_kind = 'GRN') then 'WITHIN_TOLERANCE' else 'NONE' end,
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'SUBMITTED', null, jsonb_build_object('variance_status', i.variance_status));
  return private.pi_json(i.id) || jsonb_build_object('issues', private.pi_issues(i.id));
end;
$$;

-- Approval. Variances outside the tolerance need p_accept_variances and a note of at least 10 characters.
create or replace function public.purchase_invoice_approve(p_invoice_id uuid, p_note text default null, p_accept_variances boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.approve');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['SUBMITTED']);
begin
  if s.segregation_of_duties and i.created_by = auth.uid() then
    raise exception 'Segregation of duties is on: the invoice must be approved by someone other than the person who entered it.' using errcode = '42501';
  end if;
  if i.variance_status = 'EXCEPTION' and (not coalesce(p_accept_variances, false) or length(btrim(coalesce(p_note, ''))) < 10) then
    raise exception 'The invoice has price / GST-rate variances outside the tolerance: approve them explicitly with a reason of at least 10 characters.'
      using errcode = 'P0001';
  end if;
  update public.purchase_invoices set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(),
    variance_status = case when variance_status = 'EXCEPTION' then 'APPROVED' else variance_status end,
    variance_note = case when variance_status = 'EXCEPTION' then left(btrim(p_note), 1000) else variance_note end,
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'APPROVED', p_note, jsonb_build_object('variance_status', i.variance_status));
  return private.pi_json(i.id) || jsonb_build_object('issues', private.pi_issues(i.id));
end;
$$;

create or replace function public.purchase_invoice_return_to_draft(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_invoices.create', 'purchase_invoices.approve']);
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['SUBMITTED', 'APPROVED']);
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  update public.purchase_invoices set status = 'DRAFT', submitted_at = null, submitted_by = null, approved_at = null, approved_by = null, variance_status = 'NONE',
    variance_note = null, updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'RETURNED', p_reason, '{}'::jsonb);
  return private.pi_json(i.id) || jsonb_build_object('issues', private.pi_issues(i.id));
end;
$$;

create or replace function public.purchase_invoice_cancel(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.create');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['DRAFT', 'SUBMITTED', 'APPROVED']);
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  update public.purchase_invoices set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(btrim(p_reason), 1000),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'CANCELLED', p_reason, '{}'::jsonb);
  return private.pi_json(i.id);
end;
$$;

-- Posts an APPROVED invoice. Matched receipt lines post only their differences against the receipt's share (see the header).
create or replace function public.purchase_invoice_post(p_invoice_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.post');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['APPROVED']);
  v_block   jsonb;
  r         record;
  g         record;
  v_prior   numeric;
  v_done    numeric;
  v_mnet    numeric;
  v_mpay    numeric;
  v_rules   jsonb := '{}'::jsonb;
  v_key     text;
  v_missing text[] := '{}';
  v_lines   jsonb := '[]'::jsonb;
  v_ppv     numeric := 0;
  v_gstdiff numeric := 0;
  v_cred    numeric := 0;
  v_direct_tax numeric := 0;
  v_tax     numeric;
  v_id      uuid;
  v         public.accounting_vouchers;
  v_recon   jsonb := '[]'::jsonb;
begin
  perform private.accounting_require_setup(v_company);
  -- Lock every matched receipt line again (concurrent posting / invoicing of the same lines waits).
  perform 1 from public.goods_receipt_lines where id in (select goods_receipt_line_id from public.purchase_invoice_lines where invoice_id = i.id) for update;
  select jsonb_agg(x) into v_block from jsonb_array_elements(private.pi_issues(i.id)) x where (x ->> 'blocking')::boolean;
  if v_block is not null then
    raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
  end if;
  foreach v_key in array array['CREDITORS', 'PURCHASES', 'GST_INPUT_PENDING', 'PURCHASE_PRICE_VARIANCE', 'ROUND_OFF', 'RCM_GST_PAYABLE'] loop
    if private.accounting_rule_account(v_company, v_key, '') is not null then
      v_rules := v_rules || jsonb_build_object(v_key, private.accounting_rule_account(v_company, v_key, ''));
    end if;
  end loop;

  for r in select * from public.purchase_invoice_lines where invoice_id = i.id order by line_no loop
    v_tax := r.cgst + r.sgst + r.igst + r.cess;
    if r.line_kind = 'GRN' then
      select * into g from private.pi_grn_line(r.goods_receipt_line_id);
      -- Receipt share for this quantity, cumulative over posted invoices so the shares add up exactly to the receipt's values.
      select coalesce(sum(l.quantity), 0), coalesce(sum(l.matched_net), 0), coalesce(sum(l.matched_payable), 0) into v_prior, v_mnet, v_mpay
      from public.purchase_invoice_lines l join public.purchase_invoices x on x.id = l.invoice_id
      where l.goods_receipt_line_id = r.goods_receipt_line_id and x.status = 'POSTED';
      v_done := v_prior + r.quantity;
      update public.purchase_invoice_lines set
        matched_net = round(g.net * v_done / g.accepted, 2) - v_mnet,
        matched_payable = round(g.payable * v_done / g.accepted, 2) - v_mpay,
        matched_gst = (round(g.payable * v_done / g.accepted, 2) - v_mpay) - (round(g.net * v_done / g.accepted, 2) - v_mnet),
        grn_unit_cost = g.unit_cost, grn_gst_rate = g.gst_rate
      where id = r.id returning * into r;
      v_ppv := v_ppv + (r.taxable_value - r.matched_net);
      v_gstdiff := v_gstdiff + (v_tax - r.matched_gst);
      v_cred := v_cred + (r.taxable_value + v_tax - r.matched_payable);
      v_recon := v_recon || jsonb_build_object('line_no', r.line_no, 'receipt', g.receipt_number, 'quantity', r.quantity, 'receipt_payable_share', r.matched_payable,
        'invoice_amount', r.taxable_value + v_tax, 'creditors_adjustment', r.taxable_value + v_tax - r.matched_payable);
    else
      v_lines := v_lines || jsonb_build_object('account_id', r.account_id, 'debit', r.taxable_value, 'narration', coalesce(r.description, 'Supplier invoice line'),
        'allocations', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_id', x.cost_centre_id, 'amount', x.amount))
                                 from public.purchase_invoice_allocations x where x.invoice_line_id = r.id), '[]'::jsonb));
      v_direct_tax := v_direct_tax + v_tax;
      v_cred := v_cred + r.taxable_value + case when i.reverse_charge then 0 else v_tax end;
    end if;
  end loop;
  v_cred := v_cred + i.round_off;

  if v_ppv <> 0 and not v_rules ? 'PURCHASE_PRICE_VARIANCE' then v_missing := v_missing || 'Purchase price variance'; end if;
  if (v_gstdiff <> 0 or v_direct_tax <> 0) and not v_rules ? 'GST_INPUT_PENDING' then v_missing := v_missing || 'GST input pending verification'; end if;
  if v_cred <> 0 and not v_rules ? 'CREDITORS' then v_missing := v_missing || 'Creditors'; end if;
  if i.round_off <> 0 and not v_rules ? 'ROUND_OFF' then v_missing := v_missing || 'Round off'; end if;
  if i.reverse_charge and v_direct_tax <> 0 and not v_rules ? 'RCM_GST_PAYABLE' then v_missing := v_missing || 'GST payable under reverse charge'; end if;
  if cardinality(v_missing) > 0 then
    raise exception 'Map an active account in Accounting Settings > Posting rules for: %.', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  if v_ppv > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'PURCHASE_PRICE_VARIANCE', 'debit', v_ppv, 'narration', 'Price difference against goods receipts'); end if;
  if v_ppv < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'PURCHASE_PRICE_VARIANCE', 'credit', -v_ppv, 'narration', 'Price difference against goods receipts'); end if;
  if v_gstdiff + v_direct_tax > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'GST_INPUT_PENDING', 'debit', v_gstdiff + v_direct_tax, 'narration', 'Input GST pending verification');
  elsif v_gstdiff + v_direct_tax < 0 then
    v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'GST_INPUT_PENDING', 'credit', -(v_gstdiff + v_direct_tax), 'narration', 'Input GST pending verification');
  end if;
  if i.reverse_charge and v_direct_tax > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'RCM_GST_PAYABLE', 'credit', v_direct_tax, 'narration', 'GST payable under reverse charge');
  end if;
  if i.round_off > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'ROUND_OFF', 'debit', i.round_off); end if;
  if i.round_off < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'ROUND_OFF', 'credit', -i.round_off); end if;
  if v_cred > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'CREDITORS', 'party_id', i.party_id, 'credit', v_cred); end if;
  if v_cred < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_rules ->> 'CREDITORS', 'party_id', i.party_id, 'debit', -v_cred); end if;

  -- Nothing differs from the receipts: no voucher (the receipts already carry the full liability).
  if jsonb_array_length(v_lines) > 0 then
    v_id := private.accounting_create_voucher(v_company, 'PIN', i.recorded_date, i.supplier_invoice_number,
      left(format('Supplier invoice %s (%s) — %s', i.supplier_invoice_number, i.invoice_number,
        (select coalesce(display_name, legal_name) from public.suppliers where id = i.supplier_id)), 1000),
      'AUTO', 'PURCHASE_INVOICE', i.id, i.invoice_number, null, v_lines);
    v := private.accounting_post_voucher(v_id);
  end if;
  update public.purchase_invoices set status = 'POSTED', posted_by = auth.uid(), posted_at = now(), voucher_id = v.id,
    reconciliation = jsonb_build_object('lines', v_recon, 'receipt_share_total', coalesce((select sum(matched_payable) from public.purchase_invoice_lines where invoice_id = i.id), 0),
      'creditors_posted_by_invoice', v_cred, 'invoice_total', i.grand_total, 'reconciled',
      coalesce((select sum(matched_payable) from public.purchase_invoice_lines where invoice_id = i.id), 0) + v_cred = i.grand_total
),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = i.id returning * into i;
  perform private.pi_log(i, 'POSTED', null, jsonb_build_object('voucher_number', v.voucher_number, 'creditors', v_cred, 'price_variance', v_ppv, 'gst_difference', v_gstdiff));
  return private.pi_json(i.id);
end;
$$;

-- GST verification of a POSTED invoice: ELIGIBLE moves the tax to the input CGST / SGST / IGST / cess ledgers, INELIGIBLE to the
-- ineligible-GST expense. A reason and the checks done are required; nothing is claimed automatically.
create or replace function public.purchase_invoice_verify_gst(p_invoice_id uuid, p_status text, p_reason text, p_checks jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v_status  text := upper(coalesce(p_status, ''));
  v_lines   jsonb := '[]'::jsonb;
  v_total   numeric;
  v_pending uuid := private.accounting_rule_account(v_company, 'GST_INPUT_PENDING', '');
  v_id      uuid;
  v         public.accounting_vouchers;
  v_key     text;
  v_amt     numeric;
begin
  if i.gst_status <> 'PENDING_VERIFICATION' then
    raise exception 'The GST of this invoice is % — only pending GST can be verified.', lower(replace(i.gst_status, '_', ' ')) using errcode = 'P0001';
  end if;
  if v_status not in ('ELIGIBLE', 'INELIGIBLE') then
    raise exception 'Status must be ELIGIBLE or INELIGIBLE.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Record why (at least 10 characters), e.g. what was checked against the supplier invoice.' using errcode = '22023';
  end if;
  if v_status = 'ELIGIBLE' and not (coalesce((p_checks ->> 'invoice_verified')::boolean, false) and coalesce((p_checks ->> 'goods_services_received')::boolean, false)
      and coalesce((p_checks ->> 'gstin_valid')::boolean, false)) then
    raise exception 'Eligible input GST needs the checks: supplier invoice verified, goods / services received, supplier GSTIN valid.' using errcode = 'P0001';
  end if;
  v_total := i.cgst_total + i.sgst_total + i.igst_total + i.cess_total;
  if v_pending is null then
    raise exception 'Map the GST input pending verification account first.' using errcode = 'P0001';
  end if;
  if v_status = 'ELIGIBLE' then
    foreach v_key in array array['INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS'] loop
      v_amt := case v_key when 'INPUT_CGST' then i.cgst_total when 'INPUT_SGST' then i.sgst_total when 'INPUT_IGST' then i.igst_total else i.cess_total end;
      if v_amt > 0 then
        if private.accounting_rule_account(v_company, v_key, '') is null then
          raise exception 'Map an active account in Accounting Settings > Posting rules for %.', v_key using errcode = 'P0001';
        end if;
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company, v_key, ''), 'debit', v_amt, 'narration', 'Eligible input ' || replace(v_key, 'INPUT_', ''));
      end if;
    end loop;
  else
    if private.accounting_rule_account(v_company, 'GST_INPUT_INELIGIBLE', '') is null then
      raise exception 'Map an active account in Accounting Settings > Posting rules for the ineligible input GST expense.' using errcode = 'P0001';
    end if;
    v_lines := jsonb_build_array(jsonb_build_object('account_id', private.accounting_rule_account(v_company, 'GST_INPUT_INELIGIBLE', ''), 'debit', v_total,
      'narration', 'Ineligible input GST'));
  end if;
  v_lines := v_lines || jsonb_build_object('account_id', v_pending, 'credit', v_total, 'narration', 'Out of GST input pending verification');
  v_id := private.accounting_create_voucher(v_company, 'PIN', private.company_today(v_company), i.supplier_invoice_number,
    left(format('Input GST of supplier invoice %s (%s) verified %s', i.supplier_invoice_number, i.invoice_number, lower(v_status)), 1000),
    'AUTO', 'PURCHASE_INVOICE_GST', i.id, i.invoice_number, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  update public.purchase_invoices set gst_status = v_status, gst_verified_by = auth.uid(), gst_verified_at = now(), gst_voucher_id = v.id,
    gst_verification = jsonb_build_object('status', v_status, 'reason', left(btrim(p_reason), 1000), 'checks', coalesce(p_checks, '{}'::jsonb)),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'GST_VERIFIED', p_reason, jsonb_build_object('status', v_status, 'amount', v_total, 'voucher_number', v.voucher_number, 'checks', p_checks));
  return private.pi_json(i.id);
end;
$$;

-- Controlled reversal of a POSTED invoice: linked reversal vouchers of its posting and GST vouchers; no active payment allocations.
create or replace function public.purchase_invoice_reverse(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.reverse');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v1        public.accounting_vouchers;
  v2        public.accounting_vouchers;
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  if exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id
             where a.invoice_id = i.id and a.status = 'ACTIVE' and p.status = 'RECORDED') then
    raise exception 'Payments are allocated to this invoice; remove the allocations first.' using errcode = 'P0001';
  end if;
  if i.gst_voucher_id is not null then
    v2 := private.accounting_reverse_voucher(i.gst_voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
  end if;
  if i.voucher_id is not null then
    v1 := private.accounting_reverse_voucher(i.voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
  end if;
  update public.purchase_invoices set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 1000),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'REVERSED', p_reason, jsonb_build_object('reversal_voucher', v1.voucher_number, 'gst_reversal_voucher', v2.voucher_number));
  return private.pi_json(i.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Supplier payments against invoices (existing payments; their vouchers are unchanged)
-- -----------------------------------------------------------------------------
create or replace function public.purchase_invoice_allocate_payment(p_invoice_id uuid, p_payment_id uuid, p_amount numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('supplier_payment.manage');
  i         public.purchase_invoices;
  p         public.supplier_payments;
  v_free    numeric;
begin
  -- Fixed lock order (payment, then invoice) so concurrent allocations queue instead of deadlocking.
  select * into p from public.supplier_payments where id = p_payment_id and company_id = v_company for update;
  if not found then
    raise exception 'Supplier payment not found.' using errcode = 'P0002';
  end if;
  i := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  if p.status <> 'RECORDED' then
    raise exception 'Payment % is reversed.', p.payment_number using errcode = 'P0001';
  end if;
  if p.supplier_id <> i.supplier_id then
    raise exception 'Payment % belongs to another supplier.', p.payment_number using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'The amount must be greater than zero (at most 2 decimals).' using errcode = '22023';
  end if;
  v_free := p.amount - coalesce((select sum(amount) from public.supplier_payment_allocations where payment_id = p.id and status = 'ACTIVE'), 0);
  if p_amount > v_free then
    raise exception 'Only % of payment % is unallocated.', v_free, p.payment_number using errcode = 'P0001';
  end if;
  if p_amount > private.pi_outstanding(i.id) then
    raise exception 'The invoice has only % outstanding.', private.pi_outstanding(i.id) using errcode = 'P0001';
  end if;
  insert into public.supplier_payment_allocations (company_id, payment_id, invoice_id, amount, created_by) values (v_company, p.id, i.id, p_amount, auth.uid());
  perform private.pi_log(i, 'PAYMENT_ALLOCATED', null, jsonb_build_object('payment_number', p.payment_number, 'amount', p_amount));
  return private.pi_json(i.id);
end;
$$;

create or replace function public.purchase_invoice_unallocate_payment(p_allocation_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('supplier_payment.manage');
  a         public.supplier_payment_allocations;
  i         public.purchase_invoices;
begin
  select * into a from public.supplier_payment_allocations where id = p_allocation_id and company_id = v_company for update;
  if not found or a.status <> 'ACTIVE' then
    raise exception 'Active payment allocation not found.' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  update public.supplier_payment_allocations set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 500)
   where id = a.id;
  select * into i from public.purchase_invoices where id = a.invoice_id;
  perform private.pi_log(i, 'PAYMENT_UNALLOCATED', p_reason, jsonb_build_object('amount', a.amount));
  return private.pi_json(i.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Lists, matching candidates, settings and reports
-- -----------------------------------------------------------------------------
create or replace function public.purchase_invoice_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := private.accounting_date(f, 'from', 'From');
  v_to      date := private.accounting_date(f, 'to', 'To');
  v_status  text := upper(nullif(f ->> 'status', ''));
  v_sup     uuid := private.accounting_uuid(f, 'supplier_id', 'Supplier');
  v_term    text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_out     boolean := coalesce((f ->> 'outstanding_only')::boolean, false);
begin
  return coalesce((select jsonb_agg(x order by x ->> 'supplier_invoice_date' desc, x ->> 'invoice_number' desc) from (
    select jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'supplier_id', i.supplier_id, 'supplier_name', coalesce(s.display_name, s.legal_name),
      'supplier_code', s.supplier_code, 'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date,
      'due_date', i.due_date, 'invoice_type', i.invoice_type, 'status', i.status, 'variance_status', i.variance_status, 'gst_status', i.gst_status,
      'taxable_value', i.taxable_value, 'tax_total', i.cgst_total + i.sgst_total + i.igst_total + i.cess_total, 'grand_total', i.grand_total,
      'outstanding', case when i.status = 'POSTED' then private.pi_outstanding(i.id) end, 'reverse_charge', i.reverse_charge,
      'voucher_number', (select voucher_number from public.accounting_vouchers where id = i.voucher_id),
      'has_grn', exists (select 1 from public.purchase_invoice_lines where invoice_id = i.id and line_kind = 'GRN'),
      'created_by_name', (select full_name from public.profiles where id = i.created_by)) as x
    from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
    where i.company_id = v_company and (v_from is null or i.supplier_invoice_date >= v_from) and (v_to is null or i.supplier_invoice_date <= v_to)
      and (v_status is null or i.status = v_status) and (v_sup is null or i.supplier_id = v_sup)
      and (v_term is null or i.invoice_number ilike '%' || v_term || '%' or i.supplier_invoice_number ilike '%' || v_term || '%'
           or coalesce(s.display_name, s.legal_name) ilike '%' || v_term || '%')
      and (not v_out or (i.status = 'POSTED' and private.pi_outstanding(i.id) > 0))
    order by i.supplier_invoice_date desc limit 1000) q), '[]'::jsonb);
end;
$$;

-- Receipt lines of a supplier (optionally one purchase order) with ordered, received, invoiced and remaining quantities.
create or replace function public.purchase_invoice_matching_candidates(p_supplier_id uuid, p_purchase_order_id uuid default null, p_include_done boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
begin
  return coalesce((select jsonb_agg(x order by x ->> 'receipt_date', x ->> 'receipt_number', (x ->> 'line_id')) from (
    select jsonb_build_object('line_id', l.id, 'receipt_id', g.id, 'receipt_number', g.receipt_number, 'receipt_date', g.receipt_date, 'receipt_type', g.receipt_type,
      'purchase_order_id', g.purchase_order_id, 'po_number', po.po_number, 'description', v.description, 'unit', l.unit,
      'ordered_quantity', pol.ordered_quantity, 'received_quantity', l.received_quantity, 'accepted_quantity', l.accepted_quantity,
      'invoiced_quantity', private.pi_grn_invoiced(l.id), 'posted_invoiced_quantity', (select coalesce(sum(il.quantity), 0) from public.purchase_invoice_lines il
         join public.purchase_invoices pi on pi.id = il.invoice_id where il.goods_receipt_line_id = l.id and pi.status = 'POSTED'),
      'remaining_quantity', l.accepted_quantity - private.pi_grn_invoiced(l.id), 'unit_cost', v.unit_cost, 'gst_rate', v.gst_rate,
      'payable', v.payable, 'net', v.net, 'gst', v.gst, 'in_books', private.pi_grn_in_books(g.id)) as x
    from public.goods_receipt_lines l join public.goods_receipts g on g.id = l.goods_receipt_id
    left join public.purchase_orders po on po.id = g.purchase_order_id
    left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
    cross join lateral (select * from private.pi_grn_line(l.id)) v
    where g.company_id = v_company and g.supplier_id = p_supplier_id and g.status = 'POSTED' and l.accepted_quantity > 0
      and (p_purchase_order_id is null or g.purchase_order_id = p_purchase_order_id)
      and (p_include_done or l.accepted_quantity - private.pi_grn_invoiced(l.id) > 0)) q), '[]'::jsonb);
end;
$$;

-- Posted / available supplier payments of a supplier with their unallocated amounts.
create or replace function public.purchase_invoice_supplier_payments(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_invoices.read', 'supplier_payment.manage']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'payment_number', p.payment_number, 'payment_date', p.payment_date, 'amount', p.amount,
      'payment_method', p.payment_method, 'reference', p.reference,
      'unallocated', p.amount - coalesce((select sum(amount) from public.supplier_payment_allocations where payment_id = p.id and status = 'ACTIVE'), 0))
      order by p.payment_date)
    from public.supplier_payments p where p.company_id = v_company and p.supplier_id = p_supplier_id and p.status = 'RECORDED'), '[]'::jsonb);
end;
$$;

-- What the invoice entry screen needs, readable with purchase_invoices.read alone (a Purchase Manager has no accounts.read):
-- active suppliers, postable expense-side ledgers (no control, cash or bank accounts), active cost centres and the tolerances.
create or replace function public.purchase_invoice_lookups()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
  s         public.accounting_settings;
begin
  select * into s from public.accounting_settings where company_id = v_company;
  return jsonb_build_object(
    'initialized', s.company_id is not null,
    'today', private.company_today(v_company),
    'books_start_date', s.books_start_date,
    'pi_price_tolerance_percent', s.pi_price_tolerance_percent,
    'pi_amount_tolerance', s.pi_amount_tolerance,
    'company_state_code', (select left(gstin, 2) from public.companies where id = v_company),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'supplier_code', x.supplier_code, 'name', coalesce(x.display_name, x.legal_name),
        'gstin', x.gstin, 'state_code', x.state_code, 'payment_terms', x.payment_terms) order by coalesce(x.display_name, x.legal_name))
      from public.suppliers x where x.company_id = v_company and x.status = 'ACTIVE'), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name,
        'classification', a.classification, 'cost_centre_policy', a.cost_centre_policy) order by a.account_code)
      from public.accounts a where a.company_id = v_company and a.is_active and a.is_postable
        and a.account_nature not in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL', 'CASH', 'BANK')), '[]'::jsonb),
    'cost_centres', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
        'description', c.description, 'parent_cost_centre_id', c.parent_cost_centre_id, 'is_active', c.is_active, 'updated_at', c.updated_at,
        'cost_centre_type', c.cost_centre_type, 'effective_from', c.effective_from, 'effective_to', c.effective_to) order by c.cost_centre_code)
      from public.accounting_cost_centres c where c.company_id = v_company and c.is_active), '[]'::jsonb));
end;
$$;

create or replace function public.purchase_invoice_settings_save(p_settings jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_pct     numeric := coalesce(nullif(p_settings ->> 'pi_price_tolerance_percent', '')::numeric, s.pi_price_tolerance_percent);
  v_amt     numeric := coalesce(nullif(p_settings ->> 'pi_amount_tolerance', '')::numeric, s.pi_amount_tolerance);
begin
  if v_pct not between 0 and 100 or v_amt < 0 or v_amt <> round(v_amt, 2) then
    raise exception 'Tolerances: a percentage between 0 and 100 and an amount of 0 or more (2 decimals).' using errcode = '22023';
  end if;
  update public.accounting_settings set pi_price_tolerance_percent = v_pct, pi_amount_tolerance = v_amt, updated_by = auth.uid(), updated_at = now()
   where company_id = v_company;
  perform private.write_audit_log(v_company, 'purchase_invoice.settings', 'accounting_settings', v_company::text,
    jsonb_build_object('from', jsonb_build_object('percent', s.pi_price_tolerance_percent, 'amount', s.pi_amount_tolerance), 'to', jsonb_build_object('percent', v_pct, 'amount', v_amt)));
  return jsonb_build_object('pi_price_tolerance_percent', v_pct, 'pi_amount_tolerance', v_amt);
exception
  when invalid_text_representation then
    raise exception 'The tolerance values must be numbers.' using errcode = '22023';
end;
$$;

-- Reports. Accounting figures (ITC summary, cost-centre purchase expense, payables per ledger) come from posted vouchers only;
-- operational figures (registers, receipts, outstanding by invoice) are labelled as such by the screens.
create or replace function public.purchase_invoice_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := coalesce(private.accounting_date(f, 'from', 'From'), date '2000-01-01');
  v_to      date := coalesce(private.accounting_date(f, 'to', 'To'), private.company_today(v_company));
  v_asof    date := coalesce(private.accounting_date(f, 'as_of', 'As of'), private.company_today(v_company));
  v_sup     uuid := private.accounting_uuid(f, 'supplier_id', 'Supplier');
  v_rep     text := upper(coalesce(p_report, ''));
begin
  if v_rep = 'PURCHASE_REGISTER' or v_rep = 'SUPPLIER_INVOICE_REGISTER' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date, 'supplier', coalesce(s.display_name, s.legal_name), 'supplier_gstin', i.supplier_gstin,
        'invoice_type', i.invoice_type, 'status', i.status, 'reverse_charge', i.reverse_charge, 'taxable_value', i.taxable_value, 'cgst', i.cgst_total, 'sgst', i.sgst_total,
        'igst', i.igst_total, 'cess', i.cess_total, 'grand_total', i.grand_total, 'gst_status', i.gst_status,
        'voucher_number', (select voucher_number from public.accounting_vouchers where id = i.voucher_id)) order by i.recorded_date, i.invoice_number)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.recorded_date between v_from and v_to and (v_sup is null or i.supplier_id = v_sup)
        and (v_rep = 'SUPPLIER_INVOICE_REGISTER' or i.status in ('POSTED', 'REVERSED'))), '[]'::jsonb));
  elsif v_rep in ('OUTSTANDING', 'AGEING') then
    return (with o as (
      select i.id, i.invoice_number, i.supplier_invoice_number, i.supplier_invoice_date, i.due_date, i.grand_total, i.supplier_id, coalesce(s.display_name, s.legal_name) as supplier,
             i.party_id, private.pi_outstanding(i.id) as outstanding, greatest(v_asof - coalesce(i.due_date, i.supplier_invoice_date), 0) as overdue_days,
             v_asof <= coalesce(i.due_date, i.supplier_invoice_date) as not_due
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.recorded_date <= v_asof and (v_sup is null or i.supplier_id = v_sup)
    )
    select jsonb_build_object('report', v_rep, 'as_of', v_asof,
      'rows', case when v_rep = 'OUTSTANDING' then coalesce((select jsonb_agg(jsonb_build_object('invoice_id', o.id, 'invoice_number', o.invoice_number,
          'supplier_invoice_number', o.supplier_invoice_number, 'supplier_invoice_date', o.supplier_invoice_date, 'due_date', o.due_date, 'supplier', o.supplier,
          'grand_total', o.grand_total, 'paid', o.grand_total - o.outstanding, 'outstanding', o.outstanding, 'overdue_days', o.overdue_days,
          'payment_status', case when o.outstanding = 0 then 'PAID' when o.outstanding < o.grand_total then 'PARTLY_PAID' else 'UNPAID' end) order by o.due_date)
        from o where o.outstanding > 0), '[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('supplier_id', ag.supplier_id, 'supplier', ag.supplier, 'not_due', ag.nd, 'd1_30', ag.b1, 'd31_60', ag.b2, 'd61_90', ag.b3,
          'd90_plus', ag.b4, 'total', ag.nd + ag.b1 + ag.b2 + ag.b3 + ag.b4,
          -- Accounting figure: the supplier's Creditors balance in the ledger (includes receipts not yet invoiced, payments on account and openings).
          'ledger_creditors', coalesce((select sum(l.credit - l.debit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
             join public.accounts a on a.id = l.account_id where l.party_id = ag.party_id and a.account_nature = 'PAYABLE_CONTROL' and v.status in ('POSTED', 'REVERSED')
             and v.voucher_date <= v_asof), 0)) order by ag.supplier)
        from (select supplier_id, supplier, party_id,
                     coalesce(sum(outstanding) filter (where not_due), 0) as nd,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days <= 30), 0) as b1,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 31 and 60), 0) as b2,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 61 and 90), 0) as b3,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days > 90), 0) as b4
              from o where outstanding > 0 group by supplier_id, supplier, party_id) ag), '[]'::jsonb) end));
  elsif v_rep = 'GRN_RECONCILIATION' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('receipt_number', g.receipt_number, 'receipt_date', g.receipt_date,
        'supplier', coalesce(s.display_name, s.legal_name), 'description', v.description, 'accepted_quantity', l.accepted_quantity, 'receipt_payable', v.payable,
        'invoiced_quantity', coalesce(pi.qty, 0), 'receipt_share_invoiced', coalesce(pi.share, 0), 'invoiced_amount', coalesce(pi.amount, 0),
        'difference_posted', coalesce(pi.amount, 0) - coalesce(pi.share, 0), 'uninvoiced_quantity', l.accepted_quantity - coalesce(pi.qty, 0),
        'uninvoiced_payable', v.payable - coalesce(pi.share, 0),
        'state', case when coalesce(pi.qty, 0) = 0 then 'NOT_INVOICED' when pi.qty < l.accepted_quantity then 'PARTLY_INVOICED' else 'FULLY_INVOICED' end,
        'invoices', pi.numbers) order by g.receipt_date, g.receipt_number)
      from public.goods_receipt_lines l join public.goods_receipts g on g.id = l.goods_receipt_id join public.suppliers s on s.id = g.supplier_id
      cross join lateral (select * from private.pi_grn_line(l.id)) v
      left join lateral (select sum(il.quantity) as qty, sum(il.matched_payable) as share, sum(il.taxable_value + il.cgst + il.sgst + il.igst + il.cess) as amount,
                                string_agg(i.invoice_number, ', ') as numbers
                         from public.purchase_invoice_lines il join public.purchase_invoices i on i.id = il.invoice_id
                         where il.goods_receipt_line_id = l.id and i.status = 'POSTED') pi on true
      where g.company_id = v_company and g.status = 'POSTED' and l.accepted_quantity > 0 and g.receipt_date between v_from and v_to
        and (v_sup is null or g.supplier_id = v_sup)), '[]'::jsonb));
  elsif v_rep = 'GST_PENDING' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number,
        'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'supplier', coalesce(s.display_name, s.legal_name),
        'supplier_gstin', i.supplier_gstin, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total, 'reverse_charge', i.reverse_charge,
        'days_pending', private.company_today(v_company) - i.recorded_date) order by i.recorded_date)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION'), '[]'::jsonb),
      'ledger_pending_balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
         join public.accounting_posting_rules r on r.account_id = l.account_id and r.rule_key = 'GST_INPUT_PENDING' and r.company_id = v_company
         where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to), 0));
  elsif v_rep = 'ITC_SUMMARY' then
    return jsonb_build_object('report', v_rep, 'from', v_from, 'to', v_to, 'rows', coalesce((select jsonb_agg(jsonb_build_object('rule_key', r.rule_key, 'account_code', a.account_code,
        'account_name', a.account_name, 'period_debit', coalesce(m.dr, 0), 'period_credit', coalesce(m.cr, 0), 'closing_balance', coalesce(m.closing, 0)) order by r.rule_key)
      from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id
      left join lateral (select sum(l.debit) filter (where v.voucher_date >= v_from) as dr, sum(l.credit) filter (where v.voucher_date >= v_from) as cr,
                                sum(l.debit - l.credit) as closing
                         from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                         where l.account_id = r.account_id and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to) m on true
      where r.company_id = v_company and r.rule_key in ('GST_INPUT_PENDING', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE')),
      '[]'::jsonb),
      'invoices', (select jsonb_object_agg(gst_status, n) from (select gst_status, count(*) as n from public.purchase_invoices
        where company_id = v_company and status = 'POSTED' and recorded_date between v_from and v_to group by gst_status) x));
  elsif v_rep = 'PRICE_VARIANCE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier', coalesce(s.display_name, s.legal_name), 'receipt_number', g.receipt_number, 'description', l.description, 'quantity', l.quantity,
        'receipt_unit_cost', l.grn_unit_cost, 'invoice_unit_price', l.unit_price, 'receipt_value', l.matched_net, 'invoice_value', l.taxable_value,
        'variance', l.taxable_value - l.matched_net, 'variance_percent', case when l.matched_net > 0 then round((l.taxable_value - l.matched_net) * 100 / l.matched_net, 2) end,
        'variance_status', i.variance_status) order by i.recorded_date, i.invoice_number, l.line_no)
      from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id join public.suppliers s on s.id = i.supplier_id
      join public.goods_receipts g on g.id = l.goods_receipt_id
      where i.company_id = v_company and i.status = 'POSTED' and l.line_kind = 'GRN' and i.recorded_date between v_from and v_to
        and (v_sup is null or i.supplier_id = v_sup) and l.taxable_value <> l.matched_net), '[]'::jsonb));
  elsif v_rep = 'COST_CENTRE_EXPENSE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
        'account_code', a.account_code, 'account_name', a.account_name, 'amount', t.amount) order by c.cost_centre_code, a.account_code)
      from (select x.cost_centre_id, l.account_id, sum(case when l.debit > 0 then x.amount else -x.amount end) as amount
            from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id
            join public.accounting_vouchers v on v.id = x.voucher_id join public.accounting_voucher_types t on t.id = v.voucher_type_id
            where x.company_id = v_company and t.type_code in ('PIN', 'REV') and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED')
              and v.voucher_date between v_from and v_to
            group by x.cost_centre_id, l.account_id) t
      join public.accounting_cost_centres c on c.id = t.cost_centre_id join public.accounts a on a.id = t.account_id where t.amount <> 0), '[]'::jsonb),
      'unallocated', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
        join public.accounts a on a.id = l.account_id
        where v.company_id = v_company and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED') and v.voucher_date between v_from and v_to
          and a.classification = 'EXPENSE' and not exists (select 1 from public.accounting_cost_allocations x where x.voucher_line_id = l.id)), 0));
  end if;
  raise exception 'Unknown report %.', p_report using errcode = '22023';
end;
$$;


-- -----------------------------------------------------------------------------
-- 10. Existing functions extended (each is its latest text plus marked Phase 3 lines): chart seed, posting-rule keys,
--     and the documents module (attachments of supplier invoices: entity type PURCHASE_INVOICE, read with purchase_invoices.read).
-- -----------------------------------------------------------------------------
create or replace function private.accounting_seed_chart(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  -- Groups (Indian-style hierarchy; classification inherited from the root).
  for r in
    select * from (values
      (1, 'AS', 'Assets', null, 'ASSET', 'DEBIT'),
      (2, 'AS.FA', 'Fixed Assets', 'AS', 'ASSET', 'DEBIT'),
      (3, 'AS.CA', 'Current Assets', 'AS', 'ASSET', 'DEBIT'),
      (4, 'AS.CA.CASH', 'Cash-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (5, 'AS.CA.BANK', 'Bank Accounts', 'AS.CA', 'ASSET', 'DEBIT'),
      (6, 'AS.CA.DEB', 'Sundry Debtors', 'AS.CA', 'ASSET', 'DEBIT'),
      (7, 'AS.CA.STK', 'Stock-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (8, 'AS.CA.TAX', 'Duties & Taxes Receivable', 'AS.CA', 'ASSET', 'DEBIT'),
      (9, 'AS.CA.ADV', 'Loans & Advances (Asset)', 'AS.CA', 'ASSET', 'DEBIT'),
      (10, 'LI', 'Liabilities', null, 'LIABILITY', 'CREDIT'),
      (11, 'LI.CL', 'Current Liabilities', 'LI', 'LIABILITY', 'CREDIT'),
      (12, 'LI.CL.CRD', 'Sundry Creditors', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (13, 'LI.CL.TAX', 'Duties & Taxes', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (14, 'LI.CL.PRV', 'Provisions', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (15, 'LI.LN', 'Loans (Liability)', 'LI', 'LIABILITY', 'CREDIT'),
      (16, 'EQ', 'Capital & Reserves', null, 'EQUITY', 'CREDIT'),
      (17, 'EQ.CAP', 'Capital Account', 'EQ', 'EQUITY', 'CREDIT'),
      (18, 'EQ.RES', 'Reserves & Surplus', 'EQ', 'EQUITY', 'CREDIT'),
      (19, 'IN', 'Income', null, 'INCOME', 'CREDIT'),
      (20, 'IN.SAL', 'Sales Accounts', 'IN', 'INCOME', 'CREDIT'),
      (21, 'IN.OTH', 'Other Income', 'IN', 'INCOME', 'CREDIT'),
      (22, 'EX', 'Expenses', null, 'EXPENSE', 'DEBIT'),
      (23, 'EX.PUR', 'Purchase Accounts', 'EX', 'EXPENSE', 'DEBIT'),
      (24, 'EX.DIR', 'Direct Expenses', 'EX', 'EXPENSE', 'DEBIT'),
      (25, 'EX.IND', 'Indirect Expenses', 'EX', 'EXPENSE', 'DEBIT')
    ) g (ord, code, name, parent, cls, nb) order by ord
  loop
    insert into public.account_groups (company_id, group_code, group_name, parent_group_id, classification, normal_balance, is_system, sort_order, created_by, updated_by)
    values (p_company, r.code, r.name, (select id from public.account_groups where company_id = p_company and group_code = r.parent), r.cls, r.nb, true, r.ord,
            auth.uid(), auth.uid())
    on conflict (company_id, group_code) do nothing;
  end loop;

  -- System ledgers used by automatic posting. No bank account and no payment-method mapping is created.
  for r in
    select * from (values
      ('1100', 'Cash in Hand', 'AS.CA.CASH', 'DEBIT', 'CASH', true, false, false, null),
      ('1300', 'Sundry Debtors (Control)', 'AS.CA.DEB', 'DEBIT', 'RECEIVABLE_CONTROL', false, true, true, 'DEBTORS_CONTROL'),
      ('1400', 'Inventory (Stock-in-Hand)', 'AS.CA.STK', 'DEBIT', 'INVENTORY', true, false, false, 'INVENTORY'),
      ('1510', 'GST Input Pending Verification', 'AS.CA.TAX', 'DEBIT', 'TAX', true, false, false, 'GST_INPUT_PENDING'),
      ('2100', 'Sundry Creditors (Control)', 'LI.CL.CRD', 'CREDIT', 'PAYABLE_CONTROL', false, true, true, 'CREDITORS_CONTROL'),
      ('2210', 'Output CGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_CGST'),
      ('2220', 'Output SGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_SGST'),
      ('2230', 'Output IGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_IGST'),
      ('3100', 'Capital Account', 'EQ.CAP', 'CREDIT', 'CAPITAL', true, false, false, null),
      ('4100', 'Sales', 'IN.SAL', 'CREDIT', 'GENERAL', true, false, false, 'SALES'),
      ('4110', 'Sales Returns', 'IN.SAL', 'DEBIT', 'GENERAL', true, false, false, 'SALES_RETURNS'),
      ('5100', 'Purchases', 'EX.PUR', 'DEBIT', 'GENERAL', true, false, false, 'PURCHASES'),
      ('5900', 'Round Off', 'EX.IND', 'DEBIT', 'ROUND_OFF', true, false, false, 'ROUND_OFF')
    ) a (code, name, grp, nb, nature, manual, party, control, skey)
  loop
    insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature,
      allow_manual_posting, requires_party, is_control, is_system, system_key, created_by, updated_by)
    select p_company, r.code, r.name, g.id, g.classification, r.nb, r.nature, r.manual, r.party, r.control, r.skey is not null, r.skey, auth.uid(), auth.uid()
    from public.account_groups g where g.company_id = p_company and g.group_code = r.grp
    on conflict (company_id, account_code) do nothing;
  end loop;

  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  select p_company, t.code, t.name, t.code, t.manual from (values
    ('JV', 'Journal Voucher', true), ('SAL', 'Sales', false), ('RCT', 'Receipt', false), ('PMT', 'Payment', false),
    ('CRN', 'Credit Note', false), ('DBN', 'Debit Note', false), ('PUR', 'Purchase (Goods Receipt)', false),
    ('OPN', 'Opening Balance', false), ('REV', 'Reversal', false)) t (code, name, manual)
  on conflict (company_id, type_code) do nothing;

  insert into public.accounting_posting_rules (company_id, rule_key, account_id, created_by, updated_by)
  select p_company, m.rule_key, a.id, auth.uid(), auth.uid()
  from (values ('DEBTORS', 'DEBTORS_CONTROL'), ('CREDITORS', 'CREDITORS_CONTROL'), ('SALES', 'SALES'), ('SALES_RETURNS', 'SALES_RETURNS'),
               ('OUTPUT_CGST', 'OUTPUT_CGST'), ('OUTPUT_SGST', 'OUTPUT_SGST'), ('OUTPUT_IGST', 'OUTPUT_IGST'), ('ROUND_OFF', 'ROUND_OFF'),
               ('PURCHASES', 'PURCHASES'), ('GST_INPUT_PENDING', 'GST_INPUT_PENDING')) m (rule_key, skey)
  join public.accounts a on a.company_id = p_company and a.system_key = m.skey
  on conflict (company_id, rule_key, match_value) do nothing;
  -- Phase 3: purchase-invoice ledgers, rules and the PIN voucher type.
  perform private.accounting_seed_purchase_invoices(p_company);
end;
$$;

create or replace function public.accounting_posting_rule_save(p_rule_key text, p_match_value text, p_account_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  v_key     text := upper(coalesce(p_rule_key, ''));
  v_match   text := upper(coalesce(p_match_value, ''));
  v_a       public.accounts;
  v_old     public.accounting_posting_rules;
begin
  perform private.accounting_require_setup(v_company);
  if v_key not in ('DEBTORS', 'CREDITORS', 'SALES', 'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES',
                   'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
                   -- Phase 3: supplier invoices.
                   'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE') then
    raise exception 'Unknown posting rule %.', p_rule_key using errcode = '22023';
  end if;
  if (v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')) <> (v_match <> '') then
    raise exception 'Receipt and supplier-payment rules need a payment method; the other rules do not.' using errcode = '22023';
  end if;
  select * into v_old from public.accounting_posting_rules where company_id = v_company and rule_key = v_key and match_value = v_match for update;
  if p_account_id is null then
    if v_key not in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') then
      raise exception 'Only payment-method mappings can be removed; select another account instead.' using errcode = 'P0001';
    end if;
    delete from public.accounting_posting_rules where id = v_old.id;
  else
    select * into v_a from public.accounts where id = p_account_id and company_id = v_company;
    if not found then
      raise exception 'The account does not exist in this company.' using errcode = '42501';
    end if;
    if not (v_a.is_active and v_a.is_postable) then
      raise exception 'Account % is inactive or does not accept postings.', v_a.account_code using errcode = 'P0001';
    end if;
    if v_key = 'DEBTORS' and v_a.account_nature <> 'RECEIVABLE_CONTROL' or v_key = 'CREDITORS' and v_a.account_nature <> 'PAYABLE_CONTROL' then
      raise exception 'Debtors and Creditors must map to the matching control account.' using errcode = 'P0001';
    end if;
    if v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') and v_a.account_nature not in ('CASH', 'BANK') then
      raise exception 'Payment methods must map to a cash or bank account.' using errcode = 'P0001';
    end if;
    if v_key not in ('DEBTORS', 'CREDITORS') and v_a.account_nature in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') then
      raise exception 'A control account can only be used for the Debtors / Creditors rule.' using errcode = 'P0001';
    end if;
    insert into public.accounting_posting_rules (company_id, rule_key, match_value, account_id, created_by, updated_by)
    values (v_company, v_key, v_match, v_a.id, auth.uid(), auth.uid())
    on conflict (company_id, rule_key, match_value) do update set account_id = excluded.account_id, is_active = true, updated_by = auth.uid(), updated_at = now();
  end if;
  perform private.write_audit_log(v_company, 'accounting.posting_rule.saved', 'accounting_posting_rule', v_key || ':' || v_match,
    jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'from_account', v_old.account_id, 'to_account', p_account_id));
  return jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'account_id', p_account_id);
end;
$$;

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
    union all select a.adjustment_number, 'inventory.read', '/inventory/adjustments?adj=' || a.id from public.inventory_adjustments a where p_type = 'STOCK_ADJUSTMENT' and a.id = p_id and a.company_id = p_company
    union all select i.invoice_number || ' (' || i.supplier_invoice_number || ')', 'purchase_invoices.read', '/purchases/invoices/' || i.id from public.purchase_invoices i where p_type = 'PURCHASE_INVOICE' and i.id = p_id and i.company_id = p_company
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
    when 'SUPPLIER_PO' then 'purchases.read' when 'GOODS_RECEIPT' then 'purchases.read'
    when 'STOCK_ADJUSTMENT' then 'inventory.read' when 'PURCHASE_INVOICE' then 'purchase_invoices.read' end;
$$;

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
    union all select a.id, a.adjustment_number from public.inventory_adjustments a where p_entity_type = 'STOCK_ADJUSTMENT' and a.company_id = v_company and a.adjustment_number ilike v_t
    union all select i.id, i.invoice_number || ' · ' || i.supplier_invoice_number from public.purchase_invoices i where p_entity_type = 'PURCHASE_INVOICE' and i.company_id = v_company and (i.invoice_number ilike v_t or i.supplier_invoice_number ilike v_t)
    limit 20) x), '[]'::jsonb);
end;
$$;

create or replace function private.erp_reset_document_entity_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['BATCH', 'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER',
    'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT', 'PURCHASE_INVOICE'];
$$;

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
  'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT', 'PURCHASE_INVOICE'));

-- -----------------------------------------------------------------------------
-- 11. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.purchase_invoice_save(uuid, jsonb, integer)',
    'public.purchase_invoice_get(uuid)',
    'public.purchase_invoice_submit(uuid)',
    'public.purchase_invoice_approve(uuid, text, boolean)',
    'public.purchase_invoice_return_to_draft(uuid, text)',
    'public.purchase_invoice_cancel(uuid, text)',
    'public.purchase_invoice_post(uuid)',
    'public.purchase_invoice_verify_gst(uuid, text, text, jsonb)',
    'public.purchase_invoice_reverse(uuid, text)',
    'public.purchase_invoice_allocate_payment(uuid, uuid, numeric)',
    'public.purchase_invoice_unallocate_payment(uuid, text)',
    'public.purchase_invoice_list(jsonb)',
    'public.purchase_invoice_matching_candidates(uuid, uuid, boolean)',
    'public.purchase_invoice_supplier_payments(uuid)',
    'public.purchase_invoice_settings_save(jsonb)',
    'public.purchase_invoice_report(text, jsonb)',
    'public.purchase_invoice_lookups()'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. ERP reset: the five supplier-invoice tables are resettable records (deleted before the accounting vouchers they reference).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-9, 'purchase_invoice_allocations', 'Accounting', 'Supplier invoice cost-centre splits'),
    (-8, 'purchase_invoice_lines', 'Accounting', 'Supplier invoice lines'),
    (-8, 'purchase_invoice_history', 'Accounting', 'Supplier invoice history'),
    (-8, 'supplier_payment_allocations', 'Accounting', 'Supplier payments allocated to invoices'),
    (-6, 'purchase_invoices', 'Accounting', 'Supplier (purchase) invoices'),
    (-8, 'accounting_cost_allocations', 'Accounting', 'Cost centre allocations'),
    (-4, 'accounting_budget_lines', 'Accounting', 'Cost centre budget lines'),
    (-4, 'accounting_budget_history', 'Accounting', 'Cost centre budget history'),
    (-3, 'accounting_budgets', 'Accounting', 'Cost centre budgets'),
    (-7, 'accounting_voucher_lines', 'Accounting', 'Accounting voucher lines'),
    (-7, 'accounting_opening_balance_lines', 'Accounting', 'Accounting opening balance lines'),
    (-6, 'accounting_posting_events', 'Accounting', 'Automatic accounting posting events'),
    (-6, 'accounting_opening_balance_batches', 'Accounting', 'Accounting opening balance batches'),
    (-5, 'accounting_vouchers', 'Accounting', 'Accounting vouchers'),
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (0, 'support_ticket_field_values', 'Support Centre', 'Custom ticket field values'),
    (0, 'support_ticket_products', 'Support Centre', 'Products on support tickets'),
    (0, 'support_ticket_field_layout', 'Support Centre', 'New Ticket form layout'),
    (1, 'support_ticket_field_definitions', 'Support Centre', 'Custom ticket fields'),
    (0, 'support_ticket_stage_history', 'Support Centre', 'Ticket stage history'),
    (4, 'support_pipeline_stages', 'Support Centre', 'Pipeline stages'),
    (5, 'support_pipelines', 'Support Centre', 'Support pipelines'),
    (0, 'support_customer_field_values', 'Support Centre', 'Custom customer field values'),
    (0, 'support_customer_activities', 'Support Centre', 'Customer tasks, follow-ups and appointments'),
    (-4, 'support_note_revisions', 'Support Centre', 'Note history'),
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (2, 'support_ticket_escalations', 'Support Centre', 'SLA warnings, breaches and escalations'),
    (3, 'support_ticket_rules', 'Support Centre', 'Ticket automation rules'),
    (3, 'support_business_calendar', 'Support Centre', 'Business hours'),
    (3, 'support_holidays', 'Support Centre', 'Holidays'),
    (3, 'support_sla_escalation_levels', 'Support Centre', 'SLA escalation levels'),
    (3, 'support_assignment_rules', 'Support Centre', 'Ticket assignment rules'),
    (0, 'support_whatsapp_messages', 'Support Centre', 'WhatsApp messages'),
    (0, 'support_whatsapp_statuses', 'Support Centre', 'WhatsApp delivery statuses'),
    (1, 'support_whatsapp_threads', 'Support Centre', 'WhatsApp contacts per conversation'),
    (3, 'support_whatsapp_templates', 'Support Centre', 'WhatsApp templates (from Meta)'),
    (3, 'support_whatsapp_webhook_events', 'Support Centre', 'WhatsApp webhook events'),
    (3, 'support_whatsapp_config', 'Support Centre', 'WhatsApp settings'),
    (0, 'support_email_messages', 'Support Centre', 'Email messages (Gmail)'),
    (1, 'support_email_templates', 'Support Centre', 'Email templates'),
    (3, 'support_email_config', 'Support Centre', 'Email settings'),
    (3, 'support_email_credentials', 'Support Centre', 'Email connection (encrypted)'),
    (3, 'support_oauth_states', 'Support Centre', 'Email authorisation requests'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_conversation_prefs', 'Support Centre', 'Pinned / muted / favourite conversations'),
    (0, 'support_email_thread_state', 'Support Centre', 'Email starred / snoozed / folder state'),
    (0, 'support_email_sync_queue', 'Support Centre', 'Email sync queue'),
    (1, 'support_email_sync_jobs', 'Support Centre', 'Email full re-sync jobs'),
    (0, 'support_email_sync_state', 'Support Centre', 'Email sync lock and progress'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (5, 'support_agents', 'Support Centre', 'Support agents'),
    (4, 'support_channel_accounts', 'Support Centre', 'Support channel accounts'),
    (4, 'support_customers', 'Support Centre', 'Support customers'),
    (4, 'support_sla_policies', 'Support Centre', 'Support SLA policies'),
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'bom_cost_snapshots', 'Production & BOMs', 'BOM cost calculations'),
    (0, 'bom_change_batch_lines', 'Production & BOMs', 'Bulk BOM change lines'),
    (0, 'bom_change_approvals', 'Production & BOMs', 'Bulk BOM change approvals and history'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'product_cost_history', 'Products & catalogue', 'Product cost history'),
    (0, 'product_cost_profiles', 'Products & catalogue', 'Product cost sources'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
    (1, 'bom_change_batches', 'Production & BOMs', 'Bulk BOM change batches'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
