-- =============================================================================
-- Phase 5: outsourcing (third-party manufacturing / processing)
--
--   outsourcing_orders             header (supplier is a controlled text reference
--                                  until the supplier master exists)
--   outsourcing_order_materials    company material planned for the supplier
--   outsourcing_material_movements DISPATCH / RETURN (transfers to / from the
--                                  supplier-held location) and CONSUMPTION
--                                  (material used up by the supplier)
--   outsourcing_receipts           goods received back: received = accepted + rejected
--
-- Ownership: dispatched material stays company stock. It is TRANSFERRED to an
-- EXTERNAL_PROCESSING location (same lot, same source) - never consumed or
-- purchased by the dispatch. When processed goods come back, the material the
-- supplier used is posted as SUBCONTRACT_CONSUMPTION and the output as
-- SUBCONTRACT_RECEIPT (source OUTSOURCED), so company material is never
-- double-counted. Only accepted goods enter usable stock; rejected goods are
-- either stocked in a REJECTED (non-saleable) location or recorded only.
-- =============================================================================

create table if not exists public.outsourcing_orders (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  outsourcing_order_number text not null,
  order_type               text not null check (order_type in ('OUTSOURCED_FINISHED_GOODS', 'OUTSOURCED_PROCESSING')),
  -- Reserved for the supplier master (not built yet): must stay NULL. No invented suppliers.
  supplier_id              uuid check (supplier_id is null),
  supplier_name            text not null check (length(btrim(supplier_name)) between 1 and 200),
  supplier_reference       text check (supplier_reference is null or length(supplier_reference) <= 100),
  product_id               uuid not null,
  bom_id                   uuid,
  bom_code                 text,
  bom_version              integer,
  unit                     text not null,
  ordered_quantity         numeric(14,3) not null check (ordered_quantity > 0),
  received_quantity        numeric(14,3) not null default 0 check (received_quantity >= 0),
  accepted_quantity        numeric(14,3) not null default 0 check (accepted_quantity >= 0),
  rejected_quantity        numeric(14,3) not null default 0 check (rejected_quantity >= 0),
  status                   text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_DISPATCHED',
                             'PARTIALLY_RECEIVED', 'COMPLETED', 'ON_HOLD', 'CANCELLED')),
  status_before_hold       text,
  dispatch_date            date,
  expected_return_date     date not null,
  destination_warehouse_id uuid not null,
  external_location_id     uuid,
  reference_number         text check (reference_number is null or length(reference_number) <= 100),
  unit_cost                numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  currency_code            text not null default 'INR' check (currency_code ~ '^[A-Z]{3}$'),
  notes                    text check (notes is null or length(notes) <= 2000),
  review_note              text check (review_note is null or length(review_note) <= 1000),
  hold_reason              text check (hold_reason is null or length(hold_reason) <= 1000),
  cancel_reason            text check (cancel_reason is null or length(cancel_reason) <= 1000),
  completion_note          text check (completion_note is null or length(completion_note) <= 1000),
  created_by               uuid,
  submitted_by             uuid,
  submitted_at             timestamptz,
  approved_by              uuid,
  approved_at              timestamptz,
  completed_by             uuid,
  completed_at             timestamptz,
  cancelled_by             uuid,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint outsourcing_orders_number_unique unique (company_id, outsourcing_order_number),
  constraint outsourcing_orders_id_company_unique unique (id, company_id),
  constraint outsourcing_orders_received_split check (accepted_quantity + rejected_quantity = received_quantity),
  constraint outsourcing_orders_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint outsourcing_orders_bom_fk foreign key (bom_id, company_id) references public.boms (id, company_id) on delete restrict,
  constraint outsourcing_orders_wh_fk foreign key (destination_warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict,
  constraint outsourcing_orders_ext_loc_fk foreign key (external_location_id, company_id) references public.inventory_locations (id, company_id) on delete restrict
);

comment on column public.outsourcing_orders.unit_cost is
  'Agreed price (finished goods) or processing charge (processing) per unit, if recorded. Not a full production cost for processing orders.';
comment on column public.outsourcing_orders.supplier_name is
  'Controlled external supplier reference until the supplier master exists (supplier_id stays NULL).';

create index if not exists outsourcing_orders_status_idx on public.outsourcing_orders (company_id, status);

create table if not exists public.outsourcing_order_materials (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  outsourcing_order_id uuid not null,
  line_no              integer not null,
  component_product_id uuid not null,
  unit                 text not null,
  quantity_per_unit    numeric(18,6),
  planned_quantity     numeric(14,3) not null check (planned_quantity > 0),
  dispatched_quantity  numeric(14,3) not null default 0 check (dispatched_quantity >= 0),
  returned_quantity    numeric(14,3) not null default 0 check (returned_quantity >= 0),
  consumed_quantity    numeric(14,3) not null default 0 check (consumed_quantity >= 0),
  constraint outsourcing_materials_held_nonnegative check (dispatched_quantity - returned_quantity - consumed_quantity >= 0),
  constraint outsourcing_materials_order_fk foreign key (outsourcing_order_id, company_id)
    references public.outsourcing_orders (id, company_id) on delete restrict,
  constraint outsourcing_materials_product_fk foreign key (component_product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint outsourcing_materials_unique unique (outsourcing_order_id, component_product_id),
  constraint outsourcing_materials_id_company_unique unique (id, company_id)
);

comment on table public.outsourcing_order_materials is
  'Company material for an outsourcing order. Held at supplier = dispatched - returned - consumed (all net of reversals).';

create table if not exists public.outsourcing_receipts (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  receipt_number           text not null,
  outsourcing_order_id     uuid not null,
  product_id               uuid not null,
  batch_id                 uuid,
  received_quantity        numeric(14,3) not null check (received_quantity > 0),
  accepted_quantity        numeric(14,3) not null check (accepted_quantity >= 0),
  rejected_quantity        numeric(14,3) not null check (rejected_quantity >= 0),
  unit                     text not null,
  accepted_location_id     uuid,
  rejected_location_id     uuid,
  accepted_transaction_id  uuid references public.inventory_transactions (id) on delete restrict,
  rejected_transaction_id  uuid references public.inventory_transactions (id) on delete restrict,
  receipt_date             date not null,
  unit_cost                numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  supplier_document_number text check (supplier_document_number is null or length(supplier_document_number) <= 100),
  rejection_disposition    text check (rejection_disposition is null or rejection_disposition in
                             ('RETURN_TO_SUPPLIER', 'HELD_FOR_REWORK', 'SCRAP', 'PENDING_DECISION')),
  rejection_reason         text check (rejection_reason is null or length(rejection_reason) <= 500),
  over_receipt_reason      text check (over_receipt_reason is null or length(over_receipt_reason) <= 500),
  notes                    text check (notes is null or length(notes) <= 1000),
  status                   text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_transaction_ids text[],
  reversal_reason          text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by              uuid,
  reversed_at              timestamptz,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  constraint outsourcing_receipts_number_unique unique (company_id, receipt_number),
  constraint outsourcing_receipts_split check (accepted_quantity + rejected_quantity = received_quantity),
  constraint outsourcing_receipts_disposition check ((rejected_quantity > 0) = (rejection_disposition is not null)),
  constraint outsourcing_receipts_accepted_has_tx check ((accepted_quantity > 0) = (accepted_transaction_id is not null)),
  constraint outsourcing_receipts_acc_tx_unique unique (accepted_transaction_id),
  constraint outsourcing_receipts_rej_tx_unique unique (rejected_transaction_id),
  constraint outsourcing_receipts_order_fk foreign key (outsourcing_order_id, company_id)
    references public.outsourcing_orders (id, company_id) on delete restrict,
  constraint outsourcing_receipts_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict
);

create index if not exists outsourcing_receipts_order_idx on public.outsourcing_receipts (outsourcing_order_id);
create index if not exists outsourcing_receipts_batch_idx on public.outsourcing_receipts (batch_id);
create index if not exists outsourcing_receipts_date_idx on public.outsourcing_receipts (company_id, receipt_date);

create table if not exists public.outsourcing_material_movements (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  outsourcing_order_id  uuid not null,
  order_material_id     uuid not null,
  component_product_id  uuid not null,
  movement_type         text not null check (movement_type in ('DISPATCH', 'RETURN', 'CONSUMPTION')),
  batch_id              uuid not null,
  from_location_id      uuid not null,
  to_location_id        uuid,
  quantity              numeric(14,3) not null check (quantity > 0),
  unit                  text not null,
  transfer_group_id     uuid,
  out_transaction_id    uuid not null references public.inventory_transactions (id) on delete restrict,
  in_transaction_id     uuid references public.inventory_transactions (id) on delete restrict,
  receipt_id            uuid references public.outsourcing_receipts (id) on delete restrict,
  movement_date         date not null,
  over_dispatch_reason  text check (over_dispatch_reason is null or length(over_dispatch_reason) <= 500),
  notes                 text check (notes is null or length(notes) <= 1000),
  status                text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_transaction_ids text[],
  reversal_reason       text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by           uuid,
  reversed_at           timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  constraint outsourcing_movements_out_tx_unique unique (out_transaction_id),
  constraint outsourcing_movements_shape check (
    (movement_type = 'CONSUMPTION' and to_location_id is null and in_transaction_id is null and receipt_id is not null)
    or (movement_type in ('DISPATCH', 'RETURN') and to_location_id is not null and in_transaction_id is not null)),
  constraint outsourcing_movements_order_fk foreign key (outsourcing_order_id, company_id)
    references public.outsourcing_orders (id, company_id) on delete restrict,
  constraint outsourcing_movements_material_fk foreign key (order_material_id, company_id)
    references public.outsourcing_order_materials (id, company_id) on delete restrict,
  constraint outsourcing_movements_batch_fk foreign key (batch_id, component_product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict
);

create index if not exists outsourcing_movements_order_idx on public.outsourcing_material_movements (outsourcing_order_id);
create index if not exists outsourcing_movements_batch_idx on public.outsourcing_material_movements (batch_id);

create table if not exists public.outsourcing_order_events (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  outsourcing_order_id uuid not null,
  event_type           text not null,
  from_status          text,
  to_status            text,
  note                 text,
  details              jsonb not null default '{}'::jsonb,
  actor_user_id        uuid,
  created_at           timestamptz not null default now(),
  constraint outsourcing_events_order_fk foreign key (outsourcing_order_id, company_id)
    references public.outsourcing_orders (id, company_id) on delete restrict
);

create index if not exists outsourcing_events_order_idx on public.outsourcing_order_events (outsourcing_order_id, created_at);

drop trigger if exists outsourcing_receipts_guard on public.outsourcing_receipts;
create trigger outsourcing_receipts_guard before update or delete on public.outsourcing_receipts
  for each row execute function private.guard_posted_document();
drop trigger if exists outsourcing_movements_guard on public.outsourcing_material_movements;
create trigger outsourcing_movements_guard before update or delete on public.outsourcing_material_movements
  for each row execute function private.guard_posted_document();
drop trigger if exists outsourcing_events_append_only on public.outsourcing_order_events;
create trigger outsourcing_events_append_only before update or delete on public.outsourcing_order_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists outsourcing_orders_set_updated_at on public.outsourcing_orders;
create trigger outsourcing_orders_set_updated_at before update on public.outsourcing_orders
  for each row execute function private.set_updated_at();

-- RLS: read only for clients
alter table public.outsourcing_orders enable row level security;
alter table public.outsourcing_order_materials enable row level security;
alter table public.outsourcing_receipts enable row level security;
alter table public.outsourcing_material_movements enable row level security;
alter table public.outsourcing_order_events enable row level security;

revoke all on table public.outsourcing_orders, public.outsourcing_order_materials, public.outsourcing_receipts,
  public.outsourcing_material_movements, public.outsourcing_order_events from anon, authenticated;
grant select on public.outsourcing_orders, public.outsourcing_order_materials, public.outsourcing_receipts,
  public.outsourcing_material_movements, public.outsourcing_order_events to authenticated;
grant all on table public.outsourcing_orders, public.outsourcing_order_materials, public.outsourcing_receipts,
  public.outsourcing_material_movements, public.outsourcing_order_events to service_role;

drop policy if exists outsourcing_orders_select on public.outsourcing_orders;
create policy outsourcing_orders_select on public.outsourcing_orders for select to authenticated
  using (private.has_permission(company_id, 'outsourcing.read'));
drop policy if exists outsourcing_materials_select on public.outsourcing_order_materials;
create policy outsourcing_materials_select on public.outsourcing_order_materials for select to authenticated
  using (private.has_permission(company_id, 'outsourcing.read'));
drop policy if exists outsourcing_receipts_select on public.outsourcing_receipts;
create policy outsourcing_receipts_select on public.outsourcing_receipts for select to authenticated
  using (private.has_permission(company_id, 'outsourcing.read'));
drop policy if exists outsourcing_movements_select on public.outsourcing_material_movements;
create policy outsourcing_movements_select on public.outsourcing_material_movements for select to authenticated
  using (private.has_permission(company_id, 'outsourcing.read'));
drop policy if exists outsourcing_events_select on public.outsourcing_order_events;
create policy outsourcing_events_select on public.outsourcing_order_events for select to authenticated
  using (private.has_permission(company_id, 'outsourcing.read'));

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function private.log_outsourcing_event(
  p_company uuid, p_order uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.outsourcing_order_events (company_id, outsourcing_order_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_order, p_event, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_company, 'outsourcing.order_' || lower(p_event), 'outsourcing_order', p_order::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('from_status', p_from, 'to_status', p_to, 'note', p_note));
end;
$$;

revoke all on function private.log_outsourcing_event(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

--   RECEIPT_SHORT  received less than ordered
--   MATERIAL_HELD  company material still at the supplier for this order
create or replace function private.outsourcing_discrepancies(p_order public.outsourcing_orders)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select jsonb_build_object('type', 'RECEIPT_SHORT', 'ordered', p_order.ordered_quantity, 'received', p_order.received_quantity) as d
    where p_order.received_quantity < p_order.ordered_quantity
    union all
    select jsonb_build_object('type', 'MATERIAL_HELD', 'sku', p.sku,
      'held', m.dispatched_quantity - m.returned_quantity - m.consumed_quantity, 'unit', m.unit)
    from public.outsourcing_order_materials m join public.products p on p.id = m.component_product_id
    where m.outsourcing_order_id = p_order.id and m.dispatched_quantity - m.returned_quantity - m.consumed_quantity > 0
  ) x;
$$;

revoke all on function private.outsourcing_discrepancies(public.outsourcing_orders) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Create / edit a draft outsourcing order
-- p_materials (when no BOM is given): [{product_id, quantity}] in each product's unit
-- -----------------------------------------------------------------------------
create or replace function public.outsourcing_save_order(
  p_order_id                 uuid,
  p_order_type               text,
  p_product_id               uuid,
  p_bom_id                   uuid,
  p_ordered_quantity         numeric,
  p_supplier_name            text,
  p_supplier_reference       text,
  p_expected_return_date     date,
  p_destination_warehouse_id uuid,
  p_external_location_id     uuid default null,
  p_reference_number         text default null,
  p_unit_cost                numeric default null,
  p_notes                    text default null,
  p_materials                jsonb default '[]'::jsonb,
  p_idempotency_key          uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('outsourcing_order.create');
  v_today     date := private.company_today(v_company);
  v_previous  jsonb;
  v_order     public.outsourcing_orders;
  v_product   public.products;
  v_bom       public.boms;
  v_material  public.products;
  v_ext       public.inventory_locations;
  v_item      jsonb;
  v_qty       numeric;
  v_line      int := 0;
  v_seen      uuid[] := '{}';
  v_has_mats  boolean;
begin
  if p_order_id is null then
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'outsourcing_order_create');
    if v_previous is not null then return v_previous; end if;
  else
    select * into v_order from public.outsourcing_orders where id = p_order_id and company_id = v_company for update;
    if not found then
      raise exception 'Outsourcing order not found in your company.' using errcode = 'P0001';
    end if;
    if v_order.status <> 'DRAFT' then
      raise exception 'Only draft outsourcing orders can be edited.' using errcode = 'P0001';
    end if;
    if v_order.created_by is distinct from auth.uid() and not private.has_permission(v_company, 'outsourcing_order.approve') then
      raise exception 'You can only edit your own draft outsourcing orders.' using errcode = '42501';
    end if;
  end if;

  if p_order_type not in ('OUTSOURCED_FINISHED_GOODS', 'OUTSOURCED_PROCESSING') then
    raise exception 'Order type must be OUTSOURCED_FINISHED_GOODS or OUTSOURCED_PROCESSING.' using errcode = 'P0001';
  end if;
  v_product := private.require_active_product(v_company, p_product_id);
  if p_ordered_quantity is null or p_ordered_quantity <= 0 or p_ordered_quantity <> round(p_ordered_quantity, 3) then
    raise exception 'Enter an ordered quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if p_supplier_name is null or length(btrim(p_supplier_name)) = 0 or length(btrim(p_supplier_name)) > 200 then
    raise exception 'Enter the supplier (until the supplier master exists, its name / reference).' using errcode = 'P0001';
  end if;
  if p_expected_return_date is null then
    raise exception 'Enter the expected return / delivery date.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.warehouses where id = p_destination_warehouse_id and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Select an active destination warehouse.' using errcode = 'P0001';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative.' using errcode = 'P0001';
  end if;

  if p_bom_id is not null then
    if p_materials is not null and jsonb_typeof(p_materials) = 'array' and jsonb_array_length(p_materials) > 0 then
      raise exception 'Give either a BOM or a manual material list, not both.' using errcode = 'P0001';
    end if;
    select * into v_bom from public.boms where id = p_bom_id and company_id = v_company;
    if not found then
      raise exception 'BOM not found in your company.' using errcode = 'P0001';
    end if;
    if v_bom.finished_product_id <> v_product.id then
      raise exception 'The BOM is for a different product.' using errcode = 'P0001';
    end if;
    if v_bom.status <> 'APPROVED' or v_bom.effective_from > v_today or (v_bom.effective_to is not null and v_bom.effective_to < v_today) then
      raise exception 'BOM % v% is not approved and currently effective.', v_bom.bom_code, v_bom.version using errcode = 'P0001';
    end if;
    if exists (select 1 from private.bom_requirement_lines(v_bom.id, p_ordered_quantity) r where not r.unit_matches or not r.component_active) then
      raise exception 'The BOM has inactive components or unit mismatches.' using errcode = 'P0001';
    end if;
    v_has_mats := true;
  else
    if p_materials is null or jsonb_typeof(p_materials) <> 'array' then
      raise exception 'Materials must be a list.' using errcode = 'P0001';
    end if;
    for v_item in select value from jsonb_array_elements(p_materials) loop
      v_line := v_line + 1;
      select * into v_material from public.products where id = (v_item ->> 'product_id')::uuid and company_id = v_company;
      if not found then
        raise exception 'Material line %: product not found in your company.', v_line using errcode = 'P0001';
      end if;
      if v_material.status <> 'ACTIVE' or v_material.archived_at is not null then
        raise exception 'Material line %: % is inactive.', v_line, v_material.sku using errcode = 'P0001';
      end if;
      if v_material.id = any(v_seen) then
        raise exception 'Material line %: % is listed more than once.', v_line, v_material.sku using errcode = 'P0001';
      end if;
      v_seen := v_seen || v_material.id;
      begin
        v_qty := (v_item ->> 'quantity')::numeric;
      exception when others then
        raise exception 'Material line %: quantity must be a number.', v_line using errcode = 'P0001';
      end;
      if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
        raise exception 'Material line %: quantity must be greater than zero (up to 3 decimals).', v_line using errcode = 'P0001';
      end if;
      if v_item ? 'unit' and upper(btrim(v_item ->> 'unit')) <> v_material.base_unit then
        raise exception 'Material line %: enter the quantity in % (the inventory unit of %).', v_line, v_material.base_unit, v_material.sku
          using errcode = 'P0001';
      end if;
    end loop;
    v_has_mats := v_line > 0;
  end if;

  if p_order_type = 'OUTSOURCED_PROCESSING' and not v_has_mats then
    raise exception 'A processing order needs the company materials to be processed (a BOM or a material list).' using errcode = 'P0001';
  end if;
  if v_has_mats then
    select * into v_ext from public.inventory_locations where id = p_external_location_id and company_id = v_company;
    if not found or v_ext.stock_usage <> 'EXTERNAL_PROCESSING' or v_ext.status <> 'ACTIVE' then
      raise exception 'Select the active external-processing location (supplier-held stock) for the materials.' using errcode = 'P0001';
    end if;
  elsif p_external_location_id is not null then
    raise exception 'An external-processing location is only needed when materials are sent to the supplier.' using errcode = 'P0001';
  end if;

  if p_order_id is null then
    insert into public.outsourcing_orders (company_id, outsourcing_order_number, order_type, supplier_name, supplier_reference, product_id,
      bom_id, bom_code, bom_version, unit, ordered_quantity, expected_return_date, destination_warehouse_id, external_location_id,
      reference_number, unit_cost, notes, created_by)
    values (v_company, private.next_document_number(v_company, 'OUT'), p_order_type, btrim(p_supplier_name),
      nullif(btrim(coalesce(p_supplier_reference, '')), ''), v_product.id, v_bom.id, v_bom.bom_code, v_bom.version, v_product.base_unit,
      p_ordered_quantity, p_expected_return_date, p_destination_warehouse_id, case when v_has_mats then p_external_location_id end,
      nullif(btrim(coalesce(p_reference_number, '')), ''), p_unit_cost, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
    returning * into v_order;
    perform private.log_outsourcing_event(v_company, v_order.id, 'CREATED', null, 'DRAFT', null,
      jsonb_build_object('outsourcing_order_number', v_order.outsourcing_order_number));
  else
    update public.outsourcing_orders
    set order_type = p_order_type, supplier_name = btrim(p_supplier_name), supplier_reference = nullif(btrim(coalesce(p_supplier_reference, '')), ''),
        product_id = v_product.id, bom_id = v_bom.id, bom_code = v_bom.bom_code, bom_version = v_bom.version, unit = v_product.base_unit,
        ordered_quantity = p_ordered_quantity, expected_return_date = p_expected_return_date, destination_warehouse_id = p_destination_warehouse_id,
        external_location_id = case when v_has_mats then p_external_location_id end,
        reference_number = nullif(btrim(coalesce(p_reference_number, '')), ''), unit_cost = p_unit_cost,
        notes = nullif(btrim(coalesce(p_notes, '')), '')
    where id = v_order.id
    returning * into v_order;
    delete from public.outsourcing_order_materials where outsourcing_order_id = v_order.id;
    perform private.log_outsourcing_event(v_company, v_order.id, 'UPDATED', 'DRAFT', 'DRAFT', null, '{}'::jsonb);
  end if;

  if v_bom.id is not null then
    insert into public.outsourcing_order_materials (company_id, outsourcing_order_id, line_no, component_product_id, unit, quantity_per_unit, planned_quantity)
    select v_company, v_order.id, r.line_no, r.component_product_id, r.unit, r.quantity_per_unit, r.total_requirement
    from private.bom_requirement_lines(v_bom.id, p_ordered_quantity) r;
  else
    insert into public.outsourcing_order_materials (company_id, outsourcing_order_id, line_no, component_product_id, unit, planned_quantity)
    select v_company, v_order.id, e.ordinality, p.id, p.base_unit, (e.value ->> 'quantity')::numeric
    from jsonb_array_elements(p_materials) with ordinality e
    join public.products p on p.id = (e.value ->> 'product_id')::uuid;
  end if;

  v_previous := jsonb_build_object('order_id', v_order.id, 'outsourcing_order_number', v_order.outsourcing_order_number);
  if p_order_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- SUBMIT | WITHDRAW | APPROVE | REJECT | HOLD | RESUME | CANCEL | COMPLETE
create or replace function public.outsourcing_order_action(
  p_order_id        uuid,
  p_action          text,
  p_note            text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('outsourcing.read');
  v_previous jsonb;
  v_order    public.outsourcing_orders;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_to       text;
  v_disc     jsonb;
begin
  if p_idempotency_key is not null then
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'outsourcing_order_action');
    if v_previous is not null then return v_previous; end if;
  end if;
  select * into v_order from public.outsourcing_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Outsourcing order not found in your company.' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'The note is limited to 1000 characters.' using errcode = 'P0001';
  end if;

  case p_action
  when 'SUBMIT' then
    perform private.require_permission('outsourcing_order.create');
    if v_order.status <> 'DRAFT' then
      raise exception 'Only draft orders can be submitted (order is %).', v_order.status using errcode = 'P0001';
    end if;
    if v_order.created_by is distinct from auth.uid() and not private.has_permission(v_company, 'outsourcing_order.approve') then
      raise exception 'You can only submit your own outsourcing orders.' using errcode = '42501';
    end if;
    v_to := 'PENDING_APPROVAL';
    update public.outsourcing_orders set status = v_to, submitted_by = auth.uid(), submitted_at = now(), review_note = null where id = v_order.id;

  when 'WITHDRAW' then
    if v_order.status <> 'PENDING_APPROVAL' then
      raise exception 'Only orders awaiting approval can be withdrawn.' using errcode = 'P0001';
    end if;
    if v_order.submitted_by is distinct from auth.uid() and not private.has_permission(v_company, 'outsourcing_order.approve') then
      raise exception 'You are not allowed to withdraw this order.' using errcode = '42501';
    end if;
    v_to := 'DRAFT';
    update public.outsourcing_orders set status = v_to where id = v_order.id;

  when 'APPROVE', 'REJECT' then
    perform private.require_permission('outsourcing_order.approve');
    if v_order.status <> 'PENDING_APPROVAL' then
      raise exception 'This order is not awaiting approval (order is %).', v_order.status using errcode = 'P0001';
    end if;
    if p_action = 'REJECT' then
      if v_note is null then
        raise exception 'Enter the reason for rejecting the order.' using errcode = 'P0001';
      end if;
      v_to := 'DRAFT';
      update public.outsourcing_orders set status = v_to, review_note = v_note where id = v_order.id;
    else
      perform private.assert_not_self_approval(v_company, v_order.created_by, v_order.submitted_by);
      v_to := 'APPROVED';
      update public.outsourcing_orders set status = v_to, approved_by = auth.uid(), approved_at = now(), review_note = v_note where id = v_order.id;
    end if;

  when 'HOLD' then
    perform private.require_permission('outsourcing_order.approve');
    if v_order.status not in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') then
      raise exception 'An order that is % cannot be put on hold.', v_order.status using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for the hold.' using errcode = 'P0001';
    end if;
    v_to := 'ON_HOLD';
    update public.outsourcing_orders set status = v_to, status_before_hold = v_order.status, hold_reason = v_note where id = v_order.id;

  when 'RESUME' then
    perform private.require_permission('outsourcing_order.approve');
    if v_order.status <> 'ON_HOLD' then
      raise exception 'Only orders on hold can be resumed.' using errcode = 'P0001';
    end if;
    v_to := v_order.status_before_hold;
    update public.outsourcing_orders set status = v_to, status_before_hold = null where id = v_order.id;

  when 'CANCEL' then
    perform private.require_permission('outsourcing_order.approve');
    if v_order.status in ('COMPLETED', 'CANCELLED') then
      raise exception 'An order that is % cannot be cancelled.', v_order.status using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for cancelling the order.' using errcode = 'P0001';
    end if;
    if v_order.received_quantity > 0 then
      raise exception 'Goods have been received on this order. Reverse the receipts before cancelling.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.outsourcing_order_materials
               where outsourcing_order_id = v_order.id and dispatched_quantity - returned_quantity - consumed_quantity > 0) then
      raise exception 'Company material is still at the supplier for this order. Record its return before cancelling.' using errcode = 'P0001';
    end if;
    v_to := 'CANCELLED';
    update public.outsourcing_orders set status = v_to, cancel_reason = v_note, cancelled_by = auth.uid(), cancelled_at = now() where id = v_order.id;

  when 'COMPLETE' then
    perform private.require_permission('outsourcing_order.complete');
    if v_order.status not in ('MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED', 'APPROVED') then
      raise exception 'An order that is % cannot be completed.', v_order.status using errcode = 'P0001';
    end if;
    if v_order.received_quantity = 0 then
      raise exception 'Record the goods received before completing the order.' using errcode = 'P0001';
    end if;
    v_disc := private.outsourcing_discrepancies(v_order);
    if jsonb_array_length(v_disc) > 0 then
      if not private.has_permission(v_company, 'production_exception.approve') then
        raise exception 'The order has open quantities or material still at the supplier. A user with production_exception.approve must complete it with a documented reason.'
          using errcode = '42501';
      end if;
      if v_note is null or length(v_note) < 5 then
        raise exception 'The order has discrepancies: document the reason for completing it anyway.' using errcode = 'P0001';
      end if;
    end if;
    v_to := 'COMPLETED';
    update public.outsourcing_orders set status = v_to, completion_note = v_note, completed_by = auth.uid(), completed_at = now() where id = v_order.id;
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;

  perform private.log_outsourcing_event(v_company, v_order.id, p_action, v_order.status, v_to, v_note,
    jsonb_build_object('outsourcing_order_number', v_order.outsourcing_order_number, 'discrepancies', coalesce(v_disc, '[]'::jsonb)));
  v_previous := jsonb_build_object('status', v_to, 'discrepancies', coalesce(v_disc, '[]'::jsonb));
  if p_idempotency_key is not null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- -----------------------------------------------------------------------------
-- Material dispatch to / return from the supplier: paired transfer legs
-- (same lot, ownership unchanged) between a STORAGE location and the order's
-- EXTERNAL_PROCESSING location.
-- p_lines: [{order_material_id, batch_id, location_id, quantity}]
--   DISPATCH: location_id = storage location the material leaves
--   RETURN:   location_id = storage location the material comes back to
-- -----------------------------------------------------------------------------
create or replace function public.outsourcing_move_materials(
  p_order_id        uuid,
  p_movement_type   text,
  p_lines           jsonb,
  p_movement_date   date default null,
  p_over_reason     text default null,
  p_notes           text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('outsourcing_material.dispatch');
  v_today    date;
  v_previous jsonb;
  v_order    public.outsourcing_orders;
  v_input    jsonb;
  v_line     public.outsourcing_order_materials;
  v_product  public.products;
  v_storage  public.inventory_locations;
  v_lot      public.inventory_batches;
  v_qty      numeric;
  v_from     uuid;
  v_to       uuid;
  v_group    uuid;
  v_out      uuid;
  v_in       uuid;
  v_ts       timestamptz;
  v_date     date;
  v_reason   text := nullif(btrim(coalesce(p_over_reason, '')), '');
  v_over     boolean;
  v_numbers  text[] := '{}';
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'outsourcing_' || lower(coalesce(p_movement_type, '')));
  if v_previous is not null then return v_previous; end if;
  v_today := private.company_today(v_company);
  v_date := coalesce(p_movement_date, v_today);
  if p_movement_type not in ('DISPATCH', 'RETURN') then
    raise exception 'Movement type must be DISPATCH or RETURN.' using errcode = 'P0001';
  end if;

  select * into v_order from public.outsourcing_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Outsourcing order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED')
     and not (p_movement_type = 'RETURN' and v_order.status in ('COMPLETED', 'ON_HOLD', 'CANCELLED')) then
    raise exception 'Materials cannot be % for an order that is %.', case when p_movement_type = 'DISPATCH' then 'dispatched' else 'returned' end,
      v_order.status using errcode = 'P0001';
  end if;
  if v_order.external_location_id is null then
    raise exception 'This order has no materials to send to the supplier.' using errcode = 'P0001';
  end if;
  if v_date > v_today then
    raise exception 'The movement date cannot be in the future.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one material line.' using errcode = 'P0001';
  end if;
  v_ts := private.effective_timestamp(v_company, v_date);

  for v_input in select value from jsonb_array_elements(p_lines) loop
    select * into v_line from public.outsourcing_order_materials
    where id = (v_input ->> 'order_material_id')::uuid and outsourcing_order_id = v_order.id for update;
    if not found then
      raise exception 'A material line does not belong to this order.' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = v_line.component_product_id;
    begin
      v_qty := (v_input ->> 'quantity')::numeric;
    exception when others then
      raise exception '%: quantity must be a number.', v_product.sku using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception '%: enter a quantity greater than zero (up to 3 decimals).', v_product.sku using errcode = 'P0001';
    end if;
    select * into v_storage from public.inventory_locations where id = (v_input ->> 'location_id')::uuid and company_id = v_company;
    if not found or v_storage.stock_usage <> 'STORAGE' then
      raise exception '%: choose a normal storage location.', v_product.sku using errcode = 'P0001';
    end if;
    select * into v_lot from public.inventory_batches
    where id = (v_input ->> 'batch_id')::uuid and company_id = v_company and product_id = v_product.id;
    if not found then
      raise exception '%: the selected batch/lot does not belong to this material.', v_product.sku using errcode = 'P0001';
    end if;

    v_over := false;
    if p_movement_type = 'DISPATCH' then
      if v_line.dispatched_quantity - v_line.returned_quantity + v_qty > v_line.planned_quantity then
        v_over := true;
        if not private.has_permission(v_company, 'production_exception.approve') then
          raise exception '%: dispatching % would exceed the planned % %. This needs production_exception.approve.',
            v_product.sku, v_qty, v_line.planned_quantity, v_line.unit using errcode = '42501';
        end if;
        if v_reason is null or length(v_reason) < 5 then
          raise exception '%: dispatching more than planned requires a documented reason.', v_product.sku using errcode = 'P0001';
        end if;
      end if;
      v_from := v_storage.id;
      v_to := v_order.external_location_id;
    else
      if v_qty > v_line.dispatched_quantity - v_line.returned_quantity - v_line.consumed_quantity then
        raise exception '%: only % % is held at the supplier for this order.', v_product.sku,
          v_line.dispatched_quantity - v_line.returned_quantity - v_line.consumed_quantity, v_line.unit using errcode = 'P0001';
      end if;
      v_from := v_order.external_location_id;
      v_to := v_storage.id;
    end if;

    -- Lock both balance rows in a fixed order to avoid deadlocks.
    insert into public.inventory_balances (company_id, product_id, batch_id, warehouse_id, location_id, source_type)
    select v_company, v_lot.product_id, v_lot.id, l.warehouse_id, l.id, v_lot.source_type
    from public.inventory_locations l where l.id = v_to
    on conflict (batch_id, location_id) do nothing;
    perform 1 from public.inventory_balances where batch_id = v_lot.id and location_id in (v_from, v_to) order by location_id for update;

    v_group := gen_random_uuid();
    v_out := private.post_movement(v_company, 'TRANSFER_OUT', v_lot.id, v_from, v_qty, null,
      'OUTSOURCING_ORDER', v_order.outsourcing_order_number, v_order.id,
      case when p_movement_type = 'DISPATCH' then 'Material sent to ' || v_order.supplier_name || ' for ' || v_order.outsourcing_order_number
           else 'Material returned by ' || v_order.supplier_name || ' (' || v_order.outsourcing_order_number || ')' end,
      p_notes, v_ts, 'OUTSOURCING', v_order.id, v_group);
    v_in := private.post_movement(v_company, 'TRANSFER_IN', v_lot.id, v_to, v_qty, null,
      'OUTSOURCING_ORDER', v_order.outsourcing_order_number, v_order.id,
      case when p_movement_type = 'DISPATCH' then 'Material sent to ' || v_order.supplier_name || ' for ' || v_order.outsourcing_order_number
           else 'Material returned by ' || v_order.supplier_name || ' (' || v_order.outsourcing_order_number || ')' end,
      p_notes, v_ts, 'OUTSOURCING', v_order.id, v_group);

    insert into public.outsourcing_material_movements (company_id, outsourcing_order_id, order_material_id, component_product_id, movement_type,
      batch_id, from_location_id, to_location_id, quantity, unit, transfer_group_id, out_transaction_id, in_transaction_id, movement_date,
      over_dispatch_reason, notes, created_by)
    values (v_company, v_order.id, v_line.id, v_product.id, p_movement_type, v_lot.id, v_from, v_to, v_qty, v_line.unit, v_group, v_out, v_in,
      v_date, case when v_over then v_reason end, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid());

    if p_movement_type = 'DISPATCH' then
      update public.outsourcing_order_materials set dispatched_quantity = dispatched_quantity + v_qty where id = v_line.id;
    else
      update public.outsourcing_order_materials set returned_quantity = returned_quantity + v_qty where id = v_line.id;
    end if;
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_out);
  end loop;

  if p_movement_type = 'DISPATCH' then
    update public.outsourcing_orders
    set status = case when status = 'APPROVED' then 'MATERIALS_DISPATCHED' else status end,
        dispatch_date = coalesce(dispatch_date, v_date)
    where id = v_order.id;
  end if;
  perform private.log_outsourcing_event(v_company, v_order.id, 'MATERIALS_' || case when p_movement_type = 'DISPATCH' then 'DISPATCHED' else 'RETURNED' end,
    v_order.status, (select status from public.outsourcing_orders where id = v_order.id), v_reason,
    jsonb_build_object('transaction_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('transaction_numbers', to_jsonb(v_numbers),
    'status', (select status from public.outsourcing_orders where id = v_order.id)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Goods received from the supplier
-- p_consumption: [{order_material_id, batch_id, quantity}] material used by the
-- supplier, consumed from the order's external-processing location.
-- -----------------------------------------------------------------------------
create or replace function public.outsourcing_receive_goods(
  p_order_id                 uuid,
  p_received_quantity        numeric,
  p_accepted_quantity        numeric,
  p_rejected_quantity        numeric default 0,
  p_accepted_location_id     uuid default null,
  p_rejected_location_id     uuid default null,
  p_batch_number             text default null,
  p_manufacturing_date       date default null,
  p_expiry_date              date default null,
  p_receipt_date             date default null,
  p_unit_cost                numeric default null,
  p_supplier_document_number text default null,
  p_rejection_disposition    text default null,
  p_rejection_reason         text default null,
  p_over_receipt_reason      text default null,
  p_consumption              jsonb default '[]'::jsonb,
  p_notes                    text default null,
  p_idempotency_key          uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('outsourcing_receipt.create');
  v_today    date;
  v_previous jsonb;
  v_order    public.outsourcing_orders;
  v_product  public.products;
  v_acc_loc  public.inventory_locations;
  v_rej_loc  public.inventory_locations;
  v_recv     numeric := coalesce(p_received_quantity, 0);
  v_acc      numeric := coalesce(p_accepted_quantity, 0);
  v_rej      numeric := coalesce(p_rejected_quantity, 0);
  v_date     date;
  v_ts       timestamptz;
  v_lot      uuid;
  v_acc_tx   uuid;
  v_rej_tx   uuid;
  v_number   text;
  v_id       uuid;
  v_over     text := nullif(btrim(coalesce(p_over_receipt_reason, '')), '');
  v_rej_note text := nullif(btrim(coalesce(p_rejection_reason, '')), '');
  v_input    jsonb;
  v_line     public.outsourcing_order_materials;
  v_mat      public.inventory_batches;
  v_qty      numeric;
  v_tx       uuid;
  v_consumed int := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'outsourcing_receipt');
  if v_previous is not null then return v_previous; end if;
  v_today := private.company_today(v_company);
  v_date := coalesce(p_receipt_date, v_today);

  select * into v_order from public.outsourcing_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Outsourcing order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED') then
    raise exception 'Goods cannot be received on an order that is %.', v_order.status using errcode = 'P0001';
  end if;
  if v_order.order_type = 'OUTSOURCED_PROCESSING' and not exists (
       select 1 from public.outsourcing_order_materials where outsourcing_order_id = v_order.id and dispatched_quantity > 0) then
    raise exception 'Dispatch the materials to the supplier before receiving processed goods.' using errcode = 'P0001';
  end if;
  v_product := private.require_active_product(v_company, v_order.product_id);
  if v_recv <= 0 or v_acc < 0 or v_rej < 0 then
    raise exception 'Enter the received quantity and how much was accepted and rejected.' using errcode = 'P0001';
  end if;
  if v_recv <> round(v_recv, 3) or v_acc <> round(v_acc, 3) or v_rej <> round(v_rej, 3) then
    raise exception 'Quantities support at most 3 decimal places.' using errcode = 'P0001';
  end if;
  if v_acc + v_rej > v_recv then
    raise exception 'Accepted plus rejected (%) cannot exceed the quantity received (%).', v_acc + v_rej, v_recv using errcode = 'P0001';
  end if;
  if v_acc + v_rej < v_recv then
    raise exception 'Every received unit must be accepted or rejected: % of % is unclassified.', v_recv - v_acc - v_rej, v_recv using errcode = 'P0001';
  end if;
  if v_date > v_today then
    raise exception 'The receipt date cannot be in the future.' using errcode = 'P0001';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative.' using errcode = 'P0001';
  end if;
  if v_rej > 0 then
    if p_rejection_disposition is null or p_rejection_disposition not in ('RETURN_TO_SUPPLIER', 'HELD_FOR_REWORK', 'SCRAP', 'PENDING_DECISION') then
      raise exception 'Choose what happens to the rejected goods.' using errcode = 'P0001';
    end if;
    if v_rej_note is null then
      raise exception 'Enter the reason for the rejection.' using errcode = 'P0001';
    end if;
  elsif p_rejection_disposition is not null or p_rejected_location_id is not null then
    raise exception 'A rejection disposition or location was given but nothing was rejected.' using errcode = 'P0001';
  end if;

  if v_order.received_quantity + v_recv > v_order.ordered_quantity then
    if not private.has_permission(v_company, 'production_exception.approve') then
      raise exception 'This receipt would exceed the outstanding order quantity (% of %). An over-receipt needs production_exception.approve.',
        v_order.ordered_quantity - v_order.received_quantity, v_order.ordered_quantity using errcode = '42501';
    end if;
    if v_over is null or length(v_over) < 5 then
      raise exception 'Receiving more than ordered requires a documented reason.' using errcode = 'P0001';
    end if;
  else
    v_over := null;
  end if;

  if v_acc > 0 then
    select * into v_acc_loc from public.inventory_locations where id = p_accepted_location_id and company_id = v_company;
    if not found or v_acc_loc.warehouse_id <> v_order.destination_warehouse_id or v_acc_loc.stock_usage <> 'STORAGE' then
      raise exception 'Receive accepted goods into a storage location of the order''s destination warehouse.' using errcode = 'P0001';
    end if;
  end if;
  if p_rejected_location_id is not null then
    select * into v_rej_loc from public.inventory_locations where id = p_rejected_location_id and company_id = v_company;
    if not found or v_rej_loc.stock_usage <> 'REJECTED' then
      raise exception 'Rejected goods can only be stocked in a location designated for rejected (non-saleable) goods.' using errcode = 'P0001';
    end if;
  end if;

  if v_order.order_type = 'OUTSOURCED_PROCESSING'
     and (p_consumption is null or jsonb_typeof(p_consumption) <> 'array' or jsonb_array_length(p_consumption) = 0) then
    raise exception 'Record the company material the supplier used for these goods.' using errcode = 'P0001';
  end if;

  v_ts := private.effective_timestamp(v_company, v_date);
  v_number := private.next_document_number(v_company, 'OGR');
  if v_acc > 0 or p_rejected_location_id is not null then
    v_lot := private.ensure_batch(v_company, v_product.id, 'OUTSOURCED', p_batch_number, p_manufacturing_date, p_expiry_date, p_unit_cost,
      'OUTSOURCING_ORDER', v_order.id, coalesce(v_acc_loc.warehouse_id, v_rej_loc.warehouse_id), coalesce(v_acc_loc.id, v_rej_loc.id), false);
  end if;
  if v_acc > 0 then
    v_acc_tx := private.post_movement(v_company, 'SUBCONTRACT_RECEIPT', v_lot, v_acc_loc.id, v_acc, p_unit_cost,
      'OUTSOURCING_ORDER', v_order.outsourcing_order_number, v_order.id,
      'Received from ' || v_order.supplier_name || ' (' || v_number || ')', p_notes, v_ts, 'OUTSOURCING', v_order.id);
  end if;
  if p_rejected_location_id is not null then
    v_rej_tx := private.post_movement(v_company, 'SUBCONTRACT_RECEIPT', v_lot, v_rej_loc.id, v_rej, p_unit_cost,
      'OUTSOURCING_ORDER', v_order.outsourcing_order_number, v_order.id,
      'Rejected goods from ' || v_order.supplier_name || ' (' || v_number || '): ' || v_rej_note, p_notes, v_ts, 'OUTSOURCING', v_order.id);
  end if;

  insert into public.outsourcing_receipts (company_id, receipt_number, outsourcing_order_id, product_id, batch_id, received_quantity,
    accepted_quantity, rejected_quantity, unit, accepted_location_id, rejected_location_id, accepted_transaction_id, rejected_transaction_id,
    receipt_date, unit_cost, supplier_document_number, rejection_disposition, rejection_reason, over_receipt_reason, notes, created_by)
  values (v_company, v_number, v_order.id, v_product.id, v_lot, v_recv, v_acc, v_rej, v_order.unit,
    case when v_acc > 0 then v_acc_loc.id end, p_rejected_location_id, v_acc_tx, v_rej_tx, v_date, p_unit_cost,
    nullif(btrim(coalesce(p_supplier_document_number, '')), ''), case when v_rej > 0 then p_rejection_disposition end, v_rej_note, v_over,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  -- Material used up by the supplier (leaves the external-processing location).
  for v_input in select value from jsonb_array_elements(coalesce(p_consumption, '[]'::jsonb)) loop
    select * into v_line from public.outsourcing_order_materials
    where id = (v_input ->> 'order_material_id')::uuid and outsourcing_order_id = v_order.id for update;
    if not found then
      raise exception 'A consumed material line does not belong to this order.' using errcode = 'P0001';
    end if;
    select * into v_mat from public.inventory_batches
    where id = (v_input ->> 'batch_id')::uuid and company_id = v_company and product_id = v_line.component_product_id;
    if not found then
      raise exception 'The consumed batch/lot does not belong to the material.' using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_input ->> 'quantity')::numeric;
    exception when others then
      raise exception 'Consumed quantity must be a number.' using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Consumed quantities must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
    end if;
    if v_qty > v_line.dispatched_quantity - v_line.returned_quantity - v_line.consumed_quantity then
      raise exception 'Consumption of % exceeds the material held at the supplier for this order (%).',
        v_qty, v_line.dispatched_quantity - v_line.returned_quantity - v_line.consumed_quantity using errcode = 'P0001';
    end if;
    v_tx := private.post_movement(v_company, 'SUBCONTRACT_CONSUMPTION', v_mat.id, v_order.external_location_id, v_qty, null,
      'OUTSOURCING_ORDER', v_order.outsourcing_order_number, v_order.id,
      'Used by ' || v_order.supplier_name || ' for ' || v_order.outsourcing_order_number || ' (' || v_number || ')',
      null, v_ts, 'OUTSOURCING', v_order.id);
    insert into public.outsourcing_material_movements (company_id, outsourcing_order_id, order_material_id, component_product_id, movement_type,
      batch_id, from_location_id, quantity, unit, out_transaction_id, receipt_id, movement_date, created_by)
    values (v_company, v_order.id, v_line.id, v_line.component_product_id, 'CONSUMPTION', v_mat.id, v_order.external_location_id, v_qty,
      v_line.unit, v_tx, v_id, v_date, auth.uid());
    update public.outsourcing_order_materials set consumed_quantity = consumed_quantity + v_qty where id = v_line.id;
    v_consumed := v_consumed + 1;
  end loop;

  update public.outsourcing_orders
  set received_quantity = received_quantity + v_recv, accepted_quantity = accepted_quantity + v_acc, rejected_quantity = rejected_quantity + v_rej,
      status = case when status in ('APPROVED', 'MATERIALS_DISPATCHED') then 'PARTIALLY_RECEIVED' else status end
  where id = v_order.id;

  perform private.log_outsourcing_event(v_company, v_order.id, 'GOODS_RECEIVED', v_order.status,
    (select status from public.outsourcing_orders where id = v_order.id), v_over,
    jsonb_build_object('receipt_number', v_number, 'received', v_recv, 'accepted', v_acc, 'rejected', v_rej, 'consumption_lines', v_consumed));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'receipt_id', v_id, 'receipt_number', v_number, 'batch_id', v_lot,
    'accepted_transaction_number', (select transaction_number from public.inventory_transactions where id = v_acc_tx),
    'rejected_transaction_number', (select transaction_number from public.inventory_transactions where id = v_rej_tx)));
end;
$$;

-- Reverses a goods receipt: accepted / rejected stock and the supplier
-- consumption recorded with it (material goes back to the supplier location).
create or replace function public.outsourcing_reverse_receipt(p_receipt_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_exception.approve');
  v_previous jsonb;
  v_row      public.outsourcing_receipts;
  v_order    public.outsourcing_orders;
  v_mov      public.outsourcing_material_movements;
  v_numbers  text[] := '{}';
  v_part     text[];
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'outsourcing_receipt_reversal');
  if v_previous is not null then return v_previous; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Enter the reason for the reversal.' using errcode = 'P0001';
  end if;

  select * into v_row from public.outsourcing_receipts where id = p_receipt_id and company_id = v_company for update;
  if not found then
    raise exception 'Receipt not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_order from public.outsourcing_orders where id = v_row.outsourcing_order_id for update;
  if v_row.status <> 'POSTED' then
    raise exception 'This receipt has already been reversed.' using errcode = 'P0001';
  end if;
  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'Receipts of a % order cannot be reversed.', lower(v_order.status) using errcode = 'P0001';
  end if;

  if v_row.accepted_transaction_id is not null then
    v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_row.accepted_transaction_id, p_reason);
  end if;
  if v_row.rejected_transaction_id is not null then
    v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_row.rejected_transaction_id, p_reason);
  end if;
  for v_mov in
    select * from public.outsourcing_material_movements where receipt_id = v_row.id and status = 'POSTED' for update
  loop
    v_part := private.reverse_ledger_transaction(v_company, v_mov.out_transaction_id, p_reason);
    v_numbers := v_numbers || v_part;
    update public.outsourcing_material_movements
    set status = 'REVERSED', reversal_transaction_ids = v_part, reversal_reason = btrim(p_reason), reversed_by = auth.uid(), reversed_at = now()
    where id = v_mov.id;
    update public.outsourcing_order_materials set consumed_quantity = consumed_quantity - v_mov.quantity where id = v_mov.order_material_id;
  end loop;

  update public.outsourcing_receipts
  set status = 'REVERSED', reversal_transaction_ids = v_numbers, reversal_reason = btrim(p_reason), reversed_by = auth.uid(), reversed_at = now()
  where id = v_row.id;
  update public.outsourcing_orders
  set received_quantity = received_quantity - v_row.received_quantity, accepted_quantity = accepted_quantity - v_row.accepted_quantity,
      rejected_quantity = rejected_quantity - v_row.rejected_quantity,
      status = case when status = 'PARTIALLY_RECEIVED' and received_quantity - v_row.received_quantity = 0 then
                 case when exists (select 1 from public.outsourcing_order_materials m where m.outsourcing_order_id = v_order.id and m.dispatched_quantity > 0)
                      then 'MATERIALS_DISPATCHED' else 'APPROVED' end
               else status end
  where id = v_order.id;

  perform private.log_outsourcing_event(v_company, v_order.id, 'RECEIPT_REVERSED', v_order.status,
    (select status from public.outsourcing_orders where id = v_order.id), p_reason,
    jsonb_build_object('receipt_number', v_row.receipt_number, 'reversal_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- List views (security_invoker)
-- -----------------------------------------------------------------------------
create or replace view public.outsourcing_order_list
with (security_invoker = true) as
select
  o.*, p.sku, p.product_name, w.warehouse_code as destination_warehouse_code,
  l.location_code as external_location_code, l.external_holder,
  greatest(o.ordered_quantity - o.received_quantity, 0) as pending_quantity,
  coalesce(m.lines, 0) as material_lines,
  coalesce(m.held_lines, 0) as material_lines_held
from public.outsourcing_orders o
join public.products p on p.id = o.product_id
left join public.warehouses w on w.id = o.destination_warehouse_id
left join public.inventory_locations l on l.id = o.external_location_id
left join (
  select outsourcing_order_id, count(*) as lines,
    count(*) filter (where dispatched_quantity - returned_quantity - consumed_quantity > 0) as held_lines
  from public.outsourcing_order_materials group by outsourcing_order_id
) m on m.outsourcing_order_id = o.id;

create or replace view public.outsourcing_receipt_list
with (security_invoker = true) as
select
  r.*, o.outsourcing_order_number, o.order_type, o.supplier_name, o.status as order_status,
  p.sku, p.product_name, bt.batch_number,
  al.location_code as accepted_location_code, aw.warehouse_code as accepted_warehouse_code,
  rl.location_code as rejected_location_code,
  at.transaction_number as accepted_transaction_number, rt.transaction_number as rejected_transaction_number
from public.outsourcing_receipts r
join public.outsourcing_orders o on o.id = r.outsourcing_order_id
join public.products p on p.id = r.product_id
left join public.inventory_batches bt on bt.id = r.batch_id
left join public.inventory_locations al on al.id = r.accepted_location_id
left join public.warehouses aw on aw.id = al.warehouse_id
left join public.inventory_locations rl on rl.id = r.rejected_location_id
left join public.inventory_transactions at on at.id = r.accepted_transaction_id
left join public.inventory_transactions rt on rt.id = r.rejected_transaction_id;

create or replace view public.outsourcing_movement_list
with (security_invoker = true) as
select
  m.*, o.outsourcing_order_number, o.supplier_name, p.sku, p.product_name, bt.batch_number,
  fl.location_code as from_location_code, tl.location_code as to_location_code,
  t.transaction_number as out_transaction_number
from public.outsourcing_material_movements m
join public.outsourcing_orders o on o.id = m.outsourcing_order_id
join public.products p on p.id = m.component_product_id
left join public.inventory_batches bt on bt.id = m.batch_id
left join public.inventory_locations fl on fl.id = m.from_location_id
left join public.inventory_locations tl on tl.id = m.to_location_id
left join public.inventory_transactions t on t.id = m.out_transaction_id;

revoke all on public.outsourcing_order_list, public.outsourcing_receipt_list, public.outsourcing_movement_list from anon, authenticated;
grant select on public.outsourcing_order_list, public.outsourcing_receipt_list, public.outsourcing_movement_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.outsourcing_save_order(uuid, text, uuid, uuid, numeric, text, text, date, uuid, uuid, text, numeric, text, jsonb, uuid)',
    'public.outsourcing_order_action(uuid, text, text, uuid)',
    'public.outsourcing_move_materials(uuid, text, jsonb, date, text, text, uuid)',
    'public.outsourcing_receive_goods(uuid, numeric, numeric, numeric, uuid, uuid, text, date, date, date, numeric, text, text, text, text, jsonb, text, uuid)',
    'public.outsourcing_reverse_receipt(uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

create or replace view public.outsourcing_material_list
with (security_invoker = true) as
select m.*, p.sku, p.product_name, p.base_unit as inventory_unit,
  m.dispatched_quantity - m.returned_quantity - m.consumed_quantity as held_quantity
from public.outsourcing_order_materials m
join public.products p on p.id = m.component_product_id;

revoke all on public.outsourcing_material_list from anon, authenticated;
grant select on public.outsourcing_material_list to authenticated;
