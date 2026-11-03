import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  acos, acosTargets, adMetrics, affordableCpc, contribution, ctr, cpc, forecastDemand, ratio, replenishment, roas, stockCoverDays, sumComponents, tacos, wilsonLower,
} from '../../src/features/amazon/metrics.ts'

describe('amazon advertising metrics', () => {
  it('computes ACoS, ROAS, TACoS, CTR, CPC on normal data', () => {
    assert.equal(acos(250, 1000), 25)
    assert.equal(roas(1000, 250), 4)
    assert.equal(tacos(250, 5000), 5)
    assert.equal(ctr(30, 10000), 0.3)
    assert.equal(cpc(250, 25), 10)
  })
  it('returns null (unavailable) for zero or missing denominators, never 0 or Infinity', () => {
    assert.equal(acos(100, 0), null)
    assert.equal(roas(100, 0), null)
    assert.equal(ctr(0, 0), null)
    assert.equal(cpc(0, 0), null)
    assert.equal(ratio(null, 5), null)
    const m = adMetrics({ spend: 500, sales: 0, clicks: 40, impressions: 9000, orders: 0 })
    assert.equal(m.acos, null)
    assert.equal(m.spendWithoutSales, true)
    assert.equal(m.costPerOrder, null)
  })
})

describe('amazon contribution', () => {
  const base = {
    ordered_sales: 11800, units: 10, sales_ex_gst: 10000, refunds_ex_gst: 0, discounts_ex_gst: 0, gst_missing: false,
    actual_referral: 1180, actual_fulfilment: 700, actual_other: 0, est_referral: null, est_fulfilment: null, fee_missing_days: 0,
    shipping_cost: 0, other_variable_cost: 100, product_cost: 5000, units_without_cost: 0, ad_spend: 900, ad_sales: 5900,
  }
  it('normal case: before = 10000 - 5000 - 1180 - 700 - 100 = 3020; after = 3020 - 900 = 2120', () => {
    const c = contribution(base)
    assert.equal(c.beforeAds, 3020)
    assert.equal(c.afterAds, 2120)
    assert.equal(c.feeBasis, 'ACTUAL')
    assert.deepEqual(c.missing, [])
    assert.equal(c.marginBeforePct, 30.2)
  })
  it('refunds and discounts reduce net sales once (ex-GST)', () => {
    const c = contribution({ ...base, refunds_ex_gst: 1000, discounts_ex_gst: 200 })
    assert.equal(c.netSalesExGst, 8800)
    assert.equal(c.beforeAds, 1820)
  })
  it('missing product cost makes contribution unavailable and says why', () => {
    const c = contribution({ ...base, units_without_cost: 4, product_cost: 3000 })
    assert.equal(c.beforeAds, null)
    assert.equal(c.afterAds, null)
    assert.match(c.missing.join(), /product cost for 4 unit/)
  })
  it('missing GST rate makes contribution unavailable', () => {
    const c = contribution({ ...base, gst_missing: true, sales_ex_gst: null })
    assert.equal(c.beforeAds, null)
    assert.match(c.missing.join(), /GST rate/)
  })
  it('estimated fees are used and flagged when settlements are missing', () => {
    const c = contribution({ ...base, actual_referral: null, actual_fulfilment: null, actual_other: null, est_referral: 1180, est_fulfilment: 700 })
    assert.equal(c.beforeAds, 3020)
    assert.equal(c.feeBasis, 'ESTIMATED')
    assert.equal(c.estimated.length, 1)
  })
  it('fees neither synced nor configured make contribution unavailable', () => {
    const c = contribution({ ...base, actual_referral: null, actual_fulfilment: null, actual_other: null, fee_missing_days: 3 })
    assert.equal(c.beforeAds, null)
  })
  it('overhead is shown only when configured and kept separate from actual contribution', () => {
    assert.equal(contribution(base).estimatedOperating, null)
    const c = contribution(base, { overheadPct: 10 })
    assert.equal(c.overhead, 1000)
    assert.equal(c.estimatedOperating, 1120)
    assert.equal(c.afterAds, 2120)
  })
  it('sums components without turning unknowns into zeros', () => {
    const s = sumComponents([{ ad_spend: 10, product_cost: null }, { ad_spend: 5, product_cost: null, gst_missing: true }])
    assert.equal(s.ad_spend, 15)
    assert.equal(s.product_cost, null)
    assert.equal(s.gst_missing, true)
  })
})

describe('amazon break-even, target ACoS and affordable CPC', () => {
  it('break-even ACoS = before-ads contribution / reported sales; target subtracts desired contribution', () => {
    const t = acosTargets({ beforeAds: 3020, reportedSales: 11800, units: 10, companyTargetPct: 10 })
    assert.equal(t.breakEvenAcos, 25.59)
    assert.equal(t.targetAcos, 15.59)
    assert.equal(t.targetSource, 'COMPANY_TARGET_MARGIN')
  })
  it('a per-unit desired contribution takes precedence over the company %', () => {
    const t = acosTargets({ beforeAds: 3020, reportedSales: 11800, units: 10, desiredPerUnit: 118, companyTargetPct: 10 })
    assert.equal(t.targetAcos, 15.59)
    assert.equal(t.targetSource, 'DESIRED_CONTRIBUTION_PER_UNIT')
  })
  it('no room for advertising gives target 0 with an explanation; unknown costs give no target', () => {
    const t = acosTargets({ beforeAds: 500, reportedSales: 11800, units: 10, companyTargetPct: 10 })
    assert.equal(t.targetAcos, 0)
    assert.match(t.note ?? '', /no room/)
    assert.equal(acosTargets({ beforeAds: null, reportedSales: 11800, units: 10, companyTargetPct: 10 }).targetAcos, null)
  })
  it('max CPC = max cost per order x conversion; small samples use the conservative lower bound', () => {
    const ok = affordableCpc({ targetAcos: 20, avgOrderValue: 1000, clicks: 200, orders: 10, minClicks: 20 })
    assert.equal(ok.maxCostPerOrder, 200)
    assert.equal(ok.conversionBasis, 'OBSERVED')
    assert.equal(ok.maxCpc, 10)
    const small = affordableCpc({ targetAcos: 20, avgOrderValue: 1000, clicks: 10, orders: 1, minClicks: 20 })
    assert.equal(small.conversionBasis, 'CONSERVATIVE_LOWER_BOUND')
    assert.ok(small.maxCpc !== null && small.maxCpc < 20)
    const none = affordableCpc({ targetAcos: 20, avgOrderValue: 1000, clicks: 0, orders: 0, minClicks: 20 })
    assert.equal(none.maxCpc, null)
    assert.equal(affordableCpc({ targetAcos: 20, avgOrderValue: 1000, clicks: 0, orders: 0, minClicks: 20, assumedConversion: 5 }).maxCpc, 10)
    assert.ok((wilsonLower(1, 10) ?? 1) < 0.1)
  })
})

describe('amazon stock cover and demand', () => {
  it('stock cover and forecast with a range; unreliable with short history', () => {
    assert.equal(stockCoverDays(100, 4), 25)
    assert.equal(stockCoverDays(100, 0), null)
    const f = forecastDemand(Array(28).fill(4), 30)
    assert.equal(f.expected, 120)
    assert.equal(f.low, 120)
    assert.equal(f.reliable, true)
    assert.equal(forecastDemand([1, 2], 30).reliable, false)
  })
  it('replenishment needs a lead time and accounts for incoming stock', () => {
    assert.equal(replenishment({ available: 10, incoming: 0, avgDaily: 2, leadTimeDays: null, safetyDays: 14 }).quantity, null)
    assert.equal(replenishment({ available: 10, incoming: 20, avgDaily: 2, leadTimeDays: 30, safetyDays: 14 }).quantity, 58)
  })
})
