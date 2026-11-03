// Proves the manual rollback of the force-reset migration works, restores the
// guard functions EXACTLY, keeps the reset history, and that the migration
// can be applied again afterwards, on PGlite.
//
//   npm run test:db:rollback
//
// 1. reference database: all migrations before 20261031090000
// 2. test database: all migrations, then
//    supabase/rollback/20261031090000_erp_force_reset_down.sql
// 3. compare guard functions and the standard reset list with the reference;
//    check history kept, RLS intact, no business data touched, standard reset
//    still classifies every table
// 4. apply the migration again and check it works

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261031090000_erp_force_reset.sql'
const GUARDS = ['prevent_ledger_mutation', 'prevent_history_mutation', 'prevent_import_history_mutation', 'prevent_approval_decision_mutation',
  'guard_posted_document', 'guard_bom_write', 'guard_bom_item_write', 'guard_invoice_change', 'guard_invoice_line_change',
  'guard_payment_change', 'guard_note_change', 'erp_reset_tables']
const migrations = (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()

async function database(files) {
  const db = new PGlite()
  await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
  for (const f of files) await db.exec(await read('supabase', 'migrations', f))
  return db
}
const definitions = async (db) => Object.fromEntries((await db.query(
  `select p.proname, p.prosrc || '|' || p.provolatile::text || '|' || p.prosecdef::text as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = any($1)`, [GUARDS])).rows.map((r) => [r.proname, r.def]))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}

console.log('ERP force reset rollback / roll-forward')
const reference = await database(migrations.filter((f) => f < MIGRATION))
const before = await definitions(reference)
await reference.close()

const db = await database(migrations)
const one = async (sql) => (await db.query(sql)).rows[0]
const fnCount = `select count(*)::int n from pg_proc where proname like 'erp\\_force\\_%'`
const forceFns = (await one(fnCount)).n
check('migration applied: force-reset functions present and guards carry the exemption', forceFns >= 20
  && Object.values(await definitions(db)).filter((d) => d.includes('erp_force_purge_allows')).length === 11, `functions=${forceFns}`)

await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code) values ('e7e5eb00-0000-4000-8000-0000000000a2', 'Rollback Co', 'Rollback Co', 'FRRB');
  insert into public.customers (company_id, customer_code, customer_name) values ('e7e5eb00-0000-4000-8000-0000000000a2', 'RB-C1', 'Rollback customer');`)
const customers = (await one(`select count(*)::int n from public.customers`)).n

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: no force-reset function remains', (await one(fnCount)).n === 0)
const after = await definitions(db)
const changed = GUARDS.filter((g) => after[g] !== before[g])
check('rollback: the 11 guard functions and the standard reset list are byte-identical to before the migration', changed.length === 0, changed.join(', '))
check('rollback: private approval, ticket and purge-session tables removed',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'private' and c.relname in ('erp_force_reset_approvals', 'erp_force_reset_tickets', 'erp_force_purge_sessions')`)).n === 0)
check('rollback: reset history (with mode column) and backup records kept',
  (await one(`select to_regclass('public.erp_reset_backup_attestations') is not null
                 and exists (select 1 from information_schema.columns where table_name = 'erp_reset_runs' and column_name = 'mode') ok`)).ok === true)
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
check('rollback: no business data changed', (await one(`select count(*)::int n from public.customers`)).n === customers)
check('rollback: the standard reset still classifies every table (fixture company can be reset)',
  (await one(`select (private.erp_reset_plan('e7e5eb00-0000-4000-8000-0000000000a2') ->> 'can_reset')::boolean ok`)).ok === true)
let refused = false
try {
  await db.exec(`insert into public.import_jobs (company_id, import_type, client_job_key, status) values ('e7e5eb00-0000-4000-8000-0000000000a2', 'PRODUCTS', gen_random_uuid(), 'COMPLETED');
                 delete from public.import_jobs where company_id = 'e7e5eb00-0000-4000-8000-0000000000a2';`)
} catch (e) {
  refused = /append-only/.test(e.message)
}
check('rollback: append-only guards still refuse deletes', refused)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again', (await one(fnCount)).n === forceFns)
check('roll forward: the force-reset plan runs (fixture company, no blockers)',
  (await one(`select jsonb_array_length(private.erp_force_reset_plan('e7e5eb00-0000-4000-8000-0000000000a2') -> 'blockers') = 0 ok`)).ok === true)

console.log(failed === 0 ? '✓ ERP force reset rollback check passed' : `✗ ERP force reset rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
