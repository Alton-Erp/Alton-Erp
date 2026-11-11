import { Archive, ArrowLeft, Copy, Loader2, RotateCcw, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { parseUnitQty, quantityRule } from '@/features/inventory/whole-units'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { CategoryPicker } from '@/features/products/category-picker'
import { productUnitOptions, unitOptionLabel } from '@/features/products/product-model'
import { BomComponentEditor, BomCostSummary } from '@/features/production/bom-component-editor'
import { linesCost, useComponentInfo } from '@/features/production/bom-component-info'
import { componentProblem, itemsFromLines, linesFromItems, newLine, type EditorLine } from '@/features/production/bom-tools-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchTemplate, saveTemplate, setTemplateStatus, type BomTemplateRow } from '@/services/bom-tools'
import { getProduct, listCategories } from '@/services/products'
import { fetchBom } from '@/services/production'

/**
 * /production/bom-templates/new[?bom=<bomId>] and /production/bom-templates/:templateId
 * A template: name, description, product category, output quantity and unit, components with default
 * quantities and wastage. "Save as BOM template" on a BOM opens this page filled from that BOM.
 */
export default function BomTemplatePage() {
  const { templateId } = useParams()
  const [params] = useSearchParams()
  const fromBom = templateId ? null : params.get('bom')
  const navigate = useNavigate()
  const { user } = useAuth()
  const { has } = usePermissions()
  const { prefs } = useErpPreferences()
  const { key, renew } = useRequestKey()
  const [refresh, setRefresh] = useState(0)
  const loaded = useAsync(async () => {
    if (templateId) return { kind: 'template' as const, ...(await fetchTemplate(templateId)) }
    if (fromBom) {
      const { bom, items } = await fetchBom(fromBom)
      const product = await getProduct(bom.finished_product_id).catch(() => null)
      return { kind: 'bom' as const, bom, items, categoryId: product?.category_id ?? null }
    }
    return null
  }, [templateId, fromBom, refresh])
  const categories = useAsync(() => listCategories(), [])

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [output, setOutput] = useState('1')
  const [unit, setUnit] = useState('PCS')
  const [lines, setLines] = useState<EditorLine[]>([newLine()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const d = loaded.data
    if (!d) return
    void Promise.resolve().then(() => {
      if (d.kind === 'template') {
        setName(d.template.template_name)
        setDescription(d.template.description ?? '')
        setCategory(d.template.category_id ?? '')
        setOutput(String(Number(d.template.output_quantity)))
        setUnit(d.template.output_unit)
        setLines(d.items.length ? linesFromItems(d.items) : [newLine()])
      } else {
        setName(`${d.bom.product_name} template`.slice(0, 120))
        setDescription(`Components of ${d.bom.bom_code} v${d.bom.version} (${d.bom.sku}).`)
        setCategory(d.categoryId ?? '')
        setOutput(String(Number(d.bom.output_quantity)))
        setUnit(d.bom.output_unit)
        setLines(d.items.length ? linesFromItems(d.items) : [newLine()])
      }
    })
  }, [loaded.data])

  const template: BomTemplateRow | null = loaded.data?.kind === 'template' ? loaded.data.template : null
  const mayEdit = template
    ? template.status === 'ACTIVE' && (has('production_bom.update') || (has('production_bom.create') && template.created_by === user?.id))
    : has('production_bom.create')
  const mayChangeStatus = Boolean(template) && (has('production_bom.update') || (has('production_bom.create') && template?.created_by === user?.id))
  const info = useComponentInfo(useMemo(() => lines, [lines]))
  const cost = linesCost(lines, output, info)
  const units = productUnitOptions(prefs?.['product.units'] as string[] | undefined, [unit])

  const save = async () => {
    setError(null)
    setMessage(null)
    if (name.trim().length < 2) return setError('Enter a template name (2 to 120 characters).')
    const out = parseUnitQty(output, unit)
    if (!out) return setError(`Output quantity must be greater than zero (${quantityRule(unit)}).`)
    const cp = componentProblem(lines)
    if (cp) return setError(cp)
    setBusy(true)
    try {
      const r = await saveTemplate(template?.id ?? null, {
        template_name: name.trim(), description: description.trim() || null, category_id: category || null, output_quantity: out, output_unit: unit,
        source_bom_id: loaded.data?.kind === 'bom' ? loaded.data.bom.id : null,
      }, itemsFromLines(lines), template ? null : key)
      renew()
      if (!template) navigate(`/production/bom-templates/${r.template_id}`, { replace: true, state: null })
      else { setMessage(`Saved "${r.template_name}" (${r.components} components).`); setRefresh((n) => n + 1) }
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status: 'ACTIVE' | 'ARCHIVED') => {
    if (!template) return
    setBusy(true)
    setError(null)
    try {
      await setTemplateStatus(template.id, status)
      setMessage(status === 'ARCHIVED' ? 'Template archived: it can no longer be used to create products.' : 'Template reactivated.')
      setRefresh((n) => n + 1)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'BOM templates', to: '/production/bom-templates' }, { label: template?.template_name ?? 'New template' }]
  if ((templateId || fromBom) && loaded.loading && !loaded.data) return (<><PageHeader title="BOM template" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={2} /></>)
  if ((templateId || fromBom) && (loaded.error || !loaded.data)) return (<><PageHeader title="BOM template" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(loaded.error)} onRetry={loaded.reload} /></Card></>)

  return (
    <>
      <PageHeader title={template ? template.template_name : 'New BOM template'} breadcrumbs={crumbs}
        description={template?.source_bom_code ? `Taken from ${template.source_bom_code} v${template.source_bom_version}. Editing the template never changes BOMs.` : 'Reusable components for creating new finished products.'}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/production/bom-templates"><ArrowLeft /> All templates</Link></Button>
            {template?.status === 'ACTIVE' && has('production_bom.create') && (
              <Button asChild><Link to={`/production/boms/similar?template=${template.id}`}><Copy /> Create product from template</Link></Button>
            )}
          </>
        } />
      {loaded.data?.kind === 'bom' && <p className="mb-4 rounded-lg border bg-surface-muted/50 px-4 py-2.5 text-sm" data-testid="tpl-from-bom">Filled from {loaded.data.bom.bom_code} v{loaded.data.bom.version} ({loaded.data.bom.sku}). The BOM is not changed.</p>}
      {error && <p role="alert" data-testid="tpl-error" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div><CardTitle>Template</CardTitle>{template && <CardDescription>Updated {formatDateTime(template.updated_at)}</CardDescription>}</div>
            {template && <StatusBadge label={template.status === 'ACTIVE' ? 'Active' : 'Archived'} tone={template.status === 'ACTIVE' ? 'success' : 'neutral'} />}
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="tpl-name">Template name</Label><Input id="tpl-name" maxLength={120} value={name} disabled={!mayEdit} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tpl-category">Product category</Label>
              <CategoryPicker id="tpl-category" value={category} categories={categories.data ?? []} onChange={setCategory} canAdd={false} onAddRequest={() => undefined} />
            </div>
            <div className="space-y-1.5"><Label htmlFor="tpl-output">Output quantity</Label><Input id="tpl-output" inputMode="decimal" value={output} disabled={!mayEdit} onChange={(e) => setOutput(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-unit">Output unit</Label>
              <Select value={unit} onValueChange={setUnit} disabled={!mayEdit}>
                <SelectTrigger id="tpl-unit" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{unitOptionLabel(u)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2 xl:col-span-4"><Label htmlFor="tpl-desc">Description</Label><Textarea id="tpl-desc" rows={2} maxLength={2000} value={description} disabled={!mayEdit} onChange={(e) => setDescription(e.target.value)} /></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>Components</CardTitle><CardDescription>Default quantities and wastage. They are copied into each new product's BOM, where they can be changed.</CardDescription></div></CardHeader>
          <CardContent><BomComponentEditor lines={lines} onChange={setLines} output={output} outputUnit={unit} editable={mayEdit} idPrefix="tpl" info={info}
            defaultWastage={String(prefs?.['production.default_wastage_percent'] ?? 0)} testId="tpl-components" /></CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>Estimated cost</CardTitle></div></CardHeader>
          <CardContent><BomCostSummary cost={cost} output={output} outputUnit={unit} testId="tpl-cost" /></CardContent>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          {template && mayChangeStatus && (template.status === 'ACTIVE'
            ? <Button variant="outline" onClick={() => void changeStatus('ARCHIVED')} disabled={busy}><Archive /> Archive</Button>
            : <Button variant="outline" onClick={() => void changeStatus('ACTIVE')} disabled={busy}><RotateCcw /> Reactivate</Button>)}
          {mayEdit && <Button onClick={() => void save()} disabled={busy} data-testid="tpl-save">{busy ? <Loader2 className="animate-spin" /> : <Save />} {template ? 'Save template' : 'Create template'}</Button>}
        </div>
        {template?.status === 'ARCHIVED' && <p className="text-right text-xs text-muted-foreground">Archived templates cannot be edited or used. Reactivate it first.</p>}
      </div>
    </>
  )
}
