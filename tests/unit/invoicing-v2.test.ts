// Stage 6 (V2): GST engine, document titles, payment statuses, form checks and
// the invoice Excel parser. No database; the same figures are checked in
// supabase/tests/invoicing_v2_verification.sql.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildInvoiceImportReport, calculateInvoice, changeWarnings, documentTitle, invoiceTemplateRows, parseInvoiceSheet, paymentStatusOf, treatmentFor,
  validateInvoiceForm, type InvoiceCalcInput, type InvoiceImportGroup,
} from '../../src/features/billing/invoicing-v2-model.ts'

const base: Omit<InvoiceCalcInput, 'lines'> = {
  charges: [], pricingMode: 'EXCLUSIVE', invoiceDiscountPercent: null, invoiceDiscountAmount: null, treatment: 'INTRA_STATE', roundOff: false, roundingMode: 'NEAREST',
}
const line = (quantity: number, unitPrice: number, gstRate: number, extra: Partial<{ discountPercent: number; discountAmount: number }> = {}) =>
  ({ quantity, unitPrice, gstRate, discountPercent: extra.discountPercent ?? null, discountAmount: extra.discountAmount ?? null })

describe('GST engine (same as the database)', () => {
  it('line discounts, freight and CGST + SGST: 4990 (the draft-edit example of the DB suite)', () => {
    const t = calculateInvoice({ ...base, lines: [line(3, 1000, 18, { discountPercent: 10 }), line(3, 500, 12, { discountAmount: 100 })],
      charges: [{ kind: 'FREIGHT', amount: 200, gstRate: 18 }] })
    assert.equal(t.lines[0].taxable, 2700)
    assert.equal(t.lines[0].cgst, 243)
    assert.equal(t.lines[1].total, 1568)
    assert.equal(t.charges[0].total, 236)
    assert.equal(t.subtotal, 4500)
    assert.equal(t.discount, 400)
    assert.equal(t.taxable, 4300)
    assert.equal(t.grandTotal, 4990)
  })
  it('inter-state: IGST only', () => {
    const t = calculateInvoice({ ...base, treatment: 'INTER_STATE', lines: [line(1, 1000, 18)] })
    assert.deepEqual([t.cgst, t.sgst, t.igst, t.grandTotal], [0, 0, 180, 1180])
  })
  it('tax-inclusive price: 1180 incl. 18% = 1000 + 90 + 90', () => {
    const t = calculateInvoice({ ...base, pricingMode: 'INCLUSIVE', lines: [line(1, 1180, 18)] })
    assert.deepEqual([t.lines[0].taxable, t.cgst, t.sgst, t.grandTotal], [1000, 90, 90, 1180])
  })
  it('tax-inclusive with odd paise keeps the total: 999 incl. 18%', () => {
    const t = calculateInvoice({ ...base, pricingMode: 'INCLUSIVE', lines: [line(1, 999, 18)] })
    assert.equal(t.lines[0].taxable, 846.61)
    assert.equal(t.cgst + t.sgst, 152.39)
    assert.equal(t.grandTotal, 999)
  })
  it('invoice-level discount shared by value: 150 over 1000 + 500 = 100 + 50', () => {
    const t = calculateInvoice({ ...base, invoiceDiscountAmount: 150, lines: [line(1, 1000, 18), line(1, 500, 12)] })
    assert.deepEqual(t.lines.map((l) => l.invoiceDiscount), [100, 50])
    assert.equal(t.invoiceDiscount, 150)
    assert.equal(t.grandTotal, 1566)
  })
  it('invoice-level discount remainder goes to the largest line', () => {
    const t = calculateInvoice({ ...base, invoiceDiscountAmount: 10, lines: [line(1, 100, 0), line(1, 100, 0), line(1, 100.01, 0)] })
    assert.equal(t.lines.reduce((s, l) => s + l.invoiceDiscount, 0).toFixed(2), '10.00')
    assert.equal(t.lines[2].invoiceDiscount, 3.34)
  })
  it('rounding modes: 1179.99 -> nearest 1180, up 1180, down 1179; off keeps paise', () => {
    const lines = [line(1, 999.99, 18)]
    const calc = (roundOff: boolean, roundingMode: 'NEAREST' | 'UP' | 'DOWN') => calculateInvoice({ ...base, treatment: 'INTER_STATE', roundOff, roundingMode, lines })
    assert.equal(calc(false, 'NEAREST').grandTotal, 1179.99)
    assert.equal(calc(true, 'NEAREST').grandTotal, 1180)
    assert.equal(calc(true, 'UP').roundOff, 0.01)
    assert.equal(calc(true, 'DOWN').grandTotal, 1179)
    assert.equal(calc(true, 'DOWN').roundOff, -0.99)
  })
  it('no GST when not registered', () => {
    const t = calculateInvoice({ ...base, treatment: 'NONE', lines: [line(2, 100, 18)] })
    assert.equal(t.grandTotal, 200)
  })
})

describe('place of supply and titles', () => {
  it('treatment from seller GSTIN and place of supply', () => {
    assert.equal(treatmentFor('27AAACI9876A1Z5', '27'), 'INTRA_STATE')
    assert.equal(treatmentFor('27AAACI9876A1Z5', '24'), 'INTER_STATE')
    assert.equal(treatmentFor('27AAACI9876A1Z5', '96'), 'INTER_STATE')
    assert.equal(treatmentFor(null, '27'), null)
    assert.equal(treatmentFor(null, '27', false), 'NONE')
  })
  it('a proforma is never titled tax invoice', () => {
    assert.equal(documentTitle({ is_proforma: true, invoice_type: 'TAX_INVOICE' }), 'PROFORMA INVOICE')
    assert.equal(documentTitle({ invoice_type: 'TAX_INVOICE' }), 'TAX INVOICE')
    assert.equal(documentTitle({ invoice_type: 'BILL_OF_SUPPLY' }), 'BILL OF SUPPLY')
  })
  it('payment statuses: unpaid, partially paid, paid, overdue, cancelled', () => {
    assert.equal(paymentStatusOf({ status: 'ISSUED', payment_status: 'UNPAID', display_status: 'ISSUED' }), 'UNPAID')
    assert.equal(paymentStatusOf({ status: 'ISSUED', payment_status: 'PARTIALLY_PAID', display_status: 'PARTIALLY_PAID' }), 'PARTIALLY_PAID')
    assert.equal(paymentStatusOf({ status: 'ISSUED', payment_status: 'PARTIALLY_PAID', display_status: 'OVERDUE' }), 'OVERDUE')
    assert.equal(paymentStatusOf({ status: 'ISSUED', payment_status: 'PAID', display_status: 'PAID' }), 'PAID')
    assert.equal(paymentStatusOf({ status: 'CANCELLED' }), 'CANCELLED')
    assert.equal(paymentStatusOf({ status: 'DRAFT' }), null)
  })
})

describe('invoice form checks', () => {
  const header = { customerId: 'c1', invoiceDate: '2026-10-31', dueDate: '', ewayBill: '', gstin: '', pan: '', invoiceDiscountPercent: '', invoiceDiscountAmount: '', charges: { Freight: '' } }
  const ok = { product: { unit: 'PCS', sku: 'A' }, quantity: '2', unitPrice: '100', discountPercent: '', discountAmount: '', gstRate: '18' }
  it('accepts a complete invoice', () => assert.deepEqual(validateInvoiceForm(header, [ok]), []))
  it('reports customer, half pieces, over-invoicing a sales order, bad e-way bill, GSTIN and both discounts', () => {
    const e = validateInvoiceForm({ ...header, customerId: null, ewayBill: '123', gstin: '27ABC', invoiceDiscountPercent: '5', invoiceDiscountAmount: '10', dueDate: '2026-10-01' },
      [{ ...ok, quantity: '1.5' }, { ...ok, quantity: '8', pending: 5 }, { ...ok, unitPrice: '' }])
    const all = e.join(' | ')
    for (const s of ['Choose the customer', 'whole pieces', 'only 5 PCS', 'e-way bill', 'GSTIN', 'not both', 'due date', 'enter the rate']) assert.ok(all.includes(s), s)
  })
  it('warns before changes that affect balances or tax', () => {
    const w = changeWarnings({ grandTotal: 1180, placeOfSupply: '27', customerId: 'a' }, { grandTotal: 1200, placeOfSupply: '24', customerId: 'a' })
    assert.equal(w.length, 2)
    assert.deepEqual(changeWarnings(null, { grandTotal: 1, placeOfSupply: null, customerId: null }), [])
  })
})

describe('invoice Excel import', () => {
  it('reads the template (header aliases, dates, upper-case numbers)', () => {
    const rows = invoiceTemplateRows('2026-10-31').map((r) => r.map(String))
    const p = parseInvoiceSheet(rows)
    assert.equal(p.headerRow, 1)
    assert.equal(p.rows.length, 2)
    assert.equal(p.rows[0].invoice_number, 'OLD-1001')
    assert.equal(p.rows[0].row_number, 2)
    assert.equal(p.rows[1].rate, '2500')
    assert.equal(p.rows[0].place_of_supply, '27')
  })
  it('finds a header below a title row and reports missing columns', () => {
    const p = parseInvoiceSheet([['Old invoices'], ['Inv No', 'Bill Date', 'Party', 'Item Code', 'Qty', 'Rate'], ['inv-9', '31/10/2026', 'X', 'A', '1,000', '5']])
    assert.equal(p.headerRow, 2)
    assert.equal(p.rows[0].invoice_number, 'INV-9')
    assert.equal(p.rows[0].quantity, '1000')
    assert.equal(p.rows[0].invoice_date, '2026-10-31')
    assert.ok(parseInvoiceSheet([['Name', 'Qty']]).missing.length > 0)
  })
  it('report: one line per row with the result and messages', () => {
    const g: InvoiceImportGroup[] = [
      { invoice_number: 'A1', first_row: 2, status: 'VALID', errors: [], warnings: [], invoice_date: null, customer_name: 'X', customer_gstin: null, sales_order_number: null,
        place_of_supply: null, estimated_total: 10, rows: [{ row_number: 2, sku: 'A', product_name: null, quantity: 1, unit: 'PCS', rate: 10, gst_rate: 0, errors: [], warnings: [], line_value: 10 }] },
      { invoice_number: 'A2', first_row: 3, status: 'ERROR', errors: ['held back'], warnings: [], invoice_date: null, customer_name: 'X', customer_gstin: null, sales_order_number: null,
        place_of_supply: null, estimated_total: 0, rows: [{ row_number: 3, sku: 'Z', product_name: null, quantity: 1, unit: null, rate: null, gst_rate: null, errors: ['Z not found'], warnings: [], line_value: null }] },
    ]
    const r = buildInvoiceImportReport(g, { created: [{ first_row: 2, invoice_number: 'A1' }], failed: [{ first_row: 3, messages: ['held back'] }] })
    assert.equal(r.length, 3)
    assert.equal(r[1][5], 'Imported')
    assert.equal(r[2][5], 'Not imported')
    assert.equal(r[2][6], 'Z not found held back')
  })
})
