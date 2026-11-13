import { FunctionsHttpError } from '@supabase/supabase-js'

import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import { SUPPORT_BUCKET } from '@/services/support'

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
