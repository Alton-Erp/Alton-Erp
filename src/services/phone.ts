import { FunctionsHttpError } from '@supabase/supabase-js'

import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'

/**
 * Acefone (Servetel) telephony (migration 20261211090000). The browser never sees an Acefone credential or a
 * provider recording link: calls are placed by the acefone-click-to-call Edge Function, and everything else
 * goes through permission-checked database functions.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export class PhoneServiceError extends Error {
  readonly callId: string | null
  readonly status: string | null
  constructor(message: string, callId: string | null = null, status: string | null = null) {
    super(message)
    this.callId = callId
    this.status = status
  }
}

/** Calls an acefone-* Edge Function; resolves only on success and throws a readable message otherwise. */
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
    const parsed = response ? await response.json().catch(() => null) as { error?: string; call_id?: string; status?: string } | null : null
    throw new PhoneServiceError(parsed?.error ?? `The telephony service answered HTTP ${response?.status ?? 500}.`, parsed?.call_id ?? null, parsed?.status ?? null)
  }
  const name = (error as { name?: string })?.name
  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') throw new PhoneServiceError('The telephony service could not be reached. The Edge Function may not be deployed yet.')
  throw new PhoneServiceError(describeDataError(error))
}

export type CallStatus = 'INITIATED' | 'RINGING' | 'CONNECTED' | 'COMPLETED' | 'MISSED' | 'FAILED'
export const FINAL_CALL_STATUSES: CallStatus[] = ['COMPLETED', 'MISSED', 'FAILED']

export interface PhoneLine { id: string; agent_number: string; label: string | null; agent_name: string; presence: string; mine: boolean }
export const fetchCallLines = () => rpc<PhoneLine[]>('support_call_lines')

export interface PlaceCall { customer_id?: string | null; ticket_id?: string | null; conversation_id?: string | null; number: string; line_id: string; idempotency_key: string }
export const placeCall = (p: PlaceCall) => invoke<{ call_id: string; status: CallStatus; request_state?: string; duplicate?: boolean; message?: string }>('acefone-click-to-call', { action: 'call', ...p })

export interface PhoneConfig {
  config: {
    channel_account_id: string; provider: string; toll_free_number: string | null; api_base_url: string; click_to_call_mode: 'AGENT' | 'SUPPORT'; default_caller_id: string | null
    api_token_secret: string; support_api_key_secret: string; webhook_secret_name: string; webhook_allowed_ips: string[]; recording_retrieval: boolean
    recording_retention_days: number; is_enabled: boolean; disconnected_at: string | null; last_event_at: string | null; last_sync_at: string | null
    last_sync_status: string | null; last_test_at: string | null; last_test_result: string | null
  } | null
  account: { id: string; status: string; status_detail: string | null; last_checked_at: string | null } | null
  lines: { id: string; agent_id: string; agent_name: string; presence: string; agent_active: boolean; user_id: string; agent_number: string; label: string | null; is_active: boolean }[]
  last_success_event_at: string | null
  events: { id: string; event_type: string; status: string | null; message: string | null; processing_result: string | null; processing_error: string | null
    replay_count: number; created_at: string; event: string | null }[] | null
}
export const fetchPhoneConfig = () => rpc<PhoneConfig>('support_phone_config_get')
export interface PhoneConfigSave {
  toll_free_number: string | null; api_base_url: string; click_to_call_mode: 'AGENT' | 'SUPPORT'; default_caller_id: string | null; webhook_allowed_ips: string[]
  recording_retrieval: boolean; recording_retention_days: number
}
export const savePhoneConfig = (p: PhoneConfigSave) => rpc<PhoneConfig>('support_phone_config_save', { p })
export const disconnectPhone = (reason: string) => rpc<void>('support_phone_disconnect', { p_reason: reason })
export const savePhoneLine = (id: string | null, p: { agent_id: string; agent_number: string; label: string | null; is_active: boolean }) => rpc<string>('support_phone_agent_save', { p_id: id, p })
export const replayPhoneEvent = (id: string) => rpc<{ result: string; status?: string; changed?: boolean }>('support_acefone_replay', { p_event: id })
export const fetchPhoneSecretStatus = () => invoke<{ configured: boolean; secrets: { api_token: boolean; support_api_key: boolean; webhook_secret: boolean } }>('acefone-click-to-call', { action: 'status' })
export const testPhoneConnection = () => invoke<{ ok: boolean; message: string }>('acefone-click-to-call', { action: 'test' })
export const syncCallRecords = () => invoke<{ results: { ok: boolean; records: number; message: string }[] }>('acefone-sync-cdr', {})
export const syncRecordings = () => invoke<{ results: { stored?: number; purged?: number; skipped?: string }[] }>('acefone-recording-sync', {})

export interface CallRow {
  id: string; direction: 'INBOUND' | 'OUTBOUND'; status: CallStatus; customer_id: string | null; customer_name: string | null; customer_number: string | null
  caller_number: string | null; destination_number: string | null; agent_name: string | null; ticket_id: string | null; ticket_number: string | null
  started_at: string | null; ended_at: string | null; ring_seconds: number | null; talk_seconds: number | null; disposition: string | null; has_recording: boolean; created_at: string
}
export const fetchCalls = (f: { direction?: string; status?: string; search?: string; customer_id?: string; ticket_id?: string; limit: number; offset: number }) =>
  rpc<{ total: number; rows: CallRow[] }>('support_call_list', { p: f })
export interface CallDetail {
  call: {
    id: string; direction: 'INBOUND' | 'OUTBOUND'; status: CallStatus; conversation_id: string | null; agent_number: string | null; agent_name: string | null
    caller_number: string | null; destination_number: string | null; customer_number_e164: string | null; caller_id_used: string | null; click_to_call_mode: string | null
    provider_ref_id: string | null; provider_call_id: string | null; provider_uuid: string | null; request_state: string | null; request_message: string | null
    disposition: string | null; hangup_cause: string | null; started_at: string | null; answered_at: string | null; ended_at: string | null; ring_seconds: number | null
    talk_seconds: number | null; duration_seconds: number | null; created_at: string
  }
  customer: { id: string; customer_code: string; display_name: string } | null
  ticket: { id: string; ticket_number: string; subject: string; status: string } | null
  agent: { id: string; display_name: string } | null
  initiated_by: string | null
  recording: { state: 'NONE' | 'AT_PROVIDER' | 'STORED' | 'PURGED'; attachment_id?: string; file_name?: string; storage_path?: string | null; restricted?: boolean }
  events: { event_name: string; from: string | null; to: string | null; occurred_at: string | null; at: string }[]
}
export const fetchCall = (id: string) => rpc<CallDetail>('support_call_detail', { p_id: id })
export interface LiveCall {
  id: string; direction: 'INBOUND' | 'OUTBOUND'; status: CallStatus; number: string | null; started_at: string; conversation_id: string | null; agent_name: string | null
  customer: { id: string; customer_code: string; display_name: string; company_name: string | null } | null; candidates: number
  open_tickets: { id: string; ticket_number: string; subject: string; status: string }[]; previous_calls: number; previous_conversations: number
}
export const fetchLiveCalls = () => rpc<LiveCall[]>('support_live_calls')
