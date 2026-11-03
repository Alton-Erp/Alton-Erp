import { ArrowDown, ArrowUp, CheckCircle2, Loader2, Route, Save, SlidersHorizontal, Wand2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { STRATEGY_LABELS } from '@/features/customer-po/po-import'
import { NoPoSelected, PoContextBar } from '@/features/customer-po/po-picker'
import { PoSalesOrdersNotice } from '@/features/sales/po-sales-orders-notice'
import { usePoSelection } from '@/features/customer-po/use-po-selection'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { allocatePo, fetchLineStock, fetchPoAnalysis, proposeAllocation, savePlanDraft, type AllocateResult, type AnalysisLine, type LotStock, type PlanEntry } from '@/services/customer-po'
import type { AllocationStrategy } from '@/types/database-customer-po'

const ALLOCATABLE = ['READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED', 'PARTIALLY_FULFILLED']
const round3 = (v: number) => Math.round(v * 1000) / 1000

function LotEditor({ line, entries, onClose, onSave }: { line: AnalysisLine; entries: PlanEntry[]; onClose: () => void; onSave: (entries: PlanEntry[]) => void }) {
  const stock = useAsync(() => fetchLineStock(line.line_id), [line.line_id])
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(entries.map((e) => [e.balance_id, String(e.quantity)])))
  const [error, setError] = useState<string | null>(null)
  const eligible = (stock.data ?? []).filter((s) => s.eligible)
  const total = round3(Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0))

  const save = () => {
    setError(null)
    const out: PlanEntry[] = []
    for (const s of eligible) {
      const raw = (qty[s.balance_id] ?? '').trim()
      if (!raw) continue
      const v = Number(raw)
      if (!Number.isFinite(v) || v < 0 || Math.round(v * 1000) !== v * 1000) return setError(`${s.warehouse_code}/${s.location_code}: enter a number ≥ 0 with up to 3 decimals.`)
      if (v > Number(s.available)) return setError(`${s.warehouse_code}/${s.location_code}: only ${formatQty(s.available)} available.`)
      if (v > 0) out.push({ line_id: line.line_id, balance_id: s.balance_id, quantity: v, batch_id: s.batch_id, batch_number: s.batch_number, source_type: s.source_type,
        warehouse_id: s.warehouse_id, warehouse_code: s.warehouse_code, location_id: s.location_id, location_code: s.location_code, expiry_date: s.expiry_date })
    }
    if (total > Number(line.remaining_need)) return setError(`The total (${formatQty(total)}) exceeds the quantity still to cover (${formatQty(line.remaining_need)}).`)
    onSave(out)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Adjust lots — line {line.line_no}: {line.sku}</DialogTitle>
          <DialogDescription>Still to cover: {formatQty(line.remaining_need, line.line_unit ?? undefined)}. Only eligible lots are listed (storage, not expired, known source). The server re-checks availability when you commit.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="max-h-[55vh] overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-muted text-xs text-muted-foreground"><tr><th className="p-2 text-left">Warehouse / location</th><th className="p-2 text-left">Lot</th><th className="p-2 text-left">Source</th><th className="p-2 text-right">Available</th><th className="p-2 text-right">Allocate</th></tr></thead>
            <tbody>
              {stock.loading && <tr><td colSpan={5} className="p-3 text-muted-foreground">Loading…</td></tr>}
              {!stock.loading && eligible.length === 0 && <tr><td colSpan={5} className="p-3 text-muted-foreground">No eligible stock.</td></tr>}
              {eligible.map((s: LotStock) => (
                <tr key={s.balance_id} className="border-t">
                  <td className="p-2">{s.warehouse_code} / {s.location_code}</td>
                  <td className="p-2">{s.batch_number ?? '—'}{s.expiry_date && <span className="block text-xs text-muted-foreground">exp {formatDate(s.expiry_date)}</span>}</td>
                  <td className="p-2"><StockSourceBadge source={s.source_type} /></td>
                  <td className="p-2 text-right tabular-nums">{formatQty(s.available)}</td>
                  <td className="p-2 text-right"><Input aria-label={`Allocate from ${s.warehouse_code} ${s.location_code} ${s.batch_number ?? s.source_type}`} inputMode="decimal" className="ml-auto h-8 w-28 text-right"
                    value={qty[s.balance_id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [s.balance_id]: e.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm">Total: <span className={cn('font-medium', total > Number(line.remaining_need) && 'text-shortage')}>{formatQty(total)}</span> of {formatQty(line.remaining_need)}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Use these quantities</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PoFulfilmentPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const [refresh, setRefresh] = useState(0)
  const selection = usePoSelection(refresh)
  const analysis = useAsync(() => (selection.poId ? fetchPoAnalysis(selection.poId) : Promise.resolve(null)), [selection.poId, refresh])
  const { key, renew } = useRequestKey()
  const [strategy, setStrategy] = useState<AllocationStrategy>('IN_HOUSE_FIRST')
  const [priority, setPriority] = useState<string[]>([])
  const [plan, setPlan] = useState<PlanEntry[] | null>(null)
  const [edited, setEdited] = useState(false)
  const [editing, setEditing] = useState<AnalysisLine | null>(null)
  const [allowPartial, setAllowPartial] = useState(true)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<null | 'propose' | 'commit' | 'draft'>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AllocateResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const po = selection.selected
  const canAllocate = Boolean(po && po.is_current && ALLOCATABLE.includes(po.status) && has('customer_po.allocate'))
  const lines = (analysis.data?.lines ?? []).filter((l) => l.line_status === 'MATCHED')
  const blocked = (analysis.data?.lines ?? []).filter((l) => !['MATCHED', 'EXCLUDED'].includes(l.line_status)).length
  const warehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE')
  const priorityList = priority.length ? priority : warehouses.map((w) => w.id)
  const byLine = useMemo(() => {
    const m = new Map<string, PlanEntry[]>()
    for (const e of plan ?? []) m.set(e.line_id, [...(m.get(e.line_id) ?? []), e])
    return m
  }, [plan])
  const sum = (entries: PlanEntry[] | undefined, source?: string) => round3((entries ?? []).filter((e) => !source || e.source_type === source).reduce((s, e) => s + Number(e.quantity), 0))
  const totalPlanned = sum(plan ?? [])
  const overLines = lines.filter((l) => sum(byLine.get(l.line_id)) > Number(l.remaining_need))

  const resetPlan = () => { setPlan(null); setEdited(false); setResult(null) }

  const propose = async () => {
    if (!po) return
    setError(null)
    setBusy('propose')
    try {
      if (strategy === 'MANUAL') {
        setPlan([])
      } else {
        setPlan(await proposeAllocation(po.id, strategy, strategy === 'WAREHOUSE_PRIORITY' ? priorityList : null))
      }
      setEdited(strategy === 'MANUAL')
      setResult(null)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const commit = async () => {
    if (!po || !plan) return
    setBusy('commit')
    setError(null)
    try {
      const r = await allocatePo({
        poId: po.id,
        strategy: edited ? 'MANUAL' : strategy,
        warehousePriority: strategy === 'WAREHOUSE_PRIORITY' ? priorityList : null,
        manual: edited ? plan.map((e) => ({ line_id: e.line_id, balance_id: e.balance_id, quantity: Number(e.quantity) })) : null,
        allowPartial,
        note: note.trim() || null,
      }, key)
      renew()
      setResult(r)
      setPlan(null)
      setEdited(false)
      setRefresh((n) => n + 1)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
      setConfirm(false)
    }
  }

  const saveDraft = async () => {
    if (!po || !plan) return
    setBusy('draft')
    setError(null)
    try {
      await savePlanDraft(po.id, edited ? 'MANUAL' : strategy, plan, note.trim() || null)
      setMessage('Plan saved as a draft. No stock was reserved.')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const columns: DataTableColumn<AnalysisLine>[] = [
    { id: 'line', header: 'Line', cell: (l) => l.line_no },
    { id: 'sku', header: 'Product SKU', cell: (l) => <span className="font-medium">{l.sku}</span>, searchValue: (l) => l.sku ?? '' },
    { id: 'name', header: 'Product name', cell: (l) => l.product_name, searchValue: (l) => l.product_name ?? '' },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => formatQty(l.quantity_ordered, l.line_unit ?? undefined) },
    { id: 'need', header: 'Still to cover', align: 'right', cell: (l) => formatQty(l.remaining_need) },
    { id: 'ih_av', header: 'In-house avail.', align: 'right', cell: (l) => <span className="text-blue-700">{formatQty(l.in_house_available)}</span> },
    { id: 'os_av', header: 'Outsourced avail.', align: 'right', cell: (l) => <span className="text-violet-700">{formatQty(l.outsourced_available)}</span> },
    { id: 'ih', header: 'Proposed in-house', align: 'right', cell: (l) => (plan ? <span className="text-blue-700">{formatQty(sum(byLine.get(l.line_id), 'IN_HOUSE'))}</span> : '—') },
    { id: 'os', header: 'Proposed outsourced', align: 'right', cell: (l) => (plan ? <span className="text-violet-700">{formatQty(sum(byLine.get(l.line_id), 'OUTSOURCED'))}</span> : '—') },
    { id: 'total', header: 'Total proposed', align: 'right', cell: (l) => (plan ? <span className={cn('font-medium', sum(byLine.get(l.line_id)) > Number(l.remaining_need) && 'text-shortage')}>{formatQty(sum(byLine.get(l.line_id)))}</span> : '—') },
    { id: 'short', header: 'Remaining shortage', align: 'right', cell: (l) => {
      const s = plan ? Math.max(round3(Number(l.remaining_need) - sum(byLine.get(l.line_id))), 0) : Number(l.shortage_after ?? 0)
      return <span className={cn(s > 0 && 'font-medium text-shortage')}>{formatQty(s)}</span>
    } },
    { id: 'where', header: 'Warehouse / location', cell: (l) => (
      <span className="text-xs">{[...new Set((byLine.get(l.line_id) ?? []).map((e) => `${e.warehouse_code}/${e.location_code}${e.batch_number ? ` (${e.batch_number})` : ''}`))].join(', ') || '—'}</span>
    ) },
    { id: 'status', header: 'Allocation status', cell: (l) => {
      if (Number(l.remaining_need) === 0) return <StatusBadge label="Covered" tone="success" />
      if (!plan) return Number(l.allocated_open) > 0 ? <StatusBadge label="Partially allocated" tone="info" /> : <StatusBadge label="Not allocated" />
      const t = sum(byLine.get(l.line_id))
      if (t > Number(l.remaining_need)) return <StatusBadge label="Exceeds need" tone="danger" />
      return t >= Number(l.remaining_need) ? <StatusBadge label="Fully planned" tone="success" /> : t > 0 ? <StatusBadge label="Partially planned" tone="warning" /> : <StatusBadge label="Shortage" tone="danger" />
    } },
    { id: 'adjust', header: '', cell: (l) => (canAllocate && plan && Number(l.remaining_need) > 0
      ? <Button variant="ghost" size="sm" onClick={() => setEditing(l)}><SlidersHorizontal /> Adjust</Button> : null) },
  ]

  return (
    <>
      <PageHeader />
      <PoContextBar selection={selection} />
      {po && <PoSalesOrdersNotice poId={po.id} poStatus={po.status} isCurrent={po.is_current} />}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {!po ? <NoPoSelected /> : (
        <>
          {!ALLOCATABLE.includes(po.status) && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {blocked > 0 || ['UPLOADED', 'VALIDATION_REQUIRED', 'PRODUCT_MATCHING_REQUIRED'].includes(po.status)
                ? <>Stock can be allocated once every line is matched and valid. <Link className="underline" to={`/customer-pos/matching?po=${po.id}`}>Return to product matching</Link>.</>
                : <>This PO is {po.status.replace(/_/g, ' ').toLowerCase()}; no further allocation is possible.</>}
            </div>
          )}
          {result && (
            <div role="status" className="mb-4 space-y-1 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
              <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" /> {result.reservations.length} reservation(s) created{result.duplicate ? ' (request already processed)' : ''}. PO is {result.status.replace(/_/g, ' ').toLowerCase()}.</p>
              {result.shortages.length > 0 && <p>Remaining shortage: {result.shortages.map((s) => `line ${s.line_no} ${s.sku} ${formatQty(s.short, s.unit)}`).join('; ')}. See the <Link className="underline" to="/customer-pos/shortages">Shortage Report</Link>.</p>}
            </div>
          )}
          <Card className="mb-6">
            <CardHeader><div><CardTitle>Allocation strategy</CardTitle><CardDescription>Choose how eligible stock is picked. Expired, rejected, outside-processor and unverified-source stock is never allocated. Proposals reserve nothing.</CardDescription></div></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ff-strategy">Strategy</Label>
                  <Select value={strategy} onValueChange={(v) => { setStrategy(v as AllocationStrategy); resetPlan() }}>
                    <SelectTrigger id="ff-strategy" className="w-80"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(STRATEGY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button variant="outline" disabled={!canAllocate || busy !== null} onClick={() => void propose()}>
                  {busy === 'propose' ? <Loader2 className="animate-spin" /> : <Wand2 />} {strategy === 'MANUAL' ? 'Start manual plan' : 'Propose allocation'}
                </Button>
                {plan && <Button variant="ghost" onClick={resetPlan}>Discard proposal</Button>}
              </div>
              {strategy === 'WAREHOUSE_PRIORITY' && (
                <ol className="max-w-md space-y-1 text-sm">
                  {priorityList.map((id, i) => {
                    const w = storage.warehouseById.get(id)
                    return (
                      <li key={id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1">
                        <span className="w-5 text-muted-foreground">{i + 1}.</span>
                        <span className="flex-1">{w?.warehouse_code} — {w?.warehouse_name}</span>
                        <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => { const p = [...priorityList];[p[i - 1], p[i]] = [p[i], p[i - 1]]; setPriority(p); resetPlan() }}><ArrowUp /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === priorityList.length - 1} onClick={() => { const p = [...priorityList];[p[i + 1], p[i]] = [p[i], p[i + 1]]; setPriority(p); resetPlan() }}><ArrowDown /></Button>
                      </li>
                    )
                  })}
                </ol>
              )}
              {po.fulfilment_warehouse_code && <p className="text-xs text-muted-foreground">This PO is fulfilled from {po.fulfilment_warehouse_code} only (change it on the PO page).</p>}
            </CardContent>
          </Card>

          <DataTable
            title="Fulfilment plan"
            description={plan ? `${edited ? 'Adjusted manually' : STRATEGY_LABELS[strategy]} · ${formatQty(totalPlanned)} planned across ${plan.length} lot(s). Quantities are per line unit.` : 'Propose an allocation to see the plan.'}
            columns={columns}
            data={lines}
            getRowId={(l) => l.line_id}
            loading={analysis.loading}
            error={analysis.error ? new Error(describeDataError(analysis.error)) : null}
            onRetry={analysis.reload}
            pageSize={50}
            searchable={false}
            emptyState={{ icon: Route, title: 'No matched lines', description: 'Match the PO lines to products first.' }}
          />

          {plan && canAllocate && (
            <Card className="mt-6">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start gap-2">
                  <Checkbox id="ff-partial" checked={allowPartial} onCheckedChange={(v) => setAllowPartial(v === true)} />
                  <Label htmlFor="ff-partial" className="font-normal">Allocate what is available and leave the rest as a shortage (otherwise nothing is reserved unless every line is fully covered)</Label>
                </div>
                <div className="space-y-1"><Label htmlFor="ff-note">Note (optional)</Label><Textarea id="ff-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
                {overLines.length > 0 && <p className="text-sm text-shortage">Some lines exceed what they still need. Adjust them before committing.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy !== null || totalPlanned === 0 || overLines.length > 0} onClick={() => setConfirm(true)}>Commit allocation</Button>
                  <Button variant="outline" disabled={busy !== null} onClick={() => void saveDraft()}>{busy === 'draft' ? <Loader2 className="animate-spin" /> : <Save />} Save as draft (no reservation)</Button>
                  <Button variant="ghost" asChild><Link to={`/customer-pos/matching?po=${po.id}`}>Back to matching</Link></Button>
                  <Button variant="ghost" asChild><Link to={`/customer-pos/availability?po=${po.id}`}>Review inventory</Link></Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      {editing && (
        <LotEditor line={editing} entries={byLine.get(editing.line_id) ?? []} onClose={() => setEditing(null)}
          onSave={(entries) => { setPlan((p) => [...(p ?? []).filter((e) => e.line_id !== editing.line_id), ...entries]); setEdited(true); setEditing(null) }} />
      )}
      <Dialog open={confirm} onOpenChange={(o) => !o && busy === null && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit allocation for {po?.customer_po_number}?</DialogTitle>
            <DialogDescription>
              {formatQty(totalPlanned)} across {plan?.length ?? 0} lot(s) will be reserved ({edited ? 'manual quantities' : STRATEGY_LABELS[strategy]}). The server re-checks permissions, product and stock availability and either reserves everything{allowPartial ? ' it can (partial allowed)' : ''} or nothing. On-hand stock does not change.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={busy !== null}>Cancel</Button>
            <Button onClick={() => void commit()} disabled={busy !== null}>{busy === 'commit' && <Loader2 className="animate-spin" />} Reserve stock</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
