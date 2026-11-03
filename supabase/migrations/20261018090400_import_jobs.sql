-- =============================================================================
-- Phase 10: import history for Bulk Operations
--
-- The existing import paths keep their own validation and commit logic:
--   products       -> Phase 3 client validation + RLS insert (unique SKU / barcode)
--   opening stock  -> Phase 4 inventory_submit_opening_stock (server re-validates)
--   customer POs   -> Phase 6 customer_po_import (server validation, file hash)
-- This migration only RECORDS each run: totals, rejected / duplicate / skipped
-- rows with their messages, and links a retry to the run it retries. Customer
-- PO batches are recorded automatically by a trigger; product and opening
-- stock runs are reported by their pages through import_job_record().
-- A retry re-imports only the rejected rows through the same import page, so
-- the existing duplicate protection (unique SKU, idempotency keys, file hash
-- and "already recorded" checks) prevents successful rows being posted twice.
-- =============================================================================

create table if not exists public.import_jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  import_type      text not null check (import_type in ('PRODUCTS', 'OPENING_STOCK', 'CUSTOMER_PO')),
  client_job_key   uuid not null,
  source_id        uuid,
  source_reference text check (source_reference is null or length(source_reference) <= 100),
  file_name        text check (file_name is null or length(file_name) <= 255),
  file_hash        text check (file_hash is null or file_hash ~ '^[0-9a-f]{64}$'),
  status           text not null check (status in ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'REJECTED')),
  total_rows       integer not null default 0 check (total_rows >= 0),
  success_rows     integer not null default 0 check (success_rows >= 0),
  failed_rows      integer not null default 0 check (failed_rows >= 0),
  duplicate_rows   integer not null default 0 check (duplicate_rows >= 0),
  skipped_rows     integer not null default 0 check (skipped_rows >= 0),
  retry_of_job_id  uuid,
  started_by       uuid,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz not null default now(),
  notes            text check (notes is null or length(notes) <= 1000),
  constraint import_jobs_key_unique unique (company_id, client_job_key),
  constraint import_jobs_id_company_unique unique (id, company_id),
  constraint import_jobs_counts check (success_rows + failed_rows + duplicate_rows + skipped_rows <= total_rows),
  constraint import_jobs_retry_fk foreign key (retry_of_job_id, company_id) references public.import_jobs (id, company_id) on delete restrict
);

create index if not exists import_jobs_company_time_idx on public.import_jobs (company_id, started_at desc);

create table if not exists public.import_job_rows (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  job_id     uuid not null,
  row_number integer not null check (row_number >= 0),
  outcome    text not null check (outcome in ('FAILED', 'DUPLICATE', 'SKIPPED')),
  reference  text check (reference is null or length(reference) <= 200),
  messages   text[] not null default '{}',
  row_data   jsonb not null default '{}'::jsonb check (jsonb_typeof(row_data) = 'object' and pg_column_size(row_data) <= 4096),
  constraint import_job_rows_job_fk foreign key (job_id, company_id) references public.import_jobs (id, company_id) on delete restrict
);

create index if not exists import_job_rows_job_idx on public.import_job_rows (job_id, row_number);

alter table public.import_jobs enable row level security;
alter table public.import_job_rows enable row level security;
revoke all on public.import_jobs, public.import_job_rows from anon, authenticated;
grant select on public.import_jobs, public.import_job_rows to authenticated;

drop policy if exists import_jobs_select on public.import_jobs;
create policy import_jobs_select on public.import_jobs for select to authenticated
  using (company_id = private.current_company_id() and (started_by = auth.uid() or private.has_permission(company_id, 'bulk_operations.read')));
drop policy if exists import_job_rows_select on public.import_job_rows;
create policy import_job_rows_select on public.import_job_rows for select to authenticated
  using (exists (select 1 from public.import_jobs j where j.id = job_id));

-- History rows are written once and never changed.
create or replace function private.prevent_import_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Import history is append-only.' using errcode = '42501';
end;
$$;

drop trigger if exists import_jobs_append_only on public.import_jobs;
create trigger import_jobs_append_only before update or delete on public.import_jobs for each row execute function private.prevent_import_history_mutation();
drop trigger if exists import_job_rows_append_only on public.import_job_rows;
create trigger import_job_rows_append_only before update or delete on public.import_job_rows for each row execute function private.prevent_import_history_mutation();

create or replace function private.import_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCTS' then 'products.import' when 'OPENING_STOCK' then 'inventory_opening.create' when 'CUSTOMER_PO' then 'customer_po.import' end;
$$;

-- Writes one job (idempotent by client_job_key) and its row outcomes.
create or replace function private.import_job_write(p_company uuid, p_user uuid, p_job jsonb, p_rows jsonb)
returns public.import_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job    public.import_jobs;
  v_key    uuid;
  v_failed int := coalesce((p_job ->> 'failed_rows')::int, 0);
  v_status text;
begin
  v_key := (p_job ->> 'client_job_key')::uuid;
  select * into v_job from public.import_jobs where company_id = p_company and client_job_key = v_key;
  if found then
    return v_job;
  end if;
  v_status := case when coalesce(p_job ->> 'status', '') in ('FAILED', 'REJECTED') then p_job ->> 'status'
                   when v_failed > 0 or coalesce((p_job ->> 'duplicate_rows')::int, 0) > 0 then 'COMPLETED_WITH_ERRORS'
                   else 'COMPLETED' end;
  insert into public.import_jobs (company_id, import_type, client_job_key, source_id, source_reference, file_name, file_hash, status, total_rows,
    success_rows, failed_rows, duplicate_rows, skipped_rows, retry_of_job_id, started_by, started_at, completed_at, notes)
  values (p_company, p_job ->> 'import_type', v_key, nullif(p_job ->> 'source_id', '')::uuid, left(p_job ->> 'source_reference', 100),
    left(p_job ->> 'file_name', 255), nullif(p_job ->> 'file_hash', ''), v_status,
    coalesce((p_job ->> 'total_rows')::int, 0), coalesce((p_job ->> 'success_rows')::int, 0), v_failed,
    coalesce((p_job ->> 'duplicate_rows')::int, 0), coalesce((p_job ->> 'skipped_rows')::int, 0), nullif(p_job ->> 'retry_of_job_id', '')::uuid,
    p_user, coalesce(nullif(p_job ->> 'started_at', '')::timestamptz, now()), now(), left(p_job ->> 'notes', 1000))
  returning * into v_job;
  insert into public.import_job_rows (company_id, job_id, row_number, outcome, reference, messages, row_data)
  select p_company, v_job.id, greatest(coalesce((r ->> 'row_number')::int, 0), 0), coalesce(r ->> 'outcome', 'FAILED'), left(r ->> 'reference', 200),
    coalesce(array(select left(m, 500) from jsonb_array_elements_text(coalesce(r -> 'messages', '[]'::jsonb)) m limit 20), '{}'),
    case when jsonb_typeof(r -> 'row_data') = 'object' and pg_column_size(r -> 'row_data') <= 4096 then r -> 'row_data' else '{}'::jsonb end
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  limit 5000;
  perform private.write_audit_log(p_company, 'import.completed', 'import_job', v_job.id::text,
    jsonb_build_object('module', 'bulk_operations', 'result', case when v_status = 'COMPLETED' then 'success' else 'partial' end,
      'import_type', v_job.import_type, 'file_name', v_job.file_name, 'total', v_job.total_rows, 'success', v_job.success_rows,
      'failed', v_job.failed_rows, 'duplicates', v_job.duplicate_rows, 'skipped', v_job.skipped_rows, 'retry_of', v_job.retry_of_job_id));
  if v_job.failed_rows > 0 or v_job.duplicate_rows > 0 or v_status in ('FAILED', 'REJECTED') then
    perform private.notify(p_company, p_user, 'IMPORT_FAILED_ROWS', 'Import finished with rejected rows: ' || coalesce(v_job.file_name, v_job.import_type),
      v_job.failed_rows || ' failed, ' || v_job.duplicate_rows || ' duplicate, ' || v_job.success_rows || ' imported. Download the error report in Bulk Operations.',
      'MEDIUM', 'IMPORT_JOB', v_job.id::text, '/admin/bulk-operations?job=' || v_job.id, 'IMPORT:' || v_job.id);
  end if;
  return v_job;
end;
$$;

revoke all on function private.import_permission(text) from public, anon, authenticated;
revoke all on function private.import_job_write(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;

create or replace function public.import_job_record(p_job jsonb, p_rows jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_type    text := p_job ->> 'import_type';
  v_job     public.import_jobs;
  v_retry   public.import_jobs;
begin
  if v_type not in ('PRODUCTS', 'OPENING_STOCK') then
    raise exception 'Only product and opening-stock runs are recorded here (customer PO imports are recorded automatically).' using errcode = 'P0001';
  end if;
  if v_company is null or not private.has_permission(v_company, private.import_permission(v_type)) then
    raise exception 'You are not allowed to record this import (requires %).', private.import_permission(v_type) using errcode = '42501';
  end if;
  begin
    if (p_job ->> 'client_job_key') is null then
      raise exception using errcode = '22P02';
    end if;
    perform (p_job ->> 'client_job_key')::uuid;
  exception when others then
    raise exception 'A valid import id (client_job_key) is required.' using errcode = 'P0001';
  end;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then
    raise exception 'Row details must be a list of at most 5000 rows.' using errcode = 'P0001';
  end if;
  if (p_job ->> 'retry_of_job_id') is not null then
    select * into v_retry from public.import_jobs where id = (p_job ->> 'retry_of_job_id')::uuid and company_id = v_company;
    if not found or v_retry.import_type <> v_type then
      raise exception 'The import being retried was not found or is of another type.' using errcode = 'P0001';
    end if;
  end if;
  if v_type = 'OPENING_STOCK' and (p_job ->> 'source_id') is not null
     and not exists (select 1 from public.inventory_opening_batches b where b.id = (p_job ->> 'source_id')::uuid and b.company_id = v_company and b.source = 'IMPORT') then
    raise exception 'The opening-stock document was not found in your company.' using errcode = 'P0001';
  end if;
  begin
    v_job := private.import_job_write(v_company, auth.uid(), p_job, p_rows);
  exception
    when check_violation then raise exception 'The row counts do not add up to the total.' using errcode = 'P0001';
    when invalid_text_representation then raise exception 'Counts must be whole numbers.' using errcode = 'P0001';
  end;
  return jsonb_build_object('job_id', v_job.id, 'status', v_job.status);
end;
$$;

revoke all on function public.import_job_record(jsonb, jsonb) from public, anon;
grant execute on function public.import_job_record(jsonb, jsonb) to authenticated;

-- Customer PO batches (Phase 6) are recorded automatically.
create or replace function private.import_job_from_po_batch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'row_number', coalesce(substring(coalesce(e ->> 'source_row_number', e ->> 'row', e ->> 'row_number', '') from '^\d{1,9}$')::int, 0),
      'outcome', 'FAILED',
      'reference', coalesce(e ->> 'sku', e ->> 'uploaded_sku', e ->> 'field'),
      'messages', case when jsonb_typeof(e -> 'errors') = 'array' then e -> 'errors'
                       else jsonb_build_array(coalesce(e ->> 'message', e ->> 'error', e ->> 'reason', 'Rejected')) end,
      'row_data', e)), '[]'::jsonb)
  into v_rows
  from jsonb_array_elements(case when jsonb_typeof(new.error_summary) = 'array' then new.error_summary else '[]'::jsonb end) e;
  -- History must never block the import itself.
  begin
  perform private.import_job_write(new.company_id, new.uploaded_by, jsonb_build_object(
    'import_type', 'CUSTOMER_PO', 'client_job_key', new.id, 'source_id', new.id, 'file_name', new.file_name, 'file_hash', new.file_hash,
    'status', case when new.import_status = 'REJECTED' then 'REJECTED' end,
    'total_rows', greatest(new.rows_read, new.valid_rows + new.invalid_rows),
    'success_rows', case when new.import_status = 'IMPORTED' then new.valid_rows else 0 end,
    'failed_rows', case when new.import_status = 'IMPORTED' then new.invalid_rows else greatest(new.rows_read, new.valid_rows + new.invalid_rows) end,
    'started_at', new.uploaded_at), v_rows);
  exception when others then
    insert into public.error_events (company_id, user_id, correlation_id, source, severity, code, message)
    values (new.company_id, new.uploaded_by, replace(gen_random_uuid()::text, '-', ''), 'db:import_history', 'ERROR', sqlstate,
      left('Could not record PO import history: ' || sqlerrm, 500));
  end;
  return new;
end;
$$;

revoke all on function private.import_job_from_po_batch() from public, anon, authenticated;

drop trigger if exists customer_po_import_batches_history on public.customer_po_import_batches;
create trigger customer_po_import_batches_history after insert on public.customer_po_import_batches
  for each row execute function private.import_job_from_po_batch();
