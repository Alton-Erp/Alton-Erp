/**
 * Customer Support pipelines (migration 20261227090000): pure helpers for the board, Manage Stages and the reports.
 * The database applies the same rules (and the ticket status rules behind every move).
 */
import type { TicketStatus } from '@/features/support/support-model'
import type { BoardStage, PipelineCard, Stage, StageInput, StageType } from '@/services/pipelines'

export const STAGE_COLORS = ['#3b82f6', '#0ea5e9', '#14b8a6', '#f59e0b', '#8b5cf6', '#64748b', '#16a34a', '#dc2626', '#e11d48', '#a16207'] as const

export const OPEN_STATUSES: TicketStatus[] = ['NEW', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL']
export const CLOSED_STATUSES: TicketStatus[] = ['RESOLVED', 'CLOSED']
export const statusesFor = (t: StageType) => (t === 'OPEN' ? OPEN_STATUSES : CLOSED_STATUSES)

export const SORTS = [
  ['created_desc', 'Created time (newest)'], ['created_asc', 'Created time (oldest)'], ['updated_desc', 'Updated time'], ['priority', 'Priority'], ['sla', 'SLA deadline'],
] as const
export const SCOPES = [['ALL', 'All tickets'], ['MINE', 'My tickets'], ['UNASSIGNED', 'Unassigned tickets'], ['OPEN', 'Open stages'], ['CLOSED', 'Closed stages']] as const

/** Open stages first, then closed, each in display order. */
export const orderStages = <T extends Pick<Stage, 'stage_type' | 'display_order'>>(stages: T[]) =>
  [...stages].sort((a, b) => (a.stage_type === b.stage_type ? a.display_order - b.display_order : a.stage_type === 'OPEN' ? -1 : 1))

/** "2 h 15 min left" / "3 h overdue" for an SLA deadline (business-hours due dates come from the server). */
export function slaRemaining(due: string | null, now = Date.now()): { text: string; overdue: boolean } | null {
  if (!due) return null
  const diff = new Date(due).getTime() - now
  const m = Math.round(Math.abs(diff) / 60000)
  const text = m >= 2880 ? `${Math.round(m / 1440)} d` : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`
  return diff >= 0 ? { text: `${text} left`, overdue: false } : { text: `${text} overdue`, overdue: true }
}

/** The SLA deadline that matters now: first response while none was given, otherwise resolution. */
export const slaDeadline = (c: Pick<PipelineCard, 'first_response_at' | 'first_response_due_at' | 'due_at' | 'stage_type' | 'sla_paused_at'>) =>
  c.stage_type === 'CLOSED' || c.sla_paused_at ? null : !c.first_response_at && c.first_response_due_at ? c.first_response_due_at : c.due_at

/** The board after moving one card (optimistic update; the server result replaces it, a failure restores the original). */
export function moveCard(stages: BoardStage[], cardId: string, toStage: string): BoardStage[] {
  const from = stages.find((s) => s.cards.some((c) => c.id === cardId))
  const to = stages.find((s) => s.id === toStage)
  if (!from || !to || from.id === to.id) return stages
  const card = from.cards.find((c) => c.id === cardId)!
  return stages.map((s) => s.id === from.id ? { ...s, count: s.count - 1, cards: s.cards.filter((c) => c.id !== cardId) }
    : s.id === to.id ? { ...s, count: s.count + 1, cards: [{ ...card, stage_id: to.id, stage_type: to.stage_type, outcome_type: to.outcome_type }, ...s.cards] } : s)
}

/** Moving a closed ticket to an open stage reopens it: the existing reopen rule asks for a reason. */
export const needsReopenReason = (card: Pick<PipelineCard, 'stage_type'>, to: Pick<Stage, 'stage_type'>) => card.stage_type === 'CLOSED' && to.stage_type === 'OPEN'

/** Manage Stages checks before saving (the database repeats them). */
export function checkStages(stages: StageInput[]): string | null {
  const names = new Set<string>()
  for (const s of stages) {
    const n = s.stage_name.trim()
    if (!n) return 'Every stage needs a name.'
    if (n.length > 60) return `Stage name "${n.slice(0, 20)}…" is too long (at most 60 characters).`
    if (names.has(n.toLowerCase())) return `Stage names must be unique in a pipeline: "${n}" is used twice.`
    names.add(n.toLowerCase())
    if (s.stage_type === 'CLOSED' && !s.outcome_type) return `Closed stage "${n}" needs a Positive or Negative outcome.`
    if (!statusesFor(s.stage_type).includes(s.ticket_status)) return `Stage "${n}": the ticket status must fit an ${s.stage_type.toLowerCase()} stage.`
    if (s.is_default && (!s.is_active || s.stage_type !== 'OPEN')) return 'The default stage must be an active Open stage.'
  }
  if (!stages.some((s) => s.stage_type === 'OPEN' && s.is_active)) return 'At least one active Open stage is needed.'
  if (!stages.some((s) => s.stage_type === 'CLOSED' && s.is_active)) return 'At least one active Closed stage is needed.'
  if (stages.filter((s) => s.is_default).length !== 1) return 'Choose exactly one default stage (an active Open stage) for new tickets.'
  return null
}

export const stageInputOf = (s: Stage): StageInput => ({ id: s.id, stage_name: s.stage_name, stage_description: s.stage_description, stage_type: s.stage_type, outcome_type: s.outcome_type,
  ticket_status: s.ticket_status, color: s.color, is_default: s.is_default, is_active: s.is_active })

const keyOf = (s: StageInput) => JSON.stringify([s.id ?? s.client_key, s.stage_name, s.stage_description ?? '', s.stage_type, s.outcome_type, s.ticket_status, s.color, s.is_default, s.is_active])
export const sameStages = (a: StageInput[], b: StageInput[]) => a.length === b.length && a.every((s, i) => keyOf(s) === keyOf(b[i]))

export const hoursText = (h: number | null) => (h === null || h === undefined ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h} h`)
