import { Info, Loader2, Plus, Trash2, UserPlus } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { DraftVersionNotice } from '@/components/common/draft-version-notice'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { money } from '@/features/billing/billing-model'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { useGstStates } from '@/features/billing/use-gst-states'
import { STANDARD_GST_RATES } from '@/features/products/product-model'
import { formatCost } from '@/features/products/product-list-format'
import { CostTrend } from '@/features/products/purchase-cost-badge'
import { costChange, isSignificant, poLineNetUnitCost, signedMoney, type ProductPurchaseCost } from '@/features/products/purchase-cost'
import { calcTotals, taxTreatmentFor } from '@/features/purchasing/po-calc'
import { PoProductPicker } from '@/features/purchasing/po-components'
import { LINE_TYPE_LABELS, linesPayload, PURCHASE_TYPE_LABELS, TAX_TREATMENT_LABELS, validatePoLines, type PoFormLine } from '@/features/purchasing/po-model'
import { PAYMENT_TERMS_LABELS, paymentTermsLabel } from '@/features/suppliers/supplier-model'
import { useStorage } from '@/features/inventory/use-storage'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import { formatDate, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchPoLines, fetchPoSupplierOptions, fetchPurchaseOrder, openPurchaseOrder, purchaseOrderAction, savePurchaseOrder, type PoSupplierOption } from '@/services/purchasing'
import { fetchPurchaseCosts } from '@/services/purchase-costs'
import { fetchSalesOrderV2 } from '@/services/sales-v2'
import type { PoLineType, PurchaseOrderListRow, PurchaseOrderLineListRow, PurchaseType } from '@/types/database-purchasing'

let keySeq = 0
const newKey = () => `l${++keySeq}`

function blankLine(type: PoLineType): PoFormLine {
  return { key: newKey(), id: null, line_type: type, product_id: null, sku: null, product_name: null, description: type === 'CHARGE' ? 'Freight' : '',
    unit: type === 'GOODS' ? '' : 'NOS', hsn_sac: '', quantity: '1', unit_price: '', discount_mode: 'PERCENT', discount: '', gst_rate: '', received: 0 }
}

function lineFromRow(l: PurchaseOrderLineListRow): PoFormLine {
  const pct = l.discount_percent !== null && Number(l.discount_percent) > 0
  return {
    key: newKey(), id: l.id, line_type: l.line_type, product_id: l.product_id, sku: l.sku, product_name: l.product_id ? l.description : null,
    description: l.description, unit: l.unit, hsn_sac: l.hsn_sac ?? '', quantity: String(Number(l.ordered_quantity)),
    unit_price: l.unit_price === null ? '' : String(Number(l.unit_price)), discount_mode: pct ? 'PERCENT' : 'AMOUNT',
    discount: pct ? String(Number(l.discount_percent)) : Number(l.discount_value_input) > 0 ? String(Number(l.discount_value_input)) : '',
    gst_rate: l.gst_rate === null ? '' : String(Number(l.gst_rate)), received: Number(l.accepted_quantity),
  }
}

/** A duplicated line is a new line: no id, nothing received. */
const copyLine =(l: PoFormLine): PoFormLine => ({ ...l, key: newKey(), id: null, received: 0 })

/** Stage 5: shortage items of a sales order, with the recommended quantity, as new PO lines. */
interface SoPrefill { soNumber: string; supplierId: string | null; lines: PoFormLine[] }

async function loadSoPrefill(soId: string): Promise<SoPrefill> {
  const so = await fetchSalesOrderV2(soId)
  const short = so.shortages.filter((s) => Number(s.recommended_purchase) > 0)
  const counts = new Map<string, number>()
  for (const s of short) if (s.preferred_supplier_id) counts.set(s.preferred_supplier_id, (counts.get(s.preferred_supplier_id) ?? 0) + 1)
  const supplierId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    soNumber: so.sales_order_number,
    supplierId,
    lines: short.map((s) => ({
      ...blankLine('GOODS'), product_id: s.product_id, sku: s.sku, product_name: s.product_name, description: s.product_name, unit: s.unit,
      hsn_sac: s.hsn_code ?? '', quantity: String(Number(s.recommended_purchase)), unit_price: s.standard_cost === null ? '' : String(Number(s.standard_cost)),
      gst_rate: s.gst_rate === null ? '' : String(Number(s.gst_rate)),
    })),
  }
}

async function loadForm(poId: string | undefined, copyId: string | null, fromSo: string | null) {
  const db = requireSupabase()
  const sourceId = poId ?? copyId
  const [suppliers, source, lines, company, prefill] = await Promise.all([
    fetchPoSupplierOptions(),
    sourceId ? fetchPurchaseOrder(sourceId) : Promise.resolve(null),
    sourceId ? fetchPoLines(sourceId) : Promise.resolve([]),
    // Company GSTIN for the tax preview only (the server decides). Null if not readable.
    db.from('companies').select('gstin').limit(1).maybeSingle().then((r) => (r.error ? null : (r.data?.gstin ?? null))),
    fromSo ? loadSoPrefill(fromSo) : Promise.resolve(null),
  ])
  return poId
    ? { suppliers, po: source, copyFrom: null, lines, companyGstin: company as string | null, prefill: null }
    : { suppliers, po: null, copyFrom: source, lines, companyGstin: company as string | null, prefill }
}

/**
 * Create a purchase order or edit a draft. The company is the signed-in user's;
 * the server snapshots supplier / product details, decides the tax treatment
 * and recalculates every amount when saving. The totals here are a preview.
 */
export default function PoFormPage() {
  const { poId } = useParams()
  const [searchParams] = useSearchParams()
  const copyId = poId ? null : searchParams.get('copy')
  const fromSo = poId ? null : searchParams.get('from_so')
  const data = useAsync(() => loadForm(poId, copyId, fromSo), [poId, copyId, fromSo])
  if (data.loading && !data.data) return <LoadingState label="Loading…" />
  if (data.error || !data.data) {
    return (
      <>
        <PageHeader title={poId ? 'Edit purchase order' : 'New purchase order'} breadcrumbs={[{ label: 'Orders' }, { label: 'Supplier Purchase Orders', to: '/purchase-orders' }, { label: poId ? 'Edit' : 'New' }]} />
        <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card>
      </>
    )
  }
  return <PoForm key={copyId ?? fromSo ?? poId ?? 'new'} {...data.data} draftScope={copyId ? `copy:${copyId}` : fromSo ? `so:${fromSo}` : ''} />
}

function PoForm({ suppliers, po, copyFrom, lines: initialLines, companyGstin, prefill, draftScope }: {
  suppliers: PoSupplierOption[]; po: PurchaseOrderListRow | null; copyFrom: PurchaseOrderListRow | null; lines: PurchaseOrderLineListRow[]; companyGstin: string | null
  prefill: SoPrefill | null; draftScope: string
}) {
  const navigate = useNavigate()
  const { access } = useAuth()
  const { has } = usePermissions()
  // V2 single-operator: a user who may approve opens the order in one step.
  const canOpen = has('purchase_order.approve')
  const storage = useStorage()
  const { label: stateLabel } = useGstStates()
  const request = useRequestKey()
  const locked = Boolean(po && (po.revision > 0 || po.receipt_count > 0))
  const [today] = useState(() => toIsoDate(new Date()))

  // Suppliers can be added from this screen (quick add), so the list is local state.
  const [supplierOptions, setSupplierOptions] = useState(suppliers)
  const [quickAdd, setQuickAdd] = useState(false)
  // An order's own supplier stays selectable even if it was deactivated later.
  const supplierList = useMemo(() => {
    const suppliers = supplierOptions
    if (!po || suppliers.some((s) => s.id === po.supplier_id)) return suppliers
    return [{ id: po.supplier_id, supplier_code: po.supplier_code, legal_name: po.supplier_name, display_name: null, category: 'OTHER', gstin: po.supplier_gstin,
      state_code: po.supplier_state_code, country: po.supplier_country, payment_terms: po.payment_terms, custom_payment_days: po.custom_payment_days,
      billing_address: po.supplier_billing_address, shipping_address: po.supplier_shipping_address, contact_person: po.supplier_contact_person,
      email: po.supplier_email, phone: po.supplier_phone } as PoSupplierOption, ...suppliers]
  }, [po, supplierOptions])

  // A duplicate copies supplier, terms, items and notes; dates and the reference start fresh.
  const src = po ?? copyFrom
  const erpPrefs = useErpPreferences().prefs
  const copySupplierOk = !copyFrom || suppliers.some((s) => s.id === copyFrom.supplier_id)
  const [h, setH] = useState({
    supplier_id: copySupplierOk ? (src?.supplier_id ?? (prefill?.supplierId && suppliers.some((s) => s.id === prefill.supplierId) ? prefill.supplierId : '')) : '', po_date: po?.po_date ?? today, expected_delivery_date: po?.expected_delivery_date ?? '',
    warehouse_id: src?.warehouse_id ?? '', purchase_type: (src?.purchase_type ?? '') as PurchaseType | '',
    payment_terms: src?.payment_terms ?? '', custom_payment_days: src?.custom_payment_days ? String(src.custom_payment_days) : '',
    reference_number: po?.reference_number ?? '', delivery_instructions: src ? (src.delivery_instructions ?? '') : (erpPrefs?.['purchase.default_delivery_terms'] ?? ''), internal_notes: src?.internal_notes ?? '',
    purchase_conditions: src?.purchase_conditions ?? '',
    // Supplier's references belong to this order only (never copied to a duplicate).
    supplier_invoice_number: po?.supplier_invoice_number ?? '', supplier_challan_number: po?.supplier_challan_number ?? '',
  })
  const setHeader = (k: keyof typeof h) => (v: string) => { setH((x) => ({ ...x, [k]: v })); setErrors((e) => { const n = new Map(e); n.delete(`h:${k}`); return n }) }
  const [lines, setLines] = useState<PoFormLine[]>(() => (initialLines.length
    ? initialLines.map((l) => (copyFrom ? copyLine(lineFromRow(l)) : lineFromRow(l)))
    : prefill?.lines.length ? prefill.lines : [blankLine('GOODS')]))
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)

  const supplier = supplierList.find((s) => s.id === h.supplier_id) ?? null
  const treatment = po && supplier?.id === po.supplier_id && !companyGstin ? po.tax_treatment : taxTreatmentFor(supplier, companyGstin)
  // Last Purchase Cost of the products on the order, for the comparison under each line (nothing is changed).
  const productKey = [...new Set(lines.map((l) => l.product_id).filter(Boolean))].sort().join(',')
  const lineImages = useProductImagesById(lines.map((l) => l.product_id))
  const lastCosts = useAsync(() => (productKey ? fetchPurchaseCosts(productKey.split(','), h.supplier_id || null).catch(() => new Map<string, ProductPurchaseCost>()) : Promise.resolve(new Map<string, ProductPurchaseCost>())), [productKey, h.supplier_id])
  const preview = calcTotals(lines.map((l) => ({
    line_type: l.line_type, quantity: l.quantity, unit_price: l.unit_price || null,
    discount_percent: l.discount_mode === 'PERCENT' ? l.discount || null : null, discount_amount: l.discount_mode === 'AMOUNT' ? l.discount || null : null,
    gst_rate: l.gst_rate || null,
  })), treatment)
  const warehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE' || w.id === po?.warehouse_id)
  // New orders default to the company's default warehouse until the user picks one.
  const [warehouseTouched, setWarehouseTouched] = useState(Boolean(src?.warehouse_id))
  const warehouseId = warehouseTouched ? h.warehouse_id : (h.warehouse_id || storage.warehouses.find((w) => w.is_default && w.status === 'ACTIVE')?.id || '')

  // Auto-saved working copy: restored when the user comes back to this form.
  const draft = usePersistentFormDraft({
    formKey: 'purchase.order', recordId: po?.id ?? null, scope: draftScope, baseVersion: po?.updated_at ?? null,
    enabled: has('purchase_order.create') || has('purchase_order.update'),
    value: { h, lines: lines.map(({ key: _key, ...l }) => l), warehouseTouched },
    onRestore: (d) => {
      setH((x) => ({ ...x, ...d.h }))
      setLines(d.lines.map((l) => ({ ...l, key: newKey() })))
      setWarehouseTouched(Boolean(d.warehouseTouched))
      setErrors(new Map())
    },
  })

  const chooseSupplier = (id: string, list: PoSupplierOption[] = supplierList) => {
    const s = list.find((x) => x.id === id)
    // Suppliers without their own terms get the default purchase terms from ERP Settings.
    setH((x) => ({ ...x, supplier_id: id, payment_terms: s && !s.payment_terms ? (erpPrefs?.['purchase.default_payment_terms'] ?? '') : '', custom_payment_days: '',
      purchase_type: x.purchase_type || ((s?.category ?? '') in PURCHASE_TYPE_LABELS ? (s!.category as PurchaseType) : 'OTHER') }))
    setErrors((e) => { const n = new Map(e); n.delete('h:supplier_id'); n.delete('h:purchase_type'); return n })
  }
  const updateLine = (key: string, patch: Partial<PoFormLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setErrors((e) => { const n = new Map(e); for (const k of [...n.keys()]) if (k.startsWith(`${key}:`)) n.delete(k); return n })
  }

  const validate = (forSubmit: boolean) => {
    const e = validatePoLines(lines)
    if (!h.supplier_id) e.set('h:supplier_id', 'Select a supplier.')
    if (!h.purchase_type) e.set('h:purchase_type', 'Select the purchase type.')
    if (!h.po_date) e.set('h:po_date', 'Enter the PO date.')
    else if (h.po_date > today) e.set('h:po_date', 'The PO date cannot be in the future.')
    if (h.expected_delivery_date && h.po_date && h.expected_delivery_date < h.po_date) e.set('h:expected_delivery_date', 'The expected delivery date cannot be before the PO date.')
    if (h.payment_terms === 'CUSTOM' && !/^\d{1,3}$/.test(h.custom_payment_days) || (h.payment_terms === 'CUSTOM' && (Number(h.custom_payment_days) < 1 || Number(h.custom_payment_days) > 365))) e.set('h:custom_payment_days', 'Enter 1–365 days.')
    if (lines.length === 0) e.set('h:lines', 'Add at least one line.')
    if (forSubmit) {
      if (lines.some((l) => l.line_type === 'GOODS') && !warehouseId) e.set('h:warehouse_id', 'Choose the delivery warehouse for the goods.')
      lines.forEach((l, i) => {
        if (!l.unit_price.trim()) e.set(`${l.key}:unit_price`, `Line ${i + 1}: enter the unit price before submitting.`)
        if ((treatment === 'INTRA_STATE' || treatment === 'INTER_STATE') && !l.gst_rate.trim()) e.set(`${l.key}:gst_rate`, `Line ${i + 1}: set the GST rate before submitting.`)
      })
    }
    return e
  }

  const save = async (submit: boolean) => {
    setFormError(null)
    const e = validate(submit)
    setErrors(e)
    if (e.size) {
      setFormError(`Please correct ${e.size === 1 ? 'the highlighted field' : `the ${e.size} highlighted fields`}.`)
      return
    }
    setBusy(submit ? 'submit' : 'save')
    try {
      const res = await savePurchaseOrder(po?.id ?? null, {
        supplier_id: h.supplier_id, po_date: h.po_date, expected_delivery_date: h.expected_delivery_date || null, warehouse_id: warehouseId || null,
        purchase_type: h.purchase_type, payment_terms: h.payment_terms || null, custom_payment_days: h.payment_terms === 'CUSTOM' ? Number(h.custom_payment_days) : null,
        reference_number: h.reference_number.trim() || null, delivery_instructions: h.delivery_instructions.trim() || null,
        internal_notes: h.internal_notes.trim() || null, purchase_conditions: h.purchase_conditions.trim() || null,
      }, linesPayload(lines), po?.updated_at ?? null, po ? null : request.key,
      { supplier_invoice_number: h.supplier_invoice_number.trim() || null, supplier_challan_number: h.supplier_challan_number.trim() || null })
      request.renew()
      // The order is saved in the database: the working copy is no longer needed.
      void draft.markSubmitted()
      let message = `${res.po_number} ${po ? 'saved' : 'created'} as a draft.`
      if (submit) {
        try {
          if (canOpen) {
            await openPurchaseOrder(res.po_id, null)
            message = `${res.po_number} saved and opened. You can now record goods receipts against it.`
          } else {
            await purchaseOrderAction(res.po_id, 'SUBMIT', null, null)
            message = `${res.po_number} saved and submitted for approval.`
          }
        } catch (err) {
          navigate(`/purchase-orders/${res.po_id}`, { replace: true, state: { message: `${res.po_number} was saved as a draft but not ${canOpen ? 'opened' : 'submitted'}: ${describeDataError(err)}`, tone: 'error' } })
          return
        }
      }
      navigate(`/purchase-orders/${res.po_id}`, { replace: true, state: { message } })
    } catch (err) {
      setFormError(describeDataError(err))
      setBusy(null)
    }
  }

  const err = (k: string) => errors.get(k)
  const termsLabel = supplier ? paymentTermsLabel(supplier.payment_terms, supplier.custom_payment_days) : '—'
  const title = po ? `Edit ${po.po_number}${po.revision ? ` (revision ${po.revision})` : ''}` : 'New purchase order'

  return (
    <>
      <PageHeader title={title} description="Draft orders can be changed freely. Amounts are recalculated by the server on every save."
        breadcrumbs={[{ label: 'Orders' }, { label: 'Supplier Purchase Orders', to: '/purchase-orders' }, { label: po ? po.po_number : 'New' }]} />
      {/* "Save draft" below already creates a draft purchase order, so the auto-save bar has no button of its own. */}
      <FormDraftBar draft={draft} showSave={false} />
      {po?.status === 'DRAFT' && <DraftVersionNotice kind="PURCHASE_ORDER" id={po.id} onRefreshed={() => void draft.discard().then(() => window.location.reload())} />}
      {po?.rejection_reason && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">Rejected: {po.rejection_reason}</p>
      )}
      {prefill && (
        <p role="status" className="mb-4 flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {prefill.lines.length
            ? `Prefilled with the material shortages of ${prefill.soNumber} and the recommended quantities${prefill.supplierId ? ' (preferred supplier selected)' : ''}. Choose or change the supplier and edit anything before saving. Nothing is ordered until you save.`
            : `${prefill.soNumber} has no material shortages to purchase.`}
        </p>
      )}
      {copyFrom && (
        <p role="status" className="mb-4 flex gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> Copied from {copyFrom.po_number}: supplier, items, rates, discounts, GST, charges, terms and notes. Check the quantities and dates, then save. The original order is not changed.
          {!copySupplierOk && ' The original supplier is no longer active — choose a supplier.'}
        </p>
      )}
      {locked && (
        <p className="mb-4 flex gap-2 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> This is an amendment of an approved order. The supplier cannot change, and lines with received goods keep their product and cannot go below the received quantity.
        </p>
      )}

      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(false) }} className="space-y-6">
        {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{formError}</p>}

        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader><div><CardTitle>Order details</CardTitle><CardDescription>Company: {access?.company?.legal_name ?? '—'} · Currency: INR</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field id="po-supplier" label="Supplier" required error={err('h:supplier_id')} full>
                <div className="flex gap-2">
                  {/* '' comes from Radix's hidden native select when the value is set while its option is being added (quick add); a user choice is never ''. */}
                  <Select value={h.supplier_id || undefined} onValueChange={(v) => { if (v) chooseSupplier(v) }} disabled={locked}>
                    <SelectTrigger id="po-supplier" className="w-full" aria-invalid={Boolean(err('h:supplier_id')) || undefined}><SelectValue placeholder={supplierOptions.length ? 'Select an active supplier' : 'No active suppliers — add one'} /></SelectTrigger>
                    <SelectContent className="max-h-72">{supplierList.map((s) => <SelectItem key={s.id} value={s.id}>{s.supplier_code} — {s.display_name || s.legal_name}</SelectItem>)}</SelectContent>
                  </Select>
                  {!locked && has('suppliers.manage') && (
                    <Button type="button" variant="outline" onClick={() => setQuickAdd(true)}><UserPlus /> New supplier</Button>
                  )}
                </div>
              </Field>
              {quickAdd && (
                <QuickAddPartyDialog role="SUPPLIER" onClose={() => setQuickAdd(false)} onCreated={async (r) => {
                  setQuickAdd(false)
                  try {
                    const fresh = await fetchPoSupplierOptions()
                    setSupplierOptions(fresh)
                    chooseSupplier(r.roleId, fresh)
                    setFormError(null)
                  } catch (e) {
                    setFormError(`The supplier ${r.partyCode} was saved, but the list could not be refreshed: ${describeDataError(e)}`)
                  }
                }} />
              )}
              <Field id="po-date" label="PO date" required error={err('h:po_date')}>
                <Input id="po-date" type="date" max={today} value={h.po_date} onChange={(e) => setHeader('po_date')(e.target.value)} aria-invalid={Boolean(err('h:po_date')) || undefined} />
              </Field>
              <Field id="po-expected" label="Expected delivery date" error={err('h:expected_delivery_date')}>
                <Input id="po-expected" type="date" min={h.po_date} value={h.expected_delivery_date} onChange={(e) => setHeader('expected_delivery_date')(e.target.value)} aria-invalid={Boolean(err('h:expected_delivery_date')) || undefined} />
              </Field>
              <Field id="po-warehouse" label="Delivery warehouse" error={err('h:warehouse_id')} hint="Goods are received into this warehouse.">
                {/* '' comes from Radix's hidden native select when the value changes before its option exists; a user choice is never ''. */}
                <Select value={warehouseId || 'none'} onValueChange={(v) => { if (v === '') return; setWarehouseTouched(true); setHeader('warehouse_id')(v === 'none' ? '' : v) }}>
                  <SelectTrigger id="po-warehouse" className="w-full" aria-invalid={Boolean(err('h:warehouse_id')) || undefined}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="none">Not set</SelectItem>{warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="po-type" label="Purchase type" required error={err('h:purchase_type')}>
                <Select value={h.purchase_type || undefined} onValueChange={(v) => setHeader('purchase_type')(v)}>
                  <SelectTrigger id="po-type" className="w-full" aria-invalid={Boolean(err('h:purchase_type')) || undefined}><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{Object.entries(PURCHASE_TYPE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="po-terms" label="Payment terms" hint={supplier ? `Supplier's terms: ${termsLabel}. A different choice is shown to the approver.` : undefined}>
                <Select value={h.payment_terms || 'supplier'} onValueChange={(v) => setHeader('payment_terms')(v === 'supplier' ? '' : v)}>
                  <SelectTrigger id="po-terms" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supplier">Supplier's terms{supplier ? ` (${termsLabel})` : ''}</SelectItem>
                    {Object.entries(PAYMENT_TERMS_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {h.payment_terms === 'CUSTOM' && (
                <Field id="po-days" label="Custom payment days" required error={err('h:custom_payment_days')}>
                  <Input id="po-days" inputMode="numeric" maxLength={3} value={h.custom_payment_days} onChange={(e) => setHeader('custom_payment_days')(e.target.value)} aria-invalid={Boolean(err('h:custom_payment_days')) || undefined} />
                </Field>
              )}
              <Field id="po-ref" label="Reference number" hint="Supplier quotation or indent number.">
                <Input id="po-ref" maxLength={100} value={h.reference_number} onChange={(e) => setHeader('reference_number')(e.target.value)} />
              </Field>
              <Field id="po-invoice" label="Supplier invoice no." hint="Optional. Can also be added later, and per GRN when goods arrive.">
                <Input id="po-invoice" maxLength={100} autoComplete="off" value={h.supplier_invoice_number} onChange={(e) => setHeader('supplier_invoice_number')(e.target.value)} />
              </Field>
              <Field id="po-challan" label="Supplier challan no." hint="Optional. The supplier's delivery challan number.">
                <Input id="po-challan" maxLength={100} autoComplete="off" value={h.supplier_challan_number} onChange={(e) => setHeader('supplier_challan_number')(e.target.value)} />
              </Field>
              <Field id="po-delivery" label="Delivery instructions" full>
                <Textarea id="po-delivery" rows={2} maxLength={2000} value={h.delivery_instructions} onChange={(e) => setHeader('delivery_instructions')(e.target.value)} />
              </Field>
              <Field id="po-conditions" label="Purchase conditions (printed on the PO)" full>
                <Textarea id="po-conditions" rows={2} maxLength={4000} value={h.purchase_conditions} onChange={(e) => setHeader('purchase_conditions')(e.target.value)} />
              </Field>
              <Field id="po-notes" label="Internal notes (not printed)" full>
                <Textarea id="po-notes" rows={2} maxLength={2000} value={h.internal_notes} onChange={(e) => setHeader('internal_notes')(e.target.value)} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><div><CardTitle>Supplier billing and dispatch</CardTitle><CardDescription>Copied onto the order when it is saved.</CardDescription></div></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!supplier ? <p className="text-muted-foreground">Select a supplier.</p> : (
                <>
                  <p className="font-medium">{supplier.legal_name}</p>
                  <dl className="space-y-1.5">
                    <Row label="GSTIN">{supplier.gstin ?? 'Not registered'}</Row>
                    <Row label="State">{supplier.state_code ? stateLabel(supplier.state_code) : '—'}{supplier.country !== 'India' ? ` · ${supplier.country}` : ''}</Row>
                    <Row label="Contact">{[supplier.contact_person, supplier.phone, supplier.email].filter(Boolean).join(' · ') || '—'}</Row>
                    <Row label="Billing address"><span className="whitespace-pre-line">{supplier.billing_address ?? '—'}</span></Row>
                    <Row label="Dispatch address"><span className="whitespace-pre-line">{supplier.shipping_address ?? (supplier.billing_address ? 'Same as billing' : '—')}</span></Row>
                  </dl>
                  <p className="rounded-md border bg-surface-muted/50 px-3 py-2 text-xs">Tax: {TAX_TREATMENT_LABELS[treatment]}{companyGstin ? '' : ' (confirmed by the server on save)'}</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div><CardTitle>Line items</CardTitle><CardDescription>Goods are received into stock; services and charges are not. Product details, GST rate and cost are copied from the Product Master.</CardDescription></div>
          </CardHeader>
          <CardContent className="space-y-3">
            {err('h:lines') && <p role="alert" className="text-sm text-red-700">{err('h:lines')}</p>}
            {lines.map((l, i) => (
              <LineEditor key={l.key} index={i} line={l} image={l.product_id ? lineImages.get(l.product_id) : undefined} calc={preview.lines[i]} errors={errors} locked={l.received > 0}
                lastCost={l.product_id ? lastCosts.data?.get(l.product_id) : undefined}
                onChange={(p) => updateLine(l.key, p)} onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine('GOODS')])}><Plus /> Add product</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine('SERVICE')])}><Plus /> Add service</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine('CHARGE')])}><Plus /> Add charge</Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2" />
          <Card>
            <CardHeader><div><CardTitle>Summary (preview)</CardTitle><CardDescription>{TAX_TREATMENT_LABELS[treatment]}</CardDescription></div></CardHeader>
            <CardContent>
              <dl className="space-y-1 text-sm">
                {([['Subtotal', preview.totals.gross], ['Discount', -preview.totals.discount], ['Taxable amount', preview.totals.taxable],
                  ['of which other charges', preview.totals.otherCharges], ['CGST', preview.totals.cgst], ['SGST', preview.totals.sgst], ['IGST', preview.totals.igst]] as [string, number][]).map(([k, v]) => (
                  <div key={k} className={cn('flex justify-between gap-4', k.startsWith('of which') && 'pl-3 text-xs text-muted-foreground')}><dt>{k}</dt><dd className="tabular-nums">{money(v)}</dd></div>
                ))}
                <div className="flex justify-between gap-4 text-xs text-muted-foreground"><dt className="shrink-0">Round-off</dt><dd className="text-right">on save, if enabled</dd></div>
                <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold"><dt>Grand total</dt><dd className="tabular-nums">{money(preview.totals.grand)}</dd></div>
              </dl>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => navigate(po ? `/purchase-orders/${po.id}` : '/purchase-orders')}>Cancel</Button>
          <Button type="submit" variant="outline" disabled={busy !== null}>{busy === 'save' && <Loader2 className="animate-spin" />} Save draft</Button>
          {(has('purchase_order.create') || has('purchase_order.update')) && (
            <Button type="button" disabled={busy !== null} onClick={() => void save(true)}>{busy === 'submit' && <Loader2 className="animate-spin" />} {canOpen ? 'Save and open order' : 'Save and submit for approval'}</Button>
          )}
        </div>
      </form>
    </>
  )
}

function LineEditor({ index, line: l, image, calc, errors, locked, lastCost, onChange, onRemove }: {
  index: number
  image?: string | null
  line: PoFormLine
  calc: { taxable: number; cgst: number; sgst: number; igst: number; total: number } | undefined
  errors: Map<string, string>
  locked: boolean
  lastCost?: ProductPurchaseCost
  onChange: (p: Partial<PoFormLine>) => void
  onRemove: () => void
}) {
  const id = (f: string) => `ln-${l.key}-${f}`
  const e = (f: string) => errors.get(`${l.key}:${f}`)
  const lineErrors = [...errors.entries()].filter(([k]) => k.startsWith(`${l.key}:`)).map(([, v]) => v)
  return (
    <fieldset className="rounded-lg border p-3" aria-label={`Line ${index + 1}`}>
      <legend className="sr-only">Line {index + 1}</legend>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {l.product_id && <ProductThumb size="xs" src={image} alt={l.product_name ?? l.description} />}
          <span className="text-sm font-semibold">Line {index + 1}</span>
          <Select value={l.line_type} disabled={locked} onValueChange={(v) => onChange({ line_type: v as PoLineType, product_id: null, sku: null, product_name: null, unit: v === 'GOODS' ? '' : (l.unit || 'NOS') })}>
            <SelectTrigger aria-label={`Line ${index + 1} type`} className="h-8 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(LINE_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
          {locked && <span className="text-xs text-muted-foreground">{l.received} received</span>}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} title={locked ? 'Goods were received on this line' : 'Remove line'} disabled={locked} onClick={onRemove}><Trash2 /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
        <div className="space-y-1 lg:col-span-4">
          <Label htmlFor={id('product')}>{l.line_type === 'GOODS' ? 'Product' : 'Product (optional)'}</Label>
          <PoProductPicker id={id('product')} invalid={Boolean(e('product'))} disabled={locked}
            value={l.product_id ? { sku: l.sku, product_name: l.product_name } : null}
            onChange={(p) => onChange(p ? { product_id: p.id, sku: p.sku, product_name: p.product_name, description: p.product_name, unit: p.base_unit,
              hsn_sac: p.hsn_code ?? '', gst_rate: p.gst_rate === null ? '' : String(Number(p.gst_rate)),
              unit_price: l.unit_price || (p.standard_cost === null ? '' : String(Number(p.standard_cost))) } : { product_id: null, sku: null, product_name: null })} />
        </div>
        <div className="space-y-1 lg:col-span-4">
          <Label htmlFor={id('description')}>Description</Label>
          <Input id={id('description')} maxLength={500} value={l.description} onChange={(ev) => onChange({ description: ev.target.value })} aria-invalid={Boolean(e('description')) || undefined} />
        </div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('unit')}>Unit</Label>
          <Input id={id('unit')} maxLength={10} value={l.unit} disabled={l.line_type === 'GOODS'} onChange={(ev) => onChange({ unit: ev.target.value.toUpperCase() })} aria-invalid={Boolean(e('unit')) || undefined} placeholder={l.line_type === 'GOODS' ? 'From product' : 'NOS'} />
        </div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('hsn')}>HSN / SAC</Label>
          <Input id={id('hsn')} inputMode="numeric" maxLength={8} value={l.hsn_sac} onChange={(ev) => onChange({ hsn_sac: ev.target.value })} aria-invalid={Boolean(e('hsn_sac')) || undefined} />
        </div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('qty')}>Quantity</Label>
          <Input id={id('qty')} inputMode="decimal" value={l.quantity} onChange={(ev) => onChange({ quantity: ev.target.value })} aria-invalid={Boolean(e('quantity')) || undefined} />
        </div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('price')}>Unit price (₹)</Label>
          <Input id={id('price')} inputMode="decimal" value={l.unit_price} onChange={(ev) => onChange({ unit_price: ev.target.value })} aria-invalid={Boolean(e('unit_price')) || undefined} />
        </div>
        <div className="space-y-1 lg:col-span-3">
          <Label htmlFor={id('discount')}>Discount</Label>
          <div className="flex gap-1">
            <Select value={l.discount_mode} onValueChange={(v) => onChange({ discount_mode: v as 'PERCENT' | 'AMOUNT' })}>
              <SelectTrigger aria-label={`Line ${index + 1} discount type`} className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="PERCENT">%</SelectItem><SelectItem value="AMOUNT">₹</SelectItem></SelectContent>
            </Select>
            <Input id={id('discount')} inputMode="decimal" value={l.discount} onChange={(ev) => onChange({ discount: ev.target.value })} aria-invalid={Boolean(e('discount')) || undefined} placeholder="0" />
          </div>
        </div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('gst')}>GST rate</Label>
          <Select value={l.gst_rate === '' ? 'none' : l.gst_rate} onValueChange={(v) => onChange({ gst_rate: v === 'none' ? '' : v })}>
            <SelectTrigger id={id('gst')} className="w-full" aria-invalid={Boolean(e('gst_rate')) || undefined}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not set</SelectItem>
              {[...new Set([...STANDARD_GST_RATES.map(String), ...(l.gst_rate ? [l.gst_rate] : [])])].map((r) => <SelectItem key={r} value={r}>{r}%</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 text-sm lg:col-span-3">
          <span className="text-sm font-medium">Amounts</span>
          <p className="tabular-nums text-muted-foreground">Taxable {money(calc?.taxable ?? 0)} · Tax {money((calc?.cgst ?? 0) + (calc?.sgst ?? 0) + (calc?.igst ?? 0))}</p>
          <p className="font-semibold tabular-nums">Total {money(calc?.total ?? 0)}</p>
        </div>
      </div>
      {l.line_type === 'GOODS' && l.product_id && <CostComparison line={l} lastCost={lastCost} />}
      {lineErrors.length > 0 && <ul role="alert" className="mt-2 space-y-0.5 text-xs text-red-700">{lineErrors.map((m) => <li key={m}>{m}</li>)}</ul>}
    </fieldset>
  )
}

/**
 * Last Purchase Cost and this supplier's previous price next to this line's net unit cost (after discount, excl. GST:
 * the value the goods receipt will use). Comparison only: the cost changes when the goods are received and posted.
 */
function CostComparison({ line: l, lastCost }: { line: PoFormLine; lastCost?: ProductPurchaseCost }) {
  const net = poLineNetUnitCost({ quantity: Number(l.quantity), unit_price: l.unit_price.trim() === '' ? null : Number(l.unit_price),
    discount_percent: l.discount_mode === 'PERCENT' ? Number(l.discount) || null : null, discount_amount: l.discount_mode === 'AMOUNT' ? Number(l.discount) || null : null })
  const previous = lastCost?.last_cost ?? null
  const c = costChange(previous, net)
  const warn = isSignificant(c.percent, lastCost?.threshold)
  const sup = lastCost?.supplier_last_cost ?? null
  const cs = costChange(sup, net)
  return (
    <div data-testid="po-cost-compare" data-trend={c.trend} data-warning={warn ? 'true' : 'false'}
      className={cn('mt-2 space-y-1 rounded-md border-l-4 bg-muted/40 px-3 py-1.5 text-xs',
        c.trend === 'up' ? 'border-l-red-500' : c.trend === 'down' ? 'border-l-emerald-500' : 'border-l-slate-300')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>Last purchase cost: <b className="tabular-nums">{previous === null ? 'none yet' : formatCost(previous)}</b></span>
        <span>This PO: <b className="tabular-nums">{net === null ? '—' : formatCost(net)}</b> <span className="text-muted-foreground">(net of discount, excl. GST)</span></span>
        {c.trend !== 'none' && (
          <span className="inline-flex items-center gap-1">
            Difference: <b className="tabular-nums">{signedMoney(c.difference, formatCost)}</b> <CostTrend trend={c.trend} percent={c.percent} />
            <span className="font-medium">{c.trend === 'up' ? 'Price increase' : c.trend === 'down' ? 'Price decrease' : 'Same price'}</span>
          </span>
        )}
        {sup !== null && (
          <span data-testid="po-supplier-price">This supplier last: <b className="tabular-nums">{formatCost(sup)}</b>
            {lastCost?.supplier_last_date ? ` on ${formatDate(lastCost.supplier_last_date)}` : ''} {cs.trend !== 'none' && <CostTrend trend={cs.trend} percent={cs.percent} />}</span>
        )}
      </div>
      {warn && (
        <p role="status" className="font-medium text-amber-800" data-testid="po-cost-warning">
          The price differs by {Math.abs(c.percent ?? 0).toFixed(2)}% from the Last Purchase Cost (alert threshold {lastCost?.threshold}%). Check the price before saving.
        </p>
      )}
    </div>
  )
}

function Field({ id, label, required, error, hint, full, children }: { id: string; label: string; required?: boolean; error?: string; hint?: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn('space-y-1', full && 'sm:col-span-2')}>
      <Label htmlFor={id}>{label}{required && <span aria-hidden className="text-shortage"> *</span>}</Label>
      {children}
      {error ? <p className="text-xs text-red-700">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd>{children}</dd></div>
}
