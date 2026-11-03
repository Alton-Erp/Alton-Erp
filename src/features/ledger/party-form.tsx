import { AlertTriangle, Loader2, UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useGstStates } from '@/features/billing/use-gst-states'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchParty, saveParty, type DuplicateParty, type SavePartyResult } from '@/services/ledger'
import {
  BALANCE_TYPE_LABELS,
  EMPTY_PARTY,
  PARTY_TYPE_LABELS,
  PARTY_TYPES,
  SUPPLIER_CATEGORIES,
  SUPPLIER_CATEGORY_LABELS,
  partyToForm,
  validateParty,
  type PartyField,
  type PartyFormValues,
  type PartyType,
} from './ledger-model'

export function Field({ id, label, error, hint, full, required, children }: {
  id: string; label: string; error?: string; hint?: string; full?: boolean; required?: boolean; children: ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', full && 'sm:col-span-2')}>
      <Label htmlFor={id}>{label}{required && <span className="text-shortage">*</span>}</Label>
      {children}
      {error ? <p className="text-xs text-shortage">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** The editable party fields. `compact` shows only what quick-add needs. */
export function PartyFields({ values, onChange, errors, compact = false, lockType = false, idPrefix = 'pt' }: {
  values: PartyFormValues
  onChange: (next: PartyFormValues) => void
  errors: Partial<Record<PartyField, string>>
  compact?: boolean
  lockType?: boolean
  idPrefix?: string
}) {
  const { states } = useGstStates()
  const set = (k: PartyField) => (e: { target: { value: string } }) => onChange({ ...values, [k]: e.target.value })
  const id = (k: string) => `${idPrefix}-${k}`
  const supplier = values.party_type === 'SUPPLIER' || values.party_type === 'BOTH'
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {!lockType && (
        <fieldset className="space-y-1.5 sm:col-span-2">
          <legend className="text-sm font-medium">Party type<span className="text-shortage">*</span></legend>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Party type">
            {PARTY_TYPES.map((tp) => (
              <button key={tp} type="button" role="radio" aria-checked={values.party_type === tp} onClick={() => onChange({ ...values, party_type: tp })}
                className={cn('rounded-lg border px-3 py-2 text-left text-sm transition-colors', values.party_type === tp ? 'border-primary bg-accent font-medium ring-1 ring-primary' : 'hover:bg-muted')}>
                {PARTY_TYPE_LABELS[tp]}
              </button>
            ))}
          </div>
          {errors.party_type && <p className="text-xs text-shortage">{errors.party_type}</p>}
        </fieldset>
      )}
      <Field id={id('name')} label="Party name" required error={errors.party_name} full={compact}>
        <Input id={id('name')} value={values.party_name} onChange={set('party_name')} maxLength={200} autoFocus />
      </Field>
      {!compact && (
        <Field id={id('legal')} label="Legal name (if different)" hint="Printed on invoices and purchase orders.">
          <Input id={id('legal')} value={values.legal_name} onChange={set('legal_name')} maxLength={200} />
        </Field>
      )}
      <Field id={id('gstin')} label="GSTIN" error={errors.gstin} hint="State and PAN are filled from it.">
        <Input id={id('gstin')} value={values.gstin} onChange={(e) => onChange({ ...values, gstin: e.target.value.toUpperCase() })} maxLength={15} autoComplete="off" />
      </Field>
      {!compact && (
        <Field id={id('pan')} label="PAN" error={errors.pan}>
          <Input id={id('pan')} value={values.pan} onChange={(e) => onChange({ ...values, pan: e.target.value.toUpperCase() })} maxLength={10} autoComplete="off" />
        </Field>
      )}
      <Field id={id('phone')} label="Mobile" error={errors.phone}>
        <Input id={id('phone')} inputMode="tel" value={values.phone} onChange={set('phone')} maxLength={20} />
      </Field>
      <Field id={id('email')} label="E-mail" error={errors.email}>
        <Input id={id('email')} type="email" value={values.email} onChange={set('email')} maxLength={320} />
      </Field>
      {!compact && (
        <Field id={id('contact')} label="Contact person">
          <Input id={id('contact')} value={values.contact_person} onChange={set('contact_person')} maxLength={120} />
        </Field>
      )}
      <Field id={id('state')} label="State" hint={values.gstin.length >= 2 && !values.state_code ? 'Taken from the GSTIN when saved.' : undefined}>
        <Select value={values.state_code || 'none'} onValueChange={(v) => onChange({ ...values, state_code: v === 'none' ? '' : v })}>
          <SelectTrigger id={id('state')}><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="none">Not set</SelectItem>
            {states.map((s) => <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field id={id('city')} label="City">
        <Input id={id('city')} value={values.city} onChange={set('city')} maxLength={100} />
      </Field>
      <Field id={id('bill')} label="Billing address" full>
        <Textarea id={id('bill')} rows={2} value={values.billing_address} onChange={set('billing_address')} maxLength={1000} />
      </Field>
      {!compact && (
        <>
          <Field id={id('ship')} label="Shipping address" hint="Leave blank if the same as billing." full>
            <Textarea id={id('ship')} rows={2} value={values.shipping_address} onChange={set('shipping_address')} maxLength={1000} />
          </Field>
          <Field id={id('pin')} label="PIN code" error={errors.pin_code}>
            <Input id={id('pin')} value={values.pin_code} onChange={set('pin_code')} maxLength={12} />
          </Field>
          <Field id={id('country')} label="Country">
            <Input id={id('country')} value={values.country} onChange={set('country')} maxLength={60} />
          </Field>
        </>
      )}
      <Field id={id('days')} label="Credit period (days)" error={errors.credit_period_days} hint="Days allowed for payment.">
        <Input id={id('days')} inputMode="numeric" value={values.credit_period_days} onChange={set('credit_period_days')} maxLength={3} />
      </Field>
      {!compact && (
        <>
          <Field id={id('terms')} label="Payment terms" hint="E.g. 50% advance, balance on delivery.">
            <Input id={id('terms')} value={values.payment_terms_note} onChange={set('payment_terms_note')} maxLength={200} />
          </Field>
          {supplier && (
            <Field id={id('cat')} label="Supplier category">
              <Select value={values.supplier_category || 'none'} onValueChange={(v) => onChange({ ...values, supplier_category: v === 'none' ? '' : v })}>
                <SelectTrigger id={id('cat')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {SUPPLIER_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{SUPPLIER_CATEGORY_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field id={id('ob')} label="Opening balance (₹)" error={errors.opening_balance} hint="Amount outstanding when you start using the ERP.">
            <Input id={id('ob')} inputMode="decimal" value={values.opening_balance} onChange={set('opening_balance')} />
          </Field>
          <Field id={id('obt')} label="Balance type" error={errors.opening_balance_type}>
            <Select value={values.opening_balance_type || 'auto'} onValueChange={(v) => onChange({ ...values, opening_balance_type: v === 'auto' ? '' : (v as PartyFormValues['opening_balance_type']) })}>
              <SelectTrigger id={id('obt')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{values.party_type === 'CUSTOMER' ? 'Receivable (default)' : values.party_type === 'SUPPLIER' ? 'Payable (default)' : 'Choose'}</SelectItem>
                <SelectItem value="RECEIVABLE">{BALANCE_TYPE_LABELS.RECEIVABLE}</SelectItem>
                <SelectItem value="PAYABLE">{BALANCE_TYPE_LABELS.PAYABLE}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id={id('obd')} label="Opening balance date" hint="Default: today.">
            <Input id={id('obd')} type="date" value={values.opening_balance_date} onChange={set('opening_balance_date')} />
          </Field>
          <div className="sm:col-span-2"><p className="text-sm font-medium">Bank details (optional)</p></div>
          <Field id={id('bank')} label="Bank name">
            <Input id={id('bank')} value={values.bank_name} onChange={set('bank_name')} maxLength={100} />
          </Field>
          <Field id={id('acname')} label="Account name">
            <Input id={id('acname')} value={values.bank_account_name} onChange={set('bank_account_name')} maxLength={120} />
          </Field>
          <Field id={id('acno')} label="Account number" error={errors.bank_account_number}>
            <Input id={id('acno')} value={values.bank_account_number} onChange={set('bank_account_number')} maxLength={40} autoComplete="off" />
          </Field>
          <Field id={id('ifsc')} label="IFSC" error={errors.bank_ifsc}>
            <Input id={id('ifsc')} value={values.bank_ifsc} onChange={(e) => onChange({ ...values, bank_ifsc: e.target.value.toUpperCase() })} maxLength={11} autoComplete="off" />
          </Field>
          <Field id={id('remarks')} label="Remarks" error={errors.remarks} full>
            <Textarea id={id('remarks')} rows={2} value={values.remarks} onChange={set('remarks')} maxLength={2000} />
          </Field>
        </>
      )}
    </div>
  )
}

/** Possible duplicates returned by the server, with a choice to use one of them or save anyway. */
export function DuplicatePanel({ duplicates, onUse, onSaveAnyway, busy }: {
  duplicates: DuplicateParty[]
  onUse?: (d: DuplicateParty) => void
  onSaveAnyway: () => void
  busy?: boolean
}) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> This party may already exist</p>
      <ul className="space-y-1.5">
        {duplicates.map((d) => (
          <li key={d.party_id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <Link className="font-medium underline-offset-2 hover:underline" to={`/ledger/${d.party_id}`} target="_blank">{d.party_code} — {d.party_name}</Link>
              {' '}({PARTY_TYPE_LABELS[d.party_type as PartyType] ?? d.party_type}) · same {d.matched_on.join(', ')}
            </span>
            {onUse && <Button size="sm" variant="outline" disabled={busy} onClick={() => onUse(d)}>Use this party</Button>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={busy} onClick={onSaveAnyway}>It is a different party — save anyway</Button>
      </div>
    </div>
  )
}

export interface QuickAddResult { partyId: string; partyCode: string; roleId: string; name: string }

/**
 * Quick add from a transaction screen (purchase order, sales order). Creates a
 * customer or supplier party with the essentials; everything else can be added
 * later in the Ledger. If the party already exists, the user can use it (its
 * missing role is added, making it Customer & Supplier) instead of creating a
 * duplicate.
 */
export function QuickAddPartyDialog({ role, onClose, onCreated, initialName = '' }: {
  role: 'CUSTOMER' | 'SUPPLIER'
  onClose: () => void
  onCreated: (r: QuickAddResult) => void
  initialName?: string
}) {
  const [values, setValues] = useState<PartyFormValues>({ ...EMPTY_PARTY, party_type: role, party_name: initialName })
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateParty[] | null>(null)
  const { key, renew } = useRequestKey()
  const validation = validateParty(values)
  const errors = submitted ? validation.errors : {}
  const label = role === 'CUSTOMER' ? 'customer' : 'supplier'

  const finish = (r: Extract<SavePartyResult, { ok: true }>) => {
    const roleId = role === 'CUSTOMER' ? r.customer_id : r.supplier_id
    if (!roleId) throw new Error(`The party was saved but has no ${label} record.`)
    onCreated({ partyId: r.party_id, partyCode: r.party_code, roleId, name: values.party_name.trim() })
  }

  const save = async (confirm: boolean) => {
    setSubmitted(true)
    setError(null)
    if (!validation.payload) return
    setBusy(true)
    try {
      const r = await saveParty(null, validation.payload, confirm, key)
      if (!r.ok) {
        setDuplicates(r.duplicates)
        renew()
      } else {
        finish(r)
      }
    } catch (e) {
      setError(describeDataError(e))
      renew()
    } finally {
      setBusy(false)
    }
  }

  // Use an existing party: add the missing role if needed (no duplicate is created).
  const chooseExisting = async (d: DuplicateParty) => {
    setBusy(true)
    setError(null)
    try {
      const p = await fetchParty(d.party_id)
      const hasRole = role === 'CUSTOMER' ? p.party_type !== 'SUPPLIER' : p.party_type !== 'CUSTOMER'
      const roleActive = (role === 'CUSTOMER' ? p.customer_status : p.supplier_status) === 'ACTIVE'
      if (hasRole && roleActive) {
        onCreated({ partyId: p.party_id, partyCode: p.party_code, roleId: (role === 'CUSTOMER' ? p.customer_id : p.supplier_id)!, name: p.party_name })
        return
      }
      // Missing role: add it (party becomes Customer & Supplier). Inactive role: reactivate it.
      const form = { ...partyToForm(p), party_type: hasRole ? p.party_type : ('BOTH' as const), status: 'ACTIVE' as const }
      const v = validateParty(form)
      if (!v.payload) throw new Error(`Open ${p.party_code} in the Ledger and complete its details first: ${Object.values(v.errors).join(' ')}`)
      const r = await saveParty(p.party_id, v.payload, true, null)
      if (!r.ok) throw new Error('The party could not be updated.')
      onCreated({ partyId: r.party_id, partyCode: r.party_code, roleId: (role === 'CUSTOMER' ? r.customer_id : r.supplier_id)!, name: p.party_name })
    } catch (e) {
      setError(e instanceof Error && !('code' in e) ? e.message : describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserPlus className="size-5" /> New {label}</DialogTitle>
          <DialogDescription>Only the name is required. Add GSTIN and state for correct GST; the rest can be completed later in the Ledger.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {duplicates && duplicates.length > 0 && (
          <DuplicatePanel duplicates={duplicates} busy={busy} onUse={(d) => void chooseExisting(d)} onSaveAnyway={() => void save(true)} />
        )}
        <PartyFields values={values} onChange={(v) => { setValues(v); setDuplicates(null) }} errors={errors} compact lockType idPrefix={`qa-${role.toLowerCase()}`} />
        {validation.warnings.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-800">{validation.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save(false)} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save {label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
