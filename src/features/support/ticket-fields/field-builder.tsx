import { ArrowDown, ArrowUp, GripVertical, Loader2, Lock, Pencil, Plus, RotateCcw, Save, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CustomFieldDialog } from '@/features/support/ticket-fields/custom-field-dialog'
import {
  CUSTOMER_SYSTEM_FIELDS, FIELD_TYPE_META, MAX_CUSTOM_FIELDS, MODULE_META, SYSTEM_FIELDS, badgeCount, itemKey, moveItem, sameLayout, type FieldModule,
  type FieldDefinition, type FieldType, type LayoutItem, type StandardField,
} from '@/features/support/ticket-fields/field-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchFieldsAdmin, isMissingTicketFields, saveFieldLayout, type FieldsAdmin } from '@/services/ticket-fields'

const STANDARD_TYPE_LABEL: Record<string, string> = {
  TEXT: 'Text', LOOKUP: 'Customer lookup', PRODUCTS: 'Product Master', PHONE: 'Phone', EMAIL: 'Email', PICKLIST: 'Picklist', USER: 'Agent', TEXTAREA: 'Long text',
}

const usedFrom = (a: FieldsAdmin): LayoutItem[] => a.layout.filter((l) => l.is_visible).map((l) => (l.standard_key
  ? { standard_key: l.standard_key, is_required: l.is_required_override }
  : { field_definition_id: l.field_definition_id!, is_required: l.is_required_override }))

const DRAG_TYPE = 'application/x-alton-ticket-field'
const leaveMessage = (m: FieldModule) => `The ${MODULE_META[m].record} field layout has unsaved changes. Leave without saving?`

/**
 * Support → Settings → Ticket fields. Left: the fields on the New Ticket form (drag to reorder, edit, make required,
 * remove); right: available standard and custom fields (search, drag in, Add Custom Field). Nothing changes on the
 * form until Save; removing a field never deletes saved ticket values.
 */
export function TicketFieldBuilder({ module = 'TICKET', onDirtyChange }: { module?: FieldModule; onDirtyChange?: (dirty: boolean) => void }) {
  const q = useAsync(() => fetchFieldsAdmin(module), [module])
  if (q.error && !q.data) {
    return <Card><ErrorState message={isMissingTicketFields(q.error) ? `${module === 'TICKET' ? 'Ticket fields need the database update 20261226090000' : 'Customer fields need the database update 20261228090000'} (not applied yet).` : describeDataError(q.error)} onRetry={q.reload} /></Card>
  }
  if (!q.data) return <Card><LoadingState rows={6} /></Card>
  return <BuilderBody module={module} admin={q.data} reload={q.reload} onDirtyChange={onDirtyChange} />
}

function BuilderBody({ module, admin, reload, onDirtyChange }: { module: FieldModule; admin: FieldsAdmin; reload: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const meta = MODULE_META[module]
  const saved = useMemo(() => usedFrom(admin), [admin])
  const [used, setUsed] = useState<LayoutItem[]>(saved)
  const [term, setTerm] = useState('')
  const [dialog, setDialog] = useState<FieldDefinition | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const dirty = !sameLayout(used, saved)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  // Unsaved changes: warn before closing the tab and before following a link out of the builder.
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]')
      if (!a || root.current?.contains(a)) return
      if (!window.confirm(leaveMessage(module))) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', onClick, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onClick, true) }
  }, [dirty, module])

  const standardBy = useMemo(() => new Map(admin.standard.map((s) => [s.standard_key, s] as const)), [admin])
  const defBy = useMemo(() => new Map(admin.definitions.map((d) => [d.id, d] as const)), [admin])
  const usedKeys = new Set(used.map(itemKey))
  const q = term.trim().toLowerCase()
  const matches = (label: string, type: string) => !q || label.toLowerCase().includes(q) || type.toLowerCase().includes(q)
  const unusedStandard = admin.standard.filter((s) => !usedKeys.has(s.standard_key) && matches(s.label, STANDARD_TYPE_LABEL[s.field_type] ?? ''))
  const unusedCustom = admin.definitions.filter((d) => d.is_active && !usedKeys.has(d.id) && matches(d.field_label, FIELD_TYPE_META[d.field_type].label))
  const inactive = admin.definitions.filter((d) => !d.is_active && matches(d.field_label, FIELD_TYPE_META[d.field_type].label))
  const can = admin.can

  const add = (item: LayoutItem, at = used.length) => { setUsed((u) => [...u.slice(0, at), item, ...u.slice(at)]); setNotice(null) }
  const remove = (key: string) => { setUsed((u) => u.filter((x) => itemKey(x) !== key)); setNotice(null) }
  const setRequired = (key: string, v: boolean) => setUsed((u) => u.map((x) => (itemKey(x) === key ? { ...x, is_required: v } : x)))

  const onDragStart = (e: DragEvent, key: string, from: 'used' | 'unused') => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ key, from }))
    e.dataTransfer.effectAllowed = 'move'
  }
  const readDrag = (e: DragEvent) => { try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { key: string; from: 'used' | 'unused' } } catch { return null } }
  const dropOnUsed = (e: DragEvent, at: number) => {
    e.preventDefault()
    // A drop on a row must not reach the list's own drop handler too (the move would run twice).
    e.stopPropagation()
    setDropAt(null)
    const d = readDrag(e)
    if (!d || !can.update) return
    if (d.from === 'used') {
      const from = used.findIndex((x) => itemKey(x) === d.key)
      setUsed((u) => moveItem(u, from, from < at ? at - 1 : at))
    } else {
      add(standardBy.has(d.key as never) ? { standard_key: d.key as never } : { field_definition_id: d.key }, at)
    }
  }
  const dropOnUnused = (e: DragEvent) => {
    e.preventDefault()
    const d = readDrag(e)
    if (!d || d.from !== 'used' || !can.update) return
    const s = standardBy.get(d.key as never)
    if (s?.locked) { setError(`${s.label} is always on the ${meta.form}.`); return }
    remove(d.key)
  }

  const save = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await saveFieldLayout(used.map((x) => (x.standard_key ? { standard_key: x.standard_key, is_required: x.is_required ?? null } : { field_definition_id: x.field_definition_id, is_required: x.is_required ?? null })), admin.stamp, module)
      // Normalise the working copy to what the database stores (required flags of locked fields are not kept).
      setUsed(used.map((x) => ({ ...x, is_required: x.standard_key && !standardBy.get(x.standard_key)?.required_editable ? null : x.is_required ?? null })))
      reload()
      setNotice('Ticket fields saved. New tickets use this layout now.')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => { if (!dirty || window.confirm(`Discard your changes to the ${meta.record} field layout?`)) { setUsed(saved); setError(null); setNotice(null) } }

  const row = (x: LayoutItem, i: number) => {
    const key = itemKey(x)
    const s = x.standard_key ? standardBy.get(x.standard_key) : undefined
    const d = x.field_definition_id ? defBy.get(x.field_definition_id) : undefined
    if (!s && !d) return null
    const label = s?.label ?? d!.field_label
    const typeLabel = s ? STANDARD_TYPE_LABEL[s.field_type] ?? s.field_type : FIELD_TYPE_META[d!.field_type].label
    const requiredEditable = s ? s.required_editable : d!.field_type !== 'CHECKBOX' && d!.field_type !== 'FORMULA'
    const required = s ? (s.required_editable ? Boolean(x.is_required) : s.required) : (x.is_required ?? d!.is_required) && requiredEditable
    return (
      <li key={key} draggable={can.update} onDragStart={(e) => onDragStart(e, key, 'used')}
        onDragOver={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1) }}
        onDrop={(e) => { const r = e.currentTarget.getBoundingClientRect(); dropOnUsed(e, e.clientY < r.top + r.height / 2 ? i : i + 1) }}
        className={cn('group flex items-center gap-2 border-b bg-card px-2 py-2 text-sm last:border-b-0', dropAt === i && 'shadow-[inset_0_2px_0_0_var(--color-primary)]',
          dropAt === i + 1 && i === used.length - 1 && 'shadow-[inset_0_-2px_0_0_var(--color-primary)]')}
        data-testid={`used-${s ? s.standard_key : d!.field_key}`}>
        <GripVertical className={cn('size-4 shrink-0 text-muted-foreground', can.update && 'cursor-grab')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 truncate font-medium">{label}{required && <span className="text-red-600" aria-label="required" data-testid="required-mark">*</span>}
            {s?.locked && <Lock className="size-3 text-muted-foreground" aria-label="always on the form" />}
            {d?.visibility === 'TICKET_MANAGERS' && <span className="rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">managers</span>}</span>
          <span className="block text-xs text-muted-foreground">{typeLabel}{s ? ' · standard' : ` · ${d!.field_key}`}</span>
        </span>
        {can.update && requiredEditable && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" className="size-3.5 accent-primary" checked={Boolean(required)}
            onChange={(e) => setRequired(key, e.target.checked)} aria-label={`${label} required`} />Required</label>
        )}
        {d && can.update && <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Edit ${label}`} onClick={() => setDialog(d)}><Pencil className="size-3.5" /></Button>}
        {can.update && <>
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => setUsed((u) => moveItem(u, i, i - 1))}><ArrowUp className="size-3.5" /></Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Move ${label} down`} disabled={i === used.length - 1} onClick={() => setUsed((u) => moveItem(u, i, i + 1))}><ArrowDown className="size-3.5" /></Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Remove ${label} from the form`} disabled={s?.locked} onClick={() => remove(key)}><X className="size-3.5" /></Button>
        </>}
      </li>
    )
  }

  const unusedRow = (key: string, label: string, typeLabel: string, extra: string, item: LayoutItem, def?: FieldDefinition) => (
    <li key={key} draggable={can.update} onDragStart={(e) => onDragStart(e, key, 'unused')} className="flex items-center gap-2 border-b px-2 py-2 text-sm last:border-b-0" data-testid={`unused-${def?.field_key ?? key}`}>
      <GripVertical className={cn('size-4 shrink-0 text-muted-foreground', can.update && 'cursor-grab')} aria-hidden />
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{label}</span><span className="block text-xs text-muted-foreground">{typeLabel}{extra}</span></span>
      {def && can.update && <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Edit ${label}`} onClick={() => setDialog(def)}><Pencil className="size-3.5" /></Button>}
      {can.update && <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => add(item)} aria-label={`Add ${label} to the form`}><Plus className="size-3.5" />Add</Button>}
    </li>
  )

  return (
    <div ref={root} className="space-y-3" data-testid="ticket-field-builder">
      {!can.update && <p className="text-sm text-muted-foreground">Your role can view the {meta.record} fields; changing them needs {meta.record} field access.</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="gap-0 overflow-hidden p-0">
          <CardHeader className="border-b px-4 py-3"><div><CardTitle>Used fields</CardTitle>
            <CardDescription>On the {meta.form}, in this order. Drag to reorder; <span className="text-red-600">*</span> = required.</CardDescription></div></CardHeader>
          <CardContent className="p-0">
            <ul className="border-b bg-muted/30" aria-label="System fields">
              {(module === 'TICKET' ? SYSTEM_FIELDS : CUSTOMER_SYSTEM_FIELDS).map((f) => (
                <li key={f.key} className="flex items-center gap-2 border-b px-2 py-1.5 text-sm text-muted-foreground last:border-b-0" data-testid={`system-${f.key}`}>
                  <Lock className="size-4 shrink-0" aria-hidden /><span className="flex-1">{f.label}</span><span className="text-xs">System · set automatically</span>
                </li>
              ))}
            </ul>
            <ul aria-label="Used fields" data-testid="used-fields" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null) }}
              onDragOver={(e) => { e.preventDefault(); if (!used.length) setDropAt(0) }} onDrop={(e) => dropOnUsed(e, dropAt ?? used.length)}>
              {used.map(row)}
            </ul>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden p-0" onDragOver={(e) => e.preventDefault()} onDrop={dropOnUnused} data-testid="unused-panel">
          <CardHeader className="space-y-3 border-b px-4 py-3">
            <div className="flex items-start justify-between gap-2"><div><CardTitle>Unused fields</CardTitle><CardDescription>Drag a field to the form, or drop one here to remove it.</CardDescription></div>
              {can.create && <Button size="sm" onClick={() => setDialog('new')} disabled={admin.active_custom >= MAX_CUSTOM_FIELDS} data-testid="add-custom-field"><Plus /> Add Custom Field</Button>}</div>
            <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search fields" className="pl-8" aria-label="Search fields" data-testid="field-search" /></div>
          </CardHeader>
          <CardContent className="p-0">
            {unusedStandard.length + unusedCustom.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">{q ? 'No unused field matches.' : 'Every field is on the form.'}</p>}
            <ul aria-label="Unused fields">
              {unusedStandard.map((s: StandardField) => unusedRow(s.standard_key, s.label, STANDARD_TYPE_LABEL[s.field_type] ?? s.field_type, ' · standard', { standard_key: s.standard_key }))}
              {unusedCustom.map((d) => unusedRow(d.id, d.field_label, FIELD_TYPE_META[d.field_type].label, ` · ${d.field_key}${d.value_count ? ` · ${d.value_count} saved` : ''}`, { field_definition_id: d.id }, d))}
            </ul>
            {inactive.length > 0 && (
              <div className="border-t">
                <p className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Inactive (values kept)</p>
                <ul>{inactive.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 px-4 py-1.5 text-sm text-muted-foreground" data-testid={`inactive-${d.field_key}`}>
                    <span className="min-w-0 flex-1 truncate">{d.field_label} <span className="text-xs">· {FIELD_TYPE_META[d.field_type as FieldType].label}{d.value_count ? ` · ${d.value_count} saved` : ''}</span></span>
                    {can.update && <Button size="sm" variant="ghost" className="h-7" onClick={() => setDialog(d)}><RotateCcw className="size-3.5" />Edit / activate</Button>}
                  </li>
                ))}</ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm" data-testid="builder-footer">
        <span className={cn('text-sm', admin.active_custom >= MAX_CUSTOM_FIELDS ? 'font-medium text-amber-800' : 'text-muted-foreground')} data-testid="custom-field-count">{badgeCount(admin.active_custom)}</span>
        {dirty && <span className="text-sm font-medium text-amber-800" role="status" data-testid="unsaved-changes">Unsaved changes</span>}
        {error && <span className="text-sm text-red-700" role="alert">{error}</span>}
        {notice && <span className="text-sm text-green-800" role="status">{notice}</span>}
        <span className="ml-auto flex gap-2">
          <Button variant="outline" onClick={cancel} disabled={!dirty || busy}>Cancel</Button>
          {can.update && <Button onClick={() => void save()} disabled={!dirty || busy} data-testid="save-layout">{busy ? <Loader2 className="animate-spin" /> : <Save />}Save</Button>}
        </span>
      </div>
      {dialog && (
        <CustomFieldDialog module={module} existing={dialog === 'new' ? null : dialog} can={can}
          numberFields={admin.definitions.filter((d) => (d.field_type === 'NUMBER' || d.field_type === 'CURRENCY') && (dialog === 'new' || d.id !== dialog.id))}
          onClose={() => setDialog(null)}
          onSaved={(d, created) => {
            setDialog(null)
            const wasActive = dialog !== 'new' && dialog.is_active
            reload()
            if (created) { add({ field_definition_id: d.id }); setNotice(`${d.field_label} created and placed at the end of the form. Save to show it on the ${meta.form}.`) }
            // Deactivating took the field off the saved form already; take it off the working copy too.
            else if (wasActive && !d.is_active) { setUsed((u) => u.filter((x) => x.field_definition_id !== d.id)); setNotice(`${d.field_label} deactivated. Its saved values are kept.`) }
            else setNotice(`${d.field_label} saved.`)
          }} />
      )}
    </div>
  )
}
