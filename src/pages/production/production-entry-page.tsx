import { AlertTriangle, CheckCircle2, Loader2, Network, Save } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { parseUnitQty, qtyInputMode } from '@/features/inventory/whole-units'
import { AddComponentsDialog, RequirementsTable, WarningList } from '@/features/production/production-v2-components'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import type { ProductOption } from '@/services/inventory'
import { fetchProductionOrder } from '@/services/production'
import { fetchProductionPreview, saveProductionOrderV2 } from '@/services/production-v2'
import type { ProductionOrderListRow } from '@/types/database-production'

/** /production/new and /production/orders/:orderId/edit */
export default function ProductionEntryPage() {
  const { orderId } = useParams()
  const order = useAsync(() => (orderId ? fetchProductionOrder(orderId) : Promise.resolve(null)), [orderId])
  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Production Orders', to: '/production/orders' }, { label: orderId ? 'Edit' : 'New' }]
  if (order.loading && !order.data) return <LoadingState label="Loading…" />
  if (order.error) return (<><PageHeader title="Production order" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(order.error)} onRetry={order.reload} /></Card></>)
  return <EntryForm order={order.data ?? null} crumbs={crumbs} />
}

function EntryForm({ order, crumbs }: { order: ProductionOrderListRow | null; crumbs: { label: string; to?: string }[] }) {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const storage = useStorage()
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const [product, setProduct] = useState<ProductOption | null>(order
    ? { product_id: order.finished_product_id, sku: order.sku, product_name: order.product_name, base_unit: order.unit, track_batches: false, track_expiry: false }
    : null)
  const [date, setDate] = useState(order?.planned_start_date ?? today)
  const [planned, setPlanned] = useState(order ? String(Number(order.planned_quantity)) : '')
  const [warehouse, setWarehouse] = useState(order?.source_warehouse_id ?? '')
  const [remarks, setRemarks] = useState(order?.notes ?? '')
  const [actual, setActual] = useState('')
  const [rejected, setRejected] = useState('')
  const [wastage, setWastage] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [bomVersion, setBomVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'complete'>(null)
  const [error, setError] = useState<string | null>(null)

  // Auto-saved working copy: restored when the user comes back to this form.
  const draft = usePersistentFormDraft({
    formKey: 'production.order', recordId: order?.id ?? null, baseVersion: order?.updated_at ?? null,
    enabled: has('production_order.create') || has('production_order.update'),
    value: { product, date, planned, warehouse, remarks, actual, rejected, wastage },
    onRestore: (d) => {
      setProduct(d.product)
      setDate(d.date)
      setPlanned(d.planned)
      setWarehouse(d.warehouse)
      setRemarks(d.remarks)
      setActual(d.actual)
      setRejected(d.rejected)
      setWastage(d.wastage)
      setError(null)
    },
  })

  const whId = warehouse || storage.warehouses.find((w) => w.is_default && w.status === 'ACTIVE')?.id || ''
  const unit = product?.base_unit ?? ''
  const plannedQty = product ? parseUnitQty(planned, unit) : null
  const debouncedQty = useDebouncedValue(plannedQty, 300)
  const preview = useAsync(() => (product ? fetchProductionPreview(product.product_id, debouncedQty, whId || null) : Promise.resolve(null)),
    [product?.product_id, debouncedQty, whId, bomVersion])
  const p = preview.data
  const recording = actual.trim() !== ''

  const save = async (complete: boolean) => {
    setError(null)
    const problems: string[] = []
    if (!product) problems.push('Choose the finished product.')
    if (product && !p?.bom) problems.push(`${product.sku} has no active BOM: add its components first.`)
    if (product && plannedQty === null) problems.push(`Enter the planned quantity (${unit}${['PCS', 'NOS', 'SET', 'PAIR'].includes(unit) ? ', whole numbers' : ''}).`)
    if (!date) problems.push('Enter the production date.')
    if (!whId) problems.push('Choose the production location.')
    if (complete) {
      const a = parseUnitQty(actual, unit, { allowZero: true })
      const r = parseUnitQty(rejected, unit, { allowZero: true })
      const w = parseUnitQty(wastage, unit, { allowZero: true })
      if (a === null || r === null || w === null || a + (w ?? 0) === 0) problems.push('Enter valid actual, rejected and wastage quantities.')
      else if (r > a) problems.push('Rejected quantity cannot be more than the actual quantity.')
      if (date > today) problems.push('Production that is completed now cannot be dated in the future.')
    }
    if (problems.length) return setError(problems.join(' '))
    setBusy(complete ? 'complete' : 'save')
    try {
      const res = await saveProductionOrderV2(order?.id ?? null, {
        product_id: product!.product_id, production_date: date, planned_quantity: planned.trim(), warehouse_id: whId, remarks: remarks.trim() || null,
        ...(complete ? { complete: true, actual_quantity: actual.trim(), rejected_quantity: rejected.trim() || '0', wastage_quantity: wastage.trim() || '0', production_date: date } : {}),
      }, order ? null : request.key)
      request.renew()
      void draft.markSubmitted()
      const msg = res.completion
        ? `${res.production_order_number} recorded and completed: ${res.completion.accepted} ${unit} accepted into stock (${res.completion.receipt_number}).`
        : `${res.production_order_number} ${order ? 'saved and recalculated' : 'created'} (BOM ${res.bom_code} v${res.bom_version}). Available materials are reserved; nothing has been deducted yet.`
      navigate(`/production/orders/${res.order_id}`, { replace: Boolean(order), state: { message: msg, warnings: res.warnings } })
    } catch (e) {
      setError(describeDataError(e))
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title={order ? `Edit ${order.production_order_number}` : 'New production'}
        description={order ? 'Change the product, quantity, date, location or remarks. Reservations are released and the materials recalculated from the current BOM.' : 'Create a production order. Materials are calculated from the active BOM and available stock is reserved; stock changes only when production is completed.'}
        breadcrumbs={crumbs}
      />
      <FormDraftBar draft={draft} />
      {notice &&<p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800"><CheckCircle2 className="size-4" /> {notice}</p>}
      {p && <WarningList warnings={p.warnings} showPurchase />}

      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(false) }} className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader><div><CardTitle>Production details</CardTitle><CardDescription>Fields marked * are required.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1"><Label>Production order number</Label><p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{order?.production_order_number ?? 'Assigned automatically when saved'}</p></div>
              <div className="space-y-1"><Label htmlFor="pe-date">Production date *</Label><Input id="pe-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="pe-product">Finished product *</Label>
                <ProductPicker id="pe-product" value={product} onChange={(v) => { setProduct(v); setNotice(null); setError(null) }} /></div>
              <div className="space-y-1"><Label>Product SKU</Label><p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{product?.sku ?? '—'}</p></div>
              <div className="space-y-1"><Label>BOM version</Label>
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {!product ? '—' : preview.loading && !p ? <Loader2 className="size-4 animate-spin" />
                    : p?.bom ? <span>{p.bom.bom_code} v{p.bom.version} · {p.bom.item_count} component(s){order && order.bom_version !== p.bom.version ? ` (order uses v${order.bom_version}; saving recalculates)` : ''}</span>
                    : <span className="flex items-center gap-1 text-amber-800"><AlertTriangle className="size-4" /> No active BOM</span>}
                </div></div>
              <div className="space-y-1"><Label htmlFor="pe-planned">Planned production quantity *{unit ? ` (${unit})` : ''}</Label>
                <Input id="pe-planned" inputMode={qtyInputMode(unit)} value={planned} onChange={(e) => setPlanned(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="pe-wh">Production location *</Label>
                <Select value={whId || undefined} onValueChange={(v) => { if (v) setWarehouse(v) }}>
                  <SelectTrigger id="pe-wh"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
                  <SelectContent>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Materials are taken from, and finished goods put into, this warehouse.</p></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="pe-remarks">Remarks</Label><Textarea id="pe-remarks" rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Record production now (optional)</CardTitle><CardDescription>Fill these if the production is already done. Materials are consumed at the BOM standard; to enter different material quantities, save the order and use Complete production.</CardDescription></div></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1"><Label htmlFor="pe-actual">Actual production quantity</Label><Input id="pe-actual" inputMode={qtyInputMode(unit)} value={actual} onChange={(e) => setActual(e.target.value)} placeholder="Leave blank to only create the order" /></div>
              <div className="space-y-1"><Label htmlFor="pe-rejected">Rejected quantity</Label><Input id="pe-rejected" inputMode={qtyInputMode(unit)} value={rejected} onChange={(e) => setRejected(e.target.value)} placeholder="0" /></div>
              <div className="space-y-1"><Label htmlFor="pe-wastage">Wastage</Label><Input id="pe-wastage" inputMode={qtyInputMode(unit)} value={wastage} onChange={(e) => setWastage(e.target.value)} placeholder="0" /></div>
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <CardHeader>
            <div><CardTitle>Material requirement</CardTitle><CardDescription>Calculated from the BOM for the planned quantity, including BOM wastage. Available = free stock in the production location.</CardDescription></div>
            {product && has('production_bom.create') && <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}><Network /> Add missing components</Button>}
          </CardHeader>
          {preview.error ? <CardContent><p className="text-sm text-red-700">{describeDataError(preview.error)}</p></CardContent>
            : <RequirementsTable lines={p?.lines ?? []} emptyText={!product ? 'Choose a finished product.' : !p?.bom ? 'This product has no active BOM yet. Add its components to calculate the materials.' : plannedQty === null ? 'Enter the planned quantity.' : 'Loading…'} />}
        </Card>

        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" asChild><Link to={order ? `/production/orders/${order.id}` : '/production/orders'}>Cancel</Link></Button>
          <Button type="submit" variant={recording ? 'outline' : 'default'} disabled={busy !== null}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {order ? 'Save and recalculate' : 'Save order'}</Button>
          {has('production_order.complete') && (
            <Button type="button" disabled={busy !== null || !recording} onClick={() => void save(true)}>{busy === 'complete' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Save and complete production</Button>
          )}
        </div>
      </form>

      {addOpen && product && (
        <AddComponentsDialog product={{ id: product.product_id, sku: product.sku, unit: product.base_unit }} onClose={() => setAddOpen(false)}
          onAdded={(m) => { setAddOpen(false); setNotice(m); setBomVersion((n) => n + 1) }} />
      )}
    </>
  )
}
