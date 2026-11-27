// Generate Multiple BOMs — "Add Components from Existing BOM" (migration 20261231091000): the chosen BOM is a read-only template; each
// generated product saves its own independent component rows; the template id is kept only as provenance; company isolation; no stock
// movement; existing behaviour unchanged without a template; rollback.
//
//   npm run test:db:bom-generate-template
//
// Local PGlite database only (throwaway, in memory). One committed transaction per call, as the app does.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261231091000_bom_generate_templates'
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
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)::text`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = async (user, sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const op = (sql, params) => as('op', sql, params)
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)

// ---- Fixtures: two template BOMs with remarks, wastage, source and supplier; a base BOM; existing products ---------------------------
let n = 0
const product = (type, unit = 'PCS', cost = 10, user = 'op', company = A) => as(user, `insert into public.products (company_id, sku, product_name, product_type, default_source_type,
    base_unit, status, standard_cost, gst_rate, hsn_code) values ($1, $2, $3, $4, 'OUTSOURCED', $5, 'ACTIVE', $6, 18, '6910') returning id`,
  [company, `TG-${++n}`, `Template test ${n}`, type, unit, cost, ])
const item = (p, q, w = 0, notes = null, extra = {}) => ({ component_product_id: p, quantity_required: q, unit: null, wastage_percentage: w, notes, ...extra })
const save = (fg, items, out = 1, user = 'op') => as(user, `select public.production_save_bom(null, $1, rls_test.today(), null, $2, null, $3::jsonb, gen_random_uuid())`, [fg, out, JSON.stringify(items)])
const SUP = await val(`select id::text from public.suppliers where company_id = $1 order by created_at limit 1`, [A])
const C1 = await product('RAW_MATERIAL', 'KG', 12.5)
const C2 = await product('COMPONENT', 'PCS', 450)
const C3 = await product('PACKAGING_MATERIAL', 'PCS', 35)
const C4 = await product('COMPONENT', 'PCS', 80)
const C5 = await product('RAW_MATERIAL', 'KG', 20)
const BASE_FG = await product('FINISHED_GOOD')
const base = await save(BASE_FG, [item(C1, 1)])
const TA = await product('FINISHED_GOOD')
const TB = await product('FINISHED_GOOD')
const T1 = await save(TA, [item(C1, 3, 5, 'Two glaze coats', { source_type: 'PURCHASED', ...(SUP ? { preferred_supplier_id: SUP } : {}) }), item(C2, 2, 0, 'Brass'), item(C3, 1)], 2)
const T2 = await save(TB, [item(C4, 4, 2, 'Concealed'), item(C5, 6)])
await op(`select public.production_bom_activate($1, null)`, [T1.bom_id])
const EX1 = await product('FINISHED_GOOD')
const EX2 = await product('FINISHED_GOOD')
// Company B: its own BOM (must never be usable as a template by company A).
const BP = await product('FINISHED_GOOD', 'PCS', 10, 'b_op', B)
const BC = await product('RAW_MATERIAL', 'KG', 10, 'b_op', B)
const TBX = await save(BP, [item(BC, 1)], 1, 'b_op')

const templateSnapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(b)::text, '|' order by b.id) from public.boms b where b.id = any($1::uuid[])), '')
  || coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from public.bom_items i where i.bom_id = any($1::uuid[])), ''))`, [[T1.bom_id, T2.bom_id, TBX.bom_id, base.bom_id]])
const stockSnapshot = () => val(`select md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), '')
  || coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.inventory_balances x), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.stock_reservations r), ''))`)
const tplBefore = await templateSnapshot()
const stockBefore = await stockSnapshot()

const migration = await read(path.join(migDir, `${NAME}.sql`))
await db.exec(migration)
await db.exec(migration)
console.log(`✓ ${NAME} applied (twice)`)
ok('migration changed no BOM, component or stock data', tplBefore === await templateSnapshot() && stockBefore === await stockSnapshot())

// What the page does: read the template's lines through the views (as the user) and send them as the entry's own items.
const templateItems = async (bomId, user = 'op') => {
  const r = await request(user, `select coalesce(jsonb_agg(jsonb_build_object('component_product_id', component_product_id, 'quantity_required', quantity_required,
    'unit', unit, 'wastage_percentage', wastage_percentage, 'notes', notes, 'source_type', source_type, 'preferred_supplier_id', preferred_supplier_id) order by line_no), '[]')
    from public.bom_item_list where bom_id = $1`, [bomId])
  return r.error ? { error: r.error } : r.value
}
const t1Items = await templateItems(T1.bom_id)
const t2Items = await templateItems(T2.bom_id)
ok('the template\'s lines are readable through the BOM views (quantities, wastage, remarks, source, supplier, unit)', t1Items.length === 3 && t2Items.length === 2
  && t1Items[0].notes === 'Two glaze coats' && Number(t1Items[0].wastage_percentage) === 5 && t1Items[0].source_type === 'PURCHASED' && t1Items[0].unit === 'KG', t1Items)
const bItems = await templateItems(TBX.bom_id)
ok('company isolation: company A cannot read company B\'s BOM lines', Array.isArray(bItems) && bItems.length === 0, bItems)

const gen = (entries, user = 'op', key = crypto.randomUUID()) => request(user, `select public.bom_generate_multiple($1::jsonb, $2::jsonb, $3::uuid)`,
  [JSON.stringify({ bom_id: base.bom_id }), JSON.stringify(entries), key])
const itemsOf = (bomId) => val(`select jsonb_agg(jsonb_build_object('id', id, 'c', component_product_id, 'q', quantity_required::numeric, 'w', wastage_percentage::numeric, 'n', notes,
  'u', unit, 's', source_type, 'p', preferred_supplier_id) order by line_no) from public.bom_items where bom_id = $1`, [bomId])
// Rows without their ids, keys sorted (jsonb orders keys its own way), for value comparison.
const canon = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
const noIds = (rows) => JSON.stringify((rows ?? []).map(({ id: _id, ...r }) => canon(r)))

// ---- Two products, two templates, edited independently, one save ------------------------------------------------------------------------
console.log('\nTemplates for several products in one batch')
// Product A (EX1) from T1, then edited: C2 replaced by C4, C3 removed, C1 quantity / wastage / remarks changed.
// (A component sent without a source gets the database default for its type: production_save_bom.)
const editedA = [{ ...t1Items[0], quantity_required: 4, wastage_percentage: 7, notes: 'Three coats' }, item(C4, 2, 0, 'Replaces brass')]
// Product B (EX2) from T2, unchanged copy. Product C (new product) from T1, unchanged copy.
const r1 = await gen([
  { product_id: EX1, bom: { output_quantity: 1 }, items: editedA, template_bom_id: T1.bom_id },
  { product_id: EX2, bom: { output_quantity: 1 }, items: t2Items, template_bom_id: T2.bom_id },
  { product: { product_name: 'New basin from template', sku: 'TG-NEW-1', product_type: 'FINISHED_GOOD', base_unit: 'PCS', default_source_type: 'IN_HOUSE', gst_rate: 18, hsn_code: '6910' },
    bom: { output_quantity: 2 }, items: t1Items, template_bom_id: T1.bom_id },
])
const out = r1.value?.products ?? []
ok('one call saves three draft BOMs (two existing products, one new product), each with its template id', !r1.error && r1.value.created === 3
  && out.every((p) => p.status === 'DRAFT') && out[0].template_bom_id === T1.bom_id && out[1].template_bom_id === T2.bom_id && out[2].template_bom_id === T1.bom_id, r1)
ok('the template BOMs and their component rows are unchanged (read-only templates)', tplBefore === await templateSnapshot())
ok('no stock moved: no ledger entry, balance or reservation changed', stockBefore === await stockSnapshot())
const aItems = await itemsOf(out[0]?.bom_id)
ok('product A: its own edited components (replacement, removal, quantity, wastage, remarks) — not the template\'s',
  noIds(aItems) === noIds([{ c: C1, q: 4, w: 7, n: 'Three coats', u: 'KG', s: 'PURCHASED', p: SUP ?? null }, { c: C4, q: 2, w: 0, n: 'Replaces brass', u: 'PCS', s: 'OUTSOURCED', p: null }]), aItems)
const bOut = await itemsOf(out[1]?.bom_id)
const t2Rows = await itemsOf(T2.bom_id)
ok('product B: an exact copy of template 2\'s components (values equal) in NEW component rows', noIds(bOut) === noIds(t2Rows)
  && bOut.every((x) => !t2Rows.some((t) => t.id === x.id)), { bOut, t2Rows })
const cOut = await itemsOf(out[2]?.bom_id)
const t1Rows = await itemsOf(T1.bom_id)
ok('new product C: template 1\'s components copied in full (wastage, remarks, source, supplier), own rows', noIds(cOut) === noIds(t1Rows) && cOut.every((x) => !t1Rows.some((t) => t.id === x.id)), { cOut, t1Rows })
ok('generated component rows belong only to the new BOMs (none shared with any template)', (await val(`select count(*)::int from public.bom_items where id in
  (select id from public.bom_items where bom_id = any($1::uuid[])) and bom_id not in (select unnest($1::uuid[]))`, [out.map((p) => p.bom_id)])) === 0)
const reasonA = await val(`select change_reason from public.boms where id = $1`, [out[0]?.bom_id])
const reasonC = await val(`select change_reason from public.boms where id = $1`, [out[2]?.bom_id])
const t1Code = await val(`select bom_code || ' v' || version from public.boms where id = $1`, [T1.bom_id])
ok('provenance in the change reason: base BOM and template BOM (existing and new products)', reasonA?.startsWith('Generated from ') && reasonA.includes(`components copied from ${t1Code}`)
  && reasonC?.startsWith('Created from ') && reasonC.includes(`components copied from ${t1Code}`), { reasonA, reasonC })
const audits = await val(`select jsonb_agg(metadata ->> 'template_bom_id' order by event_timestamp, id) from public.audit_logs where action = 'production.bom_components_copied'`)
ok('audit log: one production.bom_components_copied entry per templated product, with the template id', JSON.stringify([...(audits ?? [])].sort()) === JSON.stringify([T1.bom_id, T2.bom_id, T1.bom_id].sort()), audits)
ok('audit log: production.bom_generated records the template too', (await val(`select count(*)::int from public.audit_logs where action = 'production.bom_generated'
  and metadata ->> 'template_bom_id' = $1`, [T1.bom_id])) === 1)

// Later edits of a generated draft never reach the template.
const edit = await request('op', `select public.production_save_bom($1, $2, rls_test.today(), null, 1, null, $3::jsonb, gen_random_uuid())`,
  [out[1].bom_id, EX2, JSON.stringify([item(C5, 9, 1, 'Edited later')])])
ok('editing a generated draft afterwards changes only that draft', !edit.error && noIds(await itemsOf(out[1].bom_id)) === noIds([{ c: C5, q: 9, w: 1, n: 'Edited later', u: 'KG', s: 'PURCHASED', p: null }])
  && tplBefore === await templateSnapshot(), { edit, items: await itemsOf(out[1].bom_id) })

// ---- Refusals: other company, invalid id; nothing is saved ---------------------------------------------------------------------------
console.log('\nIsolation and validation')
const bomsBefore = await val(`select count(*)::int from public.boms`)
const EX3 = await product('FINISHED_GOOD')
const cross = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: [item(C1, 1)], template_bom_id: TBX.bom_id }])
ok('another company\'s BOM as template is refused ("not found in your company")', /template BOM not found in your company/.test(cross.error ?? ''), cross)
const bad = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: [item(C1, 1)], template_bom_id: 'not-a-uuid' }])
ok('an invalid template id is refused', /invalid template BOM/.test(bad.error ?? ''), bad)
const mixed = await gen([
  { product_id: EX3, bom: { output_quantity: 1 }, items: [item(C1, 1)], template_bom_id: T2.bom_id },
  { product_id: TA, bom: { output_quantity: 1 }, items: [item(C1, 1)], template_bom_id: TBX.bom_id },
])
ok('all or nothing: one refused template saves nothing for the batch', Boolean(mixed.error) && (await val(`select count(*)::int from public.boms`)) === bomsBefore, mixed)
ok('company B data untouched by company A\'s attempts', tplBefore === await templateSnapshot())
const bTry = await request('b_op', `select public.bom_generate_multiple($1::jsonb, $2::jsonb, $3::uuid)`,
  [JSON.stringify({ bom_id: TBX.bom_id }), JSON.stringify([{ product_id: BP, bom: { output_quantity: 1 }, items: [item(BC, 2)], template_bom_id: T1.bom_id }]), crypto.randomUUID()])
ok('company B cannot use company A\'s BOM as a template either', /template BOM not found in your company/.test(bTry.error ?? ''), bTry)

// ---- Search for templates (the page's dropdown): saved BOMs only, company-scoped --------------------------------------------------------
const hasSearch = await val(`select count(*)::int from pg_proc where proname = 'bom_search'`)
if (hasSearch) {
  const sku = await val(`select sku from public.products where id = $1`, [TA])
  const middle = sku.slice(1)
  const hits = await request('op', `select coalesce(jsonb_agg(e ->> 'id'), '[]') from jsonb_array_elements(public.bom_search($1, 'ACTIVE', 20)) e`, [middle])
  ok(`template search by part of the finished SKU (“${middle}”) finds the saved BOM`, (hits.value ?? []).includes(T1.bom_id), hits)
  const code = (await val(`select bom_code from public.boms where id = $1`, [T2.bom_id]))
  const byCode = await request('op', `select coalesce(jsonb_agg(e ->> 'id'), '[]') from jsonb_array_elements(public.bom_search($1, 'ACTIVE', 20)) e`, [code.slice(-4)])
  ok('template search by the middle / end of the BOM number', (byCode.value ?? []).includes(T2.bom_id), byCode)
  const byName = await request('op', `select coalesce(jsonb_agg(e ->> 'id'), '[]') from jsonb_array_elements(public.bom_search('template test', 'ACTIVE', 50)) e`)
  ok('template search by product name returns BOM records only (no BOM-less Product Master products)', (byName.value ?? []).length > 0
    && (await val(`select count(*)::int from public.boms where id = any($1::uuid[])`, [byName.value])) === byName.value.length, byName)
  const bHits = await request('b_op', `select coalesce(jsonb_agg(e ->> 'id'), '[]') from jsonb_array_elements(public.bom_search('template test', 'ACTIVE', 50)) e`)
  ok('company B\'s template search never shows company A\'s BOMs', !(bHits.value ?? []).includes(T1.bom_id) && (bHits.value ?? []).includes(TBX.bom_id), bHits)
}

// ---- Without a template: unchanged behaviour ------------------------------------------------------------------------------------------
const plain = await gen([{ product_id: EX3, bom: { output_quantity: 1 }, items: [item(C2, 1)] }])
const plainReason = await val(`select change_reason from public.boms where id = $1`, [plain.value?.products?.[0]?.bom_id])
ok('without a template: same result and lineage as before ("Generated from …" only)', !plain.error && /^Generated from .+ v\d+ \(.+\)$/.test(plainReason ?? '') && !plainReason.includes('copied')
  && plain.value.products[0].template_bom_id === null, { plain, plainReason })

// ---- Rollback -------------------------------------------------------------------------------------------------------------------------------
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const orig = await read(path.join(migDir, '20261207090000_bom_generate_multiple.sql'))
const start = orig.indexOf('create or replace function public.bom_generate_multiple(')
const body = orig.slice(orig.indexOf('as $$', start) + 5, orig.indexOf('\n$$;', start) + 1).split('\r\n').join('\n')
ok('rollback restores bom_generate_multiple of 20261207090000 exactly', (await val(`select prosrc from pg_proc where proname = 'bom_generate_multiple'`)).split('\r\n').join('\n') === body)
const afterRb = await gen([{ product_id: TB, bom: { output_quantity: 1 }, items: [item(C3, 1)], template_bom_id: T1.bom_id }])
ok('after rollback the template id is simply ignored (older behaviour), data kept', !afterRb.error && tplBefore === await templateSnapshot(), afterRb)
await db.exec(migration)
ok('re-apply after rollback', (await val(`select prosrc from pg_proc where proname = 'bom_generate_multiple'`)).includes('template_bom_id'))

console.log(`\n${failed === 0 ? '✓' : '✗'} BOM generate templates check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
