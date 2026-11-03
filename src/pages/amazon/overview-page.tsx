import { AlertTriangle, BadgeIndianRupee, Boxes, MousePointerClick, Package, Percent, ShoppingBag, TrendingUp, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'

import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { ChartCard } from '@/components/common/chart-card'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { AmazonToolbar, DataCoverage, DemoBanner, NoAmazonData } from '@/features/amazon/amazon-ui'
import { SignedBarChart } from '@/features/amazon/charts'
import { money, num, pctText } from '@/features/amazon/format'
import { acos, adConversion, contribution, costPerOrder, cpc, ctr, DEFINITIONS, ratio, replenishment, roas, sumComponents, tacos } from '@/features/amazon/metrics'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { MetricCard, SectionHeading } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchDailySeries } from '@/services/amazon'

const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })

export default function AmazonOverviewPage() {
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  const daily = useAsync(() => fetchDailySeries(view.from, view.to, demo), [view.from, view.to, demo, refresh])
  const d = data.data

  const k = useMemo(() => {
    if (!d || !daily.data) return null
    const prods = d.products
    const totals = sumComponents(prods.map((p) => p.row.totals ?? {}))
    const c = contribution(totals, { overheadPct: d.settings.overhead_allocation_pct })
    const complete = prods.filter((p) => p.contribution.afterAds !== null)
    const partialAfter = complete.reduce((s, p) => s + (p.contribution.afterAds ?? 0), 0)
    const acct = daily.data.days.reduce((a, x) => ({ spend: a.spend + (x.account_ads?.spend ?? 0), sales: a.sales + (x.account_ads?.sales ?? 0), orders: a.orders + (x.account_ads?.orders ?? 0),
      clicks: a.clicks + (x.account_ads?.clicks ?? 0), impressions: a.impressions + (x.account_ads?.impressions ?? 0), budget: a.budget + (x.account_ads?.budget ?? 0), rows: a.rows + (x.account_ads?.rows ?? 0) }),
      { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, budget: 0, rows: 0 })
    const ordered = Number(totals.ordered_sales ?? 0)
    const orderItems = Number(totals.order_items ?? 0)
    const atRisk = prods.filter((p) => p.stockStatus === 'STOCKOUT_RISK' || p.stockStatus === 'LOW')
    const repl = prods.map((p) => replenishment({ available: p.stockForCover, incoming: p.row.stock.incoming_production, avgDaily: p.avgDailyUnits, leadTimeDays: p.row.lead_time_days,
      safetyDays: d.settings.low_stock_cover_days, minStock: p.row.min_stock })).filter((r) => (r.quantity ?? 0) > 0)
    const known = prods.filter((p) => p.stockForCover !== null)
    return {
      totals, c, complete, partialAfter, acct, ordered, orderItems, atRisk, repl, known,
      adsAvailable: acct.rows > 0,
      stock: known.reduce((s, p) => s + (p.stockForCover ?? 0), 0),
      avgCover: ratio(known.reduce((s, p) => s + (p.stockForCover ?? 0), 0), known.reduce((s, p) => s + (p.avgDailyUnits ?? 0), 0)),
      spendAtRisk: atRisk.reduce((s, p) => s + p.ads.spend, 0),
    }
  }, [d, daily.data])

  const loading = data.loading || daily.loading
  const error = data.error ?? daily.error
  const empty = isEmptyDataset(d)
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {loading && !d ? <LoadingState variant="table" rows={6} /> : error ? <ErrorState message={describeDataError(error)} onRetry={() => setRefresh((n) => n + 1)} />
        : empty ? <NoAmazonData dataset={d} demo={demo} /> : d && k && (
          <div className="space-y-8">
            <DataCoverage dataset={d} />
            <section aria-labelledby="amz-sales">
              <SectionHeading id="amz-sales" title="Sales" description="From the Business Report / Sales & Traffic data for the period." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Ordered sales" value={money(k.ordered)} icon={ShoppingBag} accent="blue" kind="period" definition={DEFINITIONS.orderedSales} />
                <MetricCard label="Units ordered" value={num(Number(k.totals.units ?? 0))} icon={Package} kind="period" hint={`${num(k.orderItems)} order items`} />
                <MetricCard label="Average order value" value={money(ratio(k.ordered, k.orderItems))} icon={Wallet} kind="period" definition="Ordered sales / total order items." />
                <MetricCard label="Refunds" value={money(Number(k.totals.refund_amount ?? 0))} icon={AlertTriangle} kind="period" hint={`${num(Number(k.totals.refunded_units ?? 0))} unit(s) refunded`}
                  unavailableReason="Requires settlement data" definition="Refunded principal from settlement data." />
                <MetricCard label="Net sales (ex-GST)" value={money(k.c.netSalesExGst)} icon={BadgeIndianRupee} accent="green" kind="period" definition={DEFINITIONS.netSales}
                  unavailableReason={k.c.missing.join('; ')} />
                <MetricCard label="Advertising-attributed sales" value={k.adsAvailable ? money(k.acct.sales) : null} icon={TrendingUp} kind="period" unavailableReason="No advertising data for the period"
                  definition={`Sales attributed to ads within the ${d.settings.attribution_window_days}-day attribution window (may include other products of the same brand).`} />
                <MetricCard label="Organic sales (estimate)" value={k.adsAvailable ? money(Math.max(0, k.ordered - k.acct.sales)) : null} icon={ShoppingBag} kind="period"
                  unavailableReason="Needs advertising data" definition="Ordered sales minus advertising-attributed sales. An estimate: attribution windows and halo sales blur the split." />
              </div>
            </section>

            <section aria-labelledby="amz-ads">
              <SectionHeading id="amz-ads" title="Advertising" description="Account totals from the campaign report (all campaigns)." />
              {!k.adsAvailable ? <p className="text-sm text-muted-foreground">No advertising data for this period.</p> : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard label="Advertising spend" value={money(k.acct.spend)} icon={Wallet} accent="orange" kind="period" />
                  <MetricCard label="ACoS" value={pctText(acos(k.acct.spend, k.acct.sales))} icon={Percent} kind="period" definition={DEFINITIONS.acos} unavailableReason="No attributed sales" />
                  <MetricCard label="ROAS" value={num(roas(k.acct.sales, k.acct.spend), 2)} icon={TrendingUp} kind="period" definition={DEFINITIONS.roas} unavailableReason="No spend" />
                  <MetricCard label="TACoS" value={pctText(tacos(k.acct.spend, k.ordered))} icon={Percent} kind="period" definition={DEFINITIONS.tacos} unavailableReason="No sales data" />
                  <MetricCard label="Impressions / clicks" value={`${num(k.acct.impressions)} / ${num(k.acct.clicks)}`} icon={MousePointerClick} kind="period" hint={`CTR ${pctText(ctr(k.acct.clicks, k.acct.impressions), 2) ?? 'n/a'}`} definition={DEFINITIONS.ctr} />
                  <MetricCard label="CPC" value={money(cpc(k.acct.spend, k.acct.clicks), true)} icon={MousePointerClick} kind="period" definition={DEFINITIONS.cpc} unavailableReason="No clicks" />
                  <MetricCard label="Ad conversion rate" value={pctText(adConversion(k.acct.orders, k.acct.clicks))} icon={Percent} kind="period" definition={DEFINITIONS.adConversion} hint={`Cost per attributed order ${money(costPerOrder(k.acct.spend, k.acct.orders)) ?? 'n/a'}`} />
                  <MetricCard label="Budget utilisation" value={pctText(k.acct.budget ? (k.acct.spend / k.acct.budget) * 100 : null)} icon={Wallet} kind="period" definition={DEFINITIONS.budgetUtilisation} unavailableReason="Campaign budgets unknown" />
                </div>
              )}
            </section>

            <section aria-labelledby="amz-profit">
              <SectionHeading id="amz-profit" title="Profitability" description="Ex-GST. Actual settlement fees where synchronised, otherwise estimates from the listing fee settings." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Gross sales" value={money(k.c.grossSales)} icon={ShoppingBag} kind="period" />
                <MetricCard label="Discounts and refunds (ex-GST)" value={money((k.c.refundsExGst ?? 0) + (k.c.discountsExGst ?? 0))} icon={AlertTriangle} kind="period" />
                <MetricCard label="Product cost" value={money(k.c.productCost)} icon={Package} kind="period" unavailableReason="Missing for some units" definition={DEFINITIONS.refunds} />
                <MetricCard label="Amazon fees" value={money((k.c.referralFees ?? 0) + (k.c.fulfilmentFees ?? 0) + (k.c.otherFees ?? 0))} icon={Wallet} kind="period"
                  hint={`Referral ${money(k.c.referralFees) ?? 'n/a'} · fulfilment ${money(k.c.fulfilmentFees) ?? 'n/a'} · ${k.c.feeBasis === 'ACTUAL' ? 'actual' : k.c.feeBasis === 'NONE' ? 'not available' : 'includes estimates'}`} />
                <MetricCard label="Shipping and other variable" value={money((k.c.shipping ?? 0) + (k.c.otherVariable ?? 0))} icon={Boxes} kind="period" />
                <MetricCard label="Advertising (products)" value={money(k.c.adSpend)} icon={Wallet} kind="period" definition="Sponsored Products spend attributed to the advertised SKUs." />
                <MetricCard label="Contribution after advertising" value={money(k.c.afterAds)} icon={BadgeIndianRupee} accent={k.c.afterAds !== null && k.c.afterAds < 0 ? 'red' : 'green'} kind="period"
                  definition={DEFINITIONS.afterAds} unavailableReason={k.c.missing.length ? `Missing: ${k.c.missing.join('; ')}.` : undefined}
                  hint={k.c.afterAds === null && k.complete.length ? `${money(k.partialAfter)} for the ${k.complete.length} of ${d.products.length} products with complete data` : k.c.marginAfterPct !== null ? `${pctText(k.c.marginAfterPct)} of net sales` : undefined} />
                <MetricCard label="Estimated operating contribution" value={money(k.c.estimatedOperating)} icon={BadgeIndianRupee} kind="period"
                  unavailableReason={d.settings.overhead_allocation_pct > 0 ? 'Requires complete contribution data' : 'No overhead allocation configured (API Integration Settings > Analysis).'}
                  definition={`Contribution after advertising minus ${d.settings.overhead_allocation_pct}% allocated overhead. An estimate.`} />
              </div>
            </section>

            <section aria-labelledby="amz-stock">
              <SectionHeading id="amz-stock" title="Inventory" description="Amazon fulfillable stock where synchronised, otherwise ERP warehouse stock. Current position." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Available sellable stock" value={k.known.length ? num(k.stock) : null} icon={Boxes} kind="current" unavailableReason="No stock source for the listings"
                  hint={`${k.known.length} of ${d.products.length} listings with a known quantity`} />
                <MetricCard label="Average stock cover" value={k.avgCover === null ? null : `${num(k.avgCover)} days`} icon={Boxes} kind="current" definition={DEFINITIONS.stockCover} unavailableReason="No recent sales" />
                <MetricCard label="Products at stockout risk" value={num(k.atRisk.length)} icon={AlertTriangle} accent={k.atRisk.length ? 'red' : 'neutral'} kind="current"
                  hint={`Overstocked: ${d.products.filter((p) => p.stockStatus === 'OVERSTOCK').length}`} />
                <MetricCard label="Advertising spend at risk (low stock)" value={money(k.spendAtRisk)} icon={Wallet} accent={k.spendAtRisk > 0 ? 'orange' : 'neutral'} kind="period"
                  hint={`Replenishment recommended for ${k.repl.length} listing(s) with a lead time`} />
              </div>
            </section>

            <section aria-labelledby="amz-charts" className="grid gap-6 xl:grid-cols-2">
              <h2 id="amz-charts" className="sr-only">Charts</h2>
              <ChartCard title="Sales vs advertising spend" description="Ordered sales and account ad spend per day" isEmpty={!daily.data?.days.length}>
                <PairedBarChart aName="Ordered sales" bName="Ad spend" aColor={TONE_FILL.info} bColor={TONE_FILL.warning} valueFormatter={(v) => money(v) ?? ''}
                  data={(daily.data?.days ?? []).map((x) => ({ label: short(x.date), a: Number(x.components?.ordered_sales ?? 0), b: Number(x.account_ads?.spend ?? 0) }))} />
              </ChartCard>
              <ChartCard title="Daily contribution after advertising" description="Days with incomplete cost data are left out" isEmpty={!daily.data?.days.some((x) => x.components && contribution(x.components).afterAds !== null)}>
                <TrendLineChart seriesName="Contribution after ads" valueFormatter={(v) => money(v) ?? ''}
                  data={(daily.data?.days ?? []).flatMap((x) => { const v = x.components ? contribution(x.components).afterAds : null; return v === null ? [] : [{ label: short(x.date), value: v }] })} />
              </ChartCard>
              <ChartCard title="ACoS trend" description="Account ACoS per day (days without attributed sales left out)" isEmpty={!k.adsAvailable}>
                <TrendLineChart seriesName="ACoS %" valueFormatter={(v) => `${v.toFixed(1)}%`}
                  data={(daily.data?.days ?? []).flatMap((x) => { const v = acos(x.account_ads?.spend, x.account_ads?.sales); return v === null ? [] : [{ label: short(x.date), value: v }] })} />
              </ChartCard>
              <ChartCard title="ROAS trend" description="Account ROAS per day" isEmpty={!k.adsAvailable}>
                <TrendLineChart seriesName="ROAS" valueFormatter={(v) => v.toFixed(2)}
                  data={(daily.data?.days ?? []).flatMap((x) => { const v = roas(x.account_ads?.sales, x.account_ads?.spend); return v === null ? [] : [{ label: short(x.date), value: v }] })} />
              </ChartCard>
              <ChartCard title="Sales by product" description="Top 10 by ordered sales" isEmpty={!d.products.some((p) => (p.orderedSales ?? 0) > 0)}>
                <HorizontalBarChart seriesName="Ordered sales" valueFormatter={(v) => money(v) ?? ''}
                  data={[...d.products].sort((a, b) => (b.orderedSales ?? 0) - (a.orderedSales ?? 0)).slice(0, 10).map((p) => ({ label: p.sku, value: p.orderedSales ?? 0 }))} />
              </ChartCard>
              <ChartCard title="Contribution after advertising by SKU" description="Products with complete cost data" isEmpty={!k.complete.length}>
                <SignedBarChart seriesName="Contribution after ads" valueFormatter={(v) => money(v) ?? ''}
                  data={[...k.complete].sort((a, b) => Math.abs(b.contribution.afterAds ?? 0) - Math.abs(a.contribution.afterAds ?? 0)).slice(0, 10).map((p) => ({ label: p.sku, value: p.contribution.afterAds ?? 0 }))} />
              </ChartCard>
              <ChartCard title="Campaign performance" description="Spend vs attributed sales, top 8 by spend" isEmpty={!d.campaigns.length}>
                <PairedBarChart aName="Spend" bName="Attributed sales" aColor={TONE_FILL.warning} bColor={TONE_FILL.success} valueFormatter={(v) => money(v) ?? ''}
                  data={d.campaigns.slice(0, 8).map((c) => ({ label: c.row.name.slice(0, 18), a: c.row.spend, b: c.row.sales }))} />
              </ChartCard>
              <ChartCard title="Budget allocation by campaign" description="Current daily budgets" isEmpty={!d.campaigns.some((c) => c.row.daily_budget)}>
                <HorizontalBarChart seriesName="Daily budget" valueFormatter={(v) => money(v) ?? ''}
                  data={d.campaigns.filter((c) => c.row.daily_budget).map((c) => ({ label: c.row.name.slice(0, 22), value: c.row.daily_budget ?? 0 }))} />
              </ChartCard>
              <ChartCard title="Stock cover vs demand" description="Days of cover at the last 28 days' sales rate (stockout risk in red)" isEmpty={!d.products.some((p) => p.stockCover !== null)}>
                <HorizontalBarChart seriesName="Days of cover" valueFormatter={(v) => `${Math.round(v)} days`}
                  data={d.products.filter((p) => p.stockCover !== null).sort((a, b) => (a.stockCover ?? 0) - (b.stockCover ?? 0)).slice(0, 12)
                    .map((p) => ({ label: p.sku, value: Math.min(p.stockCover ?? 0, 365), color: p.stockStatus === 'STOCKOUT_RISK' ? TONE_FILL.danger : p.stockStatus === 'LOW' ? TONE_FILL.warning : TONE_FILL.info }))} />
              </ChartCard>
            </section>
          </div>
        )}
    </>
  )
}
