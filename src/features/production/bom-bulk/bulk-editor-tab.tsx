import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { FilterTabs } from '@/components/common/filter-tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { OPERATION_HINTS, OPERATION_LABELS, qtyText, type ImportOperation } from '@/features/production/bom-bulk-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useUrlEnum, useUrlString } from '@/hooks/use-url-state'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { fetchCurrentBoms, fetchWhereUsed, saveBatch, type BatchLineInput, type ComponentHit, type CurrentBom, type WhereUsedRow } from '@/services/bom-bulk'

import { ComponentSearch } from './component-search'

// Bulk edit is not offered in the editor (removed on request); quantities can still be changed per BOM in Replace.
const OPS: ImportOperation[] = ['REPLACE', 'DELETE', 'ADD']
type RowEdit = { quantity?: string; wastage?: string }
type AddComponent = { hit: ComponentHit; quantity: string; wastage: string; notes: string }

const num = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : null)

/** Bulk BOM Editor: prepares a draft change batch (nothing changes until it is approved and published). */
export function BulkEditorTab() {
  const navigate = useNavigate()
  const [op, setOp] = useUrlEnum<ImportOperation>('op', OPS, 'REPLACE')
  const [componentId, setComponentId] = useUrlString('component')
  const [pickedOld, setOldComp] = useState<ComponentHit | null>(null)
  const [today] = useState(() => toIsoDate(new Date()))
  const [newComp, setNewComp] = useState<ComponentHit | null>(null)
  const [factor, setFactor] = useState('')
  const [defaults, setDefaults] = useState<RowEdit>({})
  const [reason, setReason] = useState('')
  const [title, setTitle] = useState('')
  const [effective, setEffective] = useState(() => toIsoDate(new Date()))
  const [merge, setMerge] = useState(false)
  const [selection, setSelection] = useState<{ key: string; ids: Set<string>; edits: Record<string, RowEdit> }>({ key: '', ids: new Set(), edits: {} })
  const [filter, setFilter] = useState('')
  const [adds, setAdds] = useState<AddComponent[]>([])
  const [addPick, setAddPick] = useState<ComponentHit | null>(null)
  const [addQty, setAddQty] = useState<Record<string, Record<string, string>>>({})
  const [bomSearchText, setBomSearchText] = useState('')
  const bomSearch = useDebouncedValue(bomSearchText, 300)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lines of the current revisions that use the chosen component (replace / delete / edit).
  const usage = useAsync(async () => (op !== 'ADD' && componentId ? fetchWhereUsed(componentId, { status: 'CURRENT' }, 'sku', true, 5000, 0) : null), [op, componentId])
  // Current revisions of all products (add).
  const boms = useAsync(async () => (op === 'ADD' ? fetchCurrentBoms(bomSearch.trim() || null, 2000) : null), [op, bomSearch])

  const oldComp: ComponentHit | null = pickedOld && pickedOld.product_id === componentId ? pickedOld
    : usage.data?.component && usage.data.component.product_id === componentId ? { ...usage.data.component, model_number: null, supplier_model_number: null, bom_lines: usage.data.total } : null
  const selKey = `${op}|${componentId}`
  const selected = selection.key === selKey ? selection.ids : new Set<string>()
  const edits = selection.key === selKey ? selection.edits : {}
  const setSelected = (f: (s: Set<string>) => Set<string>) => setSelection((cur) => ({ key: selKey, ids: f(cur.key === selKey ? cur.ids : new Set()), edits: cur.key === selKey ? cur.edits : {} }))
  const setEdits = (f: (e: Record<string, RowEdit>) => Record<string, RowEdit>) => setSelection((cur) => ({ key: selKey, ids: cur.key === selKey ? cur.ids : new Set(), edits: f(cur.key === selKey ? cur.edits : {}) }))

  const rows: WhereUsedRow[] = useMemo(() => {
    const t = filter.trim().toLowerCase()
    return (usage.data?.rows ?? []).filter((r) => !t || `${r.sku} ${r.product_name} ${r.bom_code}`.toLowerCase().includes(t))
  }, [usage.data, filter])
  const bomRows: CurrentBom[] = boms.data ?? []
  const allIds = op === 'ADD' ? bomRows.map((b) => b.bom_id) : rows.map((r) => r.bom_id)
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const toggleAll = (on: boolean) => setSelected((s) => { const n = new Set(s); for (const id of allIds) { if (on) n.add(id); else n.delete(id) } return n })
  const setEdit = (id: string, patch: RowEdit) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }))

  const unitsDiffer = op === 'REPLACE' && oldComp && newComp && oldComp.base_unit !== newComp.base_unit
  const previewQty = (r: WhereUsedRow) => {
    const own = num(edits[r.bom_id]?.quantity)
    if (own) return `${own} ${op === 'REPLACE' ? newComp?.base_unit ?? '' : r.unit}`
    if (op === 'REPLACE') {
      if (unitsDiffer && !num(factor)) return 'needs factor'
      return qtyText(Number(r.quantity) * Number(num(factor) ?? 1), newComp?.base_unit ?? r.unit)
    }
    return qtyText(r.quantity, r.unit)
  }

  const buildLines = (): BatchLineInput[] => {
    if (op === 'ADD') {
      return bomRows.filter((b) => selected.has(b.bom_id)).flatMap((b) => adds.map((a) => ({
        bom_id: b.bom_id, component_product_id: a.hit.product_id, quantity: num(addQty[b.bom_id]?.[a.hit.product_id]) ?? num(a.quantity),
        unit: a.hit.base_unit, wastage_percentage: num(a.wastage), ...(a.notes.trim() ? { notes: a.notes.trim() } : {}),
      })))
    }
    return rows.filter((r) => selected.has(r.bom_id)).map((r) => {
      const e = edits[r.bom_id] ?? {}
      const base: BatchLineInput = { bom_id: r.bom_id, component_product_id: r.component_product_id }
      if (op === 'DELETE') return base
      return { ...base, new_component_product_id: newComp?.product_id, quantity: num(e.quantity), factor: num(e.quantity) ? null : num(factor), wastage_percentage: num(e.wastage) ?? num(defaults.wastage) }
    })
  }

  const problems: string[] = []
  if (op !== 'ADD' && !componentId) problems.push('Choose the component.')
  if (op === 'REPLACE' && !newComp) problems.push('Choose the replacement component.')
  if (op === 'ADD' && adds.length === 0) problems.push('Add at least one component.')
  if (op === 'ADD' && adds.some((a) => !num(a.quantity)) && bomRows.filter((b) => selected.has(b.bom_id)).some((b) => adds.some((a) => !num(a.quantity) && !num(addQty[b.bom_id]?.[a.hit.product_id])))) {
    problems.push('Enter a quantity for every component (a default or one per BOM).')
  }
  if (selected.size === 0) problems.push('Select at least one BOM.')
  if (reason.trim().length < 3) problems.push('Enter the reason for the change.')

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const d = await saveBatch(null, null, { operation: op, reason: reason.trim(), effective_from: effective, title: title.trim() || undefined, merge_duplicates: merge }, buildLines())
      navigate(`/production/boms?tab=approvals&batch=${d.batch.id}`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="bulk-editor">
      <FilterTabs<ImportOperation> label="Bulk operation" value={op} onChange={(v) => { setOp(v); setNewComp(null) }}
        options={OPS.map((o) => ({ value: o, label: OPERATION_LABELS[o] }))} />
      <p className="text-sm text-muted-foreground">{OPERATION_HINTS[op]} Nothing changes until the batch is approved and published; each affected BOM then gets a new revision and the previous one is kept.</p>

      {op !== 'ADD' ? (
        <Card>
          <CardHeader><CardTitle>{op === 'REPLACE' ? 'Old and new component' : 'Component'}</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{op === 'REPLACE' ? 'Old component' : 'Component'}</Label>
              <ComponentSearch label={op === 'REPLACE' ? 'Old component' : 'Component'} testId="bulk-old-component" value={oldComp}
                onChange={(h) => { setOldComp(h); setComponentId(h?.product_id ?? '') }} />
            </div>
            {op === 'REPLACE' && (
              <>
                <div className="space-y-1.5">
                  <Label>Replacement component (active only)</Label>
                  <ComponentSearch label="Replacement component" testId="bulk-new-component" activeOnly value={newComp} onChange={setNewComp} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bulk-factor">Conversion factor (new quantity = old quantity × factor)</Label>
                  <Input id="bulk-factor" inputMode="decimal" placeholder="1 (keep quantities)" value={factor} onChange={(e) => setFactor(e.target.value)} />
                  {unitsDiffer && <p className="text-xs text-amber-700">Units differ ({oldComp?.base_unit} → {newComp?.base_unit}). There is no unit-conversion master: enter how many {newComp?.base_unit} replace 1 {oldComp?.base_unit}, or a quantity per BOM.</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bulk-wastage">New wastage % (blank = keep each BOM's wastage)</Label>
                  <Input id="bulk-wastage" inputMode="decimal" value={defaults.wastage ?? ''} onChange={(e) => setDefaults((d) => ({ ...d, wastage: e.target.value }))} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle>Components to add</CardTitle><CardDescription>Each component is added in its inventory unit. Leave a BOM's quantity blank to use the default.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {adds.map((a, i) => (
              <div key={a.hit.product_id} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem_7rem_1fr_auto]">
                <div className="text-sm"><span className="font-medium">{a.hit.sku}</span> — {a.hit.product_name} <span className="text-xs text-muted-foreground">({a.hit.base_unit})</span></div>
                <Input aria-label={`Default quantity of ${a.hit.sku}`} inputMode="decimal" placeholder={`Qty (${a.hit.base_unit})`} value={a.quantity}
                  onChange={(e) => setAdds((l) => l.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                <Input aria-label={`Wastage of ${a.hit.sku}`} inputMode="decimal" placeholder="Wastage %" value={a.wastage}
                  onChange={(e) => setAdds((l) => l.map((x, j) => (j === i ? { ...x, wastage: e.target.value } : x)))} />
                <Input aria-label={`Notes for ${a.hit.sku}`} placeholder="Notes" value={a.notes} onChange={(e) => setAdds((l) => l.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} />
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${a.hit.sku}`} onClick={() => setAdds((l) => l.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-64 flex-1"><ComponentSearch label="Component to add" testId="bulk-add-component" activeOnly value={addPick} onChange={setAddPick} /></div>
              <Button type="button" variant="outline" disabled={!addPick || adds.some((a) => a.hit.product_id === addPick.product_id)}
                onClick={() => { if (addPick) { setAdds((l) => [...l, { hit: addPick, quantity: '', wastage: '', notes: '' }]); setAddPick(null) } }}><Plus /> Add component</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{op === 'ADD' ? 'Finished products (current BOM revisions)' : 'BOMs using this component (current revisions)'}</CardTitle>
            <span className="text-sm text-muted-foreground" data-testid="bulk-selected-count">{selected.size} selected</span>
          </div>
          <Input className="w-full sm:w-72" aria-label="Filter BOMs" placeholder="Filter by product, SKU or BOM number…"
            value={op === 'ADD' ? bomSearchText : filter} onChange={(e) => (op === 'ADD' ? setBomSearchText(e.target.value) : setFilter(e.target.value))} />
        </CardHeader>
        <CardContent className="p-0">
          {(op === 'ADD' ? boms.error : usage.error) && <p role="alert" className="px-5 py-3 text-sm text-red-700">{describeDataError(op === 'ADD' ? boms.error : usage.error)}</p>}
          <div className="max-h-[32rem] overflow-auto">
            <Table data-testid="bulk-bom-table">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="w-10"><Checkbox aria-label="Select all BOMs" checked={allSelected} onCheckedChange={(v) => toggleAll(v === true)} /></TableHead>
                  <TableHead>Finished product</TableHead>
                  <TableHead>BOM / revision</TableHead>
                  {op === 'ADD'
                    ? adds.map((a) => <TableHead key={a.hit.product_id} className="text-right">{a.hit.sku} ({a.hit.base_unit})</TableHead>)
                    : <>
                        <TableHead className="text-right">Current quantity</TableHead>
                        <TableHead className="text-right">Wastage %</TableHead>
                        {op !== 'DELETE' && <TableHead className="text-right">New quantity</TableHead>}
                        {op !== 'DELETE' && <TableHead className="text-right">New wastage %</TableHead>}
                      </>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(op === 'ADD' ? boms.loading : usage.loading) && <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading…</TableCell></TableRow>}
                {op !== 'ADD' && !componentId && <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">Choose a component first.</TableCell></TableRow>}
                {op === 'ADD'
                  ? bomRows.map((b) => (
                      <TableRow key={b.bom_id}>
                        <TableCell><Checkbox aria-label={`Select ${b.sku}`} checked={selected.has(b.bom_id)} onCheckedChange={(v) => toggle(b.bom_id, v === true)} /></TableCell>
                        <TableCell><span className="font-medium">{b.sku}</span><div className="text-xs text-muted-foreground">{b.product_name}</div></TableCell>
                        <TableCell>{b.bom_code} <span className="text-muted-foreground">v{b.version}</span><div className="text-xs text-muted-foreground">{b.item_count} components</div></TableCell>
                        {adds.map((a) => (
                          <TableCell key={a.hit.product_id} className="text-right">
                            <Input className="ml-auto h-8 w-24 text-right" inputMode="decimal" aria-label={`Quantity of ${a.hit.sku} for ${b.sku}`} placeholder={a.quantity || 'qty'}
                              disabled={!selected.has(b.bom_id)} value={addQty[b.bom_id]?.[a.hit.product_id] ?? ''}
                              onChange={(e) => setAddQty((q) => ({ ...q, [b.bom_id]: { ...q[b.bom_id], [a.hit.product_id]: e.target.value } }))} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : rows.map((r) => (
                      <TableRow key={r.bom_id}>
                        <TableCell><Checkbox aria-label={`Select ${r.sku}`} checked={selected.has(r.bom_id)} onCheckedChange={(v) => toggle(r.bom_id, v === true)} /></TableCell>
                        <TableCell><span className="font-medium">{r.sku}</span><div className="text-xs text-muted-foreground">{r.product_name}</div></TableCell>
                        <TableCell>{r.bom_code} <span className="text-muted-foreground">v{r.version}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{qtyText(r.quantity, r.unit)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.wastage_percentage)}%</TableCell>
                        {op !== 'DELETE' && (
                          <TableCell className="text-right">
                            <Input className="ml-auto h-8 w-28 text-right" inputMode="decimal" aria-label={`New quantity for ${r.sku}`} placeholder={previewQty(r)}
                              disabled={!selected.has(r.bom_id)} value={edits[r.bom_id]?.quantity ?? ''} onChange={(e) => setEdit(r.bom_id, { quantity: e.target.value })} />
                          </TableCell>
                        )}
                        {op !== 'DELETE' && (
                          <TableCell className="text-right">
                            <Input className="ml-auto h-8 w-20 text-right" inputMode="decimal" aria-label={`New wastage for ${r.sku}`} placeholder={defaults.wastage || String(Number(r.wastage_percentage))}
                              disabled={!selected.has(r.bom_id)} value={edits[r.bom_id]?.wastage ?? ''} onChange={(e) => setEdit(r.bom_id, { wastage: e.target.value })} />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Reason and effective date</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="bulk-reason">Reason (kept with every new revision)</Label>
            <Textarea id="bulk-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Supplier changed the glaze formulation" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-title">Title (optional)</Label>
            <Input id="bulk-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-effective">Effective from</Label>
            <Input id="bulk-effective" type="date" min={today} value={effective} onChange={(e) => setEffective(e.target.value)} />
            <p className="text-xs text-muted-foreground">Orders already created keep their BOM. New orders use the new revision from this date.</p>
          </div>
          {(op === 'REPLACE' || op === 'ADD') && (
            <label className="flex items-start gap-2 text-sm md:col-span-2">
              <Checkbox checked={merge} onCheckedChange={(v) => setMerge(v === true)} aria-label="Merge into the existing line" />
              <span>Merge into the existing line when the component is already on a BOM (quantities are added). Otherwise such BOMs are reported as errors.</span>
            </label>
          )}
        </CardContent>
      </Card>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800" data-testid="bulk-error">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {problems.length > 0 && <p className="text-sm text-muted-foreground" data-testid="bulk-problems">{problems[0]}</p>}
        <Button disabled={saving || problems.length > 0} onClick={() => void submit()} data-testid="bulk-preview">
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save draft and preview
        </Button>
      </div>
    </div>
  )
}
