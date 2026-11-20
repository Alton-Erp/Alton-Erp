import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { editorHtml, editorToMarkup, type EditorNode } from '@/features/support/mail/mail-model'
import { cn } from '@/lib/utils'

export interface RichEditorHandle {
  /** The content as markup (formatted) or plain text; never HTML. */
  value: () => { text: string; formatted: boolean }
  setValue: (text: string, formatted: boolean) => void
  focus: () => void
  isEmpty: () => boolean
}

function ToolButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
          className={cn('inline-flex size-8 items-center justify-center rounded text-[#444746] hover:bg-[#E8EAED] [&_svg]:size-4', active && 'bg-[#D3E3FD]')}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Rich-text message editor: bold, italic, underline, links, bulleted and numbered lists. Pasting inserts plain text
 * (no foreign HTML). The content leaves the browser as markup only (editorToMarkup).
 */
export const RichEditor = forwardRef<RichEditorHandle, { id: string; label: string; disabled?: boolean; minHeight?: number; onChange?: () => void; className?: string }>(
  function RichEditor({ id, label, disabled, minHeight = 160, onChange, className }, ref) {
    const el = useRef<HTMLDivElement>(null)
    const [linkOpen, setLinkOpen] = useState(false)
    const [url, setUrl] = useState('')
    const [linkError, setLinkError] = useState<string | null>(null)
    const range = useRef<Range | null>(null)
    useImperativeHandle(ref, () => ({
      value: () => (el.current ? editorToMarkup(el.current as unknown as EditorNode) : { text: '', formatted: false }),
      setValue: (text, formatted) => { if (el.current) el.current.innerHTML = editorHtml(text, formatted) },
      focus: () => el.current?.focus(),
      isEmpty: () => !(el.current?.innerText ?? '').trim(),
    }), [])
    const exec = (cmd: string, arg?: string) => {
      el.current?.focus()
      document.execCommand(cmd, false, arg)
      onChange?.()
    }
    const openLink = () => {
      const sel = window.getSelection()
      range.current = sel && sel.rangeCount && el.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
      setUrl('https://'); setLinkError(null); setLinkOpen(true)
    }
    const applyLink = () => {
      const u = url.trim()
      if (!/^(https?:\/\/[^\s]+\.[^\s]+|mailto:[^\s@]+@[^\s@]+)$/i.test(u)) { setLinkError('Enter a web address (https://…) or mailto:name@example.com'); return }
      el.current?.focus()
      const sel = window.getSelection()
      if (range.current && sel) { sel.removeAllRanges(); sel.addRange(range.current) }
      if (sel && sel.isCollapsed) document.execCommand('insertText', false, u)
      if (sel && !sel.isCollapsed) document.execCommand('createLink', false, u)
      else {
        // Link the address just inserted.
        const r = document.createRange()
        const node = sel?.anchorNode
        if (node && node.nodeType === 3 && (node.textContent ?? '').endsWith(u)) {
          r.setStart(node, (node.textContent ?? '').length - u.length); r.setEnd(node, (node.textContent ?? '').length)
          sel!.removeAllRanges(); sel!.addRange(r); document.execCommand('createLink', false, u); sel!.collapseToEnd()
        }
      }
      setLinkOpen(false)
      onChange?.()
    }
    return (
      <div className={cn('flex min-h-0 flex-col', className)}>
        <div
          ref={el} id={id} role="textbox" aria-multiline="true" aria-label={label} contentEditable={!disabled} suppressContentEditableWarning data-testid="email-editor"
          onInput={() => onChange?.()}
          onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); onChange?.() }}
          onKeyDown={(e) => {
            if (!(e.ctrlKey || e.metaKey)) return
            const k = e.key.toLowerCase()
            if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); exec(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline') }
            if (k === 'k') { e.preventDefault(); openLink() }
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-6 text-[#1F1F1F] outline-none [&_a]:text-[#0B57D0] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
          style={{ minHeight }} />
        {linkOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[#E0E3E7] bg-[#F8FAFD] px-3 py-2 text-sm" role="group" aria-label="Insert link">
            <input autoFocus aria-label="Link address" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') setLinkOpen(false) }}
              className="min-w-0 flex-1 rounded border border-[#C4C7C5] px-2 py-1 outline-none focus:border-[#0B57D0]" />
            <button type="button" onClick={applyLink} className="rounded-full bg-[#0B57D0] px-3 py-1 font-medium text-white">Apply</button>
            <button type="button" onClick={() => setLinkOpen(false)} className="rounded-full px-3 py-1 text-[#0B57D0] hover:bg-[#E8F0FE]">Cancel</button>
            {linkError && <p role="alert" className="w-full text-xs text-red-700">{linkError}</p>}
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-t border-[#E0E3E7] px-2 py-1" role="toolbar" aria-label="Formatting">
          <ToolButton label="Bold (Ctrl+B)" onClick={() => exec('bold')}><Bold /></ToolButton>
          <ToolButton label="Italic (Ctrl+I)" onClick={() => exec('italic')}><Italic /></ToolButton>
          <ToolButton label="Underline (Ctrl+U)" onClick={() => exec('underline')}><Underline /></ToolButton>
          <ToolButton label="Insert link (Ctrl+K)" onClick={openLink}><Link2 /></ToolButton>
          <ToolButton label="Bulleted list" onClick={() => exec('insertUnorderedList')}><List /></ToolButton>
          <ToolButton label="Numbered list" onClick={() => exec('insertOrderedList')}><ListOrdered /></ToolButton>
          <ToolButton label="Remove formatting" onClick={() => { exec('removeFormat'); exec('unlink') }}><RemoveFormatting /></ToolButton>
        </div>
      </div>
    )
  },
)
