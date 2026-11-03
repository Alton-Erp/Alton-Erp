import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { analyseCampaign, analyseProduct, type AmazonSettings, type CampaignRow, type ProductRow, type SearchTermRow } from '../../src/features/amazon/analysis.ts'
import { generateRecommendations } from '../../src/features/amazon/recommendations.ts'

const settings: AmazonSettings = {
  prices_include_gst: true, attribution_window_days: 7, min_clicks_for_decision: 20, min_orders_for_scaling: 3, wasted_spend_threshold: 500, low_stock_cover_days: 14,
  overstock_cover_days: 120, target_contribution_pct: 10, overhead_allocation_pct: 0, automation_mode: 'READ_ONLY', kill_switch: true, max_daily_budget: null,
  max_monthly_budget: null, max_bid: null, max_bid_change_pct: 30, max_budget_change_pct: 30,
}
const today = '2026-10-31'

function product(over: Partial<ProductRow> & { totals?: ProductRow['totals'] } = {}): ProductRow {
  return {
    seller_sku: 'SKU-1', listing_id: 'l1', asin: 'B000000001', title: 'Basin', marketplace_id: 'A21TJRUUN4KGV', product_id: 'p1', erp_sku: 'SKU-1', erp_name: 'Basin', category: null,
    item_price: 1180, fulfillment_channel: 'FBA', listing_status: 'Active', advertising_status: 'ADVERTISED', data_source: 'API', gst_rate: 18, gst_source: 'ERP_PRODUCT',
    unit_cost: 500, cost_source: 'ERP_STANDARD_COST', costs_updated_at: null, referral_fee_pct: 10, closing_fee_per_unit: null, fulfilment_fee_per_unit: 70, shipping_cost_per_unit: 0,
    other_variable_cost_per_unit: 10, desired_contribution_per_unit: null, target_acos_pct: null, min_stock: null, lead_time_days: 20,
    totals: { ordered_sales: 118000, units: 100, sessions: 2000, sales_ex_gst: 100000, refunds_ex_gst: 0, discounts_ex_gst: 0, gst_missing: false, actual_referral: 11800,
      actual_fulfilment: 7000, actual_other: 0, est_referral: null, est_fulfilment: null, fee_missing_days: 0, shipping_cost: 0, other_variable_cost: 1000, product_cost: 50000,
      units_without_cost: 0, ad_spend: 5000, ad_sales: 59000, ad_orders: 50, ad_clicks: 800, ad_impressions: 200000, sales_days: 30 },
    stock: { erp_available: 600, erp_as_of: today, amazon_fulfillable: null, amazon_inbound: null, amazon_as_of: null, amazon_source: null, incoming_production: 0 },
    velocity: { units_7: 23, units_28: 92, units_56: 180, days_with_data_28: 28, daily_28: Array(28).fill(3.3) }, campaigns: ['C1'], ...over,
  }
}
const campaign = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  campaign_id: 'C1', profile_id: 'P', name: 'Campaign 1', ad_product: 'SPONSORED_PRODUCTS', targeting_type: 'MANUAL', state: 'ENABLED', daily_budget: 200, data_source: 'API',
  last_synced_at: null, impressions: 200000, clicks: 800, spend: 5000, sales: 59000, orders: 50, units: 50, days_with_data: 30, budget_total: 6000, budget_constrained_days: 20,
  zero_order_target_spend: 0, products: ['SKU-1'], ...over,
})
const term = (over: Partial<SearchTermRow> = {}): SearchTermRow => ({
  campaign_id: 'C1', campaign_name: 'Campaign 1', targeting_type: 'MANUAL', ad_group_id: 'G1', ad_group_name: 'G', targeting: 'basin', match_type: 'BROAD', search_term: 'wash basin',
  target_id: 'T1', bid: 12, impressions: 5000, clicks: 40, spend: 600, sales: 0, orders: 0, units: 0, days: 30, asin: null, seller_sku: 'SKU-1', exact_exists: false, negative_exists: false, ...over,
})
const status = { sales_days: 30, fee_days: 30, campaign_days: 30, search_term_days: 30, period_days: 30, listings: 1, mapped_listings: 1 }

function run(p: ProductRow[], c: CampaignRow[], t: SearchTermRow[], over: Partial<typeof status> = {}, to = '2026-10-20') {
  const products = p.map((x) => analyseProduct(x, settings, today))
  const map = new Map(products.map((x) => [x.sku, x]))
  return generateRecommendations({ from: '2026-09-21', to, today, settings, products, campaigns: c.map((x) => analyseCampaign(x, map)), searchTerms: t, dataStatus: { ...status, ...over }, demo: false })
}
const codes = (r: ReturnType<typeof run>) => r.items.map((i) => i.rule_code)

describe('amazon recommendation engine', () => {
  it('profitable, budget-constrained campaign with stock: cautious budget increase within the change limit', () => {
    const r = run([product()], [campaign()], [])
    const rec = r.items.find((i) => i.rule_code === 'BUDGET_CONSTRAINED_PROFITABLE')!
    assert.ok(rec)
    assert.equal(rec.change?.change_type, 'CAMPAIGN_BUDGET')
    assert.equal(rec.change?.daily_budget, 240)
    assert.ok(rec.financial.calculation.length > 0 && rec.evidence.acos !== undefined)
  })
  it('no budget increase when the advertised product is low on stock; a stock warning instead', () => {
    const r = run([product({ stock: { erp_available: 20, erp_as_of: today, amazon_fulfillable: null, amazon_inbound: null, amazon_as_of: null, amazon_source: null, incoming_production: 0 } })], [campaign()], [])
    assert.ok(!codes(r).includes('BUDGET_CONSTRAINED_PROFITABLE'))
    assert.ok(codes(r).includes('STOCKOUT_RISK_WITH_ADS'))
  })
  it('wasted search term: spend above threshold with enough clicks and no orders -> negative keyword for review', () => {
    const r = run([product()], [], [term()])
    const rec = r.items.find((i) => i.rule_code === 'WASTED_SEARCH_TERM')!
    assert.equal(rec.change?.change_type, 'NEGATIVE_KEYWORD')
    assert.equal(rec.change?.keyword, 'wash basin')
  })
  it('too few clicks: no wasted-spend recommendation (insufficient evidence)', () => {
    assert.ok(!codes(run([product()], [], [term({ clicks: 10 })])).includes('WASTED_SEARCH_TERM'))
  })
  it('harvests a converting non-exact search term below the target ACoS; skips it if an exact keyword exists', () => {
    assert.ok(codes(run([product()], [], [term({ orders: 4, sales: 4720, spend: 300 })])).includes('HARVEST_EXACT_KEYWORD'))
    assert.ok(!codes(run([product()], [], [term({ orders: 4, sales: 4720, spend: 300, exact_exists: true })])).includes('HARVEST_EXACT_KEYWORD'))
  })
  it('missing costs: a data recommendation and no profit-based actions', () => {
    const r = run([product({ totals: { ...product().totals!, units_without_cost: 100, product_cost: 0 } })], [campaign()], [])
    assert.ok(codes(r).includes('MISSING_COST_DATA'))
    assert.ok(!codes(r).includes('BUDGET_CONSTRAINED_PROFITABLE'))
    assert.ok(!codes(r).includes('UNPROFITABLE_ADVERTISING'))
  })
  it('loss-making advertising is flagged with the calculation', () => {
    const r = run([product({ totals: { ...product().totals!, ad_spend: 40000 } })], [], [])
    const rec = r.items.find((i) => i.rule_code === 'UNPROFITABLE_ADVERTISING')!
    assert.ok(rec && (rec.financial.amount ?? 0) > 0)
  })
  it('incomplete reports and a period ending inside the attribution window are reported and lower confidence', () => {
    const r = run([product({ totals: { ...product().totals!, ad_spend: 40000 } })], [], [], { sales_days: 20 }, '2026-10-30')
    assert.ok(codes(r).includes('INCOMPLETE_REPORTS'))
    assert.ok(r.warnings.some((w) => /attributed/.test(w)))
    assert.notEqual(r.items.find((i) => i.rule_code === 'UNPROFITABLE_ADVERTISING')?.confidence, 'HIGH')
  })
  it('recommendations are sorted by priority and never duplicated', () => {
    const r = run([product()], [campaign()], [term(), term()])
    const keys = r.items.map((i) => `${i.rule_code}|${i.entity_key}`)
    assert.equal(new Set(keys).size, keys.length)
    for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].priority >= r.items[i].priority)
  })
})
