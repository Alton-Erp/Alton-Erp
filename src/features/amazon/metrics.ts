/**
 * Amazon profitability and advertising calculations. The ONE implementation
 * used by every Amazon page, report, the budget planner and the recommendation
 * engine. Inputs are the component sums returned by the database
 * (private.amazon_sku_day); see DEFINITIONS for the wording shown to users.
 *
 * Rules:
 *  - A value that cannot be computed is `null` (shown as "Unavailable"), never 0.
 *  - Sales used for contribution are ex-GST (database converts with the listing
 *    or ERP product GST rate). Fees, product cost and advertising are ex-GST.
 *  - ACoS / ROAS / TACoS / break-even ACoS use sales as reported by Amazon, so
 *    the ratio and its break-even are on the same basis.
 *  - Actual values, estimates and allocated overhead are kept separate.
 */

export type Num = number | null

export const n = (v: unknown): Num => {
  if (v === null || v === undefined || v === '') return null
  const x = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(x) ? x : null
}
const z = (v: unknown) => n(v) ?? 0
const round = (v: Num, dp = 2): Num => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp)

/** a / b, or null when b is 0 / missing or a is missing. */
export function ratio(a: unknown, b: unknown): Num {
  const x = n(a)
  const y = n(b)
  if (x === null || y === null || y === 0) return null
  return x / y
}
const pct = (a: unknown, b: unknown): Num => {
  const r = ratio(a, b)
  return r === null ? null : r * 100
}

// ---------------------------------------------------------------------------
// Advertising metrics
// ---------------------------------------------------------------------------
export interface AdTotals { spend: unknown; sales: unknown; clicks: unknown; impressions: unknown; orders: unknown }

/** ACoS % = ad spend / ad-attributed sales x 100. Null when there are no attributed sales. */
export const acos = (spend: unknown, adSales: unknown) => pct(spend, adSales)
/** ROAS = ad-attributed sales / ad spend. */
export const roas = (adSales: unknown, spend: unknown) => ratio(adSales, spend)
/** TACoS % = ad spend / total sales (same scope and period) x 100. */
export const tacos = (spend: unknown, totalSales: unknown) => pct(spend, totalSales)
/** CTR % = clicks / impressions x 100. */
export const ctr = (clicks: unknown, impressions: unknown) => pct(clicks, impressions)
/** CPC = ad spend / clicks. */
export const cpc = (spend: unknown, clicks: unknown) => ratio(spend, clicks)
/** Ad conversion rate % = attributed orders / clicks x 100 (advertising reports). */
export const adConversion = (orders: unknown, clicks: unknown) => pct(orders, clicks)
/** Unit session percentage = units ordered / sessions x 100 (Business Report definition). */
export const sessionConversion = (units: unknown, sessions: unknown) => pct(units, sessions)
/** Cost per attributed order = ad spend / attributed orders. */
export const costPerOrder = (spend: unknown, orders: unknown) => ratio(spend, orders)

export function adMetrics(t: AdTotals) {
  return {
    spend: n(t.spend), sales: n(t.sales), clicks: n(t.clicks), impressions: n(t.impressions), orders: n(t.orders),
    acos: acos(t.spend, t.sales), roas: roas(t.sales, t.spend), ctr: ctr(t.clicks, t.impressions), cpc: cpc(t.spend, t.clicks),
    conversion: adConversion(t.orders, t.clicks), costPerOrder: costPerOrder(t.spend, t.orders),
    /** Spend with no attributed sales: ACoS is undefined, not 0 or infinite. */
    spendWithoutSales: z(t.spend) > 0 && z(t.sales) === 0,
  }
}

// ---------------------------------------------------------------------------
// Contribution
// ---------------------------------------------------------------------------
/** Component sums as returned by amazon_product_performance (.totals) and amazon_daily_series (.components). */
export interface Components {
  ordered_sales?: unknown; units?: unknown; order_items?: unknown; sessions?: unknown
  refund_amount?: unknown; refunded_units?: unknown; promotion_discounts?: unknown
  sales_ex_gst?: unknown; refunds_ex_gst?: unknown; discounts_ex_gst?: unknown; gst_missing?: unknown
  actual_referral?: unknown; actual_fulfilment?: unknown; actual_other?: unknown
  est_referral?: unknown; est_fulfilment?: unknown; fee_missing_days?: unknown; actual_fee_days?: unknown
  shipping_cost?: unknown; other_variable_cost?: unknown; product_cost?: unknown; units_without_cost?: unknown
  ad_spend?: unknown; ad_sales?: unknown; ad_orders?: unknown; ad_clicks?: unknown; ad_impressions?: unknown
  sales_days?: unknown
}

export type FeeBasis = 'ACTUAL' | 'ESTIMATED' | 'MIXED' | 'NONE'

export interface Contribution {
  grossSales: Num
  netSalesExGst: Num
  refundsExGst: Num
  discountsExGst: Num
  productCost: Num
  referralFees: Num
  fulfilmentFees: Num
  otherFees: Num
  shipping: Num
  otherVariable: Num
  feeBasis: FeeBasis
  /** Contribution before advertising (ex-GST). Null when any required input is missing. */
  beforeAds: Num
  adSpend: number
  /** Contribution after advertising. */
  afterAds: Num
  marginBeforePct: Num
  marginAfterPct: Num
  /** Allocated overhead (configured % of net sales) - only when configured; an estimate. */
  overhead: Num
  /** After advertising and allocated overhead - estimate, only when overhead is configured. */
  estimatedOperating: Num
  /** Parts of the calculation based on estimates rather than actual settlement data. */
  estimated: string[]
  /** Inputs that are missing; while non-empty, beforeAds / afterAds are null. */
  missing: string[]
}

export function contribution(c: Components, opts: { overheadPct?: number | null } = {}): Contribution {
  const units = z(c.units)
  const missing: string[] = []
  const estimated: string[] = []

  const gross = n(c.ordered_sales)
  let net: Num = null
  if (c.gst_missing === true) missing.push('GST rate (set it on the product or the listing)')
  else if (gross === null && units > 0) missing.push('sales value')
  else net = z(c.sales_ex_gst) - z(c.refunds_ex_gst) - z(c.discounts_ex_gst)

  const actualRef = n(c.actual_referral)
  const actualFul = n(c.actual_fulfilment)
  const actualOther = n(c.actual_other)
  const estRef = n(c.est_referral)
  const estFul = n(c.est_fulfilment)
  const hasActual = actualRef !== null || actualFul !== null || actualOther !== null
  const hasEstimate = estRef !== null || estFul !== null
  if (z(c.fee_missing_days) > 0) missing.push('Amazon fees for some days (no settlement data and no fee settings on the listing)')
  const feeBasis: FeeBasis = hasActual && hasEstimate ? 'MIXED' : hasActual ? 'ACTUAL' : hasEstimate ? 'ESTIMATED' : 'NONE'
  if (feeBasis === 'ESTIMATED' || feeBasis === 'MIXED') estimated.push('Amazon fees for days without settlement data (from the listing fee settings)')
  if (feeBasis === 'NONE' && units > 0 && z(c.fee_missing_days) === 0) missing.push('Amazon fees')
  const referral = actualRef === null && estRef === null ? null : z(actualRef) + z(estRef)
  const fulfilment = actualFul === null && estFul === null ? null : z(actualFul) + z(estFul)
  const otherFees = actualOther

  const productCost = n(c.product_cost)
  if (z(c.units_without_cost) > 0) missing.push(`product cost for ${z(c.units_without_cost)} unit(s)`)

  const shipping = n(c.shipping_cost)
  const otherVariable = n(c.other_variable_cost)
  const adSpend = z(c.ad_spend)

  const complete = missing.length === 0 && net !== null
  const beforeAds = complete ? net! - z(productCost) - z(referral) - z(fulfilment) - z(otherFees) - z(shipping) - z(otherVariable) : null
  const afterAds = beforeAds === null ? null : beforeAds - adSpend
  const overheadPct = n(opts.overheadPct)
  const overhead = overheadPct && overheadPct > 0 && net !== null ? (net * overheadPct) / 100 : null
  return {
    grossSales: gross, netSalesExGst: round(net), refundsExGst: n(c.refunds_ex_gst), discountsExGst: n(c.discounts_ex_gst), productCost: round(productCost),
    referralFees: round(referral), fulfilmentFees: round(fulfilment), otherFees: round(otherFees), shipping: round(shipping), otherVariable: round(otherVariable), feeBasis,
    beforeAds: round(beforeAds), adSpend: round(adSpend)!, afterAds: round(afterAds),
    marginBeforePct: beforeAds === null ? null : round(pct(beforeAds, net)), marginAfterPct: afterAds === null ? null : round(pct(afterAds, net)),
    overhead: round(overhead), estimatedOperating: afterAds !== null && overhead !== null ? round(afterAds - overhead) : null, estimated, missing,
  }
}

/** Sums component objects (e.g. days into a period, products into a total). Nulls stay null only if every input is null. */
export function sumComponents(list: Components[]): Components {
  const out: Record<string, unknown> = {}
  const keys = new Set(list.flatMap((c) => Object.keys(c)))
  for (const k of keys) {
    if (k === 'gst_missing') out[k] = list.some((c) => c[k as keyof Components] === true)
    else {
      const vals = list.map((c) => n(c[k as keyof Components]))
      out[k] = vals.every((v) => v === null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0)
    }
  }
  return out as Components
}

// ---------------------------------------------------------------------------
// Break-even ACoS, target ACoS, affordable cost per order and CPC
// ---------------------------------------------------------------------------
export interface AcosTargets {
  /** % of reported sales available to pay for advertising before contribution reaches zero. */
  breakEvenAcos: Num
  /** % of reported sales that may be spent while still keeping the desired contribution. */
  targetAcos: Num
  /** How the target was set. */
  targetSource: 'LISTING_OVERRIDE' | 'DESIRED_CONTRIBUTION_PER_UNIT' | 'COMPANY_TARGET_MARGIN' | 'UNAVAILABLE'
  desiredContributionPct: Num
  note: string | null
}

/**
 * Break-even ACoS = contribution before advertising / sales (as reported) x 100.
 * Target ACoS = break-even ACoS - desired contribution (as % of the same sales).
 * The desired contribution is the listing's "desired contribution per unit" if
 * set, otherwise the company target contribution % (amazon_settings).
 */
export function acosTargets(args: {
  beforeAds: Num; reportedSales: Num; units: Num
  desiredPerUnit?: Num; companyTargetPct?: Num; listingTargetAcos?: Num
}): AcosTargets {
  const breakEven = args.beforeAds === null ? null : pct(args.beforeAds, args.reportedSales)
  let desired: Num = null
  let source: AcosTargets['targetSource'] = 'UNAVAILABLE'
  if (n(args.desiredPerUnit) !== null && z(args.units) > 0) {
    desired = pct(z(args.desiredPerUnit) * z(args.units), args.reportedSales)
    source = 'DESIRED_CONTRIBUTION_PER_UNIT'
  } else if (n(args.companyTargetPct) !== null) {
    desired = n(args.companyTargetPct)
    source = 'COMPANY_TARGET_MARGIN'
  }
  let target = breakEven !== null && desired !== null ? breakEven - desired : null
  let note: string | null = null
  if (target !== null && target <= 0) {
    note = 'At the desired contribution there is no room for advertising on this product.'
    target = 0
  }
  if (n(args.listingTargetAcos) !== null) {
    if (target !== null && n(args.listingTargetAcos)! > (breakEven ?? Infinity)) note = 'The manual target ACoS is above break-even: advertising at that level loses money.'
    return { breakEvenAcos: round(breakEven), targetAcos: n(args.listingTargetAcos), targetSource: 'LISTING_OVERRIDE', desiredContributionPct: round(desired), note }
  }
  if (breakEven === null) note = 'Break-even ACoS needs complete cost data (see missing inputs).'
  return { breakEvenAcos: round(breakEven), targetAcos: round(target), targetSource: target === null ? 'UNAVAILABLE' : source, desiredContributionPct: round(desired), note }
}

/** Lower bound of the Wilson score interval: a conservative conversion rate for small samples. */
export function wilsonLower(successes: number, trials: number, z95 = 1.2816): Num {
  if (trials <= 0) return null
  const p = successes / trials
  const z2 = z95 * z95
  return (p + z2 / (2 * trials) - z95 * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials)
}

export interface AffordableCpc {
  /** Maximum ad cost per attributed order at the target ACoS. */
  maxCostPerOrder: Num
  /** Click-to-order conversion used (fraction), and how it was obtained. */
  conversionUsed: Num
  conversionBasis: 'OBSERVED' | 'CONSERVATIVE_LOWER_BOUND' | 'USER_ASSUMPTION' | 'INSUFFICIENT_DATA'
  /** Maximum affordable CPC = max cost per order x conversion rate. */
  maxCpc: Num
  note: string | null
}

/**
 * Maximum affordable CPC = maximum affordable advertising cost per attributed
 * order x expected click-to-order conversion. With at least `minClicks` clicks
 * the observed rate is used if it has orders; with fewer clicks the 80% Wilson
 * lower bound is used (conservative); with no clicks a user assumption is needed.
 */
export function affordableCpc(args: {
  targetAcos: Num; avgOrderValue: Num; clicks: number; orders: number; minClicks: number; assumedConversion?: Num
}): AffordableCpc {
  const maxCostPerOrder = args.targetAcos === null || args.avgOrderValue === null ? null : (args.targetAcos / 100) * args.avgOrderValue
  let conv: Num = null
  let basis: AffordableCpc['conversionBasis'] = 'INSUFFICIENT_DATA'
  let note: string | null = null
  if (n(args.assumedConversion) !== null) {
    conv = n(args.assumedConversion)! / 100
    basis = 'USER_ASSUMPTION'
  } else if (args.clicks >= args.minClicks && args.orders > 0) {
    conv = args.orders / args.clicks
    basis = 'OBSERVED'
  } else if (args.clicks > 0) {
    conv = wilsonLower(args.orders, args.clicks)
    basis = 'CONSERVATIVE_LOWER_BOUND'
    note = `Only ${args.clicks} click(s) and ${args.orders} order(s): a conservative conversion estimate is used. Enter an assumption for a better estimate.`
    if (conv !== null && conv <= 0) { conv = null; basis = 'INSUFFICIENT_DATA' }
  }
  if (basis === 'INSUFFICIENT_DATA') note = 'Not enough click and order data to estimate conversion. Provide an assumed conversion rate.'
  return { maxCostPerOrder: round(maxCostPerOrder), conversionUsed: conv === null ? null : round(conv, 4), conversionBasis: basis,
    maxCpc: maxCostPerOrder === null || conv === null ? null : round(maxCostPerOrder * conv), note }
}

// ---------------------------------------------------------------------------
// Stock cover and demand
// ---------------------------------------------------------------------------
export function mean(values: number[]): Num {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null
}
export function stdDev(values: number[]): Num {
  const m = mean(values)
  if (m === null || values.length < 2) return null
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}
/** Days of stock cover = available units / average daily units sold. Null without recent sales. */
export const stockCoverDays = (available: Num, avgDaily: Num) => (available === null || !avgDaily ? null : round(available / avgDaily, 1))

export interface DemandForecast { horizonDays: number; expected: Num; low: Num; high: Num; avgDaily: Num; basis: string; reliable: boolean }

/**
 * Demand forecast = recent average daily units x horizon, with an ~80% range of
 * +/- 1.28 x daily standard deviation x sqrt(horizon). Marked unreliable with
 * fewer than 14 days of data. Not a promise: shown with its basis.
 */
export function forecastDemand(daily: number[], horizonDays: number, upliftUnitsPerDay = 0): DemandForecast {
  const avg = mean(daily)
  const sd = stdDev(daily) ?? 0
  const reliable = daily.length >= 14
  if (avg === null) return { horizonDays, expected: null, low: null, high: null, avgDaily: null, basis: 'No sales history', reliable: false }
  const base = (avg + upliftUnitsPerDay) * horizonDays
  const spread = 1.2816 * sd * Math.sqrt(horizonDays)
  return { horizonDays, expected: round(base, 1), low: round(Math.max(0, base - spread), 1), high: round(base + spread, 1), avgDaily: round(avg + upliftUnitsPerDay, 2),
    basis: `Average of the last ${daily.length} day(s)${upliftUnitsPerDay ? ` plus ${round(upliftUnitsPerDay, 2)} unit(s)/day from the proposed advertising` : ''}`, reliable }
}

/**
 * Replenishment = demand over (lead time + safety cover) - available - incoming,
 * only when a lead time is known. Returns null with a reason otherwise.
 */
export function replenishment(args: { available: Num; incoming: Num; avgDaily: Num; leadTimeDays: Num; safetyDays: number; minStock?: Num }): { quantity: Num; reason: string } {
  if (args.leadTimeDays === null) return { quantity: null, reason: 'Supplier / production lead time is not set for this listing.' }
  if (args.available === null) return { quantity: null, reason: 'Available stock is unknown.' }
  if (!args.avgDaily) return { quantity: null, reason: 'No recent sales to base a quantity on.' }
  const need = args.avgDaily * (args.leadTimeDays + args.safetyDays) + z(args.minStock)
  const qty = Math.ceil(Math.max(0, need - args.available - z(args.incoming)))
  return { quantity: qty, reason: qty > 0 ? `Covers ${args.leadTimeDays} day(s) lead time + ${args.safetyDays} day(s) safety at ${round(args.avgDaily, 2)}/day.` : 'Stock and incoming quantity cover the lead time.' }
}

// ---------------------------------------------------------------------------
// Definitions shown in the UI (same wording as the formulas above)
// ---------------------------------------------------------------------------
export const DEFINITIONS: Record<string, string> = {
  orderedSales: 'Ordered product sales as reported by Amazon (includes GST when prices include GST).',
  netSales: 'Ordered sales minus refunds and promotion discounts, converted to ex-GST with the GST rate of the listing or ERP product.',
  acos: 'ACoS = advertising spend / advertising-attributed sales x 100.',
  roas: 'ROAS = advertising-attributed sales / advertising spend.',
  tacos: 'TACoS = advertising spend / total ordered sales for the same products and period x 100.',
  ctr: 'CTR = clicks / impressions x 100.',
  cpc: 'CPC = advertising spend / clicks.',
  adConversion: 'Ad conversion = attributed orders / clicks x 100 (advertising report).',
  sessionConversion: 'Unit session percentage = units ordered / sessions x 100 (Business Report).',
  beforeAds: 'Contribution before advertising = net sales (ex-GST) - product cost - Amazon fees - shipping - other variable costs.',
  afterAds: 'Contribution after advertising = contribution before advertising - advertising spend.',
  breakEvenAcos: 'Break-even ACoS = contribution before advertising / ordered sales x 100. Above it, advertising loses money.',
  targetAcos: 'Target ACoS = break-even ACoS - desired contribution (desired contribution per unit, or the company target %).',
  maxCpc: 'Maximum affordable CPC = maximum ad cost per order at the target ACoS x expected click-to-order conversion.',
  stockCover: 'Days of stock cover = available stock / average daily units sold (last 28 days).',
  budgetUtilisation: 'Budget utilisation = advertising spend / sum of daily campaign budgets over the period.',
  refunds: 'Returned units are not credited back to product cost (their condition is not synchronised), so contribution is conservative.',
}
