import { StatusBadge } from '@/components/common/status-badge'
import { SearchSelect } from '@/features/accounting/accounting-ui'
import {
  GST_STATUS_META, PI_STATUS_META, VARIANCE_STATUS_META, type GstStatus, type PiIssue, type PiLookupSupplier, type PiStatus, type VarianceStatus,
} from '@/features/accounting/purchase-invoice-model'

export const PiStatusBadge = ({ status }: { status: PiStatus }) => <StatusBadge label={PI_STATUS_META[status].label} tone={PI_STATUS_META[status].tone} />
export const GstStatusBadge = ({ status }: { status: GstStatus }) => <StatusBadge label={GST_STATUS_META[status].label} tone={GST_STATUS_META[status].tone} />
export const VarianceBadge = ({ status }: { status: VarianceStatus }) =>
  status === 'NONE' ? null : <StatusBadge label={VARIANCE_STATUS_META[status].label} tone={VARIANCE_STATUS_META[status].tone} />

/** Supplier picker fed by purchase_invoice_lookups (works with purchase_invoices.read alone). */
export function SupplierSelect({ id, value, onChange, suppliers, loading = false, allowClear = false, placeholder = 'Select a supplier', className }: {
  id?: string; value: string; onChange: (id: string) => void; suppliers: PiLookupSupplier[]; loading?: boolean; allowClear?: boolean; placeholder?: string; className?: string
}) {
  return (
    <SearchSelect id={id} value={value} loading={loading} allowClear={allowClear} placeholder={placeholder} className={className} onChange={onChange}
      options={suppliers.map((s) => ({ value: s.id, label: `${s.supplier_code} — ${s.name}`, hint: s.gstin ?? 'no GSTIN' }))} />
  )
}

/** Blocking issues (must be fixed) and variances (need approval), as returned by the database. */
export function PiIssues({ issues, title = 'Before this invoice can move on' }: { issues: PiIssue[]; title?: string }) {
  if (!issues.length) return null
  const blocking = issues.filter((i) => i.blocking)
  const variances = issues.filter((i) => !i.blocking)
  return (
    <div className="mb-4 space-y-2" data-testid="pi-issues">
      {blocking.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
          <p className="font-medium">{title}:</p>
          <ul className="list-disc pl-5">{blocking.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
        </div>
      )}
      {variances.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <p className="font-medium">Variances against the goods receipts (need approval with a reason):</p>
          <ul className="list-disc pl-5">{variances.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
        </div>
      )}
    </div>
  )
}
