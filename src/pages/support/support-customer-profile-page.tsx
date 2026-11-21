import { ArrowLeft, Loader2, Mail, Pencil, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { money } from '@/features/billing/billing-model'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { CustomerEditor } from '@/features/support/customers/customer-editor'
import { addressLine, initials } from '@/features/support/customers/customer-model'
import {
  ActivitiesTab, CallsTab, EmailsTab, FilesTab, NotesTab, ProductsTab, TicketsTab, TimelineTab, WhatsAppTab,
} from '@/features/support/customers/customer-tabs'
import { LegacyCustomerProfile } from '@/features/support/customers/legacy-customer-profile'
import { EmailComposeDialog } from '@/features/support/email-components'
import { hoursText } from '@/features/support/pipeline/pipeline-model'
import { CallButton } from '@/features/support/phone-components'
import { TicketFormDialog } from '@/features/support/support-dialogs'
import { displayValue } from '@/features/support/ticket-fields/field-model'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/format'
import { fetchCustomerForm, fetchCustomerWorkspace, type CustomerWorkspace } from '@/services/customer-crm'
import { fetchCustomerProfile } from '@/services/support'

type Tab = 'timeline' | 'tickets' | 'notes' | 'activities' | 'emails' | 'calls' | 'whatsapp' | 'products' | 'files' | 'erp'

/** /support/customers/:customerId — customer information and the customer's support workspace. */
export default function SupportCustomerProfilePage() {
  const { customerId = '' } = useParams()
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchCustomerWorkspace(customerId), [customerId, refresh])
  if (q.loading && !q.data) return <><PageHeader title="Customer" /><LoadingState rows={8} /></>
  if (q.error) return <><PageHeader title="Customer" /><Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  if (!q.data) return <LegacyCustomerProfile customerId={customerId} />
  return <Workspace ws={q.data} reload={() => setRefresh((n) => n + 1)} />
}

function Workspace({ ws, reload }: { ws: CustomerWorkspace; reload: () => void }) {
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? undefined
  const perms = useSupportPermissions()
  const c = ws.customer
  const [tab, setTab] = useUrlParam('tab', 'timeline')
  const [editOpen, setEditOpen] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [compose, setCompose] = useState<string | null>(null)
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'timeline', label: 'Timeline' }, { value: 'tickets', label: 'Tickets', count: ws.metrics.total }, { value: 'notes', label: 'Notes', count: ws.counts.notes },
    { value: 'activities', label: 'Activities', count: ws.counts.open_activities }, { value: 'emails', label: 'Emails' }, { value: 'calls', label: 'Calls', count: ws.counts.calls },
    { value: 'whatsapp', label: 'WhatsApp' }, ...(ws.can.products ? [{ value: 'products' as Tab, label: 'Products' }] : []), { value: 'files', label: 'Files' },
    ...(c.erp_customer ? [{ value: 'erp' as Tab, label: 'Orders & invoices' }] : []),
  ]
  const t = (tabs.some((x) => x.value === tab) ? tab : 'timeline') as Tab
  const info = (label: string, value: ReactNode, testId?: string) => value ? <div className="min-w-0" data-testid={testId}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div> : null
  const phone = (n: string | null) => n ? <span className="inline-flex items-center gap-1">{n}<CallButton number={n} customerId={c.id} /></span> : null
  const email = (e: string | null) => e ? <span className="inline-flex items-center gap-1">{e}{perms.reply && <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" aria-label={`Email ${e}`}
    data-testid="email-button" onClick={() => setCompose(e)}><Mail className="size-3.5" />Email</Button>}</span> : null
  const otherPhones = c.phones.filter((p) => ![c.mobile, c.alternate_phone, c.landline].includes(p))
  const otherEmails = c.emails.filter((e) => ![c.email, c.alternate_email].includes(e))
  const m = ws.metrics

  return (
    <>
      <PageHeader title={c.display_name} description={`${c.customer_code}${c.company_name ? ` · ${c.company_name}` : ''}`}
        breadcrumbs={[{ label: 'Support Centre' }, { label: 'Support Customers', to: '/support/customers' }, { label: c.display_name }]}
        actions={<>
          <Button variant="outline" asChild><Link to="/support/customers"><ArrowLeft /> All customers</Link></Button>
          {ws.can.create_ticket && <Button onClick={() => setTicketOpen(true)} data-testid="customer-new-ticket"><Plus /> New ticket</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-testid="customer-workspace">
        <Card className="h-fit gap-0 p-0" data-testid="customer-info">
          <div className="flex items-start gap-3 border-b p-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-full bg-primary/10 text-lg font-semibold text-primary" aria-hidden>{initials(c.display_name)}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold">{c.display_name}</p>
              <p className="text-sm text-muted-foreground">{c.customer_code}{c.company_name ? ` · ${c.company_name}` : ''}</p>
              {!c.is_active && <StatusBadge label="Inactive" tone="neutral" />}
            </div>
            {ws.can.edit && <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} data-testid="edit-customer"><Pencil /> Edit</Button>}
          </div>
          <dl className="grid gap-3 p-4 text-sm">
            {info('Primary contact', c.contact_person)}
            {info('Email', email(c.email), 'info-email')}
            {info('Mobile', phone(c.mobile), 'info-mobile')}
            {info('Alternate phone', phone(c.alternate_phone))}
            {info('Landline', phone(c.landline))}
            {info('Alternate email', email(c.alternate_email))}
            {otherPhones.length > 0 && info('Other phones', <span className="flex flex-col">{otherPhones.map((p) => <span key={p}>{phone(p)}</span>)}</span>)}
            {otherEmails.length > 0 && info('Other emails', <span className="flex flex-col">{otherEmails.map((e) => <span key={e}>{email(e)}</span>)}</span>)}
            {info('GSTIN', c.gstin && <span className="font-mono">{c.gstin}</span>)}
            {info('Customer type', [c.customer_type, c.customer_category].filter(Boolean).join(' · ') || null)}
            {info('Address', addressLine(c))}
            {info('Assigned agent', c.assigned_agent?.display_name ?? null)}
            {info('ERP customer', c.erp_customer ? `${c.erp_customer.customer_code} — ${c.erp_customer.customer_name}` : null)}
            {ws.tags.length > 0 && info('Tags', <span className="flex flex-wrap gap-1">{ws.tags.map((x) => <StatusBadge key={x.id} label={x.name} tone={x.color as never} />)}</span>)}
            {info('Description', c.notes && <span className="whitespace-pre-wrap">{c.notes}</span>)}
            {info('Customer since', `${formatDate(c.created_at)}${c.created_by_name ? ` · by ${c.created_by_name}` : ''}`)}
          </dl>
          {ws.fields.length > 0 && (
            <dl className="grid gap-3 border-t p-4 text-sm" data-testid="customer-custom-fields">
              {ws.fields.map((f) => (
                <div key={f.field_key} className="min-w-0" data-testid={`ccf-${f.field_key}`}>
                  <dt className="text-xs text-muted-foreground">{f.field_label}{!f.is_active && ' (no longer in use)'}</dt>
                  <dd className="break-words">{f.field_type === 'URL' && f.value ? <a className="text-primary hover:underline" href={String(f.value)} target="_blank" rel="noopener noreferrer nofollow">{String(f.value)}</a>
                    : displayValue(f, f.value, ws.formula_inputs)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7" data-testid="customer-metrics">
            {([['Total tickets', m.total], ['Open', m.open], ['Closed', m.closed], ['Overdue', m.overdue], ['Avg resolution', hoursText(m.avg_resolution_hours)],
              ['Reopened', m.reopened], ...(m.product_complaints !== null ? [['Product complaints', m.product_complaints] as const] : [])] as const).map(([l, v]) => (
              <div key={l} className="rounded-lg border bg-card p-2.5"><p className="text-xs text-muted-foreground">{l}</p><p className="text-base font-semibold tabular-nums">{v}</p></div>
            ))}
          </div>
          <Card className="gap-0 p-0">
            <div className="flex overflow-x-auto border-b px-2" role="tablist" aria-label="Customer workspace">
              {tabs.map((x) => (
                <button key={x.value} type="button" role="tab" aria-selected={t === x.value} onClick={() => setTab(x.value)} data-testid={`ctab-${x.value}`}
                  className={cn('shrink-0 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap', t === x.value ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                  {x.label}{x.count ? <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums">{x.count}</span> : null}
                </button>
              ))}
            </div>
            <CardContent className="p-4" role="tabpanel">
              {t === 'timeline' && <TimelineTab customerId={c.id} tz={tz} />}
              {t === 'tickets' && <TicketsTab customerId={c.id} tz={tz} />}
              {t === 'notes' && <NotesTab ws={ws} tz={tz} onChanged={reload} />}
              {t === 'activities' && <ActivitiesTab ws={ws} tz={tz} onChanged={reload} />}
              {t === 'emails' && <EmailsTab customerId={c.id} tz={tz} />}
              {t === 'calls' && <CallsTab customerId={c.id} tz={tz} />}
              {t === 'whatsapp' && <WhatsAppTab customerId={c.id} tz={tz} />}
              {t === 'products' && <ProductsTab customerId={c.id} />}
              {t === 'files' && <FilesTab customerId={c.id} tz={tz} />}
              {t === 'erp' && <ErpTab customerId={c.id} />}
            </CardContent>
          </Card>
        </div>
      </div>
      {editOpen && <EditCustomerDialog ws={ws} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); reload() }} />}
      {compose && <EmailComposeDialog target={{ mode: 'NEW', customerId: c.id, to: compose }} onClose={() => setCompose(null)} onSent={reload} />}
      <TicketFormDialog open={ticketOpen} onOpenChange={setTicketOpen} customer={{ id: c.id, label: `${c.display_name} (${c.customer_code})` }} onCreated={reload} />
    </>
  )
}

function EditCustomerDialog({ ws, onClose, onSaved }: { ws: CustomerWorkspace; onClose: () => void; onSaved: () => void }) {
  const form = useAsync(() => fetchCustomerForm(), [])
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[92dvh] max-w-3xl flex-col gap-0 p-0" data-testid="customer-dialog">
        <DialogHeader className="border-b px-6 py-4"><DialogTitle>Edit {ws.customer.display_name}</DialogTitle>
          <DialogDescription>{ws.customer.customer_code}. Fields not on the form keep their values. <span className="text-red-600">*</span> = required.</DialogDescription></DialogHeader>
        {form.error ? <ErrorState message={describeDataError(form.error)} onRetry={form.reload} /> : !form.data ? <Loader2 className="mx-auto my-6 size-6 animate-spin text-muted-foreground" />
          : <CustomerEditor form={form.data} workspace={ws} onSaved={onSaved} onCancel={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

/** Orders and invoices of the linked ERP customer (from the earlier profile data; needs sales / invoice access). */
function ErpTab({ customerId }: { customerId: string }) {
  const q = useAsync(() => fetchCustomerProfile(customerId), [customerId])
  if (!q.data) return q.error ? <ErrorState message={describeDataError(q.error)} onRetry={q.reload} /> : <LoadingState rows={3} />
  const p = q.data
  if (p.orders === null && p.invoices === null) return <p className="text-sm text-muted-foreground">Order and invoice history is shown to roles with sales or invoice access.</p>
  const list = (title: string, rows: { id: string; number: string; date: string; status: string; value: number; to: string }[] | null) => rows === null ? null : (
    <div><p className="mb-1 text-sm font-medium">{title}</p>{rows.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
      <ul className="divide-y text-sm">{rows.map((r) => <li key={r.id} className="flex items-center gap-2 py-1.5"><Link className="font-medium text-primary hover:underline" to={r.to}>{r.number}</Link>
        <span className="flex-1 text-muted-foreground">{formatDate(r.date)} · {r.status}</span><span className="tabular-nums">{money(r.value)}</span></li>)}</ul>)}</div>
  )
  return (
    <div className="space-y-4">
      {list('Sales orders (latest 20)', p.orders?.map((o) => ({ id: o.id, number: o.number, date: o.order_date, status: o.status, value: o.value, to: `/sales/orders/${o.id}` })) ?? null)}
      {list('Invoices (latest 20)', p.invoices?.map((i) => ({ id: i.id, number: i.number, date: i.invoice_date, status: i.status, value: i.value, to: `/billing/invoices/${i.id}` })) ?? null)}
    </div>
  )
}
