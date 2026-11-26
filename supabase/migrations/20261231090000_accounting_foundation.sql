-- =============================================================================
-- ALTON ACCOUNTS — Phase 0: double-entry accounting foundation
--
-- New, additive. No existing table, function, trigger or record is changed
-- (the three ERP reset registries are re-declared with the accounting tables
-- added, as every module does). Design: docs/ACCOUNTING_FOUNDATION.md
--
--   chart of accounts   account_groups (hierarchy), accounts (ledgers)
--   configuration       accounting_settings, accounting_periods, accounting_cost_centres (master only)
--   vouchers            accounting_voucher_types, accounting_voucher_sequences,
--                       accounting_vouchers, accounting_voucher_lines
--   posting             accounting_posting_rules, accounting_posting_events
--                       (the automatic posting engine is 20261231090100)
--   opening balances    accounting_opening_balance_batches / _lines
--
-- Security
--   * RLS everywhere; SELECT only for active members with a read permission.
--     No INSERT / UPDATE / DELETE privilege for anon, authenticated or
--     service_role on any accounting table: every write is a SECURITY DEFINER
--     RPC that derives the company from the caller and checks a permission.
--   * Transaction-bound security token: a voucher's status changes only when
--     the posting engine created a token row for that voucher, purpose and
--     transaction (txid_current()) in private.accounting_transition_tokens and
--     set app.accounting_token to it. The guard trigger checks both.
--   * Posted / reversed vouchers and their lines are immutable for every role;
--     the only change is POSTED -> REVERSED (with a token). Deletes are refused
--     except inside a reviewed force-reset purge (private.erp_force_purge_allows).
--   * Money: numeric(18,2). Debit must equal credit; drafts never reach reports.
--
-- Rollback: supabase/rollback/20261231090000_accounting_foundation_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions (existing resource.action convention and role matrix)
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('accounts',            'read',   'View the chart of accounts, ledger accounts and cost centres'),
  ('accounts',            'manage', 'Create and edit account groups, ledger accounts and cost centres'),
  ('vouchers',            'read',   'View accounting vouchers'),
  ('vouchers',            'create', 'Create, edit and discard draft accounting vouchers'),
  ('vouchers',            'post',   'Post accounting vouchers'),
  ('vouchers',            'reverse','Reverse posted accounting vouchers'),
  ('accounting_opening',  'import', 'Create and import accounting opening balance batches'),
  ('accounting_opening',  'approve','Approve and post accounting opening balance batches'),
  ('accounting_period',   'close',  'Create, close and reopen accounting periods'),
  ('accounting_reports',  'read',   'View accounting reports: trial balance, general ledger, day book, voucher register'),
  ('accounting_settings', 'manage', 'Configure accounting settings and posting account mappings'),
  ('accounting_posting',  'manage', 'Run, retry and dismiss automatic accounting postings')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values
    ('ACCOUNTS_MANAGER', 'accounts.read'), ('ACCOUNTS_MANAGER', 'accounts.manage'), ('ACCOUNTS_MANAGER', 'vouchers.read'),
    ('ACCOUNTS_MANAGER', 'vouchers.create'), ('ACCOUNTS_MANAGER', 'vouchers.post'), ('ACCOUNTS_MANAGER', 'vouchers.reverse'),
    ('ACCOUNTS_MANAGER', 'accounting_opening.import'), ('ACCOUNTS_MANAGER', 'accounting_opening.approve'),
    ('ACCOUNTS_MANAGER', 'accounting_period.close'), ('ACCOUNTS_MANAGER', 'accounting_reports.read'),
    ('ACCOUNTS_MANAGER', 'accounting_settings.manage'), ('ACCOUNTS_MANAGER', 'accounting_posting.manage'),
    ('ADMIN', 'accounts.read'), ('ADMIN', 'vouchers.read'), ('ADMIN', 'accounting_reports.read'), ('ADMIN', 'accounting_settings.manage'),
    ('MANAGEMENT_VIEWER', 'accounts.read'), ('MANAGEMENT_VIEWER', 'vouchers.read'), ('MANAGEMENT_VIEWER', 'accounting_reports.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.code = m.role_code
join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.accounting_settings (
  company_id                uuid primary key references public.companies (id) on delete restrict,
  books_start_date          date not null,
  fy_start_month            integer not null default 4 check (fy_start_month between 1 and 12),
  currency_code             text not null default 'INR' check (currency_code = 'INR'),
  allow_future_dates        boolean not null default false,
  backdate_limit_days       integer check (backdate_limit_days is null or backdate_limit_days between 0 and 3650),
  segregation_of_duties     boolean not null default false,
  auto_posting_max_attempts integer not null default 5 check (auto_posting_max_attempts between 1 and 50),
  initialized_by            uuid,
  initialized_at            timestamptz not null default now(),
  updated_by                uuid,
  updated_at                timestamptz not null default now()
);
comment on table public.accounting_settings is 'Accounting configuration per company (books start date, financial year, INR, date rules). Written only by accounting RPCs.';

create table if not exists public.accounting_periods (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  financial_year text not null check (financial_year ~ '^[0-9]{4}(-[0-9]{2})?$'),
  period_no      integer not null check (period_no between 1 and 12),
  period_name    text not null check (length(period_name) between 3 and 40),
  start_date     date not null,
  end_date       date not null,
  status         text not null default 'OPEN' check (status in ('OPEN', 'CLOSED', 'REOPENED')),
  status_reason  text check (status_reason is null or length(status_reason) <= 500),
  closed_by      uuid,
  closed_at      timestamptz,
  reopened_by    uuid,
  reopened_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint accounting_periods_no_unique unique (company_id, financial_year, period_no),
  constraint accounting_periods_start_unique unique (company_id, start_date),
  constraint accounting_periods_dates check (end_date >= start_date)
);
create index if not exists accounting_periods_dates_idx on public.accounting_periods (company_id, start_date, end_date);

create table if not exists public.account_groups (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  group_code      text not null check (group_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
  group_name      text not null check (length(btrim(group_name)) between 2 and 120),
  parent_group_id uuid,
  classification  text not null check (classification in ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  normal_balance  text not null check (normal_balance in ('DEBIT', 'CREDIT')),
  is_system       boolean not null default false,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  description     text check (description is null or length(description) <= 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  constraint account_groups_code_unique unique (company_id, group_code),
  constraint account_groups_id_company_unique unique (id, company_id),
  constraint account_groups_parent_fk foreign key (parent_group_id, company_id) references public.account_groups (id, company_id) on delete restrict,
  constraint account_groups_not_own_parent check (parent_group_id is null or parent_group_id <> id)
);
create unique index if not exists account_groups_name_unique on public.account_groups (company_id, lower(group_name));
create index if not exists account_groups_parent_idx on public.account_groups (parent_group_id);

create table if not exists public.accounts (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  account_code         text not null check (account_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
  account_name         text not null check (length(btrim(account_name)) between 2 and 150),
  group_id             uuid not null,
  classification       text not null check (classification in ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  normal_balance       text not null check (normal_balance in ('DEBIT', 'CREDIT')),
  account_nature       text not null default 'GENERAL' check (account_nature in ('GENERAL', 'CASH', 'BANK', 'RECEIVABLE_CONTROL', 'PAYABLE_CONTROL',
                         'TAX', 'INVENTORY', 'ROUND_OFF', 'CAPITAL', 'LOAN', 'FIXED_ASSET')),
  is_postable          boolean not null default true,
  allow_manual_posting boolean not null default true,
  requires_party       boolean not null default false,
  is_control           boolean not null default false,
  is_system            boolean not null default false,
  system_key           text check (system_key is null or system_key ~ '^[A-Z][A-Z_]{1,40}$'),
  is_active            boolean not null default true,
  description          text check (description is null or length(description) <= 500),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_by           uuid,
  updated_at           timestamptz not null default now(),
  constraint accounts_code_unique unique (company_id, account_code),
  constraint accounts_id_company_unique unique (id, company_id),
  constraint accounts_system_key_unique unique (company_id, system_key),
  constraint accounts_group_fk foreign key (group_id, company_id) references public.account_groups (id, company_id) on delete restrict,
  -- Debtors / Creditors control accounts: party-wise, never posted by hand (the ERP sub-ledger stays the source).
  constraint accounts_control_rules check (
    account_nature not in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') or (is_control and requires_party and not allow_manual_posting))
);
create unique index if not exists accounts_name_unique on public.accounts (company_id, lower(account_name));
create index if not exists accounts_group_idx on public.accounts (group_id);

-- Cost-centre master only. Voucher allocations and budgets are Phase 2.
create table if not exists public.accounting_cost_centres (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  cost_centre_code      text not null check (cost_centre_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
  cost_centre_name      text not null check (length(btrim(cost_centre_name)) between 2 and 120),
  description           text check (description is null or length(description) <= 500),
  parent_cost_centre_id uuid,
  is_active             boolean not null default true,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  constraint accounting_cost_centres_code_unique unique (company_id, cost_centre_code),
  constraint accounting_cost_centres_id_company_unique unique (id, company_id),
  constraint accounting_cost_centres_parent_fk foreign key (parent_cost_centre_id, company_id)
    references public.accounting_cost_centres (id, company_id) on delete restrict,
  constraint accounting_cost_centres_not_own_parent check (parent_cost_centre_id is null or parent_cost_centre_id <> id)
);

create table if not exists public.accounting_voucher_types (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete restrict,
  type_code    text not null check (type_code ~ '^[A-Z]{2,6}$'),
  type_name    text not null check (length(btrim(type_name)) between 2 and 60),
  prefix       text not null check (prefix ~ '^[A-Z0-9]{1,8}$'),
  allow_manual boolean not null default false,
  is_system    boolean not null default true,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint accounting_voucher_types_code_unique unique (company_id, type_code),
  constraint accounting_voucher_types_id_company_unique unique (id, company_id)
);

create table if not exists public.accounting_voucher_sequences (
  company_id      uuid not null references public.companies (id) on delete restrict,
  voucher_type_id uuid not null,
  financial_year  text not null check (financial_year ~ '^[0-9]{4}(-[0-9]{2})?$'),
  last_number     bigint not null default 0 check (last_number >= 0),
  updated_at      timestamptz not null default now(),
  primary key (company_id, voucher_type_id, financial_year),
  constraint accounting_voucher_sequences_type_fk foreign key (voucher_type_id, company_id)
    references public.accounting_voucher_types (id, company_id) on delete restrict
);

create table if not exists public.accounting_vouchers (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete restrict,
  voucher_type_id        uuid not null,
  voucher_number         text check (voucher_number is null or length(voucher_number) <= 40),
  financial_year         text not null check (financial_year ~ '^[0-9]{4}(-[0-9]{2})?$'),
  voucher_date           date not null,
  reference_number       text check (reference_number is null or length(reference_number) <= 100),
  narration              text check (narration is null or length(narration) <= 1000),
  status                 text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'REVERSED', 'DISCARDED')),
  source                 text not null default 'MANUAL' check (source in ('MANUAL', 'AUTO', 'OPENING', 'REVERSAL')),
  source_type            text check (source_type is null or source_type ~ '^[A-Z_]{2,40}$'),
  source_id              uuid,
  source_number          text check (source_number is null or length(source_number) <= 100),
  reversal_of_voucher_id uuid,
  reversal_reason        text check (reversal_reason is null or length(reversal_reason) <= 1000),
  reversed_by            uuid,
  reversed_at            timestamptz,
  total_debit            numeric(18,2) not null default 0,
  total_credit           numeric(18,2) not null default 0,
  row_version            integer not null default 1 check (row_version >= 1),
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_by             uuid,
  updated_at             timestamptz not null default now(),
  posted_by              uuid,
  posted_at              timestamptz,
  discarded_by           uuid,
  discarded_at           timestamptz,
  discard_reason         text check (discard_reason is null or length(discard_reason) <= 1000),
  constraint accounting_vouchers_id_company_unique unique (id, company_id),
  constraint accounting_vouchers_number_unique unique (company_id, voucher_number),
  -- One reversal per voucher, even under concurrency.
  constraint accounting_vouchers_one_reversal unique (reversal_of_voucher_id),
  constraint accounting_vouchers_type_fk foreign key (voucher_type_id, company_id)
    references public.accounting_voucher_types (id, company_id) on delete restrict,
  constraint accounting_vouchers_reversal_fk foreign key (reversal_of_voucher_id, company_id)
    references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint accounting_vouchers_posted_state check ((status in ('POSTED', 'REVERSED')) = (voucher_number is not null and posted_at is not null)),
  constraint accounting_vouchers_balanced check (status not in ('POSTED', 'REVERSED') or (total_debit = total_credit and total_debit > 0)),
  constraint accounting_vouchers_reversed_state check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null)),
  constraint accounting_vouchers_discarded_state check ((status = 'DISCARDED') = (discarded_at is not null)),
  constraint accounting_vouchers_reversal_source check ((source = 'REVERSAL') = (reversal_of_voucher_id is not null)),
  constraint accounting_vouchers_source_ref check ((source = 'AUTO') <= (source_type is not null and source_id is not null))
);
comment on table public.accounting_vouchers is 'Accounting vouchers. Status changes only through the posting engine (transaction-bound token); posted vouchers are immutable.';
create index if not exists accounting_vouchers_company_date_idx on public.accounting_vouchers (company_id, voucher_date, status);
create index if not exists accounting_vouchers_source_idx on public.accounting_vouchers (company_id, source_type, source_id);
-- One automatic voucher per source document (its cancellation is a REVERSAL voucher).
create unique index if not exists accounting_vouchers_auto_source_unique on public.accounting_vouchers (company_id, source_type, source_id) where source = 'AUTO';

create table if not exists public.accounting_voucher_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  voucher_id     uuid not null,
  line_no        integer not null check (line_no between 1 and 9999),
  account_id     uuid not null,
  party_id       uuid,
  debit          numeric(18,2) not null default 0 check (debit >= 0),
  credit         numeric(18,2) not null default 0 check (credit >= 0),
  line_narration text check (line_narration is null or length(line_narration) <= 500),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint accounting_voucher_lines_one_side check ((debit > 0) <> (credit > 0)),
  constraint accounting_voucher_lines_no_unique unique (voucher_id, line_no),
  constraint accounting_voucher_lines_voucher_fk foreign key (voucher_id, company_id)
    references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint accounting_voucher_lines_account_fk foreign key (account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint accounting_voucher_lines_party_fk foreign key (party_id, company_id) references public.parties (id, company_id) on delete restrict
);
create index if not exists accounting_voucher_lines_account_idx on public.accounting_voucher_lines (company_id, account_id);
create index if not exists accounting_voucher_lines_party_idx on public.accounting_voucher_lines (party_id) where party_id is not null;

create table if not exists public.accounting_posting_rules (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  rule_key    text not null check (rule_key in ('DEBTORS', 'CREDITORS', 'SALES', 'SALES_RETURNS', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST',
                'ROUND_OFF', 'PURCHASES', 'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')),
  -- Payment method for RECEIPT_ACCOUNT / SUPPLIER_PAYMENT_ACCOUNT; '' for the other rules.
  match_value text not null default '' check (match_value = '' or match_value in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER')),
  account_id  uuid not null,
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  constraint accounting_posting_rules_unique unique (company_id, rule_key, match_value),
  constraint accounting_posting_rules_account_fk foreign key (account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint accounting_posting_rules_match check ((rule_key in ('RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT')) = (match_value <> ''))
);

create table if not exists public.accounting_posting_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  source_type    text not null check (source_type in ('SALES_INVOICE', 'CUSTOMER_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'SUPPLIER_PAYMENT', 'GOODS_RECEIPT')),
  source_id      uuid not null,
  event_action   text not null check (event_action in ('POST', 'REVERSE')),
  source_number  text check (source_number is null or length(source_number) <= 100),
  source_date    date not null,
  amount         numeric(18,2),
  status         text not null default 'PENDING' check (status in ('PENDING', 'POSTED', 'FAILED', 'NEEDS_ACCOUNT_MAPPING', 'SKIPPED', 'DISMISSED')),
  attempts       integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  error_code     text check (error_code is null or length(error_code) <= 60),
  error_message  text check (error_message is null or length(error_message) <= 2000),
  voucher_id     uuid,
  dismissed_by   uuid,
  dismissed_at   timestamptz,
  dismiss_reason text check (dismiss_reason is null or length(dismiss_reason) <= 500),
  posted_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Idempotency: one event per source document and action.
  constraint accounting_posting_events_unique unique (company_id, source_type, source_id, event_action),
  constraint accounting_posting_events_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint accounting_posting_events_posted check ((status = 'POSTED') = (voucher_id is not null)),
  constraint accounting_posting_events_dismissed check ((status = 'DISMISSED') = (dismissed_at is not null and dismiss_reason is not null))
);
create index if not exists accounting_posting_events_status_idx on public.accounting_posting_events (company_id, status, source_date);

create table if not exists public.accounting_opening_balance_batches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  batch_number    text not null check (batch_number ~ '^OB-[0-9]{4,}$'),
  as_of_date      date not null,
  source          text not null default 'MANUAL' check (source in ('MANUAL', 'IMPORT')),
  file_name       text check (file_name is null or length(file_name) <= 200),
  notes           text check (notes is null or length(notes) <= 1000),
  status          text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'POSTED', 'DISCARDED')),
  total_debit     numeric(18,2) not null default 0,
  total_credit    numeric(18,2) not null default 0,
  reconciliation  jsonb,
  acknowledgements jsonb not null default '[]'::jsonb check (jsonb_typeof(acknowledgements) = 'array'),
  voucher_id      uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  approved_by     uuid,
  approved_at     timestamptz,
  posted_by       uuid,
  posted_at       timestamptz,
  discarded_by    uuid,
  discarded_at    timestamptz,
  discard_reason  text check (discard_reason is null or length(discard_reason) <= 500),
  constraint accounting_opening_batches_number_unique unique (company_id, batch_number),
  constraint accounting_opening_batches_id_company_unique unique (id, company_id),
  constraint accounting_opening_batches_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint accounting_opening_batches_posted check ((status = 'POSTED') = (voucher_id is not null and posted_at is not null)),
  constraint accounting_opening_batches_approved check (status not in ('APPROVED', 'POSTED') or approved_at is not null)
);
-- One posted opening batch per company (later corrections are journal vouchers).
create unique index if not exists accounting_opening_batches_one_posted on public.accounting_opening_balance_batches (company_id) where status = 'POSTED';

create table if not exists public.accounting_opening_balance_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete restrict,
  batch_id         uuid not null,
  line_no          integer not null check (line_no between 1 and 20000),
  account_id       uuid not null,
  party_id         uuid,
  balance_category text not null default 'LEDGER' check (balance_category in ('LEDGER', 'PARTY', 'CASH_BANK', 'CAPITAL', 'LOAN', 'FIXED_ASSET', 'INVENTORY', 'OTHER')),
  debit            numeric(18,2) not null default 0 check (debit >= 0),
  credit           numeric(18,2) not null default 0 check (credit >= 0),
  description      text check (description is null or length(description) <= 300),
  created_at       timestamptz not null default now(),
  constraint accounting_opening_lines_one_side check ((debit > 0) <> (credit > 0)),
  constraint accounting_opening_lines_no_unique unique (batch_id, line_no),
  -- A ledger (or a party on a control account) appears once per batch.
  constraint accounting_opening_lines_account_party_unique unique nulls not distinct (batch_id, account_id, party_id),
  constraint accounting_opening_lines_batch_fk foreign key (batch_id, company_id)
    references public.accounting_opening_balance_batches (id, company_id) on delete restrict,
  constraint accounting_opening_lines_account_fk foreign key (account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint accounting_opening_lines_party_fk foreign key (party_id, company_id) references public.parties (id, company_id) on delete restrict
);

-- Transaction-bound status-transition tokens (private schema: not reachable through the Data API).
create table if not exists private.accounting_transition_tokens (
  token      uuid primary key default gen_random_uuid(),
  txid       bigint not null,
  voucher_id uuid not null,
  purpose    text not null check (purpose in ('POST', 'REVERSE', 'DISCARD')),
  created_at timestamptz not null default now()
);
revoke all on table private.accounting_transition_tokens from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Grants and RLS: read-only for permitted members; no write privilege for any API role
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['accounting_settings', 'accounting_periods', 'account_groups', 'accounts', 'accounting_cost_centres',
    'accounting_voucher_types', 'accounting_voucher_sequences', 'accounting_vouchers', 'accounting_voucher_lines', 'accounting_posting_rules',
    'accounting_posting_events', 'accounting_opening_balance_batches', 'accounting_opening_balance_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
  foreach t in array array['accounting_settings', 'accounting_periods', 'account_groups', 'accounts', 'accounting_cost_centres',
    'accounting_voucher_types', 'accounting_vouchers', 'accounting_voucher_lines', 'accounting_posting_rules',
    'accounting_posting_events', 'accounting_opening_balance_batches', 'accounting_opening_balance_lines'] loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

-- Read access: an active member holding any of the listed permissions.
create or replace function private.accounting_can_read(p_company uuid, p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from unnest(p_permissions) c where private.has_permission(p_company, c));
$$;
revoke all on function private.accounting_can_read(uuid, text[]) from public, anon;
grant execute on function private.accounting_can_read(uuid, text[]) to authenticated;

drop policy if exists accounting_settings_select on public.accounting_settings;
create policy accounting_settings_select on public.accounting_settings for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'accounting_reports.read', 'accounting_settings.manage']));
drop policy if exists accounting_periods_select on public.accounting_periods;
create policy accounting_periods_select on public.accounting_periods for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'accounting_reports.read', 'accounting_period.close']));
drop policy if exists account_groups_select on public.account_groups;
create policy account_groups_select on public.account_groups for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'vouchers.read', 'accounting_reports.read']));
drop policy if exists accounts_select on public.accounts;
create policy accounts_select on public.accounts for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_cost_centres_select on public.accounting_cost_centres;
create policy accounting_cost_centres_select on public.accounting_cost_centres for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_voucher_types_select on public.accounting_voucher_types;
create policy accounting_voucher_types_select on public.accounting_voucher_types for select to authenticated
  using (private.accounting_can_read(company_id, array['accounts.read', 'vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_vouchers_select on public.accounting_vouchers;
create policy accounting_vouchers_select on public.accounting_vouchers for select to authenticated
  using (private.accounting_can_read(company_id, array['vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_voucher_lines_select on public.accounting_voucher_lines;
create policy accounting_voucher_lines_select on public.accounting_voucher_lines for select to authenticated
  using (private.accounting_can_read(company_id, array['vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_posting_rules_select on public.accounting_posting_rules;
create policy accounting_posting_rules_select on public.accounting_posting_rules for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_settings.manage', 'accounting_posting.manage', 'accounting_reports.read']));
drop policy if exists accounting_posting_events_select on public.accounting_posting_events;
create policy accounting_posting_events_select on public.accounting_posting_events for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_posting.manage', 'accounting_reports.read']));
drop policy if exists accounting_opening_batches_select on public.accounting_opening_balance_batches;
create policy accounting_opening_batches_select on public.accounting_opening_balance_batches for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_opening.import', 'accounting_opening.approve', 'accounting_reports.read']));
drop policy if exists accounting_opening_lines_select on public.accounting_opening_balance_lines;
create policy accounting_opening_lines_select on public.accounting_opening_balance_lines for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_opening.import', 'accounting_opening.approve', 'accounting_reports.read']));

-- -----------------------------------------------------------------------------
-- 4. Security token and guards
-- -----------------------------------------------------------------------------
create or replace function private.accounting_issue_token(p_voucher uuid, p_purpose text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token uuid;
begin
  insert into private.accounting_transition_tokens (txid, voucher_id, purpose) values (txid_current(), p_voucher, p_purpose)
  returning token into v_token;
  perform set_config('app.accounting_token', v_token::text, true);
end;
$$;

create or replace function private.accounting_consume_token(p_voucher uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from private.accounting_transition_tokens where voucher_id = p_voucher and txid = txid_current();
  perform set_config('app.accounting_token', '', true);
end;
$$;

-- True only for a token issued in THIS transaction for this voucher and purpose, and named by the setting.
create or replace function private.accounting_token_ok(p_voucher uuid, p_purpose text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select exists (select 1 from private.accounting_transition_tokens t
                 where t.voucher_id = p_voucher and t.purpose = p_purpose and t.txid = txid_current()
                   and t.token::text = coalesce(current_setting('app.accounting_token', true), ''));
$$;

revoke all on function private.accounting_issue_token(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.accounting_consume_token(uuid) from public, anon, authenticated, service_role;
revoke all on function private.accounting_token_ok(uuid, text) from public, anon, authenticated, service_role;

create or replace function private.accounting_voucher_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_keep text[] := array['status', 'reversed_at', 'reversed_by', 'reversal_reason', 'updated_at', 'updated_by', 'row_version'];
begin
  if tg_op = 'DELETE' then
    if private.erp_force_purge_allows(tg_table_name, old.company_id) then
      return old;
    end if;
    raise exception 'Accounting vouchers are never deleted: discard a draft or reverse a posted voucher.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' or new.voucher_number is not null or new.posted_at is not null or new.reversed_at is not null or new.discarded_at is not null then
      raise exception 'A voucher is always created as a draft.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.source <> old.source or new.created_at <> old.created_at
     or new.reversal_of_voucher_id is distinct from old.reversal_of_voucher_id then
    raise exception 'A voucher''s company, source and reversal link cannot be changed.' using errcode = '42501';
  end if;
  if old.status = 'DRAFT' then
    if new.status = 'DRAFT' then
      if new.voucher_number is not null then
        raise exception 'A draft voucher has no voucher number.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.status = 'POSTED' and private.accounting_token_ok(old.id, 'POST') then
      return new;
    end if;
    if new.status = 'DISCARDED' and private.accounting_token_ok(old.id, 'DISCARD') then
      return new;
    end if;
    raise exception 'A voucher''s status can only be changed by the accounting posting engine.' using errcode = '42501';
  end if;
  if old.status = 'POSTED' and new.status = 'REVERSED' and private.accounting_token_ok(old.id, 'REVERSE')
     and (to_jsonb(new) - v_keep) = (to_jsonb(old) - v_keep) then
    return new;
  end if;
  raise exception 'Posted, reversed and discarded vouchers cannot be changed (voucher %).', coalesce(old.voucher_number, old.id::text) using errcode = '42501';
end;
$$;

create or replace function private.accounting_voucher_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' and private.erp_force_purge_allows(tg_table_name, old.company_id) then
    return old;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into v_status from public.accounting_vouchers where id = old.voucher_id;
    if v_status is distinct from 'DRAFT' then
      raise exception 'Lines of a posted, reversed or discarded voucher cannot be changed.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.voucher_id <> old.voucher_id or new.company_id <> old.company_id) then
    raise exception 'A voucher line cannot be moved to another voucher.' using errcode = '42501';
  end if;
  select status into v_status from public.accounting_vouchers where id = new.voucher_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'Lines can only be added to a draft voucher.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.accounting_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% cannot be truncated.', tg_table_name using errcode = '42501';
end;
$$;

-- Posted events keep their voucher link; opening batches change only while in progress.
create or replace function private.accounting_event_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'POSTED' then
    raise exception 'A posted accounting event cannot be changed.' using errcode = '42501';
  end if;
  if new.company_id <> old.company_id or new.source_type <> old.source_type or new.source_id <> old.source_id or new.event_action <> old.event_action then
    raise exception 'An accounting event''s source cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.accounting_opening_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_table_name = 'accounting_opening_balance_batches' then
    if old.status in ('POSTED', 'DISCARDED') then
      raise exception 'A posted or discarded opening balance batch cannot be changed.' using errcode = '42501';
    end if;
    if new.company_id <> old.company_id then
      raise exception 'An opening balance batch cannot move to another company.' using errcode = '42501';
    end if;
    return new;
  end if;
  select status into v_status from public.accounting_opening_balance_batches where id = coalesce(new.batch_id, old.batch_id);
  if v_status is distinct from 'DRAFT' and not (tg_op = 'DELETE' and private.erp_force_purge_allows(tg_table_name, old.company_id)) then
    raise exception 'Opening balance lines can only be changed while the batch is a draft.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.accounting_voucher_guard() from public, anon, authenticated;
revoke all on function private.accounting_voucher_line_guard() from public, anon, authenticated;
revoke all on function private.accounting_no_truncate() from public, anon, authenticated;
revoke all on function private.accounting_event_guard() from public, anon, authenticated;
revoke all on function private.accounting_opening_guard() from public, anon, authenticated;

drop trigger if exists accounting_vouchers_guard on public.accounting_vouchers;
create trigger accounting_vouchers_guard before insert or update or delete on public.accounting_vouchers
  for each row execute function private.accounting_voucher_guard();
drop trigger if exists accounting_voucher_lines_guard on public.accounting_voucher_lines;
create trigger accounting_voucher_lines_guard before insert or update or delete on public.accounting_voucher_lines
  for each row execute function private.accounting_voucher_line_guard();
drop trigger if exists accounting_vouchers_no_truncate on public.accounting_vouchers;
create trigger accounting_vouchers_no_truncate before truncate on public.accounting_vouchers
  for each statement execute function private.accounting_no_truncate();
drop trigger if exists accounting_voucher_lines_no_truncate on public.accounting_voucher_lines;
create trigger accounting_voucher_lines_no_truncate before truncate on public.accounting_voucher_lines
  for each statement execute function private.accounting_no_truncate();
drop trigger if exists accounting_posting_events_guard on public.accounting_posting_events;
create trigger accounting_posting_events_guard before update on public.accounting_posting_events
  for each row execute function private.accounting_event_guard();
drop trigger if exists accounting_opening_batches_guard on public.accounting_opening_balance_batches;
create trigger accounting_opening_batches_guard before update on public.accounting_opening_balance_batches
  for each row execute function private.accounting_opening_guard();
drop trigger if exists accounting_opening_lines_guard on public.accounting_opening_balance_lines;
create trigger accounting_opening_lines_guard before insert or update on public.accounting_opening_balance_lines
  for each row execute function private.accounting_opening_guard();

-- Chart of accounts integrity: same classification as the parent, no cycles; accounts take the group's classification.
create or replace function private.accounting_group_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent public.account_groups;
begin
  if new.parent_group_id is not null then
    select * into v_parent from public.account_groups where id = new.parent_group_id and company_id = new.company_id;
    if not found then
      raise exception 'The parent group does not exist in this company.' using errcode = 'P0001';
    end if;
    if v_parent.classification <> new.classification then
      raise exception 'Group "%" must have the same classification as its parent group "%" (%).', new.group_name, v_parent.group_name, v_parent.classification
        using errcode = 'P0001';
    end if;
    if tg_op = 'UPDATE' and exists (
      with recursive up (id, parent_group_id) as (
        select g.id, g.parent_group_id from public.account_groups g where g.id = new.parent_group_id
        union
        select g.id, g.parent_group_id from public.account_groups g join up on g.id = up.parent_group_id
      ) select 1 from up where up.id = new.id) then
      raise exception 'Group "%" cannot be placed under one of its own sub-groups.', new.group_name using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.classification <> old.classification
     and (exists (select 1 from public.account_groups c where c.parent_group_id = new.id)
          or exists (select 1 from public.accounts a where a.group_id = new.id)) then
    raise exception 'The classification of a group that has sub-groups or ledger accounts cannot be changed.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.accounting_account_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_group public.account_groups;
begin
  select * into v_group from public.account_groups where id = new.group_id and company_id = new.company_id;
  if not found then
    raise exception 'The account group does not exist in this company.' using errcode = 'P0001';
  end if;
  new.classification := v_group.classification;
  if tg_op = 'UPDATE' and new.classification <> old.classification
     and exists (select 1 from public.accounting_voucher_lines l where l.account_id = new.id) then
    raise exception 'Account % has vouchers: it can only move to a group with the same classification (%).', new.account_code, old.classification
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.accounting_group_check() from public, anon, authenticated;
revoke all on function private.accounting_account_check() from public, anon, authenticated;

drop trigger if exists account_groups_check on public.account_groups;
create trigger account_groups_check before insert or update on public.account_groups
  for each row execute function private.accounting_group_check();
drop trigger if exists accounts_check on public.accounts;
create trigger accounts_check before insert or update on public.accounts
  for each row execute function private.accounting_account_check();

-- -----------------------------------------------------------------------------
-- 5. Helpers
-- -----------------------------------------------------------------------------
-- Text from a JSON payload: trimmed, NULL when blank, length-checked.
create or replace function private.accounting_text(p jsonb, p_key text, p_max int, p_label text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is not null and length(v) > p_max then
    raise exception '% is too long (maximum % characters).', p_label, p_max using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Money from a JSON value: NUMERIC only, never negative, at most 2 decimals, fits numeric(18,2).
create or replace function private.accounting_amount(p jsonb, p_key text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw text := nullif(btrim(coalesce(p ->> p_key, '')), '');
  v     numeric;
begin
  if v_raw is null then
    return 0;
  end if;
  if v_raw !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception '% must be a number (got "%").', p_label, left(v_raw, 40) using errcode = '22023';
  end if;
  v := v_raw::numeric;
  if v < 0 then
    raise exception '% cannot be negative.', p_label using errcode = '22023';
  end if;
  if v <> round(v, 2) then
    raise exception '% can have at most 2 decimal places.', p_label using errcode = '22023';
  end if;
  if v > 9999999999999999.99 then
    raise exception '% is too large.', p_label using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function private.accounting_uuid(p jsonb, p_key text, p_label text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is null then
    return null;
  end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '% is not a valid id.', p_label using errcode = '22023';
  end if;
  return v::uuid;
end;
$$;

create or replace function private.accounting_date(p jsonb, p_key text, p_label text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p ->> p_key, '')), '');
begin
  if v is null then
    return null;
  end if;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception '% must be a date (YYYY-MM-DD).', p_label using errcode = '22023';
  end if;
  return v::date;
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception '% is not a valid date.', p_label using errcode = '22023';
end;
$$;

-- First day of the financial year containing p_date.
create or replace function private.accounting_fy_start(p_date date, p_start_month int)
returns date
language sql
immutable
set search_path = ''
as $$
  select make_date(case when extract(month from p_date)::int >= p_start_month then extract(year from p_date)::int
                        else extract(year from p_date)::int - 1 end, p_start_month, 1);
$$;

create or replace function private.accounting_settings_of(p_company uuid)
returns public.accounting_settings
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.accounting_settings where company_id = p_company;
$$;

create or replace function private.accounting_require_setup(p_company uuid)
returns public.accounting_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.accounting_settings := private.accounting_settings_of(p_company);
begin
  if s.company_id is null then
    raise exception 'Accounting is not set up for this company yet. Open Accounts > Accounting Settings and set the books start date.' using errcode = 'P0001';
  end if;
  return s;
end;
$$;

create or replace function private.accounting_party_name(p_party uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(c.customer_name, s.display_name, s.legal_name, p.party_code)
  from public.parties p
  left join public.customers c on c.id = p.customer_id
  left join public.suppliers s on s.id = p.supplier_id
  where p.id = p_party;
$$;

-- Balance of an account from posted vouchers (debit - credit), optionally up to a date.
create or replace function private.accounting_account_balance(p_account uuid, p_to date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0)
  from public.accounting_voucher_lines l
  join public.accounting_vouchers v on v.id = l.voucher_id
  where l.account_id = p_account and v.status in ('POSTED', 'REVERSED') and (p_to is null or v.voucher_date <= p_to);
$$;

-- Why a date cannot be posted to (NULL when it can): books start, open period, future and back-dating rules.
create or replace function private.accounting_date_issue(p_company uuid, p_date date, p_source text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s        public.accounting_settings := private.accounting_settings_of(p_company);
  v_today  date := private.company_today(p_company);
  v_period public.accounting_periods;
begin
  if s.company_id is null then
    return jsonb_build_object('code', 'NOT_SET_UP', 'message', 'Accounting is not set up for this company.');
  end if;
  if p_date is null then
    return jsonb_build_object('code', 'DATE_REQUIRED', 'message', 'The voucher date is required.');
  end if;
  if p_date < s.books_start_date then
    return jsonb_build_object('code', 'BEFORE_BOOKS_START', 'message',
      format('The date %s is before the books start date %s.', to_char(p_date, 'DD-Mon-YYYY'), to_char(s.books_start_date, 'DD-Mon-YYYY')));
  end if;
  if not s.allow_future_dates and p_date > v_today then
    return jsonb_build_object('code', 'FUTURE_DATE', 'message', format('The date %s is in the future; future-dated vouchers are not allowed.', to_char(p_date, 'DD-Mon-YYYY')));
  end if;
  if p_source = 'MANUAL' and s.backdate_limit_days is not null and p_date < v_today - s.backdate_limit_days then
    return jsonb_build_object('code', 'BACKDATE_LIMIT', 'message',
      format('The date %s is more than %s day(s) in the past; back-dated vouchers beyond that are not allowed.', to_char(p_date, 'DD-Mon-YYYY'), s.backdate_limit_days));
  end if;
  select * into v_period from public.accounting_periods where company_id = p_company and p_date between start_date and end_date;
  if not found then
    return jsonb_build_object('code', 'NO_PERIOD', 'message', format('There is no accounting period for %s. Create the financial year''s periods first.', to_char(p_date, 'DD-Mon-YYYY')));
  end if;
  if v_period.status = 'CLOSED' then
    return jsonb_build_object('code', 'PERIOD_CLOSED', 'message', format('The accounting period %s is closed.', v_period.period_name));
  end if;
  return null;
end;
$$;

-- Every reason a voucher cannot be posted, as [{code, message, line_no}] (empty = valid). Read-only.
create or replace function private.accounting_voucher_issues(p_voucher uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v        public.accounting_vouchers;
  t        public.accounting_voucher_types;
  v_issues jsonb := '[]'::jsonb;
  v_n      int;
  v_dr     numeric;
  v_cr     numeric;
  v_date   jsonb;
  r        record;
begin
  select * into v from public.accounting_vouchers where id = p_voucher;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'NOT_FOUND', 'message', 'Voucher not found.'));
  end if;
  select * into t from public.accounting_voucher_types where id = v.voucher_type_id;
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_n, v_dr, v_cr
  from public.accounting_voucher_lines where voucher_id = p_voucher;

  if v_n < 2 then
    v_issues := v_issues || jsonb_build_object('code', 'MIN_LINES', 'message', 'A voucher needs at least two lines.');
  end if;
  if v_n > 0 and (not exists (select 1 from public.accounting_voucher_lines where voucher_id = p_voucher and debit > 0)
                  or not exists (select 1 from public.accounting_voucher_lines where voucher_id = p_voucher and credit > 0)) then
    v_issues := v_issues || jsonb_build_object('code', 'ONE_SIDED', 'message', 'A voucher needs at least one debit line and one credit line.');
  end if;
  if v_dr <> v_cr then
    v_issues := v_issues || jsonb_build_object('code', 'UNBALANCED', 'message',
      format('Total debit (%s) does not equal total credit (%s); difference %s.', to_char(v_dr, 'FM999999999999990.00'),
             to_char(v_cr, 'FM999999999999990.00'), to_char(abs(v_dr - v_cr), 'FM999999999999990.00')));
  end if;
  if not t.is_active then
    v_issues := v_issues || jsonb_build_object('code', 'TYPE_INACTIVE', 'message', format('Voucher type %s is inactive.', t.type_name));
  end if;
  if v.source = 'MANUAL' and not t.allow_manual then
    v_issues := v_issues || jsonb_build_object('code', 'TYPE_NOT_MANUAL', 'message', format('%s vouchers are created automatically only.', t.type_name));
  end if;
  v_date := private.accounting_date_issue(v.company_id, v.voucher_date, v.source);
  if v_date is not null then
    v_issues := v_issues || v_date;
  end if;

  for r in
    select l.line_no, l.party_id, a.account_code, a.account_name, a.is_active, a.is_postable, a.allow_manual_posting, a.requires_party, g.is_active as group_active
    from public.accounting_voucher_lines l
    join public.accounts a on a.id = l.account_id
    join public.account_groups g on g.id = a.group_id
    where l.voucher_id = p_voucher
    order by l.line_no
  loop
    -- A reversal must always be possible, so it is not stopped by later account changes.
    if v.source <> 'REVERSAL' and not (r.is_active and r.group_active) then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_INACTIVE', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is inactive.', r.line_no, r.account_code, r.account_name));
    end if;
    if v.source <> 'REVERSAL' and not r.is_postable then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_NOT_POSTABLE', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s does not accept postings.', r.line_no, r.account_code, r.account_name));
    end if;
    if v.source = 'MANUAL' and not r.allow_manual_posting then
      v_issues := v_issues || jsonb_build_object('code', 'ACCOUNT_NO_MANUAL', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is posted automatically only (control account).', r.line_no, r.account_code, r.account_name));
    end if;
    if r.requires_party and r.party_id is null then
      v_issues := v_issues || jsonb_build_object('code', 'PARTY_REQUIRED', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s needs a customer or supplier.', r.line_no, r.account_code, r.account_name));
    end if;
    if not r.requires_party and r.party_id is not null then
      v_issues := v_issues || jsonb_build_object('code', 'PARTY_NOT_ALLOWED', 'line_no', r.line_no,
        'message', format('Line %s: account %s %s is not a party account; remove the customer / supplier.', r.line_no, r.account_code, r.account_name));
    end if;
  end loop;

  for r in
    select a.account_code, a.account_name
    from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
    where l.voucher_id = p_voucher
    group by a.account_code, a.account_name, l.party_id
    having bool_or(l.debit > 0) and bool_or(l.credit > 0)
  loop
    v_issues := v_issues || jsonb_build_object('code', 'SAME_ACCOUNT_BOTH_SIDES', 'message',
      format('Account %s %s is both debited and credited in this voucher; enter the net amount once.', r.account_code, r.account_name));
  end loop;
  return v_issues;
end;
$$;

-- Next voucher number for a type and financial year. The upsert row-locks the counter, so concurrent
-- postings get distinct, consecutive numbers; a rolled-back posting leaves no gap.
create or replace function private.accounting_next_number(p_company uuid, p_type uuid, p_fy text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_next   bigint;
begin
  select prefix into v_prefix from public.accounting_voucher_types where id = p_type and company_id = p_company;
  insert into public.accounting_voucher_sequences (company_id, voucher_type_id, financial_year, last_number) values (p_company, p_type, p_fy, 1)
  on conflict (company_id, voucher_type_id, financial_year)
  do update set last_number = public.accounting_voucher_sequences.last_number + 1, updated_at = now()
  returning last_number into v_next;
  return v_prefix || '/' || case when p_fy like '%-%' then substr(p_fy, 3, 2) || '-' || right(p_fy, 2) else p_fy end || '/' || lpad(v_next::text, 6, '0');
end;
$$;

-- Parses voucher / opening lines: [{account_id, party_id, debit, credit, narration}] (at most 500).
create or replace function private.accounting_parse_lines(p_company uuid, p_lines jsonb)
returns table (line_no int, account_id uuid, party_id uuid, debit numeric, credit numeric, narration text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e   jsonb;
  i   int := 0;
  v_a uuid;
  v_p uuid;
  v_d numeric;
  v_c numeric;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Lines must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'A voucher can have at most 500 lines.' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'Line %: invalid line.', i using errcode = '22023';
    end if;
    v_a := private.accounting_uuid(e, 'account_id', format('Line %s account', i));
    if v_a is null then
      raise exception 'Line %: select a ledger account.', i using errcode = '22023';
    end if;
    if not exists (select 1 from public.accounts a where a.id = v_a and a.company_id = p_company) then
      raise exception 'Line %: the ledger account does not exist in this company.', i using errcode = '42501';
    end if;
    v_p := private.accounting_uuid(e, 'party_id', format('Line %s party', i));
    if v_p is not null and not exists (select 1 from public.parties p where p.id = v_p and p.company_id = p_company) then
      raise exception 'Line %: the customer / supplier does not exist in this company.', i using errcode = '42501';
    end if;
    v_d := private.accounting_amount(e, 'debit', format('Line %s debit', i));
    v_c := private.accounting_amount(e, 'credit', format('Line %s credit', i));
    if (v_d > 0) = (v_c > 0) then
      raise exception 'Line %: enter either a debit or a credit amount greater than zero (not both, not zero).', i using errcode = '22023';
    end if;
    line_no := i; account_id := v_a; party_id := v_p; debit := v_d; credit := v_c;
    narration := private.accounting_text(e, 'narration', 500, format('Line %s narration', i));
    return next;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Posting engine (used by manual, automatic, opening and reversal vouchers)
-- -----------------------------------------------------------------------------
create or replace function private.accounting_create_voucher(
  p_company uuid, p_type_code text, p_date date, p_reference text, p_narration text, p_source text,
  p_source_type text, p_source_id uuid, p_source_number text, p_reversal_of uuid, p_lines jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s      public.accounting_settings := private.accounting_require_setup(p_company);
  v_type public.accounting_voucher_types;
  v_id   uuid;
begin
  select * into v_type from public.accounting_voucher_types where company_id = p_company and type_code = upper(p_type_code);
  if not found then
    raise exception 'Unknown voucher type %.', p_type_code using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'The voucher date is required.' using errcode = '22023';
  end if;
  insert into public.accounting_vouchers (company_id, voucher_type_id, financial_year, voucher_date, reference_number, narration, source,
    source_type, source_id, source_number, reversal_of_voucher_id, created_by, updated_by)
  values (p_company, v_type.id, private.financial_year(p_date, s.fy_start_month), p_date, left(p_reference, 100), left(p_narration, 1000), p_source,
    p_source_type, p_source_id, left(p_source_number, 100), p_reversal_of, auth.uid(), auth.uid())
  returning id into v_id;
  insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
  select p_company, v_id, l.line_no, l.account_id, l.party_id, l.debit, l.credit, l.narration
  from private.accounting_parse_lines(p_company, coalesce(p_lines, '[]'::jsonb)) l;
  return v_id;
end;
$$;

create or replace function private.accounting_post_voucher(p_voucher uuid, p_row_version int default null)
returns public.accounting_vouchers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        public.accounting_vouchers;
  s        public.accounting_settings;
  v_issues jsonb;
  v_fy     text;
  v_number text;
  v_dr     numeric;
  v_cr     numeric;
begin
  -- Row lock: a concurrent post of the same voucher waits here and then sees it is no longer a draft.
  select * into v from public.accounting_vouchers where id = p_voucher for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v.status <> 'DRAFT' then
    raise exception 'Voucher % is already %; it cannot be posted again.', coalesce(v.voucher_number, ''), lower(v.status) using errcode = 'P0001';
  end if;
  if p_row_version is not null and v.row_version <> p_row_version then
    raise exception 'This voucher was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  v_issues := private.accounting_voucher_issues(p_voucher);
  if jsonb_array_length(v_issues) > 0 then
    raise exception '%', v_issues -> 0 ->> 'message' using errcode = 'P0001', detail = v_issues::text;
  end if;
  s := private.accounting_require_setup(v.company_id);
  v_fy := private.financial_year(v.voucher_date, s.fy_start_month);
  v_number := private.accounting_next_number(v.company_id, v.voucher_type_id, v_fy);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_dr, v_cr from public.accounting_voucher_lines where voucher_id = p_voucher;

  perform private.accounting_issue_token(v.id, 'POST');
  update public.accounting_vouchers
     set status = 'POSTED', voucher_number = v_number, financial_year = v_fy, total_debit = v_dr, total_credit = v_cr,
         posted_by = auth.uid(), posted_at = now(), updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform private.accounting_consume_token(v.id);

  perform private.write_audit_log(v.company_id, 'accounting.voucher.posted', 'accounting_voucher', v.id::text,
    jsonb_build_object('voucher_number', v.voucher_number, 'voucher_date', v.voucher_date, 'amount', v.total_debit, 'source', v.source,
      'source_type', v.source_type, 'source_number', v.source_number));
  return v;
end;
$$;

-- Linked opposite-entry voucher; the original becomes REVERSED. Returns the reversal voucher.
create or replace function private.accounting_reverse_voucher(p_voucher uuid, p_reason text, p_date date)
returns public.accounting_vouchers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_orig   public.accounting_vouchers;
  v_rev    public.accounting_vouchers;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_date   date;
  v_lines  jsonb;
  v_id     uuid;
begin
  select * into v_orig from public.accounting_vouchers where id = p_voucher for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v_orig.status = 'REVERSED' then
    raise exception 'Voucher % has already been reversed.', v_orig.voucher_number using errcode = 'P0001';
  end if;
  if v_orig.status <> 'POSTED' then
    raise exception 'Only posted vouchers can be reversed (voucher is %).', lower(v_orig.status) using errcode = 'P0001';
  end if;
  if v_orig.source = 'REVERSAL' then
    raise exception 'Voucher % is itself a reversal and cannot be reversed.', v_orig.voucher_number using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The reversal reason is too long (maximum 1000 characters).' using errcode = '22023';
  end if;
  v_date := coalesce(p_date, private.company_today(v_orig.company_id));
  if v_date < v_orig.voucher_date then
    raise exception 'The reversal date cannot be before the original voucher date (%).', to_char(v_orig.voucher_date, 'DD-Mon-YYYY') using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'party_id', l.party_id, 'debit', l.credit, 'credit', l.debit,
                                      'narration', l.line_narration) order by l.line_no)
    into v_lines from public.accounting_voucher_lines l where l.voucher_id = v_orig.id;
  v_id := private.accounting_create_voucher(v_orig.company_id, 'REV', v_date, v_orig.voucher_number,
    left('Reversal of ' || v_orig.voucher_number || ': ' || v_reason, 1000), 'REVERSAL', v_orig.source_type, v_orig.source_id, v_orig.source_number,
    v_orig.id, v_lines);
  v_rev := private.accounting_post_voucher(v_id);

  perform private.accounting_issue_token(v_orig.id, 'REVERSE');
  update public.accounting_vouchers
     set status = 'REVERSED', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = v_reason, updated_by = auth.uid(), updated_at = now(),
         row_version = row_version + 1
   where id = v_orig.id;
  perform private.accounting_consume_token(v_orig.id);

  perform private.write_audit_log(v_orig.company_id, 'accounting.voucher.reversed', 'accounting_voucher', v_orig.id::text,
    jsonb_build_object('voucher_number', v_orig.voucher_number, 'reversal_voucher_id', v_rev.id, 'reversal_voucher_number', v_rev.voucher_number,
      'reversal_date', v_date, 'reason', left(v_reason, 500)));
  return v_rev;
end;
$$;

revoke all on function private.accounting_text(jsonb, text, int, text) from public, anon, authenticated;
revoke all on function private.accounting_amount(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.accounting_uuid(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.accounting_date(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.accounting_fy_start(date, int) from public, anon, authenticated;
revoke all on function private.accounting_settings_of(uuid) from public, anon, authenticated;
revoke all on function private.accounting_require_setup(uuid) from public, anon, authenticated;
revoke all on function private.accounting_party_name(uuid) from public, anon, authenticated;
revoke all on function private.accounting_account_balance(uuid, date) from public, anon, authenticated;
revoke all on function private.accounting_date_issue(uuid, date, text) from public, anon, authenticated;
revoke all on function private.accounting_voucher_issues(uuid) from public, anon, authenticated;
revoke all on function private.accounting_next_number(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.accounting_parse_lines(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.accounting_create_voucher(uuid, text, date, text, text, text, text, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.accounting_post_voucher(uuid, int) from public, anon, authenticated, service_role;
revoke all on function private.accounting_reverse_voucher(uuid, text, date) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Set-up: default chart of accounts, voucher types, posting rules and periods
-- -----------------------------------------------------------------------------
create or replace function private.accounting_generate_periods(p_company uuid, p_any_date date)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s       public.accounting_settings := private.accounting_require_setup(p_company);
  v_start date := private.accounting_fy_start(p_any_date, s.fy_start_month);
  v_fy    text := private.financial_year(v_start, s.fy_start_month);
  v_made  int := 0;
  i       int;
  v_from  date;
begin
  for i in 1..12 loop
    v_from := (v_start + make_interval(months => i - 1))::date;
    insert into public.accounting_periods (company_id, financial_year, period_no, period_name, start_date, end_date)
    values (p_company, v_fy, i, to_char(v_from, 'Mon YYYY'), v_from, ((v_from + interval '1 month')::date - 1))
    on conflict do nothing;
    if found then
      v_made := v_made + 1;
    end if;
  end loop;
  return v_made;
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
end;
$$;

revoke all on function private.accounting_generate_periods(uuid, date) from public, anon, authenticated, service_role;
revoke all on function private.accounting_seed_chart(uuid) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8. Settings and periods RPCs
-- -----------------------------------------------------------------------------
create or replace function public.accounting_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read', 'accounting_settings.manage',
                      'accounting_posting.manage', 'accounting_opening.import', 'accounting_opening.approve', 'accounting_period.close']);
  s         public.accounting_settings := private.accounting_settings_of(v_company);
begin
  return jsonb_build_object(
    'initialized', s.company_id is not null,
    'settings', case when s.company_id is null then null else jsonb_build_object(
      'books_start_date', s.books_start_date, 'fy_start_month', s.fy_start_month, 'currency_code', s.currency_code,
      'allow_future_dates', s.allow_future_dates, 'backdate_limit_days', s.backdate_limit_days, 'segregation_of_duties', s.segregation_of_duties,
      'auto_posting_max_attempts', s.auto_posting_max_attempts, 'initialized_at', s.initialized_at, 'updated_at', s.updated_at) end,
    'current_financial_year', case when s.company_id is null then null
      else private.financial_year(private.company_today(v_company), s.fy_start_month) end,
    'today', private.company_today(v_company),
    'has_postings', exists (select 1 from public.accounting_vouchers where company_id = v_company and status in ('POSTED', 'REVERSED')),
    'has_vouchers', exists (select 1 from public.accounting_vouchers where company_id = v_company),
    'default_fy_start_month', coalesce((select fy_start_month from public.invoice_settings where company_id = v_company), 4));
end;
$$;

create or replace function public.accounting_initialize(p_books_start_date date, p_fy_start_month integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  v_month   int;
  v_periods int;
begin
  perform pg_advisory_xact_lock(hashtextextended('accounting_setup:' || v_company::text, 0));
  if exists (select 1 from public.accounting_settings where company_id = v_company) then
    raise exception 'Accounting is already set up for this company.' using errcode = 'P0001';
  end if;
  if p_books_start_date is null then
    raise exception 'The books start date is required.' using errcode = '22023';
  end if;
  if p_books_start_date < date '2000-01-01' or p_books_start_date > private.company_today(v_company) + 366 then
    raise exception 'The books start date is out of range.' using errcode = '22023';
  end if;
  v_month := coalesce(p_fy_start_month, (select fy_start_month from public.invoice_settings where company_id = v_company), 4);
  if v_month not between 1 and 12 then
    raise exception 'The financial year start month must be between 1 and 12.' using errcode = '22023';
  end if;
  insert into public.accounting_settings (company_id, books_start_date, fy_start_month, initialized_by, updated_by)
  values (v_company, p_books_start_date, v_month, auth.uid(), auth.uid());
  perform private.accounting_seed_chart(v_company);
  v_periods := private.accounting_generate_periods(v_company, p_books_start_date);
  perform private.write_audit_log(v_company, 'accounting.settings.initialized', 'accounting_settings', v_company::text,
    jsonb_build_object('books_start_date', p_books_start_date, 'fy_start_month', v_month, 'periods_created', v_periods));
  return public.accounting_status();
end;
$$;

create or replace function public.accounting_settings_save(p_settings jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
  s         public.accounting_settings;
  v_new     public.accounting_settings;
  v_start   date;
  v_month   int;
begin
  select * into s from public.accounting_settings where company_id = v_company for update;
  if not found then
    raise exception 'Accounting is not set up for this company yet.' using errcode = 'P0001';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Settings must be an object.' using errcode = '22023';
  end if;
  v_new := s;
  if p_settings ? 'books_start_date' then
    v_start := private.accounting_date(p_settings, 'books_start_date', 'Books start date');
    if v_start is null then
      raise exception 'The books start date is required.' using errcode = '22023';
    end if;
    if v_start <> s.books_start_date and exists (select 1 from public.accounting_vouchers where company_id = v_company and status <> 'DISCARDED') then
      raise exception 'The books start date cannot change once vouchers exist.' using errcode = 'P0001';
    end if;
    v_new.books_start_date := v_start;
  end if;
  if p_settings ? 'fy_start_month' then
    v_month := (p_settings ->> 'fy_start_month')::int;
    if v_month is null or v_month not between 1 and 12 then
      raise exception 'The financial year start month must be between 1 and 12.' using errcode = '22023';
    end if;
    if v_month <> s.fy_start_month and (exists (select 1 from public.accounting_vouchers where company_id = v_company)
                                        or exists (select 1 from public.accounting_periods where company_id = v_company and status <> 'OPEN')) then
      raise exception 'The financial year cannot change once vouchers exist or a period has been closed.' using errcode = 'P0001';
    end if;
    v_new.fy_start_month := v_month;
  end if;
  if p_settings ? 'allow_future_dates' then
    v_new.allow_future_dates := coalesce((p_settings ->> 'allow_future_dates')::boolean, false);
  end if;
  if p_settings ? 'backdate_limit_days' then
    v_new.backdate_limit_days := nullif(p_settings ->> 'backdate_limit_days', '')::int;
  end if;
  if p_settings ? 'segregation_of_duties' then
    v_new.segregation_of_duties := coalesce((p_settings ->> 'segregation_of_duties')::boolean, false);
  end if;
  if p_settings ? 'auto_posting_max_attempts' then
    v_new.auto_posting_max_attempts := (p_settings ->> 'auto_posting_max_attempts')::int;
  end if;
  update public.accounting_settings
     set books_start_date = v_new.books_start_date, fy_start_month = v_new.fy_start_month, allow_future_dates = v_new.allow_future_dates,
         backdate_limit_days = v_new.backdate_limit_days, segregation_of_duties = v_new.segregation_of_duties,
         auto_posting_max_attempts = v_new.auto_posting_max_attempts, updated_by = auth.uid(), updated_at = now()
   where company_id = v_company;
  if v_new.fy_start_month <> s.fy_start_month then
    -- Only open periods without vouchers exist (checked above): rebuild them for the new financial year.
    delete from public.accounting_periods where company_id = v_company;
    perform private.accounting_generate_periods(v_company, v_new.books_start_date);
  elsif v_new.books_start_date <> s.books_start_date then
    perform private.accounting_generate_periods(v_company, v_new.books_start_date);
  end if;
  perform private.write_audit_log(v_company, 'accounting.settings.updated', 'accounting_settings', v_company::text,
    jsonb_build_object('before', to_jsonb(s) - array['company_id', 'initialized_by', 'updated_by'],
                       'after', to_jsonb(v_new) - array['company_id', 'initialized_by', 'updated_by']));
  return public.accounting_status();
exception
  when invalid_text_representation then
    raise exception 'A setting has an invalid value.' using errcode = '22023';
end;
$$;

create or replace function public.accounting_periods(p_financial_year text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'accounting_reports.read', 'accounting_period.close', 'accounting_settings.manage']);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'financial_year', p.financial_year, 'period_no', p.period_no, 'period_name', p.period_name,
      'start_date', p.start_date, 'end_date', p.end_date, 'status', p.status, 'status_reason', p.status_reason, 'closed_at', p.closed_at,
      'reopened_at', p.reopened_at,
      'draft_vouchers', (select count(*) from public.accounting_vouchers v where v.company_id = v_company and v.status = 'DRAFT'
                           and v.voucher_date between p.start_date and p.end_date),
      'posted_vouchers', (select count(*) from public.accounting_vouchers v where v.company_id = v_company and v.status in ('POSTED', 'REVERSED')
                           and v.voucher_date between p.start_date and p.end_date))
      order by p.start_date)
    from public.accounting_periods p
    where p.company_id = v_company and (p_financial_year is null or p.financial_year = p_financial_year)), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_period_generate(p_any_date date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_period.close');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_made    int;
begin
  if p_any_date is null or p_any_date < private.accounting_fy_start(s.books_start_date, s.fy_start_month) then
    raise exception 'Periods can only be created from the financial year of the books start date onwards.' using errcode = '22023';
  end if;
  if p_any_date > private.company_today(v_company) + 400 then
    raise exception 'Periods can be created at most one financial year ahead.' using errcode = '22023';
  end if;
  v_made := private.accounting_generate_periods(v_company, p_any_date);
  perform private.write_audit_log(v_company, 'accounting.period.generated', 'accounting_period', null,
    jsonb_build_object('financial_year', private.financial_year(p_any_date, s.fy_start_month), 'periods_created', v_made));
  return jsonb_build_object('financial_year', private.financial_year(p_any_date, s.fy_start_month), 'periods_created', v_made);
end;
$$;

create or replace function public.accounting_period_set_status(p_period_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_period.close');
  v_p       public.accounting_periods;
  v_status  text := upper(coalesce(p_status, ''));
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_p from public.accounting_periods where id = p_period_id and company_id = v_company for update;
  if not found then
    raise exception 'Accounting period not found.' using errcode = 'P0002';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'The reason is too long (maximum 500 characters).' using errcode = '22023';
  end if;
  if v_status = 'CLOSED' then
    if v_p.status = 'CLOSED' then
      raise exception 'Period % is already closed.', v_p.period_name using errcode = 'P0001';
    end if;
    update public.accounting_periods set status = 'CLOSED', closed_by = auth.uid(), closed_at = now(), status_reason = v_reason, updated_at = now()
     where id = v_p.id;
  elsif v_status = 'REOPENED' then
    if v_p.status <> 'CLOSED' then
      raise exception 'Only a closed period can be reopened.' using errcode = 'P0001';
    end if;
    if v_reason is null or length(v_reason) < 5 then
      raise exception 'A reason of at least 5 characters is required to reopen a period.' using errcode = '22023';
    end if;
    update public.accounting_periods set status = 'REOPENED', reopened_by = auth.uid(), reopened_at = now(), status_reason = v_reason, updated_at = now()
     where id = v_p.id;
  else
    raise exception 'Status must be CLOSED or REOPENED.' using errcode = '22023';
  end if;
  perform private.write_audit_log(v_company, 'accounting.period.' || lower(v_status), 'accounting_period', v_p.id::text,
    jsonb_build_object('period', v_p.period_name, 'financial_year', v_p.financial_year, 'from', v_p.status, 'to', v_status, 'reason', v_reason));
  return jsonb_build_object('id', v_p.id, 'status', v_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Chart of accounts and cost centres RPCs
-- -----------------------------------------------------------------------------
create or replace function public.accounting_chart()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
begin
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'group_code', g.group_code, 'group_name', g.group_name,
        'parent_group_id', g.parent_group_id, 'classification', g.classification, 'normal_balance', g.normal_balance, 'is_system', g.is_system,
        'is_active', g.is_active, 'sort_order', g.sort_order, 'description', g.description) order by g.sort_order, g.group_code)
      from public.account_groups g where g.company_id = v_company), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name,
        'group_id', a.group_id, 'group_name', g.group_name, 'classification', a.classification, 'normal_balance', a.normal_balance,
        'account_nature', a.account_nature, 'is_postable', a.is_postable, 'allow_manual_posting', a.allow_manual_posting,
        'requires_party', a.requires_party, 'is_control', a.is_control, 'is_system', a.is_system, 'system_key', a.system_key,
        'is_active', a.is_active, 'description', a.description, 'balance', coalesce(b.balance, 0), 'line_count', coalesce(b.n, 0))
        order by a.account_code)
      from public.accounts a
      join public.account_groups g on g.id = a.group_id
      left join (select l.account_id, sum(l.debit - l.credit) as balance, count(*) as n
                 from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                 where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') group by l.account_id) b on b.account_id = a.id
      where a.company_id = v_company), '[]'::jsonb));
end;
$$;

create or replace function public.accounting_group_save(p_group_id uuid, p_group jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  v_old     public.account_groups;
  v_code    text := upper(private.accounting_text(p_group, 'group_code', 20, 'Group code'));
  v_name    text := private.accounting_text(p_group, 'group_name', 120, 'Group name');
  v_parent  uuid := private.accounting_uuid(p_group, 'parent_group_id', 'Parent group');
  v_desc    text := private.accounting_text(p_group, 'description', 500, 'Description');
  v_active  boolean := coalesce((p_group ->> 'is_active')::boolean, true);
  v_p       public.account_groups;
  v_id      uuid;
begin
  perform private.accounting_require_setup(v_company);
  if v_name is null or length(v_name) < 2 then
    raise exception 'The group name is required (at least 2 characters).' using errcode = '22023';
  end if;
  if v_parent is null then
    raise exception 'Select the parent group (new top-level groups cannot be added).' using errcode = '22023';
  end if;
  select * into v_p from public.account_groups where id = v_parent and company_id = v_company;
  if not found then
    raise exception 'The parent group does not exist in this company.' using errcode = '42501';
  end if;
  if p_group_id is null then
    if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$' then
      raise exception 'The group code is required: letters, digits, . _ - (up to 20).' using errcode = '22023';
    end if;
    insert into public.account_groups (company_id, group_code, group_name, parent_group_id, classification, normal_balance, description, is_active,
      sort_order, created_by, updated_by)
    values (v_company, v_code, v_name, v_parent, v_p.classification, v_p.normal_balance, v_desc, v_active, v_p.sort_order, auth.uid(), auth.uid())
    returning id into v_id;
    perform private.write_audit_log(v_company, 'accounting.group.created', 'account_group', v_id::text, jsonb_build_object('code', v_code, 'name', v_name));
  else
    select * into v_old from public.account_groups where id = p_group_id and company_id = v_company for update;
    if not found then
      raise exception 'Account group not found.' using errcode = 'P0002';
    end if;
    if v_old.is_system and (v_parent is distinct from v_old.parent_group_id or not v_active) then
      raise exception 'System groups cannot be moved or deactivated; you can rename them.' using errcode = 'P0001';
    end if;
    if not v_active and (exists (select 1 from public.accounts a where a.group_id = v_old.id and a.is_active)
                         or exists (select 1 from public.account_groups c where c.parent_group_id = v_old.id and c.is_active)) then
      raise exception 'Deactivate the group''s active ledger accounts and sub-groups first.' using errcode = 'P0001';
    end if;
    update public.account_groups
       set group_name = v_name, parent_group_id = case when v_old.is_system then v_old.parent_group_id else v_parent end,
           classification = case when v_old.is_system then v_old.classification else v_p.classification end,
           description = v_desc, is_active = v_active, updated_by = auth.uid()
     where id = v_old.id;
    v_id := v_old.id;
    perform private.write_audit_log(v_company, 'accounting.group.updated', 'account_group', v_id::text,
      jsonb_build_object('code', v_old.group_code, 'name', v_name, 'parent_changed', v_parent is distinct from v_old.parent_group_id, 'is_active', v_active));
  end if;
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'A group with this code or name already exists.' using errcode = '23505';
end;
$$;

create or replace function public.accounting_account_save(p_account_id uuid, p_account jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  v_old     public.accounts;
  v_code    text := upper(private.accounting_text(p_account, 'account_code', 20, 'Account code'));
  v_name    text := private.accounting_text(p_account, 'account_name', 150, 'Account name');
  v_group   uuid := private.accounting_uuid(p_account, 'group_id', 'Account group');
  v_nature  text := upper(coalesce(private.accounting_text(p_account, 'account_nature', 30, 'Account nature'), 'GENERAL'));
  v_desc    text := private.accounting_text(p_account, 'description', 500, 'Description');
  v_postable boolean := coalesce((p_account ->> 'is_postable')::boolean, true);
  v_manual  boolean := coalesce((p_account ->> 'allow_manual_posting')::boolean, true);
  v_nb      text := upper(private.accounting_text(p_account, 'normal_balance', 6, 'Normal balance'));
  v_g       public.account_groups;
  v_id      uuid;
begin
  perform private.accounting_require_setup(v_company);
  if v_name is null or length(v_name) < 2 then
    raise exception 'The account name is required (at least 2 characters).' using errcode = '22023';
  end if;
  select * into v_g from public.account_groups where id = v_group and company_id = v_company;
  if not found then
    raise exception 'Select an account group of this company.' using errcode = '22023';
  end if;
  if not v_g.is_active then
    raise exception 'Group "%" is inactive.', v_g.group_name using errcode = 'P0001';
  end if;
  if v_nature in ('RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') then
    raise exception 'Debtors and Creditors control accounts are system accounts and cannot be created.' using errcode = 'P0001';
  end if;
  if v_nature not in ('GENERAL', 'CASH', 'BANK', 'TAX', 'INVENTORY', 'ROUND_OFF', 'CAPITAL', 'LOAN', 'FIXED_ASSET') then
    raise exception 'Unknown account nature %.', v_nature using errcode = '22023';
  end if;
  if v_nb is not null and v_nb not in ('DEBIT', 'CREDIT') then
    raise exception 'Normal balance must be DEBIT or CREDIT.' using errcode = '22023';
  end if;
  if p_account_id is null then
    if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$' then
      raise exception 'The account code is required: letters, digits, . _ - (up to 20).' using errcode = '22023';
    end if;
    insert into public.accounts (company_id, account_code, account_name, group_id, classification, normal_balance, account_nature, is_postable,
      allow_manual_posting, description, created_by, updated_by)
    values (v_company, v_code, v_name, v_g.id, v_g.classification, coalesce(v_nb, v_g.normal_balance), v_nature, v_postable, v_manual, v_desc,
            auth.uid(), auth.uid())
    returning id into v_id;
    perform private.write_audit_log(v_company, 'accounting.account.created', 'account', v_id::text,
      jsonb_build_object('code', v_code, 'name', v_name, 'group', v_g.group_code, 'nature', v_nature));
  else
    select * into v_old from public.accounts where id = p_account_id and company_id = v_company for update;
    if not found then
      raise exception 'Ledger account not found.' using errcode = 'P0002';
    end if;
    if v_old.is_system then
      -- System accounts: name, description and group within the same classification only.
      update public.accounts set account_name = v_name, description = v_desc, group_id = v_g.id, updated_by = auth.uid() where id = v_old.id;
    else
      if not v_postable and v_old.is_postable and private.accounting_account_balance(v_old.id) <> 0 then
        raise exception 'Account % has a balance; it must stay postable until the balance is zero.', v_old.account_code using errcode = 'P0001';
      end if;
      update public.accounts
         set account_name = v_name, group_id = v_g.id, normal_balance = coalesce(v_nb, v_old.normal_balance), account_nature = v_nature,
             is_postable = v_postable, allow_manual_posting = v_manual, description = v_desc, updated_by = auth.uid()
       where id = v_old.id;
    end if;
    v_id := v_old.id;
    perform private.write_audit_log(v_company, 'accounting.account.updated', 'account', v_id::text,
      jsonb_build_object('code', v_old.account_code, 'before', jsonb_build_object('name', v_old.account_name, 'group_id', v_old.group_id,
        'nature', v_old.account_nature, 'postable', v_old.is_postable, 'manual', v_old.allow_manual_posting),
        'after', jsonb_build_object('name', v_name, 'group_id', v_g.id, 'nature', v_nature, 'postable', v_postable, 'manual', v_manual)));
  end if;
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'An account with this code or name already exists.' using errcode = '23505';
end;
$$;

create or replace function public.accounting_account_set_active(p_account_id uuid, p_active boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  v_a       public.accounts;
  v_balance numeric;
begin
  select * into v_a from public.accounts where id = p_account_id and company_id = v_company for update;
  if not found then
    raise exception 'Ledger account not found.' using errcode = 'P0002';
  end if;
  if not coalesce(p_active, false) then
    if v_a.is_system then
      raise exception 'System account % is used by automatic posting and cannot be deactivated.', v_a.account_code using errcode = 'P0001';
    end if;
    if exists (select 1 from public.accounting_posting_rules r where r.account_id = v_a.id and r.is_active) then
      raise exception 'Account % is mapped in the posting rules; change the mapping first.', v_a.account_code using errcode = 'P0001';
    end if;
    v_balance := private.accounting_account_balance(v_a.id);
    if v_balance <> 0 then
      raise exception 'Account % has a balance of %; only accounts with a zero balance can be deactivated.', v_a.account_code, v_balance using errcode = 'P0001';
    end if;
    if exists (select 1 from public.accounting_vouchers v join public.accounting_voucher_lines l on l.voucher_id = v.id
               where l.account_id = v_a.id and v.status = 'DRAFT') then
      raise exception 'Account % is used on draft vouchers; post or discard them first.', v_a.account_code using errcode = 'P0001';
    end if;
  end if;
  update public.accounts set is_active = coalesce(p_active, false), updated_by = auth.uid() where id = v_a.id;
  perform private.write_audit_log(v_company, case when p_active then 'accounting.account.activated' else 'accounting.account.deactivated' end,
    'account', v_a.id::text, jsonb_build_object('code', v_a.account_code));
  return jsonb_build_object('id', v_a.id, 'is_active', coalesce(p_active, false));
end;
$$;

-- Accounts for pickers and the Ledger Accounts page, with posted balances.
create or replace function public.accounting_accounts(p_search text default null, p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name, 'group_name', g.group_name,
      'classification', a.classification, 'normal_balance', a.normal_balance, 'account_nature', a.account_nature, 'is_postable', a.is_postable,
      'allow_manual_posting', a.allow_manual_posting, 'requires_party', a.requires_party, 'is_system', a.is_system, 'is_active', a.is_active,
      'balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                           where l.account_id = a.id and v.status in ('POSTED', 'REVERSED')), 0))
      order by a.account_code)
    from public.accounts a join public.account_groups g on g.id = a.group_id
    where a.company_id = v_company and (p_include_inactive or a.is_active)
      and (v_term is null or a.account_code ilike '%' || v_term || '%' or a.account_name ilike '%' || v_term || '%' or g.group_name ilike '%' || v_term || '%')),
    '[]'::jsonb);
end;
$$;

-- Customers / suppliers (ledger parties) for party pickers on Debtors / Creditors lines. Read-only.
create or replace function public.accounting_parties(p_search text default null, p_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'vouchers.create', 'accounting_opening.import',
                      'accounting_reports.read']);
  v_term    text := nullif(btrim(coalesce(p_search, '')), '');
  v_type    text := upper(nullif(p_type, ''));
begin
  return coalesce((
    select jsonb_agg(x order by x ->> 'party_name')
    from (
      select jsonb_build_object('id', p.id, 'party_code', p.party_code, 'party_name', private.accounting_party_name(p.id),
        'is_customer', p.is_customer, 'is_supplier', p.is_supplier, 'opening_balance', p.opening_balance,
        'opening_balance_type', p.opening_balance_type) as x
      from public.parties p
      left join public.customers c on c.id = p.customer_id
      left join public.suppliers s on s.id = p.supplier_id
      where p.company_id = v_company
        and (v_type is null or (v_type = 'CUSTOMER' and p.is_customer) or (v_type = 'SUPPLIER' and p.is_supplier))
        and (v_term is null or p.party_code ilike '%' || v_term || '%' or coalesce(c.customer_name, '') ilike '%' || v_term || '%'
             or coalesce(c.customer_code, '') ilike '%' || v_term || '%' or coalesce(s.display_name, '') ilike '%' || v_term || '%'
             or coalesce(s.legal_name, '') ilike '%' || v_term || '%' or coalesce(s.supplier_code, '') ilike '%' || v_term || '%')
      limit 500
    ) q), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_cost_centres()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
      'description', c.description, 'parent_cost_centre_id', c.parent_cost_centre_id, 'is_active', c.is_active, 'updated_at', c.updated_at)
      order by c.cost_centre_code)
    from public.accounting_cost_centres c where c.company_id = v_company), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_cost_centre_save(p_cost_centre_id uuid, p_cost_centre jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  v_code    text := upper(private.accounting_text(p_cost_centre, 'cost_centre_code', 20, 'Cost centre code'));
  v_name    text := private.accounting_text(p_cost_centre, 'cost_centre_name', 120, 'Cost centre name');
  v_desc    text := private.accounting_text(p_cost_centre, 'description', 500, 'Description');
  v_parent  uuid := private.accounting_uuid(p_cost_centre, 'parent_cost_centre_id', 'Parent cost centre');
  v_active  boolean := coalesce((p_cost_centre ->> 'is_active')::boolean, true);
  v_id      uuid := p_cost_centre_id;
begin
  perform private.accounting_require_setup(v_company);
  if v_name is null or length(v_name) < 2 then
    raise exception 'The cost centre name is required (at least 2 characters).' using errcode = '22023';
  end if;
  if v_parent is not null and not exists (select 1 from public.accounting_cost_centres where id = v_parent and company_id = v_company) then
    raise exception 'The parent cost centre does not exist in this company.' using errcode = '42501';
  end if;
  if v_id is null then
    if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$' then
      raise exception 'The cost centre code is required: letters, digits, . _ - (up to 20).' using errcode = '22023';
    end if;
    insert into public.accounting_cost_centres (company_id, cost_centre_code, cost_centre_name, description, parent_cost_centre_id, is_active, created_by, updated_by)
    values (v_company, v_code, v_name, v_desc, v_parent, v_active, auth.uid(), auth.uid()) returning id into v_id;
  else
    if not exists (select 1 from public.accounting_cost_centres where id = v_id and company_id = v_company) then
      raise exception 'Cost centre not found.' using errcode = 'P0002';
    end if;
    if v_parent is not null and exists (
      with recursive up (id, parent_id) as (
        select c.id, c.parent_cost_centre_id from public.accounting_cost_centres c where c.id = v_parent
        union
        select c.id, c.parent_cost_centre_id from public.accounting_cost_centres c join up on c.id = up.parent_id
      ) select 1 from up where up.id = v_id) then
      raise exception 'A cost centre cannot be placed under itself or one of its own sub-centres.' using errcode = 'P0001';
    end if;
    update public.accounting_cost_centres set cost_centre_name = v_name, description = v_desc, parent_cost_centre_id = v_parent, is_active = v_active,
      updated_by = auth.uid(), updated_at = now() where id = v_id;
  end if;
  perform private.write_audit_log(v_company, case when p_cost_centre_id is null then 'accounting.cost_centre.created' else 'accounting.cost_centre.updated' end,
    'accounting_cost_centre', v_id::text, jsonb_build_object('name', v_name, 'is_active', v_active));
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'A cost centre with this code already exists.' using errcode = '23505';
end;
$$;

create or replace function public.accounting_posting_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_settings.manage', 'accounting_posting.manage', 'accounting_reports.read']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'rule_key', r.rule_key, 'match_value', r.match_value, 'account_id', r.account_id,
      'account_code', a.account_code, 'account_name', a.account_name, 'account_active', a.is_active and a.is_postable, 'is_active', r.is_active,
      'updated_at', r.updated_at) order by r.rule_key, r.match_value)
    from public.accounting_posting_rules r join public.accounts a on a.id = r.account_id where r.company_id = v_company), '[]'::jsonb);
end;
$$;

-- Maps a posting rule (and, for receipts / supplier payments, a payment method) to an account. NULL account removes the mapping.
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
                   'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT') then
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

-- -----------------------------------------------------------------------------
-- 10. Voucher RPCs (manual vouchers; Phase 1 builds the journal screen on these)
-- -----------------------------------------------------------------------------
create or replace function private.accounting_voucher_json(p_voucher uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', v.id, 'voucher_type', t.type_code, 'voucher_type_name', t.type_name, 'voucher_number', v.voucher_number,
    'financial_year', v.financial_year, 'voucher_date', v.voucher_date, 'reference_number', v.reference_number, 'narration', v.narration,
    'status', v.status, 'source', v.source, 'source_type', v.source_type, 'source_id', v.source_id, 'source_number', v.source_number,
    'reversal_of_voucher_id', v.reversal_of_voucher_id,
    'reversal_of_number', (select o.voucher_number from public.accounting_vouchers o where o.id = v.reversal_of_voucher_id),
    'reversed_by_voucher_id', (select r.id from public.accounting_vouchers r where r.reversal_of_voucher_id = v.id),
    'reversed_by_number', (select r.voucher_number from public.accounting_vouchers r where r.reversal_of_voucher_id = v.id),
    'reversal_reason', v.reversal_reason, 'reversed_at', v.reversed_at,
    'reversed_by_name', (select full_name from public.profiles where id = v.reversed_by),
    'total_debit', coalesce((select sum(debit) from public.accounting_voucher_lines where voucher_id = v.id), 0),
    'total_credit', coalesce((select sum(credit) from public.accounting_voucher_lines where voucher_id = v.id), 0),
    'row_version', v.row_version, 'created_at', v.created_at, 'created_by_name', (select full_name from public.profiles where id = v.created_by),
    'updated_at', v.updated_at, 'posted_at', v.posted_at, 'posted_by_name', (select full_name from public.profiles where id = v.posted_by),
    'discarded_at', v.discarded_at, 'discard_reason', v.discard_reason,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'account_id', l.account_id, 'account_code', a.account_code,
        'account_name', a.account_name, 'party_id', l.party_id, 'party_name', case when l.party_id is not null then private.accounting_party_name(l.party_id) end,
        'debit', l.debit, 'credit', l.credit, 'narration', l.line_narration) order by l.line_no)
      from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id), '[]'::jsonb))
  from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
  where v.id = p_voucher;
$$;
revoke all on function private.accounting_voucher_json(uuid) from public, anon, authenticated;

create or replace function private.accounting_lock_draft(p_company uuid, p_voucher uuid, p_row_version int)
returns public.accounting_vouchers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.accounting_vouchers;
begin
  select * into v from public.accounting_vouchers where id = p_voucher and company_id = p_company for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v.status <> 'DRAFT' then
    raise exception 'Voucher % is %; only drafts can be edited.', coalesce(v.voucher_number, ''), lower(v.status) using errcode = 'P0001';
  end if;
  if v.source <> 'MANUAL' then
    raise exception 'Only manual vouchers can be edited.' using errcode = 'P0001';
  end if;
  if p_row_version is not null and v.row_version <> p_row_version then
    raise exception 'This voucher was changed by someone else. Reload it and try again.' using errcode = '40001';
  end if;
  return v;
end;
$$;
revoke all on function private.accounting_lock_draft(uuid, uuid, int) from public, anon, authenticated, service_role;

create or replace function public.accounting_voucher_create(p_voucher jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v_type    text := upper(coalesce(private.accounting_text(p_voucher, 'voucher_type', 6, 'Voucher type'), 'JV'));
  v_t       public.accounting_voucher_types;
  v_date    date := private.accounting_date(p_voucher, 'voucher_date', 'Voucher date');
  v_id      uuid;
begin
  perform private.accounting_require_setup(v_company);
  if p_voucher is null or jsonb_typeof(p_voucher) <> 'object' then
    raise exception 'The voucher must be an object.' using errcode = '22023';
  end if;
  select * into v_t from public.accounting_voucher_types where company_id = v_company and type_code = v_type;
  if not found or not v_t.allow_manual then
    raise exception 'Voucher type % cannot be entered by hand.', v_type using errcode = 'P0001';
  end if;
  if v_date is null then
    raise exception 'The voucher date is required.' using errcode = '22023';
  end if;
  v_id := private.accounting_create_voucher(v_company, v_type, v_date, private.accounting_text(p_voucher, 'reference_number', 100, 'Reference number'),
    private.accounting_text(p_voucher, 'narration', 1000, 'Narration'), 'MANUAL', null, null, null, null, coalesce(p_voucher -> 'lines', '[]'::jsonb));
  perform private.write_audit_log(v_company, 'accounting.voucher.created', 'accounting_voucher', v_id::text,
    jsonb_build_object('voucher_type', v_type, 'voucher_date', v_date, 'lines', jsonb_array_length(coalesce(p_voucher -> 'lines', '[]'::jsonb))));
  return private.accounting_voucher_json(v_id) || jsonb_build_object('issues', private.accounting_voucher_issues(v_id));
end;
$$;

-- Edits a manual draft: header fields present in the payload; "lines" (when present) replaces all lines.
create or replace function public.accounting_voucher_update(p_voucher_id uuid, p_voucher jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_date    date := v.voucher_date;
begin
  if p_voucher is null or jsonb_typeof(p_voucher) <> 'object' then
    raise exception 'The voucher must be an object.' using errcode = '22023';
  end if;
  if p_voucher ? 'voucher_date' then
    v_date := private.accounting_date(p_voucher, 'voucher_date', 'Voucher date');
    if v_date is null then
      raise exception 'The voucher date is required.' using errcode = '22023';
    end if;
  end if;
  update public.accounting_vouchers
     set voucher_date = v_date, financial_year = private.financial_year(v_date, s.fy_start_month),
         reference_number = case when p_voucher ? 'reference_number' then private.accounting_text(p_voucher, 'reference_number', 100, 'Reference number') else reference_number end,
         narration = case when p_voucher ? 'narration' then private.accounting_text(p_voucher, 'narration', 1000, 'Narration') else narration end,
         updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = v.id;
  if p_voucher ? 'lines' then
    delete from public.accounting_voucher_lines where voucher_id = v.id;
    insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
    select v_company, v.id, l.line_no, l.account_id, l.party_id, l.debit, l.credit, l.narration from private.accounting_parse_lines(v_company, p_voucher -> 'lines') l;
  end if;
  perform private.write_audit_log(v_company, 'accounting.voucher.updated', 'accounting_voucher', v.id::text,
    jsonb_build_object('lines_replaced', p_voucher ? 'lines', 'voucher_date', v_date));
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

-- Adds (p_line_id NULL) or edits one line of a manual draft.
create or replace function public.accounting_voucher_line_save(p_voucher_id uuid, p_line_id uuid, p_line jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
  l         record;
  v_no      int;
begin
  select * into l from private.accounting_parse_lines(v_company, jsonb_build_array(p_line));
  if p_line_id is null then
    select coalesce(max(line_no), 0) + 1 into v_no from public.accounting_voucher_lines where voucher_id = v.id;
    if v_no > 500 then
      raise exception 'A voucher can have at most 500 lines.' using errcode = '22023';
    end if;
    insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
    values (v_company, v.id, v_no, l.account_id, l.party_id, l.debit, l.credit, l.narration);
  else
    update public.accounting_voucher_lines set account_id = l.account_id, party_id = l.party_id, debit = l.debit, credit = l.credit,
      line_narration = l.narration, updated_at = now() where id = p_line_id and voucher_id = v.id;
    if not found then
      raise exception 'Voucher line not found.' using errcode = 'P0002';
    end if;
  end if;
  update public.accounting_vouchers set row_version = row_version + 1, updated_by = auth.uid(), updated_at = now() where id = v.id;
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

create or replace function public.accounting_voucher_line_delete(p_voucher_id uuid, p_line_id uuid, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, p_row_version);
begin
  delete from public.accounting_voucher_lines where id = p_line_id and voucher_id = v.id;
  if not found then
    raise exception 'Voucher line not found.' using errcode = 'P0002';
  end if;
  -- Keep line numbers consecutive (through a temporary offset: a voucher has at most 500 lines).
  update public.accounting_voucher_lines x set line_no = n.rn + 5000
    from (select id, row_number() over (order by line_no) as rn from public.accounting_voucher_lines where voucher_id = v.id) n where x.id = n.id;
  update public.accounting_voucher_lines set line_no = line_no - 5000 where voucher_id = v.id;
  update public.accounting_vouchers set row_version = row_version + 1, updated_by = auth.uid(), updated_at = now() where id = v.id;
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

create or replace function public.accounting_voucher_validate(p_voucher_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['vouchers.create', 'vouchers.post', 'vouchers.read']);
  v_issues  jsonb;
  v_dr      numeric;
  v_cr      numeric;
begin
  if not exists (select 1 from public.accounting_vouchers where id = p_voucher_id and company_id = v_company) then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  v_issues := private.accounting_voucher_issues(p_voucher_id);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_dr, v_cr from public.accounting_voucher_lines where voucher_id = p_voucher_id;
  return jsonb_build_object('voucher_id', p_voucher_id, 'valid', jsonb_array_length(v_issues) = 0, 'issues', v_issues,
    'total_debit', v_dr, 'total_credit', v_cr, 'difference', v_dr - v_cr);
end;
$$;

create or replace function public.accounting_voucher_post(p_voucher_id uuid, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.post');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v         public.accounting_vouchers;
begin
  select * into v from public.accounting_vouchers where id = p_voucher_id and company_id = v_company;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v.source <> 'MANUAL' then
    raise exception 'Only manual vouchers are posted from here; automatic and opening vouchers are posted by their own process.' using errcode = 'P0001';
  end if;
  if s.segregation_of_duties and v.created_by = auth.uid() then
    raise exception 'Segregation of duties is on: a voucher must be posted by someone other than the person who created it.' using errcode = '42501';
  end if;
  v := private.accounting_post_voucher(p_voucher_id, p_row_version);
  return private.accounting_voucher_json(v.id);
end;
$$;

create or replace function public.accounting_voucher_discard(p_voucher_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.create');
  v         public.accounting_vouchers := private.accounting_lock_draft(v_company, p_voucher_id, null);
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A reason of at least 3 characters is required to discard a draft.' using errcode = '22023';
  end if;
  perform private.accounting_issue_token(v.id, 'DISCARD');
  update public.accounting_vouchers set status = 'DISCARDED', discarded_at = now(), discarded_by = auth.uid(), discard_reason = left(v_reason, 1000),
    updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1 where id = v.id;
  perform private.accounting_consume_token(v.id);
  perform private.write_audit_log(v_company, 'accounting.voucher.discarded', 'accounting_voucher', v.id::text, jsonb_build_object('reason', left(v_reason, 500)));
  return private.accounting_voucher_json(v.id);
end;
$$;

-- Reverses a posted MANUAL voucher. Automatic vouchers are reversed by cancelling / reversing their source document.
create or replace function public.accounting_voucher_reverse(p_voucher_id uuid, p_reason text, p_reversal_date date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('vouchers.reverse');
  v         public.accounting_vouchers;
  v_rev     public.accounting_vouchers;
begin
  perform private.accounting_require_setup(v_company);
  select * into v from public.accounting_vouchers where id = p_voucher_id and company_id = v_company;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  if v.source = 'AUTO' then
    raise exception 'Voucher % was posted automatically from % %; cancel or reverse that document instead.', v.voucher_number,
      lower(replace(v.source_type, '_', ' ')), v.source_number using errcode = 'P0001';
  end if;
  if v.source = 'OPENING' then
    raise exception 'The opening balance voucher cannot be reversed; correct opening balances with a journal voucher.' using errcode = 'P0001';
  end if;
  v_rev := private.accounting_reverse_voucher(v.id, p_reason, p_reversal_date);
  return jsonb_build_object('original', private.accounting_voucher_json(v.id), 'reversal', private.accounting_voucher_json(v_rev.id));
end;
$$;

create or replace function public.accounting_voucher_get(p_voucher_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['vouchers.read', 'accounting_reports.read']);
  v_json    jsonb;
begin
  if not exists (select 1 from public.accounting_vouchers where id = p_voucher_id and company_id = v_company) then
    raise exception 'Voucher not found.' using errcode = 'P0002';
  end if;
  v_json := private.accounting_voucher_json(p_voucher_id);
  return v_json || jsonb_build_object(
    'issues', case when v_json ->> 'status' = 'DRAFT' then private.accounting_voucher_issues(p_voucher_id) else '[]'::jsonb end,
    'audit', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.event_timestamp, 'by', p.full_name, 'metadata', a.metadata)
                       order by a.event_timestamp)
                       from public.audit_logs a left join public.profiles p on p.id = a.actor_user_id
                       where a.company_id = v_company and a.resource_type = 'accounting_voucher' and a.resource_id = p_voucher_id::text), '[]'::jsonb));
end;
$$;

-- Voucher register: filters {from, to, status, voucher_type, source, search, account_id, created_by, limit, offset}.
create or replace function public.accounting_voucher_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['vouchers.read', 'accounting_reports.read']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := private.accounting_date(f, 'from', 'From date');
  v_to      date := private.accounting_date(f, 'to', 'To date');
  v_status  text := upper(nullif(f ->> 'status', ''));
  v_type    text := upper(nullif(f ->> 'voucher_type', ''));
  v_source  text := upper(nullif(f ->> 'source', ''));
  v_term    text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_account uuid := private.accounting_uuid(f, 'account_id', 'Account');
  v_creator uuid := private.accounting_uuid(f, 'created_by', 'Created by');
  v_limit   int := least(greatest(coalesce((f ->> 'limit')::int, 200), 1), 1000);
  v_offset  int := greatest(coalesce((f ->> 'offset')::int, 0), 0);
begin
  return (
    with base as (
      select v.*, t.type_code, t.type_name,
        (select coalesce(sum(debit), 0) from public.accounting_voucher_lines where voucher_id = v.id) as dr,
        (select coalesce(sum(credit), 0) from public.accounting_voucher_lines where voucher_id = v.id) as cr
      from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company
        and (v_from is null or v.voucher_date >= v_from) and (v_to is null or v.voucher_date <= v_to)
        and (v_status is null or v.status = v_status) and (v_type is null or t.type_code = v_type) and (v_source is null or v.source = v_source)
        and (v_creator is null or v.created_by = v_creator)
        and (v_account is null or exists (select 1 from public.accounting_voucher_lines l where l.voucher_id = v.id and l.account_id = v_account))
        and (v_term is null or coalesce(v.voucher_number, '') ilike '%' || v_term || '%' or coalesce(v.reference_number, '') ilike '%' || v_term || '%'
             or coalesce(v.narration, '') ilike '%' || v_term || '%' or coalesce(v.source_number, '') ilike '%' || v_term || '%')
    )
    select jsonb_build_object('total', (select count(*) from base),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'voucher_number', b.voucher_number, 'voucher_type', b.type_code,
          'voucher_type_name', b.type_name, 'voucher_date', b.voucher_date, 'reference_number', b.reference_number, 'narration', b.narration,
          'status', b.status, 'source', b.source, 'source_type', b.source_type, 'source_number', b.source_number, 'total_debit', b.dr,
          'total_credit', b.cr, 'reversal_of_voucher_id', b.reversal_of_voucher_id,
          'created_by', b.created_by, 'created_by_name', (select full_name from public.profiles where id = b.created_by), 'created_at', b.created_at,
          'posted_at', b.posted_at) order by b.voucher_date desc, b.created_at desc)
        from (select * from base order by voucher_date desc, created_at desc limit v_limit offset v_offset) b), '[]'::jsonb)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Reports (posted and reversed vouchers only; drafts and discarded never count)
-- -----------------------------------------------------------------------------
create or replace function public.accounting_trial_balance(p_from date, p_to date, p_include_zero boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
  v_rows    jsonb;
begin
  perform private.accounting_require_setup(v_company);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  with mv as (
    select l.account_id,
      sum(case when v.voucher_date < p_from then l.debit - l.credit else 0 end) as opening,
      sum(case when v.voucher_date >= p_from then l.debit else 0 end) as dr,
      sum(case when v.voucher_date >= p_from then l.credit else 0 end) as cr
    from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
    where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= p_to
    group by l.account_id
  ), r as (
    select a.id, a.account_code, a.account_name, a.classification, a.normal_balance, g.group_name, a.is_active,
      coalesce(m.opening, 0) as opening, coalesce(m.dr, 0) as dr, coalesce(m.cr, 0) as cr, coalesce(m.opening, 0) + coalesce(m.dr, 0) - coalesce(m.cr, 0) as closing
    from public.accounts a join public.account_groups g on g.id = a.group_id left join mv m on m.account_id = a.id
    where a.company_id = v_company
  )
  select coalesce(jsonb_agg(jsonb_build_object('account_id', r.id, 'account_code', r.account_code, 'account_name', r.account_name,
      'group_name', r.group_name, 'classification', r.classification, 'normal_balance', r.normal_balance, 'is_active', r.is_active,
      'opening_debit', greatest(r.opening, 0), 'opening_credit', greatest(-r.opening, 0), 'period_debit', r.dr, 'period_credit', r.cr,
      'closing_debit', greatest(r.closing, 0), 'closing_credit', greatest(-r.closing, 0))
      order by case r.classification when 'ASSET' then 1 when 'LIABILITY' then 2 when 'EQUITY' then 3 when 'INCOME' then 4 else 5 end, r.account_code), '[]'::jsonb)
    into v_rows
  from r where p_include_zero or r.opening <> 0 or r.dr <> 0 or r.cr <> 0;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows,
    'totals', jsonb_build_object(
      'opening_debit', coalesce((select sum((x ->> 'opening_debit')::numeric) from jsonb_array_elements(v_rows) x), 0),
      'opening_credit', coalesce((select sum((x ->> 'opening_credit')::numeric) from jsonb_array_elements(v_rows) x), 0),
      'period_debit', coalesce((select sum((x ->> 'period_debit')::numeric) from jsonb_array_elements(v_rows) x), 0),
      'period_credit', coalesce((select sum((x ->> 'period_credit')::numeric) from jsonb_array_elements(v_rows) x), 0),
      'closing_debit', coalesce((select sum((x ->> 'closing_debit')::numeric) from jsonb_array_elements(v_rows) x), 0),
      'closing_credit', coalesce((select sum((x ->> 'closing_credit')::numeric) from jsonb_array_elements(v_rows) x), 0)));
end;
$$;

create or replace function public.accounting_general_ledger(p_account_id uuid, p_from date, p_to date, p_party_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
  v_a       public.accounts;
  v_opening numeric;
begin
  perform private.accounting_require_setup(v_company);
  select * into v_a from public.accounts where id = p_account_id and company_id = v_company;
  if not found then
    raise exception 'Ledger account not found.' using errcode = 'P0002';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  select coalesce(sum(l.debit - l.credit), 0) into v_opening
  from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date < p_from and (p_party_id is null or l.party_id = p_party_id);
  return jsonb_build_object('account', jsonb_build_object('id', v_a.id, 'account_code', v_a.account_code, 'account_name', v_a.account_name,
      'normal_balance', v_a.normal_balance, 'classification', v_a.classification, 'requires_party', v_a.requires_party),
    'from', p_from, 'to', p_to, 'opening_balance', v_opening,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', e.voucher_id, 'voucher_number', e.voucher_number, 'voucher_date', e.voucher_date,
        'voucher_type', e.type_code, 'status', e.status, 'narration', coalesce(e.line_narration, e.narration), 'reference_number', e.reference_number,
        'source_type', e.source_type, 'source_number', e.source_number, 'party_id', e.party_id,
        'party_name', case when e.party_id is not null then private.accounting_party_name(e.party_id) end,
        'debit', e.debit, 'credit', e.credit, 'balance', v_opening + e.running) order by e.voucher_date, e.posted_at, e.line_no)
      from (select v.id as voucher_id, v.voucher_number, v.voucher_date, v.posted_at, v.status, v.narration, v.reference_number, v.source_type, v.source_number,
                   t.type_code, l.line_no, l.line_narration, l.party_id, l.debit, l.credit,
                   sum(l.debit - l.credit) over (order by v.voucher_date, v.posted_at, v.id, l.line_no) as running
            from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
            join public.accounting_voucher_types t on t.id = v.voucher_type_id
            where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
              and (p_party_id is null or l.party_id = p_party_id)) e), '[]'::jsonb),
    'closing_balance', v_opening + coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
       where l.account_id = v_a.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
         and (p_party_id is null or l.party_id = p_party_id)), 0));
end;
$$;

create or replace function public.accounting_day_book(p_from date, p_to date, p_voucher_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
begin
  perform private.accounting_require_setup(v_company);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'The day book covers at most 400 days at a time.' using errcode = '22023';
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'vouchers', coalesce((select jsonb_agg(private.accounting_voucher_json(v.id) order by v.voucher_date, v.posted_at)
      from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))), '[]'::jsonb),
    'totals', (select jsonb_build_object('debit', coalesce(sum(l.debit), 0), 'credit', coalesce(sum(l.credit), 0), 'vouchers', count(distinct v.id))
      from public.accounting_vouchers v join public.accounting_voucher_lines l on l.voucher_id = v.id
      join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))));
end;
$$;

create or replace function public.accounting_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
  s         public.accounting_settings := private.accounting_settings_of(v_company);
  v_today   date := private.company_today(v_company);
  v_fy_from date;
begin
  if s.company_id is null then
    return jsonb_build_object('initialized', false);
  end if;
  v_fy_from := greatest(private.accounting_fy_start(v_today, s.fy_start_month), s.books_start_date);
  return jsonb_build_object('initialized', true, 'books_start_date', s.books_start_date,
    'financial_year', private.financial_year(v_today, s.fy_start_month), 'fy_from', v_fy_from, 'today', v_today,
    'vouchers', (select jsonb_build_object(
        'draft', count(*) filter (where status = 'DRAFT'),
        'posted', count(*) filter (where status = 'POSTED'),
        'reversed', count(*) filter (where status = 'REVERSED'),
        'posted_this_fy', count(*) filter (where status in ('POSTED', 'REVERSED') and voucher_date >= v_fy_from),
        'automatic', count(*) filter (where source = 'AUTO' and status in ('POSTED', 'REVERSED')),
        'manual', count(*) filter (where source = 'MANUAL' and status in ('POSTED', 'REVERSED')))
      from public.accounting_vouchers where company_id = v_company),
    'books', (select jsonb_build_object('total_debit', coalesce(sum(l.debit), 0), 'total_credit', coalesce(sum(l.credit), 0))
      from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED')),
    'events', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.accounting_posting_events
      where company_id = v_company group by status) x), '{}'::jsonb),
    'periods', (select jsonb_build_object('open', count(*) filter (where status in ('OPEN', 'REOPENED')), 'closed', count(*) filter (where status = 'CLOSED'),
        'current', (select period_name || ' (' || status || ')' from public.accounting_periods where company_id = v_company and v_today between start_date and end_date))
      from public.accounting_periods where company_id = v_company),
    'opening', (select jsonb_build_object('posted', bool_or(status = 'POSTED'), 'in_progress', count(*) filter (where status in ('DRAFT', 'APPROVED'))) from
      public.accounting_opening_balance_batches where company_id = v_company),
    'unmapped_payment_methods', (select coalesce(jsonb_agg(m order by m), '[]'::jsonb) from unnest(array['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD',
        'DEMAND_DRAFT', 'OTHER']) m where not exists (select 1 from public.accounting_posting_rules r where r.company_id = v_company
        and r.rule_key = 'RECEIPT_ACCOUNT' and r.match_value = m and r.is_active)),
    'classification', coalesce((select jsonb_object_agg(classification, bal) from (select a.classification, sum(l.debit - l.credit) as bal
      from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id join public.accounts a on a.id = l.account_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date >= v_fy_from group by a.classification) x), '{}'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Opening balances: draft -> reconcile -> approve -> post (one OPN voucher)
-- -----------------------------------------------------------------------------
create or replace function private.accounting_opening_checks(p_batch uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b          public.accounting_opening_balance_batches;
  s          public.accounting_settings;
  v_checks   jsonb := '[]'::jsonb;
  v_dr       numeric;
  v_cr       numeric;
  v_n        int;
  v_bad      jsonb;
  v_exp      numeric;
  v_act      numeric;
  v_unvalued int;
  v_date     jsonb;
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch;
  s := private.accounting_settings_of(b.company_id);
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_n, v_dr, v_cr from public.accounting_opening_balance_lines where batch_id = p_batch;

  v_checks := v_checks || jsonb_build_object('code', 'HAS_LINES', 'label', 'The batch has at least two lines', 'status', case when v_n >= 2 then 'PASS' else 'FAIL' end,
    'acknowledgeable', false, 'actual', v_n);
  v_checks := v_checks || jsonb_build_object('code', 'BALANCED', 'label', 'Total debit equals total credit', 'status', case when v_dr = v_cr then 'PASS' else 'FAIL' end,
    'acknowledgeable', false, 'expected', v_dr, 'actual', v_cr, 'difference', v_dr - v_cr);

  select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account', a.account_code || ' ' || a.account_name) order by l.line_no), '[]'::jsonb) into v_bad
  from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id
  where l.batch_id = p_batch and (not a.is_active or not a.is_postable);
  v_checks := v_checks || jsonb_build_object('code', 'ACCOUNTS_VALID', 'label', 'Every account is active and accepts postings',
    'status', case when jsonb_array_length(v_bad) = 0 then 'PASS' else 'FAIL' end, 'acknowledgeable', false, 'details', v_bad);

  select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account', a.account_code || ' ' || a.account_name,
           'problem', case when a.requires_party then 'party required' else 'party not allowed' end) order by l.line_no), '[]'::jsonb) into v_bad
  from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id
  where l.batch_id = p_batch and (a.requires_party and l.party_id is null or not a.requires_party and l.party_id is not null);
  v_checks := v_checks || jsonb_build_object('code', 'PARTIES', 'label', 'Debtors / Creditors lines are party-wise (and only those)',
    'status', case when jsonb_array_length(v_bad) = 0 then 'PASS' else 'FAIL' end, 'acknowledgeable', false, 'details', v_bad);

  v_date := private.accounting_date_issue(b.company_id, b.as_of_date, 'OPENING');
  v_checks := v_checks || jsonb_build_object('code', 'DATE_OPEN', 'label', 'The opening date (books start date) is in an open period',
    'status', case when v_date is null and b.as_of_date = s.books_start_date then 'PASS' else 'FAIL' end, 'acknowledgeable', false,
    'details', coalesce(v_date, case when b.as_of_date <> s.books_start_date then jsonb_build_object('message', 'The opening date must equal the books start date.') end));

  -- Receivables: Debtors control per party vs ERP party opening receivable (never double-counted: compared, not added).
  with acc as (
    select l.party_id, sum(l.debit - l.credit) as amt from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id
    where l.batch_id = p_batch and a.account_nature = 'RECEIVABLE_CONTROL' group by l.party_id
  ), erp as (
    select p.id as party_id, p.opening_balance as amt from public.parties p
    where p.company_id = b.company_id and p.opening_balance_type = 'RECEIVABLE' and p.opening_balance > 0
  ), d as (
    select coalesce(acc.party_id, erp.party_id) as party_id, coalesce(erp.amt, 0) as expected, coalesce(acc.amt, 0) as actual
    from acc full join erp on erp.party_id = acc.party_id
  )
  select coalesce(sum(expected), 0), coalesce(sum(actual), 0),
         coalesce(jsonb_agg(jsonb_build_object('party_id', party_id, 'party', private.accounting_party_name(party_id), 'erp', expected, 'batch', actual,
           'difference', actual - expected)) filter (where expected <> actual), '[]'::jsonb)
    into v_exp, v_act, v_bad from d;
  v_checks := v_checks || jsonb_build_object('code', 'RECEIVABLE_MATCH', 'label', 'Debtors equal the ERP customer opening balances, party by party',
    'status', case when jsonb_array_length(v_bad) = 0 then 'PASS' else 'FAIL' end, 'acknowledgeable', true, 'expected', v_exp, 'actual', v_act,
    'difference', v_act - v_exp, 'details', v_bad);

  with acc as (
    select l.party_id, sum(l.credit - l.debit) as amt from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id
    where l.batch_id = p_batch and a.account_nature = 'PAYABLE_CONTROL' group by l.party_id
  ), erp as (
    select p.id as party_id, p.opening_balance as amt from public.parties p
    where p.company_id = b.company_id and p.opening_balance_type = 'PAYABLE' and p.opening_balance > 0
  ), d as (
    select coalesce(acc.party_id, erp.party_id) as party_id, coalesce(erp.amt, 0) as expected, coalesce(acc.amt, 0) as actual
    from acc full join erp on erp.party_id = acc.party_id
  )
  select coalesce(sum(expected), 0), coalesce(sum(actual), 0),
         coalesce(jsonb_agg(jsonb_build_object('party_id', party_id, 'party', private.accounting_party_name(party_id), 'erp', expected, 'batch', actual,
           'difference', actual - expected)) filter (where expected <> actual), '[]'::jsonb)
    into v_exp, v_act, v_bad from d;
  v_checks := v_checks || jsonb_build_object('code', 'PAYABLE_MATCH', 'label', 'Creditors equal the ERP supplier opening balances, party by party',
    'status', case when jsonb_array_length(v_bad) = 0 then 'PASS' else 'FAIL' end, 'acknowledgeable', true, 'expected', v_exp, 'actual', v_act,
    'difference', v_act - v_exp, 'details', v_bad);

  -- Inventory: posted ERP opening stock valued at its unit cost (lines without a cost are reported, not guessed).
  select coalesce(sum(round(t.direction * t.quantity * t.unit_cost, 2)) filter (where t.unit_cost is not null), 0),
         count(*) filter (where t.unit_cost is null)
    into v_exp, v_unvalued
  from public.inventory_transactions t where t.company_id = b.company_id and t.transaction_type = 'OPENING_STOCK';
  select coalesce(sum(l.debit - l.credit), 0) into v_act
  from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id
  where l.batch_id = p_batch and a.account_nature = 'INVENTORY';
  v_checks := v_checks || jsonb_build_object('code', 'INVENTORY_MATCH', 'label', 'Inventory equals the valuation of posted ERP opening stock',
    'status', case when v_exp = v_act and v_unvalued = 0 then 'PASS' else 'FAIL' end, 'acknowledgeable', true, 'expected', v_exp, 'actual', v_act,
    'difference', v_act - v_exp, 'unvalued_lines', v_unvalued);
  return v_checks;
end;
$$;
revoke all on function private.accounting_opening_checks(uuid) from public, anon, authenticated;

create or replace function private.accounting_opening_json(p_batch uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(b) - array['created_by', 'updated_by', 'approved_by', 'posted_by', 'discarded_by'] || jsonb_build_object(
    'created_by_name', (select full_name from public.profiles where id = b.created_by),
    'approved_by_name', (select full_name from public.profiles where id = b.approved_by),
    'posted_by_name', (select full_name from public.profiles where id = b.posted_by),
    'voucher_number', (select voucher_number from public.accounting_vouchers where id = b.voucher_id),
    'line_total_debit', coalesce((select sum(debit) from public.accounting_opening_balance_lines where batch_id = b.id), 0),
    'line_total_credit', coalesce((select sum(credit) from public.accounting_opening_balance_lines where batch_id = b.id), 0),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'account_id', l.account_id, 'account_code', a.account_code,
        'account_name', a.account_name, 'party_id', l.party_id, 'party_name', case when l.party_id is not null then private.accounting_party_name(l.party_id) end,
        'party_code', (select party_code from public.parties where id = l.party_id), 'balance_category', l.balance_category,
        'debit', l.debit, 'credit', l.credit, 'description', l.description) order by l.line_no)
      from public.accounting_opening_balance_lines l join public.accounts a on a.id = l.account_id where l.batch_id = b.id), '[]'::jsonb))
  from public.accounting_opening_balance_batches b where b.id = p_batch;
$$;
revoke all on function private.accounting_opening_json(uuid) from public, anon, authenticated;

create or replace function public.accounting_opening_batches()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_opening.import', 'accounting_opening.approve', 'accounting_reports.read']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'batch_number', b.batch_number, 'as_of_date', b.as_of_date, 'status', b.status,
      'source', b.source, 'file_name', b.file_name, 'notes', b.notes, 'created_at', b.created_at, 'posted_at', b.posted_at,
      'voucher_number', (select voucher_number from public.accounting_vouchers where id = b.voucher_id),
      'line_count', (select count(*) from public.accounting_opening_balance_lines where batch_id = b.id),
      'total_debit', coalesce((select sum(debit) from public.accounting_opening_balance_lines where batch_id = b.id), 0),
      'total_credit', coalesce((select sum(credit) from public.accounting_opening_balance_lines where batch_id = b.id), 0)) order by b.created_at desc)
    from public.accounting_opening_balance_batches b where b.company_id = v_company), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_opening_batch_get(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_opening.import', 'accounting_opening.approve', 'accounting_reports.read']);
begin
  if not exists (select 1 from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company) then
    raise exception 'Opening balance batch not found.' using errcode = 'P0002';
  end if;
  return private.accounting_opening_json(p_batch_id) || jsonb_build_object('checks', private.accounting_opening_checks(p_batch_id));
end;
$$;

create or replace function public.accounting_opening_batch_create(p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.import');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_no      int;
  v_id      uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('accounting_opening:' || v_company::text, 0));
  if exists (select 1 from public.accounting_opening_balance_batches where company_id = v_company and status = 'POSTED') then
    raise exception 'Opening balances have already been posted; correct them with a journal voucher.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.accounting_opening_balance_batches where company_id = v_company and status in ('DRAFT', 'APPROVED')) then
    raise exception 'An opening balance batch is already in progress; finish or discard it first.' using errcode = 'P0001';
  end if;
  select coalesce(max(substr(batch_number, 4)::int), 0) + 1 into v_no from public.accounting_opening_balance_batches where company_id = v_company;
  insert into public.accounting_opening_balance_batches (company_id, batch_number, as_of_date, notes, created_by, updated_by)
  values (v_company, 'OB-' || lpad(v_no::text, 4, '0'), s.books_start_date, left(nullif(btrim(coalesce(p_notes, '')), ''), 1000), auth.uid(), auth.uid())
  returning id into v_id;
  perform private.write_audit_log(v_company, 'accounting.opening.created', 'accounting_opening_batch', v_id::text, jsonb_build_object('as_of_date', s.books_start_date));
  return private.accounting_opening_json(v_id) || jsonb_build_object('checks', private.accounting_opening_checks(v_id));
end;
$$;

-- Replaces the lines of a DRAFT batch. Lines: [{account_id | account_code, party_id | party_code, balance_category, debit, credit, description}].
-- p_source IMPORT records the file name. All lines are validated together: nothing is saved if one is wrong.
create or replace function public.accounting_opening_lines_replace(p_batch_id uuid, p_lines jsonb, p_source text default 'MANUAL', p_file_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.import');
  b         public.accounting_opening_balance_batches;
  e         jsonb;
  i         int := 0;
  v_acc     uuid;
  v_party   uuid;
  v_code    text;
  v_d       numeric;
  v_c       numeric;
  v_cat     text;
  v_errors  text[] := '{}';
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Opening balance batch not found.' using errcode = 'P0002';
  end if;
  if b.status <> 'DRAFT' then
    raise exception 'Only a draft batch can be edited (batch is %).', lower(b.status) using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Lines must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 20000 then
    raise exception 'A batch can have at most 20,000 lines.' using errcode = '22023';
  end if;
  if upper(coalesce(p_source, 'MANUAL')) not in ('MANUAL', 'IMPORT') then
    raise exception 'Source must be MANUAL or IMPORT.' using errcode = '22023';
  end if;
  create temporary table if not exists pg_temp.accounting_ob_stage (line_no int, account_id uuid, party_id uuid, category text, debit numeric, credit numeric, description text)
    on commit drop;
  truncate pg_temp.accounting_ob_stage;
  for e in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    begin
      v_acc := private.accounting_uuid(e, 'account_id', 'Account');
      if v_acc is null then
        v_code := upper(nullif(btrim(coalesce(e ->> 'account_code', '')), ''));
        select id into v_acc from public.accounts where company_id = v_company and account_code = v_code;
        if v_acc is null then
          raise exception 'account % not found', coalesce(v_code, '(blank)');
        end if;
      elsif not exists (select 1 from public.accounts where id = v_acc and company_id = v_company) then
        raise exception 'account not found in this company';
      end if;
      v_party := private.accounting_uuid(e, 'party_id', 'Party');
      if v_party is null and nullif(btrim(coalesce(e ->> 'party_code', '')), '') is not null then
        select id into v_party from public.parties where company_id = v_company and party_code = upper(btrim(e ->> 'party_code'));
        if v_party is null then
          raise exception 'party % not found', e ->> 'party_code';
        end if;
      elsif v_party is not null and not exists (select 1 from public.parties where id = v_party and company_id = v_company) then
        raise exception 'party not found in this company';
      end if;
      v_d := private.accounting_amount(e, 'debit', 'debit');
      v_c := private.accounting_amount(e, 'credit', 'credit');
      if (v_d > 0) = (v_c > 0) then
        raise exception 'enter either a debit or a credit greater than zero';
      end if;
      v_cat := upper(coalesce(nullif(btrim(coalesce(e ->> 'balance_category', '')), ''), case when v_party is not null then 'PARTY' else 'LEDGER' end));
      if v_cat not in ('LEDGER', 'PARTY', 'CASH_BANK', 'CAPITAL', 'LOAN', 'FIXED_ASSET', 'INVENTORY', 'OTHER') then
        raise exception 'unknown category %', v_cat;
      end if;
      insert into pg_temp.accounting_ob_stage values (i, v_acc, v_party, v_cat, v_d, v_c, left(nullif(btrim(coalesce(e ->> 'description', '')), ''), 300));
    exception when others then
      v_errors := v_errors || format('Row %s: %s', i, sqlerrm);
    end;
    exit when cardinality(v_errors) >= 50;
  end loop;
  for e in select to_jsonb(x) from (select account_id, party_id, min(line_no) as first_row, count(*) as n from pg_temp.accounting_ob_stage
                                    group by account_id, party_id having count(*) > 1) x loop
    v_errors := v_errors || format('Row %s: the same account%s appears %s times; combine them into one line.', e ->> 'first_row',
      case when e ->> 'party_id' is not null then ' and party' else '' end, e ->> 'n');
  end loop;
  if cardinality(v_errors) > 0 then
    raise exception 'The opening balances were not saved: %', array_to_string(v_errors[1:10], '; ') using errcode = '22023',
      detail = array_to_string(v_errors, E'\n');
  end if;
  delete from public.accounting_opening_balance_lines where batch_id = b.id;
  insert into public.accounting_opening_balance_lines (company_id, batch_id, line_no, account_id, party_id, balance_category, debit, credit, description)
  select v_company, b.id, line_no, account_id, party_id, category, debit, credit, description from pg_temp.accounting_ob_stage order by line_no;
  update public.accounting_opening_balance_batches
     set source = upper(coalesce(p_source, 'MANUAL')), file_name = case when upper(coalesce(p_source, '')) = 'IMPORT' then left(p_file_name, 200) else file_name end,
         total_debit = (select coalesce(sum(debit), 0) from pg_temp.accounting_ob_stage), total_credit = (select coalesce(sum(credit), 0) from pg_temp.accounting_ob_stage),
         reconciliation = null, acknowledgements = '[]'::jsonb, updated_by = auth.uid(), updated_at = now()
   where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.lines_saved', 'accounting_opening_batch', b.id::text,
    jsonb_build_object('lines', i, 'source', upper(coalesce(p_source, 'MANUAL')), 'file_name', left(p_file_name, 200)));
  return private.accounting_opening_json(b.id) || jsonb_build_object('checks', private.accounting_opening_checks(b.id));
end;
$$;

-- Explicitly adds one line per ERP party opening balance (Debtors / Creditors control) that the batch does not have yet.
create or replace function public.accounting_opening_prefill_parties(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.import');
  b         public.accounting_opening_balance_batches;
  v_deb     uuid;
  v_cred    uuid;
  v_next    int;
  v_added   int;
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found or b.status <> 'DRAFT' then
    raise exception 'Only a draft opening balance batch can be prefilled.' using errcode = 'P0001';
  end if;
  select account_id into v_deb from public.accounting_posting_rules where company_id = v_company and rule_key = 'DEBTORS' and match_value = '';
  select account_id into v_cred from public.accounting_posting_rules where company_id = v_company and rule_key = 'CREDITORS' and match_value = '';
  select coalesce(max(line_no), 0) into v_next from public.accounting_opening_balance_lines where batch_id = b.id;
  insert into public.accounting_opening_balance_lines (company_id, batch_id, line_no, account_id, party_id, balance_category, debit, credit, description)
  select v_company, b.id, v_next + row_number() over (order by p.party_code), x.account_id, p.id, 'PARTY',
         case when p.opening_balance_type = 'RECEIVABLE' then p.opening_balance else 0 end,
         case when p.opening_balance_type = 'PAYABLE' then p.opening_balance else 0 end,
         'ERP party opening balance ' || coalesce(to_char(p.opening_balance_date, 'DD-Mon-YYYY'), '')
  from public.parties p
  cross join lateral (select case when p.opening_balance_type = 'RECEIVABLE' then v_deb else v_cred end as account_id) x
  where p.company_id = v_company and p.opening_balance > 0 and p.opening_balance_type in ('RECEIVABLE', 'PAYABLE') and x.account_id is not null
    and not exists (select 1 from public.accounting_opening_balance_lines l where l.batch_id = b.id and l.party_id = p.id and l.account_id = x.account_id);
  get diagnostics v_added = row_count;
  update public.accounting_opening_balance_batches set reconciliation = null, acknowledgements = '[]'::jsonb, updated_by = auth.uid(), updated_at = now(),
    total_debit = (select coalesce(sum(debit), 0) from public.accounting_opening_balance_lines where batch_id = b.id),
    total_credit = (select coalesce(sum(credit), 0) from public.accounting_opening_balance_lines where batch_id = b.id)
   where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.prefilled', 'accounting_opening_batch', b.id::text, jsonb_build_object('lines_added', v_added));
  return private.accounting_opening_json(b.id) || jsonb_build_object('checks', private.accounting_opening_checks(b.id), 'lines_added', v_added);
end;
$$;

-- Approves a reconciled DRAFT. Failed checks that may be acknowledged need [{code, reason}] from the approver.
create or replace function public.accounting_opening_approve(p_batch_id uuid, p_acknowledgements jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.approve');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  b         public.accounting_opening_balance_batches;
  v_checks  jsonb;
  c         jsonb;
  v_ack     jsonb := '[]'::jsonb;
  v_reason  text;
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Opening balance batch not found.' using errcode = 'P0002';
  end if;
  if b.status <> 'DRAFT' then
    raise exception 'Only a draft batch can be approved (batch is %).', lower(b.status) using errcode = 'P0001';
  end if;
  if s.segregation_of_duties and b.created_by = auth.uid() then
    raise exception 'Segregation of duties is on: the batch must be approved by someone other than the person who prepared it.' using errcode = '42501';
  end if;
  v_checks := private.accounting_opening_checks(b.id);
  for c in select x from jsonb_array_elements(v_checks) x where x ->> 'status' = 'FAIL' loop
    if not (c ->> 'acknowledgeable')::boolean then
      raise exception 'Check failed: %. Fix the batch before approving.', c ->> 'label' using errcode = 'P0001', detail = c::text;
    end if;
    select nullif(btrim(coalesce(a ->> 'reason', '')), '') into v_reason
    from jsonb_array_elements(case when jsonb_typeof(p_acknowledgements) = 'array' then p_acknowledgements else '[]'::jsonb end) a
    where a ->> 'code' = c ->> 'code' limit 1;
    if v_reason is null or length(v_reason) < 10 then
      raise exception 'Not reconciled: %. Correct the batch, or acknowledge the difference with a reason of at least 10 characters.', c ->> 'label'
        using errcode = 'P0001', detail = c::text;
    end if;
    v_ack := v_ack || jsonb_build_object('code', c ->> 'code', 'reason', left(v_reason, 500), 'difference', c -> 'difference', 'by', auth.uid(), 'at', now());
  end loop;
  update public.accounting_opening_balance_batches set status = 'APPROVED', reconciliation = v_checks, acknowledgements = v_ack, approved_by = auth.uid(),
    approved_at = now(), updated_by = auth.uid(), updated_at = now() where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.approved', 'accounting_opening_batch', b.id::text,
    jsonb_build_object('acknowledged', v_ack, 'total_debit', b.total_debit, 'total_credit', b.total_credit));
  return private.accounting_opening_json(b.id) || jsonb_build_object('checks', v_checks);
end;
$$;

create or replace function public.accounting_opening_reopen(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.approve');
  b         public.accounting_opening_balance_batches;
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found or b.status <> 'APPROVED' then
    raise exception 'Only an approved, unposted batch can be returned to draft.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  update public.accounting_opening_balance_batches set status = 'DRAFT', approved_by = null, approved_at = null, reconciliation = null, acknowledgements = '[]'::jsonb,
    updated_by = auth.uid(), updated_at = now() where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.reopened', 'accounting_opening_batch', b.id::text, jsonb_build_object('reason', left(p_reason, 500)));
  return private.accounting_opening_json(b.id) || jsonb_build_object('checks', private.accounting_opening_checks(b.id));
end;
$$;

create or replace function public.accounting_opening_discard(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.import');
  b         public.accounting_opening_balance_batches;
begin
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found or b.status not in ('DRAFT', 'APPROVED') then
    raise exception 'Only a draft or approved, unposted batch can be discarded.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  update public.accounting_opening_balance_batches set status = 'DISCARDED', discarded_by = auth.uid(), discarded_at = now(), discard_reason = left(p_reason, 500),
    updated_by = auth.uid(), updated_at = now() where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.discarded', 'accounting_opening_batch', b.id::text, jsonb_build_object('reason', left(p_reason, 500)));
  return private.accounting_opening_json(b.id);
end;
$$;

-- Posts an APPROVED batch as one opening voucher (OPN) dated the books start date. Checks run again under the lock.
create or replace function public.accounting_opening_post(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_opening.approve');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  b         public.accounting_opening_balance_batches;
  v_checks  jsonb;
  c         jsonb;
  v_lines   jsonb;
  v_id      uuid;
  v         public.accounting_vouchers;
begin
  perform pg_advisory_xact_lock(hashtextextended('accounting_opening:' || v_company::text, 0));
  select * into b from public.accounting_opening_balance_batches where id = p_batch_id and company_id = v_company for update;
  if not found then
    raise exception 'Opening balance batch not found.' using errcode = 'P0002';
  end if;
  if b.status = 'POSTED' then
    raise exception 'This batch has already been posted (voucher %).', (select voucher_number from public.accounting_vouchers where id = b.voucher_id)
      using errcode = 'P0001';
  end if;
  if b.status <> 'APPROVED' then
    raise exception 'Approve the batch before posting it.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.accounting_opening_balance_batches where company_id = v_company and status = 'POSTED') then
    raise exception 'Opening balances have already been posted for this company.' using errcode = 'P0001';
  end if;
  v_checks := private.accounting_opening_checks(b.id);
  for c in select x from jsonb_array_elements(v_checks) x where x ->> 'status' = 'FAIL' loop
    if not (c ->> 'acknowledgeable')::boolean
       or not exists (select 1 from jsonb_array_elements(b.acknowledgements) a where a ->> 'code' = c ->> 'code'
                        and (a -> 'difference') is not distinct from (c -> 'difference')) then
      raise exception 'The batch is no longer reconciled (%). Return it to draft and review it.', c ->> 'label' using errcode = 'P0001', detail = c::text;
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'party_id', l.party_id, 'debit', l.debit, 'credit', l.credit,
                   'narration', coalesce(l.description, 'Opening balance')) order by l.line_no)
    into v_lines from public.accounting_opening_balance_lines l where l.batch_id = b.id;
  v_id := private.accounting_create_voucher(v_company, 'OPN', s.books_start_date, b.batch_number, 'Opening balances as at ' || to_char(s.books_start_date, 'DD-Mon-YYYY'),
    'OPENING', 'OPENING_BALANCE', b.id, b.batch_number, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  update public.accounting_opening_balance_batches set status = 'POSTED', voucher_id = v.id, posted_by = auth.uid(), posted_at = now(), reconciliation = v_checks,
    updated_by = auth.uid(), updated_at = now() where id = b.id;
  perform private.write_audit_log(v_company, 'accounting.opening.posted', 'accounting_opening_batch', b.id::text,
    jsonb_build_object('voucher_id', v.id, 'voucher_number', v.voucher_number, 'amount', v.total_debit));
  return private.accounting_opening_json(b.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Function grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.accounting_status()', 'public.accounting_initialize(date, integer)', 'public.accounting_settings_save(jsonb)',
    'public.accounting_periods(text)', 'public.accounting_period_generate(date)', 'public.accounting_period_set_status(uuid, text, text)',
    'public.accounting_chart()', 'public.accounting_group_save(uuid, jsonb)', 'public.accounting_account_save(uuid, jsonb)',
    'public.accounting_account_set_active(uuid, boolean)', 'public.accounting_accounts(text, boolean)', 'public.accounting_parties(text, text)',
    'public.accounting_cost_centres()',
    'public.accounting_cost_centre_save(uuid, jsonb)', 'public.accounting_posting_rules()', 'public.accounting_posting_rule_save(text, text, uuid)',
    'public.accounting_voucher_create(jsonb)', 'public.accounting_voucher_update(uuid, jsonb, integer)',
    'public.accounting_voucher_line_save(uuid, uuid, jsonb, integer)', 'public.accounting_voucher_line_delete(uuid, uuid, integer)',
    'public.accounting_voucher_validate(uuid)', 'public.accounting_voucher_post(uuid, integer)', 'public.accounting_voucher_discard(uuid, text)',
    'public.accounting_voucher_reverse(uuid, text, date)', 'public.accounting_voucher_get(uuid)', 'public.accounting_voucher_list(jsonb)',
    'public.accounting_trial_balance(date, date, boolean)', 'public.accounting_general_ledger(uuid, date, date, uuid)',
    'public.accounting_day_book(date, date, text)', 'public.accounting_dashboard()',
    'public.accounting_opening_batches()', 'public.accounting_opening_batch_get(uuid)', 'public.accounting_opening_batch_create(text)',
    'public.accounting_opening_lines_replace(uuid, jsonb, text, text)', 'public.accounting_opening_prefill_parties(uuid)',
    'public.accounting_opening_approve(uuid, jsonb)', 'public.accounting_opening_reopen(uuid, text)', 'public.accounting_opening_discard(uuid, text)',
    'public.accounting_opening_post(uuid)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. ERP reset registries (20261228090000 / 20261118090000 lists plus accounting)
--     Standard reset: configuration kept (like products and number series), vouchers and
--     events resettable (posted vouchers have delete guards, so the reset stops while they
--     exist). Force reset: every accounting table is purged through the reviewed exemption.
-- -----------------------------------------------------------------------------
-- Standard reset: the five accounting record tables are resettable (deleted before parties, children first).
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

revoke all on function private.erp_reset_tables() from public, anon, authenticated;

-- Standard reset keeps the accounting configuration (like products, settings and number series).
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

revoke all on function private.erp_reset_kept_tables() from public, anon, authenticated;

-- Force reset purges the accounting configuration too.
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
    ('products', 'Products & catalogue', 'Products'),
    ('product_versions', 'Products & catalogue', 'Product version history'),
    ('product_categories', 'Products & catalogue', 'Product categories'),
    ('warehouses', 'Warehouses & locations', 'Warehouses'),
    ('inventory_locations', 'Warehouses & locations', 'Warehouse locations'),
    ('documents', 'Documents', 'Documents (except company-level documents)'),
    ('document_versions', 'Documents', 'Document file versions')
  ) x (table_name, category, label);
$$;

revoke all on function private.erp_force_reset_tables() from public, anon, authenticated;
