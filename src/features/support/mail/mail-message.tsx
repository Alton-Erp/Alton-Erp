import {
  ChevronDown, Code2, Copy, Download, FileSearch, Fish, Forward, Info, Lock, Mail, MoreVertical, OctagonAlert, Paperclip, Printer, Reply, ReplyAll, Star, Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmailHtmlFrame, EmailSendBadge } from '@/features/support/email-components'
import { base64UrlToBytes, orderAttachments } from '@/features/support/mail/attachment-model'
import { AttachmentTile } from '@/features/support/mail/attachment-preview'
import { MailIcon } from '@/features/support/mail/mail-list'
import { addrs, authResults, emlFileName, mailListDate, splitQuoted } from '@/features/support/mail/mail-model'
import { EMAIL_SEND_META } from '@/features/support/support-model'
import { WaAvatar } from '@/features/support/wa-web/wa-ui'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchOriginalHeaders, fetchOriginalRaw, type MailAttachment, type OriginalHeaders, type ThreadEmail } from '@/services/email'

export type ReplyMode = 'REPLY' | 'REPLY_ALL' | 'FORWARD'

/** What one email's toolbar and ⋮ menu may do (each acts on this email, or says plainly that it moves the conversation). */
export interface MessageTools {
  canReply: boolean
  canEdit: boolean
  /** Per-email stars and reports need migration 20261223090000; before it the star is the conversation's. */
  perMessage: boolean
  onReply: (mode: ReplyMode) => void
  onPrint: () => void
  onStar: () => void
  onMarkUnread: () => void
  onReport: (kind: 'SPAM' | 'PHISHING') => void
  onTrash: () => void
  onCopyLink: () => void
  onPreview: (items: MailAttachment[], index: number) => void
  onError: (text: string) => void
}

async function downloadOriginal(e: ThreadEmail) {
  const r = await fetchOriginalRaw(e.id)
  const url = URL.createObjectURL(new Blob([base64UrlToBytes(r.raw) as BlobPart], { type: 'message/rfc822' }))
  const link = document.createElement('a')
  link.href = url
  link.download = emlFileName(e.subject)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** "Show original": Gmail's copy of the headers (read-only), with the SPF / DKIM / DMARC verdicts. */
function OriginalDialog({ e, open, onOpenChange, timezone }: { e: ThreadEmail; open: boolean; onOpenChange: (o: boolean) => void; timezone?: string }) {
  const [q, setQ] = useState<{ data: OriginalHeaders | null; error: string | null } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    fetchOriginalHeaders(e.id).then((data) => { if (live) setQ({ data, error: null }) }, (x) => { if (live) setQ({ data: null, error: describeDataError(x) }) })
    return () => { live = false }
  }, [open, e.id])
  const headers = q?.data?.headers ?? []
  const auth = authResults(headers)
  const text = headers.map((h) => `${h.name}: ${h.value}`).join('\n')
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setQ(null); setNote(null) } }}>
      <DialogContent className="max-w-3xl" data-testid="email-original">
        <DialogHeader>
          <DialogTitle>Original message</DialogTitle>
          <DialogDescription>Headers as the connected Gmail mailbox keeps them (read-only).</DialogDescription>
        </DialogHeader>
        {!q ? <p className="text-sm text-muted-foreground">Loading…</p> : q.error ? <p role="alert" className="text-sm text-red-700">{q.error}</p> : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Message ID</dt><dd className="break-all">{e.rfc_message_id ?? '—'}</dd>
              <dt className="text-muted-foreground">Created at</dt><dd>{formatDateTime(e.at, timezone)}</dd>
              <dt className="text-muted-foreground">From</dt><dd className="break-all">{e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address}</dd>
              <dt className="text-muted-foreground">To</dt><dd className="break-all">{addrs(e.to) || '—'}</dd>
              <dt className="text-muted-foreground">Subject</dt><dd>{e.subject || '(no subject)'}</dd>
              {(['spf', 'dkim', 'dmarc'] as const).map((k) => auth[k] && <div key={k} className="contents"><dt className="text-muted-foreground uppercase">{k}</dt>
                <dd className={auth[k] === 'PASS' ? 'text-[#188038]' : 'text-[#B3261E]'}>{auth[k]}</dd></div>)}
            </dl>
            <pre className="max-h-[45vh] overflow-auto rounded-md border bg-[#F8FAFD] p-3 text-xs whitespace-pre-wrap break-all" data-testid="email-original-headers">{text || 'No headers returned.'}</pre>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="inline-flex items-center gap-2 rounded-full bg-[#0B57D0] px-4 py-1.5 text-sm font-medium text-white"
                onClick={() => { setNote(null); downloadOriginal(e).catch((x) => setNote(describeDataError(x))) }}><Download className="size-4" />Download original</button>
              <button type="button" className="inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm"
                onClick={() => void navigator.clipboard?.writeText(text).then(() => setNote('Headers copied.'), () => setNote('Could not copy.'))}><Copy className="size-4" />Copy headers</button>
              {note && <span className="text-xs text-muted-foreground" role="status">{note}</span>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One email of the thread: a compact card when collapsed; header, toolbar, ⋮ menu, body (quoted part behind "…") and attachments when open. */
export function MailMessage({ e, expanded, starred, onToggle, timezone, tools }: {
  e: ThreadEmail; expanded: boolean; starred: boolean; onToggle: () => void; timezone?: string; tools: MessageTools
}) {
  const [details, setDetails] = useState(false)
  const [formatted, setFormatted] = useState(false)
  const [showQuoted, setShowQuoted] = useState(false)
  const [original, setOriginal] = useState(false)
  const inbound = e.direction === 'INBOUND'
  const name = e.from_name || e.from_address || 'Unknown sender'
  // Every stored file is listed, including images embedded in the body: the safe HTML view never loads images, so the
  // list is the only place they appear (ordinary attachments first).
  const files: MailAttachment[] = orderAttachments(e.attachments)
  const embedded = files.filter((a) => a.inline).length
  const body = splitQuoted(e.body_text ?? '')
  const onGmail = Boolean(e.gmail_message_id)
  const starBtn = (
    <MailIcon label={starred ? 'Starred' : 'Not starred'} disabled={!tools.canEdit} onClick={tools.onStar} testId="email-star" className="size-8">
      <Star className={starred ? 'fill-[#F4B400] text-[#F4B400]' : ''} /></MailIcon>
  )

  if (!expanded) {
    return (
      <article className="flex cursor-pointer items-center gap-3 border-b border-[#F1F3F4] px-4 py-3 hover:bg-[#F8FAFD] focus-visible:bg-[#F8FAFD] focus-visible:outline-none"
        onClick={onToggle} onKeyDown={(x) => { if (x.key === 'Enter' || x.key === ' ') { x.preventDefault(); onToggle() } }} tabIndex={0} role="button" aria-expanded="false"
        aria-label={`Email from ${name}, ${mailListDate(e.at, undefined, timezone)}. Show`} data-testid={`email-${e.id}`} data-expanded="false">
        <WaAvatar name={name} seed={e.from_address ?? name} size={32} />
        <span className={cn('w-28 shrink-0 truncate text-sm sm:w-40', e.unread ? 'font-bold' : 'font-medium')}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-[#5F6368]">{(body.main || e.body_text || '').replace(/\s+/g, ' ').slice(0, 160)}</span>
        {files.length > 0 && <Paperclip className="size-4 shrink-0 text-[#5F6368]" aria-label={`${files.length} attachment${files.length > 1 ? 's' : ''}`} />}
        {starred && <Star className="size-4 shrink-0 fill-[#F4B400] text-[#F4B400]" aria-label="Starred" />}
        <time className="shrink-0 text-xs text-[#5F6368]" title={formatDateTime(e.at, timezone)}>{mailListDate(e.at, undefined, timezone)}</time>
      </article>
    )
  }
  return (
    <article className="group/msg border-b border-[#F1F3F4] px-4 py-4" data-testid={`email-${e.id}`} data-expanded="true">
      <header className="flex items-start gap-3">
        <WaAvatar name={name} seed={e.from_address ?? name} size={40} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <p className="text-sm"><span className="font-bold text-[#1F1F1F]">{name}</span>{e.from_address && e.from_name && <span className="text-xs text-[#5F6368]"> &lt;{e.from_address}&gt;</span>}
            {!inbound && e.author && <span className="text-xs text-[#5F6368]"> · sent by {e.author}</span>}</p>
          <button type="button" className="inline-flex items-center gap-0.5 text-xs text-[#5F6368] hover:text-[#1F1F1F]" onClick={(x) => { x.stopPropagation(); setDetails((d) => !d) }} aria-expanded={details}>
            to {e.to.map((t) => t.name || t.email).join(', ') || '—'}{e.cc.length ? `, cc ${e.cc.length}` : ''}<ChevronDown className="size-3" /></button>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" role="toolbar" aria-label={`Actions for the email from ${name}`} data-testid="email-toolbar">
          {!inbound && <EmailSendBadge state={e.send_state} />}
          <time className="mr-1 hidden text-xs text-[#5F6368] sm:inline" title={formatDateTime(e.at, timezone)}>{formatDateTime(e.at, timezone)}</time>
          {starBtn}
          {tools.canReply && <MailIcon label="Reply" onClick={() => tools.onReply('REPLY')} testId="email-reply" className="size-8"><Reply /></MailIcon>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More options for this email" title="More" data-testid="email-menu"
                className="inline-flex size-8 items-center justify-center rounded-full text-[#444746] hover:bg-[#1F1F1F]/[0.08] focus-visible:outline-2 focus-visible:outline-[#0B57D0]"><MoreVertical className="size-[18px]" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64" data-testid="email-menu-content">
              {tools.canReply && <>
                <DropdownMenuItem onSelect={() => tools.onReply('REPLY')}><Reply />Reply</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => tools.onReply('REPLY_ALL')}><ReplyAll />Reply all</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => tools.onReply('FORWARD')}><Forward />Forward</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>}
              <DropdownMenuItem onSelect={tools.onPrint}><Printer />Print</DropdownMenuItem>
              <DropdownMenuItem disabled={!onGmail} onSelect={() => downloadOriginal(e).catch((x) => tools.onError(describeDataError(x)))} data-testid="email-download-original">
                <Download />Download message</DropdownMenuItem>
              <DropdownMenuItem disabled={!onGmail} onSelect={() => setOriginal(true)} data-testid="email-show-original"><FileSearch />Show original</DropdownMenuItem>
              <DropdownMenuItem onSelect={tools.onCopyLink} data-testid="email-copy-link"><Copy />Copy link to this email</DropdownMenuItem>
              {e.has_html && <DropdownMenuItem onSelect={() => setFormatted((f) => !f)}><Code2 />{formatted ? 'Plain text' : 'Formatted view'}</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setDetails((d) => !d)}><Info />{details ? 'Hide message details' : 'Message details'}</DropdownMenuItem>
              {tools.canEdit && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={tools.onMarkUnread} data-testid="email-mark-unread"><Mail />Mark as unread</DropdownMenuItem>
                <DropdownMenuItem onSelect={tools.onStar}><Star />{starred ? 'Remove star' : 'Add star'}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => tools.onReport('SPAM')} data-testid="email-report-spam"><OctagonAlert />Report spam</DropdownMenuItem>
                {tools.perMessage && <DropdownMenuItem onSelect={() => tools.onReport('PHISHING')} data-testid="email-report-phishing"><Fish />Report phishing</DropdownMenuItem>}
                <DropdownMenuItem onSelect={tools.onTrash} className="text-[#B3261E] focus:text-[#B3261E]" data-testid="email-trash"><Trash2 />Move to Trash</DropdownMenuItem>
              </>}
              {!onGmail && <p className="px-2 py-1.5 text-[11px] text-muted-foreground">The original is available once Gmail has the email (sent and synced).</p>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {details && (
        <dl className="mt-2 ml-[52px] grid max-w-xl grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-[#E0E3E7] p-3 text-xs" data-testid="email-recipients">
          <dt className="text-right text-[#5F6368]">from:</dt><dd>{e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address}</dd>
          {e.reply_to && <><dt className="text-right text-[#5F6368]">reply-to:</dt><dd>{e.reply_to}</dd></>}
          <dt className="text-right text-[#5F6368]">to:</dt><dd>{addrs(e.to) || '—'}</dd>
          {e.cc.length > 0 && <><dt className="text-right text-[#5F6368]">cc:</dt><dd>{addrs(e.cc)}</dd></>}
          {e.bcc.length > 0 && <><dt className="text-right text-[#5F6368]">bcc:</dt><dd>{addrs(e.bcc)}</dd></>}
          <dt className="text-right text-[#5F6368]">date:</dt><dd>{formatDateTime(e.at, timezone)}</dd>
          <dt className="text-right text-[#5F6368]">subject:</dt><dd>{e.subject || '(no subject)'}</dd>
          {e.rfc_message_id && <><dt className="text-right text-[#5F6368]">message-id:</dt><dd className="break-all">{e.rfc_message_id}</dd></>}
        </dl>
      )}
      <div className="mt-3 ml-0 text-sm text-[#1F1F1F] sm:ml-[52px]">
        {e.send_state === 'FAILED' && e.send_error && <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{e.send_error}</p>}
        {e.send_state === 'PENDING' && <p className="mb-2 text-xs text-amber-800">{EMAIL_SEND_META.PENDING.hint}</p>}
        {formatted && e.has_html ? <EmailHtmlFrame emailId={e.id} hideQuoted={Boolean(body.quoted) && !showQuoted} />
          : <div className="whitespace-pre-wrap break-words leading-6" data-testid="email-body">{(showQuoted ? e.body_text : body.main) || '(no text content)'}</div>}
        {body.quoted && (
          <button type="button" onClick={() => setShowQuoted((v) => !v)} aria-expanded={showQuoted} data-testid="email-show-quoted"
            aria-label={showQuoted ? 'Hide quoted text' : 'Show trimmed content'} title={showQuoted ? 'Hide quoted text' : 'Show trimmed content'}
            className="mt-2 inline-flex h-3.5 items-center rounded-sm bg-[#E8EAED] px-1.5 text-[#444746] hover:bg-[#DADCE0] focus-visible:outline-2 focus-visible:outline-[#0B57D0]">
            <span className="-mt-1.5 text-base leading-none tracking-wider">…</span></button>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {e.has_html && <button type="button" onClick={() => setFormatted((f) => !f)} data-testid="email-toggle-format"
            className="inline-flex items-center gap-1 rounded-full border border-[#C4C7C5] px-3 py-1 text-xs text-[#444746] hover:bg-[#F8FAFD]"><Code2 className="size-3.5" />{formatted ? 'Plain text' : 'Formatted view'}</button>}
          {e.html_truncated && <span className="text-xs text-[#5F6368]">Formatted version too large to keep; text shown.</span>}
        </div>
        {files.length > 0 && (
          <div className="mt-4 border-t border-[#F1F3F4] pt-3" data-testid="email-attachments">
            <p className="mb-2 text-xs font-medium text-[#444746]">{files.length} attachment{files.length > 1 ? 's' : ''}
              {embedded > 0 && <span className="ml-1 font-normal text-[#5F6368]" data-testid="email-attachments-embedded">({embedded} embedded image{embedded > 1 ? 's' : ''})</span>}
              {files.some((a) => a.restricted) && <span className="ml-2 font-normal text-[#5F6368]"><Lock className="mr-0.5 inline size-3" />some are restricted</span>}</p>
            <div className="flex flex-wrap gap-3">{files.map((a, i) => <AttachmentTile key={a.id} a={a} onPreview={() => tools.onPreview(files, i)} />)}</div>
          </div>
        )}
        {e.skipped_attachments.map((a, i) => (
          <p key={`skip-${i}`} className="mt-1 text-xs text-amber-800" title={a.reason ?? ''}>{a.filename}: {a.state === 'BLOCKED' ? 'not stored (blocked type)' : a.state === 'TOO_LARGE' ? 'not stored (too large)' : a.state === 'FAILED' ? (a.reason?.startsWith('Gave up') ? 'download failed after 5 attempts (Support Settings → Email → Retry)' : 'download failed, retried automatically') : 'downloading…'}</p>
        ))}
      </div>
      <OriginalDialog e={e} open={original} onOpenChange={setOriginal} timezone={timezone} />
    </article>
  )
}
