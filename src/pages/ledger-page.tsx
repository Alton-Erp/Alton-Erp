import { ArrowDownLeft, ArrowUpRight, BookUser, Building2, Download, Loader2, Plus, Repeat, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PARTY_TYPE_LABELS, ledgerExportRows, ledgerSummary, type PartyRow, type PartyType } from '@/features/ledger/ledger-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatNumber, toIsoDate } from '@/lib/format'
import { fetchParties, syncParties } from '@/services/ledger'

type TypeFilter = 'ALL' | PartyType
type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL'

async function load() {
  // Any customer or supplier without a party (e.g. created before the ledger) gets one first.
  await syncParties().catch(() => undefined)
  return fetchParties(null, null, null)
}

const money = (v: number) => (Math.abs(v) < 0.005 ? '—' : formatCurrency(v))
const todayStamp = () => toIsoDate(new Date())

export type LedgerScope = 'CUSTOMER' | 'SUPPLIER'

/**
 * /ledger — customers and suppliers in one list with outstanding balances.
 * /ledger/customers and /ledger/suppliers show the same list limited to one side
 * (parties that are both are included in each).
 */
export default function LedgerPage({ scope }: { scope?: LedgerScope }) {
  const navigate = useNavigate()
  const { has, hasAny } = usePermissions()
  const parties = useAsync(load, [])
  const [type, setType] = useState<TypeFilter>('ALL')
  const [status, setStatus] = useState<StatusFilter>('ACTIVE')
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const all = (parties.data ?? []).filter((p) => !scope || p.party_type === scope || p.party_type === 'BOTH')
  const rows = all.filter((p) => (type === 'ALL' || p.party_type === type) && (status === 'ALL' || p.status === status))
  const sum = ledgerSummary(all)
  const canAdd = scope === 'CUSTOMER' ? has('customers.manage') : scope === 'SUPPLIER' ? has('suppliers.manage') : hasAny(['customers.manage', 'suppliers.manage'])
  const title = scope === 'CUSTOMER' ? 'Customer Ledger' : scope === 'SUPPLIER' ? 'Supplier Ledger' : 'Customer & Supplier Ledger'
  const fileName = scope === 'CUSTOMER' ? 'customer-ledger' : scope === 'SUPPLIER' ? 'supplier-ledger' : 'ledger'

  const exportExcel = async () => {
    setExporting(true)
    setNotice(null)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Ledger', rows: ledgerExportRows(rows) }], `${fileName}-${todayStamp()}`, 'xlsx')
      setNotice(`Exported ${formatNumber(rows.length)} parties matching the current filters.`)
    } catch (e) {
      setNotice(describeDataError(e))
    } finally {
      setExporting(false)
    }
  }

  const columns: DataTableColumn<PartyRow>[] = [
    {
      id: 'party', header: 'Party', cell: (p) => (
        <span><span className="font-medium">{p.party_name}</span>
          <span className="block text-xs text-muted-foreground">{[p.party_code, p.customer_code, p.supplier_code].filter(Boolean).join(' · ')}</span></span>
      ),
      searchValue: (p) => [p.party_name, p.legal_name, p.party_code, p.customer_code, p.supplier_code, p.gstin, p.email, p.phone, p.phone?.replace(/\D/g, ''), p.city].filter(Boolean).join(' '),
      sortValue: (p) => p.party_name.toLowerCase(),
    },
    { id: 'type', header: 'Type', cell: (p) => <StatusBadge label={PARTY_TYPE_LABELS[p.party_type]} tone={p.party_type === 'BOTH' ? 'info' : 'neutral'} />, sortValue: (p) => p.party_type },
    { id: 'gstin', header: 'GSTIN', cell: (p) => p.gstin ?? <span className="text-muted-foreground">—</span> },
    { id: 'contact', header: 'Contact', cell: (p) => <span className="text-xs">{p.phone ?? '—'}{p.email && <span className="block text-muted-foreground">{p.email}</span>}</span> },
    { id: 'place', header: 'City / State', cell: (p) => <span className="text-xs">{[p.city, p.state_name].filter(Boolean).join(', ') || '—'}</span>, sortValue: (p) => p.state_name ?? '' },
    ...(scope === 'SUPPLIER' ? [] : [{ id: 'rcv', header: 'Receivable', align: 'right', cell: (p) => <span className={Number(p.overdue) > 0 ? 'font-medium text-shortage' : undefined} title={Number(p.overdue) > 0 ? `${formatCurrency(Number(p.overdue))} overdue` : undefined}>{money(Number(p.receivable))}</span>, sortValue: (p) => Number(p.receivable) }] as DataTableColumn<PartyRow>[]),
    ...(scope === 'CUSTOMER' ? [] : [{ id: 'pay', header: 'Payable', align: 'right', cell: (p) => money(Number(p.payable)), sortValue: (p) => Number(p.payable) }] as DataTableColumn<PartyRow>[]),
    { id: 'status', header: 'Status', cell: (p) => <StatusBadge label={p.status === 'ACTIVE' ? 'Active' : 'Inactive'} tone={p.status === 'ACTIVE' ? 'success' : 'neutral'} />, sortValue: (p) => p.status },
  ]

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            <Button variant="outline" disabled={exporting || rows.length === 0} onClick={() => void exportExcel()}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel
            </Button>
            {canAdd && <Button asChild><Link to={scope ? `/ledger/new?type=${scope}` : '/ledger/new'}><Plus /> {scope === 'CUSTOMER' ? 'Add customer' : scope === 'SUPPLIER' ? 'Add supplier' : 'Add party'}</Link></Button>}
          </>
        }
      />
      {notice && <p role="status" className="mb-4 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm">{notice}</p>}
      <section aria-label="Ledger summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {scope !== 'SUPPLIER' && <KpiCard label="Customers" value={parties.data ? formatNumber(sum.customers) : null} hint="Active, customer only" icon={Users} accent="available" />}
        {scope !== 'CUSTOMER' && <KpiCard label="Suppliers" value={parties.data ? formatNumber(sum.suppliers) : null} hint="Active, supplier only" icon={Building2} accent="outsourced" />}
        <KpiCard label="Customer & Supplier" value={parties.data ? formatNumber(sum.both) : null} hint="Active, both roles" icon={Repeat} accent="hybrid" />
        {scope !== 'SUPPLIER' && <KpiCard label="Total Receivables" value={parties.data ? formatCurrency(sum.receivable) : null} hint={sum.overdue > 0 ? `${formatCurrency(sum.overdue)} overdue` : 'Owed to us'} icon={ArrowDownLeft} accent={sum.overdue > 0 ? 'shortage' : 'manufacturing'} />}
        {scope !== 'CUSTOMER' && <KpiCard label="Total Payables" value={parties.data ? formatCurrency(sum.payable) : null} hint="Owed by us (goods received less payments)" icon={ArrowUpRight} accent="pending" />}
        <KpiCard label="Parties with a Balance" value={parties.data ? formatNumber(sum.withBalance) : null} hint={`${formatNumber(sum.inactive)} inactive parties`} icon={BookUser} />
      </section>
      <DataTable
        title="Parties"
        description={has('ledger.read') ? 'Search by name, code, GSTIN, mobile or e-mail. Click a party for its details and transaction history.' : undefined}
        columns={columns}
        data={rows}
        getRowId={(p) => p.party_id}
        loading={parties.loading}
        error={parties.error ? new Error(describeDataError(parties.error)) : null}
        onRetry={parties.reload}
        onRowClick={(p) => navigate(`/ledger/${p.party_id}`)}
        searchPlaceholder="Search name, GSTIN, mobile…"
        pageSize={25}
        toolbar={
          <>
            <FilterTabs<TypeFilter> label="Party type" value={type} onChange={setType}
              options={scope === 'CUSTOMER' ? [{ value: 'ALL', label: 'All customers' }, { value: 'CUSTOMER', label: 'Customer only' }, { value: 'BOTH', label: 'Also supplier' }]
                : scope === 'SUPPLIER' ? [{ value: 'ALL', label: 'All suppliers' }, { value: 'SUPPLIER', label: 'Supplier only' }, { value: 'BOTH', label: 'Also customer' }]
                : [{ value: 'ALL', label: 'All' }, { value: 'CUSTOMER', label: 'Customers' }, { value: 'SUPPLIER', label: 'Suppliers' }, { value: 'BOTH', label: 'Both' }]} />
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger aria-label="Status" className="h-8 w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ACTIVE">Active</SelectItem><SelectItem value="INACTIVE">Inactive</SelectItem><SelectItem value="ALL">All statuses</SelectItem></SelectContent>
            </Select>
          </>
        }
        emptyState={{ icon: BookUser, title: 'No parties here', description: canAdd ? 'Add a customer or supplier, or change the filters.' : 'Change the filters.' }}
      />
    </>
  )
}
