import { applyConditions, type Condition, type FilterBuilder } from '@/features/drilldown/drill-conditions'
import { productSearchPattern } from '@/features/products/product-search'
import { categoryCodeFor, type ProductInput, type ProductType, type SourceType } from '@/features/products/product-model'
import type { BulkDeletePreview, BulkDeleteResult, DuplicateHint } from '@/features/products/product-bulk-delete'
import { describeProductError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import type { Database, ProductCategoryRow, ProductRow } from '@/types/database'

/**
 * Product Master data access. Every query runs under the signed-in user's
 * RLS policies; company scoping and permissions are enforced by the database.
 */

export type ProductStatusFilter = 'current' | 'active' | 'inactive' | 'archived' | 'all'
export type ProductSortColumn = 'sku' | 'product_name' | 'product_type' | 'default_source_type' | 'status' | 'selling_price' | 'updated_at'
  | 'standard_manufacturing_cost' | 'mrp' | 'hsn_code' | 'gst_rate' | 'base_unit'

export interface ProductListParams {
  search: string
  categoryId: string | null
  sourceType: SourceType | null
  productType: ProductType | null
  status: ProductStatusFilter
  manufacturable: boolean | null
  hasBom: boolean | null
  sort: { column: ProductSortColumn; ascending: boolean }
  page: number
  pageSize: number
  /** Dashboard figure the list was opened from (drill-down): its conditions are applied as well. */
  drill?: readonly Condition[] | null
}

export interface ProductKpis {
  active: number
  in_house: number
  outsourced: number
  hybrid: number
  inactive: number
  archived: number
  total: number
  finished_goods: number
  raw_materials: number
  components: number
  subassemblies: number
  outsourced_components: number
  packaging: number
  consumables: number
  /** Active finished goods / subassemblies with no active BOM. */
  without_bom: number
  /** Active products missing HSN, GST, category or the relevant price/cost. */
  incomplete: number
}

function buildQuery(params: Omit<ProductListParams, 'page' | 'pageSize' | 'sort'>, columns: string, count: boolean) {
  let query = requireSupabase().from('products').select(columns, count ? { count: 'exact' } : undefined)

  const like = productSearchPattern(params.search)
  if (like) {
    query = query.or(
      ['sku', 'product_name', 'barcode', 'ean', 'model_number', 'brand', 'supplier_model_number', 'supplier_product_name', 'group_head'].map((c) => `${c}.ilike.${like}`).join(','),
    )
  }
  if (params.categoryId === 'none') query = query.is('category_id', null)
  else if (params.categoryId) query = query.eq('category_id', params.categoryId)
  if (params.sourceType) query = query.eq('default_source_type', params.sourceType)
  if (params.productType) query = query.eq('product_type', params.productType)
  if (params.manufacturable !== null) query = query.eq('is_manufacturable', params.manufacturable)
  if (params.hasBom !== null) query = query.eq('has_bom', params.hasBom)

  if (params.drill?.length) query = applyConditions(query as unknown as FilterBuilder<never>, params.drill) as unknown as typeof query
  switch (params.status) {
    case 'current':
      query = query.is('archived_at', null)
      break
    case 'active':
      query = query.eq('status', 'ACTIVE')
      break
    case 'inactive':
      query = query.eq('status', 'INACTIVE').is('archived_at', null)
      break
    case 'archived':
      query = query.not('archived_at', 'is', null)
      break
  }
  return query
}

export async function listProducts(params: ProductListParams): Promise<{ rows: ProductRow[]; total: number }> {
  const from = params.page * params.pageSize
  const { data, error, count } = await buildQuery(params, '*', true)
    .order(params.sort.column, { ascending: params.sort.ascending, nullsFirst: false })
    .order('id')
    .range(from, from + params.pageSize - 1)
  if (error) throw error
  return { rows: (data ?? []) as unknown as ProductRow[], total: count ?? 0 }
}

/** All rows matching the filters (for export), fetched in pages of 1000. */
export async function listAllProducts(
  params: Omit<ProductListParams, 'page' | 'pageSize'>,
  limit = 20000,
): Promise<ProductRow[]> {
  const rows: ProductRow[] = []
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await buildQuery(params, '*', false)
      .order(params.sort.column, { ascending: params.sort.ascending, nullsFirst: false })
      .order('id')
      .range(from, from + 999)
    if (error) throw error
    const page = (data ?? []) as unknown as ProductRow[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

export async function getProduct(id: string): Promise<ProductRow> {
  const { data, error } = await requireSupabase().from('products').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

export async function fetchProductKpis(): Promise<ProductKpis> {
  const { data, error } = await requireSupabase().rpc('product_kpis')
  if (error) throw error
  const value = (data ?? {}) as Record<string, unknown>
  const n = (k: keyof ProductKpis) => Number(value[k] ?? 0)
  return {
    active: n('active'),
    in_house: n('in_house'),
    outsourced: n('outsourced'),
    hybrid: n('hybrid'),
    inactive: n('inactive'),
    archived: n('archived'),
    total: n('total'),
    finished_goods: n('finished_goods'),
    raw_materials: n('raw_materials'),
    components: n('components'),
    subassemblies: n('subassemblies'),
    outsourced_components: n('outsourced_components'),
    packaging: n('packaging'),
    consumables: n('consumables'),
    without_bom: n('without_bom'),
    incomplete: n('incomplete'),
  }
}

/** An empty image link is not sent, so products can still be saved before the image-link migration (20261124090000) is applied. */
export function withoutEmptyImageLink<T extends { image_url?: string | null }>(input: T): T {
  if (input.image_url) return input
  const rest = { ...input }
  delete rest.image_url
  return rest
}

/** Creates a product. A blank SKU gets the next automatic code; the stored SKU is returned. */
export async function createProduct(companyId: string, input: ProductInput): Promise<{ id: string; sku: string }> {
  const { data, error } = await requireSupabase()
    .from('products')
    .insert({ ...withoutEmptyImageLink(input), company_id: companyId })
    .select('id, sku')
    .single()
  if (error) throw error
  return data
}

export type ProductUpdate = Database['public']['Tables']['products']['Update']

export async function updateProduct(id: string, input: ProductUpdate): Promise<void> {
  const { error, count } = await requireSupabase().from('products').update(input, { count: 'exact' }).eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

export async function setProductStatus(id: string, status: 'ACTIVE' | 'INACTIVE'): Promise<void> {
  return updateProduct(id, { status })
}

/** Archive requires an INACTIVE product (enforced by a database constraint). */
export async function setProductArchived(id: string, archived: boolean): Promise<void> {
  const { error, count } = await requireSupabase()
    .from('products')
    // The database replaces the timestamp with now() and records the actor.
    .update({ archived_at: archived ? new Date().toISOString() : null }, { count: 'exact' })
    .eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

// --- Images ------------------------------------------------------------------

export const PRODUCT_IMAGE_BUCKET = 'product-images'
export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024

export async function uploadProductImage(product: Pick<ProductRow, 'id' | 'company_id' | 'product_image_path'>, file: File) {
  if (!PRODUCT_IMAGE_TYPES.includes(file.type)) throw new Error('Use a JPEG, PNG or WebP image.')
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) throw new Error('Images must be 2 MB or smaller.')
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const path = `${product.company_id}/${product.id}/${crypto.randomUUID()}.${ext}`
  const db = requireSupabase()

  const { error: uploadError } = await db.storage.from(PRODUCT_IMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) throw uploadError
  try {
    await updateProduct(product.id, { product_image_path: path })
  } catch (error) {
    await db.storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
    throw error
  }
  // Best effort: remove the replaced image.
  if (product.product_image_path) await db.storage.from(PRODUCT_IMAGE_BUCKET).remove([product.product_image_path])
}

export async function removeProductImage(product: Pick<ProductRow, 'id' | 'product_image_path'>) {
  if (!product.product_image_path) return
  await updateProduct(product.id, { product_image_path: null })
  await requireSupabase().storage.from(PRODUCT_IMAGE_BUCKET).remove([product.product_image_path])
}

export async function getProductImageUrl(path: string): Promise<string | null> {
  const { data, error } = await requireSupabase().storage.from(PRODUCT_IMAGE_BUCKET).createSignedUrl(path, 3600)
  return error ? null : data.signedUrl
}

/** Signed links for uploaded images (private bucket), one request for many paths. Missing or refused paths are left out. */
export async function getProductImageUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length === 0) return out
  const { data, error } = await requireSupabase().storage.from(PRODUCT_IMAGE_BUCKET).createSignedUrls(unique, 3600)
  if (error) return out
  for (const d of data ?? []) if (d.path && d.signedUrl && !d.error) out.set(d.path, d.signedUrl)
  return out
}

export interface ProductImageRef {
  id: string
  image_url?: string | null
  product_image_path?: string | null
}

/** Image link and uploaded image of the given products (for thumbnails on purchase, receipt and stock screens). */
export async function fetchProductImageRefs(ids: string[]): Promise<ProductImageRef[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out: ProductImageRef[] = []
  const db = requireSupabase()
  let columns = 'id, image_url, product_image_path'
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200)
    let res = await db.from('products').select(columns).in('id', chunk)
    // Before migration 20261124090000 there is no image_url column: uploaded images only.
    if (res.error && /image_url/.test(res.error.message ?? '')) {
      columns = 'id, product_image_path'
      res = await db.from('products').select(columns).in('id', chunk)
    }
    if (res.error) throw res.error
    out.push(...((res.data ?? []) as unknown as ProductImageRef[]))
  }
  return out
}

// --- Categories --------------------------------------------------------------

export interface CategoryWithCounts extends ProductCategoryRow {
  total_products: number
  active_products: number
}

export async function listCategories(): Promise<ProductCategoryRow[]> {
  const { data, error } = await requireSupabase().from('product_categories').select('*').order('name')
  if (error) throw error
  return data ?? []
}

export async function listCategoriesWithCounts(): Promise<CategoryWithCounts[]> {
  const [categories, counts] = await Promise.all([listCategories(), requireSupabase().rpc('product_category_counts')])
  if (counts.error) throw counts.error
  const byId = new Map((counts.data ?? []).map((c) => [c.category_id, c]))
  return categories.map((c) => ({
    ...c,
    total_products: Number(byId.get(c.id)?.total_products ?? 0),
    active_products: Number(byId.get(c.id)?.active_products ?? 0),
  }))
}

export async function createCategory(companyId: string, input: { code: string; name: string; description: string | null }) {
  const { error } = await requireSupabase()
    .from('product_categories')
    .insert({ company_id: companyId, code: input.code, name: input.name, description: input.description })
  if (error) throw error
}

/**
 * Creates a category from the product form (name + optional description) and
 * returns it. The code is derived from the name; if that code is taken, a
 * numbered variant is tried. A duplicate name is refused by the database.
 */
export async function quickCreateCategory(companyId: string, existingCodes: string[], input: { name: string; description: string | null }): Promise<ProductCategoryRow> {
  const taken = new Set(existingCodes.map((c) => c.toUpperCase()))
  let code = categoryCodeFor(input.name, taken)
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await requireSupabase()
      .from('product_categories')
      .insert({ company_id: companyId, code, name: input.name, description: input.description })
      .select('*')
      .single()
    if (!error) return data as ProductCategoryRow
    // Code already used (e.g. created meanwhile): try the next free variant.
    if ((error as { code?: string }).code === '23505' && String((error as { message?: string }).message).includes('product_categories_company_code_unique')) {
      taken.add(code)
      code = categoryCodeFor(input.name, taken)
      continue
    }
    throw error
  }
  throw new Error('Could not find a free category code. Create the category under Product Categories.')
}

export async function updateCategory(id: string, changes: { name?: string; description?: string | null; is_active?: boolean }) {
  const { error, count } = await requireSupabase().from('product_categories').update(changes, { count: 'exact' }).eq('id', id)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

// --- Import ------------------------------------------------------------------

export async function findExistingIdentifiers(skus: string[], barcodes: string[]) {
  const existingSkus = new Set<string>()
  const existingBarcodes = new Set<string>()
  const skuIds = new Map<string, string>()
  const barcodeOwners = new Map<string, string>()
  // Chunked to keep request payloads small.
  for (let i = 0; i < Math.max(skus.length, barcodes.length); i += 500) {
    const { data, error } = await requireSupabase().rpc('check_product_identifiers', {
      p_skus: skus.slice(i, i + 500),
      p_barcodes: barcodes.slice(i, i + 500),
    })
    if (error) throw error
    for (const row of data ?? []) {
      if (row.kind === 'sku') {
        existingSkus.add(row.value.trim().toLowerCase())
        skuIds.set(row.value.trim().toLowerCase(), row.product_id)
      } else {
        existingBarcodes.add(row.value)
        barcodeOwners.set(row.value, row.product_id)
      }
    }
  }
  return { existingSkus, existingBarcodes, skuIds, barcodeOwners }
}

/** Product id owning each of these EANs in the company (RLS limits the lookup to the user's company). */
export async function findExistingEans(eans: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  const valid = eans.filter((e) => /^\d{8}$|^\d{13}$/.test(e))
  for (let i = 0; i < valid.length; i += 200) {
    const { data, error } = await requireSupabase().from('products').select('id, ean').in('ean', valid.slice(i, i + 200))
    if (error) throw error
    for (const p of data ?? []) if (p.ean) owners.set(p.ean, p.id)
  }
  return owners
}

// --- Bulk delete of never-used products (migration 20261121090000) ----------------

type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
const untypedRpc: UntypedRpc = (fn, args) => (requireSupabase().rpc as unknown as UntypedRpc)(fn, args)

/** Same name / barcode / EAN / model number / similar description, within the user's company. */
export async function fetchDuplicateHints(ids: string[]): Promise<DuplicateHint[]> {
  if (ids.length === 0) return []
  const { data, error } = await untypedRpc('product_duplicate_hints', { p_ids: ids })
  if (error) throw error
  return (data ?? []) as DuplicateHint[]
}

/** What deleting these products would do (Super Admin only; nothing is changed). */
export async function previewBulkDelete(ids: string[]): Promise<BulkDeletePreview> {
  const { data, error } = await untypedRpc('product_bulk_delete_preview', { p_ids: ids })
  if (error) throw error
  return data as BulkDeletePreview
}

/** Deletes the never-used products among ids in one transaction; protected ones are kept (or archived). */
export async function bulkDeleteProducts(ids: string[], confirmation: string, reason: string, archiveBlocked: boolean, requestId: string): Promise<BulkDeleteResult> {
  const { data, error } = await untypedRpc('product_bulk_delete', {
    p_ids: ids, p_confirmation: confirmation, p_reason: reason, p_archive_blocked: archiveBlocked, p_request_id: requestId,
  })
  if (error) throw error
  return data as BulkDeleteResult
}

/** Group Head choices: the list configured in ERP Settings, then other values already used on products. */
export async function fetchGroupHeadOptions(): Promise<string[]> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string) => Promise<{ data: { configured: string[]; in_use: string[] } | null; error: unknown }>)('product_group_head_options')
  if (error) throw error
  return [...(data?.configured ?? []), ...(data?.in_use ?? [])]
}

/** Stored products by id (for "update existing products" imports). With a company id, only that company's products. */
export async function fetchProductsByIds(ids: string[], companyId?: string): Promise<ProductRow[]> {
  const rows: ProductRow[] = []
  for (let i = 0; i < ids.length; i += 200) {
    let query = requireSupabase().from('products').select('*').in('id', ids.slice(i, i + 200))
    if (companyId) query = query.eq('company_id', companyId)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data ?? []))
  }
  return rows
}

/**
 * Applies reviewed import updates one product at a time (each is audited with
 * its changed fields). Returns the error message per failed index.
 */
export async function updateProductsFromImport(
  updates: { id: string; changes: ProductUpdate; expectedUpdatedAt?: string; allowSkuChange?: boolean }[],
  onProgress?: (done: number) => void,
  companyId?: string,
): Promise<Map<number, string>> {
  const failures = new Map<number, string>()
  for (const [i, u] of updates.entries()) {
    try {
      // An import never changes a product's id or company. The SKU changes only when another field is the
      // match key and the SKU was selected to modify (the database refuses it once transactions use the product).
      const { sku, id: _id, company_id: _company, ...fields } = u.changes as ProductUpdate & { sku?: string; id?: unknown; company_id?: unknown }
      const changes = { ...fields, ...(u.allowSkuChange && sku ? { sku } : {}), change_reason: fields.change_reason ?? 'Updated by Excel import' }
      if (!u.expectedUpdatedAt) {
        await updateProduct(u.id, changes)
      } else {
        // Only if the product is still as it was when the file was checked (no overwrite of a newer edit, no repeat).
        let query = requireSupabase().from('products').update(changes, { count: 'exact' }).eq('id', u.id).eq('updated_at', u.expectedUpdatedAt)
        if (companyId) query = query.eq('company_id', companyId)
        const { error, count } = await query
        if (error) throw error
        if (count === 0) {
          failures.set(i, 'Not updated: this product was changed after the file was checked (or you cannot edit it). Check the file again and re-import.')
        }
      }
    } catch (error) {
      failures.set(i, describeProductError(error))
    }
    onProgress?.(i + 1)
  }
  return failures
}

export interface ProductIdentityRow {
  id: string
  sku: string
  product_name: string
  barcode: string | null
  ean: string | null
  model_number: string | null
}

/**
 * Field the product import uses to find existing products (ERP Settings → Products, migration 20261122090000).
 * SKU while that migration is not applied.
 */
export async function fetchImportMatchKey(): Promise<string> {
  const { data, error } = await untypedRpc('product_import_match_key', {})
  if (error) {
    const e = error as { code?: string; message?: string }
    // Function not installed yet: the import keeps matching by SKU.
    if (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message ?? '')) return 'SKU'
    throw error
  }
  return typeof data === 'string' ? data : 'SKU'
}

/**
 * SKU and name of every product of the company (archived included), for the import's duplicate checks.
 * Names and SKUs are compared case-insensitively in the browser, so "WASH BASIN" matches "Wash Basin".
 */
export async function fetchProductIdentities(companyId: string): Promise<ProductIdentityRow[]> {
  const out: ProductIdentityRow[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await requireSupabase().from('products').select('id, sku, product_name, barcode, ean, model_number')
      .eq('company_id', companyId).order('id').range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/**
 * Inserts products in batches. If a batch fails (e.g. a SKU created by someone
 * else meanwhile), its rows are retried one by one so each failure is
 * attributed to its own row. Returns the error message per failed index.
 */
export async function insertProducts(
  companyId: string,
  inputs: ProductInput[],
  onProgress?: (done: number) => void,
  batchSize = 100,
): Promise<Map<number, string>> {
  const failures = new Map<number, string>()
  const db = requireSupabase()
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize)
    const { error } = await db.from('products').insert(batch.map((p) => ({ ...withoutEmptyImageLink(p), company_id: companyId })))
    if (error) {
      for (let i = 0; i < batch.length; i++) {
        const single = await db.from('products').insert({ ...withoutEmptyImageLink(batch[i]), company_id: companyId })
        if (single.error) failures.set(start + i, describeProductError(single.error))
      }
    }
    onProgress?.(Math.min(start + batch.length, inputs.length))
  }
  return failures
}

export async function logProductImport(fileName: string, totals: { total: number; imported: number; skipped: number; failed: number }) {
  await requireSupabase().rpc('log_product_import', {
    p_file_name: fileName,
    p_total: totals.total,
    p_imported: totals.imported,
    p_skipped: totals.skipped,
    p_failed: totals.failed,
  })
}

export async function fetchDisplayNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const { data, error } = await requireSupabase().rpc('user_display_names', { p_user_ids: unique })
  if (error) return new Map()
  return new Map((data ?? []).map((r) => [r.user_id, r.display_name]))
}

/** Version history of a product / component (migration 20261118090000_master_versioning.sql). */
export async function fetchProductVersionHistory(productId: string): Promise<import('@/features/versions/version-model').ProductHistory> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(
    'product_version_history', { p_product_id: productId })
  if (error) throw error
  return data as import('@/features/versions/version-model').ProductHistory
}
