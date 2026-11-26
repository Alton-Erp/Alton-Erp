-- =============================================================================
-- ALTON ACCOUNTS — Phase 2: cost centre management
--
-- Additive, on the Phase 0 / Phase 1 accounting module (20261231090000, 20261231090100).
-- No table is recreated; existing rows are kept.
--
--   cost centre master   accounting_cost_centres gains cost_centre_type and effective dates
--                        (configurable hierarchy; nothing about Alton's departments is hard-coded)
--   allocation rule      accounts.cost_centre_policy REQUIRED | OPTIONAL | NOT_APPLICABLE
--                        (control accounts are NOT_APPLICABLE; everything else starts OPTIONAL)
--   allocations          accounting_cost_allocations: one voucher line split over one or more cost
--                        centres; the split must equal the line amount exactly (NUMERIC, paise)
--   budgets              accounting_budgets (versioned, DRAFT -> APPROVED -> SUPERSEDED / CANCELLED),
--                        accounting_budget_lines (annual + 12 monthly amounts per cost centre and
--                        account), accounting_budget_history (append-only approval history)
--   reports              cost centre summary, ledger, profitability, budget vs actual; cost-centre
--                        filters on the general ledger, day book and voucher register
--
-- Rules
--   * Allocations change only while their voucher is a DRAFT (guard trigger, every role). Posted and
--     reversed vouchers' allocations are immutable; a reversal copies the original allocations onto
--     the opposite lines, so the cost centre nets to zero exactly.
--   * Posting checks the account's rule: REQUIRED needs allocations (automatic postings without
--     cost-centre information fail and are flagged in the Posting Monitor — never guessed), NOT_APPLICABLE
--     refuses them, OPTIONAL accepts either. Opening-balance vouchers are not checked for REQUIRED.
--   * Allocations are analysis only: no extra voucher lines, so company-wide debit and credit totals and
--     the trial balance are unchanged. Budgets never create vouchers.
--   * Automatic postings get no cost centre: no ERP source document carries reliable department data.
--
-- Rollback: supabase/rollback/20261231090200_accounting_cost_centres_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Permissions (cost centres keep using accounts.read / accounts.manage)
-- -----------------------------------------------------------------------------
insert into public.permissions (resource, action, description) values
  ('accounting_budgets', 'read',    'View cost centre budgets and budget versus actual'),
  ('accounting_budgets', 'manage',  'Create, import, revise and cancel cost centre budgets'),
  ('accounting_budgets', 'approve', 'Approve cost centre budgets')
on conflict (code) do nothing;

with matrix (role_code, permission_code) as (
  values ('ACCOUNTS_MANAGER', 'accounting_budgets.read'), ('ACCOUNTS_MANAGER', 'accounting_budgets.manage'), ('ACCOUNTS_MANAGER', 'accounting_budgets.approve'),
         ('ADMIN', 'accounting_budgets.read'), ('MANAGEMENT_VIEWER', 'accounting_budgets.read')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m join public.roles r on r.code = m.role_code join public.permissions p on p.code = m.permission_code
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p where r.code = 'SUPER_ADMIN'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Columns on existing tables (additive)
-- -----------------------------------------------------------------------------
alter table public.accounting_cost_centres add column if not exists cost_centre_type text not null default 'DEPARTMENT';
alter table public.accounting_cost_centres add column if not exists effective_from date;
alter table public.accounting_cost_centres add column if not exists effective_to date;
alter table public.accounts add column if not exists cost_centre_policy text not null default 'OPTIONAL';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounting_cost_centres_type_check') then
    alter table public.accounting_cost_centres add constraint accounting_cost_centres_type_check check (cost_centre_type in
      ('DEPARTMENT', 'PRODUCTION', 'SERVICE', 'SALES', 'ADMINISTRATION', 'WAREHOUSE', 'PROJECT', 'BRANCH', 'OTHER'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounting_cost_centres_effective_check') then
    alter table public.accounting_cost_centres add constraint accounting_cost_centres_effective_check
      check (effective_from is null or effective_to is null or effective_to >= effective_from);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'accounts_cost_centre_policy_check') then
    -- Control accounts are posted automatically and party-wise: never allocated.
    update public.accounts set cost_centre_policy = 'NOT_APPLICABLE' where is_control and cost_centre_policy <> 'NOT_APPLICABLE';
    alter table public.accounts add constraint accounts_cost_centre_policy_check check (cost_centre_policy in ('REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE')
      and (not is_control or cost_centre_policy = 'NOT_APPLICABLE'));
  end if;
  -- Lets an allocation reference its line, voucher and company together (company-safe foreign key).
  if not exists (select 1 from pg_constraint where conname = 'accounting_voucher_lines_id_voucher_company_unique') then
    alter table public.accounting_voucher_lines add constraint accounting_voucher_lines_id_voucher_company_unique unique (id, voucher_id, company_id);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. New tables
-- -----------------------------------------------------------------------------
create table if not exists public.accounting_cost_allocations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete restrict,
  voucher_id      uuid not null,
  voucher_line_id uuid not null,
  cost_centre_id  uuid not null,
  amount          numeric(18,2) not null check (amount > 0),
  created_at      timestamptz not null default now(),
  -- One row per cost centre per line (split over several cost centres, never the same one twice).
  constraint accounting_cost_allocations_unique unique (voucher_line_id, cost_centre_id),
  constraint accounting_cost_allocations_line_fk foreign key (voucher_line_id, voucher_id, company_id)
    references public.accounting_voucher_lines (id, voucher_id, company_id) on delete restrict,
  constraint accounting_cost_allocations_voucher_fk foreign key (voucher_id, company_id) references public.accounting_vouchers (id, company_id) on delete restrict,
  constraint accounting_cost_allocations_centre_fk foreign key (cost_centre_id, company_id)
    references public.accounting_cost_centres (id, company_id) on delete restrict
);
create index if not exists accounting_cost_allocations_centre_idx on public.accounting_cost_allocations (company_id, cost_centre_id);
create index if not exists accounting_cost_allocations_voucher_idx on public.accounting_cost_allocations (voucher_id);

create table if not exists public.accounting_budgets (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete restrict,
  financial_year        text not null check (financial_year ~ '^[0-9]{4}(-[0-9]{2})?$'),
  fy_start              date not null,
  version               integer not null check (version between 1 and 999),
  budget_name           text not null check (length(btrim(budget_name)) between 2 and 120),
  status                text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'SUPERSEDED', 'CANCELLED')),
  notes                 text check (notes is null or length(notes) <= 1000),
  source                text not null default 'MANUAL' check (source in ('MANUAL', 'IMPORT', 'REVISION')),
  file_name             text check (file_name is null or length(file_name) <= 200),
  revision_of_budget_id uuid,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  approved_by           uuid,
  approved_at           timestamptz,
  superseded_at         timestamptz,
  cancelled_by          uuid,
  cancelled_at          timestamptz,
  cancel_reason         text check (cancel_reason is null or length(cancel_reason) <= 500),
  constraint accounting_budgets_version_unique unique (company_id, financial_year, version),
  constraint accounting_budgets_id_company_unique unique (id, company_id),
  constraint accounting_budgets_revision_fk foreign key (revision_of_budget_id, company_id) references public.accounting_budgets (id, company_id) on delete restrict,
  constraint accounting_budgets_approved_state check ((status in ('APPROVED', 'SUPERSEDED')) = (approved_at is not null)),
  constraint accounting_budgets_cancelled_state check ((status = 'CANCELLED') = (cancelled_at is not null))
);
-- One approved budget per financial year.
create unique index if not exists accounting_budgets_one_approved on public.accounting_budgets (company_id, financial_year) where status = 'APPROVED';

create table if not exists public.accounting_budget_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete restrict,
  budget_id      uuid not null,
  line_no        integer not null check (line_no between 1 and 20000),
  cost_centre_id uuid not null,
  account_id     uuid not null,
  annual_amount  numeric(18,2) not null check (annual_amount >= 0),
  m01 numeric(18,2) not null default 0 check (m01 >= 0), m02 numeric(18,2) not null default 0 check (m02 >= 0),
  m03 numeric(18,2) not null default 0 check (m03 >= 0), m04 numeric(18,2) not null default 0 check (m04 >= 0),
  m05 numeric(18,2) not null default 0 check (m05 >= 0), m06 numeric(18,2) not null default 0 check (m06 >= 0),
  m07 numeric(18,2) not null default 0 check (m07 >= 0), m08 numeric(18,2) not null default 0 check (m08 >= 0),
  m09 numeric(18,2) not null default 0 check (m09 >= 0), m10 numeric(18,2) not null default 0 check (m10 >= 0),
  m11 numeric(18,2) not null default 0 check (m11 >= 0), m12 numeric(18,2) not null default 0 check (m12 >= 0),
  notes          text check (notes is null or length(notes) <= 300),
  created_at     timestamptz not null default now(),
  -- Monthly budgets always add up to the annual budget.
  constraint accounting_budget_lines_months check (annual_amount = m01 + m02 + m03 + m04 + m05 + m06 + m07 + m08 + m09 + m10 + m11 + m12),
  constraint accounting_budget_lines_unique unique (budget_id, cost_centre_id, account_id),
  constraint accounting_budget_lines_no_unique unique (budget_id, line_no),
  constraint accounting_budget_lines_budget_fk foreign key (budget_id, company_id) references public.accounting_budgets (id, company_id) on delete restrict,
  constraint accounting_budget_lines_centre_fk foreign key (cost_centre_id, company_id) references public.accounting_cost_centres (id, company_id) on delete restrict,
  constraint accounting_budget_lines_account_fk foreign key (account_id, company_id) references public.accounts (id, company_id) on delete restrict
);
create index if not exists accounting_budget_lines_centre_idx on public.accounting_budget_lines (cost_centre_id);

create table if not exists public.accounting_budget_history (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete restrict,
  budget_id   uuid not null,
  action      text not null check (action in ('CREATED', 'LINES_SAVED', 'IMPORTED', 'APPROVED', 'SUPERSEDED', 'REVISED', 'CANCELLED')),
  note        text check (note is null or length(note) <= 1000),
  details     jsonb not null default '{}'::jsonb,
  actor_id    uuid,
  created_at  timestamptz not null default now(),
  constraint accounting_budget_history_budget_fk foreign key (budget_id, company_id) references public.accounting_budgets (id, company_id) on delete restrict
);
create index if not exists accounting_budget_history_budget_idx on public.accounting_budget_history (budget_id, created_at);

do $$
declare
  t text;
begin
  foreach t in array array['accounting_cost_allocations', 'accounting_budgets', 'accounting_budget_lines', 'accounting_budget_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

drop policy if exists accounting_cost_allocations_select on public.accounting_cost_allocations;
create policy accounting_cost_allocations_select on public.accounting_cost_allocations for select to authenticated
  using (private.accounting_can_read(company_id, array['vouchers.read', 'accounting_reports.read']));
drop policy if exists accounting_budgets_select on public.accounting_budgets;
create policy accounting_budgets_select on public.accounting_budgets for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_budgets.read', 'accounting_budgets.manage', 'accounting_budgets.approve']));
drop policy if exists accounting_budget_lines_select on public.accounting_budget_lines;
create policy accounting_budget_lines_select on public.accounting_budget_lines for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_budgets.read', 'accounting_budgets.manage', 'accounting_budgets.approve']));
drop policy if exists accounting_budget_history_select on public.accounting_budget_history;
create policy accounting_budget_history_select on public.accounting_budget_history for select to authenticated
  using (private.accounting_can_read(company_id, array['accounting_budgets.read', 'accounting_budgets.manage', 'accounting_budgets.approve']));

-- -----------------------------------------------------------------------------
-- 4. Guards
-- -----------------------------------------------------------------------------
-- Allocations follow their voucher: only while it is a DRAFT; never moved; deleted only by a reviewed force purge otherwise.
create or replace function private.accounting_allocation_guard()
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
  if tg_op = 'UPDATE' and (new.voucher_id <> old.voucher_id or new.voucher_line_id <> old.voucher_line_id or new.company_id <> old.company_id) then
    raise exception 'A cost-centre allocation cannot be moved to another voucher line.' using errcode = '42501';
  end if;
  select status into v_status from public.accounting_vouchers where id = coalesce(new.voucher_id, old.voucher_id);
  if v_status is distinct from 'DRAFT' then
    raise exception 'Cost-centre allocations of a posted, reversed or discarded voucher cannot be changed.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function private.accounting_budget_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_table_name = 'accounting_budget_history' then
    raise exception 'Budget history is append-only.' using errcode = '42501';
  end if;
  if tg_table_name = 'accounting_budgets' then
    if old.status in ('SUPERSEDED', 'CANCELLED') then
      raise exception 'A superseded or cancelled budget cannot be changed.' using errcode = '42501';
    end if;
    if old.status = 'APPROVED' and (new.status <> 'SUPERSEDED' or new.financial_year <> old.financial_year or new.version <> old.version
                                    or new.budget_name <> old.budget_name or new.approved_at is distinct from old.approved_at) then
      raise exception 'An approved budget cannot be changed; create a revision.' using errcode = '42501';
    end if;
    if new.company_id <> old.company_id then
      raise exception 'A budget cannot move to another company.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and private.erp_force_purge_allows(tg_table_name, old.company_id) then
    return old;
  end if;
  select status into v_status from public.accounting_budgets where id = coalesce(new.budget_id, old.budget_id);
  if v_status is distinct from 'DRAFT' then
    raise exception 'Budget lines can only be changed while the budget is a draft.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.accounting_allocation_guard() from public, anon, authenticated;
revoke all on function private.accounting_budget_guard() from public, anon, authenticated;

drop trigger if exists accounting_cost_allocations_guard on public.accounting_cost_allocations;
create trigger accounting_cost_allocations_guard before insert or update or delete on public.accounting_cost_allocations
  for each row execute function private.accounting_allocation_guard();
drop trigger if exists accounting_cost_allocations_no_truncate on public.accounting_cost_allocations;
create trigger accounting_cost_allocations_no_truncate before truncate on public.accounting_cost_allocations
  for each statement execute function private.accounting_no_truncate();
drop trigger if exists accounting_budgets_guard on public.accounting_budgets;
create trigger accounting_budgets_guard before update on public.accounting_budgets
  for each row execute function private.accounting_budget_guard();
drop trigger if exists accounting_budget_lines_guard on public.accounting_budget_lines;
create trigger accounting_budget_lines_guard before insert or update on public.accounting_budget_lines
  for each row execute function private.accounting_budget_guard();
drop trigger if exists accounting_budget_history_guard on public.accounting_budget_history;
create trigger accounting_budget_history_guard before update on public.accounting_budget_history
  for each row execute function private.accounting_budget_guard();

-- -----------------------------------------------------------------------------
-- 5. Allocation helpers
-- -----------------------------------------------------------------------------
-- Is the cost centre usable on a date (active, inside its effective dates)?
create or replace function private.accounting_cost_centre_usable(p_cost_centre uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.is_active and (c.effective_from is null or c.effective_from <= p_date) and (c.effective_to is null or c.effective_to >= p_date)
                   from public.accounting_cost_centres c where c.id = p_cost_centre), false);
$$;

-- Inserts the allocations of one line: [{cost_centre_id, amount}] (amounts > 0, at most 2 decimals, at most 100 per line).
create or replace function private.accounting_insert_line_allocations(p_company uuid, p_voucher uuid, p_line uuid, p_allocations jsonb, p_label text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e    jsonb;
  k    int := 0;
  v_cc uuid;
  v_a  numeric;
begin
  if p_allocations is null or jsonb_typeof(p_allocations) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_allocations) <> 'array' then
    raise exception '%: cost-centre allocations must be a list.', p_label using errcode = '22023';
  end if;
  if jsonb_array_length(p_allocations) > 100 then
    raise exception '%: at most 100 cost-centre allocations per line.', p_label using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_allocations) x loop
    k := k + 1;
    if jsonb_typeof(e) <> 'object' then
      raise exception '%, allocation %: invalid allocation.', p_label, k using errcode = '22023';
    end if;
    v_cc := private.accounting_uuid(e, 'cost_centre_id', format('%s, allocation %s cost centre', p_label, k));
    if v_cc is null then
      raise exception '%, allocation %: select a cost centre.', p_label, k using errcode = '22023';
    end if;
    if not exists (select 1 from public.accounting_cost_centres where id = v_cc and company_id = p_company) then
      raise exception '%, allocation %: the cost centre does not exist in this company.', p_label, k using errcode = '42501';
    end if;
    v_a := private.accounting_amount(e, 'amount', format('%s, allocation %s amount', p_label, k));
    if v_a <= 0 then
      raise exception '%, allocation %: the amount must be greater than zero.', p_label, k using errcode = '22023';
    end if;
    begin
      insert into public.accounting_cost_allocations (company_id, voucher_id, voucher_line_id, cost_centre_id, amount)
      values (p_company, p_voucher, p_line, v_cc, v_a);
    exception when unique_violation then
      raise exception '%: the same cost centre is allocated twice; combine the amounts.', p_label using errcode = '23505';
    end;
  end loop;
end;
$$;

-- Allocations of every line of a voucher from the same line list the lines were created from (line i = element i).
create or replace function private.accounting_insert_allocations(p_company uuid, p_voucher uuid, p_lines jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e jsonb;
  i int := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return;
  end if;
  for e in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    if jsonb_typeof(e) = 'object' and e ? 'allocations' then
      perform private.accounting_insert_line_allocations(p_company, p_voucher,
        (select id from public.accounting_voucher_lines where voucher_id = p_voucher and line_no = i), e -> 'allocations', format('Line %s', i));
    end if;
  end loop;
end;
$$;

-- Cost-centre reasons a voucher cannot be posted (appended to private.accounting_voucher_issues). Read-only.
create or replace function private.accounting_allocation_issues(p_voucher uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v        public.accounting_vouchers;
  v_issues jsonb := '[]'::jsonb;
  r        record;
begin
  select * into v from public.accounting_vouchers where id = p_voucher;
  -- A reversal carries the original's allocations; it is never blocked by later rule changes.
  if v.source = 'REVERSAL' then
    return v_issues;
  end if;
  for r in
    select l.line_no, l.debit + l.credit as line_amount, a.account_code, a.account_name, a.cost_centre_policy,
           count(x.id) as n, coalesce(sum(x.amount), 0) as allocated,
           bool_and(x.id is null or private.accounting_cost_centre_usable(x.cost_centre_id, v.voucher_date)) as usable,
           string_agg(c.cost_centre_code, ', ' order by c.cost_centre_code) filter (where x.id is not null
             and not private.accounting_cost_centre_usable(x.cost_centre_id, v.voucher_date)) as unusable
    from public.accounting_voucher_lines l
    join public.accounts a on a.id = l.account_id
    left join public.accounting_cost_allocations x on x.voucher_line_id = l.id
    left join public.accounting_cost_centres c on c.id = x.cost_centre_id
    where l.voucher_id = p_voucher
    group by l.line_no, l.debit, l.credit, a.account_code, a.account_name, a.cost_centre_policy
    order by l.line_no
  loop
    if r.cost_centre_policy = 'REQUIRED' and r.n = 0 and v.source <> 'OPENING' then
      v_issues := v_issues || jsonb_build_object('code', 'COST_CENTRE_REQUIRED', 'line_no', r.line_no, 'message',
        format('Line %s: account %s %s needs a cost-centre allocation.', r.line_no, r.account_code, r.account_name));
    end if;
    if r.cost_centre_policy = 'NOT_APPLICABLE' and r.n > 0 then
      v_issues := v_issues || jsonb_build_object('code', 'COST_CENTRE_NOT_ALLOWED', 'line_no', r.line_no, 'message',
        format('Line %s: account %s %s is not allocated to cost centres; remove the allocation.', r.line_no, r.account_code, r.account_name));
    end if;
    if r.n > 0 and r.allocated <> r.line_amount then
      v_issues := v_issues || jsonb_build_object('code', 'ALLOCATION_MISMATCH', 'line_no', r.line_no, 'message',
        format('Line %s: cost-centre allocations total %s but the line amount is %s (difference %s).', r.line_no,
          to_char(r.allocated, 'FM999999999999990.00'), to_char(r.line_amount, 'FM999999999999990.00'), to_char(r.line_amount - r.allocated, 'FM999999999999990.00')));
    end if;
    if r.n > 0 and not r.usable then
      v_issues := v_issues || jsonb_build_object('code', 'COST_CENTRE_INACTIVE', 'line_no', r.line_no, 'message',
        format('Line %s: cost centre %s is inactive or outside its effective dates on %s.', r.line_no, r.unusable, to_char(v.voucher_date, 'DD-Mon-YYYY')));
    end if;
  end loop;
  return v_issues;
end;
$$;

-- Allocation rows of one line as JSON (for voucher JSON and reversals).
create or replace function private.accounting_line_allocations_json(p_line uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('cost_centre_id', x.cost_centre_id, 'cost_centre_code', c.cost_centre_code,
    'cost_centre_name', c.cost_centre_name, 'amount', x.amount) order by c.cost_centre_code), '[]'::jsonb)
  from public.accounting_cost_allocations x join public.accounting_cost_centres c on c.id = x.cost_centre_id
  where x.voucher_line_id = p_line;
$$;

revoke all on function private.accounting_cost_centre_usable(uuid, date) from public, anon, authenticated;
revoke all on function private.accounting_insert_line_allocations(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.accounting_insert_allocations(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.accounting_allocation_issues(uuid) from public, anon, authenticated;
revoke all on function private.accounting_line_allocations_json(uuid) from public, anon, authenticated;

-- Control accounts (Debtors / Creditors) are always NOT_APPLICABLE, including those created by the Phase 0 chart seed.
create or replace function private.accounting_account_cc_policy_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_control then
    new.cost_centre_policy := 'NOT_APPLICABLE';
  end if;
  return new;
end;
$$;
revoke all on function private.accounting_account_cc_policy_default() from public, anon, authenticated;
drop trigger if exists accounts_cost_centre_policy_default on public.accounts;
create trigger accounts_cost_centre_policy_default before insert or update of is_control, cost_centre_policy on public.accounts
  for each row execute function private.accounting_account_cc_policy_default();


-- -----------------------------------------------------------------------------
-- 6. Phase 0 voucher functions extended for allocations (each is the 20261231090000 text plus marked "Phase 2" lines)
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
  -- Phase 2: cost-centre allocations given with the lines ("allocations": [{cost_centre_id, amount}]).
  perform private.accounting_insert_allocations(p_company, v_id, coalesce(p_lines, '[]'::jsonb));
  return v_id;
end;
$$;

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
  -- Phase 2: cost-centre rules (required / not applicable / split equals the line / usable cost centre).
  v_issues := v_issues || private.accounting_allocation_issues(p_voucher);
  return v_issues;
end;
$$;

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
  -- Phase 2: the reversal carries the original allocations onto the opposite lines.
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'party_id', l.party_id, 'debit', l.credit, 'credit', l.debit,
                                      'narration', l.line_narration, 'allocations', private.accounting_line_allocations_json(l.id)) order by l.line_no)
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
        'debit', l.debit, 'credit', l.credit, 'narration', l.line_narration, 'cost_centre_policy', a.cost_centre_policy,
        'allocations', private.accounting_line_allocations_json(l.id)) order by l.line_no)
      from public.accounting_voucher_lines l join public.accounts a on a.id = l.account_id where l.voucher_id = v.id), '[]'::jsonb))
  from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
  where v.id = p_voucher;
$$;

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
    delete from public.accounting_cost_allocations where voucher_id = v.id;
    delete from public.accounting_voucher_lines where voucher_id = v.id;
    insert into public.accounting_voucher_lines (company_id, voucher_id, line_no, account_id, party_id, debit, credit, line_narration)
    select v_company, v.id, l.line_no, l.account_id, l.party_id, l.debit, l.credit, l.narration from private.accounting_parse_lines(v_company, p_voucher -> 'lines') l;
    perform private.accounting_insert_allocations(v_company, v.id, p_voucher -> 'lines');
  end if;
  perform private.write_audit_log(v_company, 'accounting.voucher.updated', 'accounting_voucher', v.id::text,
    jsonb_build_object('lines_replaced', p_voucher ? 'lines', 'voucher_date', v_date));
  return private.accounting_voucher_json(v.id) || jsonb_build_object('issues', private.accounting_voucher_issues(v.id));
end;
$$;

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
  -- Phase 2: "allocations" in the line replaces that line's cost-centre split.
  if p_line ? 'allocations' then
    delete from public.accounting_cost_allocations where voucher_id = v.id
      and voucher_line_id = coalesce(p_line_id, (select id from public.accounting_voucher_lines where voucher_id = v.id and line_no = v_no));
    perform private.accounting_insert_line_allocations(v_company, v.id, coalesce(p_line_id, (select id from public.accounting_voucher_lines where voucher_id = v.id and line_no = v_no)),
      p_line -> 'allocations', 'Line');
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
  delete from public.accounting_cost_allocations where voucher_line_id = p_line_id and voucher_id = v.id;
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
      'cost_centre_policy', a.cost_centre_policy,
      'balance', coalesce((select sum(l.debit - l.credit) from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
                           where l.account_id = a.id and v.status in ('POSTED', 'REVERSED')), 0))
      order by a.account_code)
    from public.accounts a join public.account_groups g on g.id = a.group_id
    where a.company_id = v_company and (p_include_inactive or a.is_active)
      and (v_term is null or a.account_code ilike '%' || v_term || '%' or a.account_name ilike '%' || v_term || '%' or g.group_name ilike '%' || v_term || '%')),
    '[]'::jsonb);
end;
$$;

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
        'requires_party', a.requires_party, 'cost_centre_policy', a.cost_centre_policy, 'is_control', a.is_control, 'is_system', a.is_system, 'system_key', a.system_key,
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
  v_cc      uuid := private.accounting_uuid(f, 'cost_centre_id', 'Cost centre');
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
        and (v_cc is null or exists (select 1 from public.accounting_cost_allocations x where x.voucher_id = v.id and x.cost_centre_id = v_cc))
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
-- 7. Cost centre master (replaces the Phase 0 list / save: type, effective dates, usage, no cycles, no delete once used)
-- -----------------------------------------------------------------------------
create or replace function public.accounting_cost_centres()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounts.read', 'vouchers.read', 'accounting_reports.read', 'accounting_budgets.read']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
      'description', c.description, 'parent_cost_centre_id', c.parent_cost_centre_id, 'cost_centre_type', c.cost_centre_type,
      'effective_from', c.effective_from, 'effective_to', c.effective_to, 'is_active', c.is_active, 'updated_at', c.updated_at,
      'allocation_count', (select count(*) from public.accounting_cost_allocations x where x.cost_centre_id = c.id),
      'posted_allocation_count', (select count(*) from public.accounting_cost_allocations x join public.accounting_vouchers v on v.id = x.voucher_id
                                  where x.cost_centre_id = c.id and v.status in ('POSTED', 'REVERSED')),
      'budget_line_count', (select count(*) from public.accounting_budget_lines b where b.cost_centre_id = c.id),
      'child_count', (select count(*) from public.accounting_cost_centres k where k.parent_cost_centre_id = c.id))
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
  v_type    text := upper(coalesce(private.accounting_text(p_cost_centre, 'cost_centre_type', 20, 'Cost centre type'), 'DEPARTMENT'));
  v_from    date := private.accounting_date(p_cost_centre, 'effective_from', 'Effective from');
  v_to      date := private.accounting_date(p_cost_centre, 'effective_to', 'Effective to');
  v_active  boolean := coalesce((p_cost_centre ->> 'is_active')::boolean, true);
  v_old     public.accounting_cost_centres;
  v_id      uuid := p_cost_centre_id;
begin
  perform private.accounting_require_setup(v_company);
  -- One hierarchy change at a time per company, so two concurrent moves cannot form a cycle together.
  perform pg_advisory_xact_lock(hashtextextended('accounting_cost_centre_tree:' || v_company::text, 0));
  if v_name is null or length(v_name) < 2 then
    raise exception 'The cost centre name is required (at least 2 characters).' using errcode = '22023';
  end if;
  if v_type not in ('DEPARTMENT', 'PRODUCTION', 'SERVICE', 'SALES', 'ADMINISTRATION', 'WAREHOUSE', 'PROJECT', 'BRANCH', 'OTHER') then
    raise exception 'Unknown cost centre type %.', v_type using errcode = '22023';
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    raise exception 'The effective end date cannot be before the start date.' using errcode = '22023';
  end if;
  if v_parent is not null and not exists (select 1 from public.accounting_cost_centres where id = v_parent and company_id = v_company) then
    raise exception 'The parent cost centre does not exist in this company.' using errcode = '42501';
  end if;
  if v_id is null then
    if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$' then
      raise exception 'The cost centre code is required: letters, digits, . _ - (up to 20).' using errcode = '22023';
    end if;
    insert into public.accounting_cost_centres (company_id, cost_centre_code, cost_centre_name, description, parent_cost_centre_id, cost_centre_type,
      effective_from, effective_to, is_active, created_by, updated_by)
    values (v_company, v_code, v_name, v_desc, v_parent, v_type, v_from, v_to, v_active, auth.uid(), auth.uid()) returning id into v_id;
  else
    select * into v_old from public.accounting_cost_centres where id = v_id and company_id = v_company for update;
    if not found then
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
    if not v_active and v_old.is_active and exists (select 1 from public.accounting_cost_centres where parent_cost_centre_id = v_id and is_active) then
      raise exception 'Deactivate the active sub-centres of % first.', v_old.cost_centre_code using errcode = 'P0001';
    end if;
    update public.accounting_cost_centres set cost_centre_name = v_name, description = v_desc, parent_cost_centre_id = v_parent, cost_centre_type = v_type,
      effective_from = v_from, effective_to = v_to, is_active = v_active, updated_by = auth.uid(), updated_at = now() where id = v_id;
  end if;
  perform private.write_audit_log(v_company, case when p_cost_centre_id is null then 'accounting.cost_centre.created' else 'accounting.cost_centre.updated' end,
    'accounting_cost_centre', v_id::text, jsonb_build_object('code', coalesce(v_code, v_old.cost_centre_code), 'name', v_name, 'type', v_type, 'parent', v_parent,
      'is_active', v_active, 'effective_from', v_from, 'effective_to', v_to,
      'before', case when v_old.id is not null then jsonb_build_object('name', v_old.cost_centre_name, 'parent', v_old.parent_cost_centre_id, 'is_active', v_old.is_active) end));
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'A cost centre with this code already exists.' using errcode = '23505';
end;
$$;

-- Deletes a cost centre that was never used (no allocations, budgets or sub-centres); a used one can only be deactivated.
create or replace function public.accounting_cost_centre_delete(p_cost_centre_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  c         public.accounting_cost_centres;
begin
  perform pg_advisory_xact_lock(hashtextextended('accounting_cost_centre_tree:' || v_company::text, 0));
  select * into c from public.accounting_cost_centres where id = p_cost_centre_id and company_id = v_company for update;
  if not found then
    raise exception 'Cost centre not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.accounting_cost_allocations where cost_centre_id = c.id) then
    raise exception 'Cost centre % is used on vouchers; deactivate it instead.', c.cost_centre_code using errcode = 'P0001';
  end if;
  if exists (select 1 from public.accounting_budget_lines where cost_centre_id = c.id) then
    raise exception 'Cost centre % is used in budgets; deactivate it instead.', c.cost_centre_code using errcode = 'P0001';
  end if;
  if exists (select 1 from public.accounting_cost_centres where parent_cost_centre_id = c.id) then
    raise exception 'Cost centre % has sub-centres.', c.cost_centre_code using errcode = 'P0001';
  end if;
  delete from public.accounting_cost_centres where id = c.id;
  perform private.write_audit_log(v_company, 'accounting.cost_centre.deleted', 'accounting_cost_centre', c.id::text,
    jsonb_build_object('code', c.cost_centre_code, 'name', c.cost_centre_name));
  return jsonb_build_object('deleted', c.id);
end;
$$;

-- Account-level allocation rule. Changing it affects drafts and future postings only; posted vouchers keep their allocations.
create or replace function public.accounting_account_set_cost_centre_policy(p_account_id uuid, p_policy text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounts.manage');
  a         public.accounts;
  v_policy  text := upper(coalesce(p_policy, ''));
begin
  select * into a from public.accounts where id = p_account_id and company_id = v_company for update;
  if not found then
    raise exception 'Ledger account not found.' using errcode = 'P0002';
  end if;
  if v_policy not in ('REQUIRED', 'OPTIONAL', 'NOT_APPLICABLE') then
    raise exception 'The cost-centre rule must be REQUIRED, OPTIONAL or NOT_APPLICABLE.' using errcode = '22023';
  end if;
  if a.is_control and v_policy <> 'NOT_APPLICABLE' then
    raise exception 'Debtors / Creditors control accounts are never allocated to cost centres.' using errcode = 'P0001';
  end if;
  update public.accounts set cost_centre_policy = v_policy, updated_by = auth.uid() where id = a.id;
  perform private.write_audit_log(v_company, 'accounting.account.cost_centre_policy', 'account', a.id::text,
    jsonb_build_object('code', a.account_code, 'from', a.cost_centre_policy, 'to', v_policy));
  return jsonb_build_object('id', a.id, 'cost_centre_policy', v_policy);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Reports with a cost-centre filter (the Phase 0 versions are replaced; company-wide results are unchanged
--    when no cost centre is given). A cost-centre general ledger shows the allocated amounts of that centre.
-- -----------------------------------------------------------------------------
-- Ledger rows of an account: whole lines, or (with a cost centre) the allocated amount of that centre on each line. Read-only.
create or replace function private.accounting_gl_rows(p_account uuid, p_to date, p_party uuid, p_cost_centre uuid)
returns table (voucher_id uuid, voucher_number text, voucher_date date, posted_at timestamptz, status text, narration text, reference_number text,
  source_type text, source_number text, type_code text, line_no int, line_narration text, party_id uuid, debit numeric, credit numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.voucher_number, v.voucher_date, v.posted_at, v.status, v.narration, v.reference_number, v.source_type, v.source_number, t.type_code,
         l.line_no, l.line_narration, l.party_id,
         case when p_cost_centre is null then l.debit when l.debit > 0 then x.amount else 0 end,
         case when p_cost_centre is null then l.credit when l.credit > 0 then x.amount else 0 end
  from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id
  join public.accounting_voucher_types t on t.id = v.voucher_type_id
  left join public.accounting_cost_allocations x on p_cost_centre is not null and x.voucher_line_id = l.id and x.cost_centre_id = p_cost_centre
  where l.account_id = p_account and v.status in ('POSTED', 'REVERSED') and v.voucher_date <= p_to
    and (p_party is null or l.party_id = p_party) and (p_cost_centre is null or x.id is not null);
$$;
revoke all on function private.accounting_gl_rows(uuid, date, uuid, uuid) from public, anon, authenticated;

drop function if exists public.accounting_general_ledger(uuid, date, date, uuid);
create or replace function public.accounting_general_ledger(p_account_id uuid, p_from date, p_to date, p_party_id uuid default null, p_cost_centre_id uuid default null)
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
  if p_cost_centre_id is not null and not exists (select 1 from public.accounting_cost_centres where id = p_cost_centre_id and company_id = v_company) then
    raise exception 'Cost centre not found.' using errcode = 'P0002';
  end if;
  select coalesce(sum(r.debit - r.credit), 0) into v_opening
  from private.accounting_gl_rows(v_a.id, p_to, p_party_id, p_cost_centre_id) r where r.voucher_date < p_from;
  return jsonb_build_object('account', jsonb_build_object('id', v_a.id, 'account_code', v_a.account_code, 'account_name', v_a.account_name,
      'normal_balance', v_a.normal_balance, 'classification', v_a.classification, 'requires_party', v_a.requires_party, 'cost_centre_policy', v_a.cost_centre_policy),
    'from', p_from, 'to', p_to, 'cost_centre_id', p_cost_centre_id, 'opening_balance', v_opening,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', e.voucher_id, 'voucher_number', e.voucher_number, 'voucher_date', e.voucher_date,
        'voucher_type', e.type_code, 'status', e.status, 'narration', coalesce(e.line_narration, e.narration), 'reference_number', e.reference_number,
        'source_type', e.source_type, 'source_number', e.source_number, 'party_id', e.party_id,
        'party_name', case when e.party_id is not null then private.accounting_party_name(e.party_id) end,
        'debit', e.debit, 'credit', e.credit, 'balance', v_opening + e.running) order by e.voucher_date, e.posted_at, e.line_no)
      from (select r.*, sum(r.debit - r.credit) over (order by r.voucher_date, r.posted_at, r.voucher_id, r.line_no) as running
            from private.accounting_gl_rows(v_a.id, p_to, p_party_id, p_cost_centre_id) r where r.voucher_date >= p_from) e), '[]'::jsonb),
    'closing_balance', v_opening + coalesce((select sum(r.debit - r.credit) from private.accounting_gl_rows(v_a.id, p_to, p_party_id, p_cost_centre_id) r
                                             where r.voucher_date >= p_from), 0));
end;
$$;


drop function if exists public.accounting_day_book(date, date, text);
create or replace function public.accounting_day_book(p_from date, p_to date, p_voucher_type text default null, p_cost_centre_id uuid default null)
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
  -- With a cost centre: the posted vouchers that allocate to it (shown whole).
  return jsonb_build_object('from', p_from, 'to', p_to, 'cost_centre_id', p_cost_centre_id,
    'vouchers', coalesce((select jsonb_agg(private.accounting_voucher_json(v.id) order by v.voucher_date, v.posted_at)
      from public.accounting_vouchers v join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))
        and (p_cost_centre_id is null or exists (select 1 from public.accounting_cost_allocations x where x.voucher_id = v.id and x.cost_centre_id = p_cost_centre_id))), '[]'::jsonb),
    'totals', (select jsonb_build_object('debit', coalesce(sum(l.debit), 0), 'credit', coalesce(sum(l.credit), 0), 'vouchers', count(distinct v.id))
      from public.accounting_vouchers v join public.accounting_voucher_lines l on l.voucher_id = v.id
      join public.accounting_voucher_types t on t.id = v.voucher_type_id
      where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
        and (p_voucher_type is null or t.type_code = upper(p_voucher_type))
        and (p_cost_centre_id is null or exists (select 1 from public.accounting_cost_allocations x where x.voucher_id = v.id and x.cost_centre_id = p_cost_centre_id))));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Cost centre reports (posted and reversed vouchers only; allocated and unallocated shown apart)
-- -----------------------------------------------------------------------------
-- Allocated facts: one row per posted allocation, signed debit-positive. Income / expense only for P&L style reports.
create or replace function private.accounting_cc_facts(p_company uuid, p_from date, p_to date)
returns table (cost_centre_id uuid, account_id uuid, classification text, voucher_date date, signed numeric, is_direct boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive direct_groups (id) as (
    select g.id from public.account_groups g where g.company_id = p_company and g.group_code in ('EX.PUR', 'EX.DIR')
    union
    select g.id from public.account_groups g join direct_groups d on g.parent_group_id = d.id
  )
  select x.cost_centre_id, l.account_id, a.classification, v.voucher_date,
         case when l.debit > 0 then x.amount else -x.amount end,
         a.group_id in (select id from direct_groups)
  from public.accounting_cost_allocations x
  join public.accounting_voucher_lines l on l.id = x.voucher_line_id
  join public.accounting_vouchers v on v.id = x.voucher_id
  join public.accounts a on a.id = l.account_id
  where x.company_id = p_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
  union all
  -- Unallocated income / expense lines (cost_centre_id NULL).
  select null::uuid, l.account_id, a.classification, v.voucher_date, l.debit - l.credit, a.group_id in (select id from direct_groups)
  from public.accounting_voucher_lines l
  join public.accounting_vouchers v on v.id = l.voucher_id
  join public.accounts a on a.id = l.account_id
  where v.company_id = p_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
    and a.classification in ('INCOME', 'EXPENSE')
    and not exists (select 1 from public.accounting_cost_allocations x where x.voucher_line_id = l.id);
$$;

-- Approved budget per cost centre and account for the months that overlap a date range.
create or replace function private.accounting_cc_budget(p_company uuid, p_from date, p_to date)
returns table (cost_centre_id uuid, account_id uuid, classification text, amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select bl.cost_centre_id, bl.account_id, a.classification, sum(m.amount)
  from public.accounting_budgets b
  join public.accounting_budget_lines bl on bl.budget_id = b.id
  join public.accounts a on a.id = bl.account_id
  cross join lateral (values (1, bl.m01), (2, bl.m02), (3, bl.m03), (4, bl.m04), (5, bl.m05), (6, bl.m06), (7, bl.m07), (8, bl.m08),
                             (9, bl.m09), (10, bl.m10), (11, bl.m11), (12, bl.m12)) m (k, amount)
  where b.company_id = p_company and b.status = 'APPROVED'
    and (b.fy_start + make_interval(months => m.k - 1))::date <= p_to
    and ((b.fy_start + make_interval(months => m.k))::date - 1) >= p_from
  group by bl.cost_centre_id, bl.account_id, a.classification;
$$;

revoke all on function private.accounting_cc_facts(uuid, date, date) from public, anon, authenticated;
revoke all on function private.accounting_cc_budget(uuid, date, date) from public, anon, authenticated;

create or replace function public.accounting_cost_centre_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_reports.read', 'accounting_budgets.read']);
begin
  perform private.accounting_require_setup(v_company);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  return (
    with f as (select * from private.accounting_cc_facts(v_company, p_from, p_to)),
    b as (select * from private.accounting_cc_budget(v_company, p_from, p_to)),
    per as (
      select f.cost_centre_id,
        coalesce(sum(-f.signed) filter (where f.classification = 'INCOME'), 0) as income,
        coalesce(sum(f.signed) filter (where f.classification = 'EXPENSE'), 0) as expense
      from f group by f.cost_centre_id
    ),
    bud as (select cost_centre_id, coalesce(sum(amount) filter (where classification = 'EXPENSE'), 0) as budget,
                   coalesce(sum(amount) filter (where classification = 'INCOME'), 0) as income_budget from b group by cost_centre_id),
    rows_ as (
      select c.id, c.cost_centre_code, c.cost_centre_name, c.parent_cost_centre_id, c.cost_centre_type, c.is_active,
             coalesce(p.income, 0) as income, coalesce(p.expense, 0) as expense, coalesce(bu.budget, 0) as budget, coalesce(bu.income_budget, 0) as income_budget
      from public.accounting_cost_centres c left join per p on p.cost_centre_id = c.id left join bud bu on bu.cost_centre_id = c.id
      where c.company_id = v_company
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_id', r.id, 'cost_centre_code', r.cost_centre_code, 'cost_centre_name', r.cost_centre_name,
          'parent_cost_centre_id', r.parent_cost_centre_id, 'cost_centre_type', r.cost_centre_type, 'is_active', r.is_active,
          'income', r.income, 'expense', r.expense, 'net', r.income - r.expense, 'budget', r.budget, 'actual', r.expense,
          'variance', r.budget - r.expense, 'income_budget', r.income_budget) order by r.cost_centre_code) from rows_ r), '[]'::jsonb),
      'unallocated', (select jsonb_build_object('income', coalesce(p.income, 0), 'expense', coalesce(p.expense, 0), 'net', coalesce(p.income, 0) - coalesce(p.expense, 0))
                      from (select 1) one left join per p on p.cost_centre_id is null),
      -- Company-wide income and expense of the period from the voucher lines (allocated + unallocated must equal these).
      'company', (select jsonb_build_object(
          'income', coalesce(sum(l.credit - l.debit) filter (where a.classification = 'INCOME'), 0),
          'expense', coalesce(sum(l.debit - l.credit) filter (where a.classification = 'EXPENSE'), 0))
        from public.accounting_voucher_lines l join public.accounting_vouchers v on v.id = l.voucher_id join public.accounts a on a.id = l.account_id
        where v.company_id = v_company and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to))
  );
end;
$$;

create or replace function public.accounting_cost_centre_profitability(p_from date, p_to date)
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
  return (
    with f as (select * from private.accounting_cc_facts(v_company, p_from, p_to)),
    per as (
      select f.cost_centre_id,
        coalesce(sum(-f.signed) filter (where f.classification = 'INCOME'), 0) as revenue,
        coalesce(sum(f.signed) filter (where f.classification = 'EXPENSE' and f.is_direct), 0) as direct,
        coalesce(sum(f.signed) filter (where f.classification = 'EXPENSE' and not f.is_direct), 0) as indirect
      from f group by f.cost_centre_id
    )
    select jsonb_build_object('from', p_from, 'to', p_to,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
          'parent_cost_centre_id', c.parent_cost_centre_id, 'cost_centre_type', c.cost_centre_type, 'revenue', coalesce(p.revenue, 0),
          'direct_expenses', coalesce(p.direct, 0), 'indirect_expenses', coalesce(p.indirect, 0),
          'contribution', coalesce(p.revenue, 0) - coalesce(p.direct, 0), 'net_contribution', coalesce(p.revenue, 0) - coalesce(p.direct, 0) - coalesce(p.indirect, 0))
          order by c.cost_centre_code)
        from public.accounting_cost_centres c left join per p on p.cost_centre_id = c.id where c.company_id = v_company), '[]'::jsonb),
      'unallocated', (select jsonb_build_object('revenue', coalesce(p.revenue, 0), 'direct_expenses', coalesce(p.direct, 0), 'indirect_expenses', coalesce(p.indirect, 0),
          'net_contribution', coalesce(p.revenue, 0) - coalesce(p.direct, 0) - coalesce(p.indirect, 0)) from (select 1) one left join per p on p.cost_centre_id is null))
  );
end;
$$;

create or replace function public.accounting_cost_centre_ledger(p_cost_centre_id uuid, p_from date, p_to date, p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_reports.read');
  c         public.accounting_cost_centres;
  v_opening numeric;
begin
  perform private.accounting_require_setup(v_company);
  select * into c from public.accounting_cost_centres where id = p_cost_centre_id and company_id = v_company;
  if not found then
    raise exception 'Cost centre not found.' using errcode = 'P0002';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Enter a valid date range.' using errcode = '22023';
  end if;
  select coalesce(sum(case when l.debit > 0 then x.amount else -x.amount end), 0) into v_opening
  from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id join public.accounting_vouchers v on v.id = x.voucher_id
  where x.cost_centre_id = c.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date < p_from and (p_account_id is null or l.account_id = p_account_id);
  return jsonb_build_object('cost_centre', jsonb_build_object('id', c.id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name),
    'from', p_from, 'to', p_to, 'opening_balance', v_opening,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('voucher_id', e.voucher_id, 'voucher_number', e.voucher_number, 'voucher_date', e.voucher_date,
        'voucher_type', e.type_code, 'status', e.status, 'account_id', e.account_id, 'account_code', e.account_code, 'account_name', e.account_name,
        'narration', coalesce(e.line_narration, e.narration), 'debit', e.debit, 'credit', e.credit, 'balance', v_opening + e.running)
        order by e.voucher_date, e.posted_at, e.voucher_id, e.line_no)
      from (select v.id as voucher_id, v.voucher_number, v.voucher_date, v.posted_at, v.status, v.narration, t.type_code, l.line_no, l.line_narration,
                   a.id as account_id, a.account_code, a.account_name,
                   case when l.debit > 0 then x.amount else 0 end as debit, case when l.credit > 0 then x.amount else 0 end as credit,
                   sum(case when l.debit > 0 then x.amount else -x.amount end) over (order by v.voucher_date, v.posted_at, v.id, l.line_no) as running
            from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id
            join public.accounting_vouchers v on v.id = x.voucher_id join public.accounting_voucher_types t on t.id = v.voucher_type_id
            join public.accounts a on a.id = l.account_id
            where x.cost_centre_id = c.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
              and (p_account_id is null or l.account_id = p_account_id)) e), '[]'::jsonb),
    'closing_balance', v_opening + coalesce((select sum(case when l.debit > 0 then x.amount else -x.amount end)
       from public.accounting_cost_allocations x join public.accounting_voucher_lines l on l.id = x.voucher_line_id join public.accounting_vouchers v on v.id = x.voucher_id
       where x.cost_centre_id = c.id and v.status in ('POSTED', 'REVERSED') and v.voucher_date between p_from and p_to
         and (p_account_id is null or l.account_id = p_account_id)), 0));
end;
$$;

-- Budget versus actual for a financial year (the approved budget), up to a month (1..12 of the financial year; NULL = whole year).
create or replace function public.accounting_budget_vs_actual(p_financial_year text, p_upto_month integer default null, p_cost_centre_id uuid default null,
  p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_reports.read', 'accounting_budgets.read']);
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_budget  public.accounting_budgets;
  v_start   date;
  v_upto    int := coalesce(p_upto_month, 12);
  v_to      date;
begin
  if p_financial_year is null or p_financial_year !~ '^[0-9]{4}(-[0-9]{2})?$' then
    raise exception 'Choose a financial year.' using errcode = '22023';
  end if;
  if v_upto not between 1 and 12 then
    raise exception 'The month must be between 1 and 12.' using errcode = '22023';
  end if;
  v_start := make_date(left(p_financial_year, 4)::int, s.fy_start_month, 1);
  v_to := ((v_start + make_interval(months => v_upto))::date - 1);
  select * into v_budget from public.accounting_budgets where company_id = v_company and financial_year = p_financial_year and status = 'APPROVED';
  return (
    with bl as (
      select l.cost_centre_id, l.account_id, l.annual_amount,
             (array[l.m01, l.m02, l.m03, l.m04, l.m05, l.m06, l.m07, l.m08, l.m09, l.m10, l.m11, l.m12])[v_upto] as month_budget,
             (select sum(m) from unnest((array[l.m01, l.m02, l.m03, l.m04, l.m05, l.m06, l.m07, l.m08, l.m09, l.m10, l.m11, l.m12])[1:v_upto]) m) as period_budget
      from public.accounting_budget_lines l where l.budget_id = v_budget.id
    ),
    act as (
      select f.cost_centre_id, f.account_id, f.classification,
             sum(case when f.classification = 'INCOME' then -f.signed else f.signed end) as actual
      from private.accounting_cc_facts(v_company, v_start, v_to) f where f.cost_centre_id is not null
      group by f.cost_centre_id, f.account_id, f.classification
    ),
    j as (
      select coalesce(bl.cost_centre_id, act.cost_centre_id) as cost_centre_id, coalesce(bl.account_id, act.account_id) as account_id,
             coalesce(bl.annual_amount, 0) as annual, coalesce(bl.month_budget, 0) as month_budget, coalesce(bl.period_budget, 0) as period_budget,
             coalesce(act.actual, 0) as actual
      from bl full join act on act.cost_centre_id = bl.cost_centre_id and act.account_id = bl.account_id
    )
    select jsonb_build_object('financial_year', p_financial_year, 'from', v_start, 'to', v_to, 'upto_month', v_upto,
      'budget', case when v_budget.id is null then null else jsonb_build_object('id', v_budget.id, 'version', v_budget.version, 'budget_name', v_budget.budget_name,
        'approved_at', v_budget.approved_at) end,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('cost_centre_id', j.cost_centre_id, 'cost_centre_code', c.cost_centre_code, 'cost_centre_name', c.cost_centre_name,
          'account_id', j.account_id, 'account_code', a.account_code, 'account_name', a.account_name, 'classification', a.classification,
          'annual_budget', j.annual, 'monthly_budget', j.month_budget, 'period_budget', j.period_budget, 'actual', j.actual,
          'remaining', j.annual - j.actual, 'variance', j.period_budget - j.actual,
          'variance_percent', case when j.period_budget = 0 then null else round((j.period_budget - j.actual) * 100 / j.period_budget, 2) end)
          order by c.cost_centre_code, a.account_code)
        from j join public.accounting_cost_centres c on c.id = j.cost_centre_id join public.accounts a on a.id = j.account_id
        where a.classification in ('INCOME', 'EXPENSE') and (p_cost_centre_id is null or j.cost_centre_id = p_cost_centre_id)
          and (p_account_id is null or j.account_id = p_account_id)), '[]'::jsonb))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Budgets
-- -----------------------------------------------------------------------------
create or replace function private.accounting_budget_json(p_budget uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(b) - array['created_by', 'updated_by', 'approved_by', 'cancelled_by'] || jsonb_build_object(
    'created_by_name', (select full_name from public.profiles where id = b.created_by),
    'approved_by_name', (select full_name from public.profiles where id = b.approved_by),
    'revision_of_version', (select version from public.accounting_budgets where id = b.revision_of_budget_id),
    'total_annual', coalesce((select sum(annual_amount) from public.accounting_budget_lines where budget_id = b.id), 0),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'cost_centre_id', l.cost_centre_id, 'cost_centre_code', c.cost_centre_code,
        'cost_centre_name', c.cost_centre_name, 'account_id', l.account_id, 'account_code', a.account_code, 'account_name', a.account_name,
        'classification', a.classification, 'annual_amount', l.annual_amount,
        'months', jsonb_build_array(l.m01, l.m02, l.m03, l.m04, l.m05, l.m06, l.m07, l.m08, l.m09, l.m10, l.m11, l.m12), 'notes', l.notes) order by l.line_no)
      from public.accounting_budget_lines l join public.accounting_cost_centres c on c.id = l.cost_centre_id join public.accounts a on a.id = l.account_id
      where l.budget_id = b.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', h.action, 'note', h.note, 'details', h.details, 'at', h.created_at,
        'by', (select full_name from public.profiles where id = h.actor_id)) order by h.created_at)
      from public.accounting_budget_history h where h.budget_id = b.id), '[]'::jsonb))
  from public.accounting_budgets b where b.id = p_budget;
$$;

create or replace function private.accounting_budget_log(p_budget public.accounting_budgets, p_action text, p_note text, p_details jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.accounting_budget_history (company_id, budget_id, action, note, details, actor_id)
  values (p_budget.company_id, p_budget.id, p_action, left(p_note, 1000), coalesce(p_details, '{}'::jsonb), auth.uid());
  perform private.write_audit_log(p_budget.company_id, 'accounting.budget.' || lower(p_action), 'accounting_budget', p_budget.id::text,
    jsonb_build_object('financial_year', p_budget.financial_year, 'version', p_budget.version, 'note', left(p_note, 500)) || coalesce(p_details, '{}'::jsonb));
end;
$$;

revoke all on function private.accounting_budget_json(uuid) from public, anon, authenticated;
revoke all on function private.accounting_budget_log(public.accounting_budgets, text, text, jsonb) from public, anon, authenticated, service_role;

create or replace function public.accounting_budgets(p_financial_year text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_budgets.read', 'accounting_budgets.manage', 'accounting_budgets.approve']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'financial_year', b.financial_year, 'version', b.version, 'budget_name', b.budget_name,
      'status', b.status, 'source', b.source, 'notes', b.notes, 'created_at', b.created_at, 'approved_at', b.approved_at,
      'created_by_name', (select full_name from public.profiles where id = b.created_by),
      'line_count', (select count(*) from public.accounting_budget_lines where budget_id = b.id),
      'total_annual', coalesce((select sum(annual_amount) from public.accounting_budget_lines where budget_id = b.id), 0)) order by b.financial_year desc, b.version desc)
    from public.accounting_budgets b where b.company_id = v_company and (p_financial_year is null or b.financial_year = p_financial_year)), '[]'::jsonb);
end;
$$;

create or replace function public.accounting_budget_get(p_budget_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_any_permission(array['accounting_budgets.read', 'accounting_budgets.manage', 'accounting_budgets.approve']);
begin
  if not exists (select 1 from public.accounting_budgets where id = p_budget_id and company_id = v_company) then
    raise exception 'Budget not found.' using errcode = 'P0002';
  end if;
  return private.accounting_budget_json(p_budget_id);
end;
$$;

create or replace function public.accounting_budget_create(p_any_date date, p_name text, p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_budgets.manage');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  v_fy      text;
  v_start   date;
  v_version int;
  b         public.accounting_budgets;
begin
  if p_any_date is null then
    raise exception 'Choose the financial year.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'The budget name is required (at least 2 characters).' using errcode = '22023';
  end if;
  v_start := private.accounting_fy_start(p_any_date, s.fy_start_month);
  v_fy := private.financial_year(v_start, s.fy_start_month);
  perform pg_advisory_xact_lock(hashtextextended('accounting_budget:' || v_company::text || ':' || v_fy, 0));
  select coalesce(max(version), 0) + 1 into v_version from public.accounting_budgets where company_id = v_company and financial_year = v_fy;
  insert into public.accounting_budgets (company_id, financial_year, fy_start, version, budget_name, notes, created_by, updated_by)
  values (v_company, v_fy, v_start, v_version, left(btrim(p_name), 120), left(nullif(btrim(coalesce(p_notes, '')), ''), 1000), auth.uid(), auth.uid())
  returning * into b;
  perform private.accounting_budget_log(b, 'CREATED', p_notes, '{}'::jsonb);
  return private.accounting_budget_json(b.id);
end;
$$;

-- Replaces the lines of a DRAFT budget. Lines: [{cost_centre_id | cost_centre_code, account_id | account_code, annual, months: [12 amounts] | m01..m12, notes}].
-- Months blank: the annual amount is spread evenly (paise-exact, remainder in the last month). Months given: they must add up to the annual amount
-- (annual blank: the months' total). Every row is validated; nothing is saved if one is wrong.
create or replace function public.accounting_budget_lines_replace(p_budget_id uuid, p_lines jsonb, p_source text default 'MANUAL', p_file_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_budgets.manage');
  b         public.accounting_budgets;
  e         jsonb;
  i         int := 0;
  k         int;
  v_cc      uuid;
  v_acc     uuid;
  v_cls     text;
  v_annual  numeric;
  v_m       numeric[];
  v_given   boolean;
  v_code    text;
  v_errors  text[] := '{}';
  v_total   numeric;
  v_each    numeric;
begin
  select * into b from public.accounting_budgets where id = p_budget_id and company_id = v_company for update;
  if not found then
    raise exception 'Budget not found.' using errcode = 'P0002';
  end if;
  if b.status <> 'DRAFT' then
    raise exception 'Only a draft budget can be edited (this one is %). Create a revision.', lower(b.status) using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Lines must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 20000 then
    raise exception 'A budget can have at most 20,000 lines.' using errcode = '22023';
  end if;
  if upper(coalesce(p_source, 'MANUAL')) not in ('MANUAL', 'IMPORT') then
    raise exception 'Source must be MANUAL or IMPORT.' using errcode = '22023';
  end if;
  create temporary table if not exists pg_temp.accounting_budget_stage (line_no int, cost_centre_id uuid, account_id uuid, annual numeric, m numeric[], notes text)
    on commit drop;
  truncate pg_temp.accounting_budget_stage;
  for e in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    begin
      v_cc := private.accounting_uuid(e, 'cost_centre_id', 'cost centre');
      if v_cc is null then
        v_code := upper(nullif(btrim(coalesce(e ->> 'cost_centre_code', '')), ''));
        select id into v_cc from public.accounting_cost_centres where company_id = v_company and cost_centre_code = v_code;
        if v_cc is null then raise exception 'cost centre % not found', coalesce(v_code, '(blank)'); end if;
      elsif not exists (select 1 from public.accounting_cost_centres where id = v_cc and company_id = v_company) then
        raise exception 'cost centre not found in this company';
      end if;
      if not exists (select 1 from public.accounting_cost_centres where id = v_cc and is_active) then
        raise exception 'cost centre % is inactive', (select cost_centre_code from public.accounting_cost_centres where id = v_cc);
      end if;
      v_acc := private.accounting_uuid(e, 'account_id', 'account');
      if v_acc is null then
        v_code := upper(nullif(btrim(coalesce(e ->> 'account_code', '')), ''));
        select id into v_acc from public.accounts where company_id = v_company and account_code = v_code;
        if v_acc is null then raise exception 'account % not found', coalesce(v_code, '(blank)'); end if;
      elsif not exists (select 1 from public.accounts where id = v_acc and company_id = v_company) then
        raise exception 'account not found in this company';
      end if;
      select classification into v_cls from public.accounts where id = v_acc and is_active;
      if v_cls is null then raise exception 'account % is inactive', (select account_code from public.accounts where id = v_acc); end if;
      if v_cls not in ('INCOME', 'EXPENSE') then
        raise exception 'account % is not an income or expense account', (select account_code from public.accounts where id = v_acc);
      end if;
      v_m := array_fill(0::numeric, array[12]);
      v_given := false;
      for k in 1..12 loop
        if e ? 'months' and jsonb_typeof(e -> 'months') = 'array' and jsonb_array_length(e -> 'months') >= k then
          if jsonb_typeof(e -> 'months' -> (k - 1)) <> 'null' and nullif(btrim(e -> 'months' ->> (k - 1)), '') is not null then
            v_m[k] := private.accounting_amount(jsonb_build_object('v', e -> 'months' -> (k - 1)), 'v', format('month %s', k));
            v_given := true;
          end if;
        elsif nullif(btrim(coalesce(e ->> ('m' || lpad(k::text, 2, '0')), '')), '') is not null then
          v_m[k] := private.accounting_amount(e, 'm' || lpad(k::text, 2, '0'), format('month %s', k));
          v_given := true;
        end if;
      end loop;
      v_total := (select sum(x) from unnest(v_m) x);
      if nullif(btrim(coalesce(e ->> 'annual', e ->> 'annual_amount', '')), '') is null then
        if not v_given then raise exception 'enter the annual budget or the monthly budgets'; end if;
        v_annual := v_total;
      else
        v_annual := private.accounting_amount(jsonb_build_object('v', coalesce(e -> 'annual', e -> 'annual_amount')), 'v', 'annual budget');
        if v_given and v_total <> v_annual then
          raise exception 'the monthly budgets total % but the annual budget is %', to_char(v_total, 'FM999999999999990.00'), to_char(v_annual, 'FM999999999999990.00');
        end if;
        if not v_given then
          v_each := trunc(v_annual / 12, 2);
          v_m := array_fill(v_each, array[12]);
          v_m[12] := v_annual - v_each * 11;
        end if;
      end if;
      insert into pg_temp.accounting_budget_stage values (i, v_cc, v_acc, v_annual, v_m, left(nullif(btrim(coalesce(e ->> 'notes', '')), ''), 300));
    exception when others then
      v_errors := v_errors || format('Row %s: %s', i, sqlerrm);
    end;
    exit when cardinality(v_errors) >= 50;
  end loop;
  for e in select to_jsonb(x) from (select cost_centre_id, account_id, min(line_no) as first_row, count(*) as n from pg_temp.accounting_budget_stage
                                    group by cost_centre_id, account_id having count(*) > 1) x loop
    v_errors := v_errors || format('Row %s: the same cost centre and account appear %s times; combine them into one row.', e ->> 'first_row', e ->> 'n');
  end loop;
  if cardinality(v_errors) > 0 then
    raise exception 'The budget was not saved: %', array_to_string(v_errors[1:10], '; ') using errcode = '22023', detail = array_to_string(v_errors, E'\n');
  end if;
  delete from public.accounting_budget_lines where budget_id = b.id;
  insert into public.accounting_budget_lines (company_id, budget_id, line_no, cost_centre_id, account_id, annual_amount,
    m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, m12, notes)
  select v_company, b.id, line_no, cost_centre_id, account_id, annual, m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], notes
  from pg_temp.accounting_budget_stage order by line_no;
  update public.accounting_budgets set source = case when upper(coalesce(p_source, '')) = 'IMPORT' then 'IMPORT' else source end,
    file_name = case when upper(coalesce(p_source, '')) = 'IMPORT' then left(p_file_name, 200) else file_name end, updated_by = auth.uid(), updated_at = now()
   where id = b.id;
  perform private.accounting_budget_log(b, case when upper(coalesce(p_source, '')) = 'IMPORT' then 'IMPORTED' else 'LINES_SAVED' end, null,
    jsonb_build_object('lines', i, 'file_name', left(p_file_name, 200), 'total', (select sum(annual) from pg_temp.accounting_budget_stage)));
  return private.accounting_budget_json(b.id);
end;
$$;

-- Approves a DRAFT; the previously approved version of the year becomes SUPERSEDED (one approved budget per year).
create or replace function public.accounting_budget_approve(p_budget_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_budgets.approve');
  s         public.accounting_settings := private.accounting_require_setup(v_company);
  b         public.accounting_budgets;
  v_prev    public.accounting_budgets;
begin
  select * into b from public.accounting_budgets where id = p_budget_id and company_id = v_company;
  if not found then
    raise exception 'Budget not found.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('accounting_budget:' || v_company::text || ':' || b.financial_year, 0));
  select * into b from public.accounting_budgets where id = p_budget_id for update;
  if b.status <> 'DRAFT' then
    raise exception 'Only a draft budget can be approved (this one is %).', lower(b.status) using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.accounting_budget_lines where budget_id = b.id) then
    raise exception 'The budget has no lines.' using errcode = 'P0001';
  end if;
  if s.segregation_of_duties and b.created_by = auth.uid() then
    raise exception 'Segregation of duties is on: the budget must be approved by someone other than the person who prepared it.' using errcode = '42501';
  end if;
  select * into v_prev from public.accounting_budgets where company_id = v_company and financial_year = b.financial_year and status = 'APPROVED' for update;
  if found then
    update public.accounting_budgets set status = 'SUPERSEDED', superseded_at = now(), updated_by = auth.uid(), updated_at = now() where id = v_prev.id;
    perform private.accounting_budget_log(v_prev, 'SUPERSEDED', format('Replaced by version %s', b.version), jsonb_build_object('by_version', b.version));
  end if;
  update public.accounting_budgets set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_by = auth.uid(), updated_at = now()
   where id = b.id returning * into b;
  perform private.accounting_budget_log(b, 'APPROVED', p_note, jsonb_build_object('supersedes_version', v_prev.version,
    'total', (select sum(annual_amount) from public.accounting_budget_lines where budget_id = b.id)));
  return private.accounting_budget_json(b.id);
end;
$$;

-- A revision: a new DRAFT version copying an approved (or superseded) budget's lines. The original is not changed.
create or replace function public.accounting_budget_revise(p_budget_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_budgets.manage');
  b         public.accounting_budgets;
  n         public.accounting_budgets;
  v_version int;
begin
  select * into b from public.accounting_budgets where id = p_budget_id and company_id = v_company;
  if not found then
    raise exception 'Budget not found.' using errcode = 'P0002';
  end if;
  if b.status not in ('APPROVED', 'SUPERSEDED') then
    raise exception 'Only an approved or superseded budget can be revised; edit the draft instead.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'A reason of at least 5 characters is required for a revision.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('accounting_budget:' || v_company::text || ':' || b.financial_year, 0));
  if exists (select 1 from public.accounting_budgets where company_id = v_company and financial_year = b.financial_year and status = 'DRAFT') then
    raise exception 'A draft budget for % already exists; finish or cancel it first.', b.financial_year using errcode = 'P0001';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.accounting_budgets where company_id = v_company and financial_year = b.financial_year;
  insert into public.accounting_budgets (company_id, financial_year, fy_start, version, budget_name, notes, source, revision_of_budget_id, created_by, updated_by)
  values (v_company, b.financial_year, b.fy_start, v_version, b.budget_name, left(btrim(p_note), 1000), 'REVISION', b.id, auth.uid(), auth.uid())
  returning * into n;
  insert into public.accounting_budget_lines (company_id, budget_id, line_no, cost_centre_id, account_id, annual_amount, m01, m02, m03, m04, m05, m06, m07, m08,
    m09, m10, m11, m12, notes)
  select company_id, n.id, line_no, cost_centre_id, account_id, annual_amount, m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, m12, notes
  from public.accounting_budget_lines where budget_id = b.id;
  perform private.accounting_budget_log(n, 'REVISED', p_note, jsonb_build_object('revision_of_version', b.version));
  return private.accounting_budget_json(n.id);
end;
$$;

create or replace function public.accounting_budget_cancel(p_budget_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('accounting_budgets.manage');
  b         public.accounting_budgets;
begin
  select * into b from public.accounting_budgets where id = p_budget_id and company_id = v_company for update;
  if not found then
    raise exception 'Budget not found.' using errcode = 'P0002';
  end if;
  if b.status <> 'DRAFT' then
    raise exception 'Only a draft budget can be cancelled.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.' using errcode = '22023';
  end if;
  update public.accounting_budgets set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(btrim(p_reason), 500),
    updated_by = auth.uid(), updated_at = now() where id = b.id returning * into b;
  perform private.accounting_budget_log(b, 'CANCELLED', p_reason, '{}'::jsonb);
  return private.accounting_budget_json(b.id);
end;
$$;


-- -----------------------------------------------------------------------------
-- 11. Grants: signed-in users only (each function checks its permission); never anon or service_role
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.accounting_cost_centre_delete(uuid)',
    'public.accounting_account_set_cost_centre_policy(uuid, text)',
    'public.accounting_general_ledger(uuid, date, date, uuid, uuid)',
    'public.accounting_day_book(date, date, text, uuid)',
    'public.accounting_cost_centre_summary(date, date)',
    'public.accounting_cost_centre_profitability(date, date)',
    'public.accounting_cost_centre_ledger(uuid, date, date, uuid)',
    'public.accounting_budget_vs_actual(text, integer, uuid, uuid)',
    'public.accounting_budgets(text)',
    'public.accounting_budget_get(uuid)',
    'public.accounting_budget_create(date, text, text)',
    'public.accounting_budget_lines_replace(uuid, jsonb, text, text)',
    'public.accounting_budget_approve(uuid, text)',
    'public.accounting_budget_revise(uuid, text)',
    'public.accounting_budget_cancel(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. ERP reset: allocations and budgets are resettable records (cost centres stay with the kept configuration).
--     Allocations of posted vouchers have a delete guard, like voucher lines; the force reset purges them.
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

revoke all on function private.erp_reset_tables() from public, anon, authenticated;
