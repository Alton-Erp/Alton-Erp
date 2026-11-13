import { ArrowLeft, Lock, Paperclip } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CallStatusBadge } from '@/features/support/phone-components'
import { InfoList } from '@/features/support/support-components'
import { formatDuration } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchCall } from '@/services/phone'
import { attachmentUrl } from '@/services/support'

/** /support/calls/:callId — one call: numbers, agent, times, durations, disposition, provider references, recording, links. */
export default function SupportCallDetailPage() {
  const { callId = '' } = useParams()
  const { access } = useAuth()
  const tz = access?.company?.timezone
  const q = useAsync(() => fetchCall(callId), [callId])
  const [recError, setRecError] = useState<string | null>(null)
  const header = <PageHeader title="Call details" breadcrumbs={[{ label: 'Support Centre' }, { label: 'Calls', to: '/support/calls' }, { label: 'Call details' }]}
    actions={<Button variant="outline" asChild><Link to="/support/calls"><ArrowLeft /> Call log</Link></Button>} />
  if (q.loading && !q.data) return <>{header}<LoadingState rows={8} /></>
  if (q.error || !q.data) return <>{header}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const d = q.data
  const c = d.call
  const when = (v: string | null) => (v ? formatDateTime(v, tz) : '—')
  const rec = d.recording
  return (
    <>
      {header}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card data-testid="call-detail">
          <CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle>{c.direction === 'INBOUND' ? 'Incoming call' : 'Outgoing call'}</CardTitle><CallStatusBadge status={c.status} /></CardHeader>
          <CardContent>
            <InfoList items={[
              ['Direction', c.direction === 'INBOUND' ? 'Inbound' : 'Outbound'],
              ['Caller number', c.caller_number ?? '—'],
              ['Destination number', c.destination_number ?? '—'],
              ['Customer number (E.164)', c.customer_number_e164 ?? '—'],
              ['Agent', d.agent?.display_name ?? c.agent_name ?? '—'],
              ['Agent line', c.agent_number ?? '—'],
              ['Caller ID used', c.caller_id_used ?? 'Account default'],
              ['Placed by', d.initiated_by ?? (c.direction === 'INBOUND' ? 'Customer' : 'Outside the ERP')],
              ['Call start', when(c.started_at)],
              ['Answered', when(c.answered_at)],
              ['Call end', when(c.ended_at)],
              ['Ring duration', formatDuration(c.ring_seconds)],
              ['Talk duration', formatDuration(c.talk_seconds)],
              ['Total duration', formatDuration(c.duration_seconds)],
              ['Disposition', c.disposition ?? '—'],
              ['Hangup cause', c.hangup_cause ?? '—'],
              ['Acefone reference (ref_id)', c.provider_ref_id ?? '—'],
              ['Acefone call ID', c.provider_call_id ?? '—'],
              ['Click-to-Call request', c.request_state ? `${c.request_state.toLowerCase()}${c.request_message ? ` — ${c.request_message}` : ''}` : '—'],
              ['Customer', d.customer ? <Link key="customer" className="text-primary hover:underline" to={`/support/customers/${d.customer.id}`}>{d.customer.display_name} ({d.customer.customer_code})</Link> : 'Not linked'],
              ['Ticket', d.ticket ? <Link key="ticket" className="text-primary hover:underline" to={`/support/tickets/${d.ticket.id}`}>{d.ticket.ticket_number} — {d.ticket.subject}</Link> : 'None'],
              ['Conversation', c.conversation_id ? <Link key="conv" className="text-primary hover:underline" to={`/support/calls?tab=conversations&c=${c.conversation_id}`}>Open conversation</Link> : '—'],
            ]} />
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Recording</CardTitle></CardHeader>
            <CardContent className="text-sm" data-testid="call-recording">
              {rec.state === 'STORED' ? (rec.restricted || !rec.storage_path
                ? <p className="inline-flex items-center gap-1 text-muted-foreground"><Lock className="size-4" />Recording stored — opening it needs ticket management access.</p>
                : <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline"
                    onClick={() => { setRecError(null); attachmentUrl(rec.storage_path!).then((u) => window.open(u, '_blank', 'noopener'), (e) => setRecError(describeDataError(e))) }}>
                    <Paperclip className="size-4" />{rec.file_name}</button>)
                : rec.state === 'AT_PROVIDER' ? <p className="text-muted-foreground">Acefone has a recording; it is copied here only when recording retrieval is enabled in Phone settings.</p>
                : rec.state === 'PURGED' ? <p className="text-muted-foreground">Deleted after the company’s retention period.</p>
                : <p className="text-muted-foreground">No recording.</p>}
              {recError && <p role="alert" className="mt-2 text-red-700">{recError}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Status history</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-1.5 text-sm" data-testid="call-events">{d.events.map((e, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2"><span>{e.event_name.replace(/_/g, ' ')}{e.from !== e.to && e.to ? ` → ${e.to.toLowerCase()}` : ''}</span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(e.occurred_at ?? e.at, tz)}</span></li>
              ))}</ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
