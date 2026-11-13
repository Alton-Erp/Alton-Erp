import { FunctionsHttpError } from '@supabase/supabase-js'

import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import { SUPPORT_BUCKET } from '@/services/support'

/**
 * Meta WhatsApp Cloud API (migration 20261213090000). The browser never sees the access token, app secret or
 * verify token: Meta is reached only by the whatsapp-* Edge Functions; everything else goes through
 * permission-checked database functions.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export class WhatsAppServiceError extends Error {}

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
    throw new WhatsAppServiceError(parsed?.error ?? `The WhatsApp service answered HTTP ${response?.status ?? 500}.`)
  }
  const name = (error as { name?: string })?.name
  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new WhatsAppServiceError('The WhatsApp service could not be reached. The Edge Function may not be deployed yet.')
  throw new WhatsAppServiceError(describeDataError(error))
}

export type WaSetupState = 'NOT_CONFIGURED' | 'NUMBER_ELIGIBILITY_PENDING' | 'MIGRATION_REQUIRED' | 'COEXISTENCE_PENDING' | 'WEBHOOK_PENDING' | 'CONNECTED' | 'ERROR'
export type WaNumberPath = 'UNKNOWN' | 'BUSINESS_APP_ONLY' | 'CLOUD_API' | 'BSP' | 'COEXISTENCE'

export interface WaConfig {
  config: {
    channel_account_id: string; business_portfolio_id: string | null; waba_id: string | null; phone_number_id: string | null; display_phone_number: string | null
    app_id: string | null; graph_api_version: string | null; number_path: WaNumberPath; setup_state: WaSetupState; integration_enabled: boolean
    enabled_at: string | null; webhook_verified_at: string | null; webhook_signed_event_at: string | null; last_webhook_at: string | null; last_inbound_at: string | null
    last_outbound_success_at: string | null; last_test_at: string | null; last_test_ok: boolean | null; last_test_result: string | null
    phone_info: Record<string, unknown>; templates_synced_at: string | null; last_error: string | null; last_error_at: string | null
  } | null
  account: { id: string; status: string; status_detail: string | null; last_checked_at: string | null } | null
  checklist_items: { key: string; label: string; required: boolean; done: boolean; note: string | null; by: string | null; at: string | null }[]
  templates: { id: string; name: string; language: string; category: string | null; status: string }[]
  counts: { received: number; sent: number; pending: number; failed: number; media_pending: number }
  events: { id: string; field: string; result: string; error: string | null; counts: Record<string, number>; replay_count: number; received_at: string; processed_at: string | null; purged: boolean }[]
}
export interface WaConfigSave {
  business_portfolio_id: string | null; waba_id: string | null; phone_number_id: string | null; display_phone_number: string | null; app_id: string | null
  graph_api_version: string | null; number_path: WaNumberPath
}
export const fetchWaConfig = () => rpc<WaConfig>('support_whatsapp_config_get')
export const saveWaConfig = (p: WaConfigSave) => rpc<WaConfig>('support_whatsapp_config_save', { p })
export const setWaChecklist = (key: string, done: boolean, note: string | null) => rpc<WaConfig>('support_whatsapp_checklist_set', { p_key: key, p_done: done, p_note: note })
export const setWaEnabled = (enabled: boolean, reason: string | null) => rpc<WaConfig>('support_whatsapp_set_enabled', { p_enabled: enabled, p_reason: reason })
export const replayWaEvent = (id: string) => rpc<{ result: string; messages?: number; statuses?: number; error?: string }>('support_whatsapp_event_replay', { p_event: id })

export interface WaWebhookCheck {
  secrets: { access_token: boolean; app_secret: boolean; verify_token: boolean; cron_secret: boolean }
  callback_url: string
  subscription: { checked: boolean; subscribed: boolean | null; message: string }
}
export const checkWaWebhook = () => invoke<WaWebhookCheck>('whatsapp-webhook-verify', { action: 'check' })
export const testWaConnection = () => invoke<{ results: { test?: { ok: boolean; message: string }; message?: string }[] }>('whatsapp-sync-status', { action: 'test' })
export const syncWaTemplates = () => invoke<{ results: { templates?: { ok: boolean; message: string }; message?: string }[] }>('whatsapp-sync-status', { action: 'templates' })
export const downloadWaMedia = (messageId?: string) => invoke<{ results: { id: string; state: string }[] }>('whatsapp-media-download', messageId ? { message_id: messageId } : {})

export type WaStatus = 'RECEIVED' | 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
export interface WaMessage {
  id: string; message_id: string; direction: 'INBOUND' | 'OUTBOUND'; type: string; body: string; at: string; status: WaStatus; status_at: string | null
  error_code: number | null; error_title: string | null; error_detail: string | null; media_state: string; media_error: string | null; media_filename: string | null
  media_mime: string | null; location: { latitude?: number; longitude?: number; name?: string; address?: string } | null; context_wa_message_id: string | null
  wa_message_id: string | null; template_name: string | null; author: string | null
  attachment: { id: string; file_name: string; content_type: string | null; size_bytes: number | null; storage_path: string | null; restricted: boolean } | null
}
export interface WaThread {
  contact: { wa_id: string | null; user_id: string | null; profile_name: string | null; last_inbound_at: string | null }
  window_open: boolean; window_closes_at: string | null; can_send: boolean; messages: WaMessage[]
}
export const fetchWaThread = (conversationId: string) => rpc<WaThread | null>('support_whatsapp_thread', { p_conversation: conversationId })
export interface WaTemplate { id: string; name: string; language: string; category: string | null; status: string; parameter_format: 'NAMED' | 'POSITIONAL' | null
  components: { type: string; format?: string; text?: string; buttons?: { type?: string; text?: string; url?: string }[] }[] }
export const fetchWaTemplates = () => rpc<WaTemplate[]>('support_whatsapp_templates_list')
export const fetchWaStatus = () => rpc<{ setup_state: WaSetupState; enabled: boolean; display_phone_number?: string | null; can_send: boolean }>('support_whatsapp_status_context')

export interface WaSendResult { id: string; conversation_id: string; status: WaStatus; message: string; error_code?: number | null }
export const sendWaText = (p: { idempotency_key: string; conversation_id: string; text: string; reply_to?: string | null }) =>
  invoke<WaSendResult>('whatsapp-send-message', { kind: 'TEXT', ...p })
export const sendWaMedia = (p: { idempotency_key: string; conversation_id: string; path: string; file_name: string; content_type: string | null; size_bytes: number; caption?: string | null; reply_to?: string | null }) =>
  invoke<WaSendResult>('whatsapp-send-message', { kind: 'MEDIA', ...p })
export const sendWaTemplate = (p: { idempotency_key: string; conversation_id?: string | null; to?: string | null; customer_id?: string | null; template_id: string; parameters: Record<string, string> }) =>
  invoke<WaSendResult>('whatsapp-send-template', { kind: 'TEMPLATE', ...p })

export async function uploadWaFile(companyId: string, key: string, file: File) {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'file'
  const path = `${companyId}/outbox/${key}/${safe}`
  const { error } = await requireSupabase().storage.from(SUPPORT_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (error) throw error
  return { path, file_name: file.name, content_type: file.type || null, size_bytes: file.size }
}
