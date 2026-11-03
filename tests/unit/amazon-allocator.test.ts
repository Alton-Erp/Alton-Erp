import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { allocateBudget, marginalAcos, salesAt, scenarios, type AllocItem } from '../../src/features/amazon/allocator.ts'

const item = (over: Partial<AllocItem> = {}): AllocItem => ({
  key: 'A', label: 'A', dailySpend: 100, dailySales: 800, clicks: 600, orders: 40, contributionPerSale: 0.3, breakEvenAcos: 30, targetAcos: 20,
  avgPrice: 1000, avgDailyUnits: 2, stockAvailable: 10000, ...over,
})

describe('budget allocator', () => {
  it('diminishing returns: doubling spend raises sales by less than double; marginal ACoS rises with spend', () => {
    assert.ok(salesAt(200, 100, 800, 0.6) < 1600)
    assert.ok((marginalAcos(200, 100, 800, 0.6) ?? 0) > (marginalAcos(100, 100, 800, 0.6) ?? 0))
  })
  it('never allocates more than the total budget or the daily limit', () => {
    const r = allocateBudget([item(), item({ key: 'B', label: 'B' })], { monthlyBudget: 30000, mode: 'PROFIT' })
    assert.ok(r.allocatedMonthly <= 30000 + 0.01)
    const d = allocateBudget([item(), item({ key: 'B', label: 'B' })], { monthlyBudget: 30000, dailyLimit: 150, mode: 'PROFIT' })
    assert.ok(d.items.reduce((s, x) => s + x.proposedDaily, 0) <= 150 + 0.01)
  })
  it('respects per-item minimum and maximum budgets', () => {
    const r = allocateBudget([item({ maxDaily: 120 }), item({ key: 'B', label: 'B', minDaily: 50, contributionPerSale: 0.05, breakEvenAcos: 5 })], { monthlyBudget: 60000, mode: 'PROFIT' })
    assert.ok(r.items[0].proposedDaily <= 120 + 0.01)
    assert.ok(r.items[1].proposedDaily >= 50 - 0.01)
  })
  it('profit mode stops at break-even: an unprofitable item gets no extra budget and money stays unallocated', () => {
    const r = allocateBudget([item({ contributionPerSale: 0.05, breakEvenAcos: 5 })], { monthlyBudget: 90000, mode: 'PROFIT' })
    assert.ok(r.items[0].proposedDaily < 100)
    assert.ok(r.unallocatedMonthly > 0)
  })
  it('stock limits the extra spend and flags stockout risk', () => {
    const r = allocateBudget([item({ stockAvailable: 40, avgDailyUnits: 2 })], { monthlyBudget: 30000, mode: 'GROWTH' })
    assert.equal(r.items[0].stockoutRisk, true)
    assert.ok(r.items[0].proposedDaily <= 100 + 0.01)
  })
  it('items with too little data get only their minimum (test) budget, low confidence and no forecast', () => {
    const r = allocateBudget([item({ clicks: 5, orders: 0, minDaily: 30 })], { monthlyBudget: 30000, mode: 'GROWTH' })
    assert.equal(r.items[0].modelled, false)
    assert.equal(r.items[0].proposedDaily, 30)
    assert.equal(r.items[0].forecast, null)
    assert.equal(r.items[0].confidence, 'LOW')
  })
  it('forecasts are ranges (low <= mid <= high) and incomplete costs block profit allocation', () => {
    const r = allocateBudget([item()], { monthlyBudget: 6000, mode: 'GROWTH' })
    const f = r.items[0].forecast!
    assert.ok(f.salesMonthly[0] <= f.salesMonthly[1] && f.salesMonthly[1] <= f.salesMonthly[2])
    const blocked = allocateBudget([item({ contributionPerSale: null })], { monthlyBudget: 30000, mode: 'PROFIT' })
    assert.ok(blocked.items[0].proposedDaily <= 0.01)
    assert.match(blocked.items[0].reasons.join(' '), /Costs are incomplete/)
  })
  it('scenario simulator: a larger budget never allocates less, and diminishing returns show in the sales forecast', () => {
    const s = scenarios([item(), item({ key: 'B', label: 'B', dailySpend: 50, dailySales: 600 })], { mode: 'GROWTH' }, [
      { label: 'Current', monthly: 4500 }, { label: '+10%', monthly: 4950 }, { label: '+30%', monthly: 5850 }])
    assert.ok(s[1].result.allocatedMonthly >= s[0].result.allocatedMonthly && s[2].result.allocatedMonthly >= s[1].result.allocatedMonthly)
    const sales = s.map((x) => x.result.forecastSalesMonthly![1])
    assert.ok(sales[2] - sales[0] < ((5850 - 4500) / 4500) * sales[0], 'sales grow less than proportionally to spend')
  })
})
