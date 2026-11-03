// Unit tests for customer PO file reading, column mapping and row validation.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'

import { autoMapPo, checkPoFile, detectPoHeader, missingPoFields, parseDecimal, validatePoRows } from '../../src/features/customer-po/po-import.ts'
import { parseWorkbook } from '../../src/features/products/spreadsheet.ts'

const toBuffer = (wb: XLSX.WorkBook, bookType: 'xlsx' | 'xls' | 'csv' = 'xlsx') =>
  (bookType === 'csv'
    ? new TextEncoder().encode(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])).buffer
    : XLSX.write(wb, { bookType, type: 'array' })) as ArrayBuffer

function workbook(sheets: Record<string, unknown[][]>) {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  return wb
}

const PO_ROWS = [
  ['Acme Ltd — Purchase Order'],
  [],
  ['PO No', 'PO Date', 'Customer', 'Item Code', 'Description', 'Qty', 'UOM', 'Rate', 'GST %'],
  ['PO-1001', '2026-10-01', 'Acme Ltd', 'WC-100', 'Closet', '12', 'Nos', '1,250.50', '18'],
  ['PO-1001', '2026-10-01', 'Acme Ltd', 'BS-200', 'Basin', '3', 'PCS', '900', '18%'],
]

describe('reading customer PO files', () => {
  it('reads a valid .xlsx workbook and detects the header below a title row', async () => {
    const wb = await parseWorkbook(toBuffer(workbook({ PO: PO_ROWS })))
    const rows = wb.rows('PO')
    assert.equal(detectPoHeader(rows), 2)
  })

  it('reads a CSV file', async () => {
    const wb = await parseWorkbook(toBuffer(workbook({ PO: PO_ROWS }), 'csv'))
    assert.equal(wb.rows(wb.sheetNames[0])[3][3], 'WC-100')
  })

  it('reads a legacy .xls workbook', async () => {
    const wb = await parseWorkbook(toBuffer(workbook({ PO: PO_ROWS }), 'xls'))
    assert.equal(wb.rows('PO')[4][3], 'BS-200')
  })

  it('lists every worksheet of a multi-sheet workbook for selection', async () => {
    const wb = await parseWorkbook(toBuffer(workbook({ Cover: [['Terms']], Lines: PO_ROWS, Notes: [['x']] })))
    assert.deepEqual(wb.sheetNames, ['Cover', 'Lines', 'Notes'])
    assert.equal(wb.rows('Lines')[3][0], 'PO-1001')
  })

  it('rejects unsupported, empty and oversized files', () => {
    assert.match(checkPoFile('po.pdf', 100) ?? '', /not a supported/)
    assert.match(checkPoFile('po.xlsm', 100) ?? '', /not a supported/)
    assert.match(checkPoFile('po.xlsx', 0) ?? '', /empty/)
    assert.match(checkPoFile('po.csv', 6 * 1024 * 1024) ?? '', /5 MB/)
    assert.equal(checkPoFile('PO.XLSX', 1000), null)
  })
})

describe('column mapping', () => {
  it('maps customer-specific headers to system fields', () => {
    const m = autoMapPo(PO_ROWS[2] as string[])
    assert.equal(m.po_number, 0)
    assert.equal(m.po_date, 1)
    assert.equal(m.customer_name, 2)
    assert.equal(m.sku, 3)
    assert.equal(m.description, 4)
    assert.equal(m.quantity, 5)
    assert.equal(m.unit, 6)
    assert.equal(m.unit_price, 7)
    assert.equal(m.tax_rate, 8)
    assert.deepEqual(missingPoFields(m), [])
  })

  it('requires quantity and at least one product identifier', () => {
    const m = autoMapPo(['Remarks', 'Price'])
    assert.equal(missingPoFields(m).length, 2)
  })
})

describe('row validation', () => {
  const mapping = autoMapPo(PO_ROWS[2] as string[])

  it('accepts valid rows and extracts a consistent header', () => {
    const { rows, header } = validatePoRows(PO_ROWS.slice(3) as string[][], mapping, 4)
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.status === 'valid'))
    assert.equal(rows[0].payload?.quantity, 12)
    assert.equal(rows[0].payload?.unit_price, 1250.5)
    assert.equal(rows[0].payload?.unit, 'NOS')
    assert.equal(rows[1].payload?.tax_rate, 18)
    assert.deepEqual(header.poNumbers, ['PO-1001'])
    assert.deepEqual(header.poDates, ['2026-10-01'])
    assert.deepEqual(header.issues, [])
  })

  it('rejects negative, zero, non-numeric and blank quantities with row numbers', () => {
    const data = [
      ['PO-1', '2026-10-01', 'A', 'X1', '', '-5', '', '', ''],
      ['PO-1', '2026-10-01', 'A', 'X2', '', '0', '', '', ''],
      ['PO-1', '2026-10-01', 'A', 'X3', '', 'twelve', '', '', ''],
      ['PO-1', '2026-10-01', 'A', 'X4', '', '', '', '', ''],
      ['PO-1', '2026-10-01', 'A', 'X5', '', '1.2345', '', '', ''],
    ]
    const { rows } = validatePoRows(data, mapping, 10)
    assert.deepEqual(rows.map((r) => r.rowNumber), [10, 11, 12, 13, 14])
    assert.ok(rows.every((r) => r.status === 'error'))
    assert.match(rows[0].errors[0], /greater than zero/)
    assert.match(rows[2].errors[0], /number/)
    assert.match(rows[3].errors[0], /required/)
  })

  it('rejects invalid dates, prices, tax rates, currency and missing identification', () => {
    const m = autoMapPo(['PO No', 'PO Date', 'Item Code', 'Description', 'Qty', 'Rate', 'GST', 'Currency'])
    const { rows } = validatePoRows([
      ['P', '31-02-2026', 'A1', '', '1', '', '', ''],
      ['P', '', 'A2', '', '1', '-3', '', ''],
      ['P', '', 'A3', '', '1', '', '120', ''],
      ['P', '', 'A4', '', '1', '', '', 'RUPEES'],
      ['P', '', '', '', '1', '', '', ''],
    ], m)
    assert.ok(rows.every((r) => r.status === 'error'), JSON.stringify(rows))
    assert.match(rows[0].errors[0], /not a valid date/)
    assert.match(rows[4].errors[0], /No product identification/)
  })

  it('flags repeated product codes and identical rows for review without discarding them', () => {
    const { rows } = validatePoRows([
      ['PO-1', '', 'A', 'WC-100', '', '2', '', '', ''],
      ['PO-1', '', 'A', 'wc-100', '', '5', '', '', ''],
      ['PO-1', '', 'A', 'WC-100', '', '2', '', '', ''],
    ], mapping)
    assert.equal(rows.length, 3)
    assert.ok(rows.every((r) => r.status === 'valid'))
    assert.match(rows[1].warnings[0], /Same product code as row 2/)
    assert.ok(rows[2].warnings.some((w) => /Identical to row 2/.test(w)))
  })

  it('reports inconsistent customer or PO number across rows', () => {
    const { header } = validatePoRows([
      ['PO-1', '2026-10-01', 'Acme', 'A', '', '1', '', '', ''],
      ['PO-2', '2026-10-02', 'Beta', 'B', '', '1', '', '', ''],
    ], mapping)
    assert.equal(header.issues.length, 3)
  })

  it('warns that description-only rows need manual product selection', () => {
    const { rows } = validatePoRows([['PO-1', '', 'A', '', 'Some closet', '1', '', '', '']], mapping)
    assert.equal(rows[0].status, 'valid')
    assert.match(rows[0].warnings[0], /selected manually/)
  })

  it('parses numbers with thousands separators and currency symbols', () => {
    assert.equal(parseDecimal('₹ 1,250.50', 2), 1250.5)
    assert.equal(parseDecimal('Rs. 99', 2), 99)
    assert.equal(parseDecimal('', 2), undefined)
    assert.equal(parseDecimal('1.234', 2), null)
  })
})
