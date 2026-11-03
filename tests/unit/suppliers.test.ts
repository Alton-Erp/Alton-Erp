import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  emptySupplierForm,
  findPossibleDuplicates,
  isValidPhone,
  normaliseSupplierName,
  paymentTermsLabel,
  toSupplierPayload,
  validateSupplierForm,
  type DuplicateCandidate,
  type SupplierFormValues,
} from '../../src/features/suppliers/supplier-model.ts'

const form = (over: Partial<SupplierFormValues> = {}): SupplierFormValues => ({ ...emptySupplierForm(), legal_name: 'Shree Clay Works Pvt Ltd', ...over })

describe('supplier form validation', () => {
  it('needs only a legal name (GSTIN, PAN and contact details are optional)', () => {
    assert.deepEqual(validateSupplierForm(form(), true).errors, {})
    assert.ok(validateSupplierForm(form({ legal_name: '   ' }), true).errors.legal_name)
  })

  it('validates GSTIN and PAN formats and that they match', () => {
    assert.deepEqual(validateSupplierForm(form({ gstin: '27aapfu0939f1zv', pan: 'aapfu0939f', state_code: '27' }), true).errors, {})
    assert.ok(validateSupplierForm(form({ gstin: '27AAPFU0939F1Z' }), true).errors.gstin)
    assert.ok(validateSupplierForm(form({ pan: 'ABCDE12345' }), true).errors.pan)
    assert.match(validateSupplierForm(form({ gstin: '27AAPFU0939F1ZV', pan: 'ZZZZZ9999Z' }), true).errors.pan ?? '', /does not match/)
  })

  it('warns (without blocking) when the GSTIN state differs from the selected state', () => {
    const r = validateSupplierForm(form({ gstin: '27AAPFU0939F1ZV', state_code: '24' }), true)
    assert.deepEqual(r.errors, {})
    assert.equal(r.warnings.length, 1)
  })

  it('validates e-mail, phone and Indian PIN code; foreign postcodes are allowed abroad', () => {
    assert.ok(validateSupplierForm(form({ email: 'sales@' }), true).errors.email)
    assert.ok(validateSupplierForm(form({ phone: '12ab' }), true).errors.phone)
    assert.ok(validateSupplierForm(form({ pin_code: '012345' }), true).errors.pin_code)
    assert.equal(validateSupplierForm(form({ pin_code: '411 001' }), true).errors.pin_code, undefined)
    assert.equal(validateSupplierForm(form({ country: 'Germany', pin_code: '10115' }), true).errors.pin_code, undefined)
    assert.ok(isValidPhone('+91 98200 12345') && isValidPhone('020-2612 3456') && !isValidPhone('12345'))
  })

  it('requires 1–365 days for custom payment terms', () => {
    assert.ok(validateSupplierForm(form({ payment_terms: 'CUSTOM' }), true).errors.custom_payment_days)
    assert.ok(validateSupplierForm(form({ payment_terms: 'CUSTOM', custom_payment_days: '400' }), true).errors.custom_payment_days)
    assert.equal(validateSupplierForm(form({ payment_terms: 'CUSTOM', custom_payment_days: '60' }), true).errors.custom_payment_days, undefined)
    assert.equal(paymentTermsLabel('CUSTOM', 60), '60 Days (custom)')
    assert.equal(paymentTermsLabel('DAYS_15', null), '15 Days')
  })

  it('checks the code only for new suppliers', () => {
    assert.ok(validateSupplierForm(form({ supplier_code: 'BAD CODE' }), true).errors.supplier_code)
    assert.equal(validateSupplierForm(form({ supplier_code: 'BAD CODE' }), false).errors.supplier_code, undefined)
  })
})

describe('supplier payload', () => {
  it('trims, upper-cases tax ids, blanks become null and custom days only for CUSTOM', () => {
    const p = toSupplierPayload(form({ supplier_code: '', gstin: ' 27aapfu0939f1zv ', email: ' Sales@X.Example ', pin_code: '411 001', custom_payment_days: '30' }))
    assert.equal(p.supplier_code, null)
    assert.equal(p.gstin, '27AAPFU0939F1ZV')
    assert.equal(p.email, 'sales@x.example')
    assert.equal(p.pin_code, '411001')
    assert.equal(p.contact_person, null)
    assert.equal(p.custom_payment_days, null)
    assert.equal(toSupplierPayload(form({ payment_terms: 'CUSTOM', custom_payment_days: '60' })).custom_payment_days, 60)
  })
})

describe('duplicate detection', () => {
  const existing: DuplicateCandidate[] = [
    { id: 's1', supplier_code: 'SUP-000001', legal_name: 'Shree Clay Works Private Limited', display_name: null, gstin: '27AAPFU0939F1ZV', pan: null, phone: '+91 98200 12345', email: 'sales@shreeclay.example', status: 'ACTIVE' },
    { id: 's2', supplier_code: 'PACK-01', legal_name: 'Box & Carton Co.', display_name: 'BoxCo', gstin: null, pan: null, phone: null, email: null, status: 'INACTIVE' },
  ]

  it('normalises legal suffixes and punctuation', () => {
    assert.equal(normaliseSupplierName('M/s. Shree Clay Works Pvt. Ltd.'), 'shree clay works')
    assert.equal(normaliseSupplierName('Shree Clay Works Private Limited'), 'shree clay works')
  })

  it('blocks the same GSTIN or code; asks to confirm the same name, PAN, phone or e-mail', () => {
    assert.deepEqual(findPossibleDuplicates(form({ legal_name: 'Other', gstin: '27AAPFU0939F1ZV' }), existing).map((d) => [d.supplier.id, d.blocking]), [['s1', true]])
    assert.deepEqual(findPossibleDuplicates(form({ legal_name: 'Other', supplier_code: 'pack-01' }), existing).map((d) => [d.supplier.id, d.blocking]), [['s2', true]])
    assert.deepEqual(findPossibleDuplicates(form({ legal_name: 'M/s Shree Clay Works Pvt Ltd' }), existing).map((d) => [d.supplier.id, d.blocking, d.reason]), [['s1', false, 'same name']])
    assert.equal(findPossibleDuplicates(form({ legal_name: 'Another', gstin: '24AAPFU0939F1ZX' }), existing)[0]?.reason.startsWith('same PAN'), true)
    assert.equal(findPossibleDuplicates(form({ legal_name: 'Another', phone: '9820012345' }), existing)[0]?.reason, 'same phone number')
    assert.equal(findPossibleDuplicates(form({ legal_name: 'Box and Carton Company' }), existing)[0]?.supplier.id, 's2')
    assert.deepEqual(findPossibleDuplicates(form({ legal_name: 'Completely New Supplier' }), existing), [])
  })

  it('ignores the record being edited', () => {
    assert.deepEqual(findPossibleDuplicates(form({ supplier_code: 'SUP-000001', gstin: '27AAPFU0939F1ZV' }), existing, 's1'), [])
  })
})
