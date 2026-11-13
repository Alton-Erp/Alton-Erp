import { PhoneIncoming, PhoneOutgoing, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CallStatusBadge } from '@/features/support/phone-components'
import { CALL_STATUS_META, formatDuration } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchCalls } from '@/services/phone'

const PAGE_SIZE = 25
const ALL = 'all'

/** Call log: every Acefone call with direction, status, numbers, agent, durations and links (server-side filters). */
export function CallLog() {
  const navigate = useNavigate()
  const [direction, setDirection] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => { const t = setTimeout(() => { setTerm(search.trim()); setPage(0) }, 300); return () => clearTimeout(t) }, [search])
  const list = useAsync(() => fetchCalls({ direction: direction === ALL ? undefined : direction, status: status === ALL ? undefined : status, search: term || undefined,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE }), [direction, status, term, page])
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-56 flex-1">
          <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search calls" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer, number or Acefone reference" />
        </div>
        <Select value={direction} onValueChange={(v) => { setDirection(v); setPage(0) }}>
          <SelectTrigger aria-label="Direction" className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All directions</SelectItem><SelectItem value="INBOUND">Incoming</SelectItem><SelectItem value="OUTBOUND">Outgoing</SelectItem></SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0) }}>
          <SelectTrigger aria-label="Call status" className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All statuses</SelectItem>{Object.entries(CALL_STATUS_META).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {list.loading && !list.data ? <LoadingState rows={6} />
        : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        : !list.data || list.data.rows.length === 0 ? <EmptyState icon={PhoneIncoming} title="No calls" description="Calls appear here when Acefone reports them or when an agent places one." />
        : (
          <div className="overflow-x-auto">
            <Table data-testid="call-log">
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Call</TableHead><TableHead>Customer</TableHead><TableHead>Agent</TableHead><TableHead>Status</TableHead>
                <TableHead>Started</TableHead><TableHead className="text-right">Ring</TableHead><TableHead className="text-right">Talk</TableHead><TableHead>Ticket</TableHead></TableRow></TableHeader>
              <TableBody>{list.data.rows.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/support/calls/${c.id}`)}>
                  <TableCell className="whitespace-nowrap"><Link to={`/support/calls/${c.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 font-medium hover:underline">
                    {c.direction === 'INBOUND' ? <PhoneIncoming className="size-4" /> : <PhoneOutgoing className="size-4" />}{c.direction === 'INBOUND' ? 'Incoming' : 'Outgoing'}</Link>
                    <span className="block text-xs text-muted-foreground">{c.customer_number ?? '—'}</span></TableCell>
                  <TableCell>{c.customer_name ?? <span className="text-muted-foreground">Unknown</span>}</TableCell>
                  <TableCell>{c.agent_name ?? '—'}</TableCell>
                  <TableCell><CallStatusBadge status={c.status} />{c.has_recording && <span className="ml-1 text-xs text-muted-foreground">· recording</span>}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{c.started_at ? formatDateTime(c.started_at) : formatDateTime(c.created_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(c.ring_seconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDuration(c.talk_seconds)}</TableCell>
                  <TableCell>{c.ticket_id ? <Link className="text-primary hover:underline" to={`/support/tickets/${c.ticket_id}`} onClick={(e) => e.stopPropagation()}>{c.ticket_number}</Link> : '—'}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
      {list.data && list.data.total > 0 && <PaginationBar page={page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={setPage} disabled={list.loading} />}
    </Card>
  )
}
