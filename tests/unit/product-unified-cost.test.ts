// One standard cost (20261127090000) and the calculated Product Master Cost (20261128090000):
// form, import, export and template rules (no database).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { costChange, masterCost, masterCostNote } from '../../src/features/products/master-cost.ts'
import { productGaps } from '../../src/features/products/product-completeness.ts'
import { EXPORT_COLUMNS, productExportRows } from '../../src/features/products/product-export.ts'
import {
  autoMapColumns, costColumn, costColumnNote, IMPORT_FIELDS, modifiableFields, productRowToFormValues, rowKind, validateImportRows,
  type ExistingProduct, type ImportContext,
} from '../../src/features/products/product-import.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'

const stored = (id: string, sku: string, cost: number | null): ExistingProduct => ({
  id, sku, updatedAt: '2026-11-01T10:00:00+00:00',
  values: productRowToFormValues({
    sku, product_name: `Product ${sku}`, description: null, category_id: null, brand: null, model_number: null, barcode: null,
    status: 'ACTIVE', product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: '6910', gst_rate: 18, selling_price: null, standard_cost: cost, minimum_selling_price: null, reorder_level: null,
    standard_manufacturing_cost: cost, mrp: null, is_manufacturable: false, has_bom: false, production_notes: null, remarks: null,
  } as Parameters<typeof productRowToFormValues>[0]),
})
const ctx = (products: ExistingProduct[]): ImportContext => ({
  categories: [], existingSkus: new Set(products.map((p) => p.sku.toLowerCase())), existingBarcodes: new Set(), duplicateMode: 'update',
  existingProducts: new Map(products.map((p) => [p.sku.toLowerCase(), p])),
})
const importRow = (headers: string[], row: string[], products = [stored('p1', 'RM-1', 40)]) => {
  const mapping = autoMapColumns(headers)
  return { mapping, result: validateImportRows([row], mapping, ctx(products))[0] }
}

describe('Product form: one Cost field', () => {
  const base = { ...EMPTY_PRODUCT_FORM, product_name: 'Clay', product_type: 'RAW_MATERIAL' as const, base_unit: 'KGS' }
  it('4/5. new and edited products save Cost into standard_cost only; no separate manufacturing cost is sent', () => {
    const v = validateProduct({ ...base, standard_cost: '12.50' })
    assert.equal(v.input?.standard_cost, 12.5)
    assert.ok(!('standard_manufacturing_cost' in (v.input ?? {})))
    assert.ok(!('standard_manufacturing_cost' in EMPTY_PRODUCT_FORM))
    assert.equal(validateProduct({ ...base, standard_cost: '0' }).input?.standard_cost, 0)
  })
  it('a negative or non-numeric Cost is refused with a clear message', () => {
    assert.match(validateProduct({ ...base, standard_cost: '-1' }).errors.standard_cost!, /non-negative/)
    assert.match(validateProduct({ ...base, standard_cost: 'abc' }).errors.standard_cost!, /non-negative/)
  })
  it('the form has one standard-cost input (the fallback Cost) and no purchase cost input', () => {
    const form = readFileSync(new URL('../../src/pages/products/product-form-page.tsx', import.meta.url), 'utf8')
    assert.match(form, /label="Standard Manufacturing Cost \(₹\)" htmlFor="p-standard_cost"/)
    assert.ok(!/Standard Purchase Cost|p-standard_manufacturing_cost/.test(form))
  })
  it('missing-cost rule: Cost blank → missing; zero is a cost', () => {
    const rm = { product_type: 'RAW_MATERIAL', hsn_code: '1', gst_rate: 5, category_id: 'c', selling_price: null }
    assert.deepEqual(productGaps({ ...rm, standard_cost: null }).map((g) => g.key), ['cost'])
    assert.deepEqual(productGaps({ ...rm, standard_cost: 0 }), [])
  })
})

describe('Product import: the standard (fallback) cost', () => {
  it('6. the "Cost" header (template) fills the standard cost', () => {
    const { result } = importRow(['SKU', 'Cost'], ['RM-1', '55'])
    assert.equal(rowKind(result), 'modified')
    assert.deepEqual(result.input, { standard_cost: 55 })
    assert.deepEqual(result.changes?.map((c) => [c.label, c.from, c.to]), [['Standard Cost', '₹40.00', '₹55.00']])
  })
  it('7. a file with only "Standard Manufacturing Cost" fills the standard cost', () => {
    const { result } = importRow(['SKU', 'Standard Manufacturing Cost'], ['RM-1', '60'])
    assert.deepEqual(result.input, { standard_cost: 60 })
  })
  it('8. both earlier columns: Standard Manufacturing Cost is used, Standard Purchase Cost ignored (even when higher)', () => {
    const { mapping, result } = importRow(['SKU', 'Standard Purchase Cost', 'Standard Manufacturing Cost'], ['RM-1', '99', '61'])
    assert.equal(costColumn(mapping), 'standard_manufacturing_cost')
    assert.deepEqual(result.input, { standard_cost: 61 })
    assert.equal(costColumnNote(mapping), 'The standard (fallback) cost is read from "Standard Manufacturing Cost"; "Standard Purchase Cost" is ignored.')
    assert.deepEqual(modifiableFields(mapping).map((f) => f.key), ['standard_manufacturing_cost'], 'only the column that is read can be selected')
  })
  it('10. an exported file (calculated Cost + Standard Manufacturing Cost): the fallback is read, the calculated Cost never saved', () => {
    const { mapping, result } = importRow(['SKU', 'Standard Purchase Cost', 'Cost', 'Standard Manufacturing Cost'], ['RM-1', '99', '70', '61'])
    assert.equal(costColumn(mapping), 'standard_manufacturing_cost')
    assert.deepEqual(result.input, { standard_cost: 61 })
    assert.match(costColumnNote(mapping)!, /read from "Standard Manufacturing Cost"; "Cost" and "Standard Purchase Cost" are ignored\. \(An exported Cost is calculated/)
    const exported = importRow(['SKU', 'Cost', 'Last Purchase Cost', 'Last Purchase Date', 'Standard Manufacturing Cost'], ['RM-1', '470', '455', '2026-11-09', '40'])
    assert.equal(rowKind(exported.result), 'skipped', 'an unchanged export imports back without changes')
  })
  it('10. Last Purchase Cost / Date columns are never imported', () => {
    const { mapping, result } = importRow(['SKU', 'Last Purchase Cost', 'Last Purchase Date'], ['RM-1', '999', '2026-11-01'])
    assert.ok(Object.values(mapping).every((i) => i !== 1 && i !== 2), JSON.stringify(mapping))
    assert.equal(rowKind(result), 'skipped')
  })
  it('an earlier file with only "Standard Purchase Cost" still imports it as the standard cost', () => {
    const { result } = importRow(['SKU', 'Standard Purchase Cost'], ['RM-1', '48'])
    assert.deepEqual(result.input, { standard_cost: 48 })
  })
  it('a blank cost cell keeps the stored value; the same value is unchanged', () => {
    assert.equal(rowKind(importRow(['SKU', 'Cost'], ['RM-1', '']).result), 'skipped')
    assert.equal(rowKind(importRow(['SKU', 'Cost'], ['RM-1', '40.00']).result), 'skipped')
  })
  it('invalid or negative costs are row errors and nothing of that row is saved', () => {
    for (const bad of ['-5', 'abc', '1.234']) {
      const { result } = importRow(['SKU', 'Cost', 'MRP'], ['RM-1', bad, '900'])
      assert.equal(result.status, 'error', bad)
      assert.equal(result.input, null, bad)
      assert.ok(result.errors.some((e) => e.startsWith('Standard Cost: ')), result.errors.join())
    }
    const legacy = importRow(['SKU', 'Standard Manufacturing Cost'], ['RM-1', '-1']).result
    assert.ok(legacy.errors.some((e) => e.startsWith('Standard Cost: ')), legacy.errors.join())
  })
  it('new products get the standard cost from whichever column is read', () => {
    const { result } = importRow(['Product Name', 'Product Type', 'Standard Purchase Cost', 'Standard Manufacturing Cost'], ['Glaze', 'Raw Material', '30', '0'], [])
    assert.equal(rowKind(result), 'new')
    assert.equal(result.input?.standard_cost, 0, 'a zero manufacturing cost is kept, not replaced by the purchase cost')
  })
  it('the template has one "Cost" column; the other cost columns are recognised but not in the template', () => {
    const template = IMPORT_FIELDS.filter((f) => !('legacy' in f)).map((f) => f.label)
    assert.ok(template.includes('Cost'))
    assert.ok(!template.some((l) => /Purchase Cost|Manufacturing Cost/.test(l)))
  })
})

describe('Product export: calculated Cost, Last Purchase Cost / Date and the fallback', () => {
  const row = (over: Record<string, unknown>) => ({ sku: 'RM-1', product_name: 'Product RM-1', product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED',
    base_unit: 'PCS', standard_cost: 451, standard_manufacturing_cost: 451, status: 'ACTIVE', is_manufacturable: false, has_bom: false, ...over }) as never
  it('9. Cost = the Product Master Cost (second-most-recent receipt), with Last Purchase Cost, Date and the fallback', () => {
    assert.deepEqual(EXPORT_COLUMNS.filter((c) => /cost|purchase date/i.test(c)), ['Cost', 'Last Purchase Cost', 'Last Purchase Date', 'Standard Manufacturing Cost'])
    const rows = productExportRows([row({ master_cost: 440, master_cost_source: 'PURCHASE', fallback_cost: 451, last_purchase_cost: 460, last_purchase_date: '2026-11-09' })], [])
    const at = (h: string) => rows[1][rows[0].indexOf(h)]
    assert.deepEqual([at('Cost'), at('Last Purchase Cost'), at('Last Purchase Date'), at('Standard Manufacturing Cost')], [440, 460, '2026-11-09', 451])
    const mapping = autoMapColumns(rows[0].map(String))
    assert.equal(costColumn(mapping), 'standard_manufacturing_cost', 'a re-import reads the fallback, never the calculated Cost')
  })
  it('without the view (database before 20261128) the export shows the standard cost as Cost', () => {
    const rows = productExportRows([row({})], [])
    assert.equal(rows[1][rows[0].indexOf('Cost')], 451)
    assert.equal(rows[1][rows[0].indexOf('Last Purchase Cost')], null)
  })
})

describe('Product Master Cost helpers', () => {
  it('reads the view columns; falls back to the standard cost (manufacturing first) without them', () => {
    assert.deepEqual(masterCost({ standard_cost: 451, master_cost: 440, master_cost_source: 'PURCHASE', master_cost_receipt_number: 'GRN-000001',
      master_cost_receipt_date: '2026-11-01', fallback_cost: 451 }), { cost: 440, source: 'PURCHASE', receiptNumber: 'GRN-000001', receiptDate: '2026-11-01', fallback: 451 })
    assert.deepEqual(masterCost({ standard_cost: 80, standard_manufacturing_cost: 120 }), { cost: 120, source: 'STANDARD', receiptNumber: null, receiptDate: null, fallback: 120 })
    assert.equal(masterCost({ standard_cost: null }).source, null)
  })
  it('Cost Change = Last Purchase Cost − Cost (₹460 − ₹440 = +₹20, +4.55%)', () => {
    assert.deepEqual(costChange(460, 440), { difference: 20, percent: 4.55, trend: 'up' })
    assert.deepEqual(costChange(440, 451), { difference: -11, percent: -2.44, trend: 'down' })
    assert.equal(costChange(null, 440), null)
    assert.equal(costChange(10, 0)?.percent, null)
  })
  it('the cost note says where the value comes from', () => {
    const d = (x: string) => x
    assert.match(masterCostNote({ cost: 440, source: 'PURCHASE', receiptNumber: 'GRN-000001', receiptDate: '2026-11-01', fallback: 451 }, d), /Second-most-recent purchase receipt GRN-000001/)
    assert.match(masterCostNote({ cost: 451, source: 'STANDARD', receiptNumber: null, receiptDate: null, fallback: 451 }, d), /until the product has two valid purchase receipts/)
  })
})
