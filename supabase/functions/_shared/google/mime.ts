// Email parsing (Gmail API messages in format=full) and building (RFC 5322 / MIME for users.messages.send).
// Gmail returns each part's body already transfer-decoded and base64url-encoded; the charset still applies.

import type { GmailMessage, GmailPart } from './gmail.ts'
import { b64urlToBytes, bytesToB64, bytesToB64url } from './google.ts'
import { htmlToText, sanitizeHtml } from './sanitize.ts'

export interface Address { email: string; name: string | null }

// ---- decoding -------------------------------------------------------------------
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder((charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function qDecode(s: string): Uint8Array {
  const out: number[] = []
  const t = s.replace(/_/g, ' ')
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2 }
    else out.push(t.charCodeAt(i) & 0xff)
  }
  return new Uint8Array(out)
}

/** RFC 2047 encoded words (=?charset?B|Q?...?=); whitespace between adjacent encoded words is removed. */
export function decodeEncodedWords(s: string): string {
  return s.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? b64urlToBytes(data.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) : qDecode(data)
        return decodeText(bytes, cs.split('*')[0])
      } catch {
        return _m
      }
    })
}

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/

/** Address list header → addresses (quoted names, angle brackets, comments, groups). Invalid entries are skipped. */
export function parseAddressList(header: string | null): Address[] {
  if (!header) return []
  const items: string[] = []
  let cur = ''
  let quoted = false
  let angle = 0
  let paren = 0
  for (const ch of header.replace(/\r?\n[ \t]/g, ' ')) {
    if (ch === '"' && paren === 0) quoted = !quoted
    else if (!quoted && ch === '<') angle++
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1)
    else if (!quoted && ch === '(') paren++
    else if (!quoted && ch === ')') paren = Math.max(0, paren - 1)
    if ((ch === ',' || ch === ';') && !quoted && angle === 0 && paren === 0) { items.push(cur); cur = ''; continue }
    cur += ch
  }
  items.push(cur)
  const out: Address[] = []
  for (let raw of items) {
    raw = raw.replace(/^[^"<]*:/, '').trim() // group name "Team:" prefix
    if (!raw) continue
    const angleMatch = /<([^<>]+)>/.exec(raw)
    let email: string
    let name: string | null = null
    if (angleMatch) {
      email = angleMatch[1].trim()
      name = raw.slice(0, angleMatch.index).trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim() || null
    } else {
      const comment = /\(([^)]*)\)/.exec(raw)
      email = raw.replace(/\([^)]*\)/g, '').trim()
      name = comment ? comment[1].trim() || null : null
    }
    email = email.toLowerCase()
    if (!EMAIL.test(email)) continue
    out.push({ email, name: name ? decodeEncodedWords(name).slice(0, 200) : null })
  }
  return out
}

const headerOf = (part: GmailPart | undefined, name: string): string | null =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null

function pctDecode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 }
    else out.push(s.charCodeAt(i) & 0xff)
  }
  return new Uint8Array(out)
}

/** A header parameter (RFC 2231 name*=charset''value first, then name="value"). */
export function param(header: string | null, name: string): string | null {
  if (!header) return null
  const ext = new RegExp(`(?:^|[;\\s])${name}\\*=([^']*)'[^']*'([^;\\s]+)`, 'i').exec(header)
  if (ext) return decodeText(pctDecode(ext[2].replace(/^"|"$/g, '')), ext[1] || 'utf-8')
  const m = new RegExp(`(?:^|[;\\s])${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header)
  return m ? decodeEncodedWords(m[1] ?? m[2]) : null
}

// ---- parsing ----------------------------------------------------------------------
/** Extensions never stored from received mail (executables and scripts). */
export const BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'cpl',
  'lnk', 'reg', 'dll', 'sys', 'app', 'dmg', 'pkg', 'sh', 'apk', 'iso', 'img', 'vhd', 'vhdx', 'gadget', 'scf', 'url', 'inf', 'chm']

export interface AttachmentPart {
  part_id: string; attachment_id: string | null; filename: string; mime_type: string; size: number; content_id: string | null; inline: boolean
  state?: 'BLOCKED' | 'TOO_LARGE'; reason?: string
}
export interface ParsedEmail {
  gmail_message_id: string; gmail_thread_id: string | null; label_ids: string[]
  rfc_message_id: string | null; in_reply_to: string | null; references: string | null
  from: Address | null; to: Address[]; cc: Address[]; bcc: Address[]; reply_to: string | null
  subject: string | null; body_text: string | null; body_html: string | null; html_truncated: boolean
  internal_date: string | null; size_estimate: number | null
  mime: { parts: { part_id: string; mime_type: string; filename?: string; size: number }[]; truncated: boolean }
  attachments: AttachmentPart[]
}

export const MAX_TEXT = 500000
export const MAX_HTML = 1000000

/** File name extension for a part that has no file name, from its content type (fallback names like "image.png"). */
const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tif', 'image/heic': 'heic',
  'image/heif': 'heif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif',
  'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
  'application/x-tar': 'tar', 'application/gzip': 'gz', 'application/x-gzip': 'gz',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
  'text/csv': 'csv', 'text/calendar': 'ics', 'text/vcard': 'vcf', 'text/x-vcard': 'vcf', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'message/rfc822': 'eml', 'application/vnd.ms-outlook': 'msg',
}
/** A safe name for a part without one: "image.png", "invite.ics", "message.eml", "attachment.bin". */
export function fallbackFileName(type: string): string {
  if (type === 'message/rfc822') return 'message.eml'
  if (type === 'text/calendar') return 'invite.ics'
  const ext = EXT_FOR_TYPE[type] ?? (/^[a-z]+\/([a-z0-9]{1,8})$/.exec(type)?.[1] ?? 'bin')
  return `${type.startsWith('image/') ? 'image' : 'attachment'}.${ext}`
}
/** Text parts that are another rendering of the body (never files): Gmail AMP, enriched text, Apple Watch HTML. */
const BODY_ALTERNATIVES = new Set(['text/plain', 'text/html', 'text/x-amp-html', 'text/enriched', 'text/richtext', 'text/watch-html'])

export function parseGmailMessage(msg: GmailMessage, maxAttachmentBytes: number): { email: ParsedEmail; inlineData: Map<string, string> } {
  const top = msg.payload
  let text: string | null = null
  let html: string | null = null
  const attachments: AttachmentPart[] = []
  const inlineData = new Map<string, string>()
  const parts: ParsedEmail['mime']['parts'] = []
  let count = 0
  const walk = (p: GmailPart, depth: number) => {
    if (depth > 20 || count++ > 300) return
    const type = (p.mimeType ?? 'application/octet-stream').toLowerCase()
    const ctype = headerOf(p, 'Content-Type')
    const disp = headerOf(p, 'Content-Disposition')
    const filename = (p.filename || param(disp, 'filename') || param(ctype, 'name') || '').trim()
    const partId = p.partId ?? String(count)
    if (parts.length < 100) parts.push({ part_id: partId, mime_type: type.slice(0, 120), ...(filename ? { filename: filename.slice(0, 255) } : {}), size: p.body?.size ?? 0 })
    if (type.startsWith('multipart/')) { for (const c of p.parts ?? []) walk(c, depth + 1); return }
    const contentId = headerOf(p, 'Content-ID')?.replace(/^<|>$/g, '').trim().slice(0, 250) || null
    // Any leaf part that is not the text body is a file, whatever its type: named parts, "attachment" parts,
    // forwarded messages, and nameless ones (embedded images with a Content-ID, calendar invites, unknown types).
    const hasContent = Boolean(p.body?.attachmentId || p.body?.data)
    const isBodyText = BODY_ALTERNATIVES.has(type) && !filename && !/^\s*attachment/i.test(disp ?? '')
    const isAttachment = !isBodyText && (Boolean(filename) || /^\s*attachment/i.test(disp ?? '') || type === 'message/rfc822' || hasContent)
    if (isBodyText && (type === 'text/plain' || type === 'text/html') && p.body?.data) {
      const decoded = decodeText(b64urlToBytes(p.body.data), param(ctype, 'charset'))
      if (type === 'text/plain' && text === null) text = decoded
      if (type === 'text/html' && html === null) html = decoded
      return
    }
    if (!isAttachment) return
    const name = (filename || fallbackFileName(type)).replace(/[\r\n]/g, ' ').replaceAll(String.fromCharCode(0), '').replace(/[\\/]/g, '_').slice(0, 255)
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? ''
    const size = p.body?.size ?? 0
    // "Inline" = an image embedded in the body (it has a Content-ID). Documents some mail apps mark inline (Apple Mail)
    // are ordinary attachments, so they are listed with the others.
    const a: AttachmentPart = { part_id: partId, attachment_id: p.body?.attachmentId ?? null, filename: name, mime_type: type.slice(0, 120), size,
      content_id: contentId, inline: type.startsWith('image/') && Boolean(contentId) && !/^\s*attachment/i.test(disp ?? '') }
    if (BLOCKED_EXTENSIONS.includes(ext)) Object.assign(a, { state: 'BLOCKED', reason: `.${ext} files are not stored (executable or script).` })
    else if (size > maxAttachmentBytes) Object.assign(a, { state: 'TOO_LARGE', reason: `Larger than the ${Math.round(maxAttachmentBytes / 1048576)} MB limit.` })
    else if (!a.attachment_id && !p.body?.data) Object.assign(a, { state: 'TOO_LARGE', reason: 'No content.' })
    if (!a.attachment_id && p.body?.data) inlineData.set(partId, p.body.data)
    attachments.push(a)
  }
  if (top) walk(top, 0)
  const from = parseAddressList(headerOf(top, 'From'))[0] ?? null
  const subject = headerOf(top, 'Subject')
  let bodyHtml: string | null = null
  let truncated = false
  if (html !== null) {
    const clean = sanitizeHtml(html as string)
    if (clean.length > MAX_HTML) truncated = true
    else bodyHtml = clean
  }
  const bodyText = text ?? (html !== null ? htmlToText(html as string) : null)
  return {
    inlineData,
    email: {
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId ?? null,
      label_ids: msg.labelIds ?? [],
      rfc_message_id: headerOf(top, 'Message-ID')?.trim().slice(0, 998) ?? null,
      in_reply_to: headerOf(top, 'In-Reply-To')?.trim().slice(0, 998) ?? null,
      references: headerOf(top, 'References')?.replace(/\s+/g, ' ').trim().slice(-8000) ?? null,
      from,
      to: parseAddressList(headerOf(top, 'To')),
      cc: parseAddressList(headerOf(top, 'Cc')),
      bcc: parseAddressList(headerOf(top, 'Bcc')),
      reply_to: parseAddressList(headerOf(top, 'Reply-To'))[0]?.email ?? null,
      subject: subject === null ? null : decodeEncodedWords(subject).replace(/\s+/g, ' ').trim().slice(0, 998),
      body_text: bodyText === null ? null : bodyText.slice(0, MAX_TEXT),
      body_html: bodyHtml,
      html_truncated: truncated,
      internal_date: msg.internalDate && /^[0-9]{10,16}$/.test(msg.internalDate) ? msg.internalDate : null,
      size_estimate: typeof msg.sizeEstimate === 'number' ? msg.sizeEstimate : null,
      mime: { parts, truncated: count > parts.length },
      attachments,
    },
  }
}

// ---- building -------------------------------------------------------------------
// eslint-disable-next-line no-control-regex -- CR, LF and NUL are removed from header values (header injection)
const clean = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ').trim()
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s)

/** RFC 2047 B-encoding in words of at most 45 UTF-8 bytes (never splitting a character). */
export function encodeWord(s: string): string {
  const v = clean(s)
  if (ascii(v)) return v
  const enc = new TextEncoder()
  const words: string[] = []
  let cur = ''
  for (const ch of v) {
    if (enc.encode(cur + ch).length > 45) { words.push(cur); cur = '' }
    cur += ch
  }
  if (cur) words.push(cur)
  return words.map((w) => `=?UTF-8?B?${bytesToB64(enc.encode(w))}?=`).join('\r\n ')
}

export function formatAddress(a: Address): string {
  const email = clean(a.email)
  if (!EMAIL.test(email)) throw new Error('Invalid email address.')
  if (!a.name) return email
  const name = clean(a.name)
  return ascii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>` : `${encodeWord(name)} <${email}>`
}

export function rfc2822Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, '$1\r\n')

function fileParams(name: string): { type: string; disp: string } {
  const n = clean(name).replace(/[\\/]/g, '_') || 'attachment'
  if (ascii(n)) {
    const q = n.replace(/(["\\])/g, '\\$1')
    return { type: `name="${q}"`, disp: `filename="${q}"` }
  }
  const pct = Array.from(new TextEncoder().encode(n), (b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('')
  return { type: `name="${encodeWord(n)}"`, disp: `filename*=UTF-8''${pct}` }
}

export interface OutgoingEmail {
  from: Address; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string
  messageId: string; inReplyTo: string | null; references: string | null; date: Date
  attachments: { fileName: string; contentType: string | null; bytes: Uint8Array }[]
  /** Formatted version (built by markdownToHtml, never taken from the browser): sent as multipart/alternative. */
  html?: string | null
}

export function buildMime(m: OutgoingEmail, boundary = `alton_${crypto.getRandomValues(new Uint32Array(2)).join('')}`): string {
  const msgId = /^<[^<>\s]+@[^<>\s]+>$/.test(m.messageId) ? m.messageId : null
  if (!msgId) throw new Error('Invalid Message-ID.')
  const idList = (v: string | null) => (v ?? '').split(/\s+/).filter((x) => /^<[^<>\s]+>$/.test(x)).join(' ')
  const h: string[] = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    // Gmail delivers to Bcc recipients and removes the header from the delivered copies.
    ...(m.bcc.length ? [`Bcc: ${m.bcc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc2822Date(m.date)}`,
    `Message-ID: ${msgId}`,
    ...(idList(m.inReplyTo) ? [`In-Reply-To: ${idList(m.inReplyTo).split(' ')[0]}`] : []),
    ...(idList(m.references) ? [`References: ${idList(m.references).split(' ').join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
  ]
  const plain = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(bytesToB64(new TextEncoder().encode(m.body.replace(/\r?\n/g, '\r\n'))))]
  // With a formatted version: text and HTML as alternatives of the same message (plain text first, as RFC 2046 asks).
  const alt = `${boundary}_alt`
  const textPart = m.html ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, ...plain, `--${alt}`,
    'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(bytesToB64(new TextEncoder().encode(m.html))), `--${alt}--`, ''] : plain
  if (!m.attachments.length) return [...h, ...textPart].join('\r\n') + '\r\n'
  const lines = [...h, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart]
  for (const a of m.attachments) {
    const type = a.contentType && /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : 'application/octet-stream'
    const fp = fileParams(a.fileName)
    lines.push(`--${boundary}`, `Content-Type: ${type}; ${fp.type}`, `Content-Disposition: attachment; ${fp.disp}`, 'Content-Transfer-Encoding: base64', '', wrap76(bytesToB64(a.bytes)))
  }
  lines.push(`--${boundary}--`, '')
  return lines.join('\r\n')
}

/** users.messages.send takes the whole message base64url-encoded in "raw". */
export const toRaw = (mime: string) => bytesToB64url(new TextEncoder().encode(mime))
