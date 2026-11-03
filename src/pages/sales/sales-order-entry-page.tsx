import { Loader2, PackagePlus, Plus, Save, Trash2, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

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
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { qtyInputMode } from '@/features/inventory/whole-units'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { QuickAddProductDialog } from '@/features/products/quick-add-product'
import { isInterState, priceOrder, validateSoForm } from '@/features/sales/sales-v2-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { fetchCustomers } from '@/services/customer-po'
import type { ProductOption } from '@/services/inventory'
import { fetchProductsByIds } from '@/services/products'
import { fetchCompanyGstin, fetchSalesOrderHeader, fetchSalesOrderLinesV2, saveSalesOrderV2, type SalesOrderV2Header } from '@/services/sales-v2'
import type { CustomerRow } from '@/types/database-customer-po'

interface Line {
  key: string
  lineId: string | null
  product: ProductOption | null
  description: string
  quantity: string
  unitPrice: string
  discountMode: 'PERCENT' | 'AMOUNT'
  discount: string
  gstRate: string
  dispatched: number
}
const blank = (): Line => ({ key: crypto.randomUUID(), lineId: null, product: null, description: '', quantity: '', unitPrice: '', discountMode: 'PERCENT', discount: '', gstRate: '', dispatched: 0 })
const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)))

async function load(soId: string | undefined) {
  const [customers, companyGstin, header, lines] = await Promise.all([
    fetchCustomers(false), fetchCompanyGstin(),
    soId ? fetchSalesOrderHeader(soId) : Promise.resolve(null),
    soId ? fetchSalesOrderLinesV2(soId) : Promise.resolve([]),
  ])
  return { customers, companyGstin, header, lines }
}

/** /sales/orders/new and /sales/orders/:soId/edit */
export default function SalesOrderEntryPage() {
  const { soId } = useParams()
  const data = useAsync(() => load(soId), [soId])
  const crumbs = [{ label: 'Sales & Fulfilment' }, { label: 'Sales Orders', to: '/sales/orders' }, { label: soId ? 'Edit' : 'New' }]
  if (data.loading && !data.data) return <LoadingState label="Loading…" />
  if (data.error || !data.data) return (<><PageHeader title="Sales order" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)
  return <EntryForm {...data.data} crumbs={crumbs} reloadCustomers={data.reload} />
}

function EntryForm({ customers, companyGstin, header: so, lines: soLines, crumbs, reloadCustomers }: {
  customers: CustomerRow[]
  companyGstin: string | null
  header: SalesOrderV2Header | null
  lines: Awaited<ReturnType<typeof fetchSalesOrderLinesV2>>
  crumbs: { label: string; to?: string }[]
  reloadCustomers: () => void
}) {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const storage = useStorage()
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const erpPrefs = useErpPreferences().prefs
  const [customerList, setCustomerList] = useState(customers)
  const [customerId, setCustomerId] = useState(so?.customer_id ?? '')
  const customer = customerList.find((c) => c.id === customerId) ?? null
  const [h, setH] = useState({
    order_date: so?.order_date ?? today,
    customer_gstin: so?.customer_gstin_snapshot ?? '',
    billing_address: so?.billing_address_snapshot ?? '',
    shipping_address: so?.shipping_address_snapshot ?? '',
    requested_delivery_date: so?.requested_delivery_date ?? '',
    // New orders start with the defaults from ERP Settings → Sales.
    payment_terms: so ? (so.payment_terms ?? '') : (erpPrefs?.['sales.default_payment_terms'] ?? ''),
    delivery_instructions: so ? (so.delivery_instructions ?? '') : (erpPrefs?.['sales.default_delivery_instructions'] ?? ''),
    customer_reference: so?.customer_reference ?? so?.customer_po_number ?? '',
    internal_notes: so?.internal_notes ?? '',
    warehouse_id: so ? (so.warehouse_id ?? '') : (erpPrefs?.['sales.default_warehouse_id'] ?? ''),
    freight_amount: so ? str(so.freight_amount) : '',
    other_charges_amount: so ? str(so.other_charges_amount) : '',
    charges_gst_rate: so ? str(so.charges_gst_rate) : '18',
    correction_reason: '',
  })
  const set = (k: keyof typeof h) => (v: string) => setH((x) => ({ ...x, [k]: v }))
  const [lines, setLines] = useState<Line[]>(() => soLines.length
    ? soLines.filter((l) => l.quantity_ordered - l.quantity_cancelled > 0).map((l) => ({
      key: l.id, lineId: l.id, product: { product_id: l.product_id, sku: l.sku_snapshot, product_name: l.product_name_snapshot, base_unit: l.unit, track_batches: false, track_expiry: false },
      description: l.description ?? '', quantity: str(l.quantity_ordered - l.quantity_cancelled), unitPrice: str(l.unit_price_snapshot),
      discountMode: l.discount_percent !== null ? 'PERCENT' : 'AMOUNT', discount: l.discount_percent !== null ? str(l.discount_percent) : (Number(l.discount_amount) ? str(l.discount_amount) : ''),
      gstRate: str(l.gst_rate), dispatched: Number(l.quantity_dispatched),
    }))
    : [blank()])
  const [quickCustomer, setQuickCustomer] = useState(false)
  const [quickProduct, setQuickProduct] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'draft'>(null)
  const [error, setError] = useState<string | null>(null)
  const dispatchedAny = lines.some((l) => l.dispatched > 0)

  const update = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)))
  const pickProduct = async (key: string, p: ProductOption | null) => {
    update(key, { product: p })
    if (!p) return
    try {
      const [row] = await fetchProductsByIds([p.product_id])
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, unitPrice: l.unitPrice || str(row?.selling_price), gstRate: l.gstRate || str(row?.gst_rate) } : l)))
    } catch { /* price and GST stay blank; the server uses the Product Master */ }
  }
  const chooseCustomer = (id: string, list: CustomerRow[] = customerList) => {
    const c = list.find((x) => x.id === id)
    setCustomerId(id)
    setH((x) => ({ ...x, customer_gstin: c?.gstin ?? '', billing_address: c?.billing_address ?? '', shipping_address: c?.shipping_address ?? c?.billing_address ?? '',
      payment_terms: c?.payment_terms_days ? `${c.payment_terms_days} days` : x.payment_terms }))
  }

  const inter = isInterState(companyGstin, customer?.billing_state_code ?? customer?.gstin ?? h.customer_gstin ?? null)
  const totals = useMemo(() => priceOrder(lines.filter((l) => l.product).map((l) => ({
    quantity: Number(l.quantity) || 0, unitPrice: l.unitPrice.trim() ? Number(l.unitPrice) : null,
    discountPercent: l.discountMode === 'PERCENT' && l.discount.trim() ? Number(l.discount) : null,
    discountAmount: l.discountMode === 'AMOUNT' && l.discount.trim() ? Number(l.discount) : null,
    gstRate: l.gstRate.trim() ? Number(l.gstRate) : null,
  })), { freight: Number(h.freight_amount) || 0, other: Number(h.other_charges_amount) || 0, gstRate: Number(h.charges_gst_rate) || 0 }, inter), [lines, h.freight_amount, h.other_charges_amount, h.charges_gst_rate, inter])

  const save = async (draft: boolean) => {
    setError(null)
    const problems = validateSoForm(customerId || null, lines.map((l) => ({
      product: l.product ? { unit: l.product.base_unit, sku: l.product.sku } : null, quantity: l.quantity, unitPrice: l.unitPrice,
      discountPercent: l.discountMode === 'PERCENT' ? l.discount : '', discountAmount: l.discountMode === 'AMOUNT' ? l.discount : '', gstRate: l.gstRate,
    })), { freight: h.freight_amount, other: h.other_charges_amount })
    if (h.requested_delivery_date && h.requested_delivery_date < h.order_date) problems.push('The expected delivery date cannot be before the order date.')
    if (!so && h.order_date > today) problems.push('The order date cannot be in the future.')
    if (so && dispatchedAny && h.correction_reason.trim().length < 3) problems.push('Part of this order was dispatched: enter the reason for the correction.')
    if (problems.length) return setError(problems.join(' '))
    setBusy(draft ? 'draft' : 'save')
    try {
      const res = await saveSalesOrderV2(so?.id ?? null, {
        customer_id: customerId, order_date: h.order_date, customer_gstin: h.customer_gstin.trim() || null, billing_address: h.billing_address.trim() || null,
        shipping_address: h.shipping_address.trim() || null, requested_delivery_date: h.requested_delivery_date || null, payment_terms: h.payment_terms.trim() || null,
        delivery_instructions: h.delivery_instructions.trim() || null, customer_reference: h.customer_reference.trim() || null,
        ...(so ? {} : { customer_po_number: h.customer_reference.trim() || null }),
        internal_notes: h.internal_notes.trim() || null, warehouse_id: h.warehouse_id || null,
        freight_amount: h.freight_amount.trim() || '0', other_charges_amount: h.other_charges_amount.trim() || '0', charges_gst_rate: h.charges_gst_rate.trim() || '18',
        draft, correction_reason: h.correction_reason.trim() || null,
      }, lines.filter((l) => l.product).map((l) => ({
        line_id: l.lineId, product_id: l.product!.product_id, description: l.description.trim() || null, quantity: l.quantity.trim(),
        unit_price: l.unitPrice.trim() || null, discount_percent: l.discountMode === 'PERCENT' ? (l.discount.trim() || null) : null,
        discount_amount: l.discountMode === 'AMOUNT' ? (l.discount.trim() || null) : null, gst_rate: l.gstRate.trim() || null,
      })), so ? null : request.key)
      request.renew()
      navigate(`/sales/orders/${res.sales_order_id}`, { replace: Boolean(so), state: {
        message: draft ? `${res.sales_order_number} saved as a draft. Nothing is reserved until it is saved as an open order.`
          : `${res.sales_order_number} ${so ? 'saved' : 'created'}. Available stock was reserved automatically; nothing has left the warehouse.`,
        warnings: (res as { warnings?: string[] }).warnings ?? [] } })
    } catch (e) {
      setError(describeDataError(e))
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader title={so ? `Edit ${so.sales_order_number}` : 'New sales order'}
        description={so ? 'Change customer, products, quantities, prices, discounts or dates. Reservations are recalculated when you save; every change is kept in the history.'
          : 'One order, any number of products. On saving, available finished goods are reserved and the materials for anything still to be made are checked.'}
        breadcrumbs={crumbs} />
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(false) }} className="space-y-6">
        <Card>
          <CardHeader><div><CardTitle>Basic information</CardTitle><CardDescription>Sales order number: {so?.sales_order_number ?? 'assigned automatically when saved'}</CardDescription></div></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="so-customer">Customer *</Label>
              <div className="flex gap-2">
                <Select value={customerId || undefined} onValueChange={(v) => { if (v) chooseCustomer(v) }} disabled={Boolean(so && dispatchedAny)}>
                  <SelectTrigger id="so-customer" className="w-full"><SelectValue placeholder="Select a customer" /></SelectTrigger>
                  <SelectContent className="max-h-72">{customerList.map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent>
                </Select>
                {has('customers.manage') && <Button type="button" variant="outline" onClick={() => setQuickCustomer(true)}><UserPlus /> New customer</Button>}
              </div></div>
            <div className="space-y-1"><Label htmlFor="so-date">Order date</Label><Input id="so-date" type="date" max={today} disabled={Boolean(so)} value={h.order_date} onChange={(e) => set('order_date')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="so-gstin">Customer GSTIN</Label><Input id="so-gstin" maxLength={15} value={h.customer_gstin} onChange={(e) => set('customer_gstin')(e.target.value.toUpperCase())} placeholder="Not registered" /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="so-bill">Billing address</Label><Textarea id="so-bill" rows={2} maxLength={1000} value={h.billing_address} onChange={(e) => set('billing_address')(e.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="so-ship">Shipping address</Label><Textarea id="so-ship" rows={2} maxLength={1000} value={h.shipping_address} onChange={(e) => set('shipping_address')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="so-exp">Expected delivery date</Label><Input id="so-exp" type="date" min={h.order_date} value={h.requested_delivery_date} onChange={(e) => set('requested_delivery_date')(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="so-terms">Payment terms</Label><Input id="so-terms" maxLength={200} value={h.payment_terms} onChange={(e) => set('payment_terms')(e.target.value)} placeholder="e.g. 30 days" /></div>
            <div className="space-y-1"><Label htmlFor="so-ref">Reference number</Label><Input id="so-ref" maxLength={100} value={h.customer_reference} onChange={(e) => set('customer_reference')(e.target.value)} placeholder="Customer's order no." /></div>
            <div className="space-y-1"><Label htmlFor="so-wh">Dispatch warehouse</Label>
              <Select value={h.warehouse_id || 'any'} onValueChange={(v) => { if (v) set('warehouse_id')(v === 'any' ? '' : v) }}>
                <SelectTrigger id="so-wh"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="any">Any warehouse</SelectItem>
                  {storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="so-ins">Delivery instructions</Label><Textarea id="so-ins" rows={2} maxLength={1000} value={h.delivery_instructions} onChange={(e) => set('delivery_instructions')(e.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="so-remarks">Remarks</Label><Textarea id="so-remarks" rows={2} maxLength={2000} value={h.internal_notes} onChange={(e) => set('internal_notes')(e.target.value)} /></div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <div><CardTitle>Product details</CardTitle><CardDescription>Price and GST come from the Product Master and can be changed. {inter ? 'Inter-state: IGST.' : 'Within the state: CGST + SGST.'}</CardDescription></div>
            {has('products.create') && <Button type="button" size="sm" variant="outline" onClick={() => setQuickProduct('new')}><PackagePlus /> New product</Button>}
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead className="min-w-64">Product / description</TableHead><TableHead className="w-28">Quantity</TableHead><TableHead className="w-28">Price (₹)</TableHead>
                <TableHead className="w-40">Discount</TableHead><TableHead className="w-20">GST %</TableHead><TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">GST</TableHead><TableHead className="text-right">Total</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>{lines.map((l, i) => {
                const p = l.product ? totals.lines[lines.filter((x) => x.product).indexOf(l)] : null
                return (
                  <TableRow key={l.key} className="align-top">
                    <TableCell className="space-y-1">
                      <ProductPicker id={`so-p-${i}`} value={l.product} onChange={(v) => void pickProduct(l.key, v)} />
                      {l.product && <p className="text-xs text-muted-foreground">{l.product.sku} · {l.product.base_unit}{l.dispatched > 0 ? ` · ${l.dispatched} dispatched` : ''}</p>}
                      <Input aria-label={`Description line ${i + 1}`} maxLength={500} placeholder="Description (optional)" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                    </TableCell>
                    <TableCell><Input aria-label={`Quantity line ${i + 1}`} id={`so-q-${i}`} inputMode={qtyInputMode(l.product?.base_unit)} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                      {l.product && <span className="text-xs text-muted-foreground">{l.product.base_unit}</span>}</TableCell>
                    <TableCell><Input aria-label={`Price line ${i + 1}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} /></TableCell>
                    <TableCell><div className="flex gap-1">
                      <Input aria-label={`Discount line ${i + 1}`} inputMode="decimal" value={l.discount} onChange={(e) => update(l.key, { discount: e.target.value })} />
                      <Select value={l.discountMode} onValueChange={(v) => { if (v) update(l.key, { discountMode: v as Line['discountMode'] }) }}>
                        <SelectTrigger aria-label={`Discount type line ${i + 1}`} className="w-16"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="PERCENT">%</SelectItem><SelectItem value="AMOUNT">₹</SelectItem></SelectContent>
                      </Select></div></TableCell>
                    <TableCell><Input aria-label={`GST line ${i + 1}`} inputMode="decimal" value={l.gstRate} onChange={(e) => update(l.key, { gstRate: e.target.value })} /></TableCell>
                    <TableCell className="text-right tabular-nums">{p ? money(p.taxable) : '—'}{p && p.discount > 0 && <span className="block text-xs text-muted-foreground">−{money(p.discount)}</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{p ? money(p.gst) : '—'}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{p ? money(p.total) : '—'}</TableCell>
                    <TableCell><Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1 || l.dispatched > 0}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button></TableCell>
                  </TableRow>
                )
              })}</TableBody>
            </Table>
          </div>
          <CardContent className="pt-4"><Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus /> Add product</Button></CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><div><CardTitle>Charges</CardTitle><CardDescription>Freight and other charges are taxed at the rate below.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1"><Label htmlFor="so-freight">Freight (₹)</Label><Input id="so-freight" inputMode="decimal" value={h.freight_amount} onChange={(e) => set('freight_amount')(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="so-other">Other charges (₹)</Label><Input id="so-other" inputMode="decimal" value={h.other_charges_amount} onChange={(e) => set('other_charges_amount')(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="so-cgst">GST on charges %</Label><Input id="so-cgst" inputMode="decimal" value={h.charges_gst_rate} onChange={(e) => set('charges_gst_rate')(e.target.value)} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Totals</CardTitle><CardDescription>A preview; the server recalculates when saving.</CardDescription></div></CardHeader>
            <CardContent><dl className="space-y-1 text-sm">
              {([['Subtotal', totals.subtotal], ['Discounts', -totals.discount], ['Freight', totals.freight], ['Other charges', totals.other], ['Taxable amount', totals.taxable],
                ...(inter ? [['IGST', totals.igst]] : [['CGST', totals.cgst], ['SGST', totals.sgst]])] as [string, number][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><dt>{k}</dt><dd className="tabular-nums">{money(v)}</dd></div>
              ))}
              <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold"><dt>Grand total</dt><dd className="tabular-nums" data-testid="so-grand-total">{money(totals.grandTotal)}</dd></div>
            </dl></CardContent>
          </Card>
        </div>

        {so && dispatchedAny && (
          <div className="space-y-1"><Label htmlFor="so-reason">Reason for the correction *</Label><Input id="so-reason" maxLength={500} value={h.correction_reason} onChange={(e) => set('correction_reason')(e.target.value)} placeholder="Recorded in the order history with the old and new values" /></div>
        )}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" asChild><Link to={so ? `/sales/orders/${so.id}` : '/sales/orders'}>Cancel</Link></Button>
          {(!so || ['DRAFT', 'PENDING_CONFIRMATION'].includes(so.order_status)) && (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void save(true)}>{busy === 'draft' && <Loader2 className="animate-spin" />} Save as draft</Button>
          )}
          <Button type="submit" disabled={busy !== null}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} {so ? 'Save and recalculate' : 'Save and reserve stock'}</Button>
        </div>
      </form>

      {quickCustomer && (
        <QuickAddPartyDialog role="CUSTOMER" onClose={() => setQuickCustomer(false)} onCreated={async (r) => {
          setQuickCustomer(false)
          try {
            const list = await fetchCustomers(false)
            setCustomerList(list)
            chooseCustomer(r.roleId, list)
          } catch { reloadCustomers() }
        }} />
      )}
      {quickProduct && (
        <QuickAddProductDialog onClose={() => setQuickProduct(null)} onCreated={(p) => {
          setQuickProduct(null)
          const option: ProductOption = { product_id: p.product_id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: false, track_expiry: false }
          setLines((ls) => {
            const empty = ls.find((l) => !l.product)
            const filled = { product: option, unitPrice: str(p.selling_price), gstRate: str(p.gst_rate) }
            return empty ? ls.map((l) => (l.key === empty.key ? { ...l, ...filled } : l)) : [...ls, { ...blank(), ...filled }]
          })
        }} />
      )}
    </>
  )
}
