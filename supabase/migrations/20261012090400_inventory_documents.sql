-- =============================================================================
-- Phase 4: approval documents
--   Opening stock (manual + staged import)  -> OPENING_STOCK on approval
--   Stock adjustments (quantity / source)   -> ADJUSTMENT_IN / ADJUSTMENT_OUT on approval
--   Physical stock counts                   -> ADJUSTMENT_IN / ADJUSTMENT_OUT for variances on approval
--
-- Approval and posting happen in ONE transaction (all-or-nothing). If posting
-- fails, the document stays PENDING/SUBMITTED and nothing is posted.
-- Segregation of duties (company setting inventory.segregation_of_duties,
-- default ON): the approver cannot be the requester / counter.
-- =============================================================================

create or replace function private.assert_not_self_approval(p_company uuid, p_requested_by uuid, p_counted_by uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (private.inventory_policy(p_company) ->> 'segregation_of_duties')::boolean
     and auth.uid() in (p_requested_by, p_counted_by) then
    raise exception 'Segregation of duties: you cannot approve your own request. Another authorised user must approve it.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.assert_not_self_approval(uuid, uuid, uuid) from public, anon, authenticated;

-- Effective timestamp for an approved document dated p_day (company timezone).
create or replace function private.effective_timestamp(p_company uuid, p_day date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_day is null or p_day >= private.company_today(p_company) then now()
              else private.company_day_start(p_company, p_day) end;
$$;

revoke all on function private.effective_timestamp(uuid, date) from public, anon, authenticated;

-- =============================================================================
-- OPENING STOCK
-- =============================================================================
create table if not exists public.inventory_opening_batches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  document_number text not null,
  source          text not null check (source in ('MANUAL', 'IMPORT')),
  file_name       text check (file_name is null or length(file_name) <= 200),
  status          text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED')),
  line_count      integer not null default 0,
  notes           text check (notes is null or length(notes) <= 2000),
  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text check (review_note is null or length(review_note) <= 1000),
  posted_at       timestamptz,
  updated_at      timestamptz not null default now(),
  constraint inventory_opening_batches_number_unique unique (company_id, document_number),
  constraint inventory_opening_batches_id_company_unique unique (id, company_id)
);

create table if not exists public.inventory_opening_lines (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  opening_batch_id      uuid not null,
  line_no               integer not null,
  product_id            uuid not null,
  warehouse_id          uuid not null,
  location_id           uuid not null,
  source_type           text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  batch_number          text,
  manufacturing_date    date,
  expiry_date           date,
  unit_cost             numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  quantity              numeric(14,3) not null check (quantity > 0),
  effective_date        date not null,
  reference             text check (reference is null or length(reference) <= 100),
  notes                 text check (notes is null or length(notes) <= 1000),
  status                text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED')),
  posted_transaction_id uuid references public.inventory_transactions (id),
  created_at            timestamptz not null default now(),
  constraint inventory_opening_lines_batch_fk foreign key (opening_batch_id, company_id)
    references public.inventory_opening_batches (id, company_id) on delete restrict,
  constraint inventory_opening_lines_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint inventory_opening_lines_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

-- One opening balance per product + location + lot (pending or posted).
create unique index if not exists inventory_opening_lines_no_duplicate
  on public.inventory_opening_lines (company_id, product_id, location_id, coalesce(lower(batch_number), ''), source_type)
  where status in ('PENDING_APPROVAL', 'POSTED');
create index if not exists inventory_opening_lines_batch_idx on public.inventory_opening_lines (opening_batch_id, line_no);

create or replace function public.inventory_submit_opening_stock(
  p_lines           jsonb,
  p_source          text default 'MANUAL',
  p_file_name       text default null,
  p_notes           text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('inventory_opening.create');
  v_previous  jsonb;
  v_today     date;
  v_errors    jsonb := '[]'::jsonb;
  v_keys      text[] := '{}';
  v_valid     jsonb := '[]'::jsonb;
  v_line      jsonb;
  v_no        integer;
  v_product   public.products;
  v_location  public.inventory_locations;
  v_wh_status text;
  v_qty       numeric;
  v_cost      numeric;
  v_eff       date;
  v_mfg       date;
  v_exp       date;
  v_source    text;
  v_batch     text;
  v_key       text;
  v_existing  text;
  v_doc_id    uuid;
  v_doc_no    text;
  v_msg       text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'opening_submit');
  if v_previous is not null then return v_previous; end if;

  if p_source not in ('MANUAL', 'IMPORT') then
    raise exception 'Source must be MANUAL or IMPORT.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Provide at least one opening stock line.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'At most 5000 lines can be submitted at once.' using errcode = 'P0001';
  end if;
  v_today := private.company_today(v_company);

  for v_line, v_no in select value, coalesce((value ->> 'line_no')::int, ordinality::int) from jsonb_array_elements(p_lines) with ordinality loop
    v_msg := null;
    begin
      v_qty    := (v_line ->> 'quantity')::numeric;
      v_cost   := nullif(v_line ->> 'unit_cost', '')::numeric;
      v_eff    := (v_line ->> 'effective_date')::date;
      v_mfg    := nullif(v_line ->> 'manufacturing_date', '')::date;
      v_exp    := nullif(v_line ->> 'expiry_date', '')::date;
      v_source := upper(coalesce(v_line ->> 'source_type', ''));
      v_batch  := nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '');

      select * into v_product from public.products where id = (v_line ->> 'product_id')::uuid and company_id = v_company;
      select * into v_location from public.inventory_locations where id = (v_line ->> 'location_id')::uuid and company_id = v_company;
      select status into v_wh_status from public.warehouses where id = v_location.warehouse_id;

      if v_product.id is null then v_msg := 'Product not found in your company.';
      elsif v_product.status <> 'ACTIVE' or v_product.archived_at is not null then v_msg := 'Product ' || v_product.sku || ' is inactive.';
      elsif v_location.id is null then v_msg := 'Location not found in your company.';
      elsif v_location.status <> 'ACTIVE' or v_wh_status <> 'ACTIVE' then v_msg := 'Location ' || v_location.location_code || ' is inactive.';
      elsif v_source not in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN') then v_msg := 'Source type must be IN_HOUSE, OUTSOURCED or UNKNOWN.';
      elsif v_qty is null or v_qty <= 0 then v_msg := 'Quantity must be greater than zero.';
      elsif v_qty <> round(v_qty, 3) or v_qty >= 1e10 then v_msg := 'Quantity has too many decimals or is too large.';
      elsif v_cost is not null and (v_cost < 0 or v_cost <> round(v_cost, 4)) then v_msg := 'Unit cost must be zero or more (max 4 decimals).';
      elsif v_eff is null then v_msg := 'Effective date is required.';
      elsif v_eff > v_today then v_msg := 'Effective date cannot be in the future.';
      elsif v_eff < date '2000-01-01' then v_msg := 'Effective date is too far in the past.';
      elsif coalesce(v_line ->> 'unit', '') <> '' and upper(v_line ->> 'unit') <> v_product.base_unit then
        v_msg := 'Unit ' || (v_line ->> 'unit') || ' does not match the product unit ' || v_product.base_unit || '.';
      elsif v_product.track_batches and v_batch is null then v_msg := 'Batch number is required for ' || v_product.sku || '.';
      elsif v_product.track_batches and v_batch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$' then v_msg := 'Invalid batch number.';
      elsif not v_product.track_batches and v_batch is not null then v_msg := v_product.sku || ' does not use batch tracking; leave the batch blank.';
      elsif not v_product.track_batches and v_exp is not null then v_msg := 'Expiry dates require batch tracking.';
      elsif v_product.track_expiry and v_exp is null then v_msg := 'Expiry date is required for ' || v_product.sku || '.';
      elsif v_mfg is not null and v_exp is not null and v_mfg > v_exp then v_msg := 'Manufacturing date is after the expiry date.';
      end if;
    exception when others then
      v_msg := 'Invalid value: ' || sqlerrm;
    end;

    if v_msg is null then
      v_key := v_product.id || '|' || v_location.id || '|' || coalesce(lower(v_batch), '') || '|' || v_source;
      if v_key = any (v_keys) then
        v_msg := 'Duplicate of another line in this submission (same product, location, batch and source).';
      else
        select b.document_number into v_existing
        from public.inventory_opening_lines l join public.inventory_opening_batches b on b.id = l.opening_batch_id
        where l.company_id = v_company and l.product_id = v_product.id and l.location_id = v_location.id
          and coalesce(lower(l.batch_number), '') = coalesce(lower(v_batch), '') and l.source_type = v_source
          and l.status in ('PENDING_APPROVAL', 'POSTED')
        limit 1;
        if v_existing is not null then
          v_msg := 'Opening stock for this product, location and batch already exists (' || v_existing || ').';
        end if;
      end if;
    end if;

    if v_msg is not null then
      v_errors := v_errors || jsonb_build_object('line_no', v_no, 'message', v_msg);
    else
      v_keys := v_keys || v_key;
      v_valid := v_valid || jsonb_build_object(
        'line_no', v_no, 'product_id', v_product.id, 'warehouse_id', v_location.warehouse_id, 'location_id', v_location.id,
        'source_type', v_source, 'batch_number', v_batch, 'manufacturing_date', v_mfg, 'expiry_date', v_exp,
        'unit_cost', v_cost, 'quantity', v_qty, 'effective_date', v_eff,
        'reference', nullif(btrim(coalesce(v_line ->> 'reference', '')), ''),
        'notes', nullif(btrim(coalesce(v_line ->> 'notes', '')), ''));
    end if;
  end loop;

  -- Nothing is staged unless every line is valid.
  if jsonb_array_length(v_errors) > 0 then
    return private.idempotency_finish(v_company, p_idempotency_key,
      jsonb_build_object('ok', false, 'errors', v_errors, 'valid_lines', jsonb_array_length(v_valid)));
  end if;

  v_doc_no := private.next_document_number(v_company, 'OS');
  insert into public.inventory_opening_batches (company_id, document_number, source, file_name, line_count, notes, requested_by)
  values (v_company, v_doc_no, p_source, left(p_file_name, 200), jsonb_array_length(v_valid), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_doc_id;

  insert into public.inventory_opening_lines (company_id, opening_batch_id, line_no, product_id, warehouse_id, location_id,
    source_type, batch_number, manufacturing_date, expiry_date, unit_cost, quantity, effective_date, reference, notes)
  select v_company, v_doc_id, (l ->> 'line_no')::int, (l ->> 'product_id')::uuid, (l ->> 'warehouse_id')::uuid,
    (l ->> 'location_id')::uuid, l ->> 'source_type', l ->> 'batch_number', (l ->> 'manufacturing_date')::date,
    (l ->> 'expiry_date')::date, (l ->> 'unit_cost')::numeric, (l ->> 'quantity')::numeric, (l ->> 'effective_date')::date,
    l ->> 'reference', l ->> 'notes'
  from jsonb_array_elements(v_valid) l;

  perform private.write_audit_log(v_company, 'inventory.opening_submitted', 'inventory_opening_batch', v_doc_id::text,
    jsonb_build_object('document_number', v_doc_no, 'lines', jsonb_array_length(v_valid), 'source', p_source));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'ok', true, 'opening_batch_id', v_doc_id, 'document_number', v_doc_no, 'line_count', jsonb_array_length(v_valid)));
end;
$$;

create or replace function public.inventory_review_opening_stock(
  p_opening_batch_id uuid,
  p_decision         text,
  p_note             text default null,
  p_idempotency_key  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory_opening.approve');
  v_previous jsonb;
  v_doc      public.inventory_opening_batches;
  v_line     public.inventory_opening_lines;
  v_lot      uuid;
  v_tx       uuid;
  v_posted   integer := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'opening_review');
  if v_previous is not null then return v_previous; end if;

  select * into v_doc from public.inventory_opening_batches where id = p_opening_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Opening stock document not found in your company.' using errcode = 'P0001';
  end if;
  if v_doc.status <> 'PENDING_APPROVAL' then
    raise exception 'Document % is already %.', v_doc.document_number, lower(replace(v_doc.status, '_', ' ')) using errcode = 'P0001';
  end if;
  perform private.assert_not_self_approval(v_company, v_doc.requested_by);

  if p_decision = 'REJECT' then
    if coalesce(btrim(p_note), '') = '' then
      raise exception 'Enter a reason for rejecting.' using errcode = 'P0001';
    end if;
    update public.inventory_opening_lines set status = 'REJECTED' where opening_batch_id = v_doc.id;
    update public.inventory_opening_batches
    set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = btrim(p_note), updated_at = now()
    where id = v_doc.id;
  elsif p_decision = 'APPROVE' then
    for v_line in select * from public.inventory_opening_lines where opening_batch_id = v_doc.id order by line_no loop
      begin
        perform private.require_active_product(v_company, v_line.product_id);
        v_lot := private.ensure_batch(v_company, v_line.product_id, v_line.source_type, v_line.batch_number,
          v_line.manufacturing_date, v_line.expiry_date, v_line.unit_cost, 'OPENING_STOCK', v_doc.id,
          v_line.warehouse_id, v_line.location_id, true);
        v_tx := private.post_movement(v_company, 'OPENING_STOCK', v_lot, v_line.location_id, v_line.quantity, v_line.unit_cost,
          'OPENING_STOCK', coalesce(v_line.reference, v_doc.document_number), v_doc.id,
          'Opening stock ' || v_doc.document_number, v_line.notes,
          private.company_day_start(v_company, v_line.effective_date), 'OPENING', v_doc.id, null, null, auth.uid());
      exception when others then
        raise exception 'Line %: %', v_line.line_no, sqlerrm using errcode = 'P0001';
      end;
      update public.inventory_opening_lines set status = 'POSTED', posted_transaction_id = v_tx where id = v_line.id;
      v_posted := v_posted + 1;
    end loop;
    update public.inventory_opening_batches
    set status = 'POSTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), ''),
        posted_at = now(), updated_at = now()
    where id = v_doc.id;
  else
    raise exception 'Decision must be APPROVE or REJECT.' using errcode = 'P0001';
  end if;

  perform private.write_audit_log(v_company, case when p_decision = 'APPROVE' then 'inventory.opening_posted' else 'inventory.opening_rejected' end,
    'inventory_opening_batch', v_doc.id::text, jsonb_build_object('document_number', v_doc.document_number, 'lines_posted', v_posted));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('status', case when p_decision = 'APPROVE' then 'POSTED' else 'REJECTED' end, 'lines_posted', v_posted));
end;
$$;

create or replace function public.inventory_cancel_opening_stock(p_opening_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_doc     public.inventory_opening_batches;
begin
  select * into v_doc from public.inventory_opening_batches where id = p_opening_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Opening stock document not found in your company.' using errcode = 'P0001';
  end if;
  if not ((v_doc.requested_by = auth.uid() and private.has_permission(v_company, 'inventory_opening.create'))
          or private.has_permission(v_company, 'inventory_opening.approve')) then
    raise exception 'You are not allowed to cancel this document.' using errcode = '42501';
  end if;
  if v_doc.status <> 'PENDING_APPROVAL' then
    raise exception 'Only pending documents can be cancelled.' using errcode = 'P0001';
  end if;
  update public.inventory_opening_lines set status = 'CANCELLED' where opening_batch_id = v_doc.id;
  update public.inventory_opening_batches set status = 'CANCELLED', updated_at = now() where id = v_doc.id;
  perform private.write_audit_log(v_company, 'inventory.opening_cancelled', 'inventory_opening_batch', v_doc.id::text,
    jsonb_build_object('document_number', v_doc.document_number));
  return jsonb_build_object('status', 'CANCELLED');
end;
$$;

-- =============================================================================
-- ADJUSTMENTS
-- =============================================================================
create table if not exists public.inventory_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  adjustment_number   text not null,
  adjustment_type     text not null check (adjustment_type in ('QUANTITY', 'SOURCE_CORRECTION')),
  product_id          uuid not null,
  batch_id            uuid,
  batch_number        text,
  warehouse_id        uuid not null,
  location_id         uuid not null,
  source_type         text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  target_source_type  text check (target_source_type is null or target_source_type in ('IN_HOUSE', 'OUTSOURCED')),
  system_quantity     numeric(14,3) not null check (system_quantity >= 0),
  counted_quantity    numeric(14,3) check (counted_quantity is null or counted_quantity >= 0),
  correction_quantity numeric(14,3) check (correction_quantity is null or correction_quantity > 0),
  difference          numeric(14,3) generated always as (counted_quantity - system_quantity) stored,
  unit_cost           numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  reason_code         text not null check (reason_code in ('DAMAGE', 'LOSS', 'THEFT', 'FOUND', 'COUNT_VARIANCE', 'EXPIRED', 'DATA_CORRECTION', 'SOURCE_CORRECTION', 'OTHER')),
  notes               text check (notes is null or length(notes) <= 2000),
  reference           text check (reference is null or length(reference) <= 100),
  effective_date      date not null,
  status              text not null default 'PENDING_APPROVAL' check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED', 'CANCELLED')),
  requested_by        uuid,
  requested_at        timestamptz not null default now(),
  submitted_at        timestamptz,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  review_note         text check (review_note is null or length(review_note) <= 1000),
  posted_at           timestamptz,
  updated_at          timestamptz not null default now(),
  constraint inventory_adjustments_number_unique unique (company_id, adjustment_number),
  constraint inventory_adjustments_shape check (
    (adjustment_type = 'QUANTITY' and counted_quantity is not null and correction_quantity is null and target_source_type is null)
    or (adjustment_type = 'SOURCE_CORRECTION' and correction_quantity is not null and target_source_type is not null
        and target_source_type <> source_type and batch_id is not null)),
  constraint inventory_adjustments_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint inventory_adjustments_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict,
  constraint inventory_adjustments_batch_fk foreign key (batch_id, product_id, company_id)
    references public.inventory_batches (id, product_id, company_id) on delete restrict
);

create index if not exists inventory_adjustments_status_idx on public.inventory_adjustments (company_id, status, requested_at desc);

create or replace function public.inventory_create_adjustment(
  p_adjustment_type     text,
  p_product_id          uuid,
  p_location_id         uuid,
  p_reason_code         text,
  p_batch_id            uuid default null,
  p_batch_number        text default null,
  p_source_type         text default null,
  p_counted_quantity    numeric default null,
  p_correction_quantity numeric default null,
  p_target_source_type  text default null,
  p_unit_cost           numeric default null,
  p_notes               text default null,
  p_reference           text default null,
  p_effective_date      date default null,
  p_submit              boolean default true,
  p_idempotency_key     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('inventory.adjust');
  v_previous  jsonb;
  v_product   public.products;
  v_location  public.inventory_locations;
  v_lot       public.inventory_batches;
  v_system    numeric := 0;
  v_reserved  numeric := 0;
  v_effective date := coalesce(p_effective_date, private.company_today(v_company));
  v_number    text;
  v_id        uuid;
  v_status    text := case when p_submit then 'PENDING_APPROVAL' else 'DRAFT' end;
  v_batch     text := nullif(btrim(coalesce(p_batch_number, '')), '');
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'adjustment_create');
  if v_previous is not null then return v_previous; end if;

  select * into v_product from public.products where id = p_product_id and company_id = v_company;
  if not found then raise exception 'Product not found in your company.' using errcode = 'P0001'; end if;
  select * into v_location from public.inventory_locations where id = p_location_id and company_id = v_company;
  if not found then raise exception 'Location not found in your company.' using errcode = 'P0001'; end if;
  if v_location.status <> 'ACTIVE' then raise exception 'Location is inactive.' using errcode = 'P0001'; end if;
  if v_effective > private.company_today(v_company) then
    raise exception 'The effective date cannot be in the future.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_notes), '') = '' and coalesce(btrim(p_reference), '') = '' then
    raise exception 'Add supporting notes or a reference.' using errcode = 'P0001';
  end if;

  -- Identify the lot (may not exist yet for found stock).
  if p_batch_id is not null then
    select * into v_lot from public.inventory_batches where id = p_batch_id and product_id = p_product_id and company_id = v_company;
    if not found then raise exception 'The selected batch does not belong to this product.' using errcode = 'P0001'; end if;
  else
    if p_source_type is null or p_source_type not in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN') then
      raise exception 'Select the stock source.' using errcode = 'P0001';
    end if;
    if v_product.track_batches and v_batch is null then
      raise exception 'Enter the batch number.' using errcode = 'P0001';
    end if;
    if not v_product.track_batches and v_batch is not null then
      raise exception 'This product does not use batch tracking.' using errcode = 'P0001';
    end if;
    select * into v_lot from public.inventory_batches
    where company_id = v_company and product_id = p_product_id and source_type = p_source_type
      and ((v_batch is null and is_system_lot) or (v_batch is not null and not is_system_lot and lower(batch_number) = lower(v_batch)));
  end if;

  if v_lot.id is not null then
    select coalesce(on_hand, 0), coalesce(reserved, 0) into v_system, v_reserved
    from public.inventory_balances where batch_id = v_lot.id and location_id = p_location_id;
    v_system := coalesce(v_system, 0);
    v_reserved := coalesce(v_reserved, 0);
  end if;

  if p_adjustment_type = 'QUANTITY' then
    if p_counted_quantity is null or p_counted_quantity < 0 or p_counted_quantity <> round(p_counted_quantity, 3) then
      raise exception 'Enter the counted / corrected quantity (zero or more, up to 3 decimals).' using errcode = 'P0001';
    end if;
    if p_counted_quantity = v_system then
      raise exception 'The corrected quantity equals the system quantity; nothing to adjust.' using errcode = 'P0001';
    end if;
    if p_reason_code is null or p_reason_code = 'SOURCE_CORRECTION' then
      raise exception 'Select an adjustment reason.' using errcode = 'P0001';
    end if;
    if v_lot.id is null and coalesce(p_source_type, '') = 'UNKNOWN' then
      raise exception 'New stock must have a known source (IN_HOUSE or OUTSOURCED).' using errcode = 'P0001';
    end if;
  elsif p_adjustment_type = 'SOURCE_CORRECTION' then
    if v_lot.id is null then
      raise exception 'There is no stock of this lot to correct.' using errcode = 'P0001';
    end if;
    if p_target_source_type is null or p_target_source_type not in ('IN_HOUSE', 'OUTSOURCED') or p_target_source_type = v_lot.source_type then
      raise exception 'Choose a different target source (IN_HOUSE or OUTSOURCED).' using errcode = 'P0001';
    end if;
    if p_correction_quantity is null or p_correction_quantity <= 0 or p_correction_quantity > v_system - v_reserved then
      raise exception 'Correction quantity must be between 0 and the unreserved quantity (%).', v_system - v_reserved using errcode = 'P0001';
    end if;
  else
    raise exception 'Adjustment type must be QUANTITY or SOURCE_CORRECTION.' using errcode = 'P0001';
  end if;

  v_number := private.next_document_number(v_company, 'ADJ');
  insert into public.inventory_adjustments (company_id, adjustment_number, adjustment_type, product_id, batch_id, batch_number,
    warehouse_id, location_id, source_type, target_source_type, system_quantity, counted_quantity, correction_quantity, unit_cost,
    reason_code, notes, reference, effective_date, status, requested_by, submitted_at)
  values (v_company, v_number, p_adjustment_type, p_product_id, v_lot.id, coalesce(v_lot.batch_number, v_batch),
    v_location.warehouse_id, v_location.id, coalesce(v_lot.source_type, p_source_type),
    case when p_adjustment_type = 'SOURCE_CORRECTION' then p_target_source_type end,
    v_system,
    case when p_adjustment_type = 'QUANTITY' then p_counted_quantity end,
    case when p_adjustment_type = 'SOURCE_CORRECTION' then p_correction_quantity end,
    p_unit_cost,
    case when p_adjustment_type = 'SOURCE_CORRECTION' then 'SOURCE_CORRECTION' else p_reason_code end,
    nullif(btrim(coalesce(p_notes, '')), ''), nullif(btrim(coalesce(p_reference, '')), ''), v_effective, v_status, auth.uid(),
    case when p_submit then now() end)
  returning id into v_id;

  perform private.write_audit_log(v_company, 'inventory.adjustment_requested', 'inventory_adjustment', v_id::text,
    jsonb_build_object('adjustment_number', v_number, 'type', p_adjustment_type, 'status', v_status));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('adjustment_id', v_id, 'adjustment_number', v_number, 'status', v_status));
end;
$$;

create or replace function public.inventory_update_adjustment_status(p_adjustment_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory.adjust');
  v_adj     public.inventory_adjustments;
begin
  select * into v_adj from public.inventory_adjustments where id = p_adjustment_id and company_id = v_company for update;
  if not found then raise exception 'Adjustment not found in your company.' using errcode = 'P0001'; end if;
  if v_adj.requested_by <> auth.uid() then
    raise exception 'Only the requester can submit or cancel this adjustment.' using errcode = '42501';
  end if;
  if p_action = 'SUBMIT' and v_adj.status = 'DRAFT' then
    update public.inventory_adjustments set status = 'PENDING_APPROVAL', submitted_at = now(), updated_at = now() where id = v_adj.id;
  elsif p_action = 'CANCEL' and v_adj.status in ('DRAFT', 'PENDING_APPROVAL') then
    update public.inventory_adjustments set status = 'CANCELLED', updated_at = now() where id = v_adj.id;
  else
    raise exception 'This action is not possible while the adjustment is %.', lower(replace(v_adj.status, '_', ' ')) using errcode = 'P0001';
  end if;
  return jsonb_build_object('status', case when p_action = 'SUBMIT' then 'PENDING_APPROVAL' else 'CANCELLED' end);
end;
$$;

create or replace function public.inventory_review_adjustment(
  p_adjustment_id   uuid,
  p_decision        text,
  p_note            text default null,
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
  v_adj      public.inventory_adjustments;
  v_lot      public.inventory_batches;
  v_target   uuid;
  v_delta    numeric;
  v_when     timestamptz;
  v_txs      text[] := '{}';
  v_tx       uuid;
  v_reason   text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'adjustment_review');
  if v_previous is not null then return v_previous; end if;

  select * into v_adj from public.inventory_adjustments where id = p_adjustment_id and company_id = v_company for update;
  if not found then raise exception 'Adjustment not found in your company.' using errcode = 'P0001'; end if;
  if v_adj.status <> 'PENDING_APPROVAL' then
    raise exception 'Adjustment % is %; only pending adjustments can be reviewed.', v_adj.adjustment_number,
      lower(replace(v_adj.status, '_', ' ')) using errcode = 'P0001';
  end if;
  perform private.assert_not_self_approval(v_company, v_adj.requested_by);

  if p_decision = 'REJECT' then
    if coalesce(btrim(p_note), '') = '' then raise exception 'Enter a reason for rejecting.' using errcode = 'P0001'; end if;
    update public.inventory_adjustments
    set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = btrim(p_note), updated_at = now()
    where id = v_adj.id;
  elsif p_decision = 'APPROVE' then
    v_when := private.effective_timestamp(v_company, v_adj.effective_date);
    v_reason := 'Adjustment ' || v_adj.adjustment_number || ' (' || lower(replace(v_adj.reason_code, '_', ' ')) || ')';

    if v_adj.adjustment_type = 'QUANTITY' then
      v_delta := v_adj.counted_quantity - v_adj.system_quantity;
      if v_delta > 0 then
        v_target := coalesce(v_adj.batch_id, private.ensure_batch(v_company, v_adj.product_id, v_adj.source_type, v_adj.batch_number,
          null, null, v_adj.unit_cost, 'ADJUSTMENT', v_adj.id, v_adj.warehouse_id, v_adj.location_id, false));
        v_tx := private.post_movement(v_company, 'ADJUSTMENT_IN', v_target, v_adj.location_id, v_delta, v_adj.unit_cost,
          'ADJUSTMENT', v_adj.adjustment_number, v_adj.id, v_reason, v_adj.notes, v_when, 'ADJUSTMENT', v_adj.id, null, null, auth.uid());
      else
        v_tx := private.post_movement(v_company, 'ADJUSTMENT_OUT', v_adj.batch_id, v_adj.location_id, -v_delta, null,
          'ADJUSTMENT', v_adj.adjustment_number, v_adj.id, v_reason, v_adj.notes, v_when, 'ADJUSTMENT', v_adj.id, null, null, auth.uid());
      end if;
      v_txs := v_txs || (select transaction_number from public.inventory_transactions where id = v_tx);
    else
      -- Source correction: move quantity to the same batch under the correct source, keeping its cost.
      select * into v_lot from public.inventory_batches where id = v_adj.batch_id;
      v_tx := private.post_movement(v_company, 'ADJUSTMENT_OUT', v_lot.id, v_adj.location_id, v_adj.correction_quantity, null,
        'ADJUSTMENT', v_adj.adjustment_number, v_adj.id, v_reason || ': ' || v_adj.source_type || ' to ' || v_adj.target_source_type,
        v_adj.notes, v_when, 'ADJUSTMENT', v_adj.id, null, null, auth.uid());
      v_txs := v_txs || (select transaction_number from public.inventory_transactions where id = v_tx);
      v_target := private.ensure_batch(v_company, v_lot.product_id, v_adj.target_source_type, v_lot.batch_number,
        v_lot.manufacturing_date, v_lot.expiry_date, v_lot.unit_cost, 'ADJUSTMENT', v_adj.id, v_adj.warehouse_id, v_adj.location_id, false);
      v_tx := private.post_movement(v_company, 'ADJUSTMENT_IN', v_target, v_adj.location_id, v_adj.correction_quantity,
        private.lot_average_cost(v_lot.id), 'ADJUSTMENT', v_adj.adjustment_number, v_adj.id,
        v_reason || ': ' || v_adj.source_type || ' to ' || v_adj.target_source_type, v_adj.notes, v_when, 'ADJUSTMENT', v_adj.id,
        null, null, auth.uid());
      v_txs := v_txs || (select transaction_number from public.inventory_transactions where id = v_tx);
    end if;

    update public.inventory_adjustments
    set status = 'POSTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), ''),
        posted_at = now(), updated_at = now()
    where id = v_adj.id;
  else
    raise exception 'Decision must be APPROVE or REJECT.' using errcode = 'P0001';
  end if;

  perform private.write_audit_log(v_company, case when p_decision = 'APPROVE' then 'inventory.adjustment_posted' else 'inventory.adjustment_rejected' end,
    'inventory_adjustment', v_adj.id::text, jsonb_build_object('adjustment_number', v_adj.adjustment_number, 'transactions', to_jsonb(v_txs)));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('status', case when p_decision = 'APPROVE' then 'POSTED' else 'REJECTED' end, 'transactions', to_jsonb(v_txs)));
end;
$$;

-- =============================================================================
-- PHYSICAL STOCK COUNTS
-- =============================================================================
create table if not exists public.inventory_counts (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  count_number         text not null,
  warehouse_id         uuid not null,
  location_id          uuid,
  include_sublocations boolean not null default true,
  product_ids          uuid[],
  status               text not null default 'OPEN' check (status in ('OPEN', 'SUBMITTED', 'POSTED', 'REJECTED', 'CANCELLED')),
  snapshot_at          timestamptz not null default now(),
  notes                text check (notes is null or length(notes) <= 2000),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  submitted_by         uuid,
  submitted_at         timestamptz,
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text check (review_note is null or length(review_note) <= 1000),
  posted_at            timestamptz,
  updated_at           timestamptz not null default now(),
  constraint inventory_counts_number_unique unique (company_id, count_number),
  constraint inventory_counts_id_company_unique unique (id, company_id),
  constraint inventory_counts_warehouse_fk foreign key (warehouse_id, company_id)
    references public.warehouses (id, company_id) on delete restrict,
  constraint inventory_counts_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create table if not exists public.inventory_count_lines (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  count_id              uuid not null,
  product_id            uuid not null,
  batch_id              uuid,
  batch_number          text,
  expiry_date           date,
  source_type           text not null check (source_type in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN')),
  warehouse_id          uuid not null,
  location_id           uuid not null,
  system_quantity       numeric(14,3) not null default 0 check (system_quantity >= 0),
  counted_quantity      numeric(14,3) check (counted_quantity is null or counted_quantity >= 0),
  variance              numeric(14,3) generated always as (counted_quantity - system_quantity) stored,
  is_added              boolean not null default false,
  counted_by            uuid,
  counted_at            timestamptz,
  notes                 text check (notes is null or length(notes) <= 500),
  posted_transaction_id uuid references public.inventory_transactions (id),
  created_at            timestamptz not null default now(),
  constraint inventory_count_lines_count_fk foreign key (count_id, company_id)
    references public.inventory_counts (id, company_id) on delete restrict,
  constraint inventory_count_lines_product_fk foreign key (product_id, company_id)
    references public.products (id, company_id) on delete restrict,
  constraint inventory_count_lines_location_fk foreign key (location_id, warehouse_id, company_id)
    references public.inventory_locations (id, warehouse_id, company_id) on delete restrict
);

create unique index if not exists inventory_count_lines_unique
  on public.inventory_count_lines (count_id, product_id, location_id, source_type, coalesce(lower(batch_number), ''));
create index if not exists inventory_count_lines_count_idx on public.inventory_count_lines (count_id);
create index if not exists inventory_counts_status_idx on public.inventory_counts (company_id, status, created_at desc);

-- Locations covered by a count (the location and, optionally, its descendants).
create or replace function private.count_location_ids(p_warehouse_id uuid, p_location_id uuid, p_include_children boolean)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  with recursive tree as (
    select id from public.inventory_locations
    where warehouse_id = p_warehouse_id and (p_location_id is null or id = p_location_id)
    union
    select c.id from public.inventory_locations c join tree t on c.parent_location_id = t.id
    where p_location_id is not null and p_include_children
  )
  select coalesce(array_agg(id), '{}') from tree;
$$;

revoke all on function private.count_location_ids(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.inventory_create_count(
  p_warehouse_id         uuid,
  p_location_id          uuid default null,
  p_include_sublocations boolean default true,
  p_product_ids          uuid[] default null,
  p_notes                text default null,
  p_idempotency_key      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('inventory_count.create');
  v_previous  jsonb;
  v_locations uuid[];
  v_id        uuid;
  v_number    text;
  v_lines     integer;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'count_create');
  if v_previous is not null then return v_previous; end if;

  if not exists (select 1 from public.warehouses where id = p_warehouse_id and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Select an active warehouse of your company.' using errcode = 'P0001';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.inventory_locations where id = p_location_id and warehouse_id = p_warehouse_id and company_id = v_company) then
    raise exception 'The location does not belong to the selected warehouse.' using errcode = 'P0001';
  end if;
  v_locations := private.count_location_ids(p_warehouse_id, p_location_id, coalesce(p_include_sublocations, true));

  v_number := private.next_document_number(v_company, 'CNT');
  insert into public.inventory_counts (company_id, count_number, warehouse_id, location_id, include_sublocations, product_ids, notes, created_by)
  values (v_company, v_number, p_warehouse_id, p_location_id, coalesce(p_include_sublocations, true),
    nullif(p_product_ids, '{}'), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  -- Snapshot of system quantities at count creation.
  insert into public.inventory_count_lines (company_id, count_id, product_id, batch_id, batch_number, expiry_date, source_type,
    warehouse_id, location_id, system_quantity)
  select v_company, v_id, b.product_id, b.batch_id, bt.batch_number, bt.expiry_date, b.source_type, b.warehouse_id, b.location_id, b.on_hand
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  where b.company_id = v_company and b.location_id = any (v_locations) and b.on_hand > 0
    and (p_product_ids is null or cardinality(p_product_ids) = 0 or b.product_id = any (p_product_ids));
  get diagnostics v_lines = row_count;

  perform private.write_audit_log(v_company, 'inventory.count_created', 'inventory_count', v_id::text,
    jsonb_build_object('count_number', v_number, 'lines', v_lines));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('count_id', v_id, 'count_number', v_number, 'line_count', v_lines));
end;
$$;

create or replace function public.inventory_record_count(p_count_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_count.create');
  v_count   public.inventory_counts;
  v_item    jsonb;
  v_qty     numeric;
  v_updated integer := 0;
begin
  select * into v_count from public.inventory_counts where id = p_count_id and company_id = v_company for update;
  if not found then raise exception 'Count not found in your company.' using errcode = 'P0001'; end if;
  if v_count.status <> 'OPEN' then raise exception 'Count % is no longer open.', v_count.count_number using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Lines must be an array.' using errcode = 'P0001'; end if;

  for v_item in select value from jsonb_array_elements(p_lines) loop
    v_qty := nullif(v_item ->> 'counted_quantity', '')::numeric;
    if v_qty is not null and (v_qty < 0 or v_qty <> round(v_qty, 3)) then
      raise exception 'Counted quantities must be zero or more with up to 3 decimals.' using errcode = 'P0001';
    end if;
    update public.inventory_count_lines
    set counted_quantity = v_qty,
        counted_by = case when v_qty is null then null else auth.uid() end,
        counted_at = case when v_qty is null then null else now() end,
        notes = coalesce(nullif(btrim(coalesce(v_item ->> 'notes', '')), ''), notes)
    where id = (v_item ->> 'line_id')::uuid and count_id = v_count.id;
    if not found then raise exception 'A line does not belong to count %.', v_count.count_number using errcode = 'P0001'; end if;
    v_updated := v_updated + 1;
  end loop;
  update public.inventory_counts set updated_at = now() where id = v_count.id;
  return jsonb_build_object('updated', v_updated);
end;
$$;

create or replace function public.inventory_add_count_line(
  p_count_id     uuid,
  p_product_id   uuid,
  p_location_id  uuid,
  p_source_type  text,
  p_batch_number text default null,
  p_expiry_date  date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_count.create');
  v_count   public.inventory_counts;
  v_product public.products;
  v_lot     public.inventory_batches;
  v_system  numeric := 0;
  v_batch   text := nullif(btrim(coalesce(p_batch_number, '')), '');
  v_id      uuid;
begin
  select * into v_count from public.inventory_counts where id = p_count_id and company_id = v_company for update;
  if not found then raise exception 'Count not found in your company.' using errcode = 'P0001'; end if;
  if v_count.status <> 'OPEN' then raise exception 'Count % is no longer open.', v_count.count_number using errcode = 'P0001'; end if;
  if not (p_location_id = any (private.count_location_ids(v_count.warehouse_id, v_count.location_id, v_count.include_sublocations))) then
    raise exception 'The location is outside the scope of this count.' using errcode = 'P0001';
  end if;
  select * into v_product from public.products where id = p_product_id and company_id = v_company and archived_at is null;
  if not found then raise exception 'Product not found in your company.' using errcode = 'P0001'; end if;
  if p_source_type not in ('IN_HOUSE', 'OUTSOURCED', 'UNKNOWN') then
    raise exception 'Select the stock source.' using errcode = 'P0001';
  end if;
  if v_product.track_batches and v_batch is null then raise exception 'Enter the batch number.' using errcode = 'P0001'; end if;
  if not v_product.track_batches and v_batch is not null then
    raise exception 'This product does not use batch tracking.' using errcode = 'P0001';
  end if;

  select * into v_lot from public.inventory_batches
  where company_id = v_company and product_id = p_product_id and source_type = p_source_type
    and ((v_batch is null and is_system_lot) or (v_batch is not null and not is_system_lot and lower(batch_number) = lower(v_batch)));
  if v_lot.id is null and p_source_type = 'UNKNOWN' then
    raise exception 'Found stock must have a known source (IN_HOUSE or OUTSOURCED).' using errcode = 'P0001';
  end if;
  if v_lot.id is not null then
    select coalesce(on_hand, 0) into v_system from public.inventory_balances where batch_id = v_lot.id and location_id = p_location_id;
  end if;

  insert into public.inventory_count_lines (company_id, count_id, product_id, batch_id, batch_number, expiry_date, source_type,
    warehouse_id, location_id, system_quantity, is_added)
  values (v_company, v_count.id, p_product_id, v_lot.id, coalesce(v_lot.batch_number, v_batch), coalesce(v_lot.expiry_date, p_expiry_date),
    p_source_type, v_count.warehouse_id, p_location_id, coalesce(v_system, 0), true)
  returning id into v_id;
  return jsonb_build_object('line_id', v_id, 'system_quantity', coalesce(v_system, 0));
exception when unique_violation then
  raise exception 'This product, batch and source is already on the count sheet for that location.' using errcode = 'P0001';
end;
$$;

create or replace function public.inventory_submit_count(p_count_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('inventory_count.create');
  v_count   public.inventory_counts;
begin
  select * into v_count from public.inventory_counts where id = p_count_id and company_id = v_company for update;
  if not found then raise exception 'Count not found in your company.' using errcode = 'P0001'; end if;
  if v_count.status <> 'OPEN' then raise exception 'Count % is not open.', v_count.count_number using errcode = 'P0001'; end if;
  if not exists (select 1 from public.inventory_count_lines where count_id = v_count.id and counted_quantity is not null) then
    raise exception 'Record at least one counted quantity before submitting.' using errcode = 'P0001';
  end if;
  update public.inventory_counts set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(), updated_at = now()
  where id = v_count.id;
  perform private.write_audit_log(v_company, 'inventory.count_submitted', 'inventory_count', v_count.id::text,
    jsonb_build_object('count_number', v_count.count_number));
  return jsonb_build_object('status', 'SUBMITTED');
end;
$$;

create or replace function public.inventory_review_count(
  p_count_id        uuid,
  p_decision        text,
  p_note            text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory_count.approve');
  v_previous jsonb;
  v_count    public.inventory_counts;
  v_line     public.inventory_count_lines;
  v_lot      uuid;
  v_tx       uuid;
  v_posted   integer := 0;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'count_review');
  if v_previous is not null then return v_previous; end if;

  select * into v_count from public.inventory_counts where id = p_count_id and company_id = v_company for update;
  if not found then raise exception 'Count not found in your company.' using errcode = 'P0001'; end if;
  if v_count.status <> 'SUBMITTED' then
    raise exception 'Count % is %; only submitted counts can be reviewed.', v_count.count_number, lower(v_count.status) using errcode = 'P0001';
  end if;
  perform private.assert_not_self_approval(v_company, v_count.created_by, v_count.submitted_by);
  if exists (select 1 from public.inventory_count_lines where count_id = v_count.id and counted_by = auth.uid())
     and (private.inventory_policy(v_company) ->> 'segregation_of_duties')::boolean then
    raise exception 'Segregation of duties: you recorded quantities on this count and cannot approve it.' using errcode = '42501';
  end if;

  if p_decision = 'REJECT' then
    if coalesce(btrim(p_note), '') = '' then raise exception 'Enter a reason for rejecting.' using errcode = 'P0001'; end if;
    update public.inventory_counts
    set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = btrim(p_note), updated_at = now()
    where id = v_count.id;
  elsif p_decision = 'APPROVE' then
    for v_line in
      select * from public.inventory_count_lines
      where count_id = v_count.id and counted_quantity is not null and variance <> 0
      order by created_at, id
    loop
      begin
        if v_line.variance > 0 then
          v_lot := coalesce(v_line.batch_id, private.ensure_batch(v_company, v_line.product_id, v_line.source_type, v_line.batch_number,
            null, v_line.expiry_date, null, 'COUNT', v_count.id, v_line.warehouse_id, v_line.location_id, false));
          v_tx := private.post_movement(v_company, 'ADJUSTMENT_IN', v_lot, v_line.location_id, v_line.variance, null,
            'COUNT', v_count.count_number, v_count.id, 'Stock count ' || v_count.count_number || ' variance', v_line.notes,
            least(v_count.snapshot_at, now()), 'COUNT', v_count.id, null, null, auth.uid());
        else
          v_tx := private.post_movement(v_company, 'ADJUSTMENT_OUT', v_line.batch_id, v_line.location_id, -v_line.variance, null,
            'COUNT', v_count.count_number, v_count.id, 'Stock count ' || v_count.count_number || ' variance', v_line.notes,
            least(v_count.snapshot_at, now()), 'COUNT', v_count.id, null, null, auth.uid());
        end if;
      exception when others then
        raise exception 'Count line for % : %', (select sku from public.products where id = v_line.product_id), sqlerrm using errcode = 'P0001';
      end;
      update public.inventory_count_lines set posted_transaction_id = v_tx where id = v_line.id;
      v_posted := v_posted + 1;
    end loop;
    update public.inventory_counts
    set status = 'POSTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), ''),
        posted_at = now(), updated_at = now()
    where id = v_count.id;
  else
    raise exception 'Decision must be APPROVE or REJECT.' using errcode = 'P0001';
  end if;

  perform private.write_audit_log(v_company, case when p_decision = 'APPROVE' then 'inventory.count_posted' else 'inventory.count_rejected' end,
    'inventory_count', v_count.id::text, jsonb_build_object('count_number', v_count.count_number, 'adjustments_posted', v_posted));

  return private.idempotency_finish(v_company, p_idempotency_key,
    jsonb_build_object('status', case when p_decision = 'APPROVE' then 'POSTED' else 'REJECTED' end, 'adjustments_posted', v_posted));
end;
$$;

create or replace function public.inventory_cancel_count(p_count_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_count   public.inventory_counts;
begin
  select * into v_count from public.inventory_counts where id = p_count_id and company_id = v_company for update;
  if not found then raise exception 'Count not found in your company.' using errcode = 'P0001'; end if;
  if not ((v_count.created_by = auth.uid() and private.has_permission(v_company, 'inventory_count.create'))
          or private.has_permission(v_company, 'inventory_count.approve')) then
    raise exception 'You are not allowed to cancel this count.' using errcode = '42501';
  end if;
  if v_count.status not in ('OPEN', 'SUBMITTED') then
    raise exception 'Only open or submitted counts can be cancelled.' using errcode = 'P0001';
  end if;
  update public.inventory_counts set status = 'CANCELLED', updated_at = now() where id = v_count.id;
  perform private.write_audit_log(v_company, 'inventory.count_cancelled', 'inventory_count', v_count.id::text,
    jsonb_build_object('count_number', v_count.count_number));
  return jsonb_build_object('status', 'CANCELLED');
end;
$$;

-- =============================================================================
-- RLS: read-only for clients
-- =============================================================================
alter table public.inventory_opening_batches enable row level security;
alter table public.inventory_opening_lines enable row level security;
alter table public.inventory_adjustments enable row level security;
alter table public.inventory_counts enable row level security;
alter table public.inventory_count_lines enable row level security;

revoke all on table public.inventory_opening_batches, public.inventory_opening_lines, public.inventory_adjustments,
  public.inventory_counts, public.inventory_count_lines from anon, authenticated;
grant select on public.inventory_opening_batches, public.inventory_opening_lines, public.inventory_adjustments,
  public.inventory_counts, public.inventory_count_lines to authenticated;
grant all on table public.inventory_opening_batches, public.inventory_opening_lines, public.inventory_adjustments,
  public.inventory_counts, public.inventory_count_lines to service_role;

drop policy if exists inventory_opening_batches_select on public.inventory_opening_batches;
create policy inventory_opening_batches_select on public.inventory_opening_batches for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
drop policy if exists inventory_opening_lines_select on public.inventory_opening_lines;
create policy inventory_opening_lines_select on public.inventory_opening_lines for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
drop policy if exists inventory_adjustments_select on public.inventory_adjustments;
create policy inventory_adjustments_select on public.inventory_adjustments for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
drop policy if exists inventory_counts_select on public.inventory_counts;
create policy inventory_counts_select on public.inventory_counts for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));
drop policy if exists inventory_count_lines_select on public.inventory_count_lines;
create policy inventory_count_lines_select on public.inventory_count_lines for select to authenticated
  using (private.has_permission(company_id, 'inventory.read'));

-- Execute grants
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.inventory_submit_opening_stock(jsonb, text, text, text, uuid)',
    'public.inventory_review_opening_stock(uuid, text, text, uuid)',
    'public.inventory_cancel_opening_stock(uuid)',
    'public.inventory_create_adjustment(text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, boolean, uuid)',
    'public.inventory_update_adjustment_status(uuid, text)',
    'public.inventory_review_adjustment(uuid, text, text, uuid)',
    'public.inventory_create_count(uuid, uuid, boolean, uuid[], text, uuid)',
    'public.inventory_record_count(uuid, jsonb)',
    'public.inventory_add_count_line(uuid, uuid, uuid, text, text, date)',
    'public.inventory_submit_count(uuid)',
    'public.inventory_review_count(uuid, text, text, uuid)',
    'public.inventory_cancel_count(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
