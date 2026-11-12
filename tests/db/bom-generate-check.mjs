// Generate Multiple BOMs for existing Product Master products and new products (migration 20261207090000).
//
//   npm run test:db:bom-generate
//
// Local PGlite database only (throwaway, in memory). One committed transaction per call, as the app does.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { itemsFromLines, linesFromItems, clearLineComponent } from '../../src/features/production/bom-tools-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261207090000_bom_generate_multiple'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ migrations before 20261207090000 applied, end-to-end business flow')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)

// Production Manager: BOMs but not the Product Master (products.create).
await db.exec(`reset role;
  insert into rls_test.ids (key, id) values ('bg_pm', 'e7e5c800-0000-4000-8000-0000000000c1');
  insert into auth.users (id, email) values (rls_test.id('bg_pm'), 'bg_pm@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('bg_pm');
  insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('bg_pm'), rls_test.id('company_a'), (select id from public.roles where code = 'PRODUCTION_MANAGER'))`)

let n = 0
const product = (type, unit = 'PCS', cost = 10) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2 || ' name', $3, 'OUTSOURCED', $4, 'ACTIVE', $5, 18, '6910') returning id`, [A, `BG-${++n}`, type, unit, cost])
const item = (p, q, w = 0, notes = null) => ({ component_product_id: p, quantity_required: q, unit: null, wastage_percentage: w, notes })
const C1 = await product('RAW_MATERIAL', 'KG', 12.5)
const C2 = await product('COMPONENT', 'PCS', 450)
const C3 = await product('PACKAGING_MATERIAL', 'PCS', 35)
const BASE_FG = await product('FINISHED_GOOD')
const base = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, 'Base', $2::jsonb, gen_random_uuid())`, [BASE_FG, JSON.stringify([item(C1, 3, 5), item(C2, 2), item(C3, 1)])])
await op(`select public.production_bom_activate($1, gen_random_uuid())`, [base.bom_id]).catch(async () => op(`select public.production_bom_activate($1)`, [base.bom_id]))
const EX1 = await product('FINISHED_GOOD')
const EX2 = await product('FINISHED_GOOD')
// EX2 already has a BOM: generation makes its next version as a draft.
const ex2bom = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [EX2, JSON.stringify([item(C2, 1)])])
const RAW = C1
const existingIds = await val(`select array_agg(id) from public.products`)
const snapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.products p where p.id = any($1::uuid[])), '')
  || coalesce((select string_agg(b.id || b.status || b.version, '|' order by b.id) from public.boms b where b.id in ($2, $3)), '')
  || coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), ''))`, [existingIds, base.bom_id, ex2bom.bom_id])
const before = await snapshot()

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log('✓ 20261207090000 applied (twice)')

const gen = (entries, user = 'op', key = crypto.randomUUID()) => request(user, `select public.bom_generate_multiple($1::jsonb, $2::jsonb, $3::uuid)`,
  [JSON.stringify({ bom_id: base.bom_id }), JSON.stringify(entries), key])
const baseItems = [item(C1, 3, 5), item(C2, 2), item(C3, 1)]
const bomsOf = (pid) => val(`select jsonb_agg(jsonb_build_object('version', version, 'status', status) order by version) from public.boms where finished_product_id = $1`, [pid])

// ---------------------------------------------------------------------------
console.log('\nExisting and new products in one batch')
const r1 = await gen([
  { product_id: EX1, bom: { output_quantity: 1 }, items: [item(C1, 4, 5), item(C2, 2)] },
  { product_id: EX2, bom: { output_quantity: 2 }, items: baseItems },
  { product: { product_name: 'Brand new basin', sku: 'BG-NEW-1', product_type: 'FINISHED_GOOD', base_unit: 'PCS', default_source_type: 'IN_HOUSE', gst_rate: 18, hsn_code: '6910' }, bom: { output_quantity: 1 }, items: baseItems },
])
const out = r1.value?.products ?? []
ok('one call saves three draft BOMs: two for existing products, one with a new product', r1.value?.created === 3 && out.every((p) => p.status === 'DRAFT')
  && out[0].existing_product === true && out[1].existing_product === true && out[2].existing_product === false, r1)
ok('existing product: its own SKU, version 1 draft BOM with the edited components', out[0]?.product_id === EX1 && out[0].sku === 'BG-5' && out[0].version === 1 && out[0].components === 2
  && (await val(`select count(*)::int from public.bom_items where bom_id = $1`, [out[0].bom_id])) === 2)
ok('existing product with a BOM: the next version as a draft, its earlier BOM unchanged', out[1]?.version === 2
  && JSON.stringify(await bomsOf(EX2)) === '[{"status":"DRAFT","version":1},{"status":"DRAFT","version":2}]', await bomsOf(EX2))
ok('new product: created by the existing function with the SKU entered (automatic numbering is off in this company)', out[2]?.sku === 'BG-NEW-1'
  && (await val(`select product_name from public.products where id = $1`, [out[2]?.product_id])) === 'Brand new basin', out[2])
ok('nothing is activated; no product other than the new one is created', (await val(`select count(*)::int from public.boms where id = any($1::uuid[]) and status <> 'DRAFT'`, [out.map((p) => p.bom_id)])) === 0)
ok('lineage and audit: "Generated from BOM… v1"', (await val(`select change_reason from public.boms where id = $1`, [out[0]?.bom_id]))?.startsWith('Generated from')
  && (await val(`select count(*)::int from public.audit_logs where action = 'production.bom_generated'`)) === 2)

// ---------------------------------------------------------------------------
console.log('\nAll or nothing, duplicates, permissions')
const EX3 = await product('FINISHED_GOOD')
const bad = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }, { product_id: RAW, bom: { output_quantity: 1 }, items: baseItems }])
ok('a failing row: nothing is saved, the row is named', Boolean(bad.error) && /Product 2 \(BG-1\)/.test(bad.error) && (await bomsOf(EX3)) === null, bad)
const dup = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }, { product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }])
ok('the same product twice in one batch is refused', /already in the batch/.test(dup.error ?? '') && (await bomsOf(EX3)) === null, dup)
const newBad = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }, { product: { product_name: '' }, bom: { output_quantity: 1 }, items: baseItems }])
ok('a new-product error keeps its row number in the batch', /^Product 2/.test((newBad.error ?? '').replace(/^.*?(Product)/, '$1')) && (await bomsOf(EX3)) === null, newBad)
const key = crypto.randomUUID()
const first = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }], 'op', key)
const again = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: baseItems }], 'op', key)
ok('a retried request returns the first result (no second BOM)', first.value?.created === 1 && again.value?.products?.[0]?.bom_id === first.value.products[0].bom_id
  && (await val(`select count(*)::int from public.boms where finished_product_id = $1`, [EX3])) === 1)
const EX4 = await product('FINISHED_GOOD')
const pmExisting = await gen([{ product_id: EX4, bom: { output_quantity: 1 }, items: baseItems }], 'bg_pm')
ok('Production Manager (no products.create) can generate BOMs for existing products', pmExisting.value?.created === 1, pmExisting)
const pmNew = await gen([{ product: { product_name: 'Not allowed', product_type: 'FINISHED_GOOD', base_unit: 'PCS' }, bom: { output_quantity: 1 }, items: baseItems }], 'bg_pm')
ok('…but not create new products (products.create still required)', /products\.create/.test(pmNew.error ?? ''), pmNew)
const other = await request('b_op', `select public.bom_generate_multiple($1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ bom_id: base.bom_id }), JSON.stringify([{ product_id: EX4, items: baseItems }])])
ok('another company cannot use this BOM or these products', /not found/.test(other.error ?? ''), other)
ok('anon cannot call it', !(await val(`select has_function_privilege('anon', 'public.bom_generate_multiple(jsonb, jsonb, uuid)', 'EXECUTE')`)))
ok('the base BOM, existing products, other BOMs and stock are unchanged', (await snapshot()) === before)

// ---------------------------------------------------------------------------
console.log('\nScreen helpers (the lines sent)')
const lines = linesFromItems([{ component_product_id: C1, sku: 'BG-1', product_name: 'x', unit: 'KG', quantity_required: 3, wastage_percentage: 5, notes: 'coat' },
  { component_product_id: C2, sku: 'BG-2', product_name: 'y', unit: 'PCS', quantity_required: 2, wastage_percentage: 0, notes: null }])
const cleared = lines.map((l, i) => (i === 0 ? clearLineComponent(l, '2') : l))
ok('× clears the component, quantity, wastage (default) and remarks of that line only', cleared[0].product === null && cleared[0].quantity === '' && cleared[0].wastage === '2'
  && cleared[0].notes === '' && cleared[0].key === lines[0].key && cleared[1] === lines[1])
const half = [{ ...lines[0], product: null }, lines[1]]
ok('a line with a quantity but no component is never sent (and no longer crashes the page)', itemsFromLines(half).length === 1 && itemsFromLines(half)[0].component_product_id === C2)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database)')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback drops the function and keeps the generated BOMs', !(await val(`select exists (select 1 from pg_proc where proname = 'bom_generate_multiple')`))
  && (await val(`select count(*)::int from public.boms where id = $1`, [out[0]?.bom_id])) === 1)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
const EX5 = await product('FINISHED_GOOD')
ok('the migration applies again and works', (await gen([{ product_id: EX5, bom: { output_quantity: 1 }, items: baseItems }])).value?.created === 1)
ok('every later migration still applies on top', await (async () => { for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f))); return true })())

console.log(`${failed === 0 ? '✓' : '✗'} BOM generate multiple check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
