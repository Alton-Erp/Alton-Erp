-- =============================================================================
-- Phase 7: sales orders and fulfilment records
--
--   sales_orders          order header; customer name / addresses are snapshots
--   sales_order_lines     product, quantities and the source customer PO line
--   fulfilments           one consignment from one warehouse (pick -> pack ->
--                         dispatch -> delivery)
--   fulfilment_lines      picked / packed / dispatched / delivered quantity per
--                         reservation (lot + location) with the issue transaction
--   delivery_events       delivery history (append-only, manual or system)
--   sales_order_events    order / fulfilment / return history (append-only)
--
-- Stock rules
--   * Allocation = public.stock_reservations rows with reference_type
--     SALES_ORDER_LINE and reference_id = sales order line.
--   * Converting a customer PO moves the PO line's open reservations to the
--     sales order line (release + re-reserve of the same lot in one
--     transaction) so nothing is reserved twice.
--   * Picking and packing record activity only; stock leaves exactly once, at
--     dispatch, as an ISSUE (document_type SALES_ORDER) consuming the
--     reservation.
--   * Once a PO has a (non-cancelled) sales order, the PO module can no longer
--     allocate, dispatch, change matched lines, cancel or revise that PO.
--
-- Quantities per sales order line
--   effective  = ordered - cancelled
--   remaining  = effective - dispatched           (reserved / picked / packed
--                                                  are stages, not fulfilment)
--   unreserved = remaining - open reserved
-- =============================================================================

create table if not exists public.sales_orders (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies (id) on delete restrict,
  sales_order_number         text not null,
  source                     text not null check (source in ('CUSTOMER_PO', 'MANUAL')),
  customer_id                uuid,
  customer_key               text not null,
  customer_name_snapshot     text not null check (length(btrim(customer_name_snapshot)) between 1 and 200),
  customer_purchase_order_id uuid,
  customer_po_number         text check (customer_po_number is null or length(btrim(customer_po_number)) between 1 and 100),
  source_po_reference        text,
  source_filename            text,
  order_date                 date not null,
  requested_delivery_date    date,
  shipping_address_snapshot  text check (shipping_address_snapshot is null or length(shipping_address_snapshot) <= 1000),
  billing_address_snapshot   text check (billing_address_snapshot is null or length(billing_address_snapshot) <= 1000),
  order_status               text not null default 'PENDING_CONFIRMATION' check (order_status in ('DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED',
                               'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED')),
  status_before_hold         text,
  fulfilment_status          text not null default 'NOT_STARTED' check (fulfilment_status in ('NOT_STARTED', 'IN_PROGRESS', 'PARTIALLY_DISPATCHED',
                               'DISPATCHED', 'PARTIALLY_DELIVERED', 'DELIVERED')),
  priority                   text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  warehouse_id               uuid,
  currency                   text check (currency is null or currency ~ '^[A-Z]{3}$'),
  customer_reference         text check (customer_reference is null or length(customer_reference) <= 100),
  internal_notes             text check (internal_notes is null or length(internal_notes) <= 2000),
  hold_reason                text check (hold_reason is null or length(hold_reason) <= 1000),
  cancel_reason              text check (cancel_reason is null or length(cancel_reason) <= 1000),
  created_by                 uuid,
  confirmed_by               uuid,
  confirmed_at               timestamptz,
  cancelled_by               uuid,
  cancelled_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint sales_orders_number_unique unique (company_id, sales_order_number),
  constraint sales_orders_id_company_unique unique (id, company_id),
  constraint sales_orders_source_po check ((source = 'CUSTOMER_PO') = (customer_purchase_order_id is not null)),
  constraint sales_orders_manual_customer check (source <> 'MANUAL' or customer_id is not null),
  constraint sales_orders_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint sales_orders_po_fk foreign key (customer_purchase_order_id, company_id) references public.customer_purchase_orders (id, company_id) on delete restrict,
  constraint sales_orders_wh_fk foreign key (warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict
);

create index if not exists sales_orders_status_idx on public.sales_orders (company_id, order_status);
create index if not exists sales_orders_customer_idx on public.sales_orders (company_id, customer_id);
create index if not exists sales_orders_customer_key_idx on public.sales_orders (company_id, customer_key);
create index if not exists sales_orders_po_idx on public.sales_orders (customer_purchase_order_id);
create index if not exists sales_orders_date_idx on public.sales_orders (company_id, order_date desc);

create table if not exists public.sales_order_lines (
  id                              uuid primary key default gen_random_uuid(),
  company_id                      uuid not null references public.companies (id) on delete restrict,
  sales_order_id                  uuid not null,
  line_no                         integer not null check (line_no > 0),
  customer_purchase_order_line_id uuid,
  product_id                      uuid not null,
  sku_snapshot                    text not null,
  product_name_snapshot           text not null,
  customer_sku_snapshot           text,
  quantity_ordered                numeric(14,3) not null check (quantity_ordered > 0),
  quantity_cancelled              numeric(14,3) not null default 0 check (quantity_cancelled >= 0),
  quantity_dispatched             numeric(14,3) not null default 0 check (quantity_dispatched >= 0),
  quantity_delivered              numeric(14,3) not null default 0 check (quantity_delivered >= 0),
  quantity_returned               numeric(14,3) not null default 0 check (quantity_returned >= 0),
  unit                            text not null check (unit ~ '^[A-Z]{1,10}$'),
  unit_price_snapshot             numeric(14,4) check (unit_price_snapshot is null or unit_price_snapshot >= 0),
  currency                        text check (currency is null or currency ~ '^[A-Z]{3}$'),
  requested_delivery_date         date,
  line_status                     text not null default 'OPEN' check (line_status in ('OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED')),
  backorder_reason                text check (backorder_reason is null or length(backorder_reason) <= 500),
  expected_fulfilment_date        date,
  notes                           text check (notes is null or length(notes) <= 500),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint sales_order_lines_unique unique (sales_order_id, line_no),
  constraint sales_order_lines_id_company_unique unique (id, company_id),
  constraint sales_order_lines_so_fk foreign key (sales_order_id, company_id) references public.sales_orders (id, company_id) on delete restrict,
  constraint sales_order_lines_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint sales_order_lines_po_line_fk foreign key (customer_purchase_order_line_id, company_id)
    references public.customer_purchase_order_lines (id, company_id) on delete restrict,
  constraint sales_order_lines_quantities check (quantity_cancelled + quantity_dispatched <= quantity_ordered
    and quantity_delivered <= quantity_dispatched and quantity_returned <= quantity_dispatched)
);

create index if not exists sales_order_lines_so_idx on public.sales_order_lines (sales_order_id);
create index if not exists sales_order_lines_product_idx on public.sales_order_lines (company_id, product_id);
create index if not exists sales_order_lines_po_line_idx on public.sales_order_lines (customer_purchase_order_line_id);

comment on column public.sales_order_lines.unit_price_snapshot is 'Price from the customer PO (or entered on a manual order); independent of the Product Master selling price. Not revenue.';

create table if not exists public.fulfilments (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  fulfilment_number      text not null,
  sales_order_id         uuid not null,
  warehouse_id           uuid not null,
  fulfilment_status      text not null default 'PENDING' check (fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED',
                           'READY_FOR_DISPATCH', 'DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_EXCEPTION', 'CANCELLED')),
  planned_dispatch_date  date,
  expected_delivery_date date,
  actual_dispatch_at     timestamptz,
  carrier_name           text check (carrier_name is null or length(carrier_name) <= 120),
  transport_mode         text check (transport_mode is null or transport_mode in ('ROAD', 'RAIL', 'AIR', 'SEA', 'COURIER', 'CUSTOMER_PICKUP', 'OTHER')),
  vehicle_number         text check (vehicle_number is null or length(vehicle_number) <= 20),
  lr_number              text check (lr_number is null or length(lr_number) <= 50),
  tracking_number        text check (tracking_number is null or length(tracking_number) <= 100),
  eway_bill_number       text check (eway_bill_number is null or length(eway_bill_number) <= 30),
  delivery_reference     text check (delivery_reference is null or length(delivery_reference) <= 100),
  document_references    text check (document_references is null or length(document_references) <= 500),
  dispatch_notes         text check (dispatch_notes is null or length(dispatch_notes) <= 1000),
  packing_notes          text check (packing_notes is null or length(packing_notes) <= 1000),
  notes                  text check (notes is null or length(notes) <= 1000),
  reopen_reason          text check (reopen_reason is null or length(reopen_reason) <= 500),
  exception_reason       text check (exception_reason is null or length(exception_reason) <= 500),
  cancel_reason          text check (cancel_reason is null or length(cancel_reason) <= 500),
  created_by             uuid,
  picked_at              timestamptz,
  packed_at              timestamptz,
  ready_at               timestamptz,
  dispatched_by          uuid,
  delivered_at           timestamptz,
  cancelled_by           uuid,
  cancelled_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fulfilments_number_unique unique (company_id, fulfilment_number),
  constraint fulfilments_id_company_unique unique (id, company_id),
  constraint fulfilments_so_fk foreign key (sales_order_id, company_id) references public.sales_orders (id, company_id) on delete restrict,
  constraint fulfilments_wh_fk foreign key (warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict,
  -- dispatched states only with a posted dispatch; delivered only with a delivery date
  constraint fulfilments_dispatch_state check ((fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_EXCEPTION'))
                                               = (actual_dispatch_at is not null)),
  constraint fulfilments_delivered_state check (fulfilment_status <> 'DELIVERED' or delivered_at is not null)
);

create index if not exists fulfilments_status_idx on public.fulfilments (company_id, fulfilment_status);
create index if not exists fulfilments_so_idx on public.fulfilments (sales_order_id);
create index if not exists fulfilments_tracking_idx on public.fulfilments (company_id, tracking_number) where tracking_number is not null;
create index if not exists fulfilments_dispatch_idx on public.fulfilments (company_id, actual_dispatch_at desc);

create table if not exists public.fulfilment_lines (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  fulfilment_id        uuid not null,
  line_no              integer not null check (line_no > 0),
  sales_order_line_id  uuid not null,
  product_id           uuid not null,
  reservation_id       uuid not null references public.stock_reservations (id) on delete restrict,
  batch_id             uuid not null,
  location_id          uuid not null,
  quantity_to_pick     numeric(14,3) not null check (quantity_to_pick > 0),
  quantity_picked      numeric(14,3) not null default 0 check (quantity_picked >= 0),
  quantity_packed      numeric(14,3) not null default 0 check (quantity_packed >= 0),
  quantity_damaged     numeric(14,3) not null default 0 check (quantity_damaged >= 0),
  quantity_dispatched  numeric(14,3) not null default 0 check (quantity_dispatched >= 0),
  quantity_delivered   numeric(14,3) not null default 0 check (quantity_delivered >= 0),
  pick_exception       text check (pick_exception is null or length(pick_exception) <= 500),
  pack_exception       text check (pack_exception is null or length(pack_exception) <= 500),
  picked_by            uuid,
  picked_at            timestamptz,
  packed_by            uuid,
  packed_at            timestamptz,
  issue_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fulfilment_lines_unique unique (fulfilment_id, line_no),
  constraint fulfilment_lines_reservation_unique unique (fulfilment_id, reservation_id),
  constraint fulfilment_lines_id_company_unique unique (id, company_id),
  constraint fulfilment_lines_fulfilment_fk foreign key (fulfilment_id, company_id) references public.fulfilments (id, company_id) on delete restrict,
  constraint fulfilment_lines_so_line_fk foreign key (sales_order_line_id, company_id) references public.sales_order_lines (id, company_id) on delete restrict,
  constraint fulfilment_lines_batch_fk foreign key (batch_id, product_id, company_id) references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint fulfilment_lines_quantities check (quantity_picked <= quantity_to_pick and quantity_packed + quantity_damaged <= quantity_picked
    and quantity_dispatched <= quantity_packed and quantity_delivered <= quantity_dispatched)
);

create index if not exists fulfilment_lines_fulfilment_idx on public.fulfilment_lines (fulfilment_id);
create index if not exists fulfilment_lines_so_line_idx on public.fulfilment_lines (sales_order_line_id);
create index if not exists fulfilment_lines_reservation_idx on public.fulfilment_lines (reservation_id);

create table if not exists public.delivery_events (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  fulfilment_id        uuid not null,
  event_type           text not null check (event_type in ('DISPATCHED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED',
                         'DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_SENDER', 'EXCEPTION')),
  event_at             timestamptz not null,
  location             text check (location is null or length(location) <= 200),
  description          text check (description is null or length(description) <= 1000),
  reference_number     text check (reference_number is null or length(reference_number) <= 100),
  failure_reason       text check (failure_reason is null or length(failure_reason) <= 500),
  delivered_quantities jsonb not null default '[]'::jsonb,
  source               text not null default 'MANUAL' check (source in ('MANUAL', 'SYSTEM', 'CARRIER')),
  verified             boolean not null default false,
  recorded_by          uuid,
  created_at           timestamptz not null default now(),
  constraint delivery_events_fulfilment_fk foreign key (fulfilment_id, company_id) references public.fulfilments (id, company_id) on delete restrict
);

comment on column public.delivery_events.source is 'MANUAL: entered by a user. SYSTEM: written by the dispatch posting. CARRIER: reserved for a verified carrier integration (none is configured).';

create index if not exists delivery_events_fulfilment_idx on public.delivery_events (fulfilment_id, event_at);
create index if not exists delivery_events_date_idx on public.delivery_events (company_id, event_at desc);

create table if not exists public.sales_order_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  sales_order_id uuid not null,
  fulfilment_id  uuid,
  return_id      uuid,
  line_id        uuid,
  event_type     text not null,
  from_status    text,
  to_status      text,
  note           text,
  details        jsonb not null default '{}'::jsonb,
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  constraint sales_order_events_so_fk foreign key (sales_order_id, company_id) references public.sales_orders (id, company_id) on delete restrict
);

create index if not exists sales_order_events_so_idx on public.sales_order_events (sales_order_id, created_at);
create index if not exists sales_order_events_date_idx on public.sales_order_events (company_id, created_at desc);

drop trigger if exists sales_order_events_append_only on public.sales_order_events;
create trigger sales_order_events_append_only before update or delete on public.sales_order_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists delivery_events_append_only on public.delivery_events;
create trigger delivery_events_append_only before update or delete on public.delivery_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists sales_orders_set_updated_at on public.sales_orders;
create trigger sales_orders_set_updated_at before update on public.sales_orders for each row execute function private.set_updated_at();
drop trigger if exists sales_order_lines_set_updated_at on public.sales_order_lines;
create trigger sales_order_lines_set_updated_at before update on public.sales_order_lines for each row execute function private.set_updated_at();
drop trigger if exists fulfilments_set_updated_at on public.fulfilments;
create trigger fulfilments_set_updated_at before update on public.fulfilments for each row execute function private.set_updated_at();
drop trigger if exists fulfilment_lines_set_updated_at on public.fulfilment_lines;
create trigger fulfilment_lines_set_updated_at before update on public.fulfilment_lines for each row execute function private.set_updated_at();

-- RLS: read only for clients; all changes through RPCs.
do $$
declare
  t text;
begin
  foreach t in array array['sales_orders', 'sales_order_lines', 'sales_order_events', 'fulfilments', 'fulfilment_lines', 'delivery_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'sales_orders.read', 'fulfilment.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Quantity helpers
-- -----------------------------------------------------------------------------
create or replace function private.so_line_open_reserved(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0)
  from public.stock_reservations
  where reference_type = 'SALES_ORDER_LINE' and reference_id = p_line and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED');
$$;

-- Quantity of a line / reservation held by fulfilments that are not yet dispatched.
create or replace function private.so_line_planned(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(fl.quantity_to_pick), 0)
  from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
  where fl.sales_order_line_id = p_line and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH');
$$;

create or replace function private.reservation_planned(p_reservation uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(fl.quantity_to_pick), 0)
  from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
  where fl.reservation_id = p_reservation and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH');
$$;

-- PO line quantity handed to sales orders (ordered - cancelled), and dispatched through them.
create or replace function private.po_line_converted(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity_ordered - quantity_cancelled), 0) from public.sales_order_lines where customer_purchase_order_line_id = p_line;
$$;

create or replace function private.po_line_so_dispatched(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity_dispatched), 0) from public.sales_order_lines where customer_purchase_order_line_id = p_line;
$$;

-- Sales orders (not cancelled) created from a PO, or NULL.
create or replace function private.po_active_sales_orders(p_po uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select string_agg(sales_order_number, ', ' order by sales_order_number)
  from public.sales_orders where customer_purchase_order_id = p_po and order_status <> 'CANCELLED';
$$;

-- Phase 6 "allocated" for a PO line now also counts stock reserved for the
-- sales order lines created from it (so PO status and analysis stay true).
create or replace function private.po_line_open_reserved(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(r.quantity - r.fulfilled_quantity - r.released_quantity), 0)
  from public.stock_reservations r
  where r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    and ((r.reference_type = 'CUSTOMER_PO' and r.reference_id = p_line)
      or (r.reference_type = 'SALES_ORDER_LINE' and r.reference_id in (select l.id from public.sales_order_lines l where l.customer_purchase_order_line_id = p_line)));
$$;

-- Eligible available stock for a line's product (caller's company only; used by views).
create or replace function private.so_line_available_now(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(s.available), 0)
  from public.sales_order_lines l
  join public.sales_orders so on so.id = l.sales_order_id
  cross join lateral private.po_eligible_stock(l.company_id, l.product_id, so.warehouse_id) s
  where l.id = p_line and l.company_id = private.current_company_id() and s.eligible;
$$;

create or replace function private.so_today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.company_today(private.current_company_id());
$$;

-- Quantity helpers are called by the security-invoker views (like Phase 6's
-- po_line_open_reserved); they return quantities for an unguessable id only.
revoke all on function private.so_line_open_reserved(uuid) from public, anon;
revoke all on function private.so_line_planned(uuid) from public, anon;
revoke all on function private.reservation_planned(uuid) from public, anon;
revoke all on function private.so_line_available_now(uuid) from public, anon;
revoke all on function private.so_today() from public, anon;
grant execute on function private.so_line_open_reserved(uuid), private.so_line_planned(uuid), private.reservation_planned(uuid),
  private.so_line_available_now(uuid), private.so_today() to authenticated;
revoke all on function private.po_line_converted(uuid) from public, anon, authenticated;
revoke all on function private.po_line_so_dispatched(uuid) from public, anon, authenticated;
revoke all on function private.po_active_sales_orders(uuid) from public, anon, authenticated;
revoke all on function private.po_line_open_reserved(uuid) from public, anon;
grant execute on function private.po_line_open_reserved(uuid) to authenticated;

-- Releases part of a reservation (all of it when p_qty >= remaining).
create or replace function private.release_reservation_qty(p_reservation public.stock_reservations, p_qty numeric, p_status text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining numeric := p_reservation.quantity - p_reservation.fulfilled_quantity - p_reservation.released_quantity;
begin
  if p_qty is null or p_qty <= 0 or v_remaining <= 0 then
    return 0;
  end if;
  if p_qty >= v_remaining then
    return private.release_reservation_remaining(p_reservation, p_status);
  end if;
  perform 1 from public.inventory_balances where batch_id = p_reservation.batch_id and location_id = p_reservation.location_id for update;
  update public.inventory_balances set reserved = reserved - p_qty, updated_at = now()
  where batch_id = p_reservation.batch_id and location_id = p_reservation.location_id;
  update public.stock_reservations set released_quantity = released_quantity + p_qty, released_by = auth.uid(), released_at = now(), updated_at = now()
  where id = p_reservation.id;
  return p_qty;
end;
$$;

revoke all on function private.release_reservation_qty(public.stock_reservations, numeric, text) from public, anon, authenticated;

create or replace function private.log_so_event(
  p_company uuid, p_so uuid, p_fulfilment uuid, p_return uuid, p_line uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.sales_order_events (company_id, sales_order_id, fulfilment_id, return_id, line_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_so, p_fulfilment, p_return, p_line, p_event, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_company, 'sales_order.' || lower(p_event), 'sales_order', p_so::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('fulfilment_id', p_fulfilment, 'return_id', p_return, 'line_id', p_line,
      'from_status', p_from, 'to_status', p_to, 'note', p_note));
end;
$$;

revoke all on function private.log_so_event(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- Recalculates line statuses, the order status (after confirmation) and the
-- order-level fulfilment status from actual records.
create or replace function private.so_recompute(p_so uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so       public.sales_orders;
  v          record;
  v_open_ful boolean;
  v_new      text;
  v_ful      text;
begin
  select * into v_so from public.sales_orders where id = p_so for update;

  update public.sales_order_lines l set line_status = x.s
  from (
    select id, case
      when quantity_ordered - quantity_cancelled = 0 then 'CANCELLED'
      when quantity_dispatched >= quantity_ordered - quantity_cancelled then 'FULFILLED'
      when quantity_dispatched > 0 then 'PARTIALLY_FULFILLED'
      else 'OPEN' end as s
    from public.sales_order_lines where sales_order_id = p_so
  ) x
  where l.id = x.id and l.line_status <> x.s;

  select
    count(*) filter (where eff > 0) as active,
    count(*) filter (where eff > 0 and disp < eff) as not_dispatched,
    count(*) filter (where disp > 0) as any_disp,
    count(*) filter (where eff > 0 and disp + res < eff) as not_covered,
    count(*) filter (where res > 0) as any_res,
    count(*) filter (where eff > 0 and delv < eff) as not_delivered,
    count(*) filter (where delv > 0) as any_delv
  into v
  from (select quantity_ordered - quantity_cancelled as eff, quantity_dispatched as disp, quantity_delivered as delv,
               private.so_line_open_reserved(id) as res
        from public.sales_order_lines where sales_order_id = p_so) x;
  v_open_ful := exists (select 1 from public.fulfilments where sales_order_id = p_so
                        and fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH'));

  v_ful := case
    when v.active > 0 and v.not_delivered = 0 then 'DELIVERED'
    when v.any_delv > 0 then 'PARTIALLY_DELIVERED'
    when v.active > 0 and v.not_dispatched = 0 then 'DISPATCHED'
    when v.any_disp > 0 then 'PARTIALLY_DISPATCHED'
    when v_open_ful then 'IN_PROGRESS'
    else 'NOT_STARTED' end;

  if v_so.order_status in ('DRAFT', 'PENDING_CONFIRMATION', 'ON_HOLD', 'CANCELLED') then
    v_new := v_so.order_status;
  else
    v_new := case
      when v.active = 0 then 'CANCELLED'
      when v.not_dispatched = 0 then 'FULFILLED'
      when v.any_disp > 0 then 'PARTIALLY_FULFILLED'
      when v_open_ful then 'IN_FULFILMENT'
      when v.not_covered = 0 then 'READY_FOR_FULFILMENT'
      when v.any_res > 0 then 'PARTIALLY_ALLOCATED'
      else 'CONFIRMED' end;
  end if;

  if v_new is distinct from v_so.order_status or v_ful is distinct from v_so.fulfilment_status then
    update public.sales_orders set order_status = v_new, fulfilment_status = v_ful where id = p_so;
  end if;
  if v_new is distinct from v_so.order_status then
    perform private.log_so_event(v_so.company_id, p_so, null, null, null, 'STATUS_CHANGED', v_so.order_status, v_new, null);
  end if;
  if v_so.customer_purchase_order_id is not null then
    perform private.po_recompute_status(v_so.customer_purchase_order_id);
  end if;
  return v_new;
end;
$$;

revoke all on function private.so_recompute(uuid) from public, anon, authenticated;

-- Statuses in which an order can be allocated and fulfilled.
create or replace function private.so_assert_workable(p_so public.sales_orders, p_action text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_so.order_status not in ('CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED') then
    raise exception 'Cannot % while sales order % is %.', p_action, p_so.sales_order_number,
      case p_so.order_status when 'PENDING_CONFIRMATION' then 'awaiting confirmation' else replace(lower(p_so.order_status), '_', ' ') end
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.so_assert_workable(public.sales_orders, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Phase 6 guards once a PO is fulfilled through sales orders
-- -----------------------------------------------------------------------------
create or replace function private.guard_po_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po  uuid;
  v_sos text;
begin
  if upper(new.reference_type) = 'CUSTOMER_PO' and coalesce(current_setting('app.so_transfer', true), '') <> 'on' then
    select purchase_order_id into v_po from public.customer_purchase_order_lines where id = new.reference_id;
    v_sos := private.po_active_sales_orders(v_po);
    if v_sos is not null then
      raise exception 'This customer PO is being fulfilled through sales order %. Allocate stock from the sales order.', v_sos using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_reservations_guard_po on public.stock_reservations;
create trigger stock_reservations_guard_po before insert on public.stock_reservations
  for each row execute function private.guard_po_reservation();

create or replace function private.guard_po_dispatch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sos text;
begin
  if new.document_type = 'CUSTOMER_PO' and new.transaction_type = 'ISSUE' then
    v_sos := private.po_active_sales_orders(new.document_id);
    if v_sos is not null then
      raise exception 'This customer PO is being fulfilled through sales order %. Dispatch from the sales order.', v_sos using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_transactions_guard_po on public.inventory_transactions;
create trigger inventory_transactions_guard_po before insert on public.inventory_transactions
  for each row execute function private.guard_po_dispatch();

create or replace function private.guard_po_line_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sos text;
begin
  if (new.product_id, new.quantity_ordered, new.unit, new.line_status) is distinct from (old.product_id, old.quantity_ordered, old.unit, old.line_status) then
    select string_agg(distinct so.sales_order_number, ', ') into v_sos
    from public.sales_order_lines l join public.sales_orders so on so.id = l.sales_order_id
    where l.customer_purchase_order_line_id = old.id and so.order_status <> 'CANCELLED';
    if v_sos is not null then
      raise exception 'PO line % is part of sales order %. Change the sales order (or cancel it) instead of the PO line.', old.line_no, v_sos using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_po_lines_guard_so on public.customer_purchase_order_lines;
create trigger customer_po_lines_guard_so before update on public.customer_purchase_order_lines
  for each row execute function private.guard_po_line_change();

create or replace function private.guard_po_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sos text;
begin
  if (new.status = 'CANCELLED' and old.status <> 'CANCELLED') or (old.is_current and not new.is_current) then
    v_sos := private.po_active_sales_orders(old.id);
    if v_sos is not null then
      raise exception 'Customer PO % has sales order %. Cancel or complete the sales order before % the PO.', old.customer_po_number, v_sos,
        case when new.status = 'CANCELLED' then 'cancelling' else 'revising' end using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_pos_guard_so on public.customer_purchase_orders;
create trigger customer_pos_guard_so before update on public.customer_purchase_orders
  for each row execute function private.guard_po_change();

revoke all on function private.guard_po_reservation() from public, anon, authenticated;
revoke all on function private.guard_po_dispatch() from public, anon, authenticated;
revoke all on function private.guard_po_line_change() from public, anon, authenticated;
revoke all on function private.guard_po_change() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Header validation shared by PO conversion and manual orders
-- -----------------------------------------------------------------------------
create or replace function private.so_header_value(p_header jsonb, p_key text, p_max int)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_header ->> p_key, '')), '');
begin
  if v is not null and length(v) > p_max then
    raise exception '% is too long (maximum % characters).', replace(p_key, '_', ' '), p_max using errcode = 'P0001';
  end if;
  return v;
end;
$$;

create or replace function private.so_header_date(p_header jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(btrim(coalesce(p_header ->> p_key, '')), '')::date;
exception when others then
  raise exception 'Enter a valid % (YYYY-MM-DD).', replace(p_key, '_', ' ') using errcode = 'P0001';
end;
$$;

create or replace function private.so_check_warehouse(p_company uuid, p_warehouse uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_warehouse is not null and not exists (select 1 from public.warehouses where id = p_warehouse and company_id = p_company and status = 'ACTIVE') then
    raise exception 'Choose an active warehouse of your company.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.so_header_value(jsonb, text, int) from public, anon, authenticated;
revoke all on function private.so_header_date(jsonb, text) from public, anon, authenticated;
revoke all on function private.so_check_warehouse(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Conversion from a customer PO
-- -----------------------------------------------------------------------------
-- Per matched PO line: quantity still available to convert and stock the PO holds.
create or replace function private.po_conversion_lines(p_po uuid)
returns table (
  po_line_id uuid, line_no int, product_id uuid, sku text, product_name text, product_status text, base_unit text, unit text,
  line_status text, quantity_ordered numeric, dispatched_by_po numeric, converted numeric, convertible numeric, po_reserved numeric,
  unit_price numeric, currency text, uploaded_customer_sku text
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.line_no, l.product_id, p.sku, p.product_name, p.status, p.base_unit, l.unit, l.line_status, l.quantity_ordered,
    l.quantity_dispatched - private.po_line_so_dispatched(l.id),
    private.po_line_converted(l.id),
    greatest(l.quantity_ordered - (l.quantity_dispatched - private.po_line_so_dispatched(l.id)) - private.po_line_converted(l.id), 0),
    (select coalesce(sum(r.quantity - r.fulfilled_quantity - r.released_quantity), 0) from public.stock_reservations r
      where r.reference_type = 'CUSTOMER_PO' and r.reference_id = l.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')),
    l.unit_price, l.currency, l.uploaded_customer_sku
  from public.customer_purchase_order_lines l
  left join public.products p on p.id = l.product_id
  where l.purchase_order_id = p_po and l.line_status <> 'EXCLUDED'
  order by l.line_no;
$$;

revoke all on function private.po_conversion_lines(uuid) from public, anon, authenticated;

-- Problems that prevent converting a PO (empty array = OK).
create or replace function private.po_conversion_blockers(p_po public.customer_purchase_orders)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_issues jsonb := '[]'::jsonb;
  v        record;
begin
  if not p_po.is_current then
    v_issues := v_issues || to_jsonb('This PO revision has been superseded; convert the current revision.'::text);
  end if;
  if p_po.status in ('UPLOADED', 'DRAFT', 'VALIDATION_REQUIRED', 'PRODUCT_MATCHING_REQUIRED') then
    v_issues := v_issues || to_jsonb('Every PO line must be matched to a product and valid before conversion (PO is ' || replace(lower(p_po.status), '_', ' ') || ').');
  elsif p_po.status in ('ON_HOLD', 'CANCELLED', 'FULFILLED') then
    v_issues := v_issues || to_jsonb('A ' || replace(lower(p_po.status), '_', ' ') || ' PO cannot be converted.');
  end if;
  for v in select * from private.po_conversion_lines(p_po.id) loop
    if v.line_status <> 'MATCHED' then
      v_issues := v_issues || to_jsonb(format('Line %s is %s.', v.line_no, replace(lower(v.line_status), '_', ' ')));
    elsif v.product_status <> 'ACTIVE' then
      v_issues := v_issues || to_jsonb(format('Line %s: product %s is not active.', v.line_no, v.sku));
    elsif v.unit <> v.base_unit then
      v_issues := v_issues || to_jsonb(format('Line %s: unit %s differs from the product unit %s (no unit conversion).', v.line_no, v.unit, v.base_unit));
    end if;
  end loop;
  return v_issues;
end;
$$;

revoke all on function private.po_conversion_blockers(public.customer_purchase_orders) from public, anon, authenticated;

-- POs that can still be converted (current, matched, with quantity left).
create or replace function public.sales_order_po_candidates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.create');
begin
  perform private.require_permission('customer_po.read');
  return coalesce((
    select jsonb_agg(x order by x.po_date desc, x.po_reference desc) from (
      select po.id as po_id, po.po_reference, po.customer_po_number, po.revision, po.customer_name_snapshot as customer_name, po.po_date,
        po.required_delivery_date, po.status, private.po_active_sales_orders(po.id) as sales_orders,
        (select coalesce(sum(c.convertible), 0) from private.po_conversion_lines(po.id) c where c.line_status = 'MATCHED') as convertible_quantity
      from public.customer_purchase_orders po
      where po.company_id = v_company and po.is_current
        and po.status in ('READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED', 'PARTIALLY_FULFILLED')
    ) x where x.convertible_quantity > 0), '[]'::jsonb);
end;
$$;

-- Review data for the conversion screen: identity, lines, stock already reserved, blockers.
create or replace function public.sales_order_po_preview(p_po_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.create');
  v_po      public.customer_purchase_orders;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'po', jsonb_build_object('po_id', v_po.id, 'po_reference', v_po.po_reference, 'customer_po_number', v_po.customer_po_number, 'revision', v_po.revision,
      'customer_id', v_po.customer_id, 'customer_name', v_po.customer_name_snapshot, 'customer_code', (select customer_code from public.customers where id = v_po.customer_id),
      'po_date', v_po.po_date, 'required_delivery_date', v_po.required_delivery_date, 'currency', v_po.currency, 'status', v_po.status,
      'fulfilment_warehouse_id', v_po.fulfilment_warehouse_id, 'source_filename', v_po.source_filename, 'is_current', v_po.is_current),
    'existing_sales_orders', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'sales_order_number', sales_order_number, 'order_status', order_status) order by sales_order_number)
      from public.sales_orders where customer_purchase_order_id = v_po.id), '[]'::jsonb),
    'blockers', private.po_conversion_blockers(v_po),
    'lines', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('reservations', coalesce((
        select jsonb_agg(jsonb_build_object('reservation_number', r.reservation_number, 'remaining', r.quantity - r.fulfilled_quantity - r.released_quantity,
          'warehouse_code', w.warehouse_code, 'location_code', loc.location_code, 'batch_number', bt.batch_number, 'source_type', bt.source_type) order by r.reserved_at)
        from public.stock_reservations r
        join public.warehouses w on w.id = r.warehouse_id
        join public.inventory_locations loc on loc.id = r.location_id
        join public.inventory_batches bt on bt.id = r.batch_id
        where r.reference_type = 'CUSTOMER_PO' and r.reference_id = c.po_line_id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), '[]'::jsonb))
      order by c.line_no) from private.po_conversion_lines(v_po.id) c), '[]'::jsonb));
end;
$$;

-- Moves up to p_qty of a PO line's open reservations to a sales order line
-- (same lot and location; release and re-reserve inside this transaction).
create or replace function private.so_take_po_reservations(p_company uuid, p_po_line uuid, p_so_line uuid, p_qty numeric, p_so_number text, p_po_number text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res   public.stock_reservations;
  v_rem   numeric;
  v_take  numeric;
  v_left  numeric := p_qty;
  v_total numeric := 0;
  v_bal   uuid;
begin
  for v_res in
    select * from public.stock_reservations
    where company_id = p_company and reference_type = 'CUSTOMER_PO' and reference_id = p_po_line and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    order by reserved_at, reservation_number
    for update
  loop
    exit when v_left <= 0;
    v_rem := v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity;
    continue when v_rem <= 0;
    v_take := least(v_rem, v_left);
    select id into v_bal from public.inventory_balances where batch_id = v_res.batch_id and location_id = v_res.location_id;
    perform private.release_reservation_remaining(v_res, 'RELEASED');
    update public.stock_reservations
    set notes = left(coalesce(notes || E'\n', '') || format('Transferred %s to sales order %s', v_take, p_so_number), 2000)
    where id = v_res.id;
    perform private.reserve_balance(p_company, v_bal, v_take, 'SALES_ORDER_LINE', p_so_number, p_so_line,
      format('Transferred from %s (customer PO %s)', v_res.reservation_number, p_po_number));
    if v_rem > v_take then
      perform set_config('app.so_transfer', 'on', true);
      perform private.reserve_balance(p_company, v_bal, v_rem - v_take, 'CUSTOMER_PO', p_po_number, p_po_line,
        format('Remainder of %s after transfer to sales order %s', v_res.reservation_number, p_so_number));
      perform set_config('app.so_transfer', 'off', true);
    end if;
    v_left := v_left - v_take;
    v_total := v_total + v_take;
  end loop;
  return v_total;
end;
$$;

revoke all on function private.so_take_po_reservations(uuid, uuid, uuid, numeric, text, text) from public, anon, authenticated;

-- Confirms an order (PENDING_CONFIRMATION -> status from its records).
create or replace function private.so_confirm(p_so uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so   public.sales_orders;
  v_bad  text;
  v_new  text;
begin
  select * into v_so from public.sales_orders where id = p_so for update;
  if v_so.order_status not in ('PENDING_CONFIRMATION', 'DRAFT') then
    raise exception 'Sales order % is already %.', v_so.sales_order_number, replace(lower(v_so.order_status), '_', ' ') using errcode = 'P0001';
  end if;
  select string_agg(format('line %s (%s)', l.line_no, l.sku_snapshot), ', ') into v_bad
  from public.sales_order_lines l join public.products p on p.id = l.product_id
  where l.sales_order_id = p_so and l.quantity_ordered > l.quantity_cancelled and (p.status <> 'ACTIVE' or p.archived_at is not null or p.base_unit <> l.unit);
  if v_bad is not null then
    raise exception 'Cannot confirm: % no longer match an active product in its unit.', v_bad using errcode = 'P0001';
  end if;
  update public.sales_orders set order_status = 'CONFIRMED', confirmed_by = auth.uid(), confirmed_at = now() where id = p_so;
  perform private.log_so_event(v_so.company_id, p_so, null, null, null, 'CONFIRMED', v_so.order_status, 'CONFIRMED', p_note);
  v_new := private.so_recompute(p_so);
  return v_new;
end;
$$;

revoke all on function private.so_confirm(uuid, text) from public, anon, authenticated;

-- p_header: {requested_delivery_date, shipping_address, billing_address, customer_reference, priority, warehouse_id, internal_notes}
-- p_lines:  [{po_line_id, quantity}] or null for every line's convertible quantity
create or replace function public.sales_order_create_from_po(
  p_po_id           uuid,
  p_header          jsonb default '{}'::jsonb,
  p_lines           jsonb default null,
  p_split           boolean default false,
  p_confirm         boolean default false,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('sales_orders.create');
  v_previous  jsonb;
  v_po        public.customer_purchase_orders;
  v_header    jsonb := coalesce(p_header, '{}'::jsonb);
  v_blockers  jsonb;
  v_existing  text;
  v_so        public.sales_orders;
  v_line      record;
  v_qty       numeric;
  v_line_no   int := 0;
  v_so_line   uuid;
  v_moved     numeric := 0;
  v_status    text;
  v_wh        uuid;
  v_priority  text := coalesce(nullif(btrim(coalesce(p_header ->> 'priority', '')), ''), 'NORMAL');
begin
  if coalesce(p_confirm, false) then
    perform private.require_permission('sales_orders.confirm');
  end if;
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_create_from_po');
  if v_previous is not null then return v_previous; end if;

  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  v_blockers := private.po_conversion_blockers(v_po);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'PO % cannot be converted: %', v_po.customer_po_number,
      (select string_agg(b, ' ') from jsonb_array_elements_text(v_blockers) b) using errcode = 'P0001';
  end if;
  v_existing := private.po_active_sales_orders(v_po.id);
  if v_existing is not null and not coalesce(p_split, false) then
    raise exception 'PO % already has sales order %. To create a separate delivery order for the remaining quantity, confirm it as a split order.',
      v_po.customer_po_number, v_existing using errcode = 'P0001';
  end if;
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Unknown priority %.', v_priority using errcode = 'P0001';
  end if;
  v_wh := coalesce(nullif(v_header ->> 'warehouse_id', '')::uuid, v_po.fulfilment_warehouse_id);
  perform private.so_check_warehouse(v_company, v_wh);
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0) then
    raise exception 'Select at least one PO line to convert.' using errcode = 'P0001';
  end if;
  if p_lines is not null and exists (
    select 1 from jsonb_array_elements(p_lines) e
    where not exists (select 1 from public.customer_purchase_order_lines l where l.id = (e ->> 'po_line_id')::uuid and l.purchase_order_id = v_po.id)
  ) then
    raise exception 'A selected line does not belong to this PO.' using errcode = 'P0001';
  end if;

  insert into public.sales_orders (company_id, sales_order_number, source, customer_id, customer_key, customer_name_snapshot, customer_purchase_order_id,
    customer_po_number, source_po_reference, source_filename, order_date, requested_delivery_date, shipping_address_snapshot, billing_address_snapshot,
    priority, warehouse_id, currency, customer_reference, internal_notes, created_by)
  values (v_company, private.next_document_number(v_company, 'SO'), 'CUSTOMER_PO', v_po.customer_id, v_po.customer_key, v_po.customer_name_snapshot, v_po.id,
    v_po.customer_po_number, v_po.po_reference, v_po.source_filename, private.company_today(v_company),
    coalesce(private.so_header_date(v_header, 'requested_delivery_date'), v_po.required_delivery_date),
    private.so_header_value(v_header, 'shipping_address', 1000), private.so_header_value(v_header, 'billing_address', 1000),
    v_priority, v_wh, v_po.currency, private.so_header_value(v_header, 'customer_reference', 100), private.so_header_value(v_header, 'internal_notes', 2000), auth.uid())
  returning * into v_so;

  for v_line in select * from private.po_conversion_lines(v_po.id) where line_status = 'MATCHED' loop
    if p_lines is null then
      v_qty := v_line.convertible;
    else
      begin
        select sum((e ->> 'quantity')::numeric) into v_qty from jsonb_array_elements(p_lines) e where (e ->> 'po_line_id')::uuid = v_line.po_line_id;
      exception when others then
        raise exception 'Quantities must be numbers.' using errcode = 'P0001';
      end;
    end if;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty > v_line.convertible then
      raise exception 'Line % (%): convert between 0 and % % (ordered %, already dispatched or on sales orders %).', v_line.line_no, v_line.sku,
        v_line.convertible, v_line.unit, v_line.quantity_ordered, v_line.quantity_ordered - v_line.convertible using errcode = 'P0001';
    end if;
    v_line_no := v_line_no + 1;
    insert into public.sales_order_lines (company_id, sales_order_id, line_no, customer_purchase_order_line_id, product_id, sku_snapshot, product_name_snapshot,
      customer_sku_snapshot, quantity_ordered, unit, unit_price_snapshot, currency, requested_delivery_date)
    values (v_company, v_so.id, v_line_no, v_line.po_line_id, v_line.product_id, v_line.sku, v_line.product_name, v_line.uploaded_customer_sku,
      v_qty, v_line.unit, v_line.unit_price, coalesce(v_line.currency, v_po.currency), v_so.requested_delivery_date)
    returning id into v_so_line;
    v_moved := v_moved + private.so_take_po_reservations(v_company, v_line.po_line_id, v_so_line, v_qty, v_so.sales_order_number, v_po.customer_po_number);
  end loop;
  if v_line_no = 0 then
    raise exception 'Nothing to convert: every line of PO % is already dispatched or on a sales order.', v_po.customer_po_number using errcode = 'P0001';
  end if;

  perform private.log_so_event(v_company, v_so.id, null, null, null, 'CREATED_FROM_PO', null, 'PENDING_CONFIRMATION', null,
    jsonb_build_object('po_id', v_po.id, 'po_reference', v_po.po_reference, 'customer_po_number', v_po.customer_po_number, 'revision', v_po.revision,
      'source_filename', v_po.source_filename, 'lines', v_line_no, 'transferred_reserved', v_moved, 'split', v_existing is not null));
  perform private.log_po_event(v_company, v_po.id, null, 'CONVERTED_TO_SALES_ORDER', v_po.status, v_po.status, null,
    jsonb_build_object('sales_order_number', v_so.sales_order_number, 'lines', v_line_no, 'transferred_reserved', v_moved));

  v_status := 'PENDING_CONFIRMATION';
  if coalesce(p_confirm, false) then
    v_status := private.so_confirm(v_so.id, null);
  else
    perform private.so_recompute(v_so.id);
  end if;

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'sales_order_id', v_so.id, 'sales_order_number', v_so.sales_order_number, 'status', v_status, 'lines', v_line_no, 'transferred_reserved', v_moved));
end;
$$;

-- Manual order (authorised users only): an existing customer and Product Master lines.
-- p_header: {customer_id, customer_po_number, order_date, requested_delivery_date, shipping_address, billing_address,
--            customer_reference, priority, warehouse_id, currency, internal_notes}
-- p_lines:  [{product_id, quantity, unit_price, requested_delivery_date, notes}]
create or replace function public.sales_order_create_manual(p_header jsonb, p_lines jsonb, p_confirm boolean default false, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('sales_orders.create');
  v_previous jsonb;
  v_customer public.customers;
  v_so       public.sales_orders;
  v_entry    jsonb;
  v_product  public.products;
  v_qty      numeric;
  v_price    numeric;
  v_no       int := 0;
  v_status   text;
  v_po_no    text := private.so_header_value(p_header, 'customer_po_number', 100);
  v_date     date := coalesce(private.so_header_date(p_header, 'order_date'), private.company_today(v_company));
  v_req      date := private.so_header_date(p_header, 'requested_delivery_date');
  v_priority text := coalesce(nullif(btrim(coalesce(p_header ->> 'priority', '')), ''), 'NORMAL');
  v_currency text := upper(private.so_header_value(p_header, 'currency', 3));
  v_dup      text;
begin
  if coalesce(p_confirm, false) then
    perform private.require_permission('sales_orders.confirm');
  end if;
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_create_manual');
  if v_previous is not null then return v_previous; end if;

  select * into v_customer from public.customers where id = nullif(p_header ->> 'customer_id', '')::uuid and company_id = v_company;
  if not found then
    raise exception 'Choose a customer of your company (create it in Customers first).' using errcode = 'P0001';
  end if;
  if v_customer.status <> 'ACTIVE' then
    raise exception 'Customer % is inactive.', v_customer.customer_code using errcode = 'P0001';
  end if;
  if v_date > private.company_today(v_company) then
    raise exception 'The order date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_req is not null and v_req < v_date then
    raise exception 'The requested delivery date cannot be before the order date.' using errcode = 'P0001';
  end if;
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Unknown priority %.', v_priority using errcode = 'P0001';
  end if;
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a 3-letter code.' using errcode = 'P0001';
  end if;
  perform private.so_check_warehouse(v_company, nullif(p_header ->> 'warehouse_id', '')::uuid);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 500 then
    raise exception 'Add between 1 and 500 product lines.' using errcode = 'P0001';
  end if;

  -- The same customer PO number must not be entered twice (or bypass its imported PO).
  if v_po_no is not null then
    if exists (select 1 from public.customer_purchase_orders where company_id = v_company and is_current and status <> 'CANCELLED'
               and lower(customer_po_number) = lower(v_po_no)
               and (customer_key = private.po_customer_key(v_customer.id, null) or customer_key = private.po_customer_key(null, v_customer.customer_name))) then
      raise exception 'Customer PO % has been imported. Create the sales order from the imported PO instead.', v_po_no using errcode = 'P0001';
    end if;
    select string_agg(sales_order_number, ', ') into v_dup from public.sales_orders
    where company_id = v_company and customer_key = private.po_customer_key(v_customer.id, null) and lower(customer_po_number) = lower(v_po_no)
      and order_status <> 'CANCELLED';
    if v_dup is not null then
      raise exception 'Sales order % already exists for customer PO %.', v_dup, v_po_no using errcode = 'P0001';
    end if;
  end if;

  insert into public.sales_orders (company_id, sales_order_number, source, customer_id, customer_key, customer_name_snapshot, customer_po_number,
    order_date, requested_delivery_date, shipping_address_snapshot, billing_address_snapshot, priority, warehouse_id, currency, customer_reference,
    internal_notes, created_by)
  values (v_company, private.next_document_number(v_company, 'SO'), 'MANUAL', v_customer.id, private.po_customer_key(v_customer.id, null), v_customer.customer_name,
    v_po_no, v_date, v_req, private.so_header_value(p_header, 'shipping_address', 1000), private.so_header_value(p_header, 'billing_address', 1000),
    v_priority, nullif(p_header ->> 'warehouse_id', '')::uuid, v_currency, private.so_header_value(p_header, 'customer_reference', 100),
    private.so_header_value(p_header, 'internal_notes', 2000), auth.uid())
  returning * into v_so;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    select * into v_product from public.products where id = nullif(v_entry ->> 'product_id', '')::uuid and company_id = v_company and archived_at is null;
    if not found or v_product.status <> 'ACTIVE' then
      raise exception 'Line %: choose an active product of your company.', v_no using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_entry ->> 'quantity')::numeric;
      v_price := nullif(v_entry ->> 'unit_price', '')::numeric;
    exception when others then
      raise exception 'Line %: quantity and price must be numbers.', v_no using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Line % (%): quantity must be greater than zero (up to 3 decimals).', v_no, v_product.sku using errcode = 'P0001';
    end if;
    if v_price is not null and v_price < 0 then
      raise exception 'Line % (%): price cannot be negative.', v_no, v_product.sku using errcode = 'P0001';
    end if;
    insert into public.sales_order_lines (company_id, sales_order_id, line_no, product_id, sku_snapshot, product_name_snapshot, quantity_ordered, unit,
      unit_price_snapshot, currency, requested_delivery_date, notes)
    values (v_company, v_so.id, v_no, v_product.id, v_product.sku, v_product.product_name, v_qty, v_product.base_unit, v_price, v_currency,
      coalesce(private.so_header_date(v_entry, 'requested_delivery_date'), v_req), private.so_header_value(v_entry, 'notes', 500));
  end loop;

  perform private.log_so_event(v_company, v_so.id, null, null, null, 'CREATED_MANUALLY', null, 'PENDING_CONFIRMATION', null, jsonb_build_object('lines', v_no));
  v_status := 'PENDING_CONFIRMATION';
  if coalesce(p_confirm, false) then
    v_status := private.so_confirm(v_so.id, null);
  end if;
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'sales_order_id', v_so.id, 'sales_order_number', v_so.sales_order_number, 'status', v_status, 'lines', v_no));
end;
$$;

create or replace function public.sales_order_confirm(p_so_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.confirm');
begin
  if not exists (select 1 from public.sales_orders where id = p_so_id and company_id = v_company) then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('status', private.so_confirm(p_so_id, p_note));
end;
$$;

-- p_changes: any of {requested_delivery_date, shipping_address, billing_address, customer_reference, priority, warehouse_id, internal_notes}
create or replace function public.sales_order_update(p_so_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.update');
  v_so      public.sales_orders;
  v_c       jsonb := coalesce(p_changes, '{}'::jsonb);
  v_prio    text;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if v_so.order_status in ('CANCELLED', 'FULFILLED') then
    raise exception 'A % sales order cannot be edited.', lower(v_so.order_status) using errcode = 'P0001';
  end if;
  v_prio := coalesce(nullif(btrim(coalesce(v_c ->> 'priority', '')), ''), v_so.priority);
  if v_prio not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Unknown priority %.', v_prio using errcode = 'P0001';
  end if;
  if v_c ? 'warehouse_id' then
    perform private.so_check_warehouse(v_company, nullif(v_c ->> 'warehouse_id', '')::uuid);
  end if;
  update public.sales_orders set
    requested_delivery_date = case when v_c ? 'requested_delivery_date' then private.so_header_date(v_c, 'requested_delivery_date') else requested_delivery_date end,
    shipping_address_snapshot = case when v_c ? 'shipping_address' then private.so_header_value(v_c, 'shipping_address', 1000) else shipping_address_snapshot end,
    billing_address_snapshot = case when v_c ? 'billing_address' then private.so_header_value(v_c, 'billing_address', 1000) else billing_address_snapshot end,
    customer_reference = case when v_c ? 'customer_reference' then private.so_header_value(v_c, 'customer_reference', 100) else customer_reference end,
    internal_notes = case when v_c ? 'internal_notes' then private.so_header_value(v_c, 'internal_notes', 2000) else internal_notes end,
    warehouse_id = case when v_c ? 'warehouse_id' then nullif(v_c ->> 'warehouse_id', '')::uuid else warehouse_id end,
    priority = v_prio
  where id = v_so.id;
  perform private.log_so_event(v_company, v_so.id, null, null, null, 'UPDATED', null, null, null, jsonb_build_object('changes', v_c));
  return jsonb_build_object('status', v_so.order_status);
end;
$$;

-- HOLD | RESUME
create or replace function public.sales_order_action(p_so_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.update');
  v_so      public.sales_orders;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_to      text;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if p_action = 'HOLD' then
    if v_so.order_status in ('ON_HOLD', 'CANCELLED', 'FULFILLED') then
      raise exception 'A % sales order cannot be put on hold.', replace(lower(v_so.order_status), '_', ' ') using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for the hold.' using errcode = 'P0001';
    end if;
    update public.sales_orders set order_status = 'ON_HOLD', status_before_hold = v_so.order_status, hold_reason = v_note where id = v_so.id;
    v_to := 'ON_HOLD';
  elsif p_action = 'RESUME' then
    if v_so.order_status <> 'ON_HOLD' then
      raise exception 'Only orders on hold can be resumed.' using errcode = 'P0001';
    end if;
    update public.sales_orders set order_status = coalesce(status_before_hold, 'CONFIRMED'), status_before_hold = null, hold_reason = null where id = v_so.id;
    v_to := private.so_recompute(v_so.id);
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end if;
  perform private.log_so_event(v_company, v_so.id, null, null, null, p_action, v_so.order_status, v_to, v_note);
  return jsonb_build_object('status', v_to);
end;
$$;

-- Allocates eligible stock to the unreserved remaining quantity of the order's
-- lines (or one line). Strategies as in Phase 6 (warehouse = order warehouse).
create or replace function public.sales_order_allocate(
  p_so_id           uuid,
  p_strategy        text default 'IN_HOUSE_FIRST',
  p_line_id         uuid default null,
  p_allow_partial   boolean default true,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('customer_po.allocate');
  v_previous jsonb;
  v_so       public.sales_orders;
  v_line     record;
  v_lot      record;
  v_need     numeric;
  v_take     numeric;
  v_res      public.stock_reservations;
  v_created  jsonb := '[]'::jsonb;
  v_short    jsonb := '[]'::jsonb;
  v_status   text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_allocate');
  if v_previous is not null then return v_previous; end if;
  if p_strategy not in ('IN_HOUSE_FIRST', 'OUTSOURCED_FIRST', 'EARLIEST_BATCH') then
    raise exception 'Choose an allocation strategy.' using errcode = 'P0001';
  end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  perform private.so_assert_workable(v_so, 'allocate stock');
  if p_line_id is not null and not exists (select 1 from public.sales_order_lines where id = p_line_id and sales_order_id = v_so.id) then
    raise exception 'The line does not belong to this sales order.' using errcode = 'P0001';
  end if;

  perform 1 from public.inventory_balances
  where company_id = v_company and product_id in (select product_id from public.sales_order_lines where sales_order_id = v_so.id)
  order by id for update;

  for v_line in
    select l.*, p.status as product_status, p.base_unit from public.sales_order_lines l join public.products p on p.id = l.product_id
    where l.sales_order_id = v_so.id and (p_line_id is null or l.id = p_line_id) order by l.line_no
  loop
    v_need := v_line.quantity_ordered - v_line.quantity_cancelled - v_line.quantity_dispatched - private.so_line_open_reserved(v_line.id);
    continue when v_need <= 0;
    if v_line.product_status <> 'ACTIVE' or v_line.unit <> v_line.base_unit then
      raise exception 'Line % (%) is not an active product in its unit; it cannot be allocated.', v_line.line_no, v_line.sku_snapshot using errcode = 'P0001';
    end if;
    for v_lot in
      select * from private.po_eligible_stock(v_company, v_line.product_id, v_so.warehouse_id) s
      where s.eligible and s.available > 0
      order by
        case when p_strategy = 'IN_HOUSE_FIRST' and s.source_type <> 'IN_HOUSE' then 1
             when p_strategy = 'OUTSOURCED_FIRST' and s.source_type <> 'OUTSOURCED' then 1 else 0 end,
        s.expiry_date nulls last, s.lot_created_at, s.warehouse_code, s.location_code
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_lot.available);
      v_res := private.reserve_balance(v_company, v_lot.balance_id, v_take, 'SALES_ORDER_LINE', v_so.sales_order_number, v_line.id,
        'Allocated to ' || v_so.sales_order_number || ' (' || v_so.customer_name_snapshot || ')');
      v_created := v_created || jsonb_build_object('reservation_number', v_res.reservation_number, 'line_no', v_line.line_no, 'sku', v_line.sku_snapshot,
        'quantity', v_take, 'source_type', v_lot.source_type, 'warehouse_code', v_lot.warehouse_code, 'location_code', v_lot.location_code, 'batch_number', v_lot.batch_number);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      v_short := v_short || jsonb_build_object('line_no', v_line.line_no, 'sku', v_line.sku_snapshot, 'short', v_need, 'unit', v_line.unit);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_partial, true) then
    raise exception 'Not enough eligible stock: %. Nothing was reserved.',
      (select string_agg(format('line %s %s short by %s %s', s ->> 'line_no', s ->> 'sku', s ->> 'short', s ->> 'unit'), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_created) = 0 then
    raise exception '%', case when jsonb_array_length(v_short) = 0 then 'Nothing to allocate: the order is fully reserved or dispatched.'
                              else 'There is no eligible stock to allocate.' end using errcode = 'P0001';
  end if;
  v_status := private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, p_line_id, 'ALLOCATED', v_so.order_status, v_status, null,
    jsonb_build_object('strategy', p_strategy, 'reservations', v_created, 'shortages', v_short));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reservations', v_created, 'shortages', v_short, 'status', v_status));
end;
$$;

-- Releases reserved stock of the order / a line / a reservation that is not
-- already on an open pick list. Never touches another order's reservations.
create or replace function public.sales_order_release(p_so_id uuid, p_line_id uuid default null, p_reservation_id uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment_reservations.release');
  v_so      public.sales_orders;
  v_res     public.stock_reservations;
  v_free    numeric;
  v_total   numeric := 0;
  v_count   int := 0;
  v_status  text;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  for v_res in
    select r.* from public.stock_reservations r
    join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = v_so.id
    where r.company_id = v_company and r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and (p_line_id is null or r.reference_id = p_line_id) and (p_reservation_id is null or r.id = p_reservation_id)
    order by r.location_id, r.batch_id
    for update of r
  loop
    v_free := v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id);
    continue when v_free <= 0;
    v_total := v_total + private.release_reservation_qty(v_res, v_free, 'RELEASED');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'There is no reserved stock to release (stock on an open pick list must be removed from it first by cancelling that fulfilment).'
      using errcode = 'P0001';
  end if;
  v_status := private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, p_line_id, 'RESERVATIONS_RELEASED', v_so.order_status, v_status, p_note,
    jsonb_build_object('released_quantity', v_total, 'reservations', v_count, 'reservation_id', p_reservation_id));
  return jsonb_build_object('released_quantity', v_total, 'reservations', v_count, 'status', v_status);
end;
$$;

-- Backorder information and customer-approved quantity reductions on a line.
create or replace function public.sales_order_line_update(
  p_line_id          uuid,
  p_backorder_reason text default null,
  p_expected_date    date default null,
  p_cancel_quantity  numeric default null,
  p_note             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.update');
  v_line    public.sales_order_lines;
  v_so      public.sales_orders;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_max     numeric;
  v_excess  numeric;
  v_res     public.stock_reservations;
  v_free    numeric;
  v_rel     numeric := 0;
  v_status  text;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id and company_id = v_company;
  if not found then
    raise exception 'Sales order line not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_so from public.sales_orders where id = v_line.sales_order_id for update;
  select * into v_line from public.sales_order_lines where id = p_line_id for update;
  if v_so.order_status in ('CANCELLED', 'FULFILLED') then
    raise exception 'Lines of a % order cannot be changed.', lower(v_so.order_status) using errcode = 'P0001';
  end if;
  if p_backorder_reason is not null and length(btrim(p_backorder_reason)) > 500 then
    raise exception 'The backorder reason is too long.' using errcode = 'P0001';
  end if;

  if coalesce(p_cancel_quantity, 0) <> 0 then
    if v_note is null then
      raise exception 'Record the customer approval (reference or note) for the quantity change.' using errcode = 'P0001';
    end if;
    v_max := v_line.quantity_ordered - v_line.quantity_cancelled - v_line.quantity_dispatched - private.so_line_planned(v_line.id);
    if p_cancel_quantity < 0 or p_cancel_quantity <> round(p_cancel_quantity, 3) or p_cancel_quantity > v_max then
      raise exception 'Line %: reduce by between 0 and % % (quantity already dispatched or on an open pick list cannot be cancelled).',
        v_line.line_no, greatest(v_max, 0), v_line.unit using errcode = 'P0001';
    end if;
    update public.sales_order_lines set quantity_cancelled = quantity_cancelled + p_cancel_quantity where id = v_line.id;
    -- Release reservations above the new remaining quantity (free portions only).
    v_excess := private.so_line_open_reserved(v_line.id) - (v_line.quantity_ordered - v_line.quantity_cancelled - p_cancel_quantity - v_line.quantity_dispatched);
    for v_res in
      select * from public.stock_reservations where reference_type = 'SALES_ORDER_LINE' and reference_id = v_line.id
        and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED') order by reserved_at desc for update
    loop
      exit when v_excess <= 0;
      v_free := least(v_excess, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity - private.reservation_planned(v_res.id));
      continue when v_free <= 0;
      v_rel := v_rel + private.release_reservation_qty(v_res, v_free, 'RELEASED');
      v_excess := v_excess - v_free;
    end loop;
  end if;

  update public.sales_order_lines
  set backorder_reason = case when p_backorder_reason is not null then nullif(btrim(p_backorder_reason), '') else backorder_reason end,
      expected_fulfilment_date = coalesce(p_expected_date, expected_fulfilment_date)
  where id = v_line.id;
  v_status := private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, v_line.id,
    case when coalesce(p_cancel_quantity, 0) <> 0 then 'LINE_QUANTITY_REDUCED' else 'BACKORDER_UPDATED' end, v_so.order_status, v_status, v_note,
    jsonb_build_object('line_no', v_line.line_no, 'cancelled_quantity', p_cancel_quantity, 'released_quantity', v_rel,
      'backorder_reason', p_backorder_reason, 'expected_date', p_expected_date));
  return jsonb_build_object('status', v_status, 'released_quantity', v_rel);
end;
$$;

-- What cancelling would do: fulfilments, active reservations, completed movements.
create or replace function public.sales_order_cancel_preview(p_so_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('sales_orders.read');
  v_so      public.sales_orders;
  v_disp    numeric;
begin
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  select coalesce(sum(quantity_dispatched), 0) into v_disp from public.sales_order_lines where sales_order_id = v_so.id;
  return jsonb_build_object(
    'sales_order_number', v_so.sales_order_number, 'order_status', v_so.order_status,
    'can_cancel', v_so.order_status not in ('CANCELLED', 'FULFILLED'),
    'blocked_reason', case when v_so.order_status = 'CANCELLED' then 'The order is already cancelled.'
                           when v_so.order_status = 'FULFILLED' then 'Everything has been dispatched. Use Customer Returns for goods coming back.' end,
    'has_dispatches', v_disp > 0,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'sku', l.sku_snapshot, 'unit', l.unit, 'ordered', l.quantity_ordered,
        'cancelled', l.quantity_cancelled, 'dispatched', l.quantity_dispatched, 'delivered', l.quantity_delivered,
        'reserved', private.so_line_open_reserved(l.id), 'planned', private.so_line_planned(l.id),
        'will_cancel', greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched, 0)) order by l.line_no)
      from public.sales_order_lines l where l.sales_order_id = v_so.id), '[]'::jsonb),
    'fulfilments', coalesce((select jsonb_agg(jsonb_build_object('fulfilment_number', f.fulfilment_number, 'status', f.fulfilment_status,
        'picked', (select coalesce(sum(quantity_picked), 0) from public.fulfilment_lines where fulfilment_id = f.id),
        'packed', (select coalesce(sum(quantity_packed), 0) from public.fulfilment_lines where fulfilment_id = f.id),
        'dispatched', (select coalesce(sum(quantity_dispatched), 0) from public.fulfilment_lines where fulfilment_id = f.id),
        'will_cancel', f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) order by f.created_at)
      from public.fulfilments f where f.sales_order_id = v_so.id), '[]'::jsonb),
    'reservations', coalesce((select jsonb_agg(jsonb_build_object('reservation_number', r.reservation_number, 'line_no', l.line_no, 'sku', l.sku_snapshot,
        'remaining', r.quantity - r.fulfilled_quantity - r.released_quantity, 'warehouse_code', w.warehouse_code, 'location_code', loc.location_code,
        'batch_number', bt.batch_number) order by l.line_no)
      from public.stock_reservations r
      join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = v_so.id
      join public.warehouses w on w.id = r.warehouse_id
      join public.inventory_locations loc on loc.id = r.location_id
      join public.inventory_batches bt on bt.id = r.batch_id
      where r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(jsonb_build_object('transaction_number', t.transaction_number, 'transaction_type', t.transaction_type,
        'quantity', t.quantity, 'unit', t.unit, 'transaction_date', t.transaction_date) order by t.transaction_date)
      from public.inventory_transactions t where t.document_type = 'SALES_ORDER' and t.document_id = v_so.id), '[]'::jsonb));
end;
$$;

-- Cancels the order (or its remaining quantity when part has been dispatched):
-- open fulfilments are cancelled (nothing was issued), this order's remaining
-- reservations are released, dispatched goods and their ledger entries stay.
create or replace function public.sales_order_cancel(p_so_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('sales_orders.cancel');
  v_previous jsonb;
  v_so       public.sales_orders;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_res      public.stock_reservations;
  v_released numeric := 0;
  v_fuls     int;
  v_disp     numeric;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'sales_order_cancel');
  if v_previous is not null then return v_previous; end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if v_so.order_status in ('CANCELLED', 'FULFILLED') then
    raise exception 'A % sales order cannot be cancelled.%', lower(v_so.order_status),
      case when v_so.order_status = 'FULFILLED' then ' Use Customer Returns for dispatched goods.' else '' end using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Enter the reason for the cancellation.' using errcode = 'P0001';
  end if;

  update public.fulfilments set fulfilment_status = 'CANCELLED', cancel_reason = left('Order cancelled: ' || v_reason, 500), cancelled_by = auth.uid(), cancelled_at = now()
  where sales_order_id = v_so.id and fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH');
  get diagnostics v_fuls = row_count;

  for v_res in
    select r.* from public.stock_reservations r
    join public.sales_order_lines l on l.id = r.reference_id and l.sales_order_id = v_so.id
    where r.company_id = v_company and r.reference_type = 'SALES_ORDER_LINE' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    order by r.location_id, r.batch_id
    for update of r
  loop
    v_released := v_released + private.release_reservation_remaining(v_res, 'CANCELLED');
  end loop;

  update public.sales_order_lines set quantity_cancelled = quantity_ordered - quantity_dispatched where sales_order_id = v_so.id;
  select coalesce(sum(quantity_dispatched), 0) into v_disp from public.sales_order_lines where sales_order_id = v_so.id;
  update public.sales_orders set order_status = 'CANCELLED', status_before_hold = null, cancel_reason = v_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = v_so.id;
  perform private.so_recompute(v_so.id);
  perform private.log_so_event(v_company, v_so.id, null, null, null, 'CANCELLED', v_so.order_status, 'CANCELLED', v_reason,
    jsonb_build_object('released_quantity', v_released, 'fulfilments_cancelled', v_fuls, 'dispatched_kept', v_disp));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'status', 'CANCELLED', 'released_quantity', v_released, 'fulfilments_cancelled', v_fuls, 'dispatched_kept', v_disp));
end;
$$;

-- -----------------------------------------------------------------------------
-- Views (security_invoker: RLS of the underlying tables applies)
-- -----------------------------------------------------------------------------
create or replace view public.sales_order_list
with (security_invoker = true) as
select so.*,
  c.customer_code,
  w.warehouse_code,
  (select count(*) from public.sales_order_lines l where l.sales_order_id = so.id)::int as line_count,
  (select jsonb_agg(u order by u ->> 'unit') from (
     select jsonb_build_object('unit', l.unit, 'ordered', sum(l.quantity_ordered), 'cancelled', sum(l.quantity_cancelled),
       'dispatched', sum(l.quantity_dispatched), 'delivered', sum(l.quantity_delivered), 'returned', sum(l.quantity_returned),
       'remaining', sum(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched),
       'reserved', sum(private.so_line_open_reserved(l.id))) as u
     from public.sales_order_lines l where l.sales_order_id = so.id group by l.unit) x) as unit_totals,
  (select count(*) from public.fulfilments f where f.sales_order_id = so.id and f.fulfilment_status <> 'CANCELLED')::int as fulfilment_count,
  (select max(f.actual_dispatch_at) from public.fulfilments f where f.sales_order_id = so.id) as last_dispatch_at,
  exists (select 1 from public.fulfilments f where f.sales_order_id = so.id and (f.fulfilment_status = 'DELIVERY_EXCEPTION'
    or exists (select 1 from public.fulfilment_lines fl where fl.fulfilment_id = f.id and (fl.pick_exception is not null or fl.quantity_damaged > 0))
    or (f.fulfilment_status in ('DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED') and f.expected_delivery_date < private.so_today()))) as has_exception
from public.sales_orders so
left join public.customers c on c.id = so.customer_id
left join public.warehouses w on w.id = so.warehouse_id;

create or replace view public.sales_order_line_list
with (security_invoker = true) as
select l.*,
  so.sales_order_number, so.order_status, so.customer_name_snapshot, so.customer_id, so.customer_po_number, so.order_date,
  so.requested_delivery_date as order_requested_date, so.priority, so.warehouse_id as order_warehouse_id,
  p.barcode, p.base_unit, p.status as product_status, p.default_source_type,
  pol.line_no as po_line_no,
  l.quantity_ordered - l.quantity_cancelled as quantity_effective,
  l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched as quantity_remaining,
  private.so_line_open_reserved(l.id) as quantity_reserved,
  private.so_line_planned(l.id) as quantity_planned,
  (select coalesce(sum(fl.quantity_picked), 0) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.sales_order_line_id = l.id and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) as quantity_picked,
  (select coalesce(sum(fl.quantity_packed), 0) from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.sales_order_line_id = l.id and f.fulfilment_status in ('PENDING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH')) as quantity_packed,
  greatest(l.quantity_ordered - l.quantity_cancelled - l.quantity_dispatched - private.so_line_open_reserved(l.id), 0) as quantity_unreserved,
  private.so_line_available_now(l.id) as available_now
from public.sales_order_lines l
join public.sales_orders so on so.id = l.sales_order_id
join public.products p on p.id = l.product_id
left join public.customer_purchase_order_lines pol on pol.id = l.customer_purchase_order_line_id;

create or replace view public.sales_order_reservation_list
with (security_invoker = true) as
select r.id, r.company_id, r.reservation_number, r.reservation_status, r.quantity, r.fulfilled_quantity, r.released_quantity,
  r.quantity - r.fulfilled_quantity - r.released_quantity as remaining,
  private.reservation_planned(r.id) as planned,
  r.reserved_at, r.notes, r.batch_id, r.location_id, r.warehouse_id, r.product_id,
  l.id as sales_order_line_id, l.line_no, l.sales_order_id, l.sku_snapshot as sku, l.product_name_snapshot as product_name, l.unit,
  so.sales_order_number, so.customer_name_snapshot,
  bt.batch_number, bt.expiry_date, bt.source_type, bt.status as batch_status,
  w.warehouse_code, loc.location_code, loc.stock_usage, loc.status as location_status
from public.stock_reservations r
join public.sales_order_lines l on l.id = r.reference_id
join public.sales_orders so on so.id = l.sales_order_id
join public.inventory_batches bt on bt.id = r.batch_id
join public.warehouses w on w.id = r.warehouse_id
join public.inventory_locations loc on loc.id = r.location_id
where r.reference_type = 'SALES_ORDER_LINE';

revoke all on public.sales_order_list, public.sales_order_line_list, public.sales_order_reservation_list from anon, authenticated;
grant select on public.sales_order_list, public.sales_order_line_list, public.sales_order_reservation_list to authenticated;

-- Function grants
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sales_order_po_candidates()', 'public.sales_order_po_preview(uuid)',
    'public.sales_order_create_from_po(uuid, jsonb, jsonb, boolean, boolean, uuid)', 'public.sales_order_create_manual(jsonb, jsonb, boolean, uuid)',
    'public.sales_order_confirm(uuid, text)', 'public.sales_order_update(uuid, jsonb)', 'public.sales_order_action(uuid, text, text)',
    'public.sales_order_allocate(uuid, text, uuid, boolean, uuid)', 'public.sales_order_release(uuid, uuid, uuid, text)',
    'public.sales_order_line_update(uuid, text, date, numeric, text)', 'public.sales_order_cancel_preview(uuid)', 'public.sales_order_cancel(uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
