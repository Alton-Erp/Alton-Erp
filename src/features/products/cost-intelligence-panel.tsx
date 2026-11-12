import { Info, Loader2, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  COST_EVENT_LABELS,
  COST_SOURCE_LABELS,
  DEFAULT_COST_SOURCE_LABELS,
  costIntelligence,
  historyChange,
  historyReference,
  type CostIntelligenceFields,
} from '@/features/products/cost-intelligence'
import { formatCost } from '@/features/products/product-list-format'
import { SOURCE_TYPE_LABELS } from '@/features/products/product-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { applySourcingMethod, fetchProductCostHistory, fetchSourcingProposal, recalculateCosts, setDefaultCostSource } from '@/services/product-cost'
import { fetchDisplayNames } from '@/services/products'

type Notice = { tone: 'success' | 'error'; text: string }

function Field({ label, testid, children, sub }: { label: string; testid?: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div data-testid={testid}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children}{sub && <span className="block text-xs text-muted-foreground">{sub}</span>}</dd>
    </div>
  )
}

/**
 * Product Master → Cost Intelligence: BOM Manufacturing Cost, Last Purchase Cost and the current Product Master Cost
 * kept apart, with the source, sourcing method, last update and status. Changes go through the database functions
 * (products.update); stock lots and posted transactions always keep their own cost.
 */
export function CostIntelligenceCard({ product, canEdit, timezone, onChanged }: {
  product: CostIntelligenceFields & { id: string }
  canEdit: boolean
  timezone?: string
  onChanged: (n: Notice) => void
}) {
  const v = costIntelligence(product)
  const proposal = useAsync(() => (v.available ? fetchSourcingProposal(product.id) : Promise.resolve(null)), [product.id, v.available, product.default_source_type])
  const [busy, setBusy] = useState<null | 'default' | 'apply' | 'recalc'>(null)
  const [confirmApply, setConfirmApply] = useState(false)
  const when = (iso: string | null) => (iso ? (iso.length <= 10 ? formatDate(iso) : formatDateTime(iso, timezone)) : null)

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<string>) => {
    setBusy(kind)
    try {
      onChanged({ tone: 'success', text: await fn() })
    } catch (e) {
      onChanged({ tone: 'error', text: describeDataError(e) })
    } finally {
      setBusy(null)
    }
  }
  const p = proposal.data
  const suggest = p && p.proposed_method !== p.current_method ? p : null

  return (
    <Card data-testid="cost-intelligence">
      <CardHeader>
        <div>
          <CardTitle>Cost Intelligence</CardTitle>
          <CardDescription>{v.rule}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!v.available ? (
          <p className="text-sm text-muted-foreground" data-testid="ci-unavailable">{v.status.text} Database update 20261208090000 adds it.</p>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="BOM Manufacturing Cost" testid="ci-bom" sub={v.bomNote}>{v.bomCost === null ? '—' : formatCost(v.bomCost)}</Field>
              <Field label="Last Purchase Cost" testid="ci-purchase" sub={v.lastPurchaseCost === null ? 'No valid posted GRN' : `Latest valid posted GRN${v.lastPurchaseDate ? ` · ${formatDate(v.lastPurchaseDate)}` : ''}`}>
                {v.lastPurchaseCost === null ? '—' : formatCost(v.lastPurchaseCost)}
              </Field>
              <Field label="Current Product Master Cost" testid="ci-current" sub={v.reference ?? undefined}>
                <span className="font-semibold" data-source={v.source ?? 'none'}>{v.currentCost === null ? '—' : formatCost(v.currentCost)}</span>
              </Field>
              <Field label="Cost Source" testid="ci-source">{v.sourceLabel}</Field>
              <Field label="Sourcing Method" testid="ci-method">{SOURCE_TYPE_LABELS[product.default_source_type]}</Field>
              <Field label="Last Updated" testid="ci-updated">{when(v.lastUpdated) ?? '—'}</Field>
              {v.defaultCostSource && (
                <Field label="Default Cost Source" testid="ci-default">{DEFAULT_COST_SOURCE_LABELS[v.defaultCostSource]}</Field>
              )}
              <Field label="Cost Status" testid="ci-status">
                <span className={cn('inline-flex rounded-md px-2 py-0.5 text-xs font-medium',
                  v.status.tone === 'ok' ? 'bg-green-50 text-green-800' : v.status.tone === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-muted text-muted-foreground')}>
                  {v.status.text}
                </span>
              </Field>
            </dl>

            {suggest && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-surface-muted/50 px-3 py-2 text-sm" data-testid="ci-proposal">
                <Info aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  Suggested sourcing method from the history: <strong>{SOURCE_TYPE_LABELS[suggest.proposed_method]}</strong> ({suggest.reason}) Nothing changes until it is applied.
                </span>
                {canEdit && (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmApply(true)}>
                    {busy === 'apply' && <Loader2 className="animate-spin" />} Apply suggestion
                  </Button>
                )}
              </div>
            )}
            {proposal.error && <p className="text-xs text-red-700">Sourcing suggestion unavailable: {describeDataError(proposal.error)}</p>}

            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                {v.defaultCostSource && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Default cost source</span>
                    <Select value={v.defaultCostSource} disabled={busy !== null}
                      onValueChange={(s) => void run('default', async () => {
                        await setDefaultCostSource(product.id, s as 'BOM' | 'GRN', null)
                        return `Default cost source set to ${DEFAULT_COST_SOURCE_LABELS[s as 'BOM' | 'GRN']}. Stock lots and posted transactions keep their own cost.`
                      })}>
                      <SelectTrigger className="w-60" aria-label="Default cost source"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BOM">{DEFAULT_COST_SOURCE_LABELS.BOM}</SelectItem>
                        <SelectItem value="GRN">{DEFAULT_COST_SOURCE_LABELS.GRN}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button type="button" size="sm" variant="outline" disabled={busy !== null} data-testid="ci-recalc"
                  onClick={() => void run('recalc', async () => {
                    const r = await recalculateCosts([product.id])
                    return r.changed > 0 ? 'Cost recalculated: the Product Master Cost changed (see Cost History).' : 'Cost recalculated: no change.'
                  })}>
                  {busy === 'recalc' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Recalculate
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
      {suggest && (
        <ConfirmDialog
          open={confirmApply}
          onOpenChange={setConfirmApply}
          title={`Change the sourcing method to ${SOURCE_TYPE_LABELS[suggest.proposed_method]}?`}
          description={`${suggest.reason} The Product Master Cost then follows the rule of the new method. A product version and an audit entry are recorded; stock and posted transactions do not change.`}
          confirmLabel="Change sourcing method"
          onConfirm={() => void run('apply', async () => {
            await applySourcingMethod(product.id, suggest.proposed_method, `Applied suggestion: ${suggest.reason}`)
            return `Sourcing method changed to ${SOURCE_TYPE_LABELS[suggest.proposed_method]}.`
          })}
        />
      )}
    </Card>
  )
}

/** Product page tab: every change of the Product Master Cost (previous / new cost, source, BOM or GRN, user, time, event). */
export function ProductCostHistoryTab({ productId, timezone }: { productId: string; timezone?: string }) {
  const q = useAsync(() => fetchProductCostHistory(productId), [productId])
  const names = useAsync(() => fetchDisplayNames((q.data ?? []).map((r) => r.created_by)), [q.data])
  if (q.loading && !q.data) return <LoadingState label="Loading cost history…" />
  if (q.error) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  if (q.data === null) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground" data-testid="cost-history-unavailable">Cost history becomes available after database update 20261208090000 is applied.</CardContent></Card>
  }
  const rows = q.data ?? []
  const who = (id: string | null) => (id ? (names.data?.get(id) ?? 'Another user') : 'System')
  return (
    <Card data-testid="cost-history">
      <CardHeader>
        <div>
          <CardTitle>Product Master Cost History</CardTitle>
          <CardDescription>One row each time the cost or its source changed. Repeated recalculation adds no row. Stock lots and posted transactions keep their own cost.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="cost-history-empty">No automatic cost change yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Previous → New cost</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>BOM version / GRN</TableHead>
                  <TableHead>Event / reason</TableHead>
                  <TableHead>Updated by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.created_at, timezone)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{historyChange(r.previous_cost, r.new_cost, formatCost)}</TableCell>
                    <TableCell>{COST_SOURCE_LABELS[r.new_source] ?? r.new_source}</TableCell>
                    <TableCell>{historyReference(r)}</TableCell>
                    <TableCell className="text-xs"><span className="font-medium">{COST_EVENT_LABELS[r.event] ?? r.event}</span><span className="block text-muted-foreground">{r.reason}</span></TableCell>
                    <TableCell className="text-xs">{who(r.created_by)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
