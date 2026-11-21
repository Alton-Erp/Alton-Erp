import { AlertTriangle, Loader2 } from 'lucide-react'
import { useState, type ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CustomerPicker } from '@/features/support/customer-picker'
import { CustomerEditor } from '@/features/support/customers/customer-editor'
import { AgentSelect, Field } from '@/features/support/support-components'
import {
  CALL_STATUSES, CALL_STATUS_LABELS, CHANNELS, CHANNEL_LABELS, PRIORITIES, PRIORITY_META, splitList, validateCustomer, validateLog, validateTicket,
  type Channel, type CustomerInput, type FieldErrors, type Priority, type TicketInput,
} from '@/features/support/support-model'
import { NewTicketForm } from '@/features/support/ticket-fields/new-ticket-form'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import {
  createConversation, createTicket, fetchAgents, fetchErpCustomerOptions, saveCustomer, type CustomerProfile,
} from '@/services/support'
import { fetchCustomerForm, fetchCustomerWorkspace } from '@/services/customer-crm'
import { fetchTicketForm } from '@/services/ticket-fields'

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{text}</p> : null
}

export { CustomerPicker }

const emptyCustomer: CustomerInput = { display_name: '', company_name: '', phones: '', emails: '', address: '', notes: '' }

/**
 * Create or edit a support customer. A phone number or email that already belongs to another customer is shown and
 * the customer is created only when the agent confirms it is a different person; customers are never merged.
 */
export function CustomerFormDialog(props: ComponentProps<typeof CustomerForm>) {
  return props.open ? <CustomerFormLoader {...props} /> : null
}

/**
 * With the customer field builder (20261228090000) the form follows the configured layout and custom fields;
 * before that database update the earlier fixed form is shown.
 */
function CustomerFormLoader(props: ComponentProps<typeof CustomerForm>) {
  const form = useAsync(() => fetchCustomerForm().catch(() => null), [])
  const id = props.existing?.id ?? null
  const workspace = useAsync(() => (id ? fetchCustomerWorkspace(id).catch(() => null) : Promise.resolve(null)), [id])
  if ((form.loading && !form.data) || (id && workspace.loading && !workspace.data)) {
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{id ? 'Edit customer' : 'New customer'}</DialogTitle><DialogDescription>Loading the form…</DialogDescription></DialogHeader>
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" /></DialogContent>
      </Dialog>
    )
  }
  if (!form.data || (id && !workspace.data)) return <CustomerForm {...props} />
  const pr = props.preset
  const phones = pr?.phones ? splitList(pr.phones) : []
  const emails = pr?.emails ? splitList(pr.emails) : []
  const preset = pr ? { ...(pr.display_name ? { display_name: pr.display_name } : {}), ...(pr.company_name ? { company_name: pr.company_name } : {}),
    ...(phones[0] ? { mobile: phones[0] } : {}), ...(phones[1] ? { alternate_phone: phones[1] } : {}), ...(emails[0] ? { email: emails[0] } : {}),
    ...(pr.address ? { address: pr.address } : {}), ...(pr.notes ? { description: pr.notes } : {}) } : undefined
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] max-w-3xl flex-col gap-0 p-0" data-testid="customer-dialog">
        <DialogHeader className="border-b px-6 py-4"><DialogTitle>{id ? 'Edit customer' : 'New customer'}</DialogTitle>
          <DialogDescription>Phone numbers and emails are used to recognise the customer on calls, WhatsApp, email and new tickets. <span className="text-red-600">*</span> = required.</DialogDescription></DialogHeader>
        <CustomerEditor form={form.data} workspace={workspace.data} preset={preset}
          onSaved={(r) => { props.onSaved(r.id, r.label); props.onOpenChange(false) }} onCancel={() => props.onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function CustomerForm({ open, onOpenChange, existing, preset, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; existing?: CustomerProfile['customer'] | null
  preset?: Partial<CustomerInput>; onSaved: (id: string, label?: string) => void
}) {
  const [v, setV] = useState<CustomerInput>(() => existing ? { display_name: existing.display_name, company_name: existing.company_name ?? '', phones: existing.phones.join(', '),
    emails: existing.emails.join(', '), address: existing.address ?? '', notes: existing.notes ?? '' } : { ...emptyCustomer, ...preset })
  const [erp, setErp] = useState<string>(existing?.erp_customer_id ?? 'none')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [dupes, setDupes] = useState<{ id: string; customer_code: string; display_name: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const erpOptions = useAsync(() => fetchErpCustomerOptions().catch(() => []), [])
  const set = (k: keyof CustomerInput) => (e: { target: { value: string } }) => { setV((x) => ({ ...x, [k]: e.target.value })); setDupes(null) }
  const submit = async (allowDuplicate: boolean) => {
    const errs = validateCustomer(v)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setError(null)
    try {
      const r = await saveCustomer(existing?.id ?? null, { display_name: v.display_name.trim(), company_name: v.company_name.trim() || null, phones: splitList(v.phones),
        emails: splitList(v.emails), address: v.address.trim() || null, notes: v.notes.trim() || null, erp_customer_id: erp === 'none' ? null : erp }, allowDuplicate)
      if (!r.ok) { setDupes(r.duplicates); return }
      onSaved(r.id!)
      onOpenChange(false)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{existing ? 'Edit customer' : 'New customer'}</DialogTitle>
          <DialogDescription>Phone numbers and emails are used to recognise the customer on calls, WhatsApp and email.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(false) }} noValidate>
          <Field label="Name" htmlFor="sc-name" error={errors.display_name}><Input id="sc-name" value={v.display_name} onChange={set('display_name')} maxLength={200} /></Field>
          <Field label="Company" htmlFor="sc-company"><Input id="sc-company" value={v.company_name} onChange={set('company_name')} maxLength={200} /></Field>
          <Field label="Phone numbers" htmlFor="sc-phones" error={errors.phones} hint="Separate several with commas."><Input id="sc-phones" value={v.phones} onChange={set('phones')} inputMode="tel" /></Field>
          <Field label="Email addresses" htmlFor="sc-emails" error={errors.emails} hint="Separate several with commas."><Input id="sc-emails" value={v.emails} onChange={set('emails')} inputMode="email" /></Field>
          {errors.contact && <p className="text-xs text-red-700" role="alert">{errors.contact}</p>}
          <Field label="Address" htmlFor="sc-address" error={errors.address}><Textarea id="sc-address" value={v.address} onChange={set('address')} rows={2} maxLength={1000} /></Field>
          <Field label="Related ERP customer" htmlFor="sc-erp" hint={erpOptions.data && erpOptions.data.length === 0 ? 'No ERP customers are visible to your role.' : undefined}>
            <Select value={erp} onValueChange={setErp}>
              <SelectTrigger id="sc-erp"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72"><SelectItem value="none">None</SelectItem>
                {(erpOptions.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Customer notes" htmlFor="sc-notes" error={errors.notes}><Textarea id="sc-notes" value={v.notes} onChange={set('notes')} rows={2} maxLength={2000} /></Field>
          {dupes && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert" data-testid="customer-duplicates">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" />This phone number or email already belongs to:</p>
              <ul className="mt-1 list-disc pl-5">{dupes.map((d) => <li key={d.id}>{d.display_name} ({d.customer_code})</li>)}</ul>
              <p className="mt-1">Customers are never merged automatically. Save only if this is a different customer.</p>
            </div>
          )}
          <ErrorLine text={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {dupes ? <Button type="button" disabled={busy} onClick={() => void submit(true)}>{busy && <Loader2 className="animate-spin" />}Save as a different customer</Button>
              : <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save customer</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * New ticket, manually or from a conversation (the conversation's channel and customer are used). With the ticket
 * field builder (20261226090000) the form follows the configured layout, custom fields and Product Master products;
 * before that database update the earlier fixed form is shown.
 */
export function TicketFormDialog(props: ComponentProps<typeof TicketForm>) {
  return props.open ? <TicketFormLoader {...props} /> : null
}

function TicketFormLoader(props: ComponentProps<typeof TicketForm>) {
  const layout = useAsync(() => fetchTicketForm().catch(() => null), [])
  if (layout.loading && !layout.data) {
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>New ticket</DialogTitle><DialogDescription>Loading the form…</DialogDescription></DialogHeader>
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" /></DialogContent>
      </Dialog>
    )
  }
  if (!layout.data) return <TicketForm {...props} />
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] max-w-3xl flex-col gap-0 p-0" data-testid="ticket-dialog">
        <DialogHeader className="border-b px-6 py-4"><DialogTitle>{props.conversation ? 'Create ticket from conversation' : 'New ticket'}</DialogTitle>
          <DialogDescription>The ticket number and SLA targets are assigned when it is saved. <span className="text-red-600">*</span> = required.</DialogDescription></DialogHeader>
        <NewTicketForm form={layout.data} conversation={props.conversation} customer={props.customer} pipelineId={props.pipelineId}
          renderCustomerDialog={(p) => <CustomerFormDialog {...p} />}
          onCreated={(r) => { props.onCreated(r); props.onOpenChange(false) }} onCancel={() => props.onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function TicketForm({ open, onOpenChange, conversation, customer, onCreated }: {
  /** The pipeline board the ticket is created from (the configured form only; otherwise the default pipeline). */
  pipelineId?: string | null
  open: boolean; onOpenChange: (o: boolean) => void
  conversation?: { id: string; subject: string | null } | null
  customer?: { id: string; label: string } | null
  onCreated: (r: { id: string; ticket_number: string }) => void
}) {
  const [v, setV] = useState<TicketInput>(() => ({ subject: conversation?.subject ?? '', customer_id: '', customer_phone: '', customer_email: '', priority: 'NORMAL', category: '',
    subcategory: '', department: '', description: '', conversation_id: conversation?.id }))
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(customer ?? null)
  const [agent, setAgent] = useState<string | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const agents = useAsync(() => fetchAgents().catch(() => []), [])
  const set = (k: keyof TicketInput) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }))
  const submit = async () => {
    const input = { ...v, customer_id: picked?.id ?? '' }
    const errs = validateTicket(input)
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setError(null)
    try {
      const r = await createTicket({ subject: v.subject.trim(), conversation_id: conversation?.id ?? null, customer_id: picked?.id ?? null,
        customer_phone: v.customer_phone.trim() || null, customer_email: v.customer_email.trim() || null, priority: v.priority,
        category: v.category.trim() || null, subcategory: v.subcategory.trim() || null, department: v.department.trim() || null,
        description: v.description.trim() || null, assigned_agent_id: agent })
      onCreated(r)
      onOpenChange(false)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{conversation ? 'Create ticket from conversation' : 'New ticket'}</DialogTitle>
          <DialogDescription>The ticket number and SLA targets are assigned when it is saved.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <Field label="Subject" htmlFor="tk-subject" error={errors.subject} className="sm:col-span-2"><Input id="tk-subject" value={v.subject} onChange={set('subject')} maxLength={200} /></Field>
          {!conversation && (
            <>
              <Field label="Customer" htmlFor="tk-customer" error={errors.customer} className="sm:col-span-2"><CustomerPicker id="tk-customer" value={picked} onChange={setPicked} /></Field>
              {!picked && <>
                <Field label="…or phone" htmlFor="tk-phone" error={errors.customer_phone}><Input id="tk-phone" value={v.customer_phone} onChange={set('customer_phone')} inputMode="tel" /></Field>
                <Field label="…or email" htmlFor="tk-email" error={errors.customer_email}><Input id="tk-email" value={v.customer_email} onChange={set('customer_email')} inputMode="email" /></Field>
              </>}
            </>
          )}
          <Field label="Priority" htmlFor="tk-priority">
            <Select value={v.priority} onValueChange={(p) => setV((x) => ({ ...x, priority: p as Priority }))}>
              <SelectTrigger id="tk-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Assigned agent" htmlFor="tk-agent"><AgentSelect id="tk-agent" agents={agents.data ?? []} value={agent} onChange={setAgent} /></Field>
          <Field label="Category" htmlFor="tk-category" error={errors.category}><Input id="tk-category" value={v.category} onChange={set('category')} maxLength={80} /></Field>
          <Field label="Subcategory" htmlFor="tk-subcategory" error={errors.subcategory}><Input id="tk-subcategory" value={v.subcategory} onChange={set('subcategory')} maxLength={80} /></Field>
          <Field label="Department" htmlFor="tk-department" error={errors.department} className="sm:col-span-2"><Input id="tk-department" value={v.department} onChange={set('department')} maxLength={80} /></Field>
          <Field label="Description" htmlFor="tk-description" error={errors.description} className="sm:col-span-2">
            <Textarea id="tk-description" value={v.description} onChange={set('description')} rows={4} maxLength={10000} /></Field>
          <div className="sm:col-span-2"><ErrorLine text={error} /></div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Create ticket</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Log a conversation that happened outside the ERP: a call taken on a phone, a WhatsApp or an email received
 * elsewhere. It is marked "logged manually"; nothing is sent to the customer.
 */
export function LogConversationDialog(props: ComponentProps<typeof LogConversationForm>) {
  return props.open ? <LogConversationForm {...props} /> : null
}

function LogConversationForm({ open, onOpenChange, defaultChannel = 'PHONE', onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; defaultChannel?: Channel
  onCreated: (r: { id: string; match: string; candidates: number }) => void
}) {
  const [channel, setChannel] = useState<Channel>(defaultChannel)
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('INBOUND')
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  const [contact, setContact] = useState({ contact_name: '', contact_phone: '', contact_email: '' })
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [callStatus, setCallStatus] = useState('ANSWERED')
  const [duration, setDuration] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const errs = validateLog({ channel, direction, body, call_status: callStatus, duration, subject }, { customer_id: picked?.id ?? '', ...contact })
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true); setError(null)
    try {
      const r = await createConversation({ channel, direction, customer_id: picked?.id ?? null, contact_name: contact.contact_name.trim() || undefined,
        contact_phone: contact.contact_phone.trim() || undefined, contact_email: contact.contact_email.trim() || undefined, subject: subject.trim() || undefined,
        body: body.trim() || undefined, call_status: channel === 'PHONE' ? callStatus : undefined, call_duration_seconds: channel === 'PHONE' && duration.trim() ? Number(duration) : null })
      onCreated({ id: r.id, match: r.match, candidates: r.candidates.length })
      onOpenChange(false)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Log a conversation</DialogTitle>
          <DialogDescription>Record a call, WhatsApp or email that happened outside the ERP. It is marked as logged manually; nothing is sent to the customer.</DialogDescription></DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <Field label="Channel" htmlFor="lg-channel">
            <Select value={channel} onValueChange={(c) => setChannel(c as Channel)}>
              <SelectTrigger id="lg-channel"><SelectValue /></SelectTrigger>
              <SelectContent>{CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Direction" htmlFor="lg-direction">
            <Select value={direction} onValueChange={(d) => setDirection(d as 'INBOUND' | 'OUTBOUND')}>
              <SelectTrigger id="lg-direction"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="INBOUND">From the customer</SelectItem><SelectItem value="OUTBOUND">To the customer</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Customer" htmlFor="lg-customer" error={errors.contact} className="sm:col-span-2" hint="Or leave empty and enter the contact details: the customer is matched by phone and email.">
            <CustomerPicker id="lg-customer" value={picked} onChange={setPicked} />
          </Field>
          {!picked && <>
            <Field label="Contact name" htmlFor="lg-name"><Input id="lg-name" value={contact.contact_name} onChange={(e) => setContact((c) => ({ ...c, contact_name: e.target.value }))} maxLength={200} /></Field>
            <Field label="Phone" htmlFor="lg-phone" error={errors.contact_phone}><Input id="lg-phone" value={contact.contact_phone} inputMode="tel"
              onChange={(e) => setContact((c) => ({ ...c, contact_phone: e.target.value }))} /></Field>
            <Field label="Email" htmlFor="lg-email" error={errors.contact_email} className="sm:col-span-2"><Input id="lg-email" value={contact.contact_email} inputMode="email"
              onChange={(e) => setContact((c) => ({ ...c, contact_email: e.target.value }))} /></Field>
          </>}
          <Field label="Subject" htmlFor="lg-subject" className="sm:col-span-2"><Input id="lg-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
          {channel === 'PHONE' && <>
            <Field label="Call result" htmlFor="lg-call" error={errors.call_status}>
              <Select value={callStatus} onValueChange={setCallStatus}>
                <SelectTrigger id="lg-call"><SelectValue /></SelectTrigger>
                <SelectContent>{CALL_STATUSES.map((c) => <SelectItem key={c} value={c}>{CALL_STATUS_LABELS[c]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Duration (seconds)" htmlFor="lg-duration" error={errors.duration}><Input id="lg-duration" value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" /></Field>
          </>}
          <Field label={channel === 'PHONE' ? 'Call summary' : 'Message'} htmlFor="lg-body" error={errors.body} className="sm:col-span-2">
            <Textarea id="lg-body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={20000} /></Field>
          <div className="sm:col-span-2"><ErrorLine text={error} /></div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Log conversation</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Asks for a reason (merge, reopen) and optionally a value (the ticket to merge into). */
export function ReasonDialog(props: ComponentProps<typeof ReasonForm>) {
  return props.open ? <ReasonForm {...props} /> : null
}

function ReasonForm({ open, onOpenChange, title, description, confirmLabel, valueLabel, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; valueLabel?: string
  onConfirm: (reason: string, value: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (valueLabel && !value.trim()) { setError(`Enter the ${valueLabel.toLowerCase()}.`); return }
    if (reason.trim().length < 3) { setError('Enter the reason (at least 3 characters).'); return }
    setBusy(true); setError(null)
    try { await onConfirm(reason.trim(), value.trim()); onOpenChange(false) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          {valueLabel && <Field label={valueLabel} htmlFor="rd-value"><Input id="rd-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="ALT-SUP-000001" /></Field>}
          <Field label="Reason" htmlFor="rd-reason"><Textarea id="rd-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} /></Field>
          <ErrorLine text={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
