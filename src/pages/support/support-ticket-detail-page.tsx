import { ArrowLeft, GitMerge, Loader2, Paperclip, RotateCcw, Save, StickyNote } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AgentSelect, ChannelIcon, ChannelLabel, ConversationStatusBadge, Field, InfoList, PriorityBadge, SlaBadge, TicketStatusBadge, Timeline } from '@/features/support/support-components'
import { TicketSlaPanel } from '@/features/support/support-unified-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { ReasonDialog } from '@/features/support/support-dialogs'
import { CallButton } from '@/features/support/phone-components'
import { PRIORITIES, PRIORITY_META, TICKET_STATUSES, TICKET_STATUS_META, formatMinutes, type TicketStatus } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  addNote, assignTicket, fetchAgents, fetchTicket, fetchTickets, mergeTicket, reopenTicket, updateTicket, uploadAttachment, type TicketDetail,
} from '@/services/support'

/** /support/tickets/:ticketId */
export default function SupportTicketDetailPage() {
  const { ticketId = '' } = useParams()
  const navigate = useNavigate()
  const { access } = useAuth()
  const tz = access?.company?.timezone
  const perms = useSupportPermissions()
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchTicket(ticketId), [ticketId, refresh])
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const reload = () => setRefresh((n) => n + 1)
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNotice(null)
    try { await fn(); if (ok) setNotice(ok); reload() } catch (e) { setError(describeDataError(e)) }
  }
  const header = <PageHeader title={q.data?.ticket.ticket_number ?? 'Ticket'} description={q.data?.ticket.subject}
    breadcrumbs={[{ label: 'Support Centre' }, { label: 'Support Tickets', to: '/support/tickets' }, { label: q.data?.ticket.ticket_number ?? 'Ticket' }]}
    actions={<Button variant="outline" asChild><Link to="/support/tickets"><ArrowLeft /> All tickets</Link></Button>} />
  if (q.loading && !q.data) return <>{header}<LoadingState rows={8} /></>
  if (q.error || !q.data) return <>{header}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const d = q.data
  const t = d.ticket
  const merged = Boolean(t.merged_into_ticket_id)
  const closed = t.status === 'CLOSED' || merged
  const editable = perms.manageTickets && !closed

  return (
    <>
      {header}
      {error && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">{notice}</p>}
      {merged && t.merged_into && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">This ticket was merged into{' '}
        <Link className="font-medium underline" to={`/support/tickets/${t.merged_into.id}`}>{t.merged_into.ticket_number}</Link>. Work continues there.</p>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2"><TicketStatusBadge status={t.status} /><PriorityBadge priority={t.priority} /><SlaBadge status={t.sla_status} /></div>
              <div className="flex flex-wrap gap-2">
                {perms.manageTickets && !merged && (t.status === 'RESOLVED' || t.status === 'CLOSED') &&
                  <Button size="sm" variant="outline" onClick={() => setReopenOpen(true)} data-testid="reopen-ticket"><RotateCcw /> Reopen</Button>}
                {perms.manageTickets && !closed && <Button size="sm" variant="outline" onClick={() => setMergeOpen(true)}><GitMerge /> Merge into…</Button>}
              </div>
            </CardHeader>
            <CardContent>
              <InfoList items={[
                ['Customer', d.customer ? <Link key="customer" className="text-primary hover:underline" to={`/support/customers/${d.customer.id}`}>{d.customer.display_name} ({d.customer.customer_code})</Link> : '—'],
                ['Phone / email', <span key="contact" className="inline-flex flex-wrap items-center gap-1">{[t.customer_phone, t.customer_email].filter(Boolean).join(' · ') || '—'}
                  {t.customer_phone && <CallButton number={t.customer_phone} ticketId={t.id} customerId={t.customer_id} />}</span>],
                ['Channel', <ChannelLabel key="channel" channel={t.channel} />],
                ['Category', [t.category, t.subcategory].filter(Boolean).join(' / ') || '—'],
                ['Department', t.department ?? '—'],
                ['Assigned agent', d.agent?.display_name ?? 'Unassigned'],
                ['Created', formatDateTime(t.created_at, tz)],
                ['First response', t.first_response_at ? formatDateTime(t.first_response_at, tz) : t.first_response_due_at ? `Due ${formatDateTime(t.first_response_due_at, tz)}` : '—'],
                ['Due', t.due_at ? formatDateTime(t.due_at, tz) : '—'],
                ['Resolved', t.resolved_at ? formatDateTime(t.resolved_at, tz) : '—'],
                ['SLA policy', d.sla_policy ? `${d.sla_policy.name}: respond in ${formatMinutes(d.sla_policy.first_response_minutes)}, resolve in ${formatMinutes(d.sla_policy.resolution_minutes)}` : 'None'],
                ['Related record', t.related_type ? `${t.related_type.replace('_', ' ').toLowerCase()} ${t.related_reference ?? ''}` : '—'],
                ['Satisfaction', t.csat_rating ? `${t.csat_rating} / 5${t.csat_comment ? ` — ${t.csat_comment}` : ''}` : 'Not rated'],
                ['Reopened', t.reopen_count ? `${t.reopen_count} time(s)` : 'Never'],
              ]} />
              {t.description && <p className="mt-4 rounded-lg bg-surface-muted/50 p-3 text-sm whitespace-pre-wrap">{t.description}</p>}
              {t.merged_from.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Merged in: {t.merged_from.map((m) => m.ticket_number).join(', ')}</p>}
            </CardContent>
          </Card>
          {editable && <EditTicket key={t.updated_at} d={d} onSave={(p) => act(() => updateTicket(t.id, p), 'Ticket updated.')} />}
          <Card>
            <CardHeader><div><CardTitle>Conversations</CardTitle><CardDescription>Calls, WhatsApp and emails linked to this ticket.</CardDescription></div></CardHeader>
            <CardContent>
              {d.conversations.length === 0 ? <p className="text-sm text-muted-foreground">No conversation is linked. Link one from the inbox.</p> : (
                <ul className="divide-y text-sm">{d.conversations.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 py-2"><ChannelIcon channel={c.channel} />
                    <Link className="min-w-0 flex-1 truncate text-primary hover:underline" to={`/support/inbox?c=${c.id}`}>{c.subject ?? c.last_message_preview ?? 'Conversation'}</Link>
                    <ConversationStatusBadge status={c.status} /><span className="text-xs text-muted-foreground">{formatDateTime(c.last_activity_at, tz)}</span></li>
                ))}</ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4"><TicketSlaPanel ticketId={t.id} timezone={tz ?? undefined} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Work on this ticket</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="Status" htmlFor="td-status">
                <Select value={t.status} disabled={!editable} onValueChange={(s) => void act(() => updateTicket(t.id, { status: s }), `Status changed to ${TICKET_STATUS_META[s as TicketStatus].label}.`)}>
                  <SelectTrigger id="td-status"><SelectValue /></SelectTrigger>
                  <SelectContent>{TICKET_STATUSES.filter((s) => s !== 'NEW' || t.status === 'NEW').map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS_META[s].label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Priority" htmlFor="td-priority" hint="Changing the priority applies that priority's SLA targets.">
                <Select value={t.priority} disabled={!editable} onValueChange={(p) => void act(() => updateTicket(t.id, { priority: p }), 'Priority changed.')}>
                  <SelectTrigger id="td-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Assigned agent" htmlFor="td-agent">
                <AgentSelect id="td-agent" agents={agents.data ?? []} value={t.assigned_agent_id} disabled={!perms.assign || closed}
                  onChange={(a) => void act(() => assignTicket(t.id, a), 'Assignment changed.')} />
              </Field>
              {perms.manageTickets && <CsatEditor key={`${t.csat_rating}-${t.csat_comment}`} rating={t.csat_rating} comment={t.csat_comment} onSave={(r, c) => act(() => updateTicket(t.id, { csat_rating: r, csat_comment: c }), 'Satisfaction rating saved.')} />}
              {!perms.manageTickets && <p className="text-xs text-muted-foreground">Your role can view tickets but not change them.</p>}
            </CardContent>
          </Card>
          <NotesCard d={d} canAdd={perms.reply} tz={tz} onAdd={(body) => act(() => addNote('TICKET', t.id, body), 'Note added.')} />
          <AttachmentsCard d={d} canAdd={perms.reply} companyId={access?.company?.id ?? null} onUploaded={reload} />
          <Card>
            <CardHeader><CardTitle>Activity history</CardTitle></CardHeader>
            <CardContent>
              <Timeline timezone={tz} items={d.events.map((e) => ({ type: 'event' as const, id: e.id, at: e.at, event_type: e.event_type, from: e.from, to: e.to, author: e.author }))} />
            </CardContent>
          </Card>
        </div>
      </div>
      <ReasonDialog open={mergeOpen} onOpenChange={setMergeOpen} title={`Merge ${t.ticket_number} into another ticket`}
        description="Use this for duplicates. This ticket is closed and points to the ticket you keep; its conversations move there. Nothing is deleted."
        confirmLabel="Merge" valueLabel="Ticket to keep (number)"
        onConfirm={async (reason, number) => {
          const r = await fetchTickets({ search: number, limit: 5, offset: 0 })
          const target = r.rows.find((x) => x.ticket_number.toUpperCase() === number.toUpperCase())
          if (!target) throw new Error(`Ticket ${number} was not found.`)
          await mergeTicket(t.id, target.id, reason)
          navigate(`/support/tickets/${target.id}`)
        }} />
      <ReasonDialog open={reopenOpen} onOpenChange={setReopenOpen} title={`Reopen ${t.ticket_number}`} description="The ticket goes back to Open and the reopen is recorded in its history."
        confirmLabel="Reopen" onConfirm={async (reason) => { await reopenTicket(t.id, reason); setNotice('Ticket reopened.'); reload() }} />
    </>
  )
}

function EditTicket({ d, onSave }: { d: TicketDetail; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const t = d.ticket
  const [v, setV] = useState({ subject: t.subject, category: t.category ?? '', subcategory: t.subcategory ?? '', department: t.department ?? '', description: t.description ?? '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = v.subject !== t.subject || v.category !== (t.category ?? '') || v.subcategory !== (t.subcategory ?? '') || v.department !== (t.department ?? '') || v.description !== (t.description ?? '')
  const save = async () => {
    if (v.subject.trim().length < 3) { setErr('Enter a subject (at least 3 characters).'); return }
    setErr(null); setBusy(true)
    try { await onSave({ subject: v.subject.trim(), category: v.category.trim(), subcategory: v.subcategory.trim(), department: v.department.trim(), description: v.description.trim() }) } finally { setBusy(false) }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }))
  return (
    <Card>
      <CardHeader><CardTitle>Details</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <Field label="Subject" htmlFor="te-subject" error={err ?? undefined} className="sm:col-span-2"><Input id="te-subject" value={v.subject} onChange={set('subject')} maxLength={200} /></Field>
          <Field label="Category" htmlFor="te-category"><Input id="te-category" value={v.category} onChange={set('category')} maxLength={80} /></Field>
          <Field label="Subcategory" htmlFor="te-subcategory"><Input id="te-subcategory" value={v.subcategory} onChange={set('subcategory')} maxLength={80} /></Field>
          <Field label="Department" htmlFor="te-department" className="sm:col-span-2"><Input id="te-department" value={v.department} onChange={set('department')} maxLength={80} /></Field>
          <Field label="Description" htmlFor="te-description" className="sm:col-span-2"><Textarea id="te-description" value={v.description} onChange={set('description')} rows={4} maxLength={10000} /></Field>
          <div className="flex justify-end sm:col-span-2"><Button type="submit" size="sm" disabled={!dirty || busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save details</Button></div>
        </form>
      </CardContent>
    </Card>
  )
}

function CsatEditor({ rating, comment, onSave }: { rating: number | null; comment: string | null; onSave: (r: number | null, c: string | null) => Promise<void> }) {
  const [r, setR] = useState(rating ? String(rating) : 'none')
  const [c, setC] = useState(comment ?? '')
  return (
    <div className="space-y-2 border-t pt-3">
      <Field label="Customer satisfaction (as given by the customer)" htmlFor="td-csat">
        <Select value={r} onValueChange={setR}>
          <SelectTrigger id="td-csat"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Not rated</SelectItem>{[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}>{n} / 5</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Input aria-label="Satisfaction comment" value={c} onChange={(e) => setC(e.target.value)} placeholder="Comment (optional)" maxLength={1000} />
      <div className="flex justify-end"><Button size="sm" variant="outline" disabled={r === (rating ? String(rating) : 'none') && c === (comment ?? '')}
        onClick={() => void onSave(r === 'none' ? null : Number(r), c.trim() || null)}>Save rating</Button></div>
    </div>
  )
}

function NotesCard({ d, canAdd, tz, onAdd }: { d: TicketDetail; canAdd: boolean; tz?: string; onAdd: (body: string) => Promise<void> }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Card>
      <CardHeader><div><CardTitle className="flex items-center gap-2"><StickyNote className="size-4" />Internal notes</CardTitle><CardDescription>Visible to agents only.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3">
        {d.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
          <ul className="space-y-2">{d.notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm"><p className="text-xs text-amber-900">{n.author ?? 'Agent'} · {formatDateTime(n.at, tz)}</p>
              <p className="whitespace-pre-wrap">{n.body}</p></li>
          ))}</ul>
        )}
        {canAdd && (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (!body.trim()) return; setBusy(true); void onAdd(body.trim()).then(() => setBody('')).finally(() => setBusy(false)) }}>
            <Textarea aria-label="New internal note" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={5000} />
            <div className="flex justify-end"><Button type="submit" size="sm" disabled={!body.trim() || busy}>Add note</Button></div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function AttachmentsCard({ d, canAdd, companyId, onUploaded }: { d: TicketDetail; canAdd: boolean; companyId: string | null; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [sensitive, setSensitive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upload = async () => {
    if (!file || !companyId) return
    if (file.size > 25 * 1024 * 1024) { setError('Files can be at most 25 MB.'); return }
    setBusy(true); setError(null)
    try { await uploadAttachment(companyId, { ticket_id: d.ticket.id }, file, sensitive); setFile(null); setSensitive(false); onUploaded() } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Paperclip className="size-4" />Attachments</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {d.attachments.length === 0 ? <p className="text-sm text-muted-foreground">No attachments.</p> : (
          <Timeline items={d.attachments.map((a) => ({ type: 'attachment' as const, id: a.id, at: a.at, file_name: a.file_name, content_type: a.content_type, size_bytes: a.size_bytes,
            is_sensitive: a.is_sensitive, is_recording: a.is_recording, storage_path: a.storage_path, restricted: a.restricted }))} />
        )}
        {canAdd && (
          <div className="space-y-2 border-t pt-3">
            <Input type="file" aria-label="Attachment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={sensitive} onCheckedChange={(v) => setSensitive(v === true)} />Sensitive (only users who manage tickets can open it)</label>
            {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
            <div className="flex justify-end"><Button size="sm" variant="outline" disabled={!file || busy} onClick={() => void upload()}>{busy && <Loader2 className="animate-spin" />}Upload</Button></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

