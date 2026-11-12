import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Layers, Loader2, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { formatQty } from '@/features/inventory/inventory-model'
import { parseUnitQty, quantityRule } from '@/features/inventory/whole-units'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { formatCost } from '@/features/products/product-list-format'
import { productToFormValues, validateProduct, type ProductFormValues } from '@/features/products/product-validation'
import { BomComponentEditor } from '@/features/production/bom-component-editor'
import { BomProductNamePicker, type PickedProduct } from '@/features/production/bom-product-name-picker'
import { linesCost, useComponentInfo } from '@/features/production/bom-component-info'
import {
  componentProblem, costDifference, filledLines, itemsFromLines, lineChanges, linesFromItems, productPayload, similarProductValues, type EditorLine,
} from '@/features/production/bom-tools-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { createSimilarProducts, generateMultipleBoms, type GeneratedBom } from '@/services/bom-tools'
import { getProduct } from '@/services/products'
import { fetchBom, fetchBoms } from '@/services/production'

interface Row {
  key: string
  /** An existing Product Master product (its SKU comes from the Product Master); null = a new product named `name`. */
  product: PickedProduct | null
  name: string
  sku: string
  description: string
  output: string
  lines: EditorLine[]
  open: boolean
}

const copyLines = (lines: EditorLine[]) => lines.map((l) => ({ ...l, key: crypto.randomUUID() }))

/**
 * /production/boms/generate?source=<bomId> — draft BOMs for several products from one base BOM, saved together. Each row is an
 * existing Product Master product (searched by name / SKU) or a new product (typed name; its SKU entered or automatic).
 */
export default function BomGeneratePage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const sourceId = params.get('source')
  const boms = useAsync(() => (sourceId ? Promise.resolve([]) : fetchBoms('ACTIVE')), [Boolean(sourceId)])
  const base = useAsync(async () => {
    if (!sourceId) return null
    const { bom, items } = await fetchBom(sourceId)
    const product = await getProduct(bom.finished_product_id)
    return { bom, values: similarProductValues(productToFormValues(product)), lines: linesFromItems(items) }
  }, [sourceId])
  const { prefs } = useErpPreferences()
  const { key, renew } = useRequestKey()
  const [rows, setRows] = useState<Row[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<(Omit<GeneratedBom, 'existing_product'> & { existing_product?: boolean })[] | null>(null)

  const newRow = (b = base.data): Row => ({ key: crypto.randomUUID(), product: null, name: '', sku: '', description: '', output: b ? String(Number(b.bom.output_quantity)) : '1', lines: copyLines(b?.lines ?? []), open: false })
  useEffect(() => {
    const b = base.data
    if (!b) return
    void Promise.resolve().then(() => { setRows([newRow(b), newRow(b)]); setCreated(null); setSubmitted(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.data])

  const allLines = useMemo(() => [...(base.data?.lines ?? []), ...rows.flatMap((r) => r.lines)], [base.data, rows])
  const info = useComponentInfo(allLines)
  const update = (k: string, patch: Partial<Row>) => { setError(null); setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r))) }
  const unit = base.data?.bom.output_unit ?? ''
  const rowName = (r: Row) => (r.product ? r.product.product_name : r.name.trim())
  // Each product once per batch; the base BOM's own product is not offered.
  const excludeFor = (rowKey: string) => {
    const m = new Map<string, string>()
    if (base.data) m.set(base.data.bom.finished_product_id, 'the base BOM\'s product')
    rows.forEach((o, j) => { if (o.key !== rowKey && o.product) m.set(o.product.product_id, `already chosen for product ${j + 1}`) })
    return m
  }
  const baseCost = base.data ? linesCost(base.data.lines, String(base.data.bom.output_quantity), info) : null

  const productOf = (r: Row): ReturnType<typeof validateProduct> =>
    validateProduct({ ...(base.data?.values as ProductFormValues), product_name: r.name, sku: r.sku, description: r.description }, { units: [unit] })
  const skuOf = (r: Row) => (r.product ? r.product.sku : r.sku).trim().toLowerCase()
  const rowProblems = (r: Row, i: number, all: Row[]): string[] => {
    const p: string[] = []
    if (!r.product) {
      const v = productOf(r)
      if (!v.input) p.push(...Object.values(v.errors))
      if (!has('products.create')) p.push('Creating a new product needs products.create: choose an existing Product Master product instead.')
    } else if (all.some((o, j) => j !== i && o.product?.product_id === r.product!.product_id)) {
      p.push(`${r.product.sku} is chosen for another row.`)
    }
    if (!parseUnitQty(r.output, unit)) p.push(`Output quantity must be greater than zero (${quantityRule(unit)}).`)
    const cp = componentProblem(r.lines)
    if (cp) p.push(cp)
    const sku = skuOf(r)
    if (sku && !r.product && all.some((o, j) => j !== i && skuOf(o) === sku)) p.push(`SKU ${r.sku.trim()} is used for another row.`)
    return p
  }

  const review = () => {
    setSubmitted(true)
    setError(null)
    if (rows.length === 0) return setError('Add at least one new product.')
    const problems = rows.flatMap((r, i) => rowProblems(r, i, rows).map((p) => `Product ${i + 1}${rowName(r) ? ` (${rowName(r)})` : ''}: ${p}`))
    if (problems.length) return setError(problems.join(' '))
    setConfirming(true)
  }

  const save = async () => {
    if (!sourceId) return
    setBusy(true)
    setError(null)
    try {
      const bomOf = (row: Row) => ({ bom: { output_quantity: parseUnitQty(row.output, unit)! }, items: itemsFromLines(row.lines) })
      // Only new products: the existing function (works on databases without 20261207090000). Any existing
      // product: the combined function, still one transaction.
      const r = rows.every((row) => !row.product)
        ? await createSimilarProducts({ bom_id: sourceId }, rows.map((row) => ({ product: productPayload(productOf(row).input!), ...bomOf(row) })), key)
        : await generateMultipleBoms(sourceId, rows.map((row) => (row.product
          ? { product_id: row.product.product_id, ...bomOf(row) }
          : { product: productPayload(productOf(row).input!), ...bomOf(row) })), key)
      renew()
      setCreated(r.products)
      setConfirming(false)
    } catch (e) {
      const code = (e as { code?: string } | null)?.code
      setError(code === 'PGRST202' || /bom_generate_multiple/.test(String((e as { message?: string } | null)?.message ?? ''))
        ? 'This database cannot yet generate BOMs for existing products (migration 20261207090000 is not applied). Nothing was saved. Use new product names only, or apply the migration.'
        : describeDataError(e))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Generate multiple' }]
  const header = <PageHeader title="Generate multiple BOMs" breadcrumbs={crumbs}
    description="Draft BOMs for several products from one base BOM. Choose existing Product Master products (or type a new product name); each row gets its own copy of the components to change. Nothing is activated."
    actions={<Button variant="outline" asChild><Link to="/production/boms"><ArrowLeft /> All BOMs</Link></Button>} />

  if (!sourceId) {
    return (
      <>
        {header}
        <Card className="max-w-2xl">
          <CardHeader><div><CardTitle>Base BOM</CardTitle><CardDescription>The BOM whose components each new product starts from.</CardDescription></div></CardHeader>
          <CardContent>
            <Label htmlFor="gen-base">Base BOM</Label>
            <Select onValueChange={(v) => setParams({ source: v })}>
              <SelectTrigger id="gen-base" className="mt-1.5 w-full"><SelectValue placeholder={boms.loading ? 'Loading…' : 'Select a BOM'} /></SelectTrigger>
              <SelectContent>{(boms.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.bom_code} v{b.version} — {b.sku} {b.product_name}</SelectItem>)}</SelectContent>
            </Select>
          </CardContent>
        </Card>
      </>
    )
  }
  if (base.loading && !base.data) return (<>{header}<LoadingState variant="cards" rows={3} /></>)
  if (base.error || !base.data) return (<>{header}<Card><ErrorState message={describeDataError(base.error)} onRetry={base.reload} /></Card></>)
  const b = base.data.bom

  if (created) {
    return (
      <>
        {header}
        <Card className="max-w-3xl" data-testid="gen-result">
          <CardHeader><div><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-5 text-green-700" /> {created.length} draft BOMs created</CardTitle>
            <CardDescription>Each BOM is a draft: review and activate them one by one. {b.bom_code} v{b.version} is unchanged.</CardDescription></div></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {created.map((c) => (
                <li key={c.bom_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><span className="font-medium">{c.sku}</span> — {c.product_name}<span className="text-xs text-muted-foreground">{c.existing_product ? ' (existing product)' : ' (new product)'}</span></span>
                  <span className="flex gap-3"><Link className="text-primary hover:underline" to={`/production/boms/${c.bom_id}`}>{c.bom_code} v{c.version} (draft)</Link>
                    <Link className="text-primary hover:underline" to={`/products/${c.product_id}`}>Product</Link></span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </>
    )
  }

  const canCreate = has('production_bom.create')
  return (
    <>
      {header}
      <p className="mb-4 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm">
        Base: <span className="font-medium">{b.bom_code} v{b.version} — {b.sku} {b.product_name}</span> ({base.data.lines.length} components per {formatQty(b.output_quantity, b.output_unit)},
        {' '}{baseCost && !baseCost.none ? `${formatCost(baseCost.perUnit)} per unit${baseCost.complete ? '' : ' (incomplete)'}` : 'no component cost'}). Existing products are not changed; new products copy its Product Master fields except SKU, barcode, EAN, image and Cost.{' '}
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => setParams({})}>Choose another base</button>
      </p>
      {!canCreate && <p role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">Generating BOMs needs production_bom.create.</p>}
      {error && <p role="alert" data-testid="gen-error" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      <Card className="mb-6">
        <CardHeader><div><CardTitle>Products</CardTitle><CardDescription>Click Product name to search the Product Master by name or SKU (the SKU is filled in), or type a new product name. Open a row to change its components and output quantity.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3">
          {rows.map((r, i) => {
            const n = i + 1
            const cost = linesCost(r.lines, r.output, info)
            const diff = costDifference(cost.perUnit, baseCost?.perUnit ?? null)
            const ch = lineChanges(base.data!.lines, r.lines)
            const problems = submitted ? rowProblems(r, i, rows) : []
            return (
              <div key={r.key} className={cn('rounded-lg border p-3', problems.length && 'border-red-300')} data-testid={`gen-row-${n}`}>
                <div className="grid gap-3 sm:grid-cols-[2rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_7rem_auto] sm:items-end">
                  <span className="text-sm font-medium text-muted-foreground sm:pb-2">{n}</span>
                  <div className="space-y-1"><Label htmlFor={`gen-name-${n}`}>Product name</Label>
                    <BomProductNamePicker id={`gen-name-${n}`} label={`Product name ${n}`} name={r.name} product={r.product} exclude={excludeFor(r.key)}
                      onName={(name) => update(r.key, { name })}
                      // The row keeps its component lines; the SKU comes from the Product Master (a typed SKU is dropped).
                      onProduct={(product) => update(r.key, product ? { product, name: '', sku: '', description: '' } : { product: null })} /></div>
                  <div className="space-y-1"><Label htmlFor={`gen-sku-${n}`}>SKU</Label>
                    {r.product
                      ? <Input id={`gen-sku-${n}`} value={r.product.sku} readOnly aria-readonly title="From the Product Master" className="bg-surface-muted/50" />
                      : <Input id={`gen-sku-${n}`} maxLength={60} placeholder="Automatic" value={r.sku} onChange={(e) => update(r.key, { sku: e.target.value })} />}</div>
                  <div className="space-y-1"><Label htmlFor={`gen-desc-${n}`}>Description</Label>
                    <Input id={`gen-desc-${n}`} maxLength={2000} value={r.product ? '' : r.description} disabled={Boolean(r.product)}
                      placeholder={r.product ? 'Existing product: not changed' : undefined} onChange={(e) => update(r.key, { description: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={`gen-output-${n}`}>Output ({unit})</Label><Input id={`gen-output-${n}`} inputMode="decimal" value={r.output} onChange={(e) => update(r.key, { output: e.target.value })} /></div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove product ${n}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /></Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <button type="button" className="flex items-center gap-1 font-medium text-primary" aria-expanded={r.open} data-testid={`gen-edit-${n}`} onClick={() => update(r.key, { open: !r.open })}>
                    {r.open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Components ({filledLines(r.lines).length})
                  </button>
                  <span className="text-muted-foreground" data-testid={`gen-summary-${n}`}>
                    {[ch.added.length && `+${ch.added.length} added`, ch.removed.length && `${ch.removed.length} removed`, ch.changed.length && `${ch.changed.length} changed`].filter(Boolean).join(', ') || 'same components as the base'}
                    {' · '}{cost.none ? 'no component cost' : `${formatCost(cost.perUnit)} per unit${cost.complete ? '' : ' (incomplete)'}`}
                    {cost.complete && baseCost?.complete && diff.amount ? ` (${diff.amount > 0 ? '+' : '−'}${formatCost(Math.abs(diff.amount))})` : ''}
                  </span>
                </div>
                {r.open && (
                  <div className="mt-3">
                    <BomComponentEditor lines={r.lines} onChange={(ls) => update(r.key, { lines: ls })} output={r.output} outputUnit={unit} idPrefix={`gen${n}`} info={info}
                      outputProductId={r.product?.product_id ?? null}
                      defaultWastage={String(prefs?.['production.default_wastage_percent'] ?? 0)} />
                  </div>
                )}
                {problems.length > 0 && <p className="mt-2 text-xs text-shortage">{problems.join(' ')}</p>}
              </div>
            )
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, newRow()])} disabled={rows.length >= 50} data-testid="gen-add"><Plus /> Add product</Button>
        </CardContent>
      </Card>

      <Card className="mb-6" data-testid="gen-preview">
        <CardHeader><div><CardTitle>Preview</CardTitle><CardDescription>The draft BOM each product will get.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {rows.map((r, i) => (
            <div key={r.key} className="rounded-md border p-3 text-sm">
              <p className="font-medium">{i + 1}. {rowName(r) || 'Unnamed'} <span className="text-muted-foreground">{r.product ? `${r.product.sku} (existing product)` : r.sku.trim() || '(automatic SKU)'}</span></p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {filledLines(r.lines).filter((l) => l.product).map((l) => <li key={l.key}>{l.product!.sku} × {l.quantity || '?'} {l.product!.base_unit}{Number(l.wastage) ? ` (+${l.wastage}% wastage)` : ''}</li>)}
              </ul>
              <p className="mt-1 text-xs">Per {r.output} {unit} · {(() => { const c = linesCost(r.lines, r.output, info); return c.none ? 'no component cost' : `${formatCost(c.perUnit)} per unit${c.complete ? '' : ' (incomplete)'}` })()}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild><Link to="/production/boms">Cancel</Link></Button>
        <Button onClick={review} disabled={!canCreate || busy || rows.length === 0} data-testid="gen-save"><Layers /> Save all as drafts ({rows.length})</Button>
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !busy && setConfirming(o)}>
        <DialogContent className="sm:max-w-lg" data-testid="gen-confirm">
          <DialogHeader>
            <DialogTitle>Generate {rows.length} draft BOMs?</DialogTitle>
            <DialogDescription>All or nothing: each existing product gets a new draft BOM and each new product is added to the Product Master with its own draft BOM. None is activated; {b.bom_code} v{b.version} and the existing products are not changed and no stock moves.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 space-y-1 overflow-y-auto text-sm">
            {rows.map((r, i) => <li key={r.key}>{i + 1}. {rowName(r)} — {r.product ? `${r.product.sku} (existing)` : r.sku.trim() || 'automatic SKU'} · {itemsFromLines(r.lines).length} components</li>)}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
            <Button onClick={() => void save()} disabled={busy} data-testid="gen-confirm-save">{busy && <Loader2 className="animate-spin" />} Generate {rows.length} BOMs</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
