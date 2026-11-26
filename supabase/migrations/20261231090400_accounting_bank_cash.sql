-- =============================================================================
-- Alton Accounts — Phase 4: Bank & Cash Management
--
-- Additive. Bank and cash account masters (each mapped to exactly one BANK / CASH ledger), an explicit bank / cash
-- account per customer receipt or supplier payment where the payment method alone does not identify it, bank and
-- cash books from posted vouchers, transfers (contra vouchers), bank statement import (evidence only — never
-- vouchers), reconciliation matching with remaining amounts, bank charges / interest adjustments from statement
-- lines, reconciliation statements and reports.
--
-- Unchanged: customer_payments, supplier_payments and their RPCs, the voucher engine (create / post / reverse),
-- Phases 0–3. Redefined from their latest text with marked Phase 4 lines: private.accounting_build_event (per-payment
-- account), private.accounting_seed_chart (CTR / BNK voucher types), the three ERP reset registries.
--
-- Rollback: supabase/rollback/20261231090400_accounting_bank_cash_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('bank_accounts', 'read',         'View bank accounts (masked numbers), bank books and bank reports'),
  ('bank_accounts', 'manage',       'Create and edit bank accounts, reveal full account numbers, assign payments to bank accounts'),
  ('cash_accounts', 'read',         'View cash accounts, cash books and the cash position'),
  ('cash_accounts', 'manage',       'Create and edit cash accounts and their balance policy'),
  ('bank_reconciliation', 'read',    'View bank statements, matches and reconciliation statements'),
  ('bank_reconciliation', 'manage',  'Import bank statements, match and unmatch transactions, save reconciliations'),
  ('bank_reconciliation', 'approve', 'Post bank charges / interest adjustments and accept reconciliation differences'),
  ('bank_transfers', 'create',       'Create and cancel draft bank / cash transfers'),
  ('bank_transfers', 'post',         'Post and reverse bank / cash transfers')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values ('ACCOUNTS_MANAGER', 'bank_accounts.read'), ('ACCOUNTS_MANAGER', 'bank_accounts.manage'), ('ACCOUNTS_MANAGER', 'cash_accounts.read'),
         ('ACCOUNTS_MANAGER', 'cash_accounts.manage'), ('ACCOUNTS_MANAGER', 'bank_reconciliation.read'), ('ACCOUNTS_MANAGER', 'bank_reconciliation.manage'),
         ('ACCOUNTS_MANAGER', 'bank_reconciliation.approve'), ('ACCOUNTS_MANAGER', 'bank_transfers.create'), ('ACCOUNTS_MANAGER', 'bank_transfers.post'),
         ('ADMIN', 'bank_accounts.read'), ('ADMIN', 'cash_accounts.read'), ('ADMIN', 'bank_reconciliation.read'),
         ('MANAGEMENT_VIEWER', 'bank_accounts.read'), ('MANAGEMENT_VIEWER', 'cash_accounts.read'), ('MANAGEMENT_VIEWER', 'bank_reconciliation.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m join public.roles r on r.code = m.role_code join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
-- Bank and cash accounts (one table, kind BANK / CASH). Each maps to exactly one active ledger of the matching nature.
create table if not exists public.bank_cash_accounts (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies (id) on delete restrict,
  account_kind              text not null check (account_kind in ('BANK', 'CASH')),
  account_code              text not null check (account_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  account_name              text not null check (length(btrim(account_name)) between 1 and 120),
  ledger_account_id         uuid not null,
  bank_name                 text check (bank_name is null or length(btrim(bank_name)) between 1 and 120),
  branch_name               text check (branch_name is null or length(branch_name) <= 120),
  account_holder_name       text check (account_holder_name is null or length(btrim(account_holder_name)) between 1 and 160),
  account_number_masked     text check (account_number_masked is null or account_number_masked ~ '^X*[0-9A-Z]{1,4}$'),
  -- sha256 of IFSC + normalised number: detects a second active registration of the same bank account without storing the number here.
  account_fingerprint       text check (account_fingerprint is null or account_fingerprint ~ '^[0-9a-f]{64}$'),
  ifsc                      text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_account_type         text check (bank_account_type is null or bank_account_type in ('CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OVERDRAFT', 'OTHER')),
  currency                  text not null default 'INR' check (currency = 'INR'),
  opening_balance           numeric(18,2),
  opening_balance_type      text check (opening_balance_type is null or opening_balance_type in ('DEBIT', 'CREDIT')),
  opening_balance_date      date,
  opening_balance_reference text check (opening_balance_reference is null or length(opening_balance_reference) <= 200),
  custodian_user_id         uuid,
  -- Postings that would take the ledger below zero on or after their date are refused (database trigger), unless allowed.
  allow_negative_balance    boolean not null default false,
  is_active                 boolean not null default true,
  notes                     text check (notes is null or length(notes) <= 1000),
  row_version               integer not null default 1,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_by                uuid,
  updated_at                timestamptz not null default now(),
  constraint bank_cash_accounts_code_unique unique (company_id, account_code),
  constraint bank_cash_accounts_id_company_unique unique (id, company_id),
  constraint bank_cash_accounts_ledger_fk foreign key (ledger_account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint bank_cash_accounts_bank_fields check (
    (account_kind = 'BANK') = (bank_name is not null and account_holder_name is not null and account_number_masked is not null and account_fingerprint is not null
                               and ifsc is not null and bank_account_type is not null)
    and (account_kind = 'BANK' or (branch_name is null and bank_name is null))),
  constraint bank_cash_accounts_opening check ((opening_balance is null) = (opening_balance_type is null) and (opening_balance is null or opening_balance >= 0))
);
create unique index if not exists bank_cash_accounts_ledger_unique on public.bank_cash_accounts (company_id, ledger_account_id) where is_active;
create unique index if not exists bank_cash_accounts_fingerprint_unique on public.bank_cash_accounts (company_id, account_fingerprint) where is_active and account_fingerprint is not null;

-- Full bank account numbers: no grants to any API role; read only through bank_account_reveal_number (audited).
create table if not exists public.bank_account_numbers (
  bank_cash_account_id uuid primary key references public.bank_cash_accounts (id) on delete restrict,
  company_id           uuid not null references public.companies (id) on delete restrict,
  account_number       text not null check (account_number ~ '^[0-9A-Z]{6,34}$'),
  updated_at           timestamptz not null default now()
);

-- Payment methods whose bank / cash account must be chosen per payment (no default ledger is used for them).
create table if not exists public.bank_payment_method_policies (
  company_id        uuid not null references public.companies (id) on delete restrict,
  direction         text not null check (direction in ('RECEIPT', 'PAYMENT')),
  payment_method    text not null check (payment_method in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER')),
  require_selection boolean not null default false,
  updated_by        uuid,
  updated_at        timestamptz not null default now(),
  primary key (company_id, direction, payment_method)
);

-- The bank / cash account of one customer receipt or supplier payment (verified by a user, with a reason).
create table if not exists public.bank_payment_assignments (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  source_type          text not null check (source_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')),
  source_id            uuid not null,
  bank_cash_account_id uuid not null,
  reason               text not null check (length(btrim(reason)) between 5 and 500),
  status               text not null default 'ACTIVE' check (status in ('ACTIVE', 'REPLACED')),
  assigned_by          uuid,
  assigned_at          timestamptz not null default now(),
  constraint bank_payment_assignments_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict
);
create unique index if not exists bank_payment_assignments_active_unique on public.bank_payment_assignments (source_type, source_id) where status = 'ACTIVE';

create table if not exists public.bank_transfers (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies (id) on delete restrict,
  transfer_number     text not null check (transfer_number ~ '^TRF-[0-9]{6,}$'),
  transfer_date       date not null,
  from_account_id     uuid not null,
  to_account_id       uuid not null,
  amount              numeric(18,2) not null check (amount > 0),
  charges             numeric(18,2) not null default 0 check (charges >= 0),
  charges_account_id  uuid,
  reference           text check (reference is null or length(reference) <= 100),
  narration           text check (narration is null or length(narration) <= 500),
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),
  voucher_id          uuid,
  reversal_voucher_id uuid,
  reversal_reason     text check (reversal_reason is null or length(reversal_reason) <= 500),
  cancel_reason       text check (cancel_reason is null or length(cancel_reason) <= 500),
  row_version         integer not null default 1,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  posted_by           uuid,
  posted_at           timestamptz,
  reversed_by         uuid,
  reversed_at         timestamptz,
  updated_at          timestamptz not null default now(),
  constraint bank_transfers_number_unique unique (company_id, transfer_number),
  constraint bank_transfers_from_fk foreign key (from_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint bank_transfers_to_fk foreign key (to_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint bank_transfers_charges_fk foreign key (charges_account_id, company_id) references public.accounts (id, company_id) on delete restrict,
  constraint bank_transfers_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint bank_transfers_reversal_fk foreign key (reversal_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint bank_transfers_distinct check (from_account_id <> to_account_id),
  constraint bank_transfers_charges check ((charges > 0) = (charges_account_id is not null)),
  constraint bank_transfers_posted check ((status in ('POSTED', 'REVERSED')) = (voucher_id is not null and posted_at is not null)),
  constraint bank_transfers_reversed check ((status = 'REVERSED') = (reversal_voucher_id is not null and reversal_reason is not null)),
  constraint bank_transfers_cancelled check ((status = 'CANCELLED') = (cancel_reason is not null))
);

create table if not exists public.bank_statement_imports (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  bank_cash_account_id uuid not null,
  file_name            text not null check (length(file_name) between 1 and 255),
  file_sha256          text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size            integer not null check (file_size > 0),
  mime_type            text check (mime_type is null or length(mime_type) <= 120),
  column_mapping       jsonb not null default '{}'::jsonb,
  row_count            integer not null check (row_count >= 0),
  imported_count       integer not null check (imported_count >= 0),
  duplicate_count      integer not null check (duplicate_count >= 0),
  failed_count         integer not null check (failed_count >= 0),
  report               jsonb not null default '[]'::jsonb,
  statement_from       date,
  statement_to         date,
  imported_by          uuid,
  imported_at          timestamptz not null default now(),
  constraint bank_statement_imports_id_company_unique unique (id, company_id),
  constraint bank_statement_imports_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict
);

-- The original uploaded file (kept as evidence; no grants to API roles — downloaded through bank_statement_file, audited).
create table if not exists public.bank_statement_files (
  import_id  uuid primary key,
  company_id uuid not null,
  content    bytea not null check (octet_length(content) <= 5242880),
  constraint bank_statement_files_import_fk foreign key (import_id, company_id) references public.bank_statement_imports (id, company_id) on delete restrict
);

create table if not exists public.bank_statement_lines (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  import_id             uuid not null,
  bank_cash_account_id  uuid not null,
  row_no                integer not null check (row_no >= 1),
  txn_date              date not null,
  value_date            date,
  description           text check (description is null or length(description) <= 500),
  reference             text check (reference is null or length(reference) <= 120),
  bank_txn_id           text check (bank_txn_id is null or length(bank_txn_id) <= 120),
  debit                 numeric(18,2) not null default 0 check (debit >= 0),
  credit                numeric(18,2) not null default 0 check (credit >= 0),
  running_balance       numeric(18,2),
  -- Signed from the bank account's point of view: deposit (credit on the statement) positive, withdrawal negative.
  amount                numeric(18,2) generated always as (credit - debit) stored,
  dedupe_key            text not null,
  category              text not null default 'OTHER' check (category in ('CHARGES', 'INTEREST', 'OTHER')),
  adjustment_voucher_id uuid,
  created_at            timestamptz not null default now(),
  constraint bank_statement_lines_one_side check ((debit > 0) <> (credit > 0)),
  constraint bank_statement_lines_dedupe_unique unique (bank_cash_account_id, dedupe_key),
  constraint bank_statement_lines_id_company_unique unique (id, company_id),
  constraint bank_statement_lines_import_fk foreign key (import_id, company_id) references public.bank_statement_imports (id, company_id) on delete restrict,
  constraint bank_statement_lines_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint bank_statement_lines_voucher_fk foreign key (adjustment_voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict
);
create index if not exists bank_statement_lines_account_date_idx on public.bank_statement_lines (bank_cash_account_id, txn_date);

create table if not exists public.bank_reconciliation_matches (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete restrict,
  bank_cash_account_id uuid not null,
  method               text not null check (method in ('AUTO', 'MANUAL', 'ADJUSTMENT')),
  reason               text check (reason is null or length(reason) <= 500),
  status               text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVERSED')),
  total                numeric(18,2) not null,
  -- Latest date on either side: the match counts in a reconciliation as of this date or later.
  effective_date       date not null,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  reversed_by          uuid,
  reversed_at          timestamptz,
  reversal_reason      text check (reversal_reason is null or length(reversal_reason) <= 500),
  constraint bank_reconciliation_matches_id_company_unique unique (id, company_id),
  constraint bank_reconciliation_matches_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint bank_reconciliation_matches_manual_reason check (method <> 'MANUAL' or length(btrim(coalesce(reason, ''))) >= 5),
  constraint bank_reconciliation_matches_reversed check ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null))
);

create table if not exists public.bank_reconciliation_match_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  match_id          uuid not null,
  statement_line_id uuid,
  voucher_line_id   uuid references public.accounting_voucher_lines (id) on delete restrict,
  -- Signed like the line (deposit / bank debit positive); never more than the line's unmatched remainder (checked under lock).
  amount            numeric(18,2) not null check (amount <> 0),
  constraint bank_match_items_match_fk foreign key (match_id, company_id) references public.bank_reconciliation_matches (id, company_id) on delete restrict,
  constraint bank_match_items_statement_fk foreign key (statement_line_id, company_id) references public.bank_statement_lines (id, company_id) on delete restrict,
  constraint bank_match_items_one_side check ((statement_line_id is null) <> (voucher_line_id is null))
);
create index if not exists bank_match_items_statement_idx on public.bank_reconciliation_match_items (statement_line_id) where statement_line_id is not null;
create index if not exists bank_match_items_voucher_line_idx on public.bank_reconciliation_match_items (voucher_line_id) where voucher_line_id is not null;

create table if not exists public.bank_reconciliations (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies (id) on delete restrict,
  bank_cash_account_id    uuid not null,
  as_of_date              date not null,
  ledger_balance          numeric(18,2) not null,
  statement_balance       numeric(18,2) not null,
  outstanding_deposits    numeric(18,2) not null,
  outstanding_payments    numeric(18,2) not null,
  unrecorded_credits      numeric(18,2) not null,
  unrecorded_debits       numeric(18,2) not null,
  adjusted_bank_balance   numeric(18,2) not null,
  adjusted_book_balance   numeric(18,2) not null,
  difference              numeric(18,2) not null,
  status                  text not null check (status in ('COMPLETED', 'ACCEPTED_DIFFERENCE')),
  difference_reason       text check (difference_reason is null or length(difference_reason) <= 1000),
  details                 jsonb not null default '{}'::jsonb,
  created_by              uuid,
  created_at              timestamptz not null default now(),
  constraint bank_reconciliations_account_fk foreign key (bank_cash_account_id, company_id) references public.bank_cash_accounts (id, company_id) on delete restrict,
  constraint bank_reconciliations_status check ((status = 'COMPLETED') = (difference = 0) and (status <> 'ACCEPTED_DIFFERENCE' or length(btrim(coalesce(difference_reason, ''))) >= 10))
);

do $$
declare
  t text;
begin
  foreach t in array array['bank_cash_accounts', 'bank_payment_method_policies', 'bank_payment_assignments', 'bank_transfers', 'bank_statement_imports',
                           'bank_statement_lines', 'bank_reconciliation_matches', 'bank_reconciliation_match_items', 'bank_reconciliations',
                           'bank_account_numbers', 'bank_statement_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
  end loop;
  -- Read access per area; the two evidence / secret tables get no grant at all.
  foreach t in array array['bank_payment_assignments', 'bank_transfers'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L) or private.has_permission(company_id, %L))',
      t || '_select', t, 'bank_accounts.read', 'cash_accounts.read');
  end loop;
  foreach t in array array['bank_statement_imports', 'bank_statement_lines', 'bank_reconciliation_matches', 'bank_reconciliation_match_items', 'bank_reconciliations'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_permission(company_id, %L))', t || '_select', t, 'bank_reconciliation.read');
  end loop;
  -- Column grant: the account fingerprint (a hash of IFSC + number) is never readable by API roles.
  grant select (id, company_id, account_kind, account_code, account_name, ledger_account_id, bank_name, branch_name, account_holder_name, account_number_masked,
    ifsc, bank_account_type, currency, opening_balance, opening_balance_type, opening_balance_date, opening_balance_reference, custodian_user_id,
    allow_negative_balance, is_active, notes, row_version, created_by, created_at, updated_by, updated_at) on public.bank_cash_accounts to authenticated;
  create policy bank_cash_accounts_select on public.bank_cash_accounts for select to authenticated
    using ((account_kind = 'BANK' and private.has_permission(company_id, 'bank_accounts.read')) or (account_kind = 'CASH' and private.has_permission(company_id, 'cash_accounts.read')));
  grant select on table public.bank_payment_method_policies to authenticated;
  create policy bank_payment_method_policies_select on public.bank_payment_method_policies for select to authenticated
    using (private.has_permission(company_id, 'bank_accounts.read') or private.has_permission(company_id, 'accounting_settings.manage'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Guards: posted transfers, statement lines, matches, reconciliations and assignments are history (changed only by the RPCs' own
--    state moves; never deleted outside a reset).
-- -----------------------------------------------------------------------------
create or replace function private.bank_history_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'bank_transfers' then
    if old.status in ('REVERSED', 'CANCELLED') or (old.status = 'POSTED' and (new.status <> 'REVERSED'
        or (to_jsonb(new) - array['status', 'reversal_voucher_id', 'reversal_reason', 'reversed_by', 'reversed_at', 'updated_at', 'row_version'])
           <> (to_jsonb(old) - array['status', 'reversal_voucher_id', 'reversal_reason', 'reversed_by', 'reversed_at', 'updated_at', 'row_version']))) then
      raise exception 'A posted, reversed or cancelled transfer cannot be changed; reverse it instead.' using errcode = '42501';
    end if;
  elsif tg_table_name = 'bank_statement_lines' then
    -- amount is a generated column (not yet computed in a BEFORE trigger); debit / credit are compared instead.
    if (to_jsonb(new) - array['adjustment_voucher_id', 'category', 'amount']) <> (to_jsonb(old) - array['adjustment_voucher_id', 'category', 'amount'])
       or (old.adjustment_voucher_id is not null and new.adjustment_voucher_id is distinct from old.adjustment_voucher_id) then
      raise exception 'Imported bank statement lines are evidence and cannot be changed.' using errcode = '42501';
    end if;
  elsif tg_table_name = 'bank_reconciliation_matches' then
    if old.status = 'REVERSED' or new.status <> 'REVERSED'
       or (to_jsonb(new) - array['status', 'reversed_by', 'reversed_at', 'reversal_reason']) <> (to_jsonb(old) - array['status', 'reversed_by', 'reversed_at', 'reversal_reason']) then
      raise exception 'A reconciliation match can only be reversed (with a reason), never edited.' using errcode = '42501';
    end if;
  elsif tg_table_name = 'bank_payment_assignments' then
    if old.status <> 'ACTIVE' or new.status <> 'REPLACED' or (to_jsonb(new) - 'status') <> (to_jsonb(old) - 'status') then
      raise exception 'A payment account assignment can only be replaced by a new one.' using errcode = '42501';
    end if;
  else
    raise exception '% rows are history and cannot be changed.', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.bank_history_guard() from public, anon, authenticated;

drop trigger if exists bank_transfers_guard on public.bank_transfers;
create trigger bank_transfers_guard before update on public.bank_transfers for each row execute function private.bank_history_guard();
drop trigger if exists bank_statement_lines_guard on public.bank_statement_lines;
create trigger bank_statement_lines_guard before update on public.bank_statement_lines for each row execute function private.bank_history_guard();
drop trigger if exists bank_reconciliation_matches_guard on public.bank_reconciliation_matches;
create trigger bank_reconciliation_matches_guard before update on public.bank_reconciliation_matches for each row execute function private.bank_history_guard();
drop trigger if exists bank_match_items_guard on public.bank_reconciliation_match_items;
create trigger bank_match_items_guard before update on public.bank_reconciliation_match_items for each row execute function private.bank_history_guard();
drop trigger if exists bank_reconciliations_guard on public.bank_reconciliations;
create trigger bank_reconciliations_guard before update on public.bank_reconciliations for each row execute function private.bank_history_guard();
drop trigger if exists bank_payment_assignments_guard on public.bank_payment_assignments;
create trigger bank_payment_assignments_guard before update on public.bank_payment_assignments for each row execute function private.bank_history_guard();
drop trigger if exists bank_statement_imports_guard on public.bank_statement_imports;
create trigger bank_statement_imports_guard before update on public.bank_statement_imports for each row execute function private.bank_history_guard();

-- -----------------------------------------------------------------------------
-- 4. Balance policy (database-enforced, transactional): a voucher that credits the ledger of a bank / cash account which does not allow a
--    negative balance is refused if the ledger would fall below zero on its date or any later date. The account row is locked first, so
--    concurrent postings from the same account queue and each sees the other's result (no concurrent overspending).
-- -----------------------------------------------------------------------------
create or replace function private.bank_cash_balance_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r     record;
  v_min numeric;
begin
  for r in select distinct b.id, b.account_code, b.account_name, b.account_kind, b.ledger_account_id
           from public.accounting_voucher_lines l
           join public.bank_cash_accounts b on b.ledger_account_id = l.account_id and b.company_id = l.company_id and b.is_active and not b.allow_negative_balance
           where l.voucher_id = new.id and l.credit > 0
           order by b.id loop
    perform 1 from public.bank_cash_accounts where id = r.id for update;
    select min(y.cum) into v_min from (
      select x.d, sum(sum(x.amt)) over (order by x.d) as cum
      from (select v.voucher_date as d, l.debit - l.credit as amt
            from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
            where l.account_id = r.ledger_account_id and v.status in ('POSTED', 'REVERSED')) x
      group by x.d) y
    where y.d >= new.voucher_date;
    if coalesce(v_min, 0) < 0 then
      raise exception '% % (%) would go below zero (lowest balance % on or after %). Record the receipts first, or allow a negative balance for this account.',
        case r.account_kind when 'CASH' then 'Cash account' else 'Bank account' end, r.account_code, r.account_name,
        to_char(v_min, 'FM999999999999990.00'), to_char(new.voucher_date, 'DD-Mon-YYYY') using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.bank_cash_balance_guard() from public, anon, authenticated;
drop trigger if exists accounting_vouchers_bank_cash_balance on public.accounting_vouchers;
create trigger accounting_vouchers_bank_cash_balance after update of status on public.accounting_vouchers
  for each row when (new.status = 'POSTED' and old.status = 'DRAFT') execute function private.bank_cash_balance_guard();

-- -----------------------------------------------------------------------------
-- 5. Seeding: Contra (transfers) and Bank adjustment voucher types, automatic only.
-- -----------------------------------------------------------------------------
create or replace function private.accounting_seed_bank_cash(p_company uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.accounting_voucher_types (company_id, type_code, type_name, prefix, allow_manual)
  values (p_company, 'CTR', 'Contra (bank / cash transfer)', 'CTR', false), (p_company, 'BNK', 'Bank adjustment', 'BNK', false)
  on conflict (company_id, type_code) do nothing;
$$;
revoke all on function private.accounting_seed_bank_cash(uuid) from public, anon, authenticated, service_role;

do $$
declare
  c uuid;
begin
  for c in select company_id from public.accounting_settings loop
    perform private.accounting_seed_bank_cash(c);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Helpers
-- -----------------------------------------------------------------------------
-- The bank / cash account a payment is explicitly assigned to (active assignment; account active).
create or replace function private.bank_payment_assigned_ledger(p_source_type text, p_source_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.ledger_account_id from public.bank_payment_assignments a join public.bank_cash_accounts b on b.id = a.bank_cash_account_id
  where a.source_type = p_source_type and a.source_id = p_source_id and a.status = 'ACTIVE' and b.is_active;
$$;

create or replace function private.bank_payment_requires_selection(p_company uuid, p_direction text, p_method text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select require_selection from public.bank_payment_method_policies
                   where company_id = p_company and direction = p_direction and payment_method = p_method), false);
$$;

-- Matched (active) amount of a statement line / voucher line, optionally only matches effective on or before p_as_of.
create or replace function private.bank_stmt_matched(p_line uuid, p_as_of date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(i.amount), 0) from public.bank_reconciliation_match_items i join public.bank_reconciliation_matches m on m.id = i.match_id
  where i.statement_line_id = p_line and m.status = 'ACTIVE' and (p_as_of is null or m.effective_date <= p_as_of);
$$;
create or replace function private.bank_ledger_matched(p_line uuid, p_as_of date default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(i.amount), 0) from public.bank_reconciliation_match_items i join public.bank_reconciliation_matches m on m.id = i.match_id
  where i.voucher_line_id = p_line and m.status = 'ACTIVE' and (p_as_of is null or m.effective_date <= p_as_of);
$$;

create or replace function private.bank_match_state(p_amount numeric, p_matched numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_matched = 0 then 'UNMATCHED' when p_matched = p_amount then 'MATCHED' else 'PARTIALLY_MATCHED' end;
$$;

-- Ledger entries of a bank / cash account (posted vouchers and their reversals), with source details for books and reconciliation.
create or replace function private.bank_ledger_rows(p_account uuid)
returns table (line_id uuid, voucher_id uuid, voucher_number text, voucher_date date, voucher_type text, source text, source_type text, source_id uuid,
  is_reversal boolean, posted_at timestamptz, line_no int, narration text, debit numeric, credit numeric, amount numeric, party_id uuid, counterparty text,
  payment_method text, reference text, transfer_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, v.id, v.voucher_number, v.voucher_date, t.type_code, v.source, v.source_type, v.source_id, v.source = 'REVERSAL', v.posted_at, l.line_no,
         coalesce(l.line_narration, v.narration), l.debit, l.credit, l.debit - l.credit,
         o.party_id,
         coalesce(case when o.party_id is not null then private.accounting_party_name(o.party_id) end,
                  case when bt.id is not null then (select x.account_name from public.bank_cash_accounts x
                    where x.id = case when bt.from_account_id = b.id then bt.to_account_id else bt.from_account_id end) end,
                  o.account_name),
         coalesce(cp.payment_method, sp.payment_method, case when bt.id is not null then 'TRANSFER' end),
         coalesce(cp.transaction_reference, cp.bank_reference, sp.reference, bt.reference, v.reference_number),
         bt.id
  from public.bank_cash_accounts b
  join public.accounting_voucher_lines l on l.account_id = b.ledger_account_id and l.company_id = b.company_id
  join public.accounting_vouchers v on v.id = l.voucher_id and v.status in ('POSTED', 'REVERSED')
  join public.accounting_voucher_types t on t.id = v.voucher_type_id
  left join lateral (select x.party_id, a.account_name from public.accounting_voucher_lines x join public.accounts a on a.id = x.account_id
                     where x.voucher_id = v.id and x.id <> l.id order by (x.party_id is null), x.line_no limit 1) o on true
  left join public.customer_payments cp on v.source_type = 'CUSTOMER_RECEIPT' and cp.id = v.source_id
  left join public.supplier_payments sp on v.source_type = 'SUPPLIER_PAYMENT' and sp.id = v.source_id
  left join public.bank_transfers bt on v.source_type = 'BANK_TRANSFER' and bt.id = v.source_id
  where b.id = p_account;
$$;

create or replace function private.bank_ledger_balance(p_account uuid, p_as_of date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0)
  from public.bank_cash_accounts b
  join public.accounting_voucher_lines l on l.account_id = b.ledger_account_id and l.company_id = b.company_id
  join public.accounting_vouchers v on v.id = l.voucher_id and v.status in ('POSTED', 'REVERSED')
  where b.id = p_account and (p_as_of is null or v.voucher_date <= p_as_of);
$$;

-- The account (company-scoped) for a read / write, with the kind-specific permission checked.
create or replace function private.bank_account_for(p_company uuid, p_account uuid, p_action text)
returns public.bank_cash_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.bank_cash_accounts;
begin
  select * into b from public.bank_cash_accounts where id = p_account and company_id = p_company;
  if not found then
    raise exception 'Bank / cash account not found.' using errcode = 'P0002';
  end if;
  if not private.has_permission(p_company, case b.account_kind when 'BANK' then 'bank_accounts.' else 'cash_accounts.' end || p_action) then
    raise exception 'You are not allowed to perform this action (requires %).', case b.account_kind when 'BANK' then 'bank_accounts.' else 'cash_accounts.' end || p_action
      using errcode = '42501';
  end if;
  return b;
end;
$$;

create or replace function private.bank_account_json(b public.bank_cash_accounts)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(b) - 'account_fingerprint' || jsonb_build_object(
    'ledger_code', a.account_code, 'ledger_name', a.account_name, 'ledger_active', a.is_active,
    'ledger_balance', private.bank_ledger_balance(b.id, null),
    'custodian_name', (select full_name from public.profiles where id = b.custodian_user_id),
    'last_statement_date', (select max(txn_date) from public.bank_statement_lines where bank_cash_account_id = b.id),
    'unmatched_statement_lines', (select count(*) from public.bank_statement_lines s where s.bank_cash_account_id = b.id and private.bank_stmt_matched(s.id) <> s.amount))
  from public.accounts a where a.id = b.ledger_account_id;
$$;

revoke all on function private.bank_payment_assigned_ledger(text, uuid) from public, anon, authenticated;
revoke all on function private.bank_payment_requires_selection(uuid, text, text) from public, anon, authenticated;
revoke all on function private.bank_stmt_matched(uuid, date) from public, anon, authenticated;
revoke all on function private.bank_ledger_matched(uuid, date) from public, anon, authenticated;
revoke all on function private.bank_match_state(numeric, numeric) from public, anon, authenticated;
revoke all on function private.bank_ledger_rows(uuid) from public, anon, authenticated;
revoke all on function private.bank_ledger_balance(uuid, date) from public, anon, authenticated;
revoke all on function private.bank_account_for(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.bank_account_json(public.bank_cash_accounts) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 7. Bank and cash account masters
-- -----------------------------------------------------------------------------
create or replace function public.bank_cash_account_list(p_kind text default null, p_include_inactive boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'cash_accounts.read']);
begin
  return coalesce((select jsonb_agg(private.bank_account_json(b) order by b.account_kind, b.is_active desc, b.account_code)
    from public.bank_cash_accounts b
    where b.company_id = v_company and (p_kind is null or b.account_kind = upper(p_kind)) and (p_include_inactive or b.is_active)
      and ((b.account_kind = 'BANK' and private.has_permission(v_company, 'bank_accounts.read'))
        or (b.account_kind = 'CASH' and private.has_permission(v_company, 'cash_accounts.read')))), '[]'::jsonb);
end;
$$;

-- Creates (p_id NULL) or edits a bank / cash account. The full bank account number is accepted here and stored apart
-- (bank_account_numbers, no API access); the account row keeps a masked number and a fingerprint for duplicate detection.
create or replace function public.bank_cash_account_save(p_id uuid, p_account jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.manage', 'cash_accounts.manage']);
  b         public.bank_cash_accounts;
  v_new     boolean := p_id is null;
  v_kind    text;
  v_code    text := upper(private.accounting_text(p_account, 'account_code', 20, 'Account code'));
  v_name    text := private.accounting_text(p_account, 'account_name', 120, 'Account name');
  v_ledger  uuid := private.accounting_uuid(p_account, 'ledger_account_id', 'Linked ledger');
  v_number  text := upper(regexp_replace(coalesce(p_account ->> 'account_number', ''), '[\s-]', '', 'g'));
  v_ifsc    text := upper(private.accounting_text(p_account, 'ifsc', 11, 'IFSC'));
  v_type    text := upper(private.accounting_text(p_account, 'bank_account_type', 20, 'Account type'));
  v_cust    uuid := private.accounting_uuid(p_account, 'custodian_user_id', 'Custodian');
  v_obal    numeric;
  v_otype   text := upper(private.accounting_text(p_account, 'opening_balance_type', 10, 'Opening balance type'));
  v_neg     boolean;
  a         public.accounts;
  v_fp      text;
begin
  perform private.accounting_require_setup(v_company);
  if p_account is null or jsonb_typeof(p_account) <> 'object' then
    raise exception 'The account must be an object.' using errcode = '22023';
  end if;
  if v_new then
    v_kind := upper(coalesce(p_account ->> 'account_kind', ''));
    if v_kind not in ('BANK', 'CASH') then
      raise exception 'Account kind must be BANK or CASH.' using errcode = '22023';
    end if;
  else
    select * into b from public.bank_cash_accounts where id = p_id and company_id = v_company for update;
    if not found then
      raise exception 'Bank / cash account not found.' using errcode = 'P0002';
    end if;
    if p_row_version is not null and b.row_version <> p_row_version then
      raise exception 'This account was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    v_kind := b.account_kind;
  end if;
  if not private.has_permission(v_company, case v_kind when 'BANK' then 'bank_accounts.manage' else 'cash_accounts.manage' end) then
    raise exception 'You are not allowed to perform this action (requires %).', case v_kind when 'BANK' then 'bank_accounts.manage' else 'cash_accounts.manage' end
      using errcode = '42501';
  end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' then
    raise exception 'Account code: up to 20 letters, digits, - or _.' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'The account name is required.' using errcode = '22023';
  end if;
  select * into a from public.accounts where id = v_ledger and company_id = v_company;
  if not found then
    raise exception 'Select the linked ledger (an account of this company''s chart).' using errcode = '22023';
  end if;
  if a.account_nature <> v_kind then
    raise exception 'Ledger % is not a % ledger. Choose (or create in the Chart of Accounts) a ledger of nature %.', a.account_code, lower(v_kind), v_kind
      using errcode = 'P0001';
  end if;
  if not (a.is_active and a.is_postable) then
    raise exception 'Ledger % is inactive or does not accept postings.', a.account_code using errcode = 'P0001';
  end if;
  if v_cust is not null and not exists (select 1 from public.profiles where id = v_cust and company_id = v_company) then
    raise exception 'The custodian must be a user of this company.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_account ->> 'opening_balance', '')), '') is not null then
    v_obal := private.accounting_amount(p_account, 'opening_balance', 'Opening balance');
    if v_otype not in ('DEBIT', 'CREDIT') then
      raise exception 'Opening balance type must be DEBIT or CREDIT.' using errcode = '22023';
    end if;
  else
    v_otype := null;
  end if;

  if v_kind = 'BANK' then
    if private.accounting_text(p_account, 'bank_name', 120, 'Bank name') is null or private.accounting_text(p_account, 'account_holder_name', 160, 'Account holder') is null then
      raise exception 'Bank name and account holder name are required.' using errcode = '22023';
    end if;
    if v_ifsc is null or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
      raise exception 'IFSC must be 11 characters: 4 letters, 0, then 6 letters or digits.' using errcode = '22023';
    end if;
    if v_type not in ('CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OVERDRAFT', 'OTHER') then
      raise exception 'Account type must be CURRENT, SAVINGS, CASH_CREDIT, OVERDRAFT or OTHER.' using errcode = '22023';
    end if;
    if v_number = '' and v_new then
      raise exception 'The bank account number is required.' using errcode = '22023';
    end if;
    if v_number <> '' and v_number !~ '^[0-9A-Z]{6,34}$' then
      raise exception 'The bank account number must be 6 to 34 letters or digits.' using errcode = '22023';
    end if;
  elsif coalesce(p_account ->> 'account_number', '') <> '' or v_ifsc is not null or p_account ? 'bank_name' and nullif(p_account ->> 'bank_name', '') is not null then
    raise exception 'A cash account has no bank details.' using errcode = '22023';
  end if;
  v_neg := coalesce((p_account ->> 'allow_negative_balance')::boolean,
                    case when v_new then v_kind = 'BANK' and v_type in ('CASH_CREDIT', 'OVERDRAFT') else b.allow_negative_balance end);

  begin
    if v_new then
      if v_kind = 'BANK' then
        v_fp := encode(sha256(convert_to(v_ifsc || ':' || v_number, 'UTF8')), 'hex');
      end if;
      insert into public.bank_cash_accounts (company_id, account_kind, account_code, account_name, ledger_account_id, bank_name, branch_name, account_holder_name,
        account_number_masked, account_fingerprint, ifsc, bank_account_type, opening_balance, opening_balance_type, opening_balance_date, opening_balance_reference,
        custodian_user_id, allow_negative_balance, notes, created_by, updated_by)
      values (v_company, v_kind, v_code, v_name, v_ledger,
        case when v_kind = 'BANK' then private.accounting_text(p_account, 'bank_name', 120, 'Bank name') end,
        case when v_kind = 'BANK' then private.accounting_text(p_account, 'branch_name', 120, 'Branch') end,
        case when v_kind = 'BANK' then private.accounting_text(p_account, 'account_holder_name', 160, 'Account holder') end,
        case when v_kind = 'BANK' then repeat('X', greatest(length(v_number) - 4, 0)) || right(v_number, 4) end, v_fp,
        case when v_kind = 'BANK' then v_ifsc end, case when v_kind = 'BANK' then v_type end, v_obal, v_otype,
        private.accounting_date(p_account, 'opening_balance_date', 'Opening balance date'),
        private.accounting_text(p_account, 'opening_balance_reference', 200, 'Opening balance reference'), v_cust, v_neg,
        private.accounting_text(p_account, 'notes', 1000, 'Notes'), auth.uid(), auth.uid())
      returning * into b;
      if v_kind = 'BANK' then
        insert into public.bank_account_numbers (bank_cash_account_id, company_id, account_number) values (b.id, v_company, v_number);
      end if;
    else
      if v_kind = 'BANK' and v_number <> '' then
        v_fp := encode(sha256(convert_to(v_ifsc || ':' || v_number, 'UTF8')), 'hex');
        update public.bank_account_numbers set account_number = v_number, updated_at = now() where bank_cash_account_id = b.id;
      elsif v_kind = 'BANK' then
        -- Number unchanged: re-derive the fingerprint only if the IFSC changed.
        select encode(sha256(convert_to(v_ifsc || ':' || n.account_number, 'UTF8')), 'hex') into v_fp from public.bank_account_numbers n where n.bank_cash_account_id = b.id;
      end if;
      update public.bank_cash_accounts set account_code = v_code, account_name = v_name, ledger_account_id = v_ledger,
        bank_name = case when v_kind = 'BANK' then private.accounting_text(p_account, 'bank_name', 120, 'Bank name') end,
        branch_name = case when v_kind = 'BANK' then private.accounting_text(p_account, 'branch_name', 120, 'Branch') end,
        account_holder_name = case when v_kind = 'BANK' then private.accounting_text(p_account, 'account_holder_name', 160, 'Account holder') end,
        account_number_masked = case when v_kind = 'BANK' and v_number <> '' then repeat('X', greatest(length(v_number) - 4, 0)) || right(v_number, 4) else account_number_masked end,
        account_fingerprint = coalesce(v_fp, account_fingerprint), ifsc = case when v_kind = 'BANK' then v_ifsc end,
        bank_account_type = case when v_kind = 'BANK' then v_type end, opening_balance = v_obal, opening_balance_type = v_otype,
        opening_balance_date = private.accounting_date(p_account, 'opening_balance_date', 'Opening balance date'),
        opening_balance_reference = private.accounting_text(p_account, 'opening_balance_reference', 200, 'Opening balance reference'),
        custodian_user_id = v_cust, allow_negative_balance = v_neg, notes = private.accounting_text(p_account, 'notes', 1000, 'Notes'),
        updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
      where id = b.id returning * into b;
    end if;
  exception when unique_violation then
    if sqlerrm like '%fingerprint%' then
      raise exception 'This bank account (IFSC and number) is already registered and active in this company.' using errcode = '23505';
    elsif sqlerrm like '%ledger%' then
      raise exception 'Ledger % is already linked to another active bank / cash account.', a.account_code using errcode = '23505';
    elsif sqlerrm like '%code%' then
      raise exception 'Account code % is already used.', v_code using errcode = '23505';
    end if;
    raise;
  end;
  perform private.write_audit_log(v_company, case when v_new then 'bank_cash_account.created' else 'bank_cash_account.updated' end, 'bank_cash_account', b.id::text,
    jsonb_build_object('account_code', b.account_code, 'kind', b.account_kind, 'ledger', a.account_code, 'number_changed', v_number <> '',
      'allow_negative_balance', b.allow_negative_balance));
  return private.bank_account_json(b);
exception
  when invalid_text_representation then
    raise exception 'A flag or number in the account is not valid.' using errcode = '22023';
end;
$$;

create or replace function public.bank_cash_account_set_active(p_id uuid, p_active boolean, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.manage', 'cash_accounts.manage']);
  b         public.bank_cash_accounts := private.bank_account_for(v_company, p_id, 'manage');
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  begin
    update public.bank_cash_accounts set is_active = coalesce(p_active, false), updated_by = auth.uid(), updated_at = now(), row_version = row_version + 1
     where id = b.id returning * into b;
  exception when unique_violation then
    raise exception 'Another active account already uses this ledger or bank account number.' using errcode = '23505';
  end;
  perform private.write_audit_log(v_company, case when b.is_active then 'bank_cash_account.activated' else 'bank_cash_account.deactivated' end, 'bank_cash_account', b.id::text,
    jsonb_build_object('account_code', b.account_code, 'reason', left(btrim(p_reason), 500)));
  return private.bank_account_json(b);
end;
$$;

-- Full account number for an authorised user (bank_accounts.manage); every reveal is audited.
create or replace function public.bank_account_reveal_number(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_accounts.manage');
  v_number  text;
begin
  select n.account_number into v_number from public.bank_account_numbers n join public.bank_cash_accounts b on b.id = n.bank_cash_account_id
  where b.id = p_id and b.company_id = v_company;
  if v_number is null then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  perform private.write_audit_log(v_company, 'bank_cash_account.number_revealed', 'bank_cash_account', p_id::text, '{}'::jsonb);
  return v_number;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Payment / receipt account mapping
-- -----------------------------------------------------------------------------
create or replace function public.bank_payment_policies()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'accounting_settings.manage']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('direction', d.direction, 'payment_method', m.method,
      'require_selection', private.bank_payment_requires_selection(v_company, d.direction, m.method),
      'rule_account_id', r.account_id, 'rule_account_code', a.account_code, 'rule_account_name', a.account_name,
      'mapped_account_id', b.id, 'mapped_account_code', b.account_code, 'mapped_account_name', b.account_name) order by d.direction, m.ord)
    from (values ('RECEIPT', 'RECEIPT_ACCOUNT'), ('PAYMENT', 'SUPPLIER_PAYMENT_ACCOUNT')) d (direction, rule_key)
    cross join (values (1, 'BANK_TRANSFER'), (2, 'UPI'), (3, 'CHEQUE'), (4, 'CASH'), (5, 'CARD'), (6, 'DEMAND_DRAFT'), (7, 'OTHER')) m (ord, method)
    left join lateral (select private.accounting_rule_account(v_company, d.rule_key, m.method) as account_id) r on true
    left join public.accounts a on a.id = r.account_id
    left join public.bank_cash_accounts b on b.company_id = v_company and b.ledger_account_id = r.account_id and b.is_active), '[]'::jsonb);
end;
$$;

create or replace function public.bank_payment_policy_save(p_direction text, p_method text, p_require_selection boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_settings.manage');
begin
  if upper(coalesce(p_direction, '')) not in ('RECEIPT', 'PAYMENT')
     or upper(coalesce(p_method, '')) not in ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER') then
    raise exception 'Unknown direction or payment method.' using errcode = '22023';
  end if;
  insert into public.bank_payment_method_policies (company_id, direction, payment_method, require_selection, updated_by)
  values (v_company, upper(p_direction), upper(p_method), coalesce(p_require_selection, false), auth.uid())
  on conflict (company_id, direction, payment_method) do update set require_selection = excluded.require_selection, updated_by = auth.uid(), updated_at = now();
  perform private.write_audit_log(v_company, 'bank_payment_policy.saved', 'bank_payment_method_policy', upper(p_direction) || ':' || upper(p_method),
    jsonb_build_object('require_selection', coalesce(p_require_selection, false)));
  return jsonb_build_object('direction', upper(p_direction), 'payment_method', upper(p_method), 'require_selection', coalesce(p_require_selection, false));
end;
$$;

-- Customer receipts and supplier payments with how their bank / cash account is (or will be) determined.
create or replace function public.bank_payment_candidates(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'accounting_posting.manage']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := private.accounting_date(f, 'from', 'From');
  v_to      date := private.accounting_date(f, 'to', 'To');
  v_state   text := upper(nullif(f ->> 'state', ''));
begin
  return coalesce((select jsonb_agg(x order by x ->> 'date' desc, x ->> 'number' desc) from (
    select jsonb_build_object('source_type', p.source_type, 'source_id', p.id, 'number', p.number, 'date', p.d, 'party', p.party, 'payment_method', p.method,
      'amount', p.amount, 'reference', p.ref, 'payment_status', p.status, 'event_status', e.status, 'event_message', e.error_message, 'voucher_id', e.voucher_id,
      'voucher_number', v.voucher_number, 'posted_account_id', pb.id, 'posted_account_code', pb.account_code, 'posted_ledger_code', pl.account_code,
      'assigned_account_id', ab.id, 'assigned_account_code', ab.account_code, 'assignment_reason', asg.reason,
      'require_selection', private.bank_payment_requires_selection(v_company, case p.source_type when 'CUSTOMER_RECEIPT' then 'RECEIPT' else 'PAYMENT' end, p.method),
      'state', st.state) as x
    from (
      select 'CUSTOMER_RECEIPT'::text as source_type, c.id, c.receipt_number as number, c.receipt_date as d, c.payment_method as method, c.amount_received as amount,
             coalesce(c.transaction_reference, c.bank_reference) as ref, c.status, (select pp.id from public.parties pp where pp.customer_id = c.customer_id and pp.company_id = c.company_id) as party_id
      from public.customer_payments c where c.company_id = v_company and c.currency = 'INR'
      union all
      select 'SUPPLIER_PAYMENT', s.id, s.payment_number, s.payment_date, s.payment_method, s.amount, s.reference, s.status,
             (select pp.id from public.parties pp where pp.supplier_id = s.supplier_id and pp.company_id = s.company_id)
      from public.supplier_payments s where s.company_id = v_company
    ) p0
    cross join lateral (select p0.*, private.accounting_party_name(p0.party_id) as party) p
    left join public.accounting_posting_events e on e.company_id = v_company and e.source_type = p.source_type and e.source_id = p.id and e.event_action = 'POST'
    left join public.accounting_vouchers v on v.id = e.voucher_id
    left join lateral (select l.account_id from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id
                       where l.voucher_id = v.id and a.account_nature in ('BANK', 'CASH') limit 1) vl on true
    left join public.accounts pl on pl.id = vl.account_id
    left join public.bank_cash_accounts pb on pb.company_id = v_company and pb.ledger_account_id = vl.account_id and pb.is_active
    left join public.bank_payment_assignments asg on asg.source_type = p.source_type and asg.source_id = p.id and asg.status = 'ACTIVE'
    left join public.bank_cash_accounts ab on ab.id = asg.bank_cash_account_id
    cross join lateral (select case
        when v.id is not null then 'POSTED'
        when p.status = 'REVERSED' then 'REVERSED'
        when ab.id is not null then 'ASSIGNED'
        when private.bank_payment_requires_selection(v_company, case p.source_type when 'CUSTOMER_RECEIPT' then 'RECEIPT' else 'PAYMENT' end, p.method) then 'NEEDS_SELECTION'
        when private.accounting_rule_account(v_company, case p.source_type when 'CUSTOMER_RECEIPT' then 'RECEIPT_ACCOUNT' else 'SUPPLIER_PAYMENT_ACCOUNT' end, p.method) is null then 'UNMAPPED'
        else 'BY_METHOD' end as state) st
    where (v_from is null or p.d >= v_from) and (v_to is null or p.d <= v_to) and (v_state is null or st.state = v_state)
    order by p.d desc limit 1000) q), '[]'::jsonb);
end;
$$;

-- Assigns the verified bank / cash account to a receipt or payment that is not posted yet (posted payments are never rewritten;
-- correct those with a journal voucher). The posting run then uses this account instead of the payment-method rule.
create or replace function public.bank_payment_assign(p_source_type text, p_source_id uuid, p_account_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.manage', 'accounting_posting.manage']);
  v_type    text := upper(coalesce(p_source_type, ''));
  v_method  text;
  v_status  text;
  v_number  text;
  e         public.accounting_posting_events;
  b         public.bank_cash_accounts;
  v_id      uuid;
begin
  if v_type = 'CUSTOMER_RECEIPT' then
    select payment_method, status, receipt_number into v_method, v_status, v_number from public.customer_payments where id = p_source_id and company_id = v_company;
  elsif v_type = 'SUPPLIER_PAYMENT' then
    select payment_method, status, payment_number into v_method, v_status, v_number from public.supplier_payments where id = p_source_id and company_id = v_company;
  else
    raise exception 'Source type must be CUSTOMER_RECEIPT or SUPPLIER_PAYMENT.' using errcode = '22023';
  end if;
  if v_method is null then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  if v_status <> 'RECORDED' then
    raise exception 'Payment % is reversed; its account cannot be assigned.', v_number using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Record how the account was verified (at least 5 characters), e.g. the bank statement entry.' using errcode = '22023';
  end if;
  -- The posting event row is the serialization point with the posting run.
  select * into e from public.accounting_posting_events where company_id = v_company and source_type = v_type and source_id = p_source_id and event_action = 'POST' for update;
  if found and e.status = 'POSTED' then
    raise exception 'Payment % is already posted (voucher %). Posted payments are never rewritten; correct the bank / cash ledger with a journal voucher.',
      v_number, (select voucher_number from public.accounting_vouchers where id = e.voucher_id) using errcode = 'P0001';
  end if;
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company and is_active;
  if not found then
    raise exception 'Select an active bank / cash account of this company.' using errcode = '22023';
  end if;
  if v_method = 'CASH' and b.account_kind <> 'CASH' or v_method not in ('CASH', 'OTHER') and b.account_kind <> 'BANK' then
    raise exception 'A % payment must go to a % account.', lower(replace(v_method, '_', ' ')), case when v_method = 'CASH' then 'cash' else 'bank' end using errcode = 'P0001';
  end if;
  update public.bank_payment_assignments set status = 'REPLACED' where source_type = v_type and source_id = p_source_id and status = 'ACTIVE';
  insert into public.bank_payment_assignments (company_id, source_type, source_id, bank_cash_account_id, reason, assigned_by)
  values (v_company, v_type, p_source_id, b.id, left(btrim(p_reason), 500), auth.uid()) returning id into v_id;
  perform private.write_audit_log(v_company, 'bank_payment.assigned', lower(v_type), p_source_id::text,
    jsonb_build_object('number', v_number, 'account_code', b.account_code, 'reason', left(btrim(p_reason), 500)));
  return jsonb_build_object('assignment_id', v_id, 'source_type', v_type, 'source_id', p_source_id, 'number', v_number, 'account_id', b.id, 'account_code', b.account_code,
    'event_status', e.status);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Bank book / cash book (posted vouchers on the account's ledger only)
-- -----------------------------------------------------------------------------
create or replace function public.bank_cash_book(p_account_id uuid, p_from date, p_to date, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'cash_accounts.read']);
  b         public.bank_cash_accounts := private.bank_account_for(v_company, p_account_id, 'read');
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_type    text := upper(nullif(f ->> 'type', ''));
  v_state   text := upper(nullif(f ->> 'reconciliation', ''));
  v_party   uuid := private.accounting_uuid(f, 'party_id', 'Party');
  v_search  text := nullif(btrim(coalesce(f ->> 'search', '')), '');
  v_open    numeric;
  r         jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid period.' using errcode = '22023';
  end if;
  v_open := private.bank_ledger_balance(b.id, p_from - 1);
  with x as (
    select g.*, case when g.source_type = 'CUSTOMER_RECEIPT' then 'RECEIPT' when g.source_type = 'SUPPLIER_PAYMENT' then 'PAYMENT'
                     when g.source_type = 'BANK_TRANSFER' then 'TRANSFER' when g.source_type = 'BANK_STATEMENT_LINE' then 'BANK_ADJUSTMENT'
                     else g.voucher_type end as txn_type,
           private.bank_ledger_matched(g.line_id) as matched,
           v_open + sum(g.amount) over (order by g.voucher_date, g.posted_at, g.voucher_number, g.line_no) as running
    from private.bank_ledger_rows(b.id) g where g.voucher_date between p_from and p_to
  ), days as (
    select x.voucher_date as d, sum(x.debit) as dr, sum(x.credit) as cr from x group by x.voucher_date
  )
  select jsonb_build_object(
    'account', private.bank_account_json(b), 'from', p_from, 'to', p_to, 'opening_balance', v_open,
    'total_debit', coalesce((select sum(debit) from x), 0), 'total_credit', coalesce((select sum(credit) from x), 0),
    'closing_balance', v_open + coalesce((select sum(amount) from x), 0),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('line_id', x.line_id, 'voucher_id', x.voucher_id, 'voucher_number', x.voucher_number, 'date', x.voucher_date,
        'txn_type', x.txn_type, 'is_reversal', x.is_reversal, 'counterparty', x.counterparty, 'party_id', x.party_id, 'narration', x.narration, 'debit', x.debit,
        'credit', x.credit, 'balance', x.running, 'reference', x.reference, 'payment_method', x.payment_method, 'matched', x.matched,
        'reconciliation', private.bank_match_state(x.amount, x.matched)) order by x.voucher_date, x.posted_at, x.voucher_number, x.line_no)
      from x where (v_type is null or x.txn_type = v_type) and (v_state is null or private.bank_match_state(x.amount, x.matched) = v_state)
        and (v_party is null or x.party_id = v_party)
        and (v_search is null or x.voucher_number ilike '%' || v_search || '%' or x.reference ilike '%' || v_search || '%' or x.narration ilike '%' || v_search || '%')), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('date', d.d, 'opening', v_open + coalesce((select sum(dr - cr) from days p where p.d < d.d), 0),
        'receipts', d.dr, 'payments', d.cr, 'closing', v_open + (select sum(dr - cr) from days p where p.d <= d.d)) order by d.d) from days d), '[]'::jsonb))
  into r;
  return r;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Transfers (contra vouchers): Dr destination ledger / Cr source ledger; charges Dr an expense ledger / Cr source
-- -----------------------------------------------------------------------------
create or replace function private.bank_transfer_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(t) || jsonb_build_object(
    'from_account_code', fa.account_code, 'from_account_name', fa.account_name, 'from_kind', fa.account_kind,
    'to_account_code', ta.account_code, 'to_account_name', ta.account_name, 'to_kind', ta.account_kind,
    'charges_account_code', ca.account_code, 'charges_account_name', ca.account_name,
    'voucher_number', (select voucher_number from public.accounting_vouchers where id = t.voucher_id),
    'reversal_voucher_number', (select voucher_number from public.accounting_vouchers where id = t.reversal_voucher_id),
    'created_by_name', (select full_name from public.profiles where id = t.created_by),
    'posted_by_name', (select full_name from public.profiles where id = t.posted_by))
  from public.bank_transfers t join public.bank_cash_accounts fa on fa.id = t.from_account_id join public.bank_cash_accounts ta on ta.id = t.to_account_id
  left join public.accounts ca on ca.id = t.charges_account_id
  where t.id = p_id;
$$;
revoke all on function private.bank_transfer_json(uuid) from public, anon, authenticated;

create or replace function public.bank_transfer_save(p_id uuid, p_transfer jsonb, p_row_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_transfers.create');
  t         public.bank_transfers;
  v_date    date := private.accounting_date(p_transfer, 'transfer_date', 'Transfer date');
  v_from    uuid := private.accounting_uuid(p_transfer, 'from_account_id', 'Source account');
  v_to      uuid := private.accounting_uuid(p_transfer, 'to_account_id', 'Destination account');
  v_amount  numeric := private.accounting_amount(p_transfer, 'amount', 'Amount');
  v_charges numeric := private.accounting_amount(p_transfer, 'charges', 'Charges');
  v_cacc    uuid := private.accounting_uuid(p_transfer, 'charges_account_id', 'Charges ledger');
  a         public.accounts;
  v_no      bigint;
begin
  perform private.accounting_require_setup(v_company);
  if v_date is null then
    raise exception 'The transfer date is required.' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'The transfer amount must be greater than zero.' using errcode = '22023';
  end if;
  if v_from is null or v_to is null or v_from = v_to then
    raise exception 'Choose two different accounts: the source and the destination.' using errcode = '22023';
  end if;
  if (select count(*) from public.bank_cash_accounts where id in (v_from, v_to) and company_id = v_company and is_active) <> 2 then
    raise exception 'Both accounts must be active bank / cash accounts of this company.' using errcode = 'P0001';
  end if;
  if v_charges > 0 then
    select * into a from public.accounts where id = v_cacc and company_id = v_company;
    if not found or not (a.is_active and a.is_postable) or a.account_nature in ('BANK', 'CASH', 'RECEIVABLE_CONTROL', 'PAYABLE_CONTROL') or a.classification <> 'EXPENSE' then
      raise exception 'Transfer charges need an active expense ledger (e.g. Bank Charges).' using errcode = 'P0001';
    end if;
  else
    v_cacc := null;
  end if;
  if p_id is null then
    perform pg_advisory_xact_lock(hashtextextended('bank_transfer_number:' || v_company::text, 0));
    select coalesce(max(substr(transfer_number, 5)::bigint), 0) + 1 into v_no from public.bank_transfers where company_id = v_company;
    insert into public.bank_transfers (company_id, transfer_number, transfer_date, from_account_id, to_account_id, amount, charges, charges_account_id, reference, narration, created_by)
    values (v_company, 'TRF-' || lpad(v_no::text, 6, '0'), v_date, v_from, v_to, v_amount, v_charges, v_cacc,
      private.accounting_text(p_transfer, 'reference', 100, 'Reference'), private.accounting_text(p_transfer, 'narration', 500, 'Narration'), auth.uid())
    returning * into t;
  else
    select * into t from public.bank_transfers where id = p_id and company_id = v_company for update;
    if not found then
      raise exception 'Transfer not found.' using errcode = 'P0002';
    end if;
    if t.status <> 'DRAFT' then
      raise exception 'Only a draft transfer can be edited (this one is %).', lower(t.status) using errcode = 'P0001';
    end if;
    if p_row_version is not null and t.row_version <> p_row_version then
      raise exception 'This transfer was changed by someone else. Reload it and try again.' using errcode = '40001';
    end if;
    update public.bank_transfers set transfer_date = v_date, from_account_id = v_from, to_account_id = v_to, amount = v_amount, charges = v_charges, charges_account_id = v_cacc,
      reference = private.accounting_text(p_transfer, 'reference', 100, 'Reference'), narration = private.accounting_text(p_transfer, 'narration', 500, 'Narration'),
      updated_at = now(), row_version = row_version + 1
    where id = t.id returning * into t;
  end if;
  perform private.write_audit_log(v_company, case when p_id is null then 'bank_transfer.created' else 'bank_transfer.updated' end, 'bank_transfer', t.id::text,
    jsonb_build_object('transfer_number', t.transfer_number, 'amount', t.amount));
  return private.bank_transfer_json(t.id);
end;
$$;

create or replace function public.bank_transfer_post(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_transfers.post');
  t         public.bank_transfers;
  fa        public.bank_cash_accounts;
  ta        public.bank_cash_accounts;
  v_lines   jsonb;
  v_id      uuid;
  v         public.accounting_vouchers;
begin
  perform private.accounting_require_setup(v_company);
  -- Row lock: a second post of the same transfer waits here, then sees it is no longer a draft (one voucher only).
  select * into t from public.bank_transfers where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Transfer not found.' using errcode = 'P0002';
  end if;
  if t.status <> 'DRAFT' then
    raise exception 'Transfer % is already %; it cannot be posted again.', t.transfer_number, lower(t.status) using errcode = 'P0001';
  end if;
  select * into fa from public.bank_cash_accounts where id = t.from_account_id;
  select * into ta from public.bank_cash_accounts where id = t.to_account_id;
  if not (fa.is_active and ta.is_active) then
    raise exception 'Both accounts must still be active.' using errcode = 'P0001';
  end if;
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', ta.ledger_account_id, 'debit', t.amount, 'narration', 'Transfer in from ' || fa.account_name),
    jsonb_build_object('account_id', fa.ledger_account_id, 'credit', t.amount, 'narration', 'Transfer out to ' || ta.account_name));
  if t.charges > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', t.charges_account_id, 'debit', t.charges, 'narration', 'Transfer charges')
                       || jsonb_build_object('account_id', fa.ledger_account_id, 'credit', t.charges, 'narration', 'Transfer charges');
  end if;
  v_id := private.accounting_create_voucher(v_company, 'CTR', t.transfer_date, coalesce(t.reference, t.transfer_number),
    left(format('Transfer %s: %s → %s%s', t.transfer_number, fa.account_name, ta.account_name, coalesce(' — ' || t.narration, '')), 1000),
    'AUTO', 'BANK_TRANSFER', t.id, t.transfer_number, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  update public.bank_transfers set status = 'POSTED', voucher_id = v.id, posted_by = auth.uid(), posted_at = now(), updated_at = now(), row_version = row_version + 1
   where id = t.id;
  perform private.write_audit_log(v_company, 'bank_transfer.posted', 'bank_transfer', t.id::text,
    jsonb_build_object('transfer_number', t.transfer_number, 'voucher_number', v.voucher_number, 'amount', t.amount, 'charges', t.charges));
  return private.bank_transfer_json(t.id);
end;
$$;

create or replace function public.bank_transfer_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_transfers.create');
  t         public.bank_transfers;
begin
  select * into t from public.bank_transfers where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Transfer not found.' using errcode = 'P0002';
  end if;
  if t.status <> 'DRAFT' then
    raise exception 'Only a draft transfer can be cancelled; a posted one is reversed.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  update public.bank_transfers set status = 'CANCELLED', cancel_reason = left(btrim(p_reason), 500), updated_at = now(), row_version = row_version + 1 where id = t.id;
  perform private.write_audit_log(v_company, 'bank_transfer.cancelled', 'bank_transfer', t.id::text, jsonb_build_object('transfer_number', t.transfer_number, 'reason', left(btrim(p_reason), 500)));
  return private.bank_transfer_json(t.id);
end;
$$;

create or replace function public.bank_transfer_reverse(p_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_transfers.post');
  t         public.bank_transfers;
  v         public.accounting_vouchers;
begin
  select * into t from public.bank_transfers where id = p_id and company_id = v_company for update;
  if not found then
    raise exception 'Transfer not found.' using errcode = 'P0002';
  end if;
  if t.status <> 'POSTED' then
    raise exception 'Only a posted transfer can be reversed (this one is %).', lower(t.status) using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reversal reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  v := private.accounting_reverse_voucher(t.voucher_id, 'Transfer reversed: ' || btrim(p_reason), null);
  update public.bank_transfers set status = 'REVERSED', reversal_voucher_id = v.id, reversal_reason = left(btrim(p_reason), 500), reversed_by = auth.uid(), reversed_at = now(),
    updated_at = now(), row_version = row_version + 1 where id = t.id;
  perform private.write_audit_log(v_company, 'bank_transfer.reversed', 'bank_transfer', t.id::text,
    jsonb_build_object('transfer_number', t.transfer_number, 'reversal_voucher', v.voucher_number, 'reason', left(btrim(p_reason), 500)));
  return private.bank_transfer_json(t.id);
end;
$$;

create or replace function public.bank_transfer_list(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'cash_accounts.read', 'bank_transfers.create', 'bank_transfers.post']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from    date := private.accounting_date(f, 'from', 'From');
  v_to      date := private.accounting_date(f, 'to', 'To');
  v_status  text := upper(nullif(f ->> 'status', ''));
  v_acc     uuid := private.accounting_uuid(f, 'account_id', 'Account');
begin
  return coalesce((select jsonb_agg(private.bank_transfer_json(t.id) order by t.transfer_date desc, t.transfer_number desc)
    from (select * from public.bank_transfers t where t.company_id = v_company and (v_from is null or t.transfer_date >= v_from) and (v_to is null or t.transfer_date <= v_to)
            and (v_status is null or t.status = v_status) and (v_acc is null or v_acc in (t.from_account_id, t.to_account_id))
          order by t.transfer_date desc, t.transfer_number desc limit 1000) t), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Bank statement import (evidence only: never creates vouchers)
-- -----------------------------------------------------------------------------
-- p_rows: [{row_no, txn_date 'YYYY-MM-DD', value_date, description, reference, bank_txn_id, debit, credit, running_balance}] — mapped from the
-- uploaded file by the screen (the column mapping is stored with the batch). p_commit false = preview: the same validation and duplicate report,
-- nothing written. Duplicates: the same bank transaction ID, or the same date / amount / reference / description / running balance (with its
-- occurrence number inside the file, so genuinely repeated rows of one statement import once and a re-import of the file imports nothing).
create or replace function public.bank_statement_import(p_account_id uuid, p_file jsonb, p_mapping jsonb, p_rows jsonb, p_commit boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.manage');
  b         public.bank_cash_accounts;
  v_content bytea;
  v_sha     text;
  v_name    text := left(btrim(coalesce(p_file ->> 'name', '')), 255);
  e         jsonb;
  v_report  jsonb := '[]'::jsonb;
  v_ok      jsonb := '[]'::jsonb;
  v_keys    text[] := '{}';
  v_ids     text[] := '{}';
  v_tuples  text[] := '{}';
  v_row     int;
  v_d       date;
  v_vd      date;
  v_dr      numeric;
  v_cr      numeric;
  v_bal     numeric;
  v_desc    text;
  v_ref     text;
  v_txn     text;
  v_tuple   text;
  v_key     text;
  v_err     text;
  v_dup     int := 0;
  v_fail    int := 0;
  v_imp     public.bank_statement_imports;
  v_prev    timestamptz;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company;
  if not found or b.account_kind <> 'BANK' then
    raise exception 'Select a bank account of this company.' using errcode = '22023';
  end if;
  if not b.is_active then
    raise exception 'Bank account % is inactive.', b.account_code using errcode = 'P0001';
  end if;
  if v_name = '' then
    raise exception 'The file name is required.' using errcode = '22023';
  end if;
  begin
    v_content := decode(coalesce(p_file ->> 'content_base64', ''), 'base64');
  exception when others then
    raise exception 'The file content is not valid base64.' using errcode = '22023';
  end;
  if octet_length(v_content) = 0 or octet_length(v_content) > 5242880 then
    raise exception 'The statement file must be between 1 byte and 5 MB.' using errcode = '22023';
  end if;
  v_sha := encode(sha256(v_content), 'hex');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'The statement must have between 1 and 20,000 rows.' using errcode = '22023';
  end if;
  select max(imported_at) into v_prev from public.bank_statement_imports where bank_cash_account_id = b.id and file_sha256 = v_sha;

  for e in select x from jsonb_array_elements(p_rows) x loop
    v_err := null; v_d := null; v_vd := null; v_dr := 0; v_cr := 0; v_bal := null;
    v_row := coalesce(nullif(e ->> 'row_no', '')::int, jsonb_array_length(v_report) + 1);
    begin
      if coalesce(e ->> 'txn_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        v_err := 'Transaction date is missing or not a date.';
      else
        v_d := (e ->> 'txn_date')::date;
      end if;
      if v_err is null and nullif(e ->> 'value_date', '') is not null then
        if (e ->> 'value_date') !~ '^\d{4}-\d{2}-\d{2}$' then v_err := 'Value date is not a date.'; else v_vd := (e ->> 'value_date')::date; end if;
      end if;
      if v_err is null then
        for v_key in select unnest(array['debit', 'credit', 'running_balance']) loop
          if nullif(btrim(coalesce(e ->> v_key, '')), '') is not null and btrim(e ->> v_key) !~ (case when v_key = 'running_balance' then '^-?' else '^' end || '\d+(\.\d{1,2})?$') then
            v_err := initcap(replace(v_key, '_', ' ')) || ' is not an amount (2 decimals at most' || case when v_key <> 'running_balance' then ', not negative' else '' end || ').';
          end if;
        end loop;
      end if;
      if v_err is null then
        v_dr := coalesce(nullif(btrim(coalesce(e ->> 'debit', '')), '')::numeric, 0);
        v_cr := coalesce(nullif(btrim(coalesce(e ->> 'credit', '')), '')::numeric, 0);
        v_bal := nullif(btrim(coalesce(e ->> 'running_balance', '')), '')::numeric;
        if (v_dr > 0) = (v_cr > 0) then
          v_err := 'Exactly one of debit (withdrawal) and credit (deposit) must be filled.';
        end if;
      end if;
    exception when others then
      v_err := 'A date or amount could not be read.';
    end;
    v_desc := left(nullif(btrim(regexp_replace(coalesce(e ->> 'description', ''), '\s+', ' ', 'g')), ''), 500);
    v_ref := left(nullif(btrim(coalesce(e ->> 'reference', '')), ''), 120);
    v_txn := left(nullif(btrim(coalesce(e ->> 'bank_txn_id', '')), ''), 120);
    if v_err is null and v_txn is not null and upper(v_txn) = any (v_ids) then
      v_err := 'The same bank transaction ID appears twice in the file.';
    end if;
    if v_err is not null then
      v_fail := v_fail + 1;
      v_report := v_report || jsonb_build_object('row_no', v_row, 'status', 'FAILED', 'message', v_err);
      continue;
    end if;
    if v_txn is not null then
      v_ids := v_ids || upper(v_txn);
      v_key := 'ID:' || upper(v_txn);
    else
      v_tuple := concat_ws('|', v_d, v_cr - v_dr, upper(coalesce(v_ref, '')), upper(coalesce(v_desc, '')), v_bal);
      v_tuples := v_tuples || v_tuple;
      v_key := 'H:' || md5(v_tuple || '#' || (select count(*) from unnest(v_tuples) t where t = v_tuple));
    end if;
    if exists (select 1 from public.bank_statement_lines where bank_cash_account_id = b.id and dedupe_key = v_key) then
      v_dup := v_dup + 1;
      v_report := v_report || jsonb_build_object('row_no', v_row, 'status', 'DUPLICATE', 'message', 'Already imported for this account; skipped.');
      continue;
    end if;
    v_keys := v_keys || v_key;
    v_ok := v_ok || jsonb_build_object('row_no', v_row, 'txn_date', v_d, 'value_date', v_vd, 'description', v_desc, 'reference', v_ref, 'bank_txn_id', v_txn,
      'debit', v_dr, 'credit', v_cr, 'running_balance', v_bal, 'dedupe_key', v_key,
      'category', case when v_desc ~* '(charge|chrg|chgs|\mchg\M|sms|\mfee|commission|gst on)' then 'CHARGES'
                       when v_desc ~* '(interest|\mint\.?\s*(cr|pd|paid|credit))' then 'INTEREST' else 'OTHER' end);
    v_report := v_report || jsonb_build_object('row_no', v_row, 'status', 'IMPORTED', 'message', case when v_txn is null and
      (select count(*) from unnest(v_tuples) t where t = v_tuple) > 1 then 'Identical to an earlier row of this file (kept: no bank transaction ID to tell them apart).' end);
  end loop;

  if not coalesce(p_commit, false) then
    return jsonb_build_object('preview', true, 'file_name', v_name, 'file_sha256', v_sha, 'previously_imported_at', v_prev,
      'row_count', jsonb_array_length(p_rows), 'importable_count', jsonb_array_length(v_ok), 'duplicate_count', v_dup, 'failed_count', v_fail,
      'report', v_report, 'rows', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_ok) x limit 200) q));
  end if;
  if jsonb_array_length(v_ok) = 0 then
    raise exception 'Nothing new to import: % duplicate and % failed row(s).', v_dup, v_fail using errcode = 'P0001', detail = v_report::text;
  end if;
  insert into public.bank_statement_imports (company_id, bank_cash_account_id, file_name, file_sha256, file_size, mime_type, column_mapping, row_count, imported_count,
    duplicate_count, failed_count, report, statement_from, statement_to, imported_by)
  values (v_company, b.id, v_name, v_sha, octet_length(v_content), left(p_file ->> 'mime', 120), coalesce(p_mapping, '{}'::jsonb), jsonb_array_length(p_rows),
    jsonb_array_length(v_ok), v_dup, v_fail, v_report, (select min((x ->> 'txn_date')::date) from jsonb_array_elements(v_ok) x),
    (select max((x ->> 'txn_date')::date) from jsonb_array_elements(v_ok) x), auth.uid())
  returning * into v_imp;
  insert into public.bank_statement_files (import_id, company_id, content) values (v_imp.id, v_company, v_content);
  insert into public.bank_statement_lines (company_id, import_id, bank_cash_account_id, row_no, txn_date, value_date, description, reference, bank_txn_id, debit, credit,
    running_balance, dedupe_key, category)
  select v_company, v_imp.id, b.id, (x ->> 'row_no')::int, (x ->> 'txn_date')::date, (x ->> 'value_date')::date, x ->> 'description', x ->> 'reference', x ->> 'bank_txn_id',
    (x ->> 'debit')::numeric, (x ->> 'credit')::numeric, (x ->> 'running_balance')::numeric, x ->> 'dedupe_key', x ->> 'category'
  from jsonb_array_elements(v_ok) x;
  perform private.write_audit_log(v_company, 'bank_statement.imported', 'bank_statement_import', v_imp.id::text,
    jsonb_build_object('account_code', b.account_code, 'file_name', v_name, 'rows', v_imp.row_count, 'imported', v_imp.imported_count, 'duplicates', v_dup, 'failed', v_fail));
  return to_jsonb(v_imp) || jsonb_build_object('preview', false, 'previously_imported_at', v_prev);
exception
  when unique_violation then
    raise exception 'A statement line was imported concurrently; run the import again (duplicates are skipped).' using errcode = '40001';
end;
$$;

create or replace function public.bank_statement_imports_list(p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
begin
  return coalesce((select jsonb_agg(to_jsonb(i) - 'report' || jsonb_build_object('account_code', b.account_code, 'account_name', b.account_name,
      'imported_by_name', (select full_name from public.profiles where id = i.imported_by)) order by i.imported_at desc)
    from public.bank_statement_imports i join public.bank_cash_accounts b on b.id = i.bank_cash_account_id
    where i.company_id = v_company and (p_account_id is null or i.bank_cash_account_id = p_account_id)), '[]'::jsonb);
end;
$$;

create or replace function public.bank_statement_import_get(p_import_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
  r         jsonb;
begin
  select to_jsonb(i) || jsonb_build_object('account_code', b.account_code, 'account_name', b.account_name,
      'imported_by_name', (select full_name from public.profiles where id = i.imported_by),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'dedupe_key' || jsonb_build_object('matched', private.bank_stmt_matched(l.id)) order by l.row_no)
                         from public.bank_statement_lines l where l.import_id = i.id), '[]'::jsonb))
    into r
  from public.bank_statement_imports i join public.bank_cash_accounts b on b.id = i.bank_cash_account_id
  where i.id = p_import_id and i.company_id = v_company;
  if r is null then
    raise exception 'Statement import not found.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- The original statement file (base64), for an authorised user; every download is audited.
create or replace function public.bank_statement_file(p_import_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
  r         jsonb;
begin
  select jsonb_build_object('file_name', i.file_name, 'mime_type', i.mime_type, 'file_sha256', i.file_sha256, 'content_base64', encode(f.content, 'base64'))
    into r
  from public.bank_statement_imports i join public.bank_statement_files f on f.import_id = i.id
  where i.id = p_import_id and i.company_id = v_company;
  if r is null then
    raise exception 'Statement import not found.' using errcode = 'P0002';
  end if;
  perform private.write_audit_log(v_company, 'bank_statement.file_downloaded', 'bank_statement_import', p_import_id::text, '{}'::jsonb);
  return r;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Reconciliation matching (never creates vouchers). Statement and ledger amounts are signed alike: deposit / bank debit positive.
--     All matching of one bank ledger is serialized by an advisory lock on the ledger, so a line can never be matched beyond its amount.
-- -----------------------------------------------------------------------------
create or replace function private.bank_recon_lock(b public.bank_cash_accounts)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('bank_recon:' || b.ledger_account_id::text, 0));
$$;
revoke all on function private.bank_recon_lock(public.bank_cash_accounts) from public, anon, authenticated, service_role;

create or replace function public.bank_reconciliation_workspace(p_account_id uuid, p_from date, p_to date, p_include_matched boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
  b         public.bank_cash_accounts;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('account', private.bank_account_json(b), 'from', p_from, 'to', p_to,
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('line_id', g.line_id, 'voucher_id', g.voucher_id, 'voucher_number', g.voucher_number, 'date', g.voucher_date,
        'voucher_type', g.voucher_type, 'source_type', g.source_type, 'is_reversal', g.is_reversal, 'counterparty', g.counterparty, 'narration', g.narration,
        'reference', g.reference, 'payment_method', g.payment_method, 'amount', g.amount, 'matched', m.matched, 'remaining', g.amount - m.matched,
        'state', private.bank_match_state(g.amount, m.matched)) order by g.voucher_date, g.voucher_number, g.line_no)
      from private.bank_ledger_rows(b.id) g cross join lateral (select private.bank_ledger_matched(g.line_id) as matched) m
      where (p_from is null or g.voucher_date >= p_from) and (p_to is null or g.voucher_date <= p_to) and (p_include_matched or m.matched <> g.amount)), '[]'::jsonb),
    'statement', coalesce((select jsonb_agg(jsonb_build_object('line_id', s.id, 'date', s.txn_date, 'value_date', s.value_date, 'description', s.description,
        'reference', s.reference, 'bank_txn_id', s.bank_txn_id, 'amount', s.amount, 'running_balance', s.running_balance, 'category', s.category,
        'adjustment_voucher_id', s.adjustment_voucher_id, 'matched', m.matched, 'remaining', s.amount - m.matched, 'state', private.bank_match_state(s.amount, m.matched))
        order by s.txn_date, s.row_no)
      from public.bank_statement_lines s cross join lateral (select private.bank_stmt_matched(s.id) as matched) m
      where s.bank_cash_account_id = b.id and (p_from is null or s.txn_date >= p_from) and (p_to is null or s.txn_date <= p_to) and (p_include_matched or m.matched <> s.amount)), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('id', mm.id, 'method', mm.method, 'reason', mm.reason, 'total', mm.total, 'effective_date', mm.effective_date,
        'created_at', mm.created_at, 'created_by_name', (select full_name from public.profiles where id = mm.created_by),
        'items', (select jsonb_agg(jsonb_build_object('statement_line_id', i.statement_line_id, 'voucher_line_id', i.voucher_line_id, 'amount', i.amount)) from public.bank_reconciliation_match_items i where i.match_id = mm.id))
        order by mm.created_at desc)
      from public.bank_reconciliation_matches mm where mm.bank_cash_account_id = b.id and mm.status = 'ACTIVE'
        and (p_from is null or mm.effective_date >= p_from) and (p_to is null or mm.effective_date <= p_to + 31)), '[]'::jsonb));
end;
$$;

-- One-to-one proposals: unmatched statement line and unmatched ledger entry of exactly the same amount within the date tolerance.
-- Confident = the only candidate for each other, or the only one whose reference appears in the statement text.
create or replace function private.bank_recon_proposals(p_account uuid, p_tolerance int)
returns table (statement_line_id uuid, voucher_line_id uuid, amount numeric, days int, reference_match boolean, confident boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select l.id, l.txn_date, l.amount, upper(coalesce(l.description, '') || ' ' || coalesce(l.reference, '') || ' ' || coalesce(l.bank_txn_id, '')) as txt
    from public.bank_statement_lines l where l.bank_cash_account_id = p_account and private.bank_stmt_matched(l.id) = 0
  ), g as (
    select r.line_id, r.voucher_date, r.amount, upper(nullif(btrim(r.reference), '')) as ref
    from private.bank_ledger_rows(p_account) r where private.bank_ledger_matched(r.line_id) = 0
  ), c as (
    select s.id as sid, g.line_id as gid, s.amount, abs(s.txn_date - g.voucher_date) as days,
           (g.ref is not null and length(g.ref) >= 4 and position(g.ref in s.txt) > 0) as refm
    from s join g on g.amount = s.amount and abs(s.txn_date - g.voucher_date) <= greatest(coalesce(p_tolerance, 3), 0)
  )
  select c.sid, c.gid, c.amount, c.days, c.refm,
         ((select count(*) from c x where x.sid = c.sid) = 1 and (select count(*) from c x where x.gid = c.gid) = 1)
         or (c.refm and (select count(*) from c x where x.sid = c.sid and x.refm) = 1 and (select count(*) from c x where x.gid = c.gid and x.refm) = 1)
  from c;
$$;
revoke all on function private.bank_recon_proposals(uuid, int) from public, anon, authenticated;

create or replace function public.bank_reconciliation_suggestions(p_account_id uuid, p_tolerance_days integer default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
begin
  if not exists (select 1 from public.bank_cash_accounts where id = p_account_id and company_id = v_company) then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('statement_line_id', p.statement_line_id, 'voucher_line_id', p.voucher_line_id, 'amount', p.amount,
      'days', p.days, 'reference_match', p.reference_match, 'confident', p.confident) order by p.confident desc, p.reference_match desc, p.days)
    from private.bank_recon_proposals(p_account_id, p_tolerance_days) p), '[]'::jsonb);
end;
$$;

-- Inserts one match (caller holds the ledger lock and has validated the account); checks every item against the line's remainder.
create or replace function private.bank_recon_insert_match(b public.bank_cash_accounts, p_items jsonb, p_method text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e        jsonb;
  v_sid    uuid;
  v_gid    uuid;
  v_amt    numeric;
  v_line   numeric;
  v_rem    numeric;
  v_date   date;
  v_eff    date;
  v_ssum   numeric := 0;
  v_gsum   numeric := 0;
  v_ns     int := 0;
  v_ng     int := 0;
  v_seen   uuid[] := '{}';
  v_id     uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 2 or jsonb_array_length(p_items) > 200 then
    raise exception 'A match needs at least one statement line and one ledger entry.' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_items) x loop
    v_sid := private.accounting_uuid(e, 'statement_line_id', 'Statement line');
    v_gid := private.accounting_uuid(e, 'voucher_line_id', 'Ledger entry');
    if (v_sid is null) = (v_gid is null) then
      raise exception 'Each item is either a statement line or a ledger entry.' using errcode = '22023';
    end if;
    if coalesce(v_sid, v_gid) = any (v_seen) then
      raise exception 'The same line appears twice in the match.' using errcode = '22023';
    end if;
    v_seen := v_seen || coalesce(v_sid, v_gid);
    if v_sid is not null then
      select l.amount, l.txn_date into v_line, v_date from public.bank_statement_lines l where l.id = v_sid and l.bank_cash_account_id = b.id;
      if not found then
        raise exception 'A statement line does not belong to bank account %.', b.account_code using errcode = '42501';
      end if;
      v_rem := v_line - private.bank_stmt_matched(v_sid);
    else
      select r.amount, r.voucher_date into v_line, v_date from private.bank_ledger_rows(b.id) r where r.line_id = v_gid;
      if not found then
        raise exception 'A ledger entry is not a posted entry of bank account %.', b.account_code using errcode = '42501';
      end if;
      v_rem := v_line - private.bank_ledger_matched(v_gid);
    end if;
    v_amt := case when nullif(btrim(coalesce(e ->> 'amount', '')), '') is null then v_rem else (e ->> 'amount')::numeric end;
    if v_amt = 0 or v_amt <> round(v_amt, 2) or sign(v_amt) <> sign(v_line) or abs(v_amt) > abs(v_rem) then
      raise exception 'Amount % exceeds what is left to match on that line (% of %), or has the wrong sign.', v_amt, v_rem, v_line using errcode = 'P0001';
    end if;
    v_eff := greatest(v_eff, v_date);
    if v_sid is not null then v_ssum := v_ssum + v_amt; v_ns := v_ns + 1; else v_gsum := v_gsum + v_amt; v_ng := v_ng + 1; end if;
  end loop;
  if v_ns = 0 or v_ng = 0 then
    raise exception 'A match needs at least one statement line and one ledger entry.' using errcode = '22023';
  end if;
  if v_ssum <> v_gsum then
    raise exception 'The statement side (%) and the ledger side (%) must be equal; post an adjustment for the difference.', v_ssum, v_gsum using errcode = 'P0001';
  end if;
  insert into public.bank_reconciliation_matches (company_id, bank_cash_account_id, method, reason, total, effective_date, created_by)
  values (b.company_id, b.id, p_method, nullif(left(btrim(coalesce(p_reason, '')), 500), ''), v_ssum, v_eff, auth.uid()) returning id into v_id;
  insert into public.bank_reconciliation_match_items (company_id, match_id, statement_line_id, voucher_line_id, amount)
  select b.company_id, v_id, private.accounting_uuid(x, 'statement_line_id', 'Statement line'), private.accounting_uuid(x, 'voucher_line_id', 'Ledger entry'),
         coalesce(nullif(btrim(coalesce(x ->> 'amount', '')), '')::numeric,
                  case when x ? 'statement_line_id' and nullif(x ->> 'statement_line_id', '') is not null
                       then (select l.amount - private.bank_stmt_matched(l.id) from public.bank_statement_lines l where l.id = (x ->> 'statement_line_id')::uuid)
                       else (select r.amount - private.bank_ledger_matched(r.line_id) from private.bank_ledger_rows(b.id) r where r.line_id = (x ->> 'voucher_line_id')::uuid) end)
  from jsonb_array_elements(p_items) x;
  return v_id;
exception
  when invalid_text_representation then
    raise exception 'An amount in the match is not a number.' using errcode = '22023';
end;
$$;
revoke all on function private.bank_recon_insert_match(public.bank_cash_accounts, jsonb, text, text) from public, anon, authenticated, service_role;

-- Manual match: any lines of the account, amounts default to each line's remainder (partial amounts allowed); both sides must be equal.
create or replace function public.bank_reconciliation_match(p_account_id uuid, p_items jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.manage');
  b         public.bank_cash_accounts;
  v_id      uuid;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A manual match needs a reason (at least 5 characters).' using errcode = '22023';
  end if;
  perform private.bank_recon_lock(b);
  v_id := private.bank_recon_insert_match(b, p_items, 'MANUAL', p_reason);
  perform private.write_audit_log(v_company, 'bank_reconciliation.matched', 'bank_reconciliation_match', v_id::text,
    jsonb_build_object('account_code', b.account_code, 'method', 'MANUAL', 'reason', left(btrim(p_reason), 500), 'items', jsonb_array_length(p_items)));
  return jsonb_build_object('match_id', v_id);
end;
$$;

-- Confirms every confident one-to-one proposal (recomputed under the lock).
create or replace function public.bank_reconciliation_auto_match(p_account_id uuid, p_tolerance_days integer default 3)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.manage');
  b         public.bank_cash_accounts;
  p         record;
  v_n       int := 0;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  perform private.bank_recon_lock(b);
  for p in select * from private.bank_recon_proposals(b.id, p_tolerance_days) where confident loop
    perform private.bank_recon_insert_match(b, jsonb_build_array(jsonb_build_object('statement_line_id', p.statement_line_id),
      jsonb_build_object('voucher_line_id', p.voucher_line_id)), 'AUTO', null);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform private.write_audit_log(v_company, 'bank_reconciliation.auto_matched', 'bank_cash_account', b.id::text, jsonb_build_object('matches', v_n, 'tolerance_days', p_tolerance_days));
  end if;
  return jsonb_build_object('matched', v_n);
end;
$$;

create or replace function public.bank_reconciliation_unmatch(p_match_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.manage');
  m         public.bank_reconciliation_matches;
  b         public.bank_cash_accounts;
begin
  select * into m from public.bank_reconciliation_matches where id = p_match_id and company_id = v_company;
  if not found then
    raise exception 'Match not found.' using errcode = 'P0002';
  end if;
  select * into b from public.bank_cash_accounts where id = m.bank_cash_account_id;
  perform private.bank_recon_lock(b);
  select * into m from public.bank_reconciliation_matches where id = p_match_id for update;
  if m.status <> 'ACTIVE' then
    raise exception 'This match has already been reversed.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason of at least 5 characters is required.' using errcode = '22023';
  end if;
  update public.bank_reconciliation_matches set status = 'REVERSED', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = left(btrim(p_reason), 500) where id = m.id;
  perform private.write_audit_log(v_company, 'bank_reconciliation.unmatched', 'bank_reconciliation_match', m.id::text,
    jsonb_build_object('account_code', b.account_code, 'reason', left(btrim(p_reason), 500), 'total', m.total));
  return jsonb_build_object('match_id', m.id, 'status', 'REVERSED');
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Bank charges / interest from a statement line: proposed, then confirmed with a ledger by an approver; posted through the voucher engine
--     (BNK voucher, one per statement line) and matched to the line.
-- -----------------------------------------------------------------------------
create or replace function public.bank_statement_adjustment_proposal(p_line_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
  l         public.bank_statement_lines;
begin
  select * into l from public.bank_statement_lines where id = p_line_id and company_id = v_company;
  if not found then
    raise exception 'Statement line not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('line', to_jsonb(l) - 'dedupe_key', 'matched', private.bank_stmt_matched(l.id),
    'direction', case when l.amount < 0 then 'WITHDRAWAL' else 'DEPOSIT' end,
    'proposal', case when l.amount < 0 then 'Dr the chosen expense ledger / Cr the bank ledger' else 'Dr the bank ledger / Cr the chosen income ledger' end,
    'suggested_category', l.category,
    -- Unmatched ledger entries of the same amount near the date: the statement line may already be in the books (do not duplicate).
    'possible_duplicates', coalesce((select jsonb_agg(jsonb_build_object('line_id', r.line_id, 'voucher_number', r.voucher_number, 'date', r.voucher_date, 'narration', r.narration))
      from private.bank_ledger_rows(l.bank_cash_account_id) r
      where r.amount = l.amount and abs(r.voucher_date - l.txn_date) <= 7 and private.bank_ledger_matched(r.line_id) = 0), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name, 'classification', a.classification,
        'cost_centre_policy', a.cost_centre_policy) order by a.account_code)
      from public.accounts a where a.company_id = v_company and a.is_active and a.is_postable
        and a.classification = case when l.amount < 0 then 'EXPENSE' else 'INCOME' end), '[]'::jsonb));
end;
$$;

create or replace function public.bank_statement_adjust(p_line_id uuid, p_account_id uuid, p_narration text, p_allocations jsonb default null, p_duplicate_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.approve');
  l         public.bank_statement_lines;
  b         public.bank_cash_accounts;
  a         public.accounts;
  v_amt     numeric;
  v_lines   jsonb;
  v_id      uuid;
  v         public.accounting_vouchers;
  v_bankln  uuid;
  v_class   text;
  v_alloc   jsonb := case when jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then p_allocations end;
begin
  perform private.accounting_require_setup(v_company);
  select * into l from public.bank_statement_lines where id = p_line_id and company_id = v_company;
  if not found then
    raise exception 'Statement line not found.' using errcode = 'P0002';
  end if;
  select * into b from public.bank_cash_accounts where id = l.bank_cash_account_id;
  perform private.bank_recon_lock(b);
  select * into l from public.bank_statement_lines where id = p_line_id for update;
  if l.adjustment_voucher_id is not null then
    raise exception 'This statement line already has an adjustment voucher.' using errcode = 'P0001';
  end if;
  if private.bank_stmt_matched(l.id) <> 0 then
    raise exception 'This statement line is already matched to the books; unmatch it first if the match is wrong.' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.bank_ledger_rows(b.id) r where r.amount = l.amount and abs(r.voucher_date - l.txn_date) <= 7 and private.bank_ledger_matched(r.line_id) = 0)
     and length(btrim(coalesce(p_duplicate_reason, ''))) < 10 then
    raise exception 'An unmatched ledger entry of the same amount exists near this date: match it instead, or confirm this is not a duplicate with a reason (at least 10 characters).'
      using errcode = 'P0001';
  end if;
  v_class := case when l.amount < 0 then 'EXPENSE' else 'INCOME' end;
  select * into a from public.accounts where id = p_account_id and company_id = v_company;
  if not found or not (a.is_active and a.is_postable) or a.account_nature in ('BANK', 'CASH', 'RECEIVABLE_CONTROL', 'PAYABLE_CONTROL')
     or a.classification <> v_class then
    raise exception 'Choose an active % ledger (not a bank, cash or control account).', case when l.amount < 0 then 'expense' else 'income' end using errcode = 'P0001';
  end if;
  v_amt := abs(l.amount);
  if l.amount < 0 then
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', a.id, 'debit', v_amt, 'narration', coalesce(nullif(btrim(p_narration), ''), l.description)) || case when v_alloc is not null then jsonb_build_object('allocations', v_alloc) else '{}'::jsonb end,
      jsonb_build_object('account_id', b.ledger_account_id, 'credit', v_amt, 'narration', l.description));
  else
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', b.ledger_account_id, 'debit', v_amt, 'narration', l.description),
      jsonb_build_object('account_id', a.id, 'credit', v_amt, 'narration', coalesce(nullif(btrim(p_narration), ''), l.description)) || case when v_alloc is not null then jsonb_build_object('allocations', v_alloc) else '{}'::jsonb end);
  end if;
  v_id := private.accounting_create_voucher(v_company, 'BNK', l.txn_date, coalesce(l.reference, l.bank_txn_id),
    left(format('Bank %s on %s statement %s: %s', case when l.amount < 0 then 'debit' else 'credit' end, b.account_code, to_char(l.txn_date, 'DD-Mon-YYYY'),
      coalesce(nullif(btrim(p_narration), ''), l.description, '')), 1000),
    'AUTO', 'BANK_STATEMENT_LINE', l.id, b.account_code || ' row ' || l.row_no, null, v_lines);
  v := private.accounting_post_voucher(v_id);
  update public.bank_statement_lines set adjustment_voucher_id = v.id where id = l.id;
  select id into v_bankln from public.accounting_voucher_lines where voucher_id = v.id and account_id = b.ledger_account_id;
  perform private.bank_recon_insert_match(b, jsonb_build_array(jsonb_build_object('statement_line_id', l.id), jsonb_build_object('voucher_line_id', v_bankln)),
    'ADJUSTMENT', nullif(btrim(coalesce(p_duplicate_reason, '')), ''));
  perform private.write_audit_log(v_company, 'bank_statement.adjusted', 'bank_statement_line', l.id::text,
    jsonb_build_object('account_code', b.account_code, 'voucher_number', v.voucher_number, 'ledger', a.account_code, 'amount', l.amount,
      'duplicate_reason', nullif(btrim(coalesce(p_duplicate_reason, '')), '')));
  return jsonb_build_object('voucher_id', v.id, 'voucher_number', v.voucher_number, 'statement_line_id', l.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. Reconciliation statement and saved reconciliations
-- -----------------------------------------------------------------------------
-- Ledger entries / statement lines not (fully) matched as of a date, with their reconciling category.
create or replace function private.bank_outstanding_ledger(p_account uuid, p_as_of date)
returns table (line_id uuid, voucher_id uuid, voucher_number text, voucher_date date, source_type text, is_reversal boolean, counterparty text, narration text,
  reference text, payment_method text, amount numeric, remaining numeric, category text, days int)
language sql
stable
security definer
set search_path = ''
as $$
  select r.line_id, r.voucher_id, r.voucher_number, r.voucher_date, r.source_type, r.is_reversal, r.counterparty, r.narration, r.reference, r.payment_method, r.amount,
         r.amount - private.bank_ledger_matched(r.line_id, p_as_of),
         case when r.is_reversal then 'REVERSED_PAYMENT'
              when r.amount - private.bank_ledger_matched(r.line_id, p_as_of) > 0 then 'DEPOSIT_IN_TRANSIT'
              when r.payment_method in ('CHEQUE', 'DEMAND_DRAFT') then 'OUTSTANDING_CHEQUE'
              when r.payment_method = 'TRANSFER' then 'TRANSFER_PENDING'
              else 'OUTSTANDING_PAYMENT' end,
         p_as_of - r.voucher_date
  from private.bank_ledger_rows(p_account) r
  where r.voucher_date <= p_as_of and r.amount - private.bank_ledger_matched(r.line_id, p_as_of) <> 0;
$$;
create or replace function private.bank_outstanding_statement(p_account uuid, p_as_of date)
returns table (line_id uuid, txn_date date, description text, reference text, amount numeric, remaining numeric, category text, days int)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.txn_date, l.description, l.reference, l.amount, l.amount - private.bank_stmt_matched(l.id, p_as_of),
         case when l.category = 'CHARGES' and l.amount < 0 then 'CHARGES_AWAITING_ACCOUNTING'
              when l.category = 'INTEREST' then 'INTEREST_AWAITING_ACCOUNTING'
              when l.amount > 0 then 'BANK_CREDIT_NOT_IN_ERP' else 'BANK_DEBIT_NOT_IN_ERP' end,
         p_as_of - l.txn_date
  from public.bank_statement_lines l
  where l.bank_cash_account_id = p_account and l.txn_date <= p_as_of and l.amount - private.bank_stmt_matched(l.id, p_as_of) <> 0;
$$;
revoke all on function private.bank_outstanding_ledger(uuid, date) from public, anon, authenticated;
revoke all on function private.bank_outstanding_statement(uuid, date) from public, anon, authenticated;

-- Bank reconciliation statement: adjusted bank balance = statement + deposits in transit − outstanding payments;
-- adjusted book balance = ledger + bank credits not in ERP − bank debits not in ERP; difference = adjusted bank − adjusted book.
create or replace function private.bank_brs(b public.bank_cash_accounts, p_as_of date, p_statement_balance numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l   numeric := private.bank_ledger_balance(b.id, p_as_of);
  v_s   numeric := p_statement_balance;
  v_src text := 'ENTERED';
  v_d   numeric;
  v_p   numeric;
  v_c   numeric;
  v_w   numeric;
begin
  if v_s is null then
    select l.running_balance into v_s from public.bank_statement_lines l join public.bank_statement_imports i on i.id = l.import_id
    where l.bank_cash_account_id = b.id and l.txn_date <= p_as_of and l.running_balance is not null
    order by l.txn_date desc, i.imported_at desc, l.row_no desc limit 1;
    v_src := case when v_s is null then 'UNKNOWN' else 'STATEMENT' end;
  end if;
  select coalesce(sum(remaining) filter (where remaining > 0), 0), coalesce(-sum(remaining) filter (where remaining < 0), 0) into v_d, v_p
  from private.bank_outstanding_ledger(b.id, p_as_of);
  select coalesce(sum(remaining) filter (where remaining > 0), 0), coalesce(-sum(remaining) filter (where remaining < 0), 0) into v_c, v_w
  from private.bank_outstanding_statement(b.id, p_as_of);
  return jsonb_build_object('account', private.bank_account_json(b), 'as_of', p_as_of, 'ledger_balance', v_l, 'statement_balance', v_s, 'statement_balance_source', v_src,
    'outstanding_deposits', v_d, 'outstanding_payments', v_p, 'unrecorded_credits', v_c, 'unrecorded_debits', v_w,
    'adjusted_bank_balance', v_s + v_d - v_p, 'adjusted_book_balance', v_l + v_c - v_w, 'difference', (v_s + v_d - v_p) - (v_l + v_c - v_w),
    'ledger_items', coalesce((select jsonb_agg(to_jsonb(o) order by o.voucher_date, o.voucher_number) from (select * from private.bank_outstanding_ledger(b.id, p_as_of) limit 2000) o), '[]'::jsonb),
    'statement_items', coalesce((select jsonb_agg(to_jsonb(o) order by o.txn_date) from (select * from private.bank_outstanding_statement(b.id, p_as_of) limit 2000) o), '[]'::jsonb),
    'last_reconciliation', (select jsonb_build_object('as_of_date', r.as_of_date, 'status', r.status, 'difference', r.difference) from public.bank_reconciliations r
                            where r.bank_cash_account_id = b.id order by r.as_of_date desc, r.created_at desc limit 1));
end;
$$;
revoke all on function private.bank_brs(public.bank_cash_accounts, date, numeric) from public, anon, authenticated;

create or replace function public.bank_reconciliation_statement(p_account_id uuid, p_as_of date, p_statement_balance numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
  b         public.bank_cash_accounts;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company and account_kind = 'BANK';
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  return private.bank_brs(b, coalesce(p_as_of, private.company_today(v_company)), p_statement_balance);
end;
$$;

-- Saves a reconciliation as of a date: COMPLETED only when the difference is zero; otherwise an approver may accept a documented difference.
create or replace function public.bank_reconciliation_save(p_account_id uuid, p_as_of date, p_statement_balance numeric default null, p_accept_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.manage');
  b         public.bank_cash_accounts;
  r         jsonb;
  v_status  text;
  v_id      uuid;
begin
  select * into b from public.bank_cash_accounts where id = p_account_id and company_id = v_company and account_kind = 'BANK';
  if not found then
    raise exception 'Bank account not found.' using errcode = 'P0002';
  end if;
  if p_as_of is null then
    raise exception 'The reconciliation date is required.' using errcode = '22023';
  end if;
  perform private.bank_recon_lock(b);
  r := private.bank_brs(b, p_as_of, p_statement_balance);
  if r ->> 'statement_balance' is null then
    raise exception 'The statement closing balance is unknown: enter it, or import a statement with running balances.' using errcode = 'P0001';
  end if;
  if (r ->> 'difference')::numeric = 0 then
    v_status := 'COMPLETED';
  elsif length(btrim(coalesce(p_accept_reason, ''))) >= 10 then
    if not private.has_permission(v_company, 'bank_reconciliation.approve') then
      raise exception 'Accepting a reconciliation difference needs bank_reconciliation.approve.' using errcode = '42501';
    end if;
    v_status := 'ACCEPTED_DIFFERENCE';
  else
    raise exception 'Not reconciled: difference %. Match or adjust the open items, or have an approver accept the documented difference (reason of at least 10 characters).',
      to_char((r ->> 'difference')::numeric, 'FM999999999999990.00') using errcode = 'P0001';
  end if;
  insert into public.bank_reconciliations (company_id, bank_cash_account_id, as_of_date, ledger_balance, statement_balance, outstanding_deposits, outstanding_payments,
    unrecorded_credits, unrecorded_debits, adjusted_bank_balance, adjusted_book_balance, difference, status, difference_reason, details, created_by)
  values (v_company, b.id, p_as_of, (r ->> 'ledger_balance')::numeric, (r ->> 'statement_balance')::numeric, (r ->> 'outstanding_deposits')::numeric,
    (r ->> 'outstanding_payments')::numeric, (r ->> 'unrecorded_credits')::numeric, (r ->> 'unrecorded_debits')::numeric, (r ->> 'adjusted_bank_balance')::numeric,
    (r ->> 'adjusted_book_balance')::numeric, (r ->> 'difference')::numeric, v_status, case when v_status = 'ACCEPTED_DIFFERENCE' then left(btrim(p_accept_reason), 1000) end,
    jsonb_build_object('ledger_items', r -> 'ledger_items', 'statement_items', r -> 'statement_items', 'statement_balance_source', r -> 'statement_balance_source'), auth.uid())
  returning id into v_id;
  perform private.write_audit_log(v_company, 'bank_reconciliation.saved', 'bank_reconciliation', v_id::text,
    jsonb_build_object('account_code', b.account_code, 'as_of', p_as_of, 'status', v_status, 'difference', r -> 'difference'));
  return r || jsonb_build_object('id', v_id, 'status', v_status);
end;
$$;

create or replace function public.bank_reconciliation_history(p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('bank_reconciliation.read');
begin
  return coalesce((select jsonb_agg(to_jsonb(r) - 'details' || jsonb_build_object('account_code', b.account_code, 'account_name', b.account_name,
      'created_by_name', (select full_name from public.profiles where id = r.created_by)) order by r.as_of_date desc, r.created_at desc)
    from public.bank_reconciliations r join public.bank_cash_accounts b on b.id = r.bank_cash_account_id
    where r.company_id = v_company and (p_account_id is null or r.bank_cash_account_id = p_account_id)), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 15. Reports and lookups
-- -----------------------------------------------------------------------------
create or replace function public.bank_report(p_report text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'cash_accounts.read', 'bank_reconciliation.read']);
  f         jsonb := coalesce(p_filters, '{}'::jsonb);
  v_rep     text := upper(coalesce(p_report, ''));
  v_asof    date := coalesce(private.accounting_date(f, 'as_of', 'As of'), private.company_today(v_company));
  v_from    date := coalesce(private.accounting_date(f, 'from', 'From'), date '2000-01-01');
  v_to      date := coalesce(private.accounting_date(f, 'to', 'To'), private.company_today(v_company));
  v_acc     uuid := private.accounting_uuid(f, 'account_id', 'Account');
  v_bank    boolean := private.has_permission(v_company, 'bank_accounts.read');
  v_cash    boolean := private.has_permission(v_company, 'cash_accounts.read');
  v_recon   boolean := private.has_permission(v_company, 'bank_reconciliation.read');
begin
  if v_rep in ('OUTSTANDING_CHEQUES', 'DEPOSITS_IN_TRANSIT', 'OUTSTANDING_ITEMS', 'UNMATCHED_STATEMENT', 'BANK_CHARGES') and not v_recon then
    raise exception 'You are not allowed to perform this action (requires bank_reconciliation.read).' using errcode = '42501';
  end if;
  if v_rep = 'ACCOUNT_SUMMARY' then
    return jsonb_build_object('report', v_rep, 'as_of', v_asof, 'rows', coalesce((select jsonb_agg(jsonb_build_object('account_id', b.id, 'account_kind', b.account_kind,
        'account_code', b.account_code, 'account_name', b.account_name, 'bank_name', b.bank_name, 'account_number_masked', b.account_number_masked, 'is_active', b.is_active,
        'ledger_code', a.account_code, 'ledger_balance', private.bank_ledger_balance(b.id, v_asof),
        'statement_balance', (select l.running_balance from public.bank_statement_lines l where l.bank_cash_account_id = b.id and l.txn_date <= v_asof and l.running_balance is not null
                              order by l.txn_date desc, l.created_at desc, l.row_no desc limit 1),
        'unmatched_ledger', case when v_recon then (select count(*) from private.bank_outstanding_ledger(b.id, v_asof)) end,
        'unmatched_statement', case when v_recon then (select count(*) from private.bank_outstanding_statement(b.id, v_asof)) end,
        'last_reconciled', (select max(r.as_of_date) from public.bank_reconciliations r where r.bank_cash_account_id = b.id)) order by b.account_kind, b.account_code)
      from public.bank_cash_accounts b join public.accounts a on a.id = b.ledger_account_id
      where b.company_id = v_company and ((b.account_kind = 'BANK' and v_bank) or (b.account_kind = 'CASH' and v_cash)) and (v_acc is null or b.id = v_acc)), '[]'::jsonb));
  elsif v_rep in ('OUTSTANDING_CHEQUES', 'DEPOSITS_IN_TRANSIT', 'OUTSTANDING_ITEMS') then
    return jsonb_build_object('report', v_rep, 'as_of', v_asof, 'rows', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('account_code', b.account_code,
        'account_name', b.account_name) order by o.voucher_date, o.voucher_number)
      from public.bank_cash_accounts b cross join lateral private.bank_outstanding_ledger(b.id, v_asof) o
      where b.company_id = v_company and b.account_kind = 'BANK' and (v_acc is null or b.id = v_acc)
        and (v_rep = 'OUTSTANDING_ITEMS' or (v_rep = 'OUTSTANDING_CHEQUES' and o.category = 'OUTSTANDING_CHEQUE')
             or (v_rep = 'DEPOSITS_IN_TRANSIT' and o.category = 'DEPOSIT_IN_TRANSIT'))), '[]'::jsonb));
  elsif v_rep = 'UNMATCHED_STATEMENT' then
    return jsonb_build_object('report', v_rep, 'as_of', v_asof, 'rows', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('account_code', b.account_code,
        'account_name', b.account_name) order by o.txn_date)
      from public.bank_cash_accounts b cross join lateral private.bank_outstanding_statement(b.id, v_asof) o
      where b.company_id = v_company and (v_acc is null or b.id = v_acc)), '[]'::jsonb));
  elsif v_rep = 'BANK_CHARGES' then
    return jsonb_build_object('report', v_rep, 'from', v_from, 'to', v_to,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('account_code', b.account_code, 'date', l.txn_date, 'description', l.description, 'amount', l.amount,
          'category', l.category, 'state', case when l.adjustment_voucher_id is not null then 'POSTED' when private.bank_stmt_matched(l.id) <> 0 then 'MATCHED' else 'AWAITING_ACCOUNTING' end,
          'voucher_number', (select voucher_number from public.accounting_vouchers where id = l.adjustment_voucher_id),
          'ledger', (select a.account_code || ' ' || a.account_name from public.accounting_voucher_lines vl join public.accounts a on a.id = vl.account_id
                     where vl.voucher_id = l.adjustment_voucher_id and vl.account_id <> b.ledger_account_id limit 1)) order by l.txn_date)
        from public.bank_statement_lines l join public.bank_cash_accounts b on b.id = l.bank_cash_account_id
        where l.company_id = v_company and (v_acc is null or b.id = v_acc) and l.txn_date between v_from and v_to
          and (l.category in ('CHARGES', 'INTEREST') or l.adjustment_voucher_id is not null)), '[]'::jsonb));
  elsif v_rep = 'TRANSFER_REGISTER' then
    return jsonb_build_object('report', v_rep, 'from', v_from, 'to', v_to, 'rows', coalesce((select jsonb_agg(private.bank_transfer_json(t.id) order by t.transfer_date, t.transfer_number)
      from public.bank_transfers t where t.company_id = v_company and t.transfer_date between v_from and v_to and (v_acc is null or v_acc in (t.from_account_id, t.to_account_id))), '[]'::jsonb));
  elsif v_rep = 'CASH_POSITION' then
    if not v_cash then
      raise exception 'You are not allowed to perform this action (requires cash_accounts.read).' using errcode = '42501';
    end if;
    return jsonb_build_object('report', v_rep, 'as_of', v_asof, 'rows', coalesce((select jsonb_agg(jsonb_build_object('account_id', b.id, 'account_code', b.account_code,
        'account_name', b.account_name, 'custodian', (select full_name from public.profiles where id = b.custodian_user_id), 'is_active', b.is_active,
        'balance', private.bank_ledger_balance(b.id, v_asof), 'allow_negative_balance', b.allow_negative_balance,
        'receipts_today', (select coalesce(sum(r.debit), 0) from private.bank_ledger_rows(b.id) r where r.voucher_date = v_asof),
        'payments_today', (select coalesce(sum(r.credit), 0) from private.bank_ledger_rows(b.id) r where r.voucher_date = v_asof)) order by b.account_code)
      from public.bank_cash_accounts b where b.company_id = v_company and b.account_kind = 'CASH' and (v_acc is null or b.id = v_acc)), '[]'::jsonb));
  end if;
  raise exception 'Unknown report %.', p_report using errcode = '22023';
end;
$$;

create or replace function public.bank_lookups()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['bank_accounts.read', 'cash_accounts.read', 'bank_reconciliation.read', 'bank_transfers.create']);
  v_manage  boolean := private.has_permission(v_company, 'bank_accounts.manage') or private.has_permission(v_company, 'cash_accounts.manage');
begin
  return jsonb_build_object(
    'initialized', exists (select 1 from public.accounting_settings where company_id = v_company),
    'today', private.company_today(v_company),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'account_kind', b.account_kind, 'account_code', b.account_code, 'account_name', b.account_name,
        'bank_name', b.bank_name, 'account_number_masked', b.account_number_masked, 'ledger_account_id', b.ledger_account_id, 'is_active', b.is_active,
        'allow_negative_balance', b.allow_negative_balance) order by b.account_kind, b.account_code)
      from public.bank_cash_accounts b where b.company_id = v_company), '[]'::jsonb),
    -- Ledgers a new account may link to (BANK / CASH nature, postable, active, not linked to an active account).
    'ledgers', case when v_manage then coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name,
        'account_nature', a.account_nature, 'linked', exists (select 1 from public.bank_cash_accounts b where b.ledger_account_id = a.id and b.is_active)) order by a.account_code)
      from public.accounts a where a.company_id = v_company and a.account_nature in ('BANK', 'CASH') and a.is_active and a.is_postable), '[]'::jsonb) else '[]'::jsonb end,
    'expense_ledgers', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'account_code', a.account_code, 'account_name', a.account_name,
        'cost_centre_policy', a.cost_centre_policy) order by a.account_code)
      from public.accounts a where a.company_id = v_company and a.classification = 'EXPENSE' and a.is_active and a.is_postable), '[]'::jsonb),
    'users', case when v_manage then coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', coalesce(p.full_name, 'User')) order by p.full_name)
      from public.profiles p where p.company_id = v_company and p.is_active), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;


-- -----------------------------------------------------------------------------
-- 16. Existing functions extended (each is its latest text plus marked Phase 4 lines): automatic posting (per-payment account),
--     chart seed (CTR / BNK voucher types) and the ERP reset registries.
-- -----------------------------------------------------------------------------
create or replace function private.accounting_build_event(p_event public.accounting_posting_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c         uuid := p_event.company_id;
  v_lines   jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_party   uuid;
  v_acc     jsonb := '{}'::jsonb;
  v_need    text[][];
  v_k       text[];
  v_id      uuid;
  inv       public.sales_invoices;
  pay       public.customer_payments;
  note      public.invoice_adjustment_notes;
  spay      public.supplier_payments;
  grn       public.goods_receipts;
  v_cur     text;
  v_payable numeric;
  v_net     numeric;
  v_gst     numeric;
  v_check   numeric;
  v_type    text;
  v_date    date;
  v_ref     text;
  v_narr    text;
  v_assigned uuid;  -- Phase 4
begin
  if p_event.source_type = 'SALES_INVOICE' then
    select * into inv from public.sales_invoices where id = p_event.source_id and company_id = c;
    if not found or inv.status not in ('ISSUED', 'CANCELLED') then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_ISSUED', 'message', 'The invoice is not issued.');
    end if;
    if inv.currency <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Invoice currency %s: only INR documents are posted until a currency design is approved.', inv.currency));
    end if;
    if inv.grand_total = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'The invoice total is zero.');
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = inv.customer_id;
    v_need := array[array['DEBTORS', ''], array['SALES', '']];
    if inv.cgst_total <> 0 then v_need := v_need || array[array['OUTPUT_CGST', '']]; end if;
    if inv.sgst_total <> 0 then v_need := v_need || array[array['OUTPUT_SGST', '']]; end if;
    if inv.igst_total <> 0 then v_need := v_need || array[array['OUTPUT_IGST', '']]; end if;
    if inv.round_off <> 0 then v_need := v_need || array[array['ROUND_OFF', '']]; end if;
    v_type := 'SAL'; v_date := inv.invoice_date; v_ref := inv.invoice_number;
    v_narr := format('Sales invoice %s — %s', inv.invoice_number, inv.customer_legal_name);
  elsif p_event.source_type = 'CUSTOMER_RECEIPT' then
    select * into pay from public.customer_payments where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The receipt no longer exists.');
    end if;
    if pay.currency <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Receipt currency %s: only INR documents are posted.', pay.currency));
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = pay.customer_id;
    v_need := array[array['RECEIPT_ACCOUNT', pay.payment_method], array['DEBTORS', '']];
    v_type := 'RCT'; v_date := pay.receipt_date; v_ref := pay.receipt_number;
    v_narr := format('Customer receipt %s (%s)%s', pay.receipt_number, replace(lower(pay.payment_method), '_', ' '),
                     coalesce(' ref ' || pay.transaction_reference, ''));
  elsif p_event.source_type in ('CREDIT_NOTE', 'DEBIT_NOTE') then
    select * into note from public.invoice_adjustment_notes where id = p_event.source_id and company_id = c;
    if not found or note.status not in ('ISSUED', 'CANCELLED') then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_ISSUED', 'message', 'The note is not issued.');
    end if;
    select currency into v_cur from public.sales_invoices where id = note.original_invoice_id;
    if v_cur <> 'INR' then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'UNSUPPORTED_CURRENCY', 'message', format('Note currency %s: only INR documents are posted.', v_cur));
    end if;
    if note.total_amount = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'The note total is zero.');
    end if;
    if least(note.cgst_amount, note.sgst_amount, note.igst_amount) < 0 then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'NEGATIVE_TAX', 'message', 'The note has a negative tax amount; post it by journal voucher after review.');
    end if;
    select id into v_party from public.parties where company_id = c and customer_id = note.customer_id;
    v_need := array[array['DEBTORS', ''], array[case when note.note_type = 'CREDIT' then 'SALES_RETURNS' else 'SALES' end, '']];
    if note.cgst_amount <> 0 then v_need := v_need || array[array['OUTPUT_CGST', '']]; end if;
    if note.sgst_amount <> 0 then v_need := v_need || array[array['OUTPUT_SGST', '']]; end if;
    if note.igst_amount <> 0 then v_need := v_need || array[array['OUTPUT_IGST', '']]; end if;
    v_type := case when note.note_type = 'CREDIT' then 'CRN' else 'DBN' end; v_date := note.note_date; v_ref := note.note_number;
    v_narr := format('%s note %s against invoice %s — %s', initcap(note.note_type), note.note_number,
                     (select invoice_number from public.sales_invoices where id = note.original_invoice_id), note.reason);
  elsif p_event.source_type = 'SUPPLIER_PAYMENT' then
    select * into spay from public.supplier_payments where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The supplier payment no longer exists.');
    end if;
    select id into v_party from public.parties where company_id = c and supplier_id = spay.supplier_id;
    v_need := array[array['CREDITORS', ''], array['SUPPLIER_PAYMENT_ACCOUNT', spay.payment_method]];
    v_type := 'PMT'; v_date := spay.payment_date; v_ref := spay.payment_number;
    v_narr := format('Supplier payment %s (%s)%s', spay.payment_number, replace(lower(spay.payment_method), '_', ' '), coalesce(' ref ' || spay.reference, ''));
  elsif p_event.source_type = 'GOODS_RECEIPT' then
    select * into grn from public.goods_receipts where id = p_event.source_id and company_id = c;
    if not found then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NOT_FOUND', 'message', 'The goods receipt no longer exists.');
    end if;
    if grn.supplier_id is null then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'NO_SUPPLIER', 'message', 'Direct receipt without a supplier: the ERP records no payable for it.');
    end if;
    -- Payable value exactly as the ERP computes it; net / GST split per line (GST = payable - net, so it balances to the paisa).
    select coalesce(sum(x.payable), 0), coalesce(sum(x.net), 0) into v_payable, v_net
    from (
      select y.payable,
             case when y.purchase_order_line_id is not null then
                    case when coalesce(y.line_total, 0) > 0 then round(y.payable * y.taxable_value / y.line_total, 2) else y.payable end
                  else round(y.payable * 100 / (100 + coalesce(y.gst_rate, 0)), 2) end as net
      from (select coalesce(l.line_value, private.grn_line_value(l.accepted_quantity, pol.ordered_quantity, pol.line_total), 0) as payable,
                   l.purchase_order_line_id, l.gst_rate, pol.taxable_value, pol.line_total
            from public.goods_receipt_lines l left join public.purchase_order_lines pol on pol.id = l.purchase_order_line_id
            where l.goods_receipt_id = grn.id) y
    ) x;
    v_check := private.goods_receipt_value(grn.id);
    if v_payable <> v_check then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'PAYABLE_MISMATCH', 'message', format('Line payable %s differs from the ERP payable %s.', v_payable, v_check));
    end if;
    if v_payable = 0 then
      return jsonb_build_object('outcome', 'SKIP', 'code', 'ZERO_VALUE', 'message', 'Nothing was accepted on this receipt (no payable).');
    end if;
    v_gst := v_payable - v_net;
    if v_gst < 0 or v_net < 0 then
      return jsonb_build_object('outcome', 'FAIL', 'code', 'GST_SPLIT_NEGATIVE', 'message', 'The net / GST split of this receipt is negative; review it and post by journal voucher.');
    end if;
    select id into v_party from public.parties where company_id = c and supplier_id = grn.supplier_id;
    v_need := array[array['CREDITORS', ''], array['PURCHASES', '']];
    if v_gst <> 0 then v_need := v_need || array[array['GST_INPUT_PENDING', '']]; end if;
    v_type := 'PUR'; v_date := grn.receipt_date; v_ref := grn.receipt_number;
    v_narr := format('Goods receipt %s%s', grn.receipt_number, coalesce(' — supplier document ' || grn.supplier_document_number, ''));
  else
    return jsonb_build_object('outcome', 'FAIL', 'code', 'UNKNOWN_SOURCE', 'message', 'Unknown source type.');
  end if;

  if v_party is null then
    return jsonb_build_object('outcome', 'FAIL', 'code', 'NO_PARTY', 'message', 'The customer / supplier has no ledger party. Open Ledger once (it creates missing parties) and retry.');
  end if;
  -- Phase 4: the verified bank / cash account of this receipt / payment (Bank & Cash > Payment accounts) replaces the payment-method
  -- rule; methods set to "choose per payment" wait here until one is assigned (never the first bank account by default).
  if p_event.source_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT') then
    v_assigned := private.bank_payment_assigned_ledger(p_event.source_type, p_event.source_id);
    if v_assigned is not null then
      v_need := case when p_event.source_type = 'CUSTOMER_RECEIPT' then array[array['DEBTORS', '']] else array[array['CREDITORS', '']] end;
      v_acc := jsonb_build_object(case when p_event.source_type = 'CUSTOMER_RECEIPT' then 'RECEIPT_ACCOUNT' else 'SUPPLIER_PAYMENT_ACCOUNT' end, v_assigned);
    elsif private.bank_payment_requires_selection(c, case when p_event.source_type = 'CUSTOMER_RECEIPT' then 'RECEIPT' else 'PAYMENT' end,
                                                  coalesce(pay.payment_method, spay.payment_method)) then
      return jsonb_build_object('outcome', 'MAPPING', 'code', 'NEEDS_ACCOUNT_MAPPING',
        'message', format('Choose the bank / cash account of %s in Accounts > Payment accounts: %s %s are assigned one by one.', v_ref,
          replace(lower(coalesce(pay.payment_method, spay.payment_method)), '_', ' '), case when p_event.source_type = 'CUSTOMER_RECEIPT' then 'receipts' else 'payments' end));
    end if;
  end if;
  foreach v_k slice 1 in array v_need loop
    v_id := private.accounting_rule_account(c, v_k[1], v_k[2]);
    if v_id is null then
      v_missing := v_missing || private.accounting_rule_label(v_k[1], v_k[2]);
    else
      v_acc := v_acc || jsonb_build_object(v_k[1], v_id);
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('outcome', 'MAPPING', 'code', 'NEEDS_ACCOUNT_MAPPING',
      'message', 'Map an active account in Accounting Settings > Posting rules for: ' || array_to_string(v_missing, ', ') || '.');
  end if;

  if p_event.source_type = 'SALES_INVOICE' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'debit', inv.grand_total));
    if inv.taxable_subtotal <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES', 'credit', inv.taxable_subtotal); end if;
    if inv.cgst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'credit', inv.cgst_total); end if;
    if inv.sgst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'credit', inv.sgst_total); end if;
    if inv.igst_total <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'credit', inv.igst_total); end if;
    if inv.round_off > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'ROUND_OFF', 'credit', inv.round_off); end if;
    if inv.round_off < 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'ROUND_OFF', 'debit', -inv.round_off); end if;
  elsif p_event.source_type = 'CUSTOMER_RECEIPT' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'RECEIPT_ACCOUNT', 'debit', pay.amount_received),
                                 jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'credit', pay.amount_received));
  elsif p_event.source_type = 'CREDIT_NOTE' then
    v_lines := '[]'::jsonb;
    if note.taxable_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES_RETURNS', 'debit', note.taxable_amount); end if;
    if note.cgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'debit', note.cgst_amount); end if;
    if note.sgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'debit', note.sgst_amount); end if;
    if note.igst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'debit', note.igst_amount); end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'credit', note.total_amount);
  elsif p_event.source_type = 'DEBIT_NOTE' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'DEBTORS', 'party_id', v_party, 'debit', note.total_amount));
    if note.taxable_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'SALES', 'credit', note.taxable_amount); end if;
    if note.cgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_CGST', 'credit', note.cgst_amount); end if;
    if note.sgst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_SGST', 'credit', note.sgst_amount); end if;
    if note.igst_amount <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'OUTPUT_IGST', 'credit', note.igst_amount); end if;
  elsif p_event.source_type = 'SUPPLIER_PAYMENT' then
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'CREDITORS', 'party_id', v_party, 'debit', spay.amount),
                                 jsonb_build_object('account_id', v_acc ->> 'SUPPLIER_PAYMENT_ACCOUNT', 'credit', spay.amount));
  else
    v_lines := jsonb_build_array(jsonb_build_object('account_id', v_acc ->> 'PURCHASES', 'debit', v_net));
    if v_gst <> 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'GST_INPUT_PENDING', 'debit', v_gst); end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_acc ->> 'CREDITORS', 'party_id', v_party, 'credit', v_payable);
  end if;
  return jsonb_build_object('outcome', 'POST', 'type', v_type, 'date', v_date, 'reference', v_ref, 'narration', left(v_narr, 1000), 'lines', v_lines);
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
end;
$$;

create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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
-- 17. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.bank_cash_account_list(text, boolean)',
    'public.bank_cash_account_save(uuid, jsonb, integer)',
    'public.bank_cash_account_set_active(uuid, boolean, text)',
    'public.bank_account_reveal_number(uuid)',
    'public.bank_payment_policies()',
    'public.bank_payment_policy_save(text, text, boolean)',
    'public.bank_payment_candidates(jsonb)',
    'public.bank_payment_assign(text, uuid, uuid, text)',
    'public.bank_cash_book(uuid, date, date, jsonb)',
    'public.bank_transfer_save(uuid, jsonb, integer)',
    'public.bank_transfer_post(uuid)',
    'public.bank_transfer_cancel(uuid, text)',
    'public.bank_transfer_reverse(uuid, text)',
    'public.bank_transfer_list(jsonb)',
    'public.bank_statement_import(uuid, jsonb, jsonb, jsonb, boolean)',
    'public.bank_statement_imports_list(uuid)',
    'public.bank_statement_import_get(uuid)',
    'public.bank_statement_file(uuid)',
    'public.bank_reconciliation_workspace(uuid, date, date, boolean)',
    'public.bank_reconciliation_suggestions(uuid, integer)',
    'public.bank_reconciliation_match(uuid, jsonb, text)',
    'public.bank_reconciliation_auto_match(uuid, integer)',
    'public.bank_reconciliation_unmatch(uuid, text)',
    'public.bank_statement_adjustment_proposal(uuid)',
    'public.bank_statement_adjust(uuid, uuid, text, jsonb, text)',
    'public.bank_reconciliation_statement(uuid, date, numeric)',
    'public.bank_reconciliation_save(uuid, date, numeric, text)',
    'public.bank_reconciliation_history(uuid)',
    'public.bank_report(text, jsonb)',
    'public.bank_lookups()'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
