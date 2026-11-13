import { ArrowLeft, Mail, Pencil, PhoneIncoming, PhoneOutgoing } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { money } from '@/features/billing/billing-model'
import { ChannelIcon, ConversationStatusBadge, InfoList, PriorityBadge, SlaBadge, TicketStatusBadge } from '@/features/support/support-components'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CustomerFormDialog, TicketFormDialog } from '@/features/support/support-dialogs'
import { CallButton } from '@/features/support/phone-components'
import { EmailComposeDialog } from '@/features/support/email-components'
import { CALL_STATUS_LABELS, formatDuration } from '@/features/support/support-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { addNote, fetchCustomerProfile } from '@/services/support'

/** /support/customers/:customerId — the unified customer profile. */
export default function SupportCustomerProfilePage() {
  const { customerId = '' } = useParams()
  const { access } = useAuth()
  const tz = access?.company?.timezone
  const perms = useSupportPermissions()
  const [refresh, setRefresh] = useState(0)
  const q = useAsync(() => fetchCustomerProfile(customerId), [customerId, refresh])
  const [editOpen, setEditOpen] = useState(false)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [compose, setCompose] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const header = <PageHeader title={q.data?.customer.display_name ?? 'Customer'} description={q.data ? `${q.data.customer.customer_code}${q.data.customer.company_name ? ` · ${q.data.customer.company_name}` : ''}` : undefined}
    breadcrumbs={[{ label: 'Support Centre' }, { label: 'Support Customers', to: '/support/customers' }, { label: q.data?.customer.display_name ?? 'Customer' }]}
    actions={<>
      <Button variant="outline" asChild><Link to="/support/customers"><ArrowLeft /> All customers</Link></Button>
      {perms.reply && q.data && <Button variant="outline" onClick={() => setEditOpen(true)}><Pencil /> Edit</Button>}
      {perms.manageTickets && q.data && <Button onClick={() => setTicketOpen(true)}>New ticket</Button>}
    </>} />
  if (q.loading && !q.data) return <>{header}<LoadingState rows={8} /></>
  if (q.error || !q.data) return <>{header}<Card><ErrorState message={describeDataError(q.error)} onRetry={q.reload} /></Card></>
  const p = q.data
  const c = p.customer
  const whatsapp = p.conversations.filter((x) => x.channel === 'WHATSAPP')
  const saveNote = async () => {
    setError(null)
    try { await addNote('CUSTOMER', c.id, note.trim()); setNote(''); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) }
  }
  const section = (title: string, empty: boolean, body: React.ReactNode, description?: string) => (
    <Card>
      <CardHeader><div><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div></CardHeader>
      <CardContent>{empty ? <p className="text-sm text-muted-foreground">None.</p> : body}</CardContent>
    </Card>
  )
  return (
    <>
      {header}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Contact details</CardTitle></CardHeader>
            <CardContent>
              <InfoList items={[
                ['Name', c.display_name], ['Customer code', c.customer_code], ['Company', c.company_name ?? '—'],
                ['Phone numbers', c.phones.length ? <span key="phones" className="flex flex-col gap-0.5">{c.phones.map((n) => (
                  <span key={n} className="inline-flex items-center gap-1">{n}<CallButton number={n} customerId={c.id} /></span>))}</span> : '—'], ['Email addresses', c.emails.length ? <span key="emails" className="flex flex-col gap-0.5">{c.emails.map((e) => (
                  <span key={e} className="inline-flex items-center gap-1">{e}{perms.reply && <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2" aria-label={`Email ${e}`}
                    data-testid="email-button" onClick={() => setCompose(e)}><Mail className="size-3.5" />Email</Button>}</span>))}</span> : '—'], ['Address', c.address ?? '—'],
                ['Customer since', formatDate(c.created_at)], ['Notes', c.notes ?? '—'],
              ]} />
            </CardContent>
          </Card>
          <Card data-testid="erp-customer">
            <CardHeader><div><CardTitle>ERP customer</CardTitle><CardDescription>The customer record in Sales, Billing and Ledger.</CardDescription></div></CardHeader>
            <CardContent>
              {p.erp_customer ? <InfoList items={[['Customer', `${p.erp_customer.customer_code} — ${p.erp_customer.customer_name}`], ['GSTIN', p.erp_customer.gstin ?? '—'],
                ['Email', p.erp_customer.contact_email ?? '—'], ['Billing address', p.erp_customer.billing_address ?? '—'], ['Status', p.erp_customer.status]]} />
                : <p className="text-sm text-muted-foreground">{c.erp_customer_id ? 'Linked, but your role cannot see ERP customer records.' : 'Not linked to an ERP customer. Edit the customer to link one.'}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Internal customer notes</CardTitle><CardDescription>Visible to agents only.</CardDescription></div></CardHeader>
            <CardContent className="space-y-3">
              {p.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
                <ul className="space-y-2">{p.notes.map((n) => <li key={n.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                  <p className="text-xs text-amber-900">{n.author ?? 'Agent'} · {formatDateTime(n.created_at, tz)}</p><p className="whitespace-pre-wrap">{n.body}</p></li>)}</ul>
              )}
              {perms.reply && (
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void saveNote() }}>
                  <Textarea aria-label="New customer note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={5000} />
                  {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
                  <div className="flex justify-end"><Button type="submit" size="sm" disabled={!note.trim()}>Add note</Button></div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          {section('Tickets', p.tickets.length === 0, (
            <ul className="divide-y text-sm">{p.tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2"><Link className="font-medium text-primary hover:underline" to={`/support/tickets/${t.id}`}>{t.ticket_number}</Link>
                <span className="min-w-0 flex-1 truncate">{t.subject}</span><TicketStatusBadge status={t.status} /><PriorityBadge priority={t.priority} /><SlaBadge status={t.sla_status} /></li>
            ))}</ul>
          ))}
          {section('Calls', p.calls.length === 0, (
            <ul className="divide-y text-sm">{p.calls.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                {m.direction === 'INBOUND' ? <PhoneIncoming className="size-4 text-muted-foreground" /> : <PhoneOutgoing className="size-4 text-muted-foreground" />}
                <Link className="text-primary hover:underline" to={`/support/calls?tab=conversations&c=${m.conversation_id}`}>{CALL_STATUS_LABELS[m.call_status] ?? m.call_status}</Link>
                <span className="text-muted-foreground">{formatDuration(m.duration_seconds)}</span><span className="min-w-0 flex-1 truncate">{m.summary ?? ''}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(m.occurred_at, tz)}{m.source === 'MANUAL' ? ' · logged' : ''}</span></li>
            ))}</ul>
          ))}
          {section('Emails', p.emails.length === 0, (
            <ul className="divide-y text-sm">{p.emails.map((m) => (
              <li key={m.id} className="flex items-center gap-2 py-2"><ChannelIcon channel="EMAIL" />
                <Link className="min-w-0 flex-1 truncate text-primary hover:underline" to={`/support/emails?c=${m.conversation_id}`}>{m.subject ?? '(no subject)'}</Link>
                <span className="text-xs text-muted-foreground">{m.direction === 'INBOUND' ? 'received' : 'sent'} {formatDateTime(m.occurred_at, tz)}</span></li>
            ))}</ul>
          ))}
          {section('WhatsApp conversations', whatsapp.length === 0, (
            <ul className="divide-y text-sm">{whatsapp.map((x) => (
              <li key={x.id} className="flex items-center gap-2 py-2"><ChannelIcon channel="WHATSAPP" />
                <Link className="min-w-0 flex-1 truncate text-primary hover:underline" to={`/support/whatsapp?c=${x.id}`}>{x.subject ?? x.last_message_preview ?? 'Conversation'}</Link>
                <ConversationStatusBadge status={x.status} /><span className="text-xs text-muted-foreground">{formatDateTime(x.last_activity_at, tz)}</span></li>
            ))}</ul>
          ))}
          {p.orders !== null ? section('Sales orders', p.orders.length === 0, (
            <ul className="divide-y text-sm">{p.orders.map((o) => (
              <li key={o.id} className="flex items-center gap-2 py-2"><Link className="font-medium text-primary hover:underline" to={`/sales/orders/${o.id}`}>{o.number}</Link>
                <span className="flex-1 text-muted-foreground">{formatDate(o.order_date)} · {o.status}</span><span className="tabular-nums">{money(o.value)}</span></li>
            ))}</ul>
          ), 'Latest 20 orders of the linked ERP customer.') : null}
          {p.invoices !== null ? section('Invoices', p.invoices.length === 0, (
            <ul className="divide-y text-sm">{p.invoices.map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-2"><Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${i.id}`}>{i.number}</Link>
                <span className="flex-1 text-muted-foreground">{formatDate(i.invoice_date)} · {i.status}</span><span className="tabular-nums">{money(i.value)}</span></li>
            ))}</ul>
          ), 'Latest 20 invoices of the linked ERP customer.') : null}
          {c.erp_customer_id && p.orders === null && p.invoices === null && <p className="text-xs text-muted-foreground">Order and invoice history is shown to roles with sales or invoice access.</p>}
        </div>
      </div>
      <CustomerFormDialog open={editOpen} onOpenChange={setEditOpen} existing={c} onSaved={() => setRefresh((n) => n + 1)} />
      {compose && <EmailComposeDialog target={{ mode: 'NEW', customerId: c.id, to: compose }} onClose={() => setCompose(null)} onSent={() => setRefresh((n) => n + 1)} />}
      <TicketFormDialog open={ticketOpen} onOpenChange={setTicketOpen} customer={{ id: c.id, label: `${c.display_name} (${c.customer_code})` }} onCreated={() => setRefresh((n) => n + 1)} />
    </>
  )
}
