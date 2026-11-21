import { ArrowDown, ArrowUp, Check, GripVertical, Loader2, Pencil, Plus, Star, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { OutcomeIcon } from '@/features/support/pipeline/pipeline-board'
import { STAGE_COLORS, checkStages, sameStages, stageInputOf, statusesFor } from '@/features/support/pipeline/pipeline-model'
import { Field } from '@/features/support/support-components'
import { TICKET_STATUS_META } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchPipelines, saveStages, type Outcome, type Pipeline, type StageInput, type StageType } from '@/services/pipelines'

const LEAVE = 'The stages have unsaved changes. Close without saving?'
type Row = StageInput & { key: string; tickets: number; used: boolean; was_active: boolean }
const DRAG = 'application/x-alton-stage'

const rowsOf = (p: Pipeline): Row[] => p.stages.map((s) => ({ ...stageInputOf(s), key: s.id, tickets: s.tickets, used: s.used, was_active: s.is_active }))
const ordered = (rows: Row[]) => [...rows.filter((r) => r.stage_type === 'OPEN'), ...rows.filter((r) => r.stage_type === 'CLOSED')]

/** Pipeline menu → Manage Stages. Loads the pipeline's stages fresh; after each save the stages are read again. */
export function ManageStagesDialog({ pipeline, onClose }: { pipeline: Pipeline; onClose: (changed: boolean) => void }) {
  const q = useAsync(() => fetchPipelines(), [])
  const [changed, setChanged] = useState(false)
  // The close button and Escape ask first when there are unsaved changes (the body knows).
  const closeRef = useRef<() => void>(() => onClose(changed))
  const fresh = q.data?.pipelines.find((p) => p.id === pipeline.id)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeRef.current() }}>
      <DialogContent className="flex max-h-[92dvh] max-w-4xl flex-col gap-0 p-0" data-testid="manage-stages" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader className="border-b px-6 py-4"><DialogTitle>Manage Stages — {pipeline.name}</DialogTitle>
          <DialogDescription>Each stage stands for a ticket status: moving a ticket into it applies that status with the normal rules (closing, reopening, SLA).</DialogDescription></DialogHeader>
        {q.error ? <ErrorState message={describeDataError(q.error)} onRetry={q.reload} />
          : !fresh ? <LoadingState rows={6} />
          : <StagesBody key={fresh.stamp} pipeline={fresh} closeRef={closeRef} onSaved={() => { setChanged(true); q.reload() }} onClose={() => onClose(changed)} onDone={() => onClose(true)} />}
      </DialogContent>
    </Dialog>
  )
}

function StagesBody({ pipeline, closeRef, onSaved, onClose, onDone }: {
  pipeline: Pipeline; closeRef: { current: () => void }; onSaved: () => void; onClose: () => void; onDone: () => void
}) {
  const baseline = useMemo(() => rowsOf(pipeline), [pipeline])
  const [rows, setRows] = useState<Row[]>(baseline)
  const [moves, setMoves] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ row: Row | null; type: StageType } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const dirty = !sameStages(rows, baseline) || Object.keys(moves).length > 0
  const needsDestination = rows.filter((r) => r.id && r.was_active && !r.is_active && r.tickets > 0)

  const close = () => { if (!dirty || window.confirm(LEAVE)) onClose() }
  useEffect(() => { closeRef.current = close })
  const setDefault = (key: string) => setRows((rs) => rs.map((r) => ({ ...r, is_default: r.key === key })))
  const move = (type: StageType, from: number, to: number) => setRows((rs) => {
    const list = rs.filter((r) => r.stage_type === type)
    if (to < 0 || to >= list.length) return rs
    const [x] = list.splice(from, 1)
    list.splice(to, 0, x)
    return ordered(type === 'OPEN' ? [...list, ...rs.filter((r) => r.stage_type === 'CLOSED')] : [...rs.filter((r) => r.stage_type === 'OPEN'), ...list])
  })
  const drop = (e: DragEvent, type: StageType, at: number) => {
    e.preventDefault(); e.stopPropagation()
    const key = e.dataTransfer.getData(DRAG)
    const list = rows.filter((r) => r.stage_type === type)
    const from = list.findIndex((r) => r.key === key)
    if (from < 0) return
    move(type, from, from < at ? at - 1 : at)
  }

  const save = async (then: 'stay' | 'done') => {
    const list = ordered(rows)
    const problem = checkStages(list)
    if (problem) { setError(problem); return }
    const missingDest = needsDestination.find((r) => !moves[r.id!])
    if (missingDest) { setError(`"${missingDest.stage_name}" contains ${missingDest.tickets} ticket(s): choose where they go before deactivating it.`); return }
    if (!dirty) { if (then === 'done') onDone(); return }
    setBusy(true); setError(null); setNotice(null)
    try {
      const r = await saveStages(pipeline.id, list.map(({ key, tickets: _t, used: _u, was_active: _w, ...s }) => ({ ...s, ...(s.id ? {} : { client_key: key }) })),
        Object.fromEntries(Object.entries(moves).filter(([id]) => needsDestination.some((x) => x.id === id))), pipeline.stamp)
      if (then === 'done') onDone()
      else { onSaved(); setNotice(r.moved ? `Stages saved; ${r.moved} ticket(s) moved.` : 'Stages saved.') }
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const section = (type: StageType) => {
    const list = rows.filter((r) => r.stage_type === type)
    const destinations = rows.filter((r) => r.is_active && r.id)
    return (
      <section className="space-y-2" data-testid={`stages-${type.toLowerCase()}`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{type === 'OPEN' ? 'Open stages' : 'Closed stages'}</h3>
          <Button size="sm" variant="outline" onClick={() => setEditing({ row: null, type })} data-testid={`add-stage-${type.toLowerCase()}`}><Plus /> Add Stage</Button>
        </div>
        <ul className="divide-y rounded-lg border" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, type, list.length)}>
          {list.map((r, i) => (
            <li key={r.key} draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG, r.key); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const b = e.currentTarget.getBoundingClientRect(); drop(e, type, e.clientY < b.top + b.height / 2 ? i : i + 1) }}
              className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-sm', !r.is_active && 'bg-muted/40 text-muted-foreground')} data-testid={`stage-row-${r.stage_name}`}>
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
              <span className="size-3 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 font-medium">{r.stage_name}<OutcomeIcon outcome={r.outcome_type} />
                  {r.is_default && <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 text-[11px] font-normal text-primary"><Star className="size-3" />Default</span>}
                  {!r.is_active && <span className="rounded bg-muted px-1.5 text-[11px] font-normal">Inactive</span>}</span>
                <span className="block truncate text-xs text-muted-foreground">Status: {TICKET_STATUS_META[r.ticket_status].label}{r.stage_description ? ` · ${r.stage_description}` : ''} · {r.tickets} ticket{r.tickets === 1 ? '' : 's'}</span>
              </span>
              {type === 'OPEN' && r.is_active && !r.is_default && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDefault(r.key)}>Set default</Button>}
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${r.stage_name} up`} disabled={i === 0} onClick={() => move(type, i, i - 1)}><ArrowUp className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${r.stage_name} down`} disabled={i === list.length - 1} onClick={() => move(type, i, i + 1)}><ArrowDown className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit ${r.stage_name}`} onClick={() => setEditing({ row: r, type })}><Pencil className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Delete ${r.stage_name}`} disabled={r.used || r.tickets > 0}
                title={r.used || r.tickets > 0 ? 'Stages that hold or held tickets cannot be deleted; deactivate them instead.' : undefined}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="size-3.5" /></Button>
              {r.id && r.was_active && !r.is_active && r.tickets > 0 && (
                <div className="flex w-full items-center gap-2 pl-9 text-xs text-amber-900" data-testid={`destination-${r.stage_name}`}>
                  Move its {r.tickets} ticket{r.tickets === 1 ? '' : 's'} to
                  <Select value={moves[r.id] ?? ''} onValueChange={(v) => setMoves((m) => ({ ...m, [r.id!]: v }))}>
                    <SelectTrigger className="h-7 w-52 text-xs" aria-label={`Destination for ${r.stage_name}`}><SelectValue placeholder="Choose a stage" /></SelectTrigger>
                    <SelectContent>{destinations.filter((d) => d.key !== r.key).map((d) => <SelectItem key={d.key} value={d.id!}>{d.stage_name}</SelectItem>)}</SelectContent>
                  </Select>
                  <span className="text-muted-foreground">(each move is recorded; closed tickets moved to an open stage are reopened)</span>
                </div>
              )}
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">No {type.toLowerCase()} stages.</li>}
        </ul>
      </section>
    )
  }

  return (
    <>
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-6 py-4">
        {section('OPEN')}
        {section('CLOSED')}
      </div>
      <DialogFooter className="flex-wrap items-center gap-2 border-t px-6 py-3 sm:justify-start">
        {dirty && <span className="text-sm font-medium text-amber-800" role="status" data-testid="stages-unsaved">Unsaved changes</span>}
        {error && <span className="text-sm text-red-700" role="alert" data-testid="stages-error">{error}</span>}
        {notice && <span className="text-sm text-green-800" role="status">{notice}</span>}
        <span className="ml-auto flex gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="outline" onClick={() => void save('stay')} disabled={busy || !dirty} data-testid="stages-save">{busy && <Loader2 className="animate-spin" />}Save</Button>
          <Button onClick={() => void save('done')} disabled={busy} data-testid="stages-done"><Check /> Done</Button>
        </span>
      </DialogFooter>
      {editing && <StageDialog row={editing.row} type={editing.type} others={rows.filter((r) => r.key !== editing.row?.key).map((r) => r.stage_name)}
        onClose={() => setEditing(null)}
        onSave={(r) => {
          setEditing(null)
          setRows((rs) => {
            let next = editing.row ? rs.map((x) => (x.key === editing.row!.key ? { ...x, ...r } : x)) : [...rs, { ...r, key: `new-${Date.now()}`, tickets: 0, used: false, was_active: true }]
            if (r.is_default) next = next.map((x) => ({ ...x, is_default: x.key === (editing.row?.key ?? next[next.length - 1].key) }))
            return ordered(next)
          })
        }} />}
    </>
  )
}

/** Add / edit one stage (saved with the whole list). */
function StageDialog({ row, type, others, onClose, onSave }: {
  row: Row | null; type: StageType; others: string[]; onClose: () => void; onSave: (r: StageInput) => void
}) {
  const [v, setV] = useState<StageInput>(() => row ? { ...row } : { stage_name: '', stage_description: null, stage_type: type, outcome_type: type === 'CLOSED' ? 'POSITIVE' : null,
    ticket_status: type === 'OPEN' ? 'IN_PROGRESS' : 'RESOLVED', color: type === 'OPEN' ? '#0ea5e9' : '#16a34a', is_default: false, is_active: true })
  const [error, setError] = useState<string | null>(null)
  const typeLocked = Boolean(row && (row.tickets > 0 || row.used))
  const submit = () => {
    const n = v.stage_name.trim()
    if (!n) { setError('Enter the stage name.'); return }
    if (others.some((o) => o.trim().toLowerCase() === n.toLowerCase())) { setError(`A stage named "${n}" already exists in this pipeline.`); return }
    if (v.stage_type === 'CLOSED' && !v.outcome_type) { setError('Choose Positive or Negative for a closed stage.'); return }
    onSave({ ...v, stage_name: n, stage_description: v.stage_description?.trim() || null, is_default: v.stage_type === 'OPEN' && v.is_active && v.is_default })
  }
  const setType = (t: StageType) => setV((x) => ({ ...x, stage_type: t, outcome_type: t === 'CLOSED' ? x.outcome_type ?? 'POSITIVE' : null,
    ticket_status: statusesFor(t).includes(x.ticket_status) ? x.ticket_status : t === 'OPEN' ? 'IN_PROGRESS' : 'RESOLVED', is_default: t === 'OPEN' && x.is_default }))
  const outcomeButton = (o: Outcome) => (
    <Button type="button" variant={v.outcome_type === o ? 'secondary' : 'outline'} size="sm" aria-pressed={v.outcome_type === o} onClick={() => setV((x) => ({ ...x, outcome_type: o }))}
      className={cn(v.outcome_type === o && (o === 'POSITIVE' ? 'border-green-600 text-green-700' : 'border-red-600 text-red-700'))} data-testid={`outcome-${o.toLowerCase()}`}>
      {o === 'POSITIVE' ? <ThumbsUp className="text-green-600" /> : <ThumbsDown className="text-red-600" />}{o === 'POSITIVE' ? 'Positive' : 'Negative'}</Button>
  )
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" data-testid="stage-dialog">
        <DialogHeader><DialogTitle>{row ? `Edit ${row.stage_name}` : 'Add Stage'}</DialogTitle><DialogDescription>Changes are saved with Save or Done in Manage Stages.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          <Field label="Stage name" htmlFor="sg-name" className="sm:col-span-2"><Input id="sg-name" value={v.stage_name} onChange={(e) => setV((x) => ({ ...x, stage_name: e.target.value }))} maxLength={60} autoFocus /></Field>
          <Field label="Description" htmlFor="sg-desc" className="sm:col-span-2"><Textarea id="sg-desc" rows={2} maxLength={300} value={v.stage_description ?? ''} onChange={(e) => setV((x) => ({ ...x, stage_description: e.target.value }))} /></Field>
          <Field label="Stage type" htmlFor="sg-type" hint={typeLocked ? 'Fixed: this stage holds or held tickets.' : undefined}>
            <Select value={v.stage_type} onValueChange={(t) => setType(t as StageType)} disabled={typeLocked}>
              <SelectTrigger id="sg-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="OPEN">Open</SelectItem><SelectItem value="CLOSED">Closed</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Ticket status" htmlFor="sg-status" hint="Applied when a ticket is moved into this stage.">
            <Select value={v.ticket_status} onValueChange={(s) => setV((x) => ({ ...x, ticket_status: s as StageInput['ticket_status'] }))}>
              <SelectTrigger id="sg-status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{statusesFor(v.stage_type).map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS_META[s].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {v.stage_type === 'CLOSED' && <div className="space-y-1 sm:col-span-2"><p className="text-sm font-medium">Outcome</p><div className="flex gap-2">{outcomeButton('POSITIVE')}{outcomeButton('NEGATIVE')}</div></div>}
          <div className="space-y-1 sm:col-span-2"><p className="text-sm font-medium">Stage colour</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stage colour">{STAGE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={v.color === c} aria-label={c} onClick={() => setV((x) => ({ ...x, color: c }))}
                className={cn('size-7 rounded-full border-2', v.color === c ? 'border-foreground' : 'border-transparent')} style={{ background: c }} />
            ))}</div></div>
          {v.stage_type === 'OPEN' && <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_default} disabled={!v.is_active} onCheckedChange={(x) => setV((s) => ({ ...s, is_default: x === true }))} />Default stage for new tickets</label>}
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={v.is_active} onCheckedChange={(x) => setV((s) => ({ ...s, is_active: x === true, is_default: x === true && s.is_default }))} data-testid="stage-active" />Active</label>
          {row && row.tickets > 0 && !v.is_active && row.is_active && <p className="text-xs text-amber-800 sm:col-span-2">This stage holds {row.tickets} ticket(s): choose where they go in the stage list before saving.</p>}
          {error && <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p>}
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" data-testid="stage-dialog-ok">{row ? 'Apply' : 'Add stage'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
