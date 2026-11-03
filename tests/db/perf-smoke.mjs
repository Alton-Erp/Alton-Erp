// Volume smoke test (Phase 11): posts N stock movements through the real ledger
// functions in PGlite, then times the dashboard / list / audit queries and checks
// the ledger invariant still holds. PGlite is single-threaded WebAssembly, so the
// timings are a pessimistic upper bound, not a production benchmark.
//
//   node tests/db/perf-smoke.mjs [movements=10000]

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const N = Number(process.argv[2] ?? 10000)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new PGlite()
await db.exec(await readFile(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql'), 'utf8'))
for (const f of (await readdir(path.join(root, 'supabase', 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(await readFile(path.join(root, 'supabase', 'migrations', f), 'utf8'))
}

const C = 'c0ffee00-0000-4000-8000-0000000000a1'
const U = 'c0ffee00-0000-4000-8000-000000000001'
await db.exec(`
  insert into public.companies (id, legal_name, display_name, company_code, state, gstin) values ('${C}', 'Perf Test (TEST)', 'Perf', 'PERF', 'Maharashtra', '27AABCP1234F1Z5');
  insert into auth.users (id, email) values ('${U}', 'perf@example.invalid');
  update public.profiles set company_id = '${C}', is_active = true where id = '${U}';
  insert into public.user_roles (user_id, company_id, role_id) select '${U}', '${C}', id from public.roles where code in ('ADMIN', 'INVENTORY_MANAGER');
  insert into public.warehouses (company_id, warehouse_code, warehouse_name, is_default) values ('${C}', 'PW', 'Perf store', true);
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit)
    select '${C}', 'PERF-' || g, 'Perf item ' || g, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS' from generate_series(1, 200) g;
`)
const loc = (await db.query(`select id from public.inventory_locations where company_id = '${C}' and location_code = 'GENERAL'`)).rows[0].id
const asUser = `set role authenticated; select set_config('request.jwt.claims', '{"sub": "${U}", "role": "authenticated"}', false);`

const time = async (label, sql) => {
  const t = performance.now()
  const r = await db.query(sql)
  const ms = Math.round(performance.now() - t)
  console.log(`  ${label.padEnd(58)} ${String(ms).padStart(7)} ms`)
  return r
}

console.log(`Volume smoke: ${N} receipts + ${N / 2} issues across 200 products (real ledger functions)`)
await db.exec(asUser)
await time(`post ${N} receipts (inventory_post_receipt)`, `select count(public.inventory_post_receipt(p.id, '${loc}', 3, 'IN_HOUSE', p_unit_cost => 100, p_idempotency_key => gen_random_uuid()))
  from generate_series(1, ${N}) g join public.products p on p.sku = 'PERF-' || (1 + g % 200)`)
await time(`post ${N / 2} issues (inventory_post_issue)`, `select count(public.inventory_post_issue(p.id, '${loc}', 1, p_source_type => 'IN_HOUSE', p_reason => 'perf', p_idempotency_key => gen_random_uuid()))
  from generate_series(1, ${N / 2}) g join public.products p on p.sku = 'PERF-' || (1 + g % 200)`)
const today = (await db.query(`select (now() at time zone 'Asia/Kolkata')::date d`)).rows[0].d.toISOString().slice(0, 10)
await time('executive dashboard (analytics_executive, 30 days)', `select public.analytics_executive('${today}'::date - 30, '${today}'::date)`)
await time('inventory analytics (analytics_inventory)', `select public.analytics_inventory('${today}'::date - 30, '${today}'::date)`)
await time('stock movements list, first page of 50 (RLS view)', `select * from public.inventory_transaction_list order by transaction_date desc limit 50`)
await time('stock register by product (RLS view)', `select count(*) from public.inventory_product_stock`)
await time('audit log page of 50 with exact count (RLS)', `select *, count(*) over () from public.audit_logs where event_timestamp >= now() - interval '30 days' order by event_timestamp desc limit 50`)
if (process.env.EXPLAIN) { for (const r of (await db.query(`explain analyze select * from public.inventory_transaction_list order by transaction_date desc limit 50`)).rows) console.log(r['QUERY PLAN']) }
await db.exec('reset role;')
const counts = (await db.query(`select (select count(*) from public.inventory_transactions)::int tx, (select count(*) from public.audit_logs)::int audit`)).rows[0]
const mismatch = (await db.query(`
  with tx as (select batch_id, location_id, sum(direction * quantity) q from public.inventory_transactions group by 1, 2)
  select count(*)::int n from tx full join public.inventory_balances b on b.batch_id = tx.batch_id and b.location_id = tx.location_id
  where coalesce(tx.q, 0) <> coalesce(b.on_hand, 0)`)).rows[0].n
console.log(`  rows: ${counts.tx} stock movements, ${counts.audit} audit events; ledger mismatches: ${mismatch}`)
process.exit(mismatch === 0 ? 0 : 1)
