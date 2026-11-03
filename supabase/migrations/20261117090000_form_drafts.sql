-- =============================================================================
-- Persistent form drafts (auto-save) — one table for every ERP form.
-- =============================================================================
-- Users never lose what they typed when they switch module, page or tab:
-- the browser saves the form's working values here (debounced), and the form
-- restores them when it is reopened.
--
--   * One row per user + company + form (+ the record being edited, + a scope
--     such as "copy of PO X"). Drafts are private to their author: nobody else,
--     not even an administrator, can read them.
--   * Each form key is registered below with the permissions needed to use the
--     form. A draft can be read or written only while the user still holds one
--     of them, is active, and belongs to an active company.
--   * Optimistic concurrency: every save sends the version it last saw. A save
--     against a newer version (another tab or device) is refused as a CONFLICT
--     and the newer draft is returned; nothing is silently overwritten.
--   * Drafts never change ERP records. Submitting a form runs the form's own
--     business function; the draft is closed only after that succeeds.
--   * Closing (submitted / discarded) clears the stored values.
--   * Secrets are refused: keys that look like passwords, tokens, OTPs or card
--     data are rejected, and the size is capped (256 KB).
--   * Writes go through SECURITY DEFINER functions; clients get SELECT only,
--     and RLS limits it to their own drafts in their own company.
--   * The ERP reset deletes drafts with the company's business data.
--
-- Rollback: supabase/rollback/20261117090000_form_drafts_down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Registry of forms that may keep drafts
-- -----------------------------------------------------------------------------
create or replace function private.erp_form_draft_registry()
returns table (form_key text, module text, feature text, permissions text[])
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('product.form',        'Product Master',      'Add / edit product',        array['products.create', 'products.update']),
    ('bom.editor',          'Production',          'Bill of materials',         array['production_bom.create', 'production_bom.update']),
    ('production.order',    'Production',          'Production order',          array['production_order.create', 'production_order.update']),
    ('purchase.order',      'Purchase',            'Supplier purchase order',   array['purchase_order.create', 'purchase_order.update']),
    ('purchase.receipt',    'Purchase',            'Goods receipt (GRN)',       array['purchase_receipt.create']),
    ('sales.order',         'Sales',               'Sales order',               array['sales_orders.create', 'sales_orders.update']),
    ('billing.invoice',     'Finance & GST',       'Sales invoice',             array['invoices.create']),
    ('billing.payment',     'Finance & GST',       'Customer payment',          array['payments.manage']),
    ('ledger.party',        'Ledger',              'Customer / supplier',       array['customers.manage', 'suppliers.manage']),
    ('inventory.opening',   'Inventory',           'Opening stock',             array['inventory_opening.create']),
    ('users.invite',        'Users & Roles',       'Invite user',               array['users.manage'])
  ) t (form_key, module, feature, permissions);
$$;

revoke all on function private.erp_form_draft_registry() from public, anon;

-- True when the signed-in user may keep drafts of this form in this company.
create or replace function private.erp_form_draft_allowed(p_company uuid, p_form_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_company is not null
     and p_company = private.current_company_id()
     and exists (select 1 from private.erp_form_draft_registry() r
                 where r.form_key = p_form_key
                   and exists (select 1 from unnest(r.permissions) p where private.has_permission(p_company, p)));
$$;

revoke all on function private.erp_form_draft_allowed(uuid, text) from public, anon;
grant execute on function private.erp_form_draft_allowed(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Table
-- -----------------------------------------------------------------------------
create table if not exists public.erp_form_drafts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  module        text not null,
  feature       text not null,
  form_key      text not null check (form_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  record_id     uuid,
  scope         text not null default '' check (length(scope) <= 120),
  draft_data    jsonb not null default '{}'::jsonb,
  base_version  text check (length(base_version) <= 100),
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'discarded')),
  version       integer not null default 1 check (version >= 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_saved_at timestamptz not null default now()
);

comment on table public.erp_form_drafts is
  'Auto-saved working values of ERP forms, private to their author. Never business records: submitting a form uses the form''s own functions.';
comment on column public.erp_form_drafts.base_version is
  'Version (updated_at) of the record being edited when the draft was started; an older draft is not restored over a newer record.';

-- One row per user, company, form, record and scope (reused after submit / discard).
create unique index if not exists erp_form_drafts_key
  on public.erp_form_drafts (company_id, user_id, form_key, coalesce(record_id, '00000000-0000-0000-0000-000000000000'::uuid), scope);
create index if not exists erp_form_drafts_user_open
  on public.erp_form_drafts (user_id, company_id, updated_at desc) where status = 'draft';

drop trigger if exists erp_form_drafts_updated_at on public.erp_form_drafts;
create trigger erp_form_drafts_updated_at before update on public.erp_form_drafts
  for each row execute function private.set_updated_at();

alter table public.erp_form_drafts enable row level security;

drop policy if exists erp_form_drafts_select_own on public.erp_form_drafts;
create policy erp_form_drafts_select_own on public.erp_form_drafts
  for select to authenticated
  using (user_id = (select auth.uid()) and private.erp_form_draft_allowed(company_id, form_key));

revoke all on public.erp_form_drafts from public, anon, authenticated;
grant select on public.erp_form_drafts to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Functions (the only write path)
-- -----------------------------------------------------------------------------
-- Common checks; returns the caller's company.
create or replace function private.erp_form_draft_context(p_form_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if auth.uid() is null or v_company is null then
    raise exception 'Your account is not active in a company.' using errcode = '42501';
  end if;
  if not exists (select 1 from private.erp_form_draft_registry() r where r.form_key = p_form_key) then
    raise exception 'Unknown form %.', p_form_key using errcode = '22023';
  end if;
  if not private.erp_form_draft_allowed(v_company, p_form_key) then
    raise exception 'You are not allowed to use this form.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

revoke all on function private.erp_form_draft_context(text) from public, anon;
grant execute on function private.erp_form_draft_context(text) to authenticated;

create or replace function private.erp_form_draft_row(p_company uuid, p_form_key text, p_record_id uuid, p_scope text)
returns public.erp_form_drafts
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.erp_form_drafts d
  where d.company_id = p_company and d.user_id = auth.uid() and d.form_key = p_form_key
    and d.record_id is not distinct from p_record_id and d.scope = coalesce(p_scope, '');
$$;

revoke all on function private.erp_form_draft_row(uuid, text, uuid, text) from public, anon;
grant execute on function private.erp_form_draft_row(uuid, text, uuid, text) to authenticated;

create or replace function private.erp_form_draft_json(d public.erp_form_drafts)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when d.id is null then null else jsonb_build_object(
    'id', d.id, 'form_key', d.form_key, 'record_id', d.record_id, 'scope', d.scope, 'status', d.status, 'version', d.version,
    'data', case when d.status = 'draft' then d.draft_data else null end, 'base_version', d.base_version,
    'last_saved_at', d.last_saved_at, 'created_at', d.created_at) end;
$$;

-- The caller's draft for a form (null when none). Closed drafts are returned
-- without data so the browser knows the current version.
create or replace function public.erp_form_draft_get(p_form_key text, p_record_id uuid default null, p_scope text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.erp_form_draft_context(p_form_key);
begin
  -- Only the signed-in author's own draft (erp_form_draft_row filters on auth.uid() too).
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return private.erp_form_draft_json(private.erp_form_draft_row(v_company, p_form_key, p_record_id, p_scope));
end;
$$;

-- Saves the draft when p_expected_version is still current (0 = the browser has no
-- draft yet). Returns {status: 'SAVED', draft} or {status: 'CONFLICT', draft} where
-- draft is the newer stored draft.
create or replace function public.erp_form_draft_save(
  p_form_key text, p_record_id uuid, p_scope text, p_data jsonb, p_base_version text, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.erp_form_draft_context(p_form_key);
  v_reg record;
  v_row public.erp_form_drafts;
  v_scope text := coalesce(p_scope, '');
begin
  if p_data is null or jsonb_typeof(p_data) not in ('object', 'array') then
    raise exception 'The draft must be a JSON object.' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 262144 then
    raise exception 'This draft is too large to save (256 KB at most).' using errcode = '22023';
  end if;
  -- No credentials or secrets in drafts.
  if p_data::text ~* '"[^"]*(password|passwd|passcode|secret|token|otp|cvv|card_?number|api_?key|private_?key)[^"]*"\s*:' then
    raise exception 'Drafts cannot contain passwords, tokens or other secrets.' using errcode = '22023';
  end if;
  if length(v_scope) > 120 or length(p_base_version) > 100 then
    raise exception 'Invalid draft scope.' using errcode = '22023';
  end if;
  select * into v_reg from private.erp_form_draft_registry() r where r.form_key = p_form_key;

  select * into v_row from public.erp_form_drafts d
  where d.company_id = v_company and d.user_id = auth.uid() and d.form_key = p_form_key
    and d.record_id is not distinct from p_record_id and d.scope = v_scope
  for update;

  -- No row (or it was removed by an ERP reset): start a new draft.
  if not found then
    insert into public.erp_form_drafts (company_id, user_id, module, feature, form_key, record_id, scope, draft_data, base_version)
    values (v_company, auth.uid(), v_reg.module, v_reg.feature, p_form_key, p_record_id, v_scope, p_data, p_base_version)
    returning * into v_row;
    return jsonb_build_object('status', 'SAVED', 'draft', private.erp_form_draft_json(v_row));
  end if;

  -- Another tab or device saved (or submitted / discarded) since this browser last looked.
  if v_row.version <> coalesce(p_expected_version, 0)
     and not (v_row.status <> 'draft' and coalesce(p_expected_version, 0) = 0) then
    return jsonb_build_object('status', 'CONFLICT', 'draft', private.erp_form_draft_json(v_row));
  end if;

  update public.erp_form_drafts
     set draft_data = p_data, base_version = p_base_version, status = 'draft', version = version + 1,
         last_saved_at = now(), module = v_reg.module, feature = v_reg.feature
   where id = v_row.id
  returning * into v_row;
  return jsonb_build_object('status', 'SAVED', 'draft', private.erp_form_draft_json(v_row));
end;
$$;

-- Closes the draft after the form was submitted successfully ('submitted') or
-- when the user discards it ('discarded'). The stored values are cleared.
create or replace function public.erp_form_draft_close(p_form_key text, p_record_id uuid, p_scope text, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.erp_form_draft_context(p_form_key);
  v_row public.erp_form_drafts;
begin
  if p_status not in ('submitted', 'discarded') then
    raise exception 'Status must be submitted or discarded.' using errcode = '22023';
  end if;
  update public.erp_form_drafts d
     set status = p_status, draft_data = '{}'::jsonb, version = d.version + 1
   where d.company_id = v_company and d.user_id = auth.uid() and d.form_key = p_form_key
     and d.record_id is not distinct from p_record_id and d.scope = coalesce(p_scope, '') and d.status = 'draft'
  returning * into v_row;
  return coalesce(private.erp_form_draft_json(v_row), jsonb_build_object('status', p_status, 'version', 0));
end;
$$;

-- The caller's open drafts in their company (for a "resume where you left off" list).
create or replace function public.erp_form_drafts_mine()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('form_key', d.form_key, 'module', d.module, 'feature', d.feature, 'record_id', d.record_id,
      'scope', d.scope, 'last_saved_at', d.last_saved_at, 'version', d.version) order by d.last_saved_at desc), '[]'::jsonb)
  from public.erp_form_drafts d
  where d.user_id = auth.uid() and d.status = 'draft' and private.erp_form_draft_allowed(d.company_id, d.form_key);
$$;

revoke all on function private.erp_form_draft_json(public.erp_form_drafts) from public, anon;
grant execute on function private.erp_form_draft_json(public.erp_form_drafts) to authenticated;
revoke all on function public.erp_form_draft_get(text, uuid, text) from public, anon;
revoke all on function public.erp_form_draft_save(text, uuid, text, jsonb, text, integer) from public, anon;
revoke all on function public.erp_form_draft_close(text, uuid, text, text) from public, anon;
revoke all on function public.erp_form_drafts_mine() from public, anon;
grant execute on function public.erp_form_draft_get(text, uuid, text) to authenticated;
grant execute on function public.erp_form_draft_save(text, uuid, text, jsonb, text, integer) to authenticated;
grant execute on function public.erp_form_draft_close(text, uuid, text, text) to authenticated;
grant execute on function public.erp_form_drafts_mine() to authenticated;

-- -----------------------------------------------------------------------------
-- 4. ERP reset: drafts are deleted with the company's business data
-- (same list as 20261111090000 plus erp_form_drafts).
-- -----------------------------------------------------------------------------
create or replace function private.erp_reset_tables()
returns table (ord int, table_name text, category text, label text)
language sql
stable
set search_path = ''
as $$
  select * from (values
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

notify pgrst, 'reload schema';
