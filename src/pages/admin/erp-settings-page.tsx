import { ExternalLink, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErpForceResetSection } from '@/features/admin/erp-force-reset-section'
import { ErpResetCard } from '@/features/admin/erp-reset-card'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PERIOD_PRESETS } from '@/features/analytics/analytics-period'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchSystemHealth } from '@/services/admin'
import { fetchCompanySettings, saveCompanySetting } from '@/services/company'
import type { Json } from '@/types/database'

const ALL_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'csv', 'txt', 'xlsx', 'docx']
const SECTIONS: { title: string; description: string; links: { label: string; to: string }[] }[] = [
  { title: 'Company & GST', description: 'Legal name, GSTIN, address, logo and financial year.', links: [{ label: 'Company settings', to: '/admin/erp-settings?tab=company' }] },
  { title: 'Invoicing & numbering', description: 'Invoice series, number formats, payment terms and bank details.', links: [{ label: 'Invoice settings', to: '/billing/settings' }] },
  { title: 'Warehouses & stock', description: 'Warehouses, locations, stock usage and default receiving location.', links: [{ label: 'Warehouses', to: '/inventory/warehouses' }] },
  { title: 'Production', description: 'Bills of materials and their versions.', links: [{ label: 'BOMs', to: '/production/boms' }] },
  { title: 'Users & roles', description: 'Invite users, assign roles, deactivate access.', links: [{ label: 'Users & roles', to: '/users' }] },
]

/** Documents, reporting, integrations, security and data reset (the System tab of ERP Settings). */
export function ErpSystemSettings() {
  const { access } = useAuth()
  const { has, hasRole } = usePermissions()
  const canReset = hasRole('SUPER_ADMIN') && has('system.reset_data')
  const companyId = access?.company?.id ?? ''
  const [refresh, setRefresh] = useState(0)
  const data = useAsync(() => fetchCompanySettings(companyId), [companyId, refresh])
  const health = useAsync(fetchSystemHealth, [])
  const setting = (key: string) => data.data?.settings.find((s) => s.setting_key === key)
  const current = {
    maxMb: Number(setting('documents.max_file_mb')?.setting_value ?? 25),
    exts: Array.isArray(setting('documents.allowed_extensions')?.setting_value) ? (setting('documents.allowed_extensions')!.setting_value as string[]) : ALL_EXTENSIONS,
    period: (setting('reporting.default_period')?.setting_value as string | undefined) ?? 'this_month',
  }
  const [draft, setDraft] = useState<{ maxMb: string; exts: string[]; period: string } | null>(null)
  const form = draft ?? { maxMb: String(current.maxMb), exts: current.exts, period: current.period }
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const changes: { key: string; value: Json; label: string }[] = []
  const mb = Number(form.maxMb)
  if (draft && mb !== current.maxMb) changes.push({ key: 'documents.max_file_mb', value: mb, label: `Maximum document size: ${current.maxMb} MB → ${mb} MB` })
  if (draft && [...form.exts].sort().join() !== [...current.exts].sort().join()) changes.push({ key: 'documents.allowed_extensions', value: form.exts, label: `Allowed file types: ${form.exts.join(', ')}` })
  if (draft && form.period !== current.period) changes.push({ key: 'reporting.default_period', value: form.period, label: `Default report period: ${PERIOD_PRESETS.find((p) => p.value === form.period)?.label}` })

  const validate = () => {
    if (!Number.isInteger(mb) || mb < 1 || mb > 25) return 'The maximum document size must be a whole number from 1 to 25 MB (the storage limit).'
    if (!form.exts.length) return 'Allow at least one file type.'
    return null
  }
  const save = async () => {
    setConfirm(false); setBusy(true); setError(null)
    try {
      for (const c of changes) await saveCompanySetting(companyId, c.key, c.value, setting(c.key))
      setDraft(null); setRefresh((n) => n + 1); setMessage('Settings saved. The change is recorded in the audit log.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const integration = (key: string) => health.data?.checks.find((c) => c.key === key)

  return (
    <>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader><div><CardTitle>Documents & reporting</CardTitle><CardDescription>Applied by the server when files are uploaded and when reports open.</CardDescription></div></CardHeader>
            <CardContent className="space-y-4">
              {data.loading && !data.data ? <LoadingState variant="table" rows={3} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} /> : <>
                <div className="flex flex-wrap gap-4">
                  <div className="space-y-1"><Label htmlFor="es-mb">Maximum document size (MB)</Label><Input id="es-mb" className="w-28" inputMode="numeric" value={form.maxMb} onChange={(e) => setDraft({ ...form, maxMb: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor="es-period">Default report period</Label>
                    <Select value={form.period} onValueChange={(v) => setDraft({ ...form, period: v })}><SelectTrigger id="es-period" className="w-52"><SelectValue /></SelectTrigger>
                      <SelectContent>{PERIOD_PRESETS.filter((p) => p.value !== 'custom').map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent></Select></div>
                </div>
                <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm"><legend className="mb-1 text-sm font-medium">Allowed document file types</legend>
                  {ALL_EXTENSIONS.map((x) => (
                    <label key={x} className="flex items-center gap-1.5"><Checkbox checked={form.exts.includes(x)} onCheckedChange={(v) => setDraft({ ...form, exts: v === true ? [...form.exts, x] : form.exts.filter((e) => e !== x) })} /> .{x}</label>
                  ))}
                </fieldset>
                <div className="flex gap-2">
                  <Button disabled={!changes.length || busy} onClick={() => { const v = validate(); if (v) setError(v); else { setError(null); setConfirm(true) } }}>{busy && <Loader2 className="animate-spin" />} Save changes</Button>
                  {draft && <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>Discard</Button>}
                </div>
              </>}
            </CardContent>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <Card key={s.title} className="gap-2 p-4">
                <p className="font-medium">{s.title}</p><p className="text-sm text-muted-foreground">{s.description}</p>
                <div className="flex flex-wrap gap-3 text-sm">{s.links.map((l) => <Link key={l.to} className="inline-flex items-center gap-1 text-primary hover:underline" to={l.to}>{l.label} <ExternalLink className="size-3" /></Link>)}</div>
              </Card>
            ))}
          </div>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader><div><CardTitle>Integrations</CardTitle><CardDescription>Only services that are actually set up are used.</CardDescription></div></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {health.loading && !health.data ? <Loader2 className="size-4 animate-spin" /> : health.error ? <p className="text-muted-foreground">Integration status needs System Health access.</p> : ['email', 'push', 'e_invoicing', 'realtime', 'scheduled_jobs'].map((k) => {
                const c = integration(k)
                return c ? <div key={k} className="flex justify-between gap-3"><span>{c.label}</span><span className={c.status === 'HEALTHY' ? 'text-green-700' : 'text-muted-foreground'}>{c.status === 'NOT_CONFIGURED' ? 'Not configured' : c.status.charAt(0) + c.status.slice(1).toLowerCase()}</span></div> : null
              })}
              <p className="pt-2 text-xs text-muted-foreground">API keys for outside services are never stored in settings the browser can read; they belong in server-side secrets.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Security & audit</CardTitle></div></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Every company's data is isolated by row-level security in the database; permissions are checked on the server for every change.</p>
              <p>The audit log is append-only. Settings, approvals, documents, imports, stock movements and billing actions are recorded. <Link className="text-primary hover:underline" to="/audit-logs">Open the audit log</Link>.</p>
              <p>Barcodes are unique across the company, enforced by the database.</p>
              <p>The last active Super Admin cannot be deactivated or lose that role.</p>
            </CardContent>
          </Card>
          {canReset && <ErpResetCard />}
        </div>
      </div>
      {canReset && access?.company && (
        <div className="mt-6">
          <ErpForceResetSection companyId={access.company.id} companyCode={access.company.company_code}
            companyName={access.company.display_name || access.company.legal_name} />
        </div>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Save these settings?" confirmLabel="Save" description={changes.map((c) => c.label).join('. ') + '.'} onConfirm={() => void save()} />
    </>
  )
}

export default function ErpSettingsPage() {
  return <><PageHeader /><ErpSystemSettings /></>
}
