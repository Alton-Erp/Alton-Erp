import { Activity, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  EVENT_STATUSES, EVENT_STATUS_META, SOURCE_TYPE_LABELS, formatAmount, sourceLink, type PostingEvent, type SourceType,
} from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, EventStatusBadge, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { dismissPostingEvent, fetchPostingEvents, retryPostingEvent, runPosting } from '@/services/accounting'

export default function PostingMonitorPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{() => <Monitor />}</SetupGate>
}

function Monitor() {
  const { has } = usePermissions()
  const manage = has('accounting_posting.manage')
  const [status, setStatus] = useState('attention')
  const [source, setSource] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const list = useAsync(() => fetchPostingEvents({ status: status === 'all' || status === 'attention' ? null : status, source_type: source === 'all' ? null : source, limit: 2000 }),
    [status, source, refresh])
  const rows = (list.data?.rows ?? []).filter((r) => status !== 'attention' || ['FAILED', 'NEEDS_ACCOUNT_MAPPING', 'PENDING'].includes(r.status))
  const counts = list.data?.counts ?? {}
  const done = (m: string) => { setAction(null); setMessage({ text: m, tone: 'ok' }); setRefresh((n) => n + 1) }

  const run = async () => {
    setRunning(true); setMessage(null)
    try {
      const r = await runPosting(500)
      if (r.busy) setMessage({ text: r.message ?? 'Another posting run is in progress.', tone: 'error' })
      else {
        const parts = Object.entries(r.results ?? {}).map(([k, n]) => `${n} ${(EVENT_STATUS_META[k as keyof typeof EVENT_STATUS_META]?.label ?? k).toLowerCase()}`)
        setMessage({ text: `${r.queued ?? 0} new document event(s) found; ${r.processed ?? 0} processed${parts.length ? `: ${parts.join(', ')}` : ''}.${r.remaining ? ` ${r.remaining} still pending — run again.` : ''}`, tone: 'ok' })
      }
      setRefresh((n) => n + 1)
    } catch (e) { setMessage({ text: describeDataError(e), tone: 'error' }) } finally { setRunning(false) }
  }

  const columns: DataTableColumn<PostingEvent>[] = [
    { id: 'doc', header: 'Source document', searchValue: (e) => `${e.source_number ?? ''} ${SOURCE_TYPE_LABELS[e.source_type]}`, sortValue: (e) => e.source_date, cell: (e) => {
      const link = sourceLink(e.source_type, e.source_id)
      return <span>{link ? <Link className="font-medium text-primary hover:underline" to={link}>{e.source_number ?? '—'}</Link> : <span className="font-medium">{e.source_number ?? '—'}</span>}
        <span className="block text-xs text-muted-foreground">{SOURCE_TYPE_LABELS[e.source_type as SourceType]} · {e.event_action === 'POST' ? 'post' : 'reverse'} · {formatDate(e.source_date)}</span></span>
    } },
    { id: 'amount', header: 'Amount', align: 'right', cell: (e) => <span className="tabular-nums">{e.amount === null ? '—' : formatAmount(e.amount)}</span> },
    { id: 'status', header: 'Status', sortValue: (e) => e.status, cell: (e) => <EventStatusBadge status={e.status} /> },
    { id: 'detail', header: 'Result', searchValue: (e) => e.error_message ?? '', cell: (e) => (
      <span className="block max-w-lg text-sm">
        {e.voucher_id ? <Link className="text-primary hover:underline" to={`/accounts/vouchers/${e.voucher_id}`}>{e.voucher_number}</Link> : null}
        {e.error_message && <span className={e.status === 'FAILED' ? 'text-red-700' : 'text-muted-foreground'}>{e.error_message}</span>}
        {e.dismiss_reason && <span className="text-muted-foreground">Dismissed: {e.dismiss_reason}</span>}
        <span className="block text-xs text-muted-foreground">{e.attempts ? `${e.attempts} failed attempt(s)` : ''}{e.last_attempt_at ? ` · last ${formatDateTime(e.last_attempt_at)}` : ''}</span>
      </span>) },
    ...(manage ? [{ id: 'actions', header: '', align: 'right' as const, cell: (e: PostingEvent) => ['FAILED', 'NEEDS_ACCOUNT_MAPPING', 'PENDING'].includes(e.status) ? (
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setAction({
          title: `Retry ${e.source_number ?? 'event'}`, description: 'Posts the document now if its accounts are mapped and its period is open. The retry counter starts again.',
          confirmLabel: 'Retry now', note: 'none',
          run: async () => { const r = await retryPostingEvent(e.id); return r.status === 'POSTED' ? 'Posted.' : `Not posted: ${r.error_message ?? r.status}` },
        })}>Retry</Button>
        <Button variant="ghost" size="sm" className="text-shortage" onClick={() => setAction({
          title: `Dismiss ${e.source_number ?? 'event'}`, description: 'The document will not be posted automatically. Record any correction with a journal voucher. The reason is kept in the audit log.',
          confirmLabel: 'Dismiss', note: 'required', minLength: 5, destructive: true,
          run: async (n) => { await dismissPostingEvent(e.id, n!); return 'Event dismissed.' },
        })}>Dismiss</Button>
      </span>) : null }] : []),
  ]

  return (
    <>
      <PageHeader actions={<>
        <AccountingExport title="Posting events" fileStem="posting-events" rows={rows} columns={[
          { header: 'Source type', value: (e) => SOURCE_TYPE_LABELS[e.source_type] }, { header: 'Document', value: (e) => e.source_number }, { header: 'Action', value: (e) => e.event_action },
          { header: 'Date', value: (e) => e.source_date }, { header: 'Amount', value: (e) => (e.amount === null ? null : Number(e.amount)) }, { header: 'Status', value: (e) => EVENT_STATUS_META[e.status].label },
          { header: 'Voucher', value: (e) => e.voucher_number }, { header: 'Message', value: (e) => e.error_message ?? e.dismiss_reason }, { header: 'Attempts', value: (e) => e.attempts },
        ]} />
        {manage && <Button onClick={() => void run()} disabled={running}>{running ? <Loader2 className="animate-spin" /> : <RefreshCw />} Run posting now</Button>}
      </>} />
      <AccountingNotice>Issued invoices, credit and debit notes, customer receipts, supplier payments and goods receipts are posted from here; nothing is guessed — a missing account mapping waits here.</AccountingNotice>
      {message && <p role="status" className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${message.tone === 'ok' ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>{message.text}</p>}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="pm-status">Status</Label>
            <Select value={status} onValueChange={setStatus}><SelectTrigger id="pm-status" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="attention">Needs attention</SelectItem><SelectItem value="all">All</SelectItem>
                {EVENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{EVENT_STATUS_META[s].label} ({counts[s] ?? 0})</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="pm-source">Source</Label>
            <Select value={source} onValueChange={setSource}><SelectTrigger id="pm-source" className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All sources</SelectItem>{(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map((s) => <SelectItem key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</SelectItem>)}</SelectContent></Select></div>
          <p className="ml-auto pb-2 text-sm text-muted-foreground">{EVENT_STATUSES.map((s) => `${EVENT_STATUS_META[s].label}: ${counts[s] ?? 0}`).join(' · ')}
            {list.data?.max_attempts ? ` · automatic retries: ${list.data.max_attempts}` : ''}</p>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(e) => e.id} loading={list.loading} pageSize={50} searchPlaceholder="Search document or message…"
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: Activity, title: status === 'attention' ? 'Nothing needs attention' : 'No posting events', description: 'Run posting to pick up newly issued and recorded documents.' }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
