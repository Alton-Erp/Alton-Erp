import { ArrowLeft, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AmazonToolbar, DemoBanner, Val } from '@/features/amazon/amazon-ui'
import { ChangeRequestDialog } from '@/features/amazon/change-dialog'
import { campaignHealth, money, num, pctText } from '@/features/amazon/format'
import { acos, cpc, ctr } from '@/features/amazon/metrics'
import { useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { MiniTable } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchCampaignDetail } from '@/services/amazon'

const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })

export default function AmazonCampaignDetailPage() {
  const { campaignId = '' } = useParams()
  const { has } = usePermissions()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  const detail = useAsync(() => fetchCampaignDetail(campaignId, view.from, view.to, demo), [campaignId, view.from, view.to, demo, refresh])
  const [proposing, setProposing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const c = data.data?.campaigns.find((x) => x.row.campaign_id === campaignId)
  const det = detail.data
  return (
    <>
      <PageHeader title={c?.row.name ?? 'Campaign'} description="Campaign performance, targets and advertised products"
        actions={<Link to="/amazon/campaigns" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> All campaigns</Link>} />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={detail.loading} onRefresh={() => setRefresh((n) => n + 1)}>
        {has('amazon_ads.request') && det && data.data && <Button onClick={() => setProposing(true)}><Pencil /> Propose change</Button>}
      </AmazonToolbar>
      <DemoBanner demo={demo} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {detail.loading && !det ? <LoadingState variant="table" rows={6} /> : detail.error ? <ErrorState message={describeDataError(detail.error)} onRetry={detail.reload} /> : det && (
        <div className="space-y-6">
          {c && <div className="flex flex-wrap items-center gap-2 text-sm"><StatusBadge label={campaignHealth(c)[0]} tone={campaignHealth(c)[1]} />
            <span>Spend {money(c.row.spend)} · attributed sales {money(c.row.sales)} · ACoS {pctText(c.acos) ?? 'n/a'} (target {pctText(c.targetAcos) ?? 'n/a'}, break-even {pctText(c.breakEvenAcos) ?? 'n/a'})
              · daily budget {money(det.campaign.daily_budget) ?? 'n/a'} · capped on {c.row.budget_constrained_days} of {c.row.days_with_data} days</span></div>}
          <ChartCard title="Spend vs attributed sales per day" isEmpty={!det.days.length}>
            <PairedBarChart aName="Spend" bName="Attributed sales" aColor={TONE_FILL.warning} bColor={TONE_FILL.success} valueFormatter={(v) => money(v) ?? ''}
              data={det.days.map((x) => ({ label: short(x.date), a: Number(x.spend), b: Number(x.sales) }))} />
          </ChartCard>
          <Card>
            <CardHeader><div><CardTitle>Targets and keywords</CardTitle><CardDescription>Performance from the search-term report, bids from the last entity sync.</CardDescription></div></CardHeader>
            <CardContent>
              <MiniTable headers={['Target', 'Match', 'State', 'Bid', 'Clicks', 'CTR', 'CPC', 'Spend', 'Orders', 'Sales', 'ACoS']} align={['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
                rows={det.targets.map((t) => [t.expression, t.match_type ?? t.target_type, t.state, <Val key="b" v={money(t.bid, true)} />, num(t.clicks), <Val key="c" v={pctText(ctr(t.clicks, t.impressions), 2)} />,
                  <Val key="p" v={money(cpc(t.spend, t.clicks), true)} />, money(t.spend), num(t.orders), money(t.sales), <Val key="a" v={pctText(acos(t.spend, t.sales))} />])} empty="No targets synchronised for this campaign." />
            </CardContent>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><div><CardTitle>Advertised products</CardTitle></div></CardHeader>
              <CardContent><MiniTable headers={['SKU', 'Spend', 'Sales', 'Orders', 'ACoS']} align={['left', 'right', 'right', 'right', 'right']}
                rows={det.products.map((p) => [<Link key="s" className="text-primary hover:underline" to={`/amazon/products/${encodeURIComponent(p.seller_sku)}`}>{p.seller_sku}</Link>, money(p.spend), money(p.sales), num(p.orders),
                  <Val key="a" v={pctText(acos(p.spend, p.sales))} />])} empty="No advertised-product data." /></CardContent>
            </Card>
            <Card>
              <CardHeader><div><CardTitle>Ad groups and placements</CardTitle></div></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <MiniTable headers={['Ad group', 'State', 'Default bid']} align={['left', 'left', 'right']} rows={det.ad_groups.map((g) => [g.name, g.state, <Val key="b" v={money(g.default_bid, true)} />])} empty="No ad groups." />
                <p className="text-xs text-muted-foreground">Placements: {det.placements.reason}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
      {proposing && det && data.data && (
        <ChangeRequestDialog settings={data.data.settings} onClose={() => setProposing(false)} onDone={(m) => { setProposing(false); setMessage(m) }}
          target={{ campaignId: det.campaign.campaign_id, campaignName: det.campaign.name, dailyBudget: det.campaign.daily_budget, state: det.campaign.state,
            targets: det.targets, adGroups: det.ad_groups.map((g) => ({ ad_group_id: g.ad_group_id, name: g.name })) }} />
      )}
    </>
  )
}
