import { GitCompareArrows, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { formatAmount } from '@/features/accounting/accounting-model'
import type { MatchingCandidate } from '@/features/accounting/purchase-invoice-model'
import { SupplierSelect } from '@/features/accounting/purchase-invoice-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchMatchingCandidates, fetchPiLookups } from '@/services/accounting'
import type { PiEntryState } from './purchase-invoice-entry-page'

/** Goods receipt lines of a supplier with ordered / received / invoiced / remaining quantities; start an invoice from selected lines. */
export default function PurchaseInvoiceMatchingPage() {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const supplier = params.get('supplier') ?? ''
  const includeDone = params.get('all') === '1'
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const lookups = useAsync(() => fetchPiLookups(), [])
  const cands = useAsync(() => (supplier ? fetchMatchingCandidates(supplier, null, includeDone) : Promise.resolve([] as MatchingCandidate[])), [supplier, includeDone])
  const [chosen, setChosen] = useState<string[]>([])
  const rows = cands.data ?? []
  const open = rows.filter((c) => chosen.includes(c.line_id) && Number(c.remaining_quantity) > 0)

  const columns: DataTableColumn<MatchingCandidate>[] = [
    { id: 'pick', header: '', cell: (c) => Number(c.remaining_quantity) > 0 ? <Checkbox aria-label={`Select ${c.receipt_number} ${c.description ?? ''}`} checked={chosen.includes(c.line_id)}
      onCheckedChange={(v) => setChosen((x) => (v ? [...x, c.line_id] : x.filter((y) => y !== c.line_id)))} /> : null },
    { id: 'receipt', header: 'Receipt', sortValue: (c) => c.receipt_date, searchValue: (c) => `${c.receipt_number} ${c.po_number ?? ''}`, cell: (c) => <span className="text-sm">{c.receipt_number}
      <span className="block text-xs text-muted-foreground">{formatDate(c.receipt_date)}{c.po_number ? ` · ${c.po_number}` : ' · without PO'}</span></span> },
    { id: 'item', header: 'Item', searchValue: (c) => c.description ?? '', cell: (c) => <span className="text-sm">{c.description}</span> },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (c) => (c.ordered_quantity === null ? '—' : Number(c.ordered_quantity)) },
    { id: 'accepted', header: 'Accepted', align: 'right', cell: (c) => Number(c.accepted_quantity) },
    { id: 'invoiced', header: 'On invoices', align: 'right', headerTitle: 'Draft, submitted, approved and posted invoices', cell: (c) => Number(c.invoiced_quantity) },
    { id: 'remaining', header: 'To invoice', align: 'right', sortValue: (c) => Number(c.remaining_quantity), cell: (c) => <span className="font-medium">{Number(c.remaining_quantity)}</span> },
    { id: 'cost', header: 'Receipt cost', align: 'right', cell: (c) => <span className="tabular-nums">{formatAmount(c.unit_cost)} @ {Number(c.gst_rate)}%</span> },
    { id: 'payable', header: 'Receipt payable', align: 'right', cell: (c) => <span className="tabular-nums">{formatAmount(c.payable)}</span> },
    { id: 'state', header: 'State', cell: (c) => <span className="flex flex-col items-start gap-1">
      <StatusBadge label={Number(c.remaining_quantity) === 0 ? 'Fully invoiced' : Number(c.invoiced_quantity) > 0 ? 'Partly invoiced' : 'Not invoiced'}
        tone={Number(c.remaining_quantity) === 0 ? 'success' : Number(c.invoiced_quantity) > 0 ? 'info' : 'neutral'} />
      {!c.in_books && <StatusBadge label="Not posted to accounts" tone="warning" />}</span> },
  ]

  return (
    <>
      <PageHeader title="GRN Matching" description="Goods receipts to invoice: quantities ordered, accepted, already on supplier invoices and still to invoice."
        breadcrumbs={[{ label: 'Purchase & GRN' }, { label: 'Supplier Invoices', to: '/purchases/invoices' }, { label: 'GRN matching' }]} actions={
          has('purchase_invoices.create') && <Button disabled={open.length === 0} onClick={() => navigate('/purchases/invoices/new', {
            state: { supplierId: supplier, candidates: open } satisfies PiEntryState })}><Plus /> Invoice {open.length || ''} selected line(s)</Button>} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-80 space-y-1"><Label htmlFor="pm-supplier">Supplier</Label>
            <SupplierSelect id="pm-supplier" value={supplier} suppliers={lookups.data?.suppliers ?? []} loading={lookups.loading}
              onChange={(v) => { setChosen([]); set('supplier', v) }} /></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={includeDone} onCheckedChange={(c) => set('all', c ? '1' : '')} /> Include fully invoiced lines</label>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(c) => c.line_id} loading={cands.loading} pageSize={100}
        error={cands.error ? new Error(describeDataError(cands.error)) : null} onRetry={cands.reload}
        searchPlaceholder="Search receipt or item"
        emptyState={{ icon: GitCompareArrows, title: supplier ? 'Nothing to invoice' : 'Select a supplier',
          description: supplier ? 'This supplier has no posted goods receipt lines left to invoice.' : 'Receipt lines of the supplier appear here.' }} />
    </>
  )
}
