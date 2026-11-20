import {
  Archive, ArrowLeft, Bookmark, ChevronDown, Code2, Download, FileText, Forward, Inbox, Lock, MoreVertical, OctagonAlert, PanelRight, Printer, Reply, ReplyAll, Star, Trash2, X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { StatusBadge } from '@/components/common/status-badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { EmailHtmlFrame, EmailSendBadge } from '@/features/support/email-components'
import { MailIcon, ThreadActions, type Act } from '@/features/support/mail/mail-list'
import { initiallyExpanded, mailListDate, printHtml, type MailFolder } from '@/features/support/mail/mail-model'
import { CustomerFormDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { EMAIL_SEND_META } from '@/features/support/support-model'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { ConversationControls, CustomerInfo, NotesInfo, TicketInfo, type InfoContext } from '@/features/support/wa-web/info-panel'
import { signedAttachmentUrl } from '@/features/support/wa-web/media-urls'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { WaAvatar } from '@/features/support/wa-web/wa-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatFileSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchComposeContext, fetchEmailThread, mirrorMailboxRead, type MailThreadRow, type ThreadEmail } from '@/services/email'
import { fetchAgents, fetchConversation, fetchTags, linkConversationCustomer, markConversationRead } from '@/services/support'

const addrs = (list: { email: string; name: string | null }[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
export type ReplyMode = 'REPLY' | 'REPLY_ALL' | 'FORWARD'

function AttachmentCard({ a }: { a: ThreadEmail['attachments'][number] }) {
  const [error, setError] = useState<string | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const image = (a.content_type ?? '').startsWith('image/')
  const ok = !a.restricted && a.storage_path
  useEffect(() => {
    if (!ok || !image) return
    let live = true
    signedAttachmentUrl(a.storage_path!).then((u) => { if (live) setThumb(u) }, () => {})
    return () => { live = false }
  }, [ok, image, a.storage_path])
  if (!ok) return <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#E0E3E7] px-3 py-2 text-xs text-[#5F6368]"><Lock className="size-3.5" />{a.file_name} (restricted)</span>
  const open = () => { setError(null); signedAttachmentUrl(a.storage_path!).then((u) => window.open(u, '_blank', 'noopener'), (e) => setError(describeDataError(e))) }
  return (
    <button type="button" onClick={open} data-testid="email-attachment" title={`Open / download ${a.file_name}`}
      className="group/att relative flex h-[120px] w-[180px] flex-col overflow-hidden rounded-lg border border-[#E0E3E7] bg-[#F8FAFD] text-left hover:shadow">
      <span className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {thumb ? <img src={thumb} alt={a.file_name} loading="lazy" className="size-full object-cover" /> : <FileText className="size-10 text-[#D93025]" />}</span>
      <span className="flex items-center gap-1.5 border-t border-[#E0E3E7] bg-white px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[#1F1F1F]">{a.file_name}</span>
          <span className="text-[#5F6368]">{a.size_bytes ? formatFileSize(a.size_bytes) : ''}</span></span>
        <Download className="size-4 shrink-0 text-[#444746]" /></span>
      {error && <span className="absolute inset-x-0 top-0 bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</span>}
    </button>
  )
}

function Message({ e, expanded, onToggle, timezone, canReply, onReply, onPrint }: {
  e: ThreadEmail; expanded: boolean; onToggle: () => void; timezone?: string; canReply: boolean; onReply: (m: ReplyMode) => void; onPrint: () => void
}) {
  const [details, setDetails] = useState(false)
  const [formatted, setFormatted] = useState(false)
  const inbound = e.direction === 'INBOUND'
  const name = e.from_name || e.from_address || 'Unknown sender'
  const files = e.attachments.filter((a) => !a.inline)
  if (!expanded) {
    return (
      <article className="flex cursor-pointer items-center gap-3 border-b border-[#F1F3F4] px-4 py-3 hover:bg-[#F8FAFD]" onClick={onToggle} data-testid={`email-${e.id}`} data-expanded="false">
        <WaAvatar name={name} seed={e.from_address ?? name} size={32} />
        <span className={cn('w-40 shrink-0 truncate text-sm', e.unread ? 'font-bold' : 'font-medium')}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-[#5F6368]">{(e.body_text ?? '').replace(/\s+/g, ' ').slice(0, 160)}</span>
        <time className="shrink-0 text-xs text-[#5F6368]">{mailListDate(e.at, undefined, timezone)}</time>
      </article>
    )
  }
  return (
    <article className="border-b border-[#F1F3F4] px-4 py-4" data-testid={`email-${e.id}`} data-expanded="true">
      <header className="flex items-start gap-3">
        <WaAvatar name={name} seed={e.from_address ?? name} size={40} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <p className="text-sm"><span className="font-bold text-[#1F1F1F]">{name}</span>{e.from_address && e.from_name && <span className="text-xs text-[#5F6368]"> &lt;{e.from_address}&gt;</span>}
            {!inbound && e.author && <span className="text-xs text-[#5F6368]"> · sent by {e.author}</span>}</p>
          <button type="button" className="inline-flex items-center gap-0.5 text-xs text-[#5F6368] hover:text-[#1F1F1F]" onClick={(x) => { x.stopPropagation(); setDetails((d) => !d) }} aria-expanded={details}>
            to {e.to.map((t) => t.name || t.email).join(', ') || '—'}{e.cc.length ? `, cc ${e.cc.length}` : ''}<ChevronDown className="size-3" /></button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!inbound && <EmailSendBadge state={e.send_state} />}
          <time className="hidden text-xs text-[#5F6368] sm:inline" title={formatDateTime(e.at, timezone)}>{formatDateTime(e.at, timezone)}</time>
          {canReply && <MailIcon label="Reply" onClick={() => onReply('REPLY')}><Reply /></MailIcon>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="More" title="More" className="inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-black/5"><MoreVertical className="size-[18px]" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canReply && <><DropdownMenuItem onSelect={() => onReply('REPLY')}><Reply />Reply</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReply('REPLY_ALL')}><ReplyAll />Reply all</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReply('FORWARD')}><Forward />Forward</DropdownMenuItem><DropdownMenuSeparator /></>}
              <DropdownMenuItem onSelect={onPrint}><Printer />Print</DropdownMenuItem>
              {e.has_html && <DropdownMenuItem onSelect={() => setFormatted((f) => !f)}><Code2 />{formatted ? 'Plain text' : 'Formatted view'}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {details && (
        <dl className="mt-2 ml-[52px] grid max-w-xl grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-[#E0E3E7] p-3 text-xs" data-testid="email-recipients">
          <dt className="text-right text-[#5F6368]">from:</dt><dd>{e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address}</dd>
          <dt className="text-right text-[#5F6368]">to:</dt><dd>{addrs(e.to) || '—'}</dd>
          {e.cc.length > 0 && <><dt className="text-right text-[#5F6368]">cc:</dt><dd>{addrs(e.cc)}</dd></>}
          {e.bcc.length > 0 && <><dt className="text-right text-[#5F6368]">bcc:</dt><dd>{addrs(e.bcc)}</dd></>}
          <dt className="text-right text-[#5F6368]">date:</dt><dd>{formatDateTime(e.at, timezone)}</dd>
          <dt className="text-right text-[#5F6368]">subject:</dt><dd>{e.subject || '(no subject)'}</dd>
        </dl>
      )}
      <div className="mt-3 ml-0 text-sm text-[#1F1F1F] sm:ml-[52px]">
        {e.send_state === 'FAILED' && e.send_error && <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{e.send_error}</p>}
        {e.send_state === 'PENDING' && <p className="mb-2 text-xs text-amber-800">{EMAIL_SEND_META.PENDING.hint}</p>}
        {formatted && e.has_html ? <EmailHtmlFrame emailId={e.id} /> : <div className="whitespace-pre-wrap break-words leading-6">{e.body_text || '(no text content)'}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {e.has_html && <button type="button" onClick={() => setFormatted((f) => !f)} data-testid="email-toggle-format"
            className="inline-flex items-center gap-1 rounded-full border border-[#C4C7C5] px-3 py-1 text-xs text-[#444746] hover:bg-[#F8FAFD]"><Code2 className="size-3.5" />{formatted ? 'Plain text' : 'Formatted view'}</button>}
          {e.html_truncated && <span className="text-xs text-[#5F6368]">Formatted version too large to keep; text shown.</span>}
        </div>
        {files.length > 0 && (
          <div className="mt-4 border-t border-[#F1F3F4] pt-3">
            <p className="mb-2 text-xs font-medium text-[#444746]">{files.length} attachment{files.length > 1 ? 's' : ''}</p>
            <div className="flex flex-wrap gap-3">{files.map((a) => <AttachmentCard key={a.id} a={a} />)}</div>
          </div>
        )}
        {e.skipped_attachments.map((a, i) => (
          <p key={`skip-${i}`} className="mt-1 text-xs text-amber-800" title={a.reason ?? ''}>{a.filename}: {a.state === 'BLOCKED' ? 'not stored (blocked type)' : a.state === 'TOO_LARGE' ? 'not stored (too large)' : a.state === 'FAILED' ? 'download failed, retried on the next sync' : 'downloading…'}</p>
        ))}
      </div>
    </article>
  )
}

/** Reading view of one thread with the mailbox actions and the support details (customer, ticket, notes). */
export function MailThread({ id, row, folder, act, labels, timezone, onBack, onChanged, onReply, detailsOpen, setDetailsOpen, legacy = false }: {
  /** Before migration 20261222090000: no mailbox actions (stars, folders, labels). */
  legacy?: boolean
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
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const emails = useMemo(() => thread.data ?? [], [thread.data])
  const expanded = open ?? initiallyExpanded(emails)

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
  const reload = () => { thread.reload(); detail.reload(); onChanged() }
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

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={subject} data-testid="mail-thread">
        <div className="flex h-12 shrink-0 items-center gap-1 px-2" role="toolbar" aria-label="Thread actions">
          <MailIcon label="Back to the list" onClick={onBack} testId="mail-back"><ArrowLeft /></MailIcon>
          {row ? <ThreadActions ids={[id]} folder={folder} rows={[row]} labels={labels} act={doAct} canEdit={canEdit} afterMove={onBack} />
            : canEdit && <MailIcon label="Archive" onClick={() => void doAct([id], 'ARCHIVE').then(onBack)}><Archive /></MailIcon>}
          <span className="ml-auto flex items-center">
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
              {emails.map((e) => (
                <Message key={e.id} e={e} expanded={expanded.has(e.id)} timezone={timezone} canReply={canReply} onPrint={() => print([e])}
                  onToggle={() => { const n = new Set(expanded); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); setOpen(n) }}
                  onReply={(m) => onReply(m, e, d?.conversation.customer_id ?? null)} />
              ))}
              {!emails.length && <p className="p-8 text-center text-sm text-[#5F6368]">This conversation has no emails (it was logged manually).</p>}
              {emails.length > 1 && (
                <div className="px-4 pt-2 sm:pl-[68px]"><button type="button" className="text-xs text-[#0B57D0] hover:underline" onClick={() => setOpen(expanded.size === emails.length ? initiallyExpanded(emails) : new Set(emails.map((e) => e.id)))}>
                  {expanded.size === emails.length ? 'Collapse all' : 'Expand all'}</button></div>
              )}
              {canReply && lastInbound && (
                <div className="flex flex-wrap gap-3 px-4 py-6 sm:pl-[68px]" data-testid="mail-reply-bar">
                  <button type="button" onClick={() => onReply('REPLY', lastInbound, d?.conversation.customer_id ?? null)} className="inline-flex items-center gap-2 rounded-full border border-[#747775] px-5 py-2 text-sm font-medium text-[#444746] hover:bg-[#F8FAFD]"><Reply className="size-4" />Reply</button>
                  <button type="button" onClick={() => onReply('REPLY_ALL', lastInbound, d?.conversation.customer_id ?? null)} className="inline-flex items-center gap-2 rounded-full border border-[#747775] px-5 py-2 text-sm font-medium text-[#444746] hover:bg-[#F8FAFD]"><ReplyAll className="size-4" />Reply all</button>
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
