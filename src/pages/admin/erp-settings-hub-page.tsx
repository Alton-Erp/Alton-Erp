import { Download, ExternalLink, Loader2, Plus, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { LOGO_SRC } from '@/components/layout/company-logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { REPORTS, reportSheet } from '@/features/management/report-defs'
import { useAsync } from '@/hooks/use-async'
import { DATE_PATTERNS } from '@/lib/date-pattern'
import { describeDataError, errorReference, logDataError } from '@/lib/errors'
import { lastFailedRequest } from '@/lib/supabase'
import { toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchBillingSettings } from '@/services/billing'
import { fetchErpSettings, runReport, saveErpSettings, type CompanyProfile, type ErpSettings, type ErpSettingsValues } from '@/services/management'

import { ErpSystemSettings } from './erp-settings-page'

const TABS = [
  ['company', 'Company'], ['products', 'Products'], ['inventory', 'Inventory'], ['purchase', 'Purchase'], ['production', 'Production'], ['sales', 'Sales'],
  ['invoices', 'Invoices'], ['imports', 'Excel import'], ['backup', 'Backup & audit'], ['system', 'System'],
] as const
type Tab = (typeof TABS)[number][0]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const PRODUCT_TYPES: [string, string][] = [['FINISHED_GOOD', 'Finished good'], ['RAW_MATERIAL', 'Raw material'], ['COMPONENT', 'Component'], ['SUBASSEMBLY', 'Subassembly'],
  ['OUTSOURCED_COMPONENT', 'Outsourced component'], ['PACKAGING_MATERIAL', 'Packaging material'], ['CONSUMABLE', 'Consumable'], ['OTHER', 'Other']]
const PO_TERMS: [string, string][] = [['IMMEDIATE', 'Immediate'], ['DAYS_7', '7 days'], ['DAYS_15', '15 days'], ['DAYS_30', '30 days'], ['DAYS_45', '45 days']]

type CompanyDraft = Partial<Record<keyof CompanyProfile, unknown>>
type SettingsDraft = Partial<ErpSettingsValues>

function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor?: string; hint?: string; children: ReactNode; className?: string }) {
  return <div className={cn('space-y-1', className)}><Label htmlFor={htmlFor}>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
}
function Info({ title, children }: { title: string; children: ReactNode }) {
  return <div className="rounded-lg border bg-muted/30 p-3 text-sm"><p className="font-medium">{title}</p><div className="text-muted-foreground">{children}</div></div>
}
function Go({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="inline-flex items-center gap-1 text-primary hover:underline">{children} <ExternalLink className="size-3" /></Link>
}

/** /admin/erp-settings — every setting in one place (Stage 7). */
export default function ErpSettingsHubPage() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find(([t]) => t === params.get('tab'))?.[0] ?? 'company') as Tab
  const data = useAsync(fetchErpSettings, [])
  return (
    <>
      <PageHeader title="ERP Settings" description="Company, numbering, products, stock, purchase, production, sales, invoices, imports and backups. Changes apply to new records and are recorded in the audit log." />
      <div role="tablist" aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1 text-sm">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setParams({ tab: t })}
            className={cn('rounded-md px-3 py-1.5', tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
        ))}
      </div>
      {tab === 'system' ? <ErpSystemSettings /> : tab === 'backup' ? <BackupTab /> : tab === 'invoices' ? <InvoicesTab />
        : data.loading && !data.data ? <LoadingState variant="cards" rows={3} />
        : data.error || !data.data ? <SettingsLoadError tab={tab} error={data.error} onRetry={data.reload} />
        : <SettingsForm key={tab} tab={tab} data={data.data} onSaved={data.reload} />}
    </>
  )
}

const tabLabel = (tab: Tab) => TABS.find(([t]) => t === tab)?.[1] ?? tab

/** Load failure of a settings tab: meaningful message, a reference code, Try again; details go to the console log. */
function SettingsLoadError({ tab, error, onRetry }: { tab: Tab; error: unknown; onRetry: () => void }) {
  useEffect(() => {
    if (error) logDataError({ area: `ERP Settings › ${tabLabel(tab)}`, operation: 'load settings (rpc erp_settings_get)', requestId: lastFailedRequest('/rpc/erp_settings_get')?.requestId }, error)
  }, [error, tab])
  const ref = errorReference(error)
  return (
    <Card>
      <ErrorState title={`${tabLabel(tab)} settings could not be loaded`}
        message={`${describeDataError(error)}${ref ? ` (Reference: ${ref})` : ''}`} onRetry={onRetry} />
    </Card>
  )
}

function SettingsForm({ tab, data, onSaved }: { tab: Tab; data: ErpSettings; onSaved: () => void }) {
  const { reload: reloadPrefs } = useErpPreferences()
  const [c, setC] = useState<CompanyDraft>({})
  const [s, setS] = useState<SettingsDraft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const cv = <K extends keyof CompanyProfile>(k: K) => (k in c ? c[k] : data.company[k]) as CompanyProfile[K]
  const sv = <K extends keyof ErpSettingsValues>(k: K) => (k in s ? s[k] : data.settings[k]) as ErpSettingsValues[K]
  const setCompany = (k: keyof CompanyProfile, v: unknown) => { setC((x) => ({ ...x, [k]: v })); setMessage(null) }
  const setSetting = <K extends keyof ErpSettingsValues>(k: K, v: ErpSettingsValues[K]) => { setS((x) => ({ ...x, [k]: v })); setMessage(null) }
  const dirty = Object.keys(c).length + Object.keys(s).length > 0
  const text = (k: keyof CompanyProfile) => String(cv(k) ?? '')

  const save = async () => {
    setBusy(true); setError(null); setMessage(null)
    try {
      // Group heads: trimmed, blanks and repeats (ignoring case) dropped.
      const heads = s['product.group_heads']
      const cleaned = heads
        ? { ...s, 'product.group_heads': heads.map((h) => h.trim().replace(/\s+/g, ' ')).filter((h, i, all) => h && all.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i) }
        : s
      await saveErpSettings(c, cleaned)
      setC({}); setS({})
      setMessage('Settings saved and recorded in the audit log.')
      onSaved(); reloadPrefs()
    } catch (e) {
      logDataError({ area: `ERP Settings › ${tabLabel(tab)}`, operation: 'save settings (rpc erp_settings_save)', requestId: lastFailedRequest('/rpc/erp_settings_save')?.requestId }, e)
      const ref = errorReference(e)
      setError(`${describeDataError(e)}${ref ? ` (Reference: ${ref})` : ''}`)
    } finally { setBusy(false) }
  }
  const onLogo = (file: File | null) => {
    if (!file) return
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return setError('Choose a PNG, JPEG, WebP or SVG image.')
    if (file.size > 290 * 1024) return setError('The logo must be smaller than about 290 KB.')
    const reader = new FileReader()
    reader.onload = () => setCompany('logo_data_url', String(reader.result))
    reader.readAsDataURL(file)
  }
  const nextNumber = (code: 'PO' | 'GRN' | 'PRD' | 'SO', key: keyof ErpSettingsValues) => `${String(sv(key))}-${String((data.counters[code] ?? 0) + 1).padStart(6, '0')}`

  const body = (() => {
    switch (tab) {
      case 'company': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Company profile</CardTitle><CardDescription>Printed on invoices, purchase orders and statements.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Company name" htmlFor="es-name"><Input id="es-name" value={text('legal_name')} onChange={(e) => setCompany('legal_name', e.target.value)} /></Field>
              <Field label="Display name" htmlFor="es-dname"><Input id="es-dname" value={text('display_name')} onChange={(e) => setCompany('display_name', e.target.value)} /></Field>
              <Field label="GSTIN" htmlFor="es-gstin" hint={data.company.state_code ? `State code ${data.company.state_code} — ${data.company.state_name ?? ''} (from the GSTIN)` : 'The state code is taken from the GSTIN.'}>
                <Input id="es-gstin" maxLength={15} value={text('gstin')} onChange={(e) => setCompany('gstin', e.target.value.toUpperCase())} /></Field>
              <Field label="Registered address" htmlFor="es-addr" className="sm:col-span-2"><Textarea id="es-addr" rows={2} value={text('legal_address')} onChange={(e) => setCompany('legal_address', e.target.value)} /></Field>
              <Field label="PAN" htmlFor="es-pan"><Input id="es-pan" maxLength={10} value={text('pan')} onChange={(e) => setCompany('pan', e.target.value.toUpperCase())} /></Field>
              <Field label="CIN (optional)" htmlFor="es-cin"><Input id="es-cin" maxLength={21} value={text('cin')} onChange={(e) => setCompany('cin', e.target.value.toUpperCase())} /></Field>
              <Field label="Contact number" htmlFor="es-phone"><Input id="es-phone" value={text('phone')} onChange={(e) => setCompany('phone', e.target.value)} /></Field>
              <Field label="E-mail" htmlFor="es-email"><Input id="es-email" type="email" value={text('email')} onChange={(e) => setCompany('email', e.target.value)} /></Field>
              <Field label="Website" htmlFor="es-web"><Input id="es-web" value={text('website')} onChange={(e) => setCompany('website', e.target.value)} /></Field>
              <Field label="State" htmlFor="es-state"><Input id="es-state" value={text('state')} onChange={(e) => setCompany('state', e.target.value)} /></Field>
              <Field label="Country" htmlFor="es-country"><Input id="es-country" value={text('country')} onChange={(e) => setCompany('country', e.target.value)} /></Field>
              <Field label="Currency" htmlFor="es-cur" hint="3-letter code"><Input id="es-cur" maxLength={3} value={text('currency_code')} onChange={(e) => setCompany('currency_code', e.target.value.toUpperCase())} /></Field>
              <Field label="Financial year starts" htmlFor="es-fy" hint={`Current financial year ${data.company.current_financial_year}`}>
                <Select value={String(cv('fy_start_month'))} onValueChange={(v) => { if (v) setCompany('fy_start_month', Number(v)) }}><SelectTrigger id="es-fy"><SelectValue /></SelectTrigger>
                  <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Date format" htmlFor="es-df" hint="Used for dates on every screen and print">
                <Select value={sv('general.date_format')} onValueChange={(v) => { if (v) setSetting('general.date_format', v as ErpSettingsValues['general.date_format']) }}><SelectTrigger id="es-df"><SelectValue /></SelectTrigger>
                  <SelectContent>{DATE_PATTERNS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Time zone" hint="Set when the company was created"><p className="text-sm">{data.company.timezone}</p></Field>
            </CardContent></Card>
          <Card><CardHeader><div><CardTitle>Company logo</CardTitle><CardDescription>Printed on invoices, credit / debit notes and purchase orders. The ALTON wordmark is used when none is uploaded.</CardDescription></div></CardHeader>
            <CardContent className="flex flex-wrap items-center gap-4">
              <img src={String(cv('logo_data_url') || LOGO_SRC)} alt="Company logo" className="h-12 w-auto rounded border bg-white p-1" />
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"><Upload className="size-4" /> Upload logo
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" aria-label="Upload logo" onChange={(e) => onLogo(e.target.files?.[0] ?? null)} /></label>
              {cv('logo_data_url') && <Button type="button" variant="outline" size="sm" onClick={() => setCompany('logo_data_url', '')}>Use the ALTON wordmark</Button>}
            </CardContent></Card>
        </div>
      )
      case 'products': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>SKU numbering</CardTitle><CardDescription>A product saved without an SKU gets the next number for its type (e.g. FG-000001). Counters never restart.</CardDescription></div></CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={sv('product.auto_sku')} onCheckedChange={(v) => setSetting('product.auto_sku', v === true)} aria-label="Automatic SKU numbering" /> Number SKUs automatically when left blank</label>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{PRODUCT_TYPES.map(([t, l]) => (
                <Field key={t} label={`${l} prefix`} htmlFor={`es-sku-${t}`}><Input id={`es-sku-${t}`} maxLength={4} value={sv('product.sku_prefixes')[t] ?? ''}
                  onChange={(e) => setSetting('product.sku_prefixes', { ...sv('product.sku_prefixes'), [t]: e.target.value.toUpperCase() })} /></Field>
              ))}</div>
            </CardContent></Card>
          <Card><CardHeader><div><CardTitle>Units, HSN codes and GST</CardTitle><CardDescription>Offered when creating products. Each product keeps its own unit, HSN and GST rate.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Units of measurement" htmlFor="es-units" hint="Comma-separated codes; PCS, NOS, SET and PAIR are counted in whole pieces">
                <Input id="es-units" value={sv('product.units').join(', ')} onChange={(e) => setSetting('product.units', e.target.value.toUpperCase().split(/[,\s]+/).filter(Boolean))} /></Field>
              <Field label="Default GST rate for new products (%)" htmlFor="es-gst" hint="GST rates offered on invoices are set under Invoices">
                <Input id="es-gst" inputMode="decimal" value={String(sv('product.default_gst_rate'))} onChange={(e) => setSetting('product.default_gst_rate', Number(e.target.value) || 0)} /></Field>
              <div className="space-y-2 sm:col-span-2"><p className="text-sm font-medium">HSN codes</p>
                {sv('product.hsn_codes').map((h, i) => (
                  <div key={i} className="flex flex-wrap gap-2">
                    <Input aria-label={`HSN ${i + 1} code`} className="w-32" value={h.code} onChange={(e) => setSetting('product.hsn_codes', sv('product.hsn_codes').map((x, j) => (j === i ? { ...x, code: e.target.value.trim() } : x)))} />
                    <Input aria-label={`HSN ${i + 1} description`} className="min-w-48 flex-1" placeholder="Description" value={h.description ?? ''} onChange={(e) => setSetting('product.hsn_codes', sv('product.hsn_codes').map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <Input aria-label={`HSN ${i + 1} GST`} className="w-24" placeholder="GST %" inputMode="decimal" value={h.gst_rate ?? ''} onChange={(e) => setSetting('product.hsn_codes', sv('product.hsn_codes').map((x, j) => (j === i ? { ...x, gst_rate: e.target.value === '' ? null : Number(e.target.value) } : x)))} />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove HSN ${i + 1}`} onClick={() => setSetting('product.hsn_codes', sv('product.hsn_codes').filter((_, j) => j !== i))}><Trash2 /></Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setSetting('product.hsn_codes', [...sv('product.hsn_codes'), { code: '', description: '', gst_rate: null }])}><Plus /> Add HSN code</Button>
              </div>
              <div className="space-y-2 sm:col-span-2" data-testid="group-heads-setting"><p className="text-sm font-medium">Group heads</p>
                <p className="text-xs text-muted-foreground">Product group classification offered on the Product Master and the BOM (Product Planning &amp; Classification). Values already used on products stay available.</p>
                {(sv('product.group_heads') ?? []).map((g, i) => (
                  <div key={i} className="flex gap-2">
                    <Input aria-label={`Group head ${i + 1}`} className="max-w-sm" maxLength={100} value={g}
                      onChange={(e) => setSetting('product.group_heads', (sv('product.group_heads') ?? []).map((x, j) => (j === i ? e.target.value : x)))} />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove group head ${i + 1}`} onClick={() => setSetting('product.group_heads', (sv('product.group_heads') ?? []).filter((_, j) => j !== i))}><Trash2 /></Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setSetting('product.group_heads', [...(sv('product.group_heads') ?? []), ''])}><Plus /> Add group head</Button>
              </div>
            </CardContent></Card>
          <div className="grid gap-3 md:grid-cols-3">
            <Info title="Product categories"><Go to="/products/categories">Manage categories</Go></Info>
            <Info title="Product types">{PRODUCT_TYPES.map(([, l]) => l).join(', ')}. Fixed, because BOMs, production and stock reports depend on them.</Info>
            <Info title="Product status">Active or inactive per product; inactive products cannot be ordered. Products are archived, never deleted.</Info>
          </div>
        </div>
      )
      case 'inventory': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Stock adjustment reasons</CardTitle><CardDescription>Offered as ready-made notes when you adjust stock.</CardDescription></div></CardHeader>
            <CardContent><Field label="Reasons" htmlFor="es-adj" hint="One per line"><Textarea id="es-adj" rows={6} value={sv('inventory.adjustment_reasons').join('\n')}
              onChange={(e) => setSetting('inventory.adjustment_reasons', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} /></Field></CardContent></Card>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Info title="Warehouses and storage locations"><Go to="/inventory/warehouses">Manage warehouses and locations</Go>. Default warehouse: {data.warehouses.find((w) => w.is_default)?.name ?? 'not set'}.</Info>
            <Info title="Stock valuation method">Weighted-average receipt cost of each lot (GRN cost, production cost of materials used). Lots without a cost are shown as not valued, never estimated.</Info>
            <Info title="Minimum stock and reorder levels">Set per product (Product Master → reorder level). Products at or below it appear in low-stock alerts. <Go to="/inventory/alerts">Low-stock alerts</Go></Info>
            <Info title="Reservation rules">Available = physical − active reservations. Sales orders reserve finished goods and production materials automatically; production orders reserve their materials. Cancelling releases them.</Info>
            <Info title="Negative stock">Not allowed: an issue, dispatch or consumption larger than the stock is refused with a clear message.</Info>
            <Info title="Stock transfers">Between warehouses and locations, posted as a pair of movements. <Go to="/inventory/movements">Stock movements</Go></Info>
          </div>
        </div>
      )
      case 'purchase': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Purchase orders and goods received</CardTitle><CardDescription>Numbers are assigned automatically and never reused.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Purchase order prefix" htmlFor="es-po" hint={`Next: ${nextNumber('PO', 'numbering.po_prefix')}`}><Input id="es-po" maxLength={5} value={sv('numbering.po_prefix')} onChange={(e) => setSetting('numbering.po_prefix', e.target.value.toUpperCase())} /></Field>
              <Field label="Goods received prefix" htmlFor="es-grn" hint={`Next: ${nextNumber('GRN', 'numbering.grn_prefix')}`}><Input id="es-grn" maxLength={5} value={sv('numbering.grn_prefix')} onChange={(e) => setSetting('numbering.grn_prefix', e.target.value.toUpperCase())} /></Field>
              <Field label="Default payment terms" htmlFor="es-poterms" hint="For suppliers without their own terms">
                <Select value={sv('purchase.default_payment_terms')} onValueChange={(v) => { if (v) setSetting('purchase.default_payment_terms', v as ErpSettingsValues['purchase.default_payment_terms']) }}><SelectTrigger id="es-poterms"><SelectValue /></SelectTrigger>
                  <SelectContent>{PO_TERMS.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Default delivery terms" htmlFor="es-podel" className="sm:col-span-2 xl:col-span-4" hint="Filled in on new purchase orders (delivery instructions)">
                <Textarea id="es-podel" rows={2} value={sv('purchase.default_delivery_terms') ?? ''} onChange={(e) => setSetting('purchase.default_delivery_terms', e.target.value || null)} /></Field>
            </CardContent></Card>
          <div className="grid gap-3 md:grid-cols-3">
            <Info title="Default supplier">Set a preferred supplier per product (Product Master); shortages and purchase suggestions use it.</Info>
            <Info title="Purchase charges and freight">Added as charge lines on the purchase order, with their own GST rate; charges are never received into stock.</Info>
            <Info title="Supplier details"><Go to="/ledger">Ledger</Go> holds GSTIN, terms and bank details per supplier.</Info>
          </div>
        </div>
      )
      case 'production': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Production orders and BOMs</CardTitle></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Production order prefix" htmlFor="es-prd" hint={`Next: ${nextNumber('PRD', 'numbering.production_prefix')}`}><Input id="es-prd" maxLength={5} value={sv('numbering.production_prefix')} onChange={(e) => setSetting('numbering.production_prefix', e.target.value.toUpperCase())} /></Field>
              <Field label="Default wastage % on new BOM lines" htmlFor="es-waste"><Input id="es-waste" inputMode="decimal" value={String(sv('production.default_wastage_percent'))} onChange={(e) => setSetting('production.default_wastage_percent', Number(e.target.value) || 0)} /></Field>
              <Field label="Material consumption when completing" htmlFor="es-cons">
                <Select value={sv('production.consumption_prefill')} onValueChange={(v) => { if (v) setSetting('production.consumption_prefill', v as ErpSettingsValues['production.consumption_prefill']) }}><SelectTrigger id="es-cons"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="STANDARD">Pre-fill with the BOM standard</SelectItem><SelectItem value="BLANK">Leave blank (enter actuals)</SelectItem></SelectContent></Select></Field>
            </CardContent></Card>
          <div className="grid gap-3 md:grid-cols-3">
            <Info title="Default production location">Materials are taken from, and finished goods received into, the default warehouse ({data.warehouses.find((w) => w.is_default)?.name ?? 'not set'}) unless the order says otherwise.</Info>
            <Info title="Costing method">Actual cost: the cost of the material lots consumed, divided by the good output.</Info>
            <Info title="Rejection rules">Rejected output goes to the rejected-stock location (not available for sale); scrap is recorded as wastage.</Info>
          </div>
        </div>
      )
      case 'sales': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Sales orders</CardTitle><CardDescription>Defaults for new sales orders; every field stays editable on the order.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Sales order prefix" htmlFor="es-so" hint={`Next: ${nextNumber('SO', 'numbering.sales_order_prefix')}`}><Input id="es-so" maxLength={5} value={sv('numbering.sales_order_prefix')} onChange={(e) => setSetting('numbering.sales_order_prefix', e.target.value.toUpperCase())} /></Field>
              <Field label="Default customer payment terms" htmlFor="es-soterms" hint="Used when the customer has none"><Input id="es-soterms" value={sv('sales.default_payment_terms') ?? ''} onChange={(e) => setSetting('sales.default_payment_terms', e.target.value || null)} placeholder="e.g. 30 days" /></Field>
              <Field label="Default sales warehouse" htmlFor="es-sowh">
                <Select value={sv('sales.default_warehouse_id') ?? 'any'} onValueChange={(v) => { if (v) setSetting('sales.default_warehouse_id', v === 'any' ? null : v) }}><SelectTrigger id="es-sowh"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="any">Any warehouse</SelectItem>{data.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.code} — {w.name}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Default delivery terms" htmlFor="es-sodel" className="sm:col-span-2 xl:col-span-3"><Textarea id="es-sodel" rows={2} value={sv('sales.default_delivery_instructions') ?? ''} onChange={(e) => setSetting('sales.default_delivery_instructions', e.target.value || null)} /></Field>
            </CardContent></Card>
          <Info title="Reservation rules">On saving an order, available finished goods are reserved (earliest expiry first); for the rest, the BOM materials that are available are reserved for production. Shortages are shown, never blocking. Dispatch uses the reservation; cancelling releases it.</Info>
        </div>
      )
      case 'imports': return (
        <div className="space-y-6">
          <Card><CardHeader><div><CardTitle>Dates in imported files</CardTitle></div></CardHeader>
            <CardContent><Field label="Read 03/04/2026 as" htmlFor="es-imp">
              <Select value={sv('import.date_order')} onValueChange={(v) => { if (v) setSetting('import.date_order', v as ErpSettingsValues['import.date_order']) }}><SelectTrigger id="es-imp" className="w-72"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="DMY">3 April 2026 (day-month-year)</SelectItem><SelectItem value="MDY">4 March 2026 (month-day-year)</SelectItem></SelectContent></Select></Field>
              <p className="mt-2 text-xs text-muted-foreground">YYYY-MM-DD and real Excel dates are always read correctly.</p></CardContent></Card>
          <Card><CardHeader><div><CardTitle>Templates and import screens</CardTitle><CardDescription>Each screen has a "Download template" button, a preview with every problem, and a downloadable error report.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
              {[['Products', '/products/import'], ['Opening stock', '/inventory/opening-stock/import'], ['Bills of materials', '/production/boms/import'], ['Production', '/production/import'],
                ['Sales orders', '/sales/orders/import'], ['Invoices', '/billing/invoices/import']].map(([l, to]) => <Go key={to} to={to}>{l}</Go>)}
            </CardContent></Card>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Info title="Import history"><Go to="/admin/bulk-operations">Import History</Go> lists every run with its rows and messages.</Info>
            <Info title="Column mapping">Headers are matched by name and common aliases (e.g. "Qty", "Item code", "Party"), in any order; the header may be below title rows.</Info>
            <Info title="Duplicate detection">Re-uploading never duplicates: invoices by number, sales orders by customer + reference, products by SKU, production by date + product + reference.</Info>
            <Info title="Validation and error reports">All rows are checked before saving; a document with any bad row is held back whole and listed in the error report. Nothing is skipped silently.</Info>
          </div>
        </div>
      )
      default: return null
    }
  })()

  return (
    <div className="space-y-4">
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {body}
      <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3">
        <Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save settings</Button>
        {dirty && <Button variant="outline" disabled={busy} onClick={() => { setC({}); setS({}); setError(null) }}>Discard changes</Button>}
      </div>
    </div>
  )
}

function InvoicesTab() {
  const s = useAsync(fetchBillingSettings, [])
  const d = s.data
  return (
    <Card>
      <CardHeader><div><CardTitle>Invoice settings</CardTitle><CardDescription>Invoice prefix and sequence, financial year, GST rates and calculation, payment terms, bank details, template, terms and signatory are edited on one page.</CardDescription></div>
        <Button asChild><Link to="/billing/settings">Open invoice settings</Link></Button></CardHeader>
      <CardContent>{s.loading && !d ? <LoadingState variant="table" rows={2} /> : s.error || !d ? <ErrorState message={describeDataError(s.error)} onRetry={s.reload} /> : (
        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          {([['Next invoice number', d.example_invoice_number], ['Financial year', d.current_financial_year], ['GST rates', (d.gst_rates ?? []).map(Number).join(', ') + '%'],
            ['Prices', d.pricing_mode === 'INCLUSIVE' ? 'Including GST' : 'Before GST'], ['Default payment terms', `${d.default_payment_terms_days} days`],
            ['Bank accounts', String((d.bank_accounts ?? []).length)], ['Template', d.invoice_template], ['Authorised signatory', d.authorized_signatory ?? 'not set']] as [string, string][]).map(([k, v]) => (
            <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
          ))}
        </dl>)}</CardContent>
    </Card>
  )
}

const EXPORTS: { label: string; file: string; reports: string[] }[] = [
  { label: 'Company data (products, customers, suppliers)', file: 'company-data', reports: ['PRODUCTS', 'CUSTOMER_OUTSTANDING', 'SUPPLIER_OUTSTANDING'] },
  { label: 'Inventory', file: 'inventory', reports: ['STOCK_REGISTER', 'INVENTORY_VALUATION', 'STOCK_MOVEMENTS', 'LOW_STOCK'] },
  { label: 'Sales', file: 'sales', reports: ['SALES_ORDER_REGISTER', 'DISPATCH', 'CUSTOMER_SALES', 'PRODUCT_SALES'] },
  { label: 'Purchase', file: 'purchase', reports: ['PURCHASE_REGISTER', 'GRN_REGISTER', 'SUPPLIER_PURCHASES'] },
  { label: 'Production', file: 'production', reports: ['PRODUCTION_REGISTER', 'MATERIAL_CONSUMPTION', 'PRODUCTION_WASTAGE'] },
  { label: 'Invoices and payments', file: 'invoices', reports: ['INVOICE_REGISTER', 'PAYMENT_COLLECTION', 'GST_SUMMARY'] },
]

function BackupTab() {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [today] = useState(() => toIsoDate(new Date()))
  const exportSet = async (e: (typeof EXPORTS)[number]) => {
    setBusy(e.file); setError(null); setDone(null)
    try {
      const sheets = []
      for (const key of e.reports) {
        const def = REPORTS.find((r) => r.key === key)!
        const res = await runReport(key, { from: '2000-01-01', to: today })
        sheets.push({ name: def.title.slice(0, 31), rows: reportSheet(def, res.rows) })
      }
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets(sheets, `alton-erp-${e.file}-${today}`, 'xlsx')
      setDone(`${e.label}: workbook downloaded.`)
    } catch (err) { setError(describeDataError(err)) } finally { setBusy(null) }
  }
  return (
    <div className="space-y-6">
      <Card><CardHeader><div><CardTitle>Database backups</CardTitle></div></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>The database is hosted on Supabase. Backups are made by Supabase according to your Supabase plan (daily on paid plans; point-in-time recovery when enabled) and are restored from the Supabase dashboard.</p>
          <p>This ERP does not run or check database backups, so it does not show a backup status. Use the exports below for your own copies.</p>
        </CardContent></Card>
      <Card><CardHeader><div><CardTitle>Export data to Excel</CardTitle><CardDescription>All records to date, one sheet per report.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          {done && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{done}</p>}
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <div className="flex flex-wrap gap-2">{EXPORTS.map((e) => (
            <Button key={e.file} variant="outline" disabled={busy !== null} onClick={() => void exportSet(e)}>{busy === e.file ? <Loader2 className="animate-spin" /> : <Download />} Export {e.label.toLowerCase()}</Button>
          ))}</div>
        </CardContent></Card>
      <Card><CardHeader><div><CardTitle>Audit history</CardTitle><CardDescription>Every change, correction and reversal is recorded with who made it and when.</CardDescription></div></CardHeader>
        <CardContent className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Go to="/audit-logs">Open the audit log</Go><Go to="/admin/bulk-operations">Import history</Go>
        </CardContent></Card>
    </div>
  )
}
