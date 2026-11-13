import { Copy, Loader2, PlugZap, Power, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

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
import { Field, InfoList } from '@/features/support/support-components'
import { WA_NUMBER_PATHS, WA_SETUP_META } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  checkWaWebhook, fetchWaConfig, replayWaEvent, saveWaConfig, setWaChecklist, setWaEnabled, syncWaTemplates, testWaConnection, type WaConfig, type WaNumberPath, type WaWebhookCheck,
} from '@/services/whatsapp'

const SECRET_ROWS: [keyof WaWebhookCheck['secrets'], string, string][] = [
  ['access_token', 'WHATSAPP_ACCESS_TOKEN', 'Permanent system-user access token (whatsapp_business_messaging, whatsapp_business_management).'],
  ['app_secret', 'WHATSAPP_APP_SECRET', 'Meta app secret: verifies the X-Hub-Signature-256 of every webhook.'],
  ['verify_token', 'WHATSAPP_VERIFY_TOKEN', 'A random value you choose; enter the same value as the verify token in the Meta app webhook settings.'],
  ['cron_secret', 'WHATSAPP_CRON_SECRET', 'Random value the scheduler sends to whatsapp-media-download and whatsapp-sync-status.'],
]
function useWebhookData(refresh: number) {
  const q = useAsync(() => checkWaWebhook().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })), [refresh])
  return q.data && 'secrets' in q.data ? q.data : null
}

/** Support → Settings → WhatsApp: preflight, onboarding checklist, Meta identifiers, secrets status, webhook, test and activation. */
export function WhatsAppSettings() {
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(fetchWaConfig, [refresh])
  const hook = useWebhookData(refresh)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [replace, setReplace] = useState<string | null>(null)
  const [off, setOff] = useState(false)
  const reload = () => setRefresh((n) => n + 1)
  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name); setNotice(null)
    try { setNotice({ ok: true, text: await fn() }); reload() } catch (e) { setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) }) } finally { setBusy(null) }
  }
  if (q.loading && !q.data) return <LoadingState rows={6} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  const d = q.data
  const c = d.config
  const st = WA_SETUP_META[c?.setup_state ?? 'NOT_CONFIGURED']
  const copy = (v: string) => void navigator.clipboard?.writeText(v)
  return (
    <div className="space-y-4" data-testid="wa-settings">
      {notice && <p role={notice.ok ? 'status' : 'alert'} data-testid="wa-settings-notice" className={notice.ok ? 'rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800'
        : 'rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800'}>{notice.text}</p>}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div><CardTitle>WhatsApp: Meta Cloud API</CardTitle>
            <CardDescription>Direct Meta WhatsApp Business Platform integration (no Zoho Bigin, no WhatsApp Web). The live number is never changed from here.</CardDescription></div>
          <div className="flex flex-wrap items-center gap-2">
            <span title={st.hint} data-testid="wa-setup" data-state={c?.setup_state ?? 'NOT_CONFIGURED'}><StatusBadge label={st.label} tone={st.tone} /></span>
            <StatusBadge label={c?.integration_enabled ? 'Switched on' : 'Switched off'} tone={c?.integration_enabled ? 'success' : 'neutral'} />
            {c && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('test', async () => (await testWaConnection()).results.map((r) => r.test?.message ?? r.message).join(' '))}>
              {busy === 'test' ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>}
            {c && !c.integration_enabled && <Button size="sm" disabled={busy !== null || c.setup_state !== 'CONNECTED'} data-testid="wa-enable"
              title={c.setup_state !== 'CONNECTED' ? 'Available when the setup state is Connected.' : undefined}
              onClick={() => void run('on', async () => { await setWaEnabled(true, null); return 'WhatsApp switched on.' })}><Power /> Switch on</Button>}
            {c?.integration_enabled && <Button size="sm" variant="outline" className="text-red-700" onClick={() => setOff(true)}><Power /> Switch off</Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="wa-state-hint">{st.hint}{c?.last_test_result ? ` Last test: ${c.last_test_result}` : ''}</p>
          {c && <InfoList items={[
            ['Connection status', d.account?.status_detail ?? '—'],
            ['Last inbound message', c.last_inbound_at ? formatDateTime(c.last_inbound_at) : 'None'],
            ['Last successful outbound message', c.last_outbound_success_at ? formatDateTime(c.last_outbound_success_at) : 'None'],
            ['Last webhook event', c.last_webhook_at ? formatDateTime(c.last_webhook_at) : 'None'],
            ['Webhook verification', c.webhook_verified_at ? `challenge passed ${formatDateTime(c.webhook_verified_at)}` : 'Not verified'],
            ['Signed webhook received', c.webhook_signed_event_at ? formatDateTime(c.webhook_signed_event_at) : 'Not yet'],
            ['Last connection test', c.last_test_at ? `${formatDateTime(c.last_test_at)} — ${c.last_test_ok ? 'passed' : 'failed'}` : 'Never'],
            ['Messages', `${d.counts.received} received · ${d.counts.sent} sent · ${d.counts.pending} pending · ${d.counts.failed} failed · ${d.counts.media_pending} media to download`],
          ]} />}
          <ConfigForm cfg={c} onSaved={(t) => { setNotice({ ok: true, text: t }); reload() }} />
        </CardContent>
      </Card>

      {c && (
        <Card>
          <CardHeader><div><CardTitle>Onboarding checklist</CardTitle>
            <CardDescription>Confirmations are recorded with who and when. The integration stays off until the required items, the connection test and the webhook verification are complete.</CardDescription></div></CardHeader>
          <CardContent><ul className="space-y-2" data-testid="wa-checklist">{d.checklist_items.map((i) => <ChecklistRow key={i.key} item={i} onChanged={(t) => { setNotice(t); reload() }} />)}</ul></CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><div><CardTitle>Secrets and webhook</CardTitle><CardDescription>Edge Function secrets (npx supabase secrets set NAME=value). Only whether each is set is shown — never a value.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-2">{SECRET_ROWS.map(([k, name, help]) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" data-testid={`wa-secret-${k}`}>
              <div className="min-w-0"><p className="font-mono text-xs font-medium">{name}</p><p className="text-xs text-muted-foreground">{help}</p></div>
              <div className="flex items-center gap-2">{hook ? <StatusBadge label={hook.secrets[k] ? 'Configured' : 'Not set'} tone={hook.secrets[k] ? 'success' : 'warning'} /> : <StatusBadge label="Unknown" tone="neutral" />}
                <Button size="sm" variant="outline" onClick={() => setReplace(name)}>Replace secret</Button></div>
            </li>
          ))}</ul>
          {hook && (
            <div className="space-y-2 text-sm" data-testid="wa-webhook">
              <div className="rounded-md border px-3 py-2"><p className="font-medium">Webhook callback URL (Meta app → WhatsApp → Configuration)</p>
                <div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs" title={hook.callback_url}>{hook.callback_url}</code>
                  <Button size="sm" variant="ghost" aria-label="Copy callback URL" onClick={() => copy(hook.callback_url)}><Copy className="size-3.5" /></Button></div>
                <p className="mt-1 text-xs text-muted-foreground">Verify token: the value of WHATSAPP_VERIFY_TOKEN. Subscribe the "messages" field.</p></div>
              <p className="flex items-center gap-2 text-xs"><ShieldCheck className="size-4" />{hook.subscription.message}</p>
            </div>
          )}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('hook', async () => { reload(); return 'Webhook check refreshed.' })}>Check webhook subscription</Button>
        </CardContent>
      </Card>

      {c && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div><CardTitle>Message templates</CardTitle><CardDescription>From WhatsApp Manager. Only APPROVED templates can be sent by agents.{c.templates_synced_at ? ` Synchronised ${formatDateTime(c.templates_synced_at)}.` : ''}</CardDescription></div>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('tpl', async () => (await syncWaTemplates()).results.map((r) => r.templates?.message ?? r.message).join(' '))}>
              {busy === 'tpl' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Synchronise templates</Button>
          </CardHeader>
          <CardContent>{!d.templates.length ? <p className="text-sm text-muted-foreground">No templates yet.</p> : (
            <ul className="divide-y text-sm" data-testid="wa-templates">{d.templates.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 py-1.5"><span>{t.name} · {t.language}{t.category ? ` · ${t.category.toLowerCase()}` : ''}</span>
                <StatusBadge label={t.status.toLowerCase()} tone={t.status === 'APPROVED' ? 'success' : t.status === 'REJECTED' || t.status === 'REMOVED' ? 'danger' : 'warning'} /></li>
            ))}</ul>)}</CardContent>
        </Card>
      )}

      {c && (
        <Card>
          <CardHeader><div><CardTitle>Webhook events</CardTitle><CardDescription>The latest 50 (message content is not shown). Held events (received before go-live) and failed events can be replayed once WhatsApp is switched on.</CardDescription></div></CardHeader>
          <CardContent>{!d.events.length ? <p className="text-sm text-muted-foreground">No webhook events yet.</p> : (
            <Table data-testid="wa-events"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Received</TableHead><TableHead>Field</TableHead><TableHead>Result</TableHead><TableHead>Counts</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{d.events.map((e) => (
                <TableRow key={e.id}><TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.received_at)}</TableCell><TableCell className="text-xs">{e.field}</TableCell>
                  <TableCell className="text-xs">{e.result.toLowerCase()}{e.error ? ` — ${e.error}` : ''}{e.replay_count ? ` · replayed ${e.replay_count}×` : ''}</TableCell>
                  <TableCell className="text-xs">{Object.entries(e.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || '—'}</TableCell>
                  <TableCell>{(e.result === 'HELD' || e.result === 'ERROR') && e.field === 'messages' && !e.purged && c.integration_enabled &&
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('replay', async () => `Replayed: ${(await replayWaEvent(e.id)).result.toLowerCase()}.`)}><RotateCcw /> Replay</Button>}</TableCell>
                </TableRow>
              ))}</TableBody></Table>)}</CardContent>
        </Card>
      )}

      {replace && (
        <Dialog open onOpenChange={(o) => { if (!o) setReplace(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Replace {replace}</DialogTitle><DialogDescription>Secrets are set on the server, never in this page.</DialogDescription></DialogHeader>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Create the new value in Meta Business Suite / the Meta app (or a new random value for the verify token).</li>
              <li>Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">npx supabase secrets set {replace}=&lt;new value&gt;</code> (or Supabase dashboard → Edge Functions → Secrets).</li>
              {replace === 'WHATSAPP_VERIFY_TOKEN' && <li>Enter the same value as the verify token in the Meta app webhook configuration and verify again.</li>}
              <li>Run Test connection here.</li>
            </ol>
            <DialogFooter><Button onClick={() => { setReplace(null); reload() }}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {off && <SwitchOffDialog onClose={() => setOff(false)} onDone={() => { setOff(false); setNotice({ ok: true, text: 'WhatsApp switched off. Webhook events are stored and held.' }); reload() }} />}
    </div>
  )
}

function ChecklistRow({ item, onChanged }: { item: WaConfig['checklist_items'][number]; onChanged: (n: { ok: boolean; text: string }) => void }) {
  const [note, setNote] = useState(item.note ?? '')
  const [busy, setBusy] = useState(false)
  const toggle = async (done: boolean) => {
    setBusy(true)
    try { await setWaChecklist(item.key, done, note.trim() || null); onChanged({ ok: true, text: done ? 'Confirmed.' : 'Confirmation removed.' }) }
    catch (e) { onChanged({ ok: false, text: describeDataError(e) }) } finally { setBusy(false) }
  }
  return (
    <li className="rounded-md border px-3 py-2 text-sm" data-testid={`wa-check-${item.key}`}>
      <label className="flex items-start gap-2"><Checkbox checked={item.done} disabled={busy} onCheckedChange={(x) => void toggle(x === true)} />
        <span>{item.label} {item.required ? <span className="text-xs text-red-700">required</span> : <span className="text-xs text-muted-foreground">recommended</span>}
          {item.done && item.at && <span className="block text-xs text-muted-foreground">Confirmed by {item.by ?? 'an administrator'} on {formatDateTime(item.at)}{item.note ? ` — ${item.note}` : ''}</span>}</span></label>
      {!item.done && <Input aria-label={`Evidence for ${item.key}`} className="mt-2 h-8" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Evidence (Meta case / partner reference, date)" maxLength={500} />}
    </li>
  )
}

function ConfigForm({ cfg, onSaved }: { cfg: WaConfig['config']; onSaved: (text: string) => void }) {
  const [v, setV] = useState(() => ({ portfolio: cfg?.business_portfolio_id ?? '', waba: cfg?.waba_id ?? '', phone: cfg?.phone_number_id ?? '', display: cfg?.display_phone_number ?? '',
    app: cfg?.app_id ?? '', version: cfg?.graph_api_version ?? '', path: (cfg?.number_path ?? 'UNKNOWN') as WaNumberPath }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const save = async () => {
    for (const [k, label] of [['portfolio', 'Business Portfolio ID'], ['waba', 'WhatsApp Business Account ID'], ['phone', 'Phone Number ID'], ['app', 'App ID']] as const) {
      if (v[k].trim() && !/^[0-9]{5,25}$/.test(v[k].trim())) { setError(`${label} is a numeric id from Meta.`); return }
    }
    if (v.version.trim() && !/^v[0-9]{1,3}\.[0-9]$/.test(v.version.trim())) { setError('Graph API version looks like v27.0 (see Meta’s Graph API changelog).'); return }
    setBusy(true); setError(null)
    try {
      await saveWaConfig({ business_portfolio_id: v.portfolio.trim() || null, waba_id: v.waba.trim() || null, phone_number_id: v.phone.trim() || null,
        display_phone_number: v.display.trim() || null, app_id: v.app.trim() || null, graph_api_version: v.version.trim() || null, number_path: v.path })
      onSaved('WhatsApp settings saved.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <form className="grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate data-testid="wa-config-form">
      <Field label="How is the support number used today? (preflight)" htmlFor="wa-path" hint="Changing this resets the test and webhook evidence. Nothing is changed at Meta or Zoho.">
        <Select value={v.path} onValueChange={(x) => setV((s) => ({ ...s, path: x as WaNumberPath }))}><SelectTrigger id="wa-path"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(WA_NUMBER_PATHS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select>
      </Field>
      <Field label="Display phone number" htmlFor="wa-display"><Input id="wa-display" value={v.display} onChange={set('display')} placeholder="+91 1800 …" inputMode="tel" /></Field>
      <Field label="Meta Business Portfolio ID" htmlFor="wa-portfolio"><Input id="wa-portfolio" value={v.portfolio} onChange={set('portfolio')} inputMode="numeric" /></Field>
      <Field label="WhatsApp Business Account ID" htmlFor="wa-waba"><Input id="wa-waba" value={v.waba} onChange={set('waba')} inputMode="numeric" /></Field>
      <Field label="Phone Number ID" htmlFor="wa-phone"><Input id="wa-phone" value={v.phone} onChange={set('phone')} inputMode="numeric" /></Field>
      <Field label="App ID" htmlFor="wa-app"><Input id="wa-app" value={v.app} onChange={set('app')} inputMode="numeric" /></Field>
      <Field label="Graph API version" htmlFor="wa-version" hint="A supported version from Meta’s Graph API changelog (e.g. v27.0). Not defaulted."><Input id="wa-version" value={v.version} onChange={set('version')} placeholder="v27.0" /></Field>
      {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
      <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save settings</Button></div>
    </form>
  )
}

function SwitchOffDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Switch WhatsApp off?</DialogTitle><DialogDescription>Agents can no longer send. Incoming webhook events are stored and held. Nothing changes at Meta.</DialogDescription></DialogHeader>
        <Field label="Reason" htmlFor="wa-off-reason"><Textarea id="wa-off-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => {
            setBusy(true); setError(null)
            setWaEnabled(false, reason.trim() || null).then(onDone, (e) => setError(describeDataError(e))).finally(() => setBusy(false))
          }}>{busy && <Loader2 className="animate-spin" />}Switch off</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
