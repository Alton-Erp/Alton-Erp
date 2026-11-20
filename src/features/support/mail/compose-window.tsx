import { Loader2, Maximize2, Minimize2, Minus, Paperclip, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { EmailSendBadge } from '@/features/support/email-components'
import { RichEditor, type RichEditorHandle } from '@/features/support/mail/rich-editor'
import { forwardBlock, forwardSubject } from '@/features/support/mail/mail-model'
import { EMAIL_ATTACHMENT_EXTENSIONS, emailAttachmentProblem, integrationMeta, parseRecipients, replyRecipients, replySubject } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatFileSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { signedAttachmentUrl } from '@/features/support/wa-web/media-urls'
import {
  closeEmailDraft, fetchComposeContext, saveEmailDraft, sendEmail, uploadOutboxFile, type ComposeContext, type EmailDraftData, type SendEmail, type SendResult, type ThreadEmail,
} from '@/services/email'

export interface MailComposeTarget {
  mode: 'NEW' | 'REPLY' | 'REPLY_ALL' | 'FORWARD'
  replyTo?: ThreadEmail | null
  conversationId?: string | null
  customerId?: string | null
  to?: string
  /** Reopening a saved draft. */
  draft?: { scope: string; version: number; data: EmailDraftData } | null
}

/** Floating compose window (bottom right; minimise, full size; full screen on phones). One request key per email. */
export function ComposeWindow(props: { target: MailComposeTarget; timezone?: string; onClose: () => void; onSent: (r: SendResult) => void; onDraftSaved?: () => void }) {
  const ctx = useAsync(fetchComposeContext, [])
  // Remounts when the mailbox context arrives, so reply-all recipients leave the support mailbox out from the start.
  return <ComposeForm key={ctx.data ? 'ready' : 'loading'} {...props} ctx={{ data: ctx.data ?? null, loading: ctx.loading }} />
}

type Size = 'normal' | 'min' | 'max'

function ComposeForm({ target, timezone, onClose, onSent, onDraftSaved, ctx }: {
  target: MailComposeTarget; timezone?: string; onClose: () => void; onSent: (r: SendResult) => void; onDraftSaved?: () => void
  ctx: { data: ComposeContext | null; loading: boolean }
}) {
  const { access } = useAuth()
  const c = ctx.data
  const reply = (target.mode === 'REPLY' || target.mode === 'REPLY_ALL') && target.replyTo ? target.replyTo : null
  const forward = target.mode === 'FORWARD' && target.replyTo ? target.replyTo : null
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [scope] = useState(() => target.draft?.scope ?? crypto.randomUUID())
  const version = useRef(target.draft?.version ?? 0)
  const [v, setV] = useState(() => {
    if (target.draft) { const d = target.draft.data; return { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, template: '', signature: true, showCc: Boolean(d.cc || d.bcc) } }
    const r = reply ? replyRecipients(reply, c?.mailbox ?? null, target.mode === 'REPLY_ALL') : { to: target.to ? [target.to] : [], cc: [] }
    return { to: r.to.join(', '), cc: r.cc.join(', '), bcc: '', subject: reply ? replySubject(reply.subject) : forward ? forwardSubject(forward.subject) : '',
      template: '', signature: true, showCc: r.cc.length > 0 }
  })
  const [size, setSize] = useState<Size>('normal')
  const [files, setFiles] = useState<SendEmail['attachments']>([])
  // Forwarding copies the original's attachments first (see the effect below).
  const [uploading, setUploading] = useState(() => Boolean(forward?.attachments.some((a) => !a.inline && !a.restricted && a.storage_path)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)
  const [draftState, setDraftState] = useState<'idle' | 'saving' | 'saved' | 'failed'>(target.draft ? 'saved' : 'idle')
  const [dirty, setDirty] = useState(0)
  const editor = useRef<RichEditorHandle>(null)
  const inFlight = useRef(false)
  const own = (c?.mailbox ?? '').toLowerCase()
  const locked = Boolean(result) || !c?.can_send

  // Initial content: a saved draft, or the forwarded message (plain text the agent can edit).
  useEffect(() => {
    if (target.draft) editor.current?.setValue(target.draft.data.body, target.draft.data.formatted)
    else if (forward) editor.current?.setValue(forwardBlock(forward, formatDateTime(forward.at, timezone)), false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Forward: the original's attachments are copied into this email's upload folder (same checks as files picked by hand).
  useEffect(() => {
    if (!forward || !access?.company?.id || !c?.can_send) return
    const list = forward.attachments.filter((a) => !a.inline && !a.restricted && a.storage_path)
    if (!list.length) return
    let live = true
    ;(async () => {
      const up: SendEmail['attachments'] = []
      for (const a of list) {
        try {
          const blob = await (await fetch(await signedAttachmentUrl(a.storage_path!))).blob()
          up.push(await uploadOutboxFile(access.company!.id, key, new File([blob], a.file_name, { type: a.content_type ?? blob.type })))
        } catch (e) {
          if (live) setError(`${a.file_name} could not be attached: ${describeDataError(e)}`)
        }
      }
      if (live) { setFiles((x) => [...x, ...up]); setUploading(false) }
    })()
    return () => { live = false }
  }, [forward?.id, c?.can_send]) // eslint-disable-line react-hooks/exhaustive-deps

  const draftData = useCallback((): EmailDraftData => {
    const body = editor.current?.value() ?? { text: '', formatted: false }
    return { mode: target.mode, to: v.to, cc: v.cc, bcc: v.bcc, subject: v.subject, body: body.text, formatted: body.formatted,
      reply_to_email_id: target.replyTo?.id ?? null, conversation_id: target.conversationId ?? null }
  }, [v, target.mode, target.replyTo?.id, target.conversationId])
  const saveDraft = useCallback(async () => {
    if (result) return
    const d = draftData()
    if (!d.to.trim() && !d.subject.trim() && !d.body.trim()) return
    setDraftState('saving')
    try {
      const r = await saveEmailDraft(scope, d, version.current)
      version.current = r.draft.version
      if (r.status === 'CONFLICT') await saveEmailDraft(scope, d, r.draft.version).then((x) => { version.current = x.draft.version })
      setDraftState('saved')
      onDraftSaved?.()
    } catch {
      setDraftState('failed')
    }
  }, [draftData, scope, result, onDraftSaved])
  // Auto-save 2 seconds after the last change.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => { void saveDraft() }, 2000)
    return () => clearTimeout(t)
  }, [dirty, v]) // eslint-disable-line react-hooks/exhaustive-deps
  const change = (patch: Partial<typeof v>) => { setV((s) => ({ ...s, ...patch })); setDirty((n) => n + 1) }

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
    const isNew = target.mode === 'NEW' || target.mode === 'FORWARD'
    if (isNew && !v.subject.trim()) { setError('Enter the subject.'); return }
    const body = editor.current?.value() ?? { text: '', formatted: false }
    if (!body.text.trim()) { setError('Enter the message.'); return }
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      const r = await sendEmail({ idempotency_key: key, mode: isNew ? 'NEW' : target.mode as 'REPLY' | 'REPLY_ALL', reply_to_email_id: reply?.id ?? null,
        conversation_id: target.mode === 'NEW' ? target.conversationId ?? null : null, customer_id: target.customerId ?? null, ticket_id: null,
        to: to.emails, cc: cc.emails.filter((e) => e !== own), bcc: bcc.emails, subject: isNew ? v.subject.trim() : undefined, body: body.text,
        template_id: v.template || null, include_signature: v.signature && Boolean(c?.signature), attachments: files, ...(body.formatted ? { format: 'markdown' as const } : {}) })
      setResult(r)
      if (r.send_state !== 'FAILED') void closeEmailDraft(scope, 'submitted').catch(() => {})
      onSent(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }
  const tryAgain = () => { setKey(crypto.randomUUID()); setFiles([]); setResult(null); setError(null) }
  const discard = async () => {
    if (draftState !== 'idle') await closeEmailDraft(scope, 'discarded').catch(() => {})
    onDraftSaved?.()
    onClose()
  }
  const close = async () => { if (!result && dirty) await saveDraft(); onClose() }
  const applyTemplate = (id: string) => {
    const t = c?.templates.find((x) => x.id === id)
    if (!t) return
    editor.current?.setValue(t.body, false)
    change({ template: id, subject: (target.mode === 'NEW' || target.mode === 'FORWARD') && t.subject && !v.subject ? t.subject : v.subject })
  }
  const title = result ? 'Message' : v.subject.trim() || { NEW: 'New message', REPLY: 'Reply', REPLY_ALL: 'Reply all', FORWARD: 'Forward' }[target.mode]
  const input = 'min-w-0 flex-1 bg-transparent py-1.5 text-sm text-[#1F1F1F] outline-none disabled:text-[#5F6368]'

  return (
    <>
      {size === 'max' && <div className="fixed inset-0 z-40 bg-black/40" aria-hidden onClick={() => setSize('normal')} />}
      <section role="dialog" aria-label={title} data-testid="email-compose" data-size={size}
        className={cn('fixed z-50 flex flex-col overflow-hidden bg-white shadow-[0_8px_10px_1px_rgba(0,0,0,0.14),0_3px_14px_2px_rgba(0,0,0,0.12)]',
          size === 'max' ? 'inset-4 rounded-2xl sm:inset-x-[8%] sm:inset-y-[6%]'
            : size === 'min' ? 'right-2 bottom-0 w-[min(320px,calc(100vw-1rem))] rounded-t-2xl sm:right-6'
            : 'inset-0 sm:inset-auto sm:right-6 sm:bottom-0 sm:h-[min(640px,calc(100dvh-5rem))] sm:w-[min(560px,calc(100vw-2rem))] sm:rounded-t-2xl')}>
        <header className="flex h-11 shrink-0 cursor-default items-center gap-1 bg-[#F2F6FC] pr-1 pl-4" onDoubleClick={() => setSize(size === 'min' ? 'normal' : 'min')}>
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-[#1F1F1F]">{title}</h2>
          <button type="button" aria-label={size === 'min' ? 'Restore' : 'Minimise'} title={size === 'min' ? 'Restore' : 'Minimise'} onClick={() => setSize(size === 'min' ? 'normal' : 'min')}
            className="hidden size-8 items-center justify-center rounded-full text-[#444746] hover:bg-black/5 sm:inline-flex"><Minus className="size-4" /></button>
          <button type="button" aria-label={size === 'max' ? 'Exit full screen' : 'Full screen'} title={size === 'max' ? 'Exit full screen' : 'Full screen'} onClick={() => setSize(size === 'max' ? 'normal' : 'max')}
            className="hidden size-8 items-center justify-center rounded-full text-[#444746] hover:bg-black/5 sm:inline-flex">{size === 'max' ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
          <button type="button" aria-label="Save draft and close" title="Save draft and close" onClick={() => void close()} data-testid="email-compose-close"
            className="inline-flex size-8 items-center justify-center rounded-full text-[#444746] hover:bg-black/5"><X className="size-4" /></button>
        </header>
        <div className={cn('flex min-h-0 flex-1 flex-col', size === 'min' && 'hidden')}>
        {ctx.loading && !c ? <p className="p-4 text-sm text-[#5F6368]">Loading…</p>
          : !c?.can_send ? (
            <p className="m-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="email-blocked">
              The support mailbox is {integrationMeta(c?.status).label.toLowerCase()}. An administrator connects it in Support Settings → Email; until then emails cannot be sent from here.</p>
          ) : (
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
              <div className="shrink-0 px-4 text-sm">
                <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><span className="w-14 text-[#5F6368]">From</span>
                  <span className="truncate py-1.5 text-[#1F1F1F]" data-testid="email-from">{c.display_name ? `${c.display_name} <${c.mailbox}>` : c.mailbox}</span></div>
                <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><label htmlFor="em-to" className="w-14 text-[#5F6368]">To</label>
                  <input id="em-to" className={input} value={v.to} onChange={(e) => change({ to: e.target.value })} disabled={locked} placeholder="Recipients" autoComplete="off" />
                  {!v.showCc && <button type="button" className="text-[#5F6368] hover:underline" onClick={() => setV((s) => ({ ...s, showCc: true }))}>Cc Bcc</button>}</div>
                {v.showCc && <>
                  <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><label htmlFor="em-cc" className="w-14 text-[#5F6368]">Cc</label>
                    <input id="em-cc" className={input} value={v.cc} onChange={(e) => change({ cc: e.target.value })} disabled={locked} autoComplete="off" /></div>
                  <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><label htmlFor="em-bcc" className="w-14 text-[#5F6368]">Bcc</label>
                    <input id="em-bcc" className={input} value={v.bcc} onChange={(e) => change({ bcc: e.target.value })} disabled={locked} autoComplete="off" /></div>
                </>}
                <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><label htmlFor="em-subject" className="w-14 text-[#5F6368]">Subject</label>
                  <input id="em-subject" className={input} value={v.subject} maxLength={300} onChange={(e) => change({ subject: e.target.value })}
                    disabled={(target.mode === 'REPLY' || target.mode === 'REPLY_ALL') || locked} title={reply ? 'Replies keep the original subject so Gmail threads them.' : undefined} /></div>
                {c.templates.length > 0 && !result && (
                  <div className="flex items-center gap-2 border-b border-[#E0E3E7]"><label htmlFor="em-template" className="w-14 text-[#5F6368]">Template</label>
                    <select id="em-template" className={cn(input, 'cursor-pointer')} value={v.template} onChange={(e) => applyTemplate(e.target.value)}>
                      <option value="">None</option>{c.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                )}
              </div>
              <RichEditor ref={editor} id="em-body" label="Message" disabled={locked} onChange={() => setDirty((n) => n + 1)} className="min-h-0 flex-1" />
              <div className="shrink-0 space-y-2 px-4 pb-2">
                {c.signature && (
                  <label className="flex items-start gap-2 text-xs text-[#5F6368]"><input type="checkbox" className="mt-0.5" checked={v.signature} disabled={locked} onChange={(e) => setV((s) => ({ ...s, signature: e.target.checked }))} />
                    <span>Add signature<span className="block whitespace-pre-wrap">-- {'\n'}{c.signature}</span></span></label>
                )}
                {(files.length > 0 || uploading) && (
                  <ul className="flex flex-wrap gap-2" data-testid="email-files">
                    {files.map((f) => (
                      <li key={f.path} className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#E0E3E7] bg-[#F8FAFD] px-2 py-1 text-xs">
                        <Paperclip className="size-3.5 shrink-0 text-[#5F6368]" /><span className="truncate">{f.file_name}</span><span className="text-[#5F6368]">({formatFileSize(f.size_bytes)})</span>
                        {!result && <button type="button" aria-label={`Remove ${f.file_name}`} onClick={() => setFiles((x) => x.filter((y) => y.path !== f.path))}><X className="size-3" /></button>}</li>
                    ))}
                    {uploading && <li className="inline-flex items-center gap-1 text-xs text-[#5F6368]"><Loader2 className="size-3 animate-spin" />Attaching…</li>}
                  </ul>
                )}
                {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                {result && (
                  <p role="status" data-testid="email-send-result" data-state={result.send_state}
                    className={cn('rounded-md border px-3 py-2 text-sm', result.send_state === 'SENT' ? 'border-green-200 bg-green-50 text-green-800'
                      : result.send_state === 'PENDING' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}>
                    <EmailSendBadge state={result.send_state} /> {result.message}</p>
                )}
              </div>
              <footer className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
                {/* Distinct keys: reusing one <button> would turn "Try again" into a submit during the same click. */}
                {result?.send_state === 'FAILED' ? <button key="again" type="button" onClick={tryAgain} className="rounded-full bg-[#0B57D0] px-6 py-2 text-sm font-medium text-white hover:bg-[#0A4CB8]">Try again</button>
                  : result ? <button key="done" type="button" onClick={onClose} className="rounded-full bg-[#0B57D0] px-6 py-2 text-sm font-medium text-white">Close</button>
                  : <button key="send" type="submit" disabled={busy || uploading} data-testid="email-send"
                      className="inline-flex items-center gap-2 rounded-full bg-[#0B57D0] px-6 py-2 text-sm font-medium text-white hover:bg-[#0A4CB8] disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}Send</button>}
                {!result && <>
                  <label className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-[#444746] hover:bg-black/5" title="Attach files (PDF, images, text, CSV, Office; 10 files, 10 MB)">
                    <Paperclip className="size-5" /><span className="sr-only">Attach files</span>
                    <input type="file" multiple className="sr-only" disabled={uploading} accept={EMAIL_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',')}
                      onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }} data-testid="email-file-input" />
                  </label>
                  <button type="button" onClick={() => void saveDraft()} data-testid="email-save-draft" className="rounded-full px-3 py-2 text-sm text-[#0B57D0] hover:bg-[#E8F0FE]">Save draft</button>
                  <span className="text-xs text-[#5F6368]" aria-live="polite" data-testid="email-draft-state">
                    {draftState === 'saving' ? 'Saving…' : draftState === 'saved' ? 'Draft saved' : draftState === 'failed' ? 'Draft not saved' : ''}</span>
                  <button type="button" onClick={() => void discard()} aria-label="Discard draft" title="Discard draft" data-testid="email-discard"
                    className="ml-auto inline-flex size-9 items-center justify-center rounded-full text-[#444746] hover:bg-black/5"><Trash2 className="size-5" /></button>
                </>}
              </footer>
            </form>
          )}
        </div>
      </section>
    </>
  )
}
