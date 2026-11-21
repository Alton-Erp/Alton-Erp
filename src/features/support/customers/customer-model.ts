/**
 * Support customer CRM (migration 20261228090000): pure helpers for the configured customer form, matching and the
 * customer workspace. The database applies the same rules.
 */
import { isEmail, normalizePhone } from '../support-model.ts'
import type { CustomerRecord } from '@/services/customer-crm'

/** Standard customer fields edited as text (the form keys are the database keys). */
export const CUSTOMER_TEXT_KEYS = ['display_name', 'company_name', 'contact_person', 'mobile', 'alternate_phone', 'landline', 'email', 'alternate_email', 'gstin',
  'customer_type', 'customer_category', 'address', 'city', 'state', 'pin_code', 'country', 'description'] as const
export type CustomerTextKey = (typeof CUSTOMER_TEXT_KEYS)[number]
export type CustomerValues = Record<CustomerTextKey, string> & { assigned_agent_id: string; erp_customer_id: string }

export const PHONE_KEYS: CustomerTextKey[] = ['mobile', 'alternate_phone', 'landline']
export const EMAIL_KEYS: CustomerTextKey[] = ['email', 'alternate_email']
export const WIDE_KEYS = new Set(['address', 'description'])
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function emptyCustomer(): CustomerValues {
  return { ...(Object.fromEntries(CUSTOMER_TEXT_KEYS.map((k) => [k, ''])) as Record<CustomerTextKey, string>), assigned_agent_id: '', erp_customer_id: '', country: 'India' }
}

export function customerValuesOf(c: CustomerRecord): CustomerValues {
  const v = emptyCustomer()
  for (const k of CUSTOMER_TEXT_KEYS) v[k] = String((k === 'description' ? c.notes : (c as unknown as Record<string, unknown>)[k]) ?? '')
  v.assigned_agent_id = c.assigned_agent_id ?? ''
  v.erp_customer_id = c.erp_customer_id ?? ''
  return v
}

/** Field errors for the standard values (formats; required fields are checked by the form). */
export function checkCustomerValues(v: CustomerValues): Record<string, string> {
  const e: Record<string, string> = {}
  if (!v.display_name.trim()) e.display_name = 'Enter the customer name.'
  for (const k of PHONE_KEYS) if (v[k].trim() && (!normalizePhone(v[k]) || v[k].trim().length > 30)) e[k] = 'Not a valid phone number.'
  for (const k of EMAIL_KEYS) if (v[k].trim() && !isEmail(v[k])) e[k] = 'Not a valid email address.'
  if (v.gstin.trim() && !GSTIN_RE.test(v.gstin.trim().toUpperCase())) e.gstin = 'GSTIN has 15 characters, e.g. 27AAACE1234F1Z5.'
  const india = !v.country.trim() || v.country.trim().toLowerCase() === 'india'
  if (v.pin_code.trim() && (india ? !/^[1-9][0-9]{5}$/.test(v.pin_code.trim()) : !/^[A-Za-z0-9 -]{3,12}$/.test(v.pin_code.trim()))) e.pin_code = india ? 'PIN code has 6 digits.' : 'Not a valid postal code.'
  return e
}

/** Initials for the avatar. */
export const initials = (name: string) => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

/** What to look up while a phone / email is typed on New Ticket (null: nothing useful yet). */
export function lookupKeys(phone: string, email: string): { phone: string | null; email: string | null } | null {
  const p = normalizePhone(phone) ? phone.trim() : null
  const e = isEmail(email) ? email.trim() : null
  return p || e ? { phone: p, email: e } : null
}

/** Address on one line. */
export const addressLine = (c: Pick<CustomerRecord, 'address' | 'city' | 'state' | 'pin_code' | 'country'>) =>
  [c.address, [c.city, c.state].filter(Boolean).join(', '), c.pin_code, c.country].filter((x) => x && String(x).trim()).join(' · ') || null

export const TIMELINE_LABELS: Record<string, string> = {
  CUSTOMER_CREATED: 'Customer created', CUSTOMER_UPDATED: 'Customer updated', TICKET_CREATED: 'Ticket created', STAGE_CHANGED: 'Stage changed',
  TICKET_ASSIGNED: 'Ticket assigned', TICKET_RESOLVED: 'Ticket resolved', TICKET_CLOSED: 'Ticket closed', TICKET_REOPENED: 'Ticket reopened', NOTE_ADDED: 'Note',
  CALL: 'Call', CALL_MISSED: 'Missed call', EMAIL_RECEIVED: 'Email received', EMAIL_SENT: 'Email sent', WHATSAPP_RECEIVED: 'WhatsApp received', WHATSAPP_SENT: 'WhatsApp sent',
  PRODUCT_LINKED: 'Product linked', ACTIVITY_CREATED: 'Activity', ACTIVITY_COMPLETED: 'Activity done',
}

/** Where a timeline event opens. */
export function timelineHref(e: { link_type: string; link_id: string; channel: string | null }, customerId: string): string | null {
  switch (e.link_type) {
    case 'TICKET': return `/support/tickets/${e.link_id}`
    case 'CALL': return `/support/calls/${e.link_id}`
    case 'CONVERSATION': return e.channel === 'EMAIL' ? `/support/emails?c=${e.link_id}` : e.channel === 'WHATSAPP' ? `/support/whatsapp?c=${e.link_id}` : `/support/inbox?c=${e.link_id}`
    case 'NOTE': return `/support/customers/${customerId}?tab=notes`
    case 'ACTIVITY': return `/support/customers/${customerId}?tab=activities`
    default: return null
  }
}

/** An ISO time as the value of a datetime-local input (the browser's time zone). */
export function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export const ACTIVITY_TYPES = [['TASK', 'Task'], ['FOLLOW_UP', 'Follow-up'], ['REMINDER', 'Reminder'], ['VISIT', 'Customer visit'], ['SERVICE_APPOINTMENT', 'Service appointment']] as const
export const ACTIVITY_STATUSES = [['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['DONE', 'Done'], ['CANCELLED', 'Cancelled']] as const
export const TICKET_FILTERS = [['ALL', 'All tickets'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['ON_HOLD', 'On hold'], ['RESOLVED', 'Resolved'], ['CLOSED', 'Closed'], ['OVERDUE', 'Overdue']] as const
