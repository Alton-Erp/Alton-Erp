import { Loader2, Pencil, Plus, Power, PowerOff, Users } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { GST_TYPE_LABELS } from '@/features/billing/billing-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { createCustomer, fetchCustomers, updateCustomer } from '@/services/customer-po'
import type { CustomerBillingFields, CustomerRow, GstRegistrationType } from '@/types/database-customer-po'

/**
 * Customer master: the records customer POs and sales orders refer to, with the
 * billing identity (legal name, GST registration, addresses, payment terms)
 * used by invoices (Phase 8). Nothing is created automatically.
 */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

function StateSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { states } = useGstStates()
  return (
    <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : v)}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent className="max-h-72"><SelectItem value="none">Not set</SelectItem>{states.map((s) => <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function CustomerDialog({ customer, companyId, onClose, onSaved }: { customer: CustomerRow | null; companyId: string; onClose: () => void; onSaved: (m: string) => void }) {
  const [code, setCode] = useState(customer?.customer_code ?? '')
  const [name, setName] = useState(customer?.customer_name ?? '')
  const [email, setEmail] = useState(customer?.contact_email ?? '')
  const [notes, setNotes] = useState(customer?.notes ?? '')
  const [b, setB] = useState({
    legal_name: customer?.legal_name ?? '', gst_registration_type: customer?.gst_registration_type ?? '', gstin: customer?.gstin ?? '', pan: customer?.pan ?? '',
    billing_address: customer?.billing_address ?? '', billing_state_code: customer?.billing_state_code ?? '', shipping_address: customer?.shipping_address ?? '',
    shipping_state_code: customer?.shipping_state_code ?? '', payment_terms_days: customer?.payment_terms_days === null || customer?.payment_terms_days === undefined ? '' : String(customer.payment_terms_days),
  })
  const set = (k: keyof typeof b) => (v: string) => setB((x) => ({ ...x, [k]: v }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const billing = (): CustomerBillingFields => ({
    legal_name: b.legal_name.trim() || null, gst_registration_type: (b.gst_registration_type || null) as GstRegistrationType | null, gstin: b.gstin.trim().toUpperCase() || null,
    pan: b.pan.trim().toUpperCase() || null, billing_address: b.billing_address.trim() || null, billing_state_code: b.billing_state_code || null,
    shipping_address: b.shipping_address.trim() || null, shipping_state_code: b.shipping_state_code || null,
    payment_terms_days: b.payment_terms_days.trim() === '' ? null : Number(b.payment_terms_days),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{customer ? `Edit ${customer.customer_code}` : 'New customer'}</DialogTitle><DialogDescription>Codes are unique within the company and cannot be changed later. Billing details are copied onto each invoice when it is drafted; issued invoices keep their copy.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="cu-code">Customer code</Label><Input id="cu-code" maxLength={30} disabled={Boolean(customer)} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. ACME" /></div>
          <div className="space-y-1"><Label htmlFor="cu-email">Contact e-mail (optional)</Label><Input id="cu-email" type="email" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="cu-name">Customer name</Label><Input id="cu-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <p className="border-t pt-3 text-sm font-medium sm:col-span-2">Billing details</p>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="cu-legal">Legal name (as on GST registration)</Label><Input id="cu-legal" maxLength={200} value={b.legal_name} onChange={(e) => set('legal_name')(e.target.value)} placeholder="Defaults to the customer name" /></div>
          <div className="space-y-1"><Label htmlFor="cu-gsttype">GST registration type</Label>
            <Select value={b.gst_registration_type || 'none'} onValueChange={(v) => set('gst_registration_type')(v === 'none' ? '' : v)}>
              <SelectTrigger id="cu-gsttype"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Not set</SelectItem>{Object.entries(GST_TYPE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="cu-gstin">GSTIN</Label><Input id="cu-gstin" maxLength={15} value={b.gstin} onChange={(e) => set('gstin')(e.target.value.toUpperCase())} /></div>
          <div className="space-y-1"><Label htmlFor="cu-pan">PAN (optional)</Label><Input id="cu-pan" maxLength={10} value={b.pan} onChange={(e) => set('pan')(e.target.value.toUpperCase())} /></div>
          <div className="space-y-1"><Label htmlFor="cu-terms">Payment terms (days)</Label><Input id="cu-terms" inputMode="numeric" value={b.payment_terms_days} onChange={(e) => set('payment_terms_days')(e.target.value)} placeholder="Company default" /></div>
          <div className="space-y-1"><Label htmlFor="cu-bill">Billing address</Label><Textarea id="cu-bill" rows={2} maxLength={1000} value={b.billing_address} onChange={(e) => set('billing_address')(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cu-billstate">Billing state</Label><StateSelect id="cu-billstate" value={b.billing_state_code} onChange={set('billing_state_code')} /></div>
          <div className="space-y-1"><Label htmlFor="cu-ship">Shipping address (if different)</Label><Textarea id="cu-ship" rows={2} maxLength={1000} value={b.shipping_address} onChange={(e) => set('shipping_address')(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cu-shipstate">Shipping state</Label><StateSelect id="cu-shipstate" value={b.shipping_state_code} onChange={set('shipping_state_code')} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="cu-notes">Notes</Label><Textarea id="cu-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setError(null)
            if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code)) return setError('Code: 1–30 letters, digits, _ or -.')
            if (!name.trim()) return setError('Enter the customer name.')
            if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter a valid e-mail address.')
            const bf = billing()
            if (bf.gstin && !GSTIN_RE.test(bf.gstin)) return setError('GSTIN must be a valid 15-character GSTIN.')
            if (bf.pan && !PAN_RE.test(bf.pan)) return setError('PAN must be 10 characters (e.g. ABCDE1234F).')
            if (['REGISTERED', 'COMPOSITION', 'SEZ'].includes(bf.gst_registration_type ?? '') && !bf.gstin) return setError('Registered customers need a GSTIN.')
            if (b.payment_terms_days.trim() && !/^\d{1,3}$/.test(b.payment_terms_days.trim())) return setError('Payment terms must be 0–365 days.')
            setBusy(true)
            try {
              if (customer) await updateCustomer(customer.id, { customer_name: name.trim(), contact_email: email.trim() || null, notes: notes.trim() || null, ...bf })
              else await createCustomer(companyId, { code, name: name.trim(), email: email.trim() || null, notes: notes.trim() || null, billing: bf })
              onSaved(`Customer ${code} saved.`)
            } catch (e) {
              setError((e as { code?: string }).code === '23505' ? 'A customer with this code already exists.' : describeDataError(e))
              setBusy(false)
            }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function CustomersPage() {
  const { access } = useAuth()
  const { has } = usePermissions()
  const [filter, setFilter] = useState<'ACTIVE' | 'INACTIVE' | 'ALL'>('ACTIVE')
  const [refresh, setRefresh] = useState(0)
  const customers = useAsync(() => fetchCustomers(true), [refresh])
  const [editing, setEditing] = useState<CustomerRow | 'new' | null>(null)
  const [toggle, setToggle] = useState<CustomerRow | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rows = (customers.data ?? []).filter((c) => filter === 'ALL' || c.status === filter)
  const canManage = has('customers.manage')

  const columns: DataTableColumn<CustomerRow>[] = [
    { id: 'code', header: 'Code', cell: (c) => <span className="font-medium">{c.customer_code}</span>, searchValue: (c) => c.customer_code, sortValue: (c) => c.customer_code },
    { id: 'name', header: 'Customer', cell: (c) => c.customer_name, searchValue: (c) => c.customer_name, sortValue: (c) => c.customer_name },
    { id: 'gst', header: 'GST', cell: (c) => <span className="text-xs">{c.gstin ?? (c.gst_registration_type ? GST_TYPE_LABELS[c.gst_registration_type] : <span className="text-amber-800">Billing details missing</span>)}</span>, searchValue: (c) => c.gstin ?? '' },
    { id: 'email', header: 'Contact e-mail', cell: (c) => c.contact_email ?? '—', searchValue: (c) => c.contact_email ?? '' },
    { id: 'updated', header: 'Updated', cell: (c) => formatDateTime(c.updated_at) },
    { id: 'status', header: 'Status', cell: (c) => <StatusBadge label={c.status === 'ACTIVE' ? 'Active' : 'Inactive'} tone={c.status === 'ACTIVE' ? 'success' : 'neutral'} /> },
    { id: 'act', header: '', cell: (c) => (canManage ? (
      <span className="flex justify-end gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.customer_code}`} onClick={() => setEditing(c)}><Pencil /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={c.status === 'ACTIVE' ? `Deactivate ${c.customer_code}` : `Activate ${c.customer_code}`} onClick={() => setToggle(c)}>{c.status === 'ACTIVE' ? <PowerOff /> : <Power />}</Button>
      </span>
    ) : null) },
  ]

  return (
    <>
      <PageHeader description="Customer records used by customer POs, sales orders and invoices, including billing details (GST registration, addresses, payment terms)." actions={canManage ? <Button onClick={() => setEditing('new')}><Plus /> Add customer</Button> : undefined} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <DataTable
        title="Customers"
        columns={columns}
        data={rows}
        getRowId={(c) => c.id}
        loading={customers.loading}
        error={customers.error ? new Error(describeDataError(customers.error)) : null}
        onRetry={customers.reload}
        pageSize={25}
        searchPlaceholder="Search code, name or e-mail…"
        toolbar={<FilterTabs<'ACTIVE' | 'INACTIVE' | 'ALL'> label="Customer status" value={filter} onChange={setFilter} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }, { value: 'ALL', label: 'All' }]} />}
        emptyState={{ icon: Users, title: 'No customers yet', description: 'Add the customers whose purchase orders you receive. Customer POs can also use an external name reference.' }}
      />
      {editing && <CustomerDialog customer={editing === 'new' ? null : editing} companyId={access?.profile?.company_id ?? ''} onClose={() => setEditing(null)}
        onSaved={(m) => { setEditing(null); setMessage(m); setRefresh((n) => n + 1) }} />}
      <ConfirmDialog open={toggle !== null} onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.status === 'ACTIVE' ? 'Deactivate customer?' : 'Activate customer?'}
        description={toggle?.status === 'ACTIVE' ? 'Inactive customers cannot be selected for new POs. Existing POs are unaffected.' : 'The customer can be selected for new POs again.'}
        confirmLabel={toggle?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} destructive={toggle?.status === 'ACTIVE'}
        onConfirm={async () => {
          if (!toggle) return
          setError(null)
          try { await updateCustomer(toggle.id, { status: toggle.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }); setMessage(`Customer ${toggle.customer_code} updated.`); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) }
          setToggle(null)
        }} />
    </>
  )
}
