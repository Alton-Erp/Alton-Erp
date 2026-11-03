-- =============================================================================
-- Phase 5: production orders, material reservation / issue, finished-goods
-- output receipts and their history.
--
--   production_orders                header; keeps the exact BOM version used
--   production_order_materials       material plan snapshot (from that BOM version)
--   production_material_consumption  one row per posted material issue (ledger-linked)
--   production_output_receipts       one row per posted output receipt (ledger-linked)
--   production_order_events          status / activity history
--
-- Stock only changes through private.post_movement (Phase 4 ledger):
--   material issue   -> PRODUCTION_ISSUE   (reservations fulfilled atomically)
--   good output      -> PRODUCTION_RECEIPT into a STORAGE location
--   rejected output  -> PRODUCTION_RECEIPT into a REJECTED (non-saleable)
--                       location, or recorded only (not stocked)
--   scrap            -> recorded only (never stocked, no value assumed)
-- Nothing moves stock on create, approve or start. Corrections are reversals.
-- =============================================================================

create table if not exists public.production_orders (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  production_order_number  text not null,
  finished_product_id      uuid not null,
  bom_id                   uuid not null,
  bom_code                 text not null,
  bom_version              integer not null,
  unit                     text not null,
  planned_quantity         numeric(14,3) not null check (planned_quantity > 0),
  completed_quantity       numeric(14,3) not null default 0 check (completed_quantity >= 0),
  rejected_quantity        numeric(14,3) not null default 0 check (rejected_quantity >= 0),
  scrap_quantity           numeric(14,3) not null default 0 check (scrap_quantity >= 0),
  actual_quantity          numeric(14,3) generated always as (completed_quantity + rejected_quantity + scrap_quantity) stored,
  status                   text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED',
                             'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'ON_HOLD', 'CANCELLED')),
  status_before_hold       text,
  priority                 text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  source_warehouse_id      uuid not null,
  destination_warehouse_id uuid not null,
  planned_start_date       date not null,
  target_completion_date   date not null,
  actual_start_date        date,
  actual_completion_date   date,
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
  started_by               uuid,
  completed_by             uuid,
  completed_at             timestamptz,
  cancelled_by             uuid,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint production_orders_number_unique unique (company_id, production_order_number),
  constraint production_orders_id_company_unique unique (id, company_id),
  constraint production_orders_dates check (target_completion_date >= planned_start_date),
  constraint production_orders_product_fk foreign key (finished_product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint production_orders_bom_fk foreign key (bom_id, company_id) references public.boms (id, company_id) on delete restrict,
  constraint production_orders_source_wh_fk foreign key (source_warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict,
  constraint production_orders_dest_wh_fk foreign key (destination_warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict
);

create index if not exists production_orders_status_idx on public.production_orders (company_id, status);
create index if not exists production_orders_product_idx on public.production_orders (company_id, finished_product_id);

create table if not exists public.production_order_materials (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  production_order_id  uuid not null,
  line_no              integer not null,
  component_product_id uuid not null,
  unit                 text not null,
  quantity_per_unit    numeric(18,6) not null check (quantity_per_unit > 0),
  wastage_percentage   numeric(5,2) not null default 0,
  base_quantity        numeric(14,3) not null check (base_quantity > 0),
  planned_quantity     numeric(14,3) not null check (planned_quantity > 0),
  issued_quantity      numeric(14,3) not null default 0 check (issued_quantity >= 0),
  constraint production_order_materials_order_fk foreign key (production_order_id, company_id)
    references public.production_orders (id, company_id) on delete restrict,
  constraint production_order_materials_product_fk foreign key (component_product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint production_order_materials_unique unique (production_order_id, component_product_id),
  constraint production_order_materials_id_company_unique unique (id, company_id)
);

comment on table public.production_order_materials is
  'Material plan of a production order, snapshotted from its BOM version: planned = base requirement plus wastage. issued_quantity is net of reversals.';

create table if not exists public.production_material_consumption (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  production_order_id      uuid not null,
  order_material_id        uuid not null,
  component_product_id     uuid not null,
  batch_id                 uuid not null,
  warehouse_id             uuid not null,
  location_id              uuid not null,
  planned_quantity         numeric(14,3) not null,
  actual_quantity          numeric(14,3) not null check (actual_quantity > 0),
  unit                     text not null,
  reserved_quantity_used   numeric(14,3) not null default 0 check (reserved_quantity_used >= 0),
  inventory_transaction_id uuid not null references public.inventory_transactions (id) on delete restrict,
  consumption_date         date not null,
  over_issue_reason        text check (over_issue_reason is null or length(over_issue_reason) <= 500),
  notes                    text check (notes is null or length(notes) <= 1000),
  status                   text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_transaction_ids text[],
  reversal_reason          text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by              uuid,
  reversed_at              timestamptz,
  recorded_by              uuid,
  created_at               timestamptz not null default now(),
  constraint production_consumption_tx_unique unique (inventory_transaction_id),
  constraint production_consumption_order_fk foreign key (production_order_id, company_id)
    references public.production_orders (id, company_id) on delete restrict,
  constraint production_consumption_material_fk foreign key (order_material_id, company_id)
    references public.production_order_materials (id, company_id) on delete restrict,
  constraint production_consumption_batch_fk foreign key (batch_id, component_product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint production_consumption_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create index if not exists production_consumption_order_idx on public.production_material_consumption (production_order_id);
create index if not exists production_consumption_batch_idx on public.production_material_consumption (batch_id);
create index if not exists production_consumption_date_idx on public.production_material_consumption (company_id, consumption_date);

create table if not exists public.production_output_receipts (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  receipt_number          text not null,
  production_order_id     uuid not null,
  product_id              uuid not null,
  batch_id                uuid,
  good_quantity           numeric(14,3) not null default 0 check (good_quantity >= 0),
  rejected_quantity       numeric(14,3) not null default 0 check (rejected_quantity >= 0),
  scrap_quantity          numeric(14,3) not null default 0 check (scrap_quantity >= 0),
  unit                    text not null,
  good_location_id        uuid,
  rejected_location_id    uuid,
  good_transaction_id     uuid references public.inventory_transactions (id) on delete restrict,
  rejected_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  production_date         date not null,
  unit_cost               numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  quality_status          text not null default 'NOT_INSPECTED' check (quality_status in ('NOT_INSPECTED', 'ACCEPTED', 'ACCEPTED_WITH_DEVIATION')),
  rejection_reason        text check (rejection_reason is null or length(rejection_reason) <= 500),
  over_production_reason  text check (over_production_reason is null or length(over_production_reason) <= 500),
  notes                   text check (notes is null or length(notes) <= 1000),
  status                  text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversal_transaction_ids text[],
  reversal_reason         text check (reversal_reason is null or length(reversal_reason) <= 500),
  reversed_by             uuid,
  reversed_at             timestamptz,
  created_by              uuid,
  created_at              timestamptz not null default now(),
  constraint production_output_number_unique unique (company_id, receipt_number),
  constraint production_output_some_quantity check (good_quantity + rejected_quantity + scrap_quantity > 0),
  constraint production_output_good_tx_unique unique (good_transaction_id),
  constraint production_output_rejected_tx_unique unique (rejected_transaction_id),
  constraint production_output_good_has_tx check ((good_quantity > 0) = (good_transaction_id is not null)),
  constraint production_output_order_fk foreign key (production_order_id, company_id)
    references public.production_orders (id, company_id) on delete restrict,
  constraint production_output_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict
);

create index if not exists production_output_order_idx on public.production_output_receipts (production_order_id);
create index if not exists production_output_batch_idx on public.production_output_receipts (batch_id);
create index if not exists production_output_date_idx on public.production_output_receipts (company_id, production_date);

create table if not exists public.production_order_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  production_order_id uuid not null,
  event_type          text not null,
  from_status         text,
  to_status           text,
  note                text,
  details             jsonb not null default '{}'::jsonb,
  actor_user_id       uuid,
  created_at          timestamptz not null default now(),
  constraint production_events_order_fk foreign key (production_order_id, company_id)
    references public.production_orders (id, company_id) on delete restrict
);

create index if not exists production_events_order_idx on public.production_order_events (production_order_id, created_at);

-- -----------------------------------------------------------------------------
-- Immutability of posted documents and history
-- -----------------------------------------------------------------------------
-- Posted issue / receipt rows may only change once: POSTED -> REVERSED.
create or replace function private.guard_posted_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutable text[] := array['status', 'reversal_transaction_ids', 'reversal_reason', 'reversed_by', 'reversed_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Posted records cannot be deleted. Reverse them instead.' using errcode = '42501';
  end if;
  if old.status <> 'POSTED' or new.status <> 'REVERSED'
     or (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'Posted records cannot be changed; only a single reversal is allowed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.prevent_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'History records cannot be changed or deleted.' using errcode = '42501';
end;
$$;

revoke all on function private.guard_posted_document() from public, anon, authenticated;
revoke all on function private.prevent_history_mutation() from public, anon, authenticated;

drop trigger if exists production_consumption_guard on public.production_material_consumption;
create trigger production_consumption_guard before update or delete on public.production_material_consumption
  for each row execute function private.guard_posted_document();
drop trigger if exists production_output_guard on public.production_output_receipts;
create trigger production_output_guard before update or delete on public.production_output_receipts
  for each row execute function private.guard_posted_document();
drop trigger if exists production_events_append_only on public.production_order_events;
create trigger production_events_append_only before update or delete on public.production_order_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists production_orders_set_updated_at on public.production_orders;
create trigger production_orders_set_updated_at before update on public.production_orders
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: read only for clients
-- -----------------------------------------------------------------------------
alter table public.production_orders enable row level security;
alter table public.production_order_materials enable row level security;
alter table public.production_material_consumption enable row level security;
alter table public.production_output_receipts enable row level security;
alter table public.production_order_events enable row level security;

revoke all on table public.production_orders, public.production_order_materials, public.production_material_consumption,
  public.production_output_receipts, public.production_order_events from anon, authenticated;
grant select on public.production_orders, public.production_order_materials, public.production_material_consumption,
  public.production_output_receipts, public.production_order_events to authenticated;
grant all on table public.production_orders, public.production_order_materials, public.production_material_consumption,
  public.production_output_receipts, public.production_order_events to service_role;

drop policy if exists production_orders_select on public.production_orders;
create policy production_orders_select on public.production_orders for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));
drop policy if exists production_order_materials_select on public.production_order_materials;
create policy production_order_materials_select on public.production_order_materials for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));
drop policy if exists production_consumption_select on public.production_material_consumption;
create policy production_consumption_select on public.production_material_consumption for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));
drop policy if exists production_output_select on public.production_output_receipts;
create policy production_output_select on public.production_output_receipts for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));
drop policy if exists production_events_select on public.production_order_events;
create policy production_events_select on public.production_order_events for select to authenticated
  using (private.has_permission(company_id, 'manufacturing.read'));

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function private.log_production_event(
  p_company uuid, p_order uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.production_order_events (company_id, production_order_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_order, p_event, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_company, 'production.order_' || lower(p_event), 'production_order', p_order::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('from_status', p_from, 'to_status', p_to, 'note', p_note));
end;
$$;

revoke all on function private.log_production_event(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- Open (unissued) reserved quantity of a component for an order.
create or replace function private.order_open_reserved(p_order uuid, p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0)
  from public.stock_reservations
  where reference_type = 'PRODUCTION_ORDER' and reference_id = p_order and product_id = p_product
    and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED');
$$;

revoke all on function private.order_open_reserved(uuid, uuid) from public, anon, authenticated;

create or replace function private.release_order_reservations(p_order public.production_orders, p_status text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res   public.stock_reservations;
  v_total numeric := 0;
begin
  for v_res in
    select * from public.stock_reservations
    where company_id = p_order.company_id and reference_type = 'PRODUCTION_ORDER' and reference_id = p_order.id
      and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
    order by location_id, batch_id
    for update
  loop
    v_total := v_total + private.release_reservation_remaining(v_res, p_status);
  end loop;
  return v_total;
end;
$$;

revoke all on function private.release_order_reservations(public.production_orders, text) from public, anon, authenticated;

-- Discrepancies that block completion unless an authorised exception is recorded.
--   OUTPUT_SHORT          total output (good + rejected + scrap) below the planned quantity
--   MATERIAL_UNDER_ISSUED a component issued below its standard requirement for the
--                         actual output (output not supported by recorded material)
create or replace function private.production_discrepancies(p_order public.production_orders)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(d), '[]'::jsonb) from (
    select jsonb_build_object('type', 'OUTPUT_SHORT', 'planned', p_order.planned_quantity, 'actual', p_order.actual_quantity) as d
    where p_order.actual_quantity < p_order.planned_quantity
    union all
    select jsonb_build_object('type', 'MATERIAL_UNDER_ISSUED', 'sku', p.sku, 'issued', m.issued_quantity,
      'expected', private.ceil_qty(m.quantity_per_unit * p_order.actual_quantity), 'unit', m.unit)
    from public.production_order_materials m
    join public.products p on p.id = m.component_product_id
    where m.production_order_id = p_order.id
      and m.issued_quantity < private.ceil_qty(m.quantity_per_unit * p_order.actual_quantity)
  ) x;
$$;

revoke all on function private.production_discrepancies(public.production_orders) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Create / edit a draft order (snapshot of the BOM material plan)
-- -----------------------------------------------------------------------------
create or replace function public.production_save_order(
  p_order_id                 uuid,
  p_bom_id                   uuid,
  p_planned_quantity         numeric,
  p_source_warehouse_id      uuid,
  p_destination_warehouse_id uuid,
  p_planned_start_date       date,
  p_target_completion_date   date,
  p_priority                 text default 'NORMAL',
  p_notes                    text default null,
  p_idempotency_key          uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_any_permission(array['production_order.create', 'production_order.update']);
  v_today    date := private.company_today(v_company);
  v_previous jsonb;
  v_order    public.production_orders;
  v_bom      public.boms;
  v_product  public.products;
  v_bad      record;
begin
  if p_order_id is null then
    if not private.has_permission(v_company, 'production_order.create') then
      raise exception 'You are not allowed to create production orders (requires production_order.create).' using errcode = '42501';
    end if;
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_order_create');
    if v_previous is not null then return v_previous; end if;
  else
    select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
    if not found then
      raise exception 'Production order not found in your company.' using errcode = 'P0001';
    end if;
    if v_order.status <> 'DRAFT' then
      raise exception 'Only draft production orders can be edited.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_order.update') or v_order.created_by = auth.uid()) then
      raise exception 'You can only edit your own draft orders (requires production_order.update).' using errcode = '42501';
    end if;
  end if;

  select * into v_bom from public.boms where id = p_bom_id and company_id = v_company;
  if not found then
    raise exception 'BOM not found in your company.' using errcode = 'P0001';
  end if;
  if v_bom.status <> 'APPROVED' or v_bom.effective_from > v_today or (v_bom.effective_to is not null and v_bom.effective_to < v_today) then
    raise exception 'BOM % v% is not approved and currently effective. Select the current approved version.', v_bom.bom_code, v_bom.version
      using errcode = 'P0001';
  end if;
  v_product := private.require_active_product(v_company, v_bom.finished_product_id);
  if v_product.base_unit <> v_bom.output_unit then
    raise exception 'The unit of % (%) no longer matches its BOM output unit (%).', v_product.sku, v_product.base_unit, v_bom.output_unit
      using errcode = 'P0001';
  end if;
  if p_planned_quantity is null or p_planned_quantity <= 0 or p_planned_quantity <> round(p_planned_quantity, 3) then
    raise exception 'Enter a planned quantity greater than zero (up to 3 decimals).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.warehouses where id = p_source_warehouse_id and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Select an active source warehouse for raw materials.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.warehouses where id = p_destination_warehouse_id and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Select an active destination warehouse for finished goods.' using errcode = 'P0001';
  end if;
  if p_planned_start_date is null or p_target_completion_date is null then
    raise exception 'Enter the planned start and target completion dates.' using errcode = 'P0001';
  end if;
  if p_target_completion_date < p_planned_start_date then
    raise exception 'The target completion date cannot be before the planned start date.' using errcode = 'P0001';
  end if;
  if coalesce(p_priority, 'NORMAL') not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Priority must be LOW, NORMAL, HIGH or URGENT.' using errcode = 'P0001';
  end if;

  select * into v_bad from private.bom_requirement_lines(v_bom.id, p_planned_quantity) r
  where not r.unit_matches or not r.component_active limit 1;
  if found then
    raise exception 'Component % cannot be planned: %.', v_bad.sku,
      case when not v_bad.unit_matches then format('BOM unit %s differs from inventory unit %s', v_bad.unit, v_bad.inventory_unit)
           else 'it is inactive' end using errcode = 'P0001';
  end if;

  if p_order_id is null then
    insert into public.production_orders (company_id, production_order_number, finished_product_id, bom_id, bom_code, bom_version, unit,
      planned_quantity, priority, source_warehouse_id, destination_warehouse_id, planned_start_date, target_completion_date, notes, created_by)
    values (v_company, private.next_document_number(v_company, 'PRD'), v_product.id, v_bom.id, v_bom.bom_code, v_bom.version, v_product.base_unit,
      p_planned_quantity, coalesce(p_priority, 'NORMAL'), p_source_warehouse_id, p_destination_warehouse_id, p_planned_start_date,
      p_target_completion_date, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
    returning * into v_order;
    perform private.log_production_event(v_company, v_order.id, 'CREATED', null, 'DRAFT', null,
      jsonb_build_object('production_order_number', v_order.production_order_number, 'bom_code', v_bom.bom_code, 'bom_version', v_bom.version));
  else
    update public.production_orders
    set finished_product_id = v_product.id, bom_id = v_bom.id, bom_code = v_bom.bom_code, bom_version = v_bom.version, unit = v_product.base_unit,
        planned_quantity = p_planned_quantity, priority = coalesce(p_priority, 'NORMAL'), source_warehouse_id = p_source_warehouse_id,
        destination_warehouse_id = p_destination_warehouse_id, planned_start_date = p_planned_start_date,
        target_completion_date = p_target_completion_date, notes = nullif(btrim(coalesce(p_notes, '')), '')
    where id = v_order.id
    returning * into v_order;
    delete from public.production_order_materials where production_order_id = v_order.id;
    perform private.log_production_event(v_company, v_order.id, 'UPDATED', 'DRAFT', 'DRAFT', null,
      jsonb_build_object('planned_quantity', p_planned_quantity, 'bom_version', v_bom.version));
  end if;

  insert into public.production_order_materials (company_id, production_order_id, line_no, component_product_id, unit,
    quantity_per_unit, wastage_percentage, base_quantity, planned_quantity)
  select v_company, v_order.id, r.line_no, r.component_product_id, r.unit, r.quantity_per_unit, r.wastage_percentage,
    r.base_requirement, r.total_requirement
  from private.bom_requirement_lines(v_bom.id, p_planned_quantity) r;

  v_previous := jsonb_build_object('order_id', v_order.id, 'production_order_number', v_order.production_order_number);
  if p_order_id is null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- -----------------------------------------------------------------------------
-- Status workflow (server-validated transitions)
-- SUBMIT | WITHDRAW | APPROVE | REJECT | START | HOLD | RESUME | CANCEL | COMPLETE
-- -----------------------------------------------------------------------------
create or replace function public.production_order_action(
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
  v_company  uuid := private.require_permission('manufacturing.read');
  v_today    date := private.company_today(v_company);
  v_previous jsonb;
  v_order    public.production_orders;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_to       text;
  v_disc     jsonb;
  v_released numeric := 0;
begin
  if p_idempotency_key is not null then
    v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_order_action');
    if v_previous is not null then return v_previous; end if;
  end if;
  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'The note is limited to 1000 characters.' using errcode = 'P0001';
  end if;

  case p_action
  when 'SUBMIT' then
    if v_order.status <> 'DRAFT' then
      raise exception 'Only draft orders can be submitted (order is %).', v_order.status using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_order.update')
            or (private.has_permission(v_company, 'production_order.create') and v_order.created_by = auth.uid())) then
      raise exception 'You are not allowed to submit this order.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.production_order_materials where production_order_id = v_order.id) then
      raise exception 'The order has no material plan.' using errcode = 'P0001';
    end if;
    v_to := 'PENDING_APPROVAL';
    update public.production_orders set status = v_to, submitted_by = auth.uid(), submitted_at = now(), review_note = null where id = v_order.id;

  when 'WITHDRAW' then
    if v_order.status <> 'PENDING_APPROVAL' then
      raise exception 'Only orders awaiting approval can be withdrawn.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_order.update') or v_order.submitted_by = auth.uid()) then
      raise exception 'You are not allowed to withdraw this order.' using errcode = '42501';
    end if;
    v_to := 'DRAFT';
    update public.production_orders set status = v_to where id = v_order.id;

  when 'APPROVE', 'REJECT' then
    perform private.require_permission('production_order.approve');
    if v_order.status <> 'PENDING_APPROVAL' then
      raise exception 'This order is not awaiting approval (order is %).', v_order.status using errcode = 'P0001';
    end if;
    if p_action = 'REJECT' then
      if v_note is null then
        raise exception 'Enter the reason for rejecting the order.' using errcode = 'P0001';
      end if;
      v_to := 'DRAFT';
      update public.production_orders set status = v_to, review_note = v_note where id = v_order.id;
    else
      perform private.assert_not_self_approval(v_company, v_order.created_by, v_order.submitted_by);
      v_to := 'APPROVED';
      update public.production_orders set status = v_to, approved_by = auth.uid(), approved_at = now(), review_note = v_note where id = v_order.id;
    end if;

  when 'START' then
    perform private.require_permission('production_order.update');
    if v_order.status not in ('APPROVED', 'MATERIALS_RESERVED') then
      raise exception 'Only approved orders can be started (order is %).', v_order.status using errcode = 'P0001';
    end if;
    v_to := 'IN_PROGRESS';
    update public.production_orders set status = v_to, actual_start_date = coalesce(actual_start_date, v_today), started_by = auth.uid()
    where id = v_order.id;

  when 'HOLD' then
    perform private.require_permission('production_order.update');
    if v_order.status not in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED') then
      raise exception 'An order that is % cannot be put on hold.', v_order.status using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for the hold.' using errcode = 'P0001';
    end if;
    v_to := 'ON_HOLD';
    update public.production_orders set status = v_to, status_before_hold = v_order.status, hold_reason = v_note where id = v_order.id;

  when 'RESUME' then
    perform private.require_permission('production_order.update');
    if v_order.status <> 'ON_HOLD' then
      raise exception 'Only orders on hold can be resumed.' using errcode = 'P0001';
    end if;
    v_to := v_order.status_before_hold;
    update public.production_orders set status = v_to, status_before_hold = null where id = v_order.id;

  when 'CANCEL' then
    perform private.require_permission('production_order.cancel');
    if v_order.status in ('COMPLETED', 'CANCELLED', 'PARTIALLY_COMPLETED') then
      raise exception 'An order that is % cannot be cancelled.', v_order.status using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for cancelling the order.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED')
       or exists (select 1 from public.production_output_receipts where production_order_id = v_order.id and status = 'POSTED') then
      raise exception 'Materials have been issued or output received for this order. Reverse those postings before cancelling.' using errcode = 'P0001';
    end if;
    v_released := private.release_order_reservations(v_order, 'CANCELLED');
    v_to := 'CANCELLED';
    update public.production_orders set status = v_to, cancel_reason = v_note, cancelled_by = auth.uid(), cancelled_at = now()
    where id = v_order.id;

  when 'COMPLETE' then
    perform private.require_permission('production_order.complete');
    if v_order.status not in ('IN_PROGRESS', 'PARTIALLY_COMPLETED') then
      raise exception 'Only orders in production can be completed (order is %).', v_order.status using errcode = 'P0001';
    end if;
    if v_order.actual_quantity = 0 then
      raise exception 'Record the production output before completing the order.' using errcode = 'P0001';
    end if;
    v_disc := private.production_discrepancies(v_order);
    if jsonb_array_length(v_disc) > 0 then
      if not private.has_permission(v_company, 'production_exception.approve') then
        raise exception 'The order has unresolved output or material discrepancies. A user with production_exception.approve must complete it with a documented reason.'
          using errcode = '42501';
      end if;
      if v_note is null or length(v_note) < 5 then
        raise exception 'The order has output or material discrepancies: document the reason for completing it anyway.' using errcode = 'P0001';
      end if;
    end if;
    v_released := private.release_order_reservations(v_order, 'RELEASED');
    v_to := 'COMPLETED';
    update public.production_orders
    set status = v_to, completion_note = v_note, actual_completion_date = v_today, completed_by = auth.uid(), completed_at = now()
    where id = v_order.id;
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;

  perform private.log_production_event(v_company, v_order.id, p_action, v_order.status, v_to, v_note,
    jsonb_build_object('production_order_number', v_order.production_order_number, 'released_reservation_quantity', v_released,
                       'discrepancies', coalesce(v_disc, '[]'::jsonb)));

  v_previous := jsonb_build_object('status', v_to, 'released_reservation_quantity', v_released, 'discrepancies', coalesce(v_disc, '[]'::jsonb));
  if p_idempotency_key is not null then
    return private.idempotency_finish(v_company, p_idempotency_key, v_previous);
  end if;
  return v_previous;
end;
$$;

-- -----------------------------------------------------------------------------
-- Material reservation (existing stock_reservations, FEFO allocation)
-- Reserves the outstanding requirement (planned - issued - already reserved)
-- from usable stock in the order's source warehouse. Balance rows are locked,
-- so concurrent orders can never reserve the same units. Without
-- p_allow_partial, a shortage of any component reserves nothing.
-- -----------------------------------------------------------------------------
create or replace function public.production_reserve_materials(
  p_order_id        uuid,
  p_allow_partial   boolean default false,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('production_material.reserve');
  v_today     date := private.company_today(v_company);
  v_previous  jsonb;
  v_order     public.production_orders;
  v_line      record;
  v_bal       record;
  v_need      numeric;
  v_take      numeric;
  v_created   jsonb := '[]'::jsonb;
  v_short     jsonb := '[]'::jsonb;
  v_number    text;
  v_complete  boolean;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_reserve');
  if v_previous is not null then return v_previous; end if;

  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Materials can only be reserved for approved orders (order is %).', v_order.status using errcode = 'P0001';
  end if;

  for v_line in
    select m.*, p.sku, p.base_unit, p.status as product_status, p.archived_at
    from public.production_order_materials m join public.products p on p.id = m.component_product_id
    where m.production_order_id = v_order.id
    order by m.line_no
    for update of m
  loop
    v_need := v_line.planned_quantity - v_line.issued_quantity - private.order_open_reserved(v_order.id, v_line.component_product_id);
    continue when v_need <= 0;
    if v_line.unit <> v_line.base_unit then
      raise exception '%: BOM unit % differs from inventory unit %; materials cannot be reserved.', v_line.sku, v_line.unit, v_line.base_unit
        using errcode = 'P0001';
    end if;

    for v_bal in
      select b.id, b.batch_id, b.location_id, b.warehouse_id, b.on_hand, b.reserved
      from public.inventory_balances b
      join public.inventory_locations l on l.id = b.location_id and l.stock_usage = 'STORAGE' and l.status = 'ACTIVE'
      join public.inventory_batches bt on bt.id = b.batch_id
      where b.company_id = v_company and b.product_id = v_line.component_product_id
        and b.warehouse_id = v_order.source_warehouse_id and b.on_hand - b.reserved > 0
        and (bt.expiry_date is null or bt.expiry_date >= v_today)
      order by bt.expiry_date nulls last, bt.created_at, b.location_id
      for update of b
    loop
      v_take := least(v_need, v_bal.on_hand - v_bal.reserved);
      continue when v_take <= 0;
      update public.inventory_balances set reserved = reserved + v_take, updated_at = now() where id = v_bal.id;
      v_number := private.next_document_number(v_company, 'RES');
      insert into public.stock_reservations (company_id, reservation_number, product_id, batch_id, warehouse_id, location_id,
        quantity, reference_type, reference_number, reference_id, notes, reserved_by)
      values (v_company, v_number, v_line.component_product_id, v_bal.batch_id, v_bal.warehouse_id, v_bal.location_id, v_take,
        'PRODUCTION_ORDER', v_order.production_order_number, v_order.id, 'Material for ' || v_order.production_order_number, auth.uid());
      v_created := v_created || jsonb_build_object('reservation_number', v_number, 'sku', v_line.sku, 'quantity', v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;

    if v_need > 0 then
      v_short := v_short || jsonb_build_object('sku', v_line.sku, 'short', v_need, 'unit', v_line.unit);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_partial, false) then
    raise exception 'Not enough usable stock to reserve: %. Nothing was reserved.',
      (select string_agg(format('%s short by %s %s', s ->> 'sku', s ->> 'short', s ->> 'unit'), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_created) = 0 and jsonb_array_length(v_short) = 0 then
    raise exception 'All materials for this order are already reserved or issued.' using errcode = 'P0001';
  end if;

  v_complete := jsonb_array_length(v_short) = 0;
  if v_order.status = 'APPROVED' and v_complete then
    update public.production_orders set status = 'MATERIALS_RESERVED' where id = v_order.id;
  end if;
  perform private.log_production_event(v_company, v_order.id, 'MATERIALS_RESERVED', v_order.status,
    case when v_order.status = 'APPROVED' and v_complete then 'MATERIALS_RESERVED' else v_order.status end, null,
    jsonb_build_object('reservations', v_created, 'shortages', v_short));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'reservations', v_created, 'shortages', v_short, 'fully_reserved', v_complete,
    'status', (select status from public.production_orders where id = v_order.id)));
end;
$$;

create or replace function public.production_release_reservations(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_material.reserve');
  v_order    public.production_orders;
  v_released numeric;
begin
  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  v_released := private.release_order_reservations(v_order, 'RELEASED');
  if v_released = 0 then
    raise exception 'This order has no open reservations.' using errcode = 'P0001';
  end if;
  if v_order.status = 'MATERIALS_RESERVED' then
    update public.production_orders set status = 'APPROVED' where id = v_order.id;
  end if;
  perform private.log_production_event(v_company, v_order.id, 'RESERVATIONS_RELEASED', v_order.status,
    case when v_order.status = 'MATERIALS_RESERVED' then 'APPROVED' else v_order.status end, p_note,
    jsonb_build_object('released_quantity', v_released));
  return jsonb_build_object('released_quantity', v_released,
    'status', (select status from public.production_orders where id = v_order.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Material issue: PRODUCTION_ISSUE ledger entries, all lines in one transaction
-- p_lines: [{order_material_id, batch_id, location_id, quantity}]
-- -----------------------------------------------------------------------------
create or replace function public.production_issue_materials(
  p_order_id          uuid,
  p_lines             jsonb,
  p_consumption_date  date default null,
  p_over_issue_reason text default null,
  p_notes             text default null,
  p_idempotency_key   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_material.issue');
  v_today    date;
  v_previous jsonb;
  v_order    public.production_orders;
  v_input    jsonb;
  v_line     public.production_order_materials;
  v_product  public.products;
  v_location public.inventory_locations;
  v_lot      public.inventory_batches;
  v_qty      numeric;
  v_res      public.stock_reservations;
  v_use      numeric;
  v_consume  numeric;
  v_res_ids  uuid[];
  v_res_uses numeric[];
  v_tx       uuid;
  v_date     date;
  v_reason   text := nullif(btrim(coalesce(p_over_issue_reason, '')), '');
  v_over     boolean := false;
  v_numbers  text[] := '{}';
  i          int;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_issue');
  if v_previous is not null then return v_previous; end if;
  v_today := private.company_today(v_company);
  v_date := coalesce(p_consumption_date, v_today);

  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Start production before issuing materials (order is %).', v_order.status using errcode = 'P0001';
  end if;
  if v_date > v_today then
    raise exception 'The consumption date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_order.actual_start_date is not null and v_date < v_order.actual_start_date then
    raise exception 'The consumption date cannot be before production started (%).', v_order.actual_start_date using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one material line to issue.' using errcode = 'P0001';
  end if;

  for v_input in select value from jsonb_array_elements(p_lines) loop
    select * into v_line from public.production_order_materials
    where id = (v_input ->> 'order_material_id')::uuid and production_order_id = v_order.id
    for update;
    if not found then
      raise exception 'A material line does not belong to this order.' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = v_line.component_product_id;
    if v_line.unit <> v_product.base_unit then
      raise exception '%: BOM unit % differs from inventory unit %; it cannot be issued.', v_product.sku, v_line.unit, v_product.base_unit
        using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_input ->> 'quantity')::numeric;
    exception when others then
      raise exception '%: quantity must be a number.', v_product.sku using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception '%: enter a quantity greater than zero (up to 3 decimals).', v_product.sku using errcode = 'P0001';
    end if;
    select * into v_location from public.inventory_locations where id = (v_input ->> 'location_id')::uuid and company_id = v_company;
    if not found or v_location.warehouse_id <> v_order.source_warehouse_id or v_location.stock_usage <> 'STORAGE' then
      raise exception '%: issue from a storage location in the order''s source warehouse.', v_product.sku using errcode = 'P0001';
    end if;
    select * into v_lot from public.inventory_batches
    where id = (v_input ->> 'batch_id')::uuid and company_id = v_company and product_id = v_product.id;
    if not found then
      raise exception '%: the selected batch/lot does not belong to this material.', v_product.sku using errcode = 'P0001';
    end if;

    if v_line.issued_quantity + v_qty > v_line.planned_quantity then
      v_over := true;
      if not private.has_permission(v_company, 'production_exception.approve') then
        raise exception '%: issuing % would exceed the planned % %. Over-consumption needs production_exception.approve.',
          v_product.sku, v_qty, v_line.planned_quantity, v_line.unit using errcode = '42501';
      end if;
      if v_reason is null or length(v_reason) < 5 then
        raise exception '%: issuing more than planned requires a documented reason.', v_product.sku using errcode = 'P0001';
      end if;
    end if;

    -- Fulfil this order's reservations on the same lot and location first.
    v_consume := 0;
    v_res_ids := '{}';
    v_res_uses := '{}';
    for v_res in
      select * from public.stock_reservations
      where company_id = v_company and reference_type = 'PRODUCTION_ORDER' and reference_id = v_order.id
        and batch_id = v_lot.id and location_id = v_location.id and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      order by reserved_at
      for update
    loop
      v_use := least(v_qty - v_consume, v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity);
      continue when v_use <= 0;
      v_consume := v_consume + v_use;
      v_res_ids := v_res_ids || v_res.id;
      v_res_uses := v_res_uses || v_use;
      exit when v_consume = v_qty;
    end loop;

    v_tx := private.post_movement(v_company, 'PRODUCTION_ISSUE', v_lot.id, v_location.id, v_qty, null,
      'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
      'Issued to production ' || v_order.production_order_number, p_notes,
      private.effective_timestamp(v_company, v_date), 'PRODUCTION', v_order.id, null, null, null, v_consume);

    for i in 1 .. coalesce(array_length(v_res_ids, 1), 0) loop
      update public.stock_reservations
      set fulfilled_quantity = fulfilled_quantity + v_res_uses[i],
          reservation_status = case when quantity - fulfilled_quantity - v_res_uses[i] - released_quantity = 0 then 'FULFILLED' else 'PARTIALLY_FULFILLED' end,
          updated_at = now()
      where id = v_res_ids[i];
    end loop;

    insert into public.production_material_consumption (company_id, production_order_id, order_material_id, component_product_id,
      batch_id, warehouse_id, location_id, planned_quantity, actual_quantity, unit, reserved_quantity_used, inventory_transaction_id,
      consumption_date, over_issue_reason, notes, recorded_by)
    values (v_company, v_order.id, v_line.id, v_product.id, v_lot.id, v_location.warehouse_id, v_location.id, v_line.planned_quantity,
      v_qty, v_line.unit, v_consume, v_tx, v_date,
      case when v_line.issued_quantity + v_qty > v_line.planned_quantity then v_reason end,
      nullif(btrim(coalesce(p_notes, '')), ''), auth.uid());

    update public.production_order_materials set issued_quantity = issued_quantity + v_qty where id = v_line.id;
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
  end loop;

  perform private.log_production_event(v_company, v_order.id, 'MATERIALS_ISSUED', v_order.status, v_order.status,
    case when v_over then v_reason end,
    jsonb_build_object('transaction_numbers', to_jsonb(v_numbers), 'over_issue', v_over));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('transaction_numbers', to_jsonb(v_numbers)));
end;
$$;

-- Authorised correction of a posted material issue (stock returns to the same
-- lot and location; the reservation is not re-created).
create or replace function public.production_reverse_consumption(p_consumption_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_exception.approve');
  v_previous jsonb;
  v_row      public.production_material_consumption;
  v_order    public.production_orders;
  v_numbers  text[];
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_issue_reversal');
  if v_previous is not null then return v_previous; end if;

  select * into v_row from public.production_material_consumption where id = p_consumption_id and company_id = v_company for update;
  if not found then
    raise exception 'Material issue not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_order from public.production_orders where id = v_row.production_order_id for update;
  if v_row.status <> 'POSTED' then
    raise exception 'This material issue has already been reversed.' using errcode = 'P0001';
  end if;
  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'Postings of a % order cannot be reversed.', lower(v_order.status) using errcode = 'P0001';
  end if;

  v_numbers := private.reverse_ledger_transaction(v_company, v_row.inventory_transaction_id, p_reason);
  update public.production_material_consumption
  set status = 'REVERSED', reversal_transaction_ids = v_numbers, reversal_reason = btrim(p_reason), reversed_by = auth.uid(), reversed_at = now()
  where id = v_row.id;
  update public.production_order_materials set issued_quantity = issued_quantity - v_row.actual_quantity where id = v_row.order_material_id;

  perform private.log_production_event(v_company, v_order.id, 'ISSUE_REVERSED', v_order.status, v_order.status, p_reason,
    jsonb_build_object('transaction_id', v_row.inventory_transaction_id, 'reversal_numbers', to_jsonb(v_numbers), 'quantity', v_row.actual_quantity));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Finished-goods output receipt
-- -----------------------------------------------------------------------------
create or replace function public.production_receive_output(
  p_order_id               uuid,
  p_good_quantity          numeric,
  p_rejected_quantity      numeric default 0,
  p_scrap_quantity         numeric default 0,
  p_good_location_id       uuid default null,
  p_rejected_location_id   uuid default null,
  p_batch_number           text default null,
  p_manufacturing_date     date default null,
  p_expiry_date            date default null,
  p_production_date        date default null,
  p_unit_cost              numeric default null,
  p_quality_status         text default 'NOT_INSPECTED',
  p_rejection_reason       text default null,
  p_over_production_reason text default null,
  p_notes                  text default null,
  p_idempotency_key        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('production_output.receive');
  v_today     date;
  v_previous  jsonb;
  v_order     public.production_orders;
  v_product   public.products;
  v_good_loc  public.inventory_locations;
  v_rej_loc   public.inventory_locations;
  v_good      numeric := coalesce(p_good_quantity, 0);
  v_rej       numeric := coalesce(p_rejected_quantity, 0);
  v_scrap     numeric := coalesce(p_scrap_quantity, 0);
  v_date      date;
  v_ts        timestamptz;
  v_lot       uuid;
  v_good_tx   uuid;
  v_rej_tx    uuid;
  v_number    text;
  v_id        uuid;
  v_over      text := nullif(btrim(coalesce(p_over_production_reason, '')), '');
  v_rej_note  text := nullif(btrim(coalesce(p_rejection_reason, '')), '');
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_output');
  if v_previous is not null then return v_previous; end if;
  v_today := private.company_today(v_company);
  v_date := coalesce(p_production_date, v_today);

  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  if v_order.status not in ('IN_PROGRESS', 'PARTIALLY_COMPLETED') then
    raise exception 'Output can only be recorded for orders in production (order is %).', v_order.status using errcode = 'P0001';
  end if;
  v_product := private.require_active_product(v_company, v_order.finished_product_id);
  if v_good < 0 or v_rej < 0 or v_scrap < 0 or v_good + v_rej + v_scrap = 0 then
    raise exception 'Enter the good, rejected and/or scrap quantities produced.' using errcode = 'P0001';
  end if;
  if v_good <> round(v_good, 3) or v_rej <> round(v_rej, 3) or v_scrap <> round(v_scrap, 3) then
    raise exception 'Quantities support at most 3 decimal places.' using errcode = 'P0001';
  end if;
  if v_date > v_today then
    raise exception 'The production date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_order.actual_start_date is not null and v_date < v_order.actual_start_date then
    raise exception 'The production date cannot be before production started (%).', v_order.actual_start_date using errcode = 'P0001';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative.' using errcode = 'P0001';
  end if;
  if coalesce(p_quality_status, 'NOT_INSPECTED') not in ('NOT_INSPECTED', 'ACCEPTED', 'ACCEPTED_WITH_DEVIATION') then
    raise exception 'Invalid quality status.' using errcode = 'P0001';
  end if;
  if (v_rej > 0 or v_scrap > 0) and v_rej_note is null then
    raise exception 'Enter the reason for the rejected or scrap quantity.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.production_order_materials where production_order_id = v_order.id)
     and not exists (select 1 from public.production_material_consumption where production_order_id = v_order.id and status = 'POSTED') then
    raise exception 'Issue materials to this order before recording its output.' using errcode = 'P0001';
  end if;

  if v_order.actual_quantity + v_good + v_rej + v_scrap > v_order.planned_quantity then
    if not private.has_permission(v_company, 'production_exception.approve') then
      raise exception 'This output would exceed the planned quantity (%). Over-production needs production_exception.approve.',
        v_order.planned_quantity using errcode = '42501';
    end if;
    if v_over is null or length(v_over) < 5 then
      raise exception 'Output above the planned quantity requires a documented reason.' using errcode = 'P0001';
    end if;
  else
    v_over := null;
  end if;

  if v_good > 0 then
    select * into v_good_loc from public.inventory_locations where id = p_good_location_id and company_id = v_company;
    if not found or v_good_loc.warehouse_id <> v_order.destination_warehouse_id or v_good_loc.stock_usage <> 'STORAGE' then
      raise exception 'Receive good output into a storage location of the order''s destination warehouse.' using errcode = 'P0001';
    end if;
  end if;
  if p_rejected_location_id is not null then
    if v_rej = 0 then
      raise exception 'A rejected-goods location was given but no rejected quantity.' using errcode = 'P0001';
    end if;
    select * into v_rej_loc from public.inventory_locations where id = p_rejected_location_id and company_id = v_company;
    if not found or v_rej_loc.stock_usage <> 'REJECTED' then
      raise exception 'Rejected goods can only be stocked in a location designated for rejected (non-saleable) goods.' using errcode = 'P0001';
    end if;
  end if;

  v_ts := private.effective_timestamp(v_company, v_date);
  if v_good > 0 or p_rejected_location_id is not null then
    v_lot := private.ensure_batch(v_company, v_product.id, 'IN_HOUSE', p_batch_number, p_manufacturing_date, p_expiry_date, p_unit_cost,
      'PRODUCTION_ORDER', v_order.id, coalesce(v_good_loc.warehouse_id, v_rej_loc.warehouse_id), coalesce(v_good_loc.id, v_rej_loc.id), false);
  end if;
  v_number := private.next_document_number(v_company, 'FGR');
  if v_good > 0 then
    v_good_tx := private.post_movement(v_company, 'PRODUCTION_RECEIPT', v_lot, v_good_loc.id, v_good, p_unit_cost,
      'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
      'Production output ' || v_order.production_order_number || ' (' || v_number || ')', p_notes, v_ts, 'PRODUCTION', v_order.id);
  end if;
  if p_rejected_location_id is not null then
    v_rej_tx := private.post_movement(v_company, 'PRODUCTION_RECEIPT', v_lot, v_rej_loc.id, v_rej, p_unit_cost,
      'PRODUCTION_ORDER', v_order.production_order_number, v_order.id,
      'Rejected production output ' || v_order.production_order_number || ': ' || v_rej_note, p_notes, v_ts, 'PRODUCTION', v_order.id);
  end if;

  insert into public.production_output_receipts (company_id, receipt_number, production_order_id, product_id, batch_id,
    good_quantity, rejected_quantity, scrap_quantity, unit, good_location_id, rejected_location_id, good_transaction_id, rejected_transaction_id,
    production_date, unit_cost, quality_status, rejection_reason, over_production_reason, notes, created_by)
  values (v_company, v_number, v_order.id, v_product.id, v_lot, v_good, v_rej, v_scrap, v_order.unit,
    case when v_good > 0 then v_good_loc.id end, p_rejected_location_id, v_good_tx, v_rej_tx, v_date, p_unit_cost,
    coalesce(p_quality_status, 'NOT_INSPECTED'), v_rej_note, v_over, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  update public.production_orders
  set completed_quantity = completed_quantity + v_good, rejected_quantity = rejected_quantity + v_rej, scrap_quantity = scrap_quantity + v_scrap,
      status = case when status = 'IN_PROGRESS' then 'PARTIALLY_COMPLETED' else status end
  where id = v_order.id;

  perform private.log_production_event(v_company, v_order.id, 'OUTPUT_RECEIVED', v_order.status,
    case when v_order.status = 'IN_PROGRESS' then 'PARTIALLY_COMPLETED' else v_order.status end, v_over,
    jsonb_build_object('receipt_number', v_number, 'good', v_good, 'rejected', v_rej, 'scrap', v_scrap));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'receipt_id', v_id, 'receipt_number', v_number, 'batch_id', v_lot,
    'good_transaction_number', (select transaction_number from public.inventory_transactions where id = v_good_tx),
    'rejected_transaction_number', (select transaction_number from public.inventory_transactions where id = v_rej_tx)));
end;
$$;

create or replace function public.production_reverse_output(p_receipt_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('production_exception.approve');
  v_previous jsonb;
  v_row      public.production_output_receipts;
  v_order    public.production_orders;
  v_numbers  text[] := '{}';
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'production_output_reversal');
  if v_previous is not null then return v_previous; end if;

  select * into v_row from public.production_output_receipts where id = p_receipt_id and company_id = v_company for update;
  if not found then
    raise exception 'Output receipt not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_order from public.production_orders where id = v_row.production_order_id for update;
  if v_row.status <> 'POSTED' then
    raise exception 'This output receipt has already been reversed.' using errcode = 'P0001';
  end if;
  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'Postings of a % order cannot be reversed.', lower(v_order.status) using errcode = 'P0001';
  end if;
  if v_row.good_transaction_id is not null then
    v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_row.good_transaction_id, p_reason);
  end if;
  if v_row.rejected_transaction_id is not null then
    v_numbers := v_numbers || private.reverse_ledger_transaction(v_company, v_row.rejected_transaction_id, p_reason);
  end if;
  if v_numbers = '{}' and (p_reason is null or length(btrim(p_reason)) < 3) then
    raise exception 'Enter the reason for the reversal.' using errcode = 'P0001';
  end if;

  update public.production_output_receipts
  set status = 'REVERSED', reversal_transaction_ids = v_numbers, reversal_reason = btrim(p_reason), reversed_by = auth.uid(), reversed_at = now()
  where id = v_row.id;
  update public.production_orders
  set completed_quantity = completed_quantity - v_row.good_quantity, rejected_quantity = rejected_quantity - v_row.rejected_quantity,
      scrap_quantity = scrap_quantity - v_row.scrap_quantity,
      status = case when status = 'PARTIALLY_COMPLETED'
                     and completed_quantity - v_row.good_quantity + rejected_quantity - v_row.rejected_quantity + scrap_quantity - v_row.scrap_quantity = 0
                    then 'IN_PROGRESS' else status end
  where id = v_order.id;

  perform private.log_production_event(v_company, v_order.id, 'OUTPUT_REVERSED', v_order.status,
    (select status from public.production_orders where id = v_order.id), p_reason,
    jsonb_build_object('receipt_number', v_row.receipt_number, 'reversal_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Material status of an order with live availability (source warehouse)
-- -----------------------------------------------------------------------------
create or replace function public.production_order_requirements(p_order_id uuid)
returns table (
  order_material_id uuid, line_no int, component_product_id uuid, sku text, product_name text, unit text, inventory_unit text,
  quantity_per_unit numeric, wastage_percentage numeric, base_quantity numeric, planned_quantity numeric, issued_quantity numeric,
  outstanding_quantity numeric, reserved_for_order numeric, available_in_source numeric, shortage numeric, line_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('manufacturing.read');
  v_order   public.production_orders;
begin
  select * into v_order from public.production_orders where id = p_order_id and company_id = v_company;
  if not found then
    raise exception 'Production order not found in your company.' using errcode = 'P0001';
  end if;
  return query
  select m.id, m.line_no, m.component_product_id, p.sku, p.product_name, m.unit, p.base_unit, m.quantity_per_unit, m.wastage_percentage,
    m.base_quantity, m.planned_quantity, m.issued_quantity,
    greatest(m.planned_quantity - m.issued_quantity, 0),
    r.qty, s.available,
    case when m.unit = p.base_unit then greatest(m.planned_quantity - m.issued_quantity - r.qty - s.available, 0) end,
    case
      when m.unit <> p.base_unit then 'UNIT_MISMATCH'
      when m.issued_quantity >= m.planned_quantity then 'ISSUED'
      when p.status <> 'ACTIVE' or p.archived_at is not null then 'INACTIVE'
      when m.planned_quantity - m.issued_quantity <= r.qty then 'RESERVED'
      when m.planned_quantity - m.issued_quantity <= r.qty + s.available then 'SUFFICIENT'
      when r.qty + s.available > 0 then 'PARTIAL'
      else 'SHORTAGE'
    end
  from public.production_order_materials m
  join public.products p on p.id = m.component_product_id
  cross join lateral (select private.order_open_reserved(v_order.id, m.component_product_id) as qty) r
  cross join lateral private.storage_stock(v_company, m.component_product_id, v_order.source_warehouse_id) s
  where m.production_order_id = v_order.id
  order by m.line_no;
end;
$$;

-- -----------------------------------------------------------------------------
-- List views (security_invoker: RLS applies to the caller)
-- -----------------------------------------------------------------------------
create or replace view public.production_order_list
with (security_invoker = true) as
select
  o.*, p.sku, p.product_name,
  sw.warehouse_code as source_warehouse_code, dw.warehouse_code as destination_warehouse_code,
  coalesce(m.lines, 0) as material_lines,
  coalesce(m.lines_issued, 0) as material_lines_issued,
  case when coalesce(m.issued_any, false) = false then 'NOT_ISSUED'
       when m.lines_issued = m.lines then 'FULLY_ISSUED' else 'PARTIALLY_ISSUED' end as material_status,
  (o.status not in ('COMPLETED', 'CANCELLED') and o.target_completion_date < (now() at time zone coalesce(c.timezone, 'UTC'))::date) as is_overdue
from public.production_orders o
join public.products p on p.id = o.finished_product_id
join public.companies c on c.id = o.company_id
left join public.warehouses sw on sw.id = o.source_warehouse_id
left join public.warehouses dw on dw.id = o.destination_warehouse_id
left join (
  select production_order_id, count(*) as lines,
    count(*) filter (where issued_quantity >= planned_quantity) as lines_issued,
    bool_or(issued_quantity > 0) as issued_any
  from public.production_order_materials group by production_order_id
) m on m.production_order_id = o.id;

create or replace view public.production_consumption_list
with (security_invoker = true) as
select
  c.*, o.production_order_number, o.status as order_status, p.sku, p.product_name,
  bt.batch_number, bt.source_type, w.warehouse_code, l.location_code,
  t.transaction_number
from public.production_material_consumption c
join public.production_orders o on o.id = c.production_order_id
join public.products p on p.id = c.component_product_id
left join public.inventory_batches bt on bt.id = c.batch_id
left join public.warehouses w on w.id = c.warehouse_id
left join public.inventory_locations l on l.id = c.location_id
left join public.inventory_transactions t on t.id = c.inventory_transaction_id;

create or replace view public.production_output_list
with (security_invoker = true) as
select
  r.*, o.production_order_number, o.status as order_status, o.planned_quantity as order_planned_quantity,
  p.sku, p.product_name, bt.batch_number,
  gl.location_code as good_location_code, gw.warehouse_code as good_warehouse_code,
  rl.location_code as rejected_location_code,
  gt.transaction_number as good_transaction_number, rt.transaction_number as rejected_transaction_number
from public.production_output_receipts r
join public.production_orders o on o.id = r.production_order_id
join public.products p on p.id = r.product_id
left join public.inventory_batches bt on bt.id = r.batch_id
left join public.inventory_locations gl on gl.id = r.good_location_id
left join public.warehouses gw on gw.id = gl.warehouse_id
left join public.inventory_locations rl on rl.id = r.rejected_location_id
left join public.inventory_transactions gt on gt.id = r.good_transaction_id
left join public.inventory_transactions rt on rt.id = r.rejected_transaction_id;

revoke all on public.production_order_list, public.production_consumption_list, public.production_output_list from anon, authenticated;
grant select on public.production_order_list, public.production_consumption_list, public.production_output_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.production_save_order(uuid, uuid, numeric, uuid, uuid, date, date, text, text, uuid)',
    'public.production_order_action(uuid, text, text, uuid)',
    'public.production_reserve_materials(uuid, boolean, uuid)',
    'public.production_release_reservations(uuid, text)',
    'public.production_issue_materials(uuid, jsonb, date, text, text, uuid)',
    'public.production_reverse_consumption(uuid, text, uuid)',
    'public.production_receive_output(uuid, numeric, numeric, numeric, uuid, uuid, text, date, date, date, numeric, text, text, text, text, uuid)',
    'public.production_reverse_output(uuid, text, uuid)',
    'public.production_order_requirements(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
