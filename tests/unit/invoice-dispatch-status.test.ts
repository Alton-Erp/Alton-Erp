// Dispatch-before-posting status: badges, the disabled-Post reason and dispatch links.
// No database (the rule itself is verified in supabase/tests/invoice_dispatch_policy_verification.sql).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  dispatchExceptionsSheet, invoiceDispatchState, ordersToDispatch, postingBlockedReason, type InvoiceDispatchLine,
} from '../../src/features/billing/dispatch-status-model.ts'

const line = (over: Partial<InvoiceDispatchLine>): InvoiceDispatchLine => ({
  line_no: 1, line_type: 'PRODUCT', product_id: 'p', sku: 'FG-1', product_name: 'Basin mixer', unit: 'PCS', applies: true,
  required: 10, dispatched: 10, remaining: 0, status: 'FULLY_DISPATCHED', reason: null, sales_order_id: 'so-1', sales_order_number: 'SO-000001', ...over,
})
const status = (lines: InvoiceDispatchLine[]) => ({
  lines, stock_lines: lines.filter((l) => l.applies).length,
  ready: !lines.some((l) => l.applies && l.remaining > 0),
})

describe('invoice dispatch state', () => {
  it('fully dispatched goods are ready to post', () => {
    assert.equal(invoiceDispatchState(status([line({})])), 'READY_TO_POST')
    assert.equal(postingBlockedReason(status([line({})])), null)
  })
  it('partially dispatched and awaiting dispatch are distinguished', () => {
    assert.equal(invoiceDispatchState(status([line({ dispatched: 4, remaining: 6, status: 'PARTIALLY_DISPATCHED' })])), 'PARTIALLY_DISPATCHED')
    assert.equal(invoiceDispatchState(status([line({ dispatched: 0, remaining: 10, status: 'AWAITING_DISPATCH' })])), 'AWAITING_DISPATCH')
  })
  it('service-only / charge-only invoices need no dispatch', () => {
    const s = status([line({ applies: false, status: 'NOT_APPLICABLE', dispatched: null, reason: 'Non-stock item' }),
      line({ line_no: 2, line_type: 'CHARGE', applies: false, status: 'NOT_APPLICABLE', dispatched: null, reason: 'Charge / service line' })])
    assert.equal(invoiceDispatchState(s), 'NO_STOCK_LINES')
    assert.equal(postingBlockedReason(s), null)
  })
})

describe('posting disabled reason', () => {
  it('names each outstanding stock line with remaining and required quantities (fractions kept)', () => {
    const r = postingBlockedReason(status([
      line({ applies: false, status: 'NOT_APPLICABLE', sku: 'SVC', product_name: 'Installation' }),
      line({ line_no: 2, sku: 'KG-1', product_name: 'Glaze', unit: 'KG', required: 2.5, dispatched: 2.25, remaining: 0.25, status: 'PARTIALLY_DISPATCHED' }),
    ]))
    assert.equal(r, 'Dispatch the goods before posting. KG-1 Glaze: 0.25 KG of 2.5 still to dispatch.')
    assert.ok(!r!.includes('SVC'), 'services are not listed')
  })
  it('nothing loaded yet is not a block (the server still checks)', () => assert.equal(postingBlockedReason(null), null))
})

describe('dispatch links', () => {
  it('lists each sales order with outstanding goods once; unlinked lines give none', () => {
    const s = status([line({ remaining: 3, dispatched: 7 }), line({ line_no: 2, remaining: 1, dispatched: 0 }),
      line({ line_no: 3, remaining: 5, dispatched: 0, sales_order_id: null, sales_order_number: null })])
    assert.deepEqual(ordersToDispatch(s), [{ id: 'so-1', number: 'SO-000001' }])
  })
})

describe('historical exceptions export', () => {
  it('exports quantities as numbers', () => {
    const out = dispatchExceptionsSheet([{ invoice_id: 'i', invoice_number: 'INV/26-27/0001', invoice_date: '2026-10-01', customer: 'X', source: 'MANUAL',
      line_no: 1, sku: 'FG-1', product_name: 'Basin mixer', unit: 'PCS', invoiced: 5, covered: 0, uncovered: 5, reason: null }])
    assert.equal(out[1][out[0].indexOf('Not covered')], 5)
    assert.equal(out[1][out[0].indexOf('Invoice')], 'INV/26-27/0001')
  })
})
