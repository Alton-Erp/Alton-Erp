-- =============================================================================
-- Alton Accounts — Phase 5 (Gate B): GST accounting & compliance — database and backend
--
-- Additive. One GST registration per company (equal to companies.gstin), effective-dated GST configuration with maker-checker
-- approval and overlap protection, HSN rate reference (warnings only), GST return periods (monthly / quarterly, no overlaps,
-- frozen once created) with review → approval → close / reopen, insert-only snapshots with per-document content hashes and an
-- amendment-exception queue, return working adjustments, sales GST sidecar details, the ITC decision engine (under review / on
-- hold / partial ITC, reversal / reclaim adjustments, maker-checker), GST challans and payments (CPIN / CIN, Phase 4 bank
-- accounts), and GST set-off. Every accounting effect goes through the voucher engine (GST voucher type); nothing here posts
-- from GSTR returns or imports. GST period control does not lock vouchers (accounting periods keep that role).
--
-- Redefined from their latest text with marked Phase 5 lines: public.purchase_invoice_verify_gst, public.purchase_invoice_reverse,
-- public.purchase_invoice_report, public.accounting_posting_rule_save, private.accounting_seed_chart and the ERP reset registries;
-- the purchase-invoice GST status constraint gains PARTIALLY_ELIGIBLE.
--
-- GSTR-2B import, file storage and server-side checksum verification: Gate C (20261231090600).
-- Rollback: supabase/rollback/20261231090500_accounting_gst_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('gst', 'read',                     'View GST registration, configuration, registers, returns working data and reports'),
  ('gst', 'manage',                   'Maintain the GST registration, configuration drafts / approvals (maker-checker), HSN rates and sales GST details'),
  ('gst_reconciliation', 'read',      'View GST reconciliation (GSTR-2B and ledger reconciliation)'),
  ('gst_reconciliation', 'manage',    'Import GSTR-2B and propose matches'),
  ('gst_reconciliation', 'approve',   'Approve or reject GSTR-2B matches (not your own)'),
  ('gst_returns', 'prepare',          'Prepare GST return working data, adjustments and amendment resolutions'),
  ('gst_returns', 'approve',          'Approve GST return working data, adjustments and amendment resolutions (not your own)'),
  ('gst_payments', 'create',          'Record GST challans, payment attempts and set-off drafts'),
  ('gst_payments', 'post',            'Post GST payments and set-offs (not your own)'),
  ('gst_periods', 'close',            'Close GST return periods'),
  ('gst_periods', 'reopen',           'Reopen approved / closed GST return periods (Super Admin)')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values ('ACCOUNTS_MANAGER', 'gst.read'), ('ACCOUNTS_MANAGER', 'gst.manage'), ('ACCOUNTS_MANAGER', 'gst_reconciliation.read'),
         ('ACCOUNTS_MANAGER', 'gst_reconciliation.manage'), ('ACCOUNTS_MANAGER', 'gst_reconciliation.approve'), ('ACCOUNTS_MANAGER', 'gst_returns.prepare'),
         ('ACCOUNTS_MANAGER', 'gst_returns.approve'), ('ACCOUNTS_MANAGER', 'gst_payments.create'), ('ACCOUNTS_MANAGER', 'gst_payments.post'),
         ('ACCOUNTS_MANAGER', 'gst_periods.close'),
         ('ADMIN', 'gst.read'), ('ADMIN', 'gst_reconciliation.read'), ('MANAGEMENT_VIEWER', 'gst.read'), ('MANAGEMENT_VIEWER', 'gst_reconciliation.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m join public.roles r on r.code = m.role_code join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Posting-rule keys and the purchase-invoice GST status (additive constraint replacements)
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_posting_rules_rule_key_gst_check') then
    alter table public.accounting_posting_rules drop constraint if exists accounting_posting_rules_rule_key_pi_check;
    alter table public.accounting_posting_rules add constraint accounting_posting_rules_rule_key_gst_check check (rule_key in ('DEBTORS', 'CREDITORS', 'SALES',
      'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES', 'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
      'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE',
      'GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_invoices_gst_status_p5_check') then
    execute (select format('alter table public.purchase_invoices drop constraint %I', conname) from pg_constraint
             where conrelid = 'public.purchase_invoices'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%gst_status%PENDING_VERIFICATION%' limit 1);
    alter table public.purchase_invoices add constraint purchase_invoices_gst_status_p5_check
      check (gst_status in ('NOT_APPLICABLE', 'PENDING_VERIFICATION', 'ELIGIBLE', 'INELIGIBLE', 'PARTIALLY_ELIGIBLE'));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------
-- One active registration per company; its GSTIN equals companies.gstin (checked by gst_registration_save). Never created automatically.
create table if not exists public.gst_registrations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete restrict,
  gstin             text not null check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  legal_name        text not null check (length(btrim(legal_name)) between 2 and 200),
  trade_name        text check (trade_name is null or length(trade_name) <= 200),
  address           text check (address is null or length(address) <= 1000),
  state_code        text not null check (state_code ~ '^[0-9]{2}$'),
  registration_type text not null check (registration_type in ('REGULAR', 'COMPOSITION', 'CASUAL', 'SEZ_UNIT', 'SEZ_DEVELOPER', 'ISD', 'OTHER')),
  effective_from    date not null,
  effective_to      date,
  is_active         boolean not null default true,
  notes             text check (notes is null or length(notes) <= 1000),
  row_version       integer not null default 1,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_by        uuid,
  updated_at        timestamptz not null default now(),
  constraint gst_registrations_id_company_unique unique (id, company_id),
  constraint gst_registrations_gstin_unique unique (company_id, gstin),
  constraint gst_registrations_state check (state_code = left(gstin, 2)),
  constraint gst_registrations_dates check (effective_to is null or effective_to >= effective_from)
);
create unique index if not exists gst_registrations_one_active on public.gst_registrations (company_id) where is_active;

-- Filing frequency history (append-only). A return period copies the frequency in force on its start date.
create table if not exists public.gst_registration_frequencies (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  registration_id uuid not null,
  frequency       text not null check (frequency in ('MONTHLY', 'QUARTERLY')),
  effective_from  date not null check (extract(day from effective_from) = 1),
  reason          text check (reason is null or length(reason) <= 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint gst_frequencies_unique unique (registration_id, effective_from),
  constraint gst_frequencies_registration_fk foreign key (registration_id, company_id) references public.gst_registrations (id, company_id) on delete restrict
);

-- Effective-dated configuration with maker-checker approval. Approved / superseded versions never overlap (trigger) and their payload never changes.
create table if not exists public.gst_config_versions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  version_no       integer not null check (version_no >= 1),
  effective_from   date not null,
  effective_to     date,
  status           text not null default 'DRAFT' check (status in ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'REJECTED')),
  payload          jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  validation_errors jsonb not null default '[]'::jsonb,
  notes            text check (notes is null or length(notes) <= 1000),
  prepared_by      uuid,
  prepared_at      timestamptz not null default now(),
  submitted_by     uuid,
  submitted_at     timestamptz,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  review_note      text check (review_note is null or length(review_note) <= 1000),
  superseded_by    uuid,
  row_version      integer not null default 1,
  constraint gst_config_versions_id_company_unique unique (id, company_id),
  constraint gst_config_versions_no_unique unique (company_id, version_no),
  constraint gst_config_versions_dates check (effective_to is null or effective_to >= effective_from),
  constraint gst_config_versions_approved check (status not in ('APPROVED', 'SUPERSEDED') or (reviewed_by is not null and reviewed_at is not null and jsonb_array_length(validation_errors) = 0)),
  constraint gst_config_versions_superseded check ((status = 'SUPERSEDED') = (effective_to is not null and superseded_by is not null)),
  constraint gst_config_versions_maker_checker check (reviewed_by is null or status = 'REJECTED' or reviewed_by is distinct from prepared_by)
);

-- HSN / SAC reference rates (used only to warn when a document's rate differs; never recalculates a document).
create table if not exists public.gst_hsn_rates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  hsn_sac        text not null check (hsn_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  description    text check (description is null or length(description) <= 300),
  gst_rate       numeric(5,2) not null check (gst_rate between 0 and 100),
  effective_from date not null,
  effective_to   date,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  constraint gst_hsn_rates_unique unique (company_id, hsn_sac, effective_from),
  constraint gst_hsn_rates_dates check (effective_to is null or effective_to >= effective_from)
);

create table if not exists public.gst_return_periods (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  registration_id     uuid not null,
  period_code         text not null check (period_code ~ '^[0-9]{4}-([0-9]{2}|Q[1-4])$'),
  frequency           text not null check (frequency in ('MONTHLY', 'QUARTERLY')),
  financial_year      text not null,
  period_start        date not null,
  period_end          date not null,
  status              text not null default 'OPEN' check (status in ('OPEN', 'UNDER_REVIEW', 'READY_FOR_APPROVAL', 'APPROVED', 'CLOSED')),
  prepared_by         uuid,
  prepared_at         timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  closed_by           uuid,
  closed_at           timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  row_version         integer not null default 1,
  constraint gst_return_periods_id_company_unique unique (id, company_id),
  constraint gst_return_periods_start_unique unique (registration_id, period_start),
  constraint gst_return_periods_registration_fk foreign key (registration_id, company_id) references public.gst_registrations (id, company_id) on delete restrict,
  constraint gst_return_periods_shape check (
    extract(day from period_start) = 1 and period_end >= period_start
    and period_end = (date_trunc('month', period_start) + case frequency when 'MONTHLY' then interval '1 month' else interval '3 months' end - interval '1 day')::date)
);
create index if not exists gst_return_periods_company_idx on public.gst_return_periods (company_id, registration_id, financial_year);

create table if not exists public.gst_period_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  period_id   uuid not null,
  action      text not null check (action in ('CREATED', 'REVIEW_STARTED', 'READY', 'RETURNED', 'APPROVED', 'CLOSED', 'REOPENED', 'SNAPSHOT')),
  from_status text,
  to_status   text,
  reason      text check (reason is null or length(reason) <= 1000),
  details     jsonb not null default '{}'::jsonb,
  actor_id    uuid,
  created_at  timestamptz not null default now(),
  constraint gst_period_events_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict
);
create index if not exists gst_period_events_period_idx on public.gst_period_events (period_id, created_at);

-- Insert-only snapshots: nothing about a snapshot is ever updated; a newer version is a new row and the period's pointer moves.
create table if not exists public.gst_period_snapshots (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  period_id         uuid not null,
  version_no        integer not null check (version_no >= 1),
  config_version_id uuid,
  data              jsonb not null,
  totals            jsonb not null,
  snapshot_hash     text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  prepared_by       uuid,
  approved_by       uuid not null,
  created_at        timestamptz not null default now(),
  constraint gst_period_snapshots_id_company_unique unique (id, company_id),
  constraint gst_period_snapshots_version_unique unique (period_id, version_no),
  constraint gst_period_snapshots_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_period_snapshots_config_fk foreign key (config_version_id, company_id) references public.gst_config_versions (id, company_id) on delete restrict,
  constraint gst_period_snapshots_maker_checker check (prepared_by is distinct from approved_by)
);
-- The current snapshot of a period (a pointer, so snapshots themselves are never updated and no foreign-key cycle exists).
create table if not exists public.gst_period_current_snapshot (
  period_id   uuid primary key,
  company_id  uuid not null,
  snapshot_id uuid not null,
  set_at      timestamptz not null default now(),
  constraint gst_current_snapshot_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_current_snapshot_snapshot_fk foreign key (snapshot_id, company_id) references public.gst_period_snapshots (id, company_id) on delete restrict
);

create table if not exists public.gst_snapshot_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  snapshot_id  uuid not null,
  source_kind  text not null check (source_kind in ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PURCHASE_INVOICE', 'ITC_DECISION', 'ITC_ADJUSTMENT')),
  source_id    uuid not null,
  document_no  text,
  document_date date,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  amounts      jsonb not null default '{}'::jsonb,
  constraint gst_snapshot_documents_unique unique (snapshot_id, source_kind, source_id),
  constraint gst_snapshot_documents_id_company_unique unique (id, company_id),
  constraint gst_snapshot_documents_snapshot_fk foreign key (snapshot_id, company_id) references public.gst_period_snapshots (id, company_id) on delete restrict
);

-- Changes found after approval. Assigned to the earliest later OPEN / UNDER_REVIEW period; PENDING_ASSIGNMENT while none exists.
create table if not exists public.gst_amendment_exceptions (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  registration_id      uuid not null,
  origin_period_id     uuid not null,
  snapshot_id          uuid not null,
  snapshot_document_id uuid,
  source_kind          text not null,
  source_id            uuid not null,
  document_no          text,
  kind                 text not null check (kind in ('CHANGED', 'CANCELLED', 'REVERSED', 'LATE_DOCUMENT', 'CONFIG_CHANGED')),
  old_hash             text,
  new_hash             text,
  diff                 jsonb not null default '{}'::jsonb,
  assigned_period_id   uuid,
  status               text not null default 'PENDING_ASSIGNMENT' check (status in ('PENDING_ASSIGNMENT', 'OPEN', 'PROPOSED', 'RESOLVED')),
  resolution           text check (resolution is null or resolution in ('INCLUDED_AS_AMENDMENT', 'NO_RETURN_IMPACT')),
  resolution_reason    text check (resolution_reason is null or length(resolution_reason) <= 1000),
  proposed_by          uuid,
  proposed_at          timestamptz,
  approved_by          uuid,
  approved_at          timestamptz,
  detected_at          timestamptz not null default now(),
  constraint gst_amendments_unique unique (snapshot_id, source_kind, source_id, kind, new_hash),
  constraint gst_amendments_origin_fk foreign key (origin_period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_amendments_assigned_fk foreign key (assigned_period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_amendments_snapshot_fk foreign key (snapshot_id, company_id) references public.gst_period_snapshots (id, company_id) on delete restrict,
  constraint gst_amendments_status check ((status = 'PENDING_ASSIGNMENT') = (assigned_period_id is null)
    and (status not in ('PROPOSED', 'RESOLVED') or (resolution is not null and proposed_by is not null))
    and (status <> 'RESOLVED' or (approved_by is not null and approved_by is distinct from proposed_by)))
);
create index if not exists gst_amendments_assigned_idx on public.gst_amendment_exceptions (assigned_period_id, status);
create index if not exists gst_amendments_pending_idx on public.gst_amendment_exceptions (registration_id) where status = 'PENDING_ASSIGNMENT';

create table if not exists public.gst_return_adjustments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  period_id   uuid not null,
  return_type text not null check (return_type in ('GSTR1', 'GSTR3B')),
  section     text not null check (length(section) between 1 and 60),
  field       text not null check (length(field) between 1 and 60),
  tax_head    text check (tax_head is null or tax_head in ('IGST', 'CGST', 'SGST', 'CESS', 'TAXABLE')),
  amount      numeric(18,2) not null check (amount <> 0),
  reason      text not null check (length(btrim(reason)) between 10 and 1000),
  status      text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'REJECTED')),
  prepared_by uuid not null,
  prepared_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 1000),
  constraint gst_return_adjustments_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_return_adjustments_review check ((status = 'DRAFT') = (reviewed_by is null) and (reviewed_by is null or reviewed_by <> prepared_by))
);

-- GST details of a sales invoice OR a customer note (exactly one), company-checked by composite foreign keys.
create table if not exists public.gst_sales_document_details (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  sales_invoice_id     uuid,
  adjustment_note_id   uuid,
  export_type          text check (export_type is null or export_type in ('WITH_PAYMENT', 'WITHOUT_PAYMENT')),
  shipping_bill_number text check (shipping_bill_number is null or shipping_bill_number ~ '^[0-9A-Za-z/-]{1,30}$'),
  shipping_bill_date   date,
  port_code            text check (port_code is null or port_code ~ '^[A-Z0-9]{6}$'),
  ecommerce_gstin      text check (ecommerce_gstin is null or ecommerce_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  section_override     text check (section_override is null or section_override in ('B2B', 'B2CL', 'B2CS', 'EXP', 'SEZWP', 'SEZWOP', 'DE', 'CDNR', 'CDNUR', 'NIL')),
  override_reason      text check (override_reason is null or length(btrim(override_reason)) between 10 and 500),
  row_version          integer not null default 1,
  updated_by           uuid,
  updated_at           timestamptz not null default now(),
  constraint gst_sales_details_one_source check (num_nonnulls(sales_invoice_id, adjustment_note_id) = 1),
  constraint gst_sales_details_invoice_fk foreign key (sales_invoice_id, company_id) references public.sales_invoices (id, company_id) on delete restrict,
  constraint gst_sales_details_note_fk foreign key (adjustment_note_id, company_id) references public.invoice_adjustment_notes (id, company_id) on delete restrict,
  constraint gst_sales_details_override check ((section_override is null) = (override_reason is null))
);
create unique index if not exists gst_sales_details_invoice_unique on public.gst_sales_document_details (sales_invoice_id) where sales_invoice_id is not null;
create unique index if not exists gst_sales_details_note_unique on public.gst_sales_document_details (adjustment_note_id) where adjustment_note_id is not null;

create table if not exists public.gst_sales_document_detail_history (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  detail_id  uuid not null references public.gst_sales_document_details (id) on delete restrict,
  before     jsonb,
  after      jsonb not null,
  actor_id   uuid,
  created_at timestamptz not null default now()
);

-- ITC decision history (append-only): every review / hold / proposal / decision / rejection / reversal is a new row.
create table if not exists public.gst_itc_decisions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  purchase_invoice_id uuid not null,
  seq                 integer not null check (seq >= 1),
  stage               text not null check (stage in ('UNDER_REVIEW', 'ON_HOLD', 'PROPOSED', 'DECIDED', 'REJECTED', 'DECISION_REVERSED', 'REVERSED_WITH_INVOICE')),
  decision            text check (decision is null or decision in ('ELIGIBLE', 'INELIGIBLE', 'PARTIALLY_ELIGIBLE')),
  proposal_id         uuid,
  pending_cgst        numeric(18,2) not null default 0,
  pending_sgst        numeric(18,2) not null default 0,
  pending_igst        numeric(18,2) not null default 0,
  pending_cess        numeric(18,2) not null default 0,
  eligible_cgst       numeric(18,2) not null default 0 check (eligible_cgst >= 0),
  eligible_sgst       numeric(18,2) not null default 0 check (eligible_sgst >= 0),
  eligible_igst       numeric(18,2) not null default 0 check (eligible_igst >= 0),
  eligible_cess       numeric(18,2) not null default 0 check (eligible_cess >= 0),
  ineligible_cgst     numeric(18,2) not null default 0 check (ineligible_cgst >= 0),
  ineligible_sgst     numeric(18,2) not null default 0 check (ineligible_sgst >= 0),
  ineligible_igst     numeric(18,2) not null default 0 check (ineligible_igst >= 0),
  ineligible_cess     numeric(18,2) not null default 0 check (ineligible_cess >= 0),
  reason              text check (reason is null or length(reason) <= 1000),
  checks              jsonb not null default '{}'::jsonb,
  document_refs       jsonb not null default '[]'::jsonb,
  voucher_id          uuid,
  actor_id            uuid,
  created_at          timestamptz not null default now(),
  constraint gst_itc_decisions_seq_unique unique (purchase_invoice_id, seq),
  constraint gst_itc_decisions_id_company_unique unique (id, company_id),
  constraint gst_itc_decisions_invoice_fk foreign key (purchase_invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict,
  constraint gst_itc_decisions_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_itc_decisions_split check (stage not in ('PROPOSED', 'DECIDED') or (
    eligible_cgst + ineligible_cgst = pending_cgst and eligible_sgst + ineligible_sgst = pending_sgst
    and eligible_igst + ineligible_igst = pending_igst and eligible_cess + ineligible_cess = pending_cess))
);

create table if not exists public.gst_itc_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  purchase_invoice_id uuid not null,
  kind                text not null check (kind in ('REVERSAL', 'RECLAIM')),
  cgst                numeric(18,2) not null default 0 check (cgst >= 0),
  sgst                numeric(18,2) not null default 0 check (sgst >= 0),
  igst                numeric(18,2) not null default 0 check (igst >= 0),
  cess                numeric(18,2) not null default 0 check (cess >= 0),
  reason              text not null check (length(btrim(reason)) between 10 and 1000),
  document_refs       jsonb not null default '[]'::jsonb,
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),
  voucher_id          uuid,
  reversal_voucher_id uuid,
  prepared_by         uuid not null,
  prepared_at         timestamptz not null default now(),
  posted_by           uuid,
  posted_at           timestamptz,
  reversed_by         uuid,
  reversed_at         timestamptz,
  status_reason       text check (status_reason is null or length(status_reason) <= 1000),
  row_version         integer not null default 1,
  constraint gst_itc_adjustments_id_company_unique unique (id, company_id),
  constraint gst_itc_adjustments_invoice_fk foreign key (purchase_invoice_id, company_id) references public.purchase_invoices (id, company_id) on delete restrict,
  constraint gst_itc_adjustments_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_itc_adjustments_reversal_fk foreign key (reversal_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_itc_adjustments_amount check (cgst + sgst + igst + cess > 0),
  constraint gst_itc_adjustments_posted check ((status in ('POSTED', 'REVERSED')) = (voucher_id is not null and posted_by is not null)
    and (posted_by is null or posted_by <> prepared_by) and (status = 'REVERSED') = (reversal_voucher_id is not null))
);
create index if not exists gst_itc_adjustments_invoice_idx on public.gst_itc_adjustments (purchase_invoice_id, status);

-- Challans (CPIN) and their payment attempts; at most one successful payment per challan; CIN unique.
create table if not exists public.gst_challans (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  registration_id uuid not null,
  period_id       uuid,
  cpin            text not null,
  challan_date    date not null,
  expiry_date     date,
  total_amount    numeric(18,2) not null check (total_amount > 0),
  status          text not null default 'CREATED' check (status in ('CREATED', 'PAID', 'EXPIRED', 'CANCELLED')),
  status_reason   text check (status_reason is null or length(status_reason) <= 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  row_version     integer not null default 1,
  constraint gst_challans_id_company_unique unique (id, company_id),
  constraint gst_challans_cpin_unique unique (registration_id, cpin),
  constraint gst_challans_registration_fk foreign key (registration_id, company_id) references public.gst_registrations (id, company_id) on delete restrict,
  constraint gst_challans_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_challans_expiry check (expiry_date is null or expiry_date >= challan_date)
);
create table if not exists public.gst_challan_heads (
  challan_id uuid not null,
  company_id uuid not null,
  major_head text not null check (major_head in ('IGST', 'CGST', 'SGST', 'CESS')),
  minor_head text not null check (minor_head in ('TAX', 'INTEREST', 'PENALTY', 'FEE', 'OTHER')),
  amount     numeric(18,2) not null check (amount > 0),
  primary key (challan_id, major_head, minor_head),
  constraint gst_challan_heads_challan_fk foreign key (challan_id, company_id) references public.gst_challans (id, company_id) on delete restrict
);
create table if not exists public.gst_challan_payments (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  challan_id           uuid not null,
  attempt_no           integer not null check (attempt_no >= 1),
  mode                 text not null check (mode in ('NET_BANKING', 'OTC', 'NEFT_RTGS', 'CARD', 'UPI', 'OTHER')),
  bank_cash_account_id uuid,
  payment_date         date not null,
  amount               numeric(18,2) not null check (amount > 0),
  bank_reference       text check (bank_reference is null or length(bank_reference) between 4 and 60),
  brn                  text check (brn is null or length(brn) between 4 and 60),
  cin                  text,
  status               text not null check (status in ('INITIATED', 'FAILED', 'SUCCESS', 'REVERSED')),
  failure_reason       text check (failure_reason is null or length(failure_reason) <= 500),
  statement_line_id    uuid,
  voucher_id           uuid,
  reversal_voucher_id  uuid,
  recorded_by          uuid not null,
  recorded_at          timestamptz not null default now(),
  posted_by            uuid,
  posted_at            timestamptz,
  reversed_by          uuid,
  reversed_at          timestamptz,
  reversal_reason      text check (reversal_reason is null or length(reversal_reason) <= 500),
  constraint gst_challan_payments_id_company_unique unique (id, company_id),
  constraint gst_challan_payments_attempt_unique unique (challan_id, attempt_no),
  constraint gst_challan_payments_challan_fk foreign key (challan_id, company_id) references public.gst_challans (id, company_id) on delete restrict,
  constraint gst_challan_payments_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint gst_challan_payments_statement_fk foreign key (statement_line_id, company_id) references public.bank_statement_lines (id, company_id) on delete restrict,
  constraint gst_challan_payments_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_challan_payments_reversal_fk foreign key (reversal_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_challan_payments_success check (status not in ('SUCCESS', 'REVERSED') or (cin is not null and bank_cash_account_id is not null)),
  constraint gst_challan_payments_posted check ((voucher_id is not null) = (posted_by is not null) and (posted_by is null or posted_by <> recorded_by)
    and (voucher_id is null or status in ('SUCCESS', 'REVERSED')) and (status = 'REVERSED') = (reversal_voucher_id is not null))
);
create unique index if not exists gst_challan_payments_one_success on public.gst_challan_payments (challan_id) where status = 'SUCCESS';
create unique index if not exists gst_challan_payments_cin_unique on public.gst_challan_payments (company_id, cin) where cin is not null;
create unique index if not exists gst_challan_payments_bankref_unique on public.gst_challan_payments (company_id, bank_reference) where status = 'SUCCESS' and bank_reference is not null;

create table if not exists public.gst_set_offs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  registration_id     uuid not null,
  period_id           uuid not null,
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),
  voucher_id          uuid,
  reversal_voucher_id uuid,
  notes               text check (notes is null or length(notes) <= 1000),
  prepared_by         uuid not null,
  prepared_at         timestamptz not null default now(),
  posted_by           uuid,
  posted_at           timestamptz,
  reversed_by         uuid,
  reversed_at         timestamptz,
  status_reason       text check (status_reason is null or length(status_reason) <= 1000),
  row_version         integer not null default 1,
  constraint gst_set_offs_id_company_unique unique (id, company_id),
  constraint gst_set_offs_period_fk foreign key (period_id, company_id) references public.gst_return_periods (id, company_id) on delete restrict,
  constraint gst_set_offs_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_set_offs_reversal_fk foreign key (reversal_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint gst_set_offs_posted check ((status in ('POSTED', 'REVERSED')) = (voucher_id is not null and posted_by is not null)
    and (posted_by is null or posted_by <> prepared_by) and (status = 'REVERSED') = (reversal_voucher_id is not null))
);
create unique index if not exists gst_set_offs_one_posted on public.gst_set_offs (period_id) where status = 'POSTED';
create table if not exists public.gst_set_off_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  set_off_id        uuid not null,
  line_no           integer not null check (line_no between 1 and 200),
  liability_kind    text not null check (liability_kind in ('OUTPUT', 'RCM', 'INTEREST', 'LATE_FEE')),
  liability_head    text not null check (liability_head in ('IGST', 'CGST', 'SGST', 'CESS')),
  source            text not null check (source in ('CREDIT', 'CASH')),
  source_head       text not null check (source_head in ('IGST', 'CGST', 'SGST', 'CESS')),
  cash_minor_head   text check (cash_minor_head is null or cash_minor_head in ('TAX', 'INTEREST', 'PENALTY', 'FEE', 'OTHER')),
  amount            numeric(18,2) not null check (amount > 0),
  constraint gst_set_off_lines_unique unique (set_off_id, line_no),
  constraint gst_set_off_lines_set_off_fk foreign key (set_off_id, company_id) references public.gst_set_offs (id, company_id) on delete restrict,
  constraint gst_set_off_lines_source check ((source = 'CASH') = (cash_minor_head is not null)
    and (liability_kind in ('OUTPUT', 'RCM') or source = 'CASH'))
);
create table if not exists public.gst_set_off_events (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  set_off_id uuid not null,
  action     text not null check (action in ('SAVED', 'POSTED', 'REVERSED', 'CANCELLED')),
  reason     text,
  details    jsonb not null default '{}'::jsonb,
  actor_id   uuid,
  created_at timestamptz not null default now(),
  constraint gst_set_off_events_set_off_fk foreign key (set_off_id, company_id) references public.gst_set_offs (id, company_id) on delete restrict
);

do $$
declare
  t text;
begin
  foreach t in array array['gst_registrations', 'gst_registration_frequencies', 'gst_config_versions', 'gst_hsn_rates', 'gst_return_periods', 'gst_period_events',
                           'gst_period_snapshots', 'gst_period_current_snapshot', 'gst_snapshot_documents', 'gst_amendment_exceptions', 'gst_return_adjustments', 'gst_sales_document_details',
                           'gst_sales_document_detail_history', 'gst_itc_decisions', 'gst_itc_adjustments', 'gst_challans', 'gst_challan_heads',
                           'gst_challan_payments', 'gst_set_offs', 'gst_set_off_lines', 'gst_set_off_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))', t || '_select', t,
      case when t in ('gst_itc_decisions', 'gst_itc_adjustments') then 'purchase_invoices.read' else 'gst.read' end);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Guards
-- -----------------------------------------------------------------------------
-- Append-only / insert-only tables: no UPDATE, no DELETE (only the reviewed force-reset exemption may delete).
create or replace function private.gst_insert_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.erp_force_purge_allows(tg_table_name, old.company_id) then
    return old;
  end if;
  raise exception '% rows are permanent GST history: they cannot be updated or deleted.', tg_table_name using errcode = '42501';
end;
$$;
revoke all on function private.gst_insert_only_guard() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['gst_registration_frequencies', 'gst_period_events', 'gst_period_snapshots', 'gst_snapshot_documents', 'gst_sales_document_detail_history',
                           'gst_itc_decisions', 'gst_set_off_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_insert_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.gst_insert_only_guard()', t || '_insert_only', t);
  end loop;
end;
$$;

-- Return periods: dates, frequency and registration are frozen; no overlaps for a registration (serialized by an advisory lock).
create or replace function private.gst_period_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_clash text;
begin
  if tg_op = 'UPDATE' then
    if new.period_start <> old.period_start or new.period_end <> old.period_end or new.frequency <> old.frequency or new.registration_id <> old.registration_id
       or new.period_code <> old.period_code or new.company_id <> old.company_id then
      raise exception 'The dates, frequency and registration of a GST return period never change.' using errcode = '42501';
    end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_periods:' || new.registration_id::text, 0));
  select p.period_code into v_clash from public.gst_return_periods p
  where p.registration_id = new.registration_id and p.id <> new.id
    and daterange(p.period_start, p.period_end, '[]') && daterange(new.period_start, new.period_end, '[]') limit 1;
  if v_clash is not null then
    raise exception 'GST return period % overlaps the existing period %.', new.period_code, v_clash using errcode = '23P01';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_period_guard() from public, anon, authenticated;
drop trigger if exists gst_return_periods_guard on public.gst_return_periods;
create trigger gst_return_periods_guard before insert or update on public.gst_return_periods for each row execute function private.gst_period_guard();

-- Configuration: approved / superseded payloads never change; approved and superseded ranges never overlap (advisory lock per company).
create or replace function private.gst_config_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_clash integer;
begin
  if tg_op = 'UPDATE' and old.status in ('APPROVED', 'SUPERSEDED', 'REJECTED') then
    if old.status = 'APPROVED' and new.status = 'SUPERSEDED'
       and (to_jsonb(new) - array['status', 'effective_to', 'superseded_by', 'row_version']) = (to_jsonb(old) - array['status', 'effective_to', 'superseded_by', 'row_version'])
       and new.effective_to >= old.effective_from then
      null;
    else
      raise exception 'An approved, superseded or rejected GST configuration version cannot be changed.' using errcode = '42501';
    end if;
  end if;
  if new.status in ('APPROVED', 'SUPERSEDED') then
    perform pg_advisory_xact_lock(hashtextextended('gst_config:' || new.company_id::text, 0));
    select c.version_no into v_clash from public.gst_config_versions c
    where c.company_id = new.company_id and c.id <> new.id and c.status in ('APPROVED', 'SUPERSEDED')
      and daterange(c.effective_from, c.effective_to, '[]') && daterange(new.effective_from, new.effective_to, '[]') limit 1;
    if v_clash is not null then
      raise exception 'GST configuration version % would overlap version % (effective dates).', new.version_no, v_clash using errcode = '23P01';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.gst_config_guard() from public, anon, authenticated;
drop trigger if exists gst_config_versions_guard on public.gst_config_versions;
create trigger gst_config_versions_guard before insert or update on public.gst_config_versions for each row execute function private.gst_config_guard();

-- Posted ITC adjustments, challan payments and set-offs change only by their own state moves (handled by the RPCs; checks enforce the shape).
create or replace function private.gst_posted_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_keep text[] := array['status', 'reversal_voucher_id', 'reversed_by', 'reversed_at', 'reversal_reason', 'status_reason', 'row_version'];
begin
  if old.status in ('REVERSED', 'CANCELLED') then
    raise exception 'A reversed or cancelled % row cannot be changed.', tg_table_name using errcode = '42501';
  end if;
  if old.voucher_id is not null and (to_jsonb(new) - v_keep) <> (to_jsonb(old) - v_keep) then
    raise exception 'A posted % row cannot be changed; reverse it instead.', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.gst_posted_guard() from public, anon, authenticated;
drop trigger if exists gst_itc_adjustments_guard on public.gst_itc_adjustments;
create trigger gst_itc_adjustments_guard before update on public.gst_itc_adjustments for each row execute function private.gst_posted_guard();
drop trigger if exists gst_challan_payments_guard on public.gst_challan_payments;
create trigger gst_challan_payments_guard before update on public.gst_challan_payments for each row execute function private.gst_posted_guard();
drop trigger if exists gst_set_offs_guard on public.gst_set_offs;
create trigger gst_set_offs_guard before update on public.gst_set_offs for each row execute function private.gst_posted_guard();

-- -----------------------------------------------------------------------------
-- 5. Voucher type and GST ledgers
-- -----------------------------------------------------------------------------
-- The three GST ledgers are created only through an explicit, validated setup: an exact existing match is reused; any conflicting
-- code, system key, name or nature raises an actionable error and nothing is created or altered.
create or replace function private.gst_ledgers_ensure(p_company uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r          record;
  a          public.accounts;
  g          public.account_groups;
  v_rule     uuid;
  v_conflict text[] := '{}';
  v_out      jsonb := '[]'::jsonb;
begin
  for r in select * from (values
      ('GST_ELECTRONIC_CASH', '1524', 'GST Electronic Cash Ledger', 'AS.CA.TAX', 'ASSET', 'DEBIT', 'TAX'),
      ('GST_INTEREST', '5920', 'GST Interest', 'EX.IND', 'EXPENSE', 'DEBIT', 'GENERAL'),
      ('GST_LATE_FEE', '5930', 'GST Late Fee & Penalty', 'EX.IND', 'EXPENSE', 'DEBIT', 'GENERAL')) x (skey, code, name, grp, cls, nb, nature) loop
    v_rule := private.accounting_rule_account(p_company, r.skey, '');
    if v_rule is not null then
      continue;  -- already mapped (to this ledger or to a compatible ledger the user chose)
    end if;
    select * into g from public.account_groups where company_id = p_company and group_code = r.grp;
    if not found then
      v_conflict := v_conflict || format('%s %s: account group %s is missing from the chart.', r.code, r.name, r.grp);
      continue;
    end if;
    select * into a from public.accounts where company_id = p_company and account_code = r.code;
    if found and (a.system_key is distinct from r.skey or a.account_nature <> r.nature or a.classification <> r.cls) then
      v_conflict := v_conflict || format('Code %s is already used by "%s" (%s, nature %s). Rename that account, or map an existing compatible ledger to rule %s in Accounting Settings.',
        r.code, a.account_name, coalesce(a.system_key, 'no system key'), a.account_nature, r.skey);
      continue;
    end if;
    if not found and exists (select 1 from public.accounts x where x.company_id = p_company and x.system_key = r.skey) then
      v_conflict := v_conflict || format('System key %s is already on account %s. Map that account to rule %s instead.', r.skey,
        (select account_code from public.accounts where company_id = p_company and system_key = r.skey), r.skey);
      continue;
    end if;
    if not found and exists (select 1 from public.accounts x where x.company_id = p_company and lower(x.account_name) = lower(r.name)) then
      v_conflict := v_conflict || format('An account named "%s" already exists with code %s. Map it to rule %s if it is the right ledger, or rename it.', r.name,
        (select account_code from public.accounts where company_id = p_company and lower(account_name) = lower(r.name) limit 1), r.skey);
      continue;
    end if;
    v_out := v_out || jsonb_build_object('rule_key', r.skey, 'code', r.code, 'name', r.name, 'group_id', g.id, 'classification', r.cls, 'normal_balance', r.nb,
      'nature', r.nature, 'existing_id', a.id);
  end loop;
  if cardinality(v_conflict) > 0 then
    raise exception 'GST ledgers cannot be set up: %', array_to_string(v_conflict, ' ') using errcode = 'P0001';
  end if;
  for r in select x from jsonb_array_elements(v_out) x loop
    if nullif(r.x ->> 'existing_id', '') is null then
      insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature, is_system, system_key)
      values (p_company, r.x ->> 'code', r.x ->> 'name', (r.x ->> 'group_id')::uuid, r.x ->> 'classification', r.x ->> 'normal_balance', r.x ->> 'nature', true, r.x ->> 'rule_key')
      returning * into a;
    else
      select * into a from public.accounts where id = (r.x ->> 'existing_id')::uuid;
    end if;
    insert into public.accounting_posting_rules (company_id, rule_key, account_id) values (p_company, r.x ->> 'rule_key', a.id)
    on conflict (company_id, rule_key, match_value) do nothing;
  end loop;
  return jsonb_build_object('created_or_mapped', jsonb_array_length(v_out));
end;
$$;
revoke all on function private.gst_ledgers_ensure(uuid) from public, anon, authenticated, service_role;

create or replace function private.accounting_seed_gst(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  values (p_company, 'GST', 'GST adjustment', 'GST', false)
  on conflict (company_id, type_code) do nothing;
end;
$$;
revoke all on function private.accounting_seed_gst(uuid) from public, anon, authenticated, service_role;

do $$
declare
  c uuid;
begin
  for c in select company_id from public.accounting_settings loop
    perform private.accounting_seed_gst(c);   -- voucher type only; ledgers need the explicit gst_ledgers_setup()
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Helpers
-- -----------------------------------------------------------------------------
create or replace function private.gst_hash(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p, 'null'::jsonb)::text, 'UTF8')), 'hex');
$$;

create or replace function private.gst_registration_of(p_company uuid)
returns public.gst_registrations
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.gst_registrations;
begin
  select * into r from public.gst_registrations where company_id = p_company and is_active;
  if not found then
    raise exception 'Set up the GST registration first (Accounts › GST › Settings).' using errcode = 'P0001';
  end if;
  return r;
end;
$$;

-- The approved configuration in force on a date (null when none).
create or replace function private.gst_config_on(p_company uuid, p_date date)
returns public.gst_config_versions
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.gst_config_versions where company_id = p_company and status in ('APPROVED', 'SUPERSEDED')
    and p_date >= effective_from and (effective_to is null or p_date <= effective_to) limit 1;
$$;

-- Configuration validation: an invalid or incomplete payload can never be approved.
create or replace function private.gst_config_validate(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  e      jsonb := '[]'::jsonb;
  v_h    text;
  v_r    jsonb;
  v_x    text;
begin
  if jsonb_typeof(p -> 'gst_rates') <> 'array' or jsonb_array_length(p -> 'gst_rates') = 0
     or exists (select 1 from jsonb_array_elements(p -> 'gst_rates') x where jsonb_typeof(x) <> 'number' or x::text::numeric < 0 or x::text::numeric > 100
                or x::text::numeric <> round(x::text::numeric, 2)) then
    e := e || to_jsonb('gst_rates: a non-empty list of rates between 0 and 100 (2 decimals).'::text);
  end if;
  if jsonb_typeof(p -> 'b2cl_invoice_threshold') <> 'number' or (p ->> 'b2cl_invoice_threshold')::numeric <= 0 then
    e := e || to_jsonb('b2cl_invoice_threshold: the invoice value above which inter-state B2C invoices are reported individually (a positive amount).'::text);
  end if;
  for v_x in select unnest(array['gstr1_monthly_day', 'gstr1_quarterly_day', 'gstr3b_monthly_day', 'gstr3b_quarterly_day']) loop
    if jsonb_typeof(p -> 'due_days' -> v_x) <> 'number' or (p -> 'due_days' ->> v_x)::numeric not between 1 and 31 then
      e := e || to_jsonb(format('due_days.%s: a day of the following month (1-31).', v_x));
    end if;
  end loop;
  if jsonb_typeof(p -> 'uqc_map') <> 'object' or exists (select 1 from jsonb_each_text(p -> 'uqc_map') x where x.value !~ '^[A-Z]{3}$') then
    e := e || to_jsonb('uqc_map: unit → three-letter UQC, e.g. {"PCS": "PCS", "KG": "KGS"}.'::text);
  end if;
  if jsonb_typeof(p -> 'set_off_matrix') <> 'object' then
    e := e || to_jsonb('set_off_matrix: for each liability head (IGST, CGST, SGST, CESS) the credit heads that may pay it.'::text);
  else
    foreach v_h in array array['IGST', 'CGST', 'SGST', 'CESS'] loop
      v_r := p -> 'set_off_matrix' -> v_h;
      if jsonb_typeof(v_r) <> 'array' or jsonb_array_length(v_r) = 0
         or exists (select 1 from jsonb_array_elements_text(v_r) x where x not in ('IGST', 'CGST', 'SGST', 'CESS')) then
        e := e || to_jsonb(format('set_off_matrix.%s: a non-empty list of credit heads.', v_h));
      elsif (v_h = 'CESS' and v_r <> '["CESS"]'::jsonb) or (v_h <> 'CESS' and v_r ? 'CESS') then
        e := e || to_jsonb('set_off_matrix: cess credit may pay only cess, and cess only from cess credit.'::text);
      end if;
    end loop;
  end if;
  if coalesce(p ->> 'set_off_order', '') not in ('IGST_FIRST', 'NONE') then
    e := e || to_jsonb('set_off_order: IGST_FIRST or NONE.'::text);
  end if;
  if jsonb_typeof(p -> 'rcm_cash_only') <> 'boolean' then
    e := e || to_jsonb('rcm_cash_only: true / false — whether reverse-charge liability may be paid only in cash.'::text);
  end if;
  if jsonb_typeof(p -> 'challan') <> 'object' or coalesce(p -> 'challan' ->> 'cpin_pattern', '') = '' or coalesce(p -> 'challan' ->> 'cin_pattern', '') = ''
     or jsonb_typeof(p -> 'challan' -> 'cin_starts_with_cpin') <> 'boolean' then
    e := e || to_jsonb('challan: {cpin_pattern, cin_pattern, cin_starts_with_cpin} — the reference formats to validate.'::text);
  else
    begin
      perform '' ~ (p -> 'challan' ->> 'cpin_pattern');
      perform '' ~ (p -> 'challan' ->> 'cin_pattern');
    exception when others then
      e := e || to_jsonb('challan: cpin_pattern / cin_pattern must be valid regular expressions.'::text);
    end;
  end if;
  if jsonb_typeof(p -> 'section_map') <> 'object' or not (p -> 'section_map' ?& array['B2B', 'B2CL', 'B2CS', 'EXP', 'CDNR', 'CDNUR', 'NIL']) then
    e := e || to_jsonb('section_map: descriptions for B2B, B2CL, B2CS, EXP, CDNR, CDNUR and NIL (how supplies map to GSTR-1 sections).'::text);
  end if;
  return e;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return e || to_jsonb('A number in the configuration is not valid.'::text);
end;
$$;

-- Ledger movement of a rule account between dates (posted / reversed vouchers), optionally excluding a voucher source type.
create or replace function private.gst_ledger_movement(p_company uuid, p_rule text, p_from date, p_to date, p_exclude_source text default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  where l.account_id = private.accounting_rule_account(p_company, p_rule, '') and v.company_id = p_company and v.status in ('POSTED', 'REVERSED')
    and (p_from is null or v.voucher_date >= p_from) and (p_to is null or v.voucher_date <= p_to)
    and (p_exclude_source is null or v.source_type is distinct from p_exclude_source);
$$;

revoke all on function private.gst_hash(jsonb) from public, anon, authenticated;
revoke all on function private.gst_registration_of(uuid) from public, anon, authenticated;
revoke all on function private.gst_config_on(uuid, date) from public, anon, authenticated;
revoke all on function private.gst_config_validate(jsonb) from public, anon, authenticated;
revoke all on function private.gst_ledger_movement(uuid, text, date, date, text) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 7. Registration, filing frequency, configuration, HSN rates, ledgers
-- -----------------------------------------------------------------------------
create or replace function private.gst_fy_start_month(p_company uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select fy_start_month from public.accounting_settings where company_id = p_company),
                  (select fy_start_month from public.invoice_settings where company_id = p_company), 4);
$$;
revoke all on function private.gst_fy_start_month(uuid) from public, anon, authenticated;

create or replace function public.gst_registration_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  r         public.gst_registrations;
  c         public.companies;
  v_gstin   text := upper(btrim(coalesce(p ->> 'gstin', '')));
  v_type    text := upper(coalesce(p ->> 'registration_type', 'REGULAR'));
  v_from    date := private.accounting_date(p, 'effective_from', 'Effective from');
  v_freq    text := upper(nullif(p ->> 'frequency', ''));
  v_ffrom   date := private.accounting_date(p, 'frequency_effective_from', 'Frequency effective from');
begin
  select * into c from public.companies where id = v_company;
  if c.gstin is null then
    raise exception 'The company has no GSTIN. Set it in the company profile first; GST registrations are never invented.' using errcode = 'P0001';
  end if;
  if v_gstin <> c.gstin then
    raise exception 'The GST registration must use the company GSTIN % (one registration per company in this phase).', c.gstin using errcode = 'P0001';
  end if;
  if v_type not in ('REGULAR', 'COMPOSITION', 'CASUAL', 'SEZ_UNIT', 'SEZ_DEVELOPER', 'ISD', 'OTHER') then
    raise exception 'Unknown registration type %.', v_type using errcode = '22023';
  end if;
  select * into r from public.gst_registrations where company_id = v_company and is_active for update;
  if not found then
    if v_from is null or v_freq not in ('MONTHLY', 'QUARTERLY') or v_ffrom is null then
      raise exception 'A new registration needs its effective date and a filing frequency (MONTHLY / QUARTERLY) with its start month.' using errcode = '22023';
    end if;
    insert into public.gst_registrations (company_id, gstin, legal_name, trade_name, address, state_code, registration_type, effective_from, notes, created_by, updated_by)
    values (v_company, v_gstin, coalesce(private.accounting_text(p, 'legal_name', 200, 'Legal name'), c.legal_name), private.accounting_text(p, 'trade_name', 200, 'Trade name'),
      coalesce(private.accounting_text(p, 'address', 1000, 'Address'), c.legal_address), left(v_gstin, 2), v_type, v_from,
      private.accounting_text(p, 'notes', 1000, 'Notes'), auth.uid(), auth.uid())
    returning * into r;
    if extract(day from v_ffrom) <> 1 then
      raise exception 'The filing frequency starts on the first day of a month.' using errcode = '22023';
    end if;
    insert into public.gst_registration_frequencies (company_id, registration_id, frequency, effective_from, reason, created_by)
    values (v_company, r.id, v_freq, v_ffrom, 'Initial filing frequency', auth.uid());
  else
    update public.gst_registrations set legal_name = coalesce(private.accounting_text(p, 'legal_name', 200, 'Legal name'), legal_name),
      trade_name = private.accounting_text(p, 'trade_name', 200, 'Trade name'), address = coalesce(private.accounting_text(p, 'address', 1000, 'Address'), address),
      registration_type = v_type, notes = private.accounting_text(p, 'notes', 1000, 'Notes'), updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
    where id = r.id returning * into r;
  end if;
  perform private.write_audit_log(v_company, 'gst.registration_saved', 'gst_registration', r.id::text, jsonb_build_object('gstin', r.gstin, 'type', r.registration_type));
  return to_jsonb(r);
end;
$$;

-- A new filing frequency from a month onward; never inside an existing return period; quarterly starts on a quarter of the financial year.
create or replace function public.gst_frequency_add(p_frequency text, p_effective_from date, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  r         public.gst_registrations := private.gst_registration_of(v_company);
  v_freq    text := upper(coalesce(p_frequency, ''));
  v_last    date;
begin
  if v_freq not in ('MONTHLY', 'QUARTERLY') or p_effective_from is null or extract(day from p_effective_from) <> 1 then
    raise exception 'Choose MONTHLY or QUARTERLY from the first day of a month.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Record why the filing frequency changes (at least 5 characters).' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('gst_periods:' || r.id::text, 0));
  select max(effective_from) into v_last from public.gst_registration_frequencies where registration_id = r.id;
  if p_effective_from <= v_last then
    raise exception 'A new filing frequency must start after the current one (from %).', v_last using errcode = 'P0001';
  end if;
  if v_freq = 'QUARTERLY' and mod((extract(month from p_effective_from)::int - private.gst_fy_start_month(v_company) + 12), 3) <> 0 then
    raise exception 'A quarterly frequency starts on the first month of a financial-year quarter.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.gst_return_periods where registration_id = r.id and period_end >= p_effective_from) then
    raise exception 'GST return periods already exist on or after %; the frequency of existing periods never changes.', p_effective_from using errcode = 'P0001';
  end if;
  insert into public.gst_registration_frequencies (company_id, registration_id, frequency, effective_from, reason, created_by)
  values (v_company, r.id, v_freq, p_effective_from, btrim(p_reason), auth.uid());
  perform private.write_audit_log(v_company, 'gst.frequency_added', 'gst_registration', r.id::text, jsonb_build_object('frequency', v_freq, 'from', p_effective_from));
  return jsonb_build_object('frequency', v_freq, 'effective_from', p_effective_from);
end;
$$;

create or replace function public.gst_config_save(p_id uuid, p_effective_from date, p_payload jsonb, p_notes text default null, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  v         public.gst_config_versions;
  v_errors  jsonb;
begin
  if p_effective_from is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'The configuration needs an effective date and a payload object.' using errcode = '22023';
  end if;
  v_errors := private.gst_config_validate(p_payload);
  if p_id is null then
    perform pg_advisory_xact_lock(hashtextextended('gst_config:' || v_company::text, 0));
    insert into public.gst_config_versions (company_id, version_no, effective_from, payload, validation_errors, notes, prepared_by)
    values (v_company, coalesce((select max(version_no) from public.gst_config_versions where company_id = v_company), 0) + 1, p_effective_from, p_payload, v_errors,
      left(p_notes, 1000), auth.uid())
    returning * into v;
  else
    select * into v from public.gst_config_versions where id = p_id and company_id = v_company for update;
    if not found then
      raise exception 'Configuration version not found.' using errcode = 'P0002';
    end if;
    if v.status <> 'DRAFT' then
      raise exception 'Only a draft configuration can be edited (version % is %).', v.version_no, lower(v.status) using errcode = 'P0001';
    end if;
    if p_row_version is not null and v.row_version <> p_row_version then
      raise exception 'This configuration was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    update public.gst_config_versions set effective_from = p_effective_from, payload = p_payload, validation_errors = v_errors, notes = left(p_notes, 1000),
      prepared_by = auth.uid(), prepared_at = now(), row_version = row_version + 1 where id = v.id returning * into v;
  end if;
  perform private.write_audit_log(v_company, 'gst.config_saved', 'gst_config_version', v.id::text, jsonb_build_object('version', v.version_no, 'errors', jsonb_array_length(v_errors)));
  return to_jsonb(v);
end;
$$;

create or replace function public.gst_config_submit(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  v         public.gst_config_versions;
begin
  select * into v from public.gst_config_versions where id = p_id and company_id = v_company for update;
  if not found or v.status <> 'DRAFT' then
    raise exception 'Only a draft configuration can be submitted for review.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(private.gst_config_validate(v.payload)) > 0 then
    raise exception 'The configuration is incomplete or invalid: %', private.gst_config_validate(v.payload) ->> 0 using errcode = 'P0001';
  end if;
  update public.gst_config_versions set status = 'IN_REVIEW', submitted_by = auth.uid(), submitted_at = now(), row_version = row_version + 1 where id = v.id returning * into v;
  perform private.write_audit_log(v_company, 'gst.config_submitted', 'gst_config_version', v.id::text, jsonb_build_object('version', v.version_no));
  return to_jsonb(v);
end;
$$;

-- Approval (checker ≠ preparer, always). Effective dates never overlap; the version in force before becomes SUPERSEDED with its historical range kept.
create or replace function public.gst_config_approve(p_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  v         public.gst_config_versions;
  v_errors  jsonb;
  v_prev    public.gst_config_versions;
begin
  perform pg_advisory_xact_lock(hashtextextended('gst_config:' || v_company::text, 0));
  select * into v from public.gst_config_versions where id = p_id and company_id = v_company for update;
  if not found or v.status <> 'IN_REVIEW' then
    raise exception 'Only a configuration in review can be approved.' using errcode = 'P0001';
  end if;
  if v.prepared_by = auth.uid() or v.submitted_by = auth.uid() then
    raise exception 'Maker-checker: the person who prepared or submitted a GST configuration cannot approve it.' using errcode = '42501';
  end if;
  v_errors := private.gst_config_validate(v.payload);
  if jsonb_array_length(v_errors) > 0 then
    raise exception 'The configuration is invalid: %', v_errors ->> 0 using errcode = 'P0001';
  end if;
  if exists (select 1 from public.gst_config_versions where company_id = v_company and status in ('APPROVED', 'SUPERSEDED') and effective_from >= v.effective_from) then
    raise exception 'An approved configuration already starts on or after %; a new version must start later.', v.effective_from using errcode = 'P0001';
  end if;
  if exists (select 1 from public.gst_return_periods p where p.company_id = v_company and p.status in ('APPROVED', 'CLOSED') and p.period_end >= v.effective_from) then
    raise exception 'GST return periods on or after % are approved or closed; a configuration cannot take effect inside them.', v.effective_from using errcode = 'P0001';
  end if;
  select * into v_prev from public.gst_config_versions where company_id = v_company and status = 'APPROVED' and effective_to is null for update;
  if found then
    update public.gst_config_versions set status = 'SUPERSEDED', effective_to = v.effective_from - 1, superseded_by = v.id, row_version = row_version + 1 where id = v_prev.id;
  end if;
  update public.gst_config_versions set status = 'APPROVED', validation_errors = '[]'::jsonb, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 1000),
    row_version = row_version + 1 where id = v.id returning * into v;
  perform private.write_audit_log(v_company, 'gst.config_approved', 'gst_config_version', v.id::text,
    jsonb_build_object('version', v.version_no, 'effective_from', v.effective_from, 'supersedes', v_prev.version_no));
  return to_jsonb(v);
end;
$$;

create or replace function public.gst_config_reject(p_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  v         public.gst_config_versions;
begin
  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'Record why the configuration is rejected (at least 5 characters).' using errcode = '22023';
  end if;
  select * into v from public.gst_config_versions where id = p_id and company_id = v_company for update;
  if not found or v.status <> 'IN_REVIEW' then
    raise exception 'Only a configuration in review can be rejected.' using errcode = 'P0001';
  end if;
  update public.gst_config_versions set status = 'REJECTED', reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(btrim(p_note), 1000), row_version = row_version + 1
  where id = v.id returning * into v;
  perform private.write_audit_log(v_company, 'gst.config_rejected', 'gst_config_version', v.id::text, jsonb_build_object('version', v.version_no));
  return to_jsonb(v);
end;
$$;

create or replace function public.gst_hsn_rate_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  r         public.gst_hsn_rates;
begin
  insert into public.gst_hsn_rates (company_id, hsn_sac, description, gst_rate, effective_from, effective_to, created_by)
  values (v_company, btrim(p ->> 'hsn_sac'), private.accounting_text(p, 'description', 300, 'Description'), (p ->> 'gst_rate')::numeric,
    private.accounting_date(p, 'effective_from', 'Effective from'), private.accounting_date(p, 'effective_to', 'Effective to'), auth.uid())
  returning * into r;
  perform private.write_audit_log(v_company, 'gst.hsn_rate_saved', 'gst_hsn_rate', r.id::text, to_jsonb(r) - 'company_id');
  return to_jsonb(r);
exception
  when unique_violation then
    raise exception 'A rate for this HSN / SAC already starts on that date.' using errcode = '23505';
  when invalid_text_representation or not_null_violation or check_violation then
    raise exception 'HSN / SAC (4, 6 or 8 digits), a rate between 0 and 100 and the effective date are required.' using errcode = '22023';
end;
$$;

create or replace function public.gst_ledgers_setup()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  r         jsonb;
begin
  perform private.accounting_require_setup(v_company);
  perform private.accounting_seed_gst(v_company);
  r := private.gst_ledgers_ensure(v_company);
  perform private.write_audit_log(v_company, 'gst.ledgers_setup', 'company', v_company::text, r);
  return r || jsonb_build_object('rules', (select jsonb_object_agg(k, private.accounting_rule_account(v_company, k, ''))
    from unnest(array['GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE']) k));
end;
$$;

create or replace function public.gst_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  r         public.gst_registrations;
  v_cfg     public.gst_config_versions := private.gst_config_on(v_company, private.company_today(v_company));
begin
  select * into r from public.gst_registrations where company_id = v_company and is_active;
  return jsonb_build_object(
    'company_gstin', (select gstin from public.companies where id = v_company),
    'registration', to_jsonb(r),
    'frequencies', coalesce((select jsonb_agg(to_jsonb(f) order by f.effective_from) from public.gst_registration_frequencies f where f.registration_id = r.id), '[]'::jsonb),
    'current_config', to_jsonb(v_cfg),
    'configs', coalesce((select jsonb_agg(to_jsonb(c) - 'payload' order by c.version_no desc) from public.gst_config_versions c where c.company_id = v_company), '[]'::jsonb),
    'ledgers', (select jsonb_agg(jsonb_build_object('rule_key', k, 'account_id', a.id, 'account_code', a.account_code, 'account_name', a.account_name) order by k)
      from unnest(array['OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'GST_INPUT_PENDING', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE',
                        'RCM_GST_PAYABLE', 'GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE']) k
      left join public.accounts a on a.id = private.accounting_rule_account(v_company, k, '')),
    'pending_amendments', (select count(*) from public.gst_amendment_exceptions where company_id = v_company and status = 'PENDING_ASSIGNMENT'));
end;
$$;

create or replace function public.gst_config_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  r         jsonb;
begin
  select to_jsonb(c) into r from public.gst_config_versions c where c.id = p_id and c.company_id = v_company;
  if r is null then
    raise exception 'Configuration version not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Sales GST details (sidecar; the invoice / note is never changed)
-- -----------------------------------------------------------------------------
create or replace function public.gst_sales_details_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.manage');
  v_inv     uuid := private.accounting_uuid(p, 'sales_invoice_id', 'Sales invoice');
  v_note    uuid := private.accounting_uuid(p, 'adjustment_note_id', 'Credit / debit note');
  d         public.gst_sales_document_details;
  v_before  jsonb;
begin
  if num_nonnulls(v_inv, v_note) <> 1 then
    raise exception 'Give exactly one of sales_invoice_id and adjustment_note_id.' using errcode = '22023';
  end if;
  if v_inv is not null and not exists (select 1 from public.sales_invoices where id = v_inv and company_id = v_company)
     or v_note is not null and not exists (select 1 from public.invoice_adjustment_notes where id = v_note and company_id = v_company) then
    raise exception 'The document does not exist in this company.' using errcode = '42501';
  end if;
  select * into d from public.gst_sales_document_details where (v_inv is not null and sales_invoice_id = v_inv) or (v_note is not null and adjustment_note_id = v_note) for update;
  v_before := to_jsonb(d);
  if found then
    update public.gst_sales_document_details set export_type = nullif(upper(p ->> 'export_type'), ''), shipping_bill_number = nullif(btrim(p ->> 'shipping_bill_number'), ''),
      shipping_bill_date = private.accounting_date(p, 'shipping_bill_date', 'Shipping bill date'), port_code = nullif(upper(btrim(p ->> 'port_code')), ''),
      ecommerce_gstin = nullif(upper(btrim(p ->> 'ecommerce_gstin')), ''), section_override = nullif(upper(p ->> 'section_override'), ''),
      override_reason = nullif(btrim(p ->> 'override_reason'), ''), updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
    where id = d.id returning * into d;
  else
    insert into public.gst_sales_document_details (company_id, sales_invoice_id, adjustment_note_id, export_type, shipping_bill_number, shipping_bill_date, port_code,
      ecommerce_gstin, section_override, override_reason, updated_by)
    values (v_company, v_inv, v_note, nullif(upper(p ->> 'export_type'), ''), nullif(btrim(p ->> 'shipping_bill_number'), ''),
      private.accounting_date(p, 'shipping_bill_date', 'Shipping bill date'), nullif(upper(btrim(p ->> 'port_code')), ''), nullif(upper(btrim(p ->> 'ecommerce_gstin')), ''),
      nullif(upper(p ->> 'section_override'), ''), nullif(btrim(p ->> 'override_reason'), ''), auth.uid())
    returning * into d;
  end if;
  insert into public.gst_sales_document_detail_history (company_id, detail_id, before, after, actor_id) values (v_company, d.id, v_before, to_jsonb(d), auth.uid());
  perform private.write_audit_log(v_company, 'gst.sales_details_saved', 'gst_sales_document_details', d.id::text, to_jsonb(d) - 'company_id');
  return to_jsonb(d);
exception
  when check_violation then
    raise exception 'Invalid GST details: export type WITH_PAYMENT / WITHOUT_PAYMENT, 6-character port code, a valid section with a reason of 10+ characters.' using errcode = '22023';
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Return periods, snapshots and amendment exceptions
-- -----------------------------------------------------------------------------
-- GST-relevant documents of a date range with a canonical content (hashed) and their amounts. ITC decisions / adjustments belong to the
-- period of their voucher; purchase invoices to their recording date; sales documents to their document date.
create or replace function private.gst_period_documents(p_company uuid, p_from date, p_to date)
returns table (source_kind text, source_id uuid, document_no text, document_date date, content jsonb, amounts jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select 'SALES_INVOICE', i.id, i.invoice_number, i.invoice_date,
         jsonb_build_object('number', i.invoice_number, 'date', i.invoice_date, 'status', i.status, 'customer_gstin', i.customer_gstin,
           'registration_type', i.customer_registration_type, 'seller_gstin', i.seller_gstin, 'place_of_supply', i.place_of_supply_state_code,
           'supply_category', i.supply_category, 'tax_treatment', i.tax_treatment, 'taxable', i.taxable_subtotal, 'cgst', i.cgst_total, 'sgst', i.sgst_total,
           'igst', i.igst_total, 'total', i.grand_total,
           'lines', (select jsonb_agg(jsonb_build_array(l.hsn_sac, l.gst_rate, l.taxable_value, l.cgst_amount, l.sgst_amount, l.igst_amount) order by l.line_no)
                     from public.sales_invoice_lines l where l.invoice_id = i.id),
           'details', (select to_jsonb(d) - array['id', 'company_id', 'row_version', 'updated_by', 'updated_at'] from public.gst_sales_document_details d where d.sales_invoice_id = i.id)),
         jsonb_build_object('taxable', i.taxable_subtotal, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', 0, 'supply_category', i.supply_category)
  from public.sales_invoices i
  where i.company_id = p_company and i.status = 'ISSUED' and not coalesce(i.is_proforma, false) and i.invoice_date between p_from and p_to
  union all
  select case n.note_type when 'CREDIT' then 'CREDIT_NOTE' else 'DEBIT_NOTE' end, n.id, n.note_number, n.note_date,
         jsonb_build_object('number', n.note_number, 'date', n.note_date, 'status', n.status, 'original_invoice', n.original_invoice_id, 'taxable', n.taxable_amount,
           'cgst', n.cgst_amount, 'sgst', n.sgst_amount, 'igst', n.igst_amount, 'total', n.total_amount,
           'details', (select to_jsonb(d) - array['id', 'company_id', 'row_version', 'updated_by', 'updated_at'] from public.gst_sales_document_details d where d.adjustment_note_id = n.id)),
         jsonb_build_object('taxable', n.taxable_amount, 'cgst', n.cgst_amount, 'sgst', n.sgst_amount, 'igst', n.igst_amount, 'cess', 0)
  from public.invoice_adjustment_notes n
  where n.company_id = p_company and n.status = 'ISSUED' and n.note_date between p_from and p_to
  union all
  select 'PURCHASE_INVOICE', p.id, p.invoice_number, p.recorded_date,
         jsonb_build_object('number', p.invoice_number, 'supplier_gstin', p.supplier_gstin, 'supplier_invoice_number', p.supplier_invoice_number,
           'supplier_invoice_date', p.supplier_invoice_date, 'status', p.status, 'supply_category', p.supply_category, 'reverse_charge', p.reverse_charge,
           'place_of_supply', p.place_of_supply_state_code, 'taxable', p.taxable_value, 'cgst', p.cgst_total, 'sgst', p.sgst_total, 'igst', p.igst_total, 'cess', p.cess_total),
         jsonb_build_object('taxable', p.taxable_value, 'cgst', p.cgst_total, 'sgst', p.sgst_total, 'igst', p.igst_total, 'cess', p.cess_total, 'reverse_charge', p.reverse_charge)
  from public.purchase_invoices p
  where p.company_id = p_company and p.status = 'POSTED' and p.recorded_date between p_from and p_to
  union all
  select 'ITC_DECISION', d.id, pi.invoice_number, v.voucher_date,
         jsonb_build_object('invoice', d.purchase_invoice_id, 'decision', d.decision, 'voucher_status', v.status,
           'eligible', jsonb_build_array(d.eligible_cgst, d.eligible_sgst, d.eligible_igst, d.eligible_cess),
           'ineligible', jsonb_build_array(d.ineligible_cgst, d.ineligible_sgst, d.ineligible_igst, d.ineligible_cess)),
         jsonb_build_object('eligible_cgst', d.eligible_cgst, 'eligible_sgst', d.eligible_sgst, 'eligible_igst', d.eligible_igst, 'eligible_cess', d.eligible_cess,
           'ineligible', d.ineligible_cgst + d.ineligible_sgst + d.ineligible_igst + d.ineligible_cess)
  from public.gst_itc_decisions d join public.accounting_vouchers v on v.id = d.voucher_id join public.purchase_invoices pi on pi.id = d.purchase_invoice_id
  where d.company_id = p_company and d.stage = 'DECIDED' and v.status = 'POSTED' and v.voucher_date between p_from and p_to
  union all
  select 'ITC_ADJUSTMENT', a.id, pi.invoice_number, v.voucher_date,
         jsonb_build_object('invoice', a.purchase_invoice_id, 'kind', a.kind, 'status', a.status, 'amounts', jsonb_build_array(a.cgst, a.sgst, a.igst, a.cess)),
         jsonb_build_object('kind', a.kind, 'cgst', a.cgst, 'sgst', a.sgst, 'igst', a.igst, 'cess', a.cess)
  from public.gst_itc_adjustments a join public.accounting_vouchers v on v.id = a.voucher_id join public.purchase_invoices pi on pi.id = a.purchase_invoice_id
  where a.company_id = p_company and a.status = 'POSTED' and v.voucher_date between p_from and p_to;
$$;
revoke all on function private.gst_period_documents(uuid, date, date) from public, anon, authenticated;

-- Present content of one source document (for the amendment scan): null when it no longer qualifies (cancelled, reversed, not posted).
create or replace function private.gst_document_now(p_company uuid, p_kind text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select content from private.gst_period_documents(p_company, date '1900-01-01', date '2999-12-31') d where d.source_kind = p_kind and d.source_id = p_id;
$$;
revoke all on function private.gst_document_now(uuid, text, uuid) from public, anon, authenticated;

create or replace function private.gst_period_lock(p_company uuid, p_period uuid)
returns public.gst_return_periods
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.gst_return_periods;
begin
  select * into p from public.gst_return_periods where id = p_period and company_id = p_company for update;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  return p;
end;
$$;
revoke all on function private.gst_period_lock(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function private.gst_period_event(p public.gst_return_periods, p_action text, p_from text, p_reason text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.gst_period_events (company_id, period_id, action, from_status, to_status, reason, details, actor_id)
  values (p.company_id, p.id, p_action, p_from, p.status, left(p_reason, 1000), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p.company_id, 'gst.period_' || lower(p_action), 'gst_return_period', p.id::text,
    jsonb_build_object('period', p.period_code, 'from', p_from, 'to', p.status, 'reason', left(p_reason, 500)) || coalesce(p_details, '{}'::jsonb));
end;
$$;
revoke all on function private.gst_period_event(public.gst_return_periods, text, text, text, jsonb) from public, anon, authenticated, service_role;

-- Creates the period that starts on p_period_start (its frequency is the one in force then) and assigns queued amendment exceptions to it.
create or replace function public.gst_period_create(p_period_start date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_returns.prepare');
  r         public.gst_registrations := private.gst_registration_of(v_company);
  v_freq    text;
  v_end     date;
  v_code    text;
  v_fym     integer := private.gst_fy_start_month(v_company);
  p         public.gst_return_periods;
  v_n       integer;
begin
  if p_period_start is null or extract(day from p_period_start) <> 1 then
    raise exception 'A GST return period starts on the first day of a month.' using errcode = '22023';
  end if;
  select frequency into v_freq from public.gst_registration_frequencies where registration_id = r.id and effective_from <= p_period_start
  order by effective_from desc limit 1;
  if v_freq is null then
    raise exception 'No filing frequency is in force on %.', p_period_start using errcode = 'P0001';
  end if;
  if v_freq = 'QUARTERLY' and mod((extract(month from p_period_start)::int - v_fym + 12), 3) <> 0 then
    raise exception 'Quarterly periods start on the first month of a financial-year quarter.' using errcode = 'P0001';
  end if;
  v_end := (p_period_start + case v_freq when 'MONTHLY' then interval '1 month' else interval '3 months' end - interval '1 day')::date;
  v_code := case v_freq when 'MONTHLY' then to_char(p_period_start, 'YYYY-MM')
            else to_char(p_period_start, 'YYYY') || '-Q' || (1 + mod((extract(month from p_period_start)::int - v_fym + 12), 12) / 3)::text end;
  insert into public.gst_return_periods (company_id, registration_id, period_code, frequency, financial_year, period_start, period_end, created_by)
  values (v_company, r.id, v_code, v_freq, private.financial_year(p_period_start, v_fym), p_period_start, v_end, auth.uid())
  returning * into p;
  -- Queued amendment exceptions from earlier periods are assigned to the first period created after them.
  update public.gst_amendment_exceptions e set assigned_period_id = p.id, status = 'OPEN'
  from public.gst_return_periods o
  where e.status = 'PENDING_ASSIGNMENT' and e.registration_id = r.id and o.id = e.origin_period_id and o.period_end < p.period_start;
  get diagnostics v_n = row_count;
  perform private.gst_period_event(p, 'CREATED', null, null, jsonb_build_object('frequency', v_freq, 'amendments_assigned', v_n));
  return to_jsonb(p) || jsonb_build_object('amendments_assigned', v_n);
exception
  when unique_violation then
    raise exception 'A GST return period already starts on %.', p_period_start using errcode = '23505';
end;
$$;

-- What stands between a period and approval. Blocking items stop READY / APPROVED; the rest are shown for review.
create or replace function private.gst_period_checklist(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_object('code', 'AMENDMENTS_UNRESOLVED', 'blocking', true, 'count',
      (select count(*) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status <> 'RESOLVED'),
      'message', 'Amendment exceptions from earlier periods are unresolved.'),
    jsonb_build_object('code', 'ADJUSTMENTS_DRAFT', 'blocking', true, 'count',
      (select count(*) from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'DRAFT'), 'message', 'Return adjustments await approval.'),
    jsonb_build_object('code', 'CONFIG_MISSING', 'blocking', true, 'count', case when private.gst_config_on(p.company_id, p.period_end) is null then 1 else 0 end,
      'message', 'No approved GST configuration is in force at the end of the period.'),
    jsonb_build_object('code', 'SALES_UNPOSTED', 'blocking', false, 'count',
      (select count(*) from public.sales_invoices i where i.company_id = p.company_id and i.status = 'ISSUED' and i.invoice_date between p.period_start and p.period_end
         and not exists (select 1 from public.accounting_vouchers v where v.source_type = 'SALES_INVOICE' and v.source_id = i.id and v.source = 'AUTO' and v.status in ('POSTED', 'REVERSED'))),
      'message', 'Issued sales invoices without an accounting voucher.'),
    jsonb_build_object('code', 'PURCHASES_UNPOSTED', 'blocking', false, 'count',
      (select count(*) from public.purchase_invoices i where i.company_id = p.company_id and i.status in ('SUBMITTED', 'APPROVED') and i.supplier_invoice_date between p.period_start and p.period_end),
      'message', 'Supplier invoices of the period not yet posted.'),
    jsonb_build_object('code', 'ITC_PENDING', 'blocking', false, 'count',
      (select count(*) from public.purchase_invoices i where i.company_id = p.company_id and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION'
         and i.recorded_date <= p.period_end), 'message', 'Posted supplier invoices with ITC still pending verification.'),
    jsonb_build_object('code', 'GST_DETAILS_MISSING', 'blocking', false, 'count',
      (select count(*) from public.sales_invoices i where i.company_id = p.company_id and i.status = 'ISSUED' and i.invoice_date between p.period_start and p.period_end
         and (i.place_of_supply_state_code is null or (i.customer_registration_type in ('REGISTERED', 'COMPOSITION', 'SEZ') and i.customer_gstin is null)
              or exists (select 1 from public.sales_invoice_lines l where l.invoice_id = i.id and l.hsn_sac is null and i.supply_category <> 'NON_GST'))),
      'message', 'Issued invoices missing place of supply, GSTIN or HSN.'),
    jsonb_build_object('code', 'SET_OFF_DRAFT', 'blocking', false, 'count',
      (select count(*) from public.gst_set_offs s where s.period_id = p.id and s.status = 'DRAFT'), 'message', 'Set-off drafts not posted.'));
$$;
revoke all on function private.gst_period_checklist(public.gst_return_periods) from public, anon, authenticated;

create or replace function public.gst_period_transition(p_period_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_any_permission(case v_action when 'APPROVE' then array['gst_returns.approve'] when 'CLOSE' then array['gst_periods.close']
                      when 'REOPEN' then array['gst_periods.reopen'] else array['gst_returns.prepare'] end);
  p         public.gst_return_periods := private.gst_period_lock(v_company, p_period_id);
  v_from    text := p.status;
  v_block   jsonb;
  v_snap    uuid;
  v_ver     integer;
  v_cfg     public.gst_config_versions;
  v_totals  jsonb;
  v_data    jsonb;
begin
  if v_action = 'START_REVIEW' and p.status = 'OPEN' then
    update public.gst_return_periods set status = 'UNDER_REVIEW', updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REVIEW_STARTED', v_from, p_reason);
  elsif v_action = 'READY' and p.status = 'UNDER_REVIEW' then
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    update public.gst_return_periods set status = 'READY_FOR_APPROVAL', prepared_by = auth.uid(), prepared_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'READY', v_from, p_reason);
  elsif v_action = 'RETURN' and p.status = 'READY_FOR_APPROVAL' then
    if length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
    end if;
    update public.gst_return_periods set status = 'UNDER_REVIEW', prepared_by = null, prepared_at = null, updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'RETURNED', v_from, p_reason);
  elsif v_action = 'APPROVE' and p.status = 'READY_FOR_APPROVAL' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot approve it.' using errcode = '42501';
    end if;
    select jsonb_agg(x) into v_block from jsonb_array_elements(private.gst_period_checklist(p)) x where (x ->> 'blocking')::boolean and (x ->> 'count')::int > 0;
    if v_block is not null then
      raise exception '%', v_block -> 0 ->> 'message' using errcode = 'P0001', detail = v_block::text;
    end if;
    v_cfg := private.gst_config_on(v_company, p.period_end);
    select coalesce(max(version_no), 0) + 1 into v_ver from public.gst_period_snapshots where period_id = p.id;
    select jsonb_build_object(
        'outward', jsonb_build_object('documents', count(*) filter (where source_kind = 'SALES_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'cgst', coalesce(sum((amounts ->> 'cgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'sgst', coalesce(sum((amounts ->> 'sgst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0),
          'igst', coalesce(sum((amounts ->> 'igst')::numeric) filter (where source_kind = 'SALES_INVOICE'), 0)),
        'credit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'CREDIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'CREDIT_NOTE'), 0)),
        'debit_notes', jsonb_build_object('documents', count(*) filter (where source_kind = 'DEBIT_NOTE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric) filter (where source_kind = 'DEBIT_NOTE'), 0)),
        'inward', jsonb_build_object('documents', count(*) filter (where source_kind = 'PURCHASE_INVOICE'),
          'taxable', coalesce(sum((amounts ->> 'taxable')::numeric) filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE'), 0),
          'rcm_tax', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'PURCHASE_INVOICE' and (amounts ->> 'reverse_charge')::boolean), 0)),
        'itc', jsonb_build_object(
          'eligible', coalesce(sum((amounts ->> 'eligible_cgst')::numeric + (amounts ->> 'eligible_sgst')::numeric + (amounts ->> 'eligible_igst')::numeric
                   + (amounts ->> 'eligible_cess')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'ineligible', coalesce(sum((amounts ->> 'ineligible')::numeric) filter (where source_kind = 'ITC_DECISION'), 0),
          'reversed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'REVERSAL'), 0),
          'reclaimed', coalesce(sum((amounts ->> 'cgst')::numeric + (amounts ->> 'sgst')::numeric + (amounts ->> 'igst')::numeric + (amounts ->> 'cess')::numeric)
                   filter (where source_kind = 'ITC_ADJUSTMENT' and amounts ->> 'kind' = 'RECLAIM'), 0)))
      into v_totals
    from private.gst_period_documents(v_company, p.period_start, p.period_end);
    v_data := jsonb_build_object('period', p.period_code, 'from', p.period_start, 'to', p.period_end, 'frequency', p.frequency,
      'registration', (select gstin from public.gst_registrations where id = p.registration_id), 'config_version', v_cfg.version_no,
      'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' order by a.prepared_at) from public.gst_return_adjustments a where a.period_id = p.id and a.status = 'APPROVED'), '[]'::jsonb),
      'amendments_resolved', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'source_kind', e.source_kind, 'source_id', e.source_id,
        'resolution', e.resolution, 'reason', e.resolution_reason)) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status = 'RESOLVED'), '[]'::jsonb),
      'liability', private.gst_liability(p));
    v_snap := gen_random_uuid();
    insert into public.gst_period_snapshots (id, company_id, period_id, version_no, config_version_id, data, totals, snapshot_hash, prepared_by, approved_by)
    values (v_snap, v_company, p.id, v_ver, v_cfg.id, v_data, v_totals,
      private.gst_hash(jsonb_build_object('data', v_data, 'totals', v_totals, 'documents',
        (select jsonb_agg(jsonb_build_array(d.source_kind, d.source_id, private.gst_hash(d.content)) order by d.source_kind, d.source_id)
         from private.gst_period_documents(v_company, p.period_start, p.period_end) d))), p.prepared_by, auth.uid());
    insert into public.gst_snapshot_documents (company_id, snapshot_id, source_kind, source_id, document_no, document_date, content_hash, amounts)
    select v_company, v_snap, d.source_kind, d.source_id, d.document_no, d.document_date, private.gst_hash(d.content), d.amounts
    from private.gst_period_documents(v_company, p.period_start, p.period_end) d;
    insert into public.gst_period_current_snapshot (period_id, company_id, snapshot_id) values (p.id, v_company, v_snap)
    on conflict (period_id) do update set snapshot_id = excluded.snapshot_id, set_at = now();
    update public.gst_return_periods set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'SNAPSHOT', v_from, null, jsonb_build_object('snapshot_id', v_snap, 'version', v_ver));
    perform private.gst_period_event(p, 'APPROVED', v_from, p_reason, jsonb_build_object('snapshot_id', v_snap));
  elsif v_action = 'CLOSE' and p.status = 'APPROVED' then
    if p.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared the period cannot close it.' using errcode = '42501';
    end if;
    update public.gst_return_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), updated_at = now(), row_version = row_version + 1
    where id = p.id returning * into p;
    perform private.gst_period_event(p, 'CLOSED', v_from, p_reason);
  elsif v_action = 'REOPEN' and p.status in ('APPROVED', 'CLOSED') then
    if length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Reopening needs a reason of at least 10 characters.' using errcode = '22023';
    end if;
    -- The approved snapshot stays exactly as it is; a later approval adds version n+1 and moves the pointer.
    update public.gst_return_periods set status = 'OPEN', prepared_by = null, prepared_at = null, approved_by = null, approved_at = null, closed_by = null, closed_at = null,
      updated_at = now(), row_version = row_version + 1 where id = p.id returning * into p;
    perform private.gst_period_event(p, 'REOPENED', v_from, p_reason);
  else
    raise exception 'Action % is not possible while the period is %.', lower(v_action), lower(replace(p.status, '_', ' ')) using errcode = 'P0001';
  end if;
  return private.gst_period_json(p.id);
end;
$$;

create or replace function private.gst_period_json(p_period uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p) || jsonb_build_object(
    'checklist', private.gst_period_checklist(p),
    'current_snapshot', (select to_jsonb(s) - array['data', 'company_id'] from public.gst_period_current_snapshot c join public.gst_period_snapshots s on s.id = c.snapshot_id where c.period_id = p.id),
    'snapshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'version_no', s.version_no, 'snapshot_hash', s.snapshot_hash, 'created_at', s.created_at,
       'approved_by', s.approved_by) order by s.version_no) from public.gst_period_snapshots s where s.period_id = p.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'reason', e.reason, 'at', e.created_at,
       'by', (select full_name from public.profiles where id = e.actor_id)) order by e.created_at) from public.gst_period_events e where e.period_id = p.id), '[]'::jsonb),
    'amendments', coalesce((select jsonb_agg(to_jsonb(e) - 'company_id' order by e.detected_at) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) - 'company_id' order by a.prepared_at) from public.gst_return_adjustments a where a.period_id = p.id), '[]'::jsonb))
  from public.gst_return_periods p where p.id = p_period;
$$;
revoke all on function private.gst_period_json(uuid) from public, anon, authenticated;

create or replace function public.gst_period_get(p_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
begin
  if not exists (select 1 from public.gst_return_periods where id = p_period_id and company_id = v_company) then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  return private.gst_period_json(p_period_id);
end;
$$;

create or replace function public.gst_periods_list(p_financial_year text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
begin
  return coalesce((select jsonb_agg(to_jsonb(p) - 'company_id' || jsonb_build_object(
      'snapshot_version', (select s.version_no from public.gst_period_current_snapshot c join public.gst_period_snapshots s on s.id = c.snapshot_id where c.period_id = p.id),
      'open_amendments', (select count(*) from public.gst_amendment_exceptions e where e.assigned_period_id = p.id and e.status <> 'RESOLVED')) order by p.period_start)
    from public.gst_return_periods p where p.company_id = v_company and (p_financial_year is null or p.financial_year = p_financial_year)), '[]'::jsonb);
end;
$$;

-- Compares every approved / closed period's current snapshot with the documents as they are now. Changed, cancelled, reversed and late
-- documents become amendment exceptions for the first later period (queued when none exists yet). Idempotent.
create or replace function public.gst_amendments_scan()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_returns.prepare');
  p         record;
  v_target  uuid;
  v_n       integer := 0;
  v_k       integer;
begin
  for p in select pr.*, c.snapshot_id from public.gst_return_periods pr join public.gst_period_current_snapshot c on c.period_id = pr.id
           where pr.company_id = v_company and pr.status in ('APPROVED', 'CLOSED') order by pr.period_start loop
    select id into v_target from public.gst_return_periods where registration_id = p.registration_id and period_start > p.period_end
      and status in ('OPEN', 'UNDER_REVIEW') order by period_start limit 1;
    -- Snapshot documents that changed or no longer qualify.
    insert into public.gst_amendment_exceptions (company_id, registration_id, origin_period_id, snapshot_id, snapshot_document_id, source_kind, source_id, document_no,
      kind, old_hash, new_hash, diff, assigned_period_id, status)
    select v_company, p.registration_id, p.id, p.snapshot_id, sd.id, sd.source_kind, sd.source_id, sd.document_no,
           case when now_c.c is null then case when sd.source_kind in ('PURCHASE_INVOICE', 'ITC_DECISION', 'ITC_ADJUSTMENT') then 'REVERSED' else 'CANCELLED' end else 'CHANGED' end,
           sd.content_hash, coalesce(private.gst_hash(now_c.c), 'gone'), jsonb_build_object('now', now_c.c), v_target, case when v_target is null then 'PENDING_ASSIGNMENT' else 'OPEN' end
    from public.gst_snapshot_documents sd
    cross join lateral (select private.gst_document_now(v_company, sd.source_kind, sd.source_id) as c) now_c
    where sd.snapshot_id = p.snapshot_id and (now_c.c is null or private.gst_hash(now_c.c) <> sd.content_hash)
    on conflict (snapshot_id, source_kind, source_id, kind, new_hash) do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;
    -- Documents dated in the period that were not in the snapshot (entered or issued after approval).
    insert into public.gst_amendment_exceptions (company_id, registration_id, origin_period_id, snapshot_id, source_kind, source_id, document_no, kind, new_hash, diff,
      assigned_period_id, status)
    select v_company, p.registration_id, p.id, p.snapshot_id, d.source_kind, d.source_id, d.document_no, 'LATE_DOCUMENT', private.gst_hash(d.content),
           jsonb_build_object('now', d.content), v_target, case when v_target is null then 'PENDING_ASSIGNMENT' else 'OPEN' end
    from private.gst_period_documents(v_company, p.period_start, p.period_end) d
    where not exists (select 1 from public.gst_snapshot_documents sd where sd.snapshot_id = p.snapshot_id and sd.source_kind = d.source_kind and sd.source_id = d.source_id)
    on conflict (snapshot_id, source_kind, source_id, kind, new_hash) do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;
  end loop;
  if v_n > 0 then
    perform private.write_audit_log(v_company, 'gst.amendments_detected', 'company', v_company::text, jsonb_build_object('count', v_n));
  end if;
  return jsonb_build_object('detected', v_n, 'pending_assignment', (select count(*) from public.gst_amendment_exceptions where company_id = v_company and status = 'PENDING_ASSIGNMENT'));
end;
$$;

create or replace function public.gst_amendment_resolve(p_id uuid, p_action text, p_resolution text default null, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_permission(case when v_action in ('APPROVE', 'REJECT') then 'gst_returns.approve' else 'gst_returns.prepare' end);
  e         public.gst_amendment_exceptions;
begin
  select * into e from public.gst_amendment_exceptions where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Amendment exception not found.' using errcode = 'P0002';
  end if;
  if v_action = 'PROPOSE' and e.status = 'OPEN' then
    if upper(coalesce(p_resolution, '')) not in ('INCLUDED_AS_AMENDMENT', 'NO_RETURN_IMPACT') or length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Choose INCLUDED_AS_AMENDMENT or NO_RETURN_IMPACT with a reason of at least 10 characters.' using errcode = '22023';
    end if;
    update public.gst_amendment_exceptions set status = 'PROPOSED', resolution = upper(p_resolution), resolution_reason = btrim(p_reason), proposed_by = auth.uid(), proposed_at = now()
    where id = e.id returning * into e;
  elsif v_action = 'APPROVE' and e.status = 'PROPOSED' then
    if e.proposed_by = auth.uid() then
      raise exception 'Maker-checker: the person who proposed the resolution cannot approve it.' using errcode = '42501';
    end if;
    update public.gst_amendment_exceptions set status = 'RESOLVED', approved_by = auth.uid(), approved_at = now() where id = e.id returning * into e;
  elsif v_action = 'REJECT' and e.status = 'PROPOSED' then
    update public.gst_amendment_exceptions set status = 'OPEN', resolution = null, resolution_reason = null, proposed_by = null, proposed_at = null where id = e.id returning * into e;
  else
    raise exception 'Action % is not possible for an amendment that is %.', lower(v_action), lower(replace(e.status, '_', ' ')) using errcode = 'P0001';
  end if;
  perform private.write_audit_log(v_company, 'gst.amendment_' || lower(v_action), 'gst_amendment_exception', e.id::text,
    jsonb_build_object('resolution', e.resolution, 'reason', left(p_reason, 500)));
  return to_jsonb(e);
end;
$$;

create or replace function public.gst_return_adjustment(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_permission(case when v_action in ('APPROVE', 'REJECT') then 'gst_returns.approve' else 'gst_returns.prepare' end);
  a         public.gst_return_adjustments;
  per       public.gst_return_periods;
begin
  if v_action = 'CREATE' then
    per := private.gst_period_lock(v_company, private.accounting_uuid(p, 'period_id', 'Period'));
    if per.status not in ('OPEN', 'UNDER_REVIEW') then
      raise exception 'Adjustments are entered only while the period is open or under review.' using errcode = 'P0001';
    end if;
    insert into public.gst_return_adjustments (company_id, period_id, return_type, section, field, tax_head, amount, reason, prepared_by)
    values (v_company, per.id, upper(p ->> 'return_type'), p ->> 'section', p ->> 'field', nullif(upper(p ->> 'tax_head'), ''), (p ->> 'amount')::numeric,
      btrim(coalesce(p ->> 'reason', '')), auth.uid())
    returning * into a;
  else
    select * into a from public.gst_return_adjustments where id = p_id and company_id = v_company for update;
    if not found or a.status <> 'DRAFT' then
      raise exception 'Only a draft adjustment can be approved or rejected.' using errcode = 'P0001';
    end if;
    if a.prepared_by = auth.uid() then
      raise exception 'Maker-checker: the person who prepared an adjustment cannot approve or reject it.' using errcode = '42501';
    end if;
    if v_action not in ('APPROVE', 'REJECT') then
      raise exception 'Unknown action %.', p_action using errcode = '22023';
    end if;
    update public.gst_return_adjustments set status = case v_action when 'APPROVE' then 'APPROVED' else 'REJECTED' end, reviewed_by = auth.uid(), reviewed_at = now(),
      review_note = left(p ->> 'note', 1000) where id = a.id returning * into a;
  end if;
  perform private.write_audit_log(v_company, 'gst.return_adjustment_' || lower(v_action), 'gst_return_adjustment', a.id::text, to_jsonb(a) - 'company_id');
  return to_jsonb(a);
exception
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'An adjustment needs return GSTR1 / GSTR3B, section, field, a non-zero amount and a reason of at least 10 characters.' using errcode = '22023';
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. ITC decision engine (extends Phase 3; one history for both screens)
-- -----------------------------------------------------------------------------
create or replace function private.gst_itc_net(p_invoice uuid)
returns table (eligible_cgst numeric, eligible_sgst numeric, eligible_igst numeric, eligible_cess numeric,
               ineligible_cgst numeric, ineligible_sgst numeric, ineligible_igst numeric, ineligible_cess numeric, decision_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with d as (select * from public.gst_itc_decisions where purchase_invoice_id = p_invoice and stage = 'DECIDED'
             and seq > coalesce((select max(seq) from public.gst_itc_decisions where purchase_invoice_id = p_invoice and stage in ('DECISION_REVERSED', 'REVERSED_WITH_INVOICE')), 0)
             order by seq desc limit 1),
       a as (select coalesce(sum(case kind when 'RECLAIM' then cgst else -cgst end), 0) as c, coalesce(sum(case kind when 'RECLAIM' then sgst else -sgst end), 0) as s,
                    coalesce(sum(case kind when 'RECLAIM' then igst else -igst end), 0) as i, coalesce(sum(case kind when 'RECLAIM' then cess else -cess end), 0) as x
             from public.gst_itc_adjustments where purchase_invoice_id = p_invoice and status = 'POSTED')
  select d.eligible_cgst + a.c, d.eligible_sgst + a.s, d.eligible_igst + a.i, d.eligible_cess + a.x,
         d.ineligible_cgst - a.c, d.ineligible_sgst - a.s, d.ineligible_igst - a.i, d.ineligible_cess - a.x, d.id
  from d cross join a;
$$;
revoke all on function private.gst_itc_net(uuid) from public, anon, authenticated;

create or replace function private.gst_itc_append(i public.purchase_invoices, p_stage text, p_decision text, p_amounts jsonb, p_reason text, p_checks jsonb,
  p_docs jsonb, p_proposal uuid, p_voucher uuid, p_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  f    text;
begin
  perform pg_advisory_xact_lock(hashtextextended('gst_itc:' || i.id::text, 0));
  insert into public.gst_itc_decisions (id, company_id, purchase_invoice_id, seq, stage, decision, proposal_id, pending_cgst, pending_sgst, pending_igst, pending_cess,
    eligible_cgst, eligible_sgst, eligible_igst, eligible_cess, ineligible_cgst, ineligible_sgst, ineligible_igst, ineligible_cess, reason, checks, document_refs, voucher_id, actor_id)
  values (v_id, i.company_id, i.id, coalesce((select max(seq) from public.gst_itc_decisions where purchase_invoice_id = i.id), 0) + 1, p_stage, p_decision, p_proposal,
    i.cgst_total, i.sgst_total, i.igst_total, i.cess_total,
    coalesce((p_amounts #>> '{eligible,cgst}')::numeric, 0), coalesce((p_amounts #>> '{eligible,sgst}')::numeric, 0), coalesce((p_amounts #>> '{eligible,igst}')::numeric, 0),
    coalesce((p_amounts #>> '{eligible,cess}')::numeric, 0), coalesce((p_amounts #>> '{ineligible,cgst}')::numeric, 0), coalesce((p_amounts #>> '{ineligible,sgst}')::numeric, 0),
    coalesce((p_amounts #>> '{ineligible,igst}')::numeric, 0), coalesce((p_amounts #>> '{ineligible,cess}')::numeric, 0),
    left(p_reason, 1000), coalesce(p_checks, '{}'::jsonb), coalesce(p_docs, '[]'::jsonb), p_voucher, auth.uid());
  perform private.write_audit_log(i.company_id, 'gst.itc_' || lower(p_stage), 'gst_itc_decision', v_id::text,
    jsonb_build_object('purchase_invoice_id', i.id, 'invoice_number', i.invoice_number, 'decision', p_decision, 'amounts', p_amounts, 'reason', left(p_reason, 500)));
  return v_id;
end;
$$;
revoke all on function private.gst_itc_append(public.purchase_invoices, text, text, jsonb, text, jsonb, jsonb, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Validates an eligible / ineligible split against the GST pending on the invoice, separately for CGST, SGST, IGST and cess.
create or replace function private.gst_itc_split(i public.purchase_invoices, p_eligible jsonb, p_ineligible jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h     text;
  v_e   numeric;
  v_n   numeric;
  v_p   numeric;
  v_out jsonb := jsonb_build_object('eligible', '{}'::jsonb, 'ineligible', '{}'::jsonb);
  v_te  numeric := 0;
  v_tn  numeric := 0;
begin
  foreach h in array array['cgst', 'sgst', 'igst', 'cess'] loop
    v_p := case h when 'cgst' then i.cgst_total when 'sgst' then i.sgst_total when 'igst' then i.igst_total else i.cess_total end;
    v_e := coalesce(nullif(p_eligible ->> h, '')::numeric, 0);
    v_n := coalesce(nullif(p_ineligible ->> h, '')::numeric, 0);
    if v_e < 0 or v_n < 0 or v_e <> round(v_e, 2) or v_n <> round(v_n, 2) then
      raise exception '% amounts must be zero or more with at most 2 decimals.', upper(h) using errcode = '22023';
    end if;
    if v_e + v_n <> v_p then
      raise exception '%: eligible % + ineligible % must equal the GST pending %.', upper(h), v_e, v_n, v_p using errcode = 'P0001';
    end if;
    v_out := jsonb_set(jsonb_set(v_out, array['eligible', h], to_jsonb(v_e)), array['ineligible', h], to_jsonb(v_n));
    v_te := v_te + v_e; v_tn := v_tn + v_n;
  end loop;
  return v_out || jsonb_build_object('decision', case when v_tn = 0 then 'ELIGIBLE' when v_te = 0 then 'INELIGIBLE' else 'PARTIALLY_ELIGIBLE' end,
    'eligible_total', v_te, 'ineligible_total', v_tn);
exception
  when invalid_text_representation then
    raise exception 'An ITC amount is not a number.' using errcode = '22023';
end;
$$;
revoke all on function private.gst_itc_split(public.purchase_invoices, jsonb, jsonb) from public, anon, authenticated;

-- Posts a decided split (one voucher), records the DECIDED row and updates the invoice's GST status. The first decision made through the
-- Phase 3 screen keeps its Phase 3 voucher identity (PIN / PURCHASE_INVOICE_GST); every other decision uses the GST voucher type.
create or replace function private.gst_itc_apply_decision(i public.purchase_invoices, p_split jsonb, p_reason text, p_checks jsonb, p_docs jsonb, p_proposal uuid, p_phase3 boolean)
returns public.purchase_invoices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lines   jsonb := '[]'::jsonb;
  v_pending uuid := private.accounting_rule_account(i.company_id, 'GST_INPUT_PENDING', '');
  v_inel    uuid := private.accounting_rule_account(i.company_id, 'GST_INPUT_INELIGIBLE', '');
  v_key     text;
  v_amt     numeric;
  v_total   numeric := (p_split ->> 'eligible_total')::numeric + (p_split ->> 'ineligible_total')::numeric;
  v_did     uuid := gen_random_uuid();
  v_legacy  boolean;
  v_id      uuid;
  v         public.accounting_vouchers;
  v_status  text := p_split ->> 'decision';
begin
  if v_pending is null then
    raise exception 'Map the GST input pending verification account first.' using errcode = 'P0001';
  end if;
  foreach v_key in array array['INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS'] loop
    v_amt := (p_split -> 'eligible' ->> lower(replace(v_key, 'INPUT_', '')))::numeric;
    if v_amt > 0 then
      if private.accounting_rule_account(i.company_id, v_key, '') is null then
        raise exception 'Map an active account in Accounting Settings > Posting rules for %.', v_key using errcode = 'P0001';
      end if;
      v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(i.company_id, v_key, ''), 'debit', v_amt, 'narration', 'Eligible input ' || replace(v_key, 'INPUT_', ''));
    end if;
  end loop;
  if (p_split ->> 'ineligible_total')::numeric > 0 then
    if v_inel is null then
      raise exception 'Map an active account in Accounting Settings > Posting rules for the ineligible input GST expense.' using errcode = 'P0001';
    end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_inel, 'debit', (p_split ->> 'ineligible_total')::numeric, 'narration', 'Ineligible input GST');
  end if;
  v_lines := v_lines || jsonb_build_object('account_id', v_pending, 'credit', v_total, 'narration', 'Out of GST input pending verification');
  v_legacy := p_phase3 and not exists (select 1 from public.accounting_vouchers where company_id = i.company_id and source = 'AUTO' and source_type = 'PURCHASE_INVOICE_GST' and source_id = i.id);
  v_id := private.accounting_create_voucher(i.company_id, case when v_legacy then 'PIN' else 'GST' end, private.company_today(i.company_id), i.supplier_invoice_number,
    left(format('Input GST of supplier invoice %s (%s) verified %s', i.supplier_invoice_number, i.invoice_number, lower(replace(v_status, '_', ' '))), 1000),
    'AUTO', case when v_legacy then 'PURCHASE_INVOICE_GST' else 'GST_ITC_DECISION' end, case when v_legacy then i.id else v_did end, i.invoice_number, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  perform private.gst_itc_append(i, 'DECIDED', v_status, p_split, p_reason, p_checks, p_docs, p_proposal, v.id, v_did);
  update public.purchase_invoices set gst_status = v_status, gst_verified_by = auth.uid(), gst_verified_at = now(), gst_voucher_id = v.id,
    gst_verification = jsonb_build_object('status', v_status, 'reason', left(btrim(p_reason), 1000), 'checks', coalesce(p_checks, '{}'::jsonb), 'decision_id', v_did,
      'eligible', p_split -> 'eligible', 'ineligible', p_split -> 'ineligible'),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'GST_VERIFIED', p_reason, jsonb_build_object('status', v_status, 'amount', v_total, 'voucher_number', v.voucher_number, 'checks', p_checks));
  return i;
end;
$$;
revoke all on function private.gst_itc_apply_decision(public.purchase_invoices, jsonb, text, jsonb, jsonb, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function private.gst_itc_checks_ok(p_checks jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_checks ->> 'invoice_verified')::boolean, false) and coalesce((p_checks ->> 'goods_services_received')::boolean, false)
     and coalesce((p_checks ->> 'gstin_valid')::boolean, false);
$$;

-- Review stages, proposals (maker) and approval (checker) of an ITC decision.
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
      i := private.gst_itc_apply_decision(i, v_split, last.reason, last.checks, last.document_refs, last.id, false);
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

-- Crediting input ledgers (reversing ITC) must not take them below what is still on the books: credit already used in set-offs stays used.
create or replace function private.gst_itc_input_available(p_company uuid, p_cgst numeric, p_sgst numeric, p_igst numeric, p_cess numeric)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h     text;
  v_amt numeric;
  v_bal numeric;
begin
  foreach h in array array['CGST', 'SGST', 'IGST', 'CESS'] loop
    v_amt := case h when 'CGST' then p_cgst when 'SGST' then p_sgst when 'IGST' then p_igst else p_cess end;
    if coalesce(v_amt, 0) > 0 then
      v_bal := private.gst_ledger_movement(p_company, 'INPUT_' || h, null, null);
      if v_bal < v_amt then
        raise exception 'ITC already utilised: Input % has only % on the books (needed %). Record an ITC reversal in the current period instead.', h, v_bal, v_amt
          using errcode = 'P0001';
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function private.gst_itc_input_available(uuid, numeric, numeric, numeric, numeric) from public, anon, authenticated;

create or replace function private.gst_itc_json(p_invoice uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number, 'supplier_gstin', i.supplier_gstin,
    'gst_status', i.gst_status, 'gst_voucher_id', i.gst_voucher_id,
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
revoke all on function private.gst_itc_json(uuid) from public, anon, authenticated;

create or replace function public.gst_itc_get(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_invoices.read', 'gst.read']);
begin
  if not exists (select 1 from public.purchase_invoices where id = p_invoice_id and company_id = v_company) then
    raise exception 'Purchase invoice not found.' using errcode = 'P0002';
  end if;
  return private.gst_itc_json(p_invoice_id);
end;
$$;

-- ITC reversals and reclaims after a decision: maker creates a draft, a different user posts it; reversed newest first.
create or replace function public.gst_itc_adjustment(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.verify_gst');
  v_action  text := upper(coalesce(p_action, ''));
  a         public.gst_itc_adjustments;
  i         public.purchase_invoices;
  n         record;
  h         text;
  v_amt     numeric;
  v_lim     numeric;
  v_lines   jsonb := '[]'::jsonb;
  v_inel    uuid;
  v_total   numeric;
  v_id      uuid;
  v         public.accounting_vouchers;
begin
  if v_action = 'CREATE' then
    i := private.pi_lock(v_company, private.accounting_uuid(p, 'purchase_invoice_id', 'Purchase invoice'), array['POSTED']);
    if i.gst_status not in ('ELIGIBLE', 'INELIGIBLE', 'PARTIALLY_ELIGIBLE') then
      raise exception 'ITC adjustments follow a posted ITC decision.' using errcode = 'P0001';
    end if;
    insert into public.gst_itc_adjustments (company_id, purchase_invoice_id, kind, cgst, sgst, igst, cess, reason, document_refs, prepared_by)
    values (v_company, i.id, upper(p ->> 'kind'), coalesce(nullif(p ->> 'cgst', '')::numeric, 0), coalesce(nullif(p ->> 'sgst', '')::numeric, 0),
      coalesce(nullif(p ->> 'igst', '')::numeric, 0), coalesce(nullif(p ->> 'cess', '')::numeric, 0), btrim(coalesce(p ->> 'reason', '')),
      coalesce(p -> 'document_refs', '[]'::jsonb), auth.uid())
    returning * into a;
  else
    select * into a from public.gst_itc_adjustments where id = p_id and company_id = v_company;
    if not found then
      raise exception 'ITC adjustment not found.' using errcode = 'P0002';
    end if;
    i := private.pi_lock(v_company, a.purchase_invoice_id, array['POSTED']);
    select * into a from public.gst_itc_adjustments where id = p_id for update;
    if v_action = 'CANCEL' then
      if a.status <> 'DRAFT' then
        raise exception 'Only a draft adjustment can be cancelled.' using errcode = 'P0001';
      end if;
      update public.gst_itc_adjustments set status = 'CANCELLED', status_reason = left(btrim(coalesce(p ->> 'reason', '')), 1000), row_version = row_version + 1
      where id = a.id returning * into a;
    elsif v_action = 'POST' then
      if a.status <> 'DRAFT' then
        raise exception 'Only a draft adjustment can be posted.' using errcode = 'P0001';
      end if;
      if a.prepared_by = auth.uid() then
        raise exception 'Maker-checker: the person who prepared an ITC adjustment cannot post it.' using errcode = '42501';
      end if;
      select * into n from private.gst_itc_net(i.id);
      foreach h in array array['cgst', 'sgst', 'igst', 'cess'] loop
        v_amt := case h when 'cgst' then a.cgst when 'sgst' then a.sgst when 'igst' then a.igst else a.cess end;
        v_lim := case a.kind when 'REVERSAL' then case h when 'cgst' then n.eligible_cgst when 'sgst' then n.eligible_sgst when 'igst' then n.eligible_igst else n.eligible_cess end
                 else case h when 'cgst' then n.ineligible_cgst when 'sgst' then n.ineligible_sgst when 'igst' then n.ineligible_igst else n.ineligible_cess end end;
        if v_amt > coalesce(v_lim, 0) then
          raise exception '% %: % is more than the % still % on this invoice (%).', initcap(lower(a.kind)), upper(h), v_amt,
            case a.kind when 'REVERSAL' then 'eligible ITC' else 'ineligible ITC' end, case a.kind when 'REVERSAL' then 'claimed' else 'reclaimable' end, coalesce(v_lim, 0)
            using errcode = 'P0001';
        end if;
        if v_amt > 0 then
          v_lines := v_lines || jsonb_build_object('account_id', private.accounting_rule_account(v_company, 'INPUT_' || upper(h), ''),
            case a.kind when 'REVERSAL' then 'credit' else 'debit' end, v_amt, 'narration', initcap(lower(a.kind)) || ' of input ' || upper(h));
        end if;
      end loop;
      if a.kind = 'REVERSAL' then
        perform private.gst_itc_input_available(v_company, a.cgst, a.sgst, a.igst, a.cess);
      end if;
      v_inel := private.accounting_rule_account(v_company, 'GST_INPUT_INELIGIBLE', '');
      v_total := a.cgst + a.sgst + a.igst + a.cess;
      v_lines := v_lines || jsonb_build_object('account_id', v_inel, case a.kind when 'REVERSAL' then 'debit' else 'credit' end, v_total, 'narration', 'Ineligible input GST');
      v_id := private.accounting_create_voucher(v_company, 'GST', private.company_today(v_company), i.supplier_invoice_number,
        left(format('ITC %s on supplier invoice %s (%s): %s', lower(a.kind), i.supplier_invoice_number, i.invoice_number, a.reason), 1000),
        'AUTO', 'GST_ITC_ADJUSTMENT', a.id, i.invoice_number, null, v_lines);
      v := private.accounting_post_voucher(v_id);
      update public.gst_itc_adjustments set status = 'POSTED', voucher_id = v.id, posted_by = auth.uid(), posted_at = now(), row_version = row_version + 1
      where id = a.id returning * into a;
    elsif v_action = 'REVERSE' then
      if a.status <> 'POSTED' then
        raise exception 'Only a posted adjustment can be reversed.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.gst_itc_adjustments x where x.purchase_invoice_id = a.purchase_invoice_id and x.status = 'POSTED' and x.posted_at > a.posted_at) then
        raise exception 'Reverse the newer ITC adjustments of this invoice first (newest first).' using errcode = 'P0001';
      end if;
      if length(btrim(coalesce(p ->> 'reason', ''))) < 10 then
        raise exception 'Record why (at least 10 characters).' using errcode = '22023';
      end if;
      if a.kind = 'RECLAIM' then
        perform private.gst_itc_input_available(v_company, a.cgst, a.sgst, a.igst, a.cess);
      end if;
      v := private.accounting_reverse_voucher(a.voucher_id, 'ITC adjustment reversed: ' || btrim(p ->> 'reason'), null);
      update public.gst_itc_adjustments set status = 'REVERSED', reversal_voucher_id = v.id, reversed_by = auth.uid(), reversed_at = now(),
        status_reason = left(btrim(p ->> 'reason'), 1000), row_version = row_version + 1 where id = a.id returning * into a;
    else
      raise exception 'Unknown action %.', p_action using errcode = '22023';
    end if;
  end if;
  perform private.write_audit_log(v_company, 'gst.itc_adjustment_' || lower(v_action), 'gst_itc_adjustment', a.id::text, to_jsonb(a) - 'company_id');
  return to_jsonb(a);
exception
  when check_violation or invalid_text_representation then
    raise exception 'An ITC adjustment needs kind REVERSAL / RECLAIM, amounts of zero or more (some positive) and a reason of at least 10 characters.' using errcode = '22023';
end;
$$;

create or replace function public.gst_itc_queue(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['purchase_invoices.read', 'gst.read']);
  v_status  text := upper(nullif(p_filters ->> 'gst_status', ''));
begin
  return coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
      'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date, 'supplier_gstin', i.supplier_gstin, 'reverse_charge', i.reverse_charge,
      'gst_status', i.gst_status, 'tax', i.cgst_total + i.sgst_total + i.igst_total + i.cess_total,
      'stage', (select stage from public.gst_itc_decisions d where d.purchase_invoice_id = i.id order by seq desc limit 1),
      'net', (select to_jsonb(n) - 'decision_id' from private.gst_itc_net(i.id) n)) order by i.recorded_date desc, i.invoice_number desc)
    from public.purchase_invoices i where i.company_id = v_company and i.status = 'POSTED' and i.cgst_total + i.sgst_total + i.igst_total + i.cess_total > 0
      and (v_status is null or i.gst_status = v_status)), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. GST challans, payments and set-off
-- -----------------------------------------------------------------------------
-- Electronic cash available per major / minor head: posted successful payments − cash used by posted set-offs.
create or replace function private.gst_cash_available(p_registration uuid)
returns table (major_head text, minor_head text, amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (select h.major_head, h.minor_head, sum(h.amount) as amt
                from public.gst_challan_heads h join public.gst_challans c on c.id = h.challan_id
                where c.registration_id = p_registration
                  and exists (select 1 from public.gst_challan_payments p where p.challan_id = c.id and p.status = 'SUCCESS' and p.voucher_id is not null)
                group by 1, 2),
       used as (select l.source_head as major_head, l.cash_minor_head as minor_head, sum(l.amount) as amt
                from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id
                where s.registration_id = p_registration and s.status = 'POSTED' and l.source = 'CASH' group by 1, 2)
  select coalesce(p.major_head, u.major_head), coalesce(p.minor_head, u.minor_head), coalesce(p.amt, 0) - coalesce(u.amt, 0)
  from paid p full join used u on u.major_head = p.major_head and u.minor_head = p.minor_head;
$$;
revoke all on function private.gst_cash_available(uuid) from public, anon, authenticated;

-- Liability of a period per head: output GST (ledger movement in the period, set-off vouchers excluded) and reverse-charge GST (posted RCM
-- supplier invoices recorded in the period), less posted set-offs of the period; credit available (input ledger balances) and electronic cash.
create or replace function private.gst_liability(p public.gst_return_periods)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'output', jsonb_build_object(
      'IGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_IGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'CGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_CGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'SGST', -private.gst_ledger_movement(p.company_id, 'OUTPUT_SGST', p.period_start, p.period_end, 'GST_SET_OFF'),
      'CESS', 0),
    'rcm', (select jsonb_build_object('IGST', coalesce(sum(igst_total), 0), 'CGST', coalesce(sum(cgst_total), 0), 'SGST', coalesce(sum(sgst_total), 0), 'CESS', coalesce(sum(cess_total), 0))
            from public.purchase_invoices where company_id = p.company_id and status = 'POSTED' and reverse_charge and recorded_date between p.period_start and p.period_end),
    'set_off', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
            select l.liability_kind || ':' || l.liability_head as k, sum(l.amount) as v from public.gst_set_off_lines l join public.gst_set_offs s on s.id = l.set_off_id
            where s.period_id = p.id and s.status = 'POSTED' group by 1) x),
    'credit', jsonb_build_object('IGST', private.gst_ledger_movement(p.company_id, 'INPUT_IGST', null, null), 'CGST', private.gst_ledger_movement(p.company_id, 'INPUT_CGST', null, null),
      'SGST', private.gst_ledger_movement(p.company_id, 'INPUT_SGST', null, null), 'CESS', private.gst_ledger_movement(p.company_id, 'INPUT_CESS', null, null)),
    'cash', coalesce((select jsonb_object_agg(c.major_head || ':' || c.minor_head, c.amount) from private.gst_cash_available(p.registration_id) c), '{}'::jsonb),
    'cash_ledger', private.gst_ledger_movement(p.company_id, 'GST_ELECTRONIC_CASH', null, null));
$$;
revoke all on function private.gst_liability(public.gst_return_periods) from public, anon, authenticated;

create or replace function public.gst_liability_summary(p_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst.read');
  p         public.gst_return_periods;
begin
  select * into p from public.gst_return_periods where id = p_period_id and company_id = v_company;
  if not found then
    raise exception 'GST return period not found.' using errcode = 'P0002';
  end if;
  return private.gst_liability(p) || jsonb_build_object('period', p.period_code);
end;
$$;

create or replace function public.gst_challan(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('gst_payments.create');
  v_action  text := upper(coalesce(p_action, ''));
  r         public.gst_registrations := private.gst_registration_of(v_company);
  c         public.gst_challans;
  v_cfg     public.gst_config_versions;
  v_cpin    text := btrim(coalesce(p ->> 'cpin', ''));
  v_date    date := private.accounting_date(p, 'challan_date', 'Challan date');
  v_total   numeric;
begin
  if v_action = 'SAVE' then
    v_cfg := private.gst_config_on(v_company, coalesce(v_date, private.company_today(v_company)));
    if v_cfg.id is null then
      raise exception 'No approved GST configuration is in force on the challan date.' using errcode = 'P0001';
    end if;
    if v_cpin !~ (v_cfg.payload -> 'challan' ->> 'cpin_pattern') then
      raise exception 'CPIN % does not match the configured format.', v_cpin using errcode = '22023';
    end if;
    if jsonb_typeof(p -> 'heads') <> 'array' or jsonb_array_length(p -> 'heads') = 0 then
      raise exception 'Enter the challan amounts by major and minor head.' using errcode = '22023';
    end if;
    select sum((h ->> 'amount')::numeric) into v_total from jsonb_array_elements(p -> 'heads') h;
    if p_id is null then
      insert into public.gst_challans (company_id, registration_id, period_id, cpin, challan_date, expiry_date, total_amount, created_by)
      values (v_company, r.id, private.accounting_uuid(p, 'period_id', 'Period'), v_cpin, v_date, private.accounting_date(p, 'expiry_date', 'Expiry date'), v_total, auth.uid())
      returning * into c;
    else
      select * into c from public.gst_challans where id = p_id and company_id = v_company for update;
      if not found or c.status <> 'CREATED' or exists (select 1 from public.gst_challan_payments where challan_id = c.id and status = 'SUCCESS') then
        raise exception 'Only an unpaid challan can be edited.' using errcode = 'P0001';
      end if;
      delete from public.gst_challan_heads where challan_id = c.id;
      update public.gst_challans set cpin = v_cpin, challan_date = v_date, expiry_date = private.accounting_date(p, 'expiry_date', 'Expiry date'), total_amount = v_total,
        period_id = private.accounting_uuid(p, 'period_id', 'Period'), row_version = row_version + 1 where id = c.id returning * into c;
    end if;
    insert into public.gst_challan_heads (challan_id, company_id, major_head, minor_head, amount)
    select c.id, v_company, upper(h ->> 'major_head'), upper(h ->> 'minor_head'), (h ->> 'amount')::numeric from jsonb_array_elements(p -> 'heads') h;
  elsif v_action in ('CANCEL', 'EXPIRE') then
    select * into c from public.gst_challans where id = p_id and company_id = v_company for update;
    if not found or c.status <> 'CREATED' or exists (select 1 from public.gst_challan_payments where challan_id = c.id and status = 'SUCCESS') then
      raise exception 'Only an unpaid challan can be cancelled or marked expired.' using errcode = 'P0001';
    end if;
    update public.gst_challans set status = case v_action when 'CANCEL' then 'CANCELLED' else 'EXPIRED' end, status_reason = left(btrim(coalesce(p ->> 'reason', '')), 500),
      row_version = row_version + 1 where id = c.id returning * into c;
  else
    raise exception 'Unknown action %.', p_action using errcode = '22023';
  end if;
  perform private.write_audit_log(v_company, 'gst.challan_' || lower(v_action), 'gst_challan', c.id::text, jsonb_build_object('cpin', c.cpin, 'total', c.total_amount, 'status', c.status));
  return to_jsonb(c) || jsonb_build_object('heads', (select jsonb_agg(to_jsonb(h) - 'company_id') from public.gst_challan_heads h where h.challan_id = c.id));
exception
  when unique_violation then
    raise exception 'CPIN % is already recorded for this registration.', v_cpin using errcode = '23505';
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception 'A challan needs a CPIN, a date and positive amounts by major head (IGST, CGST, SGST, CESS) and minor head (TAX, INTEREST, PENALTY, FEE, OTHER).'
      using errcode = '22023';
end;
$$;

-- Payment attempts (maker) and posting of the successful one (checker): Dr GST Electronic Cash / Cr the Phase 4 bank account's ledger.
create or replace function public.gst_challan_payment(p_action text, p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action  text := upper(coalesce(p_action, ''));
  v_company uuid := private.require_permission(case when v_action in ('POST', 'REVERSE') then 'gst_payments.post' else 'gst_payments.create' end);
  c         public.gst_challans;
  pay       public.gst_challan_payments;
  b         public.bank_cash_accounts;
  v_cfg     public.gst_config_versions;
  v_status  text := upper(coalesce(p ->> 'status', ''));
  v_cin     text := nullif(upper(btrim(coalesce(p ->> 'cin', ''))), '');
  v_cash    uuid;
  v_id      uuid;
  v         public.accounting_vouchers;
  h         record;
begin
  if v_action = 'RECORD' then
    select * into c from public.gst_challans where id = p_id and company_id = v_company for update;
    if not found or c.status <> 'CREATED' then
      raise exception 'Payments are recorded only for an unpaid challan.' using errcode = 'P0001';
    end if;
    if v_status not in ('INITIATED', 'FAILED', 'SUCCESS') then
      raise exception 'Status must be INITIATED, FAILED or SUCCESS.' using errcode = '22023';
    end if;
    if v_status = 'SUCCESS' then
      v_cfg := private.gst_config_on(v_company, coalesce(private.accounting_date(p, 'payment_date', 'Payment date'), c.challan_date));
      if v_cfg.id is null or v_cin is null or v_cin !~ (v_cfg.payload -> 'challan' ->> 'cin_pattern')
         or ((v_cfg.payload -> 'challan' ->> 'cin_starts_with_cpin')::boolean and left(v_cin, length(c.cpin)) <> c.cpin) then
        raise exception 'A successful payment needs a CIN in the configured format%.', case when (v_cfg.payload -> 'challan' ->> 'cin_starts_with_cpin')::boolean
          then ' (starting with the CPIN)' else '' end using errcode = '22023';
      end if;
      select * into b from public.bank_cash_accounts where id = private.accounting_uuid(p, 'bank_cash_account_id', 'Bank account') and company_id = v_company and is_active;
      if not found or b.account_kind <> 'BANK' then
        raise exception 'Choose the active bank account the payment was made from.' using errcode = '22023';
      end if;
      if coalesce(nullif(p ->> 'amount', '')::numeric, 0) <> c.total_amount then
        raise exception 'The paid amount must equal the challan total %.', c.total_amount using errcode = 'P0001';
      end if;
      if nullif(p ->> 'statement_line_id', '') is not null and not exists (select 1 from public.bank_statement_lines l
           where l.id = (p ->> 'statement_line_id')::uuid and l.bank_cash_account_id = b.id and l.amount = -c.total_amount) then
        raise exception 'The statement line must be a debit of the same amount on the same bank account.' using errcode = 'P0001';
      end if;
    end if;
    insert into public.gst_challan_payments (company_id, challan_id, attempt_no, mode, bank_cash_account_id, payment_date, amount, bank_reference, brn, cin, status,
      failure_reason, statement_line_id, recorded_by)
    values (v_company, c.id, coalesce((select max(attempt_no) from public.gst_challan_payments where challan_id = c.id), 0) + 1, upper(coalesce(p ->> 'mode', 'NET_BANKING')),
      case when v_status = 'SUCCESS' then b.id else private.accounting_uuid(p, 'bank_cash_account_id', 'Bank account') end,
      coalesce(private.accounting_date(p, 'payment_date', 'Payment date'), private.company_today(v_company)), coalesce(nullif(p ->> 'amount', '')::numeric, c.total_amount),
      nullif(btrim(p ->> 'bank_reference'), ''), nullif(btrim(p ->> 'brn'), ''), v_cin, v_status, nullif(btrim(p ->> 'failure_reason'), ''),
      private.accounting_uuid(p, 'statement_line_id', 'Statement line'), auth.uid())
    returning * into pay;
  elsif v_action = 'POST' then
    select * into pay from public.gst_challan_payments where id = p_id and company_id = v_company;
    if not found then
      raise exception 'Payment not found.' using errcode = 'P0002';
    end if;
    select * into c from public.gst_challans where id = pay.challan_id for update;          -- lock order: challan, then payment
    select * into pay from public.gst_challan_payments where id = p_id for update;
    if pay.status <> 'SUCCESS' or pay.voucher_id is not null then
      raise exception 'Only a successful, unposted payment can be posted (this one is % %).', lower(pay.status), case when pay.voucher_id is not null then 'and posted' else '' end
        using errcode = 'P0001';
    end if;
    if pay.recorded_by = auth.uid() then
      raise exception 'Maker-checker: the person who recorded the payment cannot post it.' using errcode = '42501';
    end if;
    v_cash := private.accounting_rule_account(v_company, 'GST_ELECTRONIC_CASH', '');
    if v_cash is null then
      raise exception 'Set up the GST ledgers first (GST Electronic Cash Ledger is not mapped).' using errcode = 'P0001';
    end if;
    select * into b from public.bank_cash_accounts where id = pay.bank_cash_account_id;
    if not b.is_active then
      raise exception 'Bank account % is inactive.', b.account_code using errcode = 'P0001';
    end if;
    v_id := private.accounting_create_voucher(v_company, 'GST', pay.payment_date, c.cpin,
      left(format('GST payment, CPIN %s, CIN %s', c.cpin, pay.cin), 1000), 'AUTO', 'GST_CHALLAN_PAYMENT', pay.id, c.cpin, null,
      jsonb_build_array(jsonb_build_object('account_id', v_cash, 'debit', pay.amount, 'narration', 'Electronic cash ledger — CPIN ' || c.cpin),
                        jsonb_build_object('account_id', b.ledger_account_id, 'credit', pay.amount, 'narration', 'GST challan ' || c.cpin || ' CIN ' || pay.cin)));
    v := private.accounting_post_voucher(v_id);
    update public.gst_challan_payments set voucher_id = v.id, posted_by = auth.uid(), posted_at = now() where id = pay.id returning * into pay;
    update public.gst_challans set status = 'PAID', row_version = row_version + 1 where id = c.id;
  elsif v_action = 'REVERSE' then
    select * into pay from public.gst_challan_payments where id = p_id and company_id = v_company;
    if not found then
      raise exception 'Payment not found.' using errcode = 'P0002';
    end if;
    select * into c from public.gst_challans where id = pay.challan_id for update;
    select * into pay from public.gst_challan_payments where id = p_id for update;
    if pay.voucher_id is null or pay.status <> 'SUCCESS' then
      raise exception 'Only a posted payment can be reversed.' using errcode = 'P0001';
    end if;
    if length(btrim(coalesce(p ->> 'reason', ''))) < 10 then
      raise exception 'Record why (at least 10 characters).' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('gst_setoff:' || c.registration_id::text, 0));
    for h in select hd.major_head, hd.minor_head, hd.amount, coalesce(a.amount, 0) as available from public.gst_challan_heads hd
             left join private.gst_cash_available(c.registration_id) a on a.major_head = hd.major_head and a.minor_head = hd.minor_head where hd.challan_id = c.id loop
      if h.available < h.amount then
        raise exception 'Electronic cash of this challan (% %) is already used by a posted set-off; reverse the set-off first.', h.major_head, h.minor_head using errcode = 'P0001';
      end if;
    end loop;
    v := private.accounting_reverse_voucher(pay.voucher_id, 'GST payment reversed: ' || btrim(p ->> 'reason'), null);
    update public.gst_challan_payments set status = 'REVERSED', reversal_voucher_id = v.id, reversed_by = auth.uid(), reversed_at = now(),
      reversal_reason = left(btrim(p ->> 'reason'), 500) where id = pay.id returning * into pay;
    update public.gst_challans set status = 'CREATED', row_version = row_version + 1 where id = c.id;
  else
    raise exception 'Unknown action %.', p_action using errcode = '22023';
  end if;
  perform private.write_audit_log(v_company, 'gst.payment_' || lower(v_action), 'gst_challan_payment', pay.id::text,
    jsonb_build_object('cpin', c.cpin, 'cin', pay.cin, 'status', pay.status, 'amount', pay.amount));
  return to_jsonb(pay) || jsonb_build_object('voucher_number', (select voucher_number from public.accounting_vouchers where id = pay.voucher_id));
exception
  when unique_violation then
    raise exception 'This challan already has a successful payment, or the CIN / bank reference is already recorded.' using errcode = '23505';
  when check_violation or invalid_text_representation then
    raise exception 'Invalid payment details (mode, amount, CIN, bank account).' using errcode = '22023';
end;
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
          raise exception 'Input % available is % — the set-off uses %.', l.source_head, coalesce((liab -> 'credit' ->> l.source_head)::numeric, 0), l.amt using errcode = 'P0001';
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


-- -----------------------------------------------------------------------------
-- 12. Existing functions extended (each from its latest text; Phase 5 lines marked): GST verification and invoice reversal (Phase 3),
--     the GST-pending report, posting-rule keys, chart seed and the ERP reset registries.
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
  -- Phase 5: one decision history; a pending proposal (maker-checker) must be approved or rejected first.
  if (select stage from public.gst_itc_decisions where purchase_invoice_id = i.id order by seq desc limit 1) = 'PROPOSED' then
    raise exception 'A partial-ITC proposal is awaiting approval; approve or reject it first (Accounts › GST › ITC verification).' using errcode = 'P0001';
  end if;
  v_full := jsonb_build_object('cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total);
  i := private.gst_itc_apply_decision(i, private.gst_itc_split(i, case when v_status = 'ELIGIBLE' then v_full else v_zero end,
         case when v_status = 'ELIGIBLE' then v_zero else v_full end), p_reason, coalesce(p_checks, '{}'::jsonb), '[]'::jsonb, null, true);
  return private.pi_json(i.id);
end;
$$;

create or replace function public.purchase_invoice_reverse(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.reverse');
  i         public.purchase_invoices := private.pi_lock(v_company, p_invoice_id, array['POSTED']);
  v1        public.accounting_vouchers;
  v2        public.accounting_vouchers;
  va        public.accounting_vouchers;
  n         record;
  adj       record;
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  if exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments p on p.id = a.payment_id
             where a.invoice_id = i.id and a.status = 'ACTIVE' and p.status = 'RECORDED') then
    raise exception 'Payments are allocated to this invoice; remove the allocations first.' using errcode = 'P0001';
  end if;
  -- Phase 5: no draft ITC adjustment may be left behind, and ITC already used in a set-off is never taken back silently.
  if exists (select 1 from public.gst_itc_adjustments where purchase_invoice_id = i.id and status = 'DRAFT') then
    raise exception 'An ITC adjustment of this invoice is still a draft; post or cancel it first.' using errcode = 'P0001';
  end if;
  select * into n from private.gst_itc_net(i.id);
  if i.gst_voucher_id is not null then
    if n.decision_id is not null then
      perform private.gst_itc_input_available(i.company_id, n.eligible_cgst, n.eligible_sgst, n.eligible_igst, n.eligible_cess);
    elsif i.gst_status = 'ELIGIBLE' then
      perform private.gst_itc_input_available(i.company_id, i.cgst_total, i.sgst_total, i.igst_total, i.cess_total);
    end if;
  end if;
  for adj in select * from public.gst_itc_adjustments where purchase_invoice_id = i.id and status = 'POSTED' order by posted_at desc, id desc loop
    va := private.accounting_reverse_voucher(adj.voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
    update public.gst_itc_adjustments set status = 'REVERSED', reversal_voucher_id = va.id, reversed_by = auth.uid(), reversed_at = now(),
      status_reason = left('Supplier invoice reversed: ' || btrim(p_reason), 1000), row_version = row_version + 1 where id = adj.id;
  end loop;
  if i.gst_voucher_id is not null then
    v2 := private.accounting_reverse_voucher(i.gst_voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
    if n.decision_id is not null then
      perform private.gst_itc_append(i, 'REVERSED_WITH_INVOICE', null, null, p_reason, null, null, n.decision_id, v2.id);
    end if;
  end if;
  if i.voucher_id is not null then
    v1 := private.accounting_reverse_voucher(i.voucher_id, 'Supplier invoice reversed: ' || btrim(p_reason), null);
  end if;
  update public.purchase_invoices set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 1000),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = i.id returning * into i;
  perform private.pi_log(i, 'REVERSED', p_reason, jsonb_build_object('reversal_voucher', v1.voucher_number, 'gst_reversal_voucher', v2.voucher_number));
  return private.pi_json(i.id);
end;
$$;

create or replace function public.purchase_invoice_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('purchase_invoices.read');
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := coalesce(private.accounting_date(f, 'from', 'From'), date '2000-01-01');
  v_to      date := coalesce(private.accounting_date(f, 'to', 'To'), private.company_today(v_company));
  v_asof    date := coalesce(private.accounting_date(f, 'as_of', 'As of'), private.company_today(v_company));
  v_sup     uuid := private.accounting_uuid(f, 'supplier_id', 'Supplier');
  v_rep     text := upper(coalesce(p_report, ''));
begin
  if v_rep = 'PURCHASE_REGISTER' or v_rep = 'SUPPLIER_INVOICE_REGISTER' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier_invoice_date', i.supplier_invoice_date, 'recorded_date', i.recorded_date, 'supplier', coalesce(s.display_name, s.legal_name), 'supplier_gstin', i.supplier_gstin,
        'invoice_type', i.invoice_type, 'status', i.status, 'reverse_charge', i.reverse_charge, 'taxable_value', i.taxable_value, 'cgst', i.cgst_total, 'sgst', i.sgst_total,
        'igst', i.igst_total, 'cess', i.cess_total, 'grand_total', i.grand_total, 'gst_status', i.gst_status,
        'voucher_number', (select voucher_number from public.accounting_vouchers where id = i.voucher_id)) order by i.recorded_date, i.invoice_number)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.recorded_date between v_from and v_to and (v_sup is null or i.supplier_id = v_sup)
        and (v_rep = 'SUPPLIER_INVOICE_REGISTER' or i.status in ('POSTED', 'REVERSED'))), '[]'::jsonb));
  elsif v_rep in ('OUTSTANDING', 'AGEING') then
    return (with o as (
      select i.id, i.invoice_number, i.supplier_invoice_number, i.supplier_invoice_date, i.due_date, i.grand_total, i.supplier_id, coalesce(s.display_name, s.legal_name) as supplier,
             i.party_id, private.pi_outstanding(i.id) as outstanding, greatest(v_asof - coalesce(i.due_date, i.supplier_invoice_date), 0) as overdue_days,
             v_asof <= coalesce(i.due_date, i.supplier_invoice_date) as not_due
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.recorded_date <= v_asof and (v_sup is null or i.supplier_id = v_sup)
    )
    select jsonb_build_object('report', v_rep, 'as_of', v_asof,
      'rows', case when v_rep = 'OUTSTANDING' then coalesce((select jsonb_agg(jsonb_build_object('invoice_id', o.id, 'invoice_number', o.invoice_number,
          'supplier_invoice_number', o.supplier_invoice_number, 'supplier_invoice_date', o.supplier_invoice_date, 'due_date', o.due_date, 'supplier', o.supplier,
          'grand_total', o.grand_total, 'paid', o.grand_total - o.outstanding, 'outstanding', o.outstanding, 'overdue_days', o.overdue_days,
          'payment_status', case when o.outstanding = 0 then 'PAID' when o.outstanding < o.grand_total then 'PARTLY_PAID' else 'UNPAID' end) order by o.due_date)
        from o where o.outstanding > 0), '[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('supplier_id', ag.supplier_id, 'supplier', ag.supplier, 'not_due', ag.nd, 'd1_30', ag.b1, 'd31_60', ag.b2, 'd61_90', ag.b3,
          'd90_plus', ag.b4, 'total', ag.nd + ag.b1 + ag.b2 + ag.b3 + ag.b4,
          -- Accounting figure: the supplier's Creditors balance in the ledger (includes receipts not yet invoiced, payments on account and openings).
          'ledger_creditors', coalesce((select sum(l.credit - l.debit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
             join public.accounts a on a.id = l.account_id where l.party_id = ag.party_id and a.account_nature = 'PAYABLE_CONTROL' and v.status in ('POSTED', 'REVERSED')
             and v.voucher_date <= v_asof), 0)) order by ag.supplier)
        from (select supplier_id, supplier, party_id,
                     coalesce(sum(outstanding) filter (where not_due), 0) as nd,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days <= 30), 0) as b1,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 31 and 60), 0) as b2,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days between 61 and 90), 0) as b3,
                     coalesce(sum(outstanding) filter (where not not_due and overdue_days > 90), 0) as b4
              from o where outstanding > 0 group by supplier_id, supplier, party_id) ag), '[]'::jsonb) end));
  elsif v_rep = 'GRN_RECONCILIATION' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('receipt_number', g.receipt_number, 'receipt_date', g.receipt_date,
        'supplier', coalesce(s.display_name, s.legal_name), 'description', v.description, 'accepted_quantity', l.accepted_quantity, 'receipt_payable', v.payable,
        'invoiced_quantity', coalesce(pi.qty, 0), 'receipt_share_invoiced', coalesce(pi.share, 0), 'invoiced_amount', coalesce(pi.amount, 0),
        'difference_posted', coalesce(pi.amount, 0) - coalesce(pi.share, 0), 'uninvoiced_quantity', l.accepted_quantity - coalesce(pi.qty, 0),
        'uninvoiced_payable', v.payable - coalesce(pi.share, 0),
        'state', case when coalesce(pi.qty, 0) = 0 then 'NOT_INVOICED' when pi.qty < l.accepted_quantity then 'PARTLY_INVOICED' else 'FULLY_INVOICED' end,
        'invoices', pi.numbers) order by g.receipt_date, g.receipt_number)
      from public.goods_receipt_lines l join public.goods_receipts g on g.id = l.goods_receipt_id join public.suppliers s on s.id = g.supplier_id
      cross join lateral (select * from private.pi_grn_line(l.id)) v
      left join lateral (select sum(il.quantity) as qty, sum(il.matched_payable) as share, sum(il.taxable_value + il.cgst + il.sgst + il.igst + il.cess) as amount,
                                string_agg(i.invoice_number, ', ') as numbers
                         from public.purchase_invoice_lines il join public.purchase_invoices i on i.id = il.invoice_id
                         where il.goods_receipt_line_id = l.id and i.status = 'POSTED') pi on true
      where g.company_id = v_company and g.status = 'POSTED' and l.accepted_quantity > 0 and g.receipt_date between v_from and v_to
        and (v_sup is null or g.supplier_id = v_sup)), '[]'::jsonb));
  elsif v_rep = 'GST_PENDING' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number,
        'supplier_invoice_number', i.supplier_invoice_number, 'supplier_invoice_date', i.supplier_invoice_date, 'supplier', coalesce(s.display_name, s.legal_name),
        'supplier_gstin', i.supplier_gstin, 'cgst', i.cgst_total, 'sgst', i.sgst_total, 'igst', i.igst_total, 'cess', i.cess_total, 'reverse_charge', i.reverse_charge,
        'days_pending', private.company_today(v_company) - i.recorded_date,
        -- Phase 5: review stage of the ITC decision workflow (under review / on hold / proposed).
        'review_stage', (select d.stage from public.gst_itc_decisions d where d.purchase_invoice_id = i.id order by d.seq desc limit 1)) order by i.recorded_date)
      from public.purchase_invoices i join public.suppliers s on s.id = i.supplier_id
      where i.company_id = v_company and i.status = 'POSTED' and i.gst_status = 'PENDING_VERIFICATION'), '[]'::jsonb),
      'ledger_pending_balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
         join public.accounting_posting_rules r on r.account_id = l.account_id and r.rule_key = 'GST_INPUT_PENDING' and r.company_id = v_company
         where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to), 0));
  elsif v_rep = 'ITC_SUMMARY' then
    return jsonb_build_object('report', v_rep, 'from', v_from, 'to', v_to, 'rows', coalesce((select jsonb_agg(jsonb_build_object('rule_key', r.rule_key, 'account_code', a.account_code,
        'account_name', a.account_name, 'period_debit', coalesce(m.dr, 0), 'period_credit', coalesce(m.cr, 0), 'closing_balance', coalesce(m.closing, 0)) order by r.rule_key)
      from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id
      left join lateral (select sum(l.debit) filter (where v.voucher_date >= v_from) as dr, sum(l.credit) filter (where v.voucher_date >= v_from) as cr,
                                sum(l.debit - l.credit) as closing
                         from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                         where l.account_id = r.account_id and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= v_to) m on true
      where r.company_id = v_company and r.rule_key in ('GST_INPUT_PENDING', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE')),
      '[]'::jsonb),
      'invoices', (select jsonb_object_agg(gst_status, n) from (select gst_status, count(*) as n from public.purchase_invoices
        where company_id = v_company and status = 'POSTED' and recorded_date between v_from and v_to group by gst_status) x));
  elsif v_rep = 'PRICE_VARIANCE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'supplier_invoice_number', i.supplier_invoice_number,
        'supplier', coalesce(s.display_name, s.legal_name), 'receipt_number', g.receipt_number, 'description', l.description, 'quantity', l.quantity,
        'receipt_unit_cost', l.grn_unit_cost, 'invoice_unit_price', l.unit_price, 'receipt_value', l.matched_net, 'invoice_value', l.taxable_value,
        'variance', l.taxable_value - l.matched_net, 'variance_percent', case when l.matched_net > 0 then round((l.taxable_value - l.matched_net) * 100 / l.matched_net, 2) end,
        'variance_status', i.variance_status) order by i.recorded_date, i.invoice_number, l.line_no)
      from public.purchase_invoice_lines l join public.purchase_invoices i on i.id = l.invoice_id join public.suppliers s on s.id = i.supplier_id
      join public.goods_receipts g on g.id = l.goods_receipt_id
      where i.company_id = v_company and i.status = 'POSTED' and l.line_kind = 'GRN' and i.recorded_date between v_from and v_to
        and (v_sup is null or i.supplier_id = v_sup) and l.taxable_value <> l.matched_net), '[]'::jsonb));
  elsif v_rep = 'COST_CENTRE_EXPENSE' then
    return jsonb_build_object('report', v_rep, 'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
        'account_code', a.account_code, 'account_name', a.account_name, 'amount', t.amount) order by c.cost_centre_code, a.account_code)
      from (select x.cost_centre_id, l.account_id, sum(case when l.debit > 0 then x.amount else -x.amount end) as amount
            from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id
            join public.accounting_vouchers v on v.id = x.voucher_id join public.accounting_voucher_types t on t.id = v.voucher_type_id
            where x.company_id = v_company and t.type_code in ('PIN', 'REV') and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED')
              and v.voucher_date between v_from and v_to
            group by x.cost_centre_id, l.account_id) t
      join public.accounting_cost_centres c on c.id = t.cost_centre_id join public.accounts a on a.id = t.account_id where t.amount <> 0), '[]'::jsonb),
      'unallocated', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
        join public.accounts a on a.id = l.account_id
        where v.company_id = v_company and v.source_type = 'PURCHASE_INVOICE' and v.status in ('POSTED', 'REVERSED') and v.voucher_date between v_from and v_to
          and a.classification = 'EXPENSE' and not exists (select 1 from public.accounting_cost_allocations x where x.voucher_line_id = l.id)), 0));
  end if;
  raise exception 'Unknown report %.', p_report using errcode = '22023';
end;
$$;

create or replace function public.accounting_posting_rule_save(p_rule_key text, p_match_value text, p_account_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  v_key     text := upper(coalesce(p_rule_key, ''));
  v_match   text := upper(coalesce(p_match_value, ''));
  v_a       public.accounts;
  v_old     public.accounting_posting_rules;
begin
  perform private.accounting_require_setup(v_company);
  if v_key not in ('DEBTORS', 'CREDITORS', 'SALES', 'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES',
                   'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT',
                   -- Phase 3: supplier invoices.
                   'PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE',
                   -- Phase 5: GST payments and set-off.
                   'GST_ELECTRONIC_CASH', 'GST_INTEREST', 'GST_LATE_FEE') then
    raise exception 'Unknown posting rule %.', p_rule_key using errcode = '22023';
  end if;
  if (v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')) <> (v_match <> '') then
    raise exception 'Receipt and supplier-payment rules need a payment method; the other rules do not.' using errcode = '22023';
  end if;
  select * into v_old from public.accounting_posting_rules where company_id = v_company and rule_key = v_key and match_value = v_match for update;
  if p_account_id is null then
    if v_key not in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') then
      raise exception 'Only payment-method mappings can be removed; select another account instead.' using errcode = 'P0001';
    end if;
    delete from public.accounting_posting_rules where id = v_old.id;
  else
    select * into v_a from public.accounts where id = p_account_id and company_id = v_company;
    if not found then
      raise exception 'The account does not exist in this company.' using errcode = '42501';
    end if;
    if not (v_a.is_active and v_a.is_postable) then
      raise exception 'Account % is inactive or does not accept postings.', v_a.account_code using errcode = 'P0001';
    end if;
    if v_key = 'DEBTORS' and v_a.account_nature <> 'RECEIVABLE_CONTROL' or v_key = 'CREDITORS' and v_a.account_nature <> 'PAYABLE_CONTROL' then
      raise exception 'Debtors and Creditors must map to the matching control account.' using errcode = 'P0001';
    end if;
    if v_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') and v_a.account_nature not in ('CASH', 'BANK') then
      raise exception 'Payment methods must map to a cash or bank account.' using errcode = 'P0001';
    end if;
    if v_key not in ('DEBTORS', 'CREDITORS') and v_a.account_nature in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') then
      raise exception 'A control account can only be used for the Debtors / Creditors rule.' using errcode = 'P0001';
    end if;
    insert into public.accounting_posting_rules (company_id, rule_key, match_value, account_id, created_by, updated_by)
    values (v_company, v_key, v_match, v_a.id, auth.uid(), auth.uid())
    on conflict (company_id, rule_key, match_value) do update set account_id = excluded.account_id, is_active = true, updated_by = auth.uid(), updated_at = now();
  end if;
  perform private.write_audit_log(v_company, 'accounting.posting_rule.saved', 'accounting_posting_rule', v_key || ':' || v_match,
    jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'from_account', v_old.account_id, 'to_account', p_account_id));
  return jsonb_build_object('rule_key', v_key, 'match_value', v_match, 'account_id', p_account_id);
end;
$$;

create or replace function private.accounting_seed_chart(p_company uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  -- Groups (Indian-style hierarchy; classification inherited from the root).
  for r in
    select * from (values
      (1, 'AS', 'Assets', null, 'ASSET', 'DEBIT'),
      (2, 'AS.FA', 'Fixed Assets', 'AS', 'ASSET', 'DEBIT'),
      (3, 'AS.CA', 'Current Assets', 'AS', 'ASSET', 'DEBIT'),
      (4, 'AS.CA.CASH', 'Cash-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (5, 'AS.CA.BANK', 'Bank Accounts', 'AS.CA', 'ASSET', 'DEBIT'),
      (6, 'AS.CA.DEB', 'Sundry Debtors', 'AS.CA', 'ASSET', 'DEBIT'),
      (7, 'AS.CA.STK', 'Stock-in-Hand', 'AS.CA', 'ASSET', 'DEBIT'),
      (8, 'AS.CA.TAX', 'Duties & Taxes Receivable', 'AS.CA', 'ASSET', 'DEBIT'),
      (9, 'AS.CA.ADV', 'Loans & Advances (Asset)', 'AS.CA', 'ASSET', 'DEBIT'),
      (10, 'LI', 'Liabilities', null, 'LIABILITY', 'CREDIT'),
      (11, 'LI.CL', 'Current Liabilities', 'LI', 'LIABILITY', 'CREDIT'),
      (12, 'LI.CL.CRD', 'Sundry Creditors', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (13, 'LI.CL.TAX', 'Duties & Taxes', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (14, 'LI.CL.PRV', 'Provisions', 'LI.CL', 'LIABILITY', 'CREDIT'),
      (15, 'LI.LN', 'Loans (Liability)', 'LI', 'LIABILITY', 'CREDIT'),
      (16, 'EQ', 'Capital & Reserves', null, 'EQUITY', 'CREDIT'),
      (17, 'EQ.CAP', 'Capital Account', 'EQ', 'EQUITY', 'CREDIT'),
      (18, 'EQ.RES', 'Reserves & Surplus', 'EQ', 'EQUITY', 'CREDIT'),
      (19, 'IN', 'Income', null, 'INCOME', 'CREDIT'),
      (20, 'IN.SAL', 'Sales Accounts', 'IN', 'INCOME', 'CREDIT'),
      (21, 'IN.OTH', 'Other Income', 'IN', 'INCOME', 'CREDIT'),
      (22, 'EX', 'Expenses', null, 'EXPENSE', 'DEBIT'),
      (23, 'EX.PUR', 'Purchase Accounts', 'EX', 'EXPENSE', 'DEBIT'),
      (24, 'EX.DIR', 'Direct Expenses', 'EX', 'EXPENSE', 'DEBIT'),
      (25, 'EX.IND', 'Indirect Expenses', 'EX', 'EXPENSE', 'DEBIT')
    ) g (ord, code, name, parent, cls, nb) order by ord
  loop
    insert into public.account_groups (company_id, group_code, group_name, parent_group_id, classification, normal_balance, is_system, sort_order, created_by, updated_by)
    values (p_company, r.code, r.name, (select id from public.account_groups where company_id = p_company and group_code = r.parent), r.cls, r.nb, true, r.ord,
            auth.uid(), auth.uid())
    on conflict (company_id, group_code) do nothing;
  end loop;

  -- System ledgers used by automatic posting. No bank account and no payment-method mapping is created.
  for r in
    select * from (values
      ('1100', 'Cash in Hand', 'AS.CA.CASH', 'DEBIT', 'CASH', true, false, false, null),
      ('1300', 'Sundry Debtors (Control)', 'AS.CA.DEB', 'DEBIT', 'RECEIVABLE_CONTROL', false, true, true, 'DEBTORS_CONTROL'),
      ('1400', 'Inventory (Stock-in-Hand)', 'AS.CA.STK', 'DEBIT', 'INVENTORY', true, false, false, 'INVENTORY'),
      ('1510', 'GST Input Pending Verification', 'AS.CA.TAX', 'DEBIT', 'TAX', true, false, false, 'GST_INPUT_PENDING'),
      ('2100', 'Sundry Creditors (Control)', 'LI.CL.CRD', 'CREDIT', 'PAYABLE_CONTROL', false, true, true, 'CREDITORS_CONTROL'),
      ('2210', 'Output CGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_CGST'),
      ('2220', 'Output SGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_SGST'),
      ('2230', 'Output IGST', 'LI.CL.TAX', 'CREDIT', 'TAX', true, false, false, 'OUTPUT_IGST'),
      ('3100', 'Capital Account', 'EQ.CAP', 'CREDIT', 'CAPITAL', true, false, false, null),
      ('4100', 'Sales', 'IN.SAL', 'CREDIT', 'GENERAL', true, false, false, 'SALES'),
      ('4110', 'Sales Returns', 'IN.SAL', 'DEBIT', 'GENERAL', true, false, false, 'SALES_RETURNS'),
      ('5100', 'Purchases', 'EX.PUR', 'DEBIT', 'GENERAL', true, false, false, 'PURCHASES'),
      ('5900', 'Round Off', 'EX.IND', 'DEBIT', 'ROUND_OFF', true, false, false, 'ROUND_OFF')
    ) a (code, name, grp, nb, nature, manual, party, control, skey)
  loop
    insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature,
      allow_manual_posting, requires_party, is_control, is_system, system_key, created_by, updated_by)
    select p_company, r.code, r.name, g.id, g.classification, r.nb, r.nature, r.manual, r.party, r.control, r.skey is not null, r.skey, auth.uid(), auth.uid()
    from public.account_groups g where g.company_id = p_company and g.group_code = r.grp
    on conflict (company_id, account_code) do nothing;
  end loop;

  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  select p_company, t.code, t.name, t.code, t.manual from (values
    ('JV', 'Journal Voucher', true), ('SAL', 'Sales', false), ('RCT', 'Receipt', false), ('PMT', 'Payment', false),
    ('CRN', 'Credit Note', false), ('DBN', 'Debit Note', false), ('PUR', 'Purchase (Goods Receipt)', false),
    ('OPN', 'Opening Balance', false), ('REV', 'Reversal', false)) t (code, name, manual)
  on conflict (company_id, type_code) do nothing;

  insert into public.accounting_posting_rules (company_id, rule_key, account_id, created_by, updated_by)
  select p_company, m.rule_key, a.id, auth.uid(), auth.uid()
  from (values ('DEBTORS', 'DEBTORS_CONTROL'), ('CREDITORS', 'CREDITORS_CONTROL'), ('SALES', 'SALES'), ('SALES_RETURNS', 'SALES_RETURNS'),
               ('OUTPUT_CGST', 'OUTPUT_CGST'), ('OUTPUT_SGST', 'OUTPUT_SGST'), ('OUTPUT_IGST', 'OUTPUT_IGST'), ('ROUND_OFF', 'ROUND_OFF'),
               ('PURCHASES', 'PURCHASES'), ('GST_INPUT_PENDING', 'GST_INPUT_PENDING')) m (rule_key, skey)
  join public.accounts a on a.company_id = p_company and a.system_key = m.skey
  on conflict (company_id, rule_key, match_value) do nothing;
  -- Phase 3: purchase-invoice ledgers, rules and the PIN voucher type.
  perform private.accounting_seed_purchase_invoices(p_company);
  -- Phase 4: contra and bank adjustment voucher types.
  perform private.accounting_seed_bank_cash(p_company);
  -- Phase 5: GST voucher type and the GST ledgers (explicit error on any conflict; nothing skipped or altered).
  perform private.accounting_seed_gst(p_company);
  perform private.gst_ledgers_ensure(p_company);
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

create or replace function private.erp_reset_kept_tables()
returns table (table_name text, label text, company_scoped boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('accounting_settings', 'Accounting settings', true),
    ('accounting_periods', 'Accounting periods', true),
    ('account_groups', 'Account groups', true),
    ('accounts', 'Ledger accounts', true),
    ('accounting_cost_centres', 'Cost centres', true),
    ('accounting_voucher_types', 'Voucher types', true),
    ('accounting_voucher_sequences', 'Voucher number series', true),
    ('accounting_posting_rules', 'Posting account mappings', true),
    ('bank_cash_accounts', 'Bank and cash accounts', true),
    ('bank_account_numbers', 'Bank account numbers', true),
    ('bank_payment_method_policies', 'Payment-method account policies', true),
    ('gst_registrations', 'GST registration', true),
    ('gst_registration_frequencies', 'GST filing frequencies', true),
    ('gst_config_versions', 'GST configuration versions', true),
    ('gst_hsn_rates', 'GST HSN / SAC rates', true),
    ('companies', 'Company record', true),
    ('company_settings', 'Company settings', true),
    ('profiles', 'User profiles', true),
    ('user_roles', 'Role assignments', true),
    ('user_invitations', 'User invitations', true),
    ('roles', 'Roles', false),
    ('permissions', 'Permissions', false),
    ('role_permissions', 'Role permissions', false),
    ('audit_logs', 'Audit log', true),
    ('erp_reset_runs', 'Reset history', true),
    ('erp_reset_backup_attestations', 'Reset backup records', true),
    ('invoice_settings', 'Invoice settings', true),
    ('billing_number_sequences', 'Billing number series', true),
    ('inventory_number_sequences', 'Inventory number series', true),
    ('approval_workflows', 'Approval workflows', true),
    ('approval_workflow_stages', 'Approval workflow stages', true),
    ('notification_preferences', 'Notification preferences', true),
    ('notification_sync_state', 'Notification sync state', true),
    ('error_events', 'System error log', true),
    ('amazon_settings', 'Amazon settings', true),
    ('amazon_connections', 'Amazon connections', true),
    ('warehouses', 'Warehouses', true),
    ('inventory_locations', 'Warehouse locations', true),
    ('products', 'Products', true),
    ('product_versions', 'Product version history', true),
    ('product_categories', 'Product categories', true),
    ('documents', 'Documents', true),
    ('document_versions', 'Document files', true)
  ) t (table_name, label, company_scoped);
$$;

create or replace function private.erp_force_reset_tables()
returns table (table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select t.table_name, t.category, t.label from private.erp_reset_tables() t
  union all
  select * from (values
    ('accounting_settings', 'Accounting', 'Accounting settings'),
    ('accounting_periods', 'Accounting', 'Accounting periods'),
    ('account_groups', 'Accounting', 'Account groups'),
    ('accounts', 'Accounting', 'Ledger accounts'),
    ('accounting_cost_centres', 'Accounting', 'Cost centres'),
    ('accounting_voucher_types', 'Accounting', 'Voucher types'),
    ('accounting_voucher_sequences', 'Accounting', 'Voucher number series'),
    ('accounting_posting_rules', 'Accounting', 'Posting account mappings'),
    ('bank_cash_accounts', 'Accounting', 'Bank and cash accounts'),
    ('bank_account_numbers', 'Accounting', 'Bank account numbers'),
    ('bank_payment_method_policies', 'Accounting', 'Payment-method account policies'),
    ('gst_registrations', 'Accounting', 'GST registration'),
    ('gst_registration_frequencies', 'Accounting', 'GST filing frequencies'),
    ('gst_config_versions', 'Accounting', 'GST configuration versions'),
    ('gst_hsn_rates', 'Accounting', 'GST HSN / SAC rates'),
    ('products', 'Products & catalogue', 'Products'),
    ('product_versions', 'Products & catalogue', 'Product version history'),
    ('product_categories', 'Products & catalogue', 'Product categories'),
    ('warehouses', 'Warehouses & locations', 'Warehouses'),
    ('inventory_locations', 'Warehouses & locations', 'Warehouse locations'),
    ('documents', 'Documents', 'Documents (except company-level documents)'),
    ('document_versions', 'Documents', 'Document file versions')
  ) x (table_name, category, label);
$$;

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
revoke all on function private.erp_reset_kept_tables() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 13. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.gst_registration_save(jsonb)',
    'public.gst_frequency_add(text, date, text)',
    'public.gst_config_save(uuid, date, jsonb, text, integer)',
    'public.gst_config_submit(uuid)',
    'public.gst_config_approve(uuid, text)',
    'public.gst_config_reject(uuid, text)',
    'public.gst_hsn_rate_save(jsonb)',
    'public.gst_ledgers_setup()',
    'public.gst_overview()',
    'public.gst_config_get(uuid)',
    'public.gst_sales_details_save(jsonb)',
    'public.gst_period_create(date)',
    'public.gst_period_transition(uuid, text, text)',
    'public.gst_period_get(uuid)',
    'public.gst_periods_list(text)',
    'public.gst_amendments_scan()',
    'public.gst_amendment_resolve(uuid, text, text, text)',
    'public.gst_return_adjustment(text, uuid, jsonb)',
    'public.gst_itc_action(uuid, text, jsonb)',
    'public.gst_itc_get(uuid)',
    'public.gst_itc_adjustment(text, uuid, jsonb)',
    'public.gst_itc_queue(jsonb)',
    'public.gst_liability_summary(uuid)',
    'public.gst_challan(text, uuid, jsonb)',
    'public.gst_challan_payment(text, uuid, jsonb)',
    'public.gst_set_off(text, uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
