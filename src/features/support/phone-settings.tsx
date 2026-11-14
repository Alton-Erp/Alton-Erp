import { Copy, Loader2, PlugZap, Plus, RefreshCw, RotateCcw, Unplug } from 'lucide-react'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Field, InfoList, IntegrationBadge } from '@/features/support/support-components'
import { PHONE_WEBHOOK_EVENTS, PRESENCE_META, phoneWebhookUrl as webhookUrl, type Presence } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  disconnectPhone, fetchPhoneConfig, fetchPhoneSecretStatus, replayPhoneEvent, savePhoneConfig, savePhoneLine, syncCallRecords, syncRecordings, testPhoneConnection,
  type PhoneConfig, type PhoneConfigSave,
} from '@/services/phone'
import { fetchAgents } from '@/services/support'

const SECRET_HELP: Record<string, string> = {
  api_token: 'Acefone API token (Authorization: Bearer). Used for Click-to-Call, call records and the connection test.',
  support_api_key: 'Click-to-Call Support API key (API Connect → Click to Call Support API). A different credential, sent in the request body; needed only in Support mode.',
  webhook_secret: 'A long random value you choose (e.g. openssl rand -hex 32). The same value goes into every webhook URL in Acefone.',
}

export function PhoneSettings() {
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(fetchPhoneConfig, [refresh])
  const secrets = useAsync(() => fetchPhoneSecretStatus().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })), [refresh])
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [replace, setReplace] = useState<string | null>(null)
  const [disconnect, setDisconnect] = useState(false)
  const [lineOpen, setLineOpen] = useState<PhoneConfig['lines'][number] | 'new' | null>(null)
  const reload = () => setRefresh((n) => n + 1)
  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name); setNotice(null)
    try { setNotice({ ok: true, text: await fn() }); reload() } catch (e) { setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) }) } finally { setBusy(null) }
  }
  if (q.loading && !q.data) return <LoadingState rows={6} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  const d = q.data
  const cfg = d.config
  const sec = secrets.data && 'secrets' in secrets.data ? secrets.data.secrets : null
  const secretRow = (key: 'api_token' | 'support_api_key' | 'webhook_secret', name: string | undefined) => (
    <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" data-testid={`secret-${key}`}>
      <div className="min-w-0"><p className="font-medium">{key === 'api_token' ? 'API token' : key === 'support_api_key' ? 'Click-to-Call Support API key' : 'Webhook verification secret'}
        <span className="ml-2 font-mono text-xs text-muted-foreground">{name}</span></p><p className="text-xs text-muted-foreground">{SECRET_HELP[key]}</p></div>
      <div className="flex items-center gap-2">
        {sec ? <StatusBadge label={sec[key] ? 'Configured' : 'Not set'} tone={sec[key] ? 'success' : 'warning'} /> : <StatusBadge label="Unknown" tone="neutral" />}
        <Button size="sm" variant="outline" onClick={() => setReplace(name ?? '')}>Replace secret</Button>
      </div>
    </div>
  )
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? 'https://<project>.supabase.co')
  return (
    <div className="space-y-4" data-testid="phone-settings">
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={notice.ok ? 'rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800'
        : 'rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800'} data-testid="phone-notice">{notice.text}</p>}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div><CardTitle>Phone: Acefone / Servetel</CardTitle>
            <CardDescription>Toll-free calls and Click-to-Call. Calls are placed and received through server-side functions; credentials never reach the browser.</CardDescription></div>
          <div className="flex flex-wrap items-center gap-2">
            <IntegrationBadge status={d.account?.status} testId="phone-status" />
            {cfg && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('test', async () => (await testPhoneConnection()).message)}>
              {busy === 'test' ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>}
            {cfg?.is_enabled && <Button size="sm" variant="outline" className="text-red-700" onClick={() => setDisconnect(true)}><Unplug /> Disconnect</Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {cfg && !cfg.is_enabled && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Disconnected {formatDateTime(cfg.disconnected_at!)}: calls cannot be placed and webhooks are logged but not processed. Save the settings to reconnect.</p>}
          {cfg && <InfoList items={[
            ['Last successful event', d.last_success_event_at ? formatDateTime(d.last_success_event_at) : 'None yet'],
            ['Last call-record sync', cfg.last_sync_at ? `${formatDateTime(cfg.last_sync_at)}${cfg.last_sync_status ? ` — ${cfg.last_sync_status}` : ''}` : cfg.last_sync_status ?? 'Never'],
            ['Last connection test', cfg.last_test_at ? `${formatDateTime(cfg.last_test_at)} — ${cfg.last_test_result ?? ''}` : 'Never'],
            ['Status detail', d.account?.status_detail ?? '—'],
          ]} />}
          <ConfigForm cfg={cfg} onSaved={(text) => { setNotice({ ok: true, text }); reload() }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Secrets</CardTitle><CardDescription>Stored only as Supabase Edge Function secrets. This page shows whether each is set — never its value.</CardDescription></div></CardHeader>
        <CardContent className="space-y-2">
          {secrets.data && 'error' in secrets.data && <p className="text-sm text-amber-800">Secret status unavailable: {secrets.data.error}</p>}
          {secretRow('api_token', cfg?.api_token_secret ?? 'ACEFONE_API_TOKEN')}
          {secretRow('support_api_key', cfg?.support_api_key_secret ?? 'ACEFONE_C2C_SUPPORT_API_KEY')}
          {secretRow('webhook_secret', cfg?.webhook_secret_name ?? 'ACEFONE_WEBHOOK_SECRET')}
        </CardContent>
      </Card>

      {cfg && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div><CardTitle>Agent mapping</CardTitle><CardDescription>Which Acefone agent number, Agent ID (050…) or extension (060…) each support agent calls from.</CardDescription></div>
            <Button size="sm" onClick={() => setLineOpen('new')}><Plus /> Add line</Button>
          </CardHeader>
          <CardContent>{d.lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines mapped: agents cannot place calls yet.</p> : (
            <Table data-testid="phone-lines"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Agent</TableHead><TableHead>Acefone number</TableHead><TableHead>Label</TableHead>
              <TableHead>Presence</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{d.lines.map((l) => (
                <TableRow key={l.id}><TableCell className="font-medium">{l.agent_name}</TableCell><TableCell className="font-mono text-xs">{l.agent_number}</TableCell><TableCell>{l.label ?? '—'}</TableCell>
                  <TableCell>{PRESENCE_META[l.presence as Presence]?.label ?? l.presence}</TableCell>
                  <TableCell><StatusBadge label={l.is_active && l.agent_active ? 'Active' : 'Inactive'} tone={l.is_active && l.agent_active ? 'success' : 'neutral'} /></TableCell>
                  <TableCell><Button size="sm" variant="ghost" onClick={() => setLineOpen(l)}>Edit</Button></TableCell></TableRow>
              ))}</TableBody></Table>)}</CardContent>
        </Card>
      )}

      {cfg && (
        <Card>
          <CardHeader><div><CardTitle>Webhooks</CardTitle>
            <CardDescription>In Acefone: API Connect → Webhook → Add Webhook, one per trigger, method POST, content type JSON, with the URL below. Replace &lt;ACEFONE_WEBHOOK_SECRET&gt; with the secret’s value. Ask Acefone support to enable webhooks if the menu is missing.</CardDescription></div></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm" data-testid="webhook-urls">{PHONE_WEBHOOK_EVENTS.map(([e, label]) => {
              const u = webhookUrl(supabaseUrl, cfg.channel_account_id, e)
              return (
                <li key={e} className="rounded-md border px-3 py-2"><p className="font-medium">{label}</p>
                  <div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs" title={u}>{u}</code>
                    <Button size="sm" variant="ghost" aria-label={`Copy ${label} URL`} onClick={() => void navigator.clipboard?.writeText(u)}><Copy className="size-3.5" /></Button></div></li>
              )
            })}</ul>
          </CardContent>
        </Card>
      )}

      {cfg && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div><CardTitle>Events and sync</CardTitle><CardDescription>The latest 50 provider events. Failed or rejected events can be replayed; replaying never repeats a status change.</CardDescription></div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('sync', async () => (await syncCallRecords()).results.map((r) => r.message).join(' ') || 'Synced.')}>
                {busy === 'sync' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync call records</Button>
              {cfg.recording_retrieval && <Button size="sm" variant="outline" disabled={busy !== null}
                onClick={() => void run('rec', async () => (await syncRecordings()).results.map((r) => r.skipped ?? `${r.stored ?? 0} stored, ${r.purged ?? 0} deleted`).join(' '))}>
                {busy === 'rec' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync recordings</Button>}
            </div>
          </CardHeader>
          <CardContent>{!d.events?.length ? <p className="text-sm text-muted-foreground">No events yet.</p> : (
            <Table data-testid="phone-events"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Received</TableHead><TableHead>Type</TableHead><TableHead>Event</TableHead>
              <TableHead>Result</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{d.events.map((e) => (
                <TableRow key={e.id}><TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell><TableCell className="text-xs">{e.event_type.toLowerCase().replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-xs">{e.event ?? e.message ?? '—'}</TableCell>
                  <TableCell className="text-xs">{e.processing_result ?? '—'}{e.processing_error ? ` — ${e.processing_error}` : ''}{e.replay_count ? ` · replayed ${e.replay_count}×` : ''}</TableCell>
                  <TableCell>{(e.event_type === 'WEBHOOK' || e.event_type === 'REJECTED') && ['ERROR', 'REJECTED', 'IGNORED'].includes(e.processing_result ?? '') &&
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('replay', async () => `Replayed: ${(await replayPhoneEvent(e.id)).result.toLowerCase()}.`)}><RotateCcw /> Replay</Button>}</TableCell></TableRow>
              ))}</TableBody></Table>)}</CardContent>
        </Card>
      )}

      {replace !== null && (
        <Dialog open onOpenChange={(o) => { if (!o) setReplace(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Replace {replace}</DialogTitle>
              <DialogDescription>Secrets are set on the server, never through this page, so no value is ever sent to or stored by the browser.</DialogDescription></DialogHeader>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Generate or copy the new value from Acefone (or, for the webhook secret, create a new random value).</li>
              <li>Run: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">npx supabase secrets set {replace}=&lt;new value&gt;</code> (or Supabase dashboard → Edge Functions → Secrets).</li>
              {replace.includes('WEBHOOK') && <li>Update every webhook URL in Acefone with the new value.</li>}
              <li>Come back here and use Test connection.</li>
            </ol>
            <DialogFooter><Button onClick={() => { setReplace(null); reload() }}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog open={disconnect} onOpenChange={setDisconnect} title="Disconnect Acefone?"
        description="Calls can no longer be placed from the ERP and incoming webhooks are logged but not processed. Secrets stay on the server until you remove them (npx supabase secrets unset …)."
        confirmLabel="Disconnect" onConfirm={() => void run('disconnect', async () => { await disconnectPhone('Disconnected in Support Settings'); return 'Disconnected.' })} />
      {lineOpen && <LineDialog line={lineOpen} onClose={() => setLineOpen(null)} onSaved={() => { setLineOpen(null); reload() }} />}
    </div>
  )
}

function ConfigForm({ cfg, onSaved }: { cfg: PhoneConfig['config']; onSaved: (text: string) => void }) {
  const [v, setV] = useState(() => ({ toll_free_number: cfg?.toll_free_number ?? '', api_base_url: cfg?.api_base_url ?? 'https://api.acefone.in', click_to_call_mode: cfg?.click_to_call_mode ?? 'AGENT',
    default_caller_id: cfg?.default_caller_id ?? '', ips: (cfg?.webhook_allowed_ips ?? []).join('\n'), recording_retrieval: cfg?.recording_retrieval ?? false,
    retention: String(cfg?.recording_retention_days ?? 90) }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (v.toll_free_number.replace(/\D/g, '').length < 8) { setError('Enter the toll-free number.'); return }
    if (v.default_caller_id && !/^\d{6,15}$/.test(v.default_caller_id.replace(/\D/g, ''))) { setError('The caller ID is 6 to 15 digits.'); return }
    if (!/^\d{1,4}$/.test(v.retention) || Number(v.retention) < 1) { setError('Retention is a number of days.'); return }
    setBusy(true); setError(null)
    try {
      const p: PhoneConfigSave = { toll_free_number: v.toll_free_number.trim(), api_base_url: v.api_base_url, click_to_call_mode: v.click_to_call_mode as 'AGENT' | 'SUPPORT',
        default_caller_id: v.default_caller_id.replace(/\D/g, '') || null, webhook_allowed_ips: v.ips.split(/[\s,]+/).filter(Boolean), recording_retrieval: v.recording_retrieval,
        recording_retention_days: Number(v.retention) }
      await savePhoneConfig(p)
      onSaved('Phone settings saved. Test the connection to confirm it works.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <form className="grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate data-testid="phone-config-form">
      <Field label="Provider" htmlFor="ph-provider"><Input id="ph-provider" value="Acefone / Servetel" disabled /></Field>
      <Field label="Toll-free number" htmlFor="ph-toll"><Input id="ph-toll" value={v.toll_free_number} onChange={(e) => setV((x) => ({ ...x, toll_free_number: e.target.value }))} inputMode="tel" /></Field>
      <Field label="API base URL" htmlFor="ph-base" hint="The documentation shows both hosts; confirm yours with Acefone.">
        <Select value={v.api_base_url} onValueChange={(x) => setV((s) => ({ ...s, api_base_url: x }))}><SelectTrigger id="ph-base"><SelectValue /></SelectTrigger>
          <SelectContent>
  <SelectItem value="https://api.acefone.in">https://api.acefone.in</SelectItem>
  <SelectItem value="https://api.servetel.in">https://api.servetel.in</SelectItem>
  <SelectItem value="https://api-acefone.com">https://api-acefone.com</SelectItem>
</SelectContent></Select>
      </Field>
      <Field label="Click-to-Call mode" htmlFor="ph-mode" hint={v.click_to_call_mode === 'AGENT' ? 'Rings the agent first, then the customer (API token).' : 'Rings the customer first, then the destination tied to the Support API key.'}>
        <Select value={v.click_to_call_mode} onValueChange={(x) => setV((s) => ({ ...s, click_to_call_mode: x as 'AGENT' | 'SUPPORT' }))}><SelectTrigger id="ph-mode"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="AGENT">Click to Call (agent first)</SelectItem><SelectItem value="SUPPORT">Click to Call Support (customer first)</SelectItem></SelectContent></Select>
      </Field>
      <Field label="Caller ID (DID) for outgoing calls" htmlFor="ph-caller" hint="Optional; Acefone uses the account’s default pilot number when empty."><Input id="ph-caller" value={v.default_caller_id}
        onChange={(e) => setV((x) => ({ ...x, default_caller_id: e.target.value }))} inputMode="numeric" /></Field>
      <Field label="Webhook source IPs (optional)" htmlFor="ph-ips" hint="IPv4 addresses or ranges, one per line. Ask Acefone for its webhook addresses; empty = token check only.">
        <Textarea id="ph-ips" value={v.ips} onChange={(e) => setV((x) => ({ ...x, ips: e.target.value }))} rows={2} /></Field>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.recording_retrieval} onCheckedChange={(x) => setV((s) => ({ ...s, recording_retrieval: x === true }))} />
        Copy call recordings into the ERP (only after Acefone confirms recordings may be downloaded)</label>
      <Field label="Keep recordings for (days)" htmlFor="ph-ret"><Input id="ph-ret" value={v.retention} onChange={(e) => setV((x) => ({ ...x, retention: e.target.value }))} inputMode="numeric" /></Field>
      {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
      <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{cfg ? 'Save settings' : 'Set up phone'}</Button></div>
    </form>
  )
}

function LineDialog({ line, onClose, onSaved }: { line: PhoneConfig['lines'][number] | 'new'; onClose: () => void; onSaved: () => void }) {
  const existing = line === 'new' ? null : line
  const agents = useAsync(fetchAgents, [])
  const [v, setV] = useState(() => ({ agent_id: existing?.agent_id ?? '', agent_number: existing?.agent_number ?? '', label: existing?.label ?? '', is_active: existing?.is_active ?? true }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!v.agent_id) { setError('Choose the agent.'); return }
    if (!/^\d{6,15}$/.test(v.agent_number.replace(/\D/g, ''))) { setError('Enter the Acefone agent number, Agent ID or extension (digits).'); return }
    setBusy(true); setError(null)
    try { await savePhoneLine(existing?.id ?? null, { agent_id: v.agent_id, agent_number: v.agent_number.replace(/\D/g, ''), label: v.label.trim() || null, is_active: v.is_active }); onSaved() }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{existing ? 'Edit line' : 'Add line'}</DialogTitle><DialogDescription>The number Acefone rings for this agent on Click-to-Call.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <Field label="Agent" htmlFor="ln-agent">
            <Select value={v.agent_id || undefined} onValueChange={(x) => setV((s) => ({ ...s, agent_id: x }))}><SelectTrigger id="ln-agent"><SelectValue placeholder="Choose an agent" /></SelectTrigger>
              <SelectContent>{(agents.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>)}</SelectContent></Select>
          </Field>
          <Field label="Acefone agent number / Agent ID / extension" htmlFor="ln-number"><Input id="ln-number" value={v.agent_number} onChange={(e) => setV((s) => ({ ...s, agent_number: e.target.value }))} inputMode="numeric" /></Field>
          <Field label="Label" htmlFor="ln-label"><Input id="ln-label" value={v.label} onChange={(e) => setV((s) => ({ ...s, label: e.target.value }))} maxLength={80} /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s) => ({ ...s, is_active: x === true }))} />Active</label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save line</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
