import { ExternalLink, Loader2, StickyNote, Tag, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CustomerSection, TicketSection } from '@/features/support/inbox-view'
import { AgentSelect, Field, PriorityBadge, SlaBadge, TicketStatusBadge } from '@/features/support/support-components'
import { CONVERSATION_STATUSES, CONVERSATION_STATUS_META, PRIORITIES, PRIORITY_META, type ConversationStatus, type Priority } from '@/features/support/support-model'
import type { useSupportPermissions } from '@/features/support/use-support-permissions'
import { IconButton, WaAvatar } from '@/features/support/wa-web/wa-ui'
import { formatWaNumber } from '@/features/support/wa-web/wa-web-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  addNote, assignConversation, fetchCustomerProfile, linkConversationCustomer, linkTicketConversation, setConversationTags, updateConversation,
  type Agent, type ConversationDetail, type TagRef,
} from '@/services/support'
import type { WaThread } from '@/services/whatsapp'

export interface InfoContext {
  d: ConversationDetail
  thread: WaThread | null
  name: string
  perms: ReturnType<typeof useSupportPermissions>
  agents: Agent[]
  tags: TagRef[]
  timezone?: string
  act: (fn: () => Promise<unknown>) => Promise<void>
  onCreateTicket: () => void
  onNewCustomer: () => void
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="bg-white px-5 py-4 shadow-[0_1px_3px_rgba(11,20,26,0.08)]" data-testid={testId}>
      <h3 className="mb-3 text-sm text-[#667781]">{title}</h3>
      {children}
    </section>
  )
}

/** Contact card (avatar, name, WhatsApp number and profile name). */
export function ContactHeader({ ctx }: { ctx: InfoContext }) {
  const c = ctx.d.conversation
  const number = formatWaNumber(ctx.thread?.contact.wa_id ?? c.contact_phone)
  return (
    <section className="flex flex-col items-center bg-white px-5 pb-5 pt-7 text-center shadow-[0_1px_3px_rgba(11,20,26,0.08)]">
      <WaAvatar name={ctx.name} seed={c.id} size={120} />
      <h2 className="mt-4 text-xl text-[#111B21]">{ctx.name}</h2>
      {number && <p className="mt-1 text-base text-[#667781]">{number}</p>}
      {ctx.thread?.contact.profile_name && ctx.thread.contact.profile_name !== ctx.name && <p className="mt-1 text-sm text-[#667781]">~{ctx.thread.contact.profile_name} (WhatsApp profile name)</p>}
      {!ctx.thread?.contact.wa_id && ctx.thread?.contact.user_id && <p className="mt-1 text-xs text-[#667781]">WhatsApp user {ctx.thread.contact.user_id} (number not shared)</p>}
    </section>
  )
}

/** Status, priority, agent and tags of the conversation (the existing permission rules apply). */
export function ConversationControls({ ctx }: { ctx: InfoContext }) {
  const c = ctx.d.conversation
  const id = c.id
  const tagIds = ctx.d.tags.map((t) => t.id)
  return (
    <Section title="Support" testId="wa-info-support">
      <div className="grid gap-3">
        <Field label="Status" htmlFor="wa-cv-status">
          <Select value={c.status} disabled={!ctx.perms.reply} onValueChange={(s) => void ctx.act(() => updateConversation(id, { status: s as ConversationStatus }))}>
            <SelectTrigger id="wa-cv-status"><SelectValue /></SelectTrigger>
            <SelectContent>{CONVERSATION_STATUSES.map((s) => <SelectItem key={s} value={s}>{CONVERSATION_STATUS_META[s].label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Priority" htmlFor="wa-cv-priority">
          <Select value={c.priority} disabled={!ctx.perms.reply} onValueChange={(p) => void ctx.act(() => updateConversation(id, { priority: p as Priority }))}>
            <SelectTrigger id="wa-cv-priority"><SelectValue /></SelectTrigger>
            <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Assigned agent" htmlFor="wa-cv-agent">
          <AgentSelect id="wa-cv-agent" agents={ctx.agents} value={c.assigned_agent_id} disabled={!ctx.perms.assign} onChange={(a) => void ctx.act(() => assignConversation(id, a))} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {ctx.d.tags.map((t) => <StatusBadge key={t.id} label={t.name} tone={t.color as never} />)}
          {ctx.perms.reply && ctx.tags.length > 0 && (
            <Popover>
              <PopoverTrigger asChild><Button variant="outline" size="sm"><Tag /> Tags</Button></PopoverTrigger>
              <PopoverContent className="w-56 space-y-2">
                {ctx.tags.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={tagIds.includes(t.id)} onCheckedChange={(on) => void ctx.act(() => setConversationTags(id, on ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id)))} />
                    {t.name}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </Section>
  )
}

/** Linked support customer, the ERP customer behind it and their history (tickets, conversations). */
export function CustomerInfo({ ctx, full = false }: { ctx: InfoContext; full?: boolean }) {
  const id = ctx.d.conversation.id
  const customerId = ctx.d.customer?.id ?? null
  const profile = useAsync(() => (customerId ? fetchCustomerProfile(customerId) : Promise.resolve(null)), [customerId])
  const p = profile.data
  return (
    <Section title="Customer" testId="wa-info-customer">
      <CustomerSection d={ctx.d} canEdit={ctx.perms.reply} onLink={(cid) => void ctx.act(() => linkConversationCustomer(id, cid))} onNew={ctx.onNewCustomer} />
      {customerId && (profile.loading ? <p className="mt-3 flex items-center gap-2 text-xs text-[#667781]"><Loader2 className="size-3 animate-spin" />Loading customer history…</p>
        : profile.error ? <p className="mt-3 text-xs text-red-700">{describeDataError(profile.error)}</p>
        : p && (
          <div className="mt-3 space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {p.customer.company_name && <><dt className="text-[#667781]">Company</dt><dd>{p.customer.company_name}</dd></>}
              {p.customer.phones.length > 0 && <><dt className="text-[#667781]">Phones</dt><dd>{p.customer.phones.join(', ')}</dd></>}
              {p.customer.emails.length > 0 && <><dt className="text-[#667781]">Emails</dt><dd className="break-all">{p.customer.emails.join(', ')}</dd></>}
              {full && p.customer.address && <><dt className="text-[#667781]">Address</dt><dd>{p.customer.address}</dd></>}
            </dl>
            <div className="rounded-md border border-[#E9EDEF] px-3 py-2" data-testid="wa-erp-customer">
              <p className="text-xs text-[#667781]">ERP customer</p>
              {p.erp_customer ? <p className="font-medium">{p.erp_customer.customer_name} <span className="text-xs font-normal text-[#667781]">· {p.erp_customer.customer_code}{p.erp_customer.gstin ? ` · GSTIN ${p.erp_customer.gstin}` : ''}</span></p>
                : <p className="text-[#667781]">Not linked to an ERP customer (link it on the customer profile).</p>}
            </div>
            <div>
              <p className="mb-1 text-xs text-[#667781]">Tickets ({p.tickets.length})</p>
              {p.tickets.length ? (
                <ul className="space-y-1">{p.tickets.slice(0, full ? 20 : 5).map((t) => (
                  <li key={t.id} className="flex items-center gap-2"><Link className="font-medium text-[#008069] hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link>
                    <span className="min-w-0 flex-1 truncate">{t.subject}</span><TicketStatusBadge status={t.status} /></li>
                ))}</ul>
              ) : <p className="text-[#667781]">No tickets.</p>}
            </div>
            <p className="text-xs text-[#667781]">{p.conversations.length} conversation{p.conversations.length === 1 ? '' : 's'} · {p.calls.length} call{p.calls.length === 1 ? '' : 's'} · {p.emails.length} email{p.emails.length === 1 ? '' : 's'}</p>
            <Link to={`/support/customers/${customerId}`} className="inline-flex items-center gap-1 text-sm text-[#008069] hover:underline">Open customer profile <ExternalLink className="size-3.5" /></Link>
          </div>
        ))}
    </Section>
  )
}

/** Active ticket (number, status, priority, SLA) or create / link one. */
export function TicketInfo({ ctx }: { ctx: InfoContext }) {
  const t = ctx.d.ticket
  return (
    <Section title="Ticket" testId="wa-info-ticket">
      {t ? (
        <div className="space-y-2 text-sm" data-testid="wa-active-ticket">
          <p><Link className="font-medium text-[#008069] hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link> <span>{t.subject}</span></p>
          <div className="flex flex-wrap items-center gap-1.5"><TicketStatusBadge status={t.status} /><PriorityBadge priority={t.priority} /><SlaBadge status={t.sla_status} /></div>
          <p className="text-xs text-[#667781]">Conversation agent: {ctx.d.agent?.display_name ?? 'Unassigned'}</p>
          <Link to={`/support/tickets/${t.id}`} className="inline-flex items-center gap-1 text-[#008069] hover:underline">Open ticket <ExternalLink className="size-3.5" /></Link>
        </div>
      ) : <TicketSection d={ctx.d} canManage={ctx.perms.manageTickets} onCreate={ctx.onCreateTicket} onLink={(ticketId) => ctx.act(() => linkTicketConversation(ticketId, ctx.d.conversation.id))} />}
    </Section>
  )
}

/** Internal notes: agents only, never sent to the customer (support_note_add stores them apart from messages). */
export function NotesInfo({ ctx }: { ctx: InfoContext }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notes = ctx.d.timeline.filter((e) => e.type === 'note')
  const add = async () => {
    if (!body.trim()) { setError('Enter the note.'); return }
    setBusy(true); setError(null)
    try { await ctx.act(() => addNote('CONVERSATION', ctx.d.conversation.id, body.trim())); setBody('') } finally { setBusy(false) }
  }
  return (
    <Section title="Internal notes" testId="wa-info-notes">
      <p className="mb-2 flex items-center gap-1.5 text-xs text-amber-900"><StickyNote className="size-3.5" />Visible to agents only — never sent to the customer on WhatsApp.</p>
      <ul className="mb-3 max-h-64 space-y-2 overflow-y-auto">
        {notes.map((n) => (
          <li key={n.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
            <p className="mb-0.5 text-xs text-amber-900">{n.author ?? 'Agent'} · {formatDateTime(n.at, ctx.timezone)}</p>
            <p className="whitespace-pre-wrap text-amber-950">{n.body}</p>
          </li>
        ))}
        {!notes.length && <li className="text-sm text-[#667781]">No internal notes yet.</li>}
      </ul>
      {ctx.perms.reply && (
        <div className="space-y-2">
          <Textarea aria-label="Internal note" rows={2} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add an internal note" data-testid="wa-note-input" />
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void add()} data-testid="wa-note-add">{busy && <Loader2 className="animate-spin" />}Add note</Button>
        </div>
      )}
    </Section>
  )
}

/** Right-hand drawer: contact, support controls, ticket, customer, notes. */
export function InfoPanel({ ctx, onClose, className }: { ctx: InfoContext; onClose: () => void; className?: string }) {
  return (
    <aside aria-label="Contact and support information" data-testid="wa-info" className={cn('flex h-full flex-col bg-[#F0F2F5]', className)}>
      <header className="flex h-[60px] shrink-0 items-center gap-3 bg-white px-3 shadow-[0_1px_3px_rgba(11,20,26,0.08)]">
        <IconButton label="Close contact info" onClick={onClose}><X /></IconButton>
        <h2 className="text-base text-[#111B21]">Contact info</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pb-6">
        <ContactHeader ctx={ctx} />
        <TicketInfo ctx={ctx} />
        <ConversationControls ctx={ctx} />
        <CustomerInfo ctx={ctx} />
        <NotesInfo ctx={ctx} />
      </div>
    </aside>
  )
}
