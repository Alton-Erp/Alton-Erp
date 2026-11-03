// Supplier labels, form validation and duplicate detection.
// The database enforces the same hard rules (formats, uniqueness of code and
// GSTIN per company); this layer gives immediate, field-level feedback and
// warns about likely duplicates that the database cannot judge (similar names).

import type { SupplierCategory, SupplierInsert, SupplierPaymentTerms, SupplierRow, SupplierStatus } from '@/types/database-suppliers'

/**
 * Supplier purchase orders and goods receipts exist (purchase_orders,
 * goods_receipts), so PO history, open order value and pending quantities are
 * shown from those records. Supplier invoices and payments (payables) are NOT
 * recorded, so no outstanding payable balance is ever shown.
 */
export const SUPPLIER_PO_MODULE_AVAILABLE = true

export const SUPPLIER_CATEGORY_LABELS: Record<SupplierCategory, string> = {
  RAW_MATERIAL: 'Raw Material',
  FINISHED_GOODS: 'Finished Goods',
  PACKAGING: 'Packaging',
  MACHINERY: 'Machinery',
  SERVICES: 'Services',
  OTHER: 'Other',
}

export const PAYMENT_TERMS_LABELS: Record<SupplierPaymentTerms, string> = {
  IMMEDIATE: 'Immediate',
  DAYS_7: '7 Days',
  DAYS_15: '15 Days',
  DAYS_30: '30 Days',
  DAYS_45: '45 Days',
  CUSTOM: 'Custom',
}

export function paymentTermsLabel(terms: SupplierPaymentTerms, customDays: number | null): string {
  return terms === 'CUSTOM' ? (customDays ? `${customDays} Days (custom)` : 'Custom') : PAYMENT_TERMS_LABELS[terms]
}

/** The name shown in lists: display name when set, otherwise the legal name. */
export const supplierName = (s: Pick<SupplierRow, 'display_name' | 'legal_name'>) => s.display_name || s.legal_name

export const SUPPLIER_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE_RE = /^\+?[0-9][0-9 -]{5,18}[0-9]$/
const INDIA_PIN_RE = /^[1-9][0-9]{5}$/
const FOREIGN_POSTCODE_RE = /^[A-Za-z0-9 -]{3,12}$/

export function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '').length
  return PHONE_RE.test(value) && digits >= 7 && digits <= 15
}

export const isIndia = (country: string) => country.trim().toLowerCase() === 'india' || country.trim() === ''

export interface SupplierFormValues {
  supplier_code: string
  legal_name: string
  display_name: string
  category: SupplierCategory
  contact_person: string
  phone: string
  alternate_phone: string
  email: string
  gstin: string
  pan: string
  billing_address: string
  shipping_address: string
  city: string
  state_code: string
  pin_code: string
  country: string
  payment_terms: SupplierPaymentTerms
  custom_payment_days: string
  notes: string
  status: SupplierStatus
}

export type SupplierFormErrors = Partial<Record<keyof SupplierFormValues, string>>

export function emptySupplierForm(): SupplierFormValues {
  return {
    supplier_code: '', legal_name: '', display_name: '', category: 'RAW_MATERIAL', contact_person: '', phone: '', alternate_phone: '',
    email: '', gstin: '', pan: '', billing_address: '', shipping_address: '', city: '', state_code: '', pin_code: '', country: 'India',
    payment_terms: 'DAYS_30', custom_payment_days: '', notes: '', status: 'ACTIVE',
  }
}

export function formFromSupplier(s: SupplierRow): SupplierFormValues {
  return {
    supplier_code: s.supplier_code, legal_name: s.legal_name, display_name: s.display_name ?? '', category: s.category,
    contact_person: s.contact_person ?? '', phone: s.phone ?? '', alternate_phone: s.alternate_phone ?? '', email: s.email ?? '',
    gstin: s.gstin ?? '', pan: s.pan ?? '', billing_address: s.billing_address ?? '', shipping_address: s.shipping_address ?? '',
    city: s.city ?? '', state_code: s.state_code ?? '', pin_code: s.pin_code ?? '', country: s.country, payment_terms: s.payment_terms,
    custom_payment_days: s.custom_payment_days === null ? '' : String(s.custom_payment_days), notes: s.notes ?? '', status: s.status,
  }
}

/**
 * Field errors block saving; warnings are shown but do not. `isNew` controls
 * the supplier code check (the code cannot change after creation).
 */
export function validateSupplierForm(v: SupplierFormValues, isNew: boolean): { errors: SupplierFormErrors; warnings: string[] } {
  const errors: SupplierFormErrors = {}
  const warnings: string[] = []
  const t = (s: string) => s.trim()
  const code = t(v.supplier_code).toUpperCase()
  const gstin = t(v.gstin).toUpperCase()
  const pan = t(v.pan).toUpperCase()
  const india = isIndia(v.country)

  if (isNew && code && !SUPPLIER_CODE_RE.test(code)) errors.supplier_code = 'Use 1–30 letters, digits, "-" or "_", starting with a letter or digit.'
  if (!t(v.legal_name)) errors.legal_name = 'Enter the legal business name.'
  else if (t(v.legal_name).length > 200) errors.legal_name = 'Keep the legal name within 200 characters.'
  if (t(v.display_name).length > 200) errors.display_name = 'Keep the display name within 200 characters.'
  if (t(v.contact_person).length > 120) errors.contact_person = 'Keep the contact name within 120 characters.'
  if (t(v.phone) && !isValidPhone(t(v.phone))) errors.phone = 'Enter a valid phone number (7–15 digits; "+", spaces and "-" allowed).'
  if (t(v.alternate_phone) && !isValidPhone(t(v.alternate_phone))) errors.alternate_phone = 'Enter a valid phone number (7–15 digits; "+", spaces and "-" allowed).'
  if (t(v.email) && (!EMAIL_RE.test(t(v.email)) || t(v.email).length > 320)) errors.email = 'Enter a valid e-mail address, e.g. sales@supplier.com.'
  if (gstin && !GSTIN_RE.test(gstin)) errors.gstin = 'GSTIN must be 15 characters, e.g. 27AAPFU0939F1ZV.'
  if (pan && !PAN_RE.test(pan)) errors.pan = 'PAN must be 10 characters, e.g. AAPFU0939F.'
  if (gstin && pan && !errors.gstin && !errors.pan && gstin.slice(2, 12) !== pan) errors.pan = `PAN does not match the GSTIN (characters 3–12 are ${gstin.slice(2, 12)}).`
  if (!t(v.country)) errors.country = 'Enter the country.'
  if (t(v.pin_code)) {
    const pin = t(v.pin_code).replace(/\s/g, '')
    if (india && !INDIA_PIN_RE.test(pin)) errors.pin_code = 'An Indian PIN code is 6 digits and does not start with 0.'
    if (!india && !FOREIGN_POSTCODE_RE.test(t(v.pin_code))) errors.pin_code = 'Enter a valid postcode (3–12 letters or digits).'
  }
  if (v.payment_terms === 'CUSTOM') {
    const d = t(v.custom_payment_days)
    if (!/^\d{1,3}$/.test(d) || Number(d) < 1 || Number(d) > 365) errors.custom_payment_days = 'Enter the number of days (1–365).'
  }
  if (t(v.billing_address).length > 1000) errors.billing_address = 'Keep the address within 1000 characters.'
  if (t(v.shipping_address).length > 1000) errors.shipping_address = 'Keep the address within 1000 characters.'
  if (t(v.notes).length > 2000) errors.notes = 'Keep notes within 2000 characters.'

  if (gstin && !errors.gstin && v.state_code && gstin.slice(0, 2) !== v.state_code) {
    warnings.push(`The GSTIN is registered in state ${gstin.slice(0, 2)}, but the selected state is ${v.state_code}. Check both.`)
  }
  if (gstin && !india) warnings.push('A GSTIN is entered for a supplier outside India. Check the country.')
  return { errors, warnings }
}

/** Trimmed database payload (empty strings become NULL; the database normalises again). */
export function toSupplierPayload(v: SupplierFormValues): Omit<SupplierInsert, 'company_id'> {
  const n = (s: string) => (s.trim() === '' ? null : s.trim())
  const india = isIndia(v.country)
  return {
    supplier_code: n(v.supplier_code.toUpperCase()),
    legal_name: v.legal_name.trim(),
    display_name: n(v.display_name),
    category: v.category,
    contact_person: n(v.contact_person),
    phone: n(v.phone),
    alternate_phone: n(v.alternate_phone),
    email: n(v.email.toLowerCase()),
    gstin: n(v.gstin.toUpperCase()),
    pan: n(v.pan.toUpperCase()),
    billing_address: n(v.billing_address),
    shipping_address: n(v.shipping_address),
    city: n(v.city),
    state_code: n(v.state_code),
    pin_code: india ? n(v.pin_code.replace(/\s/g, '')) : n(v.pin_code),
    country: v.country.trim() || 'India',
    payment_terms: v.payment_terms,
    custom_payment_days: v.payment_terms === 'CUSTOM' ? Number(v.custom_payment_days.trim()) : null,
    notes: n(v.notes),
    status: v.status,
  }
}

const LEGAL_SUFFIXES = /\b(private|pvt|limited|ltd|llp|llc|inc|co|company|corp|corporation|and|the|m s|ms)\b/g

/** Name key for duplicate detection: lower-case, no punctuation or legal suffixes. */
export function normaliseSupplierName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type DuplicateCandidate = Pick<SupplierRow, 'id' | 'supplier_code' | 'legal_name' | 'display_name' | 'gstin' | 'pan' | 'phone' | 'email' | 'status'>

export interface PossibleDuplicate {
  supplier: DuplicateCandidate
  /** `blocking` = the database will reject the save (same code or GSTIN). */
  blocking: boolean
  reason: string
}

/**
 * Existing suppliers that look like the one being saved. Same code / GSTIN
 * block saving (the database rejects them too); same name, PAN, phone or
 * e-mail ask the user to confirm it is a different supplier.
 */
export function findPossibleDuplicates(v: SupplierFormValues, existing: DuplicateCandidate[], selfId?: string): PossibleDuplicate[] {
  const code = v.supplier_code.trim().toUpperCase()
  const gstin = v.gstin.trim().toUpperCase()
  const pan = v.pan.trim().toUpperCase() || (GSTIN_RE.test(gstin) ? gstin.slice(2, 12) : '')
  const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10)
  const phone = digits(v.phone)
  const email = v.email.trim().toLowerCase()
  const names = [v.legal_name, v.display_name].map(normaliseSupplierName).filter((s) => s.length >= 3)

  const out: PossibleDuplicate[] = []
  for (const s of existing) {
    if (s.id === selfId) continue
    const sPan = s.pan ?? (s.gstin ? s.gstin.slice(2, 12) : null)
    if (!selfId && code && s.supplier_code === code) out.push({ supplier: s, blocking: true, reason: 'same supplier code' })
    else if (gstin && s.gstin === gstin) out.push({ supplier: s, blocking: true, reason: 'same GSTIN' })
    else if (names.length && [s.legal_name, s.display_name ?? ''].map(normaliseSupplierName).some((n) => n.length >= 3 && names.includes(n))) {
      out.push({ supplier: s, blocking: false, reason: 'same name' })
    } else if (pan && sPan === pan) out.push({ supplier: s, blocking: false, reason: 'same PAN (another GST registration of the same business?)' })
    else if (phone.length >= 7 && digits(s.phone) === phone) out.push({ supplier: s, blocking: false, reason: 'same phone number' })
    else if (email && s.email === email) out.push({ supplier: s, blocking: false, reason: 'same e-mail' })
  }
  return out
}
