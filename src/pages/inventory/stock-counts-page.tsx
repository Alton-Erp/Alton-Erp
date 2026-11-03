import { ListChecks, Loader2, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DocumentStatusBadge } from '@/features/inventory/inventory-badges'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { createCount, fetchCounts, type ProductOption } from '@/services/inventory'
import { fetchDisplayNames } from '@/services/products'
import type { CountRow } from '@/types/database-inventory'

export default function StockCountsPage() {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const storage = useStorage()
  const list = useAsync(fetchCounts, [])
  const names = useAsync(() => fetchDisplayNames((list.data ?? []).flatMap((c) => [c.created_by, c.reviewed_by])), [list.data])
  const [creating, setCreating] = useState(false)

  const columns: DataTableColumn<CountRow>[] = [
    { id: 'no', header: 'Count', cell: (c) => <span className="font-medium text-primary">{c.count_number}</span>, searchValue: (c) => c.count_number },
    { id: 'scope', header: 'Scope', cell: (c) => `${storage.warehouseById.get(c.warehouse_id)?.warehouse_code ?? '?'}${c.location_id ? ` / ${storage.locationById.get(c.location_id)?.location_code ?? '?'}` : ' (whole warehouse)'}${c.product_ids?.length ? ` · ${c.product_ids.length} products` : ''}` },
    { id: 'snap', header: 'System snapshot', cell: (c) => formatDateTime(c.snapshot_at) },
    { id: 'by', header: 'Started by', cell: (c) => names.data?.get(c.created_by ?? '') ?? '…' },
    { id: 'rev', header: 'Reviewed', cell: (c) => (c.reviewed_by ? `${names.data?.get(c.reviewed_by) ?? '…'} · ${c.reviewed_at ? formatDateTime(c.reviewed_at) : ''}` : '—') },
    { id: 'status', header: 'Status', cell: (c) => <DocumentStatusBadge status={c.status} />, searchValue: (c) => c.status },
  ]

  return (
    <>
      <PageHeader actions={has('inventory_count.create') ? <Button onClick={() => setCreating(true)}><Plus /> Start count</Button> : undefined} />
      <p className="mb-4 text-sm text-muted-foreground">Counting never changes stock by itself. Variances are posted as adjustments only when the count is approved by a different authorised user.</p>
      <DataTable
        title="Stock counts"
        columns={columns}
        data={list.data ?? []}
        getRowId={(c) => c.id}
        loading={list.loading}
        error={list.error ? new Error(describeDataError(list.error)) : null}
        onRetry={list.reload}
        searchPlaceholder="Search count number or status…"
        onRowClick={(c) => navigate(`/inventory/counts/${c.id}`)}
        emptyState={{ icon: ListChecks, title: 'No stock counts yet', description: 'Start a count for a warehouse, a location or selected products. System quantities are captured when the count starts.' }}
      />
      {creating && <CreateCountDialog storage={storage} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/inventory/counts/${id}`)} />}
    </>
  )
}

function CreateCountDialog({ storage, onClose, onCreated }: { storage: ReturnType<typeof useStorage>; onClose: () => void; onCreated: (id: string) => void }) {
  const { key } = useRequestKey()
  const [warehouseId, setWarehouseId] = useState('')
  const [locationId, setLocationId] = useState('all')
  const [children, setChildren] = useState(true)
  const [products, setProducts] = useState<ProductOption[]>([])
  const [picker, setPicker] = useState<ProductOption | null>(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeWarehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE')
  const locations = storage.allLocations.filter((l) => l.warehouseId === warehouseId && l.active)

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Start a stock count</DialogTitle>
          <DialogDescription>The current system quantity of every lot in scope is captured now. Found items can be added to the sheet.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="cc-wh">Warehouse</Label>
            <Select value={warehouseId} onValueChange={(v) => { setWarehouseId(v); setLocationId('all') }}>
              <SelectTrigger id="cc-wh"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label htmlFor="cc-loc">Location</Label>
            <Select value={locationId} onValueChange={setLocationId} disabled={!warehouseId}>
              <SelectTrigger id="cc-loc"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">Whole warehouse</SelectItem>
                {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select></div>
          {locationId !== 'all' && (
            <div className="flex items-center gap-2 sm:col-span-2"><Checkbox id="cc-children" checked={children} onCheckedChange={(v) => setChildren(v === true)} />
              <Label htmlFor="cc-children" className="font-normal">Include locations inside it</Label></div>
          )}
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="cc-prod">Limit to products (optional)</Label>
            <ProductPicker id="cc-prod" value={picker} includeInactive onChange={(p) => { if (p && !products.some((x) => x.product_id === p.product_id)) setProducts([...products, p]); setPicker(null) }} />
            {products.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {products.map((p) => (
                  <span key={p.product_id} className="inline-flex items-center gap-1 rounded-md border bg-surface-muted px-2 py-0.5 text-xs">
                    {p.sku}
                    <button type="button" aria-label={`Remove ${p.sku}`} onClick={() => setProducts(products.filter((x) => x.product_id !== p.product_id))}><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="cc-notes">Notes</Label><Textarea id="cc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy || !warehouseId} onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const r = await createCount({ warehouseId, locationId: locationId === 'all' ? null : locationId, includeSublocations: children, productIds: products.length ? products.map((p) => p.product_id) : null, notes: notes.trim() || null }, key)
              onCreated(r.count_id)
            } catch (e) {
              setError(describeDataError(e))
              setBusy(false)
            }
          }}>
            {busy && <Loader2 className="animate-spin" />} Start count
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
