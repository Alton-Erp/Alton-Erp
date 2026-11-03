/**
 * Rule-based recommendation engine. Every recommendation carries the evidence,
 * the financial calculation, a confidence level and what is missing. Rules are
 * deliberately conservative: minimum clicks / orders, attribution lag and data
 * completeness are checked before any bid, budget or pause suggestion.
 * Nothing here is executed: a recommendation can only become an ad change
 * request, which needs a second person's approval.
 */
import type { AmazonSettings, CampaignAnalysis, ProductAnalysis, SearchTermRow } from './analysis.ts'
import { acos, costPerOrder, ctr, type Num } from './metrics.ts'

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH'
export type Impact = 'INCREASE_CONTRIBUTION' | 'REDUCE_WASTE' | 'PROTECT_STOCK' | 'GROW_SALES' | 'IMPROVE_DATA' | 'NONE'

export interface SuggestedChange {
  change_type: 'CAMPAIGN_BUDGET' | 'CAMPAIGN_STATE' | 'TARGET_BID' | 'NEGATIVE_KEYWORD'
  campaign_id: string
  target_id?: string
  ad_group_id?: string
  daily_budget?: number
  bid?: number
  keyword?: string
  match_type?: string
  state?: string
}

export interface Recommendation {
  rule_code: string
  entity_type: 'PRODUCT' | 'CAMPAIGN' | 'TARGET' | 'SEARCH_TERM' | 'ACCOUNT'
  entity_key: string
  entity_label: string
  period_from: string
  period_to: string
  title: string
  issue: string
  proposed_action: string
  evidence: Record<string, string | number | boolean | null>
  financial: { calculation: string; amount?: number | null }
  impact_direction: Impact
  confidence: Confidence
  missing_info: string[]
  inventory_impact: string | null
  priority: number
  change?: SuggestedChange
}

export interface EngineInput {
  from: string
  to: string
  today: string
  settings: AmazonSettings
  products: ProductAnalysis[]
  campaigns: CampaignAnalysis[]
  searchTerms: SearchTermRow[]
  dataStatus: { sales_days: number; fee_days: number; campaign_days: number; search_term_days: number; period_days: number; listings: number; mapped_listings: number }
  demo: boolean
}

const WEIGHT: Record<Confidence, number> = { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 }
const money = (v: Num) => (v === null ? 'n/a' : `Rs ${Math.round(v).toLocaleString('en-IN')}`)
const p1 = (v: Num) => (v === null ? 'n/a' : `${Math.round(v * 10) / 10}%`)
const r2 = (v: number) => Math.round(v * 100) / 100
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

export type TermAction = 'NEGATIVE_FOR_REVIEW' | 'HARVEST_EXACT' | 'REDUCE_BID' | 'NEEDS_MORE_DATA' | 'PERFORMING' | 'MONITOR'

/** Suggested action for one search term, with the evidence threshold used (same rules as the engine). */
export function classifySearchTerm(t: SearchTermRow, targetAcos: Num, s: AmazonSettings): { action: TermAction; confidence: Confidence; evidence: string } {
  const minClicks = s.min_clicks_for_decision
  const conf: Confidence = t.clicks >= minClicks * 3 ? 'HIGH' : t.clicks >= minClicks ? 'MEDIUM' : 'LOW'
  const termAcos = acos(t.spend, t.sales)
  if (t.orders === 0 && t.clicks >= minClicks && t.spend >= s.wasted_spend_threshold && !t.negative_exists)
    return { action: 'NEGATIVE_FOR_REVIEW', confidence: conf, evidence: `${t.clicks} clicks, ${t.spend.toFixed(0)} spent, no orders` }
  if (t.orders >= 2 && t.match_type !== 'EXACT' && !t.exact_exists && termAcos !== null && targetAcos !== null && termAcos <= targetAcos)
    return { action: 'HARVEST_EXACT', confidence: t.orders >= 5 ? 'MEDIUM' : 'LOW', evidence: `${t.orders} orders at ACoS ${termAcos.toFixed(1)}% (target ${targetAcos.toFixed(1)}%)` }
  if (t.orders > 0 && termAcos !== null && targetAcos !== null && termAcos > targetAcos * 1.15 && t.clicks >= minClicks)
    return { action: 'REDUCE_BID', confidence: conf, evidence: `ACoS ${termAcos.toFixed(1)}% above target ${targetAcos.toFixed(1)}%` }
  if (t.clicks < minClicks) return { action: 'NEEDS_MORE_DATA', confidence: 'LOW', evidence: `${t.clicks} of ${minClicks} clicks needed for a decision` }
  if (t.orders > 0 && termAcos !== null && targetAcos !== null && termAcos <= targetAcos) return { action: 'PERFORMING', confidence: conf, evidence: `ACoS ${termAcos.toFixed(1)}% within target` }
  return { action: 'MONITOR', confidence: conf, evidence: targetAcos === null ? 'Target ACoS unknown (costs incomplete)' : 'No clear signal' }
}

export function generateRecommendations(input: EngineInput): { items: Recommendation[]; warnings: string[] } {
  const { settings: s, from, to } = input
  const minClicks = s.min_clicks_for_decision
  const out: Recommendation[] = []
  const warnings: string[] = []
  const base = { period_from: from, period_to: to }
  const lagDays = Math.min(s.attribution_window_days, 3)
  const recent = daysBetween(to, input.today) < lagDays
  if (recent) warnings.push(`The period ends within ${lagDays} day(s) of today: recent orders may still be attributed to ads, so ACoS for the last days can fall. Ad pause and bid-cut suggestions are marked lower confidence.`)
  const ds = input.dataStatus
  const adsWithoutSales = ds.campaign_days > 0 && ds.sales_days < ds.campaign_days
  if (adsWithoutSales) warnings.push(`Advertising data covers ${ds.campaign_days} day(s) but sales data only ${ds.sales_days}: TACoS and contribution are incomplete for the missing days.`)
  const lower = (c: Confidence): Confidence => (recent ? (c === 'HIGH' ? 'MEDIUM' : 'LOW') : c)
  const confByClicks = (clicks: number): Confidence => (clicks >= minClicks * 3 ? 'HIGH' : clicks >= minClicks ? 'MEDIUM' : 'LOW')

  if (adsWithoutSales || ds.sales_days < ds.period_days) {
    out.push({ ...base, rule_code: 'INCOMPLETE_REPORTS', entity_type: 'ACCOUNT', entity_key: 'account', entity_label: 'All products', title: 'Reports are incomplete for the period',
      issue: `Sales data: ${ds.sales_days} of ${ds.period_days} day(s); advertising: ${ds.campaign_days}; search terms: ${ds.search_term_days}; settlement fees: ${ds.fee_days}.`,
      proposed_action: 'Synchronise or import the missing reports before acting on profitability recommendations.', evidence: { ...ds }, financial: { calculation: 'Not applicable' },
      impact_direction: 'IMPROVE_DATA', confidence: 'HIGH', missing_info: ['complete daily reports'], inventory_impact: null, priority: 1e6 })
  }
  const unmapped = input.products.filter((p) => !p.row.product_id && p.row.data_source !== 'DEMO' && (p.orderedSales ?? 0) > 0)
  if (unmapped.length) {
    out.push({ ...base, rule_code: 'UNMAPPED_LISTINGS', entity_type: 'ACCOUNT', entity_key: 'unmapped', entity_label: `${unmapped.length} listing(s)`, title: 'Listings with sales are not mapped to ERP products',
      issue: `${unmapped.map((p) => p.sku).slice(0, 10).join(', ')}${unmapped.length > 10 ? '...' : ''} have sales but no ERP product, so ERP cost, GST rate and warehouse stock cannot be used.`,
      proposed_action: 'Map them in Profitability Analysis > Mapping & costs (or enter costs on the listing).', evidence: { listings: unmapped.length },
      financial: { calculation: 'Sales without cost data', amount: r2(unmapped.reduce((x, p) => x + (p.orderedSales ?? 0), 0)) }, impact_direction: 'IMPROVE_DATA', confidence: 'HIGH',
      missing_info: ['product mapping'], inventory_impact: null, priority: 9e5 })
  }

  // ---- Products
  for (const p of input.products) {
    const key = p.sku
    const ev = { units: p.units, ordered_sales: p.orderedSales, ad_spend: r2(p.ads.spend), ad_sales: r2(p.ads.sales), acos: p.ads.acos === null ? null : r2(p.ads.acos),
      break_even_acos: p.targets.breakEvenAcos, target_acos: p.targets.targetAcos, contribution_after_ads: p.contribution.afterAds, stock_cover_days: p.stockCover }
    if (p.contribution.missing.length && ((p.orderedSales ?? 0) > 0 || p.ads.spend > 0)) {
      out.push({ ...base, rule_code: 'MISSING_COST_DATA', entity_type: 'PRODUCT', entity_key: key, entity_label: p.label, title: `Complete cost data for ${p.sku}`,
        issue: `Contribution cannot be calculated: ${p.contribution.missing.join('; ')}.`, proposed_action: 'Enter the missing values in Profitability Analysis > Mapping & costs or map the ERP product.',
        evidence: ev, financial: { calculation: 'Sales whose profitability is unknown', amount: p.orderedSales }, impact_direction: 'IMPROVE_DATA', confidence: 'HIGH',
        missing_info: p.contribution.missing, inventory_impact: null, priority: 5e5 + (p.orderedSales ?? 0) / 100 })
    }
    if (p.ads.spend > 0 && (p.stockStatus === 'STOCKOUT_RISK' || p.stockStatus === 'LOW')) {
      out.push({ ...base, rule_code: 'STOCKOUT_RISK_WITH_ADS', entity_type: 'PRODUCT', entity_key: key, entity_label: p.label, title: `Low stock on an advertised product: ${p.sku}`,
        issue: `${p.stockForCover ?? 0} unit(s) available (${p.stockSource === 'AMAZON' ? 'Amazon fulfillable' : 'ERP warehouse'}) = ${p.stockCover ?? 'n/a'} day(s) of cover at ${p.avgDailyUnits === null ? 'n/a' : r2(p.avgDailyUnits)}/day, while advertising spends ${money(p.ads.spend)} in the period.`,
        proposed_action: 'Reduce or pause advertising for this product until stock is replenished, and raise replenishment.', evidence: ev,
        financial: { calculation: 'Ad spend at risk of driving traffic to an out-of-stock listing', amount: r2(p.ads.spend) }, impact_direction: 'PROTECT_STOCK', confidence: p.stockSource === 'NONE' ? 'LOW' : 'HIGH',
        missing_info: p.row.lead_time_days === null ? ['lead time (replenishment quantity)'] : [], inventory_impact: 'Advertising more would bring forward the stockout.', priority: 4e5 + p.ads.spend })
    }
    if (p.contribution.afterAds !== null && p.contribution.afterAds < 0 && p.ads.spend > 0 && p.ads.clicks >= minClicks) {
      const loss = -p.contribution.afterAds
      out.push({ ...base, rule_code: 'UNPROFITABLE_ADVERTISING', entity_type: 'PRODUCT', entity_key: key, entity_label: p.label, title: `Advertising makes ${p.sku} loss-making`,
        issue: `Contribution before advertising ${money(p.contribution.beforeAds)} minus ad spend ${money(p.ads.spend)} = ${money(p.contribution.afterAds)}. ACoS ${p1(p.ads.acos)} vs break-even ${p1(p.targets.breakEvenAcos)}.`,
        proposed_action: p.affordable.maxCpc !== null ? `Lower bids towards the maximum affordable CPC of ${money(p.affordable.maxCpc)} (current CPC ${money(p.ads.cpc)}).` : 'Lower bids or budgets for this product and review non-converting targets.',
        evidence: ev, financial: { calculation: `Contribution after advertising = ${money(p.contribution.beforeAds)} - ${money(p.ads.spend)}`, amount: r2(loss) },
        impact_direction: 'INCREASE_CONTRIBUTION', confidence: lower(confByClicks(p.ads.clicks)), missing_info: [], inventory_impact: null, priority: loss * WEIGHT[lower(confByClicks(p.ads.clicks))] })
    }
    if (p.ads.orders >= s.min_orders_for_scaling && p.ads.acos !== null && p.targets.targetAcos !== null && p.ads.acos < p.targets.targetAcos && p.stockStatus !== 'STOCKOUT_RISK' && p.stockStatus !== 'LOW') {
      const headroom = ((p.targets.targetAcos - p.ads.acos) / 100) * p.ads.sales
      out.push({ ...base, rule_code: 'SCALE_PROFITABLE_PRODUCT', entity_type: 'PRODUCT', entity_key: key, entity_label: p.label, title: `${p.sku} advertises below its target ACoS`,
        issue: `ACoS ${p1(p.ads.acos)} is below the target ${p1(p.targets.targetAcos)} with ${p.ads.orders} attributed order(s).`,
        proposed_action: 'Consider a cautious budget increase (10-20%) for campaigns advertising this product, then review after 7-14 days. Use the Budget Planner to size it.',
        evidence: ev, financial: { calculation: 'Room before reaching the target ACoS at current attributed sales', amount: r2(headroom) }, impact_direction: 'GROW_SALES',
        confidence: p.stockStatus === 'UNKNOWN' ? 'LOW' : lower(p.ads.orders >= s.min_orders_for_scaling * 3 ? 'HIGH' : 'MEDIUM'),
        missing_info: p.stockStatus === 'UNKNOWN' ? ['stock level'] : [], inventory_impact: p.stockCover === null ? 'Stock cover unknown.' : `Stock cover ${p.stockCover} day(s).`,
        priority: headroom * WEIGHT[lower('MEDIUM')] })
    }
    if (p.stockStatus === 'OVERSTOCK' && p.ads.spend === 0 && (p.contribution.beforeAds ?? 0) > 0) {
      out.push({ ...base, rule_code: 'OVERSTOCK_NOT_ADVERTISED', entity_type: 'PRODUCT', entity_key: key, entity_label: p.label, title: `${p.sku} is overstocked and not advertised`,
        issue: `${p.stockCover} day(s) of stock cover and positive contribution before advertising (${money(p.contribution.beforeAds)}).`,
        proposed_action: 'Consider a small test campaign with a budget sized to stay below break-even ACoS.', evidence: ev,
        financial: { calculation: 'Break-even ACoS available for advertising', amount: p.targets.breakEvenAcos }, impact_direction: 'GROW_SALES', confidence: 'LOW', missing_info: ['advertising history'],
        inventory_impact: 'Reduces excess stock.', priority: 1000 })
    }
  }
  const sessionsTotal = input.products.reduce((x, p) => x + (p.sessions ?? 0), 0)
  const unitsTotal = input.products.reduce((x, p) => x + p.units, 0)
  const accountCvr = sessionsTotal > 0 ? (unitsTotal / sessionsTotal) * 100 : null
  for (const p of input.products) {
    if (accountCvr !== null && (p.sessions ?? 0) >= 300 && p.sessionConversion !== null && p.sessionConversion < accountCvr * 0.5) {
      out.push({ ...base, rule_code: 'LOW_LISTING_CONVERSION', entity_type: 'PRODUCT', entity_key: p.sku, entity_label: p.label, title: `Low listing conversion: ${p.sku}`,
        issue: `Unit session percentage ${p1(p.sessionConversion)} vs ${p1(accountCvr)} across all listings (${p.sessions} sessions).`,
        proposed_action: 'Review price, images, title, reviews and availability before adding advertising.', evidence: { sessions: p.sessions, units: p.units },
        financial: { calculation: 'Not quantified' }, impact_direction: 'GROW_SALES', confidence: 'MEDIUM', missing_info: [], inventory_impact: null, priority: 500 })
    }
  }

  // ---- Campaigns
  for (const c of input.campaigns) {
    const row = c.row
    const ev = { spend: r2(row.spend), sales: r2(row.sales), orders: row.orders, clicks: row.clicks, impressions: row.impressions, acos: c.acos === null ? null : r2(c.acos),
      break_even_acos: c.breakEvenAcos, target_acos: c.targetAcos, budget_constrained_days: row.budget_constrained_days, days: row.days_with_data }
    if ((c.constrainedShare ?? 0) >= 30 && c.acos !== null && c.targetAcos !== null && c.acos < c.targetAcos && row.orders >= s.min_orders_for_scaling && row.daily_budget) {
      const pctUp = Math.min(20, s.max_budget_change_pct)
      const newBudget = r2(row.daily_budget * (1 + pctUp / 100))
      const stockNote = c.lowStockProducts.length ? `Low stock: ${c.lowStockProducts.join(', ')} - do not increase until restocked.` : 'Advertised products have adequate stock.'
      if (!c.lowStockProducts.length) {
        out.push({ ...base, rule_code: 'BUDGET_CONSTRAINED_PROFITABLE', entity_type: 'CAMPAIGN', entity_key: row.campaign_id, entity_label: row.name, title: `Profitable campaign limited by budget: ${row.name}`,
          issue: `Spend reached the daily budget on ${row.budget_constrained_days} of ${row.days_with_data} day(s) while ACoS ${p1(c.acos)} is below the target ${p1(c.targetAcos)}.`,
          proposed_action: `Increase the daily budget cautiously from ${money(row.daily_budget)} to ${money(newBudget)} (+${pctUp}%) and review after 7-14 days.`,
          evidence: ev, financial: { calculation: `Extra spend up to ${money((newBudget - row.daily_budget) * 30)} per month at ACoS below target` , amount: r2((newBudget - row.daily_budget) * 30) },
          impact_direction: 'GROW_SALES', confidence: lower(row.orders >= s.min_orders_for_scaling * 3 ? 'HIGH' : 'MEDIUM'), missing_info: [], inventory_impact: stockNote,
          priority: (newBudget - row.daily_budget) * 30 * ((c.targetAcos - c.acos) / 100 + 0.1),
          change: { change_type: 'CAMPAIGN_BUDGET', campaign_id: row.campaign_id, daily_budget: newBudget } })
      }
    }
    const cpo = costPerOrder(row.spend, row.orders)
    if (row.clicks >= minClicks && cpo !== null && c.allowedCostPerOrder !== null && cpo > c.allowedCostPerOrder * 1.1) {
      out.push({ ...base, rule_code: 'HIGH_COST_PER_ORDER', entity_type: 'CAMPAIGN', entity_key: row.campaign_id, entity_label: row.name, title: `Cost per order too high: ${row.name}`,
        issue: `Cost per attributed order ${money(cpo)} exceeds the allowed ${money(c.allowedCostPerOrder)} (target ACoS ${p1(c.targetAcos)} x average order ${money(c.avgOrderValue)}).`,
        proposed_action: 'Reduce bids on the targets with the highest cost per order (see Keyword Intelligence), rather than cutting the whole campaign.',
        evidence: ev, financial: { calculation: `(${money(cpo)} - ${money(c.allowedCostPerOrder)}) x ${row.orders} orders`, amount: r2((cpo - c.allowedCostPerOrder) * row.orders) },
        impact_direction: 'INCREASE_CONTRIBUTION', confidence: lower(confByClicks(row.clicks)), missing_info: [], inventory_impact: null,
        priority: (cpo - c.allowedCostPerOrder) * row.orders * WEIGHT[lower(confByClicks(row.clicks))] })
    }
    const campaignCtr = ctr(row.clicks, row.impressions)
    if (row.impressions >= 5000 && campaignCtr !== null && campaignCtr < 0.2) {
      out.push({ ...base, rule_code: 'LOW_CTR', entity_type: 'CAMPAIGN', entity_key: row.campaign_id, entity_label: row.name, title: `High impressions, weak CTR: ${row.name}`,
        issue: `CTR ${p1(campaignCtr)} on ${row.impressions.toLocaleString('en-IN')} impressions.`, proposed_action: 'Review targeting relevance, main image, price and title for the advertised products.',
        evidence: ev, financial: { calculation: 'Not quantified' }, impact_direction: 'GROW_SALES', confidence: 'MEDIUM', missing_info: [], inventory_impact: null, priority: 300 })
    }
    if (row.clicks >= minClicks * 2 && row.orders === 0) {
      out.push({ ...base, rule_code: 'CLICKS_NO_CONVERSION', entity_type: 'CAMPAIGN', entity_key: row.campaign_id, entity_label: row.name, title: `Clicks without orders: ${row.name}`,
        issue: `${row.clicks} clicks and ${money(row.spend)} spend with no attributed orders.`,
        proposed_action: recent ? 'Wait for the attribution window to close, then review search terms and the product page.' : 'Review search terms for irrelevant traffic and the product page (price, availability, reviews).',
        evidence: ev, financial: { calculation: 'Spend without attributed sales', amount: r2(row.spend) }, impact_direction: 'REDUCE_WASTE', confidence: lower(confByClicks(row.clicks)),
        missing_info: [], inventory_impact: null, priority: row.spend * WEIGHT[lower(confByClicks(row.clicks))] })
    }
  }

  // ---- Search terms
  for (const t of input.searchTerms) {
    const key = `${t.campaign_id}|${t.ad_group_id}|${t.targeting}|${t.match_type ?? ''}|${t.search_term}`
    const ev = { campaign: t.campaign_name, targeting: t.targeting, match_type: t.match_type, clicks: t.clicks, spend: r2(t.spend), orders: t.orders, sales: r2(t.sales), days: t.days }
    if (t.orders === 0 && t.spend >= s.wasted_spend_threshold && t.clicks >= minClicks && !t.negative_exists) {
      const conf = lower(confByClicks(t.clicks))
      out.push({ ...base, rule_code: 'WASTED_SEARCH_TERM', entity_type: 'SEARCH_TERM', entity_key: key, entity_label: `"${t.search_term}" in ${t.campaign_name ?? t.campaign_id}`,
        title: `Search term spending without orders: "${t.search_term}"`, issue: `${money(t.spend)} on ${t.clicks} clicks with no attributed order.`,
        proposed_action: 'Review relevance; if it is not relevant to the product, add it as a negative exact keyword in this campaign.',
        evidence: ev, financial: { calculation: 'Spend without attributed sales in the period', amount: r2(t.spend) }, impact_direction: 'REDUCE_WASTE', confidence: conf, missing_info: [], inventory_impact: null,
        priority: t.spend * WEIGHT[conf], change: { change_type: 'NEGATIVE_KEYWORD', campaign_id: t.campaign_id, ad_group_id: t.ad_group_id, keyword: t.search_term, match_type: 'NEGATIVE_EXACT' } })
    }
    const termAcos = acos(t.spend, t.sales)
    const product = input.products.find((p) => p.sku === t.seller_sku)
    const target = product?.targets.targetAcos ?? null
    if (t.orders >= 2 && t.match_type !== 'EXACT' && !t.exact_exists && termAcos !== null && target !== null && termAcos <= target) {
      out.push({ ...base, rule_code: 'HARVEST_EXACT_KEYWORD', entity_type: 'SEARCH_TERM', entity_key: key, entity_label: `"${t.search_term}"`, title: `Converting search term to add as exact: "${t.search_term}"`,
        issue: `${t.orders} order(s) at ACoS ${p1(termAcos)} (target ${p1(target)}) from ${t.match_type ?? 'automatic'} targeting in ${t.campaign_name ?? t.campaign_id}.`,
        proposed_action: 'Add it as an exact-match keyword in a manual campaign (and consider it as a negative exact in the source campaign to avoid self-competition).',
        evidence: ev, financial: { calculation: 'Attributed sales from this search term', amount: r2(t.sales) }, impact_direction: 'GROW_SALES', confidence: t.orders >= 5 ? 'MEDIUM' : 'LOW',
        missing_info: [], inventory_impact: product?.stockStatus === 'STOCKOUT_RISK' ? 'Product stock is low.' : null, priority: t.sales * 0.05 })
    }
    if (t.target_id && t.bid && t.clicks >= minClicks && t.orders > 0 && product && product.targets.targetAcos !== null && t.match_type === 'EXACT') {
      const aov = t.sales / t.orders
      const allowedCpo = (product.targets.targetAcos / 100) * aov
      const cpoT = t.spend / t.orders
      if (cpoT > allowedCpo * 1.15) {
        const newBid = r2(Math.max(0.01, t.bid * Math.max(1 - s.max_bid_change_pct / 100, allowedCpo / cpoT)))
        const conf = lower(confByClicks(t.clicks))
        out.push({ ...base, rule_code: 'REDUCE_TARGET_BID', entity_type: 'TARGET', entity_key: `${t.campaign_id}|${t.target_id}`, entity_label: `${t.targeting} (${t.match_type})`,
          title: `Lower the bid on "${t.targeting}"`, issue: `Cost per order ${money(cpoT)} vs allowed ${money(allowedCpo)} at the target ACoS ${p1(product.targets.targetAcos)}.`,
          proposed_action: `Reduce the bid from ${money(t.bid)} to ${money(newBid)} and review after 7-14 days.`, evidence: { ...ev, bid: t.bid },
          financial: { calculation: `(${money(cpoT)} - ${money(allowedCpo)}) x ${t.orders} orders`, amount: r2((cpoT - allowedCpo) * t.orders) }, impact_direction: 'INCREASE_CONTRIBUTION',
          confidence: conf, missing_info: [], inventory_impact: null, priority: (cpoT - allowedCpo) * t.orders * WEIGHT[conf],
          change: { change_type: 'TARGET_BID', campaign_id: t.campaign_id, target_id: t.target_id, bid: newBid } })
      }
    }
  }

  // De-duplicate target bids (search-term rows share a target) and sort by priority.
  const seen = new Set<string>()
  const items = out.filter((r) => {
    const k = `${r.rule_code}|${r.entity_key}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).sort((a, b) => b.priority - a.priority).map((r) => ({ ...r, priority: r2(r.priority) }))
  return { items, warnings }
}
