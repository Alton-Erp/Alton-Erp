// Rollback / roll-forward check of 20261118090000_master_versioning.sql on PGlite.
//   npm run test:db:rollback
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261118090000_master_versioning.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]
const yes = async (sql) => (await one(`select (${sql}) as ok`)).ok === true
const src = (schema, fn) => `(select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = '${schema}' and proname = '${fn}')`
const COLS = `(select count(*) from information_schema.columns where table_schema = 'public' and column_name in
  ('product_version_id', 'sku_snapshot', 'product_name_snapshot', 'component_version_id', 'component_sku_snapshot', 'standard_cost_snapshot', 'change_reason', 'process_instructions')
  and table_name in ('inventory_transactions', 'production_orders', 'production_order_materials', 'bom_items', 'boms', 'products'))`

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
const files = (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()
for (const f of files) await db.exec(await read('supabase', 'migrations', f))
console.log('Master versioning: rollback / roll-forward')
check('migration applied', await yes(`to_regclass('public.product_versions') is not null and ${src('public', 'erp_report')} like '%hist_product%' and ${COLS} > 0`))
// Some data first: the rollback must keep it.
await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code) values ('e7e5d400-0000-4000-8000-0000000000a1', 'Rollback MV', 'Rollback MV', 'MVRB');
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
  values ('e7e5d400-0000-4000-8000-0000000000a1', 'RB-1', 'Rollback product', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE');
  update public.products set product_name = 'Rollback product 2' where sku = 'RB-1';`)
check('versions recorded for the test product', (await one(`select count(*)::int n from public.product_versions v join public.products p on p.id = v.product_id where p.sku = 'RB-1'`)).n === 2)
const counts = `select (select count(*) from public.products)::int p, (select count(*) from public.boms)::int b, (select count(*) from public.production_orders)::int o,
  (select count(*) from public.inventory_transactions)::int t`
const before = (await db.query(counts)).rows[0]

await db.exec(await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql')))
check('rollback: version tables, snapshot columns and functions removed',
  await yes(`to_regclass('public.product_versions') is null and to_regclass('public.production_order_revisions') is null and ${COLS} = 0
    and not exists (select 1 from pg_proc where proname in ('hist_product', 'product_version_history', 'bom_version_history', 'bom_version_details_save'))`))
check('rollback: reports read the Product Master again (previous definitions)',
  await yes(`${src('public', 'erp_report')} not like '%hist_product%' and ${src('public', 'production_report')} not like '%hist_product%'
    and ${src('private', 'production_cost_rows')} like '%cp.standard_cost%'`))
check('rollback: list views restored', await yes(`(select count(*) from pg_views where schemaname = 'public' and viewname in
  ('inventory_transaction_list', 'production_consumption_list', 'production_output_list', 'production_order_list', 'bom_item_list', 'bom_list', 'bom_list_v2')) = 7
  and (select definition from pg_views where viewname = 'inventory_transaction_list') not like '%hist_product%'`))
check('rollback: ERP reset lists restored (80 / 86 tables)', await yes(`(select count(*) from private.erp_reset_tables()) = 80 and (select count(*) from private.erp_force_reset_tables()) = 86
  and not exists (select 1 from private.erp_reset_kept_tables() where table_name = 'product_versions')`))
const after = (await db.query(counts)).rows[0]
check('rollback: no products, BOMs, orders or stock entries changed', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))
check('rollback: products still editable', (await db.query(`update public.products set product_name = 'After rollback' where sku = 'RB-1'`)).affectedRows === 1)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again (legacy baseline for products without versions)',
  await yes(`to_regclass('public.product_versions') is not null and (select is_legacy from public.product_versions v join public.products p on p.id = v.product_id where p.sku = 'RB-1')`))
for (const f of files) await db.exec(await read('supabase', 'migrations', f))
check('roll forward: all migrations re-apply', true)
let message = ''
try { await db.exec(await read('supabase', 'tests', 'master_versioning_verification.sql')) } catch (e) { message = e.message ?? String(e) }
await db.exec('rollback').catch(() => {})
const m = /MASTER_VERSIONING_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
