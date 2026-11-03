-- =============================================================================
-- ADMINISTRATION & PRODUCTIVITY (PHASE 10) VERIFICATION
--
-- Barcode lookup / assignment, scan-without-posting and retry safety, the
-- approval engine (authorisation, self-approval, duplicate decisions, multi-
-- stage, thresholds, stale documents, gate on the existing module actions),
-- notifications (privacy, deduplication), documents (private storage,
-- validation, versions, cross-company), audit immutability and coverage,
-- import history and retries, user activity and session revocation, last
-- Super Admin protection, system health honesty, error-log redaction and
-- configuration permissions.
--
--   locally:      npm run test:db
--   on Supabase:  paste into Dashboard > SQL Editor and run (after migrations)
--
-- Runs in one transaction with its own companies (ADA / ADB) and ALWAYS ends by
-- raising ADMIN_VERIFICATION_RESULT passed=N failed=M (rolls everything back).
-- =============================================================================

begin;

create schema rls_test;
grant usage on schema rls_test to anon, authenticated;
create table rls_test.results (id serial primary key, name text not null, passed boolean not null, detail text);
create table rls_test.ids (key text primary key, id uuid not null);
create table rls_test.vars (key text primary key, value jsonb);
grant select, insert on rls_test.results to anon, authenticated;
grant usage on sequence rls_test.results_id_seq to anon, authenticated;
grant select on rls_test.ids to anon, authenticated;
grant select, insert, update on rls_test.vars to anon, authenticated;

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
create function rls_test.gid(p_key text, p_field text) returns uuid language sql stable as $$ select (value ->> p_field)::uuid from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error'), left(r::text, 1500)); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'error' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), left(r::text, 500)); end $$;
create function rls_test.expect_error(p_name text, p_sql text) returns void language plpgsql as $$
begin execute p_sql; perform rls_test.ok(p_name, false, 'statement succeeded but should have been rejected');
exception when others then perform rls_test.ok(p_name, true, format('rejected %s: %s', sqlstate, sqlerrm)); end $$;
create function rls_test.rows(p_sql text) returns int language plpgsql as $$
declare n int; begin execute format('select count(*) from (%s) q', p_sql) into n; return n; end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- Owner-side probes
create function rls_test.tx_count(p_company uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.inventory_transactions where company_id = p_company $$;
create function rls_test.req(p_type text, p_doc uuid) returns public.approval_requests language sql stable security definer as $$
  select * from public.approval_requests where document_type = p_type and document_id = p_doc order by requested_at desc, (status = 'PENDING_APPROVAL') desc, decided_at desc nulls first limit 1 $$;
create function rls_test.req_count(p_type text, p_doc uuid) returns int language sql stable security definer as $$
  select count(*)::int from public.approval_requests where document_type = p_type and document_id = p_doc $$;
create function rls_test.notes_for(p_user uuid, p_type text) returns int language sql stable security definer as $$
  select count(*)::int from public.notifications where recipient_user_id = p_user and notification_type = p_type $$;
create function rls_test.note_id(p_user uuid, p_type text) returns uuid language sql stable security definer as $$
  select id from public.notifications where recipient_user_id = p_user and notification_type = p_type limit 1 $$;
create function rls_test.audit_count(p_company uuid, p_action text) returns int language sql stable security definer as $$
  select count(*)::int from public.audit_logs where company_id = p_company and action = p_action $$;
create function rls_test.so_status(p_id uuid) returns text language sql stable security definer as $$ select order_status from public.sales_orders where id = p_id $$;
create function rls_test.adj_status(p_id uuid) returns text language sql stable security definer as $$ select status from public.inventory_adjustments where id = p_id $$;
create function rls_test.pay_status(p_id uuid) returns text language sql stable security definer as $$ select status from public.customer_payments where id = p_id $$;
create function rls_test.adj_of(p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.inventory_adjustments where product_id = p_product order by adjustment_number desc limit 1 $$;
create function rls_test.object_count(p_path text) returns int language sql stable security definer as $$
  select count(*)::int from storage.objects where bucket_id = 'documents' and name = p_path $$;
create function rls_test.lot(p_product uuid) returns uuid language sql stable security definer as $$
  select id from public.inventory_batches where product_id = p_product order by created_at limit 1 $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5a000-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5a000-0000-4000-8000-0000000000b1'),
  ('sa', 'e7e5a000-0000-4000-8000-000000000001'), ('adm', 'e7e5a000-0000-4000-8000-000000000002'), ('adm2', 'e7e5a000-0000-4000-8000-000000000003'),
  ('im', 'e7e5a000-0000-4000-8000-000000000004'), ('im2', 'e7e5a000-0000-4000-8000-000000000005'), ('acc', 'e7e5a000-0000-4000-8000-000000000006'),
  ('sales', 'e7e5a000-0000-4000-8000-000000000007'), ('viewer', 'e7e5a000-0000-4000-8000-000000000008'), ('b_adm', 'e7e5a000-0000-4000-8000-000000000009'),
  ('pa', 'e7e5a000-0000-4000-8000-0000000000c1'), ('pb', 'e7e5a000-0000-4000-8000-0000000000c2'), ('pb_b', 'e7e5a000-0000-4000-8000-0000000000c3'),
  ('w1', 'e7e5a000-0000-4000-8000-0000000000e1'), ('w_b', 'e7e5a000-0000-4000-8000-0000000000e2'),
  ('cu1', 'e7e5a000-0000-4000-8000-0000000000d1');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, legal_address, state, gstin) values
  (rls_test.id('company_a'), 'Admin Test A Pvt Ltd', 'Admin A', 'ADA', 'Plot 5, MIDC, Pune', 'Maharashtra', '27AADCA1234B1Z5'),
  (rls_test.id('company_b'), 'Admin Test B', 'Admin B', 'ADB', null, null, null);
insert into auth.users (id, email, last_sign_in_at) select id, key || '@ad.example.invalid', now() - interval '1 hour'
  from rls_test.ids where key in ('sa', 'adm', 'adm2', 'im', 'im2', 'acc', 'sales', 'viewer', 'b_adm');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true
  where id in (select id from rls_test.ids where key in ('sa', 'adm', 'adm2', 'im', 'im2', 'acc', 'sales', 'viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_adm');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sa'),     rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('adm'),    rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('adm2'),   rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('im'),     rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('im2'),    rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
  (rls_test.id('acc'),    rls_test.id('company_a'), rls_test.id('role_accounts_manager')),
  (rls_test.id('sales'),  rls_test.id('company_a'), rls_test.id('role_sales_manager')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_adm'),  rls_test.id('company_b'), rls_test.id('role_admin')),
  (rls_test.id('b_adm'),  rls_test.id('company_b'), rls_test.id('role_inventory_manager'));
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, barcode, selling_price, reorder_level, status) values
  (rls_test.id('pa'), rls_test.id('company_a'), 'AD-BASIN', 'Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '8900000000017', 500, 500, 'ACTIVE'),
  (rls_test.id('pb'), rls_test.id('company_a'), 'AD-TAP', 'Tap', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', null, 200, null, 'ACTIVE'),
  (rls_test.id('pb_b'), rls_test.id('company_b'), 'B-BASIN', 'Basin B', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', '8900000000017', null, null, 'ACTIVE');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Main', true), (rls_test.id('w_b'), rls_test.id('company_b'), 'WB', 'B store', true);
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where location_code = 'GENERAL' and warehouse_id = rls_test.id('w1');
insert into public.customers (id, company_id, customer_code, customer_name) values (rls_test.id('cu1'), rls_test.id('company_a'), 'C1', 'Pune Traders');

select rls_test.ok('RLS enabled on every public table (including Phase 10 tables)',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));
select rls_test.ok('clients cannot write Phase 10 tables directly (only through checked functions)',
  not exists (select 1 from unnest(array['notifications', 'notification_preferences', 'error_events', 'approval_workflows', 'approval_workflow_stages',
    'approval_requests', 'approval_decisions', 'documents', 'document_versions', 'import_jobs', 'import_job_rows']) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE') or has_table_privilege('anon', 'public.' || t, 'SELECT')));
select rls_test.ok('the documents bucket is private', (select not public from storage.buckets where id = 'documents'));

set local role authenticated;

-- ===========================================================================
-- BARCODE AND SCANNING
-- ===========================================================================
select rls_test.claims('im');
select rls_test.set('rk', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('scan: receipt posted once with a request id', 'r1',
  format($q$ select public.inventory_post_receipt(%L, %L, 100, 'IN_HOUSE', p_unit_cost => 10, p_idempotency_key => %L) $q$, rls_test.id('pa'), rls_test.id('g1'), rls_test.get('rk') #>> '{}'));
select rls_test.set('tx_after_receipt', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.expect_call_ok('scan: a repeated scan / retry with the same request id', 'r1b',
  format($q$ select public.inventory_post_receipt(%L, %L, 100, 'IN_HOUSE', p_unit_cost => 10, p_idempotency_key => %L) $q$, rls_test.id('pa'), rls_test.id('g1'), rls_test.get('rk') #>> '{}'));
select rls_test.ok('scan: retries cannot create a duplicate stock movement', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_after_receipt') #>> '{}')::int);
select rls_test.expect_call_ok('barcode: lookup by barcode', 'lk1', $q$ select public.barcode_lookup('8900000000017') $q$);
select rls_test.ok('barcode: lookup returns the company''s product with its current stock',
  jsonb_array_length(rls_test.get('lk1') -> 'matches') = 1 and rls_test.get('lk1') #>> '{matches,0,id}' = rls_test.id('pa')::text
  and (rls_test.get('lk1') #>> '{matches,0,on_hand}')::numeric = 100 and rls_test.get('lk1') #>> '{matches,0,matched_on}' = 'BARCODE', rls_test.get('lk1')::text);
select rls_test.ok('barcode: internal QR links resolve product, lot and location',
  public.barcode_lookup('https://erp.example/scan?c=P-' || rls_test.id('pa')) #>> '{matches,0,kind}' = 'PRODUCT'
  and public.barcode_lookup('B-' || rls_test.lot(rls_test.id('pa'))) #>> '{matches,0,kind}' = 'BATCH'
  and public.barcode_lookup('W1/GENERAL') #>> '{matches,0,kind}' = 'LOCATION'
  and public.barcode_lookup('ad-basin') #>> '{matches,0,matched_on}' = 'SKU');
select rls_test.ok('scan: looking codes up posts no stock movement', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_after_receipt') #>> '{}')::int);
select rls_test.ok('barcode: an unknown code returns no matches (not an error)', jsonb_array_length(public.barcode_lookup('NO-SUCH-CODE') -> 'matches') = 0);
select rls_test.claims('b_adm');
select rls_test.ok('barcode: another company scanning the same barcode only sees its own product',
  (select bool_and(m ->> 'id' = rls_test.id('pb_b')::text) from jsonb_array_elements(public.barcode_lookup('8900000000017') -> 'matches') m)
  and jsonb_array_length(public.barcode_lookup('https://x/scan?c=P-' || rls_test.id('pa')) -> 'matches') = 0);
select rls_test.claims('im');
select rls_test.expect_call_error('barcode: a barcode already used by another product is rejected',
  format($q$ select public.product_assign_barcode(%L, '8900000000017', null, false) $q$, rls_test.id('pb')), 'already assigned to AD-BASIN');
select rls_test.expect_call_error('barcode: replacing an existing barcode needs confirmation',
  format($q$ select public.product_assign_barcode(%L, '8900000000024', '8900000000017', false) $q$, rls_test.id('pa')), 'Confirm');
select rls_test.expect_call_error('barcode: a stale form (barcode changed meanwhile) is refused',
  format($q$ select public.product_assign_barcode(%L, '8900000000024', '1111', true) $q$, rls_test.id('pa')), 'changed since');
select rls_test.expect_call_ok('barcode: assign a new barcode to a product without one', 'bc1',
  format($q$ select public.product_assign_barcode(%L, 'AD-TAP-001', null, false) $q$, rls_test.id('pb')));
select rls_test.claims('sales');
select rls_test.expect_call_error('barcode: users without products.update cannot assign barcodes',
  format($q$ select public.product_assign_barcode(%L, 'X-12345', null, false) $q$, rls_test.id('pb')), 'products.update');

-- ===========================================================================
-- APPROVAL ENGINE
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_call_error('approvals: only approvals.manage can configure workflows',
  $q$ select public.approval_workflow_save('{"name": "Adjustments", "document_type": "STOCK_ADJUSTMENT"}'::jsonb, '[{"approver_roles": ["ADMIN"]}]'::jsonb) $q$, 'approvals.manage');
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: Admin configures a two-stage stock-adjustment workflow', 'wf_adj',
  $q$ select public.approval_workflow_save('{"name": "Stock adjustments", "document_type": "STOCK_ADJUSTMENT"}'::jsonb,
    '[{"name": "Stores review", "approver_roles": ["INVENTORY_MANAGER"]}, {"name": "Admin sign-off", "approver_roles": ["ADMIN"]}]'::jsonb) $q$);
select rls_test.expect_call_error('approvals: invalid configuration is refused (unknown role)',
  $q$ select public.approval_workflow_save('{"name": "Bad", "document_type": "STOCK_ADJUSTMENT"}'::jsonb, '[{"approver_roles": ["NOBODY"]}]'::jsonb) $q$, 'Unknown approver role');
select rls_test.expect_call_error('approvals: self-approval cannot be allowed for financial documents',
  $q$ select public.approval_workflow_save('{"name": "Invoices self", "document_type": "INVOICE", "allow_self_approval": true}'::jsonb,
    '[{"approver_roles": ["ACCOUNTS_MANAGER"]}]'::jsonb) $q$, 'financial documents');
reset role;
select rls_test.expect_call_error('approvals: the table constraint also rejects financial self-approval written directly',
  format($q$ insert into public.approval_workflows (company_id, name, document_type, allow_self_approval) values (%L, 'Direct self', 'PAYMENT_REVERSAL', true) returning '{}'::jsonb $q$,
    rls_test.id('company_a')), 'no_financial_self_approval');
set local role authenticated;
select rls_test.claims('adm');
select rls_test.claims('im');
select public.inventory_create_adjustment('QUANTITY', rls_test.id('pa'), rls_test.id('g1'), 'DAMAGE', p_source_type => 'IN_HOUSE', p_counted_quantity => 98,
  p_notes => 'Two cracked (inactive workflow)', p_submit => true, p_idempotency_key => gen_random_uuid());
select rls_test.ok('approvals: workflows are inactive until switched on (no request created)', rls_test.req_count('STOCK_ADJUSTMENT', rls_test.adj_of(rls_test.id('pa'))) = 0);
select public.inventory_update_adjustment_status(rls_test.adj_of(rls_test.id('pa')), 'CANCEL');
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: Admin activates the workflow', 'wf_on', format($q$ select public.approval_workflow_set_active(%L, true) $q$, rls_test.gid('wf_adj', 'workflow_id')));
select rls_test.claims('im');
select public.inventory_create_adjustment('QUANTITY', rls_test.id('pa'), rls_test.id('g1'), 'DAMAGE', p_source_type => 'IN_HOUSE', p_counted_quantity => 97,
  p_notes => 'Three cracked basins', p_submit => true, p_idempotency_key => gen_random_uuid());
reset role;
insert into rls_test.ids values ('adj1', rls_test.adj_of(rls_test.id('pa')));
set local role authenticated;
select rls_test.ok('approvals: submitting the adjustment created a request at stage 1 with the workflow version',
  (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).status = 'PENDING_APPROVAL' and (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).current_stage = 1
  and (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).workflow_version = 1 and (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).requested_by = rls_test.id('im'));
select rls_test.ok('notifications: the stage-1 approver (other inventory manager) was notified, the requester was not',
  rls_test.notes_for(rls_test.id('im2'), 'APPROVAL_REQUESTED') = 1 and rls_test.notes_for(rls_test.id('im'), 'APPROVAL_REQUESTED') = 0);
select rls_test.set('tx_before_adj', to_jsonb(rls_test.tx_count(rls_test.id('company_a'))));
select rls_test.claims('adm');
select rls_test.expect_call_error('approvals: the module approval is blocked until the workflow approves (no bypass)',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', 'ok', gen_random_uuid()) $q$, rls_test.id('adj1')), 'Approval required');
select rls_test.ok('approvals: the blocked approval posted nothing', rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before_adj') #>> '{}')::int
  and rls_test.adj_status(rls_test.id('adj1')) = 'PENDING_APPROVAL');
select rls_test.claims('sales');
select rls_test.expect_call_error('approvals: users outside the stage cannot approve',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id), 'not an approver');
select rls_test.claims('im');
select rls_test.expect_call_error('approvals: the requester cannot approve their own request (self-approval off)',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id), 'Segregation');
select rls_test.claims('adm');
select rls_test.expect_call_error('approvals: stage 2 approvers cannot decide stage 1',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id), 'not an approver for stage 1');
select rls_test.claims('im2');
select rls_test.expect_call_ok('approvals: stage 1 approved by the other inventory manager', 'd1',
  format($q$ select public.approval_decide(%L, 'APPROVE', 'Checked the damage') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id));
select rls_test.ok('approvals: the request moved to stage 2 and Admins were notified',
  rls_test.get('d1') ->> 'stage' = '2' and rls_test.notes_for(rls_test.id('adm'), 'APPROVAL_REQUESTED') >= 1);
select rls_test.expect_call_error('approvals: the same approver cannot decide again',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id), 'not an approver');
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: stage 2 approved by an Admin', 'd2',
  format($q$ select public.approval_decide(%L, 'APPROVE', 'Approved') $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id));
select rls_test.ok('approvals: approval alone posts no stock movement', rls_test.get('d2') ->> 'status' = 'APPROVED'
  and rls_test.tx_count(rls_test.id('company_a')) = (rls_test.get('tx_before_adj') #>> '{}')::int and rls_test.adj_status(rls_test.id('adj1')) = 'PENDING_APPROVAL');
select rls_test.expect_call_ok('approvals: the module approval now runs with all its own checks', 'adj1_ok',
  format($q$ select public.inventory_review_adjustment(%L, 'APPROVE', 'ok', gen_random_uuid()) $q$, rls_test.id('adj1')));
select rls_test.ok('approvals: the adjustment posted and the approval was consumed; requester notified',
  rls_test.adj_status(rls_test.id('adj1')) = 'POSTED' and (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).consumed_at is not null
  and rls_test.notes_for(rls_test.id('im'), 'APPROVAL_APPROVED') = 1);
select rls_test.ok('audit: approval request and decisions are in the audit log',
  rls_test.audit_count(rls_test.id('company_a'), 'approval.requested') >= 1 and rls_test.audit_count(rls_test.id('company_a'), 'approval.approved') = 2);
reset role;
select rls_test.expect_error('approvals: decisions are immutable (even for the database owner)',
  format($q$ update public.approval_decisions set decision = 'REJECT' where request_id = %L $q$, (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj1'))).id));
set local role authenticated;

-- Leaving the approval state cancels the open request.
select rls_test.claims('im');
select public.inventory_create_adjustment('QUANTITY', rls_test.id('pa'), rls_test.id('g1'), 'LOSS', p_source_type => 'IN_HOUSE', p_counted_quantity => 96,
  p_notes => 'One missing basin', p_submit => true, p_idempotency_key => gen_random_uuid());
reset role;
insert into rls_test.ids values ('adj2', rls_test.adj_of(rls_test.id('pa')));
set local role authenticated;
select public.inventory_update_adjustment_status(rls_test.id('adj2'), 'CANCEL');
select rls_test.ok('approvals: cancelling the document cancels its open request',
  (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj2'))).status = 'CANCELLED' and (rls_test.req('STOCK_ADJUSTMENT', rls_test.id('adj2'))).cancel_reason like 'The document left%');

-- Threshold, staleness and resubmission on sales orders.
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: sales orders of 1000 or more need Admin approval', 'wf_so',
  $q$ select public.approval_workflow_save('{"name": "Large sales orders", "document_type": "SALES_ORDER", "min_amount": 1000}'::jsonb,
    '[{"name": "Admin", "approver_roles": ["ADMIN"]}]'::jsonb) $q$);
select public.approval_workflow_set_active(rls_test.gid('wf_so', 'workflow_id'), true);
select rls_test.claims('sales');
select rls_test.set('so_small', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu1'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pb'), 'quantity', 1, 'unit_price', 500)), false, gen_random_uuid()));
select rls_test.set('so_big', public.sales_order_create_manual(jsonb_build_object('customer_id', rls_test.id('cu1'), 'warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('pb'), 'quantity', 10, 'unit_price', 500)), false, gen_random_uuid()));
-- The automatic request for a sales order is created at commit (after its lines); fire it now as a commit would.
set constraints all immediate;
set constraints all deferred;
select rls_test.ok('approvals: thresholds apply (500 order: none; 5000 order: request)',
  rls_test.req_count('SALES_ORDER', rls_test.gid('so_small', 'sales_order_id')) = 0 and rls_test.req_count('SALES_ORDER', rls_test.gid('so_big', 'sales_order_id')) = 1
  and (rls_test.req('SALES_ORDER', rls_test.gid('so_big', 'sales_order_id'))).amount = 5000);
select rls_test.expect_call_ok('approvals: an order below the threshold confirms normally', 'so_small_ok',
  format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so_small', 'sales_order_id')));
select rls_test.expect_call_error('approvals: the large order cannot be confirmed before approval',
  format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so_big', 'sales_order_id')), 'Approval required');
select public.sales_order_update(rls_test.gid('so_big', 'sales_order_id'), jsonb_build_object('requested_delivery_date', rls_test.today() + 20));
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: deciding a request whose document changed', 'stale',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, (rls_test.req('SALES_ORDER', rls_test.gid('so_big', 'sales_order_id'))).id));
select rls_test.ok('approvals: a changed document invalidates the request (cancelled, must be resubmitted)',
  (rls_test.get('stale') ->> 'stale')::boolean and (rls_test.req('SALES_ORDER', rls_test.gid('so_big', 'sales_order_id'))).status = 'CANCELLED'
  and not exists (select 1 from public.approval_decisions d where d.request_id = (rls_test.req('SALES_ORDER', rls_test.gid('so_big', 'sales_order_id'))).id));
select rls_test.claims('sales');
select rls_test.expect_call_ok('approvals: the requester resubmits', 'resub',
  format($q$ select public.approval_request_submit('SALES_ORDER', %L, 'Delivery date agreed') $q$, rls_test.gid('so_big', 'sales_order_id')));
select rls_test.claims('adm');
select rls_test.expect_call_error('approvals: rejecting needs a reason',
  format($q$ select public.approval_decide(%L, 'REJECT', '') $q$, rls_test.gid('resub', 'request_id')), 'reason');
select rls_test.expect_call_ok('approvals: approved after resubmission', 'so_ok', format($q$ select public.approval_decide(%L, 'APPROVE') $q$, rls_test.gid('resub', 'request_id')));
select rls_test.claims('sales');
select public.sales_order_update(rls_test.gid('so_big', 'sales_order_id'), jsonb_build_object('requested_delivery_date', rls_test.today() + 25));
select rls_test.expect_call_error('approvals: a document changed after approval cannot use that approval',
  format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so_big', 'sales_order_id')), 'changed after it was approved');
select rls_test.expect_call_ok('approvals: resubmitted after the change', 'resub2',
  format($q$ select public.approval_request_submit('SALES_ORDER', %L, 'Date moved again') $q$, rls_test.gid('so_big', 'sales_order_id')));
select rls_test.claims('adm2');
select public.approval_decide(rls_test.gid('resub2', 'request_id'), 'APPROVE');
select rls_test.claims('sales');
select rls_test.expect_call_ok('approvals: the approved, unchanged order confirms through the existing function', 'so_conf',
  format($q$ select public.sales_order_confirm(%L) $q$, rls_test.gid('so_big', 'sales_order_id')));
select rls_test.ok('approvals: order confirmed and approval consumed', rls_test.so_status(rls_test.gid('so_big', 'sales_order_id')) = 'CONFIRMED'
  and exists (select 1 from public.approval_requests r where r.document_id = rls_test.gid('so_big', 'sales_order_id') and r.status = 'APPROVED' and r.consumed_at is not null)
  and not exists (select 1 from public.approval_requests r where r.document_id = rls_test.gid('so_big', 'sales_order_id') and r.status = 'APPROVED' and r.consumed_at is null));

-- Payment reversal: two approvals required at one stage; duplicate decisions refused.
select rls_test.claims('acc');
select rls_test.set('pay', public.customer_payment_record(jsonb_build_object('customer_id', rls_test.id('cu1'), 'receipt_date', rls_test.today(), 'amount', '5000',
  'payment_method', 'UPI', 'transaction_reference', 'UTR-AD-1'), '[]'::jsonb, gen_random_uuid()));
select rls_test.claims('adm');
select public.approval_workflow_set_active((public.approval_workflow_save('{"name": "Payment reversals", "document_type": "PAYMENT_REVERSAL"}'::jsonb,
  '[{"name": "Two admins", "approver_roles": ["ADMIN"], "required_approvals": 2}]'::jsonb) ->> 'workflow_id')::uuid, true);
select rls_test.claims('acc');
select rls_test.expect_call_error('approvals: a payment reversal is blocked without approval',
  format($q$ select public.customer_payment_reverse(%L, 'Entered twice', gen_random_uuid()) $q$, rls_test.gid('pay', 'payment_id')), 'Approval required');
select rls_test.expect_call_ok('approvals: Accounts requests approval to reverse the receipt', 'pr',
  format($q$ select public.approval_request_submit('PAYMENT_REVERSAL', %L, 'Entered twice') $q$, rls_test.gid('pay', 'payment_id')));
select rls_test.claims('adm');
select rls_test.expect_call_ok('approvals: first Admin approves (1 of 2)', 'pr1', format($q$ select public.approval_decide(%L, 'APPROVE') $q$, rls_test.gid('pr', 'request_id')));
select rls_test.expect_call_error('approvals: the same Admin cannot approve the same stage twice',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, rls_test.gid('pr', 'request_id')), 'already decided');
select rls_test.ok('approvals: still pending with one of two approvals', rls_test.get('pr1') ->> 'status' = 'PENDING_APPROVAL' and rls_test.get('pr1') ->> 'approvals' = '1');
select rls_test.claims('adm2');
select public.approval_decide(rls_test.gid('pr', 'request_id'), 'APPROVE');
select rls_test.claims('acc');
select rls_test.expect_call_ok('approvals: the reversal runs through the existing function after approval', 'rev',
  format($q$ select public.customer_payment_reverse(%L, 'Entered twice', gen_random_uuid()) $q$, rls_test.gid('pay', 'payment_id')));
select rls_test.ok('approvals: receipt reversed', rls_test.pay_status(rls_test.gid('pay', 'payment_id')) = 'REVERSED');
select rls_test.claims('b_adm');
select rls_test.ok('cross-company: company B sees no company A workflows or requests',
  rls_test.rows('select * from public.approval_requests') = 0 and rls_test.rows('select * from public.approval_workflows') = 0
  and jsonb_array_length(public.approval_inbox('ALL') -> 'requests') = 0);
select rls_test.expect_call_error('cross-company: company B cannot decide a company A request',
  format($q$ select public.approval_decide(%L, 'APPROVE') $q$, rls_test.gid('resub2', 'request_id')), 'not found');

-- ===========================================================================
-- NOTIFICATIONS
-- ===========================================================================
select rls_test.claims('im');
select rls_test.ok('notifications: users cannot read other users'' notifications',
  rls_test.rows(format('select * from public.notifications where recipient_user_id = %L', rls_test.id('im2'))) = 0
  and rls_test.rows('select * from public.notifications') = rls_test.rows(format('select * from public.notifications where recipient_user_id = %L', rls_test.id('im'))));
select rls_test.ok('notifications: marking another user''s notification as read changes nothing',
  public.notifications_mark_read(array[rls_test.note_id(rls_test.id('im2'), 'APPROVAL_REQUESTED')]) = 0);
select rls_test.expect_error('notifications: clients cannot insert notifications directly',
  format($q$ insert into public.notifications (company_id, recipient_user_id, notification_type, title, message) values (%L, %L, 'FAKE', 'x', 'y') $q$,
    rls_test.id('company_a'), rls_test.id('im2')));
select rls_test.claims('adm');
select rls_test.expect_call_ok('notifications: alerts are synced into notifications', 'sync1', $q$ select public.notifications_sync(true) $q$);
select rls_test.expect_call_ok('notifications: a second refresh', 'sync2', $q$ select public.notifications_sync(true) $q$);
select rls_test.ok('notifications: refreshing does not create duplicates',
  (rls_test.get('sync1') ->> 'created')::int >= 1 and (rls_test.get('sync2') ->> 'created')::int = 0
  and rls_test.rows($q$ select deduplication_key from public.notifications where deduplication_key like 'ALERT:%' group by 1 having count(*) > 1 $q$) = 0,
  rls_test.get('sync1')::text || rls_test.get('sync2')::text);
select rls_test.ok('notifications: sync is throttled (no re-evaluation within 2 minutes)', (public.notifications_sync() ->> 'skipped')::boolean);
select rls_test.ok('notifications: mark all as read', public.notifications_mark_read() >= 1 and rls_test.rows('select * from public.notifications where read_at is null') = 0);
select public.notification_preference_set('ALERT_LOW_STOCK', false);
select rls_test.expect_call_error('notifications: approval notifications assigned to you cannot be muted',
  $q$ select public.notification_preference_set('APPROVAL_REQUESTED', false) $q$, 'cannot be turned off');
select rls_test.claims('b_adm');
select rls_test.ok('cross-company: company B sees none of company A''s notifications', rls_test.rows('select * from public.notifications') = 0);

-- ===========================================================================
-- DOCUMENTS
-- ===========================================================================
select rls_test.claims('adm');
select rls_test.expect_call_error('documents: disallowed file types are refused',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'Drawing', 'setup.exe', 1000, 'application/octet-stream') $q$, rls_test.id('pa')), 'not allowed');
select rls_test.expect_call_error('documents: a MIME type that does not match the extension is refused',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'Drawing', 'drawing.pdf', 1000, 'text/html') $q$, rls_test.id('pa')), 'does not match');
select rls_test.expect_call_error('documents: files above the size limit are refused',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'Drawing', 'drawing.pdf', 999999999, 'application/pdf') $q$, rls_test.id('pa')), 'MB');
select rls_test.expect_call_error('documents: attaching to another company''s record is refused',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'Drawing', 'drawing.pdf', 1000, 'application/pdf') $q$, rls_test.id('pb_b')), 'not found');
select rls_test.expect_call_ok('documents: upload prepared with a server-generated path (client path ignored)', 'up',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'Basin drawing', '../../etc/passwd/basin drawing.pdf', 1000, 'application/pdf') $q$, rls_test.id('pa')));
select rls_test.ok('documents: path is <company>/<document>/v1-<random>.pdf and the file name is sanitised',
  rls_test.get('up') ->> 'storage_path' like rls_test.id('company_a') || '/' || (rls_test.get('up') ->> 'document_id') || '/v1-%.pdf'
  and (select original_filename from public.document_versions where id = rls_test.gid('up', 'version_id')) = 'basin drawing.pdf');
select rls_test.expect_error('documents: storage refuses objects outside a prepared upload path',
  format($q$ insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', %L, auth.uid(), '{"size": 1000}') $q$,
    rls_test.id('company_a') || '/' || (rls_test.get('up') ->> 'document_id') || '/evil.pdf'));
select rls_test.expect_call_error('documents: completing before the file exists is refused',
  format($q$ select public.document_upload_complete(%L) $q$, rls_test.gid('up', 'version_id')), 'not been uploaded');
insert into storage.objects (bucket_id, name, owner, metadata)
values ('documents', rls_test.get('up') ->> 'storage_path', auth.uid(), '{"size": 1000, "mimetype": "application/pdf"}');
select rls_test.expect_call_ok('documents: upload completed after the object exists with the declared size', 'up_done',
  format($q$ select public.document_upload_complete(%L) $q$, rls_test.gid('up', 'version_id')));
select rls_test.ok('audit: document upload recorded', rls_test.audit_count(rls_test.id('company_a'), 'document.uploaded') = 1);
select rls_test.expect_call_error('documents: a revision needs a change note',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'x', 'drawing-v2.pdf', 2000, 'application/pdf', null, %L) $q$, rls_test.id('pa'), rls_test.gid('up', 'document_id')), 'what changed');
select rls_test.expect_call_ok('documents: a revision becomes version 2', 'up2',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'DRAWING', 'x', 'drawing-v2.pdf', 2000, 'application/pdf', null, %L, 'Updated dimensions') $q$,
    rls_test.id('pa'), rls_test.gid('up', 'document_id')));
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', rls_test.get('up2') ->> 'storage_path', auth.uid(), '{"size": 2000}');
select public.document_upload_complete(rls_test.gid('up2', 'version_id'));
select rls_test.ok('documents: both versions are kept; the current version is 2',
  (select current_version from public.documents where id = rls_test.gid('up', 'document_id')) = 2
  and rls_test.rows(format('select * from public.document_versions where document_id = %L and status = %L', rls_test.gid('up', 'document_id'), 'AVAILABLE')) = 2);
select rls_test.ok('documents: stored files cannot be deleted or overwritten through the API',
  rls_test.call(format($q$ with d as (delete from storage.objects where name = %L returning 1) select jsonb_build_object('n', (select count(*) from d)) $q$, rls_test.get('up') ->> 'storage_path')) ->> 'n' = '0'
  and rls_test.object_count(rls_test.get('up') ->> 'storage_path') = 1);
select rls_test.claims('viewer');
select rls_test.expect_call_ok('documents: an authorised reader may download (short-lived signed URL requested next)', 'dl',
  format($q$ select public.document_download(%L) $q$, rls_test.gid('up', 'version_id')));
select rls_test.ok('documents: the authorised reader can read the stored object', rls_test.rows(format('select * from storage.objects where name = %L', rls_test.get('up') ->> 'storage_path')) = 1);
select rls_test.claims('adm');
select rls_test.set('upc', public.document_upload_prepare('COMPANY', rls_test.id('company_a'), 'CONTRACT', 'Bank KYC', 'kyc.pdf', 500, 'application/pdf'));
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', rls_test.get('upc') ->> 'storage_path', auth.uid(), '{"size": 500}');
select public.document_upload_complete(rls_test.gid('upc', 'version_id'));
select rls_test.claims('im');
select rls_test.ok('documents: a company document is hidden from users without settings.manage (metadata and file)',
  rls_test.rows(format('select * from public.documents where id = %L', rls_test.gid('upc', 'document_id'))) = 0
  and rls_test.rows(format('select * from storage.objects where name = %L', rls_test.get('upc') ->> 'storage_path')) = 0);
select rls_test.expect_call_error('documents: private documents cannot be downloaded without authorisation',
  format($q$ select public.document_download(%L) $q$, rls_test.gid('upc', 'version_id')), 'not allowed');
select rls_test.expect_call_error('documents: only the uploader or a documents administrator can archive',
  format($q$ select public.document_archive(%L, 'Not needed any more') $q$, rls_test.gid('up', 'document_id')), 'uploader');
select rls_test.claims('b_adm');
select rls_test.ok('cross-company: company B cannot see company A documents or files',
  rls_test.rows('select * from public.documents') = 0 and rls_test.rows('select * from public.document_versions') = 0
  and rls_test.rows(format('select * from storage.objects where name = %L', rls_test.get('up') ->> 'storage_path')) = 0);
select rls_test.expect_call_error('cross-company: company B cannot download a company A document',
  format($q$ select public.document_download(%L) $q$, rls_test.gid('up', 'version_id')), 'not found');
select rls_test.claims('adm');
select rls_test.expect_call_ok('documents: the uploader archives with a reason', 'arch', format($q$ select public.document_archive(%L, 'Superseded drawing') $q$, rls_test.gid('up', 'document_id')));

-- ===========================================================================
-- AUDIT LOG
-- ===========================================================================
select rls_test.ok('audit: module histories are mirrored into the audit log (stock receipt, sales order, billing)',
  rls_test.audit_count(rls_test.id('company_a'), 'inventory.receipt') >= 1 and rls_test.audit_count(rls_test.id('company_a'), 'sales.created_manually') >= 1
  and rls_test.audit_count(rls_test.id('company_a'), 'billing.recorded') >= 1 and rls_test.audit_count(rls_test.id('company_a'), 'product.barcode_changed') = 1);
select rls_test.expect_error('audit: audit entries cannot be edited through the application', 'update public.audit_logs set action = ''x.y''');
select rls_test.expect_error('audit: audit entries cannot be deleted through the application', 'delete from public.audit_logs');
reset role;
select rls_test.expect_error('audit: audit entries are append-only even for the database owner', 'delete from public.audit_logs where company_id = ''e7e5a000-0000-4000-8000-0000000000a1''');
set local role authenticated;
select rls_test.claims('im');
select rls_test.ok('audit: users without audit_logs.read see no audit entries', rls_test.rows('select * from public.audit_logs') = 0);

-- ===========================================================================
-- IMPORT HISTORY
-- ===========================================================================
select rls_test.claims('im');
select rls_test.set('job_key', to_jsonb(gen_random_uuid()));
select rls_test.expect_call_ok('imports: a product import run with rejected rows is recorded', 'job1',
  format($q$ select public.import_job_record(%L::jsonb, %L::jsonb) $q$,
    jsonb_build_object('import_type', 'PRODUCTS', 'client_job_key', rls_test.get('job_key') #>> '{}', 'file_name', 'products.xlsx', 'total_rows', 3, 'success_rows', 1,
      'failed_rows', 1, 'duplicate_rows', 1),
    jsonb_build_array(jsonb_build_object('row_number', 3, 'outcome', 'FAILED', 'reference', 'AD-NEW-2', 'messages', jsonb_build_array('Unit is required'),
        'row_data', jsonb_build_object('SKU', 'AD-NEW-2')),
      jsonb_build_object('row_number', 4, 'outcome', 'DUPLICATE', 'reference', 'AD-BASIN', 'messages', jsonb_build_array('SKU already exists')))));
select rls_test.ok('imports: totals and rejected rows reported accurately; starter notified',
  (select status = 'COMPLETED_WITH_ERRORS' and total_rows = 3 and success_rows = 1 and failed_rows = 1 and duplicate_rows = 1 from public.import_jobs where id = rls_test.gid('job1', 'job_id'))
  and rls_test.rows(format('select * from public.import_job_rows where job_id = %L', rls_test.gid('job1', 'job_id'))) = 2
  and rls_test.notes_for(rls_test.id('im'), 'IMPORT_FAILED_ROWS') = 1);
select rls_test.expect_call_ok('imports: recording the same run again (retry of the request)', 'job1b',
  format($q$ select public.import_job_record(%L::jsonb, '[]'::jsonb) $q$,
    jsonb_build_object('import_type', 'PRODUCTS', 'client_job_key', rls_test.get('job_key') #>> '{}', 'total_rows', 3, 'success_rows', 3)));
select rls_test.ok('imports: the same run is never recorded twice', rls_test.gid('job1b', 'job_id') = rls_test.gid('job1', 'job_id')
  and rls_test.rows('select * from public.import_jobs') = 1);
select rls_test.expect_call_error('imports: counts that do not add up are refused',
  $q$ select public.import_job_record('{"import_type": "PRODUCTS", "client_job_key": "e7e5a000-0000-4000-8000-00000000aaaa", "total_rows": 1, "success_rows": 2}'::jsonb) $q$, 'add up');
insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
values (rls_test.id('company_a'), 'AD-NEW-1', 'Imported row', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE');
select rls_test.expect_error('imports: retrying a row that already succeeded cannot duplicate it (existing unique SKU rule)',
  format($q$ insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status) values (%L, 'AD-NEW-1', 'Again', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE') $q$,
    rls_test.id('company_a')));
select rls_test.expect_call_ok('imports: a retry of the rejected row is linked to the original run', 'job2',
  format($q$ select public.import_job_record(%L::jsonb) $q$,
    jsonb_build_object('import_type', 'PRODUCTS', 'client_job_key', gen_random_uuid(), 'retry_of_job_id', rls_test.gid('job1', 'job_id'), 'total_rows', 1, 'success_rows', 1)));
select rls_test.ok('imports: retry recorded as completed', (select status = 'COMPLETED' and retry_of_job_id = rls_test.gid('job1', 'job_id') from public.import_jobs where id = rls_test.gid('job2', 'job_id')));
reset role;
select rls_test.expect_error('imports: import history is append-only', format('update public.import_jobs set success_rows = 3 where id = %L', rls_test.gid('job1', 'job_id')));
set local role authenticated;
select rls_test.claims('acc');
select rls_test.expect_call_error('imports: users without the import permission cannot record runs',
  $q$ select public.import_job_record('{"import_type": "PRODUCTS", "client_job_key": "e7e5a000-0000-4000-8000-00000000bbbb", "total_rows": 1, "success_rows": 1}'::jsonb) $q$, 'products.import');
select rls_test.ok('imports: other users without bulk_operations.read do not see the history', rls_test.rows('select * from public.import_jobs') = 0);
select rls_test.claims('adm');
select rls_test.ok('imports: Bulk Operations readers see every run', rls_test.rows('select * from public.import_jobs') = 2);

-- ===========================================================================
-- USERS, SESSIONS, SUPER ADMIN PROTECTION
-- ===========================================================================
select rls_test.expect_call_ok('users: Admin opens user activity', 'ua', $q$ select public.user_activity_list() $q$);
select rls_test.ok('users: activity shows roles, status and Supabase sign-in time, and no secrets',
  (select bool_and(not (u ? 'encrypted_password') and not (u ? 'password') and not (u ? 'token') and not (u ? 'session_id') and u ? 'roles' and u ? 'auth_last_sign_in_at')
   from jsonb_array_elements(rls_test.get('ua') -> 'users') u)
  and rls_test.get('ua')::text !~* '(encrypted_password|refresh_token|access_token)', left(rls_test.get('ua')::text, 600));
reset role;
insert into auth.sessions (user_id) values (rls_test.id('im')), (rls_test.id('im'));
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_error('sessions: a reason is required', format($q$ select public.admin_revoke_sessions(%L, '') $q$, rls_test.id('im')), 'reason');
select rls_test.expect_call_ok('sessions: Admin ends a user''s sessions on the server', 'rv', format($q$ select public.admin_revoke_sessions(%L, 'Lost device') $q$, rls_test.id('im')));
select rls_test.ok('sessions: sessions removed and the action audited', (rls_test.get('rv') ->> 'sessions')::int = 2
  and rls_test.audit_count(rls_test.id('company_a'), 'security.sessions_revoked') = 1);
select rls_test.expect_call_error('sessions: an Admin cannot end a Super Admin''s sessions',
  format($q$ select public.admin_revoke_sessions(%L, 'Testing protection') $q$, rls_test.id('sa')), 'Super Admin');
select rls_test.claims('viewer');
select rls_test.expect_call_error('users: activity is restricted to user administrators', $q$ select public.user_activity_list() $q$, 'users.manage');
reset role;
select rls_test.expect_error('super admin: the last active Super Admin cannot be deactivated (even by a trusted backend)',
  format('update public.profiles set is_active = false where id = %L', rls_test.id('sa')));
select rls_test.expect_error('super admin: the Super Admin role cannot be removed from the last active Super Admin',
  format('delete from public.user_roles where user_id = %L and role_id = %L', rls_test.id('sa'), rls_test.id('role_super_admin')));
set local role authenticated;

-- ===========================================================================
-- SYSTEM HEALTH AND ERROR LOG
-- ===========================================================================
select rls_test.claims('acc');
select rls_test.expect_call_ok('errors: an error is logged with a correlation id', 'err',
  $q$ select to_jsonb(public.log_client_error('corr-1234-abcd', 'billing/payments', 'Failed for ops@example.com with Bearer eyJhbGciOiJ.eyJzdWIiOi.sig123 token=abc123',
    'PGRST301', '{"access_token": "secret-value", "page": "/billing/payments", "detail": "password: hunter2"}'::jsonb)) $q$);
select rls_test.ok('errors: users without system_health.read cannot read the error log', rls_test.rows('select * from public.error_events') = 0);
select rls_test.claims('adm');
select rls_test.expect_call_ok('health: Admin runs the health checks', 'hc', $q$ select public.system_health_check() $q$);
select rls_test.ok('errors: secrets, tokens and e-mail addresses are redacted before storage',
  (select message !~ '(eyJ|ops@example.com|abc123)' and context ->> 'access_token' = '[redacted]' and context ->> 'detail' !~ 'hunter2' and context ->> 'page' = '/billing/payments'
   from public.error_events where correlation_id = 'corr-1234-abcd'),
  (select message || ' ' || context::text from public.error_events where correlation_id = 'corr-1234-abcd'));
select rls_test.ok('health: unconfigured integrations are reported honestly as not configured',
  (select bool_and(c ->> 'status' = 'NOT_CONFIGURED') from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' in ('email', 'push', 'realtime', 'e_invoicing')),
  rls_test.get('hc')::text);
select rls_test.ok('health: database, auth and storage checks are based on real queries',
  (select c ->> 'status' from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' = 'database') = 'HEALTHY'
  and (select c ->> 'status' from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' = 'storage') = 'HEALTHY'
  and (select c ->> 'status' from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' = 'auth') = 'HEALTHY');
select rls_test.ok('health: reported errors and imports with rejected rows show as degraded',
  (select c ->> 'status' from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' = 'errors') = 'DEGRADED'
  and (select c ->> 'status' from jsonb_array_elements(rls_test.get('hc') -> 'checks') c where c ->> 'key' = 'imports') = 'DEGRADED');
select rls_test.ok('health: no credentials or connection strings are exposed', rls_test.get('hc')::text !~* '(postgres(ql)?://|password|service_role|secret|apikey)');
select rls_test.claims('viewer');
select rls_test.expect_call_error('health: restricted to system_health.read', $q$ select public.system_health_check() $q$, 'system_health.read');

-- ===========================================================================
-- CONFIGURATION PERMISSIONS
-- ===========================================================================
select rls_test.claims('im');
select rls_test.expect_error('settings: users without settings.manage cannot change ERP settings',
  format($q$ insert into public.company_settings (company_id, setting_key, setting_value) values (%L, 'documents.max_file_mb', '5') $q$, rls_test.id('company_a')));
select rls_test.claims('adm');
insert into public.company_settings (company_id, setting_key, setting_value) values (rls_test.id('company_a'), 'documents.max_file_mb', '1');
select rls_test.ok('settings: the change is audited and applied to upload rules',
  rls_test.audit_count(rls_test.id('company_a'), 'settings.created') >= 1 and (public.document_upload_rules() ->> 'max_bytes')::bigint = 1048576);
select rls_test.expect_call_error('settings: the new limit is enforced on upload',
  format($q$ select public.document_upload_prepare('PRODUCT', %L, 'PHOTO', 'Photo', 'photo.png', 2000000, 'image/png') $q$, rls_test.id('pa')), '1 MB');

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
  raise exception 'ADMIN_VERIFICATION_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
