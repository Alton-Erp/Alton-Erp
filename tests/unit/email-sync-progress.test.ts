// Mailbox sync progress on Support Settings → Email (migration 20261224090000): what the status means, progress
// percentage, retry offer, and that the screen leaves the work to the server.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { lastBatchText, scheduleView, syncView } from '../../src/features/support/email-sync-model.ts'
import type { GmailSchedule, SyncStatus } from '../../src/services/email.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = (p: string) => readFileSync(path.join(root, p), 'utf8')
const none = { queue: 0, queue_ready: 0, failed: 0, attachments: 0, attachments_ready: 0, attachments_failed: 0, discovery: false }
const base = (o: Partial<SyncStatus> = {}): SyncStatus => ({ running: false, full_requested: false, batch_no: 3, last_batch_at: '2026-11-20T10:00:00Z',
  last_batch: { fetched: 12, stored: 10, duplicates: 2, failed: 0, attachments: 3, bytes: 4404019, duration_ms: 8100, ok: true }, last_error: null, last_error_stage: null,
  last_error_at: null, remaining: none, job: null, ...o })
const job = (o: Record<string, unknown> = {}) => ({ id: 'j', reason: 'MANUAL', status: 'RUNNING', days: 7, discovery_done: true, pages: 4, discovered: 1800, processed: 450,
  stored: 440, duplicates: 10, confirmed: 0, ignored: 0, failed: 0, batches: 40, remaining: 1350, started_at: '', finished_at: null, last_batch_at: null, last_error: null,
  failure_stage: null, ...o }) as SyncStatus['job']

describe('mailbox sync progress', () => {
  it('nothing left: up to date, not active', () => {
    const v = syncView(base())
    assert.equal(v.state, 'UP_TO_DATE')
    assert.equal(v.active, false)
    assert.equal(v.canRetry, false)
  })
  it('a full re-sync in progress: percentage of the messages it found, processed and remaining counts', () => {
    const v = syncView(base({ job: job(), remaining: { ...none, queue: 1350, queue_ready: 1350, attachments: 40, attachments_ready: 40 } }))
    assert.equal(v.state, 'CONTINUING')
    assert.equal(v.percent, 25)
    assert.ok(v.lines.some((l) => l.includes('450 of 1,800 new messages processed')))
    assert.ok(v.lines.some((l) => l.includes('1,350 messages waiting to be fetched')) && v.lines.some((l) => l.includes('40 attachments still downloading')))
    assert.equal(v.active, true)
  })
  it('while discovery is still finding messages there is no percentage yet', () => {
    const v = syncView(base({ job: job({ discovery_done: false, discovered: 1000, pages: 2 }), remaining: { ...none, discovery: true } }))
    assert.equal(v.percent, null)
    assert.ok(v.lines[0].includes('finding messages — 1,000 found so far (2 pages)'))
  })
  it('a batch running right now', () => {
    assert.equal(syncView(base({ running: true })).state, 'RUNNING')
  })
  it('work only waiting for a retry time is not shown as active', () => {
    const v = syncView(base({ remaining: { ...none, queue: 2, queue_ready: 0 } }))
    assert.equal(v.state, 'WAITING_RETRY')
    assert.equal(v.active, false)
    assert.ok(v.lines[0].includes('(2 waiting to retry)'))
  })
  it('failures after 5 attempts, a failed batch or a stopped job: needs attention, Retry offered', () => {
    assert.equal(syncView(base({ remaining: { ...none, failed: 1 } })).canRetry, true)
    assert.equal(syncView(base({ remaining: { ...none, attachments_failed: 2 } })).state, 'ATTENTION')
    const v = syncView(base({ last_batch: { ok: false }, last_error: 'Sync stopped at history: Gmail API error 503' }))
    assert.equal(v.state, 'ATTENTION')
    assert.equal(v.canRetry, true)
    assert.equal(syncView(base({ job: job({ status: 'FAILED', last_error: 'x' }) })).canRetry, true)
  })
  it('last batch summary', () => {
    assert.equal(lastBatchText(base().last_batch), '12 fetched (10 new), 3 attachments (4.2 MB) in 8.1 s')
    assert.equal(lastBatchText({}), null)
  })
  it('the screen never drives the sync itself: no browser timers call the sync function; buttons are locked while a run is active', () => {
    const c = src('src/features/support/email-sync-progress.tsx')
    assert.doesNotMatch(c, /setInterval|setTimeout/)
    assert.match(c, /disabled=\{running\}/)
    assert.match(c, /if \(inFlight\.current\) return/)
    assert.match(c, /you can leave this page/)
  })
})

// Migration 20261229090000: the automatic sync's real answers.
const sched = (o: Partial<GmailSchedule> = {}): GmailSchedule => ({ scheduler_available: true, scheduled: true, job: { schedule: '*/2 * * * *', active: true }, secrets_configured: true,
  last_run: { status: 'succeeded', start_time: '2026-11-21T09:36:00Z', message: '1 row' }, health: 'OK', diagnosis: null, calls: [],
  last_call: { id: 9, called_at: '2026-11-21T09:36:00Z', outcome: 'requested', answered: true, http_status: 200,
    result: { account: 'a', ok: true, message: 'Mailbox sync: 2 new emails.', queued: 2, discovered: 0, fetched: 2, stored: 2, remaining_detail: { queue: 1, queue_ready: 0, failed: 1, attachments: 0, attachments_failed: 0 } } },
  last_scheduled_success_at: '2026-11-21T09:36:00Z', last_invocation_at: '2026-11-21T09:36:00Z',
  mailbox: { last_batch_at: '2026-11-21T09:36:00Z', last_success_at: '2026-11-21T09:36:00Z', last_error: null, last_error_at: null, history_at: null },
  last_email_stored_at: '2026-11-21T09:35:50Z', emails_stored_24h: 2, ...o })
const fmt = (iso: string) => iso.slice(11, 16)

describe('automatic sync status (no more "Up to date" while the scheduler fails)', () => {
  it('scheduler refused (HTTP 401) while pg_cron says "succeeded": never "Up to date"', () => {
    const failing = sched({ health: 'FAILING', diagnosis: 'google-gmail-sync refused the scheduler (HTTP 401)…',
      last_call: { id: 9, called_at: '2026-11-21T09:36:00Z', outcome: 'requested', answered: true, http_status: 401, refusal: 'Not allowed.', result: null } })
    assert.equal(syncView(base(), failing).state, 'AUTO_SYNC_FAILING')
    assert.equal(syncView(base(), failing).label, 'Automatic sync failing')
    const v = scheduleView(failing, fmt)!
    assert.match(v.problem ?? '', /HTTP 401/)
    assert.equal(v.facts.find(([k]) => k === 'Last scheduled result')?.[1], '09:36: HTTP 401 — Not allowed.')
  })
  it('working scheduler: "Up to date" only when nothing is left', () => {
    assert.equal(syncView(base(), sched()).state, 'UP_TO_DATE')
    assert.equal(syncView(base(), sched({ health: 'NOT_CONFIGURED' })).state, 'AUTO_SYNC_FAILING')
    assert.equal(syncView(base()).state, 'UP_TO_DATE') // before the database update: as before
  })
  it('separate facts: scheduler, last invocation, last result, last Gmail success, last email stored, discovered / fetched, pending, failed, last error', () => {
    const v = scheduleView(sched({ mailbox: { last_batch_at: null, last_success_at: null, last_error: 'Gmail API error 503', last_error_at: '2026-11-21T09:30:00Z', history_at: null } }), fmt)!
    const f = Object.fromEntries(v.facts)
    assert.equal(f['Automatic scheduler'], 'every 2 minutes (*/2 * * * *)')
    assert.equal(f['Last scheduled invocation'], '09:36')
    assert.equal(f['Last successful Gmail sync'], '09:36')
    assert.equal(f['Last email received and stored'], '09:35 (2 in the last 24 hours)')
    assert.equal(f['Last scheduled run'], '2 discovered, 2 fetched, 2 new stored')
    assert.equal(f['Messages pending'], '1 (1 waiting to retry)')
    assert.equal(f['Failed (after 5 attempts)'], '1 messages, 0 attachments')
    assert.equal(f['Last sync error'], 'Gmail API error 503 (09:30)')
    assert.equal(v.problem, null)
  })
  it('before the database update there is no scheduler view (the earlier line is kept)', () => {
    assert.equal(scheduleView(sched({ health: undefined }), fmt), null)
  })
})
