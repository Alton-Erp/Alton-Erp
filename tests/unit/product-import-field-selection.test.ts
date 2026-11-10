// Excel import: fields to modify in existing products, SKU matching and duplicate protection (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  autoMapColumns,
  identityMaps,
  modifiableFields,
  newProductConflict,
  productRowToFormValues,
  rowKind,
  summarizeImport,
  validateImportRows,
  type ExistingProduct,
  type ImportContext,
  type ImportFieldKey,
  type ProductIdentity,
} from '../../src/features/products/product-import.ts'
import { cleanSku, looseSkuKey, skuKey } from '../../src/features/products/product-model.ts'

const stored = (id: string, sku: string, over: Record<string, unknown> = {}): ExistingProduct => ({
  id, sku, updatedAt: '2026-11-01T10:00:00.123456+00:00',
  values: productRowToFormValues({
    sku, product_name: `Product ${sku}`, description: 'Stored description', category_id: 'cat-wc', brand: null, model_number: null, barcode: null,
    status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: '84818020', gst_rate: 18, selling_price: 700, standard_cost: 450, minimum_selling_price: null, reorder_level: null,
    standard_manufacturing_cost: 450, mrp: 850, is_manufacturable: true, has_bom: false, production_notes: null, remarks: null,
    ...over,
  } as Parameters<typeof productRowToFormValues>[0]),
})

const headers = ['SKU', 'Product Name', 'Category', 'Standard Manufacturing Cost', 'MRP', 'Selling Price', 'HSN Code', 'GST Rate', 'Unit', 'Product Type']
const mapping = autoMapColumns(headers)
const erp = () => [stored('p1', 'WC-100'), stored('p2', 'WC-200')]
const identities = (products: ExistingProduct[]): ProductIdentity[] => products.map((p) => ({ id: p.id, sku: p.sku, product_name: p.values.product_name }))
const ctxWith = (products: ExistingProduct[], fields?: ImportFieldKey[], extra: Partial<ImportContext> = {}): ImportContext => {
  const maps = identityMaps(identities(products))
  return {
    categories: [{ id: 'cat-wc', name: 'Water Closets', code: 'WC', is_active: true }, { id: 'cat-b', name: 'Basins', code: 'BS', is_active: true }],
    existingSkus: maps.existingSkus,
    existingBarcodes: new Set(),
    duplicateMode: 'update',
    existingProducts: new Map(products.map((p) => [skuKey(p.sku), p])),
    existingNames: maps.existingNames,
    looseSkus: maps.looseSkus,
    modifyFields: fields ? new Set(fields) : undefined,
    ...extra,
  }
}
// Every value differs from the ERP: name, category, cost, MRP, price, HSN, GST, unit.
const allChanged = (sku: string) => [sku, 'Renamed product', 'Basins', '475', '900', '750', '69101000', '12', 'BOX', 'Finished Good']

describe('fields to modify in existing products', () => {
  it('lists every mapped column except the SKU', () => {
    assert.deepEqual(modifiableFields(mapping).map((f) => f.key),
      ['product_name', 'category', 'product_type', 'unit', 'hsn_code', 'gst_rate', 'selling_price', 'mrp', 'standard_manufacturing_cost'])
    assert.ok(!modifiableFields(autoMapColumns(['SKU', 'MRP'])).some((f) => f.key === 'sku'))
  })

  it('1. only the cost is updated when only the cost is selected', () => {
    const [r] = validateImportRows([allChanged('WC-100')], mapping, ctxWith(erp(), ['standard_manufacturing_cost']))
    assert.equal(rowKind(r), 'modified')
    assert.deepEqual(r.input, { standard_cost: 475 })
    assert.deepEqual(r.compared?.map((c) => [c.field, c.action]), [['standard_cost', 'update']])
  })

  it('2. only the MRP is updated when only the MRP is selected', () => {
    const [r] = validateImportRows([allChanged('WC-100')], mapping, ctxWith(erp(), ['mrp']))
    assert.deepEqual(r.input, { mrp: 900 })
  })

  it('3. only the GST rate is updated when only the GST rate is selected', () => {
    const [r] = validateImportRows([allChanged('WC-100')], mapping, ctxWith(erp(), ['gst_rate']))
    assert.deepEqual(r.input, { gst_rate: 12 })
  })

  it('4. unselected fields stay unchanged, even when their cells are different or not valid', () => {
    const row = allChanged('WC-100')
    row[2] = 'No such category'
    row[8] = 'Bucket of bolts'
    const [r] = validateImportRows([row], mapping, ctxWith(erp(), ['standard_manufacturing_cost', 'mrp', 'gst_rate']))
    assert.equal(rowKind(r), 'modified', r.errors.join())
    assert.deepEqual(r.input, { standard_cost: 475, mrp: 900, gst_rate: 12 })
    for (const f of ['product_name', 'category_id', 'hsn_code', 'selling_price', 'base_unit', 'sku']) assert.ok(!(f in r.input!), `${f} must not change`)
    assert.deepEqual(r.compared?.map((c) => c.field).sort(), ['gst_rate', 'mrp', 'standard_cost'])
    assert.equal(r.productId, 'p1')
  })

  it('the comparison marks Update and Unchanged; no field selected skips existing products', () => {
    const row = allChanged('WC-100')
    row[6] = '84818020'
    const [r] = validateImportRows([row], mapping, ctxWith(erp(), ['mrp', 'hsn_code']))
    assert.deepEqual(r.compared?.map((c) => [c.label, c.from, c.to, c.action]), [['HSN Code', '84818020', '84818020', 'unchanged'], ['MRP', '₹850.00', '₹900.00', 'update']])
    const [none] = validateImportRows([allChanged('WC-100')], mapping, ctxWith(erp(), []))
    assert.equal(rowKind(none), 'skipped')
    assert.equal(none.skipReason, 'no-fields')
  })

  it('7. new SKUs create new products with every mapped column, whatever is selected', () => {
    const [r] = validateImportRows([['WC-900', 'Wall closet', 'Basins', '300', '600', '', '69101000', '18', 'PCS', 'Finished Good']], mapping, ctxWith(erp(), ['mrp']))
    assert.equal(rowKind(r), 'new')
    assert.equal(r.input?.sku, 'WC-900')
    assert.equal(r.input?.category_id, 'cat-b')
    assert.equal(r.input?.hsn_code, '69101000')
    assert.equal(r.input?.standard_cost, 300)
  })

  it('9. blank cells never erase data, even in selected fields', () => {
    const [r] = validateImportRows([['WC-100', '', '', '', '910', '', '', '', '', '']], mapping, ctxWith(erp()))
    assert.deepEqual(r.input, { mrp: 910 })
    assert.ok(r.compared!.filter((c) => c.action === 'blank').length >= 5, 'the blank selected cells are shown as kept')
  })
})

describe('SKU matching and duplicate protection', () => {
  it('6. SKUs match ignoring case, spaces, non-breaking spaces and invisible characters', () => {
    const rows = [' wc-100 ', 'WC-100​', '﻿wc-200 '].map((s) => { const r = allChanged(s); r[0] = s; return r })
    const results = validateImportRows([rows[0]], mapping, ctxWith(erp(), ['mrp']))
    assert.equal(rowKind(results[0]), 'modified')
    assert.equal(results[0].sku, 'WC-100', 'the stored SKU is kept')
    for (const row of rows.slice(1)) assert.equal(rowKind(validateImportRows([row], mapping, ctxWith(erp(), ['mrp']))[0]), 'modified', JSON.stringify(row[0]))
    assert.equal(cleanSku(' FG-1​ '), 'FG-1')
  })

  it('a SKU that differs only by separators is ambiguous, never matched or created', () => {
    for (const sku of ['WC100', 'wc 100', 'WC_100']) {
      const [r] = validateImportRows([allChanged(sku)], mapping, ctxWith(erp()))
      assert.equal(rowKind(r), 'ambiguous', sku)
      assert.ok(r.errors[0].includes('WC-100') && r.input === null)
    }
    assert.equal(looseSkuKey('FG-0001'), looseSkuKey('fg 0001'))
  })

  it('a product name already in the ERP is matched case-insensitively; a new SKU with it needs explicit permission', () => {
    const products = [...erp(), stored('p9', 'BS-1', { product_name: 'Wash Basin' })]
    const noSku = ['', 'WASH  BASIN', 'Basins', '', '', '', '', '', '', 'Finished Good']
    const [a] = validateImportRows([noSku], mapping, ctxWith(products))
    assert.equal(rowKind(a), 'ambiguous')
    assert.ok(a.errors[0].includes('SKU BS-1'))
    const newSku = ['BS-2', 'wash basin', 'Basins', '', '', '', '', '', '', 'Finished Good']
    assert.equal(rowKind(validateImportRows([newSku], mapping, ctxWith(products))[0]), 'ambiguous')
    const [allowed] = validateImportRows([newSku], mapping, ctxWith(products, undefined, { allowSameName: true }))
    assert.equal(rowKind(allowed), 'new')
    assert.ok(allowed.warnings.some((w) => w.includes('separate product')))
    // Rows without a SKU are never allowed through by that option.
    assert.equal(rowKind(validateImportRows([noSku], mapping, ctxWith(products, undefined, { allowSameName: true }))[0]), 'ambiguous')
  })

  it('8. a SKU repeated in the file is rejected on every row', () => {
    const results = validateImportRows([allChanged('WC-900'), allChanged(' wc-900 ')], mapping, ctxWith(erp()))
    assert.deepEqual(results.map(rowKind), ['ambiguous', 'ambiguous'])
    assert.equal(summarizeImport(results).valid, 0)
    assert.equal(summarizeImport(results).ambiguous, 2)
  })

  it('5. the same file uploaded twice creates nothing the second time', () => {
    const file = [allChanged('WC-100'), ['WC-300', 'New closet', 'Basins', '300', '600', '', '69101000', '18', 'PCS', 'Finished Good'],
      ['', 'Seat cover', '', '', '', '', '', '', '', 'Component']]
    const first = validateImportRows(file, mapping, ctxWith(erp()))
    assert.deepEqual(first.map(rowKind), ['modified', 'new', 'new'])
    // After saving: WC-100 has the new values, WC-300 exists and the seat got an automatic SKU.
    const after = [stored('p1', 'WC-100', { product_name: 'Renamed product', category_id: 'cat-b', standard_cost: 475, standard_manufacturing_cost: 475, mrp: 900, selling_price: 750,
      hsn_code: '69101000', gst_rate: 12, base_unit: 'BOX' }), stored('p2', 'WC-200'),
    stored('p3', 'WC-300', { product_name: 'New closet', category_id: 'cat-b', standard_cost: 300, standard_manufacturing_cost: 300, mrp: 600, selling_price: null, hsn_code: '69101000' }),
    stored('p4', 'CMP-000001', { product_name: 'Seat cover', product_type: 'COMPONENT' })]
    const second = validateImportRows(file, mapping, ctxWith(after))
    assert.equal(second.filter((r) => r.action === 'create').length, 0, 'no new product the second time')
    assert.deepEqual(second.map(rowKind), ['skipped', 'skipped', 'ambiguous'])
  })

  it('10. the check before saving refuses a SKU, a near-identical SKU or a name added by a concurrent import', () => {
    const now = identityMaps([{ id: 'x', sku: 'WC-300', product_name: 'New closet' }, { id: 'y', sku: 'CMP-000001', product_name: 'Seat Cover' }])
    assert.ok(newProductConflict({ sku: ' wc-300 ', product_name: 'Anything' }, now)?.includes('now exists'))
    assert.ok(newProductConflict({ sku: 'WC300', product_name: 'Anything' }, now)?.includes('almost the same'))
    assert.ok(newProductConflict({ sku: null, product_name: 'seat  cover' }, now)?.includes('CMP-000001'))
    assert.ok(newProductConflict({ sku: 'WC-301', product_name: 'new closet' }, now)?.includes('name'))
    assert.equal(newProductConflict({ sku: 'WC-301', product_name: 'new closet' }, now, true), null)
    assert.equal(newProductConflict({ sku: 'WC-999', product_name: 'Fresh' }, now), null)
  })

  it('11. only the company\'s own products are matched: a SKU of another company is a new product here', () => {
    // The lookups are built from the user's company only (RLS and a company filter); WC-777 belongs to another company.
    const [r] = validateImportRows([['WC-777', 'Other co product', '', '', '', '', '', '', '', 'Finished Good']], mapping, ctxWith(erp()))
    assert.equal(rowKind(r), 'new')
    assert.equal(r.productId, undefined, 'never an update of another company\'s product')
  })

  it('more SKU header spellings are recognised', () => {
    for (const h of ['Item SKU', 'SKU No.', 'Product SKU', 'SKU Number', 'SKU ID']) assert.equal(autoMapColumns([h, 'Name']).sku, 0, h)
  })
})
