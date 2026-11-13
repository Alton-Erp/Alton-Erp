import { requireSupabase } from '@/lib/supabase'
import type { Channel, ConversationStatus, InboxView, IntegrationStatus, Presence, Priority, TicketChannel, TicketStatus } from '@/features/support/support-model'

/**
 * Support Centre (migration 20261210090000). Every read and write goes through the support_* database
 * functions, which check the support.* permissions and the company; the tables are read-only to the app.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface Page<T> { total: number; rows: T[] }
export interface TagRef { id: string; name: string; color: string }

export interface ChannelHealth { channel: Channel; status: IntegrationStatus; accounts: number }
export const fetchChannelStatus = () => rpc<ChannelHealth[]>('support_channel_status')

// --- Overview / reports ---------------------------------------------------------------------
export interface SupportOverview {
  from: string; to: string; today: string; generated_at: string
  kpis: {
    total_tickets: number; open_tickets: number; unassigned_tickets: number; pending_customer: number; resolved_tickets: number; overdue_tickets: number
    calls_today: number; missed_calls: number; whatsapp_conversations: number; incoming_emails: number
    avg_first_response_minutes: number | null; avg_resolution_minutes: number | null; csat_average: number | null; csat_responses: number
  }
  by_channel: { channel: TicketChannel; tickets: number }[]
  by_status: { status: TicketStatus; tickets: number }[]
  daily: { day: string; created: number; resolved: number }[]
  sla: { met: number; breached: number; no_sla: number }
  resolution_buckets: { bucket: string; tickets: number }[]
  agents: AgentPerformance[] | null
  channels: ChannelHealth[]
}
export interface AgentPerformance {
  agent_id: string; name: string; presence: Presence; is_active: boolean; assigned_open: number; resolved: number
  avg_resolution_minutes: number | null; sla_met: number; sla_breached: number; open_conversations: number
}
export interface SupportReports extends SupportOverview {
  by_category: { category: string; tickets: number }[]
  by_priority: { priority: Priority; tickets: number }[]
  calls: { inbound: number; outbound: number; answered: number; missed: number; avg_duration_seconds: number | null }
  messages: { whatsapp_inbound: number; whatsapp_outbound: number; email_inbound: number; email_outbound: number }
  csat: { rating: number; tickets: number }[]
  reopened: number
}
export const fetchSupportOverview = (from: string, to: string) => rpc<SupportOverview>('support_overview', { p_from: from, p_to: to })
export const fetchSupportReports = (from: string, to: string) => rpc<SupportReports>('support_reports', { p_from: from, p_to: to })

// --- Inbox / conversations ------------------------------------------------------------------
export interface InboxRow {
  id: string; channel: Channel; subject: string | null; status: ConversationStatus; priority: Priority; customer_id: string | null; customer_name: string | null
  phone: string | null; email: string | null; last_message_preview: string | null; last_activity_at: string; unread_count: number
  assigned_agent_id: string | null; assigned_agent: string | null; ticket_id: string | null; ticket_number: string | null; tags: TagRef[]
}
export interface InboxPage extends Page<InboxRow> { me: string | null; counts: Record<string, number> }
export const fetchInbox = (view: InboxView, opts: { channel?: Channel | null; search?: string; limit: number; offset: number; customerId?: string | null }) =>
  rpc<InboxPage>('support_inbox', { p_view: view, p_channel: opts.channel ?? null, p_search: opts.search?.trim() || null, p_limit: opts.limit, p_offset: opts.offset,
    p_customer: opts.customerId ?? null })

export interface TimelineItem {
  type: 'message' | 'email' | 'call' | 'note' | 'attachment' | 'event'; id: string; at: string; direction?: 'INBOUND' | 'OUTBOUND'; source?: 'CHANNEL' | 'MANUAL'
  body?: string | null; email_subject?: string | null; call_status?: string | null; duration_seconds?: number | null; delivery_status?: string | null
  author?: string | null; file_name?: string; content_type?: string | null; size_bytes?: number | null; is_recording?: boolean; is_sensitive?: boolean
  storage_path?: string | null; restricted?: boolean; event_type?: string; from?: string | null; to?: string | null
}
export interface CustomerRef { id: string; customer_code: string; display_name: string; company_name?: string | null; phones?: string[]; emails?: string[]; matched_on?: string[] }
export interface ConversationDetail {
  conversation: { id: string; channel: Channel; subject: string | null; status: ConversationStatus; priority: Priority; customer_id: string | null; ticket_id: string | null
    contact_name: string | null; contact_phone: string | null; contact_email: string | null; assigned_agent_id: string | null; unread_count: number
    last_activity_at: string; created_at: string }
  channel_status: IntegrationStatus
  customer: CustomerRef | null
  candidates: CustomerRef[]
  ticket: { id: string; ticket_number: string; subject: string; status: TicketStatus; priority: Priority; sla_status: string } | null
  agent: { id: string; display_name: string } | null
  tags: TagRef[]
  timeline: TimelineItem[]
}
export const fetchConversation = (id: string) => rpc<ConversationDetail>('support_conversation_detail', { p_id: id })

export interface NewConversation {
  channel: Channel; direction: 'INBOUND' | 'OUTBOUND'; customer_id?: string | null; contact_name?: string; contact_phone?: string; contact_email?: string
  subject?: string; body?: string; call_status?: string; call_duration_seconds?: number | null; priority?: Priority
}
export const createConversation = (p: NewConversation) =>
  rpc<{ id: string; customer_id: string | null; match: 'PROVIDED' | 'MATCHED' | 'AMBIGUOUS' | 'NO_MATCH'; candidates: { id: string; matched_on: string[] }[] }>(
    'support_conversation_create', { p })
export const addMessage = (conversationId: string, p: { mode: 'REPLY' | 'LOG'; body?: string; direction?: 'INBOUND' | 'OUTBOUND'; call_status?: string;
  call_duration_seconds?: number | null; email_subject?: string }) => rpc<{ id: string; delivery_status: string | null }>('support_message_add', { p_conversation: conversationId, p })
export const updateConversation = (id: string, p: { status?: ConversationStatus; priority?: Priority; subject?: string }) => rpc<void>('support_conversation_update', { p_id: id, p })
export const assignConversation = (id: string, agentId: string | null) => rpc<void>('support_conversation_assign', { p_id: id, p_agent: agentId })
export const setConversationTags = (id: string, tagIds: string[]) => rpc<void>('support_conversation_set_tags', { p_id: id, p_tags: tagIds })
export const markConversationRead = (id: string) => rpc<void>('support_conversation_mark_read', { p_id: id })
export const linkConversationCustomer = (id: string, customerId: string | null) => rpc<void>('support_conversation_link_customer', { p_id: id, p_customer: customerId })
export const addNote = (target: 'CONVERSATION' | 'TICKET' | 'CUSTOMER', id: string, body: string) => rpc<string>('support_note_add', { p_target: target, p_id: id, p_body: body })

// --- Customers ------------------------------------------------------------------------------
export interface CustomerRow {
  id: string; customer_code: string; display_name: string; company_name: string | null; phones: string[]; emails: string[]
  erp_customer_id: string | null; erp_customer_code: string | null; open_tickets: number; conversations: number; last_activity_at: string | null
}
export const fetchCustomers = (search: string, limit: number, offset: number) =>
  rpc<Page<CustomerRow>>('support_customer_list', { p_search: search.trim() || null, p_limit: limit, p_offset: offset })
export const findCustomerMatches = (phone: string | null, email: string | null) => rpc<CustomerRef[]>('support_customer_matches', { p_phone: phone, p_email: email })
export interface CustomerSave { display_name: string; company_name?: string | null; phones: string[]; emails: string[]; address?: string | null; notes?: string | null; erp_customer_id?: string | null }
export const saveCustomer = (id: string | null, p: CustomerSave, allowDuplicate = false) =>
  rpc<{ ok: boolean; id?: string; customer_code?: string; duplicates: { id: string; customer_code: string; display_name: string }[] }>(
    'support_customer_save', { p_id: id, p, p_allow_duplicate: allowDuplicate })
export interface CustomerProfile {
  customer: { id: string; customer_code: string; display_name: string; company_name: string | null; phones: string[]; emails: string[]; address: string | null
    erp_customer_id: string | null; notes: string | null; created_at: string }
  erp_customer: { id: string; customer_code: string; customer_name: string; contact_email: string | null; gstin: string | null; billing_address: string | null; status: string } | null
  tickets: { id: string; ticket_number: string; subject: string; status: TicketStatus; priority: Priority; channel: TicketChannel; created_at: string; sla_status: string }[]
  conversations: { id: string; channel: Channel; subject: string | null; status: ConversationStatus; last_message_preview: string | null; last_activity_at: string }[]
  calls: { id: string; conversation_id: string; direction: string; call_status: string; duration_seconds: number | null; occurred_at: string; summary: string | null; source: string }[]
  emails: { id: string; conversation_id: string; direction: string; subject: string | null; occurred_at: string; source: string }[]
  notes: { id: string; body: string; author: string | null; created_at: string }[]
  orders: { id: string; number: string; order_date: string; status: string; value: number }[] | null
  invoices: { id: string; number: string; invoice_date: string; status: string; value: number }[] | null
}
export const fetchCustomerProfile = (id: string) => rpc<CustomerProfile>('support_customer_profile', { p_id: id })
export async function fetchErpCustomerOptions(): Promise<{ id: string; customer_code: string; customer_name: string }[]> {
  const { data, error } = await requireSupabase().from('customers').select('id, customer_code, customer_name').eq('status', 'ACTIVE').order('customer_name').limit(1000)
  if (error) throw error
  return (data ?? []) as { id: string; customer_code: string; customer_name: string }[]
}

// --- Tickets --------------------------------------------------------------------------------
export interface TicketRow {
  id: string; ticket_number: string; subject: string; customer_id: string | null; customer_name: string | null; customer_phone: string | null; customer_email: string | null
  channel: TicketChannel; category: string | null; subcategory: string | null; priority: Priority; status: TicketStatus; department: string | null
  assigned_agent_id: string | null; assigned_agent: string | null; created_at: string; first_response_at: string | null; due_at: string | null
  resolved_at: string | null; closed_at: string | null; sla_status: string; merged_into: string | null; related_type: string | null; related_reference: string | null
  csat_rating: number | null; reopen_count: number
}
export interface TicketFilters {
  status?: string; statuses?: string[]; priority?: string; channel?: string; agent_id?: string; unassigned?: boolean; sla?: string; customer_id?: string
  from?: string; to?: string; search?: string; sort?: 'created_desc' | 'created_asc' | 'due_asc' | 'priority' | 'updated_desc'; limit: number; offset: number
}
export const fetchTickets = (f: TicketFilters) => rpc<Page<TicketRow>>('support_ticket_list', { p: f })
export interface TicketCreate {
  subject: string; customer_id?: string | null; customer_phone?: string | null; customer_email?: string | null; conversation_id?: string | null; channel?: TicketChannel
  priority: Priority; category?: string | null; subcategory?: string | null; department?: string | null; description?: string | null; assigned_agent_id?: string | null
  related_type?: string | null; related_reference?: string | null
}
export const createTicket = (p: TicketCreate) => rpc<{ id: string; ticket_number: string }>('support_ticket_create', { p })
export const updateTicket = (id: string, p: Record<string, unknown>) => rpc<void>('support_ticket_update', { p_id: id, p })
export const assignTicket = (id: string, agentId: string | null) => rpc<void>('support_ticket_assign', { p_id: id, p_agent: agentId })
export const mergeTicket = (source: string, target: string, reason: string) => rpc<void>('support_ticket_merge', { p_source: source, p_target: target, p_reason: reason })
export const reopenTicket = (id: string, reason: string) => rpc<void>('support_ticket_reopen', { p_id: id, p_reason: reason })
export const linkTicketConversation = (ticketId: string, conversationId: string) => rpc<void>('support_ticket_link_conversation', { p_ticket: ticketId, p_conversation: conversationId })
export interface TicketDetail {
  ticket: TicketRow & { description: string | null; first_response_due_at: string | null; csat_comment: string | null; related_id: string | null
    merged_into: { id: string; ticket_number: string } | null; merged_from: { id: string; ticket_number: string }[]; merged_into_ticket_id: string | null; updated_at: string }
  customer: CustomerRef | null
  agent: { id: string; display_name: string } | null
  sla_policy: { name: string; first_response_minutes: number; resolution_minutes: number } | null
  conversations: { id: string; channel: Channel; subject: string | null; status: ConversationStatus; last_message_preview: string | null; last_activity_at: string }[]
  events: { id: string; event_type: string; from: string | null; to: string | null; details: Record<string, unknown>; at: string; author: string | null }[]
  notes: { id: string; body: string; at: string; author: string | null }[]
  attachments: { id: string; file_name: string; content_type: string | null; size_bytes: number | null; is_sensitive: boolean; is_recording: boolean; at: string
    storage_path: string | null; restricted: boolean }[]
}
export const fetchTicket = (id: string) => rpc<TicketDetail>('support_ticket_detail', { p_id: id })

// --- Attachments ----------------------------------------------------------------------------
export const SUPPORT_BUCKET = 'support-attachments'
export async function uploadAttachment(companyId: string, target: { ticket_id?: string; conversation_id?: string }, file: File, sensitive: boolean) {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'file'
  const path = `${companyId}/${target.ticket_id ?? target.conversation_id}/${crypto.randomUUID()}-${safe}`
  const { error } = await requireSupabase().storage.from(SUPPORT_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (error) throw error
  return rpc<string>('support_attachment_register', { p: { ...target, file_name: file.name, storage_path: path, content_type: file.type || null, size_bytes: file.size, is_sensitive: sensitive } })
}
export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await requireSupabase().storage.from(SUPPORT_BUCKET).createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}

// --- Agents, workspace ----------------------------------------------------------------------
export interface Agent { id: string; user_id: string; display_name: string; department: string | null; presence: Presence; is_active: boolean; max_open_conversations: number }
export async function fetchAgents(): Promise<Agent[]> {
  const { data, error } = await requireSupabase().from('support_agents' as never).select('id, user_id, display_name, department, presence, is_active, max_open_conversations').order('display_name')
  if (error) throw error
  return (data ?? []) as unknown as Agent[]
}
export const saveAgent = (id: string | null, p: { user_id?: string; display_name: string; department?: string | null; max_open_conversations?: number; is_active?: boolean }) =>
  rpc<string>('support_agent_save', { p_id: id, p })
export const setPresence = (presence: Presence) => rpc<void>('support_agent_set_presence', { p_presence: presence })
export async function fetchCompanyUsers(): Promise<{ id: string; full_name: string | null; email: string }[]> {
  const { data, error } = await requireSupabase().from('profiles').select('id, full_name, email').eq('is_active', true).order('full_name')
  if (error) throw error
  return (data ?? []) as { id: string; full_name: string | null; email: string }[]
}
export interface Workspace {
  agent: Agent | null
  workload?: { open_conversations: number; unread: number; open_tickets: number; overdue_tickets: number; capacity: number }
  conversations?: { id: string; channel: Channel; subject: string | null; status: ConversationStatus; priority: Priority; customer_name: string | null; unread_count: number; last_activity_at: string }[]
  tickets?: { id: string; ticket_number: string; subject: string; status: TicketStatus; priority: Priority; due_at: string | null; sla_status: string }[]
  performance?: { resolved: number; avg_resolution_minutes: number | null; avg_first_response_minutes: number | null; sla_met: number; sla_breached: number; csat_avg: number | null }
  activity?: { id: string; action: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>; at: string }[]
}
export const fetchWorkspace = (from: string, to: string) => rpc<Workspace>('support_agent_workspace', { p_from: from, p_to: to })

// --- Settings -------------------------------------------------------------------------------
export async function fetchTags(): Promise<TagRef[]> {
  const { data, error } = await requireSupabase().from('support_tags' as never).select('id, name, color').order('name')
  if (error) throw error
  return (data ?? []) as unknown as TagRef[]
}
export const saveTag = (id: string | null, name: string, color: string) => rpc<string>('support_tag_save', { p_id: id, p_name: name, p_color: color })
export const deleteTag = (id: string) => rpc<void>('support_tag_delete', { p_id: id })

export interface SlaPolicy { id: string; name: string; priority: Priority | null; first_response_minutes: number; resolution_minutes: number; is_active: boolean }
export async function fetchSlaPolicies(): Promise<SlaPolicy[]> {
  const { data, error } = await requireSupabase().from('support_sla_policies' as never).select('id, name, priority, first_response_minutes, resolution_minutes, is_active').order('name')
  if (error) throw error
  return (data ?? []) as unknown as SlaPolicy[]
}
export const saveSlaPolicy = (id: string | null, p: Omit<SlaPolicy, 'id'>) => rpc<string>('support_sla_policy_save', { p_id: id, p })

export interface ChannelAccount {
  id: string; channel: Channel; display_name: string; identifier: string | null; provider: string | null; credentials_ref: string | null; status: IntegrationStatus
  status_detail: string | null; last_checked_at: string | null; connected_at: string | null; is_active: boolean
}
export async function fetchChannelAccounts(): Promise<ChannelAccount[]> {
  const { data, error } = await requireSupabase().from('support_channel_accounts' as never)
    .select('id, channel, display_name, identifier, provider, credentials_ref, status, status_detail, last_checked_at, connected_at, is_active').order('channel')
  if (error) throw error
  return (data ?? []) as unknown as ChannelAccount[]
}
export const saveChannelAccount = (id: string | null, p: { channel?: Channel; display_name: string; identifier?: string | null; provider?: string | null; credentials_ref?: string | null; is_active?: boolean }) =>
  rpc<ChannelAccount>('support_channel_account_save', { p_id: id, p })
export async function fetchIntegrationEvents(): Promise<{ id: string; channel_account_id: string; event_type: string; status: string | null; message: string | null; created_at: string }[]> {
  const { data, error } = await requireSupabase().from('support_integration_events' as never).select('id, channel_account_id, event_type, status, message, created_at')
    .order('created_at', { ascending: false }).limit(50)
  if (error) throw error
  return (data ?? []) as unknown as { id: string; channel_account_id: string; event_type: string; status: string | null; message: string | null; created_at: string }[]
}

export interface AutomationRule {
  id: string; name: string; trigger: 'TICKET_CREATED' | 'CONVERSATION_CREATED'; conditions: Record<string, string>; actions: Record<string, string>
  run_order: number; is_active: boolean; run_count: number; last_run_at: string | null
}
export async function fetchAutomationRules(): Promise<AutomationRule[]> {
  const { data, error } = await requireSupabase().from('support_automation_rules' as never)
    .select('id, name, trigger, conditions, actions, run_order, is_active, run_count, last_run_at').order('run_order').order('name')
  if (error) throw error
  return (data ?? []) as unknown as AutomationRule[]
}
export const saveAutomationRule = (id: string | null, p: Omit<AutomationRule, 'id' | 'run_count' | 'last_run_at'>) => rpc<string>('support_automation_rule_save', { p_id: id, p })

export interface KbArticle { id: string; title: string; body: string; category: string | null; tags: string[]; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; updated_at: string }
export async function fetchKbArticles(search: string, status: string | null): Promise<KbArticle[]> {
  let q = requireSupabase().from('support_kb_articles' as never).select('id, title, body, category, tags, status, updated_at').order('updated_at', { ascending: false }).limit(200)
  if (status) q = q.eq('status', status)
  const term = search.trim().replace(/[%,()]/g, ' ')
  if (term) q = q.or(`title.ilike.%${term}%,body.ilike.%${term}%,category.ilike.%${term}%`)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as KbArticle[]
}
export const saveKbArticle = (id: string | null, p: { title: string; body: string; category?: string | null; tags: string[]; status: string }) =>
  rpc<string>('support_kb_article_save', { p_id: id, p })

/** True when the database has not been updated with the Support Centre yet. */
export const isSupportMissing = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code
  return code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01'
}
