// HSN on goods receipt lines and the Product Master HSN update (migration 20261205090000).
//
//   npm run test:db:grn-hsn
//
// Local PGlite database only (throwaway, in memory). Receipts go through the ERP's own functions, one
// committed transaction per call. GRNs posted before the migration are checked to stay unchanged.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261205090000_grn_hsn_snapshot'
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)
const w1 = await val(`select rls_test.id('w1')::text`)
const supA = await val(`select rls_test.gid('sup', 'supplier_id')::text`)

// 14. GRNs posted before this migration (the end-to-end flow).
const oldLines = () => val(`select md5(string_agg((to_jsonb(l) - 'hsn_code')::text, '|' order by l.id)) from public.goods_receipt_lines l`)
const oldCount = await val(`select count(*)::int from public.goods_receipt_lines`)
const oldBefore = await oldLines()
const oldIds = await val(`select array_agg(id::text) from public.goods_receipt_lines`)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied (20261205090000 twice)')
ok(`14. the ${oldCount} GRN line(s) posted before the migration are unchanged (no HSN snapshot invented)`, oldCount > 0
  && (await val(`select md5(string_agg((to_jsonb(l) - 'hsn_code')::text, '|' order by l.id)) from public.goods_receipt_lines l where l.id::text = any($1)`, [oldIds])) === oldBefore
  && (await val(`select count(*)::int from public.goods_receipt_lines where id::text = any($1) and hsn_code is not null`, [oldIds])) === 0)

let n = 0
const product = (hsn, extra = {}) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code, description, brand)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', $3, 'ACTIVE', $4, $5, $6, 'Keep me', 'Keep brand') returning id`,
  [A, `GH-${++n}`, extra.unit ?? 'PCS', extra.cost ?? 10, extra.gst ?? 18, hsn])
const openPo = async (lines) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
    [{ supplier_id: supA, purchase_type: 'RAW_MATERIAL', warehouse_id: w1 }, lines])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  return po
}
const lineIds = (po) => val(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
const receivePo = async (po, parts, user = 'op', key = crypto.randomUUID()) => {
  const ids = await lineIds(po)
  return request(user, `select public.purchase_receipt_post_refs($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`, [po, JSON.stringify(parts.map((x) => ({
    po_line_id: ids[x.i ?? 0], received_quantity: x.qty, accepted_quantity: x.acc ?? x.qty, rejected_quantity: 0, accepted_location_id: x.loc ?? g1,
    ...(x.hsn !== undefined ? { hsn_code: x.hsn } : {}), ...(x.actual !== undefined ? { actual_unit_price: x.actual, price_variance_reason: 'Supplier price revision' } : {}) }))), key])
}
const receiveDirect = (parts, user = 'op', key = crypto.randomUUID()) => request(user, `select public.goods_receipt_direct_post_refs($1::jsonb, $2::jsonb, $3::uuid)`,
  [JSON.stringify({ warehouse_id: w1, supplier_id: supA, receipt_date: null }), JSON.stringify(parts.map((x) => ({ product_id: x.product, received_quantity: x.qty, accepted_quantity: x.qty,
    rejected_quantity: 0, unit_cost: x.cost ?? null, gst_rate: x.gst ?? null, accepted_location_id: x.loc ?? g1, ...(x.hsn !== undefined ? { hsn_code: x.hsn } : {}) }))), key])
const masterHsn = (id) => val(`select hsn_code from public.products where id = $1`, [id])
const other = (id) => val(`select md5((to_jsonb(p) - array['hsn_code', 'updated_at', 'updated_by', 'change_reason'])::text) from public.products p where id = $1`, [id])
const snaps = (receipt) => val(`select jsonb_agg(hsn_code order by created_at, id) from public.goods_receipt_lines where goods_receipt_id = $1`, [receipt])
const audits = (pid) => val(`select count(*)::int from public.audit_logs where action = 'product.hsn_updated_from_grn' and resource_id = $1`, [pid])

// ---------------------------------------------------------------------------
console.log('\nReceive against a PO')
const P1 = await product('6910')
const po1 = await openPo([{ product_id: P1, quantity: 10, unit_price: 10 }])
const r1 = await receivePo(po1, [{ qty: 4 }])
ok('1. unchanged HSN: the line records the Product Master HSN 6910; the Product Master is not touched', !r1.error && (await snaps(r1.value.receipt_id))[0] === '6910'
  && (await audits(P1)) === 0 && r1.value.hsn_updates.length === 0, r1)
const r1b = await receivePo(po1, [{ qty: 1, hsn: '6910' }])
ok('1. the same HSN entered again is not an update', !r1b.error && (await audits(P1)) === 0)
const otherBefore = await other(P1)
const r2 = await receivePo(po1, [{ qty: 2, hsn: '73241000' }])
ok('2. changed HSN: the line records 73241000 and the Product Master HSN becomes 73241000', !r2.error && (await snaps(r2.value.receipt_id))[0] === '73241000'
  && (await masterHsn(P1)) === '73241000', r2)
ok('4. updated only HSN: name, description, brand, GST rate, cost and category are unchanged', (await other(P1)) === otherBefore)
const au = await val(`select jsonb_build_object('meta', metadata, 'actor', actor_user_id = rls_test.id('op'), 'at', event_timestamp is not null) from public.audit_logs
  where action = 'product.hsn_updated_from_grn' and resource_id = $1`, [P1])
ok('audit: previous and new HSN, product, GRN, user and time', au.meta.previous_hsn === '6910' && au.meta.new_hsn === '73241000' && au.meta.product_id === P1
  && au.meta.goods_receipt_id === r2.value.receipt_id && au.actor && au.at, au)
ok('the change is a product version naming the GRN', (await val(`select change_reason from public.product_versions where product_id = $1 order by version_no desc limit 1`, [P1]))
  === `HSN changed on goods receipt ${r2.value.receipt_number}`)
ok('the result lists the update', r2.value.hsn_updates?.[0]?.previous_hsn === '6910' && r2.value.hsn_updates[0].new_hsn === '73241000', r2.value)
ok('1. the earlier GRN keeps its own HSN snapshot (6910)', (await snaps(r1.value.receipt_id))[0] === '6910')

// 11. Actual cost different from the PO price, with a changed HSN.
const P2 = await product(null)
const po2 = await openPo([{ product_id: P2, quantity: 10, unit_price: 10 }])
const r11 = await receivePo(po2, [{ qty: 10, actual: 15, hsn: '3926' }])
ok('11. actual cost ₹15 (PO ₹10) and a new HSN together: payable ₹177, HSN 3926 recorded and set on the product', !r11.error
  && (await val(`select line_value::float8 from public.goods_receipt_lines where goods_receipt_id = $1`, [r11.value.receipt_id])) === 177
  && (await snaps(r11.value.receipt_id))[0] === '3926' && (await masterHsn(P2)) === '3926', r11)

// ---------------------------------------------------------------------------
console.log('\nReceive without a PO')
const P3 = await product(null, { unit: 'KG', cost: 40, gst: 12 })
const d1 = await receiveDirect([{ product: P3, qty: 2.5, hsn: '2507' }])
ok('3. a manually entered HSN on a receipt without a PO: recorded and set on the product (it had none)', !d1.error
  && (await snaps(d1.value.receipt_id))[0] === '2507' && (await masterHsn(P3)) === '2507' && (await audits(P3)) === 1, d1)
ok('10. the payable of a receipt without a PO is unchanged: 2.5 KG × ₹40 × 1.12 = ₹112', (await val(`select line_value::float8 from public.goods_receipt_lines where goods_receipt_id = $1`, [d1.value.receipt_id])) === 112)
const P4 = await product('8481')
const d2 = await receiveDirect([{ product: P4, qty: 3 }])
ok('3. blank HSN: the Product Master HSN is recorded', !d2.error && (await snaps(d2.value.receipt_id))[0] === '8481' && (await audits(P4)) === 0, d2)

// ---------------------------------------------------------------------------
console.log('\nOnly after a successful posting')
const P5 = await product('6910')
const otherLoc = await val(`select id::text from public.inventory_locations where company_id <> $1 limit 1`, [A])
const f1 = await receiveDirect([{ product: P5, qty: 1, hsn: '7324' }, { product: await product('6910'), qty: 1, loc: otherLoc ?? '00000000-0000-4000-8000-000000000001' }])
ok('6. a posting that fails (line 2 has a wrong location) leaves the Product Master HSN as it was', Boolean(f1.error) && (await masterHsn(P5)) === '6910' && (await audits(P5)) === 0, f1)
const po5 = await openPo([{ product_id: P5, quantity: 5, unit_price: 10 }])
const f2 = await receivePo(po5, [{ qty: 99, hsn: '7324' }])
ok('6. an over-receipt refused by the existing rules also changes nothing', Boolean(f2.error) && (await masterHsn(P5)) === '6910', f2)
const bad = await receivePo(po5, [{ qty: 1, hsn: '12345' }])
ok('an HSN that is not 4, 6 or 8 digits is refused', /4, 6 or 8 digits/.test(bad.error ?? ''), bad)
const P6 = await product('6910')
const po6 = await openPo([{ product_id: P6, quantity: 5, unit_price: 10 }, { product_id: P6, quantity: 5, unit_price: 12 }])
const clash = await receivePo(po6, [{ i: 0, qty: 1, hsn: '7324' }, { i: 1, qty: 1, hsn: '3926' }])
ok('two different HSNs for the same product in one GRN are refused', /different HSN/.test(clash.error ?? '') && (await masterHsn(P6)) === '6910', clash)
// 5. A draft never posts: the receipt form's auto-saved draft is not a GRN and calls no posting function.
ok('5. GRNs have no draft or submitted state in V2 (only POSTED / REVERSED): nothing but posting can update the Product Master',
  (await val(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'goods_receipts_status_check'`))?.includes("'POSTED'")
  && !(await val(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'goods_receipts_status_check'`)).includes('DRAFT'))

// ---------------------------------------------------------------------------
console.log('\nIdempotency, reversal, correction')
const P7 = await product('6910')
const po7 = await openPo([{ product_id: P7, quantity: 10, unit_price: 10 }])
const key = crypto.randomUUID()
const i1 = await receivePo(po7, [{ qty: 2, hsn: '7324' }], 'op', key)
const i2 = await receivePo(po7, [{ qty: 2, hsn: '7324' }], 'op', key)
ok('12. the same posting sent twice: one GRN, one Product Master update, one audit entry, one product version', i2.value?.receipt_id === i1.value?.receipt_id
  && (await audits(P7)) === 1 && (await val(`select count(*)::int from public.product_versions where product_id = $1`, [P7])) === 2, { i1, i2 })
await op(`select public.goods_receipt_reverse($1, 'Wrong supplier delivered', gen_random_uuid())`, [i1.value.receipt_id])
ok('7. reversing the GRN keeps its HSN snapshot and does not change the Product Master HSN back', (await snaps(i1.value.receipt_id))[0] === '7324'
  && (await masterHsn(P7)) === '7324' && (await audits(P7)) === 1)
const corr = await request('op', `select public.goods_receipt_correct_refs($1, 'Recount at the gate', jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, gen_random_uuid())`,
  [r2.value.receipt_id, JSON.stringify([{ po_line_id: (await lineIds(po1))[0], received_quantity: 2, accepted_quantity: 2, rejected_quantity: 0, accepted_location_id: g1, hsn_code: '732410' }])])
ok('a correction posts with its own HSN (and applies it to the Product Master like any posting)', !corr.error && (await snaps(corr.value.receipt_id))[0] === '732410'
  && (await masterHsn(P1)) === '732410' && (await snaps(r2.value.receipt_id))[0] === '73241000', corr)

// ---------------------------------------------------------------------------
console.log('\nPermissions and isolation')
const role = await val(`select r.code from public.roles r where exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'purchase_receipt.create')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'products.update') order by r.code limit 1`)
ok(`a role that receives goods but cannot edit products exists (${role})`, Boolean(role))
await db.exec(`reset role; insert into rls_test.ids (key, id) values ('gh_clerk', 'e7e5c800-0000-4000-8000-0000000000d1');
  insert into auth.users (id, email) values (rls_test.id('gh_clerk'), 'gh_clerk@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('gh_clerk')`)
await db.query(`insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('gh_clerk'), $1, (select id from public.roles where code = $2))`, [A, role])
const P8 = await product('6910')
const po8 = await openPo([{ product_id: P8, quantity: 10, unit_price: 10 }])
const denied = await receivePo(po8, [{ qty: 1, hsn: '7324' }], 'gh_clerk')
ok('13. without products.update a changed HSN is refused with the reason (no silent update, nothing posted)', /products\.update/.test(denied.error ?? '') && /differs from the Product Master HSN \(6910\)/.test(denied.error ?? '')
  && (await masterHsn(P8)) === '6910' && (await val(`select count(*)::int from public.goods_receipts where purchase_order_id = $1`, [po8])) === 0, denied)
const allowed = await receivePo(po8, [{ qty: 1 }], 'gh_clerk')
ok('13. the same user posts with the Product Master HSN', !allowed.error && (await snaps(allowed.value.receipt_id))[0] === '6910', allowed)
const deniedDirect = await receiveDirect([{ product: P8, qty: 1, hsn: '7324' }], 'gh_clerk')
ok('13. the same rule for receipts without a PO', /products\.update/.test(deniedDirect.error ?? ''), deniedDirect)
ok('company B does not see company A GRN lines', (await request('b_op', `select count(*)::int from public.goods_receipt_line_list where company_id = $1`, [A])).value === 0)
ok('15. the GRN line list (detail and print screens) shows the HSN; RLS and grants kept', (await request('op', `select hsn_code from public.goods_receipt_line_list where goods_receipt_id = $1`, [r11.value.receipt_id])).value === '3926'
  && !(await val(`select has_table_privilege('anon', 'public.goods_receipt_line_list', 'SELECT')`))
  && (await val(`select reloptions::text from pg_class where relname = 'goods_receipt_line_list'`)).includes('security_invoker=true'))
ok('the result still confirms actual-cost support (20261202090000 behaviour kept)', r1.value.actual_cost_supported === true)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database)')
const hsnNow = await masterHsn(P1)
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const orig = await read(path.join(migDir, '20261202090000_grn_actual_cost.sql'))
const start = orig.indexOf('create or replace function public.purchase_receipt_post(')
const body = orig.slice(orig.indexOf('as $$', start) + 5, orig.indexOf('\n$$;', start) + 1)
ok('rollback restores the posting function of 20261202090000 exactly', (await val(`select prosrc from pg_proc where proname = 'purchase_receipt_post'`)) === body)
ok('rollback drops the HSN snapshot column and keeps the Product Master HSN changes', (await val(`select count(*)::int from information_schema.columns where table_name = 'goods_receipt_lines' and column_name = 'hsn_code'`)) === 0
  && (await masterHsn(P1)) === hsnNow && (await val(`select to_regclass('public.goods_receipt_line_list')::text`)) === 'goods_receipt_line_list')
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
const again = await receivePo(po8, [{ qty: 1, hsn: '7325' }])
ok('the migration applies again and works', !again.error && (await masterHsn(P8)) === '7325', again)

console.log(`${failed === 0 ? '✓' : '✗'} GRN HSN check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
