import { CheckCircle2, ClipboardCheck, Loader2, Plus, Send, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ROLE_CODES, ROLE_LABELS } from '@/auth/permissions'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { APPROVAL_DOC_LABELS, APPROVAL_DOC_TYPES, APPROVAL_GATED_ACTION, FINANCIAL_TYPES, REQUEST_STATUS_TONE } from '@/features/admin/approval-labels'
import { NOTIFICATIONS_CHANGED } from '@/features/admin/notification-labels'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  cancelApprovalRequest, decideApproval, fetchApprovalInbox, fetchWorkflows, saveWorkflow, searchApprovalDocuments, setWorkflowActive, submitForApproval,
  type ApprovalDocType, type ApprovalRequestItem, type Workflow, type WorkflowStage,
} from '@/services/admin'

type Tab = 'TO_DECIDE' | 'MINE' | 'ALL' | 'MODULE' | 'WORKFLOWS'
const money = (v: number | null) => (v === null ? null : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(v)))

function RequestRow({ r, highlight, onDecide, onCancel }: { r: ApprovalRequestItem; highlight: boolean; onDecide: (r: ApprovalRequestItem, d: 'APPROVE' | 'REJECT') => void; onCancel: (r: ApprovalRequestItem) => void }) {
  return (
    <li className={`space-y-2 px-4 py-3 text-sm ${highlight ? 'bg-primary/5' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={r.status === 'PENDING_APPROVAL' ? 'Pending approval' : r.status.charAt(0) + r.status.slice(1).toLowerCase()} tone={REQUEST_STATUS_TONE[r.status] ?? 'neutral'} />
        <span className="font-medium">{APPROVAL_DOC_LABELS[r.document_type]} · {r.link ? <Link className="text-primary hover:underline" to={r.link}>{r.reference}</Link> : r.reference}</span>
        {r.amount !== null && <span>{money(r.amount)}</span>}
        {r.stale && <StatusBadge label="Document changed — will be cancelled on decision" tone="danger" />}
        {r.consumed_at && <span className="text-xs text-green-700">Used {formatDateTime(r.consumed_at)}</span>}
      </div>
      <p className="text-muted-foreground">
        {r.workflow} (v{r.workflow_version}) · stage {r.stage} of {r.stages}{r.status === 'PENDING_APPROVAL' ? ` — ${r.stage_name}: ${r.stage_approvals}/${r.required_approvals} approval(s)` : ''}
        {' · requested by '}{r.requested_by_name ?? 'unknown'} {formatDateTime(r.requested_at)}
      </p>
      {r.comment && <p>“{r.comment}”</p>}
      {r.cancel_reason && <p className="text-muted-foreground">Cancelled: {r.cancel_reason}</p>}
      {r.decisions.length > 0 && (
        <ul className="space-y-0.5 text-xs">{r.decisions.map((d, i) => (
          <li key={i}>{d.decision === 'APPROVE' ? <CheckCircle2 className="inline size-3 text-green-700" /> : <XCircle className="inline size-3 text-shortage" />} Stage {d.stage}: {d.approver} {d.decision === 'APPROVE' ? 'approved' : 'rejected'} {formatDateTime(d.decided_at)}{d.comment ? ` — ${d.comment}` : ''}</li>
        ))}</ul>
      )}
      <div className="flex flex-wrap gap-2">
        {r.can_decide && <><Button size="sm" onClick={() => onDecide(r, 'APPROVE')}><CheckCircle2 /> Approve</Button>
          <Button size="sm" variant="outline" className="text-shortage" onClick={() => onDecide(r, 'REJECT')}><XCircle /> Reject</Button></>}
        {r.status === 'PENDING_APPROVAL' && r.mine && <Button size="sm" variant="ghost" onClick={() => onCancel(r)}>Cancel request</Button>}
        {r.status === 'APPROVED' && !r.consumed_at && r.link && <span className="text-xs text-muted-foreground">Approved — now complete the step ({APPROVAL_GATED_ACTION[r.document_type]}) in the <Link className="text-primary hover:underline" to={r.link}>document</Link>; its own checks still apply.</span>}
      </div>
    </li>
  )
}

function SubmitDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [type, setType] = useState<ApprovalDocType>('INVOICE')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const docs = useAsync(() => searchApprovalDocuments(type, search), [type, search])
  const [docId, setDocId] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setError(null)
    if (!docId) return setError('Choose the document.')
    setBusy(true)
    try {
      const r = await submitForApproval(type, docId, comment.trim() || null)
      onDone(r.status === 'NOT_REQUIRED' ? `${r.reference}: no active workflow applies, so no approval is required.` : `Approval requested for ${r.reference}.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Request approval</DialogTitle>
          <DialogDescription>For documents that are not submitted automatically (e.g. a draft invoice or a payment reversal). The approval does not perform the action; you complete it in the module afterwards.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-3">
          <div className="space-y-1"><Label htmlFor="ap-type">Document type</Label>
            <Select value={type} onValueChange={(v) => { setType(v as ApprovalDocType); setDocId('') }}><SelectTrigger id="ap-type"><SelectValue /></SelectTrigger>
              <SelectContent>{APPROVAL_DOC_TYPES.map((t) => <SelectItem key={t} value={t}>{APPROVAL_DOC_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="ap-search">Find the document</Label><Input id="ap-search" placeholder="Number, customer…" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          <div className="max-h-48 overflow-y-auto rounded-lg border">
            {docs.loading ? <p className="p-3 text-sm text-muted-foreground">Searching…</p> : !docs.data?.length ? <p className="p-3 text-sm text-muted-foreground">No document of this type is awaiting approval or submission.</p>
              : docs.data.map((d) => (
                <label key={d.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-0">
                  <input type="radio" name="ap-doc" checked={docId === d.id} onChange={() => setDocId(d.id)} /> <span className="font-medium">{d.reference}</span> <span className="text-muted-foreground">{d.detail}</span>
                </label>))}
          </div>
          <div className="space-y-1"><Label htmlFor="ap-comment">Comment (optional)</Label><Textarea id="ap-comment" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} <Send /> Submit</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const emptyStage = (): WorkflowStage => ({ name: '', approver_roles: [], approver_user_ids: [], required_approvals: 1 })

function WorkflowDialog({ workflow, onClose, onDone }: { workflow: Workflow | null; onClose: () => void; onDone: (m: string) => void }) {
  const [w, setW] = useState({
    name: workflow?.name ?? '', description: workflow?.description ?? '', document_type: workflow?.document_type ?? ('STOCK_ADJUSTMENT' as ApprovalDocType),
    min_amount: workflow?.min_amount?.toString() ?? '', max_amount: workflow?.max_amount?.toString() ?? '', allow_self_approval: workflow?.allow_self_approval ?? false,
    distinct_stage_approvers: workflow?.distinct_stage_approvers ?? true, require_rejection_reason: workflow?.require_rejection_reason ?? true,
    escalate_after_hours: workflow?.escalate_after_hours?.toString() ?? '', escalate_to_role: workflow?.escalate_to_role ?? '',
  })
  const [stages, setStages] = useState<WorkflowStage[]>(workflow?.stages.length ? workflow.stages.map((s) => ({ ...s })) : [emptyStage()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const financial = FINANCIAL_TYPES.includes(w.document_type)
  const setStage = (i: number, c: Partial<WorkflowStage>) => setStages((s) => s.map((x, j) => (j === i ? { ...x, ...c } : x)))
  const save = async () => {
    setError(null)
    if (w.name.trim().length < 3) return setError('Enter a workflow name (at least 3 characters).')
    if (stages.some((s) => !s.approver_roles.length && !s.approver_user_ids.length)) return setError('Every stage needs at least one approver role.')
    if ((w.escalate_after_hours === '') !== (w.escalate_to_role === '')) return setError('Escalation needs both the hours and the role.')
    setBusy(true)
    try {
      const r = await saveWorkflow({ ...(workflow ? { id: workflow.id } : {}), ...w, min_amount: w.min_amount === '' ? null : Number(w.min_amount), max_amount: w.max_amount === '' ? null : Number(w.max_amount),
        escalate_after_hours: w.escalate_after_hours === '' ? null : Number(w.escalate_after_hours), escalate_to_role: w.escalate_to_role || null },
      stages.map((s, i) => ({ ...s, name: s.name.trim() || `Stage ${i + 1}` })))
      onDone(`Workflow saved (version ${r.version}).${workflow?.is_active ? ' Requests already submitted keep the version they started with.' : ' It is inactive until you switch it on.'}`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{workflow ? `Edit workflow: ${workflow.name}` : 'New approval workflow'}</DialogTitle>
          <DialogDescription>An approval gates the existing module step ({APPROVAL_GATED_ACTION[w.document_type]}); it never performs it. Changes create a new version.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="wf-name">Name</Label><Input id="wf-name" maxLength={120} value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="wf-type">Document type</Label>
            <Select value={w.document_type} onValueChange={(v) => setW({ ...w, document_type: v as ApprovalDocType, allow_self_approval: FINANCIAL_TYPES.includes(v as ApprovalDocType) ? false : w.allow_self_approval })}>
              <SelectTrigger id="wf-type"><SelectValue /></SelectTrigger><SelectContent>{APPROVAL_DOC_TYPES.map((t) => <SelectItem key={t} value={t}>{APPROVAL_DOC_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="wf-min">Applies from amount (₹, optional)</Label><Input id="wf-min" inputMode="decimal" value={w.min_amount} onChange={(e) => setW({ ...w, min_amount: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="wf-max">Up to amount (₹, optional)</Label><Input id="wf-max" inputMode="decimal" value={w.max_amount} onChange={(e) => setW({ ...w, max_amount: e.target.value })} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="wf-desc">Description</Label><Textarea id="wf-desc" rows={2} maxLength={1000} value={w.description} onChange={(e) => setW({ ...w, description: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={w.allow_self_approval} disabled={financial} onCheckedChange={(v) => setW({ ...w, allow_self_approval: v === true })} /> Requester may approve their own request{financial ? ' (not allowed for financial documents)' : ''}</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={w.distinct_stage_approvers} onCheckedChange={(v) => setW({ ...w, distinct_stage_approvers: v === true })} /> A different person for each stage</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={w.require_rejection_reason} onCheckedChange={(v) => setW({ ...w, require_rejection_reason: v === true })} /> Rejection needs a reason</label>
          <div className="flex items-end gap-2">
            <div className="space-y-1"><Label htmlFor="wf-esc">Escalate after (hours)</Label><Input id="wf-esc" className="w-28" inputMode="numeric" value={w.escalate_after_hours} onChange={(e) => setW({ ...w, escalate_after_hours: e.target.value })} /></div>
            <div className="space-y-1"><Label htmlFor="wf-esc-role">to role</Label>
              <Select value={w.escalate_to_role || 'none'} onValueChange={(v) => setW({ ...w, escalate_to_role: v === 'none' ? '' : v })}><SelectTrigger id="wf-esc-role" className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">No escalation</SelectItem>{ROLE_CODES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}</SelectContent></Select></div>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-medium">Stages (in order)</p>
          {stages.map((s, i) => (
            <Card key={i} className="gap-2 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1"><Label htmlFor={`st-name-${i}`}>Stage {i + 1} name</Label><Input id={`st-name-${i}`} className="w-56" value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`st-req-${i}`}>Approvals needed</Label><Input id={`st-req-${i}`} className="w-24" inputMode="numeric" value={s.required_approvals}
                  onChange={(e) => setStage(i, { required_approvals: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></div>
                {stages.length > 1 && <Button variant="ghost" size="sm" onClick={() => setStages(stages.filter((_, j) => j !== i))}>Remove stage</Button>}
              </div>
              <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm"><legend className="mb-1 text-xs text-muted-foreground">Approver roles</legend>
                {ROLE_CODES.map((r) => (
                  <label key={r} className="flex items-center gap-1.5"><Checkbox checked={s.approver_roles.includes(r)}
                    onCheckedChange={(v) => setStage(i, { approver_roles: v === true ? [...s.approver_roles, r] : s.approver_roles.filter((x) => x !== r) })} /> {ROLE_LABELS[r]}</label>
                ))}
              </fieldset>
            </Card>
          ))}
          {stages.length < 5 && <Button variant="outline" size="sm" onClick={() => setStages([...stages, emptyStage()])}><Plus /> Add stage</Button>}
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save workflow</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ApprovalsPage() {
  const { has } = usePermissions()
  const [params] = useSearchParams()
  const highlight = params.get('request')
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || (highlight ? 'ALL' : 'TO_DECIDE'))
  const [refresh, setRefresh] = useState(0)
  const scope = tab === 'MINE' ? 'MINE' : tab === 'ALL' || tab === 'MODULE' ? 'ALL' : 'TO_DECIDE'
  const inbox = useAsync(() => fetchApprovalInbox(scope), [scope, refresh])
  const workflows = useAsync(() => (tab === 'WORKFLOWS' ? fetchWorkflows() : Promise.resolve([] as Workflow[])), [tab, refresh])
  const [decide, setDecide] = useState<{ r: ApprovalRequestItem; d: 'APPROVE' | 'REJECT' } | null>(null)
  const [cancel, setCancel] = useState<ApprovalRequestItem | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null)
  const [toggle, setToggle] = useState<Workflow | null>(null)
  const done = (m: string) => { setMessage(m); setError(null); setRefresh((n) => n + 1); window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)) }

  const runDecision = async () => {
    if (!decide) return
    setBusy(true); setError(null)
    try {
      const r = await decideApproval(decide.r.id, decide.d, text.trim() || null)
      setDecide(null); setText('')
      done(r.stale ? (r.message ?? 'The document changed; the request was cancelled.')
        : r.status === 'APPROVED' ? `${decide.r.reference} approved. The requester can now complete ${APPROVAL_GATED_ACTION[decide.r.document_type]}.`
          : r.status === 'REJECTED' ? `${decide.r.reference} rejected.`
            : `Your approval was recorded (stage ${r.stage}${r.required ? `: ${r.approvals}/${r.required}` : ''}).`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  const requests = inbox.data?.requests ?? []
  return (
    <>
      <PageHeader actions={<Button onClick={() => setSubmitting(true)}><Send /> Request approval</Button>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card className="mb-4"><CardContent className="p-4">
        <FilterTabs<Tab> label="Inbox" value={tab} onChange={setTab} options={[
          { value: 'TO_DECIDE', label: 'Waiting for me' }, { value: 'MINE', label: 'My requests' }, { value: 'ALL', label: 'All requests' },
          { value: 'MODULE', label: 'Module approvals' }, ...(has('approvals.manage') ? [{ value: 'WORKFLOWS' as Tab, label: 'Workflows' }] : [])]} />
      </CardContent></Card>

      {tab === 'WORKFLOWS' ? (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div><CardTitle>Approval workflows</CardTitle><CardDescription>Inactive by default. A document type without an active workflow follows its module's existing rules only.</CardDescription></div>
            <Button size="sm" onClick={() => setEditing('new')}><Plus /> New workflow</Button>
          </CardHeader>
          <CardContent>
            {workflows.loading ? <LoadingState variant="table" rows={3} /> : workflows.error ? <ErrorState message={describeDataError(workflows.error)} onRetry={workflows.reload} />
              : !workflows.data?.length ? <EmptyState icon={ClipboardCheck} title="No workflows" description="Create a workflow to require approvals for a document type." /> : (
                <ul className="divide-y">{workflows.data.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{w.name} <span className="font-normal text-muted-foreground">v{w.version} · {APPROVAL_DOC_LABELS[w.document_type]}</span></p>
                      <p className="text-muted-foreground">{w.min_amount !== null || w.max_amount !== null ? `Amounts ${money(w.min_amount) ?? 'any'} – ${money(w.max_amount) ?? 'any'} · ` : ''}
                        {w.stages.map((s) => `${s.stage_no}. ${s.name} (${s.approver_roles.map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r).join(', ')}${s.required_approvals > 1 ? `, ${s.required_approvals} approvals` : ''})`).join(' → ')}</p>
                      <p className="text-xs text-muted-foreground">Self-approval {w.allow_self_approval ? 'allowed' : 'not allowed'} · {w.require_rejection_reason ? 'reason required to reject' : 'reason optional'}
                        {w.escalate_after_hours ? ` · escalates to ${ROLE_LABELS[w.escalate_to_role as keyof typeof ROLE_LABELS] ?? w.escalate_to_role} after ${w.escalate_after_hours} h` : ''}</p>
                    </div>
                    <StatusBadge label={w.is_active ? 'Active' : 'Inactive'} tone={w.is_active ? 'success' : 'neutral'} />
                    <Button size="sm" variant="outline" onClick={() => setEditing(w)}>Edit</Button>
                    <Button size="sm" variant="outline" onClick={() => setToggle(w)}>{w.is_active ? 'Deactivate' : 'Activate'}</Button>
                  </li>
                ))}</ul>
              )}
          </CardContent>
        </Card>
      ) : tab === 'MODULE' ? (
        <Card>
          <CardHeader><div><CardTitle>Awaiting approval in the modules</CardTitle><CardDescription>Documents waiting for a module approval you are allowed to give (no workflow request). Open them to decide.</CardDescription></div></CardHeader>
          <CardContent>
            {inbox.loading && !inbox.data ? <LoadingState variant="table" rows={3} /> : !(inbox.data?.module_items.length) ? <p className="text-sm text-muted-foreground">Nothing is waiting for you.</p> : (
              <ul className="divide-y text-sm">{inbox.data.module_items.map((m, i) => (
                <li key={i} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-medium">{APPROVAL_DOC_LABELS[m.document_type] ?? m.document_type}</span>
                  <Link className="text-primary hover:underline" to={m.link}>{m.reference}</Link><span className="text-muted-foreground">{m.summary}</span>
                  {m.mine && <span className="text-xs text-amber-700">submitted by you — another person must approve</span>}
                  {m.submitted_at && <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(m.submitted_at)}</span>}
                </li>))}</ul>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="p-0">
          {inbox.loading && !inbox.data ? <LoadingState variant="table" rows={4} /> : inbox.error ? <ErrorState message={describeDataError(inbox.error)} onRetry={inbox.reload} />
            : !requests.length ? <EmptyState icon={ClipboardCheck} title={tab === 'TO_DECIDE' ? 'Nothing waiting for you' : 'No requests'} description="Requests appear when a document needs approval under an active workflow." /> : (
              <ul className="divide-y">{requests.map((r) => <RequestRow key={r.id} r={r} highlight={r.id === highlight} onDecide={(x, d) => { setText(''); setDecide({ r: x, d }) }} onCancel={(x) => { setText(''); setCancel(x) }} />)}</ul>
            )}
        </CardContent></Card>
      )}

      {decide && (
        <Dialog open onOpenChange={(o) => !o && !busy && setDecide(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{decide.d === 'APPROVE' ? 'Approve' : 'Reject'} {decide.r.reference}</DialogTitle>
              <DialogDescription>Stage {decide.r.stage}: {decide.r.stage_name}. The document is re-checked; if it changed since submission the request is cancelled instead.
                {decide.d === 'APPROVE' ? ` Approval does not perform ${APPROVAL_GATED_ACTION[decide.r.document_type]}.` : ''}</DialogDescription></DialogHeader>
            {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <div className="space-y-1"><Label htmlFor="ap-dc">{decide.d === 'REJECT' && decide.r.require_rejection_reason ? 'Reason (required)' : 'Comment (optional)'}</Label>
              <Textarea id="ap-dc" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></div>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDecide(null)}>Cancel</Button>
              <Button variant={decide.d === 'REJECT' ? 'destructive' : 'default'} disabled={busy} onClick={() => void runDecision()}>{busy && <Loader2 className="animate-spin" />} {decide.d === 'APPROVE' ? 'Approve' : 'Reject'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {cancel && (
        <Dialog open onOpenChange={(o) => !o && !busy && setCancel(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Cancel request for {cancel.reference}</DialogTitle><DialogDescription>The request stays in the history as cancelled.</DialogDescription></DialogHeader>
            {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <div className="space-y-1"><Label htmlFor="ap-cr">Reason</Label><Textarea id="ap-cr" rows={2} value={text} onChange={(e) => setText(e.target.value)} /></div>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setCancel(null)}>Back</Button>
              <Button variant="destructive" disabled={busy} onClick={() => { setBusy(true); cancelApprovalRequest(cancel.id, text).then(() => { setCancel(null); done('Request cancelled.') }, (e) => setError(describeDataError(e))).finally(() => setBusy(false)) }}>Cancel request</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {submitting && <SubmitDialog onClose={() => setSubmitting(false)} onDone={(m) => { setSubmitting(false); done(m) }} />}
      {editing && <WorkflowDialog workflow={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(m) => { setEditing(null); done(m) }} />}
      <ConfirmDialog open={toggle !== null} onOpenChange={(o) => !o && setToggle(null)} title={toggle?.is_active ? `Deactivate "${toggle?.name}"?` : `Activate "${toggle?.name}"?`}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        description={toggle?.is_active ? 'New documents will no longer need this approval. Approvals already given are kept.'
          : `From now on, ${toggle ? APPROVAL_GATED_ACTION[toggle.document_type] : ''} will be blocked until a request under this workflow is approved.`}
        onConfirm={() => { const w = toggle!; setToggle(null); setWorkflowActive(w.id, !w.is_active).then(() => done(`Workflow ${w.is_active ? 'deactivated' : 'activated'}.`), (e) => setError(describeDataError(e))) }} />
    </>
  )
}
