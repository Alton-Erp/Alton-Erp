import { AlertTriangle, FileCheck2, Loader2, PackagePlus, Plus, Save, Trash2, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { money } from '@/features/billing/billing-model'
import { calculateInvoice, changeWarnings, treatmentFor, validateInvoiceForm, type PricingMode } from '@/features/billing/invoicing-v2-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { ProductPicker } from '@/features/inventory/pickers'
import { qtyInputMode } from '@/features/inventory/whole-units'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { QuickAddProductDialog } from '@/features/products/quick-add-product'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { fetchBillingSettings, fetchInvoice, fetchInvoiceLines, type BillingSettings } from '@/services/billing'
import { fetchCustomers } from '@/services/customer-po'
import type { ProductOption } from '@/services/inventory'
import { postingBlockedReason } from '@/features/billing/dispatch-status-model'
import { PartialInvoiceDialog } from '@/features/billing/partial-invoice-dialog'
import { partialWarning } from '@/features/sales/pending-invoice-model'
import { fetchInvoiceDispatchStatus, fetchPartialPreview, fetchSoInvoiceLines, issueInvoiceV2, saveInvoiceV2, type SoInvoiceLines } from '@/services/invoicing-v2'
import { fetchProductsByIds } from '@/services/products'
import { fetchSalesOrdersV2 } from '@/services/sales-v2'
import type { CustomerRow } from '@/types/database-customer-po'
import type { SalesInvoiceLineRow, SalesInvoiceListRow } from '@/types/database-billing'


interface Line {
  key: string
  soLineId: string | null
  product: ProductOption | null
  description: string
  hsn: string
  quantity: string
  unitPrice: string
  discountMode: 'PERCENT' | 'AMOUNT'
  discount: string
  gstRate: string
  so: { ordered: number; invoiced: number; pending: number } | null
}
const blank = (): Line => ({ key: crypto.randomUUID(), soLineId: null, product: null, description: '', hsn: '', quantity: '', unitPrice: '', discountMode: 'PERCENT', discount: '', gstRate: '', so: null })
const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)))
type Mode = 'manual' | 'so'

async function load(invoiceId: string | undefined) {
  const [settings, customers, orders, invoice, lines] = await Promise.all([
    fetchBillingSettings(), fetchCustomers(false), fetchSalesOrdersV2(null, null, null, null),
    invoiceId ? fetchInvoice(invoiceId) : Promise.resolve(null),
    invoiceId ? fetchInvoiceLines(invoiceId) : Promise.resolve([] as SalesInvoiceLineRow[]),
  ])
  const soLines = invoice?.sales_order_id ? await fetchSoInvoiceLines(invoice.sales_order_id) : null
  return { settings, customers, orders: orders.filter((o) => o.status !== 'CANCELLED' && o.status !== 'DRAFT'), invoice, lines, soLines }
}

/**
 * /billing/invoices/new (?mode=so|manual, ?so=<id>) and /billing/invoices/:invoiceId/edit.
 * All invoices are created here (Billing & Invoicing). Sales-order invoices are the default;
 * manual invoices remain for services and charges. Invoicing "from dispatches" was removed
 * (20261115): posting a sales-order invoice dispatches its goods.
 */
export default function InvoiceEntryPage() {
  const { invoiceId } = useParams()
  const [params, setParams] = useSearchParams()
  const requested = params.get('mode')
  const mode: Mode = invoiceId ? 'manual' : requested === 'manual' ? 'manual' : 'so'
  const crumbs = [{ label: 'Finance' }, { label: 'Sales Invoices', to: '/billing/invoices' }, { label: invoiceId ? 'Edit draft' : 'New' }]
  const switcher = !invoiceId && (
    <div role="tablist" aria-label="How to create the invoice" className="mb-4 inline-flex flex-wrap rounded-lg border bg-muted/40 p-1 text-sm">
      {([['so', 'From sales order'], ['manual', 'Manual invoice']] as [Mode, string][]).map(([m, label]) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m}
          className={`rounded-md px-3 py-1.5 ${mode === m ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setParams(m === 'so' ? {} : { mode: m })}>{label}</button>
      ))}
    </div>
  )
  return <Loader invoiceId={invoiceId} mode={mode} soParam={params.get('so')} crumbs={crumbs} switcher={switcher} />
}

function Loader({ invoiceId, mode, soParam, crumbs, switcher }: { invoiceId?: string; mode: Mode; soParam: string | null; crumbs: { label: string; to?: string }[]; switcher: ReactNode }) {
  const data = useAsync(() => load(invoiceId), [invoiceId])
  if (data.loading && !data.data) return <LoadingState label="Loading…" />
  if (data.error || !data.data) return (<><PageHeader title="Invoice" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)
  const inv = data.data.invoice
  if (inv && (inv.status !== 'DRAFT' || inv.source === 'DISPATCH')) {
    return (<><PageHeader title={`Edit ${inv.proforma_number ?? 'draft invoice'}`} breadcrumbs={crumbs} />
      <Card><CardContent className="space-y-3 py-6 text-sm">
        <p>{inv.status !== 'DRAFT'
          ? 'Issued invoices are never edited. Correct them with a credit or debit note, or cancel the invoice and create a new one.'
          : 'This draft was created from dispatches; change its quantities and prices on the invoice page.'}</p>
        <Button asChild variant="outline"><Link to={`/billing/invoices/${inv.id}`}>Open the invoice</Link></Button>
      </CardContent></Card></>)
  }
  return <EntryForm key={`${mode}-${invoiceId ?? 'new'}`} {...data.data} mode={inv?.sales_order_id ? 'so' : mode} soParam={soParam} crumbs={crumbs} switcher={switcher} />
}

function EntryForm({ settings, customers, orders, invoice, lines: invLines, soLines: initialSo, mode, soParam, crumbs, switcher }: {
  settings: BillingSettings
  customers: CustomerRow[]
  orders: Awaited<ReturnType<typeof fetchSalesOrdersV2>>
  invoice: SalesInvoiceListRow | null
  lines: SalesInvoiceLineRow[]
  soLines: SoInvoiceLines | null
  mode: Mode
  soParam: string | null
  crumbs: { label: string; to?: string }[]
  switcher: ReactNode
}) {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const gst = useGstStates()
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const [customerList, setCustomerList] = useState(customers)
  const [customerId, setCustomerId] = useState(invoice?.customer_id ?? '')
  const [so, setSo] = useState<SoInvoiceLines | null>(initialSo)
  const [soId, setSoId] = useState(invoice?.sales_order_id ?? '')
  const [soLoading, setSoLoading] = useState(false)
  const chargeOf = (kind: string) => str(invLines.find((l) => l.line_type === 'CHARGE' && l.charge_kind === kind)?.unit_price)
  const [h, setH] = useState({
    invoice_date: invoice?.invoice_date ?? today,
    due_date: invoice?.due_date ?? '',
    terms: invoice ? String(invoice.payment_terms_days) : '',
    customer_gstin: invoice?.customer_gstin ?? '',
    customer_pan: invoice?.customer_pan ?? '',
    billing_address: invoice?.customer_billing_address ?? '',
    shipping_address: invoice?.customer_shipping_address ?? '',
    pos: invoice?.place_of_supply_state_code ?? '',
    transport_details: invoice?.transport_details ?? '',
    vehicle_number: invoice?.vehicle_number ?? '',
    eway_bill_number: invoice?.eway_bill_number ?? '',
    notes: invoice?.notes ?? '',
    pricing_mode: (invoice?.pricing_mode ?? settings.pricing_mode ?? 'EXCLUSIVE') as PricingMode,
    proforma: invoice ? invoice.is_proforma : settings.default_invoice_type === 'PROFORMA',
    hd_mode: invoice && Number(invoice.invoice_discount_amount) > 0 ? 'AMOUNT' : 'PERCENT' as 'PERCENT' | 'AMOUNT',
    hd: invoice ? (Number(invoice.invoice_discount_amount) > 0 ? str(invoice.invoice_discount_amount) : str(invoice.invoice_discount_percent)) : '',
    freight: invoice ? chargeOf('FREIGHT') : '',
    packing: invoice ? chargeOf('PACKING') : '',
    other: invoice ? chargeOf('OTHER') : '',
  })
  const set = (k: keyof typeof h) => (v: string) => setH((x) => ({ ...x, [k]: v }))
  const [lines, setLines] = useState<Line[]>(() => {
    const product = invLines.filter((l) => l.line_type === 'PRODUCT')
    if (!product.length) return [blank()]
    return product.map((l) => {
      const sl = initialSo?.lines.find((x) => x.sales_order_line_id === l.sales_order_line_id)
      return {
        key: l.id, soLineId: l.sales_order_line_id, product: { product_id: l.product_id!, sku: l.sku ?? '', product_name: l.description, base_unit: l.unit ?? 'PCS', track_batches: false, track_expiry: false },
        description: l.description, hsn: l.hsn_sac ?? '', quantity: str(l.quantity), unitPrice: str(l.unit_price),
        discountMode: Number(l.discount_percent) > 0 ? 'PERCENT' : 'AMOUNT', discount: Number(l.discount_percent) > 0 ? str(l.discount_percent) : (Number(l.discount_amount) ? str(l.discount_amount) : ''),
        gstRate: str(l.gst_rate),
        // The pending quantity excludes this draft's own lines, so add them back.
        so: sl ? { ordered: sl.ordered, invoiced: sl.invoiced - Number(l.quantity), pending: sl.pending + Number(l.quantity) } : null,
      }
    })
  })
  const [quickCustomer, setQuickCustomer] = useState(false)
  const [quickProduct, setQuickProduct] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'issue'>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingWarnings, setPendingWarnings] = useState<{ warnings: string[]; andIssue: boolean } | null>(null)
  const [partialAfterSave, setPartialAfterSave] = useState<{ invoiceId: string; warnings: string[] } | null>(null)
  const customer = customerList.find((c) => c.id === customerId) ?? null
  const fromSo = mode === 'so'

  const chooseCustomer = (id: string, list: CustomerRow[] = customerList) => {
    const c = list.find((x) => x.id === id)
    setCustomerId(id)
    const pos = c ? (c.gstin && ['REGISTERED', 'COMPOSITION', 'SEZ'].includes(c.gst_registration_type ?? '') ? c.gstin.slice(0, 2)
      : c.gst_registration_type === 'OVERSEAS' ? '96' : (c.shipping_state_code ?? c.billing_state_code ?? '')) : ''
    setH((x) => ({ ...x, customer_gstin: c?.gstin ?? '', customer_pan: c?.pan ?? '', billing_address: c?.billing_address ?? '',
      shipping_address: c?.shipping_address ?? c?.billing_address ?? '', pos, terms: c?.payment_terms_days != null ? String(c.payment_terms_days) : x.terms }))
  }
  const chooseSo = async (id: string) => {
    setSoId(id)
    setSoLoading(true)
    setError(null)
    try {
      const s = await fetchSoInvoiceLines(id)
      setSo(s)
      if (s.customer_id) chooseCustomer(s.customer_id)
      if (s.billing_address) setH((x) => ({ ...x, billing_address: s.billing_address ?? x.billing_address, shipping_address: s.shipping_address ?? x.shipping_address }))
      const open = s.lines.filter((l) => l.pending > 0)
      setLines(open.length ? open.map((l) => ({
        key: l.sales_order_line_id, soLineId: l.sales_order_line_id,
        product: { product_id: l.product_id, sku: l.sku, product_name: l.product_name, base_unit: l.unit, track_batches: false, track_expiry: false },
        description: l.description, hsn: l.hsn_code ?? '', quantity: str(l.pending), unitPrice: str(l.unit_price),
        discountMode: 'PERCENT', discount: l.discount_percent ? str(l.discount_percent) : '', gstRate: str(l.gst_rate),
        so: { ordered: l.ordered, invoiced: l.invoiced, pending: l.pending },
      })) : [])
      if (!open.length) setError(`${s.sales_order_number} is fully invoiced; nothing is left to invoice.`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setSoLoading(false)
    }
  }
  // ?so=<id> opens the form with that order loaded (link from the sales order page).
  const autoSo = useRef(fromSo && soParam && !invoice ? soParam : null)
  useEffect(() => {
    const id = autoSo.current
    autoSo.current = null
    if (id) void chooseSo(id)
  })

  const update = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))
  const pickProduct = async (key: string, p: ProductOption | null) => {
    update(key, { product: p, description: p?.product_name ?? '' })
    if (!p) return
    try {
      const [row] = await fetchProductsByIds([p.product_id])
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, unitPrice: l.unitPrice || str(row?.selling_price), gstRate: l.gstRate || str(row?.gst_rate), hsn: l.hsn || (row?.hsn_code ?? '') } : l)))
    } catch { /* the server falls back to the Product Master */ }
  }

  const treatment = treatmentFor(settings.company?.gstin ?? null, h.pos || null, settings.gst_registered)
  const inter = treatment === 'INTER_STATE'
  const filled = lines.filter((l) => l.product)
  const totals = useMemo(() => calculateInvoice({
    lines: filled.map((l) => ({
      quantity: Number(l.quantity) || 0, unitPrice: l.unitPrice.trim() ? Number(l.unitPrice) : null,
      discountPercent: l.discountMode === 'PERCENT' && l.discount.trim() ? Number(l.discount) : null,
      discountAmount: l.discountMode === 'AMOUNT' && l.discount.trim() ? Number(l.discount) : null,
      gstRate: l.gstRate.trim() ? Number(l.gstRate) : null,
    })),
    charges: [
      { kind: 'FREIGHT', amount: Number(h.freight) || 0, gstRate: Number(settings.freight_gst_rate ?? 18) },
      { kind: 'PACKING', amount: Number(h.packing) || 0, gstRate: Number(settings.packing_gst_rate ?? 18) },
      { kind: 'OTHER', amount: Number(h.other) || 0, gstRate: Number(settings.other_charge_gst_rate ?? 18) },
    ],
    pricingMode: h.pricing_mode,
    invoiceDiscountPercent: h.hd_mode === 'PERCENT' && h.hd.trim() ? Number(h.hd) : null,
    invoiceDiscountAmount: h.hd_mode === 'AMOUNT' && h.hd.trim() ? Number(h.hd) : null,
    treatment: treatment ?? 'INTRA_STATE',
    roundOff: settings.round_off_enabled,
    roundingMode: settings.rounding_mode ?? 'NEAREST',
  }), [filled, h, settings, treatment])
  const terms = h.due_date ? null : (h.terms.trim() ? Number(h.terms) : (customer?.payment_terms_days ?? settings.default_payment_terms_days))
  const dueShown = h.due_date || (terms !== null && Number.isFinite(terms) ? toIsoDate(new Date(new Date(`${h.invoice_date}T00:00:00`).getTime() + terms * 86400000)) : '')
  const gstRates = (settings.gst_rates?.length ? settings.gst_rates : [0, 5, 12, 18, 28]).map(Number)

  const save = async (andIssue: boolean, confirmed = false) => {
    setError(null)
    const problems = validateInvoiceForm({
      customerId: customerId || null, invoiceDate: h.invoice_date, dueDate: h.due_date, ewayBill: h.eway_bill_number, gstin: h.customer_gstin, pan: h.customer_pan,
      invoiceDiscountPercent: h.hd_mode === 'PERCENT' ? h.hd : '', invoiceDiscountAmount: h.hd_mode === 'AMOUNT' ? h.hd : '',
      charges: { Freight: h.freight, 'Packing charges': h.packing, 'Other charges': h.other },
    }, lines.map((l) => ({ product: l.product ? { unit: l.product.base_unit, sku: l.product.sku } : null, quantity: l.quantity, unitPrice: l.unitPrice,
      discountPercent: l.discountMode === 'PERCENT' ? l.discount : '', discountAmount: l.discountMode === 'AMOUNT' ? l.discount : '', gstRate: l.gstRate,
      pending: h.proforma ? null : l.so?.pending ?? null })))
    if (fromSo && !soId) problems.unshift('Choose the sales order.')
    if (andIssue && h.invoice_date > today) problems.push('A future-dated invoice cannot be issued; save it as a draft.')
    if (h.terms.trim() && !/^\d{1,3}$/.test(h.terms.trim())) problems.push('Payment terms are a number of days (0-365).')
    if (problems.length) return setError(problems.join(' '))
    if (invoice && !confirmed) {
      const w = changeWarnings({ grandTotal: Number(invoice.grand_total), placeOfSupply: invoice.place_of_supply_state_code, customerId: invoice.customer_id },
        { grandTotal: totals.grandTotal, placeOfSupply: h.pos || null, customerId })
      if (w.length) { setPendingWarnings({ warnings: w, andIssue }); return }
    }
    setPendingWarnings(null)
    setBusy(andIssue ? 'issue' : 'save')
    try {
      const res = await saveInvoiceV2(invoice?.id ?? null, {
        customer_id: customerId, sales_order_id: fromSo ? soId : null, invoice_date: h.invoice_date,
        ...(h.due_date ? { due_date: h.due_date } : { payment_terms_days: terms }),
        place_of_supply_state_code: h.pos || null, customer_gstin: h.customer_gstin.trim() || null, customer_pan: h.customer_pan.trim() || null,
        billing_address: h.billing_address.trim() || null, shipping_address: h.shipping_address.trim() || null,
        transport_details: h.transport_details.trim() || null, vehicle_number: h.vehicle_number.trim() || null, eway_bill_number: h.eway_bill_number.trim() || null,
        notes: h.notes.trim() || null, pricing_mode: h.pricing_mode, is_proforma: h.proforma,
        invoice_discount_percent: h.hd_mode === 'PERCENT' ? (h.hd.trim() || null) : null, invoice_discount_amount: h.hd_mode === 'AMOUNT' ? (h.hd.trim() || '0') : '0',
      }, filled.map((l) => ({
        product_id: l.product!.product_id, sales_order_line_id: fromSo ? l.soLineId : null, description: l.description.trim() || null, hsn_sac: l.hsn.trim() || null,
        quantity: l.quantity.trim(), unit_price: l.unitPrice.trim() || null,
        discount_percent: l.discountMode === 'PERCENT' ? (l.discount.trim() || null) : null, discount_amount: l.discountMode === 'AMOUNT' ? (l.discount.trim() || null) : null,
        gst_rate: l.gstRate.trim() || null,
      })), { freight: h.freight.trim() || '0', packing: h.packing.trim() || '0', other: h.other.trim() || '0' }, invoice ? null : request.key)
      request.renew()
      if (andIssue) {
        try {
          // Lines that cannot be dispatched on posting (manual stock lines) block posting (the server checks again).
          const blocked = postingBlockedReason(await fetchInvoiceDispatchStatus(res.invoice_id))
          if (blocked) {
            navigate(`/billing/invoices/${res.invoice_id}`, { replace: Boolean(invoice), state: { message: 'The draft was saved but cannot be posted yet.', warnings: [blocked] } })
            return
          }
          // Less than the remaining order quantity: explicit acknowledgement first.
          const warnings = partialWarning((await fetchPartialPreview(res.invoice_id)).lines)
          if (warnings) { setPartialAfterSave({ invoiceId: res.invoice_id, warnings }); return }
          await postSaved(res.invoice_id)
          return
        } catch (e) {
          navigate(`/billing/invoices/${res.invoice_id}`, { replace: Boolean(invoice), state: { message: 'The draft was saved but could not be issued yet.', warnings: [describeDataError(e)] } })
          return
        }
      }
      navigate(`/billing/invoices/${res.invoice_id}`, { replace: Boolean(invoice), state: {
        message: res.is_proforma ? `Proforma ${res.proforma_number} saved. It is not a tax invoice until converted and issued.` : `Draft invoice ${invoice ? 'saved' : 'created'} (${money(res.grand_total)}). Issue it to give it an invoice number.`,
        warnings: res.issues.filter((i) => i.severity === 'BLOCK').map((i) => i.message) } })
    } catch (e) {
      setError(describeDataError(e))
      setBusy(null)
    }
  }

  /** Posts a saved draft and opens it with the result. */
  async function postSaved(invoiceId: string) {
    try {
      const issued = await issueInvoiceV2(invoiceId, false, crypto.randomUUID())
      const dispatched = (issued.dispatched_on_posting ?? []).reduce((s, d) => s + Number(d.dispatched_quantity ?? 0), 0)
      navigate(`/billing/invoices/${invoiceId}`, { replace: Boolean(invoice), state: {
        message: `Invoice ${issued.invoice_number} issued for ${money(issued.grand_total)}.${dispatched > 0 ? ` ${dispatched.toLocaleString('en-IN')} dispatched from reserved stock.` : ''}`
          + (issued.partial_invoice?.partial ? ' Partial invoice: the remaining order quantity stays pending; Super Admins were notified.' : ''),
        warnings: issued.warnings } })
    } catch (e) {
      navigate(`/billing/invoices/${invoiceId}`, { replace: Boolean(invoice), state: { message: 'The draft was saved but could not be issued yet.', warnings: [describeDataError(e)] } })
    }
  }

  const title = invoice ? `Edit ${invoice.is_proforma ? `proforma ${invoice.proforma_number}` : 'draft invoice'}` : fromSo ? 'Invoice from a sales order' : 'New invoice'
  return (
    <>
      <PageHeader title={title}
        description={fromSo ? 'Invoice all or part of what is still pending on the order. Quantities already on other invoices cannot be invoiced again. Invoices never move stock.'
          : 'Any customer and products, with line and invoice discounts, GST, freight and packing. Stock items can be posted only after they are dispatched; services and charges post straight away.'}
        breadcrumbs={crumbs} />
      {switcher}
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(false) }} className="space-y-6">
        <Card>
          <CardHeader><div><CardTitle>Invoice details</CardTitle>
            <CardDescription>Invoice number: {invoice?.invoice_number ?? 'assigned automatically when issued (never reused)'}{h.proforma ? ' · Proforma: numbered PFI-… and never shown as a tax invoice' : ''}</CardDescription></div></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {fromSo && (
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="inv-so">Sales order *</Label>
                <Select value={soId || undefined} onValueChange={(v) => { if (v) void chooseSo(v) }} disabled={Boolean(invoice)}>
                  <SelectTrigger id="inv-so" className="w-full"><SelectValue placeholder="Select a sales order" /></SelectTrigger>
                  <SelectContent className="max-h-72">{orders.map((o) => <SelectItem key={o.id} value={o.id}>{o.sales_order_number} — {o.customer_name} ({money(o.grand_total)})</SelectItem>)}</SelectContent>
                </Select>
                {soLoading && <p className="text-xs text-muted-foreground"><Loader2 className="inline size-3 animate-spin" /> Loading the order…</p>}
                {so && <p className="text-xs text-muted-foreground">Reference {so.customer_reference ?? '—'} · terms {so.payment_terms ?? '—'}</p>}
              </div>
            )}
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="inv-customer">Customer *</Label>
              <div className="flex gap-2">
                <Select value={customerId || undefined} onValueChange={(v) => { if (v) chooseCustomer(v) }} disabled={fromSo}>
                  <SelectTrigger id="inv-customer" className="w-full"><SelectValue placeholder={fromSo ? 'From the sales order' : 'Select a customer'} /></SelectTrigger>
                  <SelectContent className="max-h-72">{customerList.map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent>
                </Select>
                {!fromSo && has('customers.manage') && <Button type="button" variant="outline" onClick={() => setQuickCustomer(true)}><UserPlus /> New customer</Button>}
              </div></div>
            <div className="space-y-1"><Label htmlFor="inv-date">Invoice date</Label><Input id="inv-date" type="date" value={h.invoice_date} onChange={(e) => set('invoice_date')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="inv-type">Document</Label>
              <Select value={h.proforma ? 'PROFORMA' : 'TAX'} onValueChange={(v) => { if (v) setH((x) => ({ ...x, proforma: v === 'PROFORMA' })) }}>
                <SelectTrigger id="inv-type"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="TAX">Tax invoice / bill of supply</SelectItem><SelectItem value="PROFORMA">Proforma invoice</SelectItem></SelectContent>
              </Select></div>
            <div className="space-y-1"><Label htmlFor="inv-terms">Payment terms (days)</Label><Input id="inv-terms" inputMode="numeric" value={h.terms} disabled={Boolean(h.due_date)}
              placeholder={String(customer?.payment_terms_days ?? settings.default_payment_terms_days)} onChange={(e) => set('terms')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="inv-due">Due date</Label><Input id="inv-due" type="date" min={h.invoice_date} value={h.due_date} onChange={(e) => set('due_date')(e.target.value)} />
              {!h.due_date && dueShown && <p className="text-xs text-muted-foreground">From the terms: {formatDate(dueShown)}</p>}</div>
            <div className="space-y-1"><Label htmlFor="inv-gstin">Customer GSTIN</Label><Input id="inv-gstin" maxLength={15} value={h.customer_gstin} onChange={(e) => set('customer_gstin')(e.target.value.toUpperCase())} placeholder="Not registered" /></div>
            <div className="space-y-1"><Label htmlFor="inv-pan">Customer PAN</Label><Input id="inv-pan" maxLength={10} value={h.customer_pan} onChange={(e) => set('customer_pan')(e.target.value.toUpperCase())} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="inv-pos">Place of supply</Label>
              <Select value={h.pos || undefined} onValueChange={(v) => { if (v) set('pos')(v) }}>
                <SelectTrigger id="inv-pos" className="w-full"><SelectValue placeholder="State / code" /></SelectTrigger>
                <SelectContent className="max-h-72">{gst.states.map((s) => <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{treatment === null ? 'Choose the place of supply to work out the tax.' : treatment === 'NONE' ? 'Not GST-registered: no GST is charged.' : inter ? 'Inter-state supply: IGST.' : 'Within the state: CGST + SGST.'}</p></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="inv-bill">Billing address</Label><Textarea id="inv-bill" rows={2} maxLength={1000} value={h.billing_address} onChange={(e) => set('billing_address')(e.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="inv-ship">Shipping address</Label><Textarea id="inv-ship" rows={2} maxLength={1000} value={h.shipping_address} onChange={(e) => set('shipping_address')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="inv-transport">Transport details</Label><Input id="inv-transport" maxLength={200} value={h.transport_details} onChange={(e) => set('transport_details')(e.target.value)} placeholder="Transporter, LR no." /></div>
            <div className="space-y-1"><Label htmlFor="inv-vehicle">Vehicle number</Label><Input id="inv-vehicle" maxLength={20} value={h.vehicle_number} onChange={(e) => set('vehicle_number')(e.target.value.toUpperCase())} /></div>
            <div className="space-y-1"><Label htmlFor="inv-eway">E-way bill number</Label><Input id="inv-eway" inputMode="numeric" maxLength={12} value={h.eway_bill_number} onChange={(e) => set('eway_bill_number')(e.target.value)} placeholder="12 digits (generated on the GST portal)" /></div>
            <div className="space-y-1"><Label htmlFor="inv-pricing">Prices are</Label>
              <Select value={h.pricing_mode} onValueChange={(v) => { if (v) setH((x) => ({ ...x, pricing_mode: v as PricingMode })) }}>
                <SelectTrigger id="inv-pricing"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="EXCLUSIVE">Before GST (GST added)</SelectItem><SelectItem value="INCLUSIVE">Including GST</SelectItem></SelectContent>
              </Select></div>
            <div className="space-y-1 sm:col-span-2 xl:col-span-4"><Label htmlFor="inv-notes">Remarks (printed)</Label><Textarea id="inv-notes" rows={2} maxLength={1000} value={h.notes} onChange={(e) => set('notes')(e.target.value)} /></div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <div><CardTitle>Items</CardTitle><CardDescription>{fromSo ? 'Products, prices, HSN and GST come from the sales order; reduce a quantity to invoice part of it.' : 'Price, HSN and GST come from the Product Master and can be changed.'}</CardDescription></div>
            {!fromSo && has('products.create') && <Button type="button" size="sm" variant="outline" onClick={() => setQuickProduct(true)}><PackagePlus /> New product</Button>}
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead className="min-w-64">Product / description</TableHead><TableHead className="w-24">HSN</TableHead><TableHead className="w-28">Quantity</TableHead>
                <TableHead className="w-28">Rate (₹)</TableHead><TableHead className="w-40">Discount</TableHead><TableHead className="w-24">GST %</TableHead>
                <TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">{inter ? 'IGST' : 'CGST + SGST'}</TableHead><TableHead className="text-right">Total</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>{lines.map((l, i) => {
                const p = l.product ? totals.lines[filled.indexOf(l)] : null
                return (
                  <TableRow key={l.key} className="align-top">
                    <TableCell className="space-y-1">
                      {fromSo ? <p className="font-medium">{l.product?.sku} — {l.product?.product_name}</p>
                        : <ProductPicker id={`inv-p-${i}`} value={l.product} onChange={(v) => void pickProduct(l.key, v)} />}
                      {l.so && <p className="text-xs text-muted-foreground" data-testid={`so-line-${i}`}>Ordered {l.so.ordered} · invoiced {l.so.invoiced} · pending {l.so.pending} {l.product?.base_unit}</p>}
                      <Input aria-label={`Description line ${i + 1}`} maxLength={500} placeholder="Description" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                    </TableCell>
                    <TableCell><Input aria-label={`HSN line ${i + 1}`} className="min-w-24" inputMode="numeric" maxLength={8} value={l.hsn} onChange={(e) => update(l.key, { hsn: e.target.value })} /></TableCell>
                    <TableCell><Input aria-label={`Quantity line ${i + 1}`} className="min-w-20" inputMode={qtyInputMode(l.product?.base_unit)} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                      {l.product && <span className="text-xs text-muted-foreground">{l.product.base_unit}</span>}</TableCell>
                    <TableCell><Input aria-label={`Rate line ${i + 1}`} className="min-w-28" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} /></TableCell>
                    <TableCell><div className="flex gap-1">
                      <Input aria-label={`Discount line ${i + 1}`} className="min-w-20" inputMode="decimal" value={l.discount} onChange={(e) => update(l.key, { discount: e.target.value })} />
                      <Select value={l.discountMode} onValueChange={(v) => { if (v) update(l.key, { discountMode: v as Line['discountMode'] }) }}>
                        <SelectTrigger aria-label={`Discount type line ${i + 1}`} className="w-16"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="PERCENT">%</SelectItem><SelectItem value="AMOUNT">₹</SelectItem></SelectContent>
                      </Select></div></TableCell>
                    <TableCell><Select value={l.gstRate || undefined} onValueChange={(v) => { if (v) update(l.key, { gstRate: v }) }}>
                      <SelectTrigger aria-label={`GST line ${i + 1}`} className="min-w-20"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>{[...new Set([...gstRates, ...(l.gstRate ? [Number(l.gstRate)] : [])])].sort((a, b) => a - b).map((r) => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                    </Select></TableCell>
                    <TableCell className="text-right tabular-nums">{p ? money(p.taxable) : '—'}{p && p.discount + p.invoiceDiscount > 0 && <span className="block text-xs text-muted-foreground">−{money(p.discount + p.invoiceDiscount)}</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{p ? money(p.cgst + p.sgst + p.igst) : '—'}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{p ? money(p.total) : '—'}</TableCell>
                    <TableCell><Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button></TableCell>
                  </TableRow>
                )
              })}</TableBody>
            </Table>
          </div>
          {!fromSo && <CardContent className="pt-4"><Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus /> Add product</Button></CardContent>}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><div><CardTitle>Discount and charges</CardTitle><CardDescription>The invoice discount is shared across the products by value. Charges are taxed at the rates in Invoice Settings.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-3"><Label htmlFor="inv-hd">Invoice discount</Label>
                <div className="flex gap-1"><Input id="inv-hd" inputMode="decimal" value={h.hd} onChange={(e) => set('hd')(e.target.value)} />
                  <Select value={h.hd_mode} onValueChange={(v) => { if (v) setH((x) => ({ ...x, hd_mode: v as 'PERCENT' | 'AMOUNT' })) }}>
                    <SelectTrigger aria-label="Invoice discount type" className="w-16"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="PERCENT">%</SelectItem><SelectItem value="AMOUNT">₹</SelectItem></SelectContent>
                  </Select></div></div>
              <div className="space-y-1"><Label htmlFor="inv-freight">Freight (₹)</Label><Input id="inv-freight" inputMode="decimal" value={h.freight} onChange={(e) => set('freight')(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="inv-packing">Packing (₹)</Label><Input id="inv-packing" inputMode="decimal" value={h.packing} onChange={(e) => set('packing')(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="inv-other">{settings.other_charge_label || 'Other charges'} (₹)</Label><Input id="inv-other" inputMode="decimal" value={h.other} onChange={(e) => set('other')(e.target.value)} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Summary</CardTitle><CardDescription>A preview; the server recalculates when saving.</CardDescription></div></CardHeader>
            <CardContent><dl className="space-y-1 text-sm">
              {([['Subtotal', totals.subtotal], ['Discount', -totals.discount], ['Freight / packing / other', totals.chargesTaxable], ['Taxable amount', totals.taxable],
                ...(inter ? [['IGST', totals.igst]] : [['CGST', totals.cgst], ['SGST', totals.sgst]]),
                ...(settings.round_off_enabled ? [['Round off', totals.roundOff]] : [])] as [string, number][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><dt>{k}</dt><dd className="tabular-nums">{money(v)}</dd></div>
              ))}
              <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold"><dt>Grand total</dt><dd className="tabular-nums" data-testid="inv-grand-total">{money(totals.grandTotal)}</dd></div>
              <div className="flex justify-between gap-4 text-muted-foreground"><dt>Amount received</dt><dd className="tabular-nums">{money(0)}</dd></div>
              <div className="flex justify-between gap-4 font-medium"><dt>Balance due</dt><dd className="tabular-nums">{money(totals.grandTotal)}</dd></div>
            </dl></CardContent>
          </Card>
        </div>

        {pendingWarnings && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> This change affects the balance or the tax:</p>
            <ul className="list-disc pl-5">{pendingWarnings.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <div className="flex gap-2"><Button type="button" size="sm" onClick={() => void save(pendingWarnings.andIssue, true)}>Save the change</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setPendingWarnings(null)}>Keep editing</Button></div>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" asChild><Link to={invoice ? `/billing/invoices/${invoice.id}` : '/billing/invoices'}>Cancel</Link></Button>
          <Button type="submit" variant={h.proforma || !has('invoices.issue') ? 'default' : 'outline'} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {h.proforma ? 'Save proforma' : 'Save draft'}</Button>
          {!h.proforma && has('invoices.issue') && (
            <Button type="button" disabled={busy !== null} onClick={() => void save(true)}>{busy === 'issue' ? <Loader2 className="animate-spin" /> : <FileCheck2 />} Save and issue</Button>
          )}
        </div>
      </form>

      <PartialInvoiceDialog warnings={partialAfterSave?.warnings ?? null}
        onBack={() => { const id = partialAfterSave?.invoiceId; setPartialAfterSave(null); setBusy(null)
          if (id) navigate(`/billing/invoices/${id}`, { replace: Boolean(invoice), state: { message: 'The draft was saved and not posted. Change the quantities or post it from here.' } }) }}
        onContinue={() => { const id = partialAfterSave?.invoiceId; setPartialAfterSave(null); if (id) void postSaved(id) }} />

      {quickCustomer && (
        <QuickAddPartyDialog role="CUSTOMER" onClose={() => setQuickCustomer(false)} onCreated={async (r) => {
          setQuickCustomer(false)
          try {
            const list = await fetchCustomers(false)
            setCustomerList(list)
            chooseCustomer(r.roleId, list)
          } catch { /* the list reloads next time */ }
        }} />
      )}
      {quickProduct && (
        <QuickAddProductDialog onClose={() => setQuickProduct(false)} onCreated={(p) => {
          setQuickProduct(false)
          const option: ProductOption = { product_id: p.product_id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: false, track_expiry: false }
          setLines((ls) => {
            const empty = ls.find((l) => !l.product)
            const fill = { product: option, description: p.product_name, unitPrice: str(p.selling_price), gstRate: str(p.gst_rate), hsn: (p as { hsn_code?: string | null }).hsn_code ?? '' }
            return empty ? ls.map((l) => (l.key === empty.key ? { ...l, ...fill } : l)) : [...ls, { ...blank(), ...fill }]
          })
        }} />
      )}
    </>
  )
}
