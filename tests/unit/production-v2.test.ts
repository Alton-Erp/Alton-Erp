// Stage 4 (V2): BOM requirement / wastage maths, default consumption, completion
// form checks and the Excel upload parser. No database; the same rules are
// enforced by supabase/tests/production_v2_verification.sql.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildProductionImportReport, defaultConsumption, formatByUnit, normalizeImportDate, parseProductionSheet, productionTemplateRows,
  simpleStatus, standardFor, validateCompletion, type ImportPreviewRow, type MaterialLine,
} from '../../src/features/production/production-v2-model.ts'

const lines: MaterialLine[] = [
  { order_material_id: 'a', sku: 'COMP-A', unit: 'PCS', quantity_per_unit: 1, wastage_percentage: 0 },
  { order_material_id: 'b', sku: 'COMP-B', unit: 'PCS', quantity_per_unit: 2, wastage_percentage: 2 },
  { order_material_id: 'r', sku: 'RAW-A', unit: 'KG', quantity_per_unit: 0.5, wastage_percentage: 10 },
  { order_material_id: 'o', sku: 'OSC-A', unit: 'PCS', quantity_per_unit: 1, wastage_percentage: 0 },
]

describe('BOM calculation (spec example: 100 units of ALTON Product A)', () => {
  it('multiplies the BOM by the production quantity', () => {
    assert.equal(standardFor(lines[0], 100), 100)
    assert.equal(standardFor({ ...lines[1], wastage_percentage: 0 }, 100), 200)
    assert.equal(standardFor({ ...lines[2], wastage_percentage: 0 }, 100), 50)
    assert.equal(standardFor(lines[3], 100), 100)
  })
  it('adds BOM wastage: 2 x 100 + 2% = 204 PCS, 0.5 KG x 100 + 10% = 55 KG', () => {
    assert.equal(standardFor(lines[1], 100), 204)
    assert.equal(standardFor(lines[2], 100), 55)
  })
  it('rounds whole-piece items up after wastage (2 x 7 + 2% = 14.28 -> 15 PCS) and KG to 3 decimals', () => {
    assert.equal(standardFor(lines[1], 7), 15)
    assert.equal(standardFor({ ...lines[2], quantity_per_unit: 0.3333, wastage_percentage: 0 }, 3), 1)
    assert.equal(standardFor(lines[2], 3), 1.65)
  })
  it('nothing produced needs nothing', () => assert.equal(standardFor(lines[0], 0), 0))
})

describe('default consumption at completion', () => {
  it('is the standard for the produced quantity less anything already issued', () => {
    const d = defaultConsumption([{ ...lines[0], issued: 30 }, lines[2]], 100)
    assert.deepEqual(d, { a: '70', r: '55' })
  })
  it('never goes negative when more was issued than needed', () => {
    assert.deepEqual(defaultConsumption([{ ...lines[0], issued: 120 }], 100), { a: '0' })
  })
})

describe('completion form checks', () => {
  const consumed = { a: '100', b: '204', r: '53.5', o: '100' }
  it('accepts actual, rejected and wastage with actual consumption', () => {
    assert.deepEqual(validateCompletion({ actual: '100', rejected: '4', wastage: '0', consumed }, 'PCS', lines), [])
  })
  it('refuses rejected above actual, half pieces and nothing produced', () => {
    assert.ok(validateCompletion({ actual: '3', rejected: '5', wastage: '', consumed }, 'PCS', lines).some((e) => e.includes('cannot be more')))
    assert.ok(validateCompletion({ actual: '2.5', rejected: '', wastage: '', consumed }, 'PCS', lines).some((e) => e.includes('whole PCS')))
    assert.ok(validateCompletion({ actual: '0', rejected: '', wastage: '', consumed }, 'PCS', lines).some((e) => e.includes('actual quantity')))
  })
  it('checks each consumed quantity in its own unit', () => {
    const errs = validateCompletion({ actual: '10', rejected: '', wastage: '', consumed: { ...consumed, b: '1.5', r: 'abc' } }, 'PCS', lines)
    assert.ok(errs.some((e) => e.startsWith('COMP-B')))
    assert.ok(errs.some((e) => e.startsWith('RAW-A')))
  })
})

describe('Excel production upload', () => {
  it('finds the header, maps the columns and keeps every non-blank row with its spreadsheet row number', () => {
    const r = parseProductionSheet([
      ['Daily production'],
      ['Production Date', 'Finished Product SKU', 'Planned Quantity', 'Actual Quantity', 'Rejected Quantity', 'Remarks'],
      ['2026-10-30', 'FG-1', '1,000', '', '', 'Night'],
      ['', '', '', '', '', ''],
      ['31/10/2026', 'FG-2', '5', '5', '1', ''],
      ['bad', '', 'x', '', '', ''],
    ])
    assert.equal(r.headerRow, 2)
    assert.deepEqual(r.rows.map((x) => x.row_number), [3, 5, 6])
    assert.equal(r.rows[0].planned_quantity, '1000')
    assert.equal(r.rows[1].production_date, '2026-10-31')
    assert.equal(r.rows[2].production_date, 'bad')
  })
  it('accepts common header names', () => {
    const r = parseProductionSheet([['Date', 'SKU', 'Planned', 'Actual', 'Rejected', 'Notes'], ['2026-10-01', 'X', '1', '', '', 'n']])
    assert.equal(r.rows[0].sku, 'X')
    assert.equal(r.rows[0].remarks, 'n')
  })
  it('reports missing required columns', () => {
    assert.deepEqual(parseProductionSheet([['SKU', 'Qty']]).missing, ['Production Date', 'Finished Product SKU', 'Planned Quantity'])
  })
  it('converts day-first dates and leaves impossible ones for the server to report', () => {
    assert.equal(normalizeImportDate('5-1-2026'), '2026-01-05')
    assert.equal(normalizeImportDate('31.12.2026'), '2026-12-31')
    assert.equal(normalizeImportDate('31/02/2026'), '31/02/2026')
  })
  it('template has the documented columns', () => {
    assert.deepEqual(productionTemplateRows('2026-10-30')[0], ['Production Date', 'Finished Product SKU', 'Planned Quantity', 'Actual Quantity', 'Rejected Quantity', 'Remarks'])
  })
  it('error report lists every row with its result and messages', () => {
    const rows: ImportPreviewRow[] = [
      { row_number: 2, status: 'VALID', errors: [], warnings: [], sku: 'FG-1', product_name: 'A', bom_code: 'BOM-1', bom_version: 1, production_date: '2026-10-30', planned_quantity: 10, actual_quantity: null, rejected_quantity: 0, complete: false },
      { row_number: 3, status: 'ERROR', errors: ['SKU "X" was not found.'], warnings: [], sku: 'X', product_name: null, bom_code: null, bom_version: null, production_date: '2026-10-30', planned_quantity: 1, actual_quantity: null, rejected_quantity: 0, complete: false },
    ]
    const report = buildProductionImportReport(rows, { created: [{ row_number: 2, production_order_number: 'PRD-000001', status: 'APPROVED' }], failed: [{ row_number: 3, messages: ['SKU "X" was not found.'] }] })
    assert.equal(report.length, 3)
    assert.equal(report[1][6], 'Order created')
    assert.equal(report[1][7], 'PRD-000001')
    assert.equal(report[2][6], 'Not imported')
    assert.match(String(report[2][8]), /not found/)
  })
})

describe('display helpers', () => {
  it('never adds PCS and KG together', () => assert.equal(formatByUnit([{ unit: 'KG', quantity: 50.5 }, { unit: 'PCS', quantity: 1200 }]), '50.5 KG · 1,200 PCS'))
  it('shows the simple status words', () => {
    assert.equal(simpleStatus('APPROVED').label, 'Open')
    assert.equal(simpleStatus('COMPLETED').label, 'Completed')
  })
})
