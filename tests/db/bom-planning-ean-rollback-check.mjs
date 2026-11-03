// Rollback / roll-forward check of 20261114090000_bom_planning_product_ean.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261114090000_bom_planning_product_ean.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const yes = async (sql) => (await db.query(`select (${sql}) as ok`)).rows[0].ok === true

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('BOM planning fields & EAN: rollback / roll-forward')
check('migration applied', await yes(`to_regclass('public.bom_list_v2') is not null and exists (select 1 from pg_proc where proname = 'product_group_head_options')
  and exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'ean')`))
await db.exec(`insert into public.companies (id, legal_name, display_name, company_code) values ('00000000-0000-4000-8000-0000000000c1', 'Rollback Check Ltd', 'RBC', 'RBCK');
  insert into public.products (company_id, sku, product_name, product_type, base_unit, ean, group_head, minimum_cover_days)
  values ('00000000-0000-4000-8000-0000000000c1', 'RB-1', 'Rollback product', 'FINISHED_GOOD', 'PCS', '96385074', 'Faucets', 15);`)

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: view, options RPC and settings validation removed; settings defaults restored',
  await yes(`to_regclass('public.bom_list_v2') is null and not exists (select 1 from pg_proc where proname in ('product_group_head_options', 'company_settings_validate'))
    and not exists (select 1 from pg_trigger where tgname = 'company_settings_validate')
    and not (private.erp_setting_defaults() ? 'product.group_heads') and private.erp_setting_defaults() ? 'product.hsn_codes'`))
check('rollback: product data entered in the new columns is kept', await yes(`exists (select 1 from public.products where sku = 'RB-1' and ean = '96385074' and group_head = 'Faucets' and minimum_cover_days = 15)`))
check('rollback: existing views and BOM functions untouched', await yes(`to_regclass('public.bom_list') is not null and exists (select 1 from pg_proc where proname = 'production_save_bom')`))

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again over the kept columns', await yes(`to_regclass('public.bom_list_v2') is not null and private.erp_setting_defaults() ? 'product.group_heads'`))
let message = ''
try { await db.exec(await read('supabase', 'tests', 'bom_planning_ean_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /BOM_PLANNING_EAN_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
