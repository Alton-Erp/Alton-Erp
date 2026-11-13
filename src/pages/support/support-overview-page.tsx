import {
  AlarmClock, CheckCircle2, Clock, Hourglass, Inbox, Mail, MessageCircle, PhoneCall, PhoneMissed, RefreshCw, Smile, Ticket, UserX,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { DonutChart } from '@/components/charts/donut-chart'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useUrlDateRange } from '@/features/drilldown/use-drill'
import { ChannelStatusStrip, PresenceControl } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CHANNEL_LABELS, PRESENCE_META, TICKET_STATUS_META, formatMinutes, type TicketChannel, type TicketStatus } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { SUPPORT_DATE_RANGE_PRESETS } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchSupportOverview } from '@/services/support'

/** /support/overview — Support Centre dashboard. */
export default function SupportOverviewPage() {
  const [range, setRange] = useUrlDateRange('this_month')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const ov = useAsync(() => fetchSupportOverview(from, to), [from, to, refresh])
  const perms = useSupportPermissions()
  const navigate = useNavigate()
  const d = ov.data
  const q = (params: Record<string, string>) => `/support/tickets?${new URLSearchParams(params).toString()}`

  const header = (
    <PageHeader actions={<>
      <PresenceControl />
      <DateRangeFilter value={range} onChange={setRange} presets={SUPPORT_DATE_RANGE_PRESETS} />
      <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={ov.loading ? 'animate-spin' : undefined} /></Button>
    </>} />
  )
  if (ov.loading && !d) return <>{header}<LoadingState variant="cards" rows={8} /></>
  if (ov.error || !d) return <>{header}<Card><ErrorState message={describeDataError(ov.error)} onRetry={ov.reload} /></Card></>
  const k = d.kpis
  const statusRows = d.by_status.map((s) => ({ label: TICKET_STATUS_META[s.status as TicketStatus]?.label ?? s.status, value: Number(s.tickets), status: s.status }))
  const channelRows = d.by_channel.map((c) => ({ label: CHANNEL_LABELS[c.channel as TicketChannel] ?? c.channel, value: Number(c.tickets), channel: c.channel }))
  const daily = d.daily.map((x) => ({ label: x.day.slice(5), a: Number(x.created), b: Number(x.resolved) }))
  const slaRows = [
    { label: 'Met', value: Number(d.sla.met), color: TONE_FILL.success },
    { label: 'Breached', value: Number(d.sla.breached), color: TONE_FILL.danger },
    { label: 'No SLA', value: Number(d.sla.no_sla), color: TONE_FILL.neutral },
  ].filter((x) => x.value > 0)
  const slaTotal = Number(d.sla.met) + Number(d.sla.breached)

  return (
    <>
      {header}
      <p className="mb-3 text-xs text-muted-foreground">Ticket figures for {from === to ? from : `${from} to ${to}`}; open, unassigned, waiting and overdue tickets are as of {formatDateTime(d.generated_at)}.</p>
      <div className="mb-4"><ChannelStatusStrip channels={d.channels} /></div>
      <section aria-label="Support figures" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard testId="sk-total" label="Total tickets" value={formatNumber(k.total_tickets)} hint="Created in the period" icon={Ticket} to={q({ from, to })} />
        <KpiCard testId="sk-open" label="Open tickets" value={formatNumber(k.open_tickets)} hint="Not resolved or closed" icon={Inbox} accent="pending" to={q({ open: '1' })} />
        <KpiCard testId="sk-unassigned" label="Unassigned tickets" value={formatNumber(k.unassigned_tickets)} hint="Open, no agent" icon={UserX} accent={k.unassigned_tickets ? 'shortage' : 'neutral'} to={q({ unassigned: '1', open: '1' })} />
        <KpiCard testId="sk-waiting" label="Pending customer responses" value={formatNumber(k.pending_customer)} hint="Waiting for the customer" icon={Hourglass} to={q({ status: 'WAITING_CUSTOMER' })} />
        <KpiCard testId="sk-resolved" label="Resolved tickets" value={formatNumber(k.resolved_tickets)} hint="Resolved in the period" icon={CheckCircle2} accent="available" />
        <KpiCard testId="sk-overdue" label="Overdue SLA tickets" value={formatNumber(k.overdue_tickets)} hint="Past a response or resolution target" icon={AlarmClock} accent={k.overdue_tickets ? 'shortage' : 'neutral'} to={q({ sla: 'OVERDUE' })} />
        <KpiCard testId="sk-calls-today" label="Today’s incoming calls" value={formatNumber(k.calls_today)} hint="Received and logged today" icon={PhoneCall} to="/support/calls" />
        <KpiCard testId="sk-missed" label="Missed calls" value={formatNumber(k.missed_calls)} hint="Incoming, in the period" icon={PhoneMissed} accent={k.missed_calls ? 'shortage' : 'neutral'} to="/support/calls" />
        <KpiCard testId="sk-whatsapp" label="WhatsApp conversations" value={formatNumber(k.whatsapp_conversations)} hint="Started in the period" icon={MessageCircle} to="/support/whatsapp" />
        <KpiCard testId="sk-emails" label="Incoming emails" value={formatNumber(k.incoming_emails)} hint="Received in the period" icon={Mail} to="/support/emails" />
        <KpiCard testId="sk-first-response" label="Average first response" value={k.avg_first_response_minutes === null ? null : formatMinutes(k.avg_first_response_minutes)} hint="Tickets created in the period" icon={Clock} />
        <KpiCard testId="sk-resolution" label="Average resolution time" value={k.avg_resolution_minutes === null ? null : formatMinutes(k.avg_resolution_minutes)} hint="Tickets resolved in the period" icon={Clock} />
        <KpiCard testId="sk-csat" label="Customer satisfaction" value={k.csat_average === null ? null : `${Number(k.csat_average).toFixed(2)} / 5`}
          hint={k.csat_responses ? `${formatNumber(k.csat_responses)} rating(s) recorded in the period` : 'No ratings recorded in the period'} icon={Smile} accent="available" />
      </section>

      <section aria-label="Charts" className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Tickets by channel" description="Created in the period" isEmpty={channelRows.length === 0} emptyMessage="No tickets in this period."
          table={{ headers: ['Channel', 'Tickets'], rows: channelRows.map((r) => [r.label, r.value]), links: channelRows.map((r) => q({ channel: r.channel, from, to })) }}
          drillHint="Click a bar to open those tickets.">
          <HorizontalBarChart seriesName="Tickets" data={channelRows} valueFormatter={formatNumber} onSelect={(i) => navigate(q({ channel: channelRows[i].channel, from, to }))} />
        </ChartCard>
        <ChartCard title="Ticket status" description="Tickets created in the period, by their current status" isEmpty={statusRows.length === 0} emptyMessage="No tickets in this period."
          table={{ headers: ['Status', 'Tickets'], rows: statusRows.map((r) => [r.label, r.value]), links: statusRows.map((r) => q({ status: r.status, from, to })) }}>
          <HorizontalBarChart seriesName="Tickets" labelWidth={160} data={statusRows} valueFormatter={formatNumber} onSelect={(i) => navigate(q({ status: statusRows[i].status, from, to }))} />
        </ChartCard>
        <ChartCard title="Daily ticket volume" description="Created and resolved per day" isEmpty={daily.every((x) => !x.a && !x.b)} emptyMessage={d.daily.length ? 'No tickets in this period.' : 'Choose a period of up to a year for the daily chart.'}
          table={{ headers: ['Day', 'Created', 'Resolved'], rows: daily.map((x) => [x.label, x.a, x.b]) }}>
          <PairedBarChart aName="Created" bName="Resolved" aColor={CHART_COLORS.single} bColor={TONE_FILL.success} data={daily} />
        </ChartCard>
        <ChartCard title="SLA compliance" description={slaTotal ? `${Math.round((Number(d.sla.met) / slaTotal) * 100)}% of tickets resolved in the period met their target` : 'Tickets resolved in the period'}
          isEmpty={slaRows.length === 0} emptyMessage="No tickets resolved in this period." height={240}
          table={{ headers: ['SLA', 'Tickets'], rows: slaRows.map((r) => [r.label, r.value]) }}>
          <DonutChart seriesName="Tickets" data={slaRows} valueFormatter={formatNumber} />
        </ChartCard>
        <ChartCard title="Resolution time" description="Tickets resolved in the period" isEmpty={d.resolution_buckets.length === 0} emptyMessage="No tickets resolved in this period."
          table={{ headers: ['Resolution time', 'Tickets'], rows: d.resolution_buckets.map((b) => [b.bucket, Number(b.tickets)]) }}>
          <HorizontalBarChart seriesName="Tickets" data={d.resolution_buckets.map((b) => ({ label: b.bucket, value: Number(b.tickets) }))} valueFormatter={formatNumber} />
        </ChartCard>
        {perms.reports && d.agents ? (
          <ChartCard title="Agent performance" description="Tickets resolved in the period; open work as of now" isEmpty={d.agents.length === 0} emptyMessage="No support agents are set up yet."
            table={{ headers: ['Agent', 'Presence', 'Resolved', 'Avg resolution', 'SLA met', 'SLA breached', 'Open tickets', 'Open conversations'],
              rows: d.agents.map((a) => [a.name, PRESENCE_META[a.presence]?.label ?? a.presence, Number(a.resolved), formatMinutes(a.avg_resolution_minutes), Number(a.sla_met), Number(a.sla_breached), Number(a.assigned_open), Number(a.open_conversations)]) }}>
            <PairedBarChart aName="Resolved" bName="Open tickets" aColor={TONE_FILL.success} bColor={CHART_COLORS.single}
              data={d.agents.map((a) => ({ label: a.name, a: Number(a.resolved), b: Number(a.assigned_open) }))} />
          </ChartCard>
        ) : (
          <Card className="flex items-center justify-center p-6 text-sm text-muted-foreground" data-testid="agent-performance-restricted">Agent performance is shown to roles with support reports access.</Card>
        )}
      </section>
    </>
  )
}
