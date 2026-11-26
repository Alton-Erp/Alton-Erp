// gst-2b-verify request handling (no Deno / npm imports; unit-tested in tests/unit/gst-2b-verify.test.ts).
//
// POST { import_id } by a signed-in ERP user with gst_reconciliation.manage, after the browser uploaded the original GSTR-2B file
// (CSV or Excel .xlsx downloaded from the GST portal) to the private gst-files bucket and completed the upload.
//
//   1. gst_2b_verify_target (user JWT): permission + company check, status UPLOADED, one-time verification token.
//   2. The stored object is downloaded with the service role and its SHA-256 is computed here, on the server, from the stored bytes.
//   3. When the checksum and size equal what was declared at upload, the file is parsed (CSV / XLSX); the original cells of every row
//      are kept next to the mapped fields. A corrupted or unreadable file is rejected.
//   4. gst_2b_verify_record (service role, token) records the computed checksum and the rows; the database validates every row and
//      rejects the import on any mismatch. Nothing is posted and no ITC is decided.
//
// Never claims a GST portal / GSTN / JSON integration: it reads the file the user downloaded.

export interface RpcResult<T> { data: T | null; error: { code?: string; message?: string } | null }
export interface CallerClient { rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>> }
export interface AdminClient {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>>
  download(bucket: string, path: string): Promise<{ bytes: Uint8Array | null; error: string | null }>
}
export interface Sheet { name: string; rows: string[][] }
export interface Deps {
  allowedOrigins: string[]
  configured: boolean
  caller(authHeader: string): CallerClient
  admin(): AdminClient
  readWorkbook(bytes: Uint8Array): Promise<Sheet[]>
  subtle?: SubtleCrypto
}
export interface VerifyTarget {
  import_id: string
  bucket: string
  storage_path: string
  declared_sha256: string
  file_size: number
  mime_type: string
  file_kind: 'CSV' | 'XLSX'
  file_name: string
  token: string
}
export interface ParsedRow { sheet: string; section: string; row_no: number; original: Record<string, string>; fields: Record<string, string> }
export interface VerifyResult {
  sha256: string
  size: number
  ok: boolean
  reason?: string
  rows?: ParsedRow[]
  parser?: Record<string, unknown>
}

export const MAX_ROWS = 20000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export async function sha256Hex(bytes: Uint8Array, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** ZIP (xlsx), OLE (old binary .xls) or plain text, from the first bytes. */
export function sniffKind(bytes: Uint8Array): 'ZIP' | 'OLE' | 'TEXT' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'ZIP'
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'OLE'
  return 'TEXT'
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF / LF); comma, semicolon or tab detected from the first line. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const first = src.slice(0, Math.max(0, src.search(/\r?\n/)) || src.length)
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1] as const)
  const delim = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Maps a (combined) column header to a field, or null. Order matters: original-document columns before the current ones. */
export function fieldOf(header: string): string | null {
  const s = norm(header)
  if (!s) return null
  if (s === 'section' || s === 'sheet' || s === 'table') return 'section'
  if (s === 'doctype' || s === 'documenttype') return 'doc_type'
  if (s.includes('original') && /(number|no)$/.test(s)) return 'original_doc_number'
  if (s.includes('original') && s.endsWith('date')) return 'original_doc_date'
  if (s.includes('gstin') && (s.includes('supplier') || s === 'gstin' || s.endsWith('ctin'))) return 'supplier_gstin'
  if (s.includes('tradelegalname') || s.includes('legalname') || s.includes('tradename') || s.includes('suppliername')) return 'supplier_name'
  if (s.endsWith('notetype')) return 'note_type'
  if (/(invoice|note|document|doc)(number|no)$/.test(s)) return 'doc_number'
  if (/(invoice|note|document|doc)date$/.test(s)) return 'doc_date'
  if (s.includes('placeofsupply')) return 'place_of_supply'
  if (s.includes('reversecharge')) return 'reverse_charge'
  if (s.includes('taxablevalue')) return 'taxable_value'
  if (s.includes('integratedtax') || s.endsWith('igst')) return 'igst'
  if (s.includes('centraltax') || s.endsWith('cgst')) return 'cgst'
  if (s.includes('stateuttax') || s.includes('statetax') || s.endsWith('sgst') || s.endsWith('utgst')) return 'sgst'
  if (s.endsWith('cess')) return 'cess'
  if (s.includes('itcavailability') || s === 'itcavailable' || s === 'eligibleforitc') return 'itc_availability'
  return null
}

/** GSTR-2B sections read; every other sheet (ISD, IMPG, summaries, …) is listed as skipped. */
export function sectionOfSheet(name: string): string | null {
  const s = norm(name)
  return ({ b2b: 'B2B', b2ba: 'B2BA', b2bcdnr: 'CDNR', b2bcdnra: 'CDNRA', cdnr: 'CDNR', cdnra: 'CDNRA', csv: 'B2B' } as Record<string, string>)[s] ?? null
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim()

/** Finds the header block (1–3 rows above the first data row) and combines merged group labels with their sub-labels. */
export function headerOf(rows: string[][]): { headers: string[]; dataStart: number } | null {
  const scan = Math.min(rows.length, 25)
  let gst = -1
  for (let r = 0; r < scan && gst < 0; r++) if (rows[r].some((c) => fieldOf(cellText(c)) === 'supplier_gstin')) gst = r
  if (gst < 0) return null
  let dataStart = gst + 1
  while (dataStart < rows.length && dataStart <= gst + 3 && !rows[dataStart].some((c) => GSTIN.test(cellText(c).toUpperCase()))) dataStart++
  if (dataStart > gst + 3 || dataStart >= rows.length) dataStart = gst + 1 + (rows[gst + 1]?.some((c) => fieldOf(cellText(c))) ? 1 : 0)
  let top = gst
  for (let r = gst - 1; r >= Math.max(0, gst - 2); r--) if (rows[r].some((c) => /original|revised/i.test(cellText(c)))) top = r
  const block = rows.slice(top, dataStart)
  const width = Math.max(...block.map((r) => r.length))
  const headers: string[] = []
  for (let c = 0; c < width; c++) {
    const parts: string[] = []
    block.forEach((r, k) => {
      let v = cellText(r[c])
      const below = block.slice(k + 1).some((rr) => cellText(rr[c]) !== '')
      if (!v && below) for (let cc = c - 1; cc >= 0 && !v; cc--) v = cellText(r[cc])
      if (v) parts.push(v)
    })
    headers.push(parts.join(' / '))
  }
  return { headers, dataStart }
}

export function extractRows(sheets: Sheet[]): { rows: ParsedRow[]; parser: Record<string, unknown> } {
  const rows: ParsedRow[] = []
  const used: Record<string, unknown>[] = []
  const skipped: string[] = []
  for (const sheet of sheets) {
    const section = sectionOfSheet(sheet.name)
    if (!section) { skipped.push(sheet.name); continue }
    const h = headerOf(sheet.rows)
    if (!h) { skipped.push(`${sheet.name} (no "GSTIN of supplier" column)`); continue }
    const map = new Map<number, string>()
    const seen = new Set<string>()
    h.headers.forEach((label, c) => { const f = fieldOf(label); if (f && !seen.has(f)) { seen.add(f); map.set(c, f) } })
    if (!seen.has('doc_number')) { skipped.push(`${sheet.name} (no document number column)`); continue }
    let n = 0
    for (let r = h.dataStart; r < sheet.rows.length; r++) {
      const cells = sheet.rows[r] ?? []
      const fields: Record<string, string> = {}
      for (const [c, f] of map) fields[f] = cellText(cells[c])
      if (!fields.supplier_gstin && !fields.doc_number) continue
      const original: Record<string, string> = {}
      h.headers.forEach((label, c) => {
        const v = cellText(cells[c])
        const key = label || `Column ${c + 1}`
        original[key in original ? `${key} (${c + 1})` : key] = v
      })
      rows.push({ sheet: sheet.name, section: fields.section || section, row_no: r + 1, original, fields })
      n++
    }
    used.push({ sheet: sheet.name, section, header_row: h.dataStart, rows: n, columns: Object.fromEntries([...map].map(([c, f]) => [f, h.headers[c]])) })
  }
  return { rows, parser: { sheets: used, skipped } }
}

export async function verifyFile(bytes: Uint8Array, target: Pick<VerifyTarget, 'declared_sha256' | 'file_size' | 'file_kind'>,
  readWorkbook: Deps['readWorkbook'], subtle?: SubtleCrypto): Promise<VerifyResult> {
  const base = { sha256: await sha256Hex(bytes, subtle), size: bytes.byteLength }
  if (base.sha256 !== target.declared_sha256) return { ...base, ok: false, reason: 'Checksum mismatch' }
  if (base.size !== Number(target.file_size)) return { ...base, ok: false, reason: 'Size mismatch' }
  const kind = sniffKind(bytes)
  let sheets: Sheet[]
  if (target.file_kind === 'XLSX') {
    if (kind !== 'ZIP') return { ...base, ok: false, reason: 'The file is not a valid Excel .xlsx workbook (corrupted, or another format such as .xls / CSV renamed).' }
    try {
      sheets = await readWorkbook(bytes)
    } catch (e) {
      return { ...base, ok: false, reason: `The Excel file could not be read (corrupted): ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) }
    }
  } else {
    if (kind !== 'TEXT') return { ...base, ok: false, reason: 'The file is not a CSV text file (it looks like a spreadsheet or binary file).' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { ...base, ok: false, reason: 'The CSV file is not valid UTF-8 text (corrupted or binary).' }
    }
    if (text.includes('\u0000')) return { ...base, ok: false, reason: 'The CSV file contains binary data (corrupted).' }
    sheets = [{ name: 'CSV', rows: parseCsv(text) }]
  }
  const { rows, parser } = extractRows(sheets)
  if (rows.length === 0) {
    return { ...base, ok: false, parser, reason: `No GSTR-2B document rows were found (sheets B2B, B2BA, B2B-CDNR, B2B-CDNRA with a "GSTIN of supplier" column).${
      (parser.skipped as string[]).length ? ` Skipped: ${(parser.skipped as string[]).join(', ')}.` : ''}`.slice(0, 900) }
  }
  if (rows.length > MAX_ROWS) return { ...base, ok: false, parser, reason: `The file has ${rows.length} document rows; the limit is ${MAX_ROWS}.` }
  return { ...base, ok: true, rows, parser }
}

const statusOf = (code?: string) => (code === '42501' ? 403 : code === 'P0002' ? 404 : code === 'PGRST301' ? 401 : 400)

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.allowedOrigins)
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' })
  if (!deps.configured) return json(500, { error: 'The verification service is not configured.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer \S+$/.test(auth)) return json(401, { error: 'Sign in first.' })
  let importId = ''
  try {
    importId = String(((await req.json()) as { import_id?: unknown }).import_id ?? '')
  } catch {
    return json(400, { error: 'Send JSON: { "import_id": "<uuid>" }.' })
  }
  if (!UUID.test(importId)) return json(400, { error: 'import_id must be a UUID.' })

  const target = await deps.caller(auth).rpc<VerifyTarget>('gst_2b_verify_target', { p_import_id: importId })
  if (target.error || !target.data) return json(statusOf(target.error?.code), { error: target.error?.message ?? 'Import not found.' })
  const t = target.data
  const admin = deps.admin()
  const file = await admin.download(t.bucket, t.storage_path)
  const result: VerifyResult = file.bytes
    ? await verifyFile(file.bytes, t, deps.readWorkbook, deps.subtle)
    : { sha256: '', size: 0, ok: false, reason: `The stored file could not be read${file.error ? `: ${file.error}` : ''}.`.slice(0, 500) }
  const recorded = await admin.rpc('gst_2b_verify_record', { p_import_id: t.import_id, p_token: t.token, p: result })
  if (recorded.error) return json(statusOf(recorded.error.code), { error: recorded.error.message ?? 'The verification could not be recorded.' })
  return json(200, { import: recorded.data })
}
