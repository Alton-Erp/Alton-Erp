import { Loader2, Phone, PhoneCall, PhoneIncoming, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CustomerFormDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { CALL_STATUS_META, PRESENCE_META, type Presence } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { FINAL_CALL_STATUSES, PhoneServiceError, fetchCall, fetchCallLines, fetchLiveCalls, placeCall, type CallStatus, type LiveCall } from '@/services/phone'
import { linkConversationCustomer } from '@/services/support'

export function CallStatusBadge({ status }: { status: CallStatus }) {
  const m = CALL_STATUS_META[status] ?? CALL_STATUS_META.INITIATED
  return <span title={m.hint} data-testid="call-status" data-status={status}><StatusBadge label={m.label} tone={m.tone} /></span>
}

/** Phone button beside a customer's number. Places the call through Acefone from a chosen agent line. */
export function CallButton({ number, customerId, ticketId, conversationId, label }: {
  number: string; customerId?: string | null; ticketId?: string | null; conversationId?: string | null; label?: string
}) {
  const { has } = usePermissions()
  const [open, setOpen] = useState(false)
  if (!has('support.reply') || !number) return null
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" aria-label={`Call ${number}`} data-testid="call-button" onClick={() => setOpen(true)}>
        <Phone className="size-3.5" />{label ?? 'Call'}
      </Button>
      {open && <CallDialog number={number} customerId={customerId} ticketId={ticketId} conversationId={conversationId} onClose={() => setOpen(false)} />}
    </>
  )
}

function CallDialog({ number, customerId, ticketId, conversationId, onClose }: {
  number: string; customerId?: string | null; ticketId?: string | null; conversationId?: string | null; onClose: () => void
}) {
  const lines = useAsync(fetchCallLines, [])
  const [line, setLine] = useState<string | null>(null)
  // One request key per dialog: repeated clicks never place a second call.
  const [key] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [callId, setCallId] = useState<string | null>(null)
  const [status, setStatus] = useState<CallStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chosen = line ?? lines.data?.[0]?.id ?? null
  const polls = useRef(0)
  // Set synchronously, so clicks that land before React re-renders cannot send a second request.
  const inFlight = useRef(false)

  useEffect(() => {
    if (!callId || (status && FINAL_CALL_STATUSES.includes(status))) return
    const t = setInterval(() => {
      polls.current++
      if (polls.current > 60) { clearInterval(t); return }
      fetchCall(callId).then((d) => setStatus(d.call.status), () => {})
    }, 3000)
    return () => clearInterval(t)
  }, [callId, status])

  const call = async () => {
    if (!chosen || inFlight.current || callId) return
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      const r = await placeCall({ customer_id: customerId ?? null, ticket_id: ticketId ?? null, conversation_id: conversationId ?? null, number, line_id: chosen, idempotency_key: key })
      setCallId(r.call_id); setStatus(r.status)
      setMessage(r.duplicate ? 'This call was already requested; its current status is shown.' : 'Requested. The status changes when Acefone reports progress.')
    } catch (e) {
      if (e instanceof PhoneServiceError && e.callId) { setCallId(e.callId); setStatus((e.status as CallStatus) ?? null) }
      setError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Call {number}</DialogTitle>
          <DialogDescription>Acefone rings the chosen agent line and connects the customer. The status below comes only from Acefone’s events.</DialogDescription></DialogHeader>
        {lines.loading && !lines.data ? <p className="text-sm text-muted-foreground">Loading lines…</p>
          : lines.error ? <p role="alert" className="text-sm text-red-700">{describeDataError(lines.error)}</p>
          : !lines.data?.length ? <p className="text-sm text-muted-foreground" data-testid="no-lines">No agent line is set up for you. An administrator maps lines in Support Settings → Phone.</p>
          : (
            <div className="space-y-1">
              <label htmlFor="call-line" className="text-sm font-medium">Call from</label>
              <Select value={chosen ?? undefined} onValueChange={setLine} disabled={Boolean(callId)}>
                <SelectTrigger id="call-line"><SelectValue /></SelectTrigger>
                <SelectContent>{lines.data.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.agent_name} · {l.label ?? l.agent_number}{l.presence !== 'AVAILABLE' ? ` (${PRESENCE_META[l.presence as Presence]?.label ?? l.presence})` : ''}</SelectItem>
                ))}</SelectContent>
              </Select>
            </div>
          )}
        {status && <div className="flex items-center gap-2 text-sm" data-testid="call-progress">Status: <CallStatusBadge status={status} /></div>}
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <DialogFooter>
          {callId && <Button variant="outline" asChild><Link to={`/support/calls/${callId}`}>Call details</Link></Button>}
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          {!callId && <Button type="button" disabled={!chosen || busy} onClick={() => void call()} data-testid="place-call">{busy ? <Loader2 className="animate-spin" /> : <PhoneCall />} Call</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Incoming calls for agents (support.reply): matched customer, open tickets, previous interactions and actions. */
export function IncomingCallPanel() {
  const { has } = usePermissions()
  const enabled = has('support.reply')
  const [calls, setCalls] = useState<LiveCall[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [customerFor, setCustomerFor] = useState<LiveCall | null>(null)
  const [ticketFor, setTicketFor] = useState<LiveCall | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const load = () => {
      if (document.visibilityState !== 'visible') return
      fetchLiveCalls().then((c) => { if (!stop) setCalls(Array.isArray(c) ? c : []) }, () => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [enabled, tick])
  if (!enabled) return null
  const shown = calls.filter((c) => c.direction === 'INBOUND' && !dismissed.includes(c.id))
  return (
    <>
      {shown.length > 0 && (
        <aside aria-label="Incoming calls" className="fixed right-4 bottom-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] space-y-2" data-testid="incoming-calls">
          {shown.slice(0, 3).map((c) => (
            <div key={c.id} className="rounded-xl border bg-card p-3 shadow-lg" data-testid={`incoming-${c.id}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-center gap-2 font-medium"><PhoneIncoming className="size-4 text-primary" />{c.customer?.display_name ?? 'Unknown caller'}</p>
                <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => setDismissed((d) => [...d, c.id])}><X className="size-4" /></button>
              </div>
              <p className="text-sm text-muted-foreground">{c.number ?? 'Number withheld'} · {formatDateTime(c.started_at)}</p>
              <div className="mt-1 flex items-center gap-2 text-xs"><CallStatusBadge status={c.status} />{c.agent_name && <span>Answered by {c.agent_name}</span>}</div>
              {c.customer ? (
                <div className="mt-2 text-xs">
                  <p>{c.customer.customer_code}{c.customer.company_name ? ` · ${c.customer.company_name}` : ''} · {c.previous_conversations} conversation(s), {c.previous_calls} earlier call(s)</p>
                  {c.open_tickets.length > 0 ? <ul className="mt-1 space-y-0.5">{c.open_tickets.slice(0, 3).map((t) => (
                    <li key={t.id}><Link className="text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link> {t.subject}</li>
                  ))}</ul> : <p className="mt-1 text-muted-foreground">No open tickets.</p>}
                </div>
              ) : <p className="mt-2 text-xs text-muted-foreground">{c.candidates > 1 ? `${c.candidates} customers share this number — choose one in the conversation.` : 'No customer has this number.'}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {c.conversation_id && <Button size="sm" variant="outline" asChild><Link to={`/support/inbox?c=${c.conversation_id}`}>Open</Link></Button>}
                {!c.customer && c.candidates === 0 && <Button size="sm" variant="outline" onClick={() => setCustomerFor(c)}><UserPlus /> New customer</Button>}
                {c.conversation_id && has('support.manage_tickets') && <Button size="sm" variant="outline" onClick={() => setTicketFor(c)}>New ticket</Button>}
              </div>
            </div>
          ))}
        </aside>
      )}
      <CustomerFormDialog open={customerFor !== null} onOpenChange={(o) => { if (!o) setCustomerFor(null) }} preset={{ phones: customerFor?.number ?? '' }}
        onSaved={(id) => { const conv = customerFor?.conversation_id; if (conv) void linkConversationCustomer(conv, id).then(() => setTick((n) => n + 1), () => {}) }} />
      <TicketFormDialog open={ticketFor !== null} onOpenChange={(o) => { if (!o) setTicketFor(null) }}
        conversation={ticketFor?.conversation_id ? { id: ticketFor.conversation_id, subject: 'Phone call' } : null} onCreated={() => setTick((n) => n + 1)} />
    </>
  )
}
