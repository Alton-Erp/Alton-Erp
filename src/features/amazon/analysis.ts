/**
 * Turns the database rows (amazon_product_performance, amazon_campaign_performance,
 * amazon_search_terms) into analysed objects using the single set of formulas in
 * metrics.ts. Used by every page, the budget planner and the recommendation engine.
 */
import {
  acos, acosTargets, adConversion, affordableCpc, contribution, costPerOrder, cpc, ctr, mean, n, ratio, roas, sessionConversion, stockCoverDays, sumComponents, tacos,
  type AcosTargets, type AffordableCpc, type Components, type Contribution, type Num,
} from './metrics.ts'

export interface AmazonSettings {
  prices_include_gst: boolean
  attribution_window_days: number
  min_clicks_for_decision: number
  min_orders_for_scaling: number
  wasted_spend_threshold: number
  low_stock_cover_days: number
  overstock_cover_days: number
  target_contribution_pct: number
  overhead_allocation_pct: number
  automation_mode: 'READ_ONLY' | 'APPROVAL_REQUIRED'
  kill_switch: boolean
  max_daily_budget: number | null
  max_monthly_budget: number | null
  max_bid: number | null
  max_bid_change_pct: number
  max_budget_change_pct: number
}

export interface ProductRow {
  seller_sku: string
  listing_id: string | null
  asin: string | null
  title: string | null
  marketplace_id: string | null
  product_id: string | null
  erp_sku: string | null
  erp_name: string | null
  category: string | null
  item_price: number | null
  fulfillment_channel: string | null
  listing_status: string | null
  advertising_status: string | null
  data_source: string | null
  gst_rate: number | null
  gst_source: 'LISTING' | 'ERP_PRODUCT' | 'MISSING' | null
  unit_cost: number | null
  cost_source: 'LISTING_OVERRIDE' | 'ERP_STANDARD_COST' | 'MISSING'
  costs_updated_at: string | null
  referral_fee_pct: number | null
  closing_fee_per_unit: number | null
  fulfilment_fee_per_unit: number | null
  shipping_cost_per_unit: number | null
  other_variable_cost_per_unit: number | null
  desired_contribution_per_unit: number | null
  target_acos_pct: number | null
  min_stock: number | null
  lead_time_days: number | null
  totals: (Components & { page_views?: number; sales_days?: number; ad_units?: number }) | null
  stock: { erp_available: number | null; erp_as_of: string | null; amazon_fulfillable: number | null; amazon_inbound: number | null; amazon_as_of: string | null; amazon_source: string | null; incoming_production: number | null }
  velocity: { units_7: number; units_28: number; units_56: number; days_with_data_28: number; daily_28: number[] } | null
  campaigns: string[]
}

export interface ProductAnalysis {
  row: ProductRow
  sku: string
  label: string
  units: number
  orderedSales: Num
  sessions: Num
  sessionConversion: Num
  contribution: Contribution
  ads: { spend: number; sales: number; orders: number; clicks: number; impressions: number; acos: Num; roas: Num; tacos: Num; ctr: Num; cpc: Num; conversion: Num; costPerOrder: Num }
  targets: AcosTargets
  affordable: AffordableCpc
  avgOrderValue: Num
  avgDailyUnits: Num
  /** Sellable stock used for cover: Amazon fulfillable (FBA) if known, otherwise ERP available. */
  stockForCover: Num
  stockSource: 'AMAZON' | 'ERP' | 'NONE'
  stockCover: Num
  stockStatus: 'STOCKOUT_RISK' | 'LOW' | 'OK' | 'OVERSTOCK' | 'UNKNOWN'
  costsOutdated: boolean
  profitStatus: 'PROFITABLE' | 'BELOW_TARGET' | 'LOSS' | 'UNKNOWN'
  issues: string[]
}

const COST_STALE_DAYS = 180

export function analyseProduct(row: ProductRow, s: AmazonSettings, today: string): ProductAnalysis {
  const t: Components = row.totals ?? {}
  const units = n(t.units) ?? 0
  const orderedSales = n(t.ordered_sales)
  const c = contribution(t, { overheadPct: s.overhead_allocation_pct })
  const spend = n(t.ad_spend) ?? 0
  const adSales = n(t.ad_sales) ?? 0
  const orders = n(t.ad_orders) ?? 0
  const clicks = n(t.ad_clicks) ?? 0
  const impressions = n(t.ad_impressions) ?? 0
  const targets = acosTargets({ beforeAds: c.beforeAds, reportedSales: orderedSales, units, desiredPerUnit: row.desired_contribution_per_unit,
    companyTargetPct: s.target_contribution_pct, listingTargetAcos: row.target_acos_pct })
  const avgOrderValue = ratio(adSales, orders) ?? ratio(orderedSales, units)
  const affordable = affordableCpc({ targetAcos: targets.targetAcos, avgOrderValue, clicks, orders, minClicks: s.min_clicks_for_decision })
  const daily = row.velocity?.daily_28 ?? []
  const avgDailyUnits = daily.length ? mean(daily) : null
  const amazonStock = n(row.stock?.amazon_fulfillable)
  const erpStock = n(row.stock?.erp_available)
  const stockForCover = amazonStock ?? erpStock
  const stockSource = amazonStock !== null ? 'AMAZON' : erpStock !== null ? 'ERP' : 'NONE'
  const cover = stockCoverDays(stockForCover, avgDailyUnits)
  const lowLimit = Math.max(s.low_stock_cover_days, row.lead_time_days ?? 0)
  const stockStatus: ProductAnalysis['stockStatus'] = stockForCover === null ? 'UNKNOWN' : stockForCover <= 0 ? 'STOCKOUT_RISK'
    : cover === null ? 'OK' : cover < s.low_stock_cover_days ? 'STOCKOUT_RISK' : cover < lowLimit ? 'LOW' : cover > s.overstock_cover_days ? 'OVERSTOCK' : 'OK'
  const costsOutdated = row.cost_source === 'LISTING_OVERRIDE' && (!row.costs_updated_at || (Date.parse(today) - Date.parse(row.costs_updated_at)) / 86400000 > COST_STALE_DAYS)
  const profitStatus: ProductAnalysis['profitStatus'] = c.afterAds === null ? 'UNKNOWN' : c.afterAds < 0 ? 'LOSS'
    : targets.targetAcos !== null && spend > 0 && (acos(spend, adSales) ?? Infinity) > targets.targetAcos ? 'BELOW_TARGET' : 'PROFITABLE'
  const issues = [...c.missing.map((m) => `Missing: ${m}`)]
  if (!row.product_id && row.data_source !== 'DEMO') issues.push('Not mapped to an ERP product')
  if (costsOutdated) issues.push(`Cost override older than ${COST_STALE_DAYS} days`)
  if (row.gst_source === 'MISSING') issues.push('No GST rate')
  return {
    row, sku: row.seller_sku, label: row.title ?? row.erp_name ?? row.seller_sku, units, orderedSales, sessions: n(t.sessions), sessionConversion: sessionConversion(units, t.sessions),
    contribution: c,
    ads: { spend, sales: adSales, orders, clicks, impressions, acos: acos(spend, adSales), roas: roas(adSales, spend), tacos: tacos(spend, orderedSales), ctr: ctr(clicks, impressions),
      cpc: cpc(spend, clicks), conversion: adConversion(orders, clicks), costPerOrder: costPerOrder(spend, orders) },
    targets, affordable, avgOrderValue, avgDailyUnits, stockForCover, stockSource, stockCover: cover, stockStatus, costsOutdated, profitStatus, issues,
  }
}

export interface CampaignRow {
  campaign_id: string
  profile_id: string
  name: string
  ad_product: string
  targeting_type: string | null
  state: string
  daily_budget: number | null
  data_source: string
  last_synced_at: string | null
  impressions: number
  clicks: number
  spend: number
  sales: number
  orders: number
  units: number
  days_with_data: number
  budget_total: number | null
  budget_constrained_days: number
  zero_order_target_spend: number
  products: string[]
}

export interface CampaignAnalysis {
  row: CampaignRow
  acos: Num; roas: Num; ctr: Num; cpc: Num; conversion: Num; costPerOrder: Num
  budgetUtilisation: Num
  constrainedShare: Num
  /** Spend-weighted break-even and target ACoS of the advertised products (null if their costs are incomplete). */
  breakEvenAcos: Num
  targetAcos: Num
  avgOrderValue: Num
  allowedCostPerOrder: Num
  lowStockProducts: string[]
}

export function analyseCampaign(row: CampaignRow, products: Map<string, ProductAnalysis>): CampaignAnalysis {
  const prods = row.products.map((sku) => products.get(sku)).filter((p): p is ProductAnalysis => Boolean(p))
  const weight = (p: ProductAnalysis) => Math.max(p.ads.spend, 1)
  const weighted = (pick: (p: ProductAnalysis) => Num): Num => {
    if (!prods.length || prods.some((p) => pick(p) === null)) return null
    const w = prods.reduce((s, p) => s + weight(p), 0)
    return prods.reduce((s, p) => s + (pick(p) as number) * weight(p), 0) / w
  }
  const be = weighted((p) => p.targets.breakEvenAcos)
  const target = weighted((p) => p.targets.targetAcos)
  const aov = ratio(row.sales, row.orders)
  return {
    row, acos: acos(row.spend, row.sales), roas: roas(row.sales, row.spend), ctr: ctr(row.clicks, row.impressions), cpc: cpc(row.spend, row.clicks),
    conversion: adConversion(row.orders, row.clicks), costPerOrder: costPerOrder(row.spend, row.orders),
    budgetUtilisation: ratio(row.spend, row.budget_total) === null ? null : ratio(row.spend, row.budget_total)! * 100,
    constrainedShare: ratio(row.budget_constrained_days, row.days_with_data) === null ? null : ratio(row.budget_constrained_days, row.days_with_data)! * 100,
    breakEvenAcos: be === null ? null : Math.round(be * 100) / 100, targetAcos: target === null ? null : Math.round(target * 100) / 100,
    avgOrderValue: aov, allowedCostPerOrder: target === null || aov === null ? null : (target / 100) * aov,
    lowStockProducts: prods.filter((p) => p.stockStatus === 'STOCKOUT_RISK' || p.stockStatus === 'LOW').map((p) => p.sku),
  }
}

export interface SearchTermRow {
  campaign_id: string; campaign_name: string | null; targeting_type: string | null; ad_group_id: string; ad_group_name: string | null
  targeting: string; match_type: string | null; search_term: string; target_id: string | null; bid: number | null
  impressions: number; clicks: number; spend: number; sales: number; orders: number; units: number; days: number
  asin: string | null; seller_sku: string | null; exact_exists: boolean; negative_exists: boolean
}

export function totalsOf(list: ProductAnalysis[]) {
  const c = sumComponents(list.map((p) => p.row.totals ?? {}))
  return c
}

export const fmtPct = (v: Num, dp = 1) => (v === null ? null : `${v.toLocaleString('en-IN', { maximumFractionDigits: dp })}%`)
export const fmtRatio = (v: Num) => (v === null ? null : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }))
