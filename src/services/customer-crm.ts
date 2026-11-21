import type { FieldDefinition, FormField } from '@/features/support/ticket-fields/field-model'
import type { Priority, TicketStatus } from '@/features/support/support-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Support customer CRM (migration 20261228090000): the configured customer form, customer matching, the customer
 * workspace (profile tabs), notes, activities and the customer report. Every function checks support permissions and
 * the company in the database.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}
const missing = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return x?.code === 'PGRST202' || x?.code === '42883' || /could not find the function|does not exist/i.test(x?.message ?? '')
}
async function orNull<T>(p: Promise<T | null>): Promise<T | null> {
  try { return (await p) ?? null } catch (e) { if (missing(e)) return null; throw e }
}

export type CustomerFormField = FormField
export interface CustomerForm { fields: CustomerFormField[]; customer_types: string[]; can: { save: boolean } }
/** The configured customer form; null before the database update (the earlier customer form is used). */
export const fetchCustomerForm = () => orNull(rpc<CustomerForm | null>('support_customer_form'))

export interface CustomerSaveInput {
  display_name?: string; company_name?: string | null; contact_person?: string | null; mobile?: string | null; alternate_phone?: string | null; landline?: string | null
  email?: string | null; alternate_email?: string | null; gstin?: string | null; customer_type?: string | null; customer_category?: string | null; address?: string | null
  city?: string | null; state?: string | null; pin_code?: string | null; country?: string | null; description?: string | null; assigned_agent_id?: string | null
  erp_customer_id?: string | null; custom_fields?: Record<string, unknown>
}
export interface CustomerSaveResult { ok: boolean; id?: string; customer_code?: string; display_name?: string; duplicates: { id: string; customer_code: string; display_name: string }[] }
export const saveCustomerV2 = (id: string | null, p: CustomerSaveInput, allowDuplicate = false) =>
  rpc<CustomerSaveResult>('support_customer_save_v2', { p_id: id, p, p_allow_duplicate: allowDuplicate })

export interface CustomerMatch {
  id: string; customer_code: string; display_name: string; company_name: string | null; mobile: string | null; alternate_phone: string | null; landline: string | null
  email: string | null; alternate_email: string | null; phones: string[]; emails: string[]; matched_on: string[]; open_tickets: number
}
/** Customers whose phone or email matches (normalised); null before the database update. */
export const lookupCustomers = (phone: string | null, email: string | null) => orNull(rpc<CustomerMatch[]>('support_customer_lookup', { p_phone: phone, p_email: email }))

export interface CustomerRecord {
  id: string; customer_code: string; display_name: string; company_name: string | null; contact_person: string | null; mobile: string | null; alternate_phone: string | null
  landline: string | null; email: string | null; alternate_email: string | null; phones: string[]; emails: string[]; gstin: string | null; customer_type: string | null
  customer_category: string | null; address: string | null; city: string | null; state: string | null; pin_code: string | null; country: string | null; notes: string | null
  assigned_agent_id: string | null; assigned_agent: { id: string; display_name: string } | null; erp_customer_id: string | null
  erp_customer: { id: string; customer_code: string; customer_name: string } | null; is_active: boolean; created_at: string; updated_at: string; created_by_name: string | null
}
export interface CustomerNote { id: string; body: string; created_at: string; edited_at: string | null; author: string | null; can_edit: boolean; revisions: number }
export type ActivityType = 'TASK' | 'FOLLOW_UP' | 'REMINDER' | 'VISIT' | 'SERVICE_APPOINTMENT'
export type ActivityStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'
export interface CustomerActivity {
  id: string; activity_type: ActivityType; title: string; description: string | null; due_at: string | null; assigned_user_id: string | null; assigned_user: string | null
  priority: Priority; status: ActivityStatus; completed_at: string | null; ticket_id: string | null; ticket_number: string | null; created_at: string; created_by: string | null
}
export interface CustomerWorkspace {
  customer: CustomerRecord
  tags: { id: string; name: string; color: string }[]
  fields: (FieldDefinition & { value: unknown; in_form: boolean; required: boolean })[]
  formula_inputs: Record<string, unknown>
  metrics: { total: number; open: number; closed: number; overdue: number; avg_resolution_hours: number | null; reopened: number; product_complaints: number | null; last_ticket_at: string | null }
  counts: { notes: number; open_activities: number; conversations: number; calls: number }
  notes: CustomerNote[]
  activities: CustomerActivity[]
  can: { edit: boolean; notes: boolean; manage_notes: boolean; activities: boolean; products: boolean; create_ticket: boolean }
}
/** The customer profile workspace; null before the database update (the earlier profile page is shown). */
export const fetchCustomerWorkspace = (id: string) => orNull(rpc<CustomerWorkspace | null>('support_customer_workspace', { p_customer: id }))

export type CustomerTicketFilter = 'ALL' | 'OPEN' | 'IN_PROGRESS' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED' | 'OVERDUE'
export interface CustomerTicket {
  id: string; ticket_number: string; subject: string; status: TicketStatus; priority: Priority; pipeline: string | null; stage: string | null; stage_color: string | null
  stage_type: 'OPEN' | 'CLOSED' | null; outcome_type: 'POSITIVE' | 'NEGATIVE' | null; assigned_agent: string | null; created_at: string; updated_at: string; sla_status: string
  closed_at: string | null; merged: boolean; reopen_count: number
}
export const fetchCustomerTickets = (id: string, filter: CustomerTicketFilter) => rpc<CustomerTicket[]>('support_customer_tickets', { p_customer: id, p_filter: filter })

export interface TimelineEvent {
  at: string; type: string; title: string; detail: string | null; actor: string | null
  link_type: 'CUSTOMER' | 'TICKET' | 'CALL' | 'CONVERSATION' | 'NOTE' | 'ACTIVITY'; link_id: string; channel: string | null
}
export const fetchCustomerTimeline = (id: string, limit = 100, before: string | null = null) =>
  rpc<TimelineEvent[]>('support_customer_timeline', { p_customer: id, p_limit: limit, p_before: before })

export type RecordKind = 'EMAIL' | 'CALLS' | 'WHATSAPP' | 'FILES' | 'PRODUCTS'
export interface EmailRow { id: string; conversation_id: string; direction: string; subject: string | null; from_address: string | null; from_name: string | null; at: string }
export interface CallRow { id: string; direction: string; status: string; at: string; answered_at: string | null; ended_at: string | null; duration_seconds: number | null; agent_name: string | null; ticket_id: string | null; ticket_number: string | null; conversation_id: string | null }
export interface WhatsAppRow { id: string; conversation_id: string; direction: string; msg_type: string; status: string | null; at: string }
export interface FileRow { id: string; file_name: string; content_type: string | null; size_bytes: number | null; at: string; ticket_id: string | null; ticket_number: string | null; conversation_id: string | null; is_recording: boolean; is_sensitive: boolean; storage_path: string | null; restricted: boolean }
export interface ProductRow { product_id: string; product_name: string; sku: string; model_number: string | null; complaints: number; quantity: number; last_complaint_at: string; tickets: { id: string; ticket_number: string }[] }
export const fetchCustomerRecords = <T>(id: string, kind: RecordKind) => rpc<T[]>('support_customer_records', { p_customer: id, p_kind: kind })

export const saveCustomerNote = (customerId: string, noteId: string | null, body: string) => rpc<{ id: string }>('support_customer_note_save', { p_customer: customerId, p_note: noteId, p_body: body })
export const deleteCustomerNote = (noteId: string) => rpc<void>('support_customer_note_delete', { p_note: noteId })
export const fetchNoteHistory = (noteId: string) => rpc<{ id: string; body: string; action: 'EDITED' | 'DELETED'; changed_at: string; changed_by: string | null }[]>('support_customer_note_history', { p_note: noteId })

export interface ActivityInput { activity_type?: ActivityType; title?: string; description?: string | null; due_at?: string | null; assigned_user_id?: string | null; priority?: Priority; status?: ActivityStatus; ticket_id?: string | null }
export const saveCustomerActivity = (customerId: string, id: string | null, p: ActivityInput) => rpc<{ id: string; status: ActivityStatus }>('support_customer_activity_save', { p_customer: customerId, p_id: id, p })

export interface CustomerReport {
  from: string; to: string
  customers: { customer_id: string; customer_code: string; display_name: string; tickets: number; open: number; closed: number; overdue: number; avg_resolution_hours: number | null; reopened: number; product_complaints: number | null }[]
  trend: { customer_id: string; month: string; tickets: number }[]
  products_by_customer: { customer_id: string; customer_code: string; display_name: string; sku: string; product_name: string; tickets: number }[] | null
}
export const fetchCustomerReport = (from: string, to: string) => orNull(rpc<CustomerReport | null>('support_customer_report', { p_from: from, p_to: to }))
