// Proves the manual rollback of the ERP reset migration works and that the
// migration can be applied again afterwards, on PGlite.
//
//   npm run test:db:rollback
//
// 1. apply all migrations   2. apply supabase/rollback/20261030090000_erp_reset_down.sql
// 3. check: functions and permission gone, history table kept, RLS intact,
//    no business data touched   4. apply the migration again and check it works

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261030090000_erp_reset.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]
const fnCount = `select count(*)::int n from pg_proc where proname like 'erp\\_reset\\_%'`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
// Migrations up to and including this one: later migrations (the force reset)
// must be rolled back first, see supabase/rollback/.
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql') && x <= MIGRATION).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('ERP reset rollback / roll-forward')
check('migration applied: 15 reset functions and the permission', (await one(fnCount)).n === 15
  && (await one(`select count(*)::int n from public.permissions where code = 'system.reset_data'`)).n === 1)

await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code) values ('e7e5eb00-0000-4000-8000-0000000000a1', 'Rollback Co', 'Rollback Co', 'ERRB');
  insert into public.customers (company_id, customer_code, customer_name) values ('e7e5eb00-0000-4000-8000-0000000000a1', 'RB-C1', 'Rollback customer');`)
const before = await one(`select count(*)::int n from public.customers`)

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: no reset function remains', (await one(fnCount)).n === 0)
check('rollback: permission and its grants removed',
  (await one(`select count(*)::int n from public.permissions where code = 'system.reset_data'`)).n === 0)
check('rollback: reset history table kept', (await one(`select to_regclass('public.erp_reset_runs') is not null ok`)).ok === true)
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
check('rollback: no business data changed', (await one(`select count(*)::int n from public.customers`)).n === before.n)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', (await one(fnCount)).n === 15
  && (await one(`select count(*)::int n from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
                 join public.roles r on r.id = rp.role_id where p.code = 'system.reset_data' and r.code = 'SUPER_ADMIN'`)).n === 1)
check('roll forward: the preview logic runs (fixture company can be reset)',
  (await one(`select (private.erp_reset_plan('e7e5eb00-0000-4000-8000-0000000000a1') ->> 'can_reset')::boolean ok`)).ok === true)

console.log(failed === 0 ? '✓ ERP reset rollback check passed' : `✗ ERP reset rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
