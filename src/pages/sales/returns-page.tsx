import { ClipboardCheck, Loader2, PackageX, Plus, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { ReturnStatusBadge } from '@/features/sales/sales-badges'
import { DISPOSITION_LABELS, RETURN_REASON_LABELS, parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { createReturn, fetchFulfilmentLines, fetchOrderOptions, fetchReturnLines, fetchReturns, inspectReturn, postReturnDisposition, receiveReturn, reviewReturn } from '@/services/sales'
import type { CustomerReturnListRow, Disposition, ReturnReason, ReturnStatus } from '@/types/database-sales'

type Tab = 'OPEN' | 'CLOSED' | 'REJECTED' | 'ALL'
const ErrorBox = ({ message }: { message: string | null }) => (message ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p> : null)

function NewReturnDialog({ initialOrderId, onClose, onCreated }: { initialOrderId: string | null; onClose: () => void; onCreated: (id: string, number: string) => void }) {
  const orders = useAsync(() => fetchOrderOptions(null), [])
  const withDispatch = (orders.data ?? []).filter((o) => (o.unit_totals ?? []).some((u) => Number(u.dispatched) > 0))
  const [orderId, setOrderId] = useState(initialOrderId ?? '')
  const lines = useAsync(() => (orderId ? fetchFulfilmentLines({ orderId, dispatchedOnly: true }) : Promise.resolve([])), [orderId])
  const [qty, setQty] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<ReturnReason | ''>('')
  const [note, setNote] = useState('')
  const [today] = useState(() => toIsoDate(new Date()))
  const [date, setDate] = useState(today)
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Record customer return</DialogTitle>
          <DialogDescription>Select the dispatched items coming back. Nothing changes in stock until the return is authorised and physically received into quarantine; returned goods become sellable only after inspection.</DialogDescription></DialogHeader>
        <ErrorBox message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="nr-order">Sales order</Label>
            <Select value={orderId} onValueChange={setOrderId}><SelectTrigger id="nr-order"><SelectValue placeholder={orders.loading ? 'Loading…' : 'Select an order with dispatched goods'} /></SelectTrigger>
              <SelectContent className="max-h-72">{withDispatch.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No dispatched orders.</div>}
                {withDispatch.map((o) => <SelectItem key={o.id} value={o.id}>{o.sales_order_number} · {o.customer_name_snapshot}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="nr-reason">Reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as ReturnReason)}><SelectTrigger id="nr-reason"><SelectValue placeholder="Select the reason" /></SelectTrigger>
              <SelectContent>{Object.entries(RETURN_REASON_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="nr-date">Return date</Label><Input id="nr-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="nr-ref">Customer reference</Label><Input id="nr-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="nr-note">Details</Label><Textarea id="nr-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        {orderId && (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Consignment</th><th className="pb-1 text-left">Product / batch</th><th className="pb-1 text-right">Dispatched</th><th className="pb-1 text-right">Returning</th></tr></thead>
            <tbody>{(lines.data ?? []).map((l) => (
              <tr key={l.id} className="border-t"><td className="py-1.5">{l.fulfilment_number}</td><td className="py-1.5">{l.sku}{l.batch_number ? ` · ${l.batch_number}` : ''}</td>
                <td className="py-1.5 text-right">{formatQty(l.quantity_dispatched, l.unit)}</td>
                <td className="py-1.5 text-right"><Input aria-label={`Returning quantity ${l.fulfilment_number} line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} /></td></tr>
            ))}</tbody>
          </table>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            if (!orderId) return setError('Choose the sales order.')
            if (!reason) return setError('Choose the return reason.')
            const entries = (lines.data ?? []).map((l) => ({ fulfilment_line_id: l.id, quantity: parseQty(qty[l.id] ?? '') }))
            if (entries.some((e) => e.quantity === null)) return setError('Enter quantities as numbers.')
            const chosen = entries.filter((e) => (e.quantity ?? 0) > 0) as { fulfilment_line_id: string; quantity: number }[]
            if (chosen.length === 0) return setError('Enter at least one returned quantity.')
            setBusy(true); setError(null)
            try {
              const r = await createReturn(orderId, { return_date: date || null, reason_code: reason, reason_note: note.trim() || null, customer_reference: reference.trim() || null, notes: null }, chosen, key)
              renew(); onCreated(r.return_id, r.return_number)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Record return</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReturnPanel({ ret, onChanged }: { ret: CustomerReturnListRow; onChanged: (m: string) => void }) {
  const { has } = usePermissions()
  const storage = useStorage()
  const lines = useAsync(() => fetchReturnLines(ret.id), [ret.id, ret.status, ret.updated_at])
  const names = useAsync(() => fetchDisplayNames([ret.requested_by, ret.authorized_by, ret.received_by, ret.inspected_by, ret.closed_by]), [ret.id, ret.updated_at])
  const who = (id: string | null) => (id && names.data?.get(id)) || '—'
  const quarantine = storage.activeLocations.filter((l) => l.usage === 'QUARANTINE')
  const storageLocs = storage.activeLocations.filter((l) => l.usage === 'STORAGE')
  const rejectLocs = storage.activeLocations.filter((l) => l.usage === 'REJECTED')
  const [location, setLocation] = useState('')
  const [receivedEdits, setReceived] = useState<Record<string, string>>({})
  const [dispEdits, setDisp] = useState<Record<string, Disposition>>({})
  const [noteEdits, setNotes] = useState<Record<string, string>>({})
  const [inspNote, setInspNote] = useState('')
  const [restock, setRestock] = useState('')
  const [scrap, setScrap] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'RECEIVE' | 'POST' | 'ACCEPTED' | 'REJECTED'>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const { key, renew } = useRequestKey()

  // Edits on top of the recorded values (the panel is re-mounted whenever the return changes).
  const ls = lines.data ?? []
  const received: Record<string, string> = { ...Object.fromEntries(ls.map((l) => [l.id, String(Number(l.quantity_requested))])), ...receivedEdits }
  const disp: Record<string, Disposition> = { ...Object.fromEntries(ls.map((l) => [l.id, l.disposition])), ...dispEdits }
  const notes: Record<string, string> = { ...Object.fromEntries(ls.map((l) => [l.id, l.inspection_note ?? ''])), ...noteEdits }

  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setError(null)
    try { const m = await fn(); renew(); onChanged(m) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const needsRestock = (lines.data ?? []).some((l) => Number(l.quantity_received) > 0 && !l.disposition_posted && l.disposition === 'RESTOCK')
  const needsScrap = (lines.data ?? []).some((l) => Number(l.quantity_received) > 0 && !l.disposition_posted && l.disposition === 'SCRAP')
  const status: ReturnStatus = ret.status

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2">{ret.return_number} <ReturnStatusBadge status={ret.status} /></CardTitle>
          <CardDescription><Link className="text-primary hover:underline" to={`/sales/order-details?so=${ret.sales_order_id}`}>{ret.sales_order_number}</Link> · {ret.customer_name_snapshot} · {formatDate(ret.return_date)} · {RETURN_REASON_LABELS[ret.reason_code]}{ret.reason_note ? ` — ${ret.reason_note}` : ''}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorBox message={error} />
        <dl className="grid gap-3 text-sm sm:grid-cols-3 xl:grid-cols-5">
          <div><dt className="text-xs text-muted-foreground">Requested</dt><dd>{who(ret.requested_by)} · {formatDateTime(ret.created_at)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Authorised / rejected</dt><dd>{ret.authorized_at ? `${who(ret.authorized_by)} · ${formatDateTime(ret.authorized_at)}` : '—'}{ret.decision_note && <span className="block text-xs">{ret.decision_note}</span>}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Received (quarantine)</dt><dd>{ret.received_at ? `${who(ret.received_by)} · ${formatDateTime(ret.received_at)} · ${ret.receipt_location_code}` : '—'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Inspected</dt><dd>{ret.inspected_at ? `${who(ret.inspected_by)} · ${formatDateTime(ret.inspected_at)}` : '—'}{ret.inspection_note && <span className="block text-xs">{ret.inspection_note}</span>}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Closed</dt><dd>{ret.closed_at ? `${who(ret.closed_by)} · ${formatDateTime(ret.closed_at)}` : '—'}</dd></div>
        </dl>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Line</th><th className="pb-1 text-left">Product / batch / consignment</th><th className="pb-1 text-right">Requested</th>
              <th className="pb-1 text-right">Received</th><th className="pb-1 text-left">Disposition</th><th className="pb-1 text-left">Inspection note</th><th className="pb-1 text-left">Ledger</th></tr></thead>
            <tbody>{(lines.data ?? []).map((l) => (
              <tr key={l.id} className="border-t align-top">
                <td className="py-2">{l.line_no}</td>
                <td className="py-2">{l.sku}<span className="block text-xs text-muted-foreground">{l.batch_number ?? 'no batch'} · {l.fulfilment_number}</span></td>
                <td className="py-2 text-right">{formatQty(l.quantity_requested, l.unit)}</td>
                <td className="py-2 text-right">{status === 'AUTHORIZED' && has('fulfilment_returns.receive_stock') ? (
                  <Input aria-label={`Received quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={received[l.id] ?? ''} onChange={(e) => setReceived((x) => ({ ...x, [l.id]: e.target.value }))} />
                ) : formatQty(l.quantity_received)}</td>
                <td className="py-2">{['RECEIVED', 'UNDER_INSPECTION'].includes(status) && has('fulfilment_returns.inspect') && Number(l.quantity_received) > 0 ? (
                  <Select value={disp[l.id] ?? 'PENDING_REVIEW'} onValueChange={(v) => setDisp((x) => ({ ...x, [l.id]: v as Disposition }))}>
                    <SelectTrigger aria-label={`Disposition line ${l.line_no}`} className="h-8 w-52"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(DISPOSITION_LABELS).map(([k, lab]) => <SelectItem key={k} value={k}>{lab}</SelectItem>)}</SelectContent></Select>
                ) : <span className="text-xs">{DISPOSITION_LABELS[l.disposition]}{l.disposition_posted ? ' · posted' : ''}</span>}</td>
                <td className="py-2">{['RECEIVED', 'UNDER_INSPECTION'].includes(status) && has('fulfilment_returns.inspect') && Number(l.quantity_received) > 0 ? (
                  <Input aria-label={`Inspection note line ${l.line_no}`} className="h-8 w-48" maxLength={500} value={notes[l.id] ?? ''} onChange={(e) => setNotes((x) => ({ ...x, [l.id]: e.target.value }))} />
                ) : <span className="text-xs">{l.inspection_note ?? ''}</span>}</td>
                <td className="py-2 text-xs">{l.receipt_transaction_number ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        {status === 'REQUESTED' && has('fulfilment_returns.approve') && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button onClick={() => setAction({ title: `Authorise ${ret.return_number}`, description: 'The customer may send the goods back. No stock changes until they are received into quarantine.', confirmLabel: 'Authorise', note: 'optional',
              run: async (note) => { await reviewReturn(ret.id, 'AUTHORIZE', note); return `${ret.return_number} authorised.` } })}>Authorise</Button>
            <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Reject ${ret.return_number}`, description: 'The return request is closed without any stock movement.', confirmLabel: 'Reject return', note: 'required', destructive: true,
              run: async (note) => { await reviewReturn(ret.id, 'REJECT', note); return `${ret.return_number} rejected.` } })}>Reject</Button>
          </div>
        )}
        {status === 'AUTHORIZED' && has('fulfilment_returns.receive_stock') && (
          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <div className="space-y-1"><Label htmlFor="rt-loc">Receive into quarantine location</Label>
              <Select value={location} onValueChange={setLocation}><SelectTrigger id="rt-loc" className="w-72"><SelectValue placeholder={quarantine.length ? 'Select' : 'No quarantine location'} /></SelectTrigger>
                <SelectContent>{quarantine.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select></div>
            {quarantine.length === 0 && <p className="pb-2 text-sm text-amber-800">Create a location with usage "Quarantine" under Warehouses &amp; Locations first.</p>}
            <Button disabled={busy || !location} onClick={() => setConfirm('RECEIVE')}><PackageX /> Receive goods</Button>
          </div>
        )}
        {['RECEIVED', 'UNDER_INSPECTION'].includes(status) && has('fulfilment_returns.inspect') && (
          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1"><Label htmlFor="rt-insp">Inspection result note</Label><Textarea id="rt-insp" rows={2} maxLength={1000} value={inspNote} onChange={(e) => setInspNote(e.target.value)} /></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await inspectReturn(ret.id, inspection(), null, inspNote.trim() || null); return 'Inspection saved.' })}>Save inspection</Button>
              <Button disabled={busy} onClick={() => setConfirm('ACCEPTED')}><ClipboardCheck /> Accept return</Button>
              <Button variant="outline" className="text-shortage" disabled={busy} onClick={() => setConfirm('REJECTED')}>Reject after inspection</Button>
            </div>
          </div>
        )}
        {['ACCEPTED', 'REJECTED'].includes(status) && ret.received_at && has('fulfilment_returns.receive_stock') && (
          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            {needsRestock && <div className="space-y-1"><Label htmlFor="rt-restock">Restock into (sellable storage)</Label>
              <Select value={restock} onValueChange={setRestock}><SelectTrigger id="rt-restock" className="w-72"><SelectValue placeholder="Select storage location" /></SelectTrigger>
                <SelectContent>{storageLocs.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select></div>}
            {needsScrap && <div className="space-y-1"><Label htmlFor="rt-scrap">Scrap into (rejected goods)</Label>
              <Select value={scrap} onValueChange={setScrap}><SelectTrigger id="rt-scrap" className="w-72"><SelectValue placeholder="Select rejected location" /></SelectTrigger>
                <SelectContent>{rejectLocs.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select></div>}
            <Button disabled={busy || (needsRestock && !restock) || (needsScrap && !scrap)} onClick={() => setConfirm('POST')}>Post dispositions and close</Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'RECEIVE' ? 'Receive the returned goods?' : confirm === 'POST' ? 'Post the dispositions?' : confirm === 'ACCEPTED' ? 'Accept the return?' : 'Reject the return after inspection?'}
        confirmLabel={confirm === 'RECEIVE' ? 'Receive into quarantine' : confirm === 'POST' ? 'Post and close' : confirm === 'ACCEPTED' ? 'Accept' : 'Reject'}
        description={confirm === 'RECEIVE' ? 'A customer-return posting adds the goods to the quarantine location (same lot as dispatched). They are not available for sale.'
          : confirm === 'POST' ? 'Restocked lines are transferred to sellable storage, scrapped lines to the rejected location and lines returned to the customer are issued. Other dispositions stay in quarantine.'
          : 'The dispositions you selected are saved. Stock moves only when the dispositions are posted.'}
        onConfirm={() => {
          const c = confirm; setConfirm(null)
          if (c === 'RECEIVE') void run(async () => {
            const ls = (lines.data ?? []).map((l) => ({ line_id: l.id, quantity: parseQty(received[l.id] ?? '0') }))
            if (ls.some((x) => x.quantity === null)) throw new Error('Enter received quantities as numbers.')
            const r = await receiveReturn(ret.id, location, ls as { line_id: string; quantity: number }[], null, key)
            return `${formatQty(r.received)} received into quarantine (${r.transaction_numbers.join(', ')}).`
          })
          else if (c === 'POST') void run(async () => { const r = await postReturnDisposition(ret.id, restock || null, scrap || null, null, key); return `${ret.return_number} closed${r.transaction_numbers.length ? ` (${r.transaction_numbers.join(', ')})` : ''}.` })
          else if (c) void run(async () => { await inspectReturn(ret.id, inspection(), c, inspNote.trim() || null); return `Inspection ${c === 'ACCEPTED' ? 'accepted' : 'rejected'}.` })
        }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); onChanged(m) }} />
    </Card>
  )

  function inspection() {
    return (lines.data ?? []).filter((l) => Number(l.quantity_received) > 0).map((l) => ({ line_id: l.id, disposition: disp[l.id] ?? 'PENDING_REVIEW', note: (notes[l.id] ?? '').trim() || null }))
  }
}

export default function ReturnsPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>('OPEN')
  const [refresh, setRefresh] = useState(0)
  const [creating, setCreating] = useState(Boolean(params.get('so')) && has('fulfilment_returns.create'))
  const [message, setMessage] = useState<string | null>(null)
  const returns = useAsync(() => fetchReturns({ status: tab === 'ALL' ? null : tab === 'OPEN' ? 'OPEN' : tab }), [tab, refresh])
  const selectedId = params.get('r') ?? ''
  const selectedList = useAsync(() => (selectedId ? fetchReturns({}).then((all) => all.find((r) => r.id === selectedId) ?? null) : Promise.resolve(null)), [selectedId, refresh])
  const select = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('r', id); n.delete('so'); return n }, { replace: true })

  const columns: DataTableColumn<CustomerReturnListRow>[] = [
    { id: 'number', header: 'Return', cell: (r) => <span className={r.id === selectedId ? 'font-medium text-primary' : 'font-medium'}>{r.return_number}<span className="block text-xs font-normal text-muted-foreground">{formatDate(r.return_date)}</span></span>, searchValue: (r) => r.return_number },
    { id: 'order', header: 'Order / customer', cell: (r) => <span>{r.sales_order_number}<span className="block text-xs text-muted-foreground">{r.customer_name_snapshot}</span></span>, searchValue: (r) => `${r.sales_order_number} ${r.customer_name_snapshot}` },
    { id: 'status', header: 'Status', cell: (r) => <ReturnStatusBadge status={r.status} /> },
    { id: 'reason', header: 'Reason', cell: (r) => RETURN_REASON_LABELS[r.reason_code] },
    { id: 'qty', header: 'Requested / received', align: 'right', cell: (r) => `${formatQty(r.requested)} / ${formatQty(r.received)} ${r.units ?? ''}` },
    { id: 'restocked', header: 'Restocked', align: 'right', cell: (r) => formatQty(r.restocked) },
  ]

  return (
    <>
      <PageHeader actions={has('fulfilment_returns.create') ? <Button onClick={() => setCreating(true)}><Plus /> Record return</Button> : undefined} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <p className="mb-4 rounded-lg border bg-background px-4 py-2.5 text-sm">Requested → authorised → received into quarantine → inspected → dispositions posted. Sellable stock increases only when an accepted line is restocked. No credit notes, refunds or tax adjustments are created (billing is a future module).</p>
      <div className="mb-6">
        <DataTable title="Customer returns" columns={columns} data={returns.data ?? []} getRowId={(r) => r.id} loading={returns.loading} pageSize={10} onRowClick={(r) => { setMessage(null); select(r.id) }}
          error={returns.error ? new Error(describeDataError(returns.error)) : null} onRetry={returns.reload} searchPlaceholder="Search return, order or customer…"
          toolbar={<FilterTabs<Tab> label="Return status" value={tab} onChange={setTab} options={[{ value: 'OPEN', label: 'Open' }, { value: 'CLOSED', label: 'Closed' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'ALL', label: 'All' }]} />}
          emptyState={{ icon: Undo2, title: 'No returns', description: 'Recorded customer returns appear here.' }} />
      </div>
      {selectedList.data && <ReturnPanel key={`${selectedList.data.id}-${selectedList.data.updated_at}`} ret={selectedList.data} onChanged={(m) => { setMessage(m); setRefresh((n) => n + 1) }} />}
      {creating && <NewReturnDialog initialOrderId={params.get('so')} onClose={() => setCreating(false)} onCreated={(id, number) => { setCreating(false); setMessage(`Return ${number} recorded; it now needs authorisation.`); setRefresh((n) => n + 1); select(id) }} />}
    </>
  )
}
