import {
  Activity, CalendarCheck, FileText, History, Loader2, Mail, MessageCircle, Package, Pencil, Phone, PhoneMissed, Plus, StickyNote, Ticket, Trash2, User,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ACTIVITY_STATUSES, ACTIVITY_TYPES, TICKET_FILTERS, TIMELINE_LABELS, timelineHref, toLocalInput } from '@/features/support/customers/customer-model'
import { OutcomeIcon } from '@/features/support/pipeline/pipeline-board'
import { Field, PriorityBadge, SlaBadge, TicketStatusBadge } from '@/features/support/support-components'
import { PRIORITIES, PRIORITY_META, formatDuration } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  deleteCustomerNote, fetchCustomerRecords, fetchCustomerTickets, fetchCustomerTimeline, fetchNoteHistory, saveCustomerActivity, saveCustomerNote,
  type ActivityInput, type CallRow, type CustomerActivity, type CustomerTicketFilter, type CustomerWorkspace, type EmailRow, type FileRow, type ProductRow, type TimelineEvent,
  type WhatsAppRow,
} from '@/services/customer-crm'
import { attachmentUrl } from '@/services/support'
import { fetchUserOptions } from '@/services/ticket-fields'

const Loading = () => <LoadingState rows={5} />

const ICON: Record<string, typeof Ticket> = {
  CUSTOMER_CREATED: User, CUSTOMER_UPDATED: Pencil, TICKET_CREATED: Ticket, STAGE_CHANGED: Ticket, TICKET_ASSIGNED: User, TICKET_RESOLVED: Ticket, TICKET_CLOSED: Ticket,
  TICKET_REOPENED: Ticket, NOTE_ADDED: StickyNote, CALL: Phone, CALL_MISSED: PhoneMissed, EMAIL_RECEIVED: Mail, EMAIL_SENT: Mail, WHATSAPP_RECEIVED: MessageCircle,
  WHATSAPP_SENT: MessageCircle, PRODUCT_LINKED: Package, ACTIVITY_CREATED: CalendarCheck, ACTIVITY_COMPLETED: CalendarCheck,
}

/** Real events of the customer, newest first; each opens its record. */
export function TimelineTab({ customerId, tz }: { customerId: string; tz?: string }) {
  const [pages, setPages] = useState<TimelineEvent[][]>([])
  const [more, setMore] = useState(true)
  const [busy, setBusy] = useState(false)
  const first = useAsync(() => fetchCustomerTimeline(customerId, 100, null), [customerId])
  if (first.loading && !first.data) return <Loading />
  if (first.error || !first.data) return <ErrorState message={describeDataError(first.error)} onRetry={first.reload} />
  const events = [first.data, ...pages].flat()
  const loadMore = async () => {
    setBusy(true)
    try { const next = await fetchCustomerTimeline(customerId, 100, events.at(-1)!.at); setPages((p) => [...p, next]); if (next.length < 100) setMore(false) } finally { setBusy(false) }
  }
  if (!events.length) return <EmptyState compact icon={Activity} title="Nothing yet" description="Tickets, calls, messages, notes and activities of this customer appear here." />
  return (
    <div>
      <ol className="relative space-y-3 border-l pl-5" data-testid="customer-timeline">
        {events.map((e, i) => {
          const Icon = ICON[e.type] ?? Activity
          const href = timelineHref(e, customerId)
          return (
            <li key={`${e.type}-${e.link_id}-${e.at}-${i}`} className="relative" data-testid={`tl-${e.type}`}>
              <span className={cn('absolute top-0.5 -left-[29px] grid size-6 place-items-center rounded-full border bg-card', e.type === 'CALL_MISSED' && 'border-red-300 text-red-600')}><Icon className="size-3.5" /></span>
              <p className="text-xs text-muted-foreground">{formatDateTime(e.at, tz)} · {TIMELINE_LABELS[e.type] ?? e.type}{e.actor ? ` · ${e.actor}` : ''}</p>
              <p className="text-sm font-medium">{href ? <Link className="text-primary hover:underline" to={href}>{e.title}</Link> : e.title}</p>
              {e.detail && <p className="text-xs break-words text-muted-foreground">{e.detail}</p>}
            </li>
          )
        })}
      </ol>
      {more && first.data.length === 100 && <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void loadMore()}>{busy && <Loader2 className="animate-spin" />}Load earlier events</Button>}
    </div>
  )
}

export function TicketsTab({ customerId, tz }: { customerId: string; tz?: string }) {
  const [filter, setFilter] = useState<CustomerTicketFilter>('ALL')
  const q = useAsync(() => fetchCustomerTickets(customerId, filter), [customerId, filter])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Ticket filter">
        {TICKET_FILTERS.map(([v, l]) => <Button key={v} size="sm" variant={filter === v ? 'secondary' : 'ghost'} aria-pressed={filter === v} onClick={() => setFilter(v)} data-testid={`tf-${v}`}>{l}</Button>)}
      </div>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState message={describeDataError(q.error)} onRetry={q.reload} />
        : !q.data?.length ? <p className="text-sm text-muted-foreground">No tickets{filter === 'ALL' ? '' : ' in this view'}.</p> : (
          <div className="overflow-x-auto"><Table data-testid="customer-tickets">
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Ticket</TableHead><TableHead>Subject</TableHead><TableHead>Pipeline / stage</TableHead><TableHead>Priority</TableHead>
              <TableHead>Agent</TableHead><TableHead>SLA</TableHead><TableHead>Created</TableHead><TableHead>Updated</TableHead><TableHead>Closed</TableHead></TableRow></TableHeader>
            <TableBody>{q.data.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium whitespace-nowrap"><Link className="text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link></TableCell>
                <TableCell className="max-w-64 truncate">{t.subject}{t.merged && <span className="block text-xs text-muted-foreground">merged</span>}</TableCell>
                <TableCell className="whitespace-nowrap">{t.stage ? <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: t.stage_color ?? undefined }} />
                  <span><span className="block text-xs text-muted-foreground">{t.pipeline}</span>{t.stage}</span><OutcomeIcon outcome={t.outcome_type} /></span> : <TicketStatusBadge status={t.status} />}</TableCell>
                <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                <TableCell className="whitespace-nowrap">{t.assigned_agent ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                <TableCell><SlaBadge status={t.sla_status} /></TableCell>
                <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.created_at, tz)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{formatDateTime(t.updated_at, tz)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{t.closed_at ? formatDateTime(t.closed_at, tz) : '—'}</TableCell>
              </TableRow>
            ))}</TableBody></Table></div>
        )}
    </div>
  )
}

export function NotesTab({ ws, tz, onChanged }: { ws: CustomerWorkspace; tz?: string; onChanged: () => void }) {
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(null)
    try { await fn(); after?.(); onChanged() } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3" data-testid="customer-notes">
      {ws.can.notes && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void run(() => saveCustomerNote(ws.customer.id, null, body.trim()), () => setBody('')) }}>
          <Textarea aria-label="New customer note" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={5000} placeholder="Add a note (visible to agents only)" />
          <div className="flex justify-end"><Button type="submit" size="sm" disabled={!body.trim() || busy} data-testid="add-note"><Plus /> Add note</Button></div>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {ws.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
        <ul className="space-y-2">{ws.notes.map((n) => (
          <li key={n.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-testid="note">
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
              <span>{n.author ?? 'Agent'} · {formatDateTime(n.created_at, tz)}{n.edited_at ? ` · edited ${formatDateTime(n.edited_at, tz)}` : ''}</span>
              <span className="ml-auto flex gap-1">
                {n.revisions > 0 && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setHistory(history === n.id ? null : n.id)}><History className="size-3" />History</Button>}
                {n.can_edit && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setEditing({ id: n.id, body: n.body })} aria-label="Edit note"><Pencil className="size-3" />Edit</Button>}
                {n.can_edit && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-red-700" aria-label="Delete note"
                  onClick={() => { if (window.confirm('Delete this note? Its text stays in the note history.')) void run(() => deleteCustomerNote(n.id)) }}><Trash2 className="size-3" />Delete</Button>}
              </span>
            </div>
            {editing?.id === n.id ? (
              <div className="mt-1 space-y-1">
                <Textarea aria-label="Note text" value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} rows={3} maxLength={5000} />
                <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button size="sm" disabled={busy || !editing.body.trim()} onClick={() => void run(() => saveCustomerNote(ws.customer.id, n.id, editing.body.trim()), () => setEditing(null))}>Save</Button></div>
              </div>
            ) : <p className="mt-1 whitespace-pre-wrap">{n.body}</p>}
            {history === n.id && <NoteHistory noteId={n.id} tz={tz} />}
          </li>
        ))}</ul>
      )}
    </div>
  )
}

function NoteHistory({ noteId, tz }: { noteId: string; tz?: string }) {
  const q = useAsync(() => fetchNoteHistory(noteId), [noteId])
  if (!q.data) return null
  return (
    <ul className="mt-2 space-y-1 border-t border-amber-200 pt-2 text-xs text-amber-950">
      {q.data.map((r) => <li key={r.id}><span className="text-amber-800">Before the {r.action === 'EDITED' ? 'edit' : 'deletion'} of {formatDateTime(r.changed_at, tz)}{r.changed_by ? ` by ${r.changed_by}` : ''}:</span>
        <p className="whitespace-pre-wrap">{r.body}</p></li>)}
    </ul>
  )
}

const typeLabel = (t: string) => ACTIVITY_TYPES.find(([v]) => v === t)?.[1] ?? t
const statusLabel = (s: string) => ACTIVITY_STATUSES.find(([v]) => v === s)?.[1] ?? s

export function ActivitiesTab({ ws, tz, onChanged }: { ws: CustomerWorkspace; tz?: string; onChanged: () => void }) {
  const [open, setOpen] = useState<CustomerActivity | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setStatus = async (a: CustomerActivity, status: string) => {
    setError(null)
    try { await saveCustomerActivity(ws.customer.id, a.id, { status: status as CustomerActivity['status'] }); onChanged() } catch (e) { setError(describeDataError(e)) }
  }
  return (
    <div className="space-y-3" data-testid="customer-activities">
      {ws.can.activities && <div className="flex justify-end"><Button size="sm" onClick={() => setOpen('new')} data-testid="add-activity"><Plus /> Add activity</Button></div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {ws.activities.length === 0 ? <p className="text-sm text-muted-foreground">No tasks, follow-ups, reminders, visits or appointments.</p> : (
        <ul className="divide-y rounded-md border">{ws.activities.map((a) => (
          <li key={a.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-sm', (a.status === 'DONE' || a.status === 'CANCELLED') && 'text-muted-foreground')} data-testid="activity">
            <CalendarCheck className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{typeLabel(a.activity_type)}: {a.title}</span>
              <span className="block text-xs text-muted-foreground">{[a.due_at && `due ${formatDateTime(a.due_at, tz)}`, a.assigned_user && `for ${a.assigned_user}`,
                a.completed_at && `done ${formatDateTime(a.completed_at, tz)}`, a.ticket_number].filter(Boolean).join(' · ')}</span>
              {a.description && <span className="block text-xs whitespace-pre-wrap">{a.description}</span>}
            </span>
            <PriorityBadge priority={a.priority} />
            {ws.can.activities ? (
              <Select value={a.status} onValueChange={(s) => void setStatus(a, s)}>
                <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Status of ${a.title}`}><SelectValue /></SelectTrigger>
                <SelectContent>{ACTIVITY_STATUSES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            ) : <span className="text-xs">{statusLabel(a.status)}</span>}
            {ws.can.activities && <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit ${a.title}`} onClick={() => setOpen(a)}><Pencil className="size-3.5" /></Button>}
          </li>
        ))}</ul>
      )}
      {open && <ActivityDialog customerId={ws.customer.id} existing={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged() }} />}
    </div>
  )
}

function ActivityDialog({ customerId, existing, onClose, onSaved }: { customerId: string; existing: CustomerActivity | null; onClose: () => void; onSaved: () => void }) {
  const users = useAsync(() => fetchUserOptions('EMPLOYEES').catch(() => []), [])
  const [v, setV] = useState({ activity_type: existing?.activity_type ?? 'FOLLOW_UP', title: existing?.title ?? '', description: existing?.description ?? '',
    due: toLocalInput(existing?.due_at ?? null), assigned_user_id: existing?.assigned_user_id ?? '', priority: existing?.priority ?? 'NORMAL', status: existing?.status ?? 'OPEN' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!v.title.trim()) { setError('Enter the activity title.'); return }
    setBusy(true); setError(null)
    const p: ActivityInput = { activity_type: v.activity_type, title: v.title.trim(), description: v.description.trim() || null, due_at: v.due ? new Date(v.due).toISOString() : null,
      assigned_user_id: v.assigned_user_id || null, priority: v.priority, status: v.status }
    try { await saveCustomerActivity(customerId, existing?.id ?? null, p); onSaved() } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" data-testid="activity-dialog">
        <DialogHeader><DialogTitle>{existing ? 'Edit activity' : 'Add activity'}</DialogTitle><DialogDescription>Tasks, follow-ups, reminders, customer visits and service appointments.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <Field label="Type" htmlFor="ac-type"><Select value={v.activity_type} onValueChange={(x) => setV((s) => ({ ...s, activity_type: x as typeof s.activity_type }))}>
            <SelectTrigger id="ac-type" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{ACTIVITY_TYPES.map(([x, l]) => <SelectItem key={x} value={x}>{l}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Priority" htmlFor="ac-prio"><Select value={v.priority} onValueChange={(x) => setV((s) => ({ ...s, priority: x as typeof s.priority }))}>
            <SelectTrigger id="ac-prio" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{PRIORITIES.map((x) => <SelectItem key={x} value={x}>{PRIORITY_META[x].label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Title *" htmlFor="ac-title" className="sm:col-span-2"><Input id="ac-title" value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} maxLength={200} autoFocus /></Field>
          <Field label="Description" htmlFor="ac-desc" className="sm:col-span-2"><Textarea id="ac-desc" rows={2} maxLength={2000} value={v.description} onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))} /></Field>
          <Field label="Due" htmlFor="ac-due"><Input id="ac-due" type="datetime-local" value={v.due} onChange={(e) => setV((s) => ({ ...s, due: e.target.value }))} /></Field>
          <Field label="Assigned employee" htmlFor="ac-user"><Select value={v.assigned_user_id || 'none'} onValueChange={(x) => setV((s) => ({ ...s, assigned_user_id: x === 'none' ? '' : x }))}>
            <SelectTrigger id="ac-user" className="w-full"><SelectValue /></SelectTrigger><SelectContent className="max-h-72"><SelectItem value="none">Nobody</SelectItem>
              {(users.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Status" htmlFor="ac-status"><Select value={v.status} onValueChange={(x) => setV((s) => ({ ...s, status: x as typeof s.status }))}>
            <SelectTrigger id="ac-status" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{ACTIVITY_STATUSES.map(([x, l]) => <SelectItem key={x} value={x}>{l}</SelectItem>)}</SelectContent></Select></Field>
          {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="activity-save">{busy && <Loader2 className="animate-spin" />}Save activity</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RecordsTable<T>({ customerId, kind, empty, head, row }: { customerId: string; kind: Parameters<typeof fetchCustomerRecords>[1]; empty: string; head: string[]; row: (r: T) => ReactNode }) {
  const q = useAsync(() => fetchCustomerRecords<T>(customerId, kind), [customerId, kind])
  if (q.loading && !q.data) return <Loading />
  if (q.error) return <ErrorState message={describeDataError(q.error)} onRetry={q.reload} />
  if (!q.data?.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="overflow-x-auto"><Table data-testid={`records-${kind.toLowerCase()}`}>
      <TableHeader><TableRow className="hover:bg-transparent">{head.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{q.data.map(row)}</TableBody></Table></div>
  )
}

export const EmailsTab = ({ customerId, tz }: { customerId: string; tz?: string }) => (
  <RecordsTable<EmailRow> customerId={customerId} kind="EMAIL" empty="No emails with this customer." head={['Subject', 'From', 'Direction', 'Date']} row={(m) => (
    <TableRow key={m.id}><TableCell className="max-w-80 truncate"><Link className="text-primary hover:underline" to={`/support/emails?c=${m.conversation_id}`}>{m.subject ?? '(no subject)'}</Link></TableCell>
      <TableCell className="max-w-56 truncate">{m.from_name ?? m.from_address ?? '—'}</TableCell><TableCell>{m.direction === 'INBOUND' ? 'Received' : 'Sent'}</TableCell>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(m.at, tz)}</TableCell></TableRow>
  )} />
)

export const CallsTab = ({ customerId, tz }: { customerId: string; tz?: string }) => (
  <RecordsTable<CallRow> customerId={customerId} kind="CALLS" empty="No calls with this customer." head={['Call', 'Result', 'Duration', 'Agent', 'Ticket', 'Date']} row={(c) => (
    <TableRow key={c.id}><TableCell><Link className="text-primary hover:underline" to={`/support/calls/${c.id}`}>{c.direction === 'INBOUND' ? 'Incoming' : 'Outgoing'}</Link></TableCell>
      <TableCell className={cn(c.status === 'MISSED' && 'text-red-700')}>{c.status.replace(/_/g, ' ').toLowerCase()}</TableCell><TableCell className="tabular-nums">{formatDuration(c.duration_seconds)}</TableCell>
      <TableCell>{c.agent_name ?? '—'}</TableCell><TableCell>{c.ticket_id ? <Link className="text-primary hover:underline" to={`/support/tickets/${c.ticket_id}`}>{c.ticket_number}</Link> : '—'}</TableCell>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(c.at, tz)}</TableCell></TableRow>
  )} />
)

export const WhatsAppTab = ({ customerId, tz }: { customerId: string; tz?: string }) => (
  <RecordsTable<WhatsAppRow> customerId={customerId} kind="WHATSAPP" empty="No WhatsApp messages with this customer." head={['Message', 'Type', 'Status', 'Date']} row={(w) => (
    <TableRow key={w.id}><TableCell><Link className="text-primary hover:underline" to={`/support/whatsapp?c=${w.conversation_id}`}>{w.direction === 'INBOUND' ? 'Received' : 'Sent'}</Link></TableCell>
      <TableCell>{w.msg_type}</TableCell><TableCell>{w.status ?? '—'}</TableCell><TableCell className="text-xs whitespace-nowrap">{formatDateTime(w.at, tz)}</TableCell></TableRow>
  )} />
)

export const ProductsTab = ({ customerId }: { customerId: string }) => (
  <RecordsTable<ProductRow> customerId={customerId} kind="PRODUCTS" empty="No products on this customer's tickets." head={['Product', 'SKU', 'Model', 'Complaints', 'Last complaint', 'Tickets']} row={(p) => (
    <TableRow key={p.product_id}><TableCell className="font-medium">{p.product_name}</TableCell><TableCell className="font-mono text-xs">{p.sku}</TableCell><TableCell>{p.model_number ?? '—'}</TableCell>
      <TableCell className="tabular-nums">{p.complaints}</TableCell><TableCell className="text-xs whitespace-nowrap">{formatDate(p.last_complaint_at)}</TableCell>
      <TableCell className="text-xs">{p.tickets.map((t, i) => <span key={t.id}>{i > 0 && ', '}<Link className="text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link></span>)}</TableCell></TableRow>
  )} />
)

export const FilesTab = ({ customerId, tz }: { customerId: string; tz?: string }) => (
  <RecordsTable<FileRow> customerId={customerId} kind="FILES" empty="No files on this customer's tickets or conversations." head={['File', 'Size', 'From', 'Date']} row={(f) => (
    <TableRow key={f.id}><TableCell className="max-w-72 truncate">{f.storage_path
      ? <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => void attachmentUrl(f.storage_path!).then((u) => window.open(u, '_blank', 'noopener'))}><FileText className="size-3.5" />{f.file_name}</button>
      : <span className="text-muted-foreground">{f.file_name} (restricted)</span>}</TableCell>
      <TableCell className="text-xs tabular-nums">{f.size_bytes ? `${Math.max(1, Math.round(f.size_bytes / 1024))} KB` : '—'}</TableCell>
      <TableCell className="text-xs">{f.ticket_id ? <Link className="text-primary hover:underline" to={`/support/tickets/${f.ticket_id}`}>{f.ticket_number}</Link> : 'Conversation'}</TableCell>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(f.at, tz)}</TableCell></TableRow>
  )} />
)
