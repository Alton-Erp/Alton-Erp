// Stock valuation for the Total Stock drill-down (migration 20261125090000): database checks.
//
//   npm run test:db:stock-value
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

// Stock valuation of the Total Stock drill-down (migration 20261125090000).
// Every figure is compared with the existing stock report valuation (inventory_valuation,
// management_overview "valued at"), never with a separately worked-out cost.
const company = await id('company_a')
const g1 = await id('g1')
const wh = await id('w1')
await db.exec(`insert into public.inventory_locations (company_id, warehouse_id, location_code, location_name, location_type) values ('${company}', '${wh}', 'SV-RACK', 'Valuation rack', 'RACK')`)
const rack = await owner(`select id from public.inventory_locations where location_code = 'SV-RACK' and warehouse_id = $1`, [wh])
const newProduct = (sku, extra = '') => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status${extra ? ', track_batches' : ''})
  values ($1, $2, $2 || ' product', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE'${extra ? ', true' : ''}) returning id`, [company, sku])
const receive = (pid, loc, qty, cost, source = 'OUTSOURCED', batch = null) =>
  op(`select public.inventory_post_receipt($1, $2, $3, $4, p_batch_number => $5, p_unit_cost => $6, p_idempotency_key => gen_random_uuid())`, [pid, loc, qty, source, batch, cost])

// 1. positive stock, known cost   2. zero stock   3. reserved   4. several batches   5. several locations   6. no cost / part cost
const KNOWN = await newProduct('SV-VALVE')         // 24 @ 500
const ZERO = await newProduct('SV-ZERO')           // received then fully issued
const RES = await newProduct('SV-RES')             // 10 @ 40, 3 reserved
const BATCH = await newProduct('SV-BATCH', 'batch') // B1 10 @ 100, B2 5 @ 130
const MULTI = await newProduct('SV-MULTI')         // 4 @ 50 in GENERAL, 6 @ 50 in SV-RACK
const NOCOST = await newProduct('SV-NOCOST')       // 7, no cost
const PART = await newProduct('SV-PART')           // 3 @ 20 in-house lot + 2 uncosted outsourced lot
const THIRD = await newProduct('SV-THIRD')         // 3 @ 33.3333 (full precision)
await receive(KNOWN, g1, 24, 500)
await receive(ZERO, g1, 2, 10)
await op(`select public.inventory_post_issue($1, $2, 2, p_reason => 'test', p_idempotency_key => gen_random_uuid())`, [ZERO, g1])
await receive(RES, g1, 10, 40)
await op(`select public.inventory_create_reservation($1, $2, 3, 'MANUAL', 'SV-R1', p_idempotency_key => gen_random_uuid())`, [RES, g1])
await receive(BATCH, g1, 10, 100, 'OUTSOURCED', 'B1')
await receive(BATCH, g1, 5, 130, 'OUTSOURCED', 'B2')
await receive(MULTI, g1, 4, 50)
await receive(MULTI, rack, 6, 50)
await receive(NOCOST, g1, 7, null)
await receive(PART, g1, 3, 20, 'IN_HOUSE')
await receive(PART, g1, 2, null, 'OUTSOURCED')
await receive(THIRD, g1, 3, 33.3333)

const row = async (pid, user = 'op') => (await request(user, `select to_jsonb(v) from public.inventory_product_stock_value v where product_id = $1`, [pid])).value
const n = (v) => (v === null || v === undefined ? null : Number(v))
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.0001
/** The stock report: inventory_valuation rows of the product, added up. */
const report = async (pid) => (await request('op', `select jsonb_build_object('value', sum(value), 'qty', sum(on_hand) filter (where unit_cost is not null), 'uncosted', count(*) filter (where unit_cost is null))
  from public.inventory_valuation() where product_id = $1`, [pid])).value

let r = await row(KNOWN)
ok('1. 24 PCS at ₹500: unit cost 500, value 12,000, fully valued', near(n(r.unit_cost), 500) && near(n(r.stock_value), 12000) && r.valuation_status === 'VALUED', r)
let rep = await report(KNOWN)
ok('   same value as the stock valuation report', near(n(rep.value), n(r.stock_value)), rep)

r = await row(ZERO)
ok('2. stock received then issued to zero: no stock, no value, not in the Total Stock list', n(r.on_hand) === 0 && r.stock_value === null && r.valuation_status === 'NO_STOCK', r)

r = await row(RES)
ok('3. reserved stock: on hand 10, reserved 3, available 7; value on everything on hand (10 × 40)', n(r.on_hand) === 10 && n(r.reserved) === 3 && n(r.available) === 7 && near(n(r.stock_value), 400), r)

r = await row(BATCH)
rep = await report(BATCH)
ok('4. two batches (10 @ 100, 5 @ 130): value 1,650 = sum of the lots, average cost 110', near(n(r.stock_value), 1650) && near(n(r.unit_cost), 110) && near(n(rep.value), 1650), { r, rep })
const lots = (await request('op', `select jsonb_agg(jsonb_build_object('cost', unit_cost, 'value', stock_value) order by unit_cost) from public.inventory_balance_value where product_id = $1`, [BATCH])).value
ok('   each batch keeps its own cost on the lot rows (100 and 130, not the average)', lots.length === 2 && near(n(lots[0].cost), 100) && near(n(lots[1].cost), 130) && near(n(lots[0].value), 1000) && near(n(lots[1].value), 650), lots)

r = await row(MULTI)
const locs = (await request('op', `select jsonb_agg(jsonb_build_object('loc', location_id, 'value', stock_value)) from public.inventory_balance_value where product_id = $1`, [MULTI])).value
ok('5. two locations (4 + 6 @ 50): value 500, each location valued 200 and 300', near(n(r.stock_value), 500) && n(r.on_hand) === 10 && locs.length === 2
  && near(n(locs.find((l) => l.loc === g1)?.value), 200) && near(n(locs.find((l) => l.loc === rack)?.value), 300), { r, locs })

r = await row(NOCOST)
ok('6. no cost recorded: Not Valued (unit cost and value empty, never 0)', r.unit_cost === null && r.stock_value === null && r.valuation_status === 'NOT_VALUED' && n(r.unvalued_on_hand) === 7, r)
r = await row(PART)
rep = await report(PART)
ok('   part costed (3 @ 20 + 2 uncosted): value 60, unit cost 20, 2 not valued', near(n(r.stock_value), 60) && near(n(r.unit_cost), 20) && r.valuation_status === 'PARTIAL' && n(r.unvalued_on_hand) === 2 && near(n(rep.value), 60), { r, rep })
r = await row(THIRD)
ok('   full precision: 3 @ 33.3333 gives unit cost 33.3333 and value 100.00 (lot value rounded to paise as in the reports)', near(n(r.unit_cost), 33.3333) && near(n(r.stock_value), 100), r)

// 7. Search and sorting by value, as the drill-down queries the view.
const sorted = (await request('op', `select jsonb_agg(sku order by stock_value desc nulls last, product_id) from public.inventory_product_stock_value
  where archived_at is null and on_hand <> 0 and sku like 'SV-%'`)).value
ok('7. sorted by stock value: highest first, Not Valued last', JSON.stringify(sorted) === JSON.stringify(['SV-VALVE', 'SV-BATCH', 'SV-MULTI', 'SV-RES', 'SV-THIRD', 'SV-PART', 'SV-NOCOST']), sorted)
const summary = async (unit = null, search = null, user = 'op') => (await request(user, `select public.inventory_stock_value_summary($1, $2)`, [unit, search])).value
const sv = await summary(null, 'sv-')
ok('   summary with a search adds up only the matching products', sv.products === 7 && near(Number(sv.total_value), 12000 + 400 + 1650 + 500 + 60 + 100)
  && sv.not_valued_products === 1 && sv.partly_valued_products === 1 && sv.valued_products === 5, sv)
const pcs = sv.units.find((u) => u.unit === 'PCS')
ok('   per-unit totals: on hand 24+10+15+10+7+5+3, reserved 3', Number(pcs.on_hand) === 74 && Number(pcs.reserved) === 3 && Number(pcs.available) === 71, sv.units)
ok('   search text with % and _ is literal', (await summary(null, 'SV_%')).products === 0 && (await summary(null, 'VALVE')).products === 1)
ok('   unit filter', (await summary('KGS', 'sv-')).products === 0)

// 8. The unfiltered total equals the stock reports and the Management Dashboard "valued at".
const all = await summary()
const listed = (await request('op', `select jsonb_build_object('n', count(*), 'v', coalesce(sum(stock_value), 0)) from public.inventory_product_stock_value where archived_at is null and on_hand <> 0`)).value
const repAll = (await request('op', `select coalesce(sum(v.value), 0) from public.inventory_valuation() v join public.products p on p.id = v.product_id where p.archived_at is null and v.value is not null`)).value
const mo = (await request('op', `select (public.management_overview(current_date - 30, current_date) -> 'inventory' ->> 'total_value')::numeric`)).value
ok('8. summary total = sum of the listed rows', all.products === listed.n && near(Number(all.total_value), Number(listed.v)), { all, listed })
ok('   = stock valuation report (inventory_valuation)', near(Number(all.total_value), Number(repAll)), { all: all.total_value, repAll })
ok('   = Management Dashboard "valued at" (management_overview)', near(Number(all.total_value), Number(mo)), { all: all.total_value, mo })

// 9. Company isolation and permission.
ok('9. company B sees none of company A\'s products or lot values', (await request('b_op', `select count(*)::int from public.inventory_product_stock_value where product_id = $1`, [KNOWN])).value === 0
  && (await request('b_op', `select count(*)::int from public.inventory_balance_value where product_id = $1`, [KNOWN])).value === 0)
const bs = await summary(null, 'SV-', 'b_op')
const bAll = await summary(null, null, 'b_op')
const bListed = (await request('b_op', `select coalesce(sum(stock_value), 0) from public.inventory_product_stock_value where archived_at is null and on_hand <> 0`)).value
ok("   company B summary: none of company A's products, and its total is only its own stock", bs.products === 0 && Number(bs.total_value) === 0 && near(Number(bAll.total_value), Number(bListed)), { bs, bAll, bListed })
const anon = await request(null, `set local role anon; select public.inventory_stock_value_summary(null, null)`)
ok('   not callable without signing in', Boolean(anon.error), anon)

// Read-only: nothing stored, nothing changed.
const before = await owner(`select md5(string_agg(to_jsonb(b)::text, ',' order by id)) from public.inventory_balances b`)
await summary(); await row(KNOWN)
ok('reading valuations changes no stock balance', (await owner(`select md5(string_agg(to_jsonb(b)::text, ',' order by id)) from public.inventory_balances b`)) === before)

// Rollback removes the objects; the migration applies again.
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261125090000_stock_valuation_drilldown_down.sql')))
ok('rollback removes the views and the function', (await owner(`select count(*)::int from pg_class where relname in ('inventory_product_stock_value', 'inventory_balance_value')`)) === 0
  && (await owner(`select count(*)::int from pg_proc where proname = 'inventory_stock_value_summary'`)) === 0)
ok('   stock balances unchanged by the rollback', (await owner(`select md5(string_agg(to_jsonb(b)::text, ',' order by id)) from public.inventory_balances b`)) === before)
await db.exec(await read(path.join(migDir, '20261125090000_stock_valuation_drilldown.sql')))
await db.exec(await read(path.join(migDir, '20261125090000_stock_valuation_drilldown.sql')))
ok('the migration applies again, twice', near(n((await row(KNOWN)).stock_value), 12000))

console.log(`${failed === 0 ? '✓' : '✗'} stock valuation check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
