import { Copy, Loader2, Mail, PlugZap, Plus, RefreshCw, RotateCcw, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Field, InfoList, IntegrationBadge } from '@/features/support/support-components'
import { GMAIL_CONNECT_REASONS, isEmail } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  disconnectGoogle, fetchEmailConfig, fetchEmailTemplates, fetchGoogleStatus, renewGmailWatch, replayGmailEvent, saveEmailConfig, saveEmailTemplate, startGoogleConnect,
  syncMailboxNow, testGoogleConnection, type EmailConfig, type EmailTemplate, type GoogleStatus,
} from '@/services/email'

const SECRET_ROWS: [keyof GoogleStatus['secrets'], string, string][] = [
  ['client_id', 'GOOGLE_OAUTH_CLIENT_ID', 'OAuth client ID (Google Cloud → APIs & Services → Credentials, type "Web application").'],
  ['client_secret', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAuth client secret of the same client.'],
  ['redirect_uri', 'GOOGLE_OAUTH_REDIRECT_URI', 'Must be exactly the redirect URI shown below, also registered on the OAuth client.'],
  ['encryption_key', 'GOOGLE_TOKEN_ENCRYPTION_KEY', '32 random bytes, base64 (openssl rand -base64 32). Encrypts the stored refresh token.'],
  ['app_url', 'GOOGLE_APP_URL', 'https address of this ERP; the browser returns here after authorising.'],
  ['push_token', 'GMAIL_PUSH_TOKEN', 'Random value placed in the Pub/Sub push endpoint URL (needed for push notifications).'],
  ['push_oidc', 'GMAIL_PUSH_AUDIENCE', 'Optional: audience of the Pub/Sub authenticated push token (with GMAIL_PUSH_SERVICE_ACCOUNT).'],
  ['cron_secret', 'GOOGLE_CRON_SECRET', 'Random value the scheduler sends as x-cron-secret to google-gmail-sync and google-gmail-watch-renew.'],
]

/** Support → Settings → Email: Google Workspace (Gmail API) connection for the shared support mailbox. */
export function EmailSettings({ canEditTemplates }: { canEditTemplates: boolean }) {
  const [params, setParams] = useSearchParams()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(() => {
    const r = params.get('gmail')
    if (r === 'connected') return { ok: true, text: 'Google Workspace connected. The first sync reads the recent mail.' }
    if (r === 'error') return { ok: false, text: `Not connected: ${GMAIL_CONNECT_REASONS[params.get('reason') ?? ''] ?? 'the authorisation did not complete.'}` }
    return null
  })
  // Remove ?gmail=…&reason=… once read (the notice keeps the message).
  useEffect(() => {
    if (!params.has('gmail')) return
    const next = new URLSearchParams(params)
    next.delete('gmail'); next.delete('reason')
    setParams(next, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(fetchEmailConfig, [refresh])
  const server = useAsync(() => fetchGoogleStatus().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })), [refresh])
  const [busy, setBusy] = useState<string | null>(null)
  const [disconnect, setDisconnect] = useState(false)
  const reload = () => setRefresh((n) => n + 1)
  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name); setNotice(null)
    try { setNotice({ ok: true, text: await fn() }); reload() } catch (e) { setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) }) } finally { setBusy(null) }
  }
  const connect = async () => {
    setBusy('connect'); setNotice(null)
    try { window.location.assign((await startGoogleConnect()).url) } catch (e) { setNotice({ ok: false, text: e instanceof Error ? e.message : describeDataError(e) }); setBusy(null) }
  }
  if (q.loading && !q.data) return <LoadingState rows={6} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  const d = q.data
  const cfg = d.config
  const status = d.account?.status ?? 'NOT_CONNECTED'
  const srv = server.data && 'secrets' in server.data ? server.data : null
  const copy = (text: string) => void navigator.clipboard?.writeText(text)
  return (
    <div className="space-y-4" data-testid="email-settings">
      {notice && <p role={notice.ok ? 'status' : 'alert'} data-testid="email-notice" className={notice.ok ? 'rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800'
        : 'rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800'}>{notice.text}</p>}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div><CardTitle className="flex items-center gap-2"><Mail className="size-4" />Email: Google Workspace (Gmail)</CardTitle>
            <CardDescription>The shared support mailbox is read and sent through the Gmail API with OAuth. No mailbox password is ever asked for or stored; tokens never reach the browser.</CardDescription></div>
          <div className="flex flex-wrap items-center gap-2">
            <IntegrationBadge status={status} testId="email-status" />
            {cfg && <Button size="sm" onClick={() => void connect()} disabled={busy !== null} data-testid="connect-google">
              {busy === 'connect' ? <Loader2 className="animate-spin" /> : <PlugZap />}{cfg.is_enabled ? (status === 'REAUTHORIZATION_REQUIRED' ? 'Reconnect Google Workspace' : 'Reauthorise') : 'Connect Google Workspace'}</Button>}
            {cfg?.is_enabled && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('test', async () => (await testGoogleConnection()).message)}>
              {busy === 'test' && <Loader2 className="animate-spin" />}Test connection</Button>}
            {(cfg?.is_enabled || d.has_credentials) && <Button size="sm" variant="outline" className="text-red-700" onClick={() => setDisconnect(true)}><Unplug /> Disconnect</Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'REAUTHORIZATION_REQUIRED' && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="email-reauth">
            {d.account?.status_detail ?? 'Google no longer accepts the stored authorisation.'} Use Reconnect Google Workspace and sign in as {cfg?.mailbox_address}.</p>}
          {cfg && <InfoList items={[
            ['Mailbox', cfg.connected_address ? `${cfg.connected_address} (connected ${cfg.connected_at ? formatDateTime(cfg.connected_at) : ''})` : `${cfg.mailbox_address} — not connected`],
            ['Health', d.account?.status_detail ?? '—'],
            ['Permissions granted', cfg.granted_scopes.length ? cfg.granted_scopes.map((s) => s.split('/').pop()).join(', ') : '—'],
            ['Permissions requested', d.requested_scopes.map((s) => s.split('/').pop()).join(', ')],
            ['Last sync', cfg.last_sync_at ? `${formatDateTime(cfg.last_sync_at)} — ${cfg.last_sync_status ?? ''}` : cfg.last_sync_status ?? 'Never'],
            ['Last push notification', cfg.last_push_at ? formatDateTime(cfg.last_push_at) : cfg.push_enabled ? 'None yet' : 'Push off (scheduled sync only)'],
            ['Push watch', cfg.watch_expiration ? `until ${formatDateTime(cfg.watch_expiration)}${cfg.watch_status ? ` — ${cfg.watch_status}` : ''}` : cfg.watch_status ?? '—'],
            ['Emails', `${d.counts.received} received · ${d.counts.sent} sent · ${d.counts.pending} pending · ${d.counts.failed} failed`],
          ]} />}
          {cfg?.is_enabled && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('sync', async () => (await syncMailboxNow()).results.map((r) => r.message).join(' ') || 'Synced.')}>
                {busy === 'sync' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now</Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('full', async () => (await syncMailboxNow(true)).results.map((r) => r.message).join(' ') || 'Synced.')}>
                {busy === 'full' && <Loader2 className="animate-spin" />}Full re-sync</Button>
              {cfg.push_enabled && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('watch', async () => (await renewGmailWatch()).results.map((r) => r.message).join(' '))}>
                {busy === 'watch' && <Loader2 className="animate-spin" />}Renew push watch</Button>}
            </div>
          )}
          <ConfigForm cfg={cfg} onSaved={(text) => { setNotice({ ok: true, text }); reload() }} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Server configuration</CardTitle>
          <CardDescription>Edge Function secrets, set with npx supabase secrets set NAME=value. Only whether each is set is shown — never a value.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          {server.data && 'error' in server.data && <p className="text-sm text-amber-800">Server status unavailable: {server.data.error}</p>}
          {srv?.problems.length ? <p className="text-sm text-red-700" role="alert">{srv.problems.join(' ')}</p> : null}
          <ul className="space-y-2">{SECRET_ROWS.map(([k, name, help]) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" data-testid={`gsecret-${k}`}>
              <div className="min-w-0"><p className="font-mono text-xs font-medium">{name}</p><p className="text-xs text-muted-foreground">{help}</p></div>
              {srv ? <StatusBadge label={srv.secrets[k] ? 'Configured' : 'Not set'} tone={srv.secrets[k] ? 'success' : k === 'push_oidc' ? 'neutral' : 'warning'} /> : <StatusBadge label="Unknown" tone="neutral" />}
            </li>
          ))}</ul>
          {srv && (
            <div className="space-y-2 text-sm" data-testid="google-urls">
              {[['Authorised redirect URI (OAuth client)', srv.redirect_uri], ['Pub/Sub push endpoint', srv.webhook_url]].map(([label, value]) => (
                <div key={label} className="rounded-md border px-3 py-2"><p className="font-medium">{label}</p>
                  <div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs" title={value}>{value}</code>
                    <Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => copy(value)}><Copy className="size-3.5" /></Button></div></div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <TemplatesCard canEdit={canEditTemplates} />

      {cfg && (
        <Card>
          <CardHeader><div><CardTitle>Events</CardTitle><CardDescription>The latest 50 mailbox events. A push notification can be replayed: the mailbox history is read again and nothing is stored twice.</CardDescription></div></CardHeader>
          <CardContent>{!d.events.length ? <p className="text-sm text-muted-foreground">No events yet.</p> : (
            <Table data-testid="email-events"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Time</TableHead><TableHead>Type</TableHead><TableHead>Detail</TableHead><TableHead>Result</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{d.events.map((e) => (
                <TableRow key={e.id}><TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.created_at)}</TableCell>
                  <TableCell className="text-xs">{e.event_type === 'WEBHOOK' ? 'push notification' : e.event_type.toLowerCase().replace(/_/g, ' ')}</TableCell>
                  <TableCell className="max-w-md text-xs">{e.message ?? '—'}{e.history_id ? ` · history ${e.history_id}` : ''}</TableCell>
                  <TableCell className="text-xs">{e.processing_result ?? '—'}{e.processing_error ? ` — ${e.processing_error}` : ''}{e.replay_count ? ` · replayed ${e.replay_count}×` : ''}</TableCell>
                  <TableCell>{e.event_type === 'WEBHOOK' && cfg.is_enabled && <Button size="sm" variant="ghost" disabled={busy !== null}
                    onClick={() => void run('replay', async () => `Replayed: ${(await replayGmailEvent(e.id)).results.map((r) => r.message).join(' ')}`)}><RotateCcw /> Replay</Button>}</TableCell>
                </TableRow>
              ))}</TableBody></Table>)}</CardContent>
        </Card>
      )}

      {disconnect && <DisconnectDialog onClose={() => setDisconnect(false)} onDone={(text) => { setDisconnect(false); setNotice({ ok: true, text }); reload() }} />}
    </div>
  )
}

function DisconnectDialog({ onClose, onDone }: { onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true); setError(null)
    try {
      const r = await disconnectGoogle(reason.trim() || 'Disconnected in Support Settings')
      onDone(r.revoked ? 'Disconnected and access revoked at Google.' : 'Disconnected. Google did not confirm the revocation: remove the app under the Google account’s third-party access as well.')
    } catch (e) {
      setError(e instanceof Error ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Disconnect Google Workspace?</DialogTitle>
          <DialogDescription>Push notifications stop, the refresh token is revoked at Google and deleted here. Stored emails stay. Sending and syncing stop until it is connected again.</DialogDescription></DialogHeader>
        <Field label="Reason" htmlFor="dc-reason"><Textarea id="dc-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} /></Field>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void go()} data-testid="confirm-disconnect">{busy && <Loader2 className="animate-spin" />}Disconnect</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfigForm({ cfg, onSaved }: { cfg: EmailConfig['config']; onSaved: (text: string) => void }) {
  const [v, setV] = useState(() => ({ mailbox: cfg?.mailbox_address ?? '', name: cfg?.display_name ?? '', signature: cfg?.signature ?? '', topic: cfg?.pubsub_topic ?? '',
    push: cfg?.push_enabled ?? false, modify: cfg?.mailbox_modify_enabled ?? false, days: String(cfg?.initial_sync_days ?? 7), mb: String(cfg?.max_attachment_mb ?? 10) }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!isEmail(v.mailbox)) { setError('Enter the shared support mailbox address.'); return }
    if (v.push && !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/.test(v.topic.trim())) { setError('Push needs the Pub/Sub topic: projects/<project-id>/topics/<topic>.'); return }
    if (!/^\d{1,2}$/.test(v.days) || Number(v.days) < 1 || Number(v.days) > 30) { setError('First sync: 1 to 30 days.'); return }
    if (!/^\d{1,2}$/.test(v.mb) || Number(v.mb) < 1 || Number(v.mb) > 25) { setError('Attachment limit: 1 to 25 MB.'); return }
    setBusy(true); setError(null)
    try {
      await saveEmailConfig({ mailbox_address: v.mailbox.trim(), display_name: v.name.trim() || null, signature: v.signature.trim() || null, pubsub_topic: v.topic.trim() || null,
        push_enabled: v.push, mailbox_modify_enabled: v.modify, initial_sync_days: Number(v.days), max_attachment_mb: Number(v.mb) })
      onSaved(cfg ? 'Email settings saved.' : 'Email settings saved. Now use Connect Google Workspace and sign in as the support mailbox.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <form className="grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate data-testid="email-config-form">
      <Field label="Provider" htmlFor="em-provider"><Input id="em-provider" value="Google Workspace (Gmail API)" disabled /></Field>
      <Field label="Shared support mailbox" htmlFor="em-mailbox" hint={cfg?.is_enabled ? 'Disconnect to change the mailbox.' : 'You will sign in as this mailbox; another account is refused.'}>
        <Input id="em-mailbox" value={v.mailbox} onChange={(e) => setV((s) => ({ ...s, mailbox: e.target.value }))} disabled={cfg?.is_enabled} placeholder="support@yourcompany.com" /></Field>
      <Field label="Sender name" htmlFor="em-name"><Input id="em-name" value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} maxLength={120} placeholder="Alton Support" /></Field>
      <Field label="First sync: days of mail" htmlFor="em-days"><Input id="em-days" value={v.days} onChange={(e) => setV((s) => ({ ...s, days: e.target.value }))} inputMode="numeric" /></Field>
      <Field label="Signature" htmlFor="em-sig"><Textarea id="em-sig" value={v.signature} onChange={(e) => setV((s) => ({ ...s, signature: e.target.value }))} rows={3} maxLength={2000} /></Field>
      <Field label="Largest received attachment stored (MB)" htmlFor="em-mb" hint="Larger files and executables are listed but not stored.">
        <Input id="em-mb" value={v.mb} onChange={(e) => setV((s) => ({ ...s, mb: e.target.value }))} inputMode="numeric" /></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={v.push} onCheckedChange={(x) => setV((s) => ({ ...s, push: x === true }))} />
        Push notifications through Cloud Pub/Sub (otherwise the scheduled sync only)</label>
      {v.push && <Field label="Pub/Sub topic" htmlFor="em-topic" hint="projects/<project-id>/topics/<topic>; grant gmail-api-push@system.gserviceaccount.com publish rights on it.">
        <Input id="em-topic" value={v.topic} onChange={(e) => setV((s) => ({ ...s, topic: e.target.value }))} /></Field>}
      <label className="flex items-start gap-2 text-sm sm:col-span-2"><Checkbox checked={v.modify} onCheckedChange={(x) => setV((s) => ({ ...s, modify: x === true }))} />
        <span>Mirror “read” to the Gmail mailbox (asks Google for the additional gmail.modify permission; reauthorisation required). Off: the ERP only reads and sends.</span></label>
      {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
      <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{cfg ? 'Save settings' : 'Save and continue'}</Button></div>
    </form>
  )
}

function TemplatesCard({ canEdit }: { canEdit: boolean }) {
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(fetchEmailTemplates, [refresh])
  const [edit, setEdit] = useState<EmailTemplate | 'new' | null>(null)
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div><CardTitle>Email templates</CardTitle><CardDescription>Approved (active) templates are offered to agents in the compose window.</CardDescription></div>
        {canEdit && <Button size="sm" onClick={() => setEdit('new')}><Plus /> Add template</Button>}
      </CardHeader>
      <CardContent>
        {q.error ? <ErrorState message={describeDataError(q.error)} onRetry={q.reload} /> : !q.data?.length ? <p className="text-sm text-muted-foreground">No templates yet.</p> : (
          <ul className="divide-y text-sm" data-testid="email-templates">{q.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0"><p className="font-medium">{t.name}</p><p className="truncate text-xs text-muted-foreground">{t.subject ?? 'No subject'} — {t.body.slice(0, 100)}</p></div>
              <div className="flex items-center gap-2"><StatusBadge label={t.is_active ? 'Approved' : 'Inactive'} tone={t.is_active ? 'success' : 'neutral'} />
                {canEdit && <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Edit</Button>}</div>
            </li>
          ))}</ul>
        )}
        {!canEdit && <p className="mt-2 text-xs text-muted-foreground">Changing templates needs support settings access.</p>}
      </CardContent>
      {edit && <TemplateDialog template={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setRefresh((n) => n + 1) }} />}
    </Card>
  )
}

function TemplateDialog({ template, onClose, onSaved }: { template: EmailTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(() => ({ name: template?.name ?? '', subject: template?.subject ?? '', body: template?.body ?? '', active: template?.is_active ?? true }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!v.name.trim() || !v.body.trim()) { setError('Enter the name and the text.'); return }
    setBusy(true); setError(null)
    try { await saveEmailTemplate(template?.id ?? null, { name: v.name.trim(), subject: v.subject.trim() || null, body: v.body, is_active: v.active }); onSaved() }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{template ? 'Edit template' : 'Add template'}</DialogTitle><DialogDescription>Plain text; agents can edit it before sending.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <Field label="Name" htmlFor="tp-name"><Input id="tp-name" value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Subject (new emails)" htmlFor="tp-subject"><Input id="tp-subject" value={v.subject} onChange={(e) => setV((s) => ({ ...s, subject: e.target.value }))} maxLength={300} /></Field>
          <Field label="Text" htmlFor="tp-body"><Textarea id="tp-body" rows={8} value={v.body} onChange={(e) => setV((s) => ({ ...s, body: e.target.value }))} maxLength={20000} /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.active} onCheckedChange={(x) => setV((s) => ({ ...s, active: x === true }))} />Approved for use</label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
