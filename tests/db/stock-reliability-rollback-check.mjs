// Rollback / roll-forward check of 20261111090000_stock_register_reliability.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261111090000_stock_register_reliability.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]
const yes = async (sql) => (await one(`select (${sql}) as ok`)).ok === true

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Stock register / reliability rollback / roll-forward')
check('migration applied', await yes(`to_regclass('public.production_order_requests') is not null and exists (select 1 from pg_proc where proname = 'inventory_reconciliation')`))
const before = await one(`select count(*)::int n from public.products`)

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: functions, trigger and request table removed',
  await yes(`to_regclass('public.production_order_requests') is null
    and not exists (select 1 from pg_proc where proname in ('inventory_stock_position', 'inventory_stock_position_detail', 'inventory_reconciliation',
      'stock_position', 'open_production_statuses', 'production_order_record_request'))
    and not exists (select 1 from pg_trigger where tgname = 'production_orders_record_request')`))
check('rollback: idempotency_begin is the original again (no duplicate logging, no request settings)',
  await yes(`(select prosrc not like '%duplicate_returned%' and prosrc not like '%app.request_id%' from pg_proc where proname = 'idempotency_begin')`))
check('rollback: ERP reset list back to 78 tables', (await one(`select count(*)::int n from private.erp_reset_tables()`)).n === 78)
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
check('rollback: no data changed', (await one(`select count(*)::int n from public.products`)).n === before.n)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', await yes(`to_regclass('public.production_order_requests') is not null`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'stock_reliability_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /STOCK_RELIABILITY_VERIFICATION_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
