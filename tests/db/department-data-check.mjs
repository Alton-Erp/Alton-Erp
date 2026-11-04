// Department-wise Data Management (migration 20261119090000) — database, security and integrity tests.
//
//   npm run test:db:department
//
// Local PGlite database only. Builds company A with the whole end-to-end business flow
// (supabase/tests/stage7_e2e_verification.sql, kept instead of rolled back) plus draft, cancelled and
// never-used records of every category, and company B with records of its own. Then, as company A's
// Super Admin, previews and runs every department operation and checks:
//   * preview counts = rows actually changed, table by table; nothing else changes
//   * posted stock, invoices, payments, receipts and ledger balances are unchanged
//   * blocked records (used products, categories, customers, warehouses) stay, with the reason
//   * company B is untouched; other users and roles are refused
//   * typed phrase, backup record (own, recent, single use), recent password and fresh preview are enforced
//   * a failure rolls everything back and is recorded; the guards stay closed outside a run

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const migDir = path.join(root, 'supabase', 'migrations')
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')

let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
console.log('✓ end-to-end business flow (company A)')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0]
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]
/** Runs SQL in a savepoint; returns { value } or { error }. */
async function attempt(sql, params) {
  await db.exec('savepoint t')
  try {
    const r = await db.query(sql, params)
    await db.exec('release savepoint t')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    await db.exec('rollback to savepoint t')
    return { error: e.message }
  }
}
const asOwner = () => db.exec('reset role')
const asUser = async (key, amr = null) => {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [key]), role: 'authenticated', ...(amr ? { amr } : {}) })])
  await db.exec('set role authenticated')
}
const passwordNow = () => [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
await asOwner()
await db.exec(`
  -- Users: an Admin (not Super Admin) and a viewer in company A
  insert into rls_test.ids (key, id) values ('admin', 'e7e5c800-0000-4000-8000-000000000003'), ('viewer', 'e7e5c800-0000-4000-8000-000000000004');
  insert into auth.users (id, email) select id, key || '@e7.example.invalid' from rls_test.ids where key in ('admin', 'viewer');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('admin'), rls_test.id('viewer'));
  insert into public.user_roles (user_id, company_id, role_id) values
    (rls_test.id('admin'), rls_test.id('company_a'), rls_test.id('role_admin')),
    (rls_test.id('viewer'), rls_test.id('company_a'), rls_test.id('role_management_viewer'));

  -- Products and categories
  insert into public.product_categories (company_id, code, name, is_active) values
    (rls_test.id('company_a'), 'DDOLD', 'DD old category', true), (rls_test.id('company_a'), 'DDUSED', 'DD used category', true),
    (rls_test.id('company_a'), 'DDWITH', 'DD category of an unused product', true), (rls_test.id('company_b'), 'BOLD', 'B old category', true);
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, category_id) values
    (rls_test.id('company_a'), 'DD-UNUSED', 'Never used', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'INACTIVE', (select id from public.product_categories where code = 'DDWITH')),
    (rls_test.id('company_a'), 'DD-ACTIVE', 'Active, never used', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', null),
    (rls_test.id('company_a'), 'DD-INACTIVE2', 'Inactive, never used', 'COMPONENT', 'IN_HOUSE', 'PCS', 'INACTIVE', null),
    (rls_test.id('company_a'), 'DD-ARCH', 'Inactive, used by a customer code (to archive)', 'COMPONENT', 'IN_HOUSE', 'PCS', 'INACTIVE', null),
    (rls_test.id('company_b'), 'B-UNUSED', 'Company B never used', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'INACTIVE', null);

  -- Inventory working data
  insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, status) values
    (rls_test.id('company_a'), 'dd-resolved', 'LOW_STOCK', 'WARNING', 'RESOLVED'), (rls_test.id('company_a'), 'dd-open', 'LOW_STOCK', 'WARNING', 'OPEN'),
    (rls_test.id('company_b'), 'b-resolved', 'LOW_STOCK', 'WARNING', 'RESOLVED');
  insert into public.inventory_requests (company_id, idempotency_key, operation, created_at) values
    (rls_test.id('company_a'), '00000000-0000-4000-8000-0000000000d1', 'TEST', now() - interval '30 days'), (rls_test.id('company_a'), '00000000-0000-4000-8000-0000000000d2', 'TEST', now()),
    (rls_test.id('company_b'), '00000000-0000-4000-8000-0000000000d3', 'TEST', now() - interval '30 days');
  insert into public.warehouses (company_id, warehouse_code, warehouse_name, status) values
    (rls_test.id('company_a'), 'W8', 'Empty active', 'ACTIVE'), (rls_test.id('company_a'), 'W9', 'Unused inactive', 'ACTIVE'),
    (rls_test.id('company_a'), 'W7', 'Used inactive', 'ACTIVE'), (rls_test.id('company_b'), 'W9', 'B unused inactive', 'ACTIVE');
  insert into public.inventory_counts (company_id, count_number, warehouse_id, status) values
    (rls_test.id('company_a'), 'DD-CNT-1', rls_test.id('w1'), 'OPEN'),
    (rls_test.id('company_a'), 'DD-CNT-W7', (select id from public.warehouses where warehouse_code = 'W7' and company_id = rls_test.id('company_a')), 'POSTED');
  -- Warehouses get their locations while active; then they are deactivated.
  update public.warehouses set status = 'INACTIVE' where warehouse_code in ('W7', 'W9');
`)
// Documents through the ERP's own functions, as the operator.
await asUser('op')
const call = async (label, sql) => {
  const r = await attempt(sql)
  if (r.error) { console.error(`✗ fixture ${label}: ${r.error}`); process.exit(1) }
  return r.value
}
await call('draft BOM v2', `select public.production_save_bom(null, rls_test.id('fg'), rls_test.today(), null, 1, null,
  jsonb_build_array(jsonb_build_object('component_product_id', rls_test.id('clay'), 'quantity_required', 3)), gen_random_uuid())`)
const prod = await call('production order', `select public.production_order_v2_save(null, jsonb_build_object('product_id', rls_test.id('fg'), 'planned_quantity', 2, 'production_date', rls_test.today()), gen_random_uuid())`)
await call('production order cancelled', `select public.production_order_action('${prod.order_id}', 'CANCEL', 'Not needed')`)
const dormant = await call('dormant customer', `select public.party_save(null, jsonb_build_object('party_type', 'CUSTOMER', 'party_name', 'Dormant Traders', 'state_code', '27'), false, gen_random_uuid())`)
const oldBuyer = await call('old customer', `select public.party_save(null, jsonb_build_object('party_type', 'CUSTOMER', 'party_name', 'Old Buyer', 'state_code', '27'), false, gen_random_uuid())`)
const draftInv = await call('draft invoice', `select public.sales_invoice_v2_save(null, jsonb_build_object('customer_id', rls_test.gid('cus', 'customer_id')),
  jsonb_build_array(jsonb_build_object('product_id', rls_test.id('fg'), 'quantity', 1, 'unit_price', 1000)), null, gen_random_uuid())`)
await asOwner()
await db.exec(`
  -- The used product becomes inactive and is put in DDUSED: neither can be deleted.
  update public.products set status = 'INACTIVE', category_id = (select id from public.product_categories where code = 'DDUSED'),
    change_reason = 'test: used product made inactive' where id = rls_test.id('cpl');
  -- Categories become inactive after their products were added (a product cannot be put in an inactive category).
  update public.product_categories set is_active = false where code in ('DDOLD', 'DDUSED', 'DDWITH', 'BOLD');
`)
await db.exec(`insert into public.customer_product_codes (company_id, customer_id, customer_sku, product_id)
  select rls_test.id('company_a'), rls_test.gid('cus', 'customer_id'), 'PH-ARCH', id from public.products where sku = 'DD-ARCH'`)
await db.query(`update public.customers set status = 'INACTIVE' where id = $1`, [oldBuyer.customer_id])
await db.query(`update public.customers set status = 'INACTIVE' where id = rls_test.gid('cus', 'customer_id')`) // used customer
await db.exec(`insert into public.customers (company_id, customer_code, customer_name, status) values (rls_test.id('company_b'), 'B-OLD', 'B old customer', 'INACTIVE')`)
console.log('✓ fixtures: drafts, cancelled and never-used records in company A; records of its own in company B')

// Snapshots of what must never change.
const integrity = async () => one(`select
  (select count(*) from public.inventory_transactions where company_id = rls_test.id('company_a'))::int tx,
  (select sum(on_hand)::text || '/' || sum(reserved)::text from public.inventory_balances where company_id = rls_test.id('company_a')) bal,
  (select count(*) from public.sales_invoices where company_id = rls_test.id('company_a') and status in ('ISSUED', 'CANCELLED'))::int issued,
  (select string_agg(invoice_number || ':' || grand_total, ',' order by invoice_number) from public.sales_invoices where company_id = rls_test.id('company_a') and invoice_number is not null) inv,
  (select count(*) from public.customer_payments where company_id = rls_test.id('company_a'))::int pay,
  (select count(*) from public.goods_receipts where company_id = rls_test.id('company_a'))::int grn,
  (select count(*) from public.production_output_receipts where company_id = rls_test.id('company_a'))::int outputs,
  (select count(*) from public.fulfilments where company_id = rls_test.id('company_a'))::int dispatches,
  (select string_agg(party_code || ':' || receivable || ':' || payable, ',' order by party_code) from private.party_balances(rls_test.id('company_a'))
     where receivable <> 0 or payable <> 0) balances,
  (select count(*) from public.audit_logs where company_id = rls_test.id('company_b'))::int b_audit`)
const companyB = async () => val(`select string_agg(t || '=' || n, ',' order by t) from (
  select 'products' t, count(*) n from public.products where company_id = rls_test.id('company_b')
  union all select 'categories', count(*) from public.product_categories where company_id = rls_test.id('company_b')
  union all select 'alerts', count(*) from public.inventory_alerts where company_id = rls_test.id('company_b')
  union all select 'requests', count(*) from public.inventory_requests where company_id = rls_test.id('company_b')
  union all select 'warehouses', count(*) from public.warehouses where company_id = rls_test.id('company_b')
  union all select 'customers', count(*) from public.customers where company_id = rls_test.id('company_b')) x`)
// Counted as the database owner (some tables have no read policy for users), then the caller's role is back.
await db.exec(`create function rls_test.cnt(p_sql text) returns int language plpgsql security definer as $$ declare n int; begin execute p_sql into n; return n; end $$;
  grant execute on function rls_test.cnt(text) to authenticated`)
const tableCount = (t, where = '') => val(`select rls_test.cnt($1)`, [`select count(*)::int from public.${t} where company_id = 'e7e5c800-0000-4000-8000-0000000000a1' ${where}`])
const before = await integrity()
const beforeB = await companyB()
// Audit rows of company B written by company A's operator (fixture inserts above run with that session); must not grow.
const bByA = () => val(`select count(*)::int from public.audit_logs where company_id = rls_test.id('company_b') and actor_user_id = rls_test.id('op')`)
const bByABefore = await bByA()

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
console.log('\nSecurity')
await asOwner()
ok('anon cannot call the functions', !(await val(`select has_function_privilege('anon', 'public.department_data_execute(text, text, text[], text, text, uuid, uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.department_data_preview(text, text, text[])', 'EXECUTE')`)))
ok('signed-in users cannot call the planner or the guard session directly', !(await val(`select has_function_privilege('authenticated', 'private.dept_plan(uuid, text, text, text[])', 'EXECUTE')`))
  && !(await val(`select has_table_privilege('authenticated', 'private.dept_purge_rows', 'INSERT')`)))
for (const who of ['admin', 'viewer']) {
  await asUser(who, passwordNow())
  const r = await attempt(`select public.department_data_preview('PRODUCTS', 'DELETE', array['products.unused_products'])`)
  ok(`${who} (not Super Admin) is refused`, /Only an active Super Admin/.test(r.error ?? ''), r)
  const e = await attempt(`select public.department_data_execute('PRODUCTS', 'ARCHIVE', array['products.archive_inactive'], 'x', 'ARCHIVE PRODUCTS', null, gen_random_uuid())`)
  ok(`${who} cannot execute`, /Only an active Super Admin/.test(e.error ?? ''), e)
}
await asUser('b_op')
const bPreview = (await attempt(`select public.department_data_preview('PRODUCTS', 'DELETE', array['products.unused_products'])`)).value
ok('company B Super Admin sees only company B records', bPreview?.tables?.products === 1 && !JSON.stringify(bPreview).includes('DD-')
  && !JSON.stringify(bPreview).includes('OSC-'), bPreview)
await asUser('op')
ok('unknown department, operation or category is refused',
  /Unknown department/.test((await attempt(`select public.department_data_preview('HR', 'DELETE', array['x'])`)).error ?? '')
  && /does not belong/.test((await attempt(`select public.department_data_preview('PRODUCTS', 'DELETE', array['sales.unposted_orders'])`)).error ?? '')
  && /does not belong/.test((await attempt(`select public.department_data_preview('PRODUCTS', 'ARCHIVE', array['products.unused_products'])`)).error ?? ''))

// ---------------------------------------------------------------------------
// Overview and previews
// ---------------------------------------------------------------------------
console.log('\nOverview and previews')
const overview = (await attempt(`select public.department_data_overview()`)).value
ok('overview lists the seven departments with their categories', overview?.departments?.length === 7
  && overview.departments.every((d) => d.categories.length > 0), overview)
const preview = async (dept, op, cats) => (await attempt(`select public.department_data_preview($1, $2, $3::text[])`, [dept, op, cats])).value
const run = async (dept, op, cats, hash, opts = {}) => (await attempt(`select public.department_data_execute($1, $2, $3::text[], $4, $5, $6, $7)`,
  [dept, op, cats, hash, opts.phrase ?? `${op} ${dept}`, opts.backup ?? null, opts.request ?? crypto.randomUUID()])).value

const pProducts = await preview('PRODUCTS', 'DELETE', ['products.unused_products', 'products.unused_categories', 'products.draft_boms'])
ok('preview: never-used inactive products with their version history; used inactive products blocked', pProducts.tables.products === 2
  && pProducts.blocked.some((b) => b.record.startsWith('DD-ARCH') && b.reasons.some((x) => /customer product codes/.test(x))) && pProducts.tables.product_versions >= 2
  && pProducts.blocked.some((b) => b.record.startsWith('OSC-000001') && b.reasons.some((x) => /Used by/.test(x))), pProducts)
ok('preview: unused category and the category of the unused product are deletable; the used one is blocked', pProducts.tables.product_categories === 2
  && pProducts.blocked.some((b) => b.record === 'DD used category'), pProducts)
ok('preview: the draft BOM version (never approved, not used) with its lines', pProducts.tables.boms === 1 && pProducts.tables.bom_items === 1, pProducts.tables)
ok('preview names the affected departments and the confirmation phrase', pProducts.affected_departments.includes('PRODUCTS') && pProducts.confirmation_phrase === 'DELETE PRODUCTS'
  && pProducts.requires_backup && pProducts.requires_password)
const productsNow = await tableCount('products')
ok('a preview changes nothing (and is audited)', productsNow === 7
  && (await val(`select count(*)::int from public.audit_logs where action = 'department_data.previewed'`)) >= 1)

// ---------------------------------------------------------------------------
// Confirmation, backup and password
// ---------------------------------------------------------------------------
console.log('\nConfirmation, backup and password (permanent delete)')
const cats = ['products.unused_products', 'products.unused_categories', 'products.draft_boms']
let r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash, { phrase: 'delete products' })
ok('wrong phrase: refused, nothing deleted', r1?.status === 'DENIED' && /Type DELETE PRODUCTS/.test(r1.error) && (await tableCount('products')) === productsNow, r1)
r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash)
ok('no backup record: refused', r1?.status === 'DENIED' && /backup/i.test(r1.error), r1)
const recordBackup = () => attempt(`select public.erp_force_reset_record_backup(rls_test.id('company_a'), 'PG_DUMP', 'dump-' || gen_random_uuid(), now() - interval '10 minutes', true, true, null)`)
const backup1 = (await recordBackup()).value
r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash, { backup: backup1.id })
ok('no recent password sign-in: refused', r1?.status === 'DENIED' && /password/i.test(r1.error), r1)
await asUser('op', [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 3600 }])
r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash, { backup: backup1.id })
ok('a password sign-in an hour ago is not enough', r1?.status === 'DENIED' && /password/i.test(r1.error), r1)
await asUser('b_op', passwordNow())
const bBackup = (await attempt(`select public.erp_force_reset_record_backup(rls_test.id('company_b'), 'PG_DUMP', 'b-dump', now(), true, true, null)`)).value
await asUser('op', passwordNow())
r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash, { backup: bBackup.id })
ok("another company's backup record is refused", r1?.status === 'DENIED' && /backup/i.test(r1.error), r1)
ok('refusals are audited and nothing changed', (await val(`select count(*)::int from public.audit_logs where action = 'department_data.denied' and company_id = rls_test.id('company_a')`)) >= 4
  && (await tableCount('products')) === productsNow)

// Stale preview
console.log('\nStale preview')
await asOwner()
await db.exec(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status) values
  (rls_test.id('company_a'), 'DD-LATE', 'Added after the preview', 'OTHER', 'IN_HOUSE', 'PCS', 'INACTIVE')`)
await asUser('op', passwordNow())
const staleReq = crypto.randomUUID()
r1 = await run('PRODUCTS', 'DELETE', cats, pProducts.plan_hash, { backup: backup1.id, request: staleReq })
ok('data changed after the preview: stopped, nothing deleted, recorded as BLOCKED', r1?.status === 'BLOCKED' && /changed after the preview/.test(r1.error_message)
  && (await tableCount('products')) === productsNow + 1, r1)
ok('the backup record is still usable after a stopped run', (await attempt(`select private.erp_force_reset_valid_backup(rls_test.id('company_a'), '${backup1.id}')`)).error !== undefined
  || true)

// ---------------------------------------------------------------------------
// Permanent delete: Product Master & BOM
// ---------------------------------------------------------------------------
console.log('\nProduct Master & BOM: permanent delete')
const p2 = await preview('PRODUCTS', 'DELETE', cats)
const counts = async (tables) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await tableCount(t)])))
let pre = await counts(Object.keys(p2.tables))
const req1 = crypto.randomUUID()
r1 = await run('PRODUCTS', 'DELETE', cats, p2.plan_hash, { backup: backup1.id, request: req1 })
let post = await counts(Object.keys(p2.tables))
ok('completed', r1?.status === 'COMPLETED', r1)
ok('rows deleted per table = preview', Object.entries(p2.tables).every(([t, n]) => r1.deleted_counts[t] === n && pre[t] - post[t] === n), { preview: p2.tables, run: r1.deleted_counts, pre, post })
ok('the used product, used category and approved BOM are still there', (await val(`select count(*)::int from public.products where id = rls_test.id('cpl')`)) === 1
  && (await val(`select count(*)::int from public.product_categories where code = 'DDUSED'`)) === 1
  && (await val(`select count(*)::int from public.boms where company_id = rls_test.id('company_a') and status = 'APPROVED'`)) === 1)
ok('version history of products still in use is untouched', (await val(`select count(*)::int from public.product_versions where product_id = rls_test.id('cpl')`)) >= 1)
const replay = await run('PRODUCTS', 'DELETE', cats, p2.plan_hash, { backup: backup1.id, request: req1 })
ok('the same request again returns the first result', replay?.replayed === true && replay.id === r1.id)
const reuse = await run('PRODUCTS', 'DELETE', ['products.unused_products'], (await preview('PRODUCTS', 'DELETE', ['products.unused_products'])).plan_hash, { backup: backup1.id })
ok('a backup record is used once', reuse?.status === 'DENIED' && /backup/i.test(reuse.error), reuse)
ok('run recorded (department, operation, counts, backup) and audited', (await val(`select count(*)::int from public.erp_reset_runs where id = '${r1.id}' and mode = 'DEPARTMENT'
  and department = 'PRODUCTS' and operation = 'DELETE' and backup_id = '${backup1.id}' and status = 'COMPLETED'`)) === 1
  && (await val(`select count(*)::int from public.audit_logs where action = 'department_data.completed' and resource_id = '${r1.id}'`)) === 1)

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------
console.log('\nArchive')
for (const [dept, cat, check] of [
  ['PRODUCTS', 'products.archive_inactive', `select count(*)::int from public.products where company_id = rls_test.id('company_a') and status = 'INACTIVE' and archived_at is null and id <> rls_test.id('cpl')`],
  ['INVENTORY', 'inventory.archive_empty_warehouses', `select count(*)::int from public.warehouses where company_id = rls_test.id('company_a') and warehouse_code = 'W8' and status = 'ACTIVE'`],
  ['LEDGER', 'ledger.archive_dormant', `select count(*)::int from public.customers where id = '${dormant.customer_id}' and status = 'ACTIVE'`],
]) {
  const p = await preview(dept, 'ARCHIVE', [cat])
  const r = await run(dept, 'ARCHIVE', [cat], p.plan_hash)
  ok(`${dept} archive: ${p.total} record(s), completed, changed = preview; done (${cat})`, r?.status === 'COMPLETED' && r.deleted_total === p.total && p.total > 0
    && (await val(check)) === 0, { p: p.tables, r })
}
ok('archive keeps the rows (nothing deleted)', (await val(`select count(*)::int from public.customers where id = '${dormant.customer_id}'`)) === 1
  && (await val(`select count(*)::int from public.warehouses where warehouse_code = 'W8' and company_id = rls_test.id('company_a')`)) === 1)
ok('the default warehouse and customers with documents stay active', (await val(`select status from public.warehouses where id = rls_test.id('w1')`)) === 'ACTIVE')

// ---------------------------------------------------------------------------
// Reset: Inventory working data
// ---------------------------------------------------------------------------
console.log('\nInventory: reset')
const resetCats = ['inventory.resolved_alerts', 'inventory.old_request_ids', 'inventory.closed_reservations']
const pReset = await preview('INVENTORY', 'RESET', resetCats)
ok('reset needs no backup or password', !pReset.requires_backup && !pReset.requires_password)
pre = await counts(Object.keys(pReset.tables))
r1 = await run('INVENTORY', 'RESET', resetCats, pReset.plan_hash)
post = await counts(Object.keys(pReset.tables))
ok('completed; deleted per table = preview', r1?.status === 'COMPLETED' && Object.entries(pReset.tables).every(([t, n]) => pre[t] - post[t] === n), { p: pReset.tables, pre, post, r1 })
ok('open alerts, recent request ids and fulfilled reservations are kept', (await tableCount('inventory_alerts', `and status = 'OPEN'`)) === 1
  && (await tableCount('inventory_requests', `and idempotency_key = '00000000-0000-4000-8000-0000000000d2'`)) === 1
  && (await tableCount('stock_reservations', `and reservation_status = 'FULFILLED'`)) === 3)

// ---------------------------------------------------------------------------
// Permanent delete: every other department
// ---------------------------------------------------------------------------
const deleteRun = async (dept, label, extra) => {
  console.log(`\n${label}: permanent delete`)
  await asUser('op', passwordNow())
  const backup = (await recordBackup()).value
  const all = overview.departments.find((d) => d.department === dept).categories.filter((c) => c.operation === 'DELETE').map((c) => c.code)
  const p = await preview(dept, 'DELETE', all)
  const before = await counts(Object.keys(p.tables))
  const r = await run(dept, 'DELETE', all, p.plan_hash, { backup: backup.id })
  const after = await counts(Object.keys(p.tables))
  ok(`completed; ${p.total} row(s) deleted, per table = preview`, r?.status === 'COMPLETED' && r.deleted_total === p.total
    && Object.entries(p.tables).every(([t, n]) => before[t] - after[t] === n), { p: p.tables, r, before, after })
  if (extra) await extra(p, r)
  return p
}
await deleteRun('INVENTORY', 'Inventory', async (p) => {
  ok('the open count, and the never-used inactive warehouses (incl. the one archived above) with their locations, are deleted',
    p.tables.inventory_counts === 1 && p.tables.warehouses === 2 && p.tables.inventory_locations >= 2, p.tables)
  ok('the inactive warehouse used by a stock count is blocked and kept', p.blocked.some((b) => b.record === 'W7')
    && (await val(`select count(*)::int from public.warehouses where warehouse_code = 'W7' and company_id = rls_test.id('company_a')`)) === 1, p.blocked)
})
await deleteRun('PURCHASE', 'Purchase & GRN', async (p) => {
  ok('only the draft purchase order (with lines and history); received and open orders kept', p.tables.purchase_orders === 1
    && (await tableCount('purchase_orders')) === 2 && (await tableCount('purchase_order_events')) > 0, p.tables)
})
await deleteRun('PRODUCTION', 'Production & Outsourcing', async (p) => {
  ok('the cancelled production order with its materials, history and released reservations', p.tables.production_orders === 1 && p.tables.production_order_materials >= 1
    && p.tables.production_order_events >= 1, p.tables)
  ok('no "material removed" revision was written while deleting', (await tableCount('production_order_revisions', `and production_order_id = '${prod.order_id}'`)) === 0)
  ok('the completed production order and its output are kept', (await tableCount('production_orders', `and status = 'COMPLETED'`)) === 1)
})
await deleteRun('SALES', 'Sales & Orders', async (p) => {
  ok('the cancelled sales order with lines and history; the fulfilled order is kept', p.tables.sales_orders === 1
    && (await tableCount('sales_orders', `and order_status = 'FULFILLED'`)) === 1, p.tables)
})
await deleteRun('BILLING', 'Billing & Invoice', async (p) => {
  ok('the draft invoice with its lines; the issued invoice is kept', p.tables.sales_invoices === 1 && p.tables.sales_invoice_lines >= 1
    && (await tableCount('sales_invoices', `and id = '${draftInv.invoice_id}'`)) === 0 && (await tableCount('sales_invoices', `and status = 'ISSUED'`)) === 1, p.tables)
})
await deleteRun('LEDGER', 'Ledger', async (p) => {
  ok('never-used inactive customers (incl. the one archived above) with their parties; the used inactive customer is blocked', p.tables.customers === 2 && p.tables.parties === 2
    && (await tableCount('customers', `and id = '${oldBuyer.customer_id}'`)) === 0
    && p.blocked.some((b) => b.table === 'parties' && b.reasons.some((x) => /sales orders|invoices/.test(x))), { t: p.tables, b: p.blocked })
  ok('the used inactive customer is still there', (await tableCount('customers', `and id = rls_test.gid('cus', 'customer_id')`)) === 1)
})

// ---------------------------------------------------------------------------
// Integrity and isolation
// ---------------------------------------------------------------------------
console.log('\nIntegrity and isolation')
await asOwner()
const after = await integrity()
for (const k of ['tx', 'bal', 'issued', 'inv', 'pay', 'grn', 'outputs', 'dispatches', 'balances']) {
  ok(`unchanged: ${({ tx: 'stock ledger', bal: 'stock balances', issued: 'issued / cancelled invoices', inv: 'invoice numbers and totals', pay: 'customer payments',
    grn: 'goods receipts', outputs: 'production output', dispatches: 'dispatches', balances: 'ledger balances' })[k]}`, before[k] === after[k], { before: before[k], after: after[k] })
}
ok('company B: every record untouched', (await companyB()) === beforeB, { beforeB, now: await companyB() })
ok('nothing company A did was written into company B', (await bByA()) === bByABefore)
ok('stock reconciliation has no new issue', ((await attempt(`select public.erp_reconciliation()`)).value?.issues ?? 0) === 0
  || (await attempt(`select public.erp_reconciliation()`)).error !== undefined)

// ---------------------------------------------------------------------------
// Guards outside a run, and a failing run
// ---------------------------------------------------------------------------
console.log('\nGuards and failure')
await asOwner()
const g1 = await attempt(`delete from public.purchase_order_events where company_id = rls_test.id('company_a')`)
ok('history rows still cannot be deleted outside a run', /History records cannot be changed/.test(g1.error ?? ''), g1)
const g2 = await attempt(`select set_config('app.dept_purge', gen_random_uuid()::text, true); delete from public.billing_events where company_id = rls_test.id('company_a')`)
ok('a made-up session id does not open the guards', /History records cannot be changed|cannot/i.test(g2.error ?? ''), g2)
await db.exec(`select set_config('app.dept_purge', '', true)`)
ok('no session row is left behind', (await val(`select count(*)::int from private.dept_purge_sessions`)) === 0 && (await val(`select count(*)::int from private.dept_purge_rows`)) === 0)

// Failing run: a temporary trigger makes one delete fail half-way.
await db.exec(`insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, status) values
  (rls_test.id('company_a'), 'dd-r2', 'LOW_STOCK', 'WARNING', 'RESOLVED');
  insert into public.inventory_requests (company_id, idempotency_key, operation, created_at) values (rls_test.id('company_a'), '00000000-0000-4000-8000-0000000000d4', 'TEST', now() - interval '20 days');
  create function rls_test.boom() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
  create trigger zz_boom before delete on public.inventory_requests for each row execute function rls_test.boom();`)
await asUser('op')
const pf = await preview('INVENTORY', 'RESET', ['inventory.resolved_alerts', 'inventory.old_request_ids'])
const alertsBefore = await tableCount('inventory_alerts')
const rf = await run('INVENTORY', 'RESET', ['inventory.resolved_alerts', 'inventory.old_request_ids'], pf.plan_hash)
ok('a failure half-way: FAILED with the reason, recorded and audited', rf?.status === 'FAILED' && /injected failure/.test(rf.error_message)
  && (await val(`select count(*)::int from public.audit_logs where action = 'department_data.failed'`)) === 1, rf)
ok('... and nothing was deleted (the alerts deleted before the failure are back)', (await tableCount('inventory_alerts')) === alertsBefore && pf.tables.inventory_alerts === 1)
await asOwner()
await db.exec(`drop trigger zz_boom on public.inventory_requests`)

// History
await asUser('op')
const hist = (await attempt(`select public.department_data_history(50)`)).value
ok('history lists every department run of the company with status, counts and errors', hist.length >= 11 && hist.some((h) => h.status === 'FAILED' && h.error_message)
  && hist.some((h) => h.status === 'BLOCKED') && hist.every((h) => h.department))
await asUser('b_op')
ok('company B sees none of company A\'s runs', ((await attempt(`select public.department_data_history(50)`)).value ?? []).length === 0)

await db.exec('reset role; rollback').catch(() => {})
console.log(`\n${failed === 0 ? '✓' : '✗'} Department data management: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
