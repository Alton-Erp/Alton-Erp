import { Link2, Plus, Wand2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AmazonToolbar, DataCoverage, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { ProductAnalysis } from '@/features/amazon/analysis'
import { money, num, pctText, PROFIT_LABEL } from '@/features/amazon/format'
import { ListingDialog } from '@/features/amazon/listing-dialog'
import { contribution, DEFINITIONS, sumComponents } from '@/features/amazon/metrics'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { MiniTable } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { autoMapListings, fetchErpProducts, fetchListings, type Listing } from '@/services/amazon'

const fees = (p: ProductAnalysis) => {
  const c = p.contribution
  return c.referralFees === null && c.fulfilmentFees === null && c.otherFees === null ? null : (c.referralFees ?? 0) + (c.fulfilmentFees ?? 0) + (c.otherFees ?? 0)
}

export default function AmazonProfitabilityPage() {
  const { has } = usePermissions()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [tab, setTab] = useState<'profit' | 'mapping'>('profit')
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const d = data.data
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      <FilterTabs className="mb-4" label="Profitability view" value={tab} onChange={setTab}
        options={[{ value: 'profit', label: 'Contribution by product' }, { value: 'mapping', label: 'Product mapping & costs' }]} />
      {tab === 'mapping' ? <MappingTab demo={demo} canManage={has('amazon.manage')} onChanged={() => setRefresh((n) => n + 1)} />
        : data.loading && !d ? <LoadingState variant="table" rows={8} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
          : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : d && <ProfitTab products={d.products} overheadPct={d.settings.overhead_allocation_pct} coverage={<DataCoverage dataset={d} />} />}
    </>
  )
}

function ProfitTab({ products, overheadPct, coverage }: { products: ProductAnalysis[]; overheadPct: number; coverage: ReactNode }) {
  const total = contribution(sumComponents(products.map((p) => p.row.totals ?? {})), { overheadPct })
  const columns: DataTableColumn<ProductAnalysis>[] = [
    { id: 'sku', header: 'SKU', cell: (p) => <div><p className="font-medium">{p.sku}</p><p className="line-clamp-1 max-w-48 text-xs text-muted-foreground">{p.label}</p></div>,
      searchValue: (p) => `${p.sku} ${p.label} ${p.row.asin ?? ''}`, sortValue: (p) => p.sku },
    { id: 'net', header: 'Net sales ex-GST', align: 'right', cell: (p) => <Val v={money(p.contribution.netSalesExGst)} />, sortValue: (p) => p.contribution.netSalesExGst },
    { id: 'cost', header: 'Product cost', align: 'right', cell: (p) => <span title={p.row.cost_source}><Val v={money(p.contribution.productCost)} /></span> },
    { id: 'fees', header: 'Amazon fees', align: 'right', cell: (p) => <span><Val v={money(fees(p))} /> <span className="text-xs text-muted-foreground">{p.contribution.feeBasis.toLowerCase()}</span></span> },
    { id: 'ship', header: 'Shipping + other', align: 'right', cell: (p) => money((p.contribution.shipping ?? 0) + (p.contribution.otherVariable ?? 0)) },
    { id: 'before', header: 'Before ads', align: 'right', cell: (p) => <span><Val v={money(p.contribution.beforeAds)} title={p.contribution.missing.join('; ')} />
      <span className="block text-xs text-muted-foreground">{pctText(p.contribution.marginBeforePct) ?? ''}</span></span>, sortValue: (p) => p.contribution.beforeAds },
    { id: 'ads', header: 'Ad spend', align: 'right', cell: (p) => money(p.ads.spend), sortValue: (p) => p.ads.spend },
    { id: 'after', header: 'After ads', align: 'right', cell: (p) => <span className={(p.contribution.afterAds ?? 0) < 0 ? 'font-medium text-shortage' : ''}><Val v={money(p.contribution.afterAds)} title={p.contribution.missing.join('; ')} />
      <span className="block text-xs text-muted-foreground">{pctText(p.contribution.marginAfterPct) ?? ''}</span></span>, sortValue: (p) => p.contribution.afterAds },
    { id: 'acos', header: 'ACoS', align: 'right', cell: (p) => <Val v={pctText(p.ads.acos)} title="No attributed sales" />, sortValue: (p) => p.ads.acos },
    { id: 'be', header: 'Break-even / target ACoS', align: 'right', cell: (p) => <span title={p.targets.note ?? p.targets.targetSource}><Val v={pctText(p.targets.breakEvenAcos)} /> / <Val v={pctText(p.targets.targetAcos)} /></span>,
      sortValue: (p) => p.targets.breakEvenAcos },
    { id: 'cpo', header: 'Max cost / order', align: 'right', cell: (p) => <Val v={money(p.affordable.maxCostPerOrder)} /> },
    { id: 'cpc', header: 'Max CPC', align: 'right', cell: (p) => <span title={p.affordable.note ?? p.affordable.conversionBasis}><Val v={money(p.affordable.maxCpc, true)} />
      <span className="block text-xs text-muted-foreground">current {money(p.ads.cpc, true) ?? 'n/a'}</span></span> },
    { id: 'status', header: 'Status', cell: (p) => <div className="flex flex-col gap-1"><StatusBadge label={PROFIT_LABEL[p.profitStatus][0]} tone={PROFIT_LABEL[p.profitStatus][1]} />
      {p.issues.slice(0, 2).map((i) => <span key={i} className="text-xs text-muted-foreground">{i}</span>)}</div> },
  ]
  return (
    <div className="space-y-6">
      {coverage}
      <Card>
        <CardHeader><div><CardTitle>Contribution statement (all products)</CardTitle>
          <CardDescription>Ex-GST. {total.estimated.length ? `Includes estimates: ${total.estimated.join('; ')}.` : 'Based on actual settlement fees.'}</CardDescription></div></CardHeader>
        <CardContent>
          <MiniTable headers={['Line', 'Amount']} rows={[
            ['Gross ordered sales (as reported)', <Val key="g" v={money(total.grossSales)} />],
            ['Net sales ex-GST (after refunds and discounts)', <Val key="n" v={money(total.netSalesExGst)} />],
            ['− Product cost', <Val key="c" v={money(total.productCost)} />],
            ['− Referral fees', <Val key="r" v={money(total.referralFees)} />],
            ['− Fulfilment fees', <Val key="f" v={money(total.fulfilmentFees)} />],
            ['− Other Amazon fees', <Val key="o" v={money(total.otherFees)} />],
            ['− Shipping and other variable costs', money((total.shipping ?? 0) + (total.otherVariable ?? 0))],
            [<strong key="b">Contribution before advertising</strong>, <strong key="bv"><Val v={money(total.beforeAds)} /></strong>],
            ['− Advertising (product-attributed)', money(total.adSpend)],
            [<strong key="a">Contribution after advertising</strong>, <strong key="av"><Val v={money(total.afterAds)} /></strong>],
            [`− Allocated overhead (${overheadPct}% of net sales, estimate)`, <Val key="oh" v={money(total.overhead)} title="No overhead allocation configured" />],
            ['Estimated operating contribution', <Val key="eo" v={money(total.estimatedOperating)} />],
          ]} />
          {total.missing.length > 0 && <p className="mt-3 text-sm text-amber-800">Totals unavailable while inputs are missing: {total.missing.join('; ')}. Complete them in Product mapping &amp; costs.</p>}
        </CardContent>
      </Card>
      <DataTable title="Contribution by product" description="Hover a value for the reason it is unavailable or how a target was set." columns={columns} data={products} getRowId={(p) => p.sku} pageSize={25}
        searchPlaceholder="Search SKU or name" emptyState={{ icon: Link2, title: 'No products', description: 'No listings for the period.' }} />
      <Card>
        <CardHeader><div><CardTitle>Definitions</CardTitle></div></CardHeader>
        <CardContent><dl className="grid gap-2 text-sm md:grid-cols-2">{Object.entries(DEFINITIONS).map(([k, v]) => <div key={k}><dt className="sr-only">{k}</dt><dd className="text-muted-foreground">{v}</dd></div>)}</dl></CardContent>
      </Card>
    </div>
  )
}

function MappingTab({ demo, canManage, onChanged }: { demo: boolean; canManage: boolean; onChanged: () => void }) {
  const [reload, setReload] = useState(0)
  const listings = useAsync(() => fetchListings(demo), [demo, reload])
  const products = useAsync(() => (canManage ? fetchErpProducts() : Promise.resolve([])), [canManage])
  const [editing, setEditing] = useState<Listing | 'new' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const productName = new Map((products.data ?? []).map((p) => [p.id, `${p.sku} — ${p.product_name}`]))
  const done = (m: string) => { setEditing(null); setMessage(m); setReload((n) => n + 1); onChanged() }
  const autoMap = async () => {
    setBusy(true); setError(null)
    try {
      const r = await autoMapListings()
      done(`${r.mapped} listing(s) mapped by exact SKU match${r.conflicts ? `, ${r.conflicts} skipped (ASIN already mapped to another product)` : ''}.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const columns: DataTableColumn<Listing>[] = [
    { id: 'sku', header: 'Seller SKU / ASIN', cell: (l) => <div><p className="font-medium">{l.seller_sku}</p><p className="text-xs text-muted-foreground">{l.asin ?? 'no ASIN'} · {l.data_source}</p></div>,
      searchValue: (l) => `${l.seller_sku} ${l.asin ?? ''} ${l.title ?? ''}`, sortValue: (l) => l.seller_sku },
    { id: 'title', header: 'Title', cell: (l) => <span className="line-clamp-2 max-w-64 text-xs">{l.title ?? ''}</span> },
    { id: 'erp', header: 'ERP product', cell: (l) => l.product_id ? <span className="text-xs">{productName.get(l.product_id) ?? 'Mapped'}</span> : <StatusBadge label={l.is_demo ? 'Demo (not mapped)' : 'Not mapped'} tone={l.is_demo ? 'neutral' : 'warning'} /> },
    { id: 'cost', header: 'Cost override', align: 'right', cell: (l) => <Val v={money(l.unit_cost_override, true)} title="Uses the ERP product cost" /> },
    { id: 'gst', header: 'GST %', align: 'right', cell: (l) => <Val v={num(l.gst_rate, 2)} title="Uses ERP GST rate" /> },
    { id: 'fees', header: 'Fee estimates', align: 'right', cell: (l) => <span className="text-xs">{l.referral_fee_pct ?? '-'}% · {money(l.fulfilment_fee_per_unit, true) ?? '-'}</span> },
    { id: 'lead', header: 'Lead time', align: 'right', cell: (l) => <Val v={l.lead_time_days === null ? null : `${l.lead_time_days} d`} title="Not set" /> },
    { id: 'upd', header: 'Costs updated', cell: (l) => <span className="text-xs">{l.costs_updated_at ? formatDateTime(l.costs_updated_at) : '-'}</span> },
  ]
  if (listings.loading && !listings.data) return <LoadingState variant="table" rows={6} />
  if (listings.error) return <ErrorState message={describeDataError(listings.error)} onRetry={listings.reload} />
  const rows = listings.data ?? []
  return (
    <div className="space-y-4">
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <p className="text-sm text-muted-foreground">
        {rows.filter((l) => l.product_id).length} of {rows.length} listings mapped. Product cost comes from the cost override if set, otherwise the ERP product's standard cost;
        GST from the override or the ERP product. Fee settings are estimates used only for days without settlement data. Mapping never changes ERP products or stock.
      </p>
      <DataTable title={demo ? 'Demo listings' : 'Amazon listings'} columns={columns} data={rows} getRowId={(l) => l.id} pageSize={25} searchPlaceholder="Search SKU, ASIN or title"
        onRowClick={canManage ? (l) => setEditing(l) : undefined}
        toolbar={canManage && !demo ? <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void autoMap()}><Wand2 /> Auto-map by SKU</Button>
          <Button onClick={() => setEditing('new')}><Plus /> Manual listing</Button></div> : undefined}
        emptyState={{ icon: Link2, title: 'No listings', description: demo ? 'Load demo data in API Integration Settings.' : 'Synchronise the Selling Partner API, import a listings file or add a manual listing.' }} />
      {editing && <ListingDialog listing={editing === 'new' ? null : editing} products={products.data ?? []} onClose={() => setEditing(null)} onSaved={done} />}
    </div>
  )
}
