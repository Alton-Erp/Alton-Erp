import { useState } from 'react'

import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlDateRange } from '@/features/drilldown/use-drill'
import { formatDuration } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { SUPPORT_DATE_RANGE_PRESETS } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchCallAnalytics } from '@/services/phone'

/** Telephony dashboard: provider-confirmed call data only (Answered = Acefone reported an answer). */
export function CallAnalyticsView() {
  const [range, setRange] = useUrlDateRange('this_month')
  const [group, setGroup] = useState<'day' | 'week' | 'month'>('day')
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const q = useAsync(() => fetchCallAnalytics(from, to, group), [from, to, group])
  const filters = (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <DateRangeFilter value={range} onChange={setRange} presets={SUPPORT_DATE_RANGE_PRESETS} />
      <Select value={group} onValueChange={(v) => setGroup(v as typeof group)}>
        <SelectTrigger aria-label="Group by" className="h-9 w-36"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="day">Daily</SelectItem><SelectItem value="week">Weekly</SelectItem><SelectItem value="month">Monthly</SelectItem></SelectContent>
      </Select>
    </div>
  )
  if (q.loading && !q.data) return <>{filters}<LoadingState variant="cards" rows={4} /></>
  if (q.error || !q.data) return <>{filters}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const a = q.data
  const t = a.totals
  const kpis: [string, string, string?][] = [
    ['Inbound calls', formatNumber(t.inbound)], ['Outbound calls', formatNumber(t.outbound)], ['Answered', formatNumber(t.answered), 'Acefone reported an answer'],
    ['Missed', formatNumber(t.missed)], ['Failed', formatNumber(t.failed)], ['Average call duration', formatDuration(t.avg_duration_seconds)],
    ['Average answer time', formatDuration(t.avg_answer_seconds)], ['Unconfirmed requests', formatNumber(t.unconfirmed_requests), 'Click-to-Call requests Acefone never reported on'],
  ]
  return (
    <div data-testid="call-analytics">
      {filters}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{kpis.map(([label, value, hint]) => (
        <Card key={label} className="gap-1 p-4" title={hint}><p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-semibold tabular-nums" data-testid={`kpi-${label}`}>{value}</p></Card>
      ))}</div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle>{group === 'day' ? 'Daily' : group === 'week' ? 'Weekly' : 'Monthly'} calls</CardTitle><CardDescription>{a.from} to {a.to}</CardDescription></div></CardHeader>
          <CardContent className="overflow-x-auto"><Table data-testid="call-series"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Period</TableHead><TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead><TableHead className="text-right">Answered</TableHead><TableHead className="text-right">Missed</TableHead><TableHead className="text-right">Failed</TableHead></TableRow></TableHeader>
            <TableBody>{a.series.map((s) => <TableRow key={s.period}><TableCell>{s.period}</TableCell><TableCell className="text-right tabular-nums">{s.inbound}</TableCell>
              <TableCell className="text-right tabular-nums">{s.outbound}</TableCell><TableCell className="text-right tabular-nums">{s.answered}</TableCell><TableCell className="text-right tabular-nums">{s.missed}</TableCell>
              <TableCell className="text-right tabular-nums">{s.failed}</TableCell></TableRow>)}
              {!a.series.length && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No calls in this period.</TableCell></TableRow>}</TableBody></Table></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Agent-wise calls</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto"><Table data-testid="call-agents"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Agent</TableHead><TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead><TableHead className="text-right">Answered</TableHead><TableHead className="text-right">Missed</TableHead><TableHead className="text-right">Avg duration</TableHead></TableRow></TableHeader>
            <TableBody>{a.agents.map((g) => <TableRow key={g.agent}><TableCell>{g.agent}</TableCell><TableCell className="text-right tabular-nums">{g.inbound}</TableCell>
              <TableCell className="text-right tabular-nums">{g.outbound}</TableCell><TableCell className="text-right tabular-nums">{g.answered}</TableCell><TableCell className="text-right tabular-nums">{g.missed}</TableCell>
              <TableCell className="text-right tabular-nums">{formatDuration(g.avg_duration_seconds)}</TableCell></TableRow>)}</TableBody></Table></CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><div><CardTitle>Customer-wise call history</CardTitle><CardDescription>Top 50 callers in the period; unknown numbers are grouped as Unknown caller.</CardDescription></div></CardHeader>
          <CardContent className="overflow-x-auto"><Table data-testid="call-customers"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Customer</TableHead><TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Answered</TableHead><TableHead className="text-right">Missed</TableHead><TableHead>Last call</TableHead></TableRow></TableHeader>
            <TableBody>{a.customers.map((c) => <TableRow key={c.customer_id ?? 'unknown'}><TableCell>{c.customer}</TableCell><TableCell className="text-right tabular-nums">{c.calls}</TableCell>
              <TableCell className="text-right tabular-nums">{c.answered}</TableCell><TableCell className="text-right tabular-nums">{c.missed}</TableCell><TableCell className="text-xs">{formatDateTime(c.last_call_at)}</TableCell></TableRow>)}</TableBody></Table></CardContent>
        </Card>
      </div>
    </div>
  )
}
