import { Activity, CheckCircle2, CircleDashed, Loader2, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { requireSupabase } from '@/lib/supabase'
import { fetchSystemHealth, type HealthCheck, type HealthStatus } from '@/services/admin'

const STATUS: Record<HealthStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  HEALTHY: { label: 'Healthy', icon: CheckCircle2, className: 'text-green-700' },
  DEGRADED: { label: 'Degraded', icon: TriangleAlert, className: 'text-amber-700' },
  UNAVAILABLE: { label: 'Unavailable', icon: XCircle, className: 'text-red-700' },
  NOT_CONFIGURED: { label: 'Not configured', icon: CircleDashed, className: 'text-muted-foreground' },
}

/** Checks made from this browser, against the same services the application uses. */
async function clientChecks(): Promise<HealthCheck[]> {
  const sb = requireSupabase()
  const timed = async <T,>(fn: () => Promise<T>) => { const t = performance.now(); const r = await fn(); return { r, ms: Math.round(performance.now() - t) } }
  const out: HealthCheck[] = []
  try {
    const { r, ms } = await timed(() => sb.auth.getUser())
    out.push(r.error || !r.data.user ? { key: 'client_auth', label: 'Sign-in session (this browser)', status: 'UNAVAILABLE', detail: r.error?.message ?? 'No signed-in user.' }
      : { key: 'client_auth', label: 'Sign-in session (this browser)', status: ms > 3000 ? 'DEGRADED' : 'HEALTHY', detail: `Auth server answered in ${ms} ms.` })
  } catch (e) { out.push({ key: 'client_auth', label: 'Sign-in session (this browser)', status: 'UNAVAILABLE', detail: describeDataError(e) }) }
  try {
    const { r, ms } = await timed(() => sb.storage.from('documents').list('', { limit: 1 }))
    out.push(r.error ? { key: 'client_storage', label: 'File storage (this browser)', status: 'UNAVAILABLE', detail: r.error.message }
      : { key: 'client_storage', label: 'File storage (this browser)', status: ms > 3000 ? 'DEGRADED' : 'HEALTHY', detail: `Private documents bucket reachable in ${ms} ms.` })
  } catch (e) { out.push({ key: 'client_storage', label: 'File storage (this browser)', status: 'UNAVAILABLE', detail: describeDataError(e) }) }
  return out
}

export default function SystemHealthPage() {
  const [state, setState] = useState<{ checks: HealthCheck[]; client: HealthCheck[]; checkedAt: string; latency: number; errors: Awaited<ReturnType<typeof fetchSystemHealth>>['recent_errors'] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true); setError(null)
    const t = performance.now()
    try {
      const [server, client] = await Promise.all([fetchSystemHealth(), clientChecks()])
      setState({ checks: server.checks, client, checkedAt: server.checked_at, latency: Math.round(performance.now() - t), errors: server.recent_errors })
    } catch (e) {
      setError(`The health check could not reach the database: ${describeDataError(e)}`)
      setState(null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void Promise.resolve().then(run) }, [run])

  const all = state ? [...state.checks, ...state.client] : []
  const worst = all.some((c) => c.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : all.some((c) => c.status === 'DEGRADED') ? 'DEGRADED' : 'HEALTHY'
  return (
    <>
      <PageHeader actions={<Button variant="outline" disabled={loading} onClick={() => void run()}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again</Button>} />
      <p className="mb-4 text-sm text-muted-foreground">These checks run only when this page is opened or refreshed; there is no continuous monitoring.{state ? ` Last checked ${formatDateTime(state.checkedAt)} (round trip ${state.latency} ms).` : ''}</p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {loading && !state ? <Card><CardContent className="p-6 text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Running checks…</CardContent></Card> : state && (
        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader><div><CardTitle>Overall: {STATUS[worst].label}</CardTitle><CardDescription>Services that are not set up are shown as “Not configured”, not as failures.</CardDescription></div></CardHeader>
            <CardContent>
              <ul className="divide-y rounded-lg border">{all.map((c) => {
                const s = STATUS[c.status]
                return (
                  <li key={c.key} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <s.icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${s.className}`} />
                    <div className="min-w-0 flex-1"><p className="font-medium">{c.label}</p><p className="text-muted-foreground">{c.detail}</p></div>
                    <span className={`shrink-0 text-xs font-medium ${s.className}`}>{s.label}</span>
                  </li>)
              })}</ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Recent application errors</CardTitle><CardDescription>Reported by browsers and server functions, with sensitive values removed. Quote the reference when reporting a problem.</CardDescription></div></CardHeader>
            <CardContent>
              {!state.errors.length ? <EmptyState icon={Activity} title="No recent errors" description="No errors have been reported for this company." /> : (
                <ul className="max-h-[32rem] space-y-3 overflow-y-auto text-sm">{state.errors.map((e) => (
                  <li key={e.correlation_id + e.at} className="rounded-lg border p-2">
                    <p className="text-xs text-muted-foreground">{formatDateTime(e.at)} · {e.source} · {e.severity.toLowerCase()}{e.code ? ` · ${e.code}` : ''}</p>
                    <p className="break-words">{e.message}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">ref {e.correlation_id}</p>
                  </li>))}</ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
