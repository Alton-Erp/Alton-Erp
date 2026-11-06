// Purchase Cost Intelligence: change classification, percentages, PO and receipt unit costs, history filters (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY_FILTER,
  changeTypeOf,
  costChange,
  filterHistory,
  historySuppliers,
  isSignificant,
  percentText,
  poLineNetUnitCost,
  signedMoney,
  trendOf,
  trendPoints,
  weightedUnitCost,
  type PurchaseCostEvent,
} from '../../src/features/products/purchase-cost.ts'

const inr = (n: number) => `₹${n.toFixed(2)}`

describe('cost change', () => {
  it('increase: 850 → 920 is +70 (+8.24%)', () => {
    assert.deepEqual(costChange(850, 920), { trend: 'up', difference: 70, percent: 8.24 })
    assert.equal(changeTypeOf(850, 920), 'INCREASE')
    assert.equal(percentText(8.24), '+8.24%')
    assert.equal(signedMoney(70, inr), '+₹70.00')
  })

  it('decrease: 920 → 900 is −20 (−2.17%)', () => {
    assert.deepEqual(costChange(920, 900), { trend: 'down', difference: -20, percent: -2.17 })
    assert.equal(changeTypeOf(920, 900), 'DECREASE')
    assert.equal(percentText(-2.17), '−2.17%')
    assert.equal(signedMoney(-20, inr), '−₹20.00')
  })

  it('no change, initial cost, a cleared cost and a previous cost of zero', () => {
    assert.deepEqual(costChange(900, 900), { trend: 'same', difference: 0, percent: 0 })
    assert.equal(changeTypeOf(900, 900), 'NO_CHANGE')
    assert.equal(changeTypeOf(null, 900), 'INITIAL_COST')
    assert.equal(changeTypeOf(900, null), 'NO_COST')
    assert.deepEqual(costChange(null, 900), { trend: 'none', difference: null, percent: null })
    assert.deepEqual(costChange(0, 50), { trend: 'up', difference: 50, percent: null }, 'no percentage from a zero cost')
    assert.equal(trendOf(10.00001, 10.00002), 'same', 'compared at 4 decimals like the database')
  })

  it('a significant change is at or above the threshold, either way', () => {
    assert.equal(isSignificant(8.24, 10), false)
    assert.equal(isSignificant(10, 10), true)
    assert.equal(isSignificant(-12.5, 10), true)
    assert.equal(isSignificant(0, 0), false)
    assert.equal(isSignificant(null, 10), false)
  })
})

describe('unit costs (same rules as the database)', () => {
  it('PO line: quantity × price − discount, per unit, excl. GST', () => {
    assert.equal(poLineNetUnitCost({ quantity: 4, unit_price: 1000, discount_percent: 10 }), 900)
    assert.equal(poLineNetUnitCost({ quantity: 3, unit_price: 100, discount_amount: 10 }), 96.6667)
    assert.equal(poLineNetUnitCost({ quantity: 2, unit_price: 50, discount_amount: 500 }), 0, 'the discount never exceeds the line')
    assert.equal(poLineNetUnitCost({ quantity: 0, unit_price: 850 }), null)
    assert.equal(poLineNetUnitCost({ quantity: 5, unit_price: null }), null)
  })

  it('several receipt lines of one product: weighted by accepted quantity; rejected-only lines and missing costs handled', () => {
    assert.equal(weightedUnitCost([{ accepted_quantity: 3, unit_cost: 1000 }, { accepted_quantity: 1, unit_cost: 800 }]), 950)
    assert.equal(weightedUnitCost([{ accepted_quantity: 2, unit_cost: 10 }, { accepted_quantity: 0, unit_cost: 99 }]), 10)
    assert.equal(weightedUnitCost([{ accepted_quantity: 1, unit_cost: null }]), null)
    assert.equal(weightedUnitCost([]), null)
  })
})

describe('history display', () => {
  const ev = (over: Partial<PurchaseCostEvent>): PurchaseCostEvent => ({
    id: 'e', event_type: 'GRN_RECEIPT', status: 'APPLIED', not_applied_reason: null, previous_cost: null, new_cost: 100, difference: null, change_percent: null,
    change_type: 'INITIAL_COST', significant: false, received_quantity: 1, rejected_quantity: 0, unit: 'PCS', currency: 'INR', cost_basis: {}, supplier_id: null,
    supplier_name: null, purchase_order_id: null, po_number: null, goods_receipt_id: null, receipt_number: null, effective_date: '2026-11-01', posted_at: '',
    reason: 'r', created_at: '2026-11-01T10:00:00Z', reversed: false, created_by_name: null, ...over,
  })

  it('the trend: the cost after each applied event, oldest first', () => {
    const events = [ev({ id: '3', new_cost: 900, created_at: '2026-11-03T00:00:00Z' }), ev({ id: 'x', status: 'NOT_APPLIED', new_cost: 5, created_at: '2026-11-04T00:00:00Z' }),
      ev({ id: '2', new_cost: 920, created_at: '2026-11-02T00:00:00Z' }), ev({ id: '1', new_cost: 850, created_at: '2026-11-01T00:00:00Z' }),
      ev({ id: 'r', event_type: 'GRN_REVERSAL', new_cost: null, created_at: '2026-11-05T00:00:00Z' })]
    assert.deepEqual(trendPoints(events, (e) => e.id).map((p) => [p.label, p.value]), [['1', 850], ['2', 920], ['3', 900]])
  })

  it('filters by date range, supplier and increase / decrease', () => {
    const events = [
      ev({ id: 'a', effective_date: '2026-10-01', supplier_id: 's1', supplier_name: 'Alpha', change_type: 'INCREASE' }),
      ev({ id: 'b', effective_date: '2026-10-15', supplier_id: 's2', supplier_name: 'Beta', change_type: 'DECREASE' }),
      ev({ id: 'c', effective_date: '2026-11-02', supplier_id: 's1', supplier_name: 'Alpha', change_type: 'NO_CHANGE' }),
    ]
    const ids = (f: Partial<typeof EMPTY_FILTER>) => filterHistory(events, { ...EMPTY_FILTER, ...f }).map((e) => e.id)
    assert.deepEqual(ids({}), ['a', 'b', 'c'])
    assert.deepEqual(ids({ from: '2026-10-10', to: '2026-10-31' }), ['b'])
    assert.deepEqual(ids({ supplierId: 's1' }), ['a', 'c'])
    assert.deepEqual(ids({ change: 'increase' }), ['a'])
    assert.deepEqual(ids({ change: 'decrease' }), ['b'])
    assert.deepEqual(historySuppliers(events), [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }])
  })
})
