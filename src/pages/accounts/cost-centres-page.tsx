import { Loader2, Network, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  COST_CENTRE_TYPES, COST_CENTRE_TYPE_LABELS, buildCostCentreTree, flattenCostCentreTree, type CostCentre, type CostCentreType,
} from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { deleteCostCentre, fetchCostCentres, saveCostCentre } from '@/services/accounting'

export default function CostCentresPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{() => <Master />}</SetupGate>
}

const payload = (c: CostCentre, patch: Partial<CostCentre> = {}) => {
  const x = { ...c, ...patch }
  return { cost_centre_name: x.cost_centre_name, description: x.description, parent_cost_centre_id: x.parent_cost_centre_id, cost_centre_type: x.cost_centre_type,
    effective_from: x.effective_from ?? null, effective_to: x.effective_to ?? null, is_active: x.is_active }
}

function Master() {
  const { has } = usePermissions()
  const manage = has('accounts.manage')
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [state, setState] = useState('all')
  const [edit, setEdit] = useState<CostCentre | 'new' | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const list = useAsync(() => fetchCostCentres(), [refresh])
  const all = useMemo(() => list.data ?? [], [list.data])
  const flat = useMemo(() => flattenCostCentreTree(buildCostCentreTree(all)), [all])
  const term = search.trim().toLowerCase()
  const shown = flat.filter(({ centre: c }) => (type === 'all' || c.cost_centre_type === type) && (state === 'all' || (state === 'active') === c.is_active)
    && (!term || `${c.cost_centre_code} ${c.cost_centre_name} ${c.description ?? ''}`.toLowerCase().includes(term)))
  const byId = new Map(all.map((c) => [c.id, c]))
  const done = (m: string) => { setEdit(null); setAction(null); setMessage(m); setRefresh((n) => n + 1) }

  return (
    <>
      <PageHeader actions={<>
        <AccountingExport title="Cost centres" fileStem="cost-centres" rows={flat.map((n) => n.centre)} columns={[
          { header: 'Code', value: (c) => c.cost_centre_code }, { header: 'Name', value: (c) => c.cost_centre_name },
          { header: 'Type', value: (c) => (c.cost_centre_type ? COST_CENTRE_TYPE_LABELS[c.cost_centre_type] : null) },
          { header: 'Parent', value: (c) => (c.parent_cost_centre_id ? byId.get(c.parent_cost_centre_id)?.cost_centre_code ?? null : null) },
          { header: 'Effective from', value: (c) => c.effective_from ?? null }, { header: 'Effective to', value: (c) => c.effective_to ?? null },
          { header: 'Active', value: (c) => (c.is_active ? 'Yes' : 'No') }, { header: 'Description', value: (c) => c.description },
        ]} />
        {manage && <Button onClick={() => setEdit('new')}><Plus /> New cost centre</Button>}
      </>} />
      <AccountingNotice>Cost centres analyse posted vouchers; they never change account balances. Budgets and reports are under <Link className="underline" to="/accounts/cost-centres/budgets">Cost Centre Budgets</Link> and <Link className="underline" to="/accounts/cost-centres/reports">Cost Centre Reports</Link>.</AccountingNotice>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="cc-search">Search</Label><Input id="cc-search" className="w-64" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code, name or description" /></div>
          <div className="space-y-1"><Label htmlFor="cc-type">Type</Label>
            <Select value={type} onValueChange={setType}><SelectTrigger id="cc-type" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem>{COST_CENTRE_TYPES.map((t) => <SelectItem key={t} value={t}>{COST_CENTRE_TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="cc-state">Status</Label>
            <Select value={state} onValueChange={setState}><SelectTrigger id="cc-state" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent></Select></div>
        </CardContent>
      </Card>
      {list.loading ? <LoadingState variant="table" /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        : !all.length ? <EmptyState icon={Network} title="No cost centres yet" description="Create departments, production lines, branches or projects to analyse income and expenses." />
          : (
            <Card><CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Cost centre</TableHead><TableHead>Type</TableHead><TableHead>Effective</TableHead><TableHead>Status</TableHead>
                  <TableHead className="text-right">Used on</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{shown.map(({ centre: c, depth }) => (
                  <TableRow key={c.id} className={cn(!c.is_active && 'opacity-60')}>
                    <TableCell><span style={{ paddingLeft: depth * 18 }} className="inline-block"><span className="mr-2 font-mono text-xs text-muted-foreground">{c.cost_centre_code}</span>
                      <span className="font-medium">{c.cost_centre_name}</span>{c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}</span></TableCell>
                    <TableCell className="text-sm">{c.cost_centre_type ? COST_CENTRE_TYPE_LABELS[c.cost_centre_type] : '—'}</TableCell>
                    <TableCell className="text-xs">{c.effective_from || c.effective_to ? `${c.effective_from ? formatDate(c.effective_from) : 'always'} – ${c.effective_to ? formatDate(c.effective_to) : 'open'}` : 'Always'}</TableCell>
                    <TableCell><StatusBadge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'success' : 'neutral'} /></TableCell>
                    <TableCell className="text-right text-xs">{c.posted_allocation_count ?? 0} posted · {c.budget_line_count ?? 0} budget lines</TableCell>
                    <TableCell className="text-right">{manage && <span className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEdit(c)}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => setAction({
                        title: `${c.is_active ? 'Deactivate' : 'Activate'} ${c.cost_centre_code}`,
                        description: c.is_active ? 'It can no longer be used on new vouchers or budgets. Posted allocations stay. Sub-centres must be deactivated first.' : 'It can be used again.',
                        confirmLabel: c.is_active ? 'Deactivate' : 'Activate', note: 'none', destructive: c.is_active,
                        run: async () => { await saveCostCentre(c.id, payload(c, { is_active: !c.is_active })); return `${c.cost_centre_code} ${c.is_active ? 'deactivated' : 'activated'}.` },
                      })}>{c.is_active ? 'Deactivate' : 'Activate'}</Button>
                      {!(c.allocation_count ?? 0) && !(c.budget_line_count ?? 0) && !(c.child_count ?? 0) && <Button variant="ghost" size="sm" className="text-shortage" onClick={() => setAction({
                        title: `Delete ${c.cost_centre_code}`, description: 'Only a cost centre that was never used can be deleted.', confirmLabel: 'Delete', note: 'none', destructive: true,
                        run: async () => { await deleteCostCentre(c.id); return `${c.cost_centre_code} deleted.` },
                      })}>Delete</Button>}
                    </span>}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
              {!shown.length && <p className="p-4 text-sm text-muted-foreground">No cost centres match the filters.</p>}
            </CardContent></Card>
          )}
      {edit && <CostCentreDialog centre={edit === 'new' ? null : edit} all={all} onClose={() => setEdit(null)} onSaved={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}

function CostCentreDialog({ centre, all, onClose, onSaved }: { centre: CostCentre | null; all: CostCentre[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [code, setCode] = useState(centre?.cost_centre_code ?? '')
  const [name, setName] = useState(centre?.cost_centre_name ?? '')
  const [type, setType] = useState<CostCentreType>(centre?.cost_centre_type ?? 'DEPARTMENT')
  const [parent, setParent] = useState(centre?.parent_cost_centre_id ?? '')
  const [from, setFrom] = useState(centre?.effective_from ?? '')
  const [to, setTo] = useState(centre?.effective_to ?? '')
  const [description, setDescription] = useState(centre?.description ?? '')
  const [active, setActive] = useState(centre?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const datesBad = Boolean(from && to && to < from)
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await saveCostCentre(centre?.id ?? null, { cost_centre_code: code.trim().toUpperCase(), cost_centre_name: name.trim(), cost_centre_type: type, parent_cost_centre_id: parent || null,
        effective_from: from || null, effective_to: to || null, description: description.trim() || null, is_active: active })
      onSaved(centre ? `${centre.cost_centre_code} saved.` : `${code.trim().toUpperCase()} created.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{centre ? `Edit ${centre.cost_centre_code}` : 'New cost centre'}</DialogTitle>
          <DialogDescription>The code is fixed once created. A cost centre cannot be placed under itself or one of its own sub-centres.</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="ccd-code">Code</Label><Input id="ccd-code" value={code} disabled={Boolean(centre)} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div>
          <div className="space-y-1"><Label htmlFor="ccd-name">Name</Label><Input id="ccd-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ccd-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as CostCentreType)}><SelectTrigger id="ccd-type"><SelectValue /></SelectTrigger>
              <SelectContent>{COST_CENTRE_TYPES.map((t) => <SelectItem key={t} value={t}>{COST_CENTRE_TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="ccd-parent">Parent</Label>
            <CostCentreSelect id="ccd-parent" value={parent} onChange={setParent} centres={all.filter((c) => c.id !== centre?.id)} allowClear placeholder="None (top level)" /></div>
          <div className="space-y-1"><Label htmlFor="ccd-from">Effective from</Label><Input id="ccd-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ccd-to">Effective to (optional)</Label><Input id="ccd-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ccd-desc">Description</Label><Textarea id="ccd-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} /> Active</label>
        </div>
        {datesBad && <p className="text-sm text-red-700">The end date cannot be before the start date.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || name.trim().length < 2 || (!centre && !/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(code.trim())) || datesBad}>
            {busy && <Loader2 className="animate-spin" />} Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
