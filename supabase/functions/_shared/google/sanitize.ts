// HTML sanitiser for received email (allow-list). The result is stored and later shown in a sandboxed frame
// with a Content-Security-Policy that blocks scripts and remote content (defence in depth).
//
//   * Script-like elements are removed with their content (script, style, iframe, object, svg, form, …).
//   * Comments, doctype, CDATA and processing instructions are removed.
//   * Only allow-listed tags survive; others are dropped but their text is kept.
//   * Only allow-listed attributes survive; never event handlers, style, src or srcset.
//   * Links: http, https and mailto only; they open in a new window without referrer.
//   * Images are not loaded (tracking pixels, remote content): replaced by their alt text.
//   * Text is re-escaped, so no stray markup can survive.

const DROP_WITH_CONTENT = ['script', 'style', 'head', 'title', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes',
  'template', 'svg', 'math', 'xml', 'textarea', 'select', 'option', 'button', 'canvas', 'audio', 'video', 'picture', 'source', 'track', 'base', 'link', 'meta']
const ALLOWED = new Set(['a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
  'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var'])
const VOID = new Set(['br', 'hr', 'col'])
const ATTRS: Record<string, string[]> = {
  '*': ['title', 'dir', 'lang', 'align'],
  a: ['href'],
  td: ['colspan', 'rowspan', 'valign', 'width'],
  th: ['colspan', 'rowspan', 'valign', 'width', 'scope'],
  table: ['width', 'border', 'cellpadding', 'cellspacing'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  ol: ['start', 'type'],
  font: ['color', 'size', 'face'],
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (m, e: string) => {
    const lower = e.toLowerCase()
    if (lower.startsWith('#x')) { const n = parseInt(lower.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '' }
    if (lower.startsWith('#')) { const n = parseInt(lower.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '' }
    return NAMED[lower] ?? m
  })
}
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

function safeHref(v: string): string | null {
  // Decode entities and remove whitespace / control characters that browsers ignore inside a scheme.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const decoded = decodeEntities(v).replace(/[\u0000- \u007f-\u009f]/g, '')
  if (/^(https?:\/\/|mailto:)/i.test(decoded)) return decoded.slice(0, 2000)
  return null
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
function cleanAttributes(tag: string, raw: string): string {
  const allowed = new Set([...ATTRS['*'], ...(ATTRS[tag] ?? [])])
  const out: string[] = []
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase()
    if (!allowed.has(name)) continue
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    if (name === 'href') {
      const href = safeHref(value)
      if (href) out.push(`href="${escapeAttr(href)}"`)
      continue
    }
    const v = decodeEntities(value)
    if (!/^[\w\s#%.,:;+()-]{0,100}$/.test(v)) continue
    out.push(`${name}="${escapeAttr(v)}"`)
  }
  if (tag === 'a') out.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
  return out.length ? ' ' + out.join(' ') : ''
}

export function sanitizeHtml(input: string): string {
  let s = input.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?(\?>|$)/g, '')
  // Remove dangerous elements with their content; repeat until stable (nested / split tags).
  for (let i = 0; i < 5; i++) {
    const before = s
    for (const t of DROP_WITH_CONTENT) s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '')
    if (s === before) break
  }
  const out: string[] = []
  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(s))) {
    out.push(escapeText(decodeEntities(s.slice(last, m.index))))
    last = TAG.lastIndex
    const closing = m[0][1] === '/'
    const tag = m[1].toLowerCase()
    if (tag === 'img') {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[2])
      const text = alt ? decodeEntities(alt[1] ?? alt[2] ?? '').trim() : ''
      if (text) out.push(escapeText(`[${text.slice(0, 100)}]`))
      continue
    }
    if (!ALLOWED.has(tag)) continue
    if (closing) { if (!VOID.has(tag)) out.push(`</${tag}>`); continue }
    out.push(`<${tag}${cleanAttributes(tag, m[2])}>`)
  }
  out.push(escapeText(decodeEntities(s.slice(last))))
  return out.join('')
}

/** Plain text from HTML (used when an email has no text/plain part). */
export function htmlToText(input: string): string {
  let s = input.replace(/<!--[\s\S]*?(-->|$)/g, '')
  for (const t of DROP_WITH_CONTENT) s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '')
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ').replace(/<[^>]*>/g, '')
  return decodeEntities(s).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
