import { FileText, Image as ImageIcon, LayoutTemplate, Loader2, Mic, Paperclip, Send, Smile, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { WA_DOCUMENT_EXT, WA_IMAGE_EXT, waFileProblem } from '@/features/support/support-model'
import { EmojiPicker } from '@/features/support/wa-web/emoji-picker'
import { IconButton } from '@/features/support/wa-web/wa-ui'
import { composerKey, composerProblem, insertAt, WA_CAPTION_LIMIT, WA_TEXT_LIMIT } from '@/features/support/wa-web/wa-web-model'
import { describeDataError } from '@/lib/errors'
import { formatFileSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { sendWaMedia, sendWaText, uploadWaFile, type WaMessage, type WaSendResult } from '@/services/whatsapp'

const accept = (ext: string[]) => ext.map((e) => `.${e}`).join(',')

/**
 * Bottom composer. The send path is the existing one (whatsapp-send-message with a fresh idempotency key per message;
 * one request per click). Free-form messages only inside the 24-hour window; otherwise an approved template.
 */
export function ChatComposer({ conversationId, windowOpen, canSend, replyTo, customerName, onCancelReply, onSent, onTemplate, onError }: {
  conversationId: string; windowOpen: boolean; canSend: boolean; replyTo: WaMessage | null; customerName: string
  onCancelReply: () => void; onSent: (r: WaSendResult) => void; onTemplate: () => void; onError: (text: string) => void
}) {
  const { access } = useAuth()
  const [text, setText] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [file, setFile] = useState<{ path: string; file_name: string; content_type: string | null; size_bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const inFlight = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)

  // Grow with the text up to six lines, like WhatsApp; restore the caret after an emoji is inserted.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 6 * 20 + 18)}px`
    if (caret.current !== null) { el.setSelectionRange(caret.current, caret.current); caret.current = null }
  }, [text])

  if (!canSend) {
    return <p className="bg-[#F0F2F5] px-4 py-3 text-center text-sm text-[#667781]" data-testid="wa-blocked">WhatsApp is not switched on (Support Settings → WhatsApp) or your role cannot send messages.</p>
  }
  if (!windowOpen) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3 bg-[#F0F2F5] px-4 py-3 text-sm text-[#667781]" data-testid="wa-composer-closed">
        <span>Free-form messages are not allowed now: the customer has not written in the last 24 hours.</span>
        <button type="button" onClick={onTemplate} data-testid="wa-template-open" className="rounded-full bg-[#008069] px-4 py-2 font-medium text-white hover:bg-[#017561]">Send approved template</button>
      </div>
    )
  }

  const send = async () => {
    if (inFlight.current) return
    const problem = composerProblem(text, Boolean(file))
    if (problem) { onError(problem); return }
    inFlight.current = true
    setBusy(true)
    try {
      const r = file
        ? await sendWaMedia({ idempotency_key: key, conversation_id: conversationId, ...file, caption: text.trim() || null, reply_to: replyTo?.id ?? null })
        : await sendWaText({ idempotency_key: key, conversation_id: conversationId, text: text.trim(), reply_to: replyTo?.id ?? null })
      setText(''); setFile(null); setKey(crypto.randomUUID())
      onSent(r)
    } catch (e) {
      onError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
      inFlight.current = false
      area.current?.focus()
    }
  }
  const pick = async (f: File | undefined) => {
    if (!f || !access?.company?.id) return
    const problem = waFileProblem(f)
    if (problem) { onError(problem); return }
    setBusy(true)
    try { setFile(await uploadWaFile(access.company.id, key, f)) } catch (e) { onError(describeDataError(e)) } finally { setBusy(false) }
  }
  const addEmoji = (e: string) => {
    const el = area.current
    const r = insertAt(text, el?.selectionStart ?? null, el?.selectionEnd ?? null, e)
    caret.current = r.caret
    setText(r.text)
    setEmojiOpen(false)
    el?.focus()
  }
  const limit = file ? WA_CAPTION_LIMIT : WA_TEXT_LIMIT
  return (
    <div className="bg-[#F0F2F5]" data-testid="wa-composer">
      {(replyTo || file) && (
        <div className="space-y-1 px-4 pt-2">
          {replyTo && (
            <div className="flex items-center gap-2 rounded-lg bg-white p-2" data-testid="wa-reply-preview">
              <div className="min-w-0 flex-1 rounded-md border-l-4 border-[#06CF9C] bg-[#F5F6F6] px-2 py-1">
                <p className="text-xs font-medium text-[#06CF9C]">{replyTo.direction === 'INBOUND' ? customerName : replyTo.author ?? 'You'}</p>
                <p className="truncate text-sm text-[#667781]">{replyTo.body}</p>
              </div>
              <IconButton label="Cancel reply" onClick={onCancelReply} className="size-8"><X /></IconButton>
            </div>
          )}
          {file && (
            <div className="flex items-center gap-2 rounded-lg bg-white p-2 text-sm" data-testid="wa-file-preview">
              <FileText className="size-6 text-[#54656F]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.file_name} <span className="text-xs text-[#667781]">· {formatFileSize(file.size_bytes)}</span></span>
              <IconButton label="Remove file" onClick={() => setFile(null)} className="size-8"><X /></IconButton>
            </div>
          )}
        </div>
      )}
      <div className="flex items-end gap-1 px-2 py-2 md:px-4">
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Emoji" title="Emoji" data-testid="wa-emoji" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-[#54656F] hover:bg-black/5"><Smile className="size-6" /></button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-auto p-0">
            <EmojiPicker onPick={addEmoji} />
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Attach" title="Attach" disabled={busy} data-testid="wa-attach" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-[#54656F] hover:bg-black/5 disabled:opacity-40"><Paperclip className="size-6" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuItem onSelect={() => document.getElementById('wa-file-doc')?.click()}><FileText className="text-[#7F66FF]" />Document <span className="ml-auto text-[10px] text-muted-foreground">PDF, Office, text · 25 MB</span></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => document.getElementById('wa-file-img')?.click()}><ImageIcon className="text-[#007BFC]" />Photo <span className="ml-auto text-[10px] text-muted-foreground">JPEG, PNG · 5 MB</span></DropdownMenuItem>
            <DropdownMenuItem disabled title="The ERP's WhatsApp connector sends images and documents only."><Mic />Audio <span className="ml-auto text-[10px]">not supported</span></DropdownMenuItem>
            <DropdownMenuItem onSelect={onTemplate}><LayoutTemplate className="text-[#008069]" />Approved template</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input id="wa-file-doc" type="file" className="sr-only" tabIndex={-1} aria-hidden accept={[...WA_IMAGE_EXT, ...WA_DOCUMENT_EXT].map((e) => `.${e}`).join(',')} disabled={busy}
          onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} data-testid="wa-file" />
        <input id="wa-file-img" type="file" className="sr-only" tabIndex={-1} aria-hidden accept={accept(WA_IMAGE_EXT)} disabled={busy}
          onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
        <div className="relative min-w-0 flex-1">
          <textarea ref={area} rows={1} aria-label={file ? 'Caption' : 'WhatsApp message'} value={text} maxLength={limit}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) === 'send') { e.preventDefault(); void send() } }}
            placeholder={file ? 'Add a caption' : 'Type a message'}
            className="block max-h-[138px] w-full resize-none rounded-lg bg-white px-3 py-[9px] text-[15px] leading-5 text-[#111B21] outline-none placeholder:text-[#667781] focus-visible:ring-2 focus-visible:ring-[#00A884]/40" />
          {text.length > limit - 200 && <span className={cn('absolute -top-5 right-1 text-[11px]', text.length >= limit ? 'text-red-700' : 'text-[#667781]')} aria-live="polite">{text.length.toLocaleString('en-IN')} / {limit.toLocaleString('en-IN')}</span>}
        </div>
        <button type="button" aria-label="Send" title="Send (Enter) · new line: Shift+Enter" disabled={busy} onClick={() => void send()} data-testid="wa-send"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[#00A884] text-white hover:bg-[#008069] disabled:opacity-60">
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}</button>
      </div>
    </div>
  )
}
