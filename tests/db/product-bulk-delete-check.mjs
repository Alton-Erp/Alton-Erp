// Product bulk delete (migration 20261121090000) — database, security and integrity tests.
//
//   npm run test:db:product-delete
//
// Local PGlite database only (never the live ALTON V2 project). Company A gets the whole end-to-end
// business flow (supabase/tests/stage7_e2e_verification.sql), so its products 'fg' and 'clay' have stock,
// orders, invoices, BOMs and production. Never-used products, a product used only by a draft invoice,
// one used only by a customer product code, and company B's products are added. Then, as company A's
// Super Admin, previews and deletes, and checks every rule of the specification.

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
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]
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
let currentUser = null
const asOwner = () => { currentUser = null; return db.exec('reset role') }
const asUser = async (key) => {
  currentUser = key
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [key]), role: 'authenticated' })])
  await db.exec('set role authenticated')
}
const idOf = (sku, company = 'company_a') => val(`select id from public.products where sku = $1 and company_id = rls_test.id($2)`, [sku, company])
const exists = async (id) => (await ownerVal(`select count(*)::int from public.products where id = $1`, [id])) === 1
/** Counted as the database owner (row-level security would hide other companies' rows), then back to the user. */
const ownerVal = async (sql, params) => {
  const user = currentUser
  await db.exec('reset role')
  const v = await val(sql, params)
  if (user) await asUser(user)
  return v
}
const productCount = (company) => ownerVal(`select count(*)::int from public.products where company_id = rls_test.id($1)`, [company])
const preview = async (ids) => {
  const r = await attempt(`select public.product_bulk_delete_preview($1::uuid[])`, [ids])
  if (r.error) throw new Error(r.error)
  return r.value
}
const del = async (ids, phrase = 'DELETE PRODUCTS', reason = 'Duplicate products', archive = false) =>
  attempt(`select public.product_bulk_delete($1::uuid[], $2, $3, $4, gen_random_uuid())`, [ids, phrase, reason, archive])

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
await asOwner()
await db.exec(`
  insert into rls_test.ids (key, id) values ('admin', 'e7e5c800-0000-4000-8000-0000000000a3');
  insert into auth.users (id, email) values (rls_test.id('admin'), 'admin@pb.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('admin');
  insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('admin'), rls_test.id('company_a'), rls_test.id('role_admin'));

  insert into public.product_categories (company_id, code, name, is_active) values (rls_test.id('company_a'), 'PBCAT', 'PB Basins', true);
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, category_id, barcode, model_number, description, mrp, standard_manufacturing_cost, hsn_code, gst_rate) values
    (rls_test.id('company_a'), 'PB-1', 'Wall Basin  White', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', (select id from public.product_categories where code = 'PBCAT'), '8900000000011', 'WB-100', 'Ceramic wall basin, white glaze', 850, 450, '6910', 18),
    (rls_test.id('company_a'), 'PB-2', 'wall basin white', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, null, 'wb 100', 'Ceramic wall-basin (white glaze)', null, null, null, null),
    (rls_test.id('company_a'), 'PB-3', 'Unused seat', 'COMPONENT', 'IN_HOUSE', 'PCS', 'INACTIVE', null, null, null, null, null, null, null, null),
    (rls_test.id('company_a'), 'PB-4', 'Another unused', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', null, null, null, null, null, null, null, null),
    (rls_test.id('company_a'), 'PB-INV', 'On a draft invoice', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, null, null, null, null, null, null, null),
    (rls_test.id('company_a'), 'PB-CODE', 'Has a customer code', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, null, null, null, null, null, null, null),
    (rls_test.id('company_b'), 'B-PB-1', 'Wall Basin White', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, '8900000000011', null, null, null, null, null, null);
  insert into public.customer_product_codes (company_id, customer_id, customer_sku, product_id)
    values (rls_test.id('company_a'), rls_test.gid('cus', 'customer_id'), 'CUST-PB', (select id from public.products where sku = 'PB-CODE'));
  insert into public.inventory_alerts (company_id, alert_key, alert_type, severity, product_id)
    values (rls_test.id('company_a'), 'pb-1-low', 'LOW_STOCK', 'WARNING', (select id from public.products where sku = 'PB-1'));
`)
// A product edit makes a second version (history rows must go with the product).
await db.exec(`update public.products set mrp = 875, change_reason = 'price' where sku = 'PB-1'`)
await asUser('op')
const inv = await attempt(`select public.sales_invoice_v2_save(null, jsonb_build_object('customer_id', rls_test.gid('cus', 'customer_id')),
  jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where sku = 'PB-INV'), 'quantity', 1, 'unit_price', 500)), null, gen_random_uuid())`)
if (inv.error) { console.error('✗ fixture draft invoice:', inv.error); process.exit(1) }
await asOwner()

const ids = {}
for (const s of ['PB-1', 'PB-2', 'PB-3', 'PB-4', 'PB-INV', 'PB-CODE']) ids[s] = await idOf(s)
ids.FG = await val(`select rls_test.id('fg')`)
ids.CLAY = await val(`select rls_test.id('clay')`)
ids.B = await idOf('B-PB-1', 'company_b')
const bCount = await productCount('company_b')
const ledgerBefore = await val(`select count(*)::int from public.inventory_transactions`)
const invoiceLinesBefore = await val(`select count(*)::int from public.sales_invoice_lines`)

// ---------------------------------------------------------------------------
console.log('Duplicate indicators')
await asUser('op')
const hints = (await db.query(`select product_id, kind, matches, match_skus from public.product_duplicate_hints($1::uuid[]) order by 2`, [[ids['PB-1']]])).rows
const kinds = Object.fromEntries(hints.map((h) => [h.kind, h]))
ok('same name (case and spaces ignored), same model number, similar description (barcodes and EANs are unique per company already)', ['description', 'model', 'name'].every((k) => kinds[k]), hints)
ok('matches only within the company (company B has the same name and barcode)', hints.every((h) => !h.match_skus.includes('B-PB-1')) && kinds.name?.match_skus.join() === 'PB-2', hints)
ok('a product without duplicates has no indicator', (await val(`select count(*)::int from public.product_duplicate_hints($1::uuid[])`, [[ids['PB-3']]])) === 0)

// ---------------------------------------------------------------------------
console.log('Permissions and company isolation')
await asUser('admin')
ok('an Admin who is not Super Admin cannot preview', /Only a Super Admin/.test((await attempt(`select public.product_bulk_delete_preview($1::uuid[])`, [[ids['PB-3']]])).error ?? ''))
ok('an Admin who is not Super Admin cannot delete', /Only a Super Admin/.test((await del([ids['PB-3']])).error ?? '') && await exists(ids['PB-3']))
await asOwner()
await db.exec(`set role anon`)
ok('anonymous callers cannot run it', /permission denied/.test((await attempt(`select public.product_bulk_delete($1::uuid[], 'DELETE PRODUCTS', 'x', false, null)`, [[ids['PB-3']]])).error ?? ''))
await asOwner()
ok('signed-in users cannot delete products directly (no delete policy / grant)', await (async () => {
  await asUser('op')
  const r = await attempt(`delete from public.products where id = $1 returning id`, [ids['PB-3']])
  await asOwner()
  return (r.error || r.value === undefined) && await exists(ids['PB-3'])
})())

await asUser('op')
const pv = await preview([ids['PB-1'], ids['PB-2'], ids['PB-INV'], ids.FG, ids.CLAY, ids.B])
const byId = Object.fromEntries(pv.products.map((p) => [p.id, p]))
ok('company B\'s product is reported as not found and not described', pv.not_found.includes(ids.B) && !byId[ids.B], pv.not_found)
ok('preview shows name, SKU, category, cost, MRP, HSN and GST', byId[ids['PB-1']]?.category === 'PB Basins' && Number(byId[ids['PB-1']].mrp) === 875
  && Number(byId[ids['PB-1']].standard_manufacturing_cost) === 450 && byId[ids['PB-1']].hsn_code === '6910' && Number(byId[ids['PB-1']].gst_rate) === 18, byId[ids['PB-1']])
ok('never-used products are deletable', byId[ids['PB-1']].deletable && byId[ids['PB-2']].deletable)
const labels = (id) => byId[id].blockers.map((b) => b.label)
ok('5. a product with stock is protected: stock ledger and balances named', !byId[ids.CLAY].deletable && labels(ids.CLAY).includes('Stock ledger entries') && labels(ids.CLAY).includes('Stock balances'), labels(ids.CLAY))
ok('6. a product on an invoice is protected, and the invoice is named', !byId[ids['PB-INV']].deletable && labels(ids['PB-INV']).join() === 'Sales invoices', labels(ids['PB-INV']))
ok('the finished product of the flow is protected by its orders, invoices, BOM and production', ['Sales orders', 'Sales invoices', 'BOMs (as the finished product)', 'Production orders'].every((l) => labels(ids.FG).includes(l)), labels(ids.FG))
ok('a product with stock cannot be archived; one without stock can', byId[ids.CLAY].can_archive === false && byId[ids['PB-INV']].can_archive === true)
ok('preview changes nothing', await exists(ids['PB-1']) && (await productCount('company_b')) === bCount)

// ---------------------------------------------------------------------------
console.log('Confirmation')
const audit0 = await ownerVal(`select count(*)::int from public.audit_logs`)
let r = (await del([ids['PB-3']], 'delete products')).value
ok('a wrong phrase is refused and nothing is deleted', r.status === 'DENIED' && /DELETE PRODUCTS/.test(r.error) && await exists(ids['PB-3']), r)
r = (await del([ids['PB-3']], 'DELETE PRODUCTS', ' ')).value
ok('a reason is required', r.status === 'DENIED' && await exists(ids['PB-3']), r)
await asOwner()
ok('refused attempts are audited', (await val(`select count(*)::int from public.audit_logs where action = 'products.bulk_delete_denied'`)) === 2 && (await val(`select count(*)::int from public.audit_logs`)) === audit0 + 2)

// ---------------------------------------------------------------------------
console.log('Deleting')
await asUser('op')
r = (await del([ids['PB-3']])).value
ok('1. one never-used product is deleted', r.status === 'COMPLETED' && r.deleted.length === 1 && !(await exists(ids['PB-3'])), r)

const aCountBefore = await productCount('company_a')
r = (await del([ids['PB-1'], ids['PB-2'], ids['PB-INV'], ids.CLAY, ids.B])).value
ok('2. several products: the never-used ones are deleted', r.status === 'COMPLETED' && r.deleted.map((d) => d.sku).sort().join() === 'PB-1,PB-2', r.deleted)
ok('7. eligible unused products are gone, with their version history and alerts', !(await exists(ids['PB-1'])) && !(await exists(ids['PB-2']))
  && (await val(`select count(*)::int from public.product_versions where product_id = any ($1::uuid[])`, [[ids['PB-1'], ids['PB-2']]])) === 0
  && (await val(`select count(*)::int from public.inventory_alerts where product_id = $1`, [ids['PB-1']])) === 0)
ok('linked products are protected with their reasons, not deleted', r.blocked.map((b) => b.sku).sort().join() === 'PB-INV,RM-CLAY'.replace('RM-CLAY', r.blocked.find((b) => b.id === ids.CLAY)?.sku)
  && await exists(ids['PB-INV']) && await exists(ids.CLAY) && r.blocked.every((b) => b.blockers.length > 0 && !b.archived_now), r.blocked)
ok('8. company B\'s product is not deleted (not found)', r.not_found.includes(ids.B) && await exists(ids.B) && (await productCount('company_b')) === bCount)
ok('exactly the deleted rows are gone', (await productCount('company_a')) === aCountBefore - 2)
ok('stock ledger and invoice lines are unchanged', (await val(`select count(*)::int from public.inventory_transactions`)) === ledgerBefore
  && (await val(`select count(*)::int from public.sales_invoice_lines`)) === invoiceLinesBefore)

console.log('Archive instead')
r = (await del([ids['PB-CODE'], ids.CLAY], 'DELETE PRODUCTS', 'Duplicate products', true)).value
const code = r.blocked.find((b) => b.id === ids['PB-CODE'])
const clay = r.blocked.find((b) => b.id === ids.CLAY)
ok('a protected product without stock is archived instead', code?.archived_now === true
  && (await val(`select (archived_at is not null and status = 'INACTIVE')::text from public.products where id = $1`, [ids['PB-CODE']])) === 'true', code)
ok('a protected product with stock is not archived, with the reason', clay?.archived_now === false && /still has stock/.test(clay?.archive_error ?? ''), clay)

// ---------------------------------------------------------------------------
console.log('Audit history')
await asOwner()
const audit = (await db.query(`select action, resource_id, actor_user_id, metadata, event_timestamp from public.audit_logs where action like 'products.bulk%' order by event_timestamp`)).rows
const deletedRows = audit.filter((a) => a.action === 'products.bulk_deleted')
ok('9. one audit row per deleted product with id, SKU, name, reason, user and time', deletedRows.length === 3
  && deletedRows.every((a) => a.resource_id && a.metadata.sku && a.metadata.product_name && a.metadata.reason === 'Duplicate products' && a.event_timestamp)
  && deletedRows.every((a) => a.actor_user_id === undefined || true), deletedRows)
ok('the user is recorded', (await val(`select count(*)::int from public.audit_logs where action = 'products.bulk_deleted' and actor_user_id = rls_test.id('op')`)) === 3)
ok('summary rows and the archive are audited', audit.filter((a) => a.action === 'products.bulk_delete').length === 3 && audit.some((a) => a.action === 'products.bulk_archived'))

// ---------------------------------------------------------------------------
console.log('Atomic: an error deletes nothing')
await db.exec(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit) values
  (rls_test.id('company_a'), 'PB-X1', 'Atomic one', 'COMPONENT', 'IN_HOUSE', 'PCS'), (rls_test.id('company_a'), 'PB-X2', 'Atomic two', 'COMPONENT', 'IN_HOUSE', 'PCS')`)
const x1 = await idOf('PB-X1')
const x2 = await idOf('PB-X2')
// A trigger that fails while the second product is deleted.
await db.exec(`create function pg_temp_fail() returns trigger language plpgsql as $$ begin if old.sku = 'PB-X2' then raise exception 'simulated failure'; end if; return old; end $$;
  create trigger pb_fail before delete on public.products for each row execute function pg_temp_fail();`)
await asUser('op')
r = (await del([x1, x2])).value
await asOwner()
ok('the operation fails, both products stay, every product is listed as failed with the reason', r.status === 'FAILED' && await exists(x1) && await exists(x2)
  && r.failed.length === 2 && r.failed.every((f) => /rolled back/.test(f.reason)) && r.deleted.length === 0, r)
ok('no per-product audit rows survive the failed attempt; the failure is audited',
  (await val(`select count(*)::int from public.audit_logs where action = 'products.bulk_deleted' and resource_id in ($1, $2)`, [x1, x2])) === 0
  && (await val(`select count(*)::int from public.audit_logs where action = 'products.bulk_delete_failed'`)) === 1)
ok('the version history guard is closed again after the attempt', /History|cannot/.test((await attempt(`delete from public.product_versions where product_id = $1`, [x1])).error ?? ''))
await db.exec(`drop trigger pb_fail on public.products; drop function pg_temp_fail()`)

console.log('Rollback script')
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261121090000_product_bulk_delete_down.sql')))
ok('rollback removes the functions', (await val(`select count(*)::int from pg_proc where proname like 'product_bulk_delete%' or proname in ('product_duplicate_hints', 'product_references', 'product_reference_sources')`)) === 0)
await db.exec(await read(path.join(migDir, '20261121090000_product_bulk_delete.sql')))
await db.exec(await read(path.join(migDir, '20261121090000_product_bulk_delete.sql')))
ok('the migration applies again, twice', (await val(`select count(*)::int from pg_proc where proname = 'product_bulk_delete'`)) === 1)

console.log(`${failed === 0 ? '✓' : '✗'} product bulk delete check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
