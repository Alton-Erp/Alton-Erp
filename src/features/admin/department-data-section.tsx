import { AlertTriangle, Archive, CheckCircle2, Database, History, Loader2, RefreshCw, RotateCcw, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  confirmationPhrase, DEPARTMENTS, departmentLabel, executeBlocker, groupByOperation, nothingDeletableReason, OPERATIONS, tableLabel,
  type CategorySummary, type DepartmentKey, type Operation, type PreviewResult,
} from '@/features/admin/department-data-model'
import { DepartmentRecordsTable } from '@/features/admin/department-records-table'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber } from '@/lib/format'
import {
  confirmPassword, executeDepartmentData, fetchDepartmentHistory, fetchDepartmentOverview, previewDepartmentData, recordDataBackup,
  type DepartmentRun, type ExecuteResult,
} from '@/services/department-data'

const OP_ICON = { ARCHIVE: Archive, RESET: RotateCcw, DELETE: Trash2 }
const STATUS_TONE = { COMPLETED: 'success', BLOCKED: 'warning', FAILED: 'danger' } as const

/**
 * Settings → System → Department Data Management (Super Admin with system.reset_data; the database
 * checks it again). Archive, reset and permanent delete per department, with a preview first.
 */
export function DepartmentDataSection({ companyId }: { companyId: string }) {
  const [refresh, setRefresh] = useState(0)
  // A new loader each time `refresh` changes: useAsync re-runs only when the loader changes, and a bare
  // module function is the same object every render (the counts never reloaded after a delete).
  const overview = useAsync(() => fetchDepartmentOverview(), [refresh])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [dialog, setDialog] = useState<{ department: DepartmentKey; operation: Operation; categories: string[] } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const byDept = useMemo(() => new Map((overview.data?.departments ?? []).map((d) => [d.department, d.categories])), [overview.data])
  const selectedOf = (dept: DepartmentKey, op: Operation) =>
    (byDept.get(dept) ?? []).filter((c) => c.operation === op && selected[c.code]).map((c) => c.code)

  return (
    <Card data-testid="department-data-section">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Database className="size-5" aria-hidden /> Department Data Management</CardTitle>
          <CardDescription className="max-w-3xl">
            Archive, reset or permanently delete data one department at a time. Only never-used records and unposted or cancelled documents can be deleted;
            posted stock, invoices, notes, payments and ledger history are never deleted here. Every operation shows a preview first, runs in one
            transaction and is recorded in the audit log.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}><History /> History</Button>
          <Button variant="outline" size="icon" aria-label="Refresh counts" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={overview.loading ? 'animate-spin' : undefined} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {overview.loading && !overview.data ? <LoadingState variant="cards" rows={4} />
          : overview.error ? <ErrorState message={describeDataError(overview.error)} onRetry={overview.reload} />
          : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {DEPARTMENTS.map((d) => (
                <div key={d.key} className="flex flex-col rounded-lg border p-4" data-testid={`dept-${d.key}`}>
                  <p className="font-medium">{d.label}</p>
                  <p className="mb-3 text-xs text-muted-foreground">{d.description}</p>
                  <div className="flex-1 space-y-3">
                    {groupByOperation(byDept.get(d.key) ?? []).map((g) => (
                      <div key={g.operation}>
                        <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{OPERATIONS[g.operation].label}</p>
                        <ul className="space-y-1.5">
                          {g.categories.map((c) => <CategoryRow key={c.code} c={c} checked={Boolean(selected[c.code])}
                            onChange={(v) => setSelected((s) => ({ ...s, [c.code]: v }))}
                            onExplain={() => setDialog({ department: d.key, operation: c.operation, categories: [c.code] })} />)}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(['ARCHIVE', 'RESET', 'DELETE'] as Operation[]).filter((op) => (byDept.get(d.key) ?? []).some((c) => c.operation === op)).map((op) => {
                      const cats = selectedOf(d.key, op)
                      const Icon = OP_ICON[op]
                      return (
                        <Button key={op} size="sm" variant={op === 'DELETE' ? 'destructive' : 'outline'} disabled={cats.length === 0}
                          onClick={() => setDialog({ department: d.key, operation: op, categories: cats })}>
                          <Icon /> {OPERATIONS[op].action}{cats.length ? ` (${cats.length})` : ''}…
                        </Button>
                      )
                    })}
                  </div>
                  <NothingDeletableHint categories={byDept.get(d.key) ?? []}
                    onExplain={(codes) => setDialog({ department: d.key, operation: 'DELETE', categories: codes })} />
                </div>
              ))}
            </div>
          )}
      </CardContent>
      {dialog && (
        <OperationDialog {...dialog} companyId={companyId} onClose={(changed) => { setDialog(null); if (changed) { setSelected({}); setRefresh((n) => n + 1) } }} />
      )}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
    </Card>
  )
}

function CategoryRow({ c, checked, onChange, onExplain }: { c: CategorySummary; checked: boolean; onChange: (v: boolean) => void; onExplain: () => void }) {
  const id = `dd-${c.code}`
  return (
    <li className="flex items-start gap-2 text-sm" data-category={c.code}>
      <Checkbox id={id} checked={checked} disabled={c.records === 0} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <div className="min-w-0">
        <Label htmlFor={id} className="font-normal">{c.label}</Label>
        <p className="text-xs text-muted-foreground">
          <span className="tabular-nums">{formatNumber(c.records)}</span> eligible{c.blocked > 0 && <> · <span className="text-amber-700 tabular-nums">{formatNumber(c.blocked)} blocked</span></>}
          {c.blocked > 0 && (
            <> · <button type="button" className="text-foreground underline underline-offset-2 hover:no-underline" onClick={onExplain} data-testid={`dept-why-${c.code}`}>
              {c.records === 0 ? 'See why' : 'Review records'}
            </button></>
          )}
        </p>
      </div>
    </li>
  )
}

/** Shown under the buttons when every permanent-delete candidate of a department is blocked. */
function NothingDeletableHint({ categories, onExplain }: { categories: CategorySummary[]; onExplain: (codes: string[]) => void }) {
  const reason = nothingDeletableReason(categories)
  if (!reason) return null
  const codes = categories.filter((c) => c.operation === 'DELETE' && c.blocked > 0).map((c) => c.code)
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300" data-testid="dept-nothing-hint">
      <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{reason} <button type="button" className="font-medium underline underline-offset-2 hover:no-underline" onClick={() => onExplain(codes)}>See why</button></span>
    </p>
  )
}

function OperationDialog({ department, operation, categories, companyId, onClose }: {
  department: DepartmentKey; operation: Operation; categories: string[]; companyId: string; onClose: (changed: boolean) => void
}) {
  const { user } = useAuth()
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [attempt, setAttempt] = useState(0)
  // Full preview: every candidate and every blocked record (the list the user selects from).
  const preview = useAsync(() => previewDepartmentData(department, operation, categories), [department, operation, categories.join(','), attempt])
  const full = preview.data ?? null
  const records = useMemo(() => full?.records ?? [], [full])
  // Eligible records the user unticked; everything else is selected.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const selectedKeys = useMemo(() => records.filter((r) => !unticked.has(r.key)).map((r) => r.key), [records, unticked])
  const narrowedSelection = Boolean(full?.records) && unticked.size > 0
  // A narrowed selection gets its own preview from the database (same rules; its own plan hash).
  const narrowed = useAsync(
    () => narrowedSelection && selectedKeys.length > 0 ? previewDepartmentData(department, operation, categories, selectedKeys) : Promise.resolve(null),
    [narrowedSelection, selectedKeys.join(','), attempt],
  )
  const p: PreviewResult | null = narrowedSelection ? (narrowed.loading ? null : narrowed.data ?? null) : full
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const [backupId, setBackupId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExecuteResult | null>(null)
  const backup = backupId ? { id: backupId } : full?.backup ?? null
  const blocker = narrowed.error ? describeDataError(narrowed.error)
    : executeBlocker({ preview: p, phrase, backupId: backup?.id ?? null, password, currentUserId: user?.id ?? null, selected: full?.records ? selectedKeys.length : undefined })
  const nothingEligible = Boolean(full) && full!.total === 0

  const toggle = (key: string, on: boolean) => setUnticked((s) => {
    const n = new Set(s)
    if (on) n.delete(key)
    else n.add(key)
    return n
  })

  const execute = async () => {
    if (!p || blocker) return
    setBusy(true)
    setError(null)
    try {
      if (p.requires_password) await confirmPassword(user?.email ?? '', password)
      setPassword('')
      const r = await executeDepartmentData({ department, operation, categories, planHash: p.plan_hash, confirmation: phrase, backupId: backup?.id ?? null, requestId,
        keys: narrowedSelection ? selectedKeys : null })
      setResult(r)
    } catch (e) {
      setError((e as { code?: string }).code === 'WRONG_PASSWORD' ? 'The password is incorrect.' : describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const done = result && 'id' in result
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(Boolean(done)) }}>
      <DialogContent className="max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-5xl" data-testid="dept-dialog">
        <DialogHeader>
          <DialogTitle>{OPERATIONS[operation].action}: {departmentLabel(department)}</DialogTitle>
          <DialogDescription>{OPERATIONS[operation].explain}</DialogDescription>
        </DialogHeader>

        {result ? <ResultPanel result={result} onPreviewAgain={() => { setResult(null); setPhrase(''); setRequestId(crypto.randomUUID()); setUnticked(new Set()); setAttempt((n) => n + 1) }} />
          : preview.loading && !full ? <LoadingState label="Preparing the preview…" />
          : preview.error || !full ? <ErrorState message={describeDataError(preview.error)} onRetry={preview.reload} />
          : (
            <div className="space-y-4">
              {nothingEligible && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="dept-nothing">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    Nothing can be {operation === 'DELETE' ? 'deleted permanently' : 'changed'}.
                    {full.blocked_total > 0
                      ? ` ${full.blocked_total === 1 ? 'The record below is' : `All ${full.blocked_total} records below are`} kept because other records depend on ${full.blocked_total === 1 ? 'it' : 'them'}: the reason and the related documents are listed for each. These protections are deliberate (posted stock, payables and history are never deleted).`
                      : ' There are no records in the chosen categories.'}
                  </span>
                </div>
              )}
              <PreviewPanel p={p ?? full} showBlocked={!full.records} loading={narrowedSelection && narrowed.loading} />
              {full.records && (full.records.length > 0 || full.blocked.length > 0) && (
                <DepartmentRecordsTable records={full.records} blocked={full.blocked} selected={(k) => !unticked.has(k)} onToggle={toggle}
                  onToggleAll={(on) => setUnticked(on ? new Set() : new Set(records.map((r) => r.key)))} disabled={busy}
                  truncated={(full.records_total ?? 0) > full.records.length} />
              )}
              {!nothingEligible && (
                <div className="space-y-3 rounded-lg border p-3" data-testid="dept-confirm">
                  {full.requires_backup && <BackupStep companyId={companyId} backup={full.backup} chosen={backupId} onRecorded={setBackupId} userId={user?.id ?? null} />}
                  <div className="space-y-1">
                    <Label htmlFor="dept-phrase">Type <span className="font-mono font-semibold">{confirmationPhrase(operation, department)}</span> to confirm</Label>
                    <Input id="dept-phrase" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} disabled={busy} />
                  </div>
                  {full.requires_password && (
                    <div className="space-y-1">
                      <Label htmlFor="dept-password">Your password</Label>
                      <Input id="dept-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
                      <p className="text-xs text-muted-foreground">Checked again by Supabase sign-in; the database accepts it for 5 minutes.</p>
                    </div>
                  )}
                </div>
              )}
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              {!nothingEligible && blocker && phrase && <p className="text-xs text-muted-foreground" data-testid="dept-execute-hint">{blocker}</p>}
            </div>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(Boolean(done))} disabled={busy}>{result ? 'Close' : nothingEligible ? 'Close' : 'Cancel'}</Button>
          {!result && full && !nothingEligible && (
            <Button variant={operation === 'DELETE' ? 'destructive' : 'default'} onClick={() => void execute()} disabled={busy || Boolean(blocker)} title={blocker ?? undefined}
              data-testid="dept-execute">
              {busy || (narrowedSelection && narrowed.loading) ? <Loader2 className="animate-spin" /> : null} {OPERATIONS[operation].action}
              {p ? ` ${formatNumber(p.records_total ?? p.total)} ${p.records_total !== undefined ? `record${p.records_total === 1 ? '' : 's'}` : `row${p.total === 1 ? '' : 's'}`}` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewPanel({ p, showBlocked, loading }: { p: PreviewResult; showBlocked: boolean; loading?: boolean }) {
  const tables = Object.entries(p.tables).sort((a, b) => b[1] - a[1])
  return (
    <div className={`space-y-3 ${loading ? 'opacity-60' : ''}`} data-testid="dept-preview" aria-busy={loading || undefined}>
      <div className={`grid gap-2 ${p.records_total !== undefined ? 'grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
        {p.records_total !== undefined && <Figure label="Eligible records" value={formatNumber(p.records_total)} testId="dept-fig-eligible" />}
        <Figure label="Rows to change" value={formatNumber(p.total)} />
        <Figure label="Blocked records" value={formatNumber(p.blocked_total)} tone={p.blocked_total ? 'warning' : undefined} testId="dept-fig-blocked" />
        <Figure label="Departments affected" value={[...new Set(p.affected_departments)].map(departmentLabel).join(', ') || '—'} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium">By category</p>
          <ul className="space-y-1 text-sm">{p.by_category.map((c) => (
            <li key={c.code} className="flex justify-between gap-2"><span>{c.label}</span><span className="tabular-nums">{formatNumber(c.records)} record(s){c.blocked ? ` · ${c.blocked} blocked` : ''}</span></li>
          ))}</ul>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Rows per table</p>
          {tables.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is eligible.</p> : (
            <ul className="space-y-1 text-sm" aria-label="Rows per table">{tables.map(([t, n]) => (
              <li key={t} className="flex justify-between gap-2" data-table={t}><span>{tableLabel(t)}</span><span className="tabular-nums">{formatNumber(n)}</span></li>
            ))}</ul>
          )}
        </div>
      </div>
      {showBlocked && p.blocked.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="dept-blocked">
          <p className="mb-2 flex items-center gap-2 font-medium"><ShieldAlert className="size-4" /> Kept because other records depend on them</p>
          <ul className="space-y-1.5">{p.blocked.slice(0, 50).map((b) => (
            <li key={`${b.table}:${b.key}`}>
              <span className="font-medium">{b.record}</span> — {b.reasons.join('; ')}
              {b.references && b.references.length > 0 && (
                <span className="block text-xs text-amber-900/80">{b.references.map((r) => `${departmentLabel(r.department)}: ${r.record}`).join(' · ')}</span>
              )}
            </li>
          ))}</ul>
          {p.blocked.length > 50 && <p className="mt-1 text-xs">and {p.blocked.length - 50} more…</p>}
        </div>
      )}
    </div>
  )
}

function Figure({ label, value, tone, testId }: { label: string; value: string; tone?: 'warning'; testId?: string }) {
  return (
    <div className={`min-w-0 rounded-lg border p-2.5 break-words ${tone === 'warning' ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : ''}`} data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function BackupStep({ companyId, backup, chosen, onRecorded, userId }: {
  companyId: string; backup: PreviewResult['backup']; chosen: string | null; onRecorded: (id: string) => void; userId: string | null
}) {
  const usable = backup && (!userId || backup.recorded_by === userId)
  const [method, setMethod] = useState('SUPABASE_SCHEDULED')
  const [reference, setReference] = useState('')
  const [takenAt, setTakenAt] = useState(() => new Date(Date.now() - 5 * 60000).toISOString().slice(0, 16))
  const [restoreTested, setRestoreTested] = useState(false)
  const [external, setExternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (chosen || usable) {
    return (
      <p className="flex items-center gap-2 text-sm text-green-800" data-testid="dept-backup-ok">
        <CheckCircle2 className="size-4" /> Backup recorded{backup && !chosen ? `: ${backup.backup_reference}, taken ${formatDateTime(backup.backup_taken_at)} (valid until ${formatDateTime(backup.valid_until)})` : ''}.
      </p>
    )
  }
  const record = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await recordDataBackup({ companyId, method, reference, takenAt: new Date(takenAt).toISOString(), restoreTested, external })
      onRecorded(r.id)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2" data-testid="dept-backup">
      <p className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4 text-amber-600" /> Take a backup first (Supabase Dashboard → Database → Backups, or pg_dump), then record it here.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor="dd-bk-method">Backup method</Label>
          <Select value={method} onValueChange={(v) => { if (v) setMethod(v) }}>
            <SelectTrigger id="dd-bk-method"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="SUPABASE_SCHEDULED">Supabase scheduled backup</SelectItem>
              <SelectItem value="SUPABASE_PITR">Supabase point-in-time</SelectItem>
              <SelectItem value="PG_DUMP">pg_dump file</SelectItem>
              <SelectItem value="OTHER">Other</SelectItem>
            </SelectContent>
          </Select></div>
        <div className="space-y-1"><Label htmlFor="dd-bk-ref">Backup name or time</Label><Input id="dd-bk-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="dd-bk-time">Taken at</Label><Input id="dd-bk-time" type="datetime-local" value={takenAt} onChange={(e) => setTakenAt(e.target.value)} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox id="dd-bk-restore" checked={restoreTested} onCheckedChange={(v) => setRestoreTested(v === true)} /> I checked that the backup can be restored</label>
      <label className="flex items-center gap-2 text-sm"><Checkbox id="dd-bk-external" checked={external} onCheckedChange={(v) => setExternal(v === true)} /> The backup is outside this database</label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button size="sm" variant="outline" onClick={() => void record()} disabled={busy || reference.trim().length < 3 || !restoreTested || !external}>
        {busy && <Loader2 className="animate-spin" />} Record backup
      </Button>
    </div>
  )
}

function ResultPanel({ result, onPreviewAgain }: { result: ExecuteResult; onPreviewAgain: () => void }) {
  if (!('id' in result)) {
    return <p role="alert" className="flex items-center gap-2 text-sm text-red-700" data-testid="dept-result"><XCircle className="size-4" /> {result.error}</p>
  }
  const counts = Object.entries(result.deleted_counts ?? {})
  return (
    <div className="space-y-3" data-testid="dept-result" data-status={result.status}>
      <div className="flex items-center gap-2">
        <StatusBadge label={result.status === 'COMPLETED' ? 'Completed' : result.status === 'BLOCKED' ? 'Stopped' : 'Failed'} tone={STATUS_TONE[result.status]} />
        <span className="text-sm">{formatNumber(result.deleted_total)} row(s) changed · finished {formatDateTime(result.finished_at)}</span>
      </div>
      {result.error_message && <p role="alert" className="text-sm text-red-700">{result.error_message}{result.status === 'FAILED' ? ' Every change of this attempt was rolled back.' : ''}</p>}
      {result.status === 'BLOCKED' && <Button size="sm" variant="outline" onClick={onPreviewAgain}><RefreshCw /> Preview again</Button>}
      {counts.length > 0 && (
        <ul className="space-y-1 text-sm">{counts.map(([t, n]) => <li key={t} className="flex justify-between"><span>{tableLabel(t)}</span><span className="tabular-nums">{formatNumber(n)}</span></li>)}</ul>
      )}
    </div>
  )
}

function HistoryDialog({ onClose }: { onClose: () => void }) {
  const history = useAsync(() => fetchDepartmentHistory(50), [])
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Department data history</DialogTitle><DialogDescription>Every archive, reset and delete of this company. The history cannot be edited or deleted.</DialogDescription></DialogHeader>
        {history.loading && !history.data ? <LoadingState /> : history.error ? <ErrorState message={describeDataError(history.error)} onRetry={history.reload} /> : (
          (history.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No department operation yet.</p> : (
            <table className="w-full text-sm" aria-label="Department data history">
              <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left">When</th><th className="text-left">Department</th><th className="text-left">Operation</th><th className="text-left">Status</th><th className="text-right">Rows</th><th className="text-left">By</th></tr></thead>
              <tbody>{(history.data ?? []).map((r: DepartmentRun) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="py-1.5 whitespace-nowrap">{formatDateTime(r.started_at)}</td>
                  <td>{departmentLabel(r.department)}</td>
                  <td>{OPERATIONS[r.operation]?.label ?? r.operation}</td>
                  <td><StatusBadge label={r.status} tone={STATUS_TONE[r.status]} />{r.error_message && <span className="block text-xs text-red-700">{r.error_message}</span>}</td>
                  <td className="text-right tabular-nums">{formatNumber(r.deleted_total)}</td>
                  <td>{r.requested_by ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
