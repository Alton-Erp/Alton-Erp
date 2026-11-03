import { Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PAYMENT_METHOD_LABELS, SUPPLY_CATEGORY_LABELS } from '@/features/billing/billing-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchBillingSettings, updateBillingSettings, type BillingSettings } from '@/services/billing'
import type { BankAccount, InvoiceSettingsRow, PaymentMethod } from '@/types/database-billing'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
type Draft = Partial<Record<keyof InvoiceSettingsRow, unknown>>

function Toggle({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return <label htmlFor={id} className="flex items-start gap-2 text-sm"><Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" /><span>{children}</span></label>
}

function SettingsForm({ s, onSaved }: { s: BillingSettings; onSaved: (s: BillingSettings) => void }) {
  const [d, setD] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const v = <K extends keyof InvoiceSettingsRow>(k: K) => (k in d ? d[k] : s[k]) as InvoiceSettingsRow[K]
  const set = (k: keyof InvoiceSettingsRow, value: unknown) => { setD((x) => ({ ...x, [k]: value })); setMessage(null) }
  const text = (k: keyof InvoiceSettingsRow) => String(v(k) ?? '')
  const dirty = Object.keys(d).length > 0

  const save = async () => {
    setError(null); setMessage(null)
    const changes: Draft = {}
    for (const [k, val] of Object.entries(d)) {
      const key = k as keyof InvoiceSettingsRow
      if (['number_padding', 'fy_start_month', 'default_payment_terms_days'].includes(k)) {
        if (!/^\d+$/.test(String(val).trim())) return setError('Padding, financial-year month and payment terms must be whole numbers.')
        changes[key] = Number(val)
      } else if (k === 'freight_gst_rate' || k === 'packing_gst_rate') {
        const t = String(val ?? '').trim()
        if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > 100) return setError('Freight and packing GST rates must be numbers from 0 to 100.')
        changes[key] = Number(t)
      } else if (k === 'gst_rates') {
        const list = Array.isArray(val) ? val : String(val).split(/[,\s]+/).filter(Boolean)
        if (!list.length || list.some((r) => !/^\d+(\.\d{1,2})?$/.test(String(r)) || Number(r) > 100)) return setError('GST rates: numbers from 0 to 100 separated by commas (e.g. 0, 5, 12, 18, 28).')
        changes[key] = [...new Set(list.map(Number))].sort((a, b) => a - b)
      } else if (k === 'bank_accounts') {
        const rows = (val as BankAccount[]).filter((b) => b.account_number.trim() || b.ifsc.trim() || (b.bank_name ?? '').trim())
        if (rows.some((b) => !/^[0-9A-Z]{6,34}$/.test(b.account_number.trim().toUpperCase()) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc.trim().toUpperCase()))) {
          return setError('Each bank account needs an account number (6-34 letters or digits) and a valid IFSC (e.g. HDFC0001234).')
        }
        changes[key] = rows.map((b) => ({ ...b, account_number: b.account_number.trim().toUpperCase(), ifsc: b.ifsc.trim().toUpperCase() }))
      } else if (k === 'other_charge_gst_rate') {
        const t = String(val ?? '').trim()
        if (t && !/^\d+(\.\d{1,2})?$/.test(t)) return setError('Charge GST rate must be a number.')
        changes[key] = t ? Number(t) : null
      } else if (typeof val === 'string') {
        changes[key] = val.trim() === '' && !k.endsWith('_prefix') ? null : val
      } else changes[key] = val
    }
    if (Array.isArray(changes.payment_methods) && changes.payment_methods.length === 0) return setError('Keep at least one payment method.')
    setBusy(true)
    try {
      const next = await updateBillingSettings(changes as Partial<InvoiceSettingsRow>)
      setD({})
      setMessage(`Settings saved. Next invoice number will look like ${next.example_invoice_number}.`)
      onSaved(next)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  const methods = v('payment_methods') as PaymentMethod[]
  const accounts = (v('bank_accounts') as BankAccount[] | undefined) ?? []
  const setAccount = (idx: number, p: Partial<BankAccount>) => set('bank_accounts', accounts.map((a, i) => (i === idx ? { ...a, ...p } : a)))
  const rates = v('gst_rates') as unknown
  const ratesText = Array.isArray(rates) ? rates.map(Number).join(', ') : String(rates ?? '')
  const special = v('allowed_special_categories') as string[]
  const toggleIn = <T extends string>(list: T[], item: T, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item))

  return (
    <div className="space-y-6">
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card>
        <CardHeader><div><CardTitle>Seller details</CardTitle><CardDescription>Legal name, address, state and GSTIN come from Company Settings and are copied onto each invoice when it is drafted and refreshed.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">Legal name</dt><dd className="font-medium">{s.company.legal_name}</dd></div>
            <div><dt className="text-xs text-muted-foreground">GSTIN</dt><dd className="font-medium">{s.company.gstin ?? <span className="text-shortage">Not set</span>}</dd></div>
            <div><dt className="text-xs text-muted-foreground">State (from GSTIN)</dt><dd className="font-medium">{s.company.state_code ? `${s.company.state_code} — ${s.company.state_name ?? ''}` : '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Address</dt><dd className="font-medium whitespace-pre-line">{s.company.legal_address ?? <span className="text-shortage">Not set</span>}</dd></div>
          </dl>
          <Button variant="outline" size="sm" asChild><Link to="/admin/erp-settings?tab=company">Edit in ERP Settings</Link></Button>
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <Toggle id="st-gst" checked={Boolean(v('gst_registered'))} onChange={(x) => set('gst_registered', x)}>The company is GST-registered (tax invoices with CGST/SGST/IGST). When off, a bill of supply without GST is produced.</Toggle>
            <div className="space-y-1"><Label htmlFor="st-pan">Seller PAN (optional)</Label><Input id="st-pan" maxLength={10} value={text('seller_pan')} onChange={(e) => set('seller_pan', e.target.value)} /></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Numbering and financial year</CardTitle><CardDescription>Numbers are assigned by the database only when a document is issued, consecutively per financial year, and never reused. Changing the format affects future documents only. Maximum 16 characters.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1"><Label htmlFor="st-ip">Invoice prefix</Label><Input id="st-ip" maxLength={8} value={text('invoice_prefix')} onChange={(e) => set('invoice_prefix', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-cp">Credit note prefix</Label><Input id="st-cp" maxLength={8} value={text('credit_note_prefix')} onChange={(e) => set('credit_note_prefix', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-dp">Debit note prefix</Label><Input id="st-dp" maxLength={8} value={text('debit_note_prefix')} onChange={(e) => set('debit_note_prefix', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-rp">Receipt prefix</Label><Input id="st-rp" maxLength={8} value={text('receipt_prefix')} onChange={(e) => set('receipt_prefix', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-pad">Number padding (digits)</Label><Input id="st-pad" inputMode="numeric" value={text('number_padding')} onChange={(e) => set('number_padding', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-fym">Financial year starts</Label>
            <Select value={String(v('fy_start_month'))} onValueChange={(x) => set('fy_start_month', x)}><SelectTrigger id="st-fym"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex items-end"><Toggle id="st-fy" checked={Boolean(v('include_fy_in_number'))} onChange={(x) => set('include_fy_in_number', x)}>Include financial year in the number</Toggle></div>
          <div className="text-sm"><p className="text-xs text-muted-foreground">Current format (saved)</p><p className="font-medium">{s.example_invoice_number} · {s.example_credit_note_number} · {s.example_receipt_number}</p><p className="text-xs text-muted-foreground">FY {s.current_financial_year}</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Invoicing policy</CardTitle><CardDescription>Enforced by the database when drafts are created and issued.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="st-basis">Invoice basis</Label>
            <Select value={String(v('billing_basis'))} onValueChange={(x) => set('billing_basis', x)}><SelectTrigger id="st-basis"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="DISPATCH">Dispatched quantity</SelectItem><SelectItem value="DELIVERY">Delivered (confirmed) quantity</SelectItem></SelectContent></Select>
            <p className="text-xs text-muted-foreground">Reserved, picked or packed quantities are never invoiceable.</p></div>
          <div className="space-y-1"><Label htmlFor="st-terms">Default payment terms (days)</Label><Input id="st-terms" inputMode="numeric" value={text('default_payment_terms_days')} onChange={(e) => set('default_payment_terms_days', e.target.value)} />
            <p className="text-xs text-muted-foreground">Used when the customer has no payment terms of its own.</p></div>
          <Toggle id="st-partial" checked={Boolean(v('allow_partial_dispatch_invoicing'))} onChange={(x) => set('allow_partial_dispatch_invoicing', x)}>Allow invoicing part of a dispatched line</Toggle>
          <Toggle id="st-disc" checked={Boolean(v('allow_line_discount'))} onChange={(x) => set('allow_line_discount', x)}>Allow line discounts on drafts</Toggle>
          <Toggle id="st-appr" checked={Boolean(v('require_approval'))} onChange={(x) => set('require_approval', x)}>Require approval before issue (submitter cannot approve; approver needs “approve invoices”)</Toggle>
          <Toggle id="st-round" checked={Boolean(v('round_off_enabled'))} onChange={(x) => set('round_off_enabled', x)}>Round the invoice total to a whole rupee (shown as a separate round-off; direction below)</Toggle>
          <div className="space-y-2 sm:col-span-2">
            <p className="text-sm font-medium">Special supply categories allowed on drafts</p>
            <p className="text-xs text-muted-foreground">Taxable supply is always available. Exempt, zero-rated and non-GST treatments need a recorded basis on each invoice and an authorised tax review before issue — confirm their use with your tax adviser.</p>
            <div className="flex flex-wrap gap-4">{['EXEMPT', 'ZERO_RATED', 'NON_GST'].map((c) => (
              <Toggle key={c} id={`st-sp-${c}`} checked={special.includes(c)} onChange={(x) => set('allowed_special_categories', toggleIn(special, c, x))}>{SUPPLY_CATEGORY_LABELS[c]}</Toggle>
            ))}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>GST and invoice defaults</CardTitle><CardDescription>Used by new invoices (manual, from sales orders and imports). CGST + SGST or IGST is decided from the place of supply against your GSTIN state.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="st-rates">GST rates offered (%)</Label><Input id="st-rates" value={ratesText} onChange={(e) => set('gst_rates', e.target.value)} placeholder="0, 5, 12, 18, 28" />
            <p className="text-xs text-muted-foreground">Other rates can be added (e.g. 3 or 0.25). Imported rates outside this list are flagged as warnings.</p></div>
          <div className="space-y-1"><Label htmlFor="st-pm">Prices are entered</Label>
            <Select value={String(v('pricing_mode'))} onValueChange={(x) => { if (x) set('pricing_mode', x) }}><SelectTrigger id="st-pm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="EXCLUSIVE">Before GST (GST added)</SelectItem><SelectItem value="INCLUSIVE">Including GST</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="st-rm">Rounding of the total</Label>
            <Select value={String(v('rounding_mode'))} onValueChange={(x) => { if (x) set('rounding_mode', x) }}><SelectTrigger id="st-rm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="NEAREST">Nearest rupee</SelectItem><SelectItem value="UP">Always up</SelectItem><SelectItem value="DOWN">Always down</SelectItem></SelectContent></Select>
            <p className="text-xs text-muted-foreground">Applies when rounding is switched on above.</p></div>
          <div className="space-y-1"><Label htmlFor="st-fsac">Freight SAC</Label><Input id="st-fsac" maxLength={8} value={text('freight_sac')} onChange={(e) => set('freight_sac', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-frate">Freight GST rate (%)</Label><Input id="st-frate" inputMode="decimal" value={text('freight_gst_rate')} onChange={(e) => set('freight_gst_rate', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-psac">Packing SAC</Label><Input id="st-psac" maxLength={8} value={text('packing_sac')} onChange={(e) => set('packing_sac', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-prate">Packing GST rate (%)</Label><Input id="st-prate" inputMode="decimal" value={text('packing_gst_rate')} onChange={(e) => set('packing_gst_rate', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-dtype">Default document</Label>
            <Select value={String(v('default_invoice_type'))} onValueChange={(x) => { if (x) set('default_invoice_type', x) }}><SelectTrigger id="st-dtype"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="TAX_INVOICE">Tax invoice</SelectItem><SelectItem value="PROFORMA">Proforma invoice</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="st-dfmt">Date format</Label>
            <Select value={String(v('invoice_date_format'))} onValueChange={(x) => { if (x) set('invoice_date_format', x) }}><SelectTrigger id="st-dfmt"><SelectValue /></SelectTrigger>
              <SelectContent>{['DD-MM-YYYY', 'DD/MM/YYYY', 'DD MMM YYYY', 'YYYY-MM-DD'].map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent></Select></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Invoice PDF</CardTitle><CardDescription>A4 layout with blue accents. Bank details, terms and footer are printed from the sections on this page.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1"><Label htmlFor="st-tpl">Template</Label>
            <Select value={String(v('invoice_template'))} onValueChange={(x) => { if (x) set('invoice_template', x) }}><SelectTrigger id="st-tpl"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="CLASSIC">Classic</SelectItem><SelectItem value="COMPACT">Compact</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="st-sig">Authorised signatory</Label><Input id="st-sig" maxLength={120} value={text('authorized_signatory')} onChange={(e) => set('authorized_signatory', e.target.value)} placeholder="Name / designation" /></div>
          <div className="flex items-end"><Toggle id="st-logo" checked={Boolean(v('show_logo'))} onChange={(x) => set('show_logo', x)}>Print the company logo</Toggle></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Additional charge line</CardTitle><CardDescription>Optional taxable charge (e.g. freight) entered per draft invoice. No rate or SAC code is assumed — enter the ones your adviser confirmed.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-end"><Toggle id="st-chg" checked={Boolean(v('other_charge_enabled'))} onChange={(x) => set('other_charge_enabled', x)}>Enable the charge line</Toggle></div>
          <div className="space-y-1"><Label htmlFor="st-chl">Label</Label><Input id="st-chl" maxLength={60} value={text('other_charge_label')} onChange={(e) => set('other_charge_label', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-chs">SAC code</Label><Input id="st-chs" maxLength={8} value={text('other_charge_sac')} onChange={(e) => set('other_charge_sac', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-chr">GST rate (%)</Label><Input id="st-chr" inputMode="decimal" value={text('other_charge_gst_rate')} onChange={(e) => set('other_charge_gst_rate', e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Payments and bank details</CardTitle><CardDescription>Bank details are printed on invoices only when enabled; they are not verified by the system.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><p className="text-sm font-medium">Accepted payment methods</p>
            <div className="flex flex-wrap gap-4">{(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
              <Toggle key={m} id={`st-pm-${m}`} checked={methods.includes(m)} onChange={(x) => set('payment_methods', toggleIn(methods, m, x))}>{PAYMENT_METHOD_LABELS[m]}</Toggle>
            ))}</div></div>
          <div className="max-w-xs space-y-1"><Label htmlFor="st-dpm">Default payment mode</Label>
            <Select value={String(v('default_payment_method'))} onValueChange={(x) => { if (x) set('default_payment_method', x) }}><SelectTrigger id="st-dpm"><SelectValue /></SelectTrigger>
              <SelectContent>{methods.map((m) => <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m] ?? m}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Bank accounts (receiving payments)</p>
            {accounts.map((a, idx) => (
              <div key={idx} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-5">
                <Input aria-label={`Bank account ${idx + 1} label`} placeholder="Label (e.g. HDFC current)" value={a.label ?? ''} onChange={(e) => setAccount(idx, { label: e.target.value })} />
                <Input aria-label={`Bank account ${idx + 1} bank`} placeholder="Bank name" value={a.bank_name ?? ''} onChange={(e) => setAccount(idx, { bank_name: e.target.value })} />
                <Input aria-label={`Bank account ${idx + 1} number`} placeholder="Account number" value={a.account_number} onChange={(e) => setAccount(idx, { account_number: e.target.value })} />
                <Input aria-label={`Bank account ${idx + 1} IFSC`} placeholder="IFSC" maxLength={11} value={a.ifsc} onChange={(e) => setAccount(idx, { ifsc: e.target.value })} />
                <Button type="button" variant="outline" size="sm" onClick={() => set('bank_accounts', accounts.filter((_, i) => i !== idx))}>Remove</Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => set('bank_accounts', [...accounts, { label: '', bank_name: '', account_number: '', ifsc: '' }])}>Add bank account</Button>
            <p className="text-xs text-muted-foreground">The first account is printed on invoices when no single bank account is set below. Receipts can name the account the money came into.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1"><Label htmlFor="st-ban">Account name</Label><Input id="st-ban" maxLength={120} value={text('bank_account_name')} onChange={(e) => set('bank_account_name', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-bn">Bank name</Label><Input id="st-bn" maxLength={120} value={text('bank_name')} onChange={(e) => set('bank_name', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-bacc">Account number</Label><Input id="st-bacc" maxLength={34} value={text('bank_account_number')} onChange={(e) => set('bank_account_number', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-ifsc">IFSC</Label><Input id="st-ifsc" maxLength={11} value={text('bank_ifsc')} onChange={(e) => set('bank_ifsc', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-br">Branch</Label><Input id="st-br" maxLength={120} value={text('bank_branch')} onChange={(e) => set('bank_branch', e.target.value)} /></div>
            <div className="flex items-end"><Toggle id="st-showbank" checked={Boolean(v('show_bank_details'))} onChange={(x) => set('show_bank_details', x)}>Print bank details on invoices</Toggle></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Printed text</CardTitle><CardDescription>Copied onto each invoice when it is issued; later edits do not change issued invoices.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="st-tt">Terms and conditions</Label><Textarea id="st-tt" rows={4} maxLength={2000} value={text('terms_text')} onChange={(e) => set('terms_text', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="st-ft">Footer</Label><Textarea id="st-ft" rows={4} maxLength={1000} value={text('footer_text')} onChange={(e) => set('footer_text', e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>E-invoicing (IRN / QR) and e-way bills</CardTitle><CardDescription>Status: <span className="font-medium">Not configured</span>. No IRP, GST portal or e-way bill integration is connected; the system does not generate IRNs, signed QR codes or e-way bill numbers. If your business is required to e-invoice, those must be obtained outside this system until an integration is configured.</CardDescription></div></CardHeader>
      </Card>

      <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3">
        <Button disabled={busy || !dirty} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save settings</Button>
        {dirty && <Button variant="outline" disabled={busy} onClick={() => { setD({}); setError(null) }}>Discard changes</Button>}
        <span className="text-xs text-muted-foreground">Last updated {formatDateTime(s.updated_at)}</span>
      </div>
    </div>
  )
}

export default function InvoiceSettingsPage() {
  const [refresh, setRefresh] = useState(0)
  const [saved, setSaved] = useState<BillingSettings | null>(null)
  const settings = useAsync(fetchBillingSettings, [refresh])
  const s = saved ?? settings.data
  return (
    <>
      <PageHeader />
      {settings.loading && !s ? <LoadingState variant="cards" rows={4} /> : settings.error || !s ? <Card><ErrorState message={describeDataError(settings.error)} onRetry={() => setRefresh((n) => n + 1)} /></Card>
        : <SettingsForm key={s.company_id} s={s} onSaved={setSaved} />}
    </>
  )
}
