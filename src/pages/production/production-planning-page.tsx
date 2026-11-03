import { AlertTriangle, CalendarRange, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { isWholeUnit, parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { useStorage } from '@/features/inventory/use-storage'
import { RequirementBadge } from '@/features/production/production-badges'
import { PRIORITY_LABELS } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchBomRequirements, fetchEffectiveBoms, saveProductionOrder, type RequirementLine } from '@/services/production'
import type { ProductionPriority } from '@/types/database-production'

export default function ProductionPlanningPage() {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const storage = useStorage()
  const [today] = useState(() => toIsoDate(new Date()))
  const boms = useAsync(() => fetchEffectiveBoms(today), [today])
  const { key, renew } = useRequestKey()

  const [bomId, setBomId] = useState(params.get('bom') ?? '')
  const [quantity, setQuantity] = useState('')
  const [chosenSource, setSource] = useState('')
  const [chosenDest, setDest] = useState('')
  const [start, setStart] = useState(today)
  const [target, setTarget] = useState('')
  const [priority, setPriority] = useState<ProductionPriority>('NORMAL')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeWarehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE')
  const defaultWh = activeWarehouses.find((w) => w.is_default)?.id ?? activeWarehouses[0]?.id ?? ''
  const source = chosenSource || defaultWh
  const dest = chosenDest || defaultWh
  const bom = boms.data?.find((b) => b.id === bomId)
  const typed = useDebouncedValue(quantity, 300)
  const qty = parseUnitQty(typed, bom?.output_unit)
  const requirements = useAsync<RequirementLine[] | null>(
    () => (bom && qty && source ? fetchBomRequirements(bom.id, qty, source) : Promise.resolve(null)),
    [bom?.id, qty, source],
  )
  const rows = requirements.data ?? []
  const blocking = rows.filter((r) => r.line_status === 'UNIT_MISMATCH' || r.line_status === 'INACTIVE')
  const short = rows.filter((r) => r.line_status === 'SHORTAGE' || r.line_status === 'PARTIAL')
  const overall = !requirements.data ? null : blocking.length ? 'ERROR' : rows.every((r) => r.line_status === 'SHORTAGE') ? 'NONE' : short.length ? 'PARTIAL' : 'OK'

  const columns: DataTableColumn<RequirementLine>[] = [
    { id: 'sku', header: 'Component SKU', cell: (r) => <span className="font-medium">{r.sku}</span>, searchValue: (r) => r.sku, sortValue: (r) => r.sku },
    { id: 'name', header: 'Component name', cell: (r) => <span>{r.product_name}{r.message && <span className="block text-xs text-muted-foreground">{r.message}</span>}</span>, searchValue: (r) => r.product_name },
    { id: 'base', header: 'Theoretical (BOM ratio)', align: 'right', cell: (r) => <span className="text-muted-foreground">{formatQty(r.base_requirement, r.unit)}</span> },
    { id: 'wastage', header: 'Wastage allowance', align: 'right', cell: (r) => <span className="text-muted-foreground">{formatQty(r.wastage_allowance)} ({Number(r.wastage_percentage)}%)</span> },
    {
      id: 'total',
      header: 'Planned requirement',
      align: 'right',
      cell: (r) => {
        const rounded = isWholeUnit(r.unit) && Number(r.total_requirement) !== Math.round((Number(r.base_requirement) + Number(r.wastage_allowance)) * 1000) / 1000
        return (
          <span className="font-medium">
            {formatQty(r.total_requirement, r.unit)}
            {rounded && <span className="block text-xs font-normal text-muted-foreground">rounded up to whole pieces</span>}
          </span>
        )
      },
      sortValue: (r) => Number(r.total_requirement),
    },
    { id: 'on_hand', header: 'On hand', align: 'right', cell: (r) => formatQty(r.on_hand) },
    { id: 'reserved', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.reserved) },
    { id: 'available', header: 'Available', align: 'right', cell: (r) => (r.available === null ? '—' : formatQty(r.available)) },
    { id: 'shortage', header: 'Shortage', align: 'right', cell: (r) => (r.shortage === null ? '—' : <span className={cn(Number(r.shortage) > 0 && 'font-medium text-shortage')}>{formatQty(r.shortage)}</span>), sortValue: (r) => Number(r.shortage ?? -1) },
    { id: 'suggested', header: 'Suggested replenishment', align: 'right', cell: (r) => (r.suggested_quantity === null ? '—' : formatQty(r.suggested_quantity)) },
    { id: 'status', header: 'Status', cell: (r) => <RequirementBadge status={r.line_status} />, sortValue: (r) => r.line_status },
  ]

  const createOrder = async () => {
    setError(null)
    if (!bom || !qty) return setError('Select a BOM and a planned quantity.')
    if (!target) return setError('Enter the target completion date.')
    if (target < start) return setError('The target completion date cannot be before the planned start date.')
    if (!dest) return setError('Select the destination warehouse.')
    setBusy(true)
    try {
      const r = await saveProductionOrder(
        { orderId: null, bomId: bom.id, plannedQuantity: qty, sourceWarehouseId: source, destinationWarehouseId: dest, plannedStartDate: start, targetCompletionDate: target, priority, notes: notes.trim() || null },
        key,
      )
      renew()
      navigate(`/production/orders/${r.order_id}`)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader />
      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Planning only calculates requirements. It never reserves or consumes stock; materials are deducted only when issued to an approved, started production order. The theoretical column is the exact BOM ratio (wastage included in the next column); the planned requirement adds wastage first and then rounds items counted in pieces up to whole pieces.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pl-bom">Finished product and approved BOM version</Label>
            <Select value={bom ? bomId : ''} onValueChange={setBomId}>
              <SelectTrigger id="pl-bom"><SelectValue placeholder={boms.loading ? 'Loading…' : 'Select an approved BOM'} /></SelectTrigger>
              <SelectContent className="max-h-72">
                {(boms.data ?? []).length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No approved, currently effective BOMs. <Link className="underline" to="/production/boms">Manage BOMs</Link></div>
                )}
                {(boms.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.sku} — {b.product_name} · {b.bom_code} v{b.version}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-qty">Planned quantity{bom ? ` (${bom.output_unit})` : ''}</Label>
            <Input id="pl-qty" inputMode={qtyInputMode(bom?.output_unit)} value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={Boolean(typed.trim() && !qty)} />
            {typed.trim() !== '' && !qty && <p className="text-xs text-shortage">Enter a quantity greater than zero ({quantityRule(bom?.output_unit)}).</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as ProductionPriority)}>
              <SelectTrigger id="pl-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PRIORITY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-src">Raw materials from</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="pl-src"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-dst">Finished goods to</Label>
            <Select value={dest} onValueChange={setDest}>
              <SelectTrigger id="pl-dst"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="pl-start">Planned start</Label><Input id="pl-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="pl-target">Target completion</Label><Input id="pl-target" type="date" min={start} value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2 xl:col-span-4"><Label htmlFor="pl-notes">Notes</Label><Textarea id="pl-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </CardContent>
      </Card>

      {overall && (
        <div className={cn('mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm',
          overall === 'OK' ? 'border-green-200 bg-green-50 text-green-800' : overall === 'ERROR' || overall === 'NONE' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900')}>
          {overall === 'OK' ? <CheckCircle2 className="size-4" /> : overall === 'ERROR' || overall === 'NONE' ? <XCircle className="size-4" /> : <AlertTriangle className="size-4" />}
          {overall === 'OK' && 'All materials are available in the source warehouse.'}
          {overall === 'PARTIAL' && `${short.length} material(s) are short. The order can still be created; reserve or replenish before production.`}
          {overall === 'NONE' && 'None of the materials are available in the source warehouse.'}
          {overall === 'ERROR' && `${blocking.length} line(s) have inactive materials or unit conversion errors. Fix the BOM before creating an order.`}
        </div>
      )}

      <DataTable
        title="Material requirements"
        description={bom && qty ? `For ${formatQty(qty, bom.output_unit)} of ${bom.sku} with ${bom.bom_code} v${bom.version}. Available = on hand − reserved in storage locations of the source warehouse.` : 'Select a BOM, quantity and source warehouse.'}
        columns={columns}
        data={rows}
        getRowId={(r) => r.component_product_id}
        loading={requirements.loading && Boolean(bom && qty)}
        error={requirements.error ? new Error(describeDataError(requirements.error)) : null}
        onRetry={requirements.reload}
        pageSize={50}
        searchable={false}
        emptyState={{ icon: CalendarRange, title: 'No requirements calculated yet', description: 'Choose an approved BOM and a planned quantity to see material requirements and shortages.' }}
      />

      {has('production_order.create') && (
        <div className="mt-4 flex flex-col items-end gap-2">
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{error}</p>}
          <Button onClick={() => void createOrder()} disabled={busy || !bom || !qty || blocking.length > 0 || !requirements.data}>
            {busy && <Loader2 className="animate-spin" />} Create draft production order
          </Button>
        </div>
      )}
    </>
  )
}
