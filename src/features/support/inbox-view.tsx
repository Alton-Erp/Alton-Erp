import { ArrowLeft, Inbox, Loader2, MailPlus, MessageSquarePlus, Reply, ReplyAll, Search, Tag, Ticket, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/common/status-badge'
import { AgentSelect, ChannelIcon, ChannelStatusStrip, ConversationStatusBadge, Field, IntegrationBadge, PriorityBadge, Timeline } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CustomerFormDialog, CustomerPicker, LogConversationDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { CallButton } from '@/features/support/phone-components'
import { EmailCard, EmailComposeDialog, type ComposeTarget } from '@/features/support/email-components'
import { fetchComposeContext, fetchEmailThread, mirrorMailboxRead } from '@/services/email'
import { WhatsAppPanel } from '@/features/support/whatsapp-components'
import { fetchWaThread } from '@/services/whatsapp'
import {
  CALL_STATUSES, CALL_STATUS_LABELS, CHANNEL_LABELS, CONVERSATION_STATUSES, CONVERSATION_STATUS_META, INBOX_VIEWS, INBOX_VIEW_LABELS, PRIORITIES, PRIORITY_META,
  replyBlockedReason, type Channel, type ConversationStatus, type InboxView, type Priority,
} from '@/features/support/support-model'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  addMessage, addNote, assignConversation, fetchAgents, fetchChannelStatus, fetchConversation, fetchInbox, fetchTags, fetchTickets, linkConversationCustomer,
  linkTicketConversation, markConversationRead, setConversationTags, updateConversation, type ConversationDetail,
} from '@/services/support'

const PAGE_SIZE = 25

/**
 * Unified inbox: the conversation list (filters, search through the message history, pagination — all on the server)
 * and the selected conversation. With `channel`, only that channel's conversations (Calls, WhatsApp, Emails pages).
 */
export function InboxView({ channel }: { channel?: Channel }) {
  const views = (channel ? INBOX_VIEWS.filter((v) => !['PHONE', 'WHATSAPP', 'EMAIL'].includes(v)) : INBOX_VIEWS) as InboxView[]
  const [view, setView] = useUrlParam('view', 'ALL')
  const [selected, setSelected] = useUrlParam('c', '')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [logOpen, setLogOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const perms = useSupportPermissions()
  useEffect(() => { const t = setTimeout(() => { setTerm(search); setPage(0) }, 300); return () => clearTimeout(t) }, [search])
  const v = (views.includes(view as InboxView) ? view : 'ALL') as InboxView
  const list = useAsync(() => fetchInbox(v, { channel: channel ?? null, search: term, limit: PAGE_SIZE, offset: page * PAGE_SIZE }), [v, channel, term, page, refresh])
  const channels = useAsync(fetchChannelStatus, [refresh])
  const reload = () => setRefresh((n) => n + 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ChannelStatusStrip channels={channels.data} only={channel} />
        {perms.reply && <Button onClick={() => setLogOpen(true)} data-testid="log-conversation"><MessageSquarePlus /> Log a conversation</Button>}
      </div>
      {notice && <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900" data-testid="inbox-notice">{notice}</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className={cn('gap-0 overflow-hidden p-0', selected && 'hidden lg:flex')}>
          <div className="space-y-3 border-b p-3">
            <FilterTabs<InboxView> label="Inbox filter" value={v} onChange={(x) => { setView(x); setPage(0) }}
              options={views.map((x) => ({ value: x, label: INBOX_VIEW_LABELS[x], count: x === 'ALL' || x === 'UNASSIGNED' || x === 'MINE' || x === 'OPEN' || x === 'PENDING' ? list.data?.counts?.[x] : undefined }))} />
            <div className="relative">
              <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input aria-label="Search conversations" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email, ticket or message text" />
            </div>
          </div>
          {list.loading && !list.data ? <LoadingState rows={6} />
            : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
            : !list.data || list.data.rows.length === 0 ? (
              <EmptyState compact icon={Inbox} title={term ? 'No conversation matches' : 'No conversations'}
                description={term ? 'Try another search or filter.' : v === 'MINE' && !list.data?.me ? 'You are not set up as a support agent yet.' : 'Conversations appear here when a channel is connected or when one is logged.'} />
            ) : (
              <ul className="divide-y" data-testid="inbox-list">
                {list.data.rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setSelected(r.id)} aria-current={selected === r.id ? 'true' : undefined}
                      className={cn('w-full px-3 py-2.5 text-left hover:bg-muted/60', selected === r.id && 'bg-accent')} data-testid={`conversation-${r.id}`}>
                      <div className="flex items-start gap-2">
                        <ChannelIcon channel={r.channel} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className={cn('truncate text-sm', r.unread_count > 0 ? 'font-semibold' : 'font-medium')}>{r.customer_name ?? 'Unknown contact'}</span>
                            <time className="shrink-0 text-[11px] text-muted-foreground">{formatDateTime(r.last_activity_at)}</time>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{[r.phone, r.email].filter(Boolean).join(' · ') || '—'}</p>
                          <p className="mt-0.5 truncate text-sm">{r.subject ? <span className="font-medium">{r.subject}: </span> : null}{r.last_message_preview ?? ''}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                            <ConversationStatusBadge status={r.status} /><PriorityBadge priority={r.priority} />
                            <span className="text-muted-foreground">{r.assigned_agent ?? 'Unassigned'}</span>
                            {r.ticket_number && <span className="text-muted-foreground">· {r.ticket_number}</span>}
                            {r.tags.map((t) => <StatusBadge key={t.id} label={t.name} tone={t.color as never} />)}
                            {r.unread_count > 0 && <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" aria-label={`${r.unread_count} unread`}>{r.unread_count}</span>}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          {list.data && list.data.total > PAGE_SIZE && <PaginationBar page={page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={setPage} disabled={list.loading} />}
        </Card>
        <div className={cn(!selected && 'hidden lg:block')}>
          {selected ? <ConversationPane id={selected} onBack={() => setSelected('')} onChanged={reload} />
            : <Card><EmptyState icon={Inbox} title="Select a conversation" description="Its timeline, customer, ticket and replies appear here." /></Card>}
        </div>
      </div>
      <LogConversationDialog open={logOpen} onOpenChange={setLogOpen} defaultChannel={channel ?? 'PHONE'}
        onCreated={(r) => {
          setNotice(r.match === 'MATCHED' ? 'Conversation logged and linked to the matching customer.'
            : r.match === 'AMBIGUOUS' ? `Conversation logged. ${r.candidates} customers share this phone or email: link the right one.`
            : r.match === 'NO_MATCH' ? 'Conversation logged. No customer matched: link or create one.' : 'Conversation logged.')
          setSelected(r.id); reload()
        }} />
    </div>
  )
}

function ConversationPane({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? undefined
  const perms = useSupportPermissions()
  const navigate = useNavigate()
  const [refresh, setRefresh] = useState(0)
  const detail = useAsync(() => fetchConversation(id), [id, refresh])
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const tags = useAsync(() => fetchTags().catch(() => []), [])
  const [error, setError] = useState<string | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const isEmail = detail.data?.conversation.channel === 'EMAIL'
  const thread = useAsync(() => (isEmail ? fetchEmailThread(id) : Promise.resolve(null)), [id, refresh, isEmail])
  const mail = useAsync(() => (isEmail ? fetchComposeContext().catch(() => null) : Promise.resolve(null)), [isEmail])
  const [compose, setCompose] = useState<ComposeTarget | null>(null)
  const isWa = detail.data?.conversation.channel === 'WHATSAPP'
  const waThread = useAsync(() => (isWa ? fetchWaThread(id).catch(() => null) : Promise.resolve(null)), [id, refresh, isWa])
  useEffect(() => {
    if (!detail.data?.conversation.unread_count) return
    void markConversationRead(id).then(() => {
      onChanged()
      // Mirror "read" to Gmail only when gmail.modify was explicitly enabled and granted.
      if (detail.data?.conversation.channel === 'EMAIL') void fetchComposeContext().then((ctx) => (ctx.mailbox_modify ? mirrorMailboxRead(id) : null)).catch(() => {})
    }, () => {})
  }, [detail.data?.conversation.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); setRefresh((n) => n + 1); onChanged() } catch (e) { setError(describeDataError(e)) }
  }
  if (detail.loading && !detail.data) return <Card><LoadingState rows={6} /></Card>
  if (detail.error || !detail.data) return <Card><ErrorState message={describeDataError(detail.error)} onRetry={detail.reload} /></Card>
  const d = detail.data
  const c = d.conversation
  const name = d.customer?.display_name ?? c.contact_name ?? c.contact_phone ?? c.contact_email ?? 'Unknown contact'
  const tagIds = d.tags.map((t) => t.id)
  return (
    <Card className="gap-0 p-0" data-testid="conversation-pane">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={onBack}><ArrowLeft /> Back</Button>
          <CardTitle className="flex items-center gap-2 text-base"><ChannelIcon channel={c.channel} />{name}</CardTitle>
          <p className="text-xs text-muted-foreground">{[c.contact_phone ?? d.customer?.phones?.[0], c.contact_email ?? d.customer?.emails?.[0]].filter(Boolean).join(' · ') || 'No contact details'}
            {c.subject ? ` · ${c.subject}` : ''}
            {(c.contact_phone ?? d.customer?.phones?.[0]) && <CallButton number={(c.contact_phone ?? d.customer?.phones?.[0])!} conversationId={c.id} customerId={c.customer_id} />}</p>
        </div>
        <div className="flex items-center gap-2 text-xs"><span className="text-muted-foreground">{CHANNEL_LABELS[c.channel]}</span><IntegrationBadge status={d.channel_status} testId="pane-channel-status" /></div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Status" htmlFor="cv-status">
            <Select value={c.status} disabled={!perms.reply} onValueChange={(s) => void act(() => updateConversation(id, { status: s as ConversationStatus }))}>
              <SelectTrigger id="cv-status"><SelectValue /></SelectTrigger>
              <SelectContent>{CONVERSATION_STATUSES.map((s) => <SelectItem key={s} value={s}>{CONVERSATION_STATUS_META[s].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Priority" htmlFor="cv-priority">
            <Select value={c.priority} disabled={!perms.reply} onValueChange={(p) => void act(() => updateConversation(id, { priority: p as Priority }))}>
              <SelectTrigger id="cv-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Assigned agent" htmlFor="cv-agent">
            <AgentSelect id="cv-agent" agents={agents.data ?? []} value={c.assigned_agent_id} disabled={!perms.assign} onChange={(a) => void act(() => assignConversation(id, a))} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.tags.map((t) => <StatusBadge key={t.id} label={t.name} tone={t.color as never} />)}
          {perms.reply && (tags.data ?? []).length > 0 && (
            <Popover>
              <PopoverTrigger asChild><Button variant="outline" size="sm"><Tag /> Tags</Button></PopoverTrigger>
              <PopoverContent className="w-56 space-y-2">
                {(tags.data ?? []).map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={tagIds.includes(t.id)} onCheckedChange={(on) => void act(() => setConversationTags(id, on ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id)))} />
                    {t.name}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>

        <CustomerSection d={d} canEdit={perms.reply} onLink={(cid) => void act(() => linkConversationCustomer(id, cid))} onNew={() => setCustomerOpen(true)} />
        <TicketSection d={d} canManage={perms.manageTickets} onCreate={() => setTicketOpen(true)}
          onLink={(ticketId) => act(() => linkTicketConversation(ticketId, id))} />

        {c.channel === 'WHATSAPP' && waThread.data && <WhatsAppPanel conversationId={c.id} timezone={tz} onChanged={() => { setRefresh((n) => n + 1); onChanged() }} />}
        {c.channel === 'EMAIL' && (thread.data?.length ?? 0) > 0 && (
          <section className="space-y-2" aria-label="Email thread" data-testid="email-thread">
            {thread.data!.map((m) => <EmailCard key={m.id} email={m} timezone={tz} canReply={perms.reply && Boolean(mail.data?.can_send)}
              onReply={(mode) => setCompose({ mode, replyTo: m, conversationId: c.id })} />)}
          </section>
        )}
        <div className="max-h-[28rem] overflow-y-auto rounded-lg border bg-surface-muted/40 p-3">
          <Timeline items={d.timeline} timezone={tz} hideIds={c.channel === 'EMAIL' ? new Set((thread.data ?? []).flatMap((m) => [m.message_id, ...m.attachments.map((a) => a.id)]))
            : c.channel === 'WHATSAPP' && waThread.data ? new Set(waThread.data.messages.flatMap((m) => [m.message_id, ...(m.attachment ? [m.attachment.id] : [])])) : undefined} /></div>
        {perms.reply ? <Composer d={d} onDone={() => { setRefresh((n) => n + 1); onChanged() }}
            onEmail={c.channel === 'EMAIL' ? (mode) => {
              const last = [...(thread.data ?? [])].reverse().find((m) => m.direction === 'INBOUND') ?? thread.data?.at(-1) ?? null
              setCompose(last && mode !== 'NEW' ? { mode, replyTo: last, conversationId: c.id } : { mode: 'NEW', conversationId: c.id, customerId: c.customer_id, to: c.contact_email ?? d.customer?.emails?.[0] })
            } : undefined} emailReady={Boolean(mail.data?.can_send)}
            externalReply={c.channel === 'WHATSAPP' && waThread.data ? 'WhatsApp messages are sent from the WhatsApp panel above (the 24-hour window and template rules apply).' : undefined} />
          : <p className="text-sm text-muted-foreground">Your role can view conversations but not reply or add notes.</p>}
      </CardContent>
      <TicketFormDialog open={ticketOpen} onOpenChange={setTicketOpen} conversation={{ id, subject: c.subject }}
        onCreated={(r) => { setRefresh((n) => n + 1); onChanged(); navigate(`/support/tickets/${r.id}`) }} />
      {compose && <EmailComposeDialog target={compose} onClose={() => setCompose(null)} onSent={() => { setRefresh((n) => n + 1); onChanged() }} />}
      <CustomerFormDialog open={customerOpen} onOpenChange={setCustomerOpen}
        preset={{ display_name: c.contact_name ?? '', phones: c.contact_phone ?? '', emails: c.contact_email ?? '' }}
        onSaved={(cid) => void act(() => linkConversationCustomer(id, cid))} />
    </Card>
  )
}

function CustomerSection({ d, canEdit, onLink, onNew }: { d: ConversationDetail; canEdit: boolean; onLink: (id: string | null) => void; onNew: () => void }) {
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  if (d.customer) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="linked-customer">
        <span>Customer: <Link className="font-medium text-primary hover:underline" to={`/support/customers/${d.customer.id}`}>{d.customer.display_name}</Link>
          <span className="text-muted-foreground"> · {d.customer.customer_code}</span></span>
        {canEdit && <Button size="sm" variant="ghost" onClick={() => onLink(null)}>Unlink</Button>}
      </div>
    )
  }
  return (
    <div className="space-y-2 rounded-lg border border-dashed px-3 py-2 text-sm" data-testid="unlinked-customer">
      <p className="font-medium">No customer linked.</p>
      {d.candidates.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">{d.candidates.length > 1 ? 'Several customers match this contact. Choose the right one; nothing is merged automatically.' : 'One customer matches this contact:'}</p>
          <ul className="mt-1 space-y-1">{d.candidates.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2"><span>{c.display_name} <span className="text-xs text-muted-foreground">{c.customer_code} · matched on {c.matched_on?.join(' and ')}</span></span>
              {canEdit && <Button size="sm" variant="outline" onClick={() => onLink(c.id)}>Link</Button>}</li>
          ))}</ul>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1"><CustomerPicker value={picked} onChange={setPicked} /></div>
          <Button size="sm" variant="outline" disabled={!picked} onClick={() => picked && onLink(picked.id)}>Link customer</Button>
          <Button size="sm" variant="outline" onClick={onNew}><UserPlus /> New customer</Button>
        </div>
      )}
    </div>
  )
}

function TicketSection({ d, canManage, onCreate, onLink }: { d: ConversationDetail; canManage: boolean; onCreate: () => void; onLink: (ticketId: string) => Promise<void> }) {
  const [number, setNumber] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (d.ticket) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="linked-ticket">
        <Ticket className="size-4 text-muted-foreground" />
        <Link className="font-medium text-primary hover:underline" to={`/support/tickets/${d.ticket.id}`}>{d.ticket.ticket_number}</Link>
        <span className="truncate">{d.ticket.subject}</span>
      </div>
    )
  }
  if (!canManage) return <p className="text-xs text-muted-foreground">No ticket for this conversation.</p>
  const link = async () => {
    setError(null)
    const r = await fetchTickets({ search: number.trim(), limit: 5, offset: 0 }).catch((e) => { setError(describeDataError(e)); return null })
    const t = r?.rows.find((x) => x.ticket_number.toUpperCase() === number.trim().toUpperCase())
    if (!t) { if (r) setError(`Ticket ${number.trim()} was not found.`); return }
    await onLink(t.id)
  }
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <Button size="sm" onClick={onCreate} data-testid="create-ticket-from-conversation"><Ticket /> Create ticket</Button>
      <Input aria-label="Ticket number to link" className="h-8 w-44" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="ALT-SUP-000001" />
      <Button size="sm" variant="outline" disabled={!number.trim()} onClick={() => void link()}>Link ticket</Button>
      {error && <span className="text-xs text-red-700" role="alert">{error}</span>}
    </div>
  )
}

type Mode = 'REPLY' | 'LOG' | 'NOTE'
function Composer({ d, onDone, onEmail, emailReady, externalReply }: {
  d: ConversationDetail; onDone: () => void; onEmail?: (mode: 'NEW' | 'REPLY' | 'REPLY_ALL') => void; emailReady?: boolean; externalReply?: string
}) {
  const c = d.conversation
  const blocked = replyBlockedReason(c.channel, d.channel_status)
  const [mode, setMode] = useState<Mode>(blocked ? 'LOG' : 'REPLY')
  const [body, setBody] = useState('')
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('OUTBOUND')
  const [callStatus, setCallStatus] = useState('ANSWERED')
  const [duration, setDuration] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setError(null)
    if (mode !== 'LOG' || c.channel !== 'PHONE') { if (!body.trim()) { setError(mode === 'NOTE' ? 'Enter the note.' : 'Enter the message.'); return } }
    if (mode === 'LOG' && c.channel === 'PHONE' && duration.trim() && !/^\d{1,5}$/.test(duration.trim())) { setError('Duration in whole seconds.'); return }
    setBusy(true)
    try {
      if (mode === 'NOTE') await addNote('CONVERSATION', c.id, body.trim())
      else if (mode === 'REPLY') await addMessage(c.id, { mode: 'REPLY', body: body.trim() })
      else await addMessage(c.id, { mode: 'LOG', direction, body: body.trim() || undefined, call_status: c.channel === 'PHONE' ? callStatus : undefined,
        call_duration_seconds: c.channel === 'PHONE' && duration.trim() ? Number(duration) : null })
      setBody(''); setDuration('')
      onDone()
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="composer">
      <FilterTabs<Mode> label="Composer" value={mode} onChange={setMode}
        options={[{ value: 'REPLY', label: c.channel === 'PHONE' ? 'Call' : 'Reply' }, { value: 'LOG', label: c.channel === 'PHONE' ? 'Log a call' : 'Log activity' }, { value: 'NOTE', label: 'Internal note' }]} />
      {mode === 'REPLY' && externalReply && !blocked ? (
        <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground" data-testid="reply-external">{externalReply}</p>
      ) : mode === 'REPLY' && onEmail && !blocked ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="email-reply-actions">
          <Button size="sm" disabled={!emailReady} onClick={() => onEmail('REPLY')}><Reply /> Reply</Button>
          <Button size="sm" variant="outline" disabled={!emailReady} onClick={() => onEmail('REPLY_ALL')}><ReplyAll /> Reply all</Button>
          <Button size="sm" variant="outline" disabled={!emailReady} onClick={() => onEmail('NEW')}><MailPlus /> New email</Button>
          <span className="text-xs text-muted-foreground">Sent from the support mailbox through Gmail; the status shows Sent only when Gmail accepts it.</span>
        </div>
      ) : mode === 'REPLY' && blocked ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="reply-blocked">{blocked}</p>
      ) : (
        <>
          {mode === 'LOG' && (
            <div className="flex flex-wrap gap-2">
              <Select value={direction} onValueChange={(x) => setDirection(x as 'INBOUND' | 'OUTBOUND')}>
                <SelectTrigger aria-label="Direction" className="h-8 w-44"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="OUTBOUND">To the customer</SelectItem><SelectItem value="INBOUND">From the customer</SelectItem></SelectContent>
              </Select>
              {c.channel === 'PHONE' && <>
                <Select value={callStatus} onValueChange={setCallStatus}>
                  <SelectTrigger aria-label="Call result" className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>{CALL_STATUSES.map((s) => <SelectItem key={s} value={s}>{CALL_STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
                </Select>
                <Input aria-label="Duration in seconds" className="h-8 w-36" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="Duration (s)" inputMode="numeric" />
              </>}
            </div>
          )}
          <Textarea aria-label={mode === 'NOTE' ? 'Internal note' : 'Message'} value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={mode === 'NOTE' ? 5000 : 20000}
            placeholder={mode === 'NOTE' ? 'Visible to agents only; never sent to the customer.' : mode === 'LOG' ? 'What was said (logged manually; nothing is sent).' : `Reply through ${CHANNEL_LABELS[c.channel]}`} />
          {mode === 'REPLY' && <p className="text-xs text-muted-foreground">Queued for the {CHANNEL_LABELS[c.channel]} connector; the delivery status appears on the message.</p>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} onClick={() => void send()} data-testid="composer-send">{busy && <Loader2 className="animate-spin" />}
              {mode === 'NOTE' ? 'Add note' : mode === 'LOG' ? 'Log' : 'Send reply'}</Button>
          </div>
        </>
      )}
    </div>
  )
}
