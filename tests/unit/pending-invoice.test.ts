// Sales order partial invoicing: statuses, the partial-invoice warning, release
// rules, the register / report layouts and "dispatched on posting". No database
// (rules are verified in supabase/tests/partial_invoicing_verification.sql).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { invoiceDispatchState, postingBlockedReason, type InvoiceDispatchLine } from '../../src/features/billing/dispatch-status-model.ts'
import {
  NON_STOCK_LABEL, customerPending, orderInvoiceLabel, orderInvoiceStatus, partialWarning, reconciliationSheet, registerSheet, registerStatus, releaseProblem,
  type TrackingLine,
} from '../../src/features/sales/pending-invoice-model.ts'

const line = (over: Partial<TrackingLine>): TrackingLine => ({
  sales_order_id: 'so4', sales_order_number: 'SO-000004', order_date: '2026-11-03', order_status: 'CONFIRMED', customer_id: 'c1', customer_name: 'Amazon',
  line_id: 'l1', line_no: 1, product_id: 'p1', sku: 'FG-SHR20910', product_name: 'Shower set', unit: 'PCS',
  ordered: 10, cancelled: 0, released: 0, effective: 10, invoiced: 0, draft_invoiced: 0, dispatched: 0, pending: 10, releasable: 10,
  invoice_numbers: null, latest_invoice_id: null, latest_invoice_number: null, latest_invoice_date: null, status: 'OPEN', ...over,
})
const after8 = line({ invoiced: 8, dispatched: 8, pending: 2, releasable: 2, status: 'PARTIALLY_INVOICED', invoice_numbers: ['INV-000123'], latest_invoice_id: 'i1', latest_invoice_date: '2026-11-03' })

describe('sales order invoicing status', () => {
  it('8 of 10 invoiced shows "Partially Invoiced – 2 PCS Pending" (not fully invoiced, not closed)', () => {
    assert.equal(orderInvoiceStatus([after8]), 'PARTIALLY_INVOICED')
    assert.equal(orderInvoiceLabel([after8]), 'Partially Invoiced – 2 PCS Pending')
  })
  it('open, fully invoiced, partially released, closed and cancelled', () => {
    assert.equal(orderInvoiceLabel([line({})]), 'Open – 10 PCS Pending')
    assert.equal(orderInvoiceLabel([line({ invoiced: 10, pending: 0, status: 'FULLY_INVOICED' })]), 'Fully Invoiced')
    assert.equal(orderInvoiceStatus([after8, line({ line_id: 'l2', released: 1, cancelled: 1, effective: 9, pending: 1, status: 'PARTIALLY_RELEASED' })]), 'PARTIALLY_RELEASED')
    assert.equal(orderInvoiceLabel([line({ invoiced: 9, released: 1, effective: 9, pending: 0, status: 'CLOSED' })]), 'Closed')
    assert.equal(orderInvoiceLabel([line({ status: 'CANCELLED', pending: 10 })]), 'Cancelled')
  })
  it('pending quantities of different units are listed separately', () => {
    assert.equal(orderInvoiceLabel([after8, line({ line_id: 'l2', unit: 'KG', pending: 1.5, invoiced: 1, status: 'PARTIALLY_INVOICED' })]), 'Partially Invoiced – 2 PCS + 1.5 KG Pending')
  })
  it('register status: Partially Invoiced / Pending Invoice', () => {
    assert.equal(registerStatus(after8), 'Partially Invoiced')
    assert.equal(registerStatus(line({})), 'Pending Invoice')
  })
})

describe('partial invoice warning', () => {
  it('uses the wording of the spec with order, quantities and the inventory note', () => {
    const w = partialWarning([{ sales_order_number: 'SO-000004', sku: 'FG-SHR20910', unit: 'PCS', ordered: 10, previously_invoiced: 0, this_invoice: 8, remaining: 2 }])
    assert.deepEqual(w, ['You are creating an invoice for 8 PCS of FG-SHR20910 against Sales Order SO-000004 of 10 PCS. The remaining 2 PCS will stay pending for future invoicing. They will not be added to actual inventory.'])
  })
  it('mentions earlier invoices; no warning when the invoice covers the remaining quantity', () => {
    assert.match(partialWarning([{ sales_order_number: 'SO-000004', sku: 'A', unit: 'PCS', ordered: 10, previously_invoiced: 8, this_invoice: 1, remaining: 1 }])![0], /\(8 PCS already invoiced\)/)
    assert.equal(partialWarning([{ sales_order_number: 'SO-000004', sku: 'A', unit: 'PCS', ordered: 10, previously_invoiced: 8, this_invoice: 2, remaining: 0 }]), null)
    assert.equal(partialWarning([]), null)
  })
})

describe('release pending quantity', () => {
  it('needs a quantity within what can be released, whole pieces for PCS, and a reason', () => {
    assert.equal(releaseProblem('1', 1, 'PCS', 'Customer no longer needs it'), null)
    assert.match(releaseProblem('2', 1, 'PCS', 'Customer no longer needs it')!, /Only 1 PCS can be released/)
    assert.match(releaseProblem('0.5', 1, 'PCS', 'Customer no longer needs it')!, /whole pieces/)
    assert.equal(releaseProblem('0.5', 1, 'KG', 'Customer no longer needs it'), null)
    assert.match(releaseProblem('1', 1, 'PCS', 'no')!, /reason/)
    assert.match(releaseProblem('abc', 1, 'PCS', 'Customer no longer needs it')!, /quantity/)
  })
})

describe('register and reports (Excel)', () => {
  it('register export has the spec columns, links order and invoice, and the non-stock label', () => {
    const s = registerSheet([after8])
    for (const h of ['Sales Order No.', 'Invoice No.', 'Customer', 'Product SKU', 'Product Name', 'Ordered Qty', 'Invoiced Qty', 'Pending Invoice Qty', 'Unit', 'Order Date', 'Invoice Date', 'Status']) {
      assert.ok(s[0].includes(h), h)
    }
    const col = (h: string) => s[1][s[0].indexOf(h)]
    assert.deepEqual([col('Sales Order No.'), col('Invoice No.'), col('Ordered Qty'), col('Invoiced Qty'), col('Pending Invoice Qty'), col('Status')],
      ['SO-000004', 'INV-000123', 10, 8, 2, 'Partially Invoiced'])
    assert.equal(col('Note'), NON_STOCK_LABEL)
  })
  it('reconciliation: ordered = released + other cancelled + invoiced + pending', () => {
    const s = reconciliationSheet([after8, line({ line_id: 'l2', invoiced: 9, released: 1, effective: 9, pending: 0, status: 'CLOSED' })])
    assert.equal(s[1][s[0].indexOf('Check')], 'OK')
    assert.equal(s[2][s[0].indexOf('Check')], 'OK')
    assert.equal(reconciliationSheet([line({ invoiced: 3, pending: 2 })])[1][12], 'Check')
  })
  it('customer-wise pending sums per customer and unit, largest pending first', () => {
    const rows = customerPending([after8, line({ line_id: 'l2', sales_order_id: 'so5', pending: 5 }), line({ line_id: 'l3', customer_name: 'Flipkart', customer_id: 'c2', pending: 1 })])
    assert.deepEqual(rows.map((r) => [r.customer, r.orders, r.pending]), [['Amazon', 2, 7], ['Flipkart', 1, 1]])
  })
})

describe('dispatch on posting (invoice status panel)', () => {
  const l = (over: Partial<InvoiceDispatchLine>): InvoiceDispatchLine => ({
    line_no: 1, line_type: 'PRODUCT', product_id: 'p', sku: 'FG-1', product_name: 'Basin', unit: 'PCS', applies: true, required: 8, dispatched: 0, remaining: 8,
    status: 'DISPATCH_ON_POSTING', reason: null, sales_order_id: 'so4', sales_order_number: 'SO-000004', ...over,
  })
  it('order lines dispatched on posting do not block posting', () => {
    const s = { lines: [l({})], ready: true, stock_lines: 1 }
    assert.equal(invoiceDispatchState(s), 'DISPATCH_ON_POSTING')
    assert.equal(postingBlockedReason(s), null)
  })
  it('a manual stock line still blocks posting', () => {
    const s = { lines: [l({}), l({ line_no: 2, status: 'AWAITING_DISPATCH', sales_order_id: null, sku: 'FG-2', remaining: 1, required: 1 })], ready: false, stock_lines: 2 }
    assert.match(postingBlockedReason(s)!, /FG-2/)
    assert.ok(!postingBlockedReason(s)!.includes('FG-1 '))
  })
})
