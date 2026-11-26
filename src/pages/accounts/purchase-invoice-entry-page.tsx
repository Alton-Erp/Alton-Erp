import { ArrowLeft, PackageCheck, Plus, Split, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatAmount, type AllocationForm } from '@/features/accounting/accounting-model'
import { SearchSelect } from '@/features/accounting/accounting-ui'
import { AllocationDialog } from '@/features/accounting/cost-centre-ui'
import {
  GST_RATES, PI_TYPES, PI_TYPE_LABELS, SUPPLY_CATEGORIES, SUPPLY_CATEGORY_LABELS, emptyPiForm, linesFromCandidates, newPiLine, piFormFromInvoice, piPayload, previewPi,
  validatePiForm, type MatchingCandidate, type PiForm, type PiIssue, type PiLineForm, type PiLookups, type PiType, type PurchaseInvoice, type SupplyCategory, type TaxTreatment,
} from '@/features/accounting/purchase-invoice-model'
import { PiIssues, SupplierSelect } from '@/features/accounting/purchase-invoice-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchMatchingCandidates, fetchPiLookups, fetchPurchaseInvoice, savePurchaseInvoice, submitPurchaseInvoice } from '@/services/accounting'

/** Navigation state from the GRN matching screen: start a new invoice with these receipt lines. */
export interface PiEntryState { supplierId?: string; candidates?: MatchingCandidate[] }

export default function PurchaseInvoiceEntryPage() {
  const { invoiceId } = useParams()
  const start = (useLocation().state ?? null) as PiEntryState | null
  const data = useAsync(async () => {
    const [lookups, invoice] = await Promise.all([fetchPiLookups(), invoiceId ? fetchPurchaseInvoice(invoiceId) : Promise.resolve(null)])
    return { lookups, invoice }
  }, [invoiceId])
  const crumbs = [{ label: 'Purchase & GRN' }, { label: 'Supplier Invoices', to: '/purchases/invoices' }, { label: invoiceId ? 'Edit draft' : 'New' }]
  const title = invoiceId ? 'Edit supplier invoice' : 'New supplier invoice'
  if (data.loading) return <><PageHeader title={title} breadcrumbs={crumbs} /><LoadingState /></>
  if (data.error) return <><PageHeader title={title} breadcrumbs={crumbs} /><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></>
  const { lookups, invoice } = data.data!
  if (!lookups.initialized) {
    return <><PageHeader title={title} breadcrumbs={crumbs} />
      <ErrorState title="Accounting is not set up yet" message="Supplier invoices post to the accounts. Ask an accounts manager to set up accounting (Accounts → Accounting Settings) first." /></>
  }
  if (invoice && invoice.status !== 'DRAFT') {
    return <><PageHeader title={title} breadcrumbs={crumbs} />
      <ErrorState title="Only drafts can be edited" message={`${invoice.invoice_number} is ${invoice.status.toLowerCase()}. Open it to see the available actions.`} /></>
  }
  const initial = invoice ? piFormFromInvoice(invoice)
    : { ...emptyPiForm(lookups.today), ...(start?.supplierId ? supplierDefaults(lookups, start.supplierId) : {}), lines: linesFromCandidates(start?.candidates ?? []) }
  return <EntryForm key={invoice?.id ?? 'new'} lookups={lookups} invoice={invoice} initial={initial} title={title} crumbs={crumbs} />
}

function supplierDefaults(lookups: PiLookups, supplierId: string): Partial<PiForm> {
  const s = lookups.suppliers.find((x) => x.id === supplierId)
  return { supplier_id: supplierId, supplier_gstin: s?.gstin ?? '', place_of_supply_state_code: s?.state_code ?? s?.gstin?.slice(0, 2) ?? '' }
}

function EntryForm({ lookups, invoice, initial, title, crumbs }: {
  lookups: PiLookups; invoice: PurchaseInvoice | null; initial: PiForm; title: string; crumbs: { label: string; to?: string }[]
}) {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const [form, setForm] = useState<PiForm>(initial)
  const [saved, setSaved] = useState<PurchaseInvoice | null>(invoice)
  const [issues, setIssues] = useState<PiIssue[]>(invoice?.issues ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [picking, setPicking] = useState(false)
  const [splitting, setSplitting] = useState<string | null>(null)
  const preview = useMemo(() => previewPi(form, lookups.company_state_code), [form, lookups.company_state_code])
  const check = validatePiForm(form, preview, lookups.accounts, true)
  const draftCheck = validatePiForm(form, preview, lookups.accounts, false)
  const set = (patch: Partial<PiForm>) => setForm((f) => ({ ...f, ...patch }))
  const setLine = (key: string, patch: Partial<PiLineForm>) => setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const accountOptions = lookups.accounts.map((a) => ({ value: a.id, label: `${a.account_code} ${a.account_name}`, hint: a.cost_centre_policy === 'REQUIRED' ? 'cost centre required' : undefined }))
  const pv = (key: string) => preview.lines.find((x) => x.key === key)!
  const money = (paise: number) => formatAmount(paise / 100)
  const splitLine = form.lines.find((l) => l.key === splitting)

  const save = async (submit: boolean) => {
    setTried(true); setError(null); setMessage(null)
    const v = submit ? check : draftCheck
    if (v.errors.length || Object.keys(v.lineErrors).length) { setError('Fix the highlighted fields first.'); return }
    setBusy(true)
    try {
      let r = await savePurchaseInvoice(saved?.id ?? null, piPayload(form), saved?.row_version ?? null)
      setSaved(r); setIssues(r.issues ?? [])
      if (submit) {
        r = await submitPurchaseInvoice(r.id)
        navigate(`/purchases/invoices/${r.id}`, { replace: true, state: { message: `${r.invoice_number} submitted for approval.` } })
        return
      }
      setMessage(`Draft ${r.invoice_number} saved${(r.issues ?? []).some((i) => i.blocking) ? ' — see what still needs attention below' : ''}.`)
      if (!invoice) navigate(`/purchases/invoices/${r.id}/edit`, { replace: true })
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title={saved ? `${title} · ${saved.invoice_number}` : title} breadcrumbs={crumbs}
        description="Taxes and totals are recalculated by the database on every save; the figures below are a live preview." actions={<>
          <Button variant="outline" asChild><Link to={saved ? `/purchases/invoices/${saved.id}` : '/purchases/invoices'}><ArrowLeft /> {saved ? 'Open invoice' : 'Register'}</Link></Button>
          <Button variant="outline" disabled={busy || !has('purchase_invoices.create')} onClick={() => save(false)}>Save draft</Button>
          <Button disabled={busy || !has('purchase_invoices.create')} onClick={() => save(true)}>Save and submit</Button>
        </>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {tried && check.errors.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900" data-testid="pi-form-errors">
          <ul className="list-disc pl-5">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      <PiIssues issues={issues} title="The database reports" />

      <Card className="mb-4">
        <CardHeader><div><CardTitle>Supplier invoice</CardTitle><CardDescription>As printed on the supplier's invoice. The supplier invoice number must be unique per supplier.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="pi-supplier">Supplier</Label>
            <SupplierSelect id="pi-supplier" value={form.supplier_id} suppliers={lookups.suppliers}
              onChange={(v) => { if (saved && v !== saved.supplier_id) return; set({ ...supplierDefaults(lookups, v), lines: form.lines.filter((l) => l.kind === 'DIRECT') }) }} />
            {saved && <p className="text-xs text-muted-foreground">The supplier of a saved invoice cannot change (cancel it and enter a new one).</p>}</div>
          <div className="space-y-1"><Label htmlFor="pi-number">Supplier invoice number</Label>
            <Input id="pi-number" value={form.supplier_invoice_number} maxLength={60} onChange={(e) => set({ supplier_invoice_number: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-gstin">Supplier GSTIN</Label>
            <Input id="pi-gstin" value={form.supplier_gstin} maxLength={15} onChange={(e) => set({ supplier_gstin: e.target.value.toUpperCase() })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-date">Supplier invoice date</Label>
            <Input id="pi-date" type="date" value={form.supplier_invoice_date} onChange={(e) => set({ supplier_invoice_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-recorded">Recording (posting) date</Label>
            <Input id="pi-recorded" type="date" value={form.recorded_date} onChange={(e) => set({ recorded_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-due">Due date (blank = supplier terms)</Label>
            <Input id="pi-due" type="date" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-type">Invoice type</Label>
            <Select value={form.invoice_type} onValueChange={(v) => set({ invoice_type: v as PiType })}><SelectTrigger id="pi-type"><SelectValue /></SelectTrigger>
              <SelectContent>{PI_TYPES.map((t) => <SelectItem key={t} value={t}>{PI_TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="pi-category">Supply</Label>
            <Select value={form.supply_category} onValueChange={(v) => set({ supply_category: v as SupplyCategory })}><SelectTrigger id="pi-category"><SelectValue /></SelectTrigger>
              <SelectContent>{SUPPLY_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{SUPPLY_CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="pi-pos">Place of supply (state code)</Label>
            <Input id="pi-pos" value={form.place_of_supply_state_code} maxLength={2} inputMode="numeric" onChange={(e) => set({ place_of_supply_state_code: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pi-treatment">Tax</Label>
            <Select value={form.tax_treatment || 'AUTO'} onValueChange={(v) => set({ tax_treatment: v === 'AUTO' ? '' : (v as TaxTreatment) })}>
              <SelectTrigger id="pi-treatment"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="AUTO">Automatic ({preview.treatment === 'INTER_STATE' ? 'IGST' : 'CGST + SGST'})</SelectItem>
                <SelectItem value="INTRA_STATE">CGST + SGST (intra-state)</SelectItem><SelectItem value="INTER_STATE">IGST (inter-state)</SelectItem></SelectContent></Select></div>
          <label className="flex items-center gap-2 pt-6 text-sm"><Checkbox checked={form.reverse_charge} onCheckedChange={(c) => set({ reverse_charge: c === true })} />
            Reverse charge (GST paid by us, not to the supplier)</label>
          <div className="space-y-1 sm:col-span-2 xl:col-span-4"><Label htmlFor="pi-narration">Narration</Label>
            <Textarea id="pi-narration" rows={2} value={form.narration} maxLength={1000} onChange={(e) => set({ narration: e.target.value })} /></div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div><CardTitle>Lines</CardTitle><CardDescription>Goods receipt lines (the receipt already put Purchases, GST and Creditors in the books; only differences post) or
            direct expense / service lines (posted Dr expense, Dr GST pending / Cr Creditors).</CardDescription></div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!form.supplier_id || form.reverse_charge} onClick={() => setPicking(true)}><PackageCheck /> Add goods receipt lines</Button>
            <Button variant="outline" size="sm" onClick={() => set({ lines: [...form.lines, newPiLine('DIRECT')] })}><Plus /> Add direct line</Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow><TableHead className="w-10">#</TableHead><TableHead className="min-w-64">Receipt line / ledger account</TableHead><TableHead className="w-24">Qty</TableHead>
              <TableHead className="w-28">Unit price</TableHead><TableHead className="w-24">Discount</TableHead><TableHead className="w-24">GST %</TableHead><TableHead className="w-24">Cess</TableHead>
              <TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">GST</TableHead><TableHead className="text-right">Total</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {form.lines.length === 0 && <TableRow><TableCell colSpan={11} className="py-6 text-center text-sm text-muted-foreground">No lines yet.</TableCell></TableRow>}
              {form.lines.map((l, i) => {
                const p = pv(l.key)
                const err = (tried ? check : draftCheck).lineErrors[l.key]
                return (
                  <TableRow key={l.key} data-testid="pi-line">
                    <TableCell className="align-top">{i + 1}</TableCell>
                    <TableCell className="align-top">
                      {l.kind === 'GRN' ? (
                        <div className="text-sm"><span className="font-medium">{l.grn?.receipt_number ?? 'Goods receipt'}</span>
                          {l.grn?.receipt_date && <span className="text-muted-foreground"> · {formatDate(l.grn.receipt_date)}</span>}
                          <span className="block">{l.grn?.description ?? l.description}</span>
                          {l.grn && <span className="block text-xs text-muted-foreground">Uninvoiced {l.grn.remaining} · receipt cost {formatAmount(l.grn.unit_cost)} @ {l.grn.gst_rate}%
                            {!l.grn.in_books && ' · not posted to the accounts yet'}</span>}</div>
                      ) : (
                        <div className="space-y-1">
                          <SearchSelect id={`pi-acc-${i}`} value={l.account_id} options={accountOptions} placeholder="Select a ledger account" onChange={(v) => setLine(l.key, { account_id: v })} />
                          <Input aria-label={`Line ${i + 1} description`} placeholder="Description" value={l.description} maxLength={500} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                          {l.allocations.length > 0 && <p className="text-xs text-muted-foreground" data-testid="pi-line-split">Split: {l.allocations.map((a) => {
                            const c = lookups.cost_centres.find((x) => x.id === a.cost_centre_id)
                            return `${c?.cost_centre_code ?? '?'} ${formatAmount(a.amount)}`
                          }).join(', ')}</p>}
                        </div>
                      )}
                      {err && <p role="alert" className="mt-1 text-xs text-red-700">{err}</p>}
                    </TableCell>
                    <TableCell className="align-top"><Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></TableCell>
                    <TableCell className="align-top"><Input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" className="text-right" value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} /></TableCell>
                    <TableCell className="align-top"><Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" className="text-right" value={l.discount} onChange={(e) => setLine(l.key, { discount: e.target.value })} /></TableCell>
                    <TableCell className="align-top">
                      <Select value={l.gst_rate} onValueChange={(v) => setLine(l.key, { gst_rate: v })}><SelectTrigger aria-label={`Line ${i + 1} GST rate`}><SelectValue /></SelectTrigger>
                        <SelectContent>{GST_RATES.map((r) => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent></Select></TableCell>
                    <TableCell className="align-top"><Input aria-label={`Line ${i + 1} cess`} inputMode="decimal" className="text-right" value={l.cess} onChange={(e) => setLine(l.key, { cess: e.target.value })} /></TableCell>
                    <TableCell className="text-right align-top tabular-nums">{money(p.taxable)}</TableCell>
                    <TableCell className="text-right align-top tabular-nums">{money(p.cgst + p.sgst + p.igst + p.cess)}</TableCell>
                    <TableCell className="text-right align-top tabular-nums">{money(p.total)}</TableCell>
                    <TableCell className="align-top"><span className="flex gap-1">
                      {l.kind === 'DIRECT' && <Button variant="ghost" size="icon" aria-label={`Line ${i + 1} cost centres`} title="Cost-centre split" onClick={() => setSplitting(l.key)}><Split /></Button>}
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => set({ lines: form.lines.filter((x) => x.key !== l.key) })}><Trash2 /></Button></span></TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><div><CardTitle>Totals</CardTitle><CardDescription>{preview.treatment === 'INTER_STATE' ? 'IGST (inter-state).' : 'CGST + SGST (intra-state).'}
          {form.reverse_charge ? ' Reverse charge: the GST is ours to pay, so it is not part of what the supplier is owed.' : ''}</CardDescription></div></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="pi-totals">
            <dt>Taxable value</dt><dd className="text-right tabular-nums">{money(preview.totals.taxable)}</dd>
            <dt>CGST</dt><dd className="text-right tabular-nums">{money(preview.totals.cgst)}</dd>
            <dt>SGST</dt><dd className="text-right tabular-nums">{money(preview.totals.sgst)}</dd>
            <dt>IGST</dt><dd className="text-right tabular-nums">{money(preview.totals.igst)}</dd>
            <dt>Cess</dt><dd className="text-right tabular-nums">{money(preview.totals.cess)}</dd>
            <dt>Round-off</dt><dd className="text-right tabular-nums">{money(preview.totals.roundOff)}</dd>
            <dt className="font-semibold">Invoice total</dt><dd className="text-right font-semibold tabular-nums" data-testid="pi-grand-total">{money(preview.totals.grandTotal)}</dd>
          </dl>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="pi-stated">Total on the supplier invoice</Label>
              <Input id="pi-stated" inputMode="decimal" className="text-right" value={form.supplier_stated_total} onChange={(e) => set({ supplier_stated_total: e.target.value })} />
              {form.supplier_stated_total.trim() && <p className={`text-xs ${Math.round(Number(form.supplier_stated_total) * 100) === preview.totals.grandTotal ? 'text-green-700' : 'text-amber-700'}`}>
                {Math.round(Number(form.supplier_stated_total) * 100) === preview.totals.grandTotal ? 'Matches the calculated total.'
                  : `Differs by ${money(Math.round(Number(form.supplier_stated_total) * 100) - preview.totals.grandTotal)}.`}</p>}</div>
            <div className="space-y-1"><Label htmlFor="pi-round">Round-off (−1.00 to 1.00)</Label>
              <Input id="pi-round" inputMode="decimal" className="text-right" value={form.round_off} onChange={(e) => set({ round_off: e.target.value })} /></div>
          </div>
        </CardContent>
      </Card>

      {picking && <ReceiptPicker supplierId={form.supplier_id} exclude={form.lines.map((l) => l.goods_receipt_line_id).filter(Boolean)} onClose={() => setPicking(false)}
        onAdd={(c) => { set({ lines: [...form.lines, ...linesFromCandidates(c)] }); setPicking(false) }} />}
      {splitLine && <AllocationDialog lineNo={form.lines.indexOf(splitLine) + 1} centres={lookups.cost_centres}
        policy={lookups.accounts.find((a) => a.id === splitLine.account_id)?.cost_centre_policy}
        line={{ key: splitLine.key, account_id: splitLine.account_id, debit: (pv(splitLine.key).taxable / 100).toFixed(2), credit: '', narration: '', allocations: splitLine.allocations }}
        onClose={() => setSplitting(null)} onSave={(a: AllocationForm[]) => { setLine(splitLine.key, { allocations: a }); setSplitting(null) }} />}
    </>
  )
}

/** Uninvoiced goods receipt lines of the supplier (posted receipts only; quantities on other live invoices are already deducted). */
function ReceiptPicker({ supplierId, exclude, onClose, onAdd }: { supplierId: string; exclude: string[]; onClose: () => void; onAdd: (c: MatchingCandidate[]) => void }) {
  const cands = useAsync(() => fetchMatchingCandidates(supplierId, null, false), [supplierId])
  const [chosen, setChosen] = useState<string[]>([])
  const rows = (cands.data ?? []).filter((c) => !exclude.includes(c.line_id))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Add goods receipt lines</DialogTitle>
          <DialogDescription>Receipt lines of this supplier with quantity still to invoice. The invoice line starts with the uninvoiced quantity at the receipt's cost and GST rate.</DialogDescription></DialogHeader>
        {cands.loading ? <LoadingState /> : cands.error ? <ErrorState message={describeDataError(cands.error)} onRetry={cands.reload} /> : rows.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">No uninvoiced goods receipt lines for this supplier.</p> : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader><TableRow><TableHead /><TableHead>Receipt</TableHead><TableHead>Item</TableHead><TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Uninvoiced</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">GST %</TableHead></TableRow></TableHeader>
              <TableBody>{rows.map((c) => (
                <TableRow key={c.line_id} data-testid="pi-candidate">
                  <TableCell><Checkbox aria-label={`Select ${c.receipt_number} ${c.description ?? ''}`} checked={chosen.includes(c.line_id)}
                    onCheckedChange={(v) => setChosen((x) => (v ? [...x, c.line_id] : x.filter((y) => y !== c.line_id)))} /></TableCell>
                  <TableCell className="text-sm">{c.receipt_number}<span className="block text-xs text-muted-foreground">{formatDate(c.receipt_date)}{c.po_number ? ` · ${c.po_number}` : ''}
                    {!c.in_books && ' · not in the books yet'}</span></TableCell>
                  <TableCell className="text-sm">{c.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(c.accepted_quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(c.remaining_quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(c.unit_cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(c.gst_rate)}</TableCell>
                </TableRow>))}</TableBody>
            </Table>
          </div>)}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={chosen.length === 0} onClick={() => onAdd(rows.filter((c) => chosen.includes(c.line_id)))}>Add {chosen.length || ''} line(s)</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
