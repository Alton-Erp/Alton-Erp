// Rollback / roll-forward check of 20261113090000_force_reset_direct.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261113090000_force_reset_direct.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const yes = async (sql) => (await db.query(`select (${sql}) as ok`)).rows[0].ok === true
const previewSrc = `(select prosrc from pg_proc where proname = 'erp_force_reset_preview')`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Force reset (direct): rollback / roll-forward')
check('migration applied', await yes(`exists (select 1 from pg_proc where proname = 'erp_force_reset_now') and ${previewSrc} not like '%erp_force_reset_active_approval%'`))

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: direct function removed; preview requires approval and backup again',
  await yes(`not exists (select 1 from pg_proc where proname = 'erp_force_reset_now')
    and ${previewSrc} like '%erp_force_reset_active_approval%' and ${previewSrc} like '%erp_force_reset_valid_backup%'`))
check('rollback: the earlier approval path is intact', await yes(`exists (select 1 from pg_proc where proname = 'erp_force_reset_execute')`))

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', await yes(`exists (select 1 from pg_proc where proname = 'erp_force_reset_now')`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'force_reset_direct_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /FORCE_RESET_DIRECT_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
