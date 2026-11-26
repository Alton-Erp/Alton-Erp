// Alton Accounts Phase 3 (migration 20261231090300): supplier invoice model — the live GST / totals preview (same rounding
// as private.pi_recalculate), form validation, the save payload, workflow actions, and navigation / permission wiring.
// The database behaviour (matching, posting, GST verification, payments, concurrency) is tested by tests/db/accounting-foundation-check.mjs.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { PERMISSIONS } from '../../src/auth/permissions.ts'
import { NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'
import {
  GST_RATES, effectiveTreatment, emptyPiForm, isValidGstin, lineGrossPaise, lineTaxesPaise, linesFromCandidates, newPiLine, piActions, piPayload, previewPi, validatePiForm,
  type MatchingCandidate, type PiForm,
} from '../../src/features/accounting/purchase-invoice-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const form = (patch: Partial<PiForm> = {}): PiForm => ({ ...emptyPiForm('2026-11-25'), supplier_id: 's1', supplier_invoice_number: 'INV-1', place_of_supply_state_code: '27', ...patch })
const direct = (price: string, rate = '18', patch = {}) => newPiLine('DIRECT', { account_id: 'acc', unit_price: price, gst_rate: rate, ...patch })

describe('supplier invoice GST preview (paise, rounded like the database)', () => {
  it('CGST = SGST = round(taxable × rate / 200, 2) intra-state; IGST = round(taxable × rate / 100, 2) inter-state', () => {
    assert.deepEqual(lineTaxesPaise(42000, 18, 'TAXABLE', 'INTRA_STATE'), { cgst: 3780, sgst: 3780, igst: 0, cess: 0 })
    assert.deepEqual(lineTaxesPaise(100000, 18, 'TAXABLE', 'INTER_STATE'), { cgst: 0, sgst: 0, igst: 18000, cess: 0 })
    // 0.05 × 5% / 2 = 0.00125 → 0.00; 0.33 × 5% / 2 = 0.00825 → 0.01 (half away from zero, as numeric round)
    assert.equal(lineTaxesPaise(5, 5, 'TAXABLE', 'INTRA_STATE').cgst, 0)
    assert.equal(lineTaxesPaise(33, 5, 'TAXABLE', 'INTRA_STATE').cgst, 1)
    assert.equal(lineTaxesPaise(100, 0.25, 'TAXABLE', 'INTER_STATE').igst, 0)
    assert.deepEqual(lineTaxesPaise(100000, 18, 'EXEMPT', 'INTRA_STATE'), { cgst: 0, sgst: 0, igst: 0, cess: 0 })
  })
  it('line value = round(quantity × price, 2) with 3-decimal quantities', () => {
    assert.equal(lineGrossPaise('4', '105'), 42000)
    assert.equal(lineGrossPaise('1.333', '10.01'), 1334) // 13.34333 → 13.34
    assert.equal(lineGrossPaise('0.5', '0.01'), 1) // 0.005 → 0.01
  })
  it('treatment: automatic from the company and place-of-supply states, or as chosen', () => {
    assert.equal(effectiveTreatment({ tax_treatment: '', place_of_supply_state_code: '29' }, '27'), 'INTER_STATE')
    assert.equal(effectiveTreatment({ tax_treatment: '', place_of_supply_state_code: '27' }, '27'), 'INTRA_STATE')
    assert.equal(effectiveTreatment({ tax_treatment: 'INTRA_STATE', place_of_supply_state_code: '29' }, '27'), 'INTRA_STATE')
    assert.equal(effectiveTreatment({ tax_treatment: '', place_of_supply_state_code: '' }, '27'), 'INTRA_STATE')
  })
  it('totals: the variance invoice of the database test (1,420 + 97.80 + 97.80 = 1,615.60)', () => {
    const f = form({ lines: [newPiLine('GRN', { goods_receipt_line_id: 'g1', quantity: '4', unit_price: '105', gst_rate: '18' }),
      newPiLine('GRN', { goods_receipt_line_id: 'g2', quantity: '4', unit_price: '250', gst_rate: '12' })] })
    const p = previewPi(f, '27')
    assert.equal(p.totals.taxable, 142000)
    assert.equal(p.totals.cgst, 9780)
    assert.equal(p.totals.grandTotal, 161560)
  })
  it('reverse charge: GST computed but not part of the supplier total; round-off and discount apply', () => {
    const p = previewPi(form({ reverse_charge: true, lines: [direct('1000', '5')] }), '27')
    assert.equal(p.totals.tax, 5000)
    assert.equal(p.totals.grandTotal, 100000)
    const q = previewPi(form({ round_off: '-0.40', lines: [direct('1000.40', '0', { discount: '0.00' })] }), '27')
    assert.equal(q.totals.grandTotal, 100000)
    const d = previewPi(form({ lines: [direct('100', '18', { quantity: '2', discount: '20' })] }), '27')
    assert.equal(d.lines[0].taxable, 18000)
    assert.equal(d.totals.gross, 20000)
  })
})

describe('supplier invoice form validation', () => {
  const accounts = [{ id: 'acc', cost_centre_policy: 'OPTIONAL' as const }, { id: 'power', cost_centre_policy: 'REQUIRED' as const }, { id: 'na', cost_centre_policy: 'NOT_APPLICABLE' as const }]
  const check = (f: PiForm, submit = true) => validatePiForm(f, previewPi(f, '27'), accounts, submit)
  it('a correct direct invoice passes; submit needs the supplier total to match', () => {
    const f = form({ supplier_stated_total: '1180.00', lines: [direct('1000')] })
    assert.deepEqual(check(f), { errors: [], lineErrors: {} })
    assert.match(check({ ...f, supplier_stated_total: '1181' }).errors.join(' '), /differs from the calculated total \(1180\.00\)/)
    assert.match(check({ ...f, supplier_stated_total: '' }).errors.join(' '), /total printed on the supplier invoice/)
    assert.deepEqual(check({ ...f, supplier_stated_total: '' }, false).errors, [], 'a draft may be incomplete')
  })
  it('header rules: supplier, number, GSTIN, dates, place of supply, round-off', () => {
    const r = check(form({ supplier_id: '', supplier_invoice_number: ' ', supplier_gstin: '27ABC', recorded_date: '2026-11-01', round_off: '1.50',
      place_of_supply_state_code: '2', lines: [direct('10', '0')], supplier_stated_total: '10' }), false)
    for (const m of [/supplier\./, /invoice number/, /not a valid GSTIN/, /recording date/, /round-off/, /2-digit state code/]) assert.match(r.errors.join(' '), m)
    assert.ok(isValidGstin('27aabcp1234a1z5'))
    assert.ok(!isValidGstin('27AABCP1234A1Z'))
  })
  it('line rules: rate, quantity, decimals, exempt supplies, discounts, receipt quantity, cost-centre rules', () => {
    const lines = [direct('10', '17'), direct('10', '18', { quantity: '0' }), direct('10.005'), newPiLine('DIRECT', { unit_price: '5' }),
      direct('10', '18', { discount: '11' }), newPiLine('GRN', { goods_receipt_line_id: 'g', quantity: '5', unit_price: '1', gst_rate: '18',
        grn: { receipt_number: 'GRN-1', receipt_date: '2026-11-01', description: null, remaining: 4, unit_cost: 1, gst_rate: 18, in_books: true } }),
      direct('100', '0', { account_id: 'power' }), direct('100', '0', { account_id: 'power', allocations: [{ key: 'a', cost_centre_id: 'cc', amount: '90' }] }),
      direct('100', '0', { account_id: 'na', allocations: [{ key: 'b', cost_centre_id: 'cc', amount: '100' }] })]
    const f = form({ lines })
    const e = check(f).lineErrors
    const at = (i: number) => e[lines[i].key] ?? ''
    assert.match(at(0), /17% is not a GST rate/)
    assert.match(at(1), /quantity must be more than 0/)
    assert.match(at(2), /at most 2 decimals/)
    assert.match(at(3), /select a ledger account/)
    assert.match(at(4), /discount is larger/)
    assert.match(at(5), /only 4 of GRN-1 remains/)
    assert.match(at(6), /needs a cost-centre split/)
    assert.match(at(7), /must equal the taxable value/)
    assert.match(at(8), /does not take cost centres/)
    assert.equal(check(form({ lines: [direct('100', '0', { account_id: 'power' })] }), false).lineErrors[lines[6].key], undefined, 'the split is needed for submitting, not a draft')
    assert.match(Object.values(check(form({ supply_category: 'NIL_RATED', lines: [direct('10', '5')] })).lineErrors).join(' '), /Nil-rated supplies carry no GST/)
    assert.ok((GST_RATES as readonly number[]).includes(7.5) && !(GST_RATES as readonly number[]).includes(17))
  })
  it('reverse charge cannot be matched to receipts', () => {
    assert.match(check(form({ reverse_charge: true, lines: [newPiLine('GRN', { goods_receipt_line_id: 'g', unit_price: '1' })] }), false).errors.join(' '), /Reverse-charge/)
  })
})

describe('supplier invoice payload and lines from receipts', () => {
  it('sends strings and nulls the database expects; receipt lines carry no account and no split', () => {
    const f = form({ supplier_gstin: '27aabcp1234a1z5', due_date: '', narration: ' ', supplier_stated_total: '1180.00',
      lines: [direct('1000', '18', { allocations: [{ key: 'a', cost_centre_id: 'cc1', amount: '600.00' }, { key: 'b', cost_centre_id: '', amount: '' }] }),
        newPiLine('GRN', { goods_receipt_line_id: 'gl', quantity: '2', unit_price: '50', gst_rate: '5' })] })
    const p = piPayload(f) as Record<string, unknown> & { lines: Record<string, unknown>[] }
    assert.equal(p.supplier_gstin, '27AABCP1234A1Z5')
    assert.equal(p.due_date, null)
    assert.equal(p.narration, null)
    assert.equal(p.tax_treatment, null)
    assert.equal(p.round_off, '0')
    assert.deepEqual(p.lines[0], { kind: 'DIRECT', account_id: 'acc', description: null, quantity: '1', unit_price: '1000', discount: '0', gst_rate: '18', cess: '0',
      allocations: [{ cost_centre_id: 'cc1', amount: '600.00' }] })
    assert.deepEqual(p.lines[1], { kind: 'GRN', goods_receipt_line_id: 'gl', description: null, quantity: '2', unit_price: '50', discount: '0', gst_rate: '5', cess: '0' })
  })
  it('matching candidates become lines at the uninvoiced quantity, receipt cost and rate', () => {
    const c = { line_id: 'l1', receipt_number: 'GRN-9', receipt_date: '2026-11-20', description: 'Valve', remaining_quantity: '3.000', unit_cost: '250.0000', gst_rate: '12.00',
      in_books: true } as unknown as MatchingCandidate
    const [l] = linesFromCandidates([c])
    assert.equal(l.kind, 'GRN')
    assert.equal(l.goods_receipt_line_id, 'l1')
    assert.equal(l.quantity, '3')
    assert.equal(l.unit_price, '250')
    assert.equal(l.gst_rate, '12')
    assert.equal(l.grn?.remaining, 3)
  })
})

describe('supplier invoice workflow actions and wiring', () => {
  const all = () => true
  it('actions follow the status and permissions', () => {
    const a = piActions({ status: 'SUBMITTED', gst_status: 'PENDING_VERIFICATION', variance_status: 'EXCEPTION' }, (c) => c === 'purchase_invoices.create')
    assert.equal(a.approve, false)
    assert.equal(a.returnToDraft, true)
    assert.equal(a.cancel, true)
    assert.equal(a.needsVarianceAcceptance, true)
    const p = piActions({ status: 'POSTED', gst_status: 'PENDING_VERIFICATION', variance_status: 'NONE' }, all)
    assert.deepEqual([p.edit, p.cancel, p.post, p.verifyGst, p.reverse, p.allocate], [false, false, false, true, true, true])
    assert.equal(piActions({ status: 'POSTED', gst_status: 'ELIGIBLE', variance_status: 'NONE' }, all).verifyGst, false)
    assert.equal(piActions({ status: 'APPROVED', gst_status: 'NOT_APPLICABLE', variance_status: 'NONE' }, (c) => c === 'purchase_invoices.read').post, false)
  })
  it('the six permission codes match the migration; screens are under /purchases/invoices and need purchase_invoices.read', async () => {
    const sql = await readFile(path.join(root, 'supabase', 'migrations', '20261231090300_accounting_purchase_invoices.sql'), 'utf8')
    for (const action of ['read', 'create', 'approve', 'post', 'reverse', 'verify_gst']) {
      assert.ok((PERMISSIONS as readonly string[]).includes(`purchase_invoices.${action}`))
      assert.match(sql, new RegExp(`\\('purchase_invoices',\\s*'${action}',`))
    }
    const items = NAV_ITEMS.filter((i) => i.key.startsWith('purchase-invoice'))
    assert.equal(items.length, 3)
    for (const i of items) {
      assert.equal(i.group, 'purchase')
      assert.match(i.path, /^\/purchases\/invoices(\/|$)/)
      assert.equal(NAV_PERMISSIONS[i.key], 'purchase_invoices.read')
    }
    const routes = await readFile(path.join(root, 'src', 'routes.ts'), 'utf8')
    for (const r of ["'/purchases/invoices/new', permission: 'purchase_invoices.create'", "'/purchases/invoices/:invoiceId', permission: 'purchase_invoices.read'",
      "'/purchases/invoices/:invoiceId/edit', permission: 'purchase_invoices.create'"]) assert.ok(routes.includes(r), r)
  })
  it('attachments: PURCHASE_INVOICE is a documents entity in the frontend and the database', async () => {
    const admin = await readFile(path.join(root, 'src', 'services', 'admin.ts'), 'utf8')
    const sql = await readFile(path.join(root, 'supabase', 'migrations', '20261231090300_accounting_purchase_invoices.sql'), 'utf8')
    assert.match(admin, /'PURCHASE_INVOICE'/)
    assert.match(sql, /when 'PURCHASE_INVOICE' then 'purchase_invoices\.read'/)
  })
})
