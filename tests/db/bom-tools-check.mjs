// BOM templates, clone and similar finished products (migration 20261203090000).
//
//   npm run test:db:bom-tools
//
// Local PGlite database only (throwaway, in memory). Every change goes through the ERP's own functions,
// one committed transaction per call. The screen's cost calculation (src/features/production/bom-tools-model.ts)
// is checked against the existing BOM version cost (bom_version_history), so there is one cost method.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { bomCost } from '../../src/features/production/bom-tools-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIG = '20261203090000_bom_templates_similar_products.sql'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow')

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
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const op = as('op')
const A = await val(`select rls_test.id('company_a')::text`)
const fg = await val(`select rls_test.id('fg')::text`)

// Users: a Production Manager (BOMs but not the Product Master) and a Management Viewer (read only).
await db.exec(`reset role;
  insert into rls_test.ids (key, id) values ('bt_pm', 'e7e5c800-0000-4000-8000-0000000000b1'), ('bt_view', 'e7e5c800-0000-4000-8000-0000000000b2');
  insert into auth.users (id, email) values (rls_test.id('bt_pm'), 'bt_pm@e7.example.invalid'), (rls_test.id('bt_view'), 'bt_view@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('bt_pm'), rls_test.id('bt_view'));
  insert into public.user_roles (user_id, company_id, role_id) values
    (rls_test.id('bt_pm'), rls_test.id('company_a'), (select id from public.roles where code = 'PRODUCTION_MANAGER')),
    (rls_test.id('bt_view'), rls_test.id('company_a'), (select id from public.roles where code = 'MANAGEMENT_VIEWER'))`)
/** Whether a user holds a permission in company A (checked as that user, outside the client role). */
async function userHas(user, code) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    return (await db.query(`select private.has_permission($1, $2) as v`, [A, code])).rows[0].v
  } finally {
    await db.exec('rollback')
  }
}

let n = 0
const component = (cost, unit = 'PCS', type = 'RAW_MATERIAL') => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, $3, 'OUTSOURCED', $4, 'ACTIVE', $5, 18, '6910') returning id`, [A, `BT-C${++n}`, type, unit, cost])
const C = { glaze: await component(12.5, 'KG'), tap: await component(450), bowl: await component(800), box: await component(35, 'PCS', 'PACKAGING_MATERIAL'), seat: await component(600) }
const finished = (sku) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', null, 18, '6910') returning id`, [A, sku])
const item = (product, quantity, wastage = 0, notes = null) => ({ component_product_id: product, quantity_required: quantity, unit: null, wastage_percentage: wastage, notes })

// Source: an active BOM (2 output units per batch).
const SRC_FG = await finished('BT-BASIN-STD')
const srcSave = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 2, 'Standard basin', $2::jsonb, gen_random_uuid())`,
  [SRC_FG, JSON.stringify([item(C.glaze, 3, 5, 'Two coats'), item(C.tap, 2), item(C.bowl, 2, 2), item(C.box, 2)])])
await op(`select public.production_bom_activate($1, 'Approved for production')`, [srcSave.bom_id])
const SRC = srcSave.bom_id
const snap = (bom) => val(`select md5(to_jsonb(b)::text || coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.line_no) from public.bom_items i where i.bom_id = b.id), ''))
  from public.boms b where b.id = $1`, [bom])
const srcBefore = await snap(SRC)
const ledger = () => val(`select md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), '')
  || coalesce((select string_agg(to_jsonb(b)::text, '|' order by b.id) from public.inventory_balances b), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.stock_reservations r), '')
  || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.product_purchase_cost_events e), '')
  || coalesce((select string_agg(id::text || ':' || coalesce(standard_cost::text, '-') || ':' || coalesce(standard_manufacturing_cost::text, '-'), '|' order by id) from public.products where id = any($1::uuid[])), ''))`, [existingProducts])
const existingProducts = await val(`select array_agg(id) from public.products`)
const ledgerBefore = await ledger()
// Existing production orders (fixture: finished product FG) and their material plans.
const fgBom = await val(`select id from public.boms where finished_product_id = $1 and status = 'APPROVED' order by version desc limit 1`, [fg])
const orders = () => val(`select md5(coalesce((select string_agg(o.id::text || ':' || o.bom_id || ':' || o.bom_code || ':' || o.bom_version || ':' || o.status, '|' order by o.id) from public.production_orders o), '')
  || coalesce((select string_agg(to_jsonb(m)::text, '|' order by m.id) from public.production_order_materials m), ''))`)
const ordersBefore = await orders()
const orderCount = await val(`select count(*)::int from public.production_orders where bom_id = $1`, [fgBom])

const similar = (user, source, products, key = crypto.randomUUID()) => request(user, `select public.bom_create_similar_products($1::jsonb, $2::jsonb, $3::uuid)`,
  [JSON.stringify(source), JSON.stringify(products), key])
const productPayload = (name, sku, extra = {}) => ({ product_name: name, sku, product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS',
  hsn_code: '6910', gst_rate: 18, description: `${name} (similar to the standard basin)`, ...extra })
const bomItems = (bom) => val(`select jsonb_agg(jsonb_build_object('product', i.component_product_id, 'qty', i.quantity_required::float8, 'wastage', i.wastage_percentage::float8, 'notes', i.notes) order by i.line_no)
  from public.bom_items i where i.bom_id = $1`, [bom])

// ---------------------------------------------------------------------------
console.log('\nCreate similar product (single)')
const one = await similar('op', { bom_id: SRC }, [{
  product: productPayload('Basin Deluxe', 'BT-BASIN-DLX'),
  bom: { output_quantity: 2, notes: 'Deluxe basin' },
  // 3. quantity changed (glaze 3 → 4), 5. box removed, 4. seat added, 6. bowl replaced by... kept; tap replaced below in the multi case.
  items: [item(C.glaze, 4, 5, 'Three coats'), item(C.tap, 2), item(C.bowl, 2, 2), item(C.seat, 1, 0, 'Soft close')],
}])
ok('the call succeeds', !one.error, one)
const p1 = one.value?.products?.[0]
ok('1. the source BOM is unchanged (header and components)', (await snap(SRC)) === srcBefore)
ok('2. a new finished product with its own id and the new name / SKU', p1 && p1.product_id !== SRC_FG && p1.sku === 'BT-BASIN-DLX' && p1.product_name === 'Basin Deluxe', p1)
const newBom = await val(`select jsonb_build_object('status', status, 'version', version, 'code', bom_code, 'product', finished_product_id, 'output', output_quantity::float8, 'reason', change_reason)
  from public.boms where id = $1`, [p1?.bom_id])
const srcCode = await val(`select bom_code from public.boms where id = $1`, [SRC])
ok('2. the new product has its own BOM: a new BOM code, version 1, DRAFT (not activated)', newBom.status === 'DRAFT' && newBom.version === 1 && newBom.code !== srcCode
  && newBom.product === p1.product_id && newBom.output === 2, newBom)
ok('the new BOM records where it came from (reason for the version)', newBom.reason === `Created from ${srcCode} v1 (BT-BASIN-STD)`, newBom.reason)
const items1 = await bomItems(p1.bom_id)
ok('3/4/5. quantity changed (glaze 4), component added (seat), component removed (box), remarks kept per line',
  items1.length === 4 && items1[0].product === C.glaze && items1[0].qty === 4 && items1[0].notes === 'Three coats' && items1.some((x) => x.product === C.seat && x.notes === 'Soft close')
  && !items1.some((x) => x.product === C.box), items1)
const prod1 = await val(`select jsonb_build_object('status', status, 'type', product_type, 'unit', base_unit, 'has_bom', has_bom, 'cost', standard_cost, 'gst', gst_rate::float8, 'created_by', created_by = rls_test.id('op'))
  from public.products where id = $1`, [p1.product_id])
ok('the new product is ACTIVE (a BOM needs an active product), with the given fields; its Cost is not copied', prod1.status === 'ACTIVE' && prod1.type === 'FINISHED_GOOD'
  && prod1.unit === 'PCS' && prod1.gst === 18 && prod1.cost === null && prod1.created_by === true, prod1)
ok('the source product is unchanged', (await val(`select standard_cost is null and product_name = 'BT-BASIN-STD' from public.products where id = $1`, [SRC_FG])) === true)
ok('the new product starts its own version history (version 1, created)', (await val(`select source || ':' || version_no from public.product_versions where product_id = $1 order by version_no limit 1`, [p1.product_id])) === 'CREATED:1')
ok('audit log: production.similar_product_created with the source BOM', (await val(`select count(*)::int from public.audit_logs where action = 'production.similar_product_created' and resource_id = $1
  and metadata ->> 'source_bom_id' = $2`, [p1.bom_id, SRC])) === 1)

// Cost: the screen's calculation = the existing BOM version cost (same method, no second engine).
const costs = await val(`select jsonb_object_agg(id, master_cost::float8) from public.product_master_list where id = any($1::uuid[])`, [Object.values(C)])
const lines = (await bomItems(SRC)).map((l) => ({ quantity: l.qty, wastage: l.wastage, unitCost: costs[l.product] }))
const screen = bomCost(lines, 2)
const history = await request('op', `select public.bom_version_history($1)`, [SRC])
const ver = history.value.versions.find((v) => v.id === SRC)
const historyUnit = Math.round(ver.items.reduce((s, i) => s + Number(i.line_cost), 0) * 100) / 100
ok(`9. cost: the screen's cost per finished unit (₹${screen.perUnit}) = the existing BOM version cost (₹${historyUnit})`, screen.perUnit === historyUnit && screen.complete, { screen, historyUnit })
// (3 × 1.05 × 12.5 + 2 × 450 + 2 × 1.02 × 800 + 2 × 35) per 2 units = (39.375 + 900 + 1632 + 70) / 2 = 1320.6875 → ₹1,320.69 per unit.
ok('9. cost: total material cost per batch ₹2,641.38, per finished unit ₹1,320.69 (wastage included)', screen.total === 2641.38 && screen.perUnit === 1320.69, screen)

// ---------------------------------------------------------------------------
console.log('\nGenerate multiple similar products')
const multi = await similar('op', { bom_id: SRC }, [
  { product: productPayload('Basin Compact', 'BT-BASIN-CMP'), bom: { output_quantity: 1 }, items: [item(C.glaze, 1), item(C.tap, 1), item(C.bowl, 1)] },
  // 6. replace: the tap is replaced by the seat for this product.
  { product: productPayload('Basin No-Tap', 'bt-basin-ntp'), bom: { output_quantity: 2 }, items: [item(C.glaze, 3, 5), item(C.seat, 2), item(C.bowl, 2, 2), item(C.box, 2)] },
  { product: productPayload('Basin Twin', 'BT-BASIN-TWN'), bom: { output_quantity: 2 }, items: [item(C.glaze, 3), item(C.tap, 2)] },
])
ok('7. three products from one BOM in one call', !multi.error && multi.value.created === 3, multi)
const [m1, m2, m3] = multi.value?.products ?? []
ok('7. each has its own product and DRAFT BOM; quantities are independent', new Set([m1.product_id, m2.product_id, m3.product_id]).size === 3
  && new Set([m1.bom_id, m2.bom_id, m3.bom_id]).size === 3 && [m1, m2, m3].every((p) => p.status === 'DRAFT' && p.version === 1)
  && (await bomItems(m1.bom_id))[0].qty === 1 && (await bomItems(m2.bom_id))[0].qty === 3)
const r2 = await bomItems(m2.bom_id)
ok('6. replace: the tap is replaced by the seat on one product only', r2.some((x) => x.product === C.seat) && !r2.some((x) => x.product === C.tap)
  && (await bomItems(m1.bom_id)).some((x) => x.product === C.tap))
ok('SKUs are stored as entered (trimmed)', m2.sku === 'bt-basin-ntp' && m3.sku === 'BT-BASIN-TWN', { m2, m3 })
const blank = await similar('op', { bom_id: SRC }, [{ product: productPayload('Blank SKU', ''), items: [item(C.glaze, 1)] }])
const numbering = await val(`select coalesce((select value::text from public.company_settings where company_id = $1 and key = 'product.auto_sku'), 'default')`, [A]).catch(() => 'unknown')
ok('a blank SKU follows the Product Master rule (next automatic code, or a clear refusal when numbering is off), naming the product',
  (!blank.error && Boolean(blank.value.products[0].sku)) || /Product 1 \(Blank SKU\): .*SKU/.test(blank.error ?? ''), { blank, numbering })
ok('none of the generated BOMs is activated', (await val(`select count(*)::int from public.boms where id = any($1::uuid[]) and status <> 'DRAFT'`, [[m1.bom_id, m2.bom_id, m3.bom_id]])) === 0)

// ---------------------------------------------------------------------------
console.log('\nDuplicate SKUs, validation, atomicity, idempotency')
const before = await val(`select count(*)::int from public.products`)
let e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Dup', 'bt-basin-dlx'), items: [item(C.glaze, 1)] }])
ok('10. an existing SKU (any case) is refused', /BT-BASIN-DLX|bt-basin-dlx/i.test(e.error ?? '') && /already exists/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('A', 'BT-NEW-1'), items: [item(C.glaze, 1)] }, { product: productPayload('B', 'bt-new-1'), items: [item(C.glaze, 1)] }])
ok('10. the same SKU twice in one request is refused', /more than one new product/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Good', 'BT-ATOM-1'), items: [item(C.glaze, 1)] }, { product: productPayload('Bad', 'BT-ATOM-2'), items: [item(C.glaze, 1), item(C.glaze, 2)] }])
ok('atomic: a duplicate component on product 2 is refused and product 1 is not created either', /listed more than once/.test(e.error ?? '')
  && (await val(`select count(*)::int from public.products where sku in ('BT-ATOM-1', 'BT-ATOM-2')`)) === 0, e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Zero', 'BT-ZERO'), items: [item(C.glaze, 0)] }])
ok('a zero quantity is refused', /greater than zero/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Unit', 'BT-UNIT'), items: [{ ...item(C.glaze, 1), unit: 'G' }] }])
ok('a unit other than the component\'s inventory unit is refused (no unit conversion is configured)', /does not match the inventory unit/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Self', 'BT-SELF'), items: [] }])
ok('a product without components is refused', /at least one component/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Raw', 'BT-RAW', { product_type: 'RAW_MATERIAL' }), items: [item(C.glaze, 1)] }])
ok('a raw material cannot be the output of a BOM', /cannot have a BOM/.test(e.error ?? ''), e)
e = await similar('op', { bom_id: SRC }, [{ product: productPayload('Bad GST', 'BT-GST', { gst_rate: 'abc' }), items: [item(C.glaze, 1)] }])
ok('an invalid Product Master value is refused with the product named', /Product 1 \(Bad GST\)/.test(e.error ?? ''), e)
ok('nothing was created by the refused requests', (await val(`select count(*)::int from public.products`)) === before)
const key = crypto.randomUUID()
const first = await similar('op', { bom_id: SRC }, [{ product: productPayload('Idem', 'BT-IDEM'), items: [item(C.glaze, 1)] }], key)
const again = await similar('op', { bom_id: SRC }, [{ product: productPayload('Idem', 'BT-IDEM'), items: [item(C.glaze, 1)] }], key)
ok('the same request sent twice creates one product and one BOM', again.value?.products?.[0]?.bom_id === first.value?.products?.[0]?.bom_id
  && (await val(`select count(*)::int from public.products where sku = 'BT-IDEM'`)) === 1, { first, again })

// ---------------------------------------------------------------------------
console.log('\nBOM templates')
const tpl = await request('op', `select public.bom_template_save(null, $1::jsonb, $2::jsonb, gen_random_uuid())`, [
  JSON.stringify({ template_name: 'Standard basin kit', description: 'Glaze, tap, bowl and box', output_quantity: 2, output_unit: 'PCS', source_bom_id: SRC }),
  JSON.stringify([item(C.glaze, 3, 5), item(C.tap, 2), item(C.bowl, 2, 2), item(C.box, 2)])])
ok('a template is saved from a BOM (name, description, default quantities and wastage)', !tpl.error && tpl.value.components === 4, tpl)
const T = tpl.value.template_id
const trow = await val(`select jsonb_build_object('status', status, 'src', source_bom_code, 'ver', source_bom_version, 'unit', output_unit) from public.bom_templates where id = $1`, [T])
ok('the template remembers its source BOM and is ACTIVE', trow.status === 'ACTIVE' && trow.src === srcCode && trow.ver === 1 && trow.unit === 'PCS', trow)
ok('the source BOM is still unchanged', (await snap(SRC)) === srcBefore)
e = await request('op', `select public.bom_template_save(null, $1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ template_name: 'standard BASIN kit', output_unit: 'PCS' }), JSON.stringify([item(C.glaze, 1)])])
ok('template names are unique (any case)', /already exists/.test(e.error ?? ''), e)
e = await request('op', `select public.bom_template_save(null, $1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ template_name: 'Dup lines', output_unit: 'PCS' }), JSON.stringify([item(C.glaze, 1), item(C.glaze, 1)])])
ok('a template cannot list a component twice', /more than once/.test(e.error ?? ''), e)
const fromTpl = await similar('op', { template_id: T }, [{ product: productPayload('Basin From Template', 'BT-TPL-1'), bom: { output_quantity: 2 }, items: [item(C.glaze, 3, 5), item(C.tap, 2), item(C.bowl, 2, 2)] }])
ok('a product is created from the template (DRAFT BOM, reason names the template)', !fromTpl.error
  && (await val(`select change_reason from public.boms where id = $1`, [fromTpl.value.products[0].bom_id])) === 'Created from BOM template "Standard basin kit"', fromTpl)
const edited = await request('op', `select public.bom_template_save($1, $2::jsonb, $3::jsonb)`, [T, JSON.stringify({ template_name: 'Standard basin kit', output_unit: 'PCS', output_quantity: 2 }),
  JSON.stringify([item(C.glaze, 3.5, 5), item(C.tap, 2)])])
ok('a template can be edited (components replaced)', !edited.error && (await val(`select count(*)::int from public.bom_template_items where template_id = $1`, [T])) === 2, edited)
ok('editing the template does not change BOMs created from it', (await bomItems(fromTpl.value.products[0].bom_id)).length === 3)
await op(`select public.bom_template_set_status($1, 'ARCHIVED')`, [T])
e = await similar('op', { template_id: T }, [{ product: productPayload('Late', 'BT-TPL-2'), items: [item(C.glaze, 1)] }])
ok('an archived template cannot be used or edited', /archived/.test(e.error ?? '')
  && /archived/.test((await request('op', `select public.bom_template_save($1, $2::jsonb, $3::jsonb)`, [T, JSON.stringify({ template_name: 'Standard basin kit', output_unit: 'PCS' }), JSON.stringify([item(C.glaze, 1)])])).error ?? ''), e)
await op(`select public.bom_template_set_status($1, 'ACTIVE')`, [T])
ok('a template can be reactivated', (await val(`select status from public.bom_templates where id = $1`, [T])) === 'ACTIVE')
ok('audit log: template created, updated, archived and reactivated', (await val(`select count(distinct action)::int from public.audit_logs where resource_type = 'bom_template' and resource_id = $1`, [T])) === 4)

// ---------------------------------------------------------------------------
console.log('\nPermissions and tenant isolation')
e = await similar('bt_view', { bom_id: SRC }, [{ product: productPayload('V', 'BT-V'), items: [item(C.glaze, 1)] }])
ok('11. a read-only user cannot create similar products', /not allowed|requires/.test(e.error ?? ''), e)
ok('11. a read-only user can see templates (production_bom.read)', (await request('bt_view', `select count(*)::int from public.bom_templates`)).value >= 1)
e = await request('bt_view', `select public.bom_template_save(null, $1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ template_name: 'Viewer', output_unit: 'PCS' }), JSON.stringify([item(C.glaze, 1)])])
ok('11. a read-only user cannot create templates', /not allowed|requires/.test(e.error ?? ''), e)
const pmProducts = await userHas('bt_pm', 'products.create')
e = await similar('bt_pm', { bom_id: SRC }, [{ product: productPayload('PM', 'BT-PM'), items: [item(C.glaze, 1)] }])
ok(`11. a Production Manager ${pmProducts ? 'with' : 'without'} products.create ${pmProducts ? 'can' : 'cannot'} create similar products`, pmProducts ? !e.error : /products\.create/.test(e.error ?? ''), e)
const pmTpl = await request('bt_pm', `select public.bom_template_save(null, $1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ template_name: 'PM kit', output_unit: 'PCS' }), JSON.stringify([item(C.glaze, 1)])])
ok('11. a Production Manager (production_bom.create) can create templates', !pmTpl.error, pmTpl)
e = await request('bt_view', `select public.bom_template_set_status($1, 'ARCHIVED')`, [T])
ok('11. a read-only user cannot archive templates', /not allowed|requires/.test(e.error ?? ''), e)
e = await request('bt_view', `insert into public.bom_templates (company_id, template_name, output_unit) values ($1, 'Direct', 'PCS')`, [A])
ok('11. templates cannot be written directly (only through the functions)', Boolean(e.error), e)
ok('12. company B sees no company A templates', (await request('b_op', `select count(*)::int from public.bom_templates where company_id = $1`, [A])).value === 0)
e = await similar('b_op', { bom_id: SRC }, [{ product: productPayload('B', 'BT-B'), items: [item(C.glaze, 1)] }])
ok('12. company B cannot use a company A BOM as the source', /not found in your company/.test(e.error ?? ''), e)
e = await similar('b_op', {}, [{ product: productPayload('B', 'BT-B'), items: [item(C.glaze, 1)] }])
ok('12. company B cannot use company A components', /not found in your company/.test(e.error ?? ''), e)
e = await request('b_op', `select public.bom_template_save($1, $2::jsonb, $3::jsonb)`, [T, JSON.stringify({ template_name: 'x', output_unit: 'PCS' }), JSON.stringify([])])
ok('12. company B cannot edit a company A template', /not found in your company/.test(e.error ?? ''), e)

// ---------------------------------------------------------------------------
console.log('\nProduction safety')
const v2 = await op(`select public.production_bom_save_and_activate($1, $2, rls_test.today(), null, 1, null, (select jsonb_agg(jsonb_build_object('component_product_id', component_product_id, 'quantity_required', quantity_required * 2, 'wastage_percentage', wastage_percentage)) from public.bom_items where bom_id = $1), gen_random_uuid(), 'Double the components', null)`,
  [fgBom, fg])
ok('a change to the active BOM of FG follows the existing revision workflow (a new version)', v2.bom_id !== fgBom && v2.new_version === true, v2)
const sim = await similar('op', { bom_id: fgBom }, [{ product: productPayload('FG Similar', 'BT-FG-SIM'), items: [item(C.glaze, 1)] }])
ok('a similar product can be created from an older (superseded) version', !sim.error, sim)
ok(`13. the ${orderCount} existing production order(s) keep their BOM id, code, version and material plans`, orderCount >= 1 && (await orders()) === ordersBefore)
ok('14. no stock, reservation, ledger or cost history changed and no existing product cost changed', (await ledger()) === ledgerBefore)
const del = await request('op', `delete from public.boms where id = $1`, [fgBom])
ok('a BOM used by production orders cannot be deleted', Boolean(del.error) && (await val(`select count(*)::int from public.boms where id = $1`, [fgBom])) === 1, del)
const act = await request('op', `select public.production_bom_activate($1, 'Reviewed')`, [p1.bom_id])
ok('7. a generated draft is activated only through the existing activation (production_bom.approve)', !act.error
  && (await val(`select status from public.boms where id = $1`, [p1.bom_id])) === 'APPROVED', act)
const actPm = await request('bt_view', `select public.production_bom_activate($1, null)`, [m1.bom_id])
ok('a read-only user cannot activate', Boolean(actPm.error), actPm)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database)')
await db.exec('reset role')
const down = await read(path.join(root, 'supabase', 'rollback', '20261203090000_bom_templates_similar_products_down.sql'))
let refused = null
try { await db.exec(down) } catch (x) { refused = x.message; await db.exec('rollback').catch(() => {}) }
ok('rollback refuses while templates exist', /BOM templates exist/.test(refused ?? '') && (await val(`select to_regclass('public.bom_templates')::text`)) === 'bom_templates', refused)
const keptProducts = await val(`select count(*)::int from public.products where sku like 'BT-%'`)
await db.exec(`set app.bom_templates_rollback = 'discard'`)
await db.exec(down)
await db.exec(`reset app.bom_templates_rollback`)
ok('with the explicit setting it drops the tables and functions', (await val(`select to_regclass('public.bom_templates')::text`)) === null
  && (await val(`select count(*)::int from pg_proc where proname in ('bom_template_save', 'bom_template_set_status', 'bom_create_similar_products')`)) === 0)
ok('rollback restores the reset catalogue (83 tables) and keeps the products and BOMs created', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 83
  && (await val(`select count(*)::int from public.products where sku like 'BT-%'`)) === keptProducts && (await snap(SRC)) === srcBefore)
await db.exec(await read(path.join(migDir, MIG)))
await db.exec(await read(path.join(migDir, MIG)))
const re = await similar('op', { bom_id: SRC }, [{ product: productPayload('After', 'BT-AFTER'), items: [item(C.glaze, 1)] }])
ok('the migration applies again, twice, and works', !re.error && (await val(`select count(*)::int from private.erp_reset_tables()`)) === 85, re)

console.log(`${failed === 0 ? '✓' : '✗'} BOM tools check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
