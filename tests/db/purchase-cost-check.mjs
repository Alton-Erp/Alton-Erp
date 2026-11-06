// Purchase Cost Intelligence (migration 20261123090000) — database, security and integrity tests.
//
//   npm run test:db:purchase-cost
//
// Local PGlite database only (never the live ALTON V2 project). Company A gets the end-to-end business flow
// (supabase/tests/stage7_e2e_verification.sql); the tests then drive the real purchase functions
// (purchase_order_save / purchase_order_open / purchase_receipt_post / purchase_receipt_reverse /
// goods_receipt_direct_post / goods_receipt_reverse) as company A's operator. Each call is committed, like a
// request: the cost is recorded by a trigger deferred to the end of the posting transaction.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const migDir = path.join(root, 'supabase', 'migrations')
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')

let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow (company A)')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]
/** Runs one request as a user in its own transaction (deferred triggers run at the commit). */
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
      await db.exec('set local role authenticated')
    }
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* already ended */ }
    return { error: e.message }
  }
}
const op = async (sql, params) => {
  const r = await request('op', sql, params)
  if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`)
  return r.value
}
const owner = (sql, params) => val(sql, params)
const id = (key) => owner(`select rls_test.id($1)`, [key])
const today = await owner(`select private.company_today(rls_test.id('company_a'))::text`)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const company = await id('company_a')
const loc = await id('g1')
const wh = await id('w1')
const supA = await owner(`select (value ->> 'supplier_id')::uuid from rls_test.vars where key = 'sup'`)
await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, gst_rate, standard_cost,
    standard_manufacturing_cost, mrp, selling_price)
  values ($1, 'WB-001', 'Ceramic Wash Basin', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 18, 800, 1200, 1500, 1300),
         ($1, 'PC-SEAT', 'Purchase cost seat', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 18, null, null, null, null),
         ($1, 'PC-ZERO', 'Purchase cost free sample', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 18, null, null, null, null)`, [company])
const P = await owner(`select id from public.products where sku = 'WB-001'`)
const S = await owner(`select id from public.products where sku = 'PC-SEAT'`)
const Z = await owner(`select id from public.products where sku = 'PC-ZERO'`)
const productBefore = await owner(`select to_jsonb(p) - 'updated_at' from public.products p where id = $1`, [P])
const updatedBefore = await owner(`select updated_at::text from public.products where id = $1`, [P])
const versionsBefore = await owner(`select count(*)::int from public.product_versions where product_id = $1`, [P])
const supB = (await op(`select public.party_save(null, $1::jsonb, false, gen_random_uuid())`, [JSON.stringify({ party_type: 'SUPPLIER', party_name: 'Supplier B Rajkot',
  gstin: '24AABCR1234A1Z5', billing_address: 'Rajkot', state_code: '24', credit_period_days: 30 })])).supplier_id
// A user of company A with products.read but none of the override permissions; a purchasing approver.
const roleRead = await owner(`select r.id from public.roles r where exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'products.read')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code in ('purchase_exception.approve', 'purchase_order.approve', 'products.update', 'settings.manage'))
  order by r.code limit 1`)
const roleBuyer = await owner(`select r.id from public.roles r where r.code <> 'SUPER_ADMIN' and exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'purchase_order.approve') order by r.code limit 1`)
await db.exec(`insert into rls_test.ids (key, id) values ('viewer', 'e7e5c800-0000-4000-8000-0000000000aa'), ('buyer', 'e7e5c800-0000-4000-8000-0000000000bb');
  insert into auth.users (id, email) values ('e7e5c800-0000-4000-8000-0000000000aa', 'viewer@e7.example.invalid'), ('e7e5c800-0000-4000-8000-0000000000bb', 'buyer@e7.example.invalid');
  update public.profiles set company_id = '${company}', is_active = true where id in ('e7e5c800-0000-4000-8000-0000000000aa', 'e7e5c800-0000-4000-8000-0000000000bb');
  insert into public.user_roles (user_id, company_id, role_id) values ('e7e5c800-0000-4000-8000-0000000000aa', '${company}', '${roleRead}'),
    ('e7e5c800-0000-4000-8000-0000000000bb', '${company}', '${roleBuyer}');`)

const savePo = async (supplier, lines) => (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
  [JSON.stringify({ supplier_id: supplier, purchase_type: 'RAW_MATERIAL', warehouse_id: wh }), JSON.stringify(lines)])).po_id
const openPo = (po) => op(`select public.purchase_order_open($1)`, [po])
const poLines = (po) => owner(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
const receiveSql = `select public.purchase_receipt_post($1, $2::jsonb, $3::jsonb, $4::uuid)`
const receive = (po, lines, key = null, date = today) => op(receiveSql, [po, JSON.stringify({ receipt_date: date }), JSON.stringify(lines), key ?? crypto.randomUUID()])
const line = (lineId, acc, rej = 0) => ({ po_line_id: lineId, received_quantity: acc + rej, accepted_quantity: acc, rejected_quantity: rej,
  accepted_location_id: acc > 0 ? loc : undefined, rejection_reason: rej > 0 ? 'Cracked body' : undefined })
const direct = (product, cost, date = today, acc = 1, supplier = null) => op(`select public.goods_receipt_direct_post($1::jsonb, $2::jsonb, gen_random_uuid())`,
  [JSON.stringify({ warehouse_id: wh, receipt_date: date, ...(supplier ? { supplier_id: supplier } : {}) }),
    JSON.stringify([{ product_id: product, received_quantity: acc, accepted_quantity: acc, rejected_quantity: 0, unit_cost: cost, accepted_location_id: loc }])])
const events = (product = P) => owner(`select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at), '[]') from public.product_purchase_cost_events e where product_id = $1`, [product])
const current = (product = P) => owner(`select to_jsonb(c) from public.product_last_purchase_costs c where product_id = $1`, [product])
const setSetting = (key, value) => op(`select public.erp_settings_save('{}'::jsonb, jsonb_build_object($1::text, $2::jsonb))`, [key, JSON.stringify(value)])
const notes = () => owner(`select count(*)::int from public.notifications where notification_type = 'PURCHASE_COST_CHANGE'`)

// ---------------------------------------------------------------------------
console.log('Purchase orders never change the cost')
const po1 = await savePo(supA, [{ product_id: P, quantity: 10, unit_price: 850 }])
ok('5. a draft PO records nothing', (await events()).length === 0 && (await current()) == null)
await openPo(po1)
ok('6. an approved PO does not set the actual cost (comparison only)', (await events()).length === 0 && (await current()) == null)

console.log('Goods receipts')
const [l1] = await poLines(po1)
const grn1 = await receive(po1, [line(l1, 3, 1)])
let cur = await current()
let ev = await events()
ok('1. initial cost: first receipt sets ₹850, change type INITIAL_COST', Number(cur?.last_purchase_cost) === 850 && cur.change_type === 'INITIAL_COST'
  && ev.length === 1 && ev[0].status === 'APPLIED' && ev[0].previous_cost === null && cur.last_purchase_date === today, { cur, ev })
ok('7/10. partial receipt with a rejection: only the 3 accepted count', Number(ev[0].received_quantity) === 3 && Number(ev[0].rejected_quantity) === 1
  && /1 rejected, excluded/.test(ev[0].reason), ev[0])
ok('the event links PO, GRN, supplier and stores the calculation basis', ev[0].po_number && ev[0].receipt_number === grn1.receipt_number
  && ev[0].supplier_id === supA && ev[0].cost_basis.method === 'PO_LINE_TAXABLE_VALUE_PER_UNIT' && ev[0].cost_basis.gst === 'excluded'
  && ev[0].currency === 'INR' && ev[0].cost_basis.lines.length === 1 && Number(ev[0].cost_basis.lines[0].po_unit_price) === 850, ev[0])
const nFull = (await events()).length
await receive(po1, [{ po_line_id: l1, received_quantity: 2, accepted_quantity: 0, rejected_quantity: 2, rejection_reason: 'All broken' }])
ok('10. a fully rejected receipt changes nothing', (await events()).length === nFull && Number((await current()).last_purchase_cost) === 850)

// Increase, from supplier B, with notifications.
const notesBefore = await notes()
const po2 = await savePo(supB, [{ product_id: P, quantity: 5, unit_price: 920 }])
await openPo(po2)
const key2 = crypto.randomUUID()
const grn2 = await receive(po2, [line((await poLines(po2))[0], 5)], key2)
cur = await current()
ok('2. increase: 850 → 920 is +70 (+8.24%), INCREASE', Number(cur.last_purchase_cost) === 920 && Number(cur.previous_cost) === 850
  && Number(cur.difference_amount) === 70 && Number(cur.difference_percentage) === 8.24 && cur.change_type === 'INCREASE', cur)
ok('9. multiple suppliers: the latest receipt (supplier B) sets the cost', cur.supplier_id === supB)
const msg = await owner(`select message from public.notifications where notification_type = 'PURCHASE_COST_CHANGE' order by created_at desc limit 1`)
ok('purchasing approvers and Super Admins are notified with the details', (await notes()) > notesBefore
  && (await owner(`select count(*)::int from public.notifications where notification_type = 'PURCHASE_COST_CHANGE' and recipient_user_id = rls_test.id('buyer')`)) > 0
  && /increased for Ceramic Wash Basin \(WB-001\)/.test(msg) && /Previous: ₹850/.test(msg) && /New: ₹920/.test(msg) && /Increase: ₹70 \(8\.24%\)/.test(msg)
  && /Supplier: Supplier B Rajkot/.test(msg) && msg.includes(grn2.receipt_number), msg)
const nDup = (await events()).length
const notesDup = await notes()
const again = await receive(po2, [line((await poLines(po2))[0], 5)], key2)
ok('11. a repeated posting (same request) creates no event and no notification', again.receipt_id === grn2.receipt_id
  && (await events()).length === nDup && (await notes()) === notesDup)
ok('11. one event per receipt and product (unique idempotency key)', (await owner(`select count(*)::int from pg_constraint where conname = 'product_purchase_cost_events_idempotency_unique'`)) === 1)

// Decrease.
const po3 = await savePo(supA, [{ product_id: P, quantity: 2, unit_price: 900 }])
await openPo(po3)
await receive(po3, [line((await poLines(po3))[0], 2)])
cur = await current()
ok('3. decrease: 920 → 900 is −20 (−2.17%), DECREASE', Number(cur.last_purchase_cost) === 900 && Number(cur.difference_amount) === -20
  && Number(cur.difference_percentage) === -2.17 && cur.change_type === 'DECREASE', cur)
ok('a decrease notification is sent', /decreased for Ceramic Wash Basin/.test(await owner(`select message from public.notifications where notification_type = 'PURCHASE_COST_CHANGE' order by created_at desc limit 1`)))
// Same price.
const notesSame = await notes()
const po4 = await savePo(supA, [{ product_id: P, quantity: 1, unit_price: 900 }])
await openPo(po4)
await receive(po4, [line((await poLines(po4))[0], 1)])
cur = await current()
ok('4. unchanged price: NO_CHANGE, difference 0, no notification', Number(cur.last_purchase_cost) === 900 && Number(cur.difference_amount) === 0
  && cur.change_type === 'NO_CHANGE' && (await notes()) === notesSame, cur)

// Several lines of the same product (and another product) in one receipt: quantity-weighted.
const po5 = await savePo(supB, [{ product_id: P, quantity: 3, unit_price: 1000 }, { product_id: P, quantity: 1, unit_price: 1000, discount_percent: 20 },
  { product_id: S, quantity: 4, unit_price: 250 }])
await openPo(po5)
const [a5, b5, c5] = await poLines(po5)
const grn5 = await receive(po5, [line(a5, 3), line(b5, 1), line(c5, 4)])
ev = (await events()).filter((e) => e.goods_receipt_id === grn5.receipt_id)
ok('8. multiple lines of one product: one event with the quantity-weighted cost (3×1000 + 1×800) / 4 = 950',
  ev.length === 1 && Number(ev[0].new_cost) === 950 && Number(ev[0].received_quantity) === 4 && ev[0].goods_receipt_line_ids.length === 2
  && ev[0].cost_basis.lines.length === 2 && Number((await current()).last_purchase_cost) === 950, ev)
ok('8. the other product of the receipt gets its own event', Number((await current(S))?.last_purchase_cost) === 250 && (await current(S)).change_type === 'INITIAL_COST')

console.log('Reversals')
await op(`select public.purchase_receipt_reverse($1, 'Wrong supplier invoice', gen_random_uuid())`, [grn5.receipt_id])
cur = await current()
ev = await events()
const rev = ev.filter((e) => e.event_type === 'GRN_REVERSAL').at(-1)
ok('13. reversing the receipt that set the cost recalculates from the latest remaining valid receipt (900)',
  Number(cur.last_purchase_cost) === 900 && rev.status === 'APPLIED' && Number(rev.previous_cost) === 950 && Number(rev.new_cost) === 900
  && rev.reversal_of_event_id && cur.last_event_id === rev.id, { cur, rev })
ok('13. the original receipt event is kept unchanged', ev.some((e) => e.goods_receipt_id === grn5.receipt_id && e.event_type === 'GRN_RECEIPT' && e.status === 'APPLIED'))
await op(`select public.purchase_receipt_reverse($1, 'Returned the whole lot', gen_random_uuid())`, [grn2.receipt_id])
ok('13. reversing an older receipt is recorded; the current cost stays', Number((await current()).last_purchase_cost) === 900
  && (await events()).some((e) => e.event_type === 'GRN_REVERSAL' && e.status === 'NOT_APPLIED' && e.goods_receipt_id === grn2.receipt_id))
// The seat had only one receipt: its reversal leaves no valid receipt.
cur = await current(S)
ok('13. no valid receipt left: the Last Purchase Cost is cleared (NO_COST), the row stays', cur.last_purchase_cost === null && cur.change_type === 'NO_COST'
  && cur.last_purchase_date === null, cur)

console.log('Ordering and concurrency')
const back = await owner(`select ($1::date - 3)::text`, [today])
await direct(P, 700, back, 1, supA)
ev = await events()
ok('14. a receipt dated before the current cost never overwrites it', Number((await current()).last_purchase_cost) === 900
  && ev.at(-1).status === 'NOT_APPLIED' && /Dated before/.test(ev.at(-1).not_applied_reason), ev.at(-1))
await direct(P, 880)
ok('a direct receipt (no PO) updates the cost (method DIRECT_RECEIPT_UNIT_COST)', Number((await current()).last_purchase_cost) === 880
  && (await events()).at(-1).cost_basis.method === 'DIRECT_RECEIPT_UNIT_COST')
await direct(P, 890)
await direct(P, 885)
ok('14. two receipts on the same day: the one posted last wins', Number((await current()).last_purchase_cost) === 885)
ok('14. events of one company + product are serialised by an advisory lock', /pg_advisory_xact_lock/.test(await owner(`select prosrc from pg_proc where proname = 'purchase_cost_lock'`))
  && /purchase_cost_lock/.test(await owner(`select prosrc from pg_proc where proname = 'purchase_cost_process_receipt'`)))
ok('14. the cost is recorded at the end of the posting transaction (deferred trigger)',
  (await owner(`select tgdeferrable and tginitdeferred from pg_trigger where tgname = 'goods_receipt_lines_purchase_cost'`)) === true)

console.log('Failures roll back together')
const txBefore = await owner(`select count(*)::int from public.inventory_transactions`)
const evBefore = await owner(`select count(*)::int from public.product_purchase_cost_events`)
const grnBefore = await owner(`select count(*)::int from public.goods_receipts`)
// (a) The posting fails after its lines are written.
await db.exec(`create function pg_temp_fail_po() returns trigger language plpgsql as $$ begin if new.status = 'RECEIVED' and old.status <> 'RECEIVED' and new.po_number like '%' and current_setting('test.fail_po', true) = 'on' then raise exception 'simulated posting failure'; end if; return new; end $$;
  create trigger pc_fail_po before update on public.purchase_orders for each row execute function pg_temp_fail_po();`)
const po6 = await savePo(supA, [{ product_id: P, quantity: 1, unit_price: 2000 }])
await openPo(po6)
let r = await request('op', `select set_config('test.fail_po', 'on', true), public.purchase_receipt_post($1, $2::jsonb, $3::jsonb, gen_random_uuid())`,
  [po6, JSON.stringify({ receipt_date: today }), JSON.stringify([line((await poLines(po6))[0], 1)])])
ok('12. a failed GRN posting saves no receipt, no stock and no cost', /simulated posting failure/.test(r.error ?? '')
  && (await owner(`select count(*)::int from public.goods_receipts`)) === grnBefore && (await owner(`select count(*)::int from public.inventory_transactions`)) === txBefore
  && (await owner(`select count(*)::int from public.product_purchase_cost_events`)) === evBefore && Number((await current()).last_purchase_cost) === 885, r)
await db.exec(`drop trigger pc_fail_po on public.purchase_orders; drop function pg_temp_fail_po()`)
// (b) The cost recording itself fails at the commit: the receipt is rolled back too.
await db.exec(`create function pg_temp_fail_cost() returns trigger language plpgsql as $$ begin if new.new_cost = 2000 then raise exception 'simulated cost failure'; end if; return new; end $$;
  create trigger pc_fail_cost before insert on public.product_purchase_cost_events for each row execute function pg_temp_fail_cost();`)
r = await request('op', receiveSql, [po6, JSON.stringify({ receipt_date: today }), JSON.stringify([line((await poLines(po6))[0], 1)]), crypto.randomUUID()])
ok('12. if the cost update fails, the GRN posting and its stock movement roll back with it', /simulated cost failure/.test(r.error ?? '')
  && (await owner(`select count(*)::int from public.goods_receipts`)) === grnBefore && (await owner(`select count(*)::int from public.inventory_transactions`)) === txBefore, r)
await db.exec(`drop trigger pc_fail_cost on public.product_purchase_cost_events; drop function pg_temp_fail_cost()`)
const grn6 = await receive(po6, [line((await poLines(po6))[0], 1)])
ok('…and the same posting succeeds afterwards (2000)', Number((await current()).last_purchase_cost) === 2000 && grn6.receipt_number)
ok('significant change (885 → 2000, ≥ 10%) is flagged and notified as HIGH', (await events()).at(-1).significant === true
  && (await owner(`select severity from public.notifications where notification_type = 'PURCHASE_COST_CHANGE' order by created_at desc limit 1`)) === 'HIGH')

console.log('Zero-cost receipts and settings')
await direct(Z, 0)
ok('15. zero-cost receipt (policy IGNORE, default): recorded, not applied', (await current(Z)) == null && (await events(Z))[0].status === 'NOT_APPLIED'
  && /Zero-cost/.test((await events(Z))[0].not_applied_reason))
await setSetting('product.purchase_cost_zero_policy', 'INITIAL_ONLY')
await direct(Z, 0)
ok('15. policy INITIAL_ONLY: zero applies when the product has no cost yet', Number((await current(Z))?.last_purchase_cost) === 0)
await direct(Z, 40)
await direct(Z, 0)
ok('15. policy INITIAL_ONLY: zero never overwrites a valid cost', Number((await current(Z)).last_purchase_cost) === 40)
await setSetting('product.purchase_cost_zero_policy', 'APPLY')
await direct(Z, 0)
ok('15. policy APPLY: zero is applied explicitly', Number((await current(Z)).last_purchase_cost) === 0)
await setSetting('product.purchase_cost_zero_policy', 'IGNORE')
await setSetting('product.purchase_cost_auto_update', false)
await direct(P, 1999)
ok('automatic updates disabled: recorded in the history only', Number((await current()).last_purchase_cost) === 2000 && (await events()).at(-1).status === 'NOT_APPLIED')
await setSetting('product.purchase_cost_auto_update', true)
await setSetting('product.purchase_cost_increase_alerts', false)
const nAlert = await notes()
await direct(P, 2100)
ok('increase alerts off: no notification', (await notes()) === nAlert && Number((await current()).last_purchase_cost) === 2100)
await setSetting('product.purchase_cost_increase_alerts', true)
for (const [key, bad, rx] of [['product.purchase_cost_zero_policy', '"SOMETIMES"', /Zero-cost/], ['product.purchase_cost_auto_update', '"yes"', /on or off/],
  ['product.purchase_cost_alert_percent', '5000', /threshold/], ['product.purchase_cost_override_permission', '"users.manage"', /overrides/]]) {
  r = await request(null, `insert into public.company_settings (company_id, setting_key, setting_value) values ($1, $2, $3::jsonb)`, [company, key, bad])
  ok(`settings: an invalid ${key.split('.')[1]} is refused`, rx.test(r.error ?? ''), r)
}
ok('settings changes are audited (settings.erp_updated) and company-specific', (await owner(`select count(*)::int from public.audit_logs where company_id = $1 and action = 'settings.erp_updated'`, [company])) >= 6
  && (await owner(`select count(*)::int from public.company_settings where company_id <> $1 and setting_key like 'product.purchase_cost%'`, [company])) === 0)

console.log('Manual override, permissions and audit')
r = await request('viewer', `select public.product_purchase_cost_override($1, 1000, 'Supplier credit note agreed')`, [P])
ok('20. a user without the override permission cannot override', /permission/.test(r.error ?? ''), r)
r = await request('op', `select public.product_purchase_cost_override($1, 1000, 'no')`, [P])
ok('20. an override needs a reason', /reason/.test(r.error ?? ''), r)
await op(`select public.product_purchase_cost_override($1, 1000, 'Supplier credit note agreed')`, [P])
ok('20. an authorised override applies and is recorded', Number((await current()).last_purchase_cost) === 1000 && (await events()).at(-1).event_type === 'MANUAL_OVERRIDE')
ok('20. every cost update, reversal and override is in the audit log',
  (await owner(`select count(distinct action)::int from public.audit_logs where resource_id = $1 and action in ('products.purchase_cost_updated', 'products.purchase_cost_recorded', 'products.purchase_cost_reversed', 'products.purchase_cost_overridden')`, [P])) === 4)

console.log('Integrity, isolation and valuation')
r = await request('op', `update public.product_purchase_cost_events set new_cost = 1 where product_id = $1`, [P])
ok('16. users cannot change history', Boolean(r.error), r)
r = await request(null, `update public.product_purchase_cost_events set new_cost = 1 where product_id = $1`, [P])
ok('16. even the database owner cannot rewrite an event', /cannot be changed/.test(r.error ?? ''), r)
r = await request(null, `delete from public.product_purchase_cost_events where product_id = $1`, [P])
ok('16. …or delete one', /cannot be changed/.test(r.error ?? ''), r)
r = await request('op', `update public.product_last_purchase_costs set last_purchase_cost = 1 where product_id = $1`, [P])
ok('16. users cannot write the current cost directly', Boolean(r.error) || (await current()).last_purchase_cost !== 1, r)
ok('16. no insert / update / delete grants for users', (await owner(`select bool_or(has_table_privilege('authenticated', t, p)) from unnest(array['public.product_purchase_cost_events', 'public.product_last_purchase_costs']) t, unnest(array['insert', 'update', 'delete']) p`)) === false)
r = await request('b_op', `select public.product_purchase_cost_history($1)`, [P])
ok('17. another company cannot read the history', /not found/i.test(r.error ?? ''), r)
r = await request('b_op', `select count(*)::int from public.product_purchase_costs(array[$1::uuid])`, [P])
ok('17. another company gets no cost', r.value === 0, r)
r = await request('b_op', `select (select count(*) from public.product_purchase_cost_events)::int + (select count(*) from public.product_last_purchase_costs)::int`)
ok('17. another company sees no rows (row-level security)', r.value === 0, r)
r = await request('b_op', `select public.product_purchase_cost_override($1, 1, 'Not my product at all')`, [P])
ok('17. another company cannot override', Boolean(r.error), r)
r = await request('viewer', `select count(*)::int from public.product_purchase_cost_events where product_id = $1`, [P])
ok('a user of the company with products.read sees the history', r.value > 0, r)
const productAfter = await owner(`select to_jsonb(p) - 'updated_at' from public.products p where id = $1`, [P])
ok('18. Standard Purchase / Manufacturing Cost, MRP and Selling Price are unchanged (the product row is never written)',
  JSON.stringify(productAfter) === JSON.stringify(productBefore) && (await owner(`select updated_at::text from public.products where id = $1`, [P])) === updatedBefore
  && (await owner(`select count(*)::int from public.product_versions where product_id = $1`, [P])) === versionsBefore)
ok('19. inventory valuation is unchanged: each receipt lot is valued at the same accepted cost the event used', (await owner(`
  select bool_and(t.unit_cost = l.unit_cost) from public.goods_receipt_lines l join public.inventory_transactions t on t.id = l.accepted_transaction_id
  where l.product_id = $1`, [P])) === true)
ok('19. no stock movement was created or changed by cost events (ledger count matches receipts)', (await owner(`
  select count(*)::int from public.inventory_transactions t where t.product_id = $1 and t.unit_cost is distinct from (select l.unit_cost from public.goods_receipt_lines l where l.accepted_transaction_id = t.id or l.rejected_transaction_id = t.id) and exists (select 1 from public.goods_receipt_lines l where l.accepted_transaction_id = t.id)`, [P])) === 0)
r = await request('op', `select public.product_bulk_delete_preview(array[$1::uuid])`, [Z])
ok('a product with purchase cost history is protected from bulk delete', r.value?.products?.[0]?.deletable === false, r.value?.products?.[0]?.blockers ?? r)
r = await request('op', `select to_jsonb(c) from public.product_purchase_costs(array[$1::uuid], $2) c`, [P, supB])
ok('PO comparison: the supplier\'s own latest valid price is returned (supplier B: its last valid receipt)', r.value && Number(r.value.last_cost) === 1000
  && r.value.supplier_last_cost !== undefined && Number(r.value.threshold) === 10, r)
ok('the history lists every event newest first with the other cost types', (await op(`select jsonb_array_length(public.product_purchase_cost_history($1) -> 'events')`, [P])) === (await events()).length)
ok('the tables are in the ERP reset list', (await owner(`select count(*)::int from private.erp_reset_tables() where table_name in ('product_purchase_cost_events', 'product_last_purchase_costs')`)) === 2)
ok('anonymous users cannot call the functions', (await owner(`select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p
  where p.proname in ('product_purchase_costs', 'product_purchase_cost_history', 'product_purchase_cost_override') and p.pronamespace = 'public'::regnamespace`)) === false)

console.log('Rollback script')
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261123090000_purchase_cost_intelligence_down.sql')))
ok('rollback removes the triggers and functions, keeps the history', (await owner(`select count(*)::int from pg_proc where proname like 'product_purchase_cost%' or proname like 'purchase_cost_%'`)) === 0
  && (await owner(`select count(*)::int from pg_trigger where tgname like '%purchase_cost%' and not tgisinternal`)) === 1
  && (await owner(`select count(*)::int from public.product_purchase_cost_events`)) > 0
  && (await owner(`select private.erp_setting_defaults() ? 'product.purchase_cost_auto_update'`)) === false)
const evRolled = await owner(`select count(*)::int from public.product_purchase_cost_events`)
const po7 = await savePo(supA, [{ product_id: P, quantity: 1, unit_price: 777 }])
await openPo(po7)
await receive(po7, [line((await poLines(po7))[0], 1)])
ok('after the rollback, purchasing works and records no cost events', (await owner(`select count(*)::int from public.product_purchase_cost_events`)) === evRolled)
await db.exec(await read(path.join(migDir, '20261123090000_purchase_cost_intelligence.sql')))
await db.exec(await read(path.join(migDir, '20261123090000_purchase_cost_intelligence.sql')))
ok('the migration applies again, twice', (await owner(`select count(*)::int from pg_trigger where tgname like '%purchase_cost%' and not tgisinternal`)) === 3)

console.log(`${failed === 0 ? '✓' : '✗'} purchase cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
