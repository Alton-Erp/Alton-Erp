// Checks supabase/staging/seed_staging_test_data.sql locally (PGlite) before it is
// used on the staging project:
//   * refuses to run until confirmed and edited, and lists missing Auth users;
//   * creates the test companies, 10 role accounts and master data, re-runnably;
//   * the seeded data supports the exact sequence scripts/concurrency-check.mjs
//     runs on staging (receipt -> order -> allocate -> pick/pack -> dispatch ->
//     invoice -> issue -> payment), each step as the role the script signs in as.
// This is a sequential dry run of the data path. It does NOT replace running the
// concurrency script against staging.
//
//   node tests/db/staging-seed-check.mjs

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new PGlite()
await db.exec(await readFile(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql'), 'utf8'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(path.join(root, 'supabase', 'migrations', f), 'utf8'))
}
const seed = await readFile(path.join(root, 'supabase', 'staging', 'seed_staging_test_data.sql'), 'utf8')
const edited = seed
  .replace("'app.stg_email_prefix', 'your.mailbox'", "'app.stg_email_prefix', 'qa'")
  .replace("'app.stg_email_domain', 'yourcompany.example'", "'app.stg_email_domain', 'example.invalid'")
  .replace("'app.allow_staging_seed', 'no'", "'app.allow_staging_seed', 'yes'")

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const errorOf = async (sql) => {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return e.message
  }
}
const one = async (sql) => (await db.query(sql)).rows[0]

check('refuses to run until confirmed for staging', (await errorOf(seed))?.includes('not confirmed'))
check('lists the Auth users that must be created first', (await errorOf(edited))?.includes('qa+stg-admin@example.invalid'))

const tags = ['stg-superadmin', 'stg-admin', 'stg-inventory', 'stg-production', 'stg-purchase', 'stg-sales', 'stg-accounts', 'stg-viewer', 'stg-inactive', 'stg-b-admin']
await db.exec(`insert into auth.users (id, email) select gen_random_uuid(), 'qa+' || t || '@example.invalid' from unnest(array['${tags.join("','")}']) t`)
check('seed runs once the accounts exist', (await errorOf(edited)) === null, await errorOf(edited))
check('seed is re-runnable (second run succeeds)', (await errorOf(edited)) === null)

const s = await one(`select
  (select count(*) from public.companies where company_code like 'STG-%')::int companies,
  (select count(*) from public.profiles p join public.companies c on c.id = p.company_id where c.company_code like 'STG-%')::int accounts,
  (select count(*) from public.profiles p join public.companies c on c.id = p.company_id where c.company_code like 'STG-%' and not p.is_active)::int inactive,
  (select count(*) from public.user_roles ur join public.companies c on c.id = ur.company_id where c.company_code like 'STG-%')::int roles,
  (select count(distinct r.code) from public.user_roles ur join public.roles r on r.id = ur.role_id join public.companies c on c.id = ur.company_id where c.company_code = 'STG-A')::int role_codes,
  (select count(*) from public.products where sku in ('STG-CONC-1', 'STG-B-1'))::int products,
  (select count(*) from public.customers where customer_code in ('STG-CUST-1', 'STG-B-CUST'))::int customers,
  (select count(*) from public.inventory_locations l join public.warehouses w on w.id = l.warehouse_id where w.warehouse_code = 'STG-W1' and l.location_code = 'GENERAL')::int location`)
check('2 test companies, 10 accounts (1 deactivated), all 8 roles in STG-A, no duplicates after re-run',
  s.companies === 2 && s.accounts === 10 && s.inactive === 1 && s.roles === 10 && s.role_codes === 8, JSON.stringify(s))
check('test product, customers and the STG-W1 GENERAL location exist', s.products === 2 && s.customers === 2 && s.location === 1, JSON.stringify(s))

// Sequential dry run of the concurrency script's data path, as the same roles.
const ids = await one(`select (select id from public.products where sku = 'STG-CONC-1') p, (select id from public.customers where customer_code = 'STG-CUST-1') cu,
  (select w.id from public.warehouses w where w.warehouse_code = 'STG-W1') w,
  (select l.id from public.inventory_locations l join public.warehouses w on w.id = l.warehouse_id where w.warehouse_code = 'STG-W1' and l.location_code = 'GENERAL') l`)
const as = async (tag, sql) => {
  const uid = (await one(`select id from auth.users where email = 'qa+${tag}@example.invalid'`)).id
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub": "${uid}", "role": "authenticated"}', false);`)
  try {
    return (await db.query(sql)).rows[0]
  } finally {
    await db.exec('reset role;')
  }
}
const step = async (name, tag, sql) => {
  try {
    const r = await as(tag, sql)
    check(name, true)
    return r
  } catch (e) {
    check(name, false, e.message)
    return null
  }
}
await step('inventory: receipt of 10', 'stg-inventory', `select public.inventory_post_receipt('${ids.p}', '${ids.l}', 10, 'IN_HOUSE', p_reason => 'dry run', p_idempotency_key => gen_random_uuid())`)
const so = await step('sales: confirmed order of 3', 'stg-sales', `select public.sales_order_create_manual('{"customer_id": "${ids.cu}", "warehouse_id": "${ids.w}"}'::jsonb,
  '[{"product_id": "${ids.p}", "quantity": 3, "unit_price": 100}]'::jsonb, true, gen_random_uuid()) r`)
const soId = so?.r?.sales_order_id
await step('sales: allocation', 'stg-sales', `select public.sales_order_allocate('${soId}', 'IN_HOUSE_FIRST', null, true, gen_random_uuid())`)
const ful = await step('inventory: consignment created', 'stg-inventory', `select public.fulfilment_create('${soId}', '${ids.w}', null, null, null, gen_random_uuid()) r`)
const fId = ful?.r?.fulfilment_id
await step('inventory: pick, pack, ready', 'stg-inventory', `select public.fulfilment_pick('${fId}', (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_picked', quantity_to_pick)) from public.fulfilment_line_list where fulfilment_id = '${fId}'), true),
  public.fulfilment_pack('${fId}', (select jsonb_agg(jsonb_build_object('line_id', id, 'quantity_packed', quantity_to_pick)) from public.fulfilment_line_list where fulfilment_id = '${fId}'), null, true),
  public.fulfilment_action('${fId}', 'READY')`)
await step('inventory: dispatch', 'stg-inventory', `select public.fulfilment_dispatch('${fId}', '{"vehicle_number": "TEST-0000"}'::jsonb, gen_random_uuid())`)
const inv = await step('accounts: invoice draft from the dispatch', 'stg-accounts', `select public.sales_invoice_create_draft((select jsonb_agg(jsonb_build_object('fulfilment_line_id', id)) from public.fulfilment_line_list where fulfilment_id = '${fId}'), '{}'::jsonb, gen_random_uuid()) r`)
const invId = inv?.r?.invoice_id
await step('accounts: invoice issued (GST validation passes with the seeded company and customer)', 'stg-accounts', `select public.sales_invoice_issue('${invId}', gen_random_uuid())`)
await step('accounts: payment recorded and allocated', 'stg-accounts', `select public.customer_payment_record('{"customer_id": "${ids.cu}", "amount": 100, "payment_method": "UPI", "transaction_reference": "TEST-DRYRUN-1"}'::jsonb,
  '[{"invoice_id": "${invId}", "amount": 100}]'::jsonb, gen_random_uuid())`)
const tot = await one(`select grand_total, invoice_number from public.sales_invoices where id = '${invId}'`)
check('invoice total = 3 x 100 + 18% GST = 354', Number(tot?.grand_total) === 354, JSON.stringify(tot))

// Production guard: an issued invoice in a non-test company must stop the seed.
await db.exec(`update public.companies set company_code = 'LIVECO' where company_code = 'STG-A'`)
check('refuses to run when a non-test company has issued invoices (looks like production)', (await errorOf(edited))?.includes('looks like PRODUCTION'))
await db.exec(`update public.companies set company_code = 'STG-A' where company_code = 'LIVECO'`)

console.log(`\nStaging seed check: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
