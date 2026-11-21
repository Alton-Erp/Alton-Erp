// Customer Support pipelines (migration 20261227090000): board helpers, Manage Stages checks, and the rules that a
// move never writes the ticket status itself (existing update / reopen do), plus the page wiring.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkStages, moveCard, needsReopenReason, orderStages, sameStages, slaDeadline, slaRemaining, statusesFor } from '../../src/features/support/pipeline/pipeline-model.ts'
import type { BoardStage, PipelineCard, StageInput } from '../../src/services/pipelines.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')

const card = (id: string, stage: string, over: Partial<PipelineCard> = {}) => ({ id, ticket_number: id, subject: 's', stage_id: stage, stage_type: 'OPEN', outcome_type: null,
  first_response_at: null, first_response_due_at: null, due_at: null, sla_paused_at: null, ...over }) as PipelineCard
const stage = (id: string, cards: PipelineCard[], over: Partial<BoardStage> = {}) => ({ id, stage_name: id, stage_type: 'OPEN', outcome_type: null, display_order: 10, count: cards.length, cards, ...over }) as BoardStage
const input = (over: Partial<StageInput>): StageInput => ({ stage_name: 'X', stage_description: null, stage_type: 'OPEN', outcome_type: null, ticket_status: 'IN_PROGRESS', color: '#64748b', is_default: false, is_active: true, ...over })
const DEFAULTS = [input({ stage_name: 'New Ticket', ticket_status: 'NEW', is_default: true }), input({ stage_name: 'In Progress' }),
  input({ stage_name: 'Closed – Positive', stage_type: 'CLOSED', outcome_type: 'POSITIVE', ticket_status: 'RESOLVED' })]

describe('board', () => {
  it('moving a card updates both stages and their counts (optimistic), other stages untouched', () => {
    const s = [stage('a', [card('t1', 'a'), card('t2', 'a')]), stage('b', []), stage('c', [card('t3', 'c')])]
    const m = moveCard(s, 't1', 'b')
    assert.deepEqual(m.map((x) => [x.id, x.count, x.cards.map((c) => c.id).join()]), [['a', 1, 't2'], ['b', 1, 't1'], ['c', 1, 't3']])
    assert.equal(m[1].cards[0].stage_id, 'b')
    assert.equal(m[2], s[2])
    assert.equal(moveCard(s, 't1', 'a'), s)
  })
  it('a closed ticket moved to an open stage needs a reopen reason', () => {
    assert.equal(needsReopenReason({ stage_type: 'CLOSED' }, { stage_type: 'OPEN' }), true)
    assert.equal(needsReopenReason({ stage_type: 'CLOSED' }, { stage_type: 'CLOSED' }), false)
    assert.equal(needsReopenReason({ stage_type: 'OPEN' }, { stage_type: 'CLOSED' }), false)
  })
  it('SLA: the first-response deadline while there is no response, then resolution; none when closed or paused', () => {
    assert.equal(slaDeadline(card('t', 'a', { first_response_due_at: 'F', due_at: 'D' })), 'F')
    assert.equal(slaDeadline(card('t', 'a', { first_response_at: 'x', first_response_due_at: 'F', due_at: 'D' })), 'D')
    assert.equal(slaDeadline(card('t', 'a', { stage_type: 'CLOSED', due_at: 'D' })), null)
    assert.equal(slaDeadline(card('t', 'a', { sla_paused_at: 'p', due_at: 'D' })), null)
    const now = Date.parse('2026-11-21T10:00:00Z')
    assert.deepEqual(slaRemaining('2026-11-21T12:15:00Z', now), { text: '2 h 15 min left', overdue: false })
    assert.deepEqual(slaRemaining('2026-11-21T09:30:00Z', now), { text: '30 min overdue', overdue: true })
    assert.equal(slaRemaining(null, now), null)
  })
  it('open stages first, then closed, in display order', () => {
    const o = orderStages([{ stage_type: 'CLOSED', display_order: 1 }, { stage_type: 'OPEN', display_order: 20 }, { stage_type: 'OPEN', display_order: 10 }] as const)
    assert.deepEqual(o.map((x) => `${x.stage_type}${x.display_order}`), ['OPEN10', 'OPEN20', 'CLOSED1'])
  })
})

describe('Manage Stages checks', () => {
  it('the defaults pass', () => assert.equal(checkStages(DEFAULTS), null))
  it('names required and unique (any letter case)', () => {
    assert.equal(checkStages([...DEFAULTS, input({ stage_name: ' ' })]), 'Every stage needs a name.')
    assert.match(checkStages([...DEFAULTS, input({ stage_name: 'in progress' })]) ?? '', /unique/)
  })
  it('closed stages need an outcome; statuses must fit the stage type', () => {
    assert.match(checkStages([...DEFAULTS, input({ stage_name: 'Lost', stage_type: 'CLOSED', ticket_status: 'RESOLVED' })]) ?? '', /Positive or Negative/)
    assert.match(checkStages([...DEFAULTS, input({ stage_name: 'Odd', ticket_status: 'RESOLVED' })]) ?? '', /must fit/)
    assert.deepEqual(statusesFor('CLOSED'), ['RESOLVED', 'CLOSED'])
  })
  it('at least one active open and one active closed stage, exactly one default', () => {
    assert.match(checkStages(DEFAULTS.map((s) => (s.stage_type === 'CLOSED' ? { ...s, is_active: false } : s))) ?? '', /active Closed/)
    assert.match(checkStages(DEFAULTS.map((s) => (s.stage_type === 'OPEN' ? { ...s, is_active: false, is_default: false } : s))) ?? '', /active Open/)
    assert.match(checkStages(DEFAULTS.map((s) => ({ ...s, is_default: s.stage_type === 'OPEN' }))) ?? '', /exactly one default/)
  })
  it('unsaved changes are detected (order, names, flags)', () => {
    assert.ok(sameStages(DEFAULTS, DEFAULTS.map((s) => ({ ...s }))))
    assert.ok(!sameStages(DEFAULTS, [DEFAULTS[1], DEFAULTS[0], DEFAULTS[2]]))
    assert.ok(!sameStages(DEFAULTS, DEFAULTS.map((s, i) => (i === 1 ? { ...s, stage_name: 'Working' } : s))))
  })
})

describe('migration rules', () => {
  const m = src('supabase/migrations/20261227090000_support_pipelines.sql')
  const move = m.slice(m.indexOf('create or replace function private.support_ticket_move('), m.indexOf('create or replace function public.support_ticket_move_stage('))
  it('a move goes through the existing update / reopen functions and never writes the status itself', () => {
    assert.match(move, /perform public\.support_ticket_reopen\(p_ticket, p_note\)/)
    assert.match(move, /perform public\.support_ticket_update\(p_ticket, jsonb_build_object\('status'/)
    assert.doesNotMatch(move, /set status\s*=/)
    assert.match(move, /update public\.support_tickets set stage_id = p_stage/)
  })
  it('concurrent moves are refused with an expected-stage check under a row lock', () => {
    assert.match(m, /for update;\n\s+if not found then\n\s+raise exception 'Ticket not found in your company\.'[\s\S]*p_expected_stage is not null and t\.stage_id is distinct from p_expected_stage/)
  })
  it('existing tickets keep their status; no ticket rows are deleted; the ticket table is not recreated', () => {
    assert.doesNotMatch(m, /delete from public\.support_tickets|drop table if exists public\.support_tickets|create table if not exists public\.support_tickets /)
    assert.match(m, /update public\.support_tickets t set pipeline_id = p\.id,\n\s+stage_id = /)
  })
  it('the ticket creation function itself is unchanged (only the v2 wrapper passes the pipeline)', () => {
    assert.doesNotMatch(m, /create or replace function public\.support_ticket_create\(/)
    assert.match(m, /set_config\('app\.support_pipeline'/)
  })
})

describe('wiring', () => {
  it('Support Tickets: Pipeline view when available, the table otherwise; New Ticket creates into the viewed pipeline', () => {
    const page = src('src/pages/support/support-tickets-page.tsx')
    assert.match(page, /const showPipeline = Boolean\(pipelines\.data\) && view !== 'table'/)
    assert.match(page, /pipelineId=\{showPipeline \? boardPipeline : null\}/)
  })
  it('filters live in the URL (kept when coming back from a ticket); Kanban and List layouts', () => {
    const v = src('src/features/support/pipeline/pipeline-view.tsx')
    assert.match(v, /useSearchParams/)
    for (const k of ["'scope'", "'q'", "'priority'", "'agent'", "'customer'", "'category'", "'product'", "'from'", "'to'"]) assert.ok(v.includes(k), k)
    assert.match(v, /layout-board/)
    assert.match(v, /layout-list/)
  })
  it('moves: one at a time per card, restored on failure, reopen asks for a reason', () => {
    const v = src('src/features/support/pipeline/pipeline-view.tsx')
    assert.match(v, /if \(saving\.has\(card\.id\)\) return/)
    assert.match(v, /Restore the card where it was/)
    assert.match(v, /needsReopenReason\(card, to\)/)
  })
  it('cards open the existing ticket page (no second detail screen)', () => {
    assert.match(src('src/features/support/pipeline/pipeline-board.tsx'), /navigate\(`\/support\/tickets\/\$\{c\.id\}`\)/)
  })
})
