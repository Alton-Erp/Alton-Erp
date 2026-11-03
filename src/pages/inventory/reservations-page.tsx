import { Loader2, Lock, PackageCheck, Plus, Unlock } from 'lucide-react'
import { useEffect, useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ReservationStatusBadge, StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { LocationSelect, LotSelect, LotSummary, ProductPicker } from '@/features/inventory/pickers'
import { Field, StockFormDialog } from '@/features/inventory/stock-dialogs'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  createReservation,
  expireReservations,
  fetchReservations,
  fulfilReservation,
  releaseReservation,
  type ProductOption,
  type ReservationListRow,
} from '@/services/inventory'
import type { StockDetailRow } from '@/types/database-inventory'

type StatusFilter = 'OPEN' | 'FULFILLED' | 'RELEASED' | 'CANCELLED' | 'EXPIRED' | 'ALL'

const remaining = (r: ReservationListRow) => Number(r.quantity) - Number(r.fulfilled_quantity) - Number(r.released_quantity)

export default function ReservationsPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [refresh, setRefresh] = useState(0)
  const [expired, setExpired] = useState(0)
  const list = useAsync(() => fetchReservations(status === 'ALL' ? null : status), [status, refresh])
  const [creating, setCreating] = useState(false)
  const [action, setAction] = useState<{ kind: 'release' | 'cancel' | 'fulfil'; row: ReservationListRow } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  // Lazily expire overdue reservations so availability is restored.
  useEffect(() => {
    void expireReservations()
      .then((n) => {
        if (n > 0) {
          setExpired(n)
          setRefresh((x) => x + 1)
        }
      })
      .catch(() => undefined)
  }, [])

  const done = (text: string) => {
    setNotice({ tone: 'success', text })
    setRefresh((n) => n + 1)
  }

  const columns: DataTableColumn<ReservationListRow>[] = [
    { id: 'no', header: 'Reservation', cell: (r) => <span className="font-medium">{r.reservation_number}</span>, searchValue: (r) => r.reservation_number },
    { id: 'ref', header: 'Reference', cell: (r) => <span>{r.reference_type} <span className="font-medium">{r.reference_number}</span></span>, searchValue: (r) => `${r.reference_type} ${r.reference_number}` },
    { id: 'product', header: 'Product', cell: (r) => <span><span className="font-medium">{r.sku}</span> {r.product_name}</span>, searchValue: (r) => `${r.sku} ${r.product_name}` },
    { id: 'loc', header: 'Location', cell: (r) => `${r.warehouse_code} / ${r.location_code}${r.batch_number ? ` · ${r.batch_number}` : ''}` },
    { id: 'src', header: 'Source', cell: (r) => <StockSourceBadge source={r.source_type} /> },
    { id: 'qty', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.quantity, r.base_unit) },
    { id: 'ful', header: 'Fulfilled', align: 'right', cell: (r) => formatQty(r.fulfilled_quantity) },
    { id: 'rem', header: 'Remaining', align: 'right', cell: (r) => <span className="font-medium text-amber-800">{formatQty(remaining(r))}</span> },
    { id: 'status', header: 'Status', cell: (r) => <ReservationStatusBadge status={r.reservation_status} /> },
    { id: 'at', header: 'Reserved', cell: (r) => <span className="text-muted-foreground">{formatDateTime(r.reserved_at)}</span> },
    { id: 'exp', header: 'Expires', cell: (r) => (r.expires_at ? formatDateTime(r.expires_at) : '—') },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (r) =>
        ['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.reservation_status) ? (
          <span className="flex justify-end gap-1.5">
            {has('inventory.create') && <Button size="sm" variant="outline" onClick={() => setAction({ kind: 'fulfil', row: r })}><PackageCheck /> Fulfil</Button>}
            {has('inventory_reservation.release') && (
              <>
                <Button size="sm" variant="outline" onClick={() => setAction({ kind: 'release', row: r })}><Unlock /> Release</Button>
                <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'cancel', row: r })}>Cancel</Button>
              </>
            )}
          </span>
        ) : null,
    },
  ]

  return (
    <>
      <PageHeader actions={has('inventory_reservation.create') ? <Button onClick={() => setCreating(true)}><Plus /> New reservation</Button> : undefined} />
      {expired > 0 && <p role="status" className="mb-4 rounded-lg border bg-background px-4 py-2.5 text-sm">{expired} overdue reservation(s) expired and their quantity was made available again.</p>}
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}
      <DataTable
        title="Reservations"
        description="Reserved stock reduces available quantity, not on-hand quantity. Fulfilment posts an actual issue."
        columns={columns}
        data={list.data ?? []}
        getRowId={(r) => r.id}
        loading={list.loading}
        error={list.error ? new Error(describeDataError(list.error)) : null}
        onRetry={list.reload}
        searchPlaceholder="Search reservation, reference, product…"
        pageSize={25}
        toolbar={
          <FilterTabs<StatusFilter> label="Status" value={status} onChange={setStatus}
            options={[{ value: 'OPEN', label: 'Open' }, { value: 'FULFILLED', label: 'Fulfilled' }, { value: 'RELEASED', label: 'Released' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'ALL', label: 'All' }]} />
        }
        emptyState={{ icon: Lock, title: 'No reservations', description: 'Reserve stock for an order or other purpose with a reference number. A sales order module will create reservations automatically in a later phase.' }}
      />
      <CreateReservationDialog open={creating} onOpenChange={setCreating} locations={storage.activeLocations} onDone={done} />
      {action?.kind === 'fulfil' && <FulfilDialog row={action.row} onClose={() => setAction(null)} onDone={done} />}
      {action && action.kind !== 'fulfil' && <ReleaseDialog kind={action.kind} row={action.row} onClose={() => setAction(null)} onDone={done} />}
    </>
  )
}

function CreateReservationDialog({ open, onOpenChange, locations, onDone }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  locations: ReturnType<typeof useStorage>['activeLocations']
  onDone: (t: string) => void
}) {
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [lot, setLot] = useState<StockDetailRow | null>(null)
  const [qty, setQty] = useState('')
  const [refType, setRefType] = useState('ORDER')
  const [refNo, setRefNo] = useState('')
  const [expires, setExpires] = useState('')
  const [notes, setNotes] = useState('')
  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reserve stock"
      description="Allocate available stock to an order or purpose. On-hand stock is not changed until the reservation is fulfilled."
      confirmLabel="Reserve"
      validate={() => {
        if (!product || !locationId || !lot) return 'Select product, location and lot.'
        const q = parseUnitQty(qty, product.base_unit)
        if (!q) return `Enter a quantity greater than zero (${quantityRule(product.base_unit)}).`
        if (q > Number(lot.available)) return `Only ${formatQty(lot.available, lot.base_unit)} is available.`
        if (!refNo.trim()) return 'Enter the reference number (e.g. order number).'
        if (expires && new Date(expires) <= new Date()) return 'Expiry must be in the future.'
        return null
      }}
      review={() => [
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'Location / lot', value: lot ? `${lot.warehouse_code} / ${lot.location_code} · ${lot.batch_number ?? lot.source_type}` : '' },
        { label: 'Quantity', value: formatQty(parseUnitQty(qty, product?.base_unit), product?.base_unit) },
        { label: 'Reference', value: `${refType} ${refNo}` },
        { label: 'Expires', value: expires ? formatDateTime(new Date(expires)) : 'No expiry' },
      ]}
      submit={async (key) => {
        const r = await createReservation(
          { productId: product!.product_id, locationId, batchId: lot!.batch_id, quantity: parseUnitQty(qty, product?.base_unit)!, referenceType: refType, referenceNumber: refNo.trim(), notes: notes.trim() || null, expiresAt: expires ? new Date(expires).toISOString() : null },
          key,
        )
        onDone(`Reservation ${r.reservation_number} created.`)
        setProduct(null)
        setLot(null)
        setQty('')
        setRefNo('')
        setNotes('')
        setExpires('')
        return r.reservation_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Product" htmlFor="rs-product" full><ProductPicker id="rs-product" value={product} onChange={(p) => { setProduct(p); setLot(null) }} autoFocus /></Field>
        <Field label="Location" htmlFor="rs-loc"><LocationSelect id="rs-loc" value={locationId} onChange={(v) => { setLocationId(v); setLot(null) }} options={locations} /></Field>
        <Field label={`Quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="rs-qty"><Input id="rs-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Lot / source" htmlFor="rs-lot" full>
          <LotSelect id="rs-lot" productId={product?.product_id ?? null} locationId={locationId || null} value={lot} onChange={setLot} />
          {lot && <LotSummary lot={lot} />}
        </Field>
        <Field label="Reference type" htmlFor="rs-rtype">
          <Select value={refType} onValueChange={setRefType}>
            <SelectTrigger id="rs-rtype"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ORDER">Customer order</SelectItem>
              <SelectItem value="QUOTATION">Quotation</SelectItem>
              <SelectItem value="PROJECT">Project</SelectItem>
              <SelectItem value="INTERNAL">Internal use</SelectItem>
              <SelectItem value="OTHER">Other</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Reference number" htmlFor="rs-rno"><Input id="rs-rno" value={refNo} onChange={(e) => setRefNo(e.target.value)} maxLength={100} /></Field>
        <Field label="Expires at (optional)" htmlFor="rs-exp" hint="Expired reservations release their quantity automatically."><Input id="rs-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <Field label="Purpose / notes" htmlFor="rs-notes" full><Textarea id="rs-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      </div>
    </StockFormDialog>
  )
}

function FulfilDialog({ row, onClose, onDone }: { row: ReservationListRow; onClose: () => void; onDone: (t: string) => void }) {
  const { key, renew } = useRequestKey()
  const [qty, setQty] = useState(String(remaining(row)))
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fulfil {row.reservation_number}</DialogTitle>
          <DialogDescription>Posts an ISSUE from {row.warehouse_code} / {row.location_code} and reduces the reservation in the same transaction.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="fu-qty">Quantity ({row.base_unit}) — remaining {formatQty(remaining(row))}</Label>
            <Input id="fu-qty" inputMode={qtyInputMode(row.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="fu-ref">Dispatch / reference (optional)</Label>
            <Input id="fu-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            const q = parseUnitQty(qty, row.base_unit)
            if (!q || q > remaining(row)) return setError(`Enter a quantity between 0 and ${formatQty(remaining(row))} (${quantityRule(row.base_unit)}).`)
            setBusy(true)
            setError(null)
            try {
              const r = await fulfilReservation(row.id, q, reference.trim() || null, null, key)
              renew()
              onClose()
              onDone(`Issued ${formatQty(q, row.base_unit)} (${r.transaction_number}). Reservation is now ${r.reservation_status.toLowerCase().replace('_', ' ')}.`)
            } catch (e) {
              setError(describeDataError(e))
            } finally {
              setBusy(false)
            }
          }}>
            {busy && <Loader2 className="animate-spin" />} Post issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReleaseDialog({ kind, row, onClose, onDone }: { kind: 'release' | 'cancel'; row: ReservationListRow; onClose: () => void; onDone: (t: string) => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'release' ? 'Release' : 'Cancel'} {row.reservation_number}?</DialogTitle>
          <DialogDescription>{formatQty(remaining(row), row.base_unit)} becomes available again. On-hand stock does not change.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1.5"><Label htmlFor="rl-note">Note (optional)</Label><Textarea id="rl-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await releaseReservation(row.id, kind === 'release' ? 'RELEASE' : 'CANCEL', note.trim() || null)
              onClose()
              onDone(`${row.reservation_number} ${kind === 'release' ? 'released' : 'cancelled'}.`)
            } catch (e) {
              setError(describeDataError(e))
            } finally {
              setBusy(false)
            }
          }}>
            {busy && <Loader2 className="animate-spin" />} {kind === 'release' ? 'Release' : 'Cancel reservation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
