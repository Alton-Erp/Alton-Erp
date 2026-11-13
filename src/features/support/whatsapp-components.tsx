import { Download, FileText, Loader2, MapPin, Paperclip, Reply, Send, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/support/support-components'
import { WA_DOCUMENT_EXT, WA_IMAGE_EXT, WA_STATUS_META, waFileProblem, waTemplatePlaceholders, waTemplatePreview, waWindowText } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { attachmentUrl } from '@/services/support'
import {
  downloadWaMedia, fetchWaTemplates, fetchWaThread, sendWaMedia, sendWaTemplate, sendWaText, uploadWaFile, type WaMessage, type WaSendResult,
} from '@/services/whatsapp'

export function WaStatusBadge({ status }: { status: string }) {
  const m = WA_STATUS_META[status] ?? WA_STATUS_META.PENDING
  return <span title={m.hint} data-testid="wa-status" data-status={status}><StatusBadge label={m.label} tone={m.tone} /></span>
}

function MediaLine({ m, onChanged }: { m: WaMessage; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (m.attachment) {
    const a = m.attachment
    return a.restricted || !a.storage_path ? <p className="text-xs text-muted-foreground">{a.file_name} (restricted)</p> : (
      <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="wa-attachment"
        onClick={() => { setError(null); attachmentUrl(a.storage_path!).then((u) => window.open(u, '_blank', 'noopener'), (e) => setError(describeDataError(e))) }}>
        <Paperclip className="size-3.5" />{a.file_name}{error && <span className="text-red-700"> {error}</span>}</button>
    )
  }
  if (m.media_state === 'PENDING' || m.media_state === 'FAILED') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {m.media_state === 'PENDING' ? 'Media not downloaded yet.' : `Download failed: ${m.media_error ?? 'error'}.`}
        <Button size="sm" variant="ghost" className="h-6 px-2" disabled={busy} onClick={() => {
          setBusy(true); setError(null)
          downloadWaMedia(m.id).then(onChanged, (e) => setError(e instanceof Error ? e.message : describeDataError(e))).finally(() => setBusy(false))
        }}>{busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Download</Button>
        {error && <span className="text-red-700">{error}</span>}
      </p>
    )
  }
  if (m.media_state === 'EXPIRED') return <p className="text-xs text-muted-foreground">Media no longer available at Meta (media ids expire after 7 days).</p>
  if (m.media_state === 'TOO_LARGE') return <p className="text-xs text-muted-foreground">Media larger than 25 MB was not stored.</p>
  if (m.media_state === 'BLOCKED') return <p className="text-xs text-muted-foreground">Executable file not stored.</p>
  return null
}

/** WhatsApp conversation: messages with statuses and media, the 24-hour window, replies, attachments and templates. */
export function WhatsAppPanel({ conversationId, timezone, onChanged }: { conversationId: string; timezone?: string; onChanged: () => void }) {
  const { access } = useAuth()
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchWaThread(conversationId), [conversationId, refresh])
  const [text, setText] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [replyTo, setReplyTo] = useState<WaMessage | null>(null)
  const [file, setFile] = useState<{ path: string; file_name: string; content_type: string | null; size_bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const inFlight = useRef(false)
  const reload = () => { setRefresh((n) => n + 1); onChanged() }
  if (q.loading && !q.data) return <p className="text-sm text-muted-foreground">Loading WhatsApp messages…</p>
  if (q.error) return <p role="alert" className="text-sm text-red-700">{describeDataError(q.error)}</p>
  const t = q.data
  if (!t) return null
  const done = (r: WaSendResult) => {
    setNotice({ ok: r.status !== 'FAILED', text: r.message })
    setText(''); setFile(null); setReplyTo(null); setKey(crypto.randomUUID())
    reload()
  }
  const send = async () => {
    if (inFlight.current) return
    if (!file && !text.trim()) { setNotice({ ok: false, text: 'Enter the message.' }); return }
    if (!file && text.length > 4096) { setNotice({ ok: false, text: 'At most 4,096 characters.' }); return }
    inFlight.current = true
    setBusy(true); setNotice(null)
    try {
      done(file ? await sendWaMedia({ idempotency_key: key, conversation_id: conversationId, ...file, caption: text.trim() || null, reply_to: replyTo?.id ?? null })
        : await sendWaText({ idempotency_key: key, conversation_id: conversationId, text: text.trim(), reply_to: replyTo?.id ?? null }))
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) })
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }
  const pick = async (f: File | undefined) => {
    if (!f || !access?.company?.id) return
    const problem = waFileProblem(f)
    if (problem) { setNotice({ ok: false, text: problem }); return }
    setBusy(true); setNotice(null)
    try { setFile(await uploadWaFile(access.company.id, key, f)) } catch (e) { setNotice({ ok: false, text: describeDataError(e) }) } finally { setBusy(false) }
  }
  const byWaId = new Map(t.messages.filter((m) => m.wa_message_id).map((m) => [m.wa_message_id!, m]))
  return (
    <section className="space-y-3" aria-label="WhatsApp" data-testid="wa-panel">
      <p className="text-xs text-muted-foreground">WhatsApp {t.contact.wa_id ? `+${t.contact.wa_id}` : t.contact.user_id ? `user ${t.contact.user_id}` : ''}
        {t.contact.profile_name ? ` · ${t.contact.profile_name}` : ''}</p>
      <ol className="max-h-[28rem] space-y-2 overflow-y-auto rounded-lg border bg-surface-muted/40 p-3" data-testid="wa-messages">
        {t.messages.map((m) => {
          const inbound = m.direction === 'INBOUND'
          const quoted = m.context_wa_message_id ? byWaId.get(m.context_wa_message_id) : null
          return (
            <li key={m.id} className={cn('flex', inbound ? 'justify-start' : 'justify-end')} data-testid={`wa-${m.id}`}>
              <div className={cn('max-w-[85%] rounded-lg border px-3 py-2 text-sm', inbound ? 'bg-card' : 'border-green-200 bg-green-50')}>
                <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{inbound ? t.contact.profile_name ?? 'Customer' : m.author ?? 'Agent'}</span>
                  <time>{formatDateTime(m.at, timezone)}</time>
                  {!inbound && <WaStatusBadge status={m.status} />}
                  {m.template_name && <span className="rounded bg-muted px-1.5 py-0.5">template</span>}
                </p>
                {quoted && <p className="mb-1 border-l-2 pl-2 text-xs text-muted-foreground">{quoted.body.slice(0, 120)}</p>}
                {m.type === 'location' && m.location ? (
                  <p className="flex items-center gap-1"><MapPin className="size-4" />{[m.location.name, m.location.address].filter(Boolean).join(', ') || 'Location'}
                    <a className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps?q=${Number(m.location.latitude)},${Number(m.location.longitude)}`}>map</a></p>
                ) : <p className="whitespace-pre-wrap">{m.body}</p>}
                <MediaLine m={m} onChanged={reload} />
                {m.status === 'FAILED' && <p role="alert" className="mt-1 text-xs text-red-700">{m.error_title ?? 'Failed'}{m.error_code ? ` (${m.error_code})` : ''}{m.error_detail ? `: ${m.error_detail}` : ''}</p>}
                {m.status === 'PENDING' && m.error_title === 'Not confirmed' && <p className="mt-1 text-xs text-amber-800">Meta did not confirm this request; check WhatsApp Manager before sending it again.</p>}
                {inbound && t.can_send && t.window_open && <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => setReplyTo(m)}><Reply className="size-3" />Reply</button>}
              </div>
            </li>
          )
        })}
        {!t.messages.length && <li className="py-4 text-center text-sm text-muted-foreground">No WhatsApp messages yet.</li>}
      </ol>
      <p className={cn('rounded-md border px-3 py-2 text-xs', t.window_open ? 'border-green-200 bg-green-50 text-green-900' : 'border-amber-200 bg-amber-50 text-amber-900')} data-testid="wa-window" data-open={t.window_open}>
        {waWindowText(t.window_open, t.window_closes_at)}</p>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={cn('text-sm', notice.ok ? 'text-green-800' : 'text-red-700')} data-testid="wa-notice">{notice.text}</p>}
      {!t.can_send ? <p className="text-sm text-muted-foreground" data-testid="wa-blocked">WhatsApp is not switched on (Support Settings → WhatsApp) or your role cannot send messages.</p> : (
        <div className="space-y-2 rounded-lg border p-3" data-testid="wa-composer">
          {replyTo && <p className="flex items-center gap-2 text-xs text-muted-foreground">Replying to: {replyTo.body.slice(0, 80)}
            <button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X className="size-3" /></button></p>}
          {t.window_open ? <>
            <Textarea aria-label={file ? 'Caption' : 'WhatsApp message'} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={file ? 1024 : 4096}
              placeholder={file ? 'Caption (optional)' : 'Message'} />
            {file && <p className="flex items-center gap-2 text-xs"><FileText className="size-3.5" />{file.file_name}
              <button type="button" aria-label="Remove file" onClick={() => setFile(null)}><X className="size-3" /></button></p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary hover:underline"><Paperclip className="size-4" />Image / document
                  <input type="file" className="sr-only" accept={[...WA_IMAGE_EXT, ...WA_DOCUMENT_EXT].map((e) => `.${e}`).join(',')} disabled={busy}
                    onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} data-testid="wa-file" /></label>
                <Button size="sm" variant="outline" onClick={() => setTemplateOpen(true)}>Template</Button>
              </div>
              <Button size="sm" disabled={busy} onClick={() => void send()} data-testid="wa-send">{busy ? <Loader2 className="animate-spin" /> : <Send />} Send</Button>
            </div>
          </> : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">Free-form messages are not allowed now.</p>
              <Button size="sm" onClick={() => setTemplateOpen(true)} data-testid="wa-template-open">Send approved template</Button>
            </div>
          )}
        </div>
      )}
      {templateOpen && <WaTemplateDialog conversationId={conversationId} onClose={() => setTemplateOpen(false)} onSent={(r) => { setTemplateOpen(false); done(r) }} />}
    </section>
  )
}

/** Approved template (the only message allowed outside the window or to start a conversation). */
export function WaTemplateDialog({ conversationId, customerId, onClose, onSent }: {
  conversationId?: string | null; customerId?: string | null; onClose: () => void; onSent: (r: WaSendResult) => void
}) {
  const templates = useAsync(fetchWaTemplates, [])
  const [templateId, setTemplateId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [to, setTo] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const tpl = templates.data?.find((t) => t.id === templateId) ?? null
  const ph = tpl ? waTemplatePlaceholders(tpl.components) : { vars: [], supported: true }
  const submit = async () => {
    if (inFlight.current) return
    if (!tpl) { setError('Choose an approved template.'); return }
    if (!ph.supported) { setError('This template needs a media header or button parameters, which the ERP does not send.'); return }
    const missing = ph.vars.filter((v) => !(values[v] ?? '').trim())
    if (missing.length) { setError(`Enter values for ${missing.map((v) => `{{${v}}}`).join(', ')}.`); return }
    if (ph.vars.some((v) => /[\n\t]/.test(values[v]))) { setError('Template values cannot contain line breaks or tabs.'); return }
    if (!conversationId && to.replace(/\D/g, '').length < 8) { setError('Enter the WhatsApp number with its country code.'); return }
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      onSent(await sendWaTemplate({ idempotency_key: key, conversation_id: conversationId ?? null, to: conversationId ? null : to, customer_id: customerId ?? null, template_id: tpl.id,
        parameters: Object.fromEntries(ph.vars.map((v) => [v, values[v].trim()])) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" data-testid="wa-template-dialog">
        <DialogHeader><DialogTitle>Send approved template</DialogTitle>
          <DialogDescription>Only templates approved by Meta can be sent outside the 24-hour customer service window or to start a conversation.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          {!conversationId && <Field label="WhatsApp number" htmlFor="wa-to"><Input id="wa-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+91 98765 43210" inputMode="tel" /></Field>}
          <Field label="Template" htmlFor="wa-tpl">
            <Select value={templateId || undefined} onValueChange={(v) => { setTemplateId(v); setValues({}) }}>
              <SelectTrigger id="wa-tpl"><SelectValue placeholder={templates.loading ? 'Loading…' : templates.data?.length ? 'Choose a template' : 'No approved templates (synchronise in Settings)'} /></SelectTrigger>
              <SelectContent>{(templates.data ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name} · {t.language}{t.category ? ` · ${t.category.toLowerCase()}` : ''}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {tpl && !ph.supported && <p className="text-sm text-amber-800">This template needs a media header or button parameters, which the ERP does not send. Choose another.</p>}
          {ph.vars.map((v) => (
            <Field key={v} label={`Value for {{${v}}}`} htmlFor={`wa-v-${v}`}><Input id={`wa-v-${v}`} value={values[v] ?? ''} maxLength={1024} onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))} /></Field>
          ))}
          {tpl && <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap" data-testid="wa-template-preview">{waTemplatePreview(tpl.components, values)}</div>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !tpl} data-testid="wa-template-send">{busy && <Loader2 className="animate-spin" />}Send template</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
