-- =============================================================================
-- FORCE RESET / DELETE EVERYTHING — direct delete (20261113090000_force_reset_direct.sql)
--
--  * deletes all business data (incl. posted stock and issued invoices) without
--    environment approval, backup record, password or typed confirmations
--  * only an active Super Admin with system.reset_data, own company only
--  * users, roles, company and the audit log are kept; other companies untouched
--  * idempotent per request id; a run is recorded and audited
--
-- Runs in one transaction and ALWAYS ends by raising
--   FORCE_RESET_DIRECT_RESULT passed=N failed=M
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
-- The reset result always carries "error" (null on success); only a raised error or a non-null message fails.
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, r ->> 'error' is null or r ->> 'status' = 'DENIED', r::text); return r; end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.now_sql(p_company text, p_req text) returns text language sql stable as $$
  select format('select public.erp_force_reset_now(%L, %L)', rls_test.id(p_company), rls_test.id(p_req)) $$;
-- Owner-side probes (bypass RLS).
create function rls_test.n(p_table text, p_company uuid) returns bigint language plpgsql stable security definer as $$
declare v bigint; begin execute format('select count(*) from public.%I where company_id = $1', p_table) into v using p_company; return v; end $$;
grant execute on all functions in schema rls_test to anon, authenticated;

insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5ce00-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5ce00-0000-4000-8000-0000000000b1'),
  ('sa', 'e7e5ce00-0000-4000-8000-000000000001'), ('adm', 'e7e5ce00-0000-4000-8000-000000000002'), ('b_sa', 'e7e5ce00-0000-4000-8000-000000000003'),
  ('cx', 'e7e5ce00-0000-4000-8000-0000000000c1'), ('fg', 'e7e5ce00-0000-4000-8000-0000000000d1'), ('svc', 'e7e5ce00-0000-4000-8000-0000000000d2'),
  ('fgb', 'e7e5ce00-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5ce00-0000-4000-8000-0000000000e1'), ('wb', 'e7e5ce00-0000-4000-8000-0000000000e2'),
  ('req1', 'e7e5ce00-0000-4000-8000-0000000000f1'), ('req2', 'e7e5ce00-0000-4000-8000-0000000000f2'), ('req3', 'e7e5ce00-0000-4000-8000-0000000000f3');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Direct Reset A Pvt Ltd', 'DR A', 'DRA', '27AAACR1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Direct Reset B Pvt Ltd', 'DR B', 'DRB', '27AAACR5678B1Z5', 'Nashik');
insert into auth.users (id, email) select id, key || '@dr.example.invalid' from rls_test.ids where key in ('sa', 'adm', 'b_sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('sa'), rls_test.id('adm'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_sa');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sa'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('adm'), rls_test.id('company_a'), rls_test.id('role_admin')),
  (rls_test.id('b_sa'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, gst_registration_type, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'DR-CX', 'Xylo Homes', 'ACTIVE', '27AABCX1234A1Z5', 'REGISTERED', '27', 'Pune');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, selling_price, gst_rate, hsn_code, inventory_tracked) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'DR-FG', 'Basin mixer', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020', true),
  (rls_test.id('svc'), rls_test.id('company_a'), 'DR-SVC', 'Installation', 'FINISHED_GOOD', 'OUTSOURCED', 'NOS', 'ACTIVE', 500, 18, '995461', false),
  (rls_test.id('fgb'), rls_test.id('company_b'), 'DR-FG', 'B mixer', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020', true);
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true), (rls_test.id('wb'), rls_test.id('company_b'), 'W1', 'B factory', true);

-- Business data incl. protected history: posted stock (both companies) and an issued invoice (A).
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('setup A: 25 basin mixers received (posted stock ledger)', 'g_a',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'received_quantity', 25, 'accepted_quantity', 25, 'unit_cost', 10,
      'accepted_location_id', (select id from public.inventory_locations where warehouse_id = rls_test.id('w1') and location_code = 'GENERAL'))), gen_random_uuid()));
select rls_test.expect_call_ok('setup A: service invoice draft', 'inv',
  format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('svc'), 'quantity', 1)), gen_random_uuid()));
select rls_test.expect_call_ok('setup A: invoice issued (protected)', 'inv_i',
  format('select public.sales_invoice_v2_issue(%L, false, %L)', rls_test.gid('inv', 'invoice_id'), gen_random_uuid()));
select rls_test.claims('b_sa');
select rls_test.expect_call_ok('setup B: 7 mixers received', 'g_b',
  format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('wb')),
    jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fgb'), 'received_quantity', 7, 'accepted_quantity', 7, 'unit_cost', 10,
      'accepted_location_id', (select id from public.inventory_locations where warehouse_id = rls_test.id('wb') and location_code = 'GENERAL'))), gen_random_uuid()));
reset role;
select rls_test.ok('setup: company A has stock ledger rows, an issued invoice, products and warehouses; no approval or backup exists',
  rls_test.n('inventory_transactions', rls_test.id('company_a')) > 0 and rls_test.n('sales_invoices', rls_test.id('company_a')) = 1
  and rls_test.n('products', rls_test.id('company_a')) = 2
  and not exists (select 1 from private.erp_force_reset_approvals where company_id = rls_test.id('company_a'))
  and not exists (select 1 from public.erp_reset_backup_attestations where company_id = rls_test.id('company_a')));
select rls_test.set('b_tx', to_jsonb(rls_test.n('inventory_transactions', rls_test.id('company_b'))));
select rls_test.set('audit_a', to_jsonb((select count(*) from public.audit_logs where company_id = rls_test.id('company_a'))));

-- Refusals.
set local role authenticated;
select rls_test.claims('adm');
select rls_test.expect_call_ok('refusal: an Admin (not Super Admin)', 'r_adm', rls_test.now_sql('company_a', 'req1'));
select rls_test.claims('sa');
select rls_test.expect_call_ok('refusal: another company', 'r_other', rls_test.now_sql('company_b', 'req1'));
select set_config('request.jwt.claims', '', true);
select rls_test.set('r_anon', rls_test.call(rls_test.now_sql('company_a', 'req1')));
reset role;
select rls_test.ok('refusals: Admin DENIED, other company DENIED, not signed in refused; nothing deleted',
  rls_test.get('r_adm') ->> 'status' = 'DENIED' and rls_test.get('r_other') ->> 'status' = 'DENIED'
  and rls_test.get('r_anon') ->> 'error' ilike '%Not authenticated%'
  and rls_test.n('products', rls_test.id('company_a')) = 2 and rls_test.n('sales_invoices', rls_test.id('company_a')) = 1);
select rls_test.ok('grants: anon cannot call it', not has_function_privilege('anon', 'public.erp_force_reset_now(uuid, uuid)', 'EXECUTE'));

-- Preview is ready without approval or backup.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('preview: company A', 'prev', format('select public.erp_force_reset_preview(%L)', rls_test.id('company_a')));
reset role;
select rls_test.ok('preview: can execute with no approval and no backup record', (rls_test.get('prev') ->> 'can_execute')::boolean
  and (rls_test.get('prev') ->> 'delete_total')::int > 0, rls_test.get('prev') ->> 'gates');

-- The direct delete.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('delete: Super Admin deletes everything directly', 'run', rls_test.now_sql('company_a', 'req2'));
select rls_test.expect_call_ok('delete: the same request again (retry)', 'run2', rls_test.now_sql('company_a', 'req2'));
reset role;
select rls_test.ok('delete: COMPLETED and verified in the transaction', rls_test.get('run') ->> 'status' = 'COMPLETED'
  and (rls_test.get('run') -> 'verification' ->> 'purge_tables_empty')::boolean and (rls_test.get('run') ->> 'deleted_total')::int > 0,
  rls_test.get('run')::text);
select rls_test.ok('delete: posted stock, issued invoice, products, customers and warehouses of A are gone',
  rls_test.n('inventory_transactions', rls_test.id('company_a')) = 0 and rls_test.n('inventory_balances', rls_test.id('company_a')) = 0
  and rls_test.n('sales_invoices', rls_test.id('company_a')) = 0 and rls_test.n('products', rls_test.id('company_a')) = 0
  and rls_test.n('customers', rls_test.id('company_a')) = 0 and rls_test.n('warehouses', rls_test.id('company_a')) = 0);
select rls_test.ok('kept: company, users, roles and the Super Admin''s access',
  exists (select 1 from public.companies where id = rls_test.id('company_a') and is_active)
  and (select count(*) from public.profiles where company_id = rls_test.id('company_a')) = 2
  and private.erp_reset_actor_ok(rls_test.id('sa'), rls_test.id('company_a')));
select rls_test.ok('kept: company B untouched', rls_test.n('inventory_transactions', rls_test.id('company_b')) = (rls_test.get('b_tx'))::bigint
  and rls_test.n('products', rls_test.id('company_b')) = 1);
select rls_test.ok('history: one FORCE run recorded (no approval / backup ids), audited; audit log not reduced',
  (select count(*) from public.erp_reset_runs where company_id = rls_test.id('company_a') and mode = 'FORCE' and status = 'COMPLETED'
     and approval_id is null and backup_id is null) = 1
  and exists (select 1 from public.audit_logs where company_id = rls_test.id('company_a') and action = 'erp_force_reset.completed' and (metadata ->> 'direct')::boolean)
  and (select count(*) from public.audit_logs where company_id = rls_test.id('company_a')) >= (rls_test.get('audit_a'))::bigint);
select rls_test.ok('idempotent: the retry returns the stored run (replayed) and deletes nothing more',
  (rls_test.get('run2') ->> 'replayed')::boolean and rls_test.get('run2') ->> 'run_id' = rls_test.get('run') ->> 'run_id');

-- After the reset the company can be used again.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('afterwards: a second reset of the empty company also works', 'run3', rls_test.now_sql('company_a', 'req3'));
reset role;
select rls_test.ok('afterwards: COMPLETED with 0 rows', rls_test.get('run3') ->> 'status' = 'COMPLETED' and (rls_test.get('run3') ->> 'deleted_total')::int = 0,
  rls_test.get('run3')::text);

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
  raise exception 'FORCE_RESET_DIRECT_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
