// Purchase & GRN permanent delete (migration 20261126090000): database checks.
//
//   npm run test:db:purchase-delete
//
// Local PGlite database only (never the live ALTON V2 project). Builds company A with the whole
// end-to-end business flow, then purchase orders in every state through the ERP's own functions
// (one committed transaction per call, so deferred triggers such as purchase cost history run),
// and checks the 14 required cases:
//    1 unused draft PO deleted            8 PO with stock movements blocked
//    2 unused cancelled PO deleted        9 PO with a supplier payable / cost history blocked
//    3 unposted GRN draft deleted        10 pending approval / attachment blocked
//    4 discarded GRN draft deleted       11 company isolation
//    5 GRN draft deleted with its PO     12 preview counts = rows deleted
//    6 posted GRN never deleted          13 a failure rolls everything back
//    7 PO with a posted GRN blocked      14 repeated requests change nothing more
// plus record selection, readable reasons and the audit entry.

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
const passwordNow = () => [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]
/** Runs one request as a user in its own transaction (deferred triggers run at the commit). */
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated', amr: passwordNow() })])
      await db.exec('set local role authenticated')
    }
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* already ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => {
  const r = await request(user, sql, params)
  if (r.error) throw new Error(`${sql.slice(0, 80)}… → ${r.error}`)
  return r.value
}
const op = as('op')
const bop = as('b_op')
const owner = async (sql, params) => { await db.exec('reset role'); return val(sql, params) }
const ownerExec = async (sql) => { await db.exec('reset role'); await db.exec(sql) }
const A = await owner(`select rls_test.id('company_a')::text`)
const B = await owner(`select rls_test.id('company_b')::text`)
const count = (table, where = '', params = []) => owner(`select count(*)::int from public.${table} where ${where || 'true'}`, params)

// ---------------------------------------------------------------------------
// Fixtures: purchase orders in every state (company A), one draft in company B
// ---------------------------------------------------------------------------
await ownerExec(`insert into rls_test.ids (key, id) values ('pd_admin', 'e7e5c800-0000-4000-8000-0000000000d7');
  insert into auth.users (id, email) values (rls_test.id('pd_admin'), 'pd_admin@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('pd_admin');
  insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('pd_admin'), rls_test.id('company_a'), rls_test.id('role_admin'))`)
const header = await owner(`select jsonb_build_object('supplier_id', rls_test.gid('sup', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'))`)
const lines = await owner(`select jsonb_build_array(jsonb_build_object('product_id', rls_test.id('clay'), 'quantity', 10, 'unit_price', 20))`)
const newPo = async () => (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`, [header, lines])).po_id
const action = (po, a, note = null) => op(`select public.purchase_order_action($1, $2, $3)`, [po, a, note])
const openPo = (po) => op(`select public.purchase_order_open($1)`, [po])
const receive = async (po, qty) => op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text),
  jsonb_build_array(jsonb_build_object('po_line_id', rls_test.po_line($1, rls_test.id('clay')), 'received_quantity', $2::numeric, 'accepted_quantity', $2::numeric,
    'rejected_quantity', 0, 'accepted_location_id', rls_test.id('g1'))), gen_random_uuid())`, [po, qty])
const grnDraft = (record, scope) => op(`select public.erp_form_draft_save('purchase.receipt', $1, $2, '{"header":{"notes":"half typed"},"rows":[]}'::jsonb, null, null)`, [record, scope])
const poNo = (po) => owner(`select po_number from public.purchase_orders where id = $1`, [po])

// Drafts the end-to-end flow already left (eligible as well).
const E2E = (await owner(`select coalesce(array_agg(id::text), '{}') from public.purchase_orders where company_id = $1 and status in ('DRAFT', 'CANCELLED')`, [A]))
const P1 = await newPo()                                                           // 1 unused draft
const P2 = await newPo(); await action(P2, 'CANCEL', 'Not needed any more')        // 2 cancelled, never opened
const P3 = await newPo(); await openPo(P3); await action(P3, 'CANCEL', 'Supplier declined')   // 2 opened, then cancelled (no stock)
const P4 = await newPo(); await openPo(P4); await grnDraft(P4, 'receipt'); await action(P4, 'CANCEL', 'Goods never came')       // 5 GRN draft of an eligible PO
const P5 = await newPo(); await openPo(P5)                                         // 8 received, reversed, cancelled
const grn5 = await receive(P5, 10)
await op(`select public.goods_receipt_reverse($1, 'Wrong supplier delivered', gen_random_uuid())`, [grn5.receipt_id])
await action(P5, 'CANCEL', 'Returned all goods')
const P6 = await newPo(); await openPo(P6)                                         // 6/7 partly received, amended back to draft
const grn6 = await receive(P6, 4)
await action(P6, 'AMEND', 'Price changed by the supplier')
const P7 = await newPo()                                                           // 10 draft with an attachment
await owner(`insert into public.documents (company_id, document_type, title, related_entity_type, related_entity_id, related_reference)
  values ($1, 'PURCHASE_ORDER', 'Supplier quotation', 'SUPPLIER_PO', $2, 'quote')`, [A, P7])
const P8 = await newPo()                                                           // 10 draft with a pending approval request
await owner(`insert into public.approval_workflows (id, company_id, name, document_type) values ('e7e5c800-0000-4000-8000-0000000000f1', $1, 'PD test workflow', 'SALES_ORDER')`, [A])
await owner(`insert into public.approval_requests (company_id, workflow_id, workflow_version, workflow_snapshot, document_type, document_id, document_reference, document_fingerprint)
  values ($1, 'e7e5c800-0000-4000-8000-0000000000f1', 1, '{}', 'PURCHASE_ORDER', $2, 'pd', 'pd')`, [A, P8])
const P9 = await newPo(); await action(P9, 'SUBMIT')                               // 10 waiting for approval (PENDING_APPROVAL)
const P10 = await newPo(); await openPo(P10)                                       // open order (never a candidate)
await grnDraft(null, 'direct')                                                     // 3 GRN draft without a PO
const G1 = await owner(`select id from public.erp_form_drafts where form_key = 'purchase.receipt' and record_id is null and scope = 'direct'`)
await grnDraft(P10, 'receipt')
await op(`select public.erp_form_draft_close('purchase.receipt', $1, 'receipt', 'discarded')`, [P10])  // 4 discarded GRN draft
const G2 = await owner(`select id from public.erp_form_drafts where form_key = 'purchase.receipt' and record_id = $1`, [P10])
const G4 = await owner(`select id from public.erp_form_drafts where form_key = 'purchase.receipt' and record_id = $1`, [P4])
// Company B: its own draft purchase order.
const supB = await bop(`select public.party_save(null, jsonb_build_object('party_type', 'SUPPLIER', 'party_name', 'B Supplier', 'state_code', '27'), false, gen_random_uuid())`)
const prodB = await owner(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status)
  values ($1, 'B-RM', 'B raw material', 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE') returning id`, [B])
const PB = (await bop(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
  [{ supplier_id: supB.supplier_id, purchase_type: 'RAW_MATERIAL', warehouse_id: await owner(`select rls_test.id('wb')`) }, [{ product_id: prodB, quantity: 3, unit_price: 5 }]])).po_id
const N = Object.fromEntries(await Promise.all(Object.entries({ P1, P2, P3, P4, P5, P6, P7, P8, P9, P10 }).map(async ([k, v]) => [k, await poNo(v)])))
console.log('✓ fixtures:', Object.entries(N).map(([k, v]) => `${k}=${v}`).join(' '))

// What must never change.
const integrity = async () => owner(`select jsonb_build_object(
  'grn', (select count(*) from public.goods_receipts where company_id = $1),
  'grn_lines', (select count(*) from public.goods_receipt_lines where company_id = $1),
  'tx', (select count(*) from public.inventory_transactions where company_id = $1),
  'bal', (select sum(on_hand)::text || '/' || sum(reserved)::text from public.inventory_balances where company_id = $1),
  'cost', (select count(*) from public.product_purchase_cost_events where company_id = $1),
  'payments', (select count(*) from public.supplier_payments where company_id = $1),
  'invoices', (select count(*) from public.sales_invoices where company_id = $1),
  'payable', (select string_agg(party_code || ':' || payable, ',' order by party_code) from private.party_balances($1) where payable <> 0),
  'b', (select count(*) from public.purchase_orders where company_id = $2) || '/' || (select count(*) from public.purchase_order_lines where company_id = $2))`, [A, B])
const before = await integrity()
ok('fixtures: P5 has cost history and stock movements; P6 has a posted GRN', (await count('product_purchase_cost_events', 'purchase_order_id = $1', [P5])) >= 2
  && (await count('goods_receipts', `purchase_order_id = $1 and status = 'POSTED'`, [P6])) === 1 && (await count('goods_receipts', `purchase_order_id = $1 and status = 'REVERSED'`, [P5])) === 1)

const CATS = ['purchase.unposted_orders', 'purchase.unposted_receipts']
const preview = (user, keys = null) => request(user, keys ? `select public.department_data_preview_records('PURCHASE', 'DELETE', $1::text[], $2::text[])`
  : `select public.department_data_preview('PURCHASE', 'DELETE', $1::text[])`, keys ? [CATS, keys] : [CATS])
const backup = async (user = 'op') => (await as(user)(`select public.erp_force_reset_record_backup(rls_test.id($1), 'PG_DUMP', 'dump-' || gen_random_uuid(), now() - interval '5 minutes', true, true, null)`,
  [user === 'b_op' ? 'company_b' : 'company_a'])).id
const execute = async (user, hash, { keys = null, request: req = crypto.randomUUID(), backupId } = {}) => request(user, keys
  ? `select public.department_data_execute_records('PURCHASE', 'DELETE', $1::text[], $2, 'DELETE PURCHASE', $3::uuid, $4::uuid, $5::text[])`
  : `select public.department_data_execute('PURCHASE', 'DELETE', $1::text[], $2, 'DELETE PURCHASE', $3::uuid, $4::uuid)`,
keys ? [CATS, hash, backupId ?? await backup(user), req, keys] : [CATS, hash, backupId ?? await backup(user), req])
const blockedOf = (p, key) => p.blocked.find((b) => b.key === key)
const recordOf = (p, key) => p.records.find((r) => r.key === key)

// ---------------------------------------------------------------------------
console.log('\nPreview: eligible and blocked records with every reason')
const p0 = (await preview('op')).value
ok('eligible: unused draft, cancelled, opened-then-cancelled and cancelled-with-GRN-draft orders, and both unposted GRN drafts',
  JSON.stringify(p0.records.map((r) => r.key).sort()) === JSON.stringify([...E2E, P1, P2, P3, P4, G1, G2].sort()) && p0.records_total === 6 + E2E.length, p0.records)
ok('each eligible record shows number, type and status', recordOf(p0, P1).record === N.P1 && recordOf(p0, P1).type === 'PO' && recordOf(p0, P1).status === 'DRAFT'
  && recordOf(p0, P2).status === 'CANCELLED' && recordOf(p0, G1).type === 'GRN draft' && recordOf(p0, G1).status === 'DRAFT' && recordOf(p0, G2).status === 'DISCARDED'
  && recordOf(p0, G2).record === `GRN draft for ${N.P10}`, p0.records)
ok('5: the GRN draft of the cancelled order is part of that order (deleted with it)', recordOf(p0, P4).tables.erp_form_drafts === 1 && !recordOf(p0, G4), recordOf(p0, P4))
ok('6/7: the draft with a posted GRN is blocked, naming the GRN, its stock movement and the earlier approval',
  blockedOf(p0, P6)?.reasons.some((r) => /^Posted goods receipt/.test(r)) && blockedOf(p0, P6).reasons.some((r) => /amended back to draft \(revision 1\)/.test(r))
  && blockedOf(p0, P6).references.some((x) => x.table === 'goods_receipts' && x.record === grn6.receipt_number)
  && blockedOf(p0, P6).references.some((x) => x.table === 'inventory_transactions' && /^TXN-/.test(x.record)) && blockedOf(p0, P6).status === 'DRAFT', blockedOf(p0, P6))
ok('8/9: the cancelled order whose GRN was reversed is blocked: reversed GRN, stock movements, purchase cost history',
  blockedOf(p0, P5)?.reasons.some((r) => /posted and later reversed/.test(r)) && blockedOf(p0, P5).reasons.includes('Stock movement posted for this order')
  && blockedOf(p0, P5).reasons.includes('Purchase cost history was recorded from this order')
  && blockedOf(p0, P5).references.some((x) => x.record === grn5.receipt_number) && blockedOf(p0, P5).status === 'CANCELLED', blockedOf(p0, P5))
ok('10: the draft with a pending approval request and the draft with an attachment are blocked',
  blockedOf(p0, P8)?.reasons.includes('Waiting for approval (active approval request)')
  && blockedOf(p0, P7)?.reasons.includes('Has an attached file (attachments are kept permanently)')
  && blockedOf(p0, P7).references.some((x) => x.record === 'Attachment: Supplier quotation'), [blockedOf(p0, P7), blockedOf(p0, P8)])
ok('10: an order waiting for approval and an open order are never candidates; posted GRNs are never in a plan',
  !JSON.stringify(p0).includes(P9) && !JSON.stringify(p0).includes(P10 + '"') && !p0.tables.goods_receipts && !p0.tables.goods_receipt_lines
  && !p0.tables.inventory_transactions, p0.tables)
ok('the preview shows exactly 4 blocked records, each with the document number', p0.blocked_total === 4
  && [N.P5, N.P6, N.P7, N.P8].every((n) => p0.blocked.some((b) => b.record === n)), p0.blocked.map((b) => b.record))
const ov = (await request('op', `select public.department_data_overview()`)).value
const pc = ov.departments.find((d) => d.department === 'PURCHASE').categories
ok('the overview counts agree with the preview (orders and 2 GRN drafts eligible, 4 blocked)',
  pc.find((c) => c.code === 'purchase.unposted_orders')?.records === 4 + E2E.length && pc.find((c) => c.code === 'purchase.unposted_orders')?.blocked === 4
  && pc.find((c) => c.code === 'purchase.unposted_receipts')?.records === 2, pc)

// ---------------------------------------------------------------------------
console.log('\nSecurity and company isolation')
await db.exec('reset role')
ok('anon cannot call the new functions', !(await val(`select has_function_privilege('anon', 'public.department_data_execute_records(text, text, text[], text, text, uuid, uuid, text[])', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.department_data_preview_records(text, text, text[], text[])', 'EXECUTE')`)))
ok('signed-in users cannot call the private planner, preview or execution', !(await val(`select has_function_privilege('authenticated', 'private.dept_execute(text, text, text[], text, text, uuid, uuid, text[])', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('authenticated', 'private.dept_plan(uuid, text, text, text[], text[])', 'EXECUTE')`)))
const adminTry = await preview('pd_admin', [P1])
const adminRun = await request('pd_admin', `select public.department_data_execute_records('PURCHASE', 'DELETE', $1::text[], 'x', 'DELETE PURCHASE', null, gen_random_uuid(), $2::text[])`, [CATS, [P1]])
ok('an Admin who is not Super Admin is refused (preview and delete)', /Only an active Super Admin/.test(adminTry.error ?? '') && /Only an active Super Admin/.test(adminRun.error ?? ''), [adminTry, adminRun])
const pB = (await preview('b_op')).value
ok('11: company B sees only its own draft order', pB.records.length === 1 && pB.records[0].key === PB && !JSON.stringify(pB).includes(N.P1), pB.records)
const pBa = (await preview('b_op', [P1, P2])).value
ok("11: company B selecting company A's orders gets nothing", pBa.records_total === 0 && pBa.total === 0, pBa)
const pAb = (await preview('op', [PB])).value
const rAb = (await execute('op', pAb.plan_hash, { keys: [PB] })).value
ok("11: company A selecting company B's order gets nothing; a delete with it stops and changes nothing",
  pAb.records_total === 0 && rAb?.status === 'BLOCKED' && /Nothing is eligible/.test(rAb.error_message) && (await count('purchase_orders', 'id = $1', [PB])) === 1, rAb)

// ---------------------------------------------------------------------------
console.log('\nSelected records only')
const p1 = (await preview('op', [P1])).value
ok('preview of one selected order: its own rows only', p1.records_total === 1 && p1.records[0].key === P1 && p1.tables.purchase_orders === 1 && p1.blocked_total === 0, p1)
const linesBefore = await count('purchase_order_lines', `company_id = $1`, [A])
const r1 = (await execute('op', p1.plan_hash, { keys: [P1] })).value
ok('1: the unused draft is deleted with its lines and history; per-table counts = preview', r1?.status === 'COMPLETED'
  && (await count('purchase_orders', 'id = $1', [P1])) === 0 && (await count('purchase_order_events', 'purchase_order_id = $1', [P1])) === 0
  && (await count('purchase_order_lines', `company_id = $1`, [A])) === linesBefore - p1.tables.purchase_order_lines
  && JSON.stringify(r1.deleted_counts) === JSON.stringify(p1.tables) && r1.deleted_total === p1.total, { r1, p1: p1.tables })
ok('   the other eligible orders are untouched', (await count('purchase_orders', 'id = any ($1)', [[P2, P3, P4]])) === 3)
const audit1 = await owner(`select metadata from public.audit_logs where action = 'department_data.completed' and request_id = $1`, [r1.request_id])
ok('   the audit entry lists the deleted order by number', audit1?.records?.length === 1 && audit1.records[0].record === N.P1 && audit1.selected === 1, audit1)
const pBlk = (await preview('op', [P5])).value
const rBlk = (await execute('op', pBlk.plan_hash, { keys: [P5] })).value
ok('selecting a blocked order: nothing eligible, the reason is shown, a delete stops', pBlk.records_total === 0 && pBlk.blocked[0]?.key === P5
  && rBlk?.status === 'BLOCKED' && (await count('purchase_orders', 'id = $1', [P5])) === 1, rBlk)
const empty = await request('op', `select public.department_data_preview_records('PURCHASE', 'DELETE', $1::text[], '{}'::text[])`, [CATS])
ok('an empty selection is refused', /Select between 1 and 1000/.test(empty.error ?? ''), empty)

// ---------------------------------------------------------------------------
console.log('\nStale preview and failure')
const p2 = (await preview('op', [P2])).value
await grnDraft(P2, 'receipt')        // the order gains a GRN draft after the preview: the plan changes
const r2 = (await execute('op', p2.plan_hash, { keys: [P2] })).value
ok('a stale preview is rejected and nothing is deleted', r2?.status === 'BLOCKED' && /changed after the preview/.test(r2.error_message)
  && (await count('purchase_orders', 'id = $1', [P2])) === 1, r2)
await ownerExec(`create function rls_test.pd_boom() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
  create trigger zz_pd_boom before delete on public.purchase_orders for each row execute function rls_test.pd_boom()`)
const p3 = (await preview('op', [P2, G1])).value
const rowsBefore = { lines: await count('purchase_order_lines', 'purchase_order_id = $1', [P2]), events: await count('purchase_order_events', 'purchase_order_id = $1', [P2]),
  drafts: await count('erp_form_drafts', 'id = $1 or record_id = $2', [G1, P2]) }
const r3 = (await execute('op', p3.plan_hash, { keys: [P2, G1] })).value
ok('13: a failure half-way is FAILED with the reason, and audited', r3?.status === 'FAILED' && /injected failure/.test(r3.error_message)
  && (await count('audit_logs', `action = 'department_data.failed' and request_id = $1`, [r3.request_id])) === 1, r3)
ok('13: ... and everything is rolled back (lines, history and GRN drafts deleted before the failure are back)',
  (await count('purchase_orders', 'id = $1', [P2])) === 1 && (await count('purchase_order_lines', 'purchase_order_id = $1', [P2])) === rowsBefore.lines
  && (await count('purchase_order_events', 'purchase_order_id = $1', [P2])) === rowsBefore.events && (await count('erp_form_drafts', 'id = $1 or record_id = $2', [G1, P2])) === rowsBefore.drafts
  && rowsBefore.lines > 0 && rowsBefore.drafts === 2, rowsBefore)
await owner(`drop trigger zz_pd_boom on public.purchase_orders`)

// ---------------------------------------------------------------------------
console.log('\nDelete everything eligible')
const p4 = (await preview('op')).value
const tablesBefore = Object.fromEntries(await Promise.all(Object.keys(p4.tables).map(async (t) => [t, await count(t, 'company_id = $1', [A])])))
const req = crypto.randomUUID()
const bk = await backup()
const r4 = (await execute('op', p4.plan_hash, { request: req, backupId: bk })).value
const tablesAfter = Object.fromEntries(await Promise.all(Object.keys(p4.tables).map(async (t) => [t, await count(t, 'company_id = $1', [A])])))
ok('12: completed; rows deleted per table = preview', r4?.status === 'COMPLETED' && r4.deleted_total === p4.total
  && Object.entries(p4.tables).every(([t, n]) => tablesBefore[t] - tablesAfter[t] === n), { p: p4.tables, before: tablesBefore, after: tablesAfter, r4 })
ok('2: both cancelled orders are deleted', (await count('purchase_orders', 'id = any ($1)', [[P2, P3]])) === 0)
ok('5: the cancelled order and its GRN draft were deleted together', (await count('purchase_orders', 'id = $1', [P4])) === 0 && (await count('erp_form_drafts', 'id = $1', [G4])) === 0)
ok('3/4: the unposted and the discarded GRN drafts are deleted', (await count('erp_form_drafts', 'id = any ($1)', [[G1, G2]])) === 0)
ok('6-10: every blocked order is kept, with its GRN', (await count('purchase_orders', 'id = any ($1)', [[P5, P6, P7, P8, P9, P10]])) === 6
  && (await count('goods_receipts', 'id = any ($1)', [[grn5.receipt_id, grn6.receipt_id]])) === 2)
ok('6/8/9: GRNs, stock movements, balances, cost history, payables, payments and company B unchanged', JSON.stringify(await integrity()) === JSON.stringify(before),
  { before, after: await integrity() })
const audit4 = await owner(`select metadata from public.audit_logs where action = 'department_data.completed' and request_id = $1`, [req])
ok('the audit entry lists every deleted record', audit4?.records?.length === p4.records_total && [N.P2, N.P3, N.P4].every((n) => audit4.records.some((x) => x.record === n)), audit4)

// ---------------------------------------------------------------------------
console.log('\nRepeated requests')
const r5 = (await execute('op', p4.plan_hash, { request: req, backupId: bk })).value
ok('14: the same request again returns the stored result and changes nothing', r5?.replayed === true && r5.id === r4.id && JSON.stringify(await integrity()) === JSON.stringify(before), r5)
const r6 = (await execute('op', p4.plan_hash)).value
ok('14: a new request with the old preview stops (data changed); nothing more is deleted', r6?.status === 'BLOCKED' && /changed after the preview/.test(r6.error_message)
  && (await count('purchase_orders', 'id = any ($1)', [[P5, P6, P7, P8, P9, P10]])) === 6, r6)
const p7 = (await preview('op')).value
ok('a fresh preview: nothing eligible, the 4 blocked orders with their reasons', p7.records_total === 0 && p7.total === 0 && p7.blocked_total === 4
  && p7.blocked.every((b) => b.reasons.length > 0 && b.type === 'PO'), p7)
const r7 = (await execute('op', p7.plan_hash)).value
ok('deleting with nothing eligible stops and changes nothing', r7?.status === 'BLOCKED' && /Nothing is eligible/.test(r7.error_message), r7)

// ---------------------------------------------------------------------------
console.log('\nGuards')
const g1 = await request('op', `delete from public.purchase_order_events where purchase_order_id = $1`, [P5])
const g2 = await request(null, `delete from public.goods_receipts where id = $1`, [grn6.receipt_id])
ok('history and posted GRNs still cannot be deleted directly', (await count('purchase_order_events', 'purchase_order_id = $1', [P5])) > 0
  && (await count('goods_receipts', 'id = $1', [grn6.receipt_id])) === 1, [g1, g2])
ok('no guard session is left behind', (await owner(`select count(*)::int from private.dept_purge_sessions`)) === 0)

console.log(`${failed === 0 ? '✓' : '✗'} purchase permanent delete check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
