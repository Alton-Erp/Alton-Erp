import { Link2, Loader2, PhoneIncoming, PhoneOutgoing, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { CallStatusBadge } from '@/features/support/phone-components'
import { TicketFormDialog } from '@/features/support/support-dialogs'
import { formatDuration } from '@/features/support/support-model'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { addCallNote, fetchCallContext, linkCallTicket } from '@/services/phone'

/** After the call: notes, link to an open ticket or create one, and the customer's previous interactions. */
export function CallFollowUp({ callId, conversationId, linkedTicketId, timezone, onChanged }: {
  callId: string; conversationId: string | null; linkedTicketId: string | null; timezone?: string; onChanged: () => void
}) {
  const perms = useSupportPermissions()
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchCallContext(callId), [callId, refresh])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [newTicket, setNewTicket] = useState(false)
  const reload = () => { setRefresh((n) => n + 1); onChanged() }
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null)
    try { await fn(); setMsg({ ok: true, text: ok }); reload() } catch (e) { setMsg({ ok: false, text: describeDataError(e) }) } finally { setBusy(false) }
  }
  const c = q.data
  return (
    <>
      <Card data-testid="call-follow-up">
        <CardHeader><CardTitle>Notes and ticket</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-green-800' : 'text-red-700'} data-testid="call-follow-up-msg">{msg.text}</p>}
          {c?.notes.length ? <ul className="space-y-1.5" data-testid="call-notes">{c.notes.map((n) => (
            <li key={n.id} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5"><p className="whitespace-pre-wrap">{n.body}</p>
              <p className="text-xs text-muted-foreground">{n.author ?? 'Agent'} · {formatDateTime(n.at, timezone)}</p></li>))}</ul>
            : <p className="text-muted-foreground">No call notes.</p>}
          {perms.reply && (
            <div className="space-y-2">
              <Textarea aria-label="Call note" rows={2} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was discussed (visible to agents only)" />
              <Button size="sm" disabled={busy || !note.trim()} onClick={() => void act(async () => { await addCallNote(callId, note.trim()); setNote('') }, 'Note saved.')} data-testid="call-note-save">
                {busy && <Loader2 className="animate-spin" />}Save note</Button>
            </div>
          )}
          {perms.manageTickets && (
            <div className="space-y-2 border-t pt-3">
              {!linkedTicketId && c?.open_tickets.length ? <p className="font-medium">Link to an open ticket of this customer</p> : null}
              {!linkedTicketId && c?.open_tickets.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span><Link className="text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link> {t.subject}</span>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => linkCallTicket(callId, t.id), `Linked to ${t.ticket_number}.`)}><Link2 /> Link</Button>
                </div>
              ))}
              {!linkedTicketId && conversationId && <Button size="sm" variant="outline" onClick={() => setNewTicket(true)} data-testid="call-new-ticket"><Plus /> New ticket from this call</Button>}
              {linkedTicketId && <p className="text-muted-foreground">This call is linked to a ticket (see Ticket above).</p>}
            </div>
          )}
        </CardContent>
      </Card>
      <Card data-testid="call-previous">
        <CardHeader><CardTitle>Previous interactions</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!c ? <p className="text-muted-foreground">Loading…</p> : <>
            {c.previous_calls.length === 0 ? <p className="text-muted-foreground">No earlier calls.</p> : (
              <ul className="space-y-1">{c.previous_calls.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/support/calls/${p.id}`} className="inline-flex items-center gap-1 hover:underline">{p.direction === 'INBOUND' ? <PhoneIncoming className="size-3.5" /> : <PhoneOutgoing className="size-3.5" />}
                    {formatDateTime(p.at, timezone)}</Link>
                  <span className="flex items-center gap-2 text-xs"><CallStatusBadge status={p.status} />{p.talk_seconds ? formatDuration(p.talk_seconds) : ''}{p.agent_name ? ` · ${p.agent_name}` : ''}</span>
                </li>))}</ul>)}
            {c.conversations.length > 0 && <ul className="space-y-1 border-t pt-2">{c.conversations.map((v) => (
              <li key={v.id} className="text-xs">{v.channel.toLowerCase()} · {v.subject ?? 'conversation'} · {v.status.toLowerCase()} · {formatDateTime(v.last_activity_at, timezone)}</li>))}</ul>}
          </>}
        </CardContent>
      </Card>
      {newTicket && conversationId && <TicketFormDialog open onOpenChange={(o) => { if (!o) setNewTicket(false) }} conversation={{ id: conversationId, subject: null }}
        onCreated={(r) => { setNewTicket(false); void act(() => linkCallTicket(callId, r.id), 'Ticket created and linked.') }} />}
    </>
  )
}
