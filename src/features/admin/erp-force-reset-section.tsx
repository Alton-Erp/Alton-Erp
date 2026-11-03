import { AlertTriangle, CheckCircle2, CircleX, History, Loader2, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { ErrorState } from '@/components/common/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { groupDeletion } from '@/features/admin/erp-reset-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { newResetRequestId } from '@/services/erp-reset'
import {
  FORCE_SUCCESS_MESSAGE,
  ForceResetError,
  fetchForcePreview,
  fetchResetHistory,
  forceGates,
  runForceReset,
  type ForceBlocker,
  type ForcePreview,
  type ForceResult,
} from '@/services/erp-force-reset'

const fmt = (n: number) => n.toLocaleString('en-IN')
const when = (iso: string) => new Date(iso).toLocaleString('en-IN')

interface Outcome { kind: 'error' | 'blocked'; message: string; result?: ForceResult | null }

/**
 * "Force Reset / Delete Everything": deletes all business data of the company
 * directly (no approval, backup record or password step since 20261113).
 * Render only for Super Admins with system.reset_data; the database enforces it anyway.
 */
export function ErpForceResetSection({ companyId, companyName, companyCode }: { companyId: string; companyName: string; companyCode: string }) {
  const [preview, setPreview] = useState<ForcePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'reset' | 'history' | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setPreview(await fetchForcePreview(companyId))
    } catch (e) {
      setLoadError(describeDataError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="border-red-300 bg-white" data-testid="force-reset-section">
      <CardHeader>
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-6 shrink-0 text-red-600" />
          <div className="space-y-1">
            <CardTitle className="text-red-700">Force Reset / Delete Everything</CardTitle>
            <CardDescription>
              Permanently deletes <span className="font-medium text-foreground">all</span> business data of the company, including the protected history the
              standard reset cannot delete: posted stock, issued invoices, payments, BOMs, production, import and approval history, products, warehouses and
              stored files. It runs immediately and cannot be undone. Users, roles, settings and the audit log are kept.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid gap-x-6 gap-y-1 rounded-lg border bg-muted/40 px-4 py-3 sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Target company</dt><dd className="font-medium">{preview?.company.name ?? companyName}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Company code</dt><dd className="font-mono">{preview?.company.code ?? companyCode}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">Company ID</dt><dd className="break-all font-mono text-xs">{preview?.company.id ?? companyId}</dd></div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <ScanSearch />} Preview Force Reset
          </Button>
          <Button variant="destructive" onClick={() => { setOutcome(null); setDialog('reset') }}>
            <Trash2 /> Force Reset / Delete Everything
          </Button>
          <Button variant="outline" onClick={() => setDialog('history')}><History /> View Reset History</Button>
        </div>

        {loadError && <ErrorState message={loadError} onRetry={() => void load()} />}
        {!preview && !loadError && (
          <p className="text-muted-foreground">Run <span className="font-medium">Preview Force Reset</span> to see exactly what would be deleted and kept. The preview changes nothing.</p>
        )}
        {preview && <ForcePreviewPanel preview={preview} />}
        {outcome && <OutcomePanel outcome={outcome} />}
      </CardContent>

      {dialog === 'reset' && (
        <ForceResetDialog companyId={companyId} companyName={preview?.company.name ?? companyName} companyCode={preview?.company.code ?? companyCode}
          onClose={(o) => { setDialog(null); if (o) setOutcome(o); if (preview) void load() }} />
      )}
      {dialog === 'history' && <HistoryDialog onClose={() => setDialog(null)} />}
    </Card>
  )
}

function GateList({ preview }: { preview: ForcePreview }) {
  return (
    <ul className="space-y-1.5" aria-label="Force reset requirements">
      {forceGates(preview).map((g) => (
        <li key={g.key} className="flex items-start gap-2" data-gate={g.key} data-ok={g.ok}>
          {g.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-700" aria-label="passed" />
            : <CircleX className="mt-0.5 size-4 shrink-0 text-red-600" aria-label="not met" />}
          <span><span className="font-medium">{g.label}</span> <span className="text-muted-foreground">{g.detail}</span></span>
        </li>
      ))}
    </ul>
  )
}

function BlockerList({ blockers, title }: { blockers: ForceBlocker[]; title: string }) {
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
      <p className="font-medium">{title}</p>
      <ul className="space-y-1">
        {blockers.map((b, i) => (
          <li key={`${b.kind}:${b.table ?? i}`}><span className="font-medium">{b.label}</span>{b.rows != null && <> ({fmt(b.rows)})</>}: {b.reason}</li>
        ))}
      </ul>
    </div>
  )
}

function ForcePreviewPanel({ preview }: { preview: ForcePreview }) {
  const groups = groupDeletion(preview.tables.map((t) => ({ table: t.table, label: t.label, category: t.category, rows: t.rows })))
  const byTable = new Map(preview.tables.map((t) => [t.table, t]))
  const protectedRows = preview.tables.filter((t) => t.protected && t.rows > 0)
  const files = preview.storage.product_images + preview.storage.documents
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Records to delete', fmt(preview.delete_total)],
          ['Protected records', fmt(preview.protected_total)],
          ['Stored files to remove', fmt(files)],
          ['Tables inspected', fmt(preview.discovered_tables)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-white px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold tabular-nums" data-stat={label}>{value}</p>
          </div>
        ))}
      </div>

      <GateList preview={preview} />
      {preview.blockers.length > 0 && <BlockerList blockers={preview.blockers} title="Schema problems: the force reset cannot run until these are resolved." />}

      <div>
        <p className="font-medium">Will be deleted, by module ({fmt(preview.delete_total)} records)</p>
        <ul className="mt-1 divide-y rounded-lg border">
          {groups.map((g) => (
            <li key={g.category}>
              <details>
                <summary className="flex cursor-pointer justify-between gap-3 px-3 py-2">
                  <span>{g.category}</span><span className="tabular-nums text-muted-foreground">{fmt(g.total)}</span>
                </summary>
                <table className="mb-2 w-full text-xs">
                  <tbody>
                    {g.tables.map((t) => {
                      const info = byTable.get(t.table)
                      return (
                        <tr key={t.table} className="border-t">
                          <td className="px-3 py-1">{t.label} <span className="font-mono text-muted-foreground">{t.table}</span></td>
                          <td className="px-3 py-1">{info?.protected && <Badge variant="outline" className="border-amber-400 text-amber-800">Protected</Badge>}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{fmt(t.rows)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </details>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="font-medium">Protected records the standard reset cannot delete</p>
        {protectedRows.length === 0 ? <p className="text-muted-foreground">None for this company.</p> : (
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {protectedRows.map((t) => <li key={t.table}><span className="text-foreground">{t.label}</span> ({fmt(t.rows)}): {t.protection}</li>)}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          These are deleted only inside the force reset, for this company only. The database guards stay on; updates and deletes outside the reset are still refused.
        </p>
      </div>

      <div>
        <p className="flex items-center gap-1.5 font-medium"><ShieldCheck className="size-4 text-green-700" aria-hidden /> Kept</p>
        <ul className="mt-1 grid gap-x-6 text-muted-foreground sm:grid-cols-2">
          {preview.retained.map((r) => <li key={r.table + r.label}><span className="text-foreground">{r.label}</span> ({fmt(r.rows)})</li>)}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">
          Supabase Auth accounts are never deleted. Number series continue from their current values.
          {' '}demo_presentation_data: {preview.demo_presentation_data === 'RESETTABLE' ? 'deleted for this company'
            : preview.demo_presentation_data === 'NOT_PRESENT' ? 'not present in this database' : 'cannot be limited to one company (see problems above)'}.
          {preview.unaffected_tables.length > 0 && <> Global tables not affected: {preview.unaffected_tables.join(', ')}.</>}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Preview generated {when(preview.generated_at)}.</p>
    </div>
  )
}

function OutcomePanel({ outcome }: { outcome: Outcome }) {
  const r = outcome.result
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-red-900" data-testid="force-reset-outcome">
      <p className="font-medium">{outcome.kind === 'blocked' ? 'The force reset did not run.' : 'The force reset failed. Nothing was deleted.'}</p>
      <p>{outcome.message}</p>
      {r?.blockers && r.blockers.length > 0 && <ul className="list-disc pl-5">{r.blockers.map((b, i) => <li key={i}>{b.label}: {b.reason}</li>)}</ul>}
    </div>
  )
}

function ForceResetDialog({ companyId, companyName, companyCode, onClose }: {
  companyId: string; companyName: string; companyCode: string; onClose: (o: Outcome | null) => void
}) {
  const [requestId] = useState(newResetRequestId)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ForceResult | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      setDone(await runForceReset({ companyId, requestId }))
    } catch (e) {
      const err = e instanceof ForceResetError ? e : null
      const status = err?.result?.status
      onClose({ kind: status === 'BLOCKED' || status === 'DENIED' || status === 'IN_PROGRESS' ? 'blocked' : 'error', message: err?.message ?? describeDataError(e), result: err?.result })
    } finally {
      setBusy(false)
    }
  }
  const reloadErp = () => window.location.assign('/admin/erp-settings?tab=system')
  const left = done?.storage_cleanup ? done.storage_cleanup.listed - done.storage_cleanup.removed : 0

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) { if (done) reloadErp(); else onClose(null) } }}>
      <DialogContent showCloseButton={!busy}>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><CheckCircle2 className="size-5 text-green-700" aria-hidden /> Force reset complete</DialogTitle>
              <DialogDescription>{FORCE_SUCCESS_MESSAGE}</DialogDescription>
            </DialogHeader>
            <p>{fmt(done.deleted_total ?? 0)} records and {fmt(done.storage_cleanup?.removed ?? 0)} stored files were deleted.</p>
            {left > 0 && <p className="text-sm text-muted-foreground">{fmt(left)} stored file(s) could not be removed from the browser (stored document versions are write-once). They are no longer linked to any record.</p>}
            <DialogFooter><Button onClick={reloadErp}>Reload the ERP</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><AlertTriangle className="size-5 text-red-600" aria-hidden /> Delete everything in {companyName}?</DialogTitle>
              <DialogDescription>
                All orders, invoices, payments, stock, production, customers, suppliers, products and warehouses of {companyName} ({companyCode}) are deleted
                immediately and permanently. Users, roles, settings and the audit log are kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onClose(null)}>Cancel</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void run()}>
                {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete everything now
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function HistoryDialog({ onClose }: { onClose: () => void }) {
  const history = useAsync(fetchResetHistory, [])
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="size-5" aria-hidden /> Reset history</DialogTitle>
          <DialogDescription>Every standard and force reset attempt of this company. The history cannot be edited or deleted.</DialogDescription>
        </DialogHeader>
        {history.loading && !history.data ? <Loader2 className="size-4 animate-spin" aria-label="Loading history" />
          : history.error ? <ErrorState message={describeDataError(history.error)} onRetry={history.reload} />
            : !history.data?.length ? <p className="text-muted-foreground">No reset has been attempted.</p> : (
              <div className="max-h-[60vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">When</th><th>Type</th><th>Result</th><th className="text-right">Deleted</th></tr></thead>
                  <tbody>
                    {history.data.map((r) => (
                      <tr key={r.id} className="border-t align-top">
                        <td className="py-1.5 pr-2">{when(r.started_at)}</td>
                        <td className="pr-2">{r.mode === 'FORCE' ? 'Force' : 'Standard'}</td>
                        <td className="pr-2">
                          <span className={r.status === 'COMPLETED' ? 'text-green-700' : r.status === 'FAILED' ? 'text-red-700' : 'text-amber-700'}>{r.status.toLowerCase()}</span>
                          {r.error_message && <p className="text-xs text-muted-foreground">{r.error_message}</p>}
                          {r.status === 'BLOCKED' && r.blockers.length > 0 && <p className="text-xs text-muted-foreground">{r.blockers.map((b) => b.label).join(', ')}</p>}
                        </td>
                        <td className="text-right tabular-nums">{fmt(r.deleted_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
