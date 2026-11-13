import { Download, Loader2, Plus, Search, Ticket } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { downloadSheets } from '@/features/products/spreadsheet'
import { ChannelLabel, PresenceControl, PriorityBadge, SlaBadge, TicketStatusBadge } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { TicketFormDialog } from '@/features/support/support-dialogs'
import {
  CHANNEL_LABELS, OPEN_TICKET_STATUSES, PRIORITIES, PRIORITY_META, SLA_META, TICKET_EXPORT_HEADERS, TICKET_STATUSES, TICKET_STATUS_META, ticketExportRows,
  type TicketChannel,
} from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import { fetchAgents, fetchTickets, type TicketFilters } from '@/services/support'

const PAGE_SIZE = 25
const ALL = 'all'

/** /support/tickets — tickets with server-side filters, search, sort and pagination; export for support.manage_tickets. */
export default function SupportTicketsPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const perms = useSupportPermissions()
  const get = (k: string) => params.get(k) ?? ''
  const setParam = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (!v || v === ALL) n.delete(k); else n.set(k, v); n.delete('page'); return n }, { replace: true })
  const page = Math.max(0, Number(get('page') || 0))
  const [search, setSearch] = useState(get('q'))
  useEffect(() => { const t = setTimeout(() => { if (search !== get('q')) setParam('q', search.trim()) }, 300); return () => clearTimeout(t) }, [search]) // eslint-disable-line react-hooks/exhaustive-deps
  const [refresh, setRefresh] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])

  const filters: TicketFilters = {
    status: get('status') || undefined, statuses: get('open') ? OPEN_TICKET_STATUSES : undefined, priority: get('priority') || undefined,
    channel: get('channel') || undefined, agent_id: get('agent') || undefined, unassigned: get('unassigned') === '1' || undefined, sla: get('sla') || undefined,
    from: get('from') || undefined, to: get('to') || undefined, search: get('q') || undefined, sort: (get('sort') || 'created_desc') as TicketFilters['sort'],
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  }
  const key = JSON.stringify(filters)
  const list = useAsync(() => fetchTickets(filters), [key, refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  const activeFilters = ['status', 'open', 'priority', 'channel', 'agent', 'unassigned', 'sla', 'from', 'to', 'q'].filter((k) => params.get(k))

  const exportAll = async () => {
    setExporting(true); setExportError(null)
    try {
      const all = await fetchTickets({ ...filters, limit: 5000, offset: 0 })
      await downloadSheets([{ name: 'Tickets', rows: [[...TICKET_EXPORT_HEADERS], ...ticketExportRows(all.rows, (iso) => formatDateTime(iso))] }], `support-tickets-${toIsoDate(new Date())}`, 'xlsx')
    } catch (e) {
      setExportError(describeDataError(e))
    } finally {
      setExporting(false)
    }
  }

  const filterSelect = (k: string, label: string, options: [string, string][], width = 'w-40') => (
    <Select value={get(k) || ALL} onValueChange={(v) => setParam(k, v)}>
      <SelectTrigger aria-label={label} className={`h-9 ${width}`}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value={ALL}>{`All ${label.toLowerCase()}`}</SelectItem>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
    </Select>
  )

  return (
    <>
      <PageHeader actions={<>
        <PresenceControl compact />
        {perms.manageTickets && <Button variant="outline" disabled={exporting} onClick={() => void exportAll()}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export</Button>}
        {perms.manageTickets && <Button onClick={() => setCreateOpen(true)} data-testid="new-ticket"><Plus /> New ticket</Button>}
      </>} />
      {exportError && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{exportError}</p>}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-56 flex-1">
            <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search tickets" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticket number, subject, customer, phone, email or category" />
          </div>
          {filterSelect('status', 'Statuses', TICKET_STATUSES.map((s) => [s, TICKET_STATUS_META[s].label]), 'w-48')}
          {filterSelect('priority', 'Priorities', PRIORITIES.map((p) => [p, PRIORITY_META[p].label]))}
          {filterSelect('channel', 'Channels', (['PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL'] as TicketChannel[]).map((c) => [c, CHANNEL_LABELS[c]]))}
          {filterSelect('sla', 'SLA states', Object.entries(SLA_META).map(([k, m]) => [k, m.label]))}
          {filterSelect('agent', 'Agents', (agents.data ?? []).map((a) => [a.id, a.display_name]))}
          <Select value={get('sort') || 'created_desc'} onValueChange={(v) => setParam('sort', v === 'created_desc' ? '' : v)}>
            <SelectTrigger aria-label="Sort" className="h-9 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="created_desc">Newest first</SelectItem><SelectItem value="created_asc">Oldest first</SelectItem>
              <SelectItem value="due_asc">Due soonest</SelectItem><SelectItem value="priority">Highest priority</SelectItem><SelectItem value="updated_desc">Recently updated</SelectItem>
            </SelectContent>
          </Select>
          {activeFilters.length > 0 && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setParams(new URLSearchParams(), { replace: true }) }}>Clear filters</Button>}
        </div>
        {(get('open') || get('unassigned') || get('from')) && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground">
            {[get('open') && 'Open tickets only', get('unassigned') && 'unassigned', get('from') && `created ${get('from')} to ${get('to') || 'today'}`].filter(Boolean).join(' · ')}
          </p>
        )}
        {list.loading && !list.data ? <LoadingState rows={8} />
          : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
          : !list.data || list.data.rows.length === 0 ? (
            <EmptyState icon={Ticket} title={activeFilters.length ? 'No ticket matches these filters' : 'No tickets yet'}
              description={activeFilters.length ? 'Change or clear the filters.' : 'Create a ticket here or from a conversation in the inbox.'} />
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="tickets-table">
                <TableHeader><TableRow className="hover:bg-transparent">
                  <TableHead>Ticket</TableHead><TableHead>Subject</TableHead><TableHead>Customer</TableHead><TableHead>Channel</TableHead><TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead><TableHead>SLA</TableHead><TableHead>Agent</TableHead><TableHead>Created</TableHead><TableHead>Due</TableHead>
                </TableRow></TableHeader>
                <TableBody>{list.data.rows.map((t) => (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => navigate(`/support/tickets/${t.id}`)}>
                    <TableCell className="font-medium whitespace-nowrap"><Link to={`/support/tickets/${t.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{t.ticket_number}</Link>
                      {t.merged_into && <span className="block text-[11px] text-muted-foreground">merged into {t.merged_into}</span>}</TableCell>
                    <TableCell className="max-w-72 truncate">{t.subject}{t.category && <span className="block text-xs text-muted-foreground">{t.category}{t.subcategory ? ` / ${t.subcategory}` : ''}</span>}</TableCell>
                    <TableCell className="max-w-48 truncate">{t.customer_name ?? t.customer_phone ?? t.customer_email ?? '—'}</TableCell>
                    <TableCell><ChannelLabel channel={t.channel} /></TableCell>
                    <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                    <TableCell><TicketStatusBadge status={t.status} /></TableCell>
                    <TableCell><SlaBadge status={t.sla_status} /></TableCell>
                    <TableCell className="whitespace-nowrap">{t.assigned_agent ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.created_at)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{t.due_at ? formatDateTime(t.due_at) : '—'}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        {list.data && list.data.total > 0 && (
          <PaginationBar page={page} pageSize={PAGE_SIZE} total={list.data.total} disabled={list.loading}
            onPageChange={(p) => setParams((prev) => { const n = new URLSearchParams(prev); if (p) n.set('page', String(p)); else n.delete('page'); return n }, { replace: true })} />
        )}
      </Card>
      <TicketFormDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(r) => { setRefresh((n) => n + 1); navigate(`/support/tickets/${r.id}`) }} />
    </>
  )
}
