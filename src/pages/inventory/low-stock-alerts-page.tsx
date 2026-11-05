import { BellRing, Check, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AlertBadge } from '@/features/inventory/inventory-badges'
import { ALERT_TYPE_LABELS, formatQty } from '@/features/inventory/inventory-model'
import { ReorderPlanningPanel } from '@/features/inventory/reorder-planning'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { acknowledgeAlert, fetchAlerts, refreshAlerts } from '@/services/inventory'
import { fetchDisplayNames, listCategories } from '@/services/products'
import { requireSupabase } from '@/lib/supabase'
import type { AlertRow } from '@/types/database-inventory'
import { useUrlEnum } from '@/hooks/use-url-state'

type Tab = 'ACTIVE' | 'RESOLVED' | 'ALL'
type View = 'alerts' | 'planning'
type Details = { sku?: string; product_name?: string; unit?: string; on_hand?: number; reserved?: number; available?: number; reorder_level?: number | null
  reorder_level_days?: number | null; lead_time_days?: number | null; coverage_days?: number | null; batch_number?: string; expiry_date?: string; location_code?: string }

/** Threshold text: days of cover (and lead time) when planned in days, else the earlier quantity level. */
function thresholdText(d: Details) {
  if (d.expiry_date) return `Expiry ${d.expiry_date}`
  const parts: string[] = []
  if (d.coverage_days !== null && d.coverage_days !== undefined) parts.push(`${formatQty(d.coverage_days)} days of cover`)
  if (d.reorder_level_days !== null && d.reorder_level_days !== undefined) parts.push(`reorder at ${formatQty(d.reorder_level_days)} days`)
  if (d.lead_time_days !== null && d.lead_time_days !== undefined) parts.push(`lead time ${formatQty(d.lead_time_days)} days`)
  if (d.reorder_level !== null && d.reorder_level !== undefined) parts.push(`reorder qty ${formatQty(d.reorder_level)}`)
  return parts.length ? parts.join(' · ') : '—'
}

export default function LowStockAlertsPage() {
  const [params, setParams] = useSearchParams()
  const view: View = params.get('tab') === 'planning' ? 'planning' : 'alerts'
  return (
    <>
      <PageHeader />
      <div className="mb-4">
        <FilterTabs<View> label="View" value={view} onChange={(v) => setParams(v === 'planning' ? { tab: 'planning' } : {}, { replace: true })}
          options={[{ value: 'alerts', label: 'Stock alerts' }, { value: 'planning', label: 'Reorder planning (days of cover)' }]} />
      </div>
      {view === 'planning' ? <ReorderPlanningPanel initialQuery={params.get('q') ?? undefined} /> : <AlertsView />}
    </>
  )
}

function AlertsView() {
  const { has } = usePermissions()
  const storage = useStorage()
  const categories = useAsync(listCategories, [])
  // Kept in the address, so Back from a record returns to the same tab.
  const [tab, setTab] = useUrlEnum<Tab>('status', ['ACTIVE', 'RESOLVED', 'ALL'], 'ACTIVE')
  const [type, setType] = useState('all')
  const [warehouseId, setWarehouseId] = useState('all')
  const [categoryId, setCategoryId] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const [checking, setChecking] = useState(false)
  const [lastCheck, setLastCheck] = useState<{ opened: number; resolved: number; active: number } | null>(null)
  const [ack, setAck] = useState<AlertRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const alerts = useAsync(() => fetchAlerts(tab), [tab, refresh])
  const names = useAsync(() => fetchDisplayNames((alerts.data ?? []).map((a) => a.acknowledged_by)), [alerts.data])
  const productMeta = useAsync(async () => {
    const ids = [...new Set((alerts.data ?? []).map((a) => a.product_id).filter((x): x is string => Boolean(x)))]
    if (!ids.length) return new Map<string, string | null>()
    const { data, error } = await requireSupabase().from('products').select('id, category_id').in('id', ids)
    if (error) throw error
    return new Map((data ?? []).map((p) => [p.id, p.category_id]))
  }, [alerts.data])

  const check = async () => {
    setChecking(true)
    try {
      setLastCheck(await refreshAlerts())
      setRefresh((n) => n + 1)
    } catch (e) {
      setNotice({ tone: 'error', text: describeDataError(e) })
    } finally {
      setChecking(false)
    }
  }

  // Re-evaluate conditions on open. Idempotent: no duplicate alerts are created.
  useEffect(() => {
    void Promise.resolve().then(check)
    // Run once on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = (alerts.data ?? []).filter(
    (a) =>
      (type === 'all' || a.alert_type === type) &&
      (warehouseId === 'all' || a.warehouse_id === warehouseId || (!a.warehouse_id && warehouseId === 'all')) &&
      (categoryId === 'all' || (a.product_id && productMeta.data?.get(a.product_id) === categoryId)),
  )
  const d = (a: AlertRow) => a.details as Details

  const columns: DataTableColumn<AlertRow>[] = [
    { id: 'type', header: 'Alert', cell: (a) => <AlertBadge type={a.alert_type} severity={a.severity} />, searchValue: (a) => ALERT_TYPE_LABELS[a.alert_type], sortValue: (a) => (a.severity === 'CRITICAL' ? 0 : 1) },
    { id: 'product', header: 'Product', cell: (a) => <span><span className="font-medium">{d(a).sku}</span> {d(a).product_name}</span>, searchValue: (a) => `${d(a).sku} ${d(a).product_name}`, sortValue: (a) => d(a).sku ?? '' },
    { id: 'where', header: 'Where', cell: (a) => (a.location_id ? `${storage.locationLabel(a.location_id)}${d(a).batch_number ? ` · batch ${d(a).batch_number}` : ''}` : 'All locations') },
    { id: 'oh', header: 'On hand', align: 'right', cell: (a) => formatQty(d(a).on_hand, d(a).unit), sortValue: (a) => d(a).on_hand ?? null },
    { id: 'res', header: 'Reserved', align: 'right', cell: (a) => (d(a).reserved === undefined ? '—' : formatQty(d(a).reserved)) },
    { id: 'av', header: 'Available', align: 'right', cell: (a) => (d(a).available === undefined ? '—' : <span className="font-medium">{formatQty(d(a).available)}</span>) },
    { id: 'reorder', header: 'Reorder / expiry', className: 'whitespace-normal text-xs', cell: (a) => thresholdText(d(a)) },
    { id: 'seen', header: 'Detected', cell: (a) => <span className="text-xs">{formatDateTime(a.first_detected_at)}<span className="block text-muted-foreground">last seen {formatDateTime(a.last_detected_at)}</span></span>, sortValue: (a) => a.first_detected_at },
    {
      id: 'status',
      header: 'Status',
      cell: (a) =>
        a.status === 'OPEN' ? <StatusBadge label="Open" tone="danger" /> : a.status === 'ACKNOWLEDGED' ? (
          <span className="text-xs"><StatusBadge label="Acknowledged" tone="warning" /><span className="block text-muted-foreground">{names.data?.get(a.acknowledged_by ?? '') ?? '…'}{a.acknowledgement_note ? ` · ${a.acknowledgement_note}` : ''}</span></span>
        ) : <span className="text-xs"><StatusBadge label="Resolved" tone="success" /><span className="block text-muted-foreground">{a.resolved_at ? formatDateTime(a.resolved_at) : ''}</span></span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (a) => (a.status === 'OPEN' && has('inventory_alerts.acknowledge') ? <Button size="sm" variant="outline" onClick={() => setAck(a)}><Check /> Acknowledge</Button> : null),
    },
  ]

  return (
    <>
      <div className="mb-2 flex justify-end">
        <Button variant="outline" onClick={() => void check()} disabled={checking}>{checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-check now</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Alerts are evaluated from live balances. Each condition has at most one active alert; it resolves automatically when the condition clears and history is kept.
        {lastCheck && ` Last check: ${lastCheck.opened} new, ${lastCheck.resolved} resolved, ${lastCheck.active} active.`} Email / WhatsApp notifications are not configured.
      </p>
      {notice && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{notice.text}</p>}
      <DataTable
        title="Inventory alerts"
        columns={columns}
        data={rows}
        getRowId={(a) => a.id}
        loading={alerts.loading}
        error={alerts.error ? new Error(describeDataError(alerts.error)) : null}
        onRetry={alerts.reload}
        pageSize={25}
        searchPlaceholder="Search product…"
        toolbar={
          <>
            <FilterTabs<Tab> label="Status" value={tab} onChange={setTab} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'RESOLVED', label: 'Resolved' }, { value: 'ALL', label: 'History' }]} />
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-48" aria-label="Alert type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All alert types</SelectItem>{Object.entries(ALERT_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger className="w-40" aria-label="Warehouse"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All warehouses</SelectItem>{storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-44" aria-label="Category"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All categories</SelectItem>{(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </>
        }
        emptyState={{ icon: BellRing, title: tab === 'ACTIVE' ? 'No active alerts' : 'No alerts', description: 'Alerts appear when available stock is at or below the reorder level, runs out, a batch is expired or expiring, or stock needs source review.' }}
      />
      <p className="mt-2 text-xs text-muted-foreground">Low-stock alerts compare company-wide available stock with the product's Reorder Level (Days) as days of cover, or with an earlier reorder quantity where one is still set. Warehouse filtering applies to batch and location alerts.</p>
      {ack && <AckDialog alert={ack} onClose={() => setAck(null)} onDone={() => { setAck(null); setNotice(null); setRefresh((n) => n + 1) }} />}
    </>
  )
}

function AckDialog({ alert, onClose, onDone }: { alert: AlertRow; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Acknowledge alert</DialogTitle>
          <DialogDescription>Records who has seen it and what is being done. The alert stays active until the condition clears.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1.5"><Label htmlFor="ack-note">Note (e.g. "Reorder placed")</Label><Textarea id="ack-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            setError(null)
            try { await acknowledgeAlert(alert.id, note.trim() || null); onDone() } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Acknowledge</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
