import { BellRing, CheckCheck, Loader2, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addDays, dayStartInstant } from '@/features/analytics/analytics-period'
import { NOTIFICATION_GROUP_FILTERS, NOTIFICATION_TYPES, NOTIFICATIONS_CHANGED, SEVERITY_TONE } from '@/features/admin/notification-labels'
import { resolveNotificationLink } from '@/features/admin/notification-links'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  dismissNotifications, fetchNotificationPreferences, fetchNotifications, markNotificationsRead, setNotificationPreference, syncNotifications,
  type NotificationRow, type Severity,
} from '@/services/admin'

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

export default function NotificationsPage() {
  const navigate = useNavigate()
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? 'Asia/Kolkata'
  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [type, setType] = useState('all')
  const [severity, setSeverity] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sync = useAsync(() => syncNotifications().catch(() => null), [refresh])
  const list = useAsync(() => fetchNotifications({ unreadOnly: tab === 'unread', type: type === 'all' ? null : type, severity: severity === 'all' ? null : (severity as Severity),
    from: from ? dayStartInstant(from, tz) : null, to: to ? dayStartInstant(addDays(to, 1), tz) : null }, page, size), [tab, type, severity, from, to, page, size, refresh, sync.data])
  const prefs = useAsync(fetchNotificationPreferences, [refresh])
  const reset = () => setPage(0)

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null); setMessage(null)
    try { await fn(); setMessage(ok); changed(); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const open = async (n: NotificationRow) => {
    if (!n.read_at) await markNotificationsRead([n.id]).catch(() => undefined)
    changed()
    const target = resolveNotificationLink(n.link)
    if (target) navigate(target)
  }

  return (
    <>
      <PageHeader actions={<>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => syncNotifications(true), 'Alerts checked for new notifications.')}><RefreshCw /> Check now</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => markNotificationsRead(null), 'All notifications marked as read.')}><CheckCheck /> Mark all as read</Button>
      </>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <FilterTabs<'all' | 'unread'> label="Read state" value={tab} onChange={(v) => { setTab(v); reset() }} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
              <div className="space-y-1"><Label htmlFor="nf-type">Type</Label>
                <Select value={type} onValueChange={(v) => { setType(v); reset() }}><SelectTrigger id="nf-type" className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All types</SelectItem>{NOTIFICATION_GROUP_FILTERS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1"><Label htmlFor="nf-sev">Severity</Label>
                <Select value={severity} onValueChange={(v) => { setSeverity(v); reset() }}><SelectTrigger id="nf-sev" className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All</SelectItem>{SEVERITIES.map((s) => <SelectItem key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1"><Label htmlFor="nf-from">From</Label><Input id="nf-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset() }} /></div>
              <div className="space-y-1"><Label htmlFor="nf-to">To</Label><Input id="nf-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); reset() }} /></div>
            </div>
            {list.loading && !list.data ? <LoadingState variant="table" rows={6} /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
              : !list.data?.rows.length ? <EmptyState icon={BellRing} title="No notifications" description="Approvals assigned to you, alerts in your areas, import results and system messages appear here." /> : (
                <>
                  <ul className="divide-y rounded-lg border">{list.data.rows.map((n) => (
                    <li key={n.id} className={`flex flex-wrap items-start gap-3 px-4 py-3 text-sm ${n.read_at ? '' : 'bg-primary/5'}`}>
                      <StatusBadge label={n.severity.charAt(0) + n.severity.slice(1).toLowerCase()} tone={SEVERITY_TONE[n.severity]} />
                      <div className="min-w-0 flex-1">
                        <p className={n.read_at ? '' : 'font-semibold'}>{n.title}</p>
                        <p className="whitespace-pre-line text-muted-foreground">{n.message}</p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(n.created_at)}{n.read_at ? ` · read ${formatDateTime(n.read_at)}` : ' · unread'}</p>
                      </div>
                      <div className="flex gap-1">
                        {resolveNotificationLink(n.link) ? <Button size="sm" variant="outline" onClick={() => void open(n)}>Open</Button>
                          : n.link ? <span className="self-center text-xs text-muted-foreground">Module no longer in the ERP</span> : null}
                        {!n.read_at && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => markNotificationsRead([n.id]), 'Marked as read.')}>Mark read</Button>}
                        <Button size="icon-sm" variant="ghost" aria-label="Dismiss" disabled={busy} onClick={() => void run(() => dismissNotifications([n.id]), 'Notification dismissed.')}><X /></Button>
                      </div>
                    </li>
                  ))}</ul>
                  <PaginationBar page={page} pageSize={size} total={list.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setSize(n); reset() }} disabled={list.loading} />
                </>
              )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle>Preferences</CardTitle><CardDescription>What appears in your notification centre.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="space-y-1 rounded-lg border p-3">
              <div className="flex justify-between"><dt>In-app</dt><dd className="font-medium text-green-700">On</dd></div>
              <div className="flex justify-between"><dt>Email</dt><dd className="text-muted-foreground">Not configured</dd></div>
              <div className="flex justify-between"><dt>Push</dt><dd className="text-muted-foreground">Not configured</dd></div>
              <p className="pt-1 text-xs text-muted-foreground">No email or push provider is set up, so nothing is sent outside the application. The badge refreshes every 60 seconds.</p>
            </dl>
            {prefs.loading && !prefs.data ? <Loader2 className="size-4 animate-spin" /> : ['Approvals', 'Alerts', 'System'].map((g) => (
              <fieldset key={g} className="space-y-1.5"><legend className="mb-1 text-xs font-semibold text-muted-foreground uppercase">{g}</legend>
                {NOTIFICATION_TYPES.filter((t) => t.group === g).map((t) => (
                  <label key={t.type} className="flex items-center gap-2">
                    <Checkbox checked={t.mandatory ? true : (prefs.data?.[t.type] ?? true)} disabled={t.mandatory || busy}
                      onCheckedChange={(v) => void run(() => setNotificationPreference(t.type, v === true), 'Preference saved.')} />
                    <span>{t.label}{t.mandatory && <span className="text-xs text-muted-foreground"> (always on)</span>}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
