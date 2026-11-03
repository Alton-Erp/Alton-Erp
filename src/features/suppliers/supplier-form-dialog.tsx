import { AlertTriangle, Loader2 } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useGstStates } from '@/features/billing/use-gst-states'
import {
  emptySupplierForm,
  findPossibleDuplicates,
  formFromSupplier,
  isIndia,
  PAYMENT_TERMS_LABELS,
  SUPPLIER_CATEGORY_LABELS,
  supplierName,
  toSupplierPayload,
  validateSupplierForm,
  type PossibleDuplicate,
  type SupplierFormErrors,
  type SupplierFormValues,
} from '@/features/suppliers/supplier-model'
import { useAsync } from '@/hooks/use-async'
import { createSupplier, describeSupplierError, fetchSuppliers, updateSupplier } from '@/services/suppliers'
import type { SupplierCategory, SupplierPaymentTerms, SupplierRow } from '@/types/database-suppliers'

type Key = keyof SupplierFormValues
const FIELD_ORDER: Key[] = ['supplier_code', 'legal_name', 'display_name', 'contact_person', 'phone', 'alternate_phone', 'email', 'gstin', 'pan',
  'billing_address', 'shipping_address', 'city', 'pin_code', 'country', 'custom_payment_days', 'notes']

interface SupplierFormDialogProps {
  /** null = new supplier. */
  supplier: SupplierRow | null
  companyId: string
  /** Suppliers already loaded by the caller (used for duplicate warnings); fetched when omitted. */
  existing?: SupplierRow[]
  onClose: () => void
  onSaved: (saved: { id: string; code: string; created: boolean }) => void
}

/**
 * Add / edit supplier. Field-level validation mirrors the database checks;
 * likely duplicates (same name, PAN, phone or e-mail) must be confirmed, and
 * same code / GSTIN cannot be saved at all. Status changes on an existing
 * supplier go through Deactivate / Activate (with confirmation) instead.
 */
export function SupplierFormDialog({ supplier, companyId, existing, onClose, onSaved }: SupplierFormDialogProps) {
  const isNew = supplier === null
  const [v, setV] = useState<SupplierFormValues>(() => (supplier ? formFromSupplier(supplier) : emptySupplierForm()))
  const [shipSame, setShipSame] = useState(() => !supplier?.shipping_address)
  const [errors, setErrors] = useState<SupplierFormErrors>({})
  const [warnings, setWarnings] = useState<string[]>([])
  const [duplicates, setDuplicates] = useState<PossibleDuplicate[] | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const all = useAsync(() => (existing ? Promise.resolve(existing) : fetchSuppliers()), [existing])
  const { states } = useGstStates()

  const set = <K extends Key>(key: K) => (value: SupplierFormValues[K]) => {
    setV((x) => ({ ...x, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
    setDuplicates(null) // details changed: re-check duplicates on the next save
  }

  const save = async (confirmedDuplicates: boolean) => {
    setFormError(null)
    const values = shipSame ? { ...v, shipping_address: '' } : v
    const result = validateSupplierForm(values, isNew)
    setErrors(result.errors)
    setWarnings(result.warnings)
    const firstInvalid = FIELD_ORDER.find((k) => result.errors[k])
    if (firstInvalid) {
      setFormError('Please correct the highlighted fields.')
      document.getElementById(`sup-${firstInvalid}`)?.focus()
      return
    }

    const found = findPossibleDuplicates(values, all.data ?? [], supplier?.id)
    const blocking = found.filter((d) => d.blocking)
    if (blocking.length) {
      const d = blocking[0]
      const field: Key = d.reason === 'same GSTIN' ? 'gstin' : 'supplier_code'
      setErrors((e) => ({ ...e, [field]: `Already used by ${d.supplier.supplier_code} — ${supplierName(d.supplier)}.` }))
      setFormError(`This supplier already exists (${d.reason}): ${d.supplier.supplier_code} — ${supplierName(d.supplier)}.`)
      document.getElementById(`sup-${field}`)?.focus()
      return
    }
    if (found.length && !confirmedDuplicates) {
      setDuplicates(found)
      return
    }

    setBusy(true)
    try {
      const payload = toSupplierPayload(values)
      if (isNew) {
        const row = await createSupplier(companyId, payload)
        onSaved({ id: row.id, code: row.supplier_code, created: true })
      } else {
        // Code and status are not changed from this form.
        const { supplier_code: _code, status: _status, ...changes } = payload
        void _code
        void _status
        await updateSupplier(supplier.id, changes)
        onSaved({ id: supplier.id, code: supplier.supplier_code, created: false })
      }
    } catch (e) {
      const message = describeSupplierError(e)
      if (/GSTIN/.test(message) && /already/.test(message)) setErrors((x) => ({ ...x, gstin: message }))
      if (/supplier code/.test(message)) setErrors((x) => ({ ...x, supplier_code: message }))
      setFormError(message)
      setBusy(false)
    }
  }

  const field = (key: Key, label: string, input: ReactNode, opts: { hint?: string; full?: boolean; required?: boolean } = {}) => (
    <div className={opts.full ? 'space-y-1 sm:col-span-2' : 'space-y-1'}>
      <Label htmlFor={`sup-${key}`}>
        {label}
        {opts.required && <span aria-hidden className="text-shortage"> *</span>}
      </Label>
      {input}
      {errors[key] ? (
        <p id={`sup-${key}-error`} className="text-xs text-red-700">{errors[key]}</p>
      ) : (
        opts.hint && <p id={`sup-${key}-hint`} className="text-xs text-muted-foreground">{opts.hint}</p>
      )}
    </div>
  )
  const a11y = (key: Key, hint?: boolean) => ({
    id: `sup-${key}`,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `sup-${key}-error` : hint ? `sup-${key}-hint` : undefined,
  })
  const text = (key: Key, props: ComponentProps<typeof Input> = {}, hint?: boolean) => (
    <Input {...a11y(key, hint)} value={v[key] as string} onChange={(e) => set(key)(e.target.value as never)} {...props} />
  )
  const india = isIndia(v.country)

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add supplier' : `Edit ${supplier.supplier_code}`}</DialogTitle>
          <DialogDescription>
            Fields marked * are required. {isNew ? 'Leave the code blank to number it automatically (SUP-000001). ' : 'The supplier code cannot be changed. '}
            GSTIN is optional — unregistered and overseas suppliers do not have one.
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save(false)
          }}
          className="space-y-5"
        >
          {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{formError}</p>}

          <Section title="Identity">
            {field('supplier_code', 'Supplier code',
              text('supplier_code', { maxLength: 30, disabled: !isNew, placeholder: isNew ? 'Automatic' : undefined, onChange: (e) => set('supplier_code')(e.target.value.toUpperCase()) }, true),
              { hint: isNew ? 'Optional. Unique within your company.' : undefined })}
            {field('category', 'Supplier category', (
              <Select value={v.category} onValueChange={(x) => set('category')(x as SupplierCategory)}>
                <SelectTrigger id="sup-category" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(SUPPLIER_CATEGORY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            ), { required: true })}
            {field('legal_name', 'Legal business name', text('legal_name', { maxLength: 200, autoComplete: 'organization', required: true }), { full: true, required: true })}
            {field('display_name', 'Display name', text('display_name', { maxLength: 200 }, true), { full: true, hint: 'Optional short name used in lists. Defaults to the legal name.' })}
          </Section>

          <Section title="Contact">
            {field('contact_person', 'Contact person', text('contact_person', { maxLength: 120, autoComplete: 'name' }))}
            {field('email', 'E-mail', text('email', { type: 'email', maxLength: 320, autoComplete: 'email' }))}
            {field('phone', 'Primary phone', text('phone', { type: 'tel', maxLength: 20, autoComplete: 'tel', placeholder: '+91 98200 12345' }))}
            {field('alternate_phone', 'Alternate phone', text('alternate_phone', { type: 'tel', maxLength: 20 }))}
          </Section>

          <Section title="Tax registration">
            {field('gstin', 'GSTIN', text('gstin', { maxLength: 15, onChange: (e) => set('gstin')(e.target.value.toUpperCase()) }, true), { hint: 'Optional. 15 characters.' })}
            {field('pan', 'PAN', text('pan', { maxLength: 10, onChange: (e) => set('pan')(e.target.value.toUpperCase()) }, true), { hint: 'Optional. Must match the GSTIN when both are given.' })}
          </Section>

          <Section title="Address">
            {field('billing_address', 'Billing address', <Textarea {...a11y('billing_address')} rows={2} maxLength={1000} value={v.billing_address} onChange={(e) => set('billing_address')(e.target.value)} />, { full: true })}
            <div className="flex items-center gap-2 sm:col-span-2">
              <Checkbox id="sup-ship-same" checked={shipSame} onCheckedChange={(c) => setShipSame(c === true)} />
              <Label htmlFor="sup-ship-same" className="font-normal">Dispatch address is the same as billing</Label>
            </div>
            {!shipSame && field('shipping_address', 'Shipping / dispatch address',
              <Textarea {...a11y('shipping_address')} rows={2} maxLength={1000} value={v.shipping_address} onChange={(e) => set('shipping_address')(e.target.value)} />, { full: true })}
            {field('city', 'City', text('city', { maxLength: 100, autoComplete: 'address-level2' }))}
            {field('state_code', 'State', (
              <Select value={v.state_code || 'none'} onValueChange={(x) => set('state_code')(x === 'none' ? '' : x)}>
                <SelectTrigger id="sup-state_code" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">Not set</SelectItem>
                  {states.map((s) => <SelectItem key={s.code} value={s.code}>{s.name} ({s.code})</SelectItem>)}
                </SelectContent>
              </Select>
            ))}
            {field('pin_code', india ? 'PIN code' : 'Postcode', text('pin_code', { maxLength: 12, inputMode: india ? 'numeric' : undefined, autoComplete: 'postal-code' }))}
            {field('country', 'Country', text('country', { maxLength: 60, autoComplete: 'country-name' }), { required: true })}
          </Section>

          <Section title="Terms and notes">
            {field('payment_terms', 'Payment terms', (
              <Select value={v.payment_terms} onValueChange={(x) => set('payment_terms')(x as SupplierPaymentTerms)}>
                <SelectTrigger id="sup-payment_terms" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(PAYMENT_TERMS_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            ), { required: true })}
            {v.payment_terms === 'CUSTOM'
              ? field('custom_payment_days', 'Custom payment days', text('custom_payment_days', { inputMode: 'numeric', maxLength: 3, placeholder: 'e.g. 60' }), { required: true })
              : <div aria-hidden className="hidden sm:block" />}
            {isNew ? field('status', 'Status', (
              <Select value={v.status} onValueChange={(x) => set('status')(x as 'ACTIVE' | 'INACTIVE')}>
                <SelectTrigger id="sup-status" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="ACTIVE">Active</SelectItem><SelectItem value="INACTIVE">Inactive</SelectItem></SelectContent>
              </Select>
            ), { hint: 'Inactive suppliers cannot be chosen for new purchase orders.' }) : null}
            {field('notes', 'Notes', <Textarea {...a11y('notes')} rows={3} maxLength={2000} value={v.notes} onChange={(e) => set('notes')(e.target.value)} />, { full: true })}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Bank details are not stored in the supplier master: it is visible to every user with supplier access. Record them in your payables system.
            </p>
          </Section>

          {warnings.length > 0 && (
            <ul role="status" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          {duplicates && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-medium"><AlertTriangle aria-hidden className="size-4" /> This may be a duplicate of an existing supplier:</p>
              <ul className="mt-2 list-disc space-y-0.5 pl-6">
                {duplicates.map((d) => (
                  <li key={d.supplier.id}>
                    {d.supplier.supplier_code} — {supplierName(d.supplier)}{d.supplier.status === 'INACTIVE' ? ' (inactive)' : ''}: {d.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2">Check it is a different supplier before saving.</p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            {duplicates ? (
              <Button type="button" disabled={busy} onClick={() => void save(true)}>
                {busy && <Loader2 className="animate-spin" />} Save anyway
              </Button>
            ) : (
              <Button type="submit" disabled={busy || all.loading}>
                {busy && <Loader2 className="animate-spin" />} {isNew ? 'Save supplier' : 'Save changes'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 w-full border-b pb-1.5 text-sm font-semibold text-foreground sm:col-span-2">{title}</legend>
      {children}
    </fieldset>
  )
}
