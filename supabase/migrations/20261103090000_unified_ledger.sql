-- =============================================================================
-- ALTON ERP V2 — Stage 2: Unified Ledger / Party Master
--
-- Customers and suppliers stay in their existing tables (every sales order,
-- invoice, payment, purchase order and goods receipt keeps pointing at them).
-- A ledger party links them so one business can be a Customer, a Supplier or
-- Both, with one set of details:
--
--   public.parties          one row per business: code, roles (customer_id /
--                           supplier_id), opening balance (receivable or
--                           payable), payment-terms note, bank details, remarks
--   public.supplier_payments payments made to suppliers (the payable side had
--                           no payment record before); reversed, never deleted
--
-- Existing data is preserved: every existing customer and supplier gets its own
-- party (nothing is merged automatically; possible duplicates are listed and
-- can be linked by the user). Customers and suppliers created anywhere else
-- (old pages, imports) get a party automatically.
--
-- Balances (computed, never stored):
--   receivable = opening receivable + issued invoices + issued debit notes
--                - issued credit notes - recorded receipts
--   payable    = opening payable + goods accepted on posted goods receipts
--                (at the purchase order line value incl. GST)
--                - recorded supplier payments
--
-- Writes go through SECURITY DEFINER functions only. Customer details need
-- customers.manage, supplier details suppliers.manage; reading the ledger needs
-- ledger.read (given to every role that can read customers or suppliers).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('ledger', 'read', 'View the unified ledger: parties, outstanding balances and transaction history'),
  ('supplier_payment', 'manage', 'Record and reverse payments made to suppliers')
on conflict (code) do nothing;

-- ledger.read for every role that can already read customers or suppliers.
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, (select id from public.permissions where code = 'ledger.read')
from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
where p.code in ('customers.read', 'suppliers.read')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'supplier_payment.manage'
where r.code in ('ADMIN', 'ACCOUNTS_MANAGER', 'PURCHASE_MANAGER')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Customers: contact and address fields suppliers already have
-- -----------------------------------------------------------------------------
alter table public.customers add column if not exists contact_person text;
alter table public.customers add column if not exists phone text;
alter table public.customers add column if not exists city text;
alter table public.customers add column if not exists pin_code text;
alter table public.customers add column if not exists country text not null default 'India';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_contact_check') then
    alter table public.customers add constraint customers_contact_check check (
      (contact_person is null or length(contact_person) <= 120)
      and (phone is null or (phone ~ '^\+?[0-9][0-9 -]{5,18}[0-9]$' and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 7 and 15))
      and (city is null or length(city) <= 100)
      and (pin_code is null or pin_code ~ '^[A-Za-z0-9 -]{3,12}$')
      and length(btrim(country)) between 2 and 60);
  end if;
end;
$$;

create or replace function private.before_customer_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.customer_code := upper(btrim(new.customer_code));
  new.customer_name := btrim(regexp_replace(new.customer_name, '\s+', ' ', 'g'));
  new.contact_email := nullif(lower(btrim(coalesce(new.contact_email, ''))), '');
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  new.legal_name := nullif(btrim(regexp_replace(coalesce(new.legal_name, ''), '\s+', ' ', 'g')), '');
  new.gstin := nullif(upper(btrim(coalesce(new.gstin, ''))), '');
  new.pan := nullif(upper(btrim(coalesce(new.pan, ''))), '');
  new.billing_address := nullif(btrim(coalesce(new.billing_address, '')), '');
  new.shipping_address := nullif(btrim(coalesce(new.shipping_address, '')), '');
  new.billing_state_code := nullif(btrim(coalesce(new.billing_state_code, '')), '');
  new.shipping_state_code := nullif(btrim(coalesce(new.shipping_state_code, '')), '');
  new.contact_person := nullif(btrim(regexp_replace(coalesce(new.contact_person, ''), '\s+', ' ', 'g')), '');
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.city := nullif(btrim(regexp_replace(coalesce(new.city, ''), '\s+', ' ', 'g')), '');
  new.pin_code := nullif(upper(btrim(coalesce(new.pin_code, ''))), '');
  new.country := coalesce(nullif(btrim(regexp_replace(coalesce(new.country, ''), '\s+', ' ', 'g')), ''), 'India');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.customer_code := old.customer_code;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

revoke all on function private.before_customer_write() from public, anon, authenticated;

grant insert (contact_person, phone, city, pin_code, country) on public.customers to authenticated;
grant update (contact_person, phone, city, pin_code, country) on public.customers to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Parties
-- -----------------------------------------------------------------------------
create table if not exists public.parties (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  party_code            text not null check (party_code ~ '^PTY-[0-9]{6,}$'),
  customer_id           uuid,
  supplier_id           uuid,
  is_customer           boolean not null default false,
  is_supplier           boolean not null default false,
  opening_balance       numeric(16,2) not null default 0 check (opening_balance >= 0),
  opening_balance_type  text check (opening_balance_type is null or opening_balance_type in ('RECEIVABLE', 'PAYABLE')),
  opening_balance_date  date,
  payment_terms_note    text check (payment_terms_note is null or length(payment_terms_note) <= 200),
  bank_name             text check (bank_name is null or length(bank_name) <= 100),
  bank_account_name     text check (bank_account_name is null or length(bank_account_name) <= 120),
  bank_account_number   text check (bank_account_number is null or bank_account_number ~ '^[A-Za-z0-9]{6,34}$'),
  bank_ifsc             text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  remarks               text check (remarks is null or length(remarks) <= 2000),
  created_by            uuid,
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint parties_code_unique unique (company_id, party_code),
  constraint parties_customer_unique unique (customer_id),
  constraint parties_supplier_unique unique (supplier_id),
  constraint parties_id_company_unique unique (id, company_id),
  constraint parties_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint parties_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict,
  constraint parties_has_role check (customer_id is not null or supplier_id is not null),
  constraint parties_customer_role check (not is_customer or customer_id is not null),
  constraint parties_supplier_role check (not is_supplier or supplier_id is not null),
  constraint parties_opening_type check (opening_balance = 0 or opening_balance_type is not null)
);

comment on table public.parties is
  'Unified ledger account. Links a customer and/or supplier record of the same business; holds the opening balance, bank details and remarks. Balances are computed from invoices, receipts, goods receipts and supplier payments.';

create index if not exists parties_company_idx on public.parties (company_id);

drop trigger if exists parties_set_updated_at on public.parties;
create trigger parties_set_updated_at before update on public.parties
  for each row execute function private.set_updated_at();

alter table public.parties enable row level security;
revoke all on table public.parties from anon, authenticated;
grant all on table public.parties to service_role;
grant select on public.parties to authenticated;
drop policy if exists parties_select on public.parties;
create policy parties_select on public.parties for select to authenticated
  using (private.has_permission(company_id, 'ledger.read'));

-- Name key for duplicate detection: case, punctuation and company suffixes ignored.
create or replace function private.party_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9 ]', ' ', 'g'),
    '\m(private|pvt|limited|ltd|llp|inc|co|company|corporation|corp|the|and|m s|ms)\M', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function private.phone_key(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10), '');
$$;

revoke all on function private.party_name_key(text) from public, anon, authenticated;
revoke all on function private.phone_key(text) from public, anon, authenticated;

create or replace function private.next_party_code(p_company uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  loop
    v_code := private.next_document_number(p_company, 'PTY');
    exit when not exists (select 1 from public.parties where company_id = p_company and party_code = v_code);
  end loop;
  return v_code;
end;
$$;

revoke all on function private.next_party_code(uuid) from public, anon, authenticated;

-- Customers and suppliers created outside the ledger (old pages, imports) get
-- their own party. The ledger functions set app.ledger_sync to link them
-- themselves.
create or replace function private.party_for_new_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.ledger_sync', true), '') = 'on' then
    return null;
  end if;
  if tg_table_name = 'customers' then
    insert into public.parties (company_id, party_code, customer_id, is_customer, remarks, created_by)
    values (new.company_id, private.next_party_code(new.company_id), new.id, true, left(new.notes, 2000), auth.uid());
  else
    insert into public.parties (company_id, party_code, supplier_id, is_supplier, remarks, created_by)
    values (new.company_id, private.next_party_code(new.company_id), new.id, true, new.notes, auth.uid());
  end if;
  return null;
end;
$$;

revoke all on function private.party_for_new_role() from public, anon, authenticated;

drop trigger if exists customers_party on public.customers;
create trigger customers_party after insert on public.customers
  for each row execute function private.party_for_new_role();
drop trigger if exists suppliers_party on public.suppliers;
create trigger suppliers_party after insert on public.suppliers
  for each row execute function private.party_for_new_role();

-- Backfill: one party per existing customer and supplier (idempotent).
insert into public.parties (company_id, party_code, customer_id, is_customer, remarks, created_at)
select c.company_id, 'PTY-' || lpad((row_number() over (partition by c.company_id order by c.created_at, c.id)
         + coalesce((select max(substr(p.party_code, 5)::bigint) from public.parties p where p.company_id = c.company_id), 0))::text, 6, '0'),
       c.id, true, left(c.notes, 2000), c.created_at
from public.customers c
where not exists (select 1 from public.parties p where p.customer_id = c.id);

insert into public.parties (company_id, party_code, supplier_id, is_supplier, remarks, created_at)
select s.company_id, 'PTY-' || lpad((row_number() over (partition by s.company_id order by s.created_at, s.id)
         + coalesce((select max(substr(p.party_code, 5)::bigint) from public.parties p where p.company_id = s.company_id), 0))::text, 6, '0'),
       s.id, true, s.notes, s.created_at
from public.suppliers s
where not exists (select 1 from public.parties p where p.supplier_id = s.id);

-- Keep the PTY counter ahead of the backfilled codes.
insert into public.inventory_number_sequences (company_id, prefix, last_value)
select company_id, 'PTY', max(substr(party_code, 5)::bigint) from public.parties group by company_id
on conflict (company_id, prefix) do update set last_value = greatest(public.inventory_number_sequences.last_value, excluded.last_value);

-- -----------------------------------------------------------------------------
-- 4. Supplier payments
-- -----------------------------------------------------------------------------
create table if not exists public.supplier_payments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  payment_number  text not null check (payment_number ~ '^SPAY-[0-9]{6,}$'),
  supplier_id     uuid not null,
  payment_date    date not null,
  amount          numeric(16,2) not null check (amount > 0),
  payment_method  text not null check (payment_method in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER')),
  reference       text check (reference is null or length(reference) <= 100),
  notes           text check (notes is null or length(notes) <= 1000),
  status          text not null default 'RECORDED' check (status in ('RECORDED', 'REVERSED')),
  reversal_reason text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by     uuid,
  reversed_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint supplier_payments_number_unique unique (company_id, payment_number),
  constraint supplier_payments_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict,
  constraint supplier_payments_reversal check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null))
);

create index if not exists supplier_payments_supplier_idx on public.supplier_payments (company_id, supplier_id, payment_date);

alter table public.supplier_payments enable row level security;
revoke all on table public.supplier_payments from anon, authenticated;
grant all on table public.supplier_payments to service_role;
grant select on public.supplier_payments to authenticated;
drop policy if exists supplier_payments_select on public.supplier_payments;
create policy supplier_payments_select on public.supplier_payments for select to authenticated
  using (private.has_permission(company_id, 'ledger.read') and private.has_permission(company_id, 'suppliers.read'));

create or replace function private.guard_supplier_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same exemption as the other guards: only inside an approved force reset of this company.
  if tg_op = 'DELETE' and coalesce(current_setting('app.erp_force_purge', true), '') <> '' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then return old; end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier payments are never deleted; reverse them instead.' using errcode = '42501';
  end if;
  if old.status = 'REVERSED' or new.amount is distinct from old.amount or new.supplier_id is distinct from old.supplier_id
     or new.payment_date is distinct from old.payment_date or new.payment_number is distinct from old.payment_number then
    raise exception 'A recorded supplier payment can only be reversed.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_supplier_payment() from public, anon, authenticated;
drop trigger if exists supplier_payments_guard on public.supplier_payments;
create trigger supplier_payments_guard before update or delete on public.supplier_payments
  for each row execute function private.guard_supplier_payment();

-- -----------------------------------------------------------------------------
-- 5. Balances
-- -----------------------------------------------------------------------------
create or replace function private.customer_receivable(p_customer uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_customer is null then 0 else
    coalesce((select sum(grand_total) from public.sales_invoices where customer_id = p_customer and status = 'ISSUED'), 0)
    + coalesce((select sum(case when note_type = 'DEBIT' then total_amount else -total_amount end)
                from public.invoice_adjustment_notes where customer_id = p_customer and status = 'ISSUED'), 0)
    - coalesce((select sum(amount_received) from public.customer_payments where customer_id = p_customer and status = 'RECORDED'), 0)
  end;
$$;

-- Value of goods accepted on one goods receipt line, at its purchase order line value (incl. GST).
create or replace function private.grn_line_value(p_accepted numeric, p_ordered numeric, p_line_total numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(coalesce(p_accepted, 0) * coalesce(p_line_total, 0) / nullif(p_ordered, 0), 2);
$$;

create or replace function private.supplier_payable(p_supplier uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_supplier is null then 0 else
    coalesce((select sum(private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total))
              from public.goods_receipts r
              join public.goods_receipt_lines l on l.goods_receipt_id = r.id
              join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
              where r.supplier_id = p_supplier and r.status = 'POSTED'), 0)
    - coalesce((select sum(amount) from public.supplier_payments where supplier_id = p_supplier and status = 'RECORDED'), 0)
  end;
$$;

revoke all on function private.customer_receivable(uuid) from public, anon, authenticated;
revoke all on function private.grn_line_value(numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.supplier_payable(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Ledger list (search, filters, balances)
--   p_type:   CUSTOMER / SUPPLIER / BOTH / null (all)
--   p_status: ACTIVE / INACTIVE / null (all)
-- Customer details and receivables are shown only to users who may read
-- customers or billing; supplier details and payables only with suppliers.read.
-- -----------------------------------------------------------------------------
create or replace function public.ledger_parties(p_search text default null, p_type text default null, p_status text default null, p_party_id uuid default null)
returns table (
  party_id uuid, party_code text, party_type text, party_name text, legal_name text, status text,
  customer_id uuid, customer_code text, customer_status text, supplier_id uuid, supplier_code text, supplier_status text, supplier_category text,
  gstin text, pan text, gst_registration_type text, contact_person text, phone text, email text,
  billing_address text, shipping_address text, city text, state_code text, state_name text, shipping_state_code text, pin_code text, country text,
  credit_period_days integer, payment_terms text, payment_terms_note text,
  opening_balance numeric, opening_balance_type text, opening_balance_date date,
  bank_name text, bank_account_name text, bank_account_number text, bank_ifsc text, remarks text,
  receivable numeric, payable numeric, net_balance numeric, overdue numeric, last_activity date, created_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := private.require_permission('ledger.read');
  v_cust    boolean := private.has_permission(v_company, 'customers.read') or private.has_permission(v_company, 'invoices.read')
                       or private.has_permission(v_company, 'payments.read');
  v_sup     boolean := private.has_permission(v_company, 'suppliers.read');
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
  v_digits  text := nullif(regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g'), '');
  v_today   date := private.company_today(v_company);
begin
  return query
  with base as (
    select p.*,
      case when v_cust and p.is_customer then c.id end as c_id,
      case when v_sup and p.is_supplier then s.id end as s_id,
      c.customer_code as c_code, c.customer_name as c_name, c.legal_name as c_legal, c.status as c_status, c.gstin as c_gstin, c.pan as c_pan,
      c.gst_registration_type as c_reg, c.contact_person as c_contact, c.phone as c_phone, c.contact_email as c_email,
      c.billing_address as c_bill, c.shipping_address as c_ship, c.city as c_city, c.billing_state_code as c_state, c.shipping_state_code as c_ship_state,
      c.pin_code as c_pin, c.country as c_country, c.payment_terms_days as c_days, c.updated_at as c_updated,
      s.supplier_code as s_code, s.legal_name as s_name, s.display_name as s_display, s.status as s_status, s.category as s_category,
      s.gstin as s_gstin, s.pan as s_pan, s.contact_person as s_contact, s.phone as s_phone, s.email as s_email,
      s.billing_address as s_bill, s.shipping_address as s_ship, s.city as s_city, s.state_code as s_state, s.pin_code as s_pin, s.country as s_country,
      s.payment_terms as s_terms, s.custom_payment_days as s_custom, s.updated_at as s_updated
    from public.parties p
    left join public.customers c on c.id = p.customer_id and v_cust
    left join public.suppliers s on s.id = p.supplier_id and v_sup
    where p.company_id = v_company
      and (p_party_id is null or p.id = p_party_id)
      and ((v_cust and p.is_customer) or (v_sup and p.is_supplier))
  ), shaped as (
    select b.*,
      case when b.c_id is not null and b.s_id is not null then 'BOTH' when b.c_id is not null then 'CUSTOMER' else 'SUPPLIER' end as ptype,
      coalesce(case when b.c_id is not null then b.c_name end, b.s_display, b.s_name) as pname,
      case when coalesce(case when b.c_id is not null then b.c_status end, 'INACTIVE') = 'ACTIVE'
             or coalesce(case when b.s_id is not null then b.s_status end, 'INACTIVE') = 'ACTIVE' then 'ACTIVE' else 'INACTIVE' end as pstatus,
      case when b.c_id is not null then b.c_days
           when b.s_id is not null then case b.s_terms when 'IMMEDIATE' then 0 when 'DAYS_7' then 7 when 'DAYS_15' then 15 when 'DAYS_30' then 30
                                                       when 'DAYS_45' then 45 else b.s_custom end end as pdays
    from base b
  ), filtered as (
    select * from shaped sh
    where (p_type is null or sh.ptype = upper(p_type))
      and (p_status is null or sh.pstatus = upper(p_status))
      and (v_term is null
           or sh.pname ilike '%' || v_term || '%' or coalesce(sh.c_legal, '') ilike '%' || v_term || '%' or coalesce(sh.s_name, '') ilike '%' || v_term || '%'
           or sh.party_code ilike '%' || v_term || '%' or coalesce(sh.c_code, '') ilike '%' || v_term || '%' or coalesce(sh.s_code, '') ilike '%' || v_term || '%'
           or upper(coalesce(sh.c_gstin, sh.s_gstin, '')) like '%' || upper(v_term) || '%'
           or coalesce(sh.c_email, sh.s_email, '') ilike '%' || v_term || '%'
           or (v_digits is not null and length(v_digits) >= 4
               and regexp_replace(coalesce(sh.c_phone, '') || ' ' || coalesce(sh.s_phone, ''), '[^0-9 ]', '', 'g') like '%' || v_digits || '%'))
  )
  select f.id, f.party_code, f.ptype, f.pname,
    coalesce(case when f.c_id is not null then f.c_legal end, f.s_name),
    f.pstatus,
    f.c_id, case when f.c_id is not null then f.c_code end, case when f.c_id is not null then f.c_status end,
    f.s_id, case when f.s_id is not null then f.s_code end, case when f.s_id is not null then f.s_status end, case when f.s_id is not null then f.s_category end,
    coalesce(case when f.c_id is not null then f.c_gstin end, f.s_gstin), coalesce(case when f.c_id is not null then f.c_pan end, f.s_pan),
    case when f.c_id is not null then f.c_reg end,
    coalesce(case when f.c_id is not null then f.c_contact end, f.s_contact), coalesce(case when f.c_id is not null then f.c_phone end, f.s_phone),
    coalesce(case when f.c_id is not null then f.c_email end, f.s_email),
    coalesce(case when f.c_id is not null then f.c_bill end, f.s_bill), coalesce(case when f.c_id is not null then f.c_ship end, f.s_ship),
    coalesce(case when f.c_id is not null then f.c_city end, f.s_city),
    coalesce(case when f.c_id is not null then f.c_state end, f.s_state),
    private.gst_state_name(coalesce(case when f.c_id is not null then f.c_state end, f.s_state)),
    case when f.c_id is not null then f.c_ship_state end,
    coalesce(case when f.c_id is not null then f.c_pin end, f.s_pin), coalesce(case when f.c_id is not null then f.c_country end, f.s_country, 'India'),
    f.pdays,
    case when f.s_id is not null then f.s_terms when f.pdays is not null then 'DAYS_' || f.pdays end,
    f.payment_terms_note,
    f.opening_balance, f.opening_balance_type, f.opening_balance_date,
    f.bank_name, f.bank_account_name, f.bank_account_number, f.bank_ifsc, f.remarks,
    rcv.amount, pay.amount, rcv.amount - pay.amount,
    coalesce(od.amount, 0),
    act.last_date,
    f.created_at, greatest(f.updated_at, f.c_updated, f.s_updated)
  from filtered f
  cross join lateral (select case when f.c_id is null then 0::numeric
                                  else round(private.customer_receivable(f.c_id) + case when f.opening_balance_type = 'RECEIVABLE' then f.opening_balance else 0 end, 2) end as amount) rcv
  cross join lateral (select case when f.s_id is null then 0::numeric
                                  else round(private.supplier_payable(f.s_id) + case when f.opening_balance_type = 'PAYABLE' then f.opening_balance else 0 end, 2) end as amount) pay
  left join lateral (select sum(private.invoice_balance(i.id)) as amount from public.sales_invoices i
                     where f.c_id is not null and i.customer_id = f.c_id and i.status = 'ISSUED' and i.due_date < v_today) od on true
  left join lateral (select max(d) as last_date from (
      select max(invoice_date) as d from public.sales_invoices where f.c_id is not null and customer_id = f.c_id and status <> 'DRAFT'
      union all select max(receipt_date) from public.customer_payments where f.c_id is not null and customer_id = f.c_id
      union all select max(order_date) from public.sales_orders where f.c_id is not null and customer_id = f.c_id
      union all select max(po_date) from public.purchase_orders where f.s_id is not null and supplier_id = f.s_id
      union all select max(receipt_date) from public.goods_receipts where f.s_id is not null and supplier_id = f.s_id
      union all select max(payment_date) from public.supplier_payments where f.s_id is not null and supplier_id = f.s_id) x) act on true
  order by f.pname, f.party_code;
end;
$$;

revoke all on function public.ledger_parties(text, text, text, uuid) from public, anon;
grant execute on function public.ledger_parties(text, text, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Duplicate check (also used by the form before saving)
--   GSTIN: blocking (the same registration cannot be two parties)
--   name / PAN / mobile / email: warnings the user may confirm
-- -----------------------------------------------------------------------------
create or replace function public.party_find_duplicates(p_name text, p_gstin text default null, p_pan text default null,
  p_phone text default null, p_email text default null, p_exclude_party uuid default null)
returns table (party_id uuid, party_code text, party_name text, party_type text, matched_on text[], blocking boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := private.require_permission('ledger.read');
  v_name    text := nullif(private.party_name_key(p_name), '');
  v_gstin   text := nullif(upper(btrim(coalesce(p_gstin, ''))), '');
  v_pan     text := coalesce(nullif(upper(btrim(coalesce(p_pan, ''))), ''), case when v_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}' then substr(v_gstin, 3, 10) end);
  v_phone   text := private.phone_key(p_phone);
  v_email   text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  return query
  with roles as (
    select p.id, p.party_code, coalesce(c.customer_name, s.display_name, s.legal_name) as name,
      case when p.is_customer and p.is_supplier then 'BOTH' when p.is_customer then 'CUSTOMER' else 'SUPPLIER' end as ptype,
      array_remove(array[c.customer_name, c.legal_name, s.legal_name, s.display_name], null) as names,
      array_remove(array[c.gstin, s.gstin], null) as gstins,
      array_remove(array[c.pan, s.pan, substr(c.gstin, 3, 10), substr(s.gstin, 3, 10)], null) as pans,
      array_remove(array[private.phone_key(c.phone), private.phone_key(s.phone), private.phone_key(s.alternate_phone)], null) as phones,
      array_remove(array[c.contact_email, s.email], null) as emails
    from public.parties p
    left join public.customers c on c.id = p.customer_id
    left join public.suppliers s on s.id = p.supplier_id
    where p.company_id = v_company and (p_exclude_party is null or p.id <> p_exclude_party)
  ), matched as (
    select r.*, array_remove(array[
        case when v_gstin is not null and v_gstin = any (r.gstins) then 'GSTIN' end,
        case when v_name is not null and exists (select 1 from unnest(r.names) n where private.party_name_key(n) = v_name) then 'name' end,
        case when v_pan is not null and v_pan = any (r.pans) then 'PAN' end,
        case when v_phone is not null and v_phone = any (r.phones) then 'mobile' end,
        case when v_email is not null and v_email = any (r.emails) then 'email' end], null) as hits
    from roles r
  )
  select m.id, m.party_code, m.name, m.ptype, m.hits, 'GSTIN' = any (m.hits)
  from matched m where cardinality(m.hits) > 0
  order by ('GSTIN' = any (m.hits)) desc, cardinality(m.hits) desc, m.name
  limit 20;
end;
$$;

revoke all on function public.party_find_duplicates(text, text, text, text, text, uuid) from public, anon;
grant execute on function public.party_find_duplicates(text, text, text, text, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Save a party (create or update; adds or removes the customer / supplier role)
--
-- p_party: {party_type CUSTOMER|SUPPLIER|BOTH, party_name, legal_name?, gstin?, pan?,
--   gst_registration_type?, contact_person?, phone?, email?, billing_address?,
--   shipping_address?, city?, state_code?, shipping_state_code?, pin_code?, country?,
--   credit_period_days?, payment_terms_note?, supplier_category?, customer_code?,
--   supplier_code?, opening_balance?, opening_balance_type?, opening_balance_date?,
--   bank_name?, bank_account_name?, bank_account_number?, bank_ifsc?, remarks?, status?}
--
-- Duplicates: a GSTIN already used by another party is refused. Other matches
-- (name, PAN, mobile, email) return {ok:false, duplicates} without saving unless
-- p_confirm_duplicates is true. A role that is removed is deactivated, never
-- deleted, so its history stays; adding it back reactivates it.
-- -----------------------------------------------------------------------------
create or replace function public.party_save(
  p_party_id           uuid,
  p_party              jsonb,
  p_confirm_duplicates boolean default false,
  p_idempotency_key    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.current_company_id();
  v_uid      uuid := auth.uid();
  v_previous jsonb;
  v_party    public.parties;
  v_cust     public.customers;
  v_sup      public.suppliers;
  v_type     text := upper(btrim(coalesce(p_party ->> 'party_type', '')));
  v_want_c   boolean;
  v_want_s   boolean;
  v_name     text := btrim(regexp_replace(coalesce(p_party ->> 'party_name', ''), '\s+', ' ', 'g'));
  v_legal    text := nullif(btrim(coalesce(p_party ->> 'legal_name', '')), '');
  v_gstin    text := nullif(upper(btrim(coalesce(p_party ->> 'gstin', ''))), '');
  v_pan      text := nullif(upper(btrim(coalesce(p_party ->> 'pan', ''))), '');
  v_phone    text := nullif(btrim(coalesce(p_party ->> 'phone', '')), '');
  v_email    text := nullif(lower(btrim(coalesce(p_party ->> 'email', ''))), '');
  v_state    text := nullif(btrim(coalesce(p_party ->> 'state_code', '')), '');
  v_ship_st  text := nullif(btrim(coalesce(p_party ->> 'shipping_state_code', '')), '');
  v_country  text := coalesce(nullif(btrim(coalesce(p_party ->> 'country', '')), ''), 'India');
  v_days     integer;
  v_terms    text;
  v_custom   integer;
  v_opening  numeric := 0;
  v_otype    text := nullif(upper(btrim(coalesce(p_party ->> 'opening_balance_type', ''))), '');
  v_odate    date;
  v_status   text := upper(coalesce(nullif(btrim(coalesce(p_party ->> 'status', '')), ''), 'ACTIVE'));
  v_reg      text := nullif(upper(btrim(coalesce(p_party ->> 'gst_registration_type', ''))), '');
  v_dups     jsonb;
  v_code     text;
  v_cat      text := nullif(upper(btrim(coalesce(p_party ->> 'supplier_category', ''))), '');
  v_created  boolean := p_party_id is null;
begin
  if v_company is null then
    raise exception 'Your account is not active in a company.' using errcode = '42501';
  end if;
  if not private.has_permission(v_company, 'ledger.read') then
    raise exception 'You are not allowed to change ledger parties (requires ledger.read).' using errcode = '42501';
  end if;

  -- ---- Validate ------------------------------------------------------------
  if v_type not in ('CUSTOMER', 'SUPPLIER', 'BOTH') then
    raise exception 'Choose whether the party is a Customer, a Supplier or Both.' using errcode = 'P0001';
  end if;
  v_want_c := v_type in ('CUSTOMER', 'BOTH');
  v_want_s := v_type in ('SUPPLIER', 'BOTH');
  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'Enter the party name (up to 200 characters).' using errcode = 'P0001';
  end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'GSTIN % is not valid (15 characters: state code, PAN, entity number, Z, check character).', v_gstin using errcode = 'P0001';
  end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'PAN % is not valid (5 letters, 4 digits, 1 letter).', v_pan using errcode = 'P0001';
  end if;
  if v_gstin is not null and v_pan is not null and substr(v_gstin, 3, 10) <> v_pan then
    raise exception 'The PAN does not match the GSTIN (characters 3 to 12 of a GSTIN are the PAN).' using errcode = 'P0001';
  end if;
  if v_gstin is not null and v_pan is null then
    v_pan := substr(v_gstin, 3, 10);
  end if;
  if v_gstin is not null and v_state is null then
    v_state := left(v_gstin, 2);
  end if;
  if v_state is not null and private.gst_state_name(v_state) is null then
    raise exception 'State code % is not a GST state code.', v_state using errcode = 'P0001';
  end if;
  if v_phone is not null and not (v_phone ~ '^\+?[0-9][0-9 -]{5,18}[0-9]$' and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) between 7 and 15) then
    raise exception 'Mobile number % is not valid (7 to 15 digits; spaces, dashes and a leading + are allowed).', v_phone using errcode = 'P0001';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail address % is not valid.', v_email using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_party ->> 'pin_code', '')), '') is not null
     and ((v_country = 'India' and btrim(p_party ->> 'pin_code') !~ '^[1-9][0-9]{5}$') or btrim(p_party ->> 'pin_code') !~ '^[A-Za-z0-9 -]{3,12}$') then
    raise exception 'PIN code % is not valid (6 digits in India, not starting with 0).', btrim(p_party ->> 'pin_code') using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_party ->> 'bank_ifsc', '')), '') is not null and upper(btrim(p_party ->> 'bank_ifsc')) !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    raise exception 'IFSC % is not valid (4 letters, 0, then 6 letters or digits).', btrim(p_party ->> 'bank_ifsc') using errcode = 'P0001';
  end if;
  if nullif(regexp_replace(coalesce(p_party ->> 'bank_account_number', ''), '\s', '', 'g'), '') is not null
     and regexp_replace(p_party ->> 'bank_account_number', '\s', '', 'g') !~ '^[A-Za-z0-9]{6,34}$' then
    raise exception 'Bank account number must be 6 to 34 letters or digits.' using errcode = 'P0001';
  end if;
  begin
    v_days := nullif(btrim(coalesce(p_party ->> 'credit_period_days', '')), '')::integer;
    v_opening := coalesce(nullif(btrim(coalesce(p_party ->> 'opening_balance', '')), '')::numeric, 0);
    v_odate := nullif(btrim(coalesce(p_party ->> 'opening_balance_date', '')), '')::date;
  exception when others then
    raise exception 'Credit period, opening balance and opening balance date must be valid numbers / dates.' using errcode = 'P0001';
  end;
  if v_days is not null and (v_days < 0 or v_days > 365) then
    raise exception 'Credit period must be between 0 and 365 days.' using errcode = 'P0001';
  end if;
  if v_opening < 0 or v_opening <> round(v_opening, 2) then
    raise exception 'Opening balance must be zero or more, with up to 2 decimals.' using errcode = 'P0001';
  end if;
  if v_opening > 0 and v_otype is null then
    v_otype := case when v_want_c and not v_want_s then 'RECEIVABLE' when v_want_s and not v_want_c then 'PAYABLE' end;
    if v_otype is null then
      raise exception 'Choose whether the opening balance is receivable (they owe you) or payable (you owe them).' using errcode = 'P0001';
    end if;
  end if;
  if v_otype is not null and v_otype not in ('RECEIVABLE', 'PAYABLE') then
    raise exception 'Opening balance type must be Receivable or Payable.' using errcode = 'P0001';
  end if;
  if v_opening = 0 then
    v_otype := null;
  end if;
  if v_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'Status must be Active or Inactive.' using errcode = 'P0001';
  end if;
  if v_reg is not null and v_reg not in ('REGISTERED', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'SEZ', 'OVERSEAS') then
    raise exception 'Unknown GST registration type %.', v_reg using errcode = 'P0001';
  end if;
  if v_cat is not null and v_cat not in ('RAW_MATERIAL', 'FINISHED_GOODS', 'PACKAGING', 'MACHINERY', 'SERVICES', 'OTHER') then
    raise exception 'Unknown supplier category %.', v_cat using errcode = 'P0001';
  end if;

  -- Supplier payment terms follow the credit period.
  v_terms := case when v_days is null then null when v_days = 0 then 'IMMEDIATE' when v_days in (7, 15, 30, 45) then 'DAYS_' || v_days else 'CUSTOM' end;
  v_custom := case when v_terms = 'CUSTOM' then v_days end;

  -- ---- Load and check permissions --------------------------------------------
  if p_party_id is null then
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'party_create');
    if v_previous is not null then return v_previous; end if;
  else
    select * into v_party from public.parties where id = p_party_id and company_id = v_company for update;
    if not found then
      raise exception 'Party not found in your company.' using errcode = 'P0001';
    end if;
    if v_party.customer_id is not null then select * into v_cust from public.customers where id = v_party.customer_id for update; end if;
    if v_party.supplier_id is not null then select * into v_sup from public.suppliers where id = v_party.supplier_id for update; end if;
  end if;
  if (v_want_c or coalesce(v_party.is_customer, false)) and not private.has_permission(v_company, 'customers.manage') then
    raise exception 'You are not allowed to change customers (requires customers.manage).' using errcode = '42501';
  end if;
  if (v_want_s or coalesce(v_party.is_supplier, false)) and not private.has_permission(v_company, 'suppliers.manage') then
    raise exception 'You are not allowed to change suppliers (requires suppliers.manage).' using errcode = '42501';
  end if;

  -- ---- Duplicates -------------------------------------------------------------
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_dups
  from public.party_find_duplicates(v_name, v_gstin, v_pan, v_phone, v_email, p_party_id) d;
  if exists (select 1 from jsonb_array_elements(v_dups) d where (d ->> 'blocking')::boolean) then
    raise exception 'GSTIN % is already used by party % (%). Open that party and add the % role instead of creating a duplicate.',
      v_gstin, (select d ->> 'party_code' from jsonb_array_elements(v_dups) d where (d ->> 'blocking')::boolean limit 1),
      (select d ->> 'party_name' from jsonb_array_elements(v_dups) d where (d ->> 'blocking')::boolean limit 1),
      case when v_want_c and v_want_s then 'customer / supplier' when v_want_c then 'customer' else 'supplier' end
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_dups) > 0 and not p_confirm_duplicates then
    return jsonb_build_object('ok', false, 'duplicates', v_dups);
  end if;

  -- ---- Write ------------------------------------------------------------------
  perform set_config('app.ledger_sync', 'on', true);

  if v_want_c then
    if v_cust.id is null then
      v_code := nullif(upper(btrim(coalesce(p_party ->> 'customer_code', ''))), '');
      if v_code is null then
        loop
          v_code := private.next_document_number(v_company, 'CUS');
          exit when not exists (select 1 from public.customers where company_id = v_company and customer_code = v_code);
        end loop;
      elsif exists (select 1 from public.customers where company_id = v_company and customer_code = v_code) then
        raise exception 'Customer code % is already used.', v_code using errcode = 'P0001';
      end if;
      insert into public.customers (company_id, customer_code, customer_name, legal_name, contact_email, notes, gstin, pan, gst_registration_type,
        billing_address, billing_state_code, shipping_address, shipping_state_code, payment_terms_days, contact_person, phone, city, pin_code, country, status)
      values (v_company, v_code, v_name, v_legal, v_email, left(nullif(btrim(coalesce(p_party ->> 'remarks', '')), ''), 1000), v_gstin, v_pan,
        coalesce(v_reg, case when v_gstin is not null then 'REGISTERED' when v_country <> 'India' then 'OVERSEAS' else 'UNREGISTERED' end),
        nullif(btrim(coalesce(p_party ->> 'billing_address', '')), ''), v_state, nullif(btrim(coalesce(p_party ->> 'shipping_address', '')), ''),
        coalesce(v_ship_st, v_state), v_days, p_party ->> 'contact_person', v_phone, p_party ->> 'city', p_party ->> 'pin_code', v_country, v_status)
      returning * into v_cust;
    else
      update public.customers set customer_name = v_name, legal_name = v_legal, contact_email = v_email,
        notes = left(nullif(btrim(coalesce(p_party ->> 'remarks', '')), ''), 1000), gstin = v_gstin, pan = v_pan,
        gst_registration_type = coalesce(v_reg,
          case when v_gstin is null and gst_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') then 'UNREGISTERED'
               when v_gstin is not null and coalesce(gst_registration_type, 'UNREGISTERED') in ('UNREGISTERED', 'CONSUMER') then 'REGISTERED'
               else gst_registration_type end),
        billing_address = nullif(btrim(coalesce(p_party ->> 'billing_address', '')), ''), billing_state_code = v_state,
        shipping_address = nullif(btrim(coalesce(p_party ->> 'shipping_address', '')), ''), shipping_state_code = coalesce(v_ship_st, v_state),
        payment_terms_days = v_days, contact_person = p_party ->> 'contact_person', phone = v_phone, city = p_party ->> 'city',
        pin_code = p_party ->> 'pin_code', country = v_country, status = v_status
      where id = v_cust.id
      returning * into v_cust;
    end if;
  elsif v_cust.id is not null and v_cust.status = 'ACTIVE' then
    -- Customer role removed: deactivate (history is kept).
    update public.customers set status = 'INACTIVE' where id = v_cust.id;
  end if;

  if v_want_s then
    if v_sup.id is null then
      v_code := nullif(upper(btrim(coalesce(p_party ->> 'supplier_code', ''))), '');
      if v_code is not null and exists (select 1 from public.suppliers where company_id = v_company and supplier_code = v_code) then
        raise exception 'Supplier code % is already used.', v_code using errcode = 'P0001';
      end if;
      insert into public.suppliers (company_id, supplier_code, legal_name, display_name, category, contact_person, phone, email, gstin, pan, billing_address,
        shipping_address, city, state_code, pin_code, country, payment_terms, custom_payment_days, notes, status)
      values (v_company, v_code, coalesce(v_legal, v_name), case when v_legal is not null and v_legal <> v_name then v_name end,
        coalesce(v_cat, 'OTHER'), p_party ->> 'contact_person', v_phone, v_email, v_gstin, v_pan,
        p_party ->> 'billing_address', p_party ->> 'shipping_address', p_party ->> 'city', v_state, p_party ->> 'pin_code', v_country,
        coalesce(v_terms, 'DAYS_30'), v_custom, p_party ->> 'remarks', v_status)
      returning * into v_sup;
    else
      update public.suppliers set legal_name = coalesce(v_legal, v_name), display_name = case when v_legal is not null and v_legal <> v_name then v_name end,
        category = coalesce(v_cat, category), contact_person = p_party ->> 'contact_person', phone = v_phone, email = v_email,
        gstin = v_gstin, pan = v_pan, billing_address = p_party ->> 'billing_address', shipping_address = p_party ->> 'shipping_address',
        city = p_party ->> 'city', state_code = v_state, pin_code = p_party ->> 'pin_code', country = v_country,
        payment_terms = coalesce(v_terms, payment_terms), custom_payment_days = case when v_terms is null then custom_payment_days else v_custom end,
        notes = p_party ->> 'remarks', status = v_status
      where id = v_sup.id
      returning * into v_sup;
    end if;
  elsif v_sup.id is not null and v_sup.status = 'ACTIVE' then
    update public.suppliers set status = 'INACTIVE' where id = v_sup.id;
  end if;

  if v_party.id is null then
    insert into public.parties (company_id, party_code, customer_id, supplier_id, is_customer, is_supplier, opening_balance, opening_balance_type,
      opening_balance_date, payment_terms_note, bank_name, bank_account_name, bank_account_number, bank_ifsc, remarks, created_by, updated_by)
    values (v_company, private.next_party_code(v_company), v_cust.id, v_sup.id, v_want_c, v_want_s, v_opening, v_otype,
      case when v_opening > 0 then coalesce(v_odate, private.company_today(v_company)) end,
      nullif(btrim(coalesce(p_party ->> 'payment_terms_note', '')), ''), nullif(btrim(coalesce(p_party ->> 'bank_name', '')), ''),
      nullif(btrim(coalesce(p_party ->> 'bank_account_name', '')), ''), nullif(upper(regexp_replace(coalesce(p_party ->> 'bank_account_number', ''), '\s', '', 'g')), ''),
      nullif(upper(btrim(coalesce(p_party ->> 'bank_ifsc', ''))), ''), nullif(btrim(coalesce(p_party ->> 'remarks', '')), ''), v_uid, v_uid)
    returning * into v_party;
  else
    update public.parties set customer_id = coalesce(v_cust.id, customer_id), supplier_id = coalesce(v_sup.id, supplier_id),
      is_customer = v_want_c, is_supplier = v_want_s, opening_balance = v_opening, opening_balance_type = v_otype,
      opening_balance_date = case when v_opening > 0 then coalesce(v_odate, opening_balance_date, private.company_today(v_company)) end,
      payment_terms_note = nullif(btrim(coalesce(p_party ->> 'payment_terms_note', '')), ''), bank_name = nullif(btrim(coalesce(p_party ->> 'bank_name', '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_party ->> 'bank_account_name', '')), ''),
      bank_account_number = nullif(upper(regexp_replace(coalesce(p_party ->> 'bank_account_number', ''), '\s', '', 'g')), ''),
      bank_ifsc = nullif(upper(btrim(coalesce(p_party ->> 'bank_ifsc', ''))), ''), remarks = nullif(btrim(coalesce(p_party ->> 'remarks', '')), ''),
      updated_by = v_uid
    where id = v_party.id
    returning * into v_party;
  end if;

  perform private.write_audit_log(v_company, case when v_created then 'party.created' else 'party.updated' end, 'party', v_party.id::text,
    jsonb_build_object('party_code', v_party.party_code, 'party_type', v_type, 'name', v_name,
      'customer_code', v_cust.customer_code, 'supplier_code', v_sup.supplier_code, 'confirmed_duplicates', jsonb_array_length(v_dups) > 0));

  v_previous := jsonb_build_object('ok', true, 'party_id', v_party.id, 'party_code', v_party.party_code, 'party_type', v_type,
    'customer_id', case when v_want_c then v_cust.id end, 'customer_code', case when v_want_c then v_cust.customer_code end,
    'supplier_id', case when v_want_s then v_sup.id end, 'supplier_code', case when v_want_s then v_sup.supplier_code end);
  if v_created then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

revoke all on function public.party_save(uuid, jsonb, boolean, uuid) from public, anon;
grant execute on function public.party_save(uuid, jsonb, boolean, uuid) to authenticated;

-- Activate / deactivate every role of a party (history is kept).
create or replace function public.party_set_status(p_party_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('ledger.read');
  v_party   public.parties;
  v_status  text := upper(coalesce(p_status, ''));
begin
  if v_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'Status must be Active or Inactive.' using errcode = 'P0001';
  end if;
  select * into v_party from public.parties where id = p_party_id and company_id = v_company for update;
  if not found then
    raise exception 'Party not found in your company.' using errcode = 'P0001';
  end if;
  if v_party.is_customer then
    perform private.require_permission('customers.manage');
    update public.customers set status = v_status where id = v_party.customer_id;
  end if;
  if v_party.is_supplier then
    perform private.require_permission('suppliers.manage');
    update public.suppliers set status = v_status where id = v_party.supplier_id;
  end if;
  perform private.write_audit_log(v_company, case when v_status = 'ACTIVE' then 'party.activated' else 'party.deactivated' end,
    'party', v_party.id::text, jsonb_build_object('party_code', v_party.party_code));
  return jsonb_build_object('party_id', v_party.id, 'status', v_status);
end;
$$;

revoke all on function public.party_set_status(uuid, text) from public, anon;
grant execute on function public.party_set_status(uuid, text) to authenticated;

-- Link a customer-only party and a supplier-only party of the same business
-- into one party with both roles. No customer, supplier or document changes;
-- the emptied party record is removed (it held no documents).
create or replace function public.party_link(p_party_id uuid, p_other_party_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('ledger.read');
  v_a       public.parties;
  v_b       public.parties;
  v_keep    public.parties;
  v_drop    public.parties;
begin
  perform private.require_permission('customers.manage');
  perform private.require_permission('suppliers.manage');
  select * into v_a from public.parties where id = p_party_id and company_id = v_company for update;
  select * into v_b from public.parties where id = p_other_party_id and company_id = v_company for update;
  if v_a.id is null or v_b.id is null or v_a.id = v_b.id then
    raise exception 'Choose two different parties of your company.' using errcode = 'P0001';
  end if;
  if (v_a.customer_id is not null and v_b.customer_id is not null) or (v_a.supplier_id is not null and v_b.supplier_id is not null) then
    raise exception 'Only a customer and a supplier can be linked (both parties already have the same role).' using errcode = 'P0001';
  end if;
  if v_a.opening_balance > 0 and v_b.opening_balance > 0 then
    raise exception 'Both parties have an opening balance. Set one of them to zero (or combine them on one party) before linking.' using errcode = 'P0001';
  end if;
  v_keep := v_a;
  v_drop := v_b;
  delete from public.parties where id = v_drop.id;
  update public.parties set
    customer_id = coalesce(v_keep.customer_id, v_drop.customer_id), supplier_id = coalesce(v_keep.supplier_id, v_drop.supplier_id),
    is_customer = v_keep.is_customer or v_drop.is_customer, is_supplier = v_keep.is_supplier or v_drop.is_supplier,
    opening_balance = greatest(v_keep.opening_balance, v_drop.opening_balance),
    opening_balance_type = coalesce(case when v_keep.opening_balance > 0 then v_keep.opening_balance_type end, case when v_drop.opening_balance > 0 then v_drop.opening_balance_type end),
    opening_balance_date = coalesce(case when v_keep.opening_balance > 0 then v_keep.opening_balance_date end, case when v_drop.opening_balance > 0 then v_drop.opening_balance_date end),
    payment_terms_note = coalesce(v_keep.payment_terms_note, v_drop.payment_terms_note), bank_name = coalesce(v_keep.bank_name, v_drop.bank_name),
    bank_account_name = coalesce(v_keep.bank_account_name, v_drop.bank_account_name),
    bank_account_number = coalesce(v_keep.bank_account_number, v_drop.bank_account_number), bank_ifsc = coalesce(v_keep.bank_ifsc, v_drop.bank_ifsc),
    remarks = nullif(concat_ws(E'\n', v_keep.remarks, v_drop.remarks), ''), updated_by = auth.uid()
  where id = v_keep.id
  returning * into v_keep;
  perform private.write_audit_log(v_company, 'party.linked', 'party', v_keep.id::text,
    jsonb_build_object('party_code', v_keep.party_code, 'merged_party_code', v_drop.party_code,
      'customer_id', v_keep.customer_id, 'supplier_id', v_keep.supplier_id));
  return jsonb_build_object('party_id', v_keep.id, 'party_code', v_keep.party_code, 'removed_party_code', v_drop.party_code);
end;
$$;

revoke all on function public.party_link(uuid, uuid) from public, anon;
grant execute on function public.party_link(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Transaction history with running receivable and payable balances
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
      'Goods received' || coalesce(' · supplier doc ' || r.supplier_document_number, ''), r.status, x.value, 0, x.value
    from public.goods_receipts r
    cross join lateral (select coalesce(sum(private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total)), 0) as value
                        from public.goods_receipt_lines l join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
                        where l.goods_receipt_id = r.id) x
    where v_s is not null and r.supplier_id = v_s
    union all
    select (r.reversed_at at time zone v_tz)::date, r.reversed_at, 'GOODS_RECEIPT_REVERSED', r.receipt_number, r.id,
      'Goods receipt reversed: ' || coalesce(r.reversal_reason, ''), r.status, x.value, 0, -x.value
    from public.goods_receipts r
    cross join lateral (select coalesce(sum(private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total)), 0) as value
                        from public.goods_receipt_lines l join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
                        where l.goods_receipt_id = r.id) x
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

-- -----------------------------------------------------------------------------
-- 10. Supplier payments: record and reverse
-- -----------------------------------------------------------------------------
create or replace function public.supplier_payment_record(
  p_supplier_id     uuid,
  p_payment_date    date,
  p_amount          numeric,
  p_payment_method  text,
  p_reference       text default null,
  p_notes           text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('supplier_payment.manage');
  v_previous jsonb;
  v_sup      public.suppliers;
  v_number   text;
  v_id       uuid;
  v_payable  numeric;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'supplier_payment');
  if v_previous is not null then return v_previous; end if;
  select * into v_sup from public.suppliers where id = p_supplier_id and company_id = v_company;
  if not found then
    raise exception 'Supplier not found in your company.' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter an amount greater than zero, with up to 2 decimals.' using errcode = 'P0001';
  end if;
  if p_payment_date is null or p_payment_date > private.company_today(v_company) then
    raise exception 'Enter the payment date (not in the future).' using errcode = 'P0001';
  end if;
  if upper(coalesce(p_payment_method, '')) not in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER') then
    raise exception 'Choose the payment method.' using errcode = 'P0001';
  end if;
  loop
    v_number := private.next_document_number(v_company, 'SPAY');
    exit when not exists (select 1 from public.supplier_payments where company_id = v_company and payment_number = v_number);
  end loop;
  insert into public.supplier_payments (company_id, payment_number, supplier_id, payment_date, amount, payment_method, reference, notes, created_by)
  values (v_company, v_number, v_sup.id, p_payment_date, p_amount, upper(p_payment_method), nullif(btrim(coalesce(p_reference, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  v_payable := private.supplier_payable(v_sup.id)
    + coalesce((select opening_balance from public.parties where supplier_id = v_sup.id and opening_balance_type = 'PAYABLE'), 0);
  perform private.write_audit_log(v_company, 'supplier_payment.recorded', 'supplier_payment', v_id::text,
    jsonb_build_object('payment_number', v_number, 'supplier_code', v_sup.supplier_code, 'amount', p_amount));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('payment_id', v_id, 'payment_number', v_number,
    'payable_after', v_payable, 'overpaid', v_payable < 0));
end;
$$;

create or replace function public.supplier_payment_reverse(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('supplier_payment.manage');
  v_pay     public.supplier_payments;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_pay from public.supplier_payments where id = p_payment_id and company_id = v_company for update;
  if not found then
    raise exception 'Supplier payment not found in your company.' using errcode = 'P0001';
  end if;
  if v_pay.status = 'REVERSED' then
    raise exception 'Payment % is already reversed.', v_pay.payment_number using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Enter the reason for reversing the payment (at least 5 characters).' using errcode = 'P0001';
  end if;
  update public.supplier_payments set status = 'REVERSED', reversal_reason = left(v_reason, 500), reversed_by = auth.uid(), reversed_at = now()
  where id = v_pay.id;
  perform private.write_audit_log(v_company, 'supplier_payment.reversed', 'supplier_payment', v_pay.id::text,
    jsonb_build_object('payment_number', v_pay.payment_number, 'amount', v_pay.amount, 'reason', v_reason));
  return jsonb_build_object('payment_id', v_pay.id, 'status', 'REVERSED');
end;
$$;

revoke all on function public.supplier_payment_record(uuid, date, numeric, text, text, text, uuid) from public, anon;
revoke all on function public.supplier_payment_reverse(uuid, text) from public, anon;
grant execute on function public.supplier_payment_record(uuid, date, numeric, text, text, text, uuid) to authenticated;
grant execute on function public.supplier_payment_reverse(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 11. ERP reset: the new company tables are purged with customers and suppliers
-- (same list as 20261031090000 plus parties and supplier_payments).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
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
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
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

-- -----------------------------------------------------------------------------
-- 12. Self-healing: every customer and supplier has a party. Called when the
-- ledger opens (e.g. after a reset kept some suppliers, or rows created before
-- this migration in another session).
-- -----------------------------------------------------------------------------
create or replace function public.ledger_sync_parties()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('ledger.read');
  v_c int := 0;
  v_s int := 0;
  r record;
begin
  for r in select c.id, c.notes from public.customers c
           where c.company_id = v_company and not exists (select 1 from public.parties p where p.customer_id = c.id) order by c.created_at, c.id
  loop
    insert into public.parties (company_id, party_code, customer_id, is_customer, remarks) values (v_company, private.next_party_code(v_company), r.id, true, left(r.notes, 2000));
    v_c := v_c + 1;
  end loop;
  for r in select s.id, s.notes from public.suppliers s
           where s.company_id = v_company and not exists (select 1 from public.parties p where p.supplier_id = s.id) order by s.created_at, s.id
  loop
    insert into public.parties (company_id, party_code, supplier_id, is_supplier, remarks) values (v_company, private.next_party_code(v_company), r.id, true, r.notes);
    v_s := v_s + 1;
  end loop;
  return jsonb_build_object('customers_added', v_c, 'suppliers_added', v_s);
end;
$$;

revoke all on function public.ledger_sync_parties() from public, anon;
grant execute on function public.ledger_sync_parties() to authenticated;
-- Reset preview: explain the new guard like the others.
create or replace function private.erp_reset_guard_reason(p_function text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_function
    when 'prevent_ledger_mutation' then 'Posted stock movements are permanent; corrections are reversal entries.'
    when 'prevent_history_mutation' then 'Append-only history; it cannot be deleted.'
    when 'prevent_import_history_mutation' then 'Import history is append-only.'
    when 'prevent_approval_decision_mutation' then 'Approval decisions are append-only.'
    when 'guard_posted_document' then 'Posted documents can only be reversed, never deleted.'
    when 'guard_bom_write' then 'BOMs are never deleted; they are archived.'
    when 'guard_bom_item_write' then 'Components of submitted or approved BOMs cannot be removed.'
    when 'guard_invoice_change' then 'Invoices are never deleted; drafts are discarded and issued invoices cancelled.'
    when 'guard_invoice_line_change' then 'Lines of issued invoices cannot be removed.'
    when 'guard_payment_change' then 'Payments are never deleted; they are reversed.'
    when 'guard_note_change' then 'Credit and debit notes are never deleted.'
    when 'guard_supplier_payment' then 'Supplier payments are never deleted; they are reversed.'
    else format('Protected by the database guard %s.', p_function)
  end;
$$;

revoke all on function private.erp_reset_guard_reason(text) from public, anon, authenticated;