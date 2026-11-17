-- =============================================================================
-- Bulk BOM management: where-used analysis, bulk replace / delete / add / edit,
-- approval workflow, atomic publishing as new revisions, reversal.
--
-- Builds on the existing BOM model (20261013090200, 20261102090000, 20261118090000):
--   * boms / bom_items stay the only BOM master. A BOM version IS the revision
--     record: approved versions never change, a change is the next version.
--   * Publishing a batch creates, for every affected BOM, the next version with
--     the existing functions (production_new_bom_version + production_save_bom,
--     which re-validate components, units, duplicates and circular BOMs) and
--     activates it from the batch's effective date. The previous version is
--     closed the day before (or superseded when it starts the same day) and kept.
--   * Production orders keep the BOM version and material plan they were created
--     with (production_orders.bom_id + production_order_materials); nothing here
--     touches orders, stock, purchase orders or consumption history. New orders
--     pick the version effective on the day they are created (existing rule).
--   * No unit-conversion master exists: a BOM line's unit is always the
--     component's inventory unit. Replacing a component with one in another unit
--     needs an explicit conversion factor or quantity.
--   * One line per component per BOM (bom_items_component_unique). "Allow
--     duplicates" therefore means merging into the existing line (quantities added).
--
-- New tables (company-scoped, select-only RLS by production_bom.read; written only
-- by the SECURITY DEFINER functions below):
--   bom_change_batches      one bulk change (operation, reason, effective date, status)
--   bom_change_batch_lines  one change on one BOM (old and new values, errors, revision created)
--   bom_change_approvals    workflow history (created, submitted, approved, rejected, published, …)
--
-- Permissions (existing codes, none added):
--   prepare / submit / withdraw   production_bom.create or production_bom.update
--   approve / reject              production_bom.approve (self-approval follows
--                                 inventory.segregation_of_duties, as for single BOMs)
--   publish                       production_bom.approve and production_bom.create
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.bom_change_batches (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  batch_number      text not null check (batch_number ~ '^BCB-[0-9]{6,}$'),
  operation         text not null check (operation in ('REPLACE', 'DELETE', 'ADD', 'EDIT', 'RESTORE')),
  status            text not null default 'DRAFT'
                    check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PUBLISHED', 'CANCELLED')),
  title             text check (title is null or length(title) <= 200),
  reason            text not null check (length(btrim(reason)) between 3 and 1000),
  effective_from    date not null,
  merge_duplicates  boolean not null default false,
  restores_batch_id uuid,
  summary           jsonb not null default '{}'::jsonb,
  preview_hash      text,
  submitted_hash    text,
  row_version       integer not null default 1,
  last_error        text check (last_error is null or length(last_error) <= 2000),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  submitted_by      uuid,
  submitted_at      timestamptz,
  approved_by       uuid,
  approved_at       timestamptz,
  approval_note     text check (approval_note is null or length(approval_note) <= 1000),
  rejected_by       uuid,
  rejected_at       timestamptz,
  rejection_reason  text check (rejection_reason is null or length(rejection_reason) <= 1000),
  published_by      uuid,
  published_at      timestamptz,
  cancelled_by      uuid,
  cancelled_at      timestamptz,
  constraint bom_change_batches_number_unique unique (company_id, batch_number),
  constraint bom_change_batches_id_company_unique unique (id, company_id)
);

create index if not exists bom_change_batches_status_idx on public.bom_change_batches (company_id, status, created_at desc);

comment on table public.bom_change_batches is
  'Bulk BOM changes. Published batches create a new BOM version per affected BOM; earlier versions are kept unchanged.';

-- BOMs and products are referenced by id without a foreign key on purpose: the
-- department planner and the product bulk delete treat any foreign key as a
-- blocker, and a draft change must not stop a product from being archived.
-- SKU and name snapshots keep the history readable.
create table if not exists public.bom_change_batch_lines (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies (id) on delete restrict,
  batch_id                 uuid not null,
  line_no                  integer not null check (line_no between 1 and 5000),
  action                   text not null check (action in ('REPLACE', 'DELETE', 'ADD', 'EDIT', 'RESTORE')),
  source_bom_id            uuid not null,
  bom_code                 text,
  source_version           integer,
  finished_product_id      uuid,
  finished_sku             text,
  finished_name            text,
  component_product_id     uuid,
  component_sku            text,
  component_name           text,
  new_component_product_id uuid,
  new_component_sku        text,
  new_component_name       text,
  restore_from_bom_id      uuid,
  input                    jsonb not null default '{}'::jsonb,
  old_quantity             numeric(18,6),
  new_quantity             numeric(18,6),
  old_unit                 text,
  new_unit                 text,
  old_wastage              numeric(5,2),
  new_wastage              numeric(5,2),
  old_notes                text,
  new_notes                text,
  validation_errors        jsonb not null default '[]'::jsonb,
  warnings                 jsonb not null default '[]'::jsonb,
  result_bom_id            uuid,
  result_version           integer,
  constraint bom_change_batch_lines_batch_fk foreign key (batch_id, company_id)
    references public.bom_change_batches (id, company_id) on delete cascade,
  constraint bom_change_batch_lines_no_unique unique (batch_id, line_no)
);

create index if not exists bom_change_batch_lines_batch_idx on public.bom_change_batch_lines (batch_id, source_bom_id);
create index if not exists bom_change_batch_lines_result_idx on public.bom_change_batch_lines (company_id, result_bom_id) where result_bom_id is not null;

create table if not exists public.bom_change_approvals (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  batch_id     uuid not null,
  action       text not null check (action in ('CREATED', 'EDITED', 'SUBMITTED', 'WITHDRAWN', 'APPROVED', 'REJECTED',
                                                'PUBLISHED', 'PUBLISH_FAILED', 'CANCELLED')),
  actor_id     uuid,
  acted_at     timestamptz not null default now(),
  note         text check (note is null or length(note) <= 2000),
  preview_hash text,
  details      jsonb not null default '{}'::jsonb,
  constraint bom_change_approvals_batch_fk foreign key (batch_id, company_id)
    references public.bom_change_batches (id, company_id) on delete cascade
);

create index if not exists bom_change_approvals_batch_idx on public.bom_change_approvals (batch_id, acted_at);

alter table public.bom_change_batches enable row level security;
alter table public.bom_change_batch_lines enable row level security;
alter table public.bom_change_approvals enable row level security;
revoke all on table public.bom_change_batches, public.bom_change_batch_lines, public.bom_change_approvals from anon, authenticated;
grant select on table public.bom_change_batches, public.bom_change_batch_lines, public.bom_change_approvals to authenticated;
grant all on table public.bom_change_batches, public.bom_change_batch_lines, public.bom_change_approvals to service_role;

drop policy if exists bom_change_batches_select on public.bom_change_batches;
create policy bom_change_batches_select on public.bom_change_batches for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));
drop policy if exists bom_change_batch_lines_select on public.bom_change_batch_lines;
create policy bom_change_batch_lines_select on public.bom_change_batch_lines for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));
drop policy if exists bom_change_approvals_select on public.bom_change_approvals;
create policy bom_change_approvals_select on public.bom_change_approvals for select to authenticated
  using (private.has_permission(company_id, 'production_bom.read'));

-- The workflow history is append-only.
drop trigger if exists bom_change_approvals_append_only on public.bom_change_approvals;
create trigger bom_change_approvals_append_only before update on public.bom_change_approvals
  for each row execute function private.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- 2. Helpers
-- -----------------------------------------------------------------------------

-- Current revision of a product's BOM: its latest approved version (active now,
-- or scheduled to start later). Bulk changes always start from this version.
create or replace function private.bom_current_revision(p_company uuid, p_product uuid)
returns public.boms
language sql
stable
security definer
set search_path = ''
as $$
  select b.* from public.boms b
  where b.company_id = p_company and b.finished_product_id = p_product and b.status = 'APPROVED'
  order by b.version desc
  limit 1;
$$;

revoke all on function private.bom_current_revision(uuid, uuid) from public, anon, authenticated;

-- A number from user input, or null when it is blank or not a number.
create or replace function private.bom_bulk_num(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  return btrim(p_value)::numeric;
exception when others then
  return 'NaN'::numeric;
end;
$$;

revoke all on function private.bom_bulk_num(text) from public, anon, authenticated;

create or replace function private.bom_change_event(p_batch public.bom_change_batches, p_action text, p_note text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
begin
  insert into public.bom_change_approvals (company_id, batch_id, action, actor_id, note, preview_hash, details)
  values (p_batch.company_id, p_batch.id, p_action, auth.uid(), left(p_note, 2000), p_batch.preview_hash, coalesce(p_details, '{}'::jsonb));
  -- The audit log keeps at most 8 KB per entry: large lists stay in bom_change_approvals only.
  v_meta := jsonb_build_object('batch_number', p_batch.batch_number, 'operation', p_batch.operation, 'status', p_batch.status,
    'note', left(p_note, 1000)) || coalesce(p_details, '{}'::jsonb);
  if pg_column_size(v_meta) > 7000 then
    v_meta := (v_meta - 'revisions' - 'impact' - 'summary') || jsonb_build_object('details', 'Full details in bom_change_approvals',
      'revisions_count', jsonb_array_length(coalesce(p_details -> 'revisions', '[]'::jsonb)));
  end if;
  perform private.write_audit_log(p_batch.company_id, 'production.bom_change_' || lower(p_action), 'bom_change_batch', p_batch.id::text, v_meta);
end;
$$;

revoke all on function private.bom_change_event(public.bom_change_batches, text, text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Evaluation: applies the batch to the current BOM contents in memory,
--    stores old/new values and errors per line, and returns the summary plus
--    (p_collect) the resulting component list per BOM. Writes nothing to BOMs.
-- -----------------------------------------------------------------------------
create or replace function private.bom_change_evaluate(p_batch_id uuid, p_collect boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch   public.bom_change_batches;
  v_today   date;
  v_src     uuid;
  b         public.boms;
  v_latest  public.boms;
  v_fp      public.products;
  v_line    public.bom_change_batch_lines;
  c_old     public.products;
  c_new     public.products;
  v_items   jsonb;
  v_restore jsonb;
  v_item    jsonb;
  v_old     jsonb;
  v_max     int;
  v_err     jsonb;
  v_warn    jsonb;
  v_bom_err jsonb;
  v_bom_warn jsonb;
  v_qty     numeric;
  v_factor  numeric;
  v_waste   numeric;
  v_unit    text;
  v_notes   text;
  v_source  text;
  v_in      jsonb;
  v_first   uuid;
  v_result  jsonb := '{}'::jsonb;
  v_hash    text := '';
  k         text;
  x         record;
begin
  select * into v_batch from public.bom_change_batches where id = p_batch_id;
  v_today := private.company_today(v_batch.company_id);

  for v_src in select distinct l.source_bom_id from public.bom_change_batch_lines l where l.batch_id = p_batch_id order by 1 loop
    v_bom_err := '[]'::jsonb;
    v_bom_warn := '[]'::jsonb;
    select * into b from public.boms where id = v_src and company_id = v_batch.company_id;
    v_first := (select l.id from public.bom_change_batch_lines l where l.batch_id = p_batch_id and l.source_bom_id = v_src order by l.line_no limit 1);
    v_items := '{}'::jsonb;
    v_max := 0;

    if b.id is null then
      v_bom_err := v_bom_err || to_jsonb('The BOM was not found in your company.'::text);
    else
      select * into v_fp from public.products where id = b.finished_product_id;
      v_latest := private.bom_current_revision(b.company_id, b.finished_product_id);
      v_hash := v_hash || b.id::text || ':' || b.version || ':' || b.status || ':' || coalesce(b.effective_to::text, '') || '|';
      if b.status <> 'APPROVED' or v_latest.id is distinct from b.id then
        v_bom_err := v_bom_err || to_jsonb(format('%s v%s is no longer the current revision of %s (current: %s). Select the BOM again.',
          b.bom_code, b.version, v_fp.sku, coalesce('v' || v_latest.version, 'none')));
      end if;
      if v_fp.status <> 'ACTIVE' or v_fp.archived_at is not null then
        v_bom_err := v_bom_err || to_jsonb(format('The finished product %s is inactive.', v_fp.sku));
      end if;
      if v_batch.effective_from < b.effective_from then
        v_bom_err := v_bom_err || to_jsonb(format('%s v%s starts on %s: the effective date must be on or after it.', b.bom_code, b.version, b.effective_from));
      end if;
      if b.effective_to is not null and b.effective_to < v_batch.effective_from then
        v_bom_err := v_bom_err || to_jsonb(format('%s v%s ends on %s, before the effective date.', b.bom_code, b.version, b.effective_to));
      end if;
      if exists (select 1 from public.boms d where d.company_id = b.company_id and d.finished_product_id = b.finished_product_id
                 and d.version > b.version and d.status in ('DRAFT', 'PENDING_APPROVAL', 'REJECTED')) then
        v_bom_warn := v_bom_warn || to_jsonb(format('%s has an unpublished draft version; it will not include this change and will need to be recreated.', v_fp.sku));
      end if;
      select coalesce(jsonb_object_agg(i.component_product_id::text, jsonb_build_object(
               'line_no', i.line_no, 'component_product_id', i.component_product_id, 'quantity_required', i.quantity_required,
               'unit', i.unit, 'wastage_percentage', i.wastage_percentage, 'notes', i.notes,
               'source_type', i.source_type, 'preferred_supplier_id', i.preferred_supplier_id)), '{}'::jsonb),
             coalesce(max(i.line_no), 0)
        into v_items, v_max
      from public.bom_items i where i.bom_id = b.id;
    end if;

    for v_line in select * from public.bom_change_batch_lines l where l.batch_id = p_batch_id and l.source_bom_id = v_src order by l.line_no loop
      v_err := '[]'::jsonb;
      v_warn := '[]'::jsonb;
      v_in := v_line.input;
      v_old := case when v_line.component_product_id is not null then v_items -> v_line.component_product_id::text end;
      c_old := null;
      c_new := null;
      if v_line.component_product_id is not null then
        select * into c_old from public.products where id = v_line.component_product_id and company_id = v_batch.company_id;
      end if;
      if v_line.new_component_product_id is not null then
        select * into c_new from public.products where id = v_line.new_component_product_id and company_id = v_batch.company_id;
      end if;
      v_qty := null; v_unit := null; v_waste := null; v_notes := null;

      if b.id is null then
        null;
      elsif v_line.action = 'RESTORE' then
        if not exists (select 1 from public.boms r where r.id = v_line.restore_from_bom_id and r.company_id = v_batch.company_id
                       and r.finished_product_id = b.finished_product_id) then
          v_err := v_err || to_jsonb('The revision to restore was not found.'::text);
        else
          select coalesce(jsonb_object_agg(i.component_product_id::text, jsonb_build_object(
                   'line_no', i.line_no, 'component_product_id', i.component_product_id, 'quantity_required', i.quantity_required,
                   'unit', i.unit, 'wastage_percentage', i.wastage_percentage, 'notes', i.notes,
                   'source_type', i.source_type, 'preferred_supplier_id', i.preferred_supplier_id)), '{}'::jsonb)
            into v_restore
          from public.bom_items i where i.bom_id = v_line.restore_from_bom_id;
          v_items := v_restore;
          v_max := coalesce((select max((e.value ->> 'line_no')::int) from jsonb_each(v_items) e), 0);
          v_qty := (select count(*) from jsonb_each(v_items));
        end if;
      else
        -- The component on the BOM (REPLACE, DELETE, EDIT) or the one added (ADD).
        if v_line.action in ('REPLACE', 'DELETE', 'EDIT') then
          if c_old.id is null then
            v_err := v_err || to_jsonb('Component not found in your company.'::text);
          elsif v_old is null then
            v_err := v_err || to_jsonb(format('%s is not on %s v%s.', c_old.sku, b.bom_code, b.version));
          end if;
        end if;
        -- The component that goes onto the BOM (REPLACE: the replacement; ADD: the new one).
        if v_line.action in ('REPLACE', 'ADD') then
          if v_line.action = 'ADD' then c_new := c_old; end if;
          if c_new.id is null then
            v_err := v_err || to_jsonb('The new component was not found in your company.'::text);
          elsif c_new.status <> 'ACTIVE' or c_new.archived_at is not null then
            v_err := v_err || to_jsonb(format('%s is inactive and cannot be used.', c_new.sku));
          elsif c_new.id = b.finished_product_id then
            v_err := v_err || to_jsonb(format('%s cannot be a component of itself.', c_new.sku));
          elsif v_line.action = 'REPLACE' and c_new.id = v_line.component_product_id then
            v_err := v_err || to_jsonb('The replacement is the same component.'::text);
          elsif private.bom_creates_cycle(b.company_id, b.finished_product_id, array[c_new.id]) then
            v_err := v_err || to_jsonb(format('Circular BOM: %s (directly or through its own BOM) requires %s.', c_new.sku, v_fp.sku));
          end if;
        end if;

        if jsonb_array_length(v_err) = 0 then
          v_factor := private.bom_bulk_num(v_in ->> 'factor');
          v_qty := private.bom_bulk_num(v_in ->> 'quantity');
          v_waste := private.bom_bulk_num(v_in ->> 'wastage_percentage');
          v_notes := case when v_in ? 'notes' then nullif(btrim(coalesce(v_in ->> 'notes', '')), '') else (v_old ->> 'notes') end;
          v_source := upper(nullif(btrim(coalesce(v_in ->> 'source_type', '')), ''));
          if v_factor = 'NaN' or v_qty = 'NaN' or v_waste = 'NaN' then
            v_err := v_err || to_jsonb('Quantity, conversion factor and wastage must be numbers.'::text);
          elsif v_factor is not null and v_factor <= 0 then
            v_err := v_err || to_jsonb('The conversion factor must be greater than zero.'::text);
          elsif v_source is not null and v_source not in ('IN_HOUSE', 'OUTSOURCED', 'PURCHASED') then
            v_err := v_err || to_jsonb('Source must be In-house, Outsourced or Purchased.'::text);
          elsif v_notes is not null and length(v_notes) > 500 then
            v_err := v_err || to_jsonb('Notes are limited to 500 characters.'::text);
          end if;
        end if;

        if jsonb_array_length(v_err) = 0 then
          if v_line.action = 'REPLACE' then
            v_unit := c_new.base_unit;
            if v_qty is null then
              if (v_old ->> 'unit') <> c_new.base_unit and v_factor is null then
                v_err := v_err || to_jsonb(format('Units differ (%s on the BOM, %s for %s): enter a conversion factor or the new quantity.',
                  v_old ->> 'unit', c_new.base_unit, c_new.sku));
              else
                v_qty := round((v_old ->> 'quantity_required')::numeric * coalesce(v_factor, 1), 6);
              end if;
            end if;
            v_waste := coalesce(v_waste, (v_old ->> 'wastage_percentage')::numeric);
          elsif v_line.action = 'ADD' then
            v_unit := upper(btrim(coalesce(nullif(v_in ->> 'unit', ''), c_new.base_unit)));
            if v_qty is null then
              v_err := v_err || to_jsonb('Enter the quantity to add.'::text);
            end if;
            if v_unit <> c_new.base_unit then
              v_err := v_err || to_jsonb(format('Unit %s does not match the inventory unit of %s (%s). No unit conversion is configured, so enter the quantity in %s.',
                v_unit, c_new.sku, c_new.base_unit, c_new.base_unit));
            end if;
            v_waste := coalesce(v_waste, 0);
          elsif v_line.action = 'EDIT' then
            v_unit := upper(btrim(coalesce(nullif(v_in ->> 'unit', ''), v_old ->> 'unit')));
            if v_factor is not null and v_qty is null then
              v_qty := round((v_old ->> 'quantity_required')::numeric * v_factor, 6);
            end if;
            v_qty := coalesce(v_qty, (v_old ->> 'quantity_required')::numeric);
            v_waste := coalesce(v_waste, (v_old ->> 'wastage_percentage')::numeric);
            if v_unit <> c_old.base_unit then
              v_err := v_err || to_jsonb(format('Unit %s does not match the inventory unit of %s (%s). No unit conversion is configured, so the BOM line must use %s.',
                v_unit, c_old.sku, c_old.base_unit, c_old.base_unit));
            end if;
          end if;
          if v_line.action <> 'DELETE' and jsonb_array_length(v_err) = 0 then
            if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 6) then
              v_err := v_err || to_jsonb('Quantity must be greater than zero (up to 6 decimals).'::text);
            end if;
            if v_waste < 0 or v_waste >= 100 or v_waste <> round(v_waste, 2) then
              v_err := v_err || to_jsonb('Wastage must be between 0 and 99.99 percent.'::text);
            end if;
          end if;
        end if;

        -- Apply to the in-memory component list.
        if jsonb_array_length(v_err) = 0 then
          if v_line.action = 'DELETE' then
            v_items := v_items - v_line.component_product_id::text;
          elsif v_line.action = 'EDIT' then
            if v_qty = (v_old ->> 'quantity_required')::numeric and v_waste = (v_old ->> 'wastage_percentage')::numeric
               and v_unit = (v_old ->> 'unit') and v_notes is not distinct from (v_old ->> 'notes')
               and coalesce(v_source, v_old ->> 'source_type') is not distinct from (v_old ->> 'source_type') then
              v_warn := v_warn || to_jsonb('No change on this line.'::text);
            end if;
            v_items := jsonb_set(v_items, array[v_line.component_product_id::text], v_old || jsonb_build_object(
              'quantity_required', v_qty, 'unit', v_unit, 'wastage_percentage', v_waste, 'notes', v_notes,
              'source_type', coalesce(v_source, v_old ->> 'source_type')));
          else
            -- REPLACE / ADD: the component may already be on the BOM.
            if v_items ? c_new.id::text then
              if not v_batch.merge_duplicates then
                v_err := v_err || to_jsonb(format('%s is already on %s v%s. Tick "merge into the existing line" to add the quantities together.',
                  c_new.sku, b.bom_code, b.version));
              elsif (v_items -> c_new.id::text ->> 'unit') <> v_unit then
                v_err := v_err || to_jsonb(format('%s is already on the BOM in %s; quantities in different units cannot be merged.',
                  c_new.sku, v_items -> c_new.id::text ->> 'unit'));
              else
                v_items := jsonb_set(v_items, array[c_new.id::text, 'quantity_required'],
                  to_jsonb(round((v_items -> c_new.id::text ->> 'quantity_required')::numeric + v_qty, 6)));
                if v_line.action = 'REPLACE' then
                  v_items := v_items - v_line.component_product_id::text;
                end if;
                v_warn := v_warn || to_jsonb(format('Merged into the existing %s line (quantities added).', c_new.sku));
              end if;
            elsif v_line.action = 'REPLACE' then
              v_items := (v_items - v_line.component_product_id::text) || jsonb_build_object(c_new.id::text, jsonb_build_object(
                'line_no', (v_old ->> 'line_no')::int, 'component_product_id', c_new.id, 'quantity_required', v_qty, 'unit', v_unit,
                'wastage_percentage', v_waste, 'notes', v_notes, 'source_type', v_source, 'preferred_supplier_id', null));
            else
              v_max := v_max + 1;
              v_items := v_items || jsonb_build_object(c_new.id::text, jsonb_build_object(
                'line_no', v_max, 'component_product_id', c_new.id, 'quantity_required', v_qty, 'unit', v_unit,
                'wastage_percentage', v_waste, 'notes', v_notes, 'source_type', v_source, 'preferred_supplier_id', null));
            end if;
          end if;
        end if;
      end if;

      if v_line.id = v_first then
        v_err := v_bom_err || v_err;
        v_warn := v_bom_warn || v_warn;
      elsif jsonb_array_length(v_bom_err) > 0 then
        v_err := to_jsonb('See the first line of this BOM.'::text) || v_err;
      end if;

      update public.bom_change_batch_lines set
        bom_code = coalesce(b.bom_code, bom_code), source_version = coalesce(b.version, source_version),
        finished_product_id = coalesce(b.finished_product_id, finished_product_id),
        finished_sku = coalesce(v_fp.sku, finished_sku), finished_name = coalesce(v_fp.product_name, finished_name),
        component_sku = coalesce(c_old.sku, component_sku), component_name = coalesce(c_old.product_name, component_name),
        new_component_sku = case when action = 'REPLACE' then coalesce(c_new.sku, new_component_sku) end,
        new_component_name = case when action = 'REPLACE' then coalesce(c_new.product_name, new_component_name) end,
        old_quantity = case when action = 'RESTORE' then null else (v_old ->> 'quantity_required')::numeric end,
        old_unit = v_old ->> 'unit', old_wastage = (v_old ->> 'wastage_percentage')::numeric, old_notes = v_old ->> 'notes',
        new_quantity = case when action in ('DELETE', 'RESTORE') then null else v_qty end,
        new_unit = case when action in ('DELETE', 'RESTORE') then null else v_unit end,
        new_wastage = case when action in ('DELETE', 'RESTORE') then null else v_waste end,
        new_notes = case when action in ('DELETE', 'RESTORE') then null else v_notes end,
        validation_errors = v_err, warnings = v_warn
      where id = v_line.id;
      v_hash := v_hash || v_line.line_no || ':' || v_line.action || ':' || coalesce(v_line.component_product_id::text, '') || ':'
        || coalesce(v_line.new_component_product_id::text, '') || ':' || v_line.input::text || ':' || coalesce(v_qty::text, '') || '|';
    end loop;

    -- The resulting BOM must still be valid as a whole.
    if b.id is not null then
      if not exists (select 1 from jsonb_each(v_items)) then
        update public.bom_change_batch_lines set validation_errors = validation_errors
          || to_jsonb(format('All components of %s v%s would be removed; a BOM needs at least one component.', b.bom_code, b.version))
        where id = v_first;
      elsif (select count(*) from jsonb_each(v_items)) > 500 then
        update public.bom_change_batch_lines set validation_errors = validation_errors || to_jsonb('A BOM can have at most 500 components.'::text)
        where id = v_first;
      end if;
      for x in
        select p.sku, p.base_unit, e.value ->> 'unit' as unit, (p.status <> 'ACTIVE' or p.archived_at is not null) as inactive
        from jsonb_each(v_items) e join public.products p on p.id = (e.key)::uuid
        where p.status <> 'ACTIVE' or p.archived_at is not null or p.base_unit <> e.value ->> 'unit'
      loop
        update public.bom_change_batch_lines set validation_errors = validation_errors || to_jsonb(case when x.inactive
            then format('%s on this BOM is inactive: replace or remove it in the same batch.', x.sku)
            else format('%s is on this BOM in %s but its inventory unit is %s: correct it with a bulk edit.', x.sku, x.unit, x.base_unit) end)
        where id = v_first;
      end loop;
      if p_collect then
        v_result := v_result || jsonb_build_object(b.id::text, coalesce((
          select jsonb_agg(e.value order by (e.value ->> 'line_no')::int) from jsonb_each(v_items) e), '[]'::jsonb));
      end if;
    end if;
  end loop;

  update public.bom_change_batches set
    preview_hash = md5(v_hash || effective_from::text || merge_duplicates::text),
    summary = (
      select jsonb_build_object(
        'boms', count(distinct l.source_bom_id),
        'boms_valid', count(distinct l.source_bom_id) filter (where not exists (
          select 1 from public.bom_change_batch_lines e where e.batch_id = l.batch_id and e.source_bom_id = l.source_bom_id
            and jsonb_array_length(e.validation_errors) > 0)),
        'lines', count(*),
        'lines_with_errors', count(*) filter (where jsonb_array_length(l.validation_errors) > 0),
        'lines_with_warnings', count(*) filter (where jsonb_array_length(l.warnings) > 0),
        'products_with_errors', coalesce((
          select jsonb_agg(jsonb_build_object('finished_product_id', z.finished_product_id, 'sku', z.finished_sku, 'name', z.finished_name, 'errors', z.errors))
          from (select e.finished_product_id, e.finished_sku, e.finished_name, jsonb_agg(m.value) as errors
                from public.bom_change_batch_lines e cross join lateral jsonb_array_elements(e.validation_errors) m
                where e.batch_id = p_batch_id and m.value #>> '{}' <> 'See the first line of this BOM.'
                group by e.finished_product_id, e.finished_sku, e.finished_name) z), '[]'::jsonb),
        'evaluated_at', now())
      from public.bom_change_batch_lines l where l.batch_id = p_batch_id)
  where id = p_batch_id
  returning * into v_batch;

  return jsonb_build_object('summary', v_batch.summary, 'preview_hash', v_batch.preview_hash, 'boms', v_result);
end;
$$;

revoke all on function private.bom_change_evaluate(uuid, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Impact: production orders, stock, open purchase orders and consumption of
--    the components involved. Read-only; sections need the matching permission.
-- -----------------------------------------------------------------------------
create or replace function private.bom_change_impact(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch   public.bom_change_batches;
  v_orders  jsonb := null;
  v_comps   jsonb;
  v_stock   boolean;
  v_po      boolean;
  v_mfg     boolean;
  v_today   date;
begin
  select * into v_batch from public.bom_change_batches where id = p_batch_id;
  v_today := private.company_today(v_batch.company_id);
  v_stock := private.has_permission(v_batch.company_id, 'inventory.read');
  v_po := private.has_permission(v_batch.company_id, 'purchases.read') or private.has_permission(v_batch.company_id, 'purchase_order.read');
  v_mfg := private.has_permission(v_batch.company_id, 'manufacturing.read');

  if v_mfg then
    select coalesce(jsonb_agg(jsonb_build_object(
        'production_order_id', o.id, 'production_order_number', o.production_order_number, 'status', o.status,
        'sku', p.sku, 'product_name', p.product_name, 'bom_code', o.bom_code, 'bom_version', o.bom_version,
        'planned_quantity', o.planned_quantity, 'unit', o.unit, 'planned_start_date', o.planned_start_date,
        'released', o.status not in ('DRAFT', 'PENDING_APPROVAL'),
        'effect', case when o.status in ('DRAFT', 'PENDING_APPROVAL')
          then format('Keeps v%s. Editing it on or after %s recalculates its materials from the new revision.', o.bom_version, v_batch.effective_from)
          else format('Keeps v%s and its material plan; not changed.', o.bom_version) end
      ) order by o.planned_start_date, o.production_order_number), '[]'::jsonb)
      into v_orders
    from public.production_orders o join public.products p on p.id = o.finished_product_id
    where o.company_id = v_batch.company_id
      and o.bom_id in (select l.source_bom_id from public.bom_change_batch_lines l where l.batch_id = p_batch_id)
      and o.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'ON_HOLD');
  end if;

  with involved as (
    select l.component_product_id as product_id,
      case when l.action in ('REPLACE', 'DELETE') then 'REMOVED' when l.action = 'ADD' then 'ADDED' else 'CHANGED' end as role,
      l.source_bom_id
    from public.bom_change_batch_lines l where l.batch_id = p_batch_id and l.component_product_id is not null
    union all
    select l.new_component_product_id, 'ADDED', l.source_bom_id
    from public.bom_change_batch_lines l where l.batch_id = p_batch_id and l.new_component_product_id is not null
  ), per as (
    select i.product_id, string_agg(distinct i.role, ',' order by i.role) as roles, count(distinct i.source_bom_id) as boms_in_batch,
      count(distinct i.source_bom_id) filter (where i.role = 'REMOVED') as boms_removed
    from involved i group by i.product_id
  ), current_use as (
    select bi.component_product_id as product_id, count(distinct b.finished_product_id) as current_boms
    from public.boms b join public.bom_items bi on bi.bom_id = b.id
    where b.company_id = v_batch.company_id and b.status = 'APPROVED'
      and b.id = (private.bom_current_revision(b.company_id, b.finished_product_id)).id
      and bi.component_product_id in (select product_id from per)
    group by bi.component_product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'unit', p.base_unit, 'roles', per.roles,
      'boms_in_batch', per.boms_in_batch, 'current_boms', coalesce(cu.current_boms, 0),
      'current_boms_after', greatest(coalesce(cu.current_boms, 0) - per.boms_removed, 0),
      'on_hand', case when v_stock then s.on_hand end, 'reserved', case when v_stock then s.reserved end, 'available', case when v_stock then s.available end,
      'open_po_quantity', case when v_po then (
         select coalesce(sum(ll.pending_quantity), 0) from public.purchase_order_line_list ll
         join public.purchase_orders po on po.id = ll.purchase_order_id
         where po.company_id = v_batch.company_id and po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and ll.product_id = p.id) end,
      'open_po_count', case when v_po then (
         select count(distinct po.id) from public.purchase_order_line_list ll
         join public.purchase_orders po on po.id = ll.purchase_order_id
         where po.company_id = v_batch.company_id and po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED') and ll.product_id = p.id
           and ll.pending_quantity > 0) end,
      'consumed_90_days', case when v_mfg then (
         select coalesce(sum(c.actual_quantity), 0) from public.production_material_consumption c
         where c.company_id = v_batch.company_id and c.component_product_id = p.id and c.status = 'POSTED' and c.consumption_date >= v_today - 90) end,
      'open_order_requirement', case when v_mfg then (
         select coalesce(sum(greatest(m.planned_quantity - m.issued_quantity, 0)), 0) from public.production_order_materials m
         join public.production_orders o on o.id = m.production_order_id
         where o.company_id = v_batch.company_id and m.component_product_id = p.id
           and o.status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'ON_HOLD')) end
    ) order by p.sku), '[]'::jsonb)
    into v_comps
  from per join public.products p on p.id = per.product_id
  left join current_use cu on cu.product_id = per.product_id
  cross join lateral private.storage_stock(v_batch.company_id, p.id, null) s;

  return jsonb_build_object(
    'production_orders', v_orders,
    'production_orders_visible', v_mfg,
    'components', v_comps,
    'stock_visible', v_stock,
    'purchases_visible', v_po,
    'effective_from', v_batch.effective_from,
    'note', 'Publishing never changes stock, purchase orders, consumption or existing production orders.');
end;
$$;

revoke all on function private.bom_change_impact(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Search and where-used
-- -----------------------------------------------------------------------------

-- Components by name, SKU, product / model code, barcode or EAN (active and inactive).
create or replace function public.bom_component_search(p_term text, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_term    text := left(btrim(coalesce(p_term, '')), 80);
  v_like    text;
begin
  if v_term = '' then return '[]'::jsonb; end if;
  v_like := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((
    select jsonb_agg(r order by r ->> 'rank', r ->> 'sku')
    from (
      select jsonb_build_object('product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'base_unit', p.base_unit,
        'product_type', p.product_type, 'status', case when p.archived_at is not null then 'ARCHIVED' else p.status end,
        'barcode', p.barcode, 'ean', p.ean, 'model_number', p.model_number, 'supplier_model_number', p.supplier_model_number,
        'bom_lines', (select count(*) from public.bom_items bi join public.boms b on b.id = bi.bom_id
                      where bi.company_id = v_company and bi.component_product_id = p.id and b.status <> 'ARCHIVED'),
        'rank', case when lower(p.sku) = lower(v_term) or p.barcode = v_term or p.ean = v_term then '0' else '1' end) as r
      from public.products p
      where p.company_id = v_company
        and (p.sku ilike v_like or p.product_name ilike v_like or p.model_number ilike v_like or p.supplier_model_number ilike v_like
             or p.barcode = v_term or p.ean = v_term or p.barcode ilike v_like or p.ean ilike v_like)
      order by (lower(p.sku) = lower(v_term) or p.barcode = v_term or p.ean = v_term) desc, p.sku
      limit greatest(1, least(coalesce(p_limit, 20), 50))
    ) s), '[]'::jsonb);
end;
$$;

-- Every BOM version that uses a component, with filters, sorting and paging.
-- p_filters: {status: CURRENT|ACTIVE|SCHEDULED|DRAFT|PENDING_APPROVAL|REJECTED|SUPERSEDED|ARCHIVED|ALL,
--             search: finished product / BOM code, product_type}
create or replace function public.bom_where_used(
  p_component uuid, p_filters jsonb default '{}'::jsonb, p_sort text default 'sku', p_ascending boolean default true,
  p_limit int default 50, p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_today   date := private.company_today(v_company);
  v_status  text := upper(coalesce(nullif(p_filters ->> 'status', ''), 'CURRENT'));
  v_search  text := nullif(btrim(coalesce(p_filters ->> 'search', '')), '');
  v_type    text := nullif(p_filters ->> 'product_type', '');
  v_sort    text := case when p_sort in ('sku', 'product_name', 'bom_code', 'quantity', 'wastage', 'status', 'effective_from', 'unit') then p_sort else 'sku' end;
  v_comp    public.products;
  v_rows    jsonb;
  v_all     jsonb;
  v_total   int;
  v_stats   jsonb;
begin
  if v_status not in ('CURRENT', 'ACTIVE', 'SCHEDULED', 'DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SUPERSEDED', 'ARCHIVED', 'ALL') then
    raise exception 'Unknown status filter %.', v_status using errcode = '22023';
  end if;
  select * into v_comp from public.products where id = p_component and company_id = v_company;
  if not found then
    raise exception 'Component not found in your company.' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(x.row order by
      case when p_ascending then case v_sort when 'sku' then x.k_sku when 'product_name' then lower(x.k_name) when 'bom_code' then x.k_code
        when 'status' then x.k_status when 'unit' then x.k_unit end end asc nulls last,
      case when not p_ascending then case v_sort when 'sku' then x.k_sku when 'product_name' then lower(x.k_name) when 'bom_code' then x.k_code
        when 'status' then x.k_status when 'unit' then x.k_unit end end desc nulls last,
      case when p_ascending then case v_sort when 'quantity' then x.k_qty when 'wastage' then x.k_waste end end asc nulls last,
      case when not p_ascending then case v_sort when 'quantity' then x.k_qty when 'wastage' then x.k_waste end end desc nulls last,
      case when p_ascending then case when v_sort = 'effective_from' then x.k_from end end asc nulls last,
      case when not p_ascending then case when v_sort = 'effective_from' then x.k_from end end desc nulls last,
      x.k_sku, x.k_version desc), '[]'::jsonb)
    into v_all
  from (
    select jsonb_build_object(
        'bom_id', b.id, 'bom_code', b.bom_code, 'version', b.version, 'status', b.status, 'lifecycle', z.lifecycle,
        'is_current', z.is_current, 'effective_from', b.effective_from, 'effective_to', b.effective_to,
        'output_quantity', b.output_quantity, 'output_unit', b.output_unit,
        'finished_product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'product_type', p.product_type,
        'finished_status', case when p.archived_at is not null then 'ARCHIVED' else p.status end,
        'line_no', bi.line_no, 'component_product_id', v_comp.id, 'component_sku', v_comp.sku, 'component_name', v_comp.product_name,
        'quantity', bi.quantity_required, 'unit', bi.unit, 'inventory_unit', v_comp.base_unit, 'unit_matches', bi.unit = v_comp.base_unit,
        'wastage_percentage', bi.wastage_percentage, 'notes', bi.notes, 'source_type', bi.source_type,
        'quantity_per_unit', round(bi.quantity_required / b.output_quantity, 6)) as row,
      p.sku as k_sku, p.product_name as k_name, b.bom_code as k_code, bi.quantity_required as k_qty, bi.wastage_percentage as k_waste,
      z.lifecycle as k_status, b.effective_from as k_from, bi.unit as k_unit, b.version as k_version
    from public.bom_items bi
    join public.boms b on b.id = bi.bom_id
    join public.products p on p.id = b.finished_product_id
    cross join lateral (select private.bom_version_lifecycle(b, v_today) as lifecycle,
      (b.status = 'APPROVED' and b.id = (private.bom_current_revision(b.company_id, b.finished_product_id)).id) as is_current) z
    where bi.company_id = v_company and bi.component_product_id = v_comp.id
      and (v_status = 'ALL'
           or (v_status = 'CURRENT' and z.is_current)
           or (v_status in ('DRAFT', 'PENDING_APPROVAL', 'REJECTED') and b.status = v_status)
           or (v_status in ('ACTIVE', 'SCHEDULED', 'SUPERSEDED', 'ARCHIVED') and z.lifecycle = v_status))
      and (v_type is null or p.product_type = v_type)
      and (v_search is null or p.sku ilike '%' || v_search || '%' or p.product_name ilike '%' || v_search || '%' or b.bom_code ilike '%' || v_search || '%')
  ) x;

  v_total := jsonb_array_length(v_all);
  select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb) into v_rows
  from jsonb_array_elements(v_all) with ordinality e(value, ord)
  where e.ord > greatest(coalesce(p_offset, 0), 0) and e.ord <= greatest(coalesce(p_offset, 0), 0) + greatest(1, least(coalesce(p_limit, 50), 5000));

  select jsonb_build_object(
      'current_boms', count(*) filter (where (e.value ->> 'is_current')::boolean),
      'products', count(distinct e.value ->> 'finished_product_id'),
      'total_quantity_current', coalesce(sum((e.value ->> 'quantity')::numeric) filter (where (e.value ->> 'is_current')::boolean), 0),
      'unit_mismatches', count(*) filter (where not (e.value ->> 'unit_matches')::boolean))
    into v_stats
  from jsonb_array_elements(v_all) e;

  return jsonb_build_object(
    'component', jsonb_build_object('product_id', v_comp.id, 'sku', v_comp.sku, 'product_name', v_comp.product_name, 'base_unit', v_comp.base_unit,
      'product_type', v_comp.product_type, 'status', case when v_comp.archived_at is not null then 'ARCHIVED' else v_comp.status end,
      'barcode', v_comp.barcode, 'ean', v_comp.ean),
    'total', v_total, 'rows', v_rows, 'stats', v_stats);
end;
$$;

-- Finished products (by SKU) with their current BOM revision: used by bulk add and Excel import.
create or replace function public.bom_bulk_resolve_skus(p_skus text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
begin
  if coalesce(array_length(p_skus, 1), 0) > 5000 then
    raise exception 'At most 5000 SKUs at a time.' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('sku_key', k.key, 'product_id', p.id, 'sku', p.sku, 'product_name', p.product_name,
      'base_unit', p.base_unit, 'product_type', p.product_type, 'status', case when p.archived_at is not null then 'ARCHIVED' else p.status end,
      'current_bom_id', cb.id, 'current_bom_code', cb.bom_code, 'current_version', cb.version))
    from (select distinct lower(btrim(s)) as key from unnest(p_skus) s where btrim(coalesce(s, '')) <> '') k
    join public.products p on p.company_id = v_company and lower(p.sku) = k.key
    left join lateral (select (private.bom_current_revision(v_company, p.id)).*) cb on true), '[]'::jsonb);
end;
$$;

-- Finished products with a current BOM revision, for choosing BOMs in bulk add.
create or replace function public.bom_bulk_current_boms(p_search text default null, p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_search  text := nullif(btrim(coalesce(p_search, '')), '');
  v_today   date := private.company_today(v_company);
begin
  return coalesce((
    select jsonb_agg(r order by r ->> 'sku') from (
      select jsonb_build_object('bom_id', b.id, 'bom_code', b.bom_code, 'version', b.version, 'lifecycle', private.bom_version_lifecycle(b, v_today),
        'effective_from', b.effective_from, 'finished_product_id', p.id, 'sku', p.sku, 'product_name', p.product_name,
        'product_type', p.product_type, 'item_count', (select count(*) from public.bom_items i where i.bom_id = b.id)) as r
      from public.boms b join public.products p on p.id = b.finished_product_id
      where b.company_id = v_company and b.status = 'APPROVED'
        and b.version = (select max(x.version) from public.boms x where x.company_id = v_company and x.finished_product_id = b.finished_product_id and x.status = 'APPROVED')
        and (v_search is null or p.sku ilike '%' || v_search || '%' or p.product_name ilike '%' || v_search || '%' or b.bom_code ilike '%' || v_search || '%')
      order by p.sku
      limit greatest(1, least(coalesce(p_limit, 200), 2000))) s), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Batch: save (create / replace the lines of a draft), validate, read
-- p_header: {operation, reason, effective_from, title, merge_duplicates}
-- p_lines:  [{bom_id | finished_product_id, component_product_id, new_component_product_id,
--             quantity, factor, unit, wastage_percentage, notes, source_type}]
-- -----------------------------------------------------------------------------
create or replace function public.bom_change_batch_save(p_batch_id uuid, p_expected_version int, p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_today   date := private.company_today(v_company);
  v_batch   public.bom_change_batches;
  v_op      text := upper(coalesce(p_header ->> 'operation', ''));
  v_reason  text := nullif(btrim(coalesce(p_header ->> 'reason', '')), '');
  v_title   text := nullif(btrim(coalesce(p_header ->> 'title', '')), '');
  v_from    date;
  v_merge   boolean := coalesce((p_header ->> 'merge_duplicates')::boolean, false);
  v_line    jsonb;
  v_no      int := 0;
  v_bom     uuid;
  v_fp      uuid;
  v_input   jsonb;
begin
  begin
    v_from := coalesce(nullif(p_header ->> 'effective_from', '')::date, v_today);
  exception when others then
    raise exception 'The effective date is not a valid date.' using errcode = 'P0001';
  end;
  if v_op not in ('REPLACE', 'DELETE', 'ADD', 'EDIT') then
    raise exception 'Choose the operation: replace, delete, add or edit.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Enter the reason for this change (at least 3 characters): it is kept with every new revision.' using errcode = 'P0001';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The reason is limited to 1000 characters.' using errcode = 'P0001';
  end if;
  if v_title is not null and length(v_title) > 200 then
    raise exception 'The title is limited to 200 characters.' using errcode = 'P0001';
  end if;
  if v_from < v_today then
    raise exception 'The effective date cannot be in the past: earlier production must keep the BOM it was planned with.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one BOM to change.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'A batch can change at most 5000 BOM lines.' using errcode = 'P0001';
  end if;

  if p_batch_id is null then
    insert into public.bom_change_batches (company_id, batch_number, operation, title, reason, effective_from, merge_duplicates, created_by)
    values (v_company, private.next_document_number(v_company, 'BCB'), v_op, v_title, v_reason, v_from, v_merge, auth.uid())
    returning * into v_batch;
  else
    select * into v_batch from public.bom_change_batches where id = p_batch_id and company_id = v_company for update;
    if not found then
      raise exception 'Change batch not found in your company.' using errcode = 'P0001';
    end if;
    if v_batch.status not in ('DRAFT', 'REJECTED') then
      raise exception 'Only a draft or rejected batch can be edited (this one is %).', lower(replace(v_batch.status, '_', ' ')) using errcode = 'P0001';
    end if;
    if v_batch.operation = 'RESTORE' or v_batch.operation <> v_op then
      raise exception 'The operation of a saved batch cannot be changed. Start a new batch.' using errcode = 'P0001';
    end if;
    if p_expected_version is not null and p_expected_version <> v_batch.row_version then
      raise exception 'This batch was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or v_batch.created_by = auth.uid()) then
      raise exception 'You can only edit your own change batches (requires production_bom.update).' using errcode = '42501';
    end if;
    delete from public.bom_change_batch_lines where batch_id = v_batch.id;
    update public.bom_change_batches set title = v_title, reason = v_reason, effective_from = v_from, merge_duplicates = v_merge,
      status = 'DRAFT', row_version = row_version + 1, updated_at = now(), submitted_hash = null
    where id = v_batch.id returning * into v_batch;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    begin
      v_bom := nullif(v_line ->> 'bom_id', '')::uuid;
      v_fp := nullif(v_line ->> 'finished_product_id', '')::uuid;
      v_input := jsonb_strip_nulls(jsonb_build_object('quantity', v_line ->> 'quantity', 'factor', v_line ->> 'factor', 'unit', v_line ->> 'unit',
        'wastage_percentage', v_line ->> 'wastage_percentage', 'source_type', v_line ->> 'source_type'))
        || case when v_line ? 'notes' then jsonb_build_object('notes', v_line -> 'notes') else '{}'::jsonb end;
      if v_bom is null and v_fp is not null then
        v_bom := (private.bom_current_revision(v_company, v_fp)).id;
        if v_bom is null then
          raise exception 'Line %: the finished product has no approved BOM. Create its BOM first.', v_no using errcode = 'P0001';
        end if;
      end if;
      if v_bom is null then
        raise exception 'Line %: choose the BOM.', v_no using errcode = 'P0001';
      end if;
      if (v_line ->> 'component_product_id') is null then
        raise exception 'Line %: choose the component.', v_no using errcode = 'P0001';
      end if;
      if v_op = 'REPLACE' and (v_line ->> 'new_component_product_id') is null then
        raise exception 'Line %: choose the replacement component.', v_no using errcode = 'P0001';
      end if;
      insert into public.bom_change_batch_lines (company_id, batch_id, line_no, action, source_bom_id, component_product_id, new_component_product_id, input)
      values (v_company, v_batch.id, v_no, v_op, v_bom, (v_line ->> 'component_product_id')::uuid,
        case when v_op = 'REPLACE' then (v_line ->> 'new_component_product_id')::uuid end, v_input);
    exception when invalid_text_representation then
      raise exception 'Line %: a BOM or product id is not valid.', v_no using errcode = 'P0001';
    end;
  end loop;

  perform private.bom_change_evaluate(v_batch.id, false);
  select * into v_batch from public.bom_change_batches where id = v_batch.id;
  perform private.bom_change_event(v_batch, case when p_batch_id is null then 'CREATED' else 'EDITED' end, v_reason,
    jsonb_build_object('lines', v_no, 'summary', v_batch.summary - 'products_with_errors'));
  return public.bom_change_batch_get(v_batch.id);
end;
$$;

-- Removes lines from a draft batch (e.g. the BOMs with errors) and re-validates.
create or replace function public.bom_change_batch_remove_lines(p_batch_id uuid, p_expected_version int, p_line_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_batch   public.bom_change_batches;
  v_n       int;
begin
  select * into v_batch from public.bom_change_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  if v_batch.status not in ('DRAFT', 'REJECTED') then
    raise exception 'Lines can only be removed from a draft or rejected batch.' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and p_expected_version <> v_batch.row_version then
    raise exception 'This batch was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  if not (private.has_permission(v_company, 'production_bom.update') or v_batch.created_by = auth.uid()) then
    raise exception 'You can only edit your own change batches (requires production_bom.update).' using errcode = '42501';
  end if;
  delete from public.bom_change_batch_lines where batch_id = v_batch.id and id = any(coalesce(p_line_ids, '{}'));
  get diagnostics v_n = row_count;
  if not exists (select 1 from public.bom_change_batch_lines where batch_id = v_batch.id) then
    raise exception 'A batch needs at least one line: cancel the batch instead.' using errcode = 'P0001';
  end if;
  update public.bom_change_batches set status = 'DRAFT', row_version = row_version + 1, updated_at = now(), submitted_hash = null
  where id = v_batch.id returning * into v_batch;
  perform private.bom_change_evaluate(v_batch.id, false);
  select * into v_batch from public.bom_change_batches where id = v_batch.id;
  perform private.bom_change_event(v_batch, 'EDITED', format('%s line(s) removed.', v_n), jsonb_build_object('removed', v_n));
  return public.bom_change_batch_get(v_batch.id);
end;
$$;

-- Re-checks a batch against the BOMs as they are now (stores the result).
create or replace function public.bom_change_batch_validate(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_status  text;
begin
  select status into v_status from public.bom_change_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  if v_status in ('DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED') then
    perform private.bom_change_evaluate(p_batch_id, false);
  end if;
  return public.bom_change_batch_get(p_batch_id);
end;
$$;

-- One batch with its lines, impact and workflow history. Read-only.
create or replace function public.bom_change_batch_get(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_batch   public.bom_change_batches;
begin
  select * into v_batch from public.bom_change_batches where id = p_batch_id and company_id = v_company;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'batch', to_jsonb(v_batch) || jsonb_build_object(
      'created_by_name', (select full_name from public.profiles where id = v_batch.created_by),
      'submitted_by_name', (select full_name from public.profiles where id = v_batch.submitted_by),
      'approved_by_name', (select full_name from public.profiles where id = v_batch.approved_by),
      'rejected_by_name', (select full_name from public.profiles where id = v_batch.rejected_by),
      'published_by_name', (select full_name from public.profiles where id = v_batch.published_by),
      'restores_batch_number', (select r.batch_number from public.bom_change_batches r where r.id = v_batch.restores_batch_id),
      'stale', v_batch.status = 'PENDING_APPROVAL' and v_batch.submitted_hash is distinct from v_batch.preview_hash),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.bom_change_batch_lines l where l.batch_id = v_batch.id), '[]'::jsonb),
    'impact', case when v_batch.status in ('PUBLISHED', 'CANCELLED') then null else private.bom_change_impact(v_batch.id) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'acted_at', e.acted_at, 'note', e.note, 'details', e.details,
        'actor_name', (select full_name from public.profiles where id = e.actor_id)) order by e.acted_at, e.id)
      from public.bom_change_approvals e where e.batch_id = v_batch.id), '[]'::jsonb),
    'permissions', jsonb_build_object(
      'can_edit', v_batch.status in ('DRAFT', 'REJECTED') and (private.has_permission(v_company, 'production_bom.update')
        or (private.has_permission(v_company, 'production_bom.create') and v_batch.created_by = auth.uid())),
      'can_approve', v_batch.status = 'PENDING_APPROVAL' and private.has_permission(v_company, 'production_bom.approve'),
      'can_publish', v_batch.status = 'APPROVED' and private.has_permission(v_company, 'production_bom.approve')
        and private.has_permission(v_company, 'production_bom.create'),
      'self_approval_blocked', (private.inventory_policy(v_company) ->> 'segregation_of_duties')::boolean
        and auth.uid() in (v_batch.created_by, v_batch.submitted_by)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Workflow: SUBMIT | WITHDRAW | APPROVE | REJECT | CANCEL
-- -----------------------------------------------------------------------------
create or replace function public.bom_change_batch_action(p_batch_id uuid, p_action text, p_note text default null, p_expected_version int default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update', 'production_bom.approve']);
  v_batch   public.bom_change_batches;
  v_action  text := upper(coalesce(p_action, ''));
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_eval    jsonb;
  v_errors  int;
begin
  select * into v_batch from public.bom_change_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and p_expected_version <> v_batch.row_version then
    raise exception 'This batch was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'The note is limited to 1000 characters.' using errcode = 'P0001';
  end if;

  if v_action = 'SUBMIT' then
    if v_batch.status not in ('DRAFT', 'REJECTED') then
      raise exception 'Only a draft or rejected batch can be submitted.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update')
            or (private.has_permission(v_company, 'production_bom.create') and v_batch.created_by = auth.uid())) then
      raise exception 'You are not allowed to submit this batch.' using errcode = '42501';
    end if;
    if v_batch.effective_from < private.company_today(v_company) then
      raise exception 'The effective date % has passed. Edit the batch and choose today or later.', v_batch.effective_from using errcode = 'P0001';
    end if;
    v_eval := private.bom_change_evaluate(v_batch.id, false);
    v_errors := (v_eval -> 'summary' ->> 'lines_with_errors')::int;
    if v_errors > 0 then
      raise exception '% line(s) have validation errors. Correct them or remove those BOMs before submitting.', v_errors using errcode = 'P0001';
    end if;
    update public.bom_change_batches set status = 'PENDING_APPROVAL', submitted_by = auth.uid(), submitted_at = now(),
      submitted_hash = preview_hash, rejected_by = null, rejected_at = null, rejection_reason = null,
      row_version = row_version + 1, updated_at = now(), last_error = null
    where id = v_batch.id returning * into v_batch;
    perform private.bom_change_event(v_batch, 'SUBMITTED', v_note,
      jsonb_build_object('summary', v_batch.summary - 'products_with_errors', 'impact', private.bom_change_impact(v_batch.id)));
    perform private.notify_permission(v_company, 'production_bom.approve', 'APPROVAL_REQUESTED',
      format('BOM change %s awaits approval', v_batch.batch_number),
      format('%s: %s BOM(s), %s line(s), effective %s. Reason: %s', initcap(lower(v_batch.operation)),
        v_batch.summary ->> 'boms', v_batch.summary ->> 'lines', v_batch.effective_from, left(v_batch.reason, 300)),
      'INFO', 'BOM_CHANGE_BATCH', v_batch.id::text, '/production/boms?tab=approvals&batch=' || v_batch.id,
      'bom-change-' || v_batch.id || '-' || v_batch.row_version, auth.uid());

  elsif v_action = 'WITHDRAW' then
    if v_batch.status not in ('PENDING_APPROVAL', 'APPROVED') then
      raise exception 'Only a batch awaiting approval or publishing can be withdrawn.' using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or v_batch.submitted_by = auth.uid() or v_batch.created_by = auth.uid()) then
      raise exception 'You are not allowed to withdraw this batch.' using errcode = '42501';
    end if;
    update public.bom_change_batches set status = 'DRAFT', approved_by = null, approved_at = null, approval_note = null, submitted_hash = null,
      row_version = row_version + 1, updated_at = now()
    where id = v_batch.id returning * into v_batch;
    perform private.bom_change_event(v_batch, 'WITHDRAWN', v_note);

  elsif v_action in ('APPROVE', 'REJECT') then
    perform private.require_permission('production_bom.approve');
    if v_batch.status <> 'PENDING_APPROVAL' then
      raise exception 'This batch is not awaiting approval.' using errcode = 'P0001';
    end if;
    if v_action = 'REJECT' then
      if v_note is null or length(v_note) < 3 then
        raise exception 'Enter the reason for rejecting the batch.' using errcode = 'P0001';
      end if;
      update public.bom_change_batches set status = 'REJECTED', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = v_note,
        submitted_hash = null, row_version = row_version + 1, updated_at = now()
      where id = v_batch.id returning * into v_batch;
      perform private.bom_change_event(v_batch, 'REJECTED', v_note);
      if v_batch.created_by is not null and v_batch.created_by is distinct from auth.uid() then
        perform private.notify(v_company, v_batch.created_by, 'APPROVAL_DECIDED', format('BOM change %s rejected', v_batch.batch_number),
          left(v_note, 500), 'MEDIUM', 'BOM_CHANGE_BATCH', v_batch.id::text, '/production/boms?tab=approvals&batch=' || v_batch.id,
          'bom-change-rejected-' || v_batch.id || '-' || v_batch.row_version);
      end if;
    else
      perform private.assert_not_self_approval(v_company, v_batch.created_by, v_batch.submitted_by);
      v_eval := private.bom_change_evaluate(v_batch.id, false);
      select * into v_batch from public.bom_change_batches where id = v_batch.id;
      if (v_eval -> 'summary' ->> 'lines_with_errors')::int > 0 or v_batch.preview_hash is distinct from v_batch.submitted_hash then
        raise exception 'The BOMs changed after this batch was submitted (or a line no longer validates). Reject it or ask for it to be withdrawn, re-checked and submitted again.'
          using errcode = 'P0001';
      end if;
      update public.bom_change_batches set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), approval_note = v_note,
        row_version = row_version + 1, updated_at = now()
      where id = v_batch.id returning * into v_batch;
      perform private.bom_change_event(v_batch, 'APPROVED', v_note, jsonb_build_object('impact', private.bom_change_impact(v_batch.id)));
    end if;

  elsif v_action = 'CANCEL' then
    if v_batch.status in ('PUBLISHED', 'CANCELLED') then
      raise exception 'A % batch cannot be cancelled.', lower(v_batch.status) using errcode = 'P0001';
    end if;
    if not (private.has_permission(v_company, 'production_bom.update') or private.has_permission(v_company, 'production_bom.approve')
            or v_batch.created_by = auth.uid()) then
      raise exception 'You are not allowed to cancel this batch.' using errcode = '42501';
    end if;
    update public.bom_change_batches set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(),
      row_version = row_version + 1, updated_at = now()
    where id = v_batch.id returning * into v_batch;
    perform private.bom_change_event(v_batch, 'CANCELLED', v_note);
  else
    raise exception 'Unknown action %.', p_action using errcode = 'P0001';
  end if;

  return public.bom_change_batch_get(v_batch.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Publish: all or nothing. Every affected BOM gets its next version with the
--    resulting components, effective from the batch date, approved by the batch
--    approver; the previous version is closed (or superseded) and kept.
-- -----------------------------------------------------------------------------

-- Activates a new version created by a published batch (same rules as
-- production_bom_activate + production_bom_action APPROVE, with the batch's
-- submitter and approver recorded instead of the publisher).
create or replace function private.bom_bulk_activate(p_bom_id uuid, p_batch public.bom_change_batches)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bom    public.boms;
  v_other  public.boms;
  v_closed text[] := '{}';
  v_super  text[] := '{}';
begin
  select * into v_bom from public.boms where id = p_bom_id for update;
  perform private.validate_bom(v_bom);
  for v_other in
    select * from public.boms
    where company_id = v_bom.company_id and finished_product_id = v_bom.finished_product_id and status = 'APPROVED' and id <> v_bom.id
      and effective_from <= coalesce(v_bom.effective_to, 'infinity'::date)
      and coalesce(effective_to, 'infinity'::date) >= v_bom.effective_from
    order by version
    for update
  loop
    if v_other.effective_from >= v_bom.effective_from then
      update public.boms set status = 'ARCHIVED', archived_by = auth.uid(), archived_at = now(),
        review_note = left(format('Superseded by version %s (bulk change %s).', v_bom.version, p_batch.batch_number), 1000)
      where id = v_other.id;
      v_super := v_super || ('v' || v_other.version);
    else
      update public.boms set effective_to = v_bom.effective_from - 1 where id = v_other.id;
      v_closed := v_closed || ('v' || v_other.version);
    end if;
  end loop;
  update public.boms set status = 'APPROVED', submitted_by = p_batch.submitted_by, submitted_at = p_batch.submitted_at,
    approved_by = p_batch.approved_by, approved_at = now(),
    review_note = left(format('Bulk change %s approved%s.', p_batch.batch_number, coalesce(': ' || p_batch.approval_note, '')), 1000)
  where id = v_bom.id;
  return jsonb_build_object('closed_versions', to_jsonb(v_closed), 'superseded_versions', to_jsonb(v_super));
end;
$$;

revoke all on function private.bom_bulk_activate(uuid, public.bom_change_batches) from public, anon, authenticated;

create or replace function public.bom_change_batch_publish(p_batch_id uuid, p_expected_version int default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.approve');
  v_prev    jsonb;
  v_batch   public.bom_change_batches;
  v_eval    jsonb;
  v_src     public.boms;
  v_new     uuid;
  v_ver     int;
  v_items   jsonb;
  v_act     jsonb;
  v_done    jsonb := '[]'::jsonb;
  v_out     jsonb;
  v_reason  text;
  v_to      date;
  v_msg     text;
  v_key     uuid := coalesce(p_idempotency_key, gen_random_uuid());
begin
  perform private.require_permission('production_bom.create');
  v_prev := private.idempotency_begin(v_company, v_key, 'bom_change_publish');
  if v_prev is not null then return v_prev; end if;

  select * into v_batch from public.bom_change_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  if v_batch.status = 'PUBLISHED' then
    return jsonb_build_object('ok', true, 'already_published', true, 'batch', public.bom_change_batch_get(v_batch.id));
  end if;
  if v_batch.status <> 'APPROVED' then
    raise exception 'Only an approved batch can be published (this one is %).', lower(replace(v_batch.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if p_expected_version is not null and p_expected_version <> v_batch.row_version then
    raise exception 'This batch was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  if v_batch.effective_from < private.company_today(v_company) then
    raise exception 'The effective date % has passed. Withdraw the batch, choose today or later and submit it again.', v_batch.effective_from using errcode = 'P0001';
  end if;

  -- Lock the BOMs being changed (in a fixed order) so a concurrent change waits.
  perform 1 from public.boms b
  where b.company_id = v_company and b.finished_product_id in (
    select x.finished_product_id from public.boms x where x.id in (select l.source_bom_id from public.bom_change_batch_lines l where l.batch_id = v_batch.id))
  order by b.id for update;

  v_eval := private.bom_change_evaluate(v_batch.id, true);
  select * into v_batch from public.bom_change_batches where id = v_batch.id;
  if (v_eval -> 'summary' ->> 'lines_with_errors')::int > 0 or v_batch.preview_hash is distinct from v_batch.submitted_hash then
    v_msg := case when (v_eval -> 'summary' ->> 'lines_with_errors')::int > 0
      then format('%s line(s) no longer validate. Nothing was changed.', v_eval -> 'summary' ->> 'lines_with_errors')
      else 'The BOMs changed after approval. Nothing was changed: withdraw the batch, re-check it and submit it again.' end;
    update public.bom_change_batches set last_error = v_msg, updated_at = now() where id = v_batch.id returning * into v_batch;
    perform private.bom_change_event(v_batch, 'PUBLISH_FAILED', v_msg);
    return private.idempotency_finish(v_company, v_key,
      jsonb_build_object('ok', false, 'message', v_msg, 'batch', public.bom_change_batch_get(v_batch.id)));
  end if;

  v_reason := left(format('%s %s: %s', v_batch.batch_number, initcap(lower(v_batch.operation)), v_batch.reason), 500);
  begin
    for v_src in
      select b.* from public.boms b
      where b.id in (select l.source_bom_id from public.bom_change_batch_lines l where l.batch_id = v_batch.id)
      order by b.bom_code
    loop
      v_items := v_eval -> 'boms' -> v_src.id::text;
      v_new := (public.production_new_bom_version(v_src.id, gen_random_uuid()) ->> 'bom_id')::uuid;
      v_to := case when v_src.effective_to is not null and v_src.effective_to >= v_batch.effective_from then v_src.effective_to end;
      perform public.production_save_bom(v_new, v_src.finished_product_id, v_batch.effective_from, v_to, v_src.output_quantity, v_src.notes,
        v_items, gen_random_uuid());
      perform public.bom_version_details_save(v_new, v_reason, v_src.process_instructions);
      v_act := private.bom_bulk_activate(v_new, v_batch);
      select version into v_ver from public.boms where id = v_new;
      update public.bom_change_batch_lines set result_bom_id = v_new, result_version = v_ver
      where batch_id = v_batch.id and source_bom_id = v_src.id;
      perform private.write_audit_log(v_company, 'production.bom_bulk_revision', 'bom', v_new::text,
        jsonb_build_object('batch_number', v_batch.batch_number, 'operation', v_batch.operation, 'bom_code', v_src.bom_code,
          'from_version', v_src.version, 'to_version', v_ver, 'effective_from', v_batch.effective_from, 'reason', v_batch.reason,
          'approved_by', v_batch.approved_by, 'changes', (
            select jsonb_agg(jsonb_build_object('action', l.action, 'component', l.component_sku, 'new_component', l.new_component_sku,
              'old_quantity', l.old_quantity, 'new_quantity', l.new_quantity, 'old_unit', l.old_unit, 'new_unit', l.new_unit,
              'old_wastage', l.old_wastage, 'new_wastage', l.new_wastage) order by l.line_no)
            from (select * from public.bom_change_batch_lines x where x.batch_id = v_batch.id and x.source_bom_id = v_src.id order by x.line_no limit 30) l),
          'change_lines', (select count(*) from public.bom_change_batch_lines x where x.batch_id = v_batch.id and x.source_bom_id = v_src.id))
          || v_act);
      v_done := v_done || jsonb_build_object('bom_code', v_src.bom_code, 'from_version', v_src.version, 'to_version', v_ver, 'bom_id', v_new);
    end loop;
    -- The overlap check normally runs at commit; run it now so a failure is caught here.
    set constraints public.boms_no_overlap immediate;
  exception when others then
    -- Everything in this block (new versions, closed versions) is rolled back.
    get stacked diagnostics v_msg = message_text;
    v_msg := left('Publishing failed and nothing was changed: ' || v_msg, 2000);
    update public.bom_change_batches set last_error = v_msg, updated_at = now() where id = v_batch.id returning * into v_batch;
    perform private.bom_change_event(v_batch, 'PUBLISH_FAILED', v_msg);
    return private.idempotency_finish(v_company, v_key,
      jsonb_build_object('ok', false, 'message', v_msg, 'batch', public.bom_change_batch_get(v_batch.id)));
  end;

  update public.bom_change_batches set status = 'PUBLISHED', published_by = auth.uid(), published_at = now(), last_error = null,
    row_version = row_version + 1, updated_at = now()
  where id = v_batch.id returning * into v_batch;
  perform private.bom_change_event(v_batch, 'PUBLISHED', null, jsonb_build_object('revisions', v_done));
  v_out := jsonb_build_object('ok', true, 'revisions', v_done, 'batch', public.bom_change_batch_get(v_batch.id));
  return private.idempotency_finish(v_company, v_key, v_out);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Reversal: a new draft batch that restores, as a further revision, the
--    components each BOM had before a published batch. Goes through approval.
-- -----------------------------------------------------------------------------
create or replace function public.bom_change_batch_create_reversal(p_batch_id uuid, p_reason text, p_effective_from date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['production_bom.create', 'production_bom.update']);
  v_today   date := private.company_today(v_company);
  v_orig    public.bom_change_batches;
  v_batch   public.bom_change_batches;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_from    date := coalesce(p_effective_from, v_today);
  v_no      int := 0;
  x         record;
begin
  select * into v_orig from public.bom_change_batches where id = p_batch_id and company_id = v_company;
  if not found then
    raise exception 'Change batch not found in your company.' using errcode = 'P0001';
  end if;
  if v_orig.status <> 'PUBLISHED' then
    raise exception 'Only a published batch can be reversed.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Enter the reason for reversing this change.' using errcode = 'P0001';
  end if;
  if v_from < v_today then
    raise exception 'The effective date cannot be in the past.' using errcode = 'P0001';
  end if;
  insert into public.bom_change_batches (company_id, batch_number, operation, title, reason, effective_from, restores_batch_id, created_by)
  values (v_company, private.next_document_number(v_company, 'BCB'), 'RESTORE', left('Reverse ' || v_orig.batch_number, 200),
    left(v_reason, 1000), v_from, v_orig.id, auth.uid())
  returning * into v_batch;
  for x in
    select distinct on (l.source_bom_id) l.source_bom_id, l.result_bom_id
    from public.bom_change_batch_lines l where l.batch_id = v_orig.id and l.result_bom_id is not null
    order by l.source_bom_id
  loop
    v_no := v_no + 1;
    insert into public.bom_change_batch_lines (company_id, batch_id, line_no, action, source_bom_id, restore_from_bom_id)
    values (v_company, v_batch.id, v_no, 'RESTORE', x.result_bom_id, x.source_bom_id);
  end loop;
  perform private.bom_change_evaluate(v_batch.id, false);
  select * into v_batch from public.bom_change_batches where id = v_batch.id;
  perform private.bom_change_event(v_batch, 'CREATED', v_reason, jsonb_build_object('reverses', v_orig.batch_number, 'lines', v_no));
  return public.bom_change_batch_get(v_batch.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Lists: batches (approvals tab) and the BOM revision log
-- -----------------------------------------------------------------------------
create or replace function public.bom_change_batches_list(p_status text default null, p_limit int default 100, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_status  text := nullif(upper(coalesce(p_status, '')), '');
begin
  return jsonb_build_object(
    'total', (select count(*) from public.bom_change_batches b where b.company_id = v_company and (v_status is null or b.status = v_status)),
    'counts', (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
               from (select status, count(*) n from public.bom_change_batches where company_id = v_company group by status) s),
    'rows', coalesce((select jsonb_agg(r order by r ->> 'created_at' desc) from (
      select jsonb_build_object('id', b.id, 'batch_number', b.batch_number, 'operation', b.operation, 'status', b.status, 'title', b.title,
        'reason', b.reason, 'effective_from', b.effective_from, 'summary', b.summary - 'products_with_errors', 'created_at', b.created_at,
        'created_by_name', (select full_name from public.profiles where id = b.created_by),
        'submitted_at', b.submitted_at, 'approved_at', b.approved_at, 'published_at', b.published_at,
        'approved_by_name', (select full_name from public.profiles where id = b.approved_by),
        'stale', b.status = 'PENDING_APPROVAL' and b.submitted_hash is distinct from b.preview_hash,
        'last_error', b.last_error) as r
      from public.bom_change_batches b
      where b.company_id = v_company and (v_status is null or b.status = v_status)
      order by b.created_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(coalesce(p_offset, 0), 0)) s), '[]'::jsonb));
end;
$$;

-- Every BOM version (revision) with who changed it, why and when; bulk changes show their batch.
-- p_filters: {search, source: ALL|BULK|MANUAL, from, to (approval date), product_id}
create or replace function public.bom_revision_log(p_filters jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('production_bom.read');
  v_today   date := private.company_today(v_company);
  v_search  text := nullif(btrim(coalesce(p_filters ->> 'search', '')), '');
  v_source  text := upper(coalesce(nullif(p_filters ->> 'source', ''), 'ALL'));
  v_from    date := nullif(p_filters ->> 'from', '')::date;
  v_to      date := nullif(p_filters ->> 'to', '')::date;
  v_product uuid := nullif(p_filters ->> 'product_id', '')::uuid;
  v_all     jsonb;
begin
  select coalesce(jsonb_agg(x.row order by x.k_at desc, x.k_sku, x.k_version desc), '[]'::jsonb) into v_all
  from (
    select jsonb_build_object('bom_id', b.id, 'bom_code', b.bom_code, 'version', b.version, 'status', b.status,
        'lifecycle', private.bom_version_lifecycle(b, v_today), 'effective_from', b.effective_from, 'effective_to', b.effective_to,
        'finished_product_id', p.id, 'sku', p.sku, 'product_name', p.product_name, 'change_reason', b.change_reason, 'review_note', b.review_note,
        'created_at', b.created_at, 'approved_at', b.approved_at,
        'created_by_name', (select full_name from public.profiles where id = b.created_by),
        'approved_by_name', (select full_name from public.profiles where id = b.approved_by),
        'previous_bom_id', (select pv.id from public.boms pv where pv.company_id = b.company_id and pv.finished_product_id = b.finished_product_id
                            and pv.version < b.version order by pv.version desc limit 1),
        'item_count', (select count(*) from public.bom_items i where i.bom_id = b.id),
        'batch_id', bl.batch_id, 'batch_number', bl.batch_number, 'batch_operation', bl.operation) as row,
      coalesce(b.approved_at, b.created_at) as k_at, p.sku as k_sku, b.version as k_version
    from public.boms b
    join public.products p on p.id = b.finished_product_id
    left join lateral (select l.batch_id, cb.batch_number, cb.operation from public.bom_change_batch_lines l
                       join public.bom_change_batches cb on cb.id = l.batch_id
                       where l.company_id = b.company_id and l.result_bom_id = b.id limit 1) bl on true
    where b.company_id = v_company
      and (v_product is null or b.finished_product_id = v_product)
      and (v_search is null or p.sku ilike '%' || v_search || '%' or p.product_name ilike '%' || v_search || '%' or b.bom_code ilike '%' || v_search || '%'
           or bl.batch_number ilike '%' || v_search || '%' or b.change_reason ilike '%' || v_search || '%')
      and (v_source = 'ALL' or (v_source = 'BULK' and bl.batch_id is not null) or (v_source = 'MANUAL' and bl.batch_id is null))
      and (v_from is null or coalesce(b.approved_at, b.created_at) >= private.company_day_start(v_company, v_from))
      and (v_to is null or coalesce(b.approved_at, b.created_at) < private.company_day_start(v_company, v_to + 1))
  ) x;
  return jsonb_build_object('total', jsonb_array_length(v_all),
    'rows', coalesce((select jsonb_agg(e.value order by e.ord) from jsonb_array_elements(v_all) with ordinality e(value, ord)
      where e.ord > greatest(coalesce(p_offset, 0), 0) and e.ord <= greatest(coalesce(p_offset, 0), 0) + greatest(1, least(coalesce(p_limit, 50), 2000))), '[]'::jsonb));
end;
$$;

do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('bom_component_search', 'bom_where_used', 'bom_bulk_resolve_skus', 'bom_bulk_current_boms',
             'bom_change_batch_save', 'bom_change_batch_remove_lines', 'bom_change_batch_validate', 'bom_change_batch_get',
             'bom_change_batch_action', 'bom_change_batch_publish', 'bom_change_batch_create_reversal', 'bom_change_batches_list',
             'bom_revision_log') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. ERP reset allowlist (20261217090000 plus the three BOM change tables)
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (-2, 'support_call_events', 'Support Centre', 'Call status history'),
    (2, 'support_ticket_escalations', 'Support Centre', 'SLA warnings, breaches and escalations'),
    (3, 'support_ticket_rules', 'Support Centre', 'Ticket automation rules'),
    (3, 'support_business_calendar', 'Support Centre', 'Business hours'),
    (3, 'support_holidays', 'Support Centre', 'Holidays'),
    (3, 'support_sla_escalation_levels', 'Support Centre', 'SLA escalation levels'),
    (3, 'support_assignment_rules', 'Support Centre', 'Ticket assignment rules'),
    (0, 'support_whatsapp_messages', 'Support Centre', 'WhatsApp messages'),
    (0, 'support_whatsapp_statuses', 'Support Centre', 'WhatsApp delivery statuses'),
    (1, 'support_whatsapp_threads', 'Support Centre', 'WhatsApp contacts per conversation'),
    (3, 'support_whatsapp_templates', 'Support Centre', 'WhatsApp templates (from Meta)'),
    (3, 'support_whatsapp_webhook_events', 'Support Centre', 'WhatsApp webhook events'),
    (3, 'support_whatsapp_config', 'Support Centre', 'WhatsApp settings'),
    (0, 'support_email_messages', 'Support Centre', 'Email messages (Gmail)'),
    (1, 'support_email_templates', 'Support Centre', 'Email templates'),
    (3, 'support_email_config', 'Support Centre', 'Email settings'),
    (3, 'support_email_credentials', 'Support Centre', 'Email connection (encrypted)'),
    (3, 'support_oauth_states', 'Support Centre', 'Email authorisation requests'),
    (-1, 'support_calls', 'Support Centre', 'Phone calls'),
    (3, 'support_phone_agents', 'Support Centre', 'Phone agent lines'),
    (3, 'support_phone_config', 'Support Centre', 'Phone settings'),
    (0, 'support_attachments', 'Support Centre', 'Support attachments'),
    (0, 'support_audit_logs', 'Support Centre', 'Support activity log'),
    (0, 'support_automation_rules', 'Support Centre', 'Support automation rules'),
    (0, 'support_conversation_tags', 'Support Centre', 'Support conversation tags'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (4, 'support_agents', 'Support Centre', 'Support agents'),
    (4, 'support_channel_accounts', 'Support Centre', 'Support channel accounts'),
    (4, 'support_customers', 'Support Centre', 'Support customers'),
    (4, 'support_sla_policies', 'Support Centre', 'Support SLA policies'),
    (0, 'amazon_ad_change_requests', 'Amazon', 'Amazon ad change requests'),
    (0, 'amazon_ad_groups', 'Amazon', 'Amazon ad groups'),
    (0, 'amazon_ad_product_daily', 'Amazon', 'Amazon advertised-product daily data'),
    (0, 'amazon_budget_plans', 'Amazon', 'Amazon budget plans'),
    (0, 'amazon_campaign_daily', 'Amazon', 'Amazon campaign daily data'),
    (0, 'amazon_campaigns', 'Amazon', 'Amazon campaigns'),
    (0, 'amazon_inventory_snapshots', 'Amazon', 'Amazon inventory snapshots'),
    (0, 'amazon_listings', 'Amazon', 'Amazon listings'),
    (0, 'amazon_search_term_daily', 'Amazon', 'Amazon search-term daily data'),
    (0, 'amazon_sku_daily', 'Amazon', 'Amazon SKU daily sales'),
    (0, 'amazon_sync_errors', 'Amazon', 'Amazon sync errors'),
    (0, 'amazon_targets', 'Amazon', 'Amazon targets'),
    (0, 'approval_decisions', 'Approvals, notifications & imports', 'Approval decisions'),
    (0, 'billing_events', 'Billing & receivables', 'Billing history'),
    (0, 'bom_items', 'Production & BOMs', 'BOM components'),
    (0, 'bom_template_items', 'Production & BOMs', 'BOM template components'),
    (0, 'bom_cost_snapshots', 'Production & BOMs', 'BOM cost calculations'),
    (0, 'bom_change_batch_lines', 'Production & BOMs', 'Bulk BOM change lines'),
    (0, 'bom_change_approvals', 'Production & BOMs', 'Bulk BOM change approvals and history'),
    (0, 'customer_po_allocation_runs', 'Customer purchase orders', 'Customer PO allocation runs'),
    (0, 'customer_po_analysis_snapshots', 'Customer purchase orders', 'Customer PO analysis snapshots'),
    (0, 'customer_po_events', 'Customer purchase orders', 'Customer PO history'),
    (0, 'customer_po_shortage_notes', 'Customer purchase orders', 'Customer PO shortage notes'),
    (0, 'customer_product_codes', 'Customers & suppliers', 'Customer product codes'),
    (0, 'customer_return_lines', 'Sales & fulfilment', 'Customer return lines'),
    (0, 'delivery_events', 'Sales & fulfilment', 'Delivery history'),
    (0, 'erp_form_drafts', 'Approvals, notifications & imports', 'Unsaved form drafts'),
    (0, 'goods_receipt_lines', 'Supplier purchasing', 'Goods receipt lines'),
    (0, 'import_job_rows', 'Approvals, notifications & imports', 'Import rows'),
    (0, 'inventory_adjustments', 'Inventory', 'Stock adjustments'),
    (0, 'inventory_alerts', 'Inventory', 'Stock alerts'),
    (0, 'inventory_balances', 'Inventory', 'Stock balances'),
    (0, 'inventory_count_lines', 'Inventory', 'Stock count lines'),
    (0, 'inventory_opening_lines', 'Inventory', 'Opening stock lines'),
    (0, 'inventory_requests', 'Inventory', 'Stock operation requests'),
    (0, 'invoice_adjustment_note_lines', 'Billing & receivables', 'Credit / debit note lines'),
    (0, 'invoice_payment_allocations', 'Billing & receivables', 'Payment allocations'),
    (0, 'notifications', 'Approvals, notifications & imports', 'Notifications'),
    (0, 'outsourcing_material_movements', 'Outsourcing', 'Outsourcing material movements'),
    (0, 'outsourcing_order_events', 'Outsourcing', 'Outsourcing history'),
    (0, 'product_last_purchase_costs', 'Supplier purchasing', 'Last purchase costs'),
    (0, 'product_purchase_cost_events', 'Supplier purchasing', 'Purchase cost history'),
    (0, 'product_cost_history', 'Products & catalogue', 'Product cost history'),
    (0, 'product_cost_profiles', 'Products & catalogue', 'Product cost sources'),
    (0, 'production_material_consumption', 'Production & BOMs', 'Material issues'),
    (0, 'production_order_events', 'Production & BOMs', 'Production history'),
    (0, 'production_order_requests', 'Production & BOMs', 'Production order request ids'),
    (0, 'production_output_receipts', 'Production & BOMs', 'Production output'),
    (0, 'purchase_document_refs', 'Supplier purchasing', 'Supplier invoice / challan references'),
    (0, 'purchase_order_amendments', 'Supplier purchasing', 'Purchase order amendments'),
    (0, 'purchase_order_events', 'Supplier purchasing', 'Purchase order history'),
    (0, 'purchase_order_import_refs', 'Supplier purchasing', 'Purchase order import references'),
    (0, 'sales_invoice_dispatch_allocations', 'Billing & receivables', 'Invoice dispatch allocations'),
    (0, 'sales_order_events', 'Sales & fulfilment', 'Sales order history'),
    (1, 'amazon_recommendations', 'Amazon', 'Amazon recommendations'),
    (1, 'amazon_sync_jobs', 'Amazon', 'Amazon sync jobs'),
    (1, 'approval_requests', 'Approvals, notifications & imports', 'Approval requests'),
    (1, 'bom_templates', 'Production & BOMs', 'BOM templates'),
    (1, 'bom_change_batches', 'Production & BOMs', 'Bulk BOM change batches'),
    (1, 'customer_payments', 'Billing & receivables', 'Customer payments'),
    (1, 'supplier_payments', 'Customers & suppliers', 'Supplier payments'),
    (1, 'goods_receipts', 'Supplier purchasing', 'Goods receipts'),
    (1, 'import_jobs', 'Approvals, notifications & imports', 'Import jobs'),
    (1, 'inventory_counts', 'Inventory', 'Stock counts'),
    (1, 'inventory_opening_batches', 'Inventory', 'Opening stock documents'),
    (1, 'invoice_adjustment_notes', 'Billing & receivables', 'Credit / debit notes'),
    (1, 'outsourcing_order_materials', 'Outsourcing', 'Outsourcing material plans'),
    (1, 'outsourcing_receipts', 'Outsourcing', 'Outsourcing receipts'),
    (1, 'production_order_materials', 'Production & BOMs', 'Production material plans'),
    (1, 'purchase_order_lines', 'Supplier purchasing', 'Purchase order lines'),
    (1, 'sales_invoice_lines', 'Billing & receivables', 'Invoice lines'),
    (2, 'customer_returns', 'Sales & fulfilment', 'Customer returns'),
    (2, 'parties', 'Customers & suppliers', 'Ledger parties'),
    (2, 'fulfilment_lines', 'Sales & fulfilment', 'Fulfilment lines'),
    (2, 'outsourcing_orders', 'Outsourcing', 'Outsourcing orders'),
    (2, 'production_orders', 'Production & BOMs', 'Production orders'),
    (2, 'purchase_orders', 'Supplier purchasing', 'Supplier purchase orders'),
    (2, 'sales_invoices', 'Billing & receivables', 'Sales invoices'),
    (3, 'boms', 'Production & BOMs', 'Bills of materials'),
    (3, 'fulfilments', 'Sales & fulfilment', 'Fulfilments and dispatches'),
    (3, 'inventory_transactions', 'Inventory', 'Stock ledger'),
    (3, 'production_order_revisions', 'Production & BOMs', 'Production order revisions'),
    (3, 'sales_order_lines', 'Sales & fulfilment', 'Sales order lines'),
    (3, 'stock_reservations', 'Inventory', 'Stock reservations'),
    (3, 'suppliers', 'Customers & suppliers', 'Suppliers'),
    (4, 'customer_purchase_order_lines', 'Customer purchase orders', 'Customer PO lines'),
    (4, 'inventory_batches', 'Inventory', 'Stock batches / lots'),
    (4, 'sales_orders', 'Sales & fulfilment', 'Sales orders'),
    (5, 'customer_purchase_orders', 'Customer purchase orders', 'Customer purchase orders'),
    (6, 'customer_po_import_batches', 'Customer purchase orders', 'Customer PO import batches'),
    (6, 'customers', 'Customers & suppliers', 'Customers')
  ) t (ord, table_name, category, label)
  union all
  select 0, 'demo_presentation_data', 'Demo data', 'Demo presentation data'
  where exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.demo_presentation_data') and a.attname = 'company_id' and not a.attisdropped);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
