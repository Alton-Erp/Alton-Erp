-- =============================================================================
-- ERP FORCE RESET VERIFICATION
--
-- Executable checks for migration 20261031090000_erp_force_reset.sql:
-- classification and deletion order from the live catalogue; the guard
-- exemption works only inside a force purge of the same company in the same
-- transaction; grants; preview; backup records; environment approval;
-- password ticket; denied / blocked / completed / replayed / failed runs;
-- protected history (posted stock with a reversal, issued invoice, payment,
-- approved BOM, approval decision, import history) deleted for the target
-- company only; retained data, other companies, Super Admins and schema
-- unchanged; Storage files listed and verified; demo_presentation_data and
-- unreviewed tables.
--
--   locally:      npm run test:db   (DB_SUITE=erp_force for this suite only)
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (FRA / FRB / FRC) and users
-- (@fr.example.invalid) and ALWAYS ends by raising
--   ERP_FORCE_RESET_VERIFICATION_RESULT passed=N failed=M
-- so every test row is rolled back. It deletes only rows of its own companies.
-- =============================================================================

begin;

create schema rls_test;
grant usage on schema rls_test to anon, authenticated, service_role;

create table rls_test.results (id serial primary key, name text not null, passed boolean not null, detail text);
create table rls_test.ids (key text primary key, id uuid not null);
create table rls_test.vars (key text primary key, value jsonb);
grant select, insert on rls_test.results to anon, authenticated, service_role;
grant usage on sequence rls_test.results_id_seq to anon, authenticated, service_role;
grant select on rls_test.ids to anon, authenticated, service_role;
grant select, insert, update on rls_test.vars to anon, authenticated, service_role;

create function rls_test.id(p_key text) returns uuid language sql stable as $$ select id from rls_test.ids where key = p_key $$;
create function rls_test.ok(p_name text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin insert into rls_test.results (name, passed, detail) values (p_name, coalesce(p_cond, false), p_detail); end $$;
create function rls_test.call(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute p_sql into r; return coalesce(r, '{}'::jsonb);
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate); end $$;
create function rls_test.set(p_key text, p_value jsonb) returns jsonb language plpgsql as $$
begin insert into rls_test.vars values (p_key, p_value) on conflict (key) do update set value = excluded.value; return p_value; end $$;
create function rls_test.get(p_key text) returns jsonb language sql stable as $$ select value from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error' and r ->> 'sqlstate' is not null), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ->> 'sqlstate' is not null and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

-- Owner-side probes (bypass RLS).
create function rls_test.n(p_table text, p_company uuid) returns bigint language plpgsql stable security definer as $$
declare v bigint; begin execute format('select count(*) from public.%I where company_id = $1', p_table) into v using p_company; return v; end $$;
create function rls_test.company_rows(p_company uuid) returns jsonb language plpgsql stable security definer as $$
declare v jsonb := '{}'::jsonb; v_n bigint; r record;
begin
  for r in select c.relname::text t from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r'
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = c.relname and column_name = 'company_id')
           order by 1 loop
    execute format('select count(*) from public.%I where company_id = $1', r.t) into v_n using p_company;
    v := v || jsonb_build_object(r.t, v_n);
  end loop;
  return v;
end $$;
create function rls_test.purge_left(p_company uuid) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(private.erp_force_reset_counts(p_company) -> 'purge') where value::bigint <> 0 $$;
create function rls_test.audits(p_company uuid, p_action text) returns bigint language sql stable security definer as $$
  select count(*) from public.audit_logs where company_id = p_company and action = p_action $$;
create function rls_test.fingerprint() returns jsonb language sql stable security definer as $$ select private.erp_reset_schema_fingerprint() $$;
create function rls_test.ticket(p_user text, p_company text) returns text language sql security definer as $$
  select public.erp_force_reset_issue_ticket(rls_test.id(p_user), rls_test.id(p_company)) ->> 'ticket' $$;
create function rls_test.exec_sql(p_company text, p_request text, p_ticket text, p_code text, p_confirm text default 'DELETE ALL COMPANY DATA') returns text language sql stable as $$
  select format($q$ select public.erp_force_reset_execute(%L, %L, %L, %L, null, %L) $q$,
                rls_test.id(p_company), rls_test.id(p_request), p_confirm, p_code, p_ticket) $$;

grant execute on all functions in schema rls_test to anon, authenticated, service_role;
revoke execute on function rls_test.ticket(text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures (database owner)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'f0e5e900-0000-4000-8000-0000000000a1'), ('company_b', 'f0e5e900-0000-4000-8000-0000000000b1'),
  ('company_c', 'f0e5e900-0000-4000-8000-0000000000c1'),
  ('a_sa',   'f0e5e900-0000-4000-8000-000000000001'),  -- Super Admin A
  ('b_sa',   'f0e5e900-0000-4000-8000-000000000002'),  -- Super Admin B (initiator)
  ('b_sa2',  'f0e5e900-0000-4000-8000-000000000003'),  -- second Super Admin B
  ('b_adm',  'f0e5e900-0000-4000-8000-000000000004'),  -- Admin B (not Super Admin)
  ('b_im',   'f0e5e900-0000-4000-8000-000000000005'),  -- Inventory Manager B
  ('c_sa',   'f0e5e900-0000-4000-8000-000000000006'),  -- Super Admin C
  ('a_prod', 'f0e5e900-0000-4000-8000-0000000000d1'), ('b_prod', 'f0e5e900-0000-4000-8000-0000000000d2'),
  ('b_prod2','f0e5e900-0000-4000-8000-0000000000d3'), ('c_prod', 'f0e5e900-0000-4000-8000-0000000000d4'),
  ('b_cat',  'f0e5e900-0000-4000-8000-0000000000d5'), ('b_sup',  'f0e5e900-0000-4000-8000-0000000000d6'),
  ('a_wh',   'f0e5e900-0000-4000-8000-0000000000e1'), ('b_wh',   'f0e5e900-0000-4000-8000-0000000000e2'),
  ('b_loc2', 'f0e5e900-0000-4000-8000-0000000000e3'),
  ('a_lot',  'f0e5e900-0000-4000-8000-0000000000e4'), ('b_lot',  'f0e5e900-0000-4000-8000-0000000000e5'),
  ('a_tx',   'f0e5e900-0000-4000-8000-0000000000e6'), ('b_tx1',  'f0e5e900-0000-4000-8000-0000000000e7'),
  ('b_tx2',  'f0e5e900-0000-4000-8000-0000000000e8'),
  ('a_cust', 'f0e5e900-0000-4000-8000-0000000000f1'), ('b_cust', 'f0e5e900-0000-4000-8000-0000000000f2'),
  ('c_cust', 'f0e5e900-0000-4000-8000-0000000000f3'),
  ('a_inv',  'f0e5e900-0000-4000-8000-0000000000f4'), ('b_inv',  'f0e5e900-0000-4000-8000-0000000000f5'),
  ('b_pay',  'f0e5e900-0000-4000-8000-0000000000f6'), ('b_bom',  'f0e5e900-0000-4000-8000-0000000000f7'),
  ('b_wf',   'f0e5e900-0000-4000-8000-0000000000f8'), ('b_areq', 'f0e5e900-0000-4000-8000-0000000000f9'),
  ('b_job1', 'f0e5e900-0000-4000-8000-0000000000fa'), ('b_job2', 'f0e5e900-0000-4000-8000-0000000000fb'),
  ('a_job',  'f0e5e900-0000-4000-8000-0000000000fc'), ('c_job',  'f0e5e900-0000-4000-8000-0000000000fd'),
  ('b_cpo1', 'f0e5e900-0000-4000-8000-000000000101'), ('b_cpo2', 'f0e5e900-0000-4000-8000-000000000102'),
  ('b_doc',  'f0e5e900-0000-4000-8000-000000000103'), ('b_cdoc', 'f0e5e900-0000-4000-8000-000000000104'),
  ('a_doc',  'f0e5e900-0000-4000-8000-000000000105'),
  ('req1', 'f0e5e900-0000-4000-8000-000000000201'), ('req2', 'f0e5e900-0000-4000-8000-000000000202'),
  ('req3', 'f0e5e900-0000-4000-8000-000000000203'), ('req4', 'f0e5e900-0000-4000-8000-000000000204'),
  ('req5', 'f0e5e900-0000-4000-8000-000000000205'), ('req6', 'f0e5e900-0000-4000-8000-000000000206'),
  ('req7', 'f0e5e900-0000-4000-8000-000000000207'), ('req8', 'f0e5e900-0000-4000-8000-000000000208'),
  ('req9', 'f0e5e900-0000-4000-8000-000000000209'), ('req10', 'f0e5e900-0000-4000-8000-000000000210'),
  ('req11', 'f0e5e900-0000-4000-8000-000000000211'), ('req12', 'f0e5e900-0000-4000-8000-000000000212');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Force Test A', 'Force Test A', 'FRA'),
  (rls_test.id('company_b'), 'Force Test B', 'Force Test B', 'FRB'),
  (rls_test.id('company_c'), 'Force Test C', 'Force Test C', 'FRC');

insert into auth.users (id, email)
select id, key || '@fr.example.invalid' from rls_test.ids where key in ('a_sa', 'b_sa', 'b_sa2', 'b_adm', 'b_im', 'c_sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('a_sa');
update public.profiles set company_id = rls_test.id('company_b'), is_active = true
  where id in (rls_test.id('b_sa'), rls_test.id('b_sa2'), rls_test.id('b_adm'), rls_test.id('b_im'));
update public.profiles set company_id = rls_test.id('company_c'), is_active = true where id = rls_test.id('c_sa');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('a_sa'),  rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('b_sa'),  rls_test.id('company_b'), rls_test.id('role_super_admin')),
  (rls_test.id('b_sa2'), rls_test.id('company_b'), rls_test.id('role_super_admin')),
  (rls_test.id('b_adm'), rls_test.id('company_b'), rls_test.id('role_admin')),
  (rls_test.id('b_im'),  rls_test.id('company_b'), rls_test.id('role_inventory_manager')),
  (rls_test.id('c_sa'),  rls_test.id('company_c'), rls_test.id('role_super_admin'));

insert into public.company_settings (company_id, setting_key, setting_value)
values (rls_test.id('company_b'), 'reporting.default_period', '"this_month"'::jsonb) on conflict do nothing;

-- Master data.
insert into public.product_categories (id, company_id, name, code) values (rls_test.id('b_cat'), rls_test.id('company_b'), 'Basins', 'BAS');
insert into public.suppliers (id, company_id, supplier_code, legal_name) values (rls_test.id('b_sup'), rls_test.id('company_b'), 'FRB-S1', 'Clay supplier');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, category_id, preferred_supplier_id, product_image_path) values
  (rls_test.id('a_prod'),  rls_test.id('company_a'), 'FR-A1', 'Product A', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null, null, null),
  (rls_test.id('b_prod'),  rls_test.id('company_b'), 'FR-B1', 'Basin B', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', rls_test.id('b_cat'), rls_test.id('b_sup'), null),
  (rls_test.id('b_prod2'), rls_test.id('company_b'), 'FR-B2', 'Clay B', 'COMPONENT', 'IN_HOUSE', 'PCS', null, null, null),
  (rls_test.id('c_prod'),  rls_test.id('company_c'), 'FR-C1', 'Product C', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null, null, null);
-- The image path can only be set by an update (the insert check refuses it).
update public.products set product_image_path = company_id || '/' || id || '/basin.png' where id = rls_test.id('b_prod');

insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('a_wh'), rls_test.id('company_a'), 'WA', 'A store', true),
  (rls_test.id('b_wh'), rls_test.id('company_b'), 'WB', 'B store', true);
insert into rls_test.ids (key, id) select 'a_gen', id from public.inventory_locations where warehouse_id = rls_test.id('a_wh') and location_code = 'GENERAL';
insert into rls_test.ids (key, id) select 'b_gen', id from public.inventory_locations where warehouse_id = rls_test.id('b_wh') and location_code = 'GENERAL';
-- A child location (self-referencing table).
insert into public.inventory_locations (id, company_id, warehouse_id, location_code, location_name, location_type, stock_usage, parent_location_id)
values (rls_test.id('b_loc2'), rls_test.id('company_b'), rls_test.id('b_wh'), 'RACK1', 'Rack 1', 'RACK', 'STORAGE', rls_test.id('b_gen'));

-- Posted stock (append-only ledger) with a reversal that references the original.
insert into public.inventory_batches (id, company_id, product_id, source_type, batch_number, is_system_lot) values
  (rls_test.id('a_lot'), rls_test.id('company_a'), rls_test.id('a_prod'), 'IN_HOUSE', 'LOT-A1', false),
  (rls_test.id('b_lot'), rls_test.id('company_b'), rls_test.id('b_prod'), 'IN_HOUSE', 'LOT-B1', false);
insert into public.inventory_transactions (id, company_id, transaction_number, transaction_type, direction, product_id, batch_id, warehouse_id, location_id,
                                           quantity, unit, source_type, reason, transaction_date) values
  (rls_test.id('a_tx'),  rls_test.id('company_a'), 'FRA-TX-1', 'RECEIPT', 1, rls_test.id('a_prod'), rls_test.id('a_lot'), rls_test.id('a_wh'), rls_test.id('a_gen'), 5, 'PCS', 'IN_HOUSE', 'fixture', now()),
  (rls_test.id('b_tx1'), rls_test.id('company_b'), 'FRB-TX-1', 'RECEIPT', 1, rls_test.id('b_prod'), rls_test.id('b_lot'), rls_test.id('b_wh'), rls_test.id('b_gen'), 5, 'PCS', 'IN_HOUSE', 'fixture', now());
insert into public.inventory_transactions (id, company_id, transaction_number, transaction_type, direction, product_id, batch_id, warehouse_id, location_id,
                                           quantity, unit, source_type, reason, transaction_date, reversal_of_transaction_id)
values (rls_test.id('b_tx2'), rls_test.id('company_b'), 'FRB-TX-2', 'REVERSAL', -1, rls_test.id('b_prod'), rls_test.id('b_lot'), rls_test.id('b_wh'), rls_test.id('b_gen'),
        5, 'PCS', 'IN_HOUSE', 'fixture reversal', now(), rls_test.id('b_tx1'));

-- Approved BOM.
insert into public.boms (id, company_id, bom_code, finished_product_id, version, effective_from, output_quantity, output_unit)
values (rls_test.id('b_bom'), rls_test.id('company_b'), 'BOM-000001', rls_test.id('b_prod'), 1, current_date, 1, 'PCS');
insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit)
values (rls_test.id('company_b'), rls_test.id('b_bom'), 1, rls_test.id('b_prod2'), 2, 'PCS');
update public.boms set status = 'APPROVED', approved_by = rls_test.id('b_sa'), approved_at = now() where id = rls_test.id('b_bom');

-- Customers, an issued invoice with a line, a payment and its allocation, billing history.
insert into public.customers (id, company_id, customer_code, customer_name) values
  (rls_test.id('a_cust'), rls_test.id('company_a'), 'FRA-C1', 'Customer A'),
  (rls_test.id('b_cust'), rls_test.id('company_b'), 'FRB-C1', 'Customer B'),
  (rls_test.id('c_cust'), rls_test.id('company_c'), 'FRC-C1', 'Customer C');
insert into public.sales_invoices (id, company_id, invoice_date, payment_terms_days, customer_id, customer_code_snapshot, customer_legal_name, seller_legal_name, currency) values
  (rls_test.id('a_inv'), rls_test.id('company_a'), current_date, 30, rls_test.id('a_cust'), 'FRA-C1', 'Customer A', 'Force Test A', 'INR'),
  (rls_test.id('b_inv'), rls_test.id('company_b'), current_date, 30, rls_test.id('b_cust'), 'FRB-C1', 'Customer B', 'Force Test B', 'INR');
insert into public.sales_invoice_lines (company_id, invoice_id, line_no, line_type, description, quantity, unit_price, gross_amount, taxable_value, line_total)
values (rls_test.id('company_b'), rls_test.id('b_inv'), 1, 'CHARGE', 'Freight', 1, 100, 100, 100, 100);
update public.sales_invoices set taxable_subtotal = 100, grand_total = 100 where id = rls_test.id('b_inv');
update public.sales_invoices set status = 'ISSUED', invoice_number = case when company_id = rls_test.id('company_a') then 'FRA/1' else 'FRB/1' end,
       issued_at = now(), issued_by = rls_test.id('b_sa')
 where id in (rls_test.id('a_inv'), rls_test.id('b_inv'));
insert into public.customer_payments (id, company_id, receipt_number, customer_id, receipt_date, amount_received, currency, payment_method)
values (rls_test.id('b_pay'), rls_test.id('company_b'), 'FRB-R1', rls_test.id('b_cust'), current_date, 100, 'INR', 'UPI');
insert into public.invoice_payment_allocations (company_id, invoice_id, payment_id, allocated_amount, allocation_date)
values (rls_test.id('company_b'), rls_test.id('b_inv'), rls_test.id('b_pay'), 100, current_date);
insert into public.billing_events (company_id, entity_type, event_type) values (rls_test.id('company_b'), 'INVOICE', 'ISSUED');

-- Approval workflow (retained), request and an append-only decision.
insert into public.approval_workflows (id, company_id, name, document_type) values (rls_test.id('b_wf'), rls_test.id('company_b'), 'Stock adjustments', 'STOCK_ADJUSTMENT');
insert into public.approval_requests (id, company_id, workflow_id, workflow_version, workflow_snapshot, document_type, document_id, document_reference, document_fingerprint)
values (rls_test.id('b_areq'), rls_test.id('company_b'), rls_test.id('b_wf'), 1, '{}'::jsonb, 'STOCK_ADJUSTMENT', gen_random_uuid(), 'ADJ-1', 'fp');
insert into public.approval_decisions (company_id, request_id, stage_no, approver_user_id, decision, document_fingerprint)
values (rls_test.id('company_b'), rls_test.id('b_areq'), 1, rls_test.id('b_sa'), 'APPROVE', 'fp');

-- Import history, a retry referencing the first job (self-reference).
insert into public.import_jobs (id, company_id, import_type, client_job_key, status) values
  (rls_test.id('a_job'),  rls_test.id('company_a'), 'PRODUCTS', gen_random_uuid(), 'COMPLETED'),
  (rls_test.id('b_job1'), rls_test.id('company_b'), 'PRODUCTS', gen_random_uuid(), 'FAILED'),
  (rls_test.id('c_job'),  rls_test.id('company_c'), 'PRODUCTS', gen_random_uuid(), 'COMPLETED');
insert into public.import_jobs (id, company_id, import_type, client_job_key, status, retry_of_job_id)
values (rls_test.id('b_job2'), rls_test.id('company_b'), 'PRODUCTS', gen_random_uuid(), 'COMPLETED', rls_test.id('b_job1'));
insert into public.customer_po_import_batches (company_id, file_name, validation_status, import_status)
values (rls_test.id('company_b'), 'orders.xlsx', 'VALID', 'IMPORTED');

-- Customer PO revision chain.
insert into public.customer_purchase_orders (id, company_id, po_reference, customer_name_snapshot, customer_key, customer_po_number, po_date, revision, is_current)
values (rls_test.id('b_cpo1'), rls_test.id('company_b'), 'FRB-CPO-1', 'Customer B', 'FRB-C1', 'PO-1', current_date, 1, false);
insert into public.customer_purchase_orders (id, company_id, po_reference, customer_name_snapshot, customer_key, customer_po_number, po_date, revision, previous_revision_id)
values (rls_test.id('b_cpo2'), rls_test.id('company_b'), 'FRB-CPO-1R2', 'Customer B', 'FRB-C1', 'PO-1', current_date, 2, rls_test.id('b_cpo1'));

insert into public.notifications (company_id, recipient_user_id, notification_type, title, message)
values (rls_test.id('company_b'), rls_test.id('b_im'), 'LOW_STOCK', 'Low stock', 'FR-B1 is low');

-- Documents: one on a customer (deleted), one on the company itself (kept), one of company A.
insert into public.documents (id, company_id, document_type, title, related_entity_type, related_entity_id, related_reference) values
  (rls_test.id('b_doc'),  rls_test.id('company_b'), 'KYC', 'KYC of FRB-C1', 'CUSTOMER', rls_test.id('b_cust'), 'FRB-C1'),
  (rls_test.id('b_cdoc'), rls_test.id('company_b'), 'CONTRACT', 'Company contract', 'COMPANY', rls_test.id('company_b'), 'FRB'),
  (rls_test.id('a_doc'),  rls_test.id('company_a'), 'KYC', 'KYC of FRA-C1', 'CUSTOMER', rls_test.id('a_cust'), 'FRA-C1');
insert into public.document_versions (company_id, document_id, version, original_filename, storage_path, file_size, mime_type, extension, uploaded_by, status) values
  (rls_test.id('company_b'), rls_test.id('b_doc'),  1, 'kyc.pdf', rls_test.id('company_b') || '/' || rls_test.id('b_doc') || '/v1-kyc.pdf', 100, 'application/pdf', 'pdf', rls_test.id('b_sa'), 'AVAILABLE'),
  (rls_test.id('company_b'), rls_test.id('b_cdoc'), 1, 'contract.pdf', rls_test.id('company_b') || '/' || rls_test.id('b_cdoc') || '/v1-contract.pdf', 100, 'application/pdf', 'pdf', rls_test.id('b_sa'), 'AVAILABLE'),
  (rls_test.id('company_a'), rls_test.id('a_doc'),  1, 'kyc.pdf', rls_test.id('company_a') || '/' || rls_test.id('a_doc') || '/v1-kyc.pdf', 100, 'application/pdf', 'pdf', rls_test.id('a_sa'), 'AVAILABLE');
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', rls_test.id('company_b') || '/' || rls_test.id('b_doc') || '/v1-kyc.pdf', '{"size": 100}'),
  ('documents', rls_test.id('company_b') || '/' || rls_test.id('b_cdoc') || '/v1-contract.pdf', '{"size": 100}'),
  ('documents', rls_test.id('company_a') || '/' || rls_test.id('a_doc') || '/v1-kyc.pdf', '{"size": 100}'),
  ('product-images', rls_test.id('company_b') || '/' || rls_test.id('b_prod') || '/basin.png', '{"size": 100}');

-- ---------------------------------------------------------------------------
-- 1. Classification and order from the live catalogue
-- ---------------------------------------------------------------------------
select rls_test.ok('catalogue: every public table is purge, retained, or has no company_id',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r', 'p')
                and c.relname not in (select table_name from private.erp_force_reset_tables())
                and c.relname not in (select table_name from private.erp_force_reset_retained_tables())
                and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id')),
  (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and c.relname not in (select table_name from private.erp_force_reset_tables())
     and c.relname not in (select table_name from private.erp_force_reset_retained_tables())));
select rls_test.ok('catalogue: no table is both purged and retained',
  not exists (select 1 from private.erp_force_reset_tables() f join private.erp_force_reset_retained_tables() k using (table_name)));
-- 88 standard tables since the Cost Intelligence tables (20261208090000).
select rls_test.ok('catalogue: purge list = the 88 standard tables + products, product versions, categories, warehouses, locations, documents, versions',
  (select count(*) from private.erp_force_reset_tables()) = 95 and (select count(distinct table_name) from private.erp_force_reset_tables()) = 95
  and (select count(*) from private.erp_reset_tables() t where t.table_name not in (select table_name from private.erp_force_reset_tables())) = 0);
select rls_test.ok('catalogue: every purge table exists and is company-scoped',
  not exists (select 1 from private.erp_force_reset_tables() f where to_regclass('public.' || f.table_name) is null
              or not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = f.table_name and c.column_name = 'company_id')));
select rls_test.ok('catalogue: users, roles, permissions, audit log, reset history, settings and number series are retained',
  (select count(*) from private.erp_force_reset_retained_tables() where table_name in ('companies', 'company_settings', 'profiles', 'user_roles', 'roles',
     'permissions', 'role_permissions', 'audit_logs', 'erp_reset_runs', 'erp_reset_backup_attestations', 'invoice_settings',
     'billing_number_sequences', 'inventory_number_sequences')) = 13);
select rls_test.ok('catalogue: the standard reset classifies the new backup-record table as kept',
  exists (select 1 from private.erp_reset_kept_tables() where table_name = 'erp_reset_backup_attestations'));
select rls_test.ok('order: computed for every purge table, no cycle',
  (select count(*) from private.erp_force_reset_order()) = 95 and (select max(ord) from private.erp_force_reset_order()) < 100);
select rls_test.ok('order: every foreign key child is deleted before its parent',
  not exists (
    select 1 from pg_constraint con
    join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
    join private.erp_force_reset_order() oc on oc.table_name = ch.relname
    join private.erp_force_reset_order() op on op.table_name = pa.relname
    where con.contype = 'f' and ch.oid <> pa.oid and oc.ord >= op.ord));
select rls_test.ok('order: no foreign key from a retained (or any non-purge) table into a purge table',
  not exists (select 1 from pg_constraint con join pg_class ch on ch.oid = con.conrelid join pg_class pa on pa.oid = con.confrelid
              join pg_namespace pn on pn.oid = pa.relnamespace join pg_namespace cn on cn.oid = ch.relnamespace
              where con.contype = 'f' and pn.nspname = 'public' and pa.relname in (select table_name from private.erp_force_reset_tables())
                and not (cn.nspname = 'public' and ch.relname in (select table_name from private.erp_force_reset_tables()))));
select rls_test.ok('order: self-referencing tables get a leaf-first condition',
  private.erp_force_reset_self_fk_clause('inventory_transactions') like '%reversal_of_transaction_id%'
  and private.erp_force_reset_self_fk_clause('inventory_locations') like '%parent_location_id%'
  and private.erp_force_reset_self_fk_clause('import_jobs') like '%retry_of_job_id%'
  and private.erp_force_reset_self_fk_clause('customer_purchase_orders') like '%previous_revision_id%'
  and private.erp_force_reset_self_fk_clause('customers') = '');
select rls_test.ok('guards: protected purge tables are detected from the catalogue (ledger, invoices, payments, BOMs, history, imports, decisions)',
  (select count(*) from private.erp_force_reset_guarded_tables() where table_name in ('inventory_transactions', 'sales_invoices', 'sales_invoice_lines',
     'customer_payments', 'invoice_payment_allocations', 'boms', 'bom_items', 'billing_events', 'import_jobs', 'approval_decisions',
     'goods_receipts', 'invoice_adjustment_notes')) = 12);
select rls_test.ok('guards: every guard function used on a purge table carries the force-purge exemption',
  not exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_proc p on p.oid = tg.tgfoid
              where not tg.tgisinternal and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) <> 0 and (tg.tgtype & 8) <> 0
                and c.relnamespace = 'public'::regnamespace
                and c.relname in (select table_name from private.erp_force_reset_tables())
                and p.prosrc not like '%erp_force_purge_allows%'),
  (select string_agg(distinct p.proname, ', ') from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_proc p on p.oid = tg.tgfoid
   where not tg.tgisinternal and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) <> 0 and (tg.tgtype & 8) <> 0
     and c.relnamespace = 'public'::regnamespace and c.relname in (select table_name from private.erp_force_reset_tables())
     and p.prosrc not like '%erp_force_purge_allows%'));
select rls_test.ok('guards: the audit-log guard has no exemption; reset history is not in the purge list',
  (select prosrc from pg_proc where proname = 'prevent_audit_log_mutation') not like '%erp_force_purge%'
  and not exists (select 1 from private.erp_force_reset_tables() where table_name in ('audit_logs', 'erp_reset_runs', 'erp_reset_backup_attestations')));

-- ---------------------------------------------------------------------------
-- 2. The exemption cannot be used outside a force purge
-- ---------------------------------------------------------------------------
select rls_test.set('probe_before', rls_test.company_rows(rls_test.id('company_b')) || jsonb_build_object('a_tx', rls_test.n('inventory_transactions', rls_test.id('company_a'))));
select rls_test.expect_call_error('guard: deleting posted stock is refused (no purge session)',
  format($q$ delete from public.inventory_transactions where id = %L returning '{}'::jsonb $q$, rls_test.id('b_tx2')), 'cannot be changed or deleted');
select set_config('app.erp_force_purge', gen_random_uuid()::text, true);
select rls_test.expect_call_error('guard: a made-up session id in the setting is refused',
  format($q$ delete from public.inventory_transactions where id = %L returning '{}'::jsonb $q$, rls_test.id('b_tx2')), 'cannot be changed or deleted');
insert into private.erp_force_purge_sessions (id, company_id, actor, request_id, txid)
values ('f0e5e900-0000-4000-8000-00000000aaa1', rls_test.id('company_b'), rls_test.id('b_sa'), gen_random_uuid(), 1);
select set_config('app.erp_force_purge', 'f0e5e900-0000-4000-8000-00000000aaa1', true);
select rls_test.expect_call_error('guard: a session of another (earlier) transaction is refused',
  format($q$ delete from public.import_jobs where id = %L returning '{}'::jsonb $q$, rls_test.id('b_job2')), 'append-only');
insert into private.erp_force_purge_sessions (id, company_id, actor, request_id, txid)
values ('f0e5e900-0000-4000-8000-00000000aaa2', rls_test.id('company_b'), rls_test.id('b_sa'), gen_random_uuid(), txid_current());
select set_config('app.erp_force_purge', 'f0e5e900-0000-4000-8000-00000000aaa2', true);
select rls_test.expect_call_error('guard: a session of company B cannot delete company A''s posted stock',
  format($q$ delete from public.inventory_transactions where id = %L returning '{}'::jsonb $q$, rls_test.id('a_tx')), 'cannot be changed or deleted');
select rls_test.expect_call_error('guard: updates stay forbidden inside a session (issued invoice)',
  format($q$ update public.sales_invoices set notes = 'x' where id = %L returning '{}'::jsonb $q$, rls_test.id('b_inv')), 'cannot be edited');
select rls_test.ok('guard: inside a matching session the exemption check is true only for the same company and a purge table',
  private.erp_force_purge_allows('import_jobs', rls_test.id('company_b'))
  and not private.erp_force_purge_allows('import_jobs', rls_test.id('company_a'))
  and not private.erp_force_purge_allows('erp_reset_runs', rls_test.id('company_b'))
  and not private.erp_force_purge_allows('audit_logs', rls_test.id('company_b')));
select set_config('app.erp_force_purge', '', true);
delete from private.erp_force_purge_sessions;
select rls_test.ok('guard: protected rows untouched by the probes (company B and A''s posted stock)',
  rls_test.company_rows(rls_test.id('company_b')) || jsonb_build_object('a_tx', rls_test.n('inventory_transactions', rls_test.id('company_a')))
    = rls_test.get('probe_before')
  and rls_test.n('inventory_transactions', rls_test.id('company_b')) = 2 and rls_test.n('import_jobs', rls_test.id('company_b')) >= 2);

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
select rls_test.ok('grants: preview, backup record and execute are for signed-in users, not anon',
  has_function_privilege('authenticated', 'public.erp_force_reset_preview(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.erp_force_reset_preview(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.erp_force_reset_execute(uuid, uuid, text, text, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.erp_force_reset_execute(uuid, uuid, text, text, uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.erp_force_reset_record_backup(uuid, text, text, timestamptz, boolean, boolean, text)', 'execute')
  and not has_function_privilege('anon', 'public.erp_force_reset_record_backup(uuid, text, text, timestamptz, boolean, boolean, text)', 'execute'));
select rls_test.ok('grants: ticket, verify, failure and clean-up records are service_role only',
  has_function_privilege('service_role', 'public.erp_force_reset_issue_ticket(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_force_reset_issue_ticket(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_force_reset_verify(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_force_reset_record_failure(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.erp_force_reset_record_storage_cleanup(uuid, uuid, int, int, text)', 'execute'));
select rls_test.ok('grants: environment approval cannot be given by any API role',
  not has_function_privilege('authenticated', 'private.erp_force_reset_approve(text, uuid, text, text, text, int)', 'execute')
  and not has_function_privilege('service_role', 'private.erp_force_reset_approve(text, uuid, text, text, text, int)', 'execute')
  and not has_function_privilege('anon', 'private.erp_force_reset_approve(text, uuid, text, text, text, int)', 'execute'));
select rls_test.ok('grants: approvals, tickets and purge sessions are not readable or writable by API roles',
  not has_table_privilege('authenticated', 'private.erp_force_reset_approvals', 'select')
  and not has_table_privilege('service_role', 'private.erp_force_reset_approvals', 'insert')
  and not has_table_privilege('authenticated', 'private.erp_force_reset_tickets', 'select')
  and not has_table_privilege('service_role', 'private.erp_force_reset_tickets', 'select')
  and not has_table_privilege('authenticated', 'private.erp_force_purge_sessions', 'insert')
  and not has_table_privilege('service_role', 'private.erp_force_purge_sessions', 'insert'));
select rls_test.ok('grants: backup records have RLS and no client write grants',
  (select relrowsecurity from pg_class where oid = 'public.erp_reset_backup_attestations'::regclass)
  and not has_table_privilege('authenticated', 'public.erp_reset_backup_attestations', 'insert')
  and not has_table_privilege('authenticated', 'public.erp_reset_backup_attestations', 'update')
  and not has_table_privilege('anon', 'public.erp_reset_backup_attestations', 'select'));

-- ---------------------------------------------------------------------------
-- 4. Preview
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select rls_test.expect_call_error('preview: without a signed-in user (as in the SQL Editor) it explains auth.uid() is empty',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')), 'signed-in ERP application');
select rls_test.claims('b_adm');
select rls_test.expect_call_error('preview: an Admin (not Super Admin) is refused',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')), 'Super Admin');
select rls_test.claims('b_sa');
select rls_test.expect_call_error('preview: another company cannot be selected',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_a')), 'belongs to');
select rls_test.expect_call_ok('preview: Super Admin B gets the force-reset preview', 'prev1',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')));
reset role;
set local role anon;
select rls_test.expect_call_error('preview: anonymous callers are refused',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')), 'permission denied');
reset role;

select rls_test.ok('preview: target company name, code and id',
  rls_test.get('prev1') -> 'company' ->> 'code' = 'FRB' and (rls_test.get('prev1') -> 'company' ->> 'id')::uuid = rls_test.id('company_b')
  and rls_test.get('prev1') -> 'company' ->> 'name' = 'Force Test B');
select rls_test.ok('preview: per-table counts include protected history and master data',
  (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'inventory_transactions') = 2
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'sales_invoices') = 1
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'products') = 2
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'warehouses') = 1
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'documents') = 1,
  rls_test.get('prev1') ->> 'tables');
select rls_test.ok('preview: delete total is the sum of the table counts and matches the database',
  (rls_test.get('prev1') ->> 'delete_total')::bigint = (select sum((e ->> 'rows')::bigint) from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e)
  and (rls_test.get('prev1') ->> 'delete_total')::bigint = (select sum(value::bigint) from jsonb_each(private.erp_force_reset_counts(rls_test.id('company_b')) -> 'purge')));
select rls_test.ok('preview: protected records are flagged with the guard reason',
  (rls_test.get('prev1') ->> 'protected_total')::int > 0
  and (select e ->> 'protection' from jsonb_array_elements(rls_test.get('prev1') -> 'tables') e where e ->> 'table' = 'inventory_transactions') like 'Posted stock%');
select rls_test.ok('preview: retained list includes the company-level document',
  (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'retained') e where e ->> 'table' = 'documents') = 1
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev1') -> 'retained') e where e ->> 'table' = 'profiles') = 4);
select rls_test.ok('preview: Storage files of company B only (1 image, 1 customer document; company document kept)',
  (rls_test.get('prev1') -> 'storage' ->> 'product_images')::int = 1 and (rls_test.get('prev1') -> 'storage' ->> 'documents')::int = 1);
select rls_test.ok('preview: no schema blockers; demo_presentation_data not present; every public table counted',
  jsonb_array_length(rls_test.get('prev1') -> 'blockers') = 0 and rls_test.get('prev1') ->> 'demo_presentation_data' = 'NOT_PRESENT'
  and (rls_test.get('prev1') ->> 'discovered_tables')::int = (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')),
  rls_test.get('prev1') ->> 'blockers');
-- Since 20261113 (direct force reset) approval and backup are no longer required.
select rls_test.ok('preview: ready without approval and backup (direct force reset, 20261113)',
  (rls_test.get('prev1') -> 'gates' ->> 'authorized')::boolean and (rls_test.get('prev1') ->> 'can_execute')::boolean
  and rls_test.get('prev1') -> 'approval' = 'null'::jsonb and rls_test.get('prev1') -> 'backup' = 'null'::jsonb);
select rls_test.ok('preview: raw counts are not exposed', not (rls_test.get('prev1') ? 'counts'));

-- ---------------------------------------------------------------------------
-- 5. Execute: refusals before anything runs
-- ---------------------------------------------------------------------------
select rls_test.set('b_rows_0', rls_test.company_rows(rls_test.id('company_b')));
select rls_test.set('tk_bad_code', to_jsonb(rls_test.ticket('b_sa', 'company_b')));
select rls_test.set('tk_blocked', to_jsonb(rls_test.ticket('b_sa', 'company_b')));
select rls_test.set('tk_noperm', to_jsonb(rls_test.ticket('b_sa', 'company_b')));
set local role service_role;
select rls_test.expect_call_error('ticket: not issued for an Admin who is not Super Admin',
  format($q$ select public.erp_force_reset_issue_ticket(%L, %L) $q$, rls_test.id('b_adm'), rls_test.id('company_b')), 'Super Admin');
select rls_test.expect_call_error('ticket: not issued for another company',
  format($q$ select public.erp_force_reset_issue_ticket(%L, %L) $q$, rls_test.id('b_sa'), rls_test.id('company_a')), 'Super Admin');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '', true);
select rls_test.expect_call_error('execute: refused without a signed-in user (auth.uid())',
  rls_test.exec_sql('company_b', 'req1', 'x', 'FRB'), 'Not authenticated');
select rls_test.claims('b_sa');
select rls_test.expect_call_error('execute: wrong confirmation text is refused',
  rls_test.exec_sql('company_b', 'req1', 'x', 'FRB', 'delete all company data'), 'DELETE ALL COMPANY DATA');
select rls_test.expect_call_ok('execute: without a password ticket', 'r_noticket', rls_test.exec_sql('company_b', 'req1', 'not-a-ticket', 'FRB'));
select rls_test.expect_call_ok('execute: with another company selected', 'r_othercompany', rls_test.exec_sql('company_a', 'req1', rls_test.get('tk_bad_code') #>> '{}', 'FRA'));
select rls_test.expect_call_ok('execute: wrong company code', 'r_badcode', rls_test.exec_sql('company_b', 'req1', rls_test.get('tk_bad_code') #>> '{}', 'FRA'));
select rls_test.expect_call_ok('execute: the same ticket again', 'r_reuse', rls_test.exec_sql('company_b', 'req1', rls_test.get('tk_bad_code') #>> '{}', 'FRB'));
select rls_test.claims('b_adm');
select rls_test.expect_call_ok('execute: an Admin with a Super Admin''s ticket', 'r_adm', rls_test.exec_sql('company_b', 'req1', rls_test.get('tk_blocked') #>> '{}', 'FRB'));
reset role;
select rls_test.ok('execute: no ticket -> DENIED (re-authentication required)',
  rls_test.get('r_noticket') ->> 'status' = 'DENIED' and rls_test.get('r_noticket') ->> 'code' = 'REAUTH_REQUIRED', rls_test.get('r_noticket')::text);
select rls_test.ok('execute: another company -> DENIED', rls_test.get('r_othercompany') ->> 'status' = 'DENIED', rls_test.get('r_othercompany')::text);
select rls_test.ok('execute: wrong company code -> DENIED', rls_test.get('r_badcode') ->> 'status' = 'DENIED'
  and rls_test.get('r_badcode') ->> 'error' like '%FRB%', rls_test.get('r_badcode')::text);
select rls_test.ok('execute: a ticket works once (consumed by the previous attempt)',
  rls_test.get('r_reuse') ->> 'status' = 'DENIED' and rls_test.get('r_reuse') ->> 'code' = 'REAUTH_REQUIRED', rls_test.get('r_reuse')::text);
select rls_test.ok('execute: an Admin is DENIED even with a ticket', rls_test.get('r_adm') ->> 'status' = 'DENIED', rls_test.get('r_adm')::text);

-- Without system.reset_data (removed from the Super Admin role for this check).
delete from public.role_permissions rp using public.permissions p, public.roles r
 where p.id = rp.permission_id and r.id = rp.role_id and p.code = 'system.reset_data' and r.code = 'SUPER_ADMIN';
set local role service_role;
select rls_test.expect_call_error('permission: no ticket is issued without system.reset_data',
  format($q$ select public.erp_force_reset_issue_ticket(%L, %L) $q$, rls_test.id('b_sa'), rls_test.id('company_b')), 'system.reset_data');
reset role;
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_error('permission: preview refused without system.reset_data',
  format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')), 'system.reset_data');
select rls_test.expect_call_ok('permission: execute without system.reset_data', 'r_noperm', rls_test.exec_sql('company_b', 'req1', rls_test.get('tk_noperm') #>> '{}', 'FRB'));
reset role;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p where r.code = 'SUPER_ADMIN' and p.code = 'system.reset_data';
select rls_test.ok('permission: execute without system.reset_data -> DENIED', rls_test.get('r_noperm') ->> 'status' = 'DENIED', rls_test.get('r_noperm')::text);
select rls_test.ok('refusals: nothing deleted, no run recorded, denials audited',
  rls_test.company_rows(rls_test.id('company_b')) - 'audit_logs' = rls_test.get('b_rows_0') - 'audit_logs'
  and not exists (select 1 from public.erp_reset_runs where company_id = rls_test.id('company_b'))
  and rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.denied') >= 5);

-- Not approved, no backup: BLOCKED.
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_ok('blocked: execute without approval and backup', 'r_blocked', rls_test.exec_sql('company_b', 'req2', rls_test.get('tk_blocked') #>> '{}', 'FRB'));
reset role;
select rls_test.ok('blocked: BLOCKED with ENVIRONMENT_NOT_APPROVED and BACKUP_NOT_VERIFIED, nothing deleted',
  rls_test.get('r_blocked') ->> 'status' = 'BLOCKED' and (rls_test.get('r_blocked') ->> 'deleted_total')::int = 0
  and exists (select 1 from jsonb_array_elements(rls_test.get('r_blocked') -> 'blockers') b where b ->> 'kind' = 'ENVIRONMENT_NOT_APPROVED')
  and exists (select 1 from jsonb_array_elements(rls_test.get('r_blocked') -> 'blockers') b where b ->> 'kind' = 'BACKUP_NOT_VERIFIED')
  and rls_test.company_rows(rls_test.id('company_b')) - 'audit_logs' - 'erp_reset_runs' = rls_test.get('b_rows_0') - 'audit_logs' - 'erp_reset_runs',
  rls_test.get('r_blocked')::text);
select rls_test.ok('blocked: recorded as a FORCE run and audited',
  exists (select 1 from public.erp_reset_runs where request_id = rls_test.id('req2') and status = 'BLOCKED' and mode = 'FORCE')
  and rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.blocked') = 1);

-- ---------------------------------------------------------------------------
-- 6. Environment approval and backup record
-- ---------------------------------------------------------------------------
select rls_test.expect_call_error('approval: company code and id must match',
  format($q$ select private.erp_force_reset_approve('FRA', %L, 'DEMO', 'Test owner', 'Clearing demo data for the test', 24) $q$, rls_test.id('company_b')), 'do not belong');
select rls_test.expect_call_error('approval: production is not an allowed environment',
  format($q$ select private.erp_force_reset_approve('FRB', %L, 'PRODUCTION', 'Test owner', 'Clearing demo data for the test', 24) $q$, rls_test.id('company_b')), 'not available for production');
select rls_test.expect_call_error('approval: at most 72 hours',
  format($q$ select private.erp_force_reset_approve('FRB', %L, 'DEMO', 'Test owner', 'Clearing demo data for the test', 100) $q$, rls_test.id('company_b')), '72');
select rls_test.expect_call_ok('approval: database owner approves company B as DEMO', 'appr_b',
  format($q$ select private.erp_force_reset_approve('FRB', %L, 'DEMO', 'Test owner', 'Clearing demo data for the test', 24) $q$, rls_test.id('company_b')));
select rls_test.ok('approval: audited', rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.environment_approved') = 1);

set local role authenticated;
select rls_test.claims('b_adm');
select rls_test.expect_call_error('backup: an Admin cannot record a backup',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb.dump', now(), true, true) $q$, rls_test.id('company_b')), 'Super Admin');
select rls_test.claims('b_sa');
select rls_test.expect_call_error('backup: a time in the future is refused',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb.dump', now() + interval '1 hour', true, true) $q$, rls_test.id('company_b')), 'future');
select rls_test.expect_call_error('backup: older than 24 hours is refused',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb.dump', now() - interval '2 days', true, true) $q$, rls_test.id('company_b')), '24 hours');
select rls_test.expect_call_error('backup: restore check must be confirmed',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb.dump', now(), false, true) $q$, rls_test.id('company_b')), 'restored');
select rls_test.expect_call_error('backup: "outside this database" must be acknowledged',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb.dump', now(), true, false) $q$, rls_test.id('company_b')), 'outside this database');
select rls_test.expect_call_error('backup: connection strings with passwords are refused',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'postgres://postgres:hunter2@db.example.invalid/postgres', now(), true, true) $q$, rls_test.id('company_b')), 'connection strings');
select rls_test.expect_call_ok('backup: Super Admin B records the backup', 'bk_b',
  format($q$ select public.erp_force_reset_record_backup(%L, 'PG_DUMP', 'frb-2026-10-31.dump', now() - interval '10 minutes', true, true, 'checked on a scratch database') $q$, rls_test.id('company_b')));
select rls_test.expect_call_ok('preview: after approval and backup', 'prev2', format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_b')));
reset role;
select rls_test.ok('backup: stored as an administrator attestation and audited',
  rls_test.get('bk_b') ->> 'verification_method' = 'ADMINISTRATOR_ATTESTED' and rls_test.get('bk_b') ->> 'backup_reference' = 'frb-2026-10-31.dump'
  and rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.backup_recorded') = 1, rls_test.get('bk_b')::text);
select rls_test.expect_call_error('backup: records are append-only',
  $q$ update public.erp_reset_backup_attestations set backup_reference = 'other' returning '{}'::jsonb $q$, 'cannot be changed');
select rls_test.ok('preview: still ready after approval and backup (no longer required)',
  (rls_test.get('prev2') ->> 'can_execute')::boolean, rls_test.get('prev2') ->> 'gates');

-- ---------------------------------------------------------------------------
-- 7. Completed force reset of company B
-- ---------------------------------------------------------------------------
select rls_test.set('fp_before', rls_test.fingerprint());
select rls_test.set('a_rows', rls_test.company_rows(rls_test.id('company_a')));
select rls_test.set('c_rows', rls_test.company_rows(rls_test.id('company_c')));
select rls_test.set('global_before', jsonb_build_object(
  'roles', (select count(*) from public.roles), 'permissions', (select count(*) from public.permissions),
  'role_permissions', (select count(*) from public.role_permissions), 'auth_users', (select count(*) from auth.users),
  'audit_logs_b', rls_test.n('audit_logs', rls_test.id('company_b')),
  'storage', (select count(*) from storage.objects)));
select rls_test.set('b_settings', (select jsonb_agg(to_jsonb(s) order by s.setting_key) from public.company_settings s where s.company_id = rls_test.id('company_b')));
select rls_test.set('tk_go', to_jsonb(rls_test.ticket('b_sa', 'company_b')));

set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_ok('completed: force reset of company B runs', 'run_b',
  format($q$ select public.erp_force_reset_execute(%L, %L, 'DELETE ALL COMPANY DATA', 'frb', %L, %L) $q$,
         rls_test.id('company_b'), rls_test.id('req3'), rls_test.get('bk_b') ->> 'id', rls_test.get('tk_go') #>> '{}'));
reset role;
select rls_test.ok('completed: status COMPLETED, deleted total = preview total',
  rls_test.get('run_b') ->> 'status' = 'COMPLETED' and rls_test.get('run_b') ->> 'mode' = 'FORCE'
  and (rls_test.get('run_b') ->> 'deleted_total')::bigint = (rls_test.get('prev2') ->> 'delete_total')::bigint, rls_test.get('run_b')::text);
select rls_test.ok('completed: in-transaction verification passed',
  (rls_test.get('run_b') -> 'verification' ->> 'purge_tables_empty')::boolean and (rls_test.get('run_b') -> 'verification' ->> 'other_companies_unchanged')::boolean
  and (rls_test.get('run_b') -> 'verification' ->> 'schema_unchanged')::boolean and (rls_test.get('run_b') -> 'verification' ->> 'actor_access_valid')::boolean);
select rls_test.ok('completed: every in-scope table of company B has zero rows', rls_test.purge_left(rls_test.id('company_b')) = '{}'::jsonb,
  rls_test.purge_left(rls_test.id('company_b'))::text);
select rls_test.ok('completed: protected history deleted (stock ledger and reversal, invoice and line, payment, BOM, decision, import jobs, CPO revisions)',
  rls_test.n('inventory_transactions', rls_test.id('company_b')) = 0 and rls_test.n('sales_invoices', rls_test.id('company_b')) = 0
  and rls_test.n('sales_invoice_lines', rls_test.id('company_b')) = 0 and rls_test.n('customer_payments', rls_test.id('company_b')) = 0
  and rls_test.n('boms', rls_test.id('company_b')) = 0 and rls_test.n('approval_decisions', rls_test.id('company_b')) = 0
  and rls_test.n('import_jobs', rls_test.id('company_b')) = 0 and rls_test.n('customer_purchase_orders', rls_test.id('company_b')) = 0);
select rls_test.ok('completed: master data deleted (products, categories, suppliers, warehouses, both locations, customer document)',
  rls_test.n('products', rls_test.id('company_b')) = 0 and rls_test.n('product_categories', rls_test.id('company_b')) = 0
  and rls_test.n('suppliers', rls_test.id('company_b')) = 0 and rls_test.n('warehouses', rls_test.id('company_b')) = 0
  and rls_test.n('inventory_locations', rls_test.id('company_b')) = 0 and not exists (select 1 from public.documents where id = rls_test.id('b_doc')));
select rls_test.ok('completed: company-level document and its file version kept',
  exists (select 1 from public.documents where id = rls_test.id('b_cdoc'))
  and exists (select 1 from public.document_versions where document_id = rls_test.id('b_cdoc')));
select rls_test.ok('completed: company, settings and approval workflow kept',
  exists (select 1 from public.companies where id = rls_test.id('company_b') and is_active)
  and (select jsonb_agg(to_jsonb(s) order by s.setting_key) from public.company_settings s where s.company_id = rls_test.id('company_b')) = rls_test.get('b_settings')
  and rls_test.n('approval_workflows', rls_test.id('company_b')) = 1);
select rls_test.ok('completed: initiating Super Admin can still sign in (profile, auth user, role, permission)',
  exists (select 1 from public.profiles where id = rls_test.id('b_sa') and is_active and company_id = rls_test.id('company_b'))
  and exists (select 1 from auth.users where id = rls_test.id('b_sa')) and private.erp_reset_actor_ok(rls_test.id('b_sa'), rls_test.id('company_b')));
select rls_test.ok('completed: all users and role assignments kept, both Super Admins intact',
  rls_test.n('profiles', rls_test.id('company_b')) = 4 and rls_test.n('user_roles', rls_test.id('company_b')) = 4
  and private.erp_force_reset_super_admins(rls_test.id('company_b')) = 2);
select rls_test.ok('completed: roles, permissions, grants and auth users unchanged',
  (select count(*) from public.roles) = (rls_test.get('global_before') ->> 'roles')::int
  and (select count(*) from public.permissions) = (rls_test.get('global_before') ->> 'permissions')::int
  and (select count(*) from public.role_permissions) = (rls_test.get('global_before') ->> 'role_permissions')::int
  and (select count(*) from auth.users) = (rls_test.get('global_before') ->> 'auth_users')::int);
select rls_test.ok('completed: other companies untouched (A has its posted stock, issued invoice, import job, document)',
  rls_test.company_rows(rls_test.id('company_a')) = rls_test.get('a_rows') and rls_test.company_rows(rls_test.id('company_c')) = rls_test.get('c_rows')
  and rls_test.n('inventory_transactions', rls_test.id('company_a')) = 1 and rls_test.n('sales_invoices', rls_test.id('company_a')) = 1);
select rls_test.ok('completed: schema objects unchanged; RLS on everywhere; no trigger disabled',
  rls_test.fingerprint() = rls_test.get('fp_before')
  and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)
  and not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'D'));
select rls_test.ok('completed: the purge session is gone and the setting cleared',
  not exists (select 1 from private.erp_force_purge_sessions) and coalesce(current_setting('app.erp_force_purge', true), '') = '');
select rls_test.expect_call_error('completed: guards protect again afterwards (company A posted stock)',
  format($q$ delete from public.inventory_transactions where id = %L returning '{}'::jsonb $q$, rls_test.id('a_tx')), 'cannot be changed or deleted');
select rls_test.ok('completed: Storage files listed for removal after commit (B only; company document kept); none removed by SQL',
  jsonb_array_length((select storage_objects from public.erp_reset_runs where request_id = rls_test.id('req3'))) = 2
  and (rls_test.get('run_b') ->> 'storage_objects')::int = 2
  and not exists (select 1 from jsonb_array_elements((select storage_objects from public.erp_reset_runs where request_id = rls_test.id('req3'))) o
                  where o ->> 'name' not like rls_test.id('company_b') || '/%' or o ->> 'name' like '%contract%')
  and (select count(*) from storage.objects) = (rls_test.get('global_before') ->> 'storage')::int);
select rls_test.ok('completed: run records actor, company, approval, backup, counts and result',
  exists (select 1 from public.erp_reset_runs where request_id = rls_test.id('req3') and status = 'COMPLETED' and mode = 'FORCE'
            and requested_by = rls_test.id('b_sa') and company_id = rls_test.id('company_b')
            and approval_id = (rls_test.get('appr_b') ->> 'approval_id')::uuid and backup_id = (rls_test.get('bk_b') ->> 'id')::uuid
            and (deleted_counts ->> 'inventory_transactions')::int = 2));
select rls_test.ok('completed: audit log kept (only grew) and has one completion event',
  rls_test.n('audit_logs', rls_test.id('company_b')) > (rls_test.get('global_before') ->> 'audit_logs_b')::int
  and rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.completed') = 1
  and exists (select 1 from public.audit_logs where action = 'erp_force_reset.completed' and actor_user_id = rls_test.id('b_sa')
              and metadata ->> 'environment' = 'DEMO' and metadata ->> 'backup_reference' = 'frb-2026-10-31.dump'));
select rls_test.ok('completed: no password, ticket or secret stored in history or audit',
  not exists (select 1 from public.audit_logs where company_id = rls_test.id('company_b') and action like 'erp_force_reset.%'
              and (metadata::text ~* '(password|secret)' or metadata::text like '%' || (rls_test.get('tk_go') #>> '{}') || '%'))
  and not exists (select 1 from public.erp_reset_runs where company_id = rls_test.id('company_b')
                  and (to_jsonb(erp_reset_runs)::text ~* '(password|secret)' or to_jsonb(erp_reset_runs)::text like '%' || (rls_test.get('tk_go') #>> '{}') || '%')));

-- Duplicates.
select rls_test.set('tk_again', to_jsonb(rls_test.ticket('b_sa', 'company_b')));
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.expect_call_ok('idempotency: the same request id again', 'replay_b',
  format($q$ select public.erp_force_reset_execute(%L, %L, 'DELETE ALL COMPANY DATA', 'FRB', null, 'whatever') $q$, rls_test.id('company_b'), rls_test.id('req3')));
select rls_test.expect_call_ok('duplicate: a new request after completion', 'dup_b', rls_test.exec_sql('company_b', 'req4', rls_test.get('tk_again') #>> '{}', 'FRB'));
reset role;
select rls_test.ok('idempotency: replay returns the stored result and runs nothing',
  (rls_test.get('replay_b') ->> 'replayed')::boolean and rls_test.get('replay_b') ->> 'run_id' = rls_test.get('run_b') ->> 'run_id'
  and rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.completed') = 1, rls_test.get('replay_b')::text);
select rls_test.ok('duplicate: a second force reset is BLOCKED (approval and backup are single-use)',
  rls_test.get('dup_b') ->> 'status' = 'BLOCKED'
  and exists (select 1 from jsonb_array_elements(rls_test.get('dup_b') -> 'blockers') b where b ->> 'kind' = 'ENVIRONMENT_NOT_APPROVED')
  and exists (select 1 from jsonb_array_elements(rls_test.get('dup_b') -> 'blockers') b where b ->> 'kind' = 'BACKUP_NOT_VERIFIED'), rls_test.get('dup_b')::text);

-- Post-commit verification and Storage clean-up.
set local role service_role;
select rls_test.expect_call_ok('verify: before the files are removed', 'ver1',
  format($q$ select public.erp_force_reset_verify(%L, %L) $q$, rls_test.id('b_sa'), rls_test.get('run_b') ->> 'run_id'));
reset role;
delete from storage.objects o where o.name in (select x ->> 'name' from jsonb_array_elements(rls_test.get('ver1') -> 'storage_objects') x);
set local role service_role;
select public.erp_force_reset_record_storage_cleanup(rls_test.id('b_sa'), (rls_test.get('run_b') ->> 'run_id')::uuid, 2, 0, null);
select rls_test.expect_call_ok('verify: after the files are removed', 'ver2',
  format($q$ select public.erp_force_reset_verify(%L, %L) $q$, rls_test.id('b_sa'), rls_test.get('run_b') ->> 'run_id'));
select rls_test.expect_call_ok('verify: another user cannot verify B''s run', 'ver_other',
  format($q$ select public.erp_force_reset_verify(%L, %L) $q$, rls_test.id('a_sa'), rls_test.get('run_b') ->> 'run_id'));
reset role;
select rls_test.ok('verify: not ok while Storage files remain (2 listed)',
  not (rls_test.get('ver1') ->> 'ok')::boolean and (rls_test.get('ver1') ->> 'storage_remaining')::int = 2, rls_test.get('ver1')::text);
select rls_test.ok('verify: ok after clean-up; Super Admins 2; company document and A''s file kept',
  (rls_test.get('ver2') ->> 'ok')::boolean and (rls_test.get('ver2') ->> 'super_admins')::int = 2 and rls_test.get('ver2') -> 'remaining' = '{}'::jsonb
  and exists (select 1 from storage.objects where name like '%contract%') and exists (select 1 from storage.objects where name like rls_test.id('company_a') || '/%'),
  rls_test.get('ver2')::text);
select rls_test.ok('verify: refused for a user of another company', not (rls_test.get('ver_other') ->> 'ok')::boolean);
select rls_test.ok('verify: Storage clean-up audited', rls_test.audits(rls_test.id('company_b'), 'erp_force_reset.storage_cleanup') = 1);

-- History visibility.
set local role authenticated;
select rls_test.claims('b_sa');
select rls_test.ok('history: Super Admin B sees B''s force runs', (select count(*) from public.erp_reset_runs where mode = 'FORCE') = 3);
select rls_test.ok('history: Super Admin B sees B''s backup record', (select count(*) from public.erp_reset_backup_attestations) = 1);
select rls_test.claims('b_adm');
select rls_test.ok('history: an Admin without system.reset_data sees nothing',
  (select count(*) from public.erp_reset_runs) = 0 and (select count(*) from public.erp_reset_backup_attestations) = 0);
select rls_test.claims('a_sa');
select rls_test.ok('history: Super Admin A sees none of B''s runs', (select count(*) from public.erp_reset_runs) = 0);
reset role;

-- ---------------------------------------------------------------------------
-- 8. Failure is rolled back (company C)
-- ---------------------------------------------------------------------------
select private.erp_force_reset_approve('FRC', rls_test.id('company_c'), 'TEST', 'Test owner', 'Failure path of the test suite', 1);
set local role authenticated;
select rls_test.claims('c_sa');
select rls_test.set('bk_c', public.erp_force_reset_record_backup(rls_test.id('company_c'), 'SUPABASE_SCHEDULED', 'Daily backup 03:00', now() - interval '1 hour', true, true));
reset role;
select rls_test.set('c_rows_0', rls_test.company_rows(rls_test.id('company_c')));
create function rls_test.fail_delete() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$;
create trigger zz_test_fail_delete after delete on public.products for each row execute function rls_test.fail_delete();
select rls_test.set('tk_c', to_jsonb(rls_test.ticket('c_sa', 'company_c')));
set local role authenticated;
select rls_test.claims('c_sa');
select rls_test.expect_call_ok('failure: force reset with a failing deletion', 'run_fail', rls_test.exec_sql('company_c', 'req5', rls_test.get('tk_c') #>> '{}', 'FRC'));
reset role;
drop trigger zz_test_fail_delete on public.products;
select rls_test.ok('failure: FAILED with the real reason, nothing reported as deleted',
  rls_test.get('run_fail') ->> 'status' = 'FAILED' and rls_test.get('run_fail') ->> 'error' ilike '%products%simulated failure%'
  and (rls_test.get('run_fail') ->> 'deleted_total')::int = 0, rls_test.get('run_fail')::text);
select rls_test.ok('failure: every deletion rolled back, including protected import history',
  rls_test.company_rows(rls_test.id('company_c')) - 'audit_logs' - 'erp_reset_runs' - 'erp_reset_backup_attestations'
    = rls_test.get('c_rows_0') - 'audit_logs' - 'erp_reset_runs' - 'erp_reset_backup_attestations'
  and rls_test.n('import_jobs', rls_test.id('company_c')) = 1);
select rls_test.ok('failure: no purge session left, setting cleared, recorded and audited, approval not consumed',
  not exists (select 1 from private.erp_force_purge_sessions) and coalesce(current_setting('app.erp_force_purge', true), '') = ''
  and exists (select 1 from public.erp_reset_runs where request_id = rls_test.id('req5') and status = 'FAILED' and mode = 'FORCE')
  and rls_test.audits(rls_test.id('company_c'), 'erp_force_reset.failed') = 1
  and private.erp_force_reset_active_approval(rls_test.id('company_c')) is not null);

-- Failure reported by the Edge Function (e.g. statement timeout) is recorded once.
set local role service_role;
select rls_test.expect_call_ok('failure record: a request that never stored a run', 'rf1',
  format($q$ select public.erp_force_reset_record_failure(%L, %L, %L, 'canceling statement due to statement timeout') $q$,
         rls_test.id('c_sa'), rls_test.id('company_c'), rls_test.id('req6')));
select rls_test.expect_call_ok('failure record: the same request again', 'rf2',
  format($q$ select public.erp_force_reset_record_failure(%L, %L, %L, 'again') $q$, rls_test.id('c_sa'), rls_test.id('company_c'), rls_test.id('req6')));
select rls_test.expect_call_ok('failure record: a request that completed is never overwritten', 'rf3',
  format($q$ select public.erp_force_reset_record_failure(%L, %L, %L, 'late error') $q$, rls_test.id('b_sa'), rls_test.id('company_b'), rls_test.id('req3')));
reset role;
select rls_test.ok('failure record: FAILED once, replayed after, completed run returned unchanged',
  rls_test.get('rf1') ->> 'status' = 'FAILED' and not (rls_test.get('rf1') ->> 'replayed')::boolean
  and (rls_test.get('rf2') ->> 'replayed')::boolean and rls_test.get('rf2') ->> 'run_id' = rls_test.get('rf1') ->> 'run_id'
  and rls_test.get('rf3') ->> 'status' = 'COMPLETED' and (select count(*) from public.erp_reset_runs where request_id = rls_test.id('req6')) = 1);

-- ---------------------------------------------------------------------------
-- 9. Unreviewed tables and demo_presentation_data
-- ---------------------------------------------------------------------------
create table public.zz_force_unreviewed (id uuid primary key default gen_random_uuid(), company_id uuid);
alter table public.zz_force_unreviewed enable row level security;
create table public.zz_force_ref (id uuid primary key default gen_random_uuid(), product_id uuid references public.products (id));
alter table public.zz_force_ref enable row level security;
select rls_test.set('plan_unrev', private.erp_force_reset_plan(rls_test.id('company_c')));
select rls_test.set('tk_c2', to_jsonb(rls_test.ticket('c_sa', 'company_c')));
set local role authenticated;
select rls_test.claims('c_sa');
select rls_test.expect_call_ok('unreviewed: force reset with unreviewed tables', 'run_unrev', rls_test.exec_sql('company_c', 'req7', rls_test.get('tk_c2') #>> '{}', 'FRC'));
reset role;
drop table public.zz_force_ref;
drop table public.zz_force_unreviewed;
select rls_test.ok('unreviewed: a company-scoped table outside both lists blocks (UNREVIEWED_COMPANY_TABLE)',
  exists (select 1 from jsonb_array_elements(rls_test.get('plan_unrev') -> 'blockers') b where b ->> 'kind' = 'UNREVIEWED_COMPANY_TABLE' and b ->> 'table' = 'zz_force_unreviewed'));
select rls_test.ok('unreviewed: a foreign key from a non-purge table into products blocks (RETAINED_TABLE_REFERENCE)',
  exists (select 1 from jsonb_array_elements(rls_test.get('plan_unrev') -> 'blockers') b where b ->> 'kind' = 'RETAINED_TABLE_REFERENCE' and b ->> 'table' = 'public.zz_force_ref'));
select rls_test.ok('unreviewed: BLOCKED and nothing deleted',
  rls_test.get('run_unrev') ->> 'status' = 'BLOCKED' and rls_test.n('products', rls_test.id('company_c')) = 1, rls_test.get('run_unrev')::text);

-- demo_presentation_data without company_id: cannot be scoped, blocks.
create table public.demo_presentation_data (id uuid primary key default gen_random_uuid(), payload text);
select rls_test.set('plan_demo1', private.erp_force_reset_plan(rls_test.id('company_c')));
drop table public.demo_presentation_data;
select rls_test.ok('demo data: without company_id it is reported and blocks',
  rls_test.get('plan_demo1') ->> 'demo_presentation_data' = 'NOT_COMPANY_SCOPED'
  and exists (select 1 from jsonb_array_elements(rls_test.get('plan_demo1') -> 'blockers') b where b ->> 'kind' = 'DEMO_TABLE_NOT_COMPANY_SCOPED'));

-- demo_presentation_data with company_id: resettable (standard and force), deleted for C only.
create table public.demo_presentation_data (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies (id), payload jsonb);
alter table public.demo_presentation_data enable row level security;
insert into public.demo_presentation_data (company_id, payload) values
  (rls_test.id('company_c'), '{"slide": 1}'), (rls_test.id('company_c'), '{"slide": 2}'), (rls_test.id('company_a'), '{"slide": 1}');
select rls_test.ok('demo data: classified as resettable by the standard reset too',
  exists (select 1 from private.erp_reset_tables() where table_name = 'demo_presentation_data')
  and exists (select 1 from private.erp_force_reset_tables() where table_name = 'demo_presentation_data'));
select rls_test.set('tk_c3', to_jsonb(rls_test.ticket('c_sa', 'company_c')));
set local role authenticated;
select rls_test.claims('c_sa');
select rls_test.expect_call_ok('demo data: preview counts it', 'prev_c', format($q$ select public.erp_force_reset_preview(%L) $q$, rls_test.id('company_c')));
select rls_test.expect_call_ok('demo data: force reset of company C', 'run_c',
  format($q$ select public.erp_force_reset_execute(%L, %L, 'DELETE ALL COMPANY DATA', 'FRC', %L, %L) $q$,
         rls_test.id('company_c'), rls_test.id('req8'), rls_test.get('bk_c') ->> 'id', rls_test.get('tk_c3') #>> '{}'));
reset role;
select rls_test.ok('demo data: preview lists 2 rows of C',
  rls_test.get('prev_c') ->> 'demo_presentation_data' = 'RESETTABLE'
  and (select (e ->> 'rows')::int from jsonb_array_elements(rls_test.get('prev_c') -> 'tables') e where e ->> 'table' = 'demo_presentation_data') = 2,
  rls_test.get('prev_c') ->> 'tables');
select rls_test.ok('demo data: C reset COMPLETED, C''s demo rows deleted, A''s kept, C fully empty',
  rls_test.get('run_c') ->> 'status' = 'COMPLETED' and (rls_test.get('run_c') -> 'deleted' ->> 'demo_presentation_data')::int = 2
  and rls_test.n('demo_presentation_data', rls_test.id('company_c')) = 0 and rls_test.n('demo_presentation_data', rls_test.id('company_a')) = 1
  and rls_test.purge_left(rls_test.id('company_c')) = '{}'::jsonb, rls_test.get('run_c')::text);
drop table public.demo_presentation_data;

-- ===========================================================================
-- Result
-- ===========================================================================
do $$
declare
  v_passed int;
  v_failed int;
  v_report text;
begin
  select count(*) filter (where passed), count(*) filter (where not passed) into v_passed, v_failed from rls_test.results;
  select string_agg(format('%s %s%s', case when passed then 'PASS' else 'FAIL' end, name,
                           case when passed then '' else ' -- ' || coalesce(detail, '') end), E'\n' order by id)
    into v_report from rls_test.results;
  raise exception 'ERP_FORCE_RESET_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
