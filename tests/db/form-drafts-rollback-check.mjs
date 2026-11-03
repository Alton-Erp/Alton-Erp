// Rollback / roll-forward check of 20261117090000_form_drafts.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261117090000_form_drafts.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const yes = async (sql) => (await db.query(`select (${sql}) as ok`)).rows[0].ok === true
const fnCount = `(select count(*) from pg_proc where proname like 'erp_form_draft%')`
const resetSrc = `(select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and proname = 'erp_reset_tables')`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Form drafts: rollback / roll-forward')
check('migration applied', await yes(`${fnCount} = 9 and to_regclass('public.erp_form_drafts') is not null and ${resetSrc} like '%erp_form_drafts%'`))
const counts = `select (select count(*) from public.companies)::int c, (select count(*) from public.profiles)::int p, (select count(*) from public.purchase_orders)::int po`
const before = (await db.query(counts)).rows[0]

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: draft table and functions removed', await yes(`${fnCount} = 0 and to_regclass('public.erp_form_drafts') is null`))
check('rollback: ERP reset list restored (79 tables, no drafts)',
  await yes(`(select count(*) from private.erp_reset_tables()) = 79 and ${resetSrc} not like '%erp_form_drafts%'`))
const after = (await db.query(counts)).rows[0]
check('rollback: no ERP data changed', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', await yes(`${fnCount} = 9 and to_regclass('public.erp_form_drafts') is not null`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'form_drafts_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /FORM_DRAFTS_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
