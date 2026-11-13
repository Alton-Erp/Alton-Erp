import { FunctionsHttpError } from '@supabase/supabase-js'

import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'

/** Unified Support Centre (migration 20261214090000): ticket rules, business hours, escalation, SLA, reports, integration health. */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export interface TicketRules {
  ticket_mode: 'AGENT_REQUEST_ONLY' | 'EVERY_NEW_CONVERSATION'; new_conversation_priority: Priority; missed_call_enabled: boolean; missed_call_priority: Priority
  email_keywords_enabled: boolean; email_keywords: string[]; email_match_body: boolean; whatsapp_keywords_enabled: boolean; whatsapp_keywords: string[]
  keyword_priority: Priority; reopen_on_reply_enabled: boolean; escalate_on_breach_enabled: boolean; escalate_priorities: Priority[]; sla_warning_percent: number
}
export interface BusinessCalendar { enabled: boolean; timezone: string | null; working_days: number[]; start_time: string; end_time: string; pause_when_waiting_customer: boolean }
export interface EscalationLevel {
  id?: string; level: number; after_minutes: number; priorities: Priority[]; notify_assignee: boolean; notify_managers: boolean
  reassign_agent_id: string | null; set_department: string | null; raise_priority: boolean; is_active: boolean
}
export interface AssignmentRule { id: string; name: string; channel: string | null; priority: Priority | null; department: string | null; agent_id: string | null; run_order: number; is_active: boolean }
export interface AutomationSettings {
  rules: TicketRules; calendar: BusinessCalendar; holidays: { id: string; date: string; name: string }[]; levels: EscalationLevel[]; assignment: AssignmentRule[]; can_edit: boolean
}
export const fetchAutomationSettings = () => rpc<AutomationSettings>('support_automation_settings_get')
export const saveTicketRules = (p: Partial<TicketRules>) => rpc<AutomationSettings>('support_ticket_rules_save', { p })
export const saveBusinessCalendar = (p: BusinessCalendar) => rpc<AutomationSettings>('support_business_calendar_save', { p })
export const saveHoliday = (date: string, name: string, remove = false) => rpc<AutomationSettings>('support_holiday_save', { p_date: date, p_name: name, p_delete: remove })
export const saveEscalationLevel = (level: number, p: Partial<EscalationLevel>, remove = false) => rpc<AutomationSettings>('support_escalation_level_save', { p_level: level, p, p_delete: remove })
export const saveAssignmentRule = (id: string | null, p: Partial<AssignmentRule>, remove = false) => rpc<AutomationSettings>('support_assignment_rule_save', { p_id: id, p, p_delete: remove })
export const runSlaNow = () => rpc<{ warnings: number; breaches: number; escalations: number }>('support_sla_run_now')

export interface TicketSla {
  policy: { name: string; first_response_minutes: number; resolution_minutes: number } | null; status: string; business_hours: boolean
  paused: boolean; paused_since: string | null; paused_minutes: number
  first_response: { due_at: string | null; done_at: string | null; breached_at: string | null; breached: boolean; remaining_minutes: number | null }
  resolution: { due_at: string | null; done_at: string | null; breached_at: string | null; breached: boolean; remaining_minutes: number | null }
  history: { kind: 'WARNING' | 'BREACH' | 'ESCALATION'; target: string; level: number; at: string; details: Record<string, unknown> }[]
}
export const fetchTicketSla = (id: string) => rpc<TicketSla>('support_ticket_sla', { p_ticket: id })

export interface UnifiedReports {
  from: string; to: string
  channel_volume: { day: string; phone: number; whatsapp: number; email: number }[]
  channel_totals: { phone: number; whatsapp: number; email: number }
  calls: { inbound: number; answered: number; missed: number; answer_rate: number | null; missed_rate: number | null; avg_talk_seconds: number | null }
  response_times: Record<string, { turns: number; answered: number; avg_minutes: number | null; median_minutes: number | null; within_1h_percent: number | null }> | null
  tickets: { created: number; closed: number; closure_rate: number | null; resolved_in_period: number; open_now: number; reopened: number; by_channel: Record<string, number> | null }
  agents: { agent: string; open_tickets: number; open_conversations: number; resolved: number; replies: number }[]
  sla: { tickets: number; first_response_met: number; first_response_breached: number; resolution_met: number; resolution_breached: number; compliance_percent: number | null; escalations: number }
  csat: { responses: number; average: number | null; distribution: Record<string, number> | null }
}
export const fetchUnifiedReports = (from: string, to: string) => rpc<UnifiedReports>('support_reports_unified', { p_from: from, p_to: to })

export interface ProviderHealth {
  provider: 'ACEFONE' | 'GOOGLE_WORKSPACE' | 'META_WHATSAPP'; channel: string; configured: boolean; status: string; status_detail: string | null
  verified_by_test_at: string | null; last_sync_at: string | null; last_sync_status: string | null; last_webhook_at: string | null; last_outbound_at: string | null
  failed_events_7d: number; retry_queue: number; expired_credentials: boolean; errors: { at: string; message: string }[]; test_action: string
  setup_state?: string; enabled?: boolean
}
export const fetchIntegrationHealth = () => rpc<ProviderHealth[]>('support_integration_health')

/** Runs the provider's real API test through its Edge Function (never from the browser to the provider). */
export async function testProvider(p: ProviderHealth['provider']): Promise<string> {
  const [fn, body] = p === 'ACEFONE' ? ['acefone-click-to-call', { action: 'test' }] : p === 'GOOGLE_WORKSPACE' ? ['google-oauth-start', { action: 'test' }] : ['whatsapp-sync-status', { action: 'test' }]
  const { data, error } = await requireSupabase().functions.invoke(fn as string, { body })
  if (error) {
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      const j = await error.context.json().catch(() => null) as { error?: string } | null
      throw new Error(j?.error ?? `The ${fn} function answered HTTP ${error.context.status}.`)
    }
    throw new Error((error as { name?: string })?.name === 'FunctionsFetchError' ? `The ${fn} function could not be reached (not deployed?).` : describeDataError(error))
  }
  const d = data as { message?: string; results?: { test?: { message?: string } }[] }
  return d.message ?? d.results?.map((r) => r.test?.message).filter(Boolean).join(' ') ?? 'Test finished.'
}
