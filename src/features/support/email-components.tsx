import { Code2, Loader2, Lock, Mail, Paperclip, Reply, ReplyAll, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/support/support-components'
import {
  EMAIL_ATTACHMENT_EXTENSIONS, EMAIL_SEND_META, emailAttachmentProblem, integrationMeta, parseRecipients, replyRecipients, replySubject,
} from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  fetchComposeContext, fetchEmailHtml, sendEmail, uploadOutboxFile, type ComposeContext, type SendEmail, type SendResult, type ThreadEmail,
} from '@/services/email'
import { attachmentUrl } from '@/services/support'

export function EmailSendBadge({ state }: { state: 'PENDING' | 'SENT' | 'FAILED' | null | undefined }) {
  if (!state) return null
  const m = EMAIL_SEND_META[state]
  return <span title={m.hint} data-testid="email-send-state" data-state={state}><StatusBadge label={m.label} tone={m.tone} /></span>
}

const addrs = (list: { email: string; name: string | null }[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')

/**
 * Sanitised HTML (cleaned on the server) in a sandboxed frame: no scripts, no same-origin access, no remote
 * content (CSP), links open in a new window.
 */
export function EmailHtmlFrame({ emailId }: { emailId: string }) {
  const q = useAsync(() => fetchEmailHtml(emailId), [emailId])
  if (q.loading) return <p className="text-xs text-muted-foreground">Loading formatted view…</p>
  if (q.error || !q.data) return <p className="text-xs text-muted-foreground">The formatted version is not available.</p>
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:8px;color:#111;word-wrap:break-word}table{max-width:100%}blockquote{border-left:3px solid #ddd;margin:0;padding-left:8px;color:#555}</style></head>`
    + `<body>${q.data}</body></html>`
  return <iframe title="Formatted email" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} referrerPolicy="no-referrer"
    className="h-80 w-full resize-y rounded-md border bg-white" data-testid="email-html-frame" />
}

export function EmailCard({ email, timezone, canReply, onReply }: {
  email: ThreadEmail; timezone?: string; canReply: boolean; onReply: (mode: 'REPLY' | 'REPLY_ALL') => void
}) {
  const [formatted, setFormatted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inbound = email.direction === 'INBOUND'
  return (
    <article className={cn('rounded-lg border px-3 py-2 text-sm', inbound ? 'bg-card' : 'border-blue-200 bg-blue-50')} data-testid={`email-${email.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium">{email.subject || '(no subject)'}</p>
          <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}</span>
            {' · '}{formatDateTime(email.at, timezone)}{!inbound && email.author ? ` · by ${email.author}` : ''}</p>
          <p className="text-xs text-muted-foreground" data-testid="email-recipients">To: {addrs(email.to) || '—'}{email.cc.length ? ` · Cc: ${addrs(email.cc)}` : ''}{email.bcc.length ? ` · Bcc: ${addrs(email.bcc)}` : ''}</p>
        </div>
        <div className="flex items-center gap-1">
          {!inbound && <EmailSendBadge state={email.send_state} />}
          {canReply && <>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onReply('REPLY')} aria-label="Reply"><Reply className="size-3.5" /> Reply</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onReply('REPLY_ALL')} aria-label="Reply all"><ReplyAll className="size-3.5" /> Reply all</Button>
          </>}
        </div>
      </header>
      {email.send_state === 'FAILED' && email.send_error && <p className="mt-1 text-xs text-red-700" role="alert">{email.send_error}</p>}
      {email.send_state === 'PENDING' && <p className="mt-1 text-xs text-amber-800">{EMAIL_SEND_META.PENDING.hint}</p>}
      {formatted && email.has_html ? <div className="mt-2"><EmailHtmlFrame emailId={email.id} /></div>
        : <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap">{email.body_text || '(no text content)'}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {email.has_html && <Button size="sm" variant="outline" className="h-7" onClick={() => setFormatted((f) => !f)} data-testid="email-toggle-format">
          <Code2 className="size-3.5" />{formatted ? 'Plain text' : 'Formatted view'}</Button>}
        {email.html_truncated && <span className="text-xs text-muted-foreground">Formatted version too large to keep; text shown.</span>}
        {email.attachments.map((a) => (a.restricted || !a.storage_path
          ? <span key={a.id} className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" />{a.file_name}</span>
          : <button key={a.id} type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="email-attachment"
              onClick={() => { setError(null); attachmentUrl(a.storage_path!).then((u) => window.open(u, '_blank', 'noopener'), (e) => setError(describeDataError(e))) }}>
              <Paperclip className="size-3.5" />{a.file_name}{a.size_bytes ? ` (${Math.max(1, Math.round(a.size_bytes / 1024))} KB)` : ''}</button>))}
        {email.skipped_attachments.map((a, i) => (
          <span key={`skip-${i}`} className="text-xs text-amber-800" title={a.reason ?? ''}>{a.filename}: {a.state === 'BLOCKED' ? 'not stored (blocked type)' : a.state === 'TOO_LARGE' ? 'not stored (too large)' : a.state === 'FAILED' ? 'download failed, retried on the next sync' : 'downloading…'}</span>
        ))}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </article>
  )
}

export interface ComposeTarget {
  mode: 'NEW' | 'REPLY' | 'REPLY_ALL'
  replyTo?: ThreadEmail | null
  conversationId?: string | null
  customerId?: string | null
  ticketId?: string | null
  to?: string
}

/** Compose / reply from the connected support mailbox. One request key per dialog: repeated clicks never send twice. */
export function EmailComposeDialog(props: { target: ComposeTarget; onClose: () => void; onSent: (r: SendResult) => void }) {
  const ctx = useAsync(fetchComposeContext, [])
  // Remounts when the mailbox context arrives, so reply-all recipients leave the support mailbox out from the start.
  return <ComposeForm key={ctx.data ? 'ready' : 'loading'} {...props} ctx={{ data: ctx.data ?? null, loading: ctx.loading }} />
}

function ComposeForm({ target, onClose, onSent, ctx }: {
  target: ComposeTarget; onClose: () => void; onSent: (r: SendResult) => void; ctx: { data: ComposeContext | null; loading: boolean }
}) {
  const { access } = useAuth()
  const reply = target.mode !== 'NEW' && target.replyTo ? target.replyTo : null
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [v, setV] = useState(() => {
    const r = reply ? replyRecipients(reply, ctx.data?.mailbox ?? null, target.mode === 'REPLY_ALL') : { to: target.to ? [target.to] : [], cc: [] }
    return { to: r.to.join(', '), cc: r.cc.join(', '), bcc: '', subject: reply ? replySubject(reply.subject) : '', body: '', template: '', signature: true, showBcc: false }
  })
  const [files, setFiles] = useState<SendEmail['attachments']>([])
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)
  const inFlight = useRef(false)
  const c = ctx.data
  const own = (c?.mailbox ?? '').toLowerCase()
  const ccList = parseRecipients(v.cc).emails.filter((e) => e !== own)

  const addFiles = async (list: FileList | null) => {
    if (!list?.length || !access?.company?.id) return
    const picked = Array.from(list)
    const problem = emailAttachmentProblem([...files.map((f) => ({ name: f.file_name, size: f.size_bytes })), ...picked.map((f) => ({ name: f.name, size: f.size }))])
    if (problem) { setError(problem); return }
    setUploading(true); setError(null)
    try {
      const up: SendEmail['attachments'] = []
      for (const f of picked) up.push(await uploadOutboxFile(access.company.id, key, f))
      setFiles((x) => [...x, ...up])
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    if (inFlight.current || result) return
    const to = parseRecipients(v.to)
    const cc = parseRecipients(v.cc)
    const bcc = parseRecipients(v.bcc)
    const bad = [...to.invalid, ...cc.invalid, ...bcc.invalid]
    if (bad.length) { setError(`Not an email address: ${bad.join(', ')}`); return }
    if (!to.emails.length) { setError('Enter at least one recipient.'); return }
    if (target.mode === 'NEW' && !v.subject.trim()) { setError('Enter the subject.'); return }
    if (!v.body.trim()) { setError('Enter the message.'); return }
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      const r = await sendEmail({ idempotency_key: key, mode: target.mode, reply_to_email_id: reply?.id ?? null, conversation_id: target.mode === 'NEW' ? target.conversationId ?? null : null,
        customer_id: target.customerId ?? null, ticket_id: target.ticketId ?? null, to: to.emails, cc: cc.emails.filter((e) => e !== own), bcc: bcc.emails, subject: target.mode === 'NEW' ? v.subject.trim() : undefined,
        body: v.body, template_id: v.template || null, include_signature: v.signature && Boolean(c?.signature), attachments: files })
      setResult(r)
      onSent(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }
  const tryAgain = () => { setKey(crypto.randomUUID()); setFiles([]); setResult(null); setError(null) }
  const applyTemplate = (id: string) => {
    const t = c?.templates.find((x) => x.id === id)
    setV((s) => ({ ...s, template: id, body: t ? t.body : s.body, subject: target.mode === 'NEW' && t?.subject && !s.subject ? t.subject : s.subject }))
  }
  const title = target.mode === 'NEW' ? 'New email' : target.mode === 'REPLY' ? 'Reply' : 'Reply all'
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto" data-testid="email-compose">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mail className="size-4" />{title}</DialogTitle>
          <DialogDescription>From {c?.display_name ? `${c.display_name} <${c.mailbox}>` : c?.mailbox ?? 'the support mailbox'} through Gmail.</DialogDescription>
        </DialogHeader>
        {ctx.loading && !c ? <p className="text-sm text-muted-foreground">Loading…</p>
          : !c?.can_send ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="email-blocked">
              The support mailbox is {integrationMeta(c?.status).label.toLowerCase()}. An administrator connects it in Support Settings → Email; until then emails cannot be sent from here.</p>
          ) : (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
              <Field label="To" htmlFor="em-to"><Input id="em-to" value={v.to} onChange={(e) => setV((s) => ({ ...s, to: e.target.value }))} disabled={Boolean(result)} placeholder="name@example.com, …" /></Field>
              <Field label="Cc" htmlFor="em-cc"><Input id="em-cc" value={v.cc} onChange={(e) => setV((s) => ({ ...s, cc: e.target.value }))} disabled={Boolean(result)} /></Field>
              {v.showBcc ? <Field label="Bcc" htmlFor="em-bcc"><Input id="em-bcc" value={v.bcc} onChange={(e) => setV((s) => ({ ...s, bcc: e.target.value }))} disabled={Boolean(result)} /></Field>
                : <button type="button" className="text-xs text-primary hover:underline" onClick={() => setV((s) => ({ ...s, showBcc: true }))}>Add Bcc</button>}
              {ccList.length !== parseRecipients(v.cc).emails.length && <p className="text-xs text-muted-foreground">The support mailbox is left out of Cc.</p>}
              <Field label="Subject" htmlFor="em-subject" hint={target.mode === 'NEW' ? undefined : 'Replies keep the original subject so Gmail threads them.'}>
                <Input id="em-subject" value={v.subject} onChange={(e) => setV((s) => ({ ...s, subject: e.target.value }))} disabled={target.mode !== 'NEW' || Boolean(result)} maxLength={300} />
              </Field>
              {c.templates.length > 0 && (
                <Field label="Template" htmlFor="em-template">
                  <Select value={v.template || undefined} onValueChange={applyTemplate} disabled={Boolean(result)}>
                    <SelectTrigger id="em-template"><SelectValue placeholder="Approved templates" /></SelectTrigger>
                    <SelectContent>{c.templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="Message" htmlFor="em-body"><Textarea id="em-body" rows={8} value={v.body} onChange={(e) => setV((s) => ({ ...s, body: e.target.value }))} maxLength={20000} disabled={Boolean(result)} /></Field>
              {c.signature && (
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={v.signature} onCheckedChange={(x) => setV((s) => ({ ...s, signature: x === true }))} disabled={Boolean(result)} />
                  <span>Add signature<span className="block whitespace-pre-wrap text-xs text-muted-foreground">-- {'\n'}{c.signature}</span></span></label>
              )}
              <div className="space-y-1">
                <label className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary hover:underline">
                  <Paperclip className="size-4" />Attach files
                  <input type="file" multiple className="sr-only" disabled={uploading || Boolean(result)} accept={EMAIL_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',')}
                    onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }} data-testid="email-file-input" />
                </label>
                {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
                <ul className="flex flex-wrap gap-2">{files.map((f) => (
                  <li key={f.path} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs">{f.file_name}
                    {!result && <button type="button" aria-label={`Remove ${f.file_name}`} onClick={() => setFiles((x) => x.filter((y) => y.path !== f.path))}><X className="size-3" /></button>}</li>
                ))}</ul>
                <p className="text-xs text-muted-foreground">PDF, images, text, CSV and Office documents; up to 10 files and 10 MB in total.</p>
              </div>
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              {result && (
                <p role="status" data-testid="email-send-result" data-state={result.send_state}
                  className={cn('rounded-md border px-3 py-2 text-sm', result.send_state === 'SENT' ? 'border-green-200 bg-green-50 text-green-800'
                    : result.send_state === 'PENDING' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}>
                  <EmailSendBadge state={result.send_state} /> {result.message}</p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
                {/* Distinct keys: reusing one <button> would turn "Try again" into a submit during the same click. */}
                {result?.send_state === 'FAILED' ? <Button key="again" type="button" onClick={tryAgain}>Try again</Button>
                  : !result && <Button key="send" type="submit" disabled={busy || uploading} data-testid="email-send">{busy && <Loader2 className="animate-spin" />}Send</Button>}
              </DialogFooter>
            </form>
          )}
      </DialogContent>
    </Dialog>
  )
}
