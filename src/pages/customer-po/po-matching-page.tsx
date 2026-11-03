import { Flag, Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { LineActionDialog } from '@/features/customer-po/line-action-dialog'
import { LineStatusBadge } from '@/features/customer-po/po-badges'
import { MATCHING_EXPORT } from '@/features/customer-po/export-columns'
import { ExportMenu } from '@/features/customer-po/po-export'
import { MATCH_METHOD_LABELS, STATUS_REASON_LABELS } from '@/features/customer-po/po-import'
import { NoPoSelected, PoContextBar } from '@/features/customer-po/po-picker'
import { usePoSelection } from '@/features/customer-po/use-po-selection'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchPoLines, rematchPo, type LineAction } from '@/services/customer-po'
import type { CustomerPoLineListRow } from '@/types/database-customer-po'

type Filter = 'ALL' | 'REVIEW' | 'MATCHED' | 'EXCLUDED'

export default function PoMatchingPage() {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const selection = usePoSelection(refresh)
  const lines = useAsync(() => (selection.poId ? fetchPoLines({ poId: selection.poId }) : Promise.resolve([])), [selection.poId, refresh])
  const unmatchedAll = useAsync(() => fetchPoLines({ statuses: ['UNMATCHED', 'AMBIGUOUS'] }), [refresh])
  const [filter, setFilter] = useState<Filter>('ALL')
  const [dialog, setDialog] = useState<{ line: CustomerPoLineListRow; action: LineAction } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const po = selection.selected
  const editable = Boolean(po && po.is_current && !['CANCELLED', 'FULFILLED'].includes(po.status) && has('customer_po.match'))
  const rows = (lines.data ?? []).filter((l) =>
    filter === 'ALL' ? true : filter === 'REVIEW' ? ['UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW'].includes(l.line_status) : l.line_status === filter)
  const reload = (m: string) => { setDialog(null); setMessage(m); setRefresh((n) => n + 1); selection.reload() }

  const action = (line: CustomerPoLineListRow, a: LineAction, label: string) => (
    <Button key={a} variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setDialog({ line, action: a }) }}>{label}</Button>
  )
  const locked = (l: CustomerPoLineListRow) => Number(l.allocated_open) > 0 || Number(l.quantity_dispatched) > 0

  const columns: DataTableColumn<CustomerPoLineListRow>[] = [
    { id: 'line', header: 'Line', cell: (l) => <span>{l.line_no}<span className="block text-xs text-muted-foreground">row {l.source_row_number}</span></span>, sortValue: (l) => l.line_no },
    { id: 'uploaded', header: 'Uploaded code / description', cell: (l) => (
      <span className="text-xs">
        {[l.uploaded_sku && `SKU ${l.uploaded_sku}`, l.uploaded_customer_sku && `Cust. ${l.uploaded_customer_sku}`, l.uploaded_barcode && `EAN ${l.uploaded_barcode}`].filter(Boolean).join(' · ') || '—'}
        {l.uploaded_description && <span className="block text-muted-foreground">{l.uploaded_description}</span>}
      </span>
    ), searchValue: (l) => `${l.uploaded_sku ?? ''} ${l.uploaded_customer_sku ?? ''} ${l.uploaded_barcode ?? ''} ${l.uploaded_description ?? ''}` },
    { id: 'qty', header: 'Ordered', align: 'right', cell: (l) => (
      <span>{formatQty(l.quantity_ordered, l.unit ?? l.uploaded_unit ?? undefined)}
        {(Number(l.quantity_ordered) !== Number(l.uploaded_quantity) || (l.uploaded_unit && l.unit !== l.uploaded_unit)) && <span className="block text-xs text-amber-800">uploaded {formatQty(l.uploaded_quantity, l.uploaded_unit ?? undefined)}</span>}
      </span>
    ) },
    { id: 'status', header: 'Status', cell: (l) => <span className="inline-flex flex-col gap-1"><LineStatusBadge status={l.line_status} />{l.flagged_for_new_product && <span className="inline-flex items-center gap-1 text-xs text-amber-800"><Flag className="size-3" /> new product</span>}</span>, sortValue: (l) => l.line_status },
    { id: 'product', header: 'Internal product', cell: (l) => (l.sku ? <span>{l.sku} — {l.product_name}<span className="block text-xs text-muted-foreground">{l.category_name ?? 'Uncategorised'} · {l.base_unit}</span></span> : '—'), searchValue: (l) => `${l.sku ?? ''} ${l.product_name ?? ''}` },
    { id: 'method', header: 'Method / explanation', cell: (l) => (
      <span className="block max-w-xs text-xs">
        {l.matching_method && <span className="font-medium">{MATCH_METHOD_LABELS[l.matching_method]}. </span>}
        {l.status_reason && <span className="text-shortage">{STATUS_REASON_LABELS[l.status_reason] ?? l.status_reason}. </span>}
        {l.match_note}
      </span>
    ) },
    { id: 'actions', header: '', cell: (l) => {
      if (!editable) return null
      const items = []
      if (['UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW', 'MATCHED'].includes(l.line_status) && !locked(l)) items.push(action(l, 'MATCH', l.line_status === 'MATCHED' ? 'Change product' : 'Select product'))
      if (l.line_status === 'DUPLICATE_REVIEW') items.push(action(l, 'CONFIRM_DUPLICATE', 'Keep as separate'))
      if (l.line_status === 'INVALID' && l.status_reason === 'UNIT_MISMATCH' && !locked(l)) items.push(action(l, 'CORRECT', 'Correct unit'))
      if (['UNMATCHED', 'AMBIGUOUS'].includes(l.line_status)) items.push(action(l, l.flagged_for_new_product ? 'UNFLAG' : 'FLAG_NEW_PRODUCT', l.flagged_for_new_product ? 'Unflag' : 'Flag new product'))
      if (l.line_status !== 'EXCLUDED' && !locked(l)) items.push(action(l, 'EXCLUDE', 'Exclude'))
      if (l.line_status === 'EXCLUDED') items.push(action(l, 'RESTORE', 'Restore'))
      if (l.line_status === 'MATCHED' && !locked(l)) items.push(action(l, 'CORRECT', 'Correct qty'))
      return <div className="flex flex-wrap justify-end gap-0.5">{items}</div>
    } },
  ]

  const review = (lines.data ?? []).filter((l) => ['UNMATCHED', 'AMBIGUOUS', 'INVALID', 'DUPLICATE_REVIEW'].includes(l.line_status)).length

  return (
    <>
      <PageHeader
        actions={
          <ExportMenu title="Unmatched products" fileStem="po-unmatched-products" label="Unmatched products (all POs)" columns={MATCHING_EXPORT} rows={unmatchedAll.data ?? []} />
        }
      />
      <PoContextBar selection={selection}>
        {editable && (
          <Button variant="outline" disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try { const r = await rematchPo(selection.poId); reload(`Matching re-run: ${r.lines_changed} line(s) changed. PO is ${r.po_status.replace(/_/g, ' ').toLowerCase()}.`) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
          }}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-run matching</Button>
        )}
        {po && <ExportMenu title="Product matching" fileStem={`po-matching-${po.customer_po_number}`} label="Matching report" columns={MATCHING_EXPORT} rows={lines.data ?? []} />}
      </PoContextBar>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {!po ? <NoPoSelected /> : (
        <DataTable
          title={`Lines of ${po.customer_po_number}${po.revision > 1 ? ` (revision ${po.revision})` : ''}`}
          description={review ? `${review} line(s) need review before the PO can be allocated.` : 'All lines are resolved.'}
          columns={columns}
          data={rows}
          getRowId={(l) => l.id}
          loading={lines.loading}
          error={lines.error ? new Error(describeDataError(lines.error)) : null}
          onRetry={lines.reload}
          pageSize={25}
          searchPlaceholder="Search codes, descriptions or products…"
          toolbar={<FilterTabs<Filter> label="Line filter" value={filter} onChange={setFilter} options={[
            { value: 'ALL', label: 'All', count: (lines.data ?? []).length },
            { value: 'REVIEW', label: 'Needs review', count: review },
            { value: 'MATCHED', label: 'Matched' },
            { value: 'EXCLUDED', label: 'Excluded' },
          ]} />}
          emptyState={{ icon: ScanSearch, title: 'No lines', description: 'This PO has no lines in this view.' }}
        />
      )}
      {!editable && po && has('customer_po.match') && <p className="mt-3 text-xs text-muted-foreground">This PO revision is {po.is_current ? po.status.replace(/_/g, ' ').toLowerCase() : 'superseded'} and its lines can no longer be changed.</p>}
      {dialog && po && <LineActionDialog line={dialog.line} action={dialog.action} hasCustomerRecord={Boolean(po.customer_id)} onClose={() => setDialog(null)} onDone={reload} />}
    </>
  )
}
