import { CheckCircle2, ImagePlus, Info, Lightbulb, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AddCategoryDialog, CategoryPicker } from '@/features/products/category-picker'
import { productGaps } from '@/features/products/product-completeness'
import {
  BOM_EXPECTED_TYPES,
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  SKU_PREFIXES,
  SOURCE_TYPES,
  SOURCE_TYPE_DESCRIPTIONS,
  SOURCE_TYPE_LABELS,
  defaultSourceFor,
  imageUrlProblem,
  productUnitOptions,
  unitOptionLabel,
  type ProductInput,
} from '@/features/products/product-model'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { ProductThumb } from '@/features/products/product-image'
import { EMPTY_PRODUCT_FORM, validateProduct, type ProductField, type ProductFormValues } from '@/features/products/product-validation'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { describeProductError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  createProduct,
  fetchGroupHeadOptions,
  getProduct,
  getProductImageUrl,
  listCategories,
  removeProductImage,
  updateProduct,
  uploadProductImage,
  type ProductUpdate,
} from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'
import type { ProductCategoryRow, ProductRow } from '@/types/database'

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v))

function toFormValues(p: ProductRow): ProductFormValues {
  return {
    sku: p.sku,
    product_name: p.product_name,
    description: p.description ?? '',
    category_id: p.category_id ?? '',
    brand: p.brand ?? '',
    model_number: p.model_number ?? '',
    barcode: p.barcode ?? '',
    ean: p.ean ?? '',
    image_url: p.image_url ?? '',
    group_head: p.group_head ?? '',
    minimum_cover_days: str(p.minimum_cover_days),
    supplier_model_number: p.supplier_model_number ?? '',
    supplier_product_name: p.supplier_product_name ?? '',
    status: p.status,
    product_type: p.product_type,
    default_source_type: p.default_source_type,
    base_unit: p.base_unit,
    track_batches: p.track_batches,
    track_expiry: p.track_expiry,
    inventory_tracked: p.inventory_tracked ?? true,
    length_cm: str(p.length_cm),
    width_cm: str(p.width_cm),
    height_cm: str(p.height_cm),
    hsn_code: p.hsn_code ?? '',
    gst_rate: str(p.gst_rate),
    mrp: str(p.mrp),
    selling_price: str(p.selling_price),
    standard_cost: str(p.standard_cost),
    minimum_selling_price: str(p.minimum_selling_price),
    reorder_level: str(p.reorder_level),
    standard_manufacturing_cost: str(p.standard_manufacturing_cost),
    minimum_level: str(p.minimum_level),
    lead_time_days: str(p.lead_time_days),
    reorder_level_days: str(p.reorder_level_days),
    preferred_supplier_id: p.preferred_supplier_id ?? '',
    remarks: p.remarks ?? '',
    is_manufacturable: p.is_manufacturable,
    has_bom: p.has_bom,
    production_notes: p.production_notes ?? '',
  }
}

/** /products/new and /products/:productId/edit */
export default function ProductFormPage() {
  const { productId } = useParams()
  const isEdit = Boolean(productId)
  const product = useAsync(() => (productId ? getProduct(productId) : Promise.resolve(null)), [productId])
  const categories = useAsync(listCategories, [])
  // Suppliers are optional: a user without supplier access simply gets an empty list.
  const suppliers = useAsync(() => fetchSupplierOptions(true).catch(() => []), [])

  if (product.loading || categories.loading) return <LoadingState label="Loading…" />
  if (product.error || categories.error) {
    return (
      <>
        <FormHeader isEdit={isEdit} sku={null} />
        <Card>
          <ErrorState message={describeProductError(product.error ?? categories.error)} onRetry={() => { product.reload(); categories.reload() }} />
        </Card>
      </>
    )
  }
  if (isEdit && product.data?.archived_at) {
    return (
      <>
        <FormHeader isEdit sku={product.data.sku} />
        <Card>
          <ErrorState title="Archived products cannot be edited" message="Restore the product from the archive first." />
        </Card>
      </>
    )
  }
  return <ProductForm key={productId ?? 'new'} existing={product.data ?? null} categories={categories.data ?? []} suppliers={suppliers.data ?? []} />
}

type SupplierOption = Awaited<ReturnType<typeof fetchSupplierOptions>>[number]

function FormHeader({ isEdit, sku }: { isEdit: boolean; sku: string | null }) {
  return (
    <PageHeader
      title={isEdit ? `Edit ${sku ?? 'product'}` : 'Add Product'}
      description={isEdit ? 'Update product details. Changes are recorded in the audit log.' : 'Create a new product in the product master.'}
      breadcrumbs={[{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: isEdit ? 'Edit' : 'Add Product' }]}
    />
  )
}

function ProductForm({ existing, categories, suppliers }: { existing: ProductRow | null; categories: ProductCategoryRow[]; suppliers: SupplierOption[] }) {
  const navigate = useNavigate()
  const { access } = useAuth()
  const { has } = usePermissions()
  const companyId = access?.company?.id ?? ''

  // ERP Settings → Products: units offered, default GST rate and HSN suggestions for new products.
  const { prefs } = useErpPreferences()
  const hsnCodes = prefs?.['product.hsn_codes'] ?? []
  const groupHeadOptions = useAsync(() => fetchGroupHeadOptions().catch(() => []), [])
  const groupHeads = groupHeadOptions.data ?? []
  const initial = useMemo(() => (existing ? toFormValues(existing)
    : { ...EMPTY_PRODUCT_FORM, gst_rate: prefs ? String(prefs['product.default_gst_rate']) : EMPTY_PRODUCT_FORM.gst_rate }), [existing, prefs])
  const [values, setValues] = useState<ProductFormValues>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Version control: every edit of an existing product records a new version with this reason.
  const [changeReason, setChangeReason] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [removeLink, setRemoveLink] = useState(false)
  const [saved, setSaved] = useState<{ id: string; sku: string; imageWarning: string | null; bomExpected: boolean; gaps: number } | null>(null)

  // Auto-saved working copy. The chosen image file cannot be kept (browsers do not allow it) and must be picked again.
  const draft = usePersistentFormDraft({
    formKey: 'product.form', recordId: existing?.id ?? null, baseVersion: existing?.updated_at ?? null,
    enabled: has(existing ? 'products.update' : 'products.create') && !saved,
    value: values,
    onRestore: (d) => setValues((v) => ({ ...v, ...d })),
  })

  // Unit codes offered: the standard units, the company's other units and the product's saved unit.
  const unitCodes = productUnitOptions(prefs?.['product.units'], [existing?.base_unit, values.base_unit])
  const validation = validateProduct(values, { units: unitCodes })
  const errors = submitted ? validation.errors : {}
  const canChangeStatus = existing ? has('products.archive') : true

  // Categories created from this form are added to the list straight away.
  const [allCategories, setAllCategories] = useState(categories)
  const [addingCategory, setAddingCategory] = useState<string | null>(null)
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null)
  // Active categories, plus the product's current category even if now inactive.
  const categoryOptions = allCategories.filter((c) => c.is_active || c.id === existing?.category_id)
  const hasLegacyLevels = values.reorder_level.trim() !== '' || values.minimum_level.trim() !== ''

  const set = <K extends ProductField>(key: K, value: ProductFormValues[K]) => setValues((v) => ({ ...v, [key]: value }))
  const bind = (key: Exclude<ProductField, 'track_batches' | 'track_expiry' | 'inventory_tracked' |'is_manufacturable' | 'has_bom' | 'status' | 'product_type' | 'default_source_type'>) => ({
    id: `p-${key}`,
    value: values[key] as string,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
    'aria-invalid': Boolean(errors[key]),
  })

  const save = async () => {
    setSubmitted(true)
    setSaveError(null)
    const input = validation.input
    if (!input) return
    if (existing && !input.sku) {
      setSaveError('An existing product keeps its SKU. Enter the SKU (automatic codes are only for new products).')
      return
    }
    setSaving(true)
    try {
      let id: string
      let sku = input.sku ?? ''
      if (existing) {
        // Send only fields whose normalised value changed.
        const before = validateProduct(toFormValues(existing), { units: [existing.base_unit] }).input
        const changes: Partial<ProductInput> = {}
        for (const key of Object.keys(input) as (keyof ProductInput)[]) {
          if (!before || input[key] !== before[key]) (changes as Record<string, unknown>)[key] = input[key]
        }
        // has_bom follows the BOM module; the form never overwrites it.
        delete changes.has_bom
        if (!canChangeStatus) delete changes.status
        // A cleared image link keeps the saved one unless "Remove image link" was chosen.
        if ('image_url' in changes && changes.image_url === null && !removeLink) delete changes.image_url
        // The image link is not part of the version history, so it alone needs no reason.
        const versioned = Object.keys(changes).filter((k) => k !== 'image_url')
        if (Object.keys(changes).length > 0) {
          if (versioned.length > 0 && changeReason.trim().length < 3) {
            setSaveError('Enter the reason for this change (it is kept in the product version history).')
            setSaving(false)
            return
          }
          await updateProduct(existing.id, { ...(changes as ProductUpdate), ...(versioned.length > 0 ? { change_reason: changeReason.trim().slice(0, 500) } : {}) })
        }
        id = existing.id
      } else {
        const created = await createProduct(companyId, input)
        id = created.id
        sku = created.sku || input.sku || ''
      }
      // The product is saved in the database: the working copy is no longer needed.
      void draft.markSubmitted()

      let imageWarning: string | null = null
      if (imageFile) {
        try {
          const fresh = existing ?? { id, company_id: companyId, product_image_path: null }
          await uploadProductImage(fresh, imageFile)
        } catch (error) {
          imageWarning = `The product was saved, but the image could not be uploaded: ${error instanceof Error && !('code' in error) ? error.message : describeProductError(error)}`
        }
      }

      if (existing) {
        navigate(`/products/${id}`, { state: { message: imageWarning ?? 'Product updated.' } })
      } else {
        setSaved({ id, sku, imageWarning, bomExpected: BOM_EXPECTED_TYPES.includes(input.product_type), gaps: productGaps(input).length })
      }
    } catch (error) {
      // Keep the entered values; show the reason.
      setSaveError(describeProductError(error))
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <>
        <FormHeader isEdit={false} sku={null} />
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center py-10 text-center">
            <CheckCircle2 aria-hidden className="mb-3 size-10 text-available" />
            <p className="text-base font-semibold">Product {saved.sku} saved</p>
            <p className="mt-1 text-sm text-muted-foreground">The database confirmed the new product record.</p>
            {saved.imageWarning && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{saved.imageWarning}</p>}
            {(saved.gaps > 0 || saved.bomExpected) && (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {saved.gaps > 0 && `${saved.gaps} piece(s) of information are still missing; you can add them any time from the product page. `}
                {saved.bomExpected && 'This product has no bill of materials yet.'}
              </p>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {saved.bomExpected && has('production_bom.create') && (
                <Button variant="outline" asChild>
                  <Link to={`/production/boms/new?product=${saved.id}`}>Create BOM</Link>
                </Button>
              )}
              <Button
                onClick={() => {
                  setValues(EMPTY_PRODUCT_FORM)
                  setSubmitted(false)
                  setImageFile(null)
                  setSaved(null)
                }}
              >
                <Plus />
                Add another product
              </Button>
              <Button variant="outline" asChild>
                <Link to={`/products/${saved.id}`}>View product</Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/products">Back to list</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    )
  }

  const recommendations = [...validation.warnings]
  const effectiveSource = values.default_source_type || (values.product_type ? defaultSourceFor(values.product_type) : '')
  if (effectiveSource === 'OUTSOURCED' && !values.preferred_supplier_id && suppliers.length > 0) {
    recommendations.push('Select a preferred supplier so purchase orders and BOM lines can default to it.')
  }
  const gaps = validation.input
    ? productGaps(validation.input, existing && BOM_EXPECTED_TYPES.includes(validation.input.product_type) ? existing.has_bom : undefined)
    : []
  const supplierOptions = suppliers.filter((s) => s.status === 'ACTIVE' || s.id === existing?.preferred_supplier_id)

  return (
    <>
      <FormHeader isEdit={Boolean(existing)} sku={existing?.sku ?? null} />
      <FormDraftBar draft={draft} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]"
      >
        <div className="space-y-6">
          <Section letter="A" title="Basic Information">
            <Field label="SKU / Item Code" htmlFor="p-sku" error={errors.sku}
              hint={existing
                ? 'Changing a SKU is allowed only while no transactions reference the product.'
                : `Leave blank to get the next ${values.product_type ? `${SKU_PREFIXES[values.product_type]}-` : ''}code automatically, or enter your own. Uniqueness ignores letter case.`}>
              <Input {...bind('sku')} maxLength={50} autoComplete="off" />
            </Field>
            <Field label="Product Name" htmlFor="p-product_name" error={errors.product_name}>
              <Input {...bind('product_name')} maxLength={200} />
            </Field>
            <Field label="Description" htmlFor="p-description" full error={errors.description}>
              <Textarea {...bind('description')} rows={3} maxLength={2000} />
            </Field>
            <Field label="Category" htmlFor="p-category"
              hint={categoryNotice ?? (has('product_categories.manage') ? 'Search the list, or choose “+ Add New Category”.' : undefined)}>
              <CategoryPicker id="p-category" value={values.category_id} categories={categoryOptions} onChange={(v) => { set('category_id', v); setCategoryNotice(null) }}
                canAdd={has('product_categories.manage') && Boolean(companyId)} onAddRequest={(name) => { setCategoryNotice(null); setAddingCategory(name) }} />
            </Field>
            <Field label="Brand" htmlFor="p-brand" error={errors.brand}>
              <Input {...bind('brand')} maxLength={100} />
            </Field>
            <Field label="Model Number" htmlFor="p-model_number" error={errors.model_number}>
              <Input {...bind('model_number')} maxLength={100} />
            </Field>
            <Field label="Supplier Model No." htmlFor="p-supplier_model_number" error={errors.supplier_model_number}
              hint="Optional. The supplier's own model number; searchable.">
              <Input {...bind('supplier_model_number')} maxLength={100} autoComplete="off" />
            </Field>
            <Field label="Supplier Product Name" htmlFor="p-supplier_product_name" error={errors.supplier_product_name}
              hint="Optional. The SKU and product name above stay the Alton identifiers.">
              <Input {...bind('supplier_product_name')} maxLength={200} />
            </Field>
            <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2" data-testid="product-identification">
              <legend className="mb-1 text-sm font-medium">Product Identification</legend>
              <Field label="Barcode" htmlFor="p-barcode" error={errors.barcode} hint="Optional. Any internal or supplier code; must be unique when provided.">
                <Input {...bind('barcode')} maxLength={64} autoComplete="off" />
              </Field>
              <Field label="EAN" htmlFor="p-ean" error={errors.ean} hint="Optional. EAN-8 or EAN-13 (digits; the check digit is verified). Unique within the company.">
                <Input {...bind('ean')} inputMode="numeric" maxLength={17} autoComplete="off" placeholder="e.g. 8901234567890" />
              </Field>
            </fieldset>
            <Field label="Product Image" htmlFor="p-image" full error={imageError}>
              <ImagePicker existing={existing} file={imageFile} onFile={setImageFile} onError={setImageError} />
            </Field>
            <Field label="Image Link" htmlFor="p-image_url" full error={errors.image_url}
              hint={existing?.image_url && !removeLink ? 'Paste a new link to replace the image. Leaving the field empty keeps the saved link.'
                : 'Optional. An http:// or https:// link to the product image on a public website. An uploaded image is shown instead of the link.'}>
              <div className="flex items-start gap-3" data-testid="image-link-field">
                <ProductThumb size="md" alt={values.product_name || 'Product'} source={values.image_url.trim() || null}
                  src={values.image_url.trim() && !errors.image_url && !imageUrlProblem(values.image_url) ? values.image_url.trim() : null} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Input {...bind('image_url')} inputMode="url" maxLength={2048} autoComplete="off" placeholder="https://example.com/images/product.jpg"
                    aria-invalid={Boolean(errors.image_url || (values.image_url.trim() && imageUrlProblem(values.image_url)))}
                    onChange={(e) => { set('image_url', e.target.value); if (e.target.value.trim()) setRemoveLink(false) }} />
                  {values.image_url.trim() && imageUrlProblem(values.image_url) && !errors.image_url && (
                    <p className="text-xs text-amber-800" data-testid="image-url-problem">{imageUrlProblem(values.image_url)}</p>
                  )}
                  {existing?.image_url && (removeLink ? (
                    <p className="text-xs text-muted-foreground" data-testid="image-link-removed">The saved image link will be removed when you save.{' '}
                      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => { setRemoveLink(false); set('image_url', existing.image_url ?? '') }}>Keep it</button></p>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" data-testid="remove-image-link" onClick={() => { setRemoveLink(true); set('image_url', '') }}>
                      <Trash2 /> Remove image link
                    </Button>
                  ))}
                </div>
              </div>
            </Field>
          </Section>

          <Section letter="B" title="Classification">
            <Field label="Product Type" htmlFor="p-type" error={errors.product_type}>
              <Select value={values.product_type} onValueChange={(v) => set('product_type', v as ProductFormValues['product_type'])}>
                <SelectTrigger id="p-type" aria-invalid={Boolean(errors.product_type)}>
                  <SelectValue placeholder="Select product type" />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PRODUCT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Unit of Measurement" htmlFor="p-unit" error={errors.base_unit}>
              <Select value={values.base_unit} onValueChange={(v) => { if (v) set('base_unit', v) }}>
                <SelectTrigger id="p-unit" data-testid="p-unit" aria-invalid={Boolean(errors.base_unit)}>
                  <SelectValue placeholder="Select a unit" />
                </SelectTrigger>
                <SelectContent>
                  {unitCodes.map((code) => (
                    <SelectItem key={code} value={code}>{unitOptionLabel(code)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Group Head" htmlFor="p-group_head" error={errors.group_head} hint="Optional. Choose from the list (ERP Settings → Product) or type a new group.">
              <Input {...bind('group_head')} maxLength={100} list="p-group-head-list" autoComplete="off" />
              <datalist id="p-group-head-list">{groupHeads.map((g) => <option key={g} value={g} />)}</datalist>
            </Field>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="mb-2 text-sm font-medium">
                Default Source Type
                {!values.default_source_type && values.product_type && (
                  <span className="ml-2 font-normal text-muted-foreground">(not chosen: {SOURCE_TYPE_LABELS[defaultSourceFor(values.product_type)]} will be used)</span>
                )}
              </legend>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Default source type">
                {SOURCE_TYPES.map((s) => {
                  const selected = values.default_source_type === s
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => set('default_source_type', s)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        selected ? 'border-primary bg-accent ring-1 ring-primary' : 'hover:bg-muted',
                      )}
                    >
                      <span className="block text-sm font-medium">{SOURCE_TYPE_LABELS[s]}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{SOURCE_TYPE_DESCRIPTIONS[s]}</span>
                    </button>
                  )
                })}
              </div>
              {errors.default_source_type && <p className="text-xs text-shortage">{errors.default_source_type}</p>}
              {values.default_source_type === 'HYBRID' && (
                <p className="flex gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-900">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  Hybrid products can be both manufactured and purchased. The actual source of each stock quantity will be recorded on inventory receipts in the inventory module, not here.
                </p>
              )}
            </fieldset>
            <Field label="Status" htmlFor="p-status" hint={!canChangeStatus ? 'Changing status requires the products.archive permission.' : undefined}>
              <Select value={values.status} onValueChange={(v) => set('status', v as ProductFormValues['status'])} disabled={!canChangeStatus}>
                <SelectTrigger id="p-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="space-y-3 sm:col-span-2">
              <CheckField id="p-batches" label="Batch tracking enabled" description="Stock will be received and issued by batch (inventory module)."
                checked={values.track_batches} onChange={(v) => setValues((s) => ({ ...s, track_batches: v, track_expiry: v ? s.track_expiry : false }))} />
              <CheckField id="p-expiry" label="Expiry tracking" description="Requires batch tracking." disabled={!values.track_batches}
                checked={values.track_expiry} onChange={(v) => set('track_expiry', v)} error={errors.track_expiry} />
              <CheckField id="p-inventory-tracked" label="Stock-tracked item"
                description="Physical goods: an invoice can be posted only after the goods are dispatched. Untick for services and non-stock items (installation, AMC, labour), which are invoiced without dispatch."
                checked={values.inventory_tracked} onChange={(v) => set('inventory_tracked', v)} />
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">Dimensions <span className="font-normal text-muted-foreground">(optional, in cm)</span></legend>
              <p className="mb-2 text-xs text-muted-foreground">For packaging, logistics and warehouse planning. Leave blank if not known; weight and volume are not assumed.</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Length (cm)" htmlFor="p-length_cm" error={errors.length_cm}>
                  <Input {...bind('length_cm')} inputMode="decimal" />
                </Field>
                <Field label="Width (cm)" htmlFor="p-width_cm" error={errors.width_cm}>
                  <Input {...bind('width_cm')} inputMode="decimal" />
                </Field>
                <Field label="Height (cm)" htmlFor="p-height_cm" error={errors.height_cm}>
                  <Input {...bind('height_cm')} inputMode="decimal" />
                </Field>
              </div>
            </fieldset>
          </Section>

          <Section letter="C" title="Tax and Pricing" description="Optional until confirmed. Leave blank rather than guessing.">
            <Field label="HSN Code" htmlFor="p-hsn_code" error={errors.hsn_code} hint="4, 6 or 8 digits.">
              <Input {...bind('hsn_code')} inputMode="numeric" maxLength={8} list="p-hsn-list" />
              <datalist id="p-hsn-list">{hsnCodes.map((h) => <option key={h.code} value={h.code}>{[h.description, h.gst_rate != null ? `GST ${h.gst_rate}%` : null].filter(Boolean).join(' · ')}</option>)}</datalist>
            </Field>
            <Field label="GST Rate (%)" htmlFor="p-gst_rate" error={errors.gst_rate}>
              <Input {...bind('gst_rate')} inputMode="decimal" />
            </Field>
            <Field label="MRP (₹)" htmlFor="p-mrp" error={errors.mrp} hint="Maximum retail price incl. all taxes. Not used as the invoice price.">
              <Input {...bind('mrp')} inputMode="decimal" />
            </Field>
            <Field label="Selling Price (₹)" htmlFor="p-selling_price" error={errors.selling_price} hint="Before GST. Can be below the MRP (discounts, negotiated prices).">
              <Input {...bind('selling_price')} inputMode="decimal" />
            </Field>
            <Field label="Standard Purchase Cost (₹)" htmlFor="p-standard_cost" error={errors.standard_cost}>
              <Input {...bind('standard_cost')} inputMode="decimal" />
            </Field>
            <Field label="Standard Manufacturing Cost (₹)" htmlFor="p-standard_manufacturing_cost" error={errors.standard_manufacturing_cost}>
              <Input {...bind('standard_manufacturing_cost')} inputMode="decimal" />
            </Field>
            <Field label="Minimum Selling Price (₹)" htmlFor="p-minimum_selling_price" error={errors.minimum_selling_price}>
              <Input {...bind('minimum_selling_price')} inputMode="decimal" />
            </Field>
          </Section>

          <Section letter="D" title="Inventory Planning" description="Planned in days of stock cover: available stock ÷ average daily consumption. Stock quantities come from the inventory module.">
            <Field label="Lead Time (Days)" htmlFor="p-lead_time_days" error={errors.lead_time_days}
              hint="Days needed to buy or make the product. Shown next to reorder recommendations.">
              <Input {...bind('lead_time_days')} inputMode="decimal" />
            </Field>
            <Field label="Reorder Level (Days)" htmlFor="p-reorder_level_days" error={errors.reorder_level_days}
              hint="Reorder when the days of cover fall to this many days or fewer.">
              <Input {...bind('reorder_level_days')} inputMode="decimal" />
            </Field>
            <Field label="Minimum Stock Days" htmlFor="p-minimum_cover_days" error={errors.minimum_cover_days}
              hint="Minimum inventory coverage to keep, in days. For reference; reorder calculations use the reorder level.">
              <Input {...bind('minimum_cover_days')} inputMode="decimal" />
            </Field>
            {hasLegacyLevels && (
              <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-2">
                <p className="min-w-0 flex-1">
                  Earlier quantity levels are still stored:{' '}
                  {[values.reorder_level.trim() && `reorder at ${values.reorder_level} ${values.base_unit}`, values.minimum_level.trim() && `minimum ${values.minimum_level} ${values.base_unit}`].filter(Boolean).join(', ')}.
                  {' '}They are not converted to days, and the reorder quantity still raises low-stock alerts until it is cleared.
                </p>
                <Button type="button" size="sm" variant="outline" onClick={() => setValues((v) => ({ ...v, reorder_level: '', minimum_level: '' }))}>
                  Clear quantity levels
                </Button>
              </div>
            )}
          </Section>

          <Section letter="E" title="Manufacturing and Procurement">
            <div className="space-y-3 sm:col-span-2">
              <CheckField id="p-manufacturable" label="Is manufacturable" description="Can be produced in the company's plant."
                checked={values.is_manufacturable} onChange={(v) => set('is_manufacturable', v)} />
              <p className="text-sm">
                <span className="font-medium">Bill of materials: </span>
                {existing?.has_bom
                  ? <>active BOM in place. <Link className="text-primary hover:underline" to={`/production/boms?product=${existing.id}`}>View BOMs</Link></>
                  : <span className="text-muted-foreground">none active yet. It is set automatically when a BOM is activated{existing && has('production_bom.create') ? <>; <Link className="text-primary hover:underline" to={`/production/boms/new?product=${existing.id}`}>create one now</Link></> : ', and can be added after saving'}.</span>}
              </p>
            </div>
            <Field label="Manufacturer / Preferred Supplier" htmlFor="p-supplier"
              hint={suppliers.length === 0 ? 'No suppliers available yet. Add them under Suppliers; this can be set later.' : 'Used as the default supplier on BOM lines and purchase orders.'}>
              <Select value={values.preferred_supplier_id || 'none'} onValueChange={(v) => set('preferred_supplier_id', v === 'none' ? '' : v)} disabled={suppliers.length === 0}>
                <SelectTrigger id="p-supplier">
                  <SelectValue placeholder="No preferred supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No preferred supplier</SelectItem>
                  {supplierOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.supplier_code} — {s.display_name ?? s.legal_name}{s.status !== 'ACTIVE' && ' (inactive)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Production Notes" htmlFor="p-production_notes" full error={errors.production_notes}>
              <Textarea {...bind('production_notes')} rows={3} maxLength={2000} />
            </Field>
            <Field label="Remarks" htmlFor="p-remarks" full error={errors.remarks}>
              <Textarea {...bind('remarks')} rows={2} maxLength={2000} />
            </Field>
          </Section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          {submitted && !validation.input && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
              Please correct the highlighted fields ({Object.keys(validation.errors).length}).
            </p>
          )}
          {saveError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
              {saveError}
            </p>
          )}
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Lightbulb aria-hidden className="size-4 text-pending" />
                  Recommendations
                </CardTitle>
                <CardDescription>Suggestions only — they never block saving.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {recommendations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recommendations.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {recommendations.map((w) => (
                    <li key={w} className="flex gap-2">
                      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-pending" />
                      <span>
                        {w}
                        {w.startsWith('In-house') && !values.is_manufacturable && (
                          <button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => set('is_manufacturable', true)}>
                            Mark manufacturable
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {gaps.length > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Info aria-hidden className="size-4 text-pending" />
                    Missing information
                  </CardTitle>
                  <CardDescription>You can save now and add these later.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {gaps.map((g) => (
                    <li key={g.key} className="flex gap-2">
                      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                      <span>{g.message}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {existing && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Reason for change</CardTitle>
                  <CardDescription>Saving creates a new product version. Earlier transactions, BOMs and reports keep the previous values.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <Label htmlFor="p-change-reason" className="sr-only">Reason for change</Label>
                <Textarea id="p-change-reason" rows={2} maxLength={500} value={changeReason} placeholder="e.g. Supplier changed the glaze"
                  onChange={(e) => setChangeReason(e.target.value)} />
              </CardContent>
            </Card>
          )}
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {existing ? 'Save changes' : 'Save product'}
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link to={existing ? `/products/${existing.id}` : '/products'}>Cancel</Link>
            </Button>
          </div>
        </aside>
      </form>
      {addingCategory !== null && (
        <AddCategoryDialog
          companyId={companyId}
          initialName={addingCategory}
          categories={allCategories}
          onClose={() => setAddingCategory(null)}
          onCreated={(c) => {
            setAllCategories((list) => [...list, c].sort((a, b) => a.name.localeCompare(b.name)))
            set('category_id', c.id)
            setAddingCategory(null)
            setCategoryNotice(`Category “${c.name}” created and selected.`)
          }}
        />
      )}
    </>
  )
}

function Section({ letter, title, description, children }: { letter: string; title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>
            <span className="mr-2 text-muted-foreground">{letter}.</span>
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  )
}

function Field({ label, htmlFor, full, error, hint, children }: {
  label: string
  htmlFor: string
  full?: boolean
  error?: string | null
  hint?: string
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', full && 'sm:col-span-2')}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-shortage">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function CheckField({ id, label, description, checked, onChange, disabled, error }: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  error?: string
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <Label htmlFor={id} className="flex-col items-start gap-0.5 font-normal">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
        {error && <span className="text-xs text-shortage">{error}</span>}
      </Label>
    </div>
  )
}

function ImagePicker({ existing, file, onFile, onError }: {
  existing: ProductRow | null
  file: File | null
  onFile: (file: File | null) => void
  onError: (message: string | null) => void
}) {
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  const [removing, setRemoving] = useState(false)
  const [removed, setRemoved] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (existing?.product_image_path) {
      void getProductImageUrl(existing.product_image_path).then((url) => !cancelled && setCurrentUrl(url))
    }
    return () => {
      cancelled = true
    }
  }, [existing?.product_image_path])

  // Release the object URL when the selected file changes or the form unmounts.
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const shown = previewUrl ?? (removed ? null : currentUrl)

  return (
    <div className="flex items-center gap-4">
      <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-surface-muted">
        {shown ? <img src={shown} alt="Product" className="size-full object-contain" /> : <ImagePlus aria-hidden className="size-6 text-muted-foreground" />}
      </div>
      <div className="space-y-2 text-sm">
        <input
          id="p-image"
          type="file"
          accept={PRODUCT_IMAGE_TYPES.join(',')}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null
            onError(null)
            if (f && !PRODUCT_IMAGE_TYPES.includes(f.type)) {
              onError('Use a JPEG, PNG or WebP image.')
              e.target.value = ''
              return
            }
            if (f && f.size > PRODUCT_IMAGE_MAX_BYTES) {
              onError('Images must be 2 MB or smaller.')
              e.target.value = ''
              return
            }
            onFile(f)
          }}
        />
        <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 2 MB. Uploaded when you save.</p>
        {existing?.product_image_path && !removed && !file && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={removing}
            onClick={async () => {
              setRemoving(true)
              try {
                await removeProductImage(existing)
                setRemoved(true)
              } catch (error) {
                onError(describeProductError(error))
              } finally {
                setRemoving(false)
              }
            }}
          >
            <Trash2 />
            Remove current image
          </Button>
        )}
      </div>
    </div>
  )
}
