// Reading of the mailbox sync progress (support_email_sync_status) for the settings screen. No React; unit-tested in
// tests/unit/email-sync-progress.test.ts.
import type { GmailSchedule, SyncStatus } from '@/services/email'

export type SyncState = 'RUNNING' | 'CONTINUING' | 'WAITING_RETRY' | 'UP_TO_DATE' | 'ATTENTION' | 'AUTO_SYNC_FAILING'

export interface SyncView {
  state: SyncState
  label: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  /** Full re-sync progress 0–100 (null while messages are still being found, or without a running job). */
  percent: number | null
  /** One line per fact worth showing (counts, never content). */
  lines: string[]
  /** Something failed for good and Retry would put it back. */
  canRetry: boolean
  /** Work is in progress: poll often and keep the buttons from starting another run. */
  active: boolean
}

const n = (x: number) => x.toLocaleString('en-IN')
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`

/**
 * The mailbox state. "Up to date" needs the last batch to have succeeded, nothing left to fetch, and — when the
 * automatic sync is known (20261229090000) — its latest scheduled run to have synced this mailbox: a scheduler that
 * is refused or fails is never shown as up to date (the production fault: pg_cron "succeeded", Gmail never synced).
 */
export function syncView(s: SyncStatus, schedule?: GmailSchedule | null): SyncView {
  const r = s.remaining
  const job = s.job?.status === 'RUNNING' ? s.job : null
  const readyNow = r.queue_ready > 0 || r.attachments_ready > 0 || r.discovery
  const waiting = r.queue + r.attachments
  const failed = r.failed + r.attachments_failed
  const lines: string[] = []
  if (job) {
    lines.push(job.discovery_done
      ? `Full re-sync (last ${job.days} days): ${n(job.processed)} of ${n(job.processed + job.remaining)} new messages processed`
      : `Full re-sync (last ${job.days} days): finding messages — ${n(job.discovered)} found so far (${plural(job.pages, 'page')})`)
  } else if (s.full_requested) {
    lines.push('Full re-sync requested: it starts with the next batch.')
  }
  if (r.queue) lines.push(`${plural(r.queue, 'message')} waiting to be fetched${r.queue_ready < r.queue ? ` (${n(r.queue - r.queue_ready)} waiting to retry)` : ''}`)
  if (r.attachments) lines.push(`${plural(r.attachments, 'attachment')} still downloading${r.attachments_ready < r.attachments ? ` (${n(r.attachments - r.attachments_ready)} waiting to retry)` : ''}`)
  if (r.failed) lines.push(`${plural(r.failed, 'message')} could not be fetched after 5 attempts`)
  if (r.attachments_failed) lines.push(`${plural(r.attachments_failed, 'attachment')} could not be downloaded after 5 attempts`)
  if (s.job && s.job.status === 'COMPLETED' && !job) {
    lines.push(`Last full re-sync: ${n(s.job.stored)} new, ${n(s.job.duplicates)} already stored${s.job.failed ? `, ${n(s.job.failed)} failed` : ''}`)
  }
  if (s.job?.status === 'FAILED') lines.push(`Full re-sync stopped: ${s.job.last_error ?? 'unknown error'}`)
  const percent = job && job.discovery_done ? Math.min(100, Math.round((job.processed / Math.max(1, job.processed + job.remaining)) * 100)) : null
  const lastFailed = s.last_batch?.ok === false && Boolean(s.last_error)
  const canRetry = failed > 0 || s.job?.status === 'FAILED' || lastFailed
  const autoFailing = Boolean(schedule?.health) && ['FAILING', 'NOT_CONFIGURED', 'NOT_SCHEDULED'].includes(schedule!.health!)
  const state: SyncState = s.running ? 'RUNNING' : lastFailed || failed > 0 || s.job?.status === 'FAILED' ? 'ATTENTION'
    : readyNow || job || s.full_requested ? 'CONTINUING' : waiting > 0 ? 'WAITING_RETRY' : autoFailing ? 'AUTO_SYNC_FAILING' : 'UP_TO_DATE'
  const meta: Record<SyncState, [string, SyncView['tone']]> = {
    RUNNING: ['Syncing now', 'info'], CONTINUING: ['Sync in progress', 'info'], WAITING_RETRY: ['Waiting to retry', 'warning'],
    UP_TO_DATE: ['Up to date', 'success'], ATTENTION: ['Needs attention', 'danger'], AUTO_SYNC_FAILING: ['Automatic sync failing', 'danger'],
  }
  return { state, label: meta[state][0], tone: meta[state][1], percent, lines, canRetry, active: state === 'RUNNING' || state === 'CONTINUING' }
}

export interface ScheduleView {
  /** The automatic sync as one badge. */
  label: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  /** Shown as a warning: the scheduler is refused, fails or is not set up. */
  problem: string | null
  /** Separate facts: [label, value]. */
  facts: [string, string][]
}

/** The automatic (scheduled) sync from support_gmail_schedule_status; null before migration 20261229090000. */
export function scheduleView(sch: GmailSchedule, fmt: (iso: string) => string): ScheduleView | null {
  if (!sch.health) return null
  const meta: Record<NonNullable<GmailSchedule['health']>, [string, ScheduleView['tone']]> = {
    OK: ['Automatic sync working', 'success'], FAILING: ['Automatic sync failing', 'danger'], WAITING: ['Waiting for the first scheduled run', 'info'],
    NOT_CONFIGURED: ['Automatic sync not configured', 'warning'], NOT_SCHEDULED: ['Automatic sync not scheduled', 'warning'],
  }
  const call = sch.last_call ?? null
  const res = call?.result ?? null
  const rem = res?.remaining_detail ?? null
  const answer = !call ? '—' : call.outcome !== 'requested' ? call.outcome
    : call.timed_out ? 'timed out' : call.error ? `failed: ${call.error}`
    : `HTTP ${call.http_status}${call.refusal ? ` — ${call.refusal}` : res ? ` — ${res.message}` : ' — this mailbox was not processed'}`
  const lastSuccess = [sch.last_scheduled_success_at, sch.mailbox?.last_success_at].filter(Boolean).sort().at(-1) ?? null
  const facts: [string, string][] = [
    ['Automatic scheduler', sch.scheduled && sch.job?.active ? `every 2 minutes (${sch.job.schedule})` : 'not scheduled'],
    ['Last scheduled invocation', sch.last_invocation_at ? fmt(sch.last_invocation_at) : 'none yet'],
    ['Last scheduled result', call ? `${fmt(call.called_at)}: ${answer}` : 'no answer yet'],
    ['Last successful Gmail sync', lastSuccess ? fmt(lastSuccess) : 'none recorded'],
    ['Last email received and stored', sch.last_email_stored_at ? `${fmt(sch.last_email_stored_at)} (${sch.emails_stored_24h ?? 0} in the last 24 hours)` : 'none yet'],
  ]
  if (res) {
    facts.push(['Last scheduled run', `${(res.queued ?? 0) + (res.discovered ?? 0)} discovered, ${res.fetched ?? 0} fetched, ${res.stored ?? 0} new stored`])
    facts.push(['Messages pending', String(rem?.queue ?? 0) + (rem && rem.queue_ready < rem.queue ? ` (${rem.queue - rem.queue_ready} waiting to retry)` : '')])
    facts.push(['Failed (after 5 attempts)', `${rem?.failed ?? 0} messages, ${rem?.attachments_failed ?? 0} attachments`])
  }
  const lastError = sch.mailbox?.last_error ? `${sch.mailbox.last_error}${sch.mailbox.last_error_at ? ` (${fmt(sch.mailbox.last_error_at)})` : ''}` : null
  if (lastError) facts.push(['Last sync error', lastError])
  const failing = sch.health === 'FAILING' || sch.health === 'NOT_CONFIGURED' || sch.health === 'NOT_SCHEDULED'
  return { label: meta[sch.health][0], tone: meta[sch.health][1], problem: failing ? (sch.diagnosis ?? 'The automatic sync is not working.') : null, facts }
}

/** "12 fetched (10 new), 3 attachments (4.2 MB) in 8.1 s" for the last batch. */
export function lastBatchText(b: SyncStatus['last_batch']): string | null {
  if (!b || b.fetched === undefined) return null
  const parts = [`${n(b.fetched)} fetched${b.stored ? ` (${n(b.stored)} new)` : ''}`]
  if (b.attachments) parts.push(`${plural(b.attachments, 'attachment')} (${((b.bytes ?? 0) / 1048576).toFixed(1)} MB)`)
  if (b.failed) parts.push(`${n(b.failed)} to retry`)
  return `${parts.join(', ')}${b.duration_ms !== undefined ? ` in ${(b.duration_ms / 1000).toFixed(1)} s` : ''}`
}
