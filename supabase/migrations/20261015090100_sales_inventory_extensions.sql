-- =============================================================================
-- Phase 7: inventory extensions for sales order fulfilment and customer returns
--
-- No new stock tables. Everything still posts through private.post_movement.
--   1. Location usage QUARANTINE: returned goods awaiting inspection. Like
--      REJECTED and EXTERNAL_PROCESSING stock it is never "available".
--   2. Document types SALES_ORDER (dispatch ISSUE) and CUSTOMER_RETURN (return
--      receipt into quarantine, disposition transfers / issues).
--   3. Reservations with reference type SALES_ORDER_LINE (reference_id = sales order
--      line) belong to the sales order module; generic reservation, fulfil and
--      reversal actions refuse them and these documents.
--   4. Dispatch policy: required transport fields per company.
-- =============================================================================

-- 1. Location usage -----------------------------------------------------------
alter table public.inventory_locations drop constraint if exists inventory_locations_stock_usage_check;
alter table public.inventory_locations add constraint inventory_locations_stock_usage_check
  check (stock_usage in ('STORAGE', 'REJECTED', 'EXTERNAL_PROCESSING', 'QUARANTINE'));

comment on column public.inventory_locations.stock_usage is
  'STORAGE: usable/saleable stock. REJECTED: non-saleable rejected goods. EXTERNAL_PROCESSING: company-owned stock physically held by an outside processor. QUARANTINE: returned goods awaiting inspection. Only STORAGE stock is "available".';

-- 2. Document types -----------------------------------------------------------
alter table public.inventory_transactions drop constraint if exists inventory_transactions_document_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_document_type_check check (
  document_type is null or document_type in
  ('OPENING', 'ADJUSTMENT', 'COUNT', 'RESERVATION', 'TRANSFER', 'RECEIPT', 'ISSUE', 'REVERSAL', 'PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO',
   'SALES_ORDER', 'CUSTOMER_RETURN'));

create index if not exists stock_reservations_reference_idx on public.stock_reservations (reference_type, reference_id);

-- Returned goods never enter sellable stock directly: a CUSTOMER_RETURN posting
-- (including the generic Phase 4 receipt of that type) must go to a
-- non-storage location; restocking is a transfer after inspection.
create or replace function private.guard_return_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.transaction_type = 'CUSTOMER_RETURN'
     and exists (select 1 from public.inventory_locations where id = new.location_id and stock_usage = 'STORAGE') then
    raise exception 'Customer returns are received into a quarantine location and inspected before restocking (Sales & Fulfilment > Customer Returns).'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_return_location() from public, anon, authenticated;

drop trigger if exists inventory_transactions_guard_return on public.inventory_transactions;
create trigger inventory_transactions_guard_return before insert on public.inventory_transactions
  for each row execute function private.guard_return_location();

-- 3. Module-owned reservations and documents ----------------------------------
create or replace function private.reservation_owned_by_module(p_reference_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(btrim(coalesce(p_reference_type, '')))
    when 'PRODUCTION_ORDER' then 'production order'
    when 'CUSTOMER_PO' then 'customer purchase order'
    when 'SALES_ORDER_LINE' then 'sales order'
  end;
$$;

revoke all on function private.reservation_owned_by_module(text) from public, anon, authenticated;

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
  if v_tx.document_type in ('PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO', 'SALES_ORDER', 'CUSTOMER_RETURN') then
    raise exception 'Transaction % belongs to a %. Reverse it from that order so it stays consistent.',
      v_tx.transaction_number,
      case v_tx.document_type when 'PRODUCTION' then 'production order' when 'OUTSOURCING' then 'outsourcing order'
        when 'CUSTOMER_PO' then 'customer purchase order' when 'SALES_ORDER' then 'sales order dispatch'
        else 'customer return' end
      using errcode = 'P0001';
  end if;

  v_numbers := private.reverse_ledger_transaction(v_company, p_transaction_id, p_reason);

  perform private.write_audit_log(v_company, 'inventory.transaction_reversed', 'inventory_transaction', v_tx.id::text,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- 4. Dispatch policy ----------------------------------------------------------
-- company_settings 'fulfilment.dispatch_required_fields': JSON array of field
-- names that must be entered before a dispatch can be posted. Default: none.
create or replace function private.fulfilment_policy(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('dispatch_required_fields', coalesce((
    select jsonb_agg(f) from jsonb_array_elements_text(s.setting_value) f
    where f in ('carrier_name', 'transport_mode', 'vehicle_number', 'lr_number', 'tracking_number', 'eway_bill_number')
  ), '[]'::jsonb))
  from (select coalesce((select case when jsonb_typeof(setting_value) = 'array' then setting_value end from public.company_settings
                         where company_id = p_company and setting_key = 'fulfilment.dispatch_required_fields'), '[]'::jsonb) as setting_value) s;
$$;

revoke all on function private.fulfilment_policy(uuid) from public, anon, authenticated;

create or replace function public.fulfilment_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment.read');
begin
  return private.fulfilment_policy(v_company);
end;
$$;

revoke all on function public.fulfilment_policy() from public, anon;
grant execute on function public.fulfilment_policy() to authenticated;
