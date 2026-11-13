import { Loader2, Pencil, Plus, Workflow } from 'lucide-react'
import { useState } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CHANNEL_LABELS, PRIORITIES, PRIORITY_META, type TicketChannel } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber } from '@/lib/format'
import { fetchAgents, fetchAutomationRules, fetchTags, saveAutomationRule, type Agent, type AutomationRule, type TagRef } from '@/services/support'

const TRIGGER_LABELS = { TICKET_CREATED: 'When a ticket is created', CONVERSATION_CREATED: 'When a conversation is created' } as const
const ANY = 'any'

function describeRule(r: AutomationRule, agents: Agent[], tags: TagRef[]): { when: string; then: string } {
  const c = r.conditions
  const when = [c.channel && `channel is ${CHANNEL_LABELS[c.channel as TicketChannel] ?? c.channel}`, c.priority && `priority is ${PRIORITY_META[c.priority as keyof typeof PRIORITY_META]?.label}`,
    c.category && `category is “${c.category}”`, c.subject_contains && `subject contains “${c.subject_contains}”`].filter(Boolean).join(' and ') || 'always'
  const a = r.actions
  const then = [a.set_priority && `set priority to ${PRIORITY_META[a.set_priority as keyof typeof PRIORITY_META]?.label}`, a.set_department && `set department to “${a.set_department}”`,
    a.assign_agent_id && `assign to ${agents.find((x) => x.id === a.assign_agent_id)?.display_name ?? 'an agent'}`, a.add_tag_id && `add tag ${tags.find((t) => t.id === a.add_tag_id)?.name ?? ''}`]
    .filter(Boolean).join(', ')
  return { when, then }
}

/** /support/automation — rules applied when tickets or conversations are created (run in the database, in order). */
export default function SupportAutomationPage() {
  const perms = useSupportPermissions()
  const [refresh, setRefresh] = useState(0)
  const rules = useAsync(fetchAutomationRules, [refresh])
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const tags = useAsync(() => fetchTags().catch(() => []), [])
  const [open, setOpen] = useState<AutomationRule | 'new' | null>(null)
  return (
    <>
      <PageHeader actions={perms.settings && <Button onClick={() => setOpen('new')}><Plus /> New rule</Button>} />
      <p className="mb-4 text-sm text-muted-foreground">Rules run in the database when a ticket or conversation is created, in run order; every condition of a rule must match. Each run is recorded on the ticket's history.</p>
      <Card className="gap-0 overflow-hidden p-0">
        {rules.loading && !rules.data ? <LoadingState rows={5} />
          : rules.error ? <ErrorState message={describeDataError(rules.error)} onRetry={rules.reload} />
          : !rules.data || rules.data.length === 0 ? <EmptyState icon={Workflow} title="No automation rules" description={perms.settings ? 'Create a rule to route or prioritise new work automatically.' : 'No rules are set up.'} />
          : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Order</TableHead><TableHead>Rule</TableHead><TableHead>When</TableHead><TableHead>Then</TableHead>
                  <TableHead>Status</TableHead><TableHead className="text-right">Runs</TableHead><TableHead>Last run</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{rules.data.map((r) => {
                  const d = describeRule(r, agents.data ?? [], tags.data ?? [])
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="tabular-nums">{r.run_order}</TableCell>
                      <TableCell className="font-medium">{r.name}<span className="block text-xs font-normal text-muted-foreground">{TRIGGER_LABELS[r.trigger]}</span></TableCell>
                      <TableCell className="text-sm">{d.when}</TableCell><TableCell className="text-sm">{d.then}</TableCell>
                      <TableCell><StatusBadge label={r.is_active ? 'Active' : 'Paused'} tone={r.is_active ? 'success' : 'neutral'} /></TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.run_count)}</TableCell>
                      <TableCell className="text-xs">{r.last_run_at ? formatDateTime(r.last_run_at) : 'Never'}</TableCell>
                      <TableCell>{perms.settings && <Button size="sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setOpen(r)}><Pencil /></Button>}</TableCell>
                    </TableRow>
                  )
                })}</TableBody>
              </Table>
            </div>
          )}
      </Card>
      {open && <RuleDialog rule={open} agents={agents.data ?? []} tags={tags.data ?? []} onOpenChange={(o) => { if (!o) setOpen(null) }} onSaved={() => setRefresh((n) => n + 1)} />}
    </>
  )
}

function RuleDialog({ rule, agents, tags, onOpenChange, onSaved }: { rule: AutomationRule | 'new'; agents: Agent[]; tags: TagRef[]; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const existing = rule !== 'new' ? rule : null
  const blank = { name: '', trigger: 'TICKET_CREATED' as AutomationRule['trigger'], channel: ANY, priority: ANY, category: '', subject_contains: '',
    set_priority: ANY, set_department: '', assign_agent_id: ANY, add_tag_id: ANY, run_order: '100', is_active: true }
  const [v, setV] = useState(() => existing ? { name: existing.name, trigger: existing.trigger, channel: existing.conditions.channel ?? ANY, priority: existing.conditions.priority ?? ANY,
    category: existing.conditions.category ?? '', subject_contains: existing.conditions.subject_contains ?? '', set_priority: existing.actions.set_priority ?? ANY,
    set_department: existing.actions.set_department ?? '', assign_agent_id: existing.actions.assign_agent_id ?? ANY, add_tag_id: existing.actions.add_tag_id ?? ANY,
    run_order: String(existing.run_order), is_active: existing.is_active } : blank)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = (x: string) => (x === ANY ? '' : x)
  const save = async () => {
    const actions = { set_priority: pick(v.set_priority), set_department: v.trigger === 'TICKET_CREATED' ? v.set_department.trim() : '', assign_agent_id: pick(v.assign_agent_id),
      add_tag_id: v.trigger === 'CONVERSATION_CREATED' ? pick(v.add_tag_id) : '' }
    if (!v.name.trim()) { setError('Enter a rule name.'); return }
    if (!Object.values(actions).some(Boolean)) { setError('Choose at least one action.'); return }
    if (!/^\d{1,5}$/.test(v.run_order) || Number(v.run_order) < 1) { setError('Run order is a whole number from 1.'); return }
    setBusy(true); setError(null)
    try {
      await saveAutomationRule(existing?.id ?? null, { name: v.name.trim(), trigger: v.trigger, run_order: Number(v.run_order), is_active: v.is_active,
        conditions: Object.fromEntries(Object.entries({ channel: pick(v.channel), priority: pick(v.priority), category: v.category.trim(), subject_contains: v.subject_contains.trim() }).filter(([, x]) => x)),
        actions: Object.fromEntries(Object.entries(actions).filter(([, x]) => x)) })
      onSaved(); onOpenChange(false)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const sel = (k: keyof typeof v, label: string, options: [string, string][], anyLabel = 'Any') => (
    <Field label={label} htmlFor={`ar-${k}`}>
      <Select value={String(v[k])} onValueChange={(x) => setV((s) => ({ ...s, [k]: x }))}>
        <SelectTrigger id={`ar-${k}`}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ANY}>{anyLabel}</SelectItem>{options.map(([a, b]) => <SelectItem key={a} value={a}>{b}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  )
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{existing ? 'Edit rule' : 'New automation rule'}</DialogTitle><DialogDescription>Conditions left as “Any” are not checked.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <Field label="Name" htmlFor="ar-name" className="sm:col-span-2"><Input id="ar-name" value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Runs" htmlFor="ar-trigger">
            <Select value={v.trigger} onValueChange={(x) => setV((s) => ({ ...s, trigger: x as AutomationRule['trigger'] }))}>
              <SelectTrigger id="ar-trigger"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(TRIGGER_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Run order" htmlFor="ar-order"><Input id="ar-order" value={v.run_order} onChange={(e) => setV((s) => ({ ...s, run_order: e.target.value }))} inputMode="numeric" /></Field>
          <p className="text-xs font-medium text-muted-foreground sm:col-span-2">Conditions</p>
          {sel('channel', 'Channel', (['PHONE', 'WHATSAPP', 'EMAIL', ...(v.trigger === 'TICKET_CREATED' ? ['MANUAL'] : [])] as TicketChannel[]).map((c) => [c, CHANNEL_LABELS[c]]))}
          {sel('priority', 'Priority', PRIORITIES.map((p) => [p, PRIORITY_META[p].label]))}
          {v.trigger === 'TICKET_CREATED' && <Field label="Category is" htmlFor="ar-category"><Input id="ar-category" value={v.category} onChange={(e) => setV((s) => ({ ...s, category: e.target.value }))} maxLength={80} /></Field>}
          <Field label="Subject contains" htmlFor="ar-subject"><Input id="ar-subject" value={v.subject_contains} onChange={(e) => setV((s) => ({ ...s, subject_contains: e.target.value }))} maxLength={120} /></Field>
          <p className="text-xs font-medium text-muted-foreground sm:col-span-2">Actions</p>
          {sel('set_priority', 'Set priority', PRIORITIES.map((p) => [p, PRIORITY_META[p].label]), 'Keep')}
          {sel('assign_agent_id', 'Assign to', agents.filter((a) => a.is_active).map((a) => [a.id, a.display_name]), 'Keep')}
          {v.trigger === 'TICKET_CREATED'
            ? <Field label="Set department" htmlFor="ar-dept"><Input id="ar-dept" value={v.set_department} onChange={(e) => setV((s) => ({ ...s, set_department: e.target.value }))} maxLength={80} /></Field>
            : sel('add_tag_id', 'Add tag', tags.map((t) => [t.id, t.name]), 'None')}
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s) => ({ ...s, is_active: x === true }))} />Active</label>
          {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save rule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
