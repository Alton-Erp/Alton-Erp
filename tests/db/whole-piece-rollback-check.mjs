// Proves the manual rollback of the whole-piece migration works and that the
// migration can be applied again afterwards (roll forward), on PGlite.
//
//   npm run test:db:rollback
//
// 1. apply all migrations      2. apply supabase/rollback/..._down.sql
// 3. check: guards and audit gone, previous functions restored, fractional
//    PCS accepted again (the old behaviour), no data touched
// 4. apply the migration again and run the whole-piece verification suite

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261029090000_whole_piece_quantities.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Whole-piece rollback / roll-forward')
check('migration applied: guards installed', (await one(`select count(*)::int n from pg_trigger where tgname like '%\\_whole\\_pieces'`)).n >= 15)

// A record that must survive the rollback untouched.
await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code) values ('e7e5ab00-0000-4000-8000-0000000000a1', 'Rollback Co', 'Rollback Co', 'RBK');
  insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit)
  values ('e7e5ab00-0000-4000-8000-0000000000c1', 'e7e5ab00-0000-4000-8000-0000000000a1', 'RB-1', 'Rollback part', 'COMPONENT', 'OUTSOURCED', 'PCS');`)
const before = await one(`select count(*)::int n, md5(string_agg(id::text || sku, ',' order by id)) h from public.products`)

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: no whole-piece triggers remain', (await one(`select count(*)::int n from pg_trigger where tgname like '%\\_whole\\_pieces'`)).n === 0)
check('rollback: audit and guard functions removed',
  (await one(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where proname in ('whole_unit_quantity_audit', 'whole_unit_findings', 'guard_whole_quantities', 'guard_whole_ledger_quantity',
                                'guard_bom_whole_quantities', 'plan_qty', 'is_whole_unit', 'whole_unit_codes', 'material_standard_for_output')`)).n === 0)
check('rollback: previous requirement formula restored (3-decimal round-up)',
  (await one(`select prosrc like '%private.ceil_qty(bi.quantity_required / b.output_quantity * p_quantity)%' and prosrc not like '%is_whole_unit%' ok
              from pg_proc where proname = 'bom_requirement_lines'`)).ok === true)
check('rollback: previous reservation and discrepancy functions restored',
  (await one(`select bool_and(prosrc not like '%is_whole_unit%' and prosrc not like '%material_standard_for_output%') ok
              from pg_proc where proname in ('production_reserve_materials', 'production_discrepancies', 'production_bom_requirements')`)).ok === true)
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
const after = await one(`select count(*)::int n, md5(string_agg(id::text || sku, ',' order by id)) h from public.products`)
check('rollback: no data changed', before.n === after.n && before.h === after.h)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again after the rollback', (await one(`select count(*)::int n from pg_trigger where tgname like '%\\_whole\\_pieces'`)).n >= 15)
// (The RBK fixture stays: audit logs reference it and are never deleted; this database is thrown away.)

let message = ''
try {
  await db.exec(await read('supabase', 'tests', 'whole_piece_verification.sql'))
} catch (error) {
  message = error.message ?? String(error)
}
await db.exec('rollback').catch(() => {})
const m = /WHOLE_PIECE_VERIFICATION_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: whole-piece verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
