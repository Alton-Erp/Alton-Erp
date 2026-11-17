import { Loader2 } from 'lucide-react'

import { FilterTabs } from '@/components/common/filter-tabs'
import { StatusBadge } from '@/components/common/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BATCH_STATUS_LABELS, BATCH_STATUS_TONE, OPERATION_LABELS } from '@/features/production/bom-bulk-model'
import { useAsync } from '@/hooks/use-async'
import { useUrlEnum, useUrlString } from '@/hooks/use-url-state'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber } from '@/lib/format'
import { fetchBatches, type BatchStatus } from '@/services/bom-bulk'

import { BatchDetailView } from './batch-detail'

type Filter = 'OPEN' | BatchStatus | 'ALL'
const FILTERS: Filter[] = ['OPEN', 'PENDING_APPROVAL', 'APPROVED', 'DRAFT', 'REJECTED', 'PUBLISHED', 'CANCELLED', 'ALL']

/** Change Approvals: every bulk change batch; ?batch=… opens one (preview, impact, approve / reject / publish). */
export function ApprovalsTab() {
  const [batchId, setBatchId] = useUrlString('batch')
  const [filter, setFilter] = useUrlEnum<Filter>('bstatus', FILTERS, 'OPEN')
  const q = useAsync(() => fetchBatches(filter === 'ALL' || filter === 'OPEN' ? null : filter, 500), [filter, batchId])
  if (batchId) return <BatchDetailView batchId={batchId} onBack={() => setBatchId('')} onOpen={setBatchId} />
  const counts = q.data?.counts ?? {}
  const rows = (q.data?.rows ?? []).filter((r) => filter !== 'OPEN' || ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(r.status))
  const open = (counts.DRAFT ?? 0) + (counts.PENDING_APPROVAL ?? 0) + (counts.APPROVED ?? 0) + (counts.REJECTED ?? 0)
  return (
    <Card data-testid="bom-approvals">
      <CardHeader className="gap-3">
        <div>
          <CardTitle>Bulk BOM change batches</CardTitle>
          <CardDescription>Prepared → submitted → approved by an authorised user → published (all BOMs in one transaction). Rejected batches go back to the creator.</CardDescription>
        </div>
        <FilterTabs<Filter> label="Batch status" value={filter} onChange={setFilter} options={[
          { value: 'OPEN', label: 'Open', count: open },
          { value: 'PENDING_APPROVAL', label: 'Awaiting approval', count: counts.PENDING_APPROVAL ?? 0 },
          { value: 'APPROVED', label: 'Ready to publish', count: counts.APPROVED ?? 0 },
          { value: 'DRAFT', label: 'Draft', count: counts.DRAFT ?? 0 },
          { value: 'REJECTED', label: 'Rejected', count: counts.REJECTED ?? 0 },
          { value: 'PUBLISHED', label: 'Published', count: counts.PUBLISHED ?? 0 },
          { value: 'CANCELLED', label: 'Cancelled', count: counts.CANCELLED ?? 0 },
          { value: 'ALL', label: 'All' },
        ]} />
      </CardHeader>
      <CardContent className="p-0">
        {q.error && <p role="alert" className="px-5 py-3 text-sm text-red-700">{describeDataError(q.error)}</p>}
        <div className="overflow-x-auto">
          <Table data-testid="bom-batches">
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead><TableHead>Operation</TableHead><TableHead>Reason</TableHead><TableHead className="text-right">BOMs</TableHead>
                <TableHead className="text-right">Errors</TableHead><TableHead>Effective</TableHead><TableHead>Status</TableHead><TableHead>Prepared</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.loading && !q.data && <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading…</TableCell></TableRow>}
              {q.data && rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No batches here. Prepare one in the Bulk BOM Editor or from an Excel file.</TableCell></TableRow>}
              {rows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" tabIndex={0} onClick={() => setBatchId(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setBatchId(r.id) }}>
                  <TableCell className="font-medium text-primary">{r.batch_number}{r.title && <div className="text-xs font-normal text-muted-foreground">{r.title}</div>}</TableCell>
                  <TableCell>{OPERATION_LABELS[r.operation]}</TableCell>
                  <TableCell className="max-w-72 truncate text-sm" title={r.reason}>{r.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.summary.boms ?? 0)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.summary.lines_with_errors ? 'text-red-700' : ''}`}>{formatNumber(r.summary.lines_with_errors ?? 0)}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.effective_from)}</TableCell>
                  <TableCell><StatusBadge label={BATCH_STATUS_LABELS[r.status]} tone={BATCH_STATUS_TONE[r.status]} />{r.stale && <div className="text-xs text-amber-700">BOMs changed since</div>}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(r.created_at)}<div className="text-muted-foreground">{r.created_by_name ?? ''}</div></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
