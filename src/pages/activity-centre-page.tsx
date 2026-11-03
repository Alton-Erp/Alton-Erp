import { Activity, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ACTIVITY_LABELS } from '@/features/management/report-defs'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import { fetchActivity } from '@/services/management'
import type { DateRangeValue } from '@/types'

const PAGE = 50

/** /activity — recent activity across the business, built from the records themselves. */
export default function ActivityCentrePage() {
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('last_7_days'))
  // ?type=PAYMENT_REVERSED etc. opens a filtered view (e.g. correction history from ERP Settings).
  const [type, setType] = useState(() => new URLSearchParams(window.location.search).get('type') ?? 'all')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [page, setPage] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const feed = useAsync(() => fetchActivity({ from, to, type: type === 'all' ? null : type, search, limit: PAGE, offset: page * PAGE }), [from, to, type, search, page])
  const d = feed.data
  return (
    <>
      <PageHeader title="Activity Centre" description="What happened, when and on which record: products, BOMs, parties, purchases, receipts, production, sales, reservations, dispatches, invoices, payments and stock corrections."
        actions={<Button variant="outline" asChild><Link to="/audit-logs">Full audit log</Link></Button>} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <DateRangeFilter value={range} onChange={(r) => { setRange(r); setPage(0) }} />
          <div className="space-y-1"><Label htmlFor="ac-type">Activity</Label>
            <Select value={type} onValueChange={(v) => { if (v) { setType(v); setPage(0) } }}><SelectTrigger id="ac-type" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72"><SelectItem value="all">All activities</SelectItem>{Object.entries(ACTIVITY_LABELS).map(([k, l]) => (
                <SelectItem key={k} value={k}>{l}{d?.by_type[k] ? ` (${d.by_type[k]})` : ''}</SelectItem>))}</SelectContent></Select></div>
          <div className="relative w-64"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search activity" className="pl-9" placeholder="Reference or description…" value={term} onChange={(e) => { setTerm(e.target.value); setPage(0) }} /></div>
        </CardContent>
      </Card>
      {feed.loading && !d ? <LoadingState variant="table" rows={8} /> : feed.error || !d ? <Card><ErrorState message={describeDataError(feed.error)} onRetry={feed.reload} /></Card> : (
        <Card>
          <CardContent className="p-0">
            {d.rows.length === 0 ? <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Activity className="size-4" /> No activity for these filters.</p> : (
              <div className="overflow-x-auto"><table className="w-full text-sm" aria-label="Activity">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">Date and time</th><th className="px-3 py-2 text-left">Activity</th>
                  <th className="px-3 py-2 text-left">Reference</th><th className="px-3 py-2 text-left">Description</th></tr></thead>
                <tbody>{d.rows.map((r, i) => (
                  <tr key={`${r.type}-${r.reference}-${i}`} className="border-t">
                    <td className="px-3 py-1.5 whitespace-nowrap">{formatDateTime(r.at)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{ACTIVITY_LABELS[r.type] ?? r.type}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap"><Link className="text-primary hover:underline" to={r.link}>{r.reference}</Link></td>
                    <td className="px-3 py-1.5">{r.description}</td>
                  </tr>
                ))}</tbody></table></div>
            )}
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
              <span>{d.total} activit{d.total === 1 ? 'y' : 'ies'}</span>
              <span className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= d.total} onClick={() => setPage((p) => p + 1)}>Next</Button></span>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )
}
