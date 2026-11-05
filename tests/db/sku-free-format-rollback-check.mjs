// Free-format SKUs (20261120090000): forward behaviour, rollback and re-apply.
//
//   npm run test:db:rollback   (part of it)

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = path.join(migDir, '20261120090000_sku_free_format.sql')
const ROLLBACK = path.join(root, 'supabase', 'rollback', '20261120090000_sku_free_format_down.sql')

const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
await db.exec('begin')
await db.exec(`insert into public.companies (id, legal_name, display_name, company_code) values ('5c000000-0000-4000-8000-0000000000a1', 'SKU Test Co', 'SKU Test', 'SKUT')`)

let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`); if (!cond) failed++ }
async function insert(sku) {
  await db.exec('savepoint s')
  try {
    await db.query(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit) values ('5c000000-0000-4000-8000-0000000000a1', $1, 'SKU test', 'OTHER', 'IN_HOUSE', 'PCS')`, [sku])
    await db.exec('release savepoint s')
    return null
  } catch (e) {
    await db.exec('rollback to savepoint s')
    return e.message
  }
}

const FREE = ['WC 200 (White)', 'Basin#12/A+B', 'टाइल-01', 'x'.repeat(120), '-starts-with-dash', 'A&B, Co.']
for (const s of FREE) ok(`accepted: "${s.length > 30 ? s.slice(0, 30) + '…' : s}"`, (await insert(s)) === null)
ok('leading and trailing spaces are removed on save (then "WC-1 " is a duplicate of "WC-1")', (await insert('  WC-1  ')) === null
  && (await db.query(`select count(*)::int n from public.products where sku = 'WC-1'`)).rows[0].n === 1
  && /products_company_sku_unique/.test(await insert('WC-1 ') ?? ''))
ok('still unique per company, ignoring case', /products_company_sku_unique/.test(await insert('wc 200 (white)') ?? ''))
const auto = await db.query(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
  values ('5c000000-0000-4000-8000-0000000000a1', null, 'Auto code', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS') returning sku`).catch((e) => ({ error: e.message }))
ok('a blank SKU still gets the next automatic code', Boolean(auto.rows?.[0]?.sku), JSON.stringify(auto))

await db.exec(await read(ROLLBACK))
ok('rollback: free-format SKUs already saved are kept', (await db.query(`select count(*)::int n from public.products where sku = 'WC 200 (White)'`)).rows[0].n === 1)
ok('rollback: the original rule applies to new products again', /products_sku_check/.test(await insert('NEW SKU') ?? '') && (await insert('NEW-SKU.1')) === null)
const def = (await db.query(`select pg_get_constraintdef(oid) d, convalidated from pg_constraint where conname = 'products_sku_check'`)).rows[0]
ok('rollback: the rule is the original pattern, not validated against old rows', /\{0,49\}/.test(def.d) && def.convalidated === false, JSON.stringify(def))

await db.exec(await read(MIGRATION))
await db.exec(await read(MIGRATION))
ok('the migration applies again, twice (idempotent)', (await insert('AGAIN #1 (free)')) === null)

console.log(`${failed === 0 ? '✓' : '✗'} SKU free-format rollback check ${failed === 0 ? 'passed' : `failed (${failed})`}`)
process.exit(failed === 0 ? 0 : 1)
