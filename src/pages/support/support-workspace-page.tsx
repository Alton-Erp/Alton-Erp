import { AlarmClock, CheckCircle2, Clock, Inbox, Smile, Ticket, UserRoundX } from 'lucide-react'
import { Link } from 'react-router-dom'

import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUrlDateRange } from '@/features/drilldown/use-drill'
import { ChannelIcon, ConversationStatusBadge, PresenceControl, PriorityBadge, SlaBadge, TicketStatusBadge } from '@/features/support/support-components'
import { formatMinutes } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { SUPPORT_DATE_RANGE_PRESETS } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchWorkspace } from '@/services/support'

const ACTION_LABELS: Record<string, string> = {
  'tickets.insert': 'Created a ticket', 'tickets.update': 'Updated a ticket', 'conversations.insert': 'Logged a conversation', 'conversations.update': 'Updated a conversation',
  'internal_notes.insert': 'Added an internal note', 'customers.insert': 'Created a customer', 'customers.update': 'Updated a customer', 'attachments.insert': 'Uploaded an attachment',
  'agents.presence': 'Changed presence', 'conversations.tags_set': 'Changed conversation tags',
}

/** /support/workspace — the signed-in agent's presence, assigned work, workload, performance and activity. */
export default function SupportWorkspacePage() {
  const [range, setRange] = useUrlDateRange('this_month')
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const q = useAsync(() => fetchWorkspace(from, to), [from, to])
  const header = <PageHeader title="My workspace" description="Your presence, assigned conversations and tickets, workload, performance and activity."
    breadcrumbs={[{ label: 'Support Centre' }, { label: 'My workspace' }]}
    actions={<><PresenceControl compact /><DateRangeFilter value={range} onChange={setRange} presets={SUPPORT_DATE_RANGE_PRESETS} /></>} />
  if (q.loading && !q.data) return <>{header}<LoadingState variant="cards" rows={6} /></>
  if (q.error || !q.data) return <>{header}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const w = q.data
  if (!w.agent) {
    return <>{header}<Card><EmptyState icon={UserRoundX} title="You are not set up as a support agent"
      description="An administrator can add you in Support Settings → Agents. Until then you can still use the inbox and tickets your role allows." /></Card></>
  }
  const wl = w.workload!
  const pf = w.performance!
  return (
    <>
      {header}
      <section aria-label="Workload" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Open conversations" value={`${formatNumber(wl.open_conversations)} / ${formatNumber(wl.capacity)}`} hint={`${formatNumber(wl.unread)} unread message(s)`} icon={Inbox}
          accent={wl.open_conversations >= wl.capacity ? 'shortage' : 'neutral'} to="/support/inbox?view=MINE" />
        <KpiCard label="Open tickets" value={formatNumber(wl.open_tickets)} icon={Ticket} to={`/support/tickets?agent=${w.agent.id}&open=1`} />
        <KpiCard label="Overdue tickets" value={formatNumber(wl.overdue_tickets)} icon={AlarmClock} accent={wl.overdue_tickets ? 'shortage' : 'neutral'} to={`/support/tickets?agent=${w.agent.id}&sla=OVERDUE`} />
        <KpiCard label="Resolved in the period" value={formatNumber(pf.resolved)} hint={`SLA met ${formatNumber(pf.sla_met)} · breached ${formatNumber(pf.sla_breached)}`} icon={CheckCircle2} accent="available" />
        <KpiCard label="Average first response" value={pf.avg_first_response_minutes === null ? null : formatMinutes(pf.avg_first_response_minutes)} icon={Clock} />
        <KpiCard label="Average resolution" value={pf.avg_resolution_minutes === null ? null : formatMinutes(pf.avg_resolution_minutes)} icon={Clock} />
        <KpiCard label="Customer satisfaction" value={pf.csat_avg === null ? null : `${Number(pf.csat_avg).toFixed(2)} / 5`} icon={Smile} />
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle>My conversations</CardTitle><CardDescription>Assigned to you and not resolved.</CardDescription></div></CardHeader>
          <CardContent>{(w.conversations ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing assigned to you.</p> : (
            <ul className="divide-y text-sm">{w.conversations!.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2"><ChannelIcon channel={c.channel} />
                <Link className="min-w-0 flex-1 truncate text-primary hover:underline" to={`/support/inbox?c=${c.id}`}>{c.customer_name ?? 'Unknown contact'}{c.subject ? ` — ${c.subject}` : ''}</Link>
                {c.unread_count > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{c.unread_count}</span>}
                <ConversationStatusBadge status={c.status} /><PriorityBadge priority={c.priority} /></li>
            ))}</ul>)}</CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle>My tickets</CardTitle><CardDescription>Open, soonest due first.</CardDescription></div></CardHeader>
          <CardContent>{(w.tickets ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No open tickets assigned to you.</p> : (
            <ul className="divide-y text-sm">{w.tickets!.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2"><Link className="font-medium text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link>
                <span className="min-w-0 flex-1 truncate">{t.subject}</span><TicketStatusBadge status={t.status} /><SlaBadge status={t.sla_status} /></li>
            ))}</ul>)}</CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><div><CardTitle>My activity</CardTitle><CardDescription>Your latest 50 actions in the Support Centre.</CardDescription></div></CardHeader>
          <CardContent>{(w.activity ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : (
            <ul className="divide-y text-sm" data-testid="agent-activity">{w.activity!.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-1.5"><span>{ACTION_LABELS[a.action] ?? a.action}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(a.at)}</span></li>
            ))}</ul>)}</CardContent>
        </Card>
      </div>
    </>
  )
}
