// Proves the manual rollback of the product / purchase enhancements migration
// works and that the migration can be applied again afterwards, on PGlite.
//
//   npm run test:db:rollback
//
// 1. apply all migrations, add a product and purchase references
// 2. the rollback refuses to run while new data exists
// 3. with app.rollback_discard_new_data = yes it removes every added object,
//    restores the previous functions, keeps the existing records
// 4. apply the migration again and run its verification suite

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFile(path.join(root, ...p), 'utf8')
const MIGRATION = '20261109090000_product_purchase_enhancements.sql'
const db = new PGlite()
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const one = async (sql) => (await db.query(sql)).rows[0]
const exists = async (sql) => (await one(`select (${sql}) as ok`)).ok === true

await db.exec(await read('supabase', 'tests', 'local_supabase_shim.sql'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(await read('supabase', 'migrations', f))
}
console.log('Product / purchase enhancements rollback / roll-forward')
check('migration applied: new columns and table exist',
  await exists(`to_regclass('public.purchase_document_refs') is not null and exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'mrp')`))

await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code) values ('e7e5ca00-0000-4000-8000-0000000000a1', 'Rollback PP Co', 'Rollback PP', 'RBPP');
  insert into public.products (id, company_id, sku, product_name, product_type, default_source_type, base_unit, reorder_level, mrp)
  values ('e7e5ca00-0000-4000-8000-0000000000c1', 'e7e5ca00-0000-4000-8000-0000000000a1', 'RBPP-1', 'Rollback part', 'COMPONENT', 'OUTSOURCED', 'PCS', 7, 99);`)
const before = await one(`select count(*)::int n, md5(string_agg(id::text || sku || coalesce(reorder_level::text, ''), ',' order by id)) h from public.products`)

// Rollbacks run newest first: 20261114 (bom_list_v2 reads products.lead_time_days) is rolled back before this one.
await db.exec(await read('supabase', 'rollback', '20261114090000_bom_planning_product_ean_down.sql'))
const down = await read('supabase', 'rollback', MIGRATION.replace('.sql', '_down.sql'))
let refused = ''
try { await db.exec(down) } catch (e) { refused = e.message }
check('rollback: refuses while products hold new values', /Rollback stopped/.test(refused), refused)
check('rollback: nothing removed by the refused run', await exists(`exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'mrp')`))

await db.exec(`select set_config('app.rollback_discard_new_data', 'yes', false)`)
await db.exec(down)
check('rollback: new product columns removed',
  (await one(`select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'products'
              and column_name in ('lead_time_days', 'reorder_level_days', 'mrp', 'length_cm', 'width_cm', 'height_cm', 'supplier_model_number', 'supplier_product_name')`)).n === 0)
check('rollback: references table, views and functions removed',
  await exists(`to_regclass('public.purchase_document_refs') is null and to_regclass('public.purchase_order_list_v2') is null
                and to_regclass('public.goods_receipt_list_v2') is null
                and not exists (select 1 from pg_proc where proname in ('erp_report_v2', 'inventory_reorder_plan', 'purchase_document_refs_set', 'save_purchase_refs',
                  'purchase_order_save_refs', 'purchase_receipt_post_refs', 'goods_receipt_direct_post_refs', 'goods_receipt_correct_refs',
                  'product_consumption', 'reorder_by_days', 'product_normalise_supplier_refs'))`))
check('rollback: previous stock status, overview and alert functions restored (no days rule)',
  await exists(`pg_get_viewdef('public.inventory_product_stock'::regclass) not like '%reorder_by_days%'
                and (select bool_and(prosrc not like '%reorder_level_days%') from pg_proc where proname in ('inventory_overview', 'inventory_refresh_alerts'))`))
check('rollback: the ERP reset list is back to 77 tables', (await one(`select count(*)::int n from private.erp_reset_tables()`)).n === 77)
check('rollback: RLS still enabled on every public table',
  (await one(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).n === 0)
const after = await one(`select count(*)::int n, md5(string_agg(id::text || sku || coalesce(reorder_level::text, ''), ',' order by id)) h from public.products`)
check('rollback: existing products (and their earlier quantity reorder level) unchanged', before.n === after.n && before.h === after.h)

await db.exec(await read('supabase', 'migrations', MIGRATION))
check('roll forward: migration applies again after the rollback', await exists(`to_regclass('public.purchase_document_refs') is not null`))

let message = ''
try {
  await db.exec(await read('supabase', 'tests', 'product_purchase_v2_verification.sql'))
} catch (error) {
  message = error.message ?? String(error)
}
await db.exec('rollback').catch(() => {})
const m = /PRODUCT_PURCHASE_V2_VERIFICATION_RESULT passed=(\d+) failed=(\d+)/.exec(message)
check(`roll forward: verification suite passes (${m ? `${m[1]} passed, ${m[2]} failed` : message})`, Boolean(m) && m[2] === '0')

console.log(failed === 0 ? '✓ rollback check passed' : `✗ rollback check: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
