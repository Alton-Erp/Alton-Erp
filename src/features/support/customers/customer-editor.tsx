import { AlertTriangle, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { checkCustomerValues, customerValuesOf, emptyCustomer, WIDE_KEYS, type CustomerTextKey, type CustomerValues } from '@/features/support/customers/customer-model'
import { AgentSelect, Field } from '@/features/support/support-components'
import { CustomFieldInput } from '@/features/support/ticket-fields/custom-field-input'
import { checkFieldValue, formulaInputsOf, toInput, type FormField, type InputValue } from '@/features/support/ticket-fields/field-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { saveCustomerV2, type CustomerForm, type CustomerSaveInput, type CustomerWorkspace } from '@/services/customer-crm'
import { fetchAgents, fetchErpCustomerOptions } from '@/services/support'

type Custom = Extract<FormField, { kind: 'CUSTOM' }>
type Standard = Extract<FormField, { kind: 'STANDARD' }>

/**
 * Customer form from the administrator's layout (Support Settings → Custom fields → Customer Fields): standard and
 * custom fields in the configured order. Saving goes through support_customer_save_v2 (one transaction; a phone or
 * email already on another customer is shown and saved only as a different customer, never merged).
 */
export function CustomerEditor({ form, workspace, preset, onSaved, onCancel }: {
  form: CustomerForm
  workspace?: CustomerWorkspace | null
  preset?: Partial<CustomerValues>
  onSaved: (r: { id: string; label: string }) => void
  onCancel: () => void
}) {
  const existing = workspace?.customer ?? null
  const customs = useMemo(() => form.fields.filter((f): f is Custom => f.kind === 'CUSTOM'), [form])
  const stored = useMemo(() => Object.fromEntries((workspace?.fields ?? []).map((f) => [f.field_key, f.value])), [workspace])
  const [v, setV] = useState<CustomerValues>(() => ({ ...(existing ? customerValuesOf(existing) : emptyCustomer()), ...preset }))
  const [values, setValues] = useState<Record<string, InputValue>>(() => Object.fromEntries(customs.map((f) => [f.field_key, toInput(f, existing ? stored[f.field_key] : f.default_value)])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [dupes, setDupes] = useState<{ id: string; customer_code: string; display_name: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const erp = useAsync(() => (form.fields.some((f) => f.kind === 'STANDARD' && (f.standard_key as string) === 'erp_customer') ? fetchErpCustomerOptions().catch(() => []) : Promise.resolve([])), [form])
  const set = (k: CustomerTextKey | 'assigned_agent_id' | 'erp_customer_id', x: string) => {
    setV((s) => ({ ...s, [k]: x })); setDupes(null)
    setErrors((e) => { if (!(k in e)) return e; const n = { ...e }; delete n[k]; return n })
  }

  const submit = async (allowDuplicate: boolean) => {
    const errs = checkCustomerValues(v)
    const p: CustomerSaveInput = { display_name: v.display_name.trim() }
    for (const f of form.fields) {
      if (f.kind !== 'STANDARD') continue
      const key = f.standard_key as string
      if (key === 'assigned_agent') { p.assigned_agent_id = v.assigned_agent_id || null; if (f.required && !v.assigned_agent_id) errs.assigned_agent_id = 'Required.'; continue }
      if (key === 'erp_customer') { p.erp_customer_id = v.erp_customer_id || null; if (f.required && !v.erp_customer_id) errs.erp_customer_id = 'Required.'; continue }
      const val = v[key as CustomerTextKey]?.trim() ?? ''
      ;(p as Record<string, unknown>)[key] = key === 'gstin' ? val.toUpperCase() || null : val || null
      if (f.required && !val) errs[key] = 'Required.'
    }
    const custom: Record<string, unknown> = {}
    for (const f of customs) {
      if (f.field_type === 'FORMULA') continue
      const r = checkFieldValue(f, values[f.field_key] ?? null)
      if (r.error) errs[f.field_key] = r.error
      else if (f.required && (r.value === null || r.value === '')) errs[f.field_key] = 'Required.'
      custom[f.field_key] = r.value
    }
    p.custom_fields = custom
    setErrors(errs)
    if (Object.keys(errs).length) { setError('Check the fields marked in red.'); return }
    setBusy(true); setError(null)
    try {
      const r = await saveCustomerV2(existing?.id ?? null, p, allowDuplicate)
      if (!r.ok) { setDupes(r.duplicates); return }
      onSaved({ id: r.id!, label: `${r.display_name ?? v.display_name.trim()} (${r.customer_code ?? existing?.customer_code ?? ''})` })
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const label = (text: string, required: boolean) => (required ? `${text} *` : text)
  const standard = (f: Standard) => {
    const key = f.standard_key as string
    const err = errors[key === 'assigned_agent' ? 'assigned_agent_id' : key === 'erp_customer' ? 'erp_customer_id' : key]
    const common = { id: `cu-${key}`, 'aria-invalid': Boolean(err) || undefined }
    let input
    if (key === 'assigned_agent') input = <AgentSelect id={common.id} agents={agents.data ?? []} value={v.assigned_agent_id || null} onChange={(a) => set('assigned_agent_id', a ?? '')} />
    else if (key === 'erp_customer') {
      input = (
        <Select value={v.erp_customer_id || 'none'} onValueChange={(x) => set('erp_customer_id', x === 'none' ? '' : x)}>
          <SelectTrigger id={common.id} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-72"><SelectItem value="none">None</SelectItem>
            {(erp.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}
            {v.erp_customer_id && !(erp.data ?? []).some((c) => c.id === v.erp_customer_id) && <SelectItem value={v.erp_customer_id}>{existing?.erp_customer?.customer_name ?? 'Linked ERP customer'}</SelectItem>}</SelectContent>
        </Select>
      )
    } else if (key === 'customer_type') {
      input = (
        <Select value={v.customer_type || 'none'} onValueChange={(x) => set('customer_type', x === 'none' ? '' : x)}>
          <SelectTrigger id={common.id} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Not set</SelectItem>{[...new Set([...form.customer_types, ...(v.customer_type ? [v.customer_type] : [])])].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
        </Select>
      )
    } else if (WIDE_KEYS.has(key)) input = <Textarea {...common} rows={key === 'address' ? 2 : 3} maxLength={key === 'address' ? 1000 : 2000} value={v[key as CustomerTextKey]} onChange={(e) => set(key as CustomerTextKey, e.target.value)} />
    else {
      const k = key as CustomerTextKey
      const type = ['mobile', 'alternate_phone', 'landline'].includes(k) ? 'tel' : ['email', 'alternate_email'].includes(k) ? 'email' : 'text'
      input = <Input {...common} type={type} inputMode={type === 'tel' ? 'tel' : type === 'email' ? 'email' : undefined} value={v[k]} autoComplete="off"
        maxLength={k === 'display_name' || k === 'company_name' ? 200 : k.includes('email') ? 320 : k === 'contact_person' ? 120 : 80}
        onChange={(e) => set(k, k === 'gstin' ? e.target.value.toUpperCase() : e.target.value)} />
    }
    return <Field key={key} label={label(f.label, f.required)} htmlFor={common.id} error={err} className={cn(WIDE_KEYS.has(key) && 'sm:col-span-2')}>{input}</Field>
  }
  const inputs = formulaInputsOf(customs, values)

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void submit(false) }} noValidate data-testid="customer-editor">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-6 py-4 sm:grid-cols-2">
        {form.fields.map((f) => f.kind === 'STANDARD' ? standard(f) : (
          <Field key={f.field_key} label={label(f.field_label, f.required)} htmlFor={`cu-cf-${f.field_key}`} error={errors[f.field_key]} hint={f.help_text ?? undefined}>
            <CustomFieldInput def={f} id={`cu-cf-${f.field_key}`} value={values[f.field_key] ?? null} invalid={Boolean(errors[f.field_key])} formulaInputs={inputs}
              onChange={(x) => { setValues((s) => ({ ...s, [f.field_key]: x })); setErrors((e) => { const n = { ...e }; delete n[f.field_key]; return n }) }} />
          </Field>
        ))}
      </div>
      <div className="space-y-2 border-t px-6 py-3">
        {dupes && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert" data-testid="customer-duplicates">
            <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" />This phone number or email already belongs to:</p>
            <ul className="mt-1 list-disc pl-5">{dupes.map((d) => <li key={d.id}><a className="underline" href={`/support/customers/${d.id}`} target="_blank" rel="noreferrer">{d.display_name} ({d.customer_code})</a></li>)}</ul>
            <p className="mt-1">Customers are never merged automatically. Save only if this is a different customer.</p>
          </div>
        )}
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          {dupes ? <Button type="button" disabled={busy} onClick={() => void submit(true)}>{busy && <Loader2 className="animate-spin" />}Save as a different customer</Button>
            : <Button type="submit" disabled={busy} data-testid="customer-save">{busy && <Loader2 className="animate-spin" />}{existing ? 'Save customer' : 'Create customer'}</Button>}
        </DialogFooter>
      </div>
    </form>
  )
}
