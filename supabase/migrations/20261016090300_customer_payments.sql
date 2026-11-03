-- =============================================================================
-- Phase 8: customer payment receipts and allocations
--
--   customer_payments            receipts as recorded by a user (not proof of
--                                bank settlement; no bank integration exists)
--   invoice_payment_allocations  receipt -> invoice amounts (many-to-many)
--
-- Nothing is deleted. Reversing an allocation or a receipt marks it REVERSED
-- with a reason; re-allocation creates a new allocation row.
-- Validations (server-side, under row locks): same company, same customer,
-- same currency, allocation <= unallocated receipt amount and <= invoice
-- balance. Unallocated money stays on the receipt (advance / on account).
-- =============================================================================

create table if not exists public.customer_payments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  receipt_number        text not null,
  customer_id           uuid not null,
  receipt_date          date not null,
  amount_received       numeric(16,2) not null check (amount_received > 0),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  payment_method        text not null check (payment_method in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER')),
  transaction_reference text check (transaction_reference is null or length(transaction_reference) <= 100),
  bank_reference        text check (bank_reference is null or length(bank_reference) <= 200),
  notes                 text check (notes is null or length(notes) <= 1000),
  status                text not null default 'RECORDED' check (status in ('RECORDED', 'REVERSED')),
  verification_status   text not null default 'UNVERIFIED' check (verification_status in ('UNVERIFIED')),
  reversal_reason       text check (reversal_reason is null or length(reversal_reason) <= 1000),
  reversed_by           uuid,
  reversed_at           timestamptz,
  recorded_by           uuid,
  created_at            timestamptz not null default now(),
  constraint customer_payments_number_unique unique (company_id, receipt_number),
  constraint customer_payments_id_company_unique unique (id, company_id),
  constraint customer_payments_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint customer_payments_reversal check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null))
);

comment on column public.customer_payments.verification_status is 'Receipts are recorded by users and are not bank-verified. Only UNVERIFIED exists until a verified bank reconciliation integration is configured.';

create index if not exists customer_payments_customer_idx on public.customer_payments (company_id, customer_id);
create index if not exists customer_payments_date_idx on public.customer_payments (company_id, receipt_date desc);

create table if not exists public.invoice_payment_allocations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  invoice_id       uuid not null,
  payment_id       uuid not null,
  allocated_amount numeric(16,2) not null check (allocated_amount > 0),
  allocation_date  date not null,
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVERSED')),
  reversal_reason  text check (reversal_reason is null or length(reversal_reason) <= 1000),
  reversed_by      uuid,
  reversed_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint invoice_payment_alloc_invoice_fk foreign key (invoice_id, company_id) references public.sales_invoices (id, company_id) on delete restrict,
  constraint invoice_payment_alloc_payment_fk foreign key (payment_id, company_id) references public.customer_payments (id, company_id) on delete restrict,
  constraint invoice_payment_alloc_reversal check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null))
);

create index if not exists invoice_payment_alloc_invoice_idx on public.invoice_payment_allocations (invoice_id) where status = 'ACTIVE';
create index if not exists invoice_payment_alloc_payment_idx on public.invoice_payment_allocations (payment_id);

-- Financial history is never rewritten: receipts and allocations can only move
-- from active to reversed; nothing is deleted.
create or replace function private.guard_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment records are never deleted; reverse them instead.' using errcode = 'P0001';
  end if;
  if tg_table_name = 'customer_payments' then
    if old.status <> 'RECORDED' or new.status <> 'REVERSED'
       or (to_jsonb(new) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) is distinct from (to_jsonb(old) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) then
      raise exception 'A recorded receipt cannot be edited; reverse it and record a new one.' using errcode = 'P0001';
    end if;
  else
    if old.status <> 'ACTIVE' or new.status <> 'REVERSED'
       or (to_jsonb(new) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) is distinct from (to_jsonb(old) - array['status', 'reversal_reason', 'reversed_by', 'reversed_at']) then
      raise exception 'A payment allocation cannot be edited; reverse it and allocate again.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_payment_change() from public, anon, authenticated;

drop trigger if exists customer_payments_guard on public.customer_payments;
create trigger customer_payments_guard before update or delete on public.customer_payments for each row execute function private.guard_payment_change();
drop trigger if exists invoice_payment_alloc_guard on public.invoice_payment_allocations;
create trigger invoice_payment_alloc_guard before update or delete on public.invoice_payment_allocations for each row execute function private.guard_payment_change();

do $$
declare
  t text;
begin
  foreach t in array array['customer_payments', 'invoice_payment_allocations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'payments.read', 'invoices.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Balances (derived; never stored)
-- -----------------------------------------------------------------------------
create or replace function private.invoice_paid(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(allocated_amount), 0) from public.invoice_payment_allocations where invoice_id = p_invoice and status = 'ACTIVE';
$$;

create or replace function private.payment_allocated(p_payment uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(allocated_amount), 0) from public.invoice_payment_allocations where payment_id = p_payment and status = 'ACTIVE';
$$;

-- grand total - issued credit notes + issued debit notes - active allocations
create or replace function private.invoice_balance(p_invoice uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total numeric;
  v_cn    numeric;
  v_dn    numeric;
begin
  select grand_total into v_total from public.sales_invoices where id = p_invoice and status = 'ISSUED';
  if v_total is null then
    return 0;
  end if;
  select coalesce(sum(total_amount) filter (where note_type = 'CREDIT'), 0), coalesce(sum(total_amount) filter (where note_type = 'DEBIT'), 0)
    into v_cn, v_dn
  from public.invoice_adjustment_notes where original_invoice_id = p_invoice and status = 'ISSUED';
  return v_total - v_cn + v_dn - private.invoice_paid(p_invoice);
end;
$$;

revoke all on function private.invoice_paid(uuid) from public, anon;
revoke all on function private.payment_allocated(uuid) from public, anon;
revoke all on function private.invoice_balance(uuid) from public, anon;
grant execute on function private.invoice_paid(uuid), private.payment_allocated(uuid), private.invoice_balance(uuid) to authenticated;

-- Allocates part of a (locked) receipt to an invoice after validating everything.
create or replace function private.allocate_payment(p_company uuid, p_payment public.customer_payments, p_invoice uuid, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv     public.sales_invoices;
  v_balance numeric;
  v_free    numeric;
  v_id      uuid;
begin
  select * into v_inv from public.sales_invoices where id = p_invoice and company_id = p_company for update;
  if not found then
    raise exception 'Invoice not found in your company.' using errcode = 'P0001';
  end if;
  if v_inv.status <> 'ISSUED' then
    raise exception 'Payments can only be allocated to issued invoices (% is %).', coalesce(v_inv.invoice_number, 'the draft'), lower(v_inv.status) using errcode = 'P0001';
  end if;
  if v_inv.customer_id <> p_payment.customer_id then
    raise exception 'Invoice % belongs to another customer; a receipt can only be allocated to its own customer''s invoices.', v_inv.invoice_number using errcode = 'P0001';
  end if;
  if v_inv.currency <> p_payment.currency then
    raise exception 'Invoice % is in % and the receipt in %.', v_inv.invoice_number, v_inv.currency, p_payment.currency using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Allocation amounts must be greater than zero with at most 2 decimals.' using errcode = 'P0001';
  end if;
  v_balance := private.invoice_balance(v_inv.id);
  if p_amount > v_balance then
    raise exception 'Invoice % has a balance of %; % cannot be allocated to it.', v_inv.invoice_number, v_balance, p_amount using errcode = 'P0001';
  end if;
  v_free := p_payment.amount_received - private.payment_allocated(p_payment.id);
  if p_amount > v_free then
    raise exception 'Receipt % has % unallocated; % cannot be allocated.', p_payment.receipt_number, v_free, p_amount using errcode = 'P0001';
  end if;
  insert into public.invoice_payment_allocations (company_id, invoice_id, payment_id, allocated_amount, allocation_date, created_by)
  values (p_company, v_inv.id, p_payment.id, p_amount, greatest(p_payment.receipt_date, v_inv.invoice_date), auth.uid())
  returning id into v_id;
  perform private.log_billing_event(p_company, 'ALLOCATION', v_id, v_inv.id, 'ALLOCATED', null, 'ACTIVE', null,
    jsonb_build_object('receipt_number', p_payment.receipt_number, 'invoice_number', v_inv.invoice_number, 'amount', p_amount));
  return v_id;
end;
$$;

revoke all on function private.allocate_payment(uuid, public.customer_payments, uuid, numeric) from public, anon, authenticated;

-- p_payment: {customer_id, receipt_date, amount, payment_method, transaction_reference, bank_reference, notes}
-- p_allocations: [{invoice_id, amount}] (optional)
create or replace function public.customer_payment_record(p_payment jsonb, p_allocations jsonb default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('payments.manage');
  v_previous jsonb;
  v_s        public.invoice_settings := private.billing_settings(v_company);
  v_cust     public.customers;
  v_pay      public.customer_payments;
  v_date     date;
  v_amount   numeric;
  v_method   text := upper(coalesce(p_payment ->> 'payment_method', ''));
  v_ref      text := nullif(btrim(coalesce(p_payment ->> 'transaction_reference', '')), '');
  v_dup      text;
  v_number   jsonb;
  v_entry    jsonb;
  v_alloc    int := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_payment_record');
  if v_previous is not null then return v_previous; end if;
  select * into v_cust from public.customers where id = nullif(p_payment ->> 'customer_id', '')::uuid and company_id = v_company;
  if not found then
    raise exception 'Choose a customer of your company.' using errcode = 'P0001';
  end if;
  begin
    v_date := coalesce(nullif(p_payment ->> 'receipt_date', '')::date, private.company_today(v_company));
    v_amount := (p_payment ->> 'amount')::numeric;
  exception when others then
    raise exception 'Enter a valid receipt date and amount.' using errcode = 'P0001';
  end;
  if v_date > private.company_today(v_company) then
    raise exception 'The receipt date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'The amount received must be greater than zero with at most 2 decimals.' using errcode = 'P0001';
  end if;
  if not (v_method = any(v_s.payment_methods)) then
    raise exception 'Payment method % is not enabled in Invoice Settings.', v_method using errcode = 'P0001';
  end if;
  if v_ref is not null then
    select receipt_number into v_dup from public.customer_payments
    where company_id = v_company and customer_id = v_cust.id and status = 'RECORDED' and lower(transaction_reference) = lower(v_ref);
    if v_dup is not null then
      raise exception 'A receipt with reference % is already recorded for this customer (%).', v_ref, v_dup using errcode = 'P0001';
    end if;
  end if;

  v_number := private.next_billing_number(v_company, 'RECEIPT', v_date);
  insert into public.customer_payments (company_id, receipt_number, customer_id, receipt_date, amount_received, currency, payment_method, transaction_reference,
    bank_reference, notes, recorded_by)
  values (v_company, v_number ->> 'number', v_cust.id, v_date, v_amount, (select currency_code from public.companies where id = v_company), v_method, v_ref,
    nullif(btrim(coalesce(p_payment ->> 'bank_reference', '')), ''), nullif(btrim(coalesce(p_payment ->> 'notes', '')), ''), auth.uid())
  returning * into v_pay;
  perform private.log_billing_event(v_company, 'PAYMENT', v_pay.id, null, 'RECORDED', null, 'RECORDED', null,
    jsonb_build_object('receipt_number', v_pay.receipt_number, 'amount', v_amount, 'method', v_method));

  for v_entry in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) order by value ->> 'invoice_id' loop
    begin
      perform private.allocate_payment(v_company, v_pay, (v_entry ->> 'invoice_id')::uuid, (v_entry ->> 'amount')::numeric);
    exception when invalid_text_representation then
      raise exception 'Allocation amounts must be numbers.' using errcode = 'P0001';
    end;
    v_alloc := v_alloc + 1;
  end loop;
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'payment_id', v_pay.id, 'receipt_number', v_pay.receipt_number, 'allocations', v_alloc, 'unallocated', v_amount - private.payment_allocated(v_pay.id)));
end;
$$;

-- p_allocations: [{invoice_id, amount}]
create or replace function public.customer_payment_allocate(p_payment_id uuid, p_allocations jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('payments.manage');
  v_previous jsonb;
  v_pay      public.customer_payments;
  v_entry    jsonb;
  v_count    int := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_payment_allocate');
  if v_previous is not null then return v_previous; end if;
  select * into v_pay from public.customer_payments where id = p_payment_id and company_id = v_company for update;
  if not found then
    raise exception 'Receipt not found in your company.' using errcode = 'P0001';
  end if;
  if v_pay.status <> 'RECORDED' then
    raise exception 'Receipt % is reversed.', v_pay.receipt_number using errcode = 'P0001';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Enter at least one allocation.' using errcode = 'P0001';
  end if;
  for v_entry in select value from jsonb_array_elements(p_allocations) order by value ->> 'invoice_id' loop
    begin
      perform private.allocate_payment(v_company, v_pay, (v_entry ->> 'invoice_id')::uuid, (v_entry ->> 'amount')::numeric);
    exception when invalid_text_representation then
      raise exception 'Allocation amounts must be numbers.' using errcode = 'P0001';
    end;
    v_count := v_count + 1;
  end loop;
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'allocations', v_count, 'unallocated', v_pay.amount_received - private.payment_allocated(v_pay.id)));
end;
$$;

create or replace function public.payment_allocation_reverse(p_allocation_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('payments.reverse');
  v_a       public.invoice_payment_allocations;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_a from public.invoice_payment_allocations where id = p_allocation_id and company_id = v_company for update;
  if not found then
    raise exception 'Allocation not found in your company.' using errcode = 'P0001';
  end if;
  if v_a.status <> 'ACTIVE' then
    raise exception 'This allocation is already reversed.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Enter the reason for reversing the allocation.' using errcode = 'P0001';
  end if;
  perform 1 from public.sales_invoices where id = v_a.invoice_id for update;
  update public.invoice_payment_allocations set status = 'REVERSED', reversal_reason = left(v_reason, 1000), reversed_by = auth.uid(), reversed_at = now() where id = v_a.id;
  perform private.log_billing_event(v_company, 'ALLOCATION', v_a.id, v_a.invoice_id, 'REVERSED', 'ACTIVE', 'REVERSED', v_reason,
    jsonb_build_object('amount', v_a.allocated_amount, 'payment_id', v_a.payment_id));
  return jsonb_build_object('status', 'REVERSED', 'invoice_balance', private.invoice_balance(v_a.invoice_id));
end;
$$;

create or replace function public.customer_payment_reverse(p_payment_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('payments.reverse');
  v_previous jsonb;
  v_pay      public.customer_payments;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_a        public.invoice_payment_allocations;
  v_count    int := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_payment_reverse');
  if v_previous is not null then return v_previous; end if;
  select * into v_pay from public.customer_payments where id = p_payment_id and company_id = v_company for update;
  if not found then
    raise exception 'Receipt not found in your company.' using errcode = 'P0001';
  end if;
  if v_pay.status <> 'RECORDED' then
    raise exception 'Receipt % is already reversed.', v_pay.receipt_number using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Enter the reason for reversing the receipt (e.g. cheque dishonoured, recorded in error).' using errcode = 'P0001';
  end if;
  for v_a in select * from public.invoice_payment_allocations where payment_id = v_pay.id and status = 'ACTIVE' order by invoice_id for update loop
    update public.invoice_payment_allocations set status = 'REVERSED', reversal_reason = left('Receipt reversed: ' || v_reason, 1000), reversed_by = auth.uid(), reversed_at = now()
    where id = v_a.id;
    perform private.log_billing_event(v_company, 'ALLOCATION', v_a.id, v_a.invoice_id, 'REVERSED', 'ACTIVE', 'REVERSED', 'Receipt reversed: ' || v_reason,
      jsonb_build_object('amount', v_a.allocated_amount, 'payment_id', v_pay.id));
    v_count := v_count + 1;
  end loop;
  update public.customer_payments set status = 'REVERSED', reversal_reason = left(v_reason, 1000), reversed_by = auth.uid(), reversed_at = now() where id = v_pay.id;
  perform private.log_billing_event(v_company, 'PAYMENT', v_pay.id, null, 'REVERSED', 'RECORDED', 'REVERSED', v_reason,
    jsonb_build_object('receipt_number', v_pay.receipt_number, 'allocations_reversed', v_count));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('status', 'REVERSED', 'allocations_reversed', v_count));
end;
$$;

create or replace view public.customer_payment_list
with (security_invoker = true) as
select p.*, c.customer_code, coalesce(c.legal_name, c.customer_name) as customer_name,
  private.payment_allocated(p.id) as allocated_amount,
  case when p.status = 'RECORDED' then p.amount_received - private.payment_allocated(p.id) else 0 end as unallocated_amount,
  (select count(*) from public.invoice_payment_allocations a where a.payment_id = p.id and a.status = 'ACTIVE')::int as allocation_count
from public.customer_payments p
join public.customers c on c.id = p.customer_id;

create or replace view public.invoice_payment_allocation_list
with (security_invoker = true) as
select a.*, i.invoice_number, i.invoice_date, i.customer_id, p.receipt_number, p.receipt_date, p.payment_method
from public.invoice_payment_allocations a
join public.sales_invoices i on i.id = a.invoice_id
join public.customer_payments p on p.id = a.payment_id;

revoke all on public.customer_payment_list, public.invoice_payment_allocation_list from anon, authenticated;
grant select on public.customer_payment_list, public.invoice_payment_allocation_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.customer_payment_record(jsonb, jsonb, uuid)', 'public.customer_payment_allocate(uuid, jsonb, uuid)',
    'public.payment_allocation_reverse(uuid, text)', 'public.customer_payment_reverse(uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
