import { Building2, CircleCheck, CircleOff, Eye, FileClock, Pencil, Plus, Power, PowerOff, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGstStates } from '@/features/billing/use-gst-states'
import { SupplierFormDialog } from '@/features/suppliers/supplier-form-dialog'
import { paymentTermsLabel, SUPPLIER_CATEGORY_LABELS, SUPPLIER_PO_MODULE_AVAILABLE, supplierName } from '@/features/suppliers/supplier-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatNumber } from '@/lib/format'
import { money } from '@/features/billing/billing-model'
import { fetchPurchaseOrders } from '@/services/purchasing'
import { fetchSuppliers, setSupplierStatus } from '@/services/suppliers'
import type { SupplierCategory, SupplierRow } from '@/types/database-suppliers'

type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL'

/**
 * Supplier master: raw material, packaging, machinery and service suppliers
 * and outsourced manufacturing partners. Records are company-scoped (RLS) and
 * never deleted; deactivated suppliers stay on record for existing documents.
 */
export default function SuppliersPage() {
  const { access } = useAuth()
  const { has } = usePermissions()
  const navigate = useNavigate()
  const canManage = has('suppliers.manage')
  const { label: stateLabel } = useGstStates()

  const suppliers = useAsync(fetchSuppliers, [])
  const canSeePos = has('purchases.read')
  // Open PO value per supplier (pending receipt value of approved / sent / partially received orders).
  const openPos = useAsync(async () => {
    if (!canSeePos) return null
    const map = new Map<string, number>()
    for (const o of await fetchPurchaseOrders()) {
      if (['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(o.status)) map.set(o.supplier_id, (map.get(o.supplier_id) ?? 0) + Number(o.pending_value))
    }
    return map
  }, [canSeePos])
  const [status, setStatus] = useState<StatusFilter>('ACTIVE')
  const [state, setState] = useState<string>('all')
  const [category, setCategory] = useState<SupplierCategory | 'all'>('all')
  const [editing, setEditing] = useState<SupplierRow | 'new' | null>(null)
  const [toggle, setToggle] = useState<SupplierRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const all = useMemo(() => suppliers.data ?? [], [suppliers.data])
  const counts = useMemo(() => ({
    total: all.length,
    active: all.filter((s) => s.status === 'ACTIVE').length,
    inactive: all.filter((s) => s.status === 'INACTIVE').length,
  }), [all])
  const stateOptions = useMemo(() => [...new Set(all.map((s) => s.state_code).filter((c): c is string => Boolean(c)))].sort(), [all])
  const rows = all.filter((s) => (status === 'ALL' || s.status === status) && (state === 'all' || (state === 'none' ? !s.state_code : s.state_code === state))
    && (category === 'all' || s.category === category))
  const filtersActive = state !== 'all' || category !== 'all'

  const columns: DataTableColumn<SupplierRow>[] = [
    { id: 'code', header: 'Code', cell: (s) => <span className="font-medium whitespace-nowrap">{s.supplier_code}</span>, searchValue: (s) => s.supplier_code, sortValue: (s) => s.supplier_code },
    {
      id: 'name', header: 'Supplier', className: 'min-w-52 whitespace-normal',
      cell: (s) => (
        <div>
          <Link to={`/suppliers/${s.id}`} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>{supplierName(s)}</Link>
          <p className="text-xs text-muted-foreground">{s.display_name ? `${s.legal_name} · ` : ''}{SUPPLIER_CATEGORY_LABELS[s.category]}</p>
        </div>
      ),
      searchValue: (s) => `${s.legal_name} ${s.display_name ?? ''} ${s.city ?? ''}`, sortValue: (s) => supplierName(s).toLowerCase(),
    },
    { id: 'contact', header: 'Contact person', cell: (s) => s.contact_person ?? '—', searchValue: (s) => s.contact_person ?? '', sortValue: (s) => s.contact_person?.toLowerCase() ?? null },
    { id: 'phone', header: 'Phone', cell: (s) => (s.phone ? <a href={`tel:${s.phone.replace(/\s/g, '')}`} className="whitespace-nowrap hover:underline" onClick={(e) => e.stopPropagation()}>{s.phone}</a> : '—'), searchValue: (s) => `${s.phone ?? ''} ${s.alternate_phone ?? ''}` },
    { id: 'email', header: 'E-mail', cell: (s) => (s.email ? <a href={`mailto:${s.email}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{s.email}</a> : '—'), searchValue: (s) => s.email ?? '' },
    { id: 'gstin', header: 'GSTIN', cell: (s) => <span className="font-mono text-xs">{s.gstin ?? <span className="font-sans text-muted-foreground">Not registered</span>}</span>, searchValue: (s) => `${s.gstin ?? ''} ${s.pan ?? ''}`, sortValue: (s) => s.gstin },
    { id: 'state', header: 'State', cell: (s) => (s.state_code ? stateLabel(s.state_code).split(' — ')[1] ?? s.state_code : (s.country !== 'India' ? s.country : '—')), searchValue: (s) => `${s.state_code ? stateLabel(s.state_code) : ''} ${s.country}`, sortValue: (s) => s.state_code ?? s.country },
    { id: 'terms', header: 'Payment terms', cell: (s) => <span className="whitespace-nowrap">{paymentTermsLabel(s.payment_terms, s.custom_payment_days)}</span>, sortValue: (s) => (s.payment_terms === 'IMMEDIATE' ? 0 : s.payment_terms === 'CUSTOM' ? (s.custom_payment_days ?? 0) : Number(s.payment_terms.slice(5))) },
    ...(canSeePos ? [{ id: 'open_po', header: 'Open PO value', align: 'right' as const, sortValue: (s: SupplierRow) => openPos.data?.get(s.id) ?? 0,
      cell: (s: SupplierRow) => (openPos.data?.get(s.id) ? <span className="tabular-nums">{money(openPos.data.get(s.id)!)}</span> : <span className="text-muted-foreground">—</span>) }] : []),
    { id: 'status', header: 'Status', cell: (s) => <StatusBadge label={s.status === 'ACTIVE' ? 'Active' : 'Inactive'} tone={s.status === 'ACTIVE' ? 'success' : 'neutral'} />, sortValue: (s) => s.status },
    {
      id: 'actions', header: 'Actions', align: 'right',
      cell: (s) => (
        <span className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button asChild variant="ghost" size="icon-sm" aria-label={`View ${s.supplier_code}`} title="View"><Link to={`/suppliers/${s.id}`}><Eye /></Link></Button>
          {canManage && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.supplier_code}`} title="Edit" onClick={() => setEditing(s)}><Pencil /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={s.status === 'ACTIVE' ? `Deactivate ${s.supplier_code}` : `Activate ${s.supplier_code}`}
                title={s.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onClick={() => setToggle(s)}>
                {s.status === 'ACTIVE' ? <PowerOff /> : <Power />}
              </Button>
            </>
          )}
        </span>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        description="Raw material, packaging, machinery and service suppliers and outsourced manufacturing partners. Suppliers are never deleted: deactivate them to stop new use."
        actions={canManage ? <Button onClick={() => setEditing('new')}><Plus /> Add Supplier</Button> : undefined}
      />

      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss message" className="rounded p-0.5 opacity-70 hover:opacity-100" onClick={() => setNotice(null)}><X className="size-4" /></button>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total suppliers" value={suppliers.loading || suppliers.error ? null : formatNumber(counts.total)} icon={Building2} />
        <KpiCard label="Active" value={suppliers.loading || suppliers.error ? null : formatNumber(counts.active)} icon={CircleCheck} accent="available" hint="Selectable for new purchase orders" />
        <KpiCard label="Inactive" value={suppliers.loading || suppliers.error ? null : formatNumber(counts.inactive)} icon={CircleOff} hint="Kept for history; not selectable" />
        <KpiCard label="With open PO balances" value={!canSeePos || openPos.loading || openPos.error || !openPos.data ? null : formatNumber([...openPos.data.values()].filter((v) => v > 0).length)}
          icon={FileClock} accent="pending" hint={canSeePos ? 'Suppliers with goods still to be received on approved orders' : 'requires purchase order access'} />
      </div>

      <DataTable
        title="Suppliers"
        description={SUPPLIER_PO_MODULE_AVAILABLE ? 'Open PO value = goods still to be received on approved orders (incl. GST). Supplier invoices and payments are not recorded, so payable balances are not shown.' : undefined}
        columns={columns}
        data={rows}
        getRowId={(s) => s.id}
        onRowClick={(s) => navigate(`/suppliers/${s.id}`)}
        loading={suppliers.loading}
        error={suppliers.error ? new Error(describeDataError(suppliers.error)) : null}
        onRetry={suppliers.reload}
        pageSize={25}
        searchPlaceholder="Search code, name, phone, GSTIN…"
        toolbar={
          <>
            <FilterTabs<StatusFilter> label="Supplier status" value={status} onChange={setStatus}
              options={[{ value: 'ACTIVE', label: 'Active', count: counts.active }, { value: 'INACTIVE', label: 'Inactive', count: counts.inactive }, { value: 'ALL', label: 'All', count: counts.total }]} />
            <Select value={category} onValueChange={(x) => setCategory(x as SupplierCategory | 'all')}>
              <SelectTrigger aria-label="Filter by category" className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {Object.entries(SUPPLIER_CATEGORY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger aria-label="Filter by state" className="h-9 w-44"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All states</SelectItem>
                {stateOptions.map((c) => <SelectItem key={c} value={c}>{stateLabel(c).split(' — ')[1] ?? c}</SelectItem>)}
                <SelectItem value="none">State not set</SelectItem>
              </SelectContent>
            </Select>
            {filtersActive && <Button variant="ghost" size="sm" onClick={() => { setState('all'); setCategory('all') }}>Clear filters</Button>}
          </>
        }
        emptyState={
          all.length === 0
            ? {
              icon: Building2, title: 'No suppliers yet',
              description: canManage ? 'Add your raw material, packaging and service suppliers and outsourcing partners.' : 'No suppliers have been added yet.',
              action: canManage ? <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add Supplier</Button> : undefined,
            }
            : { icon: Building2, title: 'No suppliers match these filters', description: 'Change the status, category or state filter to see more suppliers.' }
        }
      />

      {editing && (
        <SupplierFormDialog
          supplier={editing === 'new' ? null : editing}
          companyId={access?.profile?.company_id ?? ''}
          existing={suppliers.data}
          onClose={() => setEditing(null)}
          onSaved={({ code, created }) => {
            setEditing(null)
            setNotice({ tone: 'success', text: created ? `Supplier ${code} created.` : `Supplier ${code} updated.` })
            suppliers.reload()
          }}
        />
      )}

      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.status === 'ACTIVE' ? `Deactivate ${toggle?.supplier_code}?` : `Activate ${toggle?.supplier_code}?`}
        description={toggle?.status === 'ACTIVE'
          ? 'The supplier will no longer be selectable for new purchase orders. Existing records keep their reference, and you can activate it again later.'
          : 'The supplier can be selected for new purchase orders again.'}
        confirmLabel={toggle?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        destructive={toggle?.status === 'ACTIVE'}
        onConfirm={async () => {
          if (!toggle) return
          const target = toggle
          setToggle(null)
          setNotice(null)
          try {
            await setSupplierStatus(target.id, target.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')
            setNotice({ tone: 'success', text: `Supplier ${target.supplier_code} ${target.status === 'ACTIVE' ? 'deactivated' : 'activated'}.` })
            suppliers.reload()
          } catch (e) {
            setNotice({ tone: 'error', text: describeDataError(e) })
          }
        }}
      />
    </>
  )
}
