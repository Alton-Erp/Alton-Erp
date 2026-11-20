import type { TimelineItem } from '@/services/support'
import type { WaInboxView, WaMessage, WaStatus } from '@/services/whatsapp'

/**
 * WhatsApp Web-style screen: pure rules (ticks, date separators, chat items, composer keys). No React, no I/O,
 * so every rule is unit-tested (tests/unit/whatsapp-web.test.ts).
 */

// ---- Delivery ticks ------------------------------------------------------------------------
/**
 * The tick shown on an outgoing message comes ONLY from the stored status, which only Meta's status webhooks move
 * past PENDING (private.support_whatsapp_apply_status). Inserting a message, or Meta accepting the API request,
 * never shows a tick: accepted messages stay on the clock until Meta reports "sent".
 */
export type WaTick = 'NONE' | 'CLOCK' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
export function waTick(m: { direction: 'INBOUND' | 'OUTBOUND'; status: WaStatus | string }): WaTick {
  if (m.direction !== 'OUTBOUND') return 'NONE'
  switch (m.status) {
    case 'SENT': return 'SENT'
    case 'DELIVERED': return 'DELIVERED'
    case 'READ': return 'READ'
    case 'FAILED': return 'FAILED'
    default: return 'CLOCK'
  }
}
export function waTickLabel(m: { direction: 'INBOUND' | 'OUTBOUND'; status: WaStatus | string; wa_message_id?: string | null; error_title?: string | null }): string {
  switch (waTick(m)) {
    case 'NONE': return 'Received'
    case 'SENT': return 'Sent (Meta reported it as sent)'
    case 'DELIVERED': return 'Delivered to the customer’s phone (Meta delivery receipt)'
    case 'READ': return 'Read by the customer (Meta read receipt)'
    case 'FAILED': return 'Not delivered (Meta reported a failure)'
    default:
      if (m.error_title === 'Not confirmed') return 'Meta did not confirm this request'
      return m.wa_message_id ? 'Accepted by Meta, waiting for the “sent” status' : 'Sending'
  }
}

/** Retry only what Meta reported as failed (never a message that may still arrive), text only, inside the window. */
export function canRetry(m: Pick<WaMessage, 'direction' | 'status' | 'type'>, ctx: { windowOpen: boolean; canSend: boolean; retried: boolean }): boolean {
  return m.direction === 'OUTBOUND' && m.status === 'FAILED' && m.type === 'text' && ctx.windowOpen && ctx.canSend && !ctx.retried
}

// ---- Dates ---------------------------------------------------------------------------------
const LOCALE = 'en-IN'
function parts(d: Date, timeZone?: string) {
  const fmt = (tz?: string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(d)
  try { return fmt(timeZone) } catch { return fmt() }
}
/** Calendar day (YYYY-MM-DD) in the company's timezone. */
export const dayKey = (iso: string | Date, timeZone?: string) => parts(typeof iso === 'string' ? new Date(iso) : iso, timeZone)
function dayDiff(a: string, b: string) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000)
}
/** Date separator: TODAY, YESTERDAY, else 19 NOVEMBER 2026. */
export function dayLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  const k = dayKey(iso, timeZone)
  const diff = dayDiff(dayKey(now, timeZone), k)
  if (diff === 0) return 'TODAY'
  if (diff === 1) return 'YESTERDAY'
  const [y, m, d] = k.split('-').map(Number)
  const month = new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
  return `${d} ${month} ${y}`.toUpperCase()
}
function time(iso: string, timeZone?: string) {
  const f = (tz?: string) => new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(new Date(iso))
  let s: string
  try { s = f(timeZone) } catch { s = f() }
  return s.replace(/\s?(AM|PM)$/i, (x) => x.toLowerCase())
}
/** Time inside a bubble (10:42 am). */
export const bubbleTime = time
/** Time in the conversation list: today → time, yesterday → Yesterday, this week → weekday, else dd/mm/yyyy. */
export function listTime(iso: string, now: Date = new Date(), timeZone?: string): string {
  const k = dayKey(iso, timeZone)
  const diff = dayDiff(dayKey(now, timeZone), k)
  if (diff <= 0) return time(iso, timeZone)
  if (diff === 1) return 'Yesterday'
  const [y, m, d] = k.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  if (diff < 7) return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', timeZone: 'UTC' }).format(utc)
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

// ---- Avatars and names ---------------------------------------------------------------------
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '#'
  if (/^\d+$/.test(words.join(''))) return '#'
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase()
}
const AVATAR_COLORS = ['#25D366', '#0B8F76', '#00A884', '#53BDEB', '#7F66FF', '#FF7EAE', '#FA6533', '#C4A000', '#3F51B5', '#8D6E63']
export function avatarColor(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
/** +91 98765 43210 style for Indian numbers, otherwise + and the digits. */
export function formatWaNumber(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  return `+${d}`
}

// ---- Message content -----------------------------------------------------------------------
/** Inbound reactions are stored as their own message ("[Reaction] 👍"); Meta's target id is not stored, so they are shown on their own. */
export function reactionEmoji(m: Pick<WaMessage, 'type' | 'body'>): string | null {
  if (m.type !== 'reaction') return null
  return m.body.replace(/^\[Reaction\]\s*/, '').trim()
}
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | null
export function mediaKind(m: Pick<WaMessage, 'type' | 'media_mime'> & { attachment?: { content_type: string | null } | null }): MediaKind {
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)) return m.type as MediaKind
  const mime = m.attachment?.content_type ?? m.media_mime ?? ''
  if (!mime) return m.attachment ? 'document' : null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}
/** Placeholder bodies the webhook stores for media ("[Image]", "[Document] name") are not shown as text under the media. */
export function visibleBody(m: Pick<WaMessage, 'type' | 'body' | 'media_filename'>): string {
  const b = m.body ?? ''
  if (/^\[(Image|Video|Audio message|Sticker|Empty message)\]$/.test(b)) return ''
  if (m.type === 'document') return b.replace(/^\[Document\]\s*/, '').replace(m.media_filename ?? '\u0000', '').replace(/^\s*—\s*/, '').trim()
  if (m.type === 'location') return ''
  return b
}
export function isUnsupported(m: Pick<WaMessage, 'type' | 'body'>): boolean {
  return m.type === 'unsupported' || m.type === 'unknown' || /^\[Unsupported message type/.test(m.body ?? '')
}
/** Text copied for a set of messages (Copy / select several): "[time] name: text" per message, like WhatsApp. */
export function copyText(msgs: Pick<WaMessage, 'at' | 'body' | 'direction' | 'author'>[], customer: string, timeZone?: string): string {
  if (msgs.length === 1) return msgs[0].body
  return msgs.map((m) => `[${bubbleTime(m.at, timeZone)}] ${m.direction === 'INBOUND' ? customer : m.author ?? 'Agent'}: ${m.body}`).join('\n')
}

// ---- Chat items ----------------------------------------------------------------------------
export type ChatItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; at: string; m: WaMessage }
  | { kind: 'logged'; key: string; at: string; item: TimelineItem }
  | { kind: 'event'; key: string; at: string; item: TimelineItem }

/**
 * WhatsApp messages, plus what the ERP knows that is not a WhatsApp message: manually logged messages and ticket /
 * assignment events (shown as system lines). Internal notes are NOT chat items (they live in the side panel and are
 * never sent). Stable order: time, then WhatsApp before ERP entries at the same instant, then id.
 */
export function buildChatItems(messages: WaMessage[], timeline: TimelineItem[], now: Date = new Date(), timeZone?: string): ChatItem[] {
  const covered = new Set(messages.flatMap((m) => [m.message_id, ...(m.attachment ? [m.attachment.id] : [])]))
  const rows: Exclude<ChatItem, { kind: 'day' }>[] = [
    ...messages.map((m) => ({ kind: 'message' as const, key: `m-${m.id}`, at: m.at, m })),
    ...timeline.filter((t) => !covered.has(t.id) && (t.type === 'event' || t.type === 'message'))
      .map((t) => (t.type === 'event' ? { kind: 'event' as const, key: `e-${t.id}`, at: t.at, item: t } : { kind: 'logged' as const, key: `l-${t.id}`, at: t.at, item: t })),
  ]
  const rank = (k: string) => (k === 'message' ? 0 : 1)
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || rank(a.kind) - rank(b.kind) || a.key.localeCompare(b.key))
  const out: ChatItem[] = []
  let day = ''
  for (const r of rows) {
    const k = dayKey(r.at, timeZone)
    if (k !== day) { day = k; out.push({ kind: 'day', key: `d-${k}`, label: dayLabel(r.at, now, timeZone) }) }
    out.push(r)
  }
  return out
}

/** Messages matching a search inside the conversation (case- and accent-insensitive). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
export function searchMessages(messages: Pick<WaMessage, 'id' | 'body'>[], term: string): string[] {
  const t = fold(term.trim())
  if (!t) return []
  return messages.filter((m) => fold(m.body ?? '').includes(t)).map((m) => m.id)
}
/** Splits text into plain / highlighted parts for a search term. */
export function highlight(text: string, term: string): { text: string; hit: boolean }[] {
  const t = term.trim()
  if (!t) return [{ text, hit: false }]
  const folded = fold(text)
  const ft = fold(t)
  // Folding can change lengths for some scripts; then the text is shown without highlighting.
  if (folded.length !== text.length) return [{ text, hit: folded.includes(ft) }]
  const out: { text: string; hit: boolean }[] = []
  let i = 0
  for (let j = folded.indexOf(ft); j !== -1; j = folded.indexOf(ft, i)) {
    if (j > i) out.push({ text: text.slice(i, j), hit: false })
    out.push({ text: text.slice(j, j + ft.length), hit: true })
    i = j + ft.length
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

// ---- Composer ------------------------------------------------------------------------------
export const WA_TEXT_LIMIT = 4096
export const WA_CAPTION_LIMIT = 1024
/** Enter sends, Shift+Enter is a new line; nothing happens while an IME is composing. */
export function composerKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; ctrlKey?: boolean; metaKey?: boolean }): 'send' | null {
  if (e.key !== 'Enter' || e.isComposing) return null
  return e.shiftKey ? null : 'send'
}
/** Inserts text (an emoji) at the caret / over the selection; returns the new text and caret position. */
export function insertAt(text: string, start: number | null, end: number | null, insert: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start ?? text.length, text.length))
  const e = Math.max(s, Math.min(end ?? s, text.length))
  return { text: text.slice(0, s) + insert + text.slice(e), caret: s + insert.length }
}
/** What stops a send, or null. Counted in UTF-16 code units, as the existing 4,096-character limit is. */
export function composerProblem(text: string, hasFile: boolean): string | null {
  if (!hasFile && !text.trim()) return 'Enter the message.'
  if (hasFile && text.length > WA_CAPTION_LIMIT) return `A caption can have at most ${WA_CAPTION_LIMIT.toLocaleString('en-IN')} characters.`
  if (!hasFile && text.length > WA_TEXT_LIMIT) return 'At most 4,096 characters.'
  return null
}

// ---- Recently used emoji (per browser; a convenience only) ----------------------------------
const RECENT_KEY = 'alton-erp:wa-recent-emoji'
export function recentEmoji(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}
export function pushRecentEmoji(list: string[], emoji: string): string[] {
  const next = [emoji, ...list.filter((x) => x !== emoji)].slice(0, 24)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* storage unavailable: kept for this session only */ }
  return next
}

// ---- Conversation list filters --------------------------------------------------------------
export const WA_FILTERS: { value: WaInboxView | 'GROUPS'; label: string }[] = [
  { value: 'ALL', label: 'All' }, { value: 'UNREAD', label: 'Unread' }, { value: 'FAVORITES', label: 'Favourites' }, { value: 'GROUPS', label: 'Groups' }, { value: 'MINE', label: 'Assigned to me' },
]
/** The unified inbox's other filters stay available. */
export const WA_MORE_FILTERS: { value: WaInboxView; label: string }[] = [
  { value: 'UNASSIGNED', label: 'Unassigned' }, { value: 'OPEN', label: 'Open' }, { value: 'PENDING', label: 'Pending' }, { value: 'RESOLVED', label: 'Resolved' },
]
