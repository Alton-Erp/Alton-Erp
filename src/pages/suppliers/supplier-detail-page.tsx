import { ClipboardList, Info, PackageCheck, Pencil, Power, PowerOff } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'

import { DataTable } from '@/components/common/data-table'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { PoStatusBadge } from '@/features/purchasing/po-components'
import { formatDate } from '@/lib/format'
import { fetchGoodsReceipts, fetchPurchaseOrders } from '@/services/purchasing'

import { usePermissions } from '@/auth/use-permissions'
import { useAuth } from '@/auth/use-auth'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useGstStates } from '@/features/billing/use-gst-states'
import { SupplierFormDialog } from '@/features/suppliers/supplier-form-dialog'
import { paymentTermsLabel, SUPPLIER_CATEGORY_LABELS, SUPPLIER_PO_MODULE_AVAILABLE, supplierName } from '@/features/suppliers/supplier-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import { fetchSupplierActivity, getSupplier, setSupplierStatus } from '@/services/suppliers'
import type { SupplierRow } from '@/types/database-suppliers'

/*
 * Purchase orders and goods receipts come from the purchasing tables. There is
 * no Outstanding Balances tab: supplier invoices and payments are not recorded,
 * so a payable balance cannot be shown from real records.
 */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'contact', label: 'Contact and Addresses' },
  { id: 'purchase-orders', label: 'Purchase Orders' },
  { id: 'receipts', label: 'Goods Receipts' },
  { id: 'activity', label: 'Activity History' },
] as const
type TabId = (typeof TABS)[number]['id']

const ACTION_LABELS: Record<string, string> = {
  'supplier.created': 'Supplier created',
  'supplier.updated': 'Details edited',
  'supplier.activated': 'Activated',
  'supplier.deactivated': 'Deactivated',
}

const FIELD_LABELS: Record<string, string> = {
  legal_name: 'legal name', display_name: 'display name', category: 'category', contact_person: 'contact person', phone: 'primary phone',
  alternate_phone: 'alternate phone', email: 'e-mail', gstin: 'GSTIN', pan: 'PAN', billing_address: 'billing address',
  shipping_address: 'dispatch address', city: 'city', state_code: 'state', pin_code: 'PIN code', country: 'country',
  payment_terms: 'payment terms', custom_payment_days: 'custom payment days', notes: 'notes', status: 'status',
}

export default function SupplierDetailPage() {
  const { supplierId = '' } = useParams()
  const location = useLocation()
  const { access } = useAuth()
  const { has } = usePermissions()
  const canManage = has('suppliers.manage')
  const timezone = access?.company?.timezone
  const [params, setParams] = useSearchParams()
  const tab: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'overview'
  const [refresh, setRefresh] = useState(0)
  const { data: supplier, loading, error, reload } = useAsync(() => getSupplier(supplierId), [supplierId, refresh])
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    (location.state as { message?: string } | null)?.message ? { tone: 'success', text: (location.state as { message: string }).message } : null,
  )
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const crumbs = (last: string) => [{ label: 'Master Data' }, { label: 'Suppliers', to: '/suppliers' }, { label: last }]

  if (loading && !supplier) return <LoadingState label="Loading supplier…" />
  if (error || !supplier) {
    return (
      <>
        <PageHeader title="Supplier" breadcrumbs={crumbs('Supplier')} />
        <Card><ErrorState message={describeDataError(error)} onRetry={reload} /></Card>
      </>
    )
  }

  const s = supplier
  const active = s.status === 'ACTIVE'
  const selectTab = (id: TabId) => setParams((p) => { const n = new URLSearchParams(p); if (id === 'overview') n.delete('tab'); else n.set('tab', id); return n }, { replace: true })
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null
    if (next === null) return
    e.preventDefault()
    const i = (next + TABS.length) % TABS.length
    selectTab(TABS[i].id)
    tabRefs.current[i]?.focus()
  }

  return (
    <>
      <PageHeader
        title={supplierName(s)}
        description={`${s.supplier_code} · ${SUPPLIER_CATEGORY_LABELS[s.category]}${s.display_name ? ` · ${s.legal_name}` : ''}`}
        breadcrumbs={crumbs(s.supplier_code)}
        actions={canManage ? (
          <>
            <Button variant="outline" onClick={() => setConfirm(true)}>{active ? <><PowerOff /> Deactivate</> : <><Power /> Activate</>}</Button>
            <Button onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          </>
        ) : undefined}
      />

      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn('mb-4 rounded-lg border px-4 py-2.5 text-sm', notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800')}>
          {notice.text}
        </div>
      )}
      {!active && (
        <p className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> This supplier is inactive and cannot be selected for new purchase orders. Existing records are unaffected.
        </p>
      )}

      <div role="tablist" aria-label="Supplier details" className="mb-5 flex max-w-full gap-1 overflow-x-auto overflow-y-hidden border-b">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[i] = el }}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => selectTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="outline-none">
        {tab === 'overview' && <Overview s={s} timezone={timezone} />}
        {tab === 'contact' && <ContactTab s={s} />}
        {tab === 'purchase-orders' && <PurchaseOrdersTab supplierId={s.id} />}
        {tab === 'receipts' && <ReceiptsTab supplierId={s.id} />}
        {tab === 'activity' && <ActivityTab supplierId={s.id} timezone={timezone} refresh={refresh} />}
      </div>

      {editing && (
        <SupplierFormDialog
          supplier={s}
          companyId={s.company_id}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setNotice({ tone: 'success', text: `Supplier ${s.supplier_code} updated.` }); setRefresh((n) => n + 1) }}
        />
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={active ? `Deactivate ${s.supplier_code}?` : `Activate ${s.supplier_code}?`}
        description={active
          ? 'The supplier will no longer be selectable for new purchase orders. Existing records keep their reference, and you can activate it again later.'
          : 'The supplier can be selected for new purchase orders again.'}
        confirmLabel={active ? 'Deactivate' : 'Activate'}
        destructive={active}
        onConfirm={async () => {
          setNotice(null)
          try {
            await setSupplierStatus(s.id, active ? 'INACTIVE' : 'ACTIVE')
            setNotice({ tone: 'success', text: `Supplier ${s.supplier_code} ${active ? 'deactivated' : 'activated'}.` })
            setRefresh((n) => n + 1)
          } catch (e) {
            setNotice({ tone: 'error', text: describeDataError(e) })
          }
        }}
      />
    </>
  )
}

function Overview({ s, timezone }: { s: SupplierRow; timezone?: string }) {
  const { label } = useGstStates()
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <InfoCard title="Supplier">
          <Item label="Supplier code">{s.supplier_code}</Item>
          <Item label="Status"><StatusBadge label={s.status === 'ACTIVE' ? 'Active' : 'Inactive'} tone={s.status === 'ACTIVE' ? 'success' : 'neutral'} /></Item>
          <Item label="Legal business name" full>{s.legal_name}</Item>
          <Item label="Display name">{s.display_name}</Item>
          <Item label="Category">{SUPPLIER_CATEGORY_LABELS[s.category]}</Item>
        </InfoCard>
        <InfoCard title="Tax and terms">
          <Item label="GSTIN">{s.gstin && <span className="font-mono">{s.gstin}</span>}</Item>
          <Item label="PAN">{s.pan && <span className="font-mono">{s.pan}</span>}</Item>
          <Item label="State">{s.state_code ? label(s.state_code) : null}</Item>
          <Item label="Payment terms">{paymentTermsLabel(s.payment_terms, s.custom_payment_days)}</Item>
        </InfoCard>
        <InfoCard title="Notes">
          <Item label="Notes" full>{s.notes && <span className="whitespace-pre-line">{s.notes}</span>}</Item>
        </InfoCard>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Purchasing summary</CardTitle>
              <CardDescription>From recorded purchase documents only.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {SUPPLIER_PO_MODULE_AVAILABLE ? <PurchasingSummary supplierId={s.id} /> : null}
            <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Supplier invoices and payments are not recorded in the ERP, so no payable balance is shown.
            </p>
          </CardContent>
        </Card>
        <InfoCard title="Record">
          <Item label="Created" full>{formatDateTime(s.created_at, timezone)}</Item>
          <Item label="Last updated" full>{formatDateTime(s.updated_at, timezone)}</Item>
        </InfoCard>
      </div>
    </div>
  )
}

function ContactTab({ s }: { s: SupplierRow }) {
  const { label } = useGstStates()
  const place = [s.city, s.state_code ? label(s.state_code).split(' — ')[1] : null, s.pin_code, s.country].filter(Boolean).join(', ')
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <InfoCard title="Contact">
        <Item label="Contact person" full>{s.contact_person}</Item>
        <Item label="Primary phone">{s.phone && <a className="hover:underline" href={`tel:${s.phone.replace(/\s/g, '')}`}>{s.phone}</a>}</Item>
        <Item label="Alternate phone">{s.alternate_phone && <a className="hover:underline" href={`tel:${s.alternate_phone.replace(/\s/g, '')}`}>{s.alternate_phone}</a>}</Item>
        <Item label="E-mail" full>{s.email && <a className="hover:underline" href={`mailto:${s.email}`}>{s.email}</a>}</Item>
      </InfoCard>
      <InfoCard title="Addresses">
        <Item label="Billing address" full>{s.billing_address && <span className="whitespace-pre-line">{s.billing_address}</span>}</Item>
        <Item label="Shipping / dispatch address" full>
          {s.shipping_address ? <span className="whitespace-pre-line">{s.shipping_address}</span> : s.billing_address ? <span className="text-muted-foreground">Same as billing address</span> : null}
        </Item>
        <Item label="City, state, PIN, country" full>{place}</Item>
      </InfoCard>
    </div>
  )
}

const OPEN = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']
const COMMITTED = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']

function NoPurchaseAccess() {
  return <p className="text-sm text-muted-foreground">Purchase order figures need purchase order access (purchases.read).</p>
}

function PurchasingSummary({ supplierId }: { supplierId: string }) {
  const { has } = usePermissions()
  const pos = useAsync(() => (has('purchases.read') ? fetchPurchaseOrders({ supplierId }) : Promise.resolve(null)), [supplierId])
  if (!has('purchases.read')) return <NoPurchaseAccess />
  if (pos.loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (pos.error || !pos.data) return <p className="text-sm text-red-700">{describeDataError(pos.error)}</p>
  const committed = pos.data.filter((o) => COMMITTED.includes(o.status))
  const open = pos.data.filter((o) => OPEN.includes(o.status))
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-xs text-muted-foreground">Purchase orders</dt><dd className="font-medium">{pos.data.length}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Open orders</dt><dd className="font-medium">{open.length}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Approved order value</dt><dd className="font-medium tabular-nums">{money(committed.reduce((s, o) => s + Number(o.grand_total), 0))}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Still to be received</dt><dd className="font-medium tabular-nums">{money(open.reduce((s, o) => s + Number(o.pending_value), 0))}</dd></div>
    </dl>
  )
}

function PurchaseOrdersTab({ supplierId }: { supplierId: string }) {
  const { has } = usePermissions()
  const pos = useAsync(() => (has('purchases.read') ? fetchPurchaseOrders({ supplierId }) : Promise.resolve([])), [supplierId])
  if (!has('purchases.read')) return <Card className="p-6"><NoPurchaseAccess /></Card>
  return (
    <DataTable
      title="Purchase orders"
      columns={[
        { id: 'po', header: 'PO No.', sortValue: (o) => o.po_number, searchValue: (o) => o.po_number, cell: (o) => <Link className="font-medium hover:underline" to={`/purchase-orders/${o.id}`}>{o.po_number}</Link> },
        { id: 'date', header: 'PO date', sortValue: (o) => o.po_date, cell: (o) => formatDate(o.po_date) },
        { id: 'exp', header: 'Expected', cell: (o) => (o.expected_delivery_date ? formatDate(o.expected_delivery_date) : '—') },
        { id: 'qty', header: 'Ordered / accepted / pending', align: 'right', cell: (o) => <span className="tabular-nums">{formatQty(o.total_ordered_quantity)} / {formatQty(o.total_accepted_quantity)} / {formatQty(o.total_pending_quantity)}</span> },
        { id: 'total', header: 'Order total', align: 'right', sortValue: (o) => Number(o.grand_total), cell: (o) => <span className="tabular-nums">{money(o.grand_total)}</span> },
        { id: 'status', header: 'Status', cell: (o) => <PoStatusBadge status={o.status} /> },
      ]}
      data={pos.data ?? []}
      getRowId={(o) => o.id}
      loading={pos.loading}
      error={pos.error ? new Error(describeDataError(pos.error)) : null}
      onRetry={pos.reload}
      pageSize={10}
      searchPlaceholder="Search PO number…"
      emptyState={{ icon: ClipboardList, title: 'No purchase orders', description: 'No purchase orders have been raised with this supplier yet.' }}
    />
  )
}

function ReceiptsTab({ supplierId }: { supplierId: string }) {
  const { has } = usePermissions()
  const grs = useAsync(() => (has('purchases.read') ? fetchGoodsReceipts({ supplierId }) : Promise.resolve([])), [supplierId])
  if (!has('purchases.read')) return <Card className="p-6"><NoPurchaseAccess /></Card>
  return (
    <DataTable
      title="Goods receipts"
      columns={[
        { id: 'gr', header: 'Receipt', sortValue: (r) => r.receipt_number, searchValue: (r) => `${r.receipt_number} ${r.po_number} ${r.supplier_document_number ?? ''}`, cell: (r) => <span className="font-medium">{r.receipt_number}</span> },
        { id: 'date', header: 'Date', sortValue: (r) => r.receipt_date, cell: (r) => formatDate(r.receipt_date) },
        { id: 'po', header: 'PO', cell: (r) => <Link className="hover:underline" to={`/purchase-orders/${r.purchase_order_id}`}>{r.po_number}</Link> },
        { id: 'doc', header: 'Challan / invoice', cell: (r) => r.supplier_document_number ?? '—' },
        { id: 'qty', header: 'Received / accepted / rejected', align: 'right', cell: (r) => <span className="tabular-nums">{formatQty(r.total_received)} / {formatQty(r.total_accepted)} / {formatQty(r.total_rejected)}</span> },
        { id: 'status', header: 'Status', cell: (r) => <StatusBadge label={r.status === 'POSTED' ? 'Posted' : 'Reversed'} tone={r.status === 'POSTED' ? 'success' : 'neutral'} /> },
      ]}
      data={grs.data ?? []}
      getRowId={(r) => r.id}
      loading={grs.loading}
      error={grs.error ? new Error(describeDataError(grs.error)) : null}
      onRetry={grs.reload}
      pageSize={10}
      searchPlaceholder="Search receipt, PO or challan…"
      emptyState={{ icon: PackageCheck, title: 'No goods received', description: 'Goods received from this supplier against purchase orders will be listed here.' }}
    />
  )
}

function ActivityTab({ supplierId, timezone, refresh }: { supplierId: string; timezone?: string; refresh: number }) {
  const { data, loading, error, reload } = useAsync(() => fetchSupplierActivity(supplierId), [supplierId, refresh])
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity history</CardTitle>
          <CardDescription>Every change to this supplier, from the audit log.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingState label="Loading activity…" />
        ) : error ? (
          <ErrorState message={describeDataError(error)} onRetry={reload} compact />
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No recorded activity.</p>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {(data ?? []).map((e) => (
              <li key={e.id} className="relative text-sm">
                <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-gray-400" />
                <p className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(e.event_timestamp, timezone)} · {e.actor_name ?? 'System'}</p>
                {e.metadata?.changed_fields && e.metadata.changed_fields.filter((f) => f !== 'status').length > 0 && (
                  <p className="text-xs text-muted-foreground">Changed: {e.metadata.changed_fields.filter((f) => f !== 'status').map((f) => FIELD_LABELS[f] ?? f.replace(/_/g, ' ')).join(', ')}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

function InfoCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent><dl className="grid gap-4 sm:grid-cols-2">{children}</dl></CardContent>
    </Card>
  )
}

function Item({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm break-words text-foreground">{empty ? <span className="text-muted-foreground">Not set</span> : children}</dd>
    </div>
  )
}
