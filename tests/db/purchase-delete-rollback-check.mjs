// Rollback check for 20261126090000_purchase_permanent_delete.sql
//
//   npm run test:db:rollback   (part of it)
//
// 1. Database A: migrations before 20261126 → the definitions the rollback must restore.
// 2. Database B: every migration, then the rollback script → the five replaced functions equal A's,
//    the six added functions are gone, and the department functions still work.
// 3. Database B: the migration applied again, twice (idempotent) → the same definitions as the first run.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = '20261126090000_purchase_permanent_delete.sql'
const ROLLBACK = path.join(root, 'supabase', 'rollback', '20261126090000_purchase_permanent_delete_down.sql')
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()

async function database(upTo) {
  const db = new PGlite()
  await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
  for (const f of files.filter((x) => !upTo || x < upTo)) await db.exec(await read(path.join(migDir, f)))
  return db
}
// Every department function (definition and grants), keyed by its full signature.
const defs = async (db) => Object.fromEntries((await db.query(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) d, coalesce(p.proacl::text, '') acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'private' and p.proname like 'dept\\_%') or (n.nspname = 'public' and p.proname like 'department\\_data\\_%')
  order by 1`)).rows.map((r) => [r.sig, `${r.d}\n-- acl ${r.acl}`]))
const ADDED = ['private.dept_plan(uuid,text,text,text[],text[])', 'private.dept_root_info(text,text)', 'private.dept_preview(text,text,text[],text[])',
  'private.dept_execute(text,text,text[],text,text,uuid,uuid,text[])', 'department_data_preview_records(text,text,text[],text[])',
  'department_data_execute_records(text,text,text[],text,text,uuid,uuid,text[])']
const REPLACED = ['private.dept_categories()', 'private.dept_row_label(text,text)', 'private.dept_plan(uuid,text,text,text[])',
  'department_data_preview(text,text,text[])', 'department_data_execute(text,text,text[],text,text,uuid,uuid)']

let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`); if (!cond) failed++ }

const a = await database(MIGRATION)
const before = await defs(a)
const b = await database(null)
const forward = await defs(b)
ok('forward: the six functions are added', ADDED.every((f) => f in forward && !(f in before)), ADDED.filter((f) => !(f in forward)).join(', '))
ok('forward: the five replaced functions changed', REPLACED.every((f) => forward[f] && forward[f] !== before[f]), REPLACED.filter((f) => forward[f] === before[f]).join(', '))
ok('forward: no other department function changed', Object.keys(before).filter((f) => !REPLACED.includes(f)).every((f) => forward[f] === before[f]),
  Object.keys(before).filter((f) => !REPLACED.includes(f) && forward[f] !== before[f]).join(', '))

await b.exec(await read(ROLLBACK))
const after = await defs(b)
for (const f of REPLACED) ok(`rollback restores ${f} exactly (definition and grants)`, after[f] === before[f])
ok('rollback removes the six added functions and leaves no other difference', JSON.stringify(after) === JSON.stringify(before),
  Object.keys({ ...after, ...before }).filter((f) => after[f] !== before[f]).join(', '))
const cats = (await b.query(`select count(*)::int n from private.dept_categories() where department = 'PURCHASE'`)).rows[0].n
ok('after the rollback the Purchase department has its original single category', cats === 1, String(cats))

await b.exec(await read(path.join(migDir, MIGRATION)))
await b.exec(await read(path.join(migDir, MIGRATION)))
ok('the migration applies again, twice (idempotent), with the same definitions as the first run', JSON.stringify(await defs(b)) === JSON.stringify(forward),
  Object.keys(forward).filter((f) => forward[f] !== (null)).length)

console.log(`${failed === 0 ? '✓' : '✗'} purchase permanent delete rollback check ${failed === 0 ? 'passed' : `failed (${failed})`}`)
process.exit(failed === 0 ? 0 : 1)
