// Rollback / roll-forward check of 20261112090000_invoice_dispatch_policy.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261112090000_invoice_dispatch_policy.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]
const yes = async (sql) => (await one(`select (${sql}) as ok`)).ok === true
const FUNCTIONS = `('invoice_dispatch_status', 'invoice_dispatch_exceptions', 'invoice_dispatch_guard', 'dispatch_reversal_guard',
  'invoice_dispatch_lines', 'so_line_dispatch_open', 'fulfilment_line_dispatch_open')`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Dispatch before invoice posting: rollback / roll-forward')
check('migration applied', await yes(`(select count(*) from pg_proc where proname in ${FUNCTIONS}) = 7
  and exists (select 1 from pg_trigger where tgname = 'sales_invoices_dispatch_guard')`))
const before = await one(`select (select count(*) from public.products)::int p, (select count(*) from public.sales_invoices)::int i`)

// Rollbacks run newest first: 20261115 (partial invoicing) redefines functions of this migration.
await db.exec(await read('supabase', 'rollback', '20261115090000_partial_invoicing_down.sql'))
await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: rule triggers and functions removed',
  await yes(`not exists (select 1 from pg_proc where proname in ${FUNCTIONS})
    and not exists (select 1 from pg_trigger where tgname in ('sales_invoices_dispatch_guard', 'fulfilment_lines_dispatch_reversal_guard'))`))
check('rollback: the product classification column is kept (operator data)',
  await yes(`exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'inventory_tracked')`))
check('rollback: the original invoice issue functions are untouched',
  await yes(`exists (select 1 from pg_proc where proname = 'invoice_v2_issue_core') and exists (select 1 from pg_proc where proname = 'sales_invoice_v2_issue')`))
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
const after = await one(`select (select count(*) from public.products)::int p, (select count(*) from public.sales_invoices)::int i`)
check('rollback: no data changed', after.p === before.p && after.i === before.i)

await db.exec(await read('supabase', 'migrations', MIGRATION))
await db.exec(await read('supabase', 'migrations', '20261115090000_partial_invoicing.sql'))
check('roll forward: migration applies again', await yes(`exists (select 1 from pg_trigger where tgname = 'sales_invoices_dispatch_guard')`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'invoice_dispatch_policy_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /INVOICE_DISPATCH_POLICY_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
