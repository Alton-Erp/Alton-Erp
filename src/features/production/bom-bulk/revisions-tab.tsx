import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { FilterTabs } from '@/components/common/filter-tabs'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LIFECYCLE_LABELS, OPERATION_LABELS, revisionExportRows } from '@/features/production/bom-bulk-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useUrlEnum } from '@/hooks/use-url-state'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { fetchRevisionLog } from '@/services/bom-bulk'

type Source = 'ALL' | 'BULK' | 'MANUAL'

/** Revision History: every BOM version with who changed it, why, when and from which bulk batch. */
export function RevisionsTab({ onOpenBatch }: { onOpenBatch: (id: string) => void }) {
  const [source, setSource] = useUrlEnum<Source>('rsource', ['ALL', 'BULK', 'MANUAL'], 'ALL')
  const [text, setText] = useState('')
  const search = useDebouncedValue(text, 300)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [pageState, setPageState] = useState({ key: '', page: 0 })
  const [pageSize, setPageSize] = useState(25)
  const [exporting, setExporting] = useState(false)
  const pageKey = JSON.stringify([source, search, from, to, pageSize])
  const page = pageState.key === pageKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: pageKey, page: p })
  const filters = { source, search: search.trim() || undefined, from: from || undefined, to: to || undefined }
  const q = useAsync(() => fetchRevisionLog(filters, pageSize, page * pageSize), [source, search, from, to, page, pageSize])

  const exportAll = async () => {
    setExporting(true)
    try {
      const [all, { downloadSheets }] = await Promise.all([fetchRevisionLog(filters, 2000, 0), import('@/features/products/spreadsheet')])
      await downloadSheets([{ name: 'BOM revisions', rows: revisionExportRows(all.rows, formatDateTime) }], `bom-revisions-${toIsoDate(new Date())}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card data-testid="bom-revisions">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>BOM revision history</CardTitle>
            <CardDescription>Revisions are never overwritten: every change is a new version and earlier versions stay as they were.</CardDescription>
          </div>
          <Button variant="outline" disabled={exporting || !q.data?.total} onClick={() => void exportAll()}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterTabs<Source> label="Revision source" value={source} onChange={setSource}
            options={[{ value: 'ALL', label: 'All revisions' }, { value: 'BULK', label: 'Bulk changes' }, { value: 'MANUAL', label: 'Single BOM edits' }]} />
          <Input className="w-full sm:w-64" aria-label="Search revisions" placeholder="Product, BOM, batch or reason…" value={text} onChange={(e) => setText(e.target.value)} />
          <Input type="date" className="w-40" aria-label="Approved from" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" className="w-40" aria-label="Approved to" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {q.error && <p role="alert" className="px-5 py-3 text-sm text-red-700">{describeDataError(q.error)}</p>}
        <div className="overflow-x-auto">
          <Table data-testid="bom-revision-table">
            <TableHeader>
              <TableRow>
                <TableHead>Finished product</TableHead><TableHead>BOM / revision</TableHead><TableHead>Status</TableHead><TableHead>Effective</TableHead>
                <TableHead>Approved</TableHead><TableHead>Reason</TableHead><TableHead>Bulk batch</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.loading && !q.data && <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading…</TableCell></TableRow>}
              {q.data?.rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No revisions match.</TableCell></TableRow>}
              {q.data?.rows.map((r) => (
                <TableRow key={r.bom_id}>
                  <TableCell><span className="font-medium">{r.sku}</span><div className="text-xs text-muted-foreground">{r.product_name}</div></TableCell>
                  <TableCell><Link className="text-primary hover:underline" to={`/production/boms/${r.bom_id}`}>{r.bom_code}</Link> <span className="text-muted-foreground">v{r.version}</span></TableCell>
                  <TableCell><StatusBadge label={LIFECYCLE_LABELS[r.lifecycle] ?? r.lifecycle} tone={r.lifecycle === 'ACTIVE' ? 'success' : r.lifecycle === 'SCHEDULED' ? 'info' : 'neutral'} /></TableCell>
                  <TableCell className="text-xs">{formatDate(r.effective_from)} → {r.effective_to ? formatDate(r.effective_to) : 'open'}</TableCell>
                  <TableCell className="text-xs">{r.approved_at ? formatDateTime(r.approved_at) : '—'}<div className="text-muted-foreground">{r.approved_by_name ?? ''}</div></TableCell>
                  <TableCell className="max-w-72 text-sm">{r.change_reason ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{r.batch_id ? <button type="button" className="text-primary hover:underline" onClick={() => onOpenBatch(r.batch_id!)}>{r.batch_number}</button> : <span className="text-xs text-muted-foreground">single edit</span>}
                    {r.batch_operation && <div className="text-xs text-muted-foreground">{OPERATION_LABELS[r.batch_operation]}</div>}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.previous_bom_id && <Link className="text-primary hover:underline" to={`/production/boms/compare?ids=${r.previous_bom_id},${r.bom_id}`}>Compare with previous</Link>}
                    <div><Link className="text-primary hover:underline" to={`/production/boms/${r.bom_id}/versions`}>All versions</Link></div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {q.data && q.data.total > 0 && <PaginationBar page={page} pageSize={pageSize} total={q.data.total} onPageChange={setPage} onPageSizeChange={setPageSize} disabled={q.loading} />}
      </CardContent>
    </Card>
  )
}
