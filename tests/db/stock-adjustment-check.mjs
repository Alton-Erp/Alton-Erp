// Stock Adjustments (existing workflow + migration 20261201090000): database checks.
//
//   npm run test:db:stock-adjustment
//
// Local PGlite database only. Every step goes through the ERP's own functions, one committed
// transaction per call: draft, submit, segregation of duties, approve and post, reject, positive and
// negative differences, duplicate protection, configured reasons, permissions, company isolation,
// attachments, the ledger / audit trail, untouched modules, and the rollback.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = '20261201090000_stock_adjustments.sql'
const ROLLBACK = path.join(root, 'supabase', 'rollback', '20261201090000_stock_adjustments_down.sql')
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of files) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow')

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
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const op = as('op')
const A = await val(`select rls_test.id('company_a')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)
const today = await val(`select rls_test.today()::text`)

// Users: an Inventory Manager (adjust + approve) and a Management Viewer (read only).
await db.exec(`reset role;
  insert into rls_test.ids (key, id) values ('adj_mgr', 'e7e5c800-0000-4000-8000-0000000000e1'), ('adj_view', 'e7e5c800-0000-4000-8000-0000000000e2');
  insert into auth.users (id, email) values (rls_test.id('adj_mgr'), 'adj_mgr@e7.example.invalid'), (rls_test.id('adj_view'), 'adj_view@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id in (rls_test.id('adj_mgr'), rls_test.id('adj_view'));
  insert into public.user_roles (user_id, company_id, role_id) values
    (rls_test.id('adj_mgr'), rls_test.id('company_a'), rls_test.id('role_inventory_manager')),
    (rls_test.id('adj_view'), rls_test.id('company_a'), rls_test.id('role_management_viewer'))`)
const mgr = as('adj_mgr')

// A product with 50 PCS opening stock at the GENERAL location.
const P = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, 'ADJ-1', 'Adjusted basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 20, 18, '6910') returning id`, [A])
const posted = await op(`select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`,
  [JSON.stringify([{ line_no: 1, product_id: P, location_id: g1, source_type: 'IN_HOUSE', quantity: 50, unit: 'PCS', effective_date: today }])])
if (!posted?.ok) { console.error('✗ fixture opening stock', posted); process.exit(1) }
const lot = await val(`select batch_id::text from public.inventory_balances where product_id = $1 and location_id = $2`, [P, g1])
const onHand = () => val(`select coalesce(sum(on_hand), 0)::float8 from public.inventory_balances where product_id = $1`, [P])
const ledger = (type = null) => val(`select count(*)::int from public.inventory_transactions where product_id = $1 and ($2::text is null or transaction_type = $2)`, [P, type])
const adj = (id) => val(`select to_jsonb(a) from public.inventory_adjustments a where id = $1`, [id])
const create = (user, { counted, reason = 'Damaged', submit = true, key = crypto.randomUUID(), code = 'DAMAGE', notes = 'Shelf count' }) => request(user,
  `select public.inventory_create_adjustment_v2($1, 'QUANTITY', $2::uuid, $3::uuid, $4, p_batch_id => $5::uuid, p_counted_quantity => $6::numeric,
     p_notes => $7, p_submit => $8, p_idempotency_key => $9::uuid)`, [reason, P, g1, code, lot, counted, notes, submit, key])
const review = (user, id, decision, note = null, key = crypto.randomUUID()) => request(user, `select public.inventory_review_adjustment($1::uuid, $2, $3, $4::uuid)`, [id, decision, note, key])

// What must never change.
const frozen = () => val(`select md5(concat_ws('|',
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_opening_lines x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.goods_receipts x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.purchase_orders x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.production_orders x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.outsourcing_orders x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.fulfilments x),
  (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_transactions x where x.transaction_type not like 'ADJUSTMENT%')))`)
const frozenBefore = await frozen()
const ledgerTotal = () => val(`select count(*)::int from public.inventory_transactions`)

// ---------------------------------------------------------------------------
console.log('\nDraft and submit')
const d = await create('op', { counted: 45, submit: false })
const draft = await adj(d.value?.adjustment_id)
ok('1. draft saved with the system stock read from the ledger (50), counted 45, difference −5', draft?.status === 'DRAFT' && Number(draft.system_quantity) === 50
  && Number(draft.counted_quantity) === 45 && Number(draft.difference) === -5, draft ?? d)
ok('1. the configured reason is stored (Damaged), with its category', draft?.reason_label === 'Damaged' && draft.reason_code === 'DAMAGE', draft)
ok('1. a draft changes no stock and writes no ledger entry', (await onHand()) === 50 && (await ledger('ADJUSTMENT_OUT')) === 0)
await op(`select public.inventory_update_adjustment_status($1, 'SUBMIT')`, [d.value.adjustment_id])
ok('2. submitted for approval: still no stock change', (await adj(d.value.adjustment_id)).status === 'PENDING_APPROVAL' && (await onHand()) === 50 && (await ledger('ADJUSTMENT_OUT')) === 0)
const mgrSubmit = await request('adj_mgr', `select public.inventory_update_adjustment_status($1, 'CANCEL')`, [d.value.adjustment_id])
ok('2. only the requester can submit or cancel their request', /Only the requester/.test(mgrSubmit.error ?? ''), mgrSubmit)

// ---------------------------------------------------------------------------
console.log('\nApproval, segregation of duties and posting')
await db.exec('reset role')
await db.query(`insert into public.company_settings (company_id, setting_key, setting_value) values ($1, 'inventory.segregation_of_duties', 'true'::jsonb)
  on conflict (company_id, setting_key) do update set setting_value = excluded.setting_value`, [A])
const self = await review('op', d.value.adjustment_id, 'APPROVE')
ok('3. segregation of duties ON: the requester cannot approve their own adjustment', /Segregation/i.test(self.error ?? '') && (await onHand()) === 50, self)
const viewerApprove = await review('adj_view', d.value.adjustment_id, 'APPROVE')
ok('3. a user without the approval permission cannot approve', /not allowed/i.test(viewerApprove.error ?? ''), viewerApprove)
const key = crypto.randomUUID()
const ap = await review('adj_mgr', d.value.adjustment_id, 'APPROVE', 'Checked on the shelf', key)
const a1 = await adj(d.value.adjustment_id)
ok('4. another user approves: POSTED with an ADJUSTMENT_OUT of 5; stock 45', ap.value?.status === 'POSTED' && a1.status === 'POSTED' && (await onHand()) === 45
  && (await ledger('ADJUSTMENT_OUT')) === 1, ap)
const tx = await val(`select to_jsonb(t) from public.inventory_transactions t where t.product_id = $1 and t.transaction_type = 'ADJUSTMENT_OUT'`, [P])
ok('4. the ledger entry carries the adjustment as its document and reason', tx.reference_type === 'ADJUSTMENT' && tx.reference_id === d.value.adjustment_id
  && Number(tx.quantity) === 5 && Number(tx.direction) === -1 && /Adjustment ADJ-\d+ \(damage\)/.test(tx.reason ?? ''), tx)
ok('4. requested by, approved by and timestamps are kept; before (50) and after (45) quantities kept', a1.requested_by === await val(`select rls_test.id('op')::text`)
  && a1.reviewed_by === await val(`select rls_test.id('adj_mgr')::text`) && a1.reviewed_at && a1.posted_at && a1.submitted_at
  && Number(a1.system_quantity) === 50 && Number(a1.counted_quantity) === 45, a1)
ok('4. audit trail: requested and posted entries', (await val(`select count(*)::int from public.audit_logs where resource_id = $1 and action in ('inventory.adjustment_requested', 'inventory.adjustment_posted')`,
  [d.value.adjustment_id])) === 2)
const again = await review('adj_mgr', d.value.adjustment_id, 'APPROVE', null, key)
const twice = await review('adj_mgr', d.value.adjustment_id, 'APPROVE')
ok('5. duplicate posting: the same request returns the stored result; a second approval is refused; still one ledger entry',
  again.value?.status === 'POSTED' && /only pending adjustments can be reviewed/.test(twice.error ?? '') && (await ledger('ADJUSTMENT_OUT')) === 1 && (await onHand()) === 45, [again, twice])

// Positive difference.
const plus = await create('op', { counted: 60, reason: 'found in stock', code: 'FOUND', notes: 'Found behind rack' })
const plusRow = await adj(plus.value?.adjustment_id)
ok('6. reason matched to the configured list ignoring case ("found in stock" → "Found in stock")', plusRow?.reason_label === 'Found in stock' && plusRow.status === 'PENDING_APPROVAL', plusRow ?? plus)
await mgr(`select public.inventory_review_adjustment($1, 'APPROVE', null, gen_random_uuid())`, [plus.value.adjustment_id])
ok('6. positive difference: ADJUSTMENT_IN of 15; stock 60', (await ledger('ADJUSTMENT_IN')) === 1 && (await onHand()) === 60)

// Reject.
const rej = await create('op', { counted: 10, reason: 'Count correction', code: 'COUNT_VARIANCE' })
const noReason = await review('adj_mgr', rej.value.adjustment_id, 'REJECT', '  ')
ok('7. rejecting needs a reason', /reason for rejecting/i.test(noReason.error ?? ''), noReason)
await mgr(`select public.inventory_review_adjustment($1, 'REJECT', 'Recount needed: rack B not counted', gen_random_uuid())`, [rej.value.adjustment_id])
const rejRow = await adj(rej.value.adjustment_id)
ok('7. rejected: the reason is recorded and stock does not change', rejRow.status === 'REJECTED' && rejRow.review_note === 'Recount needed: rack B not counted' && (await onHand()) === 60)
ok('7. a rejected adjustment cannot be approved later', /only pending/.test((await review('adj_mgr', rej.value.adjustment_id, 'APPROVE')).error ?? ''))

// Switch OFF (V2 default): a single operator may approve their own, also in one step.
await db.exec('reset role')
await db.query(`update public.company_settings set setting_value = 'false'::jsonb where company_id = $1 and setting_key = 'inventory.segregation_of_duties'`, [A])
const one = await request('op', `select public.inventory_post_adjustment_v2('Damaged', 'QUANTITY', $1::uuid, $2::uuid, 'DAMAGE', p_batch_id => $3::uuid,
  p_counted_quantity => 58, p_notes => 'Two cracked', p_idempotency_key => gen_random_uuid())`, [P, g1, lot])
ok('8. segregation OFF: the operator records and posts in one step (follows the company switch)', one.value?.status === 'POSTED' && (await onHand()) === 58
  && (await adj(one.value.adjustment_id)).reason_label === 'Damaged', one)

// ---------------------------------------------------------------------------
console.log('\nReasons, permissions and isolation')
const badReason = await create('op', { counted: 1, reason: 'Eaten by mice' })
ok('9. a reason that is not in ERP Settings is refused', /Select a stock adjustment reason/.test(badReason.error ?? ''), badReason)
const noReasonQty = await create('op', { counted: 1, reason: null })
ok('9. a quantity adjustment needs a reason', /Select a stock adjustment reason/.test(noReasonQty.error ?? ''), noReasonQty)
const viewerCreate = await create('adj_view', { counted: 1 })
ok('10. a user without inventory.adjust cannot record an adjustment', /not allowed/i.test(viewerCreate.error ?? ''), viewerCreate)
const direct = await request('op', `update public.inventory_balances set on_hand = 999 where product_id = $1`, [P])
const directIns = await request('op', `insert into public.inventory_adjustments (company_id, adjustment_number, adjustment_type, product_id, warehouse_id, location_id,
  source_type, system_quantity, counted_quantity, reason_code, effective_date, status) select company_id, 'X-1', 'QUANTITY', product_id, warehouse_id, location_id,
  'IN_HOUSE', 0, 1, 'OTHER', current_date, 'POSTED' from public.inventory_balances where product_id = $1 limit 1`, [P])
ok('10. no direct change of balances or adjustments from the client', (Boolean(direct.error) || (await onHand()) === 58) && Boolean(directIns.error) && (await onHand()) === 58, [direct, directIns])
const bSee = await request('b_op', `select count(*)::int from public.inventory_adjustments where company_id = $1`, [A])
const bReview = await review('b_op', d.value.adjustment_id, 'APPROVE')
ok('11. company B sees none of company A\'s adjustments and cannot review them', bSee.value === 0 && /not found|not allowed/i.test(bReview.error ?? ''), [bSee, bReview])
ok('11. anon cannot call the new functions', !(await val(`select has_function_privilege('anon', 'public.inventory_create_adjustment_v2(text, text, uuid, uuid, text, uuid, text, text, numeric, numeric, text, numeric, text, text, date, boolean, uuid)', 'EXECUTE')`)))

// ---------------------------------------------------------------------------
console.log('\nAttachments and safety')
await db.exec('reset role')
const docId = await val(`insert into public.documents (company_id, document_type, title, related_entity_type, related_entity_id, related_reference)
  values ($1, 'PHOTO', 'Damaged cartons', 'STOCK_ADJUSTMENT', $2, 'adj') returning id::text`, [A, d.value.adjustment_id])
const ent = (await db.query(`select * from private.document_entity($1, 'STOCK_ADJUSTMENT', $2)`, [A, d.value.adjustment_id])).rows[0]
ok('12. a file can be attached to a stock adjustment and links back to it', Boolean(docId) && /^ADJ-/.test(ent?.reference ?? '') && ent.read_permission === 'inventory.read'
  && ent.link === `/inventory/adjustments?adj=${d.value.adjustment_id}`, ent)
const found = await op(`select public.document_entity_search('STOCK_ADJUSTMENT', $1)`, [a1.adjustment_number])
ok('12. the documents page can find stock adjustments', found?.[0]?.id === d.value.adjustment_id, found)
ok('12. the ERP reset knows the new attachment type', (await val(`select 'STOCK_ADJUSTMENT' = any(private.erp_reset_document_entity_types())`)) === true)
ok('13. opening stock, GRNs, POs, production, outsourcing, fulfilment and non-adjustment ledger entries are unchanged', (await frozen()) === frozenBefore)
ok('13. the ledger only grew by the three posted adjustments (no rewrite)', (await ledger('ADJUSTMENT_OUT')) === 2 && (await ledger('ADJUSTMENT_IN')) === 1 && (await ledgerTotal()) > 0)

// ---------------------------------------------------------------------------
console.log('\nRollback')
await db.exec('reset role')
let refused = null
try { await db.exec(await read(ROLLBACK)) } catch (e) { refused = e.message }
ok('the rollback refuses while files are attached to stock adjustments', /Documents are attached to stock adjustments/.test(refused ?? ''), refused ?? 'ran')
// Fresh databases: before the migration, and after migration + rollback.
const fresh = async (upTo) => {
  const x = new PGlite()
  await x.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
  for (const f of files.filter((n) => !upTo || n < upTo)) await x.exec(await read(path.join(migDir, f)))
  return x
}
const defs = async (x) => (await x.query(`select string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)), ';' order by 1) d from pg_proc p
  where p.proname in ('document_entity', 'document_entity_permission', 'document_entity_search', 'erp_reset_document_entity_types')`)).rows[0].d
  + (await x.query(`select pg_get_constraintdef(oid) c from pg_constraint where conname = 'documents_related_entity_type_check'`)).rows[0].c
  + (await x.query(`select count(*)::text n from information_schema.columns where table_name = 'inventory_adjustments'`)).rows[0].n
const before = await fresh(MIGRATION)
const after = await fresh(null)
await after.exec(await read(ROLLBACK))
ok('rollback restores the document functions, the entity check and the adjustments table exactly', (await defs(after)) === (await defs(before)))
ok('rollback removes the two new functions', (await after.query(`select count(*)::int n from pg_proc where proname in ('inventory_create_adjustment_v2', 'inventory_post_adjustment_v2', 'adjustment_reason_label')`)).rows[0].n === 0)
await after.exec(await read(path.join(migDir, MIGRATION)))
await after.exec(await read(path.join(migDir, MIGRATION)))
ok('the migration applies again, twice', (await after.query(`select count(*)::int n from pg_proc where proname = 'inventory_create_adjustment_v2'`)).rows[0].n === 1)

console.log(`${failed === 0 ? '✓' : '✗'} stock adjustment check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
