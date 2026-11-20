import { ArrowDown, ArrowLeft, ChevronDown, ChevronUp, Copy, Forward, Loader2, MoreVertical, PanelRight, Search, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { CallButton } from '@/features/support/phone-components'
import { CustomerFormDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { TICKET_EVENT_LABELS, waWindowText } from '@/features/support/support-model'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { WaTemplateDialog } from '@/features/support/whatsapp-components'
import { ContactHeader, ConversationControls, CustomerInfo, InfoPanel, NotesInfo, TicketInfo, type InfoContext } from '@/features/support/wa-web/info-panel'
import { MessageBubble } from '@/features/support/wa-web/message-bubble'
import { MessageInfoDialog } from '@/features/support/wa-web/message-info-dialog'
import { ChatComposer } from '@/features/support/wa-web/chat-composer'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { WALLPAPER_STYLE } from '@/features/support/wa-web/wa-theme'
import { IconButton, WaAvatar } from '@/features/support/wa-web/wa-ui'
import { bubbleTime, buildChatItems, canRetry, copyText, formatWaNumber, searchMessages } from '@/features/support/wa-web/wa-web-model'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchAgents, fetchConversation, fetchTags, linkConversationCustomer, markConversationRead, updateConversation } from '@/services/support'
import { fetchWaThread, sendWaText, type WaMessage, type WaSendResult } from '@/services/whatsapp'

export type WaPane = 'chat' | 'ticket' | 'customer'
const PANES: { value: WaPane; label: string }[] = [{ value: 'chat', label: 'WhatsApp' }, { value: 'ticket', label: 'Ticket' }, { value: 'customer', label: 'Customer' }]

function ChatSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3 p-6" style={WALLPAPER_STYLE} aria-busy="true" aria-label="Loading conversation">
      {[60, 40, 70, 35, 55].map((w, i) => <Skeleton key={i} className={cn('h-10 rounded-lg bg-white/80', i % 2 ? 'ml-auto' : '')} style={{ width: `${w}%` }} />)}
    </div>
  )
}

/**
 * The selected conversation: header, WhatsApp / Ticket / Customer views, the chat, the composer and the contact drawer.
 * Updates by polling (5 s chat, 10 s details) while the tab is visible.
 */
export function ChatWorkspace({ id, infoOpen, setInfoOpen, onBack, onChanged }: {
  id: string; infoOpen: boolean; setInfoOpen: (open: boolean) => void; onBack: () => void; onChanged: () => void
}) {
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? undefined
  const perms = useSupportPermissions()
  const navigate = useNavigate()
  const [paneParam, setPane] = useUrlParam('pane', 'chat')
  const pane = (PANES.some((p) => p.value === paneParam) ? paneParam : 'chat') as WaPane
  const detail = usePolled(() => fetchConversation(id), [id], 10_000)
  const thread = usePolled(() => fetchWaThread(id), [id], 5_000)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const tags = useAsync(() => fetchTags().catch(() => []), [])
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [replyTo, setReplyTo] = useState<WaMessage | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [infoFor, setInfoFor] = useState<WaMessage | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [retried, setRetried] = useState<Set<string>>(new Set())
  const [retrying, setRetrying] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)

  // Opening a conversation marks it read (as the unified inbox does).
  const unread = detail.data?.conversation.unread_count ?? 0
  useEffect(() => {
    if (!unread) return
    void markConversationRead(id).then(onChanged, () => {})
  }, [id, unread]) // eslint-disable-line react-hooks/exhaustive-deps

  const t = thread.data ?? null
  const d = detail.data
  const items = useMemo(() => (t ? buildChatItems(t.messages, d?.timeline ?? [], undefined, tz) : []), [t, d?.timeline, tz])
  const hits = useMemo(() => (t && term.trim() ? searchMessages(t.messages, term) : []), [t, term])
  const byWaId = useMemo(() => new Map((t?.messages ?? []).filter((m) => m.wa_message_id).map((m) => [m.wa_message_id!, m])), [t])

  // Stay at the bottom when new messages arrive, unless the agent scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current
    const n = t?.messages.length ?? 0
    if (el && n !== lastCount.current && (atBottom || lastCount.current === 0)) el.scrollTop = el.scrollHeight
    lastCount.current = n
  }, [t, atBottom, pane])
  useEffect(() => { lastCount.current = 0 }, [id])
  useEffect(() => {
    if (!hits.length) return
    document.querySelector(`[data-testid="wa-${hits[Math.min(hitIndex, hits.length - 1)]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [hits, hitIndex])

  if ((detail.loading && !d) || (thread.loading && !t)) {
    return <div className="flex min-w-0 flex-1 flex-col" data-testid="wa-panel-loading"><div className="h-[60px] bg-[#F0F2F5]" /><ChatSkeleton /></div>
  }
  if (!d) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#F0F2F5] p-6 text-center" role="alert">
        <p className="text-sm text-red-700">{describeDataError(detail.error)}</p>
        <button type="button" onClick={detail.reload} className="rounded-full bg-[#008069] px-4 py-2 text-sm font-medium text-white">Try again</button>
      </div>
    )
  }
  const c = d.conversation
  const name = d.customer?.display_name ?? t?.contact.profile_name ?? c.contact_name ?? formatWaNumber(c.contact_phone) ?? 'Unknown contact'
  const number = formatWaNumber(t?.contact.wa_id ?? c.contact_phone)
  const phoneForCall = c.contact_phone ?? d.customer?.phones?.[0] ?? null
  const reload = () => { thread.reload(); detail.reload(); onChanged() }
  const act = async (fn: () => Promise<unknown>) => {
    setNotice(null)
    try { await fn(); reload() } catch (e) { setNotice({ ok: false, text: describeDataError(e) }) }
  }
  const done = (r: WaSendResult) => { setNotice({ ok: r.status !== 'FAILED', text: r.message }); setReplyTo(null); reload() }
  const copy = (msgs: WaMessage[]) => {
    const text = copyText([...msgs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), name, tz)
    navigator.clipboard?.writeText(text).then(() => setNotice({ ok: true, text: msgs.length > 1 ? `${msgs.length} messages copied.` : 'Message copied.' }),
      () => setNotice({ ok: false, text: 'The browser did not allow copying.' }))
  }
  const retry = async (m: WaMessage) => {
    if (retrying) return
    setRetrying(m.id)
    try {
      done(await sendWaText({ idempotency_key: crypto.randomUUID(), conversation_id: id, text: m.body }))
      setRetried((s) => new Set(s).add(m.id))
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) })
    } finally {
      setRetrying(null)
    }
  }
  const jumpTo = (waId: string) => {
    const el = document.getElementById(`wa-msg-${waId}`)
    if (!el) { setNotice({ ok: false, text: 'The quoted message is not in this conversation.' }); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.animate?.([{ backgroundColor: 'rgba(0,168,132,0.25)' }, { backgroundColor: 'transparent' }], { duration: 1400 })
  }
  const toggleSelect = (mid: string) => setSelected((s) => { const n = new Set(s ?? []); if (n.has(mid)) n.delete(mid); else n.add(mid); return n })
  const ctx: InfoContext = {
    d, thread: t, name, perms, agents: agents.data ?? [], tags: tags.data ?? [], timezone: tz, act,
    onCreateTicket: () => setTicketOpen(true), onNewCustomer: () => setCustomerOpen(true),
  }
  const canReply = Boolean(t?.can_send && t.window_open)
  const selectedMsgs = (t?.messages ?? []).filter((m) => selected?.has(m.id))

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-[#EFEAE2]" aria-label={`Conversation with ${name}`} data-testid="wa-panel" data-conversation={id}>
        {selected ? (
          <header className="flex h-[60px] shrink-0 items-center gap-2 bg-[#F0F2F5] px-2 md:px-4" data-testid="wa-select-bar">
            <IconButton label="Cancel selection" onClick={() => setSelected(null)}><X /></IconButton>
            <span className="flex-1 text-[#111B21]">{selected.size} selected</span>
            <IconButton label="Copy" disabled={!selected.size} onClick={() => { copy(selectedMsgs); setSelected(null) }}><Copy /></IconButton>
            <IconButton label="Forward" disabled tooltip="Forwarding is not supported by the ERP’s WhatsApp connector."><Forward /></IconButton>
            <IconButton label="Delete" disabled tooltip="Messages cannot be deleted: the support history is kept."><Trash2 /></IconButton>
          </header>
        ) : (
          <header className="flex h-[60px] shrink-0 items-center gap-1 bg-[#F0F2F5] px-2 md:px-4">
            <IconButton label="Back to conversations" onClick={onBack} className="md:hidden"><ArrowLeft /></IconButton>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left" onClick={() => setInfoOpen(!infoOpen)} aria-label={`Contact info for ${name}`}>
              <WaAvatar name={name} seed={c.id} size={40} />
              <span className="min-w-0">
                <span className="block truncate text-base text-[#111B21]" data-testid="wa-chat-name">{name}</span>
                <span className="block truncate text-[13px] text-[#667781]">{[number, d.ticket ? d.ticket.ticket_number : null, d.agent ? `Agent: ${d.agent.display_name}` : 'Unassigned'].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
            <IconButton label="Search messages" onClick={() => { setSearchOpen((o) => !o); setTerm('') }} data-testid="wa-search-toggle"><Search /></IconButton>
            {phoneForCall && <span className="hidden sm:inline-flex"><CallButton number={phoneForCall} conversationId={c.id} customerId={c.customer_id} /></span>}
            <IconButton label={infoOpen ? 'Hide contact info' : 'Contact info'} onClick={() => setInfoOpen(!infoOpen)} className={cn(infoOpen && 'bg-black/5')} data-testid="wa-info-toggle"><PanelRight /></IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" aria-label="More options" title="More options" className="inline-flex size-10 items-center justify-center rounded-full text-[#54656F] hover:bg-black/5"><MoreVertical className="size-5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setInfoOpen(true)}>Contact info</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSelected(new Set())}>Select messages</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSearchOpen(true)}>Search</DropdownMenuItem>
                {!d.ticket && perms.manageTickets && <DropdownMenuItem onSelect={() => setTicketOpen(true)}>Create ticket</DropdownMenuItem>}
                {d.ticket && <DropdownMenuItem onSelect={() => navigate(`/support/tickets/${d.ticket!.id}`)}>Open ticket {d.ticket.ticket_number}</DropdownMenuItem>}
                {perms.reply && <DropdownMenuSeparator />}
                {perms.reply && (c.status === 'RESOLVED'
                  ? <DropdownMenuItem onSelect={() => void act(() => updateConversation(id, { status: 'OPEN' }))}>Reopen conversation</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={() => void act(() => updateConversation(id, { status: 'RESOLVED' }))}>Mark conversation resolved</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
        )}
        <div role="tablist" aria-label="View" className="flex shrink-0 gap-1 border-b border-[#E9EDEF] bg-[#F0F2F5] px-3 md:px-4">
          {PANES.map((p) => (
            <button key={p.value} type="button" role="tab" aria-selected={pane === p.value} onClick={() => setPane(p.value)} data-testid={`wa-view-${p.value}`}
              className={cn('border-b-[3px] px-3 py-1.5 text-sm', pane === p.value ? 'border-[#008069] font-medium text-[#008069]' : 'border-transparent text-[#667781] hover:text-[#111B21]')}>{p.label}</button>
          ))}
        </div>
        {searchOpen && pane === 'chat' && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[#E9EDEF] bg-white px-3 py-1.5" data-testid="wa-search">
            <Search className="size-4 text-[#54656F]" aria-hidden />
            <input autoFocus aria-label="Search in this conversation" value={term} onChange={(e) => { setTerm(e.target.value); setHitIndex(0) }} placeholder="Search in this conversation"
              onKeyDown={(e) => { if (e.key === 'Enter' && hits.length) setHitIndex((i) => (i + (e.shiftKey ? hits.length - 1 : 1)) % hits.length); if (e.key === 'Escape') { setSearchOpen(false); setTerm('') } }}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            {term.trim() && <span className="text-xs text-[#667781]" aria-live="polite">{hits.length ? `${Math.min(hitIndex, hits.length - 1) + 1} of ${hits.length}` : 'No messages found'}</span>}
            <IconButton label="Previous match" className="size-8" disabled={!hits.length} onClick={() => setHitIndex((i) => (i + hits.length - 1) % hits.length)}><ChevronUp /></IconButton>
            <IconButton label="Next match" className="size-8" disabled={!hits.length} onClick={() => setHitIndex((i) => (i + 1) % hits.length)}><ChevronDown /></IconButton>
            <IconButton label="Close search" className="size-8" onClick={() => { setSearchOpen(false); setTerm('') }}><X /></IconButton>
          </div>
        )}

        {pane === 'chat' ? (
          <>
            <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto py-3" style={WALLPAPER_STYLE}
              onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }}>
              {!t ? (
                <p className="mx-auto mt-10 w-fit rounded-lg bg-[#FFEECD] px-4 py-2 text-center text-sm text-[#54656F]">
                  {thread.error ? describeDataError(thread.error) : 'This conversation has no WhatsApp thread (it was logged manually).'}</p>
              ) : (
                <ol className="space-y-0.5" data-testid="wa-messages" aria-live="polite" aria-relevant="additions">
                  <li className="mb-2 flex justify-center px-6"><span className="rounded-lg bg-[#FFEECD] px-3 py-1.5 text-center text-[12.5px] text-[#54656F]">
                    WhatsApp Cloud API conversation. Ticks show only what Meta reports; internal notes are never sent.</span></li>
                  {items.map((it) => {
                    if (it.kind === 'day') return <li key={it.key} className="sticky top-1 z-[1] flex justify-center py-1.5"><span className="rounded-lg bg-white px-3 py-1 text-[12.5px] text-[#54656F] shadow-sm" data-testid="wa-day">{it.label}</span></li>
                    if (it.kind === 'event') {
                      const e = it.item
                      return (
                        <li key={it.key} className="flex justify-center px-6 py-1" data-kind="event">
                          <span className="rounded-lg bg-white/90 px-3 py-1 text-center text-[12.5px] text-[#54656F] shadow-sm">
                            {TICKET_EVENT_LABELS[e.event_type ?? ''] ?? e.event_type}{e.from || e.to ? ` · ${[e.from, e.to].filter(Boolean).join(' → ')}` : ''}{e.author ? ` · ${e.author}` : ''} · {bubbleTime(e.at, tz)}</span>
                        </li>
                      )
                    }
                    if (it.kind === 'logged') {
                      const e = it.item
                      const inbound = e.direction === 'INBOUND'
                      return (
                        <li key={it.key} className={cn('flex px-[5%] py-0.5', inbound ? 'justify-start' : 'justify-end')} data-kind="logged">
                          <div className={cn('max-w-[65%] rounded-lg border border-dashed border-[#8696A0] px-2 py-1.5 text-[14.2px]', inbound ? 'bg-white/80' : 'bg-[#D9FDD3]/80')}>
                            <p className="text-[11px] text-[#667781]" title="Recorded by an agent; not received or sent through WhatsApp">Logged manually · {inbound ? 'from the customer' : e.author ?? 'agent'}</p>
                            {e.body && <p className="whitespace-pre-wrap">{e.body}</p>}
                            <span className="float-right text-[11px] text-[#667781]">{bubbleTime(e.at, tz)}</span><span className="clear-both block" />
                          </div>
                        </li>
                      )
                    }
                    const m = it.m
                    return (
                      <MessageBubble key={it.key} m={m} customerName={name} quoted={m.context_wa_message_id ? byWaId.get(m.context_wa_message_id) ?? null : null} timezone={tz}
                        search={term} isHit={hits[Math.min(hitIndex, hits.length - 1)] === m.id} selecting={Boolean(selected)} selected={Boolean(selected?.has(m.id))}
                        canReply={canReply && m.direction === 'INBOUND'}
                        retry={{ allowed: canRetry(m, { windowOpen: Boolean(t.window_open), canSend: Boolean(t.can_send), retried: retried.has(m.id) }), busy: retrying === m.id, onRetry: () => void retry(m) }}
                        onReply={() => setReplyTo(m)} onSelect={() => (selected ? toggleSelect(m.id) : setSelected(new Set([m.id])))} onInfo={() => setInfoFor(m)}
                        onCopy={() => copy([m])} onJumpTo={jumpTo} onChanged={reload} />
                    )
                  })}
                  {!t.messages.length && <li className="py-6 text-center text-sm text-[#667781]">No WhatsApp messages yet.</li>}
                </ol>
              )}
            </div>
            {!atBottom && (
              <button type="button" aria-label="Scroll to the latest message" title="Latest message" onClick={() => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }}
                className="absolute bottom-3 right-4 flex size-10 items-center justify-center rounded-full bg-white text-[#54656F] shadow-md"><ArrowDown className="size-5" /></button>
            )}
            </div>
            {thread.error && t && <p className="bg-[#FFE7EA] px-4 py-1 text-center text-xs text-[#B1002A]" role="status">Could not refresh: {describeDataError(thread.error)} Retrying automatically.</p>}
            {t && (
              <p className={cn('px-4 py-1 text-center text-xs', t.window_open ? 'bg-[#E7F8EE] text-[#0A5C36]' : 'bg-[#FFF4E0] text-[#7A4B00]')} data-testid="wa-window" data-open={t.window_open}>
                {waWindowText(t.window_open, t.window_closes_at)}</p>
            )}
            {notice && (
              <p role={notice.ok ? 'status' : 'alert'} data-testid="wa-notice" className={cn('flex items-center justify-between gap-2 px-4 py-1.5 text-sm', notice.ok ? 'bg-[#E7F8EE] text-[#0A5C36]' : 'bg-[#FFE7EA] text-[#B1002A]')}>
                <span>{notice.text}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-4" /></button></p>
            )}
            {t && <ChatComposer key={id} conversationId={id} windowOpen={t.window_open} canSend={t.can_send} replyTo={replyTo} customerName={name}
              onCancelReply={() => setReplyTo(null)} onSent={done} onTemplate={() => setTemplateOpen(true)} onError={(text) => setNotice({ ok: false, text })} />}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#F0F2F5]" data-testid={`wa-pane-${pane}`}>
            {notice && <p role={notice.ok ? 'status' : 'alert'} className={cn('px-4 py-1.5 text-sm', notice.ok ? 'text-[#0A5C36]' : 'text-[#B1002A]')}>{notice.text}</p>}
            <div className="mx-auto max-w-3xl space-y-2.5 py-3">
              {pane === 'ticket' ? <><TicketInfo ctx={ctx} /><ConversationControls ctx={ctx} /><NotesInfo ctx={ctx} /></>
                : <><ContactHeader ctx={ctx} /><CustomerInfo ctx={ctx} full /></>}
            </div>
          </div>
        )}
      </section>

      {infoOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 xl:hidden" onClick={() => setInfoOpen(false)} aria-hidden />
          <InfoPanel ctx={ctx} onClose={() => setInfoOpen(false)}
            className="fixed inset-y-0 right-0 z-50 w-full border-l border-[#E9EDEF] shadow-xl sm:w-[400px] xl:static xl:z-auto xl:w-[380px] xl:shrink-0 xl:shadow-none" />
        </>
      )}

      {infoFor && <MessageInfoDialog m={infoFor} timezone={tz} onClose={() => setInfoFor(null)} />}
      {templateOpen && <WaTemplateDialog conversationId={id} onClose={() => setTemplateOpen(false)} onSent={(r) => { setTemplateOpen(false); done(r) }} />}
      <TicketFormDialog open={ticketOpen} onOpenChange={setTicketOpen} conversation={{ id, subject: c.subject }}
        onCreated={(r) => { reload(); navigate(`/support/tickets/${r.id}`) }} />
      <CustomerFormDialog open={customerOpen} onOpenChange={setCustomerOpen}
        preset={{ display_name: c.contact_name ?? t?.contact.profile_name ?? '', phones: c.contact_phone ?? '', emails: c.contact_email ?? '' }}
        onSaved={(cid) => void act(() => linkConversationCustomer(id, cid))} />
      {retrying && <span className="sr-only" role="status"><Loader2 />Sending again…</span>}
    </>
  )
}
