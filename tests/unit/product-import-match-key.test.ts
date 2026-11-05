// Excel import: the match key chosen in ERP Settings → Products (SKU, Barcode, EAN, Model Number, Product Name, None).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  autoMapColumns,
  identityMaps,
  matchIds,
  matchValue,
  missingRequiredFields,
  modifiableFields,
  productRowToFormValues,
  rowKind,
  validateImportRows,
  type ExistingProduct,
  type ImportContext,
  type ImportFieldKey,
  type MatchKey,
  type ProductIdentity,
} from '../../src/features/products/product-import.ts'
import { skuKey } from '../../src/features/products/product-model.ts'

const stored = (id: string, sku: string, over: Record<string, unknown> = {}): ExistingProduct => ({
  id, sku, updatedAt: '2026-11-01T10:00:00+00:00',
  values: productRowToFormValues({
    sku, product_name: `Product ${sku}`, description: null, category_id: null, brand: null, model_number: `M-${sku}`, barcode: `BC-000${id}`, ean: null,
    status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: '6910', gst_rate: 18, selling_price: 700, standard_cost: null, minimum_selling_price: null, reorder_level: null,
    standard_manufacturing_cost: 450, mrp: 850, is_manufacturable: true, has_bom: false, production_notes: null, remarks: null,
    ...over,
  } as Parameters<typeof productRowToFormValues>[0]),
})
const erp = () => [
  stored('1', 'WC-100', { ean: '8901234567890' }),
  stored('2', 'WC-200', { model_number: 'TWIN' }),
  stored('3', 'WC-300', { model_number: 'TWIN' }),
]
const identity = (p: ExistingProduct): ProductIdentity => ({ id: p.id, sku: p.sku, product_name: p.values.product_name,
  barcode: p.values.barcode || null, ean: p.values.ean || null, model_number: p.values.model_number || null })

const headers = ['SKU', 'Product Name', 'Barcode', 'EAN', 'Model Number', 'MRP', 'Product Type']
const mapping = autoMapColumns(headers)
/** The context the import page builds for a match key. */
function ctxFor(matchKey: MatchKey, file: string[][], fields?: ImportFieldKey[], products = erp()): ImportContext {
  const ids = identityMaps(products.map(identity))
  const byId = new Map(products.map((p) => [p.id, p]))
  const index = matchIds(products.map(identity), matchKey)
  const col = { BARCODE: 2, EAN: 3, MODEL_NUMBER: 4, PRODUCT_NAME: 1 }[matchKey as 'BARCODE']
  const matchIndex = new Map<string, ExistingProduct[]>()
  for (const r of file) {
    const v = col === undefined ? '' : matchValue(matchKey, r[col])
    if (v && index.has(v)) matchIndex.set(v, index.get(v)!.map((id) => byId.get(id)!))
  }
  return {
    categories: [], existingBarcodes: new Set(), duplicateMode: 'update',
    existingSkus: ids.existingSkus, existingNames: ids.existingNames, looseSkus: ids.looseSkus, skuOwners: ids.skuIds,
    existingProducts: new Map(products.map((p) => [skuKey(p.sku), p])),
    matchKey, matchIndex, modifyFields: fields ? new Set(fields) : undefined,
  }
}
const run = (key: MatchKey, file: string[][], fields?: ImportFieldKey[]) => validateImportRows(file, mapping, ctxFor(key, file, fields))

describe('match key: which field finds existing products', () => {
  it('the match key column is locked; SKU becomes selectable when another field matches', () => {
    assert.ok(!modifiableFields(mapping, 'SKU').some((f) => f.key === 'sku'))
    const byBarcode = modifiableFields(mapping, 'BARCODE').map((f) => f.key)
    assert.ok(byBarcode.includes('sku') && !byBarcode.includes('barcode'))
    assert.deepEqual(modifiableFields(mapping, 'NONE'), [])
    assert.deepEqual(missingRequiredFields(autoMapColumns(['Barcode', 'MRP']), 'update', 'BARCODE'), [])
    assert.ok(missingRequiredFields(autoMapColumns(['SKU', 'MRP']), 'update', 'BARCODE').length > 0, 'the barcode column is needed to match by barcode')
  })

  it('Barcode: the row updates the product with that barcode, even with a different SKU in the file', () => {
    const [r] = run('BARCODE', [['', '', 'bc-0001', '', '', '990', '']], ['mrp'])
    assert.equal(rowKind(r), 'modified')
    assert.equal(r.productId, '1')
    assert.deepEqual(r.input, { mrp: 990 })
  })

  it('EAN: matched by digits, spaces and dashes ignored', () => {
    const [r] = run('EAN', [['', '', '', '890-1234 567890', '', '990', '']], ['mrp'])
    assert.equal(r.productId, '1')
    assert.equal(rowKind(r), 'modified')
  })

  it('Model Number shared by two products is ambiguous, never guessed', () => {
    const [r] = run('MODEL_NUMBER', [['', '', '', '', 'twin', '990', '']])
    assert.equal(rowKind(r), 'ambiguous')
    assert.ok(r.errors[0].includes('2 products have this Model Number') && r.errors[0].includes('WC-200, WC-300'))
    const [one] = run('MODEL_NUMBER', [['', '', '', '', 'm-wc-100', '990', '']], ['mrp'])
    assert.equal(one.productId, '1')
  })

  it('Product Name: matched ignoring case and spaces', () => {
    const [r] = run('PRODUCT_NAME', [['', '  product   WC-200 ', '', '', '', '990', '']], ['mrp'])
    assert.equal(r.productId, '2')
    assert.deepEqual(r.input, { mrp: 990 })
  })

  it('the SKU changes only when it is selected, and never to another product\'s SKU', () => {
    const file = [['WC-NEW', '', 'bc-0001', '', '', '', '']]
    const [kept] = run('BARCODE', file, ['mrp'])
    assert.equal(rowKind(kept), 'skipped')
    assert.ok(kept.warnings.some((w) => w.includes('SKU is not changed')))
    const [renamed] = run('BARCODE', file, ['sku'])
    assert.equal(rowKind(renamed), 'modified')
    assert.deepEqual(renamed.input, { sku: 'WC-NEW' })
    assert.deepEqual(renamed.compared?.map((c) => [c.field, c.from, c.to]), [['sku', 'WC-100', 'WC-NEW']])
    const [taken] = run('BARCODE', [['WC-200', '', 'bc-0001', '', '', '', '']], ['sku'])
    assert.equal(rowKind(taken), 'ambiguous')
    assert.ok(taken.errors[0].includes('already used by another product'))
  })

  it('no match by the key but the SKU exists: not created twice', () => {
    const [r] = run('BARCODE', [['wc-100', 'Other', 'NEWCODE', '', '', '', 'Finished Good']])
    assert.equal(rowKind(r), 'ambiguous')
    assert.ok(r.errors[0].includes('a SKU is never used twice'))
  })

  it('a match value repeated in the file is ambiguous on every row', () => {
    const rows = run('BARCODE', [['', '', 'BC-0001', '', '', '1', ''], ['', '', 'bc-0001', '', '', '2', '']])
    assert.deepEqual(rows.map(rowKind), ['ambiguous', 'ambiguous'])
  })

  it('a new product (no match) is created with every mapped column', () => {
    const [r] = run('BARCODE', [['WC-900', 'Wall closet', 'BC900', '', '', '600', 'Finished Good']], ['mrp'])
    assert.equal(rowKind(r), 'new')
    assert.equal(r.input?.sku, 'WC-900')
    assert.equal(r.input?.barcode, 'BC900')
  })

  it('None: existing products are never changed; existing SKUs are skipped, new rows added', () => {
    const results = run('NONE', [['WC-100', '', '', '', '', '990', ''], ['WC-901', 'Fresh one', '', '', '', '', 'Finished Good']])
    assert.deepEqual(results.map(rowKind), ['skipped', 'new'])
    assert.equal(results[0].skipReason, 'exists')
    assert.equal(results[0].input, null)
  })

  it('SKU (default) behaves as before', () => {
    const [r] = run('SKU', [[' wc-100 ', '', '', '', '', '990', '']], ['mrp'])
    assert.equal(r.productId, '1')
    assert.deepEqual(r.input, { mrp: 990 })
  })
})
