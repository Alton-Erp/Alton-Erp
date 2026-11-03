import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toAllocItem } from '../../src/features/amazon/allocator.ts'
import { analyseProduct, type AmazonSettings, type ProductRow, type SearchTermRow } from '../../src/features/amazon/analysis.ts'
import { classifySearchTerm } from '../../src/features/amazon/recommendations.ts'
import { stableUuid } from '../../src/features/amazon/request-id.ts'

const settings: AmazonSettings = {
  prices_include_gst: true, attribution_window_days: 7, min_clicks_for_decision: 20, min_orders_for_scaling: 3, wasted_spend_threshold: 500, low_stock_cover_days: 14,
  overstock_cover_days: 120, target_contribution_pct: 10, overhead_allocation_pct: 0, automation_mode: 'READ_ONLY', kill_switch: true, max_daily_budget: null,
  max_monthly_budget: null, max_bid: null, max_bid_change_pct: 30, max_budget_change_pct: 30,
}
const term = (over: Partial<SearchTermRow> = {}): SearchTermRow => ({
  campaign_id: 'C1', campaign_name: 'C1', targeting_type: 'MANUAL', ad_group_id: 'AG', ad_group_name: 'AG', targeting: 'basin', match_type: 'BROAD', search_term: 'white basin',
  target_id: 'T1', bid: 10, impressions: 1000, clicks: 30, spend: 600, sales: 0, orders: 0, units: 0, days: 10, asin: null, seller_sku: 'S1', exact_exists: false, negative_exists: false, ...over,
})

describe('search-term classification (keyword intelligence page)', () => {
  it('flags spend without orders above the thresholds for negative review', () => {
    assert.equal(classifySearchTerm(term(), 20, settings).action, 'NEGATIVE_FOR_REVIEW')
  })
  it('does not suggest a negative that already exists, nor judge terms with too few clicks', () => {
    assert.notEqual(classifySearchTerm(term({ negative_exists: true }), 20, settings).action, 'NEGATIVE_FOR_REVIEW')
    const few = classifySearchTerm(term({ clicks: 5, spend: 50 }), 20, settings)
    assert.equal(few.action, 'NEEDS_MORE_DATA')
    assert.equal(few.confidence, 'LOW')
  })
  it('harvests converting broad terms within target ACoS as exact keywords, unless already exact', () => {
    assert.equal(classifySearchTerm(term({ orders: 3, sales: 6000, spend: 600 }), 20, settings).action, 'HARVEST_EXACT')
    assert.notEqual(classifySearchTerm(term({ orders: 3, sales: 6000, spend: 600, exact_exists: true }), 20, settings).action, 'HARVEST_EXACT')
  })
  it('suggests a lower bid when ACoS is clearly above target, and never decides without a target', () => {
    assert.equal(classifySearchTerm(term({ orders: 1, sales: 1000, spend: 600, match_type: 'EXACT' }), 20, settings).action, 'REDUCE_BID')
    assert.equal(classifySearchTerm(term({ orders: 1, sales: 1000, spend: 600, match_type: 'EXACT' }), null, settings).action, 'MONITOR')
  })
})

describe('budget planner input mapping', () => {
  it('converts period totals to daily values and carries break-even, stock and CPC limits', () => {
    const row = {
      seller_sku: 'S1', listing_id: 'l', asin: 'B0', title: 'Basin', marketplace_id: 'A21TJRUUN4KGV', product_id: 'p', erp_sku: 'S1', erp_name: 'Basin', category: null, item_price: 2360,
      fulfillment_channel: 'MFN', listing_status: 'Active', advertising_status: null, data_source: 'CSV', gst_rate: 18, gst_source: 'ERP_PRODUCT', unit_cost: 1000,
      cost_source: 'ERP_STANDARD_COST', costs_updated_at: null, referral_fee_pct: null, closing_fee_per_unit: null, fulfilment_fee_per_unit: null, shipping_cost_per_unit: null,
      other_variable_cost_per_unit: null, desired_contribution_per_unit: null, target_acos_pct: null, min_stock: null, lead_time_days: null,
      totals: { ordered_sales: 23600, units: 10, sales_ex_gst: 20000, product_cost: 10000, actual_referral: 2000, actual_fulfilment: 1000, ad_spend: 3000, ad_sales: 11800,
        ad_orders: 5, ad_clicks: 300, ad_impressions: 30000 },
      stock: { erp_available: 40, erp_as_of: null, amazon_fulfillable: null, amazon_inbound: null, amazon_as_of: null, amazon_source: null, incoming_production: null },
      velocity: { units_7: 2, units_28: 10, units_56: 10, days_with_data_28: 10, daily_28: Array(28).fill(10 / 28) }, campaigns: ['C1'],
    } as ProductRow
    const p = analyseProduct(row, settings, '2026-10-13')
    const item = toAllocItem(p, 30, { min: 5 })
    assert.equal(item.dailySpend, 100)
    assert.equal(Math.round(item.dailySales), 393)
    assert.equal(item.breakEvenAcos, p.targets.breakEvenAcos)
    assert.equal(item.contributionPerSale, (p.targets.breakEvenAcos ?? 0) / 100)
    assert.equal(item.stockAvailable, 40)
    assert.equal(item.avgPrice, 2360)
    assert.equal(item.minDaily, 5)
  })
})

describe('request ids for imports and synchronisation', () => {
  it('are deterministic, UUID-shaped and differ per request', async () => {
    const a = await stableUuid('csv:file.csv:100:1:SKU_SALES:0:0')
    assert.equal(a, await stableUuid('csv:file.csv:100:1:SKU_SALES:0:0'))
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(a, await stableUuid('csv:file.csv:100:1:SKU_SALES:0:5000'))
  })
})
