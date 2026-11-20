// Formatted emails from the ERP's email editor. The browser never sends HTML: it sends a small, readable markup
// and the HTML part is built here, with every character of text escaped. Supported:
//   **bold**   *italic*   ++underline++   [link text](https://… | http://… | mailto:…)
//   lines starting "- " (bulleted list) or "1. " (numbered list); blank line = new paragraph.
// A backslash makes the next character literal (\* \+ \[ \] \\ and "\- " / "\1. " at the start of a line).
// Anything else is plain text. Used only when the request says format = "markdown".

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Only absolute http(s) and mailto links; anything else stays text. */
export function safeHref(url: string): string | null {
  const u = url.trim()
  if (/^mailto:[^\s<>"']+$/i.test(u)) return u
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null
  } catch {
    return null
  }
}

type Mark = '**' | '*' | '++'
const TAG: Record<Mark, string> = { '**': 'strong', '*': 'em', '++': 'u' }

/** Inline markup to HTML. Unclosed markers are printed as typed. */
export function inlineToHtml(src: string): string {
  let out = ''
  const stack: { mark: Mark; at: number }[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length) { out += esc(src[i + 1]); i += 2; continue }
    if (ch === '[') {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/.exec(src.slice(i))
      const href = m ? safeHref(m[2]) : null
      if (m && href) {
        out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inlineToHtml(m[1])}</a>`
        i += m[0].length
        continue
      }
    }
    // "***" after "**…*…": the innermost open mark closes first (italic inside bold), as the editor writes nested formatting.
    const innerItalic = ch === '*' && stack.at(-1)?.mark === '*'
    const mark: Mark | null = innerItalic ? '*' : src.startsWith('**', i) ? '**' : src.startsWith('++', i) ? '++' : ch === '*' ? '*' : null
    if (mark) {
      const open = stack.findIndex((s) => s.mark === mark)
      if (open >= 0) {
        // Close this mark (and any opened inside it, which are then printed as typed).
        const inner = stack.splice(open)
        for (let k = inner.length - 1; k >= 1; k--) out = out.slice(0, inner[k].at) + esc(inner[k].mark) + out.slice(inner[k].at + `<${TAG[inner[k].mark]}>`.length)
        out += `</${TAG[mark]}>`
      } else {
        stack.push({ mark, at: out.length })
        out += `<${TAG[mark]}>`
      }
      i += mark.length
      continue
    }
    out += esc(ch)
    i++
  }
  // Unclosed marks: print them as typed.
  for (let k = stack.length - 1; k >= 0; k--) out = out.slice(0, stack[k].at) + esc(stack[k].mark) + out.slice(stack[k].at + `<${TAG[stack[k].mark]}>`.length)
  return out
}

/** The whole body: paragraphs, line breaks and lists. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let para: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => { if (para.length) blocks.push(`<p style="margin:0 0 12px">${para.map(inlineToHtml).join('<br>')}</p>`); para = [] }
  const flushList = () => { if (list) blocks.push(`<${list.type} style="margin:0 0 12px;padding-left:24px">${list.items.map((x) => `<li>${inlineToHtml(x)}</li>`).join('')}</${list.type}>`); list = null }
  for (const line of lines) {
    const ul = /^[-•]\s+(.*)$/.exec(line)
    const ol = /^\d{1,3}\.\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const type = ul ? 'ul' : 'ol'
      if (list && list.type !== type) flushList()
      if (!list) list = { type, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    flushList()
    if (!line.trim()) { flushPara(); continue }
    para.push(line)
  }
  flushPara()
  flushList()
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">${blocks.join('')}</div>`
}

/** Plain-text version for the text/plain part: markers removed, links as "text (url)". */
export function markdownToText(md: string): string {
  return md.replace(/\r\n?/g, '\n').split('\n').map((line) => line
    .replace(/\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/g, (_m, t: string, u: string) => (safeHref(u) ? `${t} (${u})` : _m))
    .replace(/\*\*|\+\+/g, '')
    .replace(/(^|[^\\])\*/g, '$1')
    .replace(/\\(.)/g, '$1')).join('\n')
}
