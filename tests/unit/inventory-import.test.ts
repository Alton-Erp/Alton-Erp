// Unit tests for opening-stock import validation and count-sheet re-import.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'

import { parseCountSheet } from '../../src/features/inventory/count-sheet.ts'
import { parseSheetDate, parseStockSource } from '../../src/features/inventory/inventory-model.ts'
import {
  autoMapOpening,
  detectOpeningHeader,
  missingOpeningFields,
  validateOpeningRows,
  type OpeningContext,
} from '../../src/features/inventory/opening-import.ts'
import { parseWorkbook } from '../../src/features/products/spreadsheet.ts'

const ctx: OpeningContext = {
  products: new Map([
    ['wc-1', { id: 'p1', sku: 'WC-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE' }],
    ['seal-1', { id: 'p2', sku: 'SEAL-1', base_unit: 'BOX', track_batches: true, track_expiry: true, status: 'ACTIVE' }],
    ['old-1', { id: 'p3', sku: 'OLD-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'INACTIVE' }],
  ]),
  locations: [
    { id: 'l1', warehouseCode: 'MAIN', locationCode: 'GENERAL', active: true, isDefault: true },
    { id: 'l2', warehouseCode: 'MAIN', locationCode: 'BIN-1', active: true, isDefault: false },
    { id: 'l3', warehouseCode: 'MAIN', locationCode: 'OLD', active: false, isDefault: false },
  ],
  defaultEffectiveDate: '2026-10-01',
  today: '2026-10-10',
}

describe('parsing helpers', () => {
  it('parses sources and day-first dates', () => {
    assert.equal(parseStockSource('In House'), 'IN_HOUSE')
    assert.equal(parseStockSource('purchased'), 'OUTSOURCED')
    assert.equal(parseStockSource('unknown'), 'UNKNOWN')
    assert.equal(parseStockSource('factory'), null)
    assert.equal(parseSheetDate('2026-04-01'), '2026-04-01')
    assert.equal(parseSheetDate('01-04-2026'), '2026-04-01')
    assert.equal(parseSheetDate('1/4/2026'), '2026-04-01')
    assert.equal(parseSheetDate('31-02-2026'), null)
    assert.equal(parseSheetDate('04/01/26'), null)
    assert.equal(parseSheetDate(''), undefined)
  })
})

describe('opening-stock import', () => {
  const sheet = [
    ['Opening stock as on 01-10-2026'],
    [],
    ['SKU', 'Warehouse', 'Bin', 'Source', 'Qty', 'UOM', 'Batch No', 'Expiry', 'Unit Cost', 'Date'],
    ['WC-1', 'main', '', 'In House', '100', 'PCS', '', '', '450', ''],
    ['WC-1', 'MAIN', '', 'Outsourced', '40', '', '', '', '', ''],
    ['wc-1', 'MAIN', 'GENERAL', 'in-house', '5', '', '', '', '', ''],
    ['SEAL-1', 'MAIN', 'BIN-1', 'Outsourced', '12', 'BOX', 'B-7', '15-12-2026', '10.5', '05-10-2026'],
    ['SEAL-1', 'MAIN', 'BIN-1', 'Outsourced', '3', 'BOX', '', '', '', ''],
    ['NOPE', 'MAIN', '', 'In House', '1', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'OLD', 'In House', '1', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'BIN-1', 'Factory', '1', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'BIN-1', 'In House', '-2', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'BIN-1', 'Outsourced', '1', 'KG', '', '', '', ''],
    ['WC-1', 'MAIN', 'BIN-1', 'Unknown', '1', '', '', '', '', '20-10-2026'],
    ['OLD-1', 'MAIN', '', 'In House', '1', '', '', '', '', ''],
    ['WC-1', 'ANNEX', '', 'In House', '1', '', '', '', '', ''],
  ]

  async function parsed() {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Opening')
    const book = await parseWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
    const rows = book.rows('Opening')
    const h = detectOpeningHeader(rows)
    return { headers: rows[h], data: rows.slice(h + 1), first: h + 2 }
  }

  it('detects the header below title rows and maps columns', async () => {
    const { headers, first } = await parsed()
    assert.equal(first, 4)
    const m = autoMapOpening(headers)
    assert.equal(m.location, 2)
    assert.equal(m.quantity, 4)
    assert.equal(m.batch, 6)
    assert.deepEqual(missingOpeningFields(m), [])
    assert.deepEqual(missingOpeningFields(autoMapOpening(['SKU', 'Qty'])), ['Warehouse', 'Source'])
  })

  it('accepts valid rows and rejects each invalid row with its spreadsheet row number', async () => {
    const { headers, data, first } = await parsed()
    const results = validateOpeningRows(data, autoMapOpening(headers), ctx, first)
    const byRow = new Map(results.map((r) => [r.rowNumber, r]))
    assert.equal(results.length, 13)

    const r4 = byRow.get(4)!
    assert.equal(r4.status, 'valid')
    assert.deepEqual(
      { loc: r4.payload!.location_id, src: r4.payload!.source_type, qty: r4.payload!.quantity, cost: r4.payload!.unit_cost, eff: r4.payload!.effective_date },
      { loc: 'l1', src: 'IN_HOUSE', qty: 100, cost: 450, eff: '2026-10-01' },
    )
    assert.ok(r4.warnings.some((w) => w.includes('using MAIN/GENERAL')))
    assert.equal(byRow.get(5)!.status, 'valid', 'same product/location with a different source is not a duplicate')
    assert.ok(byRow.get(5)!.warnings.some((w) => w.includes('No unit cost')))
    assert.ok(byRow.get(6)!.errors.some((e) => e.includes('Duplicate of row 4')))
    assert.equal(byRow.get(7)!.status, 'valid')
    assert.equal(byRow.get(7)!.payload!.expiry_date, '2026-12-15')
    assert.equal(byRow.get(7)!.payload!.effective_date, '2026-10-05')
    assert.ok(byRow.get(8)!.errors.some((e) => e.includes('Batch number is required')))
    assert.ok(byRow.get(8)!.errors.some((e) => e.includes('Expiry date is required')))
    assert.ok(byRow.get(9)!.errors.some((e) => e.includes('not found')))
    assert.ok(byRow.get(10)!.errors.some((e) => e.includes('inactive')))
    assert.ok(byRow.get(11)!.errors.some((e) => e.includes('"Factory"')))
    assert.ok(byRow.get(12)!.errors.some((e) => e.includes('greater than zero')))
    assert.ok(byRow.get(13)!.errors.some((e) => e.includes('does not match the product unit')))
    assert.ok(byRow.get(14)!.errors.some((e) => e.includes('future')))
    assert.ok(byRow.get(15)!.errors.some((e) => e.includes('inactive')))
    assert.ok(byRow.get(16)!.errors.some((e) => e.includes('ANNEX')))
    for (const r of results) assert.equal(r.payload === null, r.status === 'error', 'rejected rows never carry a payload')
  })
})

describe('real Excel date cells', () => {
  it('are read as ISO dates (no ambiguous month/day order)', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['SKU', 'Expiry'], ['SEAL-1', new Date(Date.UTC(2026, 11, 5))]], { cellDates: true })
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const book = await parseWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
    const value = book.rows('S')[1][1]
    assert.equal(parseSheetDate(value), '2026-12-05', `cell rendered as "${value}"`)
  })
})

describe('count sheet re-import', () => {
  const lines = [
    { id: 'L1', sku: 'WC-1', system_quantity: 10, counted_quantity: null, notes: null },
    { id: 'L2', sku: 'WC-2', system_quantity: 5, counted_quantity: 5, notes: null },
    { id: 'L3', sku: 'WC-3', system_quantity: 2, counted_quantity: null, notes: null },
  ]
  it('updates counted lines, ignores blanks and rejects foreign or invalid rows', () => {
    const rows = [
      ['Line ID', 'SKU', 'Counted Qty', 'Notes'],
      ['L1', 'WC-1', '8', 'two broken'],
      ['L2', 'WC-2', '5', ''],
      ['L3', 'WC-3', '', ''],
      ['L9', 'WC-9', '1', ''],
      ['L1', 'WC-1', '9', ''],
      ['L3', 'WRONG', '1', ''],
    ]
    const r = parseCountSheet(rows, lines)
    assert.deepEqual(r.updates, [{ line_id: 'L1', counted_quantity: 8, notes: 'two broken' }])
    assert.equal(r.unchanged, 2)
    assert.deepEqual(r.errors.map((e) => e.row), [5, 6, 7])
    assert.ok(parseCountSheet([['SKU', 'Qty']], lines).errors[0].message.includes('Line ID'))
    assert.ok(parseCountSheet([['Line ID'], ['L1']], lines).errors[0].message.includes('Counted Qty'))
    assert.ok(parseCountSheet([['Line ID', 'Counted Qty'], ['L1', '-1']], lines).errors[0].message.includes('≥ 0'))
  })
})
