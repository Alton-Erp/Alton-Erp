// Opening stock without a source field (no migration): database checks.
//
//   npm run test:db:opening-stock
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

// Opening stock without a user-chosen source. No migration: the app derives the
// source from the product master (openingStockSource) and the existing functions
// are unchanged. This proves they accept that, post the right quantities, and
// that retries and repeats never create a second opening balance.
const company = await id('company_a')
const loc = await id('g1')
// Product Master Cost ₹100: opening stock is priced at it on the server (migrations 20261129090000 / 20261130090000).
const newProduct = (sku, type, source, unit = 'PCS') => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost)
  values ($1, $2, $2, $3, $4, $5, 'ACTIVE', 100) returning id`, [company, sku, type, source, unit])
const FG = await newProduct('OS-FG-1', 'FINISHED_GOOD', 'IN_HOUSE')
const RM = await newProduct('OS-RM-1', 'RAW_MATERIAL', 'OUTSOURCED', 'KGS')
const HY = await newProduct('OS-HY-1', 'FINISHED_GOOD', 'HYBRID')
const today = await owner(`select private.company_today($1)::text`, [company])
// Same rule as openingStockSource() in src/features/inventory/opening-import.ts.
const derived = { [FG]: 'IN_HOUSE', [RM]: 'OUTSOURCED', [HY]: 'IN_HOUSE' }
const units = { [FG]: 'PCS', [RM]: 'KGS', [HY]: 'PCS' }
const line = (n, product, qty, extra = {}) => ({ line_no: n, product_id: product, location_id: loc, source_type: derived[product], quantity: qty, unit: units[product], unit_cost: 100, effective_date: today, reference: 'CS-1', ...extra })

const snapshot = () => owner(`select coalesce(jsonb_agg(to_jsonb(b) - 'updated_at' order by b.id), '[]') from public.inventory_balances b where b.company_id = $1 and b.product_id not in ($2, $3, $4)`, [company, FG, RM, HY])
const txCount = () => owner(`select count(*)::int from public.inventory_transactions where company_id = $1`, [company])
const onHand = (pid) => owner(`select coalesce(jsonb_agg(jsonb_build_object('src', source_type, 'qty', on_hand::float8) order by source_type), '[]') from public.inventory_balances where product_id = $1 and location_id = $2 and on_hand <> 0`, [pid, loc])
const otherBefore = JSON.stringify(await snapshot())
const txBefore = await txCount()

// The database still requires a source on each line: that is why the app derives one rather than sending none.
const missing = await request('op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([{ ...line(1, FG, 5), source_type: undefined }])])
ok('a line with no source is refused by the unchanged database validation (so the app supplies one)', !missing.error && missing.value?.ok === false && JSON.stringify(missing.value.errors).includes('Source type'), missing)

const key = '0b6d1c1e-0000-4000-8000-00000000a001'
const post = () => request('op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, 'go-live count', $2::uuid)`, [JSON.stringify([line(1, FG, 12), line(2, RM, 7.5), line(3, HY, 3)]), key])
const first = await post()
ok('opening stock with derived sources posts', !first.error && first.value?.ok === true && first.value?.status === 'POSTED', first.error ?? first.value)
ok('   the IN_HOUSE product holds 12 as In-House stock', JSON.stringify(await onHand(FG)) === JSON.stringify([{ qty: 12, src: 'IN_HOUSE' }]), await onHand(FG))
ok('   the OUTSOURCED product holds 7.5 as Outsourced stock', JSON.stringify(await onHand(RM)) === JSON.stringify([{ qty: 7.5, src: 'OUTSOURCED' }]), await onHand(RM))
ok('   the HYBRID finished good holds 3 as In-House stock', JSON.stringify(await onHand(HY)) === JSON.stringify([{ qty: 3, src: 'IN_HOUSE' }]), await onHand(HY))
ok('   nothing is stored as UNKNOWN (no "unverified source" flag)', (await owner(`select count(*)::int from public.inventory_opening_lines where product_id in ($1, $2, $3) and source_type = 'UNKNOWN'`, [FG, RM, HY])) === 0)
ok('   exactly three OPENING_STOCK movements', (await txCount()) === txBefore + 3 && (await owner(`select count(*)::int from public.inventory_transactions where product_id in ($1, $2, $3) and transaction_type = 'OPENING_STOCK'`, [FG, RM, HY])) === 3)
ok('   opening stock audit entry recorded', (await owner(`select count(*)::int from public.audit_logs where action = 'inventory.opening_submitted' and metadata ->> 'document_number' = $1`, [first.value?.document_number])) === 1)

const retry = await post()
ok('retrying with the same request key returns the same document and posts nothing more', !retry.error && retry.value?.document_number === first.value?.document_number && (await txCount()) === txBefore + 3, retry.error ?? retry.value)
const again = await request('op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, FG, 4)])])
ok('a second opening balance for the same product and location is rejected, nothing posted', !again.error && again.value?.ok === false && JSON.stringify(again.value.errors).includes('already exists') && (await txCount()) === txBefore + 3, again.error ?? again.value)
ok('   balances unchanged after the rejected attempt', JSON.stringify(await onHand(FG)) === JSON.stringify([{ qty: 12, src: 'IN_HOUSE' }]))

ok('stock balances of every other product are unchanged', JSON.stringify(await snapshot()) === otherBefore)
ok('no goods receipt, production, transfer or adjustment movement was created', (await owner(`select count(*)::int from public.inventory_transactions where product_id in ($1, $2, $3) and transaction_type <> 'OPENING_STOCK'`, [FG, RM, HY])) === 0)

console.log(`${failed === 0 ? '✓' : '✗'} opening stock check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
