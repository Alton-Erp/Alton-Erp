import { Archive, ArrowLeft, Bookmark, ChevronsDownUp, ChevronsUpDown, Forward, Inbox, OctagonAlert, PanelRight, Printer, Reply, ReplyAll, Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { StatusBadge } from '@/components/common/status-badge'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { AttachmentPreview } from '@/features/support/mail/attachment-preview'
import { MailIcon, ThreadActions, type Act } from '@/features/support/mail/mail-list'
import { MailMessage, type MessageTools, type ReplyMode } from '@/features/support/mail/mail-message'
import { addrs, initiallyExpanded, messageLink, printHtml, starredEmails, threadItems, type MailFolder } from '@/features/support/mail/mail-model'
import { CustomerFormDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { ConversationControls, CustomerInfo, NotesInfo, TicketInfo, type InfoContext } from '@/features/support/wa-web/info-panel'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  fetchComposeContext, fetchEmailThread, fetchMessageState, messageAction, mirrorMailboxRead, type MailAttachment, type MailThreadRow, type ThreadEmail,
} from '@/services/email'
import { fetchAgents, fetchConversation, fetchTags, linkConversationCustomer, markConversationRead } from '@/services/support'

export type { ReplyMode }

/** Reading view of one thread with the mailbox actions and the support details (customer, ticket, notes). */
export function MailThread({ id, row, folder, act, labels, timezone, onBack, onChanged, onReply, detailsOpen, setDetailsOpen, legacy = false, focusId = null }: {
  /** Before migration 20261222090000: no mailbox actions (stars, folders, labels). */
  legacy?: boolean
  /** An email opened through "Copy link to this email": shown expanded and scrolled to. */
  focusId?: string | null
  id: string; row: MailThreadRow | null; folder: MailFolder; act: Act; labels: { id: string; name: string; color: string }[]; timezone?: string
  onBack: () => void; onChanged: () => void; onReply: (mode: ReplyMode, e: ThreadEmail, customerId: string | null) => void
  detailsOpen: boolean; setDetailsOpen: (o: boolean) => void
}) {
  const perms = useSupportPermissions()
  const navigate = useNavigate()
  const thread = usePolled(() => fetchEmailThread(id), [id], 30_000)
  const detail = usePolled(() => fetchConversation(id), [id], 30_000)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const tags = useAsync(() => fetchTags().catch(() => []), [])
  const compose = useAsync(() => fetchComposeContext().catch(() => null), [])
  const msgState = usePolled(() => fetchMessageState(id).catch(() => null), [id], 30_000)
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ items: MailAttachment[]; index: number } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; run: () => Promise<void> } | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const emails = useMemo(() => thread.data ?? [], [thread.data])
  const expanded = useMemo(() => {
    if (open) return open
    const s = initiallyExpanded(emails)
    if (focusId && emails.some((e) => e.id === focusId)) s.add(focusId)
    return s
  }, [open, emails, focusId])
  const stars = starredEmails(emails.map((e) => e.id), msgState.data ?? null, row?.starred ?? false)
  const perMessage = msgState.data !== null && msgState.data !== undefined

  // A linked email is scrolled into view once the thread has loaded.
  const scrolled = useRef(false)
  useEffect(() => {
    if (!focusId || scrolled.current || !emails.length) return
    scrolled.current = true
    document.querySelector(`[data-testid="email-${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'start' })
  }, [focusId, emails.length])

  // Opening a thread marks it read (and mirrors "read" to Gmail only when gmail.modify was enabled), as the inbox did.
  const unread = detail.data?.conversation.unread_count ?? 0
  useEffect(() => {
    if (!unread) return
    void markConversationRead(id).then(() => {
      onChanged()
      void fetchComposeContext().then((c) => (c.mailbox_modify ? mirrorMailboxRead(id) : null)).catch(() => {})
    }, () => {})
  }, [id, unread]) // eslint-disable-line react-hooks/exhaustive-deps

  const d = detail.data
  const subject = emails.find((e) => e.subject)?.subject ?? row?.subject ?? '(no subject)'
  const canReply = perms.reply && Boolean(compose.data?.can_send)
  const canEdit = perms.reply && !legacy
  const reload = () => { thread.reload(); detail.reload(); msgState.reload(); onChanged() }
  const doAct: Act = async (ids, a, p) => { await act(ids, a, p); reload() }
  const print = (list: ThreadEmail[]) => {
    const f = document.createElement('iframe')
    f.style.position = 'fixed'; f.style.width = '0'; f.style.height = '0'; f.style.border = '0'
    f.setAttribute('sandbox', 'allow-modals allow-same-origin')
    f.srcdoc = printHtml(subject, list.map((e) => ({ from: e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address ?? '', to: addrs(e.to), date: formatDateTime(e.at, timezone), body: e.body_text ?? '' })))
    f.onload = () => { f.contentWindow?.print(); setTimeout(() => f.remove(), 1000) }
    document.body.appendChild(f)
  }
  const ctx: InfoContext | null = d ? {
    d, thread: null, name: d.customer?.display_name ?? d.conversation.contact_name ?? d.conversation.contact_email ?? 'Unknown contact', perms,
    agents: agents.data ?? [], tags: tags.data ?? [], timezone,
    act: async (fn) => { setNotice(null); try { await fn(); reload() } catch (e) { setNotice(describeDataError(e)) } },
    onCreateTicket: () => setTicketOpen(true), onNewCustomer: () => setCustomerOpen(true),
  } : null
  const last = emails.at(-1) ?? null
  const lastInbound = [...emails].reverse().find((e) => e.direction === 'INBOUND') ?? last
  const replyAllUseful = Boolean(lastInbound && lastInbound.to.length + lastInbound.cc.length > 1)
  const allOpen = emails.length > 0 && emails.every((e) => expanded.has(e.id))
  const toggleAll = () => { if (allOpen) { setOpen(initiallyExpanded(emails)); setRevealed(false) } else { setOpen(new Set(emails.map((e) => e.id))); setRevealed(true) } }
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setNotice(null); setInfo(null)
    try { await fn(); if (done) setInfo(done); reload() } catch (e) { setNotice(describeDataError(e)) }
  }
  const toolsFor = (e: ThreadEmail): MessageTools => ({
    canReply, canEdit, perMessage,
    onReply: (m) => onReply(m, e, d?.conversation.customer_id ?? null),
    onPrint: () => print([e]),
    onStar: () => void run(() => (perMessage ? messageAction(e.id, stars.has(e.id) ? 'UNSTAR' : 'STAR') : act([id], row?.starred ? 'UNSTAR' : 'STAR'))),
    // As in Gmail, back to the list: staying would mark the conversation read again.
    onMarkUnread: () => void act([id], 'MARK_UNREAD').then(onBack, (x) => setNotice(describeDataError(x))),
    onReport: (kind) => setConfirm({
      title: kind === 'PHISHING' ? 'Report phishing?' : 'Report spam?',
      description: `${kind === 'PHISHING' ? 'The email is recorded as phishing' : 'The email is recorded as spam'} and the whole conversation moves to Spam in the ERP. Gmail and Google are not told; nothing is deleted, and "Not spam" moves it back.`,
      label: kind === 'PHISHING' ? 'Report phishing' : 'Report spam',
      run: async () => { if (perMessage) await messageAction(e.id, kind === 'PHISHING' ? 'REPORT_PHISHING' : 'REPORT_SPAM'); else await act([id], 'SPAM'); onChanged(); onBack() },
    }),
    onTrash: () => setConfirm({
      title: 'Move this conversation to Trash?',
      description: 'Single emails cannot be removed from a conversation, so the whole conversation moves to Trash. Support history is never deleted; move it back to the Inbox at any time.',
      label: 'Move to Trash',
      run: async () => { await act([id], 'TRASH'); onBack() },
    }),
    onCopyLink: () => void navigator.clipboard?.writeText(messageLink(window.location.origin, id, e.id)).then(() => setInfo('Link copied.'), () => setNotice('The browser did not allow copying.')),
    onPreview: (items, index) => setPreview({ items, index }),
    onError: (text) => setNotice(text),
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={subject} data-testid="mail-thread">
        <div className="flex h-12 shrink-0 items-center gap-1 px-2" role="toolbar" aria-label="Thread actions">
          <MailIcon label="Back to the list" onClick={onBack} testId="mail-back"><ArrowLeft /></MailIcon>
          {row ? <ThreadActions ids={[id]} folder={folder} rows={[row]} labels={labels} act={doAct} canEdit={canEdit} afterMove={onBack} />
            : canEdit && <MailIcon label="Archive" onClick={() => void doAct([id], 'ARCHIVE').then(onBack)}><Archive /></MailIcon>}
          <span className="ml-auto flex items-center">
            {emails.length > 1 && <MailIcon label={allOpen ? 'Collapse all' : 'Expand all'} onClick={toggleAll} testId="mail-expand-all">{allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}</MailIcon>}
            <MailIcon label="Print all" onClick={() => print(emails)} testId="mail-print"><Printer /></MailIcon>
            <MailIcon label={detailsOpen ? 'Hide support details' : 'Support details (customer, ticket, notes)'} onClick={() => setDetailsOpen(!detailsOpen)} testId="mail-details-toggle"
              className={cn(detailsOpen && 'bg-[#D3E3FD]')}><PanelRight /></MailIcon>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-white">
          {thread.loading && !thread.data ? (
            <div className="space-y-3 p-6" aria-busy="true"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /></div>
          ) : thread.error && !thread.data ? (
            <div className="p-8 text-center text-sm" role="alert"><p className="text-red-700">{describeDataError(thread.error)}</p>
              <button type="button" onClick={thread.reload} className="mt-3 rounded-full bg-[#0B57D0] px-4 py-1.5 font-medium text-white">Try again</button></div>
          ) : (
            <div className="group/thread" data-testid="email-thread">
              <div className="flex flex-wrap items-start gap-2 px-4 pt-5 pb-3 sm:pl-[68px]">
                <h1 className="min-w-0 flex-1 text-[22px] leading-7 text-[#1F1F1F]" data-testid="mail-subject">{subject}</h1>
                {row?.labels.map((l) => (
                  <span key={l.id} className="inline-flex items-center gap-1"><StatusBadge label={l.name} tone={l.color as never} />
                    {canEdit && <button type="button" aria-label={`Remove label ${l.name}`} onClick={() => void doAct([id], 'LABEL_REMOVE', { label: l.id })}><X className="size-3" /></button>}</span>
                ))}
                {row && <span className="rounded bg-[#DDE3EA] px-1.5 text-xs text-[#444746]">{{ INBOX: 'Inbox', ARCHIVE: 'Archived', SPAM: 'Spam', TRASH: 'Trash' }[row.folder]}</span>}
                {d?.ticket && <button type="button" onClick={() => navigate(`/support/tickets/${d.ticket!.id}`)} className="rounded bg-[#E8F0FE] px-1.5 text-xs text-[#0B57D0] hover:underline">{d.ticket.ticket_number}</button>}
                {row && canEdit && <>
                  <MailIcon label={row.important ? 'Important' : 'Mark as important'} onClick={() => void doAct([id], row.important ? 'NOT_IMPORTANT' : 'IMPORTANT')}>
                    <Bookmark className={row.important ? 'fill-[#F4B400] text-[#F4B400]' : ''} /></MailIcon>
                  <MailIcon label={row.starred ? 'Starred' : 'Not starred'} onClick={() => void doAct([id], row.starred ? 'UNSTAR' : 'STAR')} testId="mail-thread-star">
                    <Star className={row.starred ? 'fill-[#F4B400] text-[#F4B400]' : ''} /></MailIcon>
                </>}
              </div>
              {row?.folder === 'SPAM' && <p className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-[#FCE8E6] px-3 py-2 text-sm text-[#A50E0E] sm:ml-[68px]"><OctagonAlert className="size-4" />Reported as spam in the ERP (Gmail itself is not changed).</p>}
              {row?.folder === 'TRASH' && <p className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-[#F1F3F4] px-3 py-2 text-sm text-[#444746] sm:ml-[68px]"><Trash2 className="size-4" />In Trash. Support history is never deleted; move it back to the Inbox at any time.
                {canEdit && <button type="button" className="ml-auto text-[#0B57D0]" onClick={() => void doAct([id], 'INBOX')}><Inbox className="mr-1 inline size-4" />Move to Inbox</button>}</p>}
              {notice && <p role="alert" className="mx-4 mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}
              {info && <p role="status" className="mx-4 mb-2 rounded-md bg-[#E6F4EA] px-3 py-2 text-sm text-[#0D652D] sm:ml-[68px]" data-testid="mail-thread-info">{info}</p>}
              {threadItems(emails, expanded, revealed).map((it) => (it.kind === 'hidden' ? (
                <div key={`hidden-${it.ids[0]}`} className="relative flex h-6 items-center border-b border-[#F1F3F4]">
                  <span className="absolute inset-x-0 top-1/2 border-t border-[#DADCE0]" aria-hidden />
                  <button type="button" onClick={() => setRevealed(true)} data-testid="mail-thread-hidden" aria-label={`Show ${it.ids.length} earlier messages`} title={`${it.ids.length} earlier messages`}
                    className="relative ml-6 inline-flex size-10 items-center justify-center rounded-full border border-[#DADCE0] bg-white text-sm font-medium text-[#444746] hover:bg-[#F1F3F4] focus-visible:outline-2 focus-visible:outline-[#0B57D0]">{it.ids.length}</button>
                </div>
              ) : (
                <MailMessage key={it.email.id} e={it.email} expanded={expanded.has(it.email.id)} starred={stars.has(it.email.id)} timezone={timezone} tools={toolsFor(it.email)}
                  onToggle={() => { const n = new Set(expanded); if (n.has(it.email.id)) n.delete(it.email.id); else n.add(it.email.id); setOpen(n) }} />
              )))}
              {!emails.length && <p className="p-8 text-center text-sm text-[#5F6368]">This conversation has no emails (it was logged manually).</p>}
              {emails.length > 1 && (
                <div className="px-4 pt-2 sm:pl-[68px]"><button type="button" className="text-xs text-[#0B57D0] hover:underline" onClick={toggleAll}>
                  {allOpen ? 'Collapse all' : 'Expand all'}</button></div>
              )}
              {canReply && lastInbound && (
                <div className="flex flex-wrap gap-3 px-4 py-6 sm:pl-[68px]" data-testid="mail-reply-bar">
                  <button type="button" onClick={() => onReply('REPLY', lastInbound, d?.conversation.customer_id ?? null)} className="inline-flex items-center gap-2 rounded-full border border-[#747775] px-5 py-2 text-sm font-medium text-[#444746] hover:bg-[#F8FAFD]"><Reply className="size-4" />Reply</button>
                  {replyAllUseful && <button type="button" onClick={() => onReply('REPLY_ALL', lastInbound, d?.conversation.customer_id ?? null)} className="inline-flex items-center gap-2 rounded-full border border-[#747775] px-5 py-2 text-sm font-medium text-[#444746] hover:bg-[#F8FAFD]"><ReplyAll className="size-4" />Reply all</button>}
                  <button type="button" onClick={() => onReply('FORWARD', last ?? lastInbound, d?.conversation.customer_id ?? null)} className="inline-flex items-center gap-2 rounded-full border border-[#747775] px-5 py-2 text-sm font-medium text-[#444746] hover:bg-[#F8FAFD]" data-testid="mail-forward"><Forward className="size-4" />Forward</button>
                </div>
              )}
              {!canReply && perms.reply && compose.data && <p className="px-4 py-4 text-xs text-[#5F6368] sm:pl-[68px]">Replies are possible once the support mailbox is connected (Support Settings → Email).</p>}
            </div>
          )}
        </div>
      </section>
      {detailsOpen && ctx && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 xl:hidden" onClick={() => setDetailsOpen(false)} aria-hidden />
          <aside aria-label="Support details" data-testid="mail-details" className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-[#F8FAFD] shadow-xl sm:w-[380px] xl:static xl:z-auto xl:w-[340px] xl:shrink-0 xl:rounded-2xl xl:shadow-none">
            <header className="flex h-12 shrink-0 items-center justify-between px-4"><h2 className="text-sm font-medium text-[#1F1F1F]">Support details</h2>
              <MailIcon label="Close support details" onClick={() => setDetailsOpen(false)}><X /></MailIcon></header>
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pb-6">
              <TicketInfo ctx={ctx} /><ConversationControls ctx={ctx} /><CustomerInfo ctx={ctx} /><NotesInfo ctx={ctx} />
            </div>
          </aside>
        </>
      )}
      <AttachmentPreview items={preview?.items ?? []} index={preview?.index ?? null} onIndex={(index) => setPreview((p) => (p ? { ...p, index } : p))} onClose={() => setPreview(null)} />
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null) }} title={confirm?.title ?? ''} description={confirm?.description ?? ''}
        confirmLabel={confirm?.label} destructive onConfirm={() => { const c = confirm; setConfirm(null); if (c) void c.run().catch((x) => setNotice(describeDataError(x))) }} />
      {d && <>
        <TicketFormDialog open={ticketOpen} onOpenChange={setTicketOpen} conversation={{ id, subject: d.conversation.subject ?? subject }}
          onCreated={(r) => { reload(); navigate(`/support/tickets/${r.id}`) }} />
        <CustomerFormDialog open={customerOpen} onOpenChange={setCustomerOpen}
          preset={{ display_name: d.conversation.contact_name ?? lastInbound?.from_name ?? '', phones: d.conversation.contact_phone ?? '', emails: d.conversation.contact_email ?? lastInbound?.from_address ?? '' }}
          onSaved={(cid) => void ctx?.act(() => linkConversationCustomer(id, cid))} />
      </>}
    </div>
  )
}
