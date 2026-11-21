import type { Priority, TicketStatus } from '@/features/support/support-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Customer Support pipelines (migration 20261227090000). Moves go through support_ticket_move_stage, which applies
 * the existing status, closure and reopen rules; every read and write checks permissions and the company.
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

export type StageType = 'OPEN' | 'CLOSED'
export type Outcome = 'POSITIVE' | 'NEGATIVE'
export interface Stage {
  id: string; stage_name: string; stage_description: string | null; stage_type: StageType; outcome_type: Outcome | null; ticket_status: TicketStatus
  display_order: number; color: string; is_default: boolean; is_active: boolean; tickets: number; used: boolean
}
export interface Pipeline { id: string; name: string; description: string | null; is_default: boolean; is_active: boolean; stamp: string; tickets: number; stages: Stage[] }
export interface PipelinesInfo {
  pipelines: Pipeline[]
  can: { create: boolean; update: boolean; delete: boolean; manage_stages: boolean; move: boolean; products: boolean }
}
/** Pipelines with their stages; null before the database update (the tickets page then keeps its table only). */
export async function fetchPipelines(): Promise<PipelinesInfo | null> {
  try {
    const r = await rpc<PipelinesInfo | null>('support_pipelines_list')
    return r && Array.isArray(r.pipelines) && r.pipelines.length ? r : null
  } catch (e) {
    if (missing(e)) return null
    throw e
  }
}

export interface PipelineCard {
  id: string; ticket_number: string; subject: string; customer_id: string | null; customer_name: string | null; customer_phone: string | null; customer_email: string | null
  priority: Priority; status: TicketStatus; category: string | null; assigned_agent_id: string | null; assigned_agent: string | null; created_at: string; updated_at: string
  due_at: string | null; first_response_due_at: string | null; first_response_at: string | null; sla_paused_at: string | null; sla_status: string
  stage_id: string; stage_type: StageType; outcome_type: Outcome | null; reopen_count: number
  products: { sku: string; name: string; quantity: number }[] | null
}
export interface BoardStage extends Stage { count: number; cards: PipelineCard[] }
export interface BoardFilters {
  pipeline_id?: string; scope?: string; search?: string; priority?: string; agent_id?: string; customer_id?: string; category?: string; product?: string
  from?: string; to?: string; sort?: string
}
export const fetchBoard = (f: BoardFilters) => rpc<{ pipeline_id: string; total: number; stages: BoardStage[] }>('support_pipeline_board', { p: { ...f, mode: 'board', per_stage: 100 } })
export const fetchPipelineList = (f: BoardFilters & { limit: number; offset: number }) =>
  rpc<{ pipeline_id: string; total: number; rows: PipelineCard[] }>('support_pipeline_board', { p: { ...f, mode: 'list' } })

export const moveTicketStage = (ticketId: string, stageId: string, expectedStageId: string | null, note?: string | null) =>
  rpc<{ id: string; stage_id: string; status: TicketStatus; sla_status?: string; unchanged?: boolean }>('support_ticket_move_stage',
    { p_ticket: ticketId, p_stage: stageId, p_expected_stage: expectedStageId, p_note: note ?? null })

export const savePipeline = (id: string | null, p: { name?: string; description?: string | null; is_default?: boolean; is_active?: boolean }) =>
  rpc<{ id: string; name: string; is_default: boolean; is_active: boolean }>('support_pipeline_save', { p_id: id, p })

export interface StageInput {
  id?: string | null; client_key?: string; stage_name: string; stage_description: string | null; stage_type: StageType; outcome_type: Outcome | null
  ticket_status: TicketStatus; color: string; is_default: boolean; is_active: boolean
}
export const saveStages = (pipelineId: string, stages: StageInput[], moves: Record<string, string>, stamp: string) =>
  rpc<{ stamp: string; moved: number; new_ids: Record<string, string> }>('support_pipeline_save_stages', { p_pipeline: pipelineId, p_stages: stages, p_moves: moves, p_stamp: stamp })

export interface StageInfo {
  pipeline: { id: string; name: string } | null; stage_id: string | null
  stages: { id: string; stage_name: string; stage_type: StageType; outcome_type: Outcome | null; ticket_status: TicketStatus; color: string; is_active: boolean }[]
  history: { id: string; from_stage: string | null; to_stage: string; from_status: string | null; to_status: string; source: string; notes: string | null; changed_at: string; changed_by: string | null; outcome_type: Outcome | null }[]
  can_move: boolean
}
/** Stage of a ticket; null before the database update. */
export async function fetchStageInfo(ticketId: string): Promise<StageInfo | null> {
  try { return await rpc<StageInfo | null>('support_ticket_stage_info', { p_ticket: ticketId }) } catch (e) { if (missing(e)) return null; throw e }
}

export interface PipelineReport {
  pipeline_id: string; from: string; to: string
  by_stage: { stage_id: string; stage_name: string; stage_type: StageType; outcome_type: Outcome | null; color: string; is_active: boolean; tickets: number; avg_hours: number | null; entered: number; conversion_percent: number | null }[]
  open: number; closed: number; positive: number; negative: number; awaiting_action: number; overdue: number; created_in_period: number; reopened: number; reopened_tickets: number
  by_agent: { agent_id: string | null; agent: string; stages: Record<string, number> }[]
  by_product: { product_id: string; sku: string; product_name: string; tickets: number; negative: number }[] | null
}
export async function fetchPipelineReport(pipelineId: string | null, from: string, to: string): Promise<PipelineReport | null> {
  try { return await rpc<PipelineReport | null>('support_pipeline_report', { p_pipeline: pipelineId, p_from: from, p_to: to }) } catch (e) { if (missing(e)) return null; throw e }
}
