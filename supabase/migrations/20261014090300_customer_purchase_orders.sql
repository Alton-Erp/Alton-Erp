-- =============================================================================
-- Phase 6: customer purchase orders — import, product matching, stock
-- availability, allocation (reservations), dispatch, revisions and shortages.
--
--   customer_po_import_batches       one row per confirmed import attempt
--   customer_purchase_orders         PO header; revisions are explicit rows
--   customer_purchase_order_lines    original uploaded line + matched product
--   customer_po_events               status / activity history (append-only)
--   customer_po_allocation_runs      allocation drafts and committed runs
--   customer_po_analysis_snapshots   saved availability analyses (history)
--   customer_po_shortage_notes       shortage follow-up notes
--
-- Files are parsed in the browser; the original file is NOT stored (only its
-- name, size, SHA-256 fingerprint and the parsed rows).
-- Allocations are public.stock_reservations rows (reference_type CUSTOMER_PO,
-- reference_id = PO line). Dispatch is an ISSUE that consumes them.
--
-- Availability (per line, never trusted from the browser):
--   eligible stock  = STORAGE locations of active warehouses, active lots, not
--                     expired, known source (IN_HOUSE / OUTSOURCED), and the
--                     PO's fulfilment warehouse when one is set
--   available       = on hand - all active reservations (eligible lots only)
--   lines of the same product consume availability in line order, so the same
--   stock is never counted twice within a PO
--   shortage before allocation = max(ordered - dispatched - allocated - available for line, 0)
--   shortage after allocation  = max(ordered - dispatched - allocated, 0)
-- =============================================================================

create table if not exists public.customer_po_import_batches (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  file_name         text not null check (length(file_name) between 1 and 255),
  file_hash         text check (file_hash is null or file_hash ~ '^[0-9a-f]{64}$'),
  file_size         bigint check (file_size is null or file_size >= 0),
  sheet_name        text check (sheet_name is null or length(sheet_name) <= 100),
  rows_read         integer not null default 0,
  valid_rows        integer not null default 0,
  invalid_rows      integer not null default 0,
  matched_rows      integer not null default 0,
  unmatched_rows    integer not null default 0,
  validation_status text not null check (validation_status in ('VALID', 'VALID_WITH_REJECTED_ROWS', 'INVALID')),
  import_status     text not null check (import_status in ('IMPORTED', 'REJECTED')),
  error_summary     jsonb not null default '[]'::jsonb,
  uploaded_by       uuid,
  uploaded_at       timestamptz not null default now(),
  constraint customer_po_import_batches_id_company_unique unique (id, company_id)
);

create table if not exists public.customer_purchase_orders (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  po_reference            text not null,
  customer_id             uuid,
  customer_name_snapshot  text not null check (length(btrim(customer_name_snapshot)) between 1 and 200),
  customer_key            text not null,
  customer_po_number      text not null check (length(btrim(customer_po_number)) between 1 and 100),
  revision                integer not null default 1 check (revision >= 1),
  previous_revision_id    uuid references public.customer_purchase_orders (id) on delete restrict,
  is_current              boolean not null default true,
  po_date                 date not null,
  required_delivery_date  date,
  currency                text check (currency is null or currency ~ '^[A-Z]{3}$'),
  fulfilment_warehouse_id uuid,
  status                  text not null default 'UPLOADED' check (status in ('DRAFT', 'UPLOADED', 'VALIDATION_REQUIRED', 'PRODUCT_MATCHING_REQUIRED',
                            'READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED')),
  status_before_hold      text,
  hold_reason             text check (hold_reason is null or length(hold_reason) <= 1000),
  cancel_reason           text check (cancel_reason is null or length(cancel_reason) <= 1000),
  source_filename         text,
  file_hash               text,
  import_batch_id         uuid,
  notes                   text check (notes is null or length(notes) <= 2000),
  uploaded_by             uuid,
  reviewed_by             uuid,
  cancelled_by            uuid,
  cancelled_at            timestamptz,
  last_analysis_at        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint customer_pos_reference_unique unique (company_id, po_reference),
  constraint customer_pos_id_company_unique unique (id, company_id),
  constraint customer_pos_dates check (required_delivery_date is null or required_delivery_date >= po_date),
  constraint customer_pos_customer_fk foreign key (customer_id, company_id) references public.customers (id, company_id) on delete restrict,
  constraint customer_pos_wh_fk foreign key (fulfilment_warehouse_id, company_id) references public.warehouses (id, company_id) on delete restrict,
  constraint customer_pos_batch_fk foreign key (import_batch_id, company_id) references public.customer_po_import_batches (id, company_id) on delete restrict
);

-- One row per revision; only one current revision per customer + PO number.
create unique index if not exists customer_pos_revision_unique on public.customer_purchase_orders (company_id, customer_key, lower(customer_po_number), revision);
create unique index if not exists customer_pos_current_unique on public.customer_purchase_orders (company_id, customer_key, lower(customer_po_number)) where is_current;
create index if not exists customer_pos_status_idx on public.customer_purchase_orders (company_id, status);
create index if not exists customer_pos_hash_idx on public.customer_purchase_orders (company_id, file_hash);

create table if not exists public.customer_purchase_order_lines (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  purchase_order_id       uuid not null,
  line_no                 integer not null,
  source_row_number       integer not null,
  uploaded_sku            text check (uploaded_sku is null or length(uploaded_sku) <= 100),
  uploaded_customer_sku   text check (uploaded_customer_sku is null or length(uploaded_customer_sku) <= 100),
  uploaded_barcode        text check (uploaded_barcode is null or length(uploaded_barcode) <= 64),
  uploaded_description    text check (uploaded_description is null or length(uploaded_description) <= 500),
  uploaded_quantity       numeric(14,3) not null check (uploaded_quantity > 0),
  uploaded_unit           text check (uploaded_unit is null or uploaded_unit ~ '^[A-Z]{1,10}$'),
  product_id              uuid,
  quantity_ordered        numeric(14,3) not null check (quantity_ordered > 0),
  unit                    text check (unit is null or unit ~ '^[A-Z]{1,10}$'),
  unit_price              numeric(14,4) check (unit_price is null or unit_price >= 0),
  currency                text check (currency is null or currency ~ '^[A-Z]{3}$'),
  tax_rate                numeric(5,2) check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100)),
  hsn_code                text check (hsn_code is null or hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  remarks                 text check (remarks is null or length(remarks) <= 500),
  line_status             text not null check (line_status in ('MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW', 'EXCLUDED')),
  status_reason           text,
  matching_method         text check (matching_method is null or matching_method in ('SKU', 'CUSTOMER_SKU', 'BARCODE', 'NORMALIZED_CODE', 'MANUAL')),
  match_note              text,
  candidate_product_ids   uuid[] not null default '{}',
  matched_by              uuid,
  matched_at              timestamptz,
  flagged_for_new_product boolean not null default false,
  duplicate_of_line_id    uuid,
  duplicate_confirmed     boolean not null default false,
  quantity_dispatched     numeric(14,3) not null default 0 check (quantity_dispatched >= 0),
  shortage_status         text not null default 'OPEN' check (shortage_status in ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  shortage_priority       text not null default 'NORMAL' check (shortage_priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  shortage_owner          uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint customer_po_lines_unique unique (purchase_order_id, line_no),
  constraint customer_po_lines_id_company_unique unique (id, company_id),
  constraint customer_po_lines_po_fk foreign key (purchase_order_id, company_id) references public.customer_purchase_orders (id, company_id) on delete restrict,
  constraint customer_po_lines_product_fk foreign key (product_id, company_id) references public.products (id, company_id) on delete restrict,
  constraint customer_po_lines_matched_has_product check (line_status <> 'MATCHED' or product_id is not null)
);

create index if not exists customer_po_lines_po_idx on public.customer_purchase_order_lines (purchase_order_id);
create index if not exists customer_po_lines_product_idx on public.customer_purchase_order_lines (company_id, product_id);

comment on column public.customer_purchase_order_lines.uploaded_quantity is 'Quantity exactly as uploaded; quantity_ordered may only differ after an authorised, logged correction.';

create table if not exists public.customer_po_events (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  line_id           uuid,
  event_type        text not null,
  from_status       text,
  to_status         text,
  note              text,
  details           jsonb not null default '{}'::jsonb,
  actor_user_id     uuid,
  created_at        timestamptz not null default now(),
  constraint customer_po_events_po_fk foreign key (purchase_order_id, company_id) references public.customer_purchase_orders (id, company_id) on delete restrict
);
create index if not exists customer_po_events_po_idx on public.customer_po_events (purchase_order_id, created_at);

create table if not exists public.customer_po_allocation_runs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  run_type          text not null check (run_type in ('DRAFT', 'COMMITTED')),
  strategy          text not null check (strategy in ('IN_HOUSE_FIRST', 'OUTSOURCED_FIRST', 'EARLIEST_BATCH', 'WAREHOUSE_PRIORITY', 'MANUAL')),
  plan              jsonb not null default '[]'::jsonb,
  result            jsonb not null default '{}'::jsonb,
  note              text check (note is null or length(note) <= 1000),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  constraint customer_po_runs_po_fk foreign key (purchase_order_id, company_id) references public.customer_purchase_orders (id, company_id) on delete restrict
);

create table if not exists public.customer_po_analysis_snapshots (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  taken_at          timestamptz not null default now(),
  taken_by          uuid,
  summary           jsonb not null,
  lines             jsonb not null,
  constraint customer_po_snapshots_po_fk foreign key (purchase_order_id, company_id) references public.customer_purchase_orders (id, company_id) on delete restrict
);
create index if not exists customer_po_snapshots_po_idx on public.customer_po_analysis_snapshots (purchase_order_id, taken_at desc);

create table if not exists public.customer_po_shortage_notes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  line_id    uuid not null,
  note       text not null check (length(btrim(note)) between 1 and 1000),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint customer_po_shortage_notes_line_fk foreign key (line_id, company_id) references public.customer_purchase_order_lines (id, company_id) on delete restrict
);

-- History tables are append-only.
drop trigger if exists customer_po_events_append_only on public.customer_po_events;
create trigger customer_po_events_append_only before update or delete on public.customer_po_events
  for each row execute function private.prevent_history_mutation();
drop trigger if exists customer_po_runs_append_only on public.customer_po_allocation_runs;
create trigger customer_po_runs_append_only before update or delete on public.customer_po_allocation_runs
  for each row execute function private.prevent_history_mutation();
drop trigger if exists customer_po_snapshots_append_only on public.customer_po_analysis_snapshots;
create trigger customer_po_snapshots_append_only before update or delete on public.customer_po_analysis_snapshots
  for each row execute function private.prevent_history_mutation();
drop trigger if exists customer_po_notes_append_only on public.customer_po_shortage_notes;
create trigger customer_po_notes_append_only before update or delete on public.customer_po_shortage_notes
  for each row execute function private.prevent_history_mutation();
drop trigger if exists customer_po_batches_append_only on public.customer_po_import_batches;
create trigger customer_po_batches_append_only before update or delete on public.customer_po_import_batches
  for each row execute function private.prevent_history_mutation();
drop trigger if exists customer_pos_set_updated_at on public.customer_purchase_orders;
create trigger customer_pos_set_updated_at before update on public.customer_purchase_orders
  for each row execute function private.set_updated_at();
drop trigger if exists customer_po_lines_set_updated_at on public.customer_purchase_order_lines;
create trigger customer_po_lines_set_updated_at before update on public.customer_purchase_order_lines
  for each row execute function private.set_updated_at();

-- RLS: read only for clients; all changes through RPCs.
do $$
declare
  t text;
begin
  foreach t in array array['customer_po_import_batches', 'customer_purchase_orders', 'customer_purchase_order_lines', 'customer_po_events',
                           'customer_po_allocation_runs', 'customer_po_analysis_snapshots', 'customer_po_shortage_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))',
      t || '_select', t, 'customer_po.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function private.po_customer_key(p_customer_id uuid, p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_customer_id is not null then 'C:' || p_customer_id::text
              else 'N:' || upper(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))) end;
$$;

create or replace function private.po_norm_code(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

create or replace function private.log_po_event(
  p_company uuid, p_po uuid, p_line uuid, p_event text, p_from text, p_to text, p_note text, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_po_events (company_id, purchase_order_id, line_id, event_type, from_status, to_status, note, details, actor_user_id)
  values (p_company, p_po, p_line, p_event, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_company, 'customer_po.' || lower(p_event), 'customer_purchase_order', p_po::text,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('line_id', p_line, 'from_status', p_from, 'to_status', p_to, 'note', p_note));
end;
$$;

create or replace function private.po_line_open_reserved(p_line uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity - fulfilled_quantity - released_quantity), 0)
  from public.stock_reservations
  where reference_type = 'CUSTOMER_PO' and reference_id = p_line and reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED');
$$;

revoke all on function private.po_customer_key(uuid, text) from public, anon, authenticated;
revoke all on function private.po_norm_code(text) from public, anon, authenticated;
revoke all on function private.log_po_event(uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.po_line_open_reserved(uuid) from public, anon;
grant execute on function private.po_line_open_reserved(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Product matching (rules in order; never by description similarity)
--   1 exact internal SKU  2 verified customer code  3 exact barcode
--   4 normalised code (ignoring spaces / punctuation), only when unambiguous
-- -----------------------------------------------------------------------------
create or replace function private.po_match_codes(p_company uuid, p_customer uuid, p_sku text, p_customer_sku text, p_barcode text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_ids  uuid[];
  v_code text;
  v_sku  text := nullif(btrim(coalesce(p_sku, '')), '');
  v_csku text := nullif(btrim(coalesce(p_customer_sku, '')), '');
  v_bar  text := nullif(btrim(coalesce(p_barcode, '')), '');
begin
  if v_sku is not null then
    select id into v_id from public.products where company_id = p_company and archived_at is null and lower(sku) = lower(v_sku);
    if v_id is not null then
      return jsonb_build_object('status', 'MATCHED', 'method', 'SKU', 'product_id', v_id, 'note', 'Exact internal SKU');
    end if;
  end if;
  if p_customer is not null and v_csku is not null then
    select m.product_id into v_id from public.customer_product_codes m
    join public.products p on p.id = m.product_id and p.archived_at is null
    where m.company_id = p_company and m.customer_id = p_customer and upper(m.customer_sku) = upper(v_csku);
    if v_id is not null then
      return jsonb_build_object('status', 'MATCHED', 'method', 'CUSTOMER_SKU', 'product_id', v_id, 'note', 'Verified customer code mapping');
    end if;
  end if;
  if v_bar is not null then
    select array_agg(id) into v_ids from public.products where company_id = p_company and archived_at is null and barcode = v_bar;
    if coalesce(array_length(v_ids, 1), 0) = 1 then
      return jsonb_build_object('status', 'MATCHED', 'method', 'BARCODE', 'product_id', v_ids[1], 'note', 'Exact barcode');
    end if;
  end if;
  foreach v_code in array array[v_sku, v_csku] loop
    continue when private.po_norm_code(v_code) is null;
    select array_agg(id order by sku) into v_ids from public.products
    where company_id = p_company and archived_at is null and private.po_norm_code(sku) = private.po_norm_code(v_code);
    if coalesce(array_length(v_ids, 1), 0) = 1 then
      return jsonb_build_object('status', 'MATCHED', 'method', 'NORMALIZED_CODE', 'product_id', v_ids[1],
        'note', format('Code "%s" equals the SKU when spaces and punctuation are ignored', v_code));
    elsif coalesce(array_length(v_ids, 1), 0) > 1 then
      return jsonb_build_object('status', 'AMBIGUOUS', 'candidates', to_jsonb(v_ids),
        'note', format('Code "%s" matches %s products when spaces and punctuation are ignored; choose one', v_code, array_length(v_ids, 1)));
    end if;
  end loop;
  return jsonb_build_object('status', 'UNMATCHED', 'note',
    case when v_sku is null and v_csku is null and v_bar is null then 'No product code supplied; select the product manually.'
         else 'No product with this code. Select it manually, or flag it for Product Master creation.' end);
end;
$$;

revoke all on function private.po_match_codes(uuid, uuid, text, text, text) from public, anon, authenticated;

-- Applies a product to a line, validating status and unit (no unit conversion).
create or replace function private.po_apply_product(p_line_id uuid, p_product_id uuid, p_method text, p_note text, p_manual boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line    public.customer_purchase_order_lines;
  v_product public.products;
begin
  select * into v_line from public.customer_purchase_order_lines where id = p_line_id;
  select * into v_product from public.products where id = p_product_id and company_id = v_line.company_id;
  if not found or v_product.archived_at is not null then
    raise exception 'Product not found in your company.' using errcode = 'P0001';
  end if;
  update public.customer_purchase_order_lines
  set product_id = v_product.id,
      matching_method = p_method,
      match_note = p_note,
      candidate_product_ids = '{}',
      matched_by = case when p_manual then auth.uid() end,
      matched_at = now(),
      duplicate_of_line_id = null,
      unit = coalesce(v_line.unit, v_product.base_unit),
      line_status = case
        when v_product.status <> 'ACTIVE' then 'INVALID'
        when coalesce(v_line.unit, v_product.base_unit) <> v_product.base_unit then 'INVALID'
        else 'MATCHED' end,
      status_reason = case
        when v_product.status <> 'ACTIVE' then 'PRODUCT_INACTIVE'
        when coalesce(v_line.unit, v_product.base_unit) <> v_product.base_unit then 'UNIT_MISMATCH' end
  where id = v_line.id;
end;
$$;

revoke all on function private.po_apply_product(uuid, uuid, text, text, boolean) from public, anon, authenticated;

-- Runs automatic matching on a line (used at import and on re-match).
create or replace function private.po_auto_match_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.customer_purchase_order_lines;
  v_po   public.customer_purchase_orders;
  v_m    jsonb;
begin
  select * into v_line from public.customer_purchase_order_lines where id = p_line_id;
  select * into v_po from public.customer_purchase_orders where id = v_line.purchase_order_id;
  v_m := private.po_match_codes(v_line.company_id, v_po.customer_id, v_line.uploaded_sku, v_line.uploaded_customer_sku, v_line.uploaded_barcode);
  if v_m ->> 'status' = 'MATCHED' then
    perform private.po_apply_product(v_line.id, (v_m ->> 'product_id')::uuid, v_m ->> 'method', v_m ->> 'note', false);
  else
    update public.customer_purchase_order_lines
    set product_id = null, matching_method = null, matched_by = null, matched_at = null, duplicate_of_line_id = null,
        line_status = v_m ->> 'status', status_reason = case when v_m ->> 'status' = 'UNMATCHED' and uploaded_sku is null
          and uploaded_customer_sku is null and uploaded_barcode is null then 'NO_PRODUCT_CODE' end,
        match_note = v_m ->> 'note',
        candidate_product_ids = coalesce(array(select jsonb_array_elements_text(v_m -> 'candidates')::uuid), '{}')
    where id = v_line.id;
  end if;
end;
$$;

revoke all on function private.po_auto_match_line(uuid) from public, anon, authenticated;

-- Later lines for a product already on an earlier line need review (unless confirmed).
create or replace function private.po_flag_duplicates(p_po uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.customer_purchase_order_lines l
  set line_status = 'DUPLICATE_REVIEW', duplicate_of_line_id = f.first_id,
      match_note = coalesce(l.match_note || '. ', '') || 'Same product as line ' || f.first_no || ': confirm it is a separate demand or exclude it'
  from (
    select id, first_value(id) over w as first_id, first_value(line_no) over w as first_no, row_number() over w as rn
    from public.customer_purchase_order_lines
    where purchase_order_id = p_po and line_status = 'MATCHED'
    window w as (partition by product_id order by line_no)
  ) f
  where l.id = f.id and f.rn > 1 and not l.duplicate_confirmed;
$$;

revoke all on function private.po_flag_duplicates(uuid) from public, anon, authenticated;

-- Recalculates the PO workflow status from its lines, reservations and dispatches.
create or replace function private.po_recompute_status(p_po uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po  public.customer_purchase_orders;
  v_new text;
  v     record;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po for update;
  if v_po.status in ('CANCELLED', 'ON_HOLD', 'DRAFT') then
    return v_po.status;
  end if;
  select
    count(*) filter (where line_status <> 'EXCLUDED') as active,
    count(*) filter (where line_status = 'INVALID') as invalid,
    count(*) filter (where line_status in ('UNMATCHED', 'AMBIGUOUS', 'DUPLICATE_REVIEW')) as unmatched,
    count(*) filter (where line_status = 'MATCHED' and quantity_dispatched < quantity_ordered) as not_dispatched,
    count(*) filter (where line_status = 'MATCHED' and quantity_dispatched > 0) as any_dispatched,
    count(*) filter (where line_status = 'MATCHED' and quantity_dispatched + private.po_line_open_reserved(id) < quantity_ordered) as not_covered,
    count(*) filter (where line_status = 'MATCHED' and private.po_line_open_reserved(id) > 0) as any_reserved
  into v
  from public.customer_purchase_order_lines where purchase_order_id = p_po;

  v_new := case
    when v.active = 0 or v.invalid > 0 then 'VALIDATION_REQUIRED'
    when v.unmatched > 0 then 'PRODUCT_MATCHING_REQUIRED'
    when v.not_dispatched = 0 then 'FULFILLED'
    when v.any_dispatched > 0 then 'PARTIALLY_FULFILLED'
    when v.not_covered = 0 then 'FULLY_ALLOCATED'
    when v.any_reserved > 0 then 'PARTIALLY_ALLOCATED'
    else 'READY_FOR_ALLOCATION'
  end;
  if v_new is distinct from v_po.status then
    update public.customer_purchase_orders set status = v_new where id = p_po;
    perform private.log_po_event(v_po.company_id, p_po, null, 'STATUS_CHANGED', v_po.status, v_new, null, '{}'::jsonb);
  end if;
  return v_new;
end;
$$;

revoke all on function private.po_recompute_status(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Stock eligibility and availability
-- -----------------------------------------------------------------------------
create or replace function private.po_eligible_stock(p_company uuid, p_product uuid, p_warehouse uuid)
returns table (
  balance_id uuid, batch_id uuid, batch_number text, source_type text, warehouse_id uuid, warehouse_code text,
  location_id uuid, location_code text, stock_usage text, expiry_date date, lot_created_at timestamptz,
  on_hand numeric, reserved numeric, available numeric, eligible boolean, ineligible_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.batch_id, bt.batch_number, b.source_type, b.warehouse_id, w.warehouse_code, b.location_id, l.location_code, l.stock_usage,
    bt.expiry_date, bt.created_at, b.on_hand, b.reserved, b.on_hand - b.reserved, r.reason is null, r.reason
  from public.inventory_balances b
  join public.inventory_batches bt on bt.id = b.batch_id
  join public.inventory_locations l on l.id = b.location_id
  join public.warehouses w on w.id = b.warehouse_id
  cross join lateral (select case
      when l.stock_usage = 'REJECTED' then 'Rejected goods (non-saleable)'
      when l.stock_usage = 'EXTERNAL_PROCESSING' then 'Held by an outside processor'
      when l.status <> 'ACTIVE' or w.status <> 'ACTIVE' then 'Inactive location'
      when bt.status <> 'ACTIVE' then 'Lot closed'
      when bt.expiry_date is not null and bt.expiry_date < private.company_today(p_company) then 'Expired'
      when b.source_type = 'UNKNOWN' then 'Unverified source (review required)'
      when p_warehouse is not null and b.warehouse_id <> p_warehouse then 'Other warehouse'
    end as reason) r
  where b.company_id = p_company and b.product_id = p_product and b.on_hand > 0;
$$;

revoke all on function private.po_eligible_stock(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.po_line_analysis(p_company uuid, p_po uuid)
returns table (
  line_id uuid, purchase_order_id uuid, line_no int, source_row_number int, uploaded_sku text, uploaded_customer_sku text, uploaded_description text,
  product_id uuid, sku text, product_name text, category_name text, base_unit text, line_unit text, default_source_type text, reorder_level numeric,
  line_status text, status_reason text, quantity_ordered numeric, quantity_dispatched numeric, allocated_open numeric, remaining_need numeric,
  on_hand numeric, reserved numeric, available numeric,
  in_house_on_hand numeric, in_house_reserved numeric, in_house_available numeric,
  outsourced_on_hand numeric, outsourced_reserved numeric, outsourced_available numeric,
  unknown_on_hand numeric, ineligible_on_hand numeric, other_warehouse_available numeric,
  available_for_line numeric, shortage_before numeric, shortage_after numeric, availability_status text, review_warning text,
  shortage_status text, shortage_priority text, shortage_owner uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with po as (
    select * from public.customer_purchase_orders where id = p_po and company_id = p_company
  ),
  lines as (
    select l.*, private.po_line_open_reserved(l.id) as allocated_open
    from public.customer_purchase_order_lines l where l.purchase_order_id = p_po and l.company_id = p_company
  ),
  stock as (
    select l.id as line_id, s.*
    from lines l
    cross join lateral private.po_eligible_stock(p_company, l.product_id, (select fulfilment_warehouse_id from po)) s
    where l.product_id is not null
  ),
  agg as (
    select s.line_id,
      coalesce(sum(s.on_hand) filter (where s.eligible), 0) as on_hand,
      coalesce(sum(s.reserved) filter (where s.eligible), 0) as reserved,
      coalesce(sum(s.available) filter (where s.eligible), 0) as available,
      coalesce(sum(s.on_hand) filter (where s.eligible and s.source_type = 'IN_HOUSE'), 0) as ih_on,
      coalesce(sum(s.reserved) filter (where s.eligible and s.source_type = 'IN_HOUSE'), 0) as ih_res,
      coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'IN_HOUSE'), 0) as ih_av,
      coalesce(sum(s.on_hand) filter (where s.eligible and s.source_type = 'OUTSOURCED'), 0) as os_on,
      coalesce(sum(s.reserved) filter (where s.eligible and s.source_type = 'OUTSOURCED'), 0) as os_res,
      coalesce(sum(s.available) filter (where s.eligible and s.source_type = 'OUTSOURCED'), 0) as os_av,
      coalesce(sum(s.on_hand) filter (where s.source_type = 'UNKNOWN'), 0) as unknown_on,
      coalesce(sum(s.on_hand) filter (where not s.eligible), 0) as ineligible_on,
      coalesce(sum(s.available) filter (where s.ineligible_reason = 'Other warehouse'), 0) as other_wh
    from stock s group by s.line_id
  ),
  base as (
    select l.*, p.sku, p.product_name, c.name as category_name, p.base_unit, p.default_source_type, p.reorder_level,
      coalesce(a.on_hand, 0) as a_on_hand, coalesce(a.reserved, 0) as a_reserved, coalesce(a.available, 0) as a_available,
      coalesce(a.ih_on, 0) as ih_on, coalesce(a.ih_res, 0) as ih_res, coalesce(a.ih_av, 0) as ih_av,
      coalesce(a.os_on, 0) as os_on, coalesce(a.os_res, 0) as os_res, coalesce(a.os_av, 0) as os_av,
      coalesce(a.unknown_on, 0) as unknown_on, coalesce(a.ineligible_on, 0) as ineligible_on, coalesce(a.other_wh, 0) as other_wh,
      greatest(l.quantity_ordered - l.quantity_dispatched - l.allocated_open, 0) as need
    from lines l
    left join public.products p on p.id = l.product_id
    left join public.product_categories c on c.id = p.category_id
    left join agg a on a.line_id = l.id
  ),
  cum as (
    select b.*,
      coalesce(sum(case when b.line_status = 'MATCHED' then b.need end)
        over (partition by b.product_id order by b.line_no rows between unbounded preceding and 1 preceding), 0) as prior_need
    from base b
  ),
  fin as (
    select c.*, case when c.line_status = 'MATCHED' then greatest(least(c.a_available - c.prior_need, c.need), 0) else 0 end as for_line
    from cum c
  )
  select f.id, f.purchase_order_id, f.line_no, f.source_row_number, f.uploaded_sku, f.uploaded_customer_sku, f.uploaded_description,
    f.product_id, f.sku, f.product_name, f.category_name, f.base_unit, f.unit, f.default_source_type, f.reorder_level,
    f.line_status, f.status_reason, f.quantity_ordered, f.quantity_dispatched, f.allocated_open, f.need,
    f.a_on_hand, f.a_reserved, f.a_available, f.ih_on, f.ih_res, f.ih_av, f.os_on, f.os_res, f.os_av,
    f.unknown_on, f.ineligible_on, f.other_wh, f.for_line,
    case when f.line_status = 'MATCHED' then greatest(f.quantity_ordered - f.quantity_dispatched - f.allocated_open - f.for_line, 0) end,
    case when f.line_status = 'MATCHED' then greatest(f.quantity_ordered - f.quantity_dispatched - f.allocated_open, 0) end,
    case
      when f.line_status = 'EXCLUDED' then 'EXCLUDED'
      when f.line_status in ('UNMATCHED', 'AMBIGUOUS') then 'PRODUCT_UNMATCHED'
      when f.line_status = 'INVALID' and f.status_reason = 'UNIT_MISMATCH' then 'UNIT_MISMATCH'
      when f.line_status <> 'MATCHED' then 'REVIEW_REQUIRED'
      when f.need = 0 then 'FULLY_AVAILABLE'
      when f.for_line >= f.need then 'FULLY_AVAILABLE'
      when f.for_line > 0 then 'PARTIALLY_AVAILABLE'
      else 'OUT_OF_STOCK'
    end,
    nullif(concat_ws(' ',
      case when f.unknown_on > 0 then format('%s %s of unverified-source stock is excluded until its source is confirmed.', f.unknown_on, f.base_unit) end,
      case when f.other_wh > 0 then format('%s %s is available in other warehouses (outside this PO''s fulfilment warehouse).', f.other_wh, f.base_unit) end,
      case when f.line_status = 'INVALID' and f.status_reason = 'PRODUCT_INACTIVE' then 'The matched product is inactive.' end), ''),
    f.shortage_status, f.shortage_priority, f.shortage_owner
  from fin f
  order by f.line_no;
$$;

revoke all on function private.po_line_analysis(uuid, uuid) from public, anon, authenticated;

-- Overall availability status of a PO.
create or replace function private.po_availability_summary(p_company uuid, p_po uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with a as (select * from private.po_line_analysis(p_company, p_po) where availability_status <> 'EXCLUDED')
  select jsonb_build_object(
    'availability_status', case
      when (select count(*) from a) = 0 then 'REVIEW_REQUIRED'
      when exists (select 1 from a where availability_status in ('PRODUCT_UNMATCHED', 'UNIT_MISMATCH', 'REVIEW_REQUIRED')) then 'REVIEW_REQUIRED'
      when not exists (select 1 from a where availability_status <> 'FULLY_AVAILABLE') then 'FULLY_AVAILABLE'
      when not exists (select 1 from a where availability_status <> 'OUT_OF_STOCK') then 'OUT_OF_STOCK'
      else 'PARTIALLY_AVAILABLE' end,
    'lines', (select count(*) from a),
    'review_warnings', (select count(*) from a where review_warning is not null),
    'units', coalesce((select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object('unit', coalesce(line_unit, base_unit), 'ordered', sum(quantity_ordered), 'dispatched', sum(quantity_dispatched),
          'allocated', sum(allocated_open), 'available_for_lines', sum(available_for_line), 'shortage_before', sum(coalesce(shortage_before, 0)),
          'shortage_after', sum(coalesce(shortage_after, 0))) as u
        from a where line_status = 'MATCHED' group by coalesce(line_unit, base_unit)) x), '[]'::jsonb));
$$;

revoke all on function private.po_availability_summary(uuid, uuid) from public, anon, authenticated;

-- Allocation plan (no locks taken here; the commit locks balances first).
create or replace function private.po_plan(p_company uuid, p_po uuid, p_strategy text, p_priority uuid[])
returns table (line_id uuid, balance_id uuid, quantity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_wh   uuid;
  v_line record;
  v_lot  record;
  v_need numeric;
  v_used jsonb := '{}'::jsonb;
  v_left numeric;
  v_take numeric;
begin
  if p_strategy not in ('IN_HOUSE_FIRST', 'OUTSOURCED_FIRST', 'EARLIEST_BATCH', 'WAREHOUSE_PRIORITY') then
    raise exception 'Unknown allocation strategy %.', p_strategy using errcode = 'P0001';
  end if;
  select fulfilment_warehouse_id into v_wh from public.customer_purchase_orders where id = p_po;
  for v_line in
    select l.id, l.product_id, greatest(l.quantity_ordered - l.quantity_dispatched - private.po_line_open_reserved(l.id), 0) as need
    from public.customer_purchase_order_lines l
    join public.products p on p.id = l.product_id
    where l.purchase_order_id = p_po and l.line_status = 'MATCHED' and l.unit = p.base_unit and p.status = 'ACTIVE'
    order by l.line_no
  loop
    v_need := v_line.need;
    continue when v_need <= 0;
    for v_lot in
      select s.* from private.po_eligible_stock(p_company, v_line.product_id, v_wh) s
      where s.eligible and s.available > 0
      order by
        case p_strategy when 'IN_HOUSE_FIRST' then (s.source_type <> 'IN_HOUSE')::int
                        when 'OUTSOURCED_FIRST' then (s.source_type <> 'OUTSOURCED')::int else 0 end,
        case when p_strategy = 'WAREHOUSE_PRIORITY' then coalesce(array_position(p_priority, s.warehouse_id), 2147483647) else 0 end,
        s.expiry_date nulls last, s.lot_created_at, s.location_code, s.balance_id
    loop
      v_left := v_lot.available - coalesce((v_used ->> v_lot.balance_id::text)::numeric, 0);
      continue when v_left <= 0;
      v_take := least(v_need, v_left);
      v_used := jsonb_set(v_used, array[v_lot.balance_id::text], to_jsonb(coalesce((v_used ->> v_lot.balance_id::text)::numeric, 0) + v_take));
      line_id := v_line.id;
      balance_id := v_lot.balance_id;
      quantity := v_take;
      return next;
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;
  end loop;
end;
$$;

revoke all on function private.po_plan(uuid, uuid, text, uuid[]) from public, anon, authenticated;

-- Validates import / preview lines. Returns a jsonb array of {row, message}.
create or replace function private.po_validate_lines(p_lines jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line   jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_row    text;
  v_num    numeric;
  e        text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_array(jsonb_build_object('row', null, 'message', 'The PO has no valid lines.'));
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    return jsonb_build_array(jsonb_build_object('row', null, 'message', 'A PO can have at most 5,000 lines.'));
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_row := v_line ->> 'source_row_number';
    e := null;
    begin
      if v_row is null or v_row !~ '^\d+$' then e := 'Row number missing.'; end if;
      v_num := (v_line ->> 'quantity')::numeric;
      if e is null and (v_num is null or v_num <= 0 or v_num <> round(v_num, 3)) then e := 'Quantity must be greater than zero (up to 3 decimals).'; end if;
      if e is null and coalesce(v_line ->> 'unit', '') <> '' and upper(v_line ->> 'unit') !~ '^[A-Z]{1,10}$' then e := 'Unit must be 1–10 letters.'; end if;
      if e is null and coalesce(v_line ->> 'unit_price', '') <> '' then
        v_num := (v_line ->> 'unit_price')::numeric;
        if v_num < 0 or v_num <> round(v_num, 4) then e := 'Unit price must be zero or more (up to 4 decimals).'; end if;
      end if;
      if e is null and coalesce(v_line ->> 'tax_rate', '') <> '' then
        v_num := (v_line ->> 'tax_rate')::numeric;
        if v_num < 0 or v_num > 100 then e := 'Tax rate must be between 0 and 100.'; end if;
      end if;
      if e is null and coalesce(v_line ->> 'currency', '') <> '' and upper(v_line ->> 'currency') !~ '^[A-Z]{3}$' then e := 'Currency must be a 3-letter code (e.g. INR).'; end if;
      if e is null and coalesce(v_line ->> 'hsn_code', '') <> '' and v_line ->> 'hsn_code' !~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' then e := 'HSN code must have 4, 6 or 8 digits.'; end if;
      if e is null and coalesce(btrim(v_line ->> 'sku'), '') = '' and coalesce(btrim(v_line ->> 'customer_sku'), '') = ''
         and coalesce(btrim(v_line ->> 'barcode'), '') = '' and coalesce(btrim(v_line ->> 'description'), '') = '' then
        e := 'The row has no product code or description.';
      end if;
      if e is null and (length(coalesce(v_line ->> 'sku', '')) > 100 or length(coalesce(v_line ->> 'customer_sku', '')) > 100
         or length(coalesce(v_line ->> 'barcode', '')) > 64 or length(coalesce(v_line ->> 'description', '')) > 500
         or length(coalesce(v_line ->> 'remarks', '')) > 500) then
        e := 'A text value is too long.';
      end if;
    exception when others then
      e := 'A numeric value is not a valid number.';
    end;
    if e is not null then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'message', e);
    end if;
  end loop;
  return v_errors;
end;
$$;

revoke all on function private.po_validate_lines(jsonb) from public, anon, authenticated;

-- Existing current PO with the same customer identity (record or name) and PO number.
create or replace function private.po_find_existing(p_company uuid, p_customer_id uuid, p_name text, p_po_number text)
returns public.customer_purchase_orders
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.customer_purchase_orders
  where company_id = p_company and is_current and lower(customer_po_number) = lower(btrim(p_po_number))
    and (customer_key = private.po_customer_key(p_customer_id, p_name)
         or upper(btrim(regexp_replace(customer_name_snapshot, '\s+', ' ', 'g'))) = upper(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))))
  order by created_at desc
  limit 1;
$$;

revoke all on function private.po_find_existing(uuid, uuid, text, text) from public, anon, authenticated;

-- Resolves the customer for a header: an active customer record or a name reference.
create or replace function private.po_resolve_customer(p_company uuid, p_header jsonb)
returns table (customer_id uuid, customer_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cust public.customers;
begin
  if nullif(p_header ->> 'customer_id', '') is not null then
    select * into v_cust from public.customers where id = (p_header ->> 'customer_id')::uuid and company_id = p_company;
    if not found then
      raise exception 'Customer not found in your company.' using errcode = 'P0001';
    end if;
    if v_cust.status <> 'ACTIVE' then
      raise exception 'Customer % is inactive.', v_cust.customer_code using errcode = 'P0001';
    end if;
    customer_id := v_cust.id;
    customer_name := v_cust.customer_name;
  else
    customer_name := btrim(regexp_replace(coalesce(p_header ->> 'customer_name', ''), '\s+', ' ', 'g'));
    if customer_name = '' or length(customer_name) > 200 then
      raise exception 'Select a customer or enter the customer name (1–200 characters).' using errcode = 'P0001';
    end if;
    customer_id := null;
  end if;
  return next;
end;
$$;

revoke all on function private.po_resolve_customer(uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Preview (read only): matching + availability for lines before import
-- p_lines: [{source_row_number, sku, customer_sku, barcode, description, quantity, unit}]
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_preview(p_header jsonb, p_lines jsonb, p_file_hash text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('customer_po.import');
  v_cust     record;
  v_existing public.customer_purchase_orders;
  v_file     public.customer_purchase_orders;
  v_line     jsonb;
  v_m        jsonb;
  v_product  public.products;
  v_out      jsonb := '[]'::jsonb;
  v_left     jsonb := '{}'::jsonb;
  v_seen     jsonb := '{}'::jsonb;
  v_ih       numeric;
  v_os       numeric;
  v_unk      numeric;
  v_av       numeric;
  v_qty      numeric;
  v_avail    numeric;
  v_for      numeric;
  v_status   text;
  v_reason   text;
  v_wh       uuid := nullif(p_header ->> 'fulfilment_warehouse_id', '')::uuid;
begin
  select * into v_cust from private.po_resolve_customer(v_company, p_header);
  if nullif(btrim(coalesce(p_header ->> 'customer_po_number', '')), '') is not null then
    v_existing := private.po_find_existing(v_company, v_cust.customer_id, v_cust.customer_name, p_header ->> 'customer_po_number');
  end if;
  if p_file_hash is not null then
    select * into v_file from public.customer_purchase_orders where company_id = v_company and file_hash = p_file_hash order by created_at desc limit 1;
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_m := private.po_match_codes(v_company, v_cust.customer_id, v_line ->> 'sku', v_line ->> 'customer_sku', v_line ->> 'barcode');
    v_status := v_m ->> 'status';
    v_reason := null;
    v_for := null;
    v_product := null;
    v_ih := null; v_os := null; v_unk := null;
    begin
      v_qty := (v_line ->> 'quantity')::numeric;
    exception when others then
      v_qty := null;
    end;
    if v_status = 'MATCHED' then
      select * into v_product from public.products where id = (v_m ->> 'product_id')::uuid;
      if v_product.status <> 'ACTIVE' then
        v_status := 'INVALID'; v_reason := 'PRODUCT_INACTIVE';
      elsif coalesce(nullif(upper(v_line ->> 'unit'), ''), v_product.base_unit) <> v_product.base_unit then
        v_status := 'INVALID'; v_reason := 'UNIT_MISMATCH';
      elsif v_seen ? v_product.id::text then
        v_status := 'DUPLICATE_REVIEW';
      end if;
      if v_status in ('MATCHED', 'DUPLICATE_REVIEW') and not (v_seen ? v_product.id::text) then
        v_seen := v_seen || jsonb_build_object(v_product.id::text, v_line ->> 'source_row_number');
      end if;
      select coalesce(sum(available) filter (where eligible), 0),
             coalesce(sum(available) filter (where eligible and source_type = 'IN_HOUSE'), 0),
             coalesce(sum(available) filter (where eligible and source_type = 'OUTSOURCED'), 0),
             coalesce(sum(on_hand) filter (where source_type = 'UNKNOWN'), 0)
        into v_av, v_ih, v_os, v_unk from private.po_eligible_stock(v_company, v_product.id, v_wh);
      if not (v_left ? v_product.id::text) then
        v_left := v_left || jsonb_build_object(v_product.id::text, v_av);
      end if;
      v_avail := (v_left ->> v_product.id::text)::numeric;
      if v_status = 'MATCHED' and v_qty is not null then
        v_for := greatest(least(v_avail, v_qty), 0);
        v_left := v_left || jsonb_build_object(v_product.id::text, v_avail - v_for);
      end if;
    end if;
    v_out := v_out || jsonb_build_object(
      'source_row_number', v_line -> 'source_row_number',
      'status', v_status,
      'reason', v_reason,
      'method', v_m ->> 'method',
      'note', v_m ->> 'note',
      'product_id', v_product.id,
      'sku', v_product.sku,
      'product_name', v_product.product_name,
      'base_unit', v_product.base_unit,
      'duplicate_of_row', case when v_status = 'DUPLICATE_REVIEW' then v_seen ->> v_product.id::text end,
      'candidates', coalesce((select jsonb_agg(jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name))
                              from public.products p where p.id in (select jsonb_array_elements_text(v_m -> 'candidates')::uuid)), '[]'::jsonb),
      'in_house_available', v_ih,
      'outsourced_available', v_os,
      'unknown_on_hand', v_unk,
      'available_for_line', v_for,
      'availability_status', case
        when v_status in ('UNMATCHED', 'AMBIGUOUS') then 'PRODUCT_UNMATCHED'
        when v_reason = 'UNIT_MISMATCH' then 'UNIT_MISMATCH'
        when v_status <> 'MATCHED' then 'REVIEW_REQUIRED'
        when v_for >= v_qty then 'FULLY_AVAILABLE'
        when v_for > 0 then 'PARTIALLY_AVAILABLE'
        else 'OUT_OF_STOCK' end);
  end loop;

  return jsonb_build_object(
    'customer_id', v_cust.customer_id,
    'customer_name', v_cust.customer_name,
    'duplicate_po', case when v_existing.id is not null then jsonb_build_object('po_id', v_existing.id, 'po_reference', v_existing.po_reference,
      'revision', v_existing.revision, 'status', v_existing.status, 'customer_name', v_existing.customer_name_snapshot) end,
    'duplicate_file', case when v_file.id is not null then jsonb_build_object('po_id', v_file.id, 'po_reference', v_file.po_reference,
      'customer_po_number', v_file.customer_po_number, 'revision', v_file.revision) end,
    'lines', v_out);
end;
$$;

-- -----------------------------------------------------------------------------
-- Import (creates the PO only after explicit confirmation)
-- p_header: {customer_id?, customer_name?, customer_po_number, po_date, required_delivery_date?, currency?, notes?, fulfilment_warehouse_id?}
-- p_file:   {name, hash?, size?, sheet?, rows_read, rejected_rows: [{row, message}]}
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_import(
  p_header          jsonb,
  p_lines           jsonb,
  p_file            jsonb,
  p_revision_of     uuid default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('customer_po.import');
  v_previous  jsonb;
  v_cust      record;
  v_existing  public.customer_purchase_orders;
  v_target    public.customer_purchase_orders;
  v_file_dup  public.customer_purchase_orders;
  v_errors    jsonb;
  v_po        public.customer_purchase_orders;
  v_batch     uuid;
  v_line      jsonb;
  v_no        int := 0;
  v_line_id   uuid;
  v_po_date   date;
  v_due       date;
  v_currency  text := nullif(upper(btrim(coalesce(p_header ->> 'currency', ''))), '');
  v_number    text := btrim(coalesce(p_header ->> 'customer_po_number', ''));
  v_wh        uuid;
  v_hash      text := nullif(p_file ->> 'hash', '');
  v_rejected  jsonb := coalesce(p_file -> 'rejected_rows', '[]'::jsonb);
  v_counts    record;
  v_result    jsonb;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_po_import');
  if v_previous is not null then return v_previous; end if;

  -- Header
  select * into v_cust from private.po_resolve_customer(v_company, p_header);
  if v_number = '' or length(v_number) > 100 then
    raise exception 'Enter the customer PO number (1–100 characters).' using errcode = 'P0001';
  end if;
  begin
    v_po_date := (p_header ->> 'po_date')::date;
    v_due := nullif(p_header ->> 'required_delivery_date', '')::date;
  exception when others then
    raise exception 'PO date and delivery date must be valid dates (YYYY-MM-DD).' using errcode = 'P0001';
  end;
  if v_po_date is null then
    raise exception 'Enter the PO date.' using errcode = 'P0001';
  end if;
  if v_po_date > private.company_today(v_company) + 1 then
    raise exception 'The PO date cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_due is not null and v_due < v_po_date then
    raise exception 'The required delivery date cannot be before the PO date.' using errcode = 'P0001';
  end if;
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a 3-letter code (e.g. INR).' using errcode = 'P0001';
  end if;
  if nullif(p_header ->> 'fulfilment_warehouse_id', '') is not null then
    select id into v_wh from public.warehouses where id = (p_header ->> 'fulfilment_warehouse_id')::uuid and company_id = v_company and status = 'ACTIVE';
    if v_wh is null then
      raise exception 'Fulfilment warehouse not found or inactive.' using errcode = 'P0001';
    end if;
  end if;
  if coalesce(p_file ->> 'name', '') = '' then
    raise exception 'The source file name is required.' using errcode = 'P0001';
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid file fingerprint.' using errcode = 'P0001';
  end if;

  -- Duplicate protection
  if v_hash is not null then
    select * into v_file_dup from public.customer_purchase_orders where company_id = v_company and file_hash = v_hash order by created_at desc limit 1;
    if v_file_dup.id is not null then
      return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('ok', false, 'reason', 'DUPLICATE_FILE',
        'existing', jsonb_build_object('po_id', v_file_dup.id, 'po_reference', v_file_dup.po_reference, 'customer_po_number', v_file_dup.customer_po_number,
          'revision', v_file_dup.revision, 'status', v_file_dup.status)));
    end if;
  end if;
  v_existing := private.po_find_existing(v_company, v_cust.customer_id, v_cust.customer_name, v_number);
  if p_revision_of is null then
    if v_existing.id is not null then
      return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('ok', false, 'reason', 'DUPLICATE_PO',
        'existing', jsonb_build_object('po_id', v_existing.id, 'po_reference', v_existing.po_reference, 'revision', v_existing.revision,
          'status', v_existing.status, 'customer_name', v_existing.customer_name_snapshot)));
    end if;
  else
    perform private.require_permission('customer_po.revise');
    select * into v_target from public.customer_purchase_orders where id = p_revision_of and company_id = v_company for update;
    if not found then
      raise exception 'The PO being revised was not found in your company.' using errcode = 'P0001';
    end if;
    if not v_target.is_current then
      raise exception 'Only the current revision of a PO can be revised (PO % revision % is superseded).', v_target.customer_po_number, v_target.revision
        using errcode = 'P0001';
    end if;
    if v_existing.id is distinct from v_target.id then
      raise exception 'A revision must have the same customer and PO number as the PO it revises (%).', v_target.customer_po_number using errcode = 'P0001';
    end if;
  end if;

  -- Lines
  v_errors := private.po_validate_lines(p_lines);
  if jsonb_array_length(v_errors) > 0 then
    insert into public.customer_po_import_batches (company_id, file_name, file_hash, file_size, sheet_name, rows_read, valid_rows, invalid_rows,
      validation_status, import_status, error_summary, uploaded_by)
    values (v_company, left(p_file ->> 'name', 255), v_hash, nullif(p_file ->> 'size', '')::bigint, left(p_file ->> 'sheet', 100),
      coalesce((p_file ->> 'rows_read')::int, 0), 0, jsonb_array_length(v_errors) + jsonb_array_length(v_rejected), 'INVALID', 'REJECTED',
      v_errors || v_rejected, auth.uid());
    return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('ok', false, 'reason', 'INVALID', 'errors', v_errors));
  end if;

  insert into public.customer_po_import_batches (company_id, file_name, file_hash, file_size, sheet_name, rows_read, valid_rows, invalid_rows,
    validation_status, import_status, error_summary, uploaded_by)
  values (v_company, left(p_file ->> 'name', 255), v_hash, nullif(p_file ->> 'size', '')::bigint, left(p_file ->> 'sheet', 100),
    coalesce((p_file ->> 'rows_read')::int, jsonb_array_length(p_lines)), jsonb_array_length(p_lines), jsonb_array_length(v_rejected),
    case when jsonb_array_length(v_rejected) > 0 then 'VALID_WITH_REJECTED_ROWS' else 'VALID' end, 'IMPORTED', v_rejected, auth.uid())
  returning id into v_batch;

  if v_target.id is not null then
    update public.customer_purchase_orders set is_current = false where id = v_target.id;
  end if;
  insert into public.customer_purchase_orders (company_id, po_reference, customer_id, customer_name_snapshot, customer_key, customer_po_number,
    revision, previous_revision_id, po_date, required_delivery_date, currency, fulfilment_warehouse_id, status, source_filename, file_hash,
    import_batch_id, notes, uploaded_by)
  values (v_company, private.next_document_number(v_company, 'CPO'), v_cust.customer_id, v_cust.customer_name,
    coalesce(v_target.customer_key, private.po_customer_key(v_cust.customer_id, v_cust.customer_name)), v_number,
    coalesce(v_target.revision + 1, 1), v_target.id, v_po_date, v_due, v_currency, v_wh, 'UPLOADED', left(p_file ->> 'name', 255), v_hash,
    v_batch, nullif(btrim(coalesce(p_header ->> 'notes', '')), ''), auth.uid())
  returning * into v_po;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    insert into public.customer_purchase_order_lines (company_id, purchase_order_id, line_no, source_row_number, uploaded_sku, uploaded_customer_sku,
      uploaded_barcode, uploaded_description, uploaded_quantity, uploaded_unit, quantity_ordered, unit, unit_price, currency, tax_rate, hsn_code, remarks,
      line_status)
    values (v_company, v_po.id, v_no, (v_line ->> 'source_row_number')::int,
      nullif(btrim(coalesce(v_line ->> 'sku', '')), ''), nullif(btrim(coalesce(v_line ->> 'customer_sku', '')), ''),
      nullif(btrim(coalesce(v_line ->> 'barcode', '')), ''), nullif(btrim(coalesce(v_line ->> 'description', '')), ''),
      (v_line ->> 'quantity')::numeric, nullif(upper(btrim(coalesce(v_line ->> 'unit', ''))), ''), (v_line ->> 'quantity')::numeric,
      nullif(upper(btrim(coalesce(v_line ->> 'unit', ''))), ''), nullif(v_line ->> 'unit_price', '')::numeric,
      coalesce(nullif(upper(btrim(coalesce(v_line ->> 'currency', ''))), ''), v_currency), nullif(v_line ->> 'tax_rate', '')::numeric,
      nullif(btrim(coalesce(v_line ->> 'hsn_code', '')), ''), nullif(btrim(coalesce(v_line ->> 'remarks', '')), ''), 'UNMATCHED')
    returning id into v_line_id;
    perform private.po_auto_match_line(v_line_id);
  end loop;
  perform private.po_flag_duplicates(v_po.id);

  select count(*) filter (where line_status = 'MATCHED') as matched,
         count(*) filter (where line_status = 'UNMATCHED') as unmatched,
         count(*) filter (where line_status = 'AMBIGUOUS') as ambiguous,
         count(*) filter (where line_status = 'INVALID') as invalid,
         count(*) filter (where line_status = 'DUPLICATE_REVIEW') as duplicate_review
    into v_counts from public.customer_purchase_order_lines where purchase_order_id = v_po.id;

  perform private.log_po_event(v_company, v_po.id, null, case when v_target.id is null then 'IMPORTED' else 'REVISION_IMPORTED' end, null, 'UPLOADED', null,
    jsonb_build_object('po_reference', v_po.po_reference, 'customer_po_number', v_number, 'revision', v_po.revision, 'file', p_file ->> 'name',
      'lines', v_no, 'rejected_rows', jsonb_array_length(v_rejected), 'previous_revision_id', v_target.id));
  if v_target.id is not null then
    perform private.log_po_event(v_company, v_target.id, null, 'SUPERSEDED', v_target.status, v_target.status, null,
      jsonb_build_object('new_revision_id', v_po.id, 'new_revision', v_po.revision));
  end if;

  v_result := jsonb_build_object('ok', true, 'po_id', v_po.id, 'po_reference', v_po.po_reference, 'revision', v_po.revision,
    'status', private.po_recompute_status(v_po.id), 'lines', v_no, 'matched', v_counts.matched, 'unmatched', v_counts.unmatched,
    'ambiguous', v_counts.ambiguous, 'invalid', v_counts.invalid, 'duplicate_review', v_counts.duplicate_review);
  return private.idempotency_finish(v_company, p_idempotency_key, v_result);
end;
$$;

-- -----------------------------------------------------------------------------
-- Line review: manual match, duplicates, exclusion, correction, flags
-- p_action: MATCH | CONFIRM_DUPLICATE | EXCLUDE | RESTORE | FLAG_NEW_PRODUCT | UNFLAG | CORRECT
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_line_action(
  p_line_id    uuid,
  p_action     text,
  p_product_id uuid default null,
  p_remember   boolean default false,
  p_note       text default null,
  p_quantity   numeric default null,
  p_unit       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.match');
  v_line    public.customer_purchase_order_lines;
  v_po      public.customer_purchase_orders;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_code    text;
  v_unit    text := nullif(upper(btrim(coalesce(p_unit, ''))), '');
  v_product public.products;
begin
  select * into v_line from public.customer_purchase_order_lines where id = p_line_id and company_id = v_company for update;
  if not found then
    raise exception 'PO line not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_po from public.customer_purchase_orders where id = v_line.purchase_order_id for update;
  if v_po.status in ('CANCELLED', 'FULFILLED') or not v_po.is_current then
    raise exception 'Lines of a % PO cannot be changed.', case when not v_po.is_current then 'superseded' else lower(v_po.status) end using errcode = 'P0001';
  end if;
  if p_action in ('MATCH', 'EXCLUDE', 'CORRECT', 'RESTORE')
     and (private.po_line_open_reserved(v_line.id) > 0 or v_line.quantity_dispatched > 0) then
    raise exception 'Stock is allocated or dispatched for this line. Release the allocation first.' using errcode = 'P0001';
  end if;

  case p_action
  when 'MATCH' then
    if p_product_id is null then
      raise exception 'Select the product.' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = p_product_id and company_id = v_company and archived_at is null;
    if not found then
      raise exception 'Product not found in your company.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines set duplicate_confirmed = false, line_status = 'UNMATCHED' where id = v_line.id;
    perform private.po_apply_product(v_line.id, v_product.id, 'MANUAL', coalesce(v_note, 'Selected manually'), true);
    if p_remember then
      v_code := coalesce(v_line.uploaded_customer_sku, v_line.uploaded_sku);
      if v_po.customer_id is null then
        raise exception 'Customer code mappings need a customer record on the PO.' using errcode = 'P0001';
      end if;
      if v_code is null then
        raise exception 'This line has no customer code to remember.' using errcode = 'P0001';
      end if;
      insert into public.customer_product_codes (company_id, customer_id, customer_sku, product_id, verified_by)
      values (v_company, v_po.customer_id, v_code, v_product.id, auth.uid())
      on conflict (company_id, customer_id, upper(customer_sku)) do update set product_id = excluded.product_id, verified_by = excluded.verified_by, created_at = now();
    end if;
    perform private.po_flag_duplicates(v_po.id);
  when 'CONFIRM_DUPLICATE' then
    if v_line.line_status <> 'DUPLICATE_REVIEW' then
      raise exception 'This line is not awaiting duplicate review.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines
    set line_status = 'MATCHED', duplicate_confirmed = true, match_note = coalesce(v_note, 'Confirmed as a separate demand for the same product')
    where id = v_line.id;
  when 'EXCLUDE' then
    if v_note is null then
      raise exception 'Enter the reason for excluding the line.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines set line_status = 'EXCLUDED', status_reason = 'EXCLUDED', match_note = v_note where id = v_line.id;
  when 'RESTORE' then
    if v_line.line_status <> 'EXCLUDED' then
      raise exception 'Only excluded lines can be restored.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines set duplicate_confirmed = false, status_reason = null where id = v_line.id;
    perform private.po_auto_match_line(v_line.id);
    perform private.po_flag_duplicates(v_po.id);
  when 'FLAG_NEW_PRODUCT', 'UNFLAG' then
    if v_line.line_status not in ('UNMATCHED', 'AMBIGUOUS') and p_action = 'FLAG_NEW_PRODUCT' then
      raise exception 'Only unmatched lines can be flagged for Product Master creation.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines set flagged_for_new_product = (p_action = 'FLAG_NEW_PRODUCT') where id = v_line.id;
  when 'CORRECT' then
    if v_note is null or length(v_note) < 5 then
      raise exception 'Document the reason for correcting the uploaded quantity or unit.' using errcode = 'P0001';
    end if;
    if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
      raise exception 'Quantity must be greater than zero (up to 3 decimals).' using errcode = 'P0001';
    end if;
    if v_unit is not null and v_unit !~ '^[A-Z]{1,10}$' then
      raise exception 'Unit must be 1–10 letters.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_order_lines set quantity_ordered = p_quantity, unit = coalesce(v_unit, unit) where id = v_line.id;
    if v_line.product_id is not null then
      update public.customer_purchase_order_lines set line_status = 'UNMATCHED' where id = v_line.id;
      perform private.po_apply_product(v_line.id, v_line.product_id, coalesce(v_line.matching_method, 'MANUAL'), v_line.match_note, v_line.matched_by is not null);
      perform private.po_flag_duplicates(v_po.id);
    end if;
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;

  perform private.log_po_event(v_company, v_po.id, v_line.id, 'LINE_' || p_action, v_line.line_status,
    (select line_status from public.customer_purchase_order_lines where id = v_line.id), v_note,
    jsonb_build_object('line_no', v_line.line_no, 'product_id', coalesce(p_product_id, v_line.product_id), 'old_quantity', v_line.quantity_ordered,
      'new_quantity', p_quantity, 'old_unit', v_line.unit, 'new_unit', v_unit, 'remember', p_remember));
  return jsonb_build_object('line_status', (select line_status from public.customer_purchase_order_lines where id = v_line.id),
    'po_status', private.po_recompute_status(v_po.id));
end;
$$;

create or replace function public.customer_po_rematch(p_po_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.match');
  v_po      public.customer_purchase_orders;
  v_line    record;
  v_changed int := 0;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if v_po.status in ('CANCELLED', 'FULFILLED') or not v_po.is_current then
    raise exception 'This PO cannot be re-matched.' using errcode = 'P0001';
  end if;
  for v_line in select id, line_status from public.customer_purchase_order_lines
                where purchase_order_id = v_po.id and line_status in ('UNMATCHED', 'AMBIGUOUS') loop
    perform private.po_auto_match_line(v_line.id);
    if (select line_status from public.customer_purchase_order_lines where id = v_line.id) <> v_line.line_status then
      v_changed := v_changed + 1;
    end if;
  end loop;
  perform private.po_flag_duplicates(v_po.id);
  perform private.log_po_event(v_company, v_po.id, null, 'REMATCHED', v_po.status, v_po.status, null, jsonb_build_object('lines_changed', v_changed));
  return jsonb_build_object('lines_changed', v_changed, 'po_status', private.po_recompute_status(v_po.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Analysis (read), line stock, proposals
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_analysis(p_po_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
begin
  if not exists (select 1 from public.customer_purchase_orders where id = p_po_id and company_id = v_company) then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  return private.po_availability_summary(v_company, p_po_id) || jsonb_build_object(
    'calculated_at', now(),
    'lines', coalesce((select jsonb_agg(to_jsonb(a) order by a.line_no) from private.po_line_analysis(v_company, p_po_id) a), '[]'::jsonb));
end;
$$;

create or replace function public.customer_po_line_stock(p_line_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
  v_line    public.customer_purchase_order_lines;
  v_wh      uuid;
begin
  select * into v_line from public.customer_purchase_order_lines where id = p_line_id and company_id = v_company;
  if not found then
    raise exception 'PO line not found in your company.' using errcode = 'P0001';
  end if;
  if v_line.product_id is null then
    return '[]'::jsonb;
  end if;
  select fulfilment_warehouse_id into v_wh from public.customer_purchase_orders where id = v_line.purchase_order_id;
  return coalesce((
    select jsonb_agg(to_jsonb(s) || jsonb_build_object('reserved_for_line',
        coalesce((select sum(r.quantity - r.fulfilled_quantity - r.released_quantity) from public.stock_reservations r
                  where r.reference_type = 'CUSTOMER_PO' and r.reference_id = v_line.id and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
                    and r.batch_id = s.batch_id and r.location_id = s.location_id), 0))
      order by s.eligible desc, s.warehouse_code, s.expiry_date nulls last, s.location_code)
    from private.po_eligible_stock(v_company, v_line.product_id, v_wh) s), '[]'::jsonb);
end;
$$;

create or replace function public.customer_po_propose(p_po_id uuid, p_strategy text, p_warehouse_priority uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
begin
  if not exists (select 1 from public.customer_purchase_orders where id = p_po_id and company_id = v_company) then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('line_id', p.line_id, 'balance_id', p.balance_id, 'quantity', p.quantity,
      'batch_id', b.batch_id, 'batch_number', bt.batch_number, 'source_type', b.source_type, 'warehouse_id', b.warehouse_id,
      'warehouse_code', w.warehouse_code, 'location_id', b.location_id, 'location_code', l.location_code, 'expiry_date', bt.expiry_date))
    from private.po_plan(v_company, p_po_id, p_strategy, p_warehouse_priority) p
    join public.inventory_balances b on b.id = p.balance_id
    join public.inventory_batches bt on bt.id = b.batch_id
    join public.warehouses w on w.id = b.warehouse_id
    join public.inventory_locations l on l.id = b.location_id), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Allocation: server-side revalidation, balance locks, existing reservations
-- p_manual: [{line_id, balance_id, quantity}] (Manual / adjusted plan); when
-- empty the strategy plans the allocation on the server.
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_allocate(
  p_po_id              uuid,
  p_strategy           text,
  p_warehouse_priority uuid[] default null,
  p_manual             jsonb default null,
  p_allow_partial      boolean default false,
  p_note               text default null,
  p_idempotency_key    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company   uuid := private.require_permission('customer_po.allocate');
  v_previous  jsonb;
  v_po        public.customer_purchase_orders;
  v_products  uuid[];
  v_plan      jsonb := '[]'::jsonb;
  v_entry     jsonb;
  v_line      record;
  v_lot       record;
  v_res       public.stock_reservations;
  v_created   jsonb := '[]'::jsonb;
  v_short     jsonb := '[]'::jsonb;
  v_manual    boolean := p_manual is not null and jsonb_typeof(p_manual) = 'array' and jsonb_array_length(p_manual) > 0;
  v_qty       numeric;
  v_status    text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_po_allocate');
  if v_previous is not null then return v_previous; end if;

  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if not v_po.is_current then
    raise exception 'This PO revision is superseded; allocate the current revision.' using errcode = 'P0001';
  end if;
  if v_po.status not in ('READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED', 'PARTIALLY_FULFILLED') then
    raise exception 'Stock cannot be allocated while the PO is % (all lines must be matched and valid).', replace(lower(v_po.status), '_', ' ')
      using errcode = 'P0001';
  end if;
  if exists (
    with recursive prev (id) as (
      select v_po.previous_revision_id
      union all
      select p.previous_revision_id from public.customer_purchase_orders p join prev on p.id = prev.id where p.previous_revision_id is not null
    )
    select 1 from public.customer_purchase_order_lines l join prev on l.purchase_order_id = prev.id
    where private.po_line_open_reserved(l.id) > 0
  ) then
    raise exception 'An earlier revision of this PO still holds reserved stock. Review and release it before allocating this revision.' using errcode = 'P0001';
  end if;
  if not v_manual and p_strategy not in ('IN_HOUSE_FIRST', 'OUTSOURCED_FIRST', 'EARLIEST_BATCH', 'WAREHOUSE_PRIORITY') then
    raise exception 'Choose an allocation strategy.' using errcode = 'P0001';
  end if;

  -- Lock every balance of the products involved in a fixed order (deadlock-free).
  select array_agg(distinct product_id) into v_products from public.customer_purchase_order_lines
  where purchase_order_id = v_po.id and line_status = 'MATCHED';
  perform 1 from public.inventory_balances where company_id = v_company and product_id = any(coalesce(v_products, '{}')) order by id for update;

  if v_manual then
    for v_entry in select value from jsonb_array_elements(p_manual) loop
      begin
        v_qty := (v_entry ->> 'quantity')::numeric;
      exception when others then
        raise exception 'Allocation quantities must be numbers.' using errcode = 'P0001';
      end;
      continue when v_qty is null or v_qty = 0;
      v_plan := v_plan || jsonb_build_object('line_id', v_entry ->> 'line_id', 'balance_id', v_entry ->> 'balance_id', 'quantity', v_qty);
    end loop;
  else
    select coalesce(jsonb_agg(jsonb_build_object('line_id', line_id, 'balance_id', balance_id, 'quantity', quantity)), '[]'::jsonb)
      into v_plan from private.po_plan(v_company, v_po.id, p_strategy, p_warehouse_priority);
  end if;

  -- Validate per line: product, unit, need; per lot: eligibility (re-read under lock).
  for v_line in
    select l.id, l.line_no, l.product_id, l.line_status, l.unit, p.sku, p.base_unit, p.status as product_status,
      greatest(l.quantity_ordered - l.quantity_dispatched - private.po_line_open_reserved(l.id), 0) as need,
      coalesce((select sum((e ->> 'quantity')::numeric) from jsonb_array_elements(v_plan) e where (e ->> 'line_id')::uuid = l.id), 0) as planned
    from public.customer_purchase_order_lines l
    left join public.products p on p.id = l.product_id
    where l.purchase_order_id = v_po.id and l.line_status <> 'EXCLUDED'
    order by l.line_no
  loop
    if v_line.planned > 0 and (v_line.line_status <> 'MATCHED' or v_line.unit <> v_line.base_unit or v_line.product_status <> 'ACTIVE') then
      raise exception 'Line % cannot be allocated (not matched to an active product in its unit).', v_line.line_no using errcode = 'P0001';
    end if;
    if v_line.planned < 0 or v_line.planned > v_line.need then
      raise exception 'Line % (%): allocation % exceeds the quantity still to cover (%).', v_line.line_no, v_line.sku, v_line.planned, v_line.need
        using errcode = 'P0001';
    end if;
    if v_line.line_status = 'MATCHED' and v_line.planned < v_line.need then
      v_short := v_short || jsonb_build_object('line_no', v_line.line_no, 'sku', v_line.sku, 'short', v_line.need - v_line.planned, 'unit', v_line.unit);
    end if;
  end loop;
  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_partial, false) then
    raise exception 'Not enough eligible stock to allocate the whole PO: %. Nothing was reserved.',
      (select string_agg(format('line %s %s short by %s %s', s ->> 'line_no', s ->> 'sku', s ->> 'short', s ->> 'unit'), '; ') from jsonb_array_elements(v_short) s)
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_plan) = 0 then
    raise exception 'There is no eligible stock to allocate.' using errcode = 'P0001';
  end if;

  for v_entry in select value from jsonb_array_elements(v_plan) loop
    select s.* into v_lot
    from public.customer_purchase_order_lines l
    cross join lateral private.po_eligible_stock(v_company, l.product_id, v_po.fulfilment_warehouse_id) s
    where l.id = (v_entry ->> 'line_id')::uuid and l.purchase_order_id = v_po.id and s.balance_id = (v_entry ->> 'balance_id')::uuid;
    if not found then
      raise exception 'A selected lot does not hold this line''s product in your company.' using errcode = 'P0001';
    end if;
    if not v_lot.eligible then
      raise exception 'Lot at % / % is not eligible: %.', v_lot.warehouse_code, v_lot.location_code, v_lot.ineligible_reason using errcode = 'P0001';
    end if;
    v_res := private.reserve_balance(v_company, v_lot.balance_id, (v_entry ->> 'quantity')::numeric, 'CUSTOMER_PO', v_po.customer_po_number,
      (v_entry ->> 'line_id')::uuid, 'Allocated to ' || v_po.po_reference || ' (' || v_po.customer_name_snapshot || ')');
    v_created := v_created || jsonb_build_object('reservation_number', v_res.reservation_number, 'line_id', v_entry ->> 'line_id',
      'quantity', v_res.quantity, 'source_type', v_lot.source_type, 'warehouse_code', v_lot.warehouse_code, 'location_code', v_lot.location_code,
      'batch_number', v_lot.batch_number);
  end loop;

  insert into public.customer_po_allocation_runs (company_id, purchase_order_id, run_type, strategy, plan, result, note, created_by)
  values (v_company, v_po.id, 'COMMITTED', case when v_manual then 'MANUAL' else p_strategy end, v_plan,
    jsonb_build_object('reservations', v_created, 'shortages', v_short), nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
  v_status := private.po_recompute_status(v_po.id);
  perform private.log_po_event(v_company, v_po.id, null, 'ALLOCATED', v_po.status, v_status, p_note,
    jsonb_build_object('strategy', case when v_manual then 'MANUAL' else p_strategy end, 'reservations', jsonb_array_length(v_created), 'shortages', v_short));

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'reservations', v_created, 'shortages', v_short, 'status', v_status));
end;
$$;

create or replace function public.customer_po_save_plan(p_po_id uuid, p_strategy text, p_plan jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.allocate');
  v_id      uuid;
begin
  if not exists (select 1 from public.customer_purchase_orders where id = p_po_id and company_id = v_company) then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if p_strategy not in ('IN_HOUSE_FIRST', 'OUTSOURCED_FIRST', 'EARLIEST_BATCH', 'WAREHOUSE_PRIORITY', 'MANUAL') then
    raise exception 'Unknown allocation strategy.' using errcode = 'P0001';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) > 10000 then
    raise exception 'The plan must be a list of allocations.' using errcode = 'P0001';
  end if;
  insert into public.customer_po_allocation_runs (company_id, purchase_order_id, run_type, strategy, plan, note, created_by)
  values (v_company, p_po_id, 'DRAFT', p_strategy, p_plan, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  perform private.log_po_event(v_company, p_po_id, null, 'PLAN_SAVED', null, null, p_note, jsonb_build_object('strategy', p_strategy, 'entries', jsonb_array_length(p_plan)));
  return jsonb_build_object('run_id', v_id);
end;
$$;

-- Releases open reservations of a PO, one line, or one reservation.
create or replace function public.customer_po_release(p_po_id uuid, p_line_id uuid default null, p_reservation_id uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('customer_po.release');
  v_po       public.customer_purchase_orders;
  v_res      public.stock_reservations;
  v_total    numeric := 0;
  v_count    int := 0;
  v_status   text;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  for v_res in
    select r.* from public.stock_reservations r
    join public.customer_purchase_order_lines l on l.id = r.reference_id and l.purchase_order_id = v_po.id
    where r.company_id = v_company and r.reference_type = 'CUSTOMER_PO' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      and (p_line_id is null or r.reference_id = p_line_id) and (p_reservation_id is null or r.id = p_reservation_id)
    order by r.location_id, r.batch_id
    for update of r
  loop
    v_total := v_total + private.release_reservation_remaining(v_res, 'RELEASED');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    raise exception 'There is no open allocation to release.' using errcode = 'P0001';
  end if;
  v_status := private.po_recompute_status(v_po.id);
  perform private.log_po_event(v_company, v_po.id, p_line_id, 'RESERVATIONS_RELEASED', v_po.status, v_status, p_note,
    jsonb_build_object('released_quantity', v_total, 'reservations', v_count, 'reservation_id', p_reservation_id));
  return jsonb_build_object('released_quantity', v_total, 'reservations', v_count, 'status', v_status);
end;
$$;

-- Dispatch: ISSUE that consumes the line's reservation (physical fulfilment).
-- p_items: [{reservation_id, quantity}]
create or replace function public.customer_po_dispatch(p_po_id uuid, p_items jsonb, p_reference text default null, p_notes text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('customer_po.fulfil');
  v_previous jsonb;
  v_po       public.customer_purchase_orders;
  v_item     jsonb;
  v_res      public.stock_reservations;
  v_qty      numeric;
  v_remain   numeric;
  v_tx       uuid;
  v_numbers  text[] := '{}';
  v_status   text;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_po_dispatch');
  if v_previous is not null then return v_previous; end if;
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if v_po.status not in ('PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED', 'PARTIALLY_FULFILLED') then
    raise exception 'Only allocated stock of an active PO can be dispatched (PO is %).', replace(lower(v_po.status), '_', ' ') using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select the allocated stock to dispatch.' using errcode = 'P0001';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select r.* into v_res from public.stock_reservations r
    join public.customer_purchase_order_lines l on l.id = r.reference_id and l.purchase_order_id = v_po.id
    where r.id = (v_item ->> 'reservation_id')::uuid and r.company_id = v_company and r.reference_type = 'CUSTOMER_PO'
    for update of r;
    if not found then
      raise exception 'A reservation does not belong to this PO.' using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_item ->> 'quantity')::numeric;
    exception when others then
      raise exception 'Dispatch quantities must be numbers.' using errcode = 'P0001';
    end;
    v_remain := v_res.quantity - v_res.fulfilled_quantity - v_res.released_quantity;
    if v_res.reservation_status not in ('ACTIVE', 'PARTIALLY_FULFILLED') or v_qty is null or v_qty <= 0 or v_qty > v_remain then
      raise exception 'Reservation %: dispatch between 0 and the remaining reserved quantity (%).', v_res.reservation_number, v_remain using errcode = 'P0001';
    end if;
    v_tx := private.post_movement(v_company, 'ISSUE', v_res.batch_id, v_res.location_id, v_qty, null,
      'CUSTOMER_PO', coalesce(nullif(btrim(coalesce(p_reference, '')), ''), v_po.customer_po_number), v_res.reference_id,
      'Dispatch for customer PO ' || v_po.customer_po_number || ' (' || v_po.po_reference || ')', p_notes, now(), 'CUSTOMER_PO', v_po.id,
      null, null, null, v_qty);
    update public.stock_reservations
    set fulfilled_quantity = fulfilled_quantity + v_qty,
        reservation_status = case when v_remain - v_qty = 0 then 'FULFILLED' else 'PARTIALLY_FULFILLED' end, updated_at = now()
    where id = v_res.id;
    update public.customer_purchase_order_lines set quantity_dispatched = quantity_dispatched + v_qty where id = v_res.reference_id;
    v_numbers := v_numbers || (select transaction_number from public.inventory_transactions where id = v_tx);
  end loop;
  v_status := private.po_recompute_status(v_po.id);
  perform private.log_po_event(v_company, v_po.id, null, 'DISPATCHED', v_po.status, v_status, p_notes, jsonb_build_object('transaction_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('transaction_numbers', to_jsonb(v_numbers), 'status', v_status));
end;
$$;

-- Authorised correction of a dispatch: stock returns to the same lot/location as
-- available stock (the original reservation stays fulfilled in history).
create or replace function public.customer_po_reverse_dispatch(p_transaction_id uuid, p_reason text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('inventory.approve_adjustment');
  v_previous jsonb;
  v_tx       public.inventory_transactions;
  v_po       public.customer_purchase_orders;
  v_numbers  text[];
  v_status   text;
begin
  perform private.require_permission('customer_po.fulfil');
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'customer_po_reverse_dispatch');
  if v_previous is not null then return v_previous; end if;
  select * into v_tx from public.inventory_transactions where id = p_transaction_id and company_id = v_company and document_type = 'CUSTOMER_PO'
    and transaction_type = 'ISSUE';
  if not found then
    raise exception 'Dispatch transaction not found in your company.' using errcode = 'P0001';
  end if;
  select * into v_po from public.customer_purchase_orders where id = v_tx.document_id for update;
  if v_po.status = 'CANCELLED' then
    raise exception 'Dispatches of a cancelled PO cannot be reversed here.' using errcode = 'P0001';
  end if;
  v_numbers := private.reverse_ledger_transaction(v_company, v_tx.id, p_reason);
  update public.customer_purchase_order_lines set quantity_dispatched = quantity_dispatched - v_tx.quantity where id = v_tx.reference_id;
  v_status := private.po_recompute_status(v_po.id);
  perform private.log_po_event(v_company, v_po.id, v_tx.reference_id, 'DISPATCH_REVERSED', v_po.status, v_status, p_reason,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'reversal_numbers', to_jsonb(v_numbers)));
  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object('reversal_numbers', to_jsonb(v_numbers), 'status', v_status));
end;
$$;

-- HOLD | RESUME | CANCEL
create or replace function public.customer_po_action(p_po_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
  v_po      public.customer_purchase_orders;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_res     public.stock_reservations;
  v_total   numeric := 0;
  v_to      text;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  case p_action
  when 'HOLD' then
    perform private.require_permission('customer_po.update');
    if v_po.status in ('ON_HOLD', 'CANCELLED', 'FULFILLED') then
      raise exception 'A % PO cannot be put on hold.', replace(lower(v_po.status), '_', ' ') using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for the hold.' using errcode = 'P0001';
    end if;
    v_to := 'ON_HOLD';
    update public.customer_purchase_orders set status = 'ON_HOLD', status_before_hold = v_po.status, hold_reason = v_note where id = v_po.id;
  when 'RESUME' then
    perform private.require_permission('customer_po.update');
    if v_po.status <> 'ON_HOLD' then
      raise exception 'Only POs on hold can be resumed.' using errcode = 'P0001';
    end if;
    update public.customer_purchase_orders set status = coalesce(status_before_hold, 'UPLOADED'), status_before_hold = null where id = v_po.id;
    v_to := private.po_recompute_status(v_po.id);
  when 'CANCEL' then
    perform private.require_permission('customer_po.cancel');
    if v_po.status in ('CANCELLED', 'FULFILLED') then
      raise exception 'A % PO cannot be cancelled.', lower(v_po.status) using errcode = 'P0001';
    end if;
    if v_note is null then
      raise exception 'Enter the reason for cancelling the PO.' using errcode = 'P0001';
    end if;
    for v_res in
      select r.* from public.stock_reservations r
      join public.customer_purchase_order_lines l on l.id = r.reference_id and l.purchase_order_id = v_po.id
      where r.reference_type = 'CUSTOMER_PO' and r.reservation_status in ('ACTIVE', 'PARTIALLY_FULFILLED')
      order by r.location_id, r.batch_id
      for update of r
    loop
      v_total := v_total + private.release_reservation_remaining(v_res, 'CANCELLED');
    end loop;
    v_to := 'CANCELLED';
    update public.customer_purchase_orders set status = 'CANCELLED', cancel_reason = v_note, cancelled_by = auth.uid(), cancelled_at = now() where id = v_po.id;
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end case;
  perform private.log_po_event(v_company, v_po.id, null, p_action, v_po.status, v_to, v_note, jsonb_build_object('released_quantity', v_total));
  return jsonb_build_object('status', v_to, 'released_quantity', v_total);
end;
$$;

create or replace function public.customer_po_update_header(p_po_id uuid, p_required_delivery_date date, p_fulfilment_warehouse_id uuid, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.update');
  v_po      public.customer_purchase_orders;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company for update;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if v_po.status in ('CANCELLED', 'FULFILLED') then
    raise exception 'A % PO cannot be edited.', lower(v_po.status) using errcode = 'P0001';
  end if;
  if p_required_delivery_date is not null and p_required_delivery_date < v_po.po_date then
    raise exception 'The required delivery date cannot be before the PO date.' using errcode = 'P0001';
  end if;
  if p_fulfilment_warehouse_id is not null and not exists (select 1 from public.warehouses where id = p_fulfilment_warehouse_id and company_id = v_company and status = 'ACTIVE') then
    raise exception 'Fulfilment warehouse not found or inactive.' using errcode = 'P0001';
  end if;
  update public.customer_purchase_orders
  set required_delivery_date = p_required_delivery_date, fulfilment_warehouse_id = p_fulfilment_warehouse_id,
      notes = nullif(btrim(coalesce(p_notes, '')), ''), reviewed_by = auth.uid()
  where id = v_po.id;
  perform private.log_po_event(v_company, v_po.id, null, 'HEADER_UPDATED', v_po.status, v_po.status, null,
    jsonb_build_object('required_delivery_date', p_required_delivery_date, 'fulfilment_warehouse_id', p_fulfilment_warehouse_id,
      'old_required_delivery_date', v_po.required_delivery_date, 'old_fulfilment_warehouse_id', v_po.fulfilment_warehouse_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- Saves the current analysis as a snapshot (history is never overwritten).
create or replace function public.customer_po_refresh_analysis(p_po_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['customer_po.update', 'customer_po_shortages.read']);
  v_summary jsonb;
  v_id      uuid;
  v_at      timestamptz := now();
begin
  if not exists (select 1 from public.customer_purchase_orders where id = p_po_id and company_id = v_company) then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  perform private.po_recompute_status(p_po_id);
  v_summary := private.po_availability_summary(v_company, p_po_id);
  insert into public.customer_po_analysis_snapshots (company_id, purchase_order_id, taken_at, taken_by, summary, lines)
  values (v_company, p_po_id, v_at, auth.uid(), v_summary,
    coalesce((select jsonb_agg(to_jsonb(a) order by a.line_no) from private.po_line_analysis(v_company, p_po_id) a), '[]'::jsonb))
  returning id into v_id;
  update public.customer_purchase_orders set last_analysis_at = v_at where id = p_po_id;
  return jsonb_build_object('snapshot_id', v_id, 'taken_at', v_at, 'summary', v_summary);
end;
$$;

create or replace function public.customer_po_revision_diff(p_po_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
  v_po      public.customer_purchase_orders;
begin
  select * into v_po from public.customer_purchase_orders where id = p_po_id and company_id = v_company;
  if not found then
    raise exception 'PO not found in your company.' using errcode = 'P0001';
  end if;
  if v_po.previous_revision_id is null then
    return jsonb_build_object('previous_revision', null, 'changes', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'previous_revision', (select jsonb_build_object('po_id', id, 'po_reference', po_reference, 'revision', revision, 'status', status)
                          from public.customer_purchase_orders where id = v_po.previous_revision_id),
    'changes', coalesce((
      with cur as (
        select coalesce(product_id::text, 'code:' || upper(coalesce(uploaded_sku, uploaded_customer_sku, uploaded_barcode, uploaded_description))) as k,
          min(coalesce(uploaded_sku, uploaded_customer_sku, uploaded_barcode, uploaded_description)) as code, sum(quantity_ordered) as qty
        from public.customer_purchase_order_lines where purchase_order_id = v_po.id and line_status <> 'EXCLUDED' group by 1),
      prev as (
        select coalesce(product_id::text, 'code:' || upper(coalesce(uploaded_sku, uploaded_customer_sku, uploaded_barcode, uploaded_description))) as k,
          min(coalesce(uploaded_sku, uploaded_customer_sku, uploaded_barcode, uploaded_description)) as code, sum(quantity_ordered) as qty,
          sum(private.po_line_open_reserved(id)) as reserved
        from public.customer_purchase_order_lines where purchase_order_id = v_po.previous_revision_id and line_status <> 'EXCLUDED' group by 1)
      select jsonb_agg(jsonb_build_object('code', coalesce(c.code, p.code), 'previous_quantity', p.qty, 'new_quantity', c.qty,
        'previous_reserved', coalesce(p.reserved, 0),
        'change', case when p.k is null then 'ADDED' when c.k is null then 'REMOVED' when c.qty <> p.qty then 'CHANGED' else 'UNCHANGED' end)
        order by coalesce(c.code, p.code))
      from cur c full join prev p on p.k = c.k), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Shortages
-- -----------------------------------------------------------------------------
create or replace function public.customer_po_shortages(p_from date default null, p_to date default null, p_customer_key text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po_shortages.read');
  v_today   date := private.company_today(v_company);
begin
  return coalesce((
    select jsonb_agg(r order by (r ->> 'required_delivery_date') nulls last, r ->> 'customer_po_number', (r ->> 'line_no')::int)
    from (
      select jsonb_build_object(
        'po_id', po.id, 'po_reference', po.po_reference, 'customer_name', po.customer_name_snapshot, 'customer_key', po.customer_key,
        'customer_po_number', po.customer_po_number, 'revision', po.revision, 'po_date', po.po_date, 'required_delivery_date', po.required_delivery_date,
        'po_status', po.status, 'warehouse_code', w.warehouse_code,
        'line_id', a.line_id, 'line_no', a.line_no, 'product_id', a.product_id, 'sku', a.sku, 'product_name', a.product_name, 'category_name', a.category_name,
        'unit', a.line_unit, 'quantity_ordered', a.quantity_ordered, 'quantity_dispatched', a.quantity_dispatched, 'allocated', a.allocated_open,
        'available', a.available_for_line, 'shortage', a.shortage_after, 'shortage_before', a.shortage_before,
        'in_house_available', a.in_house_available, 'outsourced_available', a.outsourced_available,
        'other_warehouse_available', a.other_warehouse_available, 'unknown_on_hand', a.unknown_on_hand,
        'shortage_status', a.shortage_status, 'priority', a.shortage_priority, 'owner', a.shortage_owner,
        'last_note', (select n.note from public.customer_po_shortage_notes n where n.line_id = a.line_id order by n.created_at desc limit 1),
        'suggested_actions', to_jsonb(array_remove(array[
          case when a.available_for_line > 0 then 'Allocate the eligible stock that is available now' end,
          case when a.other_warehouse_available > 0 then 'Review stock in another warehouse' end,
          case when a.unknown_on_hand > 0 then 'Confirm the source of unverified stock so it can be used' end,
          case when a.default_source_type in ('IN_HOUSE', 'HYBRID')
                and exists (select 1 from public.boms b where b.finished_product_id = a.product_id and b.status = 'APPROVED') then 'Plan in-house production' end,
          case when a.default_source_type in ('OUTSOURCED', 'HYBRID') then 'Create or review an outsourcing order' end,
          case when a.default_source_type = 'IN_HOUSE'
                and not exists (select 1 from public.boms b where b.finished_product_id = a.product_id and b.status = 'APPROVED') then 'Review purchasing / production requirements (no approved BOM)' end,
          case when po.required_delivery_date is not null and po.required_delivery_date <= v_today + 7 then 'Contact the customer about partial fulfilment or a revised delivery date' end
        ], null))) as r
      from public.customer_purchase_orders po
      left join public.warehouses w on w.id = po.fulfilment_warehouse_id
      cross join lateral private.po_line_analysis(v_company, po.id) a
      where po.company_id = v_company and po.is_current and po.status not in ('CANCELLED', 'FULFILLED', 'DRAFT')
        and a.line_status = 'MATCHED' and a.shortage_after > 0
        and (p_from is null or po.po_date >= p_from) and (p_to is null or po.po_date <= p_to)
        and (p_customer_key is null or po.customer_key = p_customer_key)
    ) x), '[]'::jsonb);
end;
$$;

create or replace function public.customer_po_update_shortage(p_line_id uuid, p_status text, p_priority text, p_owner uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.update');
  v_line    public.customer_purchase_order_lines;
begin
  select * into v_line from public.customer_purchase_order_lines where id = p_line_id and company_id = v_company for update;
  if not found then
    raise exception 'PO line not found in your company.' using errcode = 'P0001';
  end if;
  if p_status not in ('OPEN', 'IN_PROGRESS', 'RESOLVED') or p_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'Invalid shortage status or priority.' using errcode = 'P0001';
  end if;
  if p_owner is not null and not exists (select 1 from public.profiles where id = p_owner and company_id = v_company and is_active) then
    raise exception 'The responsible user must be an active user of your company.' using errcode = 'P0001';
  end if;
  update public.customer_purchase_order_lines set shortage_status = p_status, shortage_priority = p_priority, shortage_owner = p_owner where id = v_line.id;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into public.customer_po_shortage_notes (company_id, line_id, note, created_by) values (v_company, v_line.id, btrim(p_note), auth.uid());
  end if;
  perform private.log_po_event(v_company, v_line.purchase_order_id, v_line.id, 'SHORTAGE_UPDATED', null, null, p_note,
    jsonb_build_object('status', p_status, 'priority', p_priority, 'owner', p_owner));
  return jsonb_build_object('ok', true);
end;
$$;

-- Active users of the company who can see customer POs (for shortage ownership).
create or replace function public.customer_po_assignable_users()
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('customer_po.read');
begin
  return query
  select distinct p.id, coalesce(p.full_name, split_part(p.email, '@', 1))
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id and ur.company_id = v_company
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions perm on perm.id = rp.permission_id and perm.code = 'customer_po.read'
  where p.company_id = v_company and p.is_active
  order by 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- List views (security_invoker: RLS applies to the caller)
-- -----------------------------------------------------------------------------
create or replace view public.customer_po_list
with (security_invoker = true) as
select po.*, c.customer_code, w.warehouse_code as fulfilment_warehouse_code,
  coalesce(l.lines, 0) as line_count,
  coalesce(l.unmatched, 0) as unmatched_lines,
  coalesce(l.review, 0) as review_lines,
  coalesce(l.units, '[]'::jsonb) as unit_totals
from public.customer_purchase_orders po
left join public.customers c on c.id = po.customer_id
left join public.warehouses w on w.id = po.fulfilment_warehouse_id
left join lateral (
  select count(*) filter (where line_status <> 'EXCLUDED') as lines,
    count(*) filter (where line_status in ('UNMATCHED', 'AMBIGUOUS')) as unmatched,
    count(*) filter (where line_status in ('INVALID', 'DUPLICATE_REVIEW')) as review,
    (select jsonb_agg(jsonb_build_object('unit', u.unit, 'ordered', u.ordered, 'dispatched', u.dispatched, 'allocated', u.allocated))
       from (select coalesce(unit, '?') as unit, sum(quantity_ordered) as ordered, sum(quantity_dispatched) as dispatched,
               sum(private.po_line_open_reserved(id)) as allocated
             from public.customer_purchase_order_lines x where x.purchase_order_id = po.id and x.line_status = 'MATCHED' group by 1) u) as units
  from public.customer_purchase_order_lines where purchase_order_id = po.id
) l on true;

create or replace view public.customer_po_line_list
with (security_invoker = true) as
select l.*, po.po_reference, po.customer_po_number, po.revision, po.customer_name_snapshot, po.status as po_status, po.is_current,
  p.sku, p.product_name, p.base_unit, p.status as product_status, c.name as category_name,
  private.po_line_open_reserved(l.id) as allocated_open
from public.customer_purchase_order_lines l
join public.customer_purchase_orders po on po.id = l.purchase_order_id
left join public.products p on p.id = l.product_id
left join public.product_categories c on c.id = p.category_id;

create or replace view public.customer_po_allocation_list
with (security_invoker = true) as
select r.*, l.purchase_order_id, l.line_no, po.po_reference, po.customer_po_number, po.customer_name_snapshot, po.status as po_status,
  p.sku, p.product_name, p.base_unit, bt.batch_number, bt.expiry_date, w.warehouse_code, loc.location_code
from public.stock_reservations r
join public.customer_purchase_order_lines l on l.id = r.reference_id
join public.customer_purchase_orders po on po.id = l.purchase_order_id
join public.products p on p.id = r.product_id
left join public.inventory_batches bt on bt.id = r.batch_id
left join public.warehouses w on w.id = r.warehouse_id
left join public.inventory_locations loc on loc.id = r.location_id
where r.reference_type = 'CUSTOMER_PO';

revoke all on public.customer_po_list, public.customer_po_line_list, public.customer_po_allocation_list from anon, authenticated;
grant select on public.customer_po_list, public.customer_po_line_list, public.customer_po_allocation_list to authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.customer_po_preview(jsonb, jsonb, text)',
    'public.customer_po_import(jsonb, jsonb, jsonb, uuid, uuid)',
    'public.customer_po_line_action(uuid, text, uuid, boolean, text, numeric, text)',
    'public.customer_po_rematch(uuid)',
    'public.customer_po_analysis(uuid)',
    'public.customer_po_line_stock(uuid)',
    'public.customer_po_propose(uuid, text, uuid[])',
    'public.customer_po_allocate(uuid, text, uuid[], jsonb, boolean, text, uuid)',
    'public.customer_po_save_plan(uuid, text, jsonb, text)',
    'public.customer_po_release(uuid, uuid, uuid, text)',
    'public.customer_po_dispatch(uuid, jsonb, text, text, uuid)',
    'public.customer_po_reverse_dispatch(uuid, text, uuid)',
    'public.customer_po_action(uuid, text, text)',
    'public.customer_po_update_header(uuid, date, uuid, text)',
    'public.customer_po_refresh_analysis(uuid)',
    'public.customer_po_revision_diff(uuid)',
    'public.customer_po_shortages(date, date, text)',
    'public.customer_po_update_shortage(uuid, text, text, uuid, text)',
    'public.customer_po_assignable_users()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
