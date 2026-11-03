-- =============================================================================
-- Phase 4: stock ledger core
--
--   inventory_batches       stock lots with their ACTUAL source (and cost/expiry)
--   inventory_transactions  append-only ledger: the authoritative record
--   inventory_balances      derived on-hand / reserved per lot + location,
--                           updated only inside private.post_movement() in the
--                           same transaction as the ledger row
--
-- Clients have SELECT only. Every change goes through SECURITY DEFINER
-- functions that check permissions, lock rows and validate.
-- =============================================================================

-- Products: composite key target so stock rows can reference product + company.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_id_company_unique') then
    alter table public.products add constraint products_id_company_unique unique (id, company_id);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Batches / lots
-- -----------------------------------------------------------------------------
create table if not exists public.inventory_batches (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  product_id            uuid not null,
  -- NULL for the system lot of a product that does not use batch tracking.
  batch_number          text check (batch_number is null or batch_number ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$'),
  is_system_lot         boolean not null default false,
  -- Actual source of the stock in this lot. UNKNOWN = legacy stock flagged for review.
  source_type           text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  -- Reserved for the supplier master; must stay NULL until it exists (no invented suppliers).
  supplier_id           uuid check (supplier_id is null),
  manufacturing_date    date,
  expiry_date           date,
  unit_cost             numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  currency_code         text not null default 'INR' check (currency_code ~ '^[A-Z]{3}$'),
  reference_type        text check (reference_type is null or length(reference_type) <= 40),
  reference_id          uuid,
  received_warehouse_id uuid,
  received_location_id  uuid,
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLOSED')),
  created_by            uuid,
  created_at            timestamptz not null default now(),
  constraint inventory_batches_system_lot_has_no_number check (is_system_lot = (batch_number is null)),
  constraint inventory_batches_dates check (manufacturing_date is null or expiry_date is null or manufacturing_date <= expiry_date),
  constraint inventory_batches_id_company_unique unique (id, company_id),
  constraint inventory_batches_id_product_company_unique unique (id, product_id, company_id),
  constraint inventory_batches_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict
);

create unique index if not exists inventory_batches_system_lot_unique
  on public.inventory_batches (company_id, product_id, source_type) where is_system_lot;
create unique index if not exists inventory_batches_number_unique
  on public.inventory_batches (company_id, product_id, lower(batch_number), source_type) where not is_system_lot;
create index if not exists inventory_batches_product_idx on public.inventory_batches (company_id, product_id);
create index if not exists inventory_batches_expiry_idx on public.inventory_batches (company_id, expiry_date) where expiry_date is not null;

comment on table public.inventory_batches is
  'Stock lots. Batch-tracked products: one lot per batch number and source. Other products: one system lot per source. The source here is the actual source of the stock, independent of products.default_source_type.';

-- -----------------------------------------------------------------------------
-- Balances (derived; never written by clients)
-- -----------------------------------------------------------------------------
create table if not exists public.inventory_balances (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  product_id       uuid not null,
  batch_id         uuid not null,
  warehouse_id     uuid not null,
  location_id      uuid not null,
  source_type      text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  on_hand          numeric(14,3) not null default 0 check (on_hand >= 0),
  reserved         numeric(14,3) not null default 0 check (reserved >= 0),
  last_movement_at timestamptz,
  updated_at       timestamptz not null default now(),
  constraint inventory_balances_reserved_le_on_hand check (reserved <= on_hand),
  constraint inventory_balances_lot_location_unique unique (batch_id, location_id),
  constraint inventory_balances_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint inventory_balances_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create index if not exists inventory_balances_company_product_idx on public.inventory_balances (company_id, product_id);
create index if not exists inventory_balances_company_wh_idx on public.inventory_balances (company_id, warehouse_id, location_id);

comment on table public.inventory_balances is
  'Derived stock position per lot and location (on hand, reserved; available = on_hand - reserved). Maintained atomically by private.post_movement and the reservation functions. Reconcile with public.inventory_reconcile().';

-- -----------------------------------------------------------------------------
-- Ledger (append-only)
-- -----------------------------------------------------------------------------
create table if not exists public.inventory_transactions (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies (id) on delete restrict,
  transaction_number         text not null,
  transaction_type           text not null check (transaction_type in (
                               'OPENING_STOCK', 'RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN',
                               'ADJUSTMENT_OUT', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'REVERSAL')),
  direction                  smallint not null check (direction in (1, -1)),
  product_id                 uuid not null,
  batch_id                   uuid not null,
  warehouse_id               uuid not null,
  location_id                uuid not null,
  quantity                   numeric(14,3) not null check (quantity > 0),
  unit                       text not null,
  source_type                text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  unit_cost                  numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  reference_type             text check (reference_type is null or length(reference_type) <= 40),
  reference_number           text check (reference_number is null or length(reference_number) <= 100),
  reference_id               uuid,
  reason                     text not null check (length(btrim(reason)) between 1 and 500),
  notes                      text check (notes is null or length(notes) <= 2000),
  transaction_date           timestamptz not null,
  status                     text not null default 'POSTED' check (status = 'POSTED'),
  document_type              text check (document_type is null or document_type in
                               ('OPENING', 'ADJUSTMENT', 'COUNT', 'RESERVATION', 'TRANSFER', 'RECEIPT', 'ISSUE', 'REVERSAL')),
  document_id                uuid,
  transfer_group_id          uuid,
  reversal_of_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  created_by                 uuid,
  approved_by                uuid,
  created_at                 timestamptz not null default now(),
  constraint inventory_transactions_number_unique unique (company_id, transaction_number),
  constraint inventory_transactions_one_reversal unique (reversal_of_transaction_id),
  constraint inventory_transactions_direction_matches_type check (
    (transaction_type in ('OPENING_STOCK', 'RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'CUSTOMER_RETURN') and direction = 1)
    or (transaction_type in ('ISSUE', 'TRANSFER_OUT', 'ADJUSTMENT_OUT', 'SUPPLIER_RETURN') and direction = -1)
    or (transaction_type = 'REVERSAL')),
  constraint inventory_transactions_reversal_link check ((transaction_type = 'REVERSAL') = (reversal_of_transaction_id is not null)),
  constraint inventory_transactions_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint inventory_transactions_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create index if not exists inventory_tx_company_date_idx on public.inventory_transactions (company_id, transaction_date desc);
create index if not exists inventory_tx_product_date_idx on public.inventory_transactions (company_id, product_id, transaction_date);
create index if not exists inventory_tx_lot_location_idx on public.inventory_transactions (batch_id, location_id);
create index if not exists inventory_tx_type_idx on public.inventory_transactions (company_id, transaction_type);
create index if not exists inventory_tx_document_idx on public.inventory_transactions (document_type, document_id);
create index if not exists inventory_tx_transfer_idx on public.inventory_transactions (transfer_group_id) where transfer_group_id is not null;
create index if not exists inventory_tx_warehouse_idx on public.inventory_transactions (company_id, warehouse_id, location_id);

comment on table public.inventory_transactions is
  'Authoritative append-only stock ledger. Never updated or deleted; corrections are REVERSAL entries. transaction_date is the effective date used for historical (as-of) reporting.';

create or replace function private.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Posted stock transactions cannot be changed or deleted. Post a reversal instead.' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_ledger_mutation() from public, anon, authenticated;

drop trigger if exists inventory_transactions_append_only on public.inventory_transactions;
create trigger inventory_transactions_append_only before update or delete on public.inventory_transactions
  for each row execute function private.prevent_ledger_mutation();
drop trigger if exists inventory_transactions_no_truncate on public.inventory_transactions;
create trigger inventory_transactions_no_truncate before truncate on public.inventory_transactions
  for each statement execute function private.prevent_ledger_mutation();

-- -----------------------------------------------------------------------------
-- Lot resolution
-- -----------------------------------------------------------------------------
-- Finds or creates the lot for a product. Enforces the product's batch and
-- expiry tracking rules. UNKNOWN source only when p_allow_unknown.
create or replace function private.ensure_batch(
  p_company        uuid,
  p_product_id     uuid,
  p_source_type    text,
  p_batch_number   text,
  p_mfg_date       date,
  p_expiry_date    date,
  p_unit_cost      numeric,
  p_reference_type text,
  p_reference_id   uuid,
  p_warehouse_id   uuid,
  p_location_id    uuid,
  p_allow_unknown  boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_batch   text := nullif(btrim(coalesce(p_batch_number, '')), '');
  v_lot     public.inventory_batches;
begin
  select * into v_product from public.products where id = p_product_id and company_id = p_company;
  if not found then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  if p_source_type is null or p_source_type not in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN') then
    raise exception 'Source type must be IN_HOUSE or OUTSOURCED.' using errcode = 'P0001';
  end if;
  if p_source_type = 'UNKNOWN' and not p_allow_unknown then
    raise exception 'An unverified (UNKNOWN) source is only allowed for opening stock.' using errcode = 'P0001';
  end if;

  if v_product.track_batches then
    if v_batch is null then
      raise exception 'Product % uses batch tracking: a batch/lot number is required.', v_product.sku using errcode = 'P0001';
    end if;
    if v_batch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$' then
      raise exception 'Batch numbers may contain letters, digits and . _ / - only.' using errcode = 'P0001';
    end if;
    select * into v_lot from public.inventory_batches
    where company_id = p_company and product_id = p_product_id and not is_system_lot
      and lower(batch_number) = lower(v_batch) and source_type = p_source_type;
    if found then
      if (p_expiry_date is not null and v_lot.expiry_date is not null and p_expiry_date <> v_lot.expiry_date)
         or (p_mfg_date is not null and v_lot.manufacturing_date is not null and p_mfg_date <> v_lot.manufacturing_date) then
        raise exception 'Batch % already exists with different dates.', v_batch using errcode = 'P0001';
      end if;
      return v_lot.id;
    end if;
    if v_product.track_expiry and p_expiry_date is null then
      raise exception 'Product % tracks expiry: an expiry date is required for a new batch.', v_product.sku using errcode = 'P0001';
    end if;
    if p_mfg_date is not null and p_expiry_date is not null and p_mfg_date > p_expiry_date then
      raise exception 'Manufacturing date cannot be after the expiry date.' using errcode = 'P0001';
    end if;
    insert into public.inventory_batches (company_id, product_id, batch_number, is_system_lot, source_type,
      manufacturing_date, expiry_date, unit_cost, reference_type, reference_id, received_warehouse_id, received_location_id, created_by)
    values (p_company, p_product_id, v_batch, false, p_source_type, p_mfg_date, p_expiry_date, p_unit_cost,
      p_reference_type, p_reference_id, p_warehouse_id, p_location_id, auth.uid())
    on conflict (company_id, product_id, lower(batch_number), source_type) where not is_system_lot do nothing;
    select id into v_lot.id from public.inventory_batches
    where company_id = p_company and product_id = p_product_id and not is_system_lot
      and lower(batch_number) = lower(v_batch) and source_type = p_source_type;
    return v_lot.id;
  end if;

  -- Not batch-tracked: one system lot per product and source.
  if v_batch is not null then
    raise exception 'Product % does not use batch tracking; leave the batch number blank.', v_product.sku using errcode = 'P0001';
  end if;
  if p_expiry_date is not null then
    raise exception 'Expiry dates require batch tracking on the product.' using errcode = 'P0001';
  end if;
  insert into public.inventory_batches (company_id, product_id, batch_number, is_system_lot, source_type,
    reference_type, reference_id, received_warehouse_id, received_location_id, created_by)
  values (p_company, p_product_id, null, true, p_source_type, p_reference_type, p_reference_id, p_warehouse_id, p_location_id, auth.uid())
  on conflict (company_id, product_id, source_type) where is_system_lot do nothing;
  select id into v_lot.id from public.inventory_batches
  where company_id = p_company and product_id = p_product_id and is_system_lot and source_type = p_source_type;
  return v_lot.id;
end;
$$;

revoke all on function private.ensure_batch(uuid, uuid, text, text, date, date, numeric, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- Weighted-average cost of a lot from its costed inflows (documented costing
-- method). NULL when any inflow lacks a cost: unknown is never treated as 0.
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
    and t.transaction_type in ('OPENING_STOCK', 'RECEIPT', 'CUSTOMER_RETURN', 'ADJUSTMENT_IN')
    and not exists (select 1 from public.inventory_transactions r where r.reversal_of_transaction_id = t.id);
$$;

revoke all on function private.lot_average_cost(uuid) from public, anon;
grant execute on function private.lot_average_cost(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The ONLY writer of ledger rows and balances.
-- Locks the balance row; rejects negative stock and issuing reserved stock.
-- p_consume_reserved: quantity of an existing reservation being fulfilled.
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
    when p_type in ('OPENING_STOCK', 'RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'CUSTOMER_RETURN') then 1
    when p_type in ('ISSUE', 'TRANSFER_OUT', 'ADJUSTMENT_OUT', 'SUPPLIER_RETURN') then -1
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

-- -----------------------------------------------------------------------------
-- Product guards now that stock exists
-- -----------------------------------------------------------------------------
create or replace function private.product_has_transactions(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.inventory_transactions where product_id = p_product_id)
      or exists (select 1 from public.inventory_batches where product_id = p_product_id);
$$;

create or replace function private.guard_product_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.base_unit is distinct from old.base_unit or new.track_batches is distinct from old.track_batches)
     and private.product_has_transactions(old.id) then
    raise exception 'The unit and batch tracking cannot be changed after stock has been recorded for this product.'
      using errcode = 'P0001';
  end if;
  if new.archived_at is not null and old.archived_at is null
     and exists (select 1 from public.inventory_balances b where b.product_id = old.id and (b.on_hand <> 0 or b.reserved <> 0)) then
    raise exception 'A product that still has stock cannot be archived.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_product_inventory() from public, anon, authenticated;

drop trigger if exists products_guard_inventory on public.products;
create trigger products_guard_inventory before update on public.products
  for each row execute function private.guard_product_inventory();

-- -----------------------------------------------------------------------------
-- RLS: read-only for clients
-- -----------------------------------------------------------------------------
alter table public.inventory_batches enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_transactions enable row level security;

revoke all on table public.inventory_batches, public.inventory_balances, public.inventory_transactions from anon, authenticated;
grant select on public.inventory_batches, public.inventory_balances, public.inventory_transactions to authenticated;
grant all on table public.inventory_batches, public.inventory_balances, public.inventory_transactions to service_role;

drop policy if exists inventory_batches_select on public.inventory_batches;
create policy inventory_batches_select on public.inventory_batches for select to authenticated
  using (private.has_permission(company_id, 'inventory.read') or private.has_permission(company_id, 'inventory_batch.read'));
drop policy if exists inventory_balances_select on public.inventory_balances;
create policy inventory_balances_select on public.inventory_balances for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
drop policy if exists inventory_transactions_select on public.inventory_transactions;
create policy inventory_transactions_select on public.inventory_transactions for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
