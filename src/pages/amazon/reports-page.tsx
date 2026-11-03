import { Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AmazonToolbar, DemoBanner, NoAmazonData } from '@/features/amazon/amazon-ui'
import { acos, adConversion, contribution, cpc, ctr, forecastDemand, replenishment, roas, sumComponents, type Num } from '@/features/amazon/metrics'
import { classifySearchTerm } from '@/features/amazon/recommendations'
import { isEmptyDataset, useAmazonDataset, useAmazonView, type AmazonDataset } from '@/features/amazon/use-amazon'
import type { CellValue } from '@/features/products/spreadsheet'
import { describeDataError } from '@/lib/errors'
import { fetchBudgetPlans, fetchDailySeries, fetchRecommendations, fetchSearchTerms, fetchSyncErrors } from '@/services/amazon'

const r2 = (v: Num | undefined): CellValue => (v === null || v === undefined ? null : Math.round(v * 100) / 100)

interface ReportDef { key: string; title: string; description: string; build: (d: AmazonDataset, ctx: { from: string; to: string; demo: boolean }) => Promise<CellValue[][]> }

const REPORTS: ReportDef[] = [
  { key: 'product-profitability', title: 'Product profitability', description: 'Per SKU: sales, costs, fees, ad spend, contribution before / after ads, ACoS targets, max CPC.',
    build: async (d) => [['SKU', 'ASIN', 'Title', 'ERP SKU', 'Units', 'Ordered sales', 'Net sales ex-GST', 'Product cost', 'Cost source', 'Referral fees', 'Fulfilment fees', 'Other fees', 'Fee basis',
      'Shipping', 'Other variable', 'Contribution before ads', 'Ad spend', 'Ad sales', 'Contribution after ads', 'Margin after ads %', 'ACoS %', 'TACoS %', 'ROAS', 'Break-even ACoS %', 'Target ACoS %',
      'Max CPC', 'Missing inputs'],
    ...d.products.map((p) => [p.sku, p.row.asin, p.label, p.row.erp_sku, p.units, r2(p.orderedSales), r2(p.contribution.netSalesExGst), r2(p.contribution.productCost), p.row.cost_source,
      r2(p.contribution.referralFees), r2(p.contribution.fulfilmentFees), r2(p.contribution.otherFees), p.contribution.feeBasis, r2(p.contribution.shipping), r2(p.contribution.otherVariable),
      r2(p.contribution.beforeAds), r2(p.ads.spend), r2(p.ads.sales), r2(p.contribution.afterAds), r2(p.contribution.marginAfterPct), r2(p.ads.acos), r2(p.ads.tacos), r2(p.ads.roas),
      r2(p.targets.breakEvenAcos), r2(p.targets.targetAcos), r2(p.affordable.maxCpc), p.contribution.missing.join('; ')])] },
  { key: 'campaign-performance', title: 'Campaign performance', description: 'Per campaign: budget, utilisation, clicks, spend, attributed sales, ACoS vs break-even / target.',
    build: async (d) => [['Campaign ID', 'Name', 'State', 'Targeting', 'Daily budget', 'Budget utilisation %', 'Budget-capped days', 'Impressions', 'Clicks', 'CTR %', 'CPC', 'Spend', 'Attributed sales',
      'Orders', 'ACoS %', 'ROAS', 'Conversion %', 'Break-even ACoS %', 'Target ACoS %', 'Spend on targets without orders', 'Source'],
    ...d.campaigns.map((c) => [c.row.campaign_id, c.row.name, c.row.state, c.row.targeting_type, r2(c.row.daily_budget), r2(c.budgetUtilisation), c.row.budget_constrained_days, c.row.impressions, c.row.clicks,
      r2(c.ctr), r2(c.cpc), r2(c.row.spend), r2(c.row.sales), c.row.orders, r2(c.acos), r2(c.roas), r2(c.conversion), r2(c.breakEvenAcos), r2(c.targetAcos), r2(c.row.zero_order_target_spend), c.row.data_source])] },
  { key: 'search-terms', title: 'Search terms', description: 'Customer search terms with performance and the suggested action (up to 5,000 rows).',
    build: async (d, x) => {
      const t = await fetchSearchTerms(x.from, x.to, x.demo, { limit: 5000 })
      return [['Search term', 'Keyword / target', 'Match', 'Campaign', 'Ad group', 'SKU', 'Impressions', 'Clicks', 'CTR %', 'CPC', 'Spend', 'Orders', 'Sales', 'ACoS %', 'Conversion %', 'Suggested action', 'Evidence'],
        ...t.rows.map((s) => { const c = classifySearchTerm(s, s.seller_sku ? d.productMap.get(s.seller_sku)?.targets.targetAcos ?? null : null, d.settings)
          return [s.search_term, s.targeting, s.match_type, s.campaign_name ?? s.campaign_id, s.ad_group_name ?? s.ad_group_id, s.seller_sku, s.impressions, s.clicks, r2(ctr(s.clicks, s.impressions)),
            r2(cpc(s.spend, s.clicks)), r2(s.spend), s.orders, r2(s.sales), r2(acos(s.spend, s.sales)), r2(adConversion(s.orders, s.clicks)), c.action, c.evidence] })]
    } },
  { key: 'daily-ad-spend', title: 'Daily sales and advertising', description: 'Per day: ordered sales, account ad spend, attributed sales, ACoS, ROAS and contribution after ads.',
    build: async (_d, x) => {
      const s = await fetchDailySeries(x.from, x.to, x.demo)
      return [['Date', 'Ordered sales', 'Units', 'Ad spend', 'Attributed sales', 'Clicks', 'Impressions', 'ACoS %', 'ROAS', 'Contribution after ads'],
        ...s.days.map((day) => [day.date, r2(day.components?.ordered_sales ?? null), day.components?.units ?? null, r2(day.account_ads?.spend ?? null), r2(day.account_ads?.sales ?? null),
          day.account_ads?.clicks ?? null, day.account_ads?.impressions ?? null, r2(acos(day.account_ads?.spend, day.account_ads?.sales)), r2(roas(day.account_ads?.sales, day.account_ads?.spend)),
          r2(day.components ? contribution(day.components).afterAds : null)])]
    } },
  { key: 'contribution-statement', title: 'Contribution statement', description: 'Account-level contribution waterfall for the period (ex-GST).',
    build: async (d) => {
      const c = contribution(sumComponents(d.products.map((p) => p.row.totals ?? {})), { overheadPct: d.settings.overhead_allocation_pct })
      return [['Line', 'Amount'], ['Gross ordered sales', r2(c.grossSales)], ['Net sales ex-GST', r2(c.netSalesExGst)], ['Product cost', r2(c.productCost)], ['Referral fees', r2(c.referralFees)],
        ['Fulfilment fees', r2(c.fulfilmentFees)], ['Other Amazon fees', r2(c.otherFees)], ['Shipping', r2(c.shipping)], ['Other variable costs', r2(c.otherVariable)],
        ['Contribution before advertising', r2(c.beforeAds)], ['Advertising', r2(c.adSpend)], ['Contribution after advertising', r2(c.afterAds)], ['Allocated overhead (estimate)', r2(c.overhead)],
        ['Estimated operating contribution', r2(c.estimatedOperating)], ['Fee basis', c.feeBasis], ['Estimates', c.estimated.join('; ')], ['Missing inputs', c.missing.join('; ')]]
    } },
  { key: 'inventory-risk', title: 'Inventory risk', description: 'Stock, cover, 30-day demand forecast, replenishment (where a lead time is set) and ad spend on low-stock products.',
    build: async (d) => [['SKU', 'Stock used', 'Stock source', 'Amazon fulfillable', 'Amazon as of', 'ERP available', 'Incoming production', 'Avg daily units (28 d)', 'Cover days', 'Status',
      'Demand 30 d', 'Demand low', 'Demand high', 'Lead time days', 'Replenish qty', 'Replenishment basis', 'Ad spend (period)'],
    ...d.products.map((p) => { const f = forecastDemand(p.row.velocity?.daily_28 ?? [], 30)
      const rq = replenishment({ available: p.stockForCover, incoming: p.row.stock.incoming_production, avgDaily: p.avgDailyUnits, leadTimeDays: p.row.lead_time_days, safetyDays: d.settings.low_stock_cover_days, minStock: p.row.min_stock })
      return [p.sku, p.stockForCover, p.stockSource, p.row.stock.amazon_fulfillable, p.row.stock.amazon_as_of, p.row.stock.erp_available, p.row.stock.incoming_production, r2(p.avgDailyUnits), r2(p.stockCover),
        p.stockStatus, f.expected, f.low, f.high, p.row.lead_time_days, rq.quantity, rq.reason, r2(p.ads.spend)] })] },
  { key: 'recommendations', title: 'Recommendations', description: 'Stored recommendations with status, evidence and calculation.',
    build: async (_d, x) => {
      const rows = await fetchRecommendations(x.demo)
      return [['Rule', 'Entity', 'Period from', 'Period to', 'Title', 'Issue', 'Proposed action', 'Calculation', 'Confidence', 'Impact', 'Missing', 'Status', 'Note'],
        ...rows.map((r) => [r.rule_code, r.entity_label, r.period_from, r.period_to, r.title, r.issue, r.proposed_action, r.financial.calculation, r.confidence, r.impact_direction, r.missing_info.join('; '), r.status, r.status_note])]
    } },
  { key: 'budget-plans', title: 'Budget plans', description: 'Saved budget plans with their per-product allocation.',
    build: async (_d, x) => {
      const plans = await fetchBudgetPlans(x.demo)
      const out: CellValue[][] = [['Plan', 'Month', 'Mode', 'Total budget', 'Item', 'Confidence', 'Current per day', 'Proposed per day', 'Proposed per month', 'Reasons']]
      for (const p of plans) {
        const items = ((p.allocation as { items?: { label: string; confidence: string; currentDaily: number; proposedDaily: number; proposedMonthly: number; reasons: string[] }[] }).items ?? [])
        for (const i of items) out.push([p.name, p.month, String(p.inputs.mode ?? ''), Number(p.inputs.total_budget ?? 0), i.label, i.confidence, i.currentDaily, i.proposedDaily, i.proposedMonthly, i.reasons.join(' ')])
      }
      return out
    } },
  { key: 'sync-errors', title: 'Synchronisation errors', description: 'The latest 1,000 Amazon API and import errors (messages are redacted).',
    build: async () => {
      const e = await fetchSyncErrors(0, 1000)
      return [['When', 'API', 'Operation', 'HTTP status', 'Code', 'Message', 'Retryable', 'Attempt'], ...e.rows.map((x) => [x.occurred_at, x.api, x.operation, x.http_status, x.error_code, x.message, x.retryable ? 'yes' : 'no', x.attempt])]
    } },
]

export default function AmazonReportsPage() {
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const d = data.data
  const exportReport = async (r: ReportDef) => {
    if (!d) return
    setBusy(r.key); setError(null)
    try {
      const body = await r.build(d, { from: view.from, to: view.to, demo })
      const header: CellValue[][] = [[`Amazon ${r.title}`], [`Period ${view.from} to ${view.to}`], [demo ? 'DEMO DATA - fictitious, not Amazon data' : 'Live data (synchronised / imported)'], []]
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: r.title, rows: [...header, ...body] }], `amazon-${r.key}-${view.from}-${view.to}${demo ? '-DEMO' : ''}`, 'csv')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {data.loading && !d ? <LoadingState variant="table" rows={6} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {REPORTS.map((r) => (
              <Card key={r.key}>
                <CardHeader><div><CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-4 text-muted-foreground" /> {r.title}</CardTitle><CardDescription>{r.description}</CardDescription></div></CardHeader>
                <CardContent><Button variant="outline" disabled={busy !== null} onClick={() => void exportReport(r)}>{busy === r.key ? <Loader2 className="animate-spin" /> : <Download />} Export CSV</Button></CardContent>
              </Card>
            ))}
          </div>
        )}
      <p className="mt-4 text-xs text-muted-foreground">Exports use the same calculations as the screens. Empty cells mean the value is unavailable (missing data), not zero.</p>
    </>
  )
}
