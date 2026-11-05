// Smart Excel import: only new or changed Product Master data is saved (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  autoMapColumns,
  buildFailedRowsReport,
  missingRequiredFields,
  productRowToFormValues,
  rowKind,
  summarizeImport,
  validateImportRows,
  type ExistingProduct,
  type ImportContext,
} from '../../src/features/products/product-import.ts'

const stored = (id: string, sku: string, over: Record<string, unknown> = {}): ExistingProduct => ({
  id, sku, updatedAt: '2026-11-01T10:00:00.123456+00:00',
  values: productRowToFormValues({
    sku, product_name: `Product ${sku}`, description: null, category_id: 'cat-wc', brand: null, model_number: null, barcode: null,
    status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: '6910', gst_rate: 18, selling_price: 700, standard_cost: null, minimum_selling_price: null, reorder_level: null,
    standard_manufacturing_cost: 450, mrp: 850, is_manufacturable: true, has_bom: false, production_notes: null, remarks: 'Keep me',
    ...over,
  } as Parameters<typeof productRowToFormValues>[0]),
})

const headers = ['SKU', 'Product Name', 'Product Type', 'Category', 'Standard Manufacturing Cost', 'MRP', 'GST Rate', 'HSN Code', 'Remarks']
const mapping = autoMapColumns(headers)
const ctxWith = (products: ExistingProduct[], extra: Partial<ImportContext> = {}): ImportContext => ({
  categories: [{ id: 'cat-wc', name: 'Water Closets', code: 'WC', is_active: true }],
  existingSkus: new Set(products.map((p) => p.sku.toLowerCase())),
  existingBarcodes: new Set(),
  duplicateMode: 'update',
  existingProducts: new Map(products.map((p) => [p.sku.toLowerCase(), p])),
  ...extra,
})
const erp = () => [stored('p1', 'WC-100'), stored('p2', 'WC-200')]
// The file as exported: same values as the ERP (numbers written differently).
const same = (sku: string) => [sku, `Product ${sku}`, 'Finished Good', 'Water Closets', '450.00', '850', '18%', '6910', 'Keep me']

describe('smart import: new, modified, unchanged, invalid', () => {
  it('1. a file of unchanged products: every row skipped, nothing to save', () => {
    const results = validateImportRows([same('WC-100'), [' wc-200 ', ...same('WC-200').slice(1)]], mapping, ctxWith(erp()))
    assert.deepEqual(results.map(rowKind), ['skipped', 'skipped'])
    assert.ok(results.every((r) => r.skipReason === 'unchanged' && r.input === null))
    assert.equal(summarizeImport(results).valid, 0)
  })

  it('2. one changed product: only the changed fields are updated; the comparison lists every supplied field', () => {
    const row = same('WC-100')
    row[4] = '475'
    row[5] = '900'
    const [r] = validateImportRows([row], mapping, ctxWith(erp()))
    assert.equal(rowKind(r), 'modified')
    assert.equal(r.productId, 'p1', 'the product id is kept (its transactions stay linked)')
    assert.equal(r.productUpdatedAt, '2026-11-01T10:00:00.123456+00:00')
    assert.deepEqual(r.input, { standard_manufacturing_cost: 475, mrp: 900 })
    const byLabel = new Map(r.compared!.map((c) => [c.label, c]))
    assert.deepEqual(byLabel.get('Standard Manufacturing Cost'), { field: 'standard_manufacturing_cost', label: 'Standard Manufacturing Cost', from: '₹450.00', to: '₹475.00', changed: true, action: 'update' })
    assert.deepEqual(byLabel.get('MRP'), { field: 'mrp', label: 'MRP', from: '₹850.00', to: '₹900.00', changed: true, action: 'update' })
    assert.deepEqual(byLabel.get('GST Rate'), { field: 'gst_rate', label: 'GST Rate', from: '18%', to: '18%', changed: false, action: 'unchanged' })
    assert.equal(byLabel.get('Category')?.from, 'Water Closets', 'names, not ids')
    assert.deepEqual(r.changes?.map((c) => c.label), ['MRP', 'Standard Manufacturing Cost'])
  })

  it('3. new and existing products in one file: new ones added, changed ones updated, unchanged skipped', () => {
    const changed = same('WC-200')
    changed[8] = 'Revised'
    const results = validateImportRows([same('WC-100'), changed, ['WC-300', 'New closet', 'Finished Good', '', '', '1200', '', '', '']], mapping, ctxWith(erp()))
    assert.deepEqual(results.map(rowKind), ['skipped', 'modified', 'new'])
    assert.deepEqual(results[1].input, { remarks: 'Revised' })
    assert.equal(results[2].input?.sku, 'WC-300')
    assert.equal(results[2].input?.mrp, 1200)
    const s = summarizeImport(results)
    assert.deepEqual([s.total, s.creates, s.updates, s.skipped, s.errors], [3, 1, 1, 1, 0])
  })

  it('4. the same file uploaded twice: the second time nothing is created or updated', () => {
    const file = [['WC-100', '', '', '', '475', '', '', '', ''], ['WC-300', 'New closet', 'Finished Good', '', '', '', '', '', ''], ['', 'Brand-new seat', 'Component', '', '', '', '', '', '']]
    const first = validateImportRows(file, mapping, ctxWith(erp()))
    assert.deepEqual(first.map(rowKind), ['modified', 'new', 'new'])
    // After the first import: WC-100 has the new cost, WC-300 exists, the seat got an automatic SKU.
    const after = [stored('p1', 'WC-100', { standard_manufacturing_cost: 475 }), stored('p2', 'WC-200'),
      stored('p3', 'WC-300', { product_name: 'New closet', category_id: null })]
    const second = validateImportRows(file, mapping, ctxWith(after, { existingNames: new Map([['brand-new seat', 'CMP-000001']]) }))
    assert.deepEqual(second.map(rowKind), ['skipped', 'skipped', 'ambiguous'])
    assert.ok(second[2].errors[0].includes('already exists (SKU CMP-000001)'), second[2].errors.join())
    assert.equal(summarizeImport(second).valid, 0)
  })

  it('5. blank Excel cells never erase ERP data', () => {
    const [r] = validateImportRows([['WC-100', '', '', '', '', '', '', '', '']], mapping, ctxWith(erp()))
    assert.equal(rowKind(r), 'skipped', 'nothing supplied = nothing to change')
    const [m] = validateImportRows([['WC-100', '', '', '', '', '990', '', '', '']], mapping, ctxWith(erp()))
    assert.deepEqual(m.input, { mrp: 990 }, 'only the filled cell; name, cost, GST, HSN, remarks are untouched')
    assert.deepEqual(m.compared?.filter((c) => c.action !== 'blank').map((c) => c.field), ['mrp'])
    assert.ok(m.compared?.filter((c) => c.action === 'blank').every((c) => !c.changed && c.to === 'Blank'), 'blank cells are shown as kept')
  })

  it('6. a SKU repeated in the file (any case or spacing) is invalid on every row', () => {
    const results = validateImportRows([same('WC-100'), ['', 'Seat', 'Component', '', '', '', '', '', ''], same(' wc-100'), ['', ' seat ', 'Component', '', '', '', '', '', '']],
      mapping, ctxWith(erp()))
    assert.deepEqual(results.map(rowKind), ['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous'])
    assert.ok(results[0].errors[0].startsWith('Duplicate SKU in this file: rows 2, 4'))
    assert.ok(results[1].errors[0].startsWith('Duplicate product in this file: rows 3, 5'))
  })

  it('7. matching uses only the products of the user\'s company (an unknown SKU is new, never another company\'s product)', () => {
    // existingSkus / existingProducts come from company-scoped lookups; a SKU held only by another company is not in them.
    const [r] = validateImportRows([['OTHER-CO-1', 'Their basin', 'Finished Good', '', '', '', '', '', '']], mapping, ctxWith(erp()))
    assert.equal(rowKind(r), 'new')
    assert.equal(r.productId, undefined)
  })

  it('8. an update never changes the SKU or id, so transaction history stays linked', () => {
    const row = same('wc-100')
    row[1] = 'Renamed closet'
    const [r] = validateImportRows([row], mapping, ctxWith(erp()))
    assert.equal(r.sku, 'WC-100', 'the stored SKU is kept, not the spelling in the file')
    assert.deepEqual(Object.keys(r.input ?? {}), ['product_name'])
    assert.ok(!('sku' in (r.input ?? {})) && !('id' in (r.input ?? {})))
  })

  it('invalid values in an existing product are reported on the row, not skipped silently', () => {
    const row = same('WC-100')
    row[7] = '12'
    const [r] = validateImportRows([row], mapping, ctxWith(erp()))
    assert.equal(rowKind(r), 'invalid')
    assert.ok(r.errors.some((e) => e.startsWith('HSN Code')))
  })

  it('needs only the SKU column for smart import; without SKUs, new products need name and type', () => {
    assert.deepEqual(missingRequiredFields(autoMapColumns(['SKU', 'MRP']), 'update'), [])
    assert.deepEqual(missingRequiredFields(autoMapColumns(['MRP']), 'update'), ['Product Name', 'Product Type'])
  })

  it('the failed-row report lists each failed row with its reasons and original cells', () => {
    const data = [same('WC-100'), ['WC-9', 'Bad', 'Toilet', '', '', '', '', '', ''], ['WC-10', 'Ok', 'Finished Good', '', '', '', '', '', '']]
    const results = validateImportRows(data, mapping, ctxWith(erp()))
    const saved = results.map((r) => (r.sku === 'WC-10' ? { ...r, saveError: 'Network error' } : r))
    const report = buildFailedRowsReport(saved, headers, data, 2)
    assert.deepEqual(report[0], ['Row', 'Error reasons', ...headers])
    assert.equal(report.length, 3)
    assert.equal(report[1][0], '3')
    assert.ok(report[1][1].includes('Product Type "Toilet"'))
    assert.deepEqual(report[1].slice(2), data[1])
    assert.deepEqual(report[2].slice(0, 2), ['4', 'Network error'])
  })
})
