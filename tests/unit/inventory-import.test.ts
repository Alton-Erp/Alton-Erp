// Unit tests for opening-stock import validation and count-sheet re-import.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'

import { parseCountSheet } from '../../src/features/inventory/count-sheet.ts'
import { parseSheetDate, parseStockSource } from '../../src/features/inventory/inventory-model.ts'
import {
  OPENING_FIELDS,
  autoMapOpening,
  detectOpeningHeader,
  existingOpeningIndex,
  ignoredCostColumns,
  openingValue,
  missingOpeningFields,
  openingBalanceKey,
  openingStockSource,
  validateOpeningRows,
  type OpeningContext,
} from '../../src/features/inventory/opening-import.ts'
import { parseWorkbook } from '../../src/features/products/spreadsheet.ts'

const ctx: OpeningContext = {
  products: new Map([
    ['wc-1', { id: 'p1', sku: 'WC-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', default_source_type: 'OUTSOURCED', product_type: 'TRADED_GOOD' }],
    ['wc-2', { id: 'p5', sku: 'WC-2', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', default_source_type: 'OUTSOURCED', product_type: 'TRADED_GOOD' }],
    ['seal-1', { id: 'p2', sku: 'SEAL-1', base_unit: 'BOX', track_batches: true, track_expiry: true, status: 'ACTIVE', default_source_type: 'OUTSOURCED', product_type: 'RAW_MATERIAL' }],
    ['old-1', { id: 'p3', sku: 'OLD-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'INACTIVE', default_source_type: 'OUTSOURCED', product_type: 'RAW_MATERIAL' }],
    ['basin-1', { id: 'p4', sku: 'BASIN-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', default_source_type: 'IN_HOUSE', product_type: 'FINISHED_GOOD' }],
    ['kit-1', { id: 'p6', sku: 'KIT-1', base_unit: 'PCS', track_batches: false, track_expiry: false, status: 'ACTIVE', default_source_type: 'HYBRID', product_type: 'FINISHED_GOOD' }],
  ]),
  locations: [
    { id: 'l1', warehouseCode: 'MAIN', locationCode: 'GENERAL', active: true, isDefault: true },
    { id: 'l2', warehouseCode: 'MAIN', locationCode: 'BIN-1', active: true, isDefault: false },
    { id: 'l3', warehouseCode: 'MAIN', locationCode: 'OLD', active: false, isDefault: false },
  ],
  defaultEffectiveDate: '2026-10-01',
  today: '2026-10-10',
  // Product Master Costs from the database (deliberately different from any cost in the files below).
  costs: new Map([['p1', { cost: 300, valid: true }], ['p5', { cost: 15, valid: true }], ['p2', { cost: 12.5, valid: true }],
    ['p3', { cost: 9, valid: true }], ['p4', { cost: 200, valid: true }], ['p6', { cost: 50, valid: true }]]),
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
  // An older file that still has a Source column: it must import, with that column ignored.
  const sheet = [
    ['Opening stock as on 01-10-2026'],
    [],
    ['SKU', 'Warehouse', 'Bin', 'Source', 'Qty', 'UOM', 'Batch No', 'Expiry', 'Unit Cost', 'Date'],
    ['WC-1', 'main', '', 'In House', '100', 'PCS', '', '', '450', ''],
    ['WC-1', 'MAIN', '', 'Outsourced', '40', '', '', '', '', ''],
    ['wc-1', 'MAIN', 'BIN-1', 'Factory', '5', '', '', '', '', ''],
    ['SEAL-1', 'MAIN', 'BIN-1', 'Outsourced', '12', 'BOX', 'B-7', '15-12-2026', '10.5', '05-10-2026'],
    ['SEAL-1', 'MAIN', 'BIN-1', 'Outsourced', '3', 'BOX', '', '', '', ''],
    ['NOPE', 'MAIN', '', 'In House', '1', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'OLD', 'In House', '1', '', '', '', '', ''],
    ['BASIN-1', 'MAIN', 'BIN-1', '', '7', '', '', '', '', ''],
    ['WC-1', 'MAIN', 'BIN-2', 'In House', '-2', '', '', '', '', ''],
    ['WC-2', 'MAIN', 'BIN-1', 'Outsourced', '1', 'KG', '', '', '', ''],
    ['WC-2', 'MAIN', 'GENERAL', 'Unknown', '1', '', '', '', '', '20-10-2026'],
    ['OLD-1', 'MAIN', '', 'In House', '1', '', '', '', '', ''],
    ['WC-2', 'ANNEX', '', 'In House', '1', '', '', '', '', ''],
    ['KIT-1', 'MAIN', 'BIN-1', '', '2', '', '', '', '', ''],
  ]

  async function parsed(rows: unknown[][] = sheet) {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Opening')
    const book = await parseWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
    const all = book.rows('Opening')
    const h = detectOpeningHeader(all)
    return { headers: all[h], data: all.slice(h + 1), first: h + 2 }
  }

  it('has no Source field: SKU, Warehouse and Quantity are the only required fields', () => {
    assert.ok(!OPENING_FIELDS.some((f) => (f.key as string) === 'source' || f.label === 'Source'), 'Source is still an import field')
    assert.deepEqual(OPENING_FIELDS.filter((f) => f.required).map((f) => f.label), ['SKU', 'Warehouse', 'Quantity'])
    assert.deepEqual(OPENING_FIELDS.filter((f) => !f.required).map((f) => f.label),
      ['Location', 'Unit', 'Batch', 'Manufacturing Date', 'Expiry Date', 'Effective Date', 'Reference', 'Notes'])
    assert.ok(!OPENING_FIELDS.some((f) => /cost/i.test(f.label)), 'the file never supplies the unit cost')
    assert.deepEqual(missingOpeningFields(autoMapOpening(['SKU', 'Qty'])), ['Warehouse'])
    assert.deepEqual(missingOpeningFields(autoMapOpening(['SKU', 'Warehouse', 'Qty'])), [])
  })

  it('detects the header below title rows and leaves an old Source column unmapped', async () => {
    const { headers, first } = await parsed()
    assert.equal(first, 4)
    const m = autoMapOpening(headers)
    assert.equal(m.location, 2)
    assert.equal(m.quantity, 4)
    assert.equal(m.batch, 6)
    assert.deepEqual(missingOpeningFields(m), [])
    assert.ok(!Object.values(m).includes(3), 'the Source column (index 3) was mapped to another field')
    for (const h of ['Source', 'Source Type', 'Stock Source', 'Actual Source']) {
      assert.ok(!Object.values(autoMapOpening(['SKU', 'Warehouse', h, 'Qty'])).includes(2), `${h} was mapped`)
    }
  })

  it('imports a file without a Source column', async () => {
    const { headers, data, first } = await parsed([['SKU', 'Warehouse', 'Location', 'Quantity', 'Unit Cost', 'Reference'], ['WC-1', 'MAIN', 'BIN-1', '25', '450', 'CS-1'], ['BASIN-1', 'MAIN', '', '3', '', '']])
    const results = validateOpeningRows(data, autoMapOpening(headers), ctx, first)
    assert.deepEqual(results.map((r) => r.status), ['valid', 'valid'])
    assert.deepEqual(results.map((r) => [r.payload!.quantity, r.payload!.source_type, r.payload!.reference]), [[25, 'OUTSOURCED', 'CS-1'], [3, 'IN_HOUSE', null]])
  })

  it('accepts valid rows and rejects each invalid row with its spreadsheet row number', async () => {
    const { headers, data, first } = await parsed()
    const results = validateOpeningRows(data, autoMapOpening(headers), ctx, first)
    const byRow = new Map(results.map((r) => [r.rowNumber, r]))
    assert.equal(results.length, 14)

    const r4 = byRow.get(4)!
    assert.equal(r4.status, 'valid')
    assert.deepEqual(
      { loc: r4.payload!.location_id, src: r4.payload!.source_type, qty: r4.payload!.quantity, cost: r4.payload!.unit_cost, eff: r4.payload!.effective_date },
      { loc: 'l1', src: 'OUTSOURCED', qty: 100, cost: 300, eff: '2026-10-01' },
      'the source and the cost come from the product master, not the "In House" or ₹450 cells',
    )
    assert.ok(r4.warnings.some((w) => w.includes('using MAIN/GENERAL')))
    assert.ok(byRow.get(5)!.errors.some((e) => e.includes('Duplicate of row 4')), 'a different Source cell no longer makes a second opening balance')
    assert.equal(byRow.get(6)!.status, 'valid', 'an unrecognised Source cell is ignored')
    assert.equal(byRow.get(6)!.payload!.unit_cost, 300, 'a blank cost cell also gets the Product Master Cost')
    assert.equal(byRow.get(7)!.status, 'valid')
    assert.equal(byRow.get(7)!.payload!.expiry_date, '2026-12-15')
    assert.equal(byRow.get(7)!.payload!.effective_date, '2026-10-05')
    assert.ok(byRow.get(8)!.errors.some((e) => e.includes('Batch number is required')))
    assert.ok(byRow.get(8)!.errors.some((e) => e.includes('Expiry date is required')))
    assert.ok(byRow.get(9)!.errors.some((e) => e.includes('not found')))
    assert.ok(byRow.get(10)!.errors.some((e) => e.includes('inactive')))
    assert.equal(byRow.get(11)!.payload!.source_type, 'IN_HOUSE', 'IN_HOUSE product')
    assert.ok(byRow.get(12)!.errors.some((e) => e.includes('greater than zero')))
    assert.ok(byRow.get(13)!.errors.some((e) => e.includes('does not match the product unit')))
    assert.ok(byRow.get(14)!.errors.some((e) => e.includes('future')))
    assert.ok(byRow.get(15)!.errors.some((e) => e.includes('inactive')))
    assert.ok(byRow.get(16)!.errors.some((e) => e.includes('ANNEX')))
    assert.equal(byRow.get(17)!.payload!.source_type, 'IN_HOUSE', 'HYBRID finished good follows its product type')
    for (const r of results) {
      assert.equal(r.payload === null, r.status === 'error', 'rejected rows never carry a payload')
      assert.ok(![...r.errors, ...r.warnings].some((m) => /source/i.test(m)), `row ${r.rowNumber} mentions a source: ${[...r.errors, ...r.warnings].join(' | ')}`)
      if (r.payload) assert.notEqual(r.payload.source_type, 'UNKNOWN')
    }
  })

  it('rejects a row when that product, location and batch already has opening stock', async () => {
    const { headers, data, first } = await parsed([['SKU', 'Warehouse', 'Location', 'Qty'], ['WC-1', 'MAIN', 'BIN-1', '5'], ['WC-1', 'MAIN', 'GENERAL', '5']])
    // Recorded earlier with a source chosen by hand (any source counts).
    const existing = existingOpeningIndex([{ product_id: 'p1', location_id: 'l2', batch_number: null, document_number: 'OS-000004' }])
    const results = validateOpeningRows(data, autoMapOpening(headers), { ...ctx, existing }, first)
    assert.ok(results[0].errors.some((e) => e.includes('already exists (OS-000004)')))
    assert.equal(results[1].status, 'valid')
  })

  it('2/3. unit cost = Product Master Cost; a cost in the file is ignored; value = quantity × cost', async () => {
    const { headers, data, first } = await parsed([['SKU', 'Warehouse', 'Quantity', 'Unit Cost', 'Opening Value'], ['WC-1', 'MAIN', '7', '999', '6993'], ['BASIN-1', 'MAIN', '3', '', '']])
    assert.deepEqual(ignoredCostColumns(headers), ['Unit Cost', 'Opening Value'])
    const m = autoMapOpening(headers)
    assert.ok(!Object.values(m).includes(3) && !Object.values(m).includes(4), 'a cost / value column was mapped')
    const results = validateOpeningRows(data, m, ctx, first)
    assert.deepEqual(results.map((r) => [r.status, r.cost, r.value, r.payload?.unit_cost]), [['valid', 300, 2100, 300], ['valid', 200, 600, 200]])
    assert.equal(openingValue(2.5, 12.345), 30.86)
  })

  it('5. a product without a Product Master Cost (missing or zero) is flagged, never imported at zero', async () => {
    const costs = new Map(ctx.costs)
    costs.set('p1', { cost: null, valid: false })
    costs.set('p4', { cost: 0, valid: false })
    costs.delete('p5')
    const { headers, data, first } = await parsed([['SKU', 'Warehouse', 'Quantity'], ['WC-1', 'MAIN', '5'], ['BASIN-1', 'MAIN', '5'], ['WC-2', 'MAIN', '5']])
    const results = validateOpeningRows(data, autoMapOpening(headers), { ...ctx, costs }, first)
    assert.deepEqual(results.map((r) => r.status), ['error', 'error', 'error'])
    assert.match(results[0].errors.join(), /Product Master Cost of WC-1 is missing/)
    assert.match(results[1].errors.join(), /Product Master Cost of BASIN-1 is zero/)
    assert.match(results[2].errors.join(), /Product Master Cost of WC-2 is missing/)
    assert.ok(results.every((r) => r.payload === null))
  })

  it('4. an unknown product code is rejected with the reason', async () => {
    const { headers, data, first } = await parsed([['SKU', 'Warehouse', 'Quantity'], ['NOPE-9', 'MAIN', '5']])
    const [r] = validateOpeningRows(data, autoMapOpening(headers), ctx, first)
    assert.equal(r.status, 'error')
    assert.match(r.errors.join(), /SKU "NOPE-9" was not found in the product master/)
  })

  it('derives the stored source from the product master, never UNKNOWN', () => {
    assert.equal(openingStockSource({ default_source_type: 'IN_HOUSE', product_type: 'RAW_MATERIAL' }), 'IN_HOUSE')
    assert.equal(openingStockSource({ default_source_type: 'OUTSOURCED', product_type: 'FINISHED_GOOD' }), 'OUTSOURCED')
    assert.equal(openingStockSource({ default_source_type: 'HYBRID', product_type: 'FINISHED_GOOD' }), 'IN_HOUSE')
    assert.equal(openingStockSource({ default_source_type: 'HYBRID', product_type: 'RAW_MATERIAL' }), 'OUTSOURCED')
    assert.equal(openingStockSource({}), 'OUTSOURCED')
    assert.equal(openingBalanceKey('p', 'l', ' B-7 '), openingBalanceKey('p', 'l', 'b-7'))
    assert.equal(openingBalanceKey('p', 'l', null), openingBalanceKey('p', 'l', ''))
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
