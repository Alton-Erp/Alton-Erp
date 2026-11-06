// Units of measurement (MTR, LTR, ROL …) — database checks. No migration is needed: products.base_unit
// accepts any 1-10 letter code. This proves the codes save, change and flow unchanged into purchase
// orders, goods receipts and the stock ledger, and that existing stock keeps its unit.
//
//   npm run test:db:uom
//
// Local PGlite database only (never the live ALTON V2 project).

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
await db.exec('commit')
console.log('✓ end-to-end business flow (company A)')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]
/** Runs one request as a user in its own transaction (deferred triggers run at the commit). */
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
      await db.exec('set local role authenticated')
    }
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* already ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => {
  const r = await request('op', sql, params)
  if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`)
  return r.value
}
const owner = (sql, params) => val(sql, params)
const id = (key) => owner(`select rls_test.id($1)`, [key])

const company = await id('company_a')
const loc = await id('g1')
const wh = await id('w1')
const supA = await owner(`select (value ->> 'supplier_id')::uuid from rls_test.vars where key = 'sup'`)
const add = (sku, unit) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate)
  values ($1, $2, $3, 'RAW_MATERIAL', 'OUTSOURCED', $4, 'ACTIVE', 18) returning id`, [company, sku, `UOM test ${sku}`, unit])
const unitOf = (pid) => owner(`select base_unit from public.products where id = $1`, [pid])
const setUnit = (pid, unit) => request('op', `update public.products set base_unit = $2 where id = $1 returning base_unit`, [pid, unit])

// Existing data before the tests: every product's unit and every ledger row's unit.
const before = await owner(`select jsonb_object_agg(id, base_unit) from public.products`)
const ledgerBefore = await owner(`select coalesce(jsonb_object_agg(id, unit), '{}') from public.inventory_transactions`)

// 1–3. Create.
const M = await add('UOM-MTR', 'MTR')
const L = await add('UOM-LTR', 'LTR')
const R = await add('UOM-ROL', 'ROL')
ok('1. a product is created with MTR', (await unitOf(M)) === 'MTR')
ok('2. a product is created with LTR', (await unitOf(L)) === 'LTR')
ok('3. a product is created with ROL', (await unitOf(R)) === 'ROL')
const lower = await add('UOM-LOWER', ' rol ')
ok('the code is stored trimmed in capitals', (await unitOf(lower)) === 'ROL')

// 4–6. Edit (no stock yet) and read back in a new transaction.
ok('4. an MTR product changes to LTR', (await setUnit(M, 'LTR')).value === 'LTR' && (await unitOf(M)) === 'LTR')
ok('5. an LTR product changes to ROL', (await setUnit(L, 'ROL')).value === 'ROL' && (await unitOf(L)) === 'ROL')
ok('   and back again (ROL → MTR)', (await setUnit(L, 'MTR')).value === 'MTR')
ok('6. the saved unit is read back after the change (committed)', (await request('op', `select base_unit from public.products where id = $1`, [L])).value === 'MTR')
ok('   each change is kept in the product version history', (await owner(`select count(*)::int from public.product_versions where product_id = $1`, [M])) >= 1)

// 7. Malformed codes are rejected by the database. An empty unit is rejected by the Product Master form
// (tests/unit/product-uom.test.ts); the database keeps its earlier rule of saving a missing unit as PCS.
const blank = await add('UOM-BLANK', '')
ok('7. the database saves a missing unit as PCS (existing rule; the form rejects it first)', (await unitOf(blank)) === 'PCS')
for (const bad of ['METRES-1', 'TOOLONGUNITCODE', 'M3']) {
  const r = await request('op', `insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
    values ($1, $2, 'bad unit', 'RAW_MATERIAL', 'OUTSOURCED', $3, 'ACTIVE')`, [company, `UOM-BAD-${bad.length}`, bad])
  ok(`7. unit ${JSON.stringify(bad)} is rejected`, Boolean(r.error), r.error ?? 'accepted')
}

// 10. Purchase order and goods receipt carry the product's unit; the stock ledger records it.
const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
  [JSON.stringify({ supplier_id: supA, purchase_type: 'RAW_MATERIAL', warehouse_id: wh }),
    JSON.stringify([{ product_id: M, quantity: 12.5, unit_price: 40 }, { product_id: R, quantity: 3, unit_price: 250 }])])).po_id
ok('10. the PO lines carry LTR and ROL', JSON.stringify(await owner(`select jsonb_agg(unit order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])) === '["LTR","ROL"]')
await op(`select public.purchase_order_open($1)`, [po])
const lines = await owner(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
const gr = await op(`select public.purchase_receipt_post($1, $2::jsonb, $3::jsonb, gen_random_uuid())`, [po, JSON.stringify({ receipt_date: await owner(`select private.company_today($1)::text`, [company]) }),
  JSON.stringify(lines.map((l, i) => ({ po_line_id: l, received_quantity: i === 0 ? 12.5 : 3, accepted_quantity: i === 0 ? 12.5 : 3, rejected_quantity: 0, accepted_location_id: loc })))])
ok('10. the goods receipt lines carry LTR and ROL', JSON.stringify(await owner(`select jsonb_agg(l.unit order by pl.line_no) from public.goods_receipt_lines l join public.purchase_order_lines pl on pl.id = l.purchase_order_line_id
  where l.purchase_order_id = $1`, [po])) === '["LTR","ROL"]', gr)
ok('   the stock ledger records 12.5 LTR and 3 ROL, quantities unchanged', JSON.stringify(await owner(`select jsonb_agg(jsonb_build_array(unit, quantity) order by unit)
  from public.inventory_transactions where product_id in ($1, $2)`, [M, R])) === '[["LTR",12.5],["ROL",3]]', JSON.stringify(await owner(`select jsonb_agg(jsonb_build_array(unit, quantity) order by unit) from public.inventory_transactions where product_id in ($1, $2)`, [M, R])))
const direct = await request('op', `select public.goods_receipt_direct_post($1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ warehouse_id: wh, receipt_date: await owner(`select private.company_today($1)::text`, [company]) }),
  JSON.stringify([{ product_id: L, received_quantity: 7.25, accepted_quantity: 7.25, rejected_quantity: 0, unit_cost: 10, accepted_location_id: loc }])])
ok('   a direct goods receipt of an MTR product records MTR', !direct.error && (await owner(`select string_agg(distinct unit, ',') from public.inventory_transactions where product_id = $1`, [L])) === 'MTR', direct.error)

// 8. Once stock exists the unit cannot change (no conversion of stock or history).
const locked = await setUnit(M, 'ROL')
ok('8. a product with stock keeps its unit (change refused)', Boolean(locked.error) && (await unitOf(M)) === 'LTR', locked.error ?? 'changed')
ok('8. every existing product kept its unit', (await owner(`select count(*)::int from jsonb_each_text($1::jsonb) b join public.products p on p.id = b.key::uuid where p.base_unit <> b.value`, [JSON.stringify(before)])) === 0)
ok('8. every existing stock ledger row kept its unit', (await owner(`select count(*)::int from jsonb_each_text($1::jsonb) b join public.inventory_transactions t on t.id = b.key::uuid where t.unit <> b.value`, [JSON.stringify(ledgerBefore)])) === 0)

// Company isolation: company B cannot see or change these products.
const other = await request('b_op', `update public.products set base_unit = 'PCS' where id = $1 returning id`, [R])
ok('company B cannot change company A\'s unit', !other.value && (await unitOf(R)) === 'ROL')

console.log(`${failed === 0 ? '✓' : '✗'} unit of measurement check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
