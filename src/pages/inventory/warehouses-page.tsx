import { Loader2, MapPin, Pencil, Plus, Power, PowerOff, Star, Warehouse } from 'lucide-react'
import { useState } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { LOCATION_TYPES, LOCATION_USAGE_LABELS, formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { createLocation, createWarehouse, fetchLocationStockTotals, updateLocation, updateWarehouse } from '@/services/inventory'
import type { LocationRow, WarehouseRow } from '@/types/database-inventory'

const CODE_RE = /^[A-Z0-9][A-Z0-9_./-]{0,29}$/

export default function WarehousesPage() {
  const { access } = useAuth()
  const { has } = usePermissions()
  const companyId = access?.company?.id ?? ''
  const [refresh, setRefresh] = useState(0)
  const storage = useStorage(refresh)
  const stock = useAsync(fetchLocationStockTotals, [refresh])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [warehouseDialog, setWarehouseDialog] = useState<WarehouseRow | 'new' | null>(null)
  const [locationDialog, setLocationDialog] = useState<LocationRow | 'new' | null>(null)
  const [toggle, setToggle] = useState<{ kind: 'warehouse'; row: WarehouseRow } | { kind: 'location'; row: LocationRow } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const reload = (text?: string) => {
    if (text) setNotice({ tone: 'success', text })
    setRefresh((n) => n + 1)
  }

  if (storage.loading && !storage.data) return <LoadingState label="Loading warehouses…" />
  if (storage.error) {
    return (
      <>
        <PageHeader />
        <Card><ErrorState message={describeDataError(storage.error)} onRetry={storage.reload} /></Card>
      </>
    )
  }

  const selected = storage.warehouses.find((w) => w.id === selectedId) ?? storage.warehouses[0] ?? null
  const locations = storage.locations.filter((l) => l.warehouse_id === selected?.id)
  const stockAt = (locationId: string) => stock.data?.get(locationId) ?? 0
  const warehouseStock = (id: string) => storage.locations.filter((l) => l.warehouse_id === id).reduce((s, l) => s + stockAt(l.id), 0)

  // Indented tree order.
  const ordered: { row: LocationRow; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const l of locations.filter((x) => x.parent_location_id === parent).sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.location_code.localeCompare(b.location_code))) {
      ordered.push({ row: l, depth })
      walk(l.id, depth + 1)
    }
  }
  walk(null, 0)

  const runToggle = async () => {
    if (!toggle) return
    setNotice(null)
    try {
      const next = toggle.row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
      if (toggle.kind === 'warehouse') await updateWarehouse(toggle.row.id, { status: next })
      else await updateLocation(toggle.row.id, { status: next })
      reload(`${toggle.kind === 'warehouse' ? toggle.row.warehouse_code : toggle.row.location_code} ${next === 'ACTIVE' ? 'activated' : 'deactivated'}.`)
    } catch (error) {
      setNotice({ tone: 'error', text: describeDataError(error) })
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <PermissionGate permission="inventory_warehouse.manage">
            <Button onClick={() => setWarehouseDialog('new')}><Plus /> New warehouse</Button>
          </PermissionGate>
        }
      />
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}

      {storage.warehouses.length === 0 ? (
        <Card>
          <EmptyState icon={Warehouse} title="No warehouses yet"
            description="Create your first warehouse. A default General area location is created automatically so stock can be received straight away and put away into bins later." />
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card>
            <CardHeader><CardTitle>Warehouses</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {storage.warehouses.map((w) => (
                  <li key={w.id}>
                    <button type="button" onClick={() => setSelectedId(w.id)}
                      className={cn('w-full rounded-lg border px-3 py-2 text-left transition-colors', selected?.id === w.id ? 'border-primary bg-accent' : 'hover:bg-muted')}>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {w.warehouse_code} — {w.warehouse_name}
                        {w.is_default && <Star aria-label="Default warehouse" className="size-3.5 fill-amber-400 text-amber-500" />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        {w.status === 'ACTIVE' ? 'Active' : 'Inactive'} · {storage.locations.filter((l) => l.warehouse_id === w.id).length} locations · {formatQty(warehouseStock(w.id))} units held
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {selected && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {selected.warehouse_code} — {selected.warehouse_name}
                    {selected.status === 'ACTIVE' ? <StatusBadge label="Active" tone="success" /> : <StatusBadge label="Inactive" />}
                    {selected.is_default && <StatusBadge label="Default" tone="info" />}
                  </CardTitle>
                  {selected.address && <p className="mt-1 text-xs text-muted-foreground">{selected.address}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {has('inventory_warehouse.manage') && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setWarehouseDialog(selected)}><Pencil /> Edit</Button>
                      <Button variant="outline" size="sm" onClick={() => setToggle({ kind: 'warehouse', row: selected })}>
                        {selected.status === 'ACTIVE' ? <PowerOff /> : <Power />}
                        {selected.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </Button>
                    </>
                  )}
                  {has('inventory_location.manage') && selected.status === 'ACTIVE' && (
                    <Button size="sm" onClick={() => setLocationDialog('new')}><Plus /> Location</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <ul className="divide-y rounded-lg border">
                  {ordered.map(({ row, depth }) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm" style={{ paddingLeft: 12 + depth * 20 }}>
                      <MapPin aria-hidden className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{row.location_code}</span> — {row.location_name}
                        <span className="ml-2 text-xs text-muted-foreground">{row.location_type}{row.is_default ? ' · default' : ''}</span>
                        {row.stock_usage === 'REJECTED' && <span className="ml-2 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-xs text-red-800">Rejected goods</span>}
                        {row.stock_usage === 'QUARANTINE' && <span className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">Quarantine</span>}
                        {row.stock_usage === 'EXTERNAL_PROCESSING' && (
                          <span className="ml-2 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-xs text-purple-800">Held by {row.external_holder}</span>
                        )}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{formatQty(stockAt(row.id))} units</span>
                      {row.status === 'ACTIVE' ? <StatusBadge label="Active" tone="success" /> : <StatusBadge label="Inactive" />}
                      {has('inventory_location.manage') && (
                        <span className="flex gap-1">
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.location_code}`} onClick={() => setLocationDialog(row)}><Pencil /></Button>
                          {!row.is_default && (
                            <Button variant="ghost" size="icon-sm" aria-label={row.status === 'ACTIVE' ? `Deactivate ${row.location_code}` : `Activate ${row.location_code}`}
                              title={row.status === 'ACTIVE' && stockAt(row.id) > 0 ? 'Holds stock: transfer it out first' : undefined}
                              disabled={row.status === 'ACTIVE' && stockAt(row.id) > 0}
                              onClick={() => setToggle({ kind: 'location', row })}>
                              {row.status === 'ACTIVE' ? <PowerOff /> : <Power />}
                            </Button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  Locations holding stock cannot be deactivated; transfer the stock first. Warehouses and locations are never deleted because the ledger references them.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {warehouseDialog && (
        <WarehouseDialog
          warehouse={warehouseDialog === 'new' ? null : warehouseDialog}
          onClose={() => setWarehouseDialog(null)}
          onSave={async (v) => {
            if (warehouseDialog === 'new') await createWarehouse(companyId, v)
            else await updateWarehouse(warehouseDialog.id, { warehouse_name: v.name, address: v.address, is_default: v.isDefault || undefined })
            setWarehouseDialog(null)
            reload(`Warehouse ${v.code} saved.`)
          }}
        />
      )}
      {locationDialog && selected && (
        <LocationDialog
          location={locationDialog === 'new' ? null : locationDialog}
          warehouse={selected}
          parents={locations.filter((l) => l.status === 'ACTIVE' && (locationDialog === 'new' || l.id !== locationDialog.id))}
          onClose={() => setLocationDialog(null)}
          onSave={async (v) => {
            if (locationDialog === 'new') await createLocation(companyId, { warehouseId: selected.id, ...v })
            else await updateLocation(locationDialog.id, {
              location_name: v.name, location_type: v.type, parent_location_id: v.parentId,
              stock_usage: v.usage, external_holder: v.usage === 'EXTERNAL_PROCESSING' ? v.externalHolder : null,
            })
            setLocationDialog(null)
            reload(`Location ${v.code} saved.`)
          }}
        />
      )}
      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.row.status === 'ACTIVE' ? 'Deactivate?' : 'Activate?'}
        description={toggle?.row.status === 'ACTIVE'
          ? 'It can no longer be used for new transactions. The database refuses this while stock is held there.'
          : 'It can be used for new transactions again.'}
        confirmLabel={toggle?.row.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        destructive={toggle?.row.status === 'ACTIVE'}
        onConfirm={() => void runToggle()}
      />
    </>
  )
}

function WarehouseDialog({ warehouse, onClose, onSave }: {
  warehouse: WarehouseRow | null
  onClose: () => void
  onSave: (v: { code: string; name: string; address: string | null; isDefault: boolean }) => Promise<void>
}) {
  const [code, setCode] = useState(warehouse?.warehouse_code ?? '')
  const [name, setName] = useState(warehouse?.warehouse_name ?? '')
  const [address, setAddress] = useState(warehouse?.address ?? '')
  const [isDefault, setIsDefault] = useState(warehouse?.is_default ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{warehouse ? 'Edit warehouse' : 'New warehouse'}</DialogTitle>
          <DialogDescription>Codes are unique within the company and cannot be changed later.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-4">
          <div className="space-y-1.5"><Label htmlFor="wh-code">Code</Label>
            <Input id="wh-code" value={code} disabled={Boolean(warehouse)} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} placeholder="e.g. MAIN" /></div>
          <div className="space-y-1.5"><Label htmlFor="wh-name">Name</Label>
            <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
          <div className="space-y-1.5"><Label htmlFor="wh-addr">Address</Label>
            <Textarea id="wh-addr" value={address} onChange={(e) => setAddress(e.target.value)} rows={2} maxLength={500} /></div>
          <div className="flex items-center gap-2">
            <Checkbox id="wh-default" checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} disabled={warehouse?.is_default} />
            <Label htmlFor="wh-default" className="font-normal">Default warehouse (pre-selected for receipts)</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setError(null)
            if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(code)) return setError('Code: 1–20 letters, digits, _ or -.')
            if (!name.trim()) return setError('Enter a name.')
            setBusy(true)
            try { await onSave({ code, name: name.trim(), address: address.trim() || null, isDefault }) } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LocationDialog({ location, warehouse, parents, onClose, onSave }: {
  location: LocationRow | null
  warehouse: WarehouseRow
  parents: LocationRow[]
  onClose: () => void
  onSave: (v: {
    code: string
    name: string
    type: LocationRow['location_type']
    parentId: string | null
    usage: LocationRow['stock_usage']
    externalHolder: string | null
  }) => Promise<void>
}) {
  const [code, setCode] = useState(location?.location_code ?? '')
  const [name, setName] = useState(location?.location_name ?? '')
  const [type, setType] = useState<LocationRow['location_type']>(location?.location_type ?? 'BIN')
  const [usage, setUsage] = useState<LocationRow['stock_usage']>(location?.stock_usage ?? 'STORAGE')
  const [holder, setHolder] = useState(location?.external_holder ?? '')
  const [parentId, setParentId] = useState(location?.parent_location_id ?? 'none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{location ? 'Edit location' : `New location in ${warehouse.warehouse_code}`}</DialogTitle>
          <DialogDescription>Codes are unique within the warehouse and cannot be changed later.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="loc-code">Code</Label>
            <Input id="loc-code" value={code} disabled={Boolean(location)} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={30} placeholder="e.g. A-01-03" /></div>
          <div className="space-y-1.5"><Label htmlFor="loc-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as LocationRow['location_type'])} disabled={location?.is_default}>
              <SelectTrigger id="loc-type"><SelectValue /></SelectTrigger>
              <SelectContent>{LOCATION_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="loc-name">Name</Label>
            <Input id="loc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="loc-parent">Inside (parent)</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="loc-parent"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Top level of the warehouse</SelectItem>
                {parents.map((p) => <SelectItem key={p.id} value={p.id}>{p.location_code} — {p.location_name}</SelectItem>)}
              </SelectContent>
            </Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="loc-usage">Used for</Label>
            <Select value={usage} onValueChange={(v) => setUsage(v as LocationRow['stock_usage'])} disabled={location?.is_default}>
              <SelectTrigger id="loc-usage"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(LOCATION_USAGE_LABELS).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only storage locations count as available stock. Rejected-goods locations hold non-saleable stock. Stock at an outside-processor location
              stays company-owned and moves only through outsourcing orders. Quarantine locations receive customer returns until they are inspected.
              The usage cannot change while the location holds stock.
            </p></div>
          {usage === 'EXTERNAL_PROCESSING' && (
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="loc-holder">Held by (supplier / processor)</Label>
              <Input id="loc-holder" value={holder} onChange={(e) => setHolder(e.target.value)} maxLength={200} placeholder="Name of the job worker holding the material" /></div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setError(null)
            if (!CODE_RE.test(code)) return setError('Code: 1–30 letters, digits, _ . / or -.')
            if (!name.trim()) return setError('Enter a name.')
            if (usage === 'EXTERNAL_PROCESSING' && !holder.trim()) return setError('Enter who holds the stock at this location.')
            setBusy(true)
            try {
              await onSave({ code, name: name.trim(), type, parentId: parentId === 'none' ? null : parentId, usage, externalHolder: holder.trim() || null })
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
