import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CopyPlus, Loader2, PackagePlus } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { CategoryPicker } from '@/features/products/category-picker'
import { BOM_OUTPUT_TYPES, PRODUCT_TYPE_LABELS, productUnitOptions, unitOptionLabel, type ProductType } from '@/features/products/product-model'
import { EMPTY_PRODUCT_FORM, productToFormValues, validateProduct, type ProductField, type ProductFormValues } from '@/features/products/product-validation'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { BomComponentEditor, BomCostSummary } from '@/features/production/bom-component-editor'
import { linesCost, useComponentInfo } from '@/features/production/bom-component-info'
import {
  COPIED_FIELDS, componentProblem, itemsFromLines, lineChanges, linesFromItems, newLine, productPayload, similarProductValues, type EditorLine,
} from '@/features/production/bom-tools-model'
import { BomStatusBadge } from '@/features/production/production-badges'
import { parseUnitQty, quantityRule } from '@/features/inventory/whole-units'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { createSimilarProducts, fetchTemplate, fetchTemplates, type SimilarProductResult } from '@/services/bom-tools'
import { getProduct, listCategories, uploadProductImage, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES } from '@/services/products'
import { activateBom, bomAction, fetchBom, fetchBoms } from '@/services/production'

type Source = { kind: 'bom'; id: string } | { kind: 'template'; id: string } | null

interface Loaded {
  label: string
  /** e.g. "BOM-000004 v2 (BAS-STD)" or 'template "Standard basin kit"'. */
  sourceText: string
  values: ProductFormValues
  sourceSku: string | null
  output: string
  outputUnit: string
  lines: EditorLine[]
}

async function loadSource(source: Source): Promise<Loaded | null> {
  if (!source) return null
  if (source.kind === 'bom') {
    const { bom, items } = await fetchBom(source.id)
    const product = await getProduct(bom.finished_product_id)
    return {
      label: `${bom.bom_code} v${bom.version} — ${bom.sku}`, sourceText: `${bom.bom_code} v${bom.version} (${bom.sku})`,
      values: similarProductValues(productToFormValues(product)), sourceSku: product.sku,
      output: String(Number(bom.output_quantity)), outputUnit: bom.output_unit, lines: linesFromItems(items),
    }
  }
  const { template, items } = await fetchTemplate(source.id)
  return {
    label: `Template ${template.template_name}`, sourceText: `template "${template.template_name}"`,
    values: { ...EMPTY_PRODUCT_FORM, product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: template.output_unit,
      category_id: template.category_id ?? '', description: template.description ?? '', is_manufacturable: true },
    sourceSku: null, output: String(Number(template.output_quantity)), outputUnit: template.output_unit, lines: linesFromItems(items),
  }
}

function Field({ label, htmlFor, error, hint, children, full }: { label: string; htmlFor?: string; error?: string; hint?: string; children: ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'space-y-1.5 sm:col-span-2 xl:col-span-3' : 'space-y-1.5'}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-shortage">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

const show = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : v === '' || v === null || v === undefined ? '—' : String(v))

/**
 * /production/boms/similar?source=<bomId> | ?template=<templateId>
 * Create a new finished product from an existing BOM (or a template): new product details, a copy of the
 * components to edit, the cost against the source, then one save that creates the product and a DRAFT BOM.
 * The source is never changed; activation is the existing, separately authorised step.
 */
export default function BomSimilarProductPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const source: Source = params.get('source') ? { kind: 'bom', id: params.get('source')! } : params.get('template') ? { kind: 'template', id: params.get('template')! } : null
  const loaded = useAsync(() => loadSource(source), [source?.kind, source?.id])
  const boms = useAsync(() => (source ? Promise.resolve([]) : fetchBoms('ACTIVE')), [Boolean(source)])
  const templates = useAsync(() => (source ? Promise.resolve([]) : fetchTemplates().catch(() => [])), [Boolean(source)])
  const categories = useAsync(() => listCategories(), [])
  const { prefs } = useErpPreferences()
  const { key, renew } = useRequestKey()

  const [values, setValues] = useState<ProductFormValues>(EMPTY_PRODUCT_FORM)
  const [lines, setLines] = useState<EditorLine[]>([newLine()])
  const [sourceLines, setSourceLines] = useState<EditorLine[]>([])
  const [output, setOutput] = useState('1')
  const [from, setFrom] = useState(() => toIsoDate(new Date()))
  const [reason, setReason] = useState('')
  const [instructions, setInstructions] = useState('')
  const [notes, setNotes] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [showCopied, setShowCopied] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: SimilarProductResult; imageError: string | null; status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' } | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)

  // Fill the form once per loaded source.
  useEffect(() => {
    const d = loaded.data
    if (!d) return
    void Promise.resolve().then(() => {
      setValues(d.values)
      setLines(d.lines.length ? d.lines : [newLine()])
      setSourceLines(d.lines)
      setOutput(d.output)
      setResult(null)
      setSubmitted(false)
    })
  }, [loaded.data])

  const info = useComponentInfo(useMemo(() => [...lines, ...sourceLines], [lines, sourceLines]))
  const cost = linesCost(lines, output, info)
  const sourceCost = linesCost(sourceLines, loaded.data?.output ?? '1', info)
  const units = productUnitOptions(prefs?.['product.units'] as string[] | undefined, [values.base_unit])
  const validation = validateProduct(values, { units: [values.base_unit] })
  const typeProblem = values.product_type && !BOM_OUTPUT_TYPES.includes(values.product_type) ? 'This product type cannot have a BOM: choose a finished good, subassembly, component, outsourced component or other.' : null
  const errors: Partial<Record<ProductField, string>> = submitted ? { ...validation.errors, ...(typeProblem ? { product_type: typeProblem } : {}) } : {}
  const set = <K extends ProductField>(k: K, v: ProductFormValues[K]) => setValues((x) => ({ ...x, [k]: v }))
  const changes = lineChanges(sourceLines, lines)
  const canCreate = has('production_bom.create') && has('products.create')

  const review = () => {
    setSubmitted(true)
    setError(null)
    const problems: string[] = []
    if (!validation.input) problems.push(`Correct the product details: ${Object.values(validation.errors).join(' ')}`)
    if (typeProblem) problems.push(typeProblem)
    if (!parseUnitQty(output, values.base_unit)) problems.push(`Output quantity must be greater than zero (${quantityRule(values.base_unit)}).`)
    const cp = componentProblem(lines)
    if (cp) problems.push(cp)
    if (image && (!PRODUCT_IMAGE_TYPES.includes(image.type) || image.size > PRODUCT_IMAGE_MAX_BYTES)) problems.push('The image must be a JPEG, PNG or WebP file of 2 MB or less.')
    if (problems.length) return setError(problems.join(' '))
    setConfirming(true)
  }

  const save = async () => {
    if (!validation.input || !source) return
    setBusy(true)
    setError(null)
    try {
      const r = await createSimilarProducts(source.kind === 'bom' ? { bom_id: source.id } : { template_id: source.id }, [{
        product: productPayload(validation.input),
        bom: { output_quantity: parseUnitQty(output, values.base_unit)!, effective_from: from, notes: notes.trim() || null,
          change_reason: reason.trim() || null, process_instructions: instructions.trim() || null },
        items: itemsFromLines(lines),
      }], key)
      renew()
      const created = r.products[0]
      let imageError: string | null = null
      if (image) {
        try {
          await uploadProductImage(await getProduct(created.product_id), image)
        } catch (e) {
          imageError = `The product was created, but the image was not uploaded: ${describeDataError(e)}. Add it on the product page.`
        }
      }
      setResult({ created, imageError, status: 'DRAFT' })
      setConfirming(false)
    } catch (e) {
      setError(describeDataError(e))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Create similar product' }]
  const header = <PageHeader title="Create similar product" breadcrumbs={crumbs}
    description="A new finished product with its own BOM, copied from an existing BOM or template and changed as needed. The source is never changed."
    actions={<Button variant="outline" asChild><Link to="/production/boms"><ArrowLeft /> All BOMs</Link></Button>} />

  // Step 1: choose the source.
  if (!source) {
    return (
      <>
        {header}
        <Card className="max-w-3xl" data-testid="similar-source">
          <CardHeader><div><CardTitle>1. Choose what to copy</CardTitle><CardDescription>Select an existing BOM (any version) or a BOM template.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="similar-bom">Existing BOM</Label>
              <Select onValueChange={(v) => setParams({ source: v })}>
                <SelectTrigger id="similar-bom" className="w-full"><SelectValue placeholder={boms.loading ? 'Loading…' : 'Select a BOM'} /></SelectTrigger>
                <SelectContent>{(boms.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.bom_code} v{b.version} — {b.sku} {b.product_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="similar-template">BOM template</Label>
              <Select onValueChange={(v) => setParams({ template: v })}>
                <SelectTrigger id="similar-template" className="w-full"><SelectValue placeholder={templates.loading ? 'Loading…' : (templates.data ?? []).length ? 'Select a template' : 'No templates yet'} /></SelectTrigger>
                <SelectContent>{(templates.data ?? []).filter((t) => t.status === 'ACTIVE').map((t) => <SelectItem key={t.id} value={t.id}>{t.template_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </>
    )
  }
  if (loaded.loading && !loaded.data) return (<>{header}<LoadingState variant="cards" rows={3} /></>)
  if (loaded.error || !loaded.data) return (<>{header}<Card><ErrorState message={describeDataError(loaded.error)} onRetry={loaded.reload} /></Card></>)
  const src = loaded.data

  if (result) {
    const c = result.created
    return (
      <>
        {header}
        <Card className="max-w-3xl" data-testid="similar-result">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-5 text-green-700" /> {c.sku} — {c.product_name} created</CardTitle>
              <CardDescription>The product is in the Product Master. Its BOM {c.bom_code} v{c.version} ({c.components} components) is saved as a draft: production cannot use it until it is activated. {src.sourceText} is unchanged.</CardDescription>
            </div>
            <BomStatusBadge status={result.status} />
          </CardHeader>
          <CardContent className="space-y-3">
            {result.imageError && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{result.imageError}</p>}
            <div className="flex flex-wrap gap-2">
              {result.status === 'DRAFT' && has('production_bom.approve') && (
                <Button onClick={() => setAction({ title: `Activate ${c.bom_code} v${c.version}`, confirmLabel: 'Activate', note: 'optional',
                  description: 'The BOM is checked (active components, units, no circular references) and becomes the version used for production.',
                  run: async (note) => { await activateBom(c.bom_id, note); setResult((r) => (r ? { ...r, status: 'APPROVED' } : r)); return `${c.bom_code} v${c.version} is active.` } })}>Activate BOM</Button>
              )}
              {result.status === 'DRAFT' && !has('production_bom.approve') && (
                <Button onClick={() => setAction({ title: 'Submit BOM for approval', confirmLabel: 'Submit', note: 'none', description: 'The BOM is validated again and waits for approval.',
                  run: async () => { await bomAction(c.bom_id, 'SUBMIT', null); setResult((r) => (r ? { ...r, status: 'PENDING_APPROVAL' } : r)); return `${c.bom_code} v${c.version} submitted for approval.` } })}>Submit for approval</Button>
              )}
              <Button variant="outline" asChild><Link to={`/production/boms/${c.bom_id}`}>Open BOM</Link></Button>
              <Button variant="outline" asChild><Link to={`/products/${c.product_id}`}>Open product</Link></Button>
              <Button variant="outline" onClick={() => { setResult(null); setValues(similarProductValues(src.values)); setImage(null); setSubmitted(false) }}><CopyPlus /> Create another</Button>
            </div>
          </CardContent>
        </Card>
        <ActionDialog request={action} onClose={() => setAction(null)} onDone={() => setAction(null)} />
      </>
    )
  }

  const copied = COPIED_FIELDS.filter(([k]) => show(values[k]) !== '—')
  return (
    <>
      {header}
      <p className="mb-4 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm" data-testid="similar-from">
        Copying <span className="font-medium">{src.label}</span>. <button type="button" className="font-medium text-primary hover:underline" onClick={() => setParams({})}>Choose another source</button>
      </p>
      {!canCreate && <p role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">Creating a similar product needs permission to create BOMs and products (production_bom.create and products.create).</p>}
      {error && <p role="alert" data-testid="similar-error" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      <div className="space-y-6">
        <Card>
          <CardHeader><div><CardTitle>2. New product details</CardTitle><CardDescription>Starts from {src.sourceSku ? `${src.sourceSku}'s` : 'the template\'s'} Product Master fields. SKU, barcode, EAN, image and Cost are not copied.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="Finished product name" htmlFor="sp-name" error={errors.product_name}><Input id="sp-name" maxLength={200} value={values.product_name} onChange={(e) => set('product_name', e.target.value)} aria-invalid={Boolean(errors.product_name)} /></Field>
            <Field label="SKU / product code" htmlFor="sp-sku" error={errors.sku} hint="Blank = next automatic code (if enabled in ERP Settings). Must be unique."><Input id="sp-sku" maxLength={60} value={values.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            <Field label="Product category" htmlFor="sp-category" error={errors.category_id}>
              <CategoryPicker id="sp-category" value={values.category_id} categories={categories.data ?? []} onChange={(v) => set('category_id', v)} canAdd={false} onAddRequest={() => undefined} />
            </Field>
            <Field label="Product type" htmlFor="sp-type" error={errors.product_type}>
              <Select value={values.product_type || undefined} onValueChange={(v) => set('product_type', v as ProductType)}>
                <SelectTrigger id="sp-type" className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{BOM_OUTPUT_TYPES.map((t) => <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Unit of measurement" htmlFor="sp-unit" error={errors.base_unit}>
              <Select value={values.base_unit} onValueChange={(v) => set('base_unit', v)}>
                <SelectTrigger id="sp-unit" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{unitOptionLabel(u)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="HSN code" htmlFor="sp-hsn" error={errors.hsn_code}><Input id="sp-hsn" inputMode="numeric" maxLength={8} value={values.hsn_code} onChange={(e) => set('hsn_code', e.target.value)} /></Field>
            <Field label="GST rate (%)" htmlFor="sp-gst" error={errors.gst_rate}><Input id="sp-gst" inputMode="decimal" value={values.gst_rate} onChange={(e) => set('gst_rate', e.target.value)} /></Field>
            <Field label="MRP (₹)" htmlFor="sp-mrp" error={errors.mrp}><Input id="sp-mrp" inputMode="decimal" value={values.mrp} onChange={(e) => set('mrp', e.target.value)} /></Field>
            <Field label="Selling price (₹)" htmlFor="sp-price" error={errors.selling_price}><Input id="sp-price" inputMode="decimal" value={values.selling_price} onChange={(e) => set('selling_price', e.target.value)} /></Field>
            <Field label="Cost (₹, optional)" htmlFor="sp-cost" error={errors.standard_cost} hint="Leave blank to enter later; the BOM material cost estimate is shown below.">
              <Input id="sp-cost" inputMode="decimal" value={values.standard_cost} onChange={(e) => set('standard_cost', e.target.value)} />
            </Field>
            <Field label="Brand" htmlFor="sp-brand" error={errors.brand}><Input id="sp-brand" maxLength={100} value={values.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
            <Field label="Group head" htmlFor="sp-group" error={errors.group_head}><Input id="sp-group" maxLength={100} value={values.group_head} onChange={(e) => set('group_head', e.target.value)} /></Field>
            <Field label="Lead time (days)" htmlFor="sp-lead" error={errors.lead_time_days}><Input id="sp-lead" inputMode="decimal" value={values.lead_time_days} onChange={(e) => set('lead_time_days', e.target.value)} /></Field>
            <Field label="Minimum stock days" htmlFor="sp-mincover" error={errors.minimum_cover_days}><Input id="sp-mincover" inputMode="decimal" value={values.minimum_cover_days} onChange={(e) => set('minimum_cover_days', e.target.value)} /></Field>
            <Field label="Image link (optional)" htmlFor="sp-image-url" error={errors.image_url}><Input id="sp-image-url" type="url" placeholder="https://…" value={values.image_url} onChange={(e) => set('image_url', e.target.value)} /></Field>
            <Field label="Product image (optional)" htmlFor="sp-image" hint="JPEG, PNG or WebP, up to 2 MB. Uploaded after the product is created.">
              <Input id="sp-image" type="file" accept={PRODUCT_IMAGE_TYPES.join(',')} onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Description" htmlFor="sp-description" error={errors.description} full>
              <Textarea id="sp-description" rows={2} maxLength={2000} value={values.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            {copied.length > 0 && (
              <div className="sm:col-span-2 xl:col-span-3">
                <button type="button" className="flex items-center gap-1 text-sm font-medium text-primary" onClick={() => setShowCopied((v) => !v)} aria-expanded={showCopied}>
                  {showCopied ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Other Product Master fields copied from {src.sourceSku ?? 'the template'} ({copied.length})
                </button>
                {showCopied && (
                  <dl className="mt-2 grid gap-x-6 gap-y-1 rounded-md border bg-surface-muted/40 p-3 text-sm sm:grid-cols-2 xl:grid-cols-3" data-testid="similar-copied">
                    {copied.map(([k, label]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd>{show(values[k])}</dd></div>)}
                    <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">Change these in the Product Master after saving.</p>
                  </dl>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>3. Components</CardTitle><CardDescription>A copy of the source's components: change quantities, add, remove or replace components and edit wastage and remarks.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={`Output quantity (${values.base_unit})`} htmlFor="sp-output"><Input id="sp-output" inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} /></Field>
              <Field label="Effective from" htmlFor="sp-from"><Input id="sp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            </div>
            <BomComponentEditor lines={lines} onChange={setLines} output={output} outputUnit={values.base_unit} idPrefix="sp" info={info}
              defaultWastage={String(prefs?.['production.default_wastage_percent'] ?? 0)} testId="similar-components" />
            <p className="text-sm" data-testid="similar-changes">
              <span className="font-medium">Changes from the source: </span>
              {changes.added.length + changes.removed.length + changes.changed.length === 0 ? 'none.' : [
                changes.added.length ? `added ${changes.added.join(', ')}` : '', changes.removed.length ? `removed ${changes.removed.join(', ')}` : '',
                changes.changed.length ? `quantity or wastage changed for ${changes.changed.join(', ')}` : '',
              ].filter(Boolean).join('; ') + '.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Reason for this BOM (optional)" htmlFor="sp-reason" hint={`Blank = "Created from ${src.sourceText}".`}><Input id="sp-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Field label="Notes (optional)" htmlFor="sp-notes"><Input id="sp-notes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              <Field label="Process instructions (optional)" htmlFor="sp-instructions" full><Textarea id="sp-instructions" rows={2} maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>4. Cost</CardTitle><CardDescription>Estimated material cost with the components' Product Master Cost.</CardDescription></div></CardHeader>
          <CardContent><BomCostSummary cost={cost} output={output} outputUnit={values.base_unit} sourcePerUnit={sourceCost.complete ? sourceCost.perUnit : null} sourceLabel={src.sourceSku ? src.sourceText : 'Template'} testId="similar-cost" /></CardContent>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" asChild><Link to="/production/boms">Cancel</Link></Button>
          <Button onClick={review} disabled={!canCreate || busy} data-testid="similar-save"><PackagePlus /> Save product and draft BOM</Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !busy && setConfirming(o)}>
        <DialogContent className="sm:max-w-lg" data-testid="similar-confirm">
          <DialogHeader>
            <DialogTitle>Create {values.product_name.trim() || 'the product'}?</DialogTitle>
            <DialogDescription>One step: the product is added to the Product Master and its BOM is saved as a draft (not active). {src.sourceText} is not changed and no stock moves.</DialogDescription>
          </DialogHeader>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">SKU</dt><dd>{values.sku.trim() || 'next automatic code'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Type / unit</dt><dd>{values.product_type ? PRODUCT_TYPE_LABELS[values.product_type] : '—'} · {values.base_unit}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Components</dt><dd>{itemsFromLines(lines).length} per {output} {values.base_unit}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Cost per finished unit</dt><dd>₹{cost.perUnit.toFixed(2)}{cost.complete ? '' : ' (incomplete)'}</dd></div>
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
            <Button onClick={() => void save()} disabled={busy} data-testid="similar-confirm-save">{busy && <Loader2 className="animate-spin" />} Create product and draft BOM</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
