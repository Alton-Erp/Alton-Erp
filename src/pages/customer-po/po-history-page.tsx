import { FileWarning, History } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { AUDIT_EVENTS_EXPORT, REGISTER_EXPORT, RUNS_EXPORT } from '@/features/customer-po/export-columns'
import { ExportMenu } from '@/features/customer-po/po-export'
import { exportRows } from '@/features/customer-po/export-utils'
import { EVENT_LABELS } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { fetchAllocationRuns, fetchImportBatches, fetchPoEvents, fetchPos } from '@/services/customer-po'
import type { PoEventRow, PoImportBatchRow } from '@/types/database-customer-po'

type Tab = 'EVENTS' | 'IMPORTS'

export default function PoHistoryPage() {
  const [tab, setTab] = useState<Tab>('EVENTS')
  const events = useAsync(() => fetchPoEvents(null), [])
  const batches = useAsync(fetchImportBatches, [])
  const runs = useAsync(() => fetchAllocationRuns(null), [])
  const pos = useAsync(() => fetchPos({ status: null, currentOnly: false }), [])
  const names = useAsync(() => fetchDisplayNames([...(events.data ?? []).map((e) => e.actor_user_id), ...(batches.data ?? []).map((b) => b.uploaded_by), ...(runs.data ?? []).map((r) => r.created_by)]), [events.data, batches.data, runs.data])
  const poRef = useMemo(() => new Map((pos.data ?? []).map((p) => [p.id, p])), [pos.data])
  const who = (id: string | null) => (id && names.data?.get(id)) || '—'

  const eventColumns: DataTableColumn<PoEventRow>[] = [
    { id: 'at', header: 'Time', cell: (e) => formatDateTime(e.created_at), sortValue: (e) => e.created_at },
    { id: 'po', header: 'PO', cell: (e) => { const p = poRef.get(e.purchase_order_id); return <Link className="text-primary hover:underline" to={`/customer-pos/${e.purchase_order_id}`}>{p ? `${p.customer_po_number}${p.revision > 1 ? ` rev ${p.revision}` : ''}` : 'PO'}</Link> }, searchValue: (e) => poRef.get(e.purchase_order_id)?.customer_po_number ?? '' },
    { id: 'event', header: 'Event', cell: (e) => EVENT_LABELS[e.event_type] ?? e.event_type.replace(/_/g, ' ').toLowerCase(), searchValue: (e) => e.event_type },
    { id: 'status', header: 'Status', cell: (e) => (e.from_status !== e.to_status && e.to_status ? <span className="text-xs">{(e.from_status ?? 'new').replace(/_/g, ' ').toLowerCase()} → {e.to_status.replace(/_/g, ' ').toLowerCase()}</span> : '') },
    { id: 'user', header: 'User', cell: (e) => who(e.actor_user_id), searchValue: (e) => who(e.actor_user_id) },
    { id: 'note', header: 'Note', cell: (e) => <span className="block max-w-sm text-xs">{e.note}</span>, searchValue: (e) => e.note ?? '' },
  ]
  const batchColumns: DataTableColumn<PoImportBatchRow>[] = [
    { id: 'at', header: 'Uploaded', cell: (b) => formatDateTime(b.uploaded_at), sortValue: (b) => b.uploaded_at },
    { id: 'file', header: 'File', cell: (b) => <span>{b.file_name}{b.sheet_name && <span className="block text-xs text-muted-foreground">sheet {b.sheet_name}</span>}</span>, searchValue: (b) => b.file_name },
    { id: 'user', header: 'User', cell: (b) => who(b.uploaded_by) },
    { id: 'rows', header: 'Rows read / valid / rejected', align: 'right', cell: (b) => `${b.rows_read} / ${b.valid_rows} / ${b.invalid_rows}` },
    { id: 'status', header: 'Result', cell: (b) => <StatusBadge label={b.import_status === 'IMPORTED' ? (b.validation_status === 'VALID' ? 'Imported' : 'Imported (rows rejected)') : 'Rejected'} tone={b.import_status === 'IMPORTED' ? (b.validation_status === 'VALID' ? 'success' : 'warning') : 'danger'} /> },
    { id: 'errors', header: '', cell: (b) => (Array.isArray(b.error_summary) && b.error_summary.length > 0 ? (
      <Button variant="ghost" size="sm" onClick={() => void exportRows('Import errors', `po-import-errors-${b.file_name.replace(/\.[^.]+$/, '')}`,
        [{ header: 'Row', value: (r: { row?: unknown; message?: unknown }) => String(r.row ?? '') }, { header: 'Message', value: (r) => String(r.message ?? '') }],
        b.error_summary as { row?: unknown; message?: unknown }[], 'xlsx')}><FileWarning /> Error report</Button>
    ) : null) },
  ]

  return (
    <>
      <PageHeader actions={
        <>
          <ExportMenu title="PO register" fileStem="po-register-all" label="PO register (all revisions)" columns={REGISTER_EXPORT} rows={pos.data ?? []} />
          <ExportMenu title="PO audit" fileStem="po-audit-events" label="Status & audit history" columns={AUDIT_EVENTS_EXPORT}
            rows={(events.data ?? []).map((e) => ({ ...e, po_reference: poRef.get(e.purchase_order_id)?.po_reference, actor: who(e.actor_user_id) }))} />
          <ExportMenu title="Allocation audit" fileStem="po-allocation-audit" label="Reservation & allocation audit" columns={RUNS_EXPORT}
            rows={(runs.data ?? []).map((r) => ({ ...r, po_reference: poRef.get(r.purchase_order_id)?.po_reference, actor: who(r.created_by) }))} />
        </>
      } />
      <div className="mb-4"><FilterTabs<Tab> label="History view" value={tab} onChange={setTab} options={[{ value: 'EVENTS', label: 'PO activity' }, { value: 'IMPORTS', label: 'Imports' }]} /></div>
      {tab === 'EVENTS' ? (
        <DataTable title="PO activity" description="Imports, revisions, matching changes, allocations, releases, dispatches, holds and cancellations (append-only)."
          columns={eventColumns} data={events.data ?? []} getRowId={(e) => e.id} loading={events.loading}
          error={events.error ? new Error(describeDataError(events.error)) : null} onRetry={events.reload} pageSize={25} searchPlaceholder="Search PO, event, user or note…"
          emptyState={{ icon: History, title: 'No activity yet', description: 'Imported POs and their changes appear here.' }} />
      ) : (
        <DataTable title="Import batches" description="Every confirmed import attempt, including those rejected by the database. Files themselves are not stored."
          columns={batchColumns} data={batches.data ?? []} getRowId={(b) => b.id} loading={batches.loading}
          error={batches.error ? new Error(describeDataError(batches.error)) : null} onRetry={batches.reload} pageSize={25} searchPlaceholder="Search file name…"
          emptyState={{ icon: FileWarning, title: 'No imports yet', description: 'Upload a customer PO to see it here.' }} />
      )}
    </>
  )
}
