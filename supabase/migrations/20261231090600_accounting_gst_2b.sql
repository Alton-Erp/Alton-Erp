-- =============================================================================
-- Alton Accounts — Phase 5 (Gate C): GSTR-2B import and reconciliation
--
-- Additive. Also tightens two Gate B safeguards:
--   1. ITC maker-checker for every decision. public.purchase_invoice_verify_gst (Phase 3) now only PROPOSES a full ELIGIBLE / INELIGIBLE
--      decision; another user approves it through public.gst_itc_action('APPROVE'), which keeps the Phase 3 voucher identity
--      (PIN / PURCHASE_INVOICE_GST) for a first full decision. Nobody can decide ITC alone through the old RPC.
--   2. Set-off credit availability is qualified: credit accrued by the period end (set-off vouchers excluded) less credit used by posted
--      set-offs (reversed ones excluded), never more than the input ledger balance — never the unqualified ledger balance. The liability
--      summary also shows previous-period outstanding liability and the open current-period liability per head.
--
-- GSTR-2B (Excel / CSV downloaded from the GST portal; no portal / GSTN / JSON integration):
--   private Storage bucket gst-files (CSV / XLSX, 10 MB) with upload prepare / complete RPCs; the original file is never updated or deleted
--   through the API; SHA-256 recomputed server side by the Edge Function gst-2b-verify (service role) and compared with the checksum declared
--   at upload; parsed rows kept with the original cells; validation, duplicate file / row / document detection; supplier document identity
--   (GSTIN, type, number, financial year) with amendment / changed-version history; matching with purchase invoices (auto proposals and
--   manual matches with a reason), maker-checker approval, reversal and an append-only match history; exception reports; audited, short-lived
--   file downloads. Imported data never creates vouchers and never approves ITC: it is shown as evidence in the ITC decision workflow.
--
-- Rollback: supabase/rollback/20261231090600_accounting_gst_2b_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Storage bucket (private) for original GSTR-2B files
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gst-files', 'gst-files', false, 10485760, array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
-- One row per uploaded file. The file details and the server-computed checksum never change (guard).
create table if not exists public.gst_2b_imports (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null,
  registration_id           uuid not null,
  return_period             text not null check (return_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  file_name                 text not null check (length(btrim(file_name)) between 1 and 200),
  file_kind                 text not null check (file_kind in ('CSV', 'XLSX')),
  mime_type                 text not null check (mime_type in ('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  file_size                 bigint not null check (file_size between 1 and 10485760),
  declared_sha256           text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path              text not null,
  status                    text not null default 'PENDING_UPLOAD'
                              check (status in ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'REJECTED', 'COMMITTED', 'DISCARDED', 'EXPIRED')),
  computed_sha256           text check (computed_sha256 is null or computed_sha256 ~ '^[0-9a-f]{64}$'),
  computed_size             bigint,
  verification_token_hash   text,
  verification_expires_at   timestamptz,
  verification_requested_by uuid,
  verified_at               timestamptz,
  rejection_reason          text check (rejection_reason is null or length(rejection_reason) <= 1000),
  parser                    jsonb not null default '{}'::jsonb,
  total_rows                integer not null default 0,
  valid_rows                integer not null default 0,
  error_rows                integer not null default 0,
  duplicate_rows            integer not null default 0,
  uploaded_by               uuid not null,
  created_at                timestamptz not null default now(),
  uploaded_at               timestamptz,
  committed_by              uuid,
  committed_at              timestamptz,
  commit_summary            jsonb not null default '{}'::jsonb,
  status_reason             text check (status_reason is null or length(status_reason) <= 1000),
  row_version               integer not null default 1,
  constraint gst_2b_imports_id_company_unique unique (id, company_id),
  constraint gst_2b_imports_path_unique unique (storage_path),
  constraint gst_2b_imports_registration_fk foreign key (registration_id, company_id) references public.gst_registrations (id, company_id) on delete restrict,
  constraint gst_2b_imports_path check (storage_path = company_id::text || '/gstr2b/' || id::text || case file_kind when 'CSV' then '.csv' else '.xlsx' end),
  constraint gst_2b_imports_kind_mime check ((file_kind = 'CSV') = (mime_type = 'text/csv')),
  constraint gst_2b_imports_verified check (status not in ('VERIFIED', 'COMMITTED')
    or (computed_sha256 = declared_sha256 and computed_size = file_size and verified_at is not null)),
  constraint gst_2b_imports_committed check ((status = 'COMMITTED') = (committed_at is not null))
);
-- The same file (checksum) is never imported twice while an earlier import of it is live.
create unique index if not exists gst_2b_imports_one_file on public.gst_2b_imports (company_id, declared_sha256)
  where status in ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'COMMITTED');
create index if not exists gst_2b_imports_company_idx on public.gst_2b_imports (company_id, created_at desc);

-- Every row read from the file: the original cells as read, the parsed values, validation errors and the in-file duplicate status.
create table if not exists public.gst_2b_lines (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  import_id           uuid not null,
  line_no             integer not null check (line_no >= 1),
  sheet_name          text,
  source_row          integer,
  section             text not null check (section in ('B2B', 'B2BA', 'CDNR', 'CDNRA')),
  original_row        jsonb not null check (jsonb_typeof(original_row) = 'object'),
  supplier_gstin      text,
  supplier_name       text,
  doc_type            text not null check (doc_type in ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  doc_number          text,
  doc_date            date,
  is_amendment        boolean not null default false,
  original_doc_number text,
  original_doc_date   date,
  place_of_supply     text,
  reverse_charge      boolean,
  itc_availability    text check (itc_availability is null or itc_availability in ('YES', 'NO')),
  taxable_value       numeric(18,2),
  igst                numeric(18,2),
  cgst                numeric(18,2),
  sgst                numeric(18,2),
  cess                numeric(18,2),
  identity_number_key text,
  identity_fy         text,
  identity_key        text,
  content_hash        text,
  row_status          text not null check (row_status in ('VALID', 'ERROR', 'DUPLICATE_IN_FILE')),
  errors              jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  duplicate_of_line   integer,
  commit_outcome      text check (commit_outcome is null or commit_outcome in ('NEW', 'AMENDMENT', 'CHANGED', 'DUPLICATE_OF_EARLIER', 'SKIPPED')),
  document_id         uuid,
  version_id          uuid,
  created_at          timestamptz not null default now(),
  constraint gst_2b_lines_unique unique (import_id, line_no),
  constraint gst_2b_lines_import_fk foreign key (import_id, company_id) references public.gst_2b_imports (id, company_id) on delete restrict,
  constraint gst_2b_lines_valid check (row_status = 'ERROR' or (supplier_gstin is not null and doc_number is not null and doc_date is not null
    and identity_key is not null and content_hash is not null and taxable_value is not null and igst is not null and cgst is not null and sgst is not null and cess is not null))
);
create index if not exists gst_2b_lines_identity_idx on public.gst_2b_lines (import_id, identity_key);
create index if not exists gst_2b_lines_document_idx on public.gst_2b_lines (document_id) where document_id is not null;

-- Supplier document identity: registration + supplier GSTIN + type + normalised number + financial year (of the original document).
create table if not exists public.gst_2b_documents (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  registration_id uuid not null,
  supplier_gstin  text not null,
  doc_type        text not null check (doc_type in ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  doc_number_key  text not null check (length(doc_number_key) >= 1),
  doc_fy          text not null check (doc_fy ~ '^[0-9]{4}-[0-9]{2}$'),
  doc_number      text not null,
  supplier_name   text,
  version_count   integer not null default 1 check (version_count >= 1),
  needs_review    boolean not null default false,
  review_reason   text,
  first_import_id uuid not null,
  last_import_id  uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  row_version     integer not null default 1,
  constraint gst_2b_documents_identity unique (registration_id, supplier_gstin, doc_type, doc_number_key, doc_fy),
  constraint gst_2b_documents_id_company_unique unique (id, company_id),
  constraint gst_2b_documents_registration_fk foreign key (registration_id, company_id) references public.gst_registrations (id, company_id) on delete restrict,
  constraint gst_2b_documents_first_fk foreign key (first_import_id, company_id) references public.gst_2b_imports (id, company_id) on delete restrict,
  constraint gst_2b_documents_last_fk foreign key (last_import_id, company_id) references public.gst_2b_imports (id, company_id) on delete restrict
);

-- Versions of a document (insert-only): ORIGINAL, AMENDMENT (B2BA / CDNRA rows) or CHANGED (same identity, different values in a later file).
create table if not exists public.gst_2b_document_versions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  document_id      uuid not null,
  version_no       integer not null check (version_no >= 1),
  version_kind     text not null check (version_kind in ('ORIGINAL', 'AMENDMENT', 'CHANGED')),
  import_id        uuid not null,
  line_id          uuid not null,
  return_period    text not null,
  doc_number       text not null,
  doc_date         date not null,
  taxable_value    numeric(18,2) not null,
  igst             numeric(18,2) not null,
  cgst             numeric(18,2) not null,
  sgst             numeric(18,2) not null,
  cess             numeric(18,2) not null,
  place_of_supply  text,
  reverse_charge   boolean,
  itc_availability text,
  content_hash     text not null,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint gst_2b_versions_unique unique (document_id, version_no),
  constraint gst_2b_versions_id_company_unique unique (id, company_id),
  constraint gst_2b_versions_document_fk foreign key (document_id, company_id) references public.gst_2b_documents (id, company_id) on delete restrict,
  constraint gst_2b_versions_import_fk foreign key (import_id, company_id) references public.gst_2b_imports (id, company_id) on delete restrict,
  constraint gst_2b_versions_line_fk foreign key (line_id) references public.gst_2b_lines (id) on delete restrict
);

-- Matches of a document version with a purchase invoice. One active (proposed / approved) match per document and per invoice.
create table if not exists public.gst_2b_matches (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  registration_id     uuid not null,
  document_id         uuid not null,
  document_version_id uuid not null,
  purchase_invoice_id uuid not null,
  method              text not null check (method in ('AUTO', 'MANUAL')),
  outcome             text not null check (outcome in ('EXACT', 'PARTIAL', 'DATE_MISMATCH', 'TAXABLE_MISMATCH', 'TAX_MISMATCH', 'NUMBER_MISMATCH', 'GSTIN_MISMATCH')),
  mismatches          text[] not null default '{}',
  differences         jsonb not null default '{}'::jsonb,
  tolerance           numeric(18,2) not null default 0,
  status              text not null default 'PROPOSED' check (status in ('PROPOSED', 'APPROVED', 'REJECTED', 'REVERSED', 'SUPERSEDED')),
  reason              text check (reason is null or length(reason) <= 1000),
  proposed_by         uuid not null,
  proposed_at         timestamptz not null default now(),
  decided_by          uuid,
  decided_at          timestamptz,
  decision_note       text check (decision_note is null or length(decision_note) <= 1000),
  reversed_by         uuid,
  reversed_at         timestamptz,
  reversal_reason     text check (reversal_reason is null or length(reversal_reason) <= 1000),
  row_version         integer not null default 1,
  constraint gst_2b_matches_id_company_unique unique (id, company_id),
  constraint gst_2b_matches_document_fk foreign key (document_id, company_id) references public.gst_2b_documents (id, company_id) on delete restrict,
  constraint gst_2b_matches_version_fk foreign key (document_version_id, company_id) references public.gst_2b_document_versions (id, company_id) on delete restrict,
  constraint gst_2b_matches_invoice_fk foreign key (purchase_invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict,
  constraint gst_2b_matches_manual_reason check (method = 'AUTO' or length(btrim(coalesce(reason, ''))) >= 10),
  constraint gst_2b_matches_maker_checker check (status not in ('APPROVED', 'REJECTED', 'REVERSED')
    or (decided_by is not null and decided_at is not null and decided_by <> proposed_by)),
  constraint gst_2b_matches_reversed check ((status = 'REVERSED') = (reversed_by is not null and reversed_at is not null and reversal_reason is not null))
);
create unique index if not exists gst_2b_matches_one_active_document on public.gst_2b_matches (document_id) where status in ('PROPOSED', 'APPROVED');
create unique index if not exists gst_2b_matches_one_active_invoice on public.gst_2b_matches (purchase_invoice_id) where status in ('PROPOSED', 'APPROVED');
create index if not exists gst_2b_matches_company_idx on public.gst_2b_matches (company_id, status);

create table if not exists public.gst_2b_match_history (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  match_id    uuid not null,
  document_id uuid not null,
  action      text not null check (action in ('PROPOSED', 'APPROVED', 'REJECTED', 'REVERSED', 'SUPERSEDED', 'DOCUMENT_CHANGED')),
  reason      text,
  details     jsonb not null default '{}'::jsonb,
  actor_id    uuid,
  created_at  timestamptz not null default now(),
  constraint gst_2b_match_history_match_fk foreign key (match_id, company_id) references public.gst_2b_matches (id, company_id) on delete restrict
);
create index if not exists gst_2b_match_history_match_idx on public.gst_2b_match_history (match_id, created_at);

-- Short-lived, audited download grants for an original file (read through a signed URL while the grant is valid).
create table if not exists public.gst_file_access_grants (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  import_id    uuid not null,
  storage_path text not null,
  granted_to   uuid not null,
  purpose      text not null default 'DOWNLOAD' check (purpose in ('DOWNLOAD')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint gst_file_access_grants_import_fk foreign key (import_id, company_id) references public.gst_2b_imports (id, company_id) on delete restrict
);
create index if not exists gst_file_access_grants_path_idx on public.gst_file_access_grants (storage_path, granted_to, expires_at);

do $$
declare
  t text;
begin
  foreach t in array array['gst_2b_imports', 'gst_2b_lines', 'gst_2b_documents', 'gst_2b_document_versions', 'gst_2b_matches', 'gst_2b_match_history',
                           'gst_file_access_grants'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))', t || '_select', t, 'gst_reconciliation.read');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Guards
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['gst_2b_document_versions', 'gst_2b_match_history', 'gst_file_access_grants'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_insert_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.gst_insert_only_guard()', t || '_insert_only', t);
  end loop;
end;
$$;

-- Imports: the original file details and the computed checksum never change; status moves only forward; never deleted (force reset only).
create or replace function private.gst_2b_import_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mutable text[] := array['status', 'computed_sha256', 'computed_size', 'verification_token_hash', 'verification_expires_at', 'verification_requested_by',
                            'verified_at', 'rejection_reason', 'parser', 'total_rows', 'valid_rows', 'error_rows', 'duplicate_rows', 'uploaded_at',
                            'committed_by', 'committed_at', 'commit_summary', 'status_reason', 'row_version'];
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'GSTR-2B imports are permanent records: they cannot be deleted.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'The original file details of a GSTR-2B import never change.' using errcode = '42501';
  end if;
  if old.computed_sha256 is not null and (new.computed_sha256 is distinct from old.computed_sha256 or new.computed_size is distinct from old.computed_size) then
    raise exception 'The server-computed checksum of a GSTR-2B file never changes.' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       old.status = 'PENDING_UPLOAD' and new.status in ('UPLOADED', 'REJECTED', 'EXPIRED', 'DISCARDED')
    or old.status = 'UPLOADED' and new.status in ('VERIFIED', 'REJECTED', 'DISCARDED')
    or old.status = 'VERIFIED' and new.status in ('COMMITTED', 'DISCARDED')
    or old.status = 'REJECTED' and new.status = 'DISCARDED') then
    raise exception 'A GSTR-2B import cannot move from % to %.', old.status, new.status using errcode = '42501';
  end if;
  if old.status in ('COMMITTED', 'DISCARDED', 'EXPIRED') then
    raise exception 'A % GSTR-2B import cannot be changed.', lower(old.status) using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_2b_import_guard() from public, anon, authenticated;
drop trigger if exists gst_2b_imports_guard on public.gst_2b_imports;
create trigger gst_2b_imports_guard before update or delete on public.gst_2b_imports for each row execute function private.gst_2b_import_guard();

-- Lines: insert-only, except that the commit records its outcome once.
create or replace function private.gst_2b_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_commit text[] := array['commit_outcome', 'document_id', 'version_id'];
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'gst_2b_lines rows are permanent GST history: they cannot be updated or deleted.' using errcode = '42501';
  end if;
  if old.commit_outcome is not null or (to_jsonb(new) - v_commit) <> (to_jsonb(old) - v_commit) then
    raise exception 'gst_2b_lines rows are permanent GST history: they cannot be updated or deleted.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_2b_line_guard() from public, anon, authenticated;
drop trigger if exists gst_2b_lines_guard on public.gst_2b_lines;
create trigger gst_2b_lines_guard before update or delete on public.gst_2b_lines for each row execute function private.gst_2b_line_guard();

-- Documents: the identity never changes; never deleted (force reset only).
create or replace function private.gst_2b_document_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'GSTR-2B documents are permanent records: they cannot be deleted.' using errcode = '42501';
  end if;
  if (new.company_id, new.registration_id, new.supplier_gstin, new.doc_type, new.doc_number_key, new.doc_fy, new.first_import_id)
     is distinct from (old.company_id, old.registration_id, old.supplier_gstin, old.doc_type, old.doc_number_key, old.doc_fy, old.first_import_id) then
    raise exception 'The identity of a GSTR-2B document never changes.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_2b_document_guard() from public, anon, authenticated;
drop trigger if exists gst_2b_documents_guard on public.gst_2b_documents;
create trigger gst_2b_documents_guard before update or delete on public.gst_2b_documents for each row execute function private.gst_2b_document_guard();

-- Matches: what was proposed never changes; status moves PROPOSED → APPROVED / REJECTED / SUPERSEDED, APPROVED → REVERSED; never deleted.
create or replace function private.gst_2b_match_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mutable text[] := array['status', 'decided_by', 'decided_at', 'decision_note', 'reversed_by', 'reversed_at', 'reversal_reason', 'row_version'];
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'GSTR-2B matches are permanent records: they cannot be deleted.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'A GSTR-2B match cannot be changed; reject or reverse it and propose a new one.' using errcode = '42501';
  end if;
  if new.status <> old.status and not (old.status = 'PROPOSED' and new.status in ('APPROVED', 'REJECTED', 'SUPERSEDED') or old.status = 'APPROVED' and new.status = 'REVERSED') then
    raise exception 'A GSTR-2B match cannot move from % to %.', old.status, new.status using errcode = '42501';
  end if;
  if new.status = old.status and old.status <> 'PROPOSED' then
    raise exception 'A % GSTR-2B match cannot be changed.', lower(old.status) using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_2b_match_guard() from public, anon, authenticated;
drop trigger if exists gst_2b_matches_guard on public.gst_2b_matches;
create trigger gst_2b_matches_guard before update or delete on public.gst_2b_matches for each row execute function private.gst_2b_match_guard();

-- -----------------------------------------------------------------------------
-- 4. Storage policies: upload only to the caller's own pending path (1 hour); read only with a valid download grant; no update / delete
-- -----------------------------------------------------------------------------
create or replace function private.gst_file_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.gst_2b_imports m
    where m.storage_path = p_name and m.status = 'PENDING_UPLOAD' and m.uploaded_by = auth.uid()
      and m.company_id = private.current_company_id() and m.created_at > now() - interval '1 hour'
      and private.has_permission(m.company_id, 'gst_reconciliation.manage'));
$$;

create or replace function private.gst_file_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.gst_file_access_grants g
    where g.storage_path = p_name and g.granted_to = auth.uid() and g.expires_at > now()
      and g.company_id = private.current_company_id() and private.has_permission(g.company_id, 'gst_reconciliation.read'));
$$;

revoke all on function private.gst_file_writable(text) from public, anon;
revoke all on function private.gst_file_readable(text) from public, anon;
grant execute on function private.gst_file_writable(text), private.gst_file_readable(text) to authenticated;

drop policy if exists gst_files_objects_select on storage.objects;
create policy gst_files_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'gst-files' and private.gst_file_readable(name));
drop policy if exists gst_files_objects_insert on storage.objects;
create policy gst_files_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'gst-files' and private.gst_file_writable(name));
-- No update or delete policies: an original GSTR-2B file is immutable through the API.

-- -----------------------------------------------------------------------------
-- 5. Parsing and comparison helpers (no floating point: numeric only)
-- -----------------------------------------------------------------------------
-- Normalised document number: letters and digits only, upper case ("inv/01-a" → "INV01A").
create or replace function private.gst_2b_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- GST financial year (April–March) of a date, e.g. 2026-27.
create or replace function private.gst_2b_fy(p date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p is null then null
              when extract(month from p) >= 4 then extract(year from p)::int::text || '-' || lpad(((extract(year from p)::int + 1) % 100)::text, 2, '0')
              else (extract(year from p)::int - 1)::text || '-' || lpad((extract(year from p)::int % 100)::text, 2, '0') end;
$$;

-- Dates as the portal / spreadsheets write them: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD, DD-Mon-YYYY. Null when not a valid date.
create or replace function private.gst_2b_date(p text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p, ''));
  m text[];
begin
  if v = '' then
    return null;
  end if;
  m := regexp_match(v, '^([0-9]{4})-([0-9]{2})-([0-9]{2})$');
  if m is not null then
    return make_date(m[1]::int, m[2]::int, m[3]::int);
  end if;
  m := regexp_match(v, '^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{4})$');
  if m is not null then
    return make_date(m[3]::int, m[2]::int, m[1]::int);
  end if;
  m := regexp_match(v, '^([0-9]{1,2})[-/ ]([A-Za-z]{3})[-/ ]([0-9]{4})$');
  if m is not null then
    return make_date(m[3]::int, array_position(array['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], upper(m[2])), m[1]::int);
  end if;
  return null;
exception
  when others then
    return null;
end;
$$;

-- Amounts: digits with at most 2 decimals; thousands separators and the rupee sign ignored; blank = 0; anything else = null (an error).
create or replace function private.gst_2b_amount(p text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when x = '' then 0 when x ~ '^[0-9]+(\.[0-9]{1,2})?$' then x::numeric else null end
  from (select regexp_replace(coalesce(p, ''), '[,[:space:]₹]', '', 'g') as x) s;
$$;

-- Validates one row read from the file. Returns the parsed values, the identity and an array of errors (empty when valid).
create or replace function private.gst_2b_parse_line(p jsonb, p_own_gstin text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  f        jsonb := case when jsonb_typeof(p -> 'fields') = 'object' then p -> 'fields' else '{}'::jsonb end;
  v_err    text[] := '{}';
  v_sec    text := upper(regexp_replace(coalesce(p ->> 'section', ''), '[^A-Za-z]', '', 'g'));
  v_gstin  text := upper(btrim(coalesce(f ->> 'supplier_gstin', '')));
  v_note   text := upper(regexp_replace(coalesce(nullif(f ->> 'note_type', ''), f ->> 'doc_type', ''), '[^A-Za-z]', '', 'g'));
  v_num    text := btrim(coalesce(f ->> 'doc_number', ''));
  v_date   date := private.gst_2b_date(f ->> 'doc_date');
  v_onum   text := nullif(btrim(coalesce(f ->> 'original_doc_number', '')), '');
  v_odate  date := private.gst_2b_date(f ->> 'original_doc_date');
  v_rc     text := upper(btrim(coalesce(f ->> 'reverse_charge', '')));
  v_itc    text := upper(btrim(coalesce(f ->> 'itc_availability', '')));
  v_type   text;
  v_amend  boolean;
  v_rcb    boolean;
  v_itcv   text;
  v_amts   jsonb := '{}'::jsonb;
  k        text;
  x        numeric;
  v_key    text;
  v_fy     text;
begin
  if v_sec not in ('', 'B2B', 'BB', 'BBA', 'B2BA', 'CDNR', 'CDNRA', 'BCDNR', 'BCDNRA') then
    v_err := v_err || format('Unknown section "%s" (expected B2B, B2BA, B2B-CDNR or B2B-CDNRA).', p ->> 'section');
  end if;
  v_amend := v_sec in ('B2BA', 'BBA', 'CDNRA', 'BCDNRA') or v_onum is not null;
  v_type := case when v_note in ('C', 'CREDITNOTE', 'CREDIT', 'CN') then 'CREDIT_NOTE'
                 when v_note in ('D', 'DEBITNOTE', 'DEBIT', 'DN') then 'DEBIT_NOTE'
                 when v_note in ('', 'INVOICE', 'INV', 'I', 'TAXINVOICE') then 'INVOICE' end;
  if v_type is null then
    v_err := v_err || format('Document type "%s" is not recognised (Invoice, Credit Note or Debit Note).', coalesce(nullif(f ->> 'note_type', ''), f ->> 'doc_type'));
    v_type := 'INVOICE';
  elsif v_type = 'INVOICE' and v_sec in ('CDNR', 'CDNRA', 'BCDNR', 'BCDNRA') then
    v_err := v_err || 'A credit / debit note row needs its note type (Credit Note or Debit Note).'::text;
  end if;
  if v_gstin = '' then
    v_err := v_err || 'Supplier GSTIN is missing.'::text;
  elsif v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    v_err := v_err || format('Supplier GSTIN "%s" is not a valid GSTIN.', v_gstin);
  elsif v_gstin = upper(coalesce(p_own_gstin, '')) then
    v_err := v_err || 'Supplier GSTIN is your own GSTIN.'::text;
  end if;
  if v_num = '' then
    v_err := v_err || 'Document number is missing.'::text;
  elsif length(v_num) > 30 or private.gst_2b_key(v_num) = '' then
    v_err := v_err || format('Document number "%s" is not valid (1–30 characters with letters or digits).', left(v_num, 40));
  end if;
  if v_date is null then
    v_err := v_err || format('Document date "%s" is not a valid date (DD-MM-YYYY).', coalesce(f ->> 'doc_date', ''));
  end if;
  if v_amend and v_onum is null then
    v_err := v_err || 'An amendment row needs the original document number.'::text;
  end if;
  if v_amend and coalesce(f ->> 'original_doc_date', '') <> '' and v_odate is null then
    v_err := v_err || format('Original document date "%s" is not a valid date.', f ->> 'original_doc_date');
  end if;
  foreach k in array array['taxable_value', 'igst', 'cgst', 'sgst', 'cess'] loop
    x := private.gst_2b_amount(f ->> k);
    if x is null then
      v_err := v_err || format('%s "%s" is not a valid amount (digits, at most 2 decimals, not negative).', initcap(replace(k, '_', ' ')), f ->> k);
    end if;
    v_amts := v_amts || jsonb_build_object(k, x);
  end loop;
  if coalesce((v_amts ->> 'igst')::numeric, 0) > 0 and (coalesce((v_amts ->> 'cgst')::numeric, 0) > 0 or coalesce((v_amts ->> 'sgst')::numeric, 0) > 0) then
    v_err := v_err || 'A document carries either IGST or CGST + SGST, not both.'::text;
  end if;
  v_rcb := case when v_rc in ('Y', 'YES', 'TRUE', '1') then true when v_rc in ('', 'N', 'NO', 'FALSE', '0') then false end;
  if v_rcb is null then
    v_err := v_err || format('Reverse charge "%s" must be Y or N.', f ->> 'reverse_charge');
  end if;
  v_itcv := case when v_itc in ('', 'Y', 'YES') then case when v_itc = '' then null else 'YES' end when v_itc in ('N', 'NO') then 'NO' end;
  if v_itc not in ('', 'Y', 'YES', 'N', 'NO') then
    v_err := v_err || format('ITC availability "%s" must be Yes or No.', f ->> 'itc_availability');
  end if;
  v_key := private.gst_2b_key(case when v_amend then v_onum else v_num end);
  v_fy := private.gst_2b_fy(case when v_amend then coalesce(v_odate, v_date) else v_date end);
  return jsonb_build_object(
    'section', case when v_type = 'INVOICE' then 'B2B' else 'CDNR' end || case when v_amend then 'A' else '' end,
    'supplier_gstin', nullif(v_gstin, ''), 'supplier_name', left(nullif(btrim(coalesce(f ->> 'supplier_name', '')), ''), 200),
    'doc_type', v_type, 'doc_number', left(nullif(v_num, ''), 40), 'doc_date', v_date, 'is_amendment', v_amend,
    'original_doc_number', left(v_onum, 40), 'original_doc_date', v_odate, 'place_of_supply', left(nullif(btrim(coalesce(f ->> 'place_of_supply', '')), ''), 60),
    'reverse_charge', coalesce(v_rcb, false), 'itc_availability', v_itcv,
    'identity_number_key', nullif(v_key, ''), 'identity_fy', v_fy,
    'identity_key', case when v_key <> '' and v_fy is not null and v_gstin <> '' then v_gstin || '|' || v_type || '|' || v_key || '|' || v_fy end,
    'content_hash', private.gst_hash(jsonb_build_object('n', private.gst_2b_key(v_num), 'd', v_date, 'a', v_amts, 'p', upper(btrim(coalesce(f ->> 'place_of_supply', ''))),
      'r', coalesce(v_rcb, false), 'i', v_itcv)),
    'errors', to_jsonb(v_err)) || v_amts;
end;
$$;

-- Match tolerance per amount (configuration key gstr2b_match_tolerance, default 1.00, between 0 and 100).
create or replace function private.gst_2b_tolerance(p_company uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select least(greatest(coalesce(case when c.payload ->> 'gstr2b_match_tolerance' ~ '^[0-9]+(\.[0-9]{1,2})?$' then (c.payload ->> 'gstr2b_match_tolerance')::numeric end, 1.00), 0), 100)
                   from public.gst_config_versions c where c.id = (private.gst_config_on(p_company, private.company_today(p_company))).id), 1.00);
$$;

-- Compares a GSTR-2B document version with a purchase invoice: outcome (the most serious difference), every mismatch and the differences.
create or replace function private.gst_2b_compare(v public.gst_2b_document_versions, p_gstin text, i public.purchase_invoices, p_tol numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  mm     text[] := '{}';
  diff   jsonb := '{}'::jsonb;
  h      text;
  a      numeric;
  b      numeric;
  v_near boolean := false;
begin
  if p_gstin is distinct from i.supplier_gstin then
    mm := mm || 'GSTIN'::text;
    diff := diff || jsonb_build_object('supplier_gstin', jsonb_build_object('gstr2b', p_gstin, 'books', i.supplier_gstin));
  end if;
  if private.gst_2b_key(v.doc_number) <> private.gst_2b_key(i.supplier_invoice_number) then
    mm := mm || 'NUMBER'::text;
    diff := diff || jsonb_build_object('doc_number', jsonb_build_object('gstr2b', v.doc_number, 'books', i.supplier_invoice_number));
  end if;
  if v.doc_date is distinct from i.supplier_invoice_date then
    mm := mm || 'DATE'::text;
    diff := diff || jsonb_build_object('doc_date', jsonb_build_object('gstr2b', v.doc_date, 'books', i.supplier_invoice_date));
  end if;
  foreach h in array array['taxable_value', 'igst', 'cgst', 'sgst', 'cess'] loop
    a := case h when 'taxable_value' then v.taxable_value when 'igst' then v.igst when 'cgst' then v.cgst when 'sgst' then v.sgst else v.cess end;
    b := case h when 'taxable_value' then i.taxable_value when 'igst' then i.igst_total when 'cgst' then i.cgst_total when 'sgst' then i.sgst_total else i.cess_total end;
    if a <> b then
      diff := diff || jsonb_build_object(h, jsonb_build_object('gstr2b', a, 'books', b, 'difference', a - b));
      if abs(a - b) > p_tol then
        if h = 'taxable_value' then
          mm := mm || 'TAXABLE'::text;
        elsif not ('TAX' = any (mm)) then
          mm := mm || 'TAX'::text;
        end if;
      else
        v_near := true;
      end if;
    end if;
  end loop;
  if coalesce(v.reverse_charge, false) <> i.reverse_charge then
    diff := diff || jsonb_build_object('reverse_charge', jsonb_build_object('gstr2b', v.reverse_charge, 'books', i.reverse_charge));
  end if;
  return jsonb_build_object('outcome', case when 'GSTIN' = any (mm) then 'GSTIN_MISMATCH' when 'NUMBER' = any (mm) then 'NUMBER_MISMATCH' when 'TAX' = any (mm) then 'TAX_MISMATCH'
      when 'TAXABLE' = any (mm) then 'TAXABLE_MISMATCH' when 'DATE' = any (mm) then 'DATE_MISMATCH' when v_near then 'PARTIAL' else 'EXACT' end,
    'mismatches', to_jsonb(mm), 'differences', diff);
end;
$$;

create or replace function private.gst_2b_current_version(p_document uuid)
returns public.gst_2b_document_versions
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.gst_2b_document_versions where document_id = p_document order by version_no desc limit 1;
$$;

create or replace function private.gst_2b_match_log(m public.gst_2b_matches, p_action text, p_reason text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.gst_2b_match_history (company_id, match_id, document_id, action, reason, details, actor_id)
  values (m.company_id, m.id, m.document_id, p_action, left(p_reason, 1000), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(m.company_id, 'gst.itc_statement_match_' || lower(p_action), 'gst_itc_statement_match', m.id::text,
    jsonb_build_object('document_id', m.document_id, 'purchase_invoice_id', m.purchase_invoice_id, 'outcome', m.outcome, 'status', m.status, 'reason', left(p_reason, 500)));
end;
$$;

-- Proposes a match of the document's current version with an invoice (the caller holds the registration lock).
create or replace function private.gst_2b_propose(d public.gst_2b_documents, i public.purchase_invoices, p_method text, p_reason text)
returns public.gst_2b_matches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   public.gst_2b_document_versions := private.gst_2b_current_version(d.id);
  tol numeric := private.gst_2b_tolerance(d.company_id);
  c   jsonb := private.gst_2b_compare(v, d.supplier_gstin, i, tol);
  m   public.gst_2b_matches;
begin
  insert into public.gst_2b_matches (company_id, registration_id, document_id, document_version_id, purchase_invoice_id, method, outcome, mismatches, differences, tolerance,
    reason, proposed_by)
  values (d.company_id, d.registration_id, d.id, v.id, i.id, p_method, c ->> 'outcome', array(select jsonb_array_elements_text(c -> 'mismatches')), c -> 'differences', tol,
    nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  returning * into m;
  perform private.gst_2b_match_log(m, 'PROPOSED', p_reason, c || jsonb_build_object('method', p_method, 'version_no', v.version_no));
  return m;
exception
  when unique_violation then
    raise exception 'This GSTR-2B document or purchase invoice already has a proposed or approved match.' using errcode = 'P0001';
end;
$$;

create or replace function private.gst_2b_match_json(p_match uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(m) - 'company_id' || jsonb_build_object(
    'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number, 'invoice_status', i.status, 'invoice_gst_status', i.gst_status,
    'supplier_gstin', d.supplier_gstin, 'doc_number', v.doc_number, 'doc_date', v.doc_date, 'version_no', v.version_no, 'doc_type', d.doc_type,
    'is_current_version', v.id = (private.gst_2b_current_version(d.id)).id,
    'proposed_by_name', (select full_name from public.profiles where id = m.proposed_by), 'decided_by_name', (select full_name from public.profiles where id = m.decided_by),
    'history', coalesce((select jsonb_agg(to_jsonb(h) - 'company_id' || jsonb_build_object('by', (select full_name from public.profiles where id = h.actor_id)) order by h.created_at, h.id)
       from public.gst_2b_match_history h where h.match_id = m.id), '[]'::jsonb))
  from public.gst_2b_matches m join public.purchase_invoices i on i.id = m.purchase_invoice_id join public.gst_2b_documents d on d.id = m.document_id
  join public.gst_2b_document_versions v on v.id = m.document_version_id
  where m.id = p_match;
$$;

create or replace function private.gst_2b_import_json(p_import uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(m) - array['company_id', 'verification_token_hash'] || jsonb_build_object(
    'uploaded_by_name', (select full_name from public.profiles where id = m.uploaded_by), 'committed_by_name', (select full_name from public.profiles where id = m.committed_by),
    'bucket', 'gst-files')
  from public.gst_2b_imports m where m.id = p_import;
$$;

-- What a commit would do with the valid rows of an import (computed, nothing written).
create or replace function private.gst_2b_preview(p_import uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select * from public.gst_2b_imports where id = p_import),
       l as (select l.*, d.id as doc_id,
                    exists (select 1 from public.gst_2b_document_versions v where v.document_id = d.id and v.content_hash = l.content_hash) as seen
             from public.gst_2b_lines l cross join m
             left join public.gst_2b_documents d on d.registration_id = m.registration_id and d.supplier_gstin = l.supplier_gstin and d.doc_type = l.doc_type
                  and d.doc_number_key = l.identity_number_key and d.doc_fy = l.identity_fy
             where l.import_id = p_import and l.row_status = 'VALID')
  select jsonb_build_object(
    'new_documents', count(*) filter (where doc_id is null and not (is_amendment and exists (select 1 from l o where o.identity_key = l.identity_key and not o.is_amendment))),
    'amendments', count(*) filter (where is_amendment and not seen and (doc_id is not null or exists (select 1 from l o where o.identity_key = l.identity_key and not o.is_amendment))),
    'changed', count(*) filter (where doc_id is not null and not is_amendment and not seen),
    'already_imported', count(*) filter (where seen),
    'credit_debit_notes', count(*) filter (where doc_type <> 'INVOICE'),
    'vouchers_created', 0, 'itc_approved', 0)
  from l;
$$;

-- GSTR-2B evidence for the ITC decision workflow (read only: it never decides ITC).
create or replace function private.gst_2b_evidence(p_invoice uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('match_id', m.id, 'match_status', m.status, 'outcome', m.outcome, 'method', m.method, 'mismatches', to_jsonb(m.mismatches),
      'differences', m.differences, 'document_id', d.id, 'supplier_gstin', d.supplier_gstin, 'doc_number', v.doc_number, 'doc_date', v.doc_date,
      'return_period', v.return_period, 'itc_availability', v.itc_availability, 'taxable_value', v.taxable_value, 'igst', v.igst, 'cgst', v.cgst, 'sgst', v.sgst, 'cess', v.cess,
      'version_no', v.version_no, 'is_current_version', v.id = (private.gst_2b_current_version(d.id)).id, 'needs_review', d.needs_review, 'decided_at', m.decided_at)
    from public.gst_2b_matches m join public.gst_2b_documents d on d.id = m.document_id join public.gst_2b_document_versions v on v.id = m.document_version_id
    where m.purchase_invoice_id = p_invoice and m.status in ('APPROVED', 'PROPOSED') order by (m.status = 'APPROVED') desc limit 1),
    jsonb_build_object('match_status', 'NOT_MATCHED'))
  || jsonb_build_object('note', 'GSTR-2B is evidence only: ITC is never approved automatically; the ITC decision still needs a proposal and an approval by another user.');
$$;

-- -----------------------------------------------------------------------------
-- 6. Upload, server-side verification, preview, commit
-- -----------------------------------------------------------------------------
create or replace function public.gst_2b_upload_prepare(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  v_reg     public.gst_registrations := private.gst_registration_of(v_company);
  v_name    text := btrim(coalesce(p ->> 'file_name', ''));
  v_ext     text := lower(substring(btrim(coalesce(p ->> 'file_name', '')) from '\.([A-Za-z0-9]+)$'));
  v_mime    text := lower(btrim(coalesce(p ->> 'mime_type', '')));
  v_size    bigint;
  v_sha     text := lower(btrim(coalesce(p ->> 'sha256', '')));
  v_period  text := btrim(coalesce(p ->> 'return_period', ''));
  v_id      uuid := gen_random_uuid();
  v_expect  text;
  d         public.gst_2b_imports;
  m         public.gst_2b_imports;
begin
  if v_name = '' or length(v_name) > 200 or v_name ~ '[/\\[:cntrl:]]' then
    raise exception 'A file name (up to 200 characters, no folders) is required.' using errcode = '22023';
  end if;
  if coalesce(v_ext, '') not in ('csv', 'xlsx') then
    raise exception 'Only CSV or Excel (.xlsx) GSTR-2B files are accepted.' using errcode = '22023';
  end if;
  v_expect := case v_ext when 'csv' then 'text/csv' else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' end;
  if v_mime <> v_expect then
    raise exception 'The file type "%" does not match the .% extension (expected %).', v_mime, v_ext, v_expect using errcode = '22023';
  end if;
  begin
    v_size := (p ->> 'file_size')::bigint;
  exception when others then
    v_size := null;
  end;
  if v_size is null or v_size < 1 or v_size > 10485760 then
    raise exception 'The file must be between 1 byte and 10 MB.' using errcode = '22023';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'The SHA-256 checksum of the file (64 hexadecimal characters) is required.' using errcode = '22023';
  end if;
  if v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'The GSTR-2B return period is required as YYYY-MM.' using errcode = '22023';
  end if;
  -- Uploads never completed within an hour expire (they hold no file).
  update public.gst_2b_imports set status = 'EXPIRED', status_reason = 'Upload not completed within one hour', row_version = row_version + 1
  where company_id = v_company and status = 'PENDING_UPLOAD' and created_at < now() - interval '1 hour';
  select * into d from public.gst_2b_imports where company_id = v_company and declared_sha256 = v_sha and status in ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'COMMITTED') limit 1;
  if found then
    raise exception 'Duplicate file: this file (same SHA-256) was already uploaded on % as "%" (%).', to_char(d.created_at, 'DD-MM-YYYY'), d.file_name, lower(replace(d.status, '_', ' '))
      using errcode = '23505';
  end if;
  insert into public.gst_2b_imports (id, company_id, registration_id, return_period, file_name, file_kind, mime_type, file_size, declared_sha256, storage_path, uploaded_by)
  values (v_id, v_company, v_reg.id, v_period, v_name, upper(v_ext), v_mime, v_size, v_sha, v_company::text || '/gstr2b/' || v_id::text || '.' || v_ext, auth.uid())
  returning * into m;
  perform private.write_audit_log(v_company, 'gst.itc_statement_upload_prepared', 'gst_itc_statement_import', m.id::text,
    jsonb_build_object('file_name', v_name, 'size', v_size, 'sha256', v_sha, 'return_period', v_period));
  return private.gst_2b_import_json(m.id) || jsonb_build_object('upload_expires_at', m.created_at + interval '1 hour');
exception
  when unique_violation then
    raise exception 'Duplicate file: this file (same SHA-256) is already being imported.' using errcode = '23505';
end;
$$;

create or replace function public.gst_2b_upload_complete(p_import_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  m         public.gst_2b_imports;
  v_meta    jsonb;
  v_reason  text;
begin
  select * into m from public.gst_2b_imports where id = p_import_id and company_id = v_company for update;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status <> 'PENDING_UPLOAD' then
    raise exception 'This import is % — only a pending upload can be completed.', lower(replace(m.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if m.uploaded_by <> auth.uid() then
    raise exception 'Only the person who started the upload can complete it.' using errcode = '42501';
  end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'gst-files' and o.name = m.storage_path;
  if not found then
    raise exception 'The file has not been uploaded yet.' using errcode = 'P0001';
  end if;
  v_reason := case
    when v_meta ? 'size' and (v_meta ->> 'size')::bigint <> m.file_size then format('The stored file has %s bytes; %s were declared.', v_meta ->> 'size', m.file_size)
    when v_meta ? 'mimetype' and lower(v_meta ->> 'mimetype') <> m.mime_type then format('The stored file type is %s; %s was declared.', v_meta ->> 'mimetype', m.mime_type) end;
  if v_reason is not null then
    update public.gst_2b_imports set status = 'REJECTED', rejection_reason = v_reason, row_version = row_version + 1 where id = m.id returning * into m;
  else
    update public.gst_2b_imports set status = 'UPLOADED', uploaded_at = now(), row_version = row_version + 1 where id = m.id returning * into m;
  end if;
  perform private.write_audit_log(v_company, 'gst.itc_statement_upload_' || lower(m.status), 'gst_itc_statement_import', m.id::text, jsonb_build_object('reason', v_reason));
  return private.gst_2b_import_json(m.id);
end;
$$;

-- Called by the Edge Function gst-2b-verify with the user's JWT: permission check and a one-time verification token (10 minutes).
create or replace function public.gst_2b_verify_target(p_import_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  m         public.gst_2b_imports;
  v_token   uuid := gen_random_uuid();
begin
  select * into m from public.gst_2b_imports where id = p_import_id and company_id = v_company for update;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status <> 'UPLOADED' then
    raise exception 'This import is % — only an uploaded file is verified.', lower(replace(m.status, '_', ' ')) using errcode = 'P0001';
  end if;
  update public.gst_2b_imports set verification_token_hash = encode(sha256(convert_to(v_token::text, 'UTF8')), 'hex'), verification_expires_at = now() + interval '10 minutes',
    verification_requested_by = auth.uid(), row_version = row_version + 1 where id = m.id;
  return jsonb_build_object('import_id', m.id, 'bucket', 'gst-files', 'storage_path', m.storage_path, 'declared_sha256', m.declared_sha256, 'file_size', m.file_size,
    'mime_type', m.mime_type, 'file_kind', m.file_kind, 'file_name', m.file_name, 'token', v_token);
end;
$$;

-- Service role only (the Edge Function): records the server-computed SHA-256 and size and, when they equal what was declared, the parsed rows.
-- Needs the one-time token issued to a permitted user by gst_2b_verify_target. A mismatch or unreadable file rejects the import.
create or replace function public.gst_2b_verify_record(p_import_id uuid, p_token uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m        public.gst_2b_imports;
  v_reg    public.gst_registrations;
  v_sha    text := lower(coalesce(p ->> 'sha256', ''));
  v_size   bigint;
  v_reason text;
  e        jsonb;
  r        jsonb;
  n        integer := 0;
  v_status text;
  v_dup    integer;
begin
  select * into m from public.gst_2b_imports where id = p_import_id for update;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status <> 'UPLOADED' then
    raise exception 'This import is % — only an uploaded file is verified.', lower(replace(m.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if p_token is null or m.verification_token_hash is null or m.verification_expires_at < now()
     or m.verification_token_hash <> encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex') then
    raise exception 'The verification request is not valid or has expired; start the verification again.' using errcode = '42501';
  end if;
  begin
    v_size := (p ->> 'size')::bigint;
  exception when others then
    v_size := null;
  end;
  v_reason := case
    when v_sha !~ '^[0-9a-f]{64}$' then 'The server could not compute the file checksum.'
    when v_sha <> m.declared_sha256 then format('Checksum mismatch: the stored file has SHA-256 %s but %s was declared at upload — the file was changed or corrupted.', v_sha, m.declared_sha256)
    when v_size is distinct from m.file_size then format('Size mismatch: the stored file has %s bytes; %s were declared.', coalesce(v_size::text, 'an unknown number of'), m.file_size)
    when not coalesce((p ->> 'ok')::boolean, false) then coalesce(nullif(left(btrim(p ->> 'reason'), 900), ''), 'The file could not be read.')
    when jsonb_typeof(p -> 'rows') is distinct from 'array' or jsonb_array_length(p -> 'rows') = 0 then 'No GSTR-2B document rows were found (sheets / sections B2B, B2BA, B2B-CDNR, B2B-CDNRA).'
    when jsonb_array_length(p -> 'rows') > 20000 then 'The file has more than 20,000 document rows; import one return period per file.' end;
  if v_reason is not null then
    update public.gst_2b_imports set status = 'REJECTED', rejection_reason = left(v_reason, 1000),
      computed_sha256 = case when v_sha ~ '^[0-9a-f]{64}$' then v_sha end, computed_size = v_size, verified_at = now(),
      verification_token_hash = null, verification_expires_at = null, parser = coalesce(p -> 'parser', '{}'::jsonb), row_version = row_version + 1
    where id = m.id returning * into m;
    perform private.write_audit_log(m.company_id, 'gst.itc_statement_verification_rejected', 'gst_itc_statement_import', m.id::text,
      jsonb_build_object('reason', v_reason, 'requested_by', m.verification_requested_by, 'computed_sha256', m.computed_sha256));
    return private.gst_2b_import_json(m.id);
  end if;
  select * into v_reg from public.gst_registrations where id = m.registration_id;
  for e in select x from jsonb_array_elements(p -> 'rows') x loop
    n := n + 1;
    r := private.gst_2b_parse_line(e, v_reg.gstin);
    if jsonb_typeof(e -> 'original') is distinct from 'object' then
      r := jsonb_set(r, '{errors}', (r -> 'errors') || '["The original row is missing."]'::jsonb);
    end if;
    v_status := case when jsonb_array_length(r -> 'errors') > 0 then 'ERROR' else 'VALID' end;
    v_dup := null;
    if v_status = 'VALID' then
      select line_no into v_dup from public.gst_2b_lines where import_id = m.id and identity_key = r ->> 'identity_key'
        and is_amendment = (r ->> 'is_amendment')::boolean and row_status = 'VALID' order by line_no limit 1;
      if v_dup is not null then
        v_status := 'DUPLICATE_IN_FILE';
      end if;
    end if;
    insert into public.gst_2b_lines (company_id, import_id, line_no, sheet_name, source_row, section, original_row, supplier_gstin, supplier_name, doc_type, doc_number,
      doc_date, is_amendment, original_doc_number, original_doc_date, place_of_supply, reverse_charge, itc_availability, taxable_value, igst, cgst, sgst, cess,
      identity_number_key, identity_fy, identity_key, content_hash, row_status, errors, duplicate_of_line)
    values (m.company_id, m.id, n, left(e ->> 'sheet', 60), case when e ->> 'row_no' ~ '^[0-9]{1,7}$' then (e ->> 'row_no')::int end, r ->> 'section',
      case when jsonb_typeof(e -> 'original') = 'object' then e -> 'original' else '{}'::jsonb end,
      r ->> 'supplier_gstin', r ->> 'supplier_name', r ->> 'doc_type', r ->> 'doc_number', (r ->> 'doc_date')::date, (r ->> 'is_amendment')::boolean,
      r ->> 'original_doc_number', (r ->> 'original_doc_date')::date, r ->> 'place_of_supply', (r ->> 'reverse_charge')::boolean, r ->> 'itc_availability',
      (r ->> 'taxable_value')::numeric, (r ->> 'igst')::numeric, (r ->> 'cgst')::numeric, (r ->> 'sgst')::numeric, (r ->> 'cess')::numeric,
      r ->> 'identity_number_key', r ->> 'identity_fy', r ->> 'identity_key', r ->> 'content_hash', v_status,
      case when v_status = 'DUPLICATE_IN_FILE' then jsonb_build_array(format('The same document appears earlier in this file (row %s).', v_dup)) else r -> 'errors' end, v_dup);
  end loop;
  update public.gst_2b_imports set status = 'VERIFIED', computed_sha256 = v_sha, computed_size = v_size, verified_at = now(),
    verification_token_hash = null, verification_expires_at = null, parser = coalesce(p -> 'parser', '{}'::jsonb), total_rows = n,
    valid_rows = (select count(*) from public.gst_2b_lines where import_id = m.id and row_status = 'VALID'),
    error_rows = (select count(*) from public.gst_2b_lines where import_id = m.id and row_status = 'ERROR'),
    duplicate_rows = (select count(*) from public.gst_2b_lines where import_id = m.id and row_status = 'DUPLICATE_IN_FILE'), row_version = row_version + 1
  where id = m.id returning * into m;
  perform private.write_audit_log(m.company_id, 'gst.itc_statement_verified', 'gst_itc_statement_import', m.id::text,
    jsonb_build_object('sha256', v_sha, 'rows', n, 'errors', m.error_rows, 'duplicates', m.duplicate_rows, 'requested_by', m.verification_requested_by));
  return private.gst_2b_import_json(m.id);
end;
$$;

create or replace function public.gst_2b_imports_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
begin
  return coalesce((select jsonb_agg(private.gst_2b_import_json(m.id) order by m.created_at desc) from (
    select id, created_at from public.gst_2b_imports m where m.company_id = v_company
      and (nullif(p_filters ->> 'status', '') is null or m.status = upper(p_filters ->> 'status'))
      and (nullif(p_filters ->> 'return_period', '') is null or m.return_period = p_filters ->> 'return_period')
    order by m.created_at desc limit 200) m), '[]'::jsonb);
end;
$$;

-- Import preview: the import, what a commit would do, and the rows (original cells, parsed values, errors) — filtered and paged.
create or replace function public.gst_2b_import_get(p_import_id uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
  v_limit   integer := least(greatest(coalesce(nullif(p_filters ->> 'limit', '')::int, 200), 1), 1000);
  v_offset  integer := greatest(coalesce(nullif(p_filters ->> 'offset', '')::int, 0), 0);
  v_status  text := nullif(upper(coalesce(p_filters ->> 'row_status', '')), '');
begin
  if not exists (select 1 from public.gst_2b_imports where id = p_import_id and company_id = v_company) then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  return private.gst_2b_import_json(p_import_id) || jsonb_build_object(
    'preview', private.gst_2b_preview(p_import_id),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'company_id' order by l.line_no) from (
       select * from public.gst_2b_lines where import_id = p_import_id and (v_status is null or row_status = v_status)
       order by line_no limit v_limit offset v_offset) l), '[]'::jsonb),
    'line_count', (select count(*) from public.gst_2b_lines where import_id = p_import_id and (v_status is null or row_status = v_status)));
end;
$$;

create or replace function public.gst_2b_import_discard(p_import_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  m         public.gst_2b_imports;
begin
  select * into m from public.gst_2b_imports where id = p_import_id and company_id = v_company for update;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status not in ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'REJECTED') then
    raise exception 'This import is % — only an import not yet committed can be discarded.', lower(m.status) using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  update public.gst_2b_imports set status = 'DISCARDED', status_reason = left(btrim(p_reason), 1000), verification_token_hash = null, row_version = row_version + 1
  where id = m.id returning * into m;
  perform private.write_audit_log(v_company, 'gst.itc_statement_discarded', 'gst_itc_statement_import', m.id::text, jsonb_build_object('reason', p_reason));
  return private.gst_2b_import_json(m.id);
end;
$$;

-- Commit: valid rows become supplier documents / versions (new, amendment, changed) or are recognised as already imported.
-- Never posts a voucher and never changes an ITC decision.
create or replace function public.gst_2b_import_commit(p_import_id uuid, p_accept_errors boolean default false, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  m         public.gst_2b_imports;
  l         public.gst_2b_lines;
  d         public.gst_2b_documents;
  cv        public.gst_2b_document_versions;
  v_ver     uuid;
  v_out     text;
  mt        public.gst_2b_matches;
  v_counts  jsonb := '{"NEW": 0, "AMENDMENT": 0, "CHANGED": 0, "DUPLICATE_OF_EARLIER": 0, "SKIPPED": 0}'::jsonb;
  v_super   integer := 0;
  v_review  integer := 0;
begin
  select * into m from public.gst_2b_imports where id = p_import_id and company_id = v_company for update;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status <> 'VERIFIED' then
    raise exception 'This import is % — only a file verified on the server (checksum and rows) can be imported.', lower(replace(m.status, '_', ' ')) using errcode = 'P0001';
  end if;
  if p_row_version is not null and m.row_version <> p_row_version then
    raise exception 'This import was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  if m.error_rows > 0 and not coalesce(p_accept_errors, false) then
    raise exception '% row(s) have errors. Review them in the preview and confirm that only the valid rows are imported.', m.error_rows using errcode = 'P0001';
  end if;
  if m.valid_rows = 0 then
    raise exception 'There are no valid rows to import.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_2b:' || m.registration_id::text, 0));
  for l in select * from public.gst_2b_lines where import_id = m.id and row_status = 'VALID' order by is_amendment, line_no loop
    select * into d from public.gst_2b_documents where registration_id = m.registration_id and supplier_gstin = l.supplier_gstin and doc_type = l.doc_type
      and doc_number_key = l.identity_number_key and doc_fy = l.identity_fy for update;
    if not found then
      insert into public.gst_2b_documents (company_id, registration_id, supplier_gstin, doc_type, doc_number_key, doc_fy, doc_number, supplier_name, first_import_id, last_import_id)
      values (m.company_id, m.registration_id, l.supplier_gstin, l.doc_type, l.identity_number_key, l.identity_fy, l.doc_number, l.supplier_name, m.id, m.id) returning * into d;
      insert into public.gst_2b_document_versions (company_id, document_id, version_no, version_kind, import_id, line_id, return_period, doc_number, doc_date, taxable_value,
        igst, cgst, sgst, cess, place_of_supply, reverse_charge, itc_availability, content_hash, created_by)
      values (m.company_id, d.id, 1, case when l.is_amendment then 'AMENDMENT' else 'ORIGINAL' end, m.id, l.id, m.return_period, l.doc_number, l.doc_date, l.taxable_value,
        l.igst, l.cgst, l.sgst, l.cess, l.place_of_supply, l.reverse_charge, l.itc_availability, l.content_hash, auth.uid()) returning id into v_ver;
      v_out := case when l.is_amendment then 'AMENDMENT' else 'NEW' end;
    else
      select * into cv from public.gst_2b_document_versions where document_id = d.id and content_hash = l.content_hash order by version_no desc limit 1;
      if found then
        v_out := 'DUPLICATE_OF_EARLIER';
        v_ver := cv.id;
      else
        cv := private.gst_2b_current_version(d.id);
        insert into public.gst_2b_document_versions (company_id, document_id, version_no, version_kind, import_id, line_id, return_period, doc_number, doc_date, taxable_value,
          igst, cgst, sgst, cess, place_of_supply, reverse_charge, itc_availability, content_hash, created_by)
        values (m.company_id, d.id, cv.version_no + 1, case when l.is_amendment then 'AMENDMENT' else 'CHANGED' end, m.id, l.id, m.return_period, l.doc_number, l.doc_date,
          l.taxable_value, l.igst, l.cgst, l.sgst, l.cess, l.place_of_supply, l.reverse_charge, l.itc_availability, l.content_hash, auth.uid()) returning id into v_ver;
        v_out := case when l.is_amendment then 'AMENDMENT' else 'CHANGED' end;
        -- A proposal made on the earlier version is superseded; an approved match stays (evidence) but the document is flagged for review.
        for mt in select * from public.gst_2b_matches where document_id = d.id and status = 'PROPOSED' for update loop
          update public.gst_2b_matches set status = 'SUPERSEDED', row_version = row_version + 1 where id = mt.id returning * into mt;
          perform private.gst_2b_match_log(mt, 'SUPERSEDED', format('Document %s in GSTR-2B %s (version %s)', lower(v_out), m.return_period, cv.version_no + 1));
          v_super := v_super + 1;
        end loop;
        for mt in select * from public.gst_2b_matches where document_id = d.id and status = 'APPROVED' loop
          perform private.gst_2b_match_log(mt, 'DOCUMENT_CHANGED', format('Document %s in GSTR-2B %s (version %s); review the approved match', lower(v_out), m.return_period,
            cv.version_no + 1));
          v_review := v_review + 1;
        end loop;
        update public.gst_2b_documents set doc_number = l.doc_number, supplier_name = coalesce(l.supplier_name, supplier_name), version_count = cv.version_no + 1,
          needs_review = exists (select 1 from public.gst_2b_matches where document_id = d.id and status = 'APPROVED'),
          review_reason = case when exists (select 1 from public.gst_2b_matches where document_id = d.id and status = 'APPROVED')
                               then format('Version %s (%s) differs from the approved match', cv.version_no + 1, lower(v_out)) end,
          updated_at = now(), row_version = row_version + 1
        where id = d.id;
      end if;
      update public.gst_2b_documents set last_import_id = m.id, updated_at = now() where id = d.id;
    end if;
    update public.gst_2b_lines set commit_outcome = v_out, document_id = d.id, version_id = v_ver where id = l.id;
    v_counts := jsonb_set(v_counts, array[v_out], to_jsonb((v_counts ->> v_out)::int + 1));
  end loop;
  update public.gst_2b_lines set commit_outcome = 'SKIPPED' where import_id = m.id and row_status <> 'VALID';
  v_counts := jsonb_set(v_counts, '{SKIPPED}', to_jsonb(m.error_rows + m.duplicate_rows))
    || jsonb_build_object('proposals_superseded', v_super, 'approved_matches_to_review', v_review, 'vouchers_created', 0);
  update public.gst_2b_imports set status = 'COMMITTED', committed_by = auth.uid(), committed_at = now(), commit_summary = v_counts, row_version = row_version + 1
  where id = m.id returning * into m;
  perform private.write_audit_log(v_company, 'gst.itc_statement_committed', 'gst_itc_statement_import', m.id::text, v_counts);
  return private.gst_2b_import_json(m.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Matching: auto proposals, manual matches (reason), maker-checker approval, reversal, history
-- -----------------------------------------------------------------------------
create or replace function public.gst_2b_auto_match(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  v_reg     public.gst_registrations := private.gst_registration_of(v_company);
  v_import  uuid := nullif(p ->> 'import_id', '')::uuid;
  d         public.gst_2b_documents;
  v         public.gst_2b_document_versions;
  i         public.purchase_invoices;
  mt        public.gst_2b_matches;
  n         integer;
  v_inv     uuid;
  v_out     jsonb := '{"proposed": 0, "ambiguous": 0, "no_candidate": 0}'::jsonb;
  v_by      jsonb := '{}'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('gst_2b:' || v_reg.id::text, 0));
  for d in select * from public.gst_2b_documents x where x.registration_id = v_reg.id and x.doc_type = 'INVOICE'
             and (v_import is null or x.last_import_id = v_import)
             and not exists (select 1 from public.gst_2b_matches m where m.document_id = x.id and m.status in ('PROPOSED', 'APPROVED'))
           order by x.created_at, x.id loop
    v := private.gst_2b_current_version(d.id);
    select count(*), (array_agg(pi.id))[1] into n, v_inv from public.purchase_invoices pi
    where pi.company_id = v_company and pi.status = 'POSTED' and pi.supplier_gstin = d.supplier_gstin
      and private.gst_2b_key(pi.supplier_invoice_number) = private.gst_2b_key(v.doc_number)
      and not exists (select 1 from public.gst_2b_matches m where m.purchase_invoice_id = pi.id and m.status in ('PROPOSED', 'APPROVED'));
    if n = 1 then
      select * into i from public.purchase_invoices where id = v_inv;
      mt := private.gst_2b_propose(d, i, 'AUTO', null);
      v_out := jsonb_set(v_out, '{proposed}', to_jsonb((v_out ->> 'proposed')::int + 1));
      v_by := v_by || jsonb_build_object(mt.outcome, coalesce((v_by ->> mt.outcome)::int, 0) + 1);
    elsif n > 1 then
      v_out := jsonb_set(v_out, '{ambiguous}', to_jsonb((v_out ->> 'ambiguous')::int + 1));
    else
      v_out := jsonb_set(v_out, '{no_candidate}', to_jsonb((v_out ->> 'no_candidate')::int + 1));
    end if;
  end loop;
  perform private.write_audit_log(v_company, 'gst.itc_statement_auto_match', 'gst_registration', v_reg.id::text, v_out || jsonb_build_object('by_outcome', v_by));
  return v_out || jsonb_build_object('by_outcome', v_by, 'note', 'Auto-matching only proposes; every match needs approval by another user.');
end;
$$;

create or replace function public.gst_2b_match_manual(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.manage');
  v_reason  text := btrim(coalesce(p ->> 'reason', ''));
  d         public.gst_2b_documents;
  i         public.purchase_invoices;
  mt        public.gst_2b_matches;
begin
  if length(v_reason) < 10 then
    raise exception 'A manual match needs a reason of at least 10 characters.' using errcode = '22023';
  end if;
  select * into d from public.gst_2b_documents where id = private.accounting_uuid(p, 'document_id', 'GSTR-2B document') and company_id = v_company;
  if not found then
    raise exception 'GSTR-2B document not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_2b:' || d.registration_id::text, 0));
  if d.doc_type <> 'INVOICE' then
    raise exception 'Supplier credit / debit notes are not matched to purchase invoices; they stay open as exceptions (record an ITC reversal if needed).' using errcode = 'P0001';
  end if;
  select * into i from public.purchase_invoices where id = private.accounting_uuid(p, 'purchase_invoice_id', 'Purchase invoice') and company_id = v_company;
  if not found then
    raise exception 'Purchase invoice not found.' using errcode = 'P0002';
  end if;
  if i.status <> 'POSTED' then
    raise exception 'Only a posted purchase invoice can be matched (this one is %).', lower(i.status) using errcode = 'P0001';
  end if;
  if exists (select 1 from public.gst_2b_matches where document_id = d.id and status in ('PROPOSED', 'APPROVED')) then
    raise exception 'This GSTR-2B document already has a proposed or approved match; reject or reverse it first.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.gst_2b_matches where purchase_invoice_id = i.id and status in ('PROPOSED', 'APPROVED')) then
    raise exception 'Purchase invoice % already has a proposed or approved GSTR-2B match.', i.invoice_number using errcode = 'P0001';
  end if;
  mt := private.gst_2b_propose(d, i, 'MANUAL', v_reason);
  return private.gst_2b_match_json(mt.id);
end;
$$;

create or replace function public.gst_2b_match_decide(p_match_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.approve');
  v_action  text := upper(coalesce(p_action, ''));
  v_note    text := btrim(coalesce(p_note, ''));
  mt        public.gst_2b_matches;
begin
  select * into mt from public.gst_2b_matches where id = p_match_id and company_id = v_company;
  if not found then
    raise exception 'GSTR-2B match not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_2b:' || mt.registration_id::text, 0));
  select * into mt from public.gst_2b_matches where id = p_match_id for update;
  if mt.status <> 'PROPOSED' then
    raise exception 'This match is % — only a proposed match can be approved or rejected.', lower(mt.status) using errcode = 'P0001';
  end if;
  if mt.proposed_by = auth.uid() then
    raise exception 'Maker-checker: the person who proposed a GSTR-2B match cannot approve or reject it.' using errcode = '42501';
  end if;
  if v_action = 'APPROVE' then
    if mt.document_version_id <> (private.gst_2b_current_version(mt.document_id)).id then
      raise exception 'The GSTR-2B document changed since this match was proposed; reject it and match the current version.' using errcode = 'P0001';
    end if;
    if (select status from public.purchase_invoices where id = mt.purchase_invoice_id) <> 'POSTED' then
      raise exception 'The purchase invoice is no longer posted; reject this match.' using errcode = 'P0001';
    end if;
    if mt.outcome <> 'EXACT' and length(v_note) < 10 then
      raise exception 'The match has differences (%): record why they are acceptable (at least 10 characters).', lower(replace(mt.outcome, '_', ' ')) using errcode = '22023';
    end if;
    update public.gst_2b_matches set status = 'APPROVED', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(v_note, ''), row_version = row_version + 1
    where id = mt.id returning * into mt;
    update public.gst_2b_documents set needs_review = false, review_reason = null, updated_at = now(), row_version = row_version + 1 where id = mt.document_id and needs_review;
  elsif v_action = 'REJECT' then
    if length(v_note) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    update public.gst_2b_matches set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), decision_note = v_note, row_version = row_version + 1
    where id = mt.id returning * into mt;
  else
    raise exception 'Unknown action %.', p_action using errcode = '22023';
  end if;
  perform private.gst_2b_match_log(mt, mt.status, v_note);
  return private.gst_2b_match_json(mt.id);
end;
$$;

create or replace function public.gst_2b_match_reverse(p_match_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.approve');
  mt        public.gst_2b_matches;
begin
  select * into mt from public.gst_2b_matches where id = p_match_id and company_id = v_company;
  if not found then
    raise exception 'GSTR-2B match not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_2b:' || mt.registration_id::text, 0));
  select * into mt from public.gst_2b_matches where id = p_match_id for update;
  if mt.status <> 'APPROVED' then
    raise exception 'Only an approved match can be reversed (this one is %).', lower(mt.status) using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Record why the match is reversed (at least 10 characters).' using errcode = '22023';
  end if;
  update public.gst_2b_matches set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 1000), row_version = row_version + 1
  where id = mt.id returning * into mt;
  update public.gst_2b_documents set needs_review = false, review_reason = null, updated_at = now(), row_version = row_version + 1 where id = mt.document_id and needs_review;
  perform private.gst_2b_match_log(mt, 'REVERSED', p_reason);
  return private.gst_2b_match_json(mt.id);
end;
$$;

create or replace function public.gst_2b_match_get(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
begin
  if not exists (select 1 from public.gst_2b_matches where id = p_match_id and company_id = v_company) then
    raise exception 'GSTR-2B match not found.' using errcode = 'P0002';
  end if;
  return private.gst_2b_match_json(p_match_id);
end;
$$;

create or replace function public.gst_2b_document_get(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
  d         public.gst_2b_documents;
begin
  select * into d from public.gst_2b_documents where id = p_document_id and company_id = v_company;
  if not found then
    raise exception 'GSTR-2B document not found.' using errcode = 'P0002';
  end if;
  return to_jsonb(d) - 'company_id' || jsonb_build_object(
    'versions', coalesce((select jsonb_agg(to_jsonb(v) - 'company_id' || jsonb_build_object('original_row', l.original_row, 'source_row', l.source_row, 'sheet_name', l.sheet_name,
       'file_name', m.file_name) order by v.version_no)
       from public.gst_2b_document_versions v join public.gst_2b_lines l on l.id = v.line_id join public.gst_2b_imports m on m.id = v.import_id where v.document_id = d.id), '[]'::jsonb),
    'appearances', coalesce((select jsonb_agg(jsonb_build_object('import_id', l.import_id, 'line_no', l.line_no, 'commit_outcome', l.commit_outcome, 'file_name', m.file_name,
       'return_period', m.return_period) order by m.committed_at, l.line_no)
       from public.gst_2b_lines l join public.gst_2b_imports m on m.id = l.import_id where l.document_id = d.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(private.gst_2b_match_json(x.id) order by x.proposed_at) from public.gst_2b_matches x where x.document_id = d.id), '[]'::jsonb),
    'candidates', case when d.doc_type = 'INVOICE' then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number,
       'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'supplier_gstin', i.supplier_gstin, 'taxable_value', i.taxable_value,
       'igst', i.igst_total, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'cess', i.cess_total, 'gst_status', i.gst_status) order by i.supplier_invoice_date desc)
       from (select * from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.supplier_gstin = d.supplier_gstin
               and not exists (select 1 from public.gst_2b_matches m where m.purchase_invoice_id = i.id and m.status in ('PROPOSED', 'APPROVED'))
             order by i.supplier_invoice_date desc limit 50) i), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

-- Current state of every GSTR-2B document of a company in scope (current version, active match), filtered.
create or replace function private.gst_2b_scope(p_company uuid, p_filters jsonb)
returns table (document_id uuid, doc_type text, supplier_gstin text, doc_number text, doc_date date, return_period text, taxable_value numeric, igst numeric,
  cgst numeric, sgst numeric, cess numeric, itc_availability text, version_no integer, version_count integer, needs_review boolean, review_reason text, match_id uuid,
  match_status text, outcome text, purchase_invoice_id uuid, invoice_number text, invoice_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.doc_type, d.supplier_gstin, v.doc_number, v.doc_date, v.return_period, v.taxable_value, v.igst, v.cgst, v.sgst, v.cess, v.itc_availability, v.version_no,
         d.version_count, d.needs_review, d.review_reason, m.id, m.status, m.outcome, m.purchase_invoice_id, i.invoice_number, i.status
  from public.gst_2b_documents d
  cross join lateral (select * from public.gst_2b_document_versions x where x.document_id = d.id order by x.version_no desc limit 1) v
  left join public.gst_2b_matches m on m.document_id = d.id and m.status in ('PROPOSED', 'APPROVED')
  left join public.purchase_invoices i on i.id = m.purchase_invoice_id
  where d.company_id = p_company
    and (nullif(p_filters ->> 'return_period', '') is null or v.return_period = p_filters ->> 'return_period')
    and (nullif(p_filters ->> 'supplier_gstin', '') is null or d.supplier_gstin = upper(btrim(p_filters ->> 'supplier_gstin')))
    and (nullif(p_filters ->> 'from', '') is null or v.doc_date >= (p_filters ->> 'from')::date)
    and (nullif(p_filters ->> 'to', '') is null or v.doc_date <= (p_filters ->> 'to')::date);
$$;
revoke all on function private.gst_2b_scope(uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Reports
-- -----------------------------------------------------------------------------
create or replace function public.gst_2b_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
  v_report  text := upper(coalesce(p_report, ''));
  v_reg     uuid := (select id from public.gst_registrations where company_id = v_company and is_active);
  v_from    date := nullif(p_filters ->> 'from', '')::date;
  v_to      date := nullif(p_filters ->> 'to', '')::date;
  v_period  text := nullif(p_filters ->> 'return_period', '');
  v_gstin   text := nullif(upper(btrim(coalesce(p_filters ->> 'supplier_gstin', ''))), '');
  v_rows    jsonb;
begin
  if v_report = 'SUMMARY' then
    return jsonb_build_object('report', v_report, 'registration_id', v_reg,
      'documents', (select count(*) from private.gst_2b_scope(v_company, p_filters)),
      'invoices', (select count(*) from private.gst_2b_scope(v_company, p_filters) where doc_type = 'INVOICE'),
      'approved', (select count(*) from private.gst_2b_scope(v_company, p_filters) where match_status = 'APPROVED'),
      'proposed', (select count(*) from private.gst_2b_scope(v_company, p_filters) where match_status = 'PROPOSED'),
      'missing_in_books', (select count(*) from private.gst_2b_scope(v_company, p_filters) where doc_type = 'INVOICE' and match_id is null),
      'credit_debit_notes', (select count(*) from private.gst_2b_scope(v_company, p_filters) where doc_type <> 'INVOICE'),
      'needs_review', (select count(*) from private.gst_2b_scope(v_company, p_filters) where needs_review),
      'by_outcome', coalesce((select jsonb_object_agg(outcome, n) from (select outcome, count(*) as n from private.gst_2b_scope(v_company, p_filters) where outcome is not null group by 1) x), '{}'::jsonb),
      'imports', (select count(*) from public.gst_2b_imports where company_id = v_company and status = 'COMMITTED'),
      'note', 'GSTR-2B reconciliation never posts vouchers and never approves ITC.');
  elsif v_report = 'DOCUMENTS' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.doc_date, s.doc_number), '[]'::jsonb) into v_rows from (select * from private.gst_2b_scope(v_company, p_filters)
      where (nullif(p_filters ->> 'match_status', '') is null or coalesce(match_status, 'UNMATCHED') = upper(p_filters ->> 'match_status')) limit 2000) s;
  elsif v_report = 'MISSING_IN_BOOKS' then
    select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('exception', 'MISSING_IN_BOOKS', 'candidates', (
        select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
          'supplier_invoice_date', i.supplier_invoice_date)), '[]'::jsonb)
        from (select * from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.supplier_gstin = s.supplier_gstin
                and not exists (select 1 from public.gst_2b_matches m where m.purchase_invoice_id = i.id and m.status in ('PROPOSED', 'APPROVED'))
                and (i.igst_total + i.cgst_total + i.sgst_total + i.cess_total = s.igst + s.cgst + s.sgst + s.cess or i.supplier_invoice_date = s.doc_date)
              order by i.supplier_invoice_date limit 5) i)) order by s.doc_date, s.doc_number), '[]'::jsonb)
    into v_rows from (select * from private.gst_2b_scope(v_company, p_filters) where doc_type = 'INVOICE' and match_id is null limit 2000) s;
  elsif v_report = 'MISSING_IN_2B' then
    select coalesce(jsonb_agg(jsonb_build_object('purchase_invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier_invoice_date', i.supplier_invoice_date, 'supplier_gstin', i.supplier_gstin, 'taxable_value', i.taxable_value, 'igst', i.igst_total, 'cgst', i.cgst_total,
        'sgst', i.sgst_total, 'cess', i.cess_total, 'gst_status', i.gst_status, 'reverse_charge', i.reverse_charge, 'exception', 'MISSING_IN_2B',
        'proposed_match_id', (select m.id from public.gst_2b_matches m where m.purchase_invoice_id = i.id and m.status = 'PROPOSED'))
        order by i.supplier_invoice_date, i.invoice_number), '[]'::jsonb)
    into v_rows from (select * from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.supplier_gstin is not null
        and i.igst_total + i.cgst_total + i.sgst_total + i.cess_total > 0
        and (v_from is null or i.supplier_invoice_date >= v_from) and (v_to is null or i.supplier_invoice_date <= v_to) and (v_gstin is null or i.supplier_gstin = v_gstin)
        and not exists (select 1 from public.gst_2b_matches m where m.purchase_invoice_id = i.id and m.status = 'APPROVED')
      order by i.supplier_invoice_date limit 2000) i;
  elsif v_report = 'CREDIT_NOTES' then
    select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('exception', 'CREDIT_NOTE_UNRESOLVED',
        'note', 'Supplier credit / debit notes are not matched automatically; review them and record an ITC reversal or reclaim where needed.')
        order by s.doc_date, s.doc_number), '[]'::jsonb)
    into v_rows from (select * from private.gst_2b_scope(v_company, p_filters) where doc_type <> 'INVOICE' limit 2000) s;
  elsif v_report = 'DUPLICATES' then
    select coalesce(jsonb_agg(jsonb_build_object('import_id', m.id, 'file_name', m.file_name, 'return_period', m.return_period, 'line_no', l.line_no, 'source_row', l.source_row,
        'supplier_gstin', l.supplier_gstin, 'doc_number', l.doc_number, 'doc_date', l.doc_date, 'kind', case when l.row_status = 'DUPLICATE_IN_FILE' then 'DUPLICATE_IN_FILE'
        else 'DUPLICATE_OF_EARLIER' end, 'duplicate_of_line', l.duplicate_of_line, 'document_id', l.document_id) order by m.created_at, l.line_no), '[]'::jsonb)
    into v_rows from public.gst_2b_lines l join public.gst_2b_imports m on m.id = l.import_id
    where l.company_id = v_company and (l.row_status = 'DUPLICATE_IN_FILE' or l.commit_outcome = 'DUPLICATE_OF_EARLIER')
      and (v_period is null or m.return_period = v_period) and (v_gstin is null or l.supplier_gstin = v_gstin);
  elsif v_report = 'AMENDMENTS' then
    select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('versions', (select jsonb_agg(jsonb_build_object('version_no', v.version_no, 'version_kind', v.version_kind,
        'return_period', v.return_period, 'doc_number', v.doc_number, 'doc_date', v.doc_date, 'taxable_value', v.taxable_value, 'igst', v.igst, 'cgst', v.cgst, 'sgst', v.sgst,
        'cess', v.cess) order by v.version_no) from public.gst_2b_document_versions v where v.document_id = s.document_id)) order by s.doc_date), '[]'::jsonb)
    into v_rows from (select * from private.gst_2b_scope(v_company, p_filters) where version_count > 1 or needs_review limit 2000) s;
  elsif v_report = 'MATCH_EXCEPTIONS' then
    select coalesce(jsonb_agg(private.gst_2b_match_json(m.id) || jsonb_build_object('exception', case when i.status <> 'POSTED' then 'INVOICE_NOT_POSTED'
        when d.needs_review then 'DOCUMENT_CHANGED' else m.outcome end) order by m.proposed_at), '[]'::jsonb)
    into v_rows from public.gst_2b_matches m join public.purchase_invoices i on i.id = m.purchase_invoice_id join public.gst_2b_documents d on d.id = m.document_id
    where m.company_id = v_company and m.status in ('PROPOSED', 'APPROVED') and (m.outcome <> 'EXACT' or i.status <> 'POSTED' or d.needs_review);
  elsif v_report = 'HISTORY' then
    select coalesce(jsonb_agg(to_jsonb(h) - 'company_id' || jsonb_build_object('by', (select full_name from public.profiles where id = h.actor_id)) order by h.created_at desc), '[]'::jsonb)
    into v_rows from (select * from public.gst_2b_match_history h where h.company_id = v_company
      and (nullif(p_filters ->> 'document_id', '') is null or h.document_id = (p_filters ->> 'document_id')::uuid) order by h.created_at desc limit 500) h;
  else
    raise exception 'Unknown GSTR-2B report %.', p_report using errcode = '22023';
  end if;
  return jsonb_build_object('report', v_report, 'rows', v_rows);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Original file download (audited, 5-minute grant; the caller then creates a signed URL)
-- -----------------------------------------------------------------------------
create or replace function public.gst_2b_file_access(p_import_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_reconciliation.read');
  m         public.gst_2b_imports;
  g         public.gst_file_access_grants;
begin
  select * into m from public.gst_2b_imports where id = p_import_id and company_id = v_company;
  if not found then
    raise exception 'GSTR-2B import not found.' using errcode = 'P0002';
  end if;
  if m.status in ('PENDING_UPLOAD', 'EXPIRED') then
    raise exception 'This import has no stored file.' using errcode = 'P0001';
  end if;
  insert into public.gst_file_access_grants (company_id, import_id, storage_path, granted_to, expires_at)
  values (v_company, m.id, m.storage_path, auth.uid(), now() + interval '5 minutes') returning * into g;
  perform private.write_audit_log(v_company, 'gst.itc_statement_file_download', 'gst_itc_statement_import', m.id::text, jsonb_build_object('file_name', m.file_name, 'grant_id', g.id));
  return jsonb_build_object('bucket', 'gst-files', 'storage_path', m.storage_path, 'file_name', m.file_name, 'expires_at', g.expires_at,
    'declared_sha256', m.declared_sha256, 'computed_sha256', m.computed_sha256);
end;
$$;

create index if not exists purchase_invoices_gst_2b_key_idx on public.purchase_invoices (company_id, supplier_gstin, private.gst_2b_key(supplier_invoice_number));

revoke all on function private.gst_2b_key(text) from public, anon, authenticated;
revoke all on function private.gst_2b_fy(date) from public, anon, authenticated;
revoke all on function private.gst_2b_date(text) from public, anon, authenticated;
revoke all on function private.gst_2b_amount(text) from public, anon, authenticated;
revoke all on function private.gst_2b_parse_line(jsonb, text) from public, anon, authenticated;
revoke all on function private.gst_2b_tolerance(uuid) from public, anon, authenticated;
revoke all on function private.gst_2b_compare(public.gst_2b_document_versions, text, public.purchase_invoices, numeric) from public, anon, authenticated;
revoke all on function private.gst_2b_current_version(uuid) from public, anon, authenticated;
revoke all on function private.gst_2b_match_log(public.gst_2b_matches, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.gst_2b_propose(public.gst_2b_documents, public.purchase_invoices, text, text) from public, anon, authenticated, service_role;
revoke all on function private.gst_2b_match_json(uuid) from public, anon, authenticated;
revoke all on function private.gst_2b_import_json(uuid) from public, anon, authenticated;
revoke all on function private.gst_2b_preview(uuid) from public, anon, authenticated;
revoke all on function private.gst_2b_evidence(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 10. Existing functions changed (each from its latest text; Gate C lines marked): ITC maker-checker for every decision (Phase 3 verification
--     proposes; approval keeps the Phase 3 voucher identity), GSTR-2B evidence in the ITC view, qualified set-off credit, the ERP reset
--     registry and the force-reset storage cleanup.
-- -----------------------------------------------------------------------------
create or replace function public.purchase_invoice_verify_gst(p_invoice_id uuid, p_status text, p_reason text, p_checks jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v_status  text := upper(coalesce(p_status, ''));
  v_full    jsonb;
  v_zero    jsonb := '{"cgst": 0, "sgst": 0, "igst": 0, "cess": 0}'::jsonb;
  v_split   jsonb;
begin
  if i.gst_status <> 'PENDING_VERIFICATION' then
    raise exception 'The GST of this invoice is % — only pending GST can be verified.', lower(replace(i.gst_status, '_', ' ')) using errcode = 'P0001';
  end if;
  if v_status not in ('ELIGIBLE', 'INELIGIBLE') then
    raise exception 'Status must be ELIGIBLE or INELIGIBLE.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Record why (at least 10 characters), e.g. what was checked against the supplier invoice.' using errcode = '22023';
  end if;
  if v_status = 'ELIGIBLE' and not (coalesce((p_checks ->> 'invoice_verified')::boolean, false) and coalesce((p_checks ->> 'goods_services_received')::boolean, false)
      and coalesce((p_checks ->> 'gstin_valid')::boolean, false)) then
    raise exception 'Eligible input GST needs the checks: supplier invoice verified, goods / services received, supplier GSTIN valid.' using errcode = 'P0001';
  end if;
  -- Phase 5 Gate C: maker-checker for every ITC decision. This records a PROPOSAL of the full decision (no voucher); a different user
  -- approves or rejects it (gst_itc_action APPROVE / REJECT), which posts the same Phase 3 voucher (PIN / PURCHASE_INVOICE_GST).
  if (select stage from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1) = 'PROPOSED' then
    raise exception 'An ITC proposal is awaiting approval; approve or reject it first (Accounts › GST › ITC verification).' using errcode = 'P0001';
  end if;
  v_full := jsonb_build_object('cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total);
  v_split := private.gst_itc_split(i, case when v_status = 'ELIGIBLE' then v_full else v_zero end, case when v_status = 'ELIGIBLE' then v_zero else v_full end);
  perform private.gst_itc_append(i, 'PROPOSED', v_split ->> 'decision', v_split, btrim(p_reason), coalesce(p_checks, '{}'::jsonb), '[]'::jsonb, null, null);
  return private.pi_json(i.id) || jsonb_build_object('itc_stage', 'PROPOSED', 'itc_proposal', v_split ->> 'decision',
    'message', 'ITC decision proposed. Another user with GST verification rights must approve it before it is posted.');
end;
$$;

create or replace function public.gst_itc_action(p_invoice_id uuid, p_action text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  v_action  text := upper(coalesce(p_action, ''));
  i         public.purchase_invoices;
  last      public.gst_itc_decisions;
  v_split   jsonb;
  v_reason  text := btrim(coalesce(p ->> 'reason', ''));
  n         record;
  v_rev     public.accounting_vouchers;
begin
  i := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  select * into last from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1;
  if v_action in ('UNDER_REVIEW', 'ON_HOLD', 'PROPOSE') and i.gst_status <> 'PENDING_VERIFICATION' then
    raise exception 'The GST of this invoice is % — only pending GST is reviewed or decided.', lower(replace(i.gst_status, '_', ' ')) using errcode = 'P0001';
  end if;
  if v_action in ('UNDER_REVIEW', 'ON_HOLD') then
    if length(v_reason) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    if last.stage = 'PROPOSED' then
      raise exception 'A proposal is awaiting approval; approve or reject it first.' using errcode = 'P0001';
    end if;
    perform private.gst_itc_append(i, v_action, null, null, v_reason, null, p -> 'document_refs', null, null);
  elsif v_action = 'PROPOSE' then
    if last.stage = 'PROPOSED' then
      raise exception 'A proposal is already awaiting approval.' using errcode = 'P0001';
    end if;
    if length(v_reason) < 10 then
      raise exception 'Record why (at least 10 characters), e.g. what was checked against the supplier invoice.' using errcode = '22023';
    end if;
    v_split := private.gst_itc_split(i, coalesce(p -> 'eligible', '{}'::jsonb), coalesce(p -> 'ineligible', '{}'::jsonb));
    if (v_split ->> 'eligible_total')::numeric > 0 and not private.gst_itc_checks_ok(p -> 'checks') then
      raise exception 'Eligible input GST needs the checks: supplier invoice verified, goods / services received, supplier GSTIN valid.' using errcode = 'P0001';
    end if;
    perform private.gst_itc_append(i, 'PROPOSED', v_split ->> 'decision', v_split, v_reason, p -> 'checks', p -> 'document_refs', null, null);
  elsif v_action in ('APPROVE', 'REJECT') then
    if last.stage is distinct from 'PROPOSED' then
      raise exception 'There is no proposal awaiting approval.' using errcode = 'P0001';
    end if;
    if last.actor_id = auth.uid() then
      raise exception 'Maker-checker: the person who proposed an ITC decision cannot approve or reject it.' using errcode = '42501';
    end if;
    if v_action = 'REJECT' then
      if length(v_reason) < 5 then
        raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
      end if;
      perform private.gst_itc_append(i, 'REJECTED', null, null, v_reason, null, null, last.id, null);
    else
      v_split := private.gst_itc_split(i, jsonb_build_object('cgst', last.eligible_cgst, 'sgst', last.eligible_sgst, 'igst', last.eligible_igst, 'cess', last.eligible_cess),
        jsonb_build_object('cgst', last.ineligible_cgst, 'sgst', last.ineligible_sgst, 'igst', last.ineligible_igst, 'cess', last.ineligible_cess));
      -- Gate C: a full ELIGIBLE / INELIGIBLE decision keeps the Phase 3 voucher identity (PIN / PURCHASE_INVOICE_GST) on its first posting.
      i := private.gst_itc_apply_decision(i, v_split, last.reason, last.checks, last.document_refs, last.id, (v_split ->> 'decision') in ('ELIGIBLE', 'INELIGIBLE'));
    end if;
  elsif v_action = 'REVERSE_DECISION' then
    if i.gst_status not in ('ELIGIBLE', 'INELIGIBLE', 'PARTIALLY_ELIGIBLE') or i.gst_voucher_id is null then
      raise exception 'There is no posted ITC decision to reverse.' using errcode = 'P0001';
    end if;
    if length(v_reason) < 10 then
      raise exception 'Record why the decision is reversed (at least 10 characters).' using errcode = '22023';
    end if;
    if exists (select 1 from public.gst_itc_adjustments where purchase_invoice_id = i.id and status in ('DRAFT', 'POSTED')) then
      raise exception 'Reverse or cancel the ITC adjustments of this invoice first (newest first).' using errcode = 'P0001';
    end if;
    select * into n from private.gst_itc_net(i.id);
    perform private.gst_itc_input_available(i.company_id, n.eligible_cgst, n.eligible_sgst, n.eligible_igst, n.eligible_cess);
    v_rev := private.accounting_reverse_voucher(i.gst_voucher_id, 'ITC decision reversed: ' || v_reason, null);
    perform private.gst_itc_append(i, 'DECISION_REVERSED', null, null, v_reason, null, null, n.decision_id, v_rev.id);
    update public.purchase_invoices set gst_status = 'PENDING_VERIFICATION', gst_voucher_id = null, gst_verified_by = null, gst_verified_at = null, gst_verification = null,
      updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  else
    raise exception 'Unknown ITC action %.', p_action using errcode = '22023';
  end if;
  return private.gst_itc_json(i.id);
end;
$$;

create or replace function private.gst_itc_json(p_invoice uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number, 'supplier_gstin', i.supplier_gstin,
    'gst_status', i.gst_status, 'gst_voucher_id', i.gst_voucher_id,
    -- Gate C: GSTR-2B evidence (read only; it never decides ITC).
    'gstr2b', private.gst_2b_evidence(i.id),
    'pending', jsonb_build_object('cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total),
    'net', (select to_jsonb(n) from private.gst_itc_net(i.id) n),
    'stage', (select stage from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1),
    'history', coalesce((select jsonb_agg(to_jsonb(d) - 'company_id' || jsonb_build_object('by', (select full_name from public.profiles where id = d.actor_id),
       'voucher_number', (select voucher_number from public.accounting_vouchers where id = d.voucher_id)) order by d.seq)
       from public.gst_itc_decisions d where d.purchase_invoice_id = i.id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' || jsonb_build_object('voucher_number', (select voucher_number from public.accounting_vouchers where id = a.voucher_id))
       order by a.prepared_at) from public.gst_itc_adjustments a where a.purchase_invoice_id = i.id), '[]'::jsonb))
  from public.purchase_invoices i where i.id = p_invoice;
$$;

create or replace function private.gst_liability(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Phase 5 Gate C: credit available is QUALIFIED, never the unqualified ledger balance:
  --   input credit accrued up to the period end (input ledger movements dated on or before it, set-off vouchers and their reversals excluded)
  --   less credit used by POSTED set-offs of this registration (reversed set-offs excluded),
  --   never more than the current input ledger balance (later ITC reversals reduce it) and never below zero.
  -- Liability: output (ledger movement in the period, set-off vouchers excluded) and reverse charge (posted RCM invoices recorded in the period);
  -- open = liability less posted set-offs of the period; previous_outstanding = the same for the registration's earlier periods.
  with heads (h) as (values ('IGST'), ('CGST'), ('SGST'), ('CESS')),
  bounds as (select coalesce((select min(period_start) from public.gst_return_periods where registration_id = p.registration_id), p.period_start) as first_start),
  outp as (
    select h,
      case when h = 'CESS' then 0 else -private.gst_ledger_movement(p.company_id, 'OUTPUT_' || h, p.period_start, p.period_end, 'GST_SET_OFF') end as cur,
      case when h = 'CESS' then 0 else -private.gst_ledger_movement(p.company_id, 'OUTPUT_' || h, (select first_start from bounds), p.period_start - 1, 'GST_SET_OFF') end as prev
    from heads),
  rcm as (
    select heads.h,
      coalesce(sum(case heads.h when 'IGST' then x.igst_total when 'CGST' then x.cgst_total when 'SGST' then x.sgst_total else x.cess_total end)
        filter (where x.recorded_date between p.period_start and p.period_end), 0) as cur,
      coalesce(sum(case heads.h when 'IGST' then x.igst_total when 'CGST' then x.cgst_total when 'SGST' then x.sgst_total else x.cess_total end)
        filter (where x.recorded_date >= (select first_start from bounds) and x.recorded_date < p.period_start), 0) as prev
    from heads left join public.purchase_invoices x on x.company_id = p.company_id and x.status = 'POSTED' and x.reverse_charge
    group by heads.h),
  so as (
    select l.liability_kind as kind, l.liability_head as h,
      coalesce(sum(l.amount) filter (where s.period_id = p.id), 0) as cur,
      coalesce(sum(l.amount) filter (where sp.period_start < p.period_start), 0) as prev
    from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id join public.gst_return_periods sp on sp.id = s.period_id
    where s.registration_id = p.registration_id and s.status = 'POSTED'
    group by 1, 2),
  liab as (
    select 'OUTPUT' as kind, o.h, o.cur, o.prev from outp o
    union all select 'RCM', r.h, r.cur, r.prev from rcm r),
  cred as (
    select h,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || h, null, p.period_end, 'GST_SET_OFF') as accrued,
      coalesce((select sum(l.amount) from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id
                where s.registration_id = p.registration_id and s.status = 'POSTED' and l.source = 'CREDIT' and l.source_head = heads.h), 0) as used,
      private.gst_ledger_movement(p.company_id, 'INPUT_' || h, null, null) as ledger
    from heads)
  select jsonb_build_object(
    'output', (select jsonb_object_agg(h, cur) from outp),
    'rcm', (select jsonb_object_agg(h, cur) from rcm),
    'set_off', (select coalesce(jsonb_object_agg(kind || ':' || h, cur), '{}'::jsonb) from so where cur > 0),
    'open', (select jsonb_object_agg(a.kind || ':' || a.h, a.cur - coalesce((select so.cur from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_outstanding', (select jsonb_object_agg(a.kind || ':' || a.h, a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0)) from liab a),
    'previous_from', (select first_start from bounds),
    'credit', (select jsonb_object_agg(h, greatest(0, least(accrued - used, ledger))) from cred),
    'credit_detail', (select jsonb_object_agg(h, jsonb_build_object('accrued_to_period_end', accrued, 'used_in_posted_set_offs', used, 'ledger_balance', ledger,
       'available', greatest(0, least(accrued - used, ledger)))) from cred),
    'credit_basis', 'Input credit accrued by the period end (set-off vouchers excluded) less credit used by posted set-offs (reversed set-offs excluded), never more than the input ledger balance.',
    'warnings', coalesce((select jsonb_agg(format('%s %s of earlier periods is still outstanding: %s', initcap(lower(a.kind)), a.h,
       a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0)) order by a.kind, a.h)
       from liab a where a.prev - coalesce((select so.prev from so where so.kind = a.kind and so.h = a.h), 0) > 0), '[]'::jsonb),
    'cash', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(p.registration_id) c), '{}'::jsonb),
    'cash_ledger', private.gst_ledger_movement(p.company_id, 'GST_ELECTRONIC_CASH', null, null));
$$;

create or replace function public.gst_set_off(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_permission(case when v_action in ('POST', 'REVERSE') then 'gst_payments.post' else 'gst_payments.create' end);
  s         public.gst_set_offs;
  per       public.gst_return_periods;
  v_cfg     public.gst_config_versions;
  liab      jsonb;
  l         record;
  v_used    numeric;
  v_open    numeric;
  v_lines   jsonb := '[]'::jsonb;
  v_id      uuid;
  v         public.accounting_vouchers;
  k         text;
  v_amt     numeric;
begin
  if v_action = 'SAVE' then
    if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then
      raise exception 'A set-off needs at least one line.' using errcode = '22023';
    end if;
    if p_id is null then
      per := private.gst_period_lock(v_company, private.accounting_uuid(p, 'period_id', 'Period'));
      insert into public.gst_set_offs (company_id, registration_id, period_id, notes, prepared_by)
      values (v_company, per.registration_id, per.id, left(p ->> 'notes', 1000), auth.uid()) returning * into s;
    else
      select * into s from public.gst_set_offs where id = p_id and company_id = v_company for update;
      if not found or s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be edited.' using errcode = 'P0001';
      end if;
      if nullif(p ->> 'row_version', '') is not null and s.row_version <> (p ->> 'row_version')::int then
        raise exception 'This set-off was changed by someone else. Reload it and try again.' using errcode = '40001';
      end if;
      delete from public.gst_set_off_lines where set_off_id = s.id;
      update public.gst_set_offs set notes = left(p ->> 'notes', 1000), prepared_by = auth.uid(), prepared_at = now(), row_version = row_version + 1 where id = s.id returning * into s;
    end if;
    insert into public.gst_set_off_lines (company_id, set_off_id, line_no, liability_kind, liability_head, source, source_head, cash_minor_head, amount)
    select v_company, s.id, row_number() over (), upper(x ->> 'liability_kind'), upper(x ->> 'liability_head'), upper(x ->> 'source'), upper(x ->> 'source_head'),
           nullif(upper(coalesce(x ->> 'cash_minor_head', '')), ''), (x ->> 'amount')::numeric
    from jsonb_array_elements(p -> 'lines') x;
    insert into public.gst_set_off_events (company_id, set_off_id, action, details, actor_id) values (v_company, s.id, 'SAVED', jsonb_build_object('lines', p -> 'lines'), auth.uid());
  else
    select * into s from public.gst_set_offs where id = p_id and company_id = v_company;
    if not found then
      raise exception 'Set-off not found.' using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('gst_setoff:' || s.registration_id::text, 0));
    per := private.gst_period_lock(v_company, s.period_id);
    select * into s from public.gst_set_offs where id = p_id for update;
    if v_action = 'CANCEL' then
      if s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be cancelled.' using errcode = 'P0001';
      end if;
      update public.gst_set_offs set status = 'CANCELLED', status_reason = left(p ->> 'reason', 1000), row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, reason, actor_id) values (v_company, s.id, 'CANCELLED', p ->> 'reason', auth.uid());
    elsif v_action = 'POST' then
      if s.status <> 'DRAFT' then
        raise exception 'Only a draft set-off can be posted (this one is %).', lower(s.status) using errcode = 'P0001';
      end if;
      if s.prepared_by = auth.uid() then
        raise exception 'Maker-checker: the person who prepared the set-off cannot post it.' using errcode = '42501';
      end if;
      if exists (select 1 from public.gst_set_offs where period_id = per.id and status = 'POSTED') then
        raise exception 'A set-off is already posted for period %; reverse it before posting another.', per.period_code using errcode = 'P0001';
      end if;
      v_cfg := private.gst_config_on(v_company, per.period_end);
      if v_cfg.id is null then
        raise exception 'No approved GST configuration is in force for period %.', per.period_code using errcode = 'P0001';
      end if;
      foreach k in array array['GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE'] loop
        if private.accounting_rule_account(v_company, k, '') is null then
          raise exception 'Set up the GST ledgers first (% is not mapped).', k using errcode = 'P0001';
        end if;
      end loop;
      liab := private.gst_liability(per);
      -- Every line: valid pairing, and the source / liability kinds allowed.
      for l in select * from public.gst_set_off_lines where set_off_id = s.id order by line_no loop
        if l.source = 'CREDIT' and not ((v_cfg.payload -> 'set_off_matrix' -> l.liability_head) ? l.source_head) then
          raise exception 'Line %: % credit may not pay % liability (configured set-off matrix).', l.line_no, l.source_head, l.liability_head using errcode = 'P0001';
        end if;
        if l.source = 'CASH' and l.source_head <> l.liability_head then
          raise exception 'Line %: % liability is paid from % electronic cash only.', l.line_no, l.liability_head, l.liability_head using errcode = 'P0001';
        end if;
        if l.liability_kind = 'RCM' and l.source = 'CREDIT' and (v_cfg.payload ->> 'rcm_cash_only')::boolean then
          raise exception 'Line %: reverse-charge liability is paid in cash only (configuration).', l.line_no using errcode = 'P0001';
        end if;
        if l.source = 'CASH' and l.liability_kind in ('OUTPUT', 'RCM') and l.cash_minor_head <> 'TAX' or l.liability_kind = 'INTEREST' and l.cash_minor_head <> 'INTEREST'
           or l.liability_kind = 'LATE_FEE' and l.cash_minor_head not in ('FEE', 'PENALTY') then
          raise exception 'Line %: the electronic-cash minor head does not fit the liability (tax from TAX, interest from INTEREST, late fee from FEE / PENALTY).', l.line_no
            using errcode = 'P0001';
        end if;
      end loop;
      -- Liability per kind / head never exceeded.
      for l in select liability_kind, liability_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and liability_kind in ('OUTPUT', 'RCM') group by 1, 2 loop
        v_open := coalesce((liab -> lower(l.liability_kind) ->> l.liability_head)::numeric, 0) - coalesce((liab -> 'set_off' ->> (l.liability_kind || ':' || l.liability_head))::numeric, 0);
        if l.amt > v_open then
          raise exception '% % liability of % is % — the set-off uses %.', initcap(lower(l.liability_kind)), l.liability_head, per.period_code, v_open, l.amt using errcode = 'P0001';
        end if;
      end loop;
      -- Credit per head never exceeded.
      for l in select source_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and source = 'CREDIT' group by 1 loop
        if l.amt > coalesce((liab -> 'credit' ->> l.source_head)::numeric, 0) then
          -- Gate C: qualified credit (accrued by the period end, less credit already set off, within the ledger balance).
          raise exception 'Input % credit available for % is % (accrued by the period end, less credit already set off, within the ledger balance) — the set-off uses %.',
            l.source_head, per.period_code, coalesce((liab -> 'credit' ->> l.source_head)::numeric, 0), l.amt using errcode = 'P0001';
        end if;
      end loop;
      -- Electronic cash per head never negative; the ledger as a whole too.
      for l in select source_head, cash_minor_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id and source = 'CASH' group by 1, 2 loop
        if l.amt > coalesce((liab -> 'cash' ->> (l.source_head || ':' || l.cash_minor_head))::numeric, 0) then
          raise exception 'Electronic cash % % available is % — the set-off uses %.', l.source_head, l.cash_minor_head,
            coalesce((liab -> 'cash' ->> (l.source_head || ':' || l.cash_minor_head))::numeric, 0), l.amt using errcode = 'P0001';
        end if;
      end loop;
      if (select coalesce(sum(amount), 0) from public.gst_set_off_lines where set_off_id = s.id and source = 'CASH') > (liab ->> 'cash_ledger')::numeric then
        raise exception 'The GST electronic cash ledger balance is lower than the cash used.' using errcode = 'P0001';
      end if;
      -- Voucher: Dr liabilities / Cr credits and electronic cash.
      for l in select liability_kind, liability_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id group by 1, 2 order by 1, 2 loop
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company,
          case l.liability_kind when 'OUTPUT' then 'OUTPUT_' || l.liability_head when 'RCM' then 'RCM_GST_PAYABLE' when 'INTEREST' then 'GST_INTEREST' else 'GST_LATE_FEE' end, ''),
          'debit', l.amt, 'narration', initcap(lower(l.liability_kind)) || ' ' || l.liability_head || ' ' || per.period_code);
      end loop;
      for l in select source, source_head, sum(amount) as amt from public.gst_set_off_lines where set_off_id = s.id group by 1, 2 order by 1, 2 loop
        v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company, case l.source when 'CREDIT' then 'INPUT_' || l.source_head else 'GST_ELECTRONIC_CASH' end, ''),
          'credit', l.amt, 'narration', case l.source when 'CREDIT' then 'Input ' || l.source_head || ' utilised' else 'Electronic cash ' || l.source_head || ' utilised' end);
      end loop;
      if (select count(*) from public.gst_set_off_lines where set_off_id = s.id and liability_kind in ('OUTPUT', 'RCM') and liability_head = 'CESS' and source = 'CREDIT') > 0
         and private.accounting_rule_account(v_company, 'INPUT_CESS', '') is null then
        raise exception 'Map the Input cess account first.' using errcode = 'P0001';
      end if;
      v_id := private.accounting_create_voucher(v_company, 'GST', private.company_today(v_company), per.period_code,
        left(format('GST set-off for %s', per.period_code), 1000), 'AUTO', 'GST_SET_OFF', s.id, per.period_code, null, v_lines);
      v := private.accounting_post_voucher(v_id);
      update public.gst_set_offs set status = 'POSTED', voucher_id = v.id, posted_by = auth.uid(), posted_at = now(), row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, details, actor_id) values (v_company, s.id, 'POSTED', jsonb_build_object('voucher', v.voucher_number), auth.uid());
    elsif v_action = 'REVERSE' then
      if s.status <> 'POSTED' then
        raise exception 'Only a posted set-off can be reversed.' using errcode = 'P0001';
      end if;
      if length(btrim(coalesce(p ->> 'reason', ''))) < 10 then
        raise exception 'Record why (at least 10 characters).' using errcode = '22023';
      end if;
      v := private.accounting_reverse_voucher(s.voucher_id, 'GST set-off reversed: ' || btrim(p ->> 'reason'), null);
      update public.gst_set_offs set status = 'REVERSED', reversal_voucher_id = v.id, reversed_by = auth.uid(), reversed_at = now(), status_reason = left(btrim(p ->> 'reason'), 1000),
        row_version = row_version + 1 where id = s.id returning * into s;
      insert into public.gst_set_off_events (company_id, set_off_id, action, reason, details, actor_id)
      values (v_company, s.id, 'REVERSED', p ->> 'reason', jsonb_build_object('voucher', v.voucher_number), auth.uid());
    else
      raise exception 'Unknown action %.', p_action using errcode = '22023';
    end if;
  end if;
  perform private.write_audit_log(v_company, 'gst.set_off_' || lower(v_action), 'gst_set_off', s.id::text, jsonb_build_object('period', s.period_id, 'status', s.status));
  return to_jsonb(s) || jsonb_build_object('lines', (select jsonb_agg(to_jsonb(x) - 'company_id' order by x.line_no) from public.gst_set_off_lines x where x.set_off_id = s.id),
    'voucher_number', (select voucher_number from public.accounting_vouchers where id = s.voucher_id));
exception
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'Each set-off line needs liability kind / head, source CREDIT / CASH with its head (and the cash minor head) and a positive amount.' using errcode = '22023';
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
    (-14, 'gst_2b_match_history', 'Accounting', 'GSTR-2B match history'),
    (-14, 'gst_file_access_grants', 'Accounting', 'GST file download grants'),
    (-13, 'gst_2b_matches', 'Accounting', 'GSTR-2B matches'),
    (-12, 'gst_2b_document_versions', 'Accounting', 'GSTR-2B document versions'),
    (-11, 'gst_2b_lines', 'Accounting', 'GSTR-2B imported rows'),
    (-11, 'gst_2b_documents', 'Accounting', 'GSTR-2B supplier documents'),
    (-10, 'gst_2b_imports', 'Accounting', 'GSTR-2B imports'),
    (-13, 'gst_period_current_snapshot', 'Accounting', 'GST current snapshot pointers'),
    (-13, 'gst_snapshot_documents', 'Accounting', 'GST snapshot documents'),
    (-13, 'gst_amendment_exceptions', 'Accounting', 'GST amendment exceptions'),
    (-13, 'gst_set_off_lines', 'Accounting', 'GST set-off lines'),
    (-13, 'gst_set_off_events', 'Accounting', 'GST set-off history'),
    (-13, 'gst_challan_heads', 'Accounting', 'GST challan amounts by head'),
    (-13, 'gst_sales_document_detail_history', 'Accounting', 'GST sales detail history'),
    (-12, 'gst_period_snapshots', 'Accounting', 'GST return snapshots'),
    (-12, 'gst_challan_payments', 'Accounting', 'GST challan payments'),
    (-12, 'gst_set_offs', 'Accounting', 'GST set-offs'),
    (-12, 'gst_period_events', 'Accounting', 'GST period history'),
    (-12, 'gst_return_adjustments', 'Accounting', 'GST return adjustments'),
    (-12, 'gst_sales_document_details', 'Accounting', 'GST sales document details'),
    (-12, 'gst_itc_decisions', 'Accounting', 'ITC decision history'),
    (-12, 'gst_itc_adjustments', 'Accounting', 'ITC reversals and reclaims'),
    (-11, 'gst_challans', 'Accounting', 'GST challans'),
    (-10, 'gst_return_periods', 'Accounting', 'GST return periods'),
    (-10, 'bank_reconciliation_match_items', 'Accounting', 'Bank reconciliation match lines'),
    (-9, 'bank_reconciliation_matches', 'Accounting', 'Bank reconciliation matches'),
    (-9, 'bank_reconciliations', 'Accounting', 'Saved bank reconciliations'),
    (-9, 'bank_statement_files', 'Accounting', 'Imported bank statement files'),
    (-8, 'bank_statement_lines', 'Accounting', 'Imported bank statement lines'),
    (-7, 'bank_statement_imports', 'Accounting', 'Bank statement import batches'),
    (-6, 'bank_transfers', 'Accounting', 'Bank / cash transfers'),
    (-6, 'bank_payment_assignments', 'Accounting', 'Bank / cash account of receipts and payments'),
    (-9, 'purchase_invoice_allocations', 'Accounting', 'Supplier invoice cost-centre splits'),
    (-8, 'purchase_invoice_lines', 'Accounting', 'Supplier invoice lines'),
    (-8, 'purchase_invoice_history', 'Accounting', 'Supplier invoice history'),
    (-8, 'supplier_payment_allocations', 'Accounting', 'Supplier payments allocated to invoices'),
    (-6, 'purchase_invoices', 'Accounting', 'Supplier (purchase) invoices'),
    (-8, 'accounting_cost_allocations', 'Accounting', 'Cost centre allocations'),
    (-4, 'accounting_budget_lines', 'Accounting', 'Cost centre budget lines'),
    (-4, 'accounting_budget_history', 'Accounting', 'Cost centre budget history'),
    (-3, 'accounting_budgets', 'Accounting', 'Cost centre budgets'),
    (-7, 'accounting_voucher_lines', 'Accounting', 'Accounting voucher lines'),
    (-7, 'accounting_opening_balance_lines', 'Accounting', 'Accounting opening balance lines'),
    (-6, 'accounting_posting_events', 'Accounting', 'Automatic accounting posting events'),
    (-6, 'accounting_opening_balance_batches', 'Accounting', 'Accounting opening balance batches'),
    (-5, 'accounting_vouchers', 'Accounting', 'Accounting vouchers'),
    (-3, 'support_call_signals', 'Support Centre', 'Realtime call signals'),
    (0, 'support_ticket_field_values', 'Support Centre', 'Custom ticket field values'),
    (0, 'support_ticket_products', 'Support Centre', 'Products on support tickets'),
    (0, 'support_ticket_field_layout', 'Support Centre', 'New Ticket form layout'),
    (1, 'support_ticket_field_definitions', 'Support Centre', 'Custom ticket fields'),
    (0, 'support_ticket_stage_history', 'Support Centre', 'Ticket stage history'),
    (4, 'support_pipeline_stages', 'Support Centre', 'Pipeline stages'),
    (5, 'support_pipelines', 'Support Centre', 'Support pipelines'),
    (0, 'support_customer_field_values', 'Support Centre', 'Custom customer field values'),
    (0, 'support_customer_activities', 'Support Centre', 'Customer tasks, follow-ups and appointments'),
    (-4, 'support_note_revisions', 'Support Centre', 'Note history'),
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
    (0, 'support_conversation_prefs', 'Support Centre', 'Pinned / muted / favourite conversations'),
    (0, 'support_email_thread_state', 'Support Centre', 'Email starred / snoozed / folder state'),
    (0, 'support_email_sync_queue', 'Support Centre', 'Email sync queue'),
    (1, 'support_email_sync_jobs', 'Support Centre', 'Email full re-sync jobs'),
    (0, 'support_email_sync_state', 'Support Centre', 'Email sync lock and progress'),
    (0, 'support_integration_events', 'Support Centre', 'Support integration events'),
    (-3, 'support_internal_notes', 'Support Centre', 'Support internal notes'),
    (0, 'support_kb_articles', 'Support Centre', 'Knowledge base articles'),
    (0, 'support_ticket_events', 'Support Centre', 'Support ticket history'),
    (1, 'support_messages', 'Support Centre', 'Support messages and calls'),
    (1, 'support_tags', 'Support Centre', 'Support tags'),
    (2, 'support_conversations', 'Support Centre', 'Support conversations'),
    (3, 'support_tickets', 'Support Centre', 'Support tickets'),
    (5, 'support_agents', 'Support Centre', 'Support agents'),
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

create or replace function private.erp_force_reset_storage_objects(p_company uuid)
returns table (bucket text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.bucket_id::text, o.name::text
  from storage.objects o
  where o.bucket_id in ('product-images', 'documents', 'gst-files')
    and o.name like p_company::text || '/%'
    and not exists (select 1 from public.document_versions v join public.documents d on d.id = v.document_id
                    where d.company_id = p_company and d.related_entity_type = 'COMPANY' and v.storage_path = o.name)
  order by 1, 2;
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 11. Grants: signed-in users only (each function checks its permission); the verification record is for the Edge Function (service role) only
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.gst_2b_upload_prepare(jsonb)',
    'public.gst_2b_upload_complete(uuid)',
    'public.gst_2b_verify_target(uuid)',
    'public.gst_2b_imports_list(jsonb)',
    'public.gst_2b_import_get(uuid, jsonb)',
    'public.gst_2b_import_discard(uuid, text)',
    'public.gst_2b_import_commit(uuid, boolean, integer)',
    'public.gst_2b_auto_match(jsonb)',
    'public.gst_2b_match_manual(jsonb)',
    'public.gst_2b_match_decide(uuid, text, text)',
    'public.gst_2b_match_reverse(uuid, text)',
    'public.gst_2b_match_get(uuid)',
    'public.gst_2b_document_get(uuid)',
    'public.gst_2b_report(text, jsonb)',
    'public.gst_2b_file_access(uuid)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
revoke all on function public.gst_2b_verify_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.gst_2b_verify_record(uuid, uuid, jsonb) to service_role;
