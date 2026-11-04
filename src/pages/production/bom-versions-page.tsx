import { ArrowLeft, History } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { bomUnitCost, CHANGE_LABELS, compareBomVersions, formatVersionValue, LIFECYCLE_LABELS, type BomVersion, type ComponentChange } from '@/features/versions/version-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchBomVersionHistory } from '@/services/production'

const TONE: Record<BomVersion['lifecycle'], 'success' | 'info' | 'neutral' | 'warning' | 'danger'> = {
  ACTIVE: 'success', SCHEDULED: 'info', SUPERSEDED: 'neutral', ARCHIVED: 'neutral', DRAFT: 'warning', PENDING_APPROVAL: 'warning', REJECTED: 'danger',
}
const CHANGE: Record<ComponentChange, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  ADDED: { label: CHANGE_LABELS.ADDED, tone: 'success' }, REMOVED: { label: CHANGE_LABELS.REMOVED, tone: 'danger' },
  CHANGED: { label: CHANGE_LABELS.CHANGED, tone: 'warning' }, UNCHANGED: { label: CHANGE_LABELS.UNCHANGED, tone: 'neutral' },
}
const qty = (v: unknown) => (v === null || v === undefined ? '—' : String(Number(v)))
const cost = (v: unknown) => (v === null || v === undefined ? '—' : `₹${Number(v).toFixed(2)}`)
const delta = (a: unknown, b: unknown) => {
  if (a === null || a === undefined || b === null || b === undefined) return ''
  const d = Math.round((Number(b) - Number(a)) * 100) / 100
  return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d.toFixed(2)})`
}

/** /production/boms/:bomId/versions — every version of the product's BOM (read-only), with a comparison of any two. */
export default function BomVersionsPage() {
  const { bomId = '' } = useParams()
  const data = useAsync(() => fetchBomVersionHistory(bomId), [bomId])
  const versions = useMemo(() => data.data?.versions ?? [], [data.data])
  const [aId, setA] = useState<string | null>(null)
  const [bId, setB] = useState<string | null>(null)
  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Versions' }]

  if (data.loading && !data.data) return <LoadingState label="Loading BOM versions…" />
  if (data.error || !data.data) return (<><PageHeader title="BOM versions" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)

  const b = versions.find((v) => v.id === bId) ?? versions.find((v) => v.id === bomId) ?? versions[0]
  const a = versions.find((v) => v.id === aId) ?? versions.find((v) => v.version < (b?.version ?? 0)) ?? versions[0]
  const cmp = a && b ? compareBomVersions(a, b) : null

  return (
    <>
      <PageHeader title={`BOM versions — ${data.data.product.sku}`} description={`${data.data.product.product_name}. Approved versions never change; each change is a new version. Production orders keep the version they were planned with.`}
        breadcrumbs={crumbs} actions={<Button variant="outline" asChild><Link to={`/production/boms/${bomId}`}><ArrowLeft /> BOM</Link></Button>} />

      <Card className="mb-6">
        <CardHeader><div><CardTitle>Versions</CardTitle><CardDescription>{versions.length} version(s), newest first</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm" aria-label="BOM versions">
            <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>
              {['Version', 'Status', 'Effective', 'Modified', 'Components', 'Standard cost / unit', 'Reason for change', 'Created by', 'Approved'].map((h) => <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>)}
            </tr></thead>
            <tbody>{versions.map((v) => (
              <tr key={v.id} className="border-t align-top" data-bom-version={v.version}>
                <td className="px-3 py-2 font-medium whitespace-nowrap"><Link className="text-primary hover:underline" to={`/production/boms/${v.id}`}>{v.bom_code} v{v.version}</Link></td>
                <td className="px-3 py-2"><StatusBadge label={LIFECYCLE_LABELS[v.lifecycle]} tone={TONE[v.lifecycle]} />
                  {v.superseded_by && <span className="block text-xs text-muted-foreground">by v{v.superseded_by}</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(v.effective_from)} – {v.effective_to ? formatDate(v.effective_to) : 'open'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{v.modified_at ? formatDateTime(v.modified_at) : '—'}</td>
                <td className="px-3 py-2">{v.items.length}</td>
                <td className="px-3 py-2 tabular-nums">{cost(bomUnitCost(v))}</td>
                <td className="px-3 py-2">{v.change_reason ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{v.created_by ?? '—'}<span className="block text-xs text-muted-foreground">{formatDateTime(v.created_at)}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{v.approved_by ?? '—'}{v.approved_at && <span className="block text-xs text-muted-foreground">{formatDateTime(v.approved_at)}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>

      {versions.length > 1 && a && b && cmp && (
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><History className="size-4" /> Compare versions</CardTitle>
            <CardDescription>Header and components of two versions. Component names and versions are those the BOM was approved with.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <VersionSelect id="bcmp-a" label="From" versions={versions} value={a.id} onChange={setA} />
              <VersionSelect id="bcmp-b" label="To" versions={versions} value={b.id} onChange={setB} />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm" aria-label="BOM header comparison">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">Field</th><th className="px-3 py-2 text-left">v{a.version}</th><th className="px-3 py-2 text-left">v{b.version}</th></tr></thead>
                <tbody>
                  <tr className={cn('border-t', bomUnitCost(a) !== bomUnitCost(b) && 'bg-amber-50')} data-field="unit_cost">
                    <td className="px-3 py-1.5 font-medium">Standard cost per output unit</td><td className="px-3 py-1.5">{cost(bomUnitCost(a))}</td>
                    <td className="px-3 py-1.5">{cost(bomUnitCost(b))}{delta(bomUnitCost(a), bomUnitCost(b))}</td>
                  </tr>
                  {cmp.header.map((d) => (
                  <tr key={d.key} className={cn('border-t', d.changed && 'bg-amber-50')}>
                    <td className="px-3 py-1.5 font-medium">{d.label}</td>
                    <td className="px-3 py-1.5">{d.key === 'lifecycle' ? LIFECYCLE_LABELS[d.a as BomVersion['lifecycle']] : formatVersionValue(d.a)}</td>
                    <td className="px-3 py-1.5">{d.key === 'lifecycle' ? LIFECYCLE_LABELS[d.b as BomVersion['lifecycle']] : formatVersionValue(d.b)}</td>
                  </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2 text-xs" aria-label="Summary of component changes">
              {(['ADDED', 'REMOVED', 'CHANGED'] as const).map((k) => (
                <StatusBadge key={k} label={`${CHANGE[k].label}: ${cmp.components.filter((c) => c.change === k).length}`} tone={CHANGE[k].tone} />
              ))}
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm" aria-label="BOM component comparison">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>
                  {['Component', 'Change', `Qty v${a.version}`, `Qty v${b.version}`, 'UOM', `Wastage v${a.version}`, `Wastage v${b.version}`, `Cost v${a.version}`, `Cost v${b.version}`, 'Component version', 'What changed'].map((h) => <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>{cmp.components.map((c) => (
                  <tr key={c.component_product_id} className="border-t" data-component={c.sku} data-change={c.change}>
                    <td className="px-3 py-1.5"><span className="font-medium">{c.sku}</span><span className="block text-xs text-muted-foreground">{c.product_name}</span></td>
                    <td className="px-3 py-1.5"><StatusBadge label={CHANGE[c.change].label} tone={CHANGE[c.change].tone} /></td>
                    <td className="px-3 py-1.5 tabular-nums">{qty(c.a?.quantity)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{qty(c.b?.quantity)}</td>
                    <td className="px-3 py-1.5">{c.a && c.b && c.a.unit !== c.b.unit ? `${c.a.unit} → ${c.b.unit}` : (c.b ?? c.a)?.unit}</td>
                    <td className="px-3 py-1.5 tabular-nums">{c.a ? `${Number(c.a.wastage_percentage)}%` : '—'}</td>
                    <td className="px-3 py-1.5 tabular-nums">{c.b ? `${Number(c.b.wastage_percentage)}%` : '—'}</td>
                    <td className="px-3 py-1.5 tabular-nums" title={c.a ? `component ${cost(c.a.standard_cost)} each` : undefined}>{cost(c.a?.line_cost)}</td>
                    <td className="px-3 py-1.5 tabular-nums" title={c.b ? `component ${cost(c.b.standard_cost)} each` : undefined}>{cost(c.b?.line_cost)}{delta(c.a?.line_cost, c.b?.line_cost)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{c.a && c.b && c.a.component_version !== c.b.component_version ? `${c.a.component_version} → ${c.b.component_version}` : (c.b ?? c.a)?.component_version}</td>
                    <td className="px-3 py-1.5">{c.fields.join(', ') || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {(a.process_instructions || b.process_instructions) && <p className="text-xs text-muted-foreground">Process instructions are compared in the header table above.</p>}
          </CardContent>
        </Card>
      )}
    </>
  )
}

function VersionSelect({ id, label, versions, value, onChange }: { id: string; label: string; versions: BomVersion[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => { if (v) onChange(v) }}>
        <SelectTrigger id={id} className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>{versions.map((v) => <SelectItem key={v.id} value={v.id}>{v.bom_code} v{v.version} · {LIFECYCLE_LABELS[v.lifecycle]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}
