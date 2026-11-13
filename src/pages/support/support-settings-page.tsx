import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { PhoneSettings } from '@/features/support/phone-settings'
import { EmailSettings } from '@/features/support/email-settings'
import { WhatsAppSettings } from '@/features/support/whatsapp-settings'
import { IntegrationHealthPanel, SlaCalendarSettings, TicketRulesSettings } from '@/features/support/support-unified-components'
import { ChannelLabel, Field, IntegrationBadge } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CHANNELS, CHANNEL_LABELS, PRESENCE_META, PRIORITIES, PRIORITY_META, TAG_COLORS, formatMinutes, type Channel, type Priority } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  deleteTag, fetchAgents, fetchChannelAccounts, fetchCompanyUsers, fetchIntegrationEvents, fetchSlaPolicies, fetchTags, saveAgent, saveChannelAccount, saveSlaPolicy,
  saveTag, type Agent, type ChannelAccount, type SlaPolicy, type TagRef,
} from '@/services/support'

type Tab = 'agents' | 'sla' | 'rules' | 'tags' | 'channels' | 'phone' | 'email' | 'whatsapp' | 'health' | 'numbering'

/** /support/settings — agents, SLA policies, tags and channel integrations. */
export default function SupportSettingsPage() {
  const perms = useSupportPermissions()
  const [tab, setTab] = useUrlParam('tab', 'agents')
  const tabs: { value: Tab; label: string }[] = [
    { value: 'agents', label: 'Agents' }, { value: 'sla', label: 'SLA policies' }, { value: 'rules', label: 'Ticket rules' }, { value: 'tags', label: 'Tags' },
    ...(perms.integrations ? [{ value: 'channels' as Tab, label: 'Channel integrations' }, { value: 'phone' as Tab, label: 'Phone' }, { value: 'email' as Tab, label: 'Email' }, { value: 'whatsapp' as Tab, label: 'WhatsApp' }, { value: 'health' as Tab, label: 'Integration health' }] : []), { value: 'numbering', label: 'Ticket numbering' },
  ]
  const t = (tabs.some((x) => x.value === tab) ? tab : 'agents') as Tab
  return (
    <>
      <PageHeader />
      <FilterTabs<Tab> label="Settings section" value={t} onChange={setTab} options={tabs} className="mb-4" />
      {!perms.settings && t !== 'channels' && t !== 'phone' && t !== 'email' && t !== 'whatsapp' && t !== 'health' && <p className="mb-3 text-sm text-muted-foreground">Your role can view these settings; changing them needs support settings access.</p>}
      {t === 'agents' && <AgentsTab canEdit={perms.settings} />}
      {t === 'sla' && <><SlaTab canEdit={perms.settings} /><div className="mt-4"><SlaCalendarSettings /></div></>}
      {t === 'rules' && <TicketRulesSettings />}
      {t === 'health' && perms.integrations && <IntegrationHealthPanel />}
      {t === 'tags' && <TagsTab canEdit={perms.settings} />}
      {t === 'channels' && perms.integrations && <ChannelsTab />}
      {t === 'phone' && perms.integrations && <PhoneSettings />}
      {t === 'email' && perms.integrations && <EmailSettings canEditTemplates={perms.settings} />}
      {t === 'whatsapp' && perms.integrations && <WhatsAppSettings />}
      {t === 'numbering' && (
        <Card><CardContent className="space-y-2 p-6 text-sm">
          <p>Tickets are numbered <span className="font-mono">ALT-SUP-000001</span>, <span className="font-mono">ALT-SUP-000002</span>, … automatically when they are created. Numbers are never reused.</p>
          <p>Support customers are numbered <span className="font-mono">SC-000001</span>, … The ERP customer code is shown beside it when the customer is linked to an ERP customer.</p>
        </CardContent></Card>
      )}
    </>
  )
}

function useSave() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, done: () => void) => {
    setBusy(true); setError(null)
    try { await fn(); done() } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return { error, setError, busy, run }
}

function AgentsTab({ canEdit }: { canEdit: boolean }) {
  const [refresh, setRefresh] = useState(0)
  const agents = useAsync(fetchAgents, [refresh])
  const [open, setOpen] = useState<Agent | 'new' | null>(null)
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex flex-row items-start justify-between gap-2 border-b px-4 py-3">
        <div><CardTitle>Agents</CardTitle><CardDescription>ERP users who handle support. Their role must include support access; presence is set by each agent.</CardDescription></div>
        {canEdit && <Button size="sm" onClick={() => setOpen('new')}><Plus /> Add agent</Button>}
      </CardHeader>
      {agents.loading && !agents.data ? <LoadingState rows={4} /> : agents.error ? <ErrorState message={describeDataError(agents.error)} onRetry={agents.reload} />
        : !agents.data?.length ? <EmptyState compact icon={Plus} title="No agents yet" description="Add the users who answer customers." />
        : (
          <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Agent</TableHead><TableHead>Department</TableHead><TableHead>Presence</TableHead>
            <TableHead className="text-right">Capacity</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{agents.data.map((a) => (
              <TableRow key={a.id}><TableCell className="font-medium">{a.display_name}</TableCell><TableCell>{a.department ?? '—'}</TableCell>
                <TableCell>{PRESENCE_META[a.presence].label}</TableCell><TableCell className="text-right tabular-nums">{a.max_open_conversations}</TableCell>
                <TableCell><StatusBadge label={a.is_active ? 'Active' : 'Inactive'} tone={a.is_active ? 'success' : 'neutral'} /></TableCell>
                <TableCell>{canEdit && <Button size="sm" variant="ghost" aria-label={`Edit ${a.display_name}`} onClick={() => setOpen(a)}><Pencil /></Button>}</TableCell></TableRow>
            ))}</TableBody></Table>
        )}
      {open && <AgentDialog agent={open} onOpenChange={(o) => { if (!o) setOpen(null) }} onSaved={() => setRefresh((n) => n + 1)} existingUserIds={(agents.data ?? []).map((a) => a.user_id)} />}
    </Card>
  )
}

function AgentDialog({ agent, onOpenChange, onSaved, existingUserIds }: { agent: Agent | 'new'; onOpenChange: (o: boolean) => void; onSaved: () => void; existingUserIds: string[] }) {
  const existing = agent !== 'new' ? agent : null
  const users = useAsync(() => (agent === 'new' ? fetchCompanyUsers() : Promise.resolve([])), [agent])
  const [v, setV] = useState(() => existing ? { user_id: existing.user_id, display_name: existing.display_name, department: existing.department ?? '',
    capacity: String(existing.max_open_conversations), is_active: existing.is_active } : { user_id: '', display_name: '', department: '', capacity: '25', is_active: true })
  const s = useSave()
  const available = (users.data ?? []).filter((u) => !existingUserIds.includes(u.id))
  const submit = () => {
    if (!existing && !v.user_id) { s.setError('Choose the user.'); return }
    if (!v.display_name.trim()) { s.setError('Enter the display name.'); return }
    if (!/^\d{1,3}$/.test(v.capacity) || Number(v.capacity) < 1) { s.setError('Capacity is a whole number from 1 to 500.'); return }
    void s.run(() => saveAgent(existing?.id ?? null, { user_id: existing ? undefined : v.user_id, display_name: v.display_name.trim(), department: v.department.trim() || null,
      max_open_conversations: Number(v.capacity), is_active: v.is_active }), () => { onSaved(); onOpenChange(false) })
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{existing ? 'Edit agent' : 'Add agent'}</DialogTitle><DialogDescription>Agents sign in with their normal ERP account.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          {!existing && (
            <Field label="User" htmlFor="ag-user" hint={users.error ? 'Listing users needs Users & Roles access.' : undefined}>
              <Select value={v.user_id || 'none'} onValueChange={(x) => { const u = available.find((y) => y.id === x); setV((s2) => ({ ...s2, user_id: x === 'none' ? '' : x, display_name: s2.display_name || u?.full_name || u?.email || '' })) }}>
                <SelectTrigger id="ag-user"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Choose a user</SelectItem>{available.map((u) => <SelectItem key={u.id} value={u.id}>{u.full_name ?? u.email} ({u.email})</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Display name" htmlFor="ag-name"><Input id="ag-name" value={v.display_name} onChange={(e) => setV((x) => ({ ...x, display_name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Department" htmlFor="ag-dept"><Input id="ag-dept" value={v.department} onChange={(e) => setV((x) => ({ ...x, department: e.target.value }))} maxLength={80} /></Field>
          <Field label="Maximum open conversations" htmlFor="ag-cap"><Input id="ag-cap" value={v.capacity} onChange={(e) => setV((x) => ({ ...x, capacity: e.target.value }))} inputMode="numeric" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s2) => ({ ...s2, is_active: x === true }))} />Active</label>
          {s.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={s.busy}>{s.busy && <Loader2 className="animate-spin" />}Save agent</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SlaTab({ canEdit }: { canEdit: boolean }) {
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(fetchSlaPolicies, [refresh])
  const [open, setOpen] = useState<SlaPolicy | 'new' | null>(null)
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="flex flex-row items-start justify-between gap-2 border-b px-4 py-3">
        <div><CardTitle>SLA policies</CardTitle><CardDescription>Targets per priority; the policy without a priority is the default. New targets apply to tickets created afterwards.</CardDescription></div>
        {canEdit && <Button size="sm" onClick={() => setOpen('new')}><Plus /> Add policy</Button>}
      </CardHeader>
      {list.loading && !list.data ? <LoadingState rows={3} /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        : !list.data?.length ? <EmptyState compact icon={Plus} title="No SLA policies" description="Tickets have no due dates until a policy exists." />
        : (
          <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Policy</TableHead><TableHead>Priority</TableHead><TableHead>First response</TableHead><TableHead>Resolution</TableHead>
            <TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{list.data.map((p) => (
              <TableRow key={p.id}><TableCell className="font-medium">{p.name}</TableCell><TableCell>{p.priority ? PRIORITY_META[p.priority].label : 'Default'}</TableCell>
                <TableCell>{formatMinutes(p.first_response_minutes)}</TableCell><TableCell>{formatMinutes(p.resolution_minutes)}</TableCell>
                <TableCell><StatusBadge label={p.is_active ? 'Active' : 'Inactive'} tone={p.is_active ? 'success' : 'neutral'} /></TableCell>
                <TableCell>{canEdit && <Button size="sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setOpen(p)}><Pencil /></Button>}</TableCell></TableRow>
            ))}</TableBody></Table>
        )}
      {open && <SlaDialog policy={open} onOpenChange={(o) => { if (!o) setOpen(null) }} onSaved={() => setRefresh((n) => n + 1)} />}
    </Card>
  )
}

function SlaDialog({ policy, onOpenChange, onSaved }: { policy: SlaPolicy | 'new'; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const existing = policy !== 'new' ? policy : null
  const [v, setV] = useState(() => existing ? { name: existing.name, priority: existing.priority ?? 'default', first: String(existing.first_response_minutes),
    resolution: String(existing.resolution_minutes), is_active: existing.is_active } : { name: '', priority: 'default', first: '60', resolution: '1440', is_active: true })
  const s = useSave()
  const submit = () => {
    const first = Number(v.first)
    const res = Number(v.resolution)
    if (!v.name.trim()) { s.setError('Enter a policy name.'); return }
    if (!Number.isInteger(first) || !Number.isInteger(res) || first < 1 || res < 1) { s.setError('Targets are whole numbers of minutes.'); return }
    if (first > res) { s.setError('The first-response target cannot be longer than the resolution target.'); return }
    void s.run(() => saveSlaPolicy(existing?.id ?? null, { name: v.name.trim(), priority: v.priority === 'default' ? null : (v.priority as Priority),
      first_response_minutes: first, resolution_minutes: res, is_active: v.is_active }), () => { onSaved(); onOpenChange(false) })
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{existing ? 'Edit SLA policy' : 'Add SLA policy'}</DialogTitle><DialogDescription>Targets run around the clock (24 × 7).</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          <Field label="Name" htmlFor="sla-name"><Input id="sla-name" value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Priority" htmlFor="sla-priority">
            <Select value={v.priority} onValueChange={(x) => setV((s2) => ({ ...s2, priority: x }))}>
              <SelectTrigger id="sla-priority"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="default">Default (all other priorities)</SelectItem>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="First response (minutes)" htmlFor="sla-first" hint={formatMinutes(Number(v.first) || null)}><Input id="sla-first" value={v.first} onChange={(e) => setV((x) => ({ ...x, first: e.target.value }))} inputMode="numeric" /></Field>
          <Field label="Resolution (minutes)" htmlFor="sla-res" hint={formatMinutes(Number(v.resolution) || null)}><Input id="sla-res" value={v.resolution} onChange={(e) => setV((x) => ({ ...x, resolution: e.target.value }))} inputMode="numeric" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s2) => ({ ...s2, is_active: x === true }))} />Active</label>
          {s.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={s.busy}>{s.busy && <Loader2 className="animate-spin" />}Save policy</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TagsTab({ canEdit }: { canEdit: boolean }) {
  const [refresh, setRefresh] = useState(0)
  const tags = useAsync(fetchTags, [refresh])
  const [editing, setEditing] = useState<TagRef | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('neutral')
  const s = useSave()
  return (
    <Card>
      <CardHeader><div><CardTitle>Tags</CardTitle><CardDescription>Labels agents add to conversations.</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        {tags.loading && !tags.data ? <LoadingState rows={2} /> : tags.error ? <ErrorState message={describeDataError(tags.error)} onRetry={tags.reload} />
          : !tags.data?.length ? <p className="text-sm text-muted-foreground">No tags yet.</p> : (
            <ul className="flex flex-wrap gap-2">{tags.data.map((t) => (
              <li key={t.id} className="flex items-center gap-1 rounded-md border px-2 py-1"><StatusBadge label={t.name} tone={t.color as never} />
                {canEdit && <><Button size="sm" variant="ghost" className="h-6 px-1" aria-label={`Edit ${t.name}`} onClick={() => { setEditing(t); setName(t.name); setColor(t.color) }}><Pencil className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-6 px-1" aria-label={`Delete ${t.name}`} onClick={() => void s.run(() => deleteTag(t.id), () => setRefresh((n) => n + 1))}><Trash2 className="size-3.5" /></Button></>}</li>
            ))}</ul>
          )}
        {canEdit && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { s.setError('Enter a tag name.'); return }
            void s.run(() => saveTag(editing?.id ?? null, name.trim(), color), () => { setEditing(null); setName(''); setRefresh((n) => n + 1) }) }}>
            <Field label={editing ? `Rename “${editing.name}”` : 'New tag'} htmlFor="tag-name"><Input id="tag-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
            <Field label="Colour" htmlFor="tag-color">
              <Select value={color} onValueChange={setColor}><SelectTrigger id="tag-color" className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>{TAG_COLORS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
            </Field>
            <Button type="submit" disabled={s.busy}>{editing ? 'Save' : 'Add tag'}</Button>
            {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setName(''); setColor('neutral') }}>Cancel</Button>}
          </form>
        )}
        {s.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
      </CardContent>
    </Card>
  )
}

function ChannelsTab() {
  const [refresh, setRefresh] = useState(0)
  const accounts = useAsync(fetchChannelAccounts, [refresh])
  const events = useAsync(fetchIntegrationEvents, [refresh])
  const [open, setOpen] = useState<ChannelAccount | 'new' | null>(null)
  return (
    <div className="space-y-4">
      <Card className="gap-0 overflow-hidden p-0">
        <CardHeader className="flex flex-row items-start justify-between gap-2 border-b px-4 py-3">
          <div><CardTitle>Channel integrations</CardTitle>
            <CardDescription>The status is reported by the server-side connection check; it is never set from this page. Credentials are kept as server-side secrets — only the secret’s name is entered here.</CardDescription></div>
          <Button size="sm" onClick={() => setOpen('new')}><Plus /> Add channel account</Button>
        </CardHeader>
        {accounts.loading && !accounts.data ? <LoadingState rows={3} /> : accounts.error ? <ErrorState message={describeDataError(accounts.error)} onRetry={accounts.reload} />
          : !accounts.data?.length ? <EmptyState compact icon={Plus} title="No channel accounts" description="Phone, WhatsApp and email show Not Connected until an account is set up and verified." />
          : (
            <Table data-testid="channel-accounts"><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Channel</TableHead><TableHead>Account</TableHead><TableHead>Identifier</TableHead>
              <TableHead>Secret name</TableHead><TableHead>Status</TableHead><TableHead>Last check</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{accounts.data.map((a) => (
                <TableRow key={a.id}><TableCell><ChannelLabel channel={a.channel} /></TableCell><TableCell className="font-medium">{a.display_name}{!a.is_active && ' (inactive)'}
                  {a.provider && <span className="block text-xs font-normal text-muted-foreground">{a.provider}</span>}</TableCell>
                  <TableCell>{a.identifier ?? '—'}</TableCell><TableCell className="font-mono text-xs">{a.credentials_ref ?? '—'}</TableCell>
                  <TableCell><IntegrationBadge status={a.status} />{a.status_detail && <span className="block text-xs text-muted-foreground">{a.status_detail}</span>}</TableCell>
                  <TableCell className="text-xs">{a.last_checked_at ? formatDateTime(a.last_checked_at) : 'Never checked'}</TableCell>
                  <TableCell><Button size="sm" variant="ghost" aria-label={`Edit ${a.display_name}`} onClick={() => setOpen(a)}><Pencil /></Button></TableCell></TableRow>
              ))}</TableBody></Table>
          )}
      </Card>
      <Card>
        <CardHeader><CardTitle>Integration events</CardTitle></CardHeader>
        <CardContent>{!events.data?.length ? <p className="text-sm text-muted-foreground">No events yet.</p> : (
          <ul className="divide-y text-sm">{events.data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5"><span className="font-medium">{e.event_type.replace(/_/g, ' ').toLowerCase()}</span>
              {e.status && <IntegrationBadge status={e.status} />}<span className="min-w-0 flex-1 truncate text-muted-foreground">{e.message}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span></li>
          ))}</ul>)}</CardContent>
      </Card>
      {open && <AccountDialog account={open} onOpenChange={(o) => { if (!o) setOpen(null) }} onSaved={() => setRefresh((n) => n + 1)} />}
    </div>
  )
}

function AccountDialog({ account, onOpenChange, onSaved }: { account: ChannelAccount | 'new'; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const existing = account !== 'new' ? account : null
  const [v, setV] = useState(() => existing ? { channel: existing.channel, display_name: existing.display_name, identifier: existing.identifier ?? '', provider: existing.provider ?? '',
    credentials_ref: existing.credentials_ref ?? '', is_active: existing.is_active } : { channel: 'WHATSAPP' as Channel, display_name: '', identifier: '', provider: '', credentials_ref: '', is_active: true })
  const s = useSave()
  const submit = () => {
    if (!v.display_name.trim()) { s.setError('Enter a name for the account.'); return }
    if (v.credentials_ref.trim() && !/^[A-Za-z][A-Za-z0-9_]{2,79}$/.test(v.credentials_ref.trim())) { s.setError('Enter the NAME of the server-side secret (letters, digits and _), never the secret itself.'); return }
    void s.run(() => saveChannelAccount(existing?.id ?? null, { channel: existing ? undefined : v.channel, display_name: v.display_name.trim(), identifier: v.identifier.trim() || null,
      provider: v.provider.trim() || null, credentials_ref: v.credentials_ref.trim().toUpperCase() || null, is_active: v.is_active }), () => { onSaved(); onOpenChange(false) })
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{existing ? 'Edit channel account' : 'Add channel account'}</DialogTitle>
          <DialogDescription>Saving never connects the channel. It shows Setup Required until the server-side check confirms the connection.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          {!existing && (
            <Field label="Channel" htmlFor="ca-channel">
              <Select value={v.channel} onValueChange={(x) => setV((s2) => ({ ...s2, channel: x as Channel }))}>
                <SelectTrigger id="ca-channel"><SelectValue /></SelectTrigger>
                <SelectContent>{CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Name" htmlFor="ca-name"><Input id="ca-name" value={v.display_name} onChange={(e) => setV((x) => ({ ...x, display_name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Number or address" htmlFor="ca-ident" hint="The WhatsApp number, support mailbox or phone line. Not a secret."><Input id="ca-ident" value={v.identifier} onChange={(e) => setV((x) => ({ ...x, identifier: e.target.value }))} maxLength={200} /></Field>
          <Field label="Provider" htmlFor="ca-provider"><Input id="ca-provider" value={v.provider} onChange={(e) => setV((x) => ({ ...x, provider: e.target.value }))} maxLength={60} placeholder="e.g. WhatsApp Cloud API" /></Field>
          <Field label="Server-side secret name" htmlFor="ca-ref" hint="The name of the secret stored on the server (e.g. WHATSAPP_CLOUD_TOKEN). Never paste a token here.">
            <Input id="ca-ref" value={v.credentials_ref} onChange={(e) => setV((x) => ({ ...x, credentials_ref: e.target.value }))} maxLength={80} autoComplete="off" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s2) => ({ ...s2, is_active: x === true }))} />Active</label>
          {s.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={s.busy}>{s.busy && <Loader2 className="animate-spin" />}Save account</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
