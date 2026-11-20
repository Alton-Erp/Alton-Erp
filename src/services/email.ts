import { FunctionsHttpError } from '@supabase/supabase-js'

import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import { closeFormDraft, fetchFormDraft, saveFormDraft } from '@/services/form-drafts'
import { fetchInbox, SUPPORT_BUCKET, type TagRef } from '@/services/support'

/**
 * Google Workspace Gmail for the Support Centre (migration 20261212090000). The browser never sees an OAuth
 * client secret, refresh token or access token: Google is reached only by the google-* Edge Functions, and
 * everything else goes through permission-checked database functions.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export class EmailServiceError extends Error {}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  let data: unknown
  let error: unknown
  try {
    ;({ data, error } = await requireSupabase().functions.invoke(fn, { body }))
  } catch (e) {
    error = e
  }
  if (!error) return data as T
  if (error instanceof FunctionsHttpError) {
    const response = error.context instanceof Response ? error.context : null
    const parsed = response ? await response.json().catch(() => null) as { error?: string } | null : null
    throw new EmailServiceError(parsed?.error ?? `The email service answered HTTP ${response?.status ?? 500}.`)
  }
  const name = (error as { name?: string })?.name
  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new EmailServiceError('The email service could not be reached. The Edge Function may not be deployed yet.')
  throw new EmailServiceError(describeDataError(error))
}

// ---- settings --------------------------------------------------------------------
export interface EmailConfig {
  config: {
    channel_account_id: string; provider: string; mailbox_address: string; display_name: string | null; signature: string | null; pubsub_topic: string | null
    push_enabled: boolean; mailbox_modify_enabled: boolean; initial_sync_days: number; max_attachment_mb: number; connected_address: string | null
    granted_scopes: string[]; last_history_id: string | null; watch_expiration: string | null; watch_renewed_at: string | null; watch_status: string | null
    last_push_at: string | null; last_sync_at: string | null; last_sync_status: string | null; last_full_sync_at: string | null; is_enabled: boolean
    connected_at: string | null; disconnected_at: string | null
  } | null
  account: { id: string; status: string; status_detail: string | null; last_checked_at: string | null; connected_at: string | null } | null
  has_credentials: boolean
  requested_scopes: string[]
  counts: { received: number; sent: number; pending: number; failed: number }
  events: { id: string; event_type: string; status: string | null; message: string | null; processing_result: string | null; processing_error: string | null
    replay_count: number; created_at: string; history_id: string | null }[]
}
export interface EmailConfigSave {
  mailbox_address: string; display_name: string | null; signature: string | null; pubsub_topic: string | null; push_enabled: boolean
  mailbox_modify_enabled: boolean; initial_sync_days: number; max_attachment_mb: number
}
export const fetchEmailConfig = () => rpc<EmailConfig>('support_email_config_get')
export const saveEmailConfig = (p: EmailConfigSave) => rpc<EmailConfig>('support_email_config_save', { p })

export interface GoogleStatus {
  secrets: { client_id: boolean; client_secret: boolean; redirect_uri: boolean; encryption_key: boolean; app_url: boolean; push_token: boolean; push_oidc: boolean; cron_secret: boolean }
  problems: string[]; redirect_uri: string; webhook_url: string
}
export const fetchGoogleStatus = () => invoke<GoogleStatus>('google-oauth-start', { action: 'status' })
export const startGoogleConnect = () => invoke<{ url: string }>('google-oauth-start', { action: 'start' })
export const testGoogleConnection = () => invoke<{ ok: boolean; message: string }>('google-oauth-start', { action: 'test' })
export const disconnectGoogle = (reason: string) => invoke<{ ok: boolean; revoked: boolean }>('google-oauth-start', { action: 'disconnect', reason })
export interface SyncResult { ok: boolean; kind: string; stored: number; duplicates: number; confirmed: number; failed: number; remaining: number; message: string }
export const syncMailboxNow = (full = false) => invoke<{ results: SyncResult[] }>('google-gmail-sync', { action: full ? 'full' : 'sync' })
export const replayGmailEvent = (eventId: string) => invoke<{ results: SyncResult[] }>('google-gmail-sync', { action: 'replay', event_id: eventId })
export const renewGmailWatch = () => invoke<{ results: { ok: boolean; message: string }[] }>('google-gmail-watch-renew', {})

export interface EmailTemplate { id: string; name: string; subject: string | null; body: string; is_active?: boolean; updated_at?: string }
export const fetchEmailTemplates = () => rpc<EmailTemplate[]>('support_email_templates_list')
export const saveEmailTemplate = (id: string | null, p: { name: string; subject: string | null; body: string; is_active: boolean }) => rpc<string>('support_email_template_save', { p_id: id, p })

// ---- agents ------------------------------------------------------------------------
export interface ComposeContext {
  configured: boolean; status: string; can_send: boolean; mailbox: string | null; display_name: string | null; signature: string | null
  mailbox_modify: boolean; max_attachment_mb: number; templates: EmailTemplate[]
}
export const fetchComposeContext = () => rpc<ComposeContext>('support_email_compose_context')

export interface EmailAddress { email: string; name: string | null }
export interface ThreadEmail {
  id: string; message_id: string; direction: 'INBOUND' | 'OUTBOUND'; from_address: string | null; from_name: string | null
  to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[]; reply_to: string | null; subject: string | null; body_text: string | null
  has_html: boolean; html_truncated: boolean; at: string; send_state: 'PENDING' | 'SENT' | 'FAILED' | null; send_error: string | null
  gmail_message_id: string | null; gmail_thread_id: string | null; rfc_message_id: string | null; in_reply_to: string | null; unread: boolean; author: string | null
  attachments: { id: string; file_name: string; content_type: string | null; size_bytes: number | null; inline: boolean; storage_path: string | null; restricted: boolean }[]
  skipped_attachments: { filename: string; state: string; reason: string | null }[]
}
export const fetchEmailThread = (conversationId: string) => rpc<ThreadEmail[]>('support_email_thread', { p_conversation: conversationId })
export const fetchEmailHtml = (emailId: string) => rpc<string | null>('support_email_html', { p_email: emailId })

export interface SendEmail {
  idempotency_key: string; mode: 'NEW' | 'REPLY' | 'REPLY_ALL'; reply_to_email_id?: string | null; conversation_id?: string | null; customer_id?: string | null
  ticket_id?: string | null; to: string[]; cc: string[]; bcc: string[]; subject?: string; body: string; template_id?: string | null; include_signature: boolean
  attachments: { path: string; file_name: string; content_type: string | null; size_bytes: number }[]
  /** 'markdown': the email editor's formatting; google-gmail-send builds the HTML part (20261222090000). Omitted: plain text. */
  format?: 'markdown'
}
export interface SendResult { email_id: string; conversation_id: string; send_state: 'SENT' | 'PENDING' | 'FAILED'; message: string }
export const sendEmail = (p: SendEmail) => invoke<SendResult>('google-gmail-send', { action: 'send', ...p })
export const mirrorMailboxRead = (conversationId: string) => invoke<{ skipped?: boolean; marked?: number }>('google-gmail-send', { action: 'mark_read', conversation_id: conversationId })

/** Uploads a file for one email (folder = the email's request key); the server checks type and size again. */
export async function uploadOutboxFile(companyId: string, key: string, file: File): Promise<SendEmail['attachments'][number]> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'file'
  const path = `${companyId}/outbox/${key}/${crypto.randomUUID().slice(0, 8)}-${safe}`
  const { error } = await requireSupabase().storage.from(SUPPORT_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (error) throw error
  return { path, file_name: file.name, content_type: file.type || null, size_bytes: file.size }
}

// ---- Email workspace (migration 20261222090000) ----------------------------------------------
export type MailboxFolder = 'INBOX' | 'STARRED' | 'SNOOZED' | 'SENT' | 'IMPORTANT' | 'ALL' | 'SPAM' | 'TRASH' | 'LABEL'
export interface MailboxQuery {
  folder: MailboxFolder; label?: string | null; q?: string; from?: string; to?: string; subject?: string; words?: string
  after?: string; before?: string; has_attachment?: boolean; unread?: boolean; limit: number; offset: number
}
export interface MailThreadRow {
  id: string; last_at: string; message_count: number; unread_count: number; starred: boolean; important: boolean; snoozed_until: string | null
  folder: 'INBOX' | 'ARCHIVE' | 'SPAM' | 'TRASH'; subject: string | null; snippet: string; last_direction: 'INBOUND' | 'OUTBOUND'
  last_send_state: 'PENDING' | 'SENT' | 'FAILED' | null; from_name: string | null; from_address: string | null; to: EmailAddress[]; senders: string[]
  has_attachment: boolean; labels: TagRef[]; customer_name: string | null; ticket_id: string | null; ticket_number: string | null
  assigned_agent: string | null; status: string
}
export interface MailboxPage {
  total: number; rows: MailThreadRow[]; counts: Record<string, number>; labels: (TagRef & { unread: number })[]
  /** True before the migration: the unified inbox is shown, without folders, stars or labels. */
  legacy?: boolean
}
const missingFunction = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return x?.code === 'PGRST202' || x?.code === '42883' || /could not find the function/i.test(x?.message ?? '')
}
export async function fetchMailbox(q: MailboxQuery): Promise<MailboxPage> {
  try {
    const page = await rpc<MailboxPage | null>('support_email_mailbox', { p: q })
    if (page) return page
  } catch (e) {
    if (!missingFunction(e)) throw e
  }
  // Before 20261222090000: the unified inbox's email conversations (Inbox and All mail only; nothing else is guessed).
  if (q.folder !== 'INBOX' && q.folder !== 'ALL') return { total: 0, rows: [], counts: {}, labels: [], legacy: true }
  const search = [q.q, q.from, q.to, q.subject, q.words].filter(Boolean).join(' ')
  const page = await fetchInbox('ALL', { channel: 'EMAIL', search, limit: q.limit, offset: q.offset })
  return {
    total: page.total, counts: {}, labels: [], legacy: true,
    rows: page.rows.map((r) => ({
      id: r.id, last_at: r.last_activity_at, message_count: 0, unread_count: r.unread_count, starred: false, important: false, snoozed_until: null, folder: 'INBOX',
      subject: r.subject, snippet: r.last_message_preview ?? '', last_direction: 'INBOUND', last_send_state: null, from_name: r.customer_name, from_address: r.email,
      to: [], senders: [], has_attachment: false, labels: r.tags, customer_name: r.customer_name, ticket_id: r.ticket_id, ticket_number: r.ticket_number,
      assigned_agent: r.assigned_agent, status: r.status,
    })),
  }
}
export type MailboxAction = 'STAR' | 'UNSTAR' | 'IMPORTANT' | 'NOT_IMPORTANT' | 'SNOOZE' | 'UNSNOOZE' | 'ARCHIVE' | 'INBOX' | 'SPAM' | 'TRASH'
  | 'MARK_READ' | 'MARK_UNREAD' | 'LABEL_ADD' | 'LABEL_REMOVE'
export const mailboxAction = (ids: string[], action: MailboxAction, p: { until?: string; label?: string } = {}) =>
  rpc<{ updated: number; action: string }>('support_email_mailbox_action', { p_ids: ids, p_action: action, p })

// Drafts: the existing form drafts (form key support.email), private to their author. One draft per scope (its id).
export interface EmailDraftData {
  mode: 'NEW' | 'REPLY' | 'REPLY_ALL' | 'FORWARD'; to: string; cc: string; bcc: string; subject: string
  /** The editor content as markup (never HTML): restored through the same converter the server uses. */
  body: string; formatted: boolean
  reply_to_email_id?: string | null; conversation_id?: string | null
}
export interface EmailDraftRow { scope: string; last_saved_at: string; version: number; data: EmailDraftData | null }
export async function fetchEmailDrafts(): Promise<EmailDraftRow[]> {
  const mine = await rpc<{ form_key: string; scope: string; last_saved_at: string; version: number }[] | null>('erp_form_drafts_mine')
  const own = (mine ?? []).filter((d) => d.form_key === 'support.email').slice(0, 50)
  return Promise.all(own.map(async (d) => {
    const full = await fetchFormDraft({ formKey: 'support.email', recordId: null, scope: d.scope }).catch(() => null)
    return { scope: d.scope, last_saved_at: d.last_saved_at, version: full?.version ?? d.version, data: (full?.data as EmailDraftData | undefined) ?? null }
  }))
}
export const saveEmailDraft = (scope: string, data: EmailDraftData, expectedVersion: number) =>
  saveFormDraft({ formKey: 'support.email', recordId: null, scope }, data, null, expectedVersion)
export const closeEmailDraft = (scope: string, status: 'submitted' | 'discarded') => closeFormDraft({ formKey: 'support.email', recordId: null, scope }, status)

// ---- Per-message tools (migration 20261223090000) --------------------------------------------
export interface MailAttachment {
  id: string; file_name: string; content_type: string | null; size_bytes: number | null; storage_path: string | null; restricted: boolean
  /** The email it came with (list chips only). */
  email_id?: string
}
export interface RowAttachments { count: number; items: MailAttachment[] }
/** Attachment chips of the list rows (at most 8 per conversation, newest email first). Empty before the migration. */
export async function fetchListAttachments(ids: string[]): Promise<Record<string, RowAttachments>> {
  if (!ids.length) return {}
  try {
    return (await rpc<Record<string, RowAttachments> | null>('support_email_list_attachments', { p_ids: ids.slice(0, 100) })) ?? {}
  } catch (e) {
    if (missingFunction(e)) return {}
    throw e
  }
}
export interface MessageState { starred: boolean; starred_emails: string[] }
/** Which emails of a conversation carry the star; null before the migration (only the conversation's star exists). */
export async function fetchMessageState(conversationId: string): Promise<MessageState | null> {
  try {
    return await rpc<MessageState>('support_email_message_state', { p_conversation: conversationId })
  } catch (e) {
    if (missingFunction(e)) return null
    throw e
  }
}
export type MessageAction = 'STAR' | 'UNSTAR' | 'REPORT_SPAM' | 'REPORT_PHISHING'
export const messageAction = (emailId: string, action: MessageAction) =>
  rpc<MessageState & { folder: string }>('support_email_message_action', { p_email: emailId, p_action: action })
export interface OriginalHeaders { headers: { name: string; value: string }[]; size: number | null }
/** Gmail's own copy of the email (read-only, through google-gmail-send): headers, or the whole message base64url-encoded. */
export const fetchOriginalHeaders = (emailId: string) => invoke<OriginalHeaders>('google-gmail-send', { action: 'original', email_id: emailId })
export const fetchOriginalRaw = (emailId: string) => invoke<{ raw: string; size: number | null }>('google-gmail-send', { action: 'original', email_id: emailId, format: 'raw' })
/** A 5-minute signed link that downloads (Content-Disposition: attachment) instead of opening the file. */
export async function attachmentDownloadUrl(path: string, fileName: string): Promise<string> {
  const { data, error } = await requireSupabase().storage.from(SUPPORT_BUCKET).createSignedUrl(path, 300, { download: fileName })
  if (error) throw error
  return data.signedUrl
}
/** Several 5-minute signed links in one request (list thumbnails). Paths the user may not read come back without a URL. */
export async function attachmentUrls(paths: string[]): Promise<Record<string, string>> {
  const { data, error } = await requireSupabase().storage.from(SUPPORT_BUCKET).createSignedUrls(paths, 300)
  if (error) throw error
  return Object.fromEntries((data ?? []).flatMap((d) => (d.signedUrl && d.path ? [[d.path, d.signedUrl] as const] : [])))
}
