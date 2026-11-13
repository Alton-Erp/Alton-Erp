// Support Centre presentation model (migration 20261210090000): labels, tones, validation and formatting.
// The rules themselves (SLA, matching, permissions, channel health) run in the database; nothing here decides them.

import type { Tone } from '../../config/status.ts'

export const CHANNELS = ['PHONE', 'WHATSAPP', 'EMAIL'] as const
export type Channel = (typeof CHANNELS)[number]
export type TicketChannel = Channel | 'MANUAL'
export const CHANNEL_LABELS: Record<TicketChannel, string> = { PHONE: 'Phone', WHATSAPP: 'WhatsApp', EMAIL: 'Email', MANUAL: 'Manual' }

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type Priority = (typeof PRIORITIES)[number]
export const PRIORITY_META: Record<Priority, { label: string; tone: Tone }> = {
  LOW: { label: 'Low', tone: 'neutral' },
  NORMAL: { label: 'Normal', tone: 'info' },
  HIGH: { label: 'High', tone: 'warning' },
  URGENT: { label: 'Urgent', tone: 'danger' },
}

export const TICKET_STATUSES = ['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export const TICKET_STATUS_META: Record<TicketStatus, { label: string; tone: Tone }> = {
  NEW: { label: 'New', tone: 'info' },
  OPEN: { label: 'Open', tone: 'info' },
  IN_PROGRESS: { label: 'In Progress', tone: 'warning' },
  WAITING_CUSTOMER: { label: 'Waiting for Customer', tone: 'outsourced' },
  WAITING_INTERNAL: { label: 'Waiting Internally', tone: 'outsourced' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
}
export const OPEN_TICKET_STATUSES: TicketStatus[] = ['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL']

export const CONVERSATION_STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]
export const CONVERSATION_STATUS_META: Record<ConversationStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'info' },
  PENDING: { label: 'Pending', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
}

export const SLA_META: Record<string, { label: string; tone: Tone; hint: string }> = {
  NO_SLA: { label: 'No SLA', tone: 'neutral', hint: 'No SLA policy applies to this ticket.' },
  ON_TRACK: { label: 'On track', tone: 'success', hint: 'Within the response and resolution targets.' },
  AT_RISK: { label: 'At risk', tone: 'warning', hint: 'Less than 20% of the resolution window is left.' },
  OVERDUE: { label: 'Overdue', tone: 'danger', hint: 'The first response or resolution target has passed.' },
  MET: { label: 'Met', tone: 'success', hint: 'Resolved within the target.' },
  BREACHED: { label: 'Breached', tone: 'danger', hint: 'Resolved after the target.' },
  PAUSED: { label: 'Paused', tone: 'neutral', hint: 'Waiting for the customer: the SLA clock is stopped.' },
}

/** Integration health as the server reports it. The app never derives "Connected" itself. */
export const INTEGRATION_STATUSES = ['NOT_CONNECTED', 'SETUP_REQUIRED', 'CONNECTED', 'ERROR', 'REAUTHORIZATION_REQUIRED'] as const
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]
export const INTEGRATION_META: Record<IntegrationStatus, { label: string; tone: Tone; hint: string }> = {
  NOT_CONNECTED: { label: 'Not Connected', tone: 'neutral', hint: 'No account is set up for this channel.' },
  SETUP_REQUIRED: { label: 'Setup Required', tone: 'warning', hint: 'Account saved; waiting for the server-side connection check.' },
  CONNECTED: { label: 'Connected', tone: 'success', hint: 'Verified by the server-side connection check.' },
  ERROR: { label: 'Error', tone: 'danger', hint: 'The last connection check failed.' },
  REAUTHORIZATION_REQUIRED: { label: 'Reauthorization Required', tone: 'danger', hint: 'The credentials expired or were revoked.' },
}
export const integrationMeta = (s: string | null | undefined) => INTEGRATION_META[(s ?? 'NOT_CONNECTED') as IntegrationStatus] ?? INTEGRATION_META.NOT_CONNECTED

export const PRESENCES = ['AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE'] as const
export type Presence = (typeof PRESENCES)[number]
export const PRESENCE_META: Record<Presence, { label: string; dot: string }> = {
  AVAILABLE: { label: 'Available', dot: 'bg-green-500' },
  BUSY: { label: 'Busy', dot: 'bg-red-500' },
  AWAY: { label: 'Away', dot: 'bg-amber-500' },
  OFFLINE: { label: 'Offline', dot: 'bg-gray-400' },
}

/** Live call status (Acefone): reported by the provider's events, never assumed from an accepted request. */
export const CALL_STATUS_META: Record<string, { label: string; tone: Tone; hint: string }> = {
  INITIATED: { label: 'Initiated', tone: 'neutral', hint: 'Requested; Acefone has not reported progress yet.' },
  RINGING: { label: 'Ringing', tone: 'info', hint: 'Acefone reports the call is ringing or in the IVR.' },
  CONNECTED: { label: 'Connected', tone: 'success', hint: 'Acefone reports both parties connected.' },
  COMPLETED: { label: 'Completed', tone: 'success', hint: 'The call was answered and has ended.' },
  MISSED: { label: 'Missed', tone: 'warning', hint: 'Nobody answered.' },
  FAILED: { label: 'Failed', tone: 'danger', hint: 'The call could not be placed.' },
}

export const CALL_STATUSES = ['ANSWERED', 'MISSED', 'VOICEMAIL', 'FAILED'] as const
export const CALL_STATUS_LABELS: Record<string, string> = { ANSWERED: 'Answered', MISSED: 'Missed', VOICEMAIL: 'Voicemail', FAILED: 'Failed' }

export const INBOX_VIEWS = ['ALL', 'PHONE', 'WHATSAPP', 'EMAIL', 'UNASSIGNED', 'MINE', 'OPEN', 'PENDING', 'RESOLVED'] as const
export type InboxView = (typeof INBOX_VIEWS)[number]
export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  ALL: 'All', PHONE: 'Phone', WHATSAPP: 'WhatsApp', EMAIL: 'Email', UNASSIGNED: 'Unassigned', MINE: 'My conversations', OPEN: 'Open', PENDING: 'Pending', RESOLVED: 'Resolved',
}

export const TICKET_EVENT_LABELS: Record<string, string> = {
  CREATED: 'Ticket created', STATUS_CHANGED: 'Status changed', PRIORITY_CHANGED: 'Priority changed', ASSIGNED: 'Assigned', UPDATED: 'Details updated',
  MERGED: 'Duplicate merged in', MERGED_INTO: 'Merged into another ticket', REOPENED: 'Reopened', NOTE_ADDED: 'Internal note added',
  ATTACHMENT_ADDED: 'Attachment added', CONVERSATION_LINKED: 'Conversation linked', FIRST_RESPONSE: 'First response', AUTOMATION: 'Automation rule applied',
  CSAT_RECORDED: 'Satisfaction rating recorded',
}

export const TAG_COLORS = ['neutral', 'info', 'success', 'warning', 'danger', 'outsourced'] as const

/** Same normalisation as the database (private.support_normalize_phone): +91 / 0 prefixes removed. */
export function normalizePhone(value: string | null | undefined): string | null {
  const d = String(value ?? '').replace(/\D/g, '')
  if (d.length < 6) return null
  if (d.length === 12 && d.startsWith('91')) return d.slice(2)
  if (d.length === 11 && d.startsWith('0')) return d.slice(1)
  return d
}

export const isEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())

/** Splits a free-text list (commas, semicolons or new lines) into trimmed, distinct values. */
export function splitList(value: string): string[] {
  return [...new Set(value.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean))]
}

/** "45 min", "3 h 20 min", "2 d 4 h"; a dash when unknown. */
export function formatMinutes(minutes: number | string | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes === '' || !Number.isFinite(Number(minutes))) return '—'
  const m = Math.max(0, Math.round(Number(minutes)))
  if (m < 60) return `${m} min`
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return `${d} d${h ? ` ${h} h` : ''}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type FieldErrors = Record<string, string>

export interface CustomerInput { display_name: string; company_name: string; phones: string; emails: string; address: string; notes: string }
export function validateCustomer(v: CustomerInput): FieldErrors {
  const e: FieldErrors = {}
  if (!v.display_name.trim()) e.display_name = 'Enter the customer’s name.'
  else if (v.display_name.trim().length > 200) e.display_name = 'At most 200 characters.'
  const phones = splitList(v.phones)
  const emails = splitList(v.emails)
  if (phones.length + emails.length === 0) e.contact = 'Enter at least one phone number or email address.'
  const badPhone = phones.find((p) => !normalizePhone(p) || p.length > 30)
  if (badPhone) e.phones = `“${badPhone}” is not a valid phone number.`
  const badEmail = emails.find((m) => !isEmail(m))
  if (badEmail) e.emails = `“${badEmail}” is not a valid email address.`
  if (phones.length > 10 || emails.length > 10) e.contact = 'At most 10 phone numbers and 10 email addresses.'
  if (v.address.length > 1000) e.address = 'At most 1000 characters.'
  if (v.notes.length > 2000) e.notes = 'At most 2000 characters.'
  return e
}

export interface TicketInput {
  subject: string; customer_id: string; customer_phone: string; customer_email: string; priority: Priority; category: string
  subcategory: string; department: string; description: string; conversation_id?: string
}
export function validateTicket(v: TicketInput): FieldErrors {
  const e: FieldErrors = {}
  if (v.subject.trim().length < 3) e.subject = 'Enter a subject (at least 3 characters).'
  else if (v.subject.trim().length > 200) e.subject = 'At most 200 characters.'
  if (!v.conversation_id && !v.customer_id && !v.customer_phone.trim() && !v.customer_email.trim()) e.customer = 'Choose the customer or enter their phone number or email address.'
  if (v.customer_phone.trim() && !normalizePhone(v.customer_phone)) e.customer_phone = 'Not a valid phone number.'
  if (v.customer_email.trim() && !isEmail(v.customer_email)) e.customer_email = 'Not a valid email address.'
  if (v.description.length > 10000) e.description = 'At most 10000 characters.'
  for (const k of ['category', 'subcategory', 'department'] as const) if (v[k].length > 80) e[k] = 'At most 80 characters.'
  return e
}

export interface LogInput { channel: Channel; direction: 'INBOUND' | 'OUTBOUND'; body: string; call_status: string; duration: string; subject: string }
export function validateLog(v: LogInput, needsContact: { customer_id: string; contact_phone: string; contact_email: string; contact_name: string } | null): FieldErrors {
  const e: FieldErrors = {}
  if (v.channel === 'PHONE') {
    if (!CALL_STATUSES.includes(v.call_status as (typeof CALL_STATUSES)[number])) e.call_status = 'Choose the call result.'
    if (v.duration.trim() && !/^\d{1,5}$/.test(v.duration.trim())) e.duration = 'Seconds, as a whole number.'
  } else if (!v.body.trim()) e.body = 'Enter the message.'
  if (v.body.length > 20000) e.body = 'At most 20000 characters.'
  if (needsContact) {
    const { customer_id, contact_phone, contact_email, contact_name } = needsContact
    if (!customer_id && !contact_phone.trim() && !contact_email.trim() && !contact_name.trim()) e.contact = 'Choose the customer, or enter their phone number or email address.'
    if (contact_phone.trim() && !normalizePhone(contact_phone)) e.contact_phone = 'Not a valid phone number.'
    if (contact_email.trim() && !isEmail(contact_email)) e.contact_email = 'Not a valid email address.'
  }
  return e
}

/** Why a reply through the channel is not possible, or null when it is. Logging activity is always possible. */
export function replyBlockedReason(channel: Channel, status: string | null | undefined): string | null {
  if (channel === 'PHONE') return 'Calls are not sent from here; log the call instead.'
  const meta = integrationMeta(status)
  if (status === 'CONNECTED') return null
  return `${CHANNEL_LABELS[channel]} is ${meta.label.toLowerCase()}. Replies can be sent once the channel is connected; until then, log a reply you sent elsewhere.`
}

export interface TicketExportRow {
  ticket_number: string; subject: string; customer_name: string | null; customer_phone: string | null; customer_email: string | null; channel: string
  category: string | null; subcategory: string | null; priority: string; status: string; department: string | null; assigned_agent: string | null
  created_at: string; first_response_at: string | null; due_at: string | null; resolved_at: string | null; sla_status: string; merged_into: string | null
  related_reference: string | null; csat_rating: number | null
}
export const TICKET_EXPORT_HEADERS = ['Ticket', 'Subject', 'Customer', 'Phone', 'Email', 'Channel', 'Category', 'Subcategory', 'Priority', 'Status', 'Department',
  'Agent', 'Created', 'First response', 'Due', 'Resolved', 'SLA', 'Merged into', 'Related record', 'Satisfaction'] as const
export function ticketExportRows(rows: TicketExportRow[], dateTime: (iso: string) => string): (string | number)[][] {
  return rows.map((r) => [r.ticket_number, r.subject, r.customer_name ?? '', r.customer_phone ?? '', r.customer_email ?? '', CHANNEL_LABELS[r.channel as TicketChannel] ?? r.channel,
    r.category ?? '', r.subcategory ?? '', PRIORITY_META[r.priority as Priority]?.label ?? r.priority, TICKET_STATUS_META[r.status as TicketStatus]?.label ?? r.status,
    r.department ?? '', r.assigned_agent ?? '', dateTime(r.created_at), r.first_response_at ? dateTime(r.first_response_at) : '', r.due_at ? dateTime(r.due_at) : '',
    r.resolved_at ? dateTime(r.resolved_at) : '', SLA_META[r.sla_status]?.label ?? r.sla_status, r.merged_into ?? '', r.related_reference ?? '', r.csat_rating ?? ''])
}

/** Webhooks to create in Acefone (API Connect → Webhook), one per trigger. */
export const PHONE_WEBHOOK_EVENTS: [string, string][] = [
  ['received', 'Call received on Server'], ['ivr', 'Call answered on IVR'], ['dialed_agent', 'Dialed on Agent'], ['agent_answered', 'Call answered by Agent'],
  ['agent_hangup_answered', 'Call answered by Agent (Hangup)'], ['agent_hangup_missed', 'Call missed by Agent (Hangup)'], ['hangup', 'Call hangup (Missed or Answered)'],
  ['customer_answered', 'Call answered by Customer (Click to Call)'], ['customer_missed', 'Call missed by Customer (Click to Call)'],
]

/** Webhook URL with a placeholder where the secret goes; the secret itself is never shown or sent to the browser. */
export function phoneWebhookUrl(supabaseUrl: string, account: string, event: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/acefone-webhook?account=${account}&event=${event}&token=<ACEFONE_WEBHOOK_SECRET>`
}

// ---- Email (Google Workspace Gmail, 20261212090000) -----------------------------------
/** Outbound email state: Sent only after Gmail returned the message id. */
export const EMAIL_SEND_META: Record<'PENDING' | 'SENT' | 'FAILED', { label: string; tone: Tone; hint: string }> = {
  PENDING: { label: 'Pending', tone: 'warning', hint: 'Not confirmed by Gmail yet. The next mailbox sync confirms it if it was sent.' },
  SENT: { label: 'Sent', tone: 'success', hint: 'Gmail accepted the message.' },
  FAILED: { label: 'Failed', tone: 'danger', hint: 'Gmail refused the message or it could not be sent.' },
}

/** File types an agent may attach (checked again by the database and the Edge Function). */
export const EMAIL_ATTACHMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'txt', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']
export const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1048576
export const EMAIL_ATTACHMENT_MAX_FILES = 10

export function emailAttachmentProblem(files: { name: string; size: number }[]): string | null {
  if (files.length > EMAIL_ATTACHMENT_MAX_FILES) return `At most ${EMAIL_ATTACHMENT_MAX_FILES} attachments.`
  for (const f of files) {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(f.name)?.[1]?.toLowerCase()
    if (!ext || !EMAIL_ATTACHMENT_EXTENSIONS.includes(ext)) return `${f.name}: this file type cannot be sent. Allowed: PDF, images, text, CSV and Office documents.`
    if (f.size <= 0) return `${f.name} is empty.`
  }
  if (files.reduce((t, f) => t + f.size, 0) > EMAIL_ATTACHMENT_MAX_BYTES) return 'Attachments together must be at most 10 MB.'
  return null
}

/** "a@x.com, B <b@y.com>; c@z.com" → lower-case addresses; invalid entries are returned separately. */
export function parseRecipients(value: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = []
  const invalid: string[] = []
  for (const raw of value.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const inner = /<([^<>]+)>/.exec(raw)?.[1] ?? raw
    const e = inner.trim().toLowerCase()
    if (isEmail(e)) { if (!emails.includes(e)) emails.push(e) } else invalid.push(raw)
  }
  return { emails, invalid }
}

/** Reply recipients: the sender (or Reply-To); reply all adds the other To / Cc addresses except the support mailbox. */
export function replyRecipients(email: { direction: 'INBOUND' | 'OUTBOUND'; from_address: string | null; reply_to: string | null; to: { email: string }[]; cc: { email: string }[] },
  mailbox: string | null, all: boolean): { to: string[]; cc: string[] } {
  const own = (mailbox ?? '').toLowerCase()
  const to = email.direction === 'INBOUND' ? [email.reply_to ?? email.from_address].filter((x): x is string => Boolean(x)) : email.to.map((a) => a.email)
  if (!all) return { to, cc: [] }
  const cc = [...email.to, ...email.cc].map((a) => a.email.toLowerCase()).filter((e, i, arr) => e !== own && !to.includes(e) && arr.indexOf(e) === i)
  return { to, cc }
}

export const replySubject = (subject: string | null) => `Re: ${(subject ?? '').replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim()}`

/** Messages for ?gmail=error&reason=… after the Google authorisation. */
export const GMAIL_CONNECT_REASONS: Record<string, string> = {
  denied: 'Access was not granted in the Google consent screen.',
  google_error: 'Google reported an error during the authorisation. Try again; if it repeats, check the OAuth consent screen setup.',
  no_code: 'Google returned no authorisation code. Start again.',
  scopes_missing: 'Google did not grant the Gmail read and send permissions. Allow all requested permissions.',
  wrong_mailbox: 'You signed in with another Google account than the support mailbox. Sign in as the support mailbox.',
  no_refresh_token: 'Google did not return offline access. Remove the app from the Google account’s third-party access and connect again.',
  state_used: 'This authorisation link was already used. Start again from Connect Google Workspace.',
  state_expired: 'The authorisation took longer than 10 minutes. Start again.',
  state_unknown: 'The authorisation was not started from this ERP. Start again.',
  state_invalid: 'The authorisation answer was invalid. Start again.',
  state_not_allowed: 'Your permission to manage integrations was removed during the authorisation.',
  exchange_failed: 'Google refused the authorisation code. Check the OAuth client secret and redirect URI, then try again.',
  not_configured: 'The Google OAuth secrets are not configured on the server.',
  profile_failed: 'The Gmail mailbox could not be read.',
  store_failed: 'The authorisation could not be stored.',
}

// ---- WhatsApp Cloud API (20261213090000) -----------------------------------------------
export const WA_SETUP_META: Record<string, { label: string; tone: Tone; hint: string }> = {
  NOT_CONFIGURED: { label: 'Not Configured', tone: 'neutral', hint: 'Enter the Meta identifiers and the Graph API version.' },
  NUMBER_ELIGIBILITY_PENDING: { label: 'Number Eligibility Pending', tone: 'warning', hint: 'Confirm how the number is used today, its Cloud API eligibility, and run Test connection.' },
  MIGRATION_REQUIRED: { label: 'Migration Required', tone: 'warning', hint: 'The number must be moved to the Cloud API through Meta’s supported migration first. The ERP never does this.' },
  COEXISTENCE_PENDING: { label: 'Coexistence Pending', tone: 'warning', hint: 'Coexistence onboarding through an approved Meta partner is not confirmed yet.' },
  WEBHOOK_PENDING: { label: 'Webhook Pending', tone: 'info', hint: 'Waiting for the webhook verification and a correctly signed event from Meta.' },
  CONNECTED: { label: 'Connected', tone: 'success', hint: 'Onboarding, number registration and webhook verification succeeded.' },
  ERROR: { label: 'Error', tone: 'danger', hint: 'The last connection test failed or Meta refused the access token.' },
}
export const WA_NUMBER_PATHS: Record<string, string> = {
  UNKNOWN: 'Not confirmed yet',
  BUSINESS_APP_ONLY: 'WhatsApp Business app only',
  CLOUD_API: 'Already on WhatsApp Business Platform / Cloud API (this WABA)',
  BSP: 'Connected through a Business Solution Provider (e.g. the current Zoho Bigin connection)',
  COEXISTENCE: 'Supported coexistence (WhatsApp Business app + Cloud API)',
}
/** Message status: only Meta's status webhooks move an outbound message past Pending. */
export const WA_STATUS_META: Record<string, { label: string; tone: Tone; hint: string }> = {
  RECEIVED: { label: 'Received', tone: 'neutral', hint: 'Received from the customer.' },
  PENDING: { label: 'Pending', tone: 'warning', hint: 'Not reported by Meta yet (accepted requests stay Pending until Meta reports Sent).' },
  SENT: { label: 'Sent', tone: 'info', hint: 'Meta reports the message as sent.' },
  DELIVERED: { label: 'Delivered', tone: 'success', hint: 'Delivered to the customer’s phone.' },
  READ: { label: 'Read', tone: 'success', hint: 'Read by the customer.' },
  FAILED: { label: 'Failed', tone: 'danger', hint: 'Meta could not send or deliver it.' },
}
export const WA_IMAGE_EXT = ['jpg', 'jpeg', 'png']
export const WA_DOCUMENT_EXT = ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']
export function waFileProblem(f: { name: string; size: number }): string | null {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(f.name)?.[1]?.toLowerCase() ?? ''
  if (WA_IMAGE_EXT.includes(ext)) return f.size > 5 * 1048576 ? 'Images can be at most 5 MB.' : f.size <= 0 ? 'The file is empty.' : null
  if (WA_DOCUMENT_EXT.includes(ext)) return f.size > 25 * 1048576 ? 'Documents can be at most 25 MB here.' : f.size <= 0 ? 'The file is empty.' : null
  return 'WhatsApp accepts JPEG / PNG images and PDF, text, Word, Excel and PowerPoint documents here.'
}
/** Placeholders of a template ({{1}} or {{name}}) in header and body, in order, and whether the ERP can send it. */
export function waTemplatePlaceholders(components: { type: string; format?: string; text?: string; buttons?: { url?: string }[] }[]): { vars: string[]; supported: boolean } {
  const find = (t?: string) => [...(t ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1])
  const header = components.find((c) => c.type.toUpperCase() === 'HEADER')
  const body = components.find((c) => c.type.toUpperCase() === 'BODY')
  const supported = !(header && (header.format ?? 'TEXT').toUpperCase() !== 'TEXT')
    && !components.some((c) => c.type.toUpperCase() === 'BUTTONS' && (c.buttons ?? []).some((b) => /\{\{/.test(b.url ?? '')))
  const vars = [...find(header?.text), ...find(body?.text)].filter((v, i, a) => a.indexOf(v) === i)
  return { vars, supported }
}
export function waTemplatePreview(components: { type: string; text?: string }[], values: Record<string, string>): string {
  const fill = (t?: string) => (t ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => values[k] || `{{${k}}}`)
  return components.filter((c) => ['HEADER', 'BODY', 'FOOTER'].includes(c.type.toUpperCase()) && c.text).map((c) => fill(c.text)).join('\n\n')
}
export function waWindowText(open: boolean, closesAt: string | null, now = Date.now()): string {
  if (!open || !closesAt) return 'Customer service window closed: only approved templates can be sent.'
  const mins = Math.max(0, Math.round((new Date(closesAt).getTime() - now) / 60000))
  return `Customer service window open for ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} (24 hours from the customer’s last message).`
}

// ---- Unified support (20261214090000) ---------------------------------------------------
/** CSV with quoting; text cells starting with = + - @ (or tab / CR) are prefixed so spreadsheets never run them as formulas. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
export function formatRemaining(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—'
  const abs = Math.abs(minutes)
  const text = abs >= 1440 ? `${Math.floor(abs / 1440)} d ${Math.floor((abs % 1440) / 60)} h` : abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`
  return minutes < 0 ? `${text} overdue` : `${text} left`
}
export const WEEKDAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']]
export const PROVIDER_LABELS: Record<string, string> = { ACEFONE: 'Acefone / Servetel (phone)', GOOGLE_WORKSPACE: 'Google Workspace (email)', META_WHATSAPP: 'Meta WhatsApp Cloud API' }
