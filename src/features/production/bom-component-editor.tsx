import { Info, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatQty } from '@/features/inventory/inventory-model'
import { formatCost } from '@/features/products/product-list-format'
import { BomComponentPicker } from '@/features/production/bom-component-picker'
import { linesCost } from '@/features/production/bom-component-info'
import { costDifference, newLine, type BomCost, type EditorLine } from '@/features/production/bom-tools-model'
import { validateBomLine } from '@/features/production/production-model'
import { qtyInputMode } from '@/features/inventory/whole-units'
import { cn } from '@/lib/utils'
import type { ComponentInfo } from '@/services/bom-tools'

/**
 * Editable component grid: searchable component (Change = replace), SKU, available stock, unit, Product
 * Master Cost, required quantity, wastage, estimated line cost and remarks. A component can be on one line
 * only (as in every BOM); the unit is the component's inventory unit (no unit conversion is configured).
 */
export function BomComponentEditor({ lines, onChange, output, outputUnit, outputProductId, editable = true, defaultWastage = '0', idPrefix, info, testId }: {
  lines: EditorLine[]
  onChange: (lines: EditorLine[]) => void
  /** Output quantity of one BOM batch (the quantities are per batch). */
  output: string
  outputUnit?: string | null
  /** The product the BOM makes (cannot be its own component). */
  outputProductId?: string | null
  editable?: boolean
  defaultWastage?: string
  idPrefix: string
  info: Map<string, ComponentInfo>
  testId?: string
}) {
  const cost = linesCost(lines, output, info)
  const update = (key: string, patch: Partial<EditorLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  // cost.lines follows the lines that have a component, in order.
  const costByKey = new Map(lines.filter((l) => l.product).map((l, i) => [l.key, cost.lines[i]]))
  return (
    <div data-testid={testId}>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[960px] text-sm" aria-label="Components">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2">#</th>
              <th className="px-2 py-2">Component</th>
              <th className="px-2 py-2">SKU</th>
              <th className="px-2 py-2 text-right">Available</th>
              <th className="px-2 py-2">Unit</th>
              <th className="px-2 py-2 text-right">Unit cost</th>
              <th className="w-32 px-2 py-2 text-right">Required qty</th>
              <th className="w-24 px-2 py-2 text-right">Wastage %</th>
              <th className="px-2 py-2 text-right">Est. line cost</th>
              <th className="w-10 px-2 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const n = i + 1
              const exclude = new Map<string, string>()
              if (outputProductId) exclude.set(outputProductId, 'the finished product cannot be its own component')
              lines.forEach((o, j) => { if (o.key !== l.key && o.product) exclude.set(o.product.product_id, `already on line ${j + 1}`) })
              const ci = l.product ? info.get(l.product.product_id) : undefined
              const available = ci?.available ?? l.product?.available ?? null
              const lineCost = costByKey.get(l.key) ?? null
              const problem = l.product && l.quantity.trim() !== '' ? validateBomLine({ quantity: l.quantity, wastage: l.wastage, unit: l.product.base_unit }) : null
              return (
                <tr key={l.key} className="border-t align-top" data-testid={`${idPrefix}-line-${n}`}>
                  <td className="px-2 py-2 pt-4 text-muted-foreground">{n}</td>
                  <td className="min-w-64 px-2 py-2">
                    {editable
                      ? <BomComponentPicker id={`${idPrefix}-comp-${n}`} label={`Component line ${n}`} value={l.product ? { ...l.product, track_batches: false, track_expiry: false } : null} exclude={exclude}
                          onChange={(p) => update(l.key, { product: p ? { product_id: p.product_id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, available: p.available } : null })} />
                      : <p className="pt-2">{l.product?.product_name ?? '—'}</p>}
                    <Input aria-label={`Remarks line ${n}`} placeholder="Remarks (optional)" maxLength={500} value={l.notes} disabled={!editable}
                      onChange={(e) => update(l.key, { notes: e.target.value })} className="mt-1.5 h-8 text-xs" />
                    {problem && <p className="mt-1 text-xs text-shortage">{problem}</p>}
                  </td>
                  <td className="px-2 py-2 pt-4 font-medium">{l.product?.sku ?? '—'}</td>
                  <td className="px-2 py-2 pt-4 text-right tabular-nums">{available === null || available === undefined ? <span className="text-muted-foreground" title="Stock not visible to you">—</span> : formatQty(available)}</td>
                  <td className="px-2 py-2 pt-4">{l.product?.base_unit ?? '—'}</td>
                  <td className="px-2 py-2 pt-4 text-right tabular-nums" data-testid={`${idPrefix}-cost-${n}`}>
                    {!l.product ? '—' : ci?.unit_cost === null || ci === undefined ? <span className="text-amber-800" title="No Product Master Cost">No cost</span> : formatCost(ci.unit_cost)}
                  </td>
                  <td className="px-2 py-2">
                    <Input id={`${idPrefix}-qty-${n}`} aria-label={`Quantity line ${n}`} inputMode={qtyInputMode(l.product?.base_unit)} className="text-right" value={l.quantity}
                      disabled={!editable} aria-invalid={Boolean(problem)} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                  </td>
                  <td className="px-2 py-2">
                    <Input id={`${idPrefix}-waste-${n}`} aria-label={`Wastage line ${n}`} inputMode="decimal" className="text-right" value={l.wastage}
                      disabled={!editable} onChange={(e) => update(l.key, { wastage: e.target.value })} />
                  </td>
                  <td className="px-2 py-2 pt-4 text-right tabular-nums" data-testid={`${idPrefix}-linecost-${n}`}>{lineCost?.batchCost === null || !lineCost ? '—' : formatCost(lineCost.batchCost)}</td>
                  <td className="px-2 py-2 pt-2.5">
                    {editable && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${n}`}
                        onClick={() => onChange(lines.length > 1 ? lines.filter((x) => x.key !== l.key) : [newLine(defaultWastage)])}><Trash2 /></Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {editable
          ? <Button variant="outline" size="sm" onClick={() => onChange([...lines, newLine(defaultWastage)])} disabled={lines.length >= 500} data-testid={`${idPrefix}-add`}><Plus /> Add component</Button>
          : <span />}
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Info className="size-3.5" /> Quantities are per {output || '…'} {outputUnit ?? 'unit(s)'} of output, in each component's inventory unit. To replace a component, use Change on its line.
        </p>
      </div>
    </div>
  )
}

/** Total material cost, cost per finished unit and the difference from the source BOM. */
export function BomCostSummary({ cost, output, outputUnit, sourcePerUnit, sourceLabel, testId }: {
  cost: BomCost
  output: string
  outputUnit?: string | null
  sourcePerUnit?: number | null
  sourceLabel?: string
  testId?: string
}) {
  // A difference only between complete costs (a missing component cost would distort it).
  const diff = cost.complete ? costDifference(cost.perUnit, sourcePerUnit ?? null) : { amount: null, percent: null }
  const tone = diff.amount === null || diff.amount === 0 ? '' : diff.amount > 0 ? 'text-red-700' : 'text-green-700'
  return (
    <div className="space-y-3" data-testid={testId}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Total material cost (per {output || '…'} {outputUnit ?? ''})</dt>
          <dd className="text-lg font-semibold tabular-nums" data-testid={testId ? `${testId}-total` : undefined}>{cost.none ? 'No cost' : formatCost(cost.total)}</dd>
        </div>
        <div className="rounded-md border p-3">
          <dt className="text-xs text-muted-foreground">Cost per finished unit</dt>
          <dd className="text-lg font-semibold tabular-nums" data-testid={testId ? `${testId}-unit` : undefined}>{cost.none ? 'No cost' : formatCost(cost.perUnit)}</dd>
        </div>
        {sourcePerUnit !== undefined && (
          <>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{sourceLabel ?? 'Source BOM'} per unit</dt>
              <dd className="font-medium tabular-nums">{formatCost(sourcePerUnit)}</dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Difference from source</dt>
              <dd className={cn('font-medium tabular-nums', tone)} data-testid={testId ? `${testId}-diff` : undefined}>
                {diff.amount === null ? '—' : `${diff.amount > 0 ? '+' : diff.amount < 0 ? '−' : ''}${formatCost(Math.abs(diff.amount))}`}
                {diff.percent !== null && ` (${diff.percent > 0 ? '+' : diff.percent < 0 ? '−' : ''}${Math.abs(diff.percent).toFixed(2)}%)`}
              </dd>
            </div>
          </>
        )}
      </dl>
      {!cost.complete && cost.missing > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{cost.missing} component(s) have no Product Master Cost: the totals leave them out.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Component cost = required quantity × (1 + wastage %) × the component's Product Master Cost (second-most-recent purchase receipt, else its standard cost) — the same method as the BOM version history. An estimate only: no cost, stock or ledger value is changed.
      </p>
    </div>
  )
}
