import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CustomerPicker } from '@/features/support/customer-picker'
import { CustomerMatchPanel } from '@/features/support/customers/customer-match-panel'
import { AgentSelect, Field } from '@/features/support/support-components'
import { PRIORITIES, PRIORITY_META, validateTicket, type FieldErrors, type Priority, type TicketInput } from '@/features/support/support-model'
import { CustomFieldInput } from '@/features/support/ticket-fields/custom-field-input'
import { checkFieldValue, formulaInputsOf, toInput, type FormField, type InputValue } from '@/features/support/ticket-fields/field-model'
import { quantityError, type PickedProduct } from '@/features/support/ticket-fields/product-model'
import { ProductMasterPicker } from '@/features/support/ticket-fields/product-picker'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchAgents } from '@/services/support'
import { createTicketWithFields, type TicketForm } from '@/services/ticket-fields'

type Custom = Extract<FormField, { kind: 'CUSTOM' }>

/**
 * New Ticket with the administrator's layout (Support → Settings → Ticket fields): standard fields, custom fields and
 * the Product Master selector in the configured order; required fields checked here and again by the database,
 * which saves the ticket, its values and its products in one transaction.
 */
export function NewTicketForm({ form, conversation, customer, pipelineId, renderCustomerDialog, onCreated, onCancel }: {
  form: TicketForm
  /** The customer form ("Create new customer" when the phone / email matches nobody). */
  renderCustomerDialog?: (p: { open: boolean; onOpenChange: (o: boolean) => void; preset: { phones: string; emails: string }; onSaved: (id: string, label?: string) => void }) => ReactNode
  pipelineId?: string | null
  conversation?: { id: string; subject: string | null } | null
  customer?: { id: string; label: string } | null
  onCreated: (r: { id: string; ticket_number: string }) => void
  onCancel: () => void
}) {
  const customs = useMemo(() => form.fields.filter((f): f is Custom => f.kind === 'CUSTOM'), [form])
  const [v, setV] = useState<TicketInput>(() => ({ subject: conversation?.subject ?? '', customer_id: '', customer_phone: '', customer_email: '', priority: 'NORMAL', category: '',
    subcategory: '', department: '', description: '', conversation_id: conversation?.id }))
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(customer ?? null)
  const [agent, setAgent] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, InputValue>>(() => Object.fromEntries(customs.map((f) => [f.field_key, toInput(f, f.default_value)])))
  const [products, setProducts] = useState<PickedProduct[]>([])
  const [includeArchived, setIncludeArchived] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  // Required fields found empty on Create: [error key, label]. Listed while their error is still shown.
  const [missing, setMissing] = useState<[string, string][]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newCustomer, setNewCustomer] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  // A field's error goes as soon as the field is changed.
  const clear = (...keys: string[]) => setErrors((e) => {
    if (!keys.some((k) => k in e)) return e
    const n = { ...e }
    for (const k of keys) delete n[k]
    return n
  })
  const set = (k: keyof TicketInput) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [k]: e.target.value }))
    clear(k, ...(k === 'customer_phone' || k === 'customer_email' ? ['customer'] : []))
  }
  const has = (k: string) => form.fields.some((f) => f.kind === 'STANDARD' && f.standard_key === k)
  const requiredStd = (k: string) => form.fields.some((f) => f.kind === 'STANDARD' && f.standard_key === k && f.required)
  const showProducts = has('products') && form.products.manage

  const submit = async () => {
    const errs: FieldErrors = validateTicket({ ...v, customer_id: picked?.id ?? '', customer_phone: has('customer_phone') ? v.customer_phone : '', customer_email: has('customer_email') ? v.customer_email : '' })
    const need: [string, string][] = []
    const label = (k: string) => (form.fields.find((f) => f.kind === 'STANDARD' && f.standard_key === k) as { label: string } | undefined)?.label ?? k
    for (const k of ['category', 'subcategory', 'department', 'description'] as const) if (requiredStd(k) && !v[k].trim()) { errs[k] = 'Required.'; need.push([k, label(k)]) }
    if (requiredStd('assigned_agent') && !agent) { errs.assigned_agent = 'Required.'; need.push(['assigned_agent', label('assigned_agent')]) }
    if (showProducts && requiredStd('products') && products.length === 0) { errs.products = 'Add at least one product.'; need.push(['products', label('products')]) }
    if (products.some((p) => quantityError(p.quantity))) errs.products = 'Check the product quantities.'
    const custom: Record<string, unknown> = {}
    for (const f of customs) {
      if (f.field_type === 'FORMULA') continue
      const r = checkFieldValue(f, values[f.field_key] ?? null)
      if (r.error) errs[f.field_key] = r.error
      else if (f.required && (r.value === null || r.value === '')) { errs[f.field_key] = 'Required.'; need.push([f.field_key, f.field_label]) }
      // Every key is sent (null when empty) so a cleared default stays cleared.
      custom[f.field_key] = r.value
    }
    if (errs.subject) need.unshift(['subject', 'Subject'])
    if (errs.customer) need.push(['customer', 'Customer (or phone / email)'])
    setErrors(errs)
    setMissing(need)
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
      return
    }
    setBusy(true); setError(null)
    try {
      const r = await createTicketWithFields({ subject: v.subject.trim(), conversation_id: conversation?.id ?? null, customer_id: picked?.id ?? null,
        customer_phone: has('customer_phone') ? v.customer_phone.trim() || null : null, customer_email: has('customer_email') ? v.customer_email.trim() || null : null,
        priority: v.priority, category: v.category.trim() || null, subcategory: v.subcategory.trim() || null, department: v.department.trim() || null,
        description: v.description.trim() || null, assigned_agent_id: agent, custom_fields: custom, ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        products: showProducts ? products.map((p) => ({ product_id: p.product_id, quantity: p.quantity.trim() })) : [], allow_archived_products: includeArchived && products.some((p) => p.archived) })
      onCreated(r)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const label = (text: string, required: boolean) => (required ? `${text} *` : text)
  // Matching customers appear under the later of the phone / email fields.
  const order = form.fields.map((f) => (f.kind === 'STANDARD' ? f.standard_key : ''))
  const matchHost = order.lastIndexOf('customer_email') > order.lastIndexOf('customer_phone') ? 'customer_email' : 'customer_phone'
  const matches = <CustomerMatchPanel key="matches" phone={v.customer_phone} email={v.customer_email}
    onPick={(c) => { setPicked(c); clear('customer', 'customer_phone', 'customer_email') }} onCreate={() => setNewCustomer(true)} />
  const standard = (f: Extract<FormField, { kind: 'STANDARD' }>) => {
    const req = f.required
    switch (f.standard_key) {
      case 'subject':
        return <Field key="subject" label={label('Subject', true)} htmlFor="tk-subject" error={errors.subject} className="sm:col-span-2">
          <Input id="tk-subject" value={v.subject} onChange={set('subject')} maxLength={200} aria-invalid={Boolean(errors.subject) || undefined} className="text-base" /></Field>
      case 'customer':
        return conversation ? null : <Field key="customer" label="Customer" htmlFor="tk-customer" error={errors.customer} className="sm:col-span-2"
          hint={!picked && (has('customer_phone') || has('customer_email')) ? 'Or enter the phone number or email address below.' : undefined}>
          <div data-invalid={Boolean(errors.customer) || undefined}><CustomerPicker id="tk-customer" value={picked} onChange={(c) => { setPicked(c); clear('customer') }} /></div>
          {picked && <a className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline" href={`/support/customers/${picked.id}`} target="_blank" rel="noreferrer"
            data-testid="picked-customer-profile">Open customer profile<ExternalLink className="size-3" /></a>}</Field>
      case 'products':
        return showProducts ? <Field key="products" label={label('Products (Product Master)', req)} htmlFor="tk-products" error={errors.products} className="sm:col-span-2">
          <ProductMasterPicker value={products} onChange={(x) => { setProducts(x); clear('products') }} canIncludeArchived={form.products.archived} includeArchived={includeArchived} onIncludeArchived={setIncludeArchived}
            invalid={Boolean(errors.products)} /></Field> : null
      case 'customer_phone':
        return conversation || picked ? null : [<Field key="phone" label="Phone" htmlFor="tk-phone" error={errors.customer_phone}>
          <Input id="tk-phone" value={v.customer_phone} onChange={set('customer_phone')} inputMode="tel" aria-invalid={Boolean(errors.customer_phone) || undefined} /></Field>,
          matchHost === 'customer_phone' && matches]
      case 'customer_email':
        return conversation || picked ? null : [<Field key="email" label="Email" htmlFor="tk-email" error={errors.customer_email}>
          <Input id="tk-email" value={v.customer_email} onChange={set('customer_email')} inputMode="email" aria-invalid={Boolean(errors.customer_email) || undefined} /></Field>,
          matchHost === 'customer_email' && matches]
      case 'priority':
        return <Field key="priority" label="Priority" htmlFor="tk-priority">
          <Select value={v.priority} onValueChange={(p) => setV((x) => ({ ...x, priority: p as Priority }))}>
            <SelectTrigger id="tk-priority" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
          </Select></Field>
      case 'assigned_agent':
        return <Field key="agent" label={label('Assigned agent', req)} htmlFor="tk-agent" error={errors.assigned_agent}>
          <div data-invalid={Boolean(errors.assigned_agent) || undefined}><AgentSelect id="tk-agent" agents={agents.data ?? []} value={agent} onChange={(a) => { setAgent(a); clear('assigned_agent') }} /></div></Field>
      case 'category': case 'subcategory': case 'department':
        return <Field key={f.standard_key} label={label(f.label, req)} htmlFor={`tk-${f.standard_key}`} error={errors[f.standard_key]}>
          <Input id={`tk-${f.standard_key}`} value={v[f.standard_key]} onChange={set(f.standard_key)} maxLength={80} aria-invalid={Boolean(errors[f.standard_key]) || undefined} /></Field>
      case 'description':
        return <Field key="description" label={label('Description', req)} htmlFor="tk-description" error={errors.description} className="sm:col-span-2">
          <Textarea id="tk-description" value={v.description} onChange={set('description')} rows={4} maxLength={10000} aria-invalid={Boolean(errors.description) || undefined} /></Field>
    }
  }
  const inputs = formulaInputsOf(customs, values)

  return (
    <form ref={formRef} className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate data-testid="new-ticket-form">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-6 py-4 sm:grid-cols-2">
        {form.fields.map((f) => f.kind === 'STANDARD' ? standard(f) : (
          <Field key={f.field_key} label={label(f.field_label, f.required)} htmlFor={`tk-cf-${f.field_key}`} error={errors[f.field_key]} hint={f.help_text ?? undefined}
            className={cn((f.field_type === 'TEXT' && (f.field_config.max_length ?? 255) > 255) && 'sm:col-span-2')}>
            <CustomFieldInput def={f} id={`tk-cf-${f.field_key}`} value={values[f.field_key] ?? null} invalid={Boolean(errors[f.field_key])} formulaInputs={inputs}
              onChange={(x) => { setValues((s) => ({ ...s, [f.field_key]: x })); clear(f.field_key) }} />
          </Field>
        ))}
      </div>
      <div className="space-y-2 border-t px-6 py-3">
        {missing.some(([k]) => k in errors) && (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="missing-fields">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />Fill in the required fields: {missing.filter(([k]) => k in errors).map(([, l]) => l).join(', ')}.</p>
        )}
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy} data-testid="create-ticket">{busy && <Loader2 className="animate-spin" />}Create ticket</Button>
        </DialogFooter>
      </div>
      {renderCustomerDialog?.({ open: newCustomer, onOpenChange: setNewCustomer, preset: { phones: v.customer_phone.trim(), emails: v.customer_email.trim() },
        onSaved: (id, l) => { setPicked({ id, label: l ?? 'New customer' }); clear('customer', 'customer_phone', 'customer_email') } })}
    </form>
  )
}
