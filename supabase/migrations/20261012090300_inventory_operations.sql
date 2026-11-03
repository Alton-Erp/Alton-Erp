-- =============================================================================
-- Phase 4: stock operations (RPCs) and reservations
-- All functions: SECURITY DEFINER, permission checked inside, company derived
-- from the caller, idempotency key required for postings.
-- =============================================================================

-- Resolves which lot an outgoing movement / reservation applies to.
create or replace function private.resolve_outflow_lot(
  p_company uuid, p_product_id uuid, p_location_id uuid, p_batch_id uuid, p_source_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_lot     uuid;
  v_count   int;
begin
  select * into v_product from public.products where id = p_product_id and company_id = p_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;

  if p_batch_id is not null then
    select id into v_lot from public.inventory_batches
    where id = p_batch_id and product_id = p_product_id and company_id = p_company;
    if v_lot is null then
      raise exception 'The selected batch does not belong to this product.' using errcode = 'P0001';
    end if;
    return v_lot;
  end if;

  if v_product.track_batches then
    raise exception 'Product % uses batch tracking: select the batch.', v_product.sku using errcode = 'P0001';
  end if;

  if p_source_type is not null then
    select id into v_lot from public.inventory_batches
    where company_id = p_company and product_id = p_product_id and is_system_lot and source_type = p_source_type;
    if v_lot is null then
      raise exception 'There is no % stock of % recorded.', p_source_type, v_product.sku using errcode = 'P0001';
    end if;
    return v_lot;
  end if;

  select count(*), min(b.batch_id::text)::uuid into v_count, v_lot
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id and bt.is_system_lot
  where b.product_id = p_product_id and b.location_id = p_location_id and b.on_hand > 0;
  if v_count = 0 then
    raise exception 'There is no stock of % at this location.', v_product.sku using errcode = 'P0001';
  elsif v_count > 1 then
    raise exception 'This location holds % stock from more than one source. Choose the source.', v_product.sku using errcode = 'P0001';
  end if;
  return v_lot;
end;
$$;

revoke all on function private.resolve_outflow_lot(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function private.require_active_product(p_company uuid, p_product_id uuid)
returns public.products
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products;
begin
  select * into v_product from public.products where id = p_product_id and company_id = p_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if v_product.status <> 'ACTIVE' or v_product.archived_at is not null then
    raise exception 'Product % is inactive; new stock cannot be received for it.', v_product.sku using errcode = 'P0001';
  end if;
  return v_product;
end;
$$;

revoke all on function private.require_active_product(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Receipt / customer return
-- -----------------------------------------------------------------------------
create or replace function public.inventory_post_receipt(
  p_product_id         uuid,
  p_location_id        uuid,
  p_quantity           numeric,
  p_source_type        text,
  p_batch_number       text default null,
  p_manufacturing_date date default null,
  p_expiry_date        date default null,
  p_unit_cost          numeric default null,
  p_transaction_type   text default 'RECEIPT',
  p_reference_type     text default null,
  p_reference_number   text default null,
  p_reason             text default null,
  p_notes              text default null,
  p_idempotency_key    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.create');
  v_previous jsonb;
  v_location public.inventory_locations;
  v_lot      uuid;
  v_tx       uuid;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'receipt');
  if v_previous is not null then return v_previous; end if;

  if p_transaction_type not in ('RECEIPT', 'CUSTOMER_RETURN') then
    raise exception 'Receipt type must be RECEIPT or CUSTOMER_RETURN.' using errcode = 'P0001';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative.' using errcode = 'P0001';
  end if;
  perform private.require_active_product(v_company, p_product_id);
  select * into v_location from public.inventory_locations where id = p_location_id and company_id = v_company;
  if not found then
    raise exception 'Location not found in your company.' using errcode = 'P0001';
  end if;

  v_lot := private.ensure_batch(v_company, p_product_id, p_source_type, p_batch_number, p_manufacturing_date,
    p_expiry_date, p_unit_cost, p_reference_type, null, v_location.warehouse_id, v_location.id, false);
  v_tx := private.post_movement(v_company, p_transaction_type, v_lot, v_location.id, p_quantity, p_unit_cost,
    p_reference_type, p_reference_number, null,
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), case when p_transaction_type = 'RECEIPT' then 'Goods received' else 'Customer return' end),
    p_notes, now(), 'RECEIPT', null);

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'transaction_id', v_tx,
    'transaction_number', (select transaction_number from public.inventory_transactions where id = v_tx)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Issue / supplier return
-- -----------------------------------------------------------------------------
create or replace function public.inventory_post_issue(
  p_product_id       uuid,
  p_location_id      uuid,
  p_quantity         numeric,
  p_batch_id         uuid default null,
  p_source_type      text default null,
  p_transaction_type text default 'ISSUE',
  p_reference_type   text default null,
  p_reference_number text default null,
  p_reason           text default null,
  p_notes            text default null,
  p_idempotency_key  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.create');
  v_previous jsonb;
  v_lot      uuid;
  v_tx       uuid;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'issue');
  if v_previous is not null then return v_previous; end if;

  if p_transaction_type not in ('ISSUE', 'SUPPLIER_RETURN') then
    raise exception 'Issue type must be ISSUE or SUPPLIER_RETURN.' using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Enter a reason for the issue.' using errcode = 'P0001';
  end if;
  v_lot := private.resolve_outflow_lot(v_company, p_product_id, p_location_id, p_batch_id, p_source_type);
  v_tx := private.post_movement(v_company, p_transaction_type, v_lot, p_location_id, p_quantity, null,
    p_reference_type, p_reference_number, null, p_reason, p_notes, now(), 'ISSUE', null);

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'transaction_id', v_tx,
    'transaction_number', (select transaction_number from public.inventory_transactions where id = v_tx)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Transfer: paired TRANSFER_OUT / TRANSFER_IN in one transaction.
-- Same lot on both sides, so product, unit, batch and source are preserved.
-- -----------------------------------------------------------------------------
create or replace function public.inventory_transfer_stock(
  p_product_id       uuid,
  p_from_location_id uuid,
  p_to_location_id   uuid,
  p_quantity         numeric,
  p_batch_id         uuid default null,
  p_source_type      text default null,
  p_reference_number text default null,
  p_reason           text default null,
  p_notes            text default null,
  p_idempotency_key  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory_transfer.create');
  v_previous jsonb;
  v_lot      public.inventory_batches;
  v_to       public.inventory_locations;
  v_group    uuid := gen_random_uuid();
  v_out      uuid;
  v_in       uuid;
  v_reason   text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Stock transfer');
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'transfer');
  if v_previous is not null then return v_previous; end if;

  if p_from_location_id = p_to_location_id then
    raise exception 'Choose a different destination location.' using errcode = 'P0001';
  end if;
  select * into v_to from public.inventory_locations where id = p_to_location_id and company_id = v_company;
  if not found then
    raise exception 'Destination location not found in your company.' using errcode = 'P0001';
  end if;

  select * into v_lot from public.inventory_batches
  where id = private.resolve_outflow_lot(v_company, p_product_id, p_from_location_id, p_batch_id, p_source_type);

  -- Lock both balance rows in a fixed order to avoid deadlocks.
  insert into public.inventory_balances (company_id, product_id, batch_id, warehouse_id, location_id, source_type)
  values (v_company, v_lot.product_id, v_lot.id, v_to.warehouse_id, v_to.id, v_lot.source_type)
  on conflict (batch_id, location_id) do nothing;
  perform 1 from public.inventory_balances
  where batch_id = v_lot.id and location_id in (p_from_location_id, p_to_location_id)
  order by location_id
  for update;

  v_out := private.post_movement(v_company, 'TRANSFER_OUT', v_lot.id, p_from_location_id, p_quantity, null,
    'TRANSFER', p_reference_number, null, v_reason, p_notes, now(), 'TRANSFER', v_group, v_group);
  v_in := private.post_movement(v_company, 'TRANSFER_IN', v_lot.id, p_to_location_id, p_quantity, null,
    'TRANSFER', p_reference_number, null, v_reason, p_notes, now(), 'TRANSFER', v_group, v_group);

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'transfer_group_id', v_group,
    'out_transaction_number', (select transaction_number from public.inventory_transactions where id = v_out),
    'in_transaction_number', (select transaction_number from public.inventory_transactions where id = v_in)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Reversal: the only way to correct a posted transaction. Transfers are
-- reversed as a pair. History is preserved (original rows untouched).
-- -----------------------------------------------------------------------------
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
  v_leg      public.inventory_transactions;
  v_numbers  text[] := '{}';
  v_new      uuid;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'reversal');
  if v_previous is not null then return v_previous; end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Enter the reason for the reversal.' using errcode = 'P0001';
  end if;
  select * into v_tx from public.inventory_transactions where id = p_transaction_id and company_id = v_company for update;
  if not found then
    raise exception 'Transaction not found in your company.' using errcode = 'P0001';
  end if;
  if v_tx.transaction_type = 'REVERSAL' then
    raise exception 'A reversal cannot itself be reversed. Post a new transaction instead.' using errcode = 'P0001';
  end if;

  -- Reverse the incoming leg of a transfer first so stock is available to return.
  for v_leg in
    select * from public.inventory_transactions
    where company_id = v_company
      and transaction_type <> 'REVERSAL'
      and (id = v_tx.id or (v_tx.transfer_group_id is not null and transfer_group_id = v_tx.transfer_group_id))
    order by direction desc
    for update
  loop
    if exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = v_leg.id) then
      raise exception 'Transaction % has already been reversed.', v_leg.transaction_number using errcode = 'P0001';
    end if;
    v_new := private.post_movement(v_company, 'REVERSAL', v_leg.batch_id, v_leg.location_id, v_leg.quantity, v_leg.unit_cost,
      v_leg.reference_type, v_leg.reference_number, v_leg.reference_id,
      'Reversal of ' || v_leg.transaction_number || ': ' || btrim(p_reason), null, now(),
      'REVERSAL', v_leg.id, v_leg.transfer_group_id, v_leg.id, auth.uid(), 0, (-v_leg.direction)::smallint);
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_new);
  end loop;

  perform private.write_audit_log(v_company, 'inventory.transaction_reversed', 'inventory_transaction', v_tx.id::text,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Reservations
-- -----------------------------------------------------------------------------
create table if not exists public.stock_reservations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  reservation_number  text not null,
  product_id          uuid not null,
  batch_id            uuid not null,
  warehouse_id        uuid not null,
  location_id         uuid not null,
  quantity            numeric(14,3) not null check (quantity > 0),
  fulfilled_quantity  numeric(14,3) not null default 0 check (fulfilled_quantity >= 0),
  released_quantity   numeric(14,3) not null default 0 check (released_quantity >= 0),
  reservation_status  text not null default 'ACTIVE' check (reservation_status in
                        ('ACTIVE', 'PARTIALLY_FULFILLED', 'FULFILLED', 'RELEASED', 'CANCELLED', 'EXPIRED')),
  reference_type      text not null check (length(btrim(reference_type)) between 1 and 40),
  reference_number    text not null check (length(btrim(reference_number)) between 1 and 100),
  reference_id        uuid,
  notes               text check (notes is null or length(notes) <= 2000),
  reserved_by         uuid,
  reserved_at         timestamptz not null default now(),
  expires_at          timestamptz,
  released_by         uuid,
  released_at         timestamptz,
  updated_at          timestamptz not null default now(),
  constraint stock_reservations_number_unique unique (company_id, reservation_number),
  constraint stock_reservations_quantities check (fulfilled_quantity + released_quantity <= quantity),
  constraint stock_reservations_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint stock_reservations_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create index if not exists stock_reservations_status_idx on public.stock_reservations (company_id, reservation_status);
create index if not exists stock_reservations_lot_idx on public.stock_reservations (batch_id, location_id);
create index if not exists stock_reservations_expiry_idx on public.stock_reservations (expires_at) where reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED');

alter table public.stock_reservations enable row level security;
revoke all on table public.stock_reservations from anon, authenticated;
grant select on public.stock_reservations to authenticated;
grant all on table public.stock_reservations to service_role;

drop policy if exists stock_reservations_select on public.stock_reservations;
create policy stock_reservations_select on public.stock_reservations for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));

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
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry time must be in the future.' using errcode = 'P0001';
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

-- Releases the remaining quantity back to available stock.
create or replace function private.release_reservation_remaining(p_reservation public.stock_reservations, p_status text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining numeric := p_reservation.quantity - p_reservation.fulfilled_quantity - p_reservation.released_quantity;
begin
  if v_remaining > 0 then
    perform 1 from public.inventory_balances
    where batch_id = p_reservation.batch_id and location_id = p_reservation.location_id for update;
    update public.inventory_balances set reserved = reserved - v_remaining, updated_at = now()
    where batch_id = p_reservation.batch_id and location_id = p_reservation.location_id;
  end if;
  update public.stock_reservations
  set reservation_status = p_status,
      released_quantity = released_quantity + greatest(v_remaining, 0),
      released_by = auth.uid(),
      released_at = now(),
      updated_at = now()
  where id = p_reservation.id;
  return v_remaining;
end;
$$;

revoke all on function private.release_reservation_remaining(public.stock_reservations, text) from public, anon, authenticated;

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

-- Fulfilment = an actual ISSUE that consumes the reserved quantity, atomically.
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

-- Expires overdue reservations (restores available stock). Safe to call often.
create or replace function public.inventory_expire_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.read');
  v_row     public.stock_reservations;
  v_count   int := 0;
begin
  for v_row in
    select * from public.stock_reservations
    where company_id = v_company and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and expires_at is not null and expires_at <= now()
    for update skip locked
  loop
    perform private.release_reservation_remaining(v_row, 'EXPIRED');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Execute grants: authenticated only (permission checked inside each function)
-- -----------------------------------------------------------------------------
revoke all on function public.inventory_post_receipt(uuid, uuid, numeric, text, text, date, date, numeric, text, text, text, text, text, uuid) from public, anon;
revoke all on function public.inventory_post_issue(uuid, uuid, numeric, uuid, text, text, text, text, text, text, uuid) from public, anon;
revoke all on function public.inventory_transfer_stock(uuid, uuid, uuid, numeric, uuid, text, text, text, text, uuid) from public, anon;
revoke all on function public.inventory_reverse_transaction(uuid, text, uuid) from public, anon;
revoke all on function public.inventory_create_reservation(uuid, uuid, numeric, text, text, uuid, text, text, timestamptz, uuid) from public, anon;
revoke all on function public.inventory_release_reservation(uuid, text, text) from public, anon;
revoke all on function public.inventory_fulfil_reservation(uuid, numeric, text, text, uuid) from public, anon;
revoke all on function public.inventory_expire_reservations() from public, anon;

grant execute on function public.inventory_post_receipt(uuid, uuid, numeric, text, text, date, date, numeric, text, text, text, text, text, uuid) to authenticated;
grant execute on function public.inventory_post_issue(uuid, uuid, numeric, uuid, text, text, text, text, text, text, uuid) to authenticated;
grant execute on function public.inventory_transfer_stock(uuid, uuid, uuid, numeric, uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.inventory_reverse_transaction(uuid, text, uuid) to authenticated;
grant execute on function public.inventory_create_reservation(uuid, uuid, numeric, text, text, uuid, text, text, timestamptz, uuid) to authenticated;
grant execute on function public.inventory_release_reservation(uuid, text, text) to authenticated;
grant execute on function public.inventory_fulfil_reservation(uuid, numeric, text, text, uuid) to authenticated;
grant execute on function public.inventory_expire_reservations() to authenticated;
