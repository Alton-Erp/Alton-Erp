// gst-2b-verify Edge Function with fake Supabase clients: server-side SHA-256 (mismatch, size), corrupted / wrong-format files,
// CSV and portal-style Excel parsing (multi-row headers, amendments, credit notes, original cells kept), the verification
// token round trip and the auth / permission paths. The database side (row validation, duplicates, matching) is covered by
// tests/db/accounting-foundation-check.mjs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'

import {
  extractRows, fieldOf, handle, headerOf, parseCsv, sectionOfSheet, sha256Hex, sniffKind, verifyFile,
  type AdminClient, type CallerClient, type Deps, type Sheet, type VerifyTarget,
} from '../../supabase/functions/gst-2b-verify/handler.ts'

const IMPORT = '33333333-3333-4333-8333-333333333333'
const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const readWorkbook = async (bytes: Uint8Array): Promise<Sheet[]> => {
  const wb = XLSX.read(bytes, { type: 'array', dense: true })
  return wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true })
    .map((r) => r.map((c) => String(c ?? ''))) }))
}
const CSV = [
  'GSTIN of supplier,Trade/Legal name,Invoice number,Invoice Date,Place of supply,Reverse Charge,Taxable Value,Integrated Tax,Central Tax,State/UT Tax,Cess,ITC Availability',
  '27AABCP1234A1Z5,"Supplier, One",INV/001,15-10-2026,27-Maharashtra,N,"1,000.00",0,90,90,0,Yes',
  '29AABCQ1234A1Z5,Supplier Two,"B-""7""",16-10-2026,29-Karnataka,N,500,90,0,0,0,No',
  ',,,,,,,,,,,',
].join('\r\n')

function portalWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new()
  const b2b = [
    ['Goods and Services Tax - GSTR-2B'], [], ['Taxable inward supplies received from registered persons'],
    ['GSTIN of supplier', 'Trade/Legal name', 'Invoice details', '', '', '', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Tax Amount', '', '', '', 'ITC Availability'],
    ['', '', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', '', '', '', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', ''],
    ['27AABCP1234A1Z5', 'Supplier One', 'INV/001', 'Regular', '15-10-2026', '1180', '27-Maharashtra', 'N', '1000', '0', '90', '90', '0', 'Yes'],
    ['29AABCQ1234A1Z5', 'Supplier Two', 'B-7', 'Regular', '16-10-2026', '590', '29-Karnataka', 'N', '500', '90', '0', '0', '0', 'Yes'],
  ]
  const b2ba = [
    ['Amendments to previously filed invoices'],
    ['Original details', '', 'Revised details'],
    ['Invoice number', 'Invoice Date', 'GSTIN of supplier', 'Trade/Legal name', 'Invoice number', 'Invoice Date', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
    ['INV/001', '15-10-2026', '27AABCP1234A1Z5', 'Supplier One', 'INV/001', '15-10-2026', '1100', '0', '99', '99', '0'],
  ]
  const cdnr = [
    ['GSTIN of supplier', 'Trade/Legal name', 'Credit note/Debit note details', '', '', 'Taxable Value (₹)', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
    ['', '', 'Note number', 'Note type', 'Note date', '', '', '', '', ''],
    ['27AABCP1234A1Z5', 'Supplier One', 'CN-1', 'Credit Note', '20-10-2026', '100', '0', '9', '9', '0'],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Read me'], ['This is a summary sheet']]), 'Read me')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2b), 'B2B')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2ba), 'B2BA')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cdnr), 'B2B-CDNR')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['GSTIN of ISD'], ['x']]), 'ISD')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const target = (bytes: Uint8Array, extra: Partial<VerifyTarget> = {}): VerifyTarget => ({
  import_id: IMPORT, bucket: 'gst-files', storage_path: `c/gstr2b/${IMPORT}.csv`, declared_sha256: sha(bytes), file_size: bytes.byteLength, mime_type: 'text/csv',
  file_kind: 'CSV', file_name: 'gstr2b.csv', token: 'tok-1', ...extra,
})

describe('GSTR-2B verification helpers', () => {
  it('computes SHA-256 with WebCrypto exactly as the browser / node do', async () => {
    const b = enc('abc')
    assert.equal(await sha256Hex(b), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(await sha256Hex(b), sha(b))
  })
  it('sniffs the real file format from its first bytes', () => {
    assert.equal(sniffKind(portalWorkbook()), 'ZIP')
    assert.equal(sniffKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2])), 'OLE')
    assert.equal(sniffKind(enc('a,b')), 'TEXT')
  })
  it('parses CSV with quotes, doubled quotes, embedded commas, CRLF and a BOM; semicolon files too', () => {
    const rows = parseCsv('﻿' + CSV)
    assert.equal(rows[1][1], 'Supplier, One')
    assert.equal(rows[1][6], '1,000.00')
    assert.equal(rows[2][2], 'B-"7"')
    assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']])
  })
  it('maps portal and template headers to fields; original-document columns are kept apart', () => {
    assert.equal(fieldOf('GSTIN of supplier'), 'supplier_gstin')
    assert.equal(fieldOf('Invoice details / Invoice number'), 'doc_number')
    assert.equal(fieldOf('Credit note/Debit note details / Note date'), 'doc_date')
    assert.equal(fieldOf('Credit note/Debit note details / Note type'), 'note_type')
    assert.equal(fieldOf('Original details / Invoice number'), 'original_doc_number')
    assert.equal(fieldOf('Original details / Invoice Date'), 'original_doc_date')
    assert.equal(fieldOf('Tax Amount / Integrated Tax(₹)'), 'igst')
    assert.equal(fieldOf('Tax Amount / State/UT Tax(₹)'), 'sgst')
    assert.equal(fieldOf('Invoice details / Invoice Value(₹)'), null)
    assert.equal(fieldOf('Invoice details / Invoice type'), null)
    assert.equal(sectionOfSheet('B2B-CDNR'), 'CDNR')
    assert.equal(sectionOfSheet('ISD'), null)
  })
  it('combines a two-row portal header (merged groups) and finds the first data row', () => {
    const h = headerOf([['Title'], ['GSTIN of supplier', 'Invoice details', '', 'Place of supply'], ['', 'Invoice number', 'Invoice Date', ''], ['27AABCP1234A1Z5', 'X', '01-10-2026', '27']])
    assert.ok(h)
    assert.equal(h.dataStart, 3)
    assert.deepEqual(h.headers, ['GSTIN of supplier', 'Invoice details / Invoice number', 'Invoice details / Invoice Date', 'Place of supply'])
  })
  it('reads the portal workbook: B2B, B2BA (original + revised) and B2B-CDNR rows with their original cells; other sheets skipped', async () => {
    const { rows, parser } = extractRows(await readWorkbook(portalWorkbook()))
    assert.equal(rows.length, 4)
    const [a, b, amend, note] = rows
    assert.equal(a.section, 'B2B'); assert.equal(a.row_no, 6); assert.equal(a.fields.doc_number, 'INV/001'); assert.equal(a.fields.cgst, '90')
    assert.equal(a.original['Invoice details / Invoice type'], 'Regular')
    assert.equal(a.original['Tax Amount / Central Tax(₹)'], '90')
    assert.equal(b.fields.igst, '90')
    assert.equal(amend.section, 'B2BA'); assert.equal(amend.fields.original_doc_number, 'INV/001'); assert.equal(amend.fields.doc_number, 'INV/001')
    assert.equal(amend.fields.taxable_value, '1100'); assert.equal(amend.fields.supplier_gstin, '27AABCP1234A1Z5')
    assert.equal(note.section, 'CDNR'); assert.equal(note.fields.note_type, 'Credit Note'); assert.equal(note.fields.doc_number, 'CN-1'); assert.equal(note.fields.doc_date, '20-10-2026')
    assert.deepEqual(parser.skipped, ['Read me', 'ISD'])
  })
})

describe('verifyFile', () => {
  it('a declared checksum that does not match the stored bytes is rejected without parsing', async () => {
    const b = enc(CSV)
    const r = await verifyFile(b, { ...target(b), declared_sha256: sha(enc('something else')) }, readWorkbook)
    assert.equal(r.ok, false); assert.equal(r.reason, 'Checksum mismatch'); assert.equal(r.sha256, sha(b)); assert.equal(r.rows, undefined)
  })
  it('one changed byte after upload changes the checksum (tampering / corruption in storage)', async () => {
    const b = enc(CSV)
    const declared = sha(b)
    const tampered = enc(CSV.replace('1,000.00', '9,000.00'))
    const r = await verifyFile(tampered, { declared_sha256: declared, file_size: tampered.byteLength, file_kind: 'CSV' }, readWorkbook)
    assert.equal(r.ok, false); assert.equal(r.reason, 'Checksum mismatch')
  })
  it('a size different from the declared size is rejected', async () => {
    const b = enc(CSV)
    const r = await verifyFile(b, { declared_sha256: sha(b), file_size: b.byteLength + 1, file_kind: 'CSV' }, readWorkbook)
    assert.equal(r.reason, 'Size mismatch')
  })
  it('a corrupted .xlsx (valid checksum of corrupt bytes) is rejected as unreadable', async () => {
    const good = portalWorkbook()
    const bad = good.slice(0, 200)
    const r = await verifyFile(bad, { declared_sha256: sha(bad), file_size: bad.byteLength, file_kind: 'XLSX' }, readWorkbook)
    assert.equal(r.ok, false); assert.match(r.reason ?? '', /could not be read|corrupted|No GSTR-2B/)
  })
  it('a CSV renamed to .xlsx, an old .xls, and a spreadsheet uploaded as .csv are refused', async () => {
    const csv = enc(CSV)
    assert.match((await verifyFile(csv, { declared_sha256: sha(csv), file_size: csv.byteLength, file_kind: 'XLSX' }, readWorkbook)).reason ?? '', /not a valid Excel/)
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    assert.match((await verifyFile(ole, { declared_sha256: sha(ole), file_size: ole.byteLength, file_kind: 'XLSX' }, readWorkbook)).reason ?? '', /not a valid Excel/)
    const x = portalWorkbook()
    assert.match((await verifyFile(x, { declared_sha256: sha(x), file_size: x.byteLength, file_kind: 'CSV' }, readWorkbook)).reason ?? '', /not a CSV text file/)
  })
  it('binary / non-UTF-8 content in a CSV is rejected', async () => {
    const b = new Uint8Array([0x47, 0x53, 0x54, 0xff, 0xfe, 0x00, 0x41])
    const r = await verifyFile(b, { declared_sha256: sha(b), file_size: b.byteLength, file_kind: 'CSV' }, readWorkbook)
    assert.match(r.reason ?? '', /not valid UTF-8|binary/)
  })
  it('a file without GSTR-2B document columns is rejected with an explanation', async () => {
    const b = enc('Name,Amount\nA,1')
    const r = await verifyFile(b, { declared_sha256: sha(b), file_size: b.byteLength, file_kind: 'CSV' }, readWorkbook)
    assert.equal(r.ok, false); assert.match(r.reason ?? '', /No GSTR-2B document rows/)
  })
  it('a valid CSV returns its rows (blank rows skipped) with the computed checksum', async () => {
    const b = enc(CSV)
    const r = await verifyFile(b, target(b), readWorkbook)
    assert.equal(r.ok, true); assert.equal(r.sha256, sha(b)); assert.equal(r.rows?.length, 2)
    assert.equal(r.rows?.[0].fields.supplier_name, 'Supplier, One'); assert.equal(r.rows?.[0].original['Taxable Value'], '1,000.00')
  })
})

describe('handle', () => {
  const calls: { fn: string; args?: Record<string, unknown> }[] = []
  const deps = (opts: { bytes?: Uint8Array | null; targetError?: { code: string; message: string }; declared?: string } = {}): Deps => {
    const bytes = opts.bytes === undefined ? enc(CSV) : opts.bytes
    const caller: CallerClient = {
      rpc: async <T>(fn: string, args?: Record<string, unknown>) => {
        calls.push({ fn, args })
        if (opts.targetError) return { data: null, error: opts.targetError }
        return { data: { ...target(bytes ?? enc('')), declared_sha256: opts.declared ?? sha(bytes ?? enc('')) } as unknown as T, error: null }
      },
    }
    const admin: AdminClient = {
      rpc: async <T>(fn: string, args?: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { status: 'VERIFIED' } as unknown as T, error: null } },
      download: async () => (bytes ? { bytes, error: null } : { bytes: null, error: 'Object not found' }),
    }
    return { allowedOrigins: [], configured: true, caller: () => caller, admin: () => admin, readWorkbook }
  }
  const post = (body: unknown, auth = 'Bearer user-jwt') => new Request('https://x/functions/v1/gst-2b-verify', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('requires POST, a signed-in user and a UUID', async () => {
    assert.equal((await handle(new Request('https://x', { method: 'GET' }), deps())).status, 405)
    assert.equal((await handle(post({ import_id: IMPORT }, ''), deps())).status, 401)
    assert.equal((await handle(post({ import_id: 'nope' }), deps())).status, 400)
  })
  it('an unauthorized caller (no gst_reconciliation.manage / another company) is refused before any download', async () => {
    calls.length = 0
    const r = await handle(post({ import_id: IMPORT }), deps({ targetError: { code: '42501', message: 'You are not allowed to perform this action (requires gst_reconciliation.manage).' } }))
    assert.equal(r.status, 403)
    assert.deepEqual(calls.map((c) => c.fn), ['gst_2b_verify_target'])
    const nf = await handle(post({ import_id: IMPORT }), deps({ targetError: { code: 'P0002', message: 'GSTR-2B import not found.' } }))
    assert.equal(nf.status, 404)
  })
  it('records the server-computed checksum and rows with the one-time token (service role)', async () => {
    calls.length = 0
    const r = await handle(post({ import_id: IMPORT }), deps())
    assert.equal(r.status, 200)
    const rec = calls.find((c) => c.fn === 'gst_2b_verify_record')
    assert.ok(rec)
    assert.equal(rec.args?.p_token, 'tok-1')
    const p = rec.args?.p as { sha256: string; ok: boolean; rows: unknown[] }
    assert.equal(p.sha256, sha(enc(CSV))); assert.equal(p.ok, true); assert.equal(p.rows.length, 2)
  })
  it('a mismatching checksum is recorded as a rejection (the database rejects the import)', async () => {
    calls.length = 0
    await handle(post({ import_id: IMPORT }), deps({ declared: 'f'.repeat(64) }))
    const p = calls.find((c) => c.fn === 'gst_2b_verify_record')?.args?.p as { ok: boolean; reason: string; sha256: string }
    assert.equal(p.ok, false); assert.equal(p.reason, 'Checksum mismatch'); assert.equal(p.sha256, sha(enc(CSV)))
  })
  it('a missing stored object is recorded as a rejection', async () => {
    calls.length = 0
    await handle(post({ import_id: IMPORT }), deps({ bytes: null }))
    const p = calls.find((c) => c.fn === 'gst_2b_verify_record')?.args?.p as { ok: boolean; reason: string }
    assert.equal(p.ok, false); assert.match(p.reason, /could not be read: Object not found/)
  })
})
