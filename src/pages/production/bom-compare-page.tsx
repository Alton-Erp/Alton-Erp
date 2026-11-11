import { ArrowLeft, GitCompareArrows, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatCost } from '@/features/products/product-list-format'
import { compareBoms, type CompareState } from '@/features/production/bom-tools-model'
import { BomStatusBadge } from '@/features/production/production-badges'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchBomsForCompare, fetchComponentInfo } from '@/services/bom-tools'
import { fetchBoms } from '@/services/production'

const MAX = 6
const CELL: Record<CompareState, string> = {
  BASE: '', SAME: '', ABSENT: 'text-muted-foreground',
  ADDED: 'bg-green-50 text-green-900', REMOVED: 'bg-red-50 text-red-900', CHANGED: 'bg-amber-50 text-amber-900',
}
const STATE_LABEL: Partial<Record<CompareState, string>> = { ADDED: 'Added', REMOVED: 'Removed', CHANGED: 'Changed' }
const qty = (v: number) => String(Number(v.toFixed(6)))

/** /production/boms/compare?ids=a,b — two or more BOMs side by side (per finished unit); the first is the baseline. */
export default function BomComparePage() {
  const [params, setParams] = useSearchParams()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, MAX), [params])
  const all = useAsync(() => fetchBoms(null), [])
  const data = useAsync(async () => {
    const boms = await fetchBomsForCompare(ids)
    const info = await fetchComponentInfo(boms.flatMap((b) => b.items.map((i) => i.component_product_id)))
    return { boms, info }
  }, [ids.join(',')])
  const [onlyDiff, setOnlyDiff] = useState(false)
  const setIds = (next: string[]) => setParams(next.length ? { ids: next.join(',') } : {})

  const result = useMemo(() => {
    if (!data.data || data.data.boms.length === 0) return null
    const { boms, info } = data.data
    return compareBoms(boms.map(({ bom, items }) => ({
      id: bom.id, label: `${bom.bom_code} v${bom.version}`, output_quantity: bom.output_quantity,
      items: items.map((i) => ({ component_product_id: i.component_product_id, sku: i.sku, product_name: i.product_name, unit: i.unit, quantity_required: i.quantity_required, wastage_percentage: i.wastage_percentage })),
    })), (id) => info.get(id)?.unit_cost ?? null)
  }, [data.data])
  const boms = data.data?.boms ?? []
  const rows = (result?.rows ?? []).filter((r) => !onlyDiff || r.differs)

  return (
    <>
      <PageHeader title="Compare BOMs" breadcrumbs={[{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Compare' }]}
        description="Components of two or more BOMs per finished unit, with the components' Product Master Cost. The first BOM is the baseline."
        actions={<Button variant="outline" asChild><Link to="/production/boms"><ArrowLeft /> All BOMs</Link></Button>} />

      <Card className="mb-6">
        <CardHeader><div><CardTitle>BOMs to compare</CardTitle><CardDescription>Up to {MAX}. Any product and any version; changing a BOM is never done here.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2" data-testid="compare-selected">
            {ids.map((id, i) => {
              const b = (all.data ?? []).find((x) => x.id === id) ?? boms.find((x) => x.bom.id === id)?.bom
              return (
                <span key={id} className="flex items-center gap-1.5 rounded-full border bg-surface-muted/50 py-1 pr-1 pl-3 text-sm">
                  {i === 0 && <span className="text-xs font-medium text-muted-foreground">Baseline:</span>}
                  {b ? `${b.bom_code} v${b.version} — ${b.sku}` : id.slice(0, 8)}
                  <button type="button" className="rounded-full p-0.5 hover:bg-muted" aria-label={`Remove ${b?.sku ?? 'BOM'}`} onClick={() => setIds(ids.filter((x) => x !== id))}><X className="size-3.5" /></button>
                </span>
              )
            })}
          </div>
          {ids.length < MAX && (
            <div className="max-w-xl space-y-1.5">
              <Label htmlFor="compare-add">Add a BOM</Label>
              <Select value="" onValueChange={(v) => setIds([...ids, v])}>
                <SelectTrigger id="compare-add" className="w-full"><SelectValue placeholder={all.loading ? 'Loading…' : 'Select a BOM'} /></SelectTrigger>
                <SelectContent>{(all.data ?? []).filter((b) => !ids.includes(b.id)).map((b) => <SelectItem key={b.id} value={b.id}>{b.bom_code} v{b.version} — {b.sku} {b.product_name} ({b.status.toLowerCase().replace('_', ' ')})</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {data.error && <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card>}
      {ids.length < 2 && !data.error && <p className="text-sm text-muted-foreground">Select at least two BOMs.</p>}
      {result && ids.length >= 2 && (
        <Card data-testid="compare-result">
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><GitCompareArrows className="size-5" /> Comparison</CardTitle>
              <CardDescription>Quantity per finished unit (before wastage) and component cost per unit (incl. wastage). Highlighted against the baseline: <span className="rounded bg-green-50 px-1 text-green-900">added</span> <span className="rounded bg-red-50 px-1 text-red-900">removed</span> <span className="rounded bg-amber-50 px-1 text-amber-900">quantity / wastage changed</span>.</CardDescription></div>
            <div className="flex items-center gap-2"><Checkbox id="compare-diff" checked={onlyDiff} onCheckedChange={(v) => setOnlyDiff(v === true)} /><Label htmlFor="compare-diff" className="text-sm">Only differences</Label></div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-sm" aria-label="BOM comparison">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Component</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2 text-right">Unit cost</th>
                  {boms.map(({ bom }, i) => (
                    <th key={bom.id} className="px-3 py-2 text-right">
                      <Link to={`/production/boms/${bom.id}`} className="text-primary hover:underline">{bom.bom_code} v{bom.version}</Link>
                      <span className="block font-normal normal-case">{bom.sku}{i === 0 ? ' (baseline)' : ''}</span>
                      <span className="mt-0.5 inline-block"><BomStatusBadge status={bom.status} /></span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.component_product_id} className="border-t" data-component={r.sku}>
                    <td className="px-3 py-2">{r.product_name}</td>
                    <td className="px-3 py-2 font-medium">{r.sku}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.unitCost === null ? <span className="text-amber-800">No cost</span> : formatCost(r.unitCost)}</td>
                    {r.cells.map((c, i) => (
                      <td key={i} className={cn('px-3 py-2 text-right tabular-nums', CELL[c.state])} data-state={c.state}>
                        {c.perUnit === null ? (c.state === 'REMOVED' ? 'Removed' : '—') : (
                          <>
                            {qty(c.perUnit)} {r.unit}{c.wastage ? <span className="text-xs"> +{c.wastage}%</span> : null}
                            <span className="block text-xs">{[c.cost === null ? null : formatCost(c.cost), STATE_LABEL[c.state] ?? null].filter(Boolean).join(' · ')}</span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={3 + boms.length} className="px-3 py-4 text-center text-muted-foreground">No differences.</td></tr>}
              </tbody>
              <tfoot className="border-t-2 font-medium">
                <tr data-testid="compare-totals">
                  <td className="px-3 py-2" colSpan={3}>Estimated material cost per finished unit</td>
                  {result.totals.map((t, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">
                      {t.none ? <span className="text-amber-800">No cost</span> : formatCost(t.perUnit)}
                      {!t.complete && !t.none && <span className="block text-xs font-normal text-amber-800">incomplete (components without cost)</span>}
                      {t.difference !== null && (
                        <span className={cn('block text-xs', t.difference > 0 ? 'text-red-700' : t.difference < 0 ? 'text-green-700' : 'text-muted-foreground')}>
                          {t.difference > 0 ? '+' : t.difference < 0 ? '−' : ''}{formatCost(Math.abs(t.difference))}{t.percent !== null ? ` (${t.percent > 0 ? '+' : ''}${t.percent.toFixed(2)}%)` : ''}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </>
  )
}
