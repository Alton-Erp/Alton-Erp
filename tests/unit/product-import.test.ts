// Unit tests for product validation and spreadsheet import (no database).
// Run: npm run test:unit   (Node's built-in test runner with type stripping)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'

import {
  autoMapColumns,
  buildErrorReport,
  detectHeaderRow,
  missingRequiredFields,
  splitAtHeader,
  summarizeImport,
  validateImportRows,
  type ImportCategory,
} from '../../src/features/products/product-import.ts'
import { findUnit, parseDecimal, parseProductType, parseSourceType, skuKey } from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'
import { parseWorkbook, toCsv } from '../../src/features/products/spreadsheet.ts'

const CATEGORIES: ImportCategory[] = [
  { id: 'cat-basins', name: 'Wash Basins', code: 'WASH_BASINS', is_active: true },
  { id: 'cat-old', name: 'Discontinued', code: 'OLD', is_active: false },
]

function workbookBuffer(rows: (string | number)[][], sheetName = 'Products'): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

describe('value parsing', () => {
  it('parses source and product types leniently', () => {
    assert.equal(parseSourceType('In House'), 'IN_HOUSE')
    assert.equal(parseSourceType('in-house'), 'IN_HOUSE')
    assert.equal(parseSourceType('Outsourced'), 'OUTSOURCED')
    assert.equal(parseSourceType('hybrid'), 'HYBRID')
    assert.equal(parseSourceType('Inhouse?'), 'IN_HOUSE')
    assert.equal(parseSourceType('factory'), null)
    assert.equal(parseProductType('Finished Goods'), 'FINISHED_GOOD')
    assert.equal(parseProductType('Packaging'), 'PACKAGING_MATERIAL')
    assert.equal(parseProductType('toilet'), null)
  })

  it('normalises units and decimals', () => {
    assert.equal(findUnit('pcs'), 'PCS')
    assert.equal(findUnit('Nos.'), 'NOS')
    assert.equal(findUnit('Kgs'), 'KG')
    assert.equal(findUnit('litre'), 'L')
    assert.equal(findUnit('bucket'), null)
    assert.equal(parseDecimal('1,500.50', 2), 1500.5)
    assert.equal(parseDecimal('₹ 99', 2), 99)
    assert.equal(parseDecimal('18%', 2), 18)
    assert.equal(parseDecimal('', 2), undefined)
    assert.ok(Number.isNaN(parseDecimal('1.234', 2)))
    assert.ok(Number.isNaN(parseDecimal('abc', 2)))
  })

  it('compares SKUs case-insensitively', () => {
    assert.equal(skuKey(' WC-100 '), skuKey('wc-100'))
  })
})

describe('validateProduct', () => {
  const base = { ...EMPTY_PRODUCT_FORM, sku: 'WC-1', product_name: 'Closet', product_type: 'FINISHED_GOOD' as const, default_source_type: 'HYBRID' as const }

  it('accepts optional commercial fields left blank', () => {
    const r = validateProduct(base)
    assert.deepEqual(r.errors, {})
    assert.equal(r.input?.gst_rate, null)
    assert.equal(r.input?.selling_price, null)
    assert.equal(r.input?.standard_cost, null)
  })

  it('rejects negative prices and minimum above selling price', () => {
    assert.ok(validateProduct({ ...base, selling_price: '-5' }).errors.selling_price)
    assert.ok(validateProduct({ ...base, selling_price: '100', minimum_selling_price: '150' }).errors.minimum_selling_price)
  })

  it('rejects invalid SKU, HSN and expiry without batches', () => {
    assert.ok(validateProduct({ ...base, sku: 'WC 1' }).errors.sku)
    assert.ok(validateProduct({ ...base, hsn_code: '12' }).errors.hsn_code)
    assert.ok(validateProduct({ ...base, track_expiry: true, track_batches: false }).errors.track_expiry)
  })

  it('gives recommendations without blocking save', () => {
    const r = validateProduct({ ...base, default_source_type: 'IN_HOUSE', is_manufacturable: false, gst_rate: '17' })
    assert.deepEqual(r.errors, {})
    assert.ok(r.input)
    assert.ok(r.warnings.some((w) => w.includes('manufacturable')))
    assert.ok(r.warnings.some((w) => w.includes('GST rate 17%')))
  })

  it('preserves the product name as entered (only trims ends)', () => {
    assert.equal(validateProduct({ ...base, product_name: '  Wall-Hung WC (Rimless)  ' }).input?.product_name, 'Wall-Hung WC (Rimless)')
  })
})

describe('spreadsheet import', () => {
  const header = ['SKU', 'Product Name', 'Category', 'Barcode', 'Product Type', 'Source Type', 'UOM', 'HSN Code', 'GST %', 'Selling Price', 'Standard Cost', 'Preferred Supplier']
  const rows: (string | number)[][] = [
    header,
    ['WB-001', 'Table-Top Basin', 'Wash Basins', '890100000001', 'Finished Good', 'In House', 'pcs', '6910', '18', '4,600', '3000', ''],
    ['WB-002', 'Pedestal Basin', 'WASH_BASINS', '', 'FG', 'Hybrid', 'Set', '', '', '', '', 'Some Vendor'],
    ['wb-001', 'Duplicate in file', '', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['WB-003', 'Bad source', '', '', 'Finished Good', 'Factory', 'PCS', '', '', '', '', ''],
    ['WB-004', 'Negative price', '', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '-10', '', ''],
    ['WB-005', 'Unknown category', 'Mirrors', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['WB-006', 'Inactive category', 'Discontinued', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['WB-007', 'Same barcode', '', '890100000001', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['EXISTING-1', 'Already in master', '', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['', 'No SKU', '', '', 'Finished Good', 'Outsourced', 'PCS', '', '', '', '', ''],
    ['WB-008', 'Odd GST', '', '', 'Raw Material', 'Outsourced', 'kg', '', '17', '', '', ''],
  ]

  async function parse(input = rows) {
    const wb = await parseWorkbook(workbookBuffer(input))
    assert.deepEqual(wb.sheetNames, ['Products'])
    const all = wb.rows('Products')
    const split = splitAtHeader(all, detectHeaderRow(all))
    return { headers: split.headers, data: split.data, first: split.firstDataRowNumber }
  }

  it('auto-maps common header names', async () => {
    const { headers } = await parse()
    const mapping = autoMapColumns(headers)
    assert.equal(mapping.sku, 0)
    assert.equal(mapping.unit, 6)
    assert.equal(mapping.gst_rate, 8)
    assert.equal(mapping.preferred_supplier, 11)
    assert.equal(mapping.description, null)
    assert.deepEqual(missingRequiredFields(mapping), [])
    // V2: only name and type are required; SKU, source type and unit default.
    assert.deepEqual(missingRequiredFields(autoMapColumns(['SKU', 'Name'])), ['Product Type'])
  })

  it('validates rows, detects duplicates and reports each problem', async () => {
    const { headers, data, first } = await parse()
    const results = validateImportRows(data, autoMapColumns(headers), {
      categories: CATEGORIES,
      existingSkus: new Set(['existing-1']),
      existingBarcodes: new Set(),
      duplicateMode: 'skip',
    }, first)
    const byRow = new Map(results.map((r) => [r.rowNumber, r]))

    assert.equal(results.length, 11, 'blank row is ignored')
    assert.equal(byRow.get(11)?.sku, 'EXISTING-1', 'row numbers after a blank row still match the spreadsheet')
    assert.equal(byRow.get(2)?.status, 'valid')
    assert.equal(byRow.get(2)?.input?.category_id, 'cat-basins')
    assert.equal(byRow.get(2)?.input?.default_source_type, 'IN_HOUSE')
    assert.equal(byRow.get(2)?.input?.selling_price, 4600)
    assert.equal(byRow.get(3)?.status, 'valid', 'category matched by code; blank commercial fields ok')
    assert.equal(byRow.get(3)?.input?.base_unit, 'SET')
    assert.ok(byRow.get(3)?.warnings.some((w) => w.includes('Preferred Supplier')))
    assert.ok(byRow.get(4)?.errors.some((e) => e.includes('Duplicate SKU') && e.includes('row 2')))
    assert.ok(byRow.get(5)?.errors.some((e) => e.includes('Source Type "Factory"')))
    assert.ok(byRow.get(6)?.errors.some((e) => e.startsWith('Selling Price')))
    assert.ok(byRow.get(7)?.errors.some((e) => e.includes('does not exist')))
    assert.ok(byRow.get(8)?.errors.some((e) => e.includes('inactive')))
    assert.ok(byRow.get(9)?.errors.some((e) => e.includes('Duplicate barcode')))
    assert.equal(byRow.get(11)?.status, 'skipped')
    // V2: a row without a SKU is imported; the database assigns the next FG- code.
    assert.equal(byRow.get(12)?.status, 'valid')
    assert.equal(byRow.get(12)?.input?.sku, null)
    assert.ok(byRow.get(12)?.warnings.some((w) => w.includes('FG-') && w.includes('automatically')))
    assert.equal(byRow.get(13)?.status, 'valid')
    assert.ok(byRow.get(13)?.warnings.some((w) => w.includes('17%')))

    assert.deepEqual(summarizeImport(results), { total: 11, valid: 4, creates: 4, updates: 0, withWarnings: 4, skipped: 1, errors: 6 })
    for (const r of results) assert.equal(r.input === null, r.status !== 'valid', 'only valid rows carry an insert payload')
  })

  it('keeps real row numbers when title rows sit above the header', async () => {
    const { headers, data, first } = await parse([['Alton product list'], [], ...rows])
    assert.equal(first, 4)
    const results = validateImportRows(data, autoMapColumns(headers), {
      categories: CATEGORIES, existingSkus: new Set(), existingBarcodes: new Set(), duplicateMode: 'skip',
    }, first)
    assert.equal(results[0].rowNumber, 4)
    assert.equal(results[0].sku, 'WB-001')
  })

  it('treats existing SKUs as errors in error mode', async () => {
    const { headers, data, first } = await parse()
    const results = validateImportRows(data, autoMapColumns(headers), {
      categories: CATEGORIES,
      existingSkus: new Set(['existing-1']),
      existingBarcodes: new Set(['890100000001']),
      duplicateMode: 'error',
    }, first)
    const existing = results.find((r) => r.sku === 'EXISTING-1')
    assert.equal(existing?.status, 'error')
    assert.ok(existing?.errors.some((e) => e.includes('already exists')))
    assert.ok(results.find((r) => r.rowNumber === 2)?.errors.some((e) => e.includes('Barcode is already used')))
  })

  it('builds an error report and escapes formulas in CSV', () => {
    const report = buildErrorReport([
      { rowNumber: 5, sku: 'X', productName: '=HYPERLINK("http://evil")', status: 'error', errors: ['bad'], warnings: [], input: null },
    ])
    assert.equal(report.length, 2)
    const csv = toCsv(report as (string | number)[][])
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), csv)
  })
})
