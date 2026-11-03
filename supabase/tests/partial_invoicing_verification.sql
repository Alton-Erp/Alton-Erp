-- =============================================================================
-- SALES ORDER PARTIAL INVOICING, PENDING-INVOICE TRACKING AND RELEASE (ALTON ERP V2)
-- migration 20261115090000_partial_invoicing.sql
--
-- Spec scenarios (numbers = section 11 of the request):
--   1 order for 10 PCS          5/7 invoice 8 posts (dispatched on posting)   8 2 PCS pending
--   9/10 no stock-in, stock deducted once   11 Super Admin notified (once)    12/13 second invoice 1 -> 1 pending
--   14/15 release 1: pending 0, stock unchanged, reservation freed, audited   16 cancellation and re-invoicing
--   17 over-invoicing / stale duplicate refused   18 several invoices per order   + shortage, isolation, permissions
-- Runs in one transaction and ALWAYS ends by raising
--   PARTIAL_INVOICING_RESULT passed=N failed=M
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
begin perform rls_test.set(p_key, r); perform rls_test.ok(p_name, not (r ? 'error' and r ? 'sqlstate'), r::text); return r; end $$;
create function rls_test.expect_call_error(p_name text, p_sql text, p_pattern text default null) returns void language plpgsql as $$
declare r jsonb := rls_test.call(p_sql);
begin perform rls_test.ok(p_name, r ? 'sqlstate' and (p_pattern is null or r ->> 'error' ilike '%' || p_pattern || '%'), r::text); end $$;
create function rls_test.claims(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', rls_test.id(p_key), 'role', 'authenticated')::text, true) $$;

create function rls_test.so(p_product uuid, p_qty numeric) returns text language sql stable as $$
  select format('select public.sales_order_v2_save(null, %L::jsonb, %L::jsonb, %L)', jsonb_build_object('customer_id', rls_test.id('cx')),
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', p_qty)), gen_random_uuid()) $$;
create function rls_test.so_inv(p_so uuid, p_qty numeric) returns text language sql stable security definer as $$
  select format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)', jsonb_build_object('sales_order_id', p_so),
    jsonb_build_array(jsonb_build_object('product_id', l.product_id, 'quantity', p_qty, 'sales_order_line_id', l.id)), gen_random_uuid())
  from public.sales_order_lines l where l.sales_order_id = p_so order by l.line_no limit 1 $$;
create function rls_test.issue(p_id uuid, p_key uuid default null) returns text language sql stable as $$
  select format('select public.sales_invoice_v2_issue(%L, false, %L)', p_id, coalesce(p_key, gen_random_uuid())) $$;
create function rls_test.sol(p_so uuid) returns uuid language sql stable security definer as $$
  select id from public.sales_order_lines where sales_order_id = p_so order by line_no limit 1 $$;
create function rls_test.track(p_so uuid) returns text language sql stable as $$
  select format('select public.sales_invoice_tracking(%L::jsonb)', jsonb_build_object('sales_order_id', p_so, 'pending_only', false)) $$;
create function rls_test.tl(p_track jsonb) returns jsonb language sql immutable as $$ select p_track -> 'lines' -> 0 $$;
-- Owner-side probes.
create function rls_test.on_hand(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(on_hand), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.reserved(p_product uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(reserved), 0) from public.inventory_balances where product_id = p_product $$;
create function rls_test.tx(p_product uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where product_id = p_product $$;
create function rls_test.stock_in(p_product uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.inventory_transactions where product_id = p_product and direction > 0 $$;
create function rls_test.inv(p_id uuid) returns public.sales_invoices language sql stable security definer as $$ select * from public.sales_invoices where id = p_id $$;
create function rls_test.notes(p_type text, p_user uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.notifications where notification_type = p_type and recipient_user_id = p_user $$;
grant execute on all functions in schema rls_test to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into rls_test.ids (key, id) values
  ('company_a', 'e7e5d000-0000-4000-8000-0000000000a1'), ('company_b', 'e7e5d000-0000-4000-8000-0000000000b1'),
  ('sa', 'e7e5d000-0000-4000-8000-000000000001'), ('sa2', 'e7e5d000-0000-4000-8000-000000000002'), ('viewer', 'e7e5d000-0000-4000-8000-000000000003'),
  ('b_sa', 'e7e5d000-0000-4000-8000-000000000004'),
  ('cx', 'e7e5d000-0000-4000-8000-0000000000c1'),
  ('fg', 'e7e5d000-0000-4000-8000-0000000000d1'), ('fg2', 'e7e5d000-0000-4000-8000-0000000000d2'), ('few', 'e7e5d000-0000-4000-8000-0000000000d3'),
  ('w1', 'e7e5d000-0000-4000-8000-0000000000e1'), ('k_issue', 'e7e5d000-0000-4000-8000-0000000000f1'), ('k_rel', 'e7e5d000-0000-4000-8000-0000000000f2');
insert into rls_test.ids (key, id) select 'role_' || lower(code), id from public.roles;

insert into public.companies (id, legal_name, display_name, company_code, gstin, legal_address) values
  (rls_test.id('company_a'), 'Partial Invoicing A Pvt Ltd', 'PI A', 'PIA', '27AAACP1234A1Z5', 'Pune'),
  (rls_test.id('company_b'), 'Partial Invoicing B Pvt Ltd', 'PI B', 'PIB', '27AAACP5678B1Z5', 'Nashik');
insert into auth.users (id, email) select id, key || '@pi.example.invalid' from rls_test.ids where key in ('sa', 'sa2', 'viewer', 'b_sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = 'Asha Operator' where id = rls_test.id('sa');
update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('sa2'), rls_test.id('viewer'));
update public.profiles set company_id = rls_test.id('company_b'), is_active = true where id = rls_test.id('b_sa');
insert into public.user_roles (user_id, company_id, role_id) values
  (rls_test.id('sa'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('sa2'), rls_test.id('company_a'), rls_test.id('role_super_admin')),
  (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer')),
  (rls_test.id('b_sa'), rls_test.id('company_b'), rls_test.id('role_super_admin'));
insert into public.customers (id, company_id, customer_code, customer_name, status, gstin, gst_registration_type, billing_state_code, billing_address) values
  (rls_test.id('cx'), rls_test.id('company_a'), 'PI-AMZ', 'Amazon Seller Services', 'ACTIVE', '27AABCA1234A1Z5', 'REGISTERED', '27', 'Mumbai');
insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, status, selling_price, gst_rate, hsn_code) values
  (rls_test.id('fg'), rls_test.id('company_a'), 'FG-SHR20910', 'Shower set', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 1000, 18, '84818020'),
  (rls_test.id('fg2'), rls_test.id('company_a'), 'FG-BASIN', 'Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 500, 18, '69101000'),
  (rls_test.id('few'), rls_test.id('company_a'), 'FG-RARE', 'Rare tap', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 800, 18, '84818020');
insert into public.warehouses (id, company_id, warehouse_code, warehouse_name, is_default) values
  (rls_test.id('w1'), rls_test.id('company_a'), 'W1', 'Factory', true);
insert into rls_test.ids (key, id) select 'g1', id from public.inventory_locations where warehouse_id = rls_test.id('w1') and location_code = 'GENERAL';

set local role authenticated;
select rls_test.claims('sa');
select rls_test.call(format('select public.goods_receipt_direct_post(%L::jsonb, %L::jsonb, %L)', jsonb_build_object('warehouse_id', rls_test.id('w1')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'received_quantity', 100, 'accepted_quantity', 100, 'unit_cost', 10, 'accepted_location_id', rls_test.id('g1')),
    jsonb_build_object('product_id', rls_test.id('fg2'), 'received_quantity', 20, 'accepted_quantity', 20, 'unit_cost', 10, 'accepted_location_id', rls_test.id('g1')),
    jsonb_build_object('product_id', rls_test.id('few'), 'received_quantity', 2, 'accepted_quantity', 2, 'unit_cost', 10, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid()));
-- 1. Sales order SO for 10 PCS (reserved from stock).
select rls_test.expect_call_ok('1. sales order for 10 PCS', 'so', rls_test.so(rls_test.id('fg'), 10));
reset role;
select rls_test.set('tx0', to_jsonb(rls_test.tx(rls_test.id('fg'))));
select rls_test.set('in0', to_jsonb(rls_test.stock_in(rls_test.id('fg'))));
select rls_test.ok('1. 10 PCS reserved, 100 on hand', rls_test.reserved(rls_test.id('fg')) = 10 and rls_test.on_hand(rls_test.id('fg')) = 100);

-- ---------------------------------------------------------------------------
-- 5-11. First invoice: 8 of 10
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('5. invoice draft for 8 PCS against the 10 PCS order', 'i1', rls_test.so_inv(rls_test.gid('so', 'sales_order_id'), 8));
select rls_test.expect_call_ok('6. partial invoice preview (data for the warning)', 'pv1', format('select public.invoice_partial_preview(%L)', rls_test.gid('i1', 'invoice_id')));
select rls_test.expect_call_ok('dispatch status before posting', 'ds1', format('select public.invoice_dispatch_status(%L)', rls_test.gid('i1', 'invoice_id')));
select rls_test.expect_call_ok('7. post the 8 PCS invoice', 'i1p', rls_test.issue(rls_test.gid('i1', 'invoice_id'), rls_test.id('k_issue')));
select rls_test.expect_call_ok('8. tracking after the first invoice', 't1', rls_test.track(rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_call_ok('order summary', 'sum1', format('select public.sales_order_v2_summary(%L)', rls_test.gid('so', 'sales_order_id')));
reset role;
select rls_test.ok('6. preview: ordered 10, previously invoiced 0, this invoice 8, remaining 2, partial',
  (rls_test.get('pv1') ->> 'partial')::boolean and (rls_test.get('pv1') -> 'lines' -> 0 ->> 'ordered')::numeric = 10
  and (rls_test.get('pv1') -> 'lines' -> 0 ->> 'previously_invoiced')::numeric = 0 and (rls_test.get('pv1') -> 'lines' -> 0 ->> 'this_invoice')::numeric = 8
  and (rls_test.get('pv1') -> 'lines' -> 0 ->> 'remaining')::numeric = 2, rls_test.get('pv1')::text);
select rls_test.ok('posting = dispatch: the undispatched order line shows DISPATCH_ON_POSTING and the invoice is ready to post',
  rls_test.get('ds1') -> 'lines' -> 0 ->> 'status' = 'DISPATCH_ON_POSTING' and (rls_test.get('ds1') ->> 'ready')::boolean, rls_test.get('ds1')::text);
select rls_test.ok('7. invoice for 8 PCS posted (ISSUED), linked to the order, original order quantity 10 kept',
  (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).status = 'ISSUED' and (rls_test.inv(rls_test.gid('i1', 'invoice_id'))).sales_order_id = rls_test.gid('so', 'sales_order_id')
  and (select quantity_ordered = 10 and quantity_cancelled = 0 from public.sales_order_lines where id = rls_test.sol(rls_test.gid('so', 'sales_order_id'))), rls_test.get('i1p')::text);
select rls_test.ok('7. the 8 PCS were dispatched on posting (one dispatch of 8)',
  (rls_test.get('i1p') -> 'dispatched_on_posting' -> 0 ->> 'dispatched_quantity')::numeric = 8
  and (select quantity_dispatched = 8 from public.sales_order_lines where id = rls_test.sol(rls_test.gid('so', 'sales_order_id'))), rls_test.get('i1p')::text);
select rls_test.ok('8. tracking: ordered 10, invoiced 8, pending 2, Partially Invoiced, invoice number linked',
  (rls_test.tl(rls_test.get('t1')) ->> 'invoiced')::numeric = 8 and (rls_test.tl(rls_test.get('t1')) ->> 'pending')::numeric = 2
  and (rls_test.tl(rls_test.get('t1')) ->> 'ordered')::numeric = 10 and rls_test.tl(rls_test.get('t1')) ->> 'status' = 'PARTIALLY_INVOICED'
  and rls_test.tl(rls_test.get('t1')) -> 'invoice_numbers' ->> 0 = rls_test.get('i1p') ->> 'invoice_number'
  and (rls_test.tl(rls_test.get('t1')) ->> 'latest_invoice_id')::uuid = rls_test.gid('i1', 'invoice_id'), rls_test.get('t1')::text);
select rls_test.ok('8. the order is not closed (status partially dispatched, not fulfilled)',
  rls_test.get('sum1') ->> 'status' = 'PARTIALLY_DISPATCHED'
  and (select order_status not in ('FULFILLED', 'CLOSED', 'CANCELLED') from public.sales_orders where id = rls_test.gid('so', 'sales_order_id')), rls_test.get('sum1') ->> 'status');
select rls_test.ok('9. stock: 100 - 8 = 92 (deducted once by the dispatch); the 2 pending PCS are not added to inventory',
  rls_test.on_hand(rls_test.id('fg')) = 92 and rls_test.reserved(rls_test.id('fg')) = 2);
select rls_test.ok('10. no stock-in transaction; exactly one new stock movement (the dispatch ISSUE)',
  rls_test.stock_in(rls_test.id('fg')) = (rls_test.get('in0'))::bigint and rls_test.tx(rls_test.id('fg')) = (rls_test.get('tx0'))::bigint + 1);
select rls_test.ok('11. every Super Admin receives one "Partial Invoice Created" notification; a viewer does not',
  rls_test.notes('PARTIAL_INVOICE', rls_test.id('sa')) = 1 and rls_test.notes('PARTIAL_INVOICE', rls_test.id('sa2')) = 1
  and rls_test.notes('PARTIAL_INVOICE', rls_test.id('viewer')) = 0);
select rls_test.ok('11. notification content: order, invoice, customer, SKU, ordered / invoiced / remaining, user, link, unread',
  exists (select 1 from public.notifications n where n.recipient_user_id = rls_test.id('sa2') and n.notification_type = 'PARTIAL_INVOICE'
    and n.title = 'Partial Invoice Created' and n.read_at is null and n.link = '/billing/invoices/' || rls_test.gid('i1', 'invoice_id')
    and n.message like '%Sales Order: SO-%' and n.message like '%Invoice: ' || (rls_test.get('i1p') ->> 'invoice_number') || '%'
    and n.message like '%Customer: Amazon Seller Services%' and n.message like '%FG-SHR20910 Shower set: ordered 10, previously invoiced 0, this invoice 8, remaining 2 PCS%'
    and n.message like '%Posted by Asha Operator%' and n.message like '%remaining quantity is pending%'),
  (select message from public.notifications where recipient_user_id = rls_test.id('sa2') and notification_type = 'PARTIAL_INVOICE'));
select rls_test.ok('11. partial invoice recorded in the billing history and the audit log',
  exists (select 1 from public.billing_events where invoice_id = rls_test.gid('i1', 'invoice_id') and event_type = 'PARTIAL_INVOICE')
  and exists (select 1 from public.audit_logs where action = 'invoice.partial_posted' and resource_id = rls_test.gid('i1', 'invoice_id')::text));

-- 11/12. Retrying the same posting request: same result, nothing duplicated.
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('11. the same posting request again (retry)', 'i1p2', rls_test.issue(rls_test.gid('i1', 'invoice_id'), rls_test.id('k_issue')));
reset role;
select rls_test.ok('11. retry: first result returned, no second notification, dispatch or stock movement',
  (rls_test.get('i1p2') ->> 'duplicate')::boolean and rls_test.notes('PARTIAL_INVOICE', rls_test.id('sa')) = 1
  and rls_test.on_hand(rls_test.id('fg')) = 92 and rls_test.tx(rls_test.id('fg')) = (rls_test.get('tx0'))::bigint + 1, rls_test.get('i1p2')::text);

-- ---------------------------------------------------------------------------
-- 17. Over-invoicing refused (save and stale duplicate at posting)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_error('17. an invoice for 3 PCS when only 2 are pending is refused', rls_test.so_inv(rls_test.gid('so', 'sales_order_id'), 3), 'only 2');
select rls_test.expect_call_ok('12. second invoice draft for 1 PCS', 'i2', rls_test.so_inv(rls_test.gid('so', 'sales_order_id'), 1));
reset role;
-- A stale copy of the draft (as if two users validated before either posted).
create function rls_test.clone_as_draft(p_id uuid) returns uuid language plpgsql security definer as $$
declare v_new uuid := gen_random_uuid();
begin
  insert into public.sales_invoices select (jsonb_populate_record(null::public.sales_invoices, to_jsonb(i)
    || jsonb_build_object('id', v_new, 'idempotency_key', null))).* from public.sales_invoices i where i.id = p_id;
  insert into public.sales_invoice_lines select (jsonb_populate_record(null::public.sales_invoice_lines, to_jsonb(l)
    || jsonb_build_object('id', gen_random_uuid(), 'invoice_id', v_new, 'quantity', 2))).* from public.sales_invoice_lines l where l.invoice_id = p_id;
  return v_new;
end $$;
select rls_test.set('stale', to_jsonb(rls_test.clone_as_draft(rls_test.gid('i2', 'invoice_id'))));
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('8/12. tracking with two drafts (drafts are not posted invoices)', 't_draft', rls_test.track(rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_call_error('17. the stale 2 PCS duplicate cannot be posted (with the 1 PCS draft, 3 would exceed the 2 pending; locked re-check)',
  rls_test.issue((rls_test.get('stale') #>> '{}')::uuid), 'cannot be issued');
select rls_test.call(format('select public.sales_invoice_action(%L, ''DISCARD'')', (rls_test.get('stale') #>> '{}')::uuid));
select rls_test.expect_call_ok('12. post the 1 PCS invoice', 'i2p', rls_test.issue(rls_test.gid('i2', 'invoice_id')));
select rls_test.expect_call_ok('13. tracking after the second invoice', 't2', rls_test.track(rls_test.gid('so', 'sales_order_id')));
reset role;
select rls_test.ok('8. drafts are not counted as invoiced (still 8 invoiced, 2 pending) but reduce what can be released',
  (rls_test.tl(rls_test.get('t_draft')) ->> 'invoiced')::numeric = 8 and (rls_test.tl(rls_test.get('t_draft')) ->> 'pending')::numeric = 2
  and (rls_test.tl(rls_test.get('t_draft')) ->> 'draft_invoiced')::numeric = 3 and (rls_test.tl(rls_test.get('t_draft')) ->> 'releasable')::numeric = 0,
  rls_test.tl(rls_test.get('t_draft'))::text);
select rls_test.ok('13/18. two invoices linked to the order: 9 invoiced, 1 pending; stock 91; the stale duplicate was never posted',
  (rls_test.tl(rls_test.get('t2')) ->> 'invoiced')::numeric = 9 and (rls_test.tl(rls_test.get('t2')) ->> 'pending')::numeric = 1
  and jsonb_array_length(rls_test.tl(rls_test.get('t2')) -> 'invoice_numbers') = 2 and rls_test.on_hand(rls_test.id('fg')) = 91
  and (rls_test.inv((rls_test.get('stale') #>> '{}')::uuid)).status = 'DISCARDED', rls_test.tl(rls_test.get('t2'))::text);
select rls_test.ok('13. second partial notice says previously invoiced 8, this invoice 1, remaining 1',
  exists (select 1 from public.notifications where recipient_user_id = rls_test.id('sa') and notification_type = 'PARTIAL_INVOICE'
          and message like '%previously invoiced 8, this invoice 1, remaining 1 PCS%'));
select rls_test.ok('17. posting locks the order lines (concurrent postings serialise)',
  pg_get_functiondef('private.invoice_v2_issue_core(uuid, uuid, text)'::regprocedure) ilike '%sales_order_lines%for update%');

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 14/15. Release the final 1 PCS
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('viewer');
select rls_test.expect_call_error('14. a user without cancel permission cannot release', format('select public.sales_order_line_release_pending(%L, 1, %L, gen_random_uuid())',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'Customer no longer needs it'), 'not allowed');
select rls_test.claims('b_sa');
select rls_test.expect_call_error('isolation: company B cannot release company A''s line', format('select public.sales_order_line_release_pending(%L, 1, %L, gen_random_uuid())',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'Customer no longer needs it'), 'not found');
select rls_test.expect_call_ok('isolation: company B tracking', 'b_track', 'select public.sales_invoice_tracking(''{"pending_only": false}''::jsonb)');
select rls_test.claims('sa');
select rls_test.expect_call_error('14. releasing 2 PCS is refused (only 1 pending)', format('select public.sales_order_line_release_pending(%L, 2, %L, gen_random_uuid())',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'Customer no longer needs it'), 'only 1');
select rls_test.expect_call_error('14. a reason is required', format('select public.sales_order_line_release_pending(%L, 1, %L, gen_random_uuid())',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'no'), 'reason');
reset role;
select rls_test.set('tx_rel', to_jsonb(rls_test.tx(rls_test.id('fg'))));
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('14. release the final 1 PCS', 'rel', format('select public.sales_order_line_release_pending(%L, 1, %L, %L)',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'Customer no longer requires the last unit', rls_test.id('k_rel')));
select rls_test.expect_call_ok('14. the same release request again', 'rel2', format('select public.sales_order_line_release_pending(%L, 1, %L, %L)',
  rls_test.sol(rls_test.gid('so', 'sales_order_id')), 'Customer no longer requires the last unit', rls_test.id('k_rel')));
select rls_test.expect_call_ok('15. tracking after the release', 't3', rls_test.track(rls_test.gid('so', 'sales_order_id')));
select rls_test.expect_call_ok('reports: pending-only register (empty for this order)', 't3p', format('select public.sales_invoice_tracking(%L::jsonb)', jsonb_build_object('sales_order_id', rls_test.gid('so', 'sales_order_id'))));
reset role;
select rls_test.ok('15. pending 0, released 1, status Closed; original order quantity 10 kept',
  (rls_test.tl(rls_test.get('t3')) ->> 'pending')::numeric = 0 and (rls_test.tl(rls_test.get('t3')) ->> 'released')::numeric = 1
  and rls_test.tl(rls_test.get('t3')) ->> 'status' = 'CLOSED' and (rls_test.tl(rls_test.get('t3')) ->> 'ordered')::numeric = 10
  and jsonb_array_length(rls_test.get('t3p') -> 'lines') = 0, rls_test.tl(rls_test.get('t3'))::text);
select rls_test.ok('15. physical stock unchanged by the release (91 on hand, no stock movement); the 1 PCS reservation is freed',
  rls_test.on_hand(rls_test.id('fg')) = 91 and rls_test.tx(rls_test.id('fg')) = (rls_test.get('tx_rel'))::bigint and rls_test.reserved(rls_test.id('fg')) = 0
  and rls_test.stock_in(rls_test.id('fg')) = (rls_test.get('in0'))::bigint);
select rls_test.ok('14. release recorded: order event (user, quantity, reason, invoices), audit log, Super Admin notice; retry not duplicated',
  (select count(*) from public.sales_order_events where event_type = 'PENDING_INVOICE_RELEASED' and line_id = rls_test.sol(rls_test.gid('so', 'sales_order_id'))
     and actor_user_id = rls_test.id('sa') and (details ->> 'quantity')::numeric = 1 and note = 'Customer no longer requires the last unit'
     and jsonb_array_length(details -> 'invoice_numbers') = 2) = 1
  and exists (select 1 from public.audit_logs where action = 'sales_order.pending_released')
  and rls_test.notes('PENDING_INVOICE_RELEASED', rls_test.id('sa2')) = 1 and (rls_test.get('rel2') ->> 'duplicate')::boolean);
select rls_test.ok('reports: the release appears in the released-quantity report and the partial invoices in the partial-invoice report',
  jsonb_array_length(rls_test.get('t3') -> 'releases') = 1 and (rls_test.get('t3') -> 'releases' -> 0 ->> 'quantity')::numeric = 1
  and jsonb_array_length(rls_test.get('t3') -> 'partial_invoices') = 2 and rls_test.get('t3') -> 'totals' -> 0 ->> 'unit' = 'PCS'
  and (rls_test.get('t3') -> 'totals' -> 0 ->> 'ordered')::numeric = 10 and (rls_test.get('t3') -> 'totals' -> 0 ->> 'invoiced')::numeric = 9
  and (rls_test.get('t3') -> 'totals' -> 0 ->> 'released')::numeric = 1 and (rls_test.get('t3') -> 'totals' -> 0 ->> 'pending')::numeric = 0, rls_test.get('t3')::text);
select rls_test.ok('isolation: company B sees none of company A''s orders, releases or partial invoices',
  jsonb_array_length(rls_test.get('b_track') -> 'lines') = 0 and jsonb_array_length(rls_test.get('b_track') -> 'releases') = 0
  and jsonb_array_length(rls_test.get('b_track') -> 'partial_invoices') = 0);

-- ---------------------------------------------------------------------------
-- 16. Full invoice, cancellation and re-invoicing (no second deduction)
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('setup: order for 5 basins', 'sob', rls_test.so(rls_test.id('fg2'), 5));
select rls_test.expect_call_ok('16. invoice for all 5', 'ib', rls_test.so_inv(rls_test.gid('sob', 'sales_order_id'), 5));
select rls_test.expect_call_ok('16. full invoice posts', 'ibp', rls_test.issue(rls_test.gid('ib', 'invoice_id')));
select rls_test.expect_call_ok('16. cancel the invoice', 'ibc', format('select public.sales_invoice_action(%L, ''CANCEL'', ''Wrong billing address'')', rls_test.gid('ib', 'invoice_id')));
select rls_test.expect_call_ok('16. tracking after cancellation', 'tb1', rls_test.track(rls_test.gid('sob', 'sales_order_id')));
reset role;
select rls_test.set('tx_b', to_jsonb(rls_test.tx(rls_test.id('fg2'))));
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('16. re-invoice the 5 basins', 'ib2', rls_test.so_inv(rls_test.gid('sob', 'sales_order_id'), 5));
select rls_test.expect_call_ok('16. post the replacement invoice', 'ib2p', rls_test.issue(rls_test.gid('ib2', 'invoice_id')));
select rls_test.expect_call_ok('16. tracking after re-invoicing', 'tb2', rls_test.track(rls_test.gid('sob', 'sales_order_id')));
reset role;
select rls_test.ok('16. a full invoice is not a partial invoice (no notice)', not (rls_test.get('ibp') -> 'partial_invoice' ->> 'partial')::boolean
  and not exists (select 1 from public.billing_events where invoice_id = rls_test.gid('ib', 'invoice_id') and event_type = 'PARTIAL_INVOICE'));
select rls_test.ok('16. cancelled invoice: 0 invoiced, 5 pending again; the dispatched goods stay dispatched and cannot be released',
  (rls_test.tl(rls_test.get('tb1')) ->> 'invoiced')::numeric = 0 and (rls_test.tl(rls_test.get('tb1')) ->> 'pending')::numeric = 5
  and (rls_test.tl(rls_test.get('tb1')) ->> 'dispatched')::numeric = 5 and (rls_test.tl(rls_test.get('tb1')) ->> 'releasable')::numeric = 0
  and rls_test.on_hand(rls_test.id('fg2')) = 15, rls_test.tl(rls_test.get('tb1'))::text);
select rls_test.ok('16. re-invoicing uses the earlier dispatch: no second dispatch or deduction (still 15), Fully Invoiced',
  rls_test.tx(rls_test.id('fg2')) = (rls_test.get('tx_b'))::bigint and rls_test.on_hand(rls_test.id('fg2')) = 15
  and jsonb_array_length(rls_test.get('ib2p') -> 'dispatched_on_posting') = 0 and rls_test.tl(rls_test.get('tb2')) ->> 'status' = 'FULLY_INVOICED', rls_test.get('ib2p')::text);

-- ---------------------------------------------------------------------------
-- Not enough stock: posting fails, nothing changes
-- ---------------------------------------------------------------------------
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_ok('setup: order for 5 rare taps (only 2 in stock)', 'soc', rls_test.so(rls_test.id('few'), 5));
select rls_test.expect_call_ok('setup: invoice for 4', 'ic', rls_test.so_inv(rls_test.gid('soc', 'sales_order_id'), 4));
reset role;
select rls_test.set('tx_c', to_jsonb(rls_test.tx(rls_test.id('few'))));
set local role authenticated;
select rls_test.claims('sa');
select rls_test.expect_call_error('shortage: posting 4 with 2 in stock fails with a stock message', rls_test.issue(rls_test.gid('ic', 'invoice_id')), 'short');
-- Manual invoice of a stock item: still refused (cannot be dispatched).
select rls_test.expect_call_ok('setup: manual stock invoice', 'im', format('select public.sales_invoice_v2_save(null, %L::jsonb, %L::jsonb, null, %L)',
  jsonb_build_object('customer_id', rls_test.id('cx')), jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 1)), gen_random_uuid()));
select rls_test.expect_call_error('dispatch rule: a manual (not order-linked) stock invoice is still refused', rls_test.issue(rls_test.gid('im', 'invoice_id')), 'Dispatch the goods');
reset role;
select rls_test.ok('shortage: invoice still a draft, no stock movement, no notice',
  (rls_test.inv(rls_test.gid('ic', 'invoice_id'))).status = 'DRAFT' and rls_test.tx(rls_test.id('few')) = (rls_test.get('tx_c'))::bigint
  and not exists (select 1 from public.billing_events where invoice_id = rls_test.gid('ic', 'invoice_id') and event_type = 'PARTIAL_INVOICE'));
select rls_test.ok('grants: anon cannot call the new RPCs',
  not has_function_privilege('anon', 'public.sales_invoice_tracking(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.invoice_partial_preview(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sales_order_line_release_pending(uuid, numeric, text, uuid)', 'EXECUTE'));

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
  raise exception 'PARTIAL_INVOICING_RESULT passed=% failed=%', v_passed, v_failed
    using detail = v_report,
          hint = 'This error is intentional: it rolls back all test data. failed=0 means every check passed.';
end;
$$;
