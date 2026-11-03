import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import {
  RESET_CONFIRMATION,
  ResetError,
  fetchResetPreview,
  groupDeletion,
  newResetRequestId,
  runErpReset,
  type ResetBlocker,
  type ResetPreview,
  type ResetResult,
} from '@/services/erp-reset'

const fmt = (n: number) => n.toLocaleString('en-IN')
export const RESET_SUCCESS_MESSAGE =
  'ERP data reset completed successfully. Eligible business data was deleted from Supabase. Your super admin account and system configuration have been preserved.'

function BlockerList({ blockers }: { blockers: ResetBlocker[] }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">The reset cannot run: the database protects these records and nothing will be deleted.</p>
      <ul className="space-y-1">
        {blockers.map((b) => (
          <li key={`${b.kind}:${b.table}`}>
            <span className="font-medium">{b.label}</span>{b.rows != null && <> ({fmt(b.rows)})</>}: {b.reason}
          </li>
        ))}
      </ul>
      <p className="text-xs">These guards (stock ledger, posted documents, invoices, payments, BOMs and history) are never disabled to force a reset.</p>
    </div>
  )
}

/** "Reset ERP Data" card for ERP Settings. Render only for Super Admins; the server enforces it anyway. */
export function ErpResetCard() {
  const preview = useAsync(fetchResetPreview, [])
  const [open, setOpen] = useState(false)

  return (
    <Card className="border-red-200">
      <CardHeader>
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-red-600" />
          <div>
            <CardTitle>Reset ERP Data</CardTitle>
            <CardDescription>Permanently deletes business and operational data of this company from the Supabase database. This cannot be undone.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {preview.loading && !preview.data ? <Loader2 className="size-4 animate-spin" aria-label="Loading impact" />
          : preview.error ? <ErrorState message={describeDataError(preview.error)} onRetry={preview.reload} />
          : preview.data && <ResetImpact preview={preview.data} />}
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Before resetting, take a verified database backup (Supabase Dashboard → Database → Backups, or <code>supabase db dump</code>) and check that it restores.
        </p>
        <Button variant="destructive" className="w-full" disabled={!preview.data?.can_reset} onClick={() => setOpen(true)}>
          <AlertTriangle /> Reset ERP Data
        </Button>
        {preview.data && !preview.data.can_reset && <p className="text-xs text-muted-foreground">Unavailable while protected records exist (listed above).</p>}
      </CardContent>
      {open && preview.data && <ResetDialog preview={preview.data} onClose={() => { setOpen(false); preview.reload() }} />}
    </Card>
  )
}

function ResetImpact({ preview }: { preview: ResetPreview }) {
  const groups = groupDeletion(preview.delete)
  const kept = preview.keep.filter((k) => k.table !== 'suppliers' || k.rows > 0)
  return (
    <div className="space-y-3">
      {preview.blockers.length > 0 && <BlockerList blockers={preview.blockers} />}
      <div>
        <p className="font-medium">Will be deleted ({fmt(preview.delete_total)} records)</p>
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {groups.map((g) => (
            <li key={g.category}>
              <details>
                <summary className="cursor-pointer"><span className="text-foreground">{g.category}</span>: {fmt(g.total)}</summary>
                <ul className="ml-4 text-xs">{g.tables.map((t) => <li key={t.table}>{t.label}: {fmt(t.rows)}</li>)}</ul>
              </details>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="flex items-center gap-1.5 font-medium"><ShieldCheck className="size-4 text-green-700" aria-hidden /> Kept</p>
        <p className="mt-1 text-muted-foreground">
          Your Super Admin account and all other users and their roles, the company record and settings, roles and permissions, the audit log,
          number series, approval workflows, warehouses and locations, products and categories, documents and the database schema.
        </p>
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Counts of kept records</summary>
          <ul className="ml-4">{kept.map((k) => <li key={k.table + k.label}>{k.label}: {fmt(k.rows)}</li>)}</ul>
        </details>
      </div>
      {preview.recent_runs.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Previous reset attempts</summary>
          <ul className="ml-4">{preview.recent_runs.map((r) => (
            <li key={r.id}>{new Date(r.started_at).toLocaleString('en-IN')}: {r.status.toLowerCase()}{r.status === 'COMPLETED' ? `, ${fmt(r.deleted_total)} records deleted` : ''}</li>
          ))}</ul>
        </details>
      )}
    </div>
  )
}

function ResetDialog({ preview, onClose }: { preview: ResetPreview; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [requestId, setRequestId] = useState(newResetRequestId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; blockers?: ResetBlocker[] } | null>(null)
  const [done, setDone] = useState<ResetResult | null>(null)
  const ready = password.length > 0 && confirmation === RESET_CONFIRMATION && !busy

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      setDone(await runErpReset({ password, confirmation, requestId }))
    } catch (e) {
      const err = e instanceof ResetError ? e : null
      setError({ message: err?.message ?? describeDataError(e), blockers: err?.result?.blockers?.length ? err.result.blockers : undefined })
      // A stored BLOCKED / FAILED run would be replayed for the same id; a new
      // submission needs a new id. Network errors keep the id so a retry is safe.
      if (err?.result?.status === 'BLOCKED' || err?.result?.status === 'FAILED') setRequestId(newResetRequestId())
    } finally {
      setPassword('') // never kept after the request
      setBusy(false)
    }
  }

  // Everything on screen (dashboards, lists, totals) is reloaded from the database.
  const reloadErp = () => window.location.assign('/admin/erp-settings?tab=system')

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) { if (done) reloadErp(); else onClose() } }}>
      <DialogContent showCloseButton={!busy}>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><CheckCircle2 className="size-5 text-green-700" aria-hidden /> Reset complete</DialogTitle>
              <DialogDescription>{RESET_SUCCESS_MESSAGE}</DialogDescription>
            </DialogHeader>
            <p className="text-sm">{fmt(done.deleted_total ?? 0)} records were deleted and verified on the server.</p>
            <DialogFooter><Button onClick={reloadErp}>Reload the ERP</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><AlertTriangle className="size-5 text-red-600" aria-hidden /> Permanently Reset ERP Data?</DialogTitle>
              <DialogDescription>
                This permanently deletes {fmt(preview.delete_total)} business records of this company from Supabase: orders, customers, suppliers not used by
                products, stock records, notifications, Amazon data and the rest listed on the settings page. It cannot be undone. Users, roles, settings,
                products, the audit log and the database schema are kept, and you stay signed in.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
              <div className="space-y-1">
                <Label htmlFor="reset-password">Your password</Label>
                <Input id="reset-password" type="password" autoComplete="current-password" value={password} disabled={busy}
                  onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reset-confirm">Type <span className="font-mono font-semibold">{RESET_CONFIRMATION}</span> to confirm</Label>
                <Input id="reset-confirm" autoComplete="off" spellCheck={false} value={confirmation} disabled={busy}
                  onChange={(e) => setConfirmation(e.target.value)} />
              </div>
              {error && (error.blockers ? <BlockerList blockers={error.blockers} />
                : <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error.message}</p>)}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
                <Button type="submit" variant="destructive" disabled={!ready}>{busy && <Loader2 className="animate-spin" />} Permanently Reset ERP</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
