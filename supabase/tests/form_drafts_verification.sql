-- =============================================================================
-- PERSISTENT FORM DRAFTS (ALTON ERP V2)
-- migration 20261117090000_form_drafts.sql
--
-- Numbers = section 11 of the request where a database check applies.
-- Runs in one transaction and ALWAYS ends by raising
--   FORM_DRAFTS_RESULT passed=N failed=M
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
begin execute p_sql into r; return coalesce(r, 'null'::jsonb);
exception when others then return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate); end $$;
create function rls_test.set(p_key text, p_value jsonb) returns jsonb language plpgsql as $$
begin insert into rls_test.vars values (p_key, p_value) on conflict (key) do update set value = excluded.value; return p_value; end $$;
create function rls_test.get(p_key text) returns jsonb language sql stable as $$ select value from rls_test.vars where key = p_key $$;
create function rls_test.expect_call_ok(p_name text, p_key text, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (jsonb_typeof(r) = 'object' and r ? 'sqlstate'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, jsonb_typeof(r) = 'object' and r ? 'sqlstate' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%' or r ->> 'sqlstate' = p_pattern), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;
create function rls_test.role_id(p_code text) returns uuid language sql stable security definer as $$ select id from public.roles where code = p_code $$;
-- erp_form_draft_save(form, record, scope, data, base_version, expected_version)
create function rls_test.save(p_form text, p_data jsonb, p_expected int, p_record uuid default null, p_scope text default '', p_base text default null) returns text language sql stable as $$
  select format('select public.erp_form_draft_save(%L, %L::uuid, %L, %L::jsonb, %L, %s)', p_form, p_record, p_scope, p_data, p_base, p_expected) $$;
create function rls_test.draft_rows() returns bigint language sql stable security definer as $$ select count(*) from public.erp_form_drafts $$;
create function rls_test.po_rows() returns bigint language sql stable security definer as $$ select count(*) from public.purchase_orders $$;
grant execute on all functions in schema rls_test to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures: company A (two purchasers, a viewer), company B (a Super Admin)
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5d200-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5d200-0000-4000-8000-0000000000b1'),
  ('a1', 'e7e5d200-0000-4000-8000-000000000001'), ('a2', 'e7e5d200-0000-4000-8000-000000000002'),
  ('viewer', 'e7e5d200-0000-4000-8000-000000000003'), ('b1', 'e7e5d200-0000-4000-8000-000000000004'),
  ('po_x', 'e7e5d200-0000-4000-8000-0000000000c1');
insert into public.companies (id, legal_name, display_name, company_code) values
  (rls_test.id('company_a'), 'Draft Test A Pvt Ltd', 'Draft A', 'DFA'),
  (rls_test.id('company_b'), 'Draft Test B Pvt Ltd', 'Draft B', 'DFB');
insert into auth.users (id, email) select id, key || '@drafts.example.invalid' from rls_test.ids where key in ('a1', 'a2', 'viewer', 'b1');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('a1'), rls_test.id('a2'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b1');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('a1'), rls_test.id('company_a'), rls_test.role_id('PURCHASE_MANAGER')),
  (rls_test.id('a1'), rls_test.id('company_a'), rls_test.role_id('SALES_MANAGER')),
  (rls_test.id('a2'), rls_test.id('company_a'), rls_test.role_id('PURCHASE_MANAGER')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.role_id('MANAGEMENT_VIEWER')),
  (rls_test.id('b1'), rls_test.id('company_b'), rls_test.role_id('SUPER_ADMIN'));

select rls_test.set('po_draft', jsonb_build_object(
  'h', jsonb_build_object('supplier_id', 'e7e5d200-0000-4000-8000-0000000000d1', 'po_date', '2026-11-03', 'expected_delivery_date', '2026-11-20',
    'purchase_type', 'RAW_MATERIAL', 'payment_terms', 'NET_30', 'reference_number', 'Q-17', 'internal_notes', 'Urgent — मूल्य check'),
  'lines', jsonb_build_array(
    jsonb_build_object('key', 'l1', 'line_type', 'GOODS', 'product_id', 'e7e5d200-0000-4000-8000-0000000000e1', 'quantity', '10', 'unit_price', '125.50', 'discount', '', 'gst_rate', '18'),
    jsonb_build_object('key', 'l2', 'line_type', 'CHARGE', 'description', 'Freight', 'quantity', '1', 'unit_price', '500', 'gst_rate', '18', 'tags', jsonb_build_array(1, jsonb_build_object('x', null)))),
  'step', 2, 'warehouseTouched', true));
select rls_test.set('po_count_before', to_jsonb(rls_test.po_rows()));

-- ---------------------------------------------------------------------------
-- 1/2/8. Save, read back, nested line items
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a1');
select rls_test.expect_call_ok('get: no draft yet returns nothing', 'g0', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.expect_call_ok('1. first save of a new purchase order form', 's1', rls_test.save('purchase.order', rls_test.get('po_draft'), 0));
select rls_test.expect_call_ok('2. reopening the form reads the draft', 'g1', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.expect_call_ok('autosave: next change saved on the version it last saw', 's2',
  rls_test.save('purchase.order', rls_test.get('po_draft') || '{"step": 3}', 1));
select rls_test.set('a1_rows', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts'));
reset role;
select rls_test.ok('get: none before the first save', rls_test.get('g0') = 'null'::jsonb, rls_test.get('g0')::text);
select rls_test.ok('1. saved: version 1, status draft, module and feature from the registry',
  rls_test.get('s1') ->> 'status' = 'SAVED' and (rls_test.get('s1') -> 'draft' ->> 'version')::int = 1
  and (select module || '/' || feature from public.erp_form_drafts where user_id = rls_test.id('a1')) = 'Purchase/Supplier purchase order', rls_test.get('s1')::text);
select rls_test.ok('2/8. restored exactly: header, dates, dropdown values, line items, nested arrays, nulls, unicode, step',
  rls_test.get('g1') -> 'data' = rls_test.get('po_draft') and rls_test.get('g1') ->> 'status' = 'draft', rls_test.get('g1')::text);
select rls_test.ok('autosave: version 2 with the new values', (rls_test.get('s2') -> 'draft' ->> 'version')::int = 2
  and (rls_test.get('s2') -> 'draft' -> 'data' ->> 'step')::int = 3);
select rls_test.ok('RLS: the author reads their own draft', rls_test.get('a1_rows') = '1'::jsonb);

-- ---------------------------------------------------------------------------
-- 11. Two browser sessions: stale save refused, newer draft returned
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a1');
select rls_test.expect_call_ok('11. a second session saves on version 1 after the first saved version 2', 's_stale',
  rls_test.save('purchase.order', rls_test.get('po_draft') || '{"step": 9}', 1));
select rls_test.expect_call_ok('11. read after the conflict', 'g_after', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.expect_call_ok('11. "keep mine": save again on the version the conflict reported', 's_keep',
  rls_test.save('purchase.order', rls_test.get('po_draft') || '{"step": 9}', 2));
reset role;
select rls_test.ok('11. conflict: nothing overwritten, the newer draft (version 2, step 3) is returned',
  rls_test.get('s_stale') ->> 'status' = 'CONFLICT' and (rls_test.get('s_stale') -> 'draft' ->> 'version')::int = 2
  and (rls_test.get('s_stale') -> 'draft' -> 'data' ->> 'step')::int = 3 and (rls_test.get('g_after') -> 'data' ->> 'step')::int = 3, rls_test.get('s_stale')::text);
select rls_test.ok('11. recovery: an explicit save on the reported version wins (version 3)',
  rls_test.get('s_keep') ->> 'status' = 'SAVED' and (rls_test.get('s_keep') -> 'draft' ->> 'version')::int = 3);

-- ---------------------------------------------------------------------------
-- 6/7. Other users and other companies; permissions
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a2');
select rls_test.expect_call_ok('6. another user of the same company: no draft', 'g_a2', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.set('a2_rows', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts'));
select rls_test.expect_call_ok('6. the other user keeps an independent draft of the same form', 's_a2', rls_test.save('purchase.order', '{"h": {"reference_number": "A2"}}', 0));
select rls_test.claims('b1');
select rls_test.expect_call_ok('7. company B: no draft', 'g_b1', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.set('b1_rows', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts'));
select rls_test.expect_call_ok('7. company B keeps its own draft', 's_b1', rls_test.save('purchase.order', '{"h": {"reference_number": "B"}}', 0));
select rls_test.set('b1_rows_after', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts'));
select rls_test.claims('viewer');
select rls_test.expect_call_error('permissions: a read-only user cannot keep purchase-order drafts', rls_test.save('purchase.order', '{"h": {}}', 0), 'not allowed');
select rls_test.expect_call_error('permissions: nor read them', 'select public.erp_form_draft_get(''purchase.order'', null, '''')', 'not allowed');
select rls_test.claims('a1');
select rls_test.expect_call_error('registry: unknown form keys are refused', rls_test.save('hacker.form', '{"a": 1}', 0), 'Unknown form');
select rls_test.expect_call_error('security: passwords are never stored', rls_test.save('sales.order', '{"h": {"notes": "x"}, "password": "secret1"}', 0), 'passwords');
select rls_test.expect_call_error('security: nested tokens are refused too', rls_test.save('sales.order', '{"lines": [{"access_token": "abc"}]}', 0), 'secrets');
select rls_test.expect_call_error('size: drafts are limited to 256 KB', rls_test.save('sales.order', jsonb_build_object('big', repeat('x', 270000)), 0), 'too large');
select rls_test.expect_call_error('shape: a draft is a JSON object', rls_test.save('sales.order', '"text"', 0), 'JSON object');
reset role;
select rls_test.ok('6. users never see each other''s drafts', rls_test.get('g_a2') = 'null'::jsonb and rls_test.get('a2_rows') = '0'::jsonb, rls_test.get('a2_rows')::text);
select rls_test.ok('7. companies never see each other''s drafts; each sees only its own row',
  rls_test.get('g_b1') = 'null'::jsonb and rls_test.get('b1_rows') = '0'::jsonb and rls_test.get('b1_rows_after') = '1'::jsonb
  and (select company_id from public.erp_form_drafts where user_id = rls_test.id('b1')) = rls_test.id('company_b'));

-- ---------------------------------------------------------------------------
-- Edit forms: record-scoped drafts, base version; scopes (copy of a PO)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a1');
select rls_test.expect_call_ok('edit form: draft for record X with the record''s version', 's_rec',
  rls_test.save('purchase.order', '{"h": {"reference_number": "EDIT"}}', 0, rls_test.id('po_x'), '', '2026-11-03T10:00:00Z'));
select rls_test.expect_call_ok('scope: a copy of PO X keeps its own draft', 's_copy',
  rls_test.save('purchase.order', '{"h": {"reference_number": "COPY"}}', 0, null, 'copy:' || rls_test.id('po_x')));
select rls_test.expect_call_ok('edit form draft read back', 'g_rec', format('select public.erp_form_draft_get(''purchase.order'', %L, '''')', rls_test.id('po_x')));
select rls_test.expect_call_ok('new-order draft unaffected', 'g_new', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.expect_call_ok('my open drafts', 'mine', 'select public.erp_form_drafts_mine()');
reset role;
select rls_test.ok('edit form: separate draft per record, stores the record version it started from (an older draft is never applied blindly)',
  rls_test.get('g_rec') -> 'data' ->> 'h' = '{"reference_number": "EDIT"}' and rls_test.get('g_rec') ->> 'base_version' = '2026-11-03T10:00:00Z'
  and (rls_test.get('g_new') -> 'data' ->> 'step')::int = 9, rls_test.get('g_rec')::text);
select rls_test.ok('my open drafts: the user''s three purchase-order drafts, nothing of other users',
  jsonb_array_length(rls_test.get('mine')) = 3, rls_test.get('mine')::text);

-- ---------------------------------------------------------------------------
-- 10. Submission: closed only on success; stale tabs told; reopened later
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a1');
select rls_test.expect_call_ok('10. after a successful submit the form closes its draft', 'c1', 'select public.erp_form_draft_close(''purchase.order'', null, '''', ''submitted'')');
select rls_test.expect_call_ok('10. reopening the form: no data', 'g_closed', 'select public.erp_form_draft_get(''purchase.order'', null, '''')');
select rls_test.expect_call_ok('11. a stale tab autosaving the submitted form', 's_after_submit', rls_test.save('purchase.order', '{"h": {}}', 3));
select rls_test.expect_call_ok('10. a new order later starts a new draft on the same row', 's_new_again',
  rls_test.save('purchase.order', '{"h": {"reference_number": "NEXT"}}', (rls_test.get('g_closed') ->> 'version')::int));
select rls_test.expect_call_ok('discard: the user discards the copy draft', 'd1', format('select public.erp_form_draft_close(''purchase.order'', null, %L, ''discarded'')', 'copy:' || rls_test.id('po_x')));
select rls_test.expect_call_error('close: only submitted or discarded', 'select public.erp_form_draft_close(''purchase.order'', null, '''', ''deleted'')', 'submitted or discarded');
reset role;
select rls_test.ok('10. submitted: status submitted, stored values cleared, get returns no data',
  rls_test.get('c1') ->> 'status' = 'submitted' and rls_test.get('g_closed') ->> 'status' = 'submitted' and rls_test.get('g_closed') -> 'data' = 'null'::jsonb
  and (select draft_data from public.erp_form_drafts where user_id = rls_test.id('a1') and record_id is null and scope = '') is not null, rls_test.get('g_closed')::text);
select rls_test.ok('11. a stale tab is told the form was submitted elsewhere (conflict, status submitted)',
  rls_test.get('s_after_submit') ->> 'status' = 'CONFLICT' and rls_test.get('s_after_submit') -> 'draft' ->> 'status' = 'submitted', rls_test.get('s_after_submit')::text);
select rls_test.ok('10. next new order drafts again (status draft)', rls_test.get('s_new_again') ->> 'status' = 'SAVED'
  and rls_test.get('s_new_again') -> 'draft' ->> 'status' = 'draft', rls_test.get('s_new_again')::text);
select rls_test.ok('discard: copy draft closed and emptied', rls_test.get('d1') ->> 'status' = 'discarded'
  and (select draft_data = '{}'::jsonb from public.erp_form_drafts where scope like 'copy:%'));
select rls_test.ok('drafts never create or change business records (no purchase order created)', to_jsonb(rls_test.po_rows()) = rls_test.get('po_count_before'));

-- ---------------------------------------------------------------------------
-- Security: direct writes, anon, deactivated users, lost permission
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('a1');
select rls_test.expect_call_error('grants: drafts cannot be inserted directly',
  format('insert into public.erp_form_drafts (company_id, user_id, module, feature, form_key) values (%L, %L, ''x'', ''x'', ''sales.order'') returning to_jsonb(id)',
    rls_test.id('company_a'), rls_test.id('a1')), 'permission denied');
select rls_test.expect_call_error('grants: drafts cannot be updated directly (e.g. moved to another user)',
  format('update public.erp_form_drafts set user_id = %L returning to_jsonb(id)', rls_test.id('a2')), 'permission denied');
select rls_test.expect_call_error('grants: drafts cannot be deleted directly', 'delete from public.erp_form_drafts returning to_jsonb(id)', 'permission denied');
reset role;
update public.profiles set is_active = false where id = rls_test.id('a2');
delete from public.user_roles where user_id = rls_test.id('a1') and role_id = rls_test.role_id('PURCHASE_MANAGER');
set local role authenticated;
select rls_test.claims('a2');
select rls_test.expect_call_error('5. a deactivated user cannot read their drafts', 'select public.erp_form_draft_get(''purchase.order'', null, '''')', 'not active');
select rls_test.set('a2_rows_inactive', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts'));
select rls_test.claims('a1');
select rls_test.set('a1_rows_noperm', rls_test.call('select to_jsonb(count(*)) from public.erp_form_drafts where form_key = ''purchase.order'''));
select rls_test.expect_call_error('permissions: after losing purchase_order.create the purchase-order drafts are closed to the user',
  'select public.erp_form_draft_get(''purchase.order'', null, '''')', 'not allowed');
reset role;
select rls_test.ok('RLS: deactivated users and users without the form''s permission read no drafts',
  rls_test.get('a2_rows_inactive') = '0'::jsonb and rls_test.get('a1_rows_noperm') = '0'::jsonb);
select rls_test.ok('grants: anon has no access; clients have SELECT only',
  not has_table_privilege('anon', 'public.erp_form_drafts', 'SELECT')
  and not has_function_privilege('anon', 'public.erp_form_draft_save(text, uuid, text, jsonb, text, integer)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'public.erp_form_drafts', 'INSERT,UPDATE,DELETE')
  and has_table_privilege('authenticated', 'public.erp_form_drafts', 'SELECT'));
select rls_test.ok('RLS enabled; one draft per user, company, form, record and scope',
  (select relrowsecurity from pg_class where oid = 'public.erp_form_drafts'::regclass)
  and exists (select 1 from pg_indexes where indexname = 'erp_form_drafts_key'));
select rls_test.ok('ERP reset deletes drafts with the company''s business data',
  exists (select 1 from private.erp_reset_tables() where table_name = 'erp_form_drafts'));
select rls_test.ok('registry: every registered form names permissions that exist',
  not exists (select 1 from private.erp_form_draft_registry() r, unnest(r.permissions) p where not exists (select 1 from public.permissions x where x.code = p)));

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
  raise exception 'FORM_DRAFTS_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
