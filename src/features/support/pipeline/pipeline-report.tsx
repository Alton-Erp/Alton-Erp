import { useState } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OutcomeIcon } from '@/features/support/pipeline/pipeline-board'
import { hoursText } from '@/features/support/pipeline/pipeline-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchPipelineReport, fetchPipelines } from '@/services/pipelines'

/**
 * Pipeline reports on Support Reports: tickets by stage, open vs closed, positive vs negative outcomes, time in each
 * stage (from the stage history), awaiting action, SLA overdue, agents by stage, product complaints, stage
 * conversion and reopened tickets. Hidden before the database update or without pipeline access.
 */
export function PipelineReportSection({ from, to }: { from: string; to: string }) {
  const pipelines = useAsync(() => fetchPipelines().catch(() => null), [])
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const chosen = pipelineId ?? pipelines.data?.pipelines.find((p) => p.is_default)?.id ?? null
  const q = useAsync(() => (chosen ? fetchPipelineReport(chosen, from, to) : Promise.resolve(null)), [chosen, from, to])
  if (!pipelines.data || !chosen) return null
  const r = q.data
  const stages = r?.by_stage ?? []
  return (
    <Card data-testid="pipeline-report">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div><CardTitle>Pipeline</CardTitle><CardDescription>Stage counts are current; time in stage and reopenings come from the stage history. Conversion = share of the period’s new tickets that reached the stage.</CardDescription></div>
        <Select value={chosen} onValueChange={setPipelineId}>
          <SelectTrigger className="w-56" aria-label="Pipeline for the report"><SelectValue /></SelectTrigger>
          <SelectContent>{pipelines.data.pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.error && <p role="alert" className="text-sm text-red-700">{describeDataError(q.error)}</p>}
        {r && <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {([['Open', r.open], ['Closed', r.closed], ['Positive', r.positive], ['Negative', r.negative], ['Awaiting action', r.awaiting_action], ['SLA overdue', r.overdue],
              ['Reopened after closure', r.reopened_tickets]] as const).map(([l, v]) => (
              <div key={l} className="rounded-lg border p-3" data-testid={`pr-${l}`}><p className="text-xs text-muted-foreground">{l}</p><p className="text-lg font-semibold tabular-nums">{v}</p></div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="pipeline-report-stages">
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Stage</TableHead><TableHead className="text-right">Tickets now</TableHead>
                <TableHead className="text-right">Average time in stage</TableHead><TableHead className="text-right">Reached (period)</TableHead><TableHead className="text-right">Conversion</TableHead></TableRow></TableHeader>
              <TableBody>{stages.map((s) => (
                <TableRow key={s.stage_id}>
                  <TableCell><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.stage_name}<OutcomeIcon outcome={s.outcome_type} />
                    {!s.is_active && <span className="text-xs text-muted-foreground">(inactive)</span>}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{s.tickets}</TableCell>
                  <TableCell className="text-right tabular-nums">{hoursText(s.avg_hours)}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.entered}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.conversion_percent === null ? '—' : `${s.conversion_percent}%`}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto">
              <p className="mb-1 text-sm font-medium">Agents by stage</p>
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Agent</TableHead>{stages.map((s) => <TableHead key={s.stage_id} className="text-right">{s.stage_name}</TableHead>)}</TableRow></TableHeader>
                <TableBody>{r.by_agent.map((a) => (
                  <TableRow key={a.agent_id ?? 'none'}><TableCell>{a.agent}</TableCell>{stages.map((s) => <TableCell key={s.stage_id} className="text-right tabular-nums">{a.stages[s.stage_id] ?? 0}</TableCell>)}</TableRow>
                ))}</TableBody>
              </Table>
            </div>
            {r.by_product && (
              <div className="overflow-x-auto">
                <p className="mb-1 text-sm font-medium">Product-wise complaints (period)</p>
                {r.by_product.length === 0 ? <p className="text-sm text-muted-foreground">No products linked to tickets in this period.</p> : (
                  <Table>
                    <TableHeader><TableRow className="hover:bg-transparent"><TableHead>SKU</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Tickets</TableHead><TableHead className="text-right">Closed negative</TableHead></TableRow></TableHeader>
                    <TableBody>{r.by_product.map((p) => (
                      <TableRow key={p.product_id}><TableCell className="font-mono text-xs">{p.sku}</TableCell><TableCell>{p.product_name}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.tickets}</TableCell><TableCell className="text-right tabular-nums">{p.negative}</TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                )}
              </div>
            )}
          </div>
        </>}
      </CardContent>
    </Card>
  )
}
