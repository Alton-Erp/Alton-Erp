import { Download, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlDateRange } from '@/features/drilldown/use-drill'
import { downloadSheets } from '@/features/products/spreadsheet'
import { CHANNEL_LABELS, PRESENCE_META, PRIORITY_META, TICKET_STATUS_META, formatDuration, formatMinutes, type Priority, type TicketChannel, type TicketStatus } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { SUPPORT_DATE_RANGE_PRESETS } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { fetchSupportReports, type SupportReports } from '@/services/support'
import { UnifiedReportsSection } from '@/features/support/support-unified-components'

function exportSheets(r: SupportReports) {
  const k = r.kpis
  return [
    { name: 'Summary', rows: [['Figure', 'Value'], ['Period', `${r.from} to ${r.to}`], ['Tickets created', k.total_tickets], ['Tickets resolved', k.resolved_tickets],
      ['Open tickets (now)', k.open_tickets], ['Unassigned open tickets (now)', k.unassigned_tickets], ['Waiting for customer (now)', k.pending_customer], ['Overdue SLA (now)', k.overdue_tickets],
      ['Average first response (minutes)', k.avg_first_response_minutes ?? ''], ['Average resolution (minutes)', k.avg_resolution_minutes ?? ''],
      ['SLA met', r.sla.met], ['SLA breached', r.sla.breached], ['Reopened tickets', r.reopened], ['Satisfaction average', k.csat_average ?? ''], ['Satisfaction ratings', k.csat_responses],
      ['Inbound calls', r.calls.inbound], ['Outbound calls', r.calls.outbound], ['Answered calls', r.calls.answered], ['Missed calls', r.calls.missed],
      ['Average answered call (seconds)', r.calls.avg_duration_seconds ?? ''], ['WhatsApp in / out', `${r.messages.whatsapp_inbound} / ${r.messages.whatsapp_outbound}`],
      ['Emails in / out', `${r.messages.email_inbound} / ${r.messages.email_outbound}`]] as (string | number)[][] },
    { name: 'By channel', rows: [['Channel', 'Tickets'], ...r.by_channel.map((x) => [CHANNEL_LABELS[x.channel as TicketChannel] ?? x.channel, Number(x.tickets)])] },
    { name: 'By category', rows: [['Category', 'Tickets'], ...r.by_category.map((x) => [x.category, Number(x.tickets)])] },
    { name: 'By priority', rows: [['Priority', 'Tickets'], ...r.by_priority.map((x) => [PRIORITY_META[x.priority as Priority]?.label ?? x.priority, Number(x.tickets)])] },
    { name: 'By status', rows: [['Status', 'Tickets'], ...r.by_status.map((x) => [TICKET_STATUS_META[x.status as TicketStatus]?.label ?? x.status, Number(x.tickets)])] },
    { name: 'Daily', rows: [['Day', 'Created', 'Resolved'], ...r.daily.map((x) => [x.day, Number(x.created), Number(x.resolved)])] },
    { name: 'Agents', rows: [['Agent', 'Resolved', 'Average resolution (minutes)', 'SLA met', 'SLA breached', 'Open tickets', 'Open conversations'],
      ...(r.agents ?? []).map((a) => [a.name, Number(a.resolved), a.avg_resolution_minutes ?? '', Number(a.sla_met), Number(a.sla_breached), Number(a.assigned_open), Number(a.open_conversations)])] },
    { name: 'Satisfaction', rows: [['Rating', 'Tickets'], ...r.csat.map((x) => [x.rating, Number(x.tickets)])] },
  ]
}

/** /support/reports — support reports for the period, with Excel export (support.view_reports). */
export default function SupportReportsPage() {
  const [range, setRange] = useUrlDateRange('this_month')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const q = useAsync(() => fetchSupportReports(from, to), [from, to, refresh])
  const [exporting, setExporting] = useState(false)
  const r = q.data
  const header = (
    <PageHeader actions={<>
      <DateRangeFilter value={range} onChange={setRange} presets={SUPPORT_DATE_RANGE_PRESETS} />
      <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={q.loading ? 'animate-spin' : undefined} /></Button>
      <Button variant="outline" disabled={!r || exporting} onClick={() => { if (!r) return; setExporting(true); void downloadSheets(exportSheets(r), `support-report-${from}-${to}`, 'xlsx').finally(() => setExporting(false)) }}>
        {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export Excel</Button>
    </>} />
  )
  if (q.loading && !r) return <>{header}<LoadingState variant="cards" rows={6} /></>
  if (q.error || !r) return <>{header}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const bar = (rows: { label: string; value: number }[]) => <HorizontalBarChart seriesName="Tickets" labelWidth={150} data={rows} valueFormatter={formatNumber} />
  const cat = r.by_category.map((x) => ({ label: x.category, value: Number(x.tickets) }))
  const pri = r.by_priority.map((x) => ({ label: PRIORITY_META[x.priority as Priority]?.label ?? x.priority, value: Number(x.tickets) }))
  const ch = r.by_channel.map((x) => ({ label: CHANNEL_LABELS[x.channel as TicketChannel] ?? x.channel, value: Number(x.tickets) }))
  const slaPct = Number(r.sla.met) + Number(r.sla.breached) ? Math.round((Number(r.sla.met) / (Number(r.sla.met) + Number(r.sla.breached))) * 100) : null
  return (
    <>
      {header}
      <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Summary">
        {[['Tickets created', formatNumber(r.kpis.total_tickets)], ['Tickets resolved', formatNumber(r.kpis.resolved_tickets)],
          ['SLA compliance', slaPct === null ? '—' : `${slaPct}%`], ['Reopened', formatNumber(r.reopened)],
          ['Average first response', formatMinutes(r.kpis.avg_first_response_minutes)], ['Average resolution', formatMinutes(r.kpis.avg_resolution_minutes)],
          ['Calls answered / missed', `${formatNumber(r.calls.answered)} / ${formatNumber(r.calls.missed)}`], ['Satisfaction', r.kpis.csat_average === null ? '—' : `${Number(r.kpis.csat_average).toFixed(2)} / 5 (${r.kpis.csat_responses})`],
        ].map(([l, v]) => <Card key={l} className="gap-1 p-4"><p className="text-sm text-muted-foreground">{l}</p><p className="text-xl font-semibold tabular-nums">{v}</p></Card>)}
      </section>
      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="By channel" isEmpty={ch.length === 0} emptyMessage="No tickets in this period." table={{ headers: ['Channel', 'Tickets'], rows: ch.map((x) => [x.label, x.value]) }}>{bar(ch)}</ChartCard>
        <ChartCard title="By category" isEmpty={cat.length === 0} emptyMessage="No tickets in this period." table={{ headers: ['Category', 'Tickets'], rows: cat.map((x) => [x.label, x.value]) }}>{bar(cat)}</ChartCard>
        <ChartCard title="By priority" isEmpty={pri.length === 0} emptyMessage="No tickets in this period." table={{ headers: ['Priority', 'Tickets'], rows: pri.map((x) => [x.label, x.value]) }}>{bar(pri)}</ChartCard>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Agent performance</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">{(r.agents ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No support agents are set up yet.</p> : (
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Agent</TableHead><TableHead>Presence</TableHead><TableHead className="text-right">Resolved</TableHead>
              <TableHead className="text-right">Avg resolution</TableHead><TableHead className="text-right">SLA met / breached</TableHead><TableHead className="text-right">Open</TableHead></TableRow></TableHeader>
              <TableBody>{r.agents!.map((a) => (
                <TableRow key={a.agent_id}><TableCell className="font-medium">{a.name}{!a.is_active && ' (inactive)'}</TableCell><TableCell>{PRESENCE_META[a.presence]?.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(a.resolved)}</TableCell><TableCell className="text-right">{formatMinutes(a.avg_resolution_minutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(a.sla_met)} / {formatNumber(a.sla_breached)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(a.assigned_open)} tickets · {formatNumber(a.open_conversations)} conv.</TableCell></TableRow>
              ))}</TableBody></Table>)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Channels and satisfaction</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>Calls: {formatNumber(r.calls.inbound)} incoming, {formatNumber(r.calls.outbound)} outgoing; {formatNumber(r.calls.answered)} answered, {formatNumber(r.calls.missed)} missed;
              average answered call {formatDuration(r.calls.avg_duration_seconds)}.</p>
            <p>WhatsApp: {formatNumber(r.messages.whatsapp_inbound)} received, {formatNumber(r.messages.whatsapp_outbound)} sent or logged.</p>
            <p>Email: {formatNumber(r.messages.email_inbound)} received, {formatNumber(r.messages.email_outbound)} sent or logged.</p>
            <div><p className="mb-1 font-medium">Satisfaction ratings recorded in the period</p>
              {r.csat.length === 0 ? <p className="text-muted-foreground">No ratings recorded.</p>
                : <ul className="flex flex-wrap gap-3">{[5, 4, 3, 2, 1].map((n) => <li key={n} className="tabular-nums">{n}★ {formatNumber(Number(r.csat.find((x) => Number(x.rating) === n)?.tickets ?? 0))}</li>)}</ul>}</div>
          </CardContent>
        </Card>
      </div>
      <div className="mt-4"><UnifiedReportsSection from={from} to={to} /></div>
    </>
  )
}
