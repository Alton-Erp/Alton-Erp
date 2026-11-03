import { FlaskConical, Info, PlugZap, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AMAZON_PRESETS, type AmazonPreset, type AmazonView, type AmazonDataset } from '@/features/amazon/use-amazon'
import { formatDateTime } from '@/lib/format'

/** A value or a muted "Unavailable" (never a misleading zero). */
export function Val({ v, title }: { v: string | null; title?: string }) {
  return v === null ? <span className="text-xs text-muted-foreground" title={title ?? 'Not available: missing data'}>Unavailable</span> : <>{v}</>
}

/** Period, LIVE / DEMO switch and refresh: shown at the top of every Amazon page. */
export function AmazonToolbar({ view, setPreset, setRange, setMode, onRefresh, loading, children }: {
  view: AmazonView
  setPreset: (p: AmazonPreset) => void
  setRange: (from: string, to: string) => void
  setMode: (m: 'LIVE' | 'DEMO') => void
  onRefresh?: () => void
  loading?: boolean
  children?: ReactNode
}) {
  return (
    <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
      <div className="space-y-1"><Label htmlFor="amz-period">Period</Label>
        <Select value={view.preset} onValueChange={(v) => setPreset(v as AmazonPreset)}><SelectTrigger id="amz-period" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{AMAZON_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><Label htmlFor="amz-from">From</Label><Input id="amz-from" type="date" className="w-40" value={view.from} max={view.to} onChange={(e) => e.target.value && setRange(e.target.value, view.to)} /></div>
      <div className="space-y-1"><Label htmlFor="amz-to">To</Label><Input id="amz-to" type="date" className="w-40" value={view.to} min={view.from} onChange={(e) => e.target.value && setRange(view.from, e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="amz-mode">Data</Label>
        <Select value={view.mode} onValueChange={(v) => setMode(v as 'LIVE' | 'DEMO')}><SelectTrigger id="amz-mode" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="LIVE">Live (synchronised / imported)</SelectItem><SelectItem value="DEMO">Demo data</SelectItem></SelectContent></Select></div>
      {children}
      {onRefresh && <Button variant="outline" className="ml-auto" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</Button>}
    </CardContent></Card>
  )
}

/** Visible on every page in demo mode. */
export function DemoBanner({ demo }: { demo: boolean }) {
  if (!demo) return null
  return (
    <div role="note" className="mb-4 flex items-start gap-3 rounded-lg border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <FlaskConical aria-hidden className="mt-0.5 size-5 shrink-0" />
      <p><span className="mr-2 rounded bg-amber-500 px-1.5 py-0.5 text-xs font-bold tracking-wide text-white">DEMO DATA</span>
        Fictitious products, sales and campaigns for previewing the module. They are not Amazon data, are kept separate from live data and ERP records, and can be removed in API Integration Settings.</p>
    </div>
  )
}

/** Empty / disconnected state for LIVE mode without data. */
export function NoAmazonData({ dataset, demo }: { dataset?: AmazonDataset; demo: boolean }) {
  const { has } = usePermissions()
  const conns = dataset?.status.connections ?? []
  const connected = conns.filter((c) => c.status === 'CONNECTED')
  return (
    <Card><CardContent className="space-y-3 p-6 text-sm">
      <p className="flex items-center gap-2 text-base font-semibold"><PlugZap className="size-5 text-muted-foreground" /> {demo ? 'No demo data loaded' : 'No Amazon data for this period'}</p>
      {demo ? <p>Load the demo dataset in <Link className="text-primary hover:underline" to="/amazon/settings">API Integration Settings</Link> to preview the module.</p> : <>
        <p>{connected.length ? `Connected: ${connected.map((c) => (c.api === 'SP_API' ? 'Selling Partner API' : 'Ads API')).join(', ')}. Run a synchronisation or choose another period.`
          : 'Neither Amazon API is connected yet. Until the credentials are configured you can import Amazon report downloads (CSV / Excel), or preview the module with demo data.'}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm"><Link to="/amazon/settings">{has('amazon_integration.manage') || has('amazon.manage') ? 'Connect, import or load demo data' : 'View integration status'}</Link></Button>
        </div>
      </>}
    </CardContent></Card>
  )
}

/** Shows which data families are present and how fresh they are. */
export function DataCoverage({ dataset }: { dataset: AmazonDataset }) {
  const s = dataset.status
  const item = (label: string, days: number) => <StatusBadge label={`${label}: ${days}/${s.period_days} days`} tone={days === 0 ? 'neutral' : days < s.period_days ? 'warning' : 'success'} />
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Info className="size-3.5" />
      {item('Sales', s.sales_days)}{item('Settlement fees', s.fee_days)}{item('Campaign ads', s.campaign_days)}{item('Search terms', s.search_term_days)}
      <span>Amazon stock: {s.inventory_snapshot_at ? formatDateTime(s.inventory_snapshot_at) : 'not synchronised'}</span>
      <span>· {s.mapped_listings}/{s.listings} listings mapped to ERP products · computed {formatDateTime(dataset.generatedAt)}</span>
    </div>
  )
}

