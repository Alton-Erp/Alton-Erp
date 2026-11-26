// GST return preparation screens (migration 20261231090700): working-file builders keep calculated and adjusted values apart and label the
// value status (calculated / adjusted / approved / filed); credit notes are signed; exceptions are grouped; ARN normalisation; and the page
// never claims to file returns or talks to the database outside the service.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ARN_PATTERN, VALUE_STATUS_META, exceptionSummary, gstr1Sheets, gstr3bSheets, normaliseArn, type Gstr1, type Gstr3b, type ReturnSection,
} from '../../src/features/accounting/gst-returns-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sec = (taxable: string, igst: string, adj: string | null = null, rows: Record<string, unknown>[] = []): ReturnSection => ({
  calculated: { documents: rows.length || 1, taxable, igst, cgst: '0', sgst: '0', cess: '0' }, adjusted: { taxable: adj ?? taxable, igst, cgst: '0', sgst: '0', cess: '0' },
  adjustments: adj ? [{ id: 'a1', field: 'taxable', tax_head: 'TAXABLE', amount: '500', reason: 'Advance', status: 'APPROVED' }, { id: 'a2', field: 'taxable', tax_head: 'TAXABLE', amount: '7', reason: 'Pending', status: 'DRAFT' }] : [],
  value_status: adj ? 'ADJUSTED' : 'CALCULATED', rows })
const base = {
  period: '2026-10', from: '2026-10-01', to: '2026-10-31', config_version_no: 1, unmatched_adjustments: [], source: 'SNAPSHOT' as const, value_status: 'FILED' as const, period_status: 'APPROVED',
  snapshot: { id: 's1', version_no: 2, snapshot_hash: 'c'.repeat(64), created_at: '2026-11-26', has_return_working: true }, live_differs: false,
  filing: { id: 'f1', return_type: 'GSTR3B' as const, arn: 'AA2710261234567', filed_on: '2026-11-26', note: null, recorded_by_name: 'A', recorded_at: '', note_on_filing: '' },
  exceptions: [{ code: 'MISSING_HSN', severity: 'ERROR' as const, source_kind: 'SALES_INVOICE', source_id: 'x', document_no: 'I-1', document_date: '2026-10-15', message: 'm' },
    { code: 'UNPOSTED_SOURCE', severity: 'WARNING' as const, source_kind: 'SALES_INVOICE', source_id: 'y', document_no: 'I-2', document_date: '2026-10-15', message: 'm' },
    { code: 'MISSING_HSN', severity: 'ERROR' as const, source_kind: 'SALES_INVOICE', source_id: 'z', document_no: 'I-3', document_date: '2026-10-16', message: 'm' }],
  disclaimer: 'This system does not file returns.',
}
const r1: Gstr1 = { ...base, return_type: 'GSTR1', b2cl_invoice_threshold: 100000,
  sections: {
    B2B: sec('1000', '180', null, [{ kind: 'INVOICE', number: 'I-1', date: '2026-10-15', customer: 'C', gstin: '29AABCQ1234A1Z5', place_of_supply: '29', value: '1180', sign: 1,
      taxable: '1000', igst: '180', cgst: '0', sgst: '0', rates: [{ rate: 18, taxable: '1000', igst: '180', cgst: '0', sgst: '0' }] }]),
    CDNR: sec('-100', '-18', null, [{ kind: 'CREDIT_NOTE', number: 'CN-1', date: '2026-10-20', customer: 'C', gstin: '29AABCQ1234A1Z5', place_of_supply: '29', value: '118', sign: -1,
      original_invoice: 'I-1', taxable: '100', igst: '18', cgst: '0', sgst: '0', rates: [{ rate: 18, taxable: '100', igst: '18', cgst: '0', sgst: '0' }] }]),
    B2CS: sec('500', '0', '1000', [{ place_of_supply: '27', supply_type: 'INTRA', rate: 18, taxable: '500', igst: '0', cgst: '45', sgst: '45', cess: '0' }]),
  },
  hsn: [{ hsn_sac: '6910', uqc: 'PCS', rate: 18, b2b: true, quantity: 1, taxable: '900', igst: '162', cgst: '0', sgst: '0', cess: '0' }],
  documents_issued: [{ nature: 'Invoices for outward supply', series: 'S', from: 'I-1', to: 'I-7', total: 7, cancelled: 1, net_issued: 6 }],
  excluded: { draft_or_pending: 2, cancelled: 1, proforma: 0 } }

describe('GST return working files', () => {
  it('GSTR-1: header states the value status, snapshot and filing record; the summary has calculated and adjusted columns', () => {
    const sheets = gstr1Sheets(r1, { company: 'Alton Hi-Tech', gstin: '27AABCA1234A1Z5', financial_year: '2026-27', generated_at: '2026-11-26 10:00' })
    assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'B2B', 'B2CS', 'CDNR', 'HSN', 'Documents', 'Exceptions'])
    const summary = sheets[0].rows
    assert.equal(summary[1][0], 'Alton Hi-Tech · GSTIN 27AABCA1234A1Z5')
    assert.match(String(summary[2][0]), /Financial year 2026-27 · Tax period 2026-10/)
    assert.match(String(summary[3][0]), /Generated 2026-11-26 10:00 · Configuration version 1/)
    assert.match(String(summary[4][0]), /Filed \(recorded\)/)
    assert.match(String(summary[5][0]), /Snapshot v2/)
    assert.match(String(summary[6][0]), /ARN AA2710261234567/)
    assert.equal(summary[7][0], 'Prepared by Alton ERP for review and working purposes. This document is not proof of filing with the GST Portal. The taxpayer must independently verify and file the return on the official GST Portal.')
    const b2cs = summary.find((r) => r[0] === 'B2CS')!
    assert.equal(b2cs[2], 'Manually adjusted')
    assert.equal(b2cs[3], 500) // calculated taxable
    assert.equal(b2cs[8], 1000) // adjusted taxable
    assert.equal(b2cs[13], '1 / 1') // approved / pending adjustments
    assert.ok(summary.some((r) => String(r[0]).startsWith('Excluded: 2 draft / pending, 1 cancelled')))
  })
  it('GSTR-1: credit notes are negative in their sheet; rate-wise rows per document; B2CS aggregated', () => {
    const sheets = gstr1Sheets(r1)
    const cdnr = sheets.find((s) => s.name === 'CDNR')!.rows
    assert.deepEqual(cdnr[1].slice(-6), [18, -100, -18, -0, -0, 0])
    assert.equal(cdnr[1][7], 'I-1')
    assert.deepEqual(sheets.find((s) => s.name === 'B2CS')!.rows[1], ['27', 'INTRA', 18, 500, 0, 45, 45, 0])
    assert.deepEqual(sheets.find((s) => s.name === 'Documents')!.rows[1], ['Invoices for outward supply', 'S', 'I-1', 'I-7', 7, 1, 6])
  })
  it('GSTR-3B: summary, 3.2, 6.1, historical / current credit and ITC evidence sheets', () => {
    const r3: Gstr3b = { ...base, value_status: 'APPROVED', filing: null, return_type: 'GSTR3B', sections: { '3.1(a)': sec('201500', '36180', '202000'), '4(A)(5)': sec('0', '90') },
      net_itc: { igst: '90', cgst: '0', sgst: '0', cess: '0' }, '3.2_inter_state_unregistered': [{ place_of_supply: '29', taxable: '200000', igst: '36000' }],
      '6.1': [{ head: 'IGST', payable_per_return: '36180', liability_per_ledger: '200', paid_through_itc: { IGST: '150' }, paid_in_cash: '0', interest: '0', late_fee: '0', open_after_set_off: '50' }],
      credit: { IGST: { accrued_to_period_end: '500', used_to_period: '150', used_in_posted_set_offs: '510', available_at_period_end: '350', cumulative_headroom: '350', ledger_balance: '440',
        current_available: '440', available: '350' } },
      itc_evidence: { note: 'evidence only', by_gstr2b_status: { APPROVED: { decisions: 1, itc: '180' } }, events: [] } }
    const sheets = gstr3bSheets(r3)
    assert.deepEqual(sheets.map((s) => s.name), ['Summary', '3.2 Inter-state', '6.1 Payment', 'Credit', 'ITC evidence', 'Exceptions'])
    assert.match(String(sheets[0].rows[4][0]), /Approved \(snapshot\)/)
    assert.match(String(sheets[0].rows[6][0]), /No filing recorded/)
    assert.deepEqual(sheets[0].rows.find((r) => r[0] === '3.1(a)')!.slice(2, 4), ['Manually adjusted', 201500])
    assert.deepEqual(sheets[3].rows[1], ['IGST', 500, 150, 350, 350, 440, 350])
    assert.deepEqual(sheets[2].rows[1].slice(0, 4), ['IGST', 36180, 200, 150])
    assert.equal(sheets[4].rows[0][0], 'evidence only')
  })
  it('value statuses are explicit; exceptions grouped errors first; ARN normalised and checked', () => {
    assert.deepEqual(Object.keys(VALUE_STATUS_META), ['CALCULATED', 'ADJUSTED', 'APPROVED', 'FILED'])
    assert.match(VALUE_STATUS_META.FILED.description, /does not file returns/)
    assert.deepEqual(exceptionSummary(base.exceptions), [{ code: 'MISSING_HSN', severity: 'ERROR', count: 2 }, { code: 'UNPOSTED_SOURCE', severity: 'WARNING', count: 1 }])
    assert.equal(normaliseArn(' aa2710261234567 '), 'AA2710261234567')
    assert.ok(ARN_PATTERN.test('AA2710261234567'))
    assert.ok(!ARN_PATTERN.test('AA27102612345'))
  })
})

describe('GST returns page', () => {
  it('reads through the service only, never claims to file, and records filings only as a manual record', async () => {
    const page = await readFile(path.join(root, 'src', 'pages', 'accounts', 'gst-return-prep-page.tsx'), 'utf8')
    assert.doesNotMatch(page, /requireSupabase|\.rpc\(|\.from\('/)
    assert.match(page, /does not file returns and has no GSTN or portal connection/)
    assert.match(page, /After you file this return on the GST portal, record the ARN here/)
    assert.doesNotMatch(page, /submit to (the )?portal|file (the )?return now|upload to gstn/i)
  })
})
