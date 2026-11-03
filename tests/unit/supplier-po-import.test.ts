import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calcTotals } from '../../src/features/purchasing/po-calc.ts'
import {
  groupPayload,
  invalidReferences,
  isUnsafeCell,
  parsePoImport,
  PO_IMPORT_COLUMNS,
  PO_IMPORT_MAX_ROWS,
  rejectedRowsPayload,
  templateSheets,
} from '../../src/features/purchasing/po-import.ts'

const HEAD = PO_IMPORT_COLUMNS.map((c) => c.label)
const TODAY = '2026-10-28'
/** A row by column label (other cells blank). */
const row = (v: Partial<Record<string, string>>) => HEAD.map((h) => v[h] ?? '')
const line = (ref: string, sku: string, qty: string, price: string, extra: Partial<Record<string, string>> = {}) =>
  row({ 'PO Reference': ref, 'Supplier Code': 'SUP-1', 'Product Code / SKU': sku, Quantity: qty, 'Unit Price': price, Warehouse: 'MAIN', ...extra })

describe('PO import template', () => {
  it('has the 17 requested columns plus the PO Reference grouping column, and instructions', () => {
    const [sheet, help] = templateSheets()
    assert.deepEqual(sheet.rows[0], HEAD)
    assert.equal(HEAD.length, 18)
    assert.equal(HEAD[0], 'PO Reference')
    assert.ok(help.rows.some((r) => String(r[0] ?? '').includes('same PO Reference')))
  })
})

describe('PO import parsing and grouping', () => {
  it('groups rows by PO Reference (case-insensitive), keeps spreadsheet row numbers and skips blank rows', () => {
    const p = parsePoImport([HEAD, line('PO-1', 'A', '10', '100', { 'PO Date': '01-10-2026', 'Discount Percentage': '5%' }), [], line('po-1', 'B', '2.5', '1,000.50'), line('PO-2', 'A', '1', '0')], TODAY)
    assert.deepEqual(p.fileErrors, [])
    assert.deepEqual(p.rowErrors, [])
    assert.equal(p.groups.length, 2)
    assert.deepEqual(p.groups[0].rows.map((r) => r.row_number), [2, 4])
    assert.equal(p.groups[0].header.po_date, '2026-10-01')
    assert.equal(p.groups[0].rows[0].discount_percent, '5')
    assert.equal(p.groups[0].rows[1].unit_price, '1000.50')
    assert.equal(p.blankRows, 1)
    assert.equal(p.dataRows, 3)
  })

  it('accepts header aliases and any column order', () => {
    const head = ['Product Code', 'Quantity', 'Unit Price', 'Warehouse Code', 'Supplier Code', 'PO Ref']
    const p = parsePoImport([head, ['X', '1', '2', 'MAIN', 'S', 'R1']], TODAY)
    assert.deepEqual(p.fileErrors, [])
    assert.equal(p.groups[0].rows[0].sku, 'X')
  })

  it('reports missing required columns and empty files as file errors', () => {
    assert.match(parsePoImport([['Supplier Code', 'Quantity']], TODAY).fileErrors[0], /Missing: PO Reference, Product Code \/ SKU, Unit Price, Warehouse/)
    assert.match(parsePoImport([], TODAY).fileErrors[0], /empty/)
    assert.match(parsePoImport([HEAD, [], []], TODAY).fileErrors[0], /no product rows/)
  })

  it('reports invalid rows with their spreadsheet row number and a correction message', () => {
    const p = parsePoImport([HEAD,
      line('PO-1', 'A', '0', '10'),
      line('PO-2', 'A', '1', '-5'),
      line('PO-3', 'A', '1', '10', { 'GST Rate': '7' }),
      line('PO-4', 'A', '1', '10', { 'PO Date': '31-02-2026' }),
      line('PO-5', 'A', '1', '10', { 'Discount Percentage': '120' }),
      line('', 'A', '1', '10'),
      line('PO-6', '', '1.0005', '10', { Warehouse: '' }),
      line('PO-7', 'A', '1', '10', { 'PO Date': '2026-11-30' }),
    ], TODAY)
    const at = (r: number) => p.rowErrors.filter((e) => e.row === r).map((e) => e.message).join(' | ')
    assert.match(at(2), /Quantity "0" must be a number greater than zero/)
    assert.match(at(3), /no negative prices/)
    assert.match(at(4), /GST Rate "7" is not supported/)
    assert.match(at(5), /not a valid date/)
    assert.match(at(6), /between 0 and 100/)
    assert.match(at(7), /PO Reference is required/)
    assert.match(at(8), /Product Code \/ SKU is required.*|Warehouse is required/)
    assert.match(at(8), /3 decimals/)
    assert.match(at(9), /cannot be in the future/)
    assert.deepEqual([...invalidReferences(p)].sort(), ['po-1', 'po-2', 'po-3', 'po-4', 'po-5', 'po-6', 'po-7'])
  })

  it('never silently merges: conflicting order details in one reference are errors', () => {
    const p = parsePoImport([HEAD, line('PO-1', 'A', '1', '1', { 'PO Date': '2026-10-01' }), line('PO-1', 'B', '1', '1', { 'PO Date': '2026-10-02' }),
      line('PO-1', 'C', '1', '1', { 'Supplier Code': 'SUP-2' })], TODAY)
    assert.equal(p.groups.length, 1)
    assert.match(p.rowErrors.find((e) => e.row === 3)!.message, /PO Date "2026-10-02" differs from "2026-10-01"/)
    assert.match(p.rowErrors.find((e) => e.row === 4)!.message, /Supplier Code "SUP-2" differs/)
  })

  it('blank order details on later rows inherit from the first row', () => {
    const p = parsePoImport([HEAD, line('PO-1', 'A', '1', '1', { 'Delivery Instructions': 'Gate 2' }), line('PO-1', 'B', '1', '1')], TODAY)
    assert.deepEqual(p.rowErrors, [])
    assert.equal(p.groups[0].header.delivery_instructions, 'Gate 2')
  })

  it('rejects cells that could run as formulas', () => {
    assert.ok(isUnsafeCell('=HYPERLINK("x")') && isUnsafeCell('+cmd') && isUnsafeCell('@SUM(A1)') && isUnsafeCell('-cmd|x'))
    assert.ok(!isUnsafeCell('-5') && !isUnsafeCell('Plain text') && !isUnsafeCell('PO-1'))
    const p = parsePoImport([HEAD, line('PO-1', 'A', '1', '1', { Description: '=1+1' })], TODAY)
    assert.match(p.rowErrors[0].message, /Description: cells must not start with/)
  })

  it('enforces the row limit', () => {
    const many = Array.from({ length: PO_IMPORT_MAX_ROWS + 1 }, (_, i) => line(`PO-${i}`, 'A', '1', '1'))
    assert.match(parsePoImport([HEAD, ...many], TODAY).fileErrors[0], /at most 1000/)
  })

  it('sends only order details and line values to the server (no ids, company, status or totals)', () => {
    const p = parsePoImport([HEAD, line('PO-1', 'A', '3', '999.99', { 'GST Rate': '12', 'Unit of Measurement': 'pcs' })], TODAY)
    const payload = groupPayload(p.groups[0])
    assert.deepEqual(Object.keys(payload).sort(), ['header', 'reference', 'rows'])
    const keys = Object.keys(payload.rows[0])
    for (const k of ['company_id', 'supplier_id', 'product_id', 'status', 'line_total', 'grand_total']) assert.ok(!keys.includes(k), k)
    assert.equal(payload.rows[0].unit, 'PCS')
  })

  it('lists rejected rows (and the other rows of their orders) for the import history', () => {
    const p = parsePoImport([HEAD, line('PO-1', 'A', '1', '1'), line('PO-1', 'B', '0', '1'), line('PO-2', 'A', '1', '1')], TODAY)
    const rejected = rejectedRowsPayload(p, invalidReferences(p))
    assert.deepEqual(rejected.map((r) => r.row_number).sort(), [2, 3])
    assert.match(rejected.find((r) => r.row_number === 2)!.messages[0], /another row of PO Reference PO-1/)
  })
})

describe('imported lines use the ERP GST engine (preview == database)', () => {
  it('same figures as the server dry-run in purchase_order_import_verification.sql', () => {
    const { totals } = calcTotals([
      { line_type: 'GOODS', quantity: '10', unit_price: '1000', discount_percent: '10', gst_rate: 18 },
      { line_type: 'GOODS', quantity: '2.5', unit_price: '333.3333', gst_rate: 5 },
    ], 'INTRA_STATE')
    assert.equal(totals.cgst, 830.83)
    assert.equal(totals.grand, 11494.99)
  })
})
