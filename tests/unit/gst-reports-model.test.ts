// GST period close and the ten control reports (migration 20261231090800): report tables, the Excel workbook (named sheets, header block
// with company / GSTIN / period / status / exact disclaimer, INR number format with red negatives), CSV (header lines, 2-decimal amounts,
// formula-like text neutralised), the period lifecycle and close-control labels (an open warning is never "passed"), and the print layout.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

import {
  GST_DISCLAIMER, INR_FORMAT, REPORTS, buildCsv, buildWorkbook, controlState, csvCell, headerLines, lifecycleSteps, reportTables, sheetNames,
  type ControlReport, type ReportKey, type WorkingDoc,
} from '../../src/features/accounting/gst-reports-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const head = (report: ReportKey, extra: Record<string, unknown> = {}): ControlReport => ({
  report, company: { legal_name: 'Alton Hi-Tech Sanitary Ware', display_name: 'Alton' }, gstin: '27AABCA1234A1Z5', period_code: '2026-10', from: '2026-10-01', to: '2026-10-31',
  financial_year: '2026-27', period_status: 'CLOSED', config_version_no: 1, snapshot: { id: 's1', version_no: 1, snapshot_hash: 'a'.repeat(64), created_at: '2026-11-26' },
  filings: [{ return_type: 'GSTR3B', arn: 'AA2710261234567', filed_on: '2026-11-26' }], value_status: 'FILED', generated_at: '2026-11-26T10:00:00Z', disclaimer: GST_DISCLAIMER, ...extra })
const liability = head('TAX_LIABILITY', { rows: [{ head: 'IGST', documents: 36720, ledger: 200, ledger_minus_documents: -36520, gstr1_calculated: 36720, gstr3b_calculated: 36720 }],
  unexplained_vouchers: [{ voucher_number: 'JV/1', date: '2026-10-15', source: 'MANUAL', account: '2230 Output IGST', debit: 0, credit: 200 }] })

describe('GST control reports', () => {
  it('there are exactly ten reports, numbered 1–10, each with its data sources; only the audit report is period-only; the cash report needs a payments permission', () => {
    assert.deepEqual(REPORTS.map((r) => r.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.ok(REPORTS.every((r) => r.sources.length > 20))
    assert.deepEqual(REPORTS.filter((r) => r.periodOnly).map((r) => r.key), ['PERIOD_AUDIT'])
    assert.deepEqual(REPORTS.filter((r) => r.paymentPermission).map((r) => r.key), ['CASH_LEDGER'])
  })
  it('every report maps to named tables (unknown fields never break it)', () => {
    for (const r of REPORTS) assert.ok(reportTables(head(r.key)).length >= 1, r.key)
    const g = reportTables(head('GSTR2B', { summary: { EXACT: 1, PARTIAL: 2 }, documents: [{ doc_number: 'S-1', exact: false, tolerance: 1, config_version_no: 1, category: 'PARTIAL' }] }))
    assert.deepEqual(g.map((x) => x.title), ['Summary', 'Documents', 'Reversed / rejected matches', 'Amendments', 'Duplicates', 'Missing in GSTR-2B'])
    assert.ok(g[1].columns.some((c) => c.key === 'tolerance') && g[1].columns.some((c) => c.key === 'config_version_no'))
    const c = reportTables(head('CASH_LEDGER', { payments: [{ cpin: '1', counted: false, flag: 'NOT_A_PAYMENT', bank_account: { code: 'HDFC', number: 'XXXX5678' } }] }))
    assert.equal(c[0].rows[0].bank, 'HDFC XXXX5678')
  })
  it('header lines carry company, GSTIN, financial year, tax period, generation time, configuration and snapshot reference, status and the exact disclaimer', () => {
    const lines = headerLines({ title: '1. GST tax liability reconciliation', header: liability, tables: [] })
    assert.equal(lines[1], 'Alton Hi-Tech Sanitary Ware · GSTIN 27AABCA1234A1Z5')
    assert.equal(lines[2], 'Financial year 2026-27 · Tax period 2026-10 (2026-10-01 to 2026-10-31)')
    assert.match(lines[3], /Generated 2026-11-26T10:00:00Z · Configuration version 1/)
    assert.match(lines[4], /Snapshot v1 · a{64}/)
    assert.match(lines[5], /Filed \(recorded by the user\) · Filing recorded: GSTR3B ARN AA2710261234567/)
    assert.equal(lines.at(-1), GST_DISCLAIMER)
    assert.equal(GST_DISCLAIMER, 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.')
  })
})

describe('GST working files', () => {
  const doc: WorkingDoc = { title: '1. GST tax liability reconciliation', header: liability, tables: reportTables(liability) }
  it('Excel: one correctly named sheet per table, header block first, amounts as numbers in the INR format with red negatives', () => {
    const wb = buildWorkbook(XLSX as never, doc) as XLSX.WorkBook
    const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true }), { type: 'array', cellNF: true, cellStyles: true })
    assert.deepEqual(back.SheetNames, ['Tax heads', 'Unexplained vouchers'])
    const ws = back.Sheets['Tax heads']
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null })
    assert.equal(rows[0][0], '1. GST tax liability reconciliation')
    assert.equal(rows[6][0], GST_DISCLAIMER)
    assert.equal(rows[8][0], 'Head')
    assert.deepEqual(rows[9].slice(0, 4), ['IGST', 36720, 200, -36520])
    const neg = ws[XLSX.utils.encode_cell({ r: 9, c: 3 })]
    assert.equal(neg.t, 'n')
    assert.equal(neg.z, INR_FORMAT)
    assert.match(INR_FORMAT, /\[Red\]-/)
  })
  it('sheet names are at most 31 characters, without forbidden characters, and unique', () => {
    assert.deepEqual(sheetNames(['A/B: C*?', 'A/B: C*?', 'x'.repeat(40)]), ['A B C', 'A B C 2', 'x'.repeat(31)])
  })
  it('CSV: BOM, header lines and disclaimer first, then the table; amounts with 2 decimals; quotes and formula-like text handled', () => {
    const csv = buildCsv(doc, 0)
    assert.ok(csv.startsWith('﻿1. GST tax liability reconciliation\r\n'))
    assert.ok(csv.includes(GST_DISCLAIMER))
    const lines = csv.split('\r\n')
    const hdr = lines.indexOf('Tax heads')
    assert.ok(hdr > 0)
    assert.equal(lines[hdr + 2].split(',').slice(0, 4).join(','), 'IGST,36720.00,200.00,-36520.00')
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
    assert.equal(csvCell('a, "b"'), '"a, ""b"""')
    assert.equal(csvCell(5), '5')
    assert.equal(csvCell(null), '')
  })
})

describe('GST period close', () => {
  it('lifecycle: open → in review → ready → approved → closed → filed (recorded); filed is shown on top of the status', () => {
    assert.deepEqual(lifecycleSteps({ status: 'APPROVED', label: 'APPROVED', filed: [], reopened_count: 0 }).map((s) => s.state), ['done', 'done', 'done', 'current', 'todo', 'todo'])
    assert.deepEqual(lifecycleSteps({ status: 'CLOSED', label: 'FILED', filed: [{ return_type: 'GSTR3B', arn: 'A', filed_on: 'd' }], reopened_count: 0 }).map((s) => s.state),
      ['done', 'done', 'done', 'done', 'done', 'current'])
  })
  it('a blocker passes or fails; a warning is clear or open — never "passed"', () => {
    assert.equal(controlState({ code: 'X', severity: 'BLOCKER', count: 0, passed: true, message: '' }), 'Passed')
    assert.equal(controlState({ code: 'X', severity: 'BLOCKER', count: 2, passed: false, message: '' }), 'Failed')
    assert.equal(controlState({ code: 'X', severity: 'WARNING', count: 0, passed: true, message: '' }), 'Clear')
    assert.equal(controlState({ code: 'X', severity: 'WARNING', count: 3, passed: false, message: '' }), 'Open warning')
  })
  it('print layout: A4 landscape with "Page n of m"; header with the disclaimer; controls hidden in print; screens never call the database directly', async () => {
    const ui = await readFile(path.join(root, 'src', 'features', 'accounting', 'gst-close-ui.tsx'), 'utf8')
    assert.match(ui, /@page \{ size: A4 landscape/)
    assert.match(ui, /counter\(page\) " of " counter\(pages\)/)
    assert.match(ui, /data-testid="gst-print-header"/)
    assert.match(ui, /print:hidden/)
    assert.doesNotMatch(ui, /requireSupabase|\.rpc\(|\.from\('/)
    const exp = await readFile(path.join(root, 'src', 'features', 'accounting', 'gst-export.ts'), 'utf8')
    assert.doesNotMatch(exp, /rpc|supabase/i)
  })
})
