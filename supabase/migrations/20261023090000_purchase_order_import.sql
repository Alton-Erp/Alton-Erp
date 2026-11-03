-- =============================================================================
-- Supplier purchase orders: Excel / CSV import
--
-- ADDITIVE. Imported orders are created ONLY through the existing
-- public.purchase_order_save() as DRAFT orders, so supplier / product /
-- warehouse checks, GST calculation, numbering, permissions, company isolation,
-- events and audit all stay in one place. Nothing is approved, sent, received
-- or posted to stock by an import.
--
--   purchase_order_import_refs        which import (file, PO reference, rows)
--                                     created which draft. Unique per company,
--                                     supplier and PO reference, so the same
--                                     order cannot be imported twice, even from
--                                     another file.
--   public.purchase_order_import_preview(groups)
--                                     resolves codes in the caller's company and
--                                     DRY-RUNS purchase_order_save() for each
--                                     order (rolled back), returning row errors
--                                     and the server-calculated totals
--   public.purchase_order_import(groups, file, rejected, request id)
--                                     creates the drafts, each order in its own
--                                     subtransaction (all of its lines or none),
--                                     and records the run in import_jobs
--                                     (Bulk Operations history + audit log).
--
-- Existing objects changed (behaviour kept, one value added):
--   import_jobs.import_type          + 'SUPPLIER_PO'
--   private.import_permission()      SUPPLIER_PO -> purchase_order.create
-- =============================================================================

alter table public.import_jobs drop constraint if exists import_jobs_import_type_check;
alter table public.import_jobs add constraint import_jobs_import_type_check
  check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO', 'SUPPLIER_PO'));

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create'
    when 'CUSTOMER_PO' then 'customer_po.import' when 'SUPPLIER_PO' then 'purchase_order.create' end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Import references
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_order_import_refs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  purchase_order_id uuid not null,
  supplier_id       uuid not null,
  import_reference  text not null check (import_reference ~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,49}$'),
  import_key        uuid not null,
  file_name         text check (file_name is null or length(file_name) <= 255),
  file_hash         text check (file_hash is null or file_hash ~ '^[0-9a-f]{64}$'),
  source_rows       integer[] not null default '{}',
  created_by        uuid,
  created_at        timestamptz not null default now(),
  constraint purchase_order_import_refs_po_unique unique (purchase_order_id),
  constraint purchase_order_import_refs_po_fk foreign key (purchase_order_id, company_id) references public.purchase_orders (id, company_id) on delete restrict,
  constraint purchase_order_import_refs_supplier_fk foreign key (supplier_id, company_id) references public.suppliers (id, company_id) on delete restrict
);

create unique index if not exists purchase_order_import_refs_reference_unique
  on public.purchase_order_import_refs (company_id, supplier_id, lower(import_reference));
create index if not exists purchase_order_import_refs_key_idx on public.purchase_order_import_refs (company_id, import_key);

drop trigger if exists purchase_order_import_refs_append_only on public.purchase_order_import_refs;
create trigger purchase_order_import_refs_append_only before update or delete on public.purchase_order_import_refs
  for each row execute function private.prevent_history_mutation();

alter table public.purchase_order_import_refs enable row level security;
revoke all on table public.purchase_order_import_refs from anon, authenticated;
grant select on public.purchase_order_import_refs to authenticated;
grant all on table public.purchase_order_import_refs to service_role;
drop policy if exists purchase_order_import_refs_select on public.purchase_order_import_refs;
create policy purchase_order_import_refs_select on public.purchase_order_import_refs for select to authenticated
  using (private.has_permission(company_id, 'purchases.read'));

-- -----------------------------------------------------------------------------
-- Resolution of one order (group of spreadsheet rows) in the caller's company
--
-- p_group: {reference, header: {supplier_code, supplier_name, supplier_gstin,
--   supplier_state, po_date, expected_delivery_date, warehouse,
--   delivery_instructions, remarks}, rows: [{row_number, sku, product_name,
--   description, quantity, unit, unit_price, discount_percent, gst_rate, and
--   the header fields again}]}
-- Returns {reference, supplier_id, rows, header, lines, errors, warnings};
-- errors / warnings are [{row, message}] with spreadsheet row numbers.
-- Codes are looked up ONLY inside p_company; ids are never taken from the file.
-- -----------------------------------------------------------------------------
create or replace function private.po_import_resolve(p_company uuid, p_group jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ref     text := btrim(coalesce(p_group ->> 'reference', ''));
  v_h       jsonb := coalesce(p_group -> 'header', '{}'::jsonb);
  v_rows    jsonb := p_group -> 'rows';
  v_first   int;
  v_errors  jsonb := '[]'::jsonb;
  v_warn    jsonb := '[]'::jsonb;
  v_sup     public.suppliers;
  v_wh      public.warehouses;
  v_p       public.products;
  v_r       jsonb;
  v_row     int;
  v_rows_out int[] := '{}';
  v_lines   jsonb := '[]'::jsonb;
  v_line    jsonb;
  v_rate    numeric;
  v_text    text;
  v_field   text;
  v_po      text;
  v_rates   numeric[] := array[0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28, 40];
begin
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    return jsonb_build_object('reference', v_ref, 'errors', jsonb_build_array(jsonb_build_object('row', null, 'message', 'The order has no rows.')));
  end if;
  v_first := coalesce((v_rows -> 0 ->> 'row_number')::int, 0);
  if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,49}$' then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message', 'PO Reference must be 1–50 letters, digits, spaces or . _ / -.');
  end if;
  if jsonb_array_length(v_rows) > 200 then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message', format('PO reference %s has %s rows; one order can have at most 200 lines.', v_ref, jsonb_array_length(v_rows)));
  end if;

  -- Supplier (never created by an import)
  select * into v_sup from public.suppliers s where s.company_id = p_company and s.supplier_code = upper(btrim(coalesce(v_h ->> 'supplier_code', '')));
  if not found then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message',
      format('Supplier code "%s" was not found in your company. Add the supplier under Suppliers first; imports never create suppliers.', coalesce(v_h ->> 'supplier_code', '')));
  elsif v_sup.status <> 'ACTIVE' then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message', format('Supplier %s is inactive and cannot be used for new purchase orders.', v_sup.supplier_code));
  else
    v_text := upper(nullif(btrim(coalesce(v_h ->> 'supplier_gstin', '')), ''));
    if v_text is not null and v_text is distinct from v_sup.gstin then
      v_errors := v_errors || jsonb_build_object('row', v_first, 'message',
        format('Supplier GSTIN %s does not match supplier %s (GSTIN on record: %s).', v_text, v_sup.supplier_code, coalesce(v_sup.gstin, 'none')));
    end if;
    v_text := lower(btrim(regexp_replace(coalesce(v_h ->> 'supplier_name', ''), '\s+', ' ', 'g')));
    if v_text <> '' and v_text <> lower(v_sup.legal_name) and v_text <> lower(coalesce(v_sup.display_name, '')) then
      v_warn := v_warn || jsonb_build_object('row', v_first, 'message', format('Supplier name "%s" differs from the name on record for %s (%s). The supplier is matched by code.', v_h ->> 'supplier_name', v_sup.supplier_code, v_sup.legal_name));
    end if;
    v_text := lower(btrim(coalesce(v_h ->> 'supplier_state', '')));
    if v_text <> '' and v_text <> coalesce(coalesce(left(v_sup.gstin, 2), v_sup.state_code), '')
       and v_text <> lower(coalesce(private.gst_state_name(coalesce(left(v_sup.gstin, 2), v_sup.state_code)), '')) then
      v_warn := v_warn || jsonb_build_object('row', v_first, 'message', format('Supplier state "%s" differs from the state on record for %s. GST is decided from the GSTIN on record.', v_h ->> 'supplier_state', v_sup.supplier_code));
    end if;
    select o.po_number into v_po from public.purchase_order_import_refs r join public.purchase_orders o on o.id = r.purchase_order_id
    where r.company_id = p_company and r.supplier_id = v_sup.id and lower(r.import_reference) = lower(v_ref);
    if v_po is not null then
      v_errors := v_errors || jsonb_build_object('row', v_first, 'message',
        format('PO reference %s was already imported for supplier %s as %s. Use a new reference for a new order.', v_ref, v_sup.supplier_code, v_po));
    end if;
  end if;

  -- Delivery warehouse
  select * into v_wh from public.warehouses w where w.company_id = p_company and upper(w.warehouse_code) = upper(btrim(coalesce(v_h ->> 'warehouse', '')));
  if not found then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message', format('Warehouse "%s" was not found in your company (use the warehouse code).', coalesce(v_h ->> 'warehouse', '')));
  elsif v_wh.status <> 'ACTIVE' then
    v_errors := v_errors || jsonb_build_object('row', v_first, 'message', format('Warehouse %s is inactive.', v_wh.warehouse_code));
  end if;

  for v_r in select value from jsonb_array_elements(v_rows) loop
    v_row := coalesce((v_r ->> 'row_number')::int, 0);
    v_rows_out := v_rows_out || v_row;
    v_p := null;
    -- Every row of an order must carry the same order details (or leave them blank).
    foreach v_field in array array['supplier_code', 'po_date', 'expected_delivery_date', 'warehouse', 'delivery_instructions', 'remarks'] loop
      if nullif(btrim(coalesce(v_r ->> v_field, '')), '') is not null
         and upper(btrim(v_r ->> v_field)) is distinct from upper(btrim(coalesce(v_h ->> v_field, ''))) then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'message',
          format('%s differs from the first row of PO reference %s. All rows of one order must have the same order details.', initcap(replace(v_field, '_', ' ')), v_ref));
      end if;
    end loop;
    select * into v_p from public.products p where p.company_id = p_company and lower(p.sku) = lower(btrim(coalesce(v_r ->> 'sku', '')));
    if not found then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'message',
        format('Product code "%s" was not found in your company''s Product Master. Imports never create products.', coalesce(v_r ->> 'sku', '')));
      continue;
    end if;
    if v_p.status <> 'ACTIVE' or v_p.archived_at is not null then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'message', format('Product %s is inactive and cannot be ordered.', v_p.sku));
    end if;
    v_text := upper(nullif(btrim(coalesce(v_r ->> 'unit', '')), ''));
    if v_text is not null and v_text <> v_p.base_unit then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'message', format('Unit %s does not match the product''s unit %s.', v_text, v_p.base_unit));
    end if;
    v_text := lower(btrim(coalesce(v_r ->> 'product_name', '')));
    if v_text <> '' and v_text <> lower(v_p.product_name) then
      v_warn := v_warn || jsonb_build_object('row', v_row, 'message', format('Product name differs from the Product Master for %s (%s). The product is matched by code.', v_p.sku, v_p.product_name));
    end if;
    v_line := jsonb_build_object('line_type', 'GOODS', 'product_id', v_p.id, 'description', nullif(btrim(coalesce(v_r ->> 'description', '')), ''),
      'quantity', v_r -> 'quantity', 'unit_price', v_r -> 'unit_price', 'discount_percent', v_r -> 'discount_percent');
    if nullif(btrim(coalesce(v_r ->> 'gst_rate', '')), '') is not null then
      begin
        v_rate := private.purchase_json_num(v_r, 'gst_rate', 'GST rate');
      exception when others then
        v_rate := -1;
      end;
      if not (v_rate = any(v_rates)) then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'message',
          format('GST rate "%s" is not a rate used by the ERP (%s).', v_r ->> 'gst_rate', array_to_string(v_rates, '%, ') || '%'));
      end if;
      v_line := v_line || jsonb_build_object('gst_rate', v_rate);
    elsif v_p.gst_rate is null then
      v_warn := v_warn || jsonb_build_object('row', v_row, 'message', format('No GST rate given and none set for %s in the Product Master; set it on the draft before submitting.', v_p.sku));
    end if;
    v_lines := v_lines || v_line;
  end loop;

  return jsonb_build_object(
    'reference', v_ref, 'supplier_id', v_sup.id, 'supplier_code', v_sup.supplier_code, 'supplier_name', v_sup.legal_name,
    'warehouse_code', v_wh.warehouse_code, 'rows', to_jsonb(v_rows_out), 'errors', v_errors, 'warnings', v_warn, 'lines', v_lines,
    'header', jsonb_build_object('supplier_id', v_sup.id, 'po_date', nullif(btrim(coalesce(v_h ->> 'po_date', '')), ''),
      'expected_delivery_date', nullif(btrim(coalesce(v_h ->> 'expected_delivery_date', '')), ''), 'warehouse_id', v_wh.id,
      'purchase_type', v_sup.category, 'delivery_instructions', nullif(btrim(coalesce(v_h ->> 'delivery_instructions', '')), ''),
      'internal_notes', nullif(btrim(coalesce(v_h ->> 'remarks', '')), '')));
end;
$$;

-- Turns an error from purchase_order_save into {row, message}: "Line N: ..." maps to the Nth row of the order.
create or replace function private.po_import_error(p_message text, p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'row', coalesce((p_rows ->> (substring(p_message from '^Line ([0-9]{1,3})')::int - 1))::int, (p_rows ->> 0)::int),
    'message', p_message);
$$;

-- Shared input checks for preview and import.
create or replace function private.po_import_check_input(p_groups jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_groups is null or jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) = 0 then
    raise exception 'The file has no purchase orders to import.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_groups) > 100 then
    raise exception 'At most 100 purchase orders can be imported at once (this file has %). Split the file.', jsonb_array_length(p_groups) using errcode = 'P0001';
  end if;
  select coalesce(sum(jsonb_array_length(case when jsonb_typeof(g -> 'rows') = 'array' then g -> 'rows' else '[]'::jsonb end)), 0) into v_rows
  from jsonb_array_elements(p_groups) g;
  if v_rows > 1000 then
    raise exception 'At most 1000 rows can be imported at once (this file has %). Split the file.', v_rows using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function private.po_import_resolve(uuid, jsonb), private.po_import_error(text, jsonb), private.po_import_check_input(jsonb)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Preview: validate and calculate with the real functions, then roll back
-- -----------------------------------------------------------------------------
create or replace function public.purchase_order_import_preview(p_groups jsonb, p_file_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_order.create');
  v_g       jsonb;
  v_res     jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_saved   jsonb;
  v_po      public.purchase_orders;
  v_lines   jsonb;
  v_errors  jsonb;
  v_prev    jsonb;
begin
  perform private.po_import_check_input(p_groups);
  for v_g in select value from jsonb_array_elements(p_groups) loop
    v_res := private.po_import_resolve(v_company, v_g);
    v_errors := coalesce(v_res -> 'errors', '[]'::jsonb);
    v_po := null;
    v_lines := null;
    if jsonb_array_length(v_errors) = 0 then
      begin
        -- Exactly what the import will do; always rolled back (nothing is saved, no number is used).
        v_saved := public.purchase_order_save(null, v_res -> 'header', v_res -> 'lines', null, gen_random_uuid());
        select * into v_po from public.purchase_orders where id = (v_saved ->> 'po_id')::uuid;
        select jsonb_agg(jsonb_build_object('row', (v_res -> 'rows' ->> (l.line_no - 1))::int, 'sku', l.sku, 'unit', l.unit, 'gst_rate', l.gst_rate,
            'gross', l.gross_amount, 'discount', l.discount_amount, 'taxable', l.taxable_value, 'cgst', l.cgst_amount, 'sgst', l.sgst_amount,
            'igst', l.igst_amount, 'total', l.line_total) order by l.line_no)
          into v_lines from public.purchase_order_lines l where l.purchase_order_id = v_po.id;
        raise exception 'PO_IMPORT_DRY_RUN' using errcode = 'P0001';
      exception when others then
        if sqlerrm <> 'PO_IMPORT_DRY_RUN' then
          v_errors := v_errors || private.po_import_error(sqlerrm, v_res -> 'rows');
          v_po := null;
          v_lines := null;
        end if;
      end;
    end if;
    v_out := v_out || jsonb_build_object(
      'reference', v_res -> 'reference', 'supplier_code', v_res -> 'supplier_code', 'supplier_name', v_res -> 'supplier_name',
      'warehouse_code', v_res -> 'warehouse_code', 'rows', v_res -> 'rows', 'ok', jsonb_array_length(v_errors) = 0,
      'errors', v_errors, 'warnings', coalesce(v_res -> 'warnings', '[]'::jsonb),
      'tax_treatment', v_po.tax_treatment, 'lines', v_lines,
      'totals', case when v_po.id is null then null else jsonb_build_object('gross', v_po.gross_total, 'discount', v_po.discount_total,
        'taxable', v_po.taxable_total, 'cgst', v_po.cgst_total, 'sgst', v_po.sgst_total, 'igst', v_po.igst_total,
        'round_off', v_po.round_off, 'grand', v_po.grand_total) end);
  end loop;

  if p_file_hash ~ '^[0-9a-f]{64}$' then
    select jsonb_agg(jsonb_build_object('job_id', j.id, 'started_at', j.started_at, 'success_rows', j.success_rows, 'file_name', j.file_name) order by j.started_at desc)
      into v_prev from public.import_jobs j where j.company_id = v_company and j.import_type = 'SUPPLIER_PO' and j.file_hash = p_file_hash;
  end if;
  return jsonb_build_object('groups', v_out, 'previous_imports', coalesce(v_prev, '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Import: one DRAFT per order, each all-or-nothing; history in import_jobs
-- p_file: {file_name, file_hash, total_rows}
-- p_rejected: rows the browser already rejected (recorded in the history only)
-- -----------------------------------------------------------------------------
create or replace function public.purchase_order_import(p_groups jsonb, p_file jsonb, p_rejected jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_permission('purchase_order.create');
  v_uid      uuid := auth.uid();
  v_previous jsonb;
  v_g        jsonb;
  v_res      jsonb;
  v_saved    jsonb;
  v_errors   jsonb;
  v_created  jsonb := '[]'::jsonb;
  v_failed   jsonb := '[]'::jsonb;
  v_hist     jsonb := '[]'::jsonb;
  v_ok_rows  int := 0;
  v_bad_rows int := 0;
  v_rej      jsonb := case when jsonb_typeof(p_rejected) = 'array' then p_rejected else '[]'::jsonb end;
  v_file     jsonb := coalesce(p_file, '{}'::jsonb);
  v_hash     text;
  v_job      public.import_jobs;
  v_po       public.purchase_orders;
  v_n        int;
begin
  v_previous := private.idempotency_begin(v_company, p_idempotency_key, 'purchase_order_import');
  if v_previous is not null then return v_previous; end if;
  perform private.po_import_check_input(p_groups);
  if jsonb_array_length(v_rej) > 5000 then
    raise exception 'Too many rejected rows reported.' using errcode = 'P0001';
  end if;
  v_hash := case when (v_file ->> 'file_hash') ~ '^[0-9a-f]{64}$' then v_file ->> 'file_hash' end;

  for v_g in select value from jsonb_array_elements(p_groups) loop
    v_res := private.po_import_resolve(v_company, v_g);
    v_errors := coalesce(v_res -> 'errors', '[]'::jsonb);
    v_n := jsonb_array_length(coalesce(v_res -> 'rows', '[]'::jsonb));
    if jsonb_array_length(v_errors) = 0 then
      -- Subtransaction: the order and all its lines are created together or not at all.
      begin
        v_saved := public.purchase_order_save(null, v_res -> 'header', v_res -> 'lines', null,
          md5(p_idempotency_key::text || '|' || lower(v_res ->> 'reference') || '|' || (v_res ->> 'supplier_id'))::uuid);
        insert into public.purchase_order_import_refs (company_id, purchase_order_id, supplier_id, import_reference, import_key, file_name, file_hash, source_rows, created_by)
        values (v_company, (v_saved ->> 'po_id')::uuid, (v_res ->> 'supplier_id')::uuid, v_res ->> 'reference', p_idempotency_key,
          left(v_file ->> 'file_name', 255), v_hash, array(select jsonb_array_elements_text(v_res -> 'rows')::int), v_uid);
        select * into v_po from public.purchase_orders where id = (v_saved ->> 'po_id')::uuid;
        perform private.log_purchase_event(v_company, v_po.id, 'IMPORTED', null, v_po.status,
          format('Imported from %s (PO reference %s)', coalesce(left(v_file ->> 'file_name', 200), 'a spreadsheet'), v_res ->> 'reference'),
          jsonb_build_object('import_key', p_idempotency_key, 'reference', v_res ->> 'reference', 'rows', v_res -> 'rows'));
        v_created := v_created || jsonb_build_object('reference', v_res -> 'reference', 'po_id', v_po.id, 'po_number', v_po.po_number,
          'supplier_code', v_res -> 'supplier_code', 'lines', v_n, 'grand_total', v_po.grand_total, 'tax_treatment', v_po.tax_treatment);
        v_ok_rows := v_ok_rows + v_n;
        continue;
      exception
        when unique_violation then
          v_errors := v_errors || jsonb_build_object('row', (v_res -> 'rows' ->> 0)::int, 'message',
            format('PO reference %s was already imported for this supplier. Use a new reference for a new order.', v_res ->> 'reference'));
        when others then
          v_errors := v_errors || private.po_import_error(sqlerrm, v_res -> 'rows');
      end;
    end if;
    v_failed := v_failed || jsonb_build_object('reference', v_res -> 'reference', 'rows', v_res -> 'rows', 'errors', v_errors);
    v_bad_rows := v_bad_rows + greatest(v_n, 1);
    v_hist := v_hist || coalesce((select jsonb_agg(jsonb_build_object('row_number', coalesce((e ->> 'row')::int, 0), 'outcome', 'FAILED',
      'reference', v_res ->> 'reference', 'messages', jsonb_build_array(e ->> 'message'))) from jsonb_array_elements(v_errors) e), '[]'::jsonb);
  end loop;

  v_hist := v_hist || coalesce((select jsonb_agg(jsonb_build_object('row_number', coalesce((r ->> 'row_number')::int, 0), 'outcome', 'FAILED',
    'reference', left(r ->> 'reference', 200), 'messages', coalesce(r -> 'messages', '[]'::jsonb))) from jsonb_array_elements(v_rej) r), '[]'::jsonb);
  v_bad_rows := v_bad_rows + (select count(distinct (r ->> 'row_number')) from jsonb_array_elements(v_rej) r);

  v_job := private.import_job_write(v_company, v_uid, jsonb_build_object(
    'import_type', 'SUPPLIER_PO', 'client_job_key', p_idempotency_key, 'file_name', left(v_file ->> 'file_name', 255), 'file_hash', v_hash,
    'status', case when jsonb_array_length(v_created) = 0 then 'FAILED' end,
    'total_rows', greatest(coalesce((v_file ->> 'total_rows')::int, 0), v_ok_rows + v_bad_rows),
    'success_rows', v_ok_rows, 'failed_rows', v_bad_rows,
    'notes', format('%s draft purchase order(s) created, %s order(s) not imported.', jsonb_array_length(v_created), jsonb_array_length(v_failed))), v_hist);

  return private.idempotency_finish(v_company, p_idempotency_key, jsonb_build_object(
    'job_id', v_job.id, 'created', v_created, 'failed', v_failed, 'created_count', jsonb_array_length(v_created),
    'failed_count', jsonb_array_length(v_failed), 'imported_rows', v_ok_rows, 'failed_rows', v_bad_rows));
end;
$$;

revoke all on function public.purchase_order_import_preview(jsonb, text), public.purchase_order_import(jsonb, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.purchase_order_import_preview(jsonb, text), public.purchase_order_import(jsonb, jsonb, jsonb, uuid) to authenticated;
