-- =============================================================================
-- Phase 6: inventory extensions for customer PO allocation
--
-- Allocations ARE inventory reservations (public.stock_reservations) with
--   reference_type = 'CUSTOMER_PO', reference_number = customer PO number,
--   reference_id   = customer PO line id.
-- No separate allocation or stock table is created. An allocation never
-- changes on-hand stock; dispatch is an ISSUE that consumes the reservation.
--
-- Like production reservations (Phase 5), PO reservations and PO dispatches
-- can only be changed from the PO so documents and the ledger stay in step.
-- =============================================================================

alter table public.inventory_transactions drop constraint if exists inventory_transactions_document_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_document_type_check check (
  document_type is null or document_type in
  ('OPENING', 'ADJUSTMENT', 'COUNT', 'RESERVATION', 'TRANSFER', 'RECEIPT', 'ISSUE', 'REVERSAL', 'PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO'));

-- Reference types whose reservations belong to another module's documents.
create or replace function private.reservation_owned_by_module(p_reference_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(btrim(coalesce(p_reference_type, '')))
    when 'PRODUCTION_ORDER' then 'production order'
    when 'CUSTOMER_PO' then 'customer purchase order'
  end;
$$;

revoke all on function private.reservation_owned_by_module(text) from public, anon, authenticated;

-- Reserves p_quantity on one balance row (lot + location) after locking it.
-- Shared by PO allocation; same rules as the Phase 4 reservation RPC.
create or replace function private.reserve_balance(
  p_company        uuid,
  p_balance_id     uuid,
  p_quantity       numeric,
  p_reference_type text,
  p_reference_no   text,
  p_reference_id   uuid,
  p_notes          text
)
returns public.stock_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance public.inventory_balances;
  v_res     public.stock_reservations;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Reservation quantity must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  select * into v_balance from public.inventory_balances where id = p_balance_id and company_id = p_company for update;
  if not found then
    raise exception 'Stock lot not found in your company.' using errcode = 'P0001';
  end if;
  if v_balance.on_hand - v_balance.reserved < p_quantity then
    raise exception 'Only % available at this lot; cannot reserve %.', v_balance.on_hand - v_balance.reserved, p_quantity using errcode = 'P0001';
  end if;
  update public.inventory_balances set reserved = reserved + p_quantity, updated_at = now() where id = v_balance.id;
  insert into public.stock_reservations (company_id, reservation_number, product_id, batch_id, warehouse_id, location_id, quantity,
    reference_type, reference_number, reference_id, notes, reserved_by)
  values (p_company, private.next_document_number(p_company, 'RES'), v_balance.product_id, v_balance.batch_id, v_balance.warehouse_id,
    v_balance.location_id, p_quantity, p_reference_type, p_reference_no, p_reference_id, p_notes, auth.uid())
  returning * into v_res;
  return v_res;
end;
$$;

revoke all on function private.reserve_balance(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Generic reservation RPCs: refuse reservations owned by another module.
-- -----------------------------------------------------------------------------
create or replace function public.inventory_create_reservation(
  p_product_id       uuid,
  p_location_id      uuid,
  p_quantity         numeric,
  p_reference_type   text,
  p_reference_number text,
  p_batch_id         uuid default null,
  p_source_type      text default null,
  p_notes            text default null,
  p_expires_at       timestamptz default null,
  p_idempotency_key  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory_reservation.create');
  v_previous jsonb;
  v_lot      uuid;
  v_balance  public.inventory_balances;
  v_number   text;
  v_id       uuid;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'reservation');
  if v_previous is not null then return v_previous; end if;

  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Enter a quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reference_type), '') = '' or coalesce(btrim(p_reference_number), '') = '' then
    raise exception 'A reference type and reference number are required.' using errcode = 'P0001';
  end if;
  if private.reservation_owned_by_module(p_reference_type) is not null then
    raise exception 'Stock for a % is reserved from that document.', private.reservation_owned_by_module(p_reference_type) using errcode = 'P0001';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry time must be in the future.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.inventory_locations where id = p_location_id and company_id = v_company and stock_usage <> 'STORAGE') then
    raise exception 'Stock can only be reserved in a normal storage location (not rejected or external-processing stock).' using errcode = 'P0001';
  end if;
  perform private.require_active_product(v_company, p_product_id);
  v_lot := private.resolve_outflow_lot(v_company, p_product_id, p_location_id, p_batch_id, p_source_type);

  select * into v_balance from public.inventory_balances
  where batch_id = v_lot and location_id = p_location_id and company_id = v_company
  for update;
  if not found or v_balance.on_hand - v_balance.reserved < p_quantity then
    raise exception 'Cannot reserve % : only % available.', p_quantity, coalesce(v_balance.on_hand - v_balance.reserved, 0)
      using errcode = 'P0001';
  end if;

  update public.inventory_balances set reserved = reserved + p_quantity, updated_at = now() where id = v_balance.id;
  v_number := private.next_document_number(v_company, 'RES');
  insert into public.stock_reservations (company_id, reservation_number, product_id, batch_id, warehouse_id, location_id,
    quantity, reference_type, reference_number, notes, reserved_by, expires_at)
  values (v_company, v_number, p_product_id, v_lot, v_balance.warehouse_id, p_location_id, p_quantity,
    btrim(p_reference_type), btrim(p_reference_number), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(), p_expires_at)
  returning id into v_id;

  perform private.write_audit_log(v_company, 'inventory.reservation_created', 'stock_reservation', v_id::text,
    jsonb_build_object('reservation_number', v_number, 'quantity', p_quantity));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('reservation_id', v_id, 'reservation_number', v_number));
end;
$$;

create or replace function public.inventory_release_reservation(
  p_reservation_id uuid,
  p_action         text default 'RELEASE',
  p_note           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company     uuid := private.require_permission('inventory_reservation.release');
  v_reservation public.stock_reservations;
  v_released    numeric;
begin
  if p_action not in ('RELEASE', 'CANCEL') then
    raise exception 'Action must be RELEASE or CANCEL.' using errcode = 'P0001';
  end if;
  select * into v_reservation from public.stock_reservations
  where id = p_reservation_id and company_id = v_company for update;
  if not found then
    raise exception 'Reservation not found in your company.' using errcode = 'P0001';
  end if;
  if private.reservation_owned_by_module(v_reservation.reference_type) is not null then
    raise exception 'Reservation % belongs to % %. Release it from that document.',
      v_reservation.reservation_number, private.reservation_owned_by_module(v_reservation.reference_type), v_reservation.reference_number
      using errcode = 'P0001';
  end if;
  if v_reservation.reservation_status not in ('ACTIVE', 'PARTIALLY_FULFILLED') then
    raise exception 'Reservation % is already %.', v_reservation.reservation_number, lower(v_reservation.reservation_status)
      using errcode = 'P0001';
  end if;
  v_released := private.release_reservation_remaining(v_reservation, case when p_action = 'CANCEL' then 'CANCELLED' else 'RELEASED' end);
  if p_note is not null and btrim(p_note) <> '' then
    update public.stock_reservations
    set notes = left(coalesce(notes || E'\n', '') || btrim(p_note), 2000) where id = v_reservation.id;
  end if;
  perform private.write_audit_log(v_company, 'inventory.reservation_' || lower(p_action) || (case when p_action = 'CANCEL' then 'led' else 'd' end),
    'stock_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_number', v_reservation.reservation_number, 'released_quantity', v_released));
  return jsonb_build_object('released_quantity', v_released);
end;
$$;

create or replace function public.inventory_fulfil_reservation(
  p_reservation_id   uuid,
  p_quantity         numeric,
  p_reference_number text default null,
  p_notes            text default null,
  p_idempotency_key  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company     uuid := private.require_permission('inventory.create');
  v_previous    jsonb;
  v_reservation public.stock_reservations;
  v_remaining   numeric;
  v_tx          uuid;
  v_status      text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'fulfil_reservation');
  if v_previous is not null then return v_previous; end if;

  select * into v_reservation from public.stock_reservations
  where id = p_reservation_id and company_id = v_company for update;
  if not found then
    raise exception 'Reservation not found in your company.' using errcode = 'P0001';
  end if;
  if private.reservation_owned_by_module(v_reservation.reference_type) is not null then
    raise exception 'Reservation % belongs to % %. Issue or dispatch it from that document.',
      v_reservation.reservation_number, private.reservation_owned_by_module(v_reservation.reference_type), v_reservation.reference_number
      using errcode = 'P0001';
  end if;
  if v_reservation.reservation_status not in ('ACTIVE', 'PARTIALLY_FULFILLED') then
    raise exception 'Reservation % is %.', v_reservation.reservation_number, lower(v_reservation.reservation_status) using errcode = 'P0001';
  end if;
  if v_reservation.expires_at is not null and v_reservation.expires_at <= now() then
    raise exception 'Reservation % has expired.', v_reservation.reservation_number using errcode = 'P0001';
  end if;
  v_remaining := v_reservation.quantity - v_reservation.fulfilled_quantity - v_reservation.released_quantity;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_remaining then
    raise exception 'Fulfil between 0 and the remaining reserved quantity (%).', v_remaining using errcode = 'P0001';
  end if;

  v_tx := private.post_movement(v_company, 'ISSUE', v_reservation.batch_id, v_reservation.location_id, p_quantity, null,
    v_reservation.reference_type, coalesce(nullif(btrim(coalesce(p_reference_number, '')), ''), v_reservation.reference_number), v_reservation.id,
    'Reservation fulfilment ' || v_reservation.reservation_number, p_notes, now(), 'RESERVATION', v_reservation.id,
    null, null, null, p_quantity);

  v_status := case when v_remaining - p_quantity = 0 then 'FULFILLED' else 'PARTIALLY_FULFILLED' end;
  update public.stock_reservations
  set fulfilled_quantity = fulfilled_quantity + p_quantity, reservation_status = v_status, updated_at = now()
  where id = v_reservation.id;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'transaction_id', v_tx,
    'transaction_number', (select transaction_number from public.inventory_transactions where id = v_tx),
    'reservation_status', v_status));
end;
$$;

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
  if v_tx.document_type in ('PRODUCTION', 'OUTSOURCING', 'CUSTOMER_PO') then
    raise exception 'Transaction % belongs to a %. Reverse it from that order so it stays consistent.',
      v_tx.transaction_number,
      case v_tx.document_type when 'PRODUCTION' then 'production order' when 'OUTSOURCING' then 'outsourcing order' else 'customer purchase order' end
      using errcode = 'P0001';
  end if;

  v_numbers := private.reverse_ledger_transaction(v_company, p_transaction_id, p_reason);

  perform private.write_audit_log(v_company, 'inventory.transaction_reversed', 'inventory_transaction', v_tx.id::text,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;
