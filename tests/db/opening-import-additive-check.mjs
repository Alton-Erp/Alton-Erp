// Opening stock Excel import: existing records matched, quantities added (migration 20261206090000).
//
//   npm run test:db:opening-import-additive
//
// Local PGlite database only (throwaway, in memory). One committed transaction per call, as the app does.
// The numbers in the scenario names follow the change request's verification list.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261206090000_opening_import_additive'
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
console.log('✓ migrations before 20261206090000 applied, end-to-end business flow')

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
const g1 = await val(`select rls_test.id('g1')::text`)
const today = await val(`select rls_test.today()::text`)
let n = 0
const newProduct = (cost, { unit = 'PCS', batches = false } = {}) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code, track_batches)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', $3, 'ACTIVE', $4, 18, '6910', $5) returning id`, [A, `OA-${++n}`, unit, cost, batches])
const line = (no, product, qty, extra = {}) => ({ line_no: no, product_id: product, location_id: g1, source_type: 'OUTSOURCED', quantity: qty, unit: 'PCS', effective_date: today, ...extra })
const manual = (lines) => request('op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify(lines)])
const QTY = { quantity: true, unit_cost: false, remarks: false }
const imp = (lines, fields = QTY, { post = true, key = crypto.randomUUID(), user = 'op' } = {}) => request(user,
  `select public.inventory_import_opening_stock($1::jsonb, $2::jsonb, $3, 'opening.xlsx', null, $4::uuid)`, [JSON.stringify(lines), JSON.stringify(fields), post, key])
const onHand = (product) => val(`select coalesce(sum(on_hand), 0)::float8 from public.inventory_balances where product_id = $1`, [product])
const ledger = (product) => val(`select coalesce(sum(quantity * direction), 0)::float8 from public.inventory_transactions where product_id = $1`, [product])
const lineQty = (product) => val(`select jsonb_agg(quantity::float8 order by created_at) from public.inventory_opening_lines where product_id = $1 and status = 'POSTED'`, [product])
const lots = (product) => val(`select count(distinct batch_id)::int from public.inventory_transactions where product_id = $1`, [product])
const lotCost = (product) => val(`select private.lot_average_cost(batch_id)::float8 from public.inventory_transactions where product_id = $1 and transaction_type = 'OPENING_STOCK' order by created_at limit 1`, [product])
const valuation = (product) => val(`select jsonb_build_object('status', valuation_status, 'value', stock_value::float8, 'unvalued', unvalued_on_hand::float8)
  from public.inventory_product_stock_value where product_id = $1`, [product])
const errorsOf = (r) => JSON.stringify(r.value?.errors ?? r.error)

// Opening stock posted before the change: must stay exactly as it is.
const OLD = await newProduct(10)
await manual([line(1, OLD, 4)])
const snapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from public.inventory_opening_lines l), '')
  || coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), ''))`)
const before = await snapshot()
const legacyDup = await manual([line(1, OLD, 1)])

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log('✓ 20261206090000 applied (twice)')
ok('no table, column or posted record is changed by the migration', (await snapshot()) === before)

// ---------------------------------------------------------------------------
console.log('\nNew and existing records')
const NEW = await newProduct(12)
const r1 = await imp([line(1, NEW, 30)])
ok('1. a new product, location and batch: a new opening stock record (as before)', r1.value?.ok && r1.value.status === 'POSTED' && r1.value.new_lines === 1
  && (await onHand(NEW)) === 30 && JSON.stringify(await lineQty(NEW)) === '[30]', r1)

const P = await newProduct(20)
await manual([line(1, P, 100)])
const r2 = await imp([line(1, P, 25)])
const add = r2.value?.additions?.[0]
ok('2. an existing record: 100 + 25 = 125 on hand', r2.value?.ok && (await onHand(P)) === 125 && add?.previous_quantity === 100 && add.added_quantity === 25 && add.new_quantity === 125, r2)
ok('3. never replaced: the opening record keeps its 100, no second record, the 25 is its own ledger entry',
  JSON.stringify(await lineQty(P)) === '[100]' && (await lots(P)) === 1
  && (await val(`select count(*)::int from public.inventory_transactions where product_id = $1 and reference_type = 'OPENING_ADDITION' and quantity = 25 and transaction_type = 'OPENING_STOCK'`, [P])) === 1)
const audit = await val(`select metadata from public.audit_logs where action = 'inventory.opening_quantity_added' and resource_id = $1`, [add?.opening_line_id])
ok('3. audit: previous, imported and new quantity recorded separately, with the file and row', audit?.previous_quantity === 100 && audit.added_quantity === 25 && audit.new_quantity === 125
  && audit.file_name === 'opening.xlsx' && audit.import_line_no === 1 && audit.cost_source === 'EXISTING_LOT_COST', audit)
const matches = await op(`select public.opening_stock_import_matches($1::uuid[])`, [[P]])
ok('the preview lookup shows the record with its quantity, added quantity, lot cost and on hand',
  matches.length === 1 && Number(matches[0].quantity) === 100 && Number(matches[0].added_quantity) === 25 && Number(matches[0].lot_cost) === 20 && Number(matches[0].on_hand) === 125, matches)

const r4 = await imp([line(1, P, 20), line(2, P, 5)])
ok('4. several rows for the same record add up: 125 + 20 + 5 = 150', r4.value?.ok && (await onHand(P)) === 150
  && r4.value.additions.map((a) => a.new_quantity).join() === '145,150', r4)
const NEWDUP = await newProduct(8)
const r4b = await imp([line(1, NEWDUP, 10), line(2, NEWDUP, 6)])
ok('4. the same new record twice in one file: created once, the second row added (16)', r4b.value?.ok && (await onHand(NEWDUP)) === 16 && JSON.stringify(await lineQty(NEWDUP)) === '[10]', r4b)

const BATCH = await newProduct(15, { batches: true })
await manual([line(1, BATCH, 40, { batch_number: 'B-1' })])
const r4c = await imp([line(1, BATCH, 10, { batch_number: 'b-1' }), line(2, BATCH, 7, { batch_number: 'B-2' })])
ok('matching uses the batch: B-1 gets 10 more (case does not matter), B-2 is a new record', r4c.value?.ok && r4c.value.new_lines === 1 && r4c.value.additions.length === 1
  && (await onHand(BATCH)) === 57 && JSON.stringify(await lineQty(BATCH)) === '[40,7]', r4c)

// ---------------------------------------------------------------------------
console.log('\nCost')
const r5 = await imp([line(1, P, 10, { unit_cost: 999 })])
ok('5. Unit Cost not selected: the Excel cost is ignored, the added stock takes the existing cost ₹20, the lot keeps ₹20', r5.value?.ok
  && r5.value.additions[0].unit_cost === 20 && (await lotCost(P)) === 20, r5)
const r5b = await imp([line(1, P, 1, { unit_cost: 35 })], { ...QTY, unit_cost: true })
ok('5. Unit Cost selected with a different cost: refused with the row (posted stock is not re-valued), nothing added', r5b.value?.ok === false
  && r5b.value.errors[0]?.line_no === 1 && /differs from the cost of the existing stock/.test(errorsOf(r5b)) && (await onHand(P)) === 160, r5b)
const r5c = await imp([line(1, P, 2, { unit_cost: '20.0000' })], { ...QTY, unit_cost: true })
ok('5. Unit Cost selected with the same cost: accepted', r5c.value?.ok && (await onHand(P)) === 162 && (await lotCost(P)) === 20, r5c)
const r6 = await imp([line(1, P, 3, { unit_cost: '' })], { ...QTY, unit_cost: true })
ok('6. a blank cost cell never erases: added at the existing ₹20, lot cost unchanged', r6.value?.ok && r6.value.additions[0].unit_cost === 20 && (await lotCost(P)) === 20, r6)
const r6b = await imp([line(1, P, 1, { unit_cost: 0 })], { ...QTY, unit_cost: true })
ok('6. a zero cost is refused (never stored as zero)', r6b.value?.ok === false && /greater than zero/.test(errorsOf(r6b)), r6b)
const vP = await valuation(P)
ok('10. valuation: 165 × ₹20 = ₹3,300 (existing method, one lot)', vP.status === 'VALUED' && vP.value === 3300 && (await onHand(P)) === 165, vP)

const NONE = await newProduct(null)
await manual([line(1, NONE, 50)])
const r8 = await imp([line(1, NONE, 5)])
ok('8. no cost on record: the addition stays pending (no cost, never zero), the stock stays not valued', r8.value?.ok && r8.value.additions[0].unit_cost === null
  && r8.value.additions[0].cost_source === 'PENDING' && (await valuation(NONE)).status === 'NOT_VALUED' && (await valuation(NONE)).unvalued === 55, r8)
const r8b = await imp([line(1, NONE, 1, { unit_cost: 9 })], { ...QTY, unit_cost: true })
ok('8. giving it a cost from Excel needs the existing opening cost override: refused without it', r8b.value?.ok === false && /cost override/.test(errorsOf(r8b)), r8b)

// ---------------------------------------------------------------------------
console.log('\nFields, units and validation')
const r7 = await imp([line(1, P, 1, { unit: 'KG' })])
ok('7. a different unit is refused, never combined (PCS stock + KG row)', r7.value?.ok === false && /does not match the product unit PCS/.test(errorsOf(r7)) && (await onHand(P)) === 165, r7)
const KG = await newProduct(5, { unit: 'KG' })
await manual([line(1, KG, 2.5, { unit: 'KG' })])
const r7b = await imp([line(1, KG, 1.25, { unit: 'KG' })])
ok('7. KG stock adds in KG: 2.5 + 1.25 = 3.75', r7b.value?.ok && (await onHand(KG)) === 3.75, r7b)
const kept = await imp([line(1, P, 9)], { quantity: false, unit_cost: false, remarks: false })
ok('Quantity not selected: the matched row is reported as kept, nothing added', kept.value?.ok && kept.value.kept?.[0]?.line_no === 1 && kept.value.additions.length === 0 && (await onHand(P)) === 165, kept)
const rem = await imp([line(1, P, 1, { notes: 'Found in rack 4' })], { ...QTY, remarks: true })
ok('Remarks selected: the Excel remark goes on the addition entry', rem.value?.ok
  && (await val(`select notes from public.inventory_transactions where reference_type = 'OPENING_ADDITION' and product_id = $1 order by created_at desc limit 1`, [P])) === 'Found in rack 4', rem)
const noRem = await imp([line(1, P, 1, { notes: 'not used' })])
ok('Remarks not selected: no remark is written', noRem.value?.ok
  && (await val(`select notes from public.inventory_transactions where reference_type = 'OPENING_ADDITION' and product_id = $1 order by created_at desc limit 1`, [P])) === null, noRem)

const NEW2 = await newProduct(4)
const mixed = await imp([line(1, NEW2, 3), line(2, P, 1, { unit: 'KG' }), line(3, P, -2)])
ok('one invalid row: nothing is posted at all, every failing row reported with its reason', mixed.value?.ok === false
  && mixed.value.errors.map((e) => e.line_no).join() === '2,3' && (await onHand(NEW2)) === 0 && (await onHand(P)) === 167
  && (await val(`select count(*)::int from public.inventory_opening_lines where product_id = $1`, [NEW2])) === 0, mixed)

const PEND = await newProduct(6)
const staged = await request('op', `select public.inventory_submit_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, PEND, 5)])])
const rp = await imp([line(1, PEND, 2)])
ok('a record awaiting approval is not added to: refused with its OS number', rp.value?.ok === false
  && errorsOf(rp).includes('awaiting approval') && errorsOf(rp).includes(String(staged.value?.document_number)), rp)

// ---------------------------------------------------------------------------
console.log('\nRetry, ledger and security')
const key = crypto.randomUUID()
const first = await imp([line(1, P, 10)], QTY, { key })
const retry = await imp([line(1, P, 10)], QTY, { key })
ok('9. a retried import (same request) does not add twice: 167 + 10 = 177', first.value?.ok && JSON.stringify({ ...retry.value, duplicate: undefined }) === JSON.stringify(first.value) && retry.value.duplicate === true && (await onHand(P)) === 177, { first, retry })

let consistent = true
for (const id of [NEW, P, NEWDUP, BATCH, NONE, KG]) if ((await onHand(id)) !== (await ledger(id))) consistent = false
ok('10. balances equal the ledger for every product touched', consistent)
const summary = await op(`select public.inventory_stock_value_summary(null, 'OA-')`)
const report = await op(`select coalesce(sum(value), 0)::float8 from public.inventory_valuation() where sku like 'OA-%'`)
ok('10. the value summary equals the stock valuation report', Number(summary.total_value) === report && report > 0, { summary, report })

const other = await imp([line(1, P, 1)], QTY, { user: 'b_op' })
ok('11. another company cannot add to these records', other.value?.ok === false || Boolean(other.error), other)
const otherSee = await request('b_op', `select public.opening_stock_import_matches($1::uuid[])`, [[P]])
ok('11. another company sees none of these records in the preview lookup', otherSee.error || JSON.stringify(otherSee.value) === '[]', otherSee)
const stagedMode = await imp([line(1, P, 1)], QTY, { post: false })
ok('11. submit-for-approval mode: additions refused (they post at once)', stagedMode.value?.ok === false && /cannot be staged/.test(errorsOf(stagedMode)), stagedMode)
const sodSet = (on) => val(`insert into public.company_settings (company_id, setting_key, setting_value) values ($1, 'inventory.segregation_of_duties', $2::jsonb)
  on conflict (company_id, setting_key) do update set setting_value = excluded.setting_value returning 1`, [A, String(on)])
await sodSet(true)
const sod = await imp([line(1, P, 1)])
ok('11. with segregation of duties on, additions are refused (they need the posting permission)', sod.value?.ok === false && /needs permission to post/.test(errorsOf(sod)) && (await onHand(P)) === 177, sod)
await sodSet(false)
ok('11. the private helper is not callable by users; anon cannot import',
  !(await val(`select has_function_privilege('authenticated', 'private.opening_added_quantity(uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.inventory_import_opening_stock(jsonb, jsonb, boolean, text, text, uuid)', 'EXECUTE')`)))
const legacyNow = await manual([line(1, P, 1)])
ok('manual entry is unchanged: a second opening balance is still refused there', legacyDup.value?.ok === false && legacyNow.value?.ok === false && /already exists/.test(errorsOf(legacyNow)), legacyNow)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database)')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback drops the import functions', !(await val(`select exists (select 1 from pg_proc where proname in ('inventory_import_opening_stock', 'opening_stock_import_matches', 'opening_added_quantity', 'opening_addition_cost_error'))`)))
ok('rollback keeps the added stock in the ledger', (await onHand(P)) === 177 && (await ledger(P)) === 177)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
const re = await imp([line(1, P, 3)])
ok('the migration applies again and continues from the same quantity (177 + 3)', re.value?.ok && re.value.additions[0].previous_quantity === 177 && (await onHand(P)) === 180, re)
ok('every later migration still applies on top', await (async () => { for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f))); return true })())

console.log(`${failed === 0 ? '✓' : '✗'} opening import additive check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
