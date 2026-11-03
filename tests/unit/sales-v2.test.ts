// Stage 5 (V2): order pricing, GST split, form checks, statuses and the Excel
// parser. No database; the same figures are checked in
// supabase/tests/sales_v2_verification.sql.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSalesImportReport, isInterState, parseSalesSheet, priceLine, priceOrder, salesTemplateRows, soStatusMeta, validateSoForm, type ImportGroup,
} from '../../src/features/sales/sales-v2-model.ts'

describe('sales order pricing (same as the database)', () => {
  const lines = [
    { quantity: 100, unitPrice: 1000, discountPercent: 10, discountAmount: null, gstRate: 18 },
    { quantity: 50, unitPrice: 500, discountPercent: null, discountAmount: 500, gstRate: 12 },
    { quantity: 200, unitPrice: 100, discountPercent: null, discountAmount: null, gstRate: 5 },
  ]
  it('prices each line: discount, taxable value, GST and total', () => {
    assert.deepEqual(priceLine(lines[0]), { gross: 100000, discount: 10000, taxable: 90000, gst: 16200, total: 106200 })
    assert.deepEqual(priceLine(lines[1]), { gross: 25000, discount: 500, taxable: 24500, gst: 2940, total: 27440 })
  })
  it('totals with freight and other charges: grand total 156056, CGST = SGST 10178 within the state', () => {
    const t = priceOrder(lines, { freight: 1000, other: 200, gstRate: 18 }, false)
    assert.equal(t.subtotal, 145000)
    assert.equal(t.discount, 10500)
    assert.equal(t.taxable, 135700)
    assert.equal(t.cgst, 10178)
    assert.equal(t.sgst, 10178)
    assert.equal(t.igst, 0)
    assert.equal(t.grandTotal, 156056)
  })
  it('uses IGST for another state', () => {
    const t = priceOrder([{ quantity: 5, unitPrice: 1000, discountPercent: null, discountAmount: null, gstRate: 18 }], { freight: 0, other: 0, gstRate: 18 }, true)
    assert.equal(t.igst, 900)
    assert.equal(t.cgst, 0)
    assert.equal(t.grandTotal, 5900)
  })
  it('a discount amount never exceeds the line value; no price means zero', () => {
    assert.equal(priceLine({ quantity: 1, unitPrice: 100, discountPercent: null, discountAmount: 500, gstRate: 0 }).taxable, 0)
    assert.equal(priceLine({ quantity: 3, unitPrice: null, discountPercent: null, discountAmount: null, gstRate: 18 }).total, 0)
  })
  it('decides the state from the GSTINs', () => {
    assert.equal(isInterState('27AAACS9876A1Z5', '24'), true)
    assert.equal(isInterState('27AAACS9876A1Z5', '27AABCX1234A1Z5'), false)
    assert.equal(isInterState(null, '24'), false)
  })
})

describe('order form checks', () => {
  const p = { unit: 'PCS', sku: 'SV-A' }
  const line = { product: p, quantity: '10', unitPrice: '', discountPercent: '', discountAmount: '', gstRate: '' }
  it('accepts a valid order', () => assert.deepEqual(validateSoForm('c1', [line], { freight: '', other: '' }), []))
  it('needs a customer and a product', () => {
    const e = validateSoForm(null, [{ ...line, product: null }], { freight: '', other: '' })
    assert.ok(e.includes('Choose the customer.'))
    assert.ok(e.some((m) => m.includes('choose the product')))
  })
  it('refuses half pieces, discount over 100 % and text amounts', () => {
    const e = validateSoForm('c1', [{ ...line, quantity: '1.5', discountPercent: '120' }], { freight: 'abc', other: '' })
    assert.ok(e.some((m) => m.includes('whole pieces')))
    assert.ok(e.some((m) => m.includes('discount %')))
    assert.ok(e.includes('Freight must be a number.'))
  })
})

describe('statuses', () => {
  it('has the nine Stage 5 statuses with plain labels', () => {
    assert.equal(soStatusMeta('STOCK_SHORTAGE').label, 'Stock Shortage')
    assert.equal(soStatusMeta('READY_FOR_DISPATCH').tone, 'success')
    assert.equal(soStatusMeta('PARTIALLY_DISPATCHED').label, 'Partially Dispatched')
  })
})

describe('Excel sales order import', () => {
  it('maps the template columns and keeps every non-blank row with its row number', () => {
    const r = parseSalesSheet([
      salesTemplateRows('2026-10-31')[0].map(String),
      ['31-10-2026', 'Xylo Homes', '27aabcx1234a1z5', 'PO-1', 'FG-1', 'Basin', '1,000', 'pcs', '1000', '10%', '18', '', 'x'],
      ['', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['2026-10-31', 'Xylo Homes', '', 'PO-1', 'FG-2', '', '5', '', '', '', '', '', ''],
    ])
    assert.equal(r.headerRow, 1)
    assert.deepEqual(r.rows.map((x) => x.row_number), [2, 4])
    assert.equal(r.rows[0].order_date, '2026-10-31')
    assert.equal(r.rows[0].quantity, '1000')
    assert.equal(r.rows[0].customer_gstin, '27AABCX1234A1Z5')
    assert.equal(r.rows[0].unit, 'PCS')
  })
  it('accepts common header names and reports missing columns', () => {
    assert.equal(parseSalesSheet([['Date', 'Customer', 'Order No', 'SKU', 'Qty'], ['2026-10-01', 'A', 'R1', 'S', '2']]).rows[0].customer_reference, 'R1')
    assert.deepEqual(parseSalesSheet([['SKU', 'Qty']]).missing, ['Order Date', 'Customer Name or Customer GSTIN', 'Product SKU', 'Quantity'])
  })
  it('error report lists every row with the order result', () => {
    const g: ImportGroup[] = [
      { first_row: 2, status: 'VALID', errors: [], warnings: [], customer_name: 'X', customer_reference: 'PO-1', order_date: '2026-10-31', estimated_total: 10,
        rows: [{ row_number: 2, sku: 'A', product_name: null, quantity: 1, unit: 'PCS', unit_price: 10, errors: [], warnings: [], line_total: 10 },
               { row_number: 3, sku: 'B', product_name: null, quantity: 1, unit: 'PCS', unit_price: 0, errors: [], warnings: [], line_total: 0 }] },
      { first_row: 4, status: 'ERROR', errors: ['1 row(s) of this order have errors'], warnings: [], customer_name: 'Y', customer_reference: 'N-1', order_date: null, estimated_total: 0,
        rows: [{ row_number: 4, sku: 'NOPE', product_name: null, quantity: 1, unit: null, unit_price: null, errors: ['SKU "NOPE" was not found.'], warnings: [], line_total: null }] },
    ]
    const report = buildSalesImportReport(g, { created: [{ first_row: 2, sales_order_number: 'SO-000009' }], failed: [{ first_row: 4, messages: ['held back'] }] })
    assert.equal(report.length, 4)
    assert.deepEqual([report[1][5], report[1][6]], ['Imported', 'SO-000009'])
    assert.equal(report[3][5], 'Not imported')
    assert.match(String(report[3][7]), /NOPE/)
  })
})
