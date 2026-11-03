-- =============================================================================
-- Phase 5: safe extensions of the Phase 4 inventory ledger
--
-- No new stock tables. Production and outsourcing post through the same
-- private.post_movement (the only writer of ledger rows and balances).
--
--   1. Location usage: STORAGE (normal, saleable/usable), REJECTED (non-saleable
--      rejected goods) and EXTERNAL_PROCESSING (company-owned stock held by an
--      outside processor). Only STORAGE stock counts as "available".
--   2. New ledger transaction types:
--        PRODUCTION_ISSUE        (-) raw material issued to a production order
--        PRODUCTION_RECEIPT      (+) finished goods received from production
--        SUBCONTRACT_CONSUMPTION (-) company material consumed by an outside processor
--        SUBCONTRACT_RECEIPT     (+) goods received from an outsourcing order
--      and document types PRODUCTION / OUTSOURCING.
--   3. Stock at external-processing locations moves only through outsourcing
--      orders (plus opening stock, approved adjustments, counts and reversals).
--   4. Production / outsourcing postings and production reservations can only be
--      changed through their own modules (so documents and ledger stay in step).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Location usage
-- -----------------------------------------------------------------------------
alter table public.inventory_locations add column if not exists stock_usage text not null default 'STORAGE';
alter table public.inventory_locations add column if not exists external_holder text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_locations_stock_usage_check') then
    alter table public.inventory_locations add constraint inventory_locations_stock_usage_check
      check (stock_usage in ('STORAGE', 'REJECTED', 'EXTERNAL_PROCESSING'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_locations_external_holder_check') then
    alter table public.inventory_locations add constraint inventory_locations_external_holder_check
      check ((stock_usage = 'EXTERNAL_PROCESSING') = (external_holder is not null)
             and (external_holder is null or length(btrim(external_holder)) between 1 and 200));
  end if;
end;
$$;

comment on column public.inventory_locations.stock_usage is
  'STORAGE: usable/saleable stock. REJECTED: non-saleable rejected goods. EXTERNAL_PROCESSING: company-owned stock physically held by an outside processor (moved only by outsourcing orders). Only STORAGE stock is "available".';
comment on column public.inventory_locations.external_holder is
  'Who physically holds the stock at an EXTERNAL_PROCESSING location (supplier name until the supplier master exists).';

create or replace function private.before_location_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor uuid;
  v_depth int := 0;
begin
  new.location_code := upper(btrim(new.location_code));
  new.location_name := btrim(new.location_name);
  new.external_holder := nullif(btrim(coalesce(new.external_holder, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if not exists (select 1 from public.warehouses w where w.id = new.warehouse_id and w.company_id = new.company_id and w.status = 'ACTIVE') then
      raise exception 'Locations can only be added to an active warehouse of your company.' using errcode = 'P0001';
    end if;
  else
    new.created_by := old.created_by;
    new.company_id := old.company_id;
    new.warehouse_id := old.warehouse_id;
    new.location_code := old.location_code;
    new.is_default := old.is_default;
    if old.status = 'ACTIVE' and new.status = 'INACTIVE' then
      if old.is_default then
        raise exception 'The default location of a warehouse cannot be deactivated.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.inventory_balances b where b.location_id = old.id and (b.on_hand <> 0 or b.reserved <> 0)) then
        raise exception 'This location still holds stock. Transfer it out before deactivating.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.inventory_locations c where c.parent_location_id = old.id and c.status = 'ACTIVE') then
        raise exception 'Deactivate the child locations first.' using errcode = 'P0001';
      end if;
    end if;
    -- Changing what a location is used for would silently reclassify its stock.
    if new.stock_usage is distinct from old.stock_usage
       and exists (select 1 from public.inventory_balances b where b.location_id = old.id and (b.on_hand <> 0 or b.reserved <> 0)) then
      raise exception 'The usage of a location that holds stock cannot be changed. Move the stock first.' using errcode = 'P0001';
    end if;
  end if;
  if new.is_default and new.stock_usage <> 'STORAGE' then
    raise exception 'The default location of a warehouse must be a normal storage location.' using errcode = 'P0001';
  end if;
  new.updated_by := auth.uid();

  -- Parent must be active and must not create a cycle.
  if new.parent_location_id is not null and (tg_op = 'INSERT' or new.parent_location_id is distinct from old.parent_location_id) then
    if not exists (select 1 from public.inventory_locations p where p.id = new.parent_location_id and p.status = 'ACTIVE') then
      raise exception 'The parent location is inactive or does not exist.' using errcode = 'P0001';
    end if;
    v_cursor := new.parent_location_id;
    while v_cursor is not null loop
      if v_cursor = new.id then
        raise exception 'A location cannot be placed inside itself.' using errcode = 'P0001';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 10 then
        raise exception 'Location hierarchy is limited to 10 levels.' using errcode = 'P0001';
      end if;
      select parent_location_id into v_cursor from public.inventory_locations where id = v_cursor;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function private.before_location_write() from public, anon, authenticated;

grant insert (stock_usage, external_holder) on public.inventory_locations to authenticated;
grant update (stock_usage, external_holder) on public.inventory_locations to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Transaction and document types
-- -----------------------------------------------------------------------------
alter table public.inventory_transactions drop constraint if exists inventory_transactions_transaction_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_transaction_type_check check (transaction_type in (
  'OPENING_STOCK', 'RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'CUSTOMER_RETURN',
  'SUPPLIER_RETURN', 'REVERSAL', 'PRODUCTION_ISSUE', 'PRODUCTION_RECEIPT', 'SUBCONTRACT_CONSUMPTION', 'SUBCONTRACT_RECEIPT'));

alter table public.inventory_transactions drop constraint if exists inventory_transactions_direction_matches_type;
alter table public.inventory_transactions add constraint inventory_transactions_direction_matches_type check (
  (transaction_type in ('OPENING_STOCK', 'RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'CUSTOMER_RETURN', 'PRODUCTION_RECEIPT', 'SUBCONTRACT_RECEIPT') and direction = 1)
  or (transaction_type in ('ISSUE', 'TRANSFER_OUT', 'ADJUSTMENT_OUT', 'SUPPLIER_RETURN', 'PRODUCTION_ISSUE', 'SUBCONTRACT_CONSUMPTION') and direction = -1)
  or (transaction_type = 'REVERSAL'));

alter table public.inventory_transactions drop constraint if exists inventory_transactions_document_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_document_type_check check (
  document_type is null or document_type in
  ('OPENING', 'ADJUSTMENT', 'COUNT', 'RESERVATION', 'TRANSFER', 'RECEIPT', 'ISSUE', 'REVERSAL', 'PRODUCTION', 'OUTSOURCING'));

-- -----------------------------------------------------------------------------
-- 3. Posting core (same contract as Phase 4, extended types and location rule)
-- -----------------------------------------------------------------------------
create or replace function private.post_movement(
  p_company          uuid,
  p_type             text,
  p_batch_id         uuid,
  p_location_id      uuid,
  p_quantity         numeric,
  p_unit_cost        numeric,
  p_reference_type   text,
  p_reference_number text,
  p_reference_id     uuid,
  p_reason           text,
  p_notes            text,
  p_transaction_date timestamptz,
  p_document_type    text,
  p_document_id      uuid,
  p_transfer_group   uuid default null,
  p_reversal_of      uuid default null,
  p_approved_by      uuid default null,
  p_consume_reserved numeric default 0,
  p_direction        smallint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot       public.inventory_batches;
  v_product   public.products;
  v_location  public.inventory_locations;
  v_wh_status text;
  v_balance   public.inventory_balances;
  v_dir       smallint;
  v_id        uuid;
  v_available numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.' using errcode = 'P0001';
  end if;
  if p_quantity <> round(p_quantity, 3) then
    raise exception 'Quantities support at most 3 decimal places.' using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required for every stock movement.' using errcode = 'P0001';
  end if;
  if p_transaction_date is null or p_transaction_date > now() + interval '5 minutes' then
    raise exception 'Stock movements cannot be dated in the future.' using errcode = 'P0001';
  end if;

  v_dir := case
    when p_type in ('OPENING_STOCK', 'RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'CUSTOMER_RETURN', 'PRODUCTION_RECEIPT', 'SUBCONTRACT_RECEIPT') then 1
    when p_type in ('ISSUE', 'TRANSFER_OUT', 'ADJUSTMENT_OUT', 'SUPPLIER_RETURN', 'PRODUCTION_ISSUE', 'SUBCONTRACT_CONSUMPTION') then -1
    when p_type = 'REVERSAL' then p_direction
  end;
  if v_dir is null then
    raise exception 'Invalid transaction type %.', p_type using errcode = 'P0001';
  end if;

  select * into v_lot from public.inventory_batches where id = p_batch_id and company_id = p_company;
  if not found then
    raise exception 'Batch/lot not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_product from public.products where id = v_lot.product_id;
  select * into v_location from public.inventory_locations where id = p_location_id and company_id = p_company;
  if not found then
    raise exception 'Location not found in your company.' using errcode = 'P0001';
  end if;
  select status into v_wh_status from public.warehouses where id = v_location.warehouse_id;
  if v_location.status <> 'ACTIVE' or v_wh_status <> 'ACTIVE' then
    raise exception 'Location % is inactive and cannot be used for new transactions.', v_location.location_code using errcode = 'P0001';
  end if;
  if v_location.stock_usage = 'EXTERNAL_PROCESSING'
     and coalesce(p_document_type, '') not in ('OUTSOURCING', 'OPENING', 'ADJUSTMENT', 'COUNT', 'REVERSAL') then
    raise exception 'Location % is an external-processing location: stock there moves only through outsourcing orders.',
      v_location.location_code using errcode = 'P0001';
  end if;

  insert into public.inventory_balances (company_id, product_id, batch_id, warehouse_id, location_id, source_type)
  values (p_company, v_lot.product_id, v_lot.id, v_location.warehouse_id, v_location.id, v_lot.source_type)
  on conflict (batch_id, location_id) do nothing;

  select * into v_balance from public.inventory_balances
  where batch_id = v_lot.id and location_id = v_location.id
  for update;

  if v_dir = 1 then
    if p_consume_reserved <> 0 then
      raise exception 'Only outgoing movements can fulfil a reservation.' using errcode = 'P0001';
    end if;
    update public.inventory_balances
    set on_hand = on_hand + p_quantity,
        last_movement_at = greatest(coalesce(last_movement_at, p_transaction_date), p_transaction_date),
        updated_at = now()
    where id = v_balance.id;
  else
    if p_consume_reserved < 0 or p_consume_reserved > v_balance.reserved or p_consume_reserved > p_quantity then
      raise exception 'Reservation quantity does not match the reserved stock.' using errcode = 'P0001';
    end if;
    v_available := v_balance.on_hand - v_balance.reserved;
    if p_quantity - p_consume_reserved > v_available then
      raise exception 'Insufficient available stock for % at %: available %, requested %.',
        v_product.sku, v_location.location_code, v_available, p_quantity - p_consume_reserved
        using errcode = 'P0001';
    end if;
    update public.inventory_balances
    set on_hand = on_hand - p_quantity,
        reserved = reserved - p_consume_reserved,
        last_movement_at = greatest(coalesce(last_movement_at, p_transaction_date), p_transaction_date),
        updated_at = now()
    where id = v_balance.id;
  end if;

  insert into public.inventory_transactions (
    company_id, transaction_number, transaction_type, direction, product_id, batch_id, warehouse_id, location_id,
    quantity, unit, source_type, unit_cost, reference_type, reference_number, reference_id, reason, notes,
    transaction_date, document_type, document_id, transfer_group_id, reversal_of_transaction_id, created_by, approved_by)
  values (
    p_company, private.next_document_number(p_company, 'TXN'), p_type, v_dir, v_lot.product_id, v_lot.id,
    v_location.warehouse_id, v_location.id, p_quantity, v_product.base_unit, v_lot.source_type, p_unit_cost,
    nullif(btrim(coalesce(p_reference_type, '')), ''), nullif(btrim(coalesce(p_reference_number, '')), ''), p_reference_id,
    btrim(p_reason), nullif(btrim(coalesce(p_notes, '')), ''), p_transaction_date, p_document_type, p_document_id,
    p_transfer_group, p_reversal_of, auth.uid(), p_approved_by)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function private.post_movement(uuid, text, uuid, uuid, numeric, numeric, text, text, uuid, text, text, timestamptz, text, uuid, uuid, uuid, uuid, numeric, smallint) from public, anon, authenticated;

-- Weighted-average lot cost now also counts production and outsourcing inflows.
-- Still NULL when any inflow lacks a cost (unknown is never treated as zero).
create or replace function private.lot_average_cost(p_batch_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) = 0 or count(*) filter (where t.unit_cost is null) > 0 then null
    else round(sum(t.quantity * t.unit_cost) / nullif(sum(t.quantity), 0), 4)
  end
  from public.inventory_transactions t
  where t.batch_id = p_batch_id
    and t.transaction_type in ('OPENING_STOCK', 'RECEIPT', 'CUSTOMER_RETURN', 'ADJUSTMENT_IN', 'PRODUCTION_RECEIPT', 'SUBCONTRACT_RECEIPT')
    and not exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = t.id);
$$;

revoke all on function private.lot_average_cost(uuid) from public, anon;
grant execute on function private.lot_average_cost(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Reversal core (shared by the inventory, production and outsourcing modules)
-- -----------------------------------------------------------------------------
-- Reverses a posted transaction (transfers as a pair) and returns the new
-- transaction numbers. Caller is responsible for permission checks and for
-- keeping its own documents in step.
create or replace function private.reverse_ledger_transaction(p_company uuid, p_transaction_id uuid, p_reason text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx      public.inventory_transactions;
  v_leg     public.inventory_transactions;
  v_numbers text[] := '{}';
  v_new     uuid;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Enter the reason for the reversal.' using errcode = 'P0001';
  end if;
  select * into v_tx from public.inventory_transactions where id = p_transaction_id and company_id = p_company for update;
  if not found then
    raise exception 'Transaction not found in your company.' using errcode = 'P0001';
  end if;
  if v_tx.transaction_type = 'REVERSAL' then
    raise exception 'A reversal cannot itself be reversed. Post a new transaction instead.' using errcode = 'P0001';
  end if;

  -- Reverse the incoming leg of a transfer first so stock is available to return.
  for v_leg in
    select * from public.inventory_transactions
    where company_id = p_company
      and transaction_type <> 'REVERSAL'
      and (id = v_tx.id or (v_tx.transfer_group_id is not null and transfer_group_id = v_tx.transfer_group_id))
    order by direction desc
    for update
  loop
    if exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = v_leg.id) then
      raise exception 'Transaction % has already been reversed.', v_leg.transaction_number using errcode = 'P0001';
    end if;
    v_new := private.post_movement(p_company, 'REVERSAL', v_leg.batch_id, v_leg.location_id, v_leg.quantity, v_leg.unit_cost,
      v_leg.reference_type, v_leg.reference_number, v_leg.reference_id,
      'Reversal of ' || v_leg.transaction_number || ': ' || btrim(p_reason), null, now(),
      'REVERSAL', v_leg.id, v_leg.transfer_group_id, v_leg.id, auth.uid(), 0, (-v_leg.direction)::smallint);
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_new);
  end loop;
  return v_numbers;
end;
$$;

revoke all on function private.reverse_ledger_transaction(uuid, uuid, text) from public, anon, authenticated;

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
  if v_tx.document_type in ('PRODUCTION', 'OUTSOURCING') then
    raise exception 'Transaction % belongs to a % order. Reverse it from that order so the order stays consistent.',
      v_tx.transaction_number, lower(v_tx.document_type) using errcode = 'P0001';
  end if;

  v_numbers := private.reverse_ledger_transaction(v_company, p_transaction_id, p_reason);

  perform private.write_audit_log(v_company, 'inventory.transaction_reversed', 'inventory_transaction', v_tx.id::text,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Reservations: only from storage locations; production reservations are
--    managed by their production order.
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
  if upper(btrim(p_reference_type)) = 'PRODUCTION_ORDER' then
    raise exception 'Materials for production orders are reserved from the production order.' using errcode = 'P0001';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry time must be in the future.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.inventory_locations where id = p_location_id and company_id = v_company and stock_usage <> 'STORAGE') then
    raise exception 'Stock can only be reserved in a normal storage location (not rejected or external-processing stock).' using errcode = 'P0001';
  end if;
  perform private.require_active_product(v_company, p_product_id);
  v_lot := private.resolve_outflow_lot(v_company, p_product_id, p_location_id, p_batch_id, p_source_type);

  -- Row lock serialises concurrent reservations of the same stock.
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
  if v_reservation.reference_type = 'PRODUCTION_ORDER' then
    raise exception 'Reservation % belongs to production order %. Release it from the production order.',
      v_reservation.reservation_number, v_reservation.reference_number using errcode = 'P0001';
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
  if v_reservation.reference_type = 'PRODUCTION_ORDER' then
    raise exception 'Reservation % belongs to production order %. Issue the material from the production order.',
      v_reservation.reservation_number, v_reservation.reference_number using errcode = 'P0001';
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

-- -----------------------------------------------------------------------------
-- 6. Views: "available" counts storage locations only. The Phase 4 column lists
--    are kept exactly (so re-running either migration stays possible); usage
--    detail is exposed by the additional view inventory_product_usage_stock.
-- -----------------------------------------------------------------------------
create or replace view public.inventory_stock_detail
with (security_invoker = true) as
select
  b.id as balance_id, b.company_id, b.product_id, p.sku, p.product_name, p.barcode, p.category_id, c.name as category_name,
  p.product_type, p.default_source_type, p.base_unit, p.reorder_level, p.status as product_status,
  (p.archived_at is not null) as product_archived,
  b.batch_id, bt.batch_number, bt.is_system_lot, b.source_type, bt.manufacturing_date, bt.expiry_date,
  b.warehouse_id, w.warehouse_code, w.warehouse_name, w.status as warehouse_status,
  b.location_id, l.location_code, l.location_name, l.status as location_status,
  b.on_hand, b.reserved,
  case when l.stock_usage = 'STORAGE' then b.on_hand - b.reserved else 0::numeric end as available,
  b.last_movement_at
from public.inventory_balances b
join public.products p on p.id = b.product_id
join public.inventory_batches bt on bt.id = b.batch_id
join public.warehouses w on w.id = b.warehouse_id
join public.inventory_locations l on l.id = b.location_id
left join public.product_categories c on c.id = p.category_id
where b.on_hand <> 0 or b.reserved <> 0;

create or replace view public.inventory_product_stock
with (security_invoker = true) as
select
  p.id as product_id, p.company_id, p.sku, p.product_name, p.barcode, p.brand, p.model_number, p.category_id,
  c.name as category_name, p.product_type, p.default_source_type, p.base_unit, p.reorder_level,
  p.status as product_status, p.archived_at, p.track_batches,
  coalesce(s.on_hand, 0) as on_hand,
  coalesce(s.reserved, 0) as reserved,
  coalesce(s.available, 0) as available,
  coalesce(s.in_house, 0) as in_house_on_hand,
  coalesce(s.outsourced, 0) as outsourced_on_hand,
  coalesce(s.unknown, 0) as unknown_source_on_hand,
  s.last_movement_at,
  exists (select 1 from public.inventory_transactions t where t.company_id = p.company_id and t.product_id = p.id) as has_history,
  case
    when coalesce(s.storage_on_hand, 0) = 0 then 'OUT_OF_STOCK'
    when coalesce(s.available, 0) = 0 then 'FULLY_RESERVED'
    when p.reorder_level is null then 'NO_THRESHOLD'
    when coalesce(s.available, 0) <= p.reorder_level then 'LOW_STOCK'
    else 'HEALTHY'
  end as stock_status
from public.products p
left join public.product_categories c on c.id = p.category_id
left join (
  select b.product_id,
    sum(b.on_hand) as on_hand, sum(b.reserved) as reserved,
    sum(b.on_hand) filter (where l.stock_usage = 'STORAGE') as storage_on_hand,
    sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE') as available,
    sum(b.on_hand) filter (where b.source_type = 'IN_HOUSE') as in_house,
    sum(b.on_hand) filter (where b.source_type = 'OUTSOURCED') as outsourced,
    sum(b.on_hand) filter (where b.source_type = 'UNKNOWN') as unknown,
    max(b.last_movement_at) as last_movement_at
  from public.inventory_balances b
  join public.inventory_locations l on l.id = b.location_id
  group by b.product_id
) s on s.product_id = p.id;

-- Stock per product split by location usage (rejected / held by processors).
create or replace view public.inventory_product_usage_stock
with (security_invoker = true) as
select b.company_id, b.product_id,
  coalesce(sum(b.on_hand) filter (where l.stock_usage = 'STORAGE'), 0) as storage_on_hand,
  coalesce(sum(b.on_hand) filter (where l.stock_usage = 'REJECTED'), 0) as rejected_on_hand,
  coalesce(sum(b.on_hand) filter (where l.stock_usage = 'EXTERNAL_PROCESSING'), 0) as external_on_hand
from public.inventory_balances b
join public.inventory_locations l on l.id = b.location_id
where b.on_hand <> 0
group by b.company_id, b.product_id;

revoke all on public.inventory_stock_detail, public.inventory_product_stock, public.inventory_product_usage_stock from anon, authenticated;
grant select on public.inventory_stock_detail, public.inventory_product_stock, public.inventory_product_usage_stock to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Overview and alerts: status from usable (storage) stock
-- -----------------------------------------------------------------------------
create or replace function public.inventory_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_result  jsonb;
begin
  with ps as (
    select p.id, p.base_unit, p.reorder_level, p.status, p.category_id,
      coalesce(s.on_hand, 0) as on_hand, coalesce(s.storage_on_hand, 0) as storage_on_hand,
      coalesce(s.available, 0) as available,
      exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id) as has_history
    from public.products p
    left join (select b.product_id, sum(b.on_hand) on_hand,
                 sum(b.on_hand) filter (where l.stock_usage = 'STORAGE') storage_on_hand,
                 sum(b.on_hand - b.reserved) filter (where l.stock_usage = 'STORAGE') available
               from public.inventory_balances b join public.inventory_locations l on l.id = b.location_id
               where b.company_id = v_company group by b.product_id) s on s.product_id = p.id
    where p.company_id = v_company and p.archived_at is null
  ),
  active as (select * from ps where status = 'ACTIVE'),
  bal as (
    select b.*, p.base_unit, p.category_id, l.stock_usage from public.inventory_balances b
    join public.products p on p.id = b.product_id
    join public.inventory_locations l on l.id = b.location_id
    where b.company_id = v_company and p.archived_at is null and (b.on_hand <> 0 or b.reserved <> 0)
  )
  select jsonb_build_object(
    'active_products', (select count(*) from active),
    'products_with_stock', (select count(*) from active where on_hand > 0),
    'never_stocked', (select count(*) from active where on_hand = 0 and not has_history),
    'out_of_stock', (select count(*) from active where storage_on_hand = 0 and has_history),
    'fully_reserved', (select count(*) from active where storage_on_hand > 0 and available = 0),
    'low_stock', (select count(*) from active where available > 0 and reorder_level is not null and available <= reorder_level),
    'healthy', (select count(*) from active where available > 0 and reorder_level is not null and available > reorder_level),
    'no_threshold', (select count(*) from active where available > 0 and reorder_level is null),
    'units', coalesce((
      select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object('unit', base_unit,
          'on_hand', sum(on_hand), 'reserved', sum(reserved),
          'available', coalesce(sum(on_hand - reserved) filter (where stock_usage = 'STORAGE'), 0),
          'in_house', coalesce(sum(on_hand) filter (where source_type = 'IN_HOUSE'), 0),
          'outsourced', coalesce(sum(on_hand) filter (where source_type = 'OUTSOURCED'), 0),
          'unknown', coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0),
          'rejected', coalesce(sum(on_hand) filter (where stock_usage = 'REJECTED'), 0),
          'external', coalesce(sum(on_hand) filter (where stock_usage = 'EXTERNAL_PROCESSING'), 0)) as u
        from bal group by base_unit) x), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('category', coalesce(c.name, 'Uncategorised'), 'unit', b.base_unit, 'on_hand', sum_on_hand)
                       order by sum_on_hand desc)
      from (select category_id, base_unit, sum(on_hand) sum_on_hand from bal group by category_id, base_unit) b
      left join public.product_categories c on c.id = b.category_id), '[]'::jsonb),
    'by_warehouse', coalesce((
      select jsonb_agg(jsonb_build_object('warehouse_code', w.warehouse_code, 'warehouse_name', w.warehouse_name,
                                          'unit', b.base_unit, 'on_hand', sum_on_hand) order by sum_on_hand desc)
      from (select warehouse_id, base_unit, sum(on_hand) sum_on_hand from bal group by warehouse_id, base_unit) b
      join public.warehouses w on w.id = b.warehouse_id), '[]'::jsonb),
    'first_transaction_at', (select min(transaction_date) from public.inventory_transactions where company_id = v_company),
    'last_transaction_at', (select max(transaction_date) from public.inventory_transactions where company_id = v_company),
    'warehouses', (select count(*) from public.warehouses where company_id = v_company and status = 'ACTIVE'),
    'pending_opening', (select count(*) from public.inventory_opening_batches where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_adjustments', (select count(*) from public.inventory_adjustments where company_id = v_company and status = 'PENDING_APPROVAL'),
    'pending_counts', (select count(*) from public.inventory_counts where company_id = v_company and status = 'SUBMITTED'),
    'timezone', private.company_tz(v_company),
    'as_of', now()
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.inventory_refresh_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.read');
  v_today    date := private.company_today(v_company);
  v_warn     int := (private.inventory_policy(v_company) ->> 'expiry_warning_days')::int;
  v_opened   int;
  v_resolved int;
begin
  create temporary table if not exists pg_temp.current_alerts (
    alert_key text primary key, alert_type text, severity text, product_id uuid, batch_id uuid,
    warehouse_id uuid, location_id uuid, details jsonb
  ) on commit drop;
  truncate pg_temp.current_alerts;

  -- Product-level stock conditions (active products, usable storage stock only).
  insert into pg_temp.current_alerts
  select
    case when s.on_hand = 0 then 'OUT_OF_STOCK:' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED:' else 'LOW_STOCK:' end || p.id,
    case when s.on_hand = 0 then 'OUT_OF_STOCK' when s.on_hand - s.reserved = 0 then 'FULLY_RESERVED' else 'LOW_STOCK' end,
    case when s.on_hand - s.reserved = 0 then 'CRITICAL' else 'WARNING' end,
    p.id, null, null, null,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit, 'on_hand', s.on_hand,
      'reserved', s.reserved, 'available', s.on_hand - s.reserved, 'reorder_level', p.reorder_level)
  from public.products p
  join lateral (
    select coalesce(sum(b.on_hand), 0) as on_hand, coalesce(sum(b.reserved), 0) as reserved
    from public.inventory_balances b
    join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE'
    where b.product_id = p.id
  ) s on true
  where p.company_id = v_company and p.status = 'ACTIVE' and p.archived_at is null
    and (
      (s.on_hand - s.reserved = 0 and (p.reorder_level is not null
        or exists (select 1 from public.inventory_transactions t where t.company_id = v_company and t.product_id = p.id)))
      or (s.on_hand - s.reserved > 0 and p.reorder_level is not null and s.on_hand - s.reserved <= p.reorder_level)
    );

  -- Lot-level conditions.
  insert into pg_temp.current_alerts
  select
    case when bt.expiry_date < v_today then 'EXPIRED:' else 'EXPIRING:' end || b.id,
    case when bt.expiry_date < v_today then 'EXPIRED' else 'EXPIRING' end,
    case when bt.expiry_date < v_today then 'CRITICAL' else 'WARNING' end,
    b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'batch_number', bt.batch_number,
      'expiry_date', bt.expiry_date, 'on_hand', b.on_hand, 'unit', p.base_unit, 'location_code', l.location_code)
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  where b.company_id = v_company and b.on_hand > 0 and bt.expiry_date is not null and bt.expiry_date <= v_today + v_warn
  on conflict do nothing;

  insert into pg_temp.current_alerts
  select 'INVALID_LOCATION:' || b.id, 'INVALID_LOCATION', 'CRITICAL', b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'on_hand', b.on_hand, 'unit', p.base_unit,
      'location_code', l.location_code, 'warehouse_code', w.warehouse_code)
  from public.inventory_balances b
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  join public.warehouses w on w.id = b.warehouse_id
  where b.company_id = v_company and b.on_hand > 0 and (l.status <> 'ACTIVE' or w.status <> 'ACTIVE')
  on conflict do nothing;

  insert into pg_temp.current_alerts
  select 'UNKNOWN_SOURCE:' || b.id, 'UNKNOWN_SOURCE', 'WARNING', b.product_id, b.batch_id, b.warehouse_id, b.location_id,
    jsonb_build_object('sku', p.sku, 'product_name', p.product_name, 'on_hand', b.on_hand, 'unit', p.base_unit,
      'location_code', l.location_code, 'batch_number', bt.batch_number)
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.products p on p.id = b.product_id
  join public.inventory_locations l on l.id = b.location_id
  where b.company_id = v_company and b.on_hand > 0 and b.source_type = 'UNKNOWN'
  on conflict do nothing;

  -- Open new / refresh existing active alerts.
  with upserted as (
    insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, product_id, batch_id, warehouse_id, location_id, details)
    select v_company, alert_key, alert_type, severity, product_id, batch_id, warehouse_id, location_id, details from pg_temp.current_alerts
    on conflict (company_id, alert_key) where status in ('OPEN', 'ACKNOWLEDGED')
    do update set last_detected_at = now(), details = excluded.details, severity = excluded.severity
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_opened from upserted;

  -- Resolve conditions that no longer hold.
  update public.inventory_alerts a
  set status = 'RESOLVED', resolved_at = now()
  where a.company_id = v_company and a.status in ('OPEN', 'ACKNOWLEDGED')
    and not exists (select 1 from pg_temp.current_alerts c where c.alert_key = a.alert_key);
  get diagnostics v_resolved = row_count;

  return jsonb_build_object('opened', v_opened, 'resolved', v_resolved,
    'active', (select count(*) from public.inventory_alerts where company_id = v_company and status in ('OPEN', 'ACKNOWLEDGED')));
end;
$$;
