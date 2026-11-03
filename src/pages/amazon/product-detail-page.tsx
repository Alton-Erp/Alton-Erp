import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { TONE_FILL } from '@/components/charts/chart-theme'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AmazonToolbar, DemoBanner, Val } from '@/features/amazon/amazon-ui'
import { CONFIDENCE_TONE, money, num, pctText, PROFIT_LABEL, STOCK_LABEL } from '@/features/amazon/format'
import { affordableCpc, DEFINITIONS, forecastDemand, n, replenishment } from '@/features/amazon/metrics'
import { useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { MiniTable } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchDailySeries, fetchRecommendations } from '@/services/amazon'

const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })

export default function AmazonProductDetailPage() {
  const { sku = '' } = useParams()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const daily = useAsync(() => fetchDailySeries(view.from, view.to, demo, sku), [view.from, view.to, demo, sku, refresh])
  const recs = useAsync(() => fetchRecommendations(demo), [demo, refresh])
  const [assumed, setAssumed] = useState('')
  const p = data.data?.productMap.get(sku)
  const s = data.data?.settings
  const assumedCvr = n(assumed)
  const cpcCalc = p && s ? affordableCpc({ targetAcos: p.targets.targetAcos, avgOrderValue: p.avgOrderValue, clicks: p.ads.clicks, orders: p.ads.orders, minClicks: s.min_clicks_for_decision,
    assumedConversion: assumedCvr }) : null
  const forecast = p ? forecastDemand(p.row.velocity?.daily_28 ?? [], 30) : null
  const repl = p && s ? replenishment({ available: p.stockForCover, incoming: p.row.stock.incoming_production, avgDaily: p.avgDailyUnits, leadTimeDays: p.row.lead_time_days,
    safetyDays: s.low_stock_cover_days, minStock: p.row.min_stock }) : null
  return (
    <>
      <PageHeader title={`Product ${sku}`} description={p?.label ?? 'Amazon listing'} actions={<Link to="/amazon/products" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> All products</Link>} />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((x) => x + 1)} />
      <DemoBanner demo={demo} />
      {data.loading && !data.data ? <LoadingState variant="table" rows={6} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : !p || !s ? <Card><CardContent className="p-6 text-sm">This SKU has no data in the selected {demo ? 'demo' : 'live'} dataset.</CardContent></Card> : (
          <div className="grid gap-6 xl:grid-cols-3">
            <div className="space-y-6 xl:col-span-2">
              <Card>
                <CardHeader><div><CardTitle>{p.label}</CardTitle><CardDescription>ASIN {p.row.asin ?? 'n/a'} · {p.row.fulfillment_channel ?? 'channel unknown'} · {p.row.listing_status ?? 'status unknown'} ·
                  {p.row.product_id ? ` ERP product ${p.row.erp_sku}` : ' not mapped to an ERP product'}</CardDescription></div>
                  <div className="flex gap-2"><StatusBadge label={PROFIT_LABEL[p.profitStatus][0]} tone={PROFIT_LABEL[p.profitStatus][1]} /><StatusBadge label={STOCK_LABEL[p.stockStatus][0]} tone={STOCK_LABEL[p.stockStatus][1]} /></div>
                </CardHeader>
                <CardContent>
                  {p.issues.length > 0 && <ul className="mb-3 list-disc pl-5 text-sm text-amber-800">{p.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
                  <MiniTable headers={['Contribution (ex-GST)', 'Amount', 'Basis']} align={['left', 'right', 'left']} rows={[
                    ['Gross ordered sales', <Val key="g" v={money(p.contribution.grossSales)} />, 'As reported (incl. GST if prices include GST)'],
                    ['Net sales ex-GST (after refunds, discounts)', <Val key="n" v={money(p.contribution.netSalesExGst)} />, `GST ${p.row.gst_rate ?? 'missing'}% (${p.row.gst_source ?? 'n/a'})`],
                    ['− Product cost', <Val key="c" v={money(p.contribution.productCost)} />, `${money(p.row.unit_cost) ?? 'missing'} per unit (${p.row.cost_source})`],
                    ['− Referral fees', <Val key="r" v={money(p.contribution.referralFees)} />, p.contribution.feeBasis],
                    ['− Fulfilment fees', <Val key="f" v={money(p.contribution.fulfilmentFees)} />, p.contribution.feeBasis],
                    ['− Other Amazon fees', <Val key="o" v={money(p.contribution.otherFees)} />, 'Settlement data'],
                    ['− Shipping', <Val key="s" v={money(p.contribution.shipping)} />, 'Listing setting per unit'],
                    ['− Other variable costs', <Val key="v" v={money(p.contribution.otherVariable)} />, 'Listing setting per unit'],
                    [<strong key="b">Contribution before advertising</strong>, <strong key="bv"><Val v={money(p.contribution.beforeAds)} /></strong>, pctText(p.contribution.marginBeforePct) ?? ''],
                    ['− Advertising spend', money(p.ads.spend), 'Sponsored Products, this SKU'],
                    [<strong key="a">Contribution after advertising</strong>, <strong key="av"><Val v={money(p.contribution.afterAds)} /></strong>, pctText(p.contribution.marginAfterPct) ?? ''],
                  ]} />
                  {p.contribution.estimated.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Includes estimates: {p.contribution.estimated.join('; ')}.</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{DEFINITIONS.refunds}</p>
                </CardContent>
              </Card>
              <ChartCard title="Sales and advertising history" description="Ordered sales and ad spend for this SKU per day" isEmpty={!daily.data?.days.some((x) => x.components)} loading={daily.loading}>
                <PairedBarChart aName="Ordered sales" bName="Ad spend" aColor={TONE_FILL.info} bColor={TONE_FILL.warning} valueFormatter={(v) => money(v) ?? ''}
                  data={(daily.data?.days ?? []).map((x) => ({ label: short(x.date), a: Number(x.components?.ordered_sales ?? 0), b: Number(x.components?.ad_spend ?? 0) }))} />
              </ChartCard>
              <Card>
                <CardHeader><div><CardTitle>Recommended actions</CardTitle><CardDescription>Open recommendations for this product (generate them on the AI Recommendations page).</CardDescription></div></CardHeader>
                <CardContent>
                  {(recs.data ?? []).filter((r) => r.status === 'OPEN' && (r.entity_key === sku || String(r.evidence?.seller_sku ?? '') === sku)).length === 0
                    ? <p className="text-sm text-muted-foreground">No open recommendations for this product.</p>
                    : <ul className="space-y-2 text-sm">{(recs.data ?? []).filter((r) => r.status === 'OPEN' && r.entity_key === sku).map((r) => (
                      <li key={r.id} className="rounded-lg border p-3"><p className="font-medium">{r.title} <StatusBadge label={`${r.confidence} confidence`} tone={CONFIDENCE_TONE[r.confidence]} /></p>
                        <p className="text-muted-foreground">{r.issue}</p><p>{r.proposed_action}</p></li>))}</ul>}
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader><div><CardTitle>Advertising targets</CardTitle><CardDescription>{DEFINITIONS.breakEvenAcos}</CardDescription></div></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <MiniTable headers={['Metric', 'Value']} align={['left', 'right']} rows={[
                    ['Break-even ACoS', <Val key="be" v={pctText(p.targets.breakEvenAcos)} />],
                    ['Target ACoS', <Val key="t" v={pctText(p.targets.targetAcos)} />],
                    ['Target set by', p.targets.targetSource.replace(/_/g, ' ').toLowerCase()],
                    ['Actual ACoS', <Val key="a" v={pctText(p.ads.acos)} title="No attributed sales" />],
                    ['ROAS / TACoS', <span key="r"><Val v={num(p.ads.roas, 2)} /> / <Val v={pctText(p.ads.tacos)} /></span>],
                    ['Clicks / orders', `${num(p.ads.clicks)} / ${num(p.ads.orders)}`],
                    ['Max cost per order', <Val key="mc" v={money(cpcCalc?.maxCostPerOrder ?? null)} />],
                    ['Maximum affordable CPC', <Val key="cpc" v={money(cpcCalc?.maxCpc ?? null, true)} />],
                    ['Current CPC', <Val key="cc" v={money(p.ads.cpc, true)} />],
                  ]} />
                  {p.targets.note && <p className="text-xs text-amber-800">{p.targets.note}</p>}
                  {cpcCalc?.note && <p className="text-xs text-muted-foreground">{cpcCalc.note}</p>}
                  <div className="space-y-1"><Label htmlFor="pd-cvr">Assumed click-to-order conversion % (optional)</Label>
                    <Input id="pd-cvr" className="w-32" inputMode="decimal" value={assumed} onChange={(e) => setAssumed(e.target.value)} placeholder="e.g. 8" /></div>
                  <p className="text-xs text-muted-foreground">{DEFINITIONS.maxCpc} Conversion used: {cpcCalc?.conversionUsed === null || cpcCalc === null ? 'n/a' : `${((cpcCalc.conversionUsed ?? 0) * 100).toFixed(2)}%`} ({cpcCalc?.conversionBasis.replace(/_/g, ' ').toLowerCase()}).</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Inventory</CardTitle><CardDescription>Each quantity with its source and time.</CardDescription></div></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <MiniTable headers={['Source', 'Quantity', 'As of']} align={['left', 'right', 'left']} rows={[
                    ['Amazon fulfillable', <Val key="a" v={num(p.row.stock.amazon_fulfillable)} />, p.row.stock.amazon_as_of ? formatDateTime(p.row.stock.amazon_as_of) : 'not synchronised'],
                    ['Amazon inbound', <Val key="i" v={num(p.row.stock.amazon_inbound)} />, p.row.stock.amazon_as_of ? formatDateTime(p.row.stock.amazon_as_of) : '—'],
                    ['ERP warehouse available', <Val key="e" v={num(p.row.stock.erp_available)} />, p.row.stock.erp_as_of ? 'live' : 'not mapped'],
                    ['Incoming production', <Val key="pr" v={num(p.row.stock.incoming_production)} />, 'open production orders'],
                  ]} />
                  <p>Average daily units (28 days): <strong>{num(p.avgDailyUnits, 2) ?? 'n/a'}</strong> · cover <strong>{p.stockCover === null ? 'n/a' : `${num(p.stockCover)} days`}</strong></p>
                  {forecast && <p>30-day demand forecast: <strong>{forecast.expected === null ? 'n/a' : `${num(forecast.expected)} (${num(forecast.low)}–${num(forecast.high)})`}</strong>{forecast.reliable ? '' : ' — limited history, low reliability'}</p>}
                  {repl && <p>Replenishment: <strong>{repl.quantity === null ? 'not calculated' : num(repl.quantity)}</strong> — {repl.reason}</p>}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
    </>
  )
}
