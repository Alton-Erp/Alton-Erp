import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SHORTAGE_EXPORT } from '@/features/customer-po/export-columns'
import { ExportMenu } from '@/features/customer-po/po-export'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { fetchAssignableUsers, fetchCustomerOptions, fetchShortageNotes, fetchShortages, updateShortage, type ShortageRow } from '@/services/customer-po'
import type { DateRangeValue } from '@/types'

const PRIORITY_TONE = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' } as const
const STATUS_TONE = { OPEN: 'danger', IN_PROGRESS: 'warning', RESOLVED: 'success' } as const

function FollowUpDialog({ row, users, onClose, onSaved }: { row: ShortageRow; users: { user_id: string; display_name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<string>(row.shortage_status)
  const [priority, setPriority] = useState<string>(row.priority)
  const [owner, setOwner] = useState(row.owner ?? 'none')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notes = useAsync(() => fetchShortageNotes(row.line_id), [row.line_id])
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Shortage follow-up — {row.customer_po_number} line {row.line_no}</DialogTitle>
          <DialogDescription>{row.sku} short by {formatQty(row.shortage, row.unit)}. Suggested actions are recommendations only; nothing is ordered or produced automatically.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1"><Label htmlFor="sf-status">Status</Label>
            <Select value={status} onValueChange={setStatus}><SelectTrigger id="sf-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="OPEN">Open</SelectItem><SelectItem value="IN_PROGRESS">In progress</SelectItem><SelectItem value="RESOLVED">Resolved</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="sf-priority">Priority</Label>
            <Select value={priority} onValueChange={setPriority}><SelectTrigger id="sf-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => <SelectItem key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="sf-owner">Responsible</Label>
            <Select value={owner} onValueChange={setOwner}><SelectTrigger id="sf-owner"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Unassigned</SelectItem>{users.map((u) => <SelectItem key={u.user_id} value={u.user_id}>{u.display_name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1 sm:col-span-3"><Label htmlFor="sf-note">Resolution note</Label><Textarea id="sf-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        {(notes.data ?? []).length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto border-t pt-2 text-xs">
            {(notes.data ?? []).map((n) => <li key={n.id}><span className="text-muted-foreground">{formatDateTime(n.created_at)}:</span> {n.note}</li>)}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try { await updateShortage(row.line_id, status, priority, owner === 'none' ? null : owner, note.trim() || null); onSaved() } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PoShortagesPage() {
  const { has } = usePermissions()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_year'))
  const [customer, setCustomer] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const [editing, setEditing] = useState<ShortageRow | null>(null)
  const customers = useAsync(fetchCustomerOptions, [])
  const users = useAsync(() => (has('customer_po.update') ? fetchAssignableUsers() : Promise.resolve([])), [])
  const rows = useAsync(() => fetchShortages({ from: toIsoDate(range.from), to: toIsoDate(range.to), customerKey: customer === 'all' ? null : customer }), [range, customer, refresh])
  const [calculatedAt, setCalculatedAt] = useState(() => new Date().toISOString())
  const userName = (id: string | null) => (id ? users.data?.find((u) => u.user_id === id)?.display_name ?? 'Assigned' : '—')

  const columns: DataTableColumn<ShortageRow>[] = [
    { id: 'customer', header: 'Customer', cell: (s) => s.customer_name, searchValue: (s) => s.customer_name, sortValue: (s) => s.customer_name },
    { id: 'po', header: 'PO number', cell: (s) => <Link className="font-medium text-primary hover:underline" to={`/customer-pos/${s.po_id}`}>{s.customer_po_number}</Link>, searchValue: (s) => s.customer_po_number },
    { id: 'dates', header: 'PO date / delivery', cell: (s) => <span className="text-xs">{formatDate(s.po_date)}<span className="block">{s.required_delivery_date ? formatDate(s.required_delivery_date) : '—'}</span></span>, sortValue: (s) => s.required_delivery_date ?? '9999' },
    { id: 'product', header: 'Product', cell: (s) => <span>{s.sku}<span className="block text-xs text-muted-foreground">{s.product_name}</span></span>, searchValue: (s) => `${s.sku} ${s.product_name}` },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (s) => formatQty(s.quantity_ordered, s.unit) },
    { id: 'allocated', header: 'Allocated', align: 'right', cell: (s) => formatQty(Number(s.allocated) + Number(s.quantity_dispatched)) },
    { id: 'available', header: 'Available now', align: 'right', cell: (s) => formatQty(s.available) },
    { id: 'shortage', header: 'Shortage', align: 'right', cell: (s) => <span className="font-medium text-shortage">{formatQty(s.shortage)}</span>, sortValue: (s) => Number(s.shortage) },
    { id: 'split', header: 'In-house / outsourced avail.', align: 'right', cell: (s) => <span className="text-xs"><span className="text-blue-700">{formatQty(s.in_house_available)}</span> / <span className="text-violet-700">{formatQty(s.outsourced_available)}</span></span> },
    { id: 'wh', header: 'Warehouse', cell: (s) => s.warehouse_code ?? 'Any' },
    { id: 'actions', header: 'Suggested action', cell: (s) => <ul className="max-w-xs list-disc pl-4 text-xs">{s.suggested_actions.map((a) => <li key={a}>{a}</li>)}</ul> },
    { id: 'priority', header: 'Priority', cell: (s) => <StatusBadge label={s.priority[0] + s.priority.slice(1).toLowerCase()} tone={PRIORITY_TONE[s.priority]} />, sortValue: (s) => ['LOW', 'NORMAL', 'HIGH', 'URGENT'].indexOf(s.priority) },
    { id: 'status', header: 'Status', cell: (s) => <span className="inline-flex flex-col gap-1"><StatusBadge label={s.shortage_status.replace('_', ' ').toLowerCase()} tone={STATUS_TONE[s.shortage_status]} /><span className="text-xs text-muted-foreground">{userName(s.owner)}</span>{s.last_note && <span className="max-w-[12rem] truncate text-xs" title={s.last_note}>{s.last_note}</span>}</span> },
    { id: 'edit', header: '', cell: (s) => (has('customer_po.update') ? <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>Follow up</Button> : null) },
  ]

  return (
    <>
      <PageHeader actions={<ExportMenu title="PO shortages" fileStem="po-shortage-report" columns={SHORTAGE_EXPORT} rows={rows.data ?? []} />} />
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="sh-customer">Customer</Label>
            <Select value={customer} onValueChange={setCustomer}><SelectTrigger id="sh-customer" className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All customers</SelectItem>{(customers.data ?? []).map((c) => <SelectItem key={c.customer_key} value={c.customer_key}>{c.customer_name}</SelectItem>)}</SelectContent></Select></div>
          <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
          <Button variant="outline" onClick={() => { setRefresh((n) => n + 1); setCalculatedAt(new Date().toISOString()) }}><RefreshCw className={rows.loading ? 'animate-spin' : undefined} /> Refresh from current stock</Button>
          <span className="text-xs text-muted-foreground">Calculated {formatDateTime(calculatedAt)} from live balances. Save a snapshot on Stock Availability Analysis to keep a dated result.</span>
        </CardContent>
      </Card>
      <DataTable
        title="Open shortages"
        description="Lines of open, current POs whose ordered quantity is not covered by allocated or dispatched stock (filtered by PO date)."
        columns={columns}
        data={rows.data ?? []}
        getRowId={(s) => s.line_id}
        loading={rows.loading}
        error={rows.error ? new Error(describeDataError(rows.error)) : null}
        onRetry={rows.reload}
        pageSize={25}
        searchPlaceholder="Search customer, PO or product…"
        emptyState={{ icon: AlertTriangle, title: 'No shortages', description: 'Every open PO line is covered by allocated or dispatched stock.' }}
      />
      {editing && <FollowUpDialog row={editing} users={users.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setRefresh((n) => n + 1) }} />}
    </>
  )
}
