import { ArrowLeft, Eye, History, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { compareProductVersions, fieldLabel, formatVersionValue, versionLabel, type ProductVersion } from '@/features/versions/version-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchProductVersionHistory } from '@/services/products'

/** /products/:productId/versions — read-only version history of a product or component, with a comparison of any two versions. */
export default function ProductVersionsPage() {
  const { productId = '' } = useParams()
  const data = useAsync(() => fetchProductVersionHistory(productId), [productId])
  const versions = useMemo(() => data.data?.versions ?? [], [data.data])
  const [aId, setA] = useState<string | null>(null)
  const [bId, setB] = useState<string | null>(null)
  const [onlyChanged, setOnlyChanged] = useState(true)
  const [viewId, setViewId] = useState<string | null>(null)
  const crumbs = [{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: data.data?.product.sku ?? 'Product', to: `/products/${productId}` }, { label: 'Versions' }]

  if (data.loading && !data.data) return <LoadingState label="Loading version history…" />
  if (data.error || !data.data) return (<><PageHeader title="Version history" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)

  // Defaults: the current version against the one before it.
  const b = versions.find((v) => v.id === bId) ?? versions[0]
  const a = versions.find((v) => v.id === aId) ?? versions[1] ?? versions[0]
  const diff = a && b ? compareProductVersions(a.values, b.values) : []
  const shown = onlyChanged ? diff.filter((d) => d.changed) : diff
  const viewed = versions.find((v) => v.id === viewId) ?? null
  const head = (v: ProductVersion) => `${v.is_current ? 'Current values' : v === a && b.is_current ? 'Previous values' : 'Values'} (${versionLabel(v)})`

  return (
    <>
      <PageHeader title={`Revision history — ${data.data.product.sku}`} description={`${data.data.product.product_name}. Each change creates a new version; earlier versions are read-only and stay attached to the transactions, BOMs and reports made with them.`}
        breadcrumbs={crumbs} actions={<Button variant="outline" asChild><Link to={`/products/${productId}`}><ArrowLeft /> Product</Link></Button>} />

      <Card className="mb-6">
        <CardHeader><div><CardTitle>Versions</CardTitle><CardDescription>{versions.length} version(s), newest first</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm" aria-label="Product versions">
            <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>
              {['Version', 'Status', 'Effective from', 'Effective to', 'Changed (previous → new)', 'Reason', 'Modified by', ''].map((h) => <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>{versions.map((v) => (
              <tr key={v.id} className="border-t align-top" data-version={v.version_no}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{versionLabel(v)}</td>
                <td className="px-3 py-2">{v.is_current ? <StatusBadge label="Current" tone="success" /> : <StatusBadge label="Superseded" />}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(v.effective_from)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{v.effective_to ? formatDateTime(v.effective_to) : '—'}</td>
                <td className="px-3 py-2"><ChangeSummary v={v} /></td>
                <td className="px-3 py-2">{v.change_reason ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{v.created_by ?? '—'}<span className="block text-xs text-muted-foreground">{formatDateTime(v.created_at)}</span></td>
                <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" aria-label={`View version ${v.version_no}`} onClick={() => setViewId(v.id)}><Eye /> View</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>

      {viewed && (
        <Card className="mb-6" data-testid="version-view">
          <CardHeader>
            <div><CardTitle>{versionLabel(viewed)} — read-only</CardTitle>
              <CardDescription>{viewed.is_current ? 'Current version' : `Superseded ${viewed.effective_to ? formatDateTime(viewed.effective_to) : ''}`} · effective from {formatDateTime(viewed.effective_from)} · {viewed.change_reason ?? 'no reason recorded'}</CardDescription></div>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setViewId(null)}><X /></Button>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm" aria-label={`Values of ${versionLabel(viewed)}`}>
              <tbody>{compareProductVersions(viewed.values, viewed.values).map((d) => (
                <tr key={d.key} className="border-t"><td className="w-1/3 px-3 py-1.5 font-medium">{d.label}</td><td className="px-3 py-1.5">{formatVersionValue(d.a)}</td></tr>
              ))}</tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {versions.length > 1 && a && b && (
        <Card>
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><History className="size-4" /> Compare versions</CardTitle><CardDescription>Values of two versions side by side.</CardDescription></div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <VersionSelect id="cmp-a" label="From" versions={versions} value={a.id} onChange={setA} />
              <VersionSelect id="cmp-b" label="To" versions={versions} value={b.id} onChange={setB} />
              <div className="flex items-center gap-2 pb-2"><Checkbox id="cmp-only" checked={onlyChanged} onCheckedChange={(c) => setOnlyChanged(c === true)} /><Label htmlFor="cmp-only">Only changed fields</Label></div>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm" aria-label="Version comparison">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>
                  <th className="px-3 py-2 text-left">Field</th><th className="px-3 py-2 text-left">{head(a)}</th><th className="px-3 py-2 text-left">{head(b)}</th>
                </tr></thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No differences.</td></tr>}
                  {shown.map((d) => (
                    <tr key={d.key} className={cn('border-t', d.changed && 'bg-amber-50')} data-field={d.key}>
                      <td className="px-3 py-1.5 font-medium">{d.label}</td>
                      <td className="px-3 py-1.5">{formatVersionValue(d.a)}</td>
                      <td className="px-3 py-1.5">{formatVersionValue(d.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )
}

function ChangeSummary({ v }: { v: ProductVersion }) {
  if (v.source === 'LEGACY_BASELINE') return <span className="text-muted-foreground">Values when version control started (earlier changes were not recorded)</span>
  if (v.source === 'CREATED' || !v.changes) return <span className="text-muted-foreground">Created</span>
  return (
    <ul className="space-y-0.5">
      {Object.entries(v.changes).map(([k, c]) => (
        <li key={k}><span className="font-medium">{fieldLabel(k)}:</span> {formatVersionValue(c.from)} → {formatVersionValue(c.to)}</li>
      ))}
    </ul>
  )
}

function VersionSelect({ id, label, versions, value, onChange }: { id: string; label: string; versions: ProductVersion[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => { if (v) onChange(v) }}>
        <SelectTrigger id={id} className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>{versions.map((v) => <SelectItem key={v.id} value={v.id}>{versionLabel(v)} · {formatDateTime(v.effective_from)}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}
