import { CheckCircle2, FlaskConical, Loader2, PlugZap, RefreshCw, Save, ShieldAlert, Trash2, Upload, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AmazonSettings } from '@/features/amazon/analysis'
import { parseAmazonReport, type ParsedReport } from '@/features/amazon/report-import'
import { todayIn } from '@/features/amazon/use-amazon'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  clearDemo, EdgeUnavailableError, fetchConnections, fetchSettings, importRows, invokeAmazon, loadDemo, stableUuid, updateSettings, type Connection, type ImportResult,
} from '@/services/amazon'

const STATUS_TONE: Record<Connection['status'], 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  NOT_CONFIGURED: 'neutral', CONFIGURED: 'info', CONNECTED: 'success', ERROR: 'danger', DISCONNECTED: 'warning',
}
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000))
const minuteKey = () => Math.floor(Date.now() / 60000)

function Notice({ tone, children }: { tone: 'ok' | 'error' | 'warn'; children: ReactNode }) {
  const cls = tone === 'ok' ? 'border-green-200 bg-green-50 text-green-800' : tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</p>
}

export default function AmazonSettingsPage() {
  const { has } = usePermissions()
  const [reload, setReload] = useState(0)
  const settings = useAsync(() => fetchSettings(), [reload])
  const conns = useAsync(() => fetchConnections(), [reload])
  const bump = () => setReload((n) => n + 1)
  if ((settings.loading && !settings.data) || (conns.loading && !conns.data)) return <><PageHeader /><LoadingState variant="table" rows={6} /></>
  if (settings.error || conns.error) return <><PageHeader /><ErrorState message={describeDataError(settings.error ?? conns.error)} onRetry={bump} /></>
  const byApi = (api: Connection['api']) => conns.data?.find((c) => c.api === api)
  return (
    <>
      <PageHeader />
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <ConnectionCard api="SP_API" conn={byApi('SP_API')} canManage={has('amazon_integration.manage')} onChanged={bump} />
          <ConnectionCard api="ADS_API" conn={byApi('ADS_API')} canManage={has('amazon_integration.manage')} onChanged={bump} />
        </div>
        <SetupInstructions />
        {settings.data && <AnalysisSettings settings={settings.data} canEdit={has('amazon.manage')} onSaved={bump} />}
        {settings.data && <AutomationSettings settings={settings.data} canEdit={has('amazon_ads.approve')} onSaved={bump} />}
        {has('amazon.manage') && <ReportImport />}
        {has('amazon.manage') && <DemoData />}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
function ConnectionCard({ api, conn, canManage, onChanged }: { api: Connection['api']; conn?: Connection; canManage: boolean; onChanged: () => void }) {
  const fn = api === 'SP_API' ? 'amazon-spapi' : 'amazon-ads'
  const title = api === 'SP_API' ? 'Selling Partner API (seller account)' : 'Amazon Ads API (Sponsored Products)'
  const today = todayIn('Asia/Kolkata')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [vars, setVars] = useState<{ name: string; set: boolean }[] | null>(null)
  const [from, setFrom] = useState(addDays(today, api === 'SP_API' ? -7 : -14))
  const [to, setTo] = useState(addDays(today, -1))
  const call = async (label: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => { tone: 'ok' | 'warn'; text: string }) => {
    setBusy(label); setMsg(null)
    try {
      const r = await invokeAmazon(fn, body)
      if (Array.isArray(r.variables)) setVars(r.variables as { name: string; set: boolean }[])
      setMsg(describe(r))
    } catch (e) {
      const payload = (e as { payload?: { variables?: { name: string; set: boolean }[] } }).payload
      if (payload?.variables) setVars(payload.variables)
      setMsg({ tone: e instanceof EdgeUnavailableError ? 'warn' : 'error', text: e instanceof EdgeUnavailableError ? e.message : describeDataError(e) })
    } finally {
      setBusy(null); onChanged()
    }
  }
  const job = (r: Record<string, unknown>) => ({ tone: r.status === 'WAITING_REPORT' || r.status === 'PARTIAL' ? 'warn' as const : 'ok' as const,
    text: r.duplicate ? `This request was already run (job ${String(r.job_id).slice(0, 8)}, ${String(r.status)}).`
      : r.status === 'WAITING_REPORT' ? `Amazon is still generating ${String(r.pending)} report(s). Resume the job from Sync History later.` : `Synchronisation ${String(r.status).toLowerCase()}. See Sync History for row counts.` })
  const sync = async (kind: string, range: boolean) =>
    call(kind, { action: 'sync', kind, ...(range ? { from, to } : {}), key: await stableUuid(`sp:${kind}:${range ? `${from}:${to}` : today}:${minuteKey()}`) }, job)
  return (
    <Card>
      <CardHeader><div className="space-y-1"><CardTitle className="flex flex-wrap items-center gap-2"><PlugZap className="size-4" /> {title}
        <StatusBadge label={(conn?.status ?? 'NOT_CONFIGURED').replace(/_/g, ' ').toLowerCase()} tone={STATUS_TONE[conn?.status ?? 'NOT_CONFIGURED']} /></CardTitle>
        <CardDescription>{api === 'SP_API' ? 'Listings, sales & traffic, FBA inventory and settlement fees. Read-only.' : 'Campaigns, ad groups, keywords and daily performance reports. Changes only through approved requests.'}</CardDescription></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Account</dt><dd>{conn?.account_name ?? '-'}</dd>
          <dt className="text-muted-foreground">{api === 'SP_API' ? 'Marketplaces' : 'Profile'}</dt><dd>{api === 'SP_API' ? (conn?.marketplace_ids.join(', ') || '-') : (conn?.profile_id ?? '-')}{conn?.region ? ` · ${conn.region}` : ''}</dd>
          <dt className="text-muted-foreground">Last test</dt><dd>{conn?.last_test_at ? `${formatDateTime(conn.last_test_at)} — ${conn.last_test_message ?? ''}` : 'never'}</dd>
          <dt className="text-muted-foreground">Last successful sync</dt><dd>{conn?.last_successful_sync_at ? formatDateTime(conn.last_successful_sync_at) : 'never'}</dd>
          {conn?.last_error_message && <><dt className="text-muted-foreground">Last error</dt><dd className="text-shortage">{conn.last_error_at ? `${formatDateTime(conn.last_error_at)}: ` : ''}{conn.last_error_message}</dd></>}
        </dl>
        {conn && conn.permissions.length > 0 && (
          <ul className="space-y-0.5">{conn.permissions.map((p) => <li key={p.name} className="flex items-start gap-2">{p.status === 'FAIL' ? <XCircle className="mt-0.5 size-4 text-shortage" /> : <CheckCircle2 className={`mt-0.5 size-4 ${p.status === 'PASS' ? 'text-available' : 'text-muted-foreground'}`} />}
            <span>{p.name}{p.status !== 'PASS' && p.detail ? ` — ${p.detail}` : ''}</span></li>)}</ul>)}
        {vars && <ul className="grid gap-0.5 sm:grid-cols-2">{vars.map((v) => <li key={v.name} className="flex items-center gap-1.5 font-mono text-xs">{v.set ? <CheckCircle2 className="size-3.5 text-available" /> : <XCircle className="size-3.5 text-shortage" />}{v.name}</li>)}</ul>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {canManage ? (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void call('config', { action: 'config' }, (r) => ({ tone: 'ok', text: `Secret names checked (values are never shown). Region ${String(r.region ?? 'not set')}.` }))}>
                {busy === 'config' && <Loader2 className="animate-spin" />} Check configuration</Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void call('test', { action: 'test' }, (r) => ({ tone: r.ok ? 'ok' : 'warn',
                text: r.ok ? 'Amazon accepted the credentials. Connection confirmed.' : 'Amazon answered, but the configured marketplace / profile was not found for this account.' }))}>
                {busy === 'test' ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label htmlFor={`${api}-from`}>From</Label><Input id={`${api}-from`} type="date" className="w-38" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor={`${api}-to`}>To</Label><Input id={`${api}-to`} type="date" className="w-38" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></div>
              {api === 'SP_API' ? <>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sync('SALES_TRAFFIC', true)}>{busy === 'SALES_TRAFFIC' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sales & traffic</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sync('FINANCES', true)}>{busy === 'FINANCES' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Settlement fees</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sync('LISTINGS', false)}>{busy === 'LISTINGS' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Listings</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sync('INVENTORY', false)}>{busy === 'INVENTORY' ? <Loader2 className="animate-spin" /> : <RefreshCw />} FBA inventory</Button>
              </> : <>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void stableUuid(`ads:entities:${today}:${minuteKey()}`).then((key) => call('entities', { action: 'sync_entities', key }, job))}>
                  {busy === 'entities' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Campaigns & keywords</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void stableUuid(`ads:reports:${from}:${to}:${minuteKey()}`).then((key) => call('reports', { action: 'request_reports', from, to, key }, job))}>
                  {busy === 'reports' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Performance reports</Button>
              </>}
            </div>
            <p className="text-xs text-muted-foreground">{api === 'SP_API' ? 'Sales & traffic and fees: up to 7 days per run (Amazon report limits). Listings and inventory are current snapshots.'
              : 'Performance reports: up to 31 days per run. Amazon may take several minutes to generate reports; waiting jobs can be resumed in Sync History. Data of the last 3 days can still change (attribution).'}</p>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">How to disconnect</summary>
              <p className="mt-1">{api === 'SP_API' ? 'Revoke the application in Seller Central (Apps & Services > Manage Your Apps) and delete the AMAZON_SPAPI_* secrets in Supabase.'
                : 'Remove the app authorisation in your Amazon Ads account (or revoke the Login with Amazon consent) and delete the AMAZON_ADS_* secrets in Supabase.'} Stored data stays until you delete it; the status changes to error on the next test.</p></details>
          </div>
        ) : <p className="text-xs text-muted-foreground">You need the "Amazon integration: manage" permission to test or synchronise.</p>}
      </CardContent>
    </Card>
  )
}

function SetupInstructions() {
  return (
    <Card>
      <CardHeader><div><CardTitle>Credentials and authorisation</CardTitle>
        <CardDescription>Credentials are stored only as Supabase Edge Function secrets. They are never entered here, stored in the database or sent to the browser.</CardDescription></div></CardHeader>
      <CardContent className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="space-y-2">
          <p className="font-medium">Selling Partner API</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>In Seller Central (Amazon.in) open Apps & Services &gt; Develop Apps and register as a private developer.</li>
            <li>Create an app client with the roles: Product Listing (listings report), Amazon Fulfillment (FBA inventory), Finance and Accounting (settlement fees) and Brand Analytics (Sales & Traffic report). Test connection checks each one.</li>
            <li>Note the LWA client id and client secret, then "Authorize" the app for your own account to obtain a refresh token.</li>
            <li>Set the secrets (Supabase dashboard &gt; Edge Functions &gt; Secrets, or <code>supabase secrets set</code>):</li>
          </ol>
          <pre className="overflow-x-auto rounded bg-surface-muted p-2 text-xs">{`AMAZON_SPAPI_LWA_CLIENT_ID=<from Seller Central>
AMAZON_SPAPI_LWA_CLIENT_SECRET=<from Seller Central>
AMAZON_SPAPI_REFRESH_TOKEN=<from self-authorisation>
AMAZON_SPAPI_REGION=EU            # Amazon.in is served by the EU endpoint
AMAZON_SPAPI_MARKETPLACE_IDS=A21TJRUUN4KGV
AMAZON_COMPANY_CODE=<ERP company code>`}</pre>
          <p>Deploy with <code>supabase functions deploy amazon-spapi</code>, then use Test connection.</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium">Amazon Ads API</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Create a Login with Amazon security profile and apply for Amazon Ads API access (advertising.amazon.com/API).</li>
            <li>After approval, complete the OAuth consent with scope <code>advertising::campaign_management</code> to get a refresh token.</li>
            <li>Run Test connection once with the profile empty to list your profiles, then set the profile id for the Amazon.in advertiser.</li>
          </ol>
          <pre className="overflow-x-auto rounded bg-surface-muted p-2 text-xs">{`AMAZON_ADS_CLIENT_ID=<LWA client id>
AMAZON_ADS_CLIENT_SECRET=<LWA client secret>
AMAZON_ADS_REFRESH_TOKEN=<from OAuth consent>
AMAZON_ADS_REGION=EU              # Amazon.in advertisers use the EU endpoint
AMAZON_ADS_PROFILE_ID=<profile id>
AMAZON_COMPANY_CODE=<ERP company code>`}</pre>
          <p>Deploy with <code>supabase functions deploy amazon-ads</code>. Both functions also read <code>ALLOWED_ORIGINS</code>. See docs/AMAZON_INTEGRATION.md.</p>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Settings forms
// ---------------------------------------------------------------------------
type NumField = { key: keyof AmazonSettings; label: string; help: string; optional?: boolean }
const ANALYSIS: NumField[] = [
  { key: 'attribution_window_days', label: 'Attribution window (days)', help: 'Recent days are treated as incomplete before bid / pause suggestions.' },
  { key: 'min_clicks_for_decision', label: 'Minimum clicks for a decision', help: 'Below this, keyword and campaign suggestions are "needs more data".' },
  { key: 'min_orders_for_scaling', label: 'Minimum orders before scaling', help: '' },
  { key: 'wasted_spend_threshold', label: 'Wasted-spend threshold (₹)', help: 'Spend without orders that flags a search term.' },
  { key: 'low_stock_cover_days', label: 'Low stock cover (days)', help: '' },
  { key: 'overstock_cover_days', label: 'Overstock cover (days)', help: '' },
  { key: 'target_contribution_pct', label: 'Target contribution after ads (%)', help: 'Sets target ACoS = break-even ACoS − this.' },
  { key: 'overhead_allocation_pct', label: 'Overhead allocation (% of net sales)', help: '0 = not shown. Used only for the estimated operating contribution.' },
]
const AUTOMATION: NumField[] = [
  { key: 'max_daily_budget', label: 'Max daily budget per campaign (₹)', help: '', optional: true },
  { key: 'max_monthly_budget', label: 'Max monthly budget (₹)', help: '', optional: true },
  { key: 'max_bid', label: 'Max bid (₹)', help: '', optional: true },
  { key: 'max_bid_change_pct', label: 'Max bid change per request (%)', help: '' },
  { key: 'max_budget_change_pct', label: 'Max budget change per request (%)', help: '' },
]

function useSettingsForm(settings: AmazonSettings, fields: NumField[]) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, settings[f.key] === null ? '' : String(settings[f.key])])))
  const collect = (): Partial<AmazonSettings> | string => {
    const out: Record<string, number | null> = {}
    for (const f of fields) {
      const v = values[f.key].trim()
      if (v === '') { if (!f.optional) return `${f.label} is required.`; out[f.key] = null; continue }
      if (!Number.isFinite(Number(v)) || Number(v) < 0) return `${f.label}: enter a non-negative number.`
      out[f.key] = Number(v)
    }
    return out as Partial<AmazonSettings>
  }
  const inputs = (disabled: boolean) => fields.map((f) => (
    <div key={f.key} className="space-y-1"><Label htmlFor={`st-${f.key}`}>{f.label}</Label>
      <Input id={`st-${f.key}`} inputMode="decimal" disabled={disabled} value={values[f.key]} placeholder={f.optional ? 'no limit' : ''} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))} />
      {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}</div>
  ))
  return { collect, inputs }
}

function AnalysisSettings({ settings, canEdit, onSaved }: { settings: AmazonSettings; canEdit: boolean; onSaved: () => void }) {
  const form = useSettingsForm(settings, ANALYSIS)
  const [gst, setGst] = useState(settings.prices_include_gst)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const save = async () => {
    const v = form.collect()
    if (typeof v === 'string') return setMsg({ tone: 'error', text: v })
    setBusy(true); setMsg(null)
    try { await updateSettings({ ...v, prices_include_gst: gst }); setMsg({ tone: 'ok', text: 'Analysis settings saved.' }); onSaved() } catch (e) { setMsg({ tone: 'error', text: describeDataError(e) }) } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader><div><CardTitle>Analysis settings</CardTitle><CardDescription>Thresholds used by every calculation and recommendation rule.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><Checkbox checked={gst} disabled={!canEdit} onCheckedChange={(v) => setGst(v === true)} /> Amazon prices include GST (converted to ex-GST for contribution)</label>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{form.inputs(!canEdit)}</div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {canEdit && <Button disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save analysis settings</Button>}
      </CardContent>
    </Card>
  )
}

function AutomationSettings({ settings, canEdit, onSaved }: { settings: AmazonSettings; canEdit: boolean; onSaved: () => void }) {
  const form = useSettingsForm(settings, AUTOMATION)
  const [mode, setMode] = useState(settings.automation_mode)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const persist = async (changes: Partial<AmazonSettings>, ok: string) => {
    setBusy(true); setMsg(null)
    try { await updateSettings(changes); setMsg({ tone: 'ok', text: ok }); onSaved() } catch (e) { setMsg({ tone: 'error', text: describeDataError(e) }) } finally { setBusy(false) }
  }
  const save = () => {
    const v = form.collect()
    if (typeof v === 'string') return setMsg({ tone: 'error', text: v })
    void persist({ ...v, automation_mode: mode }, 'Automation settings saved.')
  }
  return (
    <Card className={settings.kill_switch ? '' : 'border-amber-300'}>
      <CardHeader><div><CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4" /> Advertising automation and limits</CardTitle>
        <CardDescription>Read-only is the default. Even with approval required, every change needs a second person's approval and explicit execution, within these limits.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge label={settings.kill_switch ? 'Kill switch ON — nothing can be sent to Amazon' : 'Kill switch OFF — approved changes can be executed'} tone={settings.kill_switch ? 'danger' : 'warning'} />
          {canEdit && <Button size="sm" variant={settings.kill_switch ? 'outline' : 'destructive'} disabled={busy}
            onClick={() => void persist({ kill_switch: !settings.kill_switch }, settings.kill_switch ? 'Kill switch turned off.' : 'Kill switch turned on: no changes can be sent.')}>
            {settings.kill_switch ? 'Turn kill switch off' : 'Turn kill switch ON'}</Button>}
        </div>
        <div className="space-y-1"><Label htmlFor="st-mode">Mode</Label>
          <Select value={mode} disabled={!canEdit} onValueChange={(v) => setMode(v as AmazonSettings['automation_mode'])}><SelectTrigger id="st-mode" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="READ_ONLY">Read-only (no changes possible)</SelectItem><SelectItem value="APPROVAL_REQUIRED">Approval required</SelectItem></SelectContent></Select></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{form.inputs(!canEdit)}</div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {canEdit ? <Button disabled={busy} onClick={save}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save automation settings</Button>
          : <p className="text-xs text-muted-foreground">Only users with "Amazon ads: approve changes" can change these settings.</p>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Report import
// ---------------------------------------------------------------------------
function ReportImport() {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedReport | null>(null)
  const [reportDate, setReportDate] = useState('')
  const [rows, setRows] = useState<string[][] | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<(ImportResult & { kind: string })[]>([])
  const [error, setError] = useState<string | null>(null)
  const analyse = (data: string[][], date: string) => {
    const r = parseAmazonReport(data, date || null)
    if ('error' in r) { setParsed(null); setError(r.error) } else { setParsed(r); setError(null) }
  }
  const onFile = async (f: File | null) => {
    setFile(f); setParsed(null); setResults([]); setError(null); setRows(null)
    if (!f) return
    if (f.size > 20 * 1024 * 1024) return setError('The file is larger than 20 MB. Split it by date range.')
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await f.arrayBuffer())
      const data = wb.rows(wb.sheetNames[0] ?? '')
      setRows(data)
      analyse(data, reportDate)
    } catch (e) { setError(describeDataError(e)) }
  }
  const run = async () => {
    if (!parsed || !file) return
    setBusy(true); setError(null); setResults([])
    const out: (ImportResult & { kind: string })[] = []
    try {
      for (const [i, b] of parsed.batches.entries()) {
        for (let start = 0; start < b.rows.length; start += 5000) {
          const key = await stableUuid(`csv:${file.name}:${file.size}:${file.lastModified}:${reportDate}:${b.kind}:${i}:${start}`)
          out.push({ ...(await importRows(b.kind, b.rows.slice(start, start + 5000), file.name, key)), kind: b.kind })
        }
      }
      setResults(out)
    } catch (e) { setResults(out); setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader><div><CardTitle className="flex items-center gap-2"><Upload className="size-4" /> Import Amazon report files</CardTitle>
        <CardDescription>Until the APIs are connected: Business Report (by child item, one day per file), Sponsored Products campaign / advertised product / search term reports (daily), FBA inventory report. Imports are live data marked "CSV"; re-importing the same file is ignored.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="imp-file">File (CSV or Excel)</Label><Input id="imp-file" type="file" accept=".csv,.txt,.xlsx,.xls" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} /></div>
          <div className="space-y-1"><Label htmlFor="imp-date">Report date (Business Report only)</Label>
            <Input id="imp-date" type="date" className="w-40" value={reportDate} onChange={(e) => { setReportDate(e.target.value); if (rows) analyse(rows, e.target.value) }} /></div>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {parsed && <div className="space-y-1 rounded-lg border p-3">
          <p><strong>{parsed.label}</strong> · header row {parsed.headerRow + 1}{parsed.dateFrom ? ` · ${parsed.dateFrom} to ${parsed.dateTo}` : ''}</p>
          <p>{parsed.batches.map((b) => `${b.rows.length} ${b.kind.toLowerCase().replace(/_/g, ' ')} row(s)`).join(' · ') || 'No rows'}</p>
          {parsed.needsDate && !reportDate && <p className="text-amber-800">This report has no date column: choose the report date (the single day it covers).</p>}
          {parsed.errors.length > 0 && <p className="text-amber-800">{parsed.errors.length} row(s) skipped: {parsed.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.message}`).join('; ')}</p>}
          <Button size="sm" disabled={busy || !parsed.batches.length || (parsed.needsDate && !reportDate)} onClick={() => void run()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Import</Button>
        </div>}
        {results.length > 0 && <ul className="space-y-1">{results.map((r, i) => (
          <li key={i}>{r.kind.toLowerCase().replace(/_/g, ' ')}: {r.duplicate ? 'already imported (ignored)' : `${r.received} received, ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped`}
            {r.errors.length > 0 && <span className="text-amber-800"> — {r.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join('; ')}</span>}</li>))}</ul>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
function DemoData() {
  const [days, setDays] = useState('60')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const act = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null)
    try { setMsg({ tone: 'ok', text: await fn() }) } catch (e) { setMsg({ tone: 'error', text: describeDataError(e) }) } finally { setBusy(false); setConfirm(false) }
  }
  return (
    <Card className="border-amber-300">
      <CardHeader><div><CardTitle className="flex items-center gap-2"><FlaskConical className="size-4" /> Demo data</CardTitle>
        <CardDescription>Fictitious products (SKUs starting DEMO-), sales and campaigns to preview the module. Stored separately (marked demo), shown only in "Demo data" mode, never mixed into live figures or ERP records.</CardDescription></div></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3 text-sm">
        <div className="space-y-1"><Label htmlFor="demo-days">Days of history</Label>
          <Select value={days} onValueChange={setDays}><SelectTrigger id="demo-days" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{['30', '60', '90', '120'].map((d) => <SelectItem key={d} value={d}>{d} days</SelectItem>)}</SelectContent></Select></div>
        <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const r = await loadDemo(Number(days)); return `Demo data loaded: ${r.rows} rows over ${r.days} days. Switch the Data selector to "Demo data" to view it.` })}>
          {busy ? <Loader2 className="animate-spin" /> : <FlaskConical />} Load / refresh demo data</Button>
        <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}><Trash2 /> Remove demo data</Button>
        {msg && <div className="basis-full"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      </CardContent>
      {confirm && <Dialog open onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent><DialogHeader><DialogTitle>Remove all demo data?</DialogTitle>
          <DialogDescription>Deletes only rows marked as demo (listings, sales, campaigns, recommendations, plans and change requests). Live and imported data are not touched.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void act(async () => { const r = await clearDemo(); return `${r.deleted} demo row(s) removed.` })}>Remove demo data</Button></DialogFooter>
        </DialogContent>
      </Dialog>}
    </Card>
  )
}
