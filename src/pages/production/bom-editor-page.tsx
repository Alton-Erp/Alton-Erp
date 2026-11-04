import { ArrowLeft, CopyPlus, History, Loader2, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { BOM_SOURCES, BOM_SOURCE_LABELS, PRODUCT_TYPE_LABELS, defaultBomSource, type BomSource } from '@/features/products/product-model'
import { planningChanges, planningValuesFrom, validatePlanning, type BomPlanningValues } from '@/features/production/bom-planning-model'
import { fetchGroupHeadOptions, getProduct, updateProduct } from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { BomComponentPicker } from '@/features/production/bom-component-picker'
import type { BomComponentOption } from '@/services/bom-components'
import { cn } from '@/lib/utils'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { BomStatusBadge } from '@/features/production/production-badges'
import { validateBomLine } from '@/features/production/production-model'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError, describeProductError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import type { ProductOption } from '@/services/inventory'
import { activateBom, bomAction, fetchBom, newBomVersion, saveAndActivateBom, saveBom, saveBomVersionDetails } from '@/services/production'
import { DraftVersionNotice } from '@/components/common/draft-version-notice'
import { bomRequirement, isFractionalForUnit, isWholeUnit, parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'

// Each component line: (1) product, (2) SKU, (3) qty per output on the first row;
// (4) source, (5) preferred supplier, (6) wastage % on the second; remarks and the
// calculated requirement below. Stacks on small screens; never scrolls sideways.
const ROW_A = 'sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(6rem,9rem)_9.5rem_2rem]'
const ROW_B = 'sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)_6rem_2rem]'

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-muted-foreground">{children}</span>
}

/**
 * What one line means for one BOM batch: quantity + wastage, and for
 * whole-piece units (PCS, NOS, SET, PAIR) the whole pieces planning will use.
 */
function lineCalc(l: Line, output: string, outputUnit: string | undefined): { text: string; error?: boolean } | null {
  if (!l.product || l.quantity.trim() === '') return null
  const problem = validateBomLine({ ...l, unit: l.product.base_unit })
  if (problem) return { text: problem, error: true }
  const out = parseUnitQty(output, outputUnit)
  if (!out) return null
  const r = bomRequirement(Number(l.quantity), out, out, Number(l.wastage || 0), l.product.base_unit)
  const unit = l.product.base_unit
  const base = `Per ${formatQty(out, outputUnit)} output: ${formatQty(r.theoretical, unit)}`
  const withWastage = Math.round((r.theoretical + r.wastage) * 1000) / 1000
  const rounded = isWholeUnit(unit) && r.planned > withWastage ? ` → planned ${formatQty(r.planned, unit)} (rounded up to whole pieces)` : ''
  if (r.wastage > 0) return { text: `${base} + ${formatQty(r.wastage)} wastage = ${formatQty(withWastage, unit)}${rounded}` }
  return { text: `${base}${rounded}` }
}

interface Line {
  key: string
  product: ProductOption | BomComponentOption | null
  quantity: string
  wastage: string
  notes: string
  /** '' = default from the component's product master. */
  source: BomSource | ''
  /** '' = the component's preferred supplier. */
  supplierId: string
}

// New lines start with the default wastage % from ERP Settings → Production.
const blankLine = (wastage = '0'): Line => ({ key: crypto.randomUUID(), product: null, quantity: '', wastage, notes: '', source: '', supplierId: '' })

export default function BomEditorPage() {
  const { bomId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const loaded = useAsync(() => (bomId ? fetchBom(bomId) : Promise.resolve(null)), [bomId, refresh])
  const suppliers = useAsync(() => fetchSupplierOptions(true).catch(() => []), [])
  const [searchParams] = useSearchParams()
  const presetProductId = bomId ? null : searchParams.get('product')
  const preset = useAsync(() => (presetProductId ? getProduct(presetProductId).catch(() => null) : Promise.resolve(null)), [presetProductId])
  const { key, renew } = useRequestKey()

  const [product, setProduct] = useState<ProductOption | null>(null)
  const [from, setFrom] = useState(() => toIsoDate(new Date()))
  const [to, setTo] = useState('')
  const [output, setOutput] = useState('1')
  const [notes, setNotes] = useState('')
  // Version control: why this version exists and how it is made (kept with the version once approved).
  const [changeReason, setChangeReason] = useState('')
  const [instructions, setInstructions] = useState('')
  const { prefs } = useErpPreferences()
  const defaultWastage = String(prefs?.['production.default_wastage_percent'] ?? 0)
  const [lines, setLines] = useState<Line[]>(() => [blankLine(defaultWastage)])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)

  // Product Planning & Classification: the finished product's own values (Product Master).
  const [planningRefresh, setPlanningRefresh] = useState(0)
  const productInfo = useAsync(() => (product ? getProduct(product.product_id) : Promise.resolve(null)), [product?.product_id, planningRefresh])
  const groupHeads = useAsync(() => fetchGroupHeadOptions().catch(() => [] as string[]), [])
  const [planning, setPlanning] = useState<BomPlanningValues>(() => planningValuesFrom(null))
  const [planningErrors, setPlanningErrors] = useState<Partial<Record<keyof BomPlanningValues, string>>>({})
  const [planningMessage, setPlanningMessage] = useState<string | null>(null)
  const [planningBusy, setPlanningBusy] = useState(false)
  const canEditPlanning = has('products.update') && Boolean(productInfo.data)
  const pendingPlanning = productInfo.data ? planningChanges(productInfo.data, validatePlanning(planning).patch) : { patch: {}, changes: [] }

  // Autofill from the Product Master whenever the selected product (or its stored values) changes.
  useEffect(() => {
    const p = productInfo.data
    void Promise.resolve().then(() => { setPlanning(planningValuesFrom(p)); setPlanningErrors({}) })
  }, [productInfo.data])

  /** Saves the changed planning fields on the product. Returns false when they are invalid or the save failed. */
  const savePlanning = async (): Promise<boolean> => {
    if (!productInfo.data) return true
    const { errors } = validatePlanning(planning)
    setPlanningErrors(errors)
    if (Object.keys(errors).length > 0) return false
    if (pendingPlanning.changes.length === 0) return true
    setPlanningBusy(true)
    try {
      await updateProduct(productInfo.data.id, { ...pendingPlanning.patch, change_reason: 'Planning fields changed from the bill of materials' })
      setPlanningMessage(`Saved on ${productInfo.data.sku}: ${pendingPlanning.changes.map((c) => `${c.label} ${c.to}`).join(', ')}.`)
      setPlanningRefresh((n) => n + 1)
      return true
    } catch (e) {
      setPlanningMessage(null)
      setError(`Planning fields not saved: ${describeProductError(e)}`)
      return false
    } finally {
      setPlanningBusy(false)
    }
  }

  const bom = loaded.data?.bom
  const editableStatus = !bom || bom.status === 'DRAFT' || bom.status === 'REJECTED'
  const canEdit = editableStatus && (bom ? has('production_bom.update') || (has('production_bom.create') && bom.created_by === user?.id) : has('production_bom.create'))
  // No approval queue: users who may activate BOMs (existing production_bom.approve) save and activate in one step;
  // a change to the active version becomes the next version, and the active one is kept unchanged.
  const canActivate = has('production_bom.approve')
  const revising = Boolean(bom && bom.status === 'APPROVED' && canActivate && has('production_bom.create'))
  const editable = canEdit || revising

  // Load the stored BOM into the form once per fetch.
  const [formLoaded, setFormLoaded] = useState<string | null>(null)
  useEffect(() => {
    const data = loaded.data
    if (!data) return
    void Promise.resolve().then(() => {
      setFormLoaded(`${data.bom.id}:${data.bom.updated_at}`)
      setProduct({ product_id: data.bom.finished_product_id, sku: data.bom.sku, product_name: data.bom.product_name, base_unit: data.bom.output_unit, track_batches: false, track_expiry: false })
      setFrom(data.bom.effective_from)
      setTo(data.bom.effective_to ?? '')
      setOutput(String(data.bom.output_quantity))
      setNotes(data.bom.notes ?? '')
      const details = data.bom as unknown as { change_reason?: string | null; process_instructions?: string | null }
      setChangeReason(details.change_reason ?? '')
      setInstructions(details.process_instructions ?? '')
      setLines(
        data.items.map((i) => ({
          key: i.id,
          product: { product_id: i.component_product_id, sku: i.sku, product_name: i.product_name, base_unit: i.inventory_unit, track_batches: false, track_expiry: false },
          quantity: String(i.quantity_required),
          wastage: String(i.wastage_percentage),
          notes: i.notes ?? '',
          source: i.source_type ?? '',
          supplierId: i.preferred_supplier_id ?? '',
        })),
      )
    })
  }, [loaded.data])

  // "Create BOM" from a product page: start with that product selected.
  useEffect(() => {
    const p = preset.data
    if (!p) return
    void Promise.resolve().then(() =>
      setProduct((cur) => cur ?? { product_id: p.id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: p.track_batches, track_expiry: p.track_expiry }))
  }, [preset.data])

  // Auto-saved working copy of the header and components (the planning fields are the product's own values and are saved with it).
  const draft = usePersistentFormDraft({
    formKey: 'bom.editor', recordId: bom?.id ?? null, baseVersion: bom?.updated_at ?? null,
    scope: bom ? '' : presetProductId ? `product:${presetProductId}` : '',
    enabled: editable && (!bomId || (bom !== undefined && formLoaded === `${bom.id}:${bom.updated_at}`)),
    value: { product, from, to, output, notes, changeReason, instructions, lines: lines.map(({ key: _key, ...l }) => l) },
    onRestore: (d) => {
      if (!bom) setProduct(d.product)
      setFrom(d.from)
      setTo(d.to)
      setOutput(d.output)
      setNotes(d.notes)
      setChangeReason(d.changeReason ?? '')
      setInstructions(d.instructions ?? '')
      setLines(d.lines.length ? d.lines.map((l) => ({ ...l, key: crypto.randomUUID() })) : [blankLine(defaultWastage)])
    },
  })

  const updateLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)))

  const save = async (activate = false) => {
    setError(null)
    setMessage(null)
    if (revising && changeReason.trim().length < 3) return setError('Enter the reason for this change: saving creates and activates a new version, and the reason is kept with it.')
    if (!product) return setError('Select the finished product (or sub-assembly) this BOM produces.')
    const out = parseUnitQty(output, product.base_unit)
    if (!out) return setError(`Output quantity must be greater than zero (${quantityRule(product.base_unit)}).`)
    if (!from) return setError('Enter the effective-from date.')
    if (to && to < from) return setError('The effective-to date cannot be before the effective-from date.')
    // A draft may be saved without components; they can be added later.
    const filled = lines.filter((l) => l.product || l.quantity.trim())
    const seen = new Set<string>()
    for (const [i, l] of filled.entries()) {
      if (!l.product) return setError(`Line ${i + 1}: select the component.`)
      if (l.product.product_id === product.product_id) return setError(`Line ${i + 1}: a product cannot be a component of itself.`)
      if (seen.has(l.product.product_id)) return setError(`Line ${i + 1}: ${l.product.sku} is listed more than once. Combine the quantities on one line.`)
      seen.add(l.product.product_id)
      const problem = validateBomLine({ ...l, unit: l.product.base_unit })
      if (problem) return setError(`Line ${i + 1}: ${problem}`)
    }
    if (canEditPlanning && Object.keys(validatePlanning(planning).errors).length > 0) {
      setPlanningErrors(validatePlanning(planning).errors)
      return setError('Correct the Product Planning & Classification fields.')
    }
    setBusy(true)
    try {
      // Planning fields are saved on the product first (they do not depend on the BOM version).
      if (canEditPlanning && pendingPlanning.changes.length > 0 && !(await savePlanning())) return
      const input = {
          finishedProductId: product.product_id,
          effectiveFrom: from,
          effectiveTo: to || null,
          outputQuantity: out,
          notes: notes.trim() || null,
          items: filled.map((l) => ({
            component_product_id: l.product!.product_id,
            quantity_required: Number(l.quantity),
            unit: l.product!.base_unit,
            wastage_percentage: Number(l.wastage || 0),
            notes: l.notes.trim() || null,
            source_type: l.source || null,
            preferred_supplier_id: l.supplierId || null,
          })),
        }
      if (activate || revising) {
        const r = await saveAndActivateBom({ ...input, bomId: bom?.id ?? null }, key, changeReason.trim() || null, instructions.trim() || null)
        renew()
        void draft.markSubmitted()
        const replaced = [...(r.superseded_versions ?? []), ...(r.closed_versions ?? [])]
        setMessage(`${r.bom_code} v${r.version} saved and activated: new production orders use it now.${replaced.length ? ` Superseded: ${replaced.join(', ')} (kept unchanged for history).` : ''}`)
        if (r.bom_id !== bom?.id) navigate(`/production/boms/${r.bom_id}`, { replace: !bom })
        else setRefresh((n) => n + 1)
        return
      }
      const result = await saveBom({ ...input, bomId: bom?.id ?? null }, key)
      renew()
      void draft.markSubmitted()
      if (changeReason.trim() || instructions.trim() || bom) {
        try {
          await saveBomVersionDetails(result.bom_id, changeReason.trim() || null, instructions.trim() || null)
        } catch (e) {
          setError(`The BOM was saved, but the reason / process instructions were not: ${describeDataError(e)}`)
        }
      }
      if (!bom) navigate(`/production/boms/${result.bom_id}`, { replace: true })
      else {
        setMessage(filled.length === 0
          ? `Saved ${result.bom_code} v${result.version} as a draft without components. Add them before activating.`
          : `Saved ${result.bom_code} v${result.version}.`)
        setRefresh((n) => n + 1)
      }
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const runAction = (kind: 'ACTIVATE' | 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'ARCHIVE') => {
    if (!bom) return
    const texts = {
      ACTIVATE: { title: `Activate ${bom.bom_code} v${bom.version}`, confirm: 'Activate', note: 'optional' as const, desc: 'The BOM is checked (active components, units, no circular references) and becomes the version used for production. To change it later, use "Edit components", which starts a new version. An earlier active version is closed the day before this one starts, or replaced (archived) if it started on the same day or later. Production orders already created keep their version.' },
      SUBMIT: { title: 'Submit BOM for approval', confirm: 'Submit', note: 'none' as const, desc: 'The BOM is validated again (active components, units, no circular references). It cannot be edited while awaiting approval.' },
      WITHDRAW: { title: 'Withdraw from approval', confirm: 'Withdraw', note: 'none' as const, desc: 'The BOM returns to draft so it can be edited.' },
      APPROVE: { title: `Approve ${bom.bom_code} v${bom.version}`, confirm: 'Approve', note: 'optional' as const, desc: 'An approved BOM can no longer be changed (changes need a new version). If an earlier approved version overlaps, it is closed the day before this one starts. Existing production orders keep their version.' },
      REJECT: { title: 'Reject BOM', confirm: 'Reject', note: 'required' as const, desc: 'The requester can edit and resubmit it.' },
      ARCHIVE: { title: 'Archive BOM version', confirm: 'Archive', note: 'optional' as const, desc: 'Archived versions cannot be used for new orders. Orders already using this version are unaffected.' },
    }[kind]
    setAction({
      title: texts.title,
      description: texts.desc,
      confirmLabel: texts.confirm,
      note: texts.note,
      destructive: kind === 'REJECT' || kind === 'ARCHIVE',
      run: async (note) => {
        const r: { status: string; closed_versions: string[]; superseded_versions?: string[] } =
          kind === 'ACTIVATE' ? await activateBom(bom.id, note) : await bomAction(bom.id, kind, note)
        const replaced = r.superseded_versions?.length ? `; replaced ${r.superseded_versions.join(', ')}` : ''
        const status = kind === 'ACTIVATE' ? 'active' : r.status.replace('_', ' ').toLowerCase()
        return `${bom.bom_code} v${bom.version}: ${status}${r.closed_versions.length ? ` (closed ${r.closed_versions.join(', ')})` : ''}${replaced}.`
      },
    })
  }

  const createVersion = async () => {
    if (!bom) return
    setBusy(true)
    setError(null)
    try {
      const r = await newBomVersion(bom.id, key)
      renew()
      navigate(`/production/boms/${r.bom_id}`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  if (bomId && loaded.loading && !loaded.data) return (<><PageHeader title="Bill of materials" /><LoadingState variant="cards" rows={3} /></>)
  if (bomId && (loaded.error || !loaded.data)) {
    return (<><PageHeader title="Bill of materials" /><Card><ErrorState message={describeDataError(loaded.error)} onRetry={loaded.reload} /></Card></>)
  }

  // Stored quantities of whole-piece items that are fractions (BOMs saved before the whole-piece rule).
  const fractional = [
    ...(bom && isFractionalForUnit(bom.output_quantity, bom.output_unit) ? [`output ${bom.output_quantity} ${bom.output_unit}`] : []),
    ...(loaded.data?.items ?? [])
      .filter((i) => isWholeUnit(i.unit) && isFractionalForUnit(i.quantity_required, i.unit))
      .map((i) => `line ${i.line_no} ${i.sku} ${i.quantity_required} ${i.unit}`),
  ]
  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: bom ? `${bom.bom_code} v${bom.version}` : 'New' }]

  return (
    <>
      <PageHeader
        title={bom ? `${bom.bom_code} v${bom.version}` : 'New bill of materials'}
        description={bom ? `${bom.sku} — ${bom.product_name}` : 'Components needed for the output quantity of one finished product or sub-assembly.'}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/production/boms"><ArrowLeft /> All BOMs</Link></Button>
            {bom && <Button variant="outline" asChild><Link to={`/production/boms/${bom.id}/versions`}><History /> Versions &amp; compare</Link></Button>}
            {bom && has('production_bom.create') && (
              <Button variant={bom.status === 'APPROVED' ? 'default' : 'outline'} disabled={busy} onClick={() => void createVersion()}>
                {bom.status === 'APPROVED' ? <><Pencil /> Edit components</> : <><CopyPlus /> New version</>}
              </Button>
            )}
            {bom && bom.status === 'APPROVED' && has('production_plan.create') && (
              <Button asChild><Link to={`/production/planning?bom=${bom.id}`}>Plan production</Link></Button>
            )}
          </>
        }
      />
      <FormDraftBar draft={draft} />
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {bom && (bom.status === 'DRAFT' || bom.status === 'REJECTED') && <DraftVersionNotice kind="BOM" id={bom.id} onRefreshed={() => setRefresh((n) => n + 1)} />}
      {message &&<p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {fractional.length > 0 && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          Needs correction: {fractional.join('; ')} {fractional.length === 1 ? 'is' : 'are'} not whole pieces.{' '}
          {editableStatus
            ? 'Correct the quantities (whole pieces per batch) before submitting.'
            : 'Create a new version with whole pieces per batch. Until then, planning rounds requirements up to whole pieces.'}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Header</CardTitle>
                <CardDescription>Output product, quantity and effective period.</CardDescription>
              </div>
              {bom && <BomStatusBadge status={bom.status} />}
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bom-product">Finished product / sub-assembly</Label>
                {bom ? (
                  <p className="flex h-9 items-center rounded-md border bg-surface-muted/50 px-3 text-sm">{bom.sku} — {bom.product_name}</p>
                ) : (
                  <ProductPicker id="bom-product" value={product} onChange={setProduct} />
                )}
                <p className="text-xs text-muted-foreground">Finished goods, subassemblies, components and outsourced components can have a BOM (raw materials, packing material and consumables cannot). The output product of an existing BOM cannot change.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bom-output">Output quantity{product ? ` (${product.base_unit})` : ''}</Label>
                <Input id="bom-output" inputMode={qtyInputMode(product?.base_unit)} value={output} onChange={(e) => setOutput(e.target.value)} disabled={!editable} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label htmlFor="bom-from">Effective from</Label><Input id="bom-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!editable} /></div>
                <div className="space-y-1.5"><Label htmlFor="bom-to">Effective to (optional)</Label><Input id="bom-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} disabled={!editable} /></div>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bom-notes">Notes</Label>
                <Textarea id="bom-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bom-change-reason">Reason for this version</Label>
                <Input id="bom-change-reason" maxLength={500} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} disabled={!editable}
                  placeholder={canEdit ? 'e.g. Three-bowl design; tap quantity changed' : undefined} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bom-instructions">Process instructions</Label>
                <Textarea id="bom-instructions" rows={2} maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={!editable} />
                {!editable && bom && <p className="text-xs text-muted-foreground">This version is fixed. Changes create a new version.</p>}
              </div>
              {bom?.review_note && <p className="text-sm sm:col-span-2"><span className="font-medium">Review note:</span> {bom.review_note}</p>}
            </CardContent>
          </Card>

          <Card data-testid="bom-planning">
            <CardHeader>
              <div>
                <CardTitle>Product Planning &amp; Classification</CardTitle>
                <CardDescription>The finished product's values in the Product Master, shared by all versions of this BOM. Changes here update the product.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {!product ? (
                <p className="text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">Select the finished product to load its planning details.</p>
              ) : productInfo.error ? (
                <p className="text-sm text-red-800 sm:col-span-2 xl:col-span-3">Product details could not be loaded: {describeDataError(productInfo.error)}</p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>Product Name</Label>
                    <p className="flex h-9 items-center truncate rounded-md border bg-surface-muted/50 px-3 text-sm">
                      <Link to={`/products/${product.product_id}`} className="truncate text-primary hover:underline">{productInfo.data?.product_name ?? product.product_name}</Link>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Product Type</Label>
                    <p className="flex h-9 items-center rounded-md border bg-surface-muted/50 px-3 text-sm" data-testid="bom-product-type">
                      {productInfo.data ? PRODUCT_TYPE_LABELS[productInfo.data.product_type] : '…'}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bom-tax">Tax Rate (%)</Label>
                    <Input id="bom-tax" inputMode="decimal" value={planning.taxRate} disabled={!canEditPlanning} aria-invalid={Boolean(planningErrors.taxRate)}
                      onChange={(e) => setPlanning((p) => ({ ...p, taxRate: e.target.value }))} />
                    {planningErrors.taxRate && <p className="text-xs text-shortage">{planningErrors.taxRate}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bom-lead">Lead Time (Days)</Label>
                    <Input id="bom-lead" inputMode="decimal" value={planning.leadTimeDays} disabled={!canEditPlanning} aria-invalid={Boolean(planningErrors.leadTimeDays)}
                      onChange={(e) => setPlanning((p) => ({ ...p, leadTimeDays: e.target.value }))} />
                    {planningErrors.leadTimeDays && <p className="text-xs text-shortage">{planningErrors.leadTimeDays}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bom-group">Group Head</Label>
                    <Input id="bom-group" list="bom-group-list" maxLength={100} autoComplete="off" value={planning.groupHead} disabled={!canEditPlanning} aria-invalid={Boolean(planningErrors.groupHead)}
                      onChange={(e) => setPlanning((p) => ({ ...p, groupHead: e.target.value }))} />
                    <datalist id="bom-group-list">{(groupHeads.data ?? []).map((g) => <option key={g} value={g} />)}</datalist>
                    {planningErrors.groupHead && <p className="text-xs text-shortage">{planningErrors.groupHead}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bom-minstock">Minimum Stock Days</Label>
                    <Input id="bom-minstock" inputMode="decimal" value={planning.minimumCoverDays} disabled={!canEditPlanning} aria-invalid={Boolean(planningErrors.minimumCoverDays)}
                      onChange={(e) => setPlanning((p) => ({ ...p, minimumCoverDays: e.target.value }))} />
                    {planningErrors.minimumCoverDays && <p className="text-xs text-shortage">{planningErrors.minimumCoverDays}</p>}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2 xl:col-span-3">
                    <p className="text-xs text-muted-foreground">
                      {!has('products.update')
                        ? 'Changing these fields needs permission to edit the Product Master.'
                        : planningMessage ?? (pendingPlanning.changes.length > 0 ? `Unsaved: ${pendingPlanning.changes.map((c) => c.label).join(', ')}.` : 'Product type is changed in the Product Master. Minimum stock days are for reference and do not change stock calculations.')}
                    </p>
                    {canEditPlanning && (
                      <Button variant="outline" size="sm" disabled={planningBusy || pendingPlanning.changes.length === 0} onClick={() => void savePlanning()}>
                        {planningBusy && <Loader2 className="animate-spin" />} Save planning details
                      </Button>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Components</CardTitle>
                <CardDescription>
                  Quantity per {output || '…'} {product?.base_unit ?? 'unit(s)'} of output, in each component's inventory unit (no unit conversion is configured). Wastage is added on top when planning. Items counted in pieces (PCS, NOS, SET, PAIR) need whole pieces per batch: for a part shared by several units (e.g. 1 washer per 2 units) set the output quantity to 2 and the component quantity to 1. Planning rounds the requirement up to whole pieces.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ol className="divide-y border-t">
                {lines.map((l, i) => {
                  const n = i + 1
                  const unit = l.product?.base_unit
                  const exclude = new Map<string, string>()
                  if (product) exclude.set(product.product_id, 'the BOM output product cannot be its own component')
                  lines.forEach((o, j) => { if (o.key !== l.key && o.product) exclude.set(o.product.product_id, `already on line ${j + 1}`) })
                  const option = l.product && 'default_source_type' in l.product ? (l.product as BomComponentOption) : null
                  const supplierName = (sid: string | null | undefined) => {
                    const s = (suppliers.data ?? []).find((x) => x.id === sid)
                    return s ? s.display_name ?? s.legal_name : null
                  }
                  const defaultSource = option ? BOM_SOURCE_LABELS[defaultBomSource(option)] : null
                  const defaultSupplier = option ? supplierName(option.preferred_supplier_id) : null
                  const calc = lineCalc(l, output, product?.base_unit)
                  return (
                    <li key={l.key} className="space-y-2 py-3">
                      <div className={cn('grid gap-2 sm:items-start', ROW_A)}>
                        <span className="text-sm font-medium text-muted-foreground sm:pt-6"><span className="sm:hidden">Line </span>{n}</span>
                        <div className="min-w-0">
                          <FieldLabel>Component product</FieldLabel>
                          {editable
                            ? <BomComponentPicker label={`Component line ${n}`} value={l.product} exclude={exclude}
                                onChange={(p) => updateLine(l.key, { product: p, ...(p ? {} : { source: '', supplierId: '' }) })} />
                            : <p className="pt-2 text-sm">{l.product?.product_name ?? '—'}</p>}
                        </div>
                        <div className="min-w-0">
                          <FieldLabel>SKU</FieldLabel>
                          <p className="flex h-9 items-center truncate rounded-md border bg-surface-muted/50 px-3 text-sm font-medium" title={l.product?.sku}>{l.product?.sku ?? '—'}</p>
                        </div>
                        <div>
                          <FieldLabel>Qty per output</FieldLabel>
                          <div className="flex items-center gap-1.5">
                            <Input aria-label={`Quantity line ${n}`} inputMode={qtyInputMode(unit)} className="text-right" value={l.quantity}
                              onChange={(e) => updateLine(l.key, { quantity: e.target.value })} disabled={!editable} />
                            <span className="w-9 shrink-0 text-xs text-muted-foreground">{unit ?? ''}</span>
                          </div>
                        </div>
                        <div className="flex justify-end sm:pt-6">
                          {editable && (
                            <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${n}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine(defaultWastage)]))}><Trash2 /></Button>
                          )}
                        </div>
                      </div>
                      <div className={cn('grid gap-2 sm:items-start', ROW_B)}>
                        <span className="hidden sm:block" />
                        <div className="min-w-0">
                          <FieldLabel>Source</FieldLabel>
                          <Select value={l.source || 'default'} onValueChange={(v) => updateLine(l.key, { source: v === 'default' ? '' : (v as BomSource) })} disabled={!editable}>
                            <SelectTrigger aria-label={`Source line ${n}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">From product{defaultSource ? ` (${defaultSource})` : ''}</SelectItem>
                              {BOM_SOURCES.map((s) => <SelectItem key={s} value={s}>{BOM_SOURCE_LABELS[s]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="min-w-0">
                          <FieldLabel>Preferred supplier</FieldLabel>
                          <Select value={l.supplierId || 'default'} onValueChange={(v) => updateLine(l.key, { supplierId: v === 'default' ? '' : v })} disabled={!editable}>
                            <SelectTrigger aria-label={`Supplier line ${n}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">From product{defaultSupplier ? ` (${defaultSupplier})` : ''}</SelectItem>
                              {(suppliers.data ?? []).filter((s) => s.status === 'ACTIVE' || s.id === l.supplierId).map((s) => (
                                <SelectItem key={s.id} value={s.id}>{s.supplier_code} — {s.display_name ?? s.legal_name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <FieldLabel>Wastage %</FieldLabel>
                          <Input aria-label={`Wastage line ${n}`} inputMode="decimal" className="text-right" value={l.wastage} onChange={(e) => updateLine(l.key, { wastage: e.target.value })} disabled={!editable} />
                        </div>
                        <span className="hidden sm:block" />
                      </div>
                      <div className={cn('grid gap-2 sm:items-center', ROW_B)}>
                        <span className="hidden sm:block" />
                        <Input aria-label={`Notes line ${n}`} placeholder="Remarks (optional)" maxLength={500} value={l.notes} onChange={(e) => updateLine(l.key, { notes: e.target.value })} disabled={!editable} className="h-8 text-xs" />
                        <p className={cn('text-xs sm:col-span-3', calc?.error ? 'text-shortage' : 'text-muted-foreground')} data-testid={`bom-calc-${n}`}>{calc?.text ?? ''}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
              {editable && (
                <div className="mt-3 flex flex-wrap justify-between gap-2">
                  <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine(defaultWastage)])} disabled={lines.length >= 500}><Plus /> Add component</Button>
                  <div className="flex flex-wrap gap-2">
                    {revising ? (
                      <Button onClick={() => void save(true)} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save as new version (activates now)</Button>
                    ) : (
                      <>
                        <Button variant={canActivate ? 'outline' : 'default'} onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {bom ? 'Save draft' : 'Create draft BOM'}</Button>
                        {canActivate && <Button onClick={() => void save(true)} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save and activate</Button>}
                      </>
                    )}
                  </div>
                </div>
              )}
              {revising && (
                <p className="mt-3 text-xs text-muted-foreground" data-testid="bom-revise-note">
                  This is the active version. Your changes are saved as version {(bom?.version ?? 0) + 1}, effective today, and activated at once; version {bom?.version} is kept unchanged as Superseded. Production orders already planned keep their version.
                </p>
              )}
              {!editable && bom && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {bom.status === 'APPROVED'
                    ? 'This is the active version, so it is kept as it is for history. Use "Edit components" to add, remove or change components in a new version.'
                    : bom.status === 'ARCHIVED'
                    ? 'This version is archived and kept for history. Use "New version" to start from a copy of it.'
                    : bom.status === 'PENDING_APPROVAL' ? 'Awaiting approval: withdraw it to make changes.' : 'You can only edit your own draft BOMs.'}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {bom && loaded.data && (
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle>Workflow</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(bom.status === 'DRAFT' || bom.status === 'REJECTED') && canEdit && (has('production_bom.approve')
                  ? <Button className="w-full" onClick={() => runAction('ACTIVATE')}>Activate BOM</Button>
                  : <Button className="w-full" onClick={() => runAction('SUBMIT')}>Submit for approval</Button>)}
                {bom.status === 'PENDING_APPROVAL' && (has('production_bom.update') || bom.submitted_by === user?.id) && (
                  <Button variant="outline" className="w-full" onClick={() => runAction('WITHDRAW')}>Withdraw</Button>
                )}
                {bom.status === 'PENDING_APPROVAL' && has('production_bom.approve') && (
                  <>
                    {/* Segregation of duties is off by default in V2; if a company turns it on, the database refuses self-approval with a clear message. */}
                    <Button className="w-full" onClick={() => runAction('APPROVE')}>Approve</Button>
                    <Button variant="outline" className="w-full" onClick={() => runAction('REJECT')}>Reject</Button>
                  </>
                )}
                {bom.status !== 'ARCHIVED' && has('production_bom.update') && <Button variant="outline" className="w-full" onClick={() => runAction('ARCHIVE')}>Archive</Button>}
                <dl className="space-y-1 pt-2 text-xs text-muted-foreground">
                  <div>Created {formatDateTime(bom.created_at)}</div>
                  {bom.submitted_at && <div>Submitted {formatDateTime(bom.submitted_at)}</div>}
                  {bom.approved_at && <div>Approved {formatDateTime(bom.approved_at)}</div>}
                  {bom.archived_at && <div>Archived {formatDateTime(bom.archived_at)}</div>}
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Versions</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {loaded.data.versions.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2">
                      <Link to={`/production/boms/${v.id}`} className={v.id === bom.id ? 'font-semibold' : 'text-primary underline-offset-2 hover:underline'}>v{v.version}</Link>
                      <span className="text-xs text-muted-foreground">{formatDate(v.effective_from)}{v.effective_to ? ` → ${formatDate(v.effective_to)}` : ''}</span>
                      <BomStatusBadge status={v.status} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-xs text-muted-foreground">
                <Network className="mb-2 size-4" />
                Output {formatQty(bom.output_quantity, bom.output_unit)}. Creating, editing or approving a BOM never moves stock; materials are only deducted when issued to a production order.
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); setMessage(m); setRefresh((n) => n + 1) }} />
    </>
  )
}
