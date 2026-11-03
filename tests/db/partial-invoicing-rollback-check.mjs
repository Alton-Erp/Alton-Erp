// Rollback / roll-forward check of 20261115090000_partial_invoicing.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261115090000_partial_invoicing.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const yes = async (sql) => (await db.query(`select (${sql}) as ok`)).rows[0].ok === true
const src = (fn) => `(select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = '${fn}')`
const NEW = `('sales_invoice_tracking', 'invoice_partial_preview', 'sales_order_line_release_pending', 'so_invoice_tracking_lines', 'invoice_dispatch_on_posting',
  'invoice_partial_notice', 'notify_super_admins', 'so_line_posted_invoiced', 'so_line_released', 'invoice_order_lines')`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Partial invoicing: rollback / roll-forward')
check('migration applied', await yes(`(select count(*) from pg_proc where proname in ${NEW}) = 10 and ${src('sales_invoice_v2_issue')} like '%invoice_dispatch_on_posting%'`))
const before = (await db.query(`select (select count(*) from public.sales_invoices)::int i, (select count(*) from public.inventory_transactions)::int t`)).rows[0]

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: new functions removed', await yes(`not exists (select 1 from pg_proc where proname in ${NEW})`))
check('rollback: invoice posting restored (no dispatch on posting, no partial notice)',
  await yes(`${src('sales_invoice_v2_issue')} not like '%dispatch_on_posting%' and ${src('sales_invoice_v2_issue')} like '%invoice_v2_issue_core%'`))
check('rollback: dispatch status restored (no DISPATCH_ON_POSTING)', await yes(`${src('invoice_dispatch_status')} not like '%DISPATCH_ON_POSTING%'`))
check('rollback: the dispatch-before-posting trigger is still in place', await yes(`exists (select 1 from pg_trigger where tgname = 'sales_invoices_dispatch_guard')`))
const after = (await db.query(`select (select count(*) from public.sales_invoices)::int i, (select count(*) from public.inventory_transactions)::int t`)).rows[0]
check('rollback: no invoices or stock entries changed', after.i === before.i && after.t === before.t)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', await yes(`(select count(*) from pg_proc where proname in ${NEW}) = 10`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'partial_invoicing_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /PARTIAL_INVOICING_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
