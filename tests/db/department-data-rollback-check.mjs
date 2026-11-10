// Rollback check for 20261119090000_department_data_management.sql
//
//   npm run test:db:rollback   (part of it)
//
// 1. Database A: migrations before 20261119 → the definitions the rollback must restore.
// 2. Database B: every migration, then the rollback script → the eight changed functions equal A's,
//    the department functions and session tables are gone, the run-mode check is the original one.
// 3. Database B: the migration applied again, twice (idempotent) → the feature is back.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = '20261119090000_department_data_management.sql'
const ROLLBACK = path.join(root, 'supabase', 'rollback', '20261119090000_department_data_management_down.sql')
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()

async function database(upTo) {
  const db = new PGlite()
  await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
  // Migrations that build on this one (20261126 purchase permanent delete) are rolled back before it,
  // so they are not part of this check.
  for (const f of files.filter((x) => (!upTo || x < upTo) && x < '20261126')) await db.exec(await read(path.join(migDir, f)))
  return db
}
const FUNCTIONS = ['prevent_history_mutation', 'guard_bom_write', 'guard_bom_item_write', 'guard_product_version', 'guard_invoice_change',
  'guard_invoice_line_change', 'guard_note_change', 'production_material_removed']
const defs = async (db) => Object.fromEntries(await Promise.all(FUNCTIONS.map(async (f) => [f,
  (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = $1`, [f])).rows[0]?.d])))
const feature = async (db) => (await db.query(`select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'department\\_data\\_%')
     or (n.nspname = 'private' and p.proname like 'dept\\_%'))::int fns,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname like 'dept\\_purge\\_%' and c.relkind = 'r')::int tabs,
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'erp_reset_runs_mode_check') mode_check,
  (select count(*) from pg_constraint where conname = 'erp_reset_runs_department_check')::int dept_check`)).rows[0]

let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`); if (!cond) failed++ }

const a = await database(MIGRATION)
const before = await defs(a)
const beforeFeature = await feature(a)
const b = await database(null)
const forward = await feature(b)
ok('forward: 4 public + 11 private functions, 2 session tables, DEPARTMENT mode', forward.fns === 15 && forward.tabs === 2 && /DEPARTMENT/.test(forward.mode_check) && forward.dept_check === 1,
  JSON.stringify(forward))
const fwdDefs = await defs(b)
// The added block starts at its comment and ends at the first "  end if;" line after it.
const strip = (d) => {
  const lines = d.split('\n')
  const start = lines.findIndex((l) => l.startsWith('  -- Department data management (20261119090000)'))
  if (start < 0) return d
  const end = lines.findIndex((l, i) => i > start && l === '  end if;')
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
}
ok('forward: each changed function equals the original except for the one added check', FUNCTIONS.every((f) => fwdDefs[f] !== before[f] && strip(fwdDefs[f]) === before[f]),
  FUNCTIONS.filter((f) => strip(fwdDefs[f]) !== before[f]).join(', '))

await b.exec(await read(ROLLBACK))
const after = await defs(b)
for (const f of FUNCTIONS) ok(`rollback restores private.${f} exactly`, after[f] === before[f])
const back = await feature(b)
ok('rollback removes the department functions and session tables', back.fns === 0 && back.tabs === 0, JSON.stringify(back))
ok('rollback restores the original run-mode check', back.mode_check === beforeFeature.mode_check && back.dept_check === 0, `${back.mode_check} vs ${beforeFeature.mode_check}`)

await b.exec(await read(path.join(migDir, MIGRATION)))
await b.exec(await read(path.join(migDir, MIGRATION)))
const again = await feature(b)
ok('the migration applies again, twice (idempotent)', again.fns === 15 && again.tabs === 2 && /DEPARTMENT/.test(again.mode_check) && again.dept_check === 1, JSON.stringify(again))
ok('changed functions are the same as after the first forward run', JSON.stringify(await defs(b)) === JSON.stringify(fwdDefs))

console.log(`${failed === 0 ? '✓' : '✗'} department data management rollback check ${failed === 0 ? 'passed' : `failed (${failed})`}`)
process.exit(failed === 0 ? 0 : 1)
