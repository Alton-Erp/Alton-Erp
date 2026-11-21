import { Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'

import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { lastBatchText, scheduleView, syncView } from '@/features/support/email-sync-model'
import { usePolled } from '@/features/support/wa-web/use-polled'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchGmailSchedule, fetchSyncStatus, retryMailboxSync, syncMailboxNow, type SyncResult } from '@/services/email'

/**
 * Sync now / Full re-sync with live progress (migration 20261224090000). The work runs on the server in small
 * batches that continue by themselves, so this page can be left at any time. While a run is active the buttons
 * stay disabled (one request per click), and the counts refresh every few seconds.
 */
export function EmailSyncPanel({ onNotice }: { onNotice: (n: { ok: boolean; text: string }) => void }) {
  const [active, setActive] = useState(false)
  const status = usePolled(() => fetchSyncStatus().catch(() => null), [], active ? 4000 : 30000)
  const schedule = usePolled(() => fetchGmailSchedule(), [], active ? 15000 : 60000)
  const sch = schedule.data
  const view = status.data ? syncView(status.data, sch) : null
  const auto = sch ? scheduleView(sch, (iso) => formatDateTime(iso)) : null
  if (view && view.active !== active) setActive(view.active)
  const [busy, setBusy] = useState<string | null>(null)
  // One request per click: a ref, because several clicks in one tick all see the same `busy` state.
  const inFlight = useRef(false)
  const go = async (name: string, fn: () => Promise<{ results: SyncResult[] }>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(name)
    try {
      const r = await fn()
      const text = r.results.map((x) => x.message + (x.continuing ? ' Continuing in the background — you can leave this page.' : '')).join(' ') || 'Synced.'
      onNotice({ ok: r.results.every((x) => x.ok), text })
    } catch (e) {
      onNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) })
    } finally {
      inFlight.current = false
      setBusy(null)
      status.reload()
    }
  }
  const running = busy !== null || Boolean(status.data?.running)
  const s = status.data
  const last = s ? lastBatchText(s.last_batch) : null
  return (
    <div className="space-y-3 rounded-md border px-3 py-3" data-testid="email-sync-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Mailbox synchronisation</span>
        {view && <span data-testid="email-sync-state" data-state={view.state}><StatusBadge label={view.label} tone={view.tone} /></span>}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={running} onClick={() => void go('sync', () => syncMailboxNow())} data-testid="email-sync-now">
            {busy === 'sync' || (s?.running && !busy) ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now</Button>
          <Button size="sm" variant="outline" disabled={running || (s?.job?.status === 'RUNNING')} onClick={() => void go('full', () => syncMailboxNow(true))} data-testid="email-sync-full"
            title={s?.job?.status === 'RUNNING' ? 'A full re-sync is already running' : undefined}>
            {busy === 'full' && <Loader2 className="animate-spin" />}Full re-sync</Button>
          {view?.canRetry && <Button size="sm" variant="outline" disabled={running} onClick={() => void go('retry', retryMailboxSync)} data-testid="email-sync-retry">
            {busy === 'retry' ? <Loader2 className="animate-spin" /> : <RotateCcw />}Retry</Button>}
        </span>
      </div>
      {s === null && <p className="text-xs text-muted-foreground">Progress appears once migration 20261224090000 is applied.</p>}
      {auto && (
        <div className="space-y-2 rounded-md bg-surface-muted/40 px-3 py-2" data-testid="email-auto-sync">
          <span data-testid="email-auto-sync-state" data-health={sch?.health}><StatusBadge label={auto.label} tone={auto.tone} /></span>
          {auto.problem && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert" data-testid="email-auto-sync-problem">
            {auto.problem} Until this is fixed, new mail arrives only with Sync now.</p>}
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
            {auto.facts.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-words" data-testid={`auto-${k.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{v}</dd></div>)}
          </dl>
        </div>
      )}
      {sch && !auto && (sch.scheduled && sch.job?.active && sch.secrets_configured
        ? <p className="text-xs text-muted-foreground" data-testid="email-sync-schedule">Automatic sync: every 2 minutes on the server (no need to keep this page open).
            {sch.last_run ? ` Last scheduled run ${formatDateTime(sch.last_run.start_time)}: ${sch.last_run.status}.` : ''}</p>
        : <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert" data-testid="email-sync-schedule">
            Automatic sync is not running: {!sch.scheduler_available ? 'the database scheduler (pg_cron) is not available'
              : !sch.scheduled || !sch.job?.active ? 'the job alton-gmail-sync is not scheduled' : 'the Vault secrets alton_project_url / alton_gmail_cron_secret are missing'}.
            New mail arrives only with Sync now until it is set up (see the Gmail integration guide).</p>)}
      {view && view.percent !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-label="Full re-sync progress"
          data-testid="email-sync-bar"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${view.percent}%` }} /></div>
      )}
      {view && view.lines.length > 0 && <ul className="space-y-0.5 text-sm" data-testid="email-sync-lines">{view.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      {s?.last_error && s.last_batch?.ok === false && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert" data-testid="email-sync-error">
          {s.last_error}{s.last_error_at ? ` (${formatDateTime(s.last_error_at)})` : ''}. The next batch tries again; Retry starts one now.</p>
      )}
      {s && (
        <p className="text-xs text-muted-foreground" data-testid="email-sync-last">
          {s.last_batch_at ? `Last batch ${formatDateTime(s.last_batch_at)}${last ? `: ${last}` : ''}.` : 'No batch has run yet.'}
          {view?.active ? ' Work continues on the server in small batches; you can leave this page.' : ''}</p>
      )}
    </div>
  )
}
