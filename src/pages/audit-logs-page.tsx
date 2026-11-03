import { Download, Loader2, ScrollText } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Tone } from '@/config/status'
import { addDays, dayStartInstant } from '@/features/analytics/analytics-period'
import type { CellValue } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchAuditFilters, fetchAuditPage, type AuditFilter, type AuditRow } from '@/services/admin'

const ACTION_LABELS: Record<string, { label: string; tone: Tone }> = {
  'auth.sign_in': { label: 'Signed in', tone: 'neutral' },
  'auth.sign_out': { label: 'Signed out', tone: 'neutral' },
  'auth.access_denied': { label: 'Access denied', tone: 'danger' },
  'auth.password_changed': { label: 'Password changed', tone: 'warning' },
  'user.provisioned': { label: 'Account created', tone: 'info' },
  'user.invited': { label: 'User invited', tone: 'info' },
  'user.activated': { label: 'User activated', tone: 'success' },
  'user.deactivated': { label: 'User deactivated', tone: 'warning' },
  'user.company_changed': { label: 'Company changed', tone: 'warning' },
  'security.sessions_revoked': { label: 'Sessions ended', tone: 'warning' },
  'user_role.granted': { label: 'Role granted', tone: 'info' },
  'user_role.revoked': { label: 'Role revoked', tone: 'warning' },
  'settings.created': { label: 'Setting created', tone: 'info' },
  'settings.updated': { label: 'Setting updated', tone: 'info' },
  'settings.deleted': { label: 'Setting deleted', tone: 'warning' },
  'company.updated': { label: 'Company updated', tone: 'info' },
  'security.super_admin_bootstrapped': { label: 'Super Admin bootstrapped', tone: 'outsourced' },
}
const MODULE_LABELS: Record<string, string> = {
  auth: 'Sign-in & access', user: 'Users', user_role: 'Roles', settings: 'Settings', company: 'Company', inventory: 'Inventory', production: 'Production',
  outsourcing: 'Outsourcing', sales: 'Sales & fulfilment', billing: 'Billing & payments', customer_po: 'Customer POs', approval: 'Approvals',
  document: 'Documents', import: 'Imports', product: 'Products', system: 'System', security: 'Security', analytics: 'Analytics', barcode: 'Barcodes',
}

const today = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const failed = (r: AuditRow) => /denied|failed/.test(r.action) || r.metadata?.result === 'failure'
const label = (a: string) => ACTION_LABELS[a]?.label ?? a.replace(/[._]/g, ' ')
function describeMetadata(m: Record<string, unknown>): string {
  if (!m || typeof m !== 'object') return ''
  return Object.entries(m).filter(([k]) => k !== 'module' && k !== 'result')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
}

export default function AuditLogsPage() {
  const { access } = useAuth()
  const companyId = access?.company?.id ?? ''
  const tz = access?.company?.timezone ?? 'Asia/Kolkata'
  const [from, setFrom] = useState(() => addDays(today(tz), -29))
  const [to, setTo] = useState(() => today(tz))
  const [actor, setActor] = useState('all')
  const [module, setModule] = useState('all')
  const [result, setResult] = useState('all')
  const [actionText, setActionText] = useState('')
  const [entityText, setEntityText] = useState('')
  const action = useDebouncedValue(actionText, 300)
  const entity = useDebouncedValue(entityText, 300)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(50)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filters = useAsync(fetchAuditFilters, [])
  const actors = new Map((filters.data?.actors ?? []).map((a) => [a.id, a.name]))
  const actorName = (id: string | null) => (id ? (actors.get(id) ?? 'Former or external user') : 'System')
  const entityValid = !entity.trim() || /^[0-9a-f-]{36}$/i.test(entity.trim())
  const validRange = Boolean(from && to && from <= to)
  const filter: AuditFilter = {
    // an invalid range is never queried (see below)
    from: validRange ? dayStartInstant(from, tz) : '', to: validRange ? dayStartInstant(addDays(to, 1), tz) : '',
    actor: actor === 'all' ? null : actor, module: module === 'all' ? null : module, action, entityId: entityValid ? entity : '', result: result === 'all' ? null : (result as 'success' | 'failure'),
  }
  const list = useAsync(() => (companyId && validRange ? fetchAuditPage(companyId, filter, page, size) : Promise.resolve({ rows: [] as AuditRow[], total: 0 })),
    [companyId, from, to, actor, module, result, action, entity, page, size, tz])
  const reset = () => setPage(0)

  const exportCsv = async () => {
    setExporting(true); setError(null)
    try {
      const all: AuditRow[] = []
      for (let p = 0; p < 20; p++) {
        const r = await fetchAuditPage(companyId, filter, p, 1000)
        all.push(...r.rows)
        if (all.length >= r.total || r.rows.length < 1000) break
      }
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      const rows: CellValue[][] = [['Time (UTC)', 'User', 'Action', 'Module', 'Resource type', 'Resource id', 'Result', 'Details'],
        ...all.map((r) => [r.event_timestamp, actorName(r.actor_user_id), r.action, String(r.metadata?.module ?? r.action.split('.')[0]), r.resource_type, r.resource_id, failed(r) ? 'failure' : 'success', describeMetadata(r.metadata)])]
      await downloadSheets([{ name: 'Audit log', rows }], `audit-log-${from}-to-${to}`, 'csv')
    } catch (e) { setError(describeDataError(e)) } finally { setExporting(false) }
  }

  return (
    <>
      <PageHeader actions={<Button variant="outline" disabled={exporting || !list.data?.total} onClick={() => void exportCsv()}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export CSV</Button>} />
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card><CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="al-from">From</Label><Input id="al-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset() }} /></div>
          <div className="space-y-1"><Label htmlFor="al-to">To</Label><Input id="al-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); reset() }} /></div>
          <div className="space-y-1"><Label htmlFor="al-user">User</Label>
            <Select value={actor} onValueChange={(v) => { setActor(v); reset() }}><SelectTrigger id="al-user" className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All users</SelectItem>{(filters.data?.actors ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="al-module">Module</Label>
            <Select value={module} onValueChange={(v) => { setModule(v); reset() }}><SelectTrigger id="al-module" className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All modules</SelectItem>{(filters.data?.modules ?? []).map((m) => <SelectItem key={m} value={m}>{MODULE_LABELS[m] ?? m}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="al-result">Result</Label>
            <Select value={result} onValueChange={(v) => { setResult(v); reset() }}><SelectTrigger id="al-result" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any</SelectItem><SelectItem value="success">Success</SelectItem><SelectItem value="failure">Denied / failed</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="al-action">Action contains</Label><Input id="al-action" className="w-44" value={actionText} onChange={(e) => { setActionText(e.target.value); reset() }} placeholder="e.g. approved" /></div>
          <div className="space-y-1"><Label htmlFor="al-entity">Record id</Label><Input id="al-entity" className="w-72 font-mono" value={entityText} onChange={(e) => { setEntityText(e.target.value); reset() }} placeholder="UUID of the record" /></div>
        </div>
        {!validRange && <p className="text-sm text-red-800">Choose a start date on or before the end date.</p>}
        {!entityValid && <p className="text-sm text-amber-800">Record id must be a full UUID; it is ignored until then.</p>}
        {list.loading && !list.data ? <LoadingState variant="table" rows={8} /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
          : !list.data?.rows.length ? <EmptyState icon={ScrollText} title="No activity matches" description="Sign-ins, user and role changes, settings, stock movements, production, sales, billing, approvals, documents and imports are recorded automatically. Entries cannot be edited or deleted." /> : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Record</th><th className="px-3 py-2">Details</th></tr></thead>
                  <tbody className="divide-y">{list.data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-xs whitespace-nowrap tabular-nums">{formatDateTime(r.event_timestamp, tz)}</td>
                      <td className="px-3 py-2">{actorName(r.actor_user_id)}</td>
                      <td className="px-3 py-2"><StatusBadge label={label(r.action)} tone={failed(r) ? 'danger' : ACTION_LABELS[r.action]?.tone ?? 'neutral'} /></td>
                      <td className="px-3 py-2 text-xs"><span className="text-muted-foreground">{r.resource_type.replace(/_/g, ' ')}</span>{r.resource_id && <button type="button" className="ml-1 font-mono text-primary hover:underline" title="Show all entries for this record" onClick={() => { setEntityText(r.resource_id!); reset() }}>{r.resource_id.slice(0, 8)}</button>}</td>
                      <td className="px-3 py-2"><span className="block max-w-md truncate text-xs text-muted-foreground" title={describeMetadata(r.metadata)}>{describeMetadata(r.metadata) || '—'}</span></td>
                    </tr>))}</tbody>
                </table>
              </div>
              <PaginationBar page={page} pageSize={size} total={list.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setSize(n); reset() }} disabled={list.loading} />
              <p className="text-xs text-muted-foreground">Times in {tz}. The audit log is append-only. Export includes up to 20,000 entries for the current filters.</p>
            </>
          )}
      </CardContent></Card>
    </>
  )
}
