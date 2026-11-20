import type { ThreadEmail } from '@/services/email'

import { markdownToHtml } from '../../../../supabase/functions/_shared/google/markdown.ts'

/**
 * Email workspace: pure rules (folders, search syntax, list dates, editor markup, quoting). No React and no I/O,
 * so they are unit-tested (tests/unit/email-workspace.test.ts).
 */

// ---- Folders -------------------------------------------------------------------------------
export type MailFolder = 'INBOX' | 'STARRED' | 'SNOOZED' | 'SENT' | 'DRAFTS' | 'IMPORTANT' | 'ALL' | 'SPAM' | 'TRASH' | 'LABEL'
export const MAIL_FOLDERS: { key: Exclude<MailFolder, 'LABEL'>; label: string; count: 'unread' | 'total' | null }[] = [
  { key: 'INBOX', label: 'Inbox', count: 'unread' },
  { key: 'STARRED', label: 'Starred', count: null },
  { key: 'SNOOZED', label: 'Snoozed', count: 'total' },
  { key: 'SENT', label: 'Sent', count: null },
  { key: 'DRAFTS', label: 'Drafts', count: 'total' },
  { key: 'IMPORTANT', label: 'Important', count: 'unread' },
  { key: 'ALL', label: 'All mail', count: null },
  { key: 'SPAM', label: 'Spam', count: 'unread' },
  { key: 'TRASH', label: 'Trash', count: null },
]
export const isMailFolder = (v: string): v is MailFolder => v === 'LABEL' || MAIL_FOLDERS.some((f) => f.key === v)

// ---- Search ----------------------------------------------------------------------------------
export interface MailSearch {
  q?: string; from?: string; to?: string; subject?: string; words?: string; after?: string; before?: string
  has_attachment?: boolean; unread?: boolean
}
const OPS = ['from', 'to', 'subject', 'after', 'before', 'has', 'is'] as const
/** Turns "from:ravi has:attachment is:unread after:2026/11/01 basin" into filters (Gmail-style operators). */
export function parseMailSearch(input: string): MailSearch {
  const out: MailSearch = {}
  const free: string[] = []
  const tokens = input.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? []
  for (const tok of tokens) {
    const m = /^(\w+):(.*)$/.exec(tok)
    const op = m?.[1].toLowerCase()
    if (!m || !OPS.includes(op as (typeof OPS)[number])) { free.push(tok.replace(/^"|"$/g, '')); continue }
    const v = m[2].replace(/^"|"$/g, '')
    if (op === 'has' && v.toLowerCase() === 'attachment') out.has_attachment = true
    else if (op === 'is' && v.toLowerCase() === 'unread') out.unread = true
    else if (op === 'is' && v.toLowerCase() === 'read') out.unread = false
    else if ((op === 'after' || op === 'before') && toIsoDate(v)) out[op] = toIsoDate(v)!
    else if (op === 'from' || op === 'to' || op === 'subject') out[op] = v
    else free.push(tok)
  }
  const q = free.join(' ').trim()
  if (q) out.q = q
  return out
}
/** The same filters back as search text (for the advanced-search panel). */
export function formatMailSearch(s: MailSearch): string {
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v)
  return [
    s.from && `from:${quote(s.from)}`, s.to && `to:${quote(s.to)}`, s.subject && `subject:${quote(s.subject)}`,
    s.has_attachment && 'has:attachment', s.unread === true && 'is:unread', s.unread === false && 'is:read',
    s.after && `after:${s.after}`, s.before && `before:${s.before}`, s.words, s.q,
  ].filter(Boolean).join(' ')
}
/** 2026/11/01, 2026-11-01 or 01/11/2026 (day first, as in India) → 2026-11-01. */
export function toIsoDate(v: string): string | null {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v.trim())
  let y: number, mo: number, d: number
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3] } else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v.trim())
    if (!m) return null
    d = +m[1]; mo = +m[2]; y = +m[3]
  }
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
export const hasFilters = (s: MailSearch) => Object.values(s).some((v) => v !== undefined && v !== '')

// ---- List dates (Gmail-style) ----------------------------------------------------------------
function ymd(d: Date, timeZone?: string) {
  const f = (tz?: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(d)
  try { return f(timeZone) } catch { return f() }
}
/** Today → 10:42 am; this year → 12 Nov; earlier → 12/11/2025. */
export function mailListDate(iso: string, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(iso)
  const [k, n] = [ymd(d, timeZone), ymd(now, timeZone)]
  const fmt = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat('en-IN', { ...o, timeZone }).format(d) } catch { return new Intl.DateTimeFormat('en-IN', o).format(d) } }
  if (k === n) return fmt({ hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?(AM|PM)$/i, (x) => x.toLowerCase())
  if (k.slice(0, 4) === n.slice(0, 4)) return fmt({ day: 'numeric', month: 'short' })
  return fmt({ day: '2-digit', month: '2-digit', year: 'numeric' })
}
/** Page label: "1–50 of 312". */
export function pageLabel(offset: number, shown: number, total: number): string {
  if (!total) return '0 of 0'
  return `${(offset + 1).toLocaleString('en-IN')}–${(offset + shown).toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}`
}

// ---- Snooze --------------------------------------------------------------------------------
/** Gmail-like choices: later today (+3 h), tomorrow 8 am, this weekend (Sat 8 am), next week (Mon 8 am) — local time. */
export function snoozeChoices(now: Date = new Date()): { key: string; label: string; at: Date }[] {
  const at8 = (addDays: number) => { const d = new Date(now); d.setDate(d.getDate() + addDays); d.setHours(8, 0, 0, 0); return d }
  const dow = now.getDay()
  const later = new Date(now.getTime() + 3 * 3600000)
  later.setMinutes(0, 0, 0)
  return [
    { key: 'later', label: 'Later today', at: later },
    { key: 'tomorrow', label: 'Tomorrow', at: at8(1) },
    { key: 'weekend', label: 'This weekend', at: at8(((6 - dow + 7) % 7) || 7) },
    { key: 'week', label: 'Next week', at: at8(((8 - dow) % 7) || 7) },
  ]
}

// ---- Rich-text editor → markup ------------------------------------------------------------------
/**
 * The editor (contentEditable) is converted to a small markup the server turns into HTML
 * (supabase/functions/_shared/google/markdown.ts): **bold**, *italic*, ++underline++, [text](url), "- " / "1. " lists.
 * The browser never sends HTML. Works on any DOM-like node, so it is unit-tested without a browser.
 */
export interface EditorNode {
  nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<EditorNode>
  getAttribute?: (name: string) => string | null
  style?: { fontWeight?: string; fontStyle?: string; textDecoration?: string; textDecorationLine?: string }
}
/** Escapes characters that would be read as markup. Only ever applied to formatted emails. */
export function escapeMarkup(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/\+\+/g, '\\+\\+').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}
const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE'])
export function editorToMarkup(root: EditorNode): { text: string; formatted: boolean } {
  let formatted = false
  const inline = (n: EditorNode): string => {
    if (n.nodeType === 3) return escapeMarkup(n.textContent ?? '')
    if (n.nodeType !== 1) return ''
    const name = n.nodeName.toUpperCase()
    if (name === 'BR') return '\n'
    const inner = Array.from(n.childNodes).map(inline).join('')
    const wrap = (m: string) => { if (!inner.trim()) return inner; formatted = true; return `${m}${inner}${m}` }
    const deco = `${n.style?.textDecoration ?? ''} ${n.style?.textDecorationLine ?? ''}`
    if (name === 'B' || name === 'STRONG' || /^(bold|[6-9]00)$/.test(n.style?.fontWeight ?? '')) return wrap('**')
    if (name === 'I' || name === 'EM' || n.style?.fontStyle === 'italic') return wrap('*')
    if (name === 'U' || /underline/.test(deco)) return wrap('++')
    if (name === 'A') {
      const href = n.getAttribute?.('href') ?? ''
      if (/^(https?:\/\/|mailto:)\S+$/i.test(href)) { formatted = true; return `[${inner || escapeMarkup(href)}](${href.replace(/[()\s]/g, encodeURIComponent)})` }
      return inner
    }
    return inner
  }
  const lines: { text: string; list: boolean }[] = []
  let current = ''
  const flush = (list = false) => { lines.push({ text: current, list }); current = '' }
  const walk = (n: EditorNode, list: { type: 'UL' | 'OL'; i: number } | null) => {
    const name = n.nodeType === 1 ? n.nodeName.toUpperCase() : ''
    if (name === 'UL' || name === 'OL') {
      if (current) flush()
      const l = { type: name as 'UL' | 'OL', i: 0 }
      for (const c of Array.from(n.childNodes)) walk(c, l)
      return
    }
    if (name === 'LI' && list) {
      if (current) flush()
      formatted = true
      list.i += 1
      current = `${list.type === 'UL' ? '- ' : `${list.i}. `}${Array.from(n.childNodes).map(inline).join('').replace(/\n+/g, ' ').trim()}`
      flush(true)
      return
    }
    if (BLOCK.has(name)) {
      if (current) flush()
      const kids = Array.from(n.childNodes)
      if (kids.some((c) => c.nodeType === 1 && BLOCK.has(c.nodeName.toUpperCase()))) { for (const c of kids) walk(c, list); if (current) flush() }
      else { current = kids.map(inline).join(''); if (current.endsWith('\n')) current = current.slice(0, -1); flush() }
      return
    }
    current += inline(n)
  }
  for (const c of Array.from(root.childNodes)) walk(c, null)
  if (current) flush()
  const tidy = (t: string) => t.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  // Not formatted: the plain text exactly as typed (no escapes), sent as before.
  if (!formatted) return { text: tidy(unescapeMarkup(lines.map((l) => l.text).join('\n'))), formatted }
  // Formatted: only <li> items are list lines; text typed as "- x", "• x" or "1. x" stays literal.
  const literal = (t: string, list: boolean) => (!list && /^([-•]\s|\d{1,3}\.\s)/.test(t) ? `\\${t}` : t)
  return { text: tidy(lines.map((l) => l.text.split('\n').map((t, i) => literal(t, l.list && i === 0)).join('\n')).join('\n')), formatted }
}
export function unescapeMarkup(s: string): string { return s.replace(/\\([\\*[\]+])/g, '$1') }

// ---- Reply / forward ------------------------------------------------------------------------------
const who = (e: Pick<ThreadEmail, 'from_name' | 'from_address'>) => (e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address ?? 'unknown sender')
/** "On 12 Nov 2026, 10:42 am, Ravi <ravi@x> wrote:" plus the text quoted with "> ". */
export function quoteForReply(e: ThreadEmail, when: string): string {
  return `\n\nOn ${when}, ${who(e)} wrote:\n${(e.body_text ?? '').split('\n').map((l) => `> ${l}`).join('\n')}`
}
export function forwardBlock(e: ThreadEmail, when: string): string {
  const list = (a: { email: string; name: string | null }[]) => a.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ')
  return ['', '', '---------- Forwarded message ---------', `From: ${who(e)}`, `Date: ${when}`, `Subject: ${e.subject ?? ''}`, `To: ${list(e.to)}`,
    ...(e.cc.length ? [`Cc: ${list(e.cc)}`] : []), '', e.body_text ?? ''].join('\n')
}
export function forwardSubject(s: string | null): string {
  const t = (s ?? '').trim()
  return /^(fwd?|fw):/i.test(t) ? t : `Fwd: ${t}`
}
/** Which messages start expanded in a thread: the last one and any unread one (Gmail behaviour). */
export function initiallyExpanded(emails: Pick<ThreadEmail, 'id' | 'unread'>[]): Set<string> {
  return new Set(emails.filter((e, i) => e.unread || i === emails.length - 1).map((e) => e.id))
}
/** Print view: everything escaped (never the email's own HTML). */
export function printHtml(subject: string, emails: { from: string; to: string; date: string; body: string }[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title><style>body{font:14px/1.5 Arial,sans-serif;margin:32px;color:#202124}`
    + `h1{font-size:20px;font-weight:400}article{border-top:1px solid #dadce0;padding:12px 0}.m{color:#5f6368;font-size:12px}pre{white-space:pre-wrap;font:inherit}</style></head><body>`
    + `<h1>${esc(subject)}</h1>${emails.map((e) => `<article><div><b>${esc(e.from)}</b></div><div class="m">To: ${esc(e.to)} · ${esc(e.date)}</div><pre>${esc(e.body)}</pre></article>`).join('')}</body></html>`
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Editor content for saved text: markup through the same escaping converter as the server; plain text escaped. */
export function editorHtml(text: string, formatted: boolean): string {
  return formatted ? markdownToHtml(text) : text.split('\n').map((l) => `<div>${escapeHtml(l) || '<br>'}</div>`).join('')
}
