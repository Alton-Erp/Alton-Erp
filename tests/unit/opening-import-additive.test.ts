// Opening stock Excel import: existing records matched, quantity added (never replaced); fields to modify.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_IMPORT_FIELDS, IMPORT_FIELD_OPTIONS, autoMapOpening, excelCostColumn, existingOpeningIndex, openingMatchIndex, validateOpeningRows,
  type OpeningContext, type OpeningImportFieldSelection, type OpeningMatchRecord,
} from '../../src/features/inventory/opening-import.ts'

const products = new Map([
  ['bolt', { id: 'p1', sku: 'BOLT', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', product_name: 'Bolt', default_source_type: 'OUTSOURCED' }],
  ['paint', { id: 'p2', sku: 'PAINT', base_unit: 'KG', track_batches: true, track_expiry: false, status: 'ACTIVE', product_name: 'Paint', default_source_type: 'OUTSOURCED' }],
  ['nut', { id: 'p3', sku: 'NUT', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', product_name: 'Nut', default_source_type: 'OUTSOURCED' }],
])
const locations = [{ id: 'l1', warehouseCode: 'MAIN', locationCode: 'A1', active: true, isDefault: true }]
const rec = (o: Partial<OpeningMatchRecord>): OpeningMatchRecord => ({ document_number: 'OS-000003', status: 'POSTED', product_id: 'p1', location_id: 'l1', batch_number: null,
  quantity: 100, added_quantity: 0, lot_cost: 20, ...o })
const header = ['SKU', 'Warehouse', 'Location', 'Quantity', 'Unit', 'Batch', 'Notes', 'Unit Cost']
const mapping = autoMapOpening(header)
const ctx = (records: OpeningMatchRecord[], fields: OpeningImportFieldSelection = DEFAULT_IMPORT_FIELDS, overrideAllowed = false): OpeningContext => ({
  products, locations, defaultEffectiveDate: '2026-11-01', today: '2026-11-12',
  existing: existingOpeningIndex(records),
  costs: new Map([['p1', { cost: 20, valid: true }], ['p2', { cost: 50, valid: true }], ['p3', { cost: null, valid: false }]]),
  additive: { matches: openingMatchIndex(records), fields, costColumn: fields.unit_cost ? excelCostColumn(header) : null, overrideAllowed },
})
const row = (sku: string, qty: string, extra: { unit?: string; batch?: string; notes?: string; cost?: string } = {}) =>
  [sku, 'MAIN', 'A1', qty, extra.unit ?? '', extra.batch ?? '', extra.notes ?? '', extra.cost ?? '']
const run = (rows: string[][], c: OpeningContext) => validateOpeningRows(rows, mapping, c, 2)

describe('Matching existing opening stock', () => {
  it('1. no record: a new opening stock record', () => {
    const [r] = run([row('BOLT', '30')], ctx([]))
    assert.equal(r.status, 'valid')
    assert.equal(r.action, 'new')
    assert.equal(r.match, undefined)
  })
  it('2/3. an existing record: quantity added, 100 + 25 = 125, never replaced', () => {
    const [r] = run([row('BOLT', '25')], ctx([rec({})]))
    assert.equal(r.status, 'valid', r.errors.join())
    assert.equal(r.action, 'add')
    assert.deepEqual([r.match?.existing, r.match?.newQuantity, r.match?.unit, r.match?.document_number], [100, 125, 'PCS', 'OS-000003'])
    assert.equal(r.payload?.quantity, 25, 'the imported quantity is sent, not the total')
  })
  it('earlier additions count in the existing quantity', () => {
    const [r] = run([row('BOLT', '5')], ctx([rec({ added_quantity: 40 })]))
    assert.deepEqual([r.match?.existing, r.match?.newQuantity], [140, 145])
  })
  it('4. several rows for the same record add up in order', () => {
    const rs = run([row('BOLT', '20'), row('BOLT', '5')], ctx([rec({})]))
    assert.deepEqual(rs.map((r) => [r.action, r.match?.existing, r.match?.newQuantity]), [['add', 100, 120], ['add', 120, 125]])
  })
  it('4. a new record twice in the file: the first creates it, the second adds to it', () => {
    const rs = run([row('NUT', '10'), row('NUT', '6')], ctx([]))
    assert.deepEqual(rs.map((r) => [r.status, r.action, r.match?.newQuantity ?? null]), [['valid', 'new', null], ['valid', 'add', 16]])
    assert.equal(rs[1].match?.fromFile, true)
  })
  it('matching uses the batch, case-insensitively', () => {
    const rs = run([row('PAINT', '1.5', { batch: 'b-1' }), row('PAINT', '2', { batch: 'B-2' })], ctx([rec({ product_id: 'p2', batch_number: 'B-1', quantity: 2.5, lot_cost: 50 })]))
    assert.deepEqual(rs.map((r) => [r.action, r.match?.newQuantity ?? null]), [['add', 4], ['new', null]])
  })
  it('a record awaiting approval or two records with different sources: refused with the reason', () => {
    const [p] = run([row('BOLT', '1')], ctx([rec({ status: 'PENDING_APPROVAL', document_number: 'OS-000009' })]))
    assert.match(p.errors.join(), /awaiting approval \(OS-000009\)/)
    const [m] = run([row('BOLT', '1')], ctx([rec({}), rec({ document_number: 'OS-000010' })]))
    assert.match(m.errors.join(), /more than one opening stock record/)
  })
  it('without the additive context (manual entry, older database) an existing record is still rejected', () => {
    const c = ctx([rec({})])
    delete c.additive
    const [r] = run([row('BOLT', '25')], c)
    assert.match(r.errors.join(), /already exists \(OS-000003\)/)
    assert.equal(r.action, undefined)
  })
})

describe('Fields to modify', () => {
  it('defaults: Quantity selected, Unit Cost and Remarks not', () => {
    assert.deepEqual(DEFAULT_IMPORT_FIELDS, { quantity: true, unit_cost: false, remarks: false })
    assert.deepEqual(IMPORT_FIELD_OPTIONS.map((o) => o.key), ['quantity', 'unit_cost', 'remarks'])
  })
  it('Quantity not selected: matched rows are shown as kept, never silently dropped', () => {
    const [r] = run([row('BOLT', '25')], ctx([rec({})], { quantity: false, unit_cost: false, remarks: false }))
    assert.deepEqual([r.status, r.action, r.match?.newQuantity, r.value], ['valid', 'keep', 100, null])
  })
  it('5. Unit Cost not selected: the Excel cost is not read, the added quantity takes the existing cost', () => {
    const [r] = run([row('BOLT', '10', { cost: '999' })], ctx([rec({})]))
    assert.deepEqual([r.status, r.excelCost, r.cost, r.payload?.unit_cost], ['valid', undefined, 20, null])
  })
  it('5. Unit Cost selected: the same cost is accepted, a different cost refused (posted stock is not re-valued)', () => {
    const f = { ...DEFAULT_IMPORT_FIELDS, unit_cost: true }
    const [same] = run([row('BOLT', '10', { cost: '20.00' })], ctx([rec({})], f))
    assert.deepEqual([same.status, same.excelCost, same.payload?.unit_cost], ['valid', 20, 20])
    const [diff] = run([row('BOLT', '10', { cost: '35' })], ctx([rec({})], f))
    assert.match(diff.errors.join(), /differs from the cost of the existing stock in OS-000003 \(20\)/)
  })
  it('6. a blank cost cell never erases: the existing cost is kept', () => {
    const [r] = run([row('BOLT', '3', { cost: '' })], ctx([rec({})], { ...DEFAULT_IMPORT_FIELDS, unit_cost: true }))
    assert.deepEqual([r.status, r.excelCost, r.cost, r.payload?.unit_cost], ['valid', undefined, 20, null])
  })
  it('6. a zero or invalid cost is refused, never stored as zero', () => {
    const f = { ...DEFAULT_IMPORT_FIELDS, unit_cost: true }
    for (const c of ['0', 'abc', '1.23456']) assert.match(run([row('BOLT', '1', { cost: c })], ctx([rec({})], f))[0].errors.join(), /greater than zero/, c)
  })
  it('8. stock without a cost: the addition stays pending; an Excel cost needs the override', () => {
    const none = rec({ product_id: 'p3', lot_cost: null })
    const [pending] = run([row('NUT', '5')], ctx([none]))
    assert.deepEqual([pending.status, pending.cost], ['valid', null])
    assert.match(pending.warnings.join(), /pending cost/)
    const f = { ...DEFAULT_IMPORT_FIELDS, unit_cost: true }
    assert.match(run([row('NUT', '5', { cost: '9' })], ctx([none], f))[0].errors.join(), /cost override/)
    const [over] = run([row('NUT', '5', { cost: '9' })], ctx([none], f, true))
    assert.deepEqual([over.status, over.cost, over.payload?.unit_cost], ['valid', 9, 9])
  })
  it('7. a different unit is refused, never combined', () => {
    const [r] = run([row('BOLT', '1', { unit: 'KG' })], ctx([rec({})]))
    assert.match(r.errors.join(), /does not match the product unit PCS/)
  })
  it('the cost column is found by name; value / amount columns are not costs', () => {
    assert.equal(excelCostColumn(['SKU', 'Qty', 'Unit Cost (Rs)']), 2)
    assert.equal(excelCostColumn(['SKU', 'Amount', 'Value']), null)
  })
})

describe('Wiring', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const page = readFileSync(path.join(src, 'pages/inventory/opening-stock-import-page.tsx'), 'utf8')
  it('the import page submits through the additive import and falls back when the database lacks it', () => {
    assert.match(page, /importOpeningStock\(lines, fields, canPost/)
    assert.match(page, /setAdditive\(matches !== null\)/)
    assert.match(page, /<OpeningImportFieldsCard/)
    assert.match(page, /unit_cost: v\.action === 'add' \? v\.excelCost \?\? null : null/)
  })
  it('manual opening stock entry is unchanged (no additive context)', () => {
    const manual = readFileSync(path.join(src, 'pages/inventory/opening-stock-page.tsx'), 'utf8')
    assert.doesNotMatch(manual, /additive|importOpeningStock/)
  })
})
