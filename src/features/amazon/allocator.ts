/**
 * Advertising budget allocator: "which products / campaigns should receive the
 * next advertising rupee?"
 *
 * Response model (an assumption, shown to users): attributed sales follow
 * diminishing returns, S(s) = S0 x (s / s0)^b with b = 0.6 by default (sales grow
 * more slowly than spend), calibrated on each item's own history (s0 = current
 * average daily spend, S0 = its attributed sales). Ranges use b = 0.4 and 0.8.
 * Items without spend or with too few clicks get no model: at most their
 * minimum (test) budget, LOW confidence and no forecast.
 *
 * Allocation: budget is added in small steps to the item whose next step has
 * the best marginal return - contribution in PROFIT mode (stops when the
 * marginal ACoS would exceed break-even), attributed sales in GROWTH mode
 * (stops at the target ACoS). Hard caps: item min / max, the total and daily
 * limits, and stock (extra units may not exceed what stock can cover).
 * Unspendable budget is reported as unallocated, never forced out.
 */

import type { ProductAnalysis } from './analysis.ts'

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH'

export interface AllocItem {
  key: string
  label: string
  /** Average daily ad spend and attributed sales / orders over the analysis period. */
  dailySpend: number
  dailySales: number
  /** Period totals used for confidence. */
  clicks: number
  orders: number
  /** Contribution before advertising per rupee of reported sales (= break-even ACoS / 100); null if costs are incomplete. */
  contributionPerSale: number | null
  breakEvenAcos: number | null
  targetAcos: number | null
  /** Average reported price per unit (sales / units). */
  avgPrice: number | null
  /** Units sold per day (all channels) and available stock (null = unknown). */
  avgDailyUnits: number
  stockAvailable: number | null
  minDaily?: number
  maxDaily?: number
  /** Current and maximum affordable CPC (for the bid suggestion). */
  currentCpc?: number | null
  maxCpc?: number | null
}

export interface AllocInputs {
  monthlyBudget: number
  dailyLimit?: number | null
  mode: 'PROFIT' | 'GROWTH'
  daysInMonth?: number
  elasticity?: number
  /** Days of stock that must remain after the month (safety). */
  safetyDays?: number
  minClicks?: number
  maxBidChangePct?: number
  /** Optional minimum contribution after advertising for the month; reported if not met. */
  minContribution?: number | null
}

export interface AllocResult {
  key: string
  label: string
  confidence: Confidence
  modelled: boolean
  currentDaily: number
  proposedDaily: number
  proposedMonthly: number
  changeMonthly: number
  marginalAcos: number | null
  forecast: null | {
    salesMonthly: [number, number, number]
    contributionAfterAdsMonthly: [number, number, number] | null
    extraUnitsPerDay: number
  }
  bidChangePct: number | null
  stockoutRisk: boolean
  stockCoverDays: number | null
  reasons: string[]
}

export interface AllocSummary {
  mode: AllocInputs['mode']
  monthlyBudget: number
  allocatedMonthly: number
  unallocatedMonthly: number
  forecastSalesMonthly: [number, number, number] | null
  forecastContributionMonthly: [number, number, number] | null
  minContributionMet: boolean | null
  items: AllocResult[]
  assumptions: string[]
}

const r2 = (v: number) => Math.round(v * 100) / 100
const confidenceOf = (clicks: number, orders: number, minClicks: number): Confidence =>
  clicks >= Math.max(300, minClicks * 5) && orders >= 15 ? 'HIGH' : clicks >= Math.max(100, minClicks) && orders >= 5 ? 'MEDIUM' : 'LOW'

/** Attributed daily sales at spend s for elasticity b, calibrated on (s0, S0). */
export function salesAt(s: number, s0: number, S0: number, b: number): number {
  if (s <= 0 || s0 <= 0 || S0 <= 0) return 0
  return S0 * Math.pow(s / s0, b)
}
/** Marginal ACoS at spend s (cost of the next rupee of attributed sales), as %. */
export function marginalAcos(s: number, s0: number, S0: number, b: number): number | null {
  if (s0 <= 0 || S0 <= 0) return null
  const ds = 1e-3 * Math.max(1, s)
  const gain = salesAt(s + ds, s0, S0, b) - salesAt(s, s0, S0, b)
  return gain > 0 ? (ds / gain) * 100 : null
}

export function allocateBudget(items: AllocItem[], inputs: AllocInputs): AllocSummary {
  const days = inputs.daysInMonth ?? 30
  const b = inputs.elasticity ?? 0.6
  const safetyDays = inputs.safetyDays ?? 14
  const minClicks = inputs.minClicks ?? 20
  const totalDaily = Math.max(0, inputs.monthlyBudget / days)
  const dailyCap = inputs.dailyLimit && inputs.dailyLimit > 0 ? Math.min(totalDaily, inputs.dailyLimit) : totalDaily

  type State = { item: AllocItem; spend: number; min: number; max: number; modelled: boolean; confidence: Confidence; reasons: string[]; stockCover: number | null; stockout: boolean; maxSpendByStock: number }
  const states: State[] = items.map((item) => {
    const confidence = confidenceOf(item.clicks, item.orders, minClicks)
    const modelled = item.dailySpend > 0 && item.dailySales > 0 && item.clicks >= minClicks
    const reasons: string[] = []
    const min = Math.max(0, item.minDaily ?? 0)
    let max = Math.max(min, item.maxDaily ?? Number.POSITIVE_INFINITY)
    const stockCover = item.stockAvailable !== null && item.avgDailyUnits > 0 ? item.stockAvailable / item.avgDailyUnits : null
    // Stock: extra units per day may not exceed what keeps `safetyDays` of cover after the month.
    let maxSpendByStock = Number.POSITIVE_INFINITY
    let stockout = false
    if (item.stockAvailable !== null) {
      const sellablePerDay = Math.max(0, item.stockAvailable - item.avgDailyUnits * safetyDays) / days
      const extraUnitsAllowed = sellablePerDay - item.avgDailyUnits
      stockout = stockCover !== null && stockCover < days + safetyDays
      if (modelled && item.avgPrice && item.avgPrice > 0) {
        const extraSalesAllowed = Math.max(0, extraUnitsAllowed) * item.avgPrice
        // invert S(s) = S0 (s/s0)^b for S = S0 + extraSalesAllowed
        maxSpendByStock = item.dailySpend * Math.pow((item.dailySales + extraSalesAllowed) / item.dailySales, 1 / b)
      }
      if (stockout) {
        reasons.push(`Stock cover ${stockCover === null ? 'unknown' : Math.round(stockCover)} day(s) is below the month + ${safetyDays} safety days: spend is not increased.`)
        maxSpendByStock = Math.min(maxSpendByStock, item.dailySpend)
      }
    } else {
      reasons.push('Stock is unknown: no stock limit applied - check stock before increasing spend.')
    }
    max = Math.min(max, maxSpendByStock)
    if (!modelled) {
      max = Math.min(max, Math.max(min, 0))
      reasons.push(item.dailySpend <= 0 ? 'No advertising history: only the minimum (test) budget, no forecast.'
        : `Too little data (${item.clicks} clicks, ${item.orders} orders): kept at the minimum (test) budget, no forecast.`)
    }
    if (item.contributionPerSale === null) reasons.push('Costs are incomplete: profitability of extra spend cannot be judged.')
    return { item, spend: min, min, max, modelled, confidence, reasons, stockCover, stockout, maxSpendByStock }
  })

  let used = states.reduce((s, x) => s + x.spend, 0)
  const step = Math.max(1, dailyCap / 400)
  const limitAcos = (st: State) => (inputs.mode === 'PROFIT' ? st.item.breakEvenAcos : st.item.targetAcos ?? st.item.breakEvenAcos)
  // greedy marginal allocation
  for (let guard = 0; guard < 100000 && used + 1e-9 < dailyCap; guard++) {
    let best: State | null = null
    let bestScore = 0
    for (const st of states) {
      if (!st.modelled || st.item.contributionPerSale === null || st.spend + step > st.max + 1e-9) continue
      const lim = limitAcos(st)
      const mAcos = marginalAcos(st.spend + step / 2, st.item.dailySpend, st.item.dailySales, b)
      if (lim === null || mAcos === null || mAcos > lim) continue
      const extraSales = salesAt(st.spend + step, st.item.dailySpend, st.item.dailySales, b) - salesAt(st.spend, st.item.dailySpend, st.item.dailySales, b)
      const score = inputs.mode === 'PROFIT' ? extraSales * st.item.contributionPerSale - step : extraSales
      if (score > bestScore) { bestScore = score; best = st }
    }
    if (!best) break
    const add = Math.min(step, dailyCap - used)
    best.spend += add
    used += add
  }

  const results: AllocResult[] = states.map((st) => {
    const { item } = st
    const proposedDaily = r2(st.spend)
    let forecast: AllocResult['forecast'] = null
    if (st.modelled && st.confidence !== 'LOW') {
      const sales = [0.4, b, 0.8].map((bb) => salesAt(st.spend, item.dailySpend, item.dailySales, bb) * days) as [number, number, number]
      const sorted = [...sales].sort((x, y) => x - y) as [number, number, number]
      forecast = {
        salesMonthly: [r2(sorted[0]), r2(sales[1]), r2(sorted[2])],
        contributionAfterAdsMonthly: item.contributionPerSale === null ? null
          : ([sorted[0], sales[1], sorted[2]].map((s) => r2(s * item.contributionPerSale! - st.spend * days)) as [number, number, number]),
        extraUnitsPerDay: item.avgPrice ? r2((salesAt(st.spend, item.dailySpend, item.dailySales, b) - item.dailySales) / item.avgPrice) : 0,
      }
    }
    let bidChangePct: number | null = null
    if (st.confidence !== 'LOW' && item.currentCpc && item.maxCpc) {
      const raw = (item.maxCpc / item.currentCpc - 1) * 100
      bidChangePct = Math.round(Math.max(-30, Math.min(inputs.maxBidChangePct ?? 20, raw)))
    }
    const reasons = [...st.reasons]
    const change = proposedDaily - item.dailySpend
    if (st.modelled && item.contributionPerSale !== null) {
      if (change > 0.5) reasons.push(`Next rupees still return more than they cost (marginal ACoS ${r2(marginalAcos(st.spend, item.dailySpend, item.dailySales, b) ?? 0)}% within the ${inputs.mode === 'PROFIT' ? 'break-even' : 'target'} ACoS).`)
      else if (change < -0.5) reasons.push(`Reduced: at current spend the marginal ACoS exceeds the ${inputs.mode === 'PROFIT' ? 'break-even' : 'target'} ACoS of ${r2(limitAcos(st) ?? 0)}%.`)
      else reasons.push('Kept close to the current level.')
    }
    if (st.max === st.spend && Number.isFinite(st.maxSpendByStock) && st.maxSpendByStock <= st.spend + 1e-6 && !st.stockout && st.item.stockAvailable !== null) reasons.push('Capped by available stock.')
    if (item.maxDaily !== undefined && st.spend >= item.maxDaily - 1e-6) reasons.push('Capped at the maximum budget you set.')
    return {
      key: item.key, label: item.label, confidence: st.confidence, modelled: st.modelled, currentDaily: r2(item.dailySpend), proposedDaily,
      proposedMonthly: r2(st.spend * days), changeMonthly: r2((st.spend - item.dailySpend) * days),
      marginalAcos: st.modelled ? r2(marginalAcos(Math.max(st.spend, 1), item.dailySpend, item.dailySales, b) ?? 0) : null,
      forecast, bidChangePct, stockoutRisk: st.stockout, stockCoverDays: st.stockCover === null ? null : Math.round(st.stockCover), reasons,
    }
  })

  const allocatedMonthly = r2(results.reduce((s, x) => s + x.proposedMonthly, 0))
  const withForecast = results.filter((x) => x.forecast)
  const sumTriple = (pick: (x: AllocResult) => [number, number, number] | null): [number, number, number] | null => {
    const triples = withForecast.map(pick)
    if (!triples.length || triples.some((t) => t === null)) return null
    return [0, 1, 2].map((i) => r2(triples.reduce((s, t) => s + t![i], 0))) as [number, number, number]
  }
  const contributionRange = sumTriple((x) => x.forecast!.contributionAfterAdsMonthly)
  return {
    mode: inputs.mode, monthlyBudget: r2(inputs.monthlyBudget), allocatedMonthly, unallocatedMonthly: r2(Math.max(0, inputs.monthlyBudget - allocatedMonthly)),
    forecastSalesMonthly: sumTriple((x) => x.forecast!.salesMonthly), forecastContributionMonthly: contributionRange,
    minContributionMet: inputs.minContribution == null || !contributionRange ? null : contributionRange[0] >= inputs.minContribution,
    items: results,
    assumptions: [
      `Attributed sales grow with diminishing returns: sales ~ spend^${b} (range 0.4-0.8), fitted to each item's own history.`,
      `Forecasts cover only items with at least medium confidence (enough clicks and orders); others keep their minimum budget.`,
      inputs.mode === 'PROFIT' ? 'Profit priority: budget goes where the next rupee adds the most contribution, never beyond break-even ACoS.'
        : 'Growth priority: budget goes where the next rupee adds the most attributed sales, never beyond the target ACoS.',
      `Stock: extra units may not reduce cover below ${safetyDays} days after the month.`,
      'Placement, ranking, sales and profit are not guaranteed; Amazon auctions, competition and seasonality are not modelled.',
    ],
  }
}

/** Runs the allocator for several total budgets (scenario simulator). */
export function scenarios(items: AllocItem[], base: Omit<AllocInputs, 'monthlyBudget'>, budgets: { label: string; monthly: number }[]) {
  return budgets.map((s) => ({ label: s.label, monthly: s.monthly, result: allocateBudget(items, { ...base, monthlyBudget: s.monthly }) }))
}

/** Turns an analysed product into an allocator item (period averages converted to per day). */
export function toAllocItem(p: ProductAnalysis, periodDays: number, limits?: { min?: number; max?: number }): AllocItem {
  const days = Math.max(1, periodDays)
  return {
    key: p.sku, label: `${p.sku} — ${p.label}`, dailySpend: p.ads.spend / days, dailySales: p.ads.sales / days, clicks: p.ads.clicks, orders: p.ads.orders,
    contributionPerSale: p.targets.breakEvenAcos === null ? null : p.targets.breakEvenAcos / 100, breakEvenAcos: p.targets.breakEvenAcos, targetAcos: p.targets.targetAcos,
    avgPrice: p.units > 0 && p.orderedSales !== null ? p.orderedSales / p.units : p.row.item_price, avgDailyUnits: p.avgDailyUnits ?? 0, stockAvailable: p.stockForCover,
    minDaily: limits?.min, maxDaily: limits?.max, currentCpc: p.ads.cpc, maxCpc: p.affordable.maxCpc,
  }
}
