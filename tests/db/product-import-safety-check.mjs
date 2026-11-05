// Product Excel import — database guarantees the import relies on (no migration of its own).
//
//   npm run test:db:product-import
//
// Local PGlite database only (never the live ALTON V2 project). Runs the same statements the import
// sends (insert, the optimistic update on id + updated_at, check_product_identifiers, the company
// SKU/name list) as company A's and company B's users, and checks:
//   * a SKU that exists in any case or with spaces is never inserted again (two imports at once included);
//   * an update changes only the fields sent, keeps the id and SKU, and is refused when the product
//     changed after the file was checked;
//   * another company's products can be neither found nor changed.

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
    return { rows: r.rows, affected: r.affectedRows }
  } catch (e) {
    await db.exec('rollback to savepoint t')
    return { error: e.message }
  }
}
const asOwner = () => db.exec('reset role')
const asUser = async (key) => {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [key]), role: 'authenticated' })])
  await db.exec('set role authenticated')
}
const insert = (sku, name, company = 'company_a') => attempt(
  `insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
   values (rls_test.id($3), $1, $2, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS')`, [sku, name, company])
const ownerRow = async (sku, company = 'company_a') => {
  await asOwner()
  return (await db.query(`select * from public.products where company_id = rls_test.id($2) and lower(sku) = lower($1)`, [sku, company])).rows[0]
}
const count = async (sku, company = 'company_a') => {
  await asOwner()
  return val(`select count(*)::int from public.products where company_id = rls_test.id($2) and lower(sku) = lower($1)`, [sku, company])
}

// ---------------------------------------------------------------------------
console.log('New products: a SKU is never created twice')
await asUser('op')
ok('a new SKU is created', !(await insert('IMP-100', 'Import closet')).error)
await asUser('op')
const again = await insert('imp-100', 'Import closet')
ok('the same SKU in another case is refused by the database', /duplicate|unique/i.test(again.error ?? ''), again)
await asUser('op')
const spaced = await insert('  IMP-100  ', 'Import closet')
ok('the same SKU with spaces is trimmed and refused', /duplicate|unique/i.test(spaced.error ?? ''), spaced)
ok('only one product has the SKU', (await count('IMP-100')) === 1)

// Two imports saving the same new SKU: the second insert (in its own transaction) fails; nothing is half-saved.
await asUser('op')
const batch = await attempt(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
  values (rls_test.id('company_a'), 'IMP-200', 'Batch one', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS'),
         (rls_test.id('company_a'), 'imp-200', 'Batch two', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS')`)
ok('a batch holding the same SKU twice saves nothing', Boolean(batch.error) && (await count('IMP-200')) === 0, batch)
await asUser('op')
await insert('IMP-300', 'First import')
await asUser('op')
const second = await insert('IMP-300', 'Second import, same moment')
ok('the later of two concurrent imports cannot add the SKU again', /duplicate|unique/i.test(second.error ?? '') && (await count('IMP-300')) === 1, second)

console.log('Matching stays inside the company')
await asUser('op')
let r = await attempt(`select sku from public.check_product_identifiers($1, '{}')`, [['  imp-100 ']])
ok('an existing SKU is found ignoring case and spaces', r.rows?.length === 1 && r.rows[0].sku === 'IMP-100', r)
await asUser('b_op')
r = await attempt(`select sku from public.check_product_identifiers($1, '{}')`, [['imp-100']])
ok('another company does not see the SKU', r.rows?.length === 0, r)
r = await attempt(`select count(*)::int as n from public.products where company_id = rls_test.id('company_a')`)
ok('another company\'s SKU / name list is empty', r.rows?.[0]?.n === 0, r)
ok('another company may create its own product with the same SKU', !(await insert('IMP-100', 'Company B closet', 'company_b')).error)

console.log('Existing products: only the selected, changed fields')
const before = await ownerRow('IMP-100')
await db.exec(`update public.products set mrp = 850, standard_manufacturing_cost = 450, gst_rate = 18, hsn_code = '84818020', selling_price = 700 where id = '${before.id}'`)
const stored = await ownerRow('IMP-100')
// Company B tries the import's update on company A's product.
await asUser('b_op')
r = await attempt(`update public.products set mrp = 1 where id = $1 and updated_at = $2`, [stored.id, stored.updated_at])
ok('another company cannot change the product', !r.error && r.affected === 0 && Number((await ownerRow('IMP-100')).mrp) === 850, r)
await asUser('op')
r = await attempt(`update public.products set standard_manufacturing_cost = 475, mrp = 900, change_reason = 'Updated by Excel import'
  where id = $1 and updated_at = $2 and company_id = rls_test.id('company_a')`, [stored.id, stored.updated_at])
const after = await ownerRow('IMP-100')
ok('the update applies once', !r.error && r.affected === 1, r)
// The fixtures run in one transaction (now() does not move); each import save is its own request.
await db.exec('commit; begin')
await db.exec(`update public.products set mrp = mrp where id = '${stored.id}'`)
ok('a save moves the product\'s updated_at', String((await ownerRow('IMP-100')).updated_at) !== String(stored.updated_at))
ok('the selected fields change', Number(after.standard_manufacturing_cost) === 475 && Number(after.mrp) === 900, after)
ok('unselected fields, the id and the SKU are unchanged', after.id === stored.id && after.sku === 'IMP-100' && Number(after.gst_rate) === 18
  && after.hsn_code === '84818020' && Number(after.selling_price) === 700 && after.product_name === stored.product_name, after)
await asUser('op')
r = await attempt(`update public.products set mrp = 999 where id = $1 and updated_at = $2`, [stored.id, stored.updated_at])
ok('a second save with the old check time changes nothing (optimistic concurrency)', !r.error && r.affected === 0 && Number((await ownerRow('IMP-100')).mrp) === 900, r)
await asOwner()
ok('the change is in the audit log', (await val(`select count(*)::int from public.audit_logs where resource_id = $1`, [stored.id])) > 0)
ok('company B\'s product with the same SKU is untouched', Number((await ownerRow('IMP-100', 'company_b')).mrp ?? 0) === 0 || (await ownerRow('IMP-100', 'company_b')).mrp === null)

console.log(`${failed === 0 ? '✓' : '✗'} product import safety check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
