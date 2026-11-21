import { ArrowDown, ArrowUp, Loader2, Lock, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/features/support/support-components'
import {
  FIELD_TYPES, FIELD_TYPE_META, LOOKUP_LABELS, LOOKUP_TARGETS, checkDefinition, checkFieldValue, moveItem, parseFormula, previewKey, toInput,
  type FieldConfig, type FieldDefinition, type FieldType, type InputValue, type LookupTarget, type Visibility,
} from '@/features/support/ticket-fields/field-model'
import { describeDataError } from '@/lib/errors'
import { saveFieldDefinition } from '@/services/ticket-fields'

const NO_DEFAULT: FieldType[] = ['LOOKUP', 'USER', 'FORMULA']
const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
const str = (n: number | undefined) => (n === undefined || n === null ? '' : String(n))

interface Option { id?: string; label: string }

/**
 * Create or edit a custom ticket field. The internal key is generated from the label when the field is created and
 * never changes; the type cannot change afterwards (saved values must keep fitting). Deactivating keeps the values.
 */
export function CustomFieldDialog({ existing, can, numberFields, onClose, onSaved }: {
  existing: FieldDefinition | null
  can: { create: boolean; update: boolean; delete: boolean }
  /** Number and currency fields a formula may use. */
  numberFields: { field_key: string; field_label: string }[]
  onClose: () => void
  onSaved: (d: FieldDefinition, created: boolean) => void
}) {
  const c0 = existing?.field_config ?? {}
  const [label, setLabel] = useState(existing?.field_label ?? '')
  const [type, setType] = useState<FieldType>(existing?.field_type ?? 'PICKLIST')
  const [required, setRequired] = useState(existing?.is_required ?? false)
  const [active, setActive] = useState(existing?.is_active ?? true)
  const [visibility, setVisibility] = useState<Visibility>(existing?.visibility ?? 'ALL_AGENTS')
  const [help, setHelp] = useState(existing?.help_text ?? '')
  const [placeholder, setPlaceholder] = useState(existing?.placeholder ?? '')
  const [options, setOptions] = useState<Option[]>(() => (c0.options?.length ? c0.options.map((o) => ({ ...o })) : [{ label: '' }]))
  const [minLen, setMinLen] = useState(str(c0.min_length))
  const [maxLen, setMaxLen] = useState(str(c0.max_length ?? 255))
  const [kind, setKind] = useState<'INTEGER' | 'DECIMAL'>(c0.number_kind ?? 'DECIMAL')
  const [decimals, setDecimals] = useState(str(c0.decimals ?? 2))
  const [min, setMin] = useState(str(c0.min))
  const [max, setMax] = useState(str(c0.max))
  const [currency, setCurrency] = useState(c0.currency ?? 'INR')
  const [target, setTarget] = useState<LookupTarget | ''>(c0.target ?? '')
  const [expression, setExpression] = useState(c0.expression ?? '')
  const [resultKind, setResultKind] = useState<'NUMBER' | 'CURRENCY'>(c0.result_kind ?? 'NUMBER')
  const [scope, setScope] = useState<'EMPLOYEES' | 'AGENTS'>(c0.scope ?? 'EMPLOYEES')
  const [defaultValue, setDefaultValue] = useState<InputValue>(() => (existing ? toInput(existing, existing.default_value) : null))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const readOnly = existing ? !can.update : !can.create

  const config = useMemo((): FieldConfig => {
    switch (type) {
      case 'PICKLIST': return { options: options.filter((o) => o.label.trim()).map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim() })) }
      case 'TEXT': return { min_length: num(minLen) ?? 0, max_length: num(maxLen) ?? 255 }
      case 'NUMBER': return { number_kind: kind, decimals: kind === 'INTEGER' ? 0 : num(decimals) ?? 2, min: num(min), max: num(max) }
      case 'CURRENCY': return { currency: currency.trim().toUpperCase() || 'INR', min: num(min), max: num(max) }
      case 'LOOKUP': return target ? { target } : {}
      case 'FORMULA': return { expression: expression.trim(), result_kind: resultKind, decimals: num(decimals) ?? 2, currency: currency.trim().toUpperCase() || 'INR' }
      case 'USER': return { scope }
      default: return {}
    }
  }, [type, options, minLen, maxLen, kind, decimals, min, max, currency, target, expression, resultKind, scope])

  const formulaError = useMemo(() => {
    if (type !== 'FORMULA' || !expression.trim()) return null
    try { parseFormula(expression); return null } catch (e) { return (e as Error).message }
  }, [type, expression])

  const submit = async () => {
    const problem = checkDefinition({ field_label: label, field_type: type, field_config: config, is_required: required })
    if (problem) { setError(problem); return }
    if (['NUMBER', 'CURRENCY', 'TEXT'].includes(type) && [minLen, maxLen, decimals, min, max].some((x) => x.trim() && !Number.isFinite(Number(x)))) { setError('Limits must be numbers.'); return }
    let def: unknown = null
    if (type === 'PICKLIST') {
      // A default option that was removed is dropped.
      const id = defaultValue && typeof defaultValue === 'object' ? defaultValue.id : null
      def = id && config.options?.some((o) => o.id === id) ? id : null
    } else if (type === 'CHECKBOX') {
      def = defaultValue === true
    } else if (!NO_DEFAULT.includes(type)) {
      const r = checkFieldValue({ field_label: 'The default value', field_type: type, field_config: config }, defaultValue)
      if (r.error) { setError(r.error); return }
      def = r.value
    }
    setBusy(true); setError(null)
    try {
      const base = { field_label: label.trim(), field_config: config, is_required: required, help_text: help.trim() || null, placeholder: placeholder.trim() || null, visibility, default_value: def }
      const saved = await saveFieldDefinition(existing?.id ?? null, existing ? { ...base, ...(active !== existing.is_active ? { is_active: active } : {}) } : { ...base, field_type: type })
      onSaved(saved, !existing)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  // Default option of a picklist: options without a saved id do not exist yet, so the default is chosen after saving.
  const savedOptions = options.filter((o) => o.id && o.label.trim())

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col gap-0 p-0" data-testid="custom-field-dialog">
        <DialogHeader className="border-b px-6 py-4"><DialogTitle>{existing ? `Edit ${existing.field_label}` : 'Create Custom Field'}</DialogTitle>
          <DialogDescription>{existing ? 'Saved ticket values are kept when you edit or deactivate a field.' : 'The field is created now; place it on the form and Save the layout to show it on New Ticket.'}</DialogDescription></DialogHeader>
        <form id="cf-form" className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-6 py-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <Field label="Field label" htmlFor="cf-label" className="sm:col-span-2"><Input id="cf-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} disabled={readOnly} autoFocus /></Field>
          <Field label="Field type" htmlFor="cf-type" hint={existing ? 'The type cannot change after the field is created.' : FIELD_TYPE_META[type].hint}>
            <Select value={type} onValueChange={(t) => { setType(t as FieldType); setDefaultValue(t === 'CHECKBOX' ? false : null); if (t === 'CHECKBOX' || t === 'FORMULA') setRequired(false) }} disabled={Boolean(existing) || readOnly}>
              <SelectTrigger id="cf-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">{FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{FIELD_TYPE_META[t].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Internal field key" htmlFor="cf-key" hint={existing ? 'Fixed: reports and integrations use it.' : 'Generated from the label when saved; it never changes.'}>
            <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 font-mono text-xs" id="cf-key" data-testid="cf-key"><Lock className="size-3.5 text-muted-foreground" />{existing?.field_key ?? previewKey(label)}</div>
          </Field>

          {type === 'PICKLIST' && (
            <div className="space-y-2 sm:col-span-2">
              <p className="text-sm font-medium">Options</p>
              <ul className="space-y-1.5" data-testid="cf-options">
                {options.map((o, i) => (
                  <li key={o.id ?? `new-${i}`} className="flex items-center gap-1.5">
                    <Input aria-label={`Option ${i + 1}`} value={o.label} maxLength={100} disabled={readOnly} onChange={(e) => setOptions((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move option ${i + 1} up`} disabled={i === 0 || readOnly} onClick={() => setOptions((xs) => moveItem(xs, i, i - 1))}><ArrowUp className="size-4" /></Button>
                    <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move option ${i + 1} down`} disabled={i === options.length - 1 || readOnly} onClick={() => setOptions((xs) => moveItem(xs, i, i + 1))}><ArrowDown className="size-4" /></Button>
                    <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Remove option ${i + 1}`} disabled={options.length === 1 || readOnly} onClick={() => setOptions((xs) => xs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                  </li>
                ))}
              </ul>
              <Button type="button" size="sm" variant="outline" disabled={readOnly || options.length >= 200} onClick={() => setOptions((xs) => [...xs, { label: '' }])}><Plus /> Add option</Button>
              {existing && <p className="text-xs text-muted-foreground">Renaming an option renames it on every ticket. A removed option stays on the tickets that have it, marked “removed option”.</p>}
            </div>
          )}
          {type === 'TEXT' && <>
            <Field label="Minimum characters" htmlFor="cf-minlen"><Input id="cf-minlen" value={minLen} onChange={(e) => setMinLen(e.target.value)} inputMode="numeric" disabled={readOnly} /></Field>
            <Field label="Maximum characters" htmlFor="cf-maxlen" hint="At most 2000."><Input id="cf-maxlen" value={maxLen} onChange={(e) => setMaxLen(e.target.value)} inputMode="numeric" disabled={readOnly} /></Field>
          </>}
          {type === 'NUMBER' && <>
            <Field label="Number" htmlFor="cf-kind">
              <Select value={kind} onValueChange={(k) => setKind(k as 'INTEGER' | 'DECIMAL')} disabled={readOnly}>
                <SelectTrigger id="cf-kind" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="INTEGER">Whole number (integer)</SelectItem><SelectItem value="DECIMAL">Decimal</SelectItem></SelectContent>
              </Select>
            </Field>
            {kind === 'DECIMAL' ? <Field label="Decimals" htmlFor="cf-dec"><Input id="cf-dec" value={decimals} onChange={(e) => setDecimals(e.target.value)} inputMode="numeric" disabled={readOnly} /></Field> : <div />}
          </>}
          {(type === 'NUMBER' || type === 'CURRENCY') && <>
            <Field label="Minimum value" htmlFor="cf-min"><Input id="cf-min" value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" disabled={readOnly} /></Field>
            <Field label="Maximum value" htmlFor="cf-max"><Input id="cf-max" value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" disabled={readOnly} /></Field>
          </>}
          {(type === 'CURRENCY' || (type === 'FORMULA' && resultKind === 'CURRENCY')) && (
            <Field label="Currency" htmlFor="cf-cur" hint="Three-letter code. Default INR."><Input id="cf-cur" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} disabled={readOnly} /></Field>
          )}
          {type === 'LOOKUP' && (
            <Field label="Links to" htmlFor="cf-target" className="sm:col-span-2" hint="Agents search these records as they type. Each needs the ERP permission that already protects it.">
              <Select value={target || '__none'} onValueChange={(t) => setTarget(t === '__none' ? '' : (t as LookupTarget))} disabled={Boolean(existing) || readOnly}>
                <SelectTrigger id="cf-target" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__none">Choose…</SelectItem>{LOOKUP_TARGETS.map((t) => <SelectItem key={t} value={t}>{LOOKUP_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          {type === 'FORMULA' && <>
            <Field label="Formula" htmlFor="cf-expr" className="sm:col-span-2" error={formulaError ?? undefined}
              hint="Numbers, number or currency fields written as {field_key}, + − × ÷ ( ) and ROUND(x, 2), MIN(a, b), MAX(a, b), ABS(x). Calculated when shown; never stored.">
              <Textarea id="cf-expr" value={expression} onChange={(e) => setExpression(e.target.value)} rows={2} maxLength={500} className="font-mono text-xs" disabled={readOnly} />
            </Field>
            {numberFields.length > 0 && (
              <div className="flex flex-wrap gap-1.5 sm:col-span-2" aria-label="Insert a field">
                {numberFields.map((f) => <Button key={f.field_key} type="button" size="sm" variant="outline" className="h-7 font-mono text-xs" disabled={readOnly}
                  onClick={() => setExpression((x) => `${x}${x && !/[\s(]$/.test(x) ? ' ' : ''}{${f.field_key}}`)}>{`{${f.field_key}}`}</Button>)}
              </div>
            )}
            <Field label="Result" htmlFor="cf-result">
              <Select value={resultKind} onValueChange={(k) => setResultKind(k as 'NUMBER' | 'CURRENCY')} disabled={readOnly}>
                <SelectTrigger id="cf-result" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="NUMBER">Number</SelectItem><SelectItem value="CURRENCY">Amount (currency)</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Decimals" htmlFor="cf-fdec"><Input id="cf-fdec" value={decimals} onChange={(e) => setDecimals(e.target.value)} inputMode="numeric" disabled={readOnly} /></Field>
          </>}
          {type === 'USER' && (
            <Field label="Who can be chosen" htmlFor="cf-scope" className="sm:col-span-2">
              <Select value={scope} onValueChange={(s) => setScope(s as 'EMPLOYEES' | 'AGENTS')} disabled={readOnly}>
                <SelectTrigger id="cf-scope" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="EMPLOYEES">Active ERP employees</SelectItem><SelectItem value="AGENTS">Active support agents</SelectItem></SelectContent>
              </Select>
            </Field>
          )}

          {!NO_DEFAULT.includes(type) && (
            <Field label="Default value" htmlFor="cf-default" className="sm:col-span-2" hint={type === 'PICKLIST' && options.some((o) => !o.id && o.label.trim()) ? 'New options can be chosen as default after saving.' : 'Filled in on new tickets; agents can change it.'}>
              {type === 'PICKLIST' ? (
                <Select value={defaultValue && typeof defaultValue === 'object' ? defaultValue.id : '__none'} disabled={readOnly}
                  onValueChange={(v) => setDefaultValue(v === '__none' ? null : { id: v, label: savedOptions.find((o) => o.id === v)?.label ?? v })}>
                  <SelectTrigger id="cf-default" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="__none">No default</SelectItem>{savedOptions.map((o) => <SelectItem key={o.id} value={o.id!}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              ) : type === 'CHECKBOX' ? (
                <label className="flex items-center gap-2 text-sm"><Checkbox id="cf-default" checked={defaultValue === true} onCheckedChange={(v) => setDefaultValue(v === true)} disabled={readOnly} />Ticked by default</label>
              ) : (
                <Input id="cf-default" type={type === 'DATE' ? 'date' : 'text'} value={typeof defaultValue === 'string' ? defaultValue : ''} onChange={(e) => setDefaultValue(e.target.value)} disabled={readOnly} />
              )}
            </Field>
          )}
          <Field label="Help text" htmlFor="cf-help" hint="Shown under the field."><Input id="cf-help" value={help} onChange={(e) => setHelp(e.target.value)} maxLength={300} disabled={readOnly} /></Field>
          <Field label="Placeholder" htmlFor="cf-ph"><Input id="cf-ph" value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} maxLength={120} disabled={readOnly || type === 'FORMULA'} /></Field>
          <Field label="Field visibility" htmlFor="cf-vis" hint="Who sees the value on tickets.">
            <Select value={visibility} onValueChange={(v) => setVisibility(v as Visibility)} disabled={readOnly}>
              <SelectTrigger id="cf-vis" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ALL_AGENTS">Every support user</SelectItem><SelectItem value="TICKET_MANAGERS">Only users who manage tickets</SelectItem></SelectContent>
            </Select>
          </Field>
          <div className="space-y-2 pt-6">
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={required} disabled={readOnly || type === 'CHECKBOX' || type === 'FORMULA'} onCheckedChange={(v) => setRequired(v === true)} data-testid="cf-required" />Required on New Ticket</label>
            {existing && (
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={active} disabled={existing.is_active ? !can.delete : !can.update} onCheckedChange={(v) => setActive(v === true)} data-testid="cf-active" />Active</label>
            )}
            {existing && !active && existing.is_active && <p className="text-xs text-amber-800">Deactivating removes the field from the form. {existing.value_count ? `Its ${existing.value_count} saved value${existing.value_count === 1 ? ' is' : 's are'} kept and still shown on the tickets.` : ''}</p>}
          </div>
          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 sm:col-span-2">{error}</p>}
        </form>
        <DialogFooter className="border-t px-6 py-3">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          {!readOnly && <Button type="submit" form="cf-form" disabled={busy} data-testid="cf-save">{busy && <Loader2 className="animate-spin" />}{existing ? 'Save field' : 'Create field'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
