import { GitBranch, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { OutcomeIcon } from '@/features/support/pipeline/pipeline-board'
import { ReasonDialog } from '@/features/support/support-dialogs'
import { TICKET_STATUS_META, type TicketStatus } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchStageInfo, moveTicketStage } from '@/services/pipelines'

const SOURCE: Record<string, string> = { CREATED: 'created', MOVE: 'moved', STATUS_CHANGE: 'status changed', STAGE_DEACTIVATED: 'stage deactivated', MIGRATION: 'placed by status' }
const statusLabel = (s: string | null) => (s ? TICKET_STATUS_META[s as TicketStatus]?.label ?? s : '—')

/** Pipeline stage of a ticket on its page: move it (same rules as the board) and see every stage change. */
export function TicketStageCard({ ticketId, refreshKey, onMoved }: { ticketId: string; refreshKey: unknown; onMoved: (notice: string) => void }) {
  const q = useAsync(() => fetchStageInfo(ticketId), [ticketId, refreshKey])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reopenTo, setReopenTo] = useState<string | null>(null)
  if (!q.data || !q.data.pipeline) return null
  const info = q.data
  const current = info.stages.find((s) => s.id === info.stage_id)
  const move = async (to: string, note: string | null) => {
    setBusy(true); setError(null)
    try {
      await moveTicketStage(ticketId, to, info.stage_id, note)
      onMoved(`Moved to ${info.stages.find((s) => s.id === to)?.stage_name}.`)
      q.reload()
    } catch (e) {
      setError(describeDataError(e)); q.reload()
      throw e
    } finally {
      setBusy(false)
    }
  }
  const choose = (to: string) => {
    const target = info.stages.find((s) => s.id === to)
    if (current?.stage_type === 'CLOSED' && target?.stage_type === 'OPEN') { setReopenTo(to); return }
    void move(to, null).catch(() => {})
  }
  return (
    <Card data-testid="ticket-stage">
      <CardHeader><div><CardTitle className="flex items-center gap-2"><GitBranch className="size-4" />Pipeline</CardTitle><CardDescription>{info.pipeline!.name}</CardDescription></div></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Select value={info.stage_id ?? ''} onValueChange={choose} disabled={!info.can_move || busy}>
            <SelectTrigger className="w-full" aria-label="Pipeline stage" data-testid="ticket-stage-select"><SelectValue /></SelectTrigger>
            <SelectContent>{info.stages.map((s) => (
              <SelectItem key={s.id} value={s.id} disabled={!s.is_active}><span className="size-2 rounded-full" style={{ background: s.color }} />{s.stage_name}{s.stage_type === 'CLOSED' ? ' (closed)' : ''}</SelectItem>
            ))}</SelectContent>
          </Select>
          {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Saving" />}
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <ol className="space-y-1.5 border-t pt-3 text-xs" aria-label="Stage history" data-testid="stage-history">
          {info.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-1.5">
              <span className="text-muted-foreground">{formatDateTime(h.changed_at)}</span>
              <span className="font-medium">{h.from_stage ? `${h.from_stage} → ${h.to_stage}` : h.to_stage}</span><OutcomeIcon outcome={h.outcome_type} />
              <span className="text-muted-foreground">({SOURCE[h.source] ?? h.source}{h.from_status && h.from_status !== h.to_status ? `, ${statusLabel(h.from_status)} → ${statusLabel(h.to_status)}` : ''}{h.changed_by ? ` by ${h.changed_by}` : ''})</span>
              {h.notes && <span className="w-full text-muted-foreground">{h.notes}</span>}
            </li>
          ))}
        </ol>
      </CardContent>
      <ReasonDialog open={reopenTo !== null} onOpenChange={(o) => { if (!o) setReopenTo(null) }} title="Reopen ticket" confirmLabel="Reopen and move"
        description="Moving a closed ticket to an open stage reopens it. The reason is recorded in its history."
        onConfirm={async (reason) => { if (reopenTo) await move(reopenTo, reason) }} />
    </Card>
  )
}
