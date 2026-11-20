// Bulk BOM management (migration 20261218090000): where-used, bulk replace / delete / add / edit,
// approval workflow, atomic publishing as new revisions, effective dates, reversal, isolation.
//
//   npm run test:db:bom-bulk
//
// Local PGlite database only (throwaway, in memory). One committed transaction per call, as the app does.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261218090000_bom_bulk_changes'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log(`✓ migrations before ${NAME} applied, end-to-end business flow`)

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params, { readOnly = false } = {}) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
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
const op = async (sql, params, user = 'op') => { const r = await request(user, sql, params); if (r.error) throw new Error(`${sql.slice(0, 80)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)
const today = await val(`select rls_test.today()::text`)
const tomorrow = await val(`select (rls_test.today() + 1)::text`)
const yesterday = await val(`select (rls_test.today() - 1)::text`)

// Users: a second approver (Super Admin), a user who may only read BOMs, one who prepares but may not approve.
const roleWith = async (has, hasNot) => val(`select r.code from public.roles r
  where (select count(*) from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = any($1::text[])) = cardinality($1::text[])
    and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = any($2::text[]))
  order by r.code limit 1`, [has, hasNot])
const READER = await roleWith(['production_bom.read'], ['production_bom.create', 'production_bom.update', 'production_bom.approve'])
const PREPARER = await roleWith(['production_bom.read', 'production_bom.create', 'production_bom.update'], ['production_bom.approve'])
let uid = 0
const addUser = async (key, role) => {
  const id = `e7e5c800-0000-4000-8000-00000000bb${String(++uid).padStart(2, '0')}`
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${id}');
    insert into auth.users (id, email) values ('${id}', '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = '${id}';
    insert into public.user_roles (user_id, company_id, role_id) values ('${id}', rls_test.id('company_a'), (select id from public.roles where code = '${role}'))`)
}
await addUser('bb_appr', 'SUPER_ADMIN')
await db.exec(`reset role; update public.profiles set full_name = 'Operator' where id = rls_test.id('op')`)
if (READER) await addUser('bb_read', READER)
if (PREPARER) await addUser('bb_prep', PREPARER)

// Products and 100 BOMs that all use C_OLD (different quantities).
let n = 0
const product = (type, unit = 'PCS', extra = {}) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code, barcode, model_number)
  values ($1, $2, $3, $4, 'OUTSOURCED', $5, 'ACTIVE', 10, 18, '6910', $6, $7) returning id`,
  [A, extra.sku ?? `BB-${++n}`, extra.name ?? `Bulk test ${n}`, type, unit, extra.barcode ?? null, extra.model ?? null])
const item = (p, q, w = 0) => ({ component_product_id: p, quantity_required: q, unit: null, wastage_percentage: w })
const C_OLD = await product('RAW_MATERIAL', 'KG', { sku: 'BB-GLAZE-OLD', name: 'Glaze white old', barcode: 'GLZ0001', model: 'GZ-OLD-9' })
const C_NEW = await product('RAW_MATERIAL', 'KG', { sku: 'BB-GLAZE-NEW', name: 'Glaze white new' })
const C_PCS = await product('COMPONENT', 'PCS', { sku: 'BB-GLAZE-PACK', name: 'Glaze pack (pieces)' })
const C_X = await product('COMPONENT', 'PCS', { sku: 'BB-FITTING', name: 'Fitting' })
const C_ADD = await product('PACKAGING_MATERIAL', 'PCS', { sku: 'BB-BOX', name: 'Carton box' })
const C_OFF = await product('RAW_MATERIAL', 'KG', { sku: 'BB-OFF', name: 'Discontinued glaze' })
const FG = []
const BOM1 = new Map()
for (let i = 1; i <= 100; i++) {
  const fg = await product('FINISHED_GOOD', 'PCS', { sku: `BB-FG-${String(i).padStart(3, '0')}`, name: `Basin model ${i}` })
  FG.push(fg)
  const s = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`,
    [fg, JSON.stringify([item(C_OLD, (i % 7) + 0.5, 2), item(C_X, 1)])])
  await op(`select public.production_bom_activate($1, null)`, [s.bom_id])
  BOM1.set(fg, s.bom_id)
}
await op(`update public.products set status = 'INACTIVE' where id = $1`, [C_OFF])
// Circular case: FG-CA is a component of FG-CB.
const FG_CA = await product('SUBASSEMBLY', 'PCS', { sku: 'BB-SUB-A', name: 'Sub-assembly A' })
const FG_CB = await product('FINISHED_GOOD', 'PCS', { sku: 'BB-FG-CB', name: 'Basin with sub-assembly' })
const ca = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [FG_CA, JSON.stringify([item(C_OLD, 1)])])
await op(`select public.production_bom_activate($1, null)`, [ca.bom_id])
const cb = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [FG_CB, JSON.stringify([item(FG_CA, 1), item(C_X, 2)])])
await op(`select public.production_bom_activate($1, null)`, [cb.bom_id])
const FG_ONLY = await product('FINISHED_GOOD', 'PCS', { sku: 'BB-FG-ONE', name: 'Single component basin' })
const one = await op(`select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [FG_ONLY, JSON.stringify([item(C_PCS, 3)])])
await op(`select public.production_bom_activate($1, null)`, [one.bom_id])

// A production order released BEFORE any bulk change (FG-001).
const orderBefore = await op(`select public.production_order_v2_save(null, $1::jsonb, gen_random_uuid())`,
  [JSON.stringify({ product_id: FG[0], planned_quantity: 10, production_date: today })])
const orderBeforeId = orderBefore.production_order_id ?? orderBefore.id ?? await val(`select id from public.production_orders where finished_product_id = $1 order by created_at limit 1`, [FG[0]])
const matsBefore = await val(`select jsonb_agg(jsonb_build_object('c', component_product_id, 'q', planned_quantity) order by line_no) from public.production_order_materials where production_order_id = $1`, [orderBeforeId])
const otherSnapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.stock_reservations r), '')
  || coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from public.purchase_order_lines l), '')
  || coalesce((select string_agg(o.id || o.status || o.bom_id, '|' order by o.id) from public.production_orders o), ''))`)
const before = await otherSnapshot()

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)

const call = (user, fn, args, opts) => request(user, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args, opts)
const save = (user, header, lines, batchId = null, version = null) =>
  call(user, 'bom_change_batch_save', [batchId, version, JSON.stringify(header), JSON.stringify(lines)])
const act = (user, id, action, note = null, version = null) => call(user, 'bom_change_batch_action', [id, action, note, version])
const publish = (user, id, version = null) => call(user, 'bom_change_batch_publish', [id, version, crypto.randomUUID()])
const whereUsed = (user, comp, filters = {}, sort = 'sku', asc = true, limit = 50, offset = 0) =>
  call(user, 'bom_where_used', [comp, JSON.stringify(filters), sort, asc, limit, offset])
const current = (fg) => val(`select jsonb_build_object('id', b.id, 'version', b.version, 'from', b.effective_from, 'to', b.effective_to,
    'items', (select jsonb_agg(jsonb_build_object('c', i.component_product_id, 'q', i.quantity_required, 'u', i.unit, 'w', i.wastage_percentage) order by i.line_no) from public.bom_items i where i.bom_id = b.id))
  from public.boms b where b.finished_product_id = $1 and b.status = 'APPROVED' order by b.version desc limit 1`, [fg])
const itemsOf = (bomId) => val(`select jsonb_agg(jsonb_build_object('c', component_product_id, 'q', quantity_required, 'w', wastage_percentage) order by line_no) from public.bom_items where bom_id = $1`, [bomId])
const allCurrent = await whereUsed('op', C_OLD, { status: 'CURRENT' }, 'sku', true, 5000)
const linesFor = (rows, extra = {}) => rows.map((r) => ({ bom_id: r.bom_id, component_product_id: r.component_product_id, ...extra }))
const fullCycle = async (id, approver = 'op') => {
  const s = await act('op', id, 'SUBMIT')
  if (s.error) return s
  const a = await act(approver, id, 'APPROVE', 'Checked')
  if (a.error) return a
  return publish(approver, id)
}

// ---------------------------------------------------------------------------
console.log('\nWhere-used analysis')
const wu = allCurrent.value
ok('one component used in 100 BOMs: 100 current revisions found', wu?.total === 101 && wu.stats.current_boms === 101 && wu.stats.products === 101, wu && { total: wu.total, stats: wu.stats })
const page2 = (await whereUsed('op', C_OLD, { status: 'CURRENT' }, 'quantity', false, 25, 25)).value
ok('paging (25 per page, page 2) and sorting by quantity (descending)', page2.rows.length === 25 && page2.total === 101
  && page2.rows.every((r, i, a) => i === 0 || Number(a[i - 1].quantity) >= Number(r.quantity)))
const firstPage = (await whereUsed('op', C_OLD, { status: 'CURRENT' }, 'quantity', false, 25, 0)).value
ok('page 1 holds the largest quantities', Number(firstPage.rows[0].quantity) === 6.5 && Number(firstPage.rows[24].quantity) >= Number(page2.rows[0].quantity))
const filtered = (await whereUsed('op', C_OLD, { status: 'CURRENT', search: 'BB-FG-01' })).value
ok('filter by finished product SKU', filtered.total === 10 && filtered.rows.every((r) => r.sku.startsWith('BB-FG-01')), filtered.total)
const row = wu.rows.find((r) => r.sku === 'BB-FG-001')
ok('row has finished product, BOM number and revision, component, quantity, UOM, wastage, status and effective date',
  row && row.product_name === 'Basin model 1' && /^BOM-/.test(row.bom_code) && row.version === 1 && row.component_sku === 'BB-GLAZE-OLD'
  && Number(row.quantity) === 1.5 && row.unit === 'KG' && Number(row.wastage_percentage) === 2 && row.lifecycle === 'ACTIVE' && row.effective_from === today, row)
for (const [term, label] of [['glaze white old', 'name'], ['BB-GLAZE-OLD', 'SKU'], ['GZ-OLD-9', 'product / model code'], ['GLZ0001', 'barcode']]) {
  const r = (await call('op', 'bom_component_search', [term, 10])).value
  ok(`component search by ${label}`, r?.[0]?.product_id === C_OLD && Number(r[0].bom_lines) === 101, r)
}
ok('read functions run in a read-only transaction (as the app calls them)', !(await call('op', 'bom_where_used', [C_OLD, '{}', 'sku', true, 10, 0], { readOnly: true })).error
  && !(await call('op', 'bom_revision_log', ['{}', 10, 0], { readOnly: true })).error && !(await call('op', 'bom_component_search', ['BB', 5], { readOnly: true })).error)

// ---------------------------------------------------------------------------
console.log('\nBulk replace in all 100 BOMs')
const rows100 = wu.rows.filter((r) => r.sku.startsWith('BB-FG-'))
ok('100 finished goods selected', rows100.length === 100)
const noReason = await save('op', { operation: 'REPLACE', reason: '', effective_from: today }, linesFor(rows100, { new_component_product_id: C_NEW }))
ok('a reason is required', /reason/.test(noReason.error ?? ''), noReason)
const past = await save('op', { operation: 'REPLACE', reason: 'Glaze change', effective_from: yesterday }, linesFor(rows100, { new_component_product_id: C_NEW }))
ok('an effective date in the past is refused', /past/.test(past.error ?? ''), past)
const r100 = await save('op', { operation: 'REPLACE', reason: 'Supplier change: new glaze', effective_from: today, title: 'Glaze swap' }, linesFor(rows100, { new_component_product_id: C_NEW }))
const b100 = r100.value?.batch
ok('draft batch saved: 100 BOMs, 100 lines, no errors', b100?.status === 'DRAFT' && /^BCB-\d{6}$/.test(b100.batch_number) && b100.summary.boms === 100
  && b100.summary.lines === 100 && b100.summary.lines_with_errors === 0, r100.error ?? b100?.summary)
const l1 = r100.value?.lines?.find((l) => l.finished_sku === 'BB-FG-001')
ok('preview: quantities are kept by default (old 1.5 KG → new 1.5 KG, wastage kept)', Number(l1?.old_quantity) === 1.5 && Number(l1?.new_quantity) === 1.5
  && l1.old_unit === 'KG' && l1.new_unit === 'KG' && Number(l1.new_wastage) === 2 && l1.new_component_sku === 'BB-GLAZE-NEW', l1)
const imp = r100.value?.impact
ok('impact: the released production order is listed and keeps its version', imp?.production_orders?.some((o) => o.production_order_id === orderBeforeId && o.bom_version === 1)
  && imp.components.some((c) => c.product_id === C_OLD && c.roles.includes('REMOVED') && c.current_boms === 101 && c.current_boms_after === 1)
  && imp.components.some((c) => c.product_id === C_NEW && c.roles === 'ADDED'), imp)
ok('impact: stock, open purchase orders and recent consumption per component', imp?.components.every((c) => 'available' in c && 'open_po_quantity' in c && 'consumed_90_days' in c))
const pubDraft = await publish('op', b100?.id)
ok('a draft cannot be published (approval first)', /Only an approved batch/.test(pubDraft.error ?? ''), pubDraft)
const sub = await act('op', b100.id, 'SUBMIT')
ok('submitted for approval', sub.value?.batch?.status === 'PENDING_APPROVAL', sub)
ok('approvers are notified', Number(await val(`select count(*) from public.notifications where related_entity_id = $1`, [b100.id])) >= 1)
if (PREPARER) {
  const prepApprove = await act('bb_prep', b100.id, 'APPROVE')
  ok('a user without production_bom.approve cannot approve', /production_bom.approve|not allowed/.test(prepApprove.error ?? ''), prepApprove)
}
const appr = await act('bb_appr', b100.id, 'APPROVE', 'OK for production')
ok('approved by an authorised user', appr.value?.batch?.status === 'APPROVED' && appr.value.batch.approved_by_name === 'bb_appr', appr)
const v1Items = await itemsOf(BOM1.get(FG[0]))
const pub = await publish('bb_appr', b100.id)
ok('published: 100 new revisions', pub.value?.ok === true && pub.value.revisions.length === 100, pub.error ?? pub.value?.message)
const c1 = await current(FG[0])
ok('FG-001 now at v2 with the new glaze, same quantity and wastage', c1.version === 2 && c1.items.some((x) => x.c === C_NEW && Number(x.q) === 1.5 && Number(x.w) === 2)
  && !c1.items.some((x) => x.c === C_OLD), c1)
ok('the previous revision is preserved unchanged (components and values)', JSON.stringify(await itemsOf(BOM1.get(FG[0]))) === JSON.stringify(v1Items)
  && (await val(`select status from public.boms where id = $1`, [BOM1.get(FG[0])])) === 'ARCHIVED')
ok('every new revision carries the reason, batch number and approver', Number(await val(`select count(*) from public.boms b where b.change_reason like $1 and b.approved_by = rls_test.id('bb_appr') and b.status = 'APPROVED'`,
  [`${b100.batch_number} Replace: Supplier change%`])) === 100)
ok('audit: one bulk-revision record per BOM with old and new component details', Number(await val(`select count(*) from public.audit_logs where action = 'production.bom_bulk_revision'
  and metadata ->> 'batch_number' = $1 and metadata -> 'changes' -> 0 ->> 'component' = 'BB-GLAZE-OLD' and metadata -> 'changes' -> 0 ->> 'new_component' = 'BB-GLAZE-NEW'`, [b100.batch_number])) === 100)
ok('batch lines record the revision created', Number(await val(`select count(*) from public.bom_change_batch_lines where batch_id = $1 and result_version = 2 and result_bom_id is not null`, [b100.id])) === 100)
const events = await val(`select string_agg(action, ',' order by acted_at, id) from public.bom_change_approvals where batch_id = $1`, [b100.id])
ok('approval records: created, submitted, approved, published', events === 'CREATED,SUBMITTED,APPROVED,PUBLISHED', events)
const mutate = await request('op', `update public.bom_change_approvals set note = 'x' where batch_id = $1`, [b100.id])
ok('approval history cannot be changed from the app', Boolean(mutate.error) || Number(await val(`select count(*) from public.bom_change_approvals where note = 'x'`)) === 0)

console.log('\nProduction orders before and after the change')
ok('the order released before publishing keeps BOM v1 and its material plan', (await val(`select bom_version from public.production_orders where id = $1`, [orderBeforeId])) === 1
  && JSON.stringify(await val(`select jsonb_agg(jsonb_build_object('c', component_product_id, 'q', planned_quantity) order by line_no) from public.production_order_materials where production_order_id = $1`, [orderBeforeId])) === JSON.stringify(matsBefore))
ok('stock, reservations, purchase orders and production orders were not changed by publishing', (await otherSnapshot()) === before)
const orderAfter = await op(`select public.production_order_v2_save(null, $1::jsonb, gen_random_uuid())`, [JSON.stringify({ product_id: FG[1], planned_quantity: 5, production_date: today })])
const orderAfterId = orderAfter.production_order_id ?? orderAfter.id ?? await val(`select id from public.production_orders where finished_product_id = $1 order by created_at desc limit 1`, [FG[1]])
ok('an order created after publishing uses the new revision', (await val(`select bom_version from public.production_orders where id = $1`, [orderAfterId])) === 2
  && Number(await val(`select count(*) from public.production_order_materials where production_order_id = $1 and component_product_id = $2`, [orderAfterId, C_NEW])) === 1)

// ---------------------------------------------------------------------------
console.log('\nReplace in selected BOMs only, with a unit conversion')
const curRows = (await whereUsed('op', C_NEW, { status: 'CURRENT' }, 'sku', true, 5000)).value.rows
const ten = curRows.slice(0, 10)
const noFactor = await save('op', { operation: 'REPLACE', reason: 'Glaze packs', effective_from: today }, linesFor(ten, { new_component_product_id: C_PCS }))
ok('different units without a conversion factor: every line has an error', noFactor.value?.batch.summary.lines_with_errors === 10
  && noFactor.value.lines[0].validation_errors.some((e) => /Units differ \(KG on the BOM, PCS/.test(e)), noFactor.error ?? noFactor.value?.lines?.[0])
const noFactorSubmit = await act('op', noFactor.value.batch.id, 'SUBMIT')
ok('a batch with errors cannot be submitted', /validation errors/.test(noFactorSubmit.error ?? ''), noFactorSubmit)
const withFactor = await save('op', { operation: 'REPLACE', reason: 'Glaze packs', effective_from: today }, linesFor(ten, { new_component_product_id: C_PCS, factor: 2 }),
  noFactor.value.batch.id, noFactor.value.batch.row_version)
const wf1 = withFactor.value?.lines?.[0]
ok('conversion factor 2: 1.5 KG → 3 PCS; the same draft was updated', withFactor.value?.batch.id === noFactor.value.batch.id && withFactor.value.batch.summary.lines_with_errors === 0
  && Number(wf1.old_quantity) * 2 === Number(wf1.new_quantity) && wf1.new_unit === 'PCS', withFactor.error ?? wf1)
const r10 = await fullCycle(withFactor.value.batch.id)
ok('published for the 10 selected BOMs only', r10.value?.ok === true && r10.value.revisions.length === 10, r10.error ?? r10.value?.message)
ok('the other 90 BOMs are untouched (still v2)', Number(await val(`select count(*) from public.boms b join public.products p on p.id = b.finished_product_id
  where b.status = 'APPROVED' and p.sku ~ '^BB-FG-[0-9]{3}$' and b.version = 2`)) === 90)
ok('10 BOMs at v3 with the pack component', Number(await val(`select count(*) from public.boms where status = 'APPROVED' and version = 3 and change_reason like '%Glaze packs%'`)) === 10)

// ---------------------------------------------------------------------------
console.log('\nValidation: inactive items, circular BOMs, duplicates, units')
const glazeOnCa = (await whereUsed('op', C_OLD, { status: 'CURRENT' })).value.rows
const inactive = await save('op', { operation: 'REPLACE', reason: 'Try inactive', effective_from: today }, linesFor(glazeOnCa, { new_component_product_id: C_OFF }))
ok('replacing with an inactive item is refused', inactive.value?.lines?.[0]?.validation_errors.some((e) => /inactive/.test(e)), inactive.error ?? inactive.value?.lines?.[0])
const circular = await save('op', { operation: 'REPLACE', reason: 'Try circular', effective_from: today }, [{ bom_id: ca.bom_id, component_product_id: C_OLD, new_component_product_id: FG_CB }])
ok('a replacement that would make the BOM circular is refused', circular.value?.lines?.[0]?.validation_errors.some((e) => /Circular BOM/.test(e)), circular.error ?? circular.value?.lines?.[0])
const xRows = (await whereUsed('op', C_X, { status: 'CURRENT', search: 'BB-FG-02' })).value.rows.slice(0, 3)
const dup = await save('op', { operation: 'ADD', reason: 'More fittings', effective_from: today }, xRows.map((r) => ({ bom_id: r.bom_id, component_product_id: C_X, quantity: 2 })))
ok('adding a component that is already on the BOM is refused', dup.value?.batch.summary.lines_with_errors === 3 && /already on/.test(dup.value.lines[0].validation_errors.join(' ')), dup.error ?? dup.value?.lines?.[0])
const merged = await save('op', { operation: 'ADD', reason: 'More fittings', effective_from: today, merge_duplicates: true }, xRows.map((r) => ({ bom_id: r.bom_id, component_product_id: C_X, quantity: 2 })),
  dup.value.batch.id, dup.value.batch.row_version)
ok('…unless merging is ticked: quantities are added (1 + 2 = 3)', merged.value?.batch.summary.lines_with_errors === 0 && merged.value.lines[0].warnings.some((w) => /Merged/.test(w)), merged.error ?? merged.value?.lines?.[0])
const rm = await fullCycle(merged.value.batch.id)
ok('merged batch published: one fitting line with quantity 3', rm.value?.ok === true && (await current(xRows[0].finished_product_id)).items.filter((x) => x.c === C_X).length === 1
  && Number((await current(xRows[0].finished_product_id)).items.find((x) => x.c === C_X).q) === 3, rm.error ?? rm.value?.message)
const badEdit = await save('op', { operation: 'EDIT', reason: 'Bad edit', effective_from: today }, [
  { bom_id: xRows[0].bom_id, component_product_id: C_X, unit: 'KG' },
  { bom_id: (await current(xRows[1].finished_product_id)).id, component_product_id: C_X, wastage_percentage: 100 },
  { bom_id: (await current(xRows[2].finished_product_id)).id, component_product_id: C_X, quantity: 'abc' },
])
ok('edit validation: wrong unit, wastage 100% and non-numbers are refused', badEdit.value?.batch.summary.lines_with_errors === 3
  && /no longer the current revision/.test(badEdit.value.lines[0].validation_errors.join(' '))
  && /Wastage/.test(badEdit.value.lines[1].validation_errors.join(' ')) && /numbers/.test(badEdit.value.lines[2].validation_errors.join(' ')), badEdit.error ?? badEdit.value?.lines)

// ---------------------------------------------------------------------------
console.log('\nBulk add with different quantities per BOM')
const addTargets = FG.slice(40, 45)
const add = await save('op', { operation: 'ADD', reason: 'Add carton', effective_from: today }, addTargets.map((fg, i) => ({ finished_product_id: fg, component_product_id: C_ADD, quantity: i + 1, wastage_percentage: 1 })))
ok('lines given by finished product resolve to its current revision; no errors', add.value?.batch.summary.lines_with_errors === 0 && add.value.lines.every((l) => l.source_version === 2), add.error ?? add.value?.batch?.summary)
const ra = await fullCycle(add.value.batch.id)
ok('published: each BOM got its own quantity (1 to 5 PCS) at the end of the list', ra.value?.ok === true
  && (await Promise.all(addTargets.map(current))).every((c, i) => { const it = c.items.at(-1); return it.c === C_ADD && Number(it.q) === i + 1 && Number(it.w) === 1 }), ra.error ?? ra.value?.message)
const addUnit = await save('op', { operation: 'ADD', reason: 'Add carton in KG', effective_from: today }, [{ finished_product_id: FG[50], component_product_id: C_ADD, quantity: 1, unit: 'KG' }])
ok('bulk add in another unit than the component inventory unit is refused', /No unit conversion is configured/.test(addUnit.value?.lines?.[0]?.validation_errors.join(' ')), addUnit.error ?? addUnit.value?.lines?.[0])
const noBom = await save('op', { operation: 'ADD', reason: 'No BOM', effective_from: today }, [{ finished_product_id: C_ADD, component_product_id: C_X, quantity: 1 }])
ok('a product without an approved BOM is refused with its line number', /Line 1: the finished product has no approved BOM/.test(noBom.error ?? ''), noBom)

// ---------------------------------------------------------------------------
console.log('\nBulk delete')
const delRows = (await whereUsed('op', C_X, { status: 'CURRENT', search: 'BB-FG-06' })).value.rows.slice(0, 3)
const del = await save('op', { operation: 'DELETE', reason: 'Fitting no longer used', effective_from: today }, linesFor(delRows))
ok('delete preview: old quantity shown, no new quantity', del.value?.lines.every((l) => Number(l.old_quantity) === 1 && l.new_quantity === null) && del.value.batch.summary.lines_with_errors === 0, del.error ?? del.value?.lines?.[0])
const rd = await fullCycle(del.value.batch.id)
ok('published: the fitting is removed from the 3 BOMs; previous revisions keep it', rd.value?.ok === true
  && (await Promise.all(delRows.map((r) => current(r.finished_product_id)))).every((c) => !c.items.some((x) => x.c === C_X))
  && (await Promise.all(delRows.map((r) => itemsOf(r.bom_id)))).every((it) => it.some((x) => x.c === C_X)), rd.error ?? rd.value?.message)
const delLast = await save('op', { operation: 'DELETE', reason: 'Remove only component', effective_from: today }, [{ bom_id: one.bom_id, component_product_id: C_PCS }])
ok('deleting the only component is refused (a BOM needs at least one)', /All components .* would be removed/.test(delLast.value?.lines?.[0]?.validation_errors.join(' ')), delLast.error ?? delLast.value?.lines?.[0])

// ---------------------------------------------------------------------------
console.log('\nBulk edit across several BOMs')
const editRows = (await whereUsed('op', C_NEW, { status: 'CURRENT', search: 'BB-FG-07' })).value.rows.slice(0, 4)
const edit = await save('op', { operation: 'EDIT', reason: 'New glaze thickness', effective_from: today }, editRows.map((r, i) => ({ bom_id: r.bom_id, component_product_id: C_NEW, quantity: 2 + i, wastage_percentage: 5, notes: 'Thicker coat' })))
const re = await fullCycle(edit.value?.batch?.id)
ok('quantities (2, 3, 4, 5), wastage 5% and notes updated on 4 BOMs', re.value?.ok === true
  && (await Promise.all(editRows.map((r) => current(r.finished_product_id)))).every((c, i) => { const it = c.items.find((x) => x.c === C_NEW); return Number(it.q) === 2 + i && Number(it.w) === 5 }), re.error ?? re.value?.message)

// ---------------------------------------------------------------------------
console.log('\nApproval and rejection, segregation of duties')
const rj = await save('op', { operation: 'EDIT', reason: 'Wastage review', effective_from: today }, [{ bom_id: (await current(FG[80])).id, component_product_id: C_NEW, wastage_percentage: 3 }])
await act('op', rj.value.batch.id, 'SUBMIT')
const rjNoReason = await act('bb_appr', rj.value.batch.id, 'REJECT', '')
ok('rejecting needs a reason', /reason/.test(rjNoReason.error ?? ''), rjNoReason)
const rjOk = await act('bb_appr', rj.value.batch.id, 'REJECT', 'Check with QA first')
ok('rejected with a reason; creator notified', rjOk.value?.batch.status === 'REJECTED' && rjOk.value.batch.rejection_reason === 'Check with QA first'
  && Number(await val(`select count(*) from public.notifications where related_entity_id = $1 and recipient_user_id = rls_test.id('op')`, [rj.value.batch.id])) >= 1, rjOk)
const rjPub = await publish('bb_appr', rj.value.batch.id)
ok('a rejected batch cannot be published', /Only an approved batch/.test(rjPub.error ?? ''), rjPub)
const rjEdit = await save('op', { operation: 'EDIT', reason: 'Wastage review (QA ok)', effective_from: today }, [{ bom_id: (await current(FG[80])).id, component_product_id: C_NEW, wastage_percentage: 3 }],
  rj.value.batch.id, rjOk.value.batch.row_version)
ok('a rejected batch can be corrected (back to draft)', rjEdit.value?.batch.status === 'DRAFT', rjEdit)
await db.exec(`reset role; insert into public.company_settings (company_id, setting_key, setting_value) values (rls_test.id('company_a'), 'inventory.segregation_of_duties', 'true'::jsonb)
  on conflict (company_id, setting_key) do update set setting_value = excluded.setting_value`)
await act('op', rj.value.batch.id, 'SUBMIT')
const selfAppr = await act('op', rj.value.batch.id, 'APPROVE')
ok('with segregation of duties on, the submitter cannot approve', /Segregation of duties/.test(selfAppr.error ?? ''), selfAppr)
const otherAppr = await act('bb_appr', rj.value.batch.id, 'APPROVE')
ok('another authorised user can approve', otherAppr.value?.batch.status === 'APPROVED', otherAppr)
const rjDone = await publish('op', rj.value.batch.id)
ok('the submitter may publish once someone else approved (the new revision records the approver)', rjDone.value?.ok === true
  && (await val(`select approved_by = rls_test.id('bb_appr') from public.boms where id = $1`, [rjDone.value.revisions[0].bom_id])) === true, rjDone.error ?? rjDone.value?.message)
await db.exec(`reset role; update public.company_settings set setting_value = 'false'::jsonb where company_id = rls_test.id('company_a') and setting_key = 'inventory.segregation_of_duties'`)

// ---------------------------------------------------------------------------
console.log('\nConcurrent modifications')
const target = await current(FG[90])
const k1 = await save('op', { operation: 'EDIT', reason: 'Change one', effective_from: today }, [{ bom_id: target.id, component_product_id: C_NEW, quantity: 9 }])
const k2 = await save('op', { operation: 'EDIT', reason: 'Change two', effective_from: today }, [{ bom_id: target.id, component_product_id: C_NEW, quantity: 8 }])
await act('op', k1.value.batch.id, 'SUBMIT')
await act('op', k2.value.batch.id, 'SUBMIT')
await act('op', k2.value.batch.id, 'APPROVE')
const stale = await act('op', k1.value.batch.id, 'SUBMIT', null, 1)
ok('an out-of-date batch version is refused (optimistic lock)', /changed by someone else/.test(stale.error ?? ''), stale)
const pk2 = await publish('op', k2.value.batch.id)
ok('the first batch to publish wins', pk2.value?.ok === true)
const ak1 = await act('op', k1.value.batch.id, 'APPROVE')
ok('the other batch can no longer be approved: the BOM changed after it was submitted', /changed after this batch was submitted/.test(ak1.error ?? ''), ak1)
const k1get = (await call('op', 'bom_change_batch_validate', [k1.value.batch.id])).value
ok('re-checking shows which BOM is no longer current', /no longer the current revision/.test(k1get.lines[0].validation_errors.join(' ')) && k1get.batch.stale === true, k1get?.lines?.[0])
// A batch approved, then its BOM changed before publishing: publishing changes nothing.
const t2 = await current(FG[91])
const k3 = await save('op', { operation: 'EDIT', reason: 'Change three', effective_from: today }, [{ bom_id: t2.id, component_product_id: C_NEW, quantity: 7 }])
const k4 = await save('op', { operation: 'EDIT', reason: 'Change four', effective_from: today }, [{ bom_id: t2.id, component_product_id: C_NEW, quantity: 6 }])
for (const k of [k3, k4]) { await act('op', k.value.batch.id, 'SUBMIT'); await act('op', k.value.batch.id, 'APPROVE') }
await publish('op', k4.value.batch.id)
const versionsBefore = await val(`select count(*)::int from public.boms`)
const pk3 = await publish('op', k3.value.batch.id)
ok('publishing an approved batch whose BOM changed meanwhile: refused, nothing changed, failure recorded', pk3.value?.ok === false
  && (await val(`select count(*)::int from public.boms`)) === versionsBefore && pk3.value.batch.batch.status === 'APPROVED'
  && (await val(`select action from public.bom_change_approvals where batch_id = $1 order by acted_at desc, id desc limit 1`, [k3.value.batch.id])) === 'PUBLISH_FAILED', pk3.error ?? pk3.value)

// ---------------------------------------------------------------------------
console.log('\nAtomic publishing (no partial updates)')
const atomRows = (await whereUsed('op', C_NEW, { status: 'CURRENT', search: 'BB-FG-03' })).value.rows.slice(0, 5)
const atom = await save('op', { operation: 'REPLACE', reason: 'Atomic test', effective_from: today }, linesFor(atomRows, { new_component_product_id: C_OLD }))
await act('op', atom.value.batch.id, 'SUBMIT')
await act('op', atom.value.batch.id, 'APPROVE')
await op(`update public.products set status = 'INACTIVE' where id = $1`, [C_OLD])
const cnt = await val(`select count(*)::int from public.boms`)
const pa = await publish('op', atom.value.batch.id)
ok('a component made inactive after approval: no BOM is updated (all 5 or none)', pa.value?.ok === false && (await val(`select count(*)::int from public.boms`)) === cnt
  && (await Promise.all(atomRows.map((r) => current(r.finished_product_id)))).every((c, i) => c.id === atomRows[i].bom_id), pa.error ?? pa.value?.message)
await op(`update public.products set status = 'ACTIVE' where id = $1`, [C_OLD])
await act('op', atom.value.batch.id, 'CANCEL', 'Not needed')

// ---------------------------------------------------------------------------
console.log('\nEffective dates')
const fut = await save('op', { operation: 'EDIT', reason: 'From tomorrow', effective_from: tomorrow }, [{ bom_id: (await current(FG[95])).id, component_product_id: C_NEW, quantity: 4.25 }])
const pf = await fullCycle(fut.value.batch.id)
const futRow = (await whereUsed('op', C_NEW, { status: 'ALL', search: 'BB-FG-096' })).value.rows
ok('a future effective date: the new revision is scheduled, the current one stays active until the day before', pf.value?.ok === true
  && futRow.some((r) => r.lifecycle === 'SCHEDULED' && r.effective_from === tomorrow && r.is_current)
  && futRow.some((r) => r.lifecycle === 'ACTIVE' && r.effective_to === today), futRow.map((r) => [r.version, r.lifecycle, r.effective_from, r.effective_to]))
const orderBeforeEffective = await op(`select public.production_order_v2_save(null, $1::jsonb, gen_random_uuid())`, [JSON.stringify({ product_id: FG[95], planned_quantity: 2, production_date: today })])
const obeId = orderBeforeEffective.production_order_id ?? orderBeforeEffective.id ?? await val(`select id from public.production_orders where finished_product_id = $1 order by created_at desc limit 1`, [FG[95]])
ok('an order created before the effective date uses the revision effective today', (await val(`select bom_version from public.production_orders where id = $1`, [obeId])) === futRow.find((r) => r.lifecycle === 'ACTIVE').version)
const futWu = await save('op', { operation: 'EDIT', reason: 'Too early', effective_from: today }, [{ bom_id: (await current(FG[95])).id, component_product_id: C_NEW, quantity: 4 }])
ok('a change starting before a scheduled revision is refused', /starts on .*on or after it/.test(futWu.value?.lines?.[0]?.validation_errors.join(' ')), futWu.error ?? futWu.value?.lines?.[0])

// ---------------------------------------------------------------------------
console.log('\nReversal (rollback as a new revision) and revision history')
const rev = await call('op', 'bom_change_batch_create_reversal', [b100.id, 'Old glaze back for audit', today])
const revB = rev.value?.batch
ok('a reversal draft has one restore line per BOM of the original batch', revB?.operation === 'RESTORE' && rev.value.lines.length === 100 && revB.restores_batch_number === b100.batch_number, rev.error ?? revB)
const revErr = rev.value.lines.filter((l) => l.validation_errors.length > 0)
ok('BOMs changed again since the original batch are flagged (not silently overwritten)', revErr.length > 0 && revErr.every((l) => /no longer the current revision/.test(l.validation_errors.join(' '))), revErr.length)
const removed = await call('op', 'bom_change_batch_remove_lines', [revB.id, revB.row_version, revErr.map((l) => l.id)])
ok('lines with errors removed from the draft', removed.value?.batch.summary.lines_with_errors === 0 && removed.value.lines.length === 100 - revErr.length, removed.error ?? removed.value?.batch?.summary)
const rr = await fullCycle(revB.id)
const restored = rev.value.lines.find((l) => l.finished_sku === 'BB-FG-050' && l.validation_errors.length === 0)
const c60 = await current(restored.finished_product_id)
ok('published: the restored revision has the original components again (as v3), v1 and v2 kept', rr.value?.ok === true && c60.version === 3
  && JSON.stringify(c60.items.map((x) => [x.c, Number(x.q), Number(x.w)])) === JSON.stringify((await itemsOf(BOM1.get(restored.finished_product_id))).map((x) => [x.c, Number(x.q), Number(x.w)]))
  && Number(await val(`select count(*) from public.boms where finished_product_id = $1`, [restored.finished_product_id])) === 3, rr.error ?? c60)
const log = (await call('op', 'bom_revision_log', [JSON.stringify({ source: 'BULK', search: 'BB-FG-050' }), 50, 0])).value
ok('revision history: every bulk revision with its batch, reason and approver', log.total === 2 && log.rows.every((r) => /^BCB-/.test(r.batch_number) && r.change_reason && r.approved_by_name)
  && log.rows[0].version === 3, log.rows?.map((r) => [r.version, r.batch_number]))
const manual = (await call('op', 'bom_revision_log', [JSON.stringify({ source: 'MANUAL', search: 'BB-FG-050' }), 50, 0])).value
ok('…and manual revisions separately (v1)', manual.total === 1 && manual.rows[0].version === 1 && manual.rows[0].batch_number === null, manual)
const list = (await call('op', 'bom_change_batches_list', [null, 100, 0])).value
ok('batch list with counts per status', list.total >= 10 && list.counts.PUBLISHED >= 8 && list.counts.CANCELLED === 1, list.counts)

// ---------------------------------------------------------------------------
console.log('\nPermissions, company isolation and RLS')
const bSees = await request('b_op', `select (select count(*) from public.bom_change_batches)::int + (select count(*) from public.bom_change_batch_lines)::int + (select count(*) from public.bom_change_approvals)::int`)
ok('another company sees no batches, lines or approval records (RLS)', bSees.value === 0, bSees)
const bGet = await call('b_op', 'bom_change_batch_get', [b100.id])
ok('another company cannot open a batch', /not found in your company/.test(bGet.error ?? ''), bGet)
const bWu = await call('b_op', 'bom_where_used', [C_OLD, '{}', 'sku', true, 10, 0])
ok('another company cannot run where-used on this company\'s component', /not found in your company/.test(bWu.error ?? ''), bWu)
const bSave = await save('b_op', { operation: 'DELETE', reason: 'Cross-company', effective_from: today }, [{ bom_id: (await current(FG[5])).id, component_product_id: C_NEW }])
ok('another company cannot change this company\'s BOMs (the BOM is not found)', /not found in your company/.test(bSave.value?.lines?.[0]?.validation_errors.join(' ') ?? bSave.error ?? ''), bSave)
const bSearch = (await call('b_op', 'bom_component_search', ['BB-GLAZE', 10])).value
ok('another company\'s component search finds nothing here', Array.isArray(bSearch) && bSearch.length === 0, bSearch)
const bPub = await publish('b_op', b100.id)
ok('another company cannot publish this company\'s batch', Boolean(bPub.error), bPub)
if (READER) {
  const rSave = await save('bb_read', { operation: 'DELETE', reason: 'Reader', effective_from: today }, [{ bom_id: (await current(FG[5])).id, component_product_id: C_NEW }])
  ok(`a read-only BOM user (${READER}) can view but not prepare changes`, /requires production_bom.create or production_bom.update/.test(rSave.error ?? '')
    && !(await call('bb_read', 'bom_where_used', [C_NEW, '{}', 'sku', true, 10, 0])).error, rSave)
} else ok('a read-only BOM role exists for this check', false, 'no role with production_bom.read only')
if (PREPARER) {
  const pp = await save('bb_prep', { operation: 'EDIT', reason: 'Prepared', effective_from: today }, [{ bom_id: (await current(FG[6])).id, component_product_id: C_NEW, quantity: 1 }])
  await act('bb_prep', pp.value.batch.id, 'SUBMIT')
  await act('op', pp.value.batch.id, 'APPROVE')
  const ppPub = await publish('bb_prep', pp.value.batch.id)
  ok(`a preparer without approval rights (${PREPARER}) can submit but not publish`, pp.value?.batch && /production_bom.approve|not allowed/.test(ppPub.error ?? ''), ppPub)
}
const direct = await request('op', `insert into public.bom_change_batches (company_id, batch_number, operation, reason, effective_from) values ($1, 'BCB-999999', 'ADD', 'Direct', current_date)`, [A])
ok('tables cannot be written directly from the app (only through the functions)', Boolean(direct.error), direct)

// ---------------------------------------------------------------------------
console.log('\nReset allowlist and rollback')
ok('ERP reset allowlist: 129 tables including the 3 new ones (130 once 20261221090000 adds support_conversation_prefs)', Number(await val(`select count(*) from private.erp_reset_tables()`)) === 129 + Number(await val(`select count(*) from private.erp_reset_tables() where table_name = 'support_conversation_prefs'`))
  && Number(await val(`select count(*) from private.erp_reset_tables() where table_name like 'bom_change%'`)) === 3)
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
let refused = false
try { await db.exec(down) } catch (e) { refused = /Published bulk BOM changes exist/.test(e.message) }
ok('rollback refuses while published batches exist (history would be lost)', refused)
await db.exec(`reset role; set app.bom_bulk_rollback_force = 'on'`)
await db.exec(down)
await db.exec(`reset app.bom_bulk_rollback_force`)
ok('forced rollback removes the tables and functions; BOM versions stay', (await val(`select to_regclass('public.bom_change_batches')::text`)) === null
  && (await val(`select to_regprocedure('public.bom_where_used(uuid, jsonb, text, boolean, integer, integer)')::text`)) === null
  && (await current(restored.finished_product_id)).version === 3)
ok('rollback restores the reset allowlist (126 tables)', Number(await val(`select count(*) from private.erp_reset_tables()`)) === 126)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applying the migration works', (await val(`select to_regclass('public.bom_change_batches')::text`)) === 'bom_change_batches')

console.log(`\n${failed === 0 ? '✓' : '✗'} bulk BOM check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
