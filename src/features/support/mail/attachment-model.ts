// File kinds, preview rules and names for email attachments (no React; unit-tested in tests/unit/email-workspace.test.ts).

export type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'doc' | 'sheet' | 'csv' | 'slides' | 'zip' | 'text' | 'web' | 'mail' | 'calendar' | 'contact' | 'other'
export type PreviewMode = 'image' | 'pdf' | 'video' | 'audio' | 'text' | null

const EXT: Record<string, FileKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', heic: 'image', heif: 'image', svg: 'image', tif: 'image', tiff: 'image', ico: 'image',
  pdf: 'pdf',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ogv: 'video', avi: 'video', mkv: 'video', '3gp': 'video', wmv: 'video', mpg: 'video', mpeg: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', aac: 'audio', opus: 'audio', flac: 'audio', amr: 'audio', wma: 'audio', aiff: 'audio',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', ods: 'sheet', numbers: 'sheet',
  csv: 'csv', tsv: 'csv',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  zip: 'zip', rar: 'zip', '7z': 'zip', gz: 'zip', tgz: 'zip', tar: 'zip', bz2: 'zip', xz: 'zip',
  txt: 'text', log: 'text', md: 'text', json: 'text', xml: 'text', yaml: 'text', yml: 'text', ini: 'text',
  html: 'web', htm: 'web', xhtml: 'web',
  eml: 'mail', msg: 'mail',
  ics: 'calendar', vcs: 'calendar',
  vcf: 'contact', vcard: 'contact',
}

export const fileExt = (name: string) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim()); return m ? m[1].toLowerCase() : '' }

/** The kind from the extension, else from the content type (Gmail sometimes sends application/octet-stream). */
export function fileKind(name: string, contentType: string | null): FileKind {
  const byExt = EXT[fileExt(name)]
  if (byExt) return byExt
  const t = (contentType ?? '').toLowerCase()
  if (t.startsWith('image/')) return 'image'
  if (t === 'application/pdf') return 'pdf'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t === 'text/csv' || t === 'text/tab-separated-values') return 'csv'
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'web'
  if (t === 'message/rfc822' || t === 'application/vnd.ms-outlook') return 'mail'
  if (t === 'text/calendar') return 'calendar'
  if (t === 'text/vcard' || t === 'text/x-vcard') return 'contact'
  if (t.includes('opendocument.text') || t.includes('rtf')) return 'doc'
  if (t.includes('opendocument.spreadsheet')) return 'sheet'
  if (t.includes('opendocument.presentation')) return 'slides'
  if (t.includes('rar') || t.includes('7z') || t.includes('x-tar') || t.includes('gzip')) return 'zip'
  if (t === 'application/json' || t.endsWith('+json') || t === 'application/xml' || t.endsWith('+xml')) return 'text'
  if (t.includes('spreadsheet') || t.includes('excel')) return 'sheet'
  if (t.includes('wordprocessing') || t === 'application/msword') return 'doc'
  if (t.includes('presentation') || t.includes('powerpoint')) return 'slides'
  if (t.includes('zip') || t.includes('compressed')) return 'zip'
  if (t.startsWith('text/')) return 'text'
  return 'other'
}

export const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image', pdf: 'PDF', video: 'Video', audio: 'Audio', doc: 'Document', sheet: 'Spreadsheet', csv: 'CSV', slides: 'Presentation', zip: 'Archive', text: 'Text', web: 'HTML',
  mail: 'Email', calendar: 'Calendar', contact: 'Contact', other: 'File',
}

// Formats every current browser shows by itself (HEIC / TIFF / AVI / MKV / Office files are offered as downloads only;
// unknown types are never hidden: they get a generic icon and Download).
const IMAGE_OK = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'])
const VIDEO_OK = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov'])
const AUDIO_OK = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'opus', 'flac'])

/** Text-based files shown as plain text (never rendered): HTML shows its source, so no script or remote content runs. */
const TEXT_KINDS = new Set<FileKind>(['csv', 'text', 'web', 'calendar', 'contact'])

/** How the preview shows the file; null: download only. Text and CSV are read only up to 2 MB. SVG is shown only through
 *  <img>, where the browser runs no script. An Outlook .msg is binary (download); an .eml is shown as its source. */
export function previewMode(name: string, contentType: string | null, size: number | null): PreviewMode {
  const kind = fileKind(name, contentType)
  const ext = fileExt(name)
  const t = (contentType ?? '').toLowerCase()
  if (kind === 'image') return IMAGE_OK.has(ext) || /^image\/(jpeg|png|gif|webp|bmp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(t) ? 'image' : null
  // Embedded only when stored as a PDF (a ".pdf" stored as text/html or anything else is never framed).
  if (kind === 'pdf') return !t || t === 'application/pdf' || t === 'application/x-pdf' ? 'pdf' : null
  if (kind === 'video') return VIDEO_OK.has(ext) || /^video\/(mp4|webm|ogg|quicktime)$/.test(t) ? 'video' : null
  if (kind === 'audio') return AUDIO_OK.has(ext) || t.startsWith('audio/') ? 'audio' : null
  const textual = TEXT_KINDS.has(kind) || (kind === 'mail' && ext !== 'msg' && t !== 'application/vnd.ms-outlook')
  if (textual && (size ?? 0) <= 2 * 1048576) return 'text'
  return null
}

/** "Open in a new tab" serves the file from the storage domain as its own page, so it is offered only for types the
 *  browser shows without running anything (no SVG, HTML, XML or unknown types; those are previewed here or downloaded). */
export function canOpenInTab(name: string, contentType: string | null, size: number | null): boolean {
  const mode = previewMode(name, contentType, size)
  const t = (contentType ?? '').toLowerCase()
  if (mode === 'image') return fileExt(name) !== 'svg' && !t.includes('svg')
  return mode === 'pdf' || mode === 'video' || mode === 'audio'
}

/** Upper-case extension for the tile ("PDF", "DOCX"); empty when the name has none. */
export const extLabel = (name: string) => fileExt(name).toUpperCase()

/** Files of one email in display order: ordinary attachments first, then images embedded in the body (shown here because
 *  the safe HTML view never loads images); stable within each group. */
export function orderAttachments<T extends { inline?: boolean }>(list: T[]): T[] {
  return [...list.filter((a) => !a.inline), ...list.filter((a) => a.inline)]
}

/** Shortens a file name in the middle so the extension stays visible ("Quarterly rep….pdf"). */
export function shortName(name: string, max = 24): string {
  if (name.length <= max) return name
  const ext = fileExt(name)
  const tail = ext ? `.${ext}` : ''
  const keep = Math.max(4, max - tail.length - 1)
  return `${name.slice(0, keep).trimEnd()}…${tail}`
}

/** A small CSV / TSV reader for the preview (quoted fields, doubled quotes, CRLF). At most maxRows rows. */
export function parseCsv(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const delimiter = (text.split('\n', 1)[0].match(/\t/g)?.length ?? 0) > (text.split('\n', 1)[0].match(/,/g)?.length ?? 0) ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 }
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return { rows, truncated: false }
}

/** Decodes Gmail's base64url "raw" message into bytes (for the .eml download). */
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
