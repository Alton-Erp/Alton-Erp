-- =============================================================================
-- Phase 7: customer returns
--
--   REQUESTED -> AUTHORIZED -> RECEIVED -> (UNDER_INSPECTION) -> ACCEPTED / REJECTED -> CLOSED
--   REQUESTED -> REJECTED (not authorised)
--
-- Stock:
--   requested / authorised   no stock change
--   received                 CUSTOMER_RETURN posting into a QUARANTINE location,
--                            same lot as the original dispatch (not available)
--   dispositions (posted after inspection, by a user with receive_stock):
--     RESTOCK            transfer quarantine -> storage location (available again)
--     SCRAP              transfer quarantine -> rejected location (non-saleable)
--     RETURN_TO_CUSTOMER issue from quarantine
--     QUARANTINE / REPAIR / PENDING_REVIEW  stay in quarantine
-- No credit notes, refunds or tax adjustments (future billing module).
-- =============================================================================

create table if not exists public.customer_returns (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  return_number       text not null,
  sales_order_id      uuid not null,
  fulfilment_id       uuid,
  customer_id         uuid,
  customer_name_snapshot text not null,
  return_date         date not null,
  reason_code         text not null check (reason_code in ('DAMAGED_IN_TRANSIT', 'DEFECTIVE', 'WRONG_ITEM', 'EXCESS_QUANTITY', 'NOT_REQUIRED', 'DELIVERY_REFUSED', 'OTHER')),
  reason_note         text check (reason_note is null or length(reason_note) <= 1000),
  customer_reference  text check (customer_reference is null or length(customer_reference) <= 100),
  status              text not null default 'REQUESTED' check (status in ('REQUESTED', 'AUTHORIZED', 'RECEIVED', 'UNDER_INSPECTION', 'ACCEPTED', 'REJECTED', 'CLOSED')),
  receipt_location_id uuid,
  notes               text check (notes is null or length(notes) <= 1000),
  requested_by        uuid,
  authorized_by       uuid,
  authorized_at       timestamptz,
  decision_note       text check (decision_note is null or length(decision_note) <= 1000),
  received_by         uuid,
  received_at         timestamptz,
  inspected_by        uuid,
  inspected_at        timestamptz,
  inspection_note     text check (inspection_note is null or length(inspection_note) <= 1000),
  closed_by           uuid,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customer_returns_number_unique unique (company_id, return_number),
  constraint customer_returns_id_company_unique unique (id, company_id),
  constraint customer_returns_so_fk foreign key (sales_order_id, company_id) references public.sales_orders (id, company_id) on delete restrict,
  constraint customer_returns_fulfilment_fk foreign key (fulfilment_id, company_id) references public.fulfilments (id, company_id) on delete restrict,
  constraint customer_returns_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint customer_returns_location_fk foreign key (receipt_location_id) references public.inventory_locations (id) on delete restrict,
  constraint customer_returns_received_state check (status in ('REQUESTED', 'AUTHORIZED') or status = 'REJECTED' or received_at is not null)
);

create index if not exists customer_returns_status_idx on public.customer_returns (company_id, status);
create index if not exists customer_returns_so_idx on public.customer_returns (sales_order_id);
create index if not exists customer_returns_date_idx on public.customer_returns (company_id, return_date desc);

create table if not exists public.customer_return_lines (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  return_id            uuid not null,
  line_no              integer not null check (line_no > 0),
  sales_order_line_id  uuid not null,
  fulfilment_line_id   uuid not null,
  product_id           uuid not null,
  batch_id             uuid not null,
  quantity_requested   numeric(14,3) not null check (quantity_requested > 0),
  quantity_received    numeric(14,3) not null default 0 check (quantity_received >= 0),
  disposition          text not null default 'PENDING_REVIEW' check (disposition in ('RESTOCK', 'QUARANTINE', 'REPAIR', 'SCRAP', 'RETURN_TO_CUSTOMER', 'PENDING_REVIEW')),
  inspection_note      text check (inspection_note is null or length(inspection_note) <= 500),
  receipt_transaction_id uuid references public.inventory_transactions (id) on delete restrict,
  disposition_posted   boolean not null default false,
  disposition_transaction_ids uuid[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint customer_return_lines_unique unique (return_id, line_no),
  constraint customer_return_lines_return_fk foreign key (return_id, company_id) references public.customer_returns (id, company_id) on delete restrict,
  constraint customer_return_lines_so_line_fk foreign key (sales_order_line_id, company_id) references public.sales_order_lines (id, company_id) on delete restrict,
  constraint customer_return_lines_fl_fk foreign key (fulfilment_line_id, company_id) references public.fulfilment_lines (id, company_id) on delete restrict,
  constraint customer_return_lines_batch_fk foreign key (batch_id, product_id, company_id) references public.inventory_batches (id, product_id, company_id) on delete restrict,
  constraint customer_return_lines_received check (quantity_received <= quantity_requested)
);

create index if not exists customer_return_lines_return_idx on public.customer_return_lines (return_id);
create index if not exists customer_return_lines_fl_idx on public.customer_return_lines (fulfilment_line_id);

drop trigger if exists customer_returns_set_updated_at on public.customer_returns;
create trigger customer_returns_set_updated_at before update on public.customer_returns for each row execute function private.set_updated_at();
drop trigger if exists customer_return_lines_set_updated_at on public.customer_return_lines;
create trigger customer_return_lines_set_updated_at before update on public.customer_return_lines for each row execute function private.set_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array['customer_returns', 'customer_return_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'fulfilment.read', 'sales_orders.read');
  end loop;
end;
$$;

-- Quantity of a dispatched fulfilment line already claimed by returns
-- (requested while pending, received afterwards; rejected-before-receipt returns excluded).
create or replace function private.return_committed(p_fulfilment_line uuid, p_exclude_return uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when r.status in ('REQUESTED', 'AUTHORIZED') then rl.quantity_requested else rl.quantity_received end), 0)
  from public.customer_return_lines rl join public.customer_returns r on r.id = rl.return_id
  where rl.fulfilment_line_id = p_fulfilment_line and (p_exclude_return is null or r.id <> p_exclude_return)
    and not (r.status = 'REJECTED' and r.received_at is null);
$$;

revoke all on function private.return_committed(uuid, uuid) from public, anon, authenticated;

create or replace function private.lock_return(p_company uuid, p_id uuid)
returns public.customer_returns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.customer_returns;
begin
  select * into v_r from public.customer_returns where id = p_id and company_id = p_company for update;
  if not found then
    raise exception 'Return not found in your company.' using errcode = 'P0001';
  end if;
  return v_r;
end;
$$;

revoke all on function private.lock_return(uuid, uuid) from public, anon, authenticated;

-- p_header: {return_date, reason_code, reason_note, customer_reference, notes}
-- p_lines:  [{fulfilment_line_id, quantity}]
create or replace function public.customer_return_create(p_so_id uuid, p_header jsonb, p_lines jsonb, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('fulfilment_returns.create');
  v_previous jsonb;
  v_so       public.sales_orders;
  v_ret      public.customer_returns;
  v_entry    jsonb;
  v_fl       record;
  v_qty      numeric;
  v_no       int := 0;
  v_date     date := coalesce(private.so_header_date(p_header, 'return_date'), private.company_today(v_company));
  v_reason   text := upper(coalesce(nullif(btrim(coalesce(p_header ->> 'reason_code', '')), ''), ''));
  v_fuls     uuid[];
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_return_create');
  if v_previous is not null then return v_previous; end if;
  select * into v_so from public.sales_orders where id = p_so_id and company_id = v_company for update;
  if not found then
    raise exception 'Sales order not found in your company.' using errcode = 'P0001';
  end if;
  if v_reason not in ('DAMAGED_IN_TRANSIT', 'DEFECTIVE', 'WRONG_ITEM', 'EXCESS_QUANTITY', 'NOT_REQUIRED', 'DELIVERY_REFUSED', 'OTHER') then
    raise exception 'Choose the return reason.' using errcode = 'P0001';
  end if;
  if v_date > private.company_today(v_company) then
    raise exception 'The return date cannot be in the future.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select the dispatched items being returned.' using errcode = 'P0001';
  end if;

  insert into public.customer_returns (company_id, return_number, sales_order_id, customer_id, customer_name_snapshot, return_date, reason_code, reason_note,
    customer_reference, notes, requested_by)
  values (v_company, private.next_document_number(v_company, 'RET'), v_so.id, v_so.customer_id, v_so.customer_name_snapshot, v_date, v_reason,
    private.so_header_value(p_header, 'reason_note', 1000), private.so_header_value(p_header, 'customer_reference', 100), private.so_header_value(p_header, 'notes', 1000),
    auth.uid())
  returning * into v_ret;

  for v_entry in select value from jsonb_array_elements(p_lines) loop
    select fl.*, f.fulfilment_number, f.sales_order_id as so_id, f.actual_dispatch_at into v_fl
    from public.fulfilment_lines fl join public.fulfilments f on f.id = fl.fulfilment_id
    where fl.id = (v_entry ->> 'fulfilment_line_id')::uuid and fl.company_id = v_company
    for update of fl;
    if not found or v_fl.so_id <> v_so.id then
      raise exception 'A returned item does not belong to a dispatch of %.', v_so.sales_order_number using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_entry ->> 'quantity')::numeric;
    exception when others then
      raise exception 'Return quantities must be numbers.' using errcode = 'P0001';
    end;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty > v_fl.quantity_dispatched - private.return_committed(v_fl.id) then
      raise exception '% line %: return between 0 and % (dispatched %, already on returns %).', v_fl.fulfilment_number, v_fl.line_no,
        greatest(v_fl.quantity_dispatched - private.return_committed(v_fl.id), 0), v_fl.quantity_dispatched, private.return_committed(v_fl.id) using errcode = 'P0001';
    end if;
    if (v_fl.actual_dispatch_at at time zone private.company_tz(v_company))::date > v_date then
      raise exception 'The return date cannot be before the dispatch of %.', v_fl.fulfilment_number using errcode = 'P0001';
    end if;
    v_no := v_no + 1;
    insert into public.customer_return_lines (company_id, return_id, line_no, sales_order_line_id, fulfilment_line_id, product_id, batch_id, quantity_requested)
    values (v_company, v_ret.id, v_no, v_fl.sales_order_line_id, v_fl.id, v_fl.product_id, v_fl.batch_id, v_qty);
    v_fuls := v_fuls || v_fl.fulfilment_id;
  end loop;
  if v_no = 0 then
    raise exception 'Enter at least one returned quantity.' using errcode = 'P0001';
  end if;
  -- A single-consignment return keeps a direct link to that fulfilment.
  if (select count(distinct x) from unnest(v_fuls) x) = 1 then
    update public.customer_returns set fulfilment_id = v_fuls[1] where id = v_ret.id;
  end if;

  perform private.log_so_event(v_company, v_so.id, v_ret.fulfilment_id, v_ret.id, null, 'RETURN_REQUESTED', null, 'REQUESTED', v_ret.reason_note,
    jsonb_build_object('return_number', v_ret.return_number, 'reason_code', v_reason, 'lines', v_no));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('return_id', v_ret.id, 'return_number', v_ret.return_number, 'lines', v_no));
end;
$$;

-- AUTHORIZE | REJECT (before receipt). No stock change.
create or replace function public.customer_return_review(p_return_id uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment_returns.approve');
  v_r       public.customer_returns;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_to      text;
begin
  v_r := private.lock_return(v_company, p_return_id);
  if v_r.status <> 'REQUESTED' then
    raise exception 'Return % is already %.', v_r.return_number, lower(v_r.status) using errcode = 'P0001';
  end if;
  if p_decision = 'AUTHORIZE' then
    v_to := 'AUTHORIZED';
  elsif p_decision = 'REJECT' then
    if v_note is null then
      raise exception 'Enter the reason for rejecting the return.' using errcode = 'P0001';
    end if;
    v_to := 'REJECTED';
  else
    raise exception 'Unknown decision %.', p_decision using errcode = 'P0001';
  end if;
  update public.customer_returns set status = v_to, authorized_by = auth.uid(), authorized_at = now(), decision_note = left(v_note, 1000) where id = v_r.id;
  perform private.log_so_event(v_company, v_r.sales_order_id, v_r.fulfilment_id, v_r.id, null, 'RETURN_' || v_to, v_r.status, v_to, v_note,
    jsonb_build_object('return_number', v_r.return_number));
  return jsonb_build_object('status', v_to);
end;
$$;

-- Physical receipt into quarantine (CUSTOMER_RETURN posting, original lot).
-- p_lines: [{line_id, quantity}] or null = everything requested.
create or replace function public.customer_return_receive(
  p_return_id       uuid,
  p_location_id     uuid,
  p_lines           jsonb default null,
  p_received_at     timestamptz default null,
  p_note            text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('fulfilment_returns.receive_stock');
  v_previous jsonb;
  v_r        public.customer_returns;
  v_loc      public.inventory_locations;
  v_line     public.customer_return_lines;
  v_qty      numeric;
  v_tx       uuid;
  v_at       timestamptz := coalesce(p_received_at, now());
  v_numbers  text[] := '{}';
  v_total    numeric := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_return_receive');
  if v_previous is not null then return v_previous; end if;
  v_r := private.lock_return(v_company, p_return_id);
  if v_r.status <> 'AUTHORIZED' then
    raise exception 'Only an authorised return can be received (return % is %).', v_r.return_number, lower(replace(v_r.status, '_', ' ')) using errcode = 'P0001';
  end if;
  select * into v_loc from public.inventory_locations where id = p_location_id and company_id = v_company;
  if not found or v_loc.stock_usage <> 'QUARANTINE' or v_loc.status <> 'ACTIVE' then
    raise exception 'Receive returns into an active quarantine location (create one under Warehouses & Locations with usage "Quarantine").' using errcode = 'P0001';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'The receipt time cannot be in the future.' using errcode = 'P0001';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Received quantities must be a list.' using errcode = 'P0001';
  end if;

  for v_line in select * from public.customer_return_lines where return_id = v_r.id order by line_no for update loop
    if p_lines is null then
      v_qty := v_line.quantity_requested;
    else
      begin
        select sum((e ->> 'quantity')::numeric) into v_qty from jsonb_array_elements(p_lines) e where (e ->> 'line_id')::uuid = v_line.id;
      exception when others then
        raise exception 'Received quantities must be numbers.' using errcode = 'P0001';
      end;
      v_qty := coalesce(v_qty, 0);
    end if;
    if v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty > v_line.quantity_requested then
      raise exception 'Line %: receive between 0 and the authorised quantity (%).', v_line.line_no, v_line.quantity_requested using errcode = 'P0001';
    end if;
    continue when v_qty = 0;
    v_tx := private.post_movement(v_company, 'CUSTOMER_RETURN', v_line.batch_id, v_loc.id, v_qty, private.lot_average_cost(v_line.batch_id),
      'CUSTOMER_RETURN', v_r.return_number, v_line.id, 'Customer return ' || v_r.return_number || ' from ' || v_r.customer_name_snapshot || ' (quarantine)',
      nullif(btrim(coalesce(p_note, '')), ''), v_at, 'CUSTOMER_RETURN', v_r.id);
    update public.customer_return_lines set quantity_received = v_qty, receipt_transaction_id = v_tx where id = v_line.id;
    update public.sales_order_lines set quantity_returned = quantity_returned + v_qty where id = v_line.sales_order_line_id;
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
    v_total := v_total + v_qty;
  end loop;
  if v_total = 0 then
    raise exception 'Enter at least one received quantity.' using errcode = 'P0001';
  end if;
  update public.customer_returns set status = 'RECEIVED', receipt_location_id = v_loc.id, received_by = auth.uid(), received_at = v_at where id = v_r.id;
  perform private.log_so_event(v_company, v_r.sales_order_id, v_r.fulfilment_id, v_r.id, null, 'RETURN_RECEIVED', v_r.status, 'RECEIVED', p_note,
    jsonb_build_object('return_number', v_r.return_number, 'transaction_numbers', to_jsonb(v_numbers), 'quantity', v_total, 'location_code', v_loc.location_code));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('status', 'RECEIVED', 'transaction_numbers', to_jsonb(v_numbers), 'received', v_total));
end;
$$;

-- Inspection: dispositions per line; p_result ACCEPTED | REJECTED completes it,
-- NULL saves progress (UNDER_INSPECTION). No stock change.
-- p_lines: [{line_id, disposition, note}]
create or replace function public.customer_return_inspect(p_return_id uuid, p_lines jsonb, p_result text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('fulfilment_returns.inspect');
  v_r       public.customer_returns;
  v_entry   jsonb;
  v_disp    text;
  v_to      text;
begin
  v_r := private.lock_return(v_company, p_return_id);
  if v_r.status not in ('RECEIVED', 'UNDER_INSPECTION') then
    raise exception 'Only received returns can be inspected (return % is %).', v_r.return_number, lower(replace(v_r.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if p_result is not null and p_result not in ('ACCEPTED', 'REJECTED') then
    raise exception 'The inspection result must be accepted or rejected.' using errcode = 'P0001';
  end if;
  for v_entry in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_disp := upper(coalesce(v_entry ->> 'disposition', ''));
    if v_disp not in ('RESTOCK', 'QUARANTINE', 'REPAIR', 'SCRAP', 'RETURN_TO_CUSTOMER', 'PENDING_REVIEW') then
      raise exception 'Unknown disposition %.', v_disp using errcode = 'P0001';
    end if;
    update public.customer_return_lines set disposition = v_disp, inspection_note = left(nullif(btrim(coalesce(v_entry ->> 'note', '')), ''), 500)
    where id = (v_entry ->> 'line_id')::uuid and return_id = v_r.id;
    if not found then
      raise exception 'An inspected line does not belong to this return.' using errcode = 'P0001';
    end if;
  end loop;
  if p_result = 'REJECTED' and exists (select 1 from public.customer_return_lines where return_id = v_r.id and quantity_received > 0 and disposition = 'RESTOCK') then
    raise exception 'A rejected return cannot be restocked. Choose return to customer, quarantine, repair, scrap or pending review.' using errcode = 'P0001';
  end if;
  v_to := coalesce(p_result, 'UNDER_INSPECTION');
  update public.customer_returns set status = v_to, inspected_by = auth.uid(), inspected_at = now(),
    inspection_note = coalesce(left(nullif(btrim(coalesce(p_note, '')), ''), 1000), inspection_note)
  where id = v_r.id;
  perform private.log_so_event(v_company, v_r.sales_order_id, v_r.fulfilment_id, v_r.id, null,
    case when p_result is null then 'RETURN_INSPECTION_SAVED' else 'RETURN_' || p_result end, v_r.status, v_to, p_note,
    jsonb_build_object('return_number', v_r.return_number, 'lines', coalesce(p_lines, '[]'::jsonb)));
  return jsonb_build_object('status', v_to);
end;
$$;

-- Posts the inspected dispositions through the ledger and closes the return.
create or replace function public.customer_return_post_disposition(
  p_return_id           uuid,
  p_restock_location_id uuid default null,
  p_scrap_location_id   uuid default null,
  p_note                text default null,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('fulfilment_returns.receive_stock');
  v_previous jsonb;
  v_r        public.customer_returns;
  v_line     public.customer_return_lines;
  v_target   public.inventory_locations;
  v_group    uuid;
  v_ids      uuid[];
  v_out      uuid;
  v_in       uuid;
  v_numbers  text[] := '{}';
  v_reason   text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_return_post');
  if v_previous is not null then return v_previous; end if;
  v_r := private.lock_return(v_company, p_return_id);
  if v_r.status not in ('ACCEPTED', 'REJECTED') or v_r.received_at is null then
    raise exception 'Dispositions are posted after the inspection is completed (return % is %).', v_r.return_number, lower(replace(v_r.status, '_', ' '))
      using errcode = 'P0001';
  end if;

  for v_line in select * from public.customer_return_lines where return_id = v_r.id and quantity_received > 0 and not disposition_posted order by line_no for update loop
    v_ids := '{}';
    v_reason := 'Return ' || v_r.return_number || ' disposition ' || lower(replace(v_line.disposition, '_', ' '));
    if v_line.disposition in ('RESTOCK', 'SCRAP') then
      select * into v_target from public.inventory_locations
      where id = case when v_line.disposition = 'RESTOCK' then p_restock_location_id else p_scrap_location_id end and company_id = v_company and status = 'ACTIVE';
      if not found or v_target.stock_usage <> (case when v_line.disposition = 'RESTOCK' then 'STORAGE' else 'REJECTED' end) then
        raise exception 'Line %: choose an active % location for %.', v_line.line_no,
          case when v_line.disposition = 'RESTOCK' then 'storage' else 'rejected-goods' end, lower(v_line.disposition) using errcode = 'P0001';
      end if;
      v_group := gen_random_uuid();
      v_out := private.post_movement(v_company, 'TRANSFER_OUT', v_line.batch_id, v_r.receipt_location_id, v_line.quantity_received, null,
        'CUSTOMER_RETURN', v_r.return_number, v_line.id, v_reason, p_note, now(), 'CUSTOMER_RETURN', v_r.id, v_group);
      v_in := private.post_movement(v_company, 'TRANSFER_IN', v_line.batch_id, v_target.id, v_line.quantity_received, null,
        'CUSTOMER_RETURN', v_r.return_number, v_line.id, v_reason, p_note, now(), 'CUSTOMER_RETURN', v_r.id, v_group);
      v_ids := array[v_out, v_in];
    elsif v_line.disposition = 'RETURN_TO_CUSTOMER' then
      v_out := private.post_movement(v_company, 'ISSUE', v_line.batch_id, v_r.receipt_location_id, v_line.quantity_received, null,
        'CUSTOMER_RETURN', v_r.return_number, v_line.id, v_reason, p_note, now(), 'CUSTOMER_RETURN', v_r.id);
      v_ids := array[v_out];
    end if;
    update public.customer_return_lines set disposition_posted = v_line.disposition in ('RESTOCK', 'SCRAP', 'RETURN_TO_CUSTOMER'), disposition_transaction_ids = v_ids
    where id = v_line.id;
    v_numbers := v_numbers || coalesce((select array_agg(transaction_number order by transaction_number) from public.inventory_transactions where id = any(v_ids)), '{}');
  end loop;

  update public.customer_returns set status = 'CLOSED', closed_by = auth.uid(), closed_at = now() where id = v_r.id;
  perform private.log_so_event(v_company, v_r.sales_order_id, v_r.fulfilment_id, v_r.id, null, 'RETURN_CLOSED', v_r.status, 'CLOSED', p_note,
    jsonb_build_object('return_number', v_r.return_number, 'transaction_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('status', 'CLOSED', 'transaction_numbers', to_jsonb(v_numbers)));
end;
$$;

create or replace view public.customer_return_list
with (security_invoker = true) as
select r.*, so.sales_order_number, so.customer_po_number, f.fulfilment_number, loc.location_code as receipt_location_code,
  t.line_count, t.requested, t.received, t.units, t.restocked, t.pending_dispositions
from public.customer_returns r
join public.sales_orders so on so.id = r.sales_order_id
left join public.fulfilments f on f.id = r.fulfilment_id
left join public.inventory_locations loc on loc.id = r.receipt_location_id
left join lateral (
  select count(*)::int as line_count, sum(rl.quantity_requested) as requested, sum(rl.quantity_received) as received,
    string_agg(distinct p.base_unit, ', ') as units,
    coalesce(sum(rl.quantity_received) filter (where rl.disposition = 'RESTOCK' and rl.disposition_posted), 0) as restocked,
    count(*) filter (where rl.quantity_received > 0 and rl.disposition = 'PENDING_REVIEW')::int as pending_dispositions
  from public.customer_return_lines rl join public.products p on p.id = rl.product_id where rl.return_id = r.id
) t on true;

create or replace view public.customer_return_line_list
with (security_invoker = true) as
select rl.*, r.return_number, r.status as return_status, r.sales_order_id, r.reason_code,
  p.sku, p.product_name, p.base_unit as unit, bt.batch_number, f.fulfilment_number, fl.quantity_dispatched as fulfilment_line_dispatched,
  t.transaction_number as receipt_transaction_number
from public.customer_return_lines rl
join public.customer_returns r on r.id = rl.return_id
join public.products p on p.id = rl.product_id
join public.inventory_batches bt on bt.id = rl.batch_id
join public.fulfilment_lines fl on fl.id = rl.fulfilment_line_id
join public.fulfilments f on f.id = fl.fulfilment_id
left join public.inventory_transactions t on t.id = rl.receipt_transaction_id;

revoke all on public.customer_return_list, public.customer_return_line_list from anon, authenticated;
grant select on public.customer_return_list, public.customer_return_line_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.customer_return_create(uuid, jsonb, jsonb, uuid)', 'public.customer_return_review(uuid, text, text)',
    'public.customer_return_receive(uuid, uuid, jsonb, timestamptz, text, uuid)', 'public.customer_return_inspect(uuid, jsonb, text, text)',
    'public.customer_return_post_disposition(uuid, uuid, uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
