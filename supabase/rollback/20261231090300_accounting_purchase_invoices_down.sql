-- Rollback of 20261231090300_accounting_purchase_invoices.
--
-- Drops the supplier-invoice tables, functions, permissions, posting-rule keys, the PIN voucher type (when unused), the two
-- tolerance settings, and restores the chart seed, posting-rule save, documents functions and ERP reset list of the previous
-- migrations exactly. Ledgers created for supplier invoices (Input CGST / SGST / IGST / cess, Purchase Price Variance, Ineligible
-- Input GST, GST Payable under Reverse Charge) stay: they may carry posted entries. Purchase orders, goods receipts and supplier
-- payments were never changed. audit_logs entries stay (append-only).
--
-- Refused while supplier invoices or payment allocations exist (dropping them loses invoice records whose vouchers stay posted).
-- To roll back anyway, export them, then   set app.accounting_purchase_invoice_rollback_force = 'on';   in the same session.

do $$
begin
  if coalesce(current_setting('app.accounting_purchase_invoice_rollback_force', true), '') <> 'on' and to_regclass('public.purchase_invoices') is not null
     and (exists (select 1 from public.purchase_invoices) or exists (select 1 from public.supplier_payment_allocations)) then
    raise exception 'Supplier invoices exist. Export them, then set app.accounting_purchase_invoice_rollback_force = on to roll back.';
  end if;
end;
$$;

drop function if exists public.purchase_invoice_save(uuid, jsonb, integer);
drop function if exists public.purchase_invoice_get(uuid);
drop function if exists public.purchase_invoice_submit(uuid);
drop function if exists public.purchase_invoice_approve(uuid, text, boolean);
drop function if exists public.purchase_invoice_return_to_draft(uuid, text);
drop function if exists public.purchase_invoice_cancel(uuid, text);
drop function if exists public.purchase_invoice_post(uuid);
drop function if exists public.purchase_invoice_verify_gst(uuid, text, text, jsonb);
drop function if exists public.purchase_invoice_reverse(uuid, text);
drop function if exists public.purchase_invoice_allocate_payment(uuid, uuid, numeric);
drop function if exists public.purchase_invoice_unallocate_payment(uuid, text);
drop function if exists public.purchase_invoice_list(jsonb);
drop function if exists public.purchase_invoice_matching_candidates(uuid, uuid, boolean);
drop function if exists public.purchase_invoice_supplier_payments(uuid);
drop function if exists public.purchase_invoice_settings_save(jsonb);
drop function if exists public.purchase_invoice_report(text, jsonb);
drop function if exists public.purchase_invoice_lookups();
drop function if exists private.pi_json(uuid);
drop function if exists private.pi_lock(uuid, uuid, text[]);
drop function if exists private.pi_issues(uuid);
drop function if exists private.pi_recalculate(uuid);
drop function if exists private.pi_log(public.purchase_invoices, text, text, jsonb);
drop function if exists private.pi_outstanding(uuid);
drop function if exists private.pi_grn_in_books(uuid);
drop function if exists private.pi_grn_invoiced(uuid, uuid);
drop function if exists private.pi_grn_line(uuid);
drop function if exists private.pi_number_key(text);

-- Functions as the previous migrations left them.
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

create or replace function private.document_entity(p_company uuid, p_type text, p_id uuid)
returns table (reference text, read_permission text, link text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select x.reference, x.perm, x.link from (
    select p.sku as reference, 'products.read' as perm, '/products/' || p.id as link from public.products p where p_type = 'PRODUCT' and p.id = p_id and p.company_id = p_company
    union all select coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku, 'inventory.read', '/inventory/stock/' || p.id
      from public.inventory_batches b join public.products p on p.id = b.product_id where p_type = 'BATCH' and b.id = p_id and b.company_id = p_company
    union all select w.warehouse_code, 'inventory.read', '/inventory/warehouses' from public.warehouses w where p_type = 'WAREHOUSE' and w.id = p_id and w.company_id = p_company
    union all select o.production_order_number, 'manufacturing.read', '/production/orders/' || o.id from public.production_orders o where p_type = 'PRODUCTION_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.outsourcing_order_number, 'outsourcing.read', '/production/outsourcing/' || o.id from public.outsourcing_orders o where p_type = 'OUTSOURCING_ORDER' and o.id = p_id and o.company_id = p_company
    union all select o.customer_po_number || ' (' || o.po_reference || ')', 'customer_po.read', '/customer-pos/' || o.id from public.customer_purchase_orders o where p_type = 'CUSTOMER_PO' and o.id = p_id and o.company_id = p_company
    union all select s.sales_order_number, 'sales_orders.read', '/sales/order-details?so=' || s.id from public.sales_orders s where p_type = 'SALES_ORDER' and s.id = p_id and s.company_id = p_company
    union all select f.fulfilment_number, 'fulfilment.read', '/sales/delivery?f=' || f.id from public.fulfilments f where p_type = 'DISPATCH' and f.id = p_id and f.company_id = p_company
    union all select coalesce(i.invoice_number, 'Draft invoice'), 'invoices.read', '/billing/invoices/' || i.id from public.sales_invoices i where p_type = 'INVOICE' and i.id = p_id and i.company_id = p_company
    union all select coalesce(n.note_number, 'Draft note'), 'invoices.read', '/billing/notes/' || n.id from public.invoice_adjustment_notes n where p_type = 'ADJUSTMENT_NOTE' and n.id = p_id and n.company_id = p_company
    union all select c.customer_code || ' — ' || c.customer_name, 'customers.read', '/customers' from public.customers c where p_type = 'CUSTOMER' and c.id = p_id and c.company_id = p_company
    union all select c.legal_name, 'settings.manage', '/settings' from public.companies c where p_type = 'COMPANY' and c.id = p_id and c.id = p_company
    union all select o.po_number, 'purchases.read', '/purchase-orders/' || o.id from public.purchase_orders o where p_type = 'SUPPLIER_PO' and o.id = p_id and o.company_id = p_company
    union all select g.receipt_number, 'purchases.read', '/goods-receipts/' || g.id from public.goods_receipts g where p_type = 'GOODS_RECEIPT' and g.id = p_id and g.company_id = p_company
    union all select a.adjustment_number, 'inventory.read', '/inventory/adjustments?adj=' || a.id from public.inventory_adjustments a where p_type = 'STOCK_ADJUSTMENT' and a.id = p_id and a.company_id = p_company
  ) x;
end;
$$;

create or replace function private.document_entity_permission(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'PRODUCT' then 'products.read' when 'BATCH' then 'inventory.read' when 'WAREHOUSE' then 'inventory.read'
    when 'PRODUCTION_ORDER' then 'manufacturing.read' when 'OUTSOURCING_ORDER' then 'outsourcing.read' when 'CUSTOMER_PO' then 'customer_po.read'
    when 'SALES_ORDER' then 'sales_orders.read' when 'DISPATCH' then 'fulfilment.read' when 'INVOICE' then 'invoices.read'
    when 'ADJUSTMENT_NOTE' then 'invoices.read' when 'CUSTOMER' then 'customers.read' when 'COMPANY' then 'settings.manage'
    when 'SUPPLIER_PO' then 'purchases.read' when 'GOODS_RECEIPT' then 'purchases.read'
    when 'STOCK_ADJUSTMENT' then 'inventory.read' end;
$$;

create or replace function public.document_entity_search(p_entity_type text, p_term text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_permission('documents.read');
  v_t       text := '%' || replace(replace(btrim(coalesce(p_term, '')), '%', ''), '_', '') || '%';
begin
  if private.document_entity_permission(p_entity_type) is null or not private.has_permission(v_company, private.document_entity_permission(p_entity_type)) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'reference', reference)) from (
    select p.id, p.sku || ' — ' || p.product_name as reference from public.products p where p_entity_type = 'PRODUCT' and p.company_id = v_company and (p.sku ilike v_t or p.product_name ilike v_t)
    union all select b.id, coalesce(b.batch_number, 'Untracked lot') || ' · ' || p.sku from public.inventory_batches b join public.products p on p.id = b.product_id
      where p_entity_type = 'BATCH' and b.company_id = v_company and (b.batch_number ilike v_t or p.sku ilike v_t)
    union all select w.id, w.warehouse_code || ' — ' || w.warehouse_name from public.warehouses w where p_entity_type = 'WAREHOUSE' and w.company_id = v_company and (w.warehouse_code ilike v_t or w.warehouse_name ilike v_t)
    union all select o.id, o.production_order_number from public.production_orders o where p_entity_type = 'PRODUCTION_ORDER' and o.company_id = v_company and o.production_order_number ilike v_t
    union all select o.id, o.outsourcing_order_number || ' · ' || o.supplier_name from public.outsourcing_orders o where p_entity_type = 'OUTSOURCING_ORDER' and o.company_id = v_company and (o.outsourcing_order_number ilike v_t or o.supplier_name ilike v_t)
    union all select o.id, o.customer_po_number || ' (' || o.po_reference || ')' from public.customer_purchase_orders o where p_entity_type = 'CUSTOMER_PO' and o.company_id = v_company and o.is_current and (o.customer_po_number ilike v_t or o.po_reference ilike v_t)
    union all select s.id, s.sales_order_number || ' · ' || s.customer_name_snapshot from public.sales_orders s where p_entity_type = 'SALES_ORDER' and s.company_id = v_company and (s.sales_order_number ilike v_t or s.customer_name_snapshot ilike v_t)
    union all select f.id, f.fulfilment_number from public.fulfilments f where p_entity_type = 'DISPATCH' and f.company_id = v_company and f.fulfilment_number ilike v_t
    union all select i.id, coalesce(i.invoice_number, 'Draft') || ' · ' || i.customer_legal_name from public.sales_invoices i where p_entity_type = 'INVOICE' and i.company_id = v_company and i.status <> 'DISCARDED' and (i.invoice_number ilike v_t or i.customer_legal_name ilike v_t)
    union all select n.id, coalesce(n.note_number, 'Draft note') from public.invoice_adjustment_notes n where p_entity_type = 'ADJUSTMENT_NOTE' and n.company_id = v_company and n.status <> 'DISCARDED' and coalesce(n.note_number, '') ilike v_t
    union all select c.id, c.customer_code || ' — ' || c.customer_name from public.customers c where p_entity_type = 'CUSTOMER' and c.company_id = v_company and (c.customer_code ilike v_t or c.customer_name ilike v_t)
    union all select c.id, c.legal_name from public.companies c where p_entity_type = 'COMPANY' and c.id = v_company
    union all select o.id, o.po_number || ' · ' || o.supplier_name from public.purchase_orders o where p_entity_type = 'SUPPLIER_PO' and o.company_id = v_company and (o.po_number ilike v_t or o.supplier_name ilike v_t)
    union all select g.id, g.receipt_number from public.goods_receipts g where p_entity_type = 'GOODS_RECEIPT' and g.company_id = v_company and g.receipt_number ilike v_t
    union all select a.id, a.adjustment_number from public.inventory_adjustments a where p_entity_type = 'STOCK_ADJUSTMENT' and a.company_id = v_company and a.adjustment_number ilike v_t
    limit 20) x), '[]'::jsonb);
end;
$$;

create or replace function private.erp_reset_document_entity_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['BATCH', 'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER',
    'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT'];
$$;

drop function if exists private.accounting_seed_purchase_invoices(uuid);

drop trigger if exists goods_receipts_invoice_lock on public.goods_receipts;
drop function if exists private.goods_receipt_invoice_lock();
drop table if exists public.supplier_payment_allocations;
drop table if exists public.purchase_invoice_history;
drop table if exists public.purchase_invoice_allocations;
drop table if exists public.purchase_invoice_lines;
drop table if exists public.purchase_invoices;
drop function if exists private.purchase_invoice_guard();
drop function if exists private.purchase_invoice_allocation_guard();
drop function if exists private.supplier_payment_allocation_guard();

-- Posting rules and the voucher type of supplier invoices; the rule-key list as 20261231090000 defined it.
delete from public.accounting_posting_rules where rule_key in ('PURCHASE_PRICE_VARIANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'INPUT_CESS', 'GST_INPUT_INELIGIBLE', 'RCM_GST_PAYABLE');
alter table public.accounting_posting_rules drop constraint if exists accounting_posting_rules_rule_key_pi_check;
alter table public.accounting_posting_rules add constraint accounting_posting_rules_rule_key_check check (rule_key in ('DEBTORS', 'CREDITORS', 'SALES', 'SALES_RETURNS',
  'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'ROUND_OFF', 'PURCHASES', 'GST_INPUT_PENDING', 'RECEIPT_ACCOUNT', 'SUPPLIER_PAYMENT_ACCOUNT'));
delete from public.accounting_voucher_sequences where voucher_type_id in (select t.id from public.accounting_voucher_types t where t.type_code = 'PIN'
  and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id));
delete from public.accounting_voucher_types t where t.type_code = 'PIN' and not exists (select 1 from public.accounting_vouchers v where v.voucher_type_id = t.id);

alter table public.accounting_settings drop constraint if exists accounting_settings_pi_tolerance_check;
alter table public.accounting_settings drop column if exists pi_price_tolerance_percent;
alter table public.accounting_settings drop column if exists pi_amount_tolerance;

-- Documents: the entity-type list without PURCHASE_INVOICE (kept when supplier-invoice documents still exist, so none is lost).
do $$
begin
  if not exists (select 1 from public.documents where related_entity_type = 'PURCHASE_INVOICE') then
    execute (select format('alter table public.documents drop constraint %I', conname) from pg_constraint
             where conrelid = 'public.documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%related_entity_type%' limit 1);
    alter table public.documents add constraint documents_related_entity_type_check check (related_entity_type in ('PRODUCT', 'BATCH', 'WAREHOUSE',
      'PRODUCTION_ORDER', 'OUTSOURCING_ORDER', 'CUSTOMER_PO', 'SALES_ORDER', 'DISPATCH', 'INVOICE', 'ADJUSTMENT_NOTE', 'CUSTOMER', 'COMPANY',
      'SUPPLIER_PO', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT'));
  else
    raise notice 'Supplier-invoice documents exist: the documents entity-type list keeps PURCHASE_INVOICE.';
  end if;
end;
$$;

delete from public.role_permissions where permission_id in (select id from public.permissions where resource = 'purchase_invoices');
delete from public.permissions where resource = 'purchase_invoices';

-- ERP reset list as 20261231090200 left it.
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
