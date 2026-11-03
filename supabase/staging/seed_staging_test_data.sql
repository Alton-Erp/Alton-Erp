-- =============================================================================
-- STAGING ONLY: test companies, test accounts and test master data (Phase 12)
--
-- Run in the STAGING project: Dashboard > SQL Editor, after all migrations.
-- NEVER run this on production. It refuses to run when:
--   * the three settings below were not edited, or
--   * the database holds issued invoices of any company that is not a test
--     company (code starting with STG-), i.e. it looks like production.
--
-- Before running, create these Auth users in Dashboard > Authentication > Users
-- > "Add user" (tick "Auto Confirm User"), each with the shared TEST password
-- you keep only in your local .env.staging as STAGING_TEST_PASSWORD:
--
--   <prefix>+stg-superadmin@<domain>   SUPER_ADMIN         company STG-A
--   <prefix>+stg-admin@<domain>        ADMIN               company STG-A
--   <prefix>+stg-inventory@<domain>    INVENTORY_MANAGER   company STG-A
--   <prefix>+stg-production@<domain>   PRODUCTION_MANAGER  company STG-A
--   <prefix>+stg-purchase@<domain>     PURCHASE_MANAGER    company STG-A
--   <prefix>+stg-sales@<domain>        SALES_MANAGER       company STG-A
--   <prefix>+stg-accounts@<domain>     ACCOUNTS_MANAGER    company STG-A
--   <prefix>+stg-viewer@<domain>       MANAGEMENT_VIEWER   company STG-A
--   <prefix>+stg-inactive@<domain>     SALES_MANAGER       company STG-A, DEACTIVATED
--   <prefix>+stg-b-admin@<domain>      ADMIN               company STG-B
--
-- Using one real mailbox with "+" addressing (e.g. it.team+stg-admin@...) lets
-- you receive the password-reset test email. All names, GSTINs and amounts
-- below are fictitious test values; no real customer or financial data is used.
--
-- Re-runnable: existing rows are kept, missing ones are added.
-- =============================================================================

-- >>> EDIT THESE THREE LINES <<<
select set_config('app.stg_email_prefix', 'your.mailbox', false);   -- part before "+" (e.g. it.team)
select set_config('app.stg_email_domain', 'yourcompany.example', false); -- mailbox domain
select set_config('app.allow_staging_seed', 'no', false);           -- change to 'yes' to confirm this is STAGING
-- >>> END OF EDITS <<<

do $$
declare
  v_prefix text := current_setting('app.stg_email_prefix', true);
  v_domain text := current_setting('app.stg_email_domain', true);
  v_missing text;
  v_a uuid;
  v_b uuid;
  v_w uuid;
begin
  if coalesce(current_setting('app.allow_staging_seed', true), '') <> 'yes' then
    raise exception 'Staging seed not confirmed: set app.allow_staging_seed to ''yes'' at the top of this file (STAGING ONLY).';
  end if;
  if v_prefix is null or v_prefix in ('', 'your.mailbox') or v_domain is null or v_domain in ('', 'yourcompany.example') then
    raise exception 'Edit app.stg_email_prefix and app.stg_email_domain at the top of this file first.';
  end if;
  if exists (select 1 from public.sales_invoices i join public.companies c on c.id = i.company_id
             where c.company_code not like 'STG-%' and i.status <> 'DRAFT') then
    raise exception 'Refusing to run: this database contains issued invoices of a non-test company. It looks like PRODUCTION.';
  end if;

  create temporary table stg_accounts (tag text primary key, company_code text not null, role_code text not null, active boolean not null, full_name text not null) on commit drop;
  insert into stg_accounts values
    ('stg-superadmin', 'STG-A', 'SUPER_ADMIN', true, 'Staging Super Admin (TEST)'),
    ('stg-admin', 'STG-A', 'ADMIN', true, 'Staging Admin (TEST)'),
    ('stg-inventory', 'STG-A', 'INVENTORY_MANAGER', true, 'Staging Inventory Manager (TEST)'),
    ('stg-production', 'STG-A', 'PRODUCTION_MANAGER', true, 'Staging Production Manager (TEST)'),
    ('stg-purchase', 'STG-A', 'PURCHASE_MANAGER', true, 'Staging Purchase Manager (TEST)'),
    ('stg-sales', 'STG-A', 'SALES_MANAGER', true, 'Staging Sales Manager (TEST)'),
    ('stg-accounts', 'STG-A', 'ACCOUNTS_MANAGER', true, 'Staging Accounts Manager (TEST)'),
    ('stg-viewer', 'STG-A', 'MANAGEMENT_VIEWER', true, 'Staging Viewer (TEST)'),
    ('stg-inactive', 'STG-A', 'SALES_MANAGER', false, 'Staging Deactivated User (TEST)'),
    ('stg-b-admin', 'STG-B', 'ADMIN', true, 'Staging Company B Admin (TEST)');

  select string_agg(format('%s+%s@%s', v_prefix, a.tag, v_domain), ', ' order by a.tag) into v_missing
  from stg_accounts a where not exists (select 1 from auth.users u where lower(u.email) = lower(format('%s+%s@%s', v_prefix, a.tag, v_domain)));
  if v_missing is not null then
    raise exception 'Create these Auth users first (Authentication > Users > Add user, auto-confirm): %', v_missing;
  end if;

  -- Companies (fictitious GSTINs, clearly marked TEST)
  insert into public.companies (legal_name, display_name, company_code, legal_address, state, gstin)
  values ('Staging Test Company A Pvt Ltd (TEST)', 'Staging A (TEST)', 'STG-A', 'Test Plot 1, Test Industrial Area, Pune 411001', 'Maharashtra', '27ZZTST9999Z1Z1'),
         ('Staging Test Company B Pvt Ltd (TEST)', 'Staging B (TEST)', 'STG-B', 'Test Plot 2, Test Industrial Area, Bengaluru 560001', 'Karnataka', '29ZZTST9999Z1Z2')
  on conflict (company_code) do nothing;
  select id into v_a from public.companies where company_code = 'STG-A';
  select id into v_b from public.companies where company_code = 'STG-B';

  -- Accounts: company, status, roles
  update public.profiles p set company_id = c.id, is_active = true, full_name = a.full_name
  from stg_accounts a join public.companies c on c.company_code = a.company_code, auth.users u
  where lower(u.email) = lower(format('%s+%s@%s', v_prefix, a.tag, v_domain)) and p.id = u.id;
  insert into public.user_roles (user_id, company_id, role_id)
  select u.id, c.id, r.id from stg_accounts a join public.companies c on c.company_code = a.company_code join public.roles r on r.code = a.role_code
  join auth.users u on lower(u.email) = lower(format('%s+%s@%s', v_prefix, a.tag, v_domain))
  on conflict (user_id, company_id, role_id) do nothing;
  update public.profiles p set is_active = false
  from stg_accounts a, auth.users u where not a.active and lower(u.email) = lower(format('%s+%s@%s', v_prefix, a.tag, v_domain)) and p.id = u.id;

  -- Master data used by scripts/concurrency-check.mjs and the manual checks
  insert into public.warehouses (company_id, warehouse_code, warehouse_name, is_default) values
    (v_a, 'STG-W1', 'Staging main store (TEST)', true), (v_b, 'STG-WB', 'Staging B store (TEST)', true)
  on conflict (company_id, warehouse_code) do nothing;
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, hsn_code, gst_rate, selling_price, status)
  select v_a, 'STG-CONC-1', 'Concurrency test basin (TEST)', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '6910', 18, 100, 'ACTIVE'
  where not exists (select 1 from public.products where company_id = v_a and lower(sku) = 'stg-conc-1');
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, hsn_code, gst_rate, selling_price, status)
  select v_b, 'STG-B-1', 'Company B test item (TEST)', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '6910', 18, 100, 'ACTIVE'
  where not exists (select 1 from public.products where company_id = v_b and lower(sku) = 'stg-b-1');
  insert into public.customers (company_id, customer_code, customer_name, legal_name, gstin, gst_registration_type, billing_address, billing_state_code, payment_terms_days) values
    (v_a, 'STG-CUST-1', 'Test Customer One (TEST)', 'Test Customer One LLP (TEST)', '27ZZCUS9999Z1Z3', 'REGISTERED', 'Test Road 1, Pune', '27', 30),
    (v_b, 'STG-B-CUST', 'Company B Test Customer (TEST)', null, null, 'UNREGISTERED', 'Test Road 2, Bengaluru', '29', 30)
  on conflict (company_id, customer_code) do nothing;

  raise notice 'Staging test data ready: companies STG-A and STG-B, 10 test accounts, warehouse STG-W1, product STG-CONC-1, customer STG-CUST-1.';
end $$;

-- Summary (nothing secret): the test accounts and their roles
select c.company_code, p.full_name, p.is_active, string_agg(r.code, ', ') as roles
from public.profiles p join public.companies c on c.id = p.company_id
left join public.user_roles ur on ur.user_id = p.id and ur.company_id = c.id left join public.roles r on r.id = ur.role_id
where c.company_code like 'STG-%' group by 1, 2, 3 order by 1, 2;
