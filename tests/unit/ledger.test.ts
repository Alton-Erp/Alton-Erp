// Stage 2 (V2): unified ledger form rules, summary and export. No database;
// the same rules are enforced by public.party_save (supabase/tests/ledger_verification.sql).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY_PARTY, LEDGER_EXPORT_COLUMNS, balanceLabel, ledgerExportRows, ledgerSummary, partyToForm, validateParty, type PartyRow,
} from '../../src/features/ledger/ledger-model.ts'

const base = { ...EMPTY_PARTY, party_type: 'SUPPLIER' as const, party_name: '  Morbi   Glaze Works ' }

describe('party validation', () => {
  it('needs only a type and a name', () => {
    const r = validateParty(base)
    assert.deepEqual(r.errors, {})
    assert.equal(r.payload?.party_name, 'Morbi Glaze Works')
    assert.equal(r.payload?.country, 'India')
    assert.ok(validateParty({ ...base, party_type: '' }).errors.party_type)
    assert.ok(validateParty({ ...base, party_name: ' ' }).errors.party_name)
  })

  it('takes PAN and state from the GSTIN and checks they agree', () => {
    const r = validateParty({ ...base, gstin: '24abcde1234f1z5' })
    assert.equal(r.payload?.gstin, '24ABCDE1234F1Z5')
    assert.equal(r.payload?.pan, 'ABCDE1234F')
    assert.equal(r.payload?.state_code, '24')
    assert.ok(validateParty({ ...base, gstin: '24ABCDE1234F1Z5', pan: 'ZZZZZ9999Z' }).errors.pan)
    assert.ok(validateParty({ ...base, gstin: '24ABC' }).errors.gstin)
    assert.ok(validateParty({ ...base, gstin: '24ABCDE1234F1Z5', state_code: '27' }).warnings.some((w) => w.includes('differs')))
  })

  it('checks mobile, e-mail, PIN, credit period and bank details', () => {
    assert.ok(validateParty({ ...base, phone: '12' }).errors.phone)
    assert.equal(validateParty({ ...base, phone: '+91 98250-22222' }).errors.phone, undefined)
    assert.ok(validateParty({ ...base, email: 'nope' }).errors.email)
    assert.ok(validateParty({ ...base, pin_code: '012345' }).errors.pin_code)
    assert.equal(validateParty({ ...base, pin_code: 'SW1A 1AA', country: 'United Kingdom' }).errors.pin_code, undefined)
    assert.ok(validateParty({ ...base, credit_period_days: '400' }).errors.credit_period_days)
    assert.ok(validateParty({ ...base, bank_ifsc: 'HDFC1234567' }).errors.bank_ifsc)
    const ok = validateParty({ ...base, bank_ifsc: 'hdfc0001234', bank_account_number: '5010 0123 4567' })
    assert.equal(ok.payload?.bank_ifsc, 'HDFC0001234')
    assert.equal(ok.payload?.bank_account_number, '501001234567')
  })

  it('defaults the opening balance type for a customer or supplier, but asks for a Both party', () => {
    assert.equal(validateParty({ ...base, opening_balance: '2,500' }).payload?.opening_balance_type, 'PAYABLE')
    assert.equal(validateParty({ ...base, party_type: 'CUSTOMER', opening_balance: '100' }).payload?.opening_balance_type, 'RECEIVABLE')
    assert.ok(validateParty({ ...base, party_type: 'BOTH', opening_balance: '100' }).errors.opening_balance_type)
    assert.equal(validateParty({ ...base, opening_balance: '0' }).payload?.opening_balance_type, null)
    assert.ok(validateParty({ ...base, opening_balance: '-5' }).errors.opening_balance)
    assert.ok(validateParty({ ...base, party_type: 'SUPPLIER', opening_balance: '10', opening_balance_type: 'RECEIVABLE' }).warnings.some((w) => w.includes('receivable')))
  })

  it('recommends contact details and a state without blocking', () => {
    const r = validateParty(base)
    assert.ok(r.payload)
    assert.ok(r.warnings.some((w) => w.includes('mobile number or e-mail')))
    assert.ok(r.warnings.some((w) => w.includes('No state')))
    assert.ok(r.warnings.some((w) => w.includes('No GSTIN')))
  })
})

const row = (o: Partial<PartyRow>): PartyRow => ({
  party_id: 'p', party_code: 'PTY-000001', party_type: 'CUSTOMER', party_name: 'A', legal_name: null, status: 'ACTIVE', customer_id: 'c', customer_code: 'CUS-000001',
  customer_status: 'ACTIVE', supplier_id: null, supplier_code: null, supplier_status: null, supplier_category: null, gstin: null, pan: null,
  gst_registration_type: null, contact_person: null, phone: null, email: null, billing_address: null, shipping_address: null, city: null, state_code: null,
  state_name: null, shipping_state_code: null, pin_code: null, country: 'India', credit_period_days: null, payment_terms: null, payment_terms_note: null,
  opening_balance: 0, opening_balance_type: null, opening_balance_date: null, bank_name: null, bank_account_name: null, bank_account_number: null,
  bank_ifsc: null, remarks: null, receivable: 0, payable: 0, net_balance: 0, overdue: 0, last_activity: null, created_at: '', updated_at: '', ...o,
})

describe('ledger list helpers', () => {
  it('summarises parties by type and totals outstanding balances', () => {
    const s = ledgerSummary([
      row({ party_type: 'CUSTOMER', receivable: 700, overdue: 200 }),
      row({ party_type: 'SUPPLIER', payable: 756 }),
      row({ party_type: 'BOTH', receivable: 100, payable: 50 }),
      row({ party_type: 'CUSTOMER', status: 'INACTIVE', receivable: -20 }),
    ])
    assert.deepEqual(s, { customers: 1, suppliers: 1, both: 1, receivable: 800, payable: 806, withBalance: 4, overdue: 200, inactive: 1 })
  })

  it('describes a net balance', () => {
    assert.equal(balanceLabel(50), 'They owe us')
    assert.equal(balanceLabel(-50), 'We owe them')
    assert.equal(balanceLabel(0.001), 'Settled')
  })

  it('round-trips a stored party into the form (legal name only when different)', () => {
    const f = partyToForm(row({ party_type: 'BOTH', party_name: 'Aqua', legal_name: 'Aqua', opening_balance: 1000, opening_balance_type: 'RECEIVABLE', credit_period_days: 20 }))
    assert.equal(f.legal_name, '')
    assert.equal(f.opening_balance, '1000')
    assert.equal(f.credit_period_days, '20')
    assert.deepEqual(validateParty(f).errors, {})
  })

  it('exports one row per party in the documented column order', () => {
    const out = ledgerExportRows([row({ party_name: 'Shree', receivable: 700, opening_balance: 1000, opening_balance_type: 'RECEIVABLE' })])
    assert.deepEqual(out[0], [...LEDGER_EXPORT_COLUMNS])
    assert.equal(out.length, 2)
    assert.equal(out[1][1], 'Shree')
    assert.equal(out[1][2], 'Customer')
    assert.equal(out[1][LEDGER_EXPORT_COLUMNS.indexOf('Receivable')], 700)
    assert.equal(out[1][LEDGER_EXPORT_COLUMNS.indexOf('Opening Balance Type')], 'Receivable')
  })
})
