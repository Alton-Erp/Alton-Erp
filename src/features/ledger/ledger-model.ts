// Unified ledger (party master) model. Pure TypeScript (no React, no path
// aliases) so it can be unit-tested with Node. The database (party_save)
// enforces the same rules; this gives immediate field-level feedback.

export const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'] as const
export type PartyType = (typeof PARTY_TYPES)[number]
export const PARTY_TYPE_LABELS: Record<PartyType, string> = { CUSTOMER: 'Customer', SUPPLIER: 'Supplier', BOTH: 'Customer & Supplier' }

export type BalanceType = 'RECEIVABLE' | 'PAYABLE'
export const BALANCE_TYPE_LABELS: Record<BalanceType, string> = { RECEIVABLE: 'Receivable (they owe us)', PAYABLE: 'Payable (we owe them)' }

export const SUPPLIER_CATEGORIES = ['RAW_MATERIAL', 'FINISHED_GOODS', 'PACKAGING', 'MACHINERY', 'SERVICES', 'OTHER'] as const
export const SUPPLIER_CATEGORY_LABELS: Record<(typeof SUPPLIER_CATEGORIES)[number], string> = {
  RAW_MATERIAL: 'Raw material', FINISHED_GOODS: 'Finished goods', PACKAGING: 'Packaging', MACHINERY: 'Machinery', SERVICES: 'Services', OTHER: 'Other',
}

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', CASH: 'Cash', CARD: 'Card', DEMAND_DRAFT: 'Demand draft', OTHER: 'Other',
}

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
export const PHONE_RE = /^\+?[0-9][0-9 -]{5,18}[0-9]$/
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

/** Form values (strings so partial input is kept). */
export interface PartyFormValues {
  party_type: PartyType | ''
  party_name: string
  legal_name: string
  gstin: string
  pan: string
  contact_person: string
  phone: string
  email: string
  billing_address: string
  shipping_address: string
  city: string
  state_code: string
  pin_code: string
  country: string
  credit_period_days: string
  payment_terms_note: string
  supplier_category: string
  opening_balance: string
  opening_balance_type: BalanceType | ''
  opening_balance_date: string
  bank_name: string
  bank_account_name: string
  bank_account_number: string
  bank_ifsc: string
  remarks: string
  status: 'ACTIVE' | 'INACTIVE'
}

export const EMPTY_PARTY: PartyFormValues = {
  party_type: '', party_name: '', legal_name: '', gstin: '', pan: '', contact_person: '', phone: '', email: '',
  billing_address: '', shipping_address: '', city: '', state_code: '', pin_code: '', country: 'India',
  credit_period_days: '', payment_terms_note: '', supplier_category: '', opening_balance: '', opening_balance_type: '', opening_balance_date: '',
  bank_name: '', bank_account_name: '', bank_account_number: '', bank_ifsc: '', remarks: '', status: 'ACTIVE',
}

export type PartyField = keyof PartyFormValues

/** Payload for public.party_save. */
export type PartyPayload = Record<string, string | number | null>

export interface PartyValidation {
  errors: Partial<Record<PartyField, string>>
  warnings: string[]
  payload: PartyPayload | null
}

const t = (v: string) => (v.trim() === '' ? null : v.trim())

export function validateParty(v: PartyFormValues): PartyValidation {
  const errors: PartyValidation['errors'] = {}
  const warnings: string[] = []

  if (!v.party_type) errors.party_type = 'Choose Customer, Supplier or Both.'
  const name = v.party_name.trim().replace(/\s+/g, ' ')
  if (!name) errors.party_name = 'Enter the party name.'
  else if (name.length > 200) errors.party_name = 'Keep the name under 200 characters.'

  const gstin = v.gstin.trim().toUpperCase()
  let pan = v.pan.trim().toUpperCase()
  if (gstin && !GSTIN_RE.test(gstin)) errors.gstin = 'GSTIN must be 15 characters: state code, PAN, entity number, Z and a check character.'
  if (pan && !PAN_RE.test(pan)) errors.pan = 'PAN must be 5 letters, 4 digits and 1 letter.'
  if (gstin && pan && GSTIN_RE.test(gstin) && PAN_RE.test(pan) && gstin.slice(2, 12) !== pan) errors.pan = 'The PAN does not match the GSTIN (characters 3 to 12).'
  if (gstin && !pan && GSTIN_RE.test(gstin)) pan = gstin.slice(2, 12)

  let state = v.state_code.trim()
  if (gstin && GSTIN_RE.test(gstin)) {
    if (!state) state = gstin.slice(0, 2)
    else if (state !== gstin.slice(0, 2)) warnings.push(`The state (${state}) differs from the GSTIN's state code (${gstin.slice(0, 2)}). GST on invoices and purchase orders follows the state.`)
  }

  const phone = v.phone.trim()
  if (phone && !(PHONE_RE.test(phone) && phone.replace(/\D/g, '').length >= 7 && phone.replace(/\D/g, '').length <= 15)) {
    errors.phone = 'Enter 7 to 15 digits (spaces, dashes and a leading + are allowed).'
  }
  const email = v.email.trim().toLowerCase()
  if (email && !EMAIL_RE.test(email)) errors.email = 'Enter a valid e-mail address.'
  const country = v.country.trim() || 'India'
  const pin = v.pin_code.trim()
  if (pin && ((country === 'India' && !/^[1-9][0-9]{5}$/.test(pin)) || !/^[A-Za-z0-9 -]{3,12}$/.test(pin))) errors.pin_code = 'PIN code: 6 digits, not starting with 0.'

  const days = v.credit_period_days.trim()
  if (days && (!/^\d+$/.test(days) || Number(days) > 365)) errors.credit_period_days = 'Enter 0 to 365 days.'

  const ob = v.opening_balance.trim().replace(/,/g, '')
  let obType: BalanceType | null = v.opening_balance_type || null
  if (ob && (!/^\d+(\.\d{1,2})?$/.test(ob))) errors.opening_balance = 'Enter an amount of zero or more, with up to 2 decimals.'
  const obNum = ob && !errors.opening_balance ? Number(ob) : 0
  if (obNum > 0 && !obType) {
    if (v.party_type === 'CUSTOMER') obType = 'RECEIVABLE'
    else if (v.party_type === 'SUPPLIER') obType = 'PAYABLE'
    else errors.opening_balance_type = 'Choose whether the opening balance is receivable or payable.'
  }
  if (obNum > 0 && obType === 'PAYABLE' && v.party_type === 'CUSTOMER') warnings.push('A payable opening balance on a customer-only party is shown only if the party also becomes a supplier.')
  if (obNum > 0 && obType === 'RECEIVABLE' && v.party_type === 'SUPPLIER') warnings.push('A receivable opening balance on a supplier-only party is shown only if the party also becomes a customer.')

  const ifsc = v.bank_ifsc.trim().toUpperCase()
  if (ifsc && !IFSC_RE.test(ifsc)) errors.bank_ifsc = 'IFSC: 4 letters, 0, then 6 letters or digits.'
  const account = v.bank_account_number.replace(/\s/g, '')
  if (account && !/^[A-Za-z0-9]{6,34}$/.test(account)) errors.bank_account_number = '6 to 34 letters or digits.'
  if (v.remarks.trim().length > 2000) errors.remarks = 'Keep remarks under 2000 characters.'

  // Recommendations (never block).
  if (!gstin && v.party_type && country === 'India') warnings.push('No GSTIN: the party is treated as unregistered for GST.')
  if (!phone && !email) warnings.push('Add a mobile number or e-mail so the party can be contacted.')
  if (!state && country === 'India') warnings.push('No state: GST on invoices and purchase orders cannot be decided (CGST + SGST or IGST).')

  if (Object.keys(errors).length > 0) return { errors, warnings, payload: null }
  return {
    errors,
    warnings,
    payload: {
      party_type: v.party_type || null,
      party_name: name,
      legal_name: t(v.legal_name),
      gstin: gstin || null,
      pan: pan || null,
      contact_person: t(v.contact_person),
      phone: phone || null,
      email: email || null,
      billing_address: t(v.billing_address),
      shipping_address: t(v.shipping_address),
      city: t(v.city),
      state_code: state || null,
      pin_code: pin || null,
      country,
      credit_period_days: days ? Number(days) : null,
      payment_terms_note: t(v.payment_terms_note),
      supplier_category: t(v.supplier_category),
      opening_balance: obNum,
      opening_balance_type: obNum > 0 ? obType : null,
      opening_balance_date: obNum > 0 ? t(v.opening_balance_date) : null,
      bank_name: t(v.bank_name),
      bank_account_name: t(v.bank_account_name),
      bank_account_number: account || null,
      bank_ifsc: ifsc || null,
      remarks: t(v.remarks),
      status: v.status,
    },
  }
}

/** Party row from public.ledger_parties. */
export interface PartyRow {
  party_id: string
  party_code: string
  party_type: PartyType
  party_name: string
  legal_name: string | null
  status: 'ACTIVE' | 'INACTIVE'
  customer_id: string | null
  customer_code: string | null
  customer_status: string | null
  supplier_id: string | null
  supplier_code: string | null
  supplier_status: string | null
  supplier_category: string | null
  gstin: string | null
  pan: string | null
  gst_registration_type: string | null
  contact_person: string | null
  phone: string | null
  email: string | null
  billing_address: string | null
  shipping_address: string | null
  city: string | null
  state_code: string | null
  state_name: string | null
  shipping_state_code: string | null
  pin_code: string | null
  country: string
  credit_period_days: number | null
  payment_terms: string | null
  payment_terms_note: string | null
  opening_balance: number
  opening_balance_type: BalanceType | null
  opening_balance_date: string | null
  bank_name: string | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_ifsc: string | null
  remarks: string | null
  receivable: number
  payable: number
  net_balance: number
  overdue: number
  last_activity: string | null
  created_at: string
  updated_at: string
}

export function partyToForm(p: PartyRow): PartyFormValues {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    party_type: p.party_type, party_name: p.party_name, legal_name: p.legal_name && p.legal_name !== p.party_name ? p.legal_name : '',
    gstin: s(p.gstin), pan: s(p.pan), contact_person: s(p.contact_person), phone: s(p.phone), email: s(p.email),
    billing_address: s(p.billing_address), shipping_address: s(p.shipping_address), city: s(p.city), state_code: s(p.state_code),
    pin_code: s(p.pin_code), country: p.country || 'India', credit_period_days: s(p.credit_period_days), payment_terms_note: s(p.payment_terms_note),
    supplier_category: s(p.supplier_category), opening_balance: Number(p.opening_balance) > 0 ? String(Number(p.opening_balance)) : '',
    opening_balance_type: p.opening_balance_type ?? '', opening_balance_date: s(p.opening_balance_date),
    bank_name: s(p.bank_name), bank_account_name: s(p.bank_account_name), bank_account_number: s(p.bank_account_number), bank_ifsc: s(p.bank_ifsc),
    remarks: s(p.remarks), status: p.status,
  }
}

/** Human description of what the balance means. */
export function balanceLabel(net: number): string {
  if (Math.abs(net) < 0.005) return 'Settled'
  return net > 0 ? 'They owe us' : 'We owe them'
}

/** Rows for the Excel export (header + one row per party). */
export const LEDGER_EXPORT_COLUMNS = [
  'Party Code', 'Party Name', 'Type', 'Status', 'Customer Code', 'Supplier Code', 'GSTIN', 'PAN', 'Contact Person', 'Mobile', 'E-mail',
  'Billing Address', 'Shipping Address', 'City', 'State', 'State Code', 'PIN Code', 'Country', 'Credit Period (days)', 'Payment Terms Note',
  'Opening Balance', 'Opening Balance Type', 'Receivable', 'Payable', 'Net Balance', 'Overdue', 'Last Activity', 'Bank Name', 'Account Name',
  'Account Number', 'IFSC', 'Remarks',
] as const

export function ledgerExportRows(rows: PartyRow[]): (string | number | null)[][] {
  return [
    [...LEDGER_EXPORT_COLUMNS],
    ...rows.map((p) => [
      p.party_code, p.party_name, PARTY_TYPE_LABELS[p.party_type], p.status === 'ACTIVE' ? 'Active' : 'Inactive', p.customer_code, p.supplier_code,
      p.gstin, p.pan, p.contact_person, p.phone, p.email, p.billing_address, p.shipping_address, p.city, p.state_name, p.state_code, p.pin_code,
      p.country, p.credit_period_days, p.payment_terms_note, Number(p.opening_balance) || null,
      p.opening_balance_type ? (p.opening_balance_type === 'RECEIVABLE' ? 'Receivable' : 'Payable') : null,
      Number(p.receivable), Number(p.payable), Number(p.net_balance), Number(p.overdue), p.last_activity,
      p.bank_name, p.bank_account_name, p.bank_account_number, p.bank_ifsc, p.remarks,
    ]),
  ]
}

/** Totals for the ledger KPI cards. */
export function ledgerSummary(rows: PartyRow[]) {
  const active = rows.filter((r) => r.status === 'ACTIVE')
  return {
    customers: active.filter((r) => r.party_type === 'CUSTOMER').length,
    suppliers: active.filter((r) => r.party_type === 'SUPPLIER').length,
    both: active.filter((r) => r.party_type === 'BOTH').length,
    receivable: rows.reduce((s, r) => s + Math.max(0, Number(r.receivable)), 0),
    payable: rows.reduce((s, r) => s + Math.max(0, Number(r.payable)), 0),
    withBalance: rows.filter((r) => Math.abs(Number(r.receivable)) >= 0.005 || Math.abs(Number(r.payable)) >= 0.005).length,
    overdue: rows.reduce((s, r) => s + Number(r.overdue || 0), 0),
    inactive: rows.length - active.length,
  }
}
