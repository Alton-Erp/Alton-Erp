import { ChevronLeft, ChevronRight, Loader2, Play } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MiniTable } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { EdgeUnavailableError, fetchAmazonAudit, fetchSyncErrors, fetchSyncJobs, invokeAmazon, type SyncJob } from '@/services/amazon'

const SIZE = 25
const JOB_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = { SUCCEEDED: 'success', PARTIAL: 'warning', FAILED: 'danger', RUNNING: 'info', WAITING_REPORT: 'warning' }

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / SIZE))
  return (
    <div className="flex items-center justify-end gap-2 pt-3 text-sm text-muted-foreground">
      <span>{total} record(s) · page {page + 1} of {pages}</span>
      <Button size="icon" variant="outline" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
      <Button size="icon" variant="outline" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
    </div>
  )
}

export default function AmazonSyncPage() {
  const [tab, setTab] = useState<'jobs' | 'errors' | 'audit'>('jobs')
  return (
    <>
      <PageHeader />
      <FilterTabs className="mb-4" label="Sync history view" value={tab} onChange={setTab}
        options={[{ value: 'jobs', label: 'Synchronisation & import jobs' }, { value: 'errors', label: 'API errors' }, { value: 'audit', label: 'Audit log' }]} />
      {tab === 'jobs' ? <JobsTab /> : tab === 'errors' ? <ErrorsTab /> : <AuditTab />}
    </>
  )
}

function JobsTab() {
  const { has } = usePermissions()
  const [page, setPage] = useState(0)
  const [reload, setReload] = useState(0)
  const jobs = useAsync(() => fetchSyncJobs(page, SIZE), [page, reload])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const resume = async (j: SyncJob) => {
    setBusy(j.id); setMsg(null)
    try {
      const r = await invokeAmazon<{ status: string; pending?: number }>(j.api === 'SP_API' ? 'amazon-spapi' : 'amazon-ads', { action: 'resume', job_id: j.id })
      setMsg({ tone: 'ok', text: r.status === 'WAITING_REPORT' ? `Amazon is still generating ${r.pending ?? ''} report(s). Try again in a few minutes.` : `Job ${r.status.toLowerCase()}.` })
    } catch (e) { setMsg({ tone: 'error', text: e instanceof EdgeUnavailableError ? e.message : describeDataError(e) }) } finally { setBusy(null); setReload((n) => n + 1) }
  }
  if (jobs.loading && !jobs.data) return <LoadingState variant="table" rows={6} />
  if (jobs.error) return <ErrorState message={describeDataError(jobs.error)} onRetry={jobs.reload} />
  return (
    <Card><CardContent className="p-4">
      {msg && <p role={msg.tone === 'error' ? 'alert' : 'status'} className={`mb-3 rounded-lg border px-3 py-2 text-sm ${msg.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>{msg.text}</p>}
      <MiniTable headers={['Started', 'Source', 'Job', 'Period / file', 'Status', 'Received', 'New', 'Updated', 'Skipped', 'Finished', 'Message', '']}
        align={['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'left', 'left', 'left']}
        rows={(jobs.data?.rows ?? []).map((j) => [formatDateTime(j.started_at), j.api, j.job_type, j.file_name ?? (j.date_from ? `${j.date_from} – ${j.date_to}` : '-'),
          <StatusBadge key="s" label={j.status.replace(/_/g, ' ').toLowerCase()} tone={JOB_TONE[j.status] ?? 'neutral'} />, j.rows_received, j.rows_inserted, j.rows_updated, j.rows_skipped,
          j.finished_at ? formatDateTime(j.finished_at) : '-',
          <span key="m" className="line-clamp-2 max-w-72 text-xs">{j.error_message ?? (j.state.errors?.length ? `${j.state.errors.length} row error(s): ${j.state.errors.slice(0, 2).map((e) => `row ${e.row} ${e.message}`).join('; ')}` : '')}</span>,
          j.status === 'WAITING_REPORT' && has('amazon_integration.manage') && (j.api === 'SP_API' || j.api === 'ADS_API')
            ? <Button key="r" size="sm" variant="outline" disabled={busy !== null} onClick={() => void resume(j)}>{busy === j.id ? <Loader2 className="animate-spin" /> : <Play />} Resume</Button> : null])}
        empty="No synchronisation or import jobs yet." />
      <Pager page={page} total={jobs.data?.total ?? 0} onPage={setPage} />
    </CardContent></Card>
  )
}

function ErrorsTab() {
  const [page, setPage] = useState(0)
  const errors = useAsync(() => fetchSyncErrors(page, SIZE), [page])
  if (errors.loading && !errors.data) return <LoadingState variant="table" rows={6} />
  if (errors.error) return <ErrorState message={describeDataError(errors.error)} onRetry={errors.reload} />
  return (
    <Card><CardContent className="p-4">
      <p className="mb-2 text-xs text-muted-foreground">Credentials and tokens are removed from messages before they are stored.</p>
      <MiniTable headers={['When', 'API', 'Operation', 'HTTP', 'Code', 'Message', 'Retryable', 'Attempt']} align={['left', 'left', 'left', 'right', 'left', 'left', 'left', 'right']}
        rows={(errors.data?.rows ?? []).map((e) => [formatDateTime(e.occurred_at), e.api, e.operation, e.http_status ?? '-', e.error_code ?? '-',
          <span key="m" className="line-clamp-3 max-w-96 text-xs">{e.message}</span>, e.retryable ? 'yes' : 'no', e.attempt])} empty="No errors recorded." />
      <Pager page={page} total={errors.data?.total ?? 0} onPage={setPage} />
    </CardContent></Card>
  )
}

function AuditTab() {
  const [page, setPage] = useState(0)
  const audit = useAsync(() => fetchAmazonAudit(page, SIZE), [page])
  if (audit.loading && !audit.data) return <LoadingState variant="table" rows={6} />
  if (audit.error) return <ErrorState message={describeDataError(audit.error)} onRetry={audit.reload} />
  return (
    <Card><CardContent className="p-4">
      <MiniTable headers={['When', 'Action', 'Record', 'User', 'Details']} align={['left', 'left', 'left', 'left', 'left']}
        rows={(audit.data?.rows ?? []).map((a) => [formatDateTime(a.event_timestamp), a.action.replace('amazon.', ''), `${a.resource_type}${a.resource_id ? ` ${a.resource_id.slice(0, 8)}` : ''}`,
          a.actor_user_id ? a.actor_user_id.slice(0, 8) : 'system',
          <span key="d" className="line-clamp-2 max-w-96 text-xs">{Object.entries(a.metadata ?? {}).filter(([k]) => k !== 'module').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</span>])}
        empty="No Amazon audit events visible to you (the audit log needs the audit permission)." />
      <Pager page={page} total={audit.data?.total ?? 0} onPage={setPage} />
    </CardContent></Card>
  )
}
