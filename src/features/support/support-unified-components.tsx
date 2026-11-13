import { AlertTriangle, Download, Loader2, PlugZap, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, IntegrationBadge } from '@/features/support/support-components'
import { PRIORITIES, PRIORITY_META, PROVIDER_LABELS, SLA_META, WEEKDAYS, formatRemaining, toCsv, type Priority } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchAgents } from '@/services/support'
import {
  fetchAutomationSettings, fetchIntegrationHealth, fetchTicketSla, fetchUnifiedReports, runSlaNow, saveAssignmentRule, saveBusinessCalendar, saveEscalationLevel, saveHoliday,
  saveTicketRules, testProvider, type AutomationSettings, type TicketRules,
} from '@/services/support-unified'
import { reportCsvSections } from '@/features/support/support-reports-csv'

const ANY = '__any'
const notice = (n: { ok: boolean; text: string } | null) => n && (
  <p role={n.ok ? 'status' : 'alert'} data-testid="unified-notice" className={n.ok ? 'rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800'
    : 'rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800'}>{n.text}</p>)
const splitWords = (s: string) => s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)

function PrioritySelect({ id, value, onChange, disabled }: { id: string; value: string; onChange: (v: Priority) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Priority)} disabled={disabled}>
      <SelectTrigger id={id} className="h-9"><SelectValue /></SelectTrigger>
      <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
    </Select>
  )
}

// ---- Ticket rules and assignment ------------------------------------------------------------
type Notice = { ok: boolean; text: string } | null

// The message lives here so it survives the form being rebuilt with the saved values.
export function TicketRulesSettings() {
  const [refresh, setRefresh] = useState(0)
  const [n, setN] = useState<Notice>(null)
  const q = useAsync(fetchAutomationSettings, [refresh])
  if (q.loading && !q.data) return <LoadingState rows={6} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  return <>{notice(n)}<RulesForm key={refresh} s={q.data} setN={setN} onSaved={() => setRefresh((x) => x + 1)} /></>
}

function RulesForm({ s, onSaved, setN }: { s: AutomationSettings; onSaved: () => void; setN: (n: Notice) => void }) {
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const [r, setR] = useState<TicketRules>(s.rules)
  const [emailWords, setEmailWords] = useState(s.rules.email_keywords.join(', '))
  const [waWords, setWaWords] = useState(s.rules.whatsapp_keywords.join(', '))
  const [busy, setBusy] = useState(false)
  const [rule, setRule] = useState({ name: '', channel: ANY, priority: ANY, department: '', agent: ANY })
  const ro = !s.can_edit
  const set = <K extends keyof TicketRules>(k: K, v: TicketRules[K]) => setR((x) => ({ ...x, [k]: v }))
  const save = async () => {
    setBusy(true); setN(null)
    try { await saveTicketRules({ ...r, email_keywords: splitWords(emailWords), whatsapp_keywords: splitWords(waWords) }); setN({ ok: true, text: 'Ticket rules saved.' }); onSaved() }
    catch (e) { setN({ ok: false, text: describeDataError(e) }) } finally { setBusy(false) }
  }
  const addRule = async () => {
    setN(null)
    try {
      await saveAssignmentRule(null, { name: rule.name, channel: rule.channel === ANY ? null : rule.channel, priority: rule.priority === ANY ? null : rule.priority as Priority,
        department: rule.department || null, agent_id: rule.agent === ANY ? null : rule.agent, is_active: true })
      onSaved()
    } catch (e) { setN({ ok: false, text: describeDataError(e) }) }
  }
  const agentName = (id: string | null) => (agents.data ?? []).find((a) => a.id === id)?.display_name ?? '—'
  const toggle = (k: keyof TicketRules, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={Boolean(r[k])} disabled={ro} onCheckedChange={(x) => set(k, (x === true) as never)} data-testid={`rule-${k}`} />
      <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span></label>
  )
  return (
    <div className="mt-4 space-y-4" data-testid="ticket-rules">
      <Card>
        <CardHeader><div><CardTitle>Ticket creation rules</CardTitle><CardDescription>Applied to every incoming call, email and WhatsApp message (all providers). Each rule can be switched on or off.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4">
          {ro && <p className="text-sm text-muted-foreground">Changing rules needs support settings access.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New conversations" htmlFor="rule-mode">
              <Select value={r.ticket_mode} onValueChange={(v) => set('ticket_mode', v as TicketRules['ticket_mode'])} disabled={ro}>
                <SelectTrigger id="rule-mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="AGENT_REQUEST_ONLY">Ticket only when an agent creates one</SelectItem><SelectItem value="EVERY_NEW_CONVERSATION">Ticket for every new customer conversation</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Priority for new-conversation tickets" htmlFor="rule-np"><PrioritySelect id="rule-np" value={r.new_conversation_priority} onChange={(v) => set('new_conversation_priority', v)} disabled={ro} /></Field>
          </div>
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
            {toggle('missed_call_enabled', 'Create a ticket for every missed call')}
            <Field label="Missed-call priority" htmlFor="rule-mp"><PrioritySelect id="rule-mp" value={r.missed_call_priority} onChange={(v) => set('missed_call_priority', v)} disabled={ro} /></Field>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            {toggle('email_keywords_enabled', 'Create a ticket for emails whose subject contains a keyword')}
            <Field label="Email keywords (comma separated)" htmlFor="rule-ek"><Input id="rule-ek" value={emailWords} onChange={(e) => setEmailWords(e.target.value)} disabled={ro} placeholder="refund, broken, complaint" /></Field>
            {toggle('email_match_body', 'Also look in the email text')}
          </div>
          <div className="space-y-2 rounded-md border p-3">
            {toggle('whatsapp_keywords_enabled', 'Create a ticket for WhatsApp messages containing a keyword')}
            <Field label="WhatsApp keywords (comma separated)" htmlFor="rule-wk"><Input id="rule-wk" value={waWords} onChange={(e) => setWaWords(e.target.value)} disabled={ro} placeholder="damaged, urgent" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority for keyword tickets" htmlFor="rule-kp"><PrioritySelect id="rule-kp" value={r.keyword_priority} onChange={(v) => set('keyword_priority', v)} disabled={ro} /></Field>
            <Field label="SLA warning at (% of the target used)" htmlFor="rule-warn"><Input id="rule-warn" value={String(r.sla_warning_percent)} inputMode="numeric" disabled={ro}
              onChange={(e) => set('sla_warning_percent', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
          </div>
          {toggle('reopen_on_reply_enabled', 'Reopen a resolved ticket when the customer replies')}
          {toggle('escalate_on_breach_enabled', 'Escalate breached tickets (escalation levels in SLA policies)', `Priorities: ${r.escalate_priorities.map((p) => PRIORITY_META[p].label).join(', ')}`)}
          <div className="flex flex-wrap gap-3 pl-6">{PRIORITIES.map((p) => (
            <label key={p} className="flex items-center gap-1 text-xs"><Checkbox checked={r.escalate_priorities.includes(p)} disabled={ro}
              onCheckedChange={(x) => set('escalate_priorities', x === true ? [...r.escalate_priorities, p] : r.escalate_priorities.filter((y) => y !== p))} />{PRIORITY_META[p].label}</label>))}</div>
          {!ro && <div className="flex justify-end"><Button disabled={busy} onClick={() => void save()} data-testid="rules-save">{busy && <Loader2 className="animate-spin" />}Save rules</Button></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Agent and department assignment</CardTitle><CardDescription>New tickets without an agent: the first matching active rule assigns the agent and / or department.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          {s.assignment.length === 0 ? <p className="text-sm text-muted-foreground">No assignment rules.</p> : (
            <Table data-testid="assignment-rules"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Rule</TableHead><TableHead>Channel</TableHead><TableHead>Priority</TableHead>
              <TableHead>Department</TableHead><TableHead>Agent</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{s.assignment.map((a) => (
                <TableRow key={a.id}><TableCell>{a.name}</TableCell><TableCell>{a.channel ?? 'Any'}</TableCell><TableCell>{a.priority ? PRIORITY_META[a.priority].label : 'Any'}</TableCell>
                  <TableCell>{a.department ?? '—'}</TableCell><TableCell>{agentName(a.agent_id)}</TableCell>
                  <TableCell>{!ro && <Button size="sm" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => void saveAssignmentRule(a.id, {}, true).then(onSaved)}><Trash2 className="size-3.5" /></Button>}</TableCell></TableRow>
              ))}</TableBody></Table>)}
          {!ro && (
            <div className="grid gap-2 sm:grid-cols-6">
              <Input aria-label="Rule name" placeholder="Rule name" value={rule.name} onChange={(e) => setRule((x) => ({ ...x, name: e.target.value }))} className="sm:col-span-2" />
              <Select value={rule.channel} onValueChange={(v) => setRule((x) => ({ ...x, channel: v }))}><SelectTrigger aria-label="Channel"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ANY}>Any channel</SelectItem>{['PHONE', 'WHATSAPP', 'EMAIL', 'MANUAL'].map((c) => <SelectItem key={c} value={c}>{c.toLowerCase()}</SelectItem>)}</SelectContent></Select>
              <Select value={rule.priority} onValueChange={(v) => setRule((x) => ({ ...x, priority: v }))}><SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ANY}>Any priority</SelectItem>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent></Select>
              <Input aria-label="Department" placeholder="Department" value={rule.department} onChange={(e) => setRule((x) => ({ ...x, department: e.target.value }))} />
              <Select value={rule.agent} onValueChange={(v) => setRule((x) => ({ ...x, agent: v }))}><SelectTrigger aria-label="Agent"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ANY}>No agent</SelectItem>{(agents.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>)}</SelectContent></Select>
              <div className="sm:col-span-6"><Button size="sm" variant="outline" onClick={() => void addRule()}><Plus /> Add rule</Button></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---- Business hours, holidays, escalation levels --------------------------------------------
export function SlaCalendarSettings() {
  const [refresh, setRefresh] = useState(0)
  const [n, setN] = useState<Notice>(null)
  const q = useAsync(fetchAutomationSettings, [refresh])
  if (q.loading && !q.data) return <LoadingState rows={4} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  return <>{notice(n)}<CalendarForm key={refresh} s={q.data} setN={setN} onSaved={() => setRefresh((x) => x + 1)} /></>
}

function CalendarForm({ s, onSaved, setN }: { s: AutomationSettings; onSaved: () => void; setN: (n: Notice) => void }) {
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const [c, setC] = useState({ ...s.calendar, start_time: s.calendar.start_time.slice(0, 5), end_time: s.calendar.end_time.slice(0, 5) })
  const [h, setH] = useState({ date: '', name: '' })
  const [lv, setLv] = useState({ level: String((s.levels.at(-1)?.level ?? 0) + 1), after: '0', agent: ANY, department: '', raise: false, urgentOnly: true })
  const [busy, setBusy] = useState<string | null>(null)
  const ro = !s.can_edit
  const run = async (k: string, fn: () => Promise<unknown>, ok: string | (() => string)) => {
    setBusy(k); setN(null)
    try { await fn(); setN({ ok: true, text: typeof ok === 'string' ? ok : ok() }); onSaved() } catch (e) { setN({ ok: false, text: describeDataError(e) }) } finally { setBusy(null) }
  }
  return (
    <div className="mt-4 space-y-4" data-testid="sla-calendar">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div><CardTitle>Business hours</CardTitle><CardDescription>SLA targets count working time only when this is on; otherwise every minute counts (24×7).</CardDescription></div>
          {!ro && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => {
            let text = 'SLA check finished.'
            void run('run', async () => { const r = await runSlaNow(); text = `SLA check: ${r.warnings} warnings, ${r.breaches} breaches, ${r.escalations} escalations.` }, () => text)
          }}>{busy === 'run' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Run SLA check now</Button>}
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={c.enabled} disabled={ro} onCheckedChange={(x) => setC((v) => ({ ...v, enabled: x === true }))} data-testid="cal-enabled" />Use business hours for SLA</label>
          <div className="flex flex-wrap gap-3">{WEEKDAYS.map(([d, l]) => (
            <label key={d} className="flex items-center gap-1 text-sm"><Checkbox checked={c.working_days.includes(d)} disabled={ro}
              onCheckedChange={(x) => setC((v) => ({ ...v, working_days: x === true ? [...v.working_days, d].sort() : v.working_days.filter((y) => y !== d) }))} />{l}</label>))}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Opens" htmlFor="cal-start"><Input id="cal-start" type="time" value={c.start_time} disabled={ro} onChange={(e) => setC((v) => ({ ...v, start_time: e.target.value }))} /></Field>
            <Field label="Closes" htmlFor="cal-end"><Input id="cal-end" type="time" value={c.end_time} disabled={ro} onChange={(e) => setC((v) => ({ ...v, end_time: e.target.value }))} /></Field>
            <Field label="Time zone" htmlFor="cal-tz"><Input id="cal-tz" value={c.timezone ?? ''} disabled={ro} onChange={(e) => setC((v) => ({ ...v, timezone: e.target.value || null }))} placeholder="Asia/Kolkata" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={c.pause_when_waiting_customer} disabled={ro} onCheckedChange={(x) => setC((v) => ({ ...v, pause_when_waiting_customer: x === true }))} />
            Pause the SLA while a ticket waits for the customer</label>
          {!ro && <div className="flex justify-end"><Button size="sm" disabled={busy !== null} onClick={() => void run('cal', () => saveBusinessCalendar(c), 'Business hours saved.')} data-testid="cal-save">Save business hours</Button></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Holidays</CardTitle><CardDescription>No SLA time is counted on these days (with business hours on).</CardDescription></div></CardHeader>
        <CardContent className="space-y-2">
          <ul className="divide-y text-sm" data-testid="holidays">{s.holidays.map((x) => (
            <li key={x.id} className="flex items-center justify-between py-1.5"><span>{x.date} — {x.name}</span>
              {!ro && <Button size="sm" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => void run('h', () => saveHoliday(x.date, x.name, true), 'Holiday removed.')}><Trash2 className="size-3.5" /></Button>}</li>))}</ul>
          {!s.holidays.length && <p className="text-sm text-muted-foreground">No holidays.</p>}
          {!ro && <div className="flex flex-wrap gap-2"><Input aria-label="Holiday date" type="date" className="w-44" value={h.date} onChange={(e) => setH((v) => ({ ...v, date: e.target.value }))} />
            <Input aria-label="Holiday name" className="w-56" placeholder="Name" value={h.name} onChange={(e) => setH((v) => ({ ...v, name: e.target.value }))} />
            <Button size="sm" variant="outline" onClick={() => void run('h', () => saveHoliday(h.date, h.name), 'Holiday added.')}><Plus /> Add</Button></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Escalation levels</CardTitle><CardDescription>Applied once each to breached tickets of the priorities chosen in Ticket rules, when switched on there.</CardDescription></div></CardHeader>
        <CardContent className="space-y-2">
          {s.levels.length === 0 ? <p className="text-sm text-muted-foreground">No escalation levels.</p> : (
            <Table data-testid="escalation-levels"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Level</TableHead><TableHead>After breach</TableHead><TableHead>Priorities</TableHead>
              <TableHead>Reassign to</TableHead><TableHead>Department</TableHead><TableHead>Raise priority</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{s.levels.map((l) => (
                <TableRow key={l.level}><TableCell>{l.level}</TableCell><TableCell>{l.after_minutes} min</TableCell><TableCell>{l.priorities.length ? l.priorities.join(', ') : 'All'}</TableCell>
                  <TableCell>{(agents.data ?? []).find((a) => a.id === l.reassign_agent_id)?.display_name ?? '—'}</TableCell><TableCell>{l.set_department ?? '—'}</TableCell><TableCell>{l.raise_priority ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{!ro && <Button size="sm" variant="ghost" aria-label={`Delete level ${l.level}`} onClick={() => void run('l', () => saveEscalationLevel(l.level, {}, true), 'Level removed.')}><Trash2 className="size-3.5" /></Button>}</TableCell></TableRow>
              ))}</TableBody></Table>)}
          {!ro && <div className="grid gap-2 sm:grid-cols-6">
            <Input aria-label="Level" value={lv.level} onChange={(e) => setLv((v) => ({ ...v, level: e.target.value }))} inputMode="numeric" placeholder="Level 1–5" />
            <Input aria-label="Minutes after breach" value={lv.after} onChange={(e) => setLv((v) => ({ ...v, after: e.target.value }))} inputMode="numeric" placeholder="Minutes after breach" />
            <Select value={lv.agent} onValueChange={(v) => setLv((x) => ({ ...x, agent: v }))}><SelectTrigger aria-label="Reassign to"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ANY}>Keep agent</SelectItem>{(agents.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.display_name}</SelectItem>)}</SelectContent></Select>
            <Input aria-label="Escalation department" value={lv.department} onChange={(e) => setLv((v) => ({ ...v, department: e.target.value }))} placeholder="Department" />
            <label className="flex items-center gap-1 text-xs"><Checkbox checked={lv.raise} onCheckedChange={(x) => setLv((v) => ({ ...v, raise: x === true }))} />Raise priority</label>
            <Button size="sm" variant="outline" onClick={() => void run('l', () => saveEscalationLevel(Number(lv.level), { after_minutes: Number(lv.after) || 0, priorities: [],
              reassign_agent_id: lv.agent === ANY ? null : lv.agent, set_department: lv.department || null, raise_priority: lv.raise, notify_assignee: true, notify_managers: true, is_active: true }),
              'Escalation level saved.')}><Plus /> Save level</Button>
          </div>}
        </CardContent>
      </Card>
    </div>
  )
}

// ---- Integration health ------------------------------------------------------------------------
export function IntegrationHealthPanel() {
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(fetchIntegrationHealth, [refresh])
  const [busy, setBusy] = useState<string | null>(null)
  const [n, setN] = useState<{ ok: boolean; text: string } | null>(null)
  if (q.loading && !q.data) return <LoadingState rows={4} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  const when = (v: string | null) => (v ? formatDateTime(v) : 'Never')
  return (
    <div className="space-y-4" data-testid="integration-health">
      {notice(n)}
      <p className="text-sm text-muted-foreground">A provider shows Connected only after its real API test (or authorisation) succeeded on the server. Secrets are never shown.</p>
      <div className="grid gap-4 lg:grid-cols-3">{q.data.map((p) => (
        <Card key={p.provider} data-testid={`health-${p.provider}`}>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div><CardTitle className="text-base">{PROVIDER_LABELS[p.provider]}</CardTitle><CardDescription>{p.configured ? p.status_detail ?? '' : 'Not configured.'}</CardDescription></div>
            <IntegrationBadge status={p.status} testId={`health-status-${p.provider}`} />
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {p.expired_credentials && <p className="flex items-center gap-1 text-red-700" data-testid={`health-expired-${p.provider}`}><AlertTriangle className="size-4" />Credentials expired or revoked</p>}
            <p>Verified by API test: <span className="text-muted-foreground">{when(p.verified_by_test_at)}</span></p>
            {p.setup_state && <p>Setup state: <span className="text-muted-foreground">{p.setup_state.toLowerCase().replace(/_/g, ' ')}{p.enabled ? ' · switched on' : ' · switched off'}</span></p>}
            <p>Last synchronisation: <span className="text-muted-foreground">{when(p.last_sync_at)}</span></p>
            <p>Last webhook received: <span className="text-muted-foreground">{when(p.last_webhook_at)}</span></p>
            <p>Last successful outbound: <span className="text-muted-foreground">{when(p.last_outbound_at)}</span></p>
            <p>Failed events (7 days): <strong>{p.failed_events_7d}</strong> · Retry queue: <strong>{p.retry_queue}</strong></p>
            {p.errors.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-red-800">{p.errors.map((e, i) => <li key={i}>{formatDateTime(e.at)} — {e.message}</li>)}</ul>}
            {p.configured && <Button size="sm" variant="outline" className="mt-2" disabled={busy !== null} onClick={() => {
              setBusy(p.provider); setN(null)
              testProvider(p.provider).then((t) => setN({ ok: true, text: t }), (e) => setN({ ok: false, text: e instanceof Error ? e.message : String(e) }))
                .finally(() => { setBusy(null); setRefresh((x) => x + 1) })
            }}>{busy === p.provider ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>}
          </CardContent>
        </Card>
      ))}</div>
    </div>
  )
}

// ---- Ticket SLA panel ---------------------------------------------------------------------------
export function TicketSlaPanel({ ticketId, timezone }: { ticketId: string; timezone?: string }) {
  const q = useAsync(() => fetchTicketSla(ticketId), [ticketId])
  if (q.loading && !q.data) return <p className="text-sm text-muted-foreground">Loading SLA…</p>
  if (q.error || !q.data) return null
  const s = q.data
  const meta = SLA_META[s.status] ?? SLA_META.NO_SLA
  const row = (label: string, x: typeof s.first_response) => (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <span className={x.breached ? 'text-red-700' : 'text-muted-foreground'}>
        {x.done_at ? `done ${formatDateTime(x.done_at, timezone)}${x.breached ? ' (late)' : ''}` : x.due_at ? `${formatRemaining(x.remaining_minutes)} · due ${formatDateTime(x.due_at, timezone)}` : 'no target'}</span>
    </div>
  )
  return (
    <div className="space-y-2" data-testid="ticket-sla">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">SLA{s.policy ? ` · ${s.policy.name}` : ''}{s.business_hours ? ' · business hours' : ''}</span>
        <span title={meta.hint} data-testid="ticket-sla-status" data-status={s.status}><StatusBadge label={meta.label} tone={meta.tone} /></span></div>
      {row('First response', s.first_response)}
      {row('Resolution', s.resolution)}
      {s.paused && <p className="text-xs text-muted-foreground">Paused since {formatDateTime(s.paused_since!, timezone)} (waiting for the customer).</p>}
      {s.paused_minutes > 0 && <p className="text-xs text-muted-foreground">{s.paused_minutes} minutes excluded while waiting for the customer.</p>}
      {s.history.length > 0 && <ul className="space-y-0.5 border-t pt-2 text-xs" data-testid="ticket-sla-history">{s.history.map((h, i) => (
        <li key={i} className={h.kind === 'WARNING' ? 'text-amber-800' : 'text-red-800'}>{formatDateTime(h.at, timezone)} — {h.kind === 'WARNING' ? 'Warning' : h.kind === 'BREACH' ? 'Breached' : `Escalated (level ${h.level})`}: {h.target.toLowerCase().replace('_', ' ')}</li>
      ))}</ul>}
    </div>
  )
}

// ---- Unified reports (CSV per section) ----------------------------------------------------------
function download(name: string, rows: (string | number | null | undefined)[][]) {
  const url = URL.createObjectURL(new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function UnifiedReportsSection({ from, to }: { from: string; to: string }) {
  const q = useAsync(() => fetchUnifiedReports(from, to), [from, to])
  if (q.loading && !q.data) return <LoadingState rows={4} />
  if (q.error || !q.data) return <Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card>
  const r = q.data
  const sections = reportCsvSections(r)
  const title: Record<string, string> = { 'channel-volume': 'Channel-wise incoming volume', calls: 'Calls: answer and missed rates', 'response-times': 'Email and WhatsApp response time',
    tickets: 'Ticket volume and closure rate', agents: 'Agent workload', sla: 'SLA compliance', satisfaction: 'Customer satisfaction' }
  return (
    <Card data-testid="unified-reports">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div><CardTitle>Channels, response times and SLA</CardTitle><CardDescription>{from} to {to}. Each table downloads as CSV.</CardDescription></div>
        <Button size="sm" variant="outline" onClick={() => Object.entries(sections).forEach(([k, rows]) => download(`support-${k}-${from}-${to}.csv`, rows))}><Download /> All CSV</Button>
      </CardHeader>
      <CardContent className="space-y-5">{Object.entries(sections).map(([k, rows]) => (
        <section key={k} data-testid={`report-${k}`}>
          <div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{title[k]}</h3>
            <Button size="sm" variant="ghost" onClick={() => download(`support-${k}-${from}-${to}.csv`, rows)} data-testid={`csv-${k}`}><Download className="size-3.5" /> CSV</Button></div>
          <div className="overflow-x-auto"><Table><TableHeader><TableRow className="hover:bg-transparent">{rows[0].map((h, i) => <TableHead key={i}>{h}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{rows.slice(1).map((row, i) => <TableRow key={i}>{row.map((c, j) => <TableCell key={j} className="tabular-nums">{c ?? '—'}</TableCell>)}</TableRow>)}
              {rows.length === 1 && <TableRow><TableCell colSpan={rows[0].length} className="text-muted-foreground">No data in this period.</TableCell></TableRow>}</TableBody></Table></div>
        </section>
      ))}</CardContent>
    </Card>
  )
}
